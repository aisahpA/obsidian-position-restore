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
import { NavHistoryView, activateNavHistoryView, createNavHistoryView } from '@/nav-history/browser/view';
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
		// Write the settings object out, for the preferences the browser changes from
		// the panel rather than from the settings tab. The plugin owns the file; this
		// facade is only allowed to ask.
		private save: () => void = () => {},
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
		// position before the browser renders so it is not a bare type badge.
		this.nav.syncCurrentPosition();
		new NavHistoryModal(this.app, this.nav, (path) => this.database.db[path], this.browserPrefs()).open();
	}

	// The resident form of the same browser (main.ts command) — see
	// NavHistoryView. Same history, same rows, standing in a sidebar instead of
	// asked and dismissed.
	openNavHistorySidebar() {
		// Same reason as the modal's: the panel draws the stack as it stands, and
		// the note being sat in has had no leave-refresh yet.
		this.nav.syncCurrentPosition();
		void activateNavHistoryView(this.app, this.nav, (path) => this.database.db[path], this.browserPrefs());
	}

	// The factory main.ts hands to Plugin.registerView: the view needs the
	// history, the saved positions and the browser's own preferences, all of
	// which this facade owns, so the wiring is handed out here rather than reached
	// for through it.
	navHistoryViewCreator(): (leaf: WorkspaceLeaf) => NavHistoryView {
		return createNavHistoryView(this.nav, (path) => this.database.db[path], this.browserPrefs());
	}

	// The preferences the history browser owns (see types.ts): read LIVE off the
	// shared settings object, so the dialog and the resident panel cannot hold
	// different opinions about them — and written back through the plugin's own save,
	// so a choice made in the panel outlives the panel, the dialog and the app run.
	// One new object per shell: the object is a set of readers over settings that stay
	// live, not a snapshot of them.
	private browserPrefs(): NavBrowserPrefs {
		return {
			previewMode: () => this.settings.navPreviewMode,
			setPreviewMode: (mode) => {
				this.settings.navPreviewMode = mode;
				this.save();
			},
			landings: () => this.settings.navLandings,
			setLandings: (how) => {
				this.settings.navLandings = how;
				this.save();
			},
			showDetails: () => this.settings.navShowDetails,
			setShowDetails: (on) => {
				this.settings.navShowDetails = on;
				this.save();
			},
		};
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
