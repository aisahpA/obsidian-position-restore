import { MarkdownView } from 'obsidian';
import { EphemeralState } from '@/types';
import { applyEphemeralState, readEphemeralState } from '@/position/capture/ephemeral';
import { delay, hasPreviewScrolled, nextPaint } from '@/shared/wait';
import { PositionState } from '@/position/state';

// 通过 (editor).cm 能摸到的 CM6 EditorView 的最小结构视图 —— 只要像素纠正需要的那些，
// 不依赖 @codemirror（实例由 Obsidian 在运行时提供）。
export interface CmLike {
	state: { doc: { lines: number; length: number; line(n: number): { from: number }; toString(): string } };
	scrollDOM: HTMLElement;
	// CM6 公开 API：当前已渲染行的 pos 范围。只有**已渲染**行的 coordsAtPos 才返回真实的
	// 客户端矩形几何；未渲染的行返回的是高度图**估算值**，在文件交换期间（高度图过期）
	// 就是垃圾。
	viewport: { from: number; to: number };
	coordsAtPos(pos: number): { top: number } | null;
	// CM6 公开 API：把一次几何测量排到下一帧。交换后过期的高度图，只有在 CM6 跑一趟测量
	// 之后才变真 —— 而它不会仅仅因为我们在轮询就去排这一趟。由我们自己请求，正是缩短那段
	// 「垃圾测量」窗口的原因。
	requestMeasure(): void;
	defaultLineHeight: number;
}

// 移动端恢复后漂移纠正（relandDriftedScroll）的有界预算。给得宽：移动端渲染在 open 之后
// 好几秒可能还在测量，而这次纠正是唯一能修正落点的东西。
const RELAND_MAX_MS = 3000;

// 重落纠正的节奏：起步密（赶紧修好大的落偏），然后逐渐放慢 —— open 流水线会在一段时间里
// 反复重应用自己的 scroll，而用固定密节奏去追每一次重应用，会让这次修正变成肉眼可见的
// 视口抖动。
const RELAND_FIRST_STEP_MS = 200;
const RELAND_MAX_STEP_MS = 700;

// 揭开之前的像素落定（settleSourcePixels）的预算。有界，好让遮罩永远不会把笔记按住太久：
// 遮罩的安全定时器（COVER_SAFETY_MS，2000ms —— 见 ../ui/cover.ts）必须比整个被遮住的阶段
// —— 等内容就绪 + 等绘制 + 这次落定 —— 多活出一段余量。超时后揭开照样进行；揭开后的
// 一次性检查仍能抓住离谱的落点。
export const SETTLE_MAX_MS = 800;

// 落定的第一次纠正被信任之前的最短时间（settleSourcePixels；被遮住的注入路径用
// settleAndHold，它的稳定时钟取代了这段死等）。core 自己的 scroll 重应用在 open 后约 145ms
// 内落地；200ms 带余量地跨过那个窗口。
const SETTLE_MIN_MS = 200;

// 一次落定纠正之后，等这么久再校验它**守住了**：流水线可能在几百 ms 后重应用自己的 scroll。
// 一次再纠正（总共最多 2 次）既让最终位置正确，又把可见的跳限制在两次 —— 是一次落位，
// 绝不是一轮又一轮的拉锯。
const SETTLE_VERIFY_MS = 200;

// 遮罩揭开之前，落点必须守住的静默窗口：保存那一行任何像素级的移动都会重置时钟，而 core
// 自己那套两段式落地（先估算、再测量 —— 实测约 85ms）正表现为这样一次移动，所以这个窗口
// 永远跑在重落之后的真实地面上。100ms ≈ 6 帧：滤掉帧抖动与缓慢漂移，同时让「已对齐的
// open」的空白接近物理下限（CM 还没测量并重落它的估算之前，遮罩揭不开 —— 单这一步就要
// 花约 90-145ms）。
const SETTLE_HOLD_QUIET_MS = 100;
export const SETTLE_HOLD_MAX_MS = 1250;

// 源码模式的像素落位：遮罩下的收敛 + 纠正（settleSourcePixels / settleAndHold）、揭开后的
// 一次性离谱检查（relandSourcePixels），以及移动端的自适应回读循环（relandDriftedScroll）。
export class SourcePixelCorrector {
	private state: PositionState;

	constructor(state: PositionState) {
		this.state = state;
	}

	// 阅读视图的自适应回读纠正循环（揭开之后由 anchorToSettledState 调用），外加向源码像素
	// 一次性检查的分发。恢复落在刚打开的文档深处时，靠的是「基于估算 / 最近边缘」的滚动
	// 语义，所以保存的顶行常常落在视口**底部**（正好一屏高）而不是顶部 —— 落不落得中，
	// 取决于 apply 那一刻的布局状态。移动端（WKWebView）与桌面端注入的源码 open 上都
	// 观察到了。
	//
	// 没有别的东西纠正它，而且很铁：currentMode.getScroll() 会**回显**请求的值，而像素
	// 坐在别处，于是每一次基于回读的校验都以为落点是对的。源码模式因此改走 CM6 实例
	// （(editor).cm）用**像素几何**来校验：保存那一行此刻究竟坐在视口的哪里（coordsAtPos
	// 的客户端矩形 —— 不含任何坐标系假设）。纠正分**两**个阶段：
	//  1. settleSourcePixels —— 在遮罩揭开**之前**：等编辑器的测量收敛，然后做**一次**
	//     决断性的纠正，在遮罩下看不见。落点就是在这里被修好的。
	//  2. relandSourcePixels —— 揭开之后：一次**一次性**检查，只纠正离谱的误差（半屏及
	//     以上），针对那些没有落定的路径（源码滑行）或落定超时的路径。不循环：一轮又一轮
	//     去追 open 流水线自己的重应用，正是那个被报告的抖动背后的可见拉锯。
	// 阅读模式没有按行的 DOM 钩子，所以它保留下面这个自适应回读循环（预览的 getScroll
	// 一旦真的滚过就是像素推导出来的；回显期由 hasPreviewScrolled 排除掉）。读者一碰视图
	// 就中止（**新的**触摸 —— 打开文件的那一下被快照成基准），所以它从不跟用户的滚动较劲。
	// 它在恢复括号还开着的时候跑，所以轮询无法把这次纠正自己的滚动记成用户移动；纠正从不
	// 写库记录（只用于显示）。
	async relandDriftedScroll(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (!st || !st.scroll || st.scroll <= 0)
			return;
		const target = st.scroll;
		// 这次 open 自己那一下不能算「用户在滚动」：只有比这个快照更新的触摸才中止这次
		// 纠正。
		const touchBaseline = this.state.lastTouchAt;
		const deadline = Date.now() + RELAND_MAX_MS;
		if (view.getMode() === 'source') {
			await this.relandSourcePixels(view, target, isCurrent, touchBaseline);
			return;
		}
		let applied = target;
		let bestMiss = Infinity;
		let noProgress = 0;
		let stepMs = RELAND_FIRST_STEP_MS;
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			if (!hasPreviewScrolled(view))
				return; // 回显期：渲染器还没落地 —— 由它去
			const now = readEphemeralState(view);
			if (!now || now.scroll === undefined)
				return;
			if (now.scroll === target)
				return; // 已落定
			const miss = Math.abs(now.scroll - target);
			if (miss >= bestMiss) {
				// 上一次纠正没能收窄差距 —— 请求被夹住了（EOF）或落点不稳定；停下来，
				// 别再折腾。
				if (++noProgress >= 2)
					return;
			} else {
				noProgress = 0;
				bestMiss = miss;
			}
			applied += target - now.scroll;
			if (applied <= 0)
				return;
			applyEphemeralState(view, { ...st, scroll: applied });
			await delay(stepMs);
			stepMs = Math.min(stepMs * 1.4, RELAND_MAX_STEP_MS);
		}
	}

	// (editor).cm 背后那个 CM6 EditorView；摸不到时返回 null（视图还没就绪 / Obsidian 内部
	// 结构变了）。
	private cmOf(view: MarkdownView): CmLike | null {
		const cm = (view.editor as { cm?: CmLike }).cm;
		return cm?.state?.doc && cm.scrollDOM ? cm : null;
	}

	// 编辑器的文档此刻是否**已经**是目标文件的内容。同 leaf 切换时，文档会在几百 ms 里保留
	// 上一个文件的内容（Obsidian 异步加载新文件）—— 拿它去测量，得到的是与**旧**文件几何
	// 自洽的垃圾。view.data 是 Obsidian 为这个视图加载的内容 —— 在文档交换之前就设好了 ——
	// 所以 doc==data 恰好等于「交换已经发生」。先做廉价的长短比较；只有长度相等时才做完整
	// 比对。
	private docMatchesView(view: MarkdownView, cm: CmLike): boolean {
		const data = view.data;
		if (typeof data !== 'string' || data.length === 0)
			return true; // 没有可比对的东西：绝不因此阻塞
		const doc = cm.state.doc;
		if (doc.length !== data.length)
			return false;
		return doc.toString() === data;
	}

	// 受守卫的测量：保存那一行相对滚动容器顶部的像素偏移，落定与揭开前的静默保持共用。三道
	// 闸门，每一道都堵住一条「垃圾测量」的路径：
	//  1. **先确认文档身份**：同 leaf 切换时，文档会在几百 ms 里仍握着上一个文件，量它会
	//     产生恰好偏了「旧对新」布局差值的垃圾。没有正确的文档，就不测量。身份检查每个
	//     测量器只跑一次。
	//  2. 每次调用都从**当前**文档重新解析这一行的 pos：交换会替换文档，早先捕获的 pos
	//     指向的是旧文档。含 EOF 检查（文件在磁盘上变了）。
	//  3. **只要地面真值**：已渲染行的 coordsAtPos 是真实的客户端矩形；未渲染行的是高度图
	//     **估算值**。没有渲染，就没有测量。
	// 任何一道闸门不过就返回 null —— 调用方必须把 null 当作「没有可信的数字」，绝不是零。
	private targetTopMeasurer(view: MarkdownView, cm: CmLike, targetLine1Based: number): () => number | null {
		const scroller = cm.scrollDOM;
		let docVerified = false;
		return () => {
			if (!docVerified) {
				if (!this.docMatchesView(view, cm))
					return null;
				docVerified = true;
			}
			if (targetLine1Based + 1 > cm.state.doc.lines)
				return null;
			const from = cm.state.doc.line(targetLine1Based + 1).from;
			if (from < cm.viewport.from || from >= cm.viewport.to)
				return null;
			const coords = cm.coordsAtPos(from);
			return coords
				? coords.top - scroller.getBoundingClientRect().top
				: null;
		};
	}

	// 被遮住的 open 用的「精确落位 + 揭开」合并门控。一个循环**同时**决定落点要不要修、
	// 以及遮罩什么时候能揭 —— 于是一次立刻收敛的落点约 200ms 就揭开遮罩，而不是一律等到
	// 某个死截止时间：
	//  - 每帧量一次保存那一行的像素差值；任何移动都重置稳定时钟（core 的两段式落地 ——
	//    先估算、再在约 85ms 时测量重落 —— 恰好表现为这样一次移动）；
	//  - 时钟一开始走，就推一把测量趟，于是静默窗口跑在真实刷新的几何上，揭开时也就不需要
	//    再多等一次测量；
	//  - **没对齐** → 立刻纠正，且以「强制重新测量」为前置；残余在同一次里连续纠正 ——
	//    最多 2 次；
	//  - 静默满 SETTLE_HOLD_QUIET_MS → 对着当前几何校验并揭开；
	//  - 量不到（文档交换中 / 行未渲染）→ 保持遮着，推一把测量趟。
	// 由截止时间兜界（从恢复入口起算的 SETTLE_HOLD_MAX_MS；遮罩安全定时器始终是外层界限）
	// —— 超时后揭开照常进行，揭开后的一次性检查仍能抓住离谱的误差。比这次 open 自己那一下
	// 更晚的触摸会中止它。
	async settleAndHold(
		view: MarkdownView,
		targetLine1Based: number,
		isCurrent: () => boolean,
		touchBaseline: number,
		deadline: number,
	) {
		const cm = this.cmOf(view);
		if (!cm)
			return;
		const measure = this.targetTopMeasurer(view, cm, targetLine1Based);
		const scroller = cm.scrollDOM;
		const lineHeight = cm.defaultLineHeight || 20;
		const alignedLimit = lineHeight * 2;
		let prev: number | null = null;
		let stableSince = -1;
		let corrections = 0;
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			const delta = measure();
			if (delta === null) {
				cm.requestMeasure(); // 推一把：过期的高度图只有跑一趟测量才会变真
				prev = null;
				stableSince = -1;
				await nextPaint();
				continue;
			}
			if (prev !== null && Math.abs(delta - prev) <= lineHeight / 2) {
				if (stableSince < 0) {
					stableSince = Date.now();
					// **现在**就推一把测量趟：它会在一两帧内刷出真几何，于是静默窗口与揭开
					// 决策都跑在测得的真值上，到期时也不用再多等绘制。
					cm.requestMeasure();
				}
			} else {
				stableSince = -1;
			}
			prev = delta;
			const quiet = stableSince >= 0 && Date.now() - stableSince >= SETTLE_HOLD_QUIET_MS;
			const misaligned = Math.abs(delta) > alignedLimit;
			if (!misaligned && !quiet) {
				await nextPaint();
				continue;
			}
			if (misaligned) {
				// 落错了：读数一为真就修 —— 强制的一趟测量是这次纠正的前置（约在 50-95ms
				// 就纠正，而不是等静默窗口走完），残余在静默校验窗口甚至还没开始之前就
				// 连续修正。
				cm.requestMeasure();
				await nextPaint();
				await nextPaint();
				if (!isCurrent())
					return;
				const rechecked = measure();
				if (rechecked === null)
					return; // 闸门又关上了：揭开，由一次性检查兜底
				if (Math.abs(rechecked) > alignedLimit) {
					if (corrections >= 2)
						return; // 照样揭开；由一次性检查兜底
					scroller.scrollTop += rechecked; // 精确的残余纠正
					corrections++;
					// 接下来几帧对着纠正后的视口重量：进一步的残余连续修正，且只有对齐了，
					// 静默校验窗口才开始。
					prev = null;
					stableSince = -1;
					await nextPaint();
					continue;
				}
				// 终究量的还是对齐的（过期高度图误报）：按真几何继续跟踪。
				prev = rechecked;
				if (quiet)
					return;
				await nextPaint();
				continue;
			}
			// 静默期满：对着当前几何校验（稳定时钟启动时那一下推的测量已经刷过 —— 窗口中途
			// 任何高度图更新都会让读数发生变化）。
			const rechecked = measure();
			if (rechecked === null)
				return; // 闸门又关上了：揭开，由一次性检查兜底
			if (Math.abs(rechecked) > alignedLimit || Math.abs(rechecked - delta) > lineHeight / 2) {
				// 假稳定露馅：当成移动处理，继续遮着。
				stableSince = -1;
				prev = rechecked;
				await nextPaint();
				continue;
			}
			return;
		}
	}

	// 源码像素落定 —— maskedRestore 自己的 contentEl 遮罩下的精确落位。被遮住的注入路径用
	// settleAndHold，它把这次「收敛 + 纠正」与揭开决策合并在一起。
	//
	// 时机就是整个设计。刚打开的编辑器还在测量：CM6 会落基于估算的滚动、重新测量真实行高
	// 并挪动内容；分阶段的 open 流水线会在几百 ms 里重应用自己的 scroll。三条规则让可见的
	// 纠正次数停在「零到两次」**且**最终位置正确：
	//  1. SETTLE_MIN_MS 之前不纠正 —— 头约 300ms 内量到的收敛，是测量 / 重应用挪动**之前**
	//     的那段平静。
	//  2. 然后收敛：连续两帧对残余的读数一致，差距在半行以内；用精确的残余纠正**一次**。
	//  3. 校验这次纠正**守住了**（SETTLE_VERIFY_MS 之后）：如果流水线把它覆盖了，再纠正
	//     一次。总共最多 2 次纠正。
	// 比这次 open 自己那一下更晚的触摸、以及被顶替，都会中止它。由 SETTLE_MAX_MS 兜界：
	// 一个永不落定的布局就照原样揭开，揭开后的一次性检查仍能抓住离谱的误差。
	async settleSourcePixels(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean, maxMs: number) {
		if (!st || !st.scroll || st.scroll <= 0 || view.getMode() !== 'source')
			return;
		const cm = this.cmOf(view);
		if (!cm)
			return;
		const scroller = cm.scrollDOM;
		const targetLine1Based = st.scroll;
		const lineHeight = cm.defaultLineHeight || 20;
		// 这次 open 自己那一下不能算「用户在滚动」：只有比这个快照更新的触摸才中止落定。
		const touchBaseline = this.state.lastTouchAt;
		const start = Date.now();
		const deadline = start + maxMs;
		const measureDelta = this.targetTopMeasurer(view, cm, targetLine1Based);
		// 第一阶段 —— 收敛到**真实**测量上。不做高度图的粗跳：行还没渲染时，没有任何可信的
		// 东西可依据。什么都量不到时，主动请求一趟 CM6 测量 —— 交换后过期的高度图只有跑
		// 一趟才变真，而 CM6 不会仅仅因为我们在轮询就去排它。
		let converged = false;
		let prevDelta: number | null = null;
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			const delta = measureDelta();
			if (delta === null) {
				prevDelta = null;
				cm.requestMeasure();
				await nextPaint();
				continue;
			}
			if (Date.now() - start >= SETTLE_MIN_MS
				&& prevDelta !== null
				&& Math.abs(delta - prevDelta) <= lineHeight / 2) {
				converged = true;
				break;
			}
			prevDelta = delta;
			await nextPaint();
		}
		if (!converged)
			return;

		// 第二阶段 —— 纠正，然后校验这次纠正**守住了**（最多 2 次）。阈值忽略两行以下的残余：
		// 它们几乎看不见，追它们正是过去的抖动。施加纠正**之前**，强制跑一趟 CM6 测量并
		// 重检：按视口闸门算「已渲染」，仍可能意味着一段没测过的 DOM，其坐标反映的是过期的
		// 高度图 —— 强制测量之后，同一行读出的才是它真正的差值。
		let corrections = 0;
		while (corrections < 2 && isCurrent()) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			const delta = measureDelta();
			if (delta === null)
				return;
			if (Math.abs(delta) <= lineHeight * 2)
				return; // 在视觉顶部对齐
			cm.requestMeasure();
			await nextPaint();
			await nextPaint();
			const rechecked = measureDelta();
			if (rechecked === null)
				return;
			if (Math.abs(rechecked) <= lineHeight * 2)
				return;
			scroller.scrollTop += rechecked; // 精确的残余纠正
			corrections++;
			const verifyDeadline = Date.now() + SETTLE_VERIFY_MS;
			while (isCurrent() && Date.now() < verifyDeadline) {
				if (this.state.lastTouchAt > touchBaseline)
					return;
				await nextPaint();
			}
		}
	}

	// 揭开后的**一次性**离谱误差检查：只纠正偏了半个视口以上（落到最底等）的落点，且只纠
	// 一次。精确的活已经在遮罩下做完了（settleSourcePixels）；它存在是为了那些没有落定的
	// 路径（源码滑行）或落定超时的路径。按设计不循环：对着 open 流水线自己的重应用做多轮
	// 纠正，就是那场可见的拉锯；离谱误差修一次，读起来就是一次单纯的落位。
	private async relandSourcePixels(
		view: MarkdownView,
		target: number,
		isCurrent: () => boolean,
		touchBaseline: number,
	) {
		if (!isCurrent())
			return;
		// 比这次 open 自己那一下更新的触摸，说明读者已经接管了视口。
		if (this.state.lastTouchAt > touchBaseline)
			return;
		const cm = this.cmOf(view);
		if (!cm)
			return;
		const scroller = cm.scrollDOM;
		if (!this.docMatchesView(view, cm))
			return; // 文档里还是上一个文件：任何测量都是垃圾
		if (target + 1 > cm.state.doc.lines)
			return; // 保存的那一行超出 EOF（文件在磁盘 / 同步中变了）
		const lineFrom = cm.state.doc.line(target + 1).from;
		// 与落定相同的「已渲染行」闸门：未渲染行的 coordsAtPos 是高度图估算值（交换期间是
		// 垃圾）—— 拿它去纠正，**曾**是一次跳到错误位置的可见跳跃。
		if (lineFrom < cm.viewport.from || lineFrom >= cm.viewport.to)
			return;
		// 相信这次回读之前，强制跑一趟新的测量：「在视口内」仍可能意味着一段没测过的 DOM
		// 在读过期高度图的坐标。
		cm.requestMeasure();
		await nextPaint();
		await nextPaint();
		const coords = cm.coordsAtPos(lineFrom);
		if (!coords)
			return;
		const delta = coords.top - scroller.getBoundingClientRect().top;
		if (Math.abs(delta) > scroller.clientHeight / 2)
			scroller.scrollTop += delta; // 精确的残余纠正
	}
}
