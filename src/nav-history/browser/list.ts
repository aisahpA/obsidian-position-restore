import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { groupByFile, matchesNavFilter } from './listing';
import { NavEntryDescription, baseName, duplicateNames, folderOf, rowTrail } from './model';

// The tree of notes, and everything that belongs to a row: which steps the query
// keeps, how they group into one row per note, what the keyboard walks, and the
// pointer's hover — which moves the same position the keyboard walks and does
// nothing else to the row (there is no per-cell meaning left in one).
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
// The row's two halves are the two clicks: a single click opens the note (or
// closes it again; on a landing there is nothing to open, so it only points), a
// double click travels — to a landing itself, or to the first landing of the
// note it was made on. The keyboard does the same walk without a pointer: ↑↓
// step through the rows on screen (a closed note's landings are not on screen),
// ←→ close and open the note under the cursor, Enter travels.
//
// The list owns its rows and the ONE position in them: `selected`, which the
// pointer moves by hovering and the keyboard by walking (see choose). It is what
// the landing panel describes, what Enter travels to, and what is announced to a
// screen reader — one position, so the two input devices cannot disagree about
// which row the reader is on. The browser follows it through callbacks — it never
// reaches into the rows.

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
	// Whether this device drives the list with a finger instead of a pointer.
	mobile: boolean;
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
	// The position moved on a touch device: bring the panel into view.
	onRevealPanel: () => void;
	// A row was chosen with a pointing device: travel there.
	onTravel: (rep: number) => void;
}

// How long two clicks on one row may be apart and still be a double click. A
// single click has already done its work by then (it opened the note, or pointed
// at the landing), so this only decides when the second click travels.
const DOUBLE_CLICK_MS = 300;

// How far the pointer has to travel before it counts as MOVED: a report from a
// pointer that has not moved is not the reader choosing a row, and the list itself is
// what puts those reports in play — it scrolls under a cursor resting on it, it
// rebuilds its rows on every keystroke, and pressing an arrow key can jolt a mouse or
// brush a trackpad by a pixel or two. A report the reader did not make would take the
// position back off the row the keyboard just walked to (the row under the pointer is
// not the row they are on any more), so the position only follows movement. Measured
// from the last report the list ACCEPTED, not from the last event, so a slow
// deliberate move still arrives — a pixel or two late.
const HOVER_SLOP = 4;

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
// The pointer's own moves do NOT come through here: arriving on a row owes it no
// more than being legible, and the view belongs to the reader (see reveal).
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
	// THE position: the row the reader is on, whichever hand put them there —
	// hovering a row moves it (see onHover), the arrow keys walk it (see move), a
	// tap sets it. Undefined before anything has been pointed at: Enter has nothing
	// to act on until then.
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
	// The last row clicked, by the identity a rebuild preserves (the row's group,
	// or its stack index), and when: two clicks on one row inside DOUBLE_CLICK_MS
	// are a travel, one click is the row's own single action. The element itself
	// would not do — the first click of a double click on a note rebuilds the
	// list, so the second click arrives on a fresh element for the same row.
	private lastClick?: string;
	private lastAt = 0;
	// Where the pointer last acted on the list, or undefined before it has moved at
	// all. See HOVER_SLOP: reports from a pointer that has not really moved are the
	// scroll and the jolt, not the reader.
	private hoverAt?: { x: number; y: number };

	constructor(private opts: NavHistoryListOptions) {
		// Pointer movement is the only hover signal — see onHover.
		this.opts.list.addEventListener('mousemove', (ev) => this.onHover(ev));
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

	// The row the position is on — where the landing panel opens under. A note row is
	// a row the panel can describe (the landing it stands for is what it shows), so
	// this is not always rowOf(position).
	currentRow(): HTMLElement | undefined {
		return this.selected?.el;
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

	// The stack index a row acts on: a landing is itself; a note is the FIRST
	// landing under it that is not the current entry — the top of the note in the
	// order the rows are drawn, which is what a reader pointing at a note's row
	// means (the rows under it run down the document, so its first row is its
	// beginning). Travelling back to where you already are is not a step, and a
	// deleted note still ANSWERS with one of its recorded landings, because the
	// panel is where "this file is gone, here is what stood there" is said.
	// Whether that landing may actually be travelled to is travel()'s question,
	// not this one.
	//
	// The one exception is the landing the reader last AIMED at in this note (see
	// `aimed`): that one wins, so closing a note and opening it again leaves the
	// subject where it was instead of snapping back to the first row — which is a
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
		return order.find(i => i !== this.opts.currentIndex) ?? order[0];
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
	// note (that is what activeRep above answers with), so a caret would open a
	// group of one and a count would say "1" to nobody's benefit. This is the one
	// question behind the caret, the count, the expansion and ←→.
	private expandable(group: number): boolean {
		return (this.groups[group]?.indices.length ?? 0) > 1;
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
			if (this.expandable(index) && this.expanded.has(index)) {
				for (const i of group.indices)
					this.placeRow(i, i === this.opts.currentIndex);
			}
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
	// where another note on screen shares the name, and the caret and the count
	// appear only where there is something to open and something to count: a note
	// with ONE landing is a leaf — the name, and the drawer describing that one
	// landing, with nothing in between (see expandable). A pathless view row (the
	// graph) prints neither folder nor count either: it is one view, not a note
	// with spots in it.
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
		// The spots in it the reader can go back to — the reason the row is worth
		// opening. It counts the RECORDED landings, reachable or not (a deleted
		// note still names its spots); ONE says nothing, so a leaf prints no
		// number.
		const many = !pathless && group.indices.length > 1;
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
		row.addEventListener('click', () => this.onClick({ el: row, rep, group: index }));
		row.addEventListener('contextmenu', (ev) => ev.preventDefault());
		this.refs.push({ el: row, rep, group: index });

		const open = many && this.expanded.has(index);
		// The caret's span is created for EVERY note, empty where there is nothing
		// to open: it is the row's first grid track, and leaving it out would slide
		// that note's name (and only that one's) a track to the left.
		row.createSpan({
			text: many ? '▸' : '',
			cls: `nav-file-caret${open ? ' is-open' : ''}`,
			// The tap semantics read this: a note row that is ALREADY open is not
			// a toggle-off target (see onTap), and the class is the one place that
			// state is written where a click can see it.
			attr: { 'aria-hidden': 'true', 'data-open': open ? 'true' : 'false' },
		});
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
		// How many landings open under this note — the spots in it the reader can
		// go back to, which is the reason the row is worth opening. ONE says
		// nothing: there is no choice to make, so the row is a leaf and a "1" is a
		// cell spent on a fact the list already shows.
		if (many)
			file.createSpan({ text: String(group.indices.length), cls: 'nav-row-count' });
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
		row.addEventListener('click', () => this.onClick({ el: row, rep: i }));
		row.addEventListener('contextmenu', (ev) => ev.preventDefault());
		this.refs.push({ el: row, rep: i });

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

	// A click on a row. The two devices want opposite things from it:
	//  - a pointing device has the second click, so one click is the row's soft
	//    action (open/close the note, or point at the landing) and two clicks
	//    travel;
	//  - a finger has no second click and no hover, so one tap must be able to
	//    say everything: a note opens, a landing is pointed at (and tapped again
	//    to put the panel away), and the panel's own button travels.
	private onClick(ref: RowRef): void {
		if (this.opts.mobile) {
			// A finger has no second click: one tap must be able to say everything
			// (see onTap), so the double-click bookkeeping is not even kept here —
			// two taps on one landing must mean open, close, open.
			this.onTap(ref);
			return;
		}
		const now = Date.now();
		// WHICH row the previous click landed on, by the identity the render
		// preserves: the element itself is replaced by every rebuild (the first
		// click of a double click on a note opens it, which renders).
		const at = ref.group !== undefined ? `g${ref.group}` : `r${ref.rep}`;
		const double = this.lastClick === at && now - this.lastAt <= DOUBLE_CLICK_MS;
		this.lastClick = at;
		this.lastAt = now;
		this.choose(ref);
		if (double)
			this.travelRow(ref);
		else if (ref.group !== undefined)
			this.toggle(ref.group);
	}

	// A touch device's tap: open a note, point at a landing, or put the panel away
	// again when the pointed-at LANDING is tapped a second time.
	// A note's row is not a toggle-off target: the tap that opens it also selects
	// it, and a second tap on it would read as "close the note I am reading" —
	// which is what the reader then has to undo. Closing a note is the ← key's
	// move (or a click on the note itself on a pointing device): a tap on another
	// note opens that note TOO and leaves this one open.
	// A note with ONE landing is the exception, because there is nothing to open:
	// the row stands in for that landing (see fileRow), so it takes the landing
	// row's gesture — and with it the only way back out of a preview on a device
	// with no Esc key under the finger.
	private onTap(ref: RowRef): void {
		if (ref.group !== undefined && !this.expandable(ref.group)) {
			this.tapLanding(ref);
			return;
		}
		if (ref.group !== undefined) {
			if (!ref.el.querySelector('.nav-file-caret')?.classList.contains('is-open'))
				this.toggle(ref.group);
			else
				this.choose(ref);
			return;
		}
		this.tapLanding(ref);
	}

	// A row that POINTS at a landing rather than opening one: the first tap puts the
	// position on it (the panel opens under it), a second takes the position away
	// again and the panel goes with it.
	private tapLanding(ref: RowRef): void {
		if (this.selected?.el === ref.el) {
			this.clearSelection();
			return;
		}
		this.choose(ref);
	}

	// Which row a travel acts on, and whether it may. A landing of a deleted note
	// has nothing to restore, so neither its row nor its note's row travels.
	// Public because Enter comes in through the browser's key handler
	// (NavHistoryModal.onKeyDown): the row the cursor is on is this class's
	// answer, and so is whether it may be travelled to. @returns whether a
	// travel was started.
	travel(ref?: RowRef): boolean {
		const target = ref ?? this.selected;
		if (!target)
			return false;
		const rep = this.activeRep(target);
		if (rep < 0 || this.opts.describe(rep).missing)
			return false;
		this.opts.onTravel(rep);
		return true;
	}

	// The internal travel the pointer's double click makes: the same decision,
	// without the public "started?" answer.
	private travelRow(ref: RowRef): void {
		this.travel(ref);
	}

	// What the keyboard is on.
	private active(): RowRef | undefined {
		return this.selected;
	}

	// Point the list at a row: the ONE position (see `selected`), the highlight, the
	// audible option, the drawer's subject — and, on touch, the panel that has to
	// follow it into view. Both hands come through here: the pointer's hover (see
	// onHover) and the arrow keys (see move) move the same row, so the two devices
	// cannot end up describing different spots. `walked` is the one thing the two
	// hands do not share: it says the KEYBOARD made this move, which is what decides
	// whether the list shows the step or merely the row (see reveal).
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
		// Enter and a double click travel to as well. Settled BEFORE the panel is told
		// to redraw.
		this.opts.onPointed();
		if (this.opts.mobile) {
			// The panel hangs BELOW that row, so redrawing it and then bringing it
			// into view are one step: the row alone being on screen is not enough,
			// because the button that travels with a finger lives in the panel.
			this.opts.onRevealPanel();
		}
	}

	// Put the row the position moved to where the reader can see it. Two callers, two
	// needs: the pointer has just arrived ON the row, and the least the list owes it is
	// being legible — no more, because the view belongs to the reader and a hand that
	// is only pointing must not shove it. The keyboard has walked to the row with the
	// reader's hand nowhere near the mouse, so there the list has to show the STEP
	// (see revealDelta).
	private reveal(el: HTMLElement, walked: boolean): void {
		const view = this.opts.list.getBoundingClientRect();
		// The browser's own minimal scroll answers both of the cases that are not the
		// walk's: a row the pointer arrived on, and a list with no layout to measure (a
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
		// on touch "no position" is what parks the panel (see LandingPanel.render).
		this.opts.onPointed();
	}

	// Open or close a note, and put the position on the note itself: the two are one
	// gesture (a click on a note row, or ←→), and the row that toggled is what the
	// reader is looking at. The note's row stands for the landing it stands for (the
	// one most recently aimed at, see activeRep), so closing a note does not move the
	// drawer to a different spot, and opening it does not either.
	// A note with one landing has nothing to open and this does nothing (see
	// expandable), which is what keeps it a leaf.
	private toggle(index: number): void {
		if (!this.expandable(index))
			return;
		const file = this.refs.find(r => r.group === index);
		if (this.expanded.has(index))
			this.expanded.delete(index);
		else
			this.expanded.add(index);
		// The note's own row is what stays on screen either way (a landing row is gone
		// after a close), and it is also where the reader's attention now is.
		if (file)
			this.choose(file);
		this.render();
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

	// Real pointer movement over the list, hit-tested to a row: the mouse moves the
	// SAME position the arrow keys walk (see choose), so the row under the pointer is
	// the row the drawer describes and Enter travels to — one position, whichever
	// hand moved it.
	// mouseenter is deliberately NOT used: rows are rebuilt on every keystroke, and a
	// browser synthesises mouseenter for whatever lands under a stationary pointer —
	// which would move the position onto a row nobody moved to. Only movement the
	// user actually made counts.
	// Movement off the rows (the list's own padding) moves nothing: the reader has
	// taken their hand off the list, not chosen a different row, and the drawer stays
	// on the spot they were reading (see LandingPanel.render).
	// A touch device has no hover at all, and there this listener must stay out of
	// the way: touch drives this panel with its own tap semantics (onTap).
	private onHover(ev: MouseEvent): void {
		if (this.opts.mobile)
			return;
		// A pointer report is not a pointer MOVE: see HOVER_SLOP.
		const at = this.hoverAt;
		if (at && Math.abs(ev.clientX - at.x) + Math.abs(ev.clientY - at.y) < HOVER_SLOP)
			return;
		this.hoverAt = { x: ev.clientX, y: ev.clientY };
		const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.position-restore-nav-row');
		if (!el || this.selected?.el === el)
			return;
		const ref = this.refs.find(r => r.el === el);
		if (ref)
			this.choose(ref);
	}
}
