// Wiring check for PositionManager's vault rename/delete dispatch: the facade
// owns no bookkeeping of its own — it hands each vault event to PathBookkeeper
// (see path-bookkeeping.test.ts for the mechanics). What matters here is the
// end-to-end behaviour the reported bug was about: a sync plugin's remove +
// rename must not cost the file its position record or its navigation-history
// steps, while a real delete must still clean both up.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TAbstractFile } from 'obsidian';

import { App, TFile } from 'obsidian';
import { PositionManager } from '@/position/manager';
import type { NavHistory } from '@/nav-history/history';
import type { PositionState } from '@/position/state';
import type { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';
// leafStates is private on the store; this is the test seam.
import { leafStatesOf } from './position-store-seam';

// Timing is stated as "a beat" and "long after", never as the grace period
// itself: the mechanism, not the tuning value, is what these tests pin.
const A_BEAT = 100;
const LONG_AFTER = 60_000;

function makeHarness() {
	// The vault's file index, as the deferred prune's re-check sees it.
	const files = new Set<string>();
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) =>
				(files.has(path) ? Object.assign(new TFile(), { path }) : null),
		},
		metadataCache: { getFileCache: () => null },
		workspace: {
			layoutReady: true,
			rootSplit: { containerEl: { contains: () => false } },
			getActiveViewOfType: () => null,
			iterateAllLeaves: () => undefined,
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
		},
	};
	// The file layer, functional enough that the store's two-layer behaviour is
	// observable end to end (the spies still record the calls the tests assert).
	const db: Record<string, { scroll: number }> = { 'a.md': { scroll: 7 } };
	const database = {
		db,
		setState: vi.fn((path: string, st: { scroll: number }) => { db[path] = st; }),
		renameFile: vi.fn((newPath: string, oldPath: string) => {
			if (db[oldPath] === undefined) return;
			db[newPath] = db[oldPath];
			delete db[oldPath];
		}),
		deleteFile: vi.fn((path: string) => { delete db[path]; }),
	};
	// The settings object the manager (and the history it owns) holds: the
	// settings panel mutates THIS instance in place, so a test that changes a
	// setting must change it here.
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(
		app as unknown as App,
		database as never,
		settings,
	);
	// The collaborators the manager owns; the tests seed and read them through
	// the same public API the plugin uses.
	const nav = (manager as unknown as { nav: NavHistory }).nav;
	const state = (manager as unknown as { state: PositionState }).state;
	const store = (manager as unknown as { store: PositionStore }).store;
	const file = (path: string): TAbstractFile => Object.assign(new TFile(), { path }) as TAbstractFile;
	const paths = () => nav.entries.map(e => (e.kind !== 'view' ? e.path : undefined));
	return { manager, nav, state, store, database, files, file, paths, settings };
}

afterEach(() => {
	vi.useRealTimers();
	window.localStorage.clear();
});

describe('PositionManager vault path changes', () => {
	it('a rename re-keys the position record, the history steps and the current-file pointer', () => {
		const h = makeHarness();
		h.nav.recordOpen('a.md', 'leaf-1');
		h.state.lastLoadedFilePath = 'a.md';

		h.manager.renameFile(h.file('b.md'), 'a.md');

		expect(h.database.renameFile).toHaveBeenCalledWith('b.md', 'a.md');
		expect(h.paths()).toEqual(['b.md']);
		expect(h.state.lastLoadedFilePath).toBe('b.md');
	});

	it('the sync remove + rename keeps the position record and the history steps', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.nav.recordOpen('a.md', 'leaf-1');
		h.nav.recordOpen('b.md', 'leaf-1');

		// The replacement, as the vault reports it: the path is gone (Obsidian
		// closes its tab) ...
		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		// ... and the downloaded temp file is renamed over it right after.
		h.files.add('a.md');

		vi.advanceTimersByTime(LONG_AFTER);

		expect(h.database.deleteFile).not.toHaveBeenCalled();
		expect(h.paths()).toEqual(['a.md', 'b.md']);
		expect(h.nav.index).toBe(1);
	});

	it('a genuine delete still prunes both stores, once the window closes', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.nav.recordOpen('a.md', 'leaf-1');
		h.nav.recordOpen('b.md', 'leaf-1');

		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		vi.advanceTimersByTime(A_BEAT); // a beat: deferred, not synchronous
		expect(h.database.deleteFile).not.toHaveBeenCalled();

		vi.advanceTimersByTime(LONG_AFTER);

		expect(h.database.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.paths()).toEqual(['b.md']);
		expect(h.nav.index).toBe(0);
	});

	// The two layers of the position store are re-keyed and dropped TOGETHER.
	// The per-leaf records are the half the bookkeeper used to miss: a record
	// still naming the deleted path would be handed back by PositionStore.read
	// for a file later created at that same path (restoring a dead position),
	// and one still naming the old path after a rename would fail its path
	// guard, silently collapsing a per-tab split onto the file record.
	it('a rename re-keys the per-leaf records along with the file record', () => {
		const h = makeHarness();
		leafStatesOf(h.store).set('leaf-1', { filePath: 'a.md', st: { scroll: 42 } });

		h.manager.renameFile(h.file('b.md'), 'a.md');

		expect(leafStatesOf(h.store).get('leaf-1')).toEqual({ filePath: 'b.md', st: { scroll: 42 } });
		// The tab's own spot still answers for the renamed file...
		expect(h.store.read('leaf-1', 'b.md')).toEqual({ scroll: 42 });
		// ...instead of falling back to the file record.
		expect(h.store.read('leaf-1', 'a.md')).toBeUndefined();
	});

	it('a genuine delete drops the per-leaf records of that path too, and only those', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		leafStatesOf(h.store).set('leaf-1', { filePath: 'a.md', st: { scroll: 42 } });
		leafStatesOf(h.store).set('leaf-2', { filePath: 'b.md', st: { scroll: 9 } });

		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		vi.advanceTimersByTime(LONG_AFTER);

		expect(leafStatesOf(h.store).has('leaf-1')).toBe(false);
		expect(leafStatesOf(h.store).get('leaf-2')).toEqual({ filePath: 'b.md', st: { scroll: 9 } });
		// A file later created at the deleted path starts clean.
		expect(h.store.read('leaf-1', 'a.md')).toBeUndefined();
	});

	it('a sync remove + rename keeps the per-leaf records for the surviving path', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		leafStatesOf(h.store).set('leaf-1', { filePath: 'a.md', st: { scroll: 42 } });
		h.files.add('a.md');

		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		h.files.add('a.md'); // the replacement lands before the window closes

		vi.advanceTimersByTime(LONG_AFTER);

		expect(leafStatesOf(h.store).get('leaf-1')).toEqual({ filePath: 'a.md', st: { scroll: 42 } });
		expect(h.store.read('leaf-1', 'a.md')).toEqual({ scroll: 42 });
	});
});

// The two maintenance paths that have no vault event behind them: the stack
// ceiling changing in the settings, and history left over for files deleted
// while Obsidian was closed.
describe('PositionManager navigation history maintenance', () => {
	it('a changed stack cap trims the stack already in memory', () => {
		const h = makeHarness();
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			h.nav.recordOpen(p, 'leaf-1');

		h.settings.navStackCap = 2;
		h.manager.applyNavStackCap();

		// Trimmed NOW, not on the next navigation (which would drop a large
		// chunk at once, long after the setting was changed).
		expect(h.paths()).toEqual(['c.md', 'd.md']);
		expect(h.nav.index).toBe(1);
	});

	it('the startup sweep drops a missing file\'s history but keeps its position record', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.nav.recordOpen('a.md', 'leaf-1');
		h.nav.recordOpen('gone.md', 'leaf-1'); // deleted while Obsidian was closed

		h.manager.sweepMissingHistory();
		vi.advanceTimersByTime(LONG_AFTER);

		expect(h.paths()).toEqual(['a.md']);
		// History is device-local and disposable; the db is neither — it is
		// synced, so a vault that has not materialized the file yet must not
		// erase the position the other devices still hold.
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('the startup sweep leaves the history of a file the vault still has', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.files.add('b.md');
		h.nav.recordOpen('a.md', 'leaf-1');
		h.nav.recordOpen('b.md', 'leaf-1');

		h.manager.sweepMissingHistory();
		vi.advanceTimersByTime(LONG_AFTER);

		expect(h.paths()).toEqual(['a.md', 'b.md']);
	});
});
