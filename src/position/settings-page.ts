import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro } from '@/settings/page';
import { FolderSuggestModal, PropertySuggestModal, PropertyValueModal } from '@/settings/pickers';
import { ESCAPE_HATCH_PROPERTY } from './policy/frontmatter';
import { dbSyncState, DbPathModal } from './ui/db-path-modal';
import { t } from '@/i18n';

// 「最后位置」页 —— 位置功能在设置里的那张脸。它配置这个功能的三件事：
// 一篇笔记记住什么、又怎么回来（打开与恢复），哪些笔记不去碰（记录规则），
// 以及记录住在哪儿（数据存储）。它属于这里，紧挨着它谈论的采集/恢复代码，
// 而不是放进一个按它恰好渲染进的那一层命名的文件夹 —— position/ui 与
// recent-files/browser 已经遵循同一条规则。
//
// 三个分组不是三个页面：它们是同一个问题（「我刚才在哪儿」）的一个答案，
// 所以共用一个引言和一个页面标题。这个页面自己不写任何东西 —— 每一行改列表
// 都把值交给 ctx.setValue，这个键随之该承担什么统一在一处施加
// （见 SettingsPageContext）。
export function positionSettingsPage(ctx: SettingsPageContext): SettingDefinitionItem[] {
	return [
		{
			// 引言独占一个分组，而不是当「打开与恢复」里的第一个条目：它介绍整页，
			// 坐在某个分组的标题下就成了那个分组的一句话。这里不加标题，
			// 理由与另外两页一样 —— 页面已经叫「最后位置」了。
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
				// app 自己的文件列表把悬停预览开在哪里。它是自己的一项设置，
				// 不与最近文件列表的那一行合并：两者是不同的地界，读者很可能想
				// 让两者各给不同答案。默认采用笔记顶部 —— 见 PreviewFocusMode。
				{
					name: t('previewFocus.fileExplorer.name'),
					desc: t('previewFocus.fileExplorer.desc'),
					control: {
						type: 'dropdown',
						key: 'fileExplorerPreviewFocus',
						options: {
							head: t('previewFocus.fileExplorer.options.head'),
							line: t('previewFocus.fileExplorer.options.line'),
						},
					},
				},
			// 两个开关是同一个问题的两种回答方式，所以并排坐：一个是「用名字」告诉读者
				// 落在哪一节（只有恢复时），一个是「用指向」标出落点那一行（恢复时与跳转后
				// 都有）。两者各管各的，谁也不折叠谁 —— 见 restoreBreadcrumb / flashLandingLine。
				{
					name: t('openAndRestore.restoreBreadcrumb.name'),
					desc: t('openAndRestore.restoreBreadcrumb.desc'),
					control: {
						type: 'toggle',
						key: 'restoreBreadcrumb',
					},
				},
				{
					name: t('openAndRestore.flashLandingLine.name'),
					desc: t('openAndRestore.flashLandingLine.desc'),
					control: {
						type: 'toggle',
						key: 'flashLandingLine',
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
						// 两种形态各占一行，而不是共用一段：几乎每个读者都是来查
						// 该打哪一种的，那是个拿来扫的问题、不是拿来读的。弱化显示，
						// 好让它们读起来是上面那句话下的细节，而不是第三个列表 ——
						// 已排除项的列表紧接着就在下面，两份长得像的属性名列表
						// 就太多了。
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
						// 文件在哪，一行弱化说明。默认位置在插件文件夹里，
						// 而多数同步方案不会整个带着它 —— 这是记录悄悄跟不上
						// 用户到另一台设备之前，读者需要知道的事实。
						// 它不点名任何同步客户端：那条规则属于对话框。
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
						const frag = createFragment();
						frag.createDiv({ text: t('dataStorage.entries.desc', String(count)) });
						// 光一个数字会招来错的问题（「我要丢位置了吗？」）——
						// 拆开才让它可读，而这个拆分只在确有其事时才值得说。
						const atDefault = ctx.plugin.database.countDefaultPosition();
						if (atDefault > 0)
							frag.createDiv({ cls: 'mod-muted', text: t('dataStorage.entries.atDefault', String(atDefault)) });
						setting.setDesc(frag);
					},
				},
			],
		},
	];
}
