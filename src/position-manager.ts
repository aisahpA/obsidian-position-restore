import { App, TAbstractFile, Platform } from 'obsidian';
import { PluginSettings } from './types';
import { CursorPositionDatabase } from './database';
import { PositionState } from './position-state';
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
	private settings: PluginSettings;
	private state: PositionState;
	private restorer: Restorer;
	private patcher: OpenPatcher;
	private sampler: Sampler;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings) {
		this.app = app;
		this.database = database;
		this.settings = settings;
		this.state = new PositionState(settings);
		this.restorer = new Restorer(app, database, settings, this.state);
		this.patcher = new OpenPatcher(app, database, settings, this.state);
		this.sampler = new Sampler(app, database, settings, this.state);
	}

	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patcher.installPatches(registerCleanup);
		// Search anchor: armed by focus on a search input (editor find,
		// switcher, search panel) so search-driven jumps don't overwrite the
		// saved position — see Sampler.installSearchAnchor. Platform-neutral:
		// both the desktop and the mobile poll take the guard.
		this.sampler.installSearchAnchor(registerCleanup);
		if (Platform.isDesktopApp) {
			this.sampler.installScrollCapture(registerCleanup);
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

	checkEphemeralStateChanged() {
		this.sampler.checkEphemeralStateChanged();
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
