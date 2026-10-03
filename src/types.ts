
interface CursorPos {
	ch: number;
	line: number;
}

// 高频位置记录，由 readEphemeralState 在每个轮询 tick、每次滚动采集突发和每个重落帧
// 产生：只有位置——不读文档文本、不碰布局。导航显示用的字段在 NavEntryState 上。
interface EphemeralState {
	// 双重含义：markdown 存的是量化后的可见顶部行；base 视图存的是滚动容器的原始
	// scrollTop 像素。一个路径永远是其中一种，所以同一条记录里这个槽不会有歧义。
	scroll?: number,
	cursor?: {
		from: CursorPos,
		to: CursorPos
	},
	// 这个位置「抵达 store 的时刻」，由 database.setState 盖一次章——是读者最后一次有意
	// 移动，不是最后一次 flush。唯一的读者是跨设备合并：数据文件是同步的，同一个 key
	// 谁后来停在这里就算谁的。它出现之前（以及 schema 1 里）没有这个字段，按最旧处理。
	// 落盘写作 `t`，更短，因为文件里每篇笔记一条。
	time?: number,
}

// 导航条目在位置之外还带的东西，只由低频的导航读取在存条目时产生——高频读取从不
// 产生。EphemeralState 在结构上可赋值，所以喂进去的基线状态和旧版条目都能通过
// NavEntryState 类型的消费方检查。
//
// 这里只放「后来的读者再也推不出来」的东西：文件当时多大、那一行当时写着什么。
// 仓库或元数据缓存到浏览时还能答的（标题链、别名、标签、各标题）一律现查，所以
// 永远是最新的，也不占存储。
interface NavEntryState extends EphemeralState {
	// 采集时文件的 mtime。刻意「不」用它来跳过一次文本重映射：那是对活的编辑器缓冲区跑的
	// ——可能与盘上的文件不同，没保存的编辑改了行，却没碰 mtime。
	mtime?: number,
	// 采集时主行（视口顶行）去空白后的文本。唯一「有实际作用」的字段：让一个过期的行号
	// 在位置施加之前，被重映射到今天承载这段文字的那一行——单行、精确匹配语义。
	anchor?: string,
}

// 本机、按标签页各一份的位置记录。
interface TabStateRecord {
	filePath: string;
	st: EphemeralState;
}

// 一篇笔记列表记多少、以及记下来的画多少：一个答案，一条轴上的三档，因为这两个问题
// 不独立——没记过的落点画不出来。
//
//   'none' —— 只记笔记和视图。没有落点可画，也没有可搜的。
//   'last' —— 记落点，但每篇笔记只画一行。落点成了隐形索引：搜索框靠跳转旁边的那几行
//              找到一篇笔记。
//   'all'  —— 记落点、每个各画一行。默认档：只有从这一档往下选，另两档才真的有东西
//              可选；而从这一档往下走不损失任何东西。
//
// 三档是单调的——每一档留的、画的都是上一档的超集——而且每一档都「可逆」：退到
// 'none' 只是不再记新落点、一个也不画，但不删除，再往上走还找得到。
//
// 名字定在这里、紧挨着持有它的那个设置，因为有三处在说它；listing.ts 把它转出去给
// 面板的几个模块用。
type LandingsMode = 'none' | 'last' | 'all';

// 一行上路径印多少。两个「总是」档同时也定下了行挤不下时谁让位：'before' 把「名字」
// 挤到第二行、路径整条留着，'after' 让「路径」下移。
//
// 'smart'（默认）只在屏幕上另一行的名字与它撞车时才印文件夹——那时它是唯一能分开
// 两行的东西——排版上按 'before' 走。
type PathDisplayMode = 'smart' | 'before' | 'after';

// 悬停预览把「笔记自己那一行」打开在哪里——app 自己的预览能指的只有这两档，而且我们
// 哪份列表都躲不开这一个回路：悬停任何一行，都是把笔记交给 app、交给别处。
//
//   'head' —— app 自己的答案，也是它自带每一份列表给的：笔记开在篇首，画一次、不再挪。
//   'line' —— 读者在那篇里读到的最后一行。笔记没法直接开在那里；它先整篇画到篇首，
//              画完才滚过去，所以长笔记会先空着、然后一跳。
//
// 默认是 'head'，理由是第二档的代价：一行的「点击」本来就把笔记开在那一行，所以花
// 一次等待买到的，只是提前一个手势看到同一个抵达。标题行两种选择都不适用：它自称一个
// 地点，不需要等任何东西。
type PreviewFocusMode = 'head' | 'line';

interface PluginSettings {
	dbFileName: string;
	// 0 = 关闭；行数少于该值的文件不记位置
	minLinesToRecord: number;
	// 这些文件夹及其子文件夹里的文件不记位置
	excludedFolders: string[];
	// frontmatter 里含以下「任一」属性名的文件不记位置（值忽略）。空数组 = 关闭。
	frontmatterExcludeProperties: string[];
	defaultPosition: 'default' | 'fileEnd';
	// 普通文件链接（不带 #/^ 目标）打开在哪：已保存的位置，还是文件开头
	linkOpenPosition: 'restore' | 'start';
	// source 模式下如何恢复已保存的位置
	sourceRestoreMethod: 'instant' | 'glide';
	// 阅读视图下如何恢复已保存的位置
	readingRestoreMethod: 'instant' | 'glide';
	// 恢复后显示什么：章节面包屑和/或 source 模式下的闪烁
	restoreIndicator: 'off' | 'breadcrumb' | 'both';
	// 为 base 视图选择性地记录滚动容器的原始 scrollTop。默认关闭：这个值是本机的，别的
	// 设备同步过来的记录会用毫无意义的像素偏移盖掉本机那条。其它非 markdown 的 FileView
	// 一律不记。
	recordBaseScroll: boolean;

	// 导航历史（VSCode 式前进/后退）的调参。
	// 导航历史栈最多保留多少条；溢出时丢最旧的
	navHistoryCap: number;
	// 文件标签页被激活也记为一条导航（视图标签页一向都记）
	navHistoryRecordActivation: boolean;
	// 光标一次要跨过多少行才算一次文件内跳转：跳到某一行、点一个很远的位置、翻页。
	// 0 表示不记。用数字而不是开关，因为问题在于读者心里那次移动有多大。仅电脑端：触屏上
	// 每一次有意的大跳本来就以带 key 的条目送到。出厂 0：从光标移动推断出来的步是读者
	// 没要过的，想要的人自己报距离。
	navHistoryTeleportMinLines: number;

	// 列表「不许」记的文件——它自己的规则，不与 excludedFolders 共用：那条答的是「谁的
	// 光标位置值得记住」（日记文件夹可以不恢复位置，却仍是读者天天回去的地方），这条答的
	// 是「哪些到访值得列出来」。
	recentFilesExcludeFolders: string[];
	// 列表自己的 frontmatter 规则，写法与位置规则一样是 `prop[: value]`：frontmatter
	// 命中的文件永不收录。它「不」读位置功能那个单文件逃生口（`position-restore`）：那个
	// 答的是要不要记「位置」，而一篇拒绝记位置的笔记，仍是读者会去的一个地方。
	recentFilesExcludeProperties: string[];
	// 列表把读者的行踪记到多细、画多少（见 LandingsMode）。一个设置而不是两个，因为没
	// 记过的落点画不出来。
	recentFilesLandings: LandingsMode;
	// ===== 最近文件列表：自己的存储，自己的规则。 =====
	// 与前进/后退的栈、与位置记录都不是一回事：它装的是读者「去过哪里」，所以一个地点
	// 可以住上几个月，而栈里的一步只活几分钟。
	// 它记住多少「篇笔记」——每种模式下溢出都丢最旧的。落点的上限另算、且是内部的：那是
	// 存储卫生，不是让读者去编一个数字。
	recentFilesCap: number;
	// 一行是否印它所在笔记的文件夹，以及印在名字的哪一侧
	recentFilesPathDisplay: PathDisplayMode;
	// 一行是否印距上次到访过了多久。默认开：列表本来就按这个顺序排，所以标签加的是
	// 「量级」——两行都是「刚才」，而只有一个真的出自今早。用的是地点自己的 `t`，不是
	// 文件的 mtime。
	recentFilesRowTime: boolean;
	// 一行印作「笔记名」的 frontmatter 属性，留空则不用。以属性而非文件名给笔记命名的
	// 仓库，处处都按那些名字读——快速切换、反向链接、每个 `[[`——而这份列表正是读者来找
	// 其中一个名字的地方。没有这个属性、或它的值不是名字的笔记，印文件名。
	recentFilesTitleProperty: string;
	// 悬停预览把一行代表的笔记开在哪里（见 PreviewFocusMode）。不受它管的是一行「点名了
	// 落点」的行。
	recentFilesPreviewFocus: PreviewFocusMode;
	// app「自己」的文件列表把悬停预览开在哪里。它自己一个设置，不与上面那个共用：两者是
	// 两块不同的地盘——一块是本插件画的列表，另一块是 app 的——读者完全可能想让一个开在
	// 篇首、另一个开在他离开的那一行。
	fileExplorerPreviewFocus: PreviewFocusMode;
}

export const SAFE_DB_FLUSH_INTERVAL = 5000;

// 视图的 state 有自己的一个 tick 单独重读，比 100ms 的位置轮询慢：这次读取是向第三方
// 视图要 getState，那份开销不归我们管，而答案来晚只推迟一次落点——离开时的读取拿的
// 是最后一次。
export const VIEW_STATE_POLL_MS = 1000;

export const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '',
	minLinesToRecord: 20,
	excludedFolders: [],
	frontmatterExcludeProperties: [],
	defaultPosition: 'default',
	linkOpenPosition: 'restore',
	sourceRestoreMethod: 'instant',
	readingRestoreMethod: 'instant',
	restoreIndicator: 'off',
	recordBaseScroll: false,

	navHistoryCap: 50,
	navHistoryRecordActivation: true,
	navHistoryTeleportMinLines: 0,

	recentFilesExcludeFolders: [],
	recentFilesExcludeProperties: [],
	recentFilesLandings: 'all',
	recentFilesCap: 50,
	recentFilesPathDisplay: 'smart',
	recentFilesRowTime: true,
	recentFilesTitleProperty: '',
	recentFilesPreviewFocus: 'head',
	fileExplorerPreviewFocus: 'head',
};

export {
	CursorPos,
	EphemeralState,
	NavEntryState,
	TabStateRecord,
	PluginSettings,
	LandingsMode,
	PathDisplayMode,
	PreviewFocusMode,
};
