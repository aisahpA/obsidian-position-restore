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
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

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
	const database = {
		db: { 'a.md': { scroll: 7 } },
		setState: vi.fn(),
		renameFile: vi.fn(),
		deleteFile: vi.fn(),
	};
	const manager = new PositionManager(
		app as unknown as App,
		database as never,
		{ ...DEFAULT_SETTINGS } as PluginSettings,
	);
	// The collaborators the manager owns; the tests seed and read them through
	// the same public API the plugin uses.
	const nav = (manager as unknown as { nav: NavHistory }).nav;
	const state = (manager as unknown as { state: PositionState }).state;
	const file = (path: string): TAbstractFile => Object.assign(new TFile(), { path }) as TAbstractFile;
	const paths = () => nav.entries.map(e => (e.kind !== 'view' ? e.path : undefined));
	return { manager, nav, state, database, files, file, paths };
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
});
