import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { PANEL_PEEK } from './constants';
import { formatRelativeTime } from './listing';
import { contextRange, isMarkdown } from './markdown';
import { NavEntryDescription, folderOf, linkDisplayText } from './model';
import { PreviewMode, previewMode, setPreviewMode } from './preview-content';

// The landing drawer: where the pointed-at landing sits (path, pane, type, where
// a link came from, line / total, age), the heading chain it sits under, and the
// landing's CONTENT — the recorded lines around it, rendered as markdown, or the
// whole note as it stands now (see PreviewContent).
//
// TWO PRESENTATIONS, ONE RENDERER, decided by the room the window has:
//  - DRAWER: the panel is a standing second column beside the list (see
//    styles.css). It is where the "which spot was this?" question is answered,
//    and it answers it for whatever the pointer or the keyboard is on — the list
//    stays scannable because the content it would otherwise have to carry inline
//    lives here instead. Its head is pinned and its own content scrolls, so the
//    travel button and the view switch stay put however long the note is.
//  - INLINE: no room for two columns, so the SAME content opens UNDER the row it
//    describes, in the list's own scroll flow. There is one scroller (the list) and
//    the panel's pinned block is pinned by THAT (see styles.css), so the same "which
//    spot, and can I go there" stays in reach while a whole note scrolls under it.
//    Parked at the bottom of the dialog it lost the fight for height the moment
//    there was history to scroll, and a panel nobody can see is a "jump here"
//    button nobody can tap. The row that names the note is in that same scroll, so
//    reading a long note used to take the row — the one handle a tap has — off the
//    top: while the panel is under it, that row is pinned to the top instead (see
//    sync), so the same tap that opened the panel puts it away again.
// Which one it is comes from the browser (NavHistoryModal.inline): a pointing
// device always has the room, and so does a touch device wide enough — a phone held
// sideways, a tablet — where stacking the panel would leave the list a row and the
// panel nowhere to go.
//
// It shows the entry's OWN recorded block by default (see NavEntryState.context)
// rather than reading the file: no vault IO, no loading state, no dependence on
// the file still existing, and no chance of printing today's content where the
// row promises the recorded spot. The whole note is one switch away for the
// reader who wants it, and that is the only read behind any of this.

export interface LandingPanelOptions {
	// The element the panel draws into (created by the browser beside the list).
	panel: HTMLElement;
	// Where the panel waits while it has no row to open under (inline).
	parkAt: HTMLElement;
	// The list element — the scroller the panel shares when it is inline (see reveal).
	list: HTMLElement;
	// Whether the panel opens INSIDE the list, under the row it describes, instead of
	// standing beside it as the second column (see the class comment).
	inline: () => boolean;
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
	// The row an INLINE panel opens under, or undefined when the position is on a note
	// whose landings are already on screen: see NavHistoryList.panelAnchor.
	anchorRow: () => HTMLElement | undefined;
	// The NOTE row a row belongs to — the file name above it, or the row itself when it
	// is one. reveal keeps it on screen (see NavHistoryList.noteRowOf).
	noteRowOf: (row: HTMLElement) => HTMLElement | undefined;
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

	// The row the panel was last drawn UNDER, while inline (see render). It is what
	// reveal has to keep on screen: the panel is inserted after it, so the row and the
	// panel's own top are the two things the reader needs — and the panel cannot be
	// brought into view whole, because it is taller than the list it sits in.
	private openedUnder?: HTMLElement;

	// The row the panel is pinned BY, while it is stuck to the top of the list (see sync).
	// Kept so the class can be taken off the row it went on: the row is rebuilt by every
	// render of the list, and this is the one the panel last put it on.
	private pinRow?: HTMLElement;
	// How far the panel's own top sits below that row in the list's flow. A flow distance —
	// measured with the pin off (see render), because a pinned row is not where the flow put
	// it, and a scroll moves the two together.
	private pinGap = 0;

	constructor(private opts: LandingPanelOptions) {
		// The panel is drawn INTO the list inline, and the list is what scrolls: whether the
		// row it hangs under is still in sight is the one thing about the panel a renderer
		// cannot know (see sync). Bound once, on the element that owns the scroll — the panel
		// is redrawn for every move of the position, and this is not a fact about the
		// position.
		this.opts.list.addEventListener('scroll', () => this.sync(), { passive: true });
	}

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
		//  - …but INLINE only a position counts: there the panel exists for the row a
		//    finger has actually tapped, so with nothing tapped it stays out of the list
		//    rather than opening by itself.
		const sticky = this.lastRep >= 0 && this.opts.standsFor(this.lastRep) ? this.lastRep : -1;
		const rep = position >= 0 ? position
			: this.opts.inline() ? -1
				: sticky >= 0 ? sticky : this.opts.here();
		const entry = this.opts.entryAt(rep);
		if (entry)
			this.lastRep = rep;
		// …and which row that turned out to be: the "here"/"last" fallbacks are ones
		// the LIST cannot know about, so the panel reports the resolution it just made
		// rather than leaving the list to guess at it.
		this.opts.onPreviewed(entry ? rep : -1);
		box.empty();

		// WHERE it hangs — the one thing the two presentations do not share. Inline it
		// opens under the row it describes and travels with it; with no such row (no
		// position, a note whose landings are on screen, a filter that took the row away)
		// it waits out of the way. The drawer's place is the body's second column, where
		// the browser built it: a panel that arrives there from the inline presentation
		// (a rotation across the width the drawer needs) has to come back to it.
		//
		// The PIN comes off first, and for the same reason: a pinned row is not where the
		// list's flow put it, and the two distances measured below are flow distances.
		this.pin(undefined);
		this.openedUnder = undefined;
		if (this.opts.inline()) {
			const row = this.opts.anchorRow();
			if (!entry || !row) {
				this.opts.parkAt.appendChild(box);
				box.addClass('is-parked');
				this.sync();
				return;
			}
			row.insertAdjacentElement('afterend', box);
			box.removeClass('is-parked');
			this.openedUnder = row;
			// …and where the NOTE's own row is, relative to the panel: the panel hangs under
			// the row that was pointed at, which for a note with several landings is BELOW the
			// note's row — so the name leaves the list before the panel's own top does, and the
			// distance between the two is what sync needs to know (the pin is off here).
			const note = this.opts.noteRowOf(row);
			const room = note?.getBoundingClientRect();
			this.pinGap = room ? box.getBoundingClientRect().top - room.bottom : 0;
			// The pinned block starts below the pinned row rather than under it: the height is
			// the row's, and the row is the same height whether or not it is pinned.
			box.style.setProperty('--nav-pin-row', `${room?.height ?? 0}px`);
		} else {
			if (box.parentElement !== this.opts.parkAt)
				this.opts.parkAt.appendChild(box);
			box.removeClass('is-parked');
		}

		if (!entry) {
			// Neither a pointed-at row nor a current entry to fall back on (an
			// empty history): say what the column is for rather than sit blank.
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.pick') });
			this.sync();
			return;
		}
		this.draw(box, rep, entry);
		this.sync();
	}

	// The row the panel hangs under is PINNED to the top of the list while the panel is
	// still under it.
	//
	// That row is the whole of the touch gesture — a tap on a note's row opens it and a
	// second tap closes it again (see NavHistoryList.onTap) — and inline the panel is a
	// block in the list's OWN scroll: reading a long note scrolls the row off the top, and
	// the reader is left with a panel they cannot put away without scrolling back for the
	// handle. Pinned, the row (the file's name, its caret, its count) stays where the finger
	// left it, and the pinned block below it starts at the row's own foot (see styles.css).
	//
	// Only while the panel is still on screen: once the panel has gone by entirely, the row
	// goes back into its slot rather than hanging over rows that have nothing to do with it.
	//
	// What decides it is the PANEL's rect, never the row's own: pinning the row does not move
	// the panel by a pixel, so the state cannot oscillate with the thing it decides.
	private sync(): void {
		const note = this.openedUnder ? this.opts.noteRowOf(this.openedUnder) : undefined;
		// Nothing to pin, and nothing pinned: a parked panel, or the drawer. Asked before any
		// rect is, because this runs on every scroll of the list.
		if (!note && !this.pinRow)
			return;
		const view = this.opts.list.getBoundingClientRect();
		const panel = this.opts.panel.getBoundingClientRect();
		// Two ways of having no row to pin: a parked panel, and the DRAWER — where the panel
		// is a column of its own standing beside the list, and no scroll of the list can take
		// the row out from under it. And no layout to measure (a test, or a panel not laid out
		// yet): nothing has gone anywhere.
		const stuck = note !== undefined && view.height > 0
			&& panel.top < view.top + this.pinGap && panel.bottom > view.top;
		this.pin(stuck ? note : undefined);
	}

	// Put the pin on a row, or take it off the row that has it: the sticky class on the row
	// itself, and the class that moves the panel's own pinned block below it.
	private pin(row: HTMLElement | undefined): void {
		if (row === this.pinRow)
			return;
		this.pinRow?.removeClass('is-stuck');
		row?.addClass('is-stuck');
		this.pinRow = row;
		this.opts.panel.toggleClass('is-row-pinned', row !== undefined);
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

	// Keep the panel in view after the position moved — inline only, where the panel
	// hangs BELOW the row it describes (see render). Two things have to be visible and
	// they cannot both fit: the ROW, which is the only thing a finger can tap to put the
	// panel away again, and the panel's own TOP, where the travel button and the view
	// switch are. The panel as a whole never fits — it is taller than the list it sits
	// in — so the list is moved just far enough to leave PANEL_PEEK under the row, and
	// NO further: the scroll stops when the note's own row — the file name, or for a note
	// with several landings the row that was chosen — reaches the top of the list. A
	// phone reported both halves of that: opening a panel scrolled the name out of sight,
	// and without it there is nothing left to tap to close the note again.
	//
	// (The drawer needs none of this: the panel is a column of its own, with its head
	// pinned and its content scrolling under it — see styles.css.)
	reveal(): void {
		const row = this.openedUnder;
		if (!row)
			return;
		const view = this.opts.list.getBoundingClientRect();
		// No layout to measure (a test, or a panel not laid out yet): there is nothing
		// to move and nothing to move it by.
		if (view.height <= 0)
			return;
		const rect = row.getBoundingClientRect();
		// A list shorter than its own row cannot spare the peek: what is left of it.
		const peek = Math.min(PANEL_PEEK, Math.max(0, view.height - rect.height));
		if (rect.bottom > view.bottom - peek) {
			// …and the list never moves past the NOTE's own row, which is how the note is
			// closed again: a name that has left the list is a note the reader has to
			// scroll back to. The landing that was picked is below it and comes along.
			const keep = this.opts.noteRowOf(row) ?? row;
			const room = Math.max(0, keep.getBoundingClientRect().top - view.top);
			this.opts.list.scrollTop += Math.min(rect.bottom - (view.bottom - peek), room);
		} else if (rect.top < view.top) {
			// The row itself is above the list (the reader scrolled on after the panel
			// opened): bring it back, which cannot cost the note row anything — this
			// moves the content DOWN.
			this.opts.list.scrollTop -= view.top - rect.top;
		}
		// A programmatic move is heard by the scroll listener in a real browser; asking
		// again here is what makes the pin the reader comes back to correct on the frame it
		// comes back on, and what makes a test's move enough (see sync).
		this.sync();
	}
}
