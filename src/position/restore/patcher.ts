import { App, MarkdownView, Vault, Workspace, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState, OpenKind, LANDING_ABSORB_MS } from '@/position/state';
import { readNavEntryState } from '@/position/capture/ephemeral';
import type { NavFunnel } from '@/nav/funnel';
import { stripLinkAlias } from '@/nav/entry';
import { isMainAreaLeaf, isPopoverLeaf } from '@/shared/leaf';
import type { Sampler } from '@/position/capture/sampler';

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

	constructor(app: App, settings: PluginSettings, store: PositionStore, state: PositionState, funnel: NavFunnel, sampler: Sampler) {
		this.app = app;
		this.settings = settings;
		this.store = store;
		this.funnel = funnel;
		this.sampler = sampler;
		this.state = state;
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
	// 回调发出的，也就是在笔记已经按默认位置画出来之后。
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
					// **只遮源码模式**。阅读视图的首绘要异步渲染，大笔记跨文件打开能到
					// 2~3 秒；这段渲染期被遮住就是一整片空白。而阅读模式的落点本来就有
					// core 自己的渲染流水线接着（注入的 `{scroll}` 走 applyScrollDelayed，
					// 渲染器一就绪就落定），没有「未恢复的顶部」需要藏（见 modes.ts 的
					// maskedRestoreSt）。
					this.maybeCoverOpen(leaf, isSource && (merged.scroll ?? 0) > 0);
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

		this.maybeCoverOpen(leaf, (merged.scroll ?? 0) > 0);

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

	// 遮住那些头几帧否则会画出未恢复的顶部、或落定时的纠正的 open。**每一个**
	// 带 scroll 注入的源码 open 都要遮，全新 leaf 与同 leaf 切换一视同仁：
	//  - 全新 leaf 的编辑器稍后才建出来，先量自己的文档，注入的 scroll 才落地
	//    —— 第一帧显示的是默认顶部；
	//  - 同 leaf 切换走 core 分阶段的流水线，它在交换后重新测量，可能在原子
	//    apply 之后把像素推走；修正这一切的那次落定必须在看不见时跑，否则
	//    每次纠正读起来都像一次跳。
	// 只有光标的注入从不移动视口，所以第一帧就已经是最终状态，遮上只会多出
	// 一段空白期；阅读类 open 也从不遮。restoreEphemeralState 的注入分支先
	// 落定再揭开遮罩；后台 open 由安全定时器兜住上界。
	private maybeCoverOpen(leaf: WorkspaceLeaf, hasScroll: boolean) {
		if (!hasScroll)
			return;
		this.state.cover.cover(leaf);
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
