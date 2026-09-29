import { MarkdownView } from 'obsidian';
import { getScroller, nextPaint } from '@/shared/wait';

// THE TWO ENDS OF A NOTE. The app has no command for either: Ctrl+Home / Ctrl+End are editor keys,
// and only on the desktop — on a phone there is no way to ask for an end at all.
//
// Where an end is DISPLAYED is not a choice, which is the one thing worth saying about it: the
// first and the last line sit at the two ends of the scrollable range, so centring them or leaving
// context above them lands in exactly the same place — the scroller clamps. What IS ours to decide
// is the caret (an editor key moves it, a scroll does not) and the step (see manager.goToEdge).
export type NoteEdge = 'top' | 'bottom';

// The reading renderer re-applies a scroll it captured BEFORE a move, one render pass later: the
// pass the reader's own scrolling queued finishes after the command has already run, and the value
// it holds is where the reader was — hence the flash at the top and the slide back. The plugin's
// own restore pipeline meets that and answers it the same way (see pixels.ts): check the position
// HELD and put it back if it did not. Smaller dose here, because a command has no cover to hide
// the fight behind: two corrections, and out.
const HOLD_MAX_MS = 400;
const HOLD_CORRECTIONS = 2;

// Input that means the reader is moving on their own, at which point the hold is fighting THEM.
const YIELD_EVENTS = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;

// How many frames to wait for the reading renderer to be able to say where it is (see below).
const SYNC_TRIES = 3;

// The app's backlinks pane is appended INSIDE the same scroller — reading: the renderer's footer
// section; source: the sizer — so the furthest a view can scroll is the end of that pane, and a
// pane taller than a window leaves the note's last line above the viewport entirely. It is a pane
// of the TAB, not of the note, so it is not part of either end.
const BACKLINKS_SELECTOR = '.embedded-backlinks';

// Sub-pixel offsets and zoom mean a landing is rarely exactly the number asked for.
const EDGE_EPSILON = 1;

// Already standing at that end — the SCROLL half of the answer only. A command pressed twice would
// otherwise record the same arrival twice, and back would need as many presses to return to where
// the reader was.
export function atEdge(view: MarkdownView, edge: NoteEdge): boolean {
	const el = getScroller(view);
	return !!el && isAtEdge(el, edge);
}

// The CARET half: whether `caretToEdge` would change anything. A view can show the top of a note
// with the caret 200 lines down, and a reader asking for the top wants it moved — so "nothing to
// do" is the scroll and the caret agreeing, not the scroll alone (see manager.goToEdge).
export function caretAtEdge(view: MarkdownView, edge: NoteEdge): boolean {
	const editor = view.editor;
	if (!editor)
		return true;
	const at = editor.getCursor();
	if (edge === 'top')
		return at.line === 0 && at.ch === 0;
	const last = editor.lastLine();
	return at.line === last && at.ch >= (editor.getLine(last) ?? '').length;
}

export function moveToEdge(view: MarkdownView, edge: NoteEdge): void {
	caretToEdge(view, edge);
	const el = getScroller(view);
	if (el)
		applyEdge(el, edge);
}

// Keep the end for a beat after the move. The correction is the same write as the move, so a reader
// who never gets clobbered never sees one; a leaf closed mid-hold or a scroller detached from the
// document ends it.
export async function holdEdge(view: MarkdownView, edge: NoteEdge): Promise<void> {
	const el = getScroller(view);
	if (!el)
		return;
	let yielded = false;
	const onInput = () => {
		yielded = true;
	};
	for (const type of YIELD_EVENTS)
		el.addEventListener(type, onInput, { capture: true, once: true });
	try {
		const deadline = Date.now() + HOLD_MAX_MS;
		let corrections = 0;
		while (!yielded && el.isConnected && Date.now() < deadline) {
			await nextPaint();
			if (yielded || !el.isConnected || isAtEdge(el, edge))
				continue;
			if (++corrections > HOLD_CORRECTIONS)
				return;
			applyEdge(el, edge);
		}
	} finally {
		for (const type of YIELD_EVENTS)
			el.removeEventListener(type, onInput, { capture: true });
	}
}

// A MODE SWITCH does not resume from the DOM: setMode() carries `view.scroll`, which only
// view.syncScroll() fills in — and a reading view calls that from its own scroll handler only when
// the last render is at least 100ms old, which scrolling a virtualized preview never is. So a move
// made here is invisible to the switch, and editing again puts the note back where the reader stood
// BEFORE the command. The same field is what a reading view re-applies on resize.
export async function syncViewScroll(view: MarkdownView): Promise<void> {
	for (let tries = 0; tries < SYNC_TRIES; tries++) {
		const at = view.currentMode?.getScroll();
		// null while the reading renderer has not caught up: wait a frame rather than hand the
		// switch a number that is not where the note is.
		if (at != null && Number.isFinite(at)) {
			// The door setMode() itself uses: it sets the field AND moves the current mode, which
			// for us is a re-application of the position already held.
			view.setEphemeralState({ scroll: at });
			return;
		}
		await nextPaint();
	}
}

// Where the bottom of the note is: the last line at the bottom of the window, the backlinks pane
// below it. Asking for more than the range has is clamped, which is what puts the last screenful
// at the bottom however tall it happens to be.
function bottomTarget(el: HTMLElement): number {
	const furthest = Math.max(0, el.scrollHeight - el.clientHeight);
	const aside = el.querySelector<HTMLElement>(BACKLINKS_SELECTOR);
	if (!aside)
		return furthest;
	const box = aside.getBoundingClientRect();
	// No box of its own: the pane is created hidden and emptied while the setting is off, and its
	// rect collapses — a collapsed one would otherwise read as "the note ends at the top".
	if (box.width <= 0 || box.height <= 0)
		return furthest;
	const top = box.top - el.getBoundingClientRect().top + el.scrollTop;
	if (top <= 0)
		return furthest;
	return Math.max(0, Math.min(furthest, Math.round(top - el.clientHeight)));
}

function edgeTarget(el: HTMLElement, edge: NoteEdge): number {
	return edge === 'top' ? 0 : bottomTarget(el);
}

function isAtEdge(el: HTMLElement, edge: NoteEdge): boolean {
	// The landing itself, not "at or past it": a reader who scrolled on into the backlinks pane
	// is past the note's end, and asking for it again has to bring them back to it.
	return Math.abs(el.scrollTop - edgeTarget(el, edge)) <= EDGE_EPSILON;
}

function applyEdge(el: HTMLElement, edge: NoteEdge): void {
	el.scrollTop = edgeTarget(el, edge);
}

// The caret an editor key would leave: at the head of the first line, or at the end of the last.
// BOTH modes get one: a reading view shows no caret, but `view.editor` is its edit mode, built
// with the leaf and kept behind the preview — and switching modes carries the scroll and the folds
// across, never the selection. Placing it here is what puts the caret on the first line for a
// reader who arrived in reading mode and switched afterwards. It is also what makes asking for an
// end different from asking for a scroll.
export function caretToEdge(view: MarkdownView, edge: NoteEdge): void {
	const editor = view.editor;
	if (!editor)
		return;
	const line = edge === 'top' ? 0 : editor.lastLine();
	editor.setCursor({ line, ch: edge === 'top' ? 0 : editor.getLine(line).length });
}
