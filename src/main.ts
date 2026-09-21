import { Platform, Plugin } from 'obsidian';
import { SettingTab } from './ui/settings-tab';
import { PluginSettings, SAFE_DB_FLUSH_INTERVAL, DEFAULT_SETTINGS } from './types';
import { CursorPositionDatabase } from './position/storage/database';
import { PositionManager } from './position/manager';
import { NAV_HISTORY_VIEW_TYPE } from './nav-history/browser/view';
import { t } from './i18n';


export default class PositionRestorePlugin extends Plugin {
	// Initialised in place rather than left to loadSettings, and never
	// reassigned afterwards — see loadSettings for why the IDENTITY of this
	// object matters.
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
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

		// The history browser's resident form: registered BEFORE the layout is
		// restored, which is what lets a saved sidebar panel come back as itself
		// on the next start. Nothing detaches it on unload, deliberately — the
		// workspace closes a disabled plugin's views, and detaching the leaf here
		// would throw away where the reader had dragged it to.
		this.registerView(NAV_HISTORY_VIEW_TYPE, this.manager.navHistoryViewCreator());

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
		// Merged INTO the existing object, never assigned over it. NavPlaces and
		// PositionManager both capture this reference at construction and read
		// through it live (places.cap(), the panel's landings/placesCap prefs),
		// so replacing the object would leave them reading a stale copy forever.
		Object.assign(this.settings, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// data.json was edited while this plugin was already loaded — by the reader,
	// by a sync, or by another plugin writing on our behalf. Obsidian calls this
	// on the running instance; without it a change would not apply until the
	// next restart.
	//
	// Loading is all that is needed for the values themselves: both consumers
	// read the settings object live, so a new value is in effect on the very
	// next access. What does NOT happen by itself is the work a few keys owe
	// when they change — a lowered ceiling has to trim, a new folder rule has to
	// drop — so the pre-merge copy goes to the manager to diff against. No
	// saveSettings here: echoing the file straight back is how two writers
	// ping-pong.
	async onExternalSettingsChange() {
		const before = { ...this.settings };
		await this.loadSettings();
		this.manager.applyChangedSettings(before);
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
		// History browser: the stack newest-first, one row per note — the row OPENS the
		// file at the spot it stands for, and the control in its gutter shows that row's
		// details (time travel — the forward part is kept). No availability gate.
		this.addCommand({
			id: 'browse-nav-history',
			name: t('navHistory.commands.browseHistory'),
			icon: 'history',
			callback: () => this.manager.openNavHistoryModal(),
		});
		// …and the same browser as a RESIDENT sidebar panel: a place in the
		// workspace rather than a question asked and dismissed. A separate
		// command, deliberately — the two answer the same question in two
		// different moods (a picker, and a panel to work beside), and which one
		// is wanted is the reader's call at the moment they ask, not a setting
		// they have to get right beforehand.
		this.addCommand({
			id: 'open-nav-history-sidebar',
			name: t('navHistory.commands.browseHistorySidebar'),
			icon: 'panel-right',
			callback: () => this.manager.openNavHistorySidebar(),
		});
		// Start the recent-files list over. A COMMAND and not a button in the panel's
		// gear: that panel is a navigator (a row is a place to go, not a row to act on),
		// its gear holds what a row prints rather than what the list does, and this is
		// the one action that throws the reader's own history away — which belongs on
		// the command palette, where they asked for it by name, and not one stray click
		// from the rows they came here to use. No confirmation: the list is disposable
		// (see places-store.ts) and the note being read is put back on the spot (see
		// PositionManager.clearRecentPlaces).
		this.addCommand({
			id: 'clear-recent-files',
			name: t('navHistory.commands.clearRecent'),
			icon: 'trash-2',
			callback: () => this.manager.clearRecentPlaces(),
		});
		// Ribbon entry: MOBILE ONLY. There are no hotkeys on a touch device
		// and the toolbar only exists while editing, so one tap (the mobile
		// navbar exposes the ribbon) is the only way in. On desktop the icon
		// was noise on every toolbar — the command palette and hotkeys cover
		// it, and the settings tab shows whether they are bound.
		if (Platform.isMobile)
			// NOT navHistory.heading: the ribbon opens the recent-files list, and
			// that page's name is what the icon has to say. (The heading is the
			// back/forward stack's, which is the other half of this feature.)
			this.addRibbonIcon('history', t('navHistory.overview.name'), () => this.manager.openNavHistoryModal());
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
