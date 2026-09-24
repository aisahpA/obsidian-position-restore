import { App, Notice, SettingGroupItem, Hotkey, Modifier, Platform } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { t } from '@/i18n';

// A SETTINGS PAGE IS A FUNCTION OF ITS CONTEXT. Each of the tab's three pages is
// built by a function that lives beside the feature it configures — position/,
// nav-history/, recent-files/ — which is the rule this repository already
// follows for UI everywhere else (see position/ui, recent-files/browser): UI is
// found next to the thing it serves, never in a folder named after the layer it
// belongs to. So `src/settings/` keeps only what is about the settings SURFACE
// itself: the tab, these two row builders, and the pickers a page reaches for.
//
// The context is deliberately small, and every member is a permission a page
// cannot do without: read the settings (they live on the plugin), put a modal
// up (that needs the app), write ONE setting — the one the reader just chose
// from a row standing on this page — and, for the one modal that writes without
// going through a row, draw the page again.
export interface SettingsPageContext {
	app: App;
	plugin: PositionRestorePlugin;
	// Write one setting and draw the page again. Every caller is a row that has
	// just edited a list which stands on this page, so the list has to show the
	// edit. What the KEY owes in consequence is deliberately NOT here: a lowered
	// ceiling trims, a new folder rule drops, and both are applied in one place
	// — PositionManager.applyChangedSettings, diffed off the snapshot the tab
	// hands it (see settings/tab.ts). A page that applied them itself would be
	// the second copy of that table, which is the copy this refactor deleted.
	setValue(key: string, value: unknown): Promise<void>;
	// Draw the page again without writing anything. Only the database path modal
	// needs this: it edits the setting itself, since it holds the plugin and has
	// a database to re-point, and then asks the page to catch up (see
	// DbPathModal's onApply). Every other redraw in a page comes through
	// setValue, because every other redraw follows a write.
	refresh(): void;
}

// A PAGE'S OWN SENTENCE, standing above every row that asks something of
// the reader: what this page is about, in the words none of its rows can
// say for themselves. It is NOT a row's help text, so it has no control
// beside it and no name of its own — the name would be the page's name
// said again, which the page's own title already says. `searchable: false`
// keeps it out of the settings search, where a nameless hit would be a
// line with nothing above it naming where it came from.
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

// ONE HOTKEY ROW, built for a page: its own sentence, then the commands that
// belong to THAT page and the key each of them is bound to, as the app itself
// reports them (see currentHotkeyText). A command with nothing bound says so,
// which is the whole point of the row — the feature needs a key, and this is
// where a reader learns whether it has one. The button beside it opens the
// app's own hotkey settings, already filtered to this plugin.
//
// A page's commands stand on the page they belong to rather than in one list:
// "open the list of places I have been" is not a question about travel, and a
// reader looking for that key should not have to know it was filed under a
// heading about going back and forth. The tab is the only reader of this
// function's `plugin`: a row draws from what the app reports, so nothing here
// writes a setting and no page context is needed.
//
// The hint is printed ONCE, after the list, instead of being appended to every
// unbound line: two commands would otherwise repeat the same instruction, which
// reads as nagging rather than as help. It names the button by what it LOOKS
// like — a keyboard — and never by which side it stands on. That is deliberate:
// the button is an extra button, so on a phone-width screen the app's own CSS
// wraps it BELOW the row, and a sentence pointing right would be pointing at
// nothing. (What is true on both ends is said instead: a bound key only fires
// from a physical keyboard.)
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

// Formats one hotkey for display: modifier symbols on macOS, text elsewhere,
// in Obsidian's canonical modifier order.
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

// Reads the user-configured hotkeys for one of this plugin's commands.
// (hotkeyManager is runtime API absent from the public typings — same cast
// family as MetadataCache.getAllPropertyInfos in pickers.ts.)
function currentHotkeyText(plugin: PositionRestorePlugin, commandId: string): string {
	const manager = (plugin.app as unknown as {
		hotkeyManager?: { getHotkeys(id: string): Hotkey[] | null };
	}).hotkeyManager;
	const hotkeys = manager?.getHotkeys(`${plugin.manifest.id}:${commandId}`);
	if (!hotkeys || hotkeys.length === 0)
		return t('hotkeys.unbound');
	return hotkeys.map(formatHotkey).join(' / ');
}

// Opens Obsidian's hotkey settings on this plugin's commands. Only
// reachable from this plugin's settings row, so the settings modal is
// already open — calling open() again would stack a second modal (Obsidian
// does not guard re-entry) and the tab swap would land on the invisible
// instance. The tab swap from inside a click handler completes
// asynchronously (activeTab still points at the old tab when the handler
// returns), so the query prefill retries until the hotkeys tab is live.
// All runtime APIs here are untyped — a missing member degrades silently to
// an unfiltered list, but a tab that never arrives is said out loud: a button
// that does nothing is worse than no button, and the reader is left standing
// on a row that promised a way to bind a key.
function openHotkeySettings(plugin: PositionRestorePlugin): void {
	const setting = (plugin.app as unknown as {
		setting?: {
			openTabById(id: string): void;
			activeTab?: { id?: string; setQuery?(query: string): void };
		};
	}).setting;
	// Same sentence either way: what was promised was a way to bind a key, and
	// it is the outcome — not the reason — the reader is left looking at.
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
