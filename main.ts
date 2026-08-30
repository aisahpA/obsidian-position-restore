import { Plugin } from 'obsidian';
import { SettingTab } from './src/settings-tab';
import { PluginSettings, SAFE_DB_FLUSH_INTERVAL, DEFAULT_SETTINGS } from './src/types';
import { CursorPositionDatabase } from './src/database';
import { PositionManager } from './src/position-manager';


export default class RememberCursorPosition extends Plugin {
	settings!: PluginSettings;
	database!: CursorPositionDatabase;
	manager!: PositionManager;

	async onload() {
		await this.loadSettings();
		this.database = new CursorPositionDatabase(this, this.settings);
		this.manager = new PositionManager(this.app, this.database, this.settings);

		await this.database.readDb();
		this.database.pruneDb();

		this.addSettingTab(new SettingTab(this.app, this));

		this.manager.installPatches(cleanup => this.register(cleanup));

		this.registerWorkspaceEvents();
		this.registerPolling();
		this.registerDbFlush();
		this.registerSyncMerge();
		this.registerSuspendFlush();

		this.manager.restoreEphemeralState();
	}

	//----------------------------------------------------------------------------------------

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<PluginSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	//----------------------------------------------------------------------------------------
	// Lifecycle registration. Each method below owns one concern of onload;
	// comments document WHY, the names document WHAT.

	/**
	 * Workspace reactions: restore on open, persist on quit, and keep the db
	 * keyed by current paths across vault renames/deletes.
	 */
	private registerWorkspaceEvents() {
		this.registerEvent(this.app.workspace.on('file-open', () => this.manager.restoreEphemeralState()));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.manager.renameFile(file, oldPath)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.manager.deleteFile(file)));
		this.registerEvent(this.app.workspace.on('quit', () => { void this.database.writeDb(); }));
	}

	/**
	 * We chose a 100ms polling loop over the event-driven approach because
	 * our task is simply "remember the position before leaving," which has
	 * no real-time requirement. Each poll tick only calls CodeMirror in-memory
	 * getters and never triggers reflow, so its performance cost is ~0 —
	 * there is no measurable difference versus event mode. The event approach
	 * is ~3x more code and needs extra guards (restore-skip, vim-mode, target→leaf
	 * lookup), making it more error-prone, whereas polling's "full snapshot"
	 * behavior is actually more robust and never silently drops a change.
	 */
	private registerPolling() {
		this.registerInterval(
			window.setInterval(() => this.manager.checkEphemeralStateChanged(), 100)
		);
	}

	/**
	 * Periodic whole-file flush of dirty positions to disk. A separate
	 * concern from the sampling poll (different cadence, different owner —
	 * the database), so it gets its own registration.
	 */
	private registerDbFlush() {
		this.registerInterval(
			window.setInterval(() => { void this.database.writeDb(); }, SAFE_DB_FLUSH_INTERVAL)
		);
	}

	/**
	 * Multi-device sync: another device's positions arrive by the db file
	 * being replaced under us (Nutstore Sync / Remotely Save / Obsidian Sync…).
	 * Two triggers suffice: window focus catches the common "sync landed
	 * while I was away" moment immediately, and writeDb() re-checks before
	 * every flush (≤5s later) so its whole-file write never clobbers foreign
	 * records. No periodic polling: adopting foreign data a few seconds
	 * later costs nothing, and a merged record arriving late only means the
	 * next restore uses it one open-cycle sooner.
	 */
	private registerSyncMerge() {
		this.registerDomEvent(window, 'focus', () => this.database.mergeExternalChanges());
	}

	/**
	 * Flush the last visible position before the app can be suspended.
	 * On mobile the WebView freezes JS shortly after backgrounding and is
	 * later killed without a 'quit' event, so both the 100ms poll and the
	 * 5s db flush can miss the final scroll: locking the screen or
	 * switching apps right after a flick loses it. visibilitychange /
	 * pagehide are the last reliable callbacks — record the active view's
	 * current state, then write the db. Harmless on desktop (tab switch,
	 * minimize) where the same flush is simply early.
	 */
	private registerSuspendFlush() {
		const flushBeforeSuspend = () => {
			// A live search session means the visible spot is a search match,
			// not the user's — skip the record step (the poll's own search
			// guard skips the write anyway) and only persist what is already
			// saved, keeping the pre-search anchor intact across suspension.
			if (!this.manager.isSearchAnchored())
				this.manager.checkEphemeralStateChanged();
			void this.database.writeDb();
		};
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden)
				flushBeforeSuspend();
		});
		this.registerDomEvent(window, 'pagehide', () => flushBeforeSuspend());
	}

}
