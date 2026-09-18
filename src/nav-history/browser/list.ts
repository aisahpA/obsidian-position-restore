import { setIcon } from 'obsidian';
import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { groupByFile, LandingsMode, matchesNavFilter } from './listing';
import { NavEntryDescription, baseName, duplicateNames, folderOf, rowTrail } from './model';

// The tree of notes, and everything that belongs to a row: which steps the query
// keeps, how they group into one row per note, what the keyboard walks, and the
// ONE position a click moves — the same position the keyboard walks, and nothing
// else about the row (there is no per-cell meaning left in one).
//
// THE NOTE IS THE ROW. It used to be one row per step, with repeats of one
// landing collapsed into a ×N and the note's name printed once per run of its own
// rows — a flat chronology in which a note opened ten times was ten lines, and
// two notes sharing a name were two indistinguishable lines. The panel now says
// what a reader asks it: which note, and where in it. A note is one row, its
// DISTINCT landings open under it — by line, top of the note first (see
// groupByFile: inside one note the order it was visited in says nothing), and the
// same line reached twice is one spot, not two rows that read alike — and a name
// two notes share prints its folder to say which one it is. A note with ONE
// landing has no tree to open: it is a leaf, and the drawer describes that
// landing for the row itself (see expandable).
//
// The row's two halves are a single click and an arrow: a click opens the note
// (or closes it again; on a landing there is nothing to open, so it only points),
// and the ARROW in front of the row travels — to a landing itself, or to the
// first landing of the note it was made on. The arrow is not decoration: it
// replaced a double click, and a double click cannot be told from a single one
// until the second has either arrived or not — so the single click had to WAIT
// out the double-click window (every plain click in the panel answered 300ms
// late, which a reader feels as a dead list), and a click that did turn out to be
// a pair had already opened the note the travel was about to close again (the
// sublist flashing open and shut). One click, one target, one meaning — see `go`.
// The keyboard does the same walk without a pointer: ↑↓
// step through the rows on screen (a closed note's landings are not on screen),
// ←→ close and open the note under the cursor, Enter travels.
//
// ONE CLICK SAYS IT ALL, on every device and in every shell: clicking a note opens
// or closes its landings — and while it opens them it is also the NOTE the panel
// describes (see onClick) — clicking a landing (or a note with one, which is a leaf)
// points the panel at it, a second time putting it away again, and the arrow in
// front of a row travels.
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
	// there is nothing to travel to under it (which is exactly what opening it
	// says).
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
	// How many of a note's landings the list draws (see shownLandings): only the
	// newest one — the plugin's default — or every distinct spot. Read per render,
	// so a change in the settings tab reaches a panel that is already up.
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
	// The rows on screen, top to bottom: a note row followed by its landings
	// while it is open. The keyboard walks THIS, so a closed note's landings are
	// skipped without the walk having to know about the tree.
	private refs: RowRef[] = [];
	// The groups of the last render: what a file row's `group` indexes into.
	private groups: ReturnType<typeof groupByFile> = [];
	// THE position: the row the reader is on, whichever hand put them there — a
	// click sets it (see onClick), the arrow keys walk it (see move). Undefined
	// before anything has been pointed at: Enter has nothing to act on until then.
	private selected: RowRef | undefined;
	// The notes whose landings are on screen, by group index. Kept ACROSS renders:
	// the query redraws the tree, and a note that came back into the list comes
	// back where it was — a rebuild must not be a reopen.
	private expanded = new Set<number>();
	// The landing of a note the reader last AIMED at, by the note's path (a group
	// index is a position in a list the filter reorders; a path is the note). It is
	// what the note's own row stands for while its landings are not on screen (see
	// activeRep): the rows under a note run in LINE order, so "the first one" is not
	// the one the reader was reading, and closing a note must not silently move the
	// subject to a different spot.
	private aimed = new Map<string, number>();

	constructor(private opts: NavHistoryListOptions) {
		// Nothing is listened to here: a pointer moves no position at all (see the
		// class comment) — the rows' own clicks are wired as the rows are drawn.
	}

	// The stack index the position stands for, or -1 (no position): a landing is
	// itself, a note is the landing it stands for (see activeRep). Resolved from the
	// ROW now rather than remembered as a number from when the position arrived: what
	// a row stands for can move under a position that has not — the position walks the
	// landings of a note (see aimAt), the query redraws the tree, a note closes and
	// opens again. It is what the drawer describes and what Enter travels to: one
	// position, so the two cannot disagree.
	get position(): number {
		return this.selected ? this.activeRep(this.selected) : -1;
	}

	// The row an INLINE landing panel opens under (see LandingPanel.render), or
	// undefined when the position is on a note whose landings are already on screen:
	// there the panel is what would push those landings — and the note's own row, the
	// one the reader has to click again to close the note — off a narrow panel. A note
	// with ONE landing is a leaf that stands in for it (see expandable), so it keeps the
	// panel: nothing opens under it to be pushed away.
	//
	// It is the INLINE presentation's question and no other's: with the panel beside
	// the list (the drawer) the row is only the subject it describes, and nothing
	// hangs under it to be pushed.
	panelAnchor(): HTMLElement | undefined {
		const row = this.selected;
		if (!row)
			return undefined;
		if (row.group !== undefined && this.expandable(row.group) && this.expanded.has(row.group))
			return undefined;
		return row.el;
	}

	// Whether any row still STANDS FOR a landing: its own row, or — while its note
	// is closed — the note's row (see activeRep). The drawer asks this before
	// staying on a subject, so a query that dropped the note takes the column off it
	// rather than leaving it describing a row nobody can see.
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

	// The row a stack index resolves to, when that row is on screen (a landing of
	// a closed note is not, and neither is a row the filter dropped).
	rowOf(rep: number): HTMLElement | undefined {
		return rep < 0 ? undefined : this.refs.find(r => r.rep === rep)?.el;
	}

	// The NOTE row a row belongs to: the file row at or above it (which is the row
	// itself when it is one). The inline panel asks for it before moving the list: the
	// note's own name is how the tree is closed again with a click (see onClick), so opening
	// a panel may never scroll it out of the list — the scroll stops when it reaches the
	// top instead (see LandingPanel.reveal).
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

	// The stack index a row acts on: a landing is itself; a note is the newest of its
	// landings — WHERE I WAS IN THIS NOTE, which is what a reader pointing at a note
	// means, and what their back button keeps returning to (see
	// NavFileGroup.newest). It used to be the FIRST landing under the note, which the
	// line-ordered rows made look like "the beginning of the document": the row of a
	// note the reader had left at L800 travelled to L3.
	//
	// Travelling to where the reader already IS is not a step, so the landing they
	// are standing on is passed over — the note's row is right there, marked ●, and
	// the row's arrow would otherwise be a journey to itself. A note whose every
	// landing is "here" answers with the one it has. A deleted note still ANSWERS
	// with one of its recorded landings, because the panel is where "this file is
	// gone, here is what stood there" is said; whether it may actually be travelled
	// to is travel()'s question, not this one.
	//
	// The one exception is the landing the reader last AIMED at in this note (see
	// `aimed`): that one wins, so closing a note and opening it again leaves the
	// subject where it was instead of snapping back to the newest step — which is a
	// different spot whenever the rows are not in the order the reader went through
	// them.
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
		const elsewhere = order.filter(i => i !== this.opts.currentIndex);
		if (!elsewhere.length)
			return order[0] ?? -1;
		// The stack index IS the clock: entries are pushed in order, so the highest
		// index among a note's distinct landings is its newest step.
		return elsewhere.reduce((a, b) => (a > b ? a : b));
	}

	// Remember the landing the reader aimed at, keyed by its note (see `aimed`). A
	// FILE row aims at nothing of its own: it stands for whichever landing it is
	// already describing, and recording that would turn the default into a
	// permanent choice.
	private aimAt(ref: RowRef): void {
		if (ref.group !== undefined || ref.rep === undefined)
			return;
		const owner = this.ownerOf(ref);
		const path = owner === undefined ? undefined : this.groups[owner]?.path;
		if (path !== undefined)
			this.aimed.set(path, ref.rep);
	}

	// Whether a note has landings to OPEN: two or more. One landing is not a tree,
	// it is the note's own row — the drawer already describes that landing for the
	// note (that is what activeRep above answers with), so opening it would open a
	// group of one and a count would say "1" to nobody's benefit. This is the one
	// question behind the count, the expansion and ←→.
	private expandable(group: number): boolean {
		return (this.groups[group]?.indices.length ?? 0) > 1;
	}

	// WHICH of a note's landings are on screen. A note with ONE landing is a LEAF and
	// prints NONE: that landing is what the note's own row stands for (see activeRep),
	// and the drawer describes it for the row — a second row one line under the name,
	// saying the same thing, is the caret problem again in the form of a row (see
	// expandable). A note with several prints its NEWEST — the spot the reader left,
	// which is where their back button keeps returning to (see NavFileGroup.newest) —
	// plus, always, the landing they are STANDING ON: "you are here" is not something a
	// preference may hide. Clicking the note's own row shows the rest and hides them
	// again (see onClick), and the note's row says how many are hidden (see fileRow).
	//
	// The whole tree is what "all" asks for, and what the expansion opens. The default
	// is "last" because the reader's own navigation is by file: a note visited nine
	// times in one session has nine spots, of which the one that matters is the one
	// they left — a list that prints all nine pushes every other note off the panel to
	// say so.
	private shownLandings(group: ReturnType<typeof groupByFile>[number], index: number): number[] {
		// A LEAF prints none of them: see above.
		if (!this.expandable(index))
			return [];
		if (this.expanded.has(index) || this.opts.landings() === 'all')
			return group.indices;
		// The line order `indices` already carries is kept: the newest row is drawn
		// where its line puts it among the ones shown, not always on top.
		return group.indices.filter(i => i === group.newest || i === this.opts.currentIndex);
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
		// reader already is: a row it alone keeps alive is a row that can only
		// open onto "here", and the sentence below says that better than the dead
		// note does. So what decides whether the list is empty is the landings
		// that are NOT the current one.
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
				// The landing is gone (its note closed, or the filter dropped
				// it): the note it belonged to is what is left to stand on.
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
	private focusGroupOf(rep: number): void {		for (let g = 0; g < this.groups.length; g++) {
			if (this.groups[g].indices.includes(rep)) {
				const row = this.refs.find(r => r.group === g);
				if (row)
					this.choose(row);
				return;
			}
		}
	}

	// One NOTE. The name is its last path segment, the folder is printed only
	// where another note on screen shares the name, and the count appears only
	// where there is something to count: a note with ONE landing is a leaf — the
	// name, and the drawer describing that one landing, with nothing in between (see
	// expandable). A pathless view row (the graph) prints neither folder nor count
	// either: it is one view, not a note with spots in it.
	//
	// The row is its NAME and nothing else: the caret that used to lead it (and to
	// rotate when the note was open) is gone. A note that has landings to open says
	// so with the count, and an open note says so with the landings drawn under it —
	// while the caret spent a column of every row on the one piece of state the list
	// already shows twice.
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
		// How many of the note's spots are NOT on screen: the row's own affordance —
		// click it to see them, click it again to put them away (see onClick and
		// shownLandings). It is a "+N" and not the note's total because that is the
		// fact a reader needs about what they are looking at ("there are more"), and
		// a total that disagreed with the rows below it read as a miscount. Nothing
		// hidden, nothing printed: a note with one landing is a leaf, and a note whose
		// tree is open has already said what it holds.
		const hidden = pathless || !this.expandable(index)
			? 0
			: group.indices.length - this.shownLandings(group, index).length;
		const row = this.opts.list.createDiv({ cls: 'position-restore-nav-row is-file' });
		if (missing) {
			// The note is gone, and its row is still the note: it opens like any
			// other (the recorded landings say what stood there), it just has
			// nothing to travel to.
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
		// "You are here", on the note and (below) on the landing itself.
		if (group.current)
			file.createSpan({ text: '●', cls: 'nav-row-here' });
		// …and how many more of them there are, one click away.
		if (hidden > 0)
			file.createSpan({ text: `+${hidden}`, cls: 'nav-row-count' });
		return 1;
	}

	// One LANDING of a note: the coordinate, the section it sits in, and the pane
	// holding it. Only drawn while its note is open.
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
	// where the row stands for — the landing itself, or the top of the note the note's
	// row stands for (see activeRep).
	//
	// It is the affordance that replaced the double click, and the reason it had to.
	// A double click is a single click that has not been told yet whether it is one,
	// so the row's own action can only run after the double-click window has passed:
	// every plain click in the resident panel answered 300ms late, and a click that
	// did turn out to be a pair had already opened the note (or the landing panel)
	// that the travel's own collapse then took away again — a list that flashed open
	// and a click that felt dead, which is what the report of it said. An arrow is
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

	// Forget where the reader had things opened and aimed, and put the position away:
	// the tree back to the shape it opens in — every note closed, nothing pointed at.
	//
	// A shell that STAYS UP across a travel is the only caller (see view.ts): the jump
	// rewrites the stack and pins the note it landed on first, so the group index the
	// reader had opened no longer names the note they opened — redrawing from the old
	// set would re-open whatever slid into that slot, which is a panel describing a
	// note nobody chose. Starting the jump from a closed tree is what makes the redraw
	// that follows it nothing but the new list — and the tree comes back closed for
	// the reader too, which is where a travel leaves them anyway.
	collapse(): void {
		this.expanded.clear();
		this.aimed.clear();
		this.clearSelection();
	}

	// A CLICK on a row, and it goes NOWHERE: it does what the row's own soft action
	// is — open or close the note's landings, point at a landing, or put the panel
	// away again when the pointed-at row is clicked a second time. Travel is the
	// row's own arrow (see go) or, with a landing already positioned, Enter.
	//
	// A note's row is the TREE, and its click is the whole of what a click can do to
	// it: it opens the landings, or closes them again — with no second gesture this is
	// the only way back. It ALSO points at the note while it opens them, so the panel
	// describes the landing the note stands for (see activeRep): "show me this note"
	// is exactly what the click means, and a drawer left on the spot it happened to be
	// describing — another note's, or "where you are" — answers a question nobody
	// asked. What it must never do is open the panel UNDER the note's own row: a phone
	// reported that, with the landings pushed BELOW the content and the note's row,
	// the only thing left to click, off the top of the list. Nothing hangs there while
	// the tree is open, though (see panelAnchor), so the position alone is free.
	//
	// CLOSING points at nothing, and that is not symmetry for its own sake: inline the
	// panel would open under the very note the reader has just put away (see
	// panelAnchor). The drawer keeps describing the spot it was on instead (see
	// LandingPanel.render), which is the note they were working with.
	//
	// A note with ONE landing is the exception, because there is nothing to open: the
	// row stands in for that landing (see fileRow), so it takes the landing row's
	// gesture — and with it the only way back out of a preview in a panel with no Esc
	// key under the pointer.
	//
	// Either way the row that was clicked is where the reader is standing again, and the
	// list comes back to it if the panel had scrolled it away (see backTo).
	private onClick(ref: RowRef): void {
		if (ref.group !== undefined && this.expandable(ref.group)) {
			if (this.expanded.has(ref.group)) {
				// The tree closes: the position goes with it (see above), and the rows
				// are rebuilt by the close.
				this.clearSelection();
				this.toggle(ref.group, false, false);
			} else {
				// The tree opens, the note is pointed at, and the landings it just
				// opened are brought into sight: near the foot of the list they open
				// under the fold, where the click looks like it did nothing at all
				// (see showOpened).
				this.toggle(ref.group, true, true);
			}
			// The rows are rebuilt either way, so the row that was clicked is found
			// again by the identity it keeps across a rebuild: the note's group.
			this.backTo(this.refs.find(r => r.group === ref.group)?.el);
			return;
		}
		if (this.pointAt(ref))
			this.backTo(ref.el);
	}

	// A row that POINTS at a landing rather than opening one: the first click puts the
	// position on it (the panel opens under it), a second takes the position away
	// again and the panel goes with it. @returns whether it was that second click.
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
	// deleted note has nothing to restore, so neither its row nor its note's row is a
	// destination. Asked twice of every row — once when it is DRAWN (the arrow is
	// only drawn where it leads somewhere: see go) and once when it is clicked — so
	// that the arrow a reader can see is the arrow that works.
	private targetOf(ref?: RowRef): number {
		const target = ref ?? this.selected;
		if (!target)
			return -1;
		const rep = this.activeRep(target);
		return rep >= 0 && !this.opts.describe(rep).missing ? rep : -1;
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

	// What the keyboard is on.
	private active(): RowRef | undefined {
		return this.selected;
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
		// for that landing from now on (see aimAt), which is what keeps the drawer on
		// the same spot when the note is closed and opened again.
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

	// Open or close a note, and say what the gesture asks for besides the tree: `point`
	// puts the position on the note's own row, and `show` brings the landings it just
	// opened into sight. ←→ and the walk are one hand and want the first (the row that
	// toggled is what the reader is looking at); a click wants both (see onClick,
	// which is where the difference between opening and closing lives too).
	//
	// The note's row stands for the landing it stands for (the one most recently aimed
	// at, see activeRep), so closing a note does not move the drawer to a different
	// spot, and opening it does not either.
	//
	// A note with one landing has nothing to open and this does nothing (see
	// expandable), which is what keeps it a leaf.
	private toggle(index: number, point = true, show = false): void {
		if (!this.expandable(index))
			return;
		const file = this.refs.find(r => r.group === index);
		const opened = !this.expanded.has(index);
		if (opened)
			this.expanded.add(index);
		else
			this.expanded.delete(index);
		// The note's own row is what stays on screen either way (a landing row is gone
		// after a close), and it is also where the keyboard's walk left its attention.
		if (file && point)
			this.choose(file);
		this.render();
		// What a note that was just OPENED shows is the landings under it. They start
		// below the note, and a note near the foot of the list opens them under the
		// fold — where the tap looks like it did nothing at all (see showOpened).
		if (show && opened) {
			const note = this.refs.find(r => r.group === index)?.el;
			const first = this.firstPlaceOf(index);
			if (note && first)
				this.showOpened(note, first.el);
		}
	}

	// The first landing drawn under a note: the row directly below the note's own, and
	// the one a reader who has just opened it is looking for.
	private firstPlaceOf(group: number): RowRef | undefined {
		const at = this.refs.findIndex(r => r.group === group);
		return at < 0 ? undefined : this.refs.slice(at + 1).find(r => r.group === undefined);
	}

	// Bring a landing a click just opened into sight — by the LEAST the list can move, and
	// never so far that the note's own row leaves the top: that row is the only thing the
	// reader can click to close the note again, and a phone reported exactly that failure
	// ("the file got pushed up and hidden, and I had to scroll for a while to get back to
	// it"). Deliberately not scrollIntoView: that also scrolls any ANCESTOR that happens
	// to overflow — on a phone with a short history the dialog itself is one — so the
	// whole panel, list included, went up instead of the list alone.
	private showOpened(note: HTMLElement, first: HTMLElement): void {
		const view = this.opts.list.getBoundingClientRect();
		// No layout to measure (a test): nothing to move the list by.
		if (view.height <= 0)
			return;
		const below = first.getBoundingClientRect().bottom - view.bottom;
		if (below <= 0)
			return;
		// How far the list may move before the note's own row reaches the top.
		const room = note.getBoundingClientRect().top - view.top;
		this.opts.list.scrollTop += Math.min(below, Math.max(0, room));
	}

	// The keyboard's walk: one row on, wrapping at either end. A step is `walked`, so
	// the list shows the STEP and not merely the row (see reveal): it is the only move
	// the reader cannot see coming from the pointer, and the only one that would
	// otherwise leave a mark parked against the edge of the list while every further
	// step scrolled the notes under it.
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

	// The keyboard's own tree moves: ←→ close and open the note under the
	// cursor, which is the one thing a row's single click does that the arrows
	// cannot. On a landing, ← closes the note it is in. A note with one landing
	// has no tree of its own, so neither arrow is consumed and both keep their
	// ordinary meaning in the filter box (see NavHistoryModal.onKeyDown).
	// @returns whether the key was consumed.
	handleKey(ev: KeyboardEvent): boolean {
		const row = this.active();
		if (!row)
			return false;
		const group = row.group ?? this.ownerOf(row);
		if (group === undefined)
			return false;
		if (ev.key === 'ArrowRight') {
			if (this.expanded.has(group) || !this.expandable(group))
				return false;
			this.toggle(group);
			return true;
		}
		if (ev.key === 'ArrowLeft') {
			if (!this.expanded.has(group))
				return false;
			this.toggle(group);
			return true;
		}
		return false;
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
