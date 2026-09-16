import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { formatRelativeTime } from './listing';
import { contextRange, isMarkdown } from './markdown';
import { NavEntryDescription, folderOf, linkDisplayText } from './model';
import { PreviewMode, previewMode, setPreviewMode } from './preview-content';

// The landing drawer: where the pointed-at landing sits (path, pane, type, where
// a link came from, line / total, age), the heading chain it sits under, and the
// landing's CONTENT — the recorded lines around it, rendered as markdown, or the
// whole note as it stands now (see PreviewContent).
//
// TWO PRESENTATIONS, ONE RENDERER, decided by the device:
//  - DESKTOP: the panel is a standing RIGHT-HAND COLUMN beside the list (see
//    styles.css). It is where the "which spot was this?" question is answered,
//    and it answers it for whatever the pointer or the keyboard is on — the list
//    stays scannable because the content it would otherwise have to carry inline
//    lives here instead.
//  - TOUCH: no hover, and no room for two columns, so the SAME content opens
//    UNDER the tapped row, in the list's own scroll flow, with the travel button
//    a finger needs. Parked at the bottom of the dialog it lost the fight for
//    height the moment there was history to scroll, and a panel nobody can see
//    is a "jump here" button nobody can tap.
//
// It shows the entry's OWN recorded block by default (see NavEntryState.context)
// rather than reading the file: no vault IO, no loading state, no dependence on
// the file still existing, and no chance of printing today's content where the
// row promises the recorded spot. The whole note is one switch away for the
// reader who wants it, and that is the only read behind any of this.

export interface LandingPanelOptions {
	// The element the panel draws into (created by the browser beside the list).
	panel: HTMLElement;
	// Where the panel waits while it has no row to open under (touch).
	parkAt: HTMLElement;
	// Whether this device gets the in-flow (touch) presentation.
	mobile: boolean;
	// The stack index the list's POSITION stands for; -1 = no position. Read through
	// the positioned row, so it follows what that row stands for as the position
	// walks the note (see NavHistoryList.position).
	position: () => number;
	// Where the reader is standing: the LAST fallback of the resolution in render,
	// used only while nothing has been positioned or described yet.
	here: () => number;
	// Whether the list still has a row standing for a landing — its own, or its
	// note's while the note is closed (see NavHistoryList.standsFor). The drawer asks
	// before staying on a subject a query may have dropped.
	standsFor: (rep: number) => boolean;
	// The entry at a stack index, when it still exists.
	entryAt: (rep: number) => NavHistoryEntry | undefined;
	// The row element a stack index resolves to (shared with the list, so a
	// landing of a closed note still finds the note's own row).
	rowOf: (rep: number) => HTMLElement | undefined;
	// The row the list's position is on, which may be a NOTE row: the panel opens
	// under THAT (a note row's landing is what the panel describes, but the note row
	// is where the reader is looking).
	positionRow: () => HTMLElement | undefined;
	// Tell the list which row the panel ended up describing, so it can mark that
	// row (see NavHistoryList.markPreviewed). The panel is what resolves the
	// position/"last"/"here" order, so it is the only thing that knows.
	onPreviewed: (rep: number) => void;
	describe: (rep: number) => NavEntryDescription;
	// The heading chain the landing sits in.
	trailFor: (entry: NavHistoryEntry, d: NavEntryDescription) => string[];
	paneName: (entry: NavHistoryEntry) => string | undefined;
	// Draw the landing's content into the host element, in the mode the reader
	// picked. @returns whether there was anything to draw, so the panel can admit
	// it when there was not.
	content: (host: HTMLElement, mode: PreviewMode, entry: NavHistoryEntry, d: NavEntryDescription) => boolean;
	// Travel to a stack index — the panel's own "jump here" button.
	jump: (rep: number) => void;
}

export class LandingPanel {
	// Which content the reader is looking at comes from the SESSION (see
	// previewMode): the choice outlives the dialog, so a reader who wants the whole
	// note is not put back on the recorded spot every time they open the panel.
	private get mode(): PreviewMode {
		return previewMode();
	}

	// The landing the drawer last described, so that "nothing is pointed at" leaves
	// the subject where it was instead of throwing it back to the current entry (see
	// render). The column answers one question — "what is the spot on the row I am
	// working with" — and that answer must not change because the pointer left the
	// list, or because closing a note moved the position onto its row.
	private lastRep = -1;

	constructor(private opts: LandingPanelOptions) {}

	// (Re)draw the panel for the row the list's position is on. Callers: every move
	// of that position — mouse or keyboard, they are one thing (see
	// NavHistoryList.choose) — which is why the panel itself is a handful of nodes
	// around content the browser draws for it.
	render(): void {
		const box = this.opts.panel;
		const position = this.opts.position();
		// Which row the panel is about, in the order the reader's attention moves:
		//  - the POSITION, when there is one: the single row the mouse moves by
		//    hovering and the keyboard by walking, so both hands describe the same
		//    spot (see NavHistoryList);
		//  - the LAST landing it described, while the list still has a row for it: a
		//    reader who tapped a landing away, or whose row a query dropped, is still
		//    working with that note — and the current entry is not where their
		//    attention is;
		//  - where the reader is standing (only ever the first render of a dialog
		//    nothing has been positioned in at all: it, too, is "never blank").
		//  - …but on TOUCH only a position counts: there the panel exists for the row
		//    a finger has actually tapped, so with nothing tapped it stays out of the
		//    list rather than opening by itself.
		const sticky = this.lastRep >= 0 && this.opts.standsFor(this.lastRep) ? this.lastRep : -1;
		const rep = position >= 0 ? position
			: this.opts.mobile ? -1
				: sticky >= 0 ? sticky : this.opts.here();
		const entry = this.opts.entryAt(rep);
		if (entry)
			this.lastRep = rep;
		// …and which row that turned out to be: the "here"/"last" fallbacks are ones
		// the LIST cannot know about, so the panel reports the resolution it just made
		// rather than leaving the list to guess at it.
		this.opts.onPreviewed(entry ? rep : -1);
		box.empty();

		if (this.opts.mobile) {
			const row = this.opts.positionRow() ?? (entry ? this.opts.rowOf(rep) : undefined);
			if (!entry || !row) {
				// No position, or the filter took its row away: the panel has no row
				// to open under, so it waits out of the way.
				this.opts.parkAt.appendChild(box);
				box.addClass('is-parked');
				return;
			}
			row.insertAdjacentElement('afterend', box);
			box.removeClass('is-parked');
		}

		if (!entry) {
			// Neither a pointed-at row nor a current entry to fall back on (an
			// empty history): say what the column is for rather than sit blank.
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.pick') });
			return;
		}
		this.draw(box, rep, entry);
	}

	// Everything the panel says about one landing, in the order a reader reads it:
	// what it was, where it was, the two things that can be DONE about it, and then
	// the lines themselves.
	//
	// TWO BLOCKS, and only the second one moves: the head, the trail and the
	// controls are PINNED at the top of the drawer, and the caption and the lines
	// scroll under them (see styles.css). A whole note is thousands of lines long,
	// and a recorded block is read by scrolling through it — either way, "which
	// note, which spot, and can I go there" has to stay where the reader can see it
	// rather than being the first thing that leaves the panel.
	private draw(box: HTMLElement, rep: number, entry: NavHistoryEntry): void {
		const d = this.opts.describe(rep);
		const top = box.createDiv({ cls: 'nav-preview-top' });
		// The head is drawn as a FIXED SHAPE — a name, a line of small print, a
		// section line, a bar — whether or not this entry has anything for each of
		// them (see styles.css). The pointer walks the list while the reader reads
		// this column, and a block that is one line shorter for the entries with no
		// section, or two lines shorter for a deleted file with no controls, made
		// the lines below it jump up and down under the eye.
		this.head(top, entry, d);
		// WHICH section the landing sits in is the cue a reader recognizes a spot
		// by, and it needs no file read. The full chain here (the row trims it).
		// Pinned with the name: it is part of what the spot IS.
		this.trail(top, entry, d);
		// The travel button and the view switch, in ONE bar above the content: the
		// button used to sit at the foot of the panel, where a long note pushed it
		// off the bottom — the one control for "I want to go there" was the one
		// thing a reader had to scroll to find.
		this.bar(top, rep, entry, d);

		// …and what scrolls: the lines, and the labels that describe them (which
		// recorded lines these are, or that the file is gone).
		const scroll = box.createDiv({ cls: 'nav-preview-scroll' });
		if (d.missing)
			scroll.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.gone') });
		// What the content IS, said above it: which lines the recorded block
		// covers (the rendered lines have no gutter of their own left to say it),
		// or that these are today's lines and not the recorded ones. A view step
		// has neither.
		if (entry.kind !== 'view')
			this.caption(scroll, entry.path, entry, d);
		const host = scroll.createDiv({ cls: 'nav-preview-content-host' });
		if (!this.opts.content(host, this.mode, entry, d) && !d.missing)
			scroll.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
	}

	// The panel's head: WHICH note, and every small fact about the step that a row
	// has no room for. Two lines, because the name is the headline — the reader
	// arrived from a row that names the note, and this is the place with room to
	// set it as one — and the machinery below it is small print.
	private head(box: HTMLElement, entry: NavHistoryEntry, d: NavEntryDescription): void {
		const head = box.createDiv({ cls: 'nav-preview-head' });
		// The folder comes FIRST and faintly: a name two notes share has to be told
		// apart somewhere, and the row prints the folder for exactly that case (see
		// duplicateNames). A view step (the graph) has no path to take one from —
		// its `name` is already the label for the whole view.
		const ident = head.createDiv({ cls: 'nav-preview-ident' });
		const folder = entry.kind === 'view' ? undefined : folderOf(entry.path);
		if (folder !== undefined)
			ident.createSpan({ text: folder === '' ? '/' : `${folder}/`, cls: 'nav-preview-folder' });
		ident.createSpan({ text: d.name, cls: 'nav-preview-title' });
		// When the step was taken, at the far end of that line: it is the one fact
		// that orders two visits to the SAME spot, so it belongs with the identity
		// rather than in the run of machinery below.
		head.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });

		const meta = head.createDiv({ cls: 'nav-preview-meta' });
		const pane = this.opts.paneName(entry);
		if (pane)
			meta.createSpan({ text: pane, cls: 'nav-preview-pane' });
		// How the step was made is confirmation of a choice, not part of making
		// it: the row is free of it.
		if (!d.missing)
			meta.createSpan({ text: d.type, cls: `nav-preview-type${d.soft ? ' is-soft' : ''}` });
		// …and with it, for a step made by clicking a link, WHERE the link was
		// clicked and what it said: "I followed that link from here" is exactly
		// the reassurance the panel is for. The link's own words are shown only
		// when they add something the source note's name does not (a |display
		// alias).
		if (!d.missing && d.viaName) {
			meta.createSpan({ text: t('navHistory.preview.via', d.viaName), cls: 'nav-preview-via' });
			const words = d.viaText ? linkDisplayText(d.viaText) : '';
			if (words && words !== d.viaName)
				meta.createSpan({ text: `「${words}」`, cls: 'nav-preview-via' });
		}
		// "L412 / 1200": the recorded size at the time is the only denominator
		// available without a read per entry, and without one the coordinate says
		// nothing about where in the note the spot is.
		if (d.line)
			meta.createSpan({ text: d.lineCount ? `${d.line} / ${d.lineCount}` : d.line, cls: 'nav-row-line' });
		// The file was written after this step was recorded: the recorded lines
		// are what was there THEN. Worth saying, since the search box matches them.
		if (d.stale)
			meta.createSpan({ text: t('navHistory.preview.modified'), cls: 'nav-preview-modified' });
	}

	// The heading chain the landing sits under, outermost first, deepest last — and
	// the element is drawn even when the chain is empty (a deleted file, a view
	// step, a landing with no recorded line): its LINE is structure, and a line the
	// panel cannot count on is a line the content below it moves by.
	private trail(box: HTMLElement, entry: NavHistoryEntry, d: NavEntryDescription): void {
		const trail = this.opts.trailFor(entry, d);
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

	// The two things a reader can do about the landing they are looking at: go
	// there, and say which of the two views they want to read first. They share one
	// bar because they are the same decision seen twice — "this is the spot" — and
	// because the panel's height belongs to the content.
	// A deleted note has neither: nothing under it travels, and there is no file
	// left to show whole. A file that is not a note travels but does not switch: it
	// has one view, its own source (see PreviewContent.showFile).
	private bar(box: HTMLElement, rep: number, entry: NavHistoryEntry, d: NavEntryDescription): void {
		const travels = !d.missing;
		const switches = !d.missing && entry.kind !== 'view' && isMarkdown(entry.path);
		// Drawn even when it holds neither control: a deleted note is the one row
		// whose bar is empty, and removing the bar would make the whole block
		// shorter for exactly that row (see styles.css).
		const bar = box.createDiv({ cls: 'nav-preview-bar' });
		if (travels) {
			// Travel to the landing being described — the one the pointer is on, or
			// "here" when nothing is pointed at. On TOUCH it is the only way to
			// travel at all: a tap points, and this button goes. Its quiet accent
			// wash is the panel's own decision (see styles.css): the app's filled
			// primary button was too loud beside the list, and an outline read as
			// disabled in dark themes.
			const go = bar.createEl('button', { text: t('navHistory.jumpHere'), cls: 'nav-preview-go' });
			go.addEventListener('click', () => this.opts.jump(rep));
		}
		if (switches)
			this.modes(bar);
	}

	// The switch between the two contents. Two buttons and not a menu: what they
	// choose between are two views of ONE spot, and the reader flipping between
	// them is comparing — which a menu would make a two-click operation.
	private modes(bar: HTMLElement): void {
		const modes = bar.createDiv({ cls: 'nav-preview-modes' });
		for (const mode of ['spot', 'note'] as PreviewMode[]) {
			const active = this.mode === mode;
			const btn = modes.createEl('button', {
				text: t(mode === 'spot' ? 'navHistory.preview.spot' : 'navHistory.preview.note'),
				cls: `nav-preview-mode${active ? ' is-active' : ''}`,
			});
			btn.setAttr('aria-pressed', active);
			btn.addEventListener('click', () => {
				if (this.mode === mode)
					return;
				// The choice lives in the session, not in this panel: see
				// setPreviewMode. The same row is then redrawn in the other view, so
				// the caption, the content and the pressed button cannot disagree.
				setPreviewMode(mode);
				this.render();
			});
		}
	}

	// The line above the content: what the reader is about to look at. The switch
	// is a preference that outlives the row it was set on, so this is where the
	// panel admits that a note which is GONE has no "as it stands now" — what is
	// under the caption is the recorded block whatever the switch was left on.
	private caption(box: HTMLElement, path: string, entry: NavHistoryEntry, d: NavEntryDescription): void {
		if (!isMarkdown(path)) {
			// One view, and it is not a choice: there is no recorded spot to name a
			// range for.
			if (!d.missing)
				box.createDiv({ cls: 'nav-preview-caption', text: t('navHistory.preview.source') });
			return;
		}
		if (this.mode === 'note' && !d.missing) {
			box.createDiv({ cls: 'nav-preview-caption', text: t('navHistory.preview.aside') });
			return;
		}
		const range = contextRange(entry);
		if (range)
			box.createDiv({
				cls: 'nav-preview-caption',
				text: t('navHistory.preview.recorded', range.from, range.to),
			});
	}

	// Keep the panel on screen after the selection moved: on touch it hangs
	// BELOW the selected row (see render), so the row alone being on screen is
	// not enough — the panel is where the button that travels with a finger
	// lives, and it must not open off the bottom edge.
	reveal(): void {
		this.opts.panel.scrollIntoView({ block: 'nearest' });
	}
}
