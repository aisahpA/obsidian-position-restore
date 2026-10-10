import { WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { leafIdOf } from '@/shared/leaf';
import { OpenCover } from './ui/cover';
import { RestoreCue } from './ui/cue';

export type OpenKind = 'anchorLink' | 'startPlainLink' | 'callerTarget';

// setViewState 时派发一次 open-kind 跳转之后，记录会在吸收模式里停留多久：跳转是异步落地的，
// 这段窗口里轮询只重设基线、不写入，落地因此永远不会被记成用户移动。这是上限不是硬延时 ——
// 视图一停稳，采样器就提前让它失效。
export const LANDING_ABSORB_MS = 3000;

// 记录、恢复与各个 open 补丁共用的跨阶段协调状态，只此一份所有者：拆开就会让记录观察到一个
// 只恢复了一半的状态。
export class PositionState {
	// 保存的位置已被注入进这次 open 的 ephemeral state、因此不能恢复第二遍的那些 leaf。
	// 按 LEAF ID 而不是 path 作键：同一个文件开在两个标签页时，每个标签页注入各自的位置。
	// 后台 open 不产生 file-open，所以它的条目会一直留到那个标签页被激活。
	injectedOpenLeafIds = new Set<string>();

	// 上一次 'active-leaf-change' 之前处于活动的那个 path。事件只带新 leaf，所以
	// completeInjectedRestore 要靠这条记录区分「激活了同一个文件」与「真的换了文件」。
	lastActiveFilePath: string | undefined = undefined;

	// ===== 恢复轮次跟踪 =====
	restoreRun = 0;
	// 用计数器，好让被顶掉的恢复慢慢退场期间这个标记仍然立着。
	private activeRestores = 0;

	// leaf id -> 该 leaf 正在进行的恢复的 { filePath, run }。让同一个 leaf+file 的重复重申跳过
	// 而不是顶掉前一个 —— 第二条一旦入表就会走非注入路径，把首绘遮罩在落定途中揭开。
	inFlightRestoreLeafRuns: Map<string, { filePath: string; run: number }> = new Map();

	beginLeafRestore(leafId: string, filePath: string): number {
		const run = ++this.restoreRun;
		this.inFlightRestoreLeafRuns.set(leafId, { filePath, run });
		return run;
	}

	// 故意按 leaf 划分作用域：只有同一个 leaf 上更新的恢复才会让一个 run 变陈旧。
	// 另一个 leaf 上的恢复绝不能顶掉它 —— 那会让这个 leaf 的遮罩永远揭不掉。
	isCurrentLeafRestore(leafId: string, run: number): boolean {
		const cur = this.inFlightRestoreLeafRuns.get(leafId);
		return !!cur && cur.run === run;
	}

	// 这个成立期间记录让路：恢复自己的滑动会甩出 scroll 事件，否则会盖掉保存的位置。
	isRestoringFile(): boolean {
		return this.activeRestores > 0;
	}

	restoreStarted() {
		this.activeRestores++;
	}

	restoreEnded() {
		this.activeRestores--;
	}

	// 哪些 leaf 的恢复必须跳过锚定（后台恢复：记录基线只属于活动 leaf）。由 BackgroundSettler
	// 设置，在它的 finally 里清掉。
	noAnchorLeafIds = new Set<string>();

	// ===== 记录基线：恢复写、轮询读 =====
	lastEphemeralState: EphemeralState | undefined;
	lastLoadedFilePath: string | undefined;

	// 上一次恢复锚定记录的时刻 —— 桌面端推断跳变基线据此抬高纪元，以便把「恢复自己放的光标」与
	// 「读者做的一次跳转」区分开。它不再给任何重排窗口计时：采样器问的是读者**最近**动过没有
	// （见它的 hasUserIntent）。
	lastAnchorAt = 0;

	// 最后一次用户触摸（仅移动端）与最后一次用户输入（桌面端：wheel / pointerdown /
	// keydown）—— 各自是所在平台滚动守卫读的信号。
	lastTouchAt = 0;
	lastUserInputAt = 0;

	// leaf.id -> 已完整处理过 open 的 filePath。file-open 去重路径与 setViewState 补丁都会写它，
	// 所以那些 open 从不触发 'file-open' 的组合（后台打开、启动时恢复）仍能对后来的切换去重。
	handledLeafIdMap: Map<string, string> = new Map();

	// ===== open-kind 跟踪（补丁之间传递的临时标记） =====

	// 每个 leaf 待处理的 open kind。按 leaf 分是因为：一次从不触发 'file-open' 的 caller-target
	// 打开，不能泄漏到另一个 leaf 的恢复上。
	pendingOpenKind: Map<WorkspaceLeaf, OpenKind> = new Map();

	// 由 openLinkText 补丁写入（它还不知目标 leaf），再由 injectEphemeralStateOnOpen 在同一个
	// 调用栈里同步提升到 pendingOpenKind 上。那个定时器是安全网，兜那些从未走到 setViewState
	// 的调用。
	pendingLinkKind: OpenKind | undefined;
	pendingLinkKindTimeout = 0;

	// 顺带存下的原始 linktext：同文件锚点跳转在 nav-history 里的去重键。与 pendingLinkKind 一起清。
	pendingLinkText: string | undefined;

	// NavStack 在调用 app:go-back / app:go-forward 之前立刻装好：随之而来的 setViewState
	// 必须把**本插件**保存的位置注入覆盖掉原生条目的 eState —— 后者只带光标。
	pendingHistoryNav = false;
	pendingHistoryNavTimeout = 0;

	// 当目标条目自带记录位置时，待处理的那次遍历的 open 应当被给予的落点。undefined = 文件记录
	// 说了算。与那个标记一起清 —— 落下的落点会被注入进一次无关的后来的 open。
	pendingHistoryNavState: EphemeralState | undefined;

	// 那个落点所属的文件：标记是全局的，所以落点只对当年为它装好的那次 open 生效。
	pendingHistoryNavPath: string | undefined;

	// 一个在途落点落地后要标记的那一行、它所属的笔记，以及它是何时被要求的（见
	// NavStack.armLandingMark）。一次性、绑定 path，理由同上一个标记；另外还更短命，因为：
	// 这里点名的那篇笔记可能循别的路径走到这一行，那就没有谁的标题该被标上。
	// `sourceOnly`：visit/teleport 在阅读模式不闪（没有光标，视口顶就是落点）；
	// jump 缺省，两种模式都闪。
	// `center`（缺省 = true）：要不要请编辑器把那一行摆到**正中**。visit 记的是一屏、
	// 不是一行，它要的是回到记下的视口顶，所以只有它带 `center: false`（见
	// NavStack.armLandingMark —— 那里写着为什么拿光标行当 visit 的落点是错的）。
	pendingLineFlash: {
		path: string;
		line: number;
		at: number;
		sourceOnly?: boolean;
		center?: boolean;
	} | undefined;

	// leafId -> 该 leaf 上最近一次注入式 open 被给予的落点。恢复器对注入来源的落定必须核对
	// core 拿到的是同一行 —— 跨文件历史跳转之后，两者是有意不同的。
	injectedLeafStates: Map<string, EphemeralState> = new Map();

	// 在此之前抑制恢复的落点提示：只要一次遍历触发了恢复，NavStack 就装它，好让前进后退的落点
	// 不带那个小标签 —— 目的地是读者自己选的。用截止时刻而不是布尔，是因为跨文件恢复跑在防抖后的
	// 'file-open' 处理器里，晚于这次遍历的括号合上。
	cueSuppressUntil = 0;

	// ===== 搜索锚定（搜索引发的跳转守卫） =====
	// 在此之前记录把视图移动当成不是读者动的：搜索框持焦期间是 Infinity，失焦后还有一小段
	// 宽限。派发 open-kind 跳转时，补丁也会设一个有限值（LANDING_ABSORB_MS）。
	searchAnchorUntil = 0;

	isSearchAnchored(): boolean {
		return Date.now() < this.searchAnchorUntil;
	}

	// ===== 遮罩（首绘之前的蒙版） =====
	cover = new OpenCover();

	// ===== 恢复后的方位提示 =====
	cue: RestoreCue;

	constructor(settings: PluginSettings) {
		this.cue = new RestoreCue(settings);
	}

	// leaf.id 是运行时 API，公开类型里没有；这层转换收掉了各处 @ts-ignore 的噪音。
	leafId(leaf: WorkspaceLeaf): string {
		return leafIdOf(leaf);
	}
}
