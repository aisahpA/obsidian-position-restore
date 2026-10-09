import { App, FileView, WorkspaceLeaf } from 'obsidian';
import { NavEntryState } from '@/types';
import {
	NavEntry, NavTeleport, NavView, NewNavEntry, DistributiveOmit, isRecordableViewType,
} from './entry';
import { PositionState } from '@/position/state';
import {
	deferredFilePath, isDeferredLeaf, isFileDestination, isMainAreaLeaf, viewTypeIsMissing,
	viewIcon as readViewIcon, viewLabel as readViewLabel, viewState as readViewState,
} from '@/shared/leaf';
import { installOutlineCapture as installOutlineCaptureHook } from './outline-capture';

// 采集漏斗 —— 一次导航，多个读取方。各个采集点（setViewState 补丁、轮询、大纲面板、workspace 的
// active-leaf-change）往这里写，读取方订阅；**没有哪个读取方是另一个的二手转述者。**
//
// 方法有两组，区别在于谁有决定权：
//
//  - 采集面（record*、leave、settled）。采集点并不知道一次导航意味着什么 —— 它只知道它看到了什么。
//    漏斗把它变成一条记录，并套上公共闸门。闸门只回答一个与任何订阅者都无关的问题：
//    这次是读者在导航，还是插件自己在挪视图？像「记录标签页切换」这种设置**不算**闸门：
//    那是栈对自己那张列表的主张，由每个读取方各自应用。
//  - 广播（visit、landing、here）—— 已经有人认定的事实，发布给每一个订阅者。
//
// 读取方就是订阅者。栈存「步」，最近文件列表存「地点」。两者吃的是同一份记录，留下的东西不同，
// 而且互不知道对方存在。每个钩子都是可选的：用不上某个事实的订阅者，不实现它就行。

// 一次导航是怎么来到这里的 —— 这是读者唯一无法从记录本身读出来的东西，正因为如此，两个读取方
// 才能对同一个事实套各自的闸门（栈的「记录标签页切换」看的是它**加上**记录的 kind；
// 「光标跳跃距离」只看 cause 本身）。
//   open     — 一次普通的文件打开（setViewState 补丁）
//   jump     — 带 key 的跳转：大纲条目、锚点链接、搜索 / 反向链接目标
//   tab      — 标签页 / 窗格被激活（VSCode 记录 active-editor 变化也是这个做法）
//   teleport — 推断出来的同文件光标跳跃（采样器的启发式）
export type NavCause = 'open' | 'jump' | 'tab' | 'teleport';

// 一次导航，抵达订阅者时的样子。`record` 是它作为「一步」的样子（见 entry.ts）；
// 要不要留下它，由订阅者决定。
export interface NavRecording {
	record: NewNavEntry;
	cause: NavCause;
	// 一次明确的目标跳转（同文件内的搜索命中 / 反向链接闪现）：是读者点了那个地方，所以即便栈顶
	// 看起来一模一样，也要记一步。只有栈会读这个标记。
	forced?: boolean;
}

// 一次位置读取：一个地点在读者离开它时它在哪儿，或某次跳转真正落到哪儿。这两者故意是两个不同的
// 事实 —— 栈两个都要（它需要*某个*位置可以回去），而一个地点只保留落点。
export type NavLeave =
	// 读者离开了这个地点；这是他当时的位置。
	| { cause: 'read'; path: string; leafId: string; st: NavEntryState }
	// 某次跳转的落点已落定：这是它真正把他带到的地方。
	| { cause: 'settled'; path: string; leafId: string; st: NavEntryState }
	// 标签页 / 窗格被激活：接管过来的那个 leaf 自己持有一个位置。
	| { cause: 'tab'; leaf: WorkspaceLeaf };

// 一个订阅者能被通知到的事。全部可选 —— 你要留下什么就实现什么。
export interface NavFunnelSink {
	// 发生了一次导航（已经过了公共闸门）。栈在压入之前会拿它跟自己的栈顶比一比；
	// 地点列表则据此重排最近使用顺序。
	onVisit?(recording: NavRecording): void;
	// 一次位置读取（见 NavLeave）。目前只有栈实现了它。
	onLeave?(leave: NavLeave): void;
	// 某次跳转的落点现在知道了 —— 带 key 的跳转落定，或 teleport 的滚动在跳跃事件之后一帧才到。
	// 带着的是这条记录**用于识别身份**的字段（一个地点的身份是跳转的 key，而 key 只有记录里才有），
	// 但不带时间戳：落点描述的是一条已经存在的记录，它的 `t` 属于当初压栈的那一边。
	onLanded?(entry: NewNavEntry): void;
	// 「你在这里」这个标记移动了。
	onHere?(entry?: NavEntry): void;
}

// 看门狗：一次跳转里的 await 若挂住了（openFile / loadIfDeferred 永远不 resolve），
// 由它松开 bracket。没有它，漏斗会永远停在「正在移动」，前进后退就永久废了。
// 取值高于一次正常重放的上限（SETTLE_MAX_MS 800 + RELAND_MAX_MS 3000 + 锚点延迟）。
const BRACKET_WATCHDOG_MS = 5000;

export class NavFunnel {
	private readonly app: App;
	private readonly state: PositionState;
	private readonly sinks = new Set<NavFunnelSink>();

	// 插件自己在挪视图的这段时间为真：跳转过程触发的那些「打开」就是跳转本身，不是新的跳转。
	private moving = false;

	constructor(app: App, state: PositionState) {
		this.app = app;
		this.state = state;
	}

	subscribe(sink: NavFunnelSink): () => void {
		this.sinks.add(sink);
		return () => {
			this.sinks.delete(sink);
		};
	}

	// 公共闸门：这是读者做的一次导航，还是插件在挪自己？跳转过程自己的那次打开、
	// 以及启动时的重建，对谁都不算导航。
	isRecording(): boolean {
		return !this.moving && this.app.workspace.layoutReady;
	}

	// 此刻是不是有一个 bracket 开着（我们的一次跳转正在飞）？这与上面的闸门不是一回事 ——
	// 那条同时还回答「工作区起来没有」。
	isMoving(): boolean {
		return this.moving;
	}

	// ===== 采集面 =====

	// 一次文件打开（setViewState 补丁）、一次文件内的跳转标记、或一个无路径视图被激活
	// （opts.viewType —— 图谱标签页以及其它所有视图）。
	recordOpen(
		path: string | undefined,
		leafId: string,
		opts: {
			key?: string; force?: boolean; viewType?: string; viewLabel?: string;
			viewIcon?: string; viewState?: Record<string, unknown>;
		} = {},
	) {
		if (!this.isRecording())
			return;
		if (opts.viewType) {
			// 无路径的视图是靠着激活它的 leaf 抵达的。名字、图标与 state 在调用方手上有时就顺带带来：
			// 行上印的和画的就是前两个，而读者回来时那个 leaf 若已经没了，重建地点靠的就是 state。
			// 只知道类型的调用方就把它们省掉。
			const record: DistributiveOmit<NavView, 't'> = { kind: 'view', leafId, viewType: opts.viewType };
			if (opts.viewLabel)
				record.label = opts.viewLabel;
			if (opts.viewIcon)
				record.icon = opts.viewIcon;
			if (opts.viewState)
				record.state = opts.viewState;
			this.publish({ record, cause: 'open' });
			return;
		}
		// 既没路径又没类型的调用没有可恢复的东西 —— 不记录。
		if (!path)
			return;
		this.publish({
			record: opts.key
				? { kind: 'jump', path, leafId, key: opts.key }
				: { kind: 'visit', path, leafId },
			cause: opts.key ? 'jump' : 'open',
			forced: opts.force,
		});
	}

	// 同文件内的大幅光标跳跃（跳到某行、vim 跳转、鼠标点得很远）：每个 selection 事件一次，
	// 且只在桌面 —— 滑动不移动光标，而轻点落在当前这一屏之内。这是**推断**出来的移动，
	// 不是一次有意的跳转 —— 值不值得记一步由栈判断（阈值 navHistoryTeleportMinLines）。
	recordTeleport(path: string, leafId: string, line: number, landing?: NavEntryState) {
		if (!this.isRecording())
			return;
		const record: DistributiveOmit<NavTeleport, 't'> = { kind: 'teleport', path, leafId, line };
		if (landing)
			record.st = landing;
		this.publish({ record, cause: 'teleport' });
	}

	// 把标签页 / 窗格的激活当作一次导航（VSCode 记录 active-editor 变化也是这个做法）。
	// 侧边栏面板被排除 —— 它们在自己的 view state 里跟着当前文件走。而一个**视图**被激活时，
	// 发布方式与文件标签页一模一样，并且不管栈的「标签页切换」设置怎么配都算一步：
	// 激活它的 leaf 是进入一个视图唯一的方式。
	recordActivation(leaf: WorkspaceLeaf | null) {
		if (!leaf || !isMainAreaLeaf(this.app, leaf) || !this.isRecording())
			return;
		// 正被离开的那个标签页还握着它背后文件的位置，而激活发生的这一刻是它仍可读的唯一时机
		// （聚焦另一个标签页不会触发 setViewState）。
		this.publishLeave({ cause: 'tab', leaf });
		const view = leaf.view;
		const leafId = this.state.leafId(leaf);
		// 一个没有 file 的 FileView 不是「另一种目的地」，而是一个瞬间：同步替换一篇笔记的做法是
		// 先删掉文件、再把下载的那个改名盖上去（见 position/path-bookkeeping.ts），在那一个瞬间，
		// 仍显示着这篇笔记的标签页就是一个 `file` 为 null 的 FileView。把它记成视图，会凭空造出一个
		// key 为 `view:markdown` 的幽灵地点 —— 还挂着这篇笔记自己的名字 —— 而任何删除都清理不掉它，
		// 因为视图那一行背后没有文件可以「失踪」。
		//
		// 而「跟着」这篇笔记走的 FileView 两者都不是（见 isFileDestination）：它会掉到下面的
		// 视图分支里去，那才是它本来的样子。
		if (view instanceof FileView && isFileDestination(view)) {
			if (view.file)
				this.publish({ record: { kind: 'visit', path: view.file.path, leafId }, cause: 'tab' });
			return;
		}
		// 延迟打开的 leaf 是占位符，不是它那个视图：它照着恢复用的 state 回答视图的问题，所以笔记
		// 自己的标签页会掉出上面的 instanceof 判断 —— 而把它记成视图，同样会凭空造出一个 key 为
		// `view:markdown`、挂着笔记名字与文件图标的地点，任何删除都清理不掉。处在这个状态下，
		// 它代表的文件就是它替着的那篇笔记。
		if (isDeferredLeaf(leaf)) {
			const restored = deferredFilePath(view);
			if (restored) {
				this.publish({ record: { kind: 'visit', path: restored, leafId }, cause: 'tab' });
				return;
			}
		}
		// 主区视图本身就是目的地，不管它是什么类型（哪一种不算地点见 isRecordableViewType）。
		// 关于它的三样东西只在这里读、别处不读，因为只有这一刻读得到：它显示的名字、旁边的图标、
		// 以及它**自己的 state** —— 正是「这个视图」与「读者去的那个地方」的区别所在
		// （见 NavView.state）。三者都可缺省：其中一样静默地失败，好过把读者自己的一次
		// 切换标签页拖垮（见 shared/leaf.ts）。
		const viewType = view?.getViewType();
		if (!viewType || !isRecordableViewType(viewType))
			return;
		// 这个仓库已经造不出来的类型不算地点：试图恢复它的标签页只会得到一个自称是它的占位符，
		// 而挂在这种自称上的地点永远回不去 —— 而且它的 key 和真的那个一样，于是还会把真的覆盖掉。
		if (viewTypeIsMissing(this.app, viewType))
			return;
		// markdown 标签页**永远**是一篇笔记 —— 不管上面哪一步没能说清楚这一点。当成视图，它就是一个
		// 背后没有文件的地点，读者或仓库做什么都清理不掉。
		if (viewType === 'markdown')
			return;
		const record: DistributiveOmit<NavView, 't'> = { kind: 'view', leafId, viewType };
		const label = readViewLabel(view);
		if (label)
			record.label = label;
		const icon = readViewIcon(view);
		if (icon)
			record.icon = icon;
		const state = readViewState(view);
		if (state)
			record.state = state;
		this.publish({ record, cause: 'tab' });
	}

	// 「离开时更新」：正被离开的那个地点的位置，趁视图还握着它的时候读出来。
	// 由 setViewState 补丁、跳转、大纲面板以及采样器的离开读取调用。
	leave(path: string, leafId: string, st: NavEntryState) {
		this.publishLeave({ cause: 'read', path, leafId, st });
	}

	// 落点已经落定（跳转之后读者不再动了）：这是这次跳转把他带到的那个位置，
	// 也是一个地点唯一认的位置。
	settled(path: string, leafId: string, st: NavEntryState) {
		this.publishLeave({ cause: 'settled', path, leafId, st });
	}

	// 阅读模式下点大纲，其它采集路径都看不见；采集钩子放在 outline-capture.ts，
	// 只需要用到这个漏斗。
	installOutlineCapture(registerCleanup: (fn: () => void) => void) {
		installOutlineCaptureHook(this.app, {
			state: this.state,
			leave: (path, leafId, st) => this.leave(path, leafId, st),
			recordOpen: (path, leafId, opts) => this.recordOpen(path, leafId, opts),
		}, registerCleanup);
	}

	// 插件自己在做的一次位置变化（前进后退走一步、跳到某个地点）：它触发的那些打开就是跳转本身，
	// 而轮询不许把这种程序化的落位当成读者的移动记下来。bracket 同时也罩住本次跳转开头那次
	// startLeaf 激活：那也会触发一次激活，而当栈顶那一步的 leaf id 已经过期时，去重会失手。
	async runBracketed(step: () => Promise<void>): Promise<void> {
		if (this.moving)
			return;
		this.moving = true;
		this.state.restoreStarted();
		// 看门狗与 finally 共用一次 settle：一次 restoreStarted 恰好对应一次 restoreEnded
		// （这两者共用一个计数器），而卡住的跳转会松开闸门，前进后退因此始终可用。
		// 看门狗响过之后才姗姗来迟的那次完成，在这里是空操作。
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(watchdog);
			this.state.restoreEnded();
			this.moving = false;
		};
		const watchdog = window.setTimeout(settle, BRACKET_WATCHDOG_MS);
		try {
			await step();
		} finally {
			settle();
		}
	}

	// ===== 广播 =====

	// 栈自己拍板的一步 —— 从最近文件列表跳去某个地点。它故意绕开公共闸门：栈**就是**那个正在挪视图的
	// 插件本人，而且它已经判定这是一次真实的导航。记录带着这一步自己的 `t` 到来。
	visit(recording: NavRecording) {
		this.publish(recording);
	}

	// 一个落点现在知道了，来自哪一侧都有可能：栈那边是它自己落定的带 key 跳转，采样器那边是
	// 滚动比跳跃事件晚一帧才到的 teleport。每个订阅者各取自己保留的那些 kind。
	landing(entry: NewNavEntry) {
		for (const sink of this.sinks)
			sink.onLanded?.(entry);
	}

	// 「你在这里」移动了 —— 栈上和地点列表上都是。
	here(entry?: NavEntry) {
		for (const sink of this.sinks)
			sink.onHere?.(entry);
	}

	// ===== 内部 =====

	private publish(recording: NavRecording) {
		for (const sink of this.sinks)
			sink.onVisit?.(recording);
	}

	private publishLeave(leave: NavLeave) {
		for (const sink of this.sinks)
			sink.onLeave?.(leave);
	}
}
