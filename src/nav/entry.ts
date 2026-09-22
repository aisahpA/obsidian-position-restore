import { NavEntryState } from '@/types';

// One navigation, as the shared vocabulary describes it — four kinds, a
// discriminated union TAGGED by `kind` ('jump' | 'visit' | 'view' | 'teleport').
// Deliberately named after neither reader: the funnel publishes this shape (see
// nav/funnel.ts) and BOTH stores keep it — the stack as steps, the recent-files
// list as places. Every consumer reads the tag, never field presence: a
// malformed shape fails the type check and the load filter instead of slipping
// through a property coincidence, and a new variant flags every unexhausted
// switch. st (NavEntryState): its context block, mtime and anchor come from the
// low-frequency nav reads only.
export type NavEntry = NavJump | NavVisit | NavView | NavTeleport;

// What a recorder constructs: a variant without its timestamp. `t` is added
// by the stack's push — the single entry funnel — so no construction site can
// forget it and no caller can fake it.
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewNavEntry = DistributiveOmit<NavEntry, 't'>;

// Shared by every variant: the leaf the entry belongs to, and the wall-clock
// time it was pushed. `t` is DISPLAY-ONLY — the recent-files browser labels rows
// with a relative time, which is how a user actually indexes "where I was"
// (VSCode-style step counts are not a human unit). Stack ORDER always comes
// from array position, never from `t`: two entries can share a millisecond,
// and a jumpTo copy is stamped afresh when it is re-pushed.
export interface NavEntryBase {
	leafId: string;
	t: number;
}

// A keyed jump — outline:<heading>, an anchor/caller linktext. Carries the
// jump's precise landing: written when the landing settles, never
// overwritten afterwards (back/forward must return to the jump target
// itself). The key also dedups: a push whose key equals the top entry's
// key is the same jump repeated (repeated outline clicks to one heading)
// and is dropped.
export interface NavJump extends NavEntryBase {
	kind: 'jump';
	path: string;
	key: string;
	// Line the key's anchor sat on WHEN THE ENTRY WAS RECORDED (upgraded at
	// the landing settle from metadataCache — the authoritative record-time
	// line). Gives the structural re-anchor its true delta base: the anchor's
	// own line, NOT the recorded scroll (the viewport top — it drifts with
	// viewport geometry, file-tail positions, and CM's near-edge scrolling,
	// so a scroll-based delta would shift the view to pin the heading at the
	// viewport top even in an unedited file). Absent until the landing
	// upgrades the entry; ^block keys are never upgraded (their landing
	// geometry cannot be tied to the block id) — those entries ride the
	// text-snippet remap, whose base and target share the viewport-line
	// semantics and are self-consistent.
	keyLine?: number;
	st?: NavEntryState;
}

// A keyless visit — a file open or a tab/pane activation (VSCode records
// active editor changes the same way, and an activation following an open
// of the same file in the same leaf is absorbed by it). Carries no
// position of its own: st is refreshed on every leave ("where the user
// actually was").
export interface NavVisit extends NavEntryBase {
	kind: 'visit';
	path: string;
	st?: NavEntryState;
	// How this step was made. Display-only (the browser's badge): never
	// participates in dedup or positioning. 'switch' is a tab/pane
	// activation, 'link' an open that came from clicking a link — the
	// distinction a plain [[note]] link needed, since it carries no key of
	// its own (see viaPath/viaText below).
	via?: 'switch' | 'link';
	// For a 'link' open: the note the link was CLICKED IN, and the link's own
	// text as written (which may carry a |display alias). Both are recorded
	// because neither is derivable later — the destination path above says
	// where the user arrived, never where they came from — and both are
	// searchable, so "the note I followed that link from" and "the words the
	// link said" are queries the history can answer. A link that carried a
	// #/^ target is recorded as a keyed NavJump instead (its key already
	// names the target), so these fields describe plain file links only.
	viaPath?: string;
	viaText?: string;
}

// A non-file main-area view destination (the global graph); a pathless
// entry — traversal just reactivates the leaf.
export interface NavView extends NavEntryBase {
	kind: 'view';
	viewType: string;
}

// An INFERRED same-file cursor jump (large move, go-to-line, vim jump — the
// sampler's heuristic, toggleable via navRecordTeleport): unlike the
// deliberate NavJump sources (outline click, anchor link, search/backlinks
// caller) the user may not perceive it as a jump at all, so it is its own
// kind — deduped by target line, carrying the jump's precise landing (same
// regime as NavJump: written at push time or when it settles, never
// overwritten), and shown with its own (dimmed) badge in the browser.
export interface NavTeleport extends NavEntryBase {
	kind: 'teleport';
	path: string;
	line: number;
	st?: NavEntryState;
}

// Non-file main-area views recorded as entries: the global graph is a real
// destination (note → graph → note hops, and its leaf can be shared with
// files via node clicks / graph:open tab reuse). Whitelisted — sidebar
// panels are excluded by isMainAreaLeaf, the empty tab and dragged-in
// sidebars stay out, and localgraph is omitted (its view state carries the
// tracked file, which a pathless entry cannot restore).
export const RECORDABLE_VIEW_TYPES = new Set(['graph']);

// Both lists' STORAGE versions live with their stores, not here: this module is
// the shared VOCABULARY (what one navigation looks like), and a format version
// is a fact about one store's blob. The stack's is in nav-history/store.ts, the
// recent-files list's in recent-files/places-store.ts — each droppable without
// the other.
