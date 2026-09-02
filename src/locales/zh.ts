import type { En } from './en';

export const zh: En = {
	openAndRestore: '打开与恢复',
	recordingRules: '记录规则',
	dataStorage: '数据存储',

	defaultPositionName: '编辑视图的默认位置',
	defaultPositionDesc:
		'当某个文件没有已保存的位置时，将光标和滚动位置定位到此处。注意：此设置仅适用于编辑视图；阅读视图不使用此设置。',
	optionDefault: '文件开头（Obsidian 默认）',
	optionFileEnd: '文件末尾',

	linkOpenName: '双链打开位置',
	linkOpenDesc:
		'点击普通双链（不带 # 标题或 ^ 块目标）时，是始终从文件开头打开，还是使用已保存的位置。',
	optionFileStart: '文件开头',
	optionSavedPosition: '已保存的位置',

	sourceRestoreName: '编辑视图的恢复方式',
	sourceRestoreDesc:
		'在编辑视图中如何恢复已保存的位置。“直接跳转”立即定位到保存的行；“平滑滚动”从顶部滚动到该行。',
	optionInstant: '直接跳转',
	optionGlide: '平滑滚动',

	readingRestoreName: '阅读视图的恢复方式',
	readingRestoreDesc:
		'在阅读视图中如何恢复已保存的位置。“直接跳转”在渲染完成后立即定位，“平滑滚动”从顶部滚动到该行。',

	indicatorName: '位置恢复提示',
	indicatorDesc:
		'恢复位置后，向用户显示的提示信息。面包屑：显示当前所在的标题路径；光标高亮：短暂闪烁光标所在的行。',
	optionOff: '关闭',
	optionBreadcrumb: '仅面包屑',
	optionBoth: '面包屑 + 光标高亮',

	minLinesName: '不记录过短文件',
	minLinesDesc:
		'行数少于该值的文件不记录其光标/滚动位置。设为“0”可关闭此过滤。',

	baseScrollName: '记录 Base 文件的滚动位置',
	baseScrollDesc:
		'默认关闭。保存的是原始像素偏移量，只对记录它的那台设备有意义——若数据文件跨设备同步，另一台设备的记录会用不适合本机屏幕的偏移量覆盖本机记录。PDF 始终不记录：Obsidian 已在每台设备上原生记忆 PDF 阅读位置。其他非 Markdown 文件（图片等）一律不记录。',

	foldersName: '排除的文件夹',
	foldersDesc: '不记录这些文件夹及子文件夹中文件的光标和滚动位置。',
	listNoFolders: '未排除任何文件夹',
	addFolder: '添加文件夹',
	searchFolders: '输入以搜索文件夹…',
	noFoldersFound: '未找到文件夹',

	dbName: '数据文件',
	dbDesc: '保存位置记录的 JSON 文件路径，从仓库根目录开始填写，留空使用插件目录下的 positions.json。',
	confirmTooltip: '确认并验证',
	dbDefault: '当前使用默认数据文件。',
	dbInvalid: '数据文件必须是仓库内的相对路径，且需以 .json 结尾。',
	dbNoFolder: '文件夹不存在，请先在仓库中创建该文件夹。',
	dbExists: '该路径已存在文件，但无法读取并合并其内容，请先手动删除该文件。',
	dbMerged: '已采用现有数据文件，并合并了其中 {0} 条记录。',
	dbMoveFailed: '移动数据文件失败：{0}',
	dbSet: '数据文件已设为 {0}',
	entriesName: '记录数',
	entriesDesc:
		'当前记录了 {0} 个文件的位置，最多支持 750 条记录。超出上限时，将优先移除最久未访问的文件的位置记录。',
};
