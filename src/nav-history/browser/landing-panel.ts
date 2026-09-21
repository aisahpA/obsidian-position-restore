import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { PANEL_PEEK } from './constants';
import { formatRelativeTime } from './listing';
import { contextRange, isMarkdown } from './markdown';
import { NavEntryDescription, folderOf, linkDisplayText } from './model';
import { PreviewMode } from './preview-content';

// The landing drawer: where the pointed-at landing sits (path, pane, type, where
// a link came from, line / total, age), the heading chain it sits under, and the
// landing's CONTENT — the recorded lines around it, rendered as markdown, or the
// whole note as it stands now (see PreviewContent).
//
// TWO PRESENTATIONS, ONE RENDERER, decided by the room the window has:
//  - DRAWER: the panel is a standing second column beside the list (see
//    styles.css). It is where the "which spot was this?" question is answered,
//    and it answers it for the row whose own gutter control asked (see
//    NavHistoryList.disclose) — the list stays scannable because the content it
//    would otherwise have to carry inline lives here instead. Its head is pinned
//    and its own content scrolls, so what the spot IS stays put however long the
//    note is.
//  - INLINE: no room for two columns, so the SAME content opens UNDER the row it
//    describes, in the list's own scroll flow. There is one scroller (the list) and
//    the panel's pinned block is pinned by THAT (see styles.css), so the same "which
//    spot, and can I go there" stays in reach while a whole note scrolls under it.
//    Parked at the bottom of the dialog it lost the fight for height the moment
//    there was history to scroll, and a panel nobody can see is a panel describing
//    a spot to nobody. The row that names the note is in that same scroll, so
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
// row promises the recorded spot. The whole note is one gear setting away for the
// reader who wants it (see NavHistoryBrowser.openSettings), and that is the only
// read behind any of this.

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
	// Which content the panel shows: the plugin's own PERSISTED preference, read live
	// (see NavBrowserPrefs). The panel neither owns the value nor remembers it — the
	// two shells, the settings file and the next app run all read the same one, and
	// the choice itself is made in the toolbar's gear (see
	// NavHistoryBrowser.openSettings), not here.
	previewMode: () => PreviewMode;
}

export class LandingPanel {
	// Which content the reader is looking at comes from the plugin's settings (see
	// the option): the choice outlives this panel, this dialog and this run, so the
	// panel asks rather than remembers.
	private get mode(): PreviewMode {
		return this.opts.previewMode();
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
	// of that position — a click or the keyboard, they are one thing (see
	// NavHistoryList.choose) — which is why the panel itself is a handful of nodes
	// around content the browser draws for it.
	render(): void {
		const box = this.opts.panel;
		const position = this.opts.position();
		// Which row the panel is about, in the order the reader's attention moves:
		//  - the POSITION, when there is one: the single row a click puts the panel
		//    on and the keyboard walks, so both hands describe the same spot (see
		//    NavHistoryList);
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
		// position, a note whose landings are printed, a filter that took the row away)
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

	// Forget the landing the panel was last describing, so the next render starts from
	// the position / "here" order instead of staying on a subject that has just gone
	// stale.
	//
	// Called by a shell that stays up across a travel (see NavHistoryBrowser's jump):
	// the jump rewrites the stack, so the landing this column was about — and the stack
	// index that named it — may now belong to another note. Inline "forgotten" is a
	// parked panel (nothing is pointed at); in the drawer it is the current entry, which
	// after a jump is the note the reader asked for.
	forget(): void {
		this.lastRep = -1;
	}

	// Put the panel away ENTIRELY: the details column is switched off (see
	// NavBrowserPrefs.showDetails), so there is nothing for the panel to describe until
	// it is switched back on.
	//
	// Not the same as the inline "nothing is pointed at" state (see render): that one
	// parks a panel which is still part of the browser, and the next click brings it
	// back. Here the panel is not drawn at all — the body takes the column out of its
	// flow (see styles.css) — so what is left of the panel's own state has to go with
	// it: the row it was pinned by, the row it was opened under, the landing it
	// remembered, and the mark on the row it was describing.
	putAway(): void {
		this.pin(undefined);
		this.openedUnder = undefined;
		this.lastRep = -1;
		const box = this.opts.panel;
		box.empty();
		// Back to the parking spot, which is also where the note about a switched-off
		// column is written: inline the panel is INSERTED under a row, and it is not
		// drawn there for a reader whose rows no longer ask for it.
		box.addClass('is-parked');
		if (box.parentElement !== this.opts.parkAt)
			this.opts.parkAt.appendChild(box);
		this.opts.onPreviewed(-1);
	}

	// The row the panel hangs under is PINNED to the top of the list while the panel is
	// still under it.
	//
	// That row is the whole of the gesture — it is what opened the panel, and a second
	// click on it puts the panel away again (see NavHistoryList.onClick) — and inline the
	// panel is a block in the list's OWN scroll: reading a long note scrolls the row off
	// the top, and the reader is left with a panel they cannot put away without scrolling
	// back for the handle. Pinned, the row (the note's name, its arrow) stays where the
	// finger left it, and the pinned block below it starts at the row's own foot (see
	// styles.css).
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
	// what it was, where it was, and then the lines themselves.
	//
	// TWO BLOCKS, and only the second one moves: the head, the trail and the caption
	// are PINNED at the top of the drawer, and the lines scroll under them (see
	// styles.css). A whole note is thousands of lines long, and a recorded block is
	// read by scrolling through it: either way, "which note, which spot" has to stay
	// where the reader can see it rather than being the first thing that leaves the
	// panel.
	private draw(box: HTMLElement, rep: number, entry: NavHistoryEntry): void {
		const d = this.opts.describe(rep);
		const top = box.createDiv({ cls: 'nav-preview-top' });
		// The head is drawn as a FIXED SHAPE — a name, a line of small print, a
		// section line, a caption line — whether or not this entry has anything for
		// each of them (see styles.css). The keyboard walks the list while the reader
		// reads this column, and a block that is one line shorter for the entries with
		// no section, or two lines shorter for a deleted file, made the lines below it
		// jump up and down under the eye.
		this.head(top, entry, d);
		// WHICH section the landing sits in is the cue a reader recognizes a spot
		// by, and it needs no file read. The full chain here (the row trims it).
		// Pinned with the name: it is part of what the spot IS.
		this.trail(top, entry, d);
		// …and the line the content cannot say about itself: which recorded lines
		// these are (see caption). Absent in the whole-note view, where there is
		// nothing of the sort to say.
		this.caption(top, entry, d);

		// …and what scrolls: the lines, and the labels that describe them (which
		// recorded lines these are, or that the file is gone). The whole-note view
		// keeps a scroller of its own even inline (the class says which it is, see
		// styles.css): a file is not a row's detail, and finding the recorded line in
		// it has to be able to move something other than the list.
		const scroll = box.createDiv({
			cls: `nav-preview-scroll${this.mode === 'note' ? ' is-note' : ''}`,
		});
		if (d.missing)
			scroll.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.gone') });
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
		// How the step was made, when it was not simply "opened": an open is what a
		// step IS by default, and a word for it in every row's small print says
		// nothing — the reader is looking at a history of things they opened. The
		// other four say something they may not know: that they arrived by a link or
		// the outline, that the step is a tab switch, or that it is an INFERRED move
		// rather than one they made (which the dimmed, italic styling underlines).
		if (!d.missing && !d.plainOpen)
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
		// nothing about where in the note the spot is. The whole-note view drops it:
		// the file in front of the reader is not the file the number was measured
		// against, and where the spot sits in it can be seen.
		if (d.line) {
			const size = this.mode === 'spot' && d.lineCount ? `${d.line} / ${d.lineCount}` : d.line;
			meta.createSpan({ text: size, cls: 'nav-row-line' });
		}
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

	// The line above the content: WHAT the reader is looking at, where there is
	// something to say about it. The sentence is pinned with the head, because a
	// reader who has scrolled into a whole note still has to be able to tell which
	// part of the column is the fixed one.
	//
	// WHICH of the two contents is on screen is NOT said here: that choice is a
	// setting, made in the toolbar's gear and the same on every row (see
	// NavHistoryBrowser.openSettings), so a sentence naming it would be the same line
	// of chrome on all of them. What is left is what the content cannot say about
	// itself: the range the recorded block covers (a file that is not a note has one
	// view, its own source, and no range to name; a step with no file left has neither
	// the range nor the content).
	private caption(box: HTMLElement, entry: NavHistoryEntry, d: NavEntryDescription): void {
		const text = this.captionText(entry, d);
		// A row with nothing in it is not drawn: the pinned block's fixed shape is
		// about the lines that are always there (the head, the section), and an
		// empty caption line for the graph would be a line of nothing on a phone.
		if (!text)
			return;
		const row = box.createDiv({ cls: 'nav-preview-caption-row' });
		row.createDiv({ cls: 'nav-preview-caption', text });
	}

	// What the caption SAYS, or nothing when there is nothing to say. Two cases, both
	// about what the content cannot say for itself: which lines the recorded block
	// covers (the rendered lines have no gutter of their own left to say it), or — for
	// a file that is not a note — that its source is the only view there is.
	//
	// The WHOLE-NOTE view says nothing: the content is the note, and "this is the note
	// as it stands" is a constant, which is what makes it chrome (see NavBrowserPrefs).
	// The one exception is a step whose file is GONE: there is no note to show whole,
	// so what is under the caption is the recorded block after all — and then which
	// lines those are is exactly the thing worth saying.
	private captionText(entry: NavHistoryEntry, d: NavEntryDescription): string | undefined {
		if (entry.kind === 'view')
			return undefined;
		if (!isMarkdown(entry.path))
			return d.missing ? undefined : t('navHistory.preview.source');
		if (this.mode === 'note' && !d.missing)
			return undefined;
		const range = contextRange(entry);
		return range ? t('navHistory.preview.recorded', range.from, range.to) : undefined;
	}

	// Keep the panel in view after the position moved — inline only, where the panel
	// hangs BELOW the row it describes (see render). Two things have to be visible and
	// they cannot both fit: the ROW, whose gutter control is the only thing a finger
	// can use to put the panel away again, and the panel's own TOP, where the caption
	// and the first of the lines are. The panel as a whole never fits — it
	// is taller than the list it sits
	// in — so the list is moved just far enough to leave PANEL_PEEK under the row, and
	// NO further: the scroll stops when the note's own row — the name, or the landing row
	// that was chosen under 'all' — reaches the top of the list. A phone reported both
	// halves of that: opening a panel scrolled the name out of sight, and without it
	// there is nothing left to tap to put the panel away again.
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
			// …and the list never moves past the NOTE's own row, which is the handle that
			// put the panel there: a name that has left the list is a row the reader has to
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
