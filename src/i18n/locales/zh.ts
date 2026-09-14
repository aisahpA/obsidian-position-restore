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

	'dataStorage.corruptDb.notice':
		'数据文件无法解析（可能正被同步工具改写），已保留一份副本：{0}。本次从空数据继续，重新打开笔记会重新记录位置。',
	'dataStorage.corruptDb.noticeNoCopy':
		'数据文件无法解析（可能正被同步工具改写），且未能写出副本，其中的位置记录无法找回。本次从空数据继续，重新打开笔记会重新记录位置（详情见控制台）。',

	'dataStorage.entries.name': '记录数',
	'dataStorage.entries.desc':
		'当前记录了 {0} 个文件的位置，最多支持 750 条记录。超出上限时，将优先移除最久未访问的文件的位置记录。',

	'navHistory.heading': '导航历史',
	'navHistory.overview.name': '导航历史',
	'navHistory.overview.desc':
		'类似 VSCode 的“后退 / 前进”导航：记录文件切换与文件内跳转（链接、大纲、搜索结果、大范围光标移动）供命令回溯。功能始终开启，只需绑定快捷键（默认未绑定）。同一标签页内的文件切换走 Obsidian 原生标签页历史（含 PDF、Canvas 等视图）；历史栈大小可在下方调整，按设备保存在 localStorage，重启保留。',
	'navHistory.overview.hotkeyUnbound': '未绑定——点击右侧按钮设置',
	'navHistory.overview.openHotkeySettings': '打开快捷键设置',

	'navHistory.stackCap.name': '历史栈大小',
	'navHistory.stackCap.desc': '导航历史最多保留的条目数，超出后优先丢弃最旧的记录。',
	'navHistory.recordActivation.name': '记录标签页切换',
	'navHistory.recordActivation.desc': '点击其他标签页/面板会推入一条历史（类似 VSCode）。关闭后仅记录文件打开与文件内跳转（关系图谱标签页的步骤也将不再记录）。',
	'navHistory.recordTeleport.name': '记录大范围光标跳变',
	'navHistory.recordTeleport.desc': '光标一次性跨越多行的移动（远距离点击、跳转到行、vim 翻页跳转）会推入一条历史。若滚动或误点常污染历史，可关闭。',

	'navHistory.commands.navigateBack': '后退',
	'navHistory.commands.navigateForward': '前进',
	'navHistory.commands.browseHistory': '浏览导航历史',

	'navHistory.type.open': '打开',
	'navHistory.type.switch': '切换',
	'navHistory.type.teleport': '跳变',
	'navHistory.type.outline': '大纲',
	'navHistory.type.link': '链接',
	'navHistory.type.graph': '图形',
	'navHistory.graphView': '关系图谱',
	'navHistory.searchPlaceholder': '按文件或文本过滤…',
	'navHistory.noMatch': '没有匹配的历史。',
	// 文件范围由两个控件表达同一个状态：直接的「只看本笔记」开关（常用路径，一次点击）
	// 和旁边的选择器 chip——它显示当前生效的文件（未收窄时显示「全部文件」），点开是
	// 历史里出现过的所有笔记。完整路径放在两者的 tooltip 里。
	'navHistory.scope.all': '全部文件',
	'navHistory.scope.pick': '把列表收窄到某个文件',
	'navHistory.scope.count': '{0} 处',
	'navHistory.onlyThisFile': '只看本笔记',
	'navHistory.onlyThisFileTip': '只显示 {0} 里的位置',
	'navHistory.scopeEmpty': '{0} 里没有其他位置。',
	'navHistory.current': '当前位置',
	'navHistory.empty': '暂无导航历史。',
	// 历史栈上限丢弃旧条目时在列表末尾显示：被挤掉的条目在面板里没有别的痕迹。
	'navHistory.capNote': '更早的 {0} 条已丢弃（历史栈上限 {1} 条）',

	// 面板自身：钉顶的「当前位置」卡片、前进/后退分段、键盘提示。
	'navHistory.keyboardHint': '↑↓ 选择 · Enter 跳转 · Esc 关闭',
	// 触屏没有键盘，提示必须说手指能做的事（见 NavHistoryModal.mobile）。
	'navHistory.touchHint': '轻点一行看落点，再点「跳到这里」前往',
	// 仅触屏：点击行只是"选中"（没有 hover），所以预览面板要自带一个真正前往的入口。
	'navHistory.jumpHere': '跳到这里',
	'navHistory.seg.forward': '前进',
	'navHistory.seg.back': '后退',
	'navHistory.seg.count': '{0} 条',
	// 同一个文件的第二个标签页/分栏：没有这个标记，两栏的行无法区分。
	// 只写“第几个/共几个”：不用词，因为那个词是行内“安静区”里最宽的东西。
	'navHistory.pane': '{0}/{1}',
	'navHistory.disabledTip': '文件已删除，这一步无法恢复',
	// 相对时间是面板的主要索引（见 NavEntryBase.t）。
	'navHistory.time.now': '刚刚',
	'navHistory.time.minutes': '{0} 分钟前',
	'navHistory.time.hours': '{0} 小时前',
	'navHistory.time.days': '{0} 天前',
	// 落点预览条（该行上下共三行）。这条只在触屏上显示：电脑端同一处悬停
	// 交给 Obsidian 自带的页面预览，它开在被点的那一行下面，所以不需要空状态。
	'navHistory.preview.loading': '读取中…',
	'navHistory.preview.blank': '（空行）',
	'navHistory.preview.none': '（不是一个可预览的 markdown 落点）',
	'navHistory.preview.gone': '（文件已删除）',
};
