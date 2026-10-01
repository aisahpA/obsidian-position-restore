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

describe('记录编解码（写入 → 读回）', () => {
	it('只有顶行的记录写成 {"s":n}', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { scroll: 120 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":120,"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 120, time: expect.any(Number) });
	});

	it('点光标写成 {"c":[l,ch,l,ch]}，读回后仍是 from === to', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { cursor: POINT(3, 7) });
		await db.writeDb();
		// no scroll saved → scroll slot is 0; decode treats 0 as "no scroll"
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"c":[3,7,3,7],"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ cursor: POINT(3, 7), time: expect.any(Number) });
	});

	it('(0,0) 的塌陷光标是编辑器的默认值，所以按墓碑写', async () => {
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

	it('打开后没动过的记录写成 {} —— 它的光标停在 frontmatter 的默认位置上', async () => {
		const { db, files, fmPositions } = makeHarness();
		// frontmatter occupies lines 0..4, so Obsidian opens with the cursor on
		// line 5 — what "nothing happened" looks like in a vault with YAML.
		fmPositions['a.md'] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		db.setState('a.md', { cursor: POINT(5, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"t":' + db.db['a.md'].time + '}}}');
	});

	it('读者真的把光标放到 frontmatter 之下的，要留住', async () => {
		const { db, files, fmPositions } = makeHarness();
		fmPositions['a.md'] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		db.setState('a.md', { cursor: POINT(13, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"c":[13,0,13,0],"t":' + db.db['a.md'].time + '}}}');
	});

	it('有选区的写成 {"s":n,"c":[fl,fc,tl,tc]}', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } } });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":42,"c":[1,2,3,4],"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } }, time: expect.any(Number) });
	});

	it('空记录写成墓碑，干净之后就不再重写', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('empty.md', {});
		db.setState('zero.md', { scroll: 0 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"empty.md":{"t":' + db.db['empty.md'].time + '},"zero.md":{"t":' + db.db['zero.md'].time + '}}}');
		expect(db.dbDirty).toBe(false);

		await db.writeDb();
		expect(adapter.write).toHaveBeenCalledTimes(1);
	});

	it('归档时就盖上采集戳，已有的戳不动', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 5 });
		expect(db.db['a.md'].time).toEqual(expect.any(Number));

		// Moving a record to another path is not the reader moving.
		db.setState('b.md', { ...db.db['a.md'] });
		expect(db.db['b.md'].time).toBe(db.db['a.md'].time);
	});
});

describe('坏数据加固（readDb / parseDb）', () => {
	it('文件不存在时给出空库，既不去读也不抱怨', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		consoleError.mockClear();
		const { db, adapter, files } = makeHarness();
		await db.readDb();

		expect(db.db).toEqual({});
		expect(copies(files)).toEqual([]);
		// The leading stat doubles as the existence check, so a first run costs
		// a single round-trip and says nothing — there is nothing to report.
		expect(adapter.read).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('能读的库照常读，不留副本', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[5]}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': { scroll: 5 } });
		expect(copies(files)).toEqual([]);
	});

	it('JSON 坏了：库变空、字节留一份副本、并且告诉用户', async () => {
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

	it('非对象的 JSON 同样读不了（一个裸数组不是库）', async () => {
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

	it('随后的那次落盘会替换掉这个文件，副本不动', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db, files } = makeHarness({ [DB_PATH]: '{oops' });
		await db.readDb();

		db.setState('a.md', { scroll: 1 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{"s":1,"t":' + db.db['a.md'].time + '}}}');
		expect(copies(files)).toHaveLength(1);
		expect(files[copies(files)[0]]).toBe('{oops');
	});

	it('每种读不出来的内容只留一份副本，不按重试次数留', async () => {
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

	it('外部文件解析不了时，已经在内存里的记录要留住', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = makeHarness({ [DB_PATH]: '{"a.md":[120]}' });
		await h.db.readDb();
		expect(h.db.db).toEqual({ 'a.md': { scroll: 120 } });

		h.externalWrite(DB_PATH, '{torn');
		await h.db.mergeExternalChanges();
		expect(h.db.db).toEqual({ 'a.md': { scroll: 120 } });
		expect(h.files[copies(h.files)[0]]).toBe('{torn');
	});

	it('读不出来（但不是解析不了）的文件只记日志，不留副本', async () => {
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

	it('连副本都没留下时要说一声', async () => {
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

	it('schema 之前的数组格式仍然读得出来', async () => {
		const { db } = makeHarness({ [DB_PATH]: '{"a.md":[5],"b.md":[0,3,7]}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': { scroll: 5 }, 'b.md': { cursor: POINT(3, 7) } });
	});

	it('记录里不认识的字段被忽略', async () => {
		const { db } = makeHarness({ [DB_PATH]: '{"schema":2,"positions":{"a.md":{"s":5,"nope":1}}}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': { scroll: 5 } });
	});

	it('成员不是数字时给出空记录，而不是漏出脏数据', async () => {
		// A schema 1 file holds arrays by contract; anything else is unreadable
		// data and yields an empty record too.
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[1,"x",2],"b.md":{"s":5}}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': {}, 'b.md': {} });
	});

	it('[0] 墓碑解成空记录，写回去时也仍是空记录', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[0]}' });
		await db.readDb();
		expect(Object.keys(db.db)).toEqual(['a.md']);
		expect(db.db['a.md']).toEqual({});

		db.setState('b.md', { scroll: 1 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":2,"positions":{"a.md":{},"b.md":{"s":1,"t":' + db.db['b.md'].time + '}}}');
	});
});

describe('setState 的新旧记账', () => {
	it('重设一个较旧的键，会把它挪到插入顺序的末尾', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		db.setState('b.md', { scroll: 2 });
		db.setState('c.md', { scroll: 3 });
		expect(Object.keys(db.db)).toEqual(['a.md', 'b.md', 'c.md']);

		db.setState('a.md', { scroll: 11 });
		expect(Object.keys(db.db)).toEqual(['b.md', 'c.md', 'a.md']);
		expect(db.db['a.md']).toEqual({ scroll: 11, time: expect.any(Number) });
	});

	it('重设最新的那个键是原地覆盖', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		db.setState('b.md', { scroll: 2 });
		db.setState('c.md', { scroll: 3 });
		db.setState('c.md', { scroll: 33 });
		expect(Object.keys(db.db)).toEqual(['a.md', 'b.md', 'c.md']);
		expect(db.db['c.md']).toEqual({ scroll: 33, time: expect.any(Number) });
	});

	it('把库标脏', () => {
		const { db } = makeHarness();
		expect(db.dbDirty).toBe(false);
		db.setState('a.md', { scroll: 1 });
		expect(db.dbDirty).toBe(true);
	});
});

describe('容量裁剪', () => {
	it('超过上限后只留最新的 TRIM_TARGET 条', () => {
		const { db } = makeHarness();
		for (let i = 1; i <= 751; i++)
			db.setState(`f${i}`, { scroll: i });

		expect(db.pruneDb()).toBe(189); // 751 - floor(750 * 3/4)
		expect(Object.keys(db.db)).toHaveLength(562);
		expect(db.db['f1']).toBeUndefined(); // oldest dropped
		expect(db.db['f190']).toBeDefined(); // first survivor
		expect(db.db['f751']).toBeDefined(); // newest kept
	});

	it('没到上限时什么都不做', () => {
		const { db } = makeHarness();
		for (let i = 1; i <= 750; i++)
			db.setState(`f${i}`, { scroll: i });

		expect(db.pruneDb()).toBe(0);
		expect(Object.keys(db.db)).toHaveLength(750);
	});
});

describe('按文件夹排除', () => {
	it('按文件夹排除是全等或子孙文件夹命中才删，光有前缀不算', () => {
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

describe('按 frontmatter 排除', () => {
	it('逃生舱写了 `position-restore: false` 的记录要删', () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 1 });
		h.frontmatters['a.md'] = { 'position-restore': false };

		expect(h.db.pruneDb()).toBe(1);
		expect(Object.keys(h.db.db)).toEqual([]);
	});

	it('带着所配排除属性的文件不论取值是什么，记录都删', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish'] });
		h.db.setState('a.md', { scroll: 1 });
		h.db.setState('b.md', { scroll: 1 });
		h.frontmatters['a.md'] = { publish: false };
		h.frontmatters['b.md'] = { publish: true };

		expect(h.db.pruneDb()).toBe(2);
		expect(Object.keys(h.db.db)).toEqual([]);
	});

	it('排除属性的值也要跟配置对上才删', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish: true'] });
		h.db.setState('a.md', { scroll: 1 });
		h.db.setState('b.md', { scroll: 1 });
		h.frontmatters['a.md'] = { publish: true };
		h.frontmatters['b.md'] = { publish: false };

		expect(h.db.pruneDb()).toBe(1);
		expect(Object.keys(h.db.db)).toEqual(['b.md']);
	});

	it('命中若干配置属性中的任意一个就删', () => {
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

	it('逃生舱明确指定要留的，留住（`position-restore: true`）', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish'] });
		h.db.setState('a.md', { scroll: 1 });
		h.frontmatters['a.md'] = { 'position-restore': true, publish: true };

		expect(h.db.pruneDb()).toBe(0);
		expect(Object.keys(h.db.db)).toEqual(['a.md']);
	});

	it('逃生舱取值不是布尔、也不是 "true"/"false" 字符串时，忽略它', () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 1 });
		h.frontmatters['a.md'] = { 'position-restore': 1 };

		expect(h.db.pruneDb()).toBe(0);
		expect(Object.keys(h.db.db)).toEqual(['a.md']);
	});

	it('字符串形式的标记 `position-restore: "false"` 照样删', () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 1 });
		// Obsidian's properties UI stores text-typed values quoted ("false").
		h.frontmatters['a.md'] = { 'position-restore': 'false' };

		expect(h.db.pruneDb()).toBe(1);
		expect(Object.keys(h.db.db)).toEqual([]);
	});

	it('metadata 缓存还没解析的文件（懒解析），记录留住', () => {
		const h = makeHarness({}, { frontmatterExcludeProperties: ['publish'] });
		h.db.setState('a.md', { scroll: 1 });
		// frontmatters stays empty → "not parsed" → the record survives here;
		// the recording gate drops it on the file's next open/poll instead.

		expect(h.db.pruneDb()).toBe(0);
		expect(Object.keys(h.db.db)).toEqual(['a.md']);
	});
});

describe('renameFile / deleteFile', () => {
	it('记录连同采集戳一起挪到新路径', () => {
		const { db } = makeHarness();
		db.setState('old.md', { scroll: 1, time: 1000 });

		db.renameFile('new.md', 'old.md');

		expect(db.db['new.md']).toEqual({ scroll: 1, time: 1000 });
		expect(db.db['old.md']).toBeUndefined();
		expect(db.dbDirty).toBe(true);
	});

	it('重命名没记过的文件是空操作', () => {
		const { db } = makeHarness();
		db.renameFile('new.md', 'old.md');
		expect(db.dbDirty).toBe(false);
	});

	it('删掉这条记录', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 1 });

		db.deleteFile('a.md');

		expect(db.db['a.md']).toBeUndefined();
		expect(db.dbDirty).toBe(true);
	});

	it('删除没记过的文件是空操作', () => {
		const { db } = makeHarness();
		db.deleteFile('a.md');
		expect(db.dbDirty).toBe(false);
	});
});

describe('mergeExternalChanges（跨设备同步）', () => {
	it('mtime 没变时什么都不做', async () => {
		const { db, adapter } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		await db.mergeExternalChanges();
		expect(adapter.read).not.toHaveBeenCalled();
	});

	it('同一个键采得更晚的赢；只有盘上有的键被采纳；只有内存有的键留住', async () => {
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

	it('外面的采集比我们更早时让位给我们 —— 过去就是这种同步把人打回页顶', async () => {
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

	it('戳相等时留我们自己的；`t` 出现之前写的记录算最旧', async () => {
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

	it('上次落盘之后又动过的键，赢过盘上那份', async () => {
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

	it('外部文件写坏了（截断）时库不动', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db, externalWrite } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		externalWrite(DB_PATH, '{torn');
		await db.mergeExternalChanges();
		expect(db.db['a.md']).toEqual({ scroll: 1, time: expect.any(Number) });
	});

	it('外部文件不见了时保留我们手上的', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('a.md', { scroll: 1 });
		await db.writeDb();

		delete files[DB_PATH];
		await db.mergeExternalChanges();
		expect(db.db['a.md']).toEqual({ scroll: 1, time: expect.any(Number) });
		expect(adapter.read).not.toHaveBeenCalled();
	});

	it('同步合并还在进行时，落盘不许盖掉别人写来的文件', async () => {
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

describe('writeDb 的落盘竞态（落盘中途到达的 setState 不许丢）', () => {
	it('写入进行中到来的 setState 要保持脏标记，由下一次落盘把它写下去', async () => {
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

	it('落盘期间被碰过的键，在下一次外部合并里仍然赢过盘上那份', async () => {
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
	it('路径不合法就拒绝，一处都不动', async () => {
		const { db, adapter } = makeHarness();
		for (const bad of ['/abs.json', 'a\\b.json', 'x/../y.json', 'notjson.txt'])
			expect(await db.switchDbFile(bad)).toBe(false);
		expect(adapter.rename).not.toHaveBeenCalled();
		expect(adapter.write).not.toHaveBeenCalled();
		expect(adapter.remove).not.toHaveBeenCalled();
	});

	it('本来就在默认文件上时，空路径也接受', async () => {
		const { db } = makeHarness();
		expect(await db.switchDbFile('')).toBe(true);
	});

	it('把库文件挪到新的 vault 根路径下', async () => {
		const { db, files, adapter } = makeHarness({ [DB_PATH]: '{"a.md":[5]}' });

		expect(await db.switchDbFile('new.json')).toBe(true);
		expect(files['new.json']).toBe('{"a.md":[5]}');
		expect(DB_PATH in files).toBe(false);
		expect(adapter.rename).toHaveBeenCalledWith(DB_PATH, 'new.json');
	});

	it('父文件夹不存在就创建，而不是拒绝', async () => {
		const { db, files, adapter } = makeHarness({ [DB_PATH]: '{"a.md":[5]}' });
		expect(await db.switchDbFile('missing/new.json')).toBe(true);
		expect(adapter.mkdir).toHaveBeenCalledWith('missing');
		expect(files['missing/new.json']).toBe('{"a.md":[5]}');
	});

	it('目标文件已存在就采纳、删掉旧的，本地动过的记录留住', async () => {
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

	it('目标已存在但不是位置库时拒绝，一处不改', async () => {
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

	it('空但合法的库文件也采纳', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"a.md":[5]}', 'new.json': '{}' });
		await db.readDb();

		expect(await db.switchDbFile('new.json')).toBe(true);
		expect(DB_PATH in files).toBe(false);
		expect(db.db['a.md']).toEqual({ scroll: 5 });
	});
});

describe('schema 版本与旧文件', () => {
	it('写成 schema 2，读回自己的文件时不出声', async () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 5 });
		await h.db.writeDb();
		expect(JSON.parse(h.files[DB_PATH]).schema).toBe(2);

		h.db.db = {};
		await h.db.readDb();
		expect(h.db.db['a.md']).toEqual({ scroll: 5, time: expect.any(Number) });
		expect(messages()).toEqual([]);
	});

	it('读到 schema 之前的旧文件会迁移，并且只提示一次', async () => {
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

	it('只有当旧版本写者盖掉了我们的当前文件时才报告', async () => {
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

	it('更新版插件写的文件照样读，不拒绝', async () => {
		const h = makeHarness({
			[DB_PATH]: '{"schema":3,"positions":{"a.md":{"s":5,"c":[1,0,1,0],"t":1695}},"extra":{}}',
		});
		await h.db.readDb();
		// the fields we share are read; the one we do not know is ignored
		expect(h.db.db['a.md']).toEqual({ scroll: 5, cursor: POINT(1, 0), time: 1695 });
		expect(messages()).toEqual([]);
	});

	it('别的设备传来更晚的墓碑，会清掉本地的位置', async () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 50, time: 1000 });
		await h.db.writeDb();

		h.externalWrite(DB_PATH, JSON.stringify({ schema: 2, positions: { 'a.md': { t: 2000 } } }));
		await h.db.mergeExternalChanges();
		expect(h.db.db['a.md']).toEqual({ time: 2000 });
	});
});

describe('墓碑淘汰', () => {
	it('超过上限时先淘汰墓碑，才轮到真位置', () => {
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

	it('打开后没动过的记录也排在真位置前面淘汰', () => {
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

	it('刚滚到顶的笔记要留得比更旧的真位置更优先', () => {
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

describe('countDefaultPosition', () => {
	it('只数那些没有任何位置的记录，一条不多数', () => {
		const { db, fmPositions } = makeHarness();
		// Same open-default line for both: frontmatter ends at line 4, so the
		// app parks the cursor on line 5.
		const fm = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		for (const p of ['a.md', 'c.md'] as const)
			fmPositions[p] = fm;

		db.setState('a.md', { cursor: POINT(5, 0) }); // parked on the default
		db.setState('b.md', {});                      // tombstone
		db.setState('c.md', { cursor: POINT(9, 0) }); // a real line
		db.setState('d.md', { scroll: 40 });          // a real scroll

		expect(db.countDefaultPosition()).toBe(2);
	});
});
