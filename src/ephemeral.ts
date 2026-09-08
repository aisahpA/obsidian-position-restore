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
	const topLine = Math.round(scroll);
	const state: EphemeralState = { scroll: topLine };

	const editor = view.editor;
	if (editor) {
		// Anchor: the primary line's trimmed text at capture time. A recorded
		// position goes stale when the file is edited afterwards (inserts and
		// deletes above shift every line below) — remapAnchoredState uses this
		// text to re-find the line before the position is applied. Blank lines
		// carry no anchor (an empty match would match every blank line).
		if (topLine >= 0 && topLine <= (editor.lastLine?.() ?? -1)) {
			const text = editor.getLine(topLine).trim().slice(0, 80);
			if (text)
				state.anchor = text;
		}
		const from = editor.getCursor("anchor");
		const to = editor.getCursor("head");
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

// ponytail: nearest-match heuristic — an edited anchor line or a fully
// rewritten region finds no match and keeps the stale line (native-history
// behavior); heavily duplicated lines resolve to the nearest copy. Upgrade
// path: live CM change deltas on top of the anchors.
const REMAP_WINDOW = 30;

// Re-map a stale recorded position to the file's current lines: the entry
// text anchor (see readEphemeralState) locates the line that used to sit at
// the recorded line number. Nearest-first scan around it; no match applies
// the position as recorded. Returns a shifted copy — callers' entries stay
// immutable (keyed-entry semantics), the original anchor stays with the
// entry for the next apply.
export function remapAnchoredState(
	editor: { getLine(line: number): string; lastLine(): number },
	st: EphemeralState,
): EphemeralState {
	const anchor = st.anchor;
	if (!anchor)
		return st;
	const line = st.scroll ?? st.cursor?.from.line;
	if (line === undefined || line < 0)
		return st;
	const last = editor.lastLine();
	if (line <= last && editor.getLine(line).trim() === anchor)
		return st;
	for (let d = 1; d <= REMAP_WINDOW; d++) {
		for (const at of [line + d, line - d]) {
			if (at < 0 || at > last)
				continue;
			if (editor.getLine(at).trim() === anchor) {
				const delta = at - line;
				const mapped: EphemeralState = { ...st, anchor: undefined };
				if (mapped.scroll !== undefined)
					mapped.scroll = Math.max(0, mapped.scroll + delta);
				if (mapped.cursor)
					mapped.cursor = {
						from: { ...mapped.cursor.from, line: mapped.cursor.from.line + delta },
						to: { ...mapped.cursor.to, line: mapped.cursor.to.line + delta },
					};
				return mapped;
			}
		}
	}
	return st;
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
	const editor = view.editor;
	if (editor) {
		const lastLine = editor.lastLine();
		const lastLineLength = editor.getLine(lastLine).length;
		editor.setCursor({ line: lastLine, ch: lastLineLength });
		editor.scrollIntoView({ from: { line: lastLine, ch: 0 }, to: { line: lastLine, ch: lastLineLength } }, true);
	}
}
