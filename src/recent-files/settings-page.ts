import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro, hotkeys } from '@/settings/page';
import { FolderSuggestModal, PropertySuggestModal, PropertyValueModal } from '@/settings/pickers';
import { t } from '@/i18n';

// 「最近文件」页 —— 地点列表在设置里的那张脸。它有三行是列表自己的规则（它拒绝哪些文件夹、
// 哪些 frontmatter、它往回够多远），另有三行是它的**样子**（见 RecentFilesBrowserPrefs）。
// 它站在地点列表和它的浏览器旁边，而不是放进 settings 文件夹，好让「我怎么改一行显示的东西」
// 落在与「显示它的代码」同一个架子上。
//
// 一个没有标题的分组，理由与前进/后退页一样：这个页面已经叫「最近文件」了。
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
				// 这份列表**留**一篇笔记的多少、以及它把**留下的**画多少 —— 一行、一条轴上的三个档
				// （见 LandingsMode）。两半是**一个**问题，因为一个从未被记录下来的落点画不出来：
				// 一个在选「看多少」的读者，已经答过了「留多少」，而问他们两遍会产生一个毫无意义的
				// 第四个答案。各档是单调的 —— 每一档留下并画出的，都是它上面那一档的超集 ——
				// 这正是它们能待在一个下拉里、而不是两个控件里的原因。
				//
				// 'all' 是默认：列表出厂就显示读者留下的每一个地点，而它也是唯一一个「在它下面两档能挑出
				// 东西来挑」的档 —— 一个从 'none' 开始、后来才碰到这一行的读者，会发现它底下什么都没记录。
				// 而且没有哪一档是单向门：往下走会让列表**停止记录**新的落点，但它已经记录下来的东西会一直
				// 留着，直到它所处的那篇笔记被挤出局。
				{
					name: t('recentFiles.landings.name'),
					desc: t('recentFiles.landings.desc'),
					control: {
						type: 'dropdown',
						key: 'recentFilesLandings',
						options: {
							none: t('recentFiles.landings.options.none'),
							last: t('recentFiles.landings.options.last'),
							all: t('recentFiles.landings.options.all'),
						},
					},
				},
				// 这份列表**记住多少篇笔记** —— 一个只有一个含义的数字，无论读者在上面那一行的哪一档：
				// 它数的是笔记和视图，从不数它们里面的落点，所以在各档之间移动，不会挪动他们已经设下的
				// 那个数字的球门。
				//
				// 它站在那一行**下面**、而不是上面，因为那一行正是这一个需要先被读的东西：一个还没答过
				// 「我想把我的导航记到多细」的读者，说不出一个笔记数是什么的数目 —— 是上面那一行让下面
				// 这一行变得可答。（而且它那句话写了两遍，只因为最顶那一档多欠一个从句：在那里落点是
				// 当作行画出来的，所以屏幕上的列表比这个数字长，尽管这个数字数的仍然是笔记。）
				{
					name: t('recentFiles.cap.name'),
					desc: ctx.plugin.settings.recentFilesLandings === 'all'
						? t('recentFiles.cap.desc.all')
						: t('recentFiles.cap.desc.plain'),
					control: {
						type: 'number',
						key: 'recentFilesCap',
						min: 20,
						max: 500,
						step: 10,
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
