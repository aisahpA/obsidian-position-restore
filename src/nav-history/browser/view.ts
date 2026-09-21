// The recent-files panel as a RESIDENT sidebar: the same body as the modal (see
// body.ts), standing in a workspace leaf instead of a dialog.
//
// Why it exists beside the modal: the modal answers "where was I, and take me
// there" once and closes. A reader who works that way repeatedly — hopping
// between a note and the places they came from — pays an open, a read and a
// close for every hop, and the panel that would help them is the one thing they
// cannot see while they work. Resident, the same list is a place in the
// workspace: it stays where they put it, it follows the history as it moves, and
// a travel leaves it standing (see NavHistoryBrowserOptions.onJump).
//
// WHAT THE SHELL OWNS, and nothing else:
//  - the leaf's own lifetime: mount a body on open, destroy it on close, and
//    hear about list changes while it is up (see NavPlaces.subscribe);
//  - the classes the stylesheet reads, which no element of the pane's own
//    chrome has;
//  - getting out of the way on a PHONE after a travel (see dismissOnMobile).
//
// It is a VIEW and not a floating panel so that Obsidian's own machinery does
// the rest: the leaf remembers its place in the layout across restarts, it can
// be dragged to the other sidebar or into the main area, it obeys the "Close"
// the pane's own menu offers, and `revealLeaf` brings it back.

import { App, ItemView, Platform, WorkspaceLeaf } from 'obsidian';
import { PlaceList } from '@/nav-history/places';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { NavHistoryBrowser, NavBrowserPrefs } from './body';

// The view type, which is also what the layout file remembers. Renamed with the
// panel itself, while the feature is still unreleased: nothing has been saved
// into a reader's layout yet, so the constant is settled now — before it becomes
// the one string no refactor may touch (a rename would orphan the sidebar).
export const NAV_HISTORY_VIEW_TYPE = 'position-restore-recent-files';

export class NavHistoryView extends ItemView {
	// The panel itself, and the subscription that keeps it current (see
	// NavPlaces.subscribe). Both are the view's own: the modal has no
	// equivalent of either, because nothing outlives a dialog.
	private browser: NavHistoryBrowser | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		// The recent-files list: the panel's only data source. The back/forward
		// stack is NOT here — this pane lists places, and every one of them
		// travels the way its own record says (see places.ts's travel).
		private places: PlaceList,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// The browser's own preferences (see NavBrowserPrefs): the plugin owns and
		// persists them, this shell only hands them down.
		private prefs: NavBrowserPrefs,
	) {
		super(leaf);
	}

	getViewType(): string {
		return NAV_HISTORY_VIEW_TYPE;
	}

	// The pane's own tab and header text. Not a second name for the panel: the
	// toolbar inside it names nothing, and the pane is where a reader looks for
	// the panel (see modal.ts, which sets the same string as its dialog title).
	getDisplayText(): string {
		return t('recentFiles.name');
	}

	getIcon(): string {
		return 'history';
	}

	async onOpen(): Promise<void> {
		// The classes the shared presentation rules are written against (see
		// styles.css), and the one question the shell answers about the DEVICE: a
		// touch layout is a fact about the pane, not about the room it is in.
		this.contentEl.addClass('position-restore-nav-panel', 'position-restore-nav-view');
		if (Platform.isMobile)
			this.contentEl.addClass('is-touch');
		this.browser = new NavHistoryBrowser({
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
			// in the same slot (see NavHistoryList.collapse).
			collapseOnJump: true,
			// …and on a PHONE the panel itself gets out of the way (see
			// dismissOnMobile): a resident panel is a drawer over the whole screen
			// there, so a row that opens a note behind it looks like a row that did
			// nothing.
			onJump: () => this.dismissOnMobile(),
			// A resident panel is restored WITH the workspace, so taking the caret
			// out of the editor to put a sidebar panel up is not something the
		// reader asked for. The box is one click away, and it is where the arrow
		// keys walk the list from once it has the focus.
			focusFilter: false,
			prefs: this.prefs,
		});
		this.browser.mount();
		this.unsubscribe = this.places.subscribe(() => this.browser?.render());
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// The body's own teardown: the age timer and the document listener it
		// registered.
		this.browser?.destroy();
		this.browser = null;
	}

	// Draw the list again. A preference the reader changed in the settings tab is
	// read live by the body (see NavBrowserPrefs), so this is all it takes for a
	// panel standing open beside the page to show the answer they just chose —
	// and it is asked of the panel rather than pushed into it, because whether a
	// panel is up at all is the workspace's business (see
	// PositionManager.refreshNavPanels).
	refresh(): void {
		this.browser?.render();
	}

	// A travel on a phone: collapse the drawer this panel is standing in, so the note
	// the reader just opened is what they see. The panel itself STAYS in the layout —
	// collapsing is not closing, and where to put it is the reader's business (see
	// main.ts on why nothing detaches it). On a desktop the panel stands beside the
	// note, so there is nothing to move.
	private dismissOnMobile(): void {
		if (!Platform.isMobile)
			return;
		// The drawer this panel stands in IS the leaf's parent on a phone (see
		// WorkspaceLeaf.parent), so there is no question of which side it is on — and
		// it is checked by SHAPE, never with `instanceof`.
		//
		// That is not a style preference. The typings declare WorkspaceMobileDrawer,
		// but a typings-only package is not the app's runtime module: an `instanceof`
		// against a name the bundle does not export THROWS ("right-hand side of
		// 'instanceof' is not an object") — and this runs as the shell's reaction to a
		// travel, BEFORE the travel, so the panel answered no click at all on a phone.
		// Anything with a `collapsed` flag and a `collapse` is a drawer.
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
export async function activateNavHistoryView(
	app: App,
	places: PlaceList,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: NavBrowserPrefs,
): Promise<void> {
	const existing = app.workspace.getLeavesOfType(NAV_HISTORY_VIEW_TYPE)[0];
	if (existing) {
		await app.workspace.revealLeaf(existing);
		return;
	}
	const leaf = app.workspace.getRightLeaf(false);
	if (!leaf)
		return;
	await leaf.setViewState({ type: NAV_HISTORY_VIEW_TYPE, active: true });
	await app.workspace.revealLeaf(leaf);
}

// The view factory, for Plugin.registerView. Kept here beside the class it
// builds so that the leaf's runtime wiring (who gets the history, how a saved
// position is read) is one thing in one file.
export function createNavHistoryView(
	places: PlaceList,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: NavBrowserPrefs,
): (leaf: WorkspaceLeaf) => NavHistoryView {
	return leaf => new NavHistoryView(leaf, places, savedPosition, prefs);
}
