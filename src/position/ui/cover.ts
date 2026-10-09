import { MarkdownView, Platform, WorkspaceLeaf } from 'obsidian';

// 首绘遮罩的最坏情况上界，只有一次恢复都没跑时才会到达。它必须比整个被遮住的阶段都长 ——
// 等内容就绪 + 落定 + 揭示前的那段静默保持（从恢复入口起 SETTLE_HOLD_MAX_MS 1250ms）——
// 还要有余量，好让一次慢的恢复永远不会在画到一半或保持到一半时被切断。
// **从读者看得见那一刻起算**（见 cover() 与 markVisible）：在它之前这道遮罩什么也没遮住。
const COVER_SAFETY_MS = 2000;

// WorkspaceLeaf.containerEl 是内部的 —— Obsidian 公开类型里没有。
function leafContainer(leaf: WorkspaceLeaf): HTMLElement {
	return (leaf as unknown as { containerEl: HTMLElement }).containerEl;
}

// 在一次 open 首绘之前把它遮住。'file-open' 是经由一个防抖（setTimeout 0）回调发的 —— 那时视图
// 已经在顶部画完了 —— 所以光靠恢复自带的遮罩挡不住那一帧。leaf 那个常驻的 .view-content
// 会被进来的视图复用，所以在这里、与 open 同步地把它遮住；随后恢复在目标位置揭示，
// 而一个有界的保险定时器保证遮罩绝不会赖着不走（后台打开不产生 file-open；
// 恢复被跳过、或走链接导航时压根不调恢复）。
//
// **两处用，区别只在「盖多久」**：
//  · 活动标签页的源码注入 open（patcher.maybeCoverOpen）—— **open 一开始就盖上**，只盖到编辑器
//    **量完**为止（目标行的偏移与视口里最后一条可见行的偏移在同一个窗口里都没离开过窗口起点，
//    见 pixels.settleShortCover）；
//  · 后台注入标签页的落定（background-settle 的 settleBackground）—— 视图已建好、
//    但第一次激活之前没有任何东西替它落定，而读者看不见那个 leaf：可以盖到静默为止。
// 阅读视图与「只有光标」的注入从不预遮。
//
// 一个 leaf 上那道遮罩的状态：保险定时器、它是**什么时候被读者看见的**，以及调用方给的
// 「这篇内容到了吗」判据。遮罩**涂上**与**读者看得见**是两件事，`appliedAt` 记的是后者 ——
// 短盖的上界与保险定时器都从它起算，而它们管的是「读者看见的空白有多长」。揭幕的**下限**不在
// 这里：core 自己的 scroll 重落窗口是跟着内容交换走的，所以短盖自己从「第一次量到真几何」起算
// （见 pixels.settleShortCover）。
interface CoverEntry {
	timer: number;
	// **读者看得见**这道遮罩是从哪一刻起的（毫秒时间戳）；还没盖上、或没盖着时 undefined。
	// 桌面上就是遮罩涂上 `.view-content` 那一刻（涂上就看得见）；手机端遮罩虽然也在
	// setViewState 那一刻就涂上，可那时全屏的文件列表还盖着正文，读者什么都还没看见 ——
	// 起点落在**这篇内容进视图**那一刻（见 markVisible）。
	appliedAt?: number;
	// 「**这一次** open 要打开的那篇笔记的内容到了吗」（见 patcher.contentSwapGate）。
	// **缺席（undefined）= 没有闸门**：这次 open 武装的时候屏幕上并没有「上一篇」要留
	// （全新 leaf / 非 markdown / 同一篇的重放），于是它恒真 —— 但「恒真」与「没有闸门」在
	// 下游不是一回事：手机端的遮罩起点要问 leaf「这篇内容进视图了吗」（见 markVisible），
	// 而恒真函数答不了。
	// 判据由 patcher 在武装时装好 —— 第一次求值发生在装上之后的第一个 rAF 上，之后每帧一次，
	// 所以它读的是 leaf **当下**的视图（同 leaf 换文件时视图实例与内容都会变，见 cover()）。
	// 同一个 leaf 上再武装一次（重放的重注入、或快速连点换了文件）时：**定义了的替换旧的、
	// 缺席的留给旧的**（见 cover() —— 两种重入各要一边）。
	ready?: () => boolean;
}

export class OpenCover {
	private covered: Map<WorkspaceLeaf, CoverEntry> = new Map();

	isCovered(leaf: WorkspaceLeaf): boolean {
		return this.covered.has(leaf);
	}

	// 这道遮罩**读者看得见**的时刻（毫秒时间戳）；还没盖上、或没盖着时返回 undefined ——
	// 调用方据此判断「屏幕上有没有被我藏起来的空白」（见 CoverEntry.appliedAt）。
	appliedAt(leaf: WorkspaceLeaf): number | undefined {
		return this.covered.get(leaf)?.appliedAt;
	}

	// 这次 open 的「新内容到了吗」现在成立吗 —— 恢复那条路（modes.restoreInjectedSource）
	// 借用它，好在碰编辑器之前先确认**这篇**笔记的内容已经进到编辑器里（居中与短盖量的都是
	// 像素，落在上一篇的几何上全是白做，见 pixels.noteArrived）。本来就没盖布时返回 true：
	// 没有别的笔记要等它让位，也就没什么可等的。
	contentArrived(leaf: WorkspaceLeaf): boolean {
		const entry = this.covered.get(leaf);
		return entry?.ready ? entry.ready() : true;
	}

	// 遮住这个 leaf，**与 open 同步地动手**。'file-open' 是经一个防抖回调发的，那时视图已经在
	// 顶部画完了，所以光靠恢复自带的遮罩挡不住首绘；而同 leaf 换文件时 core 还要**异步读盘**
	// （文件越大越久），那段里 `.view-content` 里留着的还是**上一篇笔记**。
	//
	// ⚠️ **读盘那段也盖上 —— 2026-10-09 第十二轮之后改判（旧写法「甲」特意把它留给旧画面）。**
	// 「留着旧画面」与「盖上」只差**那一次读盘的时间**，而它在真机上读起来是**上一篇闪一下**：
	// 文件不在内容缓存里时 `cachedRead` 要走一次磁盘，那几帧屏幕上就是上一篇，接着才白、才换新
	// —— 与点击快慢无关（它是结构性的），正是用户报的「打开 C 时看见上一篇的内容闪一下」。
	// 而那次读盘通常**远小于短盖自己的下限**（SOURCE_COVER_FLOOR_MS 150），拿它去换「屏幕上
	// 绝不会出现别的笔记」是划算的。手机端本来就如此（第十轮：选择文件的过程全屏盖住正文，
	// 旧画面没有读者）—— 现在两端一致。
	//
	// ⚠️ 这只管**遮罩什么时候动手**，`contentArrived` 与它无关 —— 恢复流水线仍要等新内容真进
	// 编辑器，绝不许跑在上一篇的几何上（见 pixels.noteArrived）。
	//
	// 于是「读者看得见这道遮罩」有它自己的时刻 `appliedAt`（见 markVisible），它才是短盖上界与
	// 保险定时器的起点。已经遮着时再遮一次（重放的重注入）不能开出第二个 reapplyCover 循环 ——
	// 正在跑的那个循环会一直遮到 uncover()；这里只刷新保险定时器，并保住最初的起点
	// （重注入属于同一次 open，不该被推迟）。
	cover(leaf: WorkspaceLeaf, ready?: () => boolean): void {
		const existing = this.covered.get(leaf);
		if (existing)
			window.clearTimeout(existing.timer);
		// 移除表项归 uncover() 管，所以这个表项始终是「是否遮着」的唯一事实源，
		// uncover 的提前返回也才一直成立。
		const entry: CoverEntry = {
			timer: 0,
			// **定义了的判据替换旧的；缺席的留给旧的。** 两种重入各要一边：
			//  · core 会**重放** setViewState（未激活标签页的延迟重建、快速切换器再次选中当前
			//    文件）。重放那一刻 leaf 上那个视图握着的**就是**这次要打开的文件，patcher 的
			//    contentSwapGate 于是找不出「上一篇」的身份，只能交回**缺席**（`undefined`）。
			//    让缺席的顶掉先武装的闸门，恢复流水线整条跑在旧文档的几何上（旧文档是稳的，
			//    短盖当场判定「量完了」而揭幕）。所以缺席时**保住已有的那道** —— 这正是 `??`
			//    的行为，也是这里没有写成三目的原因。
			//  · 但**换了文件**的重入（快速连点 A→B→C）是另一回事：那几道闸门问的都是「这一篇
			//    的内容进编辑器了吗」，而**留着最先武装的那道**会让短盖等在 A 上 —— 中间篇被
			//    画出来的那一瞬它就揭幕了（用户报的「打开 C 时看见 A 的内容闪一下」）。
			//    所以定义了的判据要顶掉旧的：最后一次武装的那道（对应最后点的那个文件）说了算。
			//    ⚠️ 判据为什么按**内容**认而不是「文档对象换掉了没有」，见 patcher.contentSwapGate。
			ready: ready ?? existing?.ready,
			appliedAt: existing?.appliedAt,
		};
		this.covered.set(leaf, entry);
		this.applyCover(leaf);
		this.markVisible(leaf, entry);
		entry.timer = window.setTimeout(() => {
			this.uncover(leaf);
		}, COVER_SAFETY_MS);

		// 一个全新的 leaf 要到进来的视图构造函数里才建出它的 .view-content，而那在这段补丁返回
		// 之后才跑；同一个 leaf 的切换又可能用进来的视图自己的节点**替换**掉被遮住的那个。
		// 所以每帧重施一次（赶在绘制之前），直到揭示为止，好让任何新搭出来的 .view-content
		// 在自己的第一帧之前就被藏住。揭示或保险定时器都会让它停 —— 两者都走 uncover()。
		if (!existing)
			window.requestAnimationFrame(() => this.reapplyCover(leaf));
	}

	uncover(leaf: WorkspaceLeaf): void {
		const pending = this.covered.get(leaf);
		if (!pending)
			return; // 没被遮：没有定时器要清，没有 DOM 要还原
		window.clearTimeout(pending.timer);
		this.covered.delete(leaf);
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

	// 遮住这次 open 的首绘而不露出主题的页面背景。把 leaf.containerEl 本身置 opacity:0 会让整个 leaf
	// （连同它的内容卡片）变透明，露出主题画在背后的东西 —— 比如 Soft Paper 的宝蓝
	// --tab-container-background。所以只藏内层的 .view-content，卡片自己的背景仍然可见；
	// 而那个元素还没建出来时（全新的 leaf），就用主题的笔记背景刷一下容器，
	// 让这块地方读起来像一张空白笔记，而不是它背后的页面。
	// 每帧重施（见 reapplyCover），所以「被替换掉的 .view-content」也会在下一次调用里被重新藏住。
	private applyCover(leaf: WorkspaceLeaf): void {
		const vc = leafContainer(leaf).querySelector('.view-content');
		if (!(vc instanceof HTMLElement)) {
			leafContainer(leaf).setCssStyles({ backgroundColor: 'var(--background-primary)' });
			return;
		}
		vc.setCssStyles({ opacity: '0' });
		leafContainer(leaf).setCssStyles({ backgroundColor: '' });
	}

	// 「读者**看得见**这道遮罩」这一刻记下来 —— 短盖的上界与保险定时器都从它起算。
	// 桌面上遮罩涂上就看得见；手机端要晚一大截（详见下面两条分支）。
	private markVisible(leaf: WorkspaceLeaf, entry: CoverEntry): void {
		if (entry.appliedAt !== undefined)
			return;
		if (Platform.isPhone) {
			// 手机上遮罩虽然也在 setViewState 那一刻就涂上，可那时全屏的文件列表还盖着正文
			// （原生列表 / 插件侧面板 / 对话框），读者什么都还没看见 —— 起点要等**这篇内容
			// 进视图**：有「上一篇」要比时问闸门，闸门缺席（全新 leaf / 同一篇的重放）时问
			// leaf 自己（见 contentShown）。
			if (entry.ready) {
				if (!entry.ready())
					return;
			} else if (!this.contentShown(leaf)) {
				// ⚠️ 这就是 2026-10-09 手机上报的「列表一收，新内容闪一下」：把缺席当恒真，
				// 起点就落回「涂上容器背景」那一刻（列表还没收完），读盘与列表收起动画把短盖的
				// 预算白吃掉 —— 预算到点、循环还没量稳就揭幕。
				return;
			}
		}
		entry.appliedAt = Date.now();
	}

	// 这个 leaf 此刻是不是**握着一篇有内容的笔记**。手机端拿它当「读者能看见遮罩了吗」的
	// 代理：全屏的文件列表一收，露出的要么是笔记背景、要么是这篇笔记的内容，两者都在内容
	// 读进来之后。全新 leaf 那一刻视图还不存在（答 false ⇒ 继续等）；同一篇的重放那一刻
	// 视图已经握着这篇的内容（答 true ⇒ 立刻起算，那正对）。
	// 空笔记（0 字节）会在预算到点后照常揭幕 —— 屏幕上本来也没有内容可闪。
	private contentShown(leaf: WorkspaceLeaf): boolean {
		const view = leaf.view;
		return view instanceof MarkdownView && view.data.length > 0;
	}

	// 逮住第一次 open 新搭出来的 .view-content，以及同 leaf 视图交换时被**替换**的那个 ——
	// 被替换的节点生来就是没藏过的，所以「藏过一次」不等于「藏到揭示为止」。uncover() 是唯一出口。
	private reapplyCover(leaf: WorkspaceLeaf): void {
		const entry = this.covered.get(leaf);
		if (!entry)
			return;
		this.applyCover(leaf);
		const before = entry.appliedAt;
		this.markVisible(leaf, entry);
		if (before === undefined && entry.appliedAt !== undefined) {
			// 读者看得见的那段空白从这一刻起算：保险定时器也跟着重新起算（并保住它的上界
			// —— 「读者看得见」到「揭开」才是读者看见的空白，手机端涂上之后列表还没收完的
			// 那一段不是，见 markVisible）。
			window.clearTimeout(entry.timer);
			entry.timer = window.setTimeout(() => {
				this.uncover(leaf);
			}, COVER_SAFETY_MS);
		}
		window.requestAnimationFrame(() => this.reapplyCover(leaf));
	}
}
