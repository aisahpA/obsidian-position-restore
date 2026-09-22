import { App, FileView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, NavEntryState, PluginSettings, DEFAULT_SETTINGS } from '@/types';
import { PositionState } from '@/position/state';
import { RestoreModes } from '@/position/restore/modes';
import { readNavEntryState, normAnchor, shiftNavState } from '@/position/capture/ephemeral';
import { resolveAnchorLine, findHeading, decodeAnchor } from '@/position/restore/anchor';
import { delay } from '@/shared/wait';
import {
	NavEntry, NavJump, NavVisit, NavTeleport, NewNavEntry,
} from '@/nav/entry';
import { NavFunnel, NavFunnelSink, NavLeave, NavRecording } from '@/nav/funnel';
import { PaneTarget } from '@/nav/pane';
import { isMainAreaLeaf } from '@/shared/leaf';
import { loadNavHistory, persistNavHistory } from './store';

// VSCode-style BACK/FORWARD, and the open pipeline a place is travelled through.
//
// THE STACK. One global array of entries (NavJump | NavTeleport | NavVisit |
// NavView) with a current index. Every navigation the reader makes pushes a step;
// back/forward move the index; a fresh jump truncates the forward part — that IS
// back/forward semantics, and it is why the panel next door does not draw this
// list. Two position regimes: keyed entries (outline:<heading>, anchor linktext)
// and teleports carry the jump's precise landing — written at push time
// (teleport) or when the landing settles (outline/anchor) — and are never
// overwritten afterwards (back/forward must return to the jump target itself);
// keyless open/activation entries carry no position of their own — their st slot
// is refreshed on every leave ("where the user actually was"). st feeds BOTH the
// same-file direct apply (execute) and the cross-file open: a traversal hands the
// target's own landing to the open pipeline (landingFor), so the line a row shows
// is the line the open lands on. Only an entry with no recorded position of its
// own falls back to the per-file records (database + the per-leaf overlay) —
// "where the user actually was".
//
// RECORDING DOES NOT LIVE HERE. This class is a LISTENER on the recording funnel
// (nav/funnel.ts): the capture points (the setViewState patch, the poll, the
// outline panel, active-leaf-change) write what they saw, the funnel applies the
// SHARED gates — a traversal's own opens and the startup rebuild are not
// navigations for anybody — and publishes. This class then applies ITS OWN gates
// and keeps its own kind of record: whether a tab switch is worth a step
// (navRecordActivation), whether an inferred cursor jump is (navRecordTeleport),
// the same-location dedup, and the ceiling. The funnel's other listener keeps a
// place list instead of steps; neither list knows the other exists, and this one
// no longer reports on the other's behalf.
//
// Same-tab file switches EXECUTE through Obsidian's native per-tab history
// (leaf.history + app:go-back/go-forward): that covers PDF/canvas and every
// other non-markdown view this plugin cannot reposition. For markdown, the
// native entry's eState carries only the cursor (no scroll), so the setViewState
// patch injects this plugin's saved position over it (pendingHistoryNav).
// Cross-tab traversals reactivate the original leaf (leafId); a closed leaf
// falls back to the active one. Non-file main-area views (the graph, Thino's
// memo list) are recorded too: their entries have no path, only a viewType —
// traversal just reactivates the leaf. The entry vocabulary (NavEntry and its
// variants, isMainAreaLeaf, what counts as a recordable view) lives in
// nav/entry.ts.
//
// Native per-tab history entry (internal, untyped): { state: { type, state:
// { file, ... } }, eState: ... } — only the fields read for target
// verification are declared.
interface NativeHistoryEntry {
	state?: { type?: unknown; state?: { file?: unknown } };
}
interface NativeLeafHistory {
	backHistory: NativeHistoryEntry[];
	forwardHistory: NativeHistoryEntry[];
}

// After invoking the native go-back/forward command, wait this long before
// verifying the landing (setViewState is synchronous inside the command, but
// give the pipeline a beat before the fallback re-open).
const NATIVE_LANDING_VERIFY_MS = 80;
// Safety net clearing pendingHistoryNav when a command never reaches
// setViewState (no history, rejected). Mirrors pendingLinkKindTimeout.
const HISTORY_NAV_TIMEOUT_MS = 1000;

// How long a traversal's landing stays cue-suppressed: the cross-file
// restore runs from the debounced 'file-open' handler (after the traversal
// bracket closed) and ends with the settle (SETTLE_HOLD_MAX_MS 1250ms) plus
// the anchor delay — 3s clears that with margin while staying tight enough
// that a user's next unrelated open (quick switcher right after a hop)
// shows its own cue again.
const NAV_CUE_SUPPRESS_MS = 3000;

export class NavStack implements NavFunnelSink {
	private app: App;
	private state: PositionState;
	private modes: RestoreModes;
	// Shared settings object (main.ts assigns once, the settings tab mutates in
	// place): recording toggles and the stack cap stay live.
	private settings: PluginSettings;
	// The recording funnel this stack listens to, and whose bracket a traversal
	// runs inside.
	private funnel: NavFunnel;

	entries: NavEntry[] = [];
	// Index of the entry describing the CURRENT location; -1 = empty stack.
	index = -1;

	constructor(
		app: App,
		settings: PluginSettings,
		state: PositionState,
		funnel: NavFunnel,
		// The file's saved record, for a step that recorded no position of its own:
		// a same-file jump applies it so the row's line is still the line it opens
		// (see appliedLanding). A cross-file open needs no such help — the open
		// pipeline already falls back to the record.
		private savedPosition?: (path: string) => EphemeralState | undefined,
	) {
		this.app = app;
		this.state = state;
		this.settings = settings;
		this.funnel = funnel;
		const restored = loadNavHistory(app);
		this.entries = restored.entries;
		this.index = restored.index;
		// A stored blob can exceed the ceiling in force now (the cap is lowered
		// in the settings, which persist, while the stack is only written at
		// the flush points): trim it here so the cap is authoritative from the
		// first render rather than after the next navigation.
		this.applyStackCap();
		this.modes = new RestoreModes(settings, state);
	}

	// ===== The funnel's reader side =====

	// One navigation, already past the funnel's shared gates. The stack's own
	// gates are here, and they are the reason the funnel publishes rather than
	// decides: whether a tab switch or an inferred cursor jump is worth a STEP is
	// a question about this list, and the place list next door answers it
	// differently (it keeps both, teleports excepted).
	onVisit(recording: NavRecording) {
		if (recording.cause === 'tab' && !this.settings.navRecordActivation)
			return;
		if (recording.cause === 'teleport' && !this.settings.navRecordTeleport)
			return;
		this.pushIfNew(recording.record, recording.forced);
	}

	// A position read. The stack takes every one of them — a keyed entry keeps the
	// landing it was pushed with, a keyless one is simply overwritten — because it
	// needs *some* position to return to. (A place list does not: it takes only the
	// settle. See funnel.ts's NavLeave.)
	onLeave(leave: NavLeave) {
		if (leave.cause === 'tab') {
			this.refreshTopLeafOnActivation(leave.leaf);
			return;
		}
		this.refreshTop(leave.path, leave.leafId, leave.st, { landing: leave.cause === 'settled' });
	}

	// A landing became known from outside this class: a teleport's scroll, re-read
	// one frame after the jump event (the sampler sees it first). A keyed jump's
	// landing is this class's own business — it publishes that one itself, after
	// upgrading the key (see refreshTop).
	onLanded(entry: NewNavEntry) {
		if (entry.kind !== 'teleport' || !entry.st)
			return;
		const top = this.entries[this.index];
		if (!top || top.kind !== 'teleport' || top.path !== entry.path
			|| top.leafId !== entry.leafId || top.line !== entry.line)
			return;
		top.st = entry.st;
	}

	// (No onHere: the step at `index` IS this class's "here", so there is nothing
	// for this listener to do with that fact. Its own pointer moves are broadcast
	// to the other listeners by navigate/travelTo.)

	// The stack ceiling in force: the setting, clamped, with a fallback for a
	// value that is not a number at all (a hand-edited data.json would
	// otherwise make every `length > cap` comparison false and disable the
	// ceiling entirely).
	stackCap(): number {
		const cap = Math.floor(this.settings.navStackCap);
		return Number.isFinite(cap) ? Math.max(1, cap) : DEFAULT_SETTINGS.navStackCap;
	}

	// Trim the stack to the ceiling NOW. Called by push (the ordinary path),
	// by the settings panel when the cap changes (otherwise the trim waits for
	// the next navigation and then drops a large chunk at once), and once on
	// load (above).
	// The discards are SILENT: the stack sits at the cap whenever a session has
	// been long enough, so anything that reported them would either be permanent
	// on screen or permanently out of sight — the browser's old stack-cap
	// footnote was dropped for exactly that reason.
	// @returns how many entries were discarded.
	applyStackCap(): number {
		const cap = this.stackCap();
		if (this.entries.length <= cap)
			return 0;
		const removed = this.entries.length - cap;
		// The oldest entries drop (see push).
		this.entries.splice(0, removed);
		// The pointer follows the entries that survived. One that sat on a
		// dropped entry (the cap fell below the current depth) has nothing left
		// to describe "now": it stops on the oldest survivor rather than going
		// negative, so forward still walks what remains instead of traversal
		// being disabled outright.
		this.index = this.entries.length === 0 ? -1 : Math.max(0, this.index - removed);
		return removed;
	}

	// Every distinct file path the stack still names (view entries name none).
	// The caller pairs this with a vault check — the startup sweep for files
	// deleted while Obsidian was closed (see PathBookkeeper.sweepMissingHistory).
	knownPaths(): string[] {
		const seen = new Set<string>();
		for (const entry of this.entries)
			if (entry.kind !== 'view')
				seen.add(entry.path);
		return Array.from(seen);
	}

	// ===== Recording (this class's own decisions, applied to funnel records) =====

	// Same-location dedup, then push. The dedup is a question about the STACK —
	// "did the top step change?" — while the reader having been somewhere is a
	// question about the place list, which the funnel already asked and answered
	// before this ran (see funnel.ts's publish).
	private pushIfNew(entry: NewNavEntry, force?: boolean) {
		const top = this.entries[this.index];
		// Same location = same file in the SAME tab (+ same jump key). Two
		// tabs of one file hold independent positions (the leaf records are per-leaf),
		// so a leaf switch between them is a real entry (VSCode records editor
		// identity, group included).
		if (!force && top && this.sameLocation(top, entry))
			return;
		this.push(entry);
	}

	// Same-location across kinds: view entries match view entries (same leaf
	// view type), keyed jumps only the identical jump, and a keyless visit
	// absorbs into any file entry of the same file+leaf — its st is
	// refreshed on leave either way. An outline jump's key compares
	// normalized: the entry's key may have been upgraded to the heading's
	// source line ("outline:## T") while a re-click records the rendered
	// text ("outline:T") — `#` strips in normAnchor, so both forms mean the
	// same heading and dedup as one jump.
	private sameLocation(top: NavEntry, entry: NewNavEntry): boolean {
		if (top.leafId !== entry.leafId)
			return false;
		switch (entry.kind) {
			case 'view':
				return top.kind === 'view' && top.viewType === entry.viewType;
			case 'jump':
				return top.kind === 'jump' && top.path === entry.path
					&& (top.key === entry.key
						|| (top.key.startsWith('outline:') && entry.key.startsWith('outline:')
							&& normAnchor(top.key.slice('outline:'.length)) === normAnchor(entry.key.slice('outline:'.length))));
			case 'teleport':
				return top.kind === 'teleport' && top.path === entry.path && top.line === entry.line;
			case 'visit':
				return top.kind !== 'view' && top.path === entry.path;
		}
	}

	// The single entry funnel: every push is stamped here, so `t` can never be
	// missing on a live entry. (A travel's copy arrives with the place's own
	// stamp and gets a FRESH one — the travel is a new navigation moment, not a
	// replay of the old one.)
	private push(entry: NewNavEntry) {
		// A fresh jump discards the forward part (VSCode semantics).
		this.entries.length = this.index + 1;
		this.entries.push({ ...entry, t: Date.now() });
		// The pushed entry is the current location BEFORE the ceiling is
		// applied, so the trim moves the pointer relative to the TOP that was
		// just established, not to the entry the push replaced.
		this.index = this.entries.length - 1;
		this.applyStackCap();
	}

	// "Update on leave": refreshes the top entry's position from the view
	// the jump is leaving (called by the setViewState patch, the traversal,
	// the outline capture, and the samplers' settle-capture). Keyed entries
	// (teleport/outline/anchor) keep the precise landing of the jump they
	// were pushed for — a leave must not overwrite it with where the user
	// had drifted; only an entry that never received a landing (legacy
	// persisted entries, a landing that never settled) gets a backfill.
	// Keyless open/activation entries are overwritten on every leave.
	// Guarded by path+leaf: the top entry must still describe this view's
	// leaf+file.
	private refreshTop(path: string, leafId: string, st: NavEntryState, opts: { landing?: boolean } = {}) {
		const top = this.entries[this.index];
		if (!top || top.kind === 'view' || top.path !== path || top.leafId !== leafId)
			return;
		if (top.kind === 'jump') {
			if (!top.st) {
				top.st = st;
				this.upgradeKeyLine(top, st);
				// A PLACE is only told about a real LANDING (`opts.landing`), never
				// about the leave-read that backfills the stack: the stack wants
				// *some* position to return to, while the place's row PROMISES the
				// jump's own spot — and a reader who clicked a heading, read on and
				// then switched files must not find that heading's recorded place
				// moved to wherever they happened to be when they left.
				if (opts.landing)
					this.funnel.landing(top);
			}
			return;
		}
		if (top.kind === 'teleport') {
			if (!top.st) {
				top.st = st;
			}
			return;
		}
		top.st = st;
	}

	// Capture the position of the file being switched away from onto the top
	// entry (the one that describes it). refreshTop guards the path+leaf
	// match and keeps keyed landings; the funnel's shared gate skips our own
	// traversals and startup. A no-op when no leaf holds the top entry (e.g. it
	// was closed).
	private refreshTopLeafOnActivation(next: WorkspaceLeaf | null) {
		if (!next || !this.funnel.isRecording())
			return;
		// A SIDEBAR (or any other non-main-area pane) taking the focus is not a
		// tab/pane switch the history records — the funnel's activation refuses those
		// leaves itself — so the entry being left is not going anywhere. Refreshing it
		// here also NOTIFIED every panel on screen, so clicking into the resident
		// recent-files panel rebuilt its rows while the reader's press was still
		// in flight: the click was lost and the same row had to be clicked a second
		// time. The entry's position is still captured where it matters — on the
		// funnel's leave-reads (the patcher's at open, the sampler's on movement)
		// and on a jump (refreshTopFromActiveView).
		if (!isMainAreaLeaf(this.app, next))
			return;
		const top = this.entries[this.index];
		if (!top || top.kind === 'view')
			return;
		const leaf = this.findLeafById(top.leafId);
		if (!leaf || leaf === next)
			return;
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file && view.file.path === top.path) {
			const st = readNavEntryState(view);
			if (st)
				this.refreshTop(top.path, top.leafId, st);
		}
	}

	// Upgrade a keyed jump with the anchor's RECORD-TIME line from
	// metadataCache — the authoritative base for the structural re-anchor
	// (see NavJump.keyLine). Runs at the first landing backfill (and on a
	// pre-click refreshTop of an earlier not-yet-settled entry — equally
	// valid: the cache line IS the record-time line either way; the st view
	// line is only used to break ties between same-text headings).
	//   outline: key  → key rebuilt from the cache's authoritative source
	//     ("outline:## T": # count = absolute level, rest = HeadingCache.heading
	//     verbatim — resolveAnchorLine matches structurally, no normalization)
	//     plus keyLine.
	//   #slug key     → keyLine only (the slug key already resolves).
	//   ^block key    → nothing: a block's line can't be tied to its landing
	//     geometry; the entry keeps riding the text-snippet remap.
	// No cache heading matches (renamed/removed anchor) → untouched, the
	// rendered/slug key stays and the remap fallback keeps working.
	private upgradeKeyLine(top: NavJump, st: NavEntryState) {
		const file = this.app.vault.getAbstractFileByPath(top.path);
		const cache = file instanceof TFile ? this.app.metadataCache.getFileCache(file) : null;
		const nearLine = st.scroll ?? st.cursor?.from.line;
		if (top.key.startsWith('outline:')) {
			const hit = findHeading(cache, top.key.slice('outline:'.length), nearLine);
			if (!hit)
				return;
			top.key = `outline:${'#'.repeat(hit.level)} ${hit.heading}`;
			top.keyLine = hit.line;
			return;
		}
		const hash = top.key.indexOf('#');
		if (hash === -1)
			return;
		const hit = findHeading(cache, decodeAnchor(top.key.slice(hash + 1)), nearLine);
		if (hit)
			top.keyLine = hit.line;
	}

	// ===== Traversal =====

	// Stack-bound check: back needs an entry below, forward an entry above.
	private canStep(dir: -1 | 1): boolean {
		return dir < 0 ? this.index > 0 : this.index >= 0 && this.index < this.entries.length - 1;
	}

	// Command availability (checkCallback). An active file view is the normal
	// start; when a sidebar holds focus, traversal can still start from the
	// last file tab (see startLeaf).
	canNavigate(dir: -1 | 1): boolean {
		if (this.funnel.isMoving())
			return false;
		if (!this.canStep(dir))
			return false;
		return !!this.app.workspace.getActiveViewOfType(FileView)?.file || !!this.startLeaf();
	}

	// With no active file view (a sidebar holds focus), traversal starts from
	// the stack's current entry leaf — the last file tab the user was in;
	// falls back to the most recently active leaf when that one is closed.
	private startLeaf(): WorkspaceLeaf | undefined {
		return this.findLeafById(this.entries[this.index]?.leafId)
			?? this.app.workspace.getMostRecentLeaf() ?? undefined;
	}

	async navigate(dir: -1 | 1): Promise<void> {
		if (!this.canStep(dir))
			return;
		await this.funnel.runBracketed(() => this.traverse(dir));
		// The pointer moved even where no step was pushed (a traversal that only
		// reactivates a tab), and "you are here" moved with it — on the stack and
		// on the recent-files list alike.
		this.funnel.here(this.entries[this.index]);
	}

	// Time travel to a PLACE (the recent-files list). A place is an explicit
	// navigation, so it gets the same treatment a back/forward step does: the
	// place is re-pushed on top of the stack (branching from where the reader
	// is), and the entry it displaced stays one step below — back returns to the
	// origin. The place's own landing is what the open injects, so the line the
	// panel printed is the line the travel lands on.
	//
	// The place the reader is already standing on is not pushed again: the
	// traversal top IS that location, and a second press has to re-land it, not
	// grow a duplicate step (the place list's own rule, restated by the dedup
	// below).
	async travelTo(place: NavEntry, target?: PaneTarget): Promise<void> {
		if (place.kind === 'teleport')
			return;
		await this.funnel.runBracketed(async () => {
			// Capture where we are leaving first, so the entry below keeps the
			// exact position a later back must return to.
			this.refreshTopFromActiveView();
			// The stack decided this one is a real navigation, so it hands the
			// funnel the record itself: the shared gate is for CAPTURE points,
			// and inside a traversal it would (correctly) refuse everything.
			this.funnel.visit({
				record: { ...place },
				cause: place.kind === 'jump' ? 'jump' : 'open',
			});
			// The target's own landing is injected; the direction only feeds the
			// native-delegation check, and a place knows no stack position — so
			// both directions are offered to it (see execute's `tryBoth`).
			await this.execute(this.entries[this.index], -1, true, target);
		});
		this.funnel.here(this.entries[this.index]);
	}

	// A FILE place: open it the way Obsidian's own file explorer does, with no
	// landing injected. The panel's file rows carry no position of their own
	// (see recent-files/places.ts), so the position database decides where this
	// lands — which is what keeps "open it from the panel" and "open it from the
	// file explorer" the same act, exclusion rules and all. The open records itself
	// through the ordinary patch, so the visit still reaches both stores.
	async openFilePlain(path: string, leafId: string, target?: PaneTarget): Promise<void> {
		// With a target, the file is opened ONE TAB OVER instead of in the leaf it
		// lives in — leaving the reader's place where it was, which is the whole of what
		// the modifier asks for. Everything else is the same act: no landing is
		// injected, so the position database decides where it lands (see the note
		// above), and the file explorer's own click would land in the same spot.
		if (target) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile))
				return;
			const opened = this.app.workspace.getLeaf(target);
			await opened.openFile(file);
			this.app.workspace.setActiveLeaf(opened, { focus: true });
			return;
		}
		const leaf = this.findLeafById(leafId)
			?? this.app.workspace.getMostRecentLeaf() ?? undefined;
		if (!leaf)
			return;
		if (this.app.workspace.getActiveViewOfType(FileView)?.leaf !== leaf)
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const current = (leaf.view as FileView | undefined)?.file;
		if (current?.path === path)
			return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile)
			await leaf.openFile(file);
	}

	// A pathless view place (the graph tab, Thino's memo list): reactivate its
	// leaf, or re-assert the view when the tab was swapped to a file in the
	// meantime — execute()'s view branch, which needs nothing from the stack.
	async openViewPlace(place: NavEntry, target?: PaneTarget): Promise<void> {
		if (place.kind !== 'view')
			return;
		await this.execute(place, 1, false, target);
	}

	async traverse(dir: -1 | 1): Promise<void> {
		let activeView = this.app.workspace.getActiveViewOfType(FileView);
		if (!activeView?.file) {
			// The stack's current entry is a view entry (graph active): the
			// current location is on screen — traversal moves from it
			// directly. (A closed graph leaf has nothing to re-land either:
			// no path, no position to restore.)
			const cur = this.entries[this.index];
			if (!cur || cur.kind === 'view') {
				this.index += dir;
				await this.execute(this.entries[this.index], dir);
				return;
			}
			// A sidebar (file explorer, search, outline…) or the empty
			// "new tab" page can hold focus with no file view active. The
			// stack's current entry still describes the last file tab —
			// reactivate its leaf so traversal starts from where the user
			// actually was (this also restores focus, and the unfocused
			// editor keeps its cursor/scroll state readable).
			const startLeaf = this.startLeaf();
			if (!startLeaf)
				return;
			this.app.workspace.setActiveLeaf(startLeaf, { focus: true });
			activeView = this.app.workspace.getActiveViewOfType(FileView);
			if (!activeView?.file) {
				// Only the new-tab page: the current entry's tab was closed —
				// an unrecorded hop OFF the stack, so the history pointer
				// still sits on that entry. The first hop re-lands it (index
				// unchanged, no hop skipped — same for back and forward);
				// from the next press on, traversal walks index±1 as usual.
				await this.execute(this.entries[this.index], dir);
				return;
			}
		}

		// Refresh the entry we are leaving with the exact current position,
		// so forward returns to where the user actually was. refreshTop
		// keeps a teleport top's landing.
		this.refreshTopFromActiveView();

		this.index += dir;
		await this.execute(this.entries[this.index], dir);
	}

	// The leave-refresh of a traversal/jump: the top entry gets the exact
	// current position so a return lands where the user actually was. The entry must
	// still describe its own leaf+file (a non-file view activation — search, graph —
	// records nothing, so the stack can point at the last file view while something
	// else is active). The view is taken from the entry's OWN leaf when the
	// workspace's active view is not it: a sidebar holding the focus — the resident
	// history panel included — leaves no active FileView at all, and the entry still
	// describes the file tab behind it.
	private refreshTopFromActiveView() {
		const cur = this.entries[this.index];
		if (!cur || cur.kind === 'view')
			return;
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		const view = activeView?.file && cur.leafId === this.state.leafId(activeView.leaf)
			? activeView
			: this.findLeafById(cur.leafId)?.view;
		if (view instanceof MarkdownView && view.file?.path === cur.path) {
			const st = readNavEntryState(view);
			if (st) this.refreshTop(cur.path, cur.leafId, st);
		}
	}

	private async execute(target: NavEntry, dir: -1 | 1, tryBoth = false, modTarget?: PaneTarget) {
		// A modifier was held: the place is opened in a leaf the APP picks for that
		// target — a new tab, a split, a new window — rather than in the leaf the entry
		// came from. That is a different question from everything below, which exists to
		// go BACK to a place (find its leaf, ride the tab's own history, re-assert a
		// swapped-out view); the reader who holds Cmd is asking for a second view of the
		// place, and the tab they are reading in must not move.
		//
		// The LANDING is not part of the difference: openInLeaf arms the same
		// instant-landing flag a traversal uses, so the same note opened with Cmd held
		// lands exactly where a plain open would (see its own note).
		if (modTarget) {
			const leaf = this.app.workspace.getLeaf(modTarget);
			if (target.kind === 'view') {
				// A pathless view has no file to open: the leaf has to be told to SHOW
				// it, and `active` is what brings it to the front — there is nothing
				// else on the new tab worth showing on the way.
				await leaf.setViewState({ type: target.viewType, state: {}, active: true });
				return;
			}
			await this.openInLeaf(leaf, target);
			return;
		}
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		// No file view anywhere (only the new-tab page): fall back to the
		// last main-area leaf — the empty tab — so the traversal can still
		// open its target there (openInLeaf) instead of no-oping.
		const activeLeaf = activeView?.leaf
			?? this.app.workspace.getMostRecentLeaf() ?? undefined;
		const targetLeaf = this.findLeafById(target.leafId);

		// View entry (a view tab): reaching it means the leaf must SHOW that
		// view — activate a different tab, and when the view was swapped
		// out (a graph node click opens the file over the graph in the same
		// leaf, or graph:open reuses the tab) re-assert it. A closed leaf
		// has nothing to return to — no-op (never the active tab's file).
		if (target.kind === 'view') {
			const leaf = targetLeaf;
			if (!leaf)
				return;
			if (leaf !== activeLeaf)
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
			if (leaf.isDeferred)
				await leaf.loadIfDeferred();
			const viewType = (leaf.view as { getViewType?: () => string } | undefined)?.getViewType?.();
			if (viewType === target.viewType)
				return;
			// The view was swapped out (a graph node click opens the file over
			// the graph in the same leaf, or graph:open reuses the tab): ride
			// the native per-tab history when its next entry IS the graph
			// (keeps the two stacks aligned), else re-assert the view directly.
			// A closed leaf falls through — never the active tab's file.
			if (leaf === activeLeaf && await this.delegateNative(dir, leaf, undefined, target.viewType))
				return;
			await (leaf as unknown as {
				setViewState(vs: { type: string; state: object; active: boolean }): Promise<void>;
			}).setViewState({ type: target.viewType, state: {}, active: true });
			return;
		}

		// Cross-tab: reactivate the original leaf (back to original tab leaf). A closed
		// leaf falls back to the active one.
		if (targetLeaf && targetLeaf !== activeLeaf) {
			await this.openInLeaf(targetLeaf, target);
			return;
		}

		const leaf = targetLeaf ?? activeLeaf;
		if (!leaf)
			return;
		// The entry's own leaf is gone and the entry fell back to another
		// leaf (the new-tab page's, or the most recently active): re-point
		// the entry at the leaf its file actually lives in now. The open's
		// post-traversal activation record carries THAT leaf id — against
		// the stale one it would miss this entry's dedup and push a phantom
		// duplicate, truncating the real forward part of the stack.
		if (!targetLeaf)
			target.leafId = this.state.leafId(leaf);
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const curFile = (leaf.view as FileView | undefined)?.file;

		if (curFile?.path === target.path) {
			// In-file jump: no open, apply the entry's position directly. The view to
			// apply it to is THIS leaf's, not the workspace's ACTIVE view: with a
			// sidebar holding the focus (the resident panel included) there is
			// no active file view at all, while the leaf still shows the file — and the
			// branch then applied nothing, so a jump to a place in the note already on
			// screen did nothing. That is the sidebar's "sometimes it jumps, sometimes
			// it does not": the ADJACENT case goes through traverse(), which
			// reactivates the file leaf first (see traverse), which is why it worked.
			// Only markdown has positions (the entry's st is refreshed at leave time);
			// a same-file non-markdown entry is a no-op — the view is already there.
			const view = leaf.view;
			if (view instanceof MarkdownView)
				await this.applyLanding(view, target);
			return;
		}

		// Same-tab file switch: ride the native per-tab history when its next
		// entry matches (keeps PDF/canvas native), else open directly. Both
		// routes are handed this target's own landing when it has one.
		const landing = this.landingFor(target);
		if (await this.delegateNative(dir, leaf, target.path, undefined, landing))
			return;
		// A PLACE's travel knows no stack position, so its direction is a guess:
		// offer the other one before falling back to a direct open. A failed
		// delegateNative has no side effect (it returns before arming or
		// executing anything), so the second attempt costs one comparison.
		if (tryBoth && await this.delegateNative(dir === 1 ? -1 : 1, leaf, target.path, undefined, landing))
			return;
		await this.openInLeaf(leaf, target);
	}

	// Apply a target's landing to a view that ALREADY shows the file — the in-file
	// jump both execute() (the target's own leaf, whether or not it is the ACTIVE
	// one) and openInLeaf() (a tab that still shows the target file) end in.
	// Re-anchor structurally first (the entry's lines predate any later edits), then
	// run the shared apply. Nothing to do when there is no landing anywhere for the
	// entry (see appliedLanding).
	private async applyLanding(view: MarkdownView, target: NavJump | NavVisit | NavTeleport) {
		const st = this.appliedLanding(target);
		if (!st)
			return;
		const isCurrent = () => view.file?.path === target.path;
		this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
		await this.modes.historyJumpApply(view, st, isCurrent, this.resolveAnchorShift(target));
	}

	// The landing a SAME-FILE jump applies. What the entry itself recorded comes
	// first (see landingOf); a step that recorded none falls back to the file's saved
	// record — the very source the browser borrowed that row's line from — so the line
	// on the row is still the line the click lands on.
	// Without this, such a row named a line and the jump applied nothing at all in the
	// same file. It is deliberately NOT part of landingFor: a cross-file open already
	// falls back to that record, so naming it there would only duplicate what the open
	// pipeline does by itself.
	private appliedLanding(target: NavJump | NavVisit | NavTeleport): NavEntryState | undefined {
		return this.landingOf(target) ?? this.savedPosition?.(target.path);
	}

	// The landing an entry can actually restore: its own recorded state, or — for a
	// teleport whose landing never settled (the post-jump read never arrived, so the
	// entry kept only the line it aimed at) — that target line as the viewport top.
	// The browser prints exactly that line on the row, so honouring it is what keeps
	// the row from promising a place the jump then does not take the reader to.
	// undefined for an entry that recorded no position of its own (a legacy entry, a
	// tab activation before its leave-refresh): a same-file jump falls back to the
	// file's saved record (see appliedLanding), and a cross-file open falls back to it
	// by itself.
	private landingOf(target: NavJump | NavVisit | NavTeleport): NavEntryState | undefined {
		if (target.st)
			return target.st;
		if (target.kind === 'teleport' && Number.isFinite(target.line))
			return { scroll: Math.max(0, target.line) };
		return undefined;
	}

	// The landing a cross-file traversal hands to the open pipeline: the
	// entry's OWN recorded position — the spot the browser row shows, and
	// (per this module's contract) the spot back/forward must return to — which for
	// an unsettled teleport is the target line it recorded (see landingOf). The
	// structural re-anchor is applied when the entry is a keyed jump whose
	// heading has moved since: the injected open path has no target editor to
	// run the text-snippet remap against, so the structural shift is the only
	// edit correction available there. undefined — a keyless entry before its
	// leave-refresh, a legacy persisted entry, a ^block key (never upgraded) —
	// leaves the open to the file record: where the user actually was.
	private landingFor(target: NavJump | NavVisit | NavTeleport): NavEntryState | undefined {
		const st = this.landingOf(target);
		if (!st)
			return undefined;
		const shift = this.resolveAnchorShift(target);
		return shift ? shiftNavState(st, shift) : st;
	}

	// Arms the one-shot flag the setViewState patch consumes (see
	// PositionState.pendingHistoryNav): the traversal's own open must inject
	// this plugin's position over the native entry's cursor-only eState.
	// `landing` is the target entry's own position when it has one — the patch
	// injects it in place of the file record, and the restorer settles to the
	// same value; `path` is the file it belongs to, so a flag stolen by an
	// unrelated open in the arming window can never inject another file's
	// landing. The timeout is the safety net for a command that never reached
	// setViewState, and it must drop the landing WITH the flag: one left
	// behind would be injected into an unrelated later open.
	private armHistoryNav(landing: NavEntryState | undefined, path: string) {
		this.state.pendingHistoryNav = true;
		this.state.pendingHistoryNavState = landing;
		this.state.pendingHistoryNavPath = path;
		this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
		window.clearTimeout(this.state.pendingHistoryNavTimeout);
		this.state.pendingHistoryNavTimeout = window.setTimeout(() => {
			this.state.pendingHistoryNav = false;
			this.state.pendingHistoryNavState = undefined;
			this.state.pendingHistoryNavPath = undefined;
		}, HISTORY_NAV_TIMEOUT_MS);
	}

	// Opens the target file in `leaf` (activating it first when it is a
	// different tab). A live tab that ALREADY shows the file needs no open —
	// but the entry's landing still applies: that case is an in-file jump, and
	// the entry (and the browser row) promises that spot, not wherever the tab
	// happened to be left when the user switched away from it. The markdown
	// open restores through the standard injection pipeline, handed this
	// target's own landing when it has one; non-markdown opens rely on each
	// view's own position handling. (View entries never route here — execute
	// reactivates them; the parameter type enforces it.)
	private async openInLeaf(leaf: WorkspaceLeaf, target: NavJump | NavVisit | NavTeleport) {
		if (this.app.workspace.getActiveViewOfType(FileView)?.leaf !== leaf)
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const view = leaf.view;
		const curFile = (view as FileView | undefined)?.file;
		if (curFile?.path === target.path) {
			if (view instanceof MarkdownView)
				await this.applyLanding(view, target);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(target.path);
		if (file instanceof TFile) {
			// A traversal that opens directly (cross-tab, or the native
			// stack's next entry didn't match) must land instantly like the
			// delegated one: arm the same flag delegateNative uses, so the
			// setViewState patch injects this target's landing over the plain
			// open and bypasses the glide choice. The timeout clears it when
			// this open never reaches setViewState.
			this.armHistoryNav(this.landingFor(target), target.path);
			await leaf.openFile(file);
		}
	}

	// Delegates one step to the native per-tab history — but only when the
	// native stack's next entry IS the target — a file path, or a view type
	// for a view entry (the graph, Thino's memo list) — so the two stacks can
	// never disagree on where a step lands (in-file jumps exist only on our
	// stack, so mismatches happen legitimately; those run
	// openInLeaf/setViewState instead). Returns whether the landing was verified.
	private async delegateNative(
		dir: -1 | 1,
		leaf: WorkspaceLeaf,
		targetPath: string | undefined,
		targetViewType?: string,
		targetLanding?: NavEntryState,
	): Promise<boolean> {
		const history = (leaf as unknown as { history?: NativeLeafHistory }).history;
		const stack = dir < 0 ? history?.backHistory : history?.forwardHistory;
		const top = stack?.[stack.length - 1];
		const matches = targetPath !== undefined
			? top?.state?.state?.file === targetPath
			: top?.state?.type === targetViewType;
		if (!matches)
			return false;

		// Arm the injection: the setViewState patch then lays this plugin's
		// position over the native entry's cursor-only eState — markdown file
		// entries only, carrying the target's own landing when it has one. A
		// view entry is left unarmed: its setViewState early-returns
		// in the patch before the flag is read, so arming it here would only
		// leak onto an unrelated later open.
		if (targetPath !== undefined)
			this.armHistoryNav(targetLanding, targetPath);
		// (app.commands is part of the runtime API but absent from the
		// public typings — same cast family as position-state.leafId.)
		(this.app as unknown as {
			commands: { executeCommandById(id: string): unknown };
		}).commands.executeCommandById(dir < 0 ? 'app:go-back' : 'app:go-forward');

		await delay(NATIVE_LANDING_VERIFY_MS);
		if (targetPath !== undefined)
			return (leaf.view as FileView | undefined)?.file?.path === targetPath;
		return (leaf.view as { getViewType?: () => string } | undefined)?.getViewType?.() === targetViewType;
	}

	private findLeafById(id?: string): WorkspaceLeaf | undefined {
		if (!id)
			return undefined;
		let found: WorkspaceLeaf | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && this.state.leafId(leaf) === id)
				found = leaf;
		});
		return found;
	}

	// Structural re-anchor for an in-file jump: resolve the entry's key
	// (outline heading / anchor linktext) to its CURRENT line in the file via
	// metadataCache, and return the SHIFT the recorded position needs — the
	// anchor's current line minus its RECORD-TIME line (keyLine, upgraded at
	// the landing). The shift reflects file edits only; historyJumpApply
	// applies it uniformly to scroll and cursor, preserving the recorded
	// viewport geometry (an unedited file shifts 0 and restores untouched).
	// Entries without a keyLine (never settled, pre-upgrade, ^block keys)
	// return undefined — historyJumpApply falls back to the text-snippet
	// remap, whose base and target share the viewport-line semantics.
	private resolveAnchorShift(target: NavEntry): number | undefined {
		if (target.kind !== 'jump' || !target.key || typeof target.keyLine !== 'number')
			return undefined;
		const file = this.app.vault.getAbstractFileByPath(target.path);
		if (!(file instanceof TFile))
			return undefined;
		const line = resolveAnchorLine(this.app.metadataCache.getFileCache(file), target.key, target.keyLine);
		return line === undefined ? undefined : line - target.keyLine;
	}

	// ===== Bookkeeping (this stack's own records — see PathBookkeeper) =====

	renameFile(oldPath: string, newPath: string) {
		for (const entry of this.entries)
			if (entry.kind !== 'view' && entry.path === oldPath)
				entry.path = newPath;
	}

	// A real vault delete drops the file's steps. NOT called straight off the
	// vault 'delete' event: PathBookkeeper schedules the prune and re-checks the
	// vault before it commits, because a sync plugin replaces a changed file by
	// removing it and renaming the download over it — a delete that is undone a
	// moment later (see position/path-bookkeeping.ts).
	deleteFile(path: string) {
		const kept: NavEntry[] = [];
		let removedBefore = 0;
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (entry.kind !== 'view' && entry.path === path) {
				if (i < this.index)
					removedBefore++;
				continue;
			}
			kept.push(entry);
		}
		// A path no step names (the bookkeeper re-checks the vault, and a sync
		// plugin's replace-and-rename is one path that comes straight back): the
		// stack is not rewritten at all.
		if (kept.length === this.entries.length)
			return;
		this.entries = kept;
		this.index = kept.length === 0
			? -1
			: Math.min(this.index - removedBefore, kept.length - 1);
	}

	// ===== Persistence (device-local, per vault — mirrors the overlay) =====
	// The storage format, startup read, and per-entry shape check live in
	// store.ts.

	// The last blob THIS instance wrote (the flush dedup — see
	// persistNavHistory). An instance field, not module state: the history is
	// per vault, and a dedup shared between instances would let one skip a
	// write it owes.
	private lastPersisted = '';

	persist() {
		this.lastPersisted = persistNavHistory(
			this.app, this.entries, this.index, this.lastPersisted);
	}
}
