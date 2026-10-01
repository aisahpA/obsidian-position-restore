// Tests for the recent-files browser's pure pieces (src/recent-files/browser/):
// row description, tree grouping/merging, filtering and section chains. The DOM
// stays untested here; everything whose correctness a reader would doubt is pure.

import { describe, it, expect } from 'vitest';

import {
	describeNavEntry, rowTrail, dropsOuterLevel, baseName,
	badgeOf, displayName,
	duplicateNames, folderOf, pathLabel, ageLabel, ageOf, newestStamp,
} from '@/recent-files/browser/model';
import { groupByFile, matchesNavFilter, matchedContextLine } from '@/recent-files/browser/listing';
import { revealDelta } from '@/recent-files/browser/list';
import { headingTrailAtLine, headingsFromText } from '@/shared/headings';
import { t } from '@/i18n';
import { NavEntry } from '@/nav/entry';
import { NavEntryState } from '@/types';

const line = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });
// The lines capture recorded BELOW a landing, as capture writes them.
const block = (lines: string[]): NavEntryState => ({ context: lines });

describe('describeNavEntry', () => {
	it('一条文件步显示它的名字，不带扩展名', () => {
		// "meeting-notes.md" is the note "meeting-notes": the suffix is not part of
		// what a reader calls it, and a vault of markdown would print the same two
		// characters on every row (see displayName).
		const d = describeNavEntry({ kind: 'visit', path: 'notes/project/a.md', leafId: 'leaf-1' } as NavEntry);
		expect(d.name).toBe('a');
		expect(d.line).toBeUndefined();
		expect(d.lineIndex).toBeUndefined();
	});

	it('jump 的标题行从它自己的 KEY 读，而不是从它记录的位置读', () => {
		// Every landing either list keeps was a heading jump, and the key's line is that
		// heading as metadataCache placed it (see NavJump.keyLine) — authoritative where a
		// scroll is a viewport top and a cursor is wherever the reader last clicked.
		const d = describeNavEntry({
			kind: 'jump', path: 'a.md', leafId: 'l', key: 'outline:## H', keyLine: 17,
			st: { scroll: 42, cursor: line(99) },
		} as NavEntry);
		expect(d.line).toBe('L18');
		// the same landing as a 0-based index: what the list keys a spot by, and what
		// the section chain is looked up against
		expect(d.lineIndex).toBe(17);
	});

	it('其它那种步的标题行从它记录的位置读', () => {
		// Nothing structural to answer from: a teleport, whose own target line is the jump's,
		// and a jump whose target has since been renamed away. The words recorded below the
		// landing say nothing about where anything stands.
		const edit = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
			st: { scroll: 42, cursor: line(99), anchor: 'viewport top', ...block(['x', 'y', 'z']) },
		} as NavEntry);
		// the recorded viewport top, not the cursor
		expect(edit.line).toBe('L43');
		expect(edit.lineIndex).toBe(42);
	});

	it('跳变一直没有落地时，退回记录下来的目标行', () => {
		const d = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
		} as NavEntry);
		expect(d.line).toBe('L42');
	});

	it('没有引文的位置状态退回视口顶行', () => {
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

	it('既没有光标也没有引文，仍然显示视口那一行', () => {
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, anchor: 'viewport top' },
		} as NavEntry);
		expect(d.line).toBe('L42');
	});

	it('笔记按读者自己配的属性来称呼，没配就用文件名', () => {
		// `titleOf` is the vault's answer, not this model's: one property the reader
		// named in the settings (see reads.ts). Its UNDEFINED is the file name's
		// turn rather than an absence — a note without the property is not nameless.
		const entry = { kind: 'visit', path: 'notes/a.md', leafId: 'leaf-1' } as NavEntry;
		const named = describeNavEntry(entry, undefined, () => '每周回顾');
		expect(named.name).toBe('每周回顾');
		// …and the coordinate is the same question as ever, answered the same way.
		expect(named.line).toBeUndefined();

		const plain = describeNavEntry(entry, undefined, () => undefined);
		expect(plain.name).toBe('a');
		// No reader of a name at all is the ordinary case: it is what the model did
		// before this existed.
		expect(describeNavEntry(entry).name).toBe('a');
	});

	it('连自己名字都没有的无路径视图退回兜底，并且不带行号', () => {
		const graph = describeNavEntry({ kind: 'view', viewType: 'graph', leafId: 'leaf-1' } as NavEntry);
		expect(graph.name).toBe(t('recentFiles.graphView'));
		expect(graph.line).toBeUndefined();
		expect(graph.lineIndex).toBeUndefined();
	});

	it('视图按它自己的标签取名，没有标签的退回兜底', () => {
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

	it('没有记录位置的步，退回文件层存的那一条', () => {
		const d = describeNavEntry(
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1' } as NavEntry,
			() => ({ scroll: 41, cursor: line(99) }),
		);
		// the saved cursor line is the spot a reopen restores
		expect(d.line).toBe('L100');
	});

	it('记录里没有光标时退回存下来的顶行', () => {
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

	it('同一篇笔记的步聚成一组，组内最新的在前，笔记之间按新旧排', () => {
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

	it('读者所在的那篇按它的新旧排，不拎到前面', () => {
		// "You are here" is a mark on a row (see NavFileGroup.current), never a place
		// in the order: a.md is the note being read and the OLDER of the two, so it
		// stays where its own time puts it — second.
		const entries = [spot('a.md', 0, 10), spot('b.md', 1, 20)];
		const groups = groupByFile(entries, 0);

		expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md']);
		expect(groups[1].current).toBe(true);
		expect(groups[0].current).toBe(false);
	});

	it('当前这篇里没有一样东西能通过筛选时，把它整组丢掉', () => {
		// `keep` is the query. A note with no surviving step is not this list's
		// business, current or not; the empty-group case is the one where the note
		// is there but has nothing left to open.
		const entries = [spot('a.md', 0, 10), spot('b.md', 1, 20)];
		const groups = groupByFile(entries, 1, i => i === 0);

		expect(groups.map(g => g.path)).toEqual(['a.md']);
	});

	it('无路径视图步（关系图谱）按它自己的时间排，跟笔记一样', () => {
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
	describe('每个标题各占一行', () => {
		const at = (path: string, i: number, line: number): NavEntry =>
			({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
		const lineOf = (entries: NavEntry[]) => (i: number) => {
			const entry = entries[i];
			return entry.kind === 'view' ? undefined : entry.st?.scroll;
		};

		it('相隔几行的几个落点各占一行，顺着笔记往下排', () => {
			const entries = [at('a.md', 0, 10), at('a.md', 1, 18), at('a.md', 2, 26)];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			// Three spots eight lines apart, three rows — L11 before L19 before L27, not in
			// the order they were visited (see groupByFile) — and each one is the step a
			// click on it lands on.
			expect(groups[0].indices).toEqual([0, 1, 2]);
		});

		it('一行由它最新的那一步代表，读者自己那一步优先', () => {
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

		it('标记读者所在的那一行，没有任何标题兜住他时一个也不标', () => {
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

		it('自身没有行号的那个标题，与有行号的那些分开摆', () => {
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
	describe('一个标题，无论有多少步到过它', () => {
		const at = (path: string, i: number, line: number): NavEntry =>
			({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
		const lineOf = (entries: NavEntry[]) => (i: number) => {
			const entry = entries[i];
			return entry.kind === 'view' ? undefined : entry.st?.scroll;
		};

		it('每行一行、按行号排序，在组里只占一个槽位', () => {
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

		it('由当前那一步代表它同在的这个标题', () => {
			// The current entry has to be drawn as "here", and it can be an OLDER
			// step than the one it shares its landing with: the slot keeps the
			// reader's own step rather than a newer one that goes to the same place.
			const entries = [at('a.md', 0, 10), at('a.md', 1, 400), at('a.md', 2, 400)];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			expect(groups[0].indices).toEqual([0, 2]);
			expect(groups[0].current).toBe(true);
		});

		it('行号谁都答不出来的那些步排在最后，它们那一行写「—」', () => {
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

		it('行号谁都答不出来的那些步合并成一个标题', () => {
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

		it('同一个标签页上的图谱步坍成一个', () => {
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

		it('两篇笔记绝不合并，无论它们的行有多像', () => {
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
	describe('一个被按住的顺序', () => {
		// Newest LAST, as the places list keeps them: a, b, c is oldest-first, so
		// recency order is the reverse.
		const three = [spot('a.md', 0, 10), spot('b.md', 1, 20), spot('c.md', 2, 30)];

		it('每个组都拿到它被按住所用的那个键', () => {
			const entries = [
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 9000 } as NavEntry,
				...three,
			];
			const groups = groupByFile(entries, 0);

			// A file is its path. The graph CANNOT be: its path is the empty
			// NO_PATH, which says it is pathless without saying which view it is.
			expect(groups.map(g => g.key)).toEqual(['c.md', 'b.md', 'a.md', 'view:graph']);
		});

		it('保持给定的先后，不把当前这篇拽到最前面', () => {
			// The current group is a.md. Recency pins it first (see the test above);
			// a held order must not, because that pin is exactly the jump the reader
			// would see after clicking: the note they clicked is the one that moves.
			const groups = groupByFile(three, 0, undefined, lines(three), ['b.md', 'a.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md', 'c.md']);
			// The reader is still told where they are — the mark is not the order.
			expect(groups.find(g => g.path === 'a.md')?.current).toBe(true);
		});

		it('这个顺序没听过的笔记排最前，被按住的那些排在它后面', () => {
			// A group that appeared since the order was taken is by recency the
			// newest place, so it goes to the front — where a newly visited note
			// belongs — while the notes the reader was looking at keep their places.
			const entries = [...three, spot('d.md', 3, 40)];
			const groups = groupByFile(entries, 0, undefined, lines(entries), ['a.md', 'b.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['d.md', 'a.md', 'b.md', 'c.md']);
		});

		it('顺序里没点名的笔记按它们自己的新旧排', () => {
			const entries = [...three, spot('d.md', 3, 40)];
			const groups = groupByFile(entries, 0, undefined, lines(entries), ['b.md']);

			// d, c and a are all unheard of, and recency is d, c, a: the sort is
			// stable, so they stay in that order, ahead of the one held note. (In the
			// browser the order held is the whole list, so a group is unheard of only
			// when it has just appeared — see the test above.)
			expect(groups.map(g => g.path)).toEqual(['d.md', 'c.md', 'a.md', 'b.md']);
		});

		it('视图组没被按住时按新旧排，被按住时按给定顺序排', () => {
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

		it('什么都没按住时就只看新旧，别的都不算', () => {
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

	it('空串或只有空白的查询匹配一切', () => {
		expect(matchesNavFilter(visit('notes/a.md'), '')).toBe(true);
		expect(matchesNavFilter(visit('notes/a.md'), '   ')).toBe(true);
	});

	it('文件名、完整路径、锚点文本都参与匹配，不分大小写', () => {
		const e = visit('notes/project/Alpha.md', { anchor: 'Chapter One' });
		expect(matchesNavFilter(e, 'alpha')).toBe(true);
		expect(matchesNavFilter(e, 'PROJECT')).toBe(true);
		expect(matchesNavFilter(e, 'chapter')).toBe(true);
		expect(matchesNavFilter(e, 'beta')).toBe(false);
	});

	it('每个用空白分开的词都得命中（AND）', () => {
		const e = visit('notes/project/Alpha.md', { anchor: 'Chapter One' });
		expect(matchesNavFilter(e, 'alpha chapter')).toBe(true);
		expect(matchesNavFilter(e, 'alpha missing')).toBe(false);
	});

	it('无路径视图按它的类型、它自己的名字、以及本列表的措辞参与匹配', () => {
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

	it('记录下来的引文，任意一行命中就算', () => {
		// The lines below the landing are what the user was looking at when they left
		// (see NavEntryState.context) — the whole point of recording them is that a
		// search may hit any one of them.
		const e = visit('notes/a.md', {
			context: ['前一段：换行与量化', '落点这一行', '后一段：读取死区'],
		});
		expect(matchesNavFilter(e, '读取死区')).toBe(true);
		expect(matchesNavFilter(e, '换行 落点')).toBe(true);
		expect(matchesNavFilter(e, '没写过的词')).toBe(false);
	});

	it('匹配这一行印出来的东西：标题链和行号标签', () => {
		// Derived from the vault's heading cache rather than the entry, so the
		// caller passes it (see RecentFilesList.render).
		const e = visit('notes/a.md');
		expect(matchesNavFilter(e, '架构设计', 'L412 总览 › 架构设计')).toBe(true);
		expect(matchesNavFilter(e, 'L412', 'L412 总览')).toBe(true);
		expect(matchesNavFilter(e, 'L999', 'L412 总览')).toBe(false);
	});

	it("匹配 jump 自己的 key：那个标题，或者用户点中的锚点", () => {
		const outline = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'outline:## 架构设计' } as NavEntry;
		expect(matchesNavFilter(outline, '架构设计')).toBe(true);
		const link = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'b.md#安装步骤' } as NavEntry;
		expect(matchesNavFilter(link, '安装步骤')).toBe(true);
	});

	it('visit 没有引文时，光靠锚点也能匹配', () => {
		// A visit records no context (see readNavEntryState): the one piece of the NOTE's
		// own text it carries is the anchor — the line that stood at the viewport top. So
		// a reader who searches a sentence they were reading finds the note, and what
		// matched is a line no row prints.
		const e = visit('notes/a.md', { anchor: '落点这一行' });
		expect(matchesNavFilter(e, '落点')).toBe(true);
	});

	it('忽略调用方传来的目标 key：那是一串时间戳，不是词', () => {
		// Caller-target jumps (a search-result click) are keyed `caller:<ms>`
		// purely to take the keyed landing regime — there is nothing in there
		// a user wrote.
		const e = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'caller:1730000000000' } as NavEntry;
		expect(matchesNavFilter(e, '1730000000000')).toBe(false);
	});

});

describe('matchedContextLine', () => {
	const jump = (st?: NavEntryState): NavEntry =>
		({ kind: 'jump', path: 'a.md', leafId: 'l', key: 'outline:## H', st } as NavEntry);
	const visit = (path: string, st?: NavEntryState): NavEntry =>
		({ kind: 'visit', path, leafId: 'leaf-1', st } as NavEntry);
	const ctx = jump(block(['前一段：换行与量化', '落点这一行', '后一段：读取死区']));

	it('就是容得下整个查询的那一行', () => {
		expect(matchedContextLine(ctx, '读取死区')).toBe('后一段：读取死区');
		// A phrase standing on one line, which is what a reader usually types.
		expect(matchedContextLine(ctx, '后一段 死区')).toBe('后一段：读取死区');
	});

	it('几个词散落在引文各处时，退回第一个词所在的那一行', () => {
		// The filter matched the block joined together (see matchesNavFilter), so
		// no single line carries the query — and a row that then said nothing
		// would be a row that matched by magic.
		expect(matchedContextLine(ctx, '量化 死区')).toBe('前一段：换行与量化');
	});

	it('查询一个词也没落在引文里时是 undefined', () => {
		// A row may match on its name, its path, an alias or its section, and
		// every one of those is either printed on the row or said on hover
		// already.
		expect(matchedContextLine(ctx, '没写过的词')).toBeUndefined();
		expect(matchedContextLine(ctx, '')).toBeUndefined();
		expect(matchedContextLine(ctx, '   ')).toBeUndefined();
		expect(matchedContextLine(jump(), '落点')).toBeUndefined();
	});

	it('不分大小写，跟匹配它的那个筛选一致', () => {
		const e = jump(block(['Alpha Beta', 'gamma']));
		expect(matchedContextLine(e, 'ALPHA')).toBe('Alpha Beta');
	});

	it('靠锚点才匹配上的 visit，一句也不引', () => {
		// THE CASE A READER MEETS: the row is on the list because the query matched the
		// anchor (see the filter suite above), and the block — the only thing this answer
		// reads — is what a visit does not carry. So the row matches and quotes nothing.
		// Locked as it stands: the anchor is the line the restore re-finds, not a line a
		// row shows, and a quote of it would claim a landing the reader never asked for.
		const e = visit('notes/a.md', { anchor: '落点这一行' });
		expect(matchesNavFilter(e, '落点')).toBe(true);
		expect(matchedContextLine(e, '落点')).toBeUndefined();
	});

	it('带引文的 visit 照样引：看的是有没有引文，不是这一步的类型', () => {
		// What withholds the quote is the ABSENT BLOCK, not the kind — a visit handed one
		// is quoted like any landing. The distinction is what keeps the case above from
		// hardening into "a visit never quotes".
		const e = visit('notes/a.md', { anchor: '落点这一行', ...block(['前一段：换行与量化']) });
		expect(matchedContextLine(e, '量化')).toBe('前一段：换行与量化');
	});
});

describe('folderOf / duplicateNames', () => {
	it('给出路径所在的文件夹，vault 根就是 "/"', () => {
		expect(folderOf('a/b/c.md')).toBe('a/b');
		expect(folderOf('root.md')).toBe('');
		// a pathless group (the graph) has no folder to print
		expect(folderOf('')).toBeUndefined();
	});

	// What it counts is the names as PRINTED, which the caller has already
	// resolved: a name may come from the file or from the property the reader
	// named, and which it was is not this question.
	it('报出来的正是那两个被重复印的名字', () => {
		const doubles = duplicateNames(['index', 'index', 'notes']);
		expect([...doubles]).toEqual(['index']);
		expect(duplicateNames(['a', 'b']).size).toBe(0);
	});

	it('两行印出同一个名字就算撞名', () => {
		// The collision is about what is on screen, and what is on screen is the name
		// without its extension: "x.md" and "x.canvas" are one word twice, so the
		// folder is printed on both. (The badge differs — that is what tells them
		// apart once the eye is on the right pair of rows — but two rows reading "x"
		// are still two rows a reader cannot choose between.)
		expect([...duplicateNames(['x', 'x'])]).toEqual(['x']);
		// …and two notes that print different names do not collide, however
		// their files are called.
		expect(duplicateNames(['a']).size).toBe(0);
	});
});

describe('baseName', () => {
	it('取路径最后一段；没有分段时就是路径本身', () => {
		expect(baseName('notes/deep/a.md')).toBe('a.md');
		expect(baseName('a.md')).toBe('a.md');
	});
});

// The line that says WHERE a note sits, which is also the line that says WHICH FILE it is —
// the two are answered together or not at all (see PathDisplayMode).
describe('pathLabel', () => {
	it('没有路径的组一个字也不印', () => {
		// A view has no file and prints no folder; the list never asks (see fileRow's own
		// guard), and this is what "no path" means rather than an error.
		expect(pathLabel('', 'Graph view')).toBe('');
	});

	it('行自己的名字就是文件名时，印的是文件夹', () => {
		expect(pathLabel('notes/deep/a.md', 'a')).toBe('notes/deep/');
		// Root included: "/" rather than nothing, which would read as "not printed".
		expect(pathLabel('a.md', 'a')).toBe('/');
	});

	it('名字是借来的（取自属性）时，印出完整路径', () => {
		// The row's name cell is then singing the note's frontmatter, so the folder alone
		// would leave a row that says nothing about which note it stands for.
		expect(pathLabel('notes/deep/a.md', '每周回顾')).toBe('notes/deep/a.md');
		expect(pathLabel('a.md', '每周回顾')).toBe('a.md');
	});
});

// What a ROW prints as the note's name (see displayName / badgeOf): the last path
// segment without its extension, and the type said separately. The two are a pair —
// every name printed without an extension is either markdown (no badge) or marked —
// and the rules only close because of that.
describe('displayName / badgeOf', () => {
	it('印出不带扩展名的名字', () => {
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

	it('除 markdown 之外的每种类型都加标记，没有类型的也加', () => {
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

	it('一律向下取整，标签不会说出比实际更长的时间', () => {
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

	it('戳落在未来就夹到「现在」', () => {
		// A clock that moved backwards — a machine waking from sleep, two devices
		// syncing — must not print "-3m", which reads as a bug in the list rather than
		// as a wrong clock.
		expect(ageLabel(at, at - 3 * MINUTE)).toBe('now');
		expect(ageOf(at, at - 3 * MINUTE)).toEqual({ n: 0, unit: 'now' });
	});

	it('只说数字、单位和「前」，别的什么都不说', () => {
		// The unit is the LOCALE's word for it (the test stub is English, see
		// obsidian-stub.ts), and the label stays a scan target: no date, no parentheses.
		expect(ageOf(at, at + 90 * MINUTE)).toEqual({ n: 1, unit: 'h' });
		expect(ageLabel(at, at + 90 * MINUTE)).toBe('1h ago');
	});
});

describe('newestStamp', () => {
	const entry = (stamp?: number) => ({ kind: 'visit', path: 'a.md', leafId: 'l', t: stamp } as NavEntry);

	it('取这一组里最新的那个戳，不管它落在哪一步上', () => {
		// The anchor is usually the note's last visit, but it can have been evicted
		// while the jumps made inside the note survive — and a group's `indices` are in
		// LINE order, not in time order (see groupByFile), so the answer is a question
		// about all of them.
		const entries = [entry(10), entry(40), entry(30)];
		expect(newestStamp(entries, [2], 0)).toBe(30);
		// …and with no anchor at all it still answers.
		expect(newestStamp(entries, [0, 1], undefined)).toBe(40);
	});

	it('一组连一个戳都没有时是 undefined', () => {
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

	it('按层级嵌套，最外层在前，到那一行为止', () => {
		const headings = [h('A', 1, 0), h('B', 2, 10), h('C', 3, 20), h('D', 2, 30)];
		expect(headingTrailAtLine(headings, 25)).toEqual(['A', 'B', 'C']);
		expect(headingTrailAtLine(headings, 10)).toEqual(['A', 'B']);
		// a same-or-shallower heading closes the deeper ones
		expect(headingTrailAtLine(headings, 35)).toEqual(['A', 'D']);
	});

	it('第一个标题之上、以及全文没有标题时都是空', () => {
		expect(headingTrailAtLine([h('A', 1, 5)], 4)).toEqual([]);
		expect(headingTrailAtLine(undefined, 4)).toEqual([]);
	});
});

// …and the same reading taken out of the note's own text, which is where a row gets
// its chain when the metadata cache has nothing to say about the note (see reads.ts):
// a sync replaced it, or the app has not re-parsed it, and on a phone neither ends
// when the note is opened.
describe('headingsFromText', () => {
	it('读出 ATX 标题以及它所在的那一行', () => {
		expect(headingsFromText('# 面板设计\n\n## 呈现方案\n\n正文\n'))
			.toEqual([
				{ heading: '面板设计', level: 1, line: 0 },
				{ heading: '呈现方案', level: 2, line: 2 },
			]);
	});

	it('命名与 metadata 缓存给出的那一节相同', () => {
		// The point of the fallback: it has to be the SAME reading, or a row would say
		// one thing while the app had not parsed the note and another once it had.
		const text = '# A\n\n## B\n\n正文\n\n### C\n';
		expect(headingsFromText(text)).toEqual([
			{ heading: 'A', level: 1, line: 0 },
			{ heading: 'B', level: 2, line: 2 },
			{ heading: 'C', level: 3, line: 6 },
		]);
		expect(headingTrailAtLine(headingsFromText(text), 4)).toEqual(['A', 'B']);
	});

	it('标签、注释、属性值里读不出标题', () => {
		// `#标签` is one of the app's TAGS; a `#` inside a fence is a line of somebody's
		// shell; `title: # 1` is a frontmatter VALUE. All three were sections to a
		// reading that split on `#`, and the row would have named a section that is not
		// there — worse than naming none.
		expect(headingsFromText('#标签\n')).toEqual([]);
		expect(headingsFromText('```bash\n# 安装\n```\n')).toEqual([]);
		expect(headingsFromText('---\ntitle: # 1\n---\n# 真的标题\n'))
			.toEqual([{ heading: '真的标题', level: 1, line: 3 }]);
	});

	it('闭式标题收掉结尾那几个标记，只有开头标记的那种跳过', () => {
		expect(headingsFromText('## 一 ##\n#\n'))
			.toEqual([{ heading: '一', level: 2, line: 0 }]);
	});
});

describe('rowTrail', () => {
	it('只留最深的两层', () => {
		expect(rowTrail(['A', 'B', 'C'])).toEqual(['B', 'C']);
		expect(rowTrail(['A'])).toEqual(['A']);
	});

	it('保留落点所在行自身带着的那个标题', () => {
		// an outline jump lands ON its heading: that heading IS the deepest
		// level, and the row prints no landing text to repeat it with (only the
		// preview panel does) — dropping it left the row naming the PARENT
		// section, which is the one level a reader cannot place the spot by.
		expect(rowTrail(['A', 'B', '决策'])).toEqual(['B', '决策']);
	});
});

describe('dropsOuterLevel', () => {
	// The widths are a real row's, read off a laid-out one: what the outer level asks
	// for (`whole`) against what the row could give it (`shown`).
	it('放得下的那层留着，被裁掉一两个字的也留着', () => {
		expect(dropsOuterLevel(80, 80)).toBe(false);
		// "面板设计与信息架…" still says which section it is
		expect(dropsOuterLevel(72, 80)).toBe(false);
		// exactly half is the line, and the half that survived is still readable
		expect(dropsOuterLevel(40, 80)).toBe(false);
	});

	it('连一半都没剩下的那层丢掉', () => {
		// "新插件 Positi…" names no section, and the level beside it takes the width it
		// needs whether this one is on the row or not (see styles.css)
		expect(dropsOuterLevel(39, 80)).toBe(true);
		// …and a level the collapse has already squeezed to nothing
		expect(dropsOuterLevel(0, 80)).toBe(true);
	});

	it('还没排过版的行，它那一层留着', () => {
		// A row with no layout reports no width for either question, and a level that
		// reports nothing has not been clipped — it has not been measured. (The panel
		// guards on the LIST's width before it asks at all; this is the answer for a
		// level the collapse never touched.)
		expect(dropsOuterLevel(0, 0)).toBe(false);
	});
});

describe('revealDelta', () => {
	// A row of 28px in a list 200px tall, from y=100 to y=300: the middle a row is
	// brought to when it is not on the list is 100 + (200 - 28) / 2 = 186.
	const box = { top: 100, height: 200 };

	it('行只要还有一部分在列表里，就一个像素也不滚', () => {
		// Hovering a row must never move the view the reader is reading from, and a
		// step inside the list must not move it either — including the row flush
		// against the foot of the list.
		expect(revealDelta(150, 28, box.top, box.height)).toBeUndefined();
		expect(revealDelta(100, 28, box.top, box.height)).toBeUndefined();
		expect(revealDelta(272, 28, box.top, box.height)).toBeUndefined();
	});

	it('离开列表的行被带回列表中间，不管它是从哪一边离开的', () => {
		// Not the smallest scroll that returns the row to sight: that would park it
		// flush against the edge, and the walk would then scroll the list under a mark
		// that never moves again.
		expect(revealDelta(320, 28, box.top, box.height)).toBe(134); // 320 → the middle
		expect(revealDelta(60, 28, box.top, box.height)).toBe(-126); // …and from above
	});

	it('比列表还高的行让它居中，而不是硬塞进去', () => {
		// The rule is about the row's middle, and a row the list cannot hold has no
		// scroll that fits it: the middle is the one place that shows the most of it.
		expect(revealDelta(0, 200, 0, 100)).toBe(50);
	});
});
