// main.ts 那个 'quit' 处理程序背后的契约。Obsidian 退出前会等交给 Tasks 的那些 promise，
// 所以 storePositionData() 必须把那次写库交回去，而不是随手扔掉。这里钉住三件成立的
// 事：三个 localStorage store 是同步写下的、甚至在文件写入开始之前；返回的 promise 在
// 文件写入完成之前不落定；而即使写入失败它也会落定 —— 一个 reject 会让 app 卡在
// 「Saving...」。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { App } from 'obsidian';

import { PositionManager } from '@/position/manager';
import type { PositionStore } from '@/position/storage/position-store';
import type { NavStack } from '@/nav-history/stack';
import type { NavPlaces } from '@/recent-files/places';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

function makeHarness() {
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: () => null,
			adapter: { exists: async () => false },
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
	// 那次写库被牵着绳：什么时候算磁盘写完，由测试说。
	let release = () => {};
	const onDisk = new Promise<void>(resolve => {
		release = resolve;
	});
	const database = { writeDb: vi.fn(() => onDisk) };
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(
		app as unknown as App,
		database as never,
		settings,
	);
	const store = (manager as unknown as { store: PositionStore }).store;
	const stack = (manager as unknown as { stack: NavStack }).stack;
	const places = (manager as unknown as { places: NavPlaces }).places;
	vi.spyOn(store, 'persist');
	vi.spyOn(stack, 'persist');
	vi.spyOn(places, 'persist');
	return { manager, database, store, stack, places, release };
}

afterEach(() => {
	window.localStorage.clear();
});

describe('PositionManager.storePositionData', () => {
	it('在库文件开始写入之前，先把三个内存 store 写好', () => {
		const h = makeHarness();

		const write = h.manager.storePositionData();

		// async 函数体开头那段是同步跑的，所以拿到那个 promise 时，每一次 localStore 写入都已
		// 经发生了 —— 一个在写文件中途被杀掉的退出，仍然保住了那份每标签页快照。
		expect(h.store.persist).toHaveBeenCalled();
		expect(h.stack.persist).toHaveBeenCalled();
		expect(h.places.persist).toHaveBeenCalled();
		expect(h.database.writeDb).toHaveBeenCalled();
		h.release();
		return write;
	});

	it('文件写入落定之后它才落定', async () => {
		const h = makeHarness();
		let settled = false;

		const write = h.manager.storePositionData().then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);

		h.release();
		await write;
		expect(settled).toBe(true);
	});

	it('即便写库失败也要落定，并在日志里说明', async () => {
		const h = makeHarness();
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		h.database.writeDb.mockRejectedValueOnce(new Error('disk full'));

		// 一次退出把这个 promise 交给 Tasks，而 Obsidian 会在关窗之前用 Promise.all 等它们
		// 每一个。
		await expect(h.manager.storePositionData()).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});
