import { NavHistoryEntry } from '../entry';
import { t } from '../../i18n';
import { PREVIEW_RADIUS } from './constants';
import { formatRelativeTime } from './listing';
import { NavEntryDescription } from './model';
import { previewWindow } from './preview-lines';

// The landing panel: where the pointed-at row sits (path, pane, type, line,
// age), the heading chain it sits under, and the landing line with its
// neighbours. Nothing when nothing is pointed at, rather than guessing.
// TOUCH ONLY: on a pointing device the same hover asks the core page preview
// for the whole note instead (see PagePreviewBridge), and rendering a panel
// nobody can see would still cost a file read per hovered row.
// It opens UNDER the selected row, in the list's own scroll flow. Parked at
// the bottom of the dialog (where it used to live) it lost the fight for
// height the moment there was history to scroll — and a panel nobody can see
// is a "jump here" button nobody can tap. Inside the list it is always one
// flick away from the row that opened it, and the browser brings it into view
// on selection.

export interface LandingPanelOptions {
	// The element the panel draws into (created by the browser beside the list).
	panel: HTMLElement;
	// Where the panel waits while it has no row to open under (touch).
	parkAt: HTMLElement;
	// Whether this device gets the panel at all.
	mobile: boolean;
	// The stack index the panel describes; -1 = nothing pointed at.
	previewed: () => number;
	// The entry at a stack index, when it still exists.
	entryAt: (rep: number) => NavHistoryEntry | undefined;
	// The row element a stack index resolves to (shared with the list, so a
	// merged alias still finds its row).
	rowOf: (rep: number) => HTMLElement | undefined;
	describe: (rep: number) => NavEntryDescription;
	// The heading chain the landing sits in.
	trailFor: (entry: NavHistoryEntry, d: NavEntryDescription) => string[];
	paneName: (entry: NavHistoryEntry) => string | undefined;
	// The landing lines of a path, or undefined while they are still coming.
	linesFor: (path: string) => string[] | null | undefined;
	// Ask for a deferred vault read of the lines (see NavHistoryReads).
	scheduleRead: (path: string) => void;
	// Travel to a stack index — the panel's own "jump here" button.
	jump: (rep: number) => void;
}

export class LandingPanel {
	constructor(private opts: LandingPanelOptions) {}

	// (Re)draw the panel for the pointed-at row. Callers: the panel follows the
	// pointed-at row (see the browser's select/preview paths).
	render(): void {
		if (!this.opts.mobile)
			return;
		const box = this.opts.panel;
		box.empty();
		const rep = this.opts.previewed();
		const entry = this.opts.entryAt(rep);
		const row = entry ? this.opts.rowOf(rep) : undefined;
		if (!entry || !row) {
			// Nothing pointed at, or the filter took its row away: the panel has
			// no row to open under, so it waits out of the way.
			this.opts.parkAt.appendChild(box);
			box.addClass('is-parked');
			return;
		}
		row.insertAdjacentElement('afterend', box);
		box.removeClass('is-parked');
		const d = this.opts.describe(rep);
		const head = box.createDiv({ cls: 'nav-preview-head' });
		head.createSpan({ text: d.title, cls: 'nav-preview-title' });
		const pane = this.opts.paneName(entry);
		if (pane)
			head.createSpan({ text: pane, cls: 'nav-preview-pane' });
		// The row's old type column lives here: how the step was made is
		// confirmation of a choice, not part of making it.
		if (!d.missing)
			head.createSpan({ text: d.type, cls: `nav-preview-type${d.soft ? ' is-soft' : ''}` });
		if (d.line)
			head.createSpan({ text: d.line, cls: 'nav-row-line' });
		head.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });
		// A touch device has no Enter and no hover: without this button a tap
		// could point at a row but never go there. It is the panel's last line and
		// as wide as the panel, because a finger has to be able to hit it.
		if (!d.missing) {
			const go = box.createEl('button', { text: t('navHistory.jumpHere'), cls: 'nav-preview-go' });
			go.addEventListener('click', () => this.opts.jump(rep));
		}

		if (d.missing) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.gone') });
			return;
		}
		if (d.lineIndex === undefined || entry.kind === 'view') {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
			return;
		}
		const lines = this.opts.linesFor(entry.path);
		if (lines === undefined) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.loading') });
			this.opts.scheduleRead(entry.path);
			return;
		}
		if (lines === null) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
			return;
		}
		// WHICH section the landing sits in is the cue a reader recognizes a
		// spot by — three raw lines of prose say little on their own. The full
		// chain here (the row trims it), and it needs no file read.
		const trail = this.opts.trailFor(entry, d);
		if (trail.length) {
			const crumb = box.createDiv({ cls: 'nav-preview-trail' });
			for (let i = 0; i < trail.length; i++) {
				if (i > 0)
					crumb.createSpan({ text: '›', cls: 'nav-trail-sep' });
				crumb.createSpan({
					text: trail[i],
					cls: i === trail.length - 1 ? 'nav-trail-deep' : 'nav-trail-seg',
				});
			}
		}
		for (const line of previewWindow(lines, d.lineIndex, PREVIEW_RADIUS)) {
			const el = box.createDiv({
				cls: `nav-preview-line${line.mark ? ' is-landing' : ''}`,
			});
			el.createSpan({ text: `L${line.num}`, cls: 'nav-preview-num' });
			el.createSpan({
				text: line.text.trim() || t('navHistory.preview.blank'),
				cls: 'nav-preview-text',
			});
		}
	}

	// Keep the panel on screen after the selection moved: on touch it hangs
	// BELOW the selected row (see render), so the row alone being on screen is
	// not enough — the panel is where the button that travels with a finger
	// lives, and it must not open off the bottom edge.
	reveal(): void {
		this.opts.panel.scrollIntoView({ block: 'nearest' });
	}
}
