// OpenPatcher 里 openLinkText 补丁那次采集的单元测试：一次链接导航把什么当作它的
// **JUMP KEY** 交给漏斗。它们背后的那次回归 —— 一个 wikilink 是**整条**到达的，显示别名
// 什么的一并带着（`a.md#^b1|Example 2:`），而那个标签若留着，key 就指认了一个不存在的
// 块、以及没有任何标题等于的 slug。两个锚点都解析不出来，于是那一步没留住 keyLine，
// 遍历退回到文字片段重换算 —— 这就是 back 能落到别处、而不是读者原先站的地方的原因。

import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';

import { OpenPatcher } from '@/position/restore/patcher';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

function makeHarness() {
	const state = new PositionState(DEFAULT_SETTINGS);
	const workspace = { openLinkText: vi.fn(async () => undefined) };
	const app = { workspace, vault: { getName: () => 'Test' } } as unknown as App;
	const store = new PositionStore(app, { db: {} } as never);
	// patcher 是一个纯粹的**采集点**：它往漏斗里写，不读任何读取方，所以它需要的全套东西
	// 就是它调用的那些探子。
	const funnel = {
		recordOpen: vi.fn(), recordTeleport: vi.fn(), leave: vi.fn(), settled: vi.fn(), landing: vi.fn(),
	};
	const patcher = new OpenPatcher(
		app, DEFAULT_SETTINGS, store, state, funnel as never, { flushOnLeave: vi.fn() } as never,
	);
	// patchOpenLinkText 是私有的；测试经由这个别名驱动它，和组合根的做法一样
	// （见 position/manager.ts）。
	(patcher as unknown as { patchOpenLinkText(fn: () => void): void }).patchOpenLinkText(() => undefined);
	return { state, open: workspace.openLinkText as unknown as (...args: unknown[]) => Promise<void> };
}

describe('OpenPatcher 抓取链接', () => {
	it('块链接按链接本身作 key，不按它标着什么', async () => {
		const { state, open } = makeHarness();
		await open('a.md#^b1|Example 2:', 'src.md');
		expect(state.pendingLinkKind).toBe('anchorLink');
		expect(state.pendingLinkText).toBe('a.md#^b1');
	});

	it('标题链接按链接本身作 key，不按它标着什么', async () => {
		const { state, open } = makeHarness();
		await open('a.md#my-heading|Example', 'src.md');
		expect(state.pendingLinkText).toBe('a.md#my-heading');
	});

	it('没有标签的链接原样放过', async () => {
		const { state, open } = makeHarness();
		await open('a.md#^b1', 'src.md');
		expect(state.pendingLinkText).toBe('a.md#^b1');
		await open('#my-heading', 'src.md');
		expect(state.pendingLinkText).toBe('#my-heading');
	});

	it('没点名锚点的链接不记 key', async () => {
		// `[[a.md|Alias]]` 是整篇打开笔记：它是一次打开，不是一次 jump，而从它身上取的 key 会把
		// 此后每一次落在这篇笔记上的落点都吸走。
		const { state, open } = makeHarness();
		await open('a.md|Alias', 'src.md');
		expect(state.pendingLinkKind).toBeUndefined();
		expect(state.pendingLinkText).toBeUndefined();
	});
});
