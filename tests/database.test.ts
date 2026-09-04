// Unit tests for CursorPositionDatabase (src/database.ts): the compact
// on-disk codec (write → read round trip), corrupted-data hardening, empty
// record / tombstone dropping, setState recency bookkeeping, capacity
// trimming with hysteresis, folder exclusions, rename/delete bookkeeping,
// the external-sync merge rule (disk wins unless the key was touched after
// our last flush), and switchDbFile move/adopt semantics.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { TFile } from 'obsidian';

// i18n resolves the locale from window.moment at module load; provide a
// stand-in before src/database (and its i18n import) is evaluated.
vi.hoisted(() => {
	(window as unknown as { moment: unknown }).moment = { locale: () => 'en' };
});

import { CursorPositionDatabase } from '../src/database';
import { DEFAULT_SETTINGS, type PluginSettings } from '../src/types';

const DB_PATH = '.obsidian/plugins/position-restore/positions.json';

const POINT = (line: number, ch: number) => ({ from: { line, ch }, to: { line, ch } });

type DbInternals = { keyTouchedAt: Map<string, number> };
const internals = (db: CursorPositionDatabase) => db as unknown as DbInternals;

function makeHarness(files: Record<string, string> = {}, settings: Partial<PluginSettings> = {}) {
	let mtime = 1000;
	// Simulates another device replacing a file behind our back.
	const externalWrite = (p: string, data: string) => {
		files[p] = data;
		mtime += 1;
	};
	const adapter = {
		exists: vi.fn(async (p: string) => p in files),
		read: vi.fn(async (p: string) => {
			if (!(p in files)) throw new Error('ENOENT');
			return files[p];
		}),
		write: vi.fn(async (p: string, data: string) => {
			files[p] = data;
			mtime += 1;
		}),
		remove: vi.fn(async (p: string) => {
			delete files[p];
			mtime += 1;
		}),
		rename: vi.fn(async (from: string, to: string) => {
			if (!(from in files)) throw new Error('ENOENT');
			files[to] = files[from];
			delete files[from];
			mtime += 1;
		}),
		mkdir: vi.fn(async () => undefined),
		stat: vi.fn(async (p: string) => (p in files ? { mtime } : null)),
	};
	// frontmatters maps vault file paths to the frontmatter the metadata
	// cache reports for them; a path missing from the map means "file does not
	// exist / not parsed yet". Tests mutate the map to simulate frontmatter
	// edits and lazy parsing.
	const frontmatters: Record<string, unknown> = {};
	const app = {
		vault: {
			adapter,
			getAbstractFileByPath: vi.fn((p: string) =>
				p in frontmatters ? Object.assign(Object.create(TFile.prototype), { path: p }) : null
			),
		},
		metadataCache: {
			getFileCache: vi.fn((f: { path: string }) =>
				f.path in frontmatters ? { frontmatter: frontmatters[f.path] } : null
			),
		},
	};
	const plugin = {
		app,
		manifest: { dir: '.obsidian/plugins/position-restore' },
		saveSettings: vi.fn(),
	};
	const merged = { ...DEFAULT_SETTINGS, ...settings };
	const db = new CursorPositionDatabase(plugin as never, merged);
	return { db, frontmatters, adapter, files, externalWrite, settings: merged };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('record codec (write → read round trip)', () => {
	it('persists a scroll-only record as [scroll]', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { scroll: 120 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"a.md":[120]}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 120 });
	});

	it('persists a point cursor as [scroll, line, ch] and restores from === to', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { cursor: POINT(3, 7) });
		await db.writeDb();
		// no scroll saved → scroll slot is 0; decode treats 0 as "no scroll"
		expect(files[DB_PATH]).toBe('{"a.md":[0,3,7]}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ cursor: POINT(3, 7) });
	});

	it('persists a selection as [scroll, from.line, from.ch, to.line, to.ch]', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } } });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"a.md":[42,1,2,3,4]}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } } });
	});

	it('skips empty records (incl. scroll 0) on write and stops rewriting when clean', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('empty.md', {});
		db.setState('zero.md', { scroll: 0 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{}');
		expect(db.dbDirty).toBe(false);

		await db.writeDb();
		expect(adapter.write).toHaveBeenCalledTimes(1);
	});
});

describe('corrupted data hardening (readDb / parseDb)', () => {
	it('a missing file yields an empty db without attempting a read', async () => {
		const { db, adapter } = makeHarness();
		await db.readDb();
		expect(db.db).toEqual({});
		expect(adapter.read).not.toHaveBeenCalled();
	});

	it('malformed JSON degrades to an empty db', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db, files } = makeHarness({ [DB_PATH]: '{oops' });
		await db.readDb();
		expect(db.db).toEqual({});
	});

	it('non-object JSON degrades to an empty db', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '"just a string"' });
		await db.readDb();
		expect(db.db).toEqual({});
	});

	it('non-array values are dropped, arrays are kept', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":{"x":1},"b.md":[5]}' });
		await db.readDb();
		expect(db.db).toEqual({ 'b.md': { scroll: 5 } });
	});

	it('non-numeric members yield an empty record instead of leaking garbage', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[1,"x",2]}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': {} });
	});

	it('a [0] tombstone decodes to an empty record and is never written back', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[0]}' });
		await db.readDb();
		expect(Object.keys(db.db)).toEqual(['a.md']);
		expect(db.db['a.md']).toEqual({});

		db.setState('b.md', { scroll: 1 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"b.md":[1]}');
	});
});

describe('setState recency bookkeeping', () => {
	it('re-setting an older key moves it to the end of insertion order', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		db.setState('b.md', { scroll: 2 });
		db.setState('c.md', { scroll: 3 });
		expect(Object.keys(db.db)).toEqual(['a.md', 'b.md', 'c.md']);

		db.setState('a.md', { scroll: 11 });
		expect(Object.keys(db.db)).toEqual(['b.md', 'c.md', 'a.md']);
		expect(db.db['a.md']).toEqual({ scroll: 11 });
	});

	it('re-setting the most recent key overwrites in place', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		db.setState('b.md', { scroll: 2 });
		db.setState('c.md', { scroll: 3 });
		db.setState('c.md', { scroll: 33 });
		expect(Object.keys(db.db)).toEqual(['a.md', 'b.md', 'c.md']);
		expect(db.db['c.md']).toEqual({ scroll: 33 });
	});

	it('marks the db dirty', () => {
		const { db } = makeHarness();
		expect(db.dbDirty).toBe(false);
		db.setState('a.md', { scroll: 1 });
		expect(db.dbDirty).toBe(true);
	});
});

describe('capacity trimming', () => {
	it('keeps the newest TRIM_TARGET entries once the cap is exceeded', () => {
		const { db } = makeHarness();
		for (let i = 1; i <= 751; i++)
			db.setState(`f${i}`, { scroll: i });

		expect(db.pruneDb()).toBe(189); // 751 - floor(750 * 3/4)
		expect(Object.keys(db.db)).toHaveLength(562);
		expect(db.db['f1']).toBeUndefined(); // oldest dropped
		expect(db.db['f190']).toBeDefined(); // first survivor
		expect(db.db['f751']).toBeDefined(); // newest kept
		// touch-stamp orphans are pruned alongside their records
		expect(internals(db).keyTouchedAt.size).toBe(562);
	});

	it('is a no-op at or under the cap', () => {
		const { db } = makeHarness();
		for (let i = 1; i <= 750; i++)
			db.setState(`f${i}`, { scroll: i });

		expect(db.pruneDb()).toBe(0);
		expect(Object.keys(db.db)).toHaveLength(750);
	});
});

describe('folder exclusions', () => {
	it('removes records for excluded folders (exact match or subfolder), not mere prefix matches', () => {
		const { db } = makeHarness({}, { excludedFolders: ['notes'] });
		db.setState('notes', { scroll: 1 }); // a root file named exactly "notes"
		db.setState('notes/a.md', { scroll: 1 });
		db.setState('notes/sub/b.md', { scroll: 1 });
		db.setState('notes2/c.md', { scroll: 1 });
		db.setState('other/notes.md', { scroll: 1 });
		db.setState('d.md', { scroll: 1 });

		expect(db.pruneDb()).toBe(3);
		expect(Object.keys(db.db).sort()).toEqual(['d.md', 'notes2/c.md', 'other/notes.md']);
	});
});

describe('frontmatter exclusions', () => {
	it('removes records for the escape-hatch `position-restore: false`', () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 1 });
		h.frontmatters['a.md'] = { 'position-restore': false };

		expect(h.db.pruneDb()).toBe(1);
		expect(Object.keys(h.db.db)).toEqual([]);
	});

	it('removes records for files containing the configured exclusion property, whatever its value', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish'] });
		h.db.setState('a.md', { scroll: 1 });
		h.db.setState('b.md', { scroll: 1 });
		h.frontmatters['a.md'] = { publish: false };
		h.frontmatters['b.md'] = { publish: true };

		expect(h.db.pruneDb()).toBe(2);
		expect(Object.keys(h.db.db)).toEqual([]);
	});

	it('removes records only when the exclusion property matches its configured value', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish: true'] });
		h.db.setState('a.md', { scroll: 1 });
		h.db.setState('b.md', { scroll: 1 });
		h.frontmatters['a.md'] = { publish: true };
		h.frontmatters['b.md'] = { publish: false };

		expect(h.db.pruneDb()).toBe(1);
		expect(Object.keys(h.db.db)).toEqual(['b.md']);
	});

	it('removes records matching ANY of several configured properties', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish', 'status: draft'] });
		h.db.setState('a.md', { scroll: 1 });
		h.db.setState('b.md', { scroll: 1 });
		h.db.setState('c.md', { scroll: 1 });
		h.frontmatters['a.md'] = { status: 'draft' };
		h.frontmatters['b.md'] = { publish: true };
		h.frontmatters['c.md'] = { title: 'x' };

		expect(h.db.pruneDb()).toBe(2);
		expect(Object.keys(h.db.db)).toEqual(['c.md']);
	});

	it('keeps records the escape hatch explicitly forces (`position-restore: true`)', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish'] });
		h.db.setState('a.md', { scroll: 1 });
		h.frontmatters['a.md'] = { 'position-restore': true, publish: true };

		expect(h.db.pruneDb()).toBe(0);
		expect(Object.keys(h.db.db)).toEqual(['a.md']);
	});

	it('ignores escape-hatch values that are not boolean or "true"/"false" strings', () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 1 });
		h.frontmatters['a.md'] = { 'position-restore': 1 };

		expect(h.db.pruneDb()).toBe(0);
		expect(Object.keys(h.db.db)).toEqual(['a.md']);
	});

	it('prunes records for the string marker `position-restore: "false"`', () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 1 });
		// Obsidian's properties UI stores text-typed values quoted ("false").
		h.frontmatters['a.md'] = { 'position-restore': 'false' };

		expect(h.db.pruneDb()).toBe(1);
		expect(Object.keys(h.db.db)).toEqual([]);
	});

	it('keeps records for files the metadata cache has not parsed yet (lazy parsing)', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish'] });
		h.db.setState('a.md', { scroll: 1 });
		// frontmatters stays empty → "not parsed" → the record survives here;
		// the recording gate drops it on the file's next open/poll instead.

		expect(h.db.pruneDb()).toBe(0);
		expect(Object.keys(h.db.db)).toEqual(['a.md']);
	});
});

describe('renameFile / deleteFile', () => {
	it('moves the record and its touch stamp to the new path', () => {
		const { db } = makeHarness();
		db.setState('old.md', { scroll: 1 });

		db.renameFile('new.md', 'old.md');

		expect(db.db['new.md']).toEqual({ scroll: 1 });
		expect(db.db['old.md']).toBeUndefined();
		expect(db.dbDirty).toBe(true);
		const stamps = internals(db).keyTouchedAt;
		expect(stamps.has('new.md')).toBe(true);
		expect(stamps.has('old.md')).toBe(false);
	});

	it('renaming an untracked file is a no-op', () => {
		const { db } = makeHarness();
		db.renameFile('new.md', 'old.md');
		expect(db.dbDirty).toBe(false);
	});

	it('deletes the record and its touch stamp', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });

		db.deleteFile('a.md');

		expect(db.db['a.md']).toBeUndefined();
		expect(internals(db).keyTouchedAt.has('a.md')).toBe(false);
		expect(db.dbDirty).toBe(true);
	});

	it('deleting an untracked file is a no-op', () => {
		const { db } = makeHarness();
		db.deleteFile('a.md');
		expect(db.dbDirty).toBe(false);
	});
});

describe('mergeExternalChanges (multi-device sync)', () => {
	it('is a no-op when the mtime is unchanged', async () => {
		const { db, adapter } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		await db.mergeExternalChanges();
		expect(adapter.read).not.toHaveBeenCalled();
	});

	it('disk wins for untouched keys; disk-only keys are adopted; memory-only keys are kept', async () => {
		const { db, externalWrite } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		db.setState('b.md', { scroll: 2 });
		await db.writeDb();

		externalWrite(DB_PATH, JSON.stringify({ 'a.md': [9, 1, 1], 'c.md': [7] }));
		await db.mergeExternalChanges();

		expect(db.db['a.md']).toEqual({ scroll: 9, cursor: POINT(1, 1) });
		expect(db.db['b.md']).toEqual({ scroll: 2 });
		expect(db.db['c.md']).toEqual({ scroll: 7 });
		expect(db.dbDirty).toBe(false); // merges never mark dirty
	});

	it('a key touched after the last flush wins over the disk copy', async () => {
		vi.useFakeTimers();
		try {
			const { db, externalWrite } = makeHarness();
			db.setState('a.md', { scroll: 1 });
			await db.writeDb(); // flush at T
			vi.advanceTimersByTime(10);
			db.setState('a.md', { scroll: 100 }); // touched at T+10

			externalWrite(DB_PATH, JSON.stringify({ 'a.md': [9, 1, 1] }));
			await db.mergeExternalChanges();
			expect(db.db['a.md']).toEqual({ scroll: 100 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('a torn external file leaves the db untouched', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db, externalWrite } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		externalWrite(DB_PATH, '{torn');
		await db.mergeExternalChanges();
		expect(db.db['a.md']).toEqual({ scroll: 1 });
	});

	it('a missing external file keeps what we have', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		delete files[DB_PATH];
		await db.mergeExternalChanges();
		expect(db.db['a.md']).toEqual({ scroll: 1 });
		expect(adapter.read).not.toHaveBeenCalled();
	});

	it('a flush does not clobber a foreign file while a sync merge is in flight', async () => {
		const { db, adapter, externalWrite, files } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		// Another device lands a new record while we run.
		externalWrite(DB_PATH, JSON.stringify({ 'a.md': [1], 'c.md': [7] }));

		// Stall the first read so the sync merge and the flush's pre-write
		// merge overlap. The flush must wait for the merge, not bail and
		// write over the newer file.
		const origRead = adapter.read.getMockImplementation()!;
		let reads = 0;
		adapter.read.mockImplementation(async (p: string) => {
			const data = await origRead(p);
			if (++reads === 1)
				await new Promise(res => setTimeout(res, 20));
			return data;
		});

		db.setState('b.md', { scroll: 2 }); // a local change makes the flush dirty
		const inFlight = db.mergeExternalChanges(); // do not await yet
		await db.writeDb();
		await inFlight;

		const written = JSON.parse(files[DB_PATH]);
		expect(written['c.md']).toEqual([7]); // foreign record survived
		expect(written['b.md']).toEqual([2]);
	});
});

describe('switchDbFile', () => {
	it('rejects invalid paths without touching anything', async () => {
		const { db, adapter } = makeHarness();
		for (const bad of ['/abs.json', 'a\\b.json', 'x/../y.json', 'notjson.txt'])
			expect(await db.switchDbFile(bad)).toBe(false);
		expect(adapter.rename).not.toHaveBeenCalled();
		expect(adapter.write).not.toHaveBeenCalled();
		expect(adapter.remove).not.toHaveBeenCalled();
	});

	it('accepts the empty path when already on the default file', async () => {
		const { db } = makeHarness();
		expect(await db.switchDbFile('')).toBe(true);
	});

	it('moves the db file to the new vault-root path', async () => {
		const { db, files, adapter } = makeHarness({ [DB_PATH]: '{"a.md":[5]}' });

		expect(await db.switchDbFile('new.json')).toBe(true);
		expect(files['new.json']).toBe('{"a.md":[5]}');
		expect(DB_PATH in files).toBe(false);
		expect(adapter.rename).toHaveBeenCalledWith(DB_PATH, 'new.json');
	});

	it('refuses when the parent folder does not exist', async () => {
		const { db, files } = makeHarness();
		expect(await db.switchDbFile('missing/new.json')).toBe(false);
		expect(Object.keys(files)).toHaveLength(0);
	});

	it('adopts an existing target file, removes the old one, and keeps locally touched records', async () => {
		const { db, files } = makeHarness({
			[DB_PATH]: '{"c.md":[5]}',
			'new.json': '{"t.md":[9,1,1]}',
		});
		await db.readDb();
		db.setState('local.md', { scroll: 3 });

		expect(await db.switchDbFile('new.json')).toBe(true);
		expect(DB_PATH in files).toBe(false); // old file removed (move semantics)
		expect(db.db['t.md']).toEqual({ scroll: 9, cursor: POINT(1, 1) }); // adopted
		expect(db.db['c.md']).toEqual({ scroll: 5 }); // kept
		expect(db.db['local.md']).toEqual({ scroll: 3 }); // touched locally → wins
		expect(db.dbDirty).toBe(true); // adopted records flush on the next write
	});
});
