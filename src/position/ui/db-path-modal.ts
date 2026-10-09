import { App, Modal, Notice } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { FolderSuggestModal, DbFileSuggestModal } from '@/settings/pickers';
import { t } from '@/i18n';

// 数据库 path 落**在哪** —— 这也是设置项唯一能说的：在配置文件夹里、在隐藏文件夹里，或者作为
// 普通文件躺在 vault 里。这三种会不会跨设备，是读者的同步客户端的事：Obsidian Sync 只把插件
// 文件夹当 data.json / main.js / manifest.json / styles.css 带走，并跳过 "." 开头的文件夹；
// 而一个把整个配置文件夹镜像走的客户端则原样带走。数据库本身三种都收。
//
// 它和模态框放在一起，因为两者是一个答案：模态框是手动挑 path 的地方，而这里是页面就该 path
// 给出的说明。
export function dbSyncState(app: App, path: string): 'config' | 'hidden' | 'vault' {
	if (path === app.vault.configDir || path.startsWith(`${app.vault.configDir}/`))
		return 'config';
	const firstSegment = path.split('/')[0];
	return firstSegment.startsWith('.') ? 'hidden' : 'vault';
}

// 改数据库文件路径的面板。只用裸 DOM 元素搭 —— 不用 Setting / TextComponent ——
// 因为那些组件是 thenable 的（Setting.then），在从声明式设置页打开的模态框里跟它们缠在一起
// 可能把 Obsidian 卡死。
//
// 这个模态框认识插件、不认识设置页：它自己写设置，再由 `onApply` 通知设置页重画，
// 因为一个反过来伸进设置页的模态框会让那个页面再也走不出去。
export class DbPathModal extends Modal {
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
		// 模态框是手动挑 path 的地方，所以同步规则得在这儿讲清楚。默认折起来：
		// 对为「让位置跟着自己走」而来的读者才有用，对其他人就是四行噪音。
		const syncHint = contentEl.createEl('details', { cls: 'position-restore-db-path-hint' });
		syncHint.createEl('summary', { text: t('dataStorage.dbFileName.syncSummary') });
		syncHint.createEl('p', { cls: 'mod-muted', text: t('dataStorage.dbFileName.syncHint') });

		const input = contentEl.createEl('input', {
			type: 'text',
			cls: 'position-restore-db-path-input',
			// vault 的 path 是区分大小写的文件夹名，所以手机键盘不能替它首字母大写、
			// 自动更正或拼写检查。
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

		// `is-pickers` 让手机布局给这三个标签各占一行（见 styles.css）；
		// 下面的动作行共用基类，且必须保持成一对内联按钮。
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
