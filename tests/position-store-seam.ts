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

type Overlay = { leafStates: Map<string, TabStateRecord> };

// The store's live leaf map (read and mutate through it).
export function leafStatesOf(store: PositionStore): Map<string, TabStateRecord> {
	return (store as unknown as Overlay).leafStates;
}

// Replace the map outright: a test's preset baseline, as if the constructor
// had just seeded it from storage.
export function setLeafStates(store: PositionStore, records: Iterable<readonly [string, TabStateRecord]>): void {
	(store as unknown as Overlay).leafStates = new Map(records);
}

// The startup read, reachable without a store instance.
export function loadLeafStates(app: App): Map<string, TabStateRecord> {
	return (PositionStore as unknown as { loadLeafStates: (app: App) => Map<string, TabStateRecord> }).loadLeafStates(app);
}
