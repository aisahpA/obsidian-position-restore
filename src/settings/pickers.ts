import { App, FuzzySuggestModal, Modal, Setting, TFolder, TFile, TextComponent, Notice } from 'obsidian';
import { t } from '@/i18n';

// obsidian@1.13.2 的类型定义漏了 getAllPropertyInfos（1.4 才加的）。这段类型扩展
// 放在它唯一的用处旁边（下面的 PropertySuggestModal），而不是跟 tab 放一起：它是
// 「属性选择器可以问 app 什么」这件事，与设置界面无关。
declare module 'obsidian' {
	interface MetadataCache {
		// 键是「小写折叠后」的名字——app 靠它把 `MyProp` 和 `myprop` 合成同一个属性
		// ——而笔记里真正写的那个拼法在 `name` 里。
		getAllPropertyInfos(): Record<string, { name: string }>;
	}
}

// 只问一件事的小模态框——一个文件夹、一个 JSON 文件、一个属性名，然后是那个属性的值。
// 它们放一个文件里，是因为属于同一族、形状也一样（在仓库已有的东西上做模糊列表，或者
// 「先名字后值」两步输入），也因为其中两个是共用的：FolderSuggestModal 同时服务「最后
// 位置」页和「最近文件」页的排除文件夹列表，属性那两个是一段流程拆成的两步。选择器是从
// 哪一页打开的，在这里看不出来——它拿到的是「要避开哪些」和「选完回哪个回调」，所以
// 同一个模态框两边都能用。
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

// 在仓库已有的 JSON 文件里做模糊选择。让一台后来加入既有同步方案的设备，直接指到另一
// 台设备建的数据文件上，不用手打路径。唯一的调用方是数据库路径模态框——它住在这里而不是
// 跟那个模态框走，是因为形状与近邻一致，不是因为还有别人用它。
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

// 挑一个 frontmatter 属性名的模糊选择框，与选文件夹那套流程一致。罗列仓库里已有的全部
// 属性（metadataCache）。已被排除的属性照样显示：同一个名字可以因为好几个不同的值被排除。
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
		// 取存下来的 `name`，绝不取 key：app 的索引以小写名字为键，写成 `myprop`
		// 的规则会静默地永远匹配不上写着 `MyProp` 的笔记——属性名保留大小写。
		return Object.values(this.app.metadataCache.getAllPropertyInfos())
			.map((info) => info.name)
			.sort((a, b) => a.localeCompare(b));
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.onSelect(item);
	}
}

// 属性流程的第二步：问要匹配的值。输入留空表示只按「有没有这个属性」来排除（记作
// `name`）；否则条目就是 `name: value`。
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
