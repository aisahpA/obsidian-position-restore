import { Keymap } from 'obsidian';
import { NavHistoryEntry } from '@/nav-history/entry';
import { PaneTarget } from '@/nav-history/places';
import { t } from '@/i18n';
import { groupByFile, LandingsMode, matchesNavFilter } from './listing';
import { PathDisplayMode } from '@/types';
import {
	NavEntryDescription, ageLabel, badgeOf, displayName, duplicateNames, folderOf, newestStamp, rowTrail,
} from './model';
import { NavRowTip, TipContent } from './tip';

// The list of notes, and everything that belongs to a row: which steps the query
// keeps, how they group into one row per note, what the keyboard walks, and the
// ONE position a click moves — the same position the keyboard walks, and nothing
// else about the row (there is no per-cell meaning left in one).
//
// THE NOTE IS THE ROW. It used to be one row per step, with repeats of one
// landing collapsed into a ×N and the note's name printed once per run of its own
// rows — a flat chronology in which a note opened ten times was ten lines, and
// two notes sharing a name were two indistinguishable lines. The panel now says
// what a reader asks it: which note, and where in it. A note is one row, and a
// name two notes share prints its folder to say which one it is.
//
// THE ROW IS THE FILE, AND A FILE ROW IS AN OPEN. The places the panel draws are
// the recent-files list's (see places.ts), and a note's record there carries no
// position: its row opens the file the PLAIN way, exactly as Obsidian's file
// explorer does, and the position database decides where the reader lands. That
// is what keeps the two entry points to one file from behaving differently — and
// it is why a file row never prints a line (the line it would print is a jump's
// business, see placeRow).
//
// WHAT IS UNDER THE ROW IS THE SETTING, and only that (see LandingsMode). By
// default there is NOTHING under it: the reader's own navigation is by file.
// Every place the note holds is one value away ('all'), which prints them under
// the name by line, top of the note first (see groupByFile: inside one note the
// order it was visited in says nothing); the same line reached twice is one
// place, not two rows that read alike. A note with ONE place prints none under
// it either way: a single place is not a list, and the row already stands for the
// note as a whole.
//
// There is no third state between them, and no expansion: a note's row used to
// open and close its own landings, which made the row's click mean "open" for a
// note with several spots and "point at it" for a note with one, added a count
// (+N) to advertise what was hidden, and gave the arrow keys a second meaning.
// With the spot a note stands for already on the row (it is what the arrow
// travels to and what the panel describes), the tree cost a click to reach the
// same place, and the reader who wants the other spots says so once, in the
// setting, rather than per note.
//
// THE ROW IS ONE THING: a click opens what it stands for — a note the plain way, a
// jump at its recorded spot (see places.travel). There used to be a second hotspot in
// the row's left gutter: a control that expanded the row's own details in a panel
// beside (or under) the list. It is gone with the panel. What the panel was for — the
// small print about a step, and a rendering of the note content — turned out to be
// dominated by the click: the plugin's promise is that a row lands EXACTLY where the
// reader left, in the real editor, and a name plus its coordinate plus its section is
// what a reader picks a row by. So the gutter is gone, the rows are one target wide,
// and the list is what the panel always was in practice: a list of places to go.
// The keyboard does the same thing without a pointer: ↑↓ step through the rows on
// screen, Enter opens.
//
// NOTHING MOVES ON HOVER, which is the whole of the rule this list is built on: the
// pointer used to drive the position directly — a mouse crossing the list moved it and
// the panel beside it followed. A list that lurches under a passing mouse points at a
// row nobody chose, so the position moves only for a click or a key. The arrow travels,
// and the row's own click travels; no other button does (see onContextMenu).
//
// NOTHING MOVES WHILE IT IS BEING READ either, which is the same rule one step later:
// a click that opens a note re-orders the places it came from (they are kept by last
// visit), so without being told otherwise the list would answer the click by shuffling
// itself — the row just read moves to the top, every row above it moves down one, and
// the reader's eye is left on a different note than the one it was on. The list can
// therefore be handed the order it is currently showing and told to hold it (see the
// `order` option): the rows stay where they are while the reader's attention is on
// them, and the order catches up the moment they look away.
//
// The list owns its rows and one POSITION among them: `selected`, which the keyboard
// walks (see move) and a redraw re-finds. It is what Enter travels to and what is
// announced to a screen reader. A CLICK does not set it: a click opens what the row
// stands for, and the modal closes on the way — there is nothing left pointing at a row
// nobody would ever see. The browser follows it through callbacks — it never reaches
// into the rows.

// One row as the class keeps it: the element, and what it stands for. A FILE
// row's landings are the steps, so a travel from it reads `group`; its `rep`,
// when it has one, is only the landing the row itself stands for (see fileRow).
interface RowRef {
	el: HTMLElement;
	// The place index the row acts on — a LANDING row's own index. A note row
	// carries none: its identity is the group (see fileRow), and its place is
	// resolved from that group when it is needed (see activeRep).
	rep?: number;
	group?: number;
}

export interface NavHistoryListOptions {
	// The list element, created by the browser.
	list: HTMLElement;
	// The history the rows are drawn from, as one snapshot.
	entries: NavHistoryEntry[];
	// The stack index of the current entry: its note is pinned first, and — where the
	// setting prints a note's landings — the landing that holds it carries the "you are
	// here" marker (see placeRow).
	currentIndex: number;
	// The id the browser gave the list element. Row option ids are built from
	// it, so they are unique in the document even with a second browser open
	// (see NavHistoryModal.listId) — aria-activedescendant has to name exactly
	// one row.
	listId: string;
	// The search box's current text.
	filter: () => string;
	// One entry's display pieces (cached by the browser).
	describe: (rep: number) => NavEntryDescription;
	// Drop the per-render describe cache: the rows it described are gone.
	clearDescribeCache: () => void;
	// Whether a note still exists on disk. It is how a place is FILTERED, not how a
	// row is disabled: a name whose file is gone is not listed at all — not even when
	// it is the place the reader is standing in, and not even as a gap. The list is a
	// list of places to go to, and a row that opens nothing is the one thing its own
	// rules elsewhere refuse to draw.
	noteExists: (path: string) => boolean;
	// The heading chain an entry's landing sits in.
	trailFor: (entry: NavHistoryEntry, d: NavEntryDescription) => string[];
	// The OTHER names the file goes by (see reads.ts's aliasesFor), which the query
	// matches on and the row's own tooltip prints (see tip.ts). They take up no cell on
	// the row, so the search box and the hover are the only two places they exist for a
	// reader — and a pathless view has none (the browser answers [] for it).
	aliasesFor: (path: string) => string[];
	// Which live tab holds a landing's destination, if it needs saying.
	paneName: (entry: NavHistoryEntry) => string | undefined;
	// The position moved to another row, or off the list (undefined), by either
	// hand. The focus never leaves the filter box — typing narrows the list from the
	// same keys that move through it — so this is what makes the current option
	// audible: the browser points the box's aria-activedescendant at the row id.
	onActiveRow: (id: string | undefined) => void;
	// A row was clicked with a pointing device: open the file at what it stands
	// for. The row IS the navigation, so this fires from the row's own click (see
	// onClick). `target` is where to open it when the reader asked for somewhere
	// other than the tab the file lives in — a new tab, a split, a window — and is
	// the app's own answer for the gesture, never a modifier this module read
	// itself (see PaneTarget and onPress / onClick).
	onTravel: (rep: number, target?: PaneTarget) => void;
	// A row was right-clicked: WHICH place, and the event, so the browser can raise
	// the app's own file menu over it (see body.ts's contextRow). The list does not
	// build the menu because it does not hold the app, and a row here is a row of
	// PLACES, not of files: which of them has a file behind it is the browser's
	// question (a pathless view has none).
	onContextRow: (rep: number, ev: MouseEvent) => void;
	// How much of a note the list prints (see shownLandings): one row per note — the
	// plugin's default, the row standing for the last spot the note was left at — or
	// every distinct spot under the name, one row each.
	// Read per render, so the toolbar's setting reaches a panel that is already up.
	landings: () => LandingsMode;
	// How much of a row's PATH to print, and on which side of the name (see
	// PathDisplayMode). Read per render like the setting above.
	pathDisplay: () => PathDisplayMode;
	// Whether a row says how long ago its note was last visited (see model.ts's
	// ageLabel). Off, the row's structure is exactly what it was before the label
	// existed: no element is built and none is hidden.
	rowTime: () => boolean;
	// The group order to HOLD the list at, by group key (see listing.ts::
	// NavFileGroup.key), or undefined to order by recency like a list nobody is
	// reading. Read per render: the browser takes an order when the pointer
	// arrives and drops it when the pointer leaves, so it is the browser — and
	// not the list — that decides when the list may move again.
	order: () => readonly string[] | undefined;
	// A place's IDENTITY (`placeKey`). Injected rather than imported because the
	// list does not hold the store: it is handed the places as a plain array (see
	// `entries`), and an identity has to come from the module that defines what
	// makes two places one. It is what a click re-finds its row by when the list
	// has been rebuilt underneath it (see onClick) — an INDEX cannot serve, since
	// the whole reason for the re-find is that indices moved.
	keyOf: (rep: number) => string | undefined;
}

// How far the list has to scroll to show a step the KEYBOARD took: undefined while
// the row the walk arrived on is wholly inside the list, and otherwise the distance
// that puts the row's middle at the list's middle.
//
// What it must not be is the smallest scroll that brings the row back into sight.
// The position walks one row per key and the rows are all the same height, so a
// minimal scroll moves the list exactly as far as the row moved: the row then sits
// FLUSH against the edge, and every further step scrolls the note names under a
// mark that never moves again. That reads as "the scrollbar is moving, not the
// selection" — the reader pressing ↓ at the foot of the list watches the mark stand
// still while the list runs out from under it. Landing an off-list row in the
// MIDDLE instead costs one jump per half-list of walking, and keeps every step
// visibly a step.
//
// A CLICK's own move does NOT come through here: putting the position on a row owes
// that row no more than being legible, and the view belongs to the reader (see
// reveal).
export function revealDelta(rowTop: number, rowHeight: number, boxTop: number, boxHeight: number): number | undefined {
	if (rowTop >= boxTop && rowTop + rowHeight <= boxTop + boxHeight)
		return undefined;
	return Math.round(rowTop - (boxTop + (boxHeight - rowHeight) / 2));
}

export class NavHistoryList {
	// The rows on screen, top to bottom: a note row, and under it its landings when
	// the setting prints them (see shownLandings). The keyboard walks THIS, so what
	// is not on screen is not walked.
	private refs: RowRef[] = [];
	// The groups of the last render: what a file row's `group` indexes into.
	private groups: ReturnType<typeof groupByFile> = [];
	// THE position: the row the reader is on. The arrow keys walk it (see move), and a
	// pointer moves nothing (see the class comment). Undefined until the first key: Enter
	// has nothing to act on until then.
	private selected: RowRef | undefined;
	// The place the reader PRESSED, by identity (see onPress), until the click that
	// belongs to it arrives. It is what a click opens FROM when the list has been
	// rebuilt between the press and the release — the one case where the element the
	// event names no longer stands for what it stood for (see onClick). Only ever a
	// pass-through: any press overwrites it and any click consumes it.
	private pressed?: string;
	// What a row says on hover, drawn by the panel rather than by the browser (see
	// tip.ts): the only place a full path can be said in a type the reader can read.
	private tip: NavRowTip;

	constructor(private opts: NavHistoryListOptions) {
		// Nothing is listened to here for the LIST's own sake: a pointer moves no
		// position at all (see the class comment) — the rows' own clicks are wired as
		// the rows are drawn. The tooltip is the one pointer reader, and it answers with
		// words rather than with a move.
		this.tip = new NavRowTip(opts.list);
	}

	// The place index a row acts on: a landing is itself; a NOTE is the note's OWN
	// record — the place that stands for the file rather than for a spot inside it
	// (see listing.ts's `anchor` and places.ts).
	//
	// That is what makes a file row an OPEN and not a jump: its record carries no
	// position of its own, so travelling to it opens the file the plain way and lets
	// the position database decide where the reader lands — exactly what clicking the
	// same file in Obsidian's file explorer does. It used to stand for the note's
	// NEWEST landing, which was right while every row was a stack step and every step
	// carried a spot; with places it would make the note's name a jump to wherever the
	// reader last clicked a heading.
	//
	// A group with no anchor — a note whose own record has been evicted while the
	// jumps made inside it survive — falls back to its newest landing, and still has
	// somewhere to go.
	//
	// Every row this answers for HAS somewhere to go: a place whose file is gone never
	// becomes a row in the first place (see render's `keep`), so the only way to -1
	// here is a group the list no longer holds.
	//
	// The note's row has NO other input: what the reader merely LOOKED at (a landing's
	// own row, the gutter control, the arrow keys) moves the description and nothing
	// else.
	private activeRep(row: RowRef): number {
		if (row.group === undefined)
			return row.rep ?? -1;
		const group = this.groups[row.group];
		if (!group)
			return -1;
		if (group.anchor !== undefined && group.anchor >= 0)
			return group.anchor;
		const order = group.indices;
		// The place index IS the clock (the list is kept in MRU order, see
		// places.ts): the highest index among a note's landings is its newest one.
		return order.length ? order.reduce((a, b) => (a > b ? a : b)) : -1;
	}

	// Whether this note's landings are printed under its own row right now — the
	// setting's 'all', and a note that HAS more than one landing to print. One
	// landing is not a list: it is what the note's own row stands for (see
	// activeRep), so a second row one line under the name, saying the same thing,
	// would be a row of chrome for nothing.
	private printsLandings(group: number): boolean {
		return this.opts.landings() === 'all' && (this.groups[group]?.indices.length ?? 0) > 1;
	}

	// WHICH of a note's places are on screen: none by default — the list is one row
	// per note (see LandingsMode) — and under 'all', every distinct line, in the line
	// order `indices` already carries (top of the note first, never with the newest
	// pulled to the top).
	private shownLandings(group: ReturnType<typeof groupByFile>[number], index: number): number[] {
		return this.printsLandings(index) ? group.indices : [];
	}

	// (Re)draw the rows; the toolbar and the panel persist around them.
	render(): void {
		// Whatever the pointer was resting on is about to be thrown away: the tooltip
		// it earned points at a row of the previous render, and leaving it up would
		// leave the panel describing a row that is no longer on screen (see tip.ts).
		this.tip.reset();
		// The cursor's identity across the rebuild: the note's group index, or the
		// stack index of the landing it is on (which may be the CURRENT entry's own
		// or any other). Captured BEFORE the rows go, and re-found after.
		const cursor = this.selected;
		const wasGroup = cursor?.group;
		const wasRep = cursor && cursor.group === undefined ? cursor.rep ?? -1 : -1;
		this.opts.list.empty();
		this.opts.clearDescribeCache();
		this.refs = [];
		this.groups = [];
		this.selected = undefined;

		const query = this.opts.filter().trim();
		// The query narrows on text: what the row prints (name, path, section
		// chain, "L412") plus what the entry recorded (the landing's context
		// block, how a link got here). The row's own printed text is derived from
		// the vault's heading cache rather than carried by the entry, so the pure
		// predicate takes it as an argument (see matchesNavFilter). This closure is
		// called only while a query is up.
		//
		// An UNFILTERED list does still read the metadata cache, once per listed path:
		// a file's other names are searchable and also printed on the row's own tooltip
		// (see fileRow), and that tooltip is prepared with the row rather than when the
		// pointer arrives — a hover has to be answered with the row's OWN answer, and a
		// row is drawn once. It is one memoized lookup per path per body (see reads.ts),
		// and the honest statement of the rule is that, not "the list never asks".
		const printed = (i: number): string => {
			const entry = this.opts.entries[i];
			const d = this.opts.describe(i);
			// …and the file's OTHER names, which nothing on the row prints: this is what
			// the `extra` channel is for (see matchesNavFilter), and it is why the panel
			// can be searched for a name the reader only half remembers. Read per PATH, so
			// every landing of one note carries the same names.
			const aka = entry.kind === 'view' ? [] : this.opts.aliasesFor(entry.path);
			return `${d.line ?? ''} ${this.opts.trailFor(entry, d).join(' ')} ${aka.join(' ')}`;
		};
		// …and WHAT may be listed at all: a place whose file is gone is dropped before
		// the list is grouped, so no row, no landing and no "you are here" ever stands
		// for a name that cannot be opened. The store prunes such a place by itself (see
		// PathBookkeeper); this is the list agreeing with it, and it is also what covers
		// the moment before that prune lands. A VIEW place is exempt: the graph has no
		// file to be gone.
		const listed = (i: number): boolean => {
			const entry = this.opts.entries[i];
			return entry.kind === 'view' || this.opts.noteExists(entry.path);
		};
		const keep = (i: number) => listed(i)
			&& (!query || matchesNavFilter(this.opts.entries[i], query, printed(i)));
		this.groups = groupByFile(
			this.opts.entries,
			this.opts.currentIndex,
			keep,
			// The line a row PRINTS is what makes two steps one spot, so the
			// collapse and the coordinates can never disagree (see groupByFile).
			i => this.opts.describe(i).lineIndex,
			// The order to hold, when the reader is on the list (see the option).
			this.opts.order(),
		);
		// The names two notes on screen share: those rows are the only ones that
		// print their folder (see folderOf). Measured over the rows ON SCREEN, so
		// a collision the filter dropped costs nobody a folder.
		const doubles = duplicateNames(this.groups.map(g => g.path));

		// A note row is drawn for every group, and there is no row the list holds
		// back: the CURRENT entry's note is pinned first like any other, and — unlike
		// before — its own row is a destination too (see targetOf), so a history of
		// one step is a one-row list rather than a list with no way out.
		this.groups.forEach((group, index) => {
			this.fileRow(group, index, doubles);
			for (const i of this.shownLandings(group, index))
				this.placeRow(i, i === group.currentRep);
		});

		// Nothing to draw: the query found no step to list, or the history has nothing
		// left to name. Asked of the ROWS, because that is what the reader sees — and
		// every row on screen is a destination now that a place without a file is
		// filtered out before grouping.
		if (!this.refs.length)
			this.opts.list.createDiv({
				cls: 'position-restore-nav-empty',
				text: this.emptyText(query),
			});
		// The row the cursor was on came back (the same landing, or the same
		// note): keep it. The elements are new, but the identity is not.
		if (wasGroup !== undefined) {
			const row = this.refs.find(r => r.group === wasGroup);
			if (row)
				this.choose(row);
		} else if (wasRep >= 0) {
			const row = this.refs.find(r => r.group === undefined && r.rep === wasRep);
			if (row)
				this.choose(row);
			else
				// The landing is gone (the filter dropped it, or the setting stopped
				// printing the note's landings): the note it belonged to is what is
				// left to stand on.
				this.focusGroupOf(wasRep);
		}
	}

	// What the list says when it has nothing to draw. Two different nothings: the
	// query found no step to list, or there is no place left to name at all — a
	// history with nothing in it, or one whose every file is gone (those places are
	// dropped before grouping, see render). A single place the reader is standing in
	// is NOT one of them: its row opens it (see targetOf). One message for both,
	// decided by the query; render's `!refs.length` branch is the only caller.
	private emptyText(query: string): string {
		return query ? t('navHistory.noMatch') : t('navHistory.empty');
	}

	// The groups as they are drawn RIGHT NOW, by identity: what the browser pins
	// when the pointer arrives (see NavHistoryListOptions.order). It is asked of
	// the LIST rather than recomputed by the caller because the order on screen is
	// this render's — the filter in force, the places as they were grouped, and any
	// order already being held all went into it.
	orderedKeys(): string[] {
		return this.groups.map(g => g.key);
	}

	// Stand on the note a landing belonged to, when that landing itself is no
	// longer on screen.
	private focusGroupOf(rep: number): void {
		for (let g = 0; g < this.groups.length; g++) {
			if (this.groups[g].indices.includes(rep)) {
				const row = this.refs.find(r => r.group === g);
				if (row)
					this.choose(row);
				return;
			}
		}
	}

	// One NOTE. The row's name CELL holds the NAME — its last path segment
	// without the extension (see displayName) — then the type BADGE where the file is
	// not markdown, then the FOLDER, on the side and under the conditions the reader
	// chose (see PathDisplayMode). Beside that cell, at the row's far end and only
	// where the reader asked for it, stands the AGE (see the rowTime option): a track
	// of the row rather than a fourth thing in the name, so the times end on one x
	// down the whole list whichever half of the name wrapped. A pathless view row (the
	// graph) prints no folder and no badge: it is one view, not a note with spots in
	// it, and it has no file on disk to have a type.
	//
	// The row is its NAME and nothing else. The caret that used to lead it opened a
	// sublist of the note's landings and carried a "+N" count of what was hidden; both
	// went with the expansion, and the gutter control that replaced the caret went with
	// the details panel it opened (see the class comment). One row, one click, one
	// destination.
	private fileRow(group: ReturnType<typeof groupByFile>[number], index: number, doubles: Set<string>): number {
		// The note's own record when it has one (see activeRep), else any landing
		// it holds: the row needs ONE record to read the name and the view kind from.
		const rep = group.anchor
			?? group.indices.find(i => i !== group.currentRep)
			?? group.indices[0];
		const head = rep === undefined ? undefined : this.opts.describe(rep);
		const name = head?.name ?? displayName(group.path);
		const row = this.opts.list.createDiv({ cls: 'position-restore-nav-row is-file' });
		if (group.current)
			row.addClass('is-current');
		// WHICH SIDE the folder prints on, as a class rather than as an insertion
		// order: the DOM order is fixed (name, badge, folder) so that the row reads
		// in one order however it is drawn, and the visual order is the stylesheet's
		// (see the `order` rule). The two differ only for 'before' — and that is also
		// the only case where the name, and not the folder, is what drops to a second
		// line when the row is too narrow.
		const mode = this.opts.pathDisplay();
		if (mode !== 'after')
			row.addClass('is-path-before');
		row.dataset.group = String(index);
		row.setAttr('id', `${this.opts.listId}-row-g${index}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		// The row's own click is the one thing that acts through this. A file row's
		// identity is the GROUP: `rep` stays undefined, because a file row stands for the
		// note (see activeRep) rather than for any one landing.
		const ref: RowRef = { el: row, group: index };
		row.addEventListener('click', (ev) => this.onClick(ref, ev));
		row.addEventListener('pointerdown', (ev) => this.onPress(ref, ev));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);

		const file = row.createDiv({ cls: 'nav-row-file' });
		file.createSpan({ text: name, cls: 'nav-row-name' });
		// The type, where the type is worth saying: markdown is what a vault is made
		// of and prints nothing (see badgeOf). It sits beside the name and BEFORE the
		// folder, so it stays with the name whichever half wraps.
		const badge = badgeOf(group.path);
		if (badge)
			file.createSpan({ text: badge, cls: 'nav-row-badge' });
		// Which folder this note is in: 'smart' prints it only where its name is
		// another note's name too — the one case where the folder is not the same
		// answer for every row — and the two "always" modes print it everywhere. The
		// root prints "/" and not nothing: an empty span would leave the row's `/`-
		// placed note looking exactly like a note whose folder simply was not printed,
		// which is a different fact.
		const folder = group.path ? folderOf(group.path) : undefined;
		const printsPath = folder !== undefined && (mode !== 'smart' || doubles.has(name));
		if (printsPath)
			file.createSpan({ text: folder === '' ? '/' : `${folder}/`, cls: 'nav-row-path' });
		// HOW LONG AGO this note was last visited — where the reader asked for it. The
		// stamp is the newest one the group holds (see newestStamp), because a group's
		// landings are in line order rather than in time order and its anchor may have
		// been evicted. It is a cell of the ROW and not of the name: it stands in the
		// row's own second track, at the far end, where the same x on every row makes
		// the times the column a reader's eye can run down (see styles.css's is-timed).
		// Inside the name it had to be pushed with an automatic margin, which worked
		// only on a row whose folder the reader had not asked to print.
		if (this.opts.rowTime()) {
			const stamp = newestStamp(this.opts.entries, group.indices, group.anchor);
			if (stamp !== undefined) {
				const label = row.createSpan({ text: ageLabel(stamp, Date.now()), cls: 'nav-row-time' });
				// The row's shape follows the label that was built, so the two can never
				// disagree about whether the second track is there.
				row.addClass('is-timed');
				// The label is deliberately as short as the language can make it, and
				// two of its units are ambiguous in English ("m" could be minutes or
				// months): the moment itself is one hover away. It lives on the TIME
				// and not on the row, so hovering the time says when and hovering
				// anything else says which file (see the row's own tip).
				this.tip.attach(label, { text: new Date(stamp).toLocaleString() });
			}
		}
		// WHAT THE HOVER SAYS: only what the row does not already say. The path as it is
		// on disk, extension and all, for the reader who has to know which file of
		// several this is (see displayName / PathDisplayMode) —
		//
		//  - the full path, where the row prints NO folder. The row prints the name
		//    without its extension, so a row carrying a folder has already answered
		//    "which one is this": the extension alone is not worth a tooltip, and the
		//    setting that turns paths on is a reader asking to read them on the rows. This
		//    is what makes the panel quiet on hover exactly where it is loud on screen.
		//  - the file's OTHER names (see aliasesFor), which are searchable, take up no
		//    cell, and are therefore said NOWHERE else — so they keep their line whether
		//    or not the path does. A note with neither is a note that says nothing on
		//    hover at all.
		const aka = group.path ? this.opts.aliasesFor(group.path) : [];
		const tip: TipContent = {};
		if (group.path && !printsPath)
			tip.path = group.path;
		if (aka.length)
			tip.text = `${t('navHistory.aka')} ${aka.join(' · ')}`;
		if (tip.path || tip.text)
			this.tip.attach(row, tip);
		// NO "you are here" dot on the note's name: the current note is pinned first
		// (see groupByFile) and carries `is-current`, so the dot could only ever sit on
		// row one, saying what the row already says. It survives where it tells
		// something apart — on the LANDING that holds the current entry (a jump the
		// reader is standing on), whose note has other rows beside it (see placeRow).
		// A reader who is in the note but on no jump has no landing to mark, and the
		// row's own `is-current` is what says where they are.
		return 1;
	}

	// One PLACE of a note: the coordinate it landed on, the section it sits in, and
	// the pane holding it. Drawn only under 'all' (see shownLandings), where a note's
	// places are listed under its name — one row per distinct line, so the row is ONE
	// destination and nothing about it has to be explained away.
	private placeRow(i: number, current: boolean): number {
		const entry = this.opts.entries[i];
		const d = this.opts.describe(i);
		const row = this.opts.list.createDiv({ cls: 'position-restore-nav-row is-place' });
		if (current)
			row.addClass('is-current');
		row.dataset.rep = String(i);
		row.setAttr('id', `${this.opts.listId}-row-${i}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		// The row's own click is the one thing that acts through this: a landing row
		// stands for itself.
		const ref: RowRef = { el: row, rep: i };
		row.addEventListener('click', (ev) => this.onClick(ref, ev));
		row.addEventListener('pointerdown', (ev) => this.onPress(ref, ev));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);

		// The coordinate: the coarse "how far in" a reader matches against memory, and
		// — since a row is an OPEN — the line the click will actually land on. Those
		// two are the same number because the row stands for exactly one landing: a
		// row that folded the spots near it used to print the newest member's line
		// while covering a range, and the two only agreed by luck. A landing row says
		// nothing about the FILE: the other names belong to the note, and a spot is
		// placed by its coordinate and its section (see fileRow).
		//
		// …and the marker of "you are here" is written FIRST, in front of the number it
		// belongs to. It is hung off the box's own start rather than laid out inside it
		// (see styles.css), so the DOM order says what the eye sees — the dot, then the
		// coordinate it marks — while the box keeps holding the number alone and gives
		// up none of its width to a mark that only one row shows.
		const pos = row.createSpan({ cls: 'nav-row-pos' });
		if (current)
			pos.createSpan({ text: '●', cls: 'nav-row-here' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		else
			pos.createSpan({ text: '—', cls: 'nav-row-nopos' });

		// The section the landing sits in, deepest one or two levels: what a
		// reader recognizes a spot by, so it takes the row's slack. The cell is
		// created even when empty — later cells would slide a track left.
		const trail = rowTrail(this.opts.trailFor(entry, d));
		const crumb = row.createSpan({ cls: 'nav-row-trail' });
		for (let k = 0; k < trail.length; k++) {
			if (k > 0)
				crumb.createSpan({ text: '›', cls: 'nav-trail-sep' });
			crumb.createSpan({
				text: trail[k],
				cls: k === trail.length - 1 ? 'nav-trail-deep' : 'nav-trail-seg',
			});
		}

		// Which live tab holds this destination, when more than one does: two
		// tabs of one note are otherwise identical landings.
		const paneLabel = this.opts.paneName(entry);
		if (paneLabel)
			row.createSpan({ text: paneLabel, cls: 'nav-row-pane' });
		return 1;
	}

	// A right-click on a row — or a finger's lingering press, which a WebView reports
	// as the same event, carrying the left button's number — hands the row to the APP:
	// the browser raises the app's own file menu over it (see onContextRow), so what a
	// reader finds there is what Obsidian offers for that file anywhere else.
	//
	// It used to TRAVEL, as a shortcut for a hand already resting on the right button,
	// and the reason that was dropped has not changed: a second button that does the
	// first button's job is a gesture to learn for nothing, and on a tablet, where a
	// tap is easy to hold a beat too long, it turned an ordinary slow tap into a jump.
	// What a right-click does now is a DIFFERENT thing, and the slow tap is safe for
	// the same reason it is on Obsidian's own file list: the press raises a menu, and
	// the reader chooses from it.
	//
	// The event is still REFUSED as well as used, and that is the one thing that must
	// not change with the meaning: without preventDefault a long press also raises the
	// WebView's selection callout, and a menu with a text-selection callout over it is
	// worse than either alone.
	//
	// What the menu may do is not this list's business — the panel writes nothing
	// itself, and every action in there is one the reader asked the APP for (see
	// body.ts's contextRow: it asks for the LINK context, so no file-managing action
	// is among them).
	private onContextMenu(ev: MouseEvent, ref: RowRef): void {
		ev.preventDefault();
		const rep = this.activeRep(ref);
		if (rep >= 0)
			this.opts.onContextRow(rep, ev);
	}

	// Put the position away: the list back to the shape it opens in — nothing
	// pointed at.
	//
	// A shell that STAYS UP across a travel is the only caller (see view.ts): the jump
	// rewrites the stack and pins the note it landed on first, so the stack index the
	// position was resolved from — and the group it was on — may now name another note.
	// Starting the jump from a cleared list is what makes the redraw that follows it
	// nothing but the new list, rather than a position standing on whatever slid into
	// that slot.
	collapse(): void {
		this.clearSelection();
	}

	// The row's own click opens what it stands for (see activeRep) — the note's name is
	// its target. The same gesture on both kinds of row, because there is only one thing
	// a row can be asked: WHERE. A note's row answers with the note's own record (the
	// plain open), and a landing row with itself (a jump lands on its spot).
	//
	// The place the reader is already in is NOT exempt: the row opens it again (the file
	// back, or the landing re-applied), which is exactly what a reader whose tab was
	// closed came here for.
	//
	// WHERE the click opens is decided by the ELEMENT it landed on only while that
	// element is still part of the list. A row's index is this render's — the places
	// move under it on every visit — so a click whose element the last render threw
	// away would otherwise read an index that now names whatever slid into that slot,
	// and open the wrong note. That is not hypothetical: the reader's own click makes
	// the store re-order itself (see places.remember), and the jump the previous click
	// started settles a moment later, so a second click in quick succession can easily
	// arrive at a list that has been rebuilt under it.
	//
	// So a click on a rebuilt-away element is resolved by the place the reader PRESSED
	// (see onPress, and keyOf for why the identity can outlive the index). A click with
	// no press behind it — a programmatic `el.click()`, an assistive technology
	// activating the row — has no such claim, and a row whose element is gone is opened
	// by neither: opening NOTHING is the one failure this list can afford, and opening
	// the wrong note is the one it cannot.
	private onClick(ref: RowRef, ev: MouseEvent): void {
		// This row answers the click, whatever its answer turns out to be: nothing
		// further up is asked to answer it again (see onUnansweredClick).
		ev.preventDefault();
		// WHERE it opens is the app's call, not this module's: `Keymap.isModEvent` is
		// the documented answer for a user event (Cmd/Ctrl = a tab, +Alt = a split,
		// +Alt+Shift = a window, a middle-click = a tab), and it is the same function
		// Obsidian's own lists ask. Reading ctrlKey/metaKey here would be a second,
		// worse copy of that rule — one that gets the platform wrong.
		//
		// The app's `false` — "open it where it already is" — is normalised to no
		// target at all: they are the same request, and one of them says it in the
		// vocabulary this module's callers speak (see PaneTarget).
		const target = Keymap.isModEvent(ev) || undefined;
		const key = this.pressed;
		this.pressed = undefined;
		const rep = this.refs.includes(ref)
			? this.activeRep(ref)
			: key === undefined ? -1 : this.findByKey(key);
		if (rep >= 0)
			this.opts.onTravel(rep, target);
	}

	// The click the rows did NOT answer — the one the list itself is handed, because
	// the browser resolved the press and the release on the nearest ancestor still in
	// the document: the row the reader pressed was rebuilt away in between, so it is
	// no longer there to be the target. The reader is still asking for the row they
	// pressed, and the press is the record of which one it was, so it is answered by
	// identity — the same answer a stale element's own click gets (see onClick).
	//
	// It runs after the rows have had their say (a click bubbles from the row it
	// landed on, and a row marks its own answer, see onClick), and it is the ONLY
	// thing here that could double-answer a click — hence the check. A click with no
	// press behind it is not a row's click at all (the list's own background under
	// the last row) and goes nowhere, exactly as it did before anything listened
	// here.
	onUnansweredClick(ev: Event): void {
		if (ev.defaultPrevented)
			return;
		const key = this.pressed;
		this.pressed = undefined;
		if (key === undefined)
			return;
		const rep = this.findByKey(key);
		if (rep >= 0)
			this.opts.onTravel(rep, undefined);
	}

	// The reader pressed a row, with one button or another.
	//
	// THE PRIMARY BUTTON presses: remember WHICH place, so the click that follows can be
	// answered even if this list is rebuilt before it arrives (see onClick). The identity
	// is the place's own (see keyOf) and not the row's index, because the index is the
	// thing that is about to stop meaning this place. It is recorded here at all — rather
	// than read off the click — because the press and the release are two moments, and
	// the list can be rebuilt in the gap.
	//
	// THE MIDDLE BUTTON opens, and it does so HERE: a middle-click is delivered as
	// `auxclick`, not as `click`, so a handler waiting for the click would never run at
	// all — and holding it to a press/release pair buys nothing, since no one drags a
	// middle button off a row to cancel. Where it opens is still the app's answer rather
	// than this module's (see onClick), which for a middle-click is a new tab (documented
	// on Keymap.isModEvent). preventDefault on the press is what keeps the WebView's own
	// middle-click autoscroll out of the list.
	//
	// THE RIGHT BUTTON does neither: it raises the row's menu (see onContextMenu) and
	// never a click, so recording it would only leave a claim for the NEXT click to
	// inherit.
	private onPress(ref: RowRef, ev: MouseEvent): void {
		if (ev.button === 1) {
			ev.preventDefault();
			const rep = this.activeRep(ref);
			if (rep >= 0)
				this.opts.onTravel(rep, Keymap.isModEvent(ev) || undefined);
			return;
		}
		if (ev.button !== 0)
			return;
		const rep = this.activeRep(ref);
		this.pressed = rep < 0 ? undefined : this.opts.keyOf(rep);
	}

	// The row holding a place, found by identity rather than by index — or -1 when this
	// list no longer shows it (the filter dropped it, the file went, the cap trimmed it),
	// which leaves the click with nothing to open.
	//
	// A place the list somehow holds TWICE is refused for the same reason: identity is
	// what the store dedupes places BY (see places.remember), so two rows carrying one
	// key means the list cannot tell them apart, and picking one of them would be picking
	// at random.
	private findByKey(key: string): number {
		let found = -1;
		for (const ref of this.refs) {
			const rep = this.activeRep(ref);
			if (rep < 0 || this.opts.keyOf(rep) !== key)
				continue;
			if (found >= 0)
				return -1;
			found = rep;
		}
		return found;
	}

	// The stack index a row would open, or -1 when it has none (no row is pointed at,
	// or the group it belonged to is gone). What it must NOT refuse is the place the
	// reader is already standing in. That refusal used to read "a journey to where
	// they are is not a step", but a row is an OPEN and not a step: a reader clicking
	// the row they are on is asking for the FILE — the tab they just closed, or the
	// landing re-applied after a scroll — and jumpTo already answers exactly that
	// (the entry is not pushed again, it is re-landed; see NavHistory.jumpTo).
	// Refusing it here made the first row of the list — the current note, pinned
	// first — the one row that answered nothing, and it is the row a reader whose
	// every tab is closed reaches for first.
	//
	// Nothing about the FILE is asked here: a row only exists for a place the list
	// could open (see render's `keep`), so "may this be travelled to" is answered by
	// the row's existence.
	private targetOf(ref?: RowRef): number {
		const target = ref ?? this.selected;
		if (!target)
			return -1;
		return this.activeRep(target);
	}

	// Travel to the landing a row stands for. Public because Enter comes in through
	// the browser's key handler (see body.ts's onKeyDown) and has no row to name: the
	// row the cursor is on is this class's own answer, and so is whether it may be
	// travelled to. @returns whether a travel was started.
	travel(ref?: RowRef, target?: PaneTarget): boolean {
		const rep = this.targetOf(ref);
		if (rep < 0)
			return false;
		this.opts.onTravel(rep, target);
		return true;
	}

	// Point the list at a row: the ONE position (see `selected`), the highlight, and the
	// option a screen reader is told about. Its two callers both mean "the keyboard put
	// the reader here" — the walk (see move) and the re-find after a redraw — and
	// `walked` says whether the list has to SHOW the row it arrived on (see reveal),
	// which is the one thing a redraw does not need.
	private choose(ref: RowRef, walked = false): void {
		if (this.selected?.el !== ref.el) {
			this.selected?.el.removeClass('is-selected');
			this.selected?.el.setAttr('aria-selected', 'false');
		}
		this.selected = ref;
		ref.el.addClass('is-selected');
		ref.el.setAttr('aria-selected', 'true');
		// The list follows the position: a row the keyboard walked to may be off the
		// list, and the reader has to be able to see where they are (see reveal).
		this.reveal(ref.el, walked);
		this.opts.onActiveRow(ref.el.id);
	}

	// Put the row the position moved to where the reader can see it. Two callers, two
	// needs: a click has just put the position ON the row, and the least the list owes
	// it is being legible — no more, because the view belongs to the reader and a
	// click on a row must not shove it. The keyboard has walked to the row with the
	// reader's hand nowhere near the mouse, so there the list has to show the STEP
	// (see revealDelta).
	private reveal(el: HTMLElement, walked: boolean): void {
		const view = this.opts.list.getBoundingClientRect();
		// The browser's own minimal scroll answers both of the cases that are not the
		// walk's: a row a click landed on, and a list with no layout to measure (a
		// test, or a panel that has not been laid out yet). It moves nothing while the
		// row is in sight.
		if (!walked || view.height <= 0) {
			el.scrollIntoView({ block: 'nearest' });
			return;
		}
		const row = el.getBoundingClientRect();
		const delta = revealDelta(row.top, row.height, view.top, view.height);
		if (delta !== undefined)
			this.opts.list.scrollTop += delta;
	}

	private clearSelection(): void {
		this.selected?.el.removeClass('is-selected');
		this.selected?.el.setAttr('aria-selected', 'false');
		this.selected = undefined;
		this.opts.onActiveRow(undefined);
	}

	// The panel is going (see NavHistoryBrowser.destroy): the tooltip is the one thing
	// this class put OUTSIDE the panel's own element — it is drawn on the document, so
	// nothing that removes the panel removes it — and the events it listens for have to
	// come off with it.
	destroy(): void {
		this.tip.destroy();
	}

	// The keyboard's walk: one row on, wrapping at either end. A step is `walked`, so
	// the list shows the STEP and not merely the row (see reveal): it is the only move
	// the reader cannot see coming from the pointer, and the only one that would
	// otherwise leave a mark parked against the edge of the list while every further
	// step scrolled the notes under it. The rows it walks are the rows on screen,
	// whichever setting printed them (see refs).
	move(d: number): void {
		const n = this.refs.length;
		if (n === 0)
			return;
		const at = this.selected ? this.refs.indexOf(this.selected) : -1;
		if (at === -1) {
			this.choose(this.refs[d > 0 ? 0 : n - 1], true);
			return;
		}
		this.choose(this.refs[(at + d + n) % n], true);
	}
}
