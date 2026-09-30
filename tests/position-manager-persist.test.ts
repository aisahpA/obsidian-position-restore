// The contract behind main.ts's 'quit' handler. Obsidian waits on the promises handed
// to Tasks before it exits, so storePositionData() has to hand the db write back
// instead of dropping it on the floor. Three things hold and are pinned here: the three
// localStorage stores are written synchronously, before the file write even starts,
// the returned promise does not settle until the file write has, and it settles even
// when a write fails — a rejection would leave the app stuck on "Saving...".

import { describe, it, expect, vi, afterEach } from 'vitest';
import { App } from 'obsidian';

import { PositionManager } from '@/position/manager';
import type { PositionStore } from '@/position/storage/position-store';
import type { NavStack } from '@/nav-history/stack';
import type { NavPlaces } from '@/recent-files/places';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

function makeHarness() {
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: () => null,
			adapter: { exists: async () => false },
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
	// The db write is on a leash: the test says when the disk is done.
	let release = () => {};
	const onDisk = new Promise<void>(resolve => {
		release = resolve;
	});
	const database = { writeDb: vi.fn(() => onDisk) };
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(
		app as unknown as App,
		database as never,
		settings,
	);
	const store = (manager as unknown as { store: PositionStore }).store;
	const stack = (manager as unknown as { stack: NavStack }).stack;
	const places = (manager as unknown as { places: NavPlaces }).places;
	vi.spyOn(store, 'persist');
	vi.spyOn(stack, 'persist');
	vi.spyOn(places, 'persist');
	return { manager, database, store, stack, places, release };
}

afterEach(() => {
	window.localStorage.clear();
});

describe('PositionManager.storePositionData', () => {
	it('writes the three in-memory stores before the db file write starts', () => {
		const h = makeHarness();

		const write = h.manager.storePositionData();

		// The prefix of an async body runs synchronously, so by the time the promise
		// is in hand every localStore write has already happened — a quit that is
		// killed mid-file-write still keeps the per-tab snapshot.
		expect(h.store.persist).toHaveBeenCalled();
		expect(h.stack.persist).toHaveBeenCalled();
		expect(h.places.persist).toHaveBeenCalled();
		expect(h.database.writeDb).toHaveBeenCalled();
		h.release();
		return write;
	});

	it('settles only once the file write has', async () => {
		const h = makeHarness();
		let settled = false;

		const write = h.manager.storePositionData().then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);

		h.release();
		await write;
		expect(settled).toBe(true);
	});

	it('settles even when the db write fails, and says so in the log', async () => {
		const h = makeHarness();
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		h.database.writeDb.mockRejectedValueOnce(new Error('disk full'));

		// A quit hands this promise to Tasks, and Obsidian awaits every one of those
		// with Promise.all before it closes the window.
		await expect(h.manager.storePositionData()).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});
