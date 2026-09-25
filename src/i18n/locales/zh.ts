import type { En } from './en';

export const zh: En = {
	// ── 功能一 · 位置记录：记什么、怎么回来、记录存在哪 ────────────────
	'lastPosition.heading': '最后位置',
	// 整页在说什么，开头说一次（settings/page 的 intro 行）：记住的是什么、
	// 记录存在哪。下面任何一行都说不了这两件事。「每个标签页各记各的」刻意
	// 不在这里说：那是本机 localStorage 的覆盖层，放在「记在库里的 JSON 文件里」
	// 旁边，读者会以为它也能跟着换设备。
	'lastPosition.intro':
		'每篇笔记都记得光标停在哪一行、滚到了哪里，再次打开直接落回那一处——不会先在文件顶部闪一下再跳过去。位置记在库里的一个 JSON 文件里，默认放在插件目录内——Obsidian Sync 不会从那里带走它；想让位置跟着你换设备，到下面「数据存储」把路径改到仓库内即可。',

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
		'数据文件无法解析（可能正被同步工具改写），已保留一份副本：{0}。本次从空数据继续，重新打开笔记会重新记录位置。',
	'dataStorage.corruptDb.noticeNoCopy':
		'数据文件无法解析（可能正被同步工具改写），且未能写出副本，其中的位置记录无法找回。本次从空数据继续，重新打开笔记会重新记录位置（详情见控制台）。',

	'dataStorage.entries.name': '记录数',
	'dataStorage.entries.desc':
		'当前记录了 {0} 个文件的位置，最多支持 750 条记录。超出上限时，将优先移除最久未访问的文件的位置记录。',

	// ── 共用 · 快捷键行要用的词，两个页面都用 ──────────────────────────
	// 按它装的东西命名，而不是按它所在的页面——读者找的是键，不是页。
	// 引导句只指认按钮的样子（键盘图标），绝不说它在哪一侧：那是 addExtraButton，
	// 手机窄屏会换行到这一行的下方；并且整行只说一次，两条命令各印一遍是重复。
	'hotkeys.name': '快捷键',
	'hotkeys.unbound': '未绑定',
	// 「物理键盘」而不是「外接键盘」：两端都成立——手机软键盘按不出组合键。
	'hotkeys.hint': '想绑到某个键：用本行的键盘按钮打开「设置 → 快捷键」。绑好之后要靠物理键盘才按得出来。',
	'hotkeys.open': '打开快捷键设置',
	// 按钮点了没落到那个 tab 时的兜底。
	'hotkeys.openFailed': '没能打开快捷键设置，请到「设置 → 快捷键」里找到本插件的命令。',

	// ── 功能二 · 前进与后退：导航栈 ────────────────────────────────────
	'navHistory.heading': '前进与后退',
	// 整页在说什么，开头说一次：一步是什么、历史存在哪——下面任何一行都没法替自己
	// 说出这两件事，也正是下面那些行能写得短的原因：开关只需说自己那种走法记不记。
	'navHistory.intro':
		'类似 VSCode 的“后退 / 前进”。下面这些动作会各占一步：打开另一篇笔记；点链接、大纲或搜索结果跳到笔记里的某一处；切换标签页；打开图谱这类没有文件的视图；光标一次性跨过很多行的移动（仅电脑端）。同一标签页内的切换借 Obsidian 自己的标签页历史走回去，所以 PDF、Canvas 这类本插件无法定位的视图也回得去。这份历史只存在本机，不随仓库同步；重启后仍在。',
	// 这里不重复上面那句：「后退 / 前进」是什么，本页已经说过了。
	'navHistory.hotkeys.desc': '一个方向一个命令，走的正是上面那些步。默认都不绑快捷键——在命令面板里按名字运行即可。',
	'navHistory.stackCap.name': '前进/后退保留步数',
	'navHistory.stackCap.desc': '导航历史最多保留的条目数，超出后优先丢弃最旧的记录。',
	'navHistory.recordActivation.name': '记录标签页切换',
	'navHistory.recordActivation.desc': '点击其他标签页会往「前进/后退」里推入一条。关闭后，切标签页不再留下步骤，历史只记文件打开与文件内跳转；关系图谱这类没有文件的视图是例外，仍各占一步——否则在图谱里按后退会退过头，落到更早的那一篇。它只管「前进/后退」：最近文件列表照常记录这些视图。',
	'navHistory.teleportMinLines.name': '多少行算一次跳变',
	'navHistory.teleportMinLines.desc': '光标一次性跨过这么多行以上，就当作一次文件内跳转、往「前进/后退」里推入一条：在笔记里点一个很远的位置、用命令跳到某一行、或一次跨过很多行的键盘移动。设 0 表示完全不记录这类移动。仅在电脑端生效：手机和平板不做这项检测。',
	'navHistory.commands.navigateBack': '后退',
	'navHistory.commands.navigateForward': '前进',

	// ── 功能三 · 最近文件：地点列表，以及它的面板 ──────────────────────
	'recentFiles.name': '最近文件',

	// 整页在说什么，开头说一次：一行代表什么，以及这份列表不是什么。后半句是
	// 值得写的那一半——读者是从「前进与后退」页过来的，两个存储答的是不同的问题。
	// 唯一从下面某行借来的一件事是那行的默认值，所以它会跟着 LandingsMode 的
	// 默认值走（'all'：每个落点各占一行），并且点名借的是哪一行。
	'recentFiles.intro':
		'一份去处的清单：最近打开过的笔记，主区域里没有文件的视图（关系图谱这类）也各占一行；点一行就回到那一处。你在笔记里跳转过的标题与块同样各占一行——记多少由下面「列表记到多细」那一行决定，默认全部记下。它不是「前进与后退」页那份历史——那里记的是怎么走到这里，这里记的是去过哪些地方，两者各记各的。清单只存在本机，不随仓库同步；重启后仍在。',

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
	// 只数笔记与视图，不数笔记里的落点，所以换档不会让这个数变成另一个意思。
	// 两版文案只差一句：最上面那档落点也画成行，列表会比这个数长。
	'recentFiles.cap.name': '记住多少篇笔记',
	'recentFiles.cap.desc.plain':
		'最近文件列表最多记住多少篇笔记（主区域里没有文件的视图也各算一个）。超了就丢掉最久没打开过的那些；调小会立刻生效，丢掉的找不回来。',
	'recentFiles.cap.desc.all':
		'最近文件列表最多记住多少篇笔记（视图也各算一个）——笔记里的落点不占这里的数，但每个落点也各占一行，所以列表会比这个数长。超了就丢掉最久没打开过的那些；调小会立刻生效，丢掉的找不回来。',
	// 记多少 + 画多少，一条轴上的三档：画多少取决于记多少，所以这是一个问题而不是两个；
	// 三档单调，也就不会多出「不记却要全部画出来」这种废组合。三档都可逆，所以文案里
	// 没有「代价」那一半：退回最上面那档只是不再记新的，已记下的留着。
	'recentFiles.landings.name': '列表记到多细',
	'recentFiles.landings.desc':
		'列表把你的行踪记到多细：只记你打开过哪些笔记，还是连你在笔记里跳转到的标题与块一起记；记了之后还要不要画出来——每篇仍占一行、落点只用来搜索，还是每个落点各占一行。往细里调、往回收都不损失东西：退回「只记笔记」只是不再记新的，已经记下的会留着，切回来还在，直到那篇笔记被挤出列表。',
	'recentFiles.landings.options.none': '只记笔记',
	'recentFiles.landings.options.last': '记落点 · 每篇仍是一行',
	'recentFiles.landings.options.all': '记落点 · 每个落点一行',
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
	'recentFiles.age.now': '刚刚',
	'recentFiles.age.m': '分钟',
	'recentFiles.age.h': '小时',
	'recentFiles.age.d': '天',
	'recentFiles.age.w': '周',
	'recentFiles.age.mo': '个月',
	'recentFiles.age.y': '年',
	// 两个说法而不是一个：这里的行代表的是一个「去处」而不只是一个文件，jump 行
	// 承诺的是那个落点，所以「在新标签页打开」必须也是打开到那里。菜单本身是 app 的，
	// 这是唯一加进去的一项。
	// 文件「另外几个名字」的引导词，挂在行自己的 tooltip 上：可被搜索、不占格子，
	// 悬停是读者唯一能看到它们的地方；冒号写进值里，因为用不用冒号是各语言自己的事。
	'recentFiles.aka': '别名：',
	// 落点行 tooltip 上那两行「引文」的引导词：都是笔记自己的文字——记下时抓的、
	// 屏幕上哪里都不印的。重点在「记下时」：笔记后来可能改过，这是当时那句话。
	'recentFiles.matchedLine': '搜到的一行：',
	'recentFiles.landingLine': '记下时那一行：',
	'recentFiles.editedSince': '记下之后这篇改过',
	'recentFiles.openInNewTab': '在新标签页打开',
	'recentFiles.openHereInNewTab': '在此处打开新标签页',
	// 行自己的移除控件，也就是行上的那个 ×。用「移除」而不是「删除」：走掉的只是这条
	// 记录，文件本身和位置数据库里的落点都不动，下次再进这个文件它就回来了。
	'recentFiles.forget': '从最近文件移除',
	// 落点行上同一个 × 的说法：这里走掉的是一个位置，不是整篇笔记。用「位置」而不是
	// 「行」：读者看到的是那一行与它所在的那一节，落点挪过之后它还是同一个位置。
	'recentFiles.forgetLanding': '移除这个位置',
	// 行上第二个控件：它升起的是 app 对这份文件自己的那张菜单。说「更多操作」而不说
	// 「菜单」——那张菜单是 app 的；也有别于「在新标签页打开」，那只是菜单里的一项。
	'recentFiles.rowMenu': '更多操作',
	// 笔记自己那一行让 app 填的那张菜单上的四句话：置顶是对「一篇笔记」的书签，所以
	// 只在笔记行上、不在落点行上；「上移/下移」说的是置顶区内部的顺序，只对已经钉住的
	// 行出现。
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
	// 常驻形态：侧栏面板而非弹窗。命名强调「放在哪儿」而不是「做什么」。
	'recentFiles.commands.openSidebar': '在侧边栏打开最近文件',
	// 它们的键放在最近文件页，而不是和后退/前进的键并排：两页回答的是不同的问题。
	'recentFiles.hotkeys.desc':
		'进入列表的两种方式：一次性的弹窗，或常驻侧边栏的面板。两者默认都不绑快捷键——在命令面板里按名字打开即可。',

	// 一个没有自己名字的视图步骤回退成什么：关系图谱。真没名字的就直印 viewType。
	'recentFiles.graphView': '关系图谱',
	// 视图行上那个标记的字面回退：没报图标的视图印这两个字。
	'recentFiles.viewBadge': '视图',
	'recentFiles.searchPlaceholder': '按笔记名或文本过滤…',
	// 过滤框末尾那个 ×：app 自己的手势，按「清掉什么」命名；它同时是按钮的无障碍名字。
	'recentFiles.clearFilter': '清空筛选',
	'recentFiles.noMatch': '没有匹配的历史。',
	'recentFiles.empty': '暂无可跳转的位置。',
};
