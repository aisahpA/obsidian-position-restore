import { App, FileView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { NavEntryState, PluginSettings, DEFAULT_SETTINGS } from '@/types';
import { PositionState } from '@/position/state';
import { RestoreModes } from '@/position/restore/modes';
import { readNavEntryState, normAnchor, shiftNavState } from '@/position/capture/ephemeral';
import { resolveAnchorLine, findHeading, decodeAnchor } from '@/position/restore/anchor';
import { delay } from '@/shared/wait';
import {
	NavHistoryEntry, NavJump, NavVisit, NavTeleport, NewNavEntry,
	RECORDABLE_VIEW_TYPES,
} from './entry';
import { isMainAreaLeaf } from '@/shared/leaf';
import { loadNavHistory, persistNavHistory } from './store';
import { installOutlineCapture as installOutlineCaptureHook } from './outline-capture';

// VSCode-style back/forward navigation.
//
// One global stack of entries (NavJump | NavTeleport | NavVisit | NavView)
// with a current
// index. Every recorded jump (any file switch, tab/pane activation,
// in-file anchor/search/large cursor jumps) pushes; back/forward move the
// index; a fresh jump — recorded or picked from the history browser —
// truncates the forward part, and the browser jump re-pushes its target on
// top so back returns to the jump's origin. Two position regimes:
// keyed entries (outline:<heading>, anchor linktext) and teleports carry
// the jump's precise landing — written at push time (teleport) or when the
// landing settles (outline/anchor) — and are never overwritten afterwards
// (back/forward must return to the jump target itself); keyless open/
// activation entries carry no position of their own — their st slot is
// refreshed on every leave ("where the user actually was"). st feeds BOTH
// the same-file direct apply (execute) and the cross-file open: a traversal
// hands the target's own landing to the open pipeline (landingFor), so the
// line a row shows is the line the open lands on. Only an entry with no
// recorded position of its own falls back to the per-file records
// (database + the per-leaf overlay) — "where the user actually was".
//
// Same-tab file switches EXECUTE through Obsidian's native per-tab history
// (leaf.history + app:go-back/go-forward): that covers PDF/canvas and every
// other non-markdown view this plugin cannot reposition. For markdown, the
// native entry's eState carries only the cursor (no scroll), so the setViewState
// patch injects this plugin's saved position over it (pendingHistoryNav).
// Cross-tab traversals reactivate the original leaf (leafId); a closed leaf
// falls back to the active one. Non-file main-area views (the graph tabs)
// are recorded too: their entries have no path, only a viewType — traversal
// just reactivates the leaf. The entry vocabulary (NavHistoryEntry and its
// variants, isMainAreaLeaf, the recordable view whitelist) lives in
// entry.ts.
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

// Watchdog releasing the navigate() bracket if a traversal await hangs
// (openFile / loadIfDeferred never resolve): without it `executing` would
// stay up forever and permanently disable back/forward. Sits above the
// legit apply ceiling (SETTLE_MAX_MS 800 + RELAND_MAX_MS 3000 + anchor
// delays), so slow-but-progressing traversals are never cut off.
const NAV_WATCHDOG_MS = 5000;

export class NavHistory {
	private app: App;
	private state: PositionState;
	private modes: RestoreModes;
	// Shared settings object (main.ts assigns once, settings-tab mutates in
	// place): recording toggles and the stack cap stay live.
	private settings: PluginSettings;

	entries: NavHistoryEntry[] = [];
	// Index of the entry describing the CURRENT location; -1 = empty stack.
	index = -1;

	// True while a back/forward traversal is executing: the opens it triggers
	// (openFile, native go-back) are the traversal itself, not new jumps.
	private executing = false;

	constructor(app: App, settings: PluginSettings, state: PositionState) {
		this.app = app;
		this.state = state;
		this.settings = settings;
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
	// on screen or permanently out of sight (see NavHistoryList.render).
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

	// ===== Recording =====

	// A file open (setViewState patch), an in-file jump marker, or a graph
	// activation (pathless, opts.viewType). Gates shared with the jump
	// pushers live here so every caller is uniform.
	// Gates shared by every pusher, so all callers are uniform: a
	// traversal's own opens are the traversal, not new jumps, and startup
	// rebuild / workspace-restore setViewStates are not user navigation.
	private canRecord(): boolean {
		return !this.executing && this.app.workspace.layoutReady;
	}

	recordOpen(
		path: string | undefined,
		leafId: string,
		opts: { key?: string; force?: boolean; viewType?: string; via?: 'switch' | 'link'; viaPath?: string; viaText?: string } = {},
	) {
		if (!this.canRecord())
			return;
		// The single entry construction site: the kind tag is written here
		// and never mutated, so every downstream switch on it is exact.
		if (opts.viewType) {
			this.pushIfNew({ kind: 'view', leafId, viewType: opts.viewType }, opts.force);
			return;
		}
		// A pathless, typeless call has nothing to restore — no entry.
		if (!path)
			return;
		this.pushIfNew(
			opts.key
				? { kind: 'jump', path, leafId, key: opts.key }
				: { kind: 'visit', path, leafId, via: opts.via, viaPath: opts.viaPath, viaText: opts.viaText },
			opts.force,
		);
	}

	// Large same-file cursor jump (go-to-line, vim jump, far mouse click):
	// per selection event on desktop (Sampler.onEditorSelection, 10-line
	// threshold), per poll tick on mobile (Sampler.teleportLines, 50-line
	// threshold). Search/anchor-jump landings are excluded by the sampler
	// via the search-anchor gate. An INFERRED move, not a deliberate jump —
	// its own entry kind (NavTeleport), gated by navRecordTeleport and
	// deduped by target line: repeated jumps to the same line (re-clicking
	// the same spot) dedup, jumps to different lines are distinct entries.
	// The pushed entry carries the jump's LANDING position (`landing`, the
	// post-jump read) — precise-return semantics: returning to this entry
	// lands on the jump target itself, never on where the user had drifted
	// by leave time.
	recordTeleport(path: string, leafId: string, line: number, landing?: NavEntryState) {
		if (!this.settings.navRecordTeleport || !this.canRecord())
			return;
		this.pushIfNew({ kind: 'teleport', path, leafId, line });
		// Fill a fresh entry only: the top must be this exact teleport
		// (a gated call pushed nothing; a deduped repeat and a different
		// line keep what they have).
		const top = this.entries[this.index];
		if (landing && top && top.kind === 'teleport'
			&& top.path === path && top.line === line && !top.st)
			top.st = landing;
	}

	// Tab/pane activation as navigation (VSCode records active editor changes
	// the same way): a user clicking another tab is a "where I was" entry.
	// Gates and dedup are recordOpen's; keyless, so an activation that
	// follows an open of the same file in the same leaf is absorbed by it.
	// via: 'switch' only marks the browser badge. Non-file main-area views
	// (graph) are entries too; sidebar panels are excluded above.
	recordActivation(leaf: WorkspaceLeaf | null) {
		// "Update on leave" for tab/pane switches: the setViewState patch
		// does this for same-tab file switches, but focusing another tab
		// fires no setViewState — without this the entry for the file being
		// left would never get a position (the browser would show only its
		// type badge).
		this.refreshTopLeafOnActivation(leaf);
		if (!this.settings.navRecordActivation)
			return;
		const view = leaf?.view;
		if (!leaf || !isMainAreaLeaf(this.app, leaf))
			return;
		if (view instanceof FileView && view.file) {
			this.recordOpen(view.file.path, this.state.leafId(leaf), { via: 'switch' });
			return;
		}
		const viewType = view?.getViewType();
		if (viewType && RECORDABLE_VIEW_TYPES.has(viewType))
			this.recordOpen(undefined, this.state.leafId(leaf), { viewType });
	}

	// Capture the position of the file being switched away from onto the top
	// entry (the one that describes it). refreshTop guards the path+leaf
	// match and keeps keyed landings; canRecord skips our own traversals and
	// startup. A no-op when no leaf holds the top entry (e.g. it was closed).
	private refreshTopLeafOnActivation(next: WorkspaceLeaf | null) {
		if (!next || !this.canRecord())
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
	refreshTop(path: string, leafId: string, st: NavEntryState) {
		const top = this.entries[this.index];
		if (!top || top.kind === 'view' || top.path !== path || top.leafId !== leafId)
			return;
		if (top.kind === 'jump') {
			if (!top.st) {
				top.st = st;		
				this.upgradeKeyLine(top, st);
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

	// Reading-mode outline clicks are invisible to every other recording
	// path; the capture hook lives in outline-capture.ts — it needs only
	// this class's refreshTop/recordOpen plus the shared position state.
	installOutlineCapture(registerCleanup: (fn: () => void) => void) {
		installOutlineCaptureHook(this.app, {
			state: this.state,
			refreshTop: (path, leafId, st) => this.refreshTop(path, leafId, st),
			recordOpen: (path, leafId, opts) => this.recordOpen(path, leafId, opts),
		}, registerCleanup);
	}

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
	private sameLocation(top: NavHistoryEntry, entry: NewNavEntry): boolean {
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

	// The single entry funnel: every push is stamped here, so `t` (the
	// history browser's relative-time label) can never be missing on a live
	// entry. A jumpTo copy arrives unstamped too and gets a FRESH stamp —
	// the picker jump is a new navigation moment, not a replay of the old
	// one, and it is what the row's "刚刚" label should report.
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

	// ===== Traversal =====

	// Stack-bound check: back needs an entry below, forward an entry above.
	private canStep(dir: -1 | 1): boolean {
		return dir < 0 ? this.index > 0 : this.index >= 0 && this.index < this.entries.length - 1;
	}

	// Command availability (checkCallback). An active file view is the normal
	// start; when a sidebar holds focus, traversal can still start from the
	// last file tab (see startLeaf).
	canNavigate(dir: -1 | 1): boolean {
		if (this.executing)
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
		await this.runBracketed(() => this.traverse(dir));
	}

	// Time travel to an arbitrary entry (the history browser). Same bracket
	// as navigate. The jump is a fresh navigation branching from the current
	// entry (VSCode/IDEA semantics): the forward part is truncated and the
	// target re-pushed on top, so the origin is always the entry right below
	// and back returns to where the user was. The target goes in as a shallow
	// copy — the original entry keeps its own leave-position. Clicking the
	// current row just re-lands (keyed entries re-apply their landing).
	//
	// The entry NEXT TO the current one is the exception: that is just a
	// back/forward step, so the pointer moves instead. Branching there would
	// duplicate the entry, and the copy would make the origin the new
	// "previous" entry — so a browser step followed by another bounced
	// straight back (A → B → A …), adding one duplicate per press.
	async jumpTo(index: number): Promise<void> {
		if (index < 0 || index >= this.entries.length)
			return;
		if (index === this.index - 1 || index === this.index + 1) {
			await this.navigate(index < this.index ? -1 : 1);
			return;
		}
		await this.runBracketed(async () => {
			this.refreshTopFromActiveView();
			// Only feeds delegateNative's direction (command id + landing
			// verification); multi-step jumps never match the native stack's
			// next entry, so the value is a formality beyond ±1 hops.
			const dir: -1 | 1 = index > this.index ? 1 : -1;
			if (index !== this.index)
				this.push({ ...this.entries[index] });
			await this.execute(this.entries[this.index], dir);
		});
	}

	// The bracket shared by navigate/jumpTo: one position change, not new
	// jumps. It must cover the startLeaf activation too: its
	// active-leaf-change fires recordActivation, and when the top entry's
	// leafId is stale (closed-leaf fallback, ids restored from storage)
	// the dedup misses — the command itself would push a "current
	// location" entry before any gate was up. The bracket also stops the
	// poll/scroll capture from recording the programmatic applies as
	// user movement (the restores this open triggers run their own
	// brackets inside).
	private async runBracketed(step: () => Promise<void>): Promise<void> {
		if (this.executing)
			return;
		this.executing = true;
		this.state.restoreStarted();
		// Watchdog and the finally share one settle: exactly one restoreEnded
		// per restoreStarted (restoreStarted/Ended keep a shared counter), and
		// a hung traversal releases `executing` so back/forward stay usable.
		// A late completion after the watchdog fired simply no-ops here.
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(watchdog);
			this.state.restoreEnded();
			this.executing = false;
		};
		const watchdog = window.setTimeout(settle, NAV_WATCHDOG_MS);
		try {
			await step();
		} finally {
			settle();
		}
	}

	private async traverse(dir: -1 | 1): Promise<void> {
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
	// current position so a return lands where the user actually was. Only
	// when the top entry really describes the active leaf+file (a non-file
	// view activation — search, graph — records nothing, so the stack can
	// point at the last file view while something else is active).
	private refreshTopFromActiveView() {
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		const cur = this.entries[this.index];
		if (cur && cur.kind !== 'view' && activeView?.file
			&& cur.leafId === this.state.leafId(activeView.leaf)
			&& cur.path === activeView.file.path && activeView instanceof MarkdownView) {
			const st = readNavEntryState(activeView);
			if (st) this.refreshTop(cur.path, cur.leafId, st);
		}
	}

	// Fill the current (top) entry's position from the live active view.
	// Called before the history browser renders: the entry you are sitting in
	// has had no leave-refresh yet, so it would otherwise show no position.
	syncCurrentPosition() {
		this.refreshTopFromActiveView();
	}

	private async execute(target: NavHistoryEntry, dir: -1 | 1) {
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		// No file view anywhere (only the new-tab page): fall back to the
		// last main-area leaf — the empty tab — so the traversal can still
		// open its target there (openInLeaf) instead of no-oping.
		const activeLeaf = activeView?.leaf
			?? this.app.workspace.getMostRecentLeaf() ?? undefined;
		const targetLeaf = this.findLeafById(target.leafId);

		// View entry (graph tab): reaching it means the leaf must SHOW that
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
			// In-file jump: no open, apply the entry's position directly.
			// Only markdown has positions (the entry's st is refreshed at
			// leave time); a same-file non-markdown entry is a no-op — the
			// view is already there. (leaf is the active leaf here — the
			// cross-tab case returned above — so this is the active view.)
			if (activeView instanceof MarkdownView)
				await this.applyLanding(activeView, target);
			return;
		}

		// Same-tab file switch: ride the native per-tab history when its next
		// entry matches (keeps PDF/canvas native), else open directly. Both
		// routes are handed this target's own landing when it has one.
		if (await this.delegateNative(dir, leaf, target.path, undefined, this.landingFor(target)))
			return;
		await this.openInLeaf(leaf, target);
	}

	// Apply a target's recorded landing to a view that ALREADY shows the file
	// — the in-file jump both execute() (same file on the active leaf) and
	// openInLeaf() (a tab that still shows the target file) end in. Re-anchor
	// structurally first (the entry's lines predate any later edits), then run
	// the shared apply. Nothing to do without a recorded landing: a keyless
	// entry that never got its leave-refresh, a legacy entry, or a view entry
	// (non-markdown views have no position of ours to apply).
	private async applyLanding(view: MarkdownView, target: NavJump | NavVisit | NavTeleport) {
		if (!target.st)
			return;
		const isCurrent = () => view.file?.path === target.path;
		this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
		await this.modes.historyJumpApply(view, target.st, isCurrent, this.resolveAnchorShift(target));
	}

	// The landing a cross-file traversal hands to the open pipeline: the
	// entry's OWN recorded position — the spot the browser row shows, and
	// (per this module's contract) the spot back/forward must return to. The
	// structural re-anchor is applied when the entry is a keyed jump whose
	// heading has moved since: the injected open path has no target editor to
	// run the text-snippet remap against, so the structural shift is the only
	// edit correction available there. undefined — a keyless entry before its
	// leave-refresh, a legacy persisted entry, a ^block key (never upgraded) —
	// leaves the open to the file record: where the user actually was.
	private landingFor(target: NavJump | NavVisit | NavTeleport): NavEntryState | undefined {
		if (!target.st)
			return undefined;
		const shift = this.resolveAnchorShift(target);
		return shift ? shiftNavState(target.st, shift) : target.st;
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
	// for a view entry (the graph) — so the two stacks can never disagree on
	// where a step lands (in-file jumps exist only on our stack, so
	// mismatches happen legitimately; those run openInLeaf/setViewState
	// instead). Returns whether the landing was verified.
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
		// view entry (graph) is left unarmed: its setViewState early-returns
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
	private resolveAnchorShift(target: NavHistoryEntry): number | undefined {
		if (target.kind !== 'jump' || !target.key || typeof target.keyLine !== 'number')
			return undefined;
		const file = this.app.vault.getAbstractFileByPath(target.path);
		if (!(file instanceof TFile))
			return undefined;
		const line = resolveAnchorLine(this.app.metadataCache.getFileCache(file), target.key, target.keyLine);
		return line === undefined ? undefined : line - target.keyLine;
	}

	// ===== Bookkeeping =====

	renameFile(oldPath: string, newPath: string) {
		for (const entry of this.entries)
			if (entry.kind !== 'view' && entry.path === oldPath)
				entry.path = newPath;
	}

	// A real vault delete drops the file's steps (the browser shows the gap as
	// a missing row until then). NOT called straight off the vault 'delete'
	// event: PathBookkeeper schedules the prune and re-checks the vault before
	// it commits, because a sync plugin replaces a changed file by removing it
	// and renaming the download over it — a delete that is undone a moment
	// later (see position/path-bookkeeping.ts).
	deleteFile(path: string) {
		const kept: NavHistoryEntry[] = [];
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
