// Unit tests for the leaf+file dedup in Restorer (hasOpenedLeafPath +
// pruneStaleLeafIds) — the logic with two debugged regressions on record:
//  - a fresh leaf must never be marked handled from a stale view.file
//    snapshot (rapid file switch stranded restores at the top);
//  - pruning must drop entries for closed leaves (incl. pendingOpenKind)
//    so a reused leaf id can't wrongly dedup a later open.

import { describe, it, expect } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { Restorer } from '../src/restorer';
import { TabStore } from '../src/tab-store';
import { PositionState } from '../src/position-state';
import { DEFAULT_SETTINGS } from '../src/types';

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
	const tabStore = new TabStore(app as never, { db: {} } as never, state);
	const restorer = new Restorer(
		app as never,
		DEFAULT_SETTINGS,
		tabStore,
	) as unknown as DedupApi & { hasOpenedLeafPath: DedupApi['hasOpenedLeafPath'] };
	return { state, restorer };
}

describe('Restorer dedup', () => {
	it('a fresh leaf is never deduped and gets recorded', () => {
		const { state, restorer } = makeHarness(['leaf-1']);
		const leaf = makeLeaf('leaf-1');

		expect(restorer.hasOpenedLeafPath(leaf, 'a.md')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('the same leaf+file a second time is a dedup hit', () => {
		const { restorer } = makeHarness(['leaf-1']);
		const leaf = makeLeaf('leaf-1');

		restorer.hasOpenedLeafPath(leaf, 'a.md');
		expect(restorer.hasOpenedLeafPath(leaf, 'a.md')).toBe(true);
	});

	it('the same leaf opening a different file restores again and updates the record', () => {
		const { state, restorer } = makeHarness(['leaf-1']);
		const leaf = makeLeaf('leaf-1');

		restorer.hasOpenedLeafPath(leaf, 'a.md');
		expect(restorer.hasOpenedLeafPath(leaf, 'b.md')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('b.md');
		// ... and the new pair dedups from now on.
		expect(restorer.hasOpenedLeafPath(leaf, 'b.md')).toBe(true);
	});

	it('a fresh open prunes closed leaves and their pendingOpenKind markers', () => {
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

	it('a reused leaf id cannot dedup a later open after its entry was pruned', () => {
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
