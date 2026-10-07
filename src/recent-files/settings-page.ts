import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro, hotkeys } from '@/settings/page';
import { FolderSuggestModal, PropertySuggestModal, PropertyValueModal } from '@/settings/pickers';
import { t } from '@/i18n';

// 「最近文件」页 —— 地点列表在设置里的那张脸。它的行分成两组，回答两个问题：这份列表
// **收**谁、往回记多远（它拒绝哪些文件夹、哪些 frontmatter、记住多少篇），与进来之后
// 一行**长什么样**（见 RecentFilesBrowserPrefs）。它站在地点列表和它的浏览器旁边，
// 而不是放进 settings 文件夹，好让「我怎么改一行显示的东西」落在与「显示它的代码」
// 同一个架子上。
//
// 导言与快捷键独占一个**无标题**的分组：两者讲的是整页，挂到任一标题下就成了那一组的
// 一句话——同「最后位置」页的导言。两个标题写的是上面那两问本身，不是把页名再写一遍。
export function recentFilesSettingsPage(ctx: SettingsPageContext): SettingDefinitionItem[] {
	return [
		{
			type: 'group',
			items: [
				intro(t('recentFiles.intro')),
				// **打开**这份列表的两条命令，放在关于它的这一页上（见 hotkeys 行构建器）。
				// 前进/后退那一对在它自己的页上。
				hotkeys(ctx.plugin, t('recentFiles.hotkeys.desc'), [
					{ id: 'browse-recent-files', name: t('recentFiles.commands.open') },
					// 常驻面板与另一条一样是一条命令，所以它在同一个地方被绑定（或不绑）—— 见 view.ts。
					{ id: 'open-recent-files-sidebar', name: t('recentFiles.commands.openSidebar') },
				]),
			],
		},
		{
			type: 'group',
			heading: t('recentFiles.rules.heading'),
			items: [
				{
					type: 'page',
					name: t('recentFiles.folders.name'),
					desc: (() => {
						const frag = createFragment();
						frag.createDiv({ text: t('recentFiles.folders.desc') });
						const folders = ctx.plugin.settings.recentFilesExcludeFolders;
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
							items: ctx.plugin.settings.recentFilesExcludeFolders.map((folder) => ({
								name: folder + '/',
							})),
							onDelete: (index) => {
								const folders = ctx.plugin.settings.recentFilesExcludeFolders.filter((_, i) => i !== index);
								void ctx.setValue('recentFilesExcludeFolders', folders);
							},
							addItem: {
								name: t('recentFiles.folders.add'),
								action: () => {
									new FolderSuggestModal(
										ctx.app,
										ctx.plugin.settings.recentFilesExcludeFolders,
										(path) => {
											const folders = [...ctx.plugin.settings.recentFilesExcludeFolders, path];
											void ctx.setValue('recentFilesExcludeFolders', folders);
										}
									).open();
								},
							},
						},
					],
				},
				// 这份列表**拒绝哪些 frontmatter** —— 与上面那条文件夹规则同一个问题，但由笔记自己
				// 一次一篇地作答、而不是由它所在的位置：另一个插件拥有的看板、一个被标记为已发布的页面、
				// 一个模板。它是这份列表**自己的**列表、不是位置页的，理由与那些文件夹一样
				// （见 PluginSettings.recentFilesExcludeProperties）：一篇光标位置不值得留的笔记，
				// 仍是读者会导航去的一篇笔记。
				//
				// 它打开的那两个选择器与位置页共用（见 settings/pickers.ts）—— 属性名无论哪一页来要
				// 都是同一个属性名 —— 所以读者在那里学会的输入形式，就是在这里管用的形式。
				{
					type: 'page',
					name: t('recentFiles.frontmatterExclude.name'),
					desc: (() => {
						const frag = createFragment();
						frag.createDiv({ text: t('recentFiles.frontmatterExclude.desc') });
						frag.createDiv({
							cls: 'mod-muted',
							text: t('recentFiles.frontmatterExclude.formName'),
						});
						frag.createDiv({
							cls: 'mod-muted',
							text: t('recentFiles.frontmatterExclude.formValue'),
						});
						const props = ctx.plugin.settings.recentFilesExcludeProperties;
						if (props.length === 0)
							return frag;
						const list = frag.createEl('ul', { cls: 'mod-muted' });
						for (const prop of props.slice(0, 5))
							list.createEl('li', { text: prop });
						if (props.length > 5)
							list.createEl('li', { text: '...' });
						return frag;
					})(),
					items: [
						{
							type: 'list',
							emptyState: t('recentFiles.frontmatterExclude.list.empty'),
							items: ctx.plugin.settings.recentFilesExcludeProperties.map((prop) => ({
								name: prop,
							})),
							onDelete: (index) => {
								const props = ctx.plugin.settings.recentFilesExcludeProperties.filter((_, i) => i !== index);
								void ctx.setValue('recentFilesExcludeProperties', props);
							},
							addItem: {
								name: t('recentFiles.frontmatterExclude.add'),
								action: () => {
									new PropertySuggestModal(
										ctx.app,
										(name) => {
											new PropertyValueModal(
												ctx.app,
												name,
												ctx.plugin.settings.recentFilesExcludeProperties,
												(entry) => {
													const props = [...ctx.plugin.settings.recentFilesExcludeProperties, entry];
													void ctx.setValue('recentFilesExcludeProperties', props);
												}
											).open();
										}
									).open();
								},
							},
						},
					],
				},
				// 这份列表**记住多少篇笔记**。一个只有一个含义的数字：它数的是行，而一行就是
				// 一篇笔记（或一个视图），所以没有第二个名额池要跟着它一起被解释。
				//
				// 它跟上面两条规则同属一组，而不是跟下面那批样子项：它答的是「往回够多远」，
				// 与它们一样是一道闸门。
				{
					name: t('recentFiles.cap.name'),
					desc: t('recentFiles.cap.desc'),
					control: {
						type: 'number',
						key: 'recentFilesCap',
						min: 20,
						max: 500,
						step: 10,
					},
				},
			],
		},
		{
			type: 'group',
			heading: t('recentFiles.display.heading'),
			items: [
				// 搜索框是否把**各篇笔记的小节标题**也算进搜索面：开着时，输一个标题词会把
				// 命中的那一节作为一行画在那篇笔记下面，点它去那一节。
				//
				// 它是这个面板**唯一**一个关于「记多细」的开关，因为另一半已经不在了：这份
				// 列表只记笔记，一次跳转记下来的是「读者在这篇笔记里」（见 places.ts），所以
				// 没有什么「记不记落点」可选 —— 能选的只剩搜索能找到什么。
				//
				// 默认开：搜索框是读者带着一个**词**来的地方，而一篇笔记里的小节是「我只记得
				// 它在某一节里说过」这种记忆唯一能被兑出来的地方。
				{
					name: t('recentFiles.outlineSearch.name'),
					desc: t('recentFiles.outlineSearch.desc'),
					control: {
						type: 'toggle',
						key: 'recentFilesOutlineSearch',
					},
				},
				{
					name: t('recentFiles.pathDisplay.name'),
					desc: t('recentFiles.pathDisplay.desc'),
					control: {
						type: 'dropdown',
						key: 'recentFilesPathDisplay',
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
						key: 'recentFilesRowTime',
					},
				},
				// 一行把笔记**叫作**什么。一个属性、而不是一串：哪一个算数是读者能记在脑子里的答案，
				// 而没有它的笔记并非无名 —— 它会退回它的文件名，所以没有第二项设置来说该优先哪个。
				//
				// 空就是**关**，而关是默认：一个用文件名命名笔记的 vault 不欠这一行任何东西，
				// 而一个不这样的 vault 才是唯一必须说出来的那个。
				{
					name: t('recentFiles.titleProperty.name'),
					desc: t('recentFiles.titleProperty.desc'),
					control: {
						type: 'text',
						key: 'recentFilesTitleProperty',
						placeholder: t('recentFiles.titleProperty.placeholder'),
					},
				},
				// 被悬停的一行**在 app 自己的预览里**把笔记打开在哪里。默认是笔记头部，因为另一档要付
				// 一次等待：点名一行会让整篇笔记先被画出来、然后卡片再移过去，为那次等待换来的是这一行
				// **自己点击**时已经给出的那个到达。一个代表笔记里某个**地点**的行，两种情况都在这个
				// 选择之外 —— 它就在那个地点打开。
				{
					name: t('previewFocus.recentFiles.name'),
					desc: t('previewFocus.recentFiles.desc'),
					control: {
						type: 'dropdown',
						key: 'recentFilesPreviewFocus',
						options: {
							head: t('previewFocus.recentFiles.options.head'),
							line: t('previewFocus.recentFiles.options.line'),
						},
					},
				},
			],
		},
	];
}
