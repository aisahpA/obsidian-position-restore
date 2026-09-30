// Test seam for PositionStore's two private overlay members.
//
// The class keeps `leafStates` (the per-leaf map) and `loadLeafStates` (the
// startup read) private: in production the facade — read / write / forgetLeaf
// / deleteFile / renameFile / the prune passes — is the only thing that may
// touch the overlay, and widening the API back to public just for tests would
// give production code a second way in. The suites that pin the overlay's
// behaviour reach it through this one cast instead, the same pattern the other
// suites use for private members (their InjectFn / ScrollCapture aliases).

import type { App } from 'obsidian';
import { PositionStore } from '@/position/storage/position-store';
import type { TabStateRecord } from '@/types';

type Overlay = {
	leafStates: Map<string, TabStateRecord>;
	putLeaf(leafId: string, record: TabStateRecord): void;
	reindexLeaves(): void;
};

// The store's live leaf map, read-only. Read-only because the store derives a
// path → leaf index from it: a test that seeded through this map would leave
// the index behind, and the store would then not find the leaf it was handed.
export function leafStatesOf(store: PositionStore): ReadonlyMap<string, TabStateRecord> {
	return (store as unknown as Overlay).leafStates;
}

// Replace the map outright: a test's preset baseline, as if the constructor
// had just seeded it from storage. Reindexed for the same reason — the real
// startup read is reindexed by the constructor.
export function setLeafStates(store: PositionStore, records: Iterable<readonly [string, TabStateRecord]>): void {
	const o = store as unknown as Overlay;
	o.leafStates = new Map(records);
	o.reindexLeaves();
}

// One leaf's preset record, put through the store's own write path — the way a
// record reaches the map in production.
export function seedLeaf(store: PositionStore, leafId: string, record: TabStateRecord): void {
	(store as unknown as Overlay).putLeaf(leafId, record);
}

// The startup read, reachable without a store instance.
export function loadLeafStates(app: App): Map<string, TabStateRecord> {
	return (PositionStore as unknown as { loadLeafStates: (app: App) => Map<string, TabStateRecord> }).loadLeafStates(app);
}
