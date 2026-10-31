// DatabaseRecovery（src/position/storage/db-recovery.ts）的单元测试：读不懂的数据文件
// 怎么善后 —— 原始字节留副本（按内容去重、序号命名）、三级恢复的三种结论，以及「一次会话
// 只提示一次」。这里不起真实的 CursorPositionDatabase，只给一个最小的内存 adapter。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataAdapter } from 'obsidian';

import { Notice } from 'obsidian';

// i18n 在模块加载时从 window.moment 解析 locale；先放替身，再引被测模块。
vi.hoisted(() => {
	(window as unknown as { moment: unknown }).moment = { locale: () => 'en' };
});

import { DatabaseRecovery } from '@/position/storage/db-recovery';
import { previousPath } from '@/position/storage/atomic-file';
import { t } from '@/i18n';

const DB_PATH = 'x/plugins-data/position-restore-data.json';
const MANIFEST = '.obsidian/plugins/position-restore';
const PREV = previousPath(DB_PATH);

// 截断的库：前缀里有一条完整记录（a.md），后面断在 b.md 的字母中间。
const TRUNCATED = '{"schema":3,"lastPositions":{"a.md":{"s":5,"t":11},"b.md":{"s":9';
const LEGAL = '{"schema":3,"lastPositions":{"a.md":{"s":5,"t":11}}}';

const copies = (files: Record<string, string>): string[] =>
	Object.keys(files).filter((p) => p.startsWith(`${MANIFEST}/position-restore-data.corrupt-`)).sort();

type StubNotice = { message: string; duration: number | undefined };
const notices = (): StubNotice[] => (Notice as unknown as { instances: StubNotice[] }).instances;

function makeAdapter(files: Record<string, string> = {}) {
	const adapter = {
		exists: vi.fn(async (p: string) => p in files),
		read: vi.fn(async (p: string) => {
			if (!(p in files)) throw new Error('ENOENT');
			return files[p];
		}),
		write: vi.fn(async (p: string, data: string) => {
			files[p] = data;
		}),
	};
	const recovery = new DatabaseRecovery(adapter as unknown as DataAdapter, MANIFEST);
	return { adapter, files, recovery };
}

beforeEach(() => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	(Notice as unknown as { reset: () => void }).reset();
});

describe('副本', () => {
	it('坏字节落到插件目录，提示里报出这个路径', async () => {
		const { files, recovery } = makeAdapter();

		const outcome = await recovery.recover(DB_PATH, TRUNCATED, new Error('bad'));

		expect(outcome.kind).toBe('salvaged');
		const kept = copies(files);
		expect(kept).toHaveLength(1);
		expect(files[kept[0]]).toBe(TRUNCATED);
		expect(outcome.keptCopy).toBe(kept[0]);
		expect(notices()).toHaveLength(1);
		expect(notices()[0].message).toBe(t('dataStorage.corruptDb.recovered', '1', kept[0]));
		expect(notices()[0].duration).toBe(0);
	});

	it('同一份内容再次进来不再生成第二份副本，也不再来一条提示', async () => {
		const { files, recovery } = makeAdapter();

		await recovery.recover(DB_PATH, TRUNCATED, new Error('bad'));
		await recovery.recover(DB_PATH, TRUNCATED, new Error('bad'));

		expect(copies(files)).toHaveLength(1);
		expect(notices()).toHaveLength(1);
	});

	it('内容不同就是不同的损坏：两份副本、名字靠序号区分', async () => {
		const { files, recovery } = makeAdapter();

		await recovery.recover(DB_PATH, TRUNCATED, new Error('bad'));
		await recovery.recover(DB_PATH, '{"schema":3,"lastPositions":{"c.md":{"s":1', new Error('bad'));

		expect(copies(files)).toHaveLength(2);
	});
});

describe('三级恢复', () => {
	it('打捞出的记录带回 salvaged，更晚的那截丢掉', async () => {
		const { recovery } = makeAdapter();

		const outcome = await recovery.recover(DB_PATH, TRUNCATED, new Error('bad'));

		expect(outcome).toMatchObject({ kind: 'salvaged', db: { 'a.md': { scroll: 5, time: 11 } } });
	});

	it('打捞不出记录时退到上一版', async () => {
		const { files, recovery } = makeAdapter({ [PREV]: LEGAL });

		const outcome = await recovery.recover(DB_PATH, '"just a string"', new Error('bad'));

		expect(outcome).toMatchObject({ kind: 'previous', db: { 'a.md': { scroll: 5, time: 11 } } });
		expect(notices()[0].message).toBe(
			t('dataStorage.corruptDb.recovered', '1', copies(files)[0])
		);
	});

	it('都救不回来时给 unreadable，提示进入只读并带副本路径', async () => {
		const { files, recovery } = makeAdapter();

		const outcome = await recovery.recover(DB_PATH, '"just a string"', new Error('bad'));

		expect(outcome.kind).toBe('unreadable');
		const kept = copies(files);
		expect(outcome.keptCopy).toBe(kept[0]);
		expect(notices()[0].message).toBe(t('dataStorage.corruptDb.readOnly', kept[0]));
		expect(notices()[0].duration).toBe(0);
	});

	it('连副本都写不出来时，提示改说「没有副本」', async () => {
		const { adapter, files, recovery } = makeAdapter();
		adapter.write.mockImplementation(async () => {
			throw new Error('EACCES');
		});

		const outcome = await recovery.recover(DB_PATH, '"just a string"', new Error('bad'));

		expect(files).toEqual({});
		expect(outcome).toEqual({ kind: 'unreadable', keptCopy: null });
		expect(notices()[0].message).toBe(t('dataStorage.corruptDb.readOnlyNoCopy'));
	});
});

describe('会话中途的外部坏文件', () => {
	it('只留副本，返回路径，不提示、不动任何别的东西', async () => {
		const { files, recovery } = makeAdapter();

		const kept = await recovery.preserve(DB_PATH, '"just a string"', new Error('bad'));

		expect(kept).toBe(copies(files)[0]);
		expect(files[kept!]).toBe('"just a string"');
		expect(notices()).toHaveLength(0);
	});
});
