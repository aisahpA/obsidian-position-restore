import { MarkdownView } from 'obsidian';
import { getScroller } from '@/shared/wait';

// THE TWO ENDS OF A NOTE. The app has no command for either: Ctrl+Home / Ctrl+End are editor keys,
// and only on the desktop — on a phone there is no way to ask for an end at all.
//
// Where an end is DISPLAYED is not a choice, which is the one thing worth saying about it: the
// first and the last line sit at the two ends of the scrollable range, so centring them or leaving
// context above them lands in exactly the same place — the scroller clamps. What IS ours to decide
// is the caret (an editor key moves it, a scroll does not) and the step (see manager.goToEdge).
export type NoteEdge = 'top' | 'bottom';

// Already standing at that end. A command pressed twice would otherwise record the same arrival
// twice, and back would need as many presses to return to where the reader was.
export function atEdge(view: MarkdownView, edge: NoteEdge): boolean {
	const el = getScroller(view);
	if (!el)
		return false;
	const furthest = Math.max(0, el.scrollHeight - el.clientHeight);
	return edge === 'top' ? el.scrollTop <= 0 : el.scrollTop >= furthest - 1;
}

export function moveToEdge(view: MarkdownView, edge: NoteEdge): void {
	if (view.getMode() === 'source')
		caretToEdge(view, edge);
	const el = getScroller(view);
	// scrollHeight, not the last line's offset: it clamps to the furthest the view can go, which
	// is the end of the note however tall the last screenful happens to be.
	if (el)
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
