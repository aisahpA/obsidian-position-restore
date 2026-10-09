import { MarkdownView, Platform } from 'obsidian';
import { EphemeralState, NavEntryState } from '@/types';
import { applyEphemeralState, readEphemeralState, remapAnchoredState, shiftNavState } from '@/position/capture/ephemeral';
import {
	ANCHOR_SETTLE_DELAY, CONTENT_READY_MAX_MS, delay, nextPaint, RESTORE_MASK_BUDGET_PREVIEW,
	RESTORE_PAINT_DEADLINE, waitForContentReady, waitForRestorePainted,
} from '@/shared/wait';
import { PositionState } from '@/position/state';
import { DOC_READY_MAX_MS, SETTLE_HOLD_MAX_MS, SETTLE_MAX_MS, SOURCE_COVER_MAX_MS, SourcePixelCorrector } from './pixels';

// 一个被走过的行的标记，最多等它的落点多长时间：远超过任何一次 open 加上落定，
// 又短到读者不会把它误当成对刚才那个动作的回应。
const LINE_FLASH_ASK_MS = 5000;

// 回读一次居中落点最多等几帧。编辑器把 `scrollIntoView` 排进它自己的测量趟（那是一个
// effect，不是一次同步写），派发之后立刻回读拿到的是**旧**滚动；而少等一帧就回读，会让
// 下游那些「按 st.scroll 对齐到顶」的纠正器把刚居中的视口又拉回去。8 帧约 130ms —— 远在
// 任何一段遮罩预算之内（SETTLE_MAX_MS 是 800，遮罩保险是 2000）。
const CENTER_READ_MAX_FRAMES = 8;

// 一次点名一行的跳转里，等「编辑器能接这个原语」的帧数。这一步点名的那一行**确定存在**
// （标记在、文件对得上、没过期），只是视图还在建 / 刚换完文档 —— 此刻放弃居中就等于把落点
// 交回给按行数估的种子（「位置完全不确定，有时不在屏内」就是那个形状）。等不到才放弃，
// 放弃的理由与原来一样：宁可不居中，也不拿旧文档赌一次。
//
// 按**帧**计而不是按毫秒：这个洞只在「内容已经进来了、编辑器还差一步挂上」时出现，而
// 那一步是视图构造里同步发生的，几帧就能跨过去；按毫秒计会让慢设备上的每次跳转都白等，
// 也会把「编辑器本来就不认这个原语」的场合一起拖住（测试里就是这种桩编辑器）。
const CENTER_READY_MAX_FRAMES = 3;

// 各种恢复策略：分发流水线判定需要一次恢复之后，保存的位置如何被应用到
// 一个 markdown 视图上 —— masked（在 contentEl 遮罩下）、restoreInjectedSource
// （源码：短盖下等真几何）、landPreview（阅读：不遮，交给渲染器落），
// 以及每一种策略最后都会走到的共享锚点。
export class RestoreModes {
	private state: PositionState;
	private pixels: SourcePixelCorrector;

	constructor(state: PositionState) {
		this.state = state;
		this.pixels = new SourcePixelCorrector(state);
	}

	// 那些「保存的位置已被注入进 core 的 setViewState」的源码 open 的恢复：core
	// 已经同步应用过了，这里只把落点收成最终值（一次点名了一行的跳转先请编辑器
	// 自己居中）、在**短盖**下等编辑器给出真几何，再走共享收口 —— 记账、提示，
	// 以及揭开之后那一次像素检查
	// （anchorToSettledState → relandDriftedScroll → relandSourcePixels）。
	//
	// 为什么要遮（2026-10-08 两轮真机实测定的）：内容一出现就动几下的那种不稳定
	// 躲不掉 —— 要让第一帧就落在正确的位置上，只能等编辑器量完行高；在它量完
	// 之前画出来的帧必定被随后的一次测量推动（core 的两段式落地，实测约 85~145ms）。
	// 想不让读者看见，只剩遮住这一条路，而遮住的代价是空白。于是取舍落在「盖多久」
	// 上：盖到**编辑器量完为止** —— 目标行的偏移**与**视口里最后一条可见行的偏移在
	// 同一个窗口里都没离开过窗口起点（settleShortCover），下限从**第一次量到真几何**
	// 那一刻起算（+ SOURCE_COVER_FLOOR_MS），上界从**真正盖上**那一刻起算
	// （SOURCE_COVER_MAX_MS）。这一段里**不做**任何落点纠正（纠正留给揭开后的一次性
	// 检查）：在遮罩下纠正就是把遮罩按住更久，那正是更早那一版每次打开都给出一段空白
	// （下限约 250ms）的原因。
	//
	// **遮罩在 open 一开始就涂上，两端一致**（2026-10-09 第十二轮之后改判）。旧写法「甲」
	// 特意把那一次读盘留给旧画面（「别把 I/O 等待伪装成加载」），可真机上它读起来是
	// **上一篇闪一下**：文件不在内容缓存里时这次读盘要走磁盘，那几帧屏幕上就是上一篇，接着
	// 才白、才换新 —— 与点击快慢无关（结构性），见 ui/cover.ts 的 cover()。
	// 但「**读者看得见**这道遮罩」的时刻两处不同：桌面上就是涂上那一刻；手机端那一刻全屏的
	// 文件列表还盖着正文，要等新内容进视图（见 markVisible）。上界从读者看得见那一刻起算，
	// 读盘那一段才不会把短盖的预算白吃掉。
	//
	// **这段等待同时是「什么时候才能碰编辑器」的闸门**（同一条判据，见 waitContentArrived）：
	// 居中与短盖量的都是像素，而读盘那几百 ms 里编辑器握着的还是上一篇 ——
	// 'file-open' 是防抖发的，完全可能落在读盘中间。在旧文档上居中会被夹进行号范围，在旧
	// 文档上量像素则得出「已经量完了」的假结论（旧文档的几何是稳的 ⇒ 短盖当场揭幕 ⇒
	// 读者看到新内容出现时自己动）。手机上读盘慢，这两件事都常年发生。
	//
	// 没有盖布可揭时（后台清扫已经揭掉、或安全定时器到点）不等：没有要藏的东西，
	// 等下去只是推迟锚定。从未触发 'file-open' 的后台注入标签页仍走
	// settleInjectedReveal —— 那里读者看不见，可以盖到静默为止。
	async restoreInjectedSource(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		const touchBaseline = this.state.lastTouchAt;
		// 这一次 open 的两条等待共用一条预算，因为它们等的是**同一件事** —— 新内容到位：一条等
		// 编辑器换上这篇笔记的内容（waitContentArrived），一条等**读者看得见**那道遮罩
		// （waitCoverApplied）。只有「一直等不到」才需要一条上界（见 DOC_READY_MAX_MS）。
		const contentDeadline = Date.now() + DOC_READY_MAX_MS;
		let landed = st;
		try {
			// **先等新内容真的进到编辑器里**（见上面那段注释）：后面的每一步都以它为地面。
			// 等不到（core 一直没换文档）就**不碰编辑器** —— 一次落在旧文档上的居中比不居中
			// 更糟：行号会被夹进旧文档的范围，而它的滚动 effect 还可能在交换之后才被应用，
			// 把视口甩到任意位置。落点退回按行数估的种子，那至少是确定的。
			const arrived = await this.waitContentArrived(view, isCurrent, contentDeadline);
			// 一次点名了一行的跳转：请编辑器自己把那一行摆到正中（与点大纲面板同一个
			// 原语），再把回读到的视口顶当成落点 —— 落法于是和原生一模一样，也不再依赖
			// 「这一屏几行」那个估算。
			const centered = arrived && isCurrent() && st?.scroll
				? await this.centerNamedLine(view, isCurrent)
				: undefined;
			if (centered !== undefined && st)
				landed = { ...st, scroll: centered };
			// 短盖：等这道遮罩**读者看得见**（见 waitCoverApplied —— 桌面上涂上就看见；手机
			// 端那一刻全屏列表还盖着正文，要等新内容进视图），再盖到编辑器量完为止（见上面
			// 那段注释与 settleShortCover）。上界从**读者看得见**那一刻起算 —— 那段空白只有
			// 「读者看得见的那一刻到揭开」。
			const target = landed?.scroll;
			const appliedAt = await this.waitCoverApplied(view, isCurrent, contentDeadline);
			if (appliedAt !== undefined && isCurrent() && target)
				await this.pixels.settleShortCover(
					view,
					target,
					isCurrent,
					touchBaseline,
					appliedAt + SOURCE_COVER_MAX_MS,
				);
		} finally {
			// 后台清扫那条路（见 background-settle）此刻可能还盖着这个 leaf：切到前台
			// 必须把它揭掉，否则读者只能干等那道保险定时器（约 2s 的空白）。本路径自己
			// 盖的那道遮罩也从这里出去 —— 它就是「短盖」的出口。
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
		await this.anchorToSettledState(view, landed, isCurrent);
	}

	// 等编辑器真的换上**这篇**笔记的内容（有界）。判据借的是遮罩那道「新内容到了吗」的闭包
	// （patcher 在武装时装好，见 contentSwapGate）—— 两者问的是同一个问题，而那段闭包是唯一
	// 知道「武装时屏幕上是谁」的地方，所以不另写一份。没有盖布时它恒真：没有别的笔记要等它
	// 让位，也就没什么可等的。
	private async waitContentArrived(
		view: MarkdownView,
		isCurrent: () => boolean,
		deadline: number,
	): Promise<boolean> {
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.cover.contentArrived(view.leaf))
				return true;
			await nextPaint();
		}
		return this.state.cover.contentArrived(view.leaf);
	}

	// 等**读者看得见**这道盖布（有界），返回那一刻 —— 短盖的上界从它起算。盖布在 open 一开始
	// 就涂上、两端一致，可「读者看得见」的时刻两处不同：桌面上就是涂上那一刻（于是这里第一次
	// 循环就返回）；手机端那一刻全屏的文件列表还盖着正文，要等新内容进视图（见 ui/cover.ts 的
	// markVisible）。这次 open 根本没有盖布（后台那条路已经揭掉了、或只带光标的记录从不预遮）
	// 时返回 undefined —— 调用方于是不等待，也不盖。
	private async waitCoverApplied(
		view: MarkdownView,
		isCurrent: () => boolean,
		deadline: number,
	): Promise<number | undefined> {
		while (isCurrent() && Date.now() < deadline) {
			const at = this.state.cover.appliedAt(view.leaf);
			if (at !== undefined || !this.state.cover.isCovered(view.leaf))
				return at;
			await nextPaint();
		}
		return this.state.cover.appliedAt(view.leaf);
	}

	// 后台标签页的变体，针对一次从未触发 'file-open' 的注入 open（一个重启
	// 恢复出来、视图**已经建好**的分屏）：落点漂得和活动标签页一模一样，但在
	// 第一次激活之前没有任何东西去落定它。它跑遮罩下的 settle+reveal（与前台那条
	// 短盖的差别只在两个时刻：读者看不见这里，所以**立刻**盖上，且可以盖到落点真的
	// 静下来，也可以在遮罩下纠正 —— 见 restoreInjectedSource），但**不走**
	// anchorToSettledState —— 那个会写单槽的记录基准和 cue，而它们只属于活动
	// leaf。
	async settleInjectedReveal(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		const entryAt = Date.now();
		const touchBaseline = this.state.lastTouchAt;
		try {
			if (isCurrent() && st?.scroll)
				await this.pixels.settleAndHold(view, st.scroll, isCurrent, touchBaseline, entryAt + SETTLE_HOLD_MAX_MS);
		} finally {
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
	}

	// masked 恢复的骨架，保存位置与默认位置两种恢复共用。遮罩在首绘之前盖上，
	// 在确认恢复后的位置已经画出来的同一帧里揭掉，所以揭开是看不见的。
	// 用 opacity（不是 display:none）让隐藏期间布局保持完整，于是揭开纯粹是
	// 合成器的工作。
	//
	// `apply` 应用位置，并在可滚动时返回 true，这样遮罩会一直留着，直到编辑器
	// 报告出那一行（有界）；同步类恢复只等两帧来确认结果已经画出来。
	//
	// 盖子从盖上到揭开走**一条**预算（maskDeadline）：内容就绪与揭幕确认共享它，
	// 所以读者被遮住的时长有确定的上界，而不是各段上限之和。见 wait.ts 的
	// RESTORE_MASK_BUDGET_PREVIEW。
	private async maskedRestore(
		view: MarkdownView,
		st: EphemeralState | undefined,
		isCurrent: () => boolean,
		apply: () => boolean,
	) {
		// 把正在构建的恢复藏起来；最后揭开它的是 finally 里的
		// revealRestoreCover 和 restoreEphemeralState 顶部那一个（给被顶掉的
		// 恢复用）。
		this.state.cover.restoreCover(view);
		// 遮罩从这一刻起算，**整段被遮住的阶段共享这一条预算**：读者能感知的只有「盖上到
		// 揭开」这一段，所以只该有一个数 —— 拆成几段独立的上限会相加（曾经 2000 + 2000）。
		const maskDeadline = Date.now() + (view.getMode() === 'preview'
			? RESTORE_MASK_BUDGET_PREVIEW
			: RESTORE_PAINT_DEADLINE);
		// 等待期间的一条触摸基准：比这次恢复更晚的读者输入说明他们接管了 —— 不能再往目标上
		// 拽（遮罩照揭，由 finally 管）。两个平台各有自己的信号，同 sampler 的 hasUserIntent：
		// 移动端 touchstart，桌面端 wheel / pointerdown / keydown。这次 open 自己那一下
		// 的输入早于基准（基准在恢复入口取），所以不会把自己挡掉。
		const touchBaseline = Math.max(this.state.lastTouchAt, this.state.lastUserInputAt);
		const stillOurs = () => isCurrent()
			&& Math.max(this.state.lastTouchAt, this.state.lastUserInputAt) <= touchBaseline;
		try {
			// 等阅读渲染器把这篇笔记产出来（有界，且只花遮罩预算里剩下的那部分）。链接高亮的
			// span 会随这次渲染一起出现，所以这也把 .is-flashing 的重检安排在它可能存在的
			// 时刻。
			await waitForContentReady(view, isCurrent, Math.min(CONTENT_READY_MAX_MS, maskDeadline - Date.now()));
			if (!isCurrent())
				return;

			// 兜底：那些绕过了 openLinkText 的 anchorLink 高亮（程序化滚动、
			// API open）：core 的目标说了算，什么都不恢复。见 #10、#32、#46、#51。
			if (view.containerEl.querySelector('.is-flashing'))
				return;

			await nextPaint();
			if (!isCurrent())
				return;

			const scrollable = apply();

			// 一直遮着，直到编辑器报告出那一行（有界，免得失败时遮成一片空白）。scrollable
			// 已经蕴含 st 非空且可滚动。这里只花遮罩预算**剩下的那部分** —— 内容就绪可能已经
			// 吃掉大半，两者的和必须落在同一个 maskDeadline 之内（见 wait.ts 的
			// RESTORE_MASK_BUDGET_PREVIEW）。剩下的不够就直接揭幕，不等。
			if (scrollable && st) {
				const remaining = maskDeadline - Date.now();
				if (remaining > 0)
					await waitForRestorePainted(view, st, stillOurs, remaining);
			} else {
				// 同步类恢复；两帧确保结果已经画出来。
				await nextPaint();
				await nextPaint();
			}
			if (!isCurrent())
				return;

			// 源码模式：趁还遮着，用**一次**纠正收敛编辑器的测量并修正落点 ——
			// 揭开之后再纠正，读起来就是一场肉眼可见的拉锯。
			await this.pixels.settleSourcePixels(view, st, isCurrent, SETTLE_MAX_MS);
		} finally {
			if (isCurrent()) {
				// 既要揭掉 leaf 级的遮罩（来自 coverOpen）**又**要清掉这次恢复
				// 在 view.contentEl 上自己的遮罩 —— 两个不同的元素，两个都得
				// 清掉才能揭开。
				this.state.cover.uncover(view.leaf);
				this.state.cover.revealRestoreCover(view);
			}
		}

		await this.anchorToSettledState(view, st, isCurrent);
	}

	// 在隐藏的遮罩下恢复一个保存的位置 —— 阅读视图，以及少数绕过了
	// setViewState 的源码模式 open。阅读视图里**被注入过落点**的那一路不走这里
	// （core 自己会落定，没有顶部要藏，遮上只是空白 —— 见 landPreview）。
	async maskedRestoreSt(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		if ((st.scroll ?? 0) <= 0) {
			// scroll 为 0 的记录：唯一能用的那部分就是光标，它同步落地，从不
			// 移动视口。给一次空恢复加遮罩，只会多出一段被遮住的空白期 —— 在
			// 慢设备（Android）上非常显眼 —— 所以就在 open 里应用。
			applyEphemeralState(view, st);
			await nextPaint();
			if (!isCurrent())
				return;
			await nextPaint();
			if (!isCurrent())
				return;
			await this.anchorToSettledState(view, st, isCurrent);
			return;
		}
		await this.maskedRestore(view, st, isCurrent, () => {
			applyEphemeralState(view, st);
			return true;
		});
	}

	// 阅读模式的**无遮罩**落定 —— 只给「落点已经随 open 注入给 core」的那一路用
	// （见 restorer.ts 的阅读分支）。那一路上 core 自己的渲染流水线接着这个值
	// （applyScrollDelayed 会在渲染器就绪时落一次），所以**没有「未恢复的顶部」需要藏**，
	// 而遮罩在这条路上只会把整段异步渲染期变成一片空白 —— 跨文件打开一篇大笔记能到
	// 2~3 秒，同一个文件因为渲染器早已就绪则完全察觉不到（这正是「同一个文件内切换没有
	// 问题」的那半个现象）。
	//
	// 于是这里不遮：让笔记照常画出来，等渲染器就绪（有界）把落点应用上去、按住几帧，
	// 再走共享的收口 —— 与 maskedRestore 走的是同一个 anchorToSettledState，
	// 所以账本、提示、锚定基准一件都不少。那一次应用落在内容首绘的同一帧里
	// （waitForRestorePainted 每帧量一次、在 rAF 回调里施加），所以也不会读成
	// 「先看见顶部、再跳一下」。
	async landPreview(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		try {
			await waitForContentReady(view, isCurrent);
			if (!isCurrent())
				return;
			// 兜底：那些绕过了 openLinkText 的 anchorLink 高亮（程序化滚动、API open）
			// —— core 的目标说了算，什么都不恢复。（与 maskedRestore 同一个守卫。）
			if (view.containerEl.querySelector('.is-flashing'))
				return;
			await waitForRestorePainted(view, st, isCurrent);
		} finally {
			// 这条路径自己不遮（那正是它存在的理由），但**别人**可能还盖着这个 leaf：
			// 一次被顶掉的恢复，或一次注入的 open 留下的首绘遮罩。揭开它 —— 否则只能
			// 等遮罩的保险定时器（两秒）。
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// 文件内的历史跳转（前进 / 后退落在**同一篇**笔记里）：视图已经渲染好了 ——
	// 没什么要遮的，也没有 open 流水线要等。跑在漏斗的恢复括号里，所以轮询
	// 不会把这些 apply 当成用户移动记下来。
	async historyJumpApply(view: MarkdownView, st: NavEntryState, isCurrent: () => boolean, shift?: number) {
		// 这一步的行号早于它被记录之后所做的编辑（上方的插入 / 删除会把下面
		// 每一行都推走）。两种重锚的路子：结构化解出的位移（这次跳转自己的
		// 标题 / 块 id 通过 metadataCache 重新定位 —— 权威），或者按文本片段
		// 重映射的退路。
		if (shift !== undefined)
			st = shiftNavState(st, shift);
		else
			st = remapAnchoredState(view.editor, st);

		// 一次点名了一行的跳转（见 namedLineAsk）：**先只落光标**，让编辑器自己把那一行摆正
		// —— 视口于是只动一次，而且动在真实像素上。种子（`st.scroll`）那一次不落：它是按
		// 行号估的（core 的 applyScroll 拿区块平均插值，见 shared/jump-landing.ts 文件头），
		// 落了就是「先估一个位置、再被居中纠正回来」的两下，第二下还看得见 —— 那正是
		// 「编辑模式跳转有时候有轻微的跳动」。core 的 setState 在带光标时会把滚动原样还回去
		// （`scrollTo(当前滚动)`），所以这一次施加不移动视口。
		const named = this.namedLineAsk(view) !== undefined;
		applyEphemeralState(view, named ? { ...st, scroll: 0 } : st);
		await nextPaint();
		if (!isCurrent())
			return;
		const centered = await this.centerNamedLine(view, isCurrent);
		if (centered !== undefined) {
			// 这次像素落定、锚定、记账于是都对着回读到的真实视口顶，而不是当初按
			// 「这一屏几行」估出来的那个数。
			st = { ...st, scroll: centered };
		} else if (named) {
			// 居中做不到（视图还没建好 / 编辑器不认那个原语）：退回种子 —— 这一刻它是唯一的
			// 落点，也正因如此它得留着（别把 jumpTopBiasLines 的源码分支删成 0）。
			applyEphemeralState(view, st);
			await nextPaint();
			if (!isCurrent())
				return;
		}
		if (view.getMode() === 'source' && (st.scroll ?? 0) > 0)
			await this.pixels.settleSourcePixels(view, st, isCurrent, SETTLE_MAX_MS);
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// 前进/后退这一步点名的那一行 —— `pendingLineFlash` 正是「这一步点名了一行」（见
	// NavStack.armLandingMark），jump/visit/teleport 三种步都有。一次普通打开的保存位置
	// 没有它，那种落点是一整个**视口**，它那一行必须留在顶上，不能拿去居中。答不出来时
	// 返回 undefined，调用方退回种子：
	//   · 不是源码模式（阅读模式没有编辑器原语，落法由 jumpTopBiasLines 那边管）；
	//   · 不是点名的这篇笔记（标记是全局的）；
	//   · 标记过期（一次从未落地的打开要求的行，不许在后来某次恢复里居中）。
	//
	// 它**不看编辑器**：「这一步点名了哪一行」与「编辑器现在认不认那个原语」是两件事，
	// 后者要等（见 centerNamedLine）。
	private namedLineTarget(view: MarkdownView): { line: number } | undefined {
		const ask = this.state.pendingLineFlash;
		if (!ask || view.getMode() !== 'source' || view.file?.path !== ask.path)
			return undefined;
		if (Date.now() - ask.at >= LINE_FLASH_ASK_MS)
			return undefined;
		return ask;
	}

	// 加上「编辑器此刻就能做这件事」的条件 —— 这就是可以派发的意思。
	private namedLineAsk(view: MarkdownView): { line: number } | undefined {
		const ask = this.namedLineTarget(view);
		if (!ask)
			return undefined;
		if (typeof view.editor?.scrollIntoView !== 'function')
			return undefined;
		return ask;
	}

	// 一次「点名了一行」的落点，在源码模式里交给**编辑器自己**摆正：core 自己的大纲点击走
	// 的就是这个原语（`editor.scrollIntoView(range, true)` —— 解包 obsidian.asar 实测，它就是
	// `dispatch(scrollIntoView(range, {y: "center"}))`），所以它落在哪儿我们就落在哪儿 ——
	// 与视口多高无关，也就不会有「按一屏几行估出来的半个视口」那种时中时偏。**行号在这里
	// 不再是落点，只是「要点名哪一行」**：镐下去的是像素，回读出来的也是像素。
	//
	// 它同时是**唯一**一处让落点居中：别处一律按 `st.scroll` 把那一行对齐到顶部
	// （settleSourcePixels 等），所以这里的居中要靠它回读出来的视口顶来「说服」那些纠正器
	// —— 它们随后量到的偏差就是零。
	//
	// **派发之前，文档必须已经在位**（2026-10-09 用户拍板，丙）。跨文件打开时 'file-open'
	// 与文档交换之间有一段空档（core 在异步读盘），此刻派发的 `scrollIntoView` 落在**上一篇**
	// 文档上 —— 行号被夹进旧文档的范围，回读到的也是旧文档的滚动 —— 这一次居中于是完全作废，
	// 落点交给按行数估出来的种子决定。用户看到的正是这个形状：「位置完全不确定，甚至有时候
	// 不在屏幕里面」。那道等待归调用方管（跨文件在 restoreInjectedSource 的 waitContentArrived，
	// 同文件那条路文档本就在位），这里只管派发 —— **闸门只有一处**，就不会有人忘了过它。
	//
	// 返回 undefined 有三种情形：**没有要求编辑器滚动**（见 namedLineAsk）、这次 open 已经
	// 不是当前的了，或那个原语直接抛了。
	private async centerNamedLine(view: MarkdownView, isCurrent: () => boolean): Promise<number | undefined> {
		// 这一步确实点名了一行，只是编辑器还没接上（视图还在建 / 刚换完文档）：有界地等它。
		// 等它和「这一行到底存不存在」必须分开判 —— 合在一起会把「还没就位」误读成
		// 「没有要点名的行」，于是这次居中被静默跳过，落点退回按行数估的种子（手机上最常见的
		// 那个不稳就是这么来的）。
		if (!this.namedLineAsk(view) && this.namedLineTarget(view)) {
			for (let i = 0; i < CENTER_READY_MAX_FRAMES; i++) {
				if (!isCurrent() || this.namedLineAsk(view) || !this.namedLineTarget(view))
					break;
				await nextPaint();
			}
		}
		const ask = this.namedLineAsk(view);
		if (!ask)
			return undefined;
		if (!isCurrent())
			return undefined;
		const before = this.readScroll(view);
		try {
			view.editor.scrollIntoView({ from: { line: ask.line, ch: 0 }, to: { line: ask.line, ch: 0 } }, true);
		} catch {
			return undefined;
		}
		return this.settledScroll(view, isCurrent, before);
	}

	// 等编辑器把那次滚动真正应用下去，再回读视口顶（有界）。`scrollIntoView` 是一个 effect，
	// 编辑器把它排进自己的测量趟，所以派发之后立刻回读读到的是**旧**滚动 —— 而这个值要交给
	// 那些按 `st.scroll` 对齐到顶的纠正器，读旧了它们就会把刚居中的视口拉回去（越是不居中
	// 越明显）。等它动过、并且在两帧上一致了才算数（同 waitForRestorePainted 的做法）；一直
	// 不动（居中后的位置恰好与原来一样）就等满窗口，照样把读到的那个值交出去。
	private async settledScroll(view: MarkdownView, isCurrent: () => boolean, before: number | undefined): Promise<number | undefined> {
		let prev: number | undefined;
		let same = 0;
		for (let i = 0; i < CENTER_READ_MAX_FRAMES && isCurrent(); i++) {
			await nextPaint();
			const now = this.readScroll(view);
			if (now === undefined) {
				same = 0;
				continue;
			}
			same = prev !== undefined && Math.abs(now - prev) < 0.01 ? same + 1 : 0;
			prev = now;
			const moved = before === undefined || Math.abs(now - before) > 0.01;
			if (same >= 1 && (moved || i >= CENTER_READ_MAX_FRAMES - 1))
				return Math.max(1, Math.round(now));
		}
		return prev === undefined ? undefined : Math.max(1, Math.round(prev));
	}

	// 视口顶此刻在哪一行（可能带小数）。阅读渲染器还没跟上时报的是 null，编辑器还没建出来时
	// 报 undefined —— 两者都算「没有答案」，绝不当作 0。
	private readScroll(view: MarkdownView): number | undefined {
		const top = view.currentMode?.getScroll();
		return typeof top === 'number' && Number.isFinite(top) ? top : undefined;
	}

	// 把变化检测锚到视图**实际**落定的地方，而不是我们请求的那个值。整数量化
	// 能吸收 applyScroll 的落点误差，但视口上方加载的图片会把回读推走整数行 ——
	// 越过死区。锚到请求的那个值，会让轮询循环把这次布局位移当作用户滚动，
	// 覆盖掉保存的位置。ANCHOR_SETTLE_DELAY 让这些位移先稳定下来。
	private async anchorToSettledState(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (this.state.noAnchorLeafIds.has(this.state.leafId(view.leaf)))
			return;
		await delay(ANCHOR_SETTLE_DELAY);
		// 被顶掉的恢复绝不能锚定：lastEphemeralState 会描述错文件，轮询循环
		// 会把它写进数据库。源码模式在**所有**平台都纠正（桌面端注入的 open
		// 也会落偏）；阅读的回读循环则只在移动端跑，那里的预览漂移常见到需要
		// 一个纠正循环。
		if (isCurrent() && (view.getMode() === 'source' || Platform.isMobileApp))
			await this.pixels.relandDriftedScroll(view, st, isCurrent);
		if (isCurrent()) {
			this.state.lastEphemeralState = readEphemeralState(view) ?? st;
			this.state.lastAnchorAt = Date.now();
			// 先取标出来的那一行 —— 这个名字同时是面包屑的锚（见下面的 cue.show）：一次点名了
			// 一行的跳转把落点摆在视口正中，只有标它的那一行还知道落点在哪。必须在
			// markLandingLine 之前取，它会把标记消费掉。
			const landingLine = this.markLandingLine(view);
			// 每一条真正的恢复路径都终结在这里，所以两个方向提示只在一次真实的恢复
			// 落定之后才响。NavStack 的遍历会装好 cueSuppressUntil —— 目的地是用户
			// 自己选的，不给提示；那一路的落点由 armLandingMark 单独标出（见
			// markLandingLine），所以这里也不会和它闪成两下。
			if (Date.now() >= this.state.cueSuppressUntil) {
				this.markRestoredLine(view);
				this.state.cue.show(view, landingLine);
			}
		}
	}

	// 一个点了名的行、正在赶路的步，在笔记这一侧要做的事：给它打标记，就像 app 给它自己的
	// 大纲把读者带去的那一行打标记那样（见 NavStack.armLandingMark）。之所以在这一侧回答，
	// 是因为每一条真正的恢复都终结于此 —— 标记于是落在**落定后**的落点上，而不是当初
	// 请求的那一行。visit/teleport 的标记只在编辑模式兑现（sourceOnly）：阅读模式没有光标，
	// 视口顶就是落点；jump 两种模式都标。
	//
	// 返回值就是被打标记的那一行（没打则 undefined）—— 它同时是面包屑该念哪一节的那个锚
	// （见 anchorToSettledState 的 cue.show）：这一次落点被摆在视口**正中**，视口顶在它
	// 上方半屏处，所以只有这一行还知道读者落在哪一节里。
	private markLandingLine(view: MarkdownView): number | undefined {
		const ask = this.state.pendingLineFlash;
		if (!ask)
			return undefined;
		if (Date.now() - ask.at >= LINE_FLASH_ASK_MS) {
			this.state.pendingLineFlash = undefined;
			return undefined;
		}
		if (view.file?.path !== ask.path)
			return undefined;
		this.state.pendingLineFlash = undefined;
		if (ask.sourceOnly && view.getMode() !== 'source')
			return undefined;
		this.state.cue.flashLine(view, ask.line);
		return ask.line;
	}

	// 恢复后标出落点，且只在编辑模式：标光标那一行，读者要接着打字的地方（视口顶部那
	// 一行不标，眼睛本来就在那儿，标了只是复述）。阅读模式不标：没有光标，视口顶就是
	// 唯一落点，闪包住顶行的小节整块只是噪音，方向提示归面包屑 cue.show。行元素找不到
	// （光标在屏外，或视图刚重建还没画到那一行）时 flashLine 自己安静地退回无操作，
	// 不必先判断一次可见性。开关在 flashLine 那一侧。
	private markRestoredLine(view: MarkdownView) {
		if (view.getMode() === 'preview')
			return;
		const line = view.editor?.getCursor()?.line;
		// 文件开头那一行不是一次落点：没有保存位置的文件就打开在这儿，标它只是噪音。
		if (!line)
			return;
		this.state.cue.flashLine(view, line);
	}
}
