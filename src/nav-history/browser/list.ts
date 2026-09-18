import { setIcon } from 'obsidian';
import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { groupByFile, LandingsMode, matchesNavFilter } from './listing';
import { NavEntryDescription, baseName, duplicateNames, folderOf, rowTrail } from './model';

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
// WHAT IS UNDER THE ROW IS THE SETTING, and only that (see LandingsMode). By
// default there is NOTHING under it: the list is one row per note — the reader's
// own navigation is by file, and the spot that matters is the one they left it at
// — the row STANDS FOR that spot (see activeRep), and a click points the panel at
// it. Every distinct spot a note was left at is one value away ('all'), which
// prints them under the name by line, top of the note first (see groupByFile:
// inside one note the order it was visited in says nothing); the same line
// reached twice is one spot, not two rows that read alike. A note with ONE
// landing prints none under it either way: a single spot is not a list, and the
// row already stands for it.
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
// The row's two halves are a single click and an arrow: a click points the panel
// at the landing the row stands for — a second click on the same row puts it away
// again — and the ARROW in front of the row travels there. The arrow is not
// decoration: it replaced a double click, and a double click cannot be told from a
// single one until the second has either arrived or not — so the single click had
// to WAIT out the double-click window (every plain click in the panel answered
// 300ms late, which a reader feels as a dead list), and a click that did turn out
// to be a pair had already pointed the panel at a row the travel's own clearing
// then took away again. One click, one target, one meaning — see `go`.
// The keyboard does the same walk without a pointer: ↑↓ step through the rows on
// screen, Enter travels. There is no ←→: nothing opens.
//
// ONE CLICK SAYS IT ALL, on every device and in every shell: a note's row and a
// landing row (where 'all' prints them) take the same gesture — point the panel
// here, or put it away again — and the arrow in front of a row travels.
//
// NOTHING MOVES ON HOVER, which is the whole of the rule this panel is built on: the
// pointer used to drive the position directly — a mouse crossing the list moved it
// and the column beside it followed, describing whatever it happened to pass over.
// A list that lurches under a passing mouse describes a row nobody chose and loses
// the spot the reader was actually reading, so every change of what is described is
// now a click they made. The arrow travels, and so does the RIGHT button of a
// mouse: one press, one journey, with no menu to confirm it in (see onContextMenu).
//
// The list owns its rows and the ONE position in them: `selected`, which a click
// sets and the keyboard walks (see choose). It is what the landing panel
// describes, what Enter travels to, and what is announced to a screen reader —
// one position, so the two input devices cannot disagree about which row the
// reader is on. The browser follows it through callbacks — it never reaches into
// the rows.

// One row as the class keeps it: the element, and what it stands for. A FILE
// row's landings are the steps, so a travel from it reads `group`; its `rep`,
// when it has one, is only the landing the row itself stands for (see fileRow).
interface RowRef {
	el: HTMLElement;
	// The stack index the row acts on. Undefined for a note row whose file is
	// gone: every recorded landing is unreachable, so the row names the note and
	// there is nothing to travel to (the panel still says what stood there).
	rep?: number;
	group?: number;
}

export interface NavHistoryListOptions {
	// The list element, created by the browser.
	list: HTMLElement;
	// The history the rows are drawn from, as one snapshot.
	entries: NavHistoryEntry[];
	// The stack index of the current entry: its note is pinned first, and its
	// landing carries the "you are here" marker.
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
	// Whether a note still exists. Asked of the NOTE rather than of one of its
	// landings: a note row is disabled when the note is gone, whatever its
	// recorded steps say.
	noteExists: (path: string) => boolean;
	// The heading chain an entry's landing sits in.
	trailFor: (entry: NavHistoryEntry, d: NavEntryDescription) => string[];
	// Which live tab holds a landing's destination, if it needs saying.
	paneName: (entry: NavHistoryEntry) => string | undefined;
	// The position moved: the landing panel redraws for the row it is on.
	onPointed: () => void;
	// The position moved to another row, or off the list (undefined), by either
	// hand. The focus never leaves the filter box — typing narrows the list from the
	// same keys that move through it — so this is what makes the current option
	// audible: the browser points the box's aria-activedescendant at the row id.
	onActiveRow: (id: string | undefined) => void;
	// A CLICK moved the position: bring the panel it just opened into view (see
	// choose). Not called for the keyboard's walk: there the list shows the
	// step and the reader's own view is what it is (see reveal).
	onRevealPanel: () => void;
	// A row was chosen with a pointing device: travel there.
	onTravel: (rep: number) => void;
	// How much of a note the list prints (see shownLandings): one row per note — the
	// plugin's default, the row standing for the last spot the note was left at — or
	// every distinct spot under the name. Read per render, so the toolbar's setting
	// reaches a panel that is already up.
	landings: () => LandingsMode;
	// Whether the hand at the panel is a FINGER: it is what decides the arrow's own
	// size (see TOUCH_ARROW_PX), while the click-only rule above is the same for
	// every hand.
	touch: boolean;
}

// HOW BIG THE ARROW'S GLYPH IS UNDER A FINGER, in pixels — and the reason the number
// is in the script at all rather than only in the stylesheet: an `em` is a TYPOGRAPHIC
// unit, it follows the reader's font, and a target must not. The panel's rows carry the
// same small UI font on a phone and on a tablet, and on the tablet — a bigger screen,
// held further away — the one control the hint tells a finger to hit came out "very
// small, like a dot". The stylesheet states the same size for the panels whose
// stylesheet is the one this build was written for (see styles.css); stating it here as
// well is what a panel gets whose two files arrived apart — Obsidian Sync copies them
// one at a time, and a tablet was caught running an older stylesheet in front of a
// newer script. An inline style is also the one declaration no theme rule can outrank.
const TOUCH_ARROW_PX = 20;

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
	// THE position: the row the reader is on, whichever hand put them there — a
	// click sets it (see onClick), the arrow keys walk it (see move). Undefined
	// before anything has been pointed at: Enter has nothing to act on until then.
	private selected: RowRef | undefined;
	// The landing of a note the reader last AIMED at, by the note's path (a group
	// index is a position in a list the filter reorders; a path is the note). It is
	// what the note's own row stands for (see activeRep) once a landing of that note
	// has been pointed at: the rows under a note run in LINE order, so "the first
	// one" is not the one the reader was reading, and the row must not silently mean
	// a different spot than the one they just chose.
	private aimed = new Map<string, number>();

	constructor(private opts: NavHistoryListOptions) {
		// Nothing is listened to here: a pointer moves no position at all (see the
		// class comment) — the rows' own clicks are wired as the rows are drawn.
	}

	// The stack index the position stands for, or -1 (no position): a landing is
	// itself, a note is the landing it stands for (see activeRep). Resolved from the
	// ROW now rather than remembered as a number from when the position arrived: what
	// a row stands for can move under a position that has not — the position walks the
	// landings of a note (see aimAt), the query redraws the list. It is what the
	// drawer describes and what Enter travels to: one position, so the two cannot
	// disagree.
	get position(): number {
		return this.selected ? this.activeRep(this.selected) : -1;
	}

	// The row an INLINE landing panel opens under (see LandingPanel.render), or
	// undefined when the landings of that note are already printed under it: there the
	// panel is what would push them — and the name they belong to — off a narrow
	// panel, and the reader who wants one of them has a row of their own to click. A
	// note the setting keeps to one row has nothing under it to push, so the panel
	// opens under the row like any other.
	//
	// It is the INLINE presentation's question and no other's: with the panel beside
	// the list (the drawer) the row is only the subject it describes, and nothing
	// hangs under it to be pushed.
	panelAnchor(): HTMLElement | undefined {
		const row = this.selected;
		if (!row)
			return undefined;
		if (row.group !== undefined && this.printsLandings(row.group))
			return undefined;
		return row.el;
	}

	// Whether any row still STANDS FOR a landing: its own row, or the note's row
	// (see activeRep). The drawer asks this before staying on a subject, so a query
	// that dropped the note takes the column off it rather than leaving it describing
	// a row nobody can see.
	standsFor(rep: number): boolean {
		return rep >= 0 && this.refs.some(r => r.group !== undefined
			&& this.groups[r.group]?.indices.includes(rep));
	}

	// Mark the row the drawer is describing: the row on the left and the column on
	// the right are one thing seen twice, and the name of the note was the only line
	// tying them together — a reader had to read it in both places to be sure. One row
	// at a time; -1 (nothing described) clears it. Called by the panel, which is what
	// resolves the position/"last"/"here" order (see LandingPanel.render), and it
	// agrees with `is-selected` whenever there is a position — the two classes are
	// painted the same (see styles.css).
	markPreviewed(rep: number): void {
		for (const ref of this.refs)
			ref.el.removeClass('is-previewed');
		if (rep < 0)
			return;
		// The ROW the drawer is describing, when it has one on screen: a landing's own
		// row once its note is open, so the tint sits on the spot the column shows and
		// the note's row goes back to being just the note.
		const own = this.rowOf(rep);
		if (own) {
			own.addClass('is-previewed');
			return;
		}
		// A closed note (or a landing a query dropped) has no such row: the FILE row
		// stands in for it, which is what still pairs the two sides up.
		this.refs.find(r => r.group !== undefined && this.groups[r.group]?.indices.includes(rep))
			?.el.addClass('is-previewed');
	}

	// The row a stack index resolves to, when that row is on screen (a landing the
	// setting does not print is not, and neither is a row the filter dropped).
	rowOf(rep: number): HTMLElement | undefined {
		return rep < 0 ? undefined : this.refs.find(r => r.rep === rep)?.el;
	}

	// The NOTE row a row belongs to: the file row at or above it (which is the row
	// itself when it is one). The inline panel asks for it before moving the list: that
	// row is the handle the panel is put away with (a second click on it, see onClick),
	// so opening a panel may never scroll it out of the list — the scroll stops when it
	// reaches the top instead (see LandingPanel.reveal).
	noteRowOf(row: HTMLElement): HTMLElement | undefined {
		const at = this.refs.findIndex(r => r.el === row);
		if (at < 0)
			return undefined;
		for (let i = at; i >= 0; i--) {
			if (this.refs[i].group !== undefined)
				return this.refs[i].el;
		}
		return undefined;
	}

	// The stack index a row acts on: a landing is itself; a note is the NEWEST of its
	// landings — THE LAST SPOT THE READER WAS AT IN IT, which is what a reader pointing
	// at a note means, and what their back button keeps returning to. It used to be the
	// FIRST landing under the note, which the line-ordered rows made look like "the
	// beginning of the document": the row of a note the reader had left at L800
	// travelled to L3.
	//
	// The newest is the newest, whether or not the reader is standing on it. The row
	// used to skip "here" and answer with the newest of the OTHER spots, so that its
	// arrow was never a journey to itself — but that made the row of the note you are
	// reading stand for a spot you were not sent to, and clicking the note's own row
	// described some older place in it. Reading a row as "where I am" is right: the row
	// is marked ●, the panel opens saying the same thing, and a row that stands where
	// the reader already is simply has nowhere to travel (see targetOf).
	//
	// A deleted note still ANSWERS with one of its recorded landings, because the panel
	// is where "this file is gone, here is what stood there" is said; whether it may
	// actually be travelled to is travel()'s question, not this one.
	//
	// The one exception is the landing the reader last AIMED at in this note (see
	// `aimed`): that one wins, so a row points at the spot the reader chose rather
	// than at the newest step — which is a different spot whenever the rows are not
	// in the order the reader went through them.
	private activeRep(row: RowRef): number {
		if (row.group === undefined)
			return row.rep ?? -1;
		const group = this.groups[row.group];
		if (!group || !group.indices.length)
			return -1;
		const remembered = this.aimed.get(group.path);
		if (remembered !== undefined && group.indices.includes(remembered))
			return remembered;
		const order = group.reachable.length ? group.reachable : group.indices;
		// The stack index IS the clock: entries are pushed in order, so the highest
		// index among a note's distinct landings is its newest step.
		return order.reduce((a, b) => (a > b ? a : b));
	}

	// Remember the landing the reader aimed at, keyed by its note (see `aimed`). A
	// NOTE row aims at nothing of its own: it stands for whichever landing it is
	// already describing, and recording that would turn that landing into a
	// permanent choice the reader never made.
	private aimAt(ref: RowRef): void {
		if (ref.group !== undefined || ref.rep === undefined)
			return;
		const owner = this.ownerOf(ref);
		const path = owner === undefined ? undefined : this.groups[owner]?.path;
		if (path !== undefined)
			this.aimed.set(path, ref.rep);
	}

	// Whether this note's landings are printed under its own row right now — the
	// setting's 'all', and a note that HAS more than one spot to print. One landing is
	// not a list: it is what the note's own row stands for (see activeRep), so a
	// second row one line under the name, saying the same thing, would be a row of
	// chrome for nothing. This is the one question behind what is printed AND where an
	// inline panel may open (see panelAnchor).
	private printsLandings(group: number): boolean {
		return this.opts.landings() === 'all' && (this.groups[group]?.indices.length ?? 0) > 1;
	}

	// WHICH of a note's landings are on screen: none by default — the list is one row
	// per note (see LandingsMode) — and under 'all', every distinct spot, in the line
	// order `indices` already carries (top of the note first, never with the newest
	// pulled to the top).
	private shownLandings(group: ReturnType<typeof groupByFile>[number], index: number): number[] {
		return this.printsLandings(index) ? group.indices : [];
	}

	// (Re)draw the rows; the toolbar and the panel persist around them.
	render(): void {
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
		// predicate takes it as an argument (see matchesNavFilter). Built only
		// while a query is up: an unfiltered list never asks the heading cache
		// for anything.
		const printed = (i: number): string => {
			const d = this.opts.describe(i);
			return `${d.line ?? ''} ${this.opts.trailFor(this.opts.entries[i], d).join(' ')}`;
		};
		const keep = (i: number) => !query || matchesNavFilter(this.opts.entries[i], query, printed(i));
		this.groups = groupByFile(
			this.opts.entries,
			this.opts.currentIndex,
			keep,
			i => !this.opts.describe(i).missing,
			// The line a row PRINTS is what makes two steps one spot, so the
			// collapse and the coordinates can never disagree (see groupByFile).
			i => this.opts.describe(i).lineIndex,
		);
		// The names two notes on screen share: those rows are the only ones that
		// print their folder (see folderOf). Measured over the rows ON SCREEN, so
		// a collision the filter dropped costs nobody a folder.
		const doubles = duplicateNames(this.groups.map(g => g.path));

		// A note row is drawn for every group, but the CURRENT entry is where the
		// reader already is: a row it alone keeps alive is a row with nowhere to go
		// from, and the sentence below says that better than the dead note does. So
		// what decides whether the list is empty is the landings that are NOT the
		// current one.
		let elsewhere = 0;
		for (const group of this.groups)
			elsewhere += group.indices.filter(i => i !== this.opts.currentIndex).length;
		this.groups.forEach((group, index) => {
			this.fileRow(group, index, doubles);
			for (const i of this.shownLandings(group, index))
				this.placeRow(i, i === this.opts.currentIndex);
		});

		// Nothing to draw: the query found no step to list. The current entry is
		// never a row of its own (see groupByFile), so a history of one step — or
		// one whose every other landing is "here" — lands here by design, and the
		// message says which of the two nothings it was (see emptyText).
		if (elsewhere === 0)
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
	// query found nothing, or there is no step to go to at all — a history with
	// nothing in it, or one whose only landing is the one being stood on.
	// One message for both, decided by the query; render's single
	// `elsewhere === 0` branch is the only caller.
	private emptyText(query: string): string {
		return query ? t('navHistory.noMatch') : t('navHistory.empty');
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

	// One NOTE. The name is its last path segment, and the folder is printed only
	// where another note on screen shares the name. A pathless view row (the graph)
	// prints no folder either: it is one view, not a note with spots in it.
	//
	// The row is its NAME and nothing else. The caret that used to lead it (and to
	// rotate when the note was open) and the "+N" that said how many spots a click
	// would open both went with the expansion (see the class comment): what the row
	// prints is what it IS, and the spots it stands for are the setting's business.
	private fileRow(group: ReturnType<typeof groupByFile>[number], index: number, doubles: Set<string>): number {
		const rep = group.reachable.find(i => i !== this.opts.currentIndex) ?? group.reachable[0];
		// A note whose file is gone is still the note the reader is standing in:
		// it is drawn from the note itself — its path — rather than from a landing
		// it no longer has.
		const head = rep === undefined ? undefined : this.opts.describe(rep);
		const view = rep !== undefined && this.opts.entries[rep].kind === 'view';
		const pathless = group.path === '' && (rep === undefined || view);
		const missing = !pathless && !this.opts.noteExists(group.path);
		const name = head?.name ?? baseName(group.path);
		const row = this.opts.list.createDiv({ cls: 'position-restore-nav-row is-file' });
		if (missing) {
			// The note is gone, and its row is still the note: it points the panel at
			// the recorded landings like any other (they say what stood there), it just
			// has nothing to travel to.
			row.addClass('is-missing');
			row.setAttr('title', t('navHistory.disabledTip'));
		}
		if (group.current)
			row.addClass('is-current');
		row.dataset.group = String(index);
		row.setAttr('id', `${this.opts.listId}-row-g${index}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		if (missing || rep === undefined)
			row.setAttr('aria-disabled', 'true');
		// One ref object, because three things act through it: the row's own click,
		// the right-click, and the travel arrow — and they have to agree about
		// which landing they are about.
		const ref: RowRef = { el: row, rep, group: index };
		row.addEventListener('click', () => this.onClick(ref));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);
		// The travel arrow, in the row's own left gutter — out of the row's flow, so
		// it cannot change how tall the row is (see go).
		this.go(row, ref);

		const file = row.createDiv({ cls: 'nav-row-file' });
		if (missing)
			file.addClass('is-missing');
		// Which folder this note is in — ONLY where its name is another note's
		// name too, and BEFORE the name.
		const folder = doubles.has(name) ? folderOf(group.path) : undefined;
		if (folder !== undefined)
			file.createSpan({ text: folder === '' ? '/' : `${folder}/`, cls: 'nav-row-folder' });
		file.createSpan({ text: name, cls: 'nav-row-name' });
		// "You are here", on the note and — where 'all' prints them — on the landing
		// itself.
		if (group.current)
			file.createSpan({ text: '●', cls: 'nav-row-here' });
		return 1;
	}

	// One LANDING of a note: the coordinate, the section it sits in, and the pane
	// holding it. Drawn only under 'all' (see shownLandings), where a note's spots are
	// listed under its name.
	private placeRow(i: number, current: boolean): number {
		const entry = this.opts.entries[i];
		const d = this.opts.describe(i);
		const row = this.opts.list.createDiv({ cls: 'position-restore-nav-row is-place' });
		if (d.missing) {
			// Rendered (the gap in the history is information) but never a jump
			// target: jumping moves the stack pointer while nothing can be
			// restored.
			row.addClass('is-missing');
			row.setAttr('title', t('navHistory.disabledTip'));
		}
		if (current)
			row.addClass('is-current');
		row.dataset.rep = String(i);
		row.setAttr('id', `${this.opts.listId}-row-${i}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		if (d.missing)
			row.setAttr('aria-disabled', 'true');
		// The same three-way ref as a note's row (see fileRow): the click, the
		// right-click and the arrow are one landing.
		const ref: RowRef = { el: row, rep: i };
		row.addEventListener('click', () => this.onClick(ref));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);
		this.go(row, ref);

		// The coordinate: the coarse "how far in" a reader matches against
		// memory, and the one thing every landing has.
		const pos = row.createSpan({ cls: 'nav-row-pos' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		else
			pos.createSpan({ text: '—', cls: 'nav-row-nopos' });
		if (current)
			pos.createSpan({ text: '●', cls: 'nav-row-here' });

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

	// The arrow that travels, in the row's own left padding: ONE click, and it goes
	// where the row stands for — the landing itself, or the spot a note's own row
	// stands for (see activeRep).
	//
	// It is the affordance that replaced the double click, and the reason it had to.
	// A double click is a single click that has not been told yet whether it is one,
	// so the row's own action can only run after the double-click window has passed:
	// every plain click in the resident panel answered 300ms late, and a click that
	// did turn out to be a pair had already pointed the panel at the row that the
	// travel's own clearing then took away again — a list that flashed open and a
	// click that felt dead, which is what the report of it said. An arrow is
	// unambiguous: it means "go there", it is visible before anything is clicked, it
	// works with a mouse and a finger alike, and the row's own click keeps meaning
	// exactly what it always meant.
	//
	// It is OUT of the row's flow — the stylesheet pins it to the row's own left
	// gutter and to the row's full height — because an element in the row is an
	// element that can make the row taller: a button carries the browser's own font
	// and line box, which is a size the row knows nothing about (see styles.css).
	// Out of flow it cannot touch the row's height at all, and a row that cannot
	// travel simply has no arrow rather than an empty cell.
	private go(row: HTMLElement, ref: RowRef): void {
		if (this.targetOf(ref) < 0)
			return;
		const go = row.createEl('button', {
			cls: 'nav-row-go',
			type: 'button',
			attr: {
				// A pointer shortcut, not a second tab stop: the panel's keyboard is the
				// filter box, and Enter travels to the very same place (see body.ts's
				// onKeyDown).
				tabindex: '-1',
				// …and it is not announced either, for the same reason. The row IS an
				// option of the listbox, and an option's name is read off its contents:
				// a labelled button in every row would put "jump here" into every
				// announcement, while telling a screen-reader user nothing they cannot
				// already do — Enter on the row travels. (Which is also why the press
				// below has to be refused: an element that can take the focus is an
				// element the browser refuses to hide, and says so in the console —
				// "Blocked aria-hidden on an element because its descendant retained
				// focus".)
				'aria-hidden': 'true',
				// The visible promise of what a click does, for the hand holding the mouse.
				title: t('navHistory.jumpHere'),
			},
		});
		setIcon(go, 'corner-up-right');
		// …and its size, where the hand is a finger's (see TOUCH_ARROW_PX): set on the
		// glyph itself, so neither a theme rule nor a stylesheet that arrived a version
		// behind can shrink it back to a speck.
		if (this.opts.touch) {
			const svg = go.querySelector('svg');
			if (svg) {
				svg.style.width = `${TOUCH_ARROW_PX}px`;
				svg.style.height = `${TOUCH_ARROW_PX}px`;
			}
		}
		// …and NO PADDING OF ITS OWN, said here as well as in the stylesheet, because this
		// is the one property the app's own button rules keep taking: a TABLET pads every
		// button it has — `.is-tablet button:not(.clickable-icon)` gives it `4px 20px`, two
		// classes and a type, so it outranks a two-class rule — and 40px of padding inside
		// this 30px box (see styles.css for the gutter) is a content box of nothing: the
		// glyph was squeezed away entirely and a tablet showed an EMPTY gutter, while the
		// phone and the desktop drew the arrow. The stylesheet answers with a three-class
		// selector; this is the answer that nothing short of `!important` can outrank, and
		// the box IS the row's left padding, so there is nothing here for a padding to do.
		go.setCssStyles({ padding: '0' });
		// The press must not move the FOCUS. A button takes it on mousedown, and the
		// panel's keyboard lives in the filter box: a click that moved the caret would
		// leave the reader typing at nothing, and the row the arrow was on would stop
		// being the row the arrows walk. Refusing the press is what keeps the caret
		// where it was, and the click itself still arrives.
		go.addEventListener('mousedown', (ev) => ev.preventDefault());
		// The row's own click is right behind this one and means something else (open
		// the note): the arrow's click is the arrow's — unless the press was on the
		// WORDS, in which case the row's own click is what it meant (see onWords).
		go.addEventListener('click', (ev) => {
			if (this.onWords(go, ev))
				return;
			ev.stopPropagation();
			this.travel(ref);
		});
	}

	// Whether a press landed on the row's WORDS rather than in the arrow's gutter.
	//
	// In the panel this build styles, the boxes already answer it: the arrow's is the
	// gutter and stops a gap short of the text (see styles.css). But the two files a
	// panel runs on do not have to arrive together, and a tablet was left running them
	// apart — an older stylesheet, in which the arrow's box was as wide as the whole
	// left padding, put its edge ON the first letters of every name, and so every tap
	// on a file name travelled: "tapping the file name jumps too". So the handler asks
	// the reader's own question — was that press on the words? — of the TEXT's box,
	// which is where the words are whatever the stylesheet drew. A press on them falls
	// through to the row's own click, which is what a name means in either mode.
	//
	// The question needs a laid-out panel to be asked of: with no box for the words
	// (a test, or a panel not measured yet) the hit test that delivered the event is
	// the only answer there is, and it is the right one wherever the stylesheet and
	// this script agree.
	private onWords(go: HTMLElement, ev: MouseEvent): boolean {
		const text = go.nextElementSibling as HTMLElement | null;
		if (!text)
			return false;
		const box = text.getBoundingClientRect();
		if (!box.width)
			return false;
		return ev.clientX >= box.left && ev.clientX <= box.right;
	}

	// A right-click on a row: the arrow's own journey, without the arrow. It is the
	// way to travel that does not depend on hitting a glyph inside a strip, and the
	// one a hand already resting on the mouse reaches for while the other hand is on
	// the keyboard.
	//
	// It used to open a menu holding one item ("jump here") that had to be picked,
	// which is a confirmation dialog for a gesture that was already a decision: a
	// right-click on a row says "go there" as plainly as a left-click on the arrow
	// does, and the menu only put a second click between the reader and the move.
	// So it travels AT ONCE — the same one-press contract as the arrow, and the
	// same refusal: a row with nothing to travel to (a deleted note) does nothing
	// at all, and keeps its tooltip to say why. The browser's own menu is suppressed
	// either way: this list has a meaning for the gesture, and none of the app's
	// (copy a row, inspect it) belongs on a row.
	//
	// ONLY THE RIGHT BUTTON MEANS THAT, which is not a detail about mice: a finger
	// has no right button at all, yet a WebView still raises this event for it — a
	// press that lingers for a moment becomes a `contextmenu` carrying the LEFT
	// button's number, and a journey taken on it turned an ordinary slow tap into a
	// jump. On a tablet, where a tap is easier to hold a beat too long, that was the
	// report: "tapping the file name jumps too". The press is still refused (a long
	// press on a row has no text selection or callout to offer either); it simply
	// goes nowhere.
	private onContextMenu(ev: MouseEvent, ref: RowRef): void {
		ev.preventDefault();
		if (ev.button !== 2)
			return;
		this.travel(ref);
	}

	// Forget the landing the reader had aimed at, and put the position away: the list
	// back to the shape it opens in — nothing pointed at.
	//
	// A shell that STAYS UP across a travel is the only caller (see view.ts): the jump
	// rewrites the stack and pins the note it landed on first, so the stack index behind
	// the aimed-at landing — and the group the position was on — may now name another
	// note. Starting the jump from a cleared list is what makes the redraw that follows
	// it nothing but the new list, rather than a panel describing a note nobody chose.
	collapse(): void {
		this.aimed.clear();
		this.clearSelection();
	}

	// A CLICK on a row, and it goes NOWHERE: it points the panel at the landing the row
	// stands for (see activeRep), and a second click on the same row puts the panel away
	// again. Travel is the row's own arrow (see go) or, with a row already positioned,
	// Enter.
	//
	// The same gesture on both kinds of row, because there is only one thing a row can
	// be asked: WHICH SPOT. A note's row answers with the landing it stands for — the
	// one the reader last aimed at in that note, or the newest — so "show me this note"
	// describes the spot their back button keeps returning to, rather than a drawer left
	// on whatever it happened to be describing. A landing row answers with itself. (The
	// note's row used to OPEN its landings instead, which made one click mean "open" or
	// "point" depending on how many spots the note happened to have; the setting prints
	// them, so nothing needs opening — see the class comment.)
	//
	// CLOSING points at nothing, and that is not symmetry for its own sake: inline the
	// panel would otherwise be left open under the very row the reader has just put away
	// (see panelAnchor). The drawer keeps describing the spot it was on instead (see
	// LandingPanel.render), which is the note they were working with.
	//
	// Either way the row that was clicked is where the reader is standing again, and the
	// list comes back to it if the panel had scrolled it away (see backTo).
	private onClick(ref: RowRef): void {
		if (this.pointAt(ref))
			this.backTo(ref.el);
	}

	// A row that POINTS the panel at a spot: the first click puts the position on it
	// (the panel opens under it), a second takes the position away again and the panel
	// goes with it. @returns whether it was that second click.
	private pointAt(ref: RowRef): boolean {
		if (this.selected?.el === ref.el) {
			this.clearSelection();
			return true;
		}
		this.choose(ref);
		return false;
	}

	// Bring the row a click just put the panel away from back into the list.
	//
	// Inline the panel hangs in the list's own scroll, and a row the reader has scrolled
	// past is pinned to the top of the list so that this very click is possible (see
	// LandingPanel.sync). The panel going away leaves the list where the panel's content
	// was — the middle of a note that is no longer on screen — so the handle that was just
	// used comes back to where it was clicked: nothing moves unless the row is above the
	// list, and then it moves exactly as far as the row.
	private backTo(row?: HTMLElement): void {
		if (!row)
			return;
		const view = this.opts.list.getBoundingClientRect();
		// No layout to measure (a test): nothing has moved.
		if (view.height <= 0)
			return;
		const delta = row.getBoundingClientRect().top - view.top;
		if (delta < 0)
			this.opts.list.scrollTop += delta;
	}

	// The stack index a row would travel to, or -1 when it has none: a landing of a
	// deleted note has nothing to restore, and neither has the spot the reader is
	// ALREADY standing on — a journey to where they are is not a step (see activeRep),
	// and an arrow on such a row would promise a move the click cannot make, in the
	// dialog a click that closed the picker for nothing. Asked twice of every row —
	// once when it is DRAWN (the arrow is only drawn where it leads somewhere: see go)
	// and once when it is clicked — so that the arrow a reader can see is the arrow
	// that works.
	private targetOf(ref?: RowRef): number {
		const target = ref ?? this.selected;
		if (!target)
			return -1;
		const rep = this.activeRep(target);
		if (rep < 0 || rep === this.opts.currentIndex)
			return -1;
		return this.opts.describe(rep).missing ? -1 : rep;
	}

	// Travel to the landing a row stands for. Public because Enter comes in through
	// the browser's key handler (see body.ts's onKeyDown) and has no row to name: the
	// row the cursor is on is this class's own answer, and so is whether it may be
	// travelled to. @returns whether a travel was started.
	travel(ref?: RowRef): boolean {
		const rep = this.targetOf(ref);
		if (rep < 0)
			return false;
		this.opts.onTravel(rep);
		return true;
	}

	// Point the list at a row: the ONE position (see `selected`), the highlight, the
	// audible option, the drawer's subject — and the panel that has to follow it into
	// view. Both hands come through here: a click (see onClick) and the arrow keys
	// (see move) move the same row, so the two devices cannot end up describing
	// different spots. `walked` is the one thing the two hands do not share: it says
	// the KEYBOARD made this move, which is what decides whether the list shows the
	// step or merely the row (see reveal).
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
		// Aiming at a landing is a choice about its note too: the note's row stands
		// for that landing from now on (see aimAt), which is what keeps the row — and
		// the panel with it — on the spot the reader chose.
		this.aimAt(ref);
		// The panel describes the landing this row stands for (see activeRep) — what
		// Enter and the row's own arrow travel to as well. Settled BEFORE the panel is
		// to redraw.
		this.opts.onPointed();
		if (!walked) {
			// The panel hangs BELOW that row, so redrawing it and then bringing it
			// into view are one step: the row alone being on screen is not enough when
			// what the click opened — the panel — is below it.
			// Only a CLICK asks for this: the keyboard's walk has just shown the step
			// its own way (see reveal), and following it with the panel's scroll would
			// undo it.
			this.opts.onRevealPanel();
		}
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
		// Nothing is described any more either: the drawer follows the position, and
		// "no position" is what parks the inline panel (see LandingPanel.render).
		this.opts.onPointed();
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

	// Which note a landing row belongs to: the note row above it in the walk.
	private ownerOf(row: RowRef): number | undefined {
		const at = this.refs.indexOf(row);
		for (let i = at - 1; i >= 0; i--) {
			if (this.refs[i].group !== undefined)
				return this.refs[i].group;
		}
		return undefined;
	}
}
