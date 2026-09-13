// "Browse navigation history" panel: the shell. It owns the dialog's lifecycle,
// the render order (list → pinned card → panel), the keyboard, and travel; every
// other piece is a module beside it under nav-history-browser/:
//   - constants.ts          the tuning numbers and the popover class names
//   - model.ts / listing.ts / panes.ts / preview-lines.ts   the pure model
//   - reads.ts              every vault read, cached
//   - list.ts               the rows, the selection, the measured columns
//   - scope-picker.ts       the "only this note" switch, chip and menu
//   - landing-panel.ts      the touch-only landing panel
//   - page-preview.ts       Obsidian's own page preview, driven from a row
// The name says BROWSER because the history itself — how a step is recorded,
// persisted and restored — is nav-history.ts, nav-entry.ts, nav-history-store.ts
// and nav-outline-capture.ts, which this panel only reads.
// Everything re-exports through this module, which stays the panel's public
// entry — main.ts, position-manager.ts and the tests import from here.

import { App, FileView, HoverPopover, Modal, Platform } from 'obsidian';
import { NavHistory } from './nav-history';
import { NavHistoryEntry, RECORDABLE_VIEW_TYPES, isMainAreaLeaf, leafIdOf } from './nav-entry';
import { EphemeralState } from './types';
import { t } from './i18n';
import { BODY_OPEN_CLASS, FIXED_HEIGHT_MIN_ENTRIES } from './nav-history-browser/constants';
import { headingTrailAtLine, NavEntryDescription } from './nav-history-browser/model';
import { formatRelativeTime } from './nav-history-browser/listing';
import { LiveLeaf, PaneInfo, paneInfo, paneLabel, viewDestinationKey } from './nav-history-browser/panes';
import { NavHistoryReads } from './nav-history-browser/reads';
import { LandingPanel } from './nav-history-browser/landing-panel';
import { NavScopePicker } from './nav-history-browser/scope-picker';
import { NavHistoryList } from './nav-history-browser/list';
import { PagePreviewBridge } from './nav-history-browser/page-preview';

export * from './nav-history-browser/constants';
export * from './nav-history-browser/model';
export * from './nav-history-browser/listing';
export * from './nav-history-browser/panes';
export * from './nav-history-browser/preview-lines';
export * from './nav-history-browser/reads';
export * from './nav-history-browser/landing-panel';
export * from './nav-history-browser/scope-picker';
export * from './nav-history-browser/list';
export * from './nav-history-browser/page-preview';

// "Browse navigation history" modal. A destination picker, laid out around
// how a user actually gets lost:
//  - the CURRENT location is a pinned card at the top, so "you are here"
//    never scrolls out of view;
//  - the default list is CHRONOLOGICAL (newest first), split into forward and
//    back segments around the pinned card, each row labelled with a relative
//    time — the index a user remembers "where I was" by;
//  - Enter acts on the SELECTED row and on nothing else: going back one step
//    is the app's own back command (a hotkey on the desktop, a named command on
//    a phone), which needs no panel at all, and the entry it would reach is the
//    first row of the back segment anyway — visible, and showing where it
//    lands before the click commits to it;
//  - picking a spot is by RECOGNITION, never by retrieval, and that is what a
//    row's hover is for: on a pointing device it asks Obsidian's own page
//    preview for the whole note (see PagePreviewBridge.request), and on a touch device
//    — where there is no hover — the same information is a panel under the list,
//    with the tap-to-point model and a button to travel;
//  - the toolbar can narrow the list to matching text, and to ONE file: a
//    direct switch for the note the pinned card shows (the commonest pick, one
//    click), and a dropdown of every note the history has been in for the rest.
//    The two compose with the text filter, and the scope is what makes "where
//    in this note was I" askable at all;
//  - choosing an entry time-travels there (NavHistory.jumpTo): the target is
//    re-pushed on top, so back always returns to where you were.
// Repeat landings collapse into one row with a ×N count, so the list shows
// distinct places rather than distinct steps (the step count stays in the
// segment headers). A missing file's row is rendered but never selectable:
// jumping to it moves the stack pointer while nothing can be restored.
export class NavHistoryModal extends Modal {
	// The list of steps, its rows and what is pointed at (see NavHistoryList).
	private list!: NavHistoryList;
	// The search box's text. The list's own query.
	private filter = '';
	// The file scope (the switch, the chip and its menu) and the state it
	// carries. Not called `scope`: Modal already owns that name for its keymap
	// scope, and shadowing it does not typecheck.
	private scopePicker!: NavScopePicker;
	private hereEl!: HTMLElement;
	private previewEl!: HTMLElement;
	// Where the preview panel waits when it has no row to open under (touch).
	private previewHost!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private panes: PaneInfo = { live: new Map() };
	// Every vault read the panel makes, cached: an entry's display pieces, a
	// file's parsed headings, and a file's lines (see reads.ts).
	private reads: NavHistoryReads;
	// The touch-only landing panel (see LandingPanel).
	private panel!: LandingPanel;
	// Obsidian's own page preview, driven from a row's section column (see
	// PagePreviewBridge).
	private pagePreview!: PagePreviewBridge;
	private closed = false;
	// Touch devices have no hover at all, so the pointer's "point at a row" and
	// its "go there" are the same gesture. Read once, here: the tap semantics
	// below are the only thing that branches on it.
	private mobile = Platform.isMobile;
	// Where the core "Page preview" plugin parks the popover it shows for us
	// (the HoverParent contract). Declared because Obsidian's Modal is not a
	// HoverParent in its own typings, even though the plugin assigns this field
	// at runtime and reads it back to hide its own popover.
	hoverPopover: HoverPopover | null = null;

	constructor(
		app: App,
		private nav: NavHistory,
		savedPosition?: (path: string) => EphemeralState | undefined,
	) {
		super(app);
		this.reads = new NavHistoryReads(app, nav, {
			savedPosition,
			// A deferred read landed: the landing panel is what waits for it.
			onLinesRead: () => this.panel.render(),
			isClosed: () => this.closed,
		});
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		// The landing panel is touch-only (see LandingPanel.render): a pointing device
		// has the native page preview instead. One flag, so the class and the
		// rendering decision can never disagree.
		this.modalEl.toggleClass('is-touch', this.mobile);
		// The native page preview we ask for from a row would otherwise render
		// behind this dialog (see BODY_OPEN_CLASS).
		document.body.addClass(BODY_OPEN_CLASS);
		this.pagePreview = new PagePreviewBridge({
			app: this.app,
			modalEl: this.modalEl,
			hoverParent: this,
			popover: () => this.hoverPopover,
			entryAt: rep => this.nav.entries[rep],
			describe: rep => this.reads.describe(rep),
			isClosed: () => this.closed,
		});
		// A resting place for the preview's edges: without a value the
		// stylesheet's clamp would pin the first popover to the window's corner
		// before any row has been pointed at.
		this.pagePreview.place(null);
		// The modal is sized in % of the window, so a resize moves the rows the
		// preview is placed against; the core plugin re-runs its own placement
		// on resize, and this keeps OUR coordinate in step with it.
		window.addEventListener('resize', this.onWindowResize);
		// Pin the height once the list overflows, so filtering can't resize
		// the modal and shift it vertically (see styles.css is-fixed).
		this.modalEl.toggleClass('is-fixed', this.nav.entries.length > FIXED_HEIGHT_MIN_ENTRIES);
		this.titleEl.setText(t('navHistory.overview.name'));
		// One keydown listener on the modal covers both the filter input and
		// the list: while typing, arrows navigate and Enter jumps (the input
		// would otherwise move its caret); Escape stays native (closes).
		this.modalEl.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		this.toolbar();
		// A click anywhere else in the panel puts the scope menu away — the
		// filter box, a row, the card. The chip and its items are inside the
		// wrapper, so this cannot fight the click that opened the menu.
		this.modalEl.addEventListener('click', (ev) => {
			const el = ev.target as HTMLElement | null;
			if (!el?.closest?.('.position-restore-nav-scope'))
				this.scopePicker.closeMenu();
		});
		this.hereEl = this.contentEl.createDiv({ cls: 'position-restore-nav-here' });
		// The list, and the landing panel. It starts out beside the list, but on
		// a touch device it does not stay there: it opens UNDER the selected row,
		// inside the list's own scroll (see LandingPanel.render) — a panel parked at
		// the bottom of the dialog runs out of room the moment there is history
		// to scroll, and then the one control that can travel with a finger (its
		// "jump here" button) is off-screen.
		const body = this.contentEl.createDiv({ cls: 'position-restore-nav-body' });
		const listEl = body.createDiv({ cls: 'position-restore-nav-list' });
		this.list = new NavHistoryList({
			list: listEl,
			mobile: this.mobile,
			entries: this.nav.entries,
			currentIndex: this.nav.index,
			filter: () => this.filter,
			scope: () => this.scopePicker.scope,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			onPointed: () => this.panel.render(),
			onRevealPanel: () => this.panel.reveal(),
			onRequestPreview: (ev, row, rep) => this.pagePreview.request(ev, row, rep),
			// A showing popover is anchored to the row's own top edge (see
			// PagePreviewBridge.reposition), so scrolling the list while one is
			// up moves the row out from under it. Only re-placed while a popover
			// is actually showing: otherwise this would write the body's style
			// on every wheel tick.
			onScroll: () => this.pagePreview.reposition(),
			onTravel: rep => this.jump(rep),
		});
		this.previewEl = body.createDiv({ cls: 'position-restore-nav-preview' });
		// Where the panel waits while it has no row to open under.
		this.previewHost = body;
		this.panel = new LandingPanel({
			panel: this.previewEl,
			parkAt: this.previewHost,
			mobile: this.mobile,
			previewed: () => this.list.pointed,
			entryAt: rep => this.nav.entries[rep],
			rowOf: rep => this.list.rowOf(rep),
			describe: rep => this.reads.describe(rep),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			linesFor: path => this.reads.linesFor(path),
			scheduleRead: path => this.reads.scheduleRead(path),
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
		this.reads.cancelRead();
		this.pagePreview.dispose();
		document.body.removeClass(BODY_OPEN_CLASS);
		window.removeEventListener('resize', this.onWindowResize);
	}

	private onWindowResize = (): void => {
		this.pagePreview.place(this.list.rowOf(this.list.pointed) ?? null);
		// The labels did not change with the window, but their font may have.
		this.list.fitColumns();
	};

	private onKeyDown(ev: KeyboardEvent): void {
		// While the scope menu is up it owns the same keys the list does — see
		// NavScopePicker.handleKey, which also explains why Escape is stopped
		// here rather than closing the dialog.
		if (this.scopePicker.handleKey(ev))
			return;
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.list.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.list.move(-1);
		} else if (ev.key === 'Enter') {
			// The selection is the whole story: with nothing pointed at, Enter has
			// nothing to do. (It used to fall back to "go back one step", which
			// made one key mean two things depending on whether the pointer had
			// crossed a row — and duplicated the app's own back command.)
			const selected = this.list.selection;
			if (selected < 0)
				return;
			ev.preventDefault();
			this.jump(selected);
		}
	}

	// The toolbar is built once (not per render), so the filter input keeps
	// its focus and caret while typing re-renders the list underneath.
	private toolbar(): void {
		const bar = this.contentEl.createDiv({ cls: 'position-restore-nav-toolbar' });
		const input = bar.createEl('input', {
			type: 'text',
			cls: 'position-restore-nav-filter',
			attr: { placeholder: t('navHistory.searchPlaceholder') },
		});
		input.addEventListener('input', () => {
			this.filter = input.value;
			// The list, the card's age and the panel all follow the filter, so the
			// whole body re-renders (the toolbar does not).
			this.render();
		});
		this.filterInput = input;
		// The file scope sits beside the search box: "where else in this note
		// was I" is a question the chronological list answers badly, since a
		// handful of cross-file hops buries a note's own landings.
		//
		// TWO controls, ONE state. The switch is the shortcut that was always
		// here — the note the pinned card shows, in one click, and still the
		// commonest pick by far. The picker generalizes it to any note the
		// history has been in, which is what the panel could not answer before.
		// They can never disagree: the switch is checked exactly while the scope
		// IS that note (see NavScopePicker), and picking that note in the menu
		// checks it.
		this.scopePicker = new NavScopePicker({
			bar,
			entries: this.nav.entries,
			home: this.scopePath(),
			mobile: this.mobile,
			focusFilter: () => this.filterInput.focus(),
			onChange: () => this.render(),
		});
		this.scopePicker.build();
		// What the panel can be driven by is the whole difference between the two
		// devices: a keyboard on one, a finger on the other.
		bar.createSpan({
			cls: 'position-restore-nav-hint',
			text: t(this.mobile ? 'navHistory.touchHint' : 'navHistory.keyboardHint'),
		});
	}

	// The pinned card's file: the scope its own picker item means. A view step
	// (the graph) has none, and then that item is simply not offered. The
	// current entry cannot change while the modal is open (only jump() moves
	// the pointer, and it closes first), so this is stable for the modal's
	// lifetime — which is why the picker's contents can be built once, with the
	// rest of the toolbar.
	private scopePath(): string | undefined {
		const entry = this.nav.entries[this.nav.index];
		return entry && entry.kind !== 'view' ? entry.path : undefined;
	}

	private render(): void {
		this.panes = paneInfo(this.liveLeaves());
		// The list first (it rebuilds rows, the selection and the panel), then the
		// card and the panel around it.
		this.list.render();
		this.renderHere();
		this.panel.render();
	}

	// The pinned "you are here" card: the one entry the list never shows. It is
	// an INDICATOR, not a control: it used to be tappable (to go back one step on
	// touch, to re-apply the current position on a desktop), and neither earned
	// its place — going back one step is the app's own back command, which needs
	// no panel at all, and re-applying where you already are is what closing the
	// dialog does. Both cost a hint line over the list.
	private renderHere(): void {
		const card = this.hereEl;
		card.empty();
		const entry = this.nav.entries[this.nav.index];
		if (!entry)
			return;
		const d = this.reads.describe(this.nav.index);
		const head = card.createDiv({ cls: 'nav-here-head' });
		head.createSpan({ text: `● ${t('navHistory.current')}`, cls: 'nav-here-title' });
		head.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });
		const main = card.createDiv({ cls: 'nav-here-main' });
		main.createSpan({ text: d.file, cls: 'nav-row-file' });
		if (d.line)
			main.createSpan({ text: d.line, cls: 'nav-row-line' });
		if (d.anchor)
			main.createSpan({ text: `“${d.anchor}”`, cls: 'nav-here-anchor' });
	}

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
