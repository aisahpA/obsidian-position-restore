import { Platform, Plugin } from 'obsidian';
import { SettingTab } from './settings/tab';
import { PluginSettings, SAFE_DB_FLUSH_INTERVAL, DEFAULT_SETTINGS } from './types';
import { CursorPositionDatabase } from './position/storage/database';
import { PositionManager } from './position/manager';
import { RECENT_FILES_VIEW_TYPE } from './recent-files/browser/view';
import { NAV_SOURCE_ID } from './recent-files/browser/constants';
import { t } from './i18n';


export default class PositionRestorePlugin extends Plugin {
	// Never reassigned — see loadSettings for why the IDENTITY of this object matters.
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

		this.registerView(RECENT_FILES_VIEW_TYPE, this.manager.recentFilesViewCreator());
		this.registerPreviewSource();

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
		// PositionManager both capture this reference at construction and read through it
		// live (places.cap(), the panel's prefs), so replacing the object would leave them
		// reading a stale copy forever.
		Object.assign(this.settings, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// data.json was edited while this plugin was already loaded — by the reader, by a
	// sync, or by another plugin writing on our behalf. Obsidian calls this on the running
	// instance; without it a change would not apply until the next restart.
	//
	// Loading is all the values need: both consumers read the settings object live. What
	// does NOT happen by itself is the work a few keys owe when they change — a lowered
	// ceiling has to trim, a new folder rule has to drop — so the pre-merge copy goes to
	// the manager to diff against. No saveSettings here: echoing the file straight back is
	// how two writers ping-pong.
	async onExternalSettingsChange() {
		const before = { ...this.settings };
		await this.loadSettings();
		this.manager.applyChangedSettings(before);
	}

	//----------------------------------------------------------------------------------------
	// Lifecycle registration. Each method below owns one concern of onload.

	// Recent-files rows are a place the READER HOVERS FROM, so the panel joins the app's
	// own page-preview system under one id (see constants.ts's NAV_SOURCE_ID) and a hover
	// asks for that preview of the note its row names, rather than this panel drawing a
	// popover of its own — which would be a second set of rules to learn (see hoverRow).
	//
	// Registering is also what puts the panel BY NAME in that plugin's settings, and that
	// is where the one question here gets answered: whether hovering is enough, or takes
	// Cmd/Ctrl. `defaultMod: true` is what that row starts ON, because it is what the app
	// starts on everywhere else — the file explorer and search among them. The press is
	// waited for ON THE ROW, which is why hoverRow passes `targetEl`.
	private registerPreviewSource(): void {
		this.registerHoverLinkSource(NAV_SOURCE_ID, {
			display: t('recentFiles.name'),
			defaultMod: true,
		});
	}

	// VSCode-style navigation. No default hotkeys — bind in Obsidian's hotkey settings.
	// Works on any file view: same-tab file switches ride the native per-tab history
	// (PDF/canvas included), cross-tab traversals reactivate the original tab, in-file
	// jumps apply the recorded position directly. Also available while a sidebar holds
	// focus: the traversal reactivates the last file tab and starts from there.
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
		// Recent files: the PLACES list, most recent last (see places.ts) — one row per
		// note, and the row OPENS the file at the spot it stands for. It is NOT the
		// back/forward stack: that store is the pair of commands above. No availability
		// gate.
		//
		// The icon is a CLOCK: the rows are places ordered by when they were last sat in.
		// Not 'list', which belongs to the outline pane and would make the two read as one
		// thing in the palette. The panel's own tab carries the same icon (see
		// RecentFilesView.getIcon).
		this.addCommand({
			id: 'browse-recent-files',
			name: t('recentFiles.commands.open'),
			icon: 'clock',
			callback: () => this.manager.openRecentFilesModal(),
		});
		// …and the same browser as a RESIDENT sidebar panel: a place in the workspace
		// rather than a question asked and dismissed. A separate command, deliberately —
		// the two answer the same question in two moods (a picker, and a panel to work
		// beside), and which one is wanted is the reader's call at the moment they ask.
		this.addCommand({
			id: 'open-recent-files-sidebar',
			name: t('recentFiles.commands.openSidebar'),
			icon: 'panel-right',
			callback: () => this.manager.openRecentFilesSidebar(),
		});
		// Ribbon entry: ONE icon on every platform, because this list is the only part of
		// the plugin that has a face at all — restore happens by itself, and back/forward
		// is a hotkey the reader has to bind before it exists. A door that cannot be seen
		// leaves the feature waiting for a reader who already knows it is there.
		//
		// What the icon OPENS is the platform's own answer. On desktop the sidebar is
		// ground that stays, so the icon opens the resident panel — and brings it BACK
		// when one is already standing (see activateRecentFilesView). On a phone the icon
		// asks and goes away — the modal — not because a panel would be in the way there:
		// a travel collapses the drawer it stands in (see dismissOnMobile), and a reader
		// who wants it standing has the sidebar command and, after that, a swipe.
		//
		// There is no setting of ours for it: the app lets a reader uncheck any ribbon
		// action and remembers it across devices, and a second copy would be a knob
		// standing in front of a question already answered somewhere else.
		const openFromRibbon = Platform.isMobile
			? () => this.manager.openRecentFilesModal()
			: () => this.manager.openRecentFilesSidebar();
		// NOT navHistory.heading: the ribbon opens the recent-files list, and that page's
		// name is what the icon has to say.
		this.addRibbonIcon('clock', t('recentFiles.name'), openFromRibbon);
	}

	// Workspace reactions: restore on open, persist on quit, and keep the db keyed by
	// current paths across vault renames/deletes.
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

	// A 100ms poll rather than event-driven: the task is "remember the position before
	// leaving", which has no real-time requirement, and each tick only calls CodeMirror
	// in-memory getters and never triggers reflow — so its cost is ~0. The event approach
	// is ~3x more code and needs extra guards (restore-skip, vim-mode, target→leaf
	// lookup); polling's "full snapshot" never silently drops a change.
	private registerPolling() {
		this.registerInterval(
			window.setInterval(() => this.manager.sampleActiveView(), 100)
		);
	}

	// Periodic whole-file flush of dirty positions, preceded by an unconditional
	// external-change merge — a separate concern from the sampling poll (different
	// cadence, different owner), so its own registration.
	//
	// The merge is what keeps multi-device sync working (the sync plugins replace the db
	// file under us). It cannot ride on writeDb() alone: that early-returns while the db is
	// clean, and a read-only session stays clean for arbitrarily long, so foreign records
	// would sit unmerged until some local write happened. One stat() per tick keeps
	// adoption latency bounded at ≤5s — even while the window sits unfocused, Electron only
	// aligns timers down to 1s — and costs nothing when the mtime is unchanged. Merging
	// before every flush also means writeDb()'s whole-file write never clobbers foreign
	// records.
	private registerDbFlush() {
		this.registerInterval(
			window.setInterval(() => {
				void this.database.mergeExternalChanges()
					.then(() => this.manager.storePositionData());
			}, SAFE_DB_FLUSH_INTERVAL)
		);
	}

	// Flush the last visible position before the app can be suspended. On mobile the
	// WebView freezes JS shortly after backgrounding and is later killed without a 'quit'
	// event, so both the 100ms poll and the 5s flush can miss the final scroll: locking
	// the screen right after a flick loses it. visibilitychange / pagehide are the last
	// reliable callbacks — record the active view's state, then write the db. Harmless on
	// desktop (tab switch, minimize), where the same flush is simply early.
	private registerSuspendFlush() {
		const flushBeforeSuspend = () => {
			// A live search session means the visible spot is a search match, not the
			// reader's — skip the record step and only persist what is already saved,
			// keeping the pre-search anchor intact across suspension.
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
