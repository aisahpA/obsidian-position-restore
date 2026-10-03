import { NavEntryState } from '@/types';

// 一次导航，用共享词汇表描述的样子 —— 按 `kind` 打标记的联合类型：形状写错就过不了类型检查，
// 多出一个新分支时，每一个没写全的 switch 都会被挑出来。两个 store 都存它：栈里存成「步」，
// 最近文件列表里存成「地点」。
export type NavEntry = NavJump | NavVisit | NavView | NavTeleport;

// 记录者构造出来的形态：`t` 由栈的 push 补上，所以没有一个构造点会漏掉它，
// 也没有调用方能伪造它。
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewNavEntry = DistributiveOmit<NavEntry, 't'>;

// `t` 只用于显示 —— 行上那句「5 分钟前」读的就是它。栈的顺序永远来自数组下标：两条记录可能
// 落在同一毫秒，而 jumpTo 的副本在重新压栈时会重新盖章。
export interface NavEntryBase {
	leafId: string;
	t: number;
}

// 带 key 的跳转 —— `outline:<标题>`、锚点 / caller 的 linktext。`key` 同时还用来去重：
// 与栈顶那一条 key 相同的 push，说明是同一个标题被点了两次。
export interface NavJump extends NavEntryBase {
	kind: 'jump';
	path: string;
	key: string;
	// key 指向的那个锚点在**记录时刻**位于第几行，落地落定时会被校准 —— 它是结构化重锚的基准差。
	// 它不是记录下来的 scroll：那只是视口顶行，会随版面尺寸和 CM 贴边滚动而漂。
	// 校准之前缺席；缓存已经认不出的目标（改过名的标题、删掉的块）也永远缺席 —— 那种只能靠
	// 文本片段重映射。
	keyLine?: number;
	st?: NavEntryState;
	// 某次导航把读者从这一步带走时他所站的位置。这一步的 `st` 是落点 —— 是行所承诺的位置，
	// 也是地点列表保存的那个 —— 所以漂移只能摆在它旁边，并且自己成为一步
	// （见 NavStack 的 flushDeparture），而不是去改落点：前进后退必须还能把读者送回
	// 他点过的那个标题。
	leftAt?: NavEntryState;
}

// 不带 key 的访问：打开文件、或激活标签页/窗格。它不带自己的位置 —— 每次离开都会刷新 st。
export interface NavVisit extends NavEntryBase {
	kind: 'visit';
	path: string;
	st?: NavEntryState;
}

// 没有文件路径的主区视图：全局图谱、备忘列表、主区搜索 —— 它是工作区里的一个地方，
// 而不是笔记里的一个地方。跳转时会去找正在显示该视图的 leaf，一个都找不到就现场造一个
// （openViewPlace）。
export interface NavView extends NavEntryBase {
	kind: 'view';
	viewType: string;
	// 只用于显示，且可选：既没给名字又没给图标的视图会把两项都留空，行上用文字回答。
	// 这里是「记下来」而不是「用时再查」，因为第三方视图的名字没法从它的类型推出来。
	label?: string;
	icon?: string;
	// 标签页没了、或被换成别的视图时，拿什么重建这个地点 —— 局部图谱是哪个文件、搜索的关键词、
	// 某个插件的筛选条件。这是一份快照，不是活的引用：每次访问刷新一次，读者离开时再刷一次。
	// 身份始终是 viewType，所以同一个视图的两个标签页算同一个地点、共用一份 state。
	state?: Record<string, unknown>;
}

// **推断**出来的同文件光标跳跃 —— 大幅移动、跳到某行、vim 跳转（采样器的启发式，
// 阈值 navHistoryTeleportMinLines，且只在桌面）。读者未必觉得这是一次跳转，所以它是独立的
// 一种 kind：按目标行去重，并显示自己的标记。
export interface NavTeleport extends NavEntryBase {
	kind: 'teleport';
	path: string;
	line: number;
	st?: NavEntryState;
	// 参见 NavJump.leftAt：同样的漂移，只是这一步的位置也是冻结的。
	leftAt?: NavEntryState;
}

// 什么不算一个地点。只有一条：'empty'，主区 leaf 空着时显示的占位符 —— 它背后没有能回去的东西。
// 这里用黑名单而不是白名单，否则答案会取决于读者装了哪些插件。（侧边栏面板压根到不了这个
// 过滤器：它不是主区 leaf。）
//
// 值得一提的特例是网页视图。它的 state 带着当前 url，所以它真正的「地点」是那个 url ——
// 但身份是视图类型，于是它的几个标签页就是几个地点共用一行，每次访问覆盖上一次。所以那一行
// 跟着读者最后所在的标签页走：它的意思是「你最后在读的那一页」。给每个 url 一行就变成
// 浏览记录了，那是浏览器自己的前进后退干的事。
export const NON_DESTINATION_VIEW_TYPES = new Set(['empty']);

// 唯一的一条判据，供那些只把视图看成一个类型的采集点共用。
export function isRecordableViewType(viewType: string | undefined): boolean {
	return !!viewType && !NON_DESTINATION_VIEW_TYPES.has(viewType);
}

// 一次导航属于列表的哪一行。两个读取方必须口径一致 —— 面板按它把行归并（groupByFile），
// 地点 store 按它删掉整行（NavPlaces.forget）—— 而规则写两遍就会漂：面板的一行与 store 删的
// 一批对不上时，会删掉没人指过的地点。
//
// 它不是地点的身份（那在 places.ts 的 placeKey）：一篇笔记和它内部的每一次跳转在这里是
// 一行、在那里是多个地点，而读者从列表上取走的是那篇笔记。视图是两者重合的地方 —— 两边都是一。
export function navGroupKey(entry: NewNavEntry): string {
	return entry.kind === 'view' ? `view:${entry.viewType}` : entry.path;
}

// 一条存下来的视图记录不允许留着的东西：这三样会被直接喂回重放（`setViewState`）或写进 DOM，
// 而那份 blob 可能被读者、同步或截断写进过任何东西，所以只保留它们自称的那部分。
// 记录本身留着 —— 每个字段都有兜底（没有 state 就按默认值重放，没有图标就用文字说「视图」）。
export function pruneViewSnapshot(entry: NavEntry): void {
	if (entry.kind !== 'view')
		return;
	const view = entry as NavView & { state?: unknown; icon?: unknown; label?: unknown };
	if (view.state !== undefined
		&& (!view.state || typeof view.state !== 'object' || Array.isArray(view.state)))
		delete view.state;
	if (view.icon !== undefined && !(typeof view.icon === 'string' && view.icon))
		delete view.icon;
	if (view.label !== undefined && !(typeof view.label === 'string' && view.label))
		delete view.label;
}

// CALLER 目标：读者已经在那篇笔记里时的一次搜索命中或反向链接命中 —— core 把这种目标当作一个
// ephemeral state 交出来，而不是一个链接，所以它既没有锚点名字也不带 linktext，
// restore/patcher.ts 就用 `caller:<毫秒>` 作 key，好把两次点击区分开。
//
// 它定义在这里，是因为这不是某一个 store 的事：最近文件列表会把它降级成它落进的那篇笔记
// （见 NavPlaces.remember），而栈会留着它 —— 回到那个命中点是真实的一步，而落定时采集到的
// 位置是唯一让它可被重演的东西。
export const CALLER_KEY_PREFIX = 'caller:';

export function isCallerKey(key: string | undefined): boolean {
	return !!key && key.startsWith(CALLER_KEY_PREFIX);
}

// wikilink 是整条送到的，连显示别名都在里面（`note#^id|显示成这样`）：等我们看到时 core 已经
// 解析完链接了，所以 `|` 之后的一切都只是标签，不是目标的一部分。留着它，两种锚点都会匹配不上
// —— 块 id 变成 `id|显示成这样`（没有这个块），标题 slug 永远不等于它的标题。这里一次性去掉，
// 就在 linktext 变成 key 的地方（见 restore/patcher.ts），后面的读取方都不必知道这件事。
export function stripLinkAlias(text: string): string {
	const bar = text.indexOf('|');
	return bar < 0 ? text : text.slice(0, bar);
}

// 当目标是「块」时，一次带 key 的跳转所指的是什么：块 id，去掉那个 `^`。
// 有两件事挂在它上面且必须一致 —— restore/anchor.ts 拿这个 id 去 metadata cache 里查，给一步
// 重新定锚；而最近文件列表不给块留地点（见 NavPlaces.remember）—— 所以只在这里从 key 里解析
// 一次，下游不再各解析各的。
//
// key 就是 linktext：`note.md#^id`、`#^id`（笔记内部的自链接）或 `note.md^id`。标题链接
// （`note.md#slug`）与大纲 key（`outline:## H`）也带 `#`，所以做决定的是 `^` 而不是 `#` ——
// 也正因为这样，过去的版本会把 `#^id` 当成标题 slug 读。
export function blockAnchor(key: string): string | undefined {
	const hash = key.indexOf('#');
	const caret = key.indexOf('^');
	const at = caret < 0 ? hash : hash < 0 ? caret : Math.min(hash, caret);
	if (at < 0)
		return undefined;
	const rest = key.slice(at + 1);
	if (key[at] !== '^' && !rest.startsWith('^'))
		return undefined;
	// 转成小写，因为 metadata cache 存块 id 就是这么存的 —— 它的 `blocks` 用
	// `id.toLowerCase()` 作 key，core 匹配链接里的 id 也是同一个路子，所以手写的 `^MyBlock`
	// 指的那个块，在缓存里只叫 `myblock`。
	const id = rest.startsWith('^') ? rest.slice(1) : rest;
	return id.toLowerCase();
}

export function isBlockKey(key: string | undefined): boolean {
	return !!key && blockAnchor(key) !== undefined;
}

// 大纲 key 的目标指的是什么：标题被记录下来的那几个字，key 有两种形态（见 restore/anchor.ts）
// —— `outline:## H` 带着层级与来源，`outline:H` 只有渲染后的文字。**从记录上读，绝不从文件上读**，
// 因为恰恰是在这两者分岔的地方才需要它：标题被删掉之后，这几个字是唯一还能说明某一行代表的
// 是哪个落点的东西（见浏览器那边的 trailFor），而按那一行的行号去算标题链，回答的会是
// 「另一个地方」现在落在哪一节里。
//
// 其它 key 一律返回 undefined：linktext、块 id、caller 目标都不带标题的文字，而一行若打印
// 它的 slug 或时间戳，同样是在说一个它从没站在过的位置。
export function outlineHeading(key: string | undefined): string | undefined {
	if (!key?.startsWith('outline:'))
		return undefined;
	const words = key.slice('outline:'.length).trim().replace(/^#{1,6}\s+/, '').trim();
	return words || undefined;
}

// 一步落在第几行，没记过就返回 undefined。jump 从它自己的 KEY 里作答：两张列表保留的落点都是
// 某次标题跳转，而 key 的那一行是落定那一刻 metadataCache 里那个标题所在的行 ——
// 也就是它的行要跳去的那个行号。记录下来的位置（POSITION）只用来兜那些答不上来的情形：
// 不带 key 的一步，以及跳转到后来被改了名的目标，这两种都只说了读者当时站在哪、别的什么也没说。
//
// 「同一个落点」就是这个意思，它之所以放在这里，是因为有**两件事**按它判定并且必须一致：
// 面板把落在同一行的几步折叠成一行，地点 store 每个落点只留一条记录。写两遍就会漂。
export function landedLine(entry: NavEntry): number | undefined {
	if (entry.kind === 'view')
		return undefined;
	if (entry.kind === 'jump' && typeof entry.keyLine === 'number')
		return entry.keyLine;
	const st = entry.st;
	if (!st)
		return undefined;
	return st.scroll ?? st.cursor?.from.line;
}

// 两张列表的存储版本号跟各自的 store 走，不放在这里：本模块是共享的词汇表，
// 而「格式版本」是关于某一个 store 的 blob 的事实。
