// PositionManager 对 vault 改名/删除派发的接线检查：这个门面自己不做任何
// 簿记 —— 它把每个 vault 事件交给 PathBookkeeper（机制见
// path-bookkeeping.test.ts）。这里要紧的是那个被报的 bug 所涉的端到端
// 行为：同步插件的「删掉 + 改名」不能让文件丢掉它的位置记录或导航历史
// 步，而一次真删除仍然必须把两者都清掉。

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TAbstractFile } from 'obsidian';

import { App, TFile } from 'obsidian';
import { PositionManager } from '@/position/manager';
import type { NavFunnel } from '@/nav/funnel';
import type { NavStack } from '@/nav-history/stack';
import type { PositionState } from '@/position/state';
import type { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';
// leafStates 在 store 上是私有的；这是测试接缝。
import { leafStatesOf, seedLeaf } from './support/position-store-seam';

// 时间一律说成「一拍」和「很久之后」，从不写宽限期本身：
// 这些测试钉的是机制，不是那个可调的值。
const A_BEAT = 100;
const LONG_AFTER = 60_000;

function makeHarness() {
	// vault 的文件索引，就是延后裁剪那次复查看到的那个。
	const files = new Set<string>();
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) =>
				(files.has(path) ? Object.assign(new TFile(), { path }) : null),
			// 磁盘，供延后裁剪参考的第二意见。这里索引兼任磁盘：
			// 这些测试考的是接线，不是两者对不上。
			adapter: { exists: async (path: string) => files.has(path) },
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
	// 文件层，功能足够让 store 的两层行为端到端可观察
	// （spy 仍然记录测试断言的那些调用）。
	const db: Record<string, { scroll: number }> = { 'a.md': { scroll: 7 } };
	const database = {
		db,
		setState: vi.fn((path: string, st: { scroll: number }) => { db[path] = st; }),
		renameFile: vi.fn((newPath: string, oldPath: string) => {
			if (db[oldPath] === undefined) return;
			db[newPath] = db[oldPath];
			delete db[oldPath];
		}),
		deleteFile: vi.fn((path: string) => { delete db[path]; }),
	};
	// manager（以及它拥有的历史）持有的 settings 对象：设置面板是**原地**
	// 改**这个**实例的，所以改设置的测试必须在这里改。
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(
		app as unknown as App,
		database as never,
		settings,
	);
	// manager 拥有的协作者；测试用插件所用的同一套公开 API 给它们播种、读它们。
	// manager 是组合根，所以它同时持有两半：funnel 是测试用来记录的**采集**面，
	// stack 是保存它们所断言的步的读者。
	const funnel = (manager as unknown as { funnel: NavFunnel }).funnel;
	const stack = (manager as unknown as { stack: NavStack }).stack;
	const state = (manager as unknown as { state: PositionState }).state;
	const store = (manager as unknown as { store: PositionStore }).store;
	const file = (path: string): TAbstractFile => Object.assign(new TFile(), { path }) as TAbstractFile;
	const paths = () => stack.entries.map(e => (e.kind !== 'view' ? e.path : undefined));
	return { manager, funnel, stack, state, store, database, files, file, paths, settings };
}

afterEach(() => {
	vi.useRealTimers();
	window.localStorage.clear();
});

describe('PositionManager 的 vault 路径变更', () => {
	it('改名会同时换键：位置记录、历史步、当前文件指针', () => {
		const h = makeHarness();
		h.funnel.recordOpen('a.md', 'leaf-1');
		h.state.lastLoadedFilePath = 'a.md';

		h.manager.renameFile(h.file('b.md'), 'a.md');

		expect(h.database.renameFile).toHaveBeenCalledWith('b.md', 'a.md');
		expect(h.paths()).toEqual(['b.md']);
		expect(h.state.lastLoadedFilePath).toBe('b.md');
	});

	it('同步的「删掉再改名」保留位置记录与历史步', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.funnel.recordOpen('a.md', 'leaf-1');
		h.funnel.recordOpen('b.md', 'leaf-1');

		// 替换过程，照 vault 报告的样子：路径没了（Obsidian
		// 关掉它的标签页）……
		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		// ……紧接着，下载好的临时文件被改名覆盖到它上面。
		h.files.add('a.md');

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.database.deleteFile).not.toHaveBeenCalled();
		expect(h.paths()).toEqual(['a.md', 'b.md']);
		expect(h.stack.index).toBe(1);
	});

	it('同步的「删掉再新建」保留位置记录与历史步', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.funnel.recordOpen('a.md', 'leaf-1');

		// 同一种替换，但同步是就地写入文件、而不是把下载件改名覆盖上去：
		// 路径消失，然后以「新建」的姿态回来 —— 而正是这个新建说明
		// 那次删除从来就不是删除。
		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.files.add('a.md');
		h.manager.fileCreated(h.file('a.md'));

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.database.deleteFile).not.toHaveBeenCalled();
		expect(h.paths()).toEqual(['a.md']);
	});

	it('真删除仍然会在窗口结束后清掉两个 store', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.funnel.recordOpen('a.md', 'leaf-1');
		h.funnel.recordOpen('b.md', 'leaf-1');

		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT); // a beat: deferred, not synchronous
		expect(h.database.deleteFile).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.database.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.paths()).toEqual(['b.md']);
		expect(h.stack.index).toBe(0);
	});

	// 位置 store 的两层是一起重键、一起丢弃的。按标签页的记录是 bookkeeper
	// 过去会漏掉的那一半：一条仍然命名着已删路径的记录，会被 PositionStore.read
	// 交给之后在同一路径下新建的文件（恢复出一个死位置）；而一条在改名后仍
	// 命名旧路径的记录，会通不过它的路径校验，静默地把按标签页的分家
	// 塌回文件记录上。
	it('改名会把按标签页的记录连文件记录一起换键', () => {
		const h = makeHarness();
		seedLeaf(h.store, 'leaf-1', { filePath: 'a.md', st: { scroll: 42 } });

		h.manager.renameFile(h.file('b.md'), 'a.md');

		expect(leafStatesOf(h.store).get('leaf-1')).toEqual({ filePath: 'b.md', st: { scroll: 42 } });
		// 标签页自己的那一处对改名后的文件依然作答……
		expect(h.store.read('leaf-1', 'b.md')).toEqual({ scroll: 42 });
		// ……而不是退回文件记录。
		expect(h.store.read('leaf-1', 'a.md')).toBeUndefined();
	});

	it('真删除也会丢掉该路径的按标签页记录，且只丢那些', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		seedLeaf(h.store, 'leaf-1', { filePath: 'a.md', st: { scroll: 42 } });
		seedLeaf(h.store, 'leaf-2', { filePath: 'b.md', st: { scroll: 9 } });

		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(leafStatesOf(h.store).has('leaf-1')).toBe(false);
		expect(leafStatesOf(h.store).get('leaf-2')).toEqual({ filePath: 'b.md', st: { scroll: 9 } });
		// 之后在已删路径下新建的文件从干净状态起步。
		expect(h.store.read('leaf-1', 'a.md')).toBeUndefined();
	});

	it('同步的删掉再改名保留存活路径的按标签页记录', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		seedLeaf(h.store, 'leaf-1', { filePath: 'a.md', st: { scroll: 42 } });
		h.files.add('a.md');

		h.files.delete('a.md');
		h.manager.deleteFile(h.file('a.md'));
		h.files.add('a.md'); // the replacement lands before the window closes

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(leafStatesOf(h.store).get('leaf-1')).toEqual({ filePath: 'a.md', st: { scroll: 42 } });
		expect(h.store.read('leaf-1', 'a.md')).toEqual({ scroll: 42 });
	});
});

// 两条背后没有 vault 事件的维护路径：设置里改栈上限，
// 以及 Obsidian 关闭期间被删的文件留下的历史。
describe('PositionManager 的导航历史维护', () => {
	it('改了栈上限会立刻裁掉内存里已有的栈', () => {
		const h = makeHarness();
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			h.funnel.recordOpen(p, 'leaf-1');

		h.settings.navHistoryCap = 2;
		h.manager.applyNavHistoryCap();

		// **此刻**就裁掉，而不是等下一次导航（那会一次性丢掉一大块，
		// 而且是在改设置很久之后）。
		expect(h.paths()).toEqual(['c.md', 'd.md']);
		expect(h.stack.index).toBe(1);
	});

	it('启动时那一轮清扫丢掉已经不在了的文件的步，却留住它的位置记录', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.funnel.recordOpen('a.md', 'leaf-1');
		h.funnel.recordOpen('gone.md', 'leaf-1'); // deleted while Obsidian was closed

		h.manager.sweepMissingHistory();
		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.paths()).toEqual(['a.md']);
		// 历史是本机所有、可弃的；db 两者都不是 —— 它是同步的，所以一个还没
		// 把文件落地完的 vault，绝不能擦掉别的设备仍然持有的位置。
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('启动扫描保留 vault 里还在的那些文件的历史', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');
		h.files.add('b.md');
		h.funnel.recordOpen('a.md', 'leaf-1');
		h.funnel.recordOpen('b.md', 'leaf-1');

		h.manager.sweepMissingHistory();
		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.paths()).toEqual(['a.md', 'b.md']);
	});
});
