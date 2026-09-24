import { Keymap, MenuPositionDef, setIcon } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { t } from '@/i18n';
import { groupByFile, LandingsMode, matchesNavFilter } from './listing';
import { PathDisplayMode } from '@/types';
import {
	NavEntryDescription, ageLabel, badgeOf, displayName, dropsOuterLevel, duplicateNames, folderOf,
	newestStamp, rowTrail,
} from './model';
import { NavRowTip, TipContent } from './tip';
import { LongPress } from './long-press';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from './constants';

// What a row is, for the one lookup that has to find it from a pointer event: the
// pointer is never over the row itself but over one of the boxes inside it (the name,
// the badge, the folder, the time, the ×), and the row is the element that speaks for
// all of them (see rowAt).
const ROW_CLASS = 'position-restore-nav-row';

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
// ONE TARGET, AND TWO THINGS A READER CAN DO WITH A ROW: a click opens it, and the ×
// at its far end drops it from the list (see fileRow's own note). The × is deliberately
// not laid out INSIDE the row. A row whose text gave up width to a control would move
// under the pointer that summoned it — the one thing this list may never do (see
// NOTHING MOVES ON HOVER below) — and a control standing in the row's own flow is a
// second thing the pointer can be aiming at on the one gesture a reader makes a
// thousand times. Laid out OF the flow, absolutely, over the row's far end, it costs
// the row nothing until it is asked for: nothing moves when it appears, and every pixel
// a reader can see the row on still opens the row.
//
// The removal belongs to the ROW and not to the file or the spot: what the list drew a
// row for is a note, or a view, and that is what goes — the store drops every record the
// row was drawn from (see onForget). One act, the same on a note and on the graph, which
// is exactly why it cannot live in the row's menu: that menu is the app's file menu, and
// only a file has one (see onContextMenu).
//
// NOTHING MOVES ON HOVER, which is the whole of the rule this list is built on: the
// pointer used to drive the position directly — a mouse crossing the list moved it and
// the panel beside it followed. A list that lurches under a passing mouse points at a
// row nobody chose, so the position moves only for a click or a key. The arrow travels,
// and the row's own click travels; no other button does (see onContextMenu).
//
// A hover still SAYS something, and saying is all it may do: the row under the pointer
// takes the app's own tint (see styles.css), which tells the reader which line a click
// would land on without moving the position off the row a key put them on. The tint is
// the stylesheet's and no listener in this class draws it, so what a pointer can change
// remains exactly what it was: nothing.
//
// …and a hover now also ASKS THE APP something (see RecentFilesListOptions.onHoverRow): which FILE the row under
// the pointer stands for, so the app's own page preview can open a popover over it. That
// is the app answering, on the app's own layer and by the app's own rules — and it is not
// this list moving: no row shifts, no order changes, no position is chosen, and a preview
// opened over a row leaves the row where it was, on its own side of the glass.
//
// …where a HOVER IS THE POINTER MOVING ONTO A ROW, and not merely being over one (see
// hoverAt). A row drawn UNDER a pointer that never moved — the dialog a hotkey
// opened with the mouse resting mid-screen, a list redrawn or scrolled under the hand —
// was not pointed at, and a page opened over it is a page nobody asked for: the app is
// asked for a note while the reader's hand is somewhere else entirely.
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

// A landing row's section chain, kept for the pass that reads the layout back (see
// fitTrails): the row, the OUTER level it may have to give up, and the chain the
// row answers with on hover once it has. Dropped with the rows on every render —
// the element it names is thrown away with them.
interface TrailRow {
	el: HTMLElement;
	// The outer level — the one that goes first, being the one a reader does not
	// match a spot against (see model.ts's rowTrail and dropsOuterLevel).
	outer: HTMLElement;
	chain: string[];
	// Whether the row already says something on hover of its OWN: a chain deeper
	// than the row prints carries its whole chain as a tooltip from the moment the
	// row is drawn (see placeRow), and the pass must write over that with nothing.
	tipped: boolean;
}

export interface RecentFilesListOptions {
	// The list element, created by the browser.
	list: HTMLElement;
	// The history the rows are drawn from, as one snapshot.
	entries: NavEntry[];
	// The stack index of the current entry: its note is pinned first, and — where the
	// setting prints a note's landings — the landing that holds it carries the "you are
	// here" marker (see placeRow).
	currentIndex: number;
	// The id the browser gave the list element. Row option ids are built from
	// it, so they are unique in the document even with a second browser open
	// (see RecentFilesModal.listId) — aria-activedescendant has to name exactly
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
	trailFor: (entry: NavEntry, d: NavEntryDescription) => string[];
	// The OTHER names the file goes by (see reads.ts's aliasesFor), which the query
	// matches on and the row's own tooltip prints (see tip.ts). They take up no cell on
	// the row, so the search box and the hover are the only two places they exist for a
	// reader — and a pathless view has none (the browser answers [] for it).
	aliasesFor: (path: string) => string[];
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
	// A row was right-clicked — or, on a phone, the menu control on its armed row was
	// tapped: WHICH place, and WHERE ON SCREEN the menu is to open, so the browser can
	// raise the app's own file menu over it (see body.ts's contextRow). The list does
	// not build the menu because it does not hold the app, and a row here is a row of
	// PLACES, not of files: which of them has a file behind it is the browser's
	// question (a pathless view has none). What the menu holds is not this list's
	// business either — it is the app's actions plus the panel's own, and the app
	// decides both — so the row is handed over, and nothing is drawn again here.
	// Nothing in this file writes.
	//
	// A POINT and not the event, because the two doors do not agree about one: a
	// right-click is answered where the pointer is, while a tap on the row's control is
	// answered where that control STANDS — a click the platform delivers for a finger
	// carries coordinates it is free to leave at zero, and a menu opened at the corner
	// of the screen is a menu the reader has to go and look for.
	onContextRow: (rep: number, at: MenuPositionDef) => void;
	// Whether a menu raised from a row is standing — and if one is, TAKE IT BACK (see
	// body.ts's takeMenuBack). The control that raised it is the one door the app cannot
	// close it from, because the control stops its own press so that reaching for it
	// does not open the note.
	takeMenuBack: () => boolean;
	// The pointer MOVED ONTO a row: which row, the event it moved with, and the row's
	// own element — handed over once, per row, per visit (see
	// RecentFilesList.hoverAt). Moved, and not merely arrived: a row the list
	// drew under a pointer that has not moved is not a row the reader pointed at.
	//
	// What happens with it is the app's own preview of the page the row stands for (see
	// RecentFilesBrowser.hoverRow), which is why it leaves this module rather than being
	// answered in it: this list draws rows over PLACES and holds no App of its own — the
	// one other thing that reaches outside them is a right-click's menu (see the comment
	// above) — and a preview is drawn by the whole app, over everything else on screen.
	//
	// Arriving is not RESTING, and neither is it choosing: nothing here waits, and
	// whether a preview opens at all is the app's decision, made by the same rules it
	// applies to a link in a note. The ROW INDEX is what travels, and it is this
	// render's own, which is enough for an answer drawn while the pointer sits still.
	// The row-stands-for-the-NOTE ITSELF rather than for a spot inside it (see fileRow):
	// a note's own row names the FILE, while a landing's row names a place in it. Handed
	// over with the move because what the row IS decides how it asks the app to open
	// it, and only the list drew the row (see activeRep for the same distinction, read
	// from the other direction).
	onHoverRow: (rep: number, ev: PointerEvent, el: HTMLElement, file: boolean) => void;
	// Whether the rows' hints should be SILENT right now, asked fresh at every hover
	// (see NavRowTip): the one thing that silences them — the NOTE ITSELF standing
	// open over the list, drawn by the app's own preview — is a thing this list
	// cannot see, so the answer is handed in by the browser (see PreviewSettle.isOpen).
	tipsQuiet?: () => boolean;
	// The pointer left the LIST — the same boundary that clears `hovered` (see the
	// constructor). The browser listens too: a hover session is over, and whatever
	// the app was asked during it can stand down (see PreviewSettle.hoverEnded).
	onHoverEnd?: () => void;
	// The reader took a row off the list, from the × the row carries: WHICH row, by
	// its identity — the group KEY, which is what a row is here (see
	// NavFileGroup.key, and nav/entry.ts's navGroupKey). This is the list's one way
	// of writing anything at all, and it writes nothing itself: the store is the
	// browser's, and so is the redraw (see body.ts's onForget).
	//
	// A row and not a place, because a row is the thing the × was drawn on and the
	// thing the reader pointed at. The two differ wherever a note holds several
	// spots: what goes is the NOTE, with every spot in it. A removal that took only
	// the spot under the pointer is not a gesture this list offers — there is no × on
	// a landing row at all (see fileRow).
	onForget: (key: string) => void;
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
	// Whether this device is a TOUCH one (see RecentFilesBrowserOptions.touch). Not a
	// preference and not a setting: it is the device's own, and what it decides here is
	// which of the two ways of pointing at a row exists at all — a pointer resting on
	// one, or a finger stopping on one (see arm). A desktop needs nothing from it: the
	// controls are already on the row its pointer is over.
	touch: boolean;
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

export class RecentFilesList {
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
	// The rows that print a section chain, with the level each may have to give up
	// once the layout has had its say (see fitTrails).
	private trails: TrailRow[] = [];
	// The list's own width, watched: a pane dragged narrower keeps its rows — nothing
	// re-renders on a drag — and whether a chain fits is a question about the width
	// the row has NOW. (Not a question a test can ask: jsdom implements no layout,
	// and no observer with it.)
	private watched?: ResizeObserver;
	// The row the pointer is ON, while it is on one, and the row it was last ANNOUNCED
	// for — the two are kept apart so that a pointer wandering inside a row says it once
	// rather than once per cell (see hoverAt). Undefined while the pointer is away
	// from the list, which is what makes coming back an arrival again.
	private hovered?: RowRef;
	// WHERE THE POINTER LAST WAS, in the list's own coordinates: the only thing that
	// tells a pointer that MOVED from a list that moved under it — an event at the same
	// place as the last one is the panel arriving, redrawing or scrolling under a hand
	// that has not moved, and no row was pointed at. Undefined until the panel has
	// seen the pointer once, since where it was before the panel existed was never
	// the panel's to know (see hoverAt).
	private pointerAt?: { x: number; y: number };
	// THE ROW A FINGER STOPPED ON (see arm), and the one piece of state a press leaves
	// behind. It is a ROW and not a MODE: one row, answered once, over the moment the
	// reader does anything else — so unlike a mode there is nothing to forget to leave,
	// and no second meaning for a tap to have while it stands.
	private armed?: RowRef;
	// Whether the press now landing on a row's menu control is one that TAKES A STANDING
	// MENU BACK rather than one that asks for a menu (see menuControl). Remembered
	// between the press and the click it delivers, because the two are halves of one
	// gesture and only the press knows which one it is.
	private menuTapCloses = false;
	// The gesture that arms it, heard only where there is no hover to arm it with (see
	// the `touch` option). A desktop has no use for one: a press that never rests costs
	// a timer and nothing else, and a mouse that rests is a hover, which the rows
	// already answer.
	private press?: LongPress;

	constructor(private opts: RecentFilesListOptions) {
		// Nothing is listened to here for the LIST's own sake: a pointer moves no
		// position at all (see the class comment) — the rows' own clicks are wired as
		// the rows are drawn. The tooltip is the one pointer reader, and it answers with
		// words rather than with a move.
		this.tip = new NavRowTip(opts.list, opts.tipsQuiet);
		if (typeof ResizeObserver === 'function') {
			this.watched = new ResizeObserver(() => this.fitTrails());
			this.watched.observe(opts.list);
		}
		// A FINGER THAT STOPPED ON A ROW is the only thing that arms one (see arm), and
		// it is heard only where a hover cannot do the job.
		if (opts.touch) {
			this.press = new LongPress(opts.list, {
				ms: LONG_PRESS_MS,
				slop: LONG_PRESS_SLOP_PX,
				onArm: target => this.armAt(target),
			});
			// …and a long press is over the moment the reader does anything else. A
			// CLICK anywhere on the list is the reader having moved on — to another row,
			// to one of the armed row's own controls (which stop the click before it can
			// get here, see fileRow), or to the list's own background — and a SCROLL
			// takes the rows out from under words that are standing still (see tip.ts on
			// the same rule). Both are heard on the list and not per row: what ends is
			// the press, and the press belongs to no row in particular.
			this.opts.list.addEventListener('click', () => this.disarm());
			this.opts.list.addEventListener('scroll', () => this.disarm(), { passive: true });
		}
		// THE POINTER COMING TO BE OVER A ROW is the only thing that asks the app for a
		// page (see hoverAt), and there are two events that say it: the move that carried
		// the hand there, and the ARRIVAL the browser reports when the pointer crosses
		// into a row. Both are heard, because a hand that flicks onto a row and stops
		// may deliver only one of them — and both are heard ON THE LIST rather than on
		// the rows: a row is rebuilt on every render, and what is being heard is the
		// pointer rather than whichever row it happens to be over.
		this.opts.list.addEventListener('pointermove', (ev) => this.hoverAt(ev));
		this.opts.list.addEventListener('pointerover', (ev) => this.hoverAt(ev));
		// The pointer LEAVING THE LIST is the one thing that makes the next arrival on the
		// same row an arrival again (see hoverAt). It is heard here rather than on the
		// rows because every row hears its own leaving, including the ones it is leaving
		// FOR each other — the list is the boundary that means "not on a row at all".
		this.opts.list.addEventListener('pointerleave', (ev) => {
			this.hovered = undefined;
			// …and the place the pointer was last seen goes with it: it is the one
			// place the panel still knows, and it is where the hand is when it comes
			// back.
			this.pointerAt = { x: ev.clientX, y: ev.clientY };
			this.opts.onHoverEnd?.();
		});
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
		// A LONG PRESS DOES NOT OUTLIVE A REDRAW: the row the finger stopped on is about
		// to be thrown away, and a × standing on the row drawn in its place would be a
		// control for a row nobody armed. The words go with it for the same reason (see
		// tip.reset below) — the two arrived together, and a half of a pair left behind
		// is the one kind of state a reader cannot read.
		this.disarm();
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
		this.trails = [];
		this.groups = [];
		this.selected = undefined;
		// …and the row the pointer was last announced for goes with them: the element it
		// names is being thrown away, and the row drawn in its place is a new arrival
		// whenever the pointer crosses it (see hoverAt). The pointer's own place is
		// NOT forgotten: a row drawn under a hand that has not moved is still not a row
		// that hand pointed at.
		this.hovered = undefined;

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
		// the moment before that prune lands. A VIEW place is exempt: a view has no
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
		// …and what the LAYOUT did to the rows just drawn, read back now that they
		// have a width to be measured against (see fitTrails).
		this.fitTrails();

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
		return query ? t('recentFiles.noMatch') : t('recentFiles.empty');
	}

	// The groups as they are drawn RIGHT NOW, by identity: what the browser pins
	// when the pointer arrives (see RecentFilesListOptions.order). It is asked of
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
	// graph, Thino's memo list) prints no folder and no type badge: it is one view, not a
	// note with spots in it, and it has no file on disk to have a type — its own ICON
	// takes that slot instead (see below).
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
		// …and the record the row was drawn from, where the row has one: whether it is a
		// VIEW decides two things below — which mark takes the badge's slot, and whether
		// the row carries a second act at all (see the controls at its far end).
		const repEntry = rep === undefined ? undefined : this.opts.entries[rep];
		const name = head?.name ?? displayName(group.path);
		const row = this.opts.list.createDiv({ cls: `${ROW_CLASS} is-file` });
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
		if (badge) {
			file.createSpan({ text: badge, cls: 'nav-row-badge' });
		} else {
			// A PATHLESS VIEW takes this slot (the two never both apply — a view has
			// no path, so it has no extension for badgeOf to report): a view is not a
			// note, and the row has to say so or the list reads as a list of notes
			// with a couple of odd names in it. The mark is the view's OWN icon, the
			// one its tab header showed (see shared/leaf.ts's viewIcon), so the reader
			// recognizes the row as the thing they clicked into. A view that named no
			// icon gets the WORD instead, and not a stand-in glyph: an icon id the
			// app's build does not know draws an empty slot, and an empty slot says
			// less than a word does (the same reasoning as the badge above).
			if (repEntry?.kind === 'view') {
				const label = t('recentFiles.viewBadge');
				if (repEntry.icon) {
					const mark = file.createSpan({ cls: 'nav-row-view-icon' });
					setIcon(mark, repEntry.icon);
					mark.setAttr('aria-label', label);
				} else {
					file.createSpan({ text: label, cls: 'nav-row-badge' });
				}
			}
		}
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
				// The label may still be abbreviated ("5m ago"), so the exact moment is
				// one hover away. It lives on the TIME and not on the row, so hovering
				// the time says when and hovering anything else says which file (see
				// the row's own tip).
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
			tip.text = `${t('recentFiles.aka')} ${aka.join(' · ')}`;
		if (tip.path || tip.text)
			this.tip.attach(row, tip);
		// THE ROW'S OWN REMOVAL: the × at the row's far end. It is HERE rather than in
		// the row's menu because that menu is the APP's and only a file has one — a
		// pathless view row (the graph, Thino's memo list) has no file for a file menu
		// to be about, so a removal offered there is a removal those rows never get.
		// Drawn on THIS row, both kinds get it from one line. (See
		// RecentFilesBrowser.onForget for what the click asks for.) What it shares the
		// row's far end with is the second act below, and only on a phone.
		//
		// It is not the second TARGET the class comment refuses — the × that put a
		// control a stray pixel from the row's own click. It is laid out OUT of the
		// flow, absolutely, over the row's far end (see styles.css): the row's click
		// still lands on the row over every pixel a reader can see a row on, and the
		// control arriving under the pointer moves nothing.
		//
		// …and both of them stand in ONE BOX, out of the flow and at the far end: two
		// boxes each placed of its own would have to be told apart by the width each
		// happens to take, and a row carrying only one of them would leave the other's
		// strip standing empty.
		//
		// Its own events are STOPPED rather than left to bubble, and that is the whole
		// of what keeps the two acts apart: with the press let through, reaching for the
		// × would record the row as pressed (see onPress) and the click would open the
		// note (see onClick) — a reader asking to drop a row would get the file.
		const actions = this.actionStrip(row);
		// "WHAT CAN BE DONE WITH THIS ROW", and only on a TOUCH device. A right-click
		// raises the app's menu on a desktop; here the long press that used to raise it
		// arms THIS row instead (see onContextMenu), so the menu is raised from the row
		// itself — by the second control the arm put on it (see menuControl). One
		// gesture there, two here, and the same answer out of both: the app's own
		// actions for the file, with this panel's one item on top of them.
		//
		// Only a row with a FILE behind it: a pathless view opens by a click like
		// anything else on the list, and its menu was never raised either (see
		// contextRow) — a second gesture for what two gestures already do.
		if (this.opts.touch && repEntry?.kind !== 'view')
			this.menuControl(actions, ref);
		const forget = actions.createDiv({ cls: 'nav-row-forget clickable-icon' });
		forget.setAttr('role', 'button');
		// Deliberately outside the tab order: this list's keyboard is the position and
		// the arrow keys (see move), with the focus never leaving the filter box, and a
		// button that could be tabbed to would be a second keyboard model standing in
		// the middle of that one.
		forget.setAttr('tabindex', '-1');
		forget.setAttr('aria-label', t('recentFiles.forget'));
		setIcon(forget, 'x');
		// A finger coming down here is a new gesture, and it spends the click the
		// press that put this control on the row may still have been holding for
		// (see long-press.ts's release) — a claim that outlived its own press would
		// swallow this tap, and the tap after it would land on a row that has been
		// disarmed under it.
		forget.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			this.press?.release();
		});
		forget.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// The click a long press delivers when the finger lifts can land on a
			// control the press itself put under that finger — the controls appear
			// where the reader is already touching. It is the press's own tail and not
			// a second gesture (see onClick), and the one it must not be is THIS one:
			// a reader who stopped on a row did not ask to drop it.
			if (this.press?.consumeClick())
				return;
			this.opts.onForget(group.key);
		});
		// NO "you are here" dot on the note's name: the row carries `is-current` for
		// that, and the list is in recency order whatever the reader is standing in (see
		// groupByFile), so a dot on the name would only repeat what the row already
		// says, wherever it happens to sit. The dot survives where it tells something
		// apart — on the LANDING that holds the current entry (a jump the reader is
		// standing on), whose note has other rows beside it (see placeRow). A reader who
		// is in the note but on no jump has no landing to mark, and the row's own
		// `is-current` is what says where they are.
		return 1;
	}

	// One PLACE of a note: the coordinate it landed on, and the section it sits in.
	// Drawn only under 'all' (see shownLandings), where a note's places are listed
	// under its name — one row per distinct line, so the row is ONE destination and
	// nothing about it has to be explained away.
	private placeRow(i: number, current: boolean): number {
		const entry = this.opts.entries[i];
		const d = this.opts.describe(i);
		const row = this.opts.list.createDiv({ cls: `${ROW_CLASS} is-place` });
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
		// created even when empty, so its track exists on every landing row.
		//
		// The row holds the deepest TWO levels (see rowTrail) because it has one line
		// of width; `chain` is the whole thing the note's headings answer for. The
		// outer levels are not thrown away — they are one hover away (see the tooltip
		// at the foot of this method).
		const chain = this.opts.trailFor(entry, d);
		const trail = rowTrail(chain);
		const crumb = row.createSpan({ cls: 'nav-row-trail' });
		let outer: HTMLElement | undefined;
		for (let k = 0; k < trail.length; k++) {
			const level = crumb.createSpan({
				text: trail[k],
				cls: k === trail.length - 1 ? 'nav-trail-deep' : 'nav-trail-seg',
			});
			// The separator RIDES WITH THE LEVEL IT FOLLOWS, as a child of that level
			// and not as a cell of its own standing between the two. A cell of its own
			// keeps its width after the level in front of it has been squeezed to
			// nothing, and a row that had already given up "呈现方案" went on printing a
			// "›" with nothing to its left — measured at ~15px of a 360px panel, spent
			// in front of the ONE level this row is for (see styles.css's collapse
			// order). Inside the level it belongs to, it goes when the level goes, and
			// the deepest level gets the width back.
			if (k < trail.length - 1) {
				level.createSpan({ text: '›', cls: 'nav-trail-sep' });
				outer = level;
			}
		}
		// WHAT THE HOVER SAYS: THE WHOLE CHAIN, outermost first, the way the note
		// runs — and only where the row is not already printing all of it. A landing
		// three sections deep prints "呈现方案 › 预览" and never says which chapter
		// that is, and the chapter is the first thing a reader looking for a place
		// asks about.
		//
		// It is deliberately NOT attached to a row that already prints its whole
		// chain: hover answers with what the row could not say (see fileRow), and a
		// tooltip repeating the two words on the row is a tooltip for nothing.
		// "Already prints" is the layout's answer as much as the chain's, though, and
		// a row is drawn before anything has been measured — so the pass that reads
		// the layout back gives the row this tooltip when it takes a level off it
		// (see fitTrails).
		if (chain.length > trail.length)
			this.tip.attach(row, { text: chain.join(' › ') });
		// …and the row joins the ones the fit pass will ask about, outer level and
		// all. A row that printed a single level has nothing to give up: the whole
		// chain is the level it prints.
		if (outer)
			this.trails.push({ el: row, outer, chain, tipped: chain.length > trail.length });
		// NO × ON A LANDING: what a row takes off this list is the note the spot belongs
		// to (see onForget), and a spot is not a thing this list drops on its own — a
		// removal that took only the line under the finger is not a gesture it offers.
		// What an armed landing row DOES carry is the same menu control a note's row
		// carries, for the same reason (see fileRow): the menu is the app's for the
		// FILE the spot belongs to, and this panel's own item on top of it opens the
		// place this row stands for — the spot, and not the note's newest one.
		if (this.opts.touch && entry.kind !== 'view')
			this.menuControl(this.actionStrip(row), ref);

		return 1;
	}

	// WHAT THE LAYOUT DID TO THE CHAINS, READ BACK ONCE THE ROWS ARE ON SCREEN.
	//
	// A row is drawn before anything has been measured, and a stylesheet can only
	// SQUEEZE the outer level of a chain (see .nav-trail-seg): what a squeezed level
	// leaves is a FRAGMENT — measured on the panel's own width, a row whose levels are
	// "新插件 Position Restore" and "2026-09-04" prints "新插件 Positi… 2026-09-04",
	// where the fragment names no section and the DATE is the whole of what the row is
	// saying. The deepest level does not pay for that fragment in width — it takes the
	// width its own text needs however narrow the row gets (see styles.css) — so what
	// the pass is deciding here is the row's READING: past half of its outer level, the
	// fragment is not worth the room it reads in, and the row prints its deepest level
	// alone (see dropsOuterLevel).
	//
	// The level that goes is not lost: it is one hover away. A row whose chain was
	// deeper than what it printed already says the whole chain there, and a row that
	// had only its two levels printed gets the words it let go of as its tooltip —
	// hover answers with what the row could not say (see placeRow), and the row
	// cannot say them now.
	private fitTrails(): void {
		const rows = this.trails;
		// A list with no layout — a test's DOM, or a panel that has not reached the
		// document — reports every width as 0, and every chain would go.
		if (!rows.length || !this.opts.list.clientWidth)
			return;
		// Measure with every level back on its row: a level the LAST pass took off has
		// no box to be measured in, and a pane dragged wider has to be able to have it
		// back. One write over all of them …
		for (const r of rows)
			r.el.removeClass('is-deep-only');
		// …then ONE read of all of them, before the first row is written back: a write
		// invalidates the layout every later read would have to wait for, and this
		// list has a row per note.
		const dropped = rows.map(r => dropsOuterLevel(r.outer.clientWidth, r.outer.scrollWidth));
		rows.forEach((r, i) => {
			if (!dropped[i]) {
				// The row prints its levels again, so the words it borrowed are the row's
				// own once more and hover has nothing left to add.
				if (!r.tipped)
					this.tip.detach(r.el);
				return;
			}
			r.el.addClass('is-deep-only');
			if (!r.tipped)
				this.tip.attach(r.el, { text: r.chain.join(' › ') });
		});
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
// What the menu may do is not this list's business, and this list still writes
// nothing itself: the row is handed over, and the browser asks the APP for the app's
// own menu and adds the one entry of its own (see body.ts's contextRow — the LINK
// context is what is asked for, so no file-managing action is among the app's). Taking
// the row off the list is NOT among them any more: that is the row's own ×, and it
// asks through onForget rather than through this. (Nor is it for a pathless view,
// which raises no menu at all — see contextRow.)
	private onContextMenu(ev: MouseEvent, ref: RowRef): void {
		ev.preventDefault();
		// ON A TOUCH DEVICE this event is the same gesture the clock is waiting for: a
		// WebView reports a long press as a `contextmenu` carrying the left button's
		// number (see the comment above), and which of the two arrives first is the
		// platform's business. So the row is armed here as well, and the arm is
		// idempotent — a press that comes in by both doors is one press, and the row
		// does not care which one got there first.
		if (this.opts.touch) {
			this.arm(ref, ev.target instanceof Node ? ev.target : ref.el);
			return;
		}
		const rep = this.activeRep(ref);
		if (rep >= 0)
			this.opts.onContextRow(rep, { x: ev.clientX, y: ev.clientY });
	}

	// A FINGER STOPPED ON A ROW, which on a device with no hover is what a hover is
	// (see long-press.ts): the row answers for itself. Two things come of it, and they
	// are the two things a hover gives a desktop — the words the row cannot print
	// (see tip.ts's speak), and the controls at its far end, which the stylesheet
	// keeps out of sight until a row is armed.
	//
	// ONE ROW AT A TIME, because that is what a finger can stop on: arming another row
	// answers the first one on the way. And it ends with the press rather than with the
	// finger (see disarm) — the reader lifts the finger to reach for what the arm put
	// on the row, so the lift is the beginning of the answer, not the end of it.
	private armAt(target: Node): void {
		const ref = this.rowAt(target);
		if (ref)
			this.arm(ref, target);
	}

	private arm(ref: RowRef, target: Node): void {
		if (this.armed && this.armed !== ref)
			this.disarm();
		this.armed = ref;
		ref.el.addClass('is-armed');
		// The click the finger may still deliver when it lifts belongs to this gesture
		// and not to the reader (see onClick).
		this.press?.markArmed();
		// …and the row says what it cannot print, asked of the element the finger came
		// down on rather than of the row as a whole: a finger resting on the TIME is
		// asking for the moment behind "5m", and one resting anywhere else is asking
		// which file this is. The same two answers a pointer gets (see tip.ts).
		this.tip.speak(target);
	}

	// The press is over: the reader tapped somewhere, scrolled, or the list was drawn
	// again under the finger. The words go with it (see tip.ts's retract) — an armed
	// row with nothing to say is a row the reader has to guess at.
	private disarm(): void {
		if (!this.armed)
			return;
		this.armed.el.removeClass('is-armed');
		this.armed = undefined;
		this.tip.retract();
	}

	// THE STRIP THE ROW'S CONTROLS STAND IN: out of the row's flow, at its far end
	// (see styles.css), and answerable for one thing beyond holding them — a press
	// that landed inside it but on NEITHER control was a MISS, and a miss travels
	// nowhere.
	//
	// The reason is the browser's own and not merely a matter of small targets: a
	// finger that comes down on one control and lifts over its NEIGHBOUR has clicked
	// neither, and what the browser clicks instead is their nearest common ancestor —
	// which is the ROW. So a reader who aimed at a control and slid off it was sent
	// to the note, and on a phone the drawer folds away behind them. The controls stop
	// their own clicks (see fileRow), so what lands here is what landed BESIDE them:
	// the gap between the two, on the device where there are two.
	//
	// A miss leaves the arm STANDING. The reader was reaching for the row's answer
	// when they missed it, and a row that took its controls away mid-reach is a row
	// that made them aim a second time.
	private actionStrip(host: HTMLElement): HTMLElement {
		const strip = host.createDiv({ cls: 'nav-row-actions' });
		strip.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// …and the click the press earned is spent here too, if it was this one:
			// the strip is where the controls APPEAR, so it is where a finger that
			// stopped on a row may already be resting when it lifts. Answered by
			// nobody, and left holding nothing — a claim that survived its press
			// would swallow the reader's next tap on a control (see the × in
			// fileRow, and long-press.ts's release).
			this.press?.consumeClick();
		});
		return strip;
	}

	// THE ROW'S SECOND ACT, as a control at its far end (see fileRow / placeRow): the
	// one of the two that is not on every row, and the one that only a touch device
	// draws. It RAISES THE APP'S MENU for the file behind the row — the same menu a
	// right-click raises on a desktop, and the same one the long press raised here
	// before the press became the row's own gesture (see onContextMenu) — with this
	// panel's one item on top of it: the place the row stands for, one tab over.
	//
	// NOT A SHORTCUT FOR THAT TRAVEL, which is what this control was at first. A
	// control that answered with a jump could only ever answer with that jump, while
	// what the row stands behind is a file the app already has a whole menu about —
	// open it beside, copy a link, reveal it, rename it, whatever the app's own
	// version of that menu holds — and a desktop, which has that menu on a right-click,
	// never had the shortcut either. One tap more buys every answer the shortcut could
	// not give, and the one it did give is the first item on the menu.
	//
	// ITS OWN EVENTS ARE STOPPED, for the reason the ×'s are: with the press let
	// through, reaching for it would record the row as pressed (see onPress) and the
	// click that followed would open the note in the Tab the reader is already in — a
	// menu asked for and a jump delivered.
	private menuControl(host: HTMLElement, ref: RowRef): void {
		const more = host.createDiv({ cls: 'nav-row-menu clickable-icon' });
		more.setAttr('role', 'button');
		// Outside the tab order, exactly as the × is: the keyboard's way through this
		// list is the position and the arrow keys, and a menu is a pointer's question.
		more.setAttr('tabindex', '-1');
		more.setAttr('aria-label', t('recentFiles.rowMenu'));
		// THE GLYPH THAT PROMISES A LIST, and the only one that does: `file-plus` reads
		// as a new file, which nothing here creates, and `external-link` promises a
		// place outside, which is one of the menu's items and not the menu. Three dots
		// promise neither — they promise that there are more answers than the row shows.
		setIcon(more, 'more-vertical');
		more.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			// The claim the press is still holding, spent by the finger arriving here
			// (see fileRow's ×, and long-press.ts's release): without this, a press
			// whose tail click never came swallows the reader's first tap on this
			// control, and the tap after it opens the note instead.
			this.press?.release();
			// A menu this control already raised: THIS press takes it back, and the click
			// it delivers must not put it straight back up (see below). Asked HERE and not
			// on the click because by the click the app's menu may be standing over this
			// very control — moved up by its own height when the row sat too low on the
			// screen — and a press that lands on the menu reaches nobody.
			this.menuTapCloses = this.opts.takeMenuBack();
		});
		more.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// The press's own tail, exactly as the × refuses it (see fileRow): the
			// controls arrive under the finger that earned them, so a lift can land on
			// this one.
			if (this.press?.consumeClick())
				return;
			// The press took a standing menu back: it was not asking for another one.
			if (this.menuTapCloses) {
				this.menuTapCloses = false;
				return;
			}
			const rep = this.activeRep(ref);
			// …and a row with nowhere to go raises no menu, exactly as a desktop's
			// right-click on one does not (see onContextMenu).
			if (rep < 0)
				return;
			// WHERE IT OPENS is the CONTROL'S OWN BOX and not the tap's: a click the
			// platform delivers for a finger carries coordinates it is free to leave at
			// zero, and a menu opened at the corner of the screen is a menu the reader
			// has to go and look for. The box is where their finger already is.
			const box = more.getBoundingClientRect();
			this.opts.onContextRow(rep, { x: box.left + box.width / 2, y: box.bottom });
			// THE ARM STAYS. A menu is a question and not an answer, and the row's own
			// answers — the ×, the words it cannot print — may still be the ones the
			// reader wants when the menu closes: a row that dropped them behind a menu
			// the reader dismissed is a row they have to arm again.
		});
	}

	// THE POINTER IS OVER A ROW: hand it to the app, ONCE (see
	// RecentFilesListOptions.onHoverRow). Heard from a MOVE and from an ARRIVAL alike
	// (see the constructor), because a hand that flicks onto a row and stops may deliver
	// only one of the two, and which one it is depends on where the hand came from.
	//
	// WHAT DECIDES IS WHETHER THE POINTER MOVED, and that difference is the whole of it.
	// `pointerover` means "the pointer is inside this element" — which the browser says
	// whenever an element COMES to be under a pointer, moved or not: the dialog a hotkey
	// opened with the mouse resting mid-screen draws its rows around that pointer, every
	// one of them reports an arrival, and the app is asked for a preview of a note nobody
	// pointed at — a page opened by a keystroke, over a row the reader has not looked at.
	// So is a list redrawn under the hand (the age labels ticking, a row taken off it)
	// and so is one scrolled under it. The move is read off the pointer's own place,
	// which every one of those events carries: an event at the same coordinates as the
	// last one is the panel moving under a hand that has not.
	//
	// THE FIRST EVENT A PANEL HEARS IS NOT A MOVE, since there is nowhere it could have
	// moved FROM: where the pointer was before the panel existed is not something the
	// panel was ever told, so the first event it sees is the panel arriving under the
	// pointer — the case above — and it is recorded rather than answered. Nothing is
	// lost by it: a reader who means to point at a row moves, and that move is answered
	// like any other.
	//
	// ONCE PER ROW, and not once per element: a row is a dozen boxes deep by the time it
	// is drawn, and the move that crosses the name after the one that crossed the badge
	// is the same hand on the same row — asking again would be asking for a page already
	// being previewed. Leaving the row for ANOTHER row is a different row (the subject
	// changes on its own); leaving the LIST and coming back is the case that needs the
	// help, and it is the list's own leave that forgets (see the constructor).
	//
	// WRITTEN ONCE AND LEFT ALONE from there: what comes of the arrival is the app's
	// business entirely — whether it waits, whether it answers, whether the answer means
	// anything at all — so there is nothing here to withdraw afterwards, no popover to
	// dismiss and no state to undo. Nothing about this list moves for it either: the
	// rows, the order and the position are exactly what they were before the pointer came.
	//
	// A FINGER DOES NOT HOVER, it presses, and on a phone there is neither the room nor
	// the gesture for a page to open beside the row the thumb is about to tap. The same
	// answer the list's own tooltip gives a touch (see tip.ts): a finger resting on a row
	// is not asking what is in it.
	private hoverAt(ev: PointerEvent): void {
		if (ev.pointerType === 'touch')
			return;
		// Where the pointer IS, and whether that is somewhere NEW.
		const at = { x: ev.clientX, y: ev.clientY };
		const moved = this.pointerAt !== undefined
			&& (this.pointerAt.x !== at.x || this.pointerAt.y !== at.y);
		this.pointerAt = at;
		if (!moved)
			return;
		const ref = this.rowAt(ev.target);
		if (!ref || ref === this.hovered)
			return;
		this.hovered = ref;
		const rep = this.activeRep(ref);
		// A row with nowhere to go has nothing to preview either — the algebra is
		// `activeRep`'s, which is the one place this class says which record a row acts on.
		// A file row's identity is the GROUP, a landing's is its own place index — which
		// of the two this arrival is decides how the app is asked to open it (see the
		// option above).
		if (rep >= 0)
			this.opts.onHoverRow(rep, ev, ref.el, ref.group !== undefined);
	}

	// The row the pointer is over, from whichever element the event names (see ROW_CLASS):
	// a row is what the app is asked about, and the pointer is over one of the boxes the
	// row is built out of. Undefined for a move over the list's own background — the gap
	// under the last row, the padding beside them — which is a move over no row at all.
	private rowAt(target: EventTarget | null): RowRef | undefined {
		const el = target instanceof HTMLElement
			? target.closest<HTMLElement>(`.${ROW_CLASS}`)
			: null;
		return el ? this.refs.find(r => r.el === el) : undefined;
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
		// …unless it is the TAIL OF A LONG PRESS. The finger that stopped on this row
		// delivers a click when it comes up, and the row under it was armed by that very
		// gesture (see arm): a reader who stopped on a row did not ask to go there, so
		// the click is consumed here — and kept from the list's own listener too, which
		// would take the arm off the row the reader is about to reach into.
		if (this.press?.consumeClick()) {
			this.pressed = undefined;
			ev.stopPropagation();
			return;
		}
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
	// (the entry is not pushed again, it is re-landed; see NavStack.travelTo).
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

	// The NOTE ITSELF is standing over the rows — the app answered the hover (see
	// RecentFilesBrowser.hoverRow): take the rows' hint off it. What the rows say on
	// hover is what the row could not print — the path the setting left off it, the
	// file's other names, the outer half of a section chain — and open over the row,
	// the note has said all three before it has finished drawing itself: its own
	// title, its own frontmatter, its own headings read like the outline. A hint
	// keeping its place beside a page that answered it is not answering anything.
	//
	// Nothing is REMEMBERED here: whether a hint may speak after this is asked fresh
	// at the next hover (see RecentFilesListOptions.tipsQuiet), so the rows get their
	// voice back the moment the preview is gone — not the next time the pointer
	// happens to cross some boundary.
	hideTip(): void {
		this.tip.retract();
	}

	// The panel is going (see RecentFilesBrowser.destroy): the tooltip is the one thing
	// this class put OUTSIDE the panel's own element — it is drawn on the document, so
	// nothing that removes the panel removes it — and the events it listens for have to
	// come off with it.
	destroy(): void {
		this.tip.destroy();
		// …and the finger is listened for no longer. The listeners are on the LIST
		// element, which outlives this object — a body is destroyed and rebuilt every
		// time the dialog opens — so a gesture left listening would keep arming rows
		// nobody can see, on a clock nobody is waiting for.
		this.press?.destroy();
		// The width is watched no longer: the list it was watching goes with the panel.
		this.watched?.disconnect();
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
