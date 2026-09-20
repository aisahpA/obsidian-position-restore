// "Browse navigation history" panel: the MODAL shell around the browser body
// (see body.ts for everything that is not a shell, and view.ts for the
// resident sidebar panel that shares it).

import { App, Modal, Platform } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { DRAWER_MIN_WIDTH, FIXED_HEIGHT_MIN_ENTRIES } from './constants';
import { NavHistoryBrowser, NavBrowserPrefs } from './body';

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

// A destination picker, laid out around how a user actually gets lost:
//  - the list is NOTES, newest note first, one row per note — a note opened ten
//    times is one line, not ten, and two notes sharing a name print their folders
//    to say which is which. What the list prints UNDER a note is the toolbar's own
//    setting (see LandingsMode): by default nothing, and the row stands for the place
//    the reader left that note at — the one their back button keeps returning to,
//    which is what the row OPENS. 'All' prints the note's other places under it, by
//    line, top of the note first, nearby ones already folded into one row (see
//    groupByFile); without it the older ones are still reachable through the search
//    box, which matches the lines that were there (see list.ts);
//  - the ROW ITSELF IS THE NAVIGATION: a click opens the file at the place the row
//    stands for (see NavHistoryList.onClick). The panel is a navigator, so going
//    somewhere is the first thing it does, and the whole width of a row is that
//    target. A note's row and a place's row take the same gesture, because there is
//    only one thing a row can be asked: WHERE. A row with nowhere to open — a
//    deleted note — simply does nothing, while the one the reader is already in
//    opens the file back (the jump re-lands the place rather than pushing it again);
//  - the row's OTHER half is the control in its left gutter: one click and the panel
//    beside it describes THAT row — the recorded spot it stands for, or the note as it
//    stands now (see LandingPanel) — and a second click puts it away again. So a row
//    is an OPEN and a LOOK, two hotspots that never reach into each other, and
//    nothing answers a pointer that merely passed over a row (see list.ts): a drawer
//    that followed the mouse described whatever it happened to cross;
//  - the CURRENT note is pinned first, so the current position is a place in the
//    same list — the first row — and not a line of chrome above it. The ● of "you
//    are here" rides on the LANDING that holds the current entry, where it tells one
//    spot from another (see NavHistoryList.placeRow): on the note's own row it could
//    only ever sit on row one, saying what the position already says;
//  - picking a place is by RECOGNITION, never by retrieval, which is what the
//    LANDING's recorded lines are for: the few lines the reader was looking at
//    when they left, drawn as markdown so they look like the note they came from
//    (see PreviewContent), with the note as it stands now one gear setting away. They
//    stand in a column beside the list and describe the row whose gutter control was
//    used — the same row the keyboard walks (see list.ts), so there is no separate
//    selection for the drawer to disagree with; where there is no room for two columns
//    (a phone held upright) the same content opens under that row instead, with a
//    pinned bar that stays in reach however long the note is (see LandingPanel);
//  - the toolbar can narrow the list to matching text — a name, a path, a
//    section, a line, or a phrase the step recorded. That is the only narrowing
//    there is: the file scope that used to sit beside it (a "only this note"
//    switch and a chip of every file the history had been in) was a second way
//    to ask a question the search box already answers — a note's name IS text it
//    matches on — and it cost a control, a dropdown and a modal's worth of state
//    to say what typing three letters says;
//  - choosing an entry time-travels there (NavHistory.jumpTo): the target is
//    re-pushed on top, so back always returns to where you were. The dialog closes
//    itself on the way out (see onJump) — a picker that has answered its question
//    gets out of the way.
// The forward/back segments and the step counts are gone: this panel answers
// "which note, and where in it", and a direction of travel is not part of that
// answer. A deleted note's row is still the note — the panel says what stood there —
// but the row itself has nowhere to open.
//
// WHAT MAKES IT A MODAL, and nothing else does: the window's own width decides
// whether the drawer has room (a dialog is as wide as the window it sits in —
// see view.ts for the pane-width question a sidebar has to ask instead), the
// dialog closes the moment a row is travelled to, and the filter box takes the
// focus on open.
export class NavHistoryModal extends Modal {
	// The panel itself: the toolbar, the rows, the landing panel and the
	// keyboard (see body.ts).
	private browser!: NavHistoryBrowser;
	// The device's own ergonomics, and nothing about how the list is driven: it is
	// click-only everywhere (see list.ts). Read once, here: the touch flag picks the
	// hint and decides whether the filter box focuses itself.
	private mobile = Platform.isMobile;
	// Which of the panel's two presentations this dialog is using: INLINE (the panel
	// opens inside the list, under the row it describes) or the drawer (a standing
	// second column). A touch device gets the drawer whenever the window is wide
	// enough to hold both — a phone held sideways, a tablet — because stacked there
	// the list is one row tall and the panel has nowhere to go; a pointing device
	// always has the room for it. Follows a rotation through watchWidth, and the class
	// and the rendering decision are both read off this one flag, so they cannot
	// disagree.
	private inline = this.mobile && !drawerFits();
	// The width query this dialog follows, and the listener on it: kept so that
	// closing the dialog stops listening to the window (see watchWidth / onClose).
	private widthQuery?: MediaQueryList;
	private onWidth?: () => void;

	constructor(
		app: App,
		private nav: NavHistory,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// The browser's own preferences (see NavBrowserPrefs): the plugin owns and
		// persists them, this shell only hands them down.
		private prefs: NavBrowserPrefs,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		// The class the two shells share: what the panel's presentation rules are
		// written against (see styles.css), so a sidebar panel and this dialog
		// cannot drift apart in their quiet tiers, their inline panel or their
		// touch layout.
		this.modalEl.addClass('position-restore-nav-panel');
		// The device's own ergonomics, and separately where the panel goes. One flag
		// per question, so neither class can disagree with the rendering decision it
		// stands for (see mobile / inline). The width is read again here rather than
		// only at construction: it is the window as it is NOW that has the room.
		this.inline = this.mobile && !drawerFits();
		this.modalEl.toggleClass('is-touch', this.mobile);
		this.applyPresentation();
		this.titleEl.setText(t('navHistory.overview.name'));
		// …and the window itself decides between the two presentations: rotating the
		// device has to move the panel, not wait for the dialog to be reopened.
		this.watchWidth();
		this.browser = new NavHistoryBrowser({
			app: this.app,
			nav: this.nav,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			// The list is click-only, like every shell's (see list.ts): nothing here
			// follows a mouse, and the arrow is how a row is travelled to. The device
			// still answers for its own ergonomics through `touch` (the hint's wording,
			// the arrow's size under a finger, the on-screen keyboard).
			touch: this.mobile,
			// The dialog needs no collapse — the first travel closes it.
			collapseOnJump: false,
			inline: () => this.inline,
			focusFilter: true,
			// The dialog has answered its question the moment a row is travelled
			// to, so it gets out of the way first and the open it triggers runs
			// on its own. (The sidebar shell passes nothing here: staying up is
			// the whole point of it.) A link inside the rendered content is the
			// same kind of journey and takes the same way out (see follow).
			onJump: () => this.close(),
			prefs: this.prefs,
		});
		this.browser.mount();
	}

	onClose() {
		// A closed dialog has no presentation to keep up to date, and the window
		// outlives it: the width listener goes with the dialog.
		this.stopWatchingWidth();
		// The rendered preview and everything hung on it (embeds, math, plugin
		// children) belong to this dialog: closing it unloads them.
		this.browser.destroy();
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
		this.browser.render();
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
}
