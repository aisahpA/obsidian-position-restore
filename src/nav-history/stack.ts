import { App, FileView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, NavEntryState, PluginSettings, DEFAULT_SETTINGS } from '@/types';
import { PositionState } from '@/position/state';
import { RestoreModes } from '@/position/restore/modes';
import { readNavEntryState, normAnchor, shiftNavState, caretAtLine } from '@/position/capture/ephemeral';
import { anchorLineShift, findHeading, decodeAnchor } from '@/position/restore/anchor';
import { delay } from '@/shared/wait';
import {
	blockAnchor, landedLine, NavEntry, NavJump, NavView, NavVisit, NavTeleport, NewNavEntry,
} from '@/nav/entry';
import { NavFunnel, NavFunnelSink, NavLeave, NavRecording } from '@/nav/funnel';
import { PaneTarget } from '@/nav/pane';
import {
	isMainAreaLeaf, viewTypeIsMissing,
	viewIcon as readViewIcon, viewLabel as readViewLabel, viewState as readViewState,
} from '@/shared/leaf';
import { loadNavHistory, persistNavHistory } from './store';

// VSCode 式的「后退 / 前进」，以及一个地点被送进去的打开流水线。
//
// 栈。一个全局的条目数组（NavJump | NavTeleport | NavVisit | NavView）加一个当前
// 下标。每次导航都推进一步；后退/前进移动下标；一次新的跳转会砍掉前面那段——这就是
// 前进后退语义本身，也正是隔壁那块面板不画这份列表的原因。两套位置制度：带 key 的
// 条目（outline:<heading>、anchor linktext）和 teleport 带着跳转的精确落点并留着它
// ——离开的读者把当时站的那一处留成自己的一步（见 pendingFrom），而不是改写落点，
// 因为前进后退必须回到跳转目标本身；不带 key 的 open/activation 条目不带落点——它的
// st 槽在每次离开时刷新（「用户当时到底在哪」）。只有自己没记位置的条目才回落到按文件
// 的位置记录。
//
// 「记录」不在这里。这个类只是记录漏斗上的一个「听众」（见 nav/funnel.ts）：各采集点
// 写下它们看到的，漏斗施加「共用」的闸门并广播，然后这个类再施加它「自己的」——文件
// 标签页之间换焦点值不值得记一步（navHistoryRecordActivation；视图被激活则永远值），
// 一次推断出来的光标跳变值不值得（navHistoryTeleportMinLines）、同一地点的去重，以及
// 上限。漏斗的另一个听众留的是地点列表而不是步；两份列表互不知道对方存在。
//
// 同一标签页内换文件借「原生」的按标签页历史执行（leaf.history + app:go-back/
// go-forward）：那覆盖了 PDF/canvas，以及本插件无法重新定位的每一种非 markdown 视图。
// 对 markdown，原生条目的 eState 只带光标，所以 setViewState 补丁会把本插件保存的
// 位置注进去盖过它（pendingHistoryNav）。跨标签页的遍历会重新激活原来的 leaf；leaf
// 已关则回落到当前活跃的那个。没有路径的视图（关系图谱、Thino 的备忘列表）也记——
// 一次遍历要么找到一个「正显示」该视图的 leaf，要么按读者当时身处其中的那个 state
// 新建一个标签页（NavView.state）。条目的词汇表在 nav/entry.ts。

// 原生的按标签页历史条目（内部结构，无类型）：只声明了校验目标时要读的那几个字段。
interface NativeHistoryEntry {
	state?: { type?: unknown; state?: { file?: unknown } };
}
interface NativeLeafHistory {
	backHistory: NativeHistoryEntry[];
	forwardHistory: NativeHistoryEntry[];
}

// 调完原生 go-back/forward 之后等这么久再校验落点（setViewState 在命令内部是同步的，
// 但给流水线一拍喘息）。
const NATIVE_LANDING_VERIFY_MS = 80;
// 兜底：命令始终没走到 setViewState 时，把 pendingHistoryNav 清掉。
const HISTORY_NAV_TIMEOUT_MS = 1000;

// 一次遍历的落点要压制 cue 多久：跨文件的恢复从防抖的 'file-open' 处理器里跑起来，
// 以落定（SETTLE_HOLD_MAX_MS 1250ms）加上锚点延迟收尾。3s 有富余地盖过它，同时又
// 紧到读者下一次无关的打开能重新显示它自己的 cue。
const NAV_CUE_SUPPRESS_MS = 3000;

// 读者必须离开某一步自己的落点多远，他站的那一处才算「别处」：在这个距离以内，他读的
// 仍是那一步点名的东西，后退把他送回它的目标就是把他送回原处。超出之后，他留下的那
// 一处别无记录——那一步留着它被推入时的落点，而文件里保存的记录不是一步——于是它成了
// 自己的一步，在这里造的步按下后退时照样会动视图。十行不到一屏的三分之一：在一个标题
// 里漂移仍是读它。（它读的是 scroll；推断跳变那个设置读的是光标——同一个数字，不同的
// 尺，只是碰巧相等。）
const DEPARTURE_MIN_LINES = 10;

export class NavStack implements NavFunnelSink {
	private app: App;
	private state: PositionState;
	private modes: RestoreModes;
	// 共用的设置对象（main.ts 赋一次值，设置页就地改）：记录开关和栈上限都保持实时。
	private settings: PluginSettings;
	// 这个栈所听的记录漏斗；一次遍历跑在它的括号里。
	private funnel: NavFunnel;

	entries: NavEntry[] = [];
	// 描述「当前」所在位置的条目的下标；-1 = 空栈。
	index = -1;

	constructor(
		app: App,
		settings: PluginSettings,
		state: PositionState,
		funnel: NavFunnel,
		// 给那些自己没记位置的步用：同一文件内的跳转用它，好让行上那一行仍是它打开的那一行
		// （见 appliedLanding）。跨文件打开不需要这份帮助——打开流水线自己就会回落到记录。
		private savedPosition?: (path: string) => EphemeralState | undefined,
	) {
		this.app = app;
		this.state = state;
		this.settings = settings;
		this.funnel = funnel;
		const restored = loadNavHistory(app);
		this.entries = restored.entries;
		this.index = restored.index;
		// 盘上的存档可能超过当前生效的上限（上限是在设置里调低的、而设置会持久化，栈却只在
		// flush 点才写）。
		this.applyStackCap();
		this.modes = new RestoreModes(settings, state);
	}

	// ===== 漏斗的听者这一侧 =====

	// 一次导航，已经过了漏斗共用的闸门。栈自己的闸门在这里，它们正是漏斗只广播、不裁决的
	// 原因。
	//
	// 「记录标签页切换」答的是「文件」标签页，而条目的「种类」是这个问题的一部分：视图
	// 只能靠激活它的 leaf 进入，所以 cause 为 'tab' 是视图条目能存在的「唯一」途径（见
	// funnel.ts 的 recordOpen——打开补丁只为文件调它）。因此只闸 cause 就等于说「视图
	// 根本不再算步」，而那个设置既没有这个意思、也没法让它有这个意思：视图「就是」读者
	// 去过的一个地方。照原来那样，站在视图里会让下一次后退从最后一个「文件」条目上退，
	// 而不是退回到它——a.md → b.md → 关系图谱，后退落回 a.md，b.md 被跳过了。
	onVisit(recording: NavRecording) {
		if (recording.cause === 'tab' && recording.record.kind !== 'view'
			&& !this.settings.navHistoryRecordActivation)
			return;
		// 阈值本身是在采样器里量的——只有那里知道光标移了多远——所以没到阈值的移动根本走不到
		// 这一行。留在这里，是因为「什么算一步」是这份列表自己的判断，不是漏斗的。
		if (recording.cause === 'teleport' && this.settings.navHistoryTeleportMinLines <= 0)
			return;
		this.pushIfNew(recording.record, recording.forced);
	}

	// 一次位置读取。栈每一次都收——带 key 的条目留着它被推入时的落点，不带 key 的直接被
	// 覆盖——因为它需要「某个」位置可回。（地点列表不是这样：它只收落定那次。见
	// NavLeave。）
	onLeave(leave: NavLeave) {
		if (leave.cause === 'tab') {
			this.refreshTopLeafOnActivation(leave.leaf);
			return;
		}
		this.refreshTop(leave.path, leave.leafId, leave.st, { landing: leave.cause === 'settled' });
	}

	// 一个「已存在」条目的某个细节变清楚了——teleport 的 scroll（跳转事件之后一帧重读），
	// 或者读者离开时某个视图的 state。这里从不出入栈：它们描述的是已经在栈上的一步，而
	// 它们的 `t` 属于当初推入它的那个人。
	onLanded(entry: NewNavEntry) {
		if (entry.kind === 'view') {
			// 读者刚离开的那个视图，重读一遍。它所属的那一步就是栈顶——那「正是」读者刚才在的
			// 地方——刷新的是那次记录带的东西：state，以及它将被列在哪个名字和标记之下。
			if (!entry.state)
				return;
			const top = this.entries[this.index];
			if (!top || top.kind !== 'view' || top.viewType !== entry.viewType
				|| top.leafId !== entry.leafId)
				return;
			top.state = entry.state;
			// 缺失只表示这次视图什么都没说，不表示它没有名字：读失败时已记下的名字留着不动。
			if (entry.label !== undefined)
				top.label = entry.label;
			if (entry.icon !== undefined)
				top.icon = entry.icon;
			return;
		}
		if (entry.kind !== 'teleport' || !entry.st)
			return;
		const top = this.entries[this.index];
		if (!top || top.kind !== 'teleport' || top.path !== entry.path
			|| top.leafId !== entry.leafId || top.line !== entry.line)
			return;
		top.st = entry.st;
	}

	// （没有 onHere：`index` 上那一步「就是」这个类的「此处」。它自己的指针移动由
	// navigate/travelTo 广播给别的听众。）

	// 当前生效的栈上限，带一个「根本不是数字」时的兜底（否则手工改过的 data.json 会让每个
	// `length > cap` 比较都为假、上限彻底失效）。
	stackCap(): number {
		const cap = Math.floor(this.settings.navHistoryCap);
		return Number.isFinite(cap) ? Math.max(1, cap) : DEFAULT_SETTINGS.navHistoryCap;
	}

	// 「立刻」裁到上限。由 push、由设置页在上限变化时（否则裁剪要等到下一次导航，一次丢
	// 一大块）、以及加载时各调一次。丢弃是「静默」的：只要一次会话够长，栈就常驻在上限上，
	// 所以任何汇报它们的东西，不是一直挂在屏幕上，就是永远看不见。
	// @returns 丢掉了多少条目。
	applyStackCap(): number {
		const cap = this.stackCap();
		if (this.entries.length <= cap)
			return 0;
		const removed = this.entries.length - cap;
		this.entries.splice(0, removed);
		// 指针原本落在被丢掉的那条上（上限降到了当前深度以下）时，它停在最旧的那个幸存者上，
		// 而不是变成负数，这样前进仍能在剩下的里走，而不是遍历整个瘫痪。
		this.index = this.entries.length === 0 ? -1 : Math.max(0, this.index - removed);
		return removed;
	}

	// 栈仍然点名的每一个不同文件路径（视图条目不点名）。调用方拿它配一次仓库检查——启动时
	// 清扫 Obsidian 关着那段时间被删掉的文件（见 PathBookkeeper.sweepMissingHistory）。
	knownPaths(): string[] {
		const seen = new Set<string>();
		for (const entry of this.entries)
			if (entry.kind !== 'view')
				seen.add(entry.path);
		return Array.from(seen);
	}

	// ===== 记录（这个类自己的判断，施加在漏斗的记录上） =====

	// 先做同一地点去重，再入栈。去重是关于「栈」的问题——「栈顶那一步变了吗」——而读者
	// 去过某处是关于地点列表的问题，漏斗在这之前已经问过了。
	private pushIfNew(entry: NewNavEntry, force?: boolean) {
		// 放在去重之前：第二次点同一个标题看起来像「已经是栈顶那一步」，而读者其实在它下面
		// 200 行，所以那次离开必须先站到栈上，这一次点击才可能算一步。
		this.flushDeparture();
		const top = this.entries[this.index];
		// 同一地点 = 同一个标签页里的同一个文件（+ 同一个 jump key）。同一个文件的两个标签页
		// 各自持有独立的位置，所以在它们之间切 leaf 是一条真条目（VSCode 也记编辑器身份，连
		// 它在哪个分组都算）。
		if (!force && top && this.sameLocation(top, entry))
			return;
		this.push(entry);
	}

	// 大纲跳转的 key 比较时归一化：条目上的 key 可能已被升级成标题的源码行写法
	// （"outline:## T"），而再点一次记的是渲染后的文本（"outline:T"）——`#` 在
	// normAnchor 里会被剥掉，所以两者是同一次跳转。
	private sameLocation(top: NavEntry, entry: NewNavEntry): boolean {
		if (top.leafId !== entry.leafId)
			return false;
		switch (entry.kind) {
			case 'view':
				return top.kind === 'view' && top.viewType === entry.viewType;
			case 'jump':
				return top.kind === 'jump' && top.path === entry.path
					&& (top.key === entry.key
						|| (top.key.startsWith('outline:') && entry.key.startsWith('outline:')
							&& normAnchor(top.key.slice('outline:'.length)) === normAnchor(entry.key.slice('outline:'.length))));
			case 'teleport':
				return top.kind === 'teleport' && top.path === entry.path && top.line === entry.line;
			case 'visit':
				return top.kind !== 'view' && top.path === entry.path;
		}
	}

	// 唯一的入口漏斗：每次入栈都在这里盖章，所以活着的条目上 `t` 绝不会缺。（行进带过来的
	// 副本自带地点自己的戳，会「重新」盖一次——行进是一个新的导航时刻，不是旧时刻的重放。）
	private push(entry: NewNavEntry) {
		// 一次新的跳转丢弃前面那段（VSCode 语义）。
		this.entries.length = this.index + 1;
		this.entries.push({ ...entry, t: Date.now() });
		// 刚推入的条目在施加上限「之前」就是当前位置，所以裁剪是相对刚立起来的栈顶来挪指针的。
		this.index = this.entries.length - 1;
		this.applyStackCap();
	}

	// 「离开时更新」：从跳转正要离开的那个视图，刷新栈顶条目的位置。一个「点名了」某处的
	// 步把那处留作自己的 `st`——一次离开不许用读者漂到的位置覆盖它——漂移进 `leftAt`，等
	// 一次导航把读者带离它时，它就成了自己的一步。不带 key 的条目每次离开都被覆盖。用
	// path+leaf 把门。
	private refreshTop(
		path: string,
		leafId: string,
		st: NavEntryState,
		opts: { landing?: boolean; traversal?: boolean } = {},
	) {
		const top = this.entries[this.index];
		if (!top || top.kind === 'view' || top.path !== path || top.leafId !== leafId)
			return;
		if (top.kind === 'jump' || top.kind === 'teleport') {
			if (opts.landing) {
				// 这一步许下的东西，它一到就赢——包括在一次离开已经把这个步回填过之后（读者在它落定
				// 之前就离开的那次跳转）。
				top.st = st;
				if (top.kind === 'jump') {
					this.upgradeKeyLine(top, st);
					// 地点只会被告知真正的「落地」，绝不包括给栈回填的那次离开读取：栈要的只是「某个」可回
					// 的位置，而地点的行「许诺」的是跳转自己那一处——点了一个标题、读下去、然后切走文件的
					// 读者，不该发现那个标题记下的地点被搬到了他离开时待的地方。
					this.funnel.landing(top);
				}
				return;
			}
			if (!top.st) {
				top.st = st;
				if (top.kind === 'jump')
					this.upgradeKeyLine(top, st);
				return;
			}
			// 后退/前进不算离开：那是这个栈在走自己的步，而读者再按一次前进就走回这一步上。记下
			// 漂移会把这次返回变成它自己的一步、把落点埋在下面——前进必须落在那个标题上，那是别的
			// 什么也占不住的一处。
			if (opts.traversal) {
				delete top.leftAt;
				return;
			}
			// 它已经带着自己的落点，所以这次读取是读者站在这一步没点名的地方：覆盖会丢掉落点，
			// 丢掉又会失去他在哪。一次从这一步出发的导航会把它变成自己的一步。
			top.leftAt = st;
			return;
		}
		top.st = st;
	}

	// 一次读取是不是「读者站在这一步点名的落点以外的地方」。两边都是「视口」顶行，因为步
	// 是按 scroll 恢复的：得动的是 scroll。标题自己那一行不是基准——视口不一定够得着它
	// （笔记末尾附近的标题），拿它当基准会让满屏的漂移看着像根本没动。光标也不读：在一屏
	// 之内挪它，视图纹丝不动，用它造的步按下去会什么都拿不出来。
	private leftBehind(step: NavJump | NavTeleport, st: NavEntryState): boolean {
		const at = st.scroll;
		const promised = step.st?.scroll;
		return at !== undefined && promised !== undefined
			&& Math.abs(at - promised) > DEPARTURE_MIN_LINES;
	}

	// 离开当前那一步的漂移，作为自己的一步——在一次导航把读者带离他站的那一处时推入，绝不
	// 从一次离开里推：一次离开也发生在这个栈自己的遍历之前，那里推进去会在后退还没动之前
	// 就砍掉前进的那段。它离开的那一步留着它的落点——漂移是它旁边的一步，不是对它的改写
	// ——而漂移是一次性的：回到那一步、再离开一次的读者站在新地方，旧的那处不该被给出两次。
	private flushDeparture() {
		const top = this.entries[this.index];
		if (!top || (top.kind !== 'jump' && top.kind !== 'teleport') || !top.leftAt)
			return;
		const st = top.leftAt;
		if (!this.leftBehind(top, st))
			return;
		delete top.leftAt;
		this.push({ kind: 'visit', path: top.path, leafId: top.leafId, st });
	}

	// 把正要切走的那个文件的位置，采到栈顶条目上（描述它的那一条）。没有 leaf 持有栈顶
	// 条目时什么都不做。
	private refreshTopLeafOnActivation(next: WorkspaceLeaf | null) {
		if (!next || !this.funnel.isRecording())
			return;
		// 侧栏（或任何非主区域的窗格）拿到焦点不是历史会记的标签页切换——漏斗的 activation
		// 自己就挡掉那些 leaf——所以正要离开的条目哪儿也不去。在这里刷新它还会「通知」屏幕上
		// 每一块面板，于是点进常驻的最近文件面板会在读者的按压还在途中的时候重建它的行，把
		// 这次点击弄丢了。
		if (!isMainAreaLeaf(this.app, next))
			return;
		const top = this.entries[this.index];
		if (!top)
			return;
		// 视图步在找不到自己那个 leaf 时，回落到第一个「正显示」它那种类型的主区域 leaf，
		// 因为视图条目的 leafId 从不被写回（见 execute）：那个地点活得比它来的标签页更久。
		const leaf = this.findLeafById(top.leafId)
			?? (top.kind === 'view' ? this.findLeafShowing(top.viewType) : undefined);
		if (!leaf || leaf === next)
			return;
		// 视图步自己的 state，在这里读它的理由和读文件位置一样：正要离开的那个 leaf 还持有它，
		// 而离开正是它停止变化的那一刻。这一点让记下的视图是一个「地方」而不是一种「类型」，
		// 并且只在标签页活着的期间读得到。
		//
		// 名字和图标一并重读，理由相同：一个在读者坐进去期间给自己改名的视图，否则会一直以他
		// 「进来时」的名字被列出。内置浏览器就是显眼的例子——它的标签页标题就是网页标题，所以
		// 逛三个页面之后，那一行还叫第一个。
		//
		// 该 leaf 不再「显示」这个视图时跳过（在关系图谱里点一个节点会在同一个标签页把文件开在
		// 图谱之上），它处于「deferred」（后台卸载）时也跳过：两种情况下都会用错的或空的快照
		// 换掉真快照。
		if (top.kind === 'view') {
			if (leaf.isDeferred || leaf.view.getViewType() !== top.viewType)
				return;
			const state = readViewState(leaf.view);
			// 广播而不是直接赋值：这是两个听者都留的事实，栈会像地点列表一样经由 onLanded 听回来
			// ——只有一条写入路径，两者不会漂移。刻意用 state 把门：报不出 state 的视图，是连身份
			// 都轮不到本插件说三道四的那种（全局关系图谱只给自己一个名字，别的什么都不给）。
			if (state)
				this.funnel.landing({
					kind: 'view', leafId: top.leafId, viewType: top.viewType, state,
					label: readViewLabel(leaf.view), icon: readViewIcon(leaf.view),
				});
			return;
		}
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file && view.file.path === top.path) {
			const st = readNavEntryState(view);
			if (st)
				this.refreshTop(top.path, top.leafId, st);
		}
	}

	// 用 metadataCache 里锚点的「记录时」行号升级一次带 key 的跳转——结构重锚的权威基准
	// （见 NavJump.keyLine）。在第一次落点回填时跑；st 的视图行只在同文标题之间打破平局。
	//   outline: key  → 用缓存里的权威来源重建 key（"outline:## T"：# 的个数 = 绝对层级，
	//     其余 = HeadingCache.heading 原文），外加 keyLine。
	//   #slug key     → 只有 keyLine（slug 形式的 key 本来就能解析）。
	//   ^block key    → 什么都不做：块的行号没法跟它的落点几何挂钩。
	// 缓存里没有标题对得上（锚点被改名/删掉）→ 不动它，重映射的兜底照常可用。
	private upgradeKeyLine(top: NavJump, st: NavEntryState) {
		const file = this.app.vault.getAbstractFileByPath(top.path);
		const cache = file instanceof TFile ? this.app.metadataCache.getFileCache(file) : null;
		const nearLine = st.scroll ?? st.cursor?.from.line;
		if (top.key.startsWith('outline:')) {
			const hit = findHeading(cache, top.key.slice('outline:'.length), nearLine);
			if (!hit)
				return;
			top.key = `outline:${'#'.repeat(hit.level)} ${hit.heading}`;
			top.keyLine = hit.line;
			return;
		}
		// 块引用：id 精确点名那个块（见 nav/entry.ts 的 blockAnchor），所以它的行号就是块自己
		// 的行号，步「可以」靠它重锚。先于标题那一支问，因为 `note.md#^id` 也带着一个 `#`——
		// 当成标题 slug 去读会什么都找不到，于是每一个块步都走了文本片段重映射那条路。
		const block = blockAnchor(top.key);
		if (block !== undefined) {
			const at = cache?.blocks?.[block]?.position.start.line;
			if (at !== undefined)
				top.keyLine = at;
			return;
		}
		const hash = top.key.indexOf('#');
		if (hash === -1)
			return;
		const hit = findHeading(cache, decodeAnchor(top.key.slice(hash + 1)), nearLine);
		if (hit)
			top.keyLine = hit.line;
	}

	// ===== 遍历 =====

	// 边界检查：后退需要下面有一步，前进需要上面有一步。
	private canStep(dir: -1 | 1): boolean {
		return dir < 0 ? this.index > 0 : this.index >= 0 && this.index < this.entries.length - 1;
	}

	// 一次遍历会从哪「开始」：活跃的文件视图，或者——侧栏拿着焦点时——读者待过的最后一个
	// 文件标签页。
	private whereToStart(): boolean {
		return !!this.app.workspace.getActiveViewOfType(FileView)?.file || !!this.startLeaf();
	}

	// 这个方向上「有没有步可走」——「按钮」置灰时问的就是这个，面板的箭头也问它（见
	// PositionManager.recentFilesArrows）。它「不是」命令可用性问的问题：我们自己一次正在
	// 途中的遍历会让命令在那一刻不可用，却不会让栈里任何一步消失——而两个在一次遍历期间
	// 置灰的箭头，是读者会当成坏了的一对。宁可一个置灰按钮答「还没轮到」，也不要两个答
	// 「永远不行」。
	hasStep(dir: -1 | 1): boolean {
		return this.canStep(dir) && this.whereToStart();
	}

	// 命令可用性（checkCallback）。活跃的文件视图是常规起点；侧栏拿焦点时，遍历仍能从最后
	// 一个文件标签页起步（见 startLeaf）。已经在途中的遍历答「不可用」：在第一次里再起
	// 第二次会被漏斗拒掉（见它的 runBracketed），所以一个把自己摆出来的命令，会是一个点了
	// 没反应的命令。
	canNavigate(dir: -1 | 1): boolean {
		if (this.funnel.isMoving())
			return false;
		return this.hasStep(dir);
	}

	// 没有活跃文件视图时（侧栏拿着焦点），遍历从栈当前条目那个 leaf 起步——用户待过的最后
	// 一个文件标签页。
	private startLeaf(): WorkspaceLeaf | undefined {
		return this.findLeafById(this.entries[this.index]?.leafId)
			?? this.app.workspace.getMostRecentLeaf() ?? undefined;
	}

	async navigate(dir: -1 | 1): Promise<void> {
		if (!this.canStep(dir))
			return;
		await this.funnel.runBracketed(() => this.traverse(dir));
		// 就算一步都没推，指针也动了（一次只重新激活某个标签页的遍历），「你在这里」跟着它
		// 一起动。
		this.funnel.here(this.entries[this.index]);
	}

	// 时间旅行到一个「地点」（最近文件列表）。地点是一次明确的导航，所以它得到和后退/前进
	// 一步同样的待遇：它被重新推到栈顶（从读者所在处分叉），被它挤下去的那个条目留在下面
	// 一步——后退回到出发地。
	//
	// 读者已经站在的那个地点不再推一次：遍历的栈顶「就是」那个位置，第二次按下要做的是重新
	// 落上去，不是长出一条重复的步。
	async travelTo(place: NavEntry, target?: PaneTarget): Promise<void> {
		if (place.kind === 'teleport')
			return;
		await this.funnel.runBracketed(async () => {
			// 先采下我们要离开的地方，好让下面那个条目留住后来一次后退必须回到的精确位置。
			this.refreshTopFromActiveView();
			// 栈已判定这是真导航，所以它把记录本身交给漏斗：共用闸门是给「采集点」用的，在一次
			// 遍历内部它会（正确地）把一切都拒掉。
			this.funnel.visit({
				record: { ...place },
				cause: place.kind === 'jump' ? 'jump' : 'open',
			});
			// 地点不知道任何栈位置，所以两个方向都给它试（见 execute 的 `tryBoth`）。
			await this.execute(this.entries[this.index], -1, true, target);
		});
		this.funnel.here(this.entries[this.index]);
	}

	// 「文件」地点：像文件浏览器那样打开它，不注入落点。面板的文件行本身不带位置（见
	// recent-files/places.ts），所以落在哪里由位置数据库决定——正是这一点让「从面板打开」
	// 和「从文件浏览器打开」是同一个动作，连排除规则都一样。
	async openFilePlain(path: string, leafId: string, target?: PaneTarget): Promise<void> {
		// 给了 target 时，文件开在「旁边一个新标签页」里，而不是它所处的那个 leaf——让读者的
		// 地方原样留着，这正是那个修饰键要的全部。其余是同一个动作。
		if (target) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile))
				return;
			const opened = this.app.workspace.getLeaf(target);
			await opened.openFile(file);
			this.app.workspace.setActiveLeaf(opened, { focus: true });
			return;
		}
		const leaf = this.findLeafById(leafId)
			?? this.app.workspace.getMostRecentLeaf() ?? undefined;
		if (!leaf)
			return;
		if (this.app.workspace.getActiveViewOfType(FileView)?.leaf !== leaf)
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const current = (leaf.view as FileView | undefined)?.file;
		if (current?.path === path)
			return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile)
			await leaf.openFile(file);
	}

	// 没有路径的视图地点：在已经持有它的 leaf 里显示，处处都没有时开一个新标签页——走
	// execute() 的视图分支，不需要栈提供任何东西。地点是整份来的，所以回来的视图就是读者
	// 当时待的那个（见 NavView.state）。
	async openViewPlace(place: NavEntry, target?: PaneTarget): Promise<void> {
		if (place.kind !== 'view')
			return;
		await this.execute(place, 1, false, target);
	}

	async traverse(dir: -1 | 1): Promise<void> {
		let activeView = this.app.workspace.getActiveViewOfType(FileView);
		if (!activeView?.file) {
			// 当前条目是视图条目（关系图谱正活跃）：当前位置就在屏幕上，所以遍历直接从它开始走。
			const cur = this.entries[this.index];
			if (!cur || cur.kind === 'view') {
				this.index += dir;
				await this.execute(this.entries[this.index], dir);
				return;
			}
			// 侧栏（文件浏览器、搜索、大纲……）或空的「新标签页」可以在没有活跃文件视图的情况下
			// 拿着焦点。栈当前条目仍描述着最后一个文件标签页——重新激活它的 leaf，好让遍历从用户
			// 真正待过的地方起步。
			const startLeaf = this.startLeaf();
			if (!startLeaf)
				return;
			this.app.workspace.setActiveLeaf(startLeaf, { focus: true });
			activeView = this.app.workspace.getActiveViewOfType(FileView);
			if (!activeView?.file) {
				// 只剩「新标签页」一种可能：当前条目的标签页被关了——一次没被记录的「跳出」栈，所以
				// 历史指针仍停在那一条上。第一次跳要重新落上去（下标不变、不跳过一个——后退前进都
				// 一样）；从下一次按下起，遍历走 index±1。
				await this.execute(this.entries[this.index], dir);
				return;
			}
		}

		this.refreshTopFromActiveView({ traversal: true });

		this.index += dir;
		await this.execute(this.entries[this.index], dir);
	}

	// 遍历/跳转离开时的刷新：栈顶条目拿到精确的当前位置，好让一次返回落在用户真正待过的
	// 地方。工作区的活跃视图不是它时，视图取自条目「自己」那个 leaf：侧栏拿着焦点——常驻
	// 面板也算——根本不会留下活跃的 FileView，而那个条目仍然描述着它背后的文件标签页。
	private refreshTopFromActiveView(opts: { traversal?: boolean } = {}) {
		const cur = this.entries[this.index];
		if (!cur || cur.kind === 'view')
			return;
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		const view = activeView?.file && cur.leafId === this.state.leafId(activeView.leaf)
			? activeView
			: this.findLeafById(cur.leafId)?.view;
		if (view instanceof MarkdownView && view.file?.path === cur.path) {
			const st = readNavEntryState(view);
			if (st) this.refreshTop(cur.path, cur.leafId, st, opts);
		}
	}

	private async execute(target: NavEntry, dir: -1 | 1, tryBoth = false, modTarget?: PaneTarget) {
		// 为「整次」执行武装，而不是为其中某一支：每一支都要落到这个条目的那一处，无论最后是
		// 哪一支应答。
		this.armLandingMark(target);
		// 按住了修饰键：地点开在 app 为那个 target 选的 leaf 里，而不是条目来的那个 leaf——这
		// 与下面所有内容都是另一个问题，那些存在的意义是「回到」一个地点。「落点」不在区别
		// 之内：openInLeaf 武装的是遍历用的同一个即时落点标记。
		if (modTarget) {
			const leaf = this.app.workspace.getLeaf(modTarget);
			if (target.kind === 'view') {
				// 没有路径的视图没有文件可开：得让 leaf「显示」它，而 `active` 才把它带到前台。它按
				// 读者离开时的样子显示（见 NavView.state）；自己没 state 的视图——全局关系图谱——就用
				// 空对象要它，app 自己的 `graph:open` 传的也是这个。
				await leaf.setViewState({ type: target.viewType, state: target.state ?? {}, active: true });
				return;
			}
			await this.openInLeaf(leaf, target);
			return;
		}
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		// 哪儿都没有文件视图（只剩新标签页）：回落到最后一个主区域 leaf，好让遍历仍能在那里
		// 打开它的目标。
		const activeLeaf = activeView?.leaf
			?? this.app.workspace.getMostRecentLeaf() ?? undefined;
		const targetLeaf = this.findLeafById(target.leafId);

		// 视图条目（一个视图标签页）：到达它意味着某个 leaf 必须「显示」那个视图。「哪一个」
		// leaf，按优先级：
		//
		//   1. 条目来的那一个，如果它还在——被换掉时重新把视图立回来（在图谱里点一个节点会在
		//      同一个 leaf 把文件开在图谱之上，或者 graph:open 复用了那个标签页）；
		//   2. 任何「别的」已经在显示那个视图的 leaf。一个视图地点由它的「类型」标识（见
		//      entry.ts 的 navGroupKey），而条目点名的是它几个标签页里最后被激活的那个，所以
		//      读者的第二个 Thino 标签页同样是他去过的那个地点；
		//   3. 「新标签页」，因为记下的地点活得比它发生时的那个标签页更久。没有这一条，条目的
		//      leaf 一旦被关——视图标签页最平常的结局——它对点击就答不出任何东西。视图在那里
		//      「按类型重建」，带上读者在它里面时的那个 state，正是这一点把局部关系图谱的笔记、
		//      或插件视图的筛选条件，带过了标签页被关的那一关。
		//
		// 条目自己的 leafId 原样保留：它只被用来找一个 leaf，而上面的查找一旦落空就改按「类型」
		// 答（往地点列表自己的对象里写，会变成一种外来的偏好）。
		//
		// 而且一步是落「在它的 state 里」，不是只落在视图前面：活着的 leaf 不记得读者把那个
		// 地方留在哪。局部关系图谱就是例子——它跟的是「活跃文件」，所以读了另外两篇笔记之后
		// 再激活它的标签页，画出来的是「那两篇」的邻域。所以带 state 的步要把 state 放回去
		// （见 relandViewState），而「这个 leaf 已经在显示这个视图」不是它正显示着「这一个」
		// 的证据。
		if (target.kind === 'view') {
			const leaf = targetLeaf ?? this.findLeafShowing(target.viewType);
			if (!leaf) {
				await this.showViewInNewTab(target.viewType, target.state);
				return;
			}
			if (leaf !== activeLeaf)
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
			if (leaf.isDeferred)
				await leaf.loadIfDeferred();
			const viewType = (leaf.view as { getViewType?: () => string } | undefined)?.getViewType?.();
			if (viewType === target.viewType) {
				await this.relandViewState(leaf, target);
				return;
			}
			// 视图被换掉了：原生的按标签页历史下一条「就是」这个视图时，借它走（让两个栈保持一致），
			// 否则直接重新立起来。
			if (leaf === activeLeaf && await this.delegateNative(dir, leaf, undefined, target.viewType))
				return;
			await (leaf as unknown as {
				setViewState(vs: { type: string; state: object; active: boolean }): Promise<void>;
			}).setViewState({ type: target.viewType, state: target.state ?? {}, active: true });
			return;
		}

		// 跨标签页：重新激活原来的 leaf。leaf 已关则回落到当前活跃的那个。
		if (targetLeaf && targetLeaf !== activeLeaf) {
			await this.openInLeaf(targetLeaf, target);
			return;
		}

		const leaf = targetLeaf ?? activeLeaf;
		if (!leaf)
			return;
		// 条目自己的 leaf 没了、回落到了另一个 leaf：把它重新指向它的文件现在所在的那个 leaf。
		// 打开之后那条遍历后的 activation 记录带的是「那个」leaf id——对着过期的那个，它会错过
		// 本条目的去重、推出一条幽灵重复，把真正的前进段砍掉。
		if (!targetLeaf)
			target.leafId = this.state.leafId(leaf);
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const curFile = (leaf.view as FileView | undefined)?.file;

		if (curFile?.path === target.path) {
			// 文件内跳转：不打开，直接施加条目的位置。要施加到的是「这个」leaf 的视图，不是工作区
			// 「活跃」的视图：侧栏拿着焦点时根本没有活跃的文件视图，而那个 leaf 仍然显示着文件——
			// 可当时这一支什么都没施加，所以跳到已经在屏幕上的笔记里某个地方等于没反应。（「相邻」
			// 那种情况走 traverse()，它会先把文件 leaf 重新激活，所以才正常。）
			// 只有 markdown 有位置；同一文件的非 markdown 条目什么都不做。
			const view = leaf.view;
			if (view instanceof MarkdownView)
				await this.applyLanding(view, target);
			return;
		}

		// 同一标签页内换文件：原生按标签页历史的下一条匹配时借它走（让 PDF/canvas 保持原生），
		// 否则直接打开。
		const landing = this.landingFor(target);
		if (await this.delegateNative(dir, leaf, target.path, undefined, landing))
			return;
		// 地点的行进不知道栈位置，所以它的方向是猜的：把另一个方向也试一次。delegateNative
		// 失败没有副作用，所以代价是一次比较。
		if (tryBoth && await this.delegateNative(dir === 1 ? -1 : 1, leaf, target.path, undefined, landing))
			return;
		await this.openInLeaf(leaf, target);
	}

	// 把一步记下的视图 state 放回「正显示着」它的那个 leaf——视图遍历里「落到这一步说的
	// 那个地方」的那一半，也是步之所以要带 state 的原因（见 NavView.state）。
	//
	// 只有「动过」的 state 才重新立：先读一遍 leaf 自己的 state，能让每一次普通遍历省下一次
	// 多余的 setViewState——而对一个它本来就处在的 state，视图可能以重建自己来回应（图谱
	// 重画、搜索重跑）。步没带 state、或 leaf 的视图报不出 state 时，什么都不用做。
	private async relandViewState(leaf: WorkspaceLeaf, target: NavView): Promise<void> {
		if (!target.state)
			return;
		const live = readViewState(leaf.view);
		if (live && JSON.stringify(live) === JSON.stringify(target.state))
			return;
		await (leaf as unknown as {
			setViewState(vs: { type: string; state: object; active: boolean }): Promise<void>;
		}).setViewState({ type: target.viewType, state: target.state, active: true });
	}

	// 把一个目标的落点施加到「已经」显示着该文件的视图上——execute() 和 openInLeaf() 都以
	// 这次文件内跳转收尾。先做结构重锚（条目上的行号早于之后任何编辑），再跑共用的施加。
	private async applyLanding(view: MarkdownView, target: NavJump | NavVisit | NavTeleport) {
		const st = this.appliedLanding(target);
		if (!st)
			return;
		const isCurrent = () => view.file?.path === target.path;
		this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
		await this.modes.historyJumpApply(view, st, isCurrent, this.resolveAnchorShift(target));
	}

	// 让笔记「标出」这次落点讲的那一行：点明一行的条目就是 app 自己的大纲动作，而它自己的
	// 大纲会标出它把读者带到的那个标题。跟落点一起重锚（见 resolveAnchorShift），所以之后
	// 挪过位置的标题，标的是它现在站的地方、不是记录里说的那个。会过期：一次从未落地的打开
	// 所要求的行，不许在后来某次恢复里亮起来。
	private armLandingMark(target: NavEntry) {
		if (target.kind !== 'jump' || !target.st)
			return;
		const line = landedLine(target);
		const shift = this.resolveAnchorShift(target);
		this.state.pendingLineFlash = line === undefined
			? undefined
			: { path: target.path, line: Math.max(0, line + (shift ?? 0)), at: Date.now() };
	}

	// 一次「同一文件」跳转所施加的落点。条目自己记的排第一（见 landingOf）；自己没记的步
	// 回落到文件保存的记录——正是面板借来那一行行号的那个来源——所以行上那一行仍是点击
	// 落上去的那一行。刻意「不」属于 landingFor：跨文件打开本来就会自己回落到那条记录。
	private appliedLanding(target: NavJump | NavVisit | NavTeleport): NavEntryState | undefined {
		return this.landingOf(target) ?? this.savedPosition?.(target.path);
	}

	// 一个条目真能恢复的落点：它自己记的 state，或者——对落点从未落定的 teleport——那条
	// 目标行作为视口顶行。面板正是把那一行印在行上，所以照办它就不至于让那一行许诺一个跳转
	// 并不会把读者带到的地方。自己没位置的条目返回 undefined：同一文件跳转会回落到文件保存
	// 的记录，跨文件打开自己就会回落。
	private landingOf(target: NavJump | NavVisit | NavTeleport): NavEntryState | undefined {
		// 这一步「自己」那一处，不是读者漂到的地方：漂移会在把它带离的那次导航处记成自己的
		// 一步，所以他们点名的那个标题仍然到得了——前进走回这一步必须落在它上面。
		if (target.st) {
			// jump 点名的是一「行」，落上去的方式和 app 自己的大纲落在被点的标题上一样：光标停在
			// 该行行首。记录自带的光标不是这个许诺——那是跳转离开时落下的那个（见 readLandingState）
			// ——所以每次 jump 的光标都在这里重算，从不重放。visit 留着自己记的光标：它记的是一个
			// 阅读位置，不是一个标题。
			const line = target.kind === 'jump' ? landedLine(target) : undefined;
			return line === undefined ? target.st : caretAtLine(target.st, line);
		}
		if (target.kind === 'teleport' && Number.isFinite(target.line))
			return { scroll: Math.max(0, target.line) };
		return undefined;
	}

	// 跨文件遍历交给打开流水线的落点：条目「自己」记的位置——前进后退必须回到的那一处——
	// 并在条目是带 key 的跳转、且它的标题之后挪过时施加结构重锚：注入式的打开路径没有目标
	// 编辑器可以跑文本片段重映射。
	private landingFor(target: NavJump | NavVisit | NavTeleport): NavEntryState | undefined {
		const st = this.landingOf(target);
		if (!st)
			return undefined;
		const shift = this.resolveAnchorShift(target);
		return shift ? shiftNavState(st, shift) : st;
	}

	// 武装那个一次性标记，供 setViewState 补丁消费（见 PositionState.pendingHistoryNav）：
	// 遍历自己的打开必须把本插件的位置注进去，盖过原生条目那个只带光标的 eState。`path` 是
	// 落点所属的文件，所以被一次无关打开偷走的标记，绝不可能注进别人的落点。超时必须把落点
	// 和标记一起丢掉：落下任何一个，都会在之后某次无关的打开里被注进去。
	private armHistoryNav(landing: NavEntryState | undefined, path: string) {
		this.state.pendingHistoryNav = true;
		this.state.pendingHistoryNavState = landing;
		this.state.pendingHistoryNavPath = path;
		this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
		window.clearTimeout(this.state.pendingHistoryNavTimeout);
		this.state.pendingHistoryNavTimeout = window.setTimeout(() => {
			this.state.pendingHistoryNav = false;
			this.state.pendingHistoryNavState = undefined;
			this.state.pendingHistoryNavPath = undefined;
		}, HISTORY_NAV_TIMEOUT_MS);
	}

	// 在 `leaf` 里打开目标文件（是另一个标签页时先激活它）。已经显示着该文件的活标签页不
	// 需要打开——但条目的落点照样施加：条目（以及面板上那一行）许诺的是那一处，不是那个
	// 标签页碰巧被留在哪。（视图条目从不走这里——execute 会重新激活它们。）
	private async openInLeaf(leaf: WorkspaceLeaf, target: NavJump | NavVisit | NavTeleport) {
		if (this.app.workspace.getActiveViewOfType(FileView)?.leaf !== leaf)
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const view = leaf.view;
		const curFile = (view as FileView | undefined)?.file;
		if (curFile?.path === target.path) {
			if (view instanceof MarkdownView)
				await this.applyLanding(view, target);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(target.path);
		if (file instanceof TFile) {
			// 直接打开的遍历，必须像委托出去的那次一样瞬时落定：武装同一个标记，好让 setViewState
			// 补丁把这个目标的落点注在朴素打开之上 —— 走注入那一档（首绘遮罩下
			// 落定再揭幕），而不是等 file-open 从顶部恢复。
			this.armHistoryNav(this.landingFor(target), target.path);
			await leaf.openFile(file);
		}
	}

	// 把一步委托给原生的按标签页历史——但只在原生栈的下一条「就是」目标时（一个文件路径，
	// 或一个视图类型），这样一个步骤落在哪，两个栈永远不会各说各的。文件内跳转只存在于
	// 我们的栈上，所以对不上是理所当然的；那些改走 openInLeaf/setViewState。
	private async delegateNative(
		dir: -1 | 1,
		leaf: WorkspaceLeaf,
		targetPath: string | undefined,
		targetViewType?: string,
		targetLanding?: NavEntryState,
	): Promise<boolean> {
		const history = (leaf as unknown as { history?: NativeLeafHistory }).history;
		const stack = dir < 0 ? history?.backHistory : history?.forwardHistory;
		const top = stack?.[stack.length - 1];
		const matches = targetPath !== undefined
			? top?.state?.state?.file === targetPath
			: top?.state?.type === targetViewType;
		if (!matches)
			return false;

		// 武装注入：setViewState 补丁随后把本插件的位置铺在原生条目那个只带光标的 eState 之上
		// ——只对 markdown 的文件条目。视图条目不武装：它的 setViewState 在补丁读到标记之前就
		// 早退了，在这里武装它只会漏到之后某次无关的打开上。
		if (targetPath !== undefined)
			this.armHistoryNav(targetLanding, targetPath);
		// （app.commands 属于运行时 API，公开类型定义里没有。）
		(this.app as unknown as {
			commands: { executeCommandById(id: string): unknown };
		}).commands.executeCommandById(dir < 0 ? 'app:go-back' : 'app:go-forward');

		await delay(NATIVE_LANDING_VERIFY_MS);
		if (targetPath !== undefined)
			return (leaf.view as FileView | undefined)?.file?.path === targetPath;
		return (leaf.view as { getViewType?: () => string } | undefined)?.getViewType?.() === targetViewType;
	}

	private findLeafById(id?: string): WorkspaceLeaf | undefined {
		if (!id)
			return undefined;
		let found: WorkspaceLeaf | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && this.state.leafId(leaf) === id)
				found = leaf;
		});
		return found;
	}

	// 已经显示着这个视图的 leaf，仅限「主区域」：一个视图地点就是那个视图本身（见 entry.ts
	// 的 navGroupKey），所以它哪个标签页都能作数——而侧栏 leaf 被跳过，跟它从不被「记录」是同一个
	// 理由：面板根本不算工作区里的一个地点（见 isMainAreaLeaf）：住在侧栏里的 Thino，不是
	// 条目所说的读者去过的地方。
	private findLeafShowing(viewType: string): WorkspaceLeaf | undefined {
		// 仓库再也建不出来的类型，哪儿也没在显示：戴着它的标签页里是一个「应」那个类型的占位
		// 视图，激活它给读者的是一块说自己什么都不是的窗格（见 shared/leaf 的 viewTypeIsMissing）。
		if (viewTypeIsMissing(this.app, viewType))
			return undefined;
		return this.app.workspace.getLeavesOfType(viewType)
			.find(leaf => isMainAreaLeaf(this.app, leaf));
	}

	// 一个哪儿都没有的视图：「构造」它到一个新标签页里。留下的是类型，以及读者在它里面时
	// 那个视图的 state；state 是「重放」而不是凭空造，缺失的就按 app 自己的 `graph:open`
	// 那样传空对象进去。`active` 把新标签页带到前台，一路上什么都不显示。
	//
	// 事后要「盯住」这个 leaf，而不是信它，因为 `setViewState` 也是要一个未注册类型的途径：
	// 读者删掉的插件没东西可构造，Obsidian 会用另一种类型的视图来答（空白页）。一个立在
	// 这个仓库早已没有的地点上的标签页，比这次点击悄悄什么都不做更糟，所以除非视图真的到了，
	// 标签页会被再关掉。
	private async showViewInNewTab(viewType: string, state?: Record<string, unknown>): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		const shaped = leaf as unknown as {
			setViewState(vs: { type: string; state: object; active: boolean }): Promise<void>;
			detach(): void;
		};
		try {
			await shaped.setViewState({ type: viewType, state: state ?? {}, active: true });
		} catch {
			shaped.detach();
			return;
		}
		// 缺失的类型会构造出一个「应」那个类型的占位视图，所以下面那个常规的到达检查会带着空壳
		// 通过：那个标签页无论自称什么，都归我们关掉。
		const arrived = (leaf.view as { getViewType?: () => string } | undefined)?.getViewType?.();
		if (viewTypeIsMissing(this.app, viewType) || arrived !== viewType)
			shaped.detach();
	}

	// 文件内跳转的结构重锚：用 metadataCache 把条目的 key 解析到它「当前」的行号，返回已记
	// 位置需要的「位移」——锚点当前行号减它「记录时」的行号（keyLine）。这个位移只反映文件
	// 编辑；historyJumpApply 把它统一施加到 scroll 和光标上，保住记下的视口几何。没有
	// keyLine 的条目返回 undefined——historyJumpApply 回落到文本片段重映射。
	private resolveAnchorShift(target: NavEntry): number | undefined {
		if (target.kind !== 'jump' || !target.key || typeof target.keyLine !== 'number')
			return undefined;
		const file = this.app.vault.getAbstractFileByPath(target.path);
		if (!(file instanceof TFile))
			return undefined;
		return anchorLineShift(this.app.metadataCache.getFileCache(file), target.key, target.keyLine);
	}

	// ===== 簿记（这个栈自己的记录——见 PathBookkeeper） =====

	renameFile(oldPath: string, newPath: string) {
		for (const entry of this.entries)
			if (entry.kind !== 'view' && entry.path === oldPath)
				entry.path = newPath;
	}

	// 一次真正的仓库删除会丢掉这个文件的步。「不」直接从仓库的 'delete' 事件里调：
	// PathBookkeeper 会延迟这项清理并重查一次仓库，因为同步插件替换一个改过的文件时，是先
	// 删掉它、再把下载下来的改名盖上去——一次片刻后就被撤销的删除（见
	// position/path-bookkeeping.ts）。
	deleteFile(path: string) {
		const kept: NavEntry[] = [];
		let removedBefore = 0;
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (entry.kind !== 'view' && entry.path === path) {
				if (i < this.index)
					removedBefore++;
				continue;
			}
			kept.push(entry);
		}
		// 没有步点名这个路径：整个栈不重写。
		if (kept.length === this.entries.length)
			return;
		this.entries = kept;
		this.index = kept.length === 0
			? -1
			: Math.min(this.index - removedBefore, kept.length - 1);
	}

	// ===== 持久化（本机、按库各一份——与那份覆盖层一致） =====
	// 存储格式、启动读取、逐条目形状校验都在 store.ts 里。

	// 「本实例」最后写出的存档（flush 去重——见 persistNavHistory）。是实例字段，不是模块
	// 状态：历史按库各一份，实例间共用的去重会让某一个跳过它该写的那次。
	private lastPersisted = '';

	persist() {
		this.lastPersisted = persistNavHistory(
			this.app, this.entries, this.index, this.lastPersisted);
	}
}
