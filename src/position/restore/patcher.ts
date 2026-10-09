import { App, MarkdownView, TFile, Vault, Workspace, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState, OpenKind, LANDING_ABSORB_MS } from '@/position/state';
import { readNavEntryState } from '@/position/capture/ephemeral';
import type { NavFunnel } from '@/nav/funnel';
import { stripLinkAlias } from '@/nav/entry';
import { isMainAreaLeaf, isPopoverLeaf } from '@/shared/leaf';
import type { Sampler } from '@/position/capture/sampler';
import { SourcePixelCorrector, type ScreenNote } from './pixels';

// open 时流经 setViewState 的视图 / ephemeral state 载荷是内部结构、没有类型；
// 这里声明本插件要读的那几个最小字段。
interface OpenViewState {
	type: unknown;
	state?: {
		file?: unknown;
		mode?: unknown;
	};
}

// 同一个参数在位置字段之外，还会带上调用方提交的目标（搜索命中、
// 大纲 / 反向链接的 is-flashing）。
type OpenEphemeralState = EphemeralState & {
	match?: unknown;
	'is-flashing'?: unknown;
};

type SetViewState = (
	this: WorkspaceLeaf,
	viewState: OpenViewState,
	eState?: OpenEphemeralState,
) => unknown;

type OpenLinkText = (this: Workspace, ...args: unknown[]) => Promise<void>;

// 装上恢复所依赖的那些补丁 —— setViewState（把保存的位置注入进这次 open 的
// ephemeral state）与 openLinkText（给标题 / 块链接导航打标记，好让保存的位置
// 让位给链接目标）。所有跨阶段协调用的标记都住在共享的 PositionState 上。
export class OpenPatcher {
	private app: App;
	private settings: PluginSettings;
	private state: PositionState;
	private store: PositionStore;
	private funnel: NavFunnel;
	private sampler: Sampler;
	// 只有一道闸在这里用得上：「编辑器换上**这篇**笔记的内容了没有」（见 contentSwapGate）。
	private pixels: SourcePixelCorrector;

	constructor(app: App, settings: PluginSettings, store: PositionStore, state: PositionState, funnel: NavFunnel, sampler: Sampler) {
		this.app = app;
		this.settings = settings;
		this.store = store;
		this.funnel = funnel;
		this.sampler = sampler;
		this.state = state;
		this.pixels = new SourcePixelCorrector(state);
	}

	// 插件卸载时 registerCleanup 必须把两个补丁都撤掉。
	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patchSetViewState(registerCleanup);
		this.patchOpenLinkText(registerCleanup);
	}

	private patchSetViewState(registerCleanup: (fn: () => void) => void) {
		const leafProto = WorkspaceLeaf.prototype as {
			setViewState?: SetViewState;
		};
		const originalSetViewState = leafProto.setViewState;
		if (!originalSetViewState)
			return;
		// 箭头函数让 `this` 保持词法作用域；下面的包装器必须是个普通函数，
		// core 传的 `this`（那个 leaf）才能保住。
		const injectOnOpen = (leaf: WorkspaceLeaf, viewState: OpenViewState, eState?: OpenEphemeralState) =>
			this.injectEphemeralStateOnOpen(leaf, viewState, eState);
		leafProto.setViewState = function (this: WorkspaceLeaf, viewState: OpenViewState, eState?: OpenEphemeralState) {
			eState = injectOnOpen(this, viewState, eState);
			return originalSetViewState.call(this, viewState, eState);
		};
		registerCleanup(() => {
			leafProto.setViewState = originalSetViewState;
		});
	}

	private patchOpenLinkText(registerCleanup: (fn: () => void) => void) {
		const workspace = this.app.workspace as Workspace & { openLinkText: OpenLinkText };
		// 故意不绑定地抓下来：包装器每次调用都重新绑定（`apply(this, args)`），
		// core 选定的 `this`（那个 workspace）才说了算。
		// eslint-disable-next-line @typescript-eslint/unbound-method -- 故意不绑定地抓下来，好在每次调用时重新绑定
		const originalOpenLinkText = workspace.openLinkText;
		if (typeof originalOpenLinkText !== 'function')
			return;
		const state = this.state;
		const settings = this.settings;
		workspace.openLinkText = async function (this: Workspace, ...args: unknown[]) {
			// 临时槽位：openLinkText 这时还不知道目标 leaf，所以由这次调用栈里
			// 的 setViewState 补丁把它提升到 pendingOpenKind 上。'anchorLink' =
			// 标题 / 块目标；'startPlainLink' = 'start' 设置（在文件开头打开，
			// 保存的记录不动）。先清空，免得某次从未走到 setViewState 的 open
			// 留下的过期条目漏进这一次。
			state.pendingLinkKind = undefined;
		state.pendingLinkText = undefined;
		const linktext: unknown = args[0];
		const hasTarget = typeof linktext === 'string'
			&& (linktext.includes('#') || linktext.includes('^'));
		if (hasTarget) {
			state.pendingLinkKind = 'anchorLink';
			// 别名在**这里**剥掉，不是在读 key 的地方：送进来的是整个 wikilink，
			// 而它的标签并不属于目标的一部分。
			state.pendingLinkText = stripLinkAlias(linktext);
		} else if (settings.linkOpenPosition === 'start') {
			state.pendingLinkKind = 'startPlainLink';
		}
			try {
				return await originalOpenLinkText.apply(this, args);
			} finally {
				window.clearTimeout(state.pendingLinkKindTimeout);
				state.pendingLinkKindTimeout = window.setTimeout(() => {
					state.pendingLinkKind = undefined;
				state.pendingLinkText = undefined;
			}, 500);
			}
		};
		registerCleanup(() => {
			workspace.openLinkText = originalOpenLinkText;
		});
	}

	// 把保存的位置注入进这次 open 的 ephemeral state 参数，好让 core 在它给
	// 自己做恢复时用的那个流水线槽位里应用它：与内容交换同步，早于任何绘制。
	// 这是源码模式的恢复唯一能不带闪烁的地方 —— 'file-open' 是经由一个防抖
	// 回调发出的，也就是在笔记已经按默认位置画出来之后。注入的同时把 leaf
	// 遮上（见 maybeCoverOpen）：那段遮罩只盖到编辑器给出真几何，代价与理由
	// 都在 modes.ts 的 restoreInjectedSource。
	private injectEphemeralStateOnOpen(leaf: WorkspaceLeaf, viewState: OpenViewState, eState: OpenEphemeralState | undefined): OpenEphemeralState | undefined {
		if (!viewState || typeof viewState.type !== 'string')
			return eState;
		const filePath = viewState.state?.file;
		if (typeof filePath !== 'string' || !filePath)
			return eState;
		// 一个承载着真正 leaf 的悬停预览，就在 app 打开它的地方打开：不要位置、
		// 不要遮罩，也不在窗格的导航里留条目。
		if (isPopoverLeaf(leaf))
			return eState;
		const leafId = this.state.leafId(leaf);

		// 对一个已经处理过的 leaf+file 调 setViewState，是 core 在**重放**这个
		// leaf 缓存的视图状态，不是一次新的 open —— 未激活标签页的延迟重建，
		// 或快速切换器重新选中当前文件。leaf.view 检测不出来：打补丁这一刻
		// 标签页的视图还没装上。保留「已处理」标记；丢掉那个从未遇到自己
		// file-open 的待定 kind。
		const isReplay = this.state.handledLeafIdMap.get(leafId) === filePath;
		if (isReplay) {
			this.state.pendingOpenKind.delete(leaf);
		} else {
			// 其它任何情况都会替换这个 leaf 的内容（换一个文件，或关掉最后一个
			// 标签页后的 'empty' 状态）：把过期的账丢掉，好让之后重新打开同一个
			// 文件时还能再恢复一次。
			this.resetLeafOpenState(leaf);
		}

		// 每一次改变这个 leaf 文件的 open 都是一次跳转；重放只有带上同文件目标
		// 时才算（在当前打开的笔记上点大纲 / 反向链接不触发 file-open）。
		// recordOpen 自己会套闸门。「离开时更新」放最前：正被换走的那个视图还
		// 握着用户跳离时的位置 —— 刷新栈顶那一步，好让之后针对它的遍历落在这里。
		// 栈顶一旦走开就是空操作。
		const leavingView = leaf.view;
		if (leavingView instanceof MarkdownView && leavingView.file) {
			const fromSt = readNavEntryState(leavingView);
			if (fromSt) {
				this.funnel.leave(leavingView.file.path, leafId, fromSt);
				// 记录的常规写入方会滞后（轮询 tick、防抖采集）：在这个窗口里
				// 挪一下又迅速跳走，就丢了最终位置。去重让「没移动」成为空操作。
				this.sampler.flushOnLeave(leavingView, leavingView.file.path, fromSt);
			}
		}
		const sameFileTarget = !!eState?.match || !!eState?.['is-flashing'];
		// 只算主区域里的 leaf —— 侧边栏面板重新声明它跟踪的文件
		// （大纲 / 反向链接）不算一次跳转。
		if (isMainAreaLeaf(this.app, leaf))
			this.funnel.recordOpen(filePath, leafId, {
				// 调用方目标（搜索命中、反向链接 is-flashing）不带 linktext：
				// 给它们一个唯一的 key，让这一步走「带 key 的精确落点」那套 ——
				// 落定时的采集会回填落点，之后离开时永不覆盖它。
				key: this.state.pendingLinkText ?? (sameFileTarget ? `caller:${Date.now()}` : undefined),
				force: sameFileTarget,
			});

		// 一次栈遍历（pendingHistoryNav，在这里消费 —— 只此一次）：把**我们**保存
		// 的位置注入到原生条目的 eState 之上，后者只带光标。故意绕过 callerTarget
		// 的让位与滑行的选择 —— 遍历必须瞬间落定，落在文件的记录上（或这一步
		// 自己带的落点上），而不是原生光标上。没有记录 → 原生目标说了算。
		// 非 markdown 的遍历原样穿过去 —— 它们的位置是原生的。
		// 按文件把关：这个标记是全局的，所以某次偷走它的无关 open，绝不能被塞进
		// 另一个文件的位置。
		if (this.state.pendingHistoryNav) {
			const navLanding = this.state.pendingHistoryNavPath === filePath
				? this.state.pendingHistoryNavState
				: undefined;
			this.state.pendingHistoryNav = false;
			this.state.pendingHistoryNavState = undefined;
			this.state.pendingHistoryNavPath = undefined;
			window.clearTimeout(this.state.pendingHistoryNavTimeout);
			if (!isReplay && viewState.type === 'markdown') {
				const st = navLanding ?? this.store.read(leafId, filePath);
				if (st && ((st.scroll ?? 0) > 0 || st.cursor)) {
					const isSource = this.isSourceModeOpen(leaf, viewState);
					const merged = this.buildMergedState(st);
					// **只遮源码模式**，且只遮带 scroll 的注入。阅读视图的首绘要异步渲染，
					// 大笔记跨文件打开能到 2~3 秒；把这段渲染期遮住就是一整片空白。而阅读
					// 模式的落点本来就有 core 自己的渲染流水线接着（注入的 `{scroll}` 走
					// applyScrollDelayed，渲染器一就绪就落定），没有「未恢复的顶部」需要
					// 藏（见 modes.ts 的 landPreview）。
					this.maybeCoverOpen(leaf, filePath, isSource && (merged.scroll ?? 0) > 0);
					this.state.injectedOpenLeafIds.add(leafId);
					this.state.injectedLeafStates.set(leafId, st);
					this.state.handledLeafIdMap.set(leafId, filePath);
					return { ...eState, ...merged };
				}
			}
			this.state.handledLeafIdMap.set(leafId, filePath);
			return eState;
		}

		if (this.takeOverridingOpenKind(leaf, eState, isReplay)) {
			// 一个让了位的 open 不需要 file-open 的恢复过程 —— 把这一对记下来，
			// 好让之后的切换与重声明去重成「只跟踪」的更新，哪怕这次 open 从未
			// 触发 'file-open'。
			this.state.handledLeafIdMap.set(leafId, filePath);
			// 与 open 同步装好落点吸收：core 的目标是异步落地的，记录必须一直
			// 吸收到它落定为止。**必须**放在这里而不是 file-open 处理器里 ——
			// 同文件的搜索点击不触发 'file-open'，恢复器根本不会跑，那次跳转
			// 本身就会被记下来。
			this.state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;
			return eState;
		}

		// 非 markdown 的 FileView（pdf、图片……）：只恢复 scroll，由 file-open
		// 处理器里的 restoreFileViewScroll 应用。
		if (viewState.type !== 'markdown')
			return eState;

		// 阅读视图从不注入：它异步渲染，由 file-open 处理器从顶部恢复。
		const isSourceMode = this.isSourceModeOpen(leaf, viewState);
		if (!isSourceMode)
			return eState;

		// 同一个文件开在两个标签页，重启后每个标签页必须恢复各自的位置。
		const st = this.store.read(leafId, filePath);

		const merged = this.buildMergedState(st);
		if (merged.scroll === undefined && merged.cursor === undefined)
			return eState;

		// 重放只在「被重放的 eState 与保存的记录吻合」时才重新注入（重新遮住
		// 延迟重建留下的编辑器空档）—— 那是我们自己先前注入的签名，经 core 的
		// leaf 缓存又绕了回来。其它情况一律保持原生：没有 eState 的重声明会遮住
		// 一次从不触发 'file-open' 的 open（遮罩卡到安全定时器为止），而一个
		// 已经偏离的位置绝不能把用户拽回去。
		//
		// 例外 —— 启动时的重建：layout ready 之前，core 会用第二次 setViewState
		// 重声明活动 leaf，其 eState 是**空的**（它是把文件重新打开一遍，而不是
		// 重放缓存）。重建出来的编辑器落在顶部，注入丢了；随后的 file-open 补
		// 不回来，因为它的落定只是微调一行已经渲染好的内容。layout ready 之前
		// 用户不可能已经偏离，所以那里空着的 eState 永远是那次重建 —— 重新注入。
		const replayIsEmptyRebuild = !this.app.workspace.layoutReady
			&& !eState?.scroll && !eState?.cursor;
		if (isReplay && !(
			!!eState
			&& (eState.scroll ?? 0) === (merged.scroll ?? 0)
			&& (eState.cursor?.from.line ?? -1) === (merged.cursor?.from.line ?? -1)
		) && !replayIsEmptyRebuild)
			return eState;

		this.maybeCoverOpen(leaf, filePath, (merged.scroll ?? 0) > 0);

		// 让 file-open 处理器知道恢复已经在这里应用过了，于是它只重锚账本、
		// 不再重新应用（账本的归属仍在 restoreEphemeralState 里）。按 leaf id
		// 作键：同一个文件开在两个标签页时，每个标签页的 file-open 必须消费
		// 自己的标记、跑自己的 settle/reveal。现在把这一对记下来，也顺带让
		// 之后那些激活保持去重 —— 当这次 open 是后台 open、其 file-open 从不
		// 触发时。
		this.state.injectedOpenLeafIds.add(leafId);
		this.state.handledLeafIdMap.set(leafId, filePath);

		return { ...merged, ...eState };
	}

	// 这个 leaf 上每一次内容变更都会顶掉它先前那次 open 的账本，markdown 与
	// 其它 FileView 一样。丢掉「已处理」条目，好让同一个文件关掉再打开时能
	// 再恢复一次，而不是被错误地去重；丢掉过期的 pendingOpenKind 不会把这次
	// open 指错。只针对单个 leaf —— 其它 leaf 的标记会一直留着，直到它们的
	// 标签页被激活。
	private resetLeafOpenState(leaf: WorkspaceLeaf) {
		this.state.handledLeafIdMap.delete(this.state.leafId(leaf));
		this.state.pendingOpenKind.delete(leaf);
	}

	// 消费那个顶替用的 open kind（anchorLink / startPlainLink /
	// callerTarget）：当这次 open 该让位给一个非保存的目标时返回它，并设好
	// pendingOpenKind，好让 restoreEphemeralState 能分发。
	private takeOverridingOpenKind(leaf: WorkspaceLeaf, eState: OpenEphemeralState | undefined, isReplay: boolean): OpenKind | undefined {
		// 把这个临时的链接 kind 提升到这个 leaf 的待定条目上，然后清空槽位。
		// 链接导航胜过保存的位置，也胜过恰好撞上的 eState 光标 / scroll ——
		// core 的链接目标是权威。正因为如此，它先于 callerTarget 检查。
		const linkKind = this.state.pendingLinkKind;
		if (linkKind) {
			this.state.pendingOpenKind.set(leaf, linkKind);
			this.state.pendingLinkKind = undefined;
			this.state.pendingLinkText = undefined;
			window.clearTimeout(this.state.pendingLinkKindTimeout);
			return linkKind;
		}

		// 调用方提交的目标（eState.match 里的搜索命中，或来自大纲 / 反向链接的
		// cursor/scroll/is-flashing）：core 把它放进 ephemeral state 参数，
		// 意思是「在这里打开」，所以在上面再叠保存的位置会把它顶掉。重放时
		// eState 是这个 leaf **自己**缓存的状态，它裸着的光标 / scroll 就是
		// 那个缓存位置 —— 那里只有那些有辨识度的标记才算数。
		if (this.hasCallerTarget(eState, isReplay)) {
			this.state.pendingOpenKind.set(leaf, 'callerTarget');
			return 'callerTarget';
		}

		return undefined;
	}

	private hasCallerTarget(eState: OpenEphemeralState | undefined, isReplay = false): boolean {
		if (!eState)
			return false;
		if (eState.match || eState['is-flashing'])
			return true;
		if (isReplay)
			return false;
		return !!(eState.cursor || eState.scroll != null);
	}

	// 注入形式只有一个来源：保存的位置。没有记录就什么都不注入 —— 笔记按 Obsidian
	// 自己的默认位置打开（顶部）。
	private buildMergedState(st: EphemeralState | undefined): Partial<EphemeralState> {
		const merged: Partial<EphemeralState> = {};
		if (st) {
			if ((st.scroll ?? 0) > 0) merged.scroll = st.scroll;
			if (st.cursor) merged.cursor = st.cursor;
		}
		return merged;
	}

	// 遮住那些头几帧还带着估算高度、因而会被随后的测量推一下的源码 open。**每一个**
	// 带 scroll 注入的源码 open 都要遮，全新 leaf 与同 leaf 切换一视同仁：
	//  - 全新 leaf 的编辑器稍后才建出来，先量自己的文档，注入的 scroll 才落地
	//    —— 第一帧显示的是默认顶部；
	//  - 同 leaf 切换走 core 分阶段的流水线，它在交换后重新测量，会把像素推走。
	// 只有光标的注入从不移动视口，所以第一帧就已经是最终状态，遮上只会多出
	// 一段空白期；阅读类 open 也从不遮。
	//
	// **什么时候真的盖上**：**open 一开始就盖上**（两端一致）。⚠️ 旧写法（甲）等编辑器换上
	// 这篇笔记的内容才盖，特意把读盘那段留给旧画面（「别把 I/O 等待伪装成加载」）—— 可真机上
	// 它读起来是**上一篇闪一下**：文件不在内容缓存里时 core 的 `cachedRead` 要走一次磁盘，那几
	// 帧屏幕上就是上一篇，接着才白、才换新，与点击快慢无关（结构性）。机理见 ui/cover.ts 的
	// cover()（2026-10-09 第十二轮之后改判）。
	//
	// 而下面那道 contentSwapGate 仍然武装，只是它现在**只**管「恢复流水线什么时候能碰编辑
	// 器」，不再管遮盖时机 —— 判据是「编辑器里装的是不是**这一篇**」（见 contentSwapGate）。
	//
	// 盖多久不在这里定：那道遮罩由 modes.ts 的 restoreInjectedSource 收口
	// （pixels.settleShortCover），只盖到编辑器量完为止 —— 目标行的偏移与视口里最后一条
	// 可见行的偏移在同一个窗口里都没离开过窗口起点，下限从第一次量到真几何那一刻起算、
	// 上界从**真正盖上**那一刻起算。这道遮罩 2026-10-08 被整条删掉过一次（改由揭开后的
	// 一次性检查兜落点）：实测空白消失，但读者看见了那几帧的变动 —— 空白与变动只能选一个
	// 侧重，于是它以「短盖」的形态回来。后台注入标签页另有一道（background-settle 的
	// settleBackground），读者看不见它。
	private maybeCoverOpen(leaf: WorkspaceLeaf, filePath: string, hasScroll: boolean) {
		if (!hasScroll)
			return;
		// **open 一开始就盖上**（两端一致）。⚠️ 旧写法（甲）在桌面上特意把读盘那一段留给
		// 旧画面（「别把 I/O 等待伪装成加载」），可真机上它读起来是**上一篇闪一下**：文件不在
		// 内容缓存里时 core 的 `cachedRead` 要走一次磁盘，那几帧屏幕上就是上一篇，接着才白、
		// 才换新 —— 与点击快慢无关（结构性），正是用户报的「打开 C 时看见上一篇的内容闪一下」。
		// 而那次读盘通常远小于短盖自己的下限（SOURCE_COVER_FLOOR_MS 150），拿它换「屏幕上绝不会
		// 出现别的笔记」是划算的（2026-10-09 第十二轮之后改判，见 ui/cover.ts 的 cover()）。
		// 手机端本来就如此（第十轮：选择文件的过程全屏盖住正文，旧画面没有读者）。
		// ⚠️ 判据本身照旧武装（`contentArrived` 仍靠它）—— 遮盖的**时机**提前，但恢复流水线
		// 依然要等新内容真进编辑器。
		this.state.cover.cover(leaf, this.contentSwapGate(leaf, filePath));
	}

	// 这一次 open 的「新内容到了吗」判据 —— **恢复流水线靠它决定什么时候才能碰编辑器**（居中、
	// 短盖量的都是像素，落在上一篇的几何上不只作废：旧文档的几何是稳的，短盖会当场判定
	// 「量完了」而揭幕）。⚠️ 遮罩**动手的时机**不再由它定（open 一开始就盖上，见 maybeCoverOpen
	// 与 ui/cover.ts 的 cover()）—— 它只挡恢复流水线。
	//
	// 分两层，从粗到细：
	//  1. `noteArrived` —— 编辑器里的**文档对象**换掉了没有（见 pixels.noteArrived）。它挡住
	//     「core 还在异步读盘」那几百 ms：core 的 loadFile 先换 view.file、再 await 读盘、
	//     最后才 setData，读盘期间文档还是上一篇的。
	//  2. `expectedContent` —— 现在**装的是不是这一次要打开的那篇**。⚠️ 这一层不是为了更严，
	//     是因为第一层有个真洞：`noteArrived` 只会答一次「换了」，而**任何一个别的笔记都满足
	//     它**。core 的 `FileView.loadFile` 只在自己入口比一次 `this.file === file`，
	//     `await onLoadFile(file)` 之后**没有任何复核**（2026-10-09 解包 obsidian.asar 实测），
	//     所以快速连点 A→B→C 时 A 与 B 的读盘都可能晚于 C 回来、把中间那篇画上去 —— 而短盖
	//     在第一个「换了」上就揭幕了，随后晚到的那一篇一闪（用户报的「打开 C 时看见 A 的内容
	//     闪一下」）。内容比对是唯一能认出**这一篇**的读数。
	//
	// 武装那一刻屏幕上那篇笔记**不是另一篇**时（全新 leaf、非 markdown 视图、同一篇的重放）
	// 根本没有「上一篇」要比：交回 **undefined**（= 没有闸门，恒真）。⚠️ 别写成
	// `() => true` —— 一个恒真函数与「压根没有闸门」在**读者看得见遮罩了吗**那件事上不是
	// 一回事：手机端的遮罩起点要等「这篇内容进视图」（见 ui/cover.ts 的 markVisible /
	// contentShown），而全新 leaf 那一刻视图还没建出来、只能交回恒真 —— 照它算，起点就落在
	// 「涂上容器背景」那一刻，读盘与列表收起动画于是白吃掉短盖的预算。
	private contentSwapGate(leaf: WorkspaceLeaf, filePath: string): (() => boolean) | undefined {
		const from = this.screenNote(leaf, filePath);
		if (from === undefined)
			return undefined;
		const isTarget = this.expectedContent(leaf, filePath);
		return () => this.pixels.noteArrived(leaf.view, from) && (isTarget === undefined || isTarget());
	}

	// 「编辑器里装的是不是**这一次要打开的那篇**」—— 拿那个文件的内容来比。
	//
	// 取不到文件、或这个 vault 不认 cachedRead（测试桩（patcher-inject 的假 app 只有
	// workspace）就是这样）时返回 undefined：那一层判据**缺席**，退回与从前一样的
	// 「文档对象换掉了没有」—— 至少还能挡住读盘那一段。
	//
	// ⚠️ 比拼是 O(内容长度)，而判据每帧都被求值：按**文档身份**记忆。同一次交换只换一次文档
	// 对象，所以整段等待里最多比几次。
	private expectedContent(leaf: WorkspaceLeaf, filePath: string): (() => boolean) | undefined {
		const vault = this.app.vault as Vault | undefined;
		const file = vault?.getAbstractFileByPath?.(filePath);
		if (!file || typeof vault?.cachedRead !== 'function')
			return undefined;
		let text: string | undefined;
		void vault.cachedRead(file as TFile).then(
			(content) => { text = content; },
			() => undefined,
		);
		let seen: object | undefined;
		let seenOk = false;
		return () => {
			const want = text;
			if (want === undefined)
				return false; // 还没读到（一次 microtask）：先当没到
			const view = leaf.view;
			if (!(view instanceof MarkdownView))
				return false;
			const doc = this.pixels.docIdentity(view);
			if (doc !== undefined && doc === seen)
				return seenOk;
			seen = doc;
			seenOk = typeof view.data === 'string' && view.data === want;
			return seenOk;
		};
	}

	// 屏幕上这一刻那篇笔记的身份。这里读的是**旧**视图：本补丁跑在 core 换 view.file
	// 之前（见 installPatches 的包装器）。判据恒真的情形只有三种 —— 全新 leaf、非 markdown
	// 视图、同一篇的重放 —— 它们的共同点是**屏幕上根本没有「上一篇」要留**，于是返回
	// undefined，遮罩照旧立刻盖上正是我们要的。
	//
	// ⚠️ 注意**不能**把「读不到编辑器」也并进那三种里（早先就是这么写的，`MarkdownView.editor`
	// 是 getter，视图刚建/刚重建时确实是 undefined）：那是 2026-10-09 晚上手机上「还是一样的」
	// 的入口 —— 闸门被直接打开，遮罩立刻盖上、整条流水线跑在上一篇上。读不到编辑器时照样
	// 返回一份身份，只是 `doc` 缺席 —— 判据会退到 `view.data`（见 pixels.noteArrived）。
	private screenNote(leaf: WorkspaceLeaf, filePath: string): ScreenNote | undefined {
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || view.file?.path === filePath)
			return undefined;
		return { view, doc: this.pixels.docIdentity(view), data: view.data };
	}

	// 显式的 mode 通常不在这次 open 的视图状态里 —— 它只在切换视图模式时
	// 出现，那时 state.mode 是**目标**模式（leaf.view 报的还是切换前的模式）。
	// 否则退回当前 markdown 视图的模式（覆盖同 leaf 重新打开的情形）；全新
	// leaf 还没有视图，就退回 Obsidian 原生的默认视图模式设置。
	private isSourceModeOpen(leaf: WorkspaceLeaf, viewState: OpenViewState): boolean {
		const mode = viewState.state?.mode;
		if (mode === 'source' || mode === 'preview')
			return mode === 'source';
		const view = leaf.view;
		if (view instanceof MarkdownView)
			return view.getMode() === 'source';
		const vault = this.app.vault as Vault & { getConfig(key: string): unknown };
		return vault.getConfig('defaultViewMode') !== 'preview';
	}
}
