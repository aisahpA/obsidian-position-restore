import { Keymap, MenuPositionDef, setIcon } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { placeKey } from '@/recent-files/places';
import { PaneTarget } from '@/nav/pane';
import { t } from '@/i18n';
import { groupByFile, LandingsMode, matchesNavFilter, matchedHeading } from './listing';
import type { HeadingRef } from '@/shared/headings';
import { PathDisplayMode } from '@/types';
import {
	NavEntryDescription, ageLabel, badgeOf, displayName, dropsOuterLevel, duplicateNames, folderOf,
	newestStamp, pathLabel, rowTrail,
} from './model';
import type { FileNames } from './reads';
import { NavRowTip, TipContent } from './tip';
import { LongPress } from './long-press';
import {
	LONG_PRESS_MS,
	LONG_PRESS_SLOP_PX,
	ROW_PRESS_HOLD_MAX_MS,
	ROW_PRESS_MARK_MS,
} from './constants';

// 一行是什么 —— 为了那唯一一次从指针事件找到它的查找：指针在某一行内部的
// 某个盒子上，而该行是为它们全体发声的那个元素（见 rowAt）。
const ROW_CLASS = 'position-restore-nav-row';

// 笔记列表：查询留下哪些步、它们如何按笔记归并成一行、键盘在走什么，
// 以及一次点击所移动的**那唯一一个**位置。
//
// **笔记就是那一行。** 一篇笔记自己的记录不携带位置，所以它的行以**普通**方式
// 打开文件 —— 与 Obsidian 的文件浏览器做的完全一样 —— 由位置数据库决定读者落在
// 何处。这让指向同一个文件的两个入口点表现一致，也是为什么文件行从不打印行号
// （那是跳转的事，见 placeRow）。
//
// **行下面是什么由设置决定**（见 LandingsMode）：默认什么都不打印；'all' 在名字
// 下面打印每条不同的行号，笔记顶部在前。一个只有**一个**地点的笔记两种情况下都
// 不打印 —— 单个地点不成其为列表。
//
// **行是一个整体**：一次点击打开它所代表的东西。它远端的那个 × 把该行从列表里
// 丢掉；它以绝对定位摆在**流之外**，所以它出现时什么都不动、而行上的每一个像素
// 仍能打开它。这次移除属于**行** —— store 丢掉该行被绘制所依据的每条记录
// （见 onForget）—— 这就是为什么它不能住在行的菜单里：那个菜单是 app 的文件
// 菜单，而只有文件才有这么一个（见 onContextMenu）。
//
// **悬停时什么都不动**：位置只因点击或按键而移动。悬停可以**说**些东西
// （app 的着色、这份列表的提示、app 的页面预览），但从不移动任何东西。
// **悬停是指针移动到了一行上**，而不只是位于其上：一行被画在一个从未移动过的
// 指针之下，并没有被指向（见 hoverAt）。
//
// **在被阅读时也什么都不动**：一次点击会重排它所来自的那些地点（按上次访问
// 保持），所以可以把列表当前正在展示的次序交给它、并让它保持住（见 `order`
// 选项）。
//
// 这份列表拥有一个**位置**，`selected`：键盘走它（见 move），重画会重新找到它，
// Enter 行走至它。**点击**不设它 —— 模态框会在半路上关闭。

// 类所保持的一行：那个元素，以及它所代表的东西。FILE 行的身份是组（从它出发的
// 一次行走读 `group`；见 activeRep）；它的 `rep` 保持为空。落点行的 `rep` 是它
// 自己的地点索引。
interface RowRef {
	el: HTMLElement;
	rep?: number;
	group?: number;
}

// 落点行的节链，留给那个回读布局的遍历（见 fitTrails）。`note` 是携带而不是重算的，
// 因为 fit 遍历会**重写**这一行的 tooltip，而一个只凭链写出的 tooltip 会连同被丢掉的
// 那一层一起把「笔记被改过」这句话带走。
interface TrailRow {
	el: HTMLElement;
	// 外层 —— 最先离开的那一层（见 rowTrail / dropsOuterLevel）。
	outer: HTMLElement;
	chain: string[];
	note?: string;
}

export interface RecentFilesListOptions {
	// 列表元素，由浏览器创建。
	list: HTMLElement;
	// 行的绘制所依据的历史，作为一个快照。
	entries: NavEntry[];
	// 当前条目的栈索引：它的笔记被钉选在最前，而持有它的那个落点携带
	// 「你在这里」标记（见 placeRow）。
	currentIndex: number;
	// 行的选项 id 由它构建，所以第二个浏览器打开时它们仍保持唯一
	// （见 RecentFilesModal.listId）。
	listId: string;
	// 搜索框的当前文本。
	filter: () => string;
	// 一个条目的展示碎片（由浏览器缓存）。
	describe: (rep: number) => NavEntryDescription;
	// 丢掉每次重画的 describe 缓存：它所描述的那些行已经没了。
	clearDescribeCache: () => void;
	// 一篇笔记是否仍在磁盘上。这是地点被**过滤**的方式，而不是行被禁用的
	// 方式：一个文件已不在的名字根本不列出。
	noteExists: (path: string) => boolean;
	// 一个条目的落点所处的标题链，用条目的**索引**发问，好让浏览器为该地点作答，
	// 而不是为条目单独看起来的样子作答。
	trailFor: (entry: NavEntry, d: NavEntryDescription, i: number) => string[];
	// 这一篇笔记的**各个**标题，文档顺序 —— 搜索面用它，而**不是**记在条目上的任何快照：
	// 现查（metadataCache，缓存没答时经 cachedRead 兜底），所以它永远是最新的，而体积
	// 与笔记长度无关。见 reads.ts 的 headingsFor。
	headingsFor: (path: string) => HeadingRef[] | undefined;
	// 文件的**其它**名字：可搜索、打印在行的 tooltip 上、别处一概不出现
	// （见 tip.ts）。一个无路径视图没有这些。`printed` 是该行展示的名字，
	// 它不属于它们之中；两类名字分开返回，因为只有其中一类是 app 所称的
	// 别名（见 FileNames）。
	otherNames: (path: string, printed?: string) => FileNames;
	// 这一行的落点是否**丢了**它所命名的标题：此后笔记被写过，其中已没有任何东西
	// 为这个位置作答。由浏览器回答，它是已经知道行号现在何处的哪一方 —— 对那件事
	// 有两个答案，会让行自己的词与它所警告的东西不一致。见浏览器的 landingLost。
	lostLanding: (entry: NavEntry, d: NavEntryDescription, i: number) => boolean;
	// 位置移动了：浏览器把过滤框的 aria-activedescendant 指向该行的 id
	// （焦点从不离开那个框）。
	onActiveRow: (id: string | undefined) => void;
	// 一行被点击了：在它所代表的东西处打开文件。`target` 是 app 对那个手势自己的
	// 答案（见 PaneTarget），绝不是本模块自己读出的修饰键。
	onTravel: (rep: number, target?: PaneTarget) => void;
	// 一行被右键点击（或在手机上，它的已武装行的菜单控件被轻点）：**哪个**地点、
	// 菜单在屏幕上**哪里**打开、以及该行是**笔记本身**还是一个它内部的点 ——
	// 钉选是给一篇笔记的书签，所以浏览器可以往菜单里加什么取决于它是哪一种。
	// 是一个**点**而不是事件本身，因为两扇门不一致：右键回答指针在哪，控件轻点
	// 回答控件**立**在哪 —— 平台为手指投递的一次点击可能携带零坐标。
	onContextRow: (rep: number, at: MenuPositionDef, note: boolean) => void;
	// 从一行升起的菜单是否立着 —— 若立着，则**收回**它（见 body.ts 的
	// takeMenuBack）。
	takeMenuBack: () => boolean;
	// 指针**移动到了**一行上：每次访问每行交出一回（见 hoverAt）。拿它做什么由
	// app 自己的页面预览决定：这份列表不持有 App，而预览是画在一切之上的。`file`
	// 说明该行代表**笔记本身**还是它内部的一个点。
	onHoverRow: (rep: number, ev: PointerEvent, el: HTMLElement, file: boolean) => void;
	// 行上的提示此刻是否应当**沉默**，在每次悬停时重新发问
	// （见 PreviewSettle.isOpen）。
	tipsQuiet?: () => boolean;
	// 指针离开了**列表**（见构造函数）；一次悬停会话结束了，app 被要求的一切
	// 都可退下。
	onHoverEnd?: () => void;
	// 读者从 × 把一行拿下了列表：**哪一行**，按组 KEY（见 navGroupKey）。
	// 是一行而不是一个地点：走掉的是**笔记**及其中每个点。
	onForget: (key: string) => void;
	// 读者把**一个落点**拿下了列表：该行代表哪些地点，按**身份**（见 placeKey）
	// —— 一行可以覆盖同一行上的两条记录，留下一个会让该行立刻回来。
	onForgetLanding: (keys: string[]) => void;
	// 列表打印一篇笔记的多少（见 shownLandings）。每次重画时读。
	landings: () => LandingsMode;
	// 一行的**路径**打印多少，以及打印在名字的哪一侧。每次重画时读。
	pathDisplay: () => PathDisplayMode;
	// 一行是否说出它的笔记上次被访问是多久以前。关掉时不构建元素，也不隐藏
	// 任何元素。
	rowTime: () => boolean;
	// 读者**钉选**过的行，按组 key，以它们被展示的次序。由重画拉到列表顶部，
	// 且**不带**它们的落点绘制：钉选是给笔记的书签，而这个块本就该保持它现有的
	// 大小。每次重画时读。
	pinned: () => readonly string[];
	// 要让列表**保持**在的组次序（见类注释），或 undefined 表示按新近度排序。
	// 每次重画时读。
	order: () => readonly string[] | undefined;
	// 一个地点的**身份**（见 placeKey）。注入进来是因为列表不持有 store；当列表
	// 在它下面被重建时，一次点击靠它重新找到自己的行 —— 索引派不上用场，因为
	// 重新寻找的全部理由就是索引移动了（见 onClick）。
	keyOf: (rep: number) => string | undefined;
	// 这台设备是否是**触摸**设备：决定指向一行的两种方式中到底存在哪一种 ——
	// 一个指针停在行上，还是一根手指停在行上（见 arm）。
	touch: boolean;
}

// 列表要滚动多远才展示出**键盘**走到的那一行：当该行完全在列表内时为 undefined，
// 否则是把该行的中部放到列表中部所需的距离。**不是**最小滚动：行的高度全都一样，
// 所以最小滚动会让该行紧贴着边缘，而此后每一步都把名字滚到一个永不移动的标记下面
// —— 那读起来像「是滚动条在动，不是选中项在动」。落在中部每半个列表支付一次跳变，
// 并让每一步都可见地是一步。
export function revealDelta(rowTop: number, rowHeight: number, boxTop: number, boxHeight: number): number | undefined {
	if (rowTop >= boxTop && rowTop + rowHeight <= boxTop + boxHeight)
		return undefined;
	return Math.round(rowTop - (boxTop + (boxHeight - rowHeight) / 2));
}

// 一条节链作为一行文本，最外层在前。分隔符是行自己的（见 rowTrail），而**两**种行
// 都用文字打印一条链 —— 落点的 tooltip 与文件行的 —— 所以两者不会漂移成把同一件事
// 说得不一样。
function chainText(chain: string[]): string {
	return chain.join(' › ');
}

export class RecentFilesList {
	// 屏幕上的行，从上到下；键盘走的就是**这个**（见 refs）。
	private refs: RowRef[] = [];
	// 上次重画的组：文件行的 `group` 索引进的就是它。**绘制次序** —— 钉选行在前，
	// 然后是其余（见 render）。
	private groups: ReturnType<typeof groupByFile> = [];
	// 这些组里有多少个被钉选：前 `pinnedCount` 行就是那个块，而它们正是不打印
	// 落点的那些。
	private pinnedCount = 0;
	// **那个**位置：读者所在的行。在第一次按键之前为 undefined。
	private selected: RowRef | undefined;
	// 读者**按下**的地点，按身份，直到它的点击到达：当列表在按下与松开之间被重建
	// 时，一次点击**从**哪里打开（见 onClick）。永远只是一次透传。
	private pressed?: string;
	// 一行在悬停时说的东西（见 tip.ts）。
	private tip: NavRowTip;
	// 打印节链的那些行（见 fitTrails）。
	private trails: TrailRow[] = [];
	// 列表自己的宽度，被监视：一条链是否放得下，是关于该行**此刻**拥有的宽度的
	// 问题（jsdom 不实现布局，所以有这个守卫）。
	private watched?: ResizeObserver;
	// 指针**正位于**的行，以及它上次被**播报**的行 —— 分开保存，好让一个在行内
	// 游走的指针只说它一次（见 hoverAt）。
	private hovered?: RowRef;
	// **指针上次所在之处**，用列表的坐标：唯一能区分「指针移动了」与「列表在它
	// 下面移动了」的东西（见 hoverAt）。在面板第一次见到指针之前为 undefined。
	private pointerAt?: { x: number; y: number };
	// **一根手指停住的那一行**（见 arm）：一行，回答一次，越过读者做任何其它事的
	// 那一刻 —— 是一个**行**而不是一个**模式**，所以没有什么「忘了离开」。
	private armed?: RowRef;
	// **一次按下在它所落在的行上留下的标记**（见 markPressed）：行上的一个 class，
	// 不是列表的一个模式 —— 一行、一次按下，自己消失。
	private marked?: HTMLElement;
	// ……以及它何时消失，那**不是**手指抬起的时候（见 ROW_PRESS_MARK_MS）。
	private markFade?: number;
	// ……以及面板所立的那个 document，手指抬起在那里被听到（一次抬起可能发生在
	// 它开始时所在的那行之外；见 onLift）。
	private doc: Document;
	// 落在菜单控件上的这次按下是**收回一个立着的菜单**而不是要一个
	// （见 menuControl）；只有按下知道是哪种。
	private menuTapCloses = false;
	// 武装一行的那个手势，只在没有悬停可用来武装它时才存在（见 `touch` 选项）。
	private press?: LongPress;

	constructor(private opts: RecentFilesListOptions) {
		// 没有任何东西是为**列表**自己的缘故而监听的 —— 指针不移动位置；
		// 行自己的点击在行被画出时接好。
		this.tip = new NavRowTip(opts.list, opts.tipsQuiet);
		if (typeof ResizeObserver === 'function') {
			this.watched = new ResizeObserver(() => this.fitTrails());
			this.watched.observe(opts.list);
		}
		if (opts.touch) {
			this.press = new LongPress(opts.list, {
				ms: LONG_PRESS_MS,
				slop: LONG_PRESS_SLOP_PX,
				onArm: target => this.armAt(target),
			});
			// 一次长按在读者做任何其它事的瞬间就结束了：任何地方的点击（已武装行
			// 自己的控件在它到达这里之前会停住自己的），或一次把行从手指下带走的
			// 滚动。两者都在列表上听到、而非按行听：结束的是那一次按下，而按下
			// 并不属于某个特定的行。
			this.opts.list.addEventListener('click', () => this.disarm());
			this.opts.list.addEventListener('scroll', () => {
				this.disarm();
				// ……标记也一样：一次只是滚动的开头的按下，不是读者在指某一行。
				this.unmark();
			}, { passive: true });
		}
		// 两个表示「指针来到了一行上方」的事件都听，因为一只甩到一行上并停住的
		// 手可能只投递其中一个 —— 且两者都**在列表上**而不是在行上：一行每次重画
		// 都会被重建，而听到的是指针。
		this.opts.list.addEventListener('pointermove', (ev) => this.hoverAt(ev));
		this.opts.list.addEventListener('pointerover', (ev) => this.hoverAt(ev));
		// 列表是那个意味着「根本不在任何行上」的边界：每一行都听到自己的离开 ——
		// 包括它为了另一行而离开的那些情形。
		this.opts.list.addEventListener('pointerleave', (ev) => {
			this.hovered = undefined;
			// 指针上次被看到的位置也随它一起走 —— 那是手回来时所在之处。
			this.pointerAt = { x: ev.clientX, y: ev.clientY };
			this.opts.onHoverEnd?.();
		});
		// 抬起的手指结束了按下留下的标记 —— 在 **document** 上听到：一根在抬起
		// 之前滑出了列表的手指，仍然是一根抬起的手指（见 releaseMark）。
		this.doc = this.opts.list.ownerDocument;
		this.doc.addEventListener('pointerup', this.onLift);
		this.doc.addEventListener('pointercancel', this.onLift);
	}

	// 一行所作用的地点索引：一个落点就是它自己；一篇**笔记**是笔记**自己**的记录
	// —— 代表文件而非其内部某个点的那个地点（见 listing.ts 的 `anchor`）。这正是
	// 让文件行是一次**打开**而不是一次跳转的原因：它的记录不携带位置，所以走到它会
	// 以普通方式打开文件，与在 Obsidian 的文件浏览器里点击它完全一样。一个没有
	// anchor 的组（笔记自己的记录被淘汰、它的跳转存活）回落到它最新的落点。
	//
	// 这段所回答的每一行都**有**去处：一个文件没了的地点永远不会成为一行（见
	// render 的 `keep`），所以这里唯一能到 -1 的途径是一个列表不再持有的组。
	private activeRep(row: RowRef): number {
		if (row.group === undefined)
			return row.rep ?? -1;
		const group = this.groups[row.group];
		if (!group)
			return -1;
		if (group.anchor !== undefined && group.anchor >= 0)
			return group.anchor;
		const order = group.indices;
		// 地点索引**就是**时钟（列表保持在 MRU 次序）：一篇笔记的落点中
		// 最高的索引就是它最新的那个。
		return order.length ? order.reduce((a, b) => (a > b ? a : b)) : -1;
	}

	// 这篇笔记的落点此刻是否打印在它自己那行下面。一个落点不成其为列表 —— 它正是
	// 笔记自己那行已经代表的东西。一个**被钉选**的行永远不打印任何落点：那个块是
	// 一个书架，而一行若在读者每次访问该笔记时长出两行，就会把书架往下推出面板。
	// 钉选让读者付出的是地点的**列表**；该行仍代表最新那个，所以一次点击照旧去它
	// 一贯去的地方。
	private printsLandings(group: number): boolean {
		if (group < this.pinnedCount)
			return false;
		return this.opts.landings() === 'all' && (this.groups[group]?.indices.length ?? 0) > 1;
	}

	// 一篇笔记的哪些地点在屏幕上：默认一个也没有；在 'all' 下是每条不同的行号，
	// 笔记顶部在前。
	private shownLandings(group: ReturnType<typeof groupByFile>[number], index: number): number[] {
		return this.printsLandings(index) ? group.indices : [];
	}

	// 把被钉选的行放到顶部，按读者自己的次序（见 `pinned` 选项），并数它们。一个
	// 命名了不在屏幕上的行的钉选 —— 被过滤掉了，或是一个列表不再持有的地点 —— 被
	// 跳过：那个块是从存在的行里画出来的，而钉选不是「它的笔记一定被列出」的承诺。
	private pullPinnedToTop(): void {
		const byKey = new Map(this.groups.map(g => [g.key, g]));
		const pinned = this.opts.pinned();
		const top: typeof this.groups = [];
		for (const key of pinned) {
			const group = byKey.get(key);
			if (group)
				top.push(group);
		}
		this.pinnedCount = top.length;
		if (top.length === 0)
			return;
		const held = new Set(top);
		this.groups = [...top, ...this.groups.filter(g => !held.has(g))];
	}

	// 刚画出的这一行是否是钉选块的最后一行，那正是它下面欠一条线的时刻 —— 且只有
	// 在后面还有东西时：整份列表下面的一条线会是「没有东西」下面的一条线。
	private endsPinnedBlock(index: number): boolean {
		return this.pinnedCount > 0
			&& index === this.pinnedCount - 1
			&& this.groups.length > this.pinnedCount;
	}

	// （重）画这些行；工具栏与面板在它们周围持续存在。
	render(): void {
		// 一次长按不会活过重画：手指停住的那一行即将被丢掉，而画在它位置上的行
		// 上的一个 ×，是没人武装过的行的控件。标记与词出于同样的理由随它一起去。
		this.disarm();
		this.unmark();
		this.tip.reset();
		// 光标在这次重建前后所站之处：它占据的那个**槽位**，不是站在槽位里的那一行
		// —— 组的索引，或它所在的落点的栈索引。所以一次会重排的重画（输入了过滤、
		// 丢掉了一行、钉选上移）会让光标留在同一个槽位上，而它现在命名另一篇笔记：
		// 这是刻意选的，也是行从不按位置被播报的原因。在行消失**之前**捕获。
		const cursor = this.selected;
		const wasGroup = cursor?.group;
		const wasRep = cursor && cursor.group === undefined ? cursor.rep ?? -1 : -1;
		this.opts.list.empty();
		this.opts.clearDescribeCache();
		this.refs = [];
		this.trails = [];
		this.groups = [];
		this.selected = undefined;
		// 指针上次被播报的那一行随它们一起去 —— 它的元素正在被丢掉。指针自己的
		// 位置**没有**被忘记：画在一只尚未移动过的手下面的行，仍然不是那只手指向
		// 的行。
		this.hovered = undefined;

		const query = this.opts.filter().trim();
		// 查询按文本收窄：行打印的内容（它的名字，以及落点的节链）加上从 **vault**
		// 派生的一切（文件的其它名字、**该文件的所有小节**）。后者派生自标题缓存，所以
		// 这个纯谓词把它当作参数（见 matchesNavFilter）。一个**未过滤**的列表仍会为每个
		// 被列出的路径读一次元数据缓存：文件��其它名字可搜索、打印在行的 tooltip 上，
		// 随行一同准备而不是在悬停时 —— 而「所有小节」取自**同一次**读。
		//
		// 一行知道的两样东西**不被问及**，且出于同一个理由：两者都不是关于**记录**
		// 的事实，而是关于读者碰巧在哪。坐标（"L412"）是位置数据库的，在笔记被阅读
		// 时被重写；一个**访问**所处的链是从那个坐标读出的，所以它跟着它走。一行
		// 此刻答得出一个标题、下一刻答不出，是一个搜索框不能信赖的行。
		const printed = (i: number): string => {
			const entry = this.opts.entries[i];
			const d = this.opts.describe(i);
			// 文件的其它名字走 `extra` 通道（见 matchesNavFilter）；按**路径**读，
			// 所以一篇笔记的每个落点携带同样的名字 —— 两类都带，因为笔记自称的东西
			// 与它应答的名字一样值得输入。
			const other = entry.kind === 'view'
				? undefined
				: this.opts.otherNames(entry.path, d.name);
			const aka = other ? [other.frontTitle ?? '', ...other.aliases] : [];
			// **跳转的链是记录自己的**：它命名读者挑中的标题，那是该行存在的理由、
			// 也是落点行打印的东西。一次访问什么都没挑 —— 它携带的行号是上次见到时
			// 的笔记的行号，而从它读出的链属于那一分钟、不属于那个地点。
			const chain = entry.kind === 'jump'
				? this.opts.trailFor(entry, d, i).join(' ')
				: '';
			// **打印出来的名字**也进去：一篇读者用它的 frontmatter 标题来称呼的
			// 笔记，就用那个标题来搜索。（文件自己的名字已经在稻草堆里 —— 见
			// listing.ts 的 navSearchText。）
			return `${d.name ?? ''} ${chain} ${aka.join(' ')}`;
		};
		// **这一篇的所有小节**，每行一个，按文档顺序。**只**给文件行走（见 keep）：
		// 落点行已经印着自己那一节的链，再给它全篇的标题只会让「我这一行是哪儿」答不出来。
		// 而文件行只代表笔记，所以「这篇笔记里有个叫『定价』的小节」对它是对**这篇笔记**
		// 的回答，不是对某一处的承诺 —— 那一行在 `landings: 'last' | 'none'` 或只有一处
		// 地点时也仍然只代表笔记。
		//
		// 从不存：现查（`headingsFor`），所以它永远是最新的，而体积与笔记长度无关。
		// 一篇没有标题的笔记、以及无路径的视图，都没有 —— 那是诚实的「没有」而不是空串
		//（空串会让每个查询都命中它）。
		const outlineOf = (i: number): string | undefined => {
			const entry = this.opts.entries[i];
			return entry.kind === 'view' ? undefined : this.outlineText(entry.path);
		};
		// 究竟**什么**可以被列出：一个文件没了的地点会在归组**之前**被丢掉 ——
		// 没有行、没有落点、没有任何「你在这里」会为一个打不开的名字而立。一个
		// **视图**地点被豁免（没有文件会没）。
		const listed = (i: number): boolean => {
			const entry = this.opts.entries[i];
			return entry.kind === 'view' || this.opts.noteExists(entry.path);
		};
		// 每一行拿到的是**它自己那一档**的搜索面：文件行走 `printed` + 全篇小节，
		// 落点行只走 `printed`（它自己那条链已经在里面了）。
		const keep = (i: number) => {
			if (!listed(i))
				return false;
			if (!query)
				return true;
			const entry = this.opts.entries[i];
			const isPlace = entry.kind === 'jump';
			return matchesNavFilter(
				entry, query, printed(i), isPlace ? undefined : outlineOf(i),
			);
		};
		this.groups = groupByFile(
			this.opts.entries,
			this.opts.currentIndex,
			keep,
			// 一行**打印**的行号才是让两步成为一个地点的东西，所以合并与坐标永远
			// 不会不一致（见 groupByFile）。
			i => this.opts.describe(i).lineIndex,
			// 要保持在的次序，当读者正停在列表上时。
			this.opts.order(),
		);
		// **被钉选的行先走**，按读者把它们放进去的次序、而不是地点碰巧所处的次序
		// —— 那个次序是一个时钟，而一个读者布置好的书架不是。其余一切保持它从归组
		// 中出来的次序（新近度，或那个被保持住的次序）。
		this.pullPinnedToTop();
		// 屏幕上两篇笔记共享的名字：在**屏幕上**的行上测量，所以被过滤掉的碰撞
		// 不让任何人付出一个文件夹 —— 且在**打印出来的**名字上测量，它们不总是
		// 文件自己的名字。
		const doubles = duplicateNames(this.groups.map(g => this.printedName(g)));

		this.groups.forEach((group, index) => {
			this.fileRow(group, index, doubles, query);
			for (const i of this.shownLandings(group, index))
				this.placeRow(i, i === group.currentRep);
			// 块以一条**线**结束、而不是一个标题：被钉选的行与任何其它行一样，
			// 而唯一说出哪些行是这块的东西，就是它停在哪里。
			if (this.endsPinnedBlock(index))
				this.opts.list.createDiv({ cls: 'position-restore-nav-pinned-sep' });
		});
		// **布局**对刚画出的行做了什么，在它们有了可被测量的宽度之后回读
		// （见 fitTrails）。
		this.fitTrails();

		// 没什么可画：查询没找到任何步，或历史已没有什么可命名。
		if (!this.refs.length)
			this.opts.list.createDiv({
				cls: 'position-restore-nav-empty',
				text: this.emptyText(query),
			});
		// 光标所在的行回来了（同一个落点，或同一篇笔记）：留下它。元素是新的，
		// 但身份不是。
		if (wasGroup !== undefined) {
			const row = this.refs.find(r => r.group === wasGroup);
			if (row)
				this.choose(row);
		} else if (wasRep >= 0) {
			const row = this.refs.find(r => r.group === undefined && r.rep === wasRep);
			if (row)
				this.choose(row);
			else
				// 落点没了（过滤把它丢了，或设置不再打印该笔记的落点）：
				// 站到它的笔记上。
				this.focusGroupOf(wasRep);
		}
	}

	// 列表在没什么可画时说的话。两种不同的「没什么」，各一条消息，由查询决定；
	// render 是唯一的调用方。
	private emptyText(query: string): string {
		return query ? t('recentFiles.noMatch') : t('recentFiles.empty');
	}

	// 这些组**此刻**被画成的样子，按身份：指针到达时浏览器钉选的东西（见
	// `order` 选项）。向列表询问而不是重算，因为屏幕上的次序是这次重画的 ——
	// 生效的过滤与任何已被保持的次序都进了它里面。
	orderedKeys(): string[] {
		return this.groups.map(g => g.key);
	}

	// 站到一个落点所属的笔记上，当那个落点自己已不在屏幕上时。
	private focusGroupOf(rep: number): void {
		for (let g = 0; g < this.groups.length; g++) {
			if (this.groups[g].indices.includes(rep)) {
				const row = this.refs.find(r => r.group === g);
				if (row)
					this.choose(row);
				return;
			}
		}
	}

	// 一篇笔记的**一个**地点，用来读**名字**与**种类**：一篇笔记里的每个地点对
	// 这两者都作出同样的回答。（不是**点击**去往的那一个 —— 那是 activeRep 的
	// 问题，是另一个问题。）
	private groupRep(group: ReturnType<typeof groupByFile>[number]): number | undefined {
		return group.anchor
			?? group.indices.find(i => i !== group.currentRep)
			?? group.indices[0];
	}

	// 一行**称呼**这篇笔记用什么：笔记拥有它时用读者自己的属性，没有它时用文件的
	// 名字（见 reads.ts 的 titleOf）。整行用**一个**问题 —— 名字单元格、搜索框、
	// 以及区分两篇笔记的文件夹都读这个、别的什么都不读，所以一篇在 frontmatter 里
	// 改了名的笔记在它上面处处是同一个名字。
	private printedName(group: ReturnType<typeof groupByFile>[number]): string {
		const rep = this.groupRep(group);
		const head = rep === undefined ? undefined : this.opts.describe(rep);
		return head?.name ?? displayName(group.path);
	}

	// 一篇笔记的**各个**标题拼成的一段文字，一行一个（`\n` 分隔，因为标题本身可以含任何字符
	// 而这只是一次子串匹配）；没有标题时是 undefined。搜索面与 tooltip 都问它，所以同一帧里
	// 两处读到的是同一份答案。
	private outlineText(path: string): string | undefined {
		const titles = this.opts.headingsFor(path);
		return titles?.length ? titles.map(h => h.heading).join('\n') : undefined;
	}

	// 一篇**笔记**。名字单元格放**名字**（最后一段路径，不带扩展名，见
	// displayName），文件不是 markdown 时放类型**徽标**，以及读者所选条件下的
	// **文件夹**（见 PathDisplayMode）。**时间**立在行的远端、自成一条轨道，所以
	// 时间在整份列表里终止于同一个 x。一个无路径视图行不打印文件夹、也不打印徽标
	// —— 它自己的**图标**取而代之占据那个槽位（见下）。
	private fileRow(
		group: ReturnType<typeof groupByFile>[number],
		index: number,
		doubles: Set<string>,
		// 生效中的查询。这一行用它说出「这篇笔记里被命中的那个小节」（见下面）——
		// 文件行是唯一走全篇标题的那一档（见 render 的 keep），所以也只有它需要这句话。
		query: string,
	): number {
		const rep = this.groupRep(group);
		const repEntry = rep === undefined ? undefined : this.opts.entries[rep];
		const name = this.printedName(group);
		const row = this.opts.list.createDiv({ cls: `${ROW_CLASS} is-file` });
		if (group.current)
			row.addClass('is-current');
		// 钉选块自己的行，为样式表、以及为了一个必须在不去读钉选列表的情况下区分
		// 它们的测试而标记。
		if (index < this.pinnedCount)
			row.addClass('is-pinned');
		// 文件夹打印在**哪一侧**是一个 class，而不是插入次序：DOM 次序是固定的，
		// 好让该行无论怎么画都按一个次序被读，而视觉次序由样式表决定。
		const mode = this.opts.pathDisplay();
		if (mode !== 'after')
			row.addClass('is-path-before');
		row.dataset.group = String(index);
		row.setAttr('id', `${this.opts.listId}-row-g${index}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		// 文件行的身份是**组**：`rep` 保持 undefined（见 activeRep）。
		const ref: RowRef = { el: row, group: index };
		row.addEventListener('click', (ev) => this.onClick(ref, ev));
		row.addEventListener('pointerdown', (ev) => this.onPress(ref, ev));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);

		const file = row.createDiv({ cls: 'nav-row-file' });
		// 名字与它的标记是包裹单元格的**一个**条目，不是两个：与名字是**兄弟**的
		// 标记，是换行最先丢掉的东西 —— 那会把类型打印在它被剪下来的名字下面单独
		// 一行。.nav-row-head 内部不发生换行，所以两者一同断开、由**文件夹**占
		// 第二行。
		const lead = file.createDiv({ cls: 'nav-row-head' });
		lead.createSpan({ text: name, cls: 'nav-row-name' });
		// 类型，在类型值得说的地方：markdown 什么都不打印（见 badgeOf）。
		// 这个 **class** 是 app 自己的标签，所以标记由 app 的样式表（以及某个主题
		// 对它所做的一切）来绘制，而不是由我们自己的一条规则 —— 一个到处都像类型、
		// 唯独这里不像类型的类型，是读者得学两遍的类型。
		const badge = badgeOf(group.path);
		if (badge) {
			lead.createSpan({ text: badge, cls: 'nav-file-tag' });
		} else {
			// 一个**无路径视图**占据这个槽位：它**自己的**图标，即它 tab 标头展示过
			// 的那个（见 viewIcon）。一个没有命名图标的视图改用**文字** —— 一个 app
			// 的构建不认识的图标 id 会画出一个空槽位，那比一个词说得还少。
			if (repEntry?.kind === 'view') {
				const label = t('recentFiles.viewBadge');
				if (repEntry.icon) {
					const mark = lead.createSpan({ cls: 'nav-row-view-icon' });
					setIcon(mark, repEntry.icon);
					mark.setAttr('aria-label', label);
				} else {
					lead.createSpan({ text: label, cls: 'nav-file-tag' });
				}
			}
		}
		// 这篇笔记在哪个文件夹：'smart' 只在名字撞车处打印它。根打印 "/" —— 一个
		// 空 span 看起来会与「一篇只是没被打印文件夹的笔记」一模一样，而那是另一个
		// 事实。**名字被借用**的行改打印文件整条路径（见 pathLabel）：此时名字单元格
		// 唱着别人的词，而该行上没有别的东西会说出它代表哪篇笔记。
		const folder = group.path ? folderOf(group.path) : undefined;
		const printsPath = folder !== undefined && (mode !== 'smart' || doubles.has(name));
		if (printsPath)
			file.createSpan({ text: pathLabel(group.path, name), cls: 'nav-row-path' });
		// 这篇笔记上次被访问是**多久以前**，在读者要求的地方：该组持有的最新时间戳
		// （见 newestStamp）。它立在行自己的、远端的轨道上 —— 放在名字里面只有对一篇
		// 没打印文件夹的行才行得通。
		if (this.opts.rowTime()) {
			const stamp = newestStamp(this.opts.entries, group.indices, group.anchor);
			if (stamp !== undefined) {
				const label = row.createSpan({ text: ageLabel(stamp, Date.now()), cls: 'nav-row-time' });
				// 行的形状跟随已构建出来的标签，所以两者对第二条轨道永远不会不一致。
				row.addClass('is-timed');
				// 确切的时刻住在**时间**上、不是行上：悬停时间说出何时，悬停别的
				// 任何东西说出是哪个文件。
				this.tip.attach(label, { text: new Date(stamp).toLocaleString() });
			}
		}
		// **悬停说的话**：只说该行尚未说过的东西。行**未**打印文件夹时给完整路径
		// （带了文件夹的行已经回答过「这是哪一个」），以及文件的其它名字 —— 它们
		// 不占任何单元格、别处也一概不说。
		const other = group.path ? this.opts.otherNames(group.path, name) : undefined;
		const tip: TipContent = {};
		if (group.path && !printsPath)
			tip.path = group.path;
		// **关于节什么都不说**，连悬停上也不说 —— 除非这一行的点击**就是**去那个落点
		// （下面那个分支）。文件行代表**笔记**：它的点击以普通方式打开文件、由位置数据库
		// 决定读者落在何处，所以这一行并不关于某一个节，而在这里打印一条链会是一个点击
		// 并不兑现的承诺。该行曾代表的东西（当它确实代表过某个地点时）才是下面那些词的
		// 目的。
		// 然后是这些名字：笔记**自称**的东西单列一行，以及它在自己名下所应答的东西
		// —— 别名是 app 的词，而一个归在它名下的 `title` 是在回答一个读者没有问的
		// 问题。
		if (other?.frontTitle)
			tip.frontTitle = `${t('recentFiles.title')} ${other.frontTitle}`;
		if (other?.aliases.length)
			tip.text = `${t('recentFiles.aliases')} ${other.aliases.join(' · ')}`;
		// **这一篇里被查询命中的那个小节**（若有）。它是「搜一个标题词而落点不在那一节」
		// 那一档唯一的自证 —— 命中是**关于这篇笔记**的，而这一行只代表笔记。
		// 只在**文件行**说：落点行印的已经是它自己那一节的链，而它自己的 key 就在 haystack
		// 里，所以它从不靠全篇的标题活过过滤（见 render 的 keep）。
		//
		// 与 `trail` 的去重比的是**最深那一层**，不是整条链：链是「面板设计 › 呈现方案 › 预览」，
		// 命中的标题是「预览」—— 那是同一节，说两遍就是噪音。上面那个分支还没跑，所以这里
		// 拿不到 `trail`；判重交给它（它在链条已定之后再问一次）。
		if (query && group.path) {
			const hit = matchedHeading(this.outlineText(group.path), query);
			if (hit)
				tip.matched = hit;
		}
		// 当这一行**就是**该笔记的某个地点时（一篇只有一个地点的笔记，或设置不打印
		// 落点时的任意笔记）：点击去那里（见 activeRep），所以该行必须能说出那个
		// 位置是什么 —— 包括它**在哪个节**，因为在 `recentFilesLandings: 'last' | 'none'`
		// 两档里落点行根本不画（见 printsLandings），这里就是这条链唯一会出现的地方。
		// 少了它，一次按标题词的搜索会得到一行光秃秃的笔记名，而读者无从知道它为什么
		// 在列表上 —— 命中必须能解释自己。
		if (!this.printsLandings(index)) {
			const at = this.activeRep(ref);
			const spot = this.opts.entries[at];
			if (spot?.kind === 'jump') {
				const chain = this.opts.trailFor(spot, this.opts.describe(at), at);
				if (chain.length) {
					tip.trail = chainText(chain);
					// 这一行所在的那一节**就是**命中的那一个时，`matched` 没有新的话可说 ——
					// 链已经说了，而重复一遍只是噪音。
					if (tip.matched === chain[chain.length - 1])
						tip.matched = undefined;
				}
				const note = this.landingNote(spot, this.opts.describe(at), at);
				if (note)
					tip.note = note;
			}
		}
		if (tip.path || tip.text || tip.frontTitle || tip.trail || tip.matched || tip.note)
			this.tip.attach(row, tip);
		// **行自己的移除**。它在**这里**而不是在行的菜单里，因为那个菜单是 **app**
		// 的文件菜单、只有文件才有这样一个 —— 一个无路径视图行永远得不到它。它的事件
		// 被**停住**：若让按下透过去，去够那个 × 会把该行记为已按下，而点击会打开
		// 笔记。
		const actions = this.actionStrip(row);
		// 菜单控件，在**触摸**设备上：桌面上一记右键升起菜单；这里长按改为武装该行
		// （见 onContextMenu），所以菜单从行本身升起。无路径视图也有一个 —— 它的菜单
		// 是较短的那个（没有文件供 app 述说），但钉选是关于**行**的，而视图的行也是
		// 一行。
		if (this.opts.touch)
			this.menuControl(actions, ref);
		this.forgetControl(actions, t('recentFiles.forget'), () => this.opts.onForget(group.key));
		// 笔记名字上**没有**「你在这里」的圆点：该行带有 `is-current`，而列表处于
		// 新近度次序，所以一个圆点只会重复该行已经说过的东西。圆点保留在持有当前条目
		// 的那个**落点**上 —— 它的笔记旁边还有别的行（见 placeRow）。
		return 1;
	}

	// **一行的远端的那个 ×**。在两种行上以同样的方式构建 —— 手势不该因手指落在哪种
	// 行上而不同；不同的是**什么走掉**（调用方的 `drop`）。永远是**最后**一个控件，
	// 所以一行的远端在每一行上读起来都朝着同一个方向。
	private forgetControl(strip: HTMLElement, label: string, drop: () => void): void {
		const forget = strip.createDiv({ cls: 'nav-row-forget clickable-icon' });
		forget.setAttr('role', 'button');
		// 在 tab 次序之外：这份列表的键盘就是位置与方向键，而一个可被 Tab 聚焦的
		// 按钮会是第二种键盘模型。
		forget.setAttr('tabindex', '-1');
		forget.setAttr('aria-label', label);
		setIcon(forget, 'x');
		// 一根手指在这里按下会花掉这次按下可能仍持有的点击（见 long-press.ts 的
		// release）：一个活得比它自己那次按下更久的声明会吞掉这次轻点。
		forget.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			this.press?.release();
		});
		forget.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// 一次长按在抬起时投递的点击，可能落在这次按下自己放到那根手指下面的
			// 一个控件上；一个在一行上停住的读者并没有要求丢掉它。
			if (this.press?.consumeClick())
				return;
			drop();
		});
	}

	// **该行说不出的东西**，而它恰恰是关于它唯一值得一说的东西。
	//
	// 不是「行号被取走之后笔记被写过」：每次编辑都会触发那个，包括三次节改动之外的
	// 编辑，而一条在半张列表上都显示的行什么也没说。面板会在一行存在之前把能摆正的
	// 东西摆正（见浏览器的 reclaim），而**剩下**的是没人能修的那一种情形：这个落点
	// 命名了一个**标题**，且笔记被写过之后那个标题不在其中了 —— 所以该行代表一个它
	// 再也找不到的位置，并如实说明，而不是默默走去别处。
	//
	// 该行照样**打印**那个标题的词（见浏览器的 trailFor）：那是读者认识那个位置的
	// 凭据，而一行若停止说它们，就没有什么可关于的了。所以这一行是说出两者并非同一
	// 主张的那一半 —— 词是记录的，笔记自己的标题已不再承载它们。
	private landingNote(entry: NavEntry, d: NavEntryDescription, i: number): string | undefined {
		return this.opts.lostLanding(entry, d, i) ? t('recentFiles.lostLanding') : undefined;
	}

	// **一个落点行代表哪些地点**，按身份（见 placeKey）。一行是一条**线**，而列表
	// 把它上落到的每个地点都合并到它上面（见 groupByFile）—— 所以一行可以是两条记录。
	// 只丢掉该行自己的记录会让另一条仍立着，而该行会在重画完成之前回来。通过归组所用
	// 的**同一个** `describe` 匹配，所以两者对一个地点在哪一行永远不会不一致。
	private landingKeys(path: string, line: number | undefined): string[] {
		const entries = this.opts.entries;
		const out: string[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.kind !== 'jump' || entry.path !== path)
				continue;
			if (this.opts.describe(i).lineIndex !== line)
				continue;
			out.push(placeKey(entry));
		}
		return out;
	}

	// 一个落点行的悬停，无论布局对它所做的一切。**一个**地方把它组装起来，因为有两遍
	// 要写它 —— 行自己的绘制与 fit 遍历（见 fitTrails）—— 而一个被写两次的 tooltip
	// 会与自己不一致。
	private placeTip(
		chain: string[], trail: string[], note?: string,
	): TipContent | undefined {
		const tip: TipContent = {};
		if (chain.length > trail.length)
			tip.text = chainText(chain);
		if (note)
			tip.note = note;
		return tip.text !== undefined || tip.note !== undefined
			? tip
			: undefined;
	}

	// 一篇笔记的**一个**地点：它所落到的坐标，以及它所处的节。只在 'all' 下绘制
	// （见 shownLandings）—— 每条不同的行号一行，所以该行是**一个**目的地、没有什么
	// 需要被解释掉。
	private placeRow(i: number, current: boolean): number {
		const entry = this.opts.entries[i];
		const d = this.opts.describe(i);
		const row = this.opts.list.createDiv({ cls: `${ROW_CLASS} is-place` });
		if (current)
			row.addClass('is-current');
		row.dataset.rep = String(i);
		row.setAttr('id', `${this.opts.listId}-row-${i}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		// 一个落点行代表它自己。
		const ref: RowRef = { el: row, rep: i };
		row.addEventListener('click', (ev) => this.onClick(ref, ev));
		row.addEventListener('pointerdown', (ev) => this.onPress(ref, ev));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);

		// 坐标，以及 —— 因为一行是一次**打开** —— 点击所落到的行号：同一个数字，
		// 因为该行恰好代表一个落点。「你在这里」的圆点挂在盒子自己的起点上，所以
		// DOM 次序说出眼睛所见的，而盒子仍旧只持有那个数字（见 styles.css）。
		const pos = row.createSpan({ cls: 'nav-row-pos' });
		if (current)
			pos.createSpan({ text: '●', cls: 'nav-row-here' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		else
			pos.createSpan({ text: '—', cls: 'nav-row-nopos' });

		// 落点所处的节，最深的一到两级（见 rowTrail）：读者凭它认出一个位置，所以
		// 它占该行的富余空间。即使为空也会创建这个单元格，好让它的轨道在每个落点行上
		// 都存在。`chain` 是整体；外层只需一次悬停即可看到（见下面的 tooltip）。
		const chain = this.opts.trailFor(entry, d, i);
		const trail = rowTrail(chain);
		const crumb = row.createSpan({ cls: 'nav-row-trail' });
		// 一个从笔记中**消失**的标题，而该行仍照样打印它的词（见 landingNote）：在
		// **这里**标记而不是只在 tooltip 里，好让一行在被问之前就说出它所代表的东西。
		// 是变淡**且**加删除线，而不只是变淡 —— 变淡读起来像不重要，而这里要说的是：
		// 这些词是记录的，已不再是笔记的。
		if (this.opts.lostLanding(entry, d, i))
			crumb.addClass('is-lost');
		let outer: HTMLElement | undefined;
		for (let k = 0; k < trail.length; k++) {
			const level = crumb.createSpan({
				text: trail[k],
				cls: k === trail.length - 1 ? 'nav-trail-deep' : 'nav-trail-seg',
			});
			// 分隔符**随**它跟随的那一层一起走：单独一个单元格在前一层被挤到没有之后
			// 仍会保留自己的宽度，于是该行继续打印一个左边什么都没有的 "›"。放在层
			// 内部，它就随该层一起消失。
			if (k < trail.length - 1) {
				level.createSpan({ text: '›', cls: 'nav-trail-sep' });
				outer = level;
			}
		}
		// **悬停说的话**：整条链，且只在行尚未打印其全部之处 —— 但「已经打印」既
		// 是链的答案、也同样多的是布局的答案，而一行在任何东西被测量之前就被画出，
		// 所以 fit 遍历在拿走一层时就给该行这个 tooltip（见 fitTrails）。
		const note = this.landingNote(entry, d, i);
		const tip = this.placeTip(chain, trail, note);
		if (tip)
			this.tip.attach(row, tip);
		// ……而该行加入了 fit 遍历将询问的那些行。只打印过一层的行没有什么可让出的。
		if (outer)
			this.trails.push({ el: row, outer, chain, note });
		// **读者上次在这个地点是多久以前** —— 它自己的时间，不是笔记的：一个读者
		// 没再回过的位置保留它挣到的时间，而它所引用的块是在那次访问时捕获的。
		const strip = this.actionStrip(row);
		if (entry.kind !== 'view') {
			if (this.opts.rowTime()) {
				const label = row.createSpan({
					text: ageLabel(entry.t, Date.now()),
					cls: 'nav-row-time',
				});
				row.addClass('is-timed');
				this.tip.attach(label, { text: new Date(entry.t).toLocaleString() });
			}
			// **菜单在前，× 在后** —— 与笔记的行相同的次序：一次学会这个次序的读者
			// 在这里再读一次，而这也是当其中一个缺失时仍然成立的次序（移除是**外面**
			// 那个）。
			if (this.opts.touch)
				this.menuControl(strip, ref);
			this.forgetControl(strip, t('recentFiles.forgetLanding'), () =>
				this.opts.onForgetLanding(this.landingKeys(entry.path, d.lineIndex)));
		}

		return 1;
	}

	// **布局对这些链做了什么，在行出现在屏幕上之后回读一次。** 一行在任何东西被测量
	// 之前就被画出，而样式表只能**挤压**外层：被挤压的一层留下的是一个不命名任何节的
	// **碎片**，而最深层不为它在宽度上买单（见 styles.css）。超过其外层的一半时，这个
	// 碎片就不值它所占的阅读空间，该行便只打印它的最深层（见 dropsOuterLevel）。走掉
	// 的那一层并没有丢失 —— 它成为该行的 tooltip（悬停用该行说不出的东西作答）。
	private fitTrails(): void {
		const rows = this.trails;
		// 一个没有布局的列表 —— 一个测试的 DOM，或一个尚未到达 document 的面板 ——
		// 把每个宽度都报告为 0，于是每条链都会走掉。
		if (!rows.length || !this.opts.list.clientWidth)
			return;
		// 在每一层都回到行上之后再测量：被**上一次**遍历拿走的一层没有可被测量的盒子，
		// 而一个被拖宽的窗格必须能让它回来。对它们全体做**一次**写 ……
		for (const r of rows)
			r.el.removeClass('is-deep-only');
		// ……然后对它们全体做**一次**读，在第一个行被写回之前：一次写会让此后每一次读
		// 都得等待的布局失效。
		const dropped = rows.map(r => dropsOuterLevel(r.outer.clientWidth, r.outer.scrollWidth));
		rows.forEach((r, i) => {
			// 一个 tooltip，按该行**此刻**打印的东西写出：被布局拿走的一层是悬停必须
			// 还回去的一层。
			const tip = this.placeTip(
				r.chain, rowTrail(r.chain, dropped[i] ? 1 : undefined), r.note,
			);
			if (!tip) {
				this.tip.detach(r.el);
				return;
			}
			if (dropped[i])
				r.el.addClass('is-deep-only');
			this.tip.attach(r.el, tip);
		});
	}

	// 在一行上的一次右键 —— 或一根手指的滞留按压，WebView 把它报告为同一个事件并
	// 携带左键的编号 —— 把该行交给 **app**：浏览器在它之上升起 app 自己的文件菜单
	// （见 onContextRow）。右键从不**行走**：第二个按钮做第一个按钮的工作，是一个
	// 白白要学的手势，而在平板上，一次缓慢的轻点会变成一次跳转。
	//
	// 事件除了被使用之外仍被**拒绝**：没有 preventDefault，一次长按还会升起
	// WebView 的选择弹出框，而一个其上压着弹出框的菜单比两者单独都更糟。菜单可以
	// 做什么是 app 的事；这份列表自己什么都不写。
	private onContextMenu(ev: MouseEvent, ref: RowRef): void {
		ev.preventDefault();
		// 在**触摸**设备上，这个事件就是时钟正等待的那个手势，而两者中哪个先到是
		// 平台的事 —— 所以该行也在这里被武装，而武装是幂等的。
		if (this.opts.touch) {
			this.arm(ref, ev.target instanceof Node ? ev.target : ref.el);
			return;
		}
		const rep = this.activeRep(ref);
		if (rep >= 0)
			this.opts.onContextRow(rep, { x: ev.clientX, y: ev.clientY }, ref.group !== undefined);
	}

	// **一根手指停在一行上**，在没有悬停的设备上这就是悬停（见 long-press.ts）：
	// 该行自己作答 —— 它打印不出的词（见 tip.ts 的 speak），以及样式表在行被武装
	// 之前藏起来的那些控件。**一次一行**：武装另一行会在半路上回答第一行。它随按下
	// 结束、而不是随手指结束（见 disarm）：抬起是回答的开头，不是它的结尾。
	private armAt(target: Node): void {
		const ref = this.rowAt(target);
		if (ref)
			this.arm(ref, target);
	}

	private arm(ref: RowRef, target: Node): void {
		if (this.armed && this.armed !== ref)
			this.disarm();
		this.armed = ref;
		ref.el.addClass('is-armed');
		// ……而标记回来了，是再次被标记而不是仅仅被保持：一次长按比一次轻点所得的
		// 标记更长（见 ROW_PRESS_MARK_MS），所以时钟很可能已经把它拿掉了。从这里
		// 往后，结束标记的是读者松开了那一行，而不是某个数字（见 holdMark）。
		this.markPressed(ref.el);
		this.holdMark();
		// 手指抬起时可能仍投递的那次点击属于这个手势，不属于读者（见 onClick）。
		this.press?.markArmed();
		// ……而该行说出它打印不出的东西，向手指落在其上的那个元素发问：一根停在
		// **时间**上的手指在问 "5m" 背后的那一刻，在别处的手指在问这是哪个文件。
		this.tip.speak(target);
	}

	// 按下结束了：读者点了别处、滚动了，或列表在手指下面被重画了。
	private disarm(): void {
		if (!this.armed)
			return;
		this.armed.el.removeClass('is-armed');
		this.armed = undefined;
		this.tip.retract();
		this.unmark();
	}

	// **按下本身，在行上说出来**：一次轻点与一次长按在半秒内看起来完全一样，而在
	// 手机上直到行走完成之前两者都不改变任何东西 —— 长得足以让人怀疑那次轻点有没有
	// 落地、落在哪一行。所以该行在按下被回答之前先回答这次按下。**一次一行**：
	// 一根手指，一次按下。
	//
	// 它在**整次**按下期间都亮着：这里设的时钟是对一根永不起来的手指的**上限**
	// （见 ROW_PRESS_HOLD_MAX_MS），而不是标记消失的时刻 —— 一个走到长按半路就熄灭
	// 的标记会说明该行已不再作答。普通标记由**抬起**结束（见 releaseMark）。
	private markPressed(el: HTMLElement): void {
		if (this.marked && this.marked !== el)
			this.marked.removeClass('is-pressed');
		this.marked = el;
		el.addClass('is-pressed');
		if (this.markFade !== undefined)
			window.clearTimeout(this.markFade);
		this.markFade = window.setTimeout(() => this.unmark(), ROW_PRESS_HOLD_MAX_MS);
	}

	// 按下变成了**武装**：时钟没什么可计时的了 —— 标记现在持续得与武装一样久
	// （见 disarm）。
	private holdMark(): void {
		if (this.markFade === undefined)
			return;
		window.clearTimeout(this.markFade);
		this.markFade = undefined;
	}

	// 标记消失了：那次轻点被回答了，或它是一次滚动，或该行被重画掉了。关于它的一切
	// 都不活过它所放上的那一行。
	private unmark(): void {
		this.holdMark();
		this.marked?.removeClass('is-pressed');
		this.marked = undefined;
	}

	// **手指起来了**：标记多得一拍让人看见它（见 ROW_PRESS_MARK_MS）。**抬起不结束
	// 武装**：读者抬起手指是为了去够武装放到该行上的东西，所以标记留着、时钟被丢掉
	// 而不是重新设置。
	private releaseMark(): void {
		if (this.markFade !== undefined)
			window.clearTimeout(this.markFade);
		if (this.armed) {
			this.markFade = undefined;
			return;
		}
		this.markFade = window.setTimeout(() => this.unmark(), ROW_PRESS_MARK_MS);
	}

	// ……而一个被平台**拿走**的手势（一次滚动的开始、第二根手指）从来不是读者完成的
	// 一次按下，所以标记立刻消失。
	private onLift = (ev: Event): void => {
		if (ev.type === 'pointercancel') {
			this.unmark();
			return;
		}
		this.releaseMark();
	};

	// **行上控件所立的那个条**：在行的流之外、在它的远端（见 styles.css），并在持有
	// 它们之外还要为一件事负责 —— 一次落在它内部但**不在任何一个**控件上的按下是一次
	// **落空**，而落空不行走到任何地方：浏览器点击按下与松开最近的共同祖先，那正是
	// **该行**，所以一个从一个控件上滑开的读者被送去了那篇笔记。一次落空让武装
	// **立着** —— 一个在伸手途中把自己的控件拿走的行会让读者瞄准第二次。
	private actionStrip(host: HTMLElement): HTMLElement {
		const strip = host.createDiv({ cls: 'nav-row-actions' });
		strip.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// ……而按下自己的尾巴也在这里花掉：这个条是控件**出现**的地方，所以也是
			// 一根手指在抬起时可能已经停着的地方。一个活过了它那次按下的声明会吞掉
			// 读者在某个控件上的下一次轻点。
			this.press?.consumeClick();
		});
		return strip;
	}

	// **行的第二个动作**，只在触摸设备上：为行背后的文件**升起 app 的菜单**（桌面上
	// 一记右键升起的同一个菜单），并在顶上放上这个面板的那一个条目。**不是**对那一次
	// 行走的**快捷键**：app 已经有一整个关于该文件的菜单，多一次轻点就买到该快捷键
	// 给不了的一切答案 —— 它确实给的那一个是菜单上的第一个条目。
	private menuControl(host: HTMLElement, ref: RowRef): void {
		const more = host.createDiv({ cls: 'nav-row-menu clickable-icon' });
		more.setAttr('role', 'button');
		// 在 tab 次序之外，与 × 完全一样。
		more.setAttr('tabindex', '-1');
		more.setAttr('aria-label', t('recentFiles.rowMenu'));
		// 三个点：唯一承诺一个**列表**的字形。`file-plus` 读起来像一个新文件，
		// `external-link` 承诺一个外面的地方。
		setIcon(more, 'more-vertical');
		more.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			// 这次按下仍持有的声明，被到达这里的手指花掉（见 long-press.ts 的
			// release）。
			this.press?.release();
			// 这个控件已经升起过的一个菜单：**这次**按下把它收回，而点击绝不能立刻
			// 把它重新升起来。在**这里**问、不在点击时问：到点击时 app 的菜单可能正
			// 立在这个控件上方 —— 当该行在屏幕上坐得太低时，它会被自己的高度向上移。
			this.menuTapCloses = this.opts.takeMenuBack();
		});
		more.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// 按下自己的尾巴，与 × 拒绝它的方式完全一样。
			if (this.press?.consumeClick())
				return;
			// 这次按下收回了一个立着的菜单：不再要另一个。
			if (this.menuTapCloses) {
				this.menuTapCloses = false;
				return;
			}
			const rep = this.activeRep(ref);
			// 一个没有去处的行不升起任何菜单，正如桌面上一记右键在这样一个行上也不会。
			if (rep < 0)
				return;
			// **它在哪里打开**是**控件自己的盒子**，不是轻点的：平台为手指投递的一次
			// 点击可能携带零坐标。
			const box = more.getBoundingClientRect();
			this.opts.onContextRow(
				rep,
				{ x: box.left + box.width / 2, y: box.bottom },
				ref.group !== undefined,
			);
			// **武装留着**：菜单是一个问题、不是一个答案，而菜单关闭时读者想要的仍
			// 可能是该行自己的那些答案。
		});
	}

	// **指针在一行上方**：把它交给 app，每次访问每行**一次**（见 onHoverRow）。
	// 从一次**移动**与一次**到达**都听，因为一只甩到一行上并停住的手可能只投递两者
	// 之一。
	//
	// **决定因素是「指针有没有移动」。** 只要一个元素**来到**指针之下、
	// `pointerover` 就会触发，无论是否移动过：一个热键在鼠标停在屏幕中央时打开的
	// 对话框，会围绕那个指针画出它的行，而每一行都报告一次到达 —— 于是为没有人指向
	// 的笔记请求了页面预览。列表在手下被重画或滚动也是如此。所以一个与上一个坐标
	// 相同的事件，是面板在动，不是手在动。
	//
	// **面板听到的第一个事件不是一次移动**：面板存在之前指针在哪，从来就不是面板
	// 该知道的，所以第一个事件被记录而不是被回答。什么都没损失：一个真想指向某一行
	// 的读者会移动。
	//
	// **每行一次**，不是每个元素一次：越过名字的那次移动、紧随越过徽标的那次，是
	// 同一只手在同一行上。离开**列表**再回来又是一次到达 —— 列表自己的离开会忘记
	// （见构造函数）。
	//
	// **手指不悬停，它按下**：手机上既没有空间、也没有手势，让一根拇指即将轻点的行
	// 旁边有一页。
	private hoverAt(ev: PointerEvent): void {
		if (ev.pointerType === 'touch')
			return;
		// 指针在**哪里**，以及那是否是某个**新**的地方。
		const at = { x: ev.clientX, y: ev.clientY };
		const moved = this.pointerAt !== undefined
			&& (this.pointerAt.x !== at.x || this.pointerAt.y !== at.y);
		this.pointerAt = at;
		if (!moved)
			return;
		const ref = this.rowAt(ev.target);
		if (!ref || ref === this.hovered)
			return;
		this.hovered = ref;
		const rep = this.activeRep(ref);
		// 一个没有去处的行也没有可预览的东西。`file` 说明该行代表**笔记本身**还是它
		// 内部的一个点 —— 两者请 app 以不同方式打开。
		if (rep >= 0)
			this.opts.onHoverRow(rep, ev, ref.el, ref.group !== undefined);
	}

	// 指针所位于的行，从事件所命名的那个元素找到（见 ROW_CLASS）。在列表自己的
	// 背景上时为 undefined。
	private rowAt(target: EventTarget | null): RowRef | undefined {
		const el = target instanceof HTMLElement
			? target.closest<HTMLElement>(`.${ROW_CLASS}`)
			: null;
		return el ? this.refs.find(r => r.el === el) : undefined;
	}

	// 把位置收起来：列表回到它打开时的形状。一个在一次行走之间**保持立着**的 shell
	// 是唯一的调用方（见 view.ts）：那次跳转会重写栈、并首先钉选它落到的笔记，所以
	// 位置据以解析的那个栈索引现在可能命名另一篇笔记。
	collapse(): void {
		this.clearSelection();
	}

	// 行自己的点击打开它所代表的东西（见 activeRep）：笔记的行用笔记自己的记录作答
	// （普通打开），落点行用它自己作答。读者已经在里面的地点**不**被豁免 —— 该行会
	// 再打开它一次，那正是一个 tab 被关掉的读者所来求的。
	//
	// 点击**在哪里**打开，只在它所落在的那个元素仍是列表的一部分时由那个元素决定。
	// 一行的索引是这次重画的，而读者自己的点击会让 store 重排自己 —— 所以一次其元素
	// 已被上次重画丢掉的点击，由读者**按下**的地点来解析（见 onPress / keyOf）。一次
	// 背后没有按下的点击（一个程序性的 `el.click()`、辅助技术）**什么都不**打开：
	// 什么都不打开是这份列表赔得起的那一种失败，打开错误的笔记是它赔不起的那一种。
	private onClick(ref: RowRef, ev: MouseEvent): void {
		// 这一行回答这次点击，无论它的答案最终是什么。
		ev.preventDefault();
		// ……除非它是**一次长按的尾巴**：手指下面那一行正是被那个手势武装的，而在
		// 某一行上停住的读者并没有要求去那里。也要挡在列表自己的监听器之外 —— 否则
		// 它会把武装拿掉。
		if (this.press?.consumeClick()) {
			this.pressed = undefined;
			ev.stopPropagation();
			return;
		}
		// **它在哪里**打开是 app 的决定，不是本模块的：`Keymap.isModEvent` 是有
		// 文档记载的答案，而在这里读 ctrlKey/metaKey 会是第二份更糟的副本、把平台
		// 弄错。app 的 `false` 被归一化为无 target。
		const target = Keymap.isModEvent(ev) || undefined;
		const key = this.pressed;
		this.pressed = undefined;
		const rep = this.refs.includes(ref)
			? this.activeRep(ref)
			: key === undefined ? -1 : this.findByKey(key);
		if (rep >= 0)
			this.opts.onTravel(rep, target);
	}

	// 那些行**没有**回答的点击：浏览器把按下与松开解析到仍在 document 里的最近祖先
	// 上 —— 被按下的那一行在中间被重建掉了。按身份作答，与一个陈旧元素自己的点击
	// 一样（见 onClick）。在行有机会说话**之后**运行（所以有那个检查）：它是这里
	// 唯一可能双重回答一次点击的东西。
	onUnansweredClick(ev: Event): void {
		if (ev.defaultPrevented)
			return;
		const key = this.pressed;
		this.pressed = undefined;
		if (key === undefined)
			return;
		const rep = this.findByKey(key);
		if (rep >= 0)
			this.opts.onTravel(rep, undefined);
	}

	// 读者按下了某一行。**主按钮**按下：按身份（见 keyOf）而非按索引记住**哪个**
	// 地点 —— 索引正是即将不再意味着这个地点的东西。**中键**在**这里**打开：中键
	// 点击被作为 `auxclick` 而非 `click` 投递，preventDefault 把 WebView 的中键
	// 自动滚动挡在外面。**右键**两样都不做：它升起菜单、从不产生点击，所以记录它
	// 会留下一个供**下一次**点击继承的声明。
	private onPress(ref: RowRef, ev: MouseEvent): void {
		if (ev.button === 1) {
			ev.preventDefault();
			const rep = this.activeRep(ref);
			if (rep >= 0)
				this.opts.onTravel(rep, Keymap.isModEvent(ev) || undefined);
			return;
		}
		if (ev.button !== 0)
			return;
		const rep = this.activeRep(ref);
		this.pressed = rep < 0 ? undefined : this.opts.keyOf(rep);
		// 一个代表不了任何东西的行用「没有」来回答一次按下 —— 标记它会是一个不会
		// 到来的行走的承诺。
		if (rep >= 0)
			this.markPressed(ref.el);
	}

	// 持有某个地点的那一行，按身份而不是按索引找到 —— 或当这份列表不再展示它时
	// 返回 -1。一个列表不知何故**两次**持有的地点也被拒绝：身份正是 store 据以对
	// 地点去重的东西（见 places.remember），所以两行携带一个 key 意味着列表分不清
	// 它们。
	private findByKey(key: string): number {
		let found = -1;
		for (const ref of this.refs) {
			const rep = this.activeRep(ref);
			if (rep < 0 || this.opts.keyOf(rep) !== key)
				continue;
			if (found >= 0)
				return -1;
			found = rep;
		}
		return found;
	}

	// 一行将会打开的栈索引，或当它没有时返回 -1。它**绝不能**拒绝的是读者已经站在
	// 里面的那个地点：一行是一次**打开**，不是一个步，而一个点击自己所在行的读者
	// 是在要**文件**回来 —— jumpTo 已经恰好回答了那个（见 NavStack.travelTo）。
	// 拒绝它曾让列表的第一行 —— 当前笔记，被钉选在最前 —— 成为唯一一行什么都不
	// 回答的。
	private targetOf(ref?: RowRef): number {
		const target = ref ?? this.selected;
		if (!target)
			return -1;
		return this.activeRep(target);
	}

	// 行走至一行所代表的落点。公开是因为 Enter 从浏览器的按键处理器进来、没有行
	// 可命名。@returns 是否启动了一次行走。
	travel(ref?: RowRef, target?: PaneTarget): boolean {
		const rep = this.targetOf(ref);
		if (rep < 0)
			return false;
		this.opts.onTravel(rep, target);
		return true;
	}

	// 把列表指向某一行：**那个**位置、高亮，以及被告知给屏幕阅读器的那个选项。
	// `walked` 说明列表是否必须**展示**它到达的那一行（见 reveal），重画则不必。
	private choose(ref: RowRef, walked = false): void {
		if (this.selected?.el !== ref.el) {
			this.selected?.el.removeClass('is-selected');
			this.selected?.el.setAttr('aria-selected', 'false');
		}
		this.selected = ref;
		ref.el.addClass('is-selected');
		ref.el.setAttr('aria-selected', 'true');
		this.reveal(ref.el, walked);
		this.opts.onActiveRow(ref.el.id);
	}

	// 把位置移动到的行放到读者看得见的地方。一次点击欠该行的不多于「可读」—— 视图
	// 属于读者，点击不该硬推它。键盘走到该行时读者的手离鼠标很远，所以在那里列表
	// 必须展示那个**步**（见 revealDelta）。
	private reveal(el: HTMLElement, walked: boolean): void {
		const view = this.opts.list.getBoundingClientRect();
		// 浏览器自己的最小滚动回答了两种不属于「走」的情形：一次点击所落到的行，
		// 以及一个没有布局可测量的列表。当该行在视野内时它什么都不移动。
		if (!walked || view.height <= 0) {
			el.scrollIntoView({ block: 'nearest' });
			return;
		}
		const row = el.getBoundingClientRect();
		const delta = revealDelta(row.top, row.height, view.top, view.height);
		if (delta !== undefined)
			this.opts.list.scrollTop += delta;
	}

	private clearSelection(): void {
		this.selected?.el.removeClass('is-selected');
		this.selected?.el.setAttr('aria-selected', 'false');
		this.selected = undefined;
		this.opts.onActiveRow(undefined);
	}

	// **笔记本身**正立在行上方（app 回答了那次悬停）：把行上的提示从它这里拿开 ——
	// 在行上方打开时，笔记在画完自己之前就已经说了路径、别名与标题。什么都**不**被
	// 记住：一条提示是否可以说话在下次悬停时重新发问（见 tipsQuiet），所以预览一
	// 消失，行就重获它们的嗓音。
	hideTip(): void {
		this.tip.retract();
	}

	// 面板要走了（见 RecentFilesBrowser.destroy）：tooltip 是这个类放到面板自己元素
	// **之外**的唯一一样东西，而那些 document 监听器会活过这个类将要画的每一个
	// 面板。
	destroy(): void {
		this.tip.destroy();
		this.press?.destroy();
		this.unmark();
		this.doc.removeEventListener('pointerup', this.onLift);
		this.doc.removeEventListener('pointercancel', this.onLift);
		this.watched?.disconnect();
	}

	// 键盘的走：向前一行，在任一端环绕。一步是 `walked`，所以列表展示的是那个
	// **步**而不只是那一行（见 reveal）：它是唯一一种若不如此就会让标记停在边缘、
	// 而此后每一步都把笔记滚到它下面的移动。
	move(d: number): void {
		const n = this.refs.length;
		if (n === 0)
			return;
		const at = this.selected ? this.refs.indexOf(this.selected) : -1;
		if (at === -1) {
			this.choose(this.refs[d > 0 ? 0 : n - 1], true);
			return;
		}
		this.choose(this.refs[(at + d + n) % n], true);
	}
}
