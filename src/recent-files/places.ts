import { App } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from '@/types';
import { NavEntry, NewNavEntry, navGroupKey } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { normAnchor } from '@/position/capture/ephemeral';
import { frontmatterOfPath, frontmatterRuleMatches } from '@/shared/frontmatter';
import { loadNavPlaces, persistNavPlaces } from './places-store';

// THE RECENT FILES LIST — the panel's (and only the panel's) data.
//
// It answers one question: which files has the reader been in, and which
// headings or anchors did they jump to inside them. It is NOT the back/forward
// stack (nav-history/stack.ts), and the two are deliberately separate stores:
//
//   - the stack is a TRAVERSAL device: ordered, cursor-bound, capped small, and
//     TRUNCATING — a fresh jump discards the forward part, because that is what
//     back/forward means. A list of places drawn from it therefore lost a whole
//     chunk of itself the moment the reader went back and then somewhere else.
//   - this list is a PLACE store: unordered, never truncated by a jump, and
//     deduped by place. Going back and branching adds a place; it removes
//     nothing. (A place can still leave it — the reader may take a file off the
//     list by hand, see forget — but nothing about GOING anywhere removes one,
//     and nothing fills one back in.)
//
// WHAT IS IN IT. Two kinds of place, and no more:
//   - one FILE record per path (`kind: 'visit'`), holding no position of its
//     own. The line the panel prints for it and the place a plain open lands on
//     both come from the position database — the plugin's own "where I left
//     this file" feature — so a click here behaves exactly like a click in
//     Obsidian's file explorer (including its exclusion rules: a file the
//     reader excluded from position recording simply has no line). Duplicating
//     that position here would make the two open paths disagree.
//   - one record per JUMP the reader made (`kind: 'jump'` — an outline click or
//     an anchor link), carrying its own precise landing. That position exists
//     nowhere else, and a jump row that did not land on its jump would be a
//     broken promise. Identity is the heading/anchor KEY, not the line: a
//     heading that moved in an edit is the same place.
// A pathless view (the graph, Thino's memo list) is one record, as it is in the
// panel.
//
// WHAT IS NOT IN IT: teleports (the sampler's INFERRED large cursor moves), and
// — at the bottom stop of the landings setting — jumps (see LandingsMode): neither is a place the reader chose to
// go to. Teleports were the whole reason the list needed a second eviction tier
// to keep them from crowding out the real places; dropping them leaves one
// eviction rule, whose unit is the ROW (see trim).
//
// ORDER IS THE MRU ORDER: a touched place is moved to the END. The panel reads
// an index as a clock (list.ts's activeRep: the highest index among a note's
// landings is its newest), so a re-touched place MUST move — an in-place update
// would leave it looking older than it is.
//
// WHO FEEDS IT. Nobody here reaches for anything: the composition root subscribes
// this store to the recording funnel (see nav/funnel.ts) and it hears the same
// navigations the back/forward stack does — the two lists keep different things
// from one recording, which is exactly why they are two stores.

export interface PlaceList {
	// The places, oldest first. Read as a plain NavEntry list: every
	// consumer in the browser (describeNavEntry, groupByFile, the search box,
	// the landing panel) takes that shape and is unchanged by this store.
	entries: NavEntry[];
	// The place the reader is in NOW, or -1. Not persisted: "here" is a live
	// fact about the workspace, not something a restart can restore.
	index: number;
	// Go to a place: a FILE record opens the file the plain way, a JUMP record
	// opens it and lands on the recorded spot (see NavPlaces.travel).
	// `target` is where to open it, when the reader asked for somewhere other
	// than the tab the file is already in (see PaneTarget); absent means the
	// ordinary open, which is what the row's own click is.
	travel(index: number, target?: PaneTarget): Promise<void>;
	// Drop every place ONE ROW of the panel stands for: a note's own record and each
	// jump made inside it, or the single record a pathless view holds. `key` is the
	// row's identity (see nav/entry.ts's navGroupKey), and a ROW is deliberately what
	// this is about rather than a place: a note is one row however many spots it
	// holds, so taking the note off the list takes them with it — and the reader who
	// asked did it from the row, which is the thing they were looking at.
	//
	// The row's own identity rather than a path, because a path cannot name a
	// pathless view: the graph and Thino's memo list are rows like any other, and a
	// removal nothing can name is a row nothing can take away (see dropPlaces).
	//
	// What it does NOT touch is why this list can be edited at all: the file
	// itself, and the position records — a different store, keyed by path (see the
	// module comment). A file visited again takes its place back, by design: this is
	// a record of where the reader has been, not a rule about where they may go. A
	// reader who never wants a file listed wants one of the rules instead (see
	// recordable), which is a policy rather than a one-off.
	forget(key: string): void;
	// Something a browser would have to redraw for.
	subscribe(fn: () => void): () => void;
}

// What the store needs from the rest of the plugin to travel. Injected (and
// implemented by NavStack, which owns the open pipeline) rather than reached
// for, so this module stays a pure list: it can be built and tested without a
// workspace, and the panel can hold it without holding the traversal machinery.
export interface PlaceOpeners {
	// Open a file the way the file explorer does: activate the tab that holds
	// it, or open it there. NO injected landing — the position database decides
	// where it lands. With a `target`, the file is opened in a leaf the app picks
	// for that target instead (a new tab, a split, a window) and the landing rule
	// is unchanged: the two opens land in the same place (see stack.ts).
	openFile(path: string, leafId: string, target?: PaneTarget): Promise<void>;
	// Open the file a jump was made in and land on the jump's recorded spot.
	openJump(entry: NavEntry, target?: PaneTarget): Promise<void>;
	// Show a pathless view (a view tab — the graph, Thino's memo list): in the leaf
	// that already holds it, or in a new tab when it is nowhere. The entry arrives
	// WHOLE, so a tab that has to be built is built as the place the reader left
	// (see NavView.state).
	openView(entry: NavEntry, target?: PaneTarget): Promise<void>;
}

// The no-op opener: a store built without a workspace (a test, or a plugin
// phase where the open pipeline is not up yet) still records places and still
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
		// The one shared settings object: the ceiling and this list's own folder
		// rule are read live, so changing either in the panel takes effect on the
		// next write without rebuilding the store.
		private settings: PluginSettings,
	) {
		this.entries = loadNavPlaces(app);
	}

	// The composition root hands in the open pipeline once it exists (see
	// position/manager.ts). Separate from construction because the two objects
	// need each other: the funnel feeds this list its recordings, and a click
	// here travels out through the stack's open path.
	attach(open: PlaceOpeners): void {
		this.open = open;
	}

	// ===== Configuration =====

	// Whether this list records JUMPS — everything but the bottom stop of the
	// landings setting (see LandingsMode), where the list is notes and views
	// and nothing else. Asked of every jump and of nothing else: a file the
	// reader opened and a view they sat in are places whatever this says, and
	// the list without its jumps is still a list of notes.
	//
	// It answers RECORDING and only recording, never retention: a jump
	// recorded at an upper stop is a place like any other, and coming down
	// to 'none' leaves it where it is — it stops new ones being recorded and
	// draws nothing from the ones already there, and what that cost is bounded
	// by, and what finally takes them, is the trim (see dropOldestLandings and
	// dropOldestRows). Which is why no stop is a one-way door.
	private recordsJumps(): boolean {
		return this.settings.recentFilesLandings !== 'none';
	}

	// How many NOTES the list is kept to: the setting, clamped, with
	// DEFAULT_SETTINGS as the fallback for a value that is not a number at all
	// (a hand-edited data.json would otherwise make every `length > cap`
	// comparison false and disable the ceiling entirely — the same guard as the
	// stack's stackCap). What it counts is the note or view a row stands for,
	// in every mode (see rowCount) — not the landings inside it, which are
	// bounded by trim's second pass instead.
	cap(): number {
		const cap = Math.floor(this.settings.recentFilesCap);
		return Number.isFinite(cap) ? Math.max(1, cap) : DEFAULT_SETTINGS.recentFilesCap;
	}

	// Whether a path may be listed at all: this list's OWN rules, and no other
	// feature's. The reader's folder list and property list answer "which visits
	// are worth listing" — a template folder, an archive, a scratch folder, a
	// board that another plugin owns — and are deliberately not the position
	// recording's excludedFolders and frontmatterExcludeProperties, which answer
	// a different question (see PluginSettings.recentFilesExcludeFolders /
	// recentFilesExcludeProperties). Vault-internal paths are skipped outright:
	// they are not notes and a reader never navigates to them.
	private recordable(path: string): boolean {
		if (!path)
			return false;
		// Vault-internal paths are never listed: the configuration folder (whatever
		// the user named it — see Vault#configDir) is not notes, and Obsidian's trash
		// holds files the bookkeeper drops anyway.
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

	// The property rule (see PluginSettings.recentFilesExcludeProperties): `status`
	// keeps out every file carrying the property whatever its value,
	// `status: archived` only the files whose value equals it — the one entry
	// form this plugin writes, shared with the position rules (see
	// shared/frontmatter.ts).
	//
	// Asked LAST, and only when the reader has written a rule, because it is the
	// one test here that has to reach into the vault: with an empty list — the
	// default — the answer is "no" without touching the metadata cache, so a
	// navigation costs nothing it did not already cost.
	//
	// A file the cache has not parsed yet IS listed (no frontmatter to read):
	// the cache fills lazily, and a place withheld on a guess is a place the
	// reader cannot get back, while a place listed by mistake is one they can
	// drop — and the next visit asks again.
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

	// A place was visited — the funnel's `onVisit`, for every navigation the
	// reader made, teleports excepted (see the class comment). Called BEFORE the
	// stack decides whether the step is worth keeping: a place being sat in again
	// is a fact about THIS list, and the stack's dedup or its settings must not be
	// able to hide it. A place already on the list is moved to the end and
	// re-stamped — never duplicated: that is what makes a file opened ten times one
	// row, and what keeps the list's order the order of last visit.
	remember(entry: NewNavEntry): void {
		if (entry.kind === 'teleport')
			return;
		// A jump at the bottom stop of the landings setting, where the reader
		// has said no landing is recorded at all (see LandingsMode). Asked of
		// the KIND rather than of the file, and before the list's own file
		// rules: those answer whether a file may be listed, which is a
		// different question from whether the spots inside it are remembered.
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
		this.trim();
		this.changed();
	}

	// A detail of a place that ALREADY exists became known — the funnel's
	// `onLanded`. The stack fills a jump's landing in when it settles (after
	// upgrading the key), and it re-reads a VIEW's own state as the reader leaves
	// it; this list has to hear about both, because a row is what the reader
	// clicks and what comes back has to be the place they left.
	//
	// Only a keyed jump carries a POSITION: a file record carries none by design,
	// and a view has no position at all (see the class comment).
	settle(entry: NewNavEntry): void {
		if (entry.kind === 'view') {
			// The view the reader just left, re-read. Its state is the one thing about
			// a view that cannot be derived later (see NavView.state); the name and
			// the icon come along because a view that renamed or re-iconed itself
			// during that visit should be listed under what the reader just read.
			// The stamp moves with them: "last time you were here" is NOW.
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
		// The stack upgrades an outline key to the heading's authoritative source
		// form ("outline:T" → "outline:## T") when the landing settles. The
		// place's key follows, because the panel reads it back for the
		// structural re-anchor; its IDENTITY does not change (placeKey
		// normalizes), which is why the lookup above still found it.
		place.key = entry.key;
		if (typeof entry.keyLine === 'number')
			place.keyLine = entry.keyLine;
		place.st = entry.st;
		place.t = Date.now();
		this.changed();
	}

	// Which place the reader is in. The stack's current record maps to a place
	// by identity; an inferred step (a teleport) maps to its FILE, because the
	// reader is in that file however they got there.
	//
	// "Here" is a live fact about the workspace, so it is NOT persisted and NOT
	// invented: a list that came up empty stays empty until the reader goes
	// somewhere, and nothing here puts the note they happen to be reading back on
	// their own list — a place leaves only when something asks it to (see forget
	// and deleteFile above), and nothing fills one back in.
	markCurrent(entry?: NewNavEntry): void {
		const at = this.indexFor(entry);
		if (at === this.index)
			return;
		this.index = at;
		this.changed();
	}

	// ===== Bookkeeping =====

	// A rename re-keys the places that named the file. Identity is recomputed
	// from `path`, so no stored key has to be rewritten (a jump's own `key` is a
	// heading/anchor, and stays what it was).
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

	// A real vault delete drops the file's places — its file record and every
	// jump made inside it. The panel's rows for them would otherwise be dead
	// names that hold slots in a capped list.
	//
	// The KEY handed on is the path, and that is not a shortcut: a file's row
	// identity IS its path (see navGroupKey) — the one case the row and the path
	// agree on, and the only thing a vault delete could name.
	deleteFile(path: string): void {
		this.dropPlaces(path);
	}

	// The reader asked for a row to go: the × on the row itself (see
	// RecentFilesBrowser.onForget). The same removal as a vault delete, by the same
	// rule — a row is ONE thing and goes as one — and a second name rather than the
	// bookkeeper's entry point reused, because the two answer different questions:
	// that one is the VAULT saying the file is gone, this one is the reader saying
	// they do not want to see it. (The interface's own note says what the removal
	// leaves untouched.)
	forget(key: string): void {
		this.dropPlaces(key);
	}

	// The one removal both names above stand for, keyed by ROW (see navGroupKey):
	// every record the row is drawn from goes at once. It takes a row rather than a
	// path because a view has no path — and it has to be able to say WHICH view, since
	// a path-keyed filter can only ever leave every view standing. That is exactly
	// what this did while a view was not yet a row: the filter kept every pathless
	// record unconditionally, so the graph could be drawn on the list and never taken
	// off it.
	private dropPlaces(key: string): void {
		const current = this.entries[this.index];
		const kept = this.entries.filter(e => navGroupKey(e) !== key);
		if (kept.length === this.entries.length)
			return;
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
		this.changed();
	}

	// One of the list's rules changed (the settings tab — a folder added, or a
	// property): drop the places it now excludes, so a place the reader can no
	// longer be shown does not keep a slot in the capped list until they happen
	// to revisit it.
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

	// Every file path the list still names (view records name none) — the
	// startup sweep's input (see PathBookkeeper.sweepMissingHistory).
	knownPaths(): string[] {
		const seen = new Set<string>();
		for (const entry of this.entries)
			if (entry.kind !== 'view')
				seen.add(entry.path);
		return Array.from(seen);
	}

	// ===== Travel =====

	// Go to a place. The RECORD KIND decides how, and that is the whole of the
	// rule:
	//   - a FILE record opens the file the plain way, exactly as the file
	//     explorer does. It carries no position, so nothing is injected: the
	//     position database restores whatever it restores (or nothing, for a
	//     file the reader excluded), which is what keeps the two entry points
	//     to one file from behaving differently.
	//   - a JUMP record is an explicit navigation, like back/forward, so it
	//     carries its own landing and lands on it.
	//   - a view record is answered by a leaf SHOWING that view: the one it came
	//     from, any other one, or a new tab opened on it when the view is nowhere
	//     (a place outlives the tab it happened in). A tab built for it is built
	//     with the state the view had while the reader was there (see
	//     NavView.state), so the place they get back is the place they left —
	//     see stack.ts's openViewPlace.
	// `target` decides WHERE all three of them open, when the reader held a
	// modifier down (see PaneTarget): a place is opened exactly the same way, one
	// tab over. Absent — the ordinary click — the record's own leaf is the answer,
	// which is the plugin's whole point (a place takes you back to where it was,
	// which `getLeaf(false)` cannot express).
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

	// The ceiling changed (the settings tab): trim NOW rather than on the next
	// visit — the same reason the stack's applyStackCap is called from the
	// settings panel: waiting drops a large chunk at once, later, unexplained.
	// @returns how many places were discarded.
	applyCap(): number {
		const removed = this.trim();
		if (removed > 0)
			this.changed();
		return removed;
	}

	// ===== Persistence =====

	// The last blob THIS instance wrote (the flush dedup — see
	// persistNavPlaces). An instance field, not module state: the list is per
	// vault, and a dedup shared between instances would let one skip a write it
	// owes.
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

	// The place index a stack record stands on, with the fallbacks the "you are
	// here" marker needs: an inferred step stands on its file, and a jump whose
	// own place is gone (evicted, or never recorded) stands on its file too —
	// the reader is in that note either way.
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

	// Keep the list inside its ceiling by dropping the OLDEST things — never the
	// one the reader is standing in. A reader who went back through the list
	// must not have the row under them evicted by the trim their own visit
	// triggered, so the current place is SKIPPED and the next oldest goes
	// instead. That keeps the ceiling exact rather than letting the list run
	// over it for as long as the reader sits on an old place.
	//
	// TWO CEILINGS, both the same number, and the split is the whole point: the
	// one the reader sets bounds what they are SHOWN, while this one bounds
	// what is STORED — a place they are not being shown must not be able to
	// cost them a place they are, and no note may grow the stored list without
	// bound (see PluginSettings.recentFilesCap).
	//   - ROWS first. A row is a note or a view in every mode, and a row goes
	//     WHOLE — the note's own record and every landing inside it, the way
	//     forget takes them — so a jump can never push a file off the list.
	//   - LANDINGS second, counted over the whole list rather than per note.
	//     The stored list needs a bound of its own: a jump is by far the
	//     heaviest record it holds, carrying the lines that were on screen
	//     with the jump (see NavEntryState.context), and the ceiling above
	//     does not count it — so this is the only bound there is, in every
	//     mode, whether the landings are drawn or not. It drops the OLDEST
	//     LANDINGS, never the row they stand in.
	// @returns how many were dropped.
	private trim(): number {
		const before = this.entries.length;
		this.dropOldestRows();
		this.dropOldestLandings();
		return before - this.entries.length;
	}

	// Drop whole ROWS until the list is inside its ceiling. A row is a note (or
	// a view) in EVERY mode — the ceiling counts notes, so 'all' does not
	// change which rows go, only how many lines they take to draw — and the
	// rows are ordered by their NEWEST place: the same clock the panel reads,
	// an index being the time (see list.ts). The row the reader has not
	// touched for the longest is the one that goes, and it takes the landings
	// inside it with it: a row is one thing (see forget).
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

	// How many rows the list draws, which is what the ceiling counts: a note is
	// one row however many landings it holds, and a view is one row. The same
	// in all three modes — a mode that made the ceiling count landings too
	// would leave the reader's number meaning two different things (see
	// PluginSettings.recentFilesCap).
	rowCount(): number {
		const seen = new Set<string>();
		for (const entry of this.entries)
			seen.add(navGroupKey(entry));
		return seen.size;
	}

	// The landings' own ceiling: the same number, counted over every jump in
	// the list at once rather than per note. One shared pool rather than a
	// budget each, because what it is for is bounding what the list STORES:
	// the jumps it spends the pool on are the ones the reader actually made,
	// so a note they jumped around in keeps as many as it earned and a note
	// they only read keeps none — and no note is capped at a number the
	// reader would have had to invent (see PluginSettings.recentFilesCap).
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

	// Put a filtered array in the list's place, keeping the "you are here"
	// pointer on the same place when that place survived the filter.
	private keep(kept: NavEntry[]): void {
		if (kept.length === this.entries.length)
			return;
		const current = this.entries[this.index];
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
	}
}

// A record's IDENTITY on the list. Not stored: it is recomputed from the record
// (see places-store's loader), so a rule change cannot leave stale keys behind.
//
//   - a FILE is its path. One record per file, whichever tab it was read in:
//     the per-tab split is the position database's business, and the panel has
//     always drawn one row per note.
//   - a JUMP is its heading/anchor KEY, normalized. The key is what survives an
//     edit that moves the heading (see nav-history/stack.ts's upgradeKeyLine and
//     resolveAnchorShift), and normalizing is what makes the rendered form
//     ("outline:T") and the authoritative source form ("outline:## T") ONE
//     place rather than two — the same normalization the stack's own dedup uses.
//   - a VIEW is its view type, as in the panel's grouping.
// Typed on NewNavEntry: both a stored record and a recording heard from the funnel
// answer to it (a record is a recording with the stamp added).
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

// The identity half of a jump key: an outline key keeps its prefix (so a
// heading and a same-named anchor are not one place) and loses the hashes its
// two forms differ by; everything else is taken as written.
function normalizeJumpKey(key: string): string {
	const prefix = 'outline:';
	return key.startsWith(prefix)
		? `${prefix}${normAnchor(key.slice(prefix.length))}`
		: normAnchor(key);
}

// The record a place stores for a visit. A FILE place keeps no position (see
// the class comment), and its link origin is display-only data the panel's head
// shows — carried along, since a place is what most recently stood for it.
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
				// A re-click of a heading carries no landing yet (it arrives with
				// the settle, see settle above): the one already recorded stands
				// until then, so the row never loses the spot it promises.
				st: entry.st ?? kept?.st,
			};
		}
		case 'view': {
			// The label and the icon are taken from the recording, so they are refreshed
			// by every visit: a view that renamed itself (or a plugin updated under it)
			// is named and marked by what it says NOW — what the reader just saw on its
			// tab. A read that came back empty simply drops them, and the row falls
			// back to this list's own wording and to a word instead of a mark.
			//
			// The STATE is the exception, and deliberately: a visit whose state read
			// came back empty (the view threw, answered with nothing, or went over the
			// ceiling — see shared/leaf.ts's viewState) KEEPS the snapshot already
			// recorded instead of erasing it. One failed read must not cost the reader
			// the place they left, and what stands is the last state that was actually
			// readable.
			const kept = prev?.kind === 'view' ? prev : undefined;
			return {
				kind: 'view', leafId: entry.leafId, viewType: entry.viewType, t,
				label: entry.label, icon: entry.icon,
				state: entry.state ?? kept?.state,
			};
		}
		default:
			// Unreachable: remember() refuses teleports. Typed as a visit so a
			// future variant fails the type check here rather than silently.
			return { kind: 'visit', path: entry.path, leafId: entry.leafId, t };
	}
}
