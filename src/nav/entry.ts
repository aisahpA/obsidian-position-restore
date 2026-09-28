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
	// Absent until the upgrade, and for a target the cache no longer names — a
	// renamed heading, a deleted block — which rides the text-snippet remap.
	keyLine?: number;
	st?: NavEntryState;
}

// A keyless visit: a file open or a tab/pane activation. Carries no position of
// its own — st is refreshed on every leave.
export interface NavVisit extends NavEntryBase {
	kind: 'visit';
	path: string;
	st?: NavEntryState;
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

// A CALLER target: a search match, or a backlink hit, inside the note the reader is already in —
// core hands that target over as an ephemeral state rather than as a link, so it names no anchor
// and carries no linktext, and restore/patcher.ts keys it `caller:<ms>` to keep two clicks apart.
//
// It is named here because it is not one store's business: the recent-files list demotes it to the
// note it landed in (see NavPlaces.remember), while the stack keeps it — going back to that hit is
// a real step, and the landing the settle captured is the one thing that makes it repeatable.
export const CALLER_KEY_PREFIX = 'caller:';

export function isCallerKey(key: string | undefined): boolean {
	return !!key && key.startsWith(CALLER_KEY_PREFIX);
}

// A wikilink arrives WHOLE, display alias and all (`note#^id|shown as`): core
// has resolved the link by the time we see it, so everything from the `|` on is
// a label, not part of the target. Left on, it makes both anchor kinds
// unmatchable — a block id becomes `id|shown as` (no such block), and a heading
// slug never equals its heading. Taken off once, where the linktext becomes a
// key (see restore/patcher.ts), so no reader has to know about it.
export function stripLinkAlias(text: string): string {
	const bar = text.indexOf('|');
	return bar < 0 ? text : text.slice(0, bar);
}

// What a keyed jump's target NAMES, when the target is a BLOCK: the block id, without the `^`.
// Two decisions hang on it and have to agree — restore/anchor.ts looks the id up in the metadata
// cache to re-anchor a step, and the recent-files list keeps no place for a block (see
// NavPlaces.remember) — so it is split out of the key once, here, and not twice downstream.
//
// The key is the linktext: `note.md#^id`, `#^id` (a link inside the note itself) or `note.md^id`.
// A heading link (`note.md#slug`) and an outline key (`outline:## H`) carry a `#` too, which is
// why it is the `^` that decides — and why a `#^id` link used to be read as a heading slug.
export function blockAnchor(key: string): string | undefined {
	const hash = key.indexOf('#');
	const caret = key.indexOf('^');
	const at = caret < 0 ? hash : hash < 0 ? caret : Math.min(hash, caret);
	if (at < 0)
		return undefined;
	const rest = key.slice(at + 1);
	if (key[at] !== '^' && !rest.startsWith('^'))
		return undefined;
	// Lowercased because that is the form the metadata cache keeps block ids in — it
	// keys `blocks` by `id.toLowerCase()` and core matches a link's id the same way, so
	// a hand-written `^MyBlock` names a block the cache only knows as `myblock`.
	const id = rest.startsWith('^') ? rest.slice(1) : rest;
	return id.toLowerCase();
}

export function isBlockKey(key: string | undefined): boolean {
	return !!key && blockAnchor(key) !== undefined;
}

// What an outline key's target NAMES: the heading's own words as they were recorded, in
// either of the two forms the key takes (see restore/anchor.ts) — "outline:## H" carries
// the level and the source, "outline:H" the rendered text alone. Read off THE RECORD and
// never off the file, because it is asked exactly where the two part ways: a heading the
// note no longer has leaves these words as the only thing that still says which landing a
// row stands for (see the browser's trailFor), and a chain read at that row's line number
// would answer with the section a DIFFERENT spot now sits in.
//
// Undefined for every other key: a linktext, a block id or a caller target carries no
// heading's words, and a row that printed its slug or its timestamp would be naming a
// section it never stood for either.
export function outlineHeading(key: string | undefined): string | undefined {
	if (!key?.startsWith('outline:'))
		return undefined;
	const words = key.slice('outline:'.length).trim().replace(/^#{1,6}\s+/, '').trim();
	return words || undefined;
}

// Which line a step landed on, or undefined when it recorded none. A jump answers out of its own
// KEY: every landing either list keeps was a heading jump, and the key's line is where metadataCache
// put that heading as the landing settled — the line its row travels to. The recorded POSITION is the
// fallback for what carries no such answer: a keyless step, and a jump to a target since renamed
// away, both of which say where the reader stood and nothing else.
//
// This is what "the SAME landing" means, and it lives here because TWO things decide by it and have
// to agree: the panel collapses the steps that landed on one line into one row, and the places store
// keeps one record per landing. Written twice, it drifts.
export function landedLine(entry: NavEntry): number | undefined {
	if (entry.kind === 'view')
		return undefined;
	if (entry.kind === 'jump' && typeof entry.keyLine === 'number')
		return entry.keyLine;
	const st = entry.st;
	if (!st)
		return undefined;
	return st.scroll ?? st.cursor?.from.line;
}

// Both lists' STORAGE versions live with their stores, not here: this module is
// the shared VOCABULARY, and a format version is a fact about one store's blob.
