import { App, TAbstractFile, Platform, WorkspaceLeaf } from 'obsidian';
import { PluginSettings } from '@/types';
import { CursorPositionDatabase } from './storage/database';
import { PositionStore } from './storage/position-store';
import { PositionState } from './state';
import { BackgroundSettler } from './restore/background-settle';
import { Restorer } from './restore/restorer';
import { OpenPatcher } from './restore/patcher';
import { Sampler } from './capture/sampler';
import { NavHistory } from '@/nav-history/history';
import { NavHistoryModal } from '@/nav-history/browser/modal';
import type { NavBrowserPrefs } from '@/nav-history/browser/body';
import {
	NAV_HISTORY_VIEW_TYPE,
	NavHistoryView,
	activateNavHistoryView,
	createNavHistoryView,
} from '@/nav-history/browser/view';
import { PathBookkeeper } from './path-bookkeeping';

// Thin facade over the collaborating pieces, owned by the plugin:
//  - OpenPatcher: installs the setViewState/openLinkText patches and injects
//    saved positions into opens.
//  - Sampler: the polling-loop observer plus scroll listener that persists
//    position changes (see capture/sampler.ts).
//  - Restorer: restores a saved position after an open.
//  - NavHistory: the VSCode-style back/forward stack (records via the patch
//    and the poll, executes through the native per-tab history).
//  - PathBookkeeper: the path-keyed bookkeeping for the vault's rename/delete
//    events — which records move, which are dropped, and why a delete has to be
//    deferred before it can be dropped (see path-bookkeeping.ts).
// All cross-phase coordination flags live in the shared PositionState, so the
// collaborators never desync. main.ts only talks to this class. Nothing here
// owns state of its own beyond the collaborators: a method dispatches to the
// piece that owns the concern.
export class PositionManager {
	private app: App;
	private database: CursorPositionDatabase;
	private state: PositionState;
	private store: PositionStore;
	private restorer: Restorer;
	private patcher: OpenPatcher;
	private sampler: Sampler;
	private backgroundSettler: BackgroundSettler;
	private nav: NavHistory;
	private bookkeeper: PathBookkeeper;

	constructor(
		app: App,
		database: CursorPositionDatabase,
		// The one shared settings object (main.ts assigns it once, the settings tab
		// mutates it in place). Kept as a field because the history browser reads its
		// own preferences live off it (see browserPrefs).
		private settings: PluginSettings,
	) {
		this.app = app;
		this.database = database;
		this.state = new PositionState(settings);
		this.nav = new NavHistory(app, settings, this.state, (path) => this.database.db[path]);
		this.store = new PositionStore(app, database);
		this.restorer = new Restorer(app, settings, this.store, this.state);
		this.sampler = new Sampler(app, this.store, settings, this.state, this.nav);
		this.patcher = new OpenPatcher(app, settings, this.store, this.state, this.nav, this.sampler);
		this.backgroundSettler = new BackgroundSettler(app, settings, this.store, this.state);
		this.bookkeeper = new PathBookkeeper(app, this.store, this.nav, this.state);
	}

	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patcher.installPatches(registerCleanup);
		// Outline panel clicks as in-file nav jumps (reading mode — the one
		// jump path the patches and the poll cannot see). Silent no-op when
		// the outline DOM can't be resolved.
		this.nav.installOutlineCapture(registerCleanup);
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

		// Navigation history rides the same persist points (dirty-checked
		// against the last written snapshot, so unchanged rounds cost one
		// stringify).
		this.nav.persist();

		void this.database.writeDb();
	}

	// Navigate back/forward through the recorded jump history (VSCode-style).
	navigateBack() {
		void this.nav.navigate(-1)
			.catch(e => console.error('Position Restore: navigate back failed:', e));
	}

	navigateForward() {
		void this.nav.navigate(1)
			.catch(e => console.error('Position Restore: navigate forward failed:', e));
	}

	// Command availability for back/forward (checkCallback). True also when a
	// sidebar holds focus but the last file tab can be reactivated — see
	// NavHistory.canNavigate.
	canNavigate(dir: -1 | 1): boolean {
		return this.nav.canNavigate(dir);
	}

	// "Browse navigation history" modal (main.ts command) — see
	// NavHistoryModal / NavHistory.jumpTo.
	openNavHistoryModal() {
		// The file you are sitting in has had no leave-refresh yet — fill its
		// position, and make sure it has a place on the list, before the browser
		// renders.
		this.nav.syncCurrentPosition();
		new NavHistoryModal(this.app, this.nav.places, (path) => this.database.db[path], this.browserPrefs()).open();
	}

	// The resident form of the same browser (main.ts command) — see
	// NavHistoryView. Same history, same rows, standing in a sidebar instead of
	// asked and dismissed.
	openNavHistorySidebar() {
		// Same reason as the modal's: the panel draws the list as it stands, and
		// the note being sat in may have no place on it yet.
		this.nav.syncCurrentPosition();
		void activateNavHistoryView(this.app, this.nav.places, (path) => this.database.db[path], this.browserPrefs());
	}

	// The factory main.ts hands to Plugin.registerView: the view needs the
	// history, the saved positions and the browser's own preferences, all of
	// which this facade owns, so the wiring is handed out here rather than reached
	// for through it.
	navHistoryViewCreator(): (leaf: WorkspaceLeaf) => NavHistoryView {
		return createNavHistoryView(this.nav.places, (path) => this.database.db[path], this.browserPrefs());
	}

	// The preferences the history browser draws by (see types.ts): read LIVE off the
	// shared settings object, so the dialog and the resident panel cannot hold
	// different opinions about them, and a choice made in the settings tab is in
	// force on the next redraw of a panel that is already standing. READERS ONLY —
	// the values are written by the settings tab, which persists them itself (see
	// SettingTab.setControlValue), so there is no second writer to keep in step.
	// One new object per shell: the object is a set of readers over settings that stay
	// live, not a snapshot of them.
	private browserPrefs(): NavBrowserPrefs {
		return {
			landings: () => this.settings.navLandings,
			// How far back the recent-files list reaches (see
			// SettingTab.setControlValue: lowering it trims the list on the spot).
			placesCap: () => this.settings.navRecentCap,
			// How much of a row's path the list prints, and on which side of the
			// name (see PathDisplayMode): it decides what the NEXT render prints.
			pathDisplay: () => this.settings.navPathDisplay,
			// Whether each row says how long ago it was last visited: a label the
			// next render adds or leaves off.
			rowTime: () => this.settings.navRowTime,
		};
	}

	// A preference the reader just changed in the settings tab, while a panel may be
	// standing open beside the page they are looking at. The panel reads those
	// preferences live (see browserPrefs), so nothing has to be rebuilt or re-wired —
	// it only has to be drawn again, which is what this asks every resident panel to
	// do. A panel that is not open is simply not there to ask.
	refreshNavPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(NAV_HISTORY_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof NavHistoryView)
				view.refresh();
		}
	}

	// Tab/pane activation records a nav entry (VSCode semantics) — see
	// NavHistory.recordActivation.
	recordActivation(leaf: WorkspaceLeaf | null): void {
		this.nav.recordActivation(leaf);
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

	// Startup sweep for navigation history: files deleted while Obsidian was
	// closed fire no 'delete' event, so their entries would sit in the browser
	// as dead rows (holding slots in the capped stack) for good. History only —
	// the position records are deliberately left alone (see PathBookkeeper).
	sweepMissingHistory() {
		this.bookkeeper.sweepMissingHistory();
	}

	// The history stack's ceiling changed in the settings: apply it to the
	// stack already in memory instead of waiting for the next navigation to
	// drop a large chunk at once (see NavHistory.applyStackCap).
	applyNavStackCap(): void {
		this.nav.applyStackCap();
	}

	// The recent-files list's own folder rule changed: drop the places the new
	// rule excludes. A place the reader can no longer be shown must not keep a
	// slot in a capped list until they happen to revisit it — and the drop has to
	// happen while they are looking at the setting they just changed.
	applyNavRecentFolders(): void {
		if (this.nav.places.pruneExcluded() > 0)
			this.nav.places.applyCap();
	}

	// Throw the recent-files list away, and stand it up again on the note being read
	// (main.ts's "clear recent files" command). The panel follows both halves through
	// its subscription: the rows go, and the one note the reader is actually in comes
	// back as the first of them.
	clearRecentPlaces(): void {
		this.nav.places.clear();
		this.nav.syncCurrentPosition();
	}

	// The recent-files list's ceiling changed: the list in memory is trimmed at
	// once, so the reader sees the ceiling they just set rather than discovering
	// it on the next open. Called by the settings tab and by an external write
	// (data.json edited by hand, a sync landing) — the panel no longer carries a
	// second copy of the knob, so every writer comes through here.
	applyNavRecentCap(): void {
		this.nav.places.applyCap();
	}

	// Every setting in `before` that differs from the current one has its
	// derived consequence applied — the same dispatch as SettingTab's
	// setControlValue, keyed on a diff instead of on the key that was touched.
	// `before` is what main.ts copied off the settings object immediately
	// before overwriting it in place; an external write names no keys, so
	// comparing is the only way to know what to re-apply.
	applyChangedSettings(before: PluginSettings): void {
		if (this.settings.navStackCap !== before.navStackCap)
			this.applyNavStackCap();
		if (this.settings.navRecentCap !== before.navRecentCap)
			this.applyNavRecentCap();
		if (!sameList(this.settings.navRecentExcludeFolders, before.navRecentExcludeFolders))
			this.applyNavRecentFolders();
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
