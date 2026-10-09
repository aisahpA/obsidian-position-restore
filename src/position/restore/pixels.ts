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
	// CM6 公开 API：屏幕坐标处的文档位置。探「视口底边」这种落在**可见区之内**的点时一定
	// 答得出一个位置；只有落点所在的区块不在已渲染的视口里时才返回 null（短盖的第二个读数
	// 拿它取视口里最后一条可见行，见 settleShortCover）。
	posAtCoords(coords: { x: number; y: number }): number | null;
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

// 落定的第一次纠正被信任之前的最短时间（settleSourcePixels；两条被遮住的路 —— 后台标签页的
// settleAndHold 与前台注入 open 的 settleShortCover —— 用各自的读数时钟取代了这段死等）。
// core 自己的 scroll 重应用在 open 后约 145ms 内落地；200ms 带余量地跨过那个窗口。
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

// 前台（可见）注入 open 的「短盖」预算。**两个数的起点不同，这不是笔误**：
//  · FLOOR —— 最早可以揭幕的时刻，**从第一次量到真几何**那一刻起算（settleShortCover 内部
//    取的时刻）。core 自己那次重落（约 85~145ms）是跟着**内容交换**走的，而第一次量到真几何
//    也正是在交换之后，所以这条下限永远跑在重落之后的真实地面上。
//  · MAX —— 遮罩最多盖这么久，**从它真正盖上那一刻**起算（ui/cover.ts 的 appliedAt）：
//    新内容到位之前这道遮罩什么也没遮住（屏幕上还是上一篇笔记），所以那段时间不该算进
//    「别把读者按住太久」这条上界里 —— 2026-10-09 之前从**武装**那一刻起算，大文件（读盘
//    几百 ms）于是白吃掉一小半预算。量不到真几何（目标行还没渲染出来）就一直盖到这里，
//    然后照常揭幕，落点交给揭开后的一次性检查。外面还有 cover.ts 的 COVER_SAFETY_MS（2000）
//    兜底，它同样从真正盖上那一刻起算。
export const SOURCE_COVER_FLOOR_MS = 150;
export const SOURCE_COVER_MAX_MS = 1000;

// 短盖下判定「它不再动」的静默窗口：约两帧。比 SETTLE_HOLD_QUIET_MS（100ms，读者看不见的后台
// 那条路）小得多 —— 前台每多盖一帧就是读者多盯着空白一帧。窗口里比的是**两个读数有没有离开
// 窗口起点**（见 settleShortCover），所以它不需要靠长度来攒出可信度：任何一点位移都把窗口
// 打回起点重来。
//
// ⚠️ 它是**下限**，不是定值：慢设备上一帧本身就长（下一次 nextPaint 可能要几十上百 ms），
// 而编辑器的测量是**按帧**推进的 —— 同样 32ms，在 60fps 的桌面上是两次观察机会，在手机上
// 可能只有半次。所以 settleShortCover 实际用的是 max(它, 2 × 最近一次观察到的帧间隔)，让
// 这个窗口跟着设备的真实节奏走（桌面上恒等于它，行为一字不变）。
const SOURCE_COVER_STABLE_MS = 32;

// 短盖下等编辑器实例出现的上限。视图已经握住了这篇笔记的内容、编辑器却还没挂上（视图刚构造完
// / 刚刚重建）是**真实存在**的一小段：此刻正是最该盖住的时候，绝不能当成「没有什么可量的」
// 就把遮罩撤了 —— 那正是「新内容出现后自己动」。有界，等不到才交回（外层还有短盖的 deadline）。
//
// ⚠️ 「有界」是它存在的理由之一，**别**把它放大成 deadline（2026-10-09 试过、回退了）：真机上
// 内容与编辑器几乎同时到位（视图构造是同步的），量不到编辑器只意味着这一帧的兜底还没走完；
// 而等满 deadline 会让「压根挂不上」的场合一律白盖到上界 —— 恢复那条路于是整整晚 600ms 才
// 收口（实测 tests/restorer-injected-activate 的时长从约 500ms 涨到 1120ms）。
const SOURCE_COVER_WAIT_CM_MS = 400;

// 等编辑器真换上**这篇**笔记的内容的上限（modes.waitContentArrived —— 判据是「文档对象换
// 掉了没有」，见 noteArrived）。跨文件打开时，'file-open' 与文档交换之间有一段空档：同 leaf
// 切换的编辑器会在几百 ms 里仍握着上一个文件的内容。这段空档里的限制与编辑器无关的事一件都
// 不能做 —— 派发到旧文档上的编辑器原语全部作废（甚至更糟：它的 scroll effect 可能在交换之后
// 才被应用），而在旧文档上量像素会得出「已经量完了」的假结论（短盖会当场揭幕）。上限只管挡住
// 「永远等不到」这一种，到点照常放行 —— 调用方那侧还有自己的检查。
// 同一个数也是「等盖布真的盖上」那条等待的预算（modes.waitCoverApplied）—— 两者等的是同一件
// 事（新内容到位），而那段等待不产生空白（屏幕上还是上一篇笔记，见 ui/cover.ts 的 cover()），
// 所以不必各给一份。
export const DOC_READY_MAX_MS = 1200;

// 屏幕上**那一刻那一篇笔记**的身份 —— 三样都只用来「与后来比一比」，谁都不解引用编辑器。
// patcher 在武装那道闸门时取一份，之后每次求值都拿它比（见 noteArrived）。
export interface ScreenNote {
	view: MarkdownView;
	// 编辑器里的文档对象；武装那一刻摸不到编辑器时 undefined。
	doc?: object;
	// 视图自己那份内容。编辑器摸不到时，它是**唯一**还能用的证据。
	data: unknown;
}

// 源码模式的像素落位：遮罩下的等待与纠正（短盖的 settleShortCover、masked 与后台标签页的
// settleSourcePixels / settleAndHold）、揭开后的一次性离谱检查（relandSourcePixels）、
// 移动端的自适应回读循环（relandDriftedScroll），以及「编辑器里的文档换掉了没有」那一个
// 读数（docIdentity / noteArrived —— 遮罩什么时候动手与恢复流水线什么时候才碰编辑器，都问它）。
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

	// 编辑器的文档与视图的 data 相符 —— **这不是**「换文档了没有」的判据（理由见 noteArrived），
	// 只是一道廉价的「编辑器此刻不在一次交换的途中吗」的闸门：那一次交换里 data 先写、doc 后
	// 换，两者之间没有 await，所以它其实只在那一瞬为假。留着它是因为每个测量器都要一个最低
	// 保证：读到的数字不是刚被换掉的那一版。先做廉价的长短比较，长度相等才做完整比对。
	private docMatchesView(view: MarkdownView, cm: CmLike): boolean {
		const data = view.data;
		if (typeof data !== 'string' || data.length === 0)
			return true; // 没有可比对的东西：绝不因此阻塞
		const doc = cm.state.doc;
		if (doc.length !== data.length)
			return false;
		return doc.toString() === data;
	}

	// 编辑器里那个**文档对象**的身份（只比引用，不解引用）。摸不到编辑器时 undefined。
	docIdentity(view: MarkdownView): object | undefined {
		return this.cmOf(view)?.state.doc;
	}

	// 编辑器里现在是不是**这篇**笔记的内容了 —— **恢复流水线**什么时候才许碰编辑器
	// （modes.restoreInjectedSource）的答案。⚠️ 遮罩**动手的时机**不再由它定：遮罩在 open
	// 一开始就盖上（见 patcher.maybeCoverOpen 与 ui/cover.ts 的 cover()），它只挡恢复流水线
	// （居中、短盖量的都是像素，落在旧文档的几何上作废）。
	//
	// ⚠️ **别退回「文档与 `view.data` 相符」**：core 的 loadFile 是「先把 view.file 换成新文件
	// → `await` 读盘 → 最后 setData」，而 setData 又是先写 data 再 setViewData —— 于是读盘
	// 那几百 ms 里 view.file 已经是新的，而 data 与文档**都还是上一篇**的，两者一起换。
	// 「相符」在换之前与换之后都成立，拿它判断等于不判：2026-10-09 实测，甲（新内容到了才遮）
	// 因此整条失效 —— 遮罩照旧在读盘那一刻就盖上；手机上读盘更慢，整条恢复流水线（居中、
	// 短盖）都跑在**旧文档**的几何上，而旧文档的几何是稳的，短盖于是当场判定「量完了」而揭幕。
	// **这里比的是「武装那一刻记下的旧内容」与「现在的内容」** —— 一次真正的变化检测，
	// 与那个恒真的判据不是一回事。
	//
	// ⚠️ **也别在读不到编辑器时答「到了」**（2026-10-09 晚，手机上「还是一样的」就是它）：
	// 「屏幕上本来就没有上一篇」（全新 leaf / 非 markdown / 同一篇的重放）与「有上一篇、
	// 但这一刻读不到它的文档」是**相反**的两种情况，早先却共用同一个 `undefined` 出口。
	// 后者答「到了」等于把闸门直接打开：遮罩立刻盖上（读盘那几百 ms 变成空白），而整条
	// 恢复流水线（居中、短盖量的都是像素）跑在上一篇的几何上 —— 表现就是手机上那套
	// 「内容出现后由源码自己动」。读不到编辑器时改用 `view.data`（视图自己那份内容，
	// `setData` 写它与换文档是同一件事）：**还没装上内容（空串）一律算没到**。
	noteArrived(view: unknown, from: ScreenNote): boolean {
		if (!(view instanceof MarkdownView))
			return true; // 这块地方已经不放 markdown 视图了：没有旧画面要留
		if (view === from.view && from.doc !== undefined) {
			const doc = this.docIdentity(view);
			// setData → setViewData → Editor.setValue 是一次**整篇替换**的 dispatch
			// （`{from:0,to:doc.length,insert}`，解包 obsidian.asar 实测）⇒ 必然产出新的文档对象。
			if (doc !== undefined)
				return doc !== from.doc;
		}
		return typeof view.data === 'string' && view.data.length > 0 && view.data !== from.data;
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

	// 短盖的第二个读数：**视口里最后一条可见行**相对滚动容器顶的像素偏移。读者唯一能看见的
	// 就是眼前这条带子，它的下沿不动，画面就没动。
	//
	// 取法是拿滚动容器的底边去问 CM「那一点是文档里的哪个位置」——CM 会把落点夹到最近的边缘，
	// 所以探针落在可见区之内时一定答得出一个行号；只有那一点所在的区块不在**已渲染**的视口里
	// 才返回 null（此刻没有任何可信的读数，调用方不许揭）。拿不到位置时就退回文档最后一行：
	// 短到不用滚动的笔记走的是这一支，而它的读数一样是「眼前那条带子」。
	//
	// ⚠️ 别退回**整篇文档的测量高度**（`scrollHeight`）：视口下方的区块换成真值也算在里面，
	// 那会把遮罩按到上界而不关读者的事（见 settleShortCover）。
	private bottomVisibleMeasurer(cm: CmLike): () => number | null {
		const scroller = cm.scrollDOM;
		return () => {
			const rect = scroller.getBoundingClientRect();
			// x 取横向中点：避开行号槽，也避开左右边缘的折行 / bidi 边角。
			const at = cm.posAtCoords({
				x: rect.left + rect.width / 2,
				y: rect.bottom - 2,
			}) ?? cm.state.doc.line(cm.state.doc.lines).from;
			const coords = cm.coordsAtPos(at);
			return coords ? coords.top - rect.top : null;
		};
	}

	// 前台（可见）注入 open 的「短盖」：遮罩只盖到编辑器**量完了**为止，即同时满足
	//  · 下两个读数在同一个窗口里都**没离开过窗口起点**（约两帧），且
	//  · 距第一次量到真几何已经过了 SOURCE_COVER_FLOOR_MS（跨过 core 自己那次重落）。
	//
	// 盖的是刚交换进来的新内容还带着估算高度的那几帧：在编辑器量完之前画出来的帧，必定被
	// 随后的一次测量修正推动（core 的两段式落地），那一下就是读者看见的「内容自己动」（见
	// patcher.maybeCoverOpen）。**它不纠正任何东西** —— 落点的精确纠正只有揭开后的一次性检查
	// （relandSourcePixels）。在遮罩下纠正会把遮罩按住更久，而那段空白是读者能感觉到的代价，
	// 于是这条路上宁可让落点由 core 自己落、由揭开后那一步兜。
	//
	// 「不再动」要**同时**看两个读数，只看一个会漏掉读者真正看见的那种位移（2026-10-09 实测）：
	//  1. 保存那一行相对滚动容器顶的像素偏移 —— 它管的是「落点对不对」；
	//  2. **视口里最后一条可见行**相对滚动容器顶的像素偏移 —— 它管的是「眼前那条带子会不会挪」。
	// 光看第 1 个是量错了地方：core 的重落把**同一行**落在同一个偏移上，那一行的读数全程约等于
	// 0；真正动的是它**下面**那些刚从估算换成真值的区块，而读者看见的正是整条带子往下挪。
	//
	// 第 2 个读数**不是整篇文档的测量高度**（`scrollHeight`，2026-10-09 之前是它）：视口**下方**
	// 的区块换成真值、嵌入的图片与嵌入的笔记加载完，都会把总高度改掉却改不动眼前那条带子 ——
	// 读者一点都看不见，却一直把遮罩按到上界。文件越大、视口外没量过的区块越多，白等得越久，
	// 正是用户报的「稍微大一点的文件，空白明显更长」。
	//
	// 而两个读数都是**与稳定窗口的起点**比，不是与上一帧比（2026-10-09 第三轮实测：手机上的大
	// 文件仍会动）。逐帧比有一个洞：测量是一小步一小步推进的，每帧只挪几个像素（都不到半行）
	// ⇒ 逐帧比较一路判「没动」，窗口照走，32ms 后揭开 —— 可内容还在继续挪。与起点比则要求
	// 「这两个读数在一个窗口之内都没离开过起点」，任何累积位移都把窗口打回起点重来。代价是
	// 真在动的那些 open 会盖得更久（读者不看见位移就是这条路的全部目的），到 deadline 照揭。
	//
	// 由 deadline 兜界；量不到（文档交换中 / 目标行未渲染）就一直推测量趟，到点照常揭。
	// 比这次 open 自己那一下更晚的触摸会中止它 —— 读者接管了视口，遮罩照揭。
	//
	// ⚠️ **起手先让编辑器把新文档画出来**（2026-10-09 晚，手机上「内容出现后自己动」查到的最后
	// 一个洞）：`noteArrived` 在 `setData` 那一刻就答「到了」，而 CM6 换文档只在 `state.doc` 上**同步**
	// 换掉，视口重算与 DOM 重画排在它自己的测量趟里（requestAnimationFrame）。于是从「文档换掉」
	// 到「屏幕上真的画的是新文档」之间隔着一帧 —— 这段里 `coordsAtPos` 读到的还是**旧文档的
	// 像素**，而旧文档是稳的 ⇒ 两个读数一动不动 ⇒ 窗口走完（32ms）就揭幕，接着 CM6 才把新文档
	// 画出来并测量，读者看见的正是那一下。桌面上一帧只有 16ms、测量趟通常赶在这一帧里，所以
	// 看不出来；手机上一帧长得多，这段空窗就露在明面上。起手先推一趟测量、跨两帧，把这段
	// **必然发生**的空窗吃掉（代价是每次 open 多约两帧，约 33ms）。
	async settleShortCover(
		view: MarkdownView,
		targetLine1Based: number,
		isCurrent: () => boolean,
		touchBaseline: number,
		deadline: number,
	) {
		let cm = this.cmOf(view);
		if (!cm) {
			// 内容已经进来了（调用方等过 waitContentArrived），编辑器却还没挂上：有界地等它。
			const waitUntil = Math.min(deadline, Date.now() + SOURCE_COVER_WAIT_CM_MS);
			while (isCurrent() && Date.now() < waitUntil) {
				await nextPaint();
				cm = this.cmOf(view);
				if (cm)
					break;
			}
			if (!cm)
				return;
		}
		// 起手那一趟：把「旧文档的像素」这一页翻过去（见上面那段）。requestMeasure 是我们的
		// 请求，CM6 自己换文档时排的那一趟可能已经排在同帧 —— 再推一次是幂等的。
		cm.requestMeasure();
		await nextPaint();
		await nextPaint();
		if (!isCurrent())
			return;
		const measure = this.targetTopMeasurer(view, cm, targetLine1Based);
		const measureBottom = this.bottomVisibleMeasurer(cm);
		const lineHeight = cm.defaultLineHeight || 20;
		// 两个读数共用同一把尺：半行以内算「没离开起点」。它比的是窗口起点与当前值（不是两个
		// 相邻样本之间），所以容差只吃掉舍入噪声 —— 累积位移一律算「还在动」。
		const stillLimit = lineHeight / 2;
		let anchorTop: number | null = null;
		let anchorBottom = 0;
		let stillSince = -1;
		// 第一次拿到真几何的时刻 —— 揭幕下限从它起算（见常量注释）。
		let realSince = -1;
		// 上一次观察的时刻：用它算出设备当前的帧间隔，把静默窗口按真实节奏缩放（见常量注释）。
		let sampledAt = Date.now();
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			const delta = measure();
			if (delta === null) {
				cm.requestMeasure(); // 推一把：过期的高度图只有跑一趟测量才变真
				anchorTop = null;
				stillSince = -1;
				await nextPaint();
				continue;
			}
			const now = Date.now();
			const frameGap = Math.max(1, now - sampledAt);
			sampledAt = now;
			if (realSince < 0)
				realSince = now;
			const bottom = measureBottom();
			if (bottom === null) {
				// 眼前那条带子量不到（视口里一条行都还没渲染出来）：没有可信的读数就不揭，
				// 推一把测量再等一帧。
				cm.requestMeasure();
				anchorTop = null;
				stillSince = -1;
				await nextPaint();
				continue;
			}
			if (anchorTop === null
				|| Math.abs(delta - anchorTop) > stillLimit
				|| Math.abs(bottom - anchorBottom) > stillLimit) {
				// 离开起点 ⇒ 它还在动：窗口从这一帧重新起算（起点也换成当前读数）。
				anchorTop = delta;
				anchorBottom = bottom;
				stillSince = -1;
				await nextPaint();
				continue;
			}
			if (stillSince < 0) {
				stillSince = now;
				// **现在**就推一把测量趟：静默窗口与揭幕决策于是跑在刷新的真几何上，
				// 揭开时也就不必再多等一次测量。
				cm.requestMeasure();
			}
			if (now - stillSince >= Math.max(SOURCE_COVER_STABLE_MS, frameGap * 2)
				&& now >= realSince + SOURCE_COVER_FLOOR_MS)
				return;
			await nextPaint();
		}
	}

	// 被遮住的后台注入标签页用的「精确落位 + 揭开」合并门控（modes.ts 的
	// settleInjectedReveal —— 前台那条可见的路走 settleShortCover，不在这里做纠正）。
	// 一个循环**同时**决定落点要不要修、
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

	// 源码像素落定 —— maskedRestore 自己的 contentEl 遮罩下的精确落位。后台注入标签页
	// 那条被遮住的路用 settleAndHold，它把这次「收敛 + 纠正」与揭开决策合并在一起。
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
