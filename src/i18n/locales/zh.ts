import type { En } from './en';

export const zh: En = {
	// ── 功能一 · 位置记录：记什么、怎么回来、记录存在哪 ────────────────
	'lastPosition.heading': '最后位置',
	// 整页在说什么，开头说一次（见 settings/page 的 intro 行）：记住的是什么、
	// 替谁记住。这两件事下面任何一行都说不了——没有一行是关于「记住光标」这件事
	// 本身的，也没有一行知道同一个文件能开在两个标签页里；说清楚了，下面那些行
	// 才能直接进入自己的答案。三组标题不在这里重复：它们自己就在下面。
	'lastPosition.intro':
		'为每篇笔记记住光标停在哪一行、滚到了哪里，重新打开直接落回那一处——不在文件顶部闪一下再跳过去。每个标签页各记各的：同一篇笔记开在两个标签页里，回来时各回各的位置。',

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

	// ── 共用 · 快捷键行要用的词，两个页面都用 ──────────────────────────
	// 快捷键行按它装的东西命名，而不是按它所在的页面：同一个词既是后退/前进页两个
	// 命令的标题，也是最近文件页那两个的标题（见 settings/page）——读者找的是键，不是页。
	'hotkeys.name': '快捷键',
	'hotkeys.unbound': '未绑定——点击右侧按钮设置',
	'hotkeys.open': '打开快捷键设置',

	// ── 功能二 · 前进与后退：导航栈 ────────────────────────────────────
	'navHistory.heading': '前进与后退',
	// 整页在说什么，开头说一次（见 settings/page 的 intro 行）：一步是什么、
	// 历史存在哪——下面任何一行都没法替自己说出这两件事，也正是下面那些行能
	// 写得短的原因：开关只需说自己那一种走法要不要记。“大小可在下方调整”不再
	// 重复：那个开关的名字已经在说它了。
	'navHistory.intro':
		'类似 VSCode 的“后退 / 前进”：一步可以是切换文件，也可以是文件内的跳转——链接、大纲、搜索结果、远距离的光标移动，下面两个开关决定哪些算数。同一标签页内的切换交给 Obsidian 自己的标签页历史，所以 PDF、Canvas 这类视图也走得回去。历史存在本机，重启后仍在。',
	// 走这条历史的两个命令（见 settings/page 的 hotkeys 行）。这里不重复上面那句：
	// 这一行按它装的东西命名，而「后退 / 前进」是什么，本页已经说过了。
	'navHistory.hotkeys.desc': '一个方向一个命令，走的正是上面那些步。默认都不绑快捷键——在命令面板里按名字运行即可。',
	'navHistory.stackCap.name': '前进/后退保留步数',
	'navHistory.stackCap.desc': '导航历史最多保留的条目数，超出后优先丢弃最旧的记录。',
	'navHistory.recordActivation.name': '记录标签页切换',
	'navHistory.recordActivation.desc': '点击其他标签页/面板会往「前进/后退」里推入一条。关闭后历史只记文件打开与文件内跳转——视图标签页（关系图谱、Thino 等）也不再成为历史里的一步。它只管「前进/后退」：最近文件列表照常记录这些视图。',
	'navHistory.recordTeleport.name': '记录大范围光标跳变',
	'navHistory.recordTeleport.desc': '光标一次性跨越多行的移动（远距离点击、跳转到行、vim 翻页跳转）会推入一条历史。若滚动或误点常污染历史，可关闭。',
	'navHistory.commands.navigateBack': '后退',
	'navHistory.commands.navigateForward': '前进',

	// ── 功能三 · 最近文件：地点列表，以及它的面板 ──────────────────────
	'recentFiles.name': '最近文件',

	// 整页在说什么，开头说一次（见 settings/page 的 intro 行）：一行代表什么，
	// 以及这份列表不是什么。后半句是值得写的那一半——读者是从「前进与后退」页
	// 过来的，两个存储答的是不同的问题，看起来却像同一份历史的两种看法。其余
	// 的都交给下面各行自己说。
	'recentFiles.intro':
		'一份去处的清单：最近打开过的笔记，以及你在它们内部跳转过的标题与块——还有主区域里没有文件的视图（关系图谱、Thino 这类），它们也各占一行。点一行就回到那一处。它不是「前进与后退」页那份历史：那里存的是怎么走到这里，这里存的是去过哪些地方，两者各记各的。清单存在本机，重启后仍在。',

	// 最近文件列表自己的文件夹规则（见 PluginSettings.navRecentExcludeFolders）：
	// 哪些访问值得列出。它是独立的一份，与位置记录的文件夹规则无关——但两者不在
	// 同一页上，所以这一行只说自己做什么，不去解释读者此刻没看着的那条规则。
	'recentFiles.folders.name': '不收录的文件夹',
	'recentFiles.folders.desc': '这些文件夹里的文件不会进入最近文件列表。',
	'recentFiles.folders.list.empty': '所有文件夹都会收录。',
	'recentFiles.folders.add': '添加文件夹',
	'recentFiles.cap.name': '保留地点数',
	'recentFiles.cap.desc': '最近文件列表最多保留多少个地点。调小会立刻丢掉最旧的那些。',
	// 一个文件在列表里打印几个落点。两档按「列表会变成什么样」写，因为这才是选择本身：
	// 默认跟着读者自己的走法——读历史基本是按文件走的，最后那一个才是「返回」会回到的地方，
	// 而它已经由笔记那一行代表（点一下看它、箭头跳过去），所以行下不再需要任何子级。
	'recentFiles.landings.name': '列表里的落点',
	'recentFiles.landings.desc': '每篇笔记只占一行（代表你最后离开的那一处），还是每个落点各占一行。',
	'recentFiles.landings.options.last': '每篇一行',
	'recentFiles.landings.options.all': '全部落点',
	// 一行的路径打印多少、打印在名字哪一侧（见 PathDisplayMode）。两个「总是」档写的是
	// 「放不下时谁下移」，因为那才是读者真正在权衡的东西——flex 行在行尾换行，所以排在后面
	// 的那一半才会落到第二行。默认档「仅在重名时」说得最少：目录是消歧用的，有要消歧的才打印。
	'recentFiles.pathDisplay.name': '列表里的路径',
	'recentFiles.pathDisplay.desc': '一行是否打印笔记所在的文件夹——只在两行重名时打印，还是每行都打印——以及打印在名字的哪一侧。',
	'recentFiles.pathDisplay.options.smart': '仅在重名时显示',
	'recentFiles.pathDisplay.options.before': '总是显示，路径在前',
	'recentFiles.pathDisplay.options.after': '总是显示，路径在后',
	// 每行是否显示「距上次打开过了多久」。这个时间是地点自己的 t（见 places.ts）——读者
	// 上一次到那里的时间，不是文件的修改时间；后者是另一回事，而它恰好是读者看到文件行
	// 上印着时间时的第一反应。确切时刻挂在这个标签自己的 tooltip 上。
	'recentFiles.rowTime.name': '每行的时间',
	'recentFiles.rowTime.desc': '在每行上打印「距上次到访过了多久」。',
	'recentFiles.age.now': '刚刚',
	'recentFiles.age.m': '分钟',
	'recentFiles.age.h': '小时',
	'recentFiles.age.d': '天',
	'recentFiles.age.w': '周',
	'recentFiles.age.mo': '个月',
	'recentFiles.age.y': '年',
	// 行的右键菜单（见 RecentFilesBrowser.contextRow）。菜单本身是 app 的；唯一加进去的那一项
	// 是 app 不可能知道的——这里的行代表的是一个「去处」而不只是一个文件：jump 行承诺的是那个
	// 落点，所以「在新标签页打开」必须也是打开到那里。因此是两个答案而不是一个：文件，与文件里
	// 的这一处，是两个不同的承诺。
	// 文件「另外几个名字」的引导词，挂在行自己的 tooltip 上（见 RecentFilesReads.aliasesFor）。
	// 它们可被搜索、不占任何格子，所以悬停是读者唯一能看到它们的地方；冒号写进值里，因为
	// 用不用冒号是各语言自己的事。
	'recentFiles.aka': '别名：',
	'recentFiles.menu.openInNewTab': '在新标签页打开',
	'recentFiles.menu.openHereInNewTab': '在此处打开新标签页',
	// 行自己的移除控件，也就是行上的那个 ×（见 RecentFilesBrowser.onForget）。它不再挂在行的
	// 右键菜单上：那个菜单是 app 的，而只有文件才有这样一份菜单——无路径的视图行（图谱、Thino
	// 的备忘列表）没有文件可以让它去讲，于是同一个动作只对有文件的行成立，这正是读者会碰上的
	// 那一种不一致。用「移除」而不是「删除」：走掉的只是这条记录，文件本身和位置数据库里的落点
	// 都不动，下次再进这个文件它就回来了。
	'recentFiles.forget': '从最近文件移除',
	// 用「浏览」而不是「打开」：被打开的是那份列表，而「打开最近文件」读起来像打开
	// 读者上次所在的那个文件。这也是命令 id 里的那个动词（见 main.ts），并且是两条
	// 命令在命令面板里一眼能分开的地方——另一条是「打开」，那里被打开的确实是面板。
	'recentFiles.commands.open': '浏览最近文件',
	// 同一个浏览器的常驻形态：侧栏面板而非弹窗（见 view.ts）。命名强调「放在哪儿」
	// 而不是「做什么」，因为这正是两者的区别——面板被放下后就留在那里。
	'recentFiles.commands.openSidebar': '在侧边栏打开最近文件',
	// 上面两个命令，作为绑定它们的那一行设置（见 settings/page）。它们的键放在最近文件
	// 页，而不是和后退/前进的键并排：两页回答的是不同的问题，想找「打开列表」那个键的
	// 读者不该先知道它藏在一个讲「走位」的标题底下。
	'recentFiles.hotkeys.desc':
		'进入列表的两种方式：一次性的弹窗，或常驻侧边栏的面板。两者默认都不绑快捷键——在命令面板里按名字打开即可。',

	// 一个没有自己名字的视图步骤回退成什么（见 browser/model.ts 的 viewName）：关系图谱，列表一直这么叫它。
	// 其它类型的视图很少走到这里（视图会在记录时带上自己的名字），真没名字就直接印 viewType。
	'recentFiles.graphView': '关系图谱',
	// 视图行上那个标记的字面回退（见 list.ts 的 fileRow）：报了图标的视图印它自己的图标，没报图标的印这两个字。
	'recentFiles.viewBadge': '视图',
	'recentFiles.searchPlaceholder': '按笔记名或文本过滤…',
	// 过滤框末尾那个 ×（见 RecentFilesBrowser.toolbar）：app 自己的手势，按「清掉什么」命名。
	// 它同时是按钮的无障碍名字和它的 tooltip，所以写的是动作而不是那个符号。
	'recentFiles.clearFilter': '清空筛选',
	'recentFiles.noMatch': '没有匹配的历史。',
	// 以前这里还有「文件筛选」：一个「只看本笔记」开关加上一个选择器 chip（点开是历史
	// 里出现过的所有笔记）。两个控件都是搜索框已经能回答的问题——笔记名本身就是它匹配
	// 的文本——却各自占着工具栏的一格和一份状态，所以一起去掉了（见 modal.ts）。
	'recentFiles.empty': '暂无可跳转的位置。',
};
