import { App, PluginSettingTab, SettingDefinitionItem, FuzzySuggestModal, Modal, Setting, TFolder, TextComponent, Notice } from 'obsidian';
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
				heading: t('openAndRestore'),
				items: [
					{
						name: t('defaultPositionName'),
						desc: t('defaultPositionDesc'),
						control: {
							type: 'dropdown',
							key: 'defaultPosition',
							options: {
								default: t('optionDefault'),
								fileEnd: t('optionFileEnd'),
							},
						},
					},
					{
						name: t('linkOpenName'),
						desc: t('linkOpenDesc'),
						control: {
							type: 'dropdown',
							key: 'linkOpenPosition',
							options: {
								start: t('optionFileStart'),
								restore: t('optionSavedPosition'),
							},
						},
					},
					{
						name: t('sourceRestoreName'),
						desc: t('sourceRestoreDesc'),
						control: {
							type: 'dropdown',
							key: 'sourceRestoreMethod',
							options: {
								instant: t('optionInstant'),
								glide: t('optionGlide'),
							},
						},
					},
					{
						name: t('readingRestoreName'),
						desc: t('readingRestoreDesc'),
						control: {
							type: 'dropdown',
							key: 'readingRestoreMethod',
							options: {
								instant: t('optionInstant'),
								glide: t('optionGlide'),
							},
						},
					},
					{
						name: t('indicatorName'),
						desc: t('indicatorDesc'),
						control: {
							type: 'dropdown',
							key: 'restoreIndicator',
							options: {
								off: t('optionOff'),
								breadcrumb: t('optionBreadcrumb'),
								both: t('optionBoth'),
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('recordingRules'),
				items: [
					{
						type: 'page',
						name: t('foldersName'),
						desc: (() => {
							const frag = createFragment();
							frag.createDiv({ text: t('foldersDesc') });
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
								emptyState: t('listNoFolders'),
								items: this.plugin.settings.excludedFolders.map((folder) => ({
									name: folder + '/',
								})),
								onDelete: (index) => {
									const folders = this.plugin.settings.excludedFolders.filter((_, i) => i !== index);
									void this.setControlValue('excludedFolders', folders).then(() => this.update());
								},
								addItem: {
									name: t('addFolder'),
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
						name: t('minLinesName'),
						desc: t('minLinesDesc'),
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
						name: t('frontmatterExcludeName'),
						desc: (() => {
							const frag = createFragment();
							frag.createDiv({ text: t('frontmatterExcludeDesc') });
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
								emptyState: t('listNoProperties'),
								items: this.plugin.settings.frontmatterExcludeProperties.map((prop) => ({
									name: prop,
								})),
								onDelete: (index) => {
									const props = this.plugin.settings.frontmatterExcludeProperties.filter((_, i) => i !== index);
									void this.setControlValue('frontmatterExcludeProperties', props).then(() => this.update());
								},
								addItem: {
									name: t('addProperty'),
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
						name: t('escapeHatchName'),
						desc: t('escapeHatchDesc', ESCAPE_HATCH_PROPERTY),
					},
					{
						name: t('baseScrollName'),
						desc: t('baseScrollDesc'),
						control: {
							type: 'toggle',
							key: 'recordBaseScroll',
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('dataStorage'),
				items: [
					{
						name: t('dbName'),
						desc: t('dbDesc'),
						render: (setting) => {
							let text: TextComponent;
							const confirm = async () => {
								const value = text.getValue().trim();
								if (await this.plugin.database.switchDbFile(value)) {
									void this.setControlValue('dbFileName', value);
									new Notice(value === '' ? t('dbDefault') : t('dbSet', value));
									this.update();
								}
							};
							setting.addText((t) => {
								text = t;
								t.setPlaceholder(this.plugin.database.defaultDbFileName);
								t.setValue(this.plugin.settings.dbFileName || '');
							}).addExtraButton((btn) => {
								btn.setIcon('check').setTooltip(t('confirmTooltip'))
									.onClick(() => { void confirm(); });
							});
						},
					},
					{
						name: t('entriesName'),
						render: (setting) => {
							const count = Object.keys(this.plugin.database.db).length;
							setting.setDesc(t('entriesDesc', String(count)));
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
		this.setPlaceholder(t('searchFolders'));
		this.limit = 50;
		this.emptyStateText = t('noFoldersFound');
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
		this.setPlaceholder(t('searchProperties'));
		this.limit = 50;
		this.emptyStateText = t('noPropertiesFound');
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
		contentEl.createEl('h3', { text: t('propertyValueTitle', this.name) });

		let input: TextComponent;
		new Setting(contentEl)
			.setName(t('propertyValueName'))
			.setDesc(t('propertyValueDesc'))
			.addText((text) => {
				input = text;
				text.setPlaceholder(t('propertyValuePlaceholder'));
				text.inputEl.addEventListener('keydown', (ev) => {
					if (ev.key === 'Enter')
						this.submit(input);
				});
			});
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText(t('addProperty'))
				.setCta()
				.onClick(() => this.submit(input))
		);
	}

	private submit(input: TextComponent) {
		const value = input.getValue().trim();
		const entry = value === '' ? this.name : `${this.name}: ${value}`;
		if (this.excluded.includes(entry)) {
			new Notice(t('propertyDuplicate', entry));
			return;
		}
		this.onSelect(entry);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
