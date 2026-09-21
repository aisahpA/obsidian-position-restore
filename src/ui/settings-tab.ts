import { App, PluginSettingTab, SettingDefinitionItem, SettingGroupItem, FuzzySuggestModal, Modal, Setting, TFolder, TFile, TextComponent, Notice, Platform, Hotkey, Modifier } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { ESCAPE_HATCH_PROPERTY } from '@/position/policy/frontmatter';
import { t } from '@/i18n';

// obsidian@1.13.2 types omit getAllPropertyInfos (added in Obsidian 1.4).
declare module 'obsidian' {
	interface MetadataCache {
		getAllPropertyInfos(): Record<string, unknown>;
	}
}

// WHERE a database path sits — which is all the settings item may state: inside
// the configuration folder (the plugin's own folder, or anywhere else under it),
// inside a hidden folder, or out in the vault as an ordinary file. Whether any
// of those travels between devices is the reader's sync client's business:
// Obsidian Sync carries a plugin folder only as data.json / main.js /
// manifest.json / styles.css and skips "."-folders outright, while a client that
// mirrors the whole configuration folder carries them as they stand. So the page
// says where the file is, and the modal states the Obsidian Sync rules. The
// database itself accepts all three.
function dbSyncState(app: App, path: string): 'config' | 'hidden' | 'vault' {
	if (path === app.vault.configDir || path.startsWith(`${app.vault.configDir}/`))
		return 'config';
	const firstSegment = path.split('/')[0];
	return firstSegment.startsWith('.') ? 'hidden' : 'vault';
}

// The settings a standing recent-files panel draws by (see NavBrowserPrefs): what
// one row prints, and whether it prints a time. They are read LIVE, so a panel
// open beside this page is drawn again the moment one of them changes rather than
// catching up on the reader's next navigation.
const BROWSER_PREF_KEYS = new Set(['navLandings', 'navPathDisplay', 'navRowTime']);

export class SettingTab extends PluginSettingTab {
	plugin: PositionRestorePlugin;

	constructor(app: App, plugin: PositionRestorePlugin) {
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
			this.plugin.manager.prunePositions();
		}
		// The ceiling is otherwise only applied on the next navigation: the
		// stack (and the browser) would keep its old size until then, and then
		// drop a large chunk at once.
		if (key === 'navStackCap')
			this.plugin.manager.applyNavStackCap();
		// The recent-files list's own folder rule: dropping a folder must drop the
		// places it already holds, not wait for the reader to revisit one.
		if (key === 'navRecentExcludeFolders')
			this.plugin.manager.applyNavRecentFolders();
		// …and its ceiling, which trims the list in memory on the spot so the reader
		// sees the number they just set rather than discovering it on the next open.
		if (key === 'navRecentCap')
			this.plugin.manager.applyNavRecentCap();
		// How the list LOOKS changed while a panel may be standing open beside this
		// page: the panel reads these preferences live, so it only has to be drawn
		// again (see PositionManager.refreshNavPanels) — and the answer the reader
		// just chose is in front of them without their leaving the tab.
		if (BROWSER_PREF_KEYS.has(key))
			this.plugin.manager.refreshNavPanels();
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'page',
				name: t('lastPosition.heading'),
				items: this.getPositionDefs(),
			},
			{
				type: 'page',
				name: t('navHistory.heading'),
				items: this.getNavDefs(),
			},
			{
				type: 'page',
				name: t('recentFiles.name'),
				items: this.getRecentFileDefs(),
			},
		] as SettingDefinitionItem[];
	}

	// ── Tab 1: Last Position ─────────────────────────────────────────

	private getPositionDefs(): SettingDefinitionItem[] {
		return [
			{
				// The intro gets a group of its own, and not a first item inside
				// "Open & restore": it introduces the whole page, and sitting
				// under one group's heading would make it that group's sentence.
				// No heading here, for the reason the other two pages have none —
				// the page is already named "Last position".
				type: 'group',
				items: [this.intro(t('lastPosition.intro'))],
			},
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
						desc: (() => {
							const current = this.plugin.settings.dbFileName || this.plugin.database.defaultDbFileName;
							const state = dbSyncState(this.app, current);
							const frag = createFragment();
							frag.createDiv({ text: t('dataStorage.dbFileName.desc') });
							frag.createDiv({ cls: 'mod-muted', text: t('dataStorage.dbFileName.current', current) });
							// Where the file is, in one muted line. The default sits
							// inside the plugin folder, which most sync setups do not
							// carry whole — the fact a reader needs before the records
							// silently fail to follow them to another device. It names
							// no sync client: that rule belongs to the dialog.
							frag.createDiv({
								cls: 'mod-muted',
								text: state === 'config'
									? t('dataStorage.dbFileName.syncLocal')
									: state === 'hidden'
										? t('dataStorage.dbFileName.syncHidden')
										: t('dataStorage.dbFileName.syncVault'),
							});
							return frag;
						})(),
						render: (setting) => {
							setting.addButton((btn) => {
								btn.setButtonText(t('dataStorage.dbFileName.change'))
									.onClick(() => new DbPathModal(this.app, this.plugin, () => this.update()).open());
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
		];
	}

	// A PAGE'S OWN SENTENCE, standing above every row that asks something of
	// the reader: what this page is about, in the words none of its rows can
	// say for themselves. It is NOT a row's help text, so it has no control
	// beside it and no name of its own — the name would be the page's name
	// said again, which the page's own title already says. `searchable: false`
	// keeps it out of the settings search, where a nameless hit would be a
	// line with nothing above it naming where it came from.
	private intro(desc: string): SettingGroupItem {
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
	// heading about going back and forth.
	private hotkeys(
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
						text: `${command.name}: ${currentHotkeyText(this.plugin, command.id)}`,
					});
				setting.setDesc(frag);
				setting.addExtraButton((btn) => {
					btn.setIcon('keyboard').setTooltip(t('hotkeys.open'))
						.onClick(() => openHotkeySettings(this.plugin));
				});
			},
		};
	}

	// ── Tab 2: Back and forward ────────────────────────────────────────

	private getNavDefs(): SettingDefinitionItem[] {
		return [
			{
				// NO heading: the page is already named "Back and forward" (see
				// navHistory.heading), and a group heading saying it again under
				// itself is one line of chrome that names nothing the page has not.
				type: 'group',
				items: [
					this.intro(t('navHistory.intro')),
					this.hotkeys(t('navHistory.hotkeys.desc'), [
						{ id: 'navigate-back', name: t('navHistory.commands.navigateBack') },
						{ id: 'navigate-forward', name: t('navHistory.commands.navigateForward') },
					]),
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

	// ── Tab 3: Recent File ───────────────────────────────────────────────

	private getRecentFileDefs(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				items: [
					this.intro(t('recentFiles.intro')),
					// The two commands that OPEN this list, on the page that is about
					// it (see `hotkeys`). The back/forward pair is on its own page.
					this.hotkeys(t('recentFiles.hotkeys.desc'), [
						{ id: 'browse-nav-history', name: t('recentFiles.commands.open') },
						// The resident panel is a command like the other one, so it is
						// bound (or not) in the same place — see view.ts.
						{ id: 'open-nav-history-sidebar', name: t('recentFiles.commands.openSidebar') },
					]),
					{
						type: 'page',
						name: t('recentFiles.folders.name'),
						desc: (() => {
							const frag = createFragment();
							frag.createDiv({ text: t('recentFiles.folders.desc') });
							const folders = this.plugin.settings.navRecentExcludeFolders;
							if (folders.length === 0)
								return frag;
							const list = frag.createEl('ul', { cls: 'mod-muted' });
							for (const folder of folders.slice(0, 5))
								list.createEl('li', { text: folder + '/' });
							if (folders.length > 5)
								list.createEl('li', { text: '...' });
							return frag;
						})(),
						items: [
							{
								type: 'list',
								emptyState: t('recentFiles.folders.list.empty'),
								items: this.plugin.settings.navRecentExcludeFolders.map((folder) => ({
									name: folder + '/',
								})),
								onDelete: (index) => {
									const folders = this.plugin.settings.navRecentExcludeFolders.filter((_, i) => i !== index);
									void this.setControlValue('navRecentExcludeFolders', folders).then(() => this.update());
								},
								addItem: {
									name: t('recentFiles.folders.add'),
									action: () => {
										new FolderSuggestModal(
											this.app,
											this.plugin.settings.navRecentExcludeFolders,
											(path) => {
												const folders = [...this.plugin.settings.navRecentExcludeFolders, path];
												void this.setControlValue('navRecentExcludeFolders', folders)
													.then(() => this.update());
											}
										).open();
									},
								},
							},
						],
					},
					// WHAT A ROW PRINTS, and how far back the list reaches: the
					// browser's own preferences (see NavBrowserPrefs). They stand
					// here and no longer in a gear of the panel's toolbar — one
					// place that holds them, reached the way every other setting of
					// the plugin is, and no second copy inside a panel that is a
					// navigator rather than a control surface. A panel standing
					// open beside this page is redrawn as each of them is chosen
					// (see setControlValue), so the question "what does the list
					// look like" is answered in front of the reader either way.
					{
						name: t('recentFiles.landings.name'),
						desc: t('recentFiles.landings.desc'),
						control: {
							type: 'dropdown',
							key: 'navLandings',
							options: {
								last: t('recentFiles.landings.options.last'),
								all: t('recentFiles.landings.options.all'),
							},
						},
					},
					{
						name: t('recentFiles.pathDisplay.name'),
						desc: t('recentFiles.pathDisplay.desc'),
						control: {
							type: 'dropdown',
							key: 'navPathDisplay',
							options: {
								smart: t('recentFiles.pathDisplay.options.smart'),
								before: t('recentFiles.pathDisplay.options.before'),
								after: t('recentFiles.pathDisplay.options.after'),
							},
						},
					},
					{
						name: t('recentFiles.rowTime.name'),
						desc: t('recentFiles.rowTime.desc'),
						control: {
							type: 'toggle',
							key: 'navRowTime',
						},
					},
					{
						name: t('recentFiles.cap.name'),
						desc: t('recentFiles.cap.desc'),
						control: {
							type: 'number',
							key: 'navRecentCap',
							min: 20,
							max: 500,
							step: 10,
						},
					},
				],
			},
		];
	}
}

// Panel for changing the database file path. Built from plain DOM elements
// only — no Setting / TextComponent — because those components are thenable
// (`Setting.then`) and interacting badly with them inside a modal opened from
// the declarative settings tab can wedge Obsidian. Plain input + buttons keep
// the whole flow synchronous and predictable.
class DbPathModal extends Modal {
	constructor(
		app: App,
		private plugin: PositionRestorePlugin,
		private onApply: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: t('dataStorage.dbFileName.modal.title') });
		contentEl.createEl('p', { cls: 'mod-muted', text: t('dataStorage.dbFileName.desc') });
		contentEl.createEl('p', { cls: 'mod-muted', text: t('dataStorage.dbFileName.mergeHint') });
		// The modal is where a path is chosen by hand, so it is where the
		// Obsidian Sync rule has to be stated — out of a plugin folder Sync
		// carries only data.json, main.js, manifest.json and styles.css, and it
		// skips "."-folders. Folded away by default: it matters to the reader who
		// came here to make positions follow them, and would be four lines of
		// noise to everyone else.
		const syncHint = contentEl.createEl('details', { cls: 'position-restore-db-path-hint' });
		syncHint.createEl('summary', { text: t('dataStorage.dbFileName.syncSummary') });
		syncHint.createEl('p', { cls: 'mod-muted', text: t('dataStorage.dbFileName.syncHint') });

		const input = contentEl.createEl('input', {
			type: 'text',
			cls: 'position-restore-db-path-input',
			// A vault path is a case-sensitive sequence of folder names, so the
			// mobile keyboard has to be told not to capitalize the first letter,
			// not to autocorrect a segment into a word it knows, and not to
			// underline the whole thing as a misspelling.
			attr: { autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false' },
		});
		input.placeholder = this.plugin.database.defaultDbFileName;
		input.value = this.plugin.settings.dbFileName || '';

		const submit = async () => {
			const value = input.value.trim();
			if (!(await this.plugin.database.switchDbFile(value)))
				return;
			this.plugin.settings.dbFileName = value;
			await this.plugin.saveSettings();
			new Notice(value === '' ? t('dataStorage.dbFileName.messages.default') : t('dataStorage.dbFileName.messages.set', value));
			this.close();
			this.onApply();
		};

		input.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter')
				void submit();
		});

		// `is-pickers` is what lets the phone layout give each of these three
		// labels a row of its own (see styles.css); the action row below shares
		// the base class and must stay an inline pair.
		const pickers = contentEl.createDiv({ cls: 'position-restore-db-path-row is-pickers' });
		pickers.createEl('button', { text: t('dataStorage.dbFileName.pickFolder') })
			.addEventListener('click', () => {
				const current = input.value.trim() || this.plugin.database.defaultDbFileName;
				const name = current.substring(current.lastIndexOf('/') + 1);
				new FolderSuggestModal(this.app, [], (folder) => { input.value = `${folder}/${name}`; }).open();
			});
		pickers.createEl('button', { text: t('dataStorage.dbFileName.pickFile') })
			.addEventListener('click', () => {
				new DbFileSuggestModal(this.app, (file) => { input.value = file.path; }).open();
			});
		pickers.createEl('button', { text: t('dataStorage.dbFileName.modal.default') })
			.addEventListener('click', () => { input.value = ''; });

		const actions = contentEl.createDiv({ cls: 'position-restore-db-path-row is-actions' });
		actions.createEl('button', { text: t('dataStorage.dbFileName.modal.cancel') })
			.addEventListener('click', () => this.close());
		actions.createEl('button', { text: t('dataStorage.dbFileName.apply'), cls: 'mod-cta' })
			.addEventListener('click', () => { void submit(); });
	}

	onClose() {
		this.contentEl.empty();
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

// Fuzzy picker over every JSON file already in the vault. Lets a device that
// joins an existing sync setup point straight at the database another device
// created, instead of typing its path by hand.
class DbFileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private onSelect: (file: TFile) => void
	) {
		super(app);
		this.setPlaceholder(t('dataStorage.dbFileName.search.placeholder'));
		this.limit = 50;
		this.emptyStateText = t('dataStorage.dbFileName.search.empty');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles()
			.filter((f) => f.extension === 'json')
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onSelect(file);
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
// All runtime APIs here are untyped — a missing member or exhausted
// retries degrade silently to an unfiltered list.
function openHotkeySettings(plugin: PositionRestorePlugin): void {
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
