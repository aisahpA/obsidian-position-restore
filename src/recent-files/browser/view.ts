// The recent-files panel as a RESIDENT sidebar: the same body as the modal (see
// body.ts), standing in a workspace leaf instead of a dialog.
//
// Why it exists beside the modal: the modal answers "where was I, and take me
// there" once and closes. A reader who works that way repeatedly — hopping
// between a note and the places they came from — pays an open, a read and a
// close for every hop, and the panel that would help them is the one thing they
// cannot see while they work. Resident, the same list is a place in the
// workspace: it stays where they put it, it follows the history as it moves, and
// a travel leaves it standing (see RecentFilesBrowserOptions.onJump).
//
// WHAT THE SHELL OWNS, and nothing else:
//  - the leaf's own lifetime: mount a body on open, destroy it on close, and
//    hear about list changes while it is up (see NavPlaces.subscribe);
//  - the classes the stylesheet reads, which no element of the pane's own
//    chrome has;
//  - getting out of the way on a PHONE after a travel: the drawer it stands in
//    first, and then the list it leaves behind (see standAside).
//
// It is a VIEW and not a floating panel so that Obsidian's own machinery does
// the rest: the leaf remembers its place in the layout across restarts, it can
// be dragged to the other sidebar or into the main area, it obeys the "Close"
// the pane's own menu offers, and `revealLeaf` brings it back.

import { App, ItemView, Platform, WorkspaceLeaf } from 'obsidian';
import { PlaceList } from '@/recent-files/places';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { RecentFilesBrowser, RecentFilesBrowserPrefs } from './body';
import { NAV_SOURCE_ID, PANEL_EXIT_GRACE_MS } from './constants';

// The view type, which is also what the layout file remembers — and thereby the name the
// panel answers by in the app's hover-preview system (see NAV_SOURCE_ID): the dialog says
// it too, so hovering a row there and hovering the same row here is one name to the app,
// and one line in that core plugin's settings. Which is also why changing this string
// would orphan a saved sidebar from the layout that remembers it: it is a persisted id
// before it is a label.
export const RECENT_FILES_VIEW_TYPE = NAV_SOURCE_ID;

export class RecentFilesView extends ItemView {
	// The panel itself, and the subscription that keeps it current (see
	// NavPlaces.subscribe). Both are the view's own: the modal has no
	// equivalent of either, because nothing outlives a dialog.
	private browser: RecentFilesBrowser | null = null;
	private unsubscribe: (() => void) | null = null;
	// The panel's redraws, HELD BACK while it is on its way out of the reader's
	// sight (see suspendRedraws). The timer IS the flag — something is being waited
	// out only while it stands — and it is cleared with the panel (see onClose), so a
	// closed view is never drawn into again.
	private suspendTimer?: number;
	// A change that arrived while the redraws were held back: caught up in ONE
	// redraw once the panel is gone, however many arrived on the way out. A panel
	// nobody is looking at does not owe a redraw per change; it owes a list that is
	// true when it is looked at again.
	private missedRender = false;

	constructor(
		leaf: WorkspaceLeaf,
		// The recent-files list: the panel's only data source. The back/forward
		// stack is NOT here — this pane lists places, and every one of them
		// travels the way its own record says (see places.ts's travel).
		private places: PlaceList,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// The browser's own preferences (see RecentFilesBrowserPrefs): the plugin owns and
		// persists them, this shell only hands them down.
		private prefs: RecentFilesBrowserPrefs,
	) {
		super(leaf);
	}

	getViewType(): string {
		return RECENT_FILES_VIEW_TYPE;
	}

	// The pane's own tab and header text. Not a second name for the panel: the
	// toolbar inside it names nothing, and the pane is where a reader looks for
	// the panel (see modal.ts, which sets the same string as its dialog title).
	getDisplayText(): string {
		return t('recentFiles.name');
	}

	// The same icon the two commands carry (see main.ts). A clock, because the
	// rows are ordered by WHEN they were last sat in — recency is what this
	// panel is about. Not 'list': that one is the outline's icon (see the
	// outline pane), and borrowing it would put two different panes under one
	// mark in the sidebar.
	getIcon(): string {
		return 'clock';
	}

	async onOpen(): Promise<void> {
		// The classes the shared presentation rules are written against (see
		// styles.css), and the one question the shell answers about the DEVICE: a
		// touch layout is a fact about the pane, not about the room it is in.
		this.contentEl.addClass('position-restore-nav-panel', 'position-restore-nav-view');
		if (Platform.isMobile)
			this.contentEl.addClass('is-touch');
		this.browser = new RecentFilesBrowser({
			app: this.app,
			places: this.places,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			// The list is click-only, exactly as it is in the dialog (see list.ts):
			// nothing follows a pointer that merely passes over it — the reader asked
		// for a place that stays put while they work. The DEVICE still answers for
		// its own ergonomics (the on-screen keyboard, and a × worth tapping).
			touch: Platform.isMobile,
			// …and a travel starts from a cleared list: the travel re-orders the list
			// (the place visited moves to the end) and a jump re-pushes the stack, so
			// the row the reader had pointed at is about to stand for a different place
			// in the same slot (see RecentFilesList.collapse).
			collapseOnJump: true,
			// …and on a PHONE the panel itself gets out of the way (see standAside):
			// a resident panel is a drawer over the whole screen there, so a row that
			// opens a note behind it looks like a row that did nothing.
			onJump: () => this.standAside(),
			// A resident panel is restored WITH the workspace, so taking the caret
			// out of the editor to put a sidebar panel up is not something the
		// reader asked for. The box is one click away, and it is where the arrow
		// keys walk the list from once it has the focus.
			focusFilter: false,
			prefs: this.prefs,
		});
		this.browser.mount();
		this.unsubscribe = this.places.subscribe(() => this.hearPlaces());
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// The body's own teardown: the age timer and the document listener it
		// registered.
		this.browser?.destroy();
		this.browser = null;
		// …and the panel's own: whatever it was holding a redraw back for, it is not
		// standing any more, so there is nothing left to catch up on. A timer that
		// outlived the view would draw into a body that has been torn down.
		this.stopSuspending();
	}

	// Draw the list again. A preference the reader changed in the settings tab is
	// read live by the body (see RecentFilesBrowserPrefs), so this is all it takes for a
	// panel standing open beside the page to show the answer they just chose —
	// and it is asked of the panel rather than pushed into it, because whether a
	// panel is up at all is the workspace's business (see
	// PositionManager.refreshNavPanels).
	refresh(): void {
		this.browser?.render();
	}

	// The places moved. A panel the reader can still see is drawn again on the
	// spot; one that is on its way out is not (see suspendRedraws) — it is drawn
	// once, when it has gone.
	private hearPlaces(): void {
		if (this.suspendTimer !== undefined) {
			this.missedRender = true;
			return;
		}
		this.browser?.render();
	}

	// A travel on a phone: the panel gets out of the way, and so does the LIST it
	// leaves behind.
	//
	// The two are one event to the reader — they pointed at a row and the whole
	// panel is going away — so they are one reaction here. The drawer folds first
	// (see dismissOnMobile), because that is the half that answers "why did nothing
	// seem to happen": the note they opened is behind a panel covering the screen.
	// Then the list stops being drawn (see suspendRedraws), because the travel
	// re-orders it at once — the place just sat in becomes the newest — and a list
	// that shuffles itself on the way out is a change nobody asked for.
	//
	// On a DESKTOP neither happens: the panel stands beside the note it just opened,
	// and that re-ordering IS the answer — the row they aimed at climbs to the top and
	// takes the "you are here" mark with it. Holding it back there would leave a
	// standing panel a step behind the one thing it is for.
	private standAside(): void {
		if (!Platform.isMobile)
			return;
		// The menu goes FIRST, before anything moves: it was raised from a row of this
		// panel and stands on the document, so the app has no way to hear that the
		// panel is leaving — folding a drawer is not one of the gestures it takes a
		// menu off the screen for (see RecentFilesBrowser.closeMenu).
		this.browser?.closeMenu();
		this.dismissOnMobile();
		this.suspendRedraws();
	}

	// Stop drawing the list until the panel has left the reader's sight (see
	// PANEL_EXIT_GRACE_MS), then draw it ONCE if anything changed on the way out.
	//
	// Nothing the panel would draw in those few hundred milliseconds is worth
	// drawing: the reader's attention has followed the note they opened, and what
	// they would see is a list re-ordering itself under a drawer that is already
	// leaving. What the panel owes instead is a list that is TRUE when the drawer is
	// pulled open again — and ONE redraw delivers that however many changes arrived,
	// because the list is drawn from the places as they stand then (see
	// RecentFilesBrowser.render), and the last of them already carries the others.
	private suspendRedraws(): void {
		// A second travel inside the same window starts it over rather than stacking
		// a second timer: what is being waited out is the panel's own exit, and a
		// panel has only one.
		this.stopSuspending();
		this.suspendTimer = window.setTimeout(() => {
			this.suspendTimer = undefined;
			if (!this.missedRender)
				return;
			this.missedRender = false;
			this.browser?.render();
		}, PANEL_EXIT_GRACE_MS);
	}

	private stopSuspending(): void {
		if (this.suspendTimer === undefined)
			return;
		window.clearTimeout(this.suspendTimer);
		this.suspendTimer = undefined;
		this.missedRender = false;
	}

	// Fold the drawer this panel is standing in, so the note the reader just opened
	// is what they see. The panel itself STAYS in the layout — collapsing is not
	// closing, and where to put it is the reader's business (see main.ts on why
	// nothing detaches it). Asked on a phone only (see standAside): on a desktop the
	// panel stands beside the note, so there is nothing to move.
	//
	// The drawer IS the leaf's parent on a phone (see WorkspaceLeaf.parent), so there
	// is no question of which side it is on — and it is checked by SHAPE, never with
	// `instanceof`.
	//
	// That is not a style preference. The typings declare WorkspaceMobileDrawer, but a
	// typings-only package is not the app's runtime module: an `instanceof` against a
	// name the bundle does not export THROWS ("right-hand side of 'instanceof' is not
	// an object") — and this runs as the shell's reaction to a travel, BEFORE the
	// travel, so the panel answered no click at all on a phone. Anything with a
	// `collapsed` flag and a `collapse` is a drawer.
	private dismissOnMobile(): void {
		const parent = this.leaf.parent as unknown as
			{ collapsed?: boolean; collapse?: () => void } | undefined;
		if (parent?.collapsed === false && typeof parent.collapse === 'function')
			parent.collapse();
	}

}

// Bring the resident panel up, or bring it back: the panel is a PLACE, so a
// second invocation must find the one that is already open rather than open a
// second copy of the same list (two panels of one history, each with its own
// filter and its own open notes, is a way to be shown two different answers).
// With none open the panel lands in the right sidebar, beside the note it is
// about.
export async function activateRecentFilesView(
	app: App,
	places: PlaceList,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: RecentFilesBrowserPrefs,
): Promise<void> {
	const existing = app.workspace.getLeavesOfType(RECENT_FILES_VIEW_TYPE)[0];
	if (existing) {
		await app.workspace.revealLeaf(existing);
		return;
	}
	const leaf = app.workspace.getRightLeaf(false);
	if (!leaf)
		return;
	await leaf.setViewState({ type: RECENT_FILES_VIEW_TYPE, active: true });
	await app.workspace.revealLeaf(leaf);
}

// The view factory, for Plugin.registerView. Kept here beside the class it
// builds so that the leaf's runtime wiring (who gets the history, how a saved
// position is read) is one thing in one file.
export function createRecentFilesView(
	places: PlaceList,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: RecentFilesBrowserPrefs,
): (leaf: WorkspaceLeaf) => RecentFilesView {
	return leaf => new RecentFilesView(leaf, places, savedPosition, prefs);
}
