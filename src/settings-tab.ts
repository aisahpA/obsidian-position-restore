import { App, PluginSettingTab, SettingDefinitionItem, FuzzySuggestModal, Modal, Setting, TFolder, TextComponent, Notice, Platform, Hotkey, Modifier } from 'obsidian';
import type RememberCursorPosition from '../main';
import { ESCAPE_HATCH_PROPERTY } from './frontmatter';
import { t } from './i18n';

// obsidian@1.13.2 types omit getAllPropertyInfos (added in Obsidian 1.4).
declare module 'obsidian' {
	interface MetadataCache {
		getAllPropertyInfos(): Record<string, unknown>;
	}
}

export class SettingTab extends PluginSettingTab {
	plugin: RememberCursorPosition;

	constructor(app: App, plugin: RememberCursorPosition) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		if (key === 'excludedFolders' || key === 'frontmatterExcludeProperties') {
			this.plugin.manager.clearExclusionCache();
			this.plugin.database.pruneDb();
		}
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: t('openAndRestore.heading'),
				items: [
					{
						name: t('openAndRestore.defaultPosition.name'),
						desc: t('openAndRestore.defaultPosition.desc'),
						control: {
							type: 'dropdown',
							key: 'defaultPosition',
							options: {
								default: t('openAndRestore.defaultPosition.options.default'),
								fileEnd: t('openAndRestore.defaultPosition.options.fileEnd'),
							},
						},
					},
					{
						name: t('openAndRestore.linkOpenPosition.name'),
						desc: t('openAndRestore.linkOpenPosition.desc'),
						control: {
							type: 'dropdown',
							key: 'linkOpenPosition',
							options: {
								start: t('openAndRestore.linkOpenPosition.options.start'),
								restore: t('openAndRestore.linkOpenPosition.options.restore'),
							},
						},
					},
					{
						name: t('openAndRestore.sourceRestoreMethod.name'),
						desc: t('openAndRestore.sourceRestoreMethod.desc'),
						control: {
							type: 'dropdown',
							key: 'sourceRestoreMethod',
							options: {
								instant: t('openAndRestore.sourceRestoreMethod.options.instant'),
								glide: t('openAndRestore.sourceRestoreMethod.options.glide'),
							},
						},
					},
					{
						name: t('openAndRestore.readingRestoreMethod.name'),
						desc: t('openAndRestore.readingRestoreMethod.desc'),
						control: {
							type: 'dropdown',
							key: 'readingRestoreMethod',
							options: {
								instant: t('openAndRestore.readingRestoreMethod.options.instant'),
								glide: t('openAndRestore.readingRestoreMethod.options.glide'),
							},
						},
					},
					{
						name: t('openAndRestore.restoreIndicator.name'),
						desc: t('openAndRestore.restoreIndicator.desc'),
						control: {
							type: 'dropdown',
							key: 'restoreIndicator',
							options: {
								off: t('openAndRestore.restoreIndicator.options.off'),
								breadcrumb: t('openAndRestore.restoreIndicator.options.breadcrumb'),
								both: t('openAndRestore.restoreIndicator.options.both'),
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('recordingRules.heading'),
				items: [
					{
						type: 'page',
						name: t('recordingRules.folders.name'),
						desc: (() => {
							const frag = createFragment();
							frag.createDiv({ text: t('recordingRules.folders.desc') });
							const folders = this.plugin.settings.excludedFolders;
							if (folders.length === 0) {
								return frag;
							}
							const list = frag.createEl('ul', { cls: 'mod-muted' });
							for (const folder of folders.slice(0, 5)) {
								list.createEl('li', { text: folder + '/' });
							}
							if (folders.length > 5) {
								list.createEl('li', { text: '...' });
							}
							return frag;
						})(),
						items: [
							{
								type: 'list',
								emptyState: t('recordingRules.folders.list.empty'),
								items: this.plugin.settings.excludedFolders.map((folder) => ({
									name: folder + '/',
								})),
								onDelete: (index) => {
									const folders = this.plugin.settings.excludedFolders.filter((_, i) => i !== index);
									void this.setControlValue('excludedFolders', folders).then(() => this.update());
								},
								addItem: {
									name: t('recordingRules.folders.add'),
									action: () => {
										new FolderSuggestModal(
											this.app,
											this.plugin.settings.excludedFolders,
											(path) => {
												const folders = [...this.plugin.settings.excludedFolders, path];
												void this.setControlValue('excludedFolders', folders)
													.then(() => this.update());
											}
										).open();
									},
								},
							},
						],
					},
					{
						name: t('recordingRules.minLinesToRecord.name'),
						desc: t('recordingRules.minLinesToRecord.desc'),
						control: {
							type: 'number',
							key: 'minLinesToRecord',
							min: 0,
							max: 100000,
							step: 1,
						},
					},
					{
						type: 'page',
						name: t('recordingRules.frontmatterExclude.name'),
						desc: (() => {
							const frag = createFragment();
							frag.createDiv({ text: t('recordingRules.frontmatterExclude.desc') });
							const props = this.plugin.settings.frontmatterExcludeProperties;
							if (props.length === 0) {
								return frag;
							}
							const list = frag.createEl('ul', { cls: 'mod-muted' });
							for (const prop of props.slice(0, 5)) {
								list.createEl('li', { text: prop });
							}
							if (props.length > 5) {
								list.createEl('li', { text: '...' });
							}
							return frag;
						})(),
						items: [
							{
								type: 'list',
								emptyState: t('recordingRules.frontmatterExclude.list.empty'),
								items: this.plugin.settings.frontmatterExcludeProperties.map((prop) => ({
									name: prop,
								})),
								onDelete: (index) => {
									const props = this.plugin.settings.frontmatterExcludeProperties.filter((_, i) => i !== index);
									void this.setControlValue('frontmatterExcludeProperties', props).then(() => this.update());
								},
								addItem: {
									name: t('recordingRules.frontmatterExclude.add'),
									action: () => {
										new PropertySuggestModal(
											this.app,
											(name) => {
												new PropertyValueModal(
													this.app,
													name,
													this.plugin.settings.frontmatterExcludeProperties,
													(entry) => {
														const props = [...this.plugin.settings.frontmatterExcludeProperties, entry];
														void this.setControlValue('frontmatterExcludeProperties', props)
															.then(() => this.update());
													}
												).open();
											}
										).open();
									},
								},
							},
						],
					},
					{
						name: t('recordingRules.escapeHatch.name'),
						desc: t('recordingRules.escapeHatch.desc', ESCAPE_HATCH_PROPERTY),
					},
					{
						name: t('recordingRules.recordBaseScroll.name'),
						desc: t('recordingRules.recordBaseScroll.desc'),
						control: {
							type: 'toggle',
							key: 'recordBaseScroll',
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('dataStorage.heading'),
				items: [
					{
						name: t('dataStorage.dbFileName.name'),
						desc: t('dataStorage.dbFileName.desc'),
						render: (setting) => {
							let text: TextComponent;
							const confirm = async () => {
								const value = text.getValue().trim();
								if (await this.plugin.database.switchDbFile(value)) {
									void this.setControlValue('dbFileName', value);
									new Notice(value === '' ? t('dataStorage.dbFileName.messages.default') : t('dataStorage.dbFileName.messages.set', value));
									this.update();
								}
							};
							setting.addText((t) => {
								text = t;
								t.setPlaceholder(this.plugin.database.defaultDbFileName);
								t.setValue(this.plugin.settings.dbFileName || '');
							}).addExtraButton((btn) => {
								btn.setIcon('check').setTooltip(t('dataStorage.dbFileName.confirm'))
									.onClick(() => { void confirm(); });
							});
						},
					},
					{
						name: t('dataStorage.entries.name'),
						render: (setting) => {
							const count = Object.keys(this.plugin.database.db).length;
							setting.setDesc(t('dataStorage.entries.desc', String(count)));
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('navHistory.heading'),
				items: [
					{
						name: t('navHistory.overview.name'),
						render: (setting) => {
							const frag = createFragment();
							frag.createDiv({ text: t('navHistory.overview.desc') });
							const list = frag.createEl('ul', { cls: 'mod-muted' });
							list.createEl('li', { text: `${t('navHistory.commands.navigateBack')}: ${currentHotkeyText(this.plugin, 'navigate-back')}` });
							list.createEl('li', { text: `${t('navHistory.commands.navigateForward')}: ${currentHotkeyText(this.plugin, 'navigate-forward')}` });
							list.createEl('li', { text: `${t('navHistory.commands.browseHistory')}: ${currentHotkeyText(this.plugin, 'browse-nav-history')}` });
							setting.setDesc(frag);
							setting.addExtraButton((btn) => {
								btn.setIcon('keyboard').setTooltip(t('navHistory.overview.openHotkeySettings'))
									.onClick(() => openHotkeySettings(this.plugin));
							});
						},
					},
					{
						name: t('navHistory.stackCap.name'),
						desc: t('navHistory.stackCap.desc'),
						control: {
							type: 'number',
							key: 'navStackCap',
							min: 10,
							max: 500,
							step: 1,
						},
					},
					{
						name: t('navHistory.recordActivation.name'),
						desc: t('navHistory.recordActivation.desc'),
						control: {
							type: 'toggle',
							key: 'navRecordActivation',
						},
					},
					{
						name: t('navHistory.recordTeleport.name'),
						desc: t('navHistory.recordTeleport.desc'),
						control: {
							type: 'toggle',
							key: 'navRecordTeleport',
						},
					},
				],
			},
		];
	}
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private excludedFolders: string[],
		private onSelect: (path: string) => void
	) {
		super(app);
		this.setPlaceholder(t('recordingRules.folders.search.placeholder'));
		this.limit = 50;
		this.emptyStateText = t('recordingRules.folders.search.empty');
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(false)
			.filter((f) => {
				return !this.excludedFolders.some(folder =>
					f.path === folder || f.path.startsWith(folder + '/')
				);
			})
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onSelect(folder.path);
	}
}

// Fuzzy suggest modal for picking one frontmatter property name, matching the
// folder suggest flow. Lists every property already present in the vault
// (metadataCache). Excluded properties are still shown: the same name can be
// excluded for several different values.
class PropertySuggestModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private onSelect: (name: string) => void
	) {
		super(app);
		this.setPlaceholder(t('recordingRules.frontmatterExclude.search.placeholder'));
		this.limit = 50;
		this.emptyStateText = t('recordingRules.frontmatterExclude.search.empty');
	}

	getItems(): string[] {
		return Object.keys(this.app.metadataCache.getAllPropertyInfos())
			.sort((a, b) => a.localeCompare(b));
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.onSelect(item);
	}
}

// Second step of the property flow: ask for the value to match. Leave the
// input empty to exclude by property presence alone (`name`); otherwise the
// entry becomes `name: value`.
class PropertyValueModal extends Modal {
	constructor(
		app: App,
		private name: string,
		private excluded: string[],
		private onSelect: (entry: string) => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: t('recordingRules.frontmatterExclude.value.title', this.name) });

		let input: TextComponent;
		new Setting(contentEl)
			.setName(t('recordingRules.frontmatterExclude.value.name'))
			.setDesc(t('recordingRules.frontmatterExclude.value.desc'))
			.addText((text) => {
				input = text;
				text.setPlaceholder(t('recordingRules.frontmatterExclude.value.placeholder'));
				text.inputEl.addEventListener('keydown', (ev) => {
					if (ev.key === 'Enter')
						this.submit(input);
				});
			});
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText(t('recordingRules.frontmatterExclude.add'))
				.setCta()
				.onClick(() => this.submit(input))
		);
	}

	private submit(input: TextComponent) {
		const value = input.getValue().trim();
		const entry = value === '' ? this.name : `${this.name}: ${value}`;
		if (this.excluded.includes(entry)) {
			new Notice(t('recordingRules.frontmatterExclude.duplicate', entry));
			return;
		}
		this.onSelect(entry);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
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
// family as MetadataCache.getAllPropertyInfos above.)
function currentHotkeyText(plugin: RememberCursorPosition, commandId: string): string {
	const manager = (plugin.app as unknown as {
		hotkeyManager?: { getHotkeys(id: string): Hotkey[] | null };
	}).hotkeyManager;
	const hotkeys = manager?.getHotkeys(`${plugin.manifest.id}:${commandId}`);
	if (!hotkeys || hotkeys.length === 0)
		return t('navHistory.overview.hotkeyUnbound');
	return hotkeys.map(formatHotkey).join(' / ');
}

// Opens Obsidian's hotkey settings on this plugin's commands. Only
// reachable from this plugin's settings row, so the settings modal is
// already open — calling open() again would stack a second modal (Obsidian
// does not guard re-entry) and the tab swap would land on the invisible
// instance. The tab swap from inside a click handler completes
// asynchronously (activeTab still points at the old tab when the handler
// returns), so the query prefill retries until the hotkeys tab is live.
// All runtime APIs here are untyped — a missing member or exhausted
// retries degrade silently to an unfiltered list.
function openHotkeySettings(plugin: RememberCursorPosition): void {
	const setting = (plugin.app as unknown as {
		setting?: {
			openTabById(id: string): void;
			activeTab?: { id?: string; setQuery?(query: string): void };
		};
	}).setting;
	if (!setting)
		return;
	setting.openTabById('hotkeys');
	const prefill = (retries: number): void => {
		const tab = setting.activeTab;
		if (tab?.id === 'hotkeys' && tab.setQuery) {
			tab.setQuery(plugin.manifest.name);
			return;
		}
		if (retries > 0)
			window.setTimeout(() => prefill(retries - 1), 50);
	};
	prefill(20);
}
