import { FileView, MarkdownView } from 'obsidian';
import { EphemeralState } from './types';
import { applyEphemeralState, readEphemeralState } from './ephemeral';

// Fix wait after a restore before anchoring change detection. Covers
// post-restore layout shifts (image decode, block resizing).
export const ANCHOR_SETTLE_DELAY = 100;

// Bounded max for the pre-restore wait for the reading renderer to produce
// the note (replaces the removed delayAfterFileOpening setting): covers
// notes whose async render is unusually slow. Recent Obsidian versions
// re-render a reading note asynchronously on every open — large notes can
// take seconds before the renderer reports any scrollable content — so this
// budget is generous; waitForRestorePainted carries the restore the rest of
// the way once content actually lands.
export const CONTENT_READY_MAX_MS = 2000;

// Bounded deadline for confirming a restore has settled under cover before
// revealing.
export const RESTORE_PAINT_DEADLINE = 600;

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Resolves on the next animation frame — the earliest moment a pending
// paint has certainly been composited. rAF stalls while the window is
// hidden, so race it with a timeout to avoid hanging restores.
export function nextPaint(): Promise<void> {
	return new Promise(resolve => {
		let done = false;
		const timeout = setTimeout(() => {
			if (done) return;
			done = true;
			resolve();
		}, 100);
		requestAnimationFrame(() => {
			if (done) return;
			done = true;
			// The rAF won the race: drop the dangling timeout so restore
			// loops that call this every frame don't pile up dead timers.
			clearTimeout(timeout);
			resolve();
		});
	});
}

// Resolves once the reading renderer has produced the note's content, or
// after a bounded wait for views that never catch up. Reading view renders
// asynchronously: the saved scroll can only be applied — and the
// link-highlight span can only appear — once that render lands. Polling
// render state instead of sleeping a fixed delay keeps the covered blank
// time equal to the real render time, with no arbitrary minimum on top.
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
	// completes it is empty or not yet laid out. The reading renderer also
	// reports no scroll (currentMode.getScroll() === null) until it has
	// caught up with the new note — a reused leaf can briefly show the
	// previous note's layout, so require the renderer to be usable before
	// restoring into it.
	const sizer = view.containerEl.querySelector<HTMLElement>('.markdown-preview-sizer');
	return !!sizer && sizer.children.length > 0 && sizer.scrollHeight > 0
		&& view.currentMode?.getScroll() != null;
}

// Whether the state requested in setEphemeralState() is what the view now
// reports. Scroll is compared exactly: applyScroll lands within ~0.04 line
// of the request and Math.round's ±0.5 dead zone absorbs that. A missing
// readback cursor means a collapsed (0,0) cursor — the editor's default —
// so it matches a saved (0,0) cursor.
function isRestoreStuck(view: MarkdownView, st: EphemeralState): boolean {
	const now = readEphemeralState(view);
	if (!now)
		return false;
	if ((st.scroll ?? 0) > 0 && (
		now.scroll !== st.scroll
		// Reading view reports the requested scroll before it has actually
		// scrolled (the renderer is still catching up with the new note), so a
		// matching readback alone would confirm an un-landed top. Require the
		// real scroller to have moved when a scroll was requested — this is what
		// distinguishes "rendered and scrolled to the line" from "renderer says
		// it will get there eventually".
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
// frames (or after a bounded wait for views whose async rendering never
// catches up). Reading view applies a scroll only once its renderer has
// produced the target lines, and Obsidian's staged open pipeline can reset
// the scroll after it first lands — so keep re-applying on drift while
// covered, and only uncover once nothing is fighting us anymore.
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

// The element that actually scrolls the view in its CURRENT mode: the
// editor's .cm-scroller in source, the .markdown-preview-view container in
// reading, or the .bases-view root container for base views — the only
// non-markdown FileView ever recorded/restored (pdf/image/canvas are never
// recorded). Markdown and base containers verified in devtools (each carries
// overflow-y: auto and holds the saved scroll); querySelector returns the
// outermost match in document order, so embedded notes (.markdown-embed)
// inside a preview never shadow the real container. Unlike the old ancestor
// walk this also returns the container for short notes that don't scroll;
// callers treat that case identically (scrollTop stays 0). Reading-only
// callers (hasPreviewScrolled, cue's previewTopBlock) are guarded by
// getMode() === 'preview' at their call sites.
export function getScroller(view: FileView): HTMLElement | null {
	if (view instanceof MarkdownView)
		return view.getMode() === 'source'
			? view.contentEl.querySelector<HTMLElement>('.cm-scroller')
			: view.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
	return view.containerEl.querySelector<HTMLElement>('.bases-view');
}

// Whether a reading (preview) view's real scroller has actually moved
// (found and scrollTop > 0). Callers guard with getMode() === 'preview'
// before using it. A reading renderer can report the requested scroll in
// getScroll() before any pixel moves, so this distinguishes "rendered and
// scrolled to the line" from "renderer says it will get there eventually".
export function hasPreviewScrolled(view: MarkdownView): boolean {
	const scroller = getScroller(view);
	return !!scroller && scroller.scrollTop > 0;
}

// Animates a scroll container's scrollTop from `from` to `to` over `duration`
// ms with easeInOutSine, so reading-view restores move at a legible,
// user-controlled pixel speed instead of stepping line-by-line through
// Obsidian's render pipeline. Writing scrollTop directly is what native
// scrolling does, so lazy-rendered content paints smoothly as it comes into
// view. Resolves on completion; a timeout races the rAF loop so a hidden
// window can't stall the restore.
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
				requestAnimationFrame(step);
			else
				resolve();
		};
		requestAnimationFrame(step);
		setTimeout(resolve, duration + 100);
	});
}

// Resolves once an injected open's position is confirmed painted, then the
// caller lifts the cover. Core applied the state in setViewState, so we
// only observe — never re-apply, which would fight core's own open
// pipeline. A new source editor measures its document before its scroll can
// land, so wait until the readback reports the position (short bound
// covers the measure frame; a failure to land just reveals at the default
// position instead of blanking the note). An 'end' default-position open
// (no record) has nothing to wait on beyond a paint: scroll-to-end is one
// synchronous editor op, and a note too short to scroll is already fully
// visible.
export async function waitForInjectedRestorePainted(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
	if (!st) {
		await nextPaint();
		await nextPaint();
		return;
	}
	const deadline = Date.now() + 200;
	let stableFrames = 0;
	while (Date.now() < deadline && isCurrent()) {
		await nextPaint();
		if (!isCurrent())
			return;
		if (isRestoreStuck(view, st)) {
			if (++stableFrames >= 2)
				return;
		} else {
			stableFrames = 0;
		}
	}
}
