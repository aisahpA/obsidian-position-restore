import { NavEntryState } from '@/types';

// One navigation, as the shared vocabulary describes it — a union TAGGED by
// `kind`, so a malformed shape fails the type check and a new variant flags
// every unexhausted switch. Both stores keep it: the stack as steps, the
// recent-files list as places.
export type NavEntry = NavJump | NavVisit | NavView | NavTeleport;

// What a recorder constructs: `t` is added by the stack's push, so no
// construction site can forget it and no caller can fake it.
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewNavEntry = DistributiveOmit<NavEntry, 't'>;

// `t` is DISPLAY-ONLY — what a row's "5m ago" reads. Stack order always comes
// from array position: two entries can share a millisecond, and a jumpTo copy
// is stamped afresh when it is re-pushed.
export interface NavEntryBase {
	leafId: string;
	t: number;
}

// A keyed jump — outline:<heading>, an anchor/caller linktext. `key` also
// dedups: a push whose key equals the top entry's is one heading clicked twice.
export interface NavJump extends NavEntryBase {
	kind: 'jump';
	path: string;
	key: string;
	// Where the key's anchor sat at RECORD time, upgraded at the landing settle
	// — the structural re-anchor's delta base. Not the recorded scroll, which is
	// a viewport top and drifts with geometry and CM's near-edge scrolling.
	// Absent until the upgrade; ^block keys never get one (their landing cannot
	// be tied to the block id) and ride the text-snippet remap instead.
	keyLine?: number;
	st?: NavEntryState;
}

// A keyless visit: a file open or a tab/pane activation. Carries no position of
// its own — st is refreshed on every leave.
export interface NavVisit extends NavEntryBase {
	kind: 'visit';
	path: string;
	st?: NavEntryState;
	// Display-only (the browser's badge): never dedup or positioning. 'switch'
	// is an activation, 'link' an open that came from clicking a link.
	via?: 'switch' | 'link';
	// For 'link': where the link was clicked and what it said — neither is
	// derivable later, since the path above names the destination. Both are
	// searchable. A link carrying a #/^ target is a keyed NavJump instead, so
	// these name plain file links only.
	viaPath?: string;
	viaText?: string;
}

// A pathless main-area view: the global graph, a memo list, a main-area search
// — a place in the workspace rather than a place in a note. Traversal finds a
// leaf SHOWING that view, or builds one when it is nowhere (openViewPlace).
export interface NavView extends NavEntryBase {
	kind: 'view';
	viewType: string;
	// DISPLAY-ONLY, and optional: a view that named no label or icon leaves
	// them off and the row answers in words. Recorded rather than looked up
	// because a third-party view's name cannot be derived from its type.
	label?: string;
	icon?: string;
	// What the place is REBUILT with when its tab is gone or was swapped to
	// another view — a local graph's file, a search's query, a plugin's
	// filters. A SNAPSHOT, not a live reference: refreshed on every visit and
	// once more as the reader leaves. Identity stays viewType, so two tabs of
	// one view are one place with one state between them.
	state?: Record<string, unknown>;
}

// An INFERRED same-file cursor jump — large move, go-to-line, vim jump (the
// sampler's heuristic, gated by navHistoryTeleportMinLines, desktop-only). The
// reader may not perceive it as a jump, so it is its own kind: deduped by
// target line, shown with its own badge.
export interface NavTeleport extends NavEntryBase {
	kind: 'teleport';
	path: string;
	line: number;
	st?: NavEntryState;
}

// What is NOT a place. One entry: 'empty', the placeholder a main-area leaf
// shows with nothing in it — there is nothing behind it to return to. A
// whitelist would make the answer depend on which plugins the reader has
// installed. (A sidebar panel never reaches this filter: it is not a main-area
// leaf.)
//
// The web view is the one case worth naming. Its state carries the url it is
// showing, so its real place is that url — but identity is the view TYPE, so
// several of its tabs are several places sharing ONE row, each visit
// overwriting the last. The row therefore follows the tab the reader last
// stood in: it MEANS "the page you were last reading". Giving every url a row
// would make this a browsing history, which is the browser's own back/forward.
export const NON_DESTINATION_VIEW_TYPES = new Set(['empty']);

// The one test, shared by the capture points that see a view only as a type.
export function isRecordableViewType(viewType: string | undefined): boolean {
	return !!viewType && !NON_DESTINATION_VIEW_TYPES.has(viewType);
}

// Which LIST ROW a navigation belongs to. Two readers must agree — the browser
// groups rows by it (groupByFile), the places store drops a whole row by it
// (NavPlaces.forget) — and a rule written twice can drift: a panel whose rows
// and a store whose removals disagree would drop places nobody pointed at.
//
// NOT a place's identity (places.ts's placeKey): a note and every jump inside
// it are ONE row here and as many places there, and what a reader takes off
// the list is the note. A view is where the two agree, being both one.
export function navGroupKey(entry: NewNavEntry): string {
	return entry.kind === 'view' ? `view:${entry.viewType}` : entry.path;
}

// What a stored view entry may not keep: these three are read straight back
// into a REPLAY (`setViewState`) or into the DOM, so a blob the reader, a sync
// or a truncation could have put anything into is pruned to what they claim.
// The ENTRY is kept — each field has a fallback (no state replays at defaults,
// no icon says "view" in words).
export function pruneViewSnapshot(entry: NavEntry): void {
	if (entry.kind !== 'view')
		return;
	const view = entry as NavView & { state?: unknown; icon?: unknown; label?: unknown };
	if (view.state !== undefined
		&& (!view.state || typeof view.state !== 'object' || Array.isArray(view.state)))
		delete view.state;
	if (view.icon !== undefined && !(typeof view.icon === 'string' && view.icon))
		delete view.icon;
	if (view.label !== undefined && !(typeof view.label === 'string' && view.label))
		delete view.label;
}

// Both lists' STORAGE versions live with their stores, not here: this module is
// the shared VOCABULARY, and a format version is a fact about one store's blob.
