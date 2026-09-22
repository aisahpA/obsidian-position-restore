import { App, FuzzySuggestModal, Modal, Setting, TFolder, TFile, TextComponent, Notice } from 'obsidian';
import { t } from '@/i18n';

// obsidian@1.13.2 types omit getAllPropertyInfos (added in Obsidian 1.4).
// The augmentation stands next to its only consumer (PropertySuggestModal
// below) rather than with the tab: it is a fact about what a property picker
// may ask the app, not about the settings surface.
declare module 'obsidian' {
	interface MetadataCache {
		getAllPropertyInfos(): Record<string, unknown>;
	}
}

// THE SMALL MODALS THAT ASK FOR ONE THING — a folder, a JSON file, a property
// name, then that property's value. They are kept in one file because they are
// one family with one shape (fuzzy list over something the vault already has,
// or a two-step name-then-value input), and because two of them are shared:
// FolderSuggestModal answers for the excluded-folder lists on the last-position
// page AND on the recent-files page, and the property pair is one flow split in
// two. Which PAGE a picker is opened from is not visible here — a picker is
// handed a list to avoid and a callback to answer through, so the same modal
// serves both.
export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
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
// created, instead of typing its path by hand. The only caller is the database
// path modal — it lives here rather than with that modal because it is the same
// picker shape as its neighbours, not because anything else shares it.
export class DbFileSuggestModal extends FuzzySuggestModal<TFile> {
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
export class PropertySuggestModal extends FuzzySuggestModal<string> {
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
export class PropertyValueModal extends Modal {
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
