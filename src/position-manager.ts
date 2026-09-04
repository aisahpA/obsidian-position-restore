import { App, TAbstractFile, Platform, WorkspaceLeaf } from 'obsidian';
import { PluginSettings } from './types';
import { CursorPositionDatabase } from './database';
import { TabStore } from './tab-store';
import { PositionState } from './position-state';
import { BackgroundSettler } from './background-settle';
import { Restorer } from './restorer';
import { OpenPatcher } from './patcher';
import { Sampler } from './sampler';

// Thin facade over the collaborating pieces, owned by the plugin:
//  - OpenPatcher: installs the setViewState/openLinkText patches and injects
//    saved positions into opens.
//    position changes (see sampler.ts).
//  - Sampler: the polling-loop observer plus scroll listener that persists
//  - Restorer: restores a saved position after an open.
//  - File rename/delete bookkeeping.
// All cross-phase coordination flags live in the shared PositionState, so the
// collaborators never desync. main.ts only talks to this class.
export class PositionManager {
	private app: App;
	private database: CursorPositionDatabase;
	private state: PositionState;
	private tabStore: TabStore;
	private restorer: Restorer;
	private patcher: OpenPatcher;
	private sampler: Sampler;
	private backgroundSettler: BackgroundSettler;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings) {
		this.app = app;
		this.database = database;
		this.state = new PositionState(settings);
		this.tabStore = new TabStore(app, database, this.state);
		this.restorer = new Restorer(app, settings, this.tabStore);
		this.patcher = new OpenPatcher(app, settings, this.tabStore);
		this.sampler = new Sampler(app, database, settings, this.state);
		this.backgroundSettler = new BackgroundSettler(app, settings, this.tabStore);
	}

	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patcher.installPatches(registerCleanup);
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

	checkEphemeralStateChanged() {
		this.sampler.checkEphemeralStateChanged();
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

		void this.database.writeDb();
	}

	// True while a search session is live (a search input holds, or just
	// released, focus — see Sampler.installSearchAnchor). main.ts checks this
	// before recording paths outside the poll, e.g. the suspend flush.
	isSearchAnchored() {
		return this.state.isSearchAnchored();
	}

	renameFile(file: TAbstractFile, oldPath: string) {
		this.database.renameFile(file.path, oldPath);
		if (this.state.lastLoadedFilePath == oldPath)
			this.state.lastLoadedFilePath = file.path;
	}

	deleteFile(file: TAbstractFile) {
		this.database.deleteFile(file.path);
	}

	clearExclusionCache() {
		this.sampler.clearExclusionCache();
	}
}
