import { Keymap, MenuPositionDef, setIcon } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { placeKey } from '@/recent-files/places';
import { PaneTarget } from '@/nav/pane';
import { t } from '@/i18n';
import { groupByFile, LandingsMode, matchesNavFilter, matchedContextLine } from './listing';
import { PathDisplayMode } from '@/types';
import {
	NavEntryDescription, ageLabel, badgeOf, displayName, dropsOuterLevel, duplicateNames, folderOf,
	landingText, newestStamp, rowTrail,
} from './model';
import { NavRowTip, TipContent } from './tip';
import { LongPress } from './long-press';
import {
	LONG_PRESS_MS,
	LONG_PRESS_SLOP_PX,
	ROW_PRESS_HOLD_MAX_MS,
	ROW_PRESS_MARK_MS,
} from './constants';

// What a row is, for the one lookup that finds it from a pointer event: the
// pointer is over one of the boxes inside the row, and the row is the element
// that speaks for all of them (see rowAt).
const ROW_CLASS = 'position-restore-nav-row';

// The list of notes: which steps the query keeps, how they group into one row
// per note, what the keyboard walks, and the ONE position a click moves.
//
// THE NOTE IS THE ROW. A note's own record carries no position, so its row opens
// the file the PLAIN way — exactly as Obsidian's file explorer does — and the
// position database decides where the reader lands. That keeps the two entry
// points to one file from behaving differently, and it is why a file row never
// prints a line (that is a jump's business, see placeRow).
//
// WHAT IS UNDER THE ROW IS THE SETTING (see LandingsMode): nothing by default;
// 'all' prints every distinct line under the name, top of the note first. A note
// with ONE place prints none either way — a single place is not a list.
//
// THE ROW IS ONE THING: a click opens what it stands for. The × at its far end
// drops the row from the list; it is laid out OUT of the flow, absolutely, so
// nothing moves when it appears and every pixel of the row still opens it. The
// removal belongs to the ROW — the store drops every record the row was drawn
// from (see onForget) — which is why it cannot live in the row's menu: that menu
// is the app's file menu, and only a file has one (see onContextMenu).
//
// NOTHING MOVES ON HOVER: the position moves only for a click or a key. A hover
// may SAY things (the app's tint, this list's tip, the app's page preview) but
// never moves anything. A HOVER IS THE POINTER MOVING ONTO A ROW, not merely
// being over one: a row drawn under a pointer that never moved was not pointed
// at (see hoverAt).
//
// NOTHING MOVES WHILE IT IS BEING READ either: a click re-orders the places it
// came from (kept by last visit), so the list can be handed the order it is
// currently showing and told to hold it (see the `order` option).
//
// The list owns one POSITION, `selected`: the keyboard walks it (see move), a
// redraw re-finds it, Enter travels to it. A CLICK does not set it — the modal
// closes on the way.

// One row as the class keeps it: the element, and what it stands for. A FILE
// row's identity is the group (a travel from it reads `group`; see activeRep);
// its `rep` stays empty. A landing row's `rep` is its own place index.
interface RowRef {
	el: HTMLElement;
	rep?: number;
	group?: number;
}

// A landing row's section chain, kept for the pass that reads the layout back
// (see fitTrails). `quotes`/`note` are carried rather than recomputed because
// the fit pass REWRITES this row's tooltip, and one written from the chain
// alone would take the recorded words away with the dropped level.
interface TrailRow {
	el: HTMLElement;
	// The outer level — the one that goes first (see rowTrail / dropsOuterLevel).
	outer: HTMLElement;
	chain: string[];
	quotes: string[];
	note?: string;
}

export interface RecentFilesListOptions {
	// The list element, created by the browser.
	list: HTMLElement;
	// The history the rows are drawn from, as one snapshot.
	entries: NavEntry[];
	// The stack index of the current entry: its note is pinned first, and the
	// landing holding it carries the "you are here" marker (see placeRow).
	currentIndex: number;
	// Row option ids are built from it, so they stay unique with a second
	// browser open (see RecentFilesModal.listId).
	listId: string;
	// The search box's current text.
	filter: () => string;
	// One entry's display pieces (cached by the browser).
	describe: (rep: number) => NavEntryDescription;
	// Drop the per-render describe cache: the rows it described are gone.
	clearDescribeCache: () => void;
	// Whether a note still exists on disk. It is how a place is FILTERED, not
	// how a row is disabled: a name whose file is gone is not listed at all.
	noteExists: (path: string) => boolean;
	// The heading chain an entry's landing sits in.
	trailFor: (entry: NavEntry, d: NavEntryDescription) => string[];
	// The file's OTHER names: searchable, printed on the row's tooltip, and
	// nowhere else (see tip.ts). A pathless view has none.
	aliasesFor: (path: string) => string[];
	// The file's mtime NOW, for landingNote's "written since" comparison.
	// Never asked about a pathless view.
	mtimeFor: (path: string) => number | undefined;
	// The position moved: the browser points the filter box's
	// aria-activedescendant at the row id (focus never leaves the box).
	onActiveRow: (id: string | undefined) => void;
	// A row was clicked: open the file at what it stands for. `target` is the
	// app's own answer for the gesture (see PaneTarget), never a modifier this
	// module read itself.
	onTravel: (rep: number, target?: PaneTarget) => void;
	// A row was right-clicked (or, on a phone, its armed row's menu control
	// tapped): WHICH place, WHERE ON SCREEN the menu opens, and whether the row
	// is the NOTE's own rather than a spot inside it — a pin is a bookmark for a
	// note, so what the browser may add to the menu depends on which it is. A
	// POINT and not the event because the two doors disagree: right-click
	// answers where the pointer is, a control tap where the control STANDS — a
	// click the platform delivers for a finger may carry zero coordinates.
	onContextRow: (rep: number, at: MenuPositionDef, note: boolean) => void;
	// Whether a menu raised from a row is standing — and if one is, TAKE IT
	// BACK (see body.ts's takeMenuBack).
	takeMenuBack: () => boolean;
	// The pointer MOVED ONTO a row: handed over once per row per visit (see
	// hoverAt). What happens with it is the app's own page preview: this list
	// holds no App, and a preview is drawn over everything. `file` says whether
	// the row stands for the NOTE itself rather than a spot inside it.
	onHoverRow: (rep: number, ev: PointerEvent, el: HTMLElement, file: boolean) => void;
	// Whether the rows' hints should be SILENT right now, asked fresh at
	// every hover (see PreviewSettle.isOpen).
	tipsQuiet?: () => boolean;
	// The pointer left the LIST (see the constructor); a hover session is
	// over and whatever the app was asked can stand down.
	onHoverEnd?: () => void;
	// The reader took a row off the list, from its ×: WHICH row, by group KEY
	// (see navGroupKey). A row and not a place: what goes is the NOTE with
	// every spot in it.
	onForget: (key: string) => void;
	// The reader took ONE LANDING off the list: which places the row stands
	// for, BY IDENTITY (see placeKey) — one row can cover two records on one
	// line, and leaving one behind would put the row straight back.
	onForgetLanding: (keys: string[]) => void;
	// How much of a note the list prints (see shownLandings). Read per render.
	landings: () => LandingsMode;
	// How much of a row's PATH to print, and on which side of the name.
	// Read per render.
	pathDisplay: () => PathDisplayMode;
	// Whether a row says how long ago its note was last visited. Off, no
	// element is built and none is hidden.
	rowTime: () => boolean;
	// The rows the reader PINNED, by group key, in the order they are shown.
	// Pulled to the top of the list by the render, and drawn WITHOUT their
	// landings: a pin is a bookmark for the note, and the block is meant to
	// stay the size it is. Read per render.
	pinned: () => readonly string[];
	// The group order to HOLD the list at (see the class comment), or
	// undefined to order by recency. Read per render.
	order: () => readonly string[] | undefined;
	// A place's IDENTITY (see placeKey). Injected because the list does not
	// hold the store; it is what a click re-finds its row by when the list
	// has been rebuilt underneath it — an index cannot serve, since the
	// whole reason for the re-find is that indices moved (see onClick).
	keyOf: (rep: number) => string | undefined;
	// Whether this device is a TOUCH one: decides which way of pointing at a
	// row exists at all — a pointer resting on one, or a finger stopping on
	// one (see arm).
	touch: boolean;
}

// How far the list has to scroll to show a row the KEYBOARD walked to: undefined
// while the row is wholly inside the list, otherwise the distance that puts the
// row's middle at the list's middle. NOT the minimal scroll: rows are all the
// same height, so a minimal scroll leaves the row flush against the edge and
// every further step scrolls the names under a mark that never moves — that
// reads as "the scrollbar is moving, not the selection". Landing in the middle
// costs one jump per half-list and keeps every step visibly a step.
export function revealDelta(rowTop: number, rowHeight: number, boxTop: number, boxHeight: number): number | undefined {
	if (rowTop >= boxTop && rowTop + rowHeight <= boxTop + boxHeight)
		return undefined;
	return Math.round(rowTop - (boxTop + (boxHeight - rowHeight) / 2));
}

export class RecentFilesList {
	// The rows on screen, top to bottom; the keyboard walks THIS (see refs).
	private refs: RowRef[] = [];
	// The groups of the last render: what a file row's `group` indexes into.
	// DRAWN ORDER — the pinned rows first, then the rest (see render).
	private groups: ReturnType<typeof groupByFile> = [];
	// How many of those groups are pinned: the first `pinnedCount` rows are the
	// block, and they are the ones that print no landings.
	private pinnedCount = 0;
	// THE position: the row the reader is on. Undefined until the first key.
	private selected: RowRef | undefined;
	// The place the reader PRESSED, by identity, until its click arrives: what a
	// click opens FROM when the list was rebuilt between press and release (see
	// onClick). Only ever a pass-through.
	private pressed?: string;
	// What a row says on hover (see tip.ts).
	private tip: NavRowTip;
	// The rows that print a section chain (see fitTrails).
	private trails: TrailRow[] = [];
	// The list's own width, watched: whether a chain fits is a question about
	// the width the row has NOW (jsdom implements no layout, hence the guard).
	private watched?: ResizeObserver;
	// The row the pointer is ON, and the row it was last ANNOUNCED for — kept
	// apart so a pointer wandering inside a row says it once (see hoverAt).
	private hovered?: RowRef;
	// WHERE THE POINTER LAST WAS, in the list's coordinates: the only thing
	// that tells a pointer that MOVED from a list that moved under it (see
	// hoverAt). Undefined until the panel has seen the pointer once.
	private pointerAt?: { x: number; y: number };
	// THE ROW A FINGER STOPPED ON (see arm): one row, answered once, over the
	// moment the reader does anything else — a ROW and not a MODE, so there is
	// nothing to forget to leave.
	private armed?: RowRef;
	// THE MARK A PRESS LEAVES on the row it landed on (see markPressed): a
	// class on the row, not a mode of the list — one row, one press, gone by
	// itself.
	private marked?: HTMLElement;
	// …and when it goes, which is NOT when the finger comes up (see
	// ROW_PRESS_MARK_MS).
	private markFade?: number;
	// …and the document the panel stands in, where a finger coming up is heard
	// (a lift can happen off the row it started on; see onLift).
	private doc: Document;
	// Whether the press landing on a menu control TAKES A STANDING MENU BACK
	// rather than asking for one (see menuControl); only the press knows which.
	private menuTapCloses = false;
	// The gesture that arms a row, only where there is no hover to arm it with
	// (see the `touch` option).
	private press?: LongPress;

	constructor(private opts: RecentFilesListOptions) {
		// Nothing is listened to for the LIST's own sake — a pointer moves no
		// position; the rows' own clicks are wired as the rows are drawn.
		this.tip = new NavRowTip(opts.list, opts.tipsQuiet);
		if (typeof ResizeObserver === 'function') {
			this.watched = new ResizeObserver(() => this.fitTrails());
			this.watched.observe(opts.list);
		}
		if (opts.touch) {
			this.press = new LongPress(opts.list, {
				ms: LONG_PRESS_MS,
				slop: LONG_PRESS_SLOP_PX,
				onArm: target => this.armAt(target),
			});
			// A long press is over the moment the reader does anything else:
			// a click anywhere (the armed row's own controls stop theirs before
			// it gets here), or a scroll taking the rows out from under the
			// finger. Both heard on the list, not per row: what ends is the
			// press, and the press belongs to no row in particular.
			this.opts.list.addEventListener('click', () => this.disarm());
			this.opts.list.addEventListener('scroll', () => {
				this.disarm();
				// …and the mark too: a press that was only the beginning of a
				// scroll was not a reader pointing at a row.
				this.unmark();
			}, { passive: true });
		}
		// Both events that say "the pointer came to be over a row" are heard,
		// because a hand that flicks onto a row and stops may deliver only one
		// of them — and both ON THE LIST rather than on the rows: a row is
		// rebuilt on every render, and what is being heard is the pointer.
		this.opts.list.addEventListener('pointermove', (ev) => this.hoverAt(ev));
		this.opts.list.addEventListener('pointerover', (ev) => this.hoverAt(ev));
		// The list is the boundary that means "not on a row at all": every row
		// hears its own leaving, including the ones it is leaving FOR each other.
		this.opts.list.addEventListener('pointerleave', (ev) => {
			this.hovered = undefined;
			// Where the pointer was last seen goes with it — it is where the
			// hand is when it comes back.
			this.pointerAt = { x: ev.clientX, y: ev.clientY };
			this.opts.onHoverEnd?.();
		});
		// The finger coming up ends the mark a press left — heard on the
		// DOCUMENT: a finger that slid off the list before it lifted is still
		// a finger that came up (see releaseMark).
		this.doc = this.opts.list.ownerDocument;
		this.doc.addEventListener('pointerup', this.onLift);
		this.doc.addEventListener('pointercancel', this.onLift);
	}

	// The place index a row acts on: a landing is itself; a NOTE is the note's OWN
	// record — the place that stands for the file rather than for a spot inside it
	// (see listing.ts's `anchor`). That is what makes a file row an OPEN and not a
	// jump: its record carries no position, so travelling to it opens the file the
	// plain way, exactly as clicking it in Obsidian's file explorer does. A group
	// with no anchor (the note's own record evicted, its jumps surviving) falls
	// back to its newest landing.
	//
	// Every row this answers for HAS somewhere to go: a place whose file is gone
	// never becomes a row (see render's `keep`), so the only way to -1 here is a
	// group the list no longer holds.
	private activeRep(row: RowRef): number {
		if (row.group === undefined)
			return row.rep ?? -1;
		const group = this.groups[row.group];
		if (!group)
			return -1;
		if (group.anchor !== undefined && group.anchor >= 0)
			return group.anchor;
		const order = group.indices;
		// The place index IS the clock (the list is kept in MRU order): the
		// highest index among a note's landings is its newest one.
		return order.length ? order.reduce((a, b) => (a > b ? a : b)) : -1;
	}

	// Whether this note's landings are printed under its own row right now. One
	// landing is not a list — it is what the note's own row already stands for.
	// A PINNED row prints none ever: the block is a shelf, and a row that grew
	// two lines every time the reader visited the note would push the shelf
	// down the panel. What a pin costs them is the LIST of spots; the row still
	// stands for the newest one, so a click goes where it always did.
	private printsLandings(group: number): boolean {
		if (group < this.pinnedCount)
			return false;
		return this.opts.landings() === 'all' && (this.groups[group]?.indices.length ?? 0) > 1;
	}

	// WHICH of a note's places are on screen: none by default; under 'all',
	// every distinct line, top of the note first.
	private shownLandings(group: ReturnType<typeof groupByFile>[number], index: number): number[] {
		return this.printsLandings(index) ? group.indices : [];
	}

	// Put the pinned rows at the top, in the reader's own order (see the
	// `pinned` option), and count them. A pin naming a row that is not on
	// screen — filtered out, or a place the list no longer holds — is skipped:
	// the block is drawn from the rows that exist, and a pin is not a promise
	// that its note is listed.
	private pullPinnedToTop(): void {
		const byKey = new Map(this.groups.map(g => [g.key, g]));
		const pinned = this.opts.pinned();
		const top: typeof this.groups = [];
		for (const key of pinned) {
			const group = byKey.get(key);
			if (group)
				top.push(group);
		}
		this.pinnedCount = top.length;
		if (top.length === 0)
			return;
		const held = new Set(top);
		this.groups = [...top, ...this.groups.filter(g => !held.has(g))];
	}

	// Whether the row just drawn is the last of the pinned block, which is when
	// the line under it is owed — and only when something follows: a line under
	// the whole list would be a line under nothing.
	private endsPinnedBlock(index: number): boolean {
		return this.pinnedCount > 0
			&& index === this.pinnedCount - 1
			&& this.groups.length > this.pinnedCount;
	}

	// (Re)draw the rows; the toolbar and the panel persist around them.
	render(): void {
		// A long press does not outlive a redraw: the row the finger stopped on
		// is about to be thrown away, and a × on the row drawn in its place is a
		// control for a row nobody armed. The mark and the words go with it for
		// the same reason.
		this.disarm();
		this.unmark();
		this.tip.reset();
		// The cursor's identity across the rebuild: the note's group index, or
		// the stack index of the landing it is on. Captured BEFORE the rows go.
		const cursor = this.selected;
		const wasGroup = cursor?.group;
		const wasRep = cursor && cursor.group === undefined ? cursor.rep ?? -1 : -1;
		this.opts.list.empty();
		this.opts.clearDescribeCache();
		this.refs = [];
		this.trails = [];
		this.groups = [];
		this.selected = undefined;
		// The row the pointer was last announced for goes with them — its
		// element is being thrown away. The pointer's own place is NOT
		// forgotten: a row drawn under a hand that has not moved is still not
		// a row that hand pointed at.
		this.hovered = undefined;

		const query = this.opts.filter().trim();
		// The query narrows on text: what the row prints (name, path, section
		// chain, "L412") plus what the entry recorded (context, how a link got
		// here). The row's printed text is derived from the vault's heading
		// cache, so the pure predicate takes it as an argument (see
		// matchesNavFilter). An UNFILTERED list still reads the metadata cache
		// once per listed path: a file's other names are searchable and printed
		// on the row's tooltip, prepared with the row rather than on hover.
		const printed = (i: number): string => {
			const entry = this.opts.entries[i];
			const d = this.opts.describe(i);
			// The file's other names ride the `extra` channel (see
			// matchesNavFilter); read per PATH, so every landing of one note
			// carries the same names.
			const aka = entry.kind === 'view' ? [] : this.opts.aliasesFor(entry.path);
			return `${d.line ?? ''} ${this.opts.trailFor(entry, d).join(' ')} ${aka.join(' ')}`;
		};
		// WHAT may be listed at all: a place whose file is gone is dropped
		// before grouping — no row, no landing, no "you are here" ever stands
		// for a name that cannot be opened. A VIEW place is exempt (no file to
		// be gone).
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
			// The order to hold, when the reader is on the list.
			this.opts.order(),
		);
		// THE PINNED ROWS GO FIRST, in the order the reader put them in and not
		// in the order the places happen to be in — that order is a clock, and a
		// shelf the reader arranged is not one. Everything else keeps the order
		// it came out of the grouping with (recency, or the held one).
		this.pullPinnedToTop();
		// The names two notes on screen share: measured over the rows ON
		// SCREEN, so a collision the filter dropped costs nobody a folder.
		const doubles = duplicateNames(this.groups.map(g => g.path));

		this.groups.forEach((group, index) => {
			this.fileRow(group, index, doubles, query);
			for (const i of this.shownLandings(group, index))
				this.placeRow(i, i === group.currentRep, query);
			// The block ends with a LINE and not with a heading: a pinned row is
			// a row like any other, and the only thing that says which rows are
			// the block is where it stops.
			if (this.endsPinnedBlock(index))
				this.opts.list.createDiv({ cls: 'position-restore-nav-pinned-sep' });
		});
		// What the LAYOUT did to the rows just drawn, read back now that they
		// have a width to be measured against (see fitTrails).
		this.fitTrails();

		// Nothing to draw: the query found no step, or the history has nothing
		// left to name.
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
				// The landing is gone (the filter dropped it, or the setting
				// stopped printing the note's landings): stand on its note.
				this.focusGroupOf(wasRep);
		}
	}

	// What the list says when it has nothing to draw. Two different nothings,
	// one message each, decided by the query; render is the only caller.
	private emptyText(query: string): string {
		return query ? t('recentFiles.noMatch') : t('recentFiles.empty');
	}

	// The groups as they are drawn RIGHT NOW, by identity: what the browser
	// pins when the pointer arrives (see the `order` option). Asked of the
	// list rather than recomputed because the order on screen is this
	// render's — the filter in force and any order already being held went
	// into it.
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

	// One NOTE. The name cell holds the NAME (last path segment, no extension,
	// see displayName), the type BADGE where the file is not markdown, and the
	// FOLDER under the conditions the reader chose (see PathDisplayMode). The AGE
	// stands at the row's far end, a track of its own, so the times end on one x
	// down the whole list. A pathless view row prints no folder and no badge —
	// its own ICON takes that slot instead (see below).
	private fileRow(
		group: ReturnType<typeof groupByFile>[number],
		index: number,
		doubles: Set<string>,
		// The query in force, which the row's own words are quoted against. A
		// note's row usually has nothing to quote, but a note whose landings are
		// not printed is standing on one of them (see below), and the reader who
		// found it with a query is owed the line the query hit.
		query: string,
	): number {
		// The note's own record when it has one (see activeRep), else any
		// landing it holds: the row needs ONE record to read the name and the
		// view kind from.
		const rep = group.anchor
			?? group.indices.find(i => i !== group.currentRep)
			?? group.indices[0];
		const head = rep === undefined ? undefined : this.opts.describe(rep);
		const repEntry = rep === undefined ? undefined : this.opts.entries[rep];
		const name = head?.name ?? displayName(group.path);
		const row = this.opts.list.createDiv({ cls: `${ROW_CLASS} is-file` });
		if (group.current)
			row.addClass('is-current');
		// The pinned block's own rows, marked for the stylesheet and for a test
		// that has to tell them apart without reading the pin list.
		if (index < this.pinnedCount)
			row.addClass('is-pinned');
		// WHICH SIDE the folder prints on is a class, not an insertion order:
		// the DOM order is fixed so the row reads in one order however it is
		// drawn, and the visual order is the stylesheet's.
		const mode = this.opts.pathDisplay();
		if (mode !== 'after')
			row.addClass('is-path-before');
		row.dataset.group = String(index);
		row.setAttr('id', `${this.opts.listId}-row-g${index}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		// A file row's identity is the GROUP: `rep` stays undefined (see
		// activeRep).
		const ref: RowRef = { el: row, group: index };
		row.addEventListener('click', (ev) => this.onClick(ref, ev));
		row.addEventListener('pointerdown', (ev) => this.onPress(ref, ev));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);

		const file = row.createDiv({ cls: 'nav-row-file' });
		// The name and its mark are ONE item of the wrapping cell, not two:
		// a mark that is a SIBLING of the name is the first thing the wrap
		// drops, which prints the type on a line of its own below the name it
		// was cut away from. Nothing wraps inside .nav-row-head, so the two
		// break off together and the FOLDER takes the second line.
		const lead = file.createDiv({ cls: 'nav-row-head' });
		lead.createSpan({ text: name, cls: 'nav-row-name' });
		// The type, where the type is worth saying: markdown prints nothing
		// (see badgeOf). The CLASS is the app's own tag, so the mark is drawn
		// by the app's stylesheet (and whatever a theme did to it) rather than
		// by a rule of ours — a type that looked like a type everywhere but
		// here is one the reader has to learn twice.
		const badge = badgeOf(group.path);
		if (badge) {
			lead.createSpan({ text: badge, cls: 'nav-file-tag' });
		} else {
			// A PATHLESS VIEW takes this slot: its OWN icon, the one its tab
			// header showed (see viewIcon). A view that named no icon gets the
			// WORD instead — an icon id the app's build does not know draws an
			// empty slot, which says less than a word.
			if (repEntry?.kind === 'view') {
				const label = t('recentFiles.viewBadge');
				if (repEntry.icon) {
					const mark = lead.createSpan({ cls: 'nav-row-view-icon' });
					setIcon(mark, repEntry.icon);
					mark.setAttr('aria-label', label);
				} else {
					lead.createSpan({ text: label, cls: 'nav-file-tag' });
				}
			}
		}
		// Which folder this note is in: 'smart' prints it only where the name
		// collides. The root prints "/" — an empty span would look exactly
		// like a note whose folder simply was not printed, a different fact.
		const folder = group.path ? folderOf(group.path) : undefined;
		const printsPath = folder !== undefined && (mode !== 'smart' || doubles.has(name));
		if (printsPath)
			file.createSpan({ text: folder === '' ? '/' : `${folder}/`, cls: 'nav-row-path' });
		// HOW LONG AGO this note was last visited, where the reader asked for
		// it: the newest stamp the group holds (see newestStamp). It stands in
		// the row's own track at the far end — inside the name it only worked
		// on a row whose folder was not printed.
		if (this.opts.rowTime()) {
			const stamp = newestStamp(this.opts.entries, group.indices, group.anchor);
			if (stamp !== undefined) {
				const label = row.createSpan({ text: ageLabel(stamp, Date.now()), cls: 'nav-row-time' });
				// The row's shape follows the label that was built, so the
				// two can never disagree about the second track.
				row.addClass('is-timed');
				// The exact moment lives on the TIME, not the row: hovering
				// the time says when, hovering anything else says which file.
				this.tip.attach(label, { text: new Date(stamp).toLocaleString() });
			}
		}
		// WHAT THE HOVER SAYS: only what the row does not already say. The full
		// path where the row prints NO folder (a row carrying a folder has
		// already answered "which one is this"), and the file's other names,
		// which take up no cell and are said nowhere else.
		const aka = group.path ? this.opts.aliasesFor(group.path) : [];
		const tip: TipContent = {};
		if (group.path && !printsPath)
			tip.path = group.path;
		if (aka.length)
			tip.text = `${t('recentFiles.aka')} ${aka.join(' · ')}`;
		// Where this row IS one of the note's places (a note with one place,
		// or any note while the setting prints none): the click goes there
		// (see activeRep), so the row has to be able to say what the spot was.
		if (!this.printsLandings(index)) {
			const spot = this.opts.entries[this.activeRep(ref)];
			if (spot?.kind === 'jump') {
				const quotes = this.landingQuotes(spot, query);
				if (quotes.length)
					tip.quotes = quotes;
				const note = this.landingNote(spot);
				if (note)
					tip.note = note;
			}
		}
		if (tip.path || tip.text || tip.quotes || tip.note)
			this.tip.attach(row, tip);
		// THE ROW'S OWN REMOVAL. It is HERE rather than in the row's menu
		// because that menu is the APP's file menu and only a file has one —
		// a pathless view row would never get it. Its events are STOPPED:
		// with the press let through, reaching for the × would record the row
		// as pressed and the click would open the note.
		const actions = this.actionStrip(row);
		// The menu control, only on a TOUCH device and only for a row with a
		// FILE behind it: a right-click raises the app's menu on a desktop;
		// here the long press arms the row instead (see onContextMenu), so the
		// menu is raised from the row itself.
		if (this.opts.touch && repEntry?.kind !== 'view')
			this.menuControl(actions, ref);
		this.forgetControl(actions, t('recentFiles.forget'), () => this.opts.onForget(group.key));
		// NO "you are here" dot on the note's name: the row carries
		// `is-current` and the list is in recency order, so a dot would only
		// repeat what the row already says. The dot survives on the LANDING
		// that holds the current entry, whose note has other rows beside it
		// (see placeRow).
		return 1;
	}

	// THE × AT A ROW'S FAR END. Built the same way on both kinds of row — the
	// gesture must not differ by which row the finger came down on; what
	// differs is WHAT GOES (the caller's `drop`). Always the LAST control, so
	// a row's far end reads the same way round on every row.
	private forgetControl(strip: HTMLElement, label: string, drop: () => void): void {
		const forget = strip.createDiv({ cls: 'nav-row-forget clickable-icon' });
		forget.setAttr('role', 'button');
		// Outside the tab order: this list's keyboard is the position and the
		// arrow keys, and a tabbable button would be a second keyboard model.
		forget.setAttr('tabindex', '-1');
		forget.setAttr('aria-label', label);
		setIcon(forget, 'x');
		// A finger coming down here spends the click the press may still be
		// holding (see long-press.ts's release): a claim that outlived its own
		// press would swallow this tap.
		forget.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			this.press?.release();
		});
		forget.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// The click a long press delivers on lift can land on a control
			// the press itself put under that finger; a reader who stopped on
			// a row did not ask to drop it.
			if (this.press?.consumeClick())
				return;
			drop();
		});
	}

	// The words a landing row RECORDED and never prints: the line it sat on,
	// and — while a query is up — the line the query hit. The HIT comes first
	// when there is one: a reader looking at a filtered list is asking why
	// this row survived. The landing's own line follows only when it differs
	// — saying the same words twice under two labels is a tooltip that has
	// stopped talking.
	private landingQuotes(entry: NavEntry, query: string): string[] {
		if (entry.kind === 'view')
			return [];
		const hit = query ? matchedContextLine(entry, query) : undefined;
		const own = landingText(entry);
		const out: string[] = [];
		if (hit)
			out.push(`${t('recentFiles.matchedLine')}${hit}`);
		if (own && own !== hit)
			out.push(`${t('recentFiles.landingLine')}${own}`);
		return out;
	}

	// Whether the note has been written since the landing's words were taken.
	// The quote is a photograph — the coordinate and the section are the
	// note's as it stands NOW, the words are its as it stood THEN, and
	// nothing else on the row says which is which. Not a warning and nothing
	// to do: what it buys is that an old quote reads as an old quote.
	private landingNote(entry: NavEntry): string | undefined {
		if (entry.kind === 'view')
			return undefined;
		const taken = entry.st?.mtime;
		// No stamp on the record says nothing rather than guessing.
		if (taken === undefined)
			return undefined;
		const now = this.opts.mtimeFor(entry.path);
		// A clock that ran BACKWARDS (a sync putting an older copy back) says
		// nothing rather than claiming a rewrite that did not happen.
		if (now === undefined || now <= taken)
			return undefined;
		return t('recentFiles.editedSince');
	}

	// WHICH PLACES ONE LANDING ROW STANDS FOR, by identity (see placeKey). A
	// row is one LINE, and the list collapses onto it every place that landed
	// there (see groupByFile) — so one row can be two records. Dropping the
	// row's own record alone would leave the other standing, and the row
	// would be back before the redraw had finished. Matched through the SAME
	// `describe` the grouping used, so the two never disagree about which
	// line a place is on.
	private landingKeys(path: string, line: number | undefined): string[] {
		const entries = this.opts.entries;
		const out: string[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.kind !== 'jump' || entry.path !== path)
				continue;
			if (this.opts.describe(i).lineIndex !== line)
				continue;
			out.push(placeKey(entry));
		}
		return out;
	}

	// One landing row's hover, whatever the layout has done to it. ONE place
	// that assembles it, because two passes write it — the row's own draw and
	// the fit pass (see fitTrails) — and a tooltip written twice is one that
	// can disagree with itself.
	private placeTip(
		chain: string[], trail: string[], quotes: string[], note?: string,
	): TipContent | undefined {
		const tip: TipContent = {};
		if (chain.length > trail.length)
			tip.text = chain.join(' › ');
		if (quotes.length)
			tip.quotes = quotes;
		if (note)
			tip.note = note;
		return tip.text !== undefined || tip.quotes !== undefined || tip.note !== undefined
			? tip
			: undefined;
	}

	// One PLACE of a note: the coordinate it landed on, and the section it sits
	// in. Drawn only under 'all' (see shownLandings) — one row per distinct
	// line, so the row is ONE destination and nothing has to be explained away.
	private placeRow(i: number, current: boolean, query: string): number {
		const entry = this.opts.entries[i];
		const d = this.opts.describe(i);
		const row = this.opts.list.createDiv({ cls: `${ROW_CLASS} is-place` });
		if (current)
			row.addClass('is-current');
		row.dataset.rep = String(i);
		row.setAttr('id', `${this.opts.listId}-row-${i}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		// A landing row stands for itself.
		const ref: RowRef = { el: row, rep: i };
		row.addEventListener('click', (ev) => this.onClick(ref, ev));
		row.addEventListener('pointerdown', (ev) => this.onPress(ref, ev));
		row.addEventListener('contextmenu', (ev) => this.onContextMenu(ev, ref));
		this.refs.push(ref);

		// The coordinate, and — since a row is an OPEN — the line the click
		// lands on: the same number, because the row stands for exactly one
		// landing. The "you are here" dot is hung off the box's own start, so
		// the DOM order says what the eye sees while the box keeps holding the
		// number alone (see styles.css).
		const pos = row.createSpan({ cls: 'nav-row-pos' });
		if (current)
			pos.createSpan({ text: '●', cls: 'nav-row-here' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		else
			pos.createSpan({ text: '—', cls: 'nav-row-nopos' });

		// The section the landing sits in, deepest one or two levels (see
		// rowTrail): what a reader recognizes a spot by, so it takes the row's
		// slack. The cell is created even when empty, so its track exists on
		// every landing row. `chain` is the whole thing; the outer levels are
		// one hover away (see the tooltip below).
		const chain = this.opts.trailFor(entry, d);
		const trail = rowTrail(chain);
		const crumb = row.createSpan({ cls: 'nav-row-trail' });
		let outer: HTMLElement | undefined;
		for (let k = 0; k < trail.length; k++) {
			const level = crumb.createSpan({
				text: trail[k],
				cls: k === trail.length - 1 ? 'nav-trail-deep' : 'nav-trail-seg',
			});
			// The separator RIDES WITH the level it follows: a cell of its own
			// keeps its width after the level in front has been squeezed to
			// nothing, and the row went on printing a "›" with nothing to its
			// left. Inside the level, it goes when the level goes.
			if (k < trail.length - 1) {
				level.createSpan({ text: '›', cls: 'nav-trail-sep' });
				outer = level;
			}
		}
		// WHAT THE HOVER SAYS: the whole chain, and only where the row is not
		// already printing all of it — but "already prints" is the layout's
		// answer as much as the chain's, and a row is drawn before anything
		// has been measured, so the fit pass gives the row this tooltip when
		// it takes a level off (see fitTrails). The recorded words ride along
		// either way: they are the half of this row the reader cannot see
		// anywhere.
		const quotes = this.landingQuotes(entry, query);
		const note = this.landingNote(entry);
		const tip = this.placeTip(chain, trail, quotes, note);
		if (tip)
			this.tip.attach(row, tip);
		// …and the row joins the ones the fit pass will ask about. A row that
		// printed a single level has nothing to give up.
		if (outer)
			this.trails.push({ el: row, outer, chain, quotes, note });
		// HOW LONG AGO THE READER WAS AT THIS PLACE — its own time, not the
		// note's: a spot the reader has not been back to keeps the time it
		// earned, and the block it quotes was captured on that visit.
		const strip = this.actionStrip(row);
		if (entry.kind !== 'view') {
			if (this.opts.rowTime()) {
				const label = row.createSpan({
					text: ageLabel(entry.t, Date.now()),
					cls: 'nav-row-time',
				});
				row.addClass('is-timed');
				this.tip.attach(label, { text: new Date(entry.t).toLocaleString() });
			}
			// THE MENU FIRST, THE × LAST — the same order as a note's row: a
			// reader who learned the order once reads it again here, and it is
			// the order that holds when one of them is missing (the removal is
			// the OUTER one).
			if (this.opts.touch)
				this.menuControl(strip, ref);
			this.forgetControl(strip, t('recentFiles.forgetLanding'), () =>
				this.opts.onForgetLanding(this.landingKeys(entry.path, d.lineIndex)));
		}

		return 1;
	}

	// WHAT THE LAYOUT DID TO THE CHAINS, READ BACK ONCE THE ROWS ARE ON SCREEN.
	// A row is drawn before anything has been measured, and a stylesheet can
	// only SQUEEZE the outer level: what a squeezed level leaves is a FRAGMENT
	// that names no section, and the deepest level does not pay for it in width
	// (see styles.css). Past half of its outer level, the fragment is not worth
	// the room it reads in, and the row prints its deepest level alone (see
	// dropsOuterLevel). The level that goes is not lost — it becomes the row's
	// tooltip (hover answers with what the row could not say).
	private fitTrails(): void {
		const rows = this.trails;
		// A list with no layout — a test's DOM, or a panel that has not reached
		// the document — reports every width as 0, and every chain would go.
		if (!rows.length || !this.opts.list.clientWidth)
			return;
		// Measure with every level back on its row: a level the LAST pass took
		// off has no box to be measured in, and a pane dragged wider has to be
		// able to have it back. One write over all of them …
		for (const r of rows)
			r.el.removeClass('is-deep-only');
		// …then ONE read of all of them, before the first row is written back:
		// a write invalidates the layout every later read would have to wait for.
		const dropped = rows.map(r => dropsOuterLevel(r.outer.clientWidth, r.outer.scrollWidth));
		rows.forEach((r, i) => {
			// One tooltip, written from what the row prints NOW: a level the
			// layout took off is a level the hover has to give back.
			const tip = this.placeTip(
				r.chain, rowTrail(r.chain, dropped[i] ? 1 : undefined), r.quotes, r.note,
			);
			if (!tip) {
				this.tip.detach(r.el);
				return;
			}
			if (dropped[i])
				r.el.addClass('is-deep-only');
			this.tip.attach(r.el, tip);
		});
	}

	// A right-click on a row — or a finger's lingering press, which a WebView
	// reports as the same event, carrying the left button's number — hands the
	// row to the APP: the browser raises the app's own file menu over it (see
	// onContextRow). A right-click never TRAVELS: a second button doing the
	// first button's job is a gesture to learn for nothing, and on a tablet a
	// slow tap would become a jump.
	//
	// The event is still REFUSED as well as used: without preventDefault a long
	// press also raises the WebView's selection callout, and a menu with a
	// callout over it is worse than either alone. What the menu may do is the
	// app's business; this list writes nothing itself.
	private onContextMenu(ev: MouseEvent, ref: RowRef): void {
		ev.preventDefault();
		// ON A TOUCH DEVICE this event is the same gesture the clock is waiting
		// for, and which of the two arrives first is the platform's business —
		// so the row is armed here as well, and the arm is idempotent.
		if (this.opts.touch) {
			this.arm(ref, ev.target instanceof Node ? ev.target : ref.el);
			return;
		}
		const rep = this.activeRep(ref);
		if (rep >= 0)
			this.opts.onContextRow(rep, { x: ev.clientX, y: ev.clientY }, ref.group !== undefined);
	}

	// A FINGER STOPPED ON A ROW, which on a device with no hover is what a
	// hover is (see long-press.ts): the row answers for itself — the words it
	// cannot print (see tip.ts's speak), and the controls the stylesheet keeps
	// out of sight until a row is armed. ONE ROW AT A TIME: arming another
	// answers the first on the way. It ends with the press rather than with
	// the finger (see disarm): the lift is the beginning of the answer, not
	// the end of it.
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
		// …and the mark comes back, marked AGAIN rather than merely held: a
		// long press is longer than the mark a tap is given (see
		// ROW_PRESS_MARK_MS), so the clock has likely taken it off already.
		// From here what ends the mark is the reader letting go of the row,
		// not a number (see holdMark).
		this.markPressed(ref.el);
		this.holdMark();
		// The click the finger may still deliver when it lifts belongs to
		// this gesture, not to the reader (see onClick).
		this.press?.markArmed();
		// …and the row says what it cannot print, asked of the element the
		// finger came down on: a finger resting on the TIME is asking for the
		// moment behind "5m", one anywhere else which file this is.
		this.tip.speak(target);
	}

	// The press is over: the reader tapped somewhere, scrolled, or the list
	// was drawn again under the finger.
	private disarm(): void {
		if (!this.armed)
			return;
		this.armed.el.removeClass('is-armed');
		this.armed = undefined;
		this.tip.retract();
		this.unmark();
	}

	// THE PRESS ITSELF, SAID ON THE ROW: a tap and a long press look exactly
	// alike for half a second, and neither changes anything on a phone until
	// the travel goes through — long enough to wonder whether the tap landed,
	// and on which row. So the row answers the press before the press has been
	// answered. ONE ROW AT A TIME: one finger, one press.
	//
	// It stays lit for the WHOLE press: the clock set here is a CEILING for a
	// finger that never comes up (see ROW_PRESS_HOLD_MAX_MS), not when the
	// mark goes — a mark that blinked out halfway to a long press would say
	// the row had stopped answering. The ordinary mark is ended by the LIFT
	// (see releaseMark).
	private markPressed(el: HTMLElement): void {
		if (this.marked && this.marked !== el)
			this.marked.removeClass('is-pressed');
		this.marked = el;
		el.addClass('is-pressed');
		if (this.markFade !== undefined)
			window.clearTimeout(this.markFade);
		this.markFade = window.setTimeout(() => this.unmark(), ROW_PRESS_HOLD_MAX_MS);
	}

	// The press became an ARM: the clock has nothing to time — the mark now
	// lasts as long as the arm does (see disarm).
	private holdMark(): void {
		if (this.markFade === undefined)
			return;
		window.clearTimeout(this.markFade);
		this.markFade = undefined;
	}

	// The mark goes: the tap was answered, or it was a scroll, or the row was
	// redrawn away. Nothing about it outlives the row it was put on.
	private unmark(): void {
		this.holdMark();
		this.marked?.removeClass('is-pressed');
		this.marked = undefined;
	}

	// THE FINGER CAME UP: the mark gets one more beat to be seen in (see
	// ROW_PRESS_MARK_MS). AN ARM IS NOT ENDED BY THE LIFT: the reader lifted
	// the finger to reach for what the arm put on the row, so the mark stays
	// and the clock is dropped rather than re-set.
	private releaseMark(): void {
		if (this.markFade !== undefined)
			window.clearTimeout(this.markFade);
		if (this.armed) {
			this.markFade = undefined;
			return;
		}
		this.markFade = window.setTimeout(() => this.unmark(), ROW_PRESS_MARK_MS);
	}

	// …and a gesture the platform took AWAY (a scroll beginning, a second
	// finger) was never a press the reader finished, so the mark goes at once.
	private onLift = (ev: Event): void => {
		if (ev.type === 'pointercancel') {
			this.unmark();
			return;
		}
		this.releaseMark();
	};

	// THE STRIP THE ROW'S CONTROLS STAND IN: out of the row's flow, at its far
	// end (see styles.css), and answerable for one thing beyond holding them —
	// a press that landed inside it but on NEITHER control was a MISS, and a
	// miss travels nowhere: the browser clicks the nearest common ancestor of
	// press and release, which is the ROW, so a reader who slid off a control
	// was sent to the note. A miss leaves the arm STANDING — a row that took
	// its controls away mid-reach makes the reader aim a second time.
	private actionStrip(host: HTMLElement): HTMLElement {
		const strip = host.createDiv({ cls: 'nav-row-actions' });
		strip.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// …and the press's own tail is spent here too: the strip is where
			// the controls APPEAR, so it is where a finger may already be
			// resting when it lifts. A claim that survived its press would
			// swallow the reader's next tap on a control.
			this.press?.consumeClick();
		});
		return strip;
	}

	// THE ROW'S SECOND ACT, only on a touch device: RAISES THE APP'S MENU for
	// the file behind the row (the same menu a right-click raises on a
	// desktop), with this panel's one item on top. NOT A SHORTCUT for that one
	// travel: the app already has a whole menu about the file, and one tap
	// more buys every answer the shortcut could not give — the one it did
	// give is the first item on the menu.
	private menuControl(host: HTMLElement, ref: RowRef): void {
		const more = host.createDiv({ cls: 'nav-row-menu clickable-icon' });
		more.setAttr('role', 'button');
		// Outside the tab order, exactly as the × is.
		more.setAttr('tabindex', '-1');
		more.setAttr('aria-label', t('recentFiles.rowMenu'));
		// Three dots: the only glyph that promises a LIST. `file-plus` reads
		// as a new file, `external-link` promises a place outside.
		setIcon(more, 'more-vertical');
		more.addEventListener('pointerdown', (ev) => {
			ev.stopPropagation();
			// The claim the press is still holding, spent by the finger
			// arriving here (see long-press.ts's release).
			this.press?.release();
			// A menu this control already raised: THIS press takes it back,
			// and the click must not put it straight back up. Asked HERE, not
			// on the click: by the click the app's menu may be standing over
			// this very control — moved up by its own height when the row sat
			// too low on the screen.
			this.menuTapCloses = this.opts.takeMenuBack();
		});
		more.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// The press's own tail, exactly as the × refuses it.
			if (this.press?.consumeClick())
				return;
			// The press took a standing menu back: not asking for another.
			if (this.menuTapCloses) {
				this.menuTapCloses = false;
				return;
			}
			const rep = this.activeRep(ref);
			// A row with nowhere to go raises no menu, as a desktop's
			// right-click on one does not.
			if (rep < 0)
				return;
			// WHERE IT OPENS is the CONTROL'S OWN BOX, not the tap's: a click
			// the platform delivers for a finger may carry zero coordinates.
			const box = more.getBoundingClientRect();
			this.opts.onContextRow(
				rep,
				{ x: box.left + box.width / 2, y: box.bottom },
				ref.group !== undefined,
			);
			// THE ARM STAYS: a menu is a question, not an answer, and the
			// row's own answers may still be the ones the reader wants when
			// the menu closes.
		});
	}

	// THE POINTER IS OVER A ROW: hand it to the app, ONCE per row per visit
	// (see onHoverRow). Heard from a MOVE and from an ARRIVAL alike, because a
	// hand that flicks onto a row and stops may deliver only one of the two.
	//
	// WHAT DECIDES IS WHETHER THE POINTER MOVED. `pointerover` fires whenever
	// an element COMES to be under a pointer, moved or not: the dialog a
	// hotkey opened with the mouse resting mid-screen draws its rows around
	// that pointer, and every one reports an arrival — a page preview asked
	// for a note nobody pointed at. Same for a list redrawn or scrolled under
	// the hand. So an event at the same coordinates as the last one is the
	// panel moving, not the hand.
	//
	// THE FIRST EVENT A PANEL HEARS IS NOT A MOVE: where the pointer was
	// before the panel existed was never the panel's to know, so the first
	// event is recorded rather than answered. Nothing is lost: a reader who
	// means to point at a row moves.
	//
	// ONCE PER ROW, not once per element: the move that crosses the name
	// after the one that crossed the badge is the same hand on the same row.
	// Leaving the LIST and coming back is an arrival again — the list's own
	// leave forgets (see the constructor).
	//
	// A FINGER DOES NOT HOVER, it presses: on a phone there is neither the
	// room nor the gesture for a page beside the row the thumb is about to tap.
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
		// A row with nowhere to go has nothing to preview either. `file` says
		// whether the row stands for the NOTE itself or a spot inside it —
		// the two ask the app to open differently.
		if (rep >= 0)
			this.opts.onHoverRow(rep, ev, ref.el, ref.group !== undefined);
	}

	// The row the pointer is over, from whichever element the event names
	// (see ROW_CLASS). Undefined over the list's own background.
	private rowAt(target: EventTarget | null): RowRef | undefined {
		const el = target instanceof HTMLElement
			? target.closest<HTMLElement>(`.${ROW_CLASS}`)
			: null;
		return el ? this.refs.find(r => r.el === el) : undefined;
	}

	// Put the position away: the list back to the shape it opens in. A shell
	// that STAYS UP across a travel is the only caller (see view.ts): the jump
	// rewrites the stack and pins the note it landed on first, so the stack
	// index the position was resolved from may now name another note.
	collapse(): void {
		this.clearSelection();
	}

	// The row's own click opens what it stands for (see activeRep): a note's
	// row answers with the note's own record (the plain open), a landing row
	// with itself. The place the reader is already in is NOT exempt — the row
	// opens it again, which is what a reader whose tab was closed came for.
	//
	// WHERE the click opens is decided by the ELEMENT it landed on only while
	// that element is still part of the list. A row's index is this render's,
	// and the reader's own click makes the store re-order itself — so a click
	// whose element the last render threw away is resolved by the place the
	// reader PRESSED (see onPress / keyOf). A click with no press behind it
	// (a programmatic `el.click()`, assistive technology) opens NOTHING:
	// opening nothing is the one failure this list can afford, opening the
	// wrong note the one it cannot.
	private onClick(ref: RowRef, ev: MouseEvent): void {
		// This row answers the click, whatever its answer turns out to be.
		ev.preventDefault();
		// …unless it is the TAIL OF A LONG PRESS: the row under the finger
		// was armed by that very gesture, and a reader who stopped on a row
		// did not ask to go there. Kept from the list's own listener too,
		// which would take the arm off.
		if (this.press?.consumeClick()) {
			this.pressed = undefined;
			ev.stopPropagation();
			return;
		}
		// WHERE it opens is the app's call, not this module's:
		// `Keymap.isModEvent` is the documented answer, and reading
		// ctrlKey/metaKey here would be a second, worse copy that gets the
		// platform wrong. The app's `false` is normalised to no target.
		const target = Keymap.isModEvent(ev) || undefined;
		const key = this.pressed;
		this.pressed = undefined;
		const rep = this.refs.includes(ref)
			? this.activeRep(ref)
			: key === undefined ? -1 : this.findByKey(key);
		if (rep >= 0)
			this.opts.onTravel(rep, target);
	}

	// The click the rows did NOT answer: the browser resolved press and
	// release on the nearest ancestor still in the document — the row pressed
	// was rebuilt away in between. Answered by identity, the same as a stale
	// element's own click (see onClick). Runs AFTER the rows have had their
	// say (hence the check): it is the only thing here that could
	// double-answer a click.
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

	// The reader pressed a row. THE PRIMARY BUTTON presses: remember WHICH
	// place, by identity (see keyOf) and not by index — the index is the
	// thing about to stop meaning this place. THE MIDDLE BUTTON opens HERE:
	// a middle-click is delivered as `auxclick`, not `click`, and preventDefault
	// keeps the WebView's middle-click autoscroll out. THE RIGHT BUTTON does
	// neither: it raises the menu and never a click, so recording it would
	// leave a claim for the NEXT click to inherit.
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
		// A row standing for nothing answers a press with nothing — marking
		// it would promise a travel that is not coming.
		if (rep >= 0)
			this.markPressed(ref.el);
	}

	// The row holding a place, found by identity rather than by index — or -1
	// when this list no longer shows it. A place the list somehow holds TWICE
	// is refused too: identity is what the store dedupes places BY (see
	// places.remember), so two rows carrying one key means the list cannot
	// tell them apart.
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

	// The stack index a row would open, or -1 when it has none. What it must
	// NOT refuse is the place the reader is already standing in: a row is an
	// OPEN, not a step, and a reader clicking the row they are on is asking
	// for the FILE back — jumpTo already answers exactly that (see
	// NavStack.travelTo). Refusing it made the first row of the list — the
	// current note, pinned first — the one row that answered nothing.
	private targetOf(ref?: RowRef): number {
		const target = ref ?? this.selected;
		if (!target)
			return -1;
		return this.activeRep(target);
	}

	// Travel to the landing a row stands for. Public because Enter comes in
	// through the browser's key handler and has no row to name. @returns
	// whether a travel was started.
	travel(ref?: RowRef, target?: PaneTarget): boolean {
		const rep = this.targetOf(ref);
		if (rep < 0)
			return false;
		this.opts.onTravel(rep, target);
		return true;
	}

	// Point the list at a row: the ONE position, the highlight, and the
	// option a screen reader is told about. `walked` says whether the list
	// has to SHOW the row it arrived on (see reveal), which a redraw does not.
	private choose(ref: RowRef, walked = false): void {
		if (this.selected?.el !== ref.el) {
			this.selected?.el.removeClass('is-selected');
			this.selected?.el.setAttr('aria-selected', 'false');
		}
		this.selected = ref;
		ref.el.addClass('is-selected');
		ref.el.setAttr('aria-selected', 'true');
		this.reveal(ref.el, walked);
		this.opts.onActiveRow(ref.el.id);
	}

	// Put the row the position moved to where the reader can see it. A click
	// owes the row no more than being legible — the view belongs to the
	// reader and a click must not shove it. The keyboard walked to the row
	// with the reader's hand nowhere near the mouse, so there the list has
	// to show the STEP (see revealDelta).
	private reveal(el: HTMLElement, walked: boolean): void {
		const view = this.opts.list.getBoundingClientRect();
		// The browser's own minimal scroll answers both of the cases that are
		// not the walk's: a row a click landed on, and a list with no layout
		// to measure. It moves nothing while the row is in sight.
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

	// The NOTE ITSELF is standing over the rows (the app answered the hover):
	// take the rows' hint off it — open over the row, the note has said the
	// path, the aliases and the headings before it has finished drawing
	// itself. Nothing is REMEMBERED: whether a hint may speak is asked fresh
	// at the next hover (see tipsQuiet), so the rows get their voice back
	// the moment the preview is gone.
	hideTip(): void {
		this.tip.retract();
	}

	// The panel is going (see RecentFilesBrowser.destroy): the tooltip is
	// the one thing this class put OUTSIDE the panel's own element, and the
	// document listeners outlive every panel this class will ever draw.
	destroy(): void {
		this.tip.destroy();
		this.press?.destroy();
		this.unmark();
		this.doc.removeEventListener('pointerup', this.onLift);
		this.doc.removeEventListener('pointercancel', this.onLift);
		this.watched?.disconnect();
	}

	// The keyboard's walk: one row on, wrapping at either end. A step is
	// `walked`, so the list shows the STEP and not merely the row (see
	// reveal): it is the only move that would otherwise leave the mark
	// parked against the edge while every further step scrolled the notes
	// under it.
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
