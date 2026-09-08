import { App, FileView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { PositionState, LANDING_ABSORB_MS } from './position-state';
import { RestoreModes } from './restore-modes';
import { readEphemeralState } from './ephemeral';
import { delay } from './wait';

// VSCode-style back/forward navigation.
//
// One global stack of entries `{ path, leafId, st?, key? }` with a current
// index. Every recorded jump (any file switch, tab/pane activation,
// in-file anchor/search/large cursor jumps) pushes; back/forward move the
// index; a fresh jump truncates the forward part; the history-browser jump
// lifts its target to the top (back returns to the jump's origin). Two
// position regimes:
// keyed entries (teleport:<line>, outline:<heading>, anchor linktext) carry
// the jump's precise landing — written at push time (teleport) or when the
// landing settles (outline/anchor) — and are never overwritten afterwards
// (back/forward must return to the jump target itself); keyless open/
// activation entries carry no position of their own — their st slot is
// refreshed on every leave ("where the user actually was"). st only feeds
// the same-file direct apply in execute(); cross-file traversal restores
// from the per-file records (database + tab-store).
//
// Same-tab file switches EXECUTE through Obsidian's native per-tab history
// (leaf.history + app:go-back/go-forward): that covers PDF/canvas and every
// other non-markdown view this plugin cannot reposition. For markdown, the
// native entry's eState carries only the cursor (no scroll), so the setViewState
// patch injects this plugin's saved position over it (pendingHistoryNav).
// Cross-tab traversals reactivate the original leaf (leafId); a closed leaf
// falls back to the active one. Non-file main-area views (the graph tabs)
// are steps too: their entries have no path, only a viewType — traversal
// just reactivates the leaf.
export interface NavHistoryEntry {
	// Undefined only for a view entry (viewType set).
	path?: string;
	leafId?: string;
	// Non-file view destination (the global graph); a pathless entry.
	viewType?: string;
	// Same-file apply position (markdown only): the jump's precise landing
	// for keyed entries (teleport/outline/anchor — written at push time or
	// when the landing settles, immutable), the leave position for keyless
	// open/activation entries (refreshed on every leave).
	st?: EphemeralState;
	// Dedup key: the linktext of an anchor jump, or `teleport:<line>` for
	// large cursor jumps. A push whose key equals the top entry's key is the
	// same jump repeated (repeated outline clicks to one heading) and is
	// dropped.
	key?: string;
}

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

// Non-file main-area views recorded as steps: the global graph is a real
// destination (note → graph → note hops, and its leaf can be shared with
// files via node clicks / graph:open tab reuse). Whitelisted — sidebar
// panels are excluded by isMainAreaLeaf, the empty tab and dragged-in
// sidebars stay out, and localgraph is omitted (its view state carries the
// tracked file, which a pathless entry cannot restore).
const RECORDABLE_VIEW_TYPES = new Set(['graph']);

// Only main-area leaves record as navigation steps. Sidebar panels
// (outline, backlinks, local graph…) track the active file in their own
// view state: focusing the panel (or its state re-assertion) carries that
// file through activation/setViewState, and recording it creates a phantom
// step whose "leaf" is the panel — a traversal targeting it would only
// re-focus the panel. Hover previews and pop-out windows are equally not
// steps of this workspace.
export function isMainAreaLeaf(app: App, leaf: WorkspaceLeaf): boolean {
	// (rootSplit.containerEl and leaf.containerEl are runtime API absent
	// from the public typings — same cast family as position-state.leafId.)
	const root = app.workspace.rootSplit as { containerEl?: HTMLElement } | undefined;
	const el = (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
	return !!root?.containerEl && !!el && root.containerEl.contains(el);
}

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
	private lastPersisted = '';

	constructor(app: App, settings: PluginSettings, state: PositionState) {
		this.app = app;
		this.state = state;
		this.settings = settings;
		const restored = NavHistory.load(app);
		this.entries = restored.entries;
		this.index = restored.index;
		this.modes = new RestoreModes(settings, state);
	}

	// ===== Recording =====

	// A file open (setViewState patch), an in-file jump marker, or a graph
	// activation (pathless, opts.viewType). Gates shared with the jump
	// pushers live here so every caller is uniform.
	recordOpen(
		path: string | undefined,
		leafId: string,
		opts: { key?: string; force?: boolean; viewType?: string } = {},
	) {
		if (this.executing)
			return;
		// Startup rebuild / workspace-restore setViewStates are not user
		// navigation.
		if (!this.app.workspace.layoutReady)
			return;
		this.pushIfNew({ path, leafId, viewType: opts.viewType, key: opts.key }, opts.force);
	}

	// Large same-file cursor jump (go-to-line, vim jump, far mouse click):
	// per selection event on desktop (Sampler.onEditorSelection, 10-line
	// threshold), per poll tick on mobile (Sampler.teleportLines, 50-line
	// threshold). Search/anchor-jump landings are excluded by the sampler
	// via the search-anchor gate. Keyed by target line: repeated jumps to
	// the same line (re-clicking the same spot) dedup, jumps to different
	// lines are distinct entries. The pushed entry carries the jump's
	// LANDING position (`landing`, the post-jump read) — precise-return
	// semantics: returning to this entry lands on the jump target itself,
	// never on where the user had drifted by leave time.
	recordTeleport(path: string, leafId: string, line: number, landing?: EphemeralState) {
		if (!this.settings.navRecordTeleport)
			return;
		this.recordOpen(path, leafId, { key: `teleport:${line}` });
		// Fill a fresh entry only: the top must be this exact teleport key
		// (a gated call pushed nothing; a deduped repeat and a different
		// line keep what they have).
		const top = this.entries[this.index];
		if (landing && top && top.path === path && top.key === `teleport:${line}` && !top.st)
			top.st = landing;
	}

	// Tab/pane activation as navigation (VSCode records active editor changes
	// the same way): a user clicking another tab is a "where I was" step.
	// Gates and dedup are recordOpen's; keyless, so an activation that
	// follows an open of the same file in the same leaf is absorbed by it.
	// Non-file main-area views (graph) are steps too; sidebar panels are
	// excluded above.
	recordActivation(leaf: WorkspaceLeaf | null) {
		if (!this.settings.navRecordActivation)
			return;
		const view = leaf?.view;
		if (!leaf || !isMainAreaLeaf(this.app, leaf))
			return;
		if (view instanceof FileView && view.file) {
			this.recordOpen(view.file.path, this.state.leafId(leaf));
			return;
		}
		const viewType = view?.getViewType();
		if (viewType && RECORDABLE_VIEW_TYPES.has(viewType))
			this.recordOpen(undefined, this.state.leafId(leaf), { viewType });
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
	refreshTop(path: string, leafId: string, st: EphemeralState) {
		const top = this.entries[this.index];
		if (!top || top.path !== path || top.leafId !== leafId)
			return;
		if (top.key) {
			if (!top.st)
				top.st = st;
			return;
		}
		top.st = st;
	}

	// Reading-mode outline clicks are invisible to every other
	// recording path: core resolves an item click into setActiveLeaf +
	// view.setEphemeralState({ line }) — no openLinkText, no setViewState,
	// and preview has no cursor for the poll's teleport — so nothing pushes.
	// Source mode is recorded here TOO: the capture itself pushes the keyed
	// outline entry, and the landing-absorb window it arms gates the
	// imminent cursor jump on both teleport paths (selection event / poll),
	// so one click pushes exactly one entry (no teleport double-record).
	// This capture listener runs before core's handlers (capture phase on
	// the workspace root), which is what lets refreshTop see the exact
	// pre-click position. Every resolution step degrades silently: unknown
	// DOM, missing outline view, unresolvable target leaf — the hook does
	// nothing and the standard pipeline covers the not-open case on its own.
	installOutlineCapture(registerCleanup: (fn: () => void) => void) {
		this.app.workspace.containerEl.addEventListener('click', this.onOutlineClick, { capture: true });
		registerCleanup(() =>
			this.app.workspace.containerEl.removeEventListener('click', this.onOutlineClick, { capture: true }));
	}

	private onOutlineClick = (ev: MouseEvent) => {
		if (!(ev.target instanceof HTMLElement))
			return;
		// Collapse arrows preventDefault core's jump handler downstream, but
		// this capture listener runs before that happens — exclude them here.
		if (ev.target.closest('.collapse-icon'))
			return;
		// Outline tree items only (the clickable selfEl): excludes the
		// panel's search box, toolbar buttons, and every non-outline click.
		const selfEl = ev.target.closest('.tree-item-self.is-clickable');
		const contentEl = selfEl?.closest('.workspace-leaf-content[data-type="outline"]');
		if (!selfEl || !contentEl)
			return;
		// The outline leaf owning the clicked panel (a view's containerEl IS
		// the workspace-leaf-content element).
		let outlineLeaf: WorkspaceLeaf | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!outlineLeaf && leaf.view.getViewType() === 'outline'
				&& leaf.view.containerEl === contentEl)
				outlineLeaf = leaf;
		});
		const outlineFile = (outlineLeaf?.view as unknown as { file?: unknown })?.file;
		if (!(outlineFile instanceof TFile))
			return;
		// The markdown leaf the jump will land in — mirrors core's
		// findCorrespondingLeaf: linked-pane group first, else the active
		// markdown view when it tracks the same file. No match means core
		// opens the file fresh (new leaf) — that open records through the
		// setViewState pipeline already.
		// (leaf.group is runtime API absent from the public typings — same
		// cast family as isMainAreaLeaf's containerEl.)
		const group = (outlineLeaf as unknown as { group?: string } | undefined)?.group;
		let view: MarkdownView | undefined;
		if (group) {
			for (const leaf of this.app.workspace.getGroupLeaves(group)) {
				const v = leaf.view;
				if (v instanceof MarkdownView && v.file === outlineFile) {
					view = v;
					break;
				}
			}
		} else {
			// Core's findCorrespondingLeaf resolves through getActiveFileView,
			// NOT getActiveViewOfType: the click's pointerdown focuses the
			// outline panel's leaf FIRST (the capture phase sees activeLeaf =
			// the outline view), and getActiveViewOfType — strictly the
			// focused leaf — returns null there, so the jump would never
			// record. getActiveFileView falls back to the most recently
			// active FILE view. (Runtime API absent from the public typings —
			// same cast family as isMainAreaLeaf's containerEl.)
			const active = (this.app.workspace as unknown as {
				getActiveFileView?: () => unknown;
			}).getActiveFileView?.();
			if (active instanceof MarkdownView && active.file === outlineFile)
				view = active;
		}
		if (!view || !view.file)
			return;
		// "Update on leave" with the exact pre-click position (nothing has
		// scrolled yet) so a later back lands where the user actually was.
		const leafId = this.state.leafId(view.leaf);
		const fromSt = readEphemeralState(view);
		if (fromSt)
			this.refreshTop(view.file.path, leafId, fromSt);
		// Key = heading text (core renders the heading as the item's inner
		// text): repeated clicks to one heading dedup, different headings
		// push — the anchor-link key semantics. No text → no key → skip
		// (a keyless entry would wrongly absorb every later click).
		const heading = selfEl.querySelector('.tree-item-inner')?.textContent?.trim();
		if (heading) {
			this.recordOpen(view.file.path, leafId, { key: `outline:${heading}` });
			// Arm the landing absorb (same contract as open-kind jumps):
			// core resolves the jump asynchronously, and the poll/scroll
			// capture must stay absorbed until it settles — the settled read
			// then becomes this entry's precise landing (Sampler
			// settle-capture). Not armed when nothing was recorded (no
			// heading text): the settle-capture would overwrite an unrelated
			// top entry.
			this.state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;
		}
	};

	private pushIfNew(entry: NavHistoryEntry, force?: boolean) {
		const top = this.entries[this.index];
		// Same location = same file in the SAME tab (+ same jump key). Two
		// tabs of one file hold independent positions (tab-store is per-leaf),
		// so a leaf switch between them is a real step (VSCode records editor
		// identity, group included).
		if (!force && top && top.path === entry.path && top.leafId === entry.leafId
			&& top.viewType === entry.viewType
			&& (!entry.key || entry.key === top.key))
			return;
		this.push(entry);
	}

	private push(entry: NavHistoryEntry) {
		// A fresh jump discards the forward part (VSCode semantics).
		this.entries.length = this.index + 1;
		this.entries.push(entry);
		// Stack ceiling (settings.navStackCap); on overflow the OLDEST
		// entries drop. Clamp guards hand-edited data.json values.
		const cap = Math.max(1, Math.floor(this.settings.navStackCap));
		if (this.entries.length > cap)
			this.entries.splice(0, this.entries.length - cap);
		this.index = this.entries.length - 1;
	}

	// ===== Traversal =====

	canGoBack(): boolean {
		return this.index > 0;
	}

	canGoForward(): boolean {
		return this.index >= 0 && this.index < this.entries.length - 1;
	}

	// Command availability (checkCallback). An active file view is the normal
	// start; when a sidebar holds focus, traversal can still start from the
	// last file tab (see startLeaf).
	canNavigate(dir: -1 | 1): boolean {
		if (this.executing)
			return false;
		if (dir < 0 ? !this.canGoBack() : !this.canGoForward())
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
		if (dir < 0 ? !this.canGoBack() : !this.canGoForward())
			return;
		await this.runBracketed(() => this.traverse(dir));
	}

	// Time travel to an arbitrary entry (the history browser). Same bracket
	// as navigate. The jump is a fresh navigation (VSCode/IDEA record the
	// origin as a back step): the chosen entry is lifted to the stack top so
	// back returns to where the user was; the displaced middle stays in
	// place, walkable via back — nothing is truncated here. Clicking the
	// current row just re-lands (keyed entries re-apply their landing).
	async jumpTo(index: number): Promise<void> {
		if (index < 0 || index >= this.entries.length)
			return;
		await this.runBracketed(async () => {
			this.refreshTopFromActiveView();
			// Only feeds delegateNative's direction (command id + landing
			// verification); multi-step jumps never match the native stack's
			// next entry, so the value is a formality beyond ±1 hops.
			const dir: -1 | 1 = index > this.index ? 1 : -1;
			if (index !== this.index) {
				if (index !== this.entries.length - 1)
					this.entries.push(this.entries.splice(index, 1)[0]);
				this.index = this.entries.length - 1;
			}
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
			// The stack's current entry is a view step (graph active): there
			// is no file leaf to reactivate — traversal moves from it
			// directly.
			if (!this.entries[this.index]?.path) {
				this.index += dir;
				await this.execute(this.entries[this.index], dir);
				return;
			}
			// A sidebar (file explorer, search, outline…) can hold focus with
			// no file view active. The stack's current entry still describes
			// the last file tab — reactivate its leaf so traversal starts from
			// where the user actually was (this also restores focus, and the
			// unfocused editor keeps its cursor/scroll state readable).
			const startLeaf = this.startLeaf();
			if (!startLeaf)
				return;
			this.app.workspace.setActiveLeaf(startLeaf, { focus: true });
			activeView = this.app.workspace.getActiveViewOfType(FileView);
			if (!activeView?.file)
				return;
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
		if (cur && activeView?.file && cur.leafId === this.state.leafId(activeView.leaf)
			&& cur.path === activeView.file.path && activeView instanceof MarkdownView) {
			const st = readEphemeralState(activeView);
			if (st) this.refreshTop(cur.path, cur.leafId, st);
		}
	}

	private async execute(target: NavHistoryEntry, dir: -1 | 1) {
		const activeView = this.app.workspace.getActiveViewOfType(FileView);
		const activeLeaf = activeView?.leaf;
		const targetLeaf = this.findLeafById(target.leafId);

		// View step (graph tab): reaching it means the leaf must SHOW that
		// view — activate a different tab, and when the view was swapped
		// out (a graph node click opens the file over the graph in the same
		// leaf, or graph:open reuses the tab) re-assert it. A closed leaf
		// has nothing to return to — no-op (never the active tab's file).
		// (pathless ⟺ viewType set — one guard narrows both.)
		const viewStep = target.path ? undefined : target.viewType;
		if (viewStep) {
			const leaf = targetLeaf;
			if (!leaf)
				return;
			if (leaf !== activeLeaf)
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
			if (leaf.isDeferred)
				await leaf.loadIfDeferred();
			const viewType = (leaf.view as { getViewType?: () => string } | undefined)?.getViewType?.();
			if (viewType === viewStep)
				return;
			// The view was swapped out (a graph node click opens the file over
			// the graph in the same leaf, or graph:open reuses the tab): ride
			// the native per-tab history when its next entry IS the graph
			// (keeps the two stacks aligned), else re-assert the view directly.
			// A closed leaf falls through — never the active tab's file.
			if (leaf === activeLeaf && await this.delegateNative(dir, leaf, undefined, viewStep))
				return;
			await (leaf as unknown as {
				setViewState(vs: { type: string; state: object; active: boolean }): Promise<void>;
			}).setViewState({ type: viewStep, state: {}, active: true });
			return;
		}

		// Cross-tab: reactivate the original leaf (回到原 leaf). A closed
		// leaf falls back to the active one.
		if (targetLeaf && targetLeaf !== activeLeaf) {
			await this.openInLeaf(targetLeaf, target);
			return;
		}

		const leaf = targetLeaf ?? activeLeaf;
		if (!leaf)
			return;
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const curFile = (leaf.view as FileView | undefined)?.file;

		if (curFile?.path === target.path) {
			// In-file jump: no open, apply the entry's position directly.
			// Only markdown has positions (the entry's st is refreshed at
			// leave time); a same-file non-markdown entry is a no-op — the
			// view is already there. (leaf is the active leaf here — the
			// cross-tab case returned above.)
			if (activeView instanceof MarkdownView && target.st) {
				const isCurrent = () => activeView.file?.path === target.path;
				this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
				await this.modes.historyJumpApply(activeView, target.st, isCurrent);
			}
			return;
		}

		// Same-tab file switch: ride the native per-tab history when its next
		// entry matches (keeps PDF/canvas native), else open directly.
		if (await this.delegateNative(dir, leaf, target.path))
			return;
		await this.openInLeaf(leaf, target);
	}

	// Opens the target file in `leaf` (activating it first when it is a
	// different tab). The markdown open restores through the standard
	// injection pipeline from the per-file records; non-markdown opens rely
	// on each view's own position handling.
	private async openInLeaf(leaf: WorkspaceLeaf, target: NavHistoryEntry) {
		// View entries (graph) never route here — execute reactivates them.
		if (!target.path)
			return;
		if (this.app.workspace.getActiveViewOfType(FileView)?.leaf !== leaf)
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.isDeferred)
			await leaf.loadIfDeferred();
		const curFile = (leaf.view as FileView | undefined)?.file;
		if (curFile?.path === target.path)
			return;
		const file = this.app.vault.getAbstractFileByPath(target.path);
		if (file instanceof TFile) {
			// A traversal that opens directly (cross-tab, or the native
			// stack's next entry didn't match) must land instantly like the
			// delegated one: arm the same flag delegateNative uses, so the
			// setViewState patch injects the per-file record over the plain
			// open and bypasses the glide choice. The timeout clears it when
			// this open never reaches setViewState.
			this.state.pendingHistoryNav = true;
			this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
			window.clearTimeout(this.state.pendingHistoryNavTimeout);
			this.state.pendingHistoryNavTimeout = window.setTimeout(() => {
				this.state.pendingHistoryNav = false;
			}, HISTORY_NAV_TIMEOUT_MS);
			await leaf.openFile(file);
		}
	}

	// Delegates one step to the native per-tab history — but only when the
	// native stack's next entry IS the target — a file path, or a view type
	// for a view step (the graph) — so the two stacks can never disagree on
	// where a step lands (in-file jumps exist only on our stack, so
	// mismatches happen legitimately; those run openInLeaf/setViewState
	// instead). Returns whether the landing was verified.
	private async delegateNative(
		dir: -1 | 1,
		leaf: WorkspaceLeaf,
		targetPath: string | undefined,
		targetViewType?: string,
	): Promise<boolean> {
		const history = (leaf as unknown as { history?: NativeLeafHistory }).history;
		const stack = dir < 0 ? history?.backHistory : history?.forwardHistory;
		const top = stack?.[stack.length - 1];
		const matches = targetPath !== undefined
			? top?.state?.state?.file === targetPath
			: top?.state?.type === targetViewType;
		if (!matches)
			return false;

		// pendingHistoryNav arms the setViewState patch to inject this
		// plugin's saved position over the native entry's cursor-only
		// eState — markdown file steps only. A view step's setViewState
		// (graph) early-returns in the patch before the flag is read, so
		// arming it here would just leak 1s onto an unrelated later open.
		if (targetPath !== undefined) {
			this.state.pendingHistoryNav = true;
			this.state.cueSuppressUntil = Date.now() + NAV_CUE_SUPPRESS_MS;
			window.clearTimeout(this.state.pendingHistoryNavTimeout);
			this.state.pendingHistoryNavTimeout = window.setTimeout(() => {
				this.state.pendingHistoryNav = false;
			}, HISTORY_NAV_TIMEOUT_MS);
		}
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

	// ===== Bookkeeping =====

	renameFile(oldPath: string, newPath: string) {
		for (const entry of this.entries)
			if (entry.path === oldPath)
				entry.path = newPath;
	}

	deleteFile(path: string) {
		const kept: NavHistoryEntry[] = [];
		let removedBefore = 0;
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (entry.path === path) {
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

	// ===== Persistence (device-local, per vault — mirrors tab-store) =====

	private static storageKey(app: App): string {
		const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
		return `position-restore:nav-history:${appId}`;
	}

	private static load(app: App): { entries: NavHistoryEntry[]; index: number } {
		try {
			const raw = window.localStorage.getItem(NavHistory.storageKey(app));
			if (!raw)
				return { entries: [], index: -1 };
			const parsed = JSON.parse(raw) as { entries?: unknown; index?: unknown };
			const entries = Array.isArray(parsed.entries)
				? parsed.entries.filter(
					(e): e is NavHistoryEntry => {
						const entry = e as NavHistoryEntry;
						return !!e && (
							(typeof entry.path === 'string' && !!entry.path)
							|| (typeof entry.viewType === 'string' && !!entry.viewType));
					})
				: [];
			const index = typeof parsed.index === 'number'
				&& parsed.index >= -1 && parsed.index < entries.length
				? parsed.index
				: entries.length - 1;
			return { entries, index };
		} catch (e) {
			console.error('Position Restore: can not read navigation history:', e);
			return { entries: [], index: -1 };
		}
	}

	persist() {
		try {
			// entries is a plain array of plain objects — JSON-safe as is.
			const serialized = JSON.stringify({ entries: this.entries, index: this.index });
			if (serialized === this.lastPersisted)
				return;
			window.localStorage.setItem(NavHistory.storageKey(this.app), serialized);
			this.lastPersisted = serialized;
		} catch (e) {
			console.error('Position Restore: can not persist navigation history:', e);
		}
	}
}
