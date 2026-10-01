// Unit tests for the leaf+file dedup in Restorer (hasOpenedLeafPath +
// pruneStaleLeafIds) — the logic with two debugged regressions on record:
//  - a fresh leaf must never be marked handled from a stale view.file
//    snapshot (rapid file switch stranded restores at the top);
//  - pruning must drop entries for closed leaves (incl. pendingOpenKind)
//    so a reused leaf id can't wrongly dedup a later open.

import { describe, it, expect } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { Restorer } from '@/position/restore/restorer';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

// hasOpenedLeafPath / pruneStaleLeafIds are private; tests drive them
// through this alias.
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
		// ... and the new pair dedups from now on.
		expect(restorer.hasOpenedLeafPath(leaf, 'b.md')).toBe(true);
	});

	it('一次全新打开会清掉已关闭的 leaf 及其 pendingOpenKind 标记', () => {
		const liveLeaf = makeLeaf('leaf-live');
		const closedLeaf = makeLeaf('leaf-closed');
		const { state, restorer } = makeHarness(['leaf-live']);

		state.handledLeafIdMap.set('leaf-closed', 'old.md');
		state.pendingOpenKind.set(closedLeaf, 'anchorLink');

		// Fresh open of the live leaf triggers the prune.
		expect(restorer.hasOpenedLeafPath(liveLeaf, 'a.md')).toBe(false);

		expect(state.handledLeafIdMap.has('leaf-closed')).toBe(false);
		expect(state.pendingOpenKind.has(closedLeaf)).toBe(false);
		// Live entries survive.
		expect(state.handledLeafIdMap.get('leaf-live')).toBe('a.md');
	});

	it('被复用的 leaf id 在它的条目被清掉之后，不能再给后来的打开去重', () => {
		const liveLeafIds = ['leaf-2'];
		const { restorer } = makeHarness(liveLeafIds);
		const leaf = makeLeaf('leaf-2');

		restorer.hasOpenedLeafPath(leaf, 'a.md'); // recorded
		// The leaf is closed and another one opens: prune drops leaf-2's entry.
		liveLeafIds.length = 0;
		liveLeafIds.push('leaf-3');
		expect(restorer.hasOpenedLeafPath(makeLeaf('leaf-3'), 'b.md')).toBe(false);
		// The closed id gets reused by a later leaf instance: no stale dedup.
		expect(restorer.hasOpenedLeafPath(leaf, 'a.md')).toBe(false);
	});
});
