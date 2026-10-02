export const en = {
	// ── 功能一 · 位置记录：记什么、怎么回来、记录存在哪 ────────────────
	'lastPosition.heading': 'Last position',
	// 整页在说什么，开头说一次（settings/page 的 intro 行）：记住的是什么、
	// 记录存在哪。下面任何一行都说不了这两件事。「每个标签页各记各的」刻意
	// 不在这里说：那是本机 localStorage 的覆盖层，放在「记在库里的 JSON 文件里」
	// 旁边，读者会以为它也能跟着换设备。
	'lastPosition.intro':
		'Every note remembers where its cursor sat and how far it was scrolled, and opening it again lands on that spot — no flash at the top first, no jump afterwards. Positions are kept in a JSON file inside the vault, by default in the plugin folder — Obsidian Sync does not carry it from there, so to take your positions to another device, point the path inside the vault (under Data storage below).',

	'openAndRestore.heading': 'Open & restore',
	'openAndRestore.defaultPosition.name': 'Default position in edit view',
	'openAndRestore.defaultPosition.desc':
		'When no saved position exists for a file, move the cursor and scroll position here. Note: this setting only applies to the edit view; reading view does not use it.',
	'openAndRestore.defaultPosition.options.default': 'Start of file (Obsidian default)',
	'openAndRestore.defaultPosition.options.fileEnd': 'End of file',

	'openAndRestore.linkOpenPosition.name': 'Wikilink open position',
	'openAndRestore.linkOpenPosition.desc':
		'When clicking a plain wikilink (without a # heading or ^ block target), whether to always open from the file start or use the saved position.',
	'openAndRestore.linkOpenPosition.options.start': 'File start',
	'openAndRestore.linkOpenPosition.options.restore': 'Saved position',

	'openAndRestore.sourceRestoreMethod.name': 'Edit view restore method',
	'openAndRestore.sourceRestoreMethod.desc':
		'How to restore a saved position in the edit view. "Instant" jumps directly to the saved line; "Glide" scrolls from the top to that line.',
	'openAndRestore.sourceRestoreMethod.options.instant': 'Instant',
	'openAndRestore.sourceRestoreMethod.options.glide': 'Glide',

	'openAndRestore.readingRestoreMethod.name': 'Reading view restore method',
	'openAndRestore.readingRestoreMethod.desc':
		'How to restore a saved position in reading view. "Instant" jumps directly once rendered; "Glide" scrolls from the top to the saved line.',
	'openAndRestore.readingRestoreMethod.options.instant': 'Instant',
	'openAndRestore.readingRestoreMethod.options.glide': 'Glide',

	'openAndRestore.restoreIndicator.name': 'Position restore indicator',
	'openAndRestore.restoreIndicator.desc':
		'The notice shown to the user after a position is restored. Breadcrumb: shows the heading path of the current location; cursor highlight: briefly flashes the line the cursor is on.',
	'openAndRestore.restoreIndicator.options.off': 'Off',
	'openAndRestore.restoreIndicator.options.breadcrumb': 'Breadcrumb only',
	'openAndRestore.restoreIndicator.options.both': 'Breadcrumb + cursor highlight',

	'recordingRules.heading': 'Recording rules',

	'recordingRules.folders.name': 'Excluded folders',
	'recordingRules.folders.desc': 'Don\'t record the cursor/scroll position for files in these folders and their subfolders.',
	'recordingRules.folders.list.empty': 'No folders excluded',
	'recordingRules.folders.add': 'Add folder',
	'recordingRules.folders.search.placeholder': 'Type to search folders...',
	'recordingRules.folders.search.empty': 'No folders found',

	'recordingRules.minLinesToRecord.name': 'Do not record files shorter than',
	'recordingRules.minLinesToRecord.desc':
		'Don\'t record the cursor/scroll position for files with fewer lines than this value. Set to "0" to disable this filter.',

	'recordingRules.frontmatterExclude.name': 'Exclude by frontmatter property/value',
	'recordingRules.frontmatterExclude.desc':
		'Exclude a whole class of notes by frontmatter: a file matching any entry in the list is not recorded.',
	'recordingRules.frontmatterExclude.formName': 'A property name on its own (`status`): any file carrying the property is skipped, whatever its value.',
	'recordingRules.frontmatterExclude.formValue': 'A name with a value (`status: archived`): only files whose value equals it are skipped. yes/no/on/off compare as booleans; an array matches when any one element does.',
	'recordingRules.frontmatterExclude.list.empty': 'No properties excluded',
	'recordingRules.frontmatterExclude.add': 'Add property',
	'recordingRules.frontmatterExclude.search.placeholder': 'Type to search properties...',
	'recordingRules.frontmatterExclude.search.empty': 'No properties found',
	'recordingRules.frontmatterExclude.value.title': 'Exclude when {0} equals',
	'recordingRules.frontmatterExclude.value.name': 'Value',
	'recordingRules.frontmatterExclude.value.desc': 'Leave empty to exclude any file that has this property, whatever its value.',
	'recordingRules.frontmatterExclude.value.placeholder': 'e.g. true',
	'recordingRules.frontmatterExclude.duplicate': '{0} is already in the list',

	'recordingRules.escapeHatch.name': 'Per-file override property',
	'recordingRules.escapeHatch.desc':
		'This page can also be bypassed one file at a time: in its frontmatter, `{0}: false` means never record it — while `{0}: true` means record it anyway, over excluded folders, the minimum-length filter and the property rule above. Only true and false mean anything; write anything else and it reads as if you had never written the property.',

	'recordingRules.recordBaseScroll.name': 'Record scroll position for Base files',
	'recordingRules.recordBaseScroll.desc':
		'A Base has no line numbers to anchor to the way Markdown does, so the only thing worth saving is the pixel offset you scrolled to — and that stops meaning anything once the screen size differs: two devices syncing the database would overwrite each other\'s number. Off by default. This switch concerns Base alone: PDF reading positions are already remembered natively on each device, and images and other non-Markdown files have no scroll state worth keeping.',

	'dataStorage.heading': 'Data storage',

	'dataStorage.dbFileName.name': 'Database file',
	'dataStorage.dbFileName.desc': 'JSON file that stores position records.',
	'dataStorage.dbFileName.current': 'Current path: {0}',
	'dataStorage.dbFileName.change': 'Change',
	'dataStorage.dbFileName.modal.title': 'Set database file',
	'dataStorage.dbFileName.modal.default': 'Use default',
	'dataStorage.dbFileName.modal.cancel': 'Cancel',
	'dataStorage.dbFileName.apply': 'Confirm and apply',
	'dataStorage.dbFileName.pickFolder': 'Choose folder',
	'dataStorage.dbFileName.pickFile': 'Pick an existing JSON file in the vault',
	'dataStorage.dbFileName.search.placeholder': 'Type to search JSON files in the vault',
	'dataStorage.dbFileName.search.empty': 'No JSON file found',
	'dataStorage.dbFileName.messages.default': 'Using the default database file.',
	'dataStorage.dbFileName.messages.invalid': 'The database file must be a vault-relative path ending in .json.',
	'dataStorage.dbFileName.messages.exists': 'A file already exists at that path but is not a valid position database. Nothing was changed — pick another file or remove it first.',
	'dataStorage.dbFileName.mergeHint':
		'If the chosen file already exists, its records are merged into the current database before moving there. If it does not exist, the current database is simply moved to it.',
	'dataStorage.dbFileName.messages.merged': 'Adopted the existing database file and merged {0} record(s) from it.',
	'dataStorage.dbFileName.messages.moveFailed': 'Failed to move the database file: {0}',
	'dataStorage.dbFileName.messages.set': 'Database file set to {0}',
	'dataStorage.dbFileName.syncLocal': 'Inside the plugin folder (the default) — whether it travels with your vault depends on the sync client.',
	'dataStorage.dbFileName.syncVault': 'Inside the vault — an ordinary vault file, which any sync client can carry.',
	'dataStorage.dbFileName.syncHidden': 'Inside a hidden folder — some sync clients skip folders whose name starts with ".".',
	'dataStorage.dbFileName.syncSummary': 'Will Obsidian Sync carry this file?',
	'dataStorage.dbFileName.syncHint':
		'Obsidian Sync takes only data.json, main.js, manifest.json and styles.css out of a community plugin folder, so the database never leaves the device it was written on while it sits in the default location. To make positions follow you between devices, point this setting at a path inside the vault — the buttons below pick or create the folder for you — and enable "Sync all other types" in Obsidian Sync on every device. Folders whose name starts with "." are never synced by Obsidian Sync, so choose an ordinary vault folder.',

	'dataStorage.corruptDb.notice':
		'Position Restore: The database file could not be parsed (a sync client may have been rewriting it). A copy was kept at {0}. Starting from empty — positions are re-recorded as you open notes.',
	'dataStorage.corruptDb.noticeNoCopy':
		'Position Restore: The database file could not be parsed (a sync client may have been rewriting it) and no copy could be written, so its positions are unrecoverable. Starting from empty — positions are re-recorded as you open notes (see the console for details).',
	// 常驻提示（要点一下才消失）：通知区里看不到来源，所以行首要自报插件名。
	// 两条的时刻不同：`notice` 是启动时读到旧版文件（整份已读出）；
	// `noticeOverwritten` 是本会话已写过新版之后，文件又变回旧版 —— 别处刚覆盖过它。
	'dataStorage.legacyDb.notice':
		'Position Restore: the data file is in the format an older version of the plugin wrote. Every position in it was read, and the next save writes the whole file in the current format. If another device still runs an older version, update it too: the older version cannot read the new file, treats it as empty and rewrites it whole, so only the notes opened on that device survive — while versions differ, every sync can drop a batch of positions.',
	'dataStorage.legacyDb.noticeOverwritten':
		'Position Restore: the data file was just rewritten in the older format by a device that has not been updated yet. The older version cannot read the new file, so it wrote back only its own positions; everything another device had recorded in the new format is gone from the file. What this device recorded is untouched and goes back on the next save. Update the plugin on your other devices, or this repeats on every sync.',

	'dataStorage.entries.name': 'Entry count',
	// 「默认位置」＝打开笔记时 Obsidian 自己放光标的那一行：有 frontmatter 就是它下面第一行，
	// 没有就是第一行。停在那里的记录存进文件是个空记录，它不占位置信息，但也不是没用——
	// 它挡着「编辑视图的默认位置」，删掉它那篇笔记下次打开就算「没有记录」。
	'dataStorage.entries.desc':
		'Currently recording positions for {0} files, up to a maximum of 750 entries. When the limit is exceeded, the least-recently-visited records that sit at the default position are dropped first; the rest go least-recently-visited first.',
	'dataStorage.entries.atDefault':
		'Of these, {0} sit at the default position (the first line after the frontmatter) and hold no actual position.',

	// ── 共用 · 快捷键行要用的词，两个页面都用 ──────────────────────────
	// 按它装的东西命名，而不是按它所在的页面——读者找的是键，不是页。
	'hotkeys.name': 'Hotkeys',
	// 打开 app 快捷键设置的那个按钮是额外按钮，窄屏上会换行到这一行「下方」，所以这里
	// 的句子不许指向某一侧——只能指向它长什么样。
	'hotkeys.unbound': 'Not bound',
	// 说「物理键盘」而不说「外接键盘」：两端都成立。
	'hotkeys.hint': 'To bind one: use the keyboard button on this row to open Settings → Hotkeys. A bound key only fires from a physical keyboard.',
	'hotkeys.open': 'Open hotkey settings',
	// 按钮点了没落到那个 tab 时的兜底。
	'hotkeys.openFailed': 'Could not open the hotkey settings. Go to Settings → Hotkeys and find this plugin\'s commands there.',

	// ── 功能二 · 前进与后退：导航栈 ────────────────────────────────────
	'navHistory.heading': 'Back and forward',
	// 整页在说什么，开头说一次：一步是什么、历史存在哪——下面任何一行都没法替自己
	// 说出这两件事，也正是下面那些行能写得短的原因：开关只需说自己那种走法记不记。
	'navHistory.intro':
		'VSCode-style "navigate back" / "navigate forward". Each of these takes a step: opening another note; jumping somewhere inside one — a link, the outline, a search result; switching tabs; opening a view with no file behind it, such as the graph; and a cursor move that crosses many lines at once (desktop only). A switch inside one tab travels on Obsidian\'s own per-tab history, so PDF, canvas and the other views this plugin cannot reposition come back too. The stack is kept on this device only — it does not sync with the vault — and survives restarts.',
	// 这里不重复上面那句：「后退 / 前进」是什么，本页已经说过了。
	'navHistory.hotkeys.desc':
		'One command per direction, walking the steps above. Neither is bound by default — run either by name from the command palette.',
	'navHistory.stackCap.name': 'Back/forward steps kept',
	'navHistory.stackCap.desc': 'Maximum number of entries kept in the navigation history. When exceeded, the oldest entries are dropped first.',
	'navHistory.recordActivation.name': 'Record tab switches',
	'navHistory.recordActivation.desc': 'Clicking another tab pushes a back/forward step. Turned off, switching tabs stops leaving steps and the history keeps file opens and in-file jumps — except for views with no file behind them, such as the graph, which still take one: without that step, back from the graph would overshoot to an earlier note. It governs the back/forward history only: the recent-files list records those views either way.',
	'navHistory.teleportMinLines.name': 'Minimum lines in one cursor move',
	'navHistory.teleportMinLines.desc': 'A cursor move crossing at least this many lines in one action — clicking a spot far away in the note, a go-to-line command, a keyboard motion that crosses many lines at once — counts as an in-file jump and pushes a back/forward step. Set 0 to never record one — the default, since a step inferred from a cursor move is one the reader never asked for. Desktop only: the phone and tablet apps run no such detection.',
	// 四个箭头没有开关——上面两步加上笔记的两端，作为按钮画在最近文件列表的底部：它们
	// 不占那份列表任何东西（它们不是列表的行），而没有键盘的读者除此之外没有别的办法
	// 提出这四个请求，所以开关只会把按钮从真正需要它的人手里拿走。它们作用的是「你打开
	// 的那篇笔记」而不是那份列表，这一点由每个按钮自己的名字说出口。
	'navHistory.commands.navigateBack': 'Navigate back',
	'navHistory.commands.navigateForward': 'Navigate forward',

	// ── 笔记的两端 ────────────────────────────────────────────────────
	// 按「目的地」命名，不按「移动」命名：读者是在挑笔记里的一个地方。和别处一样，
	// 两个默认都不绑。
	'noteEdge.commands.top': 'Go to top of note',
	'noteEdge.commands.bottom': 'Go to bottom of note',

	// ── 功能三 · 最近文件：地点列表，以及它的面板 ──────────────────────
	// 模态框自己的标题，也是「面板」的名字：一份地点列表——最近打开过的笔记，加上在
	// 它们内部跳转到的标题——而「不是」前进/后退那份历史。两者答的是不同的问题。
	'recentFiles.name': 'Recent files',

	// 整页在说什么，开头说一次：一行代表什么，以及这份列表不是什么。后半句是
	// 值得写的那一半——读者是从「前进与后退」页过来的，两个存储答的是不同的问题。
	// 唯一从下面某行借来的一件事是那行的默认值，所以它会跟着 LandingsMode 的
	// 默认值走（'all'：每个标题各占一行），并且点名借的是哪一行。
	'recentFiles.intro':
		'A list of places you have been: notes opened recently, and the main area\'s file-less views (the graph above all) — each one row, and a row opens that spot again. The headings you jumped to inside a note get rows of their own as well — how many, is the "How much it keeps" row below, and by default every one of them is kept. It is not the "Back and forward" stack: that one holds how you got here, this one holds where you have been, and the two are kept apart. The list is kept on this device only — it does not sync with the vault — and survives restarts.',

	// 列表自己的文件夹规则，与位置记录的那条无关——两者不在同一页上，所以这一行
	// 只说自己做什么。
	'recentFiles.folders.name': 'Folders not listed',
	'recentFiles.folders.desc': 'Files in these folders are not added to the recent files list.',
	'recentFiles.folders.list.empty': 'Every folder is listed.',
	'recentFiles.folders.add': 'Add folder',
	// 和上面的文件夹规则问的是同一件事，只是改由笔记自己回答，而不是看它放在哪。
	// 两种写法各占一行：几乎所有读者都是来核对该写哪一种。
	'recentFiles.frontmatterExclude.name': 'Properties not listed',
	'recentFiles.frontmatterExclude.desc':
		'Exclude a whole class of notes by frontmatter: a file matching any entry in the list is never added to the recent files list.',
	'recentFiles.frontmatterExclude.formName': 'A property name on its own (`status`): any file carrying the property is left out, whatever its value.',
	'recentFiles.frontmatterExclude.formValue': 'A name with a value (`status: archived`): only files whose value equals it are left out. yes/no/on/off compare as booleans; an array matches when any one element does.',
	'recentFiles.frontmatterExclude.list.empty': 'Every file is listed.',
	'recentFiles.frontmatterExclude.add': 'Add property',
	// 只数笔记与视图，不数笔记里的标题，所以换档不会让这个数变成另一个意思。
	// 两版文案只差一句：最上面那档标题也画成行，列表会比这个数长。
	'recentFiles.cap.name': 'Notes to remember',
	'recentFiles.cap.desc.plain':
		'How many notes the recent files list remembers (a view counts as one). Past that, the ones you have not opened for the longest are dropped; lowering it takes effect at once, and what it drops does not come back.',
	'recentFiles.cap.desc.all':
		'How many notes the recent files list remembers (a view counts as one) — the headings inside a note do not count, but each is drawn as a row of its own, so the list runs longer than this number. Past that, the ones you have not opened for the longest are dropped; lowering it takes effect at once, and what it drops does not come back.',
	// 记多少 + 画多少，一条轴上的三档：画多少取决于记多少，所以这是一个问题而不是两个；
	// 三档单调，也就不会多出「不记却要全部画出来」这种废组合。三档都可逆，所以文案里
	// 没有「代价」那一半：退回最上面那档只是不再记新的，已记下的留着。
	'recentFiles.landings.name': 'How much it keeps',
	'recentFiles.landings.desc':
		'How finely the list remembers where you have been: the notes you opened only, or the headings you jumped to inside them as well. And once they are recorded, whether they are drawn: the note still takes one row and its headings only answer the search box, or every heading gets a row of its own. Moving either way costs nothing: coming back to "notes only" merely stops recording new ones — the headings already recorded are kept, and going back down finds them there, until the note they stand in is crowded out.',
	'recentFiles.landings.options.none': 'Notes only',
	'recentFiles.landings.options.last': 'Headings, one row per note',
	'recentFiles.landings.options.all': 'Headings, a row each',
	// 两个「总是」档写的是「放不下时谁下移」，因为那才是读者真正在权衡的东西——
	// flex 行在行尾换行，排在后面的那一半才会落到第二行。默认档说得最少：目录是消歧用的。
	'recentFiles.pathDisplay.name': 'Folder path in the list',
	'recentFiles.pathDisplay.desc': 'Whether a row shows the folder its note sits in — on every row, or only where another row on screen shares the name — and on which side of the name. The side also decides which half gives way when the row runs out of width: the one laid out last drops to a second line.',
	'recentFiles.pathDisplay.options.smart': 'Only when names repeat',
	'recentFiles.pathDisplay.options.before': 'Always, before the name',
	'recentFiles.pathDisplay.options.after': 'Always, after the name',
	// 这个时间是地点自己的 t——上一次到那里的时间，不是文件的修改时间；后者恰好是
	// 读者看到文件行上印着时间时的第一反应。确切时刻挂在这个标签的 tooltip 上。
	'recentFiles.rowTime.name': 'Time on each row',
	'recentFiles.rowTime.desc': 'Show how long ago each row was last visited — the last time you were there, and not the file\'s modification time. The exact moment is one hover away, on the label itself.',
	// 只有一个属性名，不再配第二个「优先用哪个」的设置：有这个属性的笔记就用它，
	// 没有的回落文件名——这就是优先级本身。留空＝关闭，且默认关闭：文件名才是
	// app 里其它各处列表的印法。
	'recentFiles.titleProperty.name': 'Name from a property',
	'recentFiles.titleProperty.desc': 'Which frontmatter property a row prints as the note\'s name. A note without it — or whose value is not a single piece of text — keeps its file name.',
	// 这是例子，不是关于规则的提示：读者来这里就是要打 `title`。
	'recentFiles.titleProperty.placeholder': 'e.g. title',
	'recentFiles.age.now': 'now',
	'recentFiles.age.m': 'm ago',
	'recentFiles.age.h': 'h ago',
	'recentFiles.age.d': 'd ago',
	'recentFiles.age.w': 'w ago',
	'recentFiles.age.mo': 'mo ago',
	'recentFiles.age.y': 'y ago',
	// 悬停上那两行名字的引导词 = 属性名本身（`title` / `aliases`），中英文都一样：
	// 属性名是读者笔记里的 key，app 的属性面板也不翻译它，写成中文反而对不上他
	// 自己写的那一行。小写，因为 YAML 里就是这么写的，我们读的也是 `fm?.aliases`。
	// 分成两行是因为 `title` 不是别名：它是笔记自称，而「别名」是 app 的说法，只
	// 指 `aliases`。行上已经印着 title 的时候，这一行不出现。冒号写进值里。
	'recentFiles.title': 'title:',
	// 另外几个名字：可被搜索、不占格子，悬停是读者唯一能看到它们的地方。
	'recentFiles.aliases': 'aliases:',
	// 标题行 tooltip 上那两行「引文」的引导词：都是笔记自己的文字——记下时抓的、
	// 屏幕上哪里都不印的。重点在「记下时」：笔记后来可能改过，这是当时那句话。
	// 挂在它们下面那句是面板自己的话（面板自己的处境）：挪得回去的标题它已经在
	// 画出来之前挪回去了，轮不到读者动手；剩下要说的就是挪不回去的那一档——
	// 改过之后这个标题不在笔记里了，这一行指向的那一处也就无处可去。
	'recentFiles.matchedLine': 'Matched:',
	'recentFiles.lostLanding': "Can't find this heading since the note was edited",
	'recentFiles.openInNewTab': 'Open in new tab',
	'recentFiles.openHereInNewTab': 'Open here in a new tab',
	// 行自己的移除控件，也就是行上的那个 ×。用「移除」而不是「删除」：走掉的只是这条
	// 记录，文件本身和位置数据库里的其它记录都不动，下次再进这个文件它就回来了。
	'recentFiles.forget': 'Remove from recent files',
	// 标题行上同一个 × 的说法：这里走掉的是一个标题，不是整篇笔记。用「标题」而不是
	// 「行」：读者看到的是那个标题所在的那一节，标题挪过之后它还是同一处。
	'recentFiles.forgetLanding': 'Remove this heading',
	// 标签页右键菜单上那一项：走掉的是整个列表，留下的是置顶的那几行——置顶是读者
	// 自己钉的，不是列表自己记的；被清掉的笔记再打开一次就会回来（位置也还在）。
	'recentFiles.clearList': 'Clear the whole list',
	// 行上第二个控件：它升起的是 app 对这份文件自己的那张菜单。说「更多操作」而不说
	// 「菜单」——那张菜单是 app 的；也有别于「在新标签页打开」，那只是菜单里的一项。
	'recentFiles.rowMenu': 'More actions',
	// 笔记自己那一行让 app 填的那张菜单上的四句话：置顶是对「一篇笔记」的书签，所以
	// 只在笔记行上、不在标题行上；「上移/下移」说的是置顶区内部的顺序，只对已经钉住的
	// 行出现。
	'recentFiles.pin': 'Pin to top',
	'recentFiles.unpin': 'Unpin',
	'recentFiles.pinUp': 'Move up',
	'recentFiles.pinDown': 'Move down',
	// …以及一步到头：置顶区长了以后，一次挪一步要来回开这张菜单。
	'recentFiles.pinFirst': 'Move to front',
	'recentFiles.pinLast': 'Move to end',
	// 用「浏览」而不是「打开」：被打开的是那份列表，而「打开最近文件」读起来像打开
	// 读者上次所在的那个文件。这也是两条命令在命令面板里能一眼分开的地方——另一条是
	// 「打开 …」。
	'recentFiles.commands.open': 'Browse recent files',
	// 常驻形态：侧栏面板而非弹窗。命名强调「放在哪儿」而不是「做什么」。
	'recentFiles.commands.openSidebar': 'Open recent files in sidebar',
	// 它们的键放在本页，而不是和后退/前进的键并排：想找「打开这份列表」那个键的人，
	// 不该先知道它藏在一个讲行进的标题底下。
	'recentFiles.hotkeys.desc':
		'Two ways into the list: a dialog that answers once and closes, or a panel that stays in the sidebar. Neither is bound by default — the command palette opens either by name.',

	// 一个没有自己名字的视图步骤回退成什么：关系图谱。自己有名字的印那个名字，没有的
	// 印它光秃秃的类型。
	'recentFiles.graphView': 'Graph view',
	// 视图行上那个标记的字面回退：没报图标的视图印这两个字。
	'recentFiles.viewBadge': 'View',
	'recentFiles.searchPlaceholder': 'Filter by note name or text…',
	// 过滤框末尾那个 ×：它是按钮的无障碍名字兼 tooltip，所以写的是动作而不是那个符号。
	// 两个名字，对应同一个符号承担的两件事：有输入时清空，没输入时关闭对话框。
	'recentFiles.clearFilter': 'Clear filter',
	'recentFiles.close': 'Close',
	'recentFiles.noMatch': 'No matching entry.',
	'recentFiles.empty': 'Nowhere to go.',

	// ===== 悬停预览把笔记打开在哪里 =====
	// 会向 app 要预览的两处列表共用这一个分组，各有自己的四个键而不是共用一条
	// 文案：今天写的字一样，但两项落在不同的设置页，迟早要各说各的。两处默认都
	// 是篇首：指到那一行的话，app 先把整篇画出来再挪过去，等于让卡片先空着一
	// 下——而同一行的点击本来就把人送到那里。
	'previewFocus.recentFiles.name': 'Where a preview opens the note',
	'previewFocus.recentFiles.desc':
		'The spot the app\'s own preview opens a hovered row\'s note at: its top, the way every list the app itself ships opens one, or the line you were last reading it at. Naming a line costs a wait — the note is drawn whole first and only then moved to it, so on a long note the card stands empty and then jumps. A row standing for a place in a note opens at that place either way.',
	'previewFocus.recentFiles.options.head': 'Its top',
	'previewFocus.recentFiles.options.line': 'Your last line',
	'previewFocus.fileExplorer.name': 'Where a file list preview opens the note',
	'previewFocus.fileExplorer.desc':
		'The spot the app\'s own file list opens its hover preview at: a note\'s top, which is what the app asks for and what it ships, or the last line this plugin recorded for that note. Naming a line costs the same wait it costs everywhere — the note is drawn whole first and only then moved there — and the line it opens is the one last recorded here, so a note changed on another device since may not open where you left it.',
	'previewFocus.fileExplorer.options.head': 'Its top',
	'previewFocus.fileExplorer.options.line': 'Your last line',
};

export type En = typeof en;
