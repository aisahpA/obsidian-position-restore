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
// forces. The words are what the row is SEARCHED by; which line it took the
// reader to is the jump's own key to say.

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
function makeCm(opts: { viewport: { from: number; to: number }; coordsTop?: number; hidden?: boolean }) {
	return {
		state: { doc: { lines: 1000, line: (n: number) => ({ from: (n - 1) * 10 }) } },
		viewport: opts.viewport,
		scrollDOM: {
			getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 0, right: 800 }),
			// null = out of layout (a hidden tab) — the one case the live read cannot answer.
			offsetParent: opts.hidden ? null : ({} as unknown as HTMLElement),
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

// What the row is searched by: the lines recorded BELOW the landing.
const below = (st: NavEntryState | undefined): string[] | undefined => st?.context;

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
	});

	// A horizontal rule is a legal anchor by its text and a useless one by its nature: the remap
	// scan looks outward from the recorded line, and in a note with several rules it finds a
	// different one. Recorded like a blank line — no anchor, so the number stands or falls alone.
	it('records no anchor when the viewport top is a horizontal rule', () => {
		for (const rule of ['---', '***', '___']) {
			const view = makeView({
				scroll: 1.2, cursorLine: 3, mode: 'source',
				lines: ['top', rule, 'x', 'cursor line'],
				cm: makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 }),
				mtime: 1_730_000_000_000,
			});
			expect(readNavEntryState(view)?.anchor).toBeUndefined();
		}
	});

	it('still anchors a list item — only a bare rule is dropped', () => {
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', '- a list item', 'x', 'cursor line'],
			cm: makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 }),
			mtime: 1_730_000_000_000,
		});
		expect(readNavEntryState(view)?.anchor).toBe('- a list item');
	});

	it('undefined when the hot read is undefined (renderer not caught up)', () => {
		const view = makeView({ scroll: null as unknown as number, cursorLine: 3 });
		expect(readNavEntryState(view)).toBeUndefined();
	});

	// A stacked tab group keeps only its active tab in layout: the hidden scroller's scrollTop
	// reads 0, so the live read says "top of file" for a reader 680 lines down, and the
	// leave-refresh stores that top as their position. Obsidian's own per-tab cache is what still
	// knows — and the anchor must come off that same line, not off the bogus one.
	it('takes the cached scroll when the tab is out of layout', () => {
		const lines: string[] = Array.from({ length: 700 }, (_, i) => (i === 681 ? 'deep line' : 'x'));
		lines[10] = 'top line';
		const view = Object.assign(makeView({
			scroll: 10, cursorLine: 686, mode: 'source', lines,
			cm: makeCm({ viewport: { from: 0, to: 100 }, hidden: true }),
		}), { scroll: 680.59 });

		const st = readNavEntryState(view);

		expect(st?.scroll).toBe(681);
		expect(st?.anchor).toBe('deep line');
	});

	// Visible views keep reading the DOM: an applied restore writes the REQUESTED value into that
	// cache, so trusting it here would echo the request back as the reader's position.
	it('keeps the live read when the view is in layout, cache and all', () => {
		const view = Object.assign(makeView({
			scroll: 10, cursorLine: 686, mode: 'source', lines: Array.from({ length: 700 }, () => 'x'),
			cm: makeCm({ viewport: { from: 0, to: 100 } }),
		}), { scroll: 680.59 });

		expect(readNavEntryState(view)?.scroll).toBe(10);
	});
});

// WHICH line a capture landed on decides where the window starts, and nothing
// is taken from above it — so what gets recorded says which line was decided
// on. Pinned through the words rather than through a stamped index: the line a
// landing sits ON is the jump's key to name (see nav/entry.ts's landedLine),
// and the words only ever answer "what stood below it".
describe('landingContext — which line the window starts from', () => {
	const lines = Array.from({ length: 12 }, (_, i) => `L${i}`);
	const after = (n: number) => [`L${n + 1}`, `L${n + 2}`, `L${n + 3}`, `L${n + 4}`];

	it('starts on the cursor line when it is on screen (source mode)', () => {
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 300 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(3));
	});

	it('starts on the VIEWPORT top when the cursor line was not rendered at all', () => {
		// Line 4 (1-based) sits at offset 30; the rendered range ends at 25.
		const cm = makeCm({ viewport: { from: 0, to: 25 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(1));
	});

	it('starts on the VIEWPORT top when the cursor pixels sit outside the scroller box', () => {
		// Line 4 at offset 30 renders inside the viewport; coordsAtPos reads
		// top 60 (pos*2) — the scroller box starts at 100, so the line sits
		// above the box: scrolled off, off screen.
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 60 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(1));
	});

	it('assumes the cursor is visible when the editor view is unreachable', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(3));
	});

	it('assumes the cursor is visible when the coords are not yet measured', () => {
		const cm = makeCm({ viewport: { from: 0, to: 200 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(3));
	});

	it('starts at the VIEWPORT top for a reading capture (stale pre-preview cursor)', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'preview', lines });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(1));
	});

	it('undefined when the recorded position names no line at all', () => {
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: ['a', 'b'] });

		expect(landingContext(view, {})).toBeUndefined();
	});
});

describe('landingContext — the recorded words', () => {
	it('counts NON-BLANK lines, and stops at the budget', () => {
		// One sentence per line with blank separators (the ordinary shape of a
		// Chinese markdown note): a raw four would spend the window on blanks.
		const lines = [
			'# 标题', '', '第一段', '', '落点',
			'', '本节第一段', '', '本节第二段', '', '本节第三段', '', '本节第四段', '', '本节第五段',
		];
		const cm = makeCm({ viewport: { from: 0, to: 400 }, coordsTop: 300 });
		const view = makeView({ scroll: 4, cursorLine: 4, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 4, cursor: cursor(4) })))
			.toEqual(['本节第一段', '本节第二段', '本节第三段', '本节第四段']);
	});

	it('takes NOTHING from above the landing — those words are the section before', () => {
		// Every landing is a heading jump, and a heading's line is where its section
		// STARTS: the words above belong to the previous section, and recording them
		// is what once made a search for that section's words pull this row up.
		const lines = ['上一节的正文', '', '## Beta', '本节第一段'];
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 300 });
		const view = makeView({ scroll: 2, cursorLine: 2, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 2, cursor: cursor(2) }))).toEqual(['本节第一段']);
	});

	it('undefined when nothing but blanks follows the landing (a heading at the foot)', () => {
		const lines = ['a', 'b', '## Last', '', ''];
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 300 });
		const view = makeView({ scroll: 2, cursorLine: 2, mode: 'source', lines, cm });

		expect(landingContext(view, { scroll: 2, cursor: cursor(2) })).toBeUndefined();
	});

	it('caps one recorded line so a paragraph-per-line note cannot bloat the list', () => {
		const long = 'x'.repeat(500);
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: [long, long] });

		expect(below(words(view, { scroll: 0, cursor: cursor(0) }))?.[0]).toHaveLength(120);
	});

	it('trims a line, so the recorded text is what the panel prints', () => {
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: ['r0', '\t  缩进的段落  '] });

		expect(below(words(view, { scroll: 0, cursor: cursor(0) }))).toEqual(['缩进的段落']);
	});

	it('bounds how far it looks for non-blank lines (the read stays cheap)', () => {
		// Past the bound it records nothing rather than walking a long blank
		// stretch to the end of the note.
		const lines = ['落点', ...Array.from({ length: 400 }, () => '')];
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines });

		expect(below(words(view, { scroll: 0, cursor: cursor(0) }))).toBeUndefined();
	});
});

// The landing is recorded the moment it settles, and the words it is searched and quoted by are
// read in that SAME read: the state arrives whole at both lists, and the stack leaves them behind
// when it writes a step.
describe('readLandingState — the read that records a landing', () => {
	it('is what a step carries plus the words below the landing', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', 'viewport line', 'x', 'cursor line', 'a1', 'a2', 'a3', 'a4', 'a5'],
			cm, mtime: 1_730_000_000_000,
		});

		expect(readLandingState(view)).toEqual({
			scroll: 1,
			cursor: cursor(3),
			anchor: 'viewport line',
			mtime: 1_730_000_000_000,
			// The window starts on the cursor line (on screen) and takes what follows it.
			context: ['a1', 'a2', 'a3', 'a4'],
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
