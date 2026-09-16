import { Platform, Plugin } from 'obsidian';
import { SettingTab } from './ui/settings-tab';
import { PluginSettings, SAFE_DB_FLUSH_INTERVAL, DEFAULT_SETTINGS } from './types';
import { CursorPositionDatabase } from './position/storage/database';
import { PositionManager } from './position/manager';
import { t } from './i18n';


export default class PositionRestorePlugin extends Plugin {
	settings!: PluginSettings;
	database!: CursorPositionDatabase;
	manager!: PositionManager;

	async onload() {
		await this.loadSettings();
		this.database = new CursorPositionDatabase(this, this.settings);
		this.manager = new PositionManager(this.app, this.database, this.settings);

		await this.database.readDb();
		this.manager.prunePositions();
		this.manager.sweepMissingHistory();

		this.addSettingTab(new SettingTab(this.app, this));

		this.manager.installPatches(cleanup => this.register(cleanup));
		this.manager.installBackgroundSettle(cleanup => this.register(cleanup));
		this.registerCommands();

		this.registerWorkspaceEvents();
		this.registerPolling();
		this.registerDbFlush();
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
	 * VSCode-style navigation. No default hotkeys — bind in Obsidian's hotkey
	 * settings. Works on any file view: same-tab file switches ride
	 * Obsidian's native per-tab history (PDF/canvas included), cross-tab
	 * traversals reactivate the original tab, in-file jumps apply the
	 * recorded position directly. Also available while a sidebar (file
	 * explorer, search…) holds focus: the traversal reactivates the last
	 * file tab and starts from there.
	 */
	private registerCommands() {
		this.addCommand({
			id: 'navigate-back',
			name: t('navHistory.commands.navigateBack'),
			icon: 'arrow-left',
			checkCallback: (checking) => {
				if (!this.manager.canNavigate(-1)) return false;
				if (!checking) this.manager.navigateBack();
				return true;
			},
		});
		this.addCommand({
			id: 'navigate-forward',
			name: t('navHistory.commands.navigateForward'),
			icon: 'arrow-right',
			checkCallback: (checking) => {
				if (!this.manager.canNavigate(1)) return false;
				if (!checking) this.manager.navigateForward();
				return true;
			}
		});
		// History browser: the stack newest-first, click a row to jump there
		// (time travel — the forward part is kept). No availability gate.
		this.addCommand({
			id: 'browse-nav-history',
			name: t('navHistory.commands.browseHistory'),
			icon: 'history',
			callback: () => this.manager.openNavHistoryModal(),
		});
		// Ribbon entry: MOBILE ONLY. There are no hotkeys on a touch device
		// and the toolbar only exists while editing, so one tap (the mobile
		// navbar exposes the ribbon) is the only way in. On desktop the icon
		// was noise on every toolbar — the command palette and hotkeys cover
		// it, and the settings tab shows whether they are bound.
		if (Platform.isMobile)
			this.addRibbonIcon('history', t('navHistory.heading'), () => this.manager.openNavHistoryModal());
	}

	/**
	 * Workspace reactions: restore on open, persist on quit, and keep the db
	 * keyed by current paths across vault renames/deletes.
	 */
	private registerWorkspaceEvents() {
		this.registerEvent(this.app.workspace.on('file-open', () => this.manager.restoreEphemeralState()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			this.manager.completeInjectedRestore(leaf);
			this.manager.recordActivation(leaf);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.manager.renameFile(file, oldPath)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.manager.deleteFile(file)));
		this.registerEvent(this.app.workspace.on('quit', () => this.manager.storePositionData()));
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
			window.setInterval(() => this.manager.sampleActiveView(), 100)
		);
	}

	/**
	 * Periodic whole-file flush of dirty positions to disk, preceded by an
	 * unconditional external-change merge. A separate concern from the
	 * sampling poll (different cadence, different owner — the database), so
	 * it gets its own registration.
	 *
	 * The merge is what keeps multi-device sync working (Nutstore Sync /
	 * Remotely Save / Obsidian Sync… replace the db file under us). It cannot
	 * ride on writeDb() alone: that early-returns while the db is clean, and
	 * a read-only session (the poll records cursor movement only, scroll
	 * belongs to the capture listener) stays clean for arbitrarily long, so
	 * foreign records would sit unmerged until some local write happened.
	 * One stat() per tick keeps adoption latency bounded at ≤5s — even while
	 * the window sits unfocused, Electron only aligns timers down to 1s — and
	 * costs nothing when the mtime is unchanged. Merging before every flush
	 * also means writeDb()'s whole-file write never clobbers foreign records.
	 */
	private registerDbFlush() {
		this.registerInterval(
			window.setInterval(() => {
				void this.database.mergeExternalChanges()
					.then(() => this.manager.storePositionData());
			}, SAFE_DB_FLUSH_INTERVAL)
		);
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
				this.manager.sampleActiveView();
			this.manager.storePositionData();
		};
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden)
				flushBeforeSuspend();
		});
		this.registerDomEvent(window, 'pagehide', () => flushBeforeSuspend());
	}

}
