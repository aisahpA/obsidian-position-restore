// 原子落盘工具（src/position/storage/atomic-file.ts）的单元测试：三步写盘（写暂存 → 删正式
// 文件 → rename 就位）、暂存那套用不了时的整份直写退路，以及启动时补完被打断的落盘。
// 这里只关心文件动作，所以用一个最小的内存 adapter，不牵扯 Obsidian 的任何东西。

import { describe, it, expect, vi } from 'vitest';
import type { DataAdapter } from 'obsidian';

import {
	STAGING_DIR,
	discardStagedFile,
	finishInterruptedWrite,
	readFileIfParsable,
	stagedPath,
	writeFileAtomically,
} from '@/position/storage/atomic-file';

const TARGET = 'x/plugins-data/position-restore-data.json';

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
		remove: vi.fn(async (p: string) => {
			delete files[p];
		}),
		rename: vi.fn(async (from: string, to: string) => {
			if (!(from in files)) throw new Error('ENOENT');
			if (to in files) throw new Error('Destination file already exists!');
			files[to] = files[from];
			delete files[from];
		}),
		mkdir: vi.fn(async () => {}),
	};
	return { adapter: adapter as unknown as DataAdapter, files, mock: adapter };
}

// 解析器：把内容当成「能读」的判据。工具本身不认识格式，测试里用最直白的一种。
const parse = (text: string): string => {
	if (!text.startsWith('ok:')) throw new Error('unparsable');
	return text;
};

describe('writeFileAtomically', () => {
	it('第一次写：没有正式文件，新内容直接就位', async () => {
		const { adapter, files } = makeAdapter();

		expect(await writeFileAtomically(adapter, TARGET, 'first')).toBe(true);

		expect(files[TARGET]).toBe('first');
		expect(files[stagedPath(TARGET)]).toBeUndefined();
	});

	it('再写一次：旧文件被替换，不留下「上一版」', async () => {
		const { adapter, files } = makeAdapter({ [TARGET]: 'old' });

		expect(await writeFileAtomically(adapter, TARGET, 'new')).toBe(true);

		expect(files[TARGET]).toBe('new');
		expect(Object.keys(files).filter((p) => p.startsWith(STAGING_DIR))).toEqual([]);
	});

	it('暂存那套用不了时退回整份直写，正式文件仍是新内容', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { adapter, files, mock } = makeAdapter({ [TARGET]: 'old' });
		mock.write.mockImplementation(async (p: string, data: string) => {
			if (p.startsWith(STAGING_DIR))
				throw new Error('EPERM');
			files[p] = data;
		});

		expect(await writeFileAtomically(adapter, TARGET, 'new')).toBe(true);

		expect(files[TARGET]).toBe('new');
	});

	it('两次写都失败：返回 false，正式文件原样不动', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { adapter, files, mock } = makeAdapter({ [TARGET]: 'old' });
		mock.write.mockImplementation(async () => {
			throw new Error('EIO');
		});

		expect(await writeFileAtomically(adapter, TARGET, 'new')).toBe(false);

		expect(files[TARGET]).toBe('old');
	});
});

describe('finishInterruptedWrite', () => {
	it('暂存文件是完整的新内容，扶正后暂存消失', async () => {
		const { adapter, files } = makeAdapter({ [stagedPath(TARGET)]: 'ok:new' });

		const recovered = await finishInterruptedWrite(adapter, TARGET, parse);

		expect(recovered).toBe('ok:new');
		expect(files[TARGET]).toBe('ok:new');
		expect(files[stagedPath(TARGET)]).toBeUndefined();
	});

	it('暂存读不懂时返回 null，不把它扶正', async () => {
		const { adapter, files } = makeAdapter({ [stagedPath(TARGET)]: 'garbage' });

		expect(await finishInterruptedWrite(adapter, TARGET, parse)).toBeNull();

		expect(files[TARGET]).toBeUndefined();
		expect(files[stagedPath(TARGET)]).toBe('garbage');
	});

	it('没有暂存时返回 null（第一次运行也走这条）', async () => {
		const { adapter } = makeAdapter();

		expect(await finishInterruptedWrite(adapter, TARGET, parse)).toBeNull();
	});
});

describe('discardStagedFile / readFileIfParsable', () => {
	it('清掉残留的暂存文件；没有残留时是空操作', async () => {
		const { adapter, files } = makeAdapter({ [stagedPath(TARGET)]: 'leftover' });

		await discardStagedFile(adapter, TARGET);
		expect(files[stagedPath(TARGET)]).toBeUndefined();

		await expect(discardStagedFile(adapter, TARGET)).resolves.toBeUndefined();
	});

	it('读不懂或不存在都返回 null，不抛', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { adapter } = makeAdapter({ [stagedPath(TARGET)]: 'garbage' });

		expect(await readFileIfParsable(adapter, stagedPath(TARGET), parse)).toBeNull();
		expect(await readFileIfParsable(adapter, 'nope/absent.json', parse)).toBeNull();
	});
});
