// Tests for remapAnchoredState (ephemeral.ts): a recorded position whose
// anchor line text moved (edits above shifted lines) re-maps to the line that
// now carries the anchor text; no anchor, an unmoved line, or no match
// applies the position as recorded. The copy carries the shift; the input
// stays untouched.

import { describe, it, expect } from 'vitest';

import { remapAnchoredState } from '../src/ephemeral';
import { EphemeralState } from '../src/types';

function editor(lines: string[]) {
	return {
		getLine: (line: number) => lines[line],
		lastLine: () => lines.length - 1,
	};
}

const BASE_LINES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

describe('remapAnchoredState', () => {
	it('returns the state as-is without an anchor', () => {
		const st: EphemeralState = { scroll: 3 };
		expect(remapAnchoredState(editor(BASE_LINES), st)).toBe(st);
	});

	it('returns the state as-is when the line still holds the anchor text', () => {
		const st: EphemeralState = { scroll: 2, anchor: 'charlie' };
		expect(remapAnchoredState(editor(BASE_LINES), st)).toBe(st);
	});

	it('shifts scroll and cursor when lines were inserted above', () => {
		// anchor was line 2; two lines inserted above moved it to line 4
		const lines = ['x1', 'x2', 'alpha', 'bravo', 'charlie', 'delta', 'echo'];
		const st: EphemeralState = {
			scroll: 2,
			cursor: { from: { line: 3, ch: 1 }, to: { line: 4, ch: 2 } },
			anchor: 'charlie',
		};
		const out = remapAnchoredState(editor(lines), st);
		expect(out.scroll).toBe(4);
		expect(out.cursor).toEqual({
			from: { line: 5, ch: 1 },
			to: { line: 6, ch: 2 },
		});
		// entry stays immutable; the applied copy drops the anchor
		expect(st.scroll).toBe(2);
		expect(st.cursor?.from.line).toBe(3);
		expect(out.anchor).toBeUndefined();
	});

	it('shifts cursor-only records (no scroll)', () => {
		const st: EphemeralState = {
			cursor: { from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } },
			anchor: 'echo',
		};
		const out = remapAnchoredState(editor(BASE_LINES), st);
		expect(out.scroll).toBeUndefined();
		expect(out.cursor?.from.line).toBe(4);
	});

	it('clamps scroll at 0 when the shift goes negative', () => {
		// anchor was line 2; lines above deleted, it moved to line 0; a
		// cursor at line 1 would land before the file top
		const lines = ['charlie', 'delta', 'echo'];
		const st: EphemeralState = {
			scroll: 2,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
			anchor: 'charlie',
		};
		const out = remapAnchoredState(editor(lines), st);
		expect(out.scroll).toBe(0);
		expect(out.cursor?.from.line).toBe(1);
	});

	it('finds the anchor above an out-of-range line (file shrank)', () => {
		const lines = ['alpha', 'bravo', 'echo'];
		const st: EphemeralState = { scroll: 4, anchor: 'echo' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(2);
	});

	it('keeps the stale line when the anchor text is gone', () => {
		const lines = ['alpha', 'bravo', 'rewritten', 'delta', 'echo'];
		const st: EphemeralState = { scroll: 2, anchor: 'charlie' };
		expect(remapAnchoredState(editor(lines), st)).toBe(st);
	});

	it('keeps the stale line when the shift exceeds the scan window', () => {
		const lines = ['far-away-anchor', ...Array(45).fill('filler')];
		const st: EphemeralState = { scroll: 40, anchor: 'far-away-anchor' };
		expect(remapAnchoredState(editor(lines), st)).toBe(st);
	});

	it('matches the nearest duplicate within the window', () => {
		// recorded line 3 holds 'b'; closer duplicate at -1 wins over -3
		let lines = ['dup', 'a', 'dup', 'b', 'c'];
		let st: EphemeralState = { scroll: 3, anchor: 'dup' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(2);
		// equal distance: line+d is checked before line-d
		lines = ['dup', 'a', 'x', 'b', 'c', 'dup'];
		st = { scroll: 3, anchor: 'dup' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(5);
	});
});
