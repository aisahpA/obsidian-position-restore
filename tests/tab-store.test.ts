// Tests for the device-local per-leaf records (tab-store.ts):
//  - loadLastStateByLeaf: a restart reads storage into the PositionState map;
//    corrupt storage degrades to empty; malformed entries (no path/state)
//    are dropped instead of trusted;
//  - persistLastStateByLeaf: the quit/suspend snapshot's single storage write
//    (PositionManager.snapshotTabStates delegates here);
//  - getRestoreSt: path-guarded read of a leaf's stored ephemeral state —
//    a record whose leaf has moved on to another file must not reposition it,
//    and the read never consumes the record.
//
// Recording-side guards (exclusions, bases scrollTop, restore/search skips)
// are covered by sampler-scroll-capture.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';

import { App, WorkspaceLeaf } from 'obsidian';
import { TabStore } from '../src/tab-store';
import { PositionState } from '../src/position-state';
import { DEFAULT_SETTINGS, TabStateRecord } from '../src/types';

const APP_STUB = {
	appId: 'test-vault',
	vault: { getName: () => 'Test' },
	workspace: { layoutReady: false },
} as unknown as App;

const STORAGE_KEY = 'position-restore:tabs:test-vault';

function seedStorage(records: Record<string, TabStateRecord> | string) {
	window.localStorage.setItem(STORAGE_KEY, typeof records === 'string' ? records : JSON.stringify(records));
}

function rec(path: string, scroll: number): TabStateRecord {
	return { filePath: path, st: { scroll } };
}

function storeWith(entries: [string, TabStateRecord][], db: Record<string, unknown> = {}): TabStore {
	const store = new TabStore(APP_STUB, { db } as never, new PositionState(DEFAULT_SETTINGS));
	// The constructor loads from storage into lastStateByLeaf; tests with a
	// preset map re-assign it after construction.
	store.state.lastStateByLeaf = new Map(entries);
	return store;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe('loadLastStateByLeaf / persistLastStateByLeaf', () => {
	it('loads the records persisted by the last session into a leaf-keyed map', () => {
		seedStorage({ 'leaf-1': rec('a.md', 42) });
		const records = TabStore.loadLastStateByLeaf(APP_STUB);
		expect(records.get('leaf-1')).toEqual(rec('a.md', 42));
	});

	it('corrupt storage degrades to an empty load without throwing', () => {
		seedStorage('{not json');
		expect(TabStore.loadLastStateByLeaf(APP_STUB).size).toBe(0);
	});

	it('drops malformed entries (no path or no state) instead of trusting the parse', () => {
		seedStorage(JSON.stringify({ 'leaf-1': { scroll: 1 }, 'leaf-2': rec('b.md', 2) }));
		const records = TabStore.loadLastStateByLeaf(APP_STUB);
		expect(records.has('leaf-1')).toBe(false);
		expect(records.get('leaf-2')).toEqual(rec('b.md', 2));
	});

	it('persistLastStateByLeaf writes only records whose filePath is shared by multiple leaves', () => {
		const store = storeWith([]);
		store.persistLastStateByLeaf(new Map([
			['leaf-1', rec('a.md', 2)],
			['leaf-2', rec('a.md', 5)],
			['leaf-3', rec('b.md', 7)],
		]));
		expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
			'leaf-1': rec('a.md', 2),
			'leaf-2': rec('a.md', 5),
		});
	});
});

describe('getRestoreSt', () => {
	it('returns the stored ephemeral state of a leaf, path-guarded, without consuming', () => {
		const store = storeWith([['leaf-1', rec('a.md', 42)]]);
		const leaf1 = { id: 'leaf-1' } as unknown as WorkspaceLeaf;
		const leafX = { id: 'leaf-x' } as unknown as WorkspaceLeaf;
		expect(store.getRestoreSt(leaf1, 'a.md')).toEqual({ scroll: 42 });
		// Path guard: the leaf moved on to another file — no reposition.
		expect(store.getRestoreSt(leaf1, 'b.md')).toBeUndefined();
		// Unknown leaf.
		expect(store.getRestoreSt(leafX, 'a.md')).toBeUndefined();
		// Read never consumes: the record survives for later reads.
		expect(store.getRestoreSt(leaf1, 'a.md')).toEqual({ scroll: 42 });
		expect(store.state.lastStateByLeaf.has('leaf-1')).toBe(true);
	});
});