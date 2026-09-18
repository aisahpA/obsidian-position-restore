// The history browser as a RESIDENT sidebar panel: the same body as the modal
// (see body.ts), standing in a workspace leaf instead of a dialog.
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
//    hear about history changes while it is up (see NavHistory.subscribe);
//  - the presentation decision, which a SIDEBAR has to ask differently from a
//    dialog — see drawerFits below;
//  - the classes the stylesheet reads, which no element of the pane's own
//    chrome has.
//
// It is a VIEW and not a floating panel so that Obsidian's own machinery does
// the rest: the leaf remembers its place in the layout across restarts, it can
// be dragged to the other sidebar or into the main area, it obeys the "Close"
// the pane's own menu offers, and `revealLeaf` brings it back.

import { App, ItemView, Platform, WorkspaceLeaf } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { DRAWER_MIN_WIDTH } from './constants';
import { NavHistoryBrowser, NavBrowserPrefs } from './body';

// The view type, which is also what the layout file remembers: renaming it
// orphans every reader's saved sidebar (they would find an empty pane where the
// panel used to be), so it is a constant no refactor may touch.
export const NAV_HISTORY_VIEW_TYPE = 'position-restore-nav-history';

export class NavHistoryView extends ItemView {
	// The panel itself, and the subscription that keeps it current (see
	// NavHistory.subscribe). Both are the view's own: the modal has no
	// equivalent of either, because nothing outlives a dialog.
	private browser: NavHistoryBrowser | null = null;
	private unsubscribe: (() => void) | null = null;
	// Whether the landing panel opens INSIDE the list (see
	// NavHistoryBrowserOptions.inline). Read from the pane, never from the
	// window, and kept so a resize that does not change the answer costs no
	// render (see measure).
	private inline = true;

	constructor(
		leaf: WorkspaceLeaf,
		private nav: NavHistory,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// The browser's own two preferences (see NavBrowserPrefs): the plugin owns
		// and persists them, this shell only hands them down.
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
		return t('navHistory.overview.name');
	}

	getIcon(): string {
		return 'history';
	}

	async onOpen(): Promise<void> {
		// The classes the shared presentation rules are written against (see
		// styles.css). `is-inline` is the safe opening answer — this pane may not
		// have been laid out yet (see measure) — and `is-touch` is the one
		// question the shell answers about the device rather than about the room.
		this.contentEl.addClass('position-restore-nav-panel', 'position-restore-nav-view');
		// …and the presentation the pane's own width answers, applied here rather
		// than left to measure: that method only acts on a CHANGE, and the shell
		// opens on the inline answer (see `inline`).
		this.contentEl.toggleClass('is-inline', this.inline);
		if (Platform.isMobile)
			this.contentEl.addClass('is-touch');
		this.measure();
		this.browser = new NavHistoryBrowser({
			app: this.app,
			nav: this.nav,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			// The panel is click-only, exactly as it is in the dialog (see list.ts):
			// no pointer moves the position and nothing opens under a row nobody
			// clicked — the reader asked for a place that stays put while they work,
			// and a list that reshuffles what it describes under a passing mouse is
			// the opposite of that. One click says everything (a note opens its
			// landings and is described, a landing is pointed at, a second click puts
			// it away) and the row's own arrow travels.
			// The DEVICE still answers for its own ergonomics (the on-screen
			// keyboard, and whether the hint says "tap" or "click").
			touch: Platform.isMobile,
			// …and a travel starts from a closed tree: the jump pins the note it landed
			// on first, so the note the reader had opened is about to be a different
			// note in the same slot (see NavHistoryList.collapse).
			collapseOnJump: true,
			inline: () => this.inline,
			// A resident panel is restored WITH the workspace, so taking the caret
			// out of the editor to put a sidebar panel up is not something the
			// reader asked for. The box is one click away, and the hint under it
			// says what the arrows do once it has the focus.
			focusFilter: false,
			prefs: this.prefs,
		});
		this.browser.mount();
		this.unsubscribe = this.nav.subscribe(() => this.browser?.render());
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// The rendered preview and everything hung on it (embeds, math, plugin
		// children) belong to this view: closing it unloads them.
		this.browser?.destroy();
		this.browser = null;
	}

	// The pane changed size. A sidebar's width is its OWN question, and the
	// window cannot answer it: the modal's media query (see modal.ts) is asked of
	// the whole window, which on a 300px rail with a 1400px editor says "plenty of
	// room for two columns" about a pane that has room for one. So the drawer is
	// offered exactly when the PANE is wide enough for it — a wide rail on a
	// desktop, and on a phone the sidebar drawer, which covers the screen and is
	// therefore the one place a phone can have the two-column presentation.
	onResize(): void {
		this.measure();
	}

	private measure(): void {
		// clientWidth is 0 until the pane has been laid out (and in a test): the
		// inline presentation is the one that needs no second column, so it is the
		// safe answer, and the resize that reports the real width corrects it.
		const inline = this.contentEl.clientWidth < DRAWER_MIN_WIDTH;
		if (inline === this.inline)
			return;
		this.inline = inline;
		this.contentEl.toggleClass('is-inline', inline);
		this.browser?.render();
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
	nav: NavHistory,
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
	nav: NavHistory,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: NavBrowserPrefs,
): (leaf: WorkspaceLeaf) => NavHistoryView {
	return leaf => new NavHistoryView(leaf, nav, savedPosition, prefs);
}
