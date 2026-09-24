import { App } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from '@/types';
import { NavEntry, NewNavEntry, navGroupKey } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { normAnchor } from '@/position/capture/ephemeral';
import { frontmatterOfPath, frontmatterRuleMatches } from '@/shared/frontmatter';
import { loadNavPlaces, persistNavPlaces } from './places-store';

// THE RECENT FILES LIST — the panel's (and only the panel's) data.
//
// NOT the back/forward stack (see nav-history/stack.ts), and the two are deliberately
// separate stores: the stack is a TRAVERSAL device — ordered, cursor-bound, and
// TRUNCATING, so a fresh jump discards the forward part and a list drawn from it loses
// a chunk of itself the moment the reader branches. This is a PLACE store: unordered,
// never truncated by a jump, deduped by place. (A place can still leave — see forget —
// but nothing about GOING anywhere removes one, and nothing fills one back in.)
//
// WHAT IS IN IT. Two kinds of place:
//   - one FILE record per path (`kind: 'visit'`), holding no position of its own. The
//     line the panel prints and the spot a plain open lands on both come from the
//     position database, so a click here behaves like a click in the file explorer
//     (including its exclusion rules). Duplicating that position here would make the
//     two open paths disagree.
//   - one record per JUMP (`kind: 'jump'` — an outline click, an anchor link), carrying
//     its own landing, which exists nowhere else. Identity is the heading/anchor KEY,
//     not the line: a heading that moved in an edit is the same place.
// A pathless view (the graph, Thino's memo list) is one record, as in the panel.
//
// WHAT IS NOT IN IT: teleports (the sampler's INFERRED cursor moves), and — at the
// bottom stop of the landings setting — jumps (see LandingsMode): neither is a place
// the reader chose to go to.
//
// ORDER IS THE MRU ORDER: a touched place moves to the END. The panel reads an index as
// a clock (list.ts's activeRep), so an in-place update would leave a re-touched place
// looking older than it is.
//
// WHO FEEDS IT. Nothing here reaches for anything: the composition root subscribes this
// store to the recording funnel (see nav/funnel.ts), and it hears the same navigations
// the stack does — the two lists keep different things from one recording.

export interface PlaceList {
	// Oldest first. Read as a plain NavEntry list: every consumer in the browser takes
	// that shape and is unchanged by this store.
	entries: NavEntry[];
	// The place the reader is in NOW, or -1. Not persisted: "here" is a live fact about
	// the workspace, not something a restart can restore.
	index: number;
	// Go to a place: a FILE record opens the file the plain way, a JUMP record opens it
	// and lands on the recorded spot (see NavPlaces.travel). `target` is where to open
	// it when the reader asked for somewhere other than the tab the file is already in
	// (see PaneTarget); absent means the ordinary open.
	travel(index: number, target?: PaneTarget): Promise<void>;
	// Drop every place ONE ROW stands for: a note's own record and each jump inside it,
	// or the single record a pathless view holds. `key` is the row's identity (see
	// nav/entry.ts's navGroupKey), and a ROW is deliberately what this is about: a note
	// is one row however many spots it holds, and the reader asked from the row.
	//
	// A row's identity and not a path, because a path cannot name a pathless view.
	//
	// What it does NOT touch is why this list can be edited at all: the file itself, and
	// the position records — a different store, keyed by path. A file visited again takes
	// its place back, by design. A reader who never wants a file listed wants one of the
	// rules instead (see recordable), which is a policy rather than a one-off.
	forget(key: string): void;
	// Drop ONE LANDING of a note: the places the row UNDER the note's own row stands
	// for, handed over BY IDENTITY (see placeKey below) rather than by index. The panel
	// collapses onto a row every place that landed on that line (see list.ts's
	// landingKeys), so a removal naming the row's own record alone would leave its twin
	// behind and the row would be back before the redraw finished: a × that does
	// nothing.
	//
	// What stays is the note's own record and its other places.
	forgetLanding(keys: readonly string[]): void;
	// Something a browser would have to redraw for.
	subscribe(fn: () => void): () => void;
}

// What the store needs to travel. Injected (and implemented by NavStack, which owns the
// open pipeline) rather than reached for, so this module stays a pure list: it can be
// built and tested without a workspace.
export interface PlaceOpeners {
	// Open a file the way the file explorer does: activate the tab holding it, or open it
	// there. NO injected landing — the position database decides. With a `target`, the
	// file opens in a leaf the app picks for that target (a new tab, a split, a window)
	// and the landing rule is unchanged (see stack.ts).
	openFile(path: string, leafId: string, target?: PaneTarget): Promise<void>;
	// Open the file a jump was made in and land on the jump's recorded spot.
	openJump(entry: NavEntry, target?: PaneTarget): Promise<void>;
	// Show a pathless view: in the leaf that already holds it, or in a new tab when it is
	// nowhere. The entry arrives WHOLE, so a tab that has to be built is built as the
	// place the reader left (see NavView.state).
	openView(entry: NavEntry, target?: PaneTarget): Promise<void>;
}

// The no-op opener: a store built without a workspace still records places and still
// answers the panel; it just cannot travel.
const NO_OPENERS: PlaceOpeners = {
	openFile: async () => undefined,
	openJump: async () => undefined,
	openView: async () => undefined,
};

export class NavPlaces implements PlaceList {
	entries: NavEntry[] = [];
	index = -1;

	private listeners = new Set<() => void>();
	private open: PlaceOpeners = NO_OPENERS;
	private lastPersisted = '';

	constructor(
		private app: App,
		// The one shared settings object: the ceiling and this list's own folder rule are
		// read live, so changing either takes effect on the next write.
		private settings: PluginSettings,
	) {
		this.entries = loadNavPlaces(app);
	}

	// The composition root hands in the open pipeline once it exists (see
	// position/manager.ts). Separate from construction because the two objects need each
	// other: the funnel feeds this list, and a click here travels out through the stack.
	attach(open: PlaceOpeners): void {
		this.open = open;
	}

	// ===== Configuration =====

	// Whether this list records JUMPS — everything but the bottom stop of the landings
	// setting (see LandingsMode), where the list is notes and views and nothing else.
	//
	// It answers RECORDING and only recording, never retention: a jump recorded at an
	// upper stop is a place like any other, and coming down to 'none' leaves it where it
	// is — it stops new ones being recorded, and what finally takes the old ones is the
	// trim (see dropOldestLandings). Which is why no stop is a one-way door.
	private recordsJumps(): boolean {
		return this.settings.recentFilesLandings !== 'none';
	}

	// How many NOTES the list is kept to: the setting, clamped, with DEFAULT_SETTINGS as
	// the fallback for a value that is not a number at all (a hand-edited data.json would
	// otherwise make every `length > cap` comparison false and disable the ceiling
	// entirely — the same guard as the stack's stackCap). What it counts is the row a
	// note or view stands for (see rowCount), not the landings inside it.
	cap(): number {
		const cap = Math.floor(this.settings.recentFilesCap);
		return Number.isFinite(cap) ? Math.max(1, cap) : DEFAULT_SETTINGS.recentFilesCap;
	}

	// Whether a path may be listed at all: this list's OWN rules, and no other feature's.
	// The reader's folder list and property list answer "which visits are worth listing",
	// and are deliberately not the position recording's excludedFolders and
	// frontmatterExcludeProperties, which answer a different question (see
	// PluginSettings.recentFilesExcludeFolders / recentFilesExcludeProperties).
	private recordable(path: string): boolean {
		if (!path)
			return false;
		// Vault-internal paths are never listed: the configuration folder (whatever the
		// user named it — see Vault#configDir) is not notes, and Obsidian's trash holds
		// files the bookkeeper drops anyway.
		const config = (this.app.vault as { configDir?: string }).configDir;
		if (config && (path === config || path.startsWith(`${config}/`)))
			return false;
		if (path.startsWith('.trash/'))
			return false;
		const folders = this.settings.recentFilesExcludeFolders ?? [];
		if (folders.some(folder => {
			const clean = folder.replace(/\/+$/, '');
			return !!clean && (path === clean || path.startsWith(`${clean}/`));
		}))
			return false;
		return !this.excludedByFrontmatter(path);
	}

	// `status` keeps out every file carrying the property whatever its value,
	// `status: archived` only the files whose value equals it — the one entry form this
	// plugin writes, shared with the position rules (see shared/frontmatter.ts).
	//
	// Asked LAST, and only when the reader has written a rule: it is the one test here
	// that reaches into the vault, and with an empty list — the default — the answer is
	// "no" without touching the metadata cache.
	//
	// A file the cache has not parsed yet IS listed: the cache fills lazily, and a place
	// withheld on a guess is a place the reader cannot get back, while a place listed by
	// mistake is one they can drop.
	private excludedByFrontmatter(path: string): boolean {
		const rules = this.settings.recentFilesExcludeProperties ?? [];
		if (rules.length === 0)
			return false;
		return frontmatterRuleMatches(frontmatterOfPath(this.app, path), rules);
	}

	// ===== Reading =====

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private changed(): void {
		for (const fn of this.listeners)
			fn();
	}

	// ===== Writing =====

	// A place was visited — the funnel's `onVisit`, for every navigation but a teleport
	// (see the class comment). Called BEFORE the stack decides whether the step is worth
	// keeping: a place being sat in again is a fact about THIS list, and the stack's
	// dedup or its settings must not be able to hide it. A place already on the list is
	// moved to the end and re-stamped, never duplicated — that is what makes a file
	// opened ten times one row.
	remember(entry: NewNavEntry): void {
		if (entry.kind === 'teleport')
			return;
		// Asked of the KIND rather than of the file, and before the list's own file rules:
		// those answer whether a file may be listed, which is a different question from
		// whether the spots inside it are remembered.
		if (entry.kind === 'jump' && !this.recordsJumps())
			return;
		if (entry.kind !== 'view' && !this.recordable(entry.path))
			return;
		const key = placeKey(entry);
		const at = this.indexOf(key);
		const prev = at < 0 ? undefined : this.entries[at];
		const record = placeRecord(entry, prev);
		if (at >= 0)
			this.entries.splice(at, 1);
		this.entries.push(record);
		// The reader is standing in the place they just went to, which every
		// navigation this list hears sets — the funnel's `here` broadcast
		// reaches it from a traversal alone. Set before the trim, so its
		// exemption (see dropOldestRows / dropOldestLandings) protects this
		// place and not a stale one.
		this.index = this.entries.length - 1;
		this.trim();
		this.changed();
	}

	// A detail of a place that ALREADY exists became known — the funnel's `onLanded`. The
	// stack fills a jump's landing in when it settles (after upgrading the key) and
	// re-reads a VIEW's own state as the reader leaves it; a row is what the reader
	// clicks, so what comes back has to be the place they left.
	settle(entry: NewNavEntry): void {
		if (entry.kind === 'view') {
			// The view the reader just left, re-read. Its state is the one thing about a
			// view that cannot be derived later (see NavView.state); the name and the icon
			// come along because a view that renamed itself during that visit should be
			// listed under what the reader just read. The stamp moves with them.
			if (!entry.state)
				return;
			const at = this.indexOf(placeKey(entry));
			if (at < 0)
				return;
			const place = this.entries[at];
			if (place.kind !== 'view')
				return;
			place.state = entry.state;
			if (entry.label !== undefined)
				place.label = entry.label;
			if (entry.icon !== undefined)
				place.icon = entry.icon;
			place.t = Date.now();
			this.changed();
			return;
		}
		if (entry.kind !== 'jump' || !entry.st)
			return;
		const at = this.indexOf(placeKey(entry));
		if (at < 0)
			return;
		const place = this.entries[at];
		if (place.kind !== 'jump')
			return;
		// The stack upgrades an outline key to the heading's authoritative source form
		// ("outline:T" → "outline:## T") when the landing settles. The place's key
		// follows, because the panel reads it back for the structural re-anchor; its
		// IDENTITY does not change (placeKey normalizes), which is why the lookup above
		// still found it.
		place.key = entry.key;
		if (typeof entry.keyLine === 'number')
			place.keyLine = entry.keyLine;
		place.st = entry.st;
		place.t = Date.now();
		this.changed();
	}

	// Which place the reader is in. The stack's current record maps to a place by
	// identity; an inferred step (a teleport) maps to its FILE, because the reader is in
	// that file however they got there.
	//
	// "Here" is a live fact about the workspace, so it is NOT persisted and NOT invented:
	// a list that came up empty stays empty until the reader goes somewhere, and nothing
	// here puts the note they happen to be reading back on their own list.
	markCurrent(entry?: NewNavEntry): void {
		const at = this.indexFor(entry);
		if (at === this.index)
			return;
		this.index = at;
		this.changed();
	}

	// ===== Bookkeeping =====

	// A rename re-keys the places that named the file. Identity is recomputed from `path`,
	// so no stored key has to be rewritten (a jump's own `key` is a heading/anchor).
	renameFile(oldPath: string, newPath: string): void {
		let renamed = false;
		for (const entry of this.entries) {
			if (entry.kind === 'view' || entry.path !== oldPath)
				continue;
			entry.path = newPath;
			renamed = true;
		}
		if (renamed)
			this.changed();
	}

	// A real vault delete drops the file's places — its file record and every jump inside
	// it. The panel's rows for them would otherwise be dead names holding slots in a
	// capped list. The key handed on IS the path: a file's row identity is its path (see
	// navGroupKey) — the one case the row and the path agree on.
	deleteFile(path: string): void {
		this.dropPlaces(path);
	}

	// The reader asked for a row to go: the × on the row itself (see
	// RecentFilesBrowser.onForget). The same removal as a vault delete, by the same rule,
	// and a second name rather than the bookkeeper's entry point reused, because the two
	// answer different questions: that one is the VAULT saying the file is gone, this one
	// is the reader saying they do not want to see it.
	forget(key: string): void {
		this.dropPlaces(key);
	}

	// One landing of a note, taken off by the reader (see RecentFilesBrowser's
	// forgetLanding — the × on a landing's own row). The keys arrive from the panel,
	// which is the only thing that knows which places one row stands for, and they are
	// matched against the list's OWN identity for a place (see placeKey): a dialog's
	// snapshot may be a click behind the store.
	forgetLanding(keys: readonly string[]): void {
		const doomed = new Set(keys);
		if (doomed.size === 0)
			return;
		const before = this.entries.length;
		// …and the "you are here" pointer rides along with the filter, exactly as it does
		// for every other removal here (see keep): a reader standing ON the spot they are
		// taking off is a reader whose pointer has nowhere to stand, which is the honest
		// answer rather than a bug.
		this.keep(this.entries.filter(e => !doomed.has(placeKey(e))));
		if (this.entries.length === before)
			return;
		this.changed();
	}

	// The one removal both names above stand for, keyed by ROW (see navGroupKey): every
	// record the row is drawn from goes at once. It takes a row rather than a path because
	// a view has no path — a path-keyed filter can only ever leave every view standing.
	private dropPlaces(key: string): void {
		const current = this.entries[this.index];
		const kept = this.entries.filter(e => navGroupKey(e) !== key);
		if (kept.length === this.entries.length)
			return;
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
		this.changed();
	}

	// One of the list's rules changed (the settings tab — a folder added, or a property):
	// drop the places it now excludes, so a place the reader can no longer be shown does
	// not keep a slot in the capped list.
	// @returns how many places were dropped.
	pruneExcluded(): number {
		const current = this.entries[this.index];
		const kept = this.entries.filter(e => e.kind === 'view' || this.recordable(e.path));
		const removed = this.entries.length - kept.length;
		if (removed === 0)
			return 0;
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
		this.changed();
		return removed;
	}

	// Every file path the list still names (view records name none) — the startup sweep's
	// input (see PathBookkeeper.sweepMissingHistory).
	knownPaths(): string[] {
		const seen = new Set<string>();
		for (const entry of this.entries)
			if (entry.kind !== 'view')
				seen.add(entry.path);
		return Array.from(seen);
	}

	// ===== Travel =====

	// Go to a place. The RECORD KIND decides how:
	//   - a FILE record opens the file the plain way, exactly as the file explorer does.
	//     It carries no position, so nothing is injected: the position database restores
	//     whatever it restores (or nothing, for an excluded file), which keeps the two
	//     entry points to one file from behaving differently.
	//   - a JUMP record is an explicit navigation, like back/forward, so it carries its
	//     own landing and lands on it.
	//   - a view record is answered by a leaf SHOWING that view: the one it came from, any
	//     other one, or a new tab when the view is nowhere (a place outlives the tab it
	//     happened in). A tab built for it is built with the state the view had while the
	//     reader was there (see NavView.state) — see stack.ts's openViewPlace.
	// `target` decides WHERE all three open, when the reader held a modifier down (see
	// PaneTarget). Absent — the ordinary click — the record's own leaf is the answer,
	// which is the plugin's whole point: a place takes you back to where it was, which
	// `getLeaf(false)` cannot express.
	async travel(index: number, target?: PaneTarget): Promise<void> {
		const entry = this.entries[index];
		if (!entry)
			return;
		if (entry.kind === 'jump') {
			await this.open.openJump(entry, target);
			return;
		}
		if (entry.kind === 'view') {
			await this.open.openView(entry, target);
			return;
		}
		await this.open.openFile(entry.path, entry.leafId, target);
	}

	// The ceiling changed (the settings tab): trim NOW rather than on the next visit —
	// waiting drops a large chunk at once, later, unexplained.
	// @returns how many places were discarded.
	applyCap(): number {
		const removed = this.trim();
		if (removed > 0)
			this.changed();
		return removed;
	}

	// ===== Persistence =====

	// The last blob THIS instance wrote (the flush dedup — see persistNavPlaces). An
	// instance field, not module state: the list is per vault, and a dedup shared between
	// instances would let one skip a write it owes.
	persist(): void {
		this.lastPersisted = persistNavPlaces(this.app, this.entries, this.lastPersisted);
	}

	// ===== Internals =====

	private indexOf(key: string): number {
		for (let i = 0; i < this.entries.length; i++)
			if (placeKey(this.entries[i]) === key)
				return i;
		return -1;
	}

	// The place index a stack record stands on, with the fallbacks the "you are here"
	// marker needs: an inferred step stands on its file, and a jump whose own place is
	// gone (evicted, or never recorded) stands on its file too.
	private indexFor(entry?: NewNavEntry): number {
		if (!entry)
			return -1;
		if (entry.kind !== 'teleport') {
			const at = this.indexOf(placeKey(entry));
			if (at >= 0)
				return at;
		}
		if (entry.kind === 'view')
			return -1;
		return this.indexOf(entry.path);
	}

	// Keep the list inside its ceiling by dropping the OLDEST things — never the one the
	// reader is standing in, so a row cannot be evicted from under them by the trim their
	// own visit triggered. That keeps the ceiling exact rather than letting the list run
	// over it for as long as the reader sits on an old place.
	//
	// TWO CEILINGS, both the same number: the one the reader sets bounds what they are
	// SHOWN, while this one bounds what is STORED — a place they are not being shown must
	// not be able to cost them a place they are (see PluginSettings.recentFilesCap).
	//   - ROWS first. A row goes WHOLE — the note's own record and every landing inside
	//     it, the way forget takes them — so a jump can never push a file off the list.
	//   - LANDINGS second, counted over the whole list rather than per note, because a
	//     jump is by far the heaviest record here (it carries the lines that were on
	//     screen with it, see NavEntryState.context) and the ceiling above does not count
	//     it. It drops the OLDEST landings, never the row they stand in.
	// @returns how many were dropped.
	private trim(): number {
		const before = this.entries.length;
		this.dropOldestRows();
		this.dropOldestLandings();
		return before - this.entries.length;
	}

	// Drop whole rows until the list is inside its ceiling. A row is a note (or a view) in
	// EVERY mode — the ceiling counts notes, so the mode only changes how many lines a row
	// takes to draw. Rows are ordered by their NEWEST place: the same clock the panel
	// reads, an index being the time (see list.ts).
	private dropOldestRows(): void {
		const over = this.rowCount() - this.cap();
		if (over <= 0)
			return;
		const newest = new Map<string, number>();
		for (let i = 0; i < this.entries.length; i++)
			newest.set(navGroupKey(this.entries[i]), i);
		const oldestFirst = Array.from(newest.entries())
			.sort((a, b) => a[1] - b[1])
			.map(([key]) => key);
		const currentKey = this.index >= 0 ? navGroupKey(this.entries[this.index]) : undefined;
		const doomed = new Set<string>();
		for (const key of oldestFirst) {
			if (doomed.size >= over)
				break;
			if (key === currentKey)
				continue;
			doomed.add(key);
		}
		this.keep(this.entries.filter(e => !doomed.has(navGroupKey(e))));
	}

	// How many rows the list draws, which is what the ceiling counts: a note is one row
	// however many landings it holds. The same in all three modes — a mode that made the
	// ceiling count landings too would leave the reader's number meaning two things (see
	// PluginSettings.recentFilesCap).
	rowCount(): number {
		const seen = new Set<string>();
		for (const entry of this.entries)
			seen.add(navGroupKey(entry));
		return seen.size;
	}

	// The landings' own ceiling: the same number, counted over every jump in the list at
	// once rather than per note. One shared pool rather than a budget each, because what
	// it bounds is what the list STORES: the jumps it spends the pool on are the ones the
	// reader actually made, so a note they jumped around in keeps as many as it earned and
	// a note they only read keeps none.
	private dropOldestLandings(): void {
		let held = 0;
		for (const entry of this.entries)
			if (entry.kind === 'jump')
				held++;
		const over = held - this.cap();
		if (over <= 0)
			return;
		const kept: NavEntry[] = [];
		let dropped = 0;
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (entry.kind === 'jump' && dropped < over && i !== this.index) {
				dropped++;
				continue;
			}
			kept.push(entry);
		}
		this.keep(kept);
	}

	// Put a filtered array in the list's place, keeping the "you are here" pointer on the
	// same place when that place survived the filter.
	private keep(kept: NavEntry[]): void {
		if (kept.length === this.entries.length)
			return;
		const current = this.entries[this.index];
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
	}
}

// A record's IDENTITY on the list. Not stored: it is recomputed from the record (see
// places-store's loader), so a rule change cannot leave stale keys behind.
//
//   - a FILE is its path. One record per file, whichever tab it was read in: the per-tab
//     split is the position database's business, and the panel draws one row per note.
//   - a JUMP is its heading/anchor KEY, normalized. The key is what survives an edit that
//     moves the heading (see nav-history/stack.ts's upgradeKeyLine and
//     resolveAnchorShift), and normalizing is what makes the rendered form ("outline:T")
//     and the authoritative source form ("outline:## T") ONE place rather than two — the
//     same normalization the stack's own dedup uses.
//   - a VIEW is its view type, as in the panel's grouping.
// Typed on NewNavEntry: both a stored record and a recording heard from the funnel answer
// to it (a record is a recording with the stamp added).
export function placeKey(entry: NewNavEntry): string {
	switch (entry.kind) {
		case 'view':
			return `view:${entry.viewType}`;
		case 'jump':
			return `${entry.path}#${normalizeJumpKey(entry.key)}`;
		case 'teleport':
			return `${entry.path}#teleport:${entry.line}`;
		case 'visit':
			return entry.path;
	}
}

// An outline key keeps its prefix (so a heading and a same-named anchor are not one
// place) and loses the hashes its two forms differ by; everything else is taken as
// written.
function normalizeJumpKey(key: string): string {
	const prefix = 'outline:';
	return key.startsWith(prefix)
		? `${prefix}${normAnchor(key.slice(prefix.length))}`
		: normAnchor(key);
}

// A FILE place keeps no position (see the class comment); its link origin is display-only
// data the panel's head shows — carried along, since a place is what most recently stood
// for it.
function placeRecord(entry: NewNavEntry, prev?: NavEntry): NavEntry {
	const t = Date.now();
	switch (entry.kind) {
		case 'visit':
			return {
				kind: 'visit', path: entry.path, leafId: entry.leafId, t,
				via: entry.via, viaPath: entry.viaPath, viaText: entry.viaText,
			};
		case 'jump': {
			const kept = prev?.kind === 'jump' ? prev : undefined;
			return {
				kind: 'jump', path: entry.path, leafId: entry.leafId, key: entry.key, t,
				keyLine: entry.keyLine ?? kept?.keyLine,
				// A re-click of a heading carries no landing yet (it arrives with the
				// settle): the one already recorded stands until then, so the row never
				// loses the spot it promises.
				st: entry.st ?? kept?.st,
			};
		}
		case 'view': {
			// The label and the icon are refreshed by every visit: a view that renamed
			// itself is named and marked by what it says NOW. A read that came back empty
			// simply drops them, and the row falls back to this list's own wording.
			//
			// The STATE is the exception, and deliberately: a visit whose state read came
			// back empty (the view threw, answered with nothing, or went over the ceiling
			// — see shared/leaf.ts's viewState) KEEPS the snapshot already recorded
			// instead of erasing it. One failed read must not cost the reader the place
			// they left.
			const kept = prev?.kind === 'view' ? prev : undefined;
			return {
				kind: 'view', leafId: entry.leafId, viewType: entry.viewType, t,
				label: entry.label, icon: entry.icon,
				state: entry.state ?? kept?.state,
			};
		}
		default:
			// Unreachable: remember() refuses teleports. Typed as a visit so a future
			// variant fails the type check here rather than silently.
			return { kind: 'visit', path: entry.path, leafId: entry.leafId, t };
	}
}
