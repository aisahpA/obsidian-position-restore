// CursorPositionDatabase（src/database.ts）的单元测试：紧凑的落盘编解码（写入 →
// 读回一轮）、坏数据加固（解析不了的文件被复制到旁边并上报，绝不悄悄清掉）、空记录 /
// 墓碑的淘汰、setState 的新旧记账、带滞回的容量裁剪、文件夹排除、改名/删除记账、
// 外部同步的合并规则（盘上那份赢，除非该键在我们上次落盘之后被动过），以及
// switchDbFile 的移动/采纳语义。

import { describe, it, expect, vi, afterEach } from 'vitest';

import { Notice, TFile } from 'obsidian';

// i18n 在模块加载时从 window.moment 解析出 locale；所以要在 src/database（以及它的
// i18n import）被求值之前先放一个替身。
vi.hoisted(() => {
	(window as unknown as { moment: unknown }).moment = { locale: () => 'en' };
});

import { CursorPositionDatabase } from '@/position/storage/database';
import { t } from '@/i18n';
import { DEFAULT_SETTINGS, type PluginSettings } from '@/types';

const DB_PATH = '.obsidian/plugins/position-restore/position-restore-data.json';
const PLUGIN_DIR = '.obsidian/plugins/position-restore';

// 读不出来的库内容旁边的那些副本（名字里的时间戳是变的）。
const copies = (files: Record<string, string>): string[] =>
	Object.keys(files).filter((p) => p.startsWith(`${PLUGIN_DIR}/position-restore-data.corrupt-`)).sort();

// 测试桩的 Notice 记下用户被告知了什么、以及展示了多久；obsidian 的类型声明里只有
// 真实的构造函数。
type StubNotice = { message: string; duration: number | undefined };
const notices = (): StubNotice[] =>
	(Notice as unknown as { instances: StubNotice[] }).instances;
const messages = (): string[] => notices().map((n) => n.message);
const resetNotices = (): void => (Notice as unknown as { reset: () => void }).reset();

const POINT = (line: number, ch: number) => ({ from: { line, ch }, to: { line, ch } });

function makeHarness(files: Record<string, string> = {}, settings: Partial<PluginSettings> = {}) {
	let mtime = 1000;
	// 模拟另一台设备在我们背后换掉一个文件。
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
	// frontmatters 把 vault 里的文件路径映射到元数据缓存为它们报告的 frontmatter；映射里
	// 缺席的路径意味着「文件不存在 / 还没解析」。测试改动这张映射，来模拟 frontmatter
	// 被编辑和惰性解析。
	const frontmatters: Record<string, unknown> = {};
	// 每个路径的 frontmatter 块的跨度，就是 metadataCache 在 frontmatterPosition 里报告的
	// 那个 —— 设置时**不带** `frontmatter` 条目，好让光标那个「打开时的默认行」能单独被
	// 测到。
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
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"s":120,"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 120, time: expect.any(Number) });
	});

	it('点光标写成 {"c":[l,ch,l,ch]}，读回后仍是 from === to', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { cursor: POINT(3, 7) });
		await db.writeDb();
		// 没存 scroll → scroll 槽是 0；解码把 0 当成「没有 scroll」
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"c":[3,7,3,7],"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ cursor: POINT(3, 7), time: expect.any(Number) });
	});

	it('(0,0) 的塌陷光标是编辑器的默认值，所以按墓碑写', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { cursor: POINT(0, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"t":' + db.db['a.md'].time + '}}}');

		// 盘上已经有的那一个（在这条规则之前写的、或另一台设备写的），读回来时是它真正的样子
		// —— 一条墓碑，而不是一个位置。
		files[DB_PATH] = '{"schema":2,"positions":{"b.md":{"c":[0,0,0,0]}}}';
		db.db = {};
		await db.readDb();
		expect(db.db['b.md']).toEqual({});
	});

	it('打开后没动过的记录写成 {} —— 它的光标停在 frontmatter 的默认位置上', async () => {
		const { db, files, fmPositions } = makeHarness();
		// frontmatter 占着第 0..4 行，所以 Obsidian 打开时光标在第 5 行 —— 这就是一个带 YAML
		// 的 vault 里「什么都没发生」的样子。
		fmPositions['a.md'] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		db.setState('a.md', { cursor: POINT(5, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"t":' + db.db['a.md'].time + '}}}');
	});

	it('读者真的把光标放到 frontmatter 之下的，要留住', async () => {
		const { db, files, fmPositions } = makeHarness();
		fmPositions['a.md'] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		db.setState('a.md', { cursor: POINT(13, 0) });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"c":[13,0,13,0],"t":' + db.db['a.md'].time + '}}}');
	});

	it('有选区的写成 {"s":n,"c":[fl,fc,tl,tc]}', async () => {
		const { db, files } = makeHarness();
		db.setState('a.md', { scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } } });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"s":42,"c":[1,2,3,4],"t":' + db.db['a.md'].time + '}}}');

		db.db = {};
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 42, cursor: { from: { line: 1, ch: 2 }, to: { line: 3, ch: 4 } }, time: expect.any(Number) });
	});

	it('空记录写成墓碑，干净之后就不再重写', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('empty.md', {});
		db.setState('zero.md', { scroll: 0 });
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"empty.md":{"t":' + db.db['empty.md'].time + '},"zero.md":{"t":' + db.db['zero.md'].time + '}}}');
		expect(db.dbDirty).toBe(false);

		await db.writeDb();
		expect(adapter.write).toHaveBeenCalledTimes(1);
	});

	it('归档时就盖上采集戳，已有的戳不动', () => {
		const { db } = makeHarness();
		db.setState('a.md', { scroll: 5 });
		expect(db.db['a.md'].time).toEqual(expect.any(Number));

		// 把一条记录挪到另一个路径，不是读者在动。
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
		// 开头那次 stat 顺带兼作存在性检查，所以第一次运行只花一轮往返、而且一声不吭 ——
		// 没有任何东西要报告。
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
		// 读不出来的那个文件本身留在原地 —— 下一次落盘会把它替换掉
		expect(files[DB_PATH]).toBe('{oops');
		expect(messages()).toEqual([expect.stringContaining(copies(files)[0])]);
		// duration 为 0 = Obsidian 会把它留在屏幕上直到用户关掉：这份损失不该在读者看向别处时
		// 被错过
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
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"s":1,"t":' + db.db['a.md'].time + '}}}');
		expect(copies(files)).toHaveLength(1);
		expect(files[copies(files)[0]]).toBe('{oops');
	});

	it('每种读不出来的内容只留一份副本，不按重试次数留', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const h = makeHarness({ [DB_PATH]: '{oops' });
		await h.db.readDb();
		expect(copies(h.files)).toHaveLength(1);

		// 重试循环再次读到同一份读不出来的内容时，不许再生成第二份副本 —— 也不许重复那条提示
		await h.db.mergeExternalChanges();
		expect(copies(h.files)).toHaveLength(1);
		expect(messages()).toHaveLength(1);

		// 不同的字节是另一次损失
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

	// schema 3 只是把容器键从 `positions` 改名成 `lastPositions`，记录形状一模一样 ——
	// 所以旧文件整份读得出来，改名不丢位置。
	it('schema 2 的 positions 旧文件照样读出来，下一次落盘整份写成 schema 3', async () => {
		const { db, files } = makeHarness({ [DB_PATH]: '{"schema":2,"positions":{"a.md":{"s":7,"c":[1,2,1,2],"t":1695}}}' });
		await db.readDb();
		expect(db.db['a.md']).toEqual({ scroll: 7, cursor: POINT(1, 2), time: 1695 });

		// 读回来不脏 —— 得像真实会话那样动一下，落盘才会发生（writeDb 有 dirty 闸门）。
		db.setState('b.md', { scroll: 1 });
		await db.writeDb();
		const written = JSON.parse(files[DB_PATH]);
		expect(written.schema).toBe(3);
		expect(written.lastPositions).toEqual({
			'a.md': { s: 7, c: [1, 2, 1, 2], t: 1695 },
			'b.md': { s: 1, t: expect.any(Number) },
		});
	});

	it('记录里不认识的字段被忽略', async () => {
		const { db } = makeHarness({ [DB_PATH]: '{"schema":2,"positions":{"a.md":{"s":5,"nope":1}}}' });
		await db.readDb();
		expect(db.db).toEqual({ 'a.md': { scroll: 5 } });
	});

	it('成员不是数字时给出空记录，而不是漏出脏数据', async () => {
		// schema 1 的文件按理是一堆数组；别的东西都是读不出来的数据，也产出一条空记录。
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
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{},"b.md":{"s":1,"t":' + db.db['b.md'].time + '}}}');
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

		expect(db.pruneDb()).toBe(189); // 751 - floor(750 * 3/4) 条被丢掉
		expect(Object.keys(db.db)).toHaveLength(562);
		expect(db.db['f1']).toBeUndefined(); // 最旧的被丢掉
		expect(db.db['f190']).toBeDefined(); // 第一个活下来的
		expect(db.db['f751']).toBeDefined(); // 最新的留住
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
		db.setState('notes', { scroll: 1 }); // 一个名字恰好就是 "notes" 的根文件
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
		// frontmatters 保持为空 → 「还没解析」→ 这条记录在这儿留住了；改由记录闸门在这个文件
		// 下次打开/轮询时把它丢掉。

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
		expect(db.dbDirty).toBe(false); // 合并从不标脏
	});

	it('外面的采集比我们更早时让位给我们 —— 过去就是这种同步把人打回页顶', async () => {
		const { db, externalWrite } = makeHarness();
		db.setState('a.md', { scroll: 300, time: 5000 });
		await db.writeDb();

		// 另一台设备停止读这篇笔记的时间比我们早得多
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

		// a.md：同一个戳；b.md：压根没有戳（一个来自 `t` 出现之前的写者）
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
			await db.writeDb(); // 在 T 时刻落盘
			vi.advanceTimersByTime(10);
			db.setState('a.md', { scroll: 100 }); // 在 T+10 被碰过

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

		// 我们跑着的时候，另一台设备落了一条新记录。
		externalWrite(DB_PATH, JSON.stringify({ 'a.md': [1], 'c.md': [7] }));

		// 把第一次读取拖住，好让同步合并与落盘前的那次合并重叠。落盘必须等这次合并，而不是
		// 掉头走开、把更新的那份文件盖掉。
		const origRead = adapter.read.getMockImplementation()!;
		let reads = 0;
		adapter.read.mockImplementation(async (p: string) => {
			const data = await origRead(p);
			if (++reads === 1)
				await new Promise(res => setTimeout(res, 20));
			return data;
		});

		db.setState('b.md', { scroll: 2 }); // 一次本地改动让落盘变脏
		const inFlight = db.mergeExternalChanges(); // 先不 await
		await db.writeDb();
		await inFlight;

		const written = JSON.parse(files[DB_PATH]).lastPositions;
		expect(written['c.md']).toEqual({ s: 7 }); // 外来的记录活了下来
		expect(written['b.md']).toEqual({ s: 2, t: expect.any(Number) });
	});
});

describe('writeDb 的落盘竞态（落盘中途到达的 setState 不许丢）', () => {
	it('写入进行中到来的 setState 要保持脏标记，由下一次落盘把它写下去', async () => {
		const { db, adapter, files } = makeHarness();
		db.setState('a.md', { scroll: 2 });
		// 先留一份：下面那个并发的 setState 会替换掉这条记录，连带替换掉它的戳 —— 而首次落盘
		// 带下去的正是这一个。
		const flushedStamp = db.db['a.md'].time;

		// 在真正写 adapter 的那一刻同步落下一个并发 setState —— 也就是 writeDb 已经序列化完
		// 它那份快照之后。真实使用中 100ms 的轮询恰好就是插在这儿。
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

		// 这次落盘采到的是 scroll 2（它的快照早于那个 setState），但那次并发的改动绝不能被它
		// 清掉。
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"s":2,"t":' + flushedStamp + '}}}');
		expect(db.dbDirty).toBe(true);

		// 下一次落盘会把更新的那个值写下去。
		await db.writeDb();
		expect(files[DB_PATH]).toBe('{"schema":3,"lastPositions":{"a.md":{"s":3,"t":' + db.db['a.md'].time + '}}}');
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
					// 真实的磁盘 I/O 不止一毫秒；照这个建模，好让那次并发触碰的戳严格晚于落盘采快照的
					// 那一刻（lastFlushTime）。
					vi.advanceTimersByTime(10);
					db.setState('a.md', { scroll: 3 });
				}
				return origWrite(p, data);
			});

			await db.writeDb();
			expect(db.dbDirty).toBe(true); // 那次并发的改动挺过了这次落盘

			// 一个外来的文件落到盘上。lastFlushTime 读出来是落盘采快照的那一刻 —— **早于**那次
			// 并发触碰 —— 所以内存里的 scroll 3 会被当成比落盘出去的那份盘上副本更新。
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
		expect(DB_PATH in files).toBe(false); // 旧文件被删掉（移动语义）
		expect(db.db['t.md']).toEqual({ scroll: 9, cursor: POINT(1, 1) }); // 被采纳
		expect(db.db['c.md']).toEqual({ scroll: 5 }); // 留住
		expect(db.db['local.md']).toEqual({ scroll: 3, time: expect.any(Number) }); // 本地碰过 → 赢
		expect(db.dbDirty).toBe(true); // 采纳进来的记录在下一次写入时落盘
	});

	it('目标已存在但不是位置库时拒绝，一处不改', async () => {
		const { db, files, adapter } = makeHarness({
			[DB_PATH]: '{"a.md":[5]}',
			'package.json': '{"name":"x","deps":["a"]}',
			// 数字数组能通过值的检查；只有外层「笔记路径」这一道键检查会把它拒掉。
			'chart.json': '{"series":[1,2,3],"axis":[0]}',
		});
		await db.readDb();

		expect(await db.switchDbFile('package.json')).toBe(false);
		expect(await db.switchDbFile('chart.json')).toBe(false);
		expect(DB_PATH in files).toBe(true); // 真正的库留住
		expect(files['package.json']).toBe('{"name":"x","deps":["a"]}');
		expect(db.db['a.md']).toEqual({ scroll: 5 }); // 内存里的留住
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
		expect(JSON.parse(h.files[DB_PATH]).schema).toBe(3);

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

		// 同一个旧文件再看一遍不是新闻
		h.db.db = {};
		await h.db.readDb();
		expect(messages()).toHaveLength(1);
	});

	it('只有当旧版本写者盖掉了我们的当前文件时才报告', async () => {
		const h = makeHarness();
		h.db.setState('a.md', { scroll: 5 });
		await h.db.writeDb();
		expect(messages()).toEqual([]);

		// 另一台还在跑旧版插件的设备把它覆盖了
		h.externalWrite(DB_PATH, JSON.stringify({ 'a.md': [9] }));
		await h.db.mergeExternalChanges();
		// 一条没有 `t` 的记录是最旧的，所以我们那份站得住。但这个文件仍然易了主，而那条提示讲的
		// 正是这件事。
		expect(h.db.db['a.md']).toEqual({ scroll: 5, time: expect.any(Number) });
		expect(messages()).toEqual([t('dataStorage.legacyDb.noticeOverwritten')]);

		// 之后仍然是旧的：已经说过了，不要再重复
		h.externalWrite(DB_PATH, JSON.stringify({ 'a.md': [10] }));
		await h.db.mergeExternalChanges();
		expect(messages()).toHaveLength(1);
	});

	it('更新版插件写的文件照样读，不拒绝', async () => {
		const h = makeHarness({
			[DB_PATH]: '{"schema":4,"lastPositions":{"a.md":{"s":5,"c":[1,0,1,0],"t":1695}},"extra":{}}',
		});
		await h.db.readDb();
		// 我们共有的字段读出来；我们不认识的那个被忽略
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

// 默认数据文件从 `positions.json` 改叫 `position-restore-data.json`：只在用的是默认位置时
// 把旧文件搬过来 —— 搬字节，不重编码（重编码要 metadataCache，而 readDb 跑在它就绪之前）。
describe('默认数据文件改名', () => {
	const LEGACY_PATH = `${PLUGIN_DIR}/positions.json`;

	it('插件目录里那份旧默认文件被搬成新名字', async () => {
		const { db, files } = makeHarness({ [LEGACY_PATH]: '{"a.md":[7]}' });
		await db.readDb();
		expect(files[LEGACY_PATH]).toBeUndefined();
		expect(files[DB_PATH]).toBe('{"a.md":[7]}');
		expect(db.db['a.md']).toEqual({ scroll: 7 });
	});

	it('新名字已经有文件时不动旧文件', async () => {
		const { db, files } = makeHarness({
			[LEGACY_PATH]: '{"a.md":[7]}',
			[DB_PATH]: '{"b.md":[9]}',
		});
		await db.readDb();
		expect(files[LEGACY_PATH]).toBe('{"a.md":[7]}');
		expect(db.db['b.md']).toEqual({ scroll: 9 });
	});

	// 自定义路径是用户明确选定的，插件不碰它 —— 那一类库升级后还在原处，靠 schema 迁移。
	it('用户自定义了路径时，旧默认文件原样留着', async () => {
		const custom = 'x/plugins-data/positions.json';
		const { db, files } = makeHarness(
			{ [custom]: '{"a.md":[7]}', [LEGACY_PATH]: '{"b.md":[9]}' },
			{ dbFileName: custom }
		);
		await db.readDb();
		expect(files[LEGACY_PATH]).toBe('{"b.md":[9]}');
		expect(db.db['a.md']).toEqual({ scroll: 7 });
	});
});

describe('墓碑淘汰', () => {
	it('超过上限时先淘汰墓碑，才轮到真位置', () => {
		const { db } = makeHarness();
		// 800 条记录，其中一半是墓碑
		for (let i = 1; i <= 800; i++)
			db.setState(`f${i}`, i % 2 === 0 ? {} : { scroll: i });

		db.pruneDb();
		const keys = Object.keys(db.db);
		expect(keys).toHaveLength(562);

		// 每一个真实位置都活了下来；被丢掉的 238 个全部来自墓碑（400 - 238 = 162 个留下）
		const live = keys.filter((k) => db.db[k].scroll !== undefined);
		const tombs = keys.filter((k) => db.db[k].scroll === undefined);
		expect(live).toHaveLength(400);
		expect(tombs).toHaveLength(162);
	});

	it('打开后没动过的记录也排在真位置前面淘汰', () => {
		const { db, fmPositions } = makeHarness();
		// 800 条记录，其中一半只是被打开过：光标停在 frontmatter 之后那一行，所以它们根本不带
		// 任何位置。
		for (let i = 1; i <= 800; i++) {
			const path = `f${i}.md`;
			fmPositions[path] = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
			db.setState(path, i % 2 === 0 ? { cursor: POINT(5, 0) } : { scroll: i });
		}

		db.pruneDb();
		const keys = Object.keys(db.db);
		expect(keys).toHaveLength(562);
		// 每一个真实位置都活了下来；被丢掉的 238 个全部来自那些没动过的打开（400 - 238 = 162
		// 个留下）
		expect(keys.filter((k) => db.db[k].scroll !== undefined)).toHaveLength(400);
		expect(keys.filter((k) => db.db[k].scroll === undefined)).toHaveLength(162);
	});

	it('刚滚到顶的笔记要留得比更旧的真位置更优先', () => {
		const { db } = makeHarness();
		// 800 条记录：最旧的 250 个握着真实位置，更新的全都是墓碑 —— 其中最新的那个是刚滚到
		// 顶部的笔记。
		for (let i = 1; i <= 800; i++)
			db.setState(`f${i}`, i <= 250 ? { scroll: i } : {});

		db.pruneDb();
		expect(Object.keys(db.db)).toHaveLength(562);
		// 「廉价」只够得到新鲜窗口之外，所以被丢掉的 238 个全部来自最旧的那些墓碑：没有一个
		// 真实位置丢失，而最后被置顶的那篇笔记还在。
		expect(db.db['f1']).toEqual({ scroll: 1, time: expect.any(Number) });
		expect(db.db['f250']).toEqual({ scroll: 250, time: expect.any(Number) });
		expect(db.db['f800']).toEqual({ time: expect.any(Number) });
	});
});

describe('countDefaultPosition', () => {
	it('只数那些没有任何位置的记录，一条不多数', () => {
		const { db, fmPositions } = makeHarness();
		// 两者用同一个「打开时的默认行」：frontmatter 在第 4 行结束，所以 app 把光标停在
		// 第 5 行。
		const fm = { start: { line: 0, col: 0, offset: 0 }, end: { line: 4, col: 0, offset: 0 } };
		for (const p of ['a.md', 'c.md'] as const)
			fmPositions[p] = fm;

		db.setState('a.md', { cursor: POINT(5, 0) }); // 停在默认位置上
		db.setState('b.md', {});                      // 墓碑
		db.setState('c.md', { cursor: POINT(9, 0) }); // 一个真实的行
		db.setState('d.md', { scroll: 40 });          // 一个真实的滚动位置

		expect(db.countDefaultPosition()).toBe(2);
	});
});
