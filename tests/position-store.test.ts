// Tests for PositionStore (position/storage/position-store.ts), the single
// facade over the two position layers:
//  - loadLeafStates: a restart reads the persisted overlay into the map;
//    corrupt storage degrades to empty; malformed entries (no path/state) are
//    dropped instead of trusted;
//  - read: the leaf record wins for the file it names, falls back to the file
//    record otherwise, is path-guarded, and never consumes;
//  - write: updates both layers, dedups an unchanged leaf record, and seeds a
//    first sighting without touching the file layer;
//  - persist: writes ONLY the true divergence — leaf records whose value the
//    file record does not already hold — so a single tab per file never
//    reaches localStorage;
//  - renameFile / deleteFile: the path lifecycle runs over BOTH layers (the
//    regression this facade exists for: a per-leaf record left behind naming
//    a deleted path would be restored again for a new file at that path);
//  - pruneDeadLeaves: closed leaves cannot update their own record.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { App } from 'obsidian';
import { PositionStore } from '@/position/storage/position-store';
import { EphemeralState, TabStateRecord } from '@/types';
// leafStates / loadLeafStates are private on the store; this is the test seam.
import { leafStatesOf, loadLeafStates, setLeafStates } from './position-store-seam';

const APP_STUB = {
	appId: 'test-vault',
	vault: { getName: () => 'Test' },
} as unknown as App;

const STORAGE_KEY = 'position-restore:tabs:test-vault';

// Minimal stand-in for CursorPositionDatabase: just enough of the file layer
// for the store's two-layer logic to be observable, without pulling the real
// class (and its i18n / Notice imports) into a storage unit test.
interface DbStub {
	db: Record<string, EphemeralState>;
	setState(filePath: string, st: EphemeralState): void;
	deleteFile(filePath: string): void;
	renameFile(newPath: string, oldPath: string): void;
	pruneDb(): number;
}

function makeDb(seed: Record<string, EphemeralState> = {}): DbStub {
	const db: Record<string, EphemeralState> = { ...seed };
	return {
		db,
		setState(filePath, st) { db[filePath] = st; },
		deleteFile(filePath) { delete db[filePath]; },
		renameFile(newPath, oldPath) {
			if (db[oldPath] === undefined) return;
			db[newPath] = db[oldPath];
			delete db[oldPath];
		},
		// The real prune owns the exclusion rules; the store only mirrors its
		// result, so tests drive it by removing paths directly.
		pruneDb: () => 0,
	};
}

function makeStore(db: DbStub = makeDb()): { store: PositionStore; db: DbStub } {
	return { store: new PositionStore(APP_STUB, db as never), db };
}

function seedStorage(records: Record<string, TabStateRecord> | string) {
	window.localStorage.setItem(STORAGE_KEY, typeof records === 'string' ? records : JSON.stringify(records));
}

function rec(path: string, scroll: number): TabStateRecord {
	return { filePath: path, st: { scroll } };
}

function persisted(): unknown {
	return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
}

beforeEach(() => {
	window.localStorage.clear();
});

describe('loadLeafStates', () => {
	it('loads the persisted overlay into a leaf-keyed map', () => {
		seedStorage({ 'leaf-1': rec('a.md', 42) });
		const records = loadLeafStates(APP_STUB);
		expect(records.get('leaf-1')).toEqual(rec('a.md', 42));
	});

	it('corrupt storage degrades to an empty load without throwing', () => {
		seedStorage('{not json');
		expect(loadLeafStates(APP_STUB).size).toBe(0);
	});

	it('drops malformed entries (no path or no state) instead of trusting the parse', () => {
		seedStorage(JSON.stringify({ 'leaf-1': { scroll: 1 }, 'leaf-2': rec('b.md', 2) }));
		const records = loadLeafStates(APP_STUB);
		expect(records.has('leaf-1')).toBe(false);
		expect(records.get('leaf-2')).toEqual(rec('b.md', 2));
	});
});

describe('read', () => {
	it('prefers the leaf record for the file it names, path-guarded, without consuming', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 } }));
		setLeafStates(store, [['leaf-1', rec('a.md', 42)]]);

		expect(store.read('leaf-1', 'a.md')).toEqual({ scroll: 42 });
		// Path guard: the leaf moved on to another file → the file record answers.
		expect(store.read('leaf-1', 'b.md')).toBeUndefined();
		// Unknown leaf → the file record answers.
		expect(store.read('leaf-x', 'a.md')).toEqual({ scroll: 1 });
		// Read never consumes.
		expect(leafStatesOf(store).has('leaf-1')).toBe(true);
		expect(db.db['a.md']).toEqual({ scroll: 1 });
	});
});

describe('write', () => {
	it('records in both layers', () => {
		const { store, db } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 7 });
		expect(db.db['a.md']).toEqual({ scroll: 7 });
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('a.md', 7));
	});

	it('is a no-op when the leaf record is unchanged', () => {
		const { store, db } = makeStore();
		const setState = (db.setState = vi.fn());
		setLeafStates(store, [['leaf-1', rec('a.md', 7)]]);

		store.write('leaf-1', 'a.md', { scroll: 7 });

		expect(setState).not.toHaveBeenCalled();
	});

	it('seeds a first sighting that already matches the file record without a file write', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 7 } }));
		const setState = (db.setState = vi.fn());

		store.write('leaf-1', 'a.md', { scroll: 7 });

		expect(setState).not.toHaveBeenCalled();
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('a.md', 7));
	});

	it('keeps two leaves of one file independent (the file layer holds the last write)', () => {
		const { store, db } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });

		expect(db.db['a.md']).toEqual({ scroll: 100 });
		expect(store.read('leaf-1', 'a.md')).toEqual({ scroll: 10 });
		expect(store.read('leaf-2', 'a.md')).toEqual({ scroll: 100 });
	});
});

describe('persist — the overlay holds only the true divergence', () => {
	it('persists nothing while every leaf agrees with the file record', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.persist();
		expect(persisted()).toEqual({});
	});

	it('persists only the leaf whose value the file record does not hold', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });
		// The file record holds 100, so only leaf-1 diverges.
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });
	});

	it('stops persisting a leaf once the file record catches up with it', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });

		// leaf-2 moves to leaf-1's position: the file record now holds 10, so
		// neither leaf diverges any more.
		store.write('leaf-2', 'a.md', { scroll: 10 });
		store.persist();
		expect(persisted()).toEqual({});
	});

	it('keeps a leaf record that has no file record at all (it is the only copy)', () => {
		const { store } = makeStore();
		setLeafStates(store, [['leaf-1', rec('a.md', 10)]]);
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });
	});

	it('degrades quietly when localStorage rejects the write (quota / disabled)', () => {
		const { store } = makeStore();
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		setLeafStates(store, [['leaf-1', rec('a.md', 10)]]);
		expect(() => store.persist()).not.toThrow();
		spy.mockRestore();
	});
});

describe('renameFile', () => {
	it('re-keys the file record AND the leaf records naming that path', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 } }));
		setLeafStates(store, [['leaf-1', rec('a.md', 42)]]);

		store.renameFile('b.md', 'a.md');

		expect(db.db['b.md']).toEqual({ scroll: 1 });
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('b.md', 42));
		// The re-keyed leaf still answers for the new path...
		expect(store.read('leaf-1', 'b.md')).toEqual({ scroll: 42 });
		// ...and the old path is gone from both layers.
		expect(store.read('leaf-1', 'a.md')).toBeUndefined();
	});

	it('survives a restart with the leaf still on the renamed file', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 } }));
		setLeafStates(store, [['leaf-1', rec('a.md', 42)]]);
		store.renameFile('b.md', 'a.md');
		store.persist();

		const restarted = new PositionStore(APP_STUB, db as never);
		expect(restarted.read('leaf-1', 'b.md')).toEqual({ scroll: 42 });
	});
});

describe('deleteFile', () => {
	it('drops the file record AND every leaf record naming that path', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 }, 'b.md': { scroll: 2 } }));
		setLeafStates(store, [
			['leaf-1', rec('a.md', 42)],
			['leaf-2', rec('a.md', 99)],
			['leaf-3', rec('b.md', 7)],
		]);

		store.deleteFile('a.md');

		expect(db.db['a.md']).toBeUndefined();
		expect(leafStatesOf(store).has('leaf-1')).toBe(false);
		expect(leafStatesOf(store).has('leaf-2')).toBe(false);
		// Other paths are untouched.
		expect(leafStatesOf(store).get('leaf-3')).toEqual(rec('b.md', 7));
	});

	it('does not hand a deleted position back to a new file at the same path', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 42 });
		store.deleteFile('a.md');

		// The file is re-created at the same path and opened in the same leaf.
		expect(store.read('leaf-1', 'a.md')).toBeUndefined();
		store.write('leaf-1', 'a.md', { scroll: 3 });
		expect(store.read('leaf-1', 'a.md')).toEqual({ scroll: 3 });
	});

	it('a deleted path stops being persisted', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });

		store.deleteFile('a.md');
		store.persist();
		expect(persisted()).toEqual({});
	});
});

describe('pruneDatabase', () => {
	it('mirrors the file-layer prune onto the leaf layer', () => {
		const db = makeDb({ 'ex.txt': { scroll: 1 }, 'ok.md': { scroll: 2 } });
		db.pruneDb = () => {
			delete db.db['ex.txt']; // what the exclusion rules removed
			return 1;
		};
		const { store } = makeStore(db);
		setLeafStates(store, [
			['leaf-1', rec('ex.txt', 42)],
			['leaf-2', rec('ok.md', 7)],
		]);

		expect(store.pruneDatabase()).toBe(1);

		// The excluded path is gone from both layers; the other one is intact.
		expect(leafStatesOf(store).has('leaf-1')).toBe(false);
		expect(leafStatesOf(store).get('leaf-2')).toEqual(rec('ok.md', 7));
		expect(store.read('leaf-1', 'ex.txt')).toBeUndefined();
	});

	it('leaves a leaf record whose path the file layer never held alone', () => {
		const db = makeDb({ 'other.md': { scroll: 1 } });
		db.pruneDb = () => {
			delete db.db['other.md'];
			return 1;
		};
		const { store } = makeStore(db);
		// No file record ever existed for new.md: "absent from the db" must not
		// be read as "just pruned".
		setLeafStates(store, [['leaf-1', rec('new.md', 42)]]);

		store.pruneDatabase();

		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('new.md', 42));
	});

	it('writes the overlay out when it dropped records (the settings panel is not a persist point)', () => {
		const db = makeDb({ 'ex.txt': { scroll: 1 } });
		db.pruneDb = () => {
			delete db.db['ex.txt'];
			return 1;
		};
		const { store } = makeStore(db);
		setLeafStates(store, [['leaf-1', rec('ex.txt', 42)]]);

		store.pruneDatabase();

		expect(persisted()).toEqual({});
	});
});

describe('pruneDeadLeaves', () => {
	it('drops records of leaves that are gone and keeps the live ones', () => {
		const { store } = makeStore();
		setLeafStates(store, [
			['leaf-live', rec('a.md', 1)],
			['leaf-closed', rec('a.md', 2)],
		]);

		expect(store.pruneDeadLeaves(new Set(['leaf-live']))).toBe(true);
		expect(leafStatesOf(store).has('leaf-closed')).toBe(false);
		expect(leafStatesOf(store).get('leaf-live')).toEqual(rec('a.md', 1));
		// Nothing to drop → false, so callers can skip the persist.
		expect(store.pruneDeadLeaves(new Set(['leaf-live']))).toBe(false);
	});
});
