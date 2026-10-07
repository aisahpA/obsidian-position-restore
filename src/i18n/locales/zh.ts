import type { En } from './en';

export const zh: En = {
	// ═══ 位置记录 ═══ 记什么、怎么回来、记录存在哪
	'lastPosition.heading': '最后位置',
	// 整页在说什么，开头说一次（settings/page 的 intro 行）：记住的是什么、
	// 记录存在哪。下面任何一行都说不了这两件事。「每个标签页各记各的」刻意
	// 不在这里说：那是本机 localStorage 的覆盖层，放在「记在库里的 JSON 文件里」
	// 旁边，读者会以为它也能跟着换设备。
	'lastPosition.intro':
		'每篇笔记都记得光标停在哪一行、滚到了哪里，再次打开直接落回那一处——不会先在文件顶部闪一下再跳过去。位置记在库里的一个 JSON 文件里，默认放在插件目录内——Obsidian Sync 不会从那里带走它；想让位置跟着你换设备，到下面「数据存储」把路径改到仓库内即可。',

	'openAndRestore.heading': '打开与恢复',

	'openAndRestore.linkOpenPosition.name': '双链打开位置',
	'openAndRestore.linkOpenPosition.desc':
		'点击普通双链（不带 # 标题或 ^ 块目标）时，是始终从文件开头打开，还是使用已保存的位置。',
	'openAndRestore.linkOpenPosition.options.start': '文件开头',
	'openAndRestore.linkOpenPosition.options.restore': '已保存的位置',

	'openAndRestore.restoreBreadcrumb.name': '打开笔记时提示所在小节',
	'openAndRestore.restoreBreadcrumb.desc':
		'恢复位置后，如果这一屏里看不到任何小节标题，就在笔记中间短暂显示你所在的小节路径。标题已经在屏幕上时不显示（一眼就能看出落在哪一节）；整篇只有一个标题时也不显示；笔记的一级标题多半就是文章标题，不会重复显示。',
	'openAndRestore.flashLandingLine.name': '标出落点那一行',
	'openAndRestore.flashLandingLine.desc':
		'打开笔记回到上次的位置时，以及点大纲、点搜索结果里的小节、用前进/后退落到某一行之后，短暂标出到达的那一行；阅读视图里标出的是落点所在的那一小节。光标不在屏幕上时自然标不出来。',

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
		'按 frontmatter 排除一整类笔记：命中列表里任一条目的文件，不记录它的位置。',
	'recordingRules.frontmatterExclude.formName': '只写属性名（如 `status`）：文件只要带这个属性就不记录，不论值是多少。',
	'recordingRules.frontmatterExclude.formValue': '写成 `属性: 值`（如 `status: archived`）：只有值相等才不记录。yes/no/on/off 按布尔比较；数组里任一元素相等即算命中。',
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
		'也可以绕过这个页面，让某一篇自己决定：在它的 frontmatter 里写 `{0}: false`，这篇永不记录；写 `{0}: true`，则连排除的文件夹、最短行数和上面的属性规则一起压过去，照记不误。只认 true / false，写别的值等于没写。',

	'recordingRules.recordBaseScroll.name': '记录 Base 文件的滚动位置',
	'recordingRules.recordBaseScroll.desc':
		'Base 文件不像 Markdown 那样有行号可供锚定，能存的只有滚过的像素数：屏幕尺寸一变就对不上，数据文件跨设备同步时还会被另一台设备的记录覆盖，所以默认关着。这个开关只管 Base——PDF 的阅读位置 Obsidian 原生已在每台设备上记住；图片等其他非 Markdown 文件，也没有值得记录的滚动状态。',

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
		'Position Restore：数据文件无法解析（可能正被同步工具改写），已保留一份副本：{0}。本次从空数据继续，重新打开笔记会重新记录位置。',
	'dataStorage.corruptDb.noticeNoCopy':
		'Position Restore：数据文件无法解析（可能正被同步工具改写），且未能写出副本，其中的位置记录无法找回。本次从空数据继续，重新打开笔记会重新记录位置（详情见控制台）。',
	// 常驻提示（要点一下才消失）：通知区里看不到来源，所以行首要自报插件名。
	// 两条的时刻不同：`notice` 是启动时读到旧版文件（整份已读出）；
	// `noticeOverwritten` 是本会话已写过新版之后，文件又变回旧版 —— 别处刚覆盖过它。
	'dataStorage.legacyDb.notice':
		'Position Restore：数据文件是旧版插件写入的格式，位置记录已全部读出，下次保存时会以新版格式整份写回。若其他设备上的本插件仍是旧版，请一并更新：旧版读不懂新版文件，会把它当成空文件整份重写，只剩那台设备自己打开过的笔记——两端版本不一致时，每同步一次就可能丢一批位置。',
	'dataStorage.legacyDb.noticeOverwritten':
		'Position Restore：数据文件刚被另一台尚未更新的设备重写成旧版格式。旧版读不懂新版文件，只写回它自己那一份，于是文件中由新版记录的位置已经不在了。本机记录的位置不受影响，下次保存会一并写回。请更新其他设备上的本插件，否则每次同步都会重演一次。',

	'dataStorage.entries.name': '记录数',
	// 「默认位置」＝打开笔记时 Obsidian 自己放光标的那一行：有 frontmatter 就是它下面第一行，
	// 没有就是第一行。停在那里的记录存进文件是个空记录（墓碑），它不占位置信息，但也不是
	// 没用——它记着「来过、停在顶部」，并且优先让位给容量上限（见 database.ts 的 trimToLimit）。
	'dataStorage.entries.desc':
		'当前记录了 {0} 个文件的位置，最多支持 750 条记录。超出上限时，先移除较久未访问、且停在默认位置的记录，其余再按最久未访问移除。',
	'dataStorage.entries.atDefault':
		'其中 {0} 个停在默认位置（frontmatter 下面第一行），没有记下实际位置。',

	// ═══ 快捷键 ═══ 两个页面都要用的一行
	// 按它装的东西命名，而不是按它所在的页面——读者找的是键，不是页。
	// 引导句只指认按钮的样子（键盘图标），绝不说它在哪一侧：那是 addExtraButton，
	// 手机窄屏会换行到这一行的下方；并且整行只说一次，两条命令各印一遍是重复。
	'hotkeys.name': '快捷键',
	'hotkeys.unbound': '未绑定',
	// 「物理键盘」而不是「外接键盘」：两端都成立——手机软键盘按不出组合键。
	'hotkeys.hint': '想绑到某个键：用本行的键盘按钮打开「设置 → 快捷键」。绑好之后要靠物理键盘才按得出来。',
	'hotkeys.open': '打开快捷键设置',
	'hotkeys.openFailed': '没能打开快捷键设置，请到「设置 → 快捷键」里找到本插件的命令。',

	// ═══ 前进与后退 ═══ 导航栈
	'navHistory.heading': '前进与后退',
	// 后两个旋钮的组标题：它们问的是同一件事 —— 什么动作会被记成一步 —— 只是一个开关
	// 打开它、一个数字给它一个距离。「保留多少步」不在这里：它是量，留在页级那个无标题
	// 的分组里。
	'navHistory.steps.heading': '记录哪些步',
	// 整页在说什么，开头说一次：一步是什么、历史存在哪——下面任何一行都没法替自己
	// 说出这两件事，也正是下面那些行能写得短的原因：开关只需说自己那种走法记不记。
	'navHistory.intro':
		'类似 VSCode 的“后退 / 前进”。下面这些动作会各占一步：打开另一篇笔记；点链接、大纲或搜索结果跳到笔记里的某一处；切换标签页；打开图谱这类没有文件的视图；光标一次性跨过很多行的移动（仅电脑端）。同一标签页内的切换借 Obsidian 自己的标签页历史走回去，所以 PDF、Canvas 这类本插件无法定位的视图也回得去。这份历史只存在本机，不随仓库同步；重启后仍在。',
	'navHistory.hotkeys.desc': '一个方向一个命令，走的正是上面那些步。默认都不绑快捷键——在命令面板里按名字运行即可。',
	'navHistory.stackCap.name': '前进/后退保留步数',
	'navHistory.stackCap.desc': '导航历史最多保留的条目数，超出后优先丢弃最旧的记录。',
	'navHistory.recordActivation.name': '记录标签页切换',
	'navHistory.recordActivation.desc': '点击其他标签页会往「前进/后退」里推入一条。关闭后，切标签页不再留下步骤，历史只记文件打开与文件内跳转；关系图谱这类没有文件的视图是例外，仍各占一步——否则在图谱里按后退会退过头，落到更早的那一篇。它只管「前进/后退」：最近文件列表照常记录这些视图。',
	// 名字里说清三件事：看的是光标（不是滚动）、一次移动的跨度（不是累计）、
	// 结果是「一步」（本页用的词）。「跳变」是内部叫法，读者不知道它指什么。
	'navHistory.teleportMinLines.name': '光标一次跨越多少行才算一步',
	'navHistory.teleportMinLines.desc': '光标一次性跨过这么多行以上，就当作一次文件内跳转、往「前进/后退」里推入一条：在笔记里点一个很远的位置、用命令跳到某一行、或一次跨过很多行的键盘移动。设 0 表示完全不记录这类移动 —— 默认就是 0：这类步是推断出来的，想要的人自己定距离。仅在电脑端生效：手机和平板不做这项检测。',
	// 四个箭头没有开关——上面两步加上笔记的两端，作为按钮画在最近文件列表的底部：它们
	// 不占那份列表任何东西（它们不是列表的行），而没有键盘的读者除此之外没有别的办法
	// 提出这四个请求，所以开关只会把按钮从真正需要它的人手里拿走。它们作用的是「你打开
	// 的那篇笔记」而不是那份列表，这一点由每个按钮自己的名字说出口。
	'navHistory.commands.navigateBack': '后退',
	'navHistory.commands.navigateForward': '前进',

	// ═══ 笔记的两端 ═══ 跳过去，不是移动过去
	// 按「目的地」命名，不按「移动」命名：读者是在挑笔记里的一个地方。和别处一样，
	// 两个默认都不绑。
	'noteEdge.commands.top': '跳到笔记开头',
	'noteEdge.commands.bottom': '跳到笔记末尾',

	// ═══ 最近文件 ═══ 地点列表，以及它的面板
	// 这个 key 有两个用处：模态框的标题，也是常驻侧栏面板的名字——同一份列表的两种形态。
	'recentFiles.name': '最近文件',

	// 两个分组标题。它们写的是这一页回答的两问本身 —— 收谁、以及进来之后一行长什么样
	// —— 而不是把页名再写一遍；导言与快捷键因此留在它们之上那个无标题的分组里。
	'recentFiles.rules.heading': '收录规则',
	'recentFiles.display.heading': '显示',

	// 整页在说什么，开头说一次：一行代表什么，以及这份列表不是什么。后半句是
	// 值得写的那一半——读者是从「前进与后退」页过来的，两个存储答的是不同的问题。
	// ⚠️ 但它只说「不记你在这篇笔记的哪一处」，别写成「不记位置」：点一行打开一篇笔记，
	// 落点由位置记录给（见 stack.ts 的 openFilePlain），写反了读者一试就发现对不上。
	// （落点规则本身不写进这句：读者不懂「落点」这个词，实测太长没人看——别再补回去。）
	'recentFiles.intro':
		'一份去处的清单：最近打开过的笔记，主区域里没有文件的视图（关系图谱这类）也各占一行；点一行就回到那一处。搜索框还能按笔记里的小节标题来找——命中哪几节就把它们各画一行，点一行跳到那一节（见下面「搜索小节标题」）。这份列表不记「你在这篇笔记里的哪一处」——上次去过的某一节，是「前进与后退」页那份历史的事。清单只存在本机，不随仓库同步；重启后仍在。',

	// 列表自己的文件夹规则，与位置记录的那条无关——两者不在同一页上，所以这一行
	// 只说自己做什么。
	'recentFiles.folders.name': '不收录的文件夹',
	'recentFiles.folders.desc': '这些文件夹里的文件不会进入最近文件列表。',
	'recentFiles.folders.list.empty': '所有文件夹都会收录。',
	'recentFiles.folders.add': '添加文件夹',
	// 和上面的文件夹规则问的是同一件事，只是改由笔记自己回答，而不是看它放在哪。
	// 两种写法各占一行：几乎所有读者都是来核对该写哪一种。
	'recentFiles.frontmatterExclude.name': '不收录的属性',
	'recentFiles.frontmatterExclude.desc':
		'按 frontmatter 排除一整类笔记：命中列表里任一条目的文件，不会进入最近文件列表。',
	'recentFiles.frontmatterExclude.formName': '只写属性名（如 `status`）：文件只要带这个属性就不收录，不论值是多少。',
	'recentFiles.frontmatterExclude.formValue': '写成 `属性: 值`（如 `status: archived`）：只有值相等才不收录。yes/no/on/off 按布尔比较；数组里任一元素相等即算命中。',
	'recentFiles.frontmatterExclude.list.empty': '所有文件都会收录。',
	'recentFiles.frontmatterExclude.add': '添加属性',
	// 只数行，而一行就是一篇笔记（或一个视图）——没有第二个名额池，所以这个数只有
	// 一个意思。
	'recentFiles.cap.name': '记住多少篇笔记',
	'recentFiles.cap.desc':
		'最近文件列表最多记住多少篇笔记（主区域里没有文件的视图也各算一个）。超了就丢掉最久没打开过的那些；调小会立刻生效，丢掉的找不回来。置顶的行不占这里的数。',
	// 搜索面里唯一可开关的一半。另一半没有开关：这份列表只记笔记，所以「记不记标题」
	// 不是一个选项 —— 标题只在**被搜到**时出现，而它们出现时是自己的行。
	'recentFiles.outlineSearch.name': '搜索小节标题',
	'recentFiles.outlineSearch.desc':
		'搜索框除了笔记名（以及它的别名、路径）之外，是否也匹配各篇笔记里的小节标题。开着时，命中哪几个小节就把它们各画一行在那篇笔记下面，点一行就跳到那一节。关掉时搜索只认笔记自己。',
	// 两个「总是」档写的是「放不下时谁下移」，因为那才是读者真正在权衡的东西——
	// flex 行在行尾换行，排在后面的那一半才会落到第二行。默认档说得最少：目录是消歧用的。
	'recentFiles.pathDisplay.name': '列表里的路径',
	'recentFiles.pathDisplay.desc': '一行是否显示笔记所在的文件夹——每行都显示，还是只在名字与屏幕上别的行撞车时才显示；而显示在名字的哪一侧，也就定下了行挤不下时谁让位：排在后面的那一半会落到第二行。',
	'recentFiles.pathDisplay.options.smart': '仅在重名时显示',
	'recentFiles.pathDisplay.options.before': '总是显示，路径在前',
	'recentFiles.pathDisplay.options.after': '总是显示，路径在后',
	// 这个时间是地点自己的 t——上一次到那里的时间，不是文件的修改时间；后者恰好是
	// 读者看到文件行上印着时间时的第一反应。确切时刻挂在这个标签的 tooltip 上。
	'recentFiles.rowTime.name': '每行的时间',
	'recentFiles.rowTime.desc': '在每行上显示「距上次到访过了多久」——那是你上一次在那里的时间，不是文件的修改时间；确切时刻悬停在这行的时间上可以看到。',
	// 只有一个属性名，不再配第二个「优先用哪个」的设置：有这个属性的笔记就用它，
	// 没有的回落文件名——这就是优先级本身。留空＝关闭，且默认关闭：文件名才是
	// app 里其它各处列表的印法。
	'recentFiles.titleProperty.name': '行名取自属性',
	'recentFiles.titleProperty.desc': '填一个 frontmatter 属性名：有这个属性的笔记，列表里用它当名字；没有，或它的值不是一段文字的，仍显示文件名。留空则不使用。',
	// 这是例子，不是关于规则的提示：读者来这里就是要打 `title`。
	'recentFiles.titleProperty.placeholder': '例如 title',
	'recentFiles.age.now': '刚刚',
	'recentFiles.age.m': '分钟',
	'recentFiles.age.h': '小时',
	'recentFiles.age.d': '天',
	'recentFiles.age.w': '周',
	'recentFiles.age.mo': '个月',
	'recentFiles.age.y': '年',
	// 引导词＝属性名本身，中英文一致：属性名是读者笔记里的 key，app 的属性面板也
	// 不翻译它。小写，因为 YAML 里就是这么写的，我们读的也是 `fm?.aliases`。
	'recentFiles.title': 'title:',
	// 分两行是因为 `title` 不是别名：它是笔记自称，而「别名」是 app 的说法，只指
	// `aliases`。这一行可被搜索、不占格子，悬停是读者唯一能看到它的地方。
	'recentFiles.aliases': 'aliases:',
	// 两个说法而不是一个：一个大纲行代表一个「去处」而不只是一个文件，它承诺的是那一节，
	// 所以「在新标签页打开」也必须打开到那里。菜单是 app 的，这是唯一加进去的一项。
	'recentFiles.openInNewTab': '在新标签页打开',
	'recentFiles.openHereInNewTab': '在此处打开新标签页',
	// 行自己的移除控件，也就是行上的那个 ×。用「移除」而不是「删除」：走掉的只是这条
	// 记录，文件本身和位置数据库里的其它记录都不动，下次再进这个文件它就回来了。
	'recentFiles.forget': '从最近文件移除',
	// 标签页右键菜单上那一项：走掉的是整个列表，留下的是置顶的那几行——置顶是读者
	// 自己钉的，不是列表自己记的；被清掉的笔记再打开一次就会回来（位置也还在）。
	'recentFiles.clearList': '清空整个列表',
	// 行上第二个控件：它升起的是 app 对这份文件自己的那张菜单。说「更多操作」而不说
	// 「菜单」——那张菜单是 app 的；也有别于「在新标签页打开」，那只是菜单里的一项。
	'recentFiles.rowMenu': '更多操作',
	// 笔记自己那一行让 app 填的那张菜单上的四句话：置顶是对「一行」的书签，所以只在
	// 笔记行上、不在大纲行上（那一节不是一条记录）；「上移/下移」说的是置顶区内部的
	// 顺序，只对已经钉住的行出现。
	'recentFiles.pin': '置顶',
	'recentFiles.unpin': '取消置顶',
	'recentFiles.pinUp': '上移',
	'recentFiles.pinDown': '下移',
	// …以及一步到头：置顶区长了以后，一次挪一步要来回开这张菜单。
	'recentFiles.pinFirst': '移到最前',
	'recentFiles.pinLast': '移到最后',
	// 用「浏览」而不是「打开」：被打开的是那份列表，而「打开最近文件」读起来像打开
	// 读者上次所在的那个文件。这也是两条命令在命令面板里一眼能分开的地方。
	'recentFiles.commands.open': '浏览最近文件',
	// 命名强调「放在哪儿」而不是「做什么」。
	'recentFiles.commands.openSidebar': '在侧边栏打开最近文件',
	// 它们的键放在最近文件页，而不是和后退/前进的键并排：两页回答的是不同的问题。
	'recentFiles.hotkeys.desc':
		'进入列表的两种方式：一次性的弹窗，或常驻侧边栏的面板。两者默认都不绑快捷键——在命令面板里按名字打开即可。',

	// 没有自己名字的视图步骤回退到这一行；再没有就直印 viewType。
	'recentFiles.graphView': '关系图谱',
	'recentFiles.viewBadge': '视图',
	'recentFiles.searchPlaceholder': '按笔记名或文本过滤…',
	// 过滤框末尾那个 ×：app 自己的手势，按「清掉什么」命名；它同时是按钮的无障碍名字。
	// 两个名字，对应同一个符号的两件事：有输入时清空，没输入时关闭对话框。
	'recentFiles.clearFilter': '清空筛选',
	'recentFiles.close': '关闭',
	'recentFiles.noMatch': '没有匹配的历史。',
	'recentFiles.empty': '暂无可跳转的位置。',

	// ═══ 悬停预览 ═══ 把笔记打开在哪里
	// 会向 app 要预览的两处列表共用这一个分组，各有自己的四个键而不是共用一条
	// 文案：今天写的字一样，但两项落在不同的设置页，迟早要各说各的。两处默认都
	// 是篇首：指到那一行的话，app 先把整篇画出来再挪过去，等于让卡片先空着一
	// 下——而同一行的点击本来就把人送到那里。
	'previewFocus.recentFiles.name': '预览打开在哪里',
	'previewFocus.recentFiles.desc':
		'悬停一行时，预览打开在笔记的哪个位置：篇首（app 自己的各处列表都是这样），还是你上次在那篇里读到的那一行。选「那一行」要多等一下——笔记要先整篇画出来、然后才挪过去，长笔记上会先看到一张空卡片，然后才翻到那一行。标题行不受这一项影响：它本来就打开在那个标题上。',
	'previewFocus.recentFiles.options.head': '篇首',
	'previewFocus.recentFiles.options.line': '上次读到的那一行',
	'previewFocus.fileExplorer.name': '文件列表的预览打开在哪里',
	'previewFocus.fileExplorer.desc':
		'app 自己的文件列表悬停出预览时，笔记打开在哪个位置：篇首（app 原本就是这样要的），还是这个插件为那篇笔记记录的最后一行。指到那一行要付的是同样的等待——笔记先整篇画出来、然后才挪过去；而它打开的是这里最后记录的那一行，笔记在别的设备上被改过之后，可能已不在你离开的地方。',
	'previewFocus.fileExplorer.options.head': '篇首',
	'previewFocus.fileExplorer.options.line': '上次读到的那一行',
};
