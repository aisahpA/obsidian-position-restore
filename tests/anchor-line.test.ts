// Tests for anchor-line.ts: resolveAnchorLine resolves a keyed NavJump's
// structural anchor (outline heading, #heading link, ^block ref) to its
// CURRENT line in the file, surviving arbitrary insert/delete shifts — vs.
// the ±30-line text-snippet remap it replaces for keyed jumps.

import { describe, it, expect } from 'vitest';
import { outlinePathAtLine, resolveAnchorLine } from '../src/anchor-line';

function cache(headings: Array<[string, number] | [string, number, number]>, blocks?: Record<string, number>) {
	return {
		headings: headings.map(([heading, line, level = 1]) => ({
			heading,
			level,
			position: { start: { line }, end: { line } },
		})),
		blocks: blocks ? Object.fromEntries(
			Object.entries(blocks).map(([id, line]) => [id, { id, position: { start: { line }, end: { line } } }]),
		) : undefined,
	} as never;
}

describe('resolveAnchorLine', () => {
	it('resolves an outline heading key to its current line', () => {
		// 40 lines were inserted above; the heading is now at line 42.
		const c = cache([['Alpha', 0], ['Beta', 42], ['Gamma', 90]]);
		expect(resolveAnchorLine(c, 'outline:Beta')).toBe(42);
	});

	it('matches outline heading text case/whitespace-insensitively', () => {
		const c = cache([['Some Heading', 7]]);
		expect(resolveAnchorLine(c, 'outline:some  heading')).toBe(7);
	});

	it('resolves a #heading link (slug) via normalization', () => {
		const c = cache([['My Heading', 12]]);
		expect(resolveAnchorLine(c, 'note.md#my-heading')).toBe(12);
	});

	it('resolves a ^block reference by exact id', () => {
		const c = cache([], { '2024-01-01': 5 });
		expect(resolveAnchorLine(c, 'note.md^2024-01-01')).toBe(5);
	});

	it('returns undefined when the heading is renamed or removed', () => {
		const c = cache([['Alpha', 0]]);
		expect(resolveAnchorLine(c, 'outline:Vanished')).toBeUndefined();
		expect(resolveAnchorLine(c, 'note.md#Vanished')).toBeUndefined();
		expect(resolveAnchorLine(c, 'note.md^missing-block')).toBeUndefined();
	});

	it('returns undefined for non-structural keys', () => {
		expect(resolveAnchorLine(cache([]), 'caller:123')).toBeUndefined();
		expect(resolveAnchorLine(null, 'outline:Alpha')).toBeUndefined();
		expect(resolveAnchorLine(cache([]), '')).toBeUndefined();
	});

	it('picks the duplicate heading nearest the recorded base line', () => {
		// Two "Notes" headings at 10 and 50; the jump landed on the second
		// one (base 50) — resolve must return 50, not the document-first 10.
		const c = cache([['Intro', 0], ['Notes', 10], ['Body', 30], ['Notes', 50], ['End', 70]]);
		expect(resolveAnchorLine(c, 'outline:Notes', 50)).toBe(50);
		expect(resolveAnchorLine(c, 'outline:Notes', 8)).toBe(10);
	});

	it('falls back to the first duplicate without a base line', () => {
		const c = cache([['Notes', 10], ['Notes', 50]]);
		expect(resolveAnchorLine(c, 'outline:Notes')).toBe(10);
	});

	it('survives a stray % in the link anchor (decode fallback)', () => {
		// decodeURIComponent would throw on "%50%"-style junk; the raw text
		// stands in and the call must not throw into execute().
		const c = cache([['50', 3]]);
		expect(resolveAnchorLine(c, 'note.md#%50%')).toBe(3);
	});

	it('prefers an exact heading over a nearer normalized-only one', () => {
		// 'Notes!' (line 10, nearest base 12) only normalizes to the key;
		// the unedited 'Notes' (line 0) wins the plain pass first.
		const c = cache([['Notes', 0], ['Notes!', 10]]);
		expect(resolveAnchorLine(c, 'outline:Notes', 12)).toBe(0);
	});

	it('resolves an upgraded source-line key by exact text and level', () => {
		// "outline:## My Heading": # count = level 2, rest is the heading's
		// exact source text — a markdown-syntax heading (unrenderable as a
		// plain-text match) still resolves structurally.
		const c = cache([['**Bold** Title', 20, 2]]);
		expect(resolveAnchorLine(c, 'outline:## **Bold** Title')).toBe(20);
	});

	it('disambiguates same-text headings by the key level', () => {
		// '## Setup' and '#### Setup' share the text; the key's level picks
		// the right instance regardless of proximity.
		const c = cache([['Setup', 10, 2], ['Setup', 50, 4]]);
		expect(resolveAnchorLine(c, 'outline:## Setup', 48)).toBe(10);
		expect(resolveAnchorLine(c, 'outline:#### Setup', 48)).toBe(50);
	});

	it('does not let a level-filtered miss mask the rendered-text fallback', () => {
		// An upgraded key whose text later fails to match (renamed heading)
		// stays undefined — no cross-level guessing.
		const c = cache([['Setup', 10, 2]]);
		expect(resolveAnchorLine(c, 'outline:## Renamed')).toBeUndefined();
	});
});
// The section chain a line sits under — shared by the post-restore breadcrumb
// and the history browser's detail strip, so both name a section identically.
describe('outlinePathAtLine', () => {
	const trail = (lines: string[], line: number) => outlinePathAtLine(lines, line);

	it('nests by heading level, outermost first', () => {
		const lines = ['# A', 'text', '## B', 'text', '### C', 'here'];
		expect(trail(lines, 5)).toEqual(['A', 'B', 'C']);
		// a shallower heading closes the deeper ones
		expect(trail(lines, 1)).toEqual(['A']);
	});

	it('includes a heading sitting on the line itself as the deepest segment', () => {
		const lines = ['# A', '## B'];
		expect(trail(lines, 1)).toEqual(['A', 'B']);
	});

	it('is empty above the first heading', () => {
		expect(trail(['text', '# A'], 0)).toEqual([]);
	});

	it('ignores heading-looking lines inside fences and comments', () => {
		const lines = ['# Real', '```', '# not a heading', '```', '<!--', '# nor this', '-->', '%%', '# nor this', '%%', 'body'];
		expect(trail(lines, 11)).toEqual(['Real']);
	});

	it('strips a closing hash run and inline comment from the heading text', () => {
		expect(trail(['## Title ##'], 0)).toEqual(['Title']);
		expect(trail(['## Title %%note%%'], 0)).toEqual(['Title']);
	});
});
