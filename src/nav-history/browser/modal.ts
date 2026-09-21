// "Open recent files" panel: the MODAL shell around the browser body (see
// body.ts for everything that is not a shell, and view.ts for the resident
// sidebar panel that shares it).

import { App, Modal, Platform } from 'obsidian';
import { PlaceList } from '@/nav-history/places';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { FIXED_HEIGHT_MIN_ENTRIES } from './constants';
import { NavHistoryBrowser, NavBrowserPrefs } from './body';

// A destination picker, laid out around how a user actually gets lost:
//  - the list is PLACES (see places.ts): the notes the reader has been in, newest
//    first, one row per note — a note opened ten times is one line, not ten, and two
//    notes sharing a name print their folders to say which is which. What the list
//    prints UNDER a note is the toolbar's own setting (see LandingsMode): by default
//    nothing, and what the row OPENS is the NOTE, the plain way — the position
//    database lands it, exactly as the file explorer would. 'All' prints the jumps
//    the reader made inside it under the name, by line, top of the note first, one
//    ROW PER DISTINCT LINE (see groupByFile); without it the older
//    ones are still reachable through the search box, which matches the lines that
//    were there (see list.ts);
//  - the ROW ITSELF IS THE NAVIGATION, and the whole of it: a click opens what the row
//    stands for (see NavHistoryList.onClick) — a note plainly, a jump at its recorded
//    spot. Every row on screen has somewhere to go, since a place whose file is gone is
//    not listed at all, and the place the reader is already in opens the file back (a
//    jump re-lands its place rather than pushing a second step). Nothing answers a
//    pointer that merely passed over a row (see list.ts): the list is click-only;
//  - the CURRENT note is pinned first, so the current position is a place in the
//    same list — the first row — and not a line of chrome above it. The ● of "you
//    are here" rides on the LANDING that holds the current entry, where it tells one
//    spot from another (see NavHistoryList.placeRow): on the note's own row it could
//    only ever sit on row one, saying what the position already says;
//  - picking a place is by RECOGNITION, never by retrieval, and what a row is
//    recognized by is on the row: the note's name, the line it would land on, and the
//    section it sits in. A details panel used to render that step's recorded lines (or
//    the note as it stands) beside the list; it is gone, because the row's own click
//    does the same job exactly — the plugin's promise is that a click lands where the
//    reader left, in the real editor — and the sheet of small print it carried was not
//    what a reader picks a row by;
//  - the toolbar can narrow the list to matching text — a name, a path, a
//    section, a line, or a phrase the step recorded. That is the only narrowing
//    there is: the file scope that used to sit beside it (a "only this note"
//    switch and a chip of every file the history had been in) was a second way
//    to ask a question the search box already answers — a note's name IS text it
//    matches on — and it cost a control, a dropdown and a modal's worth of state
//    to say what typing three letters says;
//  - choosing a place travels there (NavPlaces.travel): a jump re-pushes its target
//    on top, so back always returns to where you were. The dialog closes itself on
//    the way out (see onJump) — a picker that has answered its question gets out of
//    the way.
// The forward/back segments and the step counts are gone: this panel answers
// "which note, and where in it", and a direction of travel is not part of that
// answer. A file that is gone is not part of the answer either: the recent-files
// store drops it on the vault's own delete event (see places.ts), and the list
// drops it on the spot so that no row ever names a note it cannot open.
//
// WHAT MAKES IT A MODAL, and nothing else does: it is a dialog (a shell of its own
// lifetime, closed the moment a row is travelled to, with the filter box focused on
// open). See view.ts for the resident panel that shares the same body.
export class NavHistoryModal extends Modal {
	// The panel itself: the toolbar, the rows and the keyboard (see body.ts).
	private browser!: NavHistoryBrowser;
	// The device's own ergonomics, and nothing about how the list is driven: it is
	// click-only everywhere (see list.ts). Read once, here: the touch flag picks the
	// hint and decides whether the filter box focuses itself.
	private mobile = Platform.isMobile;

	constructor(
		app: App,
		// The recent-files list: the panel's only data source (see view.ts).
		private places: PlaceList,
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
		// The device's own ergonomics, and nothing else: the classes are per DEVICE, and
		// the dialog's height is pinned once, here — the list it holds is a snapshot, so
		// neither can change while the dialog is up.
		this.modalEl.toggleClass('is-touch', this.mobile);
		this.modalEl.toggleClass('is-fixed', this.places.entries.length > FIXED_HEIGHT_MIN_ENTRIES);
		this.titleEl.setText(t('navHistory.overview.name'));
		this.browser = new NavHistoryBrowser({
			app: this.app,
			places: this.places,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			// The list is click-only, like every shell's (see list.ts): nothing here
			// follows a mouse. The device still answers for its own ergonomics through
			// `touch` (the hint's wording and the on-screen keyboard).
			touch: this.mobile,
			// The dialog needs no collapse — the first travel closes it.
			collapseOnJump: false,
			focusFilter: true,
			// The dialog has answered its question the moment a row is travelled
			// to, so it gets out of the way first and the open it triggers runs
			// on its own. (The sidebar shell passes nothing here: staying up is
			// the whole point of it.)
			onJump: () => this.close(),
			prefs: this.prefs,
		});
		this.browser.mount();
	}

	onClose() {
		// The body's own teardown: the toolbar's setting, if it is open.
		this.browser.destroy();
	}

}
