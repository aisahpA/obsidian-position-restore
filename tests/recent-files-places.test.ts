// Tests for the RECENT FILES list (recent-files/places.ts + places-store.ts): the
// store the panel draws and travels through, and which the stack feeds.
//
// What is being pinned here is the separation the feature is built on: a place is
// not a stack step. A place list never truncates, dedupes by place instead of by
// step, drops inferred moves (teleports) entirely, keeps no position for a FILE
// (the position database owns "where I left this file"), and keeps its own for a
// JUMP (the one spot nothing else records).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, TFile } from 'obsidian';

import { NavPlaces, placeKey } from '@/recent-files/places';
import { RECENT_PLACES_VERSION } from '@/recent-files/places-store';
import { NavEntry, NavJump, NavTeleport, NavVisit } from '@/nav/entry';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

const STORAGE_KEY = 'position-restore:nav-recent:test-vault';

function makeApp(): App {
	return {
		appId: 'test-vault',
		vault: {
			configDir: '.obsidian',
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
		},
	} as unknown as App;
}

// A vault whose notes carry frontmatter: the list's own property rule reads the
// metadata cache (see shared/frontmatter.ts), and that is the only part of the
// app it asks — everything else is still the bare stub above. A path absent from
// `props` answers like a file the cache has not parsed yet.
function makeAppWithFrontmatter(props: Record<string, Record<string, unknown>>): App {
	return {
		...makeApp(),
		metadataCache: {
			getFileCache: (file: TFile) => {
				const fm = props[file.path];
				return fm ? { frontmatter: fm } : null;
			},
		},
	} as unknown as App;
}

function makeSettings(over: Partial<PluginSettings> = {}): PluginSettings {
	return { ...DEFAULT_SETTINGS, ...over } as PluginSettings;
}

// The open pipeline, in miniature: what a travel asked for, and the order.
function openers() {
	const calls: string[] = [];
	return {
		calls,
		open: {
			openFile: async (path: string, leafId: string) => { calls.push(`file:${path}@${leafId}`); },
			openJump: async (entry: NavEntry) => { calls.push(`jump:${placeKey(entry)}`); },
			openView: async (entry: NavEntry) => { calls.push(`view:${placeKey(entry)}`); },
		},
	};
}

// The harness picks the MIDDLE stop of the landings setting, against the
// shipped default of 'none' (see LandingsMode): most of this file is about what
// a LANDING is, and the bottom stop would refuse every one of them before the
// assertion was reached. The default itself is held by one test of its own
// below rather than by every other test in the file.
function makePlaces(settings: Partial<PluginSettings> = {}, app = makeApp()) {
	const places = new NavPlaces(app, makeSettings({ recentFilesLandings: 'last', ...settings }));
	const opened = openers();
	places.attach(opened.open);
	return { places, calls: opened.calls, app };
}

const visit = (path: string, leafId = 'leaf-1'): NavVisit =>
	({ kind: 'visit', path, leafId, t: 0 });
const jump = (path: string, key: string, leafId = 'leaf-1'): NavJump =>
	({ kind: 'jump', path, leafId, key, t: 0 });
const teleport = (path: string, line: number, leafId = 'leaf-1'): NavTeleport =>
	({ kind: 'teleport', path, leafId, line, t: 0 });
const view = (viewType = 'graph', leafId = 'leaf-1'): NavEntry =>
	({ kind: 'view', leafId, viewType, t: 0 });

const paths = (places: NavPlaces) => places.entries.map(e => placeKey(e));

beforeEach(() => {
	window.localStorage.clear();
});

describe('NavPlaces — what a place is', () => {
	it('keeps one record per file, moved to the end when revisited', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(visit('a.md'));

		// One record per file — a file opened ten times is one row — and the array IS
		// the MRU order (the panel reads an index as a clock, see list.ts's activeRep).
		expect(paths(places)).toEqual(['b.md', 'a.md']);
	});

	it('re-stamps the visit time instead of duplicating the place', () => {
		const { places } = makePlaces();
		const spy = vi.spyOn(Date, 'now').mockReturnValue(1000);
		try {
			places.remember(visit('a.md'));
			spy.mockReturnValue(2000);
			places.remember(visit('a.md'));
		} finally {
			spy.mockRestore();
		}

		expect(places.entries).toHaveLength(1);
		expect(places.entries[0].t).toBe(2000);
	});

	it('drops an inferred step (a teleport) entirely', () => {
		// The sampler's heuristic is not a place the reader chose, and it was the
		// reason the list needed a second eviction tier (see places.ts).
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(teleport('a.md', 500));

		expect(paths(places)).toEqual(['a.md']);
	});

	it('keeps a file place without a position, and a jump place with one', () => {
		const { places } = makePlaces();
		places.remember({ ...visit('a.md'), st: { scroll: 120 } } as NavVisit);
		places.remember({ ...jump('a.md', 'outline:## T'), st: { scroll: 7 } } as NavJump);

		// The FILE place keeps no position of its own: the position database owns
		// "where I left this file", and a second copy here would make the panel's line
		// and the plain open disagree.
		const file = places.entries.find(e => e.kind === 'visit') as NavVisit;
		expect(file.st).toBeUndefined();
		// …while a jump's landing exists nowhere else, and its row promises it.
		const j = places.entries.find(e => e.kind === 'jump') as NavJump;
		expect(j.st).toEqual({ scroll: 7 });
	});

	it('takes a settled landing onto the jump place, upgrading the key with it', () => {
		const { places } = makePlaces();
		places.remember({ ...jump('a.md', 'outline:T') } as NavJump);

		places.settle({
			...jump('a.md', 'outline:## T'), keyLine: 12, st: { scroll: 3 },
		} as NavJump);

		const j = places.entries[0] as NavJump;
		expect(j.key).toBe('outline:## T');
		expect(j.keyLine).toBe(12);
		expect(j.st).toEqual({ scroll: 3 });
		// The rendered form and the authoritative source form are ONE place, not two:
		// identity normalizes the hashes away (see placeKey).
		expect(places.entries).toHaveLength(1);
	});

	it('finds a jump place recorded in its rendered form after the key was upgraded', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## T'));
		places.remember(jump('a.md', 'outline:T'));

		expect(places.entries).toHaveLength(1);
	});

	it('keeps a pathless view as one place of its own', () => {
		const { places } = makePlaces();
		places.remember(view('graph'));
		places.remember(visit('a.md'));

		expect(paths(places)).toEqual(['view:graph', 'a.md']);
	});

	it('keeps the view\'s own name, refreshed by every visit', () => {
		// The label is not part of a place's IDENTITY — that is the view type (see
		// placeKey), and two Thino tabs are one destination. It is what the row
		// PRINTS, and it is taken from the recording each time: a view that renamed
		// itself is named by what it says now (see places.ts's placeRecord).
		const { places } = makePlaces();
		const labelAt = (i: number) => {
			const entry = places.entries[i];
			return entry.kind === 'view' ? entry.label : undefined;
		};
		const thino = (label?: string): NavEntry =>
			({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', label, t: 0 });

		places.remember(thino('Thino'));
		expect(labelAt(0)).toBe('Thino');

		places.remember(thino('Memos'));

		// One place, re-named — not two.
		expect(places.entries).toHaveLength(1);
		expect(labelAt(0)).toBe('Memos');
	});

	it('keeps the view\'s own state and icon, refreshed by every visit', () => {
		// What a place is REBUILT with when its own tab is gone: the state the view
		// had while the reader was in it, plus the mark its row wears. Both come off
		// the recording, like the label above — and the state is the one thing about a
		// view that cannot be derived later (see NavView.state), so a visit whose read
		// came back EMPTY keeps the snapshot already recorded instead of erasing it:
		// one failed read must not cost the reader the place they left.
		const { places } = makePlaces();
		const stateAt = (i: number) => {
			const entry = places.entries[i];
			return entry.kind === 'view' ? entry.state : undefined;
		};
		const iconAt = (i: number) => {
			const entry = places.entries[i];
			return entry.kind === 'view' ? entry.icon : undefined;
		};
		const thino = (state?: Record<string, unknown>, icon?: string): NavEntry =>
			({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', t: 0, state, icon });

		places.remember(thino({ filter: 'today' }, 'git-fork'));
		expect(stateAt(0)).toEqual({ filter: 'today' });
		expect(iconAt(0)).toBe('git-fork');

		// A later visit re-read both.
		places.remember(thino({ filter: 'week' }, 'calendar'));
		expect(places.entries).toHaveLength(1); // still one place: the type is the identity
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBe('calendar');

		// A visit whose state read came back empty (the view threw, answered with
		// nothing, or went over the ceiling — see shared/leaf.ts's viewState) keeps
		// what is there; a view that names no icon simply drops it, and the row falls
		// back to the word (see list.ts's fileRow).
		places.remember(thino());
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBeUndefined();
	});

	it('settles a view place in place: its state, and the stamp that goes with it', () => {
		// The funnel's `onLanded` for a view — the stack re-read the view's state as the
		// reader left it (see stack.ts's refreshTopLeafOnActivation), and this list has to
		// hear about it because a ROW is what the reader clicks. Nothing MOVES: the place
		// keeps its own position in the list and only the facts about it are refreshed,
		// so a reader travelling down the panel never sees rows shuffle under the pointer.
		const { places } = makePlaces();
		places.remember(view('thino_view'));
		places.remember(visit('a.md'));

		places.settle({
			kind: 'view', viewType: 'thino_view', leafId: 'leaf-1',
			state: { filter: 'week' }, label: 'Thino',
		});

		expect(paths(places)).toEqual(['view:thino_view', 'a.md']);
		const settled = places.entries[0];
		expect(settled.kind === 'view' ? settled.state : undefined).toEqual({ filter: 'week' });
		expect(settled.kind === 'view' ? settled.label : undefined).toBe('Thino');
	});

	it('ignores a view settle for a place that is not on the list', () => {
		// Nothing to refresh: the reader removed the row, or the ceiling trimmed it.
		const { places } = makePlaces();
		places.remember(visit('a.md'));

		places.settle({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', state: { filter: 'week' } });

		expect(paths(places)).toEqual(['a.md']);
	});
});

describe('NavPlaces — one record per landing', () => {
	// A jump is recorded before its landing settles, so the merge is made at the settle —
	// the first moment two jumps can be told apart. What it covers is two keys naming ONE
	// spot: a heading, and a block ref an edit moved onto the heading's line.
	it('merges two jumps that came to rest on the same line', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('a.md', '^block-1'));
		places.settle({ ...jump('a.md', '^block-1'), st: { scroll: 12 } });

		expect(paths(places)).toEqual([placeKey(jump('a.md', '^block-1'))]);
	});

	it('keeps the newest of the two, which is the one the row was already drawn from', () => {
		// The panel draws a line from its newest step (see groupByFile), so the record
		// that survives is the one the reader was already clicking.
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('a.md', '^block-1'));
		places.settle({ ...jump('a.md', '^block-1'), st: { scroll: 12 } });

		expect(paths(places)).toEqual([placeKey(jump('a.md', '^block-1'))]);
		expect(places.index).toBe(0);
	});

	it('keeps two landings on two lines apart', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('a.md', 'outline:## Two'));
		places.settle({ ...jump('a.md', 'outline:## Two'), st: { scroll: 40 } });

		expect(paths(places)).toEqual([
			placeKey(jump('a.md', 'outline:## One')),
			placeKey(jump('a.md', 'outline:## Two')),
		]);
	});

	it('leaves a jump with no landing alone — no coordinates is not a line', () => {
		// …and this is also why the merge is not made in remember, where no jump has one.
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));

		expect(places.entries).toHaveLength(2);
	});

	it('never merges across files', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('b.md', 'outline:## One'));
		places.settle({ ...jump('b.md', 'outline:## One'), st: { scroll: 12 } });

		expect(paths(places)).toEqual([
			placeKey(jump('a.md', 'outline:## One')),
			placeKey(jump('b.md', 'outline:## One')),
		]);
	});
});


describe('NavPlaces — its own folder rule', () => {
	it('skips the paths the reader excluded, and vault internals', () => {
		const { places } = makePlaces({ recentFilesExcludeFolders: ['私人', '归档/旧'] });
		places.remember(visit('笔记/a.md'));
		places.remember(visit('私人/b.md'));
		places.remember(visit('私人')); // the folder path itself
		places.remember(visit('归档/旧/c.md'));
		places.remember(visit('.trash/d.md'));
		places.remember(visit('.obsidian/workspace.json'));

		// The rule is the LIST's own, deliberately not the recording rules' folders
		// (see PluginSettings.recentFilesExcludeFolders).
		expect(paths(places)).toEqual(['笔记/a.md']);
	});

	it('does not consult the position-recording rules at all', () => {
		// A short file, a file with a frontmatter marker, a folder excluded from
		// POSITION recording: all of them are still files the reader navigates to.
		const { places } = makePlaces({
			excludedFolders: ['日记'],
			minLinesToRecord: 1000,
			frontmatterExcludeProperties: ['kanban-plugin'],
		});
		places.remember(visit('日记/today.md'));
		places.remember(visit('tiny.md'));

		expect(paths(places)).toEqual(['日记/today.md', 'tiny.md']);
	});

	it('drops the places a newly excluded folder already holds', () => {
		const settings = makeSettings();
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('私人/a.md'));
		places.remember(visit('公开/b.md'));
		places.markCurrent(visit('私人/a.md'));
		expect(places.index).toBe(0);

		settings.recentFilesExcludeFolders = ['私人'];
		expect(places.pruneExcluded()).toBe(1);
		expect(paths(places)).toEqual(['公开/b.md']);
		// the place the reader was standing in is gone: nothing is "here"
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces — its own frontmatter rule', () => {
	it('skips the files whose frontmatter matches a property rule', () => {
		const app = makeAppWithFrontmatter({
			'看板/board.md': { 'kanban-plugin': 'basic' },
			'published/a.md': { publish: true },
			'published/b.md': { publish: false },
			'notes/c.md': { status: 'draft' },
		});
		const { places } = makePlaces({ recentFilesExcludeProperties: ['kanban-plugin', 'publish: true'] }, app);
		places.remember(visit('看板/board.md'));
		places.remember(visit('published/a.md'));
		places.remember(visit('published/b.md'));
		places.remember(visit('notes/c.md'));

		// A name on its own keeps out every file carrying it (`kanban-plugin`);
		// a name with a value only the file whose value equals it (`publish: true`,
		// so the still-unpublished b.md is listed). The entry form is the one the
		// position rules already speak (see shared/frontmatter.ts).
		expect(paths(places)).toEqual(['published/b.md', 'notes/c.md']);
	});

	it('drops the places a newly excluded property already holds', () => {
		const app = makeAppWithFrontmatter({
			'看板/board.md': { 'kanban-plugin': 'basic' },
			'notes/a.md': { status: 'draft' },
		});
		const settings = makeSettings({ recentFilesLandings: 'last' });
		const places = new NavPlaces(app, settings);
		places.remember(visit('看板/board.md'));
		places.remember(jump('看板/board.md', 'outline:## T'));
		places.remember(visit('notes/a.md'));

		// The whole ROW goes — the note and each jump made inside it — as it does
		// for a folder that was just excluded (see pruneExcluded).
		settings.recentFilesExcludeProperties = ['kanban-plugin'];
		expect(places.pruneExcluded()).toBe(2);
		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('does not read the position feature’s per-file marker', () => {
		// `position-restore: false` answers whether a POSITION is recorded for
		// this file — it says nothing about whether the reader goes there.
		const app = makeAppWithFrontmatter({ 'notes/a.md': { 'position-restore': false } });
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, app);
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('lists a file whose frontmatter has not been parsed yet', () => {
		// The metadata cache fills lazily. A place withheld on a guess is a place
		// the reader cannot get back; the next visit asks again.
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, makeAppWithFrontmatter({}));
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('asks the vault nothing while the reader has written no rule', () => {
		// The default: no rule, no metadata-cache read. makeApp() has no
		// metadataCache at all, so a lookup here would throw.
		const { places } = makePlaces();
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});
});

describe('NavPlaces — the ceiling', () => {
	it('drops the oldest place and keeps the list MRU ordered', () => {
		const { places } = makePlaces({ recentFilesCap: 3 });
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.remember(visit(p));

		expect(paths(places)).toEqual(['b.md', 'c.md', 'd.md']);
	});

	it('never drops the place the reader is standing in', () => {
		const settings = makeSettings({ recentFilesCap: 3 });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));
		// Back to the oldest place — a traversal, which visits nothing new.
		places.markCurrent(visit('a.md'));

		// …and THEN the list has to give a row up: the ceiling came down
		// under a reader who has not moved since.
		settings.recentFilesCap = 2;
		places.applyCap();

		// Removal stops at the current index: 'a.md' is the row they are on.
		expect(paths(places)).toEqual(['a.md', 'c.md']);
		expect(places.index).toBe(0);
	});

	it('trims on the spot when the ceiling is lowered, and says how many went', () => {
		const settings = makeSettings({ recentFilesCap: 2 });
		const places = new NavPlaces(makeApp(), settings);
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));

		expect(places.applyCap()).toBe(0);
		settings.recentFilesCap = 1;
		expect(places.applyCap()).toBe(1);
		expect(paths(places)).toEqual(['c.md']);
	});

	it('clamps a hand-edited ceiling instead of disabling the cap', () => {
		const { places } = makePlaces({ recentFilesCap: 'abc' as unknown as number });
		expect(places.cap()).toBe(DEFAULT_SETTINGS.recentFilesCap);
		expect(makePlaces({ recentFilesCap: 0 }).places.cap()).toBe(1);
	});

	// WHAT THE CEILING COUNTS is rows, and a row is what the reader is SHOWN:
	// under 'last' a note is one row however many landings it holds, so a
	// landing can never cost a file its place on the list — which is the whole
	// reason the two ceilings are counted apart (see NavPlaces.trim).
	it('counts a note as one row however many landings it holds', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		// Three notes, room for two: the one that goes takes its landings with
		// it, because a ROW is the thing being dropped (see forget).
		expect(paths(places)).toEqual(['b.md', 'c.md']);
	});

	it('never drops the row the reader is standing in, landings and all', () => {
		const settings = makeSettings({ recentFilesCap: 3 });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));
		// Back to the oldest row: the note AND the landing inside it are the
		// row the ceiling has to step over.
		places.markCurrent(visit('a.md'));

		settings.recentFilesCap = 2;
		places.applyCap();

		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'c.md']);
		expect(places.index).toBe(0);
	});

	// …and the landings have a ceiling of their own, the same number, so the
	// list they live in stays bounded even where none of them is a row.
	it('gives the landings a ceiling of their own and drops the oldest of them', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		for (const key of ['h1', 'h2', 'h3', 'h4'])
			places.remember(jump('a.md', key));

		// The note's row is never in question — it is one row all along — but
		// only the two newest landings are kept, and it is the LANDING that
		// goes rather than the note it stands in.
		expect(paths(places)).toEqual(['a.md', 'a.md#h3', 'a.md#h4']);
	});

	// The top stop DRAWS every landing as a row, but it does not change what
	// the ceiling counts: a note is still one row, so the extra lines cost the
	// reader no note — which is what keeps the number they set meaning the same
	// thing at every stop (see NavPlaces.trim).
	it('draws every landing as a row without charging them to the ceiling', () => {
		const { places } = makePlaces({ recentFilesCap: 3, recentFilesLandings: 'all' });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		// Three notes in a ceiling of three, landings and all: what the reader
		// sees runs longer than the number — the one clause that stop adds.
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'a.md#h2', 'b.md', 'c.md']);
		expect(places.rowCount()).toBe(3);
	});

	// …and so moving between the stops never re-trims: the ceiling was never
	// counting the thing that changed.
	it('does not re-trim when the reader moves between the stops', () => {
		const settings = makeSettings({ recentFilesCap: 3, recentFilesLandings: 'last' });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		expect(places.rowCount()).toBe(3);
		settings.recentFilesLandings = 'all';
		expect(places.applyCap()).toBe(0);
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'a.md#h2', 'b.md', 'c.md']);
	});
});

// The BOTTOM stop of the landings setting (see LandingsMode): it answers
// RECORDING, and recording only — what is already recorded is a place like any
// other and no stop deletes it.
describe('NavPlaces — recording jumps or not', () => {
	// The shipped default (see LandingsMode), and why it is the TOP stop: what
	// ships is the whole of what the list can record, because it is the only
	// stop from which the two below it can be chosen with anything to choose
	// between — a reader who started at 'none' and only later came upon the
	// setting would find nothing recorded under it. The harness above turns it
	// down so that landings can be talked about as a separate thing.
	it('records a jump by default', () => {
		const places = new NavPlaces(makeApp(), makeSettings());
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));

		expect(paths(places)).toEqual(['a.md', 'a.md#h1']);
	});

	it('records no jump at all at the bottom stop', () => {
		const { places } = makePlaces({ recentFilesLandings: 'none' });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));

		// The note is still a place; the spot inside it is not.
		expect(paths(places)).toEqual(['a.md']);
	});

	it('still records a view, which is a place rather than a spot in a note', () => {
		const { places } = makePlaces({ recentFilesLandings: 'none' });
		places.remember(view('graph'));

		expect(paths(places)).toEqual(['view:graph']);
	});

	// The bottom stop stops the list RECORDING; it does not reach back and
	// delete what it already has. A landing goes when the note it stands in is
	// crowded out (see NavPlaces.trim), and not before — which is what makes
	// every stop reversible: a reader trying "how finely" out and coming back
	// finds their landings where they were.
	it('keeps the landings already recorded when the bottom stop is chosen', () => {
		const settings = makeSettings({ recentFilesLandings: 'last' });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(visit('b.md'));

		settings.recentFilesLandings = 'none';
		// From here on a file is all that is recorded of a visit…
		places.remember(jump('b.md', 'h2'));
		places.remember(visit('c.md'));
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'b.md', 'c.md']);

		// …and coming back down finds the landing it had, not an empty note.
		settings.recentFilesLandings = 'all';
		expect(places.entries.filter(e => e.kind === 'jump')).toHaveLength(1);
	});
});

describe('NavPlaces — the current place', () => {
	it('marks the file whose visit the reader is standing on', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.markCurrent(visit('a.md'));

		expect(places.index).toBe(0);
	});

	it('follows a plain visit and a jump, neither of which publishes "here"', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		expect(places.index).toBe(1);

		// …and a jump stands on the LANDING, not on the note — that is the
		// difference the panel's dot is drawn for.
		places.remember(jump('b.md', 'outline:## T'));
		expect(places.index).toBe(2);
	});

	it('marks the FILE for an inferred step, which is not a place of its own', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.markCurrent(teleport('a.md', 900));

		expect(places.index).toBe(0);
	});

	it('falls back to the file when a jump has no place of its own', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));

		places.markCurrent(jump('a.md', 'outline:## Gone'));

		expect(places.index).toBe(0);
	});

	it('never invents a place for the note being read — "here" is not a place', () => {
		// A workspace restored at startup opens its file through a path nothing
		// recorded. The list stays TRULY empty in that case: "you are here" has nothing
		// to stand on until the reader goes somewhere — the list does not put the note
		// being sat in back on itself, and nothing fills a place in (see forget below).
		const { places } = makePlaces();
		places.markCurrent(visit('restored.md'));

		expect(paths(places)).toEqual([]);
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces — travel goes the way its record says', () => {
	it('opens a file place the plain way, with no landing of its own', async () => {
		const { places, calls } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));

		await places.travel(0);

		// A FILE place carries no position, so nothing is injected: the position
		// database decides — exactly as clicking the same file in the file explorer
		// does. This is what keeps the two entry points from behaving differently.
		expect(calls).toEqual(['file:a.md@leaf-1']);
	});

	it('lands a jump place on its recorded spot', async () => {
		const { places, calls } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));

		await places.travel(1);

		// placeKey normalizes the heading's hashes away (see placeKey): the identity
		// is what the travel reports, while the record keeps the readable form.
		expect(calls).toEqual([`jump:${placeKey(jump('a.md', 'outline:## T'))}`]);
		expect((places.entries[1] as NavJump).key).toBe('outline:## T');
	});

	it('reactivates a view place', async () => {
		const { places, calls } = makePlaces();
		places.remember(view('graph'));

		await places.travel(0);

		expect(calls).toEqual(['view:view:graph']);
	});

	it('goes nowhere for an index that is not there', async () => {
		const { places, calls } = makePlaces();
		await places.travel(7);
		expect(calls).toEqual([]);
	});
});

describe('NavPlaces — forgetting a file', () => {
	it('drops the file record and every jump made inside it', () => {
		// What a reader means by "I do not want to see this note here" is the FILE: one
		// row per note is the list's own shape (see list.ts), so a removal that left the
		// landings behind would leave the row behind with them.
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(visit('b.md'));

		places.forget('a.md');

		expect(paths(places)).toEqual(['b.md']);
	});

	it('leaves every other file, and a pathless view, standing', () => {
		// A view has no path, so no path names it: the removal is about a FILE, and the
		// graph is not one (see places.ts's forget).
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(view('graph'));
		places.remember(jump('b.md', 'outline:## T'));

		places.forget('a.md');

		// Named through placeKey rather than spelled out: what is pinned here is which
		// places SURVIVED, and a key is the store's own way of naming one (see placeKey).
		expect(paths(places)).toEqual([
			placeKey(view('graph')),
			placeKey(jump('b.md', 'outline:## T')),
		]);
	});

	it('drops a pathless view, which no path could name', () => {
		// A view is a ROW like any other, so it comes off the list like any other — and the
		// only thing that can name it is its own TYPE (see nav/entry.ts's navGroupKey).
		// The filter used to keep every pathless record unconditionally, which left the
		// graph a row the reader could see and never take away.
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(view('graph'));
		places.remember(view('thino-memo'));

		places.forget('view:graph');

		// Named through placeKey rather than spelled out, as above: what is pinned is which
		// places SURVIVED.
		expect(paths(places)).toEqual(['a.md', placeKey(view('thino-memo'))]);
	});

	it('tells the panel, so the rows go while the reader is looking at them', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forget('a.md');

		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('stands nowhere when the place it forgot was the one being read', () => {
		// "Here" is an index into the list: a place that is gone must not leave one
		// behind, or the note that arrives next would be named as where the reader is.
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.markCurrent(visit('a.md'));
		expect(places.index).toBe(0);

		places.forget('a.md');

		expect(places.entries).toEqual([]);
		expect(places.index).toBe(-1);
	});

	it('keeps standing on the same place when another file is forgotten', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.markCurrent(visit('b.md'));
		expect(places.index).toBe(1);

		places.forget('a.md');

		// The index is re-found by IDENTITY and not by arithmetic (see dropPlaces): the
		// place that slid down one slot is the same place.
		expect(paths(places)).toEqual(['b.md']);
		expect(places.index).toBe(0);
	});

	it('says nothing at all for a path the list does not hold', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forget('nowhere.md');

		expect(paths(places)).toEqual(['a.md']);
		expect(seen).not.toHaveBeenCalled();
	});
});

describe('NavPlaces — forgetting one landing', () => {
	// The × on a LANDING's own row (see list.ts's onForgetLanding): what goes is one
	// spot, and the note's row above stays — the two acts are on two different rows
	// now, so neither has to be told apart by a gesture.
	it('drops the spot and leaves the note, and the note\'s other spots', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(visit('b.md'));

		places.forgetLanding([placeKey(jump('a.md', 'outline:## One'))]);

		// Named through placeKey rather than spelled out: what is pinned is which
		// places SURVIVED, and a key is the store's own way of naming one.
		expect(paths(places)).toEqual([
			'a.md',
			placeKey(jump('a.md', 'outline:## Two')),
			'b.md',
		]);
	});

	it('drops every place one row stands for, so the row cannot come back', () => {
		// A row is a LINE, and the panel collapses onto it every place that landed
		// there — a heading and a block ref an edit moved onto one line are one row to
		// the reader (see list.ts's landingKeys). A removal that named one of them
		// would leave the other to draw the row again the moment it was taken off,
		// which is a × that does nothing.
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', '^block-1'));
		places.remember(visit('b.md'));

		places.forgetLanding([
			placeKey(jump('a.md', 'outline:## One')),
			placeKey(jump('a.md', '^block-1')),
		]);

		expect(paths(places)).toEqual(['b.md']);
	});

	it('tells the panel, so the row goes while the reader is looking at it', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forgetLanding([placeKey(jump('a.md', 'outline:## One'))]);

		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('says nothing at all for keys the list does not hold', () => {
		// The keys arrive from a panel that may be a click behind the store (a dialog
		// holding a snapshot), so a place already gone is not a change to report.
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forgetLanding([placeKey(jump('a.md', 'outline:## Gone'))]);

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'outline:## One'))]);
		expect(seen).not.toHaveBeenCalled();
	});

	it('stands nowhere when the spot it forgot was the one being read', () => {
		// "Here" is an index into the list: a place that is gone must not leave one
		// behind, or the note that arrives next would be named as where the reader is.
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.markCurrent(jump('a.md', 'outline:## One'));
		expect(places.index).toBe(0);

		places.forgetLanding([placeKey(jump('a.md', 'outline:## One'))]);

		expect(places.entries).toEqual([]);
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces — bookkeeping', () => {
	it('re-keys every place that named a renamed file', () => {
		const { places } = makePlaces();
		places.remember(visit('old.md'));
		places.remember(jump('old.md', 'outline:## T'));
		places.remember(visit('other.md'));

		places.renameFile('old.md', 'new.md');

		// The jump's own key is a heading, not a path: it survives the rename, and the
		// identity is recomputed from the path (see placeKey).
		expect(places.entries.map(e => e.kind === 'view' ? '' : e.path))
			.toEqual(['new.md', 'new.md', 'other.md']);
		expect((places.entries[1] as NavJump).key).toBe('outline:## T');
	});

	it('drops a deleted file and every jump made inside it', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));
		places.remember(visit('b.md'));

		places.deleteFile('a.md');

		expect(paths(places)).toEqual(['b.md']);
	});

	it('names every path it holds, for the startup sweep', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('b.md', 'outline:## T'));
		places.remember(view('graph'));

		expect(places.knownPaths().sort()).toEqual(['a.md', 'b.md']);
	});
});

// A PIN is the reader's own answer about a row: it is kept out of the ceiling,
// out of the rules and out of the trim, and it leaves with the row it names.
describe('NavPlaces — pinning a row', () => {
	it('puts a new pin at the END of the block, and never pins the same row twice', () => {
		// A pin arriving at the top would push down the rows the reader had
		// already arranged; the block is a shelf they are filling, not a stack.
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.pin('a.md');
		places.pin('b.md');
		places.pin('b.md');

		expect(places.pinned).toEqual(['a.md', 'b.md']);
	});

	it('moves a pin one step, and nowhere at either end', () => {
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.pin('a.md');
		places.pin('b.md');
		places.pin('c.md');
		expect(places.pinned).toEqual(['a.md', 'b.md', 'c.md']);

		places.movePinned('a.md', -1);
		expect(places.pinned).toEqual(['a.md', 'b.md', 'c.md']);
		places.movePinned('a.md', 1);
		expect(places.pinned).toEqual(['b.md', 'a.md', 'c.md']);
		places.movePinned('c.md', 1);
		expect(places.pinned).toEqual(['b.md', 'a.md', 'c.md']);
		places.movePinned('c.md', -1);
		expect(places.pinned).toEqual(['b.md', 'c.md', 'a.md']);
		places.movePinned('nope.md', -1);
		expect(places.pinned).toEqual(['b.md', 'c.md', 'a.md']);
	});

	it('moves a pin the WHOLE WAY, and lands on the end rather than past it', () => {
		// "Move to the front" hands over more steps than the block is long, and
		// what it means is the end: counting them is the CALLER's arithmetic
		// about a shape it does not own (see NavPlaces.movePinned).
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.remember(visit(p));
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.pin(p);
		expect(places.pinned).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);

		places.movePinned('c.md', -2);
		expect(places.pinned).toEqual(['c.md', 'a.md', 'b.md', 'd.md']);
		// More steps than there is block: the row lands ON the end it asked for.
		places.movePinned('a.md', -99);
		expect(places.pinned).toEqual(['a.md', 'c.md', 'b.md', 'd.md']);
		places.movePinned('b.md', 99);
		expect(places.pinned).toEqual(['a.md', 'c.md', 'd.md', 'b.md']);
	});

	it('takes a pin off, and says nothing for a row that was never pinned', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.pin('a.md');
		places.pin('b.md');

		places.unpin('a.md');
		places.unpin('nope.md');

		expect(places.pinned).toEqual(['b.md']);
		expect(places.isPinned('b.md')).toBe(true);
		expect(places.isPinned('a.md')).toBe(false);
	});

	// THE CEILING counts the rows the reader did NOT name: a pin is kept on top of
	// the number and not out of it, so pinning a note costs them none of the fifty.
	it('keeps a pinned row on top of the ceiling rather than inside it', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.pin('b.md');

		for (const p of ['d.md', 'e.md'])
			places.remember(visit(p));

		// The unnamed rows are c, d, e — one over, and the oldest of them goes.
		expect(paths(places)).toEqual(['b.md', 'd.md', 'e.md']);
	});

	it('keeps a pinned row’s own landings out of the landing ceiling', () => {
		const { places } = makePlaces({ recentFilesCap: 1 });
		places.remember(visit('a.md'));
		places.pin('a.md');
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));

		expect(places.applyCap()).toBe(0);
		expect(places.entries.filter(e => e.kind === 'jump')).toHaveLength(2);
	});

	it('keeps a pinned row when a rule added later would exclude it', () => {
		const settings = makeSettings();
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('notes/a.md'));
		places.remember(visit('b.md'));
		places.pin('notes/a.md');

		settings.recentFilesExcludeFolders = ['notes'];

		expect(places.pruneExcluded()).toBe(0);
		expect(paths(places)).toEqual(['notes/a.md', 'b.md']);
	});

	it('moves a pin with the file it names', () => {
		const { places } = makePlaces();
		places.remember(visit('old.md'));
		places.pin('old.md');

		places.renameFile('old.md', 'new.md');

		expect(places.pinned).toEqual(['new.md']);
	});

	it('takes the pin with the row when the row is gone', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.pin('a.md');

		places.deleteFile('a.md');
		expect(places.pinned).toEqual([]);

		places.pin('b.md');
		places.forget('b.md');
		expect(places.pinned).toEqual([]);
	});

	it('writes a pin down at once, rather than leaving it to the next flush', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.persist();
		places.pin('a.md');

		expect(new NavPlaces(makeApp(), makeSettings()).pinned).toEqual(['a.md']);
	});

	it('tells the panel about a pin, and about nothing that pinned nothing', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.pin('a.md');
		places.pin('a.md');
		places.unpin('nope.md');

		expect(seen).toHaveBeenCalledTimes(1);
	});
});

describe('NavPlaces — persistence', () => {
	it('round-trips the list per vault', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));
		places.persist();

		const restored = new NavPlaces(makeApp(), makeSettings());
		expect(restored.entries.map(e => e.kind)).toEqual(['visit', 'jump']);
		expect((restored.entries[1] as NavJump).key).toBe('outline:## T');
		expect(paths(restored)).toEqual(paths(places));
	});

	it('drops a blob written by another format version', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: RECENT_PLACES_VERSION + 1,
			places: [visit('a.md')],
		}));

		expect(new NavPlaces(makeApp(), makeSettings()).entries).toEqual([]);
	});

	it('refuses a blob carrying an inferred step, which is never a place', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: RECENT_PLACES_VERSION,
			places: [visit('a.md'), teleport('a.md', 5), { kind: 'nonsense' }],
		}));

		expect(paths(new NavPlaces(makeApp(), makeSettings()))).toEqual(['a.md']);
	});

	it('dedups its own writes', () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem');
		try {
			const places = new NavPlaces(makeApp(), makeSettings());
			places.remember(visit('a.md'));
			places.persist();
			expect(setItem).toHaveBeenCalledTimes(1);
			places.persist();
			expect(setItem).toHaveBeenCalledTimes(1);
		} finally {
			setItem.mockRestore();
		}
	});

	it('degrades to an empty list on junk', () => {
		window.localStorage.setItem(STORAGE_KEY, '{not json');
		expect(new NavPlaces(makeApp(), makeSettings()).entries).toEqual([]);
	});
});

// The signal a RESIDENT panel lives on (see NavPlaces.subscribe): the dialog is
// opened, read and closed inside one render and needs none of this, but a sidebar
// panel is on screen for hours and has no other way to learn that the list moved
// under it. It used to come from the stack (see nav-history/stack.ts) — the panel draws
// places now, so the place list is what has to say so.
describe('NavPlaces — change notification', () => {
	it('tells a subscriber about a place, and stops when it unsubscribes', () => {
		const { places } = makePlaces();
		const seen = vi.fn();
		const off = places.subscribe(seen);

		places.remember(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);

		// The panel was closed: a place recorded afterwards must not be drawn into a
		// body that has already been torn down.
		off();
		places.remember(visit('b.md'));
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('tells a subscriber when the current place moves, and not when it has not', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.markCurrent(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);
		// Already standing there: nothing on screen moved.
		places.markCurrent(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);
		places.markCurrent(undefined);
		expect(seen).toHaveBeenCalledTimes(2);
	});

	it('tells a subscriber about a rename, a prune and a trim — and about nothing that changed nothing', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.renameFile('a.md', 'z.md');
		expect(seen).toHaveBeenCalledTimes(1);
		places.renameFile('nothing.md', 'else.md');
		expect(seen).toHaveBeenCalledTimes(1);

		places.remember(visit('b.md'));
		places.remember(visit('c.md')); // the trim drops 'z.md'
		expect(seen).toHaveBeenCalledTimes(3);

		places.deleteFile('b.md');
		expect(seen).toHaveBeenCalledTimes(4);
		places.deleteFile('b.md');
		expect(seen).toHaveBeenCalledTimes(4);

		// A filtered path is never a place, so it is never news either.
		places.remember(visit('.trash/x.md'));
		expect(seen).toHaveBeenCalledTimes(4);
	});
});
