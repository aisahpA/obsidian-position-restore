import { FileView, MarkdownView } from 'obsidian';
import { EphemeralState } from '@/types';
import { applyEphemeralState, readEphemeralState } from '@/position/capture/ephemeral';

// Fix wait after a restore before anchoring change detection: covers
// post-restore layout shifts (image decode, block resizing).
export const ANCHOR_SETTLE_DELAY = 100;

// Bounded max for the pre-restore wait for the reading renderer. Recent
// Obsidian versions re-render a reading note asynchronously on every open —
// large notes take seconds before any scrollable content exists — so this
// budget is generous; waitForRestorePainted carries the restore the rest of
// the way once content lands.
export const CONTENT_READY_MAX_MS = 2000;

// Bounded deadline for confirming a restore has settled under cover before
// revealing.
export const RESTORE_PAINT_DEADLINE = 600;

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}

// Resolves on the next animation frame — the earliest moment a pending paint
// has certainly been composited. rAF stalls while the window is hidden, so
// race it with a timeout to avoid hanging restores.
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
			// The rAF won the race: drop the dangling timeout so restore loops
			// that call this every frame don't pile up dead timers.
			window.clearTimeout(timeout);
			resolve();
		});
	});
}

// Resolves once the reading renderer has produced the note's content, or
// after a bounded wait for views that never catch up. Polling render state
// instead of sleeping a fixed delay keeps the covered blank time equal to
// the real render time, with no arbitrary minimum on top.
export async function waitForContentReady(view: MarkdownView, isCurrent: () => boolean): Promise<void> {
	const deadline = Date.now() + CONTENT_READY_MAX_MS;
	while (isCurrent() && Date.now() < deadline) {
		if (isContentReady(view))
			return;
		await nextPaint();
	}
}

function isContentReady(view: MarkdownView): boolean {
	// Source mode needs no async render; the editor is synchronous.
	if (view.getMode() === 'source')
		return true;
	// The preview sizer holds the rendered blocks; before the async render
	// completes it is empty or not yet laid out. The renderer also reports no
	// scroll until it has caught up — a reused leaf can briefly show the
	// previous note's layout — so require a usable renderer before restoring.
	const sizer = view.containerEl.querySelector<HTMLElement>('.markdown-preview-sizer');
	return !!sizer && sizer.children.length > 0 && sizer.scrollHeight > 0
		&& view.currentMode?.getScroll() != null;
}

// Whether the state requested in setEphemeralState() is what the view now
// reports. Scroll is compared exactly: applyScroll lands within ~0.04 line of
// the request and Math.round's ±0.5 dead zone absorbs that. A missing
// readback cursor means a collapsed (0,0) cursor — the editor's default — so
// it matches a saved (0,0) cursor.
function isRestoreStuck(view: MarkdownView, st: EphemeralState): boolean {
	const now = readEphemeralState(view);
	if (!now)
		return false;
	if ((st.scroll ?? 0) > 0 && (
		now.scroll !== st.scroll
		// Reading view echoes the requested scroll before it has actually
		// scrolled, so a matching readback alone would confirm an un-landed
		// top. Require the real scroller to have moved too.
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

// Resolves once the restored position has STAYED put for three consecutive
// frames (or after a bounded wait for views that never catch up). Reading
// view applies a scroll only once its renderer has produced the target lines,
// and the staged open pipeline can reset it after it first lands — so keep
// re-applying on drift while covered, and uncover only when nothing fights.
export async function waitForRestorePainted(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
	const deadline = Date.now() + RESTORE_PAINT_DEADLINE;
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

// The element that actually scrolls the view in its CURRENT mode: .cm-scroller
// in source, .markdown-preview-view in reading, .bases-view for base views —
// the only non-markdown FileView ever recorded/restored (pdf/image/canvas
// never are). Containers verified in devtools (each carries overflow-y: auto
// and holds the saved scroll); querySelector returns the outermost match in
// document order, so embedded notes never shadow the real container. Also
// returned for short notes that don't scroll — callers treat scrollTop 0
// identically. Reading-only callers are guarded by getMode() at their sites.
export function getScroller(view: FileView): HTMLElement | null {
	if (view instanceof MarkdownView)
		return view.getMode() === 'source'
			? view.contentEl.querySelector<HTMLElement>('.cm-scroller')
			: view.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
	return view.containerEl.querySelector<HTMLElement>('.bases-view');
}

// Whether a reading view's real scroller has actually moved. A reading
// renderer can report the requested scroll in getScroll() before any pixel
// moves, so this distinguishes "rendered and scrolled" from "will get there".
export function hasPreviewScrolled(view: MarkdownView): boolean {
	const scroller = getScroller(view);
	return !!scroller && scroller.scrollTop > 0;
}

// Animates a scroll container's scrollTop with easeInOutSine, so reading-view
// restores move at one legible speed instead of stepping through Obsidian's
// render pipeline. Writing scrollTop directly is what native scrolling does,
// so lazy-rendered content paints smoothly as it comes into view. A timeout
// races the rAF loop so a hidden window can't stall the restore.
export async function animateScrollTop(
	el: HTMLElement,
	from: number,
	to: number,
	duration: number,
	isCurrent: () => boolean,
): Promise<void> {
	if (duration <= 0 || from === to) {
		el.scrollTop = to;
		return;
	}
	const startTime = performance.now();
	const dist = to - from;
	return new Promise(resolve => {
		const step = (now: number) => {
			if (!isCurrent()) {
				resolve();
				return;
			}
			const t = Math.min(1, (now - startTime) / duration);
			const eased = (1 - Math.cos(Math.PI * t)) / 2;
			el.scrollTop = from + dist * eased;
			if (t < 1)
				window.requestAnimationFrame(step);
			else
				resolve();
		};
		window.requestAnimationFrame(step);
		window.setTimeout(resolve, duration + 100);
	});
}
