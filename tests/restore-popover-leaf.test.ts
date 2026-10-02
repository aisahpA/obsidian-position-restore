// 关于「窗格不是窗格」的唯一那个地方的单元测试：一个被托在悬停浮层里面的真 leaf ——
// 让 app 的预览变得可编辑的那个插件会往里放的东西。'file-open' 会像对任何别的 leaf 一样
// 为它触发，而恢复它会把卡片落到没人指过的行上，还盖着一张让它空着的遮罩，直到落定为
// 止。预览在 app 打开预览的地方打开。

import { describe, it, expect } from 'vitest';
import { MarkdownView, type WorkspaceLeaf } from 'obsidian';

import { Restorer } from '@/position/restore/restorer';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';
import { isPopoverLeaf } from '@/shared/leaf';

// 分隔「一个预览」与「一个窗格」的唯一东西，就是这个 leaf 住在哪儿。
function makeView(inPopover: boolean) {
	const root = document.createElement('div');
	const host = document.createElement('div');
	if (inPopover) {
		const popover = document.createElement('div');
		popover.className = 'hover-popover';
		popover.appendChild(host);
		root.appendChild(popover);
	} else {
		root.appendChild(host);
	}
	const leaf = { id: 'leaf-1', containerEl: host } as unknown as WorkspaceLeaf;
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path: 'a.md' },
		leaf,
	}) as MarkdownView;
	// store 在构造时按 vault 给自己的遮罩命名；没有它，store 会在这些测试的每一轮里记一次
	// 读取失败。
	const app = {
		workspace: { getActiveViewOfType: () => view },
		vault: { getName: () => 'vault' },
	};
	const state = new PositionState(DEFAULT_SETTINGS);
	const store = new PositionStore(app as never, { db: { 'a.md': { scroll: 10 } } } as never);
	return {
		state,
		leaf,
		restorer: new Restorer(app as never, DEFAULT_SETTINGS, store, state),
	};
}

describe('悬停浮层托着的那个 leaf', () => {
	it('按它住在哪儿分辨，不按它显示什么', () => {
		expect(isPopoverLeaf(makeView(true).leaf)).toBe(true);
		expect(isPopoverLeaf(makeView(false).leaf)).toBe(false);
	});

	it('就让它停在 app 打开它时的那个位置', async () => {
		const { state, leaf, restorer } = makeView(true);

		await restorer.restoreEphemeralState();

		// 没有记下这一对、也没有盖布：这次恢复压根没开始，所以卡片显示的是 app 画出来的东西，
		// 而不是空着等一次对一个只是悬停的读者永远不会到来的落定。
		expect(state.handledLeafIdMap.get('leaf-1')).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
	});
});
