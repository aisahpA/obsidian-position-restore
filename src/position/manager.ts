import { App, FileView, TAbstractFile, Platform, View, WorkspaceLeaf } from 'obsidian';
import { PluginSettings } from '@/types';
import { CursorPositionDatabase } from './storage/database';
import { PositionStore } from './storage/position-store';
import { PositionState } from './state';
import { BackgroundSettler } from './restore/background-settle';
import { Restorer } from './restore/restorer';
import { OpenPatcher } from './restore/patcher';
import { ExplorerPreviewFocus } from './hover/explorer-preview';
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

// Facade over the collaborating pieces, owned by the plugin; main.ts only talks to this class.
// Each method dispatches to the piece that owns the concern — nothing here holds state of its own.
// It is also the ONE place that knows both navigation stores: it wires the funnel to each and hands
// the place list the stack's open pipeline, so neither store imports the other. The cross-phase
// coordination flags live in the shared PositionState, so the collaborators never desync.
export class PositionManager {
	private app: App;
	private database: CursorPositionDatabase;
	private state: PositionState;
	private store: PositionStore;
	private restorer: Restorer;
	private patcher: OpenPatcher;
	private explorerPreview: ExplorerPreviewFocus;
	private sampler: Sampler;
	private backgroundSettler: BackgroundSettler;
	private funnel: NavFunnel;
	private stack: NavStack;
	private places: NavPlaces;
	private bookkeeper: PathBookkeeper;

	constructor(
		app: App,
		database: CursorPositionDatabase,
		// The one shared settings object (main.ts assigns it once, the settings tab mutates it in
		// place), kept as a field because the browser reads its preferences live off it.
		private settings: PluginSettings,
	) {
		this.app = app;
		this.database = database;
		this.state = new PositionState(settings);
		// The recording funnel first: both readers below need it.
		this.funnel = new NavFunnel(app, this.state);
		this.stack = new NavStack(app, settings, this.state, this.funnel, (path) => this.database.db[path]);
		this.places = new NavPlaces(app, settings);
		// The funnel's two listeners. The stack IS one; the place list keeps its own vocabulary
		// (places, not steps), so the port translation lives here.
		this.funnel.subscribe(this.stack);
		this.funnel.subscribe({
			onVisit: (recording) => this.places.remember(recording.record),
			onLanded: (entry) => this.places.settle(entry),
			onHere: (entry) => this.places.markCurrent(entry),
		});
		this.places.attach({
			openFile: (path, leafId, target) => this.stack.openFilePlain(path, leafId, target),
			openJump: (entry, target) => this.stack.travelTo(entry, target),
			openView: (entry, target) => this.stack.openViewPlace(entry, target),
		});
		this.store = new PositionStore(app, database);
		this.restorer = new Restorer(app, settings, this.store, this.state);
		this.sampler = new Sampler(app, this.store, settings, this.state, this.funnel);
		this.patcher = new OpenPatcher(app, settings, this.store, this.state, this.funnel, this.sampler);
		this.explorerPreview = new ExplorerPreviewFocus(app, database, settings);
		this.backgroundSettler = new BackgroundSettler(app, settings, this.store, this.state);
		this.bookkeeper = new PathBookkeeper(app, this.store, [this.stack, this.places], this.state);
	}

	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patcher.installPatches(registerCleanup);
		// Outline panel clicks as in-file nav jumps (reading mode — the one jump path the patches
		// and the poll cannot see). Silent no-op when the outline DOM can't be resolved.
		this.funnel.installOutlineCapture(registerCleanup);
		// Search anchor: armed by focus on a search input so search-driven jumps don't overwrite
		// the saved position. Platform-neutral: both the desktop and the mobile poll take the guard.
		this.sampler.installSearchAnchor(registerCleanup);
		// Frontmatter recording rules: drop a file's records the moment it opts out.
		this.sampler.installFrontmatterWatch(registerCleanup);
		if (Platform.isDesktopApp) {
			this.sampler.installScrollCapture(registerCleanup);
			// Desktop counterpart of the mobile touch listener: stamp user input so scroll capture
			// can tell real scrolls from programmatic movement.
			this.sampler.installUserIntentTracker(registerCleanup);
			// In-file jump detection at per-selection-event granularity (VSCode's 10-line
			// threshold) instead of the poll's 100ms quantization.
			this.sampler.installTeleportWatcher(registerCleanup);
		} else {
			// Mobile: no scroll capture (WKWebView drops the events), but the poll needs a
			// reliable "user touched the view" signal to tell real scrolls from passive reflow.
			this.sampler.installTouchListener(registerCleanup);
		}
	}

	// Where the app's OWN file list opens its hover preview. Own registration
	// rather than folded into installPatches: it changes no position and reads
	// none of the pipes the patches feed, and it stays answerable on its own if
	// the preview it points at is ever dropped.
	installExplorerPreview(registerCleanup: (fn: () => void) => void) {
		this.explorerPreview.install(registerCleanup);
	}

	restoreEphemeralState(): void {
		void this.restorer.restoreEphemeralState()
			.catch(e => console.error('Position Restore: restore failed:', e));
	}

	// 'active-leaf-change' completion for opens that never fired 'file-open' (background opens,
	// restart-restored tabs, same-file deferred-tab activations).
	completeInjectedRestore(leaf: WorkspaceLeaf | null): void {
		void this.restorer.completeInjectedRestore(leaf)
			.catch(e => console.error('Position Restore: complete injected restore failed:', e));
	}

	// Startup sweep for background split tabs whose open never fired 'file-open'. Bounded poll;
	// stops when no built leaf still needs work or the deadline passes.
	installBackgroundSettle(registerCleanup: (fn: () => void) => void) {
		this.backgroundSettler.start(registerCleanup);
	}

	// The 100ms tick. The view-state read below is NOT part of it: it rides a slower
	// tick of its own (see main.ts's registerPolling).
	sampleActiveView() {
		this.sampler.sampleActiveView();
	}

	// A view's state is not finished when the reader arrives in it: the built-in browser answers
	// getState with `{title, mode}` until the page has committed and the url it is on exists, and
	// the place list writes that same unfinished state over its own good one. Nothing re-reads it
	// until the reader leaves — which is never, for a tab closed straight after opening. So the
	// tick re-reads it and publishes the difference as a landing, through the same wire as the
	// leave-read (see funnel.ts's NavFunnelSink.onLanded), with both readers updating in place.
	//
	// Quiet on nearly every tick (the comparison is against what the step already holds) except for
	// a third-party view whose own getState is expensive: it is asked once per second while the
	// reader sits in it. Hence the order below — the two property reads answering "is this the
	// step?" come BEFORE isMainAreaLeaf, which walks the workspace's element tree.
	sampleActiveViewState(): void {
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
		// Closing a leaf fires no dedicated event, so dead records survive until the next fresh
		// open's prune. Prune at every persist point instead (quit, suspend flush, periodic flush).
		this.restorer.pruneStaleLeafIds();

		// The per-leaf overlay persists at the database's cadence rather than only at quit: it is
		// the only place a same-file-in-two-tabs split survives a restart. Deduped against its own
		// last blob, so an unchanged round is one stringify.
		this.store.persist();

		// Navigation stores ride the same persist points, each dirty-checked against its own last
		// written snapshot. Two independent calls: neither writes on the other's behalf.
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

	// Command availability for back/forward (checkCallback) — see NavStack.canNavigate.
	canNavigate(dir: -1 | 1): boolean {
		return this.stack.canNavigate(dir);
	}

	// The "Open recent files" modal (main.ts command) — see NavStack.travelTo.
	openRecentFilesModal() {
		new RecentFilesModal(this.app, this.places, (path) => this.database.db[path], this.browserPrefs()).open();
	}

	// The resident form of the same browser (main.ts command): same list, same rows, standing in a
	// sidebar instead of asked and dismissed.
	openRecentFilesSidebar() {
		void activateRecentFilesView(this.app, this.places, (path) => this.database.db[path], this.browserPrefs());
	}

	// The factory main.ts hands to Plugin.registerView: the view needs the place list, the saved
	// positions and the browser's preferences, all of which this facade owns.
	recentFilesViewCreator(): (leaf: WorkspaceLeaf) => RecentFilesView {
		return createRecentFilesView(this.places, (path) => this.database.db[path], this.browserPrefs());
	}

	// The preferences the browser draws by: read LIVE off the shared settings object, so the dialog
	// and the resident panel cannot hold different opinions, and a choice made in the settings tab
	// is in force on the next redraw of a panel already standing. READERS ONLY — the settings tab
	// writes and persists them itself, so there is no second writer to keep in step.
	private browserPrefs(): RecentFilesBrowserPrefs {
		return {
			landings: () => this.settings.recentFilesLandings,
			// How far back the list reaches; lowering it trims the list on the spot.
			placesCap: () => this.settings.recentFilesCap,
			// How much of a row's path the list prints, and on which side of the name: it decides
			// what the NEXT render prints.
			pathDisplay: () => this.settings.recentFilesPathDisplay,
			// Whether each row says how long ago it was last visited.
			rowTime: () => this.settings.recentFilesRowTime,
			// What a row calls the note: the reader's own frontmatter property
			// where they named one, the file's name everywhere else.
			titleProperty: () => this.settings.recentFilesTitleProperty,
			// Where a hover opens the note a row stands for (see PreviewFocusMode). Nothing is
			// drawn from it, so it takes effect on the next hover rather than the next redraw —
			// which is why it owes no repaint (see BROWSER_PREF_KEYS in settings/tab.ts).
			previewFocus: () => this.settings.recentFilesPreviewFocus,
		};
	}

	// A preference the reader just changed while a panel may be standing open beside the page they
	// are looking at. The panel reads those preferences live (see browserPrefs), so nothing has to
	// be rebuilt or re-wired — only drawn again.
	refreshNavPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(RECENT_FILES_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof RecentFilesView)
				view.refresh();
		}
	}

	// Tab/pane activation records a nav entry (VSCode semantics).
	recordActivation(leaf: WorkspaceLeaf | null): void {
		this.funnel.recordActivation(leaf);
	}

	// True while a search session is live. main.ts checks this before recording paths outside the
	// poll, e.g. the suspend flush.
	isSearchAnchored() {
		return this.state.isSearchAnchored();
	}

	// Vault 'rename' — every path-keyed record moves with the file.
	renameFile(file: TAbstractFile, oldPath: string) {
		this.bookkeeper.renameFile(file, oldPath);
	}

	// Vault 'delete' — a scheduled prune, never an immediate one: the vault reports the same event
	// for a sync plugin's remove-then-rename replacement, whose undo arrives a moment later.
	deleteFile(file: TAbstractFile) {
		this.bookkeeper.deleteFile(file);
	}

	// Startup sweep for the navigation stores: files deleted while Obsidian was closed fire no
	// 'delete' event, so their entries would hold slots in the caps for good. The position records
	// are deliberately left alone.
	sweepMissingHistory() {
		this.bookkeeper.sweepMissingHistory();
	}

	// The stack's ceiling changed: apply it to the stack already in memory instead of waiting for
	// the next navigation to drop a large chunk at once.
	applyNavHistoryCap(): void {
		this.stack.applyStackCap();
	}

	// One of the list's own rules changed — a folder or frontmatter property added to "do not
	// list". A place the reader can no longer be shown must not keep a slot in a capped list until
	// they happen to revisit it, and the drop has to land while they are looking at the setting.
	applyRecentFilesExclusions(): void {
		if (this.places.pruneExcluded() > 0)
			this.places.applyCap();
	}

	// The list's ceiling changed: trimmed at once, so the reader sees the ceiling they just set.
	// Called by the settings tab and by an external write (data.json edited by hand, a sync
	// landing), so every writer comes through here.
	//
	// The ceiling counts NOTES, so what it owes is one number's worth of trimming and nothing else.
	//
	// The landings setting is deliberately NOT in this table: it stops or starts RECORDING, which
	// the list answers on the next navigation (NavPlaces.recordsJumps) rather than a consequence to
	// re-apply, and it leaves what was already recorded alone.
	applyRecentFilesCap(): void {
		this.places.applyCap();
	}

	// Every setting in `before` that differs from the current one has its derived consequence
	// applied. This IS the dispatch — one copy of it. A write from the settings tab arrives here
	// too, carrying the snapshot the tab took before it wrote, so the consequences don't have to be
	// repeated per caller. `before` is a copy taken off the settings object immediately before it
	// was overwritten in place, which is also the only form an EXTERNAL write can arrive in:
	// data.json names no keys, so comparing is the one thing both callers have in common.
	//
	// Repainting an open panel is deliberately NOT in here: every panel reads its preferences live
	// (see browserPrefs), so nothing needs recomputing — it is a view asked to draw again, and only
	// the settings tab knows a reader just changed one of those preferences in front of a panel.
	applyChangedSettings(before: PluginSettings): void {
		if (this.settings.navHistoryCap !== before.navHistoryCap)
			this.applyNavHistoryCap();
		if (this.settings.recentFilesCap !== before.recentFilesCap)
			this.applyRecentFilesCap();
		if (!sameList(this.settings.recentFilesExcludeFolders, before.recentFilesExcludeFolders)
			|| !sameList(this.settings.recentFilesExcludeProperties, before.recentFilesExcludeProperties))
			this.applyRecentFilesExclusions();
		if (!sameList(this.settings.excludedFolders, before.excludedFolders)
			|| !sameList(this.settings.frontmatterExcludeProperties, before.frontmatterExcludeProperties))
			this.prunePositions();
	}

	// Prune the records the current settings exclude (and, incidentally, the ones over the entry
	// cap). Routed through the store so the file layer and the leaf layer are pruned together.
	prunePositions(): number {
		return this.store.pruneDatabase();
	}
}

// Element-wise equality for the string-list settings: a fresh array is built by every JSON.parse,
// so identity comparison would report "changed" on every external write and re-run the prune.
function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
