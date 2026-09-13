// Tests for the two-tier read split (ephemeral.ts): the hot read
// (readEphemeralState) carries position only — the 100ms poll and the
// restore verification/reland loops run it every tick and frame, so it must
// never pay doc-string reads or layout — while the nav reads
// (readNavEntryState / withNavDisplay) assemble the NavEntryState display
// fields at save time. The cursor-visibility check is the one
// layout-forcing read and runs pixel geometry through (editor).cm — never
// currentMode.getScroll(), which echoes the requested value (pixels.ts).

import { describe, it, expect } from 'vitest';

import { MarkdownView } from 'obsidian';
import { readEphemeralState, readNavEntryState, withNavDisplay } from '../src/position/capture/ephemeral';
import { EphemeralState } from '../src/types';

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
}): MarkdownView {
	const lines = opts.lines ?? [];
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		currentMode: { getScroll: () => opts.scroll },
		getMode: opts.mode ? () => opts.mode : undefined,
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

describe('readEphemeralState — the hot read is position only', () => {
	it('carries no anchor/cursorAnchor/mode even when the view could provide them', () => {
		const view = makeView({ scroll: 42.3, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'] });
		expect(readEphemeralState(view)).toEqual({
			scroll: 42,
			cursor: cursor(3),
		});
	});
});

describe('readNavEntryState — the nav read assembles the display fields', () => {
	it('adds the viewport anchor, the cursor line text, and the mode stamp', () => {
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', 'viewport line', 'x', 'cursor line'],
		});
		expect(readNavEntryState(view)).toEqual({
			scroll: 1,
			cursor: cursor(3),
			anchor: 'viewport line',
			cursorAnchor: 'cursor line',
			mode: 'source',
		});
	});

	it('flags a cursor line outside the rendered viewport (unrendered = off screen)', () => {
		// Line 4 (1-based) sits at offset 30; the rendered range ends at 25.
		const cm = makeCm({ viewport: { from: 0, to: 25 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });
		const st = readNavEntryState(view);
		expect(st?.cursorOffscreen).toBe(true);
	});

	it('flags a rendered cursor line whose pixels sit outside the scroller box', () => {
		// Line 4 at offset 30 renders inside the viewport; coordsAtPos reads
		// top 60 (pos*2) — the scroller box starts at 100, so the line sits
		// above the box: scrolled off, off screen.
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 60 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });
		const st = readNavEntryState(view);
		expect(st?.cursorOffscreen).toBe(true);
	});

	it('no flag when the rendered cursor line is inside the scroller box', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });
		const st = readNavEntryState(view);
		expect(st?.cursorOffscreen).toBeUndefined();
		expect(st?.cursorAnchor).toBe('d');
	});

	it('no flag when the editor view is unreachable (assume visible)', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'] });
		const st = readNavEntryState(view);
		expect(st?.cursorOffscreen).toBeUndefined();
	});

	it('no flag when the coords are not yet measured (assume visible)', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'], cm });
		const st = readNavEntryState(view);
		expect(st?.cursorOffscreen).toBeUndefined();
	});

	it('a reading capture skips the cursor display fields (stale pre-preview cursor)', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'preview', lines: ['a', 'b', 'c', 'd'] });
		const st = readNavEntryState(view);
		expect(st?.mode).toBe('preview');
		expect(st?.cursorAnchor).toBeUndefined();
		expect(st?.cursorOffscreen).toBeUndefined();
		expect(st?.anchor).toBe('b');
	});

	it('a blank cursor line carries no text and no flag', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', ''], cm });
		const st = readNavEntryState(view);
		expect(st?.cursorAnchor).toBeUndefined();
		expect(st?.cursorOffscreen).toBeUndefined();
	});

	it('undefined when the hot read is undefined (renderer not caught up)', () => {
		const view = makeView({ scroll: null as unknown as number, cursorLine: 3 });
		expect(readNavEntryState(view)).toBeUndefined();
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
			cursorAnchor: 'L101',
			mode: 'source',
			cursorOffscreen: true,
		});
		// The input is untouched: the baseline is shared with the poll and the
		// db, and a later reconstruction must never flip an entry retroactively.
		expect(baseline).toEqual({ scroll: 500, cursor: cursor(101) });
	});
});
