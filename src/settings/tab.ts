import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { positionSettingsPage } from '@/position/settings-page';
import { navHistorySettingsPage } from '@/nav-history/settings-page';
import { recentFilesSettingsPage } from '@/recent-files/settings-page';
import { SettingsPageContext } from './page';
import { t } from '@/i18n';

// THE SETTINGS SURFACE — the tab the framework knows, plus the row builders and pickers the three
// pages share (page.ts, pickers.ts). The pages live beside the features they configure.
//
// This file is an ASSEMBLER: getSettingDefinitions, getControlValue and setControlValue are
// overrides of PluginSettingTab (@since 1.13.0), so the app calls them on an instance of this class
// and they can never move elsewhere. What remains names all three pages and knows nothing inside
// them.

// The preferences a standing panel DRAWS BY (see RecentFilesBrowserPrefs). A change to one of them
// owes no derived state — panels read these live — but a panel open beside this page was drawn with
// the old one and has to be asked to draw again. That is why the list stands here rather than inside
// the manager's diff table: that table re-applies state the stores hold, while this asks a view to
// draw.
const BROWSER_PREF_KEYS = new Set(['recentFilesLandings', 'recentFilesPathDisplay', 'recentFilesRowTime']);

// The keys that change the SHAPE OF A PAGE rather than a value on it — whose consequence is a row
// appearing or not, or a sentence read differently. The framework writes a control's value and
// calls nothing back, so these are the writes that have to ask for the redraw themselves (see
// setControlValue); every other key changes a number or an answer, and the row that holds it is
// already drawn with the new one.
const PAGE_SHAPE_KEYS = new Set(['recentFilesLandings']);

export class SettingTab extends PluginSettingTab {
	plugin: PositionRestorePlugin;

	constructor(app: App, plugin: PositionRestorePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	// THE ONE WRITE PATH, and the only place that knows what a written key owes in consequence —
	// which is a diff, not a lookup: the writes that name no key (data.json edited by hand, a sync
	// landing) have to be answered by the same table, and only a diff can answer both. So the tab
	// snapshots, writes, and hands the snapshot over; the manager's table decides.
	//
	// The snapshot is shallow on purpose. Nothing here mutates an array in place — a folder list is
	// always replaced whole — so the pre-write arrays keep their identity and the manager's
	// element-wise comparison stays a comparison of VALUES, which is what it has to be for the
	// arrays a fresh JSON.parse builds on an external write (see PositionManager.sameList).
	async setControlValue(key: string, value: unknown): Promise<void> {
		const before = { ...this.plugin.settings };
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		this.plugin.manager.applyChangedSettings(before);
		if (BROWSER_PREF_KEYS.has(key))
			this.plugin.manager.refreshNavPanels();
		await this.plugin.saveSettings();
		// Asked AFTER the save: a redraw rebuilds every page from the settings, so it has to see
		// the value that was just written — and it has to be asked here, because the framework's
		// own write path ends in this method and nowhere calls back into the tab.
		if (PAGE_SHAPE_KEYS.has(key))
			this.update();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const ctx = this.pageContext();
		return [
			{
				type: 'page',
				name: t('lastPosition.heading'),
				items: positionSettingsPage(ctx),
			},
			{
				type: 'page',
				name: t('navHistory.heading'),
				items: navHistorySettingsPage(ctx),
			},
			{
				type: 'page',
				name: t('recentFiles.name'),
				items: recentFilesSettingsPage(ctx),
			},
		] as SettingDefinitionItem[];
	}

	// What a page is handed. Rebuilt per call rather than held as a field: it is a set of readers
	// plus two methods that already exist on this class, so there is no state in it to keep — and a
	// field would have to be created in the constructor, before PluginSettingTab is done with its
	// own.
	private pageContext(): SettingsPageContext {
		return {
			app: this.app,
			plugin: this.plugin,
			// setControlValue already applies the key's consequence; all a page adds is the
			// redraw, because the list it just edited is on the page it is looking at.
			setValue: async (key, value) => {
				await this.setControlValue(key, value);
				this.update();
			},
			refresh: () => this.update(),
		};
	}
}
