// Unit tests for CursorPositionDatabase (src/database.ts): the compact
// on-disk codec (write → read round trip), unreadable-data hardening (an
// unparseable file is copied aside and reported, never silently cleared),
// empty record / tombstone dropping, setState recency bookkeeping, capacity
// trimming with hysteresis, folder exclusions, rename/delete bookkeeping,
// the external-sync merge rule (disk wins unless the key was touched after
// our last flush), and switchDbFile move/adopt semantics.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { Notice, TFile } from 'obsidian';

// i18n resolves the locale from window.moment at module load; provide a
// stand-in before src/database (and its i18n import) is evaluated.
vi.hoisted(() => {
	(window as unknown as { moment: unknown }).moment = { locale: () => 'en' };
});

import { CursorPositionDatabase } from '@/position/storage/database';
import { t } from '@/i18n';
import { DEFAULT_SETTINGS, type PluginSettings } from '@/types';

const DB_PATH = '.obsidian/plugins/position-restore/positions.json';
const PLUGIN_DIR = '.obsidian/plugins/position-restore';

// Side copies of unreadable db content (the timestamp in the name varies).
const copies = (files: Record<string, string>): string[] =>
	Object.keys(files).filter((p) => p.startsWith(`${PLUGIN_DIR}/positions.corrupt-`)).sort();

// The test stub's Notice records what the user was told and for how long; the
// obsidian typings only declare the real constructor.
type StubNotice = { message: string; duration: number | undefined };
const notices = (): StubNotice[] =>
	(Notice as unknown as { instances: StubNotice[] }).instances;
const messages = (): string[] => notices().map((n) => n.message);
const resetNotices = (): void => (Notice as unknown as { reset: () => void }).reset();

const POINT = (line: number, ch: number) => ({ from: { line, ch }, to: { line, ch } });

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
	// The frontmatter block's span per path, as metadataCache reports it in
	// frontmatterPosition — set without a `frontmatter` entry, so the cursor's
	// open-default line can be tested on its own.
	const fmPositions: Record<string, unknown> = {};
	const known = (p: string) => p in frontmatters || p in fmPositions;
	const app = {
		vault: {
			adapter,
			getAbstractFileByPath: vi.fn((p: string) =>
				known(p) ? Object.assign(Object.create(TFile.prototype), { path: p }) : null
			),
		},
		metadataCache: {
			getFileCache: vi.fn((f: { path: string }) =>
				known(f.path)
					? { frontmatter: frontmatters[f.path], frontmatterPosition: fmPositions[f.path] }
					: null
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
	return { db, frontmatters, fmPositions, adapter, files, externalWrite, settings: merged };
}

afterEach(() => {
	vi.restoreAllMocks();
	resetNotices();
});

describe('record codec (write → read round trip)', () => {
	it('persists a scroll-only record as {"s":n}', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { scroll: 120 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":120,"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 120, time: expect.any(Number) });
	});

	it('persists a point cursor as {"c":[l,ch,l,ch]} and restores from === to', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { cursor: POINT(3, 7) });
		await db.writeDb();
		// no scroll saved → scroll slot is 0; decode treats 0 as "no scroll"
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"c":[3,7,3,7],"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ cursor: POINT(3, 7), time: expect.any(Number) });
	});

	it('a collapsed cursor at (0,0) is the editor default, so it is written as a tombstone', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { cursor: POINT(0, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"t":' + db.db['a.md'].time + '}}}');

		// One already on disk (written before the rule, or by another device)
		// reads back as the tombstone it really is, not as a position.
		files[DB_PATH] = '{"schema":2,"positions":{"b.md":{"c":[0,0,0,0]}}}';
		db.db = {};
		await db.readDb();
		expect(db.db['b.md']).toEqual({});
	});

	it('writes an untouched-open record as {} — its cursor is the frontmatter default', async () => {
		const { db, files, fmPositions } = makeHarness();
		// frontmatter occupies lines 0..4, so Obsidian opens with the cursor on
		// line 5 — what "nothing happened" looks like in a vault with YAML.
		fmPositions['a.md'] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		db.setState('a.md', { cursor: POINT(5, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"t":' + db.db['a.md'].time + '}}}');
	});

	it('keeps a cursor the reader actually placed below the frontmatter', async () => {
		const { db, files, fmPositions } = makeHarness();
		fmPositions['a.md'] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		db.setState('a.md', { cursor: POINT(13, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"c":[13,0,13,0],"t":' + db.db['a.md'].time + '}}}');
	});

	it('persists a selection as {"s":n,"c":[fl,fc,tl,tc]}', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } } });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":42,"c":[1,2,3,4],"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } }, time: expect.any(Number) });
	});

	it('writes empty records as tombstones and stops rewriting when clean', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('empty.md', {});
		db.setState('zero.md', { scroll: 0 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"empty.md":{"t":' + db.db['empty.md'].time + '},"zero.md":{"t":' + db.db['zero.md'].time + '}}}');
		expect(db.dbDirty).toBe(false);

		await db.writeDb();
		expect(adapter.write).toHaveBeenCalledTimes(1);
	});

	it('stamps a record as it is filed, and leaves the stamp it already has', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 5 });
		expect(db.db['a.md'].time).toEqual(expect.any(Number));

		// Moving a record to another path is not the reader moving.
		db.setState('b.md', { ...db.db['a.md'] });
		expect(db.db['b.md'].time).toBe(db.db['a.md'].time);
	});
});

describe('corrupted data hardening (readDb / parseDb)', () => {
	it('a missing file yields an empty db without attempting a read', async () => {
		const { db, adapter } = makeHarness();
		await db.readDb();
		expect(db.db).toEqual({});
		expect(adapter.read).not.toHaveBeenCalled();
	});

	it('a readable db is read and leaves no copy behind', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[5]}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': { scroll: 5 } });
		expect(copies(files)).toEqual([]);
	});

	it('malformed JSON: empty db, a copy of the bytes, and the user told', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db, files } = makeHarness({ [DB_PATH]: '{oops' });
		await db.readDb();

		expect(db.db).toEqual({});
		expect(copies(files)).toHaveLength(1);
		expect(files[copies(files)[0]]).toBe('{oops');
		// the unreadable file itself stays put — the next flush replaces it
		expect(files[DB_PATH]).toBe('{oops');
		expect(messages()).toEqual([expect.stringContaining(copies(files)[0])]);
		// duration 0 = Obsidian keeps it on screen until the user dismisses it:
		// the loss is not something to be missed while looking elsewhere
		expect(notices().map((n) => n.duration)).toEqual([0]);
	});

	it('non-object JSON is unreadable too (a bare array is not a db)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const stringy = makeHarness({ [DB_PATH]: '"just a string"' });
		await stringy.db.readDb();
		expect(stringy.db.db).toEqual({});
		expect(copies(stringy.files)).toHaveLength(1);

		const array = makeHarness({ [DB_PATH]: '[]' });
		await array.db.readDb();
		expect(array.db.db).toEqual({});
		expect(copies(array.files)).toHaveLength(1);
	});

	it('the flush that follows replaces the file and leaves the copy untouched', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db, files } = makeHarness({ [DB_PATH]: '{oops' });
		await db.readDb();

		db.setState('a.md', { scroll: 1 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":1,"t":' + db.db['a.md'].time + '}}}');
		expect(copies(files)).toHaveLength(1);
		expect(files[copies(files)[0]]).toBe('{oops');
	});

	it('keeps one copy per distinct unreadable content, not one per retry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = makeHarness({ [DB_PATH]: '{oops' });
		await h.db.readDb();
		expect(copies(h.files)).toHaveLength(1);

		// the retry loop reading the same unreadable content again must not
		// spawn a second copy — or repeat the notice
		await h.db.mergeExternalChanges();
		expect(copies(h.files)).toHaveLength(1);
		expect(messages()).toHaveLength(1);

		// different bytes are a different loss
		h.externalWrite(DB_PATH, '<<<<<<< LOCAL\n{}');
		await h.db.mergeExternalChanges();
		expect(copies(h.files)).toHaveLength(2);
		expect(messages()).toHaveLength(1);
	});

	it('records already in memory survive an unparseable external file', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = makeHarness({ [DB_PATH]: '{"a.md":[120]}' });
		await h.db.readDb();
		expect(h.db.db).toEqual({ 'a.md': { scroll: 120 } });

		h.externalWrite(DB_PATH, '{torn');
		await h.db.mergeExternalChanges();
		expect(h.db.db).toEqual({ 'a.md': { scroll: 120 } });
		expect(h.files[copies(h.files)[0]]).toBe('{torn');
	});

	it('an unreadable (not unparseable) file is logged without a copy', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = makeHarness({ [DB_PATH]: '{"a.md":[1]}' });
		h.adapter.read.mockImplementation(async () => {
			throw new Error('EACCES');
		});
		await h.db.readDb();
		expect(h.db.db).toEqual({});
		expect(copies(h.files)).toEqual([]);
		expect(messages()).toEqual([]);
	});

	it('says so when not even a copy could be kept', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = makeHarness({ [DB_PATH]: '{oops' });
		h.adapter.write.mockImplementation(async () => {
			throw new Error('EROFS');
		});
		await h.db.readDb();
		expect(h.db.db).toEqual({});
		expect(messages()).toEqual([t('dataStorage.corruptDb.noticeNoCopy')]);
		expect(notices().map((n) => n.duration)).toEqual([0]);
	});

	it('pre-schema arrays still read', async () => {
		const { db } = makeHarness({ [DB_PATH]: '{"a.md":[5],"b.md":[0,3,7]}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': { scroll: 5 }, 'b.md': { cursor: POINT(3, 7) } });
	});

	it('unknown fields in a record are ignored', async () => {
		const { db } = makeHarness({ [DB_PATH]: '{"schema":2,"positions":{"a.md":{"s":5,"nope":1}}}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': { scroll: 5 } });
	});

	it('non-numeric members yield an empty record instead of leaking garbage', async () => {
		// A schema 1 file holds arrays by contract; anything else is unreadable
		// data and yields an empty record too.
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[1,"x",2],"b.md":{"s":5}}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': {}, 'b.md': {} });
	});

	it('a [0] tombstone decodes to an empty record, and is written back as one', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[0]}' });
		await db.readDb();
		expect(Object.keys(db.db)).toEqual(['a.md']);
		expect(db.db['a.md']).toEqual({});

		db.setState('b.md', { scroll: 1 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{},"b.md":{"s":1,"t":' + db.db['b.md'].time + '}}}');
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
		expect(db.db['a.md']).toEqual({ scroll: 11, time: expect.any(Number) });
	});

	it('re-setting the most recent key overwrites in place', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		db.setState('b.md', { scroll: 2 });
		db.setState('c.md', { scroll: 3 });
		db.setState('c.md', { scroll: 33 });
		expect(Object.keys(db.db)).toEqual(['a.md', 'b.md', 'c.md']);
		expect(db.db['c.md']).toEqual({ scroll: 33, time: expect.any(Number) });
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
	it('moves the record to the new path, capture stamp included', () => {
		const { db } = makeHarness();
		db.setState('old.md', { scroll: 1, time: 1000 });

		db.renameFile('new.md', 'old.md');

		expect(db.db['new.md']).toEqual({ scroll: 1, time: 1000 });
		expect(db.db['old.md']).toBeUndefined();
		expect(db.dbDirty).toBe(true);
	});

	it('renaming an untracked file is a no-op', () => {
		const { db } = makeHarness();
		db.renameFile('new.md', 'old.md');
		expect(db.dbDirty).toBe(false);
	});

	it('deletes the record', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });

		db.deleteFile('a.md');

		expect(db.db['a.md']).toBeUndefined();
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

	it('the later capture wins a shared key; disk-only keys are adopted; memory-only keys are kept', async () => {
		const { db, externalWrite } = makeHarness();
		db.setState('a.md', { scroll: 1, time: 1000 });
		db.setState('b.md', { scroll: 2 });
		await db.writeDb();

		externalWrite(DB_PATH, JSON.stringify({
			schema: 2,
			positions: { 'a.md': { s: 9, c: [1, 1, 1, 1], t: 2000 }, 'c.md': { s: 7, t: 2000 } },
		}));
		await db.mergeExternalChanges();

		expect(db.db['a.md']).toEqual({ scroll: 9, cursor: POINT(1, 1), time: 2000 });
		expect(db.db['b.md']).toEqual({ scroll: 2, time: expect.any(Number) });
		expect(db.db['c.md']).toEqual({ scroll: 7, time: 2000 });
		expect(db.dbDirty).toBe(false); // merges never mark dirty
	});

	it('an EARLIER external capture yields to ours — the sync that used to send us back to the top', async () => {
		const { db, externalWrite } = makeHarness();
		db.setState('a.md', { scroll: 300, time: 5000 });
		await db.writeDb();

		// the other device stopped reading this note long before we did
		externalWrite(DB_PATH, JSON.stringify({
			schema: 2, positions: { 'a.md': { s: 0, t: 1000 } },
		}));
		await db.mergeExternalChanges();

		expect(db.db['a.md']).toEqual({ scroll: 300, time: 5000 });
	});

	it('equal stamps keep ours, and a record written before `t` existed counts as oldest', async () => {
		const { db, externalWrite } = makeHarness();
		db.setState('a.md', { scroll: 300, time: 1000 });
		db.setState('b.md', { scroll: 300, time: 1000 });
		await db.writeDb();

		// a.md: the same stamp; b.md: none at all (a writer from before `t`)
		externalWrite(DB_PATH, JSON.stringify({
			schema: 2, positions: { 'a.md': { s: 9, t: 1000 }, 'b.md': { s: 9 } },
		}));
		await db.mergeExternalChanges();

		expect(db.db['a.md']).toEqual({ scroll: 300, time: 1000 });
		expect(db.db['b.md']).toEqual({ scroll: 300, time: 1000 });
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
			expect(db.db['a.md']).toEqual({ scroll: 100, time: expect.any(Number) });
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
		expect(db.db['a.md']).toEqual({ scroll: 1, time: expect.any(Number) });
	});

	it('a missing external file keeps what we have', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		delete files[DB_PATH];
		await db.mergeExternalChanges();
		expect(db.db['a.md']).toEqual({ scroll: 1, time: expect.any(Number) });
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

		const written = JSON.parse(files[DB_PATH]).positions;
		expect(written['c.md']).toEqual({ s: 7 }); // foreign record survived
		expect(written['b.md']).toEqual({ s: 2, t: expect.any(Number) });
	});
});

describe('writeDb flush race (setState landing mid-flush is not lost)', () => {
	it('a setState during an in-flight write stays dirty and is persisted by the next flush', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('a.md', { scroll: 2 });
		// Kept aside: the concurrent setState below replaces the record, and
		// with it the stamp — this is the one the first flush carried.
		const flushedStamp = db.db['a.md'].time;

		// Land a concurrent setState synchronously at the start of the actual
		// adapter write — i.e. after writeDb has already serialized its
		// snapshot. This is exactly where the 100ms poll interleaves in real
		// usage.
		const origWrite = adapter.write.getMockImplementation()!;
		let injected = false;
		adapter.write.mockImplementation(async (p: string, data: string) => {
			if (!injected) {
				injected = true;
				db.setState('a.md', { scroll: 3 });
			}
			return origWrite(p, data);
		});

		await db.writeDb();

		// The flush captured scroll 2 (its snapshot predates the setState),
		// but the concurrent change must NOT be cleared by it.
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":2,"t":' + flushedStamp + '}}}');
		expect(db.dbDirty).toBe(true);

		// The next flush persists the newer value.
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":3,"t":' + db.db['a.md'].time + '}}}');
		expect(db.dbDirty).toBe(false);
	});

	it('a key touched during a flush still beats the disk copy in the next external merge', async () => {
		vi.useFakeTimers();
		try {
			const { db, adapter, externalWrite } = makeHarness();
			db.setState('a.md', { scroll: 2 });

			const origWrite = adapter.write.getMockImplementation()!;
			let injected = false;
			adapter.write.mockImplementation(async (p: string, data: string) => {
				if (!injected) {
					injected = true;
					// Real disk I/O takes longer than a millisecond; model that
					// so the concurrent touch's stamp is strictly after the
					// flush's snapshot moment (lastFlushTime).
					vi.advanceTimersByTime(10);
					db.setState('a.md', { scroll: 3 });
				}
				return origWrite(p, data);
			});

			await db.writeDb();
			expect(db.dbDirty).toBe(true); // the concurrent change survived the flush

			// A foreign file lands on disk. lastFlushTime reads as the flush's
			// snapshot moment — BEFORE the concurrent touch — so the in-memory
			// scroll 3 is treated as locally newer than the flushed disk copy.
			externalWrite(DB_PATH, JSON.stringify({ 'a.md': [9, 1, 1] }));
			await db.mergeExternalChanges();
			expect(db.db['a.md']).toEqual({ scroll: 3, time: expect.any(Number) });
		} finally {
			vi.useRealTimers();
		}
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

	it('creates a missing parent folder instead of refusing', async () => {
		const { db, files, adapter } = makeHarness({ [DB_PATH]: '{"a.md":[5]}' });
		expect(await db.switchDbFile('missing/new.json')).toBe(true);
		expect(adapter.mkdir).toHaveBeenCalledWith('missing');
		expect(files['missing/new.json']).toBe('{"a.md":[5]}');
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
		expect(db.db['local.md']).toEqual({ scroll: 3, time: expect.any(Number) }); // touched locally → wins
		expect(db.dbDirty).toBe(true); // adopted records flush on the next write
	});

	it('refuses an existing non-database JSON file without changing anything', async () => {
		const { db, files, adapter } = makeHarness({
			[DB_PATH]: '{"a.md":[5]}',
			'package.json': '{"name":"x","deps":["a"]}',
			// Numeric arrays pass the value check; only the outer note-path
			// key check rejects this one.
			'chart.json': '{"series":[1,2,3],"axis":[0]}',
		});
		await db.readDb();

		expect(await db.switchDbFile('package.json')).toBe(false);
		expect(await db.switchDbFile('chart.json')).toBe(false);
		expect(DB_PATH in files).toBe(true); // real db kept
		expect(files['package.json']).toBe('{"name":"x","deps":["a"]}');
		expect(db.db['a.md']).toEqual({ scroll: 5 }); // memory kept
		expect(adapter.remove).not.toHaveBeenCalled();
	});

	it('adopts an empty but valid database file', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[5]}', 'new.json': '{}' });
		await db.readDb();

		expect(await db.switchDbFile('new.json')).toBe(true);
		expect(DB_PATH in files).toBe(false);
		expect(db.db['a.md']).toEqual({ scroll: 5 });
	});
});

describe('schema version and legacy files', () => {
	it('writes schema 2 and reads its own file back in silence', async () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 5 });
		await h.db.writeDb();
		expect(JSON.parse(h.files[DB_PATH]).schema).toBe(2);

		h.db.db = {};
		await h.db.readDb();
		expect(h.db.db['a.md']).toEqual({ scroll: 5, time: expect.any(Number) });
		expect(messages()).toEqual([]);
	});

	it('reads a pre-schema file, migrates it, and says so once', async () => {
		const h = makeHarness({ [DB_PATH]: '{"a.md":[5],"b.md":[0,3,7]}' });
		await h.db.readDb();
		expect(h.db.db['a.md']).toEqual({ scroll: 5 });
		expect(h.db.db['b.md']).toEqual({ cursor: POINT(3, 7) });
		expect(messages()).toEqual([t('dataStorage.legacyDb.notice')]);
		expect(notices().map((n) => n.duration)).toEqual([0]);

		// the same old file seen again is not news
		h.db.db = {};
		await h.db.readDb();
		expect(messages()).toHaveLength(1);
	});

	it('reports an older writer only when it replaces a current file of ours', async () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 5 });
		await h.db.writeDb();
		expect(messages()).toEqual([]);

		// another device still running the old plugin overwrites it
		h.externalWrite(DB_PATH, JSON.stringify({ 'a.md': [9] }));
		await h.db.mergeExternalChanges();
		// A pre-`t` record is the oldest there is, so ours stands. The file
		// still changed hands, which is what the notice is about.
		expect(h.db.db['a.md']).toEqual({ scroll: 5, time: expect.any(Number) });
		expect(messages()).toEqual([t('dataStorage.legacyDb.noticeOverwritten')]);

		// still old afterwards: already said, do not repeat
		h.externalWrite(DB_PATH, JSON.stringify({ 'a.md': [10] }));
		await h.db.mergeExternalChanges();
		expect(messages()).toHaveLength(1);
	});

	it('a file from a newer plugin version is read, not rejected', async () => {
		const h = makeHarness({
			[DB_PATH]: '{"schema":3,"positions":{"a.md":{"s":5,"c":[1,0,1,0],"t":1695}},"extra":{}}',
		});
		await h.db.readDb();
		// the fields we share are read; the one we do not know is ignored
		expect(h.db.db['a.md']).toEqual({ scroll: 5, cursor: POINT(1, 0), time: 1695 });
		expect(messages()).toEqual([]);
	});

	it('a LATER tombstone from another device clears the local position', async () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 50, time: 1000 });
		await h.db.writeDb();

		h.externalWrite(DB_PATH, JSON.stringify({ schema: 2, positions: { 'a.md': { t: 2000 } } }));
		await h.db.mergeExternalChanges();
		expect(h.db.db['a.md']).toEqual({ time: 2000 });
	});
});

describe('tombstone eviction', () => {
	it('evicts tombstones before real positions once the cap is exceeded', () => {
		const { db } = makeHarness();
		// 800 records, half of them tombstones
		for (let i = 1; i <= 800; i++)
			db.setState(`f${i}`, i % 2 === 0 ? {} : { scroll: i });

		db.pruneDb();
		const keys = Object.keys(db.db);
		expect(keys).toHaveLength(562);

		// every real position survived; the 238 dropped all came from the
		// tombstones (400 - 238 = 162 of them remain)
		const live = keys.filter((k) => db.db[k].scroll !== undefined);
		const tombs = keys.filter((k) => db.db[k].scroll === undefined);
		expect(live).toHaveLength(400);
		expect(tombs).toHaveLength(162);
	});

	it('evicts untouched-open records before real positions', () => {
		const { db, fmPositions } = makeHarness();
		// 800 records, half of them merely opened: the cursor sits on the line
		// after the frontmatter, so they carry no position at all.
		for (let i = 1; i <= 800; i++) {
			const path = `f${i}.md`;
			fmPositions[path] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
			db.setState(path, i % 2 === 0 ? { cursor: POINT(5, 0) } : { scroll: i });
		}

		db.pruneDb();
		const keys = Object.keys(db.db);
		expect(keys).toHaveLength(562);
		// every real position survived; the 238 dropped all came from the
		// untouched opens (400 - 238 = 162 of them remain)
		expect(keys.filter((k) => db.db[k].scroll !== undefined)).toHaveLength(400);
		expect(keys.filter((k) => db.db[k].scroll === undefined)).toHaveLength(162);
	});

	it('keeps a just-topped note ahead of an older real position', () => {
		const { db } = makeHarness();
		// 800 records: the oldest 250 hold real positions, everything newer is
		// a tombstone — the newest of all is the note just scrolled to the top.
		for (let i = 1; i <= 800; i++)
			db.setState(`f${i}`, i <= 250 ? { scroll: i } : {});

		db.pruneDb();
		expect(Object.keys(db.db)).toHaveLength(562);
		// Cheapness reaches only outside the recency window, so the 238 dropped
		// all come from the oldest tombstones: no real position is lost, and
		// the note topped last is still there.
		expect(db.db['f1']).toEqual({ scroll: 1, time: expect.any(Number) });
		expect(db.db['f250']).toEqual({ scroll: 250, time: expect.any(Number) });
		expect(db.db['f800']).toEqual({ time: expect.any(Number) });
	});
});
