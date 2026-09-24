import { App, Notice, SettingGroupItem, Hotkey, Modifier, Platform } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { t } from '@/i18n';

// A SETTINGS PAGE IS A FUNCTION OF ITS CONTEXT. Each page is built by a
// function living beside the feature it configures (position/, nav-history/,
// recent-files/), so `src/settings/` keeps only what is about the settings
// SURFACE itself: the tab, these two row builders, and the pickers a page
// reaches for.
//
// The context is deliberately small, and every member is a permission a page
// cannot do without: read the settings, put a modal up, write ONE setting,
// and — for the one modal that writes without going through a row — draw the
// page again.
export interface SettingsPageContext {
	app: App;
	plugin: PositionRestorePlugin;
	// Write one setting and draw the page again. Every caller is a row that
	// just edited a list standing on this page. What the KEY owes in
	// consequence is deliberately NOT here: a lowered ceiling trims, a new
	// folder rule drops, and both are applied in one place —
	// PositionManager.applyChangedSettings, diffed off the tab's snapshot.
	setValue(key: string, value: unknown): Promise<void>;
	// Draw the page again without writing anything. Only the database path
	// modal needs this: it edits the setting itself and then asks the page to
	// catch up (see DbPathModal's onApply). Every other redraw follows a
	// write, so it comes through setValue.
	refresh(): void;
}

// A PAGE'S OWN SENTENCE, standing above every row that asks something of the
// reader: what this page is about, which none of its rows can say. It is not
// a row's help text, so it has no control beside it and no name of its own.
// `searchable: false` keeps a nameless hit out of the settings search.
export function intro(desc: string): SettingGroupItem {
	return {
		name: '',
		searchable: false,
		render: (setting) => {
			setting.setDesc(desc);
			setting.settingEl.addClass('position-restore-page-intro');
		},
	};
}

// ONE HOTKEY ROW, built for a page: its own sentence, then the commands
// belonging to THAT page and the key each is bound to, as the app reports
// them. A command with nothing bound says so, which is the whole point of the
// row — this is where a reader learns whether the feature has a key. The
// button beside it opens the app's own hotkey settings, filtered to this
// plugin.
//
// The hint is printed ONCE, after the list — two commands would otherwise
// repeat the same instruction, which reads as nagging. It names the button by
// what it LOOKS like, never by which side it stands on: on a phone-width
// screen the app's CSS wraps it BELOW the row, so a sentence pointing right
// would point at nothing. A bound key only fires from a physical keyboard.
export function hotkeys(
	plugin: PositionRestorePlugin,
	desc: string,
	commands: { id: string; name: string }[],
): SettingGroupItem {
	return {
		name: t('hotkeys.name'),
		render: (setting) => {
			const frag = createFragment();
			frag.createDiv({ text: desc });
			const list = frag.createEl('ul', { cls: 'mod-muted' });
			for (const command of commands)
				list.createEl('li', {
					text: `${command.name}: ${currentHotkeyText(plugin, command.id)}`,
				});
			frag.createDiv({ cls: 'mod-muted', text: t('hotkeys.hint') });
			setting.setDesc(frag);
			setting.addExtraButton((btn) => {
				btn.setIcon('keyboard').setTooltip(t('hotkeys.open'))
					.onClick(() => openHotkeySettings(plugin));
			});
		},
	};
}

// Formats one hotkey: modifier symbols on macOS, text elsewhere, in
// Obsidian's canonical modifier order.
function formatHotkey(hk: Hotkey): string {
	const isMac = Platform.isMacOS;
	const symbol: Record<Modifier, string> = {
		Mod: isMac ? '⌘' : 'Ctrl',
		Ctrl: isMac ? '⌃' : 'Ctrl',
		Meta: isMac ? '⌘' : 'Win',
		Shift: isMac ? '⇧' : 'Shift',
		Alt: isMac ? '⌥' : 'Alt',
	};
	const mods = (['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt'] as Modifier[])
		.filter((m) => hk.modifiers.includes(m))
		.map((m) => symbol[m]);
	const text = mods.join(isMac ? ' ' : '+');
	let keyShow;
	if (hk.key === 'ArrowLeft')
		keyShow = '←';
	else if (hk.key === 'ArrowRight')
		keyShow = '→';
	else
		keyShow = hk.key;
	return text ? `${text}${isMac ? ' ' : '+'}${keyShow}` : keyShow;
}

// (hotkeyManager is runtime API absent from the public typings.)
function currentHotkeyText(plugin: PositionRestorePlugin, commandId: string): string {
	const manager = (plugin.app as unknown as {
		hotkeyManager?: { getHotkeys(id: string): Hotkey[] | null };
	}).hotkeyManager;
	const hotkeys = manager?.getHotkeys(`${plugin.manifest.id}:${commandId}`);
	if (!hotkeys || hotkeys.length === 0)
		return t('hotkeys.unbound');
	return hotkeys.map(formatHotkey).join(' / ');
}

// Opens Obsidian's hotkey settings on this plugin's commands. Only reachable
// from a settings row, so the settings modal is already open — calling open()
// again would stack a second modal (Obsidian does not guard re-entry) and the
// tab swap would land on the invisible instance. The swap from inside a click
// handler completes asynchronously, so the query prefill retries until the
// hotkeys tab is live. A tab that never arrives is said out loud: a button
// that does nothing is worse than no button.
function openHotkeySettings(plugin: PositionRestorePlugin): void {
	const setting = (plugin.app as unknown as {
		setting?: {
			openTabById(id: string): void;
			activeTab?: { id?: string; setQuery?(query: string): void };
		};
	}).setting;
	// Same sentence either way: what was promised was a way to bind a key,
	// and it is the outcome — not the reason — the reader is left looking at.
	if (!setting) {
		new Notice(t('hotkeys.openFailed'));
		return;
	}
	setting.openTabById('hotkeys');
	const prefill = (retries: number): void => {
		const tab = setting.activeTab;
		// Arriving on the tab is the job; the query is only a convenience, so a
		// tab with no setQuery counts as arrived and says nothing.
		if (tab?.id === 'hotkeys') {
			tab.setQuery?.(plugin.manifest.name);
			return;
		}
		if (retries > 0) {
			window.setTimeout(() => prefill(retries - 1), 50);
			return;
		}
		new Notice(t('hotkeys.openFailed'));
	};
	prefill(20);
}
