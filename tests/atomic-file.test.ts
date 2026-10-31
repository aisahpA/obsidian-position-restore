// 原子落盘工具（src/position/storage/atomic-file.ts）的单元测试：三步写盘（暂存 → 上一版
// 轮转 → rename 就位）、暂存那套用不了时的整份直写退路，以及启动时补完被打断的落盘。
// 这里只关心文件动作，所以用一个最小的内存 adapter，不牵扯 Obsidian 的任何东西。

import { describe, it, expect, vi } from 'vitest';
import type { DataAdapter } from 'obsidian';

import {
	STAGING_DIR,
	discardStagedFile,
	finishInterruptedWrite,
	previousPath,
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
	it('第一次写：没有上一版，正式文件就是新内容', async () => {
		const { adapter, files } = makeAdapter();

		expect(await writeFileAtomically(adapter, TARGET, 'first')).toBe(true);

		expect(files[TARGET]).toBe('first');
		expect(files[previousPath(TARGET)]).toBeUndefined();
		expect(files[stagedPath(TARGET)]).toBeUndefined();
	});

	it('再写一次：旧内容轮转成上一版，正式文件立刻换成新内容', async () => {
		const { adapter, files } = makeAdapter({ [TARGET]: 'old' });

		expect(await writeFileAtomically(adapter, TARGET, 'new')).toBe(true);

		expect(files[TARGET]).toBe('new');
		expect(files[previousPath(TARGET)]).toBe('old');
		expect(files[stagedPath(TARGET)]).toBeUndefined();
	});

	it('上一版只留一份：连写三次也只覆盖它，不会越攒越多', async () => {
		const { adapter, files } = makeAdapter({ [TARGET]: 'v1' });

		await writeFileAtomically(adapter, TARGET, 'v2');
		await writeFileAtomically(adapter, TARGET, 'v3');

		expect(files[TARGET]).toBe('v3');
		expect(files[previousPath(TARGET)]).toBe('v2');
		expect(Object.keys(files).filter((p) => p.startsWith(STAGING_DIR)).sort()).toEqual([
			previousPath(TARGET),
		]);
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
	it('暂存文件优先：它是完整的新内容，扶正后暂存文件消失', async () => {
		const { adapter, files } = makeAdapter({
			[stagedPath(TARGET)]: 'ok:new',
			[previousPath(TARGET)]: 'ok:old',
		});

		const recovered = await finishInterruptedWrite(adapter, TARGET, parse);

		expect(recovered).toEqual({ source: 'staged', value: 'ok:new' });
		expect(files[TARGET]).toBe('ok:new');
		expect(files[stagedPath(TARGET)]).toBeUndefined();
		// 上一版原样留着，它还是那份退路
		expect(files[previousPath(TARGET)]).toBe('ok:old');
	});

	it('暂存文件读不懂时退到上一版', async () => {
		const { adapter, files } = makeAdapter({
			[stagedPath(TARGET)]: 'garbage',
			[previousPath(TARGET)]: 'ok:old',
		});

		const recovered = await finishInterruptedWrite(adapter, TARGET, parse);

		expect(recovered).toEqual({ source: 'previous', value: 'ok:old' });
		expect(files[TARGET]).toBe('ok:old');
		expect(files[previousPath(TARGET)]).toBeUndefined();
	});

	it('两份都没有（或都读不懂）时返回 null，正式文件照旧不存在', async () => {
		const { adapter, files } = makeAdapter({ [stagedPath(TARGET)]: 'garbage' });

		expect(await finishInterruptedWrite(adapter, TARGET, parse)).toBeNull();

		expect(files[TARGET]).toBeUndefined();
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
		const { adapter } = makeAdapter({ [previousPath(TARGET)]: 'garbage' });

		expect(await readFileIfParsable(adapter, previousPath(TARGET), parse)).toBeNull();
		expect(await readFileIfParsable(adapter, 'nope/absent.json', parse)).toBeNull();
	});
});
