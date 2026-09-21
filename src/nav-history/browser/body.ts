// The history browser's BODY: everything about the panel that is not a shell.
//
// Two shells stand around it — the "Open recent files" modal
// (modal.ts) and the resident sidebar panel (view.ts) — and everything they have in
// common lives here: the toolbar, the list of notes, the keyboard, and travel. A shell
// owns its own lifetime and nothing else: when it opens, it mounts one of these into an
// element it owns; when it closes, it destroys it. That is the whole of the difference
// between a dialog and a sidebar here, and it is why travel is a callback (see
// onJump): the modal closes when the reader goes somewhere, the sidebar stays.
//
// Every other piece is a module beside this one:
//   - constants.ts                    the tuning numbers
//   - model.ts / listing.ts / panes.ts   the pure model
//   - reads.ts                        every vault lookup, cached and metadata-only
//   - list.ts                         the list of notes and the position in it
// The name says BROWSER because the list itself — which places exist, how they are
// recorded, persisted and travelled to — is the rest of nav-history/ (places.ts,
// places-store.ts, plus the recording funnel in history.ts and the entry vocabulary in
// entry.ts), which this panel only reads and never writes.
//
// READ-ONLY, and that is what makes a RESIDENT panel possible at all: the body draws
// whatever the stack holds at the moment render() is called. The list's own snapshot is
// refreshed from the stack on every render (see render), so a shell that lives for hours
// shows the history as it stands rather than as it stood when the panel opened — and one
// that lives for a second (the modal) is not asked for anything more.

import { App, FileView, setIcon } from 'obsidian';
import { NavHistoryEntry, RECORDABLE_VIEW_TYPES } from '@/nav-history/entry';
import { PlaceList } from '@/nav-history/places';
import { isMainAreaLeaf, leafIdOf } from '@/shared/leaf';
import { EphemeralState, LandingsMode } from '@/types';
import { t } from '@/i18n';
import { headingTrailAtLine, NavEntryDescription } from './model';
import { LiveLeaf, PaneInfo, paneInfo, paneLabel, viewDestinationKey } from './panes';
import { NavHistoryReads } from './reads';
import { NavHistoryList, NavHistoryListOptions } from './list';

// Per-body sequence for the list element's id (see NavHistoryBrowser.listId).
let browserSeq = 0;

// The preferences the browser ITSELF owns, handed to every shell by the plugin
// that persists them (see PluginSettings and PositionManager.browserPrefs). All are
// READERS over the one shared settings object rather than values: a resident panel draws
// its list from a call made during render, so a change made in the panel is picked up by
// the next history change instead of being frozen into the panel that happened to be
// open. Both come as a pair — read plus write — because the panel is where each of them
// is CHOSEN (see NavHistoryBrowser.settings).
export interface NavBrowserPrefs {
	// How much of one note the list prints (see LandingsMode).
	landings: () => LandingsMode;
	// The toolbar's setting: still the plugin's choice to keep (see setLandings).
	setLandings: (mode: LandingsMode) => void;
	// How many places the recent-files list keeps. Chosen here rather than in the
	// settings tab for the same reason the one above is: the reader decides it while
	// looking at the list whose length it is (see body.ts's settings gear).
	placesCap: () => number;
	setPlacesCap: (cap: number) => void;
}

export interface NavHistoryBrowserOptions {
	app: App;
	// The PLACES the rows are drawn from — the recent-files list (see places.ts), never
	// the back/forward stack: the list answers "which files have I been in, and which
	// spots did I jump to", and a stack that truncates on a fresh jump cannot answer it.
	// Its own travel decides per record how to go there (a file opens the plain way; a
	// jump lands on its spot).
	places: PlaceList;
	// The element the body builds itself into. Its size is the shell's business;
	// the body only fills it.
	host: HTMLElement;
	// The file's saved record: the position every FILE row's line is drawn from
	// (a place carries none), and the spot a plain open restores.
	savedPosition?: (path: string) => EphemeralState | undefined;
	// Whether this device is a touch device. It is about the device's own
	// ergonomics and nothing else — an on-screen keyboard that covers half a phone
	// when a field takes focus, and the wording of the hint ("tap" for a finger,
	// "click" for a mouse). The list's own interaction is the same either way: it is
	// click-only on every device (see NavHistoryList).
	touch: boolean;
	// Whether a travel CLEARS the reader's place in the list first: nothing pointed
	// at before the history is asked to move.
	//
	// A shell that stays up needs it (see view.ts). The jump rewrites the stack and pins
	// the note it landed on first, so the note the reader had opened is about to be a
	// different note in the same slot — and any position left standing would name
	// whatever slid into it. The dialog says no: it closes on the first travel (see
	// onJump) and never redraws.
	collapseOnJump: boolean;
	// Whether the filter box takes the focus as soon as the body is mounted. A
	// dialog wants it (typing is the fastest way through the list, and the
	// dialog was opened on purpose); a resident panel must not (it is restored
	// with the workspace, and stealing the caret out of the editor to open a
	// sidebar is not something the reader asked for).
	focusFilter: boolean;
	// The shell's own reaction to a travel, run BEFORE the history is asked to
	// move: the modal closes here (a picker has answered its question), the
	// sidebar does nothing (staying put is the whole point of it).
	onJump?: () => void;
	// The browser's own preferences, handed down by the shell (see NavBrowserPrefs):
	// whether a landing is described at all, and how much of a note the list prints.
	prefs: NavBrowserPrefs;
}

export class NavHistoryBrowser {
	// The list of steps, its rows and what is pointed at (see NavHistoryList).
	private list!: NavHistoryList;
	// The list's options object, kept because two of its fields are the LIVE
	// stack and are re-pointed before every render (see render): the list reads
	// its entries through this object, so a resident panel is refreshed by
	// assigning to it rather than by rebuilding the list (which would drop the
	// position the reader was on).
	private listOpts!: NavHistoryListOptions;
	// The search box's text. The list's own query.
	private filter = '';
	private filterInput!: HTMLInputElement;
	// The toolbar's own setting: the button in the strip's far corner, the small panel
	// it opens (undefined while it is closed), and the press-outside listener that
	// dismisses it. Held because only one may be up, and because that listener has to
	// come off the document when the panel closes or the body goes (see destroy).
	private settingsBtn!: HTMLElement;
	private settingsMenu?: HTMLElement;
	private dismissSettings?: (ev: Event) => void;
	private panes: PaneInfo = { live: new Map() };
	// Every vault lookup the panel makes, cached — all of them metadata-cache
	// lookups: an entry's display pieces and a file's parsed headings (see
	// reads.ts).
	private reads: NavHistoryReads;
	// The list element's id, unique per body: the rows' option ids are built
	// from it and the filter box's aria-activedescendant points at one of them,
	// so a second browser mounted beside this one — a sidebar panel and the
	// modal at once — cannot collide with it.
	private readonly listId = `position-restore-nav-list-${++browserSeq}`;

	constructor(private opts: NavHistoryBrowserOptions) {
		this.reads = new NavHistoryReads(opts.app, {
			savedPosition: opts.savedPosition,
			// The live list, re-pointed per render (see render): a resident panel
			// describes the places as they stand, not as they stood when it opened.
			entries: () => opts.places.entries,
		});
	}

	// Build the toolbar and the list inside the shell's element. One call per body: the
	// toolbar is NOT rebuilt per render, so the filter input keeps its focus and its
	// caret while typing redraws the list underneath it.
	mount(): void {
		this.toolbar();
		// The list, straight into the shell's element: with the details panel gone there
		// is no second column to stand beside, and the body div that used to hold the two
		// of them has nothing left to arrange.
		const listEl = this.opts.host.createDiv({ cls: 'position-restore-nav-list' });
		// The list is a listbox whose options are the rows (the list tags them; see
		// NavHistoryList.row) and whose current option the filter box names through
		// aria-activedescendant (see setActiveRow). The id is what makes that reference
		// possible, and the label is the panel's own name.
		listEl.setAttr('id', this.listId);
		listEl.setAttr('role', 'listbox');
		listEl.setAttr('aria-label', t('navHistory.overview.name'));
		this.listOpts = {
			list: listEl,
			listId: this.listId,
			// How much of a note to print: read LIVE (see NavBrowserPrefs), so the
			// toolbar's setting reaches a panel that is already up.
			landings: () => this.opts.prefs.landings(),
			// The live places, re-pointed per render (see render).
			entries: this.opts.places.entries,
			currentIndex: this.opts.places.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			// Whether a place may be listed at all: a name the list cannot open is not a
			// row (see NavHistoryList.render and NavHistoryReads.hasFile). The store
			// prunes such a place on its own; this is the list agreeing with it.
			noteExists: path => this.reads.hasFile(path),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			onActiveRow: id => this.setActiveRow(id),
			onTravel: rep => this.jump(rep),
		};
		this.list = new NavHistoryList(this.listOpts);
		// One keydown listener on the shell's own element covers both the filter
		// input and the list: while typing, arrows navigate and Enter jumps (the
		// input would otherwise move its caret); Escape stays native (closes the
		// dialog, and in a sidebar does nothing, which is what "resident" means).
		this.opts.host.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		this.render();
		// A touch device raises its on-screen keyboard the moment an input takes focus,
		// and the keyboard covers half of a small screen. So on touch the box stays
		// unfocused (one tap away, when the user actually means to type); on a pointing
		// device the keyboard costs nothing and typing is the fastest way through the
		// list, so it keeps the focus.
		if (this.opts.focusFilter && !this.opts.touch && this.opts.places.entries.length > 0)
			this.filterInput.focus();
	}

	// (Re)draw everything the places and the filter decide. Called by the shell when it
	// mounts and — for a resident panel — every time the places change (see
	// NavPlaces.subscribe).
	render(): void {
		// The places as they stand NOW, before anything reads them: the list holds its
		// options object across renders and resolves its entries by index, so a list that
		// moved under a resident panel is picked up by re-pointing these two fields and
		// nothing else. The describe cache goes with them — it is keyed by index, and an
		// index means another place the moment the list is re-ordered or trimmed.
		this.listOpts.entries = this.opts.places.entries;
		this.listOpts.currentIndex = this.opts.places.index;
		this.panes = paneInfo(this.liveLeaves());
		this.list.render();
	}

	// Throw away what belongs to this body: the toolbar's setting, if it happens to
	// be open — its press-outside listener lives on the document, which outlives
	// every panel (see the shell's teardown).
	destroy(): void {
		this.closeSettings();
	}

	private onKeyDown(ev: KeyboardEvent): void {
		// The toolbar's setting goes first, and the key STOPS here: a reader pressing
		// Escape at an open setting is putting THAT away, not closing the dialog it
		// happens to be standing in.
		if (ev.key === 'Escape' && this.closeSettings()) {
			ev.preventDefault();
			ev.stopPropagation();
			return;
		}
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.list.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.list.move(-1);
		} else if (ev.key === 'Enter') {
			// Enter acts on the POSITION and on nothing else — the row the arrows walk
			// (see the list's move) — and with no position it does nothing. (It used to
			// fall back to "go back one step", which made one key mean two things
			// depending on whether the pointer had crossed a row — and duplicated the
			// app's own back command.)
			// The travel goes through the list, which is what knows which row the
			// position is on: every row on screen is a destination, the place the
			// reader is already in included (see list.targetOf).
			if (this.list.travel())
				ev.preventDefault();
		}
	}

	// Tell assistive tech which option the keyboard is on. The focus never
	// leaves the filter box, so this attribute is the ONLY thing that makes the
	// arrow keys audible — without it the box reads as an empty text field while
	// the user walks the list.
	private setActiveRow(id: string | undefined): void {
		if (id)
			this.filterInput.setAttr('aria-activedescendant', id);
		else
			this.filterInput.removeAttribute('aria-activedescendant');
	}

	// The toolbar is built once (not per render), so the filter input keeps
	// its focus and caret while typing re-renders the list underneath.
	private toolbar(): void {
		const bar = this.opts.host.createDiv({ cls: 'position-restore-nav-toolbar' });
		const input = bar.createEl('input', {
			type: 'text',
			cls: 'position-restore-nav-filter',
			attr: {
				placeholder: t('navHistory.searchPlaceholder'),
				// The box IS the list's keyboard: it keeps the focus while the
				// arrow keys walk the rows, so it is a combobox over the list
				// (always expanded — the list is on screen, not a popup) and the
				// current option is reported through aria-activedescendant (see
				// setActiveRow) instead of by moving focus.
				role: 'combobox',
				'aria-controls': this.listId,
				'aria-expanded': 'true',
				'aria-autocomplete': 'list',
			},
		});
		input.addEventListener('input', () => {
			this.filter = input.value;
			// The list follows the filter, so the body re-renders (the toolbar does
			// not).
			this.render();
		});
		this.filterInput = input;
		// The hint, and then the list's own settings at the far end of the strip. The file
		// scope that used to sit between them — a "only this note" switch and a chip of
		// every note the history had been in — is gone: a note's name is text the box
		// already matches, so the two controls were a slower way to type it, and they cost
		// the list the width and the row they stood on.
		// What is left to name is the one gesture a row has: a finger's tap on a touch
		// device, a click everywhere else (see `hint`).
		this.hint(bar);
		this.settings(bar);
	}

	// The hint: one sentence per DEVICE, saying the only thing a row now answers to. It
	// used to be written from the details setting, because half of it named the gutter
	// control that opened the panel; with the control gone there is one gesture left, so
	// the sentence is fixed and the element is built once.
	private hint(bar: HTMLElement): void {
		bar.createSpan({
			cls: 'position-restore-nav-hint',
			text: t(this.opts.touch ? 'navHistory.touchHint' : 'navHistory.clickHint'),
		});
	}

	// THE TOOLBAR'S SETTINGS: the small button at the strip's far end, and the panel it
	// opens over the list. Two choices — how much of a note the list prints, and how far
	// back it reaches.
	//
	// It stands here rather than in the settings tab because this is where the questions
	// are asked — a reader decides how long the list should be while looking at it — and
	// because the panel is a DIALOG as often as it is a sidebar: a settings row would be
	// the only way to reach a choice about something that is not on screen at the time.
	// It leaves the settings tab with no second copy of any of these values that could
	// drift from this one.
	//
	// The panel is plain DOM and not the app's own Menu: each choice is a radio group
	// whose answers carry their own few words beside them, which a menu cannot carry.
	private settings(bar: HTMLElement): void {
		const btn = bar.createEl('button', {
			cls: 'clickable-icon position-restore-nav-settings',
			type: 'button',
			attr: {
				// The button is the only label the panel needs, and a gear is not a word:
				// the name is for the reader who has to have it said and for the tooltip.
				'aria-label': t('navHistory.listSettings'),
				'aria-haspopup': 'true',
				'aria-expanded': 'false',
				title: t('navHistory.listSettings'),
			},
		});
		setIcon(btn, 'settings-2');
		this.settingsBtn = btn;
		btn.addEventListener('click', () => {
			if (this.settingsMenu)
				this.closeSettings();
			else
				this.openSettings(bar);
		});
	}

	// Open the settings under the button: each choice is the name of the choice and its
	// answer(s), every answer carrying its own few words.
	private openSettings(bar: HTMLElement): void {
		const menu = bar.createDiv({
			cls: 'position-restore-nav-settings-menu',
			attr: { role: 'group', 'aria-label': t('navHistory.listSettings') },
		});
		this.settingGroup<LandingsMode>(menu, t('navHistory.landings.name'), [
			{
				value: 'last',
				label: t('navHistory.landings.options.last'),
				desc: t('navHistory.landings.options.last.desc'),
			},
			{
				value: 'all',
				label: t('navHistory.landings.options.all'),
				desc: t('navHistory.landings.options.all.desc'),
			},
		], this.opts.prefs.landings(), mode => this.pickLandings(mode));
		// How far back the list reaches: the one storage knob of the recent-files
		// list, and a question only the reader looking at the list can answer (see
		// NavBrowserPrefs.placesCap). Three answers rather than a number field,
		// because the choice is "how far back do I want to reach", not a figure to
		// type — and each answer carries its own few words, like every group here.
		this.settingGroup<string>(menu, t('navHistory.recentCap.name'), [
			{ value: '100', label: '100', desc: t('navHistory.recentCap.short') },
			{ value: '200', label: '200', desc: t('navHistory.recentCap.medium') },
			{ value: '500', label: '500', desc: t('navHistory.recentCap.long') },
		], String(this.opts.prefs.placesCap()), value => this.pickPlacesCap(Number(value)));
		this.settingsMenu = menu;
		this.settingsBtn.setAttr('aria-expanded', 'true');
		this.watchDismiss(menu);
	}

	// Anything outside the setting — the list, the filter box, the rest of the app —
	// puts it away. On the DOCUMENT and in the CAPTURE phase, so that it is gone before
	// the press it belongs to reaches whatever it landed on.
	private watchDismiss(menu: HTMLElement): void {
		const dismiss = (ev: Event) => {
			const target = ev.target as Node | null;
			if (target && (menu.contains(target) || this.settingsBtn.contains(target)))
				return;
			this.closeSettings();
		};
		this.dismissSettings = dismiss;
		document.addEventListener('mousedown', dismiss, true);
	}

	// One choice in the menu: its name, and its answers under it — each answer saying
	// what it means in a few words of its own, right after the word itself.
	//
	// The note used to stand under the group as one paragraph, a line per answer: two
	// short rows and then a wall of small print, which the reader had to pick apart to
	// find which sentence belonged to which answer, in a menu that is already the
	// width of the words it holds. Written after its own option, each answer's few
	// words are read where the answer is, and the paragraph that had to name its
	// options before it could say anything is gone.
	private settingGroup<T extends string>(
		menu: HTMLElement,
		title: string,
		options: { value: T; label: string; desc: string }[],
		current: T,
		pick: (value: T) => void,
	): void {
		const box = menu.createDiv({ cls: 'nav-settings-group' });
		box.createDiv({ cls: 'nav-settings-title', text: title });
		const group = box.createDiv({
			cls: 'nav-settings-options',
			attr: {
				// A radio group rather than a menu of commands: what is being chosen is
				// one of two answers, and the reader has to be able to hear WHICH one is
				// in force without opening the list to look at its shape.
				role: 'radiogroup',
				'aria-label': title,
			},
		});
		for (const option of options) {
			const checked = option.value === current;
			const row = group.createEl('button', {
				cls: 'nav-settings-option',
				type: 'button',
				attr: { role: 'radio', 'aria-checked': String(checked) },
			});
			// The value in force says so a second time, with a mark: the tint alone is a
			// fact a theme can take away (see styles.css), and this is the one cue left
			// when two backgrounds come out nearly the same. The mark's SLOT is written
			// on every row whether or not it holds a glyph — in front of the label, so
			// the two labels start on one x instead of the unticked one pulling left.
			const tick = row.createSpan({ cls: 'nav-settings-tick', attr: { 'aria-hidden': 'true' } });
			if (checked)
				setIcon(tick, 'check');
			row.createSpan({ cls: 'nav-settings-label', text: option.label });
			// The answer's few words travel in the row's own control, so they are part
			// of what the option is called when it is announced as well as of what is
			// read on screen. The BRACKETS around them are the locale's and not this
			// line's: which pair to draw is the language's own call, and the text here
			// is taken as it was written.
			row.createSpan({ cls: 'nav-settings-option-desc', text: option.desc });
			row.addEventListener('click', () => pick(option.value));
		}
	}

	// One of the two values: the plugin is asked to remember it (see NavBrowserPrefs),
	// and the list is redrawn on the spot — seeing the list that follows is the whole
	// reason the choice is offered here, so the panel goes first and the change lands
	// under it.
	private pickLandings(mode: LandingsMode): void {
		this.closeSettings();
		if (this.opts.prefs.landings() === mode)
			return;
		this.opts.prefs.setLandings(mode);
		this.render();
	}

	// …and the same for how far back the list reaches. Lowering it trims the list
	// on the spot rather than on the next visit (see NavPlaces.applyCap): a
	// setting that says "keep 100" has to mean it while the reader is looking at
	// the 300 it is about to drop.
	private pickPlacesCap(cap: number): void {
		this.closeSettings();
		if (!Number.isFinite(cap) || this.opts.prefs.placesCap() === cap)
			return;
		this.opts.prefs.setPlacesCap(cap);
		this.render();
	}

	// Put the setting away, and say whether there was one up (@returns whether this
	// was the key the reader meant, see onKeyDown).
	private closeSettings(): boolean {
		const menu = this.settingsMenu;
		if (!menu)
			return false;
		this.settingsMenu = undefined;
		if (this.dismissSettings) {
			document.removeEventListener('mousedown', this.dismissSettings, true);
			this.dismissSettings = undefined;
		}
		this.settingsBtn.setAttr('aria-expanded', 'false');
		menu.remove();
		return true;
	}

	// The "you are here" CARD that used to stand between the toolbar and the list
	// is gone. The current entry is a row in the list like any other — pinned
	// first — and the card said the same thing a second time, in a second place,
	// in a second layout: one line of chrome bought with the height the list
	// needed, and a reader had to learn which of the two "current position"s was
	// authoritative. The row is.

	// The heading chain the entry's landing sits in. Empty for a view entry or an
	// entry with no recorded line.
	private trailFor(entry: NavHistoryEntry, d: NavEntryDescription): string[] {
		if (entry.kind === 'view' || d.lineIndex === undefined)
			return [];
		return headingTrailAtLine(this.reads.headingsFor(entry.path), d.lineIndex);
	}

	// Which live tab/pane an entry belongs to, or undefined when there is
	// nothing to disambiguate (see paneLabel). It belongs on the row because two
	// tabs of one file are otherwise identical rows — and telling those apart is
	// what decides which row to pick — but it is only ever a claim about what is
	// open NOW, which is why it is looked up from the workspace rather than read
	// off the entry.
	private paneName(entry: NavHistoryEntry): string | undefined {
		const label = paneLabel(this.panes, entry);
		if (!label)
			return undefined;
		// "2/3" — which of how many, in three characters: the word ("Pane",
		// "窗格") was the widest thing in the row's quiet zone and said nothing
		// the two numbers do not.
		return t('navHistory.pane', label.n, label.total);
	}

	// The main area as it stands right now: every main-area leaf, in the
	// layout order iterateAllLeaves yields, with the destination it currently
	// shows. This — not the recorded leaf ids — is what the pane marker is
	// derived from (see paneInfo for why): one tab walks through many notes, and
	// closing a tab leaves its entries behind, so a history-derived number named
	// windows the user could not see. Rebuilt per render, so the marker follows
	// the layout.
	private liveLeaves(): LiveLeaf[] {
		const live: LiveLeaf[] = [];
		this.opts.app.workspace.iterateAllLeaves((leaf) => {
			// A sidebar panel holding the tracked note is not a second window of
			// it for this purpose: it is not a tab the reader switches between,
			// and the history never records it either. This plugin's own sidebar
			// panel is not even a FileView, so it could not be mistaken for one.
			if (!isMainAreaLeaf(this.opts.app, leaf))
				return;
			const view = leaf.view;
			if (view instanceof FileView) {
				if (view.file)
					live.push({ leafId: leafIdOf(leaf), key: view.file.path });
				return;
			}
			const viewType = view?.getViewType();
			if (viewType && RECORDABLE_VIEW_TYPES.has(viewType))
				live.push({ leafId: leafIdOf(leaf), key: viewDestinationKey(viewType) });
		});
		return live;
	}

	private jump(i: number): void {
		// The reader's place first where the shell is staying up: going to a place
		// re-orders the list (it is moved to the end) and a jump re-pushes the stack, so
		// a position left where it was would name whatever slid into that slot (see the
		// option).
		if (this.opts.collapseOnJump)
			this.list.collapse();
		// …then the shell's own reaction, so a dialog is out of the way before
		// the open it triggers runs (see NavHistoryBrowserOptions.onJump).
		this.shellReacts();
		void this.opts.places.travel(i)
			.catch(e => console.error('Position Restore: recent-files travel failed:', e));
	}

	// Run the shell's own reaction to a travel, and let NOTHING it does stop the journey
	// behind it. The callback is the shell's business — a dialog closing, a phone's drawer
	// folding away — and the reader asked to go somewhere: a shell that throws must cost
	// them the reaction, not the travel. (That is not hypothetical: the resident panel's
	// mobile dismissal once threw on a class the app's runtime module does not export, and
	// every click it answered did nothing.)
	private shellReacts(): void {
		try {
			this.opts.onJump?.();
		} catch (e) {
			console.error('Position Restore: the panel shell failed to react to a travel:', e);
		}
	}
}
