// "Open recent files" panel: the MODAL shell around the browser body (see
// body.ts for everything that is not a shell, and view.ts for the resident
// sidebar panel that shares it).
//
// WHAT MAKES IT A MODAL and nothing else does: a dialog of its own lifetime,
// closed the moment a row is travelled to, with the filter box focused on open.
//
// It is also the one shell that does NOT subscribe to the places: a dialog is a
// question asked and answered, and the only change its list can see is one its
// own reader made from a row's menu, which the body redraws itself. A panel that
// stays up is the opposite case, and the reason that subscription exists.

import { App, Modal, Platform } from 'obsidian';
import { PlaceList } from '@/recent-files/places';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { FIXED_HEIGHT_MIN_ENTRIES } from './constants';
import { RecentFilesBrowser, RecentFilesBrowserPrefs } from './body';

export class RecentFilesModal extends Modal {
	// The toolbar, the rows and the keyboard.
	private browser!: RecentFilesBrowser;
	// Read once, here: it picks the hint and whether the filter box focuses itself.
	private mobile = Platform.isMobile;

	constructor(
		app: App,
		// The panel's only data source.
		private places: PlaceList,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// The plugin owns and persists these; this shell only hands them down.
		private prefs: RecentFilesBrowserPrefs,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		// The class the two shells share: what the panel's presentation rules are
		// written against (see styles.css), so a dialog and a sidebar panel cannot
		// drift apart in their quiet tiers, their inline panel or their touch layout.
		this.modalEl.addClass('position-restore-nav-panel');
		// Pinned once, here. A row can still leave while the dialog is up — the
		// reader may take one off from its own menu — and the list simply comes out a
		// row shorter.
		this.modalEl.toggleClass('is-touch', this.mobile);
		this.modalEl.toggleClass('is-fixed', this.places.entries.length > FIXED_HEIGHT_MIN_ENTRIES);
		this.titleEl.setText(t('recentFiles.name'));
		this.browser = new RecentFilesBrowser({
			app: this.app,
			places: this.places,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			touch: this.mobile,
			// The dialog needs no collapse — the first travel closes it.
			collapseOnJump: false,
			focusFilter: true,
			// The dialog has answered its question the moment a row is travelled to,
			// so it gets out of the way first and the open runs on its own. (The
			// sidebar shell passes nothing here: staying up is the point of it.)
			onJump: () => this.close(),
			prefs: this.prefs,
		});
		this.browser.mount();
	}

	onClose() {
		this.browser.destroy();
	}

}
