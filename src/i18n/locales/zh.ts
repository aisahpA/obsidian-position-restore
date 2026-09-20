import type { En } from './en';

export const zh: En = {
	'openAndRestore.heading': '打开与恢复',
	'openAndRestore.defaultPosition.name': '编辑视图的默认位置',
	'openAndRestore.defaultPosition.desc':
		'当某个文件没有已保存的位置时，将光标和滚动位置定位到此处。注意：此设置仅适用于编辑视图；阅读视图不使用此设置。',
	'openAndRestore.defaultPosition.options.default': '文件开头（Obsidian 默认）',
	'openAndRestore.defaultPosition.options.fileEnd': '文件末尾',

	'openAndRestore.linkOpenPosition.name': '双链打开位置',
	'openAndRestore.linkOpenPosition.desc':
		'点击普通双链（不带 # 标题或 ^ 块目标）时，是始终从文件开头打开，还是使用已保存的位置。',
	'openAndRestore.linkOpenPosition.options.start': '文件开头',
	'openAndRestore.linkOpenPosition.options.restore': '已保存的位置',

	'openAndRestore.sourceRestoreMethod.name': '编辑视图的恢复方式',
	'openAndRestore.sourceRestoreMethod.desc':
		'在编辑视图中如何恢复已保存的位置。“直接跳转”立即定位到保存的行；“平滑滚动”从顶部滚动到该行。',
	'openAndRestore.sourceRestoreMethod.options.instant': '直接跳转',
	'openAndRestore.sourceRestoreMethod.options.glide': '平滑滚动',

	'openAndRestore.readingRestoreMethod.name': '阅读视图的恢复方式',
	'openAndRestore.readingRestoreMethod.desc':
		'在阅读视图中如何恢复已保存的位置。“直接跳转”在渲染完成后立即定位，“平滑滚动”从顶部滚动到该行。',
	'openAndRestore.readingRestoreMethod.options.instant': '直接跳转',
	'openAndRestore.readingRestoreMethod.options.glide': '平滑滚动',

	'openAndRestore.restoreIndicator.name': '位置恢复提示',
	'openAndRestore.restoreIndicator.desc':
		'恢复位置后，向用户显示的提示信息。面包屑：显示当前所在的标题路径；光标高亮：短暂闪烁光标所在的行。',
	'openAndRestore.restoreIndicator.options.off': '关闭',
	'openAndRestore.restoreIndicator.options.breadcrumb': '仅面包屑',
	'openAndRestore.restoreIndicator.options.both': '面包屑 + 光标高亮',

	'recordingRules.heading': '记录规则',

	'recordingRules.folders.name': '排除的文件夹',
	'recordingRules.folders.desc': '不记录这些文件夹及子文件夹中文件的光标和滚动位置。',
	'recordingRules.folders.list.empty': '未排除任何文件夹',
	'recordingRules.folders.add': '添加文件夹',
	'recordingRules.folders.search.placeholder': '输入以搜索文件夹…',
	'recordingRules.folders.search.empty': '未找到文件夹',

	'recordingRules.minLinesToRecord.name': '不记录过短文件',
	'recordingRules.minLinesToRecord.desc':
		'行数少于该值的文件不记录其光标/滚动位置。设为“0”可关闭此过滤。',

	'recordingRules.frontmatterExclude.name': '按 frontmatter 属性/值排除',
	'recordingRules.frontmatterExclude.desc':
		'frontmatter 匹配任一这些条目的文件不记录位置。条目可以是属性名（`publish`）——只要含该属性即排除；也可以是 `属性: 值`（`publish: true`）——仅当属性值等于该值才排除（yes/no/on/off 视为布尔，数组命中任一元素即匹配）。这些属性通常已为其他插件而存在，因此无需修改任何文件。删除全部条目以关闭此功能。注意裸属性名：填 "tags" 会排除几乎全部笔记。',
	'recordingRules.frontmatterExclude.list.empty': '未排除任何属性',
	'recordingRules.frontmatterExclude.add': '添加属性',
	'recordingRules.frontmatterExclude.search.placeholder': '输入以搜索属性…',
	'recordingRules.frontmatterExclude.search.empty': '未找到属性',
	'recordingRules.frontmatterExclude.value.title': '{0} 等于以下值时排除',
	'recordingRules.frontmatterExclude.value.name': '值',
	'recordingRules.frontmatterExclude.value.desc': '留空表示只要文件含该属性即排除，无论其值如何。',
	'recordingRules.frontmatterExclude.value.placeholder': '如 true',
	'recordingRules.frontmatterExclude.duplicate': '{0} 已在列表中',

	'recordingRules.escapeHatch.name': '单文件覆盖属性',
	'recordingRules.escapeHatch.desc':
		'任何文件也可单独开启或关闭记录，无需改动设置：`{0}: false` 表示绝不记录（优先于上方所有规则），`{0}: true` 表示总是记录（优先于排除的文件夹、最短行数过滤与属性规则）。其他值一律忽略。',

	'recordingRules.recordBaseScroll.name': '记录 Base 文件的滚动位置',
	'recordingRules.recordBaseScroll.desc':
		'默认关闭。保存的是原始像素偏移量，只对记录它的那台设备有意义——若数据文件跨设备同步，另一台设备的记录会用不适合本机屏幕的偏移量覆盖本机记录。PDF 始终不记录：Obsidian 已在每台设备上原生记忆 PDF 阅读位置。其他非 Markdown 文件（图片等）一律不记录。',

	'dataStorage.heading': '数据存储',

	'dataStorage.dbFileName.name': '数据文件',
	'dataStorage.dbFileName.desc': '保存位置记录的 JSON 文件。',
	'dataStorage.dbFileName.current': '当前路径：{0}',
	'dataStorage.dbFileName.change': '更改',
	'dataStorage.dbFileName.modal.title': '设置数据文件',
	'dataStorage.dbFileName.modal.default': '恢复默认',
	'dataStorage.dbFileName.modal.cancel': '取消',
	'dataStorage.dbFileName.apply': '确认并应用',
	'dataStorage.dbFileName.pickFolder': '选择文件夹',
	'dataStorage.dbFileName.pickFile': '从仓库已有的 JSON 文件中选择',
	'dataStorage.dbFileName.search.placeholder': '输入以搜索仓库内的 JSON 文件',
	'dataStorage.dbFileName.search.empty': '未找到 JSON 文件',
	'dataStorage.dbFileName.messages.default': '当前使用默认数据文件。',
	'dataStorage.dbFileName.messages.invalid': '数据文件必须是仓库内的相对路径，且需以 .json 结尾。',
	'dataStorage.dbFileName.messages.exists': '该路径已存在文件，但它不是有效的本插件数据文件。未做任何改动，请另选文件或先手动删除它。',
	'dataStorage.dbFileName.mergeHint':
		'若所选文件已存在，会先将其中的记录合并到当前数据，再移动过去；文件不存在时则直接移动。',
	'dataStorage.dbFileName.messages.merged': '已采用现有数据文件，并合并了其中 {0} 条记录。',
	'dataStorage.dbFileName.messages.moveFailed': '移动数据文件失败：{0}',
	'dataStorage.dbFileName.messages.set': '数据文件已设为 {0}',
	// 文件放在哪里是设置项可以陈述的“位置”事实；它是否因此被同步则不是——那取决
	// 于用户使用的同步工具，而坚果云 / Remotely Save / iCloud / git 等工具恰恰会
	// 同步 Obsidian Sync 跳过的插件目录。所以页面只说位置，Obsidian Sync 的规则
	// 与它的名字留到弹窗的折叠说明里，因为那里问的正是这个问题。
	'dataStorage.dbFileName.syncLocal': '位于插件目录内（默认）——它是否随 vault 同步，取决于你使用的同步工具。',
	'dataStorage.dbFileName.syncVault': '位于仓库内——普通仓库文件，任何同步工具都能同步它。',
	'dataStorage.dbFileName.syncHidden': '位于隐藏文件夹内——部分同步工具会跳过以“.”开头的文件夹。',
	'dataStorage.dbFileName.syncSummary': '这个文件会被 Obsidian Sync 同步吗？',
	'dataStorage.dbFileName.syncHint':
		'Obsidian Sync 只会从社区插件目录中同步 data.json、main.js、manifest.json 和 styles.css，因此数据文件留在默认位置时不会离开写入它的那台设备。想让位置在设备之间跟着你走，请把数据文件指向仓库内的路径（用下方的按钮选择或新建文件夹），并在每台设备的 Obsidian Sync 中开启“同步其他所有类型文件”。以“.”开头的文件夹永远不会被 Obsidian Sync 同步，请选择普通的仓库文件夹。',

	'dataStorage.corruptDb.notice':
		'数据文件无法解析（可能正被同步工具改写），已保留一份副本：{0}。本次从空数据继续，重新打开笔记会重新记录位置。',
	'dataStorage.corruptDb.noticeNoCopy':
		'数据文件无法解析（可能正被同步工具改写），且未能写出副本，其中的位置记录无法找回。本次从空数据继续，重新打开笔记会重新记录位置（详情见控制台）。',

	'dataStorage.entries.name': '记录数',
	'dataStorage.entries.desc':
		'当前记录了 {0} 个文件的位置，最多支持 750 条记录。超出上限时，将优先移除最久未访问的文件的位置记录。',

	'navHistory.heading': '导航历史',
	// 设置项本身就是分组标题下的内容，不能再重复一遍标题（见 settings-tab）：
	// 它装的是快捷键清单。
	'navHistory.hotkeys.name': '快捷键',
	// 弹窗自己的标题：它上面没有标题可以重复。
	'navHistory.overview.name': '最近文件',
	'navHistory.overview.desc':
		'类似 VSCode 的“后退 / 前进”导航：记录文件切换与文件内跳转（链接、大纲、搜索结果、大范围光标移动）供命令回溯。功能始终开启，只需绑定快捷键（默认未绑定）。同一标签页内的文件切换走 Obsidian 原生标签页历史（含 PDF、Canvas 等视图）；历史栈大小可在下方调整，按设备保存在 localStorage，重启保留。',
	'navHistory.overview.hotkeyUnbound': '未绑定——点击右侧按钮设置',
	'navHistory.overview.openHotkeySettings': '打开快捷键设置',

	'navHistory.recentFolders.name': '不收录的文件夹',
	'navHistory.recentFolders.desc': '这些文件夹里的文件不会进入最近文件列表。它和上面的记录规则是两回事：一个你不想记住滚动位置的文件夹，可能恰恰是你想回头再打开的。',
	'navHistory.recentFolders.list.empty': '所有文件夹都会收录。',
	'navHistory.recentFolders.add': '添加文件夹',
	'navHistory.recentCap.name': '保留地点数',
	'navHistory.recentCap.short': '（最近 100 个）',
	'navHistory.recentCap.medium': '（最近 200 个）',
	'navHistory.recentCap.long': '（最近 500 个）',
	'navHistory.stackCap.name': '前进/后退保留步数',
	'navHistory.stackCap.desc': '导航历史最多保留的条目数，超出后优先丢弃最旧的记录。',
	'navHistory.recordActivation.name': '记录标签页切换',
	'navHistory.recordActivation.desc': '点击其他标签页/面板会推入一条历史（类似 VSCode）。关闭后仅记录文件打开与文件内跳转（关系图谱标签页的步骤也将不再记录）。',
	'navHistory.recordTeleport.name': '记录大范围光标跳变',
	'navHistory.recordTeleport.desc': '光标一次性跨越多行的移动（远距离点击、跳转到行、vim 翻页跳转）会推入一条历史。若滚动或误点常污染历史，可关闭。',
	// 一个文件在历史列表里打印几个落点。这个设置本身也在页面上——工具栏最右端那个小按钮
	// （见 NavHistoryBrowser.settings），因为读者是在看着列表做这个决定的：默认跟着读者自己
	// 的走法——读历史基本是按文件走的，最后那一个才是「返回」会回到的地方，而它已经由笔记
	// 那一行代表（点一下看它、箭头跳过去），所以列表里不再需要任何子级。
	'navHistory.landings.name': '列表里的落点',
	'navHistory.listSettings': '设置',
	// 说明简化成几个字，写在答案自己后面（见 NavHistoryBrowser.settingGroup），并用括号
	// 括起来——读到的是一句关于答案的注，而不是第二个标签。一段话堆在整组下面，得先点名
	// 两个选项才能开口，读者还得从一堵小字墙里挑出属于自己正看着的那一档；写在答案旁边，
	// 字就落在答案上。括号跟着字走：一对半角还是全角，是各语言自己的事。
	'navHistory.landings.options.last': '每篇一行',
	'navHistory.landings.options.last.desc': '（只留最后落点）',
	'navHistory.landings.options.all': '全部落点',
	'navHistory.landings.options.all.desc': '（每个落点都列出）',
	// 是否让列表讲一行落点是什么（见 PluginSettings.navShowDetails）。默认关闭：历史首先是
	// 一张「回去哪儿」的清单，「这一步当时是什么样」是读者自己的选择——就在它改变的这张
	// 列表上选。这一组只有一行，不是上面那种两档：读者不是在「显示」和「不显示」之间挑
	// 一个，行本身就是开关，勾就是它的状态。
	'navHistory.details.name': '落点详情',
	'navHistory.details.show': '显示',
	'navHistory.details.show.desc': '（行首三角打开的落点详情）',

	'navHistory.commands.navigateBack': '后退',
	'navHistory.commands.navigateForward': '前进',
	'navHistory.commands.browseHistory': '打开最近文件',
	// 同一个浏览器的常驻形态：侧栏面板而非弹窗（见 view.ts）。命名强调「放在哪儿」
	// 而不是「做什么」，因为这正是两者的区别——面板被放下后就留在那里。
	'navHistory.commands.browseHistorySidebar': '在侧边栏打开最近文件',

	'navHistory.type.open': '打开',
	'navHistory.type.switch': '切换',
	'navHistory.type.teleport': '跳变',
	'navHistory.type.outline': '大纲',
	'navHistory.type.link': '链接',
	'navHistory.type.graph': '图形',
	'navHistory.graphView': '关系图谱',
	'navHistory.searchPlaceholder': '按笔记名或文本过滤…',
	'navHistory.noMatch': '没有匹配的历史。',
	// 以前这里还有「文件筛选」：一个「只看本笔记」开关加上一个选择器 chip（点开是历史
	// 里出现过的所有笔记）。两个控件都是搜索框已经能回答的问题——笔记名本身就是它匹配
	// 的文本——却各自占着工具栏的一格和一份状态，所以一起去掉了（见 modal.ts）。
	'navHistory.empty': '暂无可跳转的位置。',

	// 面板自身：点击提示。列表现在是个导航器：点一行就是打开那一行代表的文件，行首那个
	// 三角则是「看这一行自己的详情」（见 NavHistoryList.disclose）。两件事各有一个靶子，
	// 提示要教的正是这一点。`{arrow}` 是行首那个三角在句子里落笔的位置（见
	// NavHistoryBrowser.hint）——提示让人去找它，就得画出列表上真正的那一个，而不是打一
	// 个形状不同的字符。
	// 「展开」不在这两句话里：详情显示哪一份内容由齿轮里那个按钮决定（见
	// NavHistoryBrowser.settings），而那与手势无关，所以提示不点名它，也就不会被它留在
	// 旧档位上。
	// 但「有没有详情」确实会换掉整句话，那句话在设置改变时会重写（见 fillHint）：下面两句
	// 是点名那个控件的，再下面两句是关掉详情栏的读者读到的。
	'navHistory.touchHint': '轻点一行打开，轻点 {arrow} 看这一处',
	// ……鼠标下的同一套手势，两种外壳都一样：列表只认点击（见 NavHistoryList），打开由行
	// 本身承担，行首的三角看详情，鼠标划过什么也不做——只是路过一行的指针既不动位置，也
	// 不打开任何东西。（键盘仍然可用——↑↓ 走、Enter 打开——只是这行提示要教的不是它。）
	'navHistory.clickHint': '单击一行打开 · {arrow} 看这一处',
	// 同样的两种设备，没有详情栏可看：只剩一个手势，句子说完就停。两句里都没有 `{arrow}`，
	// 因为那枚三角不在列表上（见 NavHistoryList.disclose）。
	'navHistory.touchHintOpen': '轻点一行打开',
	'navHistory.clickHintOpen': '单击一行打开',
	// 行首那个三角自己的说法：拿它当提示文字（title）。
	'navHistory.showDetails': '看详情',
	// 同一个文件的第二个标签页/分栏：没有这个标记，两栏的行无法区分。
	// 只写“第几个/共几个”：不用词，因为那个词是行内“安静区”里最宽的东西。
	'navHistory.pane': '{0}/{1}',
	'navHistory.disabledTip': '文件已删除，这一步无法恢复',
	// 一个折叠了多个相近落点的行打印的坐标范围（见 groupByFile 与 LANDING_MERGE_LINES）：
	// 第二个 L 省掉——它和第一个在同一列里，而这一列在手机上很窄。
	'navHistory.lineRange': 'L{0}–{1}',
	// 相对时间不再是列表里的一列（见 listing.ts）：只剩下落点预览面板的头部在用。
	'navHistory.time.now': '刚刚',
	'navHistory.time.minutes': '{0} 分钟前',
	'navHistory.time.hours': '{0} 小时前',
	'navHistory.time.days': '{0} 天前',
	// 落点抽屉：渲染的是条目自己记录的上下文块（用户离开时正在看的那几行），背后没有
	// 任何读取；也可以显示这篇笔记现在的样子（一次库读取，见 PreviewContent）。两者都
	// 交给 Obsidian 自己的 markdown 渲染器，所以既没有「读取中」这个状态，屏幕上也不
	// 会出现原始 markdown 源码。
	'navHistory.preview.none': '（不是一个可预览的 markdown 落点）',
	'navHistory.preview.gone': '（文件已删除）',
	// 抽屉能显示的两种内容。它们不再是面板里的一对按钮：显示哪一份是一项跟着走遍所有面板
	// 的设置，选在工具栏的齿轮里（见 NavHistoryBrowser.openSettings），所以这两个词现在
	// 是齿轮菜单里的选项标签。各两个字，剩下的交给写在每个选项后面的那几个字。
	'navHistory.preview.name': '面板内容',
	'navHistory.preview.spot': '当时落点',
	'navHistory.preview.spot.desc': '（离开时看的那几行）',
	'navHistory.preview.note': '现在全文',
	'navHistory.preview.note.desc': '（笔记现在的样子）',
	// 记录的上下文块覆盖的行号范围：渲染出来的正文没有自己的行号栏来说这件事。「现在全文」
	// 下这句话不印——那几行是笔记现在的样子，说的不是记录。
	'navHistory.preview.recorded': '当时看到 · L{0}–L{1}',
	// 不是笔记的文件只有一种视图——它自己的源码——也没有可命名的记录范围。
	'navHistory.preview.source': '文件源码',
	// 完全没有文本的文件（PDF、图片）。打开它靠的就是点这一行，所以直接点名，
	// 不让读者自己去猜。
	'navHistory.preview.binary': '这类文件没有可预览的文本（PDF、图片等）：点这一行会打开它',
	// 点击链接进入时，链接所在的那篇笔记；以及「记录之后文件已被写过」的标记。
	'navHistory.preview.via': '来自「{0}」',
	'navHistory.preview.modified': '记录后已修改',
	// 右栏的空状态：历史里一行都没有时，说明这一栏是干什么的，而不是空着。
	'navHistory.preview.pick': '这一栏显示的是一行落点的详情：用行首的三角展开它',
};
