import { MarkdownView, WorkspaceLeaf } from 'obsidian';

// 首绘遮罩的最坏情况上界，只有一次恢复都没跑时才会到达。它必须比整个被遮住的阶段都长 ——
// 等内容就绪 + 落定 + 揭示前的那段静默保持（从恢复入口起 SETTLE_HOLD_MAX_MS 1250ms）——
// 还要有余量，好让一次慢的恢复永远不会在画到一半或保持到一半时被切断。
const COVER_SAFETY_MS = 2000;

// WorkspaceLeaf.containerEl 是内部的 —— Obsidian 公开类型里没有。
function leafContainer(leaf: WorkspaceLeaf): HTMLElement {
	return (leaf as unknown as { containerEl: HTMLElement }).containerEl;
}

// 在一次 open 首绘之前把它遮住。'file-open' 是经由一个防抖（setTimeout 0）回调发的 —— 那时视图
// 已经在顶部画完了 —— 所以光靠恢复自带的遮罩挡不住那一帧。leaf 那个常驻的 .view-content
// 会被进来的视图复用，所以在这里、与 open 同步地把它藏起来，就能遮住首绘；随后恢复在目标位置
// 揭示，而一个有界的保险定时器保证遮罩绝不会赖着不走（后台打开不产生 file-open；
// 恢复被跳过、或走链接导航时压根不调恢复）。
//
// 阅读模式的打开（异步渲染）与注入式来源的打开（新编辑器在滚动落地前先量一次）都会画出未恢复的
// 顶部，所以两者都走 cover()。
export class OpenCover {
	private pendingTimers: Map<WorkspaceLeaf, number> = new Map();

	isCovered(leaf: WorkspaceLeaf): boolean {
		return this.pendingTimers.has(leaf);
	}

	cover(leaf: WorkspaceLeaf): void {
		// 已经遮着时再遮一次（重放的重注入）不能开出第二个 reapplyCover 循环 —— 正在跑的那个
		// 循环会一直遮到 uncover()；这里只刷新下面的保险定时器。
		const wasCovered = this.pendingTimers.has(leaf);
		this.coverLeaf(leaf);
		const existing = this.pendingTimers.get(leaf);
		if (existing)
			window.clearTimeout(existing);
		// 移除表项归 uncover() 管，所以这个表项始终是「是否遮着」的唯一事实源，
		// uncover 的提前返回也才一直成立。
		this.pendingTimers.set(leaf, window.setTimeout(() => {
			this.uncover(leaf);
		}, COVER_SAFETY_MS));

		// 一个全新的 leaf 要到进来的视图构造函数里才建出它的 .view-content，而那在这段补丁返回
		// 之后才跑；同一个 leaf 的切换又可能用进来的视图自己的节点**替换**掉被遮住的那个。
		// 所以每帧重施一次（赶在绘制之前），直到揭示为止，好让任何新搭出来的 .view-content
		// 在自己的第一帧之前就被藏住。揭示或保险定时器都会让它停 —— 两者都走 uncover()。
		if (!wasCovered)
			window.requestAnimationFrame(() => this.reapplyCover(leaf));
	}

	uncover(leaf: WorkspaceLeaf): void {
		const pending = this.pendingTimers.get(leaf);
		if (!pending)
			return; // 没被遮：没有定时器要清，没有 DOM 要还原
		window.clearTimeout(pending);
		this.pendingTimers.delete(leaf);
		const vc = leafContainer(leaf).querySelector('.view-content');
		if (vc instanceof HTMLElement)
			vc.setCssStyles({ opacity: '' });
		leafContainer(leaf).setCssStyles({ opacity: '' });
		leafContainer(leaf).setCssStyles({ backgroundColor: '' });
	}

	// maskedRestore 通过把视图 contentEl 的 opacity 置 0 来遮住一次正在进行的恢复
	// （它自带的恢复遮罩）。所有 contentEl 遮罩操作都归这里管，以免恢复路径到处散落裸样式访问：
	// cover()/uncover() 是 leaf 的首绘遮罩，下面两个方法是恢复遮罩。两者都按 leaf 作键，
	// 并通过各自的清理路径揭示。
	restoreCover(view: MarkdownView): void {
		view.contentEl.setCssStyles({ opacity: '0' });
	}

	// 一次被顶掉的 maskedRestore 会让 contentEl 留在隐藏状态，因为它的 finally 只在仍是最新时
	// 才清；这个方法在下次恢复开头被回调 —— 在第一个 await 之前 —— 好让后续那次恢复从可见开始。
	// 它也是 maskedRestore 的 finally 在仍是最新时跑的清理。每个恢复分支要么在绘制前同步重施
	// 这层遮罩，要么本就该显示 core 已施好的状态，所以在这里揭示永远不会闪出未恢复的顶部。
	revealRestoreCover(view: MarkdownView): void {
		view.contentEl.setCssStyles({ opacity: '' });
	}

	// 遮住这次 open 而不露出主题的页面背景。把 leaf.containerEl 本身置 opacity:0 会让整个 leaf
	// （连同它的内容卡片）变透明，露出主题画在背后的东西 —— 比如 Soft Paper 的宝蓝
	// --tab-container-background。所以只藏内层的 .view-content，卡片自己的背景仍然可见；
	// 而那个元素还没建出来时（全新的 leaf），就用主题的笔记背景刷一下容器，
	// 让这块地方读起来像一张空白笔记，而不是它背后的页面。
	// @returns leaf 的 .view-content 存在且已被遮住时返回 true；
	//          只刷了容器背景时返回 false。
	private coverLeaf(leaf: WorkspaceLeaf): boolean {
		const vc = leafContainer(leaf).querySelector('.view-content');
		if (vc instanceof HTMLElement) {
			vc.setCssStyles({ opacity: '0' });
			leafContainer(leaf).setCssStyles({ backgroundColor: '' });
			return true;
		}
		leafContainer(leaf).setCssStyles({ backgroundColor: 'var(--background-primary)' });
		return false;
	}

	// 逮住第一次 open 新搭出来的 .view-content，以及同 leaf 视图交换时被**替换**的那个 ——
	// 被替换的节点生来就是没藏过的，所以「藏过一次」不等于「藏到揭示为止」。uncover() 是唯一出口。
	private reapplyCover(leaf: WorkspaceLeaf): void {
		if (!this.pendingTimers.has(leaf))
			return;
		this.coverLeaf(leaf);
		window.requestAnimationFrame(() => this.reapplyCover(leaf));
	}
}
