import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro } from '@/settings/page';
import { FolderSuggestModal, PropertySuggestModal, PropertyValueModal } from '@/settings/pickers';
import { ESCAPE_HATCH_PROPERTY } from './policy/frontmatter';
import { dbSyncState, DbPathModal } from './ui/db-path-modal';
import { t } from '@/i18n';

// THE "LAST POSITION" PAGE — the position feature's own face in the settings.
// It configures the three things this feature is: what a note remembers and how
// it comes back (Open & restore), which notes are left alone (Recording rules),
// and where the records live (Data storage). It belongs here, next to the
// capture/restore code it talks about, rather than in a folder named after the
// layer it happens to render into — the same rule position/ui and
// recent-files/browser already follow.
//
// The three groups are NOT three pages: they are one answer to one question
// ("where was I"), which is why they share an intro and a page title. The page
// writes nothing itself — every row that changes a list hands the value to
// ctx.setValue, and what the key owes in consequence is applied in one place
// (see SettingsPageContext).
export function positionSettingsPage(ctx: SettingsPageContext): SettingDefinitionItem[] {
	return [
		{
			// The intro gets a group of its own, and not a first item inside
			// "Open & restore": it introduces the whole page, and sitting
			// under one group's heading would make it that group's sentence.
			// No heading here, for the reason the other two pages have none —
			// the page is already named "Last position".
			type: 'group',
			items: [intro(t('lastPosition.intro'))],
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
						const folders = ctx.plugin.settings.excludedFolders;
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
							items: ctx.plugin.settings.excludedFolders.map((folder) => ({
								name: folder + '/',
							})),
							onDelete: (index) => {
								const folders = ctx.plugin.settings.excludedFolders.filter((_, i) => i !== index);
								void ctx.setValue('excludedFolders', folders);
							},
							addItem: {
								name: t('recordingRules.folders.add'),
								action: () => {
									new FolderSuggestModal(
										ctx.app,
										ctx.plugin.settings.excludedFolders,
										(path) => {
											const folders = [...ctx.plugin.settings.excludedFolders, path];
											void ctx.setValue('excludedFolders', folders);
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
						// The two forms get a line each instead of sharing a
						// paragraph: almost every reader arrives to check
						// which of the two they should type, and that is a
						// question to scan for, not to read for. Muted, so
						// they read as detail under the sentence above rather
						// than as a third list — the list of what is already
						// excluded follows right below, and two bullet lists
						// of look-alike property names would be one too many.
						frag.createDiv({
							cls: 'mod-muted',
							text: t('recordingRules.frontmatterExclude.formName'),
						});
						frag.createDiv({
							cls: 'mod-muted',
							text: t('recordingRules.frontmatterExclude.formValue'),
						});
						const props = ctx.plugin.settings.frontmatterExcludeProperties;
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
							items: ctx.plugin.settings.frontmatterExcludeProperties.map((prop) => ({
								name: prop,
							})),
							onDelete: (index) => {
								const props = ctx.plugin.settings.frontmatterExcludeProperties.filter((_, i) => i !== index);
								void ctx.setValue('frontmatterExcludeProperties', props);
							},
							addItem: {
								name: t('recordingRules.frontmatterExclude.add'),
								action: () => {
									new PropertySuggestModal(
										ctx.app,
										(name) => {
											new PropertyValueModal(
												ctx.app,
												name,
												ctx.plugin.settings.frontmatterExcludeProperties,
												(entry) => {
													const props = [...ctx.plugin.settings.frontmatterExcludeProperties, entry];
													void ctx.setValue('frontmatterExcludeProperties', props);
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
						const current = ctx.plugin.settings.dbFileName || ctx.plugin.database.defaultDbFileName;
						const state = dbSyncState(ctx.app, current);
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
								.onClick(() => new DbPathModal(ctx.app, ctx.plugin, () => ctx.refresh()).open());
						});
					},
				},
				{
					name: t('dataStorage.entries.name'),
					render: (setting) => {
						const count = Object.keys(ctx.plugin.database.db).length;
						setting.setDesc(t('dataStorage.entries.desc', String(count)));
					},
				},
			],
		},
	];
}
