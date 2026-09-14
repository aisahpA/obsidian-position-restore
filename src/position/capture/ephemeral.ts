import { MarkdownView } from 'obsidian';
import { EphemeralState, NavEntryState } from '@/types';

// Hot read: the 100ms poll (Sampler), the scroll capture, and the restore
// verification / reland loops run this every tick and every frame. Position
// only — no doc-string reads, no layout. Nav display fields live in
// readNavEntryState / withNavDisplay, which run only when a nav entry
// is actually saved.
export function readEphemeralState(view: MarkdownView): EphemeralState | undefined {
	const scroll = view.currentMode?.getScroll();
	// getScroll() reports null (not undefined) while the preview renderer has
	// not caught up (see isContentReady) — isNaN(null) is false, so it would
	// pass the old guard and Math.round(null) would read as "top of file".
	if (scroll == null || !Number.isFinite(scroll))
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

// Minimal CM6 surface for the cursor-visibility check. Same cast family as
// CmLike (restore/pixels.ts) / Cm6EditorView (ui/cue.ts) — (editor).cm is
// runtime-only, absent from the public typings. A local interface: the pixel
// corrector imports this module, so its CmLike cannot be borrowed without a
// cycle.
interface CmView {
	state: { doc: { lines: number; line(n: number): { from: number } } };
	viewport: { from: number; to: number };
	scrollDOM: HTMLElement;
	coordsAtPos(pos: number): { top: number } | null;
	defaultLineHeight: number;
}

// Whether the cursor line is actually on screen. Pixel geometry through
// (editor).cm — never currentMode.getScroll(), which ECHOES the requested
// value while the pixels sit elsewhere (pixels.ts:99-102). An unrendered
// line (outside cm.viewport, CM's render margin included) is off screen by
// definition; a rendered line's coordsAtPos is a real client rect, compared
// against the scroller's box. Every undecidable step (no editor view, line
// beyond EOF, coords not yet measured) returns true — assume visible, keep
// today's display; never lose the label to a geometry hiccup.
function cursorOnScreen(view: MarkdownView, line: number): boolean {
	const cm = (view.editor as unknown as { cm?: CmView }).cm;
	if (!cm?.scrollDOM)
		return true;
	if (line + 1 > cm.state.doc.lines)
		return true;
	const from = cm.state.doc.line(line + 1).from;
	if (from < cm.viewport.from || from >= cm.viewport.to)
		return false;
	const coords = cm.coordsAtPos(from);
	if (!coords)
		return true;
	const rect = cm.scrollDOM.getBoundingClientRect();
	const lineHeight = cm.defaultLineHeight || 20;
	return coords.top >= rect.top - lineHeight && coords.top < rect.bottom;
}

// The nav-display fields around a position: the viewport-top anchor
// (functional — remapAnchoredState re-finds the line after later edits), the
// cursor line's own text and the mode stamp (history-browser display), and
// the offscreen flag. Cheap doc reads EXCEPT cursorOnScreen — this is the
// only layout-forcing part of the nav read, and it never runs on the hot
// path.
function navDisplayFields(
	view: MarkdownView,
	topLine: number,
	cursor: EphemeralState['cursor'],
): Pick<NavEntryState, 'anchor' | 'cursorAnchor' | 'mode' | 'cursorOffscreen'> {
	const display: Pick<NavEntryState, 'anchor' | 'cursorAnchor' | 'mode' | 'cursorOffscreen'> = {};
	// getMode is optional-called: the mode stamp is display-only and must
	// never be able to crash the recording path on a view-like object that
	// lacks it (missing mode reads as the cursor-first heuristic).
	const mode = view.getMode?.();
	if (mode)
		display.mode = mode;
	const editor = view.editor;
	if (!editor || typeof editor.getLine !== 'function')
		return display;
	// Anchor: the primary line's trimmed text at capture time. A recorded
	// position goes stale when the file is edited afterwards (inserts and
	// deletes above shift every line below) — remapAnchoredState uses this
	// text to re-find the line before the position is applied. Blank lines
	// carry no anchor (an empty match would match every blank line).
	if (topLine >= 0 && topLine <= (editor.lastLine?.() ?? -1)) {
		const text = editor.getLine(topLine).trim().slice(0, 80);
		if (text)
			display.anchor = text;
	}
	// cursorAnchor: the cursor line's own text — the line the jump lands on.
	// Reading captures are excluded: their cursor is the stale pre-preview
	// one (the viewport anchor covers them). Off-screen cursor: the history
	// browser must describe the viewport instead of the invisible line.
	if (cursor && mode !== 'preview') {
		const landing = editor.getLine(cursor.from.line)?.trim().slice(0, 80);
		if (landing)
			display.cursorAnchor = landing;
		if (!cursorOnScreen(view, cursor.from.line))
			display.cursorOffscreen = true;
	}
	return display;
}

// Nav read — LOW frequency only (the leave-refresh on a file switch, the
// outline pre-click read, the leave-refresh before back/forward, the
// landing settle-capture, the teleport landing): the hot read plus the
// display fields a NavHistory entry carries. Never a drop-in for
// readEphemeralState on hot paths: the visibility check forces layout per
// call.
export function readNavEntryState(view: MarkdownView): NavEntryState | undefined {
	const st = readEphemeralState(view);
	if (!st)
		return undefined;
	return { ...st, ...navDisplayFields(view, st.scroll ?? -1, st.cursor) };
}

// Rebuild the nav-display fields around an ALREADY-READ position — the poll
// baseline handed to refreshTop at a teleport. The pre-jump state cannot be
// re-read (the cursor has already jumped; the scroll may already have
// landed on mobile), so the display fields are reconstructed from the
// current view against the recorded position: at most one poll tick stale,
// and on desktop CM applies the jump's scrollIntoView AFTER the selection
// event, so the visibility check sees the pre-jump viewport. Shallow copy —
// never mutate the shared baseline (or any entry sharing it) in place.
export function withNavDisplay(view: MarkdownView, st: EphemeralState): NavEntryState {
	return { ...st, ...navDisplayFields(view, st.scroll ?? -1, st.cursor) };
}

// ponytail: nearest-match heuristic — an edited anchor line or a fully
// rewritten region finds no match and keeps the stale line (native-history
// behavior); heavily duplicated lines resolve to the nearest copy. Upgrade
// path: live CM change deltas on top of the anchors.
const REMAP_WINDOW = 30;

// Normalize text for anchor matching: fold case and strip whitespace and
// punctuation so a lightly-edited anchor line still matches its recorded
// text (e.g. "## Some  Heading!" vs "some heading"). CJK needs no case fold
// but benefits from the whitespace/punctuation strip ("我的 标题" vs
// "我的标题"). Comparison stays an exact match on the normalized forms —
// never a substring — so heavily-duplicated lines still resolve nearest,
// and an unrelated edit ("charlie" -> "rewritten") never falsely matches.
export function normAnchor(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

// Re-map a stale recorded position to the file's current lines: the entry
// text anchor (see readNavEntryState) locates the line that used to sit at
// the recorded line number. Nearest-first scan around it; no match applies
// the position as recorded. Returns a shifted copy — callers' entries stay
// immutable (keyed-entry semantics), the original anchor stays with the
// entry for the next apply.
export function remapAnchoredState(
	editor: { getLine(line: number): string; lastLine(): number },
	st: NavEntryState,
): NavEntryState {
	const anchor = st.anchor;
	if (!anchor)
		return st;
	const line = st.scroll ?? st.cursor?.from.line;
	if (line === undefined || line < 0)
		return st;
	const last = editor.lastLine();
	const key = normAnchor(anchor);
	// Two passes: plain text first — the common unedited case, nothing but
	// string compares — and the normalized scan only when plain found
	// nothing. A per-line `exact || norm` predicate would NOT buy this: the
	// unmatching majority (most of the window) pays the regex on every
	// scan. An exact hit outranks a nearer normalized one — an unedited
	// copy of the recorded line is more credible than an edited lookalike.
	for (const hit of [
		(text: string) => text.trim() === anchor,
		(text: string) => normAnchor(text) === key,
	]) {
		if (line <= last && hit(editor.getLine(line)))
			return st;
		for (let d = 1; d <= REMAP_WINDOW; d++) {
			for (const at of [line + d, line - d]) {
				if (at < 0 || at > last)
					continue;
				if (hit(editor.getLine(at))) {
					const delta = at - line;
					const mapped: NavEntryState = { ...st, anchor: undefined };
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

export function setCursorToEnd(view: MarkdownView) {
	const editor = view.editor;
	if (editor) {
		const lastLine = editor.lastLine();
		const lastLineLength = editor.getLine(lastLine).length;
		editor.setCursor({ line: lastLine, ch: lastLineLength });
		editor.scrollIntoView({ from: { line: lastLine, ch: 0 }, to: { line: lastLine, ch: lastLineLength } }, true);
	}
}
