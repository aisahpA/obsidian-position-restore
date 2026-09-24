import { App, Modal, Notice } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { FolderSuggestModal, DbFileSuggestModal } from '@/settings/pickers';
import { t } from '@/i18n';

// WHERE a database path sits — which is all the settings item may state:
// inside the configuration folder, inside a hidden folder, or out in the vault
// as an ordinary file. Whether any of those travels between devices is the
// reader's sync client's business: Obsidian Sync carries a plugin folder only
// as data.json / main.js / manifest.json / styles.css and skips "."-folders,
// while a client that mirrors the whole configuration folder carries them as
// they stand. The database itself accepts all three.
//
// It lives beside the modal because the two are one answer: the modal is where
// a path is chosen by hand, and this is what the page says about it.
export function dbSyncState(app: App, path: string): 'config' | 'hidden' | 'vault' {
	if (path === app.vault.configDir || path.startsWith(`${app.vault.configDir}/`))
		return 'config';
	const firstSegment = path.split('/')[0];
	return firstSegment.startsWith('.') ? 'hidden' : 'vault';
}

// Panel for changing the database file path. Built from plain DOM elements
// only — no Setting / TextComponent — because those components are thenable
// (Setting.then) and interacting badly with them inside a modal opened from the
// declarative settings tab can wedge Obsidian.
//
// The modal knows the plugin, not the tab: it writes the setting itself and
// the tab is told to redraw through `onApply`, because a modal that reached
// back into the tab would make the page unable to move out of it.
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
		// The modal is where a path is chosen by hand, so it is where the Sync
		// rule has to be stated. Folded away by default: it matters to the
		// reader who came here to make positions follow them, and would be four
		// lines of noise to everyone else.
		const syncHint = contentEl.createEl('details', { cls: 'position-restore-db-path-hint' });
		syncHint.createEl('summary', { text: t('dataStorage.dbFileName.syncSummary') });
		syncHint.createEl('p', { cls: 'mod-muted', text: t('dataStorage.dbFileName.syncHint') });

		const input = contentEl.createEl('input', {
			type: 'text',
			cls: 'position-restore-db-path-input',
			// A vault path is case-sensitive folder names, so the mobile
			// keyboard must not capitalize, autocorrect, or spellcheck it.
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

		// `is-pickers` lets the phone layout give each of these three labels a
		// row of its own (see styles.css); the action row below shares the base
		// class and must stay an inline pair.
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
