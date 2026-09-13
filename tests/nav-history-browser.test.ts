// Tests for the history browser's pure pieces (src/nav-history/browser/):
// row description, merging, filtering, the file-scope picker's contents, time
// labels, direction segments, pane numbering and the preview window. The
// modal's own DOM stays untested here; everything whose correctness a reader
// would doubt is pure.

import { describe, it, expect } from 'vitest';

import { describeNavEntry, headingTrailAtLine, rowTrail, baseName } from '../src/nav-history/browser/model';
import {
	mergeByLanding, matchesNavFilter, inFileScope, historyFileOptions, formatRelativeTime,
	splitHistorySegments,
} from '../src/nav-history/browser/listing';
import { destinationKey, paneInfo, paneLabel, LiveLeaf } from '../src/nav-history/browser/panes';
import { previewWindow } from '../src/nav-history/browser/preview-lines';
import { t } from '../src/i18n';
import { NavHistoryEntry } from '../src/nav-history/entry';
import { NavEntryState } from '../src/types';

const hasFile = () => true;
const line = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });

describe('describeNavEntry', () => {
	it('a file entry shows its basename and the key-derived jump type', () => {
		const d = describeNavEntry({ kind: 'visit', path: 'notes/project/a.md', leafId: 'leaf-1' } as NavHistoryEntry, hasFile);
		expect(d.file).toBe('a.md');
		expect(d.title).toBe('notes/project/a.md');
		expect(d.type).toBe(t('navHistory.type.open'));
		expect(d.line).toBeUndefined();
		expect(d.missing).toBe(false);
	});

	it('a tab-switch visit (via: switch) gets its own badge', () => {
		const d = describeNavEntry({ kind: 'visit', path: 'a.md', leafId: 'leaf-1', via: 'switch' } as NavHistoryEntry, hasFile);
		expect(d.type).toBe(t('navHistory.type.switch'));
	});


	it('an edit capture shows the cursor line and the cursor line text', () => {
		const edit = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
			st: { scroll: 42, mode: 'source', cursor: line(99), anchor: 'viewport top', cursorAnchor: 'cursor line' },
		} as NavHistoryEntry, hasFile);
		expect(edit.type).toBe(t('navHistory.type.teleport'));
		expect(edit.line).toBe('L100');
		// the same landing as a 0-based index, for the preview window
		expect(edit.lineIndex).toBe(99);
		expect(edit.anchor).toBe('cursor line');
		expect(edit.soft).toBe(true);
	});

	it('an edit capture without cursorAnchor (legacy entry, blank line) shows no text', () => {
		// The viewport-top anchor belongs to another line — showing it next
		// to the cursor line number would misdescribe the landing.
		const edit = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
			st: { scroll: 42, mode: 'source', cursor: line(99), anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(edit.line).toBe('L100');
		expect(edit.anchor).toBeUndefined();
	});

	it('a teleport whose landing never settled falls back to the recorded target line', () => {
		const d = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
		} as NavHistoryEntry, hasFile);
		expect(d.type).toBe(t('navHistory.type.teleport'));
		expect(d.line).toBe('L42');
	});

	it('a reading capture shows the viewport top line and its anchor', () => {
		// the stale pre-preview cursor is ignored
		const read = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, mode: 'preview', cursor: line(3), anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(read.type).toBe(t('navHistory.type.open'));
		expect(read.line).toBe('L42');
		expect(read.anchor).toBe('viewport top');
	});

	it('a cursorless edit capture shows the viewport line and its anchor', () => {
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, mode: 'source', anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L42');
		expect(d.anchor).toBe('viewport top');
	});

	it('a pre-upgrade entry (no mode) falls back to cursor-first', () => {
		const d = describeNavEntry({
			kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'b.md#标题',
			st: { scroll: 42, cursor: line(99) },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L100');
		expect(d.anchor).toBeUndefined();
	});

	it('an off-screen cursor capture falls back to the viewport line and anchor', () => {
		// Source-mode scrolling left the cursor behind (cursorOffscreen): the
		// restore lands on the viewport, so the row describes the viewport,
		// never the invisible cursor line.
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 499, mode: 'source', cursor: line(100), anchor: 'viewport top', cursorAnchor: 'cursor line', cursorOffscreen: true },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L500');
		expect(d.anchor).toBe('viewport top');
	});

	it('outline and anchor keys label their types; a pathless entry is the graph', () => {
		const outline = describeNavEntry({ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:第一章' } as NavHistoryEntry, hasFile);
		expect(outline.type).toBe(t('navHistory.type.outline'));
		const link = describeNavEntry({ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'b.md#标题' } as NavHistoryEntry, hasFile);
		expect(link.type).toBe(t('navHistory.type.link'));
		const graph = describeNavEntry({ kind: 'view', viewType: 'graph', leafId: 'leaf-1' } as NavHistoryEntry, hasFile);
		expect(graph.type).toBe(t('navHistory.type.graph'));
		expect(graph.file).toBe(t('navHistory.graphView'));
		expect(graph.line).toBeUndefined();
	});

	it('a path that no longer resolves is marked missing', () => {
		const d = describeNavEntry({ kind: 'visit', path: 'gone.md', leafId: 'leaf-1' } as NavHistoryEntry, () => false);
		expect(d.missing).toBe(true);
	});

	it('an entry with no recorded position falls back to the file saved record', () => {
		const d = describeNavEntry(
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1' } as NavHistoryEntry,
			hasFile,
			() => ({ scroll: 41, cursor: line(99) }),
		);
		// the saved cursor line is the spot a reopen restores
		expect(d.line).toBe('L100');
		// the compact record carries no anchor text
		expect(d.anchor).toBeUndefined();
	});

	it('falls back to the saved scroll when the record has no cursor', () => {
		const d = describeNavEntry(
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1' } as NavHistoryEntry,
			hasFile,
			() => ({ scroll: 7 }),
		);
		expect(d.line).toBe('L8');
	});
});

// The list's compaction: repeat landings collapse to one row.
describe('mergeByLanding', () => {
	it('merges indices with the same landing, preserving newest-first order', () => {
		const keys: Record<number, string> = { 5: 'L10', 4: 'L20', 3: 'L10', 2: 'L20', 1: 'L30' };
		const rows = mergeByLanding([5, 4, 3, 2, 1], (i) => keys[i]);
		expect(rows.map((r) => r.indices)).toEqual([[5, 3], [4, 2], [1]]);
	});

	it('never merges entries with no landing', () => {
		const rows = mergeByLanding([3, 2, 1], () => undefined);
		expect(rows.map((r) => r.indices)).toEqual([[3], [2], [1]]);
	});

	it('a landing with no duplicate stays its own row', () => {
		const keys: Record<number, string> = { 2: 'L1', 1: 'L2' };
		const rows = mergeByLanding([2, 1], (i) => keys[i]);
		expect(rows.map((r) => r.indices)).toEqual([[2], [1]]);
	});
});

// The browser's filter box: tokens AND-match across file name, path, and the
// anchor text, read straight from the entry (no DOM, no describeNavEntry).
describe('matchesNavFilter', () => {
	const visit = (path: string, st?: NavEntryState): NavHistoryEntry =>
		({ kind: 'visit', path, leafId: 'leaf-1', st } as NavHistoryEntry);

	it('an empty or whitespace query matches everything', () => {
		expect(matchesNavFilter(visit('notes/a.md'), '')).toBe(true);
		expect(matchesNavFilter(visit('notes/a.md'), '   ')).toBe(true);
	});

	it('matches the basename, full path, and anchor text case-insensitively', () => {
		const e = visit('notes/project/Alpha.md', { anchor: 'Chapter One' });
		expect(matchesNavFilter(e, 'alpha')).toBe(true);
		expect(matchesNavFilter(e, 'PROJECT')).toBe(true);
		expect(matchesNavFilter(e, 'chapter')).toBe(true);
		expect(matchesNavFilter(e, 'beta')).toBe(false);
	});

	it('requires every whitespace-separated token (AND)', () => {
		const e = visit('notes/project/Alpha.md', { anchor: 'Chapter One' });
		expect(matchesNavFilter(e, 'alpha chapter')).toBe(true);
		expect(matchesNavFilter(e, 'alpha missing')).toBe(false);
	});

	it('matches a pathless view entry by its view type / graph label', () => {
		const e = { kind: 'view', leafId: 'leaf-1', viewType: 'graph' } as NavHistoryEntry;
		expect(matchesNavFilter(e, 'graph')).toBe(true);
		expect(matchesNavFilter(e, t('navHistory.graphView'))).toBe(true);
		expect(matchesNavFilter(e, 'canvas')).toBe(false);
	});
});

// The file scope ("only in this note"): the predicate behind the toolbar chip.
describe('inFileScope', () => {
	const at = (path: string): NavHistoryEntry => ({ kind: 'visit', path, leafId: 'leaf-1' });

	it('keeps only the entries of the scoped file', () => {
		expect(inFileScope(at('a.md'), 'a.md')).toBe(true);
		expect(inFileScope(at('b.md'), 'a.md')).toBe(false);
	});

	it('compares the whole path, not the basename', () => {
		// two notes named the same in different folders are different files
		expect(inFileScope(at('archive/a.md'), 'notes/a.md')).toBe(false);
	});

	it('is inert without a file to scope to', () => {
		// an empty history or a pathless view step leaves a stale toggle harmless
		expect(inFileScope(at('a.md'), undefined)).toBe(true);
		expect(inFileScope({ kind: 'view', leafId: 'leaf-1', viewType: 'graph' } as NavHistoryEntry, undefined)).toBe(true);
	});

	it('never matches a view step, which is not a place in a note', () => {
		const graph = { kind: 'view', leafId: 'leaf-1', viewType: 'graph' } as NavHistoryEntry;
		expect(inFileScope(graph, 'a.md')).toBe(false);
	});
});

describe('historyFileOptions', () => {
	const NOW = Date.parse('2025-09-12T12:00:00');
	const MINUTE = 60_000;
	const at = (path: string, agoMin: number): NavHistoryEntry =>
		({ kind: 'visit', path, leafId: 'leaf-1', t: NOW - agoMin * MINUTE });

	it('lists each file once, by name, with the steps that landed there', () => {
		// By NAME, not by recency. The panel answers "recently" three times over:
		// the pinned card, the direct switch and the chronological list. What is
		// left for a picker is a lookup — and a lookup wants a position it can be
		// found at twice, not a rank that moves with every visit.
		const opts = historyFileOptions([
			at('zeta.md', 60), at('alpha.md', 2), at('zeta.md', 30), at('alpha.md', 1),
		]);
		expect(opts.map(o => o.path)).toEqual(['alpha.md', 'zeta.md']);
		expect(opts.map(o => o.count)).toEqual([2, 2]);
		expect(opts[0].name).toBe('alpha.md');
	});

	it('sorts names the way a reader would, not by code point', () => {
		// "draft 2" belongs before "draft 10" and "Beta" beside "beta": a raw
		// string compare puts the ten first and splits the two cases apart, which
		// is the classic "this list looks unsorted" complaint.
		const opts = historyFileOptions([at('draft 10.md', 3), at('draft 2.md', 2), at('beta.md', 1)]);
		expect(opts.map(o => o.name)).toEqual(['beta.md', 'draft 2.md', 'draft 10.md']);
	});

	it('skips view steps, which have no path to narrow to', () => {
		// A graph-only stack has nothing to scope to: no chip at all, rather
		// than a chip whose menu is empty.
		const opts = historyFileOptions([
			at('a.md', 5),
			{ kind: 'view', leafId: 'leaf-1', viewType: 'graph', t: NOW } as NavHistoryEntry,
		]);
		expect(opts.map(o => o.path)).toEqual(['a.md']);
		expect(historyFileOptions([{ kind: 'view', leafId: 'leaf-1', viewType: 'graph' } as NavHistoryEntry]))
			.toEqual([]);
	});

	it('names the folder only where two files share a name', () => {
		// Two notes called "index" are otherwise one item and the choice
		// between them could not be made; the folder is long and faint, so it
		// is spent on the ambiguity alone.
		const opts = historyFileOptions([
			at('notes/index.md', 5), at('b.md', 4), at('archive/index.md', 3),
		]);
		const byPath = new Map(opts.map(o => [o.path, o]));
		expect(byPath.get('notes/index.md')?.folder).toBe('notes');
		expect(byPath.get('archive/index.md')?.folder).toBe('archive');
		expect(byPath.get('b.md')?.folder).toBeUndefined();
	});

	it('gives a same-named note at the vault root a folder to show', () => {
		const opts = historyFileOptions([at('index.md', 5), at('archive/index.md', 3)]);
		expect(opts.find(o => o.path === 'index.md')?.folder).toBe('/');
	});
});

describe('baseName', () => {
	it('is the last path segment, and the path itself when there is none', () => {
		expect(baseName('notes/deep/a.md')).toBe('a.md');
		expect(baseName('a.md')).toBe('a.md');
	});
});

// The browser's primary index is TIME, not stack distance: a user remembers
// "the spot from a few minutes ago", never "three steps back" — which is why
// the old ±N step counter is gone.
describe('formatRelativeTime', () => {
	const NOW = Date.parse('2025-09-12T12:00:00');

	it('collapses the last minute to "just now"', () => {
		expect(formatRelativeTime(NOW - 5_000, NOW)).toBe(t('navHistory.time.now'));
	});

	it('counts minutes under an hour, hours under a day, days under a week', () => {
		expect(formatRelativeTime(NOW - 20 * 60_000, NOW)).toBe(t('navHistory.time.minutes', 20));
		expect(formatRelativeTime(NOW - 5 * 3_600_000, NOW)).toBe(t('navHistory.time.hours', 5));
		expect(formatRelativeTime(NOW - 3 * 86_400_000, NOW)).toBe(t('navHistory.time.days', 3));
	});

	it('falls back to an absolute date beyond a week', () => {
		expect(formatRelativeTime(Date.parse('2025-08-01T09:30:00'), NOW)).toBe('2025-08-01');
	});

	it('never renders a future stamp as a negative age', () => {
		expect(formatRelativeTime(NOW + 60_000, NOW)).toBe(t('navHistory.time.now'));
	});
});

// The current entry is rendered as a pinned card, so the list is exactly the
// two directions around it.
describe('splitHistorySegments', () => {
	const visit = (path: string): NavHistoryEntry =>
		({ kind: 'visit', path, leafId: 'leaf-1', t: 1 } as NavHistoryEntry);
	const entries = [visit('a.md'), visit('b.md'), visit('c.md'), visit('d.md'), visit('e.md')];

	it('splits around the current entry, newest first, and never includes it', () => {
		const { forward, back } = splitHistorySegments(entries, 2);
		expect(forward).toEqual([4, 3]);
		expect(back).toEqual([1, 0]);
	});

	it('has no forward half at the top of the stack', () => {
		const { forward, back } = splitHistorySegments(entries, 4);
		expect(forward).toEqual([]);
		expect(back).toEqual([3, 2, 1, 0]);
	});

	it('applies the filter to both halves', () => {
		const { forward, back } = splitHistorySegments(entries, 2, (i) => i !== 3);
		expect(forward).toEqual([4]);
		expect(back).toEqual([1, 0]);
	});
});

describe('destinationKey', () => {
	it('keys file entries by path and view entries by view type', () => {
		expect(destinationKey({ kind: 'visit', path: 'a.md', leafId: 'l', t: 1 } as NavHistoryEntry)).toBe('a.md');
		expect(destinationKey({ kind: 'view', viewType: 'graph', leafId: 'l', t: 1 } as NavHistoryEntry)).toBe('view:graph');
	});
});

// Two tabs (or two panes) holding one file: without a marker, their rows are
// identical, and telling them apart is what decides which row to pick. The
// marker is derived from the LIVE layout, not from the history's recorded leaf
// ids — see paneLabel — so what is fed in here is the main area as it stands.
describe('paneInfo / paneLabel', () => {
	const visit = (path: string, leafId: string): NavHistoryEntry =>
		({ kind: 'visit', path, leafId, t: 1 } as NavHistoryEntry);
	const graph = (leafId: string): NavHistoryEntry =>
		({ kind: 'view', viewType: 'graph', leafId, t: 1 } as NavHistoryEntry);
	const layout = (...leaves: [string, string][]): LiveLeaf[] =>
		leaves.map(([leafId, key]) => ({ leafId, key }));

	it('numbers the live tabs holding a file, in layout order', () => {
		const info = paneInfo(layout(['a1', 'a.md'], ['b1', 'b.md'], ['a2', 'a.md']));
		expect(paneLabel(info, visit('a.md', 'a1'))).toEqual({ n: 1, total: 2 });
		expect(paneLabel(info, visit('a.md', 'a2'))).toEqual({ n: 2, total: 2 });
		// b.md lives in a single leaf: a marker would be pure noise
		expect(paneLabel(info, visit('b.md', 'b1'))).toBeUndefined();
	});

	it('gives no number to a step whose tab has moved on or been closed', () => {
		// The bug this replaced: the number came from the history, so a tab that
		// had since opened another note (or been closed) still claimed a window —
		// "2/2" for a file only one tab was showing.
		const info = paneInfo(layout(['a1', 'a.md'], ['a2', 'a.md']));
		expect(paneLabel(info, visit('a.md', 'closed'))).toBeUndefined();
	});

	it('says nothing when only one live leaf holds the destination', () => {
		const info = paneInfo(layout(['a1', 'a.md']));
		expect(paneLabel(info, visit('a.md', 'a1'))).toBeUndefined();
	});

	it('numbers graph tabs by view type, the same way', () => {
		const info = paneInfo(layout(['g1', 'view:graph'], ['g2', 'view:graph']));
		expect(paneLabel(info, graph('g2'))).toEqual({ n: 2, total: 2 });
	});

	it('a file reopened twice in the same tab is not ambiguous', () => {
		const info = paneInfo(layout(['a1', 'a.md']));
		expect(paneLabel(info, visit('a.md', 'a1'))).toBeUndefined();
	});
});

// The preview strip: the landing line plus a neighbour either side, clamped
// to the document, so a spot is recognized instead of guessed.
describe('previewWindow', () => {
	const lines = ['a', 'b', 'c', 'd', 'e'];

	it('returns the landing line with one neighbour either side, marked', () => {
		expect(previewWindow(lines, 2)).toEqual([
			{ num: 2, text: 'b', mark: false },
			{ num: 3, text: 'c', mark: true },
			{ num: 4, text: 'd', mark: false },
		]);
	});

	it('clamps at the document edges', () => {
		expect(previewWindow(lines, 0).map(l => l.num)).toEqual([1, 2]);
		expect(previewWindow(lines, 4).map(l => l.num)).toEqual([4, 5]);
	});

	it('an empty document has nothing to preview', () => {
		expect(previewWindow([], 0)).toEqual([]);
	});
});

// The section a landing sits in: the coarse index a reader scans by, and the
// reason the strip and the rows can name it without reading the file.
describe('headingTrailAtLine', () => {
	const h = (heading: string, level: number, line: number) => ({ heading, level, line });

	it('nests by level, outermost first, and stops at the line', () => {
		const headings = [h('A', 1, 0), h('B', 2, 10), h('C', 3, 20), h('D', 2, 30)];
		expect(headingTrailAtLine(headings, 25)).toEqual(['A', 'B', 'C']);
		expect(headingTrailAtLine(headings, 10)).toEqual(['A', 'B']);
		// a same-or-shallower heading closes the deeper ones
		expect(headingTrailAtLine(headings, 35)).toEqual(['A', 'D']);
	});

	it('is empty above the first heading and without headings', () => {
		expect(headingTrailAtLine([h('A', 1, 5)], 4)).toEqual([]);
		expect(headingTrailAtLine(undefined, 4)).toEqual([]);
	});
});

describe('rowTrail', () => {
	it('keeps the deepest two levels', () => {
		expect(rowTrail(['A', 'B', 'C'], undefined)).toEqual(['B', 'C']);
		expect(rowTrail(['A'], undefined)).toEqual(['A']);
	});

	it('drops the heading the landing line itself carries', () => {
		// an outline jump lands ON its heading: the row quotes that text, so
		// repeating it as a section would say the same thing twice
		expect(rowTrail(['A', 'B', '决策'], '## 决策')).toEqual(['A', 'B']);
		expect(rowTrail(['A', 'B', '决策'], '决策')).toEqual(['A', 'B']);
		// prose that merely mentions the section is not a duplicate
		expect(rowTrail(['A', 'B'], 'B 的另一半')).toEqual(['A', 'B']);
	});
});
