// Restorer 里 leaf+file 去重的单元测试（hasOpenedLeafPath +
// pruneStaleLeafIds）—— 这套逻辑背着两个已修过的回归：
//  - 全新的 leaf 绝不能凭一份过期的 view.file 快照被标成已处理
//    （快速换文件会把恢复搁浅在页顶）；
//  - 裁剪必须丢弃已关闭 leaf 的条目（含 pendingOpenKind），
//    好让一个被复用的 leaf id 无法错误地给后来的打开去重。

import { describe, it, expect } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { Restorer } from '@/position/restore/restorer';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

// hasOpenedLeafPath / pruneStaleLeafIds 是私有的；测试通过这个别名
// 驱动它们。
type DedupApi = {
	hasOpenedLeafPath(leaf: WorkspaceLeaf, filePath: string): boolean;
	pruneStaleLeafIds(): void;
};

function makeLeaf(id: string): WorkspaceLeaf {
	return { id } as unknown as WorkspaceLeaf;
}

function makeHarness(liveLeafIds: string[]) {
	const state = new PositionState(DEFAULT_SETTINGS);
	const app = {
		workspace: {
			iterateAllLeaves: (cb: (leaf: unknown) => undefined) => {
				liveLeafIds.forEach((id) => cb(makeLeaf(id)));
			},
		},
	};
	const store = new PositionStore(app as never, { db: {} } as never);
	const restorer = new Restorer(
		app as never,
		DEFAULT_SETTINGS,
		store,
		state,
	) as unknown as DedupApi & { hasOpenedLeafPath: DedupApi['hasOpenedLeafPath'] };
	return { state, restorer };
}

describe('Restorer 去重', () => {
	it('全新的 leaf 绝不会被去重，而且会被记下来', () => {
		const { state, restorer } = makeHarness(['leaf-1']);
		const leaf = makeLeaf('leaf-1');

		expect(restorer.hasOpenedLeafPath(leaf, 'a.md')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('同一 leaf + 同一文件第二次算去重命中', () => {
		const { restorer } = makeHarness(['leaf-1']);
		const leaf = makeLeaf('leaf-1');

		restorer.hasOpenedLeafPath(leaf, 'a.md');
		expect(restorer.hasOpenedLeafPath(leaf, 'a.md')).toBe(true);
	});

	it('同一个 leaf 打开别的文件会再次恢复并更新记录', () => {
		const { state, restorer } = makeHarness(['leaf-1']);
		const leaf = makeLeaf('leaf-1');

		restorer.hasOpenedLeafPath(leaf, 'a.md');
		expect(restorer.hasOpenedLeafPath(leaf, 'b.md')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('b.md');
		// ……而新那一对从此刻起算去重命中。
		expect(restorer.hasOpenedLeafPath(leaf, 'b.md')).toBe(true);
	});

	it('一次全新打开会清掉已关闭的 leaf 及其 pendingOpenKind 标记', () => {
		const liveLeaf = makeLeaf('leaf-live');
		const closedLeaf = makeLeaf('leaf-closed');
		const { state, restorer } = makeHarness(['leaf-live']);

		state.handledLeafIdMap.set('leaf-closed', 'old.md');
		state.pendingOpenKind.set(closedLeaf, 'anchorLink');

		// 对存活 leaf 的一次全新打开会触发裁剪。
		expect(restorer.hasOpenedLeafPath(liveLeaf, 'a.md')).toBe(false);

		expect(state.handledLeafIdMap.has('leaf-closed')).toBe(false);
		expect(state.pendingOpenKind.has(closedLeaf)).toBe(false);
		// 存活的条目留了下来。
		expect(state.handledLeafIdMap.get('leaf-live')).toBe('a.md');
	});

	it('被复用的 leaf id 在它的条目被清掉之后，不能再给后来的打开去重', () => {
		const liveLeafIds = ['leaf-2'];
		const { restorer } = makeHarness(liveLeafIds);
		const leaf = makeLeaf('leaf-2');

		restorer.hasOpenedLeafPath(leaf, 'a.md'); // recorded
		// 该 leaf 关闭、另一个打开：裁剪丢掉了 leaf-2 的条目。
		liveLeafIds.length = 0;
		liveLeafIds.push('leaf-3');
		expect(restorer.hasOpenedLeafPath(makeLeaf('leaf-3'), 'b.md')).toBe(false);
		// 那个已关闭的 id 被后来的一个 leaf 实例复用：没有陈旧去重。
		expect(restorer.hasOpenedLeafPath(leaf, 'a.md')).toBe(false);
	});
});
