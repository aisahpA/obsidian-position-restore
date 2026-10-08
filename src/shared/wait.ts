import { FileView, MarkdownView } from 'obsidian';
import { EphemeralState } from '@/types';
import { applyEphemeralState, readEphemeralState } from '@/position/capture/ephemeral';

// 恢复之后先固定地等一小会儿，再启动变化检测：用来兜住恢复完成后的版面抖动
// （图片解码、块重新排版）。
export const ANCHOR_SETTLE_DELAY = 100;

// 打开阅读模式时等渲染器的上限。较新的 Obsidian 每次打开都会把阅读视图异步重绘一遍 ——
// 大文件要几秒才有可滚动的内容 —— 所以这份预算给得宽。**不遮的那条路（landPreview）让它当
// 独立上限**；遮罩那条路则把它当成整条遮罩预算里「内容就绪」这一段的上限（见
// RESTORE_MASK_BUDGET_PREVIEW）。
export const CONTENT_READY_MAX_MS = 2000;

// 揭幕之前，确认恢复已经在保护窗口下落定 —— 源码模式下这个确认的最长时限。
// 源码模式是同步的，而「没落定」在它那里只意味着编辑器还在测量，几百毫秒就够；
// 真正的落位另有那套像素纠正（pixels.ts），不靠这个等待。
//
// 它同时也是**源码那条路**上「揭幕确认」这一步的预算：源码的内容就绪是瞬时的
// （isContentReady 对源码直接返回 true），所以这里不必像阅读那样跟别的等待共享一条线。
// ⚠️ 源码遮罩里还有一段与渲染无关的像素落定（pixels.ts 的 SETTLE_MAX_MS 800，在揭幕前跑），
// 它不归这条预算管；源码整段遮罩的外层上界由 COVER_SAFETY_MS 兜着。
export const RESTORE_PAINT_DEADLINE = 600;

// 阅读恢复的遮罩，**从盖上那一刻到揭幕的总预算**：内容就绪与「确认已落定」共享这一条。
// 别拆成几条独立的预算 —— 它们会相加（曾经就是 2000 + 2000 = 4 秒，手机上一眼可见），
// 而读者能感知的只有「盖上到揭开」这一段，所以只该有一个数。
//
// 这个等待为什么不能省：预览渲染器是**分趟**跑的（每趟 5ms 渲染预算，下一趟排在
// requestAnimationFrame 上），而它的 applyScroll 第一句就是「目标行**之前**的每个 section
// 都必须已经渲染并量过高度，否则拒绝」⇒ **什么时候能落由渲染器决定，跟谁先请求、什么时候
// 请求都无关。** 所以稍微大一点的笔记就过不了源码那 600ms：遮罩提前揭开，读者看到的是还停在
// 顶部的半成品，而那次没能落下去、被排进渲染器 rendered 队列的施加会在后面某一趟悄悄生效
// ⇒ 那一下「接着跳」。
//
// 代价就是**空白**，而这段空白本来就在：渲染器必须从顶部一路渲染到目标行，这段时间读者
// 要么看着内容逐段长出来（然后跳），要么看着遮罩（等）。1500 是用户在手机上见过 4 秒之后
// 拍的（2026-10-08：「4 秒时间确实有点长了」）。到点照常揭幕，超预算的笔记回到「先看见顶部
// 再跳」，那段残差由移动端本来就有的 drift 纠正循环（pixels.ts 的 relandDriftedScroll）收掉。
export const RESTORE_MASK_BUDGET_PREVIEW = 1500;

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}

// 在下一帧完成时 resolve —— 这是「这一次待处理的绘制必定已经合成」最早的时刻。
// 窗口隐藏时 rAF 会停摆，所以要跟一个 timeout 赛跑，免得恢复悬着不动。
export function nextPaint(): Promise<void> {
	return new Promise(resolve => {
		let done = false;
		const timeout = window.setTimeout(() => {
			if (done) return;
			done = true;
			resolve();
		}, 100);
		window.requestAnimationFrame(() => {
			if (done) return;
			done = true;
			// rAF 赢了：顺手清掉那个没人管的 timeout，免得每帧都调它的恢复循环堆一地死定时器。
			window.clearTimeout(timeout);
			resolve();
		});
	});
}

// 阅读渲染器真正产出内容后才 resolve；永远追不上的视图则由上限兜住。轮询渲染状态而不是
// 死睡一段固定时间，是为了让被遮住的空白时长恰好等于真实渲染时间，上面不再叠一个人为的下限。
//
// `maxMs` 是「最多等它多久」。遮罩那条路传进来的是整条遮罩预算**剩下的那部分**，好让
// 「内容就绪 + 揭幕确认」一起落在同一个 deadline 之内（见 RESTORE_MASK_BUDGET_PREVIEW）。
export async function waitForContentReady(
	view: MarkdownView,
	isCurrent: () => boolean,
	maxMs = CONTENT_READY_MAX_MS,
): Promise<void> {
	const deadline = Date.now() + maxMs;
	while (isCurrent() && Date.now() < deadline) {
		if (isContentReady(view))
			return;
		await nextPaint();
	}
}

function isContentReady(view: MarkdownView): boolean {
	// 源码模式不需要异步渲染；编辑器是同步的。
	if (view.getMode() === 'source')
		return true;
	// preview sizer 装着渲染好的块；异步渲染没完成前它是空的或还没布局。追赶期间渲染器也不
	// 报告滚动位置 —— 被复用的 leaf 会短暂地摆着上一篇笔记的版面 —— 所以恢复前必须先把渲染器
	// 等到可用。
	const sizer = view.containerEl.querySelector<HTMLElement>('.markdown-preview-sizer');
	return !!sizer && sizer.children.length > 0 && sizer.scrollHeight > 0
		&& view.currentMode?.getScroll() != null;
}

// setEphemeralState() 要求的那个状态，是不是视图现在报出来的状态。滚动按精确相等比较：
// applyScroll 的落点与请求相差约 0.04 行，而 Math.round 的 ±0.5 死区能吃掉这点误差。
// 回读不到光标视为折叠的 (0,0) 光标 —— 编辑器的默认形态 —— 于是和存下来的 (0,0) 光标算一致。
//
// ⚠️ **「读不出来」算「还没落定」，不是「已经落定」**：阅读渲染器没量完时 getScroll() 报
// null（绝不是 0，见 capture/ephemeral.ts），readEphemeralState 于是返回 undefined，这里
// 返回 false，调用方继续等。别把它改成「读不到就当已落定」—— 那会让遮罩在渲染中途揭开，
// 正是「先看见顶部」本身。
function isRestoreStuck(view: MarkdownView, st: EphemeralState): boolean {
	const now = readEphemeralState(view);
	if (!now)
		return false;
	if ((st.scroll ?? 0) > 0 && (
		now.scroll !== st.scroll
		// 阅读模式会在真正滚动之前就把请求的 scroll 回显出来，所以光看回读值对不对，
		// 会把一个「还没落到那一行」的开头当成成功。必须要求真正的滚动容器也动了。
		|| (view.getMode() === 'preview' && !hasPreviewScrolled(view))
	))
		return false;
	const want = st.cursor;
	if (!want)
		return true;
	const got = now.cursor ?? { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
	return want.from.line === got.from.line && want.from.ch === got.from.ch
		&& want.to.line === got.to.line && want.to.ch === got.to.ch;
}

// 恢复下来的位置连续三帧没被改动后才 resolve（永远追不上的视图由上限兜住）。阅读模式要等渲染器
// 产出目标行才会真的滚动，而分阶段的打开流程可能在它刚落下之后又把它重置 —— 所以在保护窗口里
// 一旦漂了就重画；只有没人再跟它抢时才揭幕。
//
// `maxMs` 是「还没落定时最多陪你等多久」。**遮罩那条路传的是整条遮罩预算剩下的那部分**
// （见 RESTORE_MASK_BUDGET_PREVIEW）—— 传成一条独立的新预算就等于把它翻倍。不遮的那条路
// （landPreview）留在默认值上：那里揭幕不是它决定的，等多久都不改变读者看见什么。
export async function waitForRestorePainted(
	view: MarkdownView,
	st: EphemeralState,
	isCurrent: () => boolean,
	maxMs = RESTORE_PAINT_DEADLINE,
) {
	const deadline = Date.now() + maxMs;
	let stableFrames = 0;
	while (Date.now() < deadline && isCurrent()) {
		await nextPaint();
		if (!isCurrent())
			return;
		if (isRestoreStuck(view, st)) {
			if (++stableFrames >= 3)
				return;
		} else {
			stableFrames = 0;
			applyEphemeralState(view, st);
		}
	}
}

// 当前模式下真正在滚的那个元素：源码模式是 .cm-scroller，阅读模式是 .markdown-preview-view，
// base 视图是 .bases-view —— 后者是唯一会被记录/恢复的非 markdown FileView（pdf/图片/canvas
// 从不）。这些容器都在 devtools 里逐个核实过（每个都带 overflow-y: auto 且持有存下来的 scroll）；
// querySelector 按文档顺序返回最外层的匹配，所以嵌入的笔记盖不住真正的容器。短到不用滚动的
// 笔记也会返回元素 —— 调用方对 scrollTop 0 的处理是一样的。只用于阅读模式的调用方在自己那侧
// 由 getMode() 把着。
export function getScroller(view: FileView): HTMLElement | null {
	if (view instanceof MarkdownView)
		return view.getMode() === 'source'
			? view.contentEl.querySelector<HTMLElement>('.cm-scroller')
			: view.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
	return view.containerEl.querySelector<HTMLElement>('.bases-view');
}

// 阅读视图真正的滚动容器是不是动了。阅读渲染器会在任何像素移动之前就把请求的 scroll 报进
// getScroll()，所以用这一步来区分「已经渲染并滚动了」和「早晚到得了」。
export function hasPreviewScrolled(view: MarkdownView): boolean {
	const scroller = getScroller(view);
	return !!scroller && scroller.scrollTop > 0;
}
