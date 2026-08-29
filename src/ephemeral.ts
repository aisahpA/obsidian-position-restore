import { MarkdownView } from 'obsidian';
import { EphemeralState } from './types';

export function readEphemeralState(view: MarkdownView): EphemeralState | undefined {
	const scroll = view.currentMode?.getScroll();
	if (scroll === undefined || isNaN(scroll))
		return undefined;

	// getScroll() returns a 0-based top visible line number plus a fraction of
	// how far that line is scrolled through (e.g. 42.37 = viewport top sits 37%
	// into line 43). We deliberately quantize to whole lines:
	//
	// 1. Reading continuity. Restoring to a line *top* is the position that
	//    lets reading resume: the saved fraction points into the middle of a
	//    line the user had already partially read, and re-creating that
	//    half-read state forces the eye to re-scan a broken line before
	//    thought continues. Quantizing costs at most half a line of re-read
	//    and never loses content. For tall blocks (images, embeds) a
	//    fractional restore yields "half an image on screen" — not a useful
	//    reading position; landing on the block top (or past it) is.
	// 2. Round-trip stability. applyScroll(n) lands exactly on a line top;
	//    the residual landing error (pixel rounding) is ~0.04 line, well
	//    inside Math.round's ±0.5 dead zone. So: save 42 -> land 42.0x ->
	//    read back 42 -> no db write, ever. Finer quantization (e.g. 2
	//    decimals) shrinks the dead zone below the landing error, and the
	//    exact-=== change check then writes the drifted readback to the db,
	//    ratcheting the saved scroll by one step on every open.
	// 3. Must be Math.round, not Math.floor. floor's dead zone is
	//    asymmetric: [n-1, n) instead of [n-0.5, n+0.5). It tolerates ~1 line
	//    of upward deviation but *zero* downward deviation, so any landing or
	//    layout shift slightly below the saved value re-introduces one-way
	//    downward drift. Only a symmetric dead zone absorbs noise in both
	//    directions. (Obsidian's own outline sync also uses Math.round here.)
	let state: EphemeralState = { scroll: Math.round(scroll) };

	let editor = view.editor;
	if (editor) {
		let from = editor.getCursor("anchor");
		let to = editor.getCursor("head");
		// A collapsed cursor at (0,0) is where the editor opens anyway — omit it
		// so such records stay minimal ([0] tombstones / scroll-only records).
		if (from && to && (from.line !== 0 || from.ch !== 0 || to.line !== 0 || to.ch !== 0)) {
			state.cursor = {
				from: { ch: from.ch, line: from.line },
				to: { ch: to.ch, line: to.line }
			}
		}
	}

	return state;
}

export function applyEphemeralState(view: MarkdownView, state: EphemeralState) {
	const stateToApply: Record<string, unknown> = {};
	if (state.cursor)
		stateToApply.cursor = state.cursor;
	if (state.scroll && state.scroll > 0)
		stateToApply.scroll = state.scroll;
	
	if (Object.keys(stateToApply).length > 0)
		view.setEphemeralState(stateToApply);
}

// Cursor-only equality for callers that track cursor movement independently
// of scroll (e.g. the 100ms poll, whose baseline may carry a scroll field
// that must not participate in the comparison).
export function isCursorStatesEqual(
	state1?: EphemeralState['cursor'],
	state2?: EphemeralState['cursor']
): boolean {
	if (!!state1 !== !!state2) return false;
	if (!state1 || !state2) return true;
	return state1.from.ch === state2.from.ch && state1.from.line === state2.from.line &&
		state1.to.ch === state2.to.ch && state1.to.line === state2.to.line;
}

export function isEphemeralStatesEquals(state1: EphemeralState, state2: EphemeralState): boolean {
	const c1 = state1.cursor, c2 = state2.cursor;
	if (!isCursorStatesEqual(c1, c2)) return false;

	return state1.scroll === state2.scroll;
}

export function setCursorToEnd(view: MarkdownView) {
	let editor = view.editor;
	if (editor) {
		let lastLine = editor.lastLine();
		let lastLineLength = editor.getLine(lastLine).length;
		editor.setCursor({ line: lastLine, ch: lastLineLength });
		editor.scrollIntoView({ from: { line: lastLine, ch: 0 }, to: { line: lastLine, ch: lastLineLength } }, true);
	}
}
