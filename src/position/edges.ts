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

// Already standing at that end. A command pressed twice would otherwise record the same arrival
// twice, and back would need as many presses to return to where the reader was.
export function atEdge(view: MarkdownView, edge: NoteEdge): boolean {
	const el = getScroller(view);
	return !!el && isAtEdge(el, edge);
}

export function moveToEdge(view: MarkdownView, edge: NoteEdge): void {
	if (view.getMode() === 'source')
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

function isAtEdge(el: HTMLElement, edge: NoteEdge): boolean {
	const furthest = Math.max(0, el.scrollHeight - el.clientHeight);
	return edge === 'top' ? el.scrollTop <= 0 : el.scrollTop >= furthest - 1;
}

function applyEdge(el: HTMLElement, edge: NoteEdge): void {
	// scrollHeight, not the last line's offset: it clamps to the furthest the view can go, which
	// is the end of the note however tall the last screenful happens to be.
	el.scrollTop = edge === 'top' ? 0 : el.scrollHeight;
}

// The caret an editor key would leave: at the head of the first line, or at the end of the last.
// Reading mode has no caret to put, and the caret is what makes the difference between "the note
// scrolled" and "the reader's own cursor moved".
function caretToEdge(view: MarkdownView, edge: NoteEdge): void {
	const editor = view.editor;
	if (!editor)
		return;
	const line = edge === 'top' ? 0 : editor.lastLine();
	editor.setCursor({ line, ch: edge === 'top' ? 0 : editor.getLine(line).length });
}
