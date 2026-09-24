// The recent-files panel as a RESIDENT sidebar: the same body as the modal (see
// body.ts), standing in a workspace leaf instead of a dialog.
//
// Why it exists beside the modal: the modal answers "where was I, and take me there"
// once and closes. A reader who works that way repeatedly pays an open, a read and a
// close for every hop, and the panel that would help them is the one thing they cannot
// see while they work. Resident, the same list is a place in the workspace: it stays
// where they put it and a travel leaves it standing.
//
// WHAT THE SHELL OWNS, and nothing else: the leaf's lifetime, the classes the
// stylesheet reads, and getting out of the way on a PHONE after a travel (see
// standAside).
//
// It is a VIEW and not a floating panel so that Obsidian's own machinery does the
// rest: the leaf remembers its place in the layout across restarts, it can be dragged
// to the other sidebar or into the main area, it obeys the pane's own "Close", and
// `revealLeaf` brings it back.

import { App, ItemView, Platform, WorkspaceLeaf } from 'obsidian';
import { PlaceList } from '@/recent-files/places';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { RecentFilesBrowser, RecentFilesBrowserPrefs } from './body';
import { NAV_SOURCE_ID, PANEL_EXIT_GRACE_MS } from './constants';

// Also the name the panel answers by in the app's hover-preview system (see
// constants.ts's NAV_SOURCE_ID): the dialog says it too, so hovering a row there and
// here is one name to the app. Which is also why changing this string would orphan a
// saved sidebar: it is a persisted id before it is a label.
export const RECENT_FILES_VIEW_TYPE = NAV_SOURCE_ID;

export class RecentFilesView extends ItemView {
	// Both are the view's own: the modal has no equivalent of either, because nothing
	// outlives a dialog.
	private browser: RecentFilesBrowser | null = null;
	private unsubscribe: (() => void) | null = null;
	// The timer IS the flag — something is being waited out only while it stands — and
	// it is cleared with the panel, so a closed view is never drawn into again.
	private suspendTimer?: number;
	// Caught up in ONE redraw once the panel is gone, however many changes arrived on
	// the way out: a panel nobody is looking at does not owe a redraw per change, it
	// owes a list that is true when it is looked at again.
	private missedRender = false;

	constructor(
		leaf: WorkspaceLeaf,
		// The panel's only data source. The back/forward stack is NOT here — this pane
		// lists places, and every one travels the way its own record says.
		private places: PlaceList,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// The plugin owns and persists these; this shell only hands them down.
		private prefs: RecentFilesBrowserPrefs,
	) {
		super(leaf);
	}

	getViewType(): string {
		return RECENT_FILES_VIEW_TYPE;
	}

	// Not a second name for the panel: the toolbar inside it names nothing, and the
	// pane is where a reader looks for it (see modal.ts, which sets the same string).
	getDisplayText(): string {
		return t('recentFiles.name');
	}

	// A clock, because the rows are ordered by WHEN they were last sat in. Not 'list':
	// that is the outline's icon, and borrowing it would put two panes under one mark.
	getIcon(): string {
		return 'clock';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('position-restore-nav-panel', 'position-restore-nav-view');
		// A touch layout is a fact about the pane, not about the room it is in.
		if (Platform.isMobile)
			this.contentEl.addClass('is-touch');
		this.browser = new RecentFilesBrowser({
			app: this.app,
			places: this.places,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			// The list is click-only, exactly as in the dialog (see list.ts): nothing
			// follows a pointer that merely passes over it. The DEVICE still answers for
			// its own ergonomics.
			touch: Platform.isMobile,
			// A travel starts from a cleared list: it re-orders the rows (the place
			// visited moves to the end), so the row pointed at is about to stand for a
			// different place in the same slot (see RecentFilesList.collapse).
			collapseOnJump: true,
			// On a PHONE the panel itself gets out of the way: a resident panel is a
			// drawer over the whole screen there, so a row that opens a note behind it
			// looks like a row that did nothing.
			onJump: () => this.standAside(),
			// A resident panel is restored WITH the workspace, so taking the caret out
			// of the editor is not something the reader asked for.
			focusFilter: false,
			prefs: this.prefs,
		});
		this.browser.mount();
		this.unsubscribe = this.places.subscribe(() => this.hearPlaces());
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.browser?.destroy();
		this.browser = null;
		// Whatever it was holding a redraw back for, it is not standing any more: a
		// timer that outlived the view would draw into a body that has been torn down.
		this.stopSuspending();
	}

	// A preference changed in the settings tab is read live by the body, so this is all
	// it takes for an open panel to show the answer just chosen. Asked of the panel
	// rather than pushed into it, because whether it is up at all is the workspace's
	// business (see PositionManager.refreshNavPanels).
	refresh(): void {
		this.browser?.render();
	}

	// A panel the reader can still see is drawn again on the spot; one on its way out
	// is not (see suspendRedraws) — it is drawn once, when it has gone.
	private hearPlaces(): void {
		if (this.suspendTimer !== undefined) {
			this.missedRender = true;
			return;
		}
		this.browser?.render();
	}

	// A travel on a phone: the panel gets out of the way, and so does the list it
	// leaves behind — one event to the reader, so one reaction here. The drawer folds
	// first (see dismissOnMobile), because that is the half that answers "why did
	// nothing seem to happen". Then the list stops being drawn, because the travel
	// re-orders it at once and a list that shuffles itself on the way out is a change
	// nobody asked for.
	//
	// On a DESKTOP neither happens: the panel stands beside the note it just opened,
	// and that re-ordering IS the answer — the row they aimed at climbs to the top and
	// takes the "you are here" mark with it.
	private standAside(): void {
		if (!Platform.isMobile)
			return;
		// The menu goes FIRST: it was raised from a row of this panel and stands on the
		// document, so the app has no way to hear that the panel is leaving — folding a
		// drawer is not one of the gestures it takes a menu off the screen for (see
		// RecentFilesBrowser.closeMenu).
		this.browser?.closeMenu();
		this.dismissOnMobile();
		this.suspendRedraws();
	}

	// Nothing the panel would draw in those few hundred milliseconds is worth drawing:
	// the reader's attention has followed the note they opened. What the panel owes is
	// a list that is TRUE when the drawer is pulled open again — and ONE redraw
	// delivers that however many changes arrived, because the list is drawn from the
	// places as they stand then (see RecentFilesBrowser.render).
	private suspendRedraws(): void {
		// A second travel inside the same window restarts it rather than stacking a
		// second timer: a panel has only one exit.
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

	// The panel itself STAYS in the layout — collapsing is not closing, and where to
	// put it is the reader's business. The drawer IS the leaf's parent on a phone, so
	// there is no question of which side it is on — and it is checked by SHAPE, never
	// with `instanceof`.
	//
	// That is not a style preference: the typings declare WorkspaceMobileDrawer, but a
	// typings-only package is not the app's runtime module, and an `instanceof` against
	// a name the bundle does not export THROWS — and this runs as the shell's reaction
	// to a travel, so the panel answered no click at all on a phone.
	private dismissOnMobile(): void {
		const parent = this.leaf.parent as unknown as
			{ collapsed?: boolean; collapse?: () => void } | undefined;
		if (parent?.collapsed === false && typeof parent.collapse === 'function')
			parent.collapse();
	}

}

// Bring the panel up, or bring it back: the panel is a PLACE, so a second invocation
// must find the one already open rather than open a second copy of the same list (two
// panels of one history, each with its own filter, is a way to be shown two answers).
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

// Kept beside the class it builds so the leaf's runtime wiring is one thing in one
// file.
export function createRecentFilesView(
	places: PlaceList,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: RecentFilesBrowserPrefs,
): (leaf: WorkspaceLeaf) => RecentFilesView {
	return leaf => new RecentFilesView(leaf, places, savedPosition, prefs);
}
