// The recent-files browser's BODY: everything about the panel that is not a shell.
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
//   - model.ts / listing.ts           the pure model
//   - reads.ts                        every vault lookup, cached and metadata-only
//   - list.ts                         the list of notes and the position in it
// The name says BROWSER because the list itself — which places exist, how they are
// recorded, persisted and travelled to — is the rest of recent-files/ (places.ts and
// places-store.ts beside this directory), over the shared entry vocabulary in
// nav/entry.ts, which this panel only reads and never writes.
//
// READ-ONLY, and that is what makes a RESIDENT panel possible at all: the body draws
// whatever the place list holds at the moment render() is called. The list's own snapshot
// is refreshed from the places on every render (see render), so a shell that lives for
// hours shows the history as it stands rather than as it stood when the panel opened — and
// one that lives for a second (the modal) is not asked for anything more.

import { App, Menu, TFile, setIcon, Keymap } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { PlaceList, placeKey } from '@/recent-files/places';
import { EphemeralState, LandingsMode, PathDisplayMode } from '@/types';
import { t } from '@/i18n';
import { headingTrailAtLine, NavEntryDescription } from './model';
import { RecentFilesReads } from './reads';
import { RecentFilesList, RecentFilesListOptions } from './list';
import { TIME_REFRESH_MS } from './constants';

// Per-body sequence for the list element's id (see RecentFilesBrowser.listId).
let browserSeq = 0;

// The preferences the browser DRAWS BY, handed to every shell by the plugin that
// persists them (see PluginSettings and PositionManager.browserPrefs). All are
// READERS over the one shared settings object rather than values: a resident panel draws
// its list from a call made during render, so a change made elsewhere is picked up by
// the next redraw instead of being frozen into the panel that happened to be open.
//
// Readers and nothing else, because none of them is CHOSEN here any more: all four
// are rows of the plugin's settings tab (see ui/settings-tab.ts), which is where a
// reader reaches for a setting anyway. The copy the toolbar's gear used to carry is
// gone with the gear — two places to change one value is one place to forget.
export interface RecentFilesBrowserPrefs {
	// How much of one note the list prints (see LandingsMode).
	landings: () => LandingsMode;
	// How many places the recent-files list keeps.
	placesCap: () => number;
	// How much of a row's path the list prints, and on which side of the name (see
	// PathDisplayMode).
	pathDisplay: () => PathDisplayMode;
	// Whether each row says how long ago it was last visited (see model.ts's
	// ageLabel). The only one of the four that is a plain switch: there is nothing
	// to pick between, only whether the row carries the label at all.
	rowTime: () => boolean;
}

export interface RecentFilesBrowserOptions {
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
	// when a field takes focus, and a × worth tapping where a mouse gets a few
	// pixels. The list's own interaction is the same either way: it is click-only
	// on every device (see RecentFilesList).
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
	// The browser's preferences, handed down by the shell (see RecentFilesBrowserPrefs):
	// how much of a note the list prints, and how much of a row's path.
	prefs: RecentFilesBrowserPrefs;
}

export class RecentFilesBrowser {
	// The list of steps, its rows and what is pointed at (see RecentFilesList).
	private list!: RecentFilesList;
	// The list's options object, kept because two of its fields are the LIVE
	// stack and are re-pointed before every render (see render): the list reads
	// its entries through this object, so a resident panel is refreshed by
	// assigning to it rather than by rebuilding the list (which would drop the
	// position the reader was on).
	private listOpts!: RecentFilesListOptions;
	// The search box's text. The list's own query.
	private filter = '';
	private filterInput!: HTMLInputElement;
	// Every vault lookup the panel makes, cached — all of them metadata-cache
	// lookups: an entry's display pieces and a file's parsed headings (see
	// reads.ts).
	private reads: RecentFilesReads;
	// The list element's id, unique per body: the rows' option ids are built
	// from it and the filter box's aria-activedescendant points at one of them,
	// so a second browser mounted beside this one — a sidebar panel and the
	// modal at once — cannot collide with it.
	private readonly listId = `position-restore-nav-list-${++browserSeq}`;
	// The group order the list is being HELD at, while the pointer is on it (see
	// freezeOrder), or undefined when the list is nobody's business but the places'.
	// Held as group keys rather than as rows because a rebuild draws new rows: the
	// order has to survive the redraw it is there to stop from re-ordering anything.
	private frozenOrder?: string[];
	// The interval that re-derives the rows' ages while the panel sits idle (see
	// TIME_REFRESH_MS). Held because destroy is the one place that can stop it, and
	// because a shell may mount and destroy a body many times in one app run.
	private timer?: number;

	constructor(private opts: RecentFilesBrowserOptions) {
		this.reads = new RecentFilesReads(opts.app, {
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
		// RecentFilesList.row) and whose current option the filter box names through
		// aria-activedescendant (see setActiveRow). The id is what makes that reference
		// possible, and the label is the panel's own name.
		listEl.setAttr('id', this.listId);
		listEl.setAttr('role', 'listbox');
		listEl.setAttr('aria-label', t('recentFiles.name'));
		this.listOpts = {
			list: listEl,
			listId: this.listId,
			// How much of a note to print, and how much of its path: read LIVE (see
			// RecentFilesBrowserPrefs), so the toolbar's setting reaches a panel that is
			// already up.
			landings: () => this.opts.prefs.landings(),
			pathDisplay: () => this.opts.prefs.pathDisplay(),
			rowTime: () => this.opts.prefs.rowTime(),
			// The order to hold, while the pointer is on the list (see
			// freezeOrder). Read per render, so a render that happens while the
			// reader is on the list comes out in the order they are reading.
			order: () => this.frozenOrder,
			// What makes two places one, for a click whose row has been rebuilt
			// away from under it (see RecentFilesList.onClick). The store's own
			// notion of identity, reached through the list it was handed.
			keyOf: (rep) => {
				const entry = this.opts.places.entries[rep];
				return entry ? placeKey(entry) : undefined;
			},
			// The live places, re-pointed per render (see render).
			entries: this.opts.places.entries,
			currentIndex: this.opts.places.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			// Whether a place may be listed at all: a name the list cannot open is not a
			// row (see RecentFilesList.render and RecentFilesReads.hasFile). The store
			// prunes such a place on its own; this is the list agreeing with it.
			noteExists: path => this.reads.hasFile(path),
			trailFor: (entry, d) => this.trailFor(entry, d),
			// The file's other names (see RecentFilesReads.aliasesFor): searchable, and
			// printed nowhere on the row but its tooltip.
			aliasesFor: path => this.reads.aliasesFor(path),
			onActiveRow: id => this.setActiveRow(id),
			onTravel: (rep, target) => this.jump(rep, target),
			// A right-click asks the APP what it can do with this file; the menu is
			// built here because the list does not hold the app (see contextRow).
			onContextRow: (rep, ev) => this.contextRow(rep, ev),
		};
		this.list = new RecentFilesList(this.listOpts);
		// The pointer is how the body knows the reader is USING this list, which is
		// the question the held order answers (see frozenOrder). Both listeners are
		// on the list element and go with it; nothing to undo in destroy.
		//
		// pointerover rather than pointerenter: a panel that comes up under a pointer
		// that is already resting there — the sidebar restored at startup, the modal
		// opened by a command while the mouse sits mid-screen — never crosses the
		// boundary, so the enter never fires and the order would never be taken. Any
		// move inside the list bubbles an over, so the first twitch of the pointer
		// makes up for it. Taking the order is idempotent (see freezeOrder), so the
		// repeated events cost nothing.
		//
		// A FINGER IS NOT A POINTER HERE, and hearing it is what breaks a phone's
		// gestures. Touch delivers the same pair of events — an over with the press,
		// and an out/leave the moment the browser decides the finger is panning or
		// that the app is dragging something — and the leave arrives while the finger
		// is STILL DOWN, so thawOrder's redraw replaced every row underneath a touch
		// that was in the middle of becoming a scroll: the row the touch had landed
		// on was gone, and with it the gesture (a scroll that loses its target stops;
		// the drawer being dragged sideways loses the touchmove that was moving it
		// and is left standing part-folded). A finger resting on a row is not reading
		// the list — it is about to tap it — so there is no order to hold for it.
		listEl.addEventListener('pointerover', (ev) => {
			if (ev.pointerType !== 'touch')
				this.freezeOrder();
		});
		listEl.addEventListener('pointerleave', (ev) => {
			if (ev.pointerType !== 'touch')
				this.thawOrder();
		});
		// …and the click the ROWS did not answer. A click bubbles from the row it
		// landed on, so this sees one only when there was no row element left to be
		// the target — the row was rebuilt away between the press and the release —
		// which is exactly the click the list has to answer by identity (see
		// RecentFilesList.onUnansweredClick).
		listEl.addEventListener('click', (ev) => this.list.onUnansweredClick(ev));
		// One keydown listener on the shell's own element covers both the filter
		// input and the list: while typing, arrows navigate and Enter jumps (the
		// input would otherwise move its caret); Escape stays native (closes the
		// dialog, and in a sidebar does nothing, which is what "resident" means).
		this.opts.host.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		this.render();
		// The ages on the rows are read off a clock, so a panel nobody is touching would
		// drift: "5m" would sit there while the note it names got an hour old. Two
		// cheap things keep it honest, and neither needs the other —
		//   - the interval, for a panel that is simply standing there (see
		//     TIME_REFRESH_MS: it is a coarse number, so the tick is coarse too), and
		//   - becoming visible again, which is the case an interval cannot cover at all:
		//     a tab in the background has its timers throttled and may not run for
		//     hours, and the reader coming back is exactly when the labels are wrong.
		// A redraw while the reader is reading is not a redraw they see: the rows are
		// held in place, and a label that changes text is the one thing that may move.
		this.timer = window.setInterval(() => {
			if (document.hidden || !this.opts.prefs.rowTime())
				return;
			this.render();
		}, TIME_REFRESH_MS);
		document.addEventListener('visibilitychange', this.onVisibilityChange);
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
		this.list.render();
	}

	// The reader's pointer is on the list, so the list is being READ: take the order
	// it is showing right now and hold it there (see frozenOrder, and
	// RecentFilesListOptions.order). This is the whole of the answer to "has the list
	// changed under me?" — the question is not which change was real, it is whether
	// anyone is still looking, and the pointer is that question's honest answer.
	//
	// Nothing happens if an order is already held: the first over takes it, and every
	// further one is the same fact said again.
	private freezeOrder(): void {
		if (this.frozenOrder)
			return;
		const keys = this.list.orderedKeys();
		// An empty list holds nothing: there is no order to keep, and holding `[]`
		// would pin every later arrival to the front (see groupByFile's rank).
		if (keys.length)
			this.frozenOrder = keys;
	}

	// The pointer has left: nobody is reading this list, so it may catch up with the
	// places. The redraw is what makes the catch-up visible, and it happens HERE —
	// while the reader's attention is following the note they just opened — rather
	// than on the next history change, which may not come for minutes.
	private thawOrder(): void {
		if (!this.frozenOrder)
			return;
		this.frozenOrder = undefined;
		this.render();
	}

	// Throw away what belongs to this body: everything below was registered beside
	// elements the shell owns, and each of them outlives those elements (see the
	// shell's teardown).
	destroy(): void {
		// The list put one thing OUTSIDE the panel's element — the tooltip it draws on
		// the document (see tip.ts) — so a body that goes without this leaves a stray
		// element behind for every dialog ever opened.
		this.list.destroy();
		// The metadata watcher belongs to the READS, and it outlives the DOM it was
		// built beside: a dialog is a new reads object every time it opens, and a
		// sidebar panel can be closed and reopened many times in one app run.
		this.reads.dispose();
		// The interval and the document listener OUTLIVE the elements they were
		// registered beside — the timer would go on redrawing a panel that is gone, and
		// a modal is a new body every time it opens.
		if (this.timer !== undefined)
			window.clearInterval(this.timer);
		this.timer = undefined;
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
	}

	// The panel became visible again (or was hidden). Only the visible half matters:
	// a hidden panel is not being read, and the reader coming back is what the tick
	// cannot be trusted to have covered.
	private onVisibilityChange = (): void => {
		if (!document.hidden && this.opts.prefs.rowTime())
			this.render();
	};

	private onKeyDown(ev: KeyboardEvent): void {
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
			// The keyboard's own "new tab": the focus never leaves the filter box, so
			// the row's modifier-click is out of reach — Cmd/Ctrl+Enter is the gesture
			// every list in the app answers to. 'Mod' is the app's platform-independent
			// name for it (Cmd on macOS, Ctrl elsewhere): reading metaKey/ctrlKey here
			// would be a second copy of that rule, and the wrong one on one platform.
			const target = Keymap.isModifier(ev, 'Mod') ? 'tab' : undefined;
			if (this.list.travel(undefined, target))
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
		// The box and its × are one control, so they are one element: the clear button
		// is positioned against the box's own line (see styles.css) and is hidden while
		// there is nothing to clear, which is a question only the box can answer.
		const strip = bar.createDiv({ cls: 'position-restore-nav-search' });
		const input = strip.createEl('input', {
			type: 'text',
			cls: 'position-restore-nav-filter',
			attr: {
				placeholder: t('recentFiles.searchPlaceholder'),
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
		// The one gesture the box has, shared by typing and by the ×: what the reader
		// typed IS the list's query, so the list is redrawn from it.
		const apply = (): void => {
			this.filter = input.value;
			// The list follows the filter, so the body re-renders (the toolbar does
			// not).
			this.render();
		};
		input.addEventListener('input', apply);
		this.filterInput = input;
		// THE ×, exactly as the app's own search boxes carry one (see the quick
		// switcher, whose clear button this copies): the press is REFUSED so that the
		// caret never leaves the box — a control that takes the focus turns the next
		// keystroke into nothing — and the click empties the box and re-reads the list
		// from it. Emptying an empty box is the same as emptying it once, so with
		// nothing to clear the button does no more than put the caret back.
		//
		// A plain div and not a button, for the same reason the app's is: it is not a
		// stop on the keyboard's way through the panel (the box keeps every key), and a
		// tabbable control inside a combobox's strip would be a stop that answers to Tab
		// and then takes the arrows the box was holding. The name is still there for
		// whatever reads the DOM and is the only label a mouse needs; the `title` beside
		// it is the quiet tooltip this panel keeps for its own chrome (see styles.css's
		// --no-tooltip note).
		const clear = strip.createDiv({
			cls: 'clickable-icon position-restore-nav-clear',
			attr: {
				'aria-label': t('recentFiles.clearFilter'),
				title: t('recentFiles.clearFilter'),
			},
		});
		setIcon(clear, 'x');
		clear.addEventListener('mousedown', (ev) => ev.preventDefault());
		clear.addEventListener('click', () => {
			if (input.value !== '') {
				input.value = '';
				apply();
			}
			// The caret goes back where the reader's typing is — on a pointing device,
			// where the box is one click from being typed in and usually already is. On
			// TOUCH the focus is left exactly as it was: a finger that tapped × either
			// was typing (the box keeps its caret, mousedown was refused) or was not, and
			// summoning the on-screen keyboard over half the panel is the opposite of
			// what the tap asked for (see mount's own touch rule).
			if (!this.opts.touch)
				input.focus();
		});
		// …and that is the whole strip: the box, and nothing beside it. The file scope
		// that used to stand here — a "only this note" switch and a chip of every note
		// the history had been in — is gone: a note's name is text the box already
		// matches, so the two controls were a slower way to type it, and they cost the
		// list the width and the row they stood on. So is the gear that used to stand at
		// the strip's far end — its four choices are rows of the plugin's settings tab
		// now (see RecentFilesBrowserPrefs) — and so is the hint that used to say "click a row
		// to open it": a row in a list answers a click everywhere else in the app, and
		// the sentence was buying its line with the height the list needed.
	}

	// The "you are here" CARD that used to stand between the toolbar and the list
	// is gone. The current entry is a row in the list like any other — pinned
	// first — and the card said the same thing a second time, in a second place,
	// in a second layout: one line of chrome bought with the height the list
	// needed, and a reader had to learn which of the two "current position"s was
	// authoritative. The row is.

	// The heading chain the entry's landing sits in. Empty for a view entry or an
	// entry with no recorded line.
	private trailFor(entry: NavEntry, d: NavEntryDescription): string[] {
		if (entry.kind === 'view' || d.lineIndex === undefined)
			return [];
		return headingTrailAtLine(this.reads.headingsFor(entry.path), d.lineIndex);
	}

	private jump(i: number, target?: PaneTarget): void {
		// The reader's place first where the shell is staying up: going to a place
		// re-orders the list (it is moved to the end) and a jump re-pushes the stack, so
		// a position left where it was would name whatever slid into that slot (see the
		// option).
		if (this.opts.collapseOnJump)
			this.list.collapse();
		// …then the shell's own reaction, so a dialog is out of the way before
		// the open it triggers runs (see RecentFilesBrowserOptions.onJump).
		this.shellReacts();
		void this.opts.places.travel(i, target)
			.catch(e => console.error('Position Restore: recent-files travel failed:', e));
	}

	// A row was right-clicked: raise the APP's own menu for the file behind it.
	//
	// The menu is the app's and not ours, and that is deliberate: what a reader can do
	// with a file (open it beside, copy a link, reveal it, rename it, whatever the
	// app's own version of this menu holds) is the app's business, and a second list of
	// those commands written here would be a stale copy of it. The ONE thing added is
	// the thing the app cannot know: a row of PLACES promises a specific landing, so a
	// jump row gets its own "open here in a new tab" (see the two locale keys).
	//
	// The context asked for is the LINK one, not the file explorer's: a row here is a
	// pointer at a file rather than the file in its own tree, and the file-managing
	// actions (rename, move, delete) do not belong to a reader who came here to go
	// somewhere. The panel's read-only promise is intact either way: nothing in this
	// handler writes anything, and whatever the reader picks from the menu is something
	// they asked the APP to do.
	private contextRow(rep: number, ev: MouseEvent): void {
		const entry = this.opts.places.entries[rep];
		// A pathless view (the graph) has no file: a file menu has nothing to be about.
		if (!entry || entry.kind === 'view')
			return;
		const file = this.opts.app.vault.getAbstractFileByPath(entry.path);
		if (!(file instanceof TFile))
			return;
		const menu = new Menu();
		// Our own item goes FIRST (section 'action', which the app sorts ahead of its
		// own sections), because it is the one entry the reader cannot get anywhere
		// else for THIS row: core's menu can offer "open in a new tab" for the file, but
		// only this list knows the landing the row stands for.
		menu.addItem(item => item
			.setSection('action')
			.setTitle(t(entry.kind === 'jump'
				? 'recentFiles.menu.openHereInNewTab'
				: 'recentFiles.menu.openInNewTab'))
			.setIcon('file-plus')
			.onClick(() => this.jump(rep, 'tab')));
		this.opts.app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		menu.showAtMouseEvent(ev);
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
