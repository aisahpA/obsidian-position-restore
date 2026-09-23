import { App, FileView, TAbstractFile, Platform, View, WorkspaceLeaf } from 'obsidian';
import { PluginSettings } from '@/types';
import { CursorPositionDatabase } from './storage/database';
import { PositionStore } from './storage/position-store';
import { PositionState } from './state';
import { BackgroundSettler } from './restore/background-settle';
import { Restorer } from './restore/restorer';
import { OpenPatcher } from './restore/patcher';
import { Sampler } from './capture/sampler';
import { NavFunnel } from '@/nav/funnel';
import { NavStack } from '@/nav-history/stack';
import { NavPlaces } from '@/recent-files/places';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { RecentFilesBrowserPrefs } from '@/recent-files/browser/body';
import {
	RECENT_FILES_VIEW_TYPE,
	RecentFilesView,
	activateRecentFilesView,
	createRecentFilesView,
} from '@/recent-files/browser/view';
import { PathBookkeeper } from './path-bookkeeping';
import { isRecordableViewType } from '@/nav/entry';
import { isMainAreaLeaf, viewIcon, viewLabel, viewState } from '@/shared/leaf';

// Thin facade over the collaborating pieces, owned by the plugin:
//  - OpenPatcher: installs the setViewState/openLinkText patches and injects
//    saved positions into opens.
//  - Sampler: the polling-loop observer plus scroll listener that persists
//    position changes (see capture/sampler.ts).
//  - Restorer: restores a saved position after an open.
//  - NavFunnel: the neutral recording funnel (one navigation, several readers)
//    — the capture points write to it: the setViewState patch, the poll, the
//    outline panel, active-leaf-change.
//  - NavStack: the VSCode-style back/forward stack (executes through the native
//    per-tab history) — one of the funnel's listeners, and the open pipeline
//    the recent-files list travels through.
//  - NavPlaces: the recent-files list — the funnel's other listener, keeping a
//    list of PLACES instead of steps.
//  - PathBookkeeper: the path-keyed bookkeeping for the vault's rename/delete
//    events — which records move, which are dropped, and why a delete has to be
//    deferred before it can be dropped (see path-bookkeeping.ts).
// All cross-phase coordination flags live in the shared PositionState, so the
// collaborators never desync. main.ts only talks to this class. Nothing here
// owns state of its own beyond the collaborators: a method dispatches to the
// piece that owns the concern. This is also the ONE place that knows both
// navigation stores — it wires the funnel to each and hands the place list the
// stack's open pipeline — so neither store has to import the other.
export class PositionManager {
	private app: App;
	private database: CursorPositionDatabase;
	private state: PositionState;
	private store: PositionStore;
	private restorer: Restorer;
	private patcher: OpenPatcher;
	private sampler: Sampler;
	private backgroundSettler: BackgroundSettler;
	private funnel: NavFunnel;
	private stack: NavStack;
	private places: NavPlaces;
	private bookkeeper: PathBookkeeper;

	constructor(
		app: App,
		database: CursorPositionDatabase,
		// The one shared settings object (main.ts assigns it once, the settings tab
		// mutates it in place). Kept as a field because the recent-files browser reads its
		// own preferences live off it (see browserPrefs).
		private settings: PluginSettings,
	) {
		this.app = app;
		this.database = database;
		this.state = new PositionState(settings);
		// The recording funnel first: both readers below need it. The capture
		// points write to it (the setViewState patch and the poll through their
		// owners, the outline panel and active-leaf-change through the funnel's
		// own API); the stack and the place list subscribe.
		this.funnel = new NavFunnel(app, this.state);
		this.stack = new NavStack(app, settings, this.state, this.funnel, (path) => this.database.db[path]);
		this.places = new NavPlaces(app, settings);
		// The funnel's two listeners. The stack IS one (it keeps steps); the
		// place list keeps its own vocabulary (remember/settle/markCurrent —
		// places, not steps), so the port translation lives HERE, in the one
		// place that knows both. Neither store imports the other.
		this.funnel.subscribe(this.stack);
		this.funnel.subscribe({
			onVisit: (recording) => this.places.remember(recording.record),
			onLanded: (entry) => this.places.settle(entry),
			onHere: (entry) => this.places.markCurrent(entry),
		});
		// The place list travels through the stack's open pipeline, but the two
		// speak different words (openJump/openView/openFile vs travelTo/
		// openViewPlace/openFilePlain), so this adapter is written here too.
		this.places.attach({
			openFile: (path, leafId, target) => this.stack.openFilePlain(path, leafId, target),
			openJump: (entry, target) => this.stack.travelTo(entry, target),
			openView: (entry, target) => this.stack.openViewPlace(entry, target),
		});
		this.store = new PositionStore(app, database);
		this.restorer = new Restorer(app, settings, this.store, this.state);
		this.sampler = new Sampler(app, this.store, settings, this.state, this.funnel);
		this.patcher = new OpenPatcher(app, settings, this.store, this.state, this.funnel, this.sampler);
		this.backgroundSettler = new BackgroundSettler(app, settings, this.store, this.state);
		this.bookkeeper = new PathBookkeeper(app, this.store, [this.stack, this.places], this.state);
	}

	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patcher.installPatches(registerCleanup);
		// Outline panel clicks as in-file nav jumps (reading mode — the one
		// jump path the patches and the poll cannot see). Silent no-op when
		// the outline DOM can't be resolved.
		this.funnel.installOutlineCapture(registerCleanup);
		// Search anchor: armed by focus on a search input (editor find,
		// switcher, search panel) so search-driven jumps don't overwrite the
		// saved position — see Sampler.installSearchAnchor. Platform-neutral:
		// both the desktop and the mobile poll take the guard.
		this.sampler.installSearchAnchor(registerCleanup);
		// Frontmatter recording rules: keep the exclusion memo in sync with
		// metadata re-parses and drop records the moment a file opts out.
		this.sampler.installFrontmatterWatch(registerCleanup);
		if (Platform.isDesktopApp) {
			this.sampler.installScrollCapture(registerCleanup);
			// Desktop counterpart of the mobile touch listener: stamp user
			// input so scroll capture can tell real scrolls from programmatic
			// movement (see Sampler.installUserIntentTracker).
			this.sampler.installUserIntentTracker(registerCleanup);
			// In-file jump detection at per-selection-event granularity
			// (VSCode's 10-line threshold) instead of the poll's 100ms
			// quantization — see Sampler.installTeleportWatcher.
			this.sampler.installTeleportWatcher(registerCleanup);
		} else {
			// Mobile: no scroll capture (WKWebView drops the events), but the
			// poll needs a reliable "user touched the view" signal to tell
			// real scrolls from passive reflow — see Sampler.installTouchListener.
			this.sampler.installTouchListener(registerCleanup);
		}
	}

	restoreEphemeralState(): void {
		void this.restorer.restoreEphemeralState()
			.catch(e => console.error('Position Restore: restore failed:', e));
	}

	// 'active-leaf-change' completion for opens that never fired 'file-open'
	// (background opens, restart-restored tabs, same-file deferred-tab
	// activations) — see Restorer.completeInjectedRestore.
	completeInjectedRestore(leaf: WorkspaceLeaf | null): void {
		void this.restorer.completeInjectedRestore(leaf)
			.catch(e => console.error('Position Restore: complete injected restore failed:', e));
	}

	// Startup sweep for background split tabs whose open never fired
	// 'file-open' — see BackgroundSettler.start / completeBackgroundRestores.
	// Bounded poll; stops when no built leaf still needs work or the deadline
	// passes.
	installBackgroundSettle(registerCleanup: (fn: () => void) => void) {
		this.backgroundSettler.start(registerCleanup);
	}

	sampleActiveView() {
		this.sampler.sampleActiveView();
		this.sampleActiveViewState();
	}

	// The poll keeps the CURRENT STEP's view state true, the way the sampler's tick
	// keeps a file's position true — and this is the only place that can: it takes
	// asking the stack what the reader is standing on, which is a question about
	// both stores.
	//
	// It exists because a view's state is not finished when the reader arrives in
	// it. The built-in browser is the case that shows it: it answers getState with
	// `{title, mode}` until its page has actually committed and the url it is on
	// exists (Obsidian's WebviewerView only carries `url` once it has navigated),
	// so the step pushed by that activation holds a state with no idea WHERE the
	// place is — and the place list writes that same state over its own good one.
	// Nothing else reads it again until the reader leaves, which is exactly the
	// moment a tab they closed straight after opening never gets to. So the tick
	// re-reads it, and publishes the difference as a landing: the same fact the
	// leave-read publishes, through the same wire, with both readers updating in
	// place (see funnel.ts's NavFunnelSink.onLanded).
	//
	// Quiet when nothing moved, which is nearly every tick: the comparison is
	// against what the step already HOLDS, so no view-state bookkeeping is kept
	// here and no field had to be added to this class. A view that reports no state
	// at all is left alone (the global graph), and one that is not the current step
	// is not this tick's business (its own leave-read has it).
	//
	// Cost, measured on this machine through the tick it rides on (a realistic
	// web-viewer state, ~80 bytes): 0.04µs per tick while a note is the active
	// view — the branch never gets past `instanceof FileView` — and 2.1µs per tick
	// while the reader is standing IN the step's view, most of it the state read's
	// JSON round trip (stringify 0.4µs + parse 0.5µs). Against this poll's 100ms
	// interval that is 0.002% of one tick, which is why the cadence is not what
	// this branch's cost argues about. The one thing that cannot be bounded here is
	// a third-party view whose own getState is expensive: it is asked every tick
	// while the reader sits in it (the ceiling in shared/leaf.ts's viewState bounds
	// what may be STORED, not what it costs to ask). The order below is part of
	// keeping that rare: the two property reads that answer "is this the step?" come
	// BEFORE isMainAreaLeaf, which walks the workspace's element tree — so a view
	// that merely holds the focus (a sidebar panel, a view the reader reached
	// without recording) is answered without touching the DOM or the view.
	private sampleActiveViewState(): void {
		if (!this.funnel.isRecording())
			return;
		const view = this.app.workspace.getActiveViewOfType(View);
		if (!view || view instanceof FileView)
			return;
		const viewType = view.getViewType();
		if (!isRecordableViewType(viewType))
			return;
		const top = this.stack.entries[this.stack.index];
		if (!top || top.kind !== 'view' || top.viewType !== viewType)
			return;
		if (!isMainAreaLeaf(this.app, view.leaf))
			return;
		const state = viewState(view);
		if (!state || JSON.stringify(state) === JSON.stringify(top.state))
			return;
		this.funnel.landing({
			kind: 'view', leafId: top.leafId, viewType, state,
			label: viewLabel(view), icon: viewIcon(view),
		});
	}

	storePositionData() {
		// Closing a leaf can't update the stored leaf records (no dedicated
		// close event), so dead records survive until the next fresh open's
		// prune. Prune at every persist point instead — quit, suspend flush,
		// and the periodic flush all funnel here.
		this.restorer.pruneStaleLeafIds();

		// The per-leaf overlay rides the same persist points, and it persists
		// at the same cadence as the database rather than only at quit: it is
		// the only place a same-file-in-two-tabs split survives a restart, so
		// holding it in memory until quit lost it to a crash. It dedups its own
		// writes against the last blob, so an unchanged round is one stringify.
		this.store.persist();

		// Navigation stores ride the same persist points (each dirty-checked
		// against its own last written snapshot, so an unchanged round costs one
		// stringify). Two independent calls: the stack keeps steps, the list
		// keeps places, and neither writes on the other's behalf.
		this.stack.persist();
		this.places.persist();

		void this.database.writeDb();
	}

	// Navigate back/forward through the recorded jump history (VSCode-style).
	navigateBack() {
		void this.stack.navigate(-1)
			.catch(e => console.error('Position Restore: navigate back failed:', e));
	}

	navigateForward() {
		void this.stack.navigate(1)
			.catch(e => console.error('Position Restore: navigate forward failed:', e));
	}

	// Command availability for back/forward (checkCallback). True also when a
	// sidebar holds focus but the last file tab can be reactivated — see
	// NavStack.canNavigate.
	canNavigate(dir: -1 | 1): boolean {
		return this.stack.canNavigate(dir);
	}

	// The "Open recent files" modal (main.ts command) — see
	// RecentFilesModal / NavStack.travelTo.
	openRecentFilesModal() {
		new RecentFilesModal(this.app, this.places, (path) => this.database.db[path], this.browserPrefs()).open();
	}

	// The resident form of the same browser (main.ts command) — see
	// RecentFilesView. Same list, same rows, standing in a sidebar instead of
	// asked and dismissed.
	openRecentFilesSidebar() {
		void activateRecentFilesView(this.app, this.places, (path) => this.database.db[path], this.browserPrefs());
	}

	// The factory main.ts hands to Plugin.registerView: the view needs the
	// place list, the saved positions and the browser's own preferences, all of
	// which this facade owns, so the wiring is handed out here rather than reached
	// for through it.
	recentFilesViewCreator(): (leaf: WorkspaceLeaf) => RecentFilesView {
		return createRecentFilesView(this.places, (path) => this.database.db[path], this.browserPrefs());
	}

	// The preferences the recent-files browser draws by (see types.ts): read LIVE off the
	// shared settings object, so the dialog and the resident panel cannot hold
	// different opinions about them, and a choice made in the settings tab is in
	// force on the next redraw of a panel that is already standing. READERS ONLY —
	// the values are written by the settings tab, which persists them itself (see
	// SettingTab.setControlValue), so there is no second writer to keep in step.
	// One new object per shell: the object is a set of readers over settings that stay
	// live, not a snapshot of them.
	private browserPrefs(): RecentFilesBrowserPrefs {
		return {
			landings: () => this.settings.recentFilesLandings,
			// How far back the recent-files list reaches (see
			// SettingTab.setControlValue: lowering it trims the list on the spot).
			placesCap: () => this.settings.recentFilesCap,
			// How much of a row's path the list prints, and on which side of the
			// name (see PathDisplayMode): it decides what the NEXT render prints.
			pathDisplay: () => this.settings.recentFilesPathDisplay,
			// Whether each row says how long ago it was last visited: a label the
			// next render adds or leaves off.
			rowTime: () => this.settings.recentFilesRowTime,
		};
	}

	// A preference the reader just changed in the settings tab, while a panel may be
	// standing open beside the page they are looking at. The panel reads those
	// preferences live (see browserPrefs), so nothing has to be rebuilt or re-wired —
	// it only has to be drawn again, which is what this asks every resident panel to
	// do. A panel that is not open is simply not there to ask.
	refreshNavPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(RECENT_FILES_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof RecentFilesView)
				view.refresh();
		}
	}

	// Tab/pane activation records a nav entry (VSCode semantics) — see
	// NavFunnel.recordActivation.
	recordActivation(leaf: WorkspaceLeaf | null): void {
		this.funnel.recordActivation(leaf);
	}

	// True while a search session is live (a search input holds, or just
	// released, focus — see Sampler.installSearchAnchor). main.ts checks this
	// before recording paths outside the poll, e.g. the suspend flush.
	isSearchAnchored() {
		return this.state.isSearchAnchored();
	}

	// Vault 'rename' — every path-keyed record moves with the file (see
	// PathBookkeeper).
	renameFile(file: TAbstractFile, oldPath: string) {
		this.bookkeeper.renameFile(file, oldPath);
	}

	// Vault 'delete' — a scheduled prune, never an immediate one: the vault
	// reports the same event for a sync plugin's remove-then-rename
	// replacement, whose undo arrives a moment later (see PathBookkeeper).
	deleteFile(file: TAbstractFile) {
		this.bookkeeper.deleteFile(file);
	}

	// Startup sweep for the navigation stores: files deleted while Obsidian was
	// closed fire no 'delete' event, so their entries would sit in the stack and
	// the recent-files list as dead rows (holding slots in their caps) for good.
	// The navigation stores only — the position records are deliberately left
	// alone (see PathBookkeeper).
	sweepMissingHistory() {
		this.bookkeeper.sweepMissingHistory();
	}

	// The history stack's ceiling changed in the settings: apply it to the
	// stack already in memory instead of waiting for the next navigation to
	// drop a large chunk at once (see NavStack.applyStackCap).
	applyNavHistoryCap(): void {
		this.stack.applyStackCap();
	}

	// One of the recent-files list's own rules changed — a folder added to the
	// "do not list" list, or a frontmatter property: drop the places the new
	// rule excludes. A place the reader can no longer be shown must not keep a
	// slot in a capped list until they happen to revisit it — and the drop has to
	// happen while they are looking at the setting they just changed.
	applyRecentFilesExclusions(): void {
		if (this.places.pruneExcluded() > 0)
			this.places.applyCap();
	}

	// The recent-files list's ceiling changed: the list in memory is trimmed at
	// once, so the reader sees the ceiling they just set rather than discovering
	// it on the next open. Called by the settings tab and by an external write
	// (data.json edited by hand, a sync landing) — the panel no longer carries a
	// second copy of the knob, so every writer comes through here.
	//
	// The ceiling counts NOTES, so what it owes is one number's worth of
	// trimming and nothing else: no other setting changes what a note is.
	//
	// The landings setting is deliberately NOT in this table at all — see
	// RecentFilesBrowserPrefs: it stops or starts RECORDING, which is a
	// question the list answers on the next navigation (NavPlaces.recordsJumps)
	// rather than a consequence to re-apply, and it leaves what was already
	// recorded alone.
	applyRecentFilesCap(): void {
		this.places.applyCap();
	}

	// Every setting in `before` that differs from the current one has its
	// derived consequence applied. This IS the dispatch — there is one copy of
	// it. A write from the settings tab arrives here too, carrying the snapshot
	// the tab took before it wrote (see SettingTab.setControlValue), so the list
	// of consequences does not have to be repeated per caller. `before` is a
	// copy taken off the settings object immediately before it was overwritten
	// in place, which is also the only form an EXTERNAL write can arrive in:
	// data.json names no keys, so comparing is the one thing both callers have
	// in common.
	//
	// Repainting an open recent-files panel is deliberately NOT in here. It is
	// not state these stores hold — every panel reads its preferences live (see
	// browserPrefs), so nothing needs recomputing — it is a view asked to draw
	// again, and only the settings tab knows a reader just changed one of those
	// preferences in front of a panel (see its BROWSER_PREF_KEYS).
	applyChangedSettings(before: PluginSettings): void {
		if (this.settings.navHistoryCap !== before.navHistoryCap)
			this.applyNavHistoryCap();
		if (this.settings.recentFilesCap !== before.recentFilesCap)
			this.applyRecentFilesCap();
		// The landings setting is not here: it changes what is recorded from
		// now on and what the panel draws, and neither is state a store
		// holds (see applyRecentFilesCap) — the reader's next jump is
		// answered by the setting as it stands, and a panel reads it live.
		// Both of the list's own rules: which folders, and which frontmatter, it
		// refuses. One prune answers either (see NavPlaces.pruneExcluded).
		if (!sameList(this.settings.recentFilesExcludeFolders, before.recentFilesExcludeFolders)
			|| !sameList(this.settings.recentFilesExcludeProperties, before.recentFilesExcludeProperties))
			this.applyRecentFilesExclusions();
		// The cache is keyed by path and holds answers that the excluded-folder
		// and frontmatter rules were consulted to produce, so a change to either
		// rule invalidates it wholesale (see Sampler.clearExclusionCache).
		if (!sameList(this.settings.excludedFolders, before.excludedFolders)
			|| !sameList(this.settings.frontmatterExcludeProperties, before.frontmatterExcludeProperties)) {
			this.clearExclusionCache();
			this.prunePositions();
		}
	}

	// Prune the records the current settings exclude (and, incidentally, the
	// ones over the entry cap). Routed through the store so the file layer and
	// the leaf layer are pruned together — main.ts's startup sweep and the
	// settings panel both come here.
	prunePositions(): number {
		return this.store.pruneDatabase();
	}

	clearExclusionCache() {
		this.sampler.clearExclusionCache();
	}
}

// Element-wise equality for the string-list settings. A fresh array is built by
// every JSON.parse, so identity comparison would report "changed" on every
// external write and re-run the prune each time.
function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
