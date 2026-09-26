// Tests for the two-tier read split (ephemeral.ts): the hot read
// (readEphemeralState) carries position only — the 100ms poll and the
// restore verification/reland loops run it every tick and frame, so it must
// never pay doc-string reads or layout — while the nav reads
// (readNavEntryState / withNavDisplay) assemble the fields a STEP carries:
// the viewport anchor and the file's mtime.
//
// The landing's WORDS are the third tier (landingContext), read by ONE read
// (readLandingState) — the one that records a landing. No other read pays for
// them: not the doc reads, and not the layout the cursor-visibility check
// forces.

import { describe, it, expect } from 'vitest';

import { MarkdownView } from 'obsidian';
import {
	landingContext, readEphemeralState, readLandingState, readNavEntryState, withNavDisplay,
} from '@/position/capture/ephemeral';
import { EphemeralState, NavEntryState } from '@/types';

// A cm stub: 1-based line(n) sits at offset (n-1)*10; `to` bounds the
// rendered offset range. coordsAtPos maps an offset to a client top (x2);
// the scroller box is [100, 700), so a rendered line top inside 100..700
// reads as on-screen, anything else off-screen.
function makeCm(opts: { viewport: { from: number; to: number }; coordsTop?: number }) {
	return {
		state: { doc: { lines: 1000, line: (n: number) => ({ from: (n - 1) * 10 }) } },
		viewport: opts.viewport,
		scrollDOM: {
			getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 0, right: 800 }),
		},
		coordsAtPos: () => (opts.coordsTop === undefined ? null : { top: opts.coordsTop }),
		defaultLineHeight: 20,
	};
}

// A fake markdown view: real prototype chain (instanceof) plus exactly the
// surface the reads touch. getMode is only attached when requested (a bare
// view-like object must survive — the mode stamp is optional-called).
// getScroll passes through verbatim: an explicit null exercises the
// "renderer not caught up" guard.
function makeView(opts: {
	scroll?: number | null;
	cursorLine?: number;
	mode?: 'source' | 'preview';
	lines?: string[];
	cm?: ReturnType<typeof makeCm>;
	// the file's mtime, for the recorded "written since" stamp
	mtime?: number;
}): MarkdownView {
	const lines = opts.lines ?? [];
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		currentMode: { getScroll: () => opts.scroll },
		getMode: opts.mode ? () => opts.mode : undefined,
		file: opts.mtime === undefined ? undefined : { path: 'a.md', stat: { mtime: opts.mtime } },
		editor: {
			getCursor: () => ({ line: opts.cursorLine ?? 0, ch: 0 }),
			getLine: (n: number) => lines[n] ?? '',
			lastLine: () => lines.length - 1,
			cm: opts.cm,
		},
	}) as MarkdownView;
	return view;
}

const cursor = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });

// The words one landing was given, as a state a reader would see them in.
function words(view: MarkdownView, st: EphemeralState = { scroll: 1, cursor: cursor(0) }): NavEntryState {
	return { ...st, ...(landingContext(view, st) ?? {}) };
}

// The line the landing was decided to be: the one `contextAt` marks.
const landingLine = (st: NavEntryState | undefined): number | undefined =>
	st?.context?.[st.contextAt ?? -1]?.line;

describe('readEphemeralState — the hot read is position only', () => {
	it('carries none of the nav-display fields, even when the view could provide them', () => {
		const view = makeView({ scroll: 42.3, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'] });
		expect(readEphemeralState(view)).toEqual({
			scroll: 42,
			cursor: cursor(3),
		});
	});
});

// A STEP carries the anchor it can be re-found by and the mtime its words were
// taken at — and no words. The stack persists every step, so a block written
// onto one is stored for a reader who never sees it.
describe('readNavEntryState — what a step carries', () => {
	it('adds the viewport anchor and the mtime, and no landing words', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', 'viewport line', 'x', 'cursor line'],
			cm, mtime: 1_730_000_000_000,
		});

		const st = readNavEntryState(view);

		expect(st).toEqual({
			scroll: 1,
			cursor: cursor(3),
			// The anchor belongs to the viewport top — the line a stale record is
			// re-mapped from, and the only functional field here.
			anchor: 'viewport line',
			mtime: 1_730_000_000_000,
		});
		expect(st).not.toHaveProperty('context');
		expect(st).not.toHaveProperty('contextAt');
	});

	it('undefined when the hot read is undefined (renderer not caught up)', () => {
		const view = makeView({ scroll: null as unknown as number, cursorLine: 3 });
		expect(readNavEntryState(view)).toBeUndefined();
	});
});

// WHICH line a capture landed on used to be re-derived by the recent-files browser
// from a stamped view mode plus a cursor-offscreen flag. It is decided here
// now, once, where the geometry is still observable, and recorded as
// `contextAt` — so these tests pin the decision itself.
describe('landingContext — which line the landing is', () => {
	it('lands on the cursor line when it is on screen (source mode)', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });

		expect(landingLine(words(view, { scroll: 1, cursor: cursor(3) }))).toBe(3);
	});

	it('lands on the VIEWPORT top when the cursor line was not rendered at all', () => {
		// Line 4 (1-based) sits at offset 30; the rendered range ends at 25.
		const cm = makeCm({ viewport: { from: 0, to: 25 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });

		expect(landingLine(words(view, { scroll: 1, cursor: cursor(3) }))).toBe(1);
	});

	it('lands on the VIEWPORT top when the cursor pixels sit outside the scroller box', () => {
		// Line 4 at offset 30 renders inside the viewport; coordsAtPos reads
		// top 60 (pos*2) — the scroller box starts at 100, so the line sits
		// above the box: scrolled off, off screen.
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 60 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });

		expect(landingLine(words(view, { scroll: 1, cursor: cursor(3) }))).toBe(1);
	});

	it('assumes the cursor is visible when the editor view is unreachable', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'] });

		expect(landingLine(words(view, { scroll: 1, cursor: cursor(3) }))).toBe(3);
	});

	it('assumes the cursor is visible when the coords are not yet measured', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });

		expect(landingLine(words(view, { scroll: 1, cursor: cursor(3) }))).toBe(3);
	});

	it('lands on the VIEWPORT top for a reading capture (stale pre-preview cursor)', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'preview', lines: ['a', 'b', 'c', 'd'] });

		expect(landingLine(words(view, { scroll: 1, cursor: cursor(3) }))).toBe(1);
	});

	it('records a BLANK landing line as empty text rather than skipping it', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', ''], cm });

		const st = words(view, { scroll: 1, cursor: cursor(3) });

		expect(landingLine(st)).toBe(3);
		expect(st.context?.[st.contextAt ?? -1]?.text).toBe('');
	});

	it('undefined when the recorded position names no line at all', () => {
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: ['a', 'b'] });

		expect(landingContext(view, {})).toBeUndefined();
	});
});

describe('landingContext — the recorded block', () => {
	it('counts NON-BLANK lines each side, and clamps at the document edges', () => {
		// One sentence per line with blank separators (the ordinary shape of a
		// Chinese markdown note): a raw ±3 would spend the window on blanks.
		const lines = [
			'# 标题', '', '第一段', '', '第二段', '落点',
			'', '第三段', '', '第四段', '', '第五段', '', '第六段', '', '第七段',
		];
		const view = makeView({ scroll: 5, cursorLine: 5, mode: 'source', lines });

		const st = words(view, { scroll: 5, cursor: cursor(5) });

		// three non-blank lines before (the document starts), three after, and
		// the landing itself in the middle.
		expect(st.context?.map(l => l.line)).toEqual([0, 2, 4, 5, 7, 9, 11]);
		expect(st.contextAt).toBe(3);
		expect(st.context?.[3]).toEqual({ line: 5, text: '落点' });
	});

	it('keeps a BLANK landing line (started a paragraph, then left)', () => {
		// The case the block exists for: a blank landing used to record no text
		// at all, leaving the step searchable by its file name only.
		const view = makeView({ scroll: 2, cursorLine: 2, mode: 'source', lines: ['a', 'b', '', 'c', 'd'] });

		expect(words(view, { scroll: 2, cursor: cursor(2) }).context).toEqual([
			{ line: 0, text: 'a' },
			{ line: 1, text: 'b' },
			{ line: 2, text: '' },
			{ line: 3, text: 'c' },
			{ line: 4, text: 'd' },
		]);
	});

	it('lands a reading capture on the viewport top, never the stale cursor', () => {
		// A reading capture's cursor is the pre-preview one: the block must
		// describe the line the row shows (the viewport top) or the panel
		// would print a spot the user never looked at.
		const lines = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'];
		const view = makeView({ scroll: 2, cursorLine: 5, mode: 'preview', lines });

		const st = words(view, { scroll: 2, cursor: cursor(5) });

		expect(st.context?.[st.contextAt ?? -1]).toEqual({ line: 2, text: 'r2' });
	});

	it('caps one recorded line so a paragraph-per-line note cannot bloat the list', () => {
		const long = 'x'.repeat(500);
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: [long] });

		expect(words(view, { scroll: 0, cursor: cursor(0) }).context?.[0].text).toHaveLength(120);
	});

	it('trims a line, so the recorded text is what the panel prints', () => {
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: ['\t  缩进的段落  '] });

		expect(words(view, { scroll: 0, cursor: cursor(0) }).context?.[0].text).toBe('缩进的段落');
	});

	it('bounds how far it looks for non-blank lines (the read stays cheap)', () => {
		// Past the bound it simply records fewer lines rather than walking a
		// long blank stretch back to line 0.
		const lines = [...Array.from({ length: 400 }, () => ''), '落点'];
		const view = makeView({ scroll: 400, cursorLine: 400, mode: 'source', lines });

		expect(words(view, { scroll: 400, cursor: cursor(400) }).context).toEqual([{ line: 400, text: '落点' }]);
	});

	it('takes NOTHING from above a heading landing — those words are the section before', () => {
		// A heading's line is where its section STARTS: the words above it belong
		// to the previous section, and recording them is what made a search for
		// the previous section's words pull this landing up.
		const lines = ['上一节的正文', '', '## Beta', '本节第一段', '本节第二段', '本节第三段'];
		const view = makeView({ scroll: 2, cursorLine: 2, mode: 'source', lines });

		const st = words(view, { scroll: 2, cursor: cursor(2) });

		expect(st.context?.map(l => l.line)).toEqual([2, 3, 4, 5]);
		expect(st.contextAt).toBe(0);
	});

	it('spends a heading landing’s whole window below it', () => {
		// The budget is unchanged: what is not taken from above goes to the
		// section the reader actually jumped into.
		const lines = ['# H', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines });

		expect(words(view, { scroll: 0, cursor: cursor(0) }).context?.map(l => l.line))
			.toEqual([0, 1, 2, 3, 4, 5, 6]);
	});
});

// The landing is recorded the moment it settles, and the words it is searched and quoted by are
// read in that SAME read: the state arrives whole at both lists, and the stack leaves them behind
// when it writes a step.
describe('readLandingState — the read that records a landing', () => {
	it('is what a step carries plus the words the landing sits in', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', 'viewport line', 'x', 'cursor line'],
			cm, mtime: 1_730_000_000_000,
		});

		expect(readLandingState(view)).toEqual({
			scroll: 1,
			cursor: cursor(3),
			anchor: 'viewport line',
			mtime: 1_730_000_000_000,
			// The landing is the cursor line (on screen), and the block is what stood around it.
			context: [
				{ line: 0, text: 'top' },
				{ line: 1, text: 'viewport line' },
				{ line: 2, text: 'x' },
				{ line: 3, text: 'cursor line' },
			],
			contextAt: 3,
		});
	});
});

describe('withNavDisplay — rebuilds display fields around an existing position', () => {
	it('annotates the baseline without mutating it', () => {
		const baseline: EphemeralState = { scroll: 500, cursor: cursor(101) };
		// Cursor line 102 (1-based) sits at offset 1010 — outside the rendered
		// range [0, 500): the baseline was read while the cursor was off screen.
		const cm = makeCm({ viewport: { from: 0, to: 500 } });
		const lines = Array.from({ length: 1000 }, (_, i) => `L${i}`);
		const view = makeView({ mode: 'source', lines, cm });

		const st = withNavDisplay(view, baseline);
		expect(st).toEqual({
			scroll: 500,
			cursor: cursor(101),
			anchor: 'L500',
		});
		// The input is untouched: the baseline is shared with the poll and the
		// db, and a later reconstruction must never flip an entry retroactively.
		expect(baseline).toEqual({ scroll: 500, cursor: cursor(101) });
	});
});
