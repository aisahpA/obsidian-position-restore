import { App } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from '@/types';
import { NavEntry, NewNavEntry } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { normAnchor } from '@/position/capture/ephemeral';
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
// A pathless view (the graph) is one record, as it is in the panel.
//
// WHAT IS NOT IN IT: teleports (the sampler's INFERRED large cursor moves).
// They are not places the reader chose, and they were the whole reason the
// list needed a second eviction tier to keep them from crowding out the real
// ones. Dropping them removes the tier: the array is a strict MRU list, so
// eviction is "drop from the front".
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
	// Drop every place a file holds — its own file record and each jump made
	// inside it, which is what a reader means by "I do not want to see this note
	// here" (the panel's own menu item: see RecentFilesBrowser.contextRow). The
	// file is untouched, and so are the position records: this list is a record
	// of where the reader has BEEN, and a place that comes back the next time
	// they visit is not a bug (see NavPlaces.forget).
	forget(path: string): void;
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
	// Reactivate a pathless view (the graph tab).
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

	// How many places are kept: the setting, clamped, with DEFAULT_SETTINGS as
	// the fallback for a value that is not a number at all (a hand-edited
	// data.json would otherwise make every `length > cap` comparison false and
	// disable the ceiling entirely — the same guard as the stack's stackCap).
	cap(): number {
		const cap = Math.floor(this.settings.navRecentCap);
		return Number.isFinite(cap) ? Math.max(1, cap) : DEFAULT_SETTINGS.navRecentCap;
	}

	// Whether a path may be listed at all: this list's OWN rule. The reader's
	// folder list answers "which visits are worth listing" — a template folder,
	// an archive, a scratch folder — and is deliberately not the position
	// recording's excludedFolders, which answers a different question (see
	// PluginSettings.navRecentExcludeFolders). Vault-internal paths are skipped
	// outright: they are not notes and a reader never navigates to them.
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
		const folders = this.settings.navRecentExcludeFolders ?? [];
		return !folders.some(folder => {
			const clean = folder.replace(/\/+$/, '');
			return !!clean && (path === clean || path.startsWith(`${clean}/`));
		});
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

	// The jump's landing settled (or was re-read): keep the place's own position
	// fresh. Only keyed jumps have one — a file record carries none by design.
	// The funnel's `onLanded`: the stack fills the landing in when the jump
	// settles (after upgrading the key), and this list has to hear about it.
	settle(entry: NewNavEntry): void {
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
	deleteFile(path: string): void {
		this.dropPlaces(path);
	}

	// The reader asked for a file's places to go: the panel's own menu item (see
	// RecentFilesBrowser.contextRow). The same removal as a vault delete, by the
	// same rule — a file is ONE row, so a file that goes takes its landings with
	// it, or the row would survive as the landings left under it — and a second
	// name rather than the bookkeeper's entry point reused, because the two
	// answer different questions: that one is the VAULT saying the file is gone,
	// this one is the reader saying they do not want to see it.
	//
	// What it does NOT touch is why this list can be edited at all: the file
	// itself, and the position records — a different store, keyed by path (see
	// the module comment). A file visited again takes its place back, by design:
	// this is a record of where the reader has been, not a rule about where they
	// may go. A reader who never wants a file listed wants the folder rule
	// instead (see recordable), which is a policy rather than a one-off.
	forget(path: string): void {
		this.dropPlaces(path);
	}

	// The one removal both names above stand for. A pathless place (a view) is
	// never what a path names, which is why the filter leaves it standing.
	private dropPlaces(path: string): void {
		const current = this.entries[this.index];
		const kept = this.entries.filter(e => e.kind === 'view' || e.path !== path);
		if (kept.length === this.entries.length)
			return;
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
		this.changed();
	}

	// The folder rule changed (the settings tab): drop the places it now
	// excludes, so a place the reader can no longer be shown does not keep a slot
	// in the capped list until they happen to revisit it.
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
	//   - a view record reactivates its leaf.
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

	// Keep the list to its ceiling by dropping the OLDEST places (the front of the
	// MRU array) — never the one the reader is standing in. A reader who went back
	// through the list must not have the row under them evicted by the trim their
	// own visit triggered, so the current place is SKIPPED and the next oldest goes
	// instead. That keeps the ceiling exact rather than letting the list run over it
	// for as long as the reader sits on an old place.
	// @returns how many were dropped.
	private trim(): number {
		const over = this.entries.length - this.cap();
		if (over <= 0)
			return 0;
		const kept: NavEntry[] = [];
		let dropped = 0;
		for (let i = 0; i < this.entries.length; i++) {
			if (dropped < over && i !== this.index) {
				dropped++;
				continue;
			}
			kept.push(this.entries[i]);
		}
		if (dropped === 0)
			return 0;
		const current = this.index >= 0 ? this.entries[this.index] : undefined;
		this.entries = kept;
		this.index = current ? kept.indexOf(current) : -1;
		return dropped;
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
		case 'view':
			return { kind: 'view', leafId: entry.leafId, viewType: entry.viewType, t };
		default:
			// Unreachable: remember() refuses teleports. Typed as a visit so a
			// future variant fails the type check here rather than silently.
			return { kind: 'visit', path: entry.path, leafId: entry.leafId, t };
	}
}
