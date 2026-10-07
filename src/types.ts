
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
// 一次等待买到的，只是提前一个手势看到同一个抵达。大纲行两种选择都不适用：它自称一个
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
	// 普通文件链接（不带 #/^ 目标）打开在哪：已保存的位置，还是文件开头
	linkOpenPosition: 'restore' | 'start';
	// 恢复位置后，在笔记中间短暂显示「落在哪一节」的面包屑。两种情况不说：这一屏里已经
	// 能看到标题（一眼就知道在哪一节），以及整篇只有一个标题（那是笔记名或它唯一的小节）。
	// 笔记的一级标题多半就是文章标题，也不会重复显示（见 position/ui/cue.ts 的 breadcrumbPath）。
	restoreBreadcrumb: boolean;
	// 落到一处之后标出那一行（阅读视图里标出那一小块）：打开笔记回到上次的位置时，
	// 以及点大纲、点搜索结果里的小节、用前进/后退落到某一行之后。编辑模式标光标那一行
	// —— 它在屏外时自然标不出来，不必先做判断。
	flashLandingLine: boolean;
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
	// 图片文件（app 会用图片视图打开的那些后缀）是否一律不收录。它是一个开关而不是
	// 一条默认规则：这一份列表本就收录主区域里的每一个目的地 —— 第三方视图、canvas、
	// pdf 都算 —— 而一张图片在这样的列表里只剩下文件名可印（没有位置、没有标题、没有
	// 大纲可搜），所以「它算不算一个值得列出来的地方」是读者自己的取舍，出厂关。
	//
	// 它只影响**之后**的到访：已经进列表的图片行不动，直到被上限挤出去，或被一次规则
	// 变更（见 applyRecentFilesExclusions）扫掉 —— 不为此写迁移。
	recentFilesExcludeImages: boolean;
	// 搜索框是否把**各篇笔记的小节标题**也算进搜索面：开着时，输一个标题词会把命中的
	// 那一节作为一行画在那篇笔记下面，点它去那一节。关掉时搜索只认名字、路径与其它
	// 名字，一行也只代表那篇笔记。
	//
	// 它与「列表记什么」正交：无论开关怎样，一份跳转都只记成「读者在这篇笔记里」（见
	// places.ts），所以这一项从不改变**记录**的东西，只改变搜索能找到什么、以及画什么。
	recentFilesOutlineSearch: boolean;
	// 它记住多少「篇笔记」——溢出时丢最旧的。一行就是一篇笔记（或一个视图），所以这就是
	// 行数，没有第二个名额池。
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
	// 悬停预览把一行代表的笔记开在哪里（见 PreviewFocusMode）。不管的是**大纲行**：它是
	// 一个点名了小节的行，预览它就是预览那一节。
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
	linkOpenPosition: 'restore',
	restoreBreadcrumb: true,
	flashLandingLine: true,
	recordBaseScroll: false,

	navHistoryCap: 50,
	navHistoryRecordActivation: true,
	navHistoryTeleportMinLines: 0,

	recentFilesExcludeFolders: [],
	recentFilesExcludeProperties: [],
	recentFilesExcludeImages: false,
	recentFilesOutlineSearch: true,
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
	PathDisplayMode,
	PreviewFocusMode,
};
