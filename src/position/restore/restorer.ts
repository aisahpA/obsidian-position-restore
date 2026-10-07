import { App, FileView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { getScroller, nextPaint } from '@/shared/wait';
import { isPopoverLeaf } from '@/shared/leaf';
import { PositionState } from '@/position/state';
import { RestoreModes } from './modes';

// 在 open 之后恢复保存的位置。各模式的策略（masked / 不遮的阅读落点 / 注入源码，
// 以及共享锚点）住在 ./modes，源码模式的像素纠正住在 ./pixels，纯粹的 view<->state 辅助
// 住在 ../capture/ephemeral，绘制观察住在 ../../shared/wait，首绘遮罩与 cue 住在
// ../ui。所有跨阶段协调用的标记都归共享的 PositionState 所有。
export class Restorer {
	private app: App;
	private settings: PluginSettings;
	private state: PositionState;
	private store: PositionStore;
	private modes: RestoreModes;

	constructor(app: App, settings: PluginSettings, store: PositionStore, state: PositionState) {
		this.app = app;
		this.settings = settings;
		this.store = store;
		this.state = state;
		this.modes = new RestoreModes(this.state);
	}

	// markdown 视图交给 restoreMarkdown；base 视图的记录是滚动采集监听器存下的
	// 裸 scrollTop，走 restoreFileViewScroll（由 recordBaseScroll 选择开启）。
	// PDF 从不恢复：原生的 PDF.js 历史已经处理了同设备的位置，而跨设备的
	// scrollTop 并不符合本设备的视口，再加一个恢复器只会和原生的打架。其它
	// FileView 干脆从不记录。
	async restoreEphemeralState() {
		const fv = this.app.workspace.getActiveViewOfType(FileView);
		if (!fv?.file)
			return;
		// 悬停浮层里的一个 leaf 是个恰巧可编辑的**预览**：它就在 app 打开预览的
		// 地方打开，而恢复带来的遮罩会让它空白着，直到落定跑完为止。
		if (isPopoverLeaf(fv.leaf))
			return;

		if (fv instanceof MarkdownView) {
			await this.restoreMarkdown(fv);
			return;
		} 
		
		if (fv.getViewType() === 'bases' && this.settings.recordBaseScroll)
			await this.restoreFileViewScroll(fv);
		else
			// 不恢复：仍要丢掉上一个文件留下的提示条，与 restoreMarkdown
			// open 时重置 cue 的行为一致。
			this.state.cue.hide();
	}

	// 补完一次「在刚激活的 leaf 上从未触发 'file-open'」的 open 的恢复 —— 两种
	// 情形，靠一个注入标记区分：
	//
	//  1. 带着注入标记：某次后台 open 在 setViewState 那一刻注入了位置，但只有
	//     第一次激活才建出被推迟的视图，而活动文件没变，所以后面不会跟来
	//     'file-open'。
	//  2. 无标记的同文件激活：阅读 / 源码滑行标签页从不注入，但同文件激活必然
	//     不触发 file-open（'file-open' 只在活动**文件**变化时触发）。真正的
	//     open 会触发自己的 'file-open'、从不在这里被处理，所以不会与它竞争。
	//
	// 'active-leaf-change' 只带来新的 leaf，所以上一个活动文件来自
	// state.lastActiveFilePath，在下面（await 之前）同步滑走。推迟一帧，再对着
	// **当前**活动视图重新解析，因为「恰好一次」不能交给定时器的先后 —— 真正
	// open 那次防抖的 'file-open'（setTimeout(0)）不保证在这个 rAF 之前跑。
	// 无标记分支：await 前先滑走，意味着真正 open 的新文件永远匹配不上。标记
	// 分支：如果它先跑，就通过 restoreOpen 恢复当前文件，而后者的 inflight +
	// 去重守卫会让真正 open 自己的 'file-open' 变成空操作。
	async completeInjectedRestore(leaf: WorkspaceLeaf | null) {
		if (!this.app.workspace.layoutReady)
			return;
		// 同步滑走（await 之前），好让**下一次**激活看到正确的前一个文件，
		// 哪怕接连快速切换。
		const oldFilePath = this.state.lastActiveFilePath;
		const newFilePath = (leaf?.view as FileView | undefined)?.file?.path;
		this.state.lastActiveFilePath = newFilePath;
		await nextPaint();
		const fv = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!fv?.file)
			return;
		const leafId = this.state.leafId(fv.leaf);
		const filePath = fv.file.path;
		if (this.state.injectedOpenLeafIds.has(leafId)) {
			// 标记还在 -> 不会有 file-open 来消费它：通过共享流水线跑那次注入
			// 恢复（在仍然盖着的首绘遮罩下落定，然后揭开 + 锚定）。
			await this.restoreEphemeralState();
			return;
		}
		// 无标记分支：一个未处理 leaf 的同文件激活（它被推迟的视图刚刚建好）。
		// 它自己的恢复必须走共享流水线，后者处理活动 leaf 的锚定 + 去重。
		if (oldFilePath !== filePath)
			return;
		if (this.state.handledLeafIdMap.get(leafId) === filePath)
			return;
		await this.restoreEphemeralState();
	}

	// restoreOpen 掌管这次 open 的账本（cue、遮罩、跳转、去重、run 令牌）；这里
	// 只按视图模式分发。
	private async restoreMarkdown(view: MarkdownView) {
		const filePath = view.file?.path;
		if (!filePath)
			return;

		await this.restoreOpen(view, filePath, async (isCurrent, injected, injectedSt) => {
			// 一次注入的 open 被补丁交给了一个**特定的**落点（遍历目标自己的条目
			// 位置，或作为退路的文件记录）。改成落定到 store 记录，会和 core
			// 实际应用的那一行打架：跨文件的历史跳转之后，这两者故意不同 ——
			// 记录是读者漂到的地方，而这一步的落点才是那一行当初承诺的。
			const st = injectedSt ?? this.store.read(this.state.leafId(view.leaf), filePath);
			const mode = view.getMode();

			// 每个分支自己管自己的「无记录」处理，好让两者不跨模式泄漏。没有记录
			// 就什么都不做 —— 笔记停在 Obsidian 自己的默认位置（顶部）。
			// 注入的 open 放最前：历史遍历一律注入并遮住（「必须瞬间落定」），
			// 它要的正是「在首绘遮罩下落定、再揭幕」这一套。
			if (mode === 'source') {
				if (!st)
					return;
				if (injected)
					await this.modes.restoreInjectedSource(view, st, isCurrent);
				else
					await this.modes.maskedRestoreSt(view, st, isCurrent);
				return;
			}

			if (mode === 'preview') {
				// 阅读视图从顶部渲染，从不应用默认位置 —— 没有记录就没有可恢复的
				// 东西。
				if (!st)
					return;
				// 一次**注入过**的阅读落点不遮：那个位置已经随这次 open 交到 core
				// 自己的渲染流水线上（patcher 注入的 `{scroll}` —— applyScrollDelayed
				// 在渲染器就绪时落它），所以没有「未恢复的顶部」要藏，而遮罩会把整段
				// 异步渲染期变成空白（跨文件的大笔记 2~3 秒）。其余阅读恢复没有人替它
				// 落定，遮罩照旧。
				else if (injected)
					await this.modes.landPreview(view, st, isCurrent);
				else
					await this.modes.maskedRestoreSt(view, st, isCurrent);
			}
		});
	}

	// bases 视图只恢复 scroll：它们可记录的状态就是一个数，所以恢复就是等视图
	// 有了滚动容器后应用它（landBaseScroll）。这里不遮 —— 'file-open' 在首绘
	// 之后才触发，这么晚才遮上只会在那次跳之上再加一道空白闪。
	private async restoreFileViewScroll(view: FileView) {
		const filePath = view.file?.path;
		if (!filePath)
			return;

		await this.restoreOpen(view, filePath, async (isCurrent) => {
			await this.landBaseScroll(view, filePath, isCurrent);
		});
	}

	// markdown 与 bases open 共用的流水线：重置 cue 提示条，揭开任何过期的
	// masked 恢复遮罩，消费一次待定的 open-kind 跳转，给 leaf+file 去重，然后用
	// restoreStarted/restoreEnded 的 run 令牌把分发体括起来 —— 体内每一次 await
	// 在碰视图之前都会重新检查返回的 isCurrent。这次 open 不需要恢复（跳转或
	// 去重）时不跑体内逻辑直接返回：skipRestoreAndAnchor 已经重新锚好了记录
	// 基准。
	private async restoreOpen(
		view: FileView,
		filePath: string,
		body: (isCurrent: () => boolean, injected: boolean, injectedSt: EphemeralState | undefined) => Promise<void>,
	) {
		const isMarkdown = view instanceof MarkdownView;
		const leafId = this.state.leafId(view.leaf);

		// 针对这个确切的 leaf+file 的恢复已经在跑了（active-leaf-change 补完正在
		// 跑落定时来了一个 'file-open'，或反过来）。正在跑的那次恢复管揭开：
		// 整个跳过 —— 不顶替、不揭开（那会在落定途中把首绘遮罩揭掉）、不重锚。
		// 同一个 leaf 上的**不同**文件，仍然在下面顶替。
		const inflight = this.state.inFlightRestoreLeafRuns.get(leafId);
		if (inflight && inflight.filePath === filePath)
			return;

		// 在揭开的门控与去重检查之前消费，这样一次去重命中（单纯的标签页激活）
		// 仍会清掉标记，之后重新打开还能再恢复。按 leaf id 作键 —— 同一个文件
		// 开在两个标签页时，每个标签页的标记由它自己的 file-open 消费
		// （见 injectedOpenLeafPaths）。
		const injected = isMarkdown && this.state.injectedOpenLeafIds.delete(leafId);
		// 那次注入的 open 被交给的落点，与它的标记一起消费（之后重复的 file-open
		// 读不到标记，所以它也不该读到落点）。
		const injectedSt = injected ? this.state.injectedLeafStates.get(leafId) : undefined;
		if (injected)
			this.state.injectedLeafStates.delete(leafId);

		// 揭开任何过期的恢复遮罩；分发体按需重新遮上。一个 leaf 首绘遮罩还盖着
		// 的注入 open，绝不能在这里被揭开：view.contentEl 与 leaf 遮罩的
		// .view-content 是**同一个**元素，所以清掉 contentEl 会在落定跑完之前
		// 就把首绘遮罩揭开 —— 落定前的像素就成了可见的闪烁。
		// restoreInjectedSource 里那个被遮住的分支管这次揭开。
		if (isMarkdown && !(injected && this.state.cover.isCovered(view.leaf)))
			this.state.cover.revealRestoreCover(view);

		// OpenKind 跳转（anchorLink / startPlainLink / callerTarget）是精确的
		// 原生跳转 —— core 已经在它自己的目标处打开了，注入也被跳过了。绝不
		// 恢复；只需重锚变化检测，好让这次落点本身不被记下来。
		const openKind = this.state.pendingOpenKind.get(view.leaf);
		if (openKind) {
			this.state.pendingOpenKind.delete(view.leaf);
			// 一次真正的 open 切换：不会再有新 cue 显示，所以丢掉上一个文件留下的
			// 提示条。这不是单纯的重激活，所以在这里隐藏是安全的。
			this.state.cue.hide();
			// 这次落点由补丁在 setViewState 时装好的锚来吸收
			// （见 injectEphemeralStateOnOpen）—— 在这里再装一次会**漏掉**同文件
			// 的搜索跳转，那些从不触发 'file-open'。
			this.skipRestoreAndAnchor(view, filePath);
			return;
		}

		// 去重：Obsidian 会反复触发 'file-open'（切换窗格、恢复工作区、单纯的
		// 标签页激活）。每一个 leaf+file 组合只恢复一次，否则光标会一直跳回保存的
		// 位置。注入的 open 绕过去重：它们的 file-open 必须跑 restoreInjectedSource
		// （落定 + 揭开遮罩），哪怕这一对已经被处理过 —— 补丁在注入时就记下了
		// 已处理的配对，否则一次重放的 open 会被去重进 skipRestoreAndAnchor，
		// 而后者会在落定之前把遮罩揭开。
		if (!injected && this.hasOpenedLeafPath(view.leaf, filePath)) {
			// 单纯的重激活（切换窗格、重复的 'file-open' 事件 —— 在 Android 上很
			// 频繁）。一个已经在显示的 cue 别去动它：它自己的自动隐藏定时器会让它
			// 退场。在这里隐藏，会在恢复锚定之后重复事件落下的那一瞬杀掉一个刚
			// 显示的提示条 —— 面包屑「一闪而过」。
			this.skipRestoreAndAnchor(view, filePath);
			return;
		}

		// 一次真正的恢复会顶掉上一个文件那条 cue 留下的任何提示条。
		this.state.cue.hide();

		// 取消任何仍在跑的恢复：快速切换文件会复用同一个视图实例，所以一个过期的
		// 恢复循环会一直把上一个文件的位置应用到新笔记上 —— 随机的最终位置、
		// 闪烁，以及经轮询循环写坏的记录。
		//
		// 顶替是按 **leaf** 划分范围的，从不全局：在 B 窗格打开 Y 时，A 窗格的
		// masked 恢复正遮到一半，绝不能作废 A 窗格 —— 它的遮罩没有安全定时器，
		// 会一直停在 opacity 0，位置永远恢复不了。
		const run = this.state.beginLeafRestore(leafId, filePath);
		const isCurrent = () => this.state.isCurrentLeafRestore(leafId, run)
			&& view.file?.path === filePath;

		this.state.restoreStarted();
		try {
			this.state.lastEphemeralState = undefined;
			this.state.lastLoadedFilePath = filePath;
			await body(isCurrent, injected, injectedSt);
		} finally {
			// 只有胜出的那次恢复移除自己的条目：被顶替的 run 不再匹配，所以它
			// 绝不能删掉同一个 leaf 更新的那条条目。
			const cur = this.state.inFlightRestoreLeafRuns.get(leafId);
			if (cur && cur.run === run)
				this.state.inFlightRestoreLeafRuns.delete(leafId);
			this.state.restoreEnded();
		}
	}

	// 读出保存的像素，等 bases 视图有了滚动容器（异步建出，有界等待）后落上去。
	// 一旦找到它就一直在：`.bases-view` 是视图自己的根，重渲染只替换它里面的
	// 卡片内容。Bases 懒加载行，所以首次落定之后文档还会长 —— 漂了就重发，
	// 直到那个值稳住（有界，并节流，免得一个内容够不到的值每帧都折腾）。
	private async landBaseScroll(view: FileView, filePath: string, isCurrent: () => boolean) {
		const st = this.store.read(this.state.leafId(view.leaf), filePath);
		const scroll = st?.scroll ?? 0;
		if (scroll <= 0)
			return;

		const findDeadline = Date.now() + 500;
		let scroller: HTMLElement | null = null;
		while (isCurrent() && !scroller && Date.now() < findDeadline) {
			scroller = getScroller(view);
			if (!scroller)
				await nextPaint();
		}

		const landDeadline = Date.now() + 2000;
		let lastApply = 0;
		let stableFrames = 0;
		while (isCurrent() && scroller && Date.now() < landDeadline) {
			if (Math.abs(scroller.scrollTop - scroll) <= 1) {
				if (++stableFrames >= 3)
					break;
			} else {
				stableFrames = 0;
				if (Date.now() - lastApply >= 100) {
					scroller.scrollTop = scroll;
					lastApply = Date.now();
				}
			}
			await nextPaint();
		}
	}

	// 把变化检测重锚到活动文件并清掉轮询基准，这样之后用户的移动 —— 而不是落点
	// —— 才是下一个被记录的变更；顺带揭开仍施加在这个 leaf 上的任何遮罩。
	// 两个调用点：一次去重命中（没什么要重新应用的；清掉基准可避免 Obsidian 自己的
	// 滚动恢复滑掉时轮询拿过期记录去比）与 open-kind 跳转（core 已经在它自己精确的
	// 目标处打开了；锚到落点会把这次跳转本身记下来）。
	private skipRestoreAndAnchor(view: FileView, filePath: string) {
		this.state.lastEphemeralState = undefined;
		this.state.lastLoadedFilePath = filePath;
		// 从这里也开始跑 open 后的重排守卫：去重过的重激活与 open-kind 跳转经由
		// Obsidian 自己的流水线落地，可能像一次恢复那样重排。
		this.state.lastAnchorAt = Date.now();
		// 既要揭开 leaf 级的遮罩**又**要清掉 view.contentEl 上过期的 maskedRestore
		// 遮罩 —— 一次被顶替的恢复可能把它留在了隐藏状态。
		this.state.cover.uncover(view.leaf);
	}

	private hasOpenedLeafPath(leaf: WorkspaceLeaf, filePath: string): boolean {
		const leafId = this.state.leafId(leaf);
		const existPath = this.state.handledLeafIdMap.get(leafId);
		if (existPath) {
			if (existPath === filePath)
				return true;
			this.state.handledLeafIdMap.set(leafId, filePath);
			return false;
		}
		// 没有条目的 leaf 是一次全新的 open —— 绝不跳过它的恢复。只记 leaf id，
		// 从不记 view.file：快速切换时它已经指向一个恢复还没跑的文件（setViewState
		// 在防抖的 'file-open' 之前就换掉了 view.file），记它会把恢复搁浅在顶部。
		this.pruneStaleLeafIds();
		this.state.handledLeafIdMap.set(leafId, filePath);
		return false;
	}

	// 修剪掉那些已经不再打开的 leaf 的已处理条目。只读 leaf id（每个 leaf 实例
	// 稳定）—— 它连切换途中都安全，view.file 则不然。遍历**所有** leaf，不只是
	// markdown 的：pdf / 图片 leaf 也持有去重条目，修剪掉它们的会让那个文件在每次
	// 标签页激活时重新滚动。既在全新 open（去重检查）时跑，**也**在落盘点
	// （storePositionData）跑：关闭 leaf 没有专门的事件，所以没有落盘点这一次
	// 调用，死记录会进到那个 overlay 快照里。这一次工作区扫描与 store 的修剪
	// 共用一个。
	public pruneStaleLeafIds(): void {
		const liveIds = new Set<string>();
		// 故意用块语句体：这个回调**必须**返回 undefined。Obsidian 的 iterate
		// 辅助函数会把回调结果当成提前中断的信号（iterateRefs 上有记载），所以
		// 一个返回 Set 的表达式体会在几个 leaf 之后中断扫描 —— liveIds 收集不足，
		// 活着的条目被错误修剪（2026-09 排查过：16 个 leaf 只访问了 3 个）。
		this.app.workspace.iterateAllLeaves((leaf) => {
			liveIds.add(this.state.leafId(leaf));
		});
		for (const id of this.state.handledLeafIdMap.keys())
			if (!liveIds.has(id))
				this.state.handledLeafIdMap.delete(id);
		// 同样出于这个理由，也丢掉已关闭 leaf 的注入标记（那些 file-open 从未
		// 触发的后台 open）。
		for (const id of this.state.injectedOpenLeafIds)
			if (!liveIds.has(id))
				this.state.injectedOpenLeafIds.delete(id);
		for (const id of this.state.injectedLeafStates.keys())
			if (!liveIds.has(id))
				this.state.injectedLeafStates.delete(id);
		for (const leaf of this.state.pendingOpenKind.keys())
			if (!liveIds.has(this.state.leafId(leaf)))
				this.state.pendingOpenKind.delete(leaf);
		this.store.pruneDeadLeaves(liveIds);
	}
}
