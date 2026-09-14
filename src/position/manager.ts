import { App, TAbstractFile, Platform, WorkspaceLeaf } from 'obsidian';
import { PluginSettings } from '@/types';
import { CursorPositionDatabase } from './storage/database';
import { TabStore } from './storage/tab-store';
import { PositionState } from './state';
import { BackgroundSettler } from './restore/background-settle';
import { Restorer } from './restore/restorer';
import { OpenPatcher } from './restore/patcher';
import { Sampler } from './capture/sampler';
import { NavHistory } from '@/nav-history/history';
import { NavHistoryModal } from '@/nav-history/browser/modal';
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
	private tabStore: TabStore;
	private restorer: Restorer;
	private patcher: OpenPatcher;
	private sampler: Sampler;
	private backgroundSettler: BackgroundSettler;
	private nav: NavHistory;
	private bookkeeper: PathBookkeeper;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings) {
		this.app = app;
		this.database = database;
		this.state = new PositionState(settings);
		this.nav = new NavHistory(app, settings, this.state);
		this.tabStore = new TabStore(app, database, this.state);
		this.restorer = new Restorer(app, settings, this.tabStore);
		this.sampler = new Sampler(app, database, settings, this.state, this.nav);
		this.patcher = new OpenPatcher(app, settings, this.tabStore, this.nav, this.sampler);
		this.backgroundSettler = new BackgroundSettler(app, settings, this.tabStore);
		this.bookkeeper = new PathBookkeeper(app, database, this.nav, this.state);
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
		// Closing a leaf can't update lastStateByLeaf (no dedicated close
		// event), so dead records survive until the next fresh open's prune.
		// Prune at every persist point instead — quit, suspend flush, and the
		// periodic db flush all funnel here.
		const droppedLastState = this.restorer.pruneStaleLeafIds();
		if(this.database.dbDirty || droppedLastState) {
			this.tabStore.persistLastStateByLeaf(this.state.lastStateByLeaf);
		}

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
		new NavHistoryModal(this.app, this.nav, (path) => this.database.db[path]).open();
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

	clearExclusionCache() {
		this.sampler.clearExclusionCache();
	}
}
