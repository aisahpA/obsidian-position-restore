// "Browse navigation history" panel: the shell. It owns the dialog's lifecycle,
// the render order (list → panel), the keyboard, and travel; every
// other piece is a module beside it:
//   - constants.ts          the tuning numbers
//   - model.ts / listing.ts / panes.ts   the pure model
//   - reads.ts              every vault read, cached
//   - list.ts               the tree of notes, the position, the double click
//   - landing-panel.ts      the landing described: head, trail, content switch
//                           and the travel button — the right-hand drawer on a
//                           pointing device, the in-flow panel on touch
//   - preview-content.ts    what that panel draws: the recorded lines, or the
//                           whole note, through Obsidian's markdown renderer
//   - markdown.ts           the recorded lines dressed as markdown for it
// The name says BROWSER because the history itself — how a step is recorded,
// persisted and restored — is the rest of nav-history/ (history.ts, entry.ts,
// store.ts, outline-capture.ts), which this panel only reads and never writes.

import { App, FileView, Modal, Platform } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { NavHistoryEntry, RECORDABLE_VIEW_TYPES } from '@/nav-history/entry';
import { isMainAreaLeaf, leafIdOf } from '@/shared/leaf';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { DRAWER_MIN_WIDTH, FIXED_HEIGHT_MIN_ENTRIES } from './constants';
import { headingTrailAtLine, NavEntryDescription } from './model';
import { LiveLeaf, PaneInfo, paneInfo, paneLabel, viewDestinationKey } from './panes';
import { NavHistoryReads } from './reads';
import { LandingPanel } from './landing-panel';
import { NavPreviewContent } from './preview-content';
import { NavHistoryList } from './list';

// Per-dialog sequence for the list element's id (see NavHistoryModal.listId).
let modalSeq = 0;

// Whether the window has room for the list and the landing panel side by side (see
// DRAWER_MIN_WIDTH). Asked as a media query so that rotating the device — or dragging
// the window across the boundary — can be HEARD (see NavHistoryModal.watchWidth), and
// answered "no" wherever the API is missing (a test environment): the inline
// presentation is the one that needs no second column, so it is the safe default.
function drawerFits(): boolean {
	return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
		? window.matchMedia(`(min-width: ${DRAWER_MIN_WIDTH}px)`).matches
		: false;
}

// "Browse navigation history" modal. A destination picker, laid out around
// how a user actually gets lost:
//  - the list is a TREE OF NOTES, newest note first, one row per note with its
//    landings open under it — by line, top of the note first, and not at all for
//    a note with a single landing, which is a leaf: a note opened ten times is
//    one line, not ten, and two notes sharing a name print their folders to say
//    which is which;
//  - one click opens a note (or closes it again), two clicks travel — and on a
//    touch device, where there is no second click and no hover, one tap says it
//    all: a note's row opens or closes its landings and points at nothing, a
//    landing (or a note with one, which is a leaf) is pointed at and put away
//    again by the same tap, and the panel's own button travels;
//  - the CURRENT note is pinned first and its landing carries the "you are
//    here" marker, so the current position is a place in the same tree — the
//    first row, marked — and not a line of chrome above it;
//  - picking a spot is by RECOGNITION, never by retrieval, which is what the
//    LANDING's recorded lines are for: the few lines the reader was looking at
//    when they left, drawn as markdown so they look like the note they came from
//    (see PreviewContent), with the note as it stands now one switch away. On a
//    pointing device they stand in a column beside the list and follow the row the
//    reader is on — hover and the arrow keys move the SAME position (see list.ts),
//    so there is no separate selection for the drawer to disagree with; where there
//    is no room for two columns (a phone held upright) the same content opens under
//    the tapped row instead, with a button to travel and a pinned bar that stays in
//    reach however long the note is (see LandingPanel);
//  - the toolbar can narrow the list to matching text — a name, a path, a
//    section, a line, or a phrase the step recorded. That is the only narrowing
//    there is: the file scope that used to sit beside it (a "only this note"
//    switch and a chip of every file the history had been in) was a second way
//    to ask a question the search box already answers — a note's name IS text it
//    matches on — and it cost a control, a dropdown and a modal's worth of state
//    to say what typing three letters says;
//  - choosing an entry time-travels there (NavHistory.jumpTo): the target is
//    re-pushed on top, so back always returns to where you were.
// The forward/back segments and the step counts are gone: this panel answers
// "which note, and where in it", and a direction of travel is not part of that
// answer. A deleted note's row is still the note — it opens, and its recorded
// landings still say what stood there — but nothing under it travels.
export class NavHistoryModal extends Modal {
	// The list of steps, its rows and what is pointed at (see NavHistoryList).
	private list!: NavHistoryList;
	// The search box's text. The list's own query.
	private filter = '';
	private previewEl!: HTMLElement;
	// Where the preview panel waits when it has no row to open under (inline).
	private previewHost!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private panes: PaneInfo = { live: new Map() };
	// Every vault lookup the panel makes, cached: an entry's display pieces, a
	// file's parsed headings, the end of a file's frontmatter, and a file's text
	// (see reads.ts).
	private reads: NavHistoryReads;
	// The landing panel: the standing second column beside the list, or the in-flow
	// panel under the tapped row (see LandingPanel).
	private panel!: LandingPanel;
	// What the panel draws as the landing's content: the recorded lines, or the
	// whole note, both through Obsidian's own markdown renderer (see
	// PreviewContent). Owned by the dialog, because the rendered DOM and the
	// components hung on it have to be unloaded when the dialog closes.
	private content: NavPreviewContent;
	private closed = false;
	// The list element's id, unique per dialog: the rows' option ids are built
	// from it and the filter box's aria-activedescendant points at one of them,
	// so a second browser opened over this one cannot collide with it.
	private readonly listId = `position-restore-nav-list-${++modalSeq}`;
	// Touch devices have no hover at all, so there the only way to move the position
	// is a tap and "point at a row" and "go there" are the same gesture. Read once,
	// here: this also picks the hint and whether the filter box focuses itself.
	private mobile = Platform.isMobile;
	// Which of the panel's two presentations this dialog is using: INLINE (the panel
	// opens inside the list, under the row it describes) or the drawer (a standing
	// second column). A pointing device always has the room for the drawer; a touch
	// device gets it whenever the window is wide enough to hold both — a phone held
	// sideways, a tablet — because stacked there the list is one row tall and the panel
	// has nowhere to go. Follows a rotation through watchWidth, and the class and the
	// rendering decision are both read off this one flag, so they cannot disagree.
	private inline = this.mobile && !drawerFits();
	// The width query this dialog follows, and the listener on it: kept so that
	// closing the dialog stops listening to the window (see watchWidth / onClose).
	private widthQuery?: MediaQueryList;
	private onWidth?: () => void;

	constructor(
		app: App,
		private nav: NavHistory,
		savedPosition?: (path: string) => EphemeralState | undefined,
	) {
		super(app);
		this.reads = new NavHistoryReads(app, nav, { savedPosition });
		this.content = new NavPreviewContent({
			app,
			// The browser's only vault read: the panel's whole-note view of a note,
			// and the source view of a file that is not one (see
			// NavHistoryReads.textFor).
			read: path => this.reads.textFor(path),
			// …and the metadata lookup that keeps a recorded block starting inside
			// the properties from rendering as a heading rule (see contextMarkdown).
			frontmatterEnd: path => this.reads.frontmatterEnd(path),
			// Inline, the panel shares the list's scroll, so putting the landing on
			// screen must not move it (see NavPreviewContent's option).
			inline: () => this.inline,
		});
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		// The device's own ergonomics, and separately where the panel goes. One flag
		// per question, so neither class can disagree with the rendering decision it
		// stands for (see mobile / inline). The width is read again here rather than
		// only at construction: it is the window as it is NOW that has the room.
		this.inline = this.mobile && !drawerFits();
		this.modalEl.toggleClass('is-touch', this.mobile);
		this.applyPresentation();
		this.titleEl.setText(t('navHistory.overview.name'));
		// One keydown listener on the modal covers both the filter input and
		// the list: while typing, arrows navigate and Enter jumps (the input
		// would otherwise move its caret); Escape stays native (closes).
		this.modalEl.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		// …and the window itself decides between the two presentations: rotating the
		// device has to move the panel, not wait for the dialog to be reopened.
		this.watchWidth();
		this.toolbar();
		// The list, and the landing panel. With the drawer the panel IS the body's
		// second column (see styles.css) and follows the position. Inline it does not
		// stay there: it opens UNDER the row it describes, inside the list's
		// own scroll (see LandingPanel.render) — a panel parked at the bottom of
		// the dialog runs out of room the moment there is history to scroll, and
		// then the one control that can travel with a finger (its "jump here"
		// button) is off-screen.
		const body = this.contentEl.createDiv({ cls: 'position-restore-nav-body' });
		const listEl = body.createDiv({ cls: 'position-restore-nav-list' });
		// The list is a listbox whose options are the rows (the list tags them;
		// see NavHistoryList.row) and whose current option the filter box names
		// through aria-activedescendant (see setActiveRow). The id is what makes
		// that reference possible, and the label is the dialog's own title.
		listEl.setAttr('id', this.listId);
		listEl.setAttr('role', 'listbox');
		listEl.setAttr('aria-label', t('navHistory.overview.name'));
		this.list = new NavHistoryList({
			list: listEl,
			listId: this.listId,
			mobile: this.mobile,
			entries: this.nav.entries,
			currentIndex: this.nav.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			noteExists: path => this.reads.hasFile(path),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			onPointed: () => this.panel.render(),
			onActiveRow: id => this.setActiveRow(id),
			onRevealPanel: () => this.panel.reveal(),
			onTravel: rep => this.jump(rep),
		});
		this.previewEl = body.createDiv({ cls: 'position-restore-nav-preview' });
		// Where the panel waits while it has no row to open under.
		this.previewHost = body;
		this.panel = new LandingPanel({
			panel: this.previewEl,
			parkAt: this.previewHost,
			list: listEl,
			inline: () => this.inline,
			position: () => this.list.position,
			here: () => this.nav.index,
			standsFor: rep => this.list.standsFor(rep),
			entryAt: rep => this.nav.entries[rep],
			anchorRow: () => this.list.panelAnchor(),
			noteRowOf: row => this.list.noteRowOf(row),
			onPreviewed: rep => this.list.markPreviewed(rep),
			describe: rep => this.reads.describe(rep),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			content: (host, mode, entry, d) => this.content.show(host, mode, entry, d),
			jump: rep => this.jump(rep),
		});
		this.render();
		// A touch device raises its on-screen keyboard the moment an input takes
		// focus, and the keyboard covers half of a small screen — the panel's
		// whole reason for being is the list under it. So on touch the box stays
		// unfocused (one tap away, when the user actually means to type); on a
		// pointing device the keyboard costs nothing and typing is the fastest
		// way through the list, so it keeps the focus.
		if (!this.mobile && this.nav.entries.length > 0)
			this.filterInput.focus();
	}

	onClose() {
		this.closed = true;
		// A closed dialog has no presentation to keep up to date, and the window
		// outlives it: the width listener goes with the dialog.
		this.stopWatchingWidth();
		// The rendered preview and everything hung on it (embeds, math, plugin
		// children) belong to this dialog: closing it unloads them.
		this.content.destroy();
	}

	// Follow the window's width while the dialog is open: rotating a phone, or dragging
	// a window across the width the drawer needs, is a change of PRESENTATION — the
	// panel moves between the list's own flow and the body's second column, which only
	// a re-render can do (see LandingPanel.render). A WebView too old to have the
	// listener API simply keeps the presentation the dialog opened with.
	private watchWidth(): void {
		if (typeof window.matchMedia !== 'function')
			return;
		const query = window.matchMedia(`(min-width: ${DRAWER_MIN_WIDTH}px)`);
		if (typeof query.addEventListener !== 'function')
			return;
		const onWidth = () => this.setPresentation();
		this.widthQuery = query;
		this.onWidth = onWidth;
		query.addEventListener('change', onWidth);
	}

	private stopWatchingWidth(): void {
		const query = this.widthQuery;
		const onWidth = this.onWidth;
		if (query && onWidth && typeof query.removeEventListener === 'function')
			query.removeEventListener('change', onWidth);
		this.widthQuery = undefined;
		this.onWidth = undefined;
	}

	private setPresentation(): void {
		const inline = this.mobile && !drawerFits();
		if (inline === this.inline)
			return;
		this.inline = inline;
		this.applyPresentation();
		// The rows are the same rows (the device has not changed, only the room for
		// two columns): what has to move is the panel.
		this.render();
	}

	// How the panel is presented, as the two classes the stylesheet reads. One place,
	// because the two decisions come from one flag and a rotation has to change both:
	//  - `is-inline`, the panel in the list's own flow (see LandingPanel.render);
	//  - `is-fixed`, the dialog's pinned height. Inline it is NOT optional, even for a
	//    history too short to need it: the panel opens inside the list's scroll, and a
	//    dialog that sizes to its content hands the scrolling to THE MODAL as soon as a
	//    panel opens — where a scroll drags the whole list, the row a finger just tapped
	//    included, out of the dialog. Pinned, the list is the one scroller there is, and
	//    the panel scrolls under the reader inside it. (A pointing device keeps the old
	//    rule: a three-entry list in a full-height box is mostly dead space.)
	private applyPresentation(): void {
		this.modalEl.toggleClass('is-inline', this.inline);
		this.modalEl.toggleClass('is-fixed',
			this.inline || this.nav.entries.length > FIXED_HEIGHT_MIN_ENTRIES);
	}

	private onKeyDown(ev: KeyboardEvent): void {
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.list.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.list.move(-1);
		} else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
			// The tree's own moves: close and open the note under the position,
			// which is what a row's single click does and the vertical walk
			// cannot. Only an open/close is consumed — the left and right arrows
			// keep their ordinary meaning in the filter box otherwise.
			if (this.list.handleKey(ev))
				ev.preventDefault();
		} else if (ev.key === 'Enter') {
			// Enter acts on the POSITION and on nothing else — the one row the mouse
			// moves by hovering and the arrows by walking (see the list's choose) — and
			// with no position it does nothing. (It used to fall back to "go back one
			// step", which made one key mean two things depending on whether the pointer
			// had crossed a row — and duplicated the app's own back command.)
			// The travel goes through the list, which is what knows whether the
			// row the position is on may be travelled to: a note whose file is gone
			// opens (and is where "file deleted" is explained) but never jumps.
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
		const bar = this.contentEl.createDiv({ cls: 'position-restore-nav-toolbar' });
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
			// The list and the panel both follow the filter, so the
			// whole body re-renders (the toolbar does not).
			this.render();
		});
		this.filterInput = input;
		// The hint, and nothing else: the box is the whole toolbar. The file
		// scope that used to sit beside it — a "only this note" switch and a chip
		// of every note the history had been in — is gone: a note's name is text
		// the box already matches, so the two controls were a slower way to type
		// it, and they cost the list the width and the row they stood on.
		// What the panel can be driven by is the whole difference between the two
		// devices: a keyboard on one, a finger on the other.
		bar.createSpan({
			cls: 'position-restore-nav-hint',
			text: t(this.mobile ? 'navHistory.touchHint' : 'navHistory.keyboardHint'),
		});
	}

	private render(): void {
		this.panes = paneInfo(this.liveLeaves());
		// The list first (it rebuilds rows, the selection and the panel), then the
		// panel around it.
		this.list.render();
		this.panel.render();
	}

	// The "you are here" CARD that used to stand between the toolbar and the list
	// is gone. The current entry is a row in the tree like any other — pinned
	// first, marked `●` — and the card said the same thing a second time, in a
	// second place, in a second layout: one line of chrome bought with the height
	// the list needed, and a reader had to learn which of the two "current
	// position"s was authoritative. The row is.

	// The heading chain the entry's landing sits in. Empty for a view entry, a
	// deleted file, or an entry with no recorded line.
	private trailFor(entry: NavHistoryEntry, d: NavEntryDescription): string[] {
		if (entry.kind === 'view' || d.missing || d.lineIndex === undefined)
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
		this.app.workspace.iterateAllLeaves((leaf) => {
			// A sidebar panel holding the tracked note is not a second window of
			// it for this purpose: it is not a tab the reader switches between,
			// and the history never records it either.
			if (!isMainAreaLeaf(this.app, leaf))
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
		this.close();
		void this.nav.jumpTo(i)
			.catch(e => console.error('Position Restore: history jump failed:', e));
	}
}
