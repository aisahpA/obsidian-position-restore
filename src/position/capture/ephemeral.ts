import { MarkdownView } from 'obsidian';
import { EphemeralState, NavContextLine, NavEntryState } from '@/types';

// Hot read: the 100ms poll (Sampler), the scroll capture, and the restore verification / reland
// loops run this every tick and every frame. Position only — no doc-string reads, no layout. Nav
// display fields live in readNavEntryState / withNavDisplay, which run only when a nav entry is
// actually saved.
export function readEphemeralState(view: MarkdownView): EphemeralState | undefined {
	const scroll = view.currentMode?.getScroll();
	// getScroll() reports null (not undefined) while the preview renderer has not caught up —
	// isNaN(null) is false, so it would pass the old guard and Math.round(null) would read as "top
	// of file".
	if (scroll == null || !Number.isFinite(scroll))
		return undefined;

	// getScroll() returns a 0-based top visible line number plus a fraction of how far that line is
	// scrolled through (42.37 = the viewport top sits 37% into line 43), quantized to whole lines:
	//
	// 1. Reading continuity: the saved fraction points into the middle of a line the reader had
	//    already half-read, and re-creating that state forces the eye to re-scan a broken line. For
	//    tall blocks (images, embeds) a fractional restore yields half an image.
	// 2. Round-trip stability: applyScroll(n) lands exactly on a line top, so the residual landing
	//    error (~0.04 line) stays inside Math.round's ±0.5 dead zone — save 42, read back 42, never
	//    a db write. Finer quantization shrinks the dead zone below that error, and the drifted
	//    readback then ratchets the saved scroll by one step on every open.
	// 3. Must be Math.round, not Math.floor: floor's dead zone is asymmetric ([n-1, n)), so any
	//    landing slightly below the saved value re-introduces one-way downward drift. Only a
	//    symmetric dead zone absorbs noise in both directions.
	const topLine = Math.round(scroll);
	const state: EphemeralState = { scroll: topLine };

	const editor = view.editor;
	if (editor) {
		const from = editor.getCursor("anchor");
		const to = editor.getCursor("head");
		// A collapsed cursor at (0,0) is where the editor opens anyway — omit it so such records
		// stay minimal ([0] tombstones / scroll-only records).
		if (from && to && (from.line !== 0 || from.ch !== 0 || to.line !== 0 || to.ch !== 0)) {
			state.cursor = {
				from: { ch: from.ch, line: from.line },
				to: { ch: to.ch, line: to.line }
			}
		}
	}

	return state;
}

// Minimal CM6 surface for the cursor-visibility check. Same cast family as CmLike
// (restore/pixels.ts) / Cm6EditorView (ui/cue.ts) — (editor).cm is runtime-only, absent from the
// public typings. A local interface: the pixel corrector imports this module, so its CmLike cannot
// be borrowed without a cycle.
interface CmView {
	state: { doc: { lines: number; line(n: number): { from: number } } };
	viewport: { from: number; to: number };
	scrollDOM: HTMLElement;
	coordsAtPos(pos: number): { top: number } | null;
	defaultLineHeight: number;
}

// Whether the cursor line is actually on screen. Pixel geometry through (editor).cm — never
// currentMode.getScroll(), which ECHOES the requested value while the pixels sit elsewhere
// (pixels.ts:99-102). An unrendered line (outside cm.viewport, CM's render margin included) is off
// screen by definition; a rendered line's coordsAtPos is a real client rect, compared against the
// scroller's box. Every undecidable step (no editor view, line beyond EOF, coords not yet measured)
// returns true — assume visible, keep today's display; never lose the label to a geometry hiccup.
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

// The recorded context block's radius, in NON-BLANK lines either side of the landing (the landing
// line itself is always recorded, blank or not). Non-blank counting is the point — a note written
// one sentence per line with blank separators would spend a raw ±3 on two lines of actual text.
//
// THREE, and it came down from five: this block is the heaviest thing the recent-files list stores
// and it buys exactly one thing — the search box matching a note by the words that stood beside a
// jump (see listing.ts's navSearchText). The line NUMBER travels on its own (contextAt), so a
// narrower window costs no precision, only reach.
export const NAV_CONTEXT_RADIUS = 3;

// Per-line cap of a recorded context line, in characters. Longer than the anchor's 80 on purpose:
// they do different jobs. The anchor (below) is matched EXACTLY to re-find a line after edits,
// where a longer string is a brittler key, while a context line is only searched.
const CONTEXT_LINE_CAP = 120;

// How many RAW lines either side the block looks through to find its radius worth of non-blank ones.
// Without a bound, a landing at the foot of a note with a long blank stretch would walk to line 0 —
// and this read runs on every file switch.
const CONTEXT_SCAN_LIMIT = NAV_CONTEXT_RADIUS * 4;

// One line as the block stores it: trimmed (the panel prints the text, and leading indentation is
// noise in a one-line-per-record box) and capped.
function contextText(raw: string | undefined): string {
	return (raw ?? '').trim().slice(0, CONTEXT_LINE_CAP);
}

// The landing line plus NAV_CONTEXT_RADIUS non-blank lines either side, in document order. The
// landing is included even when it is blank: "started a paragraph, then left" is an ordinary step,
// and that blank line is where the entry points. Blank lines elsewhere are skipped rather than
// stored (an empty string matches every query and displays as a placeholder).
function contextBlock(
	editor: { getLine(line: number): string; lastLine(): number },
	landing: number,
): NavContextLine[] | undefined {
	if (landing < 0 || landing > editor.lastLine())
		return undefined;
	const before: NavContextLine[] = [];
	for (let i = landing - 1; i >= 0 && before.length < NAV_CONTEXT_RADIUS && landing - i <= CONTEXT_SCAN_LIMIT; i--) {
		const text = contextText(editor.getLine(i));
		if (text)
			before.unshift({ line: i, text });
	}
	const after: NavContextLine[] = [];
	for (let i = landing + 1; i <= editor.lastLine() && after.length < NAV_CONTEXT_RADIUS && i - landing <= CONTEXT_SCAN_LIMIT; i++) {
		const text = contextText(editor.getLine(i));
		if (text)
			after.push({ line: i, text });
	}
	return [...before, { line: landing, text: contextText(editor.getLine(landing)) }, ...after];
}

// The nav-display fields around a position: the viewport-top anchor (functional —
// remapAnchoredState re-finds the line after later edits), the landing's recorded context block
// (search), and the file's mtime. Cheap doc reads EXCEPT cursorOnScreen — the only layout-forcing
// part of the nav read, and it never runs on the hot path. A doc read is the whole price of the
// context block: the lines come from the editor's buffer, no vault IO.
function navDisplayFields(
	view: MarkdownView,
	topLine: number,
	cursor: EphemeralState['cursor'],
): Pick<NavEntryState, 'anchor' | 'context' | 'contextAt' | 'mtime'> {
	const display: Pick<NavEntryState, 'anchor' | 'context' | 'contextAt' | 'mtime'> = {};
	// The view mode is read here and nowhere else: it decides which line the landing is (below),
	// and that decision is RECORDED (contextAt) instead of being stamped for a reader to re-derive.
	// Optional-called: the display fields must never crash the recording path on a view-like object
	// that lacks getMode.
	const mode = view.getMode?.();
	const editor = view.editor;
	if (!editor || typeof editor.getLine !== 'function')
		return display;
	// Anchor: the primary line's trimmed text at capture time. A recorded position goes stale when
	// the file is edited afterwards (inserts and deletes above shift every line below) —
	// remapAnchoredState uses this text to re-find the line before the position is applied. Blank
	// lines carry no anchor (an empty match would match every blank line).
	if (topLine >= 0 && topLine <= (editor.lastLine?.() ?? -1)) {
		const text = editor.getLine(topLine).trim().slice(0, 80);
		if (text)
			display.anchor = text;
	}
	// Which line the row's landing IS: the cursor line for a source capture whose cursor is on
	// screen, the viewport top otherwise (a reading capture's cursor is the stale pre-preview one;
	// a source capture's cursor may have been scrolled out of sight).
	const cursorVisible = !!cursor && mode !== 'preview' && cursorOnScreen(view, cursor.from.line);
	const landingLine = cursorVisible && cursor ? cursor.from.line : topLine;
	const block = contextBlock(editor, landingLine);
	if (block) {
		display.context = block;
		display.contextAt = block.findIndex(l => l.line === landingLine);
	}
	// The file's mtime at capture time — the record's own stamp, what the file WAS when the step was
	// taken. It does NOT drive the restore (which works against a live editor buffer, whose unsaved
	// text can differ from the file on disk regardless of its mtime).
	const mtime = view.file && typeof view.file.stat?.mtime === 'number' ? view.file.stat.mtime : undefined;
	if (mtime !== undefined)
		display.mtime = mtime;
	return display;
}

// Nav read — LOW frequency only (the leave-refresh on a file switch, the outline pre-click read, the
// leave-refresh before back/forward, the landing settle-capture, the teleport landing): the hot read
// plus the display fields a nav entry carries. Never a drop-in for readEphemeralState on hot paths:
// the visibility check forces layout per call.
export function readNavEntryState(view: MarkdownView): NavEntryState | undefined {
	const st = readEphemeralState(view);
	if (!st)
		return undefined;
	return { ...st, ...navDisplayFields(view, st.scroll ?? -1, st.cursor) };
}

// Rebuild the nav-display fields around an ALREADY-READ position — the poll baseline handed to
// refreshTop at a teleport. The pre-jump state cannot be re-read (the cursor has already jumped; the
// scroll may already have landed on mobile), so the display fields are reconstructed from the
// current view against the recorded position: at most one poll tick stale, and on desktop CM applies
// the jump's scrollIntoView AFTER the selection event, so the visibility check sees the pre-jump
// viewport. Shallow copy — never mutate the shared baseline (or any entry sharing it) in place.
export function withNavDisplay(view: MarkdownView, st: EphemeralState): NavEntryState {
	return { ...st, ...navDisplayFields(view, st.scroll ?? -1, st.cursor) };
}

// Nearest-match heuristic: an edited anchor line or a fully rewritten region finds no match and
// keeps the stale line (native-history behavior); heavily duplicated lines resolve to the nearest
// copy. Upgrade path: live CM change deltas on top of the anchors.
const REMAP_WINDOW = 30;

// Normalize text for anchor matching: fold case and strip whitespace and punctuation so a
// lightly-edited anchor line still matches its recorded text. CJK needs no case fold but benefits
// from the strip ("我的 标题" vs "我的标题"). Comparison stays an exact match on the normalized
// forms — never a substring — so heavily-duplicated lines still resolve nearest, and an unrelated
// edit never falsely matches.
export function normAnchor(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

// Anywhere lines can be read out of by number: an editor's buffer, or a file's lines read off disk.
// The whole shape the scan below needs and nothing more — which is what lets ONE scan serve a note
// that is open (its buffer, ahead of the file on disk by however much the reader has typed and not
// saved) and one that is not.
export interface LineSource {
	getLine(line: number): string;
	lastLine(): number;
}

// A file's lines as that shape: what the scan is handed for a note that is not open. Split once,
// kept by whoever asked for it.
export function linesSource(lines: string[]): LineSource {
	return {
		getLine: (line: number) => lines[line] ?? '',
		lastLine: () => lines.length - 1,
	};
}

// WHERE THE ANCHOR'S LINE IS NOW: the one scan, over any line source. A record names a line NUMBER
// and the text that stood on it; the file has moved since — inserts and deletes above shift every
// line below — so the number is a stale address and the text is the only thing left that knows the
// place. Nearest-first outwards from the recorded line, because an edit shifts lines by a few, not
// by a relocation; an exact hit outranks a nearer normalized one, because an unedited copy of the
// recorded line is more credible than an edited lookalike.
//
// UNDEFINED MEANS UNKNOWN, NOT UNCHANGED, and that is the whole reason this scan answers in a line
// rather than in a shift: a note rewritten past recognition has no answer to give, and a caller that
// read undefined as "it is where it was" would go on quoting a number it knows nothing about. Two
// passes, plain text first: the common unedited case costs nothing but string compares, and only a
// miss pays for normalization.
export function remapAnchorLine(
	anchor: string | undefined,
	recorded: number | undefined,
	src: LineSource,
): number | undefined {
	if (!anchor || recorded === undefined || recorded < 0)
		return undefined;
	const last = src.lastLine();
	const key = normAnchor(anchor);
	for (const hit of [
		(text: string) => text.trim() === anchor,
		(text: string) => normAnchor(text) === key,
	]) {
		if (recorded <= last && hit(src.getLine(recorded)))
			return recorded;
		for (let d = 1; d <= REMAP_WINDOW; d++) {
			for (const at of [recorded + d, recorded - d]) {
				if (at < 0 || at > last)
					continue;
				if (hit(src.getLine(at)))
					return at;
			}
		}
	}
	return undefined;
}

// Re-map a stale recorded position to the file's current lines: the entry text anchor (see
// readNavEntryState) locates the line that used to sit at the recorded line number. Returns a
// shifted copy — callers' entries stay immutable (keyed-entry semantics), the original anchor stays
// with the entry for the next apply. No anchor, no scan, no change: the position is applied exactly
// as it was recorded.
export function remapAnchoredState(editor: LineSource, st: NavEntryState): NavEntryState {
	const base = st.scroll ?? st.cursor?.from.line;
	if (base === undefined || base < 0)
		return st;
	const at = remapAnchorLine(st.anchor, base, editor);
	return at === undefined || at === base ? st : shiftNavState(st, at - base);
}

// Shift a recorded position by `delta` lines — the structural anchor's drift: its CURRENT line minus
// its RECORD-TIME line, both resolved by the caller through metadataCache. Same mechanics as the
// remap above (immutable copy, scroll clamps at 0, cursor lines clamp too), but driven by an
// authoritative structural line instead of a ±REMAP_WINDOW text scan, so a shift beyond any window
// still lands. The text anchor is dropped: it belongs to the record-time line, and the caller has
// already re-located the position structurally.
//
// Shared on purpose by the two consumers that must agree on the shift: an in-file history jump
// (RestoreModes.historyJumpApply) and the landing a cross-file traversal hands to the open pipeline
// (NavStack.landingFor, which cannot run the text remap — the target editor does not exist yet).
export function shiftNavState(st: NavEntryState, delta: number): NavEntryState {
	if (delta === 0)
		return st;
	const mapped: NavEntryState = { ...st, anchor: undefined };
	if (mapped.scroll !== undefined)
		mapped.scroll = Math.max(0, mapped.scroll + delta);
	if (mapped.cursor) {
		mapped.cursor = {
			from: { ...mapped.cursor.from, line: Math.max(0, mapped.cursor.from.line + delta) },
			to: { ...mapped.cursor.to, line: Math.max(0, mapped.cursor.to.line + delta) },
		};
	}
	return mapped;
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
