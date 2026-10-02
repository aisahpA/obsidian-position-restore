// PathBookkeeper（position/path-bookkeeping.ts）管着插件按 vault 路径
// 索引的一切，覆盖 vault 的两种路径事件：
//  - RENAME 一起挪走位置记录（两层，一次 store 调用搞定）、导航 store 的
//    条目（各自重键**自己的**记录）以及流水线的当前文件指针 —— 而当指针
//    指的是别的文件时，就不动它；
//  - DELETE 只是排期，不立即执行，窗口关闭时由 VAULT 定夺：回来的路径
//    干脆不删（同步插件的「先删再改名」替换），仍然缺失的路径按原样
//    裁剪，只裁一次，即便它被反复删除。

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { App, TAbstractFile } from 'obsidian';

import { PathBookkeeper, type PathStore } from '@/position/path-bookkeeping';

// 时间一律说成「一拍」和「很久之后」，从不写宽限期本身：这些测试钉的是
// 机制（延后、由 vault 定夺、窗口不重叠），所以重新调窗口不能碰到它们。
const A_BEAT = 100;
const LONG_AFTER = 60_000;

// `extraNavStore` 加入交给 bookkeeper 的那个列表，好让测试能查它够到
// **每一个**导航 store 而不只是第一个（生产环境里的列表是
// [stack, 最近文件列表]）。
function makeHarness(extraNavStore?: PathStore) {
	// vault 的文件索引，就是关窗时那次复查看到的那个。
	const files = new Set<string>();
	// **磁盘**，单独去问（见 confirmGone）：同步插件经由适配器把文件放回来，
	// 索引未必会听说 —— 所以两者可能对不上。
	const disk = new Set<string>();
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => (files.has(path) ? { path } : null),
			adapter: { exists: async (path: string) => disk.has(path) },
		},
	};
	const store = { renameFile: vi.fn(), deleteFile: vi.fn() };
	// 一个按路径索引的导航 store（生产环境里是前进/后退栈）：
	// 它重键/丢弃自己的记录，列表里的每个兄弟也都会这样。
	const navStore = {
		renameFile: vi.fn(),
		deleteFile: vi.fn(),
		persist: vi.fn(),
		knownPaths: vi.fn((): string[] => []),
	};
	const state = { lastLoadedFilePath: undefined as string | undefined };
	const bookkeeper = new PathBookkeeper(
		app as unknown as App,
		store as never,
		extraNavStore ? [navStore, extraNavStore] : [navStore],
		state as never,
	);
	const file = (path: string) => ({ path }) as TAbstractFile;
	const restore = (path: string) => {
		files.add(path);
		disk.add(path);
	};
	const remove = (path: string) => {
		files.delete(path);
		disk.delete(path);
	};
	return { bookkeeper, store, navStore, state, files, disk, file, restore, remove };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('PathBookkeeper 改名', () => {
	it('挪走位置记录、历史条目与当前文件指针', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'a.md';

		h.bookkeeper.renameFile(h.file('b.md'), 'a.md');

		// 每个 store 各有自己的参数顺序：位置 store 是 (new, old)，历史是
		// (old, new) —— bookkeeper 就是两者都只声明一次的地方。
		expect(h.store.renameFile).toHaveBeenCalledWith('b.md', 'a.md');
		expect(h.navStore.renameFile).toHaveBeenCalledWith('a.md', 'b.md');
		expect(h.state.lastLoadedFilePath).toBe('b.md');
	});

	it('当前文件指针指的是别的文件时不动它', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'c.md';

		h.bookkeeper.renameFile(h.file('b.md'), 'a.md');

		expect(h.navStore.renameFile).toHaveBeenCalledWith('a.md', 'b.md');
		expect(h.state.lastLoadedFilePath).toBe('c.md');
	});
});

describe('PathBookkeeper 删除', () => {
	it('窗口结束时又回来的路径不清掉（同步替换）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.restore('a.md');

		// 删除时没了，窗口关之前又回来了。同样的结果也会在路径甚至在删除被排期
		// 之前就回来时出现：定夺的是关窗时那次 vault 读取，从来不是事件配对。
		h.remove('a.md');
		h.bookkeeper.deleteFile(h.file('a.md'));
		h.restore('a.md');

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
	});

	it('窗口结束时仍然缺失的路径从两个 store 清掉，且绝不提前', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT); // a beat: deferred, not synchronous
		expect(h.store.deleteFile).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.store.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.navStore.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
	});

	it('对仍然缺失的路径反复删除只清一次：后一次删除会重启窗口', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.bookkeeper.deleteFile(h.file('a.md')); // restarts the window
		await vi.advanceTimersByTimeAsync(A_BEAT);
		expect(h.store.deleteFile).not.toHaveBeenCalled(); // neither window has closed

		// 两个窗口都很久之后：只有重启的那个可能已经触发过。
		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).toHaveBeenCalledTimes(1);
	});

	// 被报的那个 bug：手机的同步把笔记拿走又放回，而这次替换是一次网络往返，
	// 所以它是否落在窗口内，不该是记录能否存活所依赖的东西。vault 自己说这条
	// 路径回来了，就取消裁剪 —— 窗口只是「一次没有任何东西反驳的删除」
	// 会发生的事。
	it('为已删路径新建文件会取消清理（同步的删掉再写入）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.bookkeeper.fileCreated(h.file('a.md'));

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
	});

	it('覆盖到已删路径的改名取消清理（同步的删掉再改名）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		// 下载先落到一个临时名字上，再改名覆盖到目标。
		h.bookkeeper.renameFile(h.file('a.md'), 'a.md.tmp');

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
		// ……而它同时也是的重键照样发生：取消掉一次裁剪不等于
		// 取消掉一次改名。
		expect(h.store.renameFile).toHaveBeenCalledWith('a.md', 'a.md.tmp');
	});

	// 手机的同步直接把下载好的文件经适配器写进去，索引未必会听说：它引发的
	// 那次删除，面对的是一块已有该文件的磁盘和一个仍然没有的索引。记录必须
	// 熬过这次分歧 —— 索引落后于磁盘只是慢了一次同步，不等于文件没了。
	it('磁盘上有、索引里没有的路径不清掉（同步绕过了 vault 直接写）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.disk.add('a.md'); // back on disk; the index never hears about it

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
	});
});

describe('PathBookkeeper 启动扫描', () => {
	it('丢掉 vault 里没有的那个路径的历史 —— 而且只丢历史', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md', 'b.md']);
		h.restore('b.md'); // still there: not swept

		h.bookkeeper.sweepMissingHistory();
		await vi.advanceTimersByTimeAsync(A_BEAT); // a beat: deferred, like a live delete
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.navStore.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
		// 位置记录是故意留着的：db 本身是个同步文件，所以一个还没在本设备上
		// 把文件落地完的 vault，绝不能擦掉别的设备仍然需要的位置。
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		// 裁剪立刻写出去（这次清扫的意义就是让死行消失），
		// 而不是留到下一次 flush。
		expect(h.navStore.persist).toHaveBeenCalled();
	});

	it('被扫到的路径在窗口内回来了就保留历史', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		h.restore('a.md'); // the sync plugin finished downloading

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.persist).not.toHaveBeenCalled();
	});

	it('被扫到的路径被实时删除时，仍然清掉两个 store', async () => {
		// 两种延后是各自独立的表，所以清扫待定时到来的一次 vault 'delete'
		// 绝不能被它收窄成只管历史。
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		h.bookkeeper.deleteFile(h.file('a.md'));

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.store.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
	});

	it('够到每一个导航 store，不只是第一个', async () => {
		// bookkeeper 拿到的是一个**列表**（生产环境里是栈和最近文件列表），
		// 每个 store 重键/丢弃**自己的**记录 —— 所以一个只够到第一个的丢弃，
		// 会让第二个攥着死行不放。
		vi.useFakeTimers();
		const other: PathStore = {
			renameFile: vi.fn(),
			deleteFile: vi.fn(),
			persist: vi.fn(),
			knownPaths: vi.fn((): string[] => ['b.md']),
		};
		const h = makeHarness(other);
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.renameFile(h.file('c.md'), 'a.md');
		expect(other.renameFile).toHaveBeenCalledWith('a.md', 'c.md');

		// 清扫走的是各 store 路径的**并集**并在每个 store 里裁剪它，所以
		// 只有第二个 store 知道的路径也会被扫到。
		h.bookkeeper.sweepMissingHistory();
		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('b.md');
		expect(other.deleteFile).toHaveBeenCalledWith('a.md');
		expect(other.deleteFile).toHaveBeenCalledWith('b.md');
		expect(other.persist).toHaveBeenCalled();
	});

	it('窗口还站着时同步送来的那个被扫路径保留历史', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.bookkeeper.fileCreated(h.file('a.md'));

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.persist).not.toHaveBeenCalled();
	});
});
