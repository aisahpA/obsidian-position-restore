import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { formatRelativeTime } from './listing';
import { NavEntryDescription, linkDisplayText } from './model';

// One line of the recorded context block as the panel prints it: the 1-based
// number the gutter shows, the text, and whether this is the landing itself.
interface PreviewLine {
	num: number;
	text: string;
	mark: boolean;
}

// The landing panel: where the pointed-at row sits (path, pane, type, where a
// link came from, line / total, age), the heading chain it sits under, and the
// recorded landing lines. Nothing when nothing is pointed at, rather than
// guessing.
// TOUCH ONLY: on a pointing device the same hover asks the core page preview
// for the whole note instead (see PagePreviewBridge).
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
		// …and with it, for a step made by clicking a link, WHERE the link was
		// clicked and what it said: the row has no room for it, the panel does,
		// and "I followed that link from here" is exactly the reassurance the
		// panel is for. The link's own words are shown only when they add
		// something the source note's name does not (a |display alias).
		if (!d.missing && d.viaName) {
			head.createSpan({ text: t('navHistory.preview.via', d.viaName), cls: 'nav-preview-via' });
			const words = d.viaText ? linkDisplayText(d.viaText) : '';
			if (words && words !== d.viaName)
				head.createSpan({ text: `「${words}」`, cls: 'nav-preview-via' });
		}
		// "L412 / 1200": the recorded size at the time is the only denominator
		// available without a read per entry, and without one the coordinate
		// says nothing about where in the note the spot is.
		if (d.line)
			head.createSpan({ text: d.lineCount ? `${d.line} / ${d.lineCount}` : d.line, cls: 'nav-row-line' });
		// The file was written after this step was recorded: the text below is
		// what was there THEN. Worth saying, since the search box matches it.
		if (d.stale)
			head.createSpan({ text: t('navHistory.preview.modified'), cls: 'nav-preview-modified' });
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
			// The note is gone; the recorded block still says what stood there,
			// which is the only thing left to recognize the step by. No block,
			// nothing to add: "file deleted" already said it.
			this.printBlock(box, entry);
			return;
		}
		if (d.lineIndex === undefined) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
			return;
		}
		// WHICH section the landing sits in is the cue a reader recognizes a
		// spot by — a handful of raw lines of prose say little on their own. The
		// full chain here (the row trims it), and it needs no file read.
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
		if (!this.printBlock(box, entry))
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
	}

	// The landing lines, from the entry's OWN recorded block (see
	// NavEntryState.context): what the user was looking at when they left, with
	// no read behind it — no vault IO, no loading state, no dependence on the
	// file still existing, and no chance of printing today's content where the
	// row promises the recorded spot. @returns whether there was a block to
	// print, so the caller can admit it when there was not.
	private printBlock(box: HTMLElement, entry: NavHistoryEntry): boolean {
		if (entry.kind === 'view')
			return false;
		const st = entry.st;
		if (!st?.context?.length)
			return false;
		this.printLines(box, st.context.map((line, i) => ({
			num: line.line + 1,
			text: line.text,
			mark: i === st.contextAt,
		})));
		return true;
	}

	private printLines(box: HTMLElement, lines: PreviewLine[]): void {
		for (const line of lines) {
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
