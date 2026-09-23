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

// A non-file main-area view destination: the global graph, Thino's memo list,
// a main-area search or local graph — anything the reader opened that is a place
// in the workspace rather than a place in a note. A pathless entry: traversal
// finds a leaf SHOWING that view, or builds one when it is nowhere (see
// nav-history/stack.ts's openViewPlace).
export interface NavView extends NavEntryBase {
	kind: 'view';
	viewType: string;
	// The name the view gives itself, for the row that stands for it (see
	// shared/leaf.ts's viewLabel). DISPLAY-ONLY, and optional: a view that never
	// named itself leaves it off and the browser answers with its own wording (see
	// model.ts's viewName). Recorded rather than looked up later because a
	// third-party view's name cannot be derived from its type — the type is what
	// identity is (see places.ts's placeKey), the name is what the reader reads.
	label?: string;
	// The icon the view gives itself, for the mark the row prints (see
	// shared/leaf.ts's viewIcon). DISPLAY-ONLY too, and optional for the same
	// reason: the row says "view" in words when the view offered none.
	icon?: string;
	// The view's own state as it stood while the reader was there (see
	// shared/leaf.ts's viewState): what a place is REBUILT with when its own tab
	// is gone or was swapped to another view — the local graph's file, a search's
	// query, a plugin view's filters. Optional: the global graph has no state to
	// speak of, and being rebuilt at the empty one is exactly right for it.
	//
	// It is a SNAPSHOT, not a live reference, and it is refreshed the same way the
	// label is: on every visit, and once more as the reader leaves the view (see
	// nav-history/stack.ts's refreshTopLeafOnActivation). Identity stays viewType
	// — two Thino tabs are one place with one state between them, whatever either
	// tab happened to be showing.
	state?: Record<string, unknown>;
}

// An INFERRED same-file cursor jump (large move, go-to-line, vim jump — the
// sampler's heuristic, gated by navHistoryTeleportMinLines and desktop-only): unlike the
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

// EVERY non-file main-area view is a destination, whatever its type is. The
// global graph was only ever the first one to be listed, and a whitelist made the
// list's answer depend on which plugins the reader has installed: Thino's memo
// list was not recorded at all, so while the reader sat in it the newest place on
// their recent-files list was still the FILE THEY CAME FROM — an unrelated note
// standing in for the place they had just gone to.
//
// The rule is therefore written as what is NOT a place, and there is one:
//   - 'empty' — the placeholder a main-area leaf shows with nothing in it. There
//     is nothing behind it to return to, and its row would open nothing.
// What else stays out is decided upstream and for another reason: a SIDEBAR panel
// is not a main-area leaf at all (see isMainAreaLeaf), so the outline, backlinks
// and a sidebar-resident Thino never reach this filter.
//
// Accepted with the widening, and why it is acceptable: a view entry is answered
// by a leaf that SHOWS that view — the entry's own, any other one, or one opened
// in a new tab when the view is nowhere (see nav-history/stack.ts's openViewPlace)
// — and is rebuilt with the state the view HAD while the reader was there (see
// NavView.state), so a local graph comes back on the note it was showing rather
// than on whatever is active at the time and a plugin view keeps its filters.
// Only a view that never had a state to record (the global graph) is rebuilt at
// the empty one, which is what its own `graph:open` passes too.
//
// THE BROWSER IS THE ONE CASE THAT ASKS FOR MORE ROWS THAN IT GETS, and the
// answer is deliberate. A built-in web view's state carries the url it is
// showing, so its PLACE is really that url — and since a place's identity is the
// view TYPE (see places.ts's placeKey), several of its tabs are several places
// sharing ONE row, each visit writing over the last. Giving every url a row would
// make this list a browsing history, which is the browser's own back/forward and
// not what this plugin is about. What stands instead is that the row follows the
// tab the reader LAST stood in: the state is re-read on every leave and refreshed
// while they sit in the view (see position/manager.ts's sampleActiveViewState),
// and the label travels with it, so the browser row MEANS "the page you were last
// reading" — one place, kept true, rather than many.
//
// The seam that follows from it: a url the reader never saw settled is not
// recorded. Obsidian's own web view has no url until the page has committed, so a
// tab opened and left inside the same beat leaves the row holding what the visit
// before it wrote — stale about WHICH page, never wrong about which place.
export const NON_DESTINATION_VIEW_TYPES = new Set(['empty']);

// Is this view type a place the recent-files list may hold? The one test, shared
// by the capture points that see a view only as a type (see nav/funnel.ts).
export function isRecordableViewType(viewType: string | undefined): boolean {
	return !!viewType && !NON_DESTINATION_VIEW_TYPES.has(viewType);
}

// Which LIST ROW a navigation belongs to: the note's path, or a pathless view's
// view TYPE. Two readers ask this and have to get the same answer, which is why it
// lives in the shared vocabulary rather than in either of them: the browser groups
// its rows by it (see listing.ts's groupByFile), and the places store drops a whole
// row by it (see NavPlaces.forget). Written once because a rule written twice is a
// rule that can drift — and a panel whose rows and a store whose removals disagree
// about what one row is would delete places the reader never pointed at.
//
// It is NOT a place's identity (see places.ts's placeKey). A note's own record and
// every jump made inside it are ONE row here and as many places there: what a reader
// takes off the list is the NOTE — the thing the list drew a row for — and a removal
// that left the jumps behind would leave the row behind with them. A view is the one
// case the two agree on, being one place and one row.
//
// A pathless entry is named by its view TYPE, and that type is its identity even
// though the row prints the view's own LABEL: two Thino tabs are one destination
// whatever either of them happens to be called, and two graph steps are two landings
// of one row rather than two rows (see model.ts's viewName for the name a row prints,
// which is a display fact and a separate one).
export function navGroupKey(entry: NewNavEntry): string {
	return entry.kind === 'view' ? `view:${entry.viewType}` : entry.path;
}

// What a stored view entry may NOT keep. The blob is device-local storage the
// reader (or a sync, or a truncation) can put anything into, and these three
// fields are the ones read straight back out into a REPLAY (`setViewState`) or
// into the DOM, so they are pruned to what they claim to be — while the ENTRY is
// kept. Dropping the whole entry would lose the place over a field that has a
// perfectly good fallback: no state replays the view at its defaults, no icon
// makes the row say "view" in words, no label makes it print its view type.
//
// In place, on the freshly parsed object, because that is what the loaders hold
// and nothing else has seen it yet.
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
// the shared VOCABULARY (what one navigation looks like), and a format version
// is a fact about one store's blob. The stack's is in nav-history/store.ts, the
// recent-files list's in recent-files/places-store.ts — each droppable without
// the other.
