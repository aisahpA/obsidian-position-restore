// The pane marker's pure model: which LIVE main-area leaf holds which
// destination, and which step therefore deserves a "2/3" label. The live layout
// comes in as a list (see RecentFilesModal.liveLeaves); nothing here touches the
// workspace or the DOM.

import { NavHistoryEntry } from '@/nav-history/entry';

// What a destination is keyed by: the target path, or the view type for a
// pathless view entry. The pane marker keys its live leaves with the same
// vocabulary (see liveLeaves), so both ends must build the view key here.
export function viewDestinationKey(viewType: string): string {
	return `view:${viewType}`;
}

export function destinationKey(entry: NavHistoryEntry): string {
	return entry.kind === 'view' ? viewDestinationKey(entry.viewType) : entry.path;
}

// The main area as the pane marker needs to see it: one record per MAIN-AREA
// leaf, in layout order, naming the destination that leaf currently shows.
// Built by the browser from the live workspace (RecentFilesModal.liveLeaves) and
// never from the history: a recorded leaf id keeps pointing at a tab after that
// tab has walked to another note ("this leaf also held that file") or after it
// has been closed, and a number derived from those claims named windows that
// were not there.
export interface LiveLeaf {
	leafId: string;
	key: string;
}

// Which live leaves hold each destination: leafId → its 1-based rank in layout
// order. One leaf per destination is the ordinary case and needs no marker; two
// or more is the case the marker exists for.
export interface PaneInfo {
	live: Map<string, Map<string, number>>;
}

export function paneInfo(live: LiveLeaf[]): PaneInfo {
	const out = new Map<string, Map<string, number>>();
	for (const { leafId, key } of live) {
		let byLeaf = out.get(key);
		if (!byLeaf) {
			byLeaf = new Map();
			out.set(key, byLeaf);
		}
		if (!byLeaf.has(leafId))
			byLeaf.set(leafId, byLeaf.size + 1);
	}
	return { live: out };
}

// Which of how many for a step, or undefined when there is nothing to
// disambiguate: fewer than two LIVE leaves hold its destination, or this step's
// leaf is not one of them (that tab has moved on to another note, or was
// closed). The number is a property of the current layout, looked up on every
// render — so it can never outlive the window it names, and it is never off by
// a tab the user cannot see.
export function paneLabel(
	info: PaneInfo,
	entry: NavHistoryEntry,
): { n: number; total: number } | undefined {
	const byLeaf = info.live.get(destinationKey(entry));
	if (!byLeaf || byLeaf.size < 2)
		return undefined;
	const n = byLeaf.get(entry.leafId);
	return n === undefined ? undefined : { n, total: byLeaf.size };
}
