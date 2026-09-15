import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import {
	NAME_COL_CAP_EM, NAME_COL_WIDTH_SHARE, TIME_COL_MAX, TIME_COL_MIN,
} from './constants';
import {
	formatRelativeTime, inFileScope, matchesNavFilter, mergeByLanding, splitHistorySegments,
} from './listing';
import { NavEntryDescription, baseName, rowTrail } from './model';
import { destinationKey } from './panes';

// The list of steps, and everything that belongs to a row: which entries it
// shows (the query and the file scope composed), how they collapse into one row
// per landing, the forward/back segments around the pinned card, the selection
// the keyboard walks, the measured name/age columns, and the pointer's hover
// (which selects a row, and asks for the whole-note preview from the name
// column alone — the one cell every row has).
//
// Two of the row's decisions are LIST-WIDE rather than per-row, because a column
// is only a column if it comes out the same on every line:
//  - the name column is measured from the rows that print it (fitNameColumn),
//    and a run of one file's landings prints that name ONCE — the rest of the
//    run leaves the cell blank (see renderChronological);
//  - the pane marker is a column and is reserved on every row while any row uses
//    it. The count is NOT: it rides with the file name (see row).
// The section chain always keeps its deepest level (see rowTrail).
//
// The list owns its rows and the two indices that point at them: `visible` (the
// stack indices on screen, in order) and `selected`/`previewed` (what the
// keyboard is on and what the landing panel describes). The browser follows
// those through callbacks — it never reaches into the rows.

export interface NavHistoryListOptions {
	// The list element, created by the browser.
	list: HTMLElement;
	// Whether this device drives the list with a finger instead of a pointer.
	mobile: boolean;
	// The history the rows are drawn from, as one snapshot.
	entries: NavHistoryEntry[];
	// The stack index rendered as the pinned card rather than as a row.
	currentIndex: number;
	// The id the browser gave the list element. Row option ids are built from
	// it, so they are unique in the document even with a second browser open
	// (see NavHistoryModal.listId) — aria-activedescendant has to name exactly
	// one row.
	listId: string;
	// The search box's current text.
	filter: () => string;
	// The file the list is narrowed to, or undefined for the whole history.
	scope: () => string | undefined;
	// One entry's display pieces (cached by the browser).
	describe: (rep: number) => NavEntryDescription;
	// Drop the per-render describe cache: the rows it described are gone.
	clearDescribeCache: () => void;
	// The heading chain an entry's landing sits in.
	trailFor: (entry: NavHistoryEntry, d: NavEntryDescription) => string[];
	// Which pane of a destination the entry belongs to, if it needs saying.
	paneName: (entry: NavHistoryEntry) => string | undefined;
	// What is pointed at changed: the landing panel redraws.
	onPointed: () => void;
	// The keyboard moved to another row, or off the list (undefined). The focus
	// never leaves the filter box — typing narrows the list from the same keys
	// that move through it — so this is what makes the current option audible:
	// the browser points the box's aria-activedescendant at the row id.
	onActiveRow: (id: string | undefined) => void;
	// The selection moved on a touch device: bring the panel into view.
	onRevealPanel: () => void;
	// The pointer entered a row's file name column: ask for the page preview.
	onRequestPreview: (ev: MouseEvent, row: HTMLElement, rep: number) => void;
	// The list scrolled: a popover anchored to a row's top edge must follow.
	onScroll: () => void;
	// A row was chosen with a pointing device: travel there.
	onTravel: (rep: number) => void;
}

export class NavHistoryList {
	// Representative stack indices in on-screen order (top to bottom).
	// Keyboard selection walks THIS, not the raw stack order.
	private visible: number[] = [];
	// Representative stack index → its row element, for selection highlight.
	private rowEls = new Map<number, HTMLElement>();
	// Nothing is selected on open: Enter has nothing to act on until the user
	// points at a row (arrows, or the pointer on a desktop).
	private selected = -1;
	// The row the landing panel describes. Driven by the keyboard selection AND
	// by pointer movement, so the two never disagree about what is being pointed
	// at; -1 = nothing pointed at, and the panel says so instead of guessing (a
	// missing entry can be previewed but never selected).
	private previewed = -1;
	// Pointer state for the native preview's trigger area: true while the pointer
	// sits on the pointed-at row's NAME column. Kept so the preview is asked for
	// on entering that column and not on every mousemove inside it.
	private nameHover = false;

	constructor(private opts: NavHistoryListOptions) {
		// Pointer movement is the only hover signal — see onHover.
		this.opts.list.addEventListener('mousemove', (ev) => this.onHover(ev));
		// Leaving the list ends the pointer's stay on the name column: coming
		// back to the same name must ask for the preview again.
		this.opts.list.addEventListener('mouseleave', () => {
			this.nameHover = false;
		});
		// A showing popover is anchored to a row's own top edge, so scrolling the
		// list moves the row out from under it (see the browser's preview bridge).
		this.opts.list.addEventListener('scroll', () => this.opts.onScroll());
	}

	// What the keyboard is on, or -1.
	get selection(): number {
		return this.selected;
	}

	// What the landing panel describes, or -1.
	get pointed(): number {
		return this.previewed;
	}

	// The row a stack index resolves to (a merged alias finds its row too).
	rowOf(rep: number): HTMLElement | undefined {
		return this.rowEls.get(rep);
	}

	// (Re)draw the rows; the toolbar/here-card/panel persist around them.
	render(): void {
		const keepSelected = this.selected;
		this.opts.list.empty();
		this.opts.clearDescribeCache();
		this.rowEls = new Map();
		this.visible = [];
		// The cells these flags described are gone with the old rows.
		this.nameHover = false;

		const query = this.opts.filter().trim();
		// The scope narrows on the file picked in the toolbar; a query narrows
		// on text. They compose — the answer to "where in this note did 'scroll'
		// come up" is the intersection, not either half. The text half covers
		// what the row prints (name, path, section chain, "L412") plus what the
		// entry recorded (the landing's context block, how a link got here).
		const path = this.opts.scope();
		// The row's own printed text, derived from the vault's heading cache
		// rather than carried by the entry, so the pure predicate takes it as an
		// argument (see matchesNavFilter). Built only while a query is up: an
		// unfiltered list never asks the heading cache for anything.
		const printed = (i: number): string => {
			const d = this.opts.describe(i);
			return `${d.line ?? ''} ${this.opts.trailFor(this.opts.entries[i], d).join(' ')}`;
		};
		const keep = (i: number) => {
			const entry = this.opts.entries[i];
			if (!inFileScope(entry, path))
				return false;
			return !query || matchesNavFilter(entry, query, printed(i));
		};
		const emitted = this.renderChronological(keep);

		if (emitted === 0)
			this.opts.list.createDiv({
				cls: 'position-restore-nav-empty',
				// Three different nothings: the query found nothing, the file
				// scope has nothing left to show, or there is no history at all.
				text: query
					? t('navHistory.noMatch')
					: path !== undefined
						? t('navHistory.scopeEmpty', baseName(path))
						: t('navHistory.empty'),
			});
		// The stack ceiling's footnote used to be appended here. It is gone on
		// purpose: the stack sits at its cap in ordinary use, so the line was
		// either permanent, or — at the foot of a list that only overflows once
		// the cap HAS bitten — permanently below the fold. Discards are silent.
		// A row the filter dropped is no longer on screen to be pointed at.
		if (this.previewed >= 0 && !this.rowEls.has(this.previewed))
			this.previewed = -1;
		// Re-apply the selection: the element it pointed at is gone.
		this.selected = -1;
		this.select(keepSelected);
		// The columns are sized from the rows on screen, and a filter leaves
		// different names and different ages on screen.
		this.fitColumns();
	}

	// Everything except the current entry, newest first, split into the
	// forward and back halves around it and collapsed by landing. The segment
	// headers count STEPS (what the back/forward buttons would do); the rows
	// count PLACES.
	private renderChronological(keep: (i: number) => boolean): number {
		const { forward, back } = splitHistorySegments(this.opts.entries, this.opts.currentIndex, keep);
		const blocks = [
			{ label: t('navHistory.seg.forward'), arrow: '→', indices: forward },
			{ label: t('navHistory.seg.back'), arrow: '←', indices: back },
		]
			.filter(block => block.indices.length > 0)
			.map(block => ({ ...block, rows: mergeByLanding(block.indices, (i) => this.mergeKey(i)) }));
		// ONE decision for the whole list, taken before a single row is drawn: the
		// small print is a strip of fixed columns, so a pane marker on any row has
		// to reserve its column on all of them or the coordinates stop lining up.
		// While no row has one — the ordinary case — nothing is reserved. (The
		// merge count is not part of this: it rides with the file name, so it
		// reserves nothing.)
		const paneColumn = blocks.some(b => b.rows.some(r => this.paneOf(r.indices[0]) !== undefined));
		let emitted = 0;
		for (const block of blocks) {
			this.segment(block.label, block.arrow, block.indices.length);
			// Which file the row above named. Reset per segment: the divider is a
			// break in the reading order, and a blank name under it would read as
			// a lost row rather than as "the same file as above".
			let lastName: string | undefined;
			for (const r of block.rows) {
				const key = this.nameKey(r.indices[0]);
				// A file that holds several landings names itself once (see row).
				// A DELETED file never does: its name carries the red warning, and
				// blanking it would hide that the step is dead.
				const sameFile = key !== undefined && key === lastName
					&& !this.opts.describe(r.indices[0]).missing;
				lastName = key;
				emitted += this.row(r.indices, paneColumn, sameFile);
			}
		}
		return emitted;
	}

	// Which pane holds a stack index's destination, if it needs saying (see
	// paneLabel): one lookup, used by both the reservation scan and the row.
	private paneOf(i: number): string | undefined {
		return this.opts.paneName(this.opts.entries[i]);
	}

	// What "the same file" means to the name column: the path, or the view type
	// for a pathless view step — two rows of the graph view would otherwise
	// repeat that label too.
	private nameKey(i: number): string | undefined {
		const entry = this.opts.entries[i];
		if (!entry)
			return undefined;
		return entry.kind === 'view' ? `view:${entry.viewType}` : entry.path;
	}

	// A merged row must never hide a reachable position, so the key carries
	// BOTH the leaf and the destination:
	//  - the leaf, because two panes of one file at the same line are different
	//    places, and merging them would make one of them unreachable;
	//  - the destination, because ONE tab walks from note to note and two
	//    different notes can sit on the same line number — keyed on "line|leaf"
	//    those two steps collapsed into a single row that named the newer note
	//    over the older one's place, leaving that place unreachable from the
	//    panel (destinationKey is the browser's own "which destination" spelling,
	//    the same one the pane marker keys live leaves by).
	// The caller merges each segment separately, which is what keeps a back entry
	// from being swallowed by a forward one at the same landing.
	private mergeKey(i: number): string | undefined {
		const d = this.opts.describe(i);
		if (d.line === undefined)
			return undefined;
		const entry = this.opts.entries[i];
		return `${d.line}|${entry.leafId}|${destinationKey(entry)}`;
	}

	// Direction divider for the chronological view. Decorative for the
	// accessibility tree (the rows say what they are; the arrow and the rule
	// would only be read as noise out of the listbox they sit in).
	private segment(label: string, arrow: string, count: number): void {
		const seg = this.opts.list.createDiv({ cls: 'position-restore-nav-segment' });
		seg.createSpan({ text: arrow, cls: 'nav-seg-arrow', attr: { 'aria-hidden': 'true' } });
		seg.createSpan({ text: `${label} · ${t('navHistory.seg.count', count)}` });
		seg.createDiv({ cls: 'nav-seg-line', attr: { 'aria-hidden': 'true' } });
	}

	// One row: a single entry, or several entries that landed on the same place.
	// What the row SAYS is the note and where in it, so those two sit together at
	// the front (file | section); the small print (×N, pane, coordinate, age) is
	// one block — a strip at the row's right edge on a pointing device, a second
	// line on a phone (see .nav-row-meta). Only what decides WHICH row goes here;
	// how the step was made (open/switch/link/outline) is confirmation, not
	// selection, and lives in the preview panel's head. The landing's own text is
	// deliberately NOT here either: as a second line it doubled the row height,
	// and beside the section it squeezed both into ellipses.
	// `paneColumn` is the list-wide reservation of the pane's column (see
	// renderChronological), and `sameFile` says the row above has already named
	// this note.
	// Returns 1 so callers can count what was drawn.
	private row(indices: number[], paneColumn: boolean, sameFile: boolean): number {
		const rep = indices[0];
		const entry = this.opts.entries[rep];
		const d = this.opts.describe(rep);
		const row = this.opts.list.createDiv({ cls: 'position-restore-nav-row' });
		if (d.missing) {
			// Rendered (the gap in the history is information) but never
			// selectable and never a jump target: jumping moves the stack
			// pointer while nothing can be restored.
			row.addClass('is-missing');
			row.setAttr('title', t('navHistory.disabledTip'));
		}

		row.dataset.rep = String(rep);
		// The row is an option of the list's listbox (see the browser's
		// setActiveRow for the other half of the wiring). The id is what the
		// filter box's aria-activedescendant points at, so it names exactly this
		// row; a merged row is one option and carries its representative index.
		row.setAttr('id', `${this.opts.listId}-row-${rep}`);
		row.setAttr('role', 'option');
		row.setAttr('aria-selected', 'false');
		if (d.missing)
			// Previewable but never selectable: said in the tree too, not only
			// in a tooltip a screen reader never shows.
			row.setAttr('aria-disabled', 'true');
		// A dead step is marked on the name itself: the type column that used
		// to carry "missing" is gone, and a row a click cannot reach must look
		// different from one it can.
		const file = row.createSpan({
			cls: `nav-row-file${d.missing ? ' is-missing' : ''}`,
		});
		// The note names itself ONCE per run of its own rows: a file holding
		// several landings would otherwise print the same name down the list
		// (see renderChronological), and the block reads as one note's places
		// instead of as N copies of one name. The rows after the first carry the
		// repeat mark instead (see below). The text stays IN the row — the
		// stylesheet clips it — so the option still names its file to a screen
		// reader, and the name column's width is measured from the rows that
		// print it.
		file.createSpan({
			text: d.file,
			cls: `nav-row-name${sameFile ? ' is-continuation' : ''}`,
		});
		// A row that follows its file's first row says so with a mark instead of
		// an empty cell: "this one belongs to the note above". ↳ (U+21B3) is the
		// continuation arrow a list UI uses everywhere, and — unlike a ditto mark
		// (〃), which would read as a typo to anyone not raised on it — it says the
		// same thing in every locale. Decorative: the clipped name in this very
		// cell still names the file to a screen reader.
		if (sameFile)
			file.createSpan({ text: '↳', cls: 'nav-row-repeat', attr: { 'aria-hidden': 'true' } });
		// How many steps this row stands for, right after the name it belongs to.
		// It used to be a column of its own in the small print, which reserved its
		// width on every row of the list and printed nothing on most of them. A
		// row that repeats the name above (see renderChronological) still prints
		// its OWN count: ×3 says how many steps landed HERE, which is this row's
		// fact and not the name's.
		if (indices.length >= 3)
			file.createSpan({ text: `×${indices.length}`, cls: 'nav-row-count' });

		// The section the landing sits in, deepest one or two levels: the coarse
		// index a reader matches against memory, and the second half of what the
		// row says. It follows the name immediately — a fixed-width name column
		// left a hole in the middle of every row with a short name.
		// The cell is created even when there is no section, and empty: the row
		// is a grid of tracks, so a missing element would let later cells slide
		// one track left. The levels are tagged so that the deepest one is the
		// last to give way when the column runs out of room (see styles.css).
		const trail = rowTrail(this.opts.trailFor(entry, d));
		const crumb = row.createSpan({ cls: 'nav-row-trail' });
		for (let i = 0; i < trail.length; i++) {
			if (i > 0)
				crumb.createSpan({ text: '›', cls: 'nav-trail-sep' });
			crumb.createSpan({
				text: trail[i],
				cls: i === trail.length - 1 ? 'nav-trail-deep' : 'nav-trail-seg',
			});
		}

		// The small print — which pane of the file this row came from, the
		// coordinate it lands on, and when: row identity rather than row content,
		// all of it faint, all of it in one element so that the two layouts can
		// place it as a block. (The count is not here: it rides with the name.)
		// On a pointing device it is a strip at the row's right edge, its cells
		// right-aligned inside it so they line up as columns down the list; on a
		// phone it is the row's second line (see styles.css). The pane cell is
		// created even when this row has no pane of its own, but ONLY while some
		// OTHER row does (`paneColumn`): reserved on every row it printed nothing
		// on the ordinary history and cost the row its width in quiet zone to do
		// it, so nothing is reserved until the badge is actually on screen — and
		// then every row reserves it, or the coordinates stop lining up.
		const meta = row.createDiv({ cls: 'nav-row-meta' });
		if (paneColumn) {
			const pane = meta.createSpan({ cls: 'nav-row-pane' });
			const paneLabel = this.paneOf(rep);
			if (paneLabel)
				pane.setText(paneLabel);
		}
		const pos = meta.createDiv({ cls: 'nav-row-pos' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		else
			pos.createSpan({ text: '—', cls: 'nav-row-nopos' });

		meta.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });

		if (!d.missing) {
			row.addEventListener('click', () => this.activate(rep));
			this.visible.push(rep);
		} else if (this.opts.mobile) {
			// A dead step stays inert as a jump target, but on a touch device the
			// tap has to be able to ask for its panel: that panel is where "this
			// file is gone" is written, and there is no hover to ask with. The
			// panel grows no jump button for it (see LandingPanel.render).
			row.addEventListener('click', () => this.activate(rep));
		}
		// Every merged alias resolves to this element, so a preview or a
		// selection that lands on a duplicate still finds its row.
		for (const i of indices)
			this.rowEls.set(i, row);
		return 1;
	}

	move(d: number): void {
		const n = this.visible.length;
		if (n === 0)
			return;
		if (this.selected === -1) {
			this.select(this.visible[d > 0 ? 0 : n - 1]);
			return;
		}
		const at = this.visible.indexOf(this.selected);
		this.select(this.visible[(at + d + n) % n]);
	}

	// Highlight + reveal the row holding stack index i, and point the preview
	// at it: the outline, the strip and Enter always describe the same row. A
	// hidden selection clears to -1 so the next arrow starts from an end.
	private select(i: number): void {
		const previous = this.selected;
		if (this.selected >= 0)
			this.rowEls.get(this.selected)?.removeClass('is-selected');
		this.selected = i >= 0 && this.visible.includes(i) ? i : -1;
		if (this.selected >= 0) {
			this.previewed = this.selected;
			const el = this.rowEls.get(this.selected);
			el?.addClass('is-selected');
			// Role and id are set once, at render; the flag is state.
			el?.setAttr('aria-selected', 'true');
			el?.scrollIntoView({ block: 'nearest' });
		}
		// The row left behind keeps its own flag honest — a move within one
		// render leaves the element in place, an arrow back to it must find it
		// unselected.
		if (previous >= 0 && previous !== this.selected)
			this.rowEls.get(previous)?.setAttr('aria-selected', 'false');
		this.opts.onActiveRow(this.selected >= 0
			? `${this.opts.listId}-row-${this.selected}`
			: undefined);
		this.opts.onPointed();
		// On touch the panel hangs BELOW that row (see LandingPanel.render), so
		// the row alone being on screen is not enough: the panel is where the
		// button that travels with a finger lives, and it must not open off the
		// bottom edge.
		if (this.opts.mobile && this.selected >= 0)
			this.opts.onRevealPanel();
	}

	// Real pointer movement over the list, hit-tested to a row. mouseenter is
	// deliberately NOT used: rows are rebuilt on every keystroke, and a
	// browser synthesises mouseenter for whatever lands under a stationary
	// pointer — which would steal the keyboard selection and silently
	// retarget Enter. Only movement the user actually made counts.
	// A touch device has no hover at all, and there this listener must stay out
	// of the way: a tap on the name column (the one part of a row that does
	// something a click does not) makes the WebView fire a mousemove before the
	// click, which pointed the panel at the row and asked the core page preview
	// for a popover — under the finger that opened it, so tapping that column
	// behaved nothing like tapping the rest of the row, and the synthesized
	// selection made the tap's click read as "close this row again". Touch drives
	// this panel with clicks alone.
	private onHover(ev: MouseEvent): void {
		if (this.opts.mobile)
			return;
		const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.position-restore-nav-row');
		const rep = row ? Number(row.dataset.rep) : NaN;
		if (!row || Number.isNaN(rep)) {
			// Off any row but still inside the list (a segment header, the
			// bottom padding): the pointer is no longer on the name column, so
			// coming back to it must ask for the preview again — the same re-arm
			// mouseleave does, but for moves that never leave the list.
			this.nameHover = false;
			return;
		}
		if (rep !== this.previewed) {
			this.previewed = rep;
			// The new row has not been pointed at yet: entering its name column
			// is what asks for a preview.
			this.nameHover = false;
			// A missing file cannot be selected (Enter must never target it), but
			// its row still previews — the panel is where "deleted" is explained.
			if (this.visible.includes(rep))
				this.select(rep);
			else
				this.opts.onPointed();
		}
		// The whole note is previewed from the NAME column alone: pointing at a
		// row selects it (and a click travels there), but throwing a whole-note
		// popover over the list every time the pointer crosses a row made the
		// list unusable for the scanning it is there for. The name is the one
		// cell EVERY row has — a row whose note has no headings (or whose landing
		// is above the first one) has nothing in the section column to point at,
		// and asking from the section alone left exactly those rows with no
		// preview at all. It is also a bounded target: the measured name column,
		// not the row's whole flexible middle.
		const onName = this.overName(ev, row);
		if (onName && !this.nameHover && this.visible.includes(rep))
			this.opts.onRequestPreview(ev, row, rep);
		this.nameHover = onName;
	}

	// Whether the pointer is over the file name column — the row's preview
	// target. Tested by X rather than by DOM containment: the cell is what the
	// pointer has to cross, and a stretch-filled grid item's box is exactly the
	// column a user sees.
	private overName(ev: MouseEvent, row: HTMLElement): boolean {
		const cell = row.querySelector<HTMLElement>('.nav-row-file');
		if (!cell)
			return false;
		const box = cell.getBoundingClientRect();
		return ev.clientX >= box.left && ev.clientX <= box.right;
	}

	// A row's tap/click. On a pointing device the click IS the choice, as it
	// always was. On a touch device every tap does exactly one thing, on every
	// row: it OPENS that row's landing under it, or CLOSES it again when the same
	// row is tapped twice — the panel is the only preview a touch device can get
	// (there is no hover), and a tap that could only ever open left the list with
	// no way back. Travel is the panel's own "jump here" button, so the gesture
	// never changes meaning under the finger.
	private activate(rep: number): void {
		if (this.opts.mobile) {
			if (this.selected === rep || this.previewed === rep) {
				// Closing: nothing is pointed at any more, which is what parks
				// the panel (see LandingPanel.render).
				this.previewed = -1;
				this.select(-1);
			} else if (this.visible.includes(rep)) {
				this.select(rep);
			} else {
				// A deleted step: previewable (that is where "file gone" is
				// explained) but never selectable, so Enter can never target it.
				this.previewed = rep;
				this.opts.onPointed();
			}
			return;
		}
		this.opts.onTravel(rep);
	}

	// One of the row's columns (the name's) is not sized by the stylesheet but
	// measured here, because a column that has to come out IDENTICAL on every row
	// cannot be sized by the content of one row: every row is its own grid, so
	// `max-content` would give each row its own width and the section would start
	// at a different x on each line. The age is measured for the same reason.
	fitColumns(): void {
		// The touch layout gives the name and the section a line of their own
		// (see styles.css), so there is no column to align and nothing to measure
		// on a phone.
		if (!this.opts.mobile)
			this.fitNameColumn();
		this.fitTimeColumn();
	}

	// The width of an element's TEXT — not of the element, which may already be
	// clipped by its own cap — in px. Range.getBoundingClientRect is missing in
	// jsdom, and there is no layout at all there, so 0 means "no measurement".
	private textWidth(el: HTMLElement): number {
		const range = document.createRange();
		range.selectNodeContents(el);
		if (typeof range.getBoundingClientRect !== 'function')
			return 0;
		return range.getBoundingClientRect().width;
	}

	// The name column is the widest name (and count) ON SCREEN: the section then
	// starts at the same x on every row, which is the column the eye runs down.
	// It has no floor — a list of one-word names gets a one-word column — but it
	// has two ceilings: the name's own cap (20em, see .nav-row-name) and a share
	// of the panel, so the section cannot be squeezed out entirely. The
	// measurement is of the TEXT, which may be longer than the box it is drawn
	// in, so without either one long title would push the section of every row
	// off the panel. Where there is no measurement at all the property is left
	// unset and the stylesheet's `max-content` fallback stands — never 0px, which
	// would erase the names.
	// A row whose name the sheet CLIPS (the same file as the row above) is
	// skipped: its box is a 1px sliver, and the text it repeats is already
	// measured on the row that prints it.
	// The FILE CELL is what is measured, not the name span: the ×N rides with the
	// name (see row), so the width the section may start after is the name the
	// row shows PLUS the count it carries — measure the name alone and the count
	// of the widest row would be the thing that gets clipped.
	private fitNameColumn(): void {
		let widest = 0;
		let cap = 0;
		// Scoped to ROWS: on touch the landing panel lives inside the list too,
		// and its own copies of these cells are not columns of it.
		for (const el of Array.from(this.opts.list.querySelectorAll<HTMLElement>('.position-restore-nav-row .nav-row-file'))) {
			if (el.querySelector('.nav-row-name.is-continuation'))
				continue;
			widest = Math.max(widest, this.textWidth(el));
			const size = parseFloat(window.getComputedStyle(el).fontSize);
			if (Number.isFinite(size))
				cap = Math.max(cap, size * NAME_COL_CAP_EM);
		}
		if (widest <= 0) {
			this.opts.list.style.removeProperty('--nav-name-col');
			return;
		}
		// 0 before the first layout (jsdom, or the frame the list is built in):
		// the share is simply not applied then.
		const share = this.opts.list.clientWidth * NAME_COL_WIDTH_SHARE;
		const width = Math.ceil(Math.min(widest, cap > 0 ? cap : widest, share > 0 ? share : widest));
		this.opts.list.style.setProperty('--nav-name-col', `${width}px`);
	}

	// The age column is as wide as the widest age ON SCREEN, not as wide as a
	// guess: the fixed 11ch track it replaces reserved 111px in the row's font,
	// which is more than twice what a Chinese label needs ("3 分钟前" is 50px) —
	// and because the age is right-aligned, every spare pixel of it showed up as
	// a gap between the coordinate and the time. Measuring keeps the column
	// uniform (so the ages and the whole small-print strip still line up as
	// columns) without reserving room nothing uses. Where there is no layout
	// engine at all (jsdom), the measurement reads 0 and the clamp's floor
	// stands.
	private fitTimeColumn(): void {
		let widest = 0;
		for (const el of Array.from(this.opts.list.querySelectorAll<HTMLElement>('.position-restore-nav-row .nav-row-time')))
			widest = Math.max(widest, this.textWidth(el));
		const width = Math.min(TIME_COL_MAX, Math.max(TIME_COL_MIN, Math.ceil(widest)));
		this.opts.list.style.setProperty('--nav-time-col', `${width}px`);
	}
}
