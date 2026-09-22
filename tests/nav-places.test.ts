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

function makePlaces(settings: Partial<PluginSettings> = {}, app = makeApp()) {
	const places = new NavPlaces(app, makeSettings(settings));
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
});

describe('NavPlaces — its own folder rule', () => {
	it('skips the paths the reader excluded, and vault internals', () => {
		const { places } = makePlaces({ navRecentExcludeFolders: ['私人', '归档/旧'] });
		places.remember(visit('笔记/a.md'));
		places.remember(visit('私人/b.md'));
		places.remember(visit('私人')); // the folder path itself
		places.remember(visit('归档/旧/c.md'));
		places.remember(visit('.trash/d.md'));
		places.remember(visit('.obsidian/workspace.json'));

		// The rule is the LIST's own, deliberately not the recording rules' folders
		// (see PluginSettings.navRecentExcludeFolders).
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

		settings.navRecentExcludeFolders = ['私人'];
		expect(places.pruneExcluded()).toBe(1);
		expect(paths(places)).toEqual(['公开/b.md']);
		// the place the reader was standing in is gone: nothing is "here"
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces — the ceiling', () => {
	it('drops the oldest place and keeps the list MRU ordered', () => {
		const { places } = makePlaces({ navRecentCap: 3 });
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.remember(visit(p));

		expect(paths(places)).toEqual(['b.md', 'c.md', 'd.md']);
	});

	it('never drops the place the reader is standing in', () => {
		const { places } = makePlaces({ navRecentCap: 2 });
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		// the reader goes back to the oldest place, then a new one arrives
		places.markCurrent(visit('a.md'));
		places.remember(visit('c.md'));

		// Removal stops at the current index: 'a.md' is the row they are on.
		expect(paths(places)).toEqual(['a.md', 'c.md']);
		expect(places.index).toBe(0);
	});

	it('trims on the spot when the ceiling is lowered, and says how many went', () => {
		const settings = makeSettings({ navRecentCap: 2 });
		const places = new NavPlaces(makeApp(), settings);
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));

		expect(places.applyCap()).toBe(0);
		settings.navRecentCap = 1;
		expect(places.applyCap()).toBe(1);
		expect(paths(places)).toEqual(['c.md']);
	});

	it('clamps a hand-edited ceiling instead of disabling the cap', () => {
		const { places } = makePlaces({ navRecentCap: 'abc' as unknown as number });
		expect(places.cap()).toBe(DEFAULT_SETTINGS.navRecentCap);
		expect(makePlaces({ navRecentCap: 0 }).places.cap()).toBe(1);
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
		// recorded. The list stays TRULY empty in that case (see NavPlaces.clear):
		// "you are here" has nothing to stand on until the reader goes somewhere —
		// the list does not put the note being sat in back on itself.
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

describe('NavPlaces — starting over', () => {
	it('throws every place away, and stands nowhere', () => {
		// The list is disposable by design (see places-store.ts): an empty one fills up
		// again with use, so clearing it needs no confirmation and no migration — and it
		// deliberately does NOT touch the position records, which are a different store
		// keyed by path (see the module comment).
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));
		places.remember(view('graph'));
		places.markCurrent(visit('a.md'));
		expect(places.entries).toHaveLength(3);
		expect(places.index).toBe(0);

		places.clear();

		expect(places.entries).toEqual([]);
		// "Here" goes with it: an index into a list that is gone would name the note
		// that arrives next.
		expect(places.index).toBe(-1);
	});

	it('tells the panel, so the rows go while the reader is looking at them', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.clear();

		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('starts empty rather than merely looking empty', () => {
		// "Clear" is a real clear (see NavPlaces.clear): the note being read goes with
		// the rest, and nothing puts it back — an empty list is the whole of what was
		// asked, and the next navigation refills it. This checks the absence of any
		// such backfill, which the caller used to do.
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.clear();

		expect(places.knownPaths()).toEqual([]);
		expect(places.entries.some(e => e.kind !== 'view')).toBe(false);
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
		const { places } = makePlaces({ navRecentCap: 2 });
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
