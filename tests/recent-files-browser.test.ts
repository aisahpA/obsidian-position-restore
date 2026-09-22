// Tests for the recent-files browser's pure pieces (src/recent-files/browser/):
// row description, tree grouping/merging, filtering and section chains. The DOM
// stays untested here; everything whose correctness a reader would doubt is pure.

import { describe, it, expect } from 'vitest';

import {
	describeNavEntry, headingTrailAtLine, rowTrail, baseName, badgeOf, displayName, duplicateNames, folderOf,
	ageLabel, ageOf, newestStamp,
} from '@/recent-files/browser/model';
import { groupByFile, matchesNavFilter } from '@/recent-files/browser/listing';
import { revealDelta } from '@/recent-files/browser/list';
import { t } from '@/i18n';
import { NavEntry } from '@/nav/entry';
import { NavEntryState } from '@/types';

const line = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });
// A recorded landing block, as capture writes it: surrounding lines with the
// landing at `at`.
const block = (lines: string[], at: number): NavEntryState => ({
	context: lines.map((text, i) => ({ line: i, text })),
	contextAt: at,
});

describe('describeNavEntry', () => {
	it('a file entry shows its name, without the extension', () => {
		// "meeting-notes.md" is the note "meeting-notes": the suffix is not part of
		// what a reader calls it, and a vault of markdown would print the same two
		// characters on every row (see displayName).
		const d = describeNavEntry({ kind: 'visit', path: 'notes/project/a.md', leafId: 'leaf-1' } as NavEntry);
		expect(d.name).toBe('a');
		expect(d.line).toBeUndefined();
		expect(d.lineIndex).toBeUndefined();
	});

	it('reads the landing line from the recorded block', () => {
		const edit = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
			st: { scroll: 42, cursor: line(99), anchor: 'viewport top', ...block(['x', 'y', 'cursor line', 'z'], 2) },
		} as NavEntry);
		// the landing line, not the viewport top and not the cursor
		expect(edit.line).toBe('L3');
		// the same landing as a 0-based index: what the list keys a spot by, and what
		// the section chain is looked up against
		expect(edit.lineIndex).toBe(2);
	});

	it('a teleport whose landing never settled falls back to the recorded target line', () => {
		const d = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
		} as NavEntry);
		expect(d.line).toBe('L42');
	});

	it('a state with no block falls back to the viewport top line', () => {
		// Not reachable for an entry this plugin recorded (see
		// NavEntryState.context), but a position record fed into the row has no
		// block, and the viewport top is the honest guess then.
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, cursor: line(3), anchor: 'viewport top' },
		} as NavEntry);
		expect(d.line).toBe('L42');
		expect(d.lineIndex).toBe(41);
	});

	it('a cursorless state with no block still shows the viewport line', () => {
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, anchor: 'viewport top' },
		} as NavEntry);
		expect(d.line).toBe('L42');
	});

	it('a pathless view with no name of its own falls back, and has no coordinate', () => {
		const graph = describeNavEntry({ kind: 'view', viewType: 'graph', leafId: 'leaf-1' } as NavEntry);
		expect(graph.name).toBe(t('recentFiles.graphView'));
		expect(graph.line).toBeUndefined();
		expect(graph.lineIndex).toBeUndefined();
	});

	it('names a view by its own label, and falls back for one that has none', () => {
		// The view's own name is what its tab header said while the reader was there
		// (see NavView.label), so a Thino row says "Thino" without this list having
		// to know the plugin; a view that never named itself gets this list's wording
		// for the graph, and its bare type otherwise (see viewName).
		const named = describeNavEntry(
			{ kind: 'view', viewType: 'thino_view', label: 'Thino', leafId: 'leaf-1' } as NavEntry,
		);
		expect(named.name).toBe('Thino');

		const unnamed = describeNavEntry(
			{ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1' } as NavEntry,
		);
		expect(unnamed.name).toBe('thino_view');
	});

	it('an entry with no recorded position falls back to the file saved record', () => {
		const d = describeNavEntry(
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1' } as NavEntry,
			() => ({ scroll: 41, cursor: line(99) }),
		);
		// the saved cursor line is the spot a reopen restores
		expect(d.line).toBe('L100');
	});

	it('falls back to the saved scroll when the record has no cursor', () => {
		const d = describeNavEntry(
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1' } as NavEntry,
			() => ({ scroll: 7 }),
		);
		expect(d.line).toBe('L8');
	});
});

// The list's tree: every note once, its landings under it.
describe('groupByFile', () => {
	// One LANDING of a note, as the recent-files list holds it: a jump the reader
	// made. A note's own record (the `visit`) is the group's anchor and adds no
	// landing at all (see listing.ts) — a row standing for it would open the file
	// the reader is already in, which is the row that visibly does nothing.
	const spot = (path: string, i: number, line: number): NavEntry =>
		({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
	// The line each step landed on, resolved the way the browser resolves it (see
	// RecentFilesList.render). The pure function groups by what it is TOLD: a caller
	// that says nothing about lines is saying every step of a note is the same
	// place, which is what a file with no coordinates has (see landingKey).
	const lines = (entries: NavEntry[]) => (i: number) =>
		entries[i].kind === 'view' ? undefined : entries[i].st?.scroll;

	it('groups one note\'s steps together, newest first, and keeps the notes in recency order', () => {
		const entries = [
			spot('a.md', 0, 10),
			spot('b.md', 1, 20),
			spot('a.md', 2, 400),
			spot('c.md', 3, 40),
		];
		const groups = groupByFile(entries, 3, undefined, lines(entries));

		expect(groups.map(g => g.path)).toEqual(['c.md', 'a.md', 'b.md']);
		// …and inside a note the rows come out DOWN the note: L10 before L400, not in
		// the order they were visited in (see groupByFile).
		expect(groups.map(g => g.indices)).toEqual([[3], [0, 2], [1]]);
		expect(groups[0].current).toBe(true);
	});

	it('keeps the note the reader is in where its recency puts it', () => {
		// "You are here" is a mark on a row (see NavFileGroup.current), never a place
		// in the order: a.md is the note being read and the OLDER of the two, so it
		// stays where its own time puts it — second.
		const entries = [spot('a.md', 0, 10), spot('b.md', 1, 20)];
		const groups = groupByFile(entries, 0);

		expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md']);
		expect(groups[1].current).toBe(true);
		expect(groups[0].current).toBe(false);
	});

	it('drops the current note when nothing about it survives the filter', () => {
		// `keep` is the query. A note with no surviving step is not this list's
		// business, current or not; the empty-group case is the one where the note
		// is there but has nothing left to open.
		const entries = [spot('a.md', 0, 10), spot('b.md', 1, 20)];
		const groups = groupByFile(entries, 1, i => i === 0);

		expect(groups.map(g => g.path)).toEqual(['a.md']);
	});

	it('orders the pathless view step (the graph) by its own time, like a note', () => {
		// The graph is the NEWEST place here: the last step on the store's list is
		// the most recent one (see places.ts). A view is somewhere the reader went,
		// so it takes the place its time gives it — parked at the foot of the list
		// it would be a place whose time the order ignores.
		const entries = [
			spot('a.md', 0, 10),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 9000 } as NavEntry,
		];
		const groups = groupByFile(entries, 0);

		expect(groups.map(g => g.path)).toEqual(['', 'a.md']);
	});

	// EVERY SPOT IS A ROW, however close the next one stands. Nearby landings used to
	// be folded into one row (a LANDING_MERGE_LINES window, since removed): the row
	// printed ONE member's line while covering the others, so a click could not reach
	// them, the fold was invisible once the row stopped printing the range, and the
	// "you are here" dot could sit on a row whose line was not where the reader was.
	// 'all' is the reader asking for every place in the note (see NavFileGroup).
	describe('every landing is a row of its own', () => {
		const at = (path: string, i: number, line: number): NavEntry =>
			({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
		const lineOf = (entries: NavEntry[]) => (i: number) => {
			const entry = entries[i];
			return entry.kind === 'view' ? undefined : entry.st?.scroll;
		};

		it('keeps a trail a few lines apart as one row per line, down the note', () => {
			const entries = [at('a.md', 0, 10), at('a.md', 1, 18), at('a.md', 2, 26)];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			// Three spots eight lines apart, three rows — L11 before L19 before L27, not in
			// the order they were visited (see groupByFile) — and each one is the step a
			// click on it lands on.
			expect(groups[0].indices).toEqual([0, 1, 2]);
		});

		it('stands for a line with its NEWEST step, and lets the reader\'s own step win', () => {
			// Two steps on one line are one landing (see landingKey). The row opens the
			// newest of them — the last place the reader was in that line — except where
			// the CURRENT entry shares the line: then the slot keeps the reader's own step,
			// because that is the step "here" has to name.
			const entries = [at('a.md', 0, 10), at('a.md', 1, 12), at('a.md', 2, 12)];

			const newest = groupByFile(entries, 0, undefined, lineOf(entries));
			expect(newest[0].indices).toEqual([0, 2]);

			const current = groupByFile(entries, 1, undefined, lineOf(entries));
			expect(current[0].indices).toEqual([0, 1]);
			expect(current[0].currentRep).toBe(1);
			expect(current[0].current).toBe(true);
		});

		it('marks the row the reader is on, and marks nothing when no landing holds them', () => {
			// The dot is the listed landing the reader is standing on — and the note's OWN
			// record is not a landing, so a reader who is in the note without having jumped
			// in it has no row to mark (see NavFileGroup.currentRep).
			const entries = [
				{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 500 } as NavEntry,
				at('a.md', 1, 18),
			];

			const onLanding = groupByFile(entries, 1, undefined, lineOf(entries));
			expect(onLanding[0].indices).toEqual([1]);
			expect(onLanding[0].currentRep).toBe(1);

			const onNote = groupByFile(entries, 0, undefined, lineOf(entries));
			expect(onNote[0].indices).toEqual([1]);
			expect(onNote[0].current).toBe(true);
			expect(onNote[0].currentRep).toBeUndefined();
		});

		it('keeps a landing with no coordinate of its own apart from the numbered ones', () => {
			// A `.base`, an image, a step whose position never resolved: one place, and it
			// cannot be near anything — there is no number to be near.
			const entries = [
				at('a.md', 0, 400),
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:H1', t: 1400, st: {} } as NavEntry,
			];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			expect(groups[0].indices).toEqual([0, 1]);
		});
	});

	// The landings under a note are PLACES, not steps (see landingKey): the line
	// a step landed on is what tells two of them apart, and it comes in as a
	// resolver because the line a row prints is not always the entry's own (a
	// step with no recorded block falls back to the file's saved position).
	describe('one landing, however many steps reached it', () => {
		const at = (path: string, i: number, line: number): NavEntry =>
			({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
		const lineOf = (entries: NavEntry[]) => (i: number) => {
			const entry = entries[i];
			return entry.kind === 'view' ? undefined : entry.st?.scroll;
		};

		it('keeps one row per line, in line order, and one slot in the group', () => {
			const entries = [
				at('a.md', 0, 10),
				at('a.md', 1, 400),
				at('a.md', 2, 400),
				at('a.md', 3, 400),
			];
			const groups = groupByFile(entries, 3, undefined, lineOf(entries));

			// L400 was reached three times, by three steps: one destination. The two
			// landings come out down the note — L10 before L400, whatever order they
			// were visited in (see groupByFile).
			expect(groups[0].indices).toEqual([0, 3]);
		});

		it('lets the CURRENT step stand for the landing it shares', () => {
			// The current entry has to be drawn as "here", and it can be an OLDER
			// step than the one it shares its landing with: the slot keeps the
			// reader's own step rather than a newer one that goes to the same place.
			const entries = [at('a.md', 0, 10), at('a.md', 1, 400), at('a.md', 2, 400)];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			expect(groups[0].indices).toEqual([0, 2]);
			expect(groups[0].current).toBe(true);
		});

		it('puts the steps whose line nothing can resolve last, where their row says "—"', () => {
			// A step with no line cannot be placed in the note's own order, so its
			// landing stands after the ones that can — it is not a guess about WHERE,
			// it is the one landing a file without coordinates has (see landingKey).
			const entries = [
				at('a.md', 0, 10),
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B1', t: 1000 } as NavEntry,
				at('a.md', 2, 400),
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B3', t: 1200 } as NavEntry,
			];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			expect(groups[0].indices).toEqual([0, 2, 3]);
		});

		it('merges the steps whose line nothing can resolve into ONE landing', () => {
			// Two steps of one file with no coordinate between them: a `.base` view, a
			// PDF, an image — a file with nowhere in it to be. They are the same place,
			// and the newest step is the one that stands for it (see landingKey: this
			// used to keep every such step as its own row, which printed one identical
			// "—" line per visit).
			const entries = [
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B1', t: 1000 } as NavEntry,
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B2', t: 1100 } as NavEntry,
			];
			const groups = groupByFile(entries, 1, undefined, () => undefined);

			// ONE landing, and it is the step the reader is ON: the current entry's own
			// (the newer of the two here).
			expect(groups[0].indices).toEqual([1]);
		});

		it('collapses graph steps to the one tab they are', () => {
			// A pathless view step is not a place in a note: the group is the graph
			// tab, and however often it was switched to it is one destination.
			const entries = [
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 900 } as NavEntry,
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 1000 } as NavEntry,
			];
			const groups = groupByFile(entries, 1, undefined, () => undefined);

			// …and it is the group's ANCHOR rather than a landing under it: a view has
			// no spots inside it, and its own row is the one the reader travels to.
			expect(groups[0].indices).toEqual([]);
			expect(groups[0].anchor).toBe(1);
			expect(groups[0].current).toBe(true);
		});

		it('never merges two notes, however alike their lines are', () => {
			// The collapse is per note, so two notes captured at one line stay two
			// destinations — the resolver is never asked across a group boundary.
			const entries = [at('a.md', 0, 400), at('b.md', 1, 400)];
			const groups = groupByFile(entries, 1, undefined, lineOf(entries));

			expect(groups.map(g => g.indices)).toEqual([[1], [0]]);
		});
	});

	// A HELD ORDER: the sequence the list is showing, handed back to it so a
	// redraw does not re-order what the reader is reading (see RecentFilesList's
	// `order` option). The keys are the groups' identities, not their indices —
	// indices are what the redraw is about to change.
	describe('a held order', () => {
		// Newest LAST, as the places list keeps them: a, b, c is oldest-first, so
		// recency order is the reverse.
		const three = [spot('a.md', 0, 10), spot('b.md', 1, 20), spot('c.md', 2, 30)];

		it('gives every group the key it is held by', () => {
			const entries = [
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 9000 } as NavEntry,
				...three,
			];
			const groups = groupByFile(entries, 0);

			// A file is its path. The graph CANNOT be: its path is the empty
			// NO_PATH, which says it is pathless without saying which view it is.
			expect(groups.map(g => g.key)).toEqual(['c.md', 'b.md', 'a.md', 'view:graph']);
		});

		it('keeps the given sequence, and does NOT pull the current note to the front', () => {
			// The current group is a.md. Recency pins it first (see the test above);
			// a held order must not, because that pin is exactly the jump the reader
			// would see after clicking: the note they clicked is the one that moves.
			const groups = groupByFile(three, 0, undefined, lines(three), ['b.md', 'a.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md', 'c.md']);
			// The reader is still told where they are — the mark is not the order.
			expect(groups.find(g => g.path === 'a.md')?.current).toBe(true);
		});

		it('puts a note the order has never heard of FIRST, and the held ones after it', () => {
			// A group that appeared since the order was taken is by recency the
			// newest place, so it goes to the front — where a newly visited note
			// belongs — while the notes the reader was looking at keep their places.
			const entries = [...three, spot('d.md', 3, 40)];
			const groups = groupByFile(entries, 0, undefined, lines(entries), ['a.md', 'b.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['d.md', 'a.md', 'b.md', 'c.md']);
		});

		it('leaves the notes the order does not name in their own recency order', () => {
			const entries = [...three, spot('d.md', 3, 40)];
			const groups = groupByFile(entries, 0, undefined, lines(entries), ['b.md']);

			// d, c and a are all unheard of, and recency is d, c, a: the sort is
			// stable, so they stay in that order, ahead of the one held note. (In the
			// browser the order held is the whole list, so a group is unheard of only
			// when it has just appeared — see the test above.)
			expect(groups.map(g => g.path)).toEqual(['d.md', 'c.md', 'a.md', 'b.md']);
		});

		it('orders a view group by recency when free, and by the held order when there is one', () => {
			const entries = [
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 9000 } as NavEntry,
				...three,
			];
			const held = groupByFile(entries, 1, undefined, lines(entries), ['view:graph', 'a.md']);
			const free = groupByFile(entries, 1, undefined, lines(entries));

			// Free: recency, and the graph is the OLDEST step here, so it comes last
			// on its own merits — nothing puts it there (see groupByFile).
			expect(free.map(g => g.path)).toEqual(['c.md', 'b.md', 'a.md', '']);
			// Held: the graph is what the order names first, and the notes it never
			// heard of (b, c) go ahead of everything it knows. A held order is the
			// reader's, views included.
			expect(held.map(g => g.path)).toEqual(['c.md', 'b.md', '', 'a.md']);
		});

		it('is recency and nothing else when nothing is held', () => {
			// The regression that keeps the default honest: undefined holds nothing,
			// so the list is the places' own recency — the current note included.
			const groups = groupByFile(three, 0, undefined, lines(three), undefined);

			expect(groups.map(g => g.path)).toEqual(['c.md', 'b.md', 'a.md']);
		});
	});
});

// The browser's filter box: tokens AND-match across everything the entry
// recorded (name, path, the landing context block, the legacy anchors, a
// jump's key, a link's origin) plus the text the ROW prints (the section
// chain and the line label), handed in by the caller. No DOM, and no
// describeNavEntry: the predicate is testable on its own.
describe('matchesNavFilter', () => {
	const visit = (path: string, st?: NavEntryState): NavEntry =>
		({ kind: 'visit', path, leafId: 'leaf-1', st } as NavEntry);

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

	it('matches a pathless view by its type, its own name, and this list\'s wording', () => {
		const e = { kind: 'view', leafId: 'leaf-1', viewType: 'graph' } as NavEntry;
		expect(matchesNavFilter(e, 'graph')).toBe(true);
		expect(matchesNavFilter(e, t('recentFiles.graphView'))).toBe(true);
		expect(matchesNavFilter(e, 'canvas')).toBe(false);

		// A view's own name is searchable too: it is the word a reader who does not
		// know the view TYPE would ever type (see navSearchText).
		const thino = { kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', label: 'Memos' } as NavEntry;
		expect(matchesNavFilter(thino, 'memos')).toBe(true);
		expect(matchesNavFilter(thino, 'thino_view')).toBe(true);
	});

	it('matches the recorded context block, not only the landing line', () => {
		// The block is what the user was looking at when they left (see
		// NavEntryState.context) — the whole point of recording it is that a
		// search may hit any line of it.
		const e = visit('notes/a.md', {
			context: [
				{ line: 10, text: '前一段：换行与量化' },
				{ line: 11, text: '落点这一行' },
				{ line: 12, text: '后一段：读取死区' },
			],
			contextAt: 1,
		});
		expect(matchesNavFilter(e, '读取死区')).toBe(true);
		expect(matchesNavFilter(e, '换行 落点')).toBe(true);
		expect(matchesNavFilter(e, '没写过的词')).toBe(false);
	});

	it('matches what the row prints: the section chain and the line label', () => {
		// Derived from the vault's heading cache rather than the entry, so the
		// caller passes it (see RecentFilesList.render).
		const e = visit('notes/a.md');
		expect(matchesNavFilter(e, '架构设计', 'L412 总览 › 架构设计')).toBe(true);
		expect(matchesNavFilter(e, 'L412', 'L412 总览')).toBe(true);
		expect(matchesNavFilter(e, 'L999', 'L412 总览')).toBe(false);
	});

	it("matches a jump's own key: the heading, or the anchor the user picked", () => {
		const outline = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'outline:## 架构设计' } as NavEntry;
		expect(matchesNavFilter(outline, '架构设计')).toBe(true);
		const link = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'b.md#安装步骤' } as NavEntry;
		expect(matchesNavFilter(link, '安装步骤')).toBe(true);
	});

	it('ignores a caller target key: a timestamp, not words', () => {
		// Caller-target jumps (a search-result click) are keyed `caller:<ms>`
		// purely to take the keyed landing regime — there is nothing in there
		// a user wrote.
		const e = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'caller:1730000000000' } as NavEntry;
		expect(matchesNavFilter(e, '1730000000000')).toBe(false);
	});

	it('matches where a plain link came from, and what it said', () => {
		const e = {
			kind: 'visit', path: 'b.md', leafId: 'l', t: 0,
			via: 'link', viaPath: 'notes/来源笔记.md', viaText: 'b|另见',
		} as NavEntry;
		expect(matchesNavFilter(e, '来源笔记')).toBe(true);
		expect(matchesNavFilter(e, '另见')).toBe(true);
		expect(matchesNavFilter(e, '别的笔记')).toBe(false);
	});
});

describe('folderOf / duplicateNames', () => {
	it('names the folder a path sits in, with the vault root as "/"', () => {
		expect(folderOf('a/b/c.md')).toBe('a/b');
		expect(folderOf('root.md')).toBe('');
		// a pathless group (the graph) has no folder to print
		expect(folderOf('')).toBeUndefined();
	});

	it('reports exactly the names two paths share', () => {
		const doubles = duplicateNames(['a/index.md', 'b/index.md', 'notes.md']);
		expect([...doubles]).toEqual(['index']);
		expect(duplicateNames(['a.md', 'b.md']).size).toBe(0);
	});

	it('counts two files as a collision on the name they both PRINT', () => {
		// The collision is about what is on screen, and what is on screen is the name
		// without its extension: "x.md" and "x.canvas" are one word twice, so the
		// folder is printed on both. (The badge differs — that is what tells them
		// apart once the eye is on the right pair of rows — but two rows reading "x"
		// are still two rows a reader cannot choose between.)
		expect([...duplicateNames(['a/x.md', 'b/x.canvas'])]).toEqual(['x']);
		// …and the extension is not part of the name it is counted by, so one note
		// and one directory-looking name do not collide.
		expect(duplicateNames(['a.md']).size).toBe(0);
	});
});

describe('baseName', () => {
	it('is the last path segment, and the path itself when there is none', () => {
		expect(baseName('notes/deep/a.md')).toBe('a.md');
		expect(baseName('a.md')).toBe('a.md');
	});
});

// What a ROW prints as the note's name (see displayName / badgeOf): the last path
// segment without its extension, and the type said separately. The two are a pair —
// every name printed without an extension is either markdown (no badge) or marked —
// and the rules only close because of that.
describe('displayName / badgeOf', () => {
	it('prints the name without its extension', () => {
		expect(displayName('notes/deep/a.md')).toBe('a');
		expect(displayName('a.md')).toBe('a');
		// The extension is only the LAST one: a name may contain dots of its own.
		expect(displayName('archive.tar.gz')).toBe('archive.tar');
		// …and a LEADING dot is not an extension: that is the whole name.
		expect(displayName('.gitignore')).toBe('.gitignore');
		// A pathless group (the graph) has no name to shorten; the list never asks
		// (its name is the translated view label), and this is what "no path" means.
		expect(displayName('')).toBe('');
	});

	it('marks every type but markdown, and marks the ones with no type too', () => {
		// Markdown has no badge: in a vault it is the unmarked default, and a badge on
		// every row would be a column of noise.
		expect(badgeOf('a.md')).toBeUndefined();
		expect(badgeOf('notes/a.MD')).toBeUndefined();
		// Everything else says what it is.
		expect(badgeOf('report.PDF')).toBe('PDF');
		expect(badgeOf('board.canvas')).toBe('CANVAS');
		// A file with no extension gets a badge anyway, or "no badge" would mean two
		// different things.
		expect(badgeOf('LICENSE')).toBe('FILE');
		expect(badgeOf('.gitignore')).toBe('FILE');
		// A dot in a FOLDER is not an extension in the file.
		expect(badgeOf('notes.v2/readme')).toBe('FILE');
		expect(badgeOf('notes.v2/readme.md')).toBeUndefined();
		// The pathless group is a view, not a file: it has no type.
		expect(badgeOf('')).toBeUndefined();
	});
});

// HOW OLD A ROW IS (see ageOf / ageLabel / newestStamp): the magnitude a reader
// scanning for "where was I" compares rows by, said compactly but in words a reader
// does not have to decode. The list is ALREADY in this order — the label adds the
// scale, not the order — so the boundaries are what matter, and they are what is
// pinned here.
describe('ageOf / ageLabel', () => {
	const at = 1_000_000_000_000;
	const ago = (ms: number) => ageLabel(at, at + ms);
	const SECOND = 1000;
	const MINUTE = 60 * SECOND;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	it('rounds DOWN, so a label never claims more time than has passed', () => {
		expect(ago(59 * SECOND)).toBe('now');
		// …and the unit changes exactly at the boundary, not a moment early.
		expect(ago(60 * SECOND)).toBe('1m ago');
		expect(ago(59 * MINUTE)).toBe('59m ago');
		expect(ago(60 * MINUTE)).toBe('1h ago');
		expect(ago(23 * HOUR)).toBe('23h ago');
		expect(ago(24 * HOUR)).toBe('1d ago');
		expect(ago(6 * DAY)).toBe('6d ago');
		expect(ago(7 * DAY)).toBe('1w ago');
		// Five weeks is where the weeks stop being useful: 4w is the last week label,
		// and a month takes over from there.
		expect(ago(34 * DAY)).toBe('4w ago');
		expect(ago(35 * DAY)).toBe('1mo ago');
		expect(ago(364 * DAY)).toBe('12mo ago');
		expect(ago(365 * DAY)).toBe('1y ago');
		expect(ago(800 * DAY)).toBe('2y ago');
	});

	it('clamps a stamp in the FUTURE to now', () => {
		// A clock that moved backwards — a machine waking from sleep, two devices
		// syncing — must not print "-3m", which reads as a bug in the list rather than
		// as a wrong clock.
		expect(ageLabel(at, at - 3 * MINUTE)).toBe('now');
		expect(ageOf(at, at - 3 * MINUTE)).toEqual({ n: 0, unit: 'now' });
	});

	it('says the number, the unit and "ago", and nothing else', () => {
		// The unit is the LOCALE's word for it (the test stub is English, see
		// obsidian-stub.ts), and the label stays a scan target: no date, no parentheses.
		expect(ageOf(at, at + 90 * MINUTE)).toEqual({ n: 1, unit: 'h' });
		expect(ageLabel(at, at + 90 * MINUTE)).toBe('1h ago');
	});
});

describe('newestStamp', () => {
	const entry = (stamp?: number) => ({ kind: 'visit', path: 'a.md', leafId: 'l', t: stamp } as NavEntry);

	it('is the newest stamp the group holds, wherever it sits', () => {
		// The anchor is usually the note's last visit, but it can have been evicted
		// while the jumps made inside the note survive — and a group's `indices` are in
		// LINE order, not in time order (see groupByFile), so the answer is a question
		// about all of them.
		const entries = [entry(10), entry(40), entry(30)];
		expect(newestStamp(entries, [2], 0)).toBe(30);
		// …and with no anchor at all it still answers.
		expect(newestStamp(entries, [0, 1], undefined)).toBe(40);
	});

	it('is undefined for a group with no stamp at all', () => {
		// The rows print nothing then, rather than "now" — which is what a missing
		// stamp would otherwise read as.
		expect(newestStamp([entry(undefined)], [], 0)).toBeUndefined();
		expect(newestStamp([], [], undefined)).toBeUndefined();
		// A record that is not there contributes nothing (and does not throw): the
		// anchor and an index can both name a place the list has since dropped.
		expect(newestStamp([entry(5)], [7, 0], 7)).toBe(5);
	});
});

// The section a landing sits in: the coarse index a reader scans by, and the
// reason a row can name it without reading the file it is in — the parsed
// headings are enough.
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
		expect(rowTrail(['A', 'B', 'C'])).toEqual(['B', 'C']);
		expect(rowTrail(['A'])).toEqual(['A']);
	});

	it('keeps the heading the landing line itself carries', () => {
		// an outline jump lands ON its heading: that heading IS the deepest
		// level, and the row prints no landing text to repeat it with (only the
		// preview panel does) — dropping it left the row naming the PARENT
		// section, which is the one level a reader cannot place the spot by.
		expect(rowTrail(['A', 'B', '决策'])).toEqual(['B', '决策']);
	});
});

describe('revealDelta', () => {
	// A row of 28px in a list 200px tall, from y=100 to y=300: the middle a row is
	// brought to when it is not on the list is 100 + (200 - 28) / 2 = 186.
	const box = { top: 100, height: 200 };

	it('asks for no scroll while any part of the row is on the list', () => {
		// Hovering a row must never move the view the reader is reading from, and a
		// step inside the list must not move it either — including the row flush
		// against the foot of the list.
		expect(revealDelta(150, 28, box.top, box.height)).toBeUndefined();
		expect(revealDelta(100, 28, box.top, box.height)).toBeUndefined();
		expect(revealDelta(272, 28, box.top, box.height)).toBeUndefined();
	});

	it('brings a row that left the list to the MIDDLE of it, whichever way it left', () => {
		// Not the smallest scroll that returns the row to sight: that would park it
		// flush against the edge, and the walk would then scroll the list under a mark
		// that never moves again.
		expect(revealDelta(320, 28, box.top, box.height)).toBe(134); // 320 → the middle
		expect(revealDelta(60, 28, box.top, box.height)).toBe(-126); // …and from above
	});

	it('centres a row taller than the list rather than trying to fit it', () => {
		// The rule is about the row's middle, and a row the list cannot hold has no
		// scroll that fits it: the middle is the one place that shows the most of it.
		expect(revealDelta(0, 200, 0, 100)).toBe(50);
	});
});
