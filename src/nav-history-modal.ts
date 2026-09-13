import { App, Editor, FileView, HoverPopover, MarkdownView, Modal, Platform, TFile } from 'obsidian';
import { NavHistory } from './nav-history';
import { NavHistoryEntry, RECORDABLE_VIEW_TYPES, isMainAreaLeaf, leafIdOf } from './nav-entry';
import { EphemeralState } from './types';
import { t } from './i18n';

// The id this panel registers as a hover-link source (see main.ts). The core
// "Page preview" plugin keys its per-source options — including whether the Mod
// key is required — off this string, so both ends must agree on it.
export const HOVER_LINK_SOURCE_ID = 'position-restore-nav-history';

// Put on document.body while the browser is open. The core page preview mounts
// its popover on the body at var(--layer-popover) (30), i.e. BELOW a modal
// (var(--layer-modal) = 50) — see styles.css, which lifts it back above the
// dialog for exactly as long as this class is present.
const BODY_OPEN_CLASS = 'position-restore-nav-open';

// Where the native preview should put its left edge, in viewport coordinates:
// just right of the SECTION cell the pointer is on (see placePagePreview). The
// core plugin aligns a popover's left edge with its anchor's — the whole row —
// so left to itself this 450px panel starts at the row's far edge, up to half a
// panel away from the text the user is actually pointing at, and the hover-link
// payload has no field for the side. It recomputes that position on every show,
// so the only durable way to say where the popover goes is a CSS variable that
// styles.css reads with !important (which beats the inline style the plugin
// writes).
export const POPOVER_LEFT_VAR = '--position-restore-popover-left';

// Where it should put its TOP edge, in viewport coordinates: the pointed-at
// ROW's own top. The plugin hangs the popover under its anchor row (or bottom-
// anchors it above), so the panel reads as something that drifted away from the
// row it describes; the row's top edge keeps the two level, and styles.css'
// clamp only steps in when the window has no room for the whole preview.
export const POPOVER_TOP_VAR = '--position-restore-popover-top';

// Put on document.body for as long as the native popover is still building its
// preview (see holdPreview). styles.css keeps the popover invisible for exactly
// that long: the plugin draws the top of the note first and applies the landing
// scroll afterwards, so without the hold the user sees a flash of the file's
// opening lines before the preview jumps to the row's position.
export const POPOVER_PENDING_CLASS = 'is-preview-pending';

// How far right of the section cell the preview starts.
const POPOVER_GAP = 8;

// How long a preview may be held back waiting for its landing scroll to be
// applied. A file Obsidian never finishes laying out — or an empty one — would
// otherwise keep the popover invisible for good; past this it is shown as it is.
const REVEAL_DEADLINE_MS = 1200;

// The class the note renderer puts on the line it scrolled to (and flashes). Its
// arrival is the popover's "the landing is applied" signal — the only one the
// plugin offers from outside — and it is written by the same call that positions
// the preview, so the popover is complete by the time it appears.
const LANDING_MARK_CLASS = '.is-flashing';

// The field the core popover carries that Obsidian's typings omit: the element
// it was opened for (the row this browser handed it). The browser needs it to
// tell ITS popover from one still up for another row, and it is assigned by the
// plugin at runtime — hoverEl, the element the preview is rendered into, IS
// typed. Type-only, read-only: the cast never escapes.
type PopoverRuntime = HoverPopover & { targetEl?: HTMLElement | null };

// The display name of a path: its last segment. What a row labels itself with,
// and what the file-scope chip names (the full path is the row's hover title).
export function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

// One row's display pieces, derived from the entry. Pure (the vault lookup
// comes in as a predicate) so the history browser's labels are testable
// without a DOM.
export interface NavEntryDescription {
	file: string;
	title: string;
	type: string;
	line?: string;
	// The same landing line as a 0-based index (what the preview window reads,
	// and where `line` is computed from). `line` is the display form: "L412".
	lineIndex?: number;
	anchor?: string;
	missing: boolean;
	// An inferred entry (NavTeleport): the user did not deliberately jump
	// there — the badge renders dimmed to signal lower confidence.
	soft?: boolean;
}

// Which line a step lands on, and the text that goes with it (the row shows the
// number, the preview shows the text): a reading capture lands on the viewport
// top line (its remap anchor), an edit
// capture lands on the cursor line (its cursorAnchor — never the viewport
// top text, a different line; missing for blank cursor lines and legacy
// entries). An edit capture whose cursor sat OUTSIDE the viewport
// (cursorOffscreen — source-mode scrolling leaves the cursor behind) falls
// back to the viewport top line + anchor: the restore lands on the viewport,
// so that is where the user actually was. Line number semantics by capture
// mode (see NavEntryState.mode): a reading capture carries the editor's
// stale pre-preview cursor, so only the recorded mode disambiguates —
// pre-upgrade entries (no mode) fall back to the cursor-first heuristic.
export function describeNavEntry(
	entry: NavHistoryEntry,
	hasFile: (path: string) => boolean,
	savedPosition?: (path: string) => EphemeralState | undefined,
): NavEntryDescription {
	if (entry.kind === 'view') {
		return {
			file: t('navHistory.graphView'),
			title: entry.viewType,
			type: t('navHistory.type.graph'),
			missing: false,
		};
	}
	// Jump type from the entry kind; a keyless visit is an open by default
	// and a tab/pane activation when tagged (via: 'switch'). A teleport is
	// its own kind (an inferred move, not a deliberate jump).
	let type: string;
	if (entry.kind === 'jump') {
		if (entry.key.startsWith('outline:'))
			type = t('navHistory.type.outline');
		else
			type = t('navHistory.type.link');
	} else if (entry.kind === 'teleport') {
		type = t('navHistory.type.teleport');
	} else {
		type = entry.via === 'switch' ? t('navHistory.type.switch') : t('navHistory.type.open');
	}
	const st = entry.st;
	let n: number | undefined;
	let anchor: string | undefined;
	if (st) {
		if (st.mode === 'preview') {
			n = st.scroll;
			anchor = st.anchor;
		} else if (st.cursor && !st.cursorOffscreen) {
			n = st.cursor.from.line;
			anchor = st.cursorAnchor;
		} else {
			n = st.scroll;
			anchor = st.anchor;
		}
	} else {
		// The entry itself carries no position (a tab/pane activation
		// predating the leave-refresh, or a legacy persisted entry): fall
		// back to the file's saved record — the spot a reopen would restore,
		// which is exactly this step's "where I was". The record has no
		// anchor text, so the row shows the line number only.
		const saved = savedPosition?.(entry.path);
		n = saved?.cursor?.from.line ?? saved?.scroll;
		if (n === undefined && entry.kind === 'teleport')
			// A landing that never settled: the recorded target line is
			// still where the restore will aim.
			n = entry.line;
	}
	return {
		file: baseName(entry.path),
		title: entry.path,
		type,
		line: n !== undefined ? `L${n + 1}` : undefined,
		lineIndex: n,
		anchor,
		missing: !hasFile(entry.path),
		soft: entry.kind === 'teleport',
	};
}

// The section chain a landing sits in, built from the file's PARSED headings
// (metadataCache) rather than from its text: a row needs its section without —
// and long before — the preview's file read. Obsidian's own parser is what
// excludes headings inside fenced code or comments, so this agrees with the
// outline pane. (The cue keeps its own raw-text scan because it works from a
// live editor buffer, which can be ahead of the cache.)
export interface HeadingRef {
	heading: string;
	level: number;
	line: number;
}

// The chain of headings the line falls under, outermost first. A heading ON
// the line is included as the deepest segment: the chain names the target line
// rather than skipping to its parent section. `headings` is in document order,
// as the cache stores it.
export function headingTrailAtLine(headings: HeadingRef[] | undefined, line: number): string[] {
	if (!headings || !headings.length)
		return [];
	const stack: HeadingRef[] = [];
	for (const h of headings) {
		if (h.line > line)
			break;
		while (stack.length && stack[stack.length - 1].level >= h.level)
			stack.pop();
		stack.push(h);
	}
	return stack.map(h => h.heading);
}

// The chain as a ROW prints it: the deepest `depth` levels only (a row has one
// line of width), with the heading the landing line itself carries dropped —
// the row already quotes that text, so naming the section too would say the
// same thing twice.
export function rowTrail(trail: string[], landingText: string | undefined, depth = 2): string[] {
	const out = trail.slice();
	if (landingText !== undefined && out.length) {
		const line = normalizeHeadingText(landingText);
		if (line && normalizeHeadingText(out[out.length - 1]) === line)
			out.pop();
	}
	return out.slice(-depth);
}

function normalizeHeadingText(text: string): string {
	return text
		.replace(/^#{1,6}\s*/, '')
		.replace(/#+\s*$/, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

// What a destination is keyed by: the target path, or the view type for a
// pathless view entry. The pane marker keys its live leaves with the same
// vocabulary (see liveLeaves), so both ends must build the view key here.
export function viewDestinationKey(viewType: string): string {
	return `view:${viewType}`;
}

export function destinationKey(entry: NavHistoryEntry): string {
	return entry.kind === 'view' ? viewDestinationKey(entry.viewType) : entry.path;
}

// One displayed row: the stack indices it merges (newest first). A row is
// either a single entry or several entries that landed on the same place.
export interface NavEntryRow {
	indices: number[];
}

// Merge entries (newest-first stack indices) by landing position: the same
// place becomes one row carrying ×N. This is what keeps a long session's list
// scannable — bouncing between a note and its reference re-lands on the same
// spot over and over, and twenty identical rows say nothing the first one did
// not. Entries with no landing (landing() returns undefined — no recorded
// position) never merge; each keeps its own row.
export function mergeByLanding(
	indices: number[],
	landing: (index: number) => string | undefined,
): NavEntryRow[] {
	const rows: NavEntryRow[] = [];
	const byLanding = new Map<string, NavEntryRow>();
	for (const index of indices) {
		const key = landing(index);
		const existing = key !== undefined ? byLanding.get(key) : undefined;
		if (existing) {
			existing.indices.push(index);
			continue;
		}
		const row = { indices: [index] };
		if (key !== undefined)
			byLanding.set(key, row);
		rows.push(row);
	}
	return rows;
}

// Pure filter predicate for the search box: every whitespace-separated token
// must appear (case-insensitive) in the entry's own fields — file name, full
// path, and the landing/cursor anchor text. Reads the entry directly, never
// the DOM, so the browser's search is testable without a DOM.
export function matchesNavFilter(entry: NavHistoryEntry, query: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0)
		return true;
	let hay: string;
	if (entry.kind === 'view') {
		hay = `${entry.viewType} ${t('navHistory.graphView')}`;
	} else {
		const base = baseName(entry.path);
		hay = `${base} ${entry.path} ${entry.st?.anchor ?? ''} ${entry.st?.cursorAnchor ?? ''}`;
	}
	hay = hay.toLowerCase();
	return tokens.every(tok => hay.includes(tok));
}

// The file-scope filter (the picker's predicate): does the entry sit in the
// file the scope names? `path` is that file's path, or undefined for "all
// files" — then the scope is inert and lets everything through, so a stale
// choice can never blank the list. A view entry has no path, so it never
// matches a narrowed scope: the scope answers "where else in THIS note was I",
// and a graph step is not a place in a note.
export function inFileScope(entry: NavHistoryEntry, path: string | undefined): boolean {
	if (path === undefined)
		return true;
	return entry.kind !== 'view' && entry.path === path;
}

// One item of the scope picker: a note the history has been in, and how much of
// the history sits there. The count is STEPS, the unit the segment headers
// count in (see renderChronological) — it is what decides whether narrowing to
// this note is worth losing the rest of the list.
export interface HistoryFileOption {
	path: string;
	// What the item says: the last segment, exactly as a row names it.
	name: string;
	// The parent folder, set ONLY for a name that another option shares — two
	// notes called "index" in different folders are otherwise one item, and the
	// choice between them could not be made. Sparse rather than always-on
	// because the folder is long, faint, and usually the same on every item.
	folder?: string;
	count: number;
}

// The distinct files the history has been in. View entries (the graph) have no
// path and are skipped, as they are by every other file-scoped question (see
// inFileScope). Pure: what the picker offers is testable without a DOM.
export function historyFileOptions(entries: NavHistoryEntry[]): HistoryFileOption[] {
	const byPath = new Map<string, HistoryFileOption>();
	for (const entry of entries) {
		if (entry.kind === 'view')
			continue;
		const seen = byPath.get(entry.path);
		if (seen)
			seen.count++;
		else
			byPath.set(entry.path, { path: entry.path, name: baseName(entry.path), count: 1 });
	}
	const out = Array.from(byPath.values());
	// By NAME, not by recency. The panel answers "recently" twice already: the
	// pinned card and the direct "only this note" switch cover the note you are
	// in, and the list underneath is chronological with an age on every row. So
	// what is left for a picker is "the note called X" — a lookup, and a lookup
	// wants a position it can be found at TWICE, not a rank that moves every
	// time the note is visited. Alphabetical is also the one index the list
	// itself never shows. Folder order breaks a tie between same-named notes,
	// which are exactly the ones whose folders are on screen.
	out.sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
		|| a.path.localeCompare(b.path));
	const names = new Map<string, number>();
	for (const o of out)
		names.set(o.name, (names.get(o.name) ?? 0) + 1);
	for (const o of out) {
		if ((names.get(o.name) ?? 0) > 1) {
			const cut = o.path.lastIndexOf('/');
			o.folder = cut === -1 ? '/' : o.path.slice(0, cut);
		}
	}
	return out;
}

// A row's time label. This is the browser's PRIMARY index: a user recalls
// "the spot from a few minutes ago", not "three steps back" — which is why
// the old ±N step counter is gone. Beyond a week an absolute date is more
// useful than an ever-growing day count. Pure (now comes in) for testing.
export function formatRelativeTime(stamp: number, now: number = Date.now()): string {
	const minutes = Math.floor(Math.max(0, now - stamp) / 60000);
	if (minutes < 1)
		return t('navHistory.time.now');
	if (minutes < 60)
		return t('navHistory.time.minutes', minutes);
	const hours = Math.floor(minutes / 60);
	if (hours < 24)
		return t('navHistory.time.hours', hours);
	const days = Math.floor(hours / 24);
	if (days < 7)
		return t('navHistory.time.days', days);
	const d = new Date(stamp);
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

// The current entry is rendered as a pinned card, never as a list row, so the
// rest of the stack splits into the two directions around it: indices above
// the current entry are the FORWARD history, below it the BACK history. Both
// come back newest-first (what a user scans for). `keep` applies the filter.
export interface NavHistorySegments {
	forward: number[];
	back: number[];
}

export function splitHistorySegments(
	entries: NavHistoryEntry[],
	currentIndex: number,
	keep: (index: number) => boolean = () => true,
): NavHistorySegments {
	const forward: number[] = [];
	const back: number[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		if (i === currentIndex || !keep(i))
			continue;
		(i > currentIndex ? forward : back).push(i);
	}
	return { forward, back };
}

// The main area as the pane marker needs to see it: one record per MAIN-AREA
// leaf, in layout order, naming the destination that leaf currently shows.
// Built by the browser from the live workspace (NavHistoryModal.liveLeaves) and
// never from the history: a recorded leaf id keeps pointing at a tab after that
// tab has walked to another note ("this leaf also held that file") or after it
// has been closed, and a number derived from those claims named windows that
// were not there.
export interface LiveLeaf {
	leafId: string;
	key: string;
}

// Which live leaves hold each destination: leafId → its 1-based rank in layout
// order. One leaf per destination is the ordinary case and needs no marker; two
// or more is the case the marker exists for.
export interface PaneInfo {
	live: Map<string, Map<string, number>>;
}

export function paneInfo(live: LiveLeaf[]): PaneInfo {
	const out = new Map<string, Map<string, number>>();
	for (const { leafId, key } of live) {
		let byLeaf = out.get(key);
		if (!byLeaf) {
			byLeaf = new Map();
			out.set(key, byLeaf);
		}
		if (!byLeaf.has(leafId))
			byLeaf.set(leafId, byLeaf.size + 1);
	}
	return { live: out };
}

// Which of how many for a step, or undefined when there is nothing to
// disambiguate: fewer than two LIVE leaves hold its destination, or this step's
// leaf is not one of them (that tab has moved on to another note, or was
// closed). The number is a property of the current layout, looked up on every
// render — so it can never outlive the window it names, and it is never off by
// a tab the user cannot see.
export function paneLabel(
	info: PaneInfo,
	entry: NavHistoryEntry,
): { n: number; total: number } | undefined {
	const byLeaf = info.live.get(destinationKey(entry));
	if (!byLeaf || byLeaf.size < 2)
		return undefined;
	const n = byLeaf.get(entry.leafId);
	return n === undefined ? undefined : { n, total: byLeaf.size };
}

// One line of the landing preview. num is the 1-based line number as shown.
export interface PreviewLine {
	num: number;
	text: string;
	mark: boolean;
}

// The landing line plus `radius` lines either side, clamped to the document.
// Pure: the caller supplies the file's already-split lines.
export function previewWindow(lines: string[], lineIndex: number, radius = 1): PreviewLine[] {
	if (lines.length === 0)
		return [];
	const first = Math.max(0, lineIndex - radius);
	const last = Math.min(lines.length - 1, lineIndex + radius);
	const out: PreviewLine[] = [];
	for (let i = first; i <= last; i++)
		out.push({ num: i + 1, text: lines[i], mark: i === lineIndex });
	return out;
}

// A vault read for the preview is deferred this long: the strip follows the
// pointer, and a mouse sweep across rows must not queue a whole-file read per
// row passed over. Only a row the pointer actually rests on is worth reading.
const PREVIEW_READ_DELAY_MS = 120;
// How many notes' lines the preview keeps. Each entry is a whole file split
// into lines, so an unbounded cache pins every note visited in a session.
const PREVIEW_CACHE_MAX = 8;

// How many lines either side of the landing the preview shows. The preview is
// its own scrolling panel beside the list, so it no longer competes with the
// list for height: a context window deep enough to recognize a spot is now
// affordable, and the panel scrolls when even that is not enough.
const PREVIEW_RADIUS = 3;

// Above this many entries the modal pins its height and scrolls the list
// inside it (filtering must not resize and re-center the dialog). Below it
// the modal sizes to its content — a three-entry history in a 640px box was
// mostly dead space.
const FIXED_HEIGHT_MIN_ENTRIES = 12;

// The age column is sized from the labels actually on screen (see
// fitTimeColumn), clamped to these two pixel bounds: a floor so a list of
// "just now" rows does not collapse the column, and a ceiling equal to what
// the old fixed 11ch track reserved, so the fit can only ever take width back.
const TIME_COL_MIN = 40;
const TIME_COL_MAX = 112;

// The cap the name column is measured against (see fitNameColumn): the same
// 16em the name box itself carries in styles.css, so the column can never be
// wider than a name is allowed to be drawn.
const NAME_COL_CAP_EM = 16;

// …and the other cap, in share of the panel: however long the longest name is,
// the section column may not be squeezed out of existence by it. One long title
// in a narrow window would otherwise take the whole row (the small print keeps
// its fixed cells, the section collapses to nothing, and the list stops saying
// WHERE in the note each step was — the half of a row's meaning that is not the
// name). At the panel's usual width this never binds: 35% of 760px is 266px,
// above the 16em cap.
const NAME_COL_WIDTH_SHARE = 0.35;

// "Browse navigation history" modal. A destination picker, laid out around
// how a user actually gets lost:
//  - the CURRENT location is a pinned card at the top, so "you are here"
//    never scrolls out of view;
//  - the default list is CHRONOLOGICAL (newest first), split into forward and
//    back segments around the pinned card, each row labelled with a relative
//    time — the index a user remembers "where I was" by;
//  - Enter acts on the SELECTED row and on nothing else: going back one step
//    is the app's own back command (a hotkey on the desktop, a named command on
//    a phone), which needs no panel at all, and the entry it would reach is the
//    first row of the back segment anyway — visible, and showing where it
//    lands before the click commits to it;
//  - picking a spot is by RECOGNITION, never by retrieval, and that is what a
//    row's hover is for: on a pointing device it asks Obsidian's own page
//    preview for the whole note (see requestPagePreview), and on a touch device
//    — where there is no hover — the same information is a panel under the list,
//    with the tap-to-point model and a button to travel;
//  - the toolbar can narrow the list to matching text, and to ONE file: a
//    direct switch for the note the pinned card shows (the commonest pick, one
//    click), and a dropdown of every note the history has been in for the rest.
//    The two compose with the text filter, and the scope is what makes "where
//    in this note was I" askable at all;
//  - choosing an entry time-travels there (NavHistory.jumpTo): the target is
//    re-pushed on top, so back always returns to where you were.
// Repeat landings collapse into one row with a ×N count, so the list shows
// distinct places rather than distinct steps (the step count stays in the
// segment headers). A missing file's row is rendered but never selectable:
// jumping to it moves the stack pointer while nothing can be restored.
export class NavHistoryModal extends Modal {
	// Representative stack indices in on-screen order (top to bottom).
	// Keyboard selection walks THIS, not the raw stack order.
	private visible: number[] = [];
	// Representative stack index → its row element, for selection highlight.
	private rowEls = new Map<number, HTMLElement>();
	// Nothing is selected on open: Enter has nothing to act on until the user
	// points at a row (arrows, or the pointer on a desktop).
	private selected = -1;
	// The row the preview panel describes. Driven by the keyboard selection
	// AND by pointer movement, so the two never disagree about what is being
	// pointed at; -1 = nothing pointed at, and the panel says so instead of
	// guessing (a missing entry can be previewed but never selected).
	private previewed = -1;
	private filter = '';
	// The file the list is narrowed to, or undefined for the whole history.
	// This replaced a boolean "only this note" toggle: the same question —
	// "where else in this note was I" — generalized to any note the history has
	// been in, because the old chip could only ever mean the note the pinned
	// card shows. Off by default, because the question this panel is opened
	// with is usually "where was I", not "where in this note was I". Not called
	// `scope`: Modal already owns that name for its keymap scope, and shadowing
	// it does not typecheck.
	private scopeTo: string | undefined = undefined;
	// The scope picker: the direct switch, the chip, its dropdown, and the items
	// in it. The switch exists independently of the chip (a current note is a
	// file, whether or not the rest of the history has any).
	private scopeToggle?: HTMLElement;
	private scopeBox?: HTMLInputElement;
	private scopeButton?: HTMLButtonElement;
	private scopeLabel?: HTMLElement;
	private scopeMenu?: HTMLElement;
	private scopeItems: { path: string | undefined; el: HTMLElement }[] = [];
	// Which item the keyboard is on, and whether the menu is up (see onKeyDown:
	// while it is, the menu owns the arrow keys, Enter and Escape).
	private scopeActive = 0;
	private scopeOpen = false;
	private listEl!: HTMLElement;
	private hereEl!: HTMLElement;
	private previewEl!: HTMLElement;
	// Where the preview panel waits when it has no row to open under (touch).
	private previewHost!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private panes: PaneInfo = { live: new Map() };
	// Per-render describe cache: filtering re-renders on every keystroke, so
	// the vault lookups behind describeNavEntry are not repeated per row.
	private descCache = new Map<number, NavEntryDescription>();
	// Preview line cache: path → lines, or null when unreadable. undefined
	// (absent) means "not read yet". Bounded by PREVIEW_CACHE_MAX, oldest
	// first, so a long session cannot pin note after note in memory.
	private lines = new Map<string, string[] | null>();
	private reading = new Set<string>();
	// path → the file's parsed headings. Cheap to hold (tens of small records)
	// and otherwise re-mapped on every row render.
	private headings = new Map<string, HeadingRef[] | undefined>();
	private readTimer: number | undefined;
	private readPath = '';
	private closed = false;
	// Touch devices have no hover at all, so the pointer's "point at a row" and
	// its "go there" are the same gesture. Read once, here: the tap semantics
	// below are the only thing that branches on it.
	private mobile = Platform.isMobile;
	// Pointer state for the native preview's trigger area: true while the pointer
	// sits on the pointed-at row's SECTION column. Kept so the preview is asked
	// for on entering that column and not on every mousemove inside it.
	private trailHover = false;
	// Where the core "Page preview" plugin parks the popover it shows for us
	// (the HoverParent contract). Declared because Obsidian's Modal is not a
	// HoverParent in its own typings, even though the plugin assigns this field
	// at runtime and reads it back to hide its own popover.
	hoverPopover: HoverPopover | null = null;
	// The animation frame that watches a held-back preview for its landing (see
	// holdPreview). One at a time: a new hover supersedes the previous wait.
	private revealWatch: number | undefined;

	constructor(
		app: App,
		private nav: NavHistory,
		private savedPosition?: (path: string) => EphemeralState | undefined,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		// The landing panel is touch-only (see renderPreview): a pointing device
		// has the native page preview instead. One flag, so the class and the
		// rendering decision can never disagree.
		this.modalEl.toggleClass('is-touch', this.mobile);
		// The native page preview we ask for from a row would otherwise render
		// behind this dialog (see BODY_OPEN_CLASS).
		document.body.addClass(BODY_OPEN_CLASS);
		// A resting place for the preview's edges: without a value the
		// stylesheet's clamp would pin the first popover to the window's corner
		// before any row has been pointed at.
		this.placePagePreview(null);
		// The modal is sized in % of the window, so a resize moves the rows the
		// preview is placed against; the core plugin re-runs its own placement
		// on resize, and this keeps OUR coordinate in step with it.
		window.addEventListener('resize', this.onWindowResize);
		// Pin the height once the list overflows, so filtering can't resize
		// the modal and shift it vertically (see styles.css is-fixed).
		this.modalEl.toggleClass('is-fixed', this.nav.entries.length > FIXED_HEIGHT_MIN_ENTRIES);
		this.titleEl.setText(t('navHistory.overview.name'));
		// One keydown listener on the modal covers both the filter input and
		// the list: while typing, arrows navigate and Enter jumps (the input
		// would otherwise move its caret); Escape stays native (closes).
		this.modalEl.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		this.toolbar();
		// A click anywhere else in the panel puts the scope menu away — the
		// filter box, a row, the card. The chip and its items are inside the
		// wrapper, so this cannot fight the click that opened the menu.
		this.modalEl.addEventListener('click', (ev) => {
			const el = ev.target as HTMLElement | null;
			if (!el?.closest?.('.position-restore-nav-scope'))
				this.closeScopeMenu();
		});
		this.hereEl = this.contentEl.createDiv({ cls: 'position-restore-nav-here' });
		// The list, and the landing panel. It starts out beside the list, but on
		// a touch device it does not stay there: it opens UNDER the selected row,
		// inside the list's own scroll (see renderPreview) — a panel parked at
		// the bottom of the dialog runs out of room the moment there is history
		// to scroll, and then the one control that can travel with a finger (its
		// "jump here" button) is off-screen.
		const body = this.contentEl.createDiv({ cls: 'position-restore-nav-body' });
		this.listEl = body.createDiv({ cls: 'position-restore-nav-list' });
		// Pointer movement is the only hover signal — see onListHover.
		this.listEl.addEventListener('mousemove', (ev) => this.onListHover(ev));
		// Leaving the list ends the pointer's stay on the section column: coming
		// back to the same section must ask for the preview again.
		this.listEl.addEventListener('mouseleave', () => {
			this.trailHover = false;
		});
		// The popover is anchored to the row's own top edge (see
		// placePagePreview), so scrolling the list while one is up moves the row
		// out from under it. Only re-placed while a popover is actually showing:
		// otherwise this would write the body's style on every wheel tick.
		this.listEl.addEventListener('scroll', () => {
			const target = this.shownPopover()?.targetEl;
			if (target)
				this.placePagePreview(target);
		});
		this.previewEl = body.createDiv({ cls: 'position-restore-nav-preview' });
		// Where the panel waits while it has no row to open under.
		this.previewHost = body;
		this.render();
		// A touch device raises its on-screen keyboard the moment an input takes
		// focus, and the keyboard covers half of a small screen — the panel's
		// whole reason for being is the list under it. So on touch the box stays
		// unfocused (one tap away, when the user actually means to type); on a
		// pointing device the keyboard costs nothing and typing is the fastest
		// way through the list, so it keeps the focus.
		if (!this.mobile && this.nav.entries.length > 0)
			this.filterInput.focus();
	}

	onClose() {
		this.closed = true;
		this.cancelRead();
		this.revealPreview();
		document.body.removeClass(BODY_OPEN_CLASS);
		document.body.style.removeProperty(POPOVER_LEFT_VAR);
		document.body.style.removeProperty(POPOVER_TOP_VAR);
		window.removeEventListener('resize', this.onWindowResize);
	}

	private onWindowResize = (): void => {
		this.placePagePreview(this.rowEls.get(this.previewed) ?? null);
		// The labels did not change with the window, but their font may have.
		this.fitColumns();
	};

	// One of the row's columns (the name's) is not sized by the stylesheet but
	// measured here, because a column that has to come out IDENTICAL on every row
	// cannot be sized by the content of one row: every row is its own grid, so
	// `max-content` would give each row its own width and the section would start
	// at a different x on each line. The age is measured for the same reason.
	private fitColumns(): void {
		// The touch layout gives the name and the section a line of their own
		// (see styles.css), so there is no column to align and nothing to measure
		// on a phone.
		if (!this.mobile)
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

	// The name column is the widest name ON SCREEN: the section then starts at
	// the same x on every row, which is the column the eye runs down. It has no
	// floor — a list of one-word names gets a one-word column — but it has two
	// ceilings: the name's own cap (16em, see .nav-row-name) and a share of the
	// panel, so the section cannot be squeezed out entirely. The measurement is
	// of the TEXT, which may be longer than the box it is drawn in, so without
	// either one long title would push the section of every row off the panel.
	// Where there is no measurement at all the property is left unset and the
	// stylesheet's `max-content` fallback stands — never 0px, which would erase
	// the names.
	private fitNameColumn(): void {
		let widest = 0;
		let cap = 0;
		// Scoped to ROWS: on touch the landing panel lives inside the list too,
		// and its own copies of these cells are not columns of it.
		for (const el of Array.from(this.listEl.querySelectorAll<HTMLElement>('.position-restore-nav-row .nav-row-name'))) {
			widest = Math.max(widest, this.textWidth(el));
			const size = parseFloat(window.getComputedStyle(el).fontSize);
			if (Number.isFinite(size))
				cap = Math.max(cap, size * NAME_COL_CAP_EM);
		}
		if (widest <= 0) {
			this.listEl.style.removeProperty('--nav-name-col');
			return;
		}
		// 0 before the first layout (jsdom, or the frame the list is built in):
		// the share is simply not applied then.
		const share = this.listEl.clientWidth * NAME_COL_WIDTH_SHARE;
		const width = Math.ceil(Math.min(widest, cap > 0 ? cap : widest, share > 0 ? share : widest));
		this.listEl.style.setProperty('--nav-name-col', `${width}px`);
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
		for (const el of Array.from(this.listEl.querySelectorAll<HTMLElement>('.position-restore-nav-row .nav-row-time')))
			widest = Math.max(widest, this.textWidth(el));
		const width = Math.min(TIME_COL_MAX, Math.max(TIME_COL_MIN, Math.ceil(widest)));
		this.listEl.style.setProperty('--nav-time-col', `${width}px`);
	}

	// Tell the stylesheet where the native preview goes: its LEFT edge just right
	// of the section cell the pointer is on — the column a row's hover preview
	// belongs to, and the part a reader points at to confirm a spot — and its TOP
	// edge level with the row itself, both in viewport coordinates. The plugin's
	// own placement aligns the popover with the whole row and hangs it below, so
	// a row whose section sits at the panel's left put the preview half a panel
	// down and to the right of the text being pointed at. No row (before any
	// hover, or after a filter dropped the pointed-at one) → the dialog itself is
	// the resting anchor.
	private placePagePreview(row?: HTMLElement | null): void {
		const anchor = row ?? this.modalEl;
		const cell = row?.querySelector<HTMLElement>('.nav-row-trail') ?? anchor;
		document.body.style.setProperty(POPOVER_LEFT_VAR, `${cell.getBoundingClientRect().right + POPOVER_GAP}px`);
		document.body.style.setProperty(POPOVER_TOP_VAR, `${anchor.getBoundingClientRect().top}px`);
	}

	private onKeyDown(ev: KeyboardEvent): void {
		// While the scope menu is up it owns the same keys the list does. The
		// selection behind an overlay must not move where the user cannot see
		// it, Enter must pick the menu's item, and Escape must put the MENU away
		// rather than the whole panel — the modal's Escape is the app's own
		// keymap on document, so stopping the event here is what keeps this
		// dialog open for one more look at the list.
		if (this.scopeOpen) {
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
				ev.preventDefault();
				this.moveScopeActive(ev.key === 'ArrowDown' ? 1 : -1);
				return;
			}
			if (ev.key === 'Enter') {
				// An item the user tabbed to handles its own Enter (a focused
				// button fires click); the active item is for the case where the
				// focus is still on the chip.
				if ((ev.target as HTMLElement | null)?.closest?.('.nav-scope-item'))
					return;
				ev.preventDefault();
				this.pickScope(this.scopeItems[this.scopeActive]?.path);
				return;
			}
			if (ev.key === 'Escape') {
				ev.preventDefault();
				ev.stopPropagation();
				this.closeScopeMenu();
				return;
			}
			// A key that EDITS text means the user has decided to type a filter
			// rather than pick a file: the menu gets out of the way and the key
			// lands in the box (which openScopeMenu left focused).
			if (ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Delete') {
				if (!ev.ctrlKey && !ev.metaKey && !ev.altKey)
					this.closeScopeMenu();
			}
		}
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.move(-1);
		} else if (ev.key === 'Enter') {
			// The selection is the whole story: with nothing pointed at, Enter has
			// nothing to do. (It used to fall back to "go back one step", which
			// made one key mean two things depending on whether the pointer had
			// crossed a row — and duplicated the app's own back command.)
			if (this.selected < 0)
				return;
			ev.preventDefault();
			this.jump(this.selected);
		}
	}

	// The toolbar is built once (not per render), so the filter input keeps
	// its focus and caret while typing re-renders the list underneath.
	private toolbar(): void {
		const bar = this.contentEl.createDiv({ cls: 'position-restore-nav-toolbar' });
		const input = bar.createEl('input', {
			type: 'text',
			cls: 'position-restore-nav-filter',
			attr: { placeholder: t('navHistory.searchPlaceholder') },
		});
		input.addEventListener('input', () => {
			this.filter = input.value;
			// The list, the card's age and the panel all follow the filter, so the
			// whole body re-renders (the toolbar does not).
			this.render();
		});
		this.filterInput = input;
		// The file scope sits beside the search box: "where else in this note
		// was I" is a question the chronological list answers badly, since a
		// handful of cross-file hops buries a note's own landings.
		//
		// TWO controls, ONE state. The switch is the shortcut that was always
		// here — the note the pinned card shows, in one click, and still the
		// commonest pick by far. The picker generalizes it to any note the
		// history has been in, which is what the panel could not answer before.
		// They can never disagree: the switch is checked exactly while the scope
		// IS that note (see syncScopeChip), and picking that note in the menu
		// checks it.
		this.buildScopeToggle(bar);
		this.buildScopePicker(bar);
		this.syncScopeChip();
		// What the panel can be driven by is the whole difference between the two
		// devices: a keyboard on one, a finger on the other.
		bar.createSpan({
			cls: 'position-restore-nav-hint',
			text: t(this.mobile ? 'navHistory.touchHint' : 'navHistory.keyboardHint'),
		});
	}

	// The one-click switch to the current note: the file-scope chip's original
	// meaning, kept as a control of its own so the commonest pick never costs a
	// menu. Its label names the ACTION, as it always did (a fixed string keeps
	// the chip's width off the length of a note name); which note that is comes
	// from the tooltip and from the pinned card below.
	private buildScopeToggle(bar: HTMLElement): void {
		const home = this.scopePath();
		if (home === undefined)
			return;
		const label = bar.createEl('label', {
			cls: 'position-restore-nav-toggle',
			title: t('navHistory.onlyThisFileTip', home),
		});
		const box = label.createEl('input', { type: 'checkbox' });
		label.createSpan({ text: t('navHistory.onlyThisFile') });
		box.addEventListener('change', () => {
			// Checked means "only this note"; unchecked means "no scope at all".
			// From a scope on another note the box is already unchecked, so one
			// click lands on this note — which is what its label promises.
			this.pickScope(box.checked ? home : undefined);
		});
		this.scopeToggle = label;
		this.scopeBox = box;
	}

	// The scope chip and its dropdown, built once with the toolbar: the history
	// cannot change while the panel is open (only jump() moves the stack
	// pointer, and it closes first), so the item list is a snapshot — which is
	// what lets the chip's label be derived from it, as scopePath does.
	// "All files" is always the first item, so the chip can always say what it
	// is showing and a narrowed list always has a way back.
	private buildScopePicker(bar: HTMLElement): void {
		const files = historyFileOptions(this.nav.entries);
		if (files.length === 0)
			return;

		const wrap = bar.createDiv({ cls: 'position-restore-nav-scope' });
		this.scopeButton = wrap.createEl('button', {
			cls: 'position-restore-nav-scope-btn',
			attr: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
		});
		this.scopeLabel = this.scopeButton.createSpan({ cls: 'nav-scope-label' });
		this.scopeButton.createSpan({ cls: 'nav-scope-caret', text: '▾' });
		this.scopeButton.addEventListener('click', () => this.toggleScopeMenu());
		const menu = wrap.createDiv({
			cls: 'position-restore-nav-scope-menu is-closed',
			attr: { role: 'listbox' },
		});
		this.scopeMenu = menu;

		const add = (path: string | undefined, label: string, folder?: string, count?: number) => {
			const item = menu.createEl('button', {
				cls: 'nav-scope-item',
				attr: { type: 'button', role: 'option' },
			});
			item.createSpan({ text: label, cls: 'nav-scope-item-name' });
			if (folder)
				item.createSpan({ text: folder, cls: 'nav-scope-item-folder' });
			// Zero is left off rather than printed: it is not a selling point,
			// and the empty list it leads to says the same thing better.
			if (count)
				item.createSpan({ text: t('navHistory.scope.count', count), cls: 'nav-scope-item-count' });
			item.addEventListener('click', () => this.pickScope(path));
			this.scopeItems.push({ path, el: item });
		};

		add(undefined, t('navHistory.scope.all'));
		// …and the notes themselves, sorted by name (see historyFileOptions).
		// The note the pinned card shows is in this list like any other: the
		// switch beside the chip is its shortcut, and picking it here just sets
		// the same scope. The count is the list the pick will show, so the
		// current note's own step — the card, never a row — is not counted.
		const home = this.scopePath();
		menu.createDiv({ cls: 'nav-scope-sep' });
		for (const f of files)
			add(f.path, f.name, f.folder, f.count - (f.path === home ? 1 : 0));
	}

	// Point both controls at the scope the list is showing. Scoped, the chip's
	// label takes the normal text colour (its own class, in styles.css) so a
	// narrowed list has a visible cause.
	private syncScopeChip(): void {
		// The switch is the same state seen from the current note's side: checked
		// exactly while the scope IS the note the pinned card shows.
		const home = this.scopePath();
		if (this.scopeBox && this.scopeToggle) {
			const on = home !== undefined && this.scopeTo === home;
			this.scopeBox.checked = on;
			this.scopeToggle.toggleClass('is-active', on);
		}
		if (!this.scopeButton || !this.scopeLabel || !this.scopeMenu)
			return;
		const scoped = this.scopeTo !== undefined;
		this.scopeLabel.setText(scoped ? baseName(this.scopeTo as string) : t('navHistory.scope.all'));
		this.scopeButton.toggleClass('is-active', scoped);
		this.scopeButton.setAttr('title', scoped
			? t('navHistory.onlyThisFileTip', this.scopeTo as string)
			: t('navHistory.scope.pick'));
		this.scopeActive = this.scopeIndexOf();
		this.markScopeActive();
	}

	// Which item stands for the current scope: "all files" (0) when nothing is
	// scoped.
	private scopeIndexOf(): number {
		const at = this.scopeItems.findIndex(it => it.path === this.scopeTo);
		return at === -1 ? 0 : at;
	}

	private markScopeActive(): void {
		this.scopeItems.forEach((it, i) => {
			const on = i === this.scopeActive;
			it.el.toggleClass('is-active', on);
			it.el.setAttr('aria-selected', on ? 'true' : 'false');
		});
		this.scopeItems[this.scopeActive]?.el.scrollIntoView({ block: 'nearest' });
	}

	private toggleScopeMenu(): void {
		if (this.scopeOpen)
			this.closeScopeMenu();
		else
			this.openScopeMenu();
	}

	private openScopeMenu(): void {
		if (!this.scopeMenu || !this.scopeButton)
			return;
		this.scopeOpen = true;
		this.scopeMenu.removeClass('is-closed');
		this.scopeButton.setAttr('aria-expanded', 'true');
		// The keyboard starts on the scope the list already shows, so ↓ walks
		// away from where the user is rather than from the top of the list.
		this.scopeActive = this.scopeIndexOf();
		this.markScopeActive();
		// The filter box keeps the keyboard: typing is how the list underneath is
		// narrowed, and the modal's keydown handler routes ↓/↑/Enter to the menu
		// while it is open (see onKeyDown). A touch device is left alone —
		// taking the focus there raises the on-screen keyboard over the list.
		if (!this.mobile)
			this.filterInput.focus();
	}

	private closeScopeMenu(): void {
		if (!this.scopeOpen || !this.scopeMenu || !this.scopeButton)
			return;
		this.scopeOpen = false;
		this.scopeMenu.addClass('is-closed');
		this.scopeButton.setAttr('aria-expanded', 'false');
	}

	private moveScopeActive(d: number): void {
		const n = this.scopeItems.length;
		if (n === 0)
			return;
		this.scopeActive = (this.scopeActive + d + n) % n;
		this.markScopeActive();
	}

	// Choosing an item NARROWS the list to that file; it does not travel there.
	// A file holds several landings and which one is the entire question the
	// list is on screen to answer — a jump here would both guess and close the
	// panel before the user could look. Picking the scope already in force just
	// puts the menu away.
	private pickScope(path: string | undefined): void {
		this.closeScopeMenu();
		// The search box is this toolbar's keyboard surface and the modal's
		// keydown handler routes every key through the modal: a click that
		// narrows the list must not cost the user the ability to keep typing in
		// it. On touch, though, taking the focus IS the cost — it raises the
		// on-screen keyboard over the list the user is narrowing.
		if (!this.mobile)
			this.filterInput.focus();
		if (path === this.scopeTo)
			return;
		this.scopeTo = path;
		this.syncScopeChip();
		this.render();
	}

	// The pinned card's file: the scope its own picker item means. A view step
	// (the graph) has none, and then that item is simply not offered. The
	// current entry cannot change while the modal is open (only jump() moves
	// the pointer, and it closes first), so this is stable for the modal's
	// lifetime — which is why the picker's contents can be built once, with the
	// rest of the toolbar.
	private scopePath(): string | undefined {
		const entry = this.nav.entries[this.nav.index];
		return entry && entry.kind !== 'view' ? entry.path : undefined;
	}

	private hasFile = (path: string): boolean =>
		this.app.vault.getAbstractFileByPath(path) instanceof TFile;

	private describe(i: number): NavEntryDescription {
		let d = this.descCache.get(i);
		if (!d) {
			d = describeNavEntry(this.nav.entries[i], this.hasFile, this.savedPosition);
			this.descCache.set(i, d);
		}
		return d;
	}

	private render(): void {
		this.panes = paneInfo(this.liveLeaves());
		// The list first (it rebuilds rows, the selection and the panel), then the
		// card and the panel around it.
		this.renderList();
		this.renderHere();
		this.renderPreview();
	}

	// The pinned "you are here" card: the one entry the list never shows. It is
	// an INDICATOR, not a control: it used to be tappable (to go back one step on
	// touch, to re-apply the current position on a desktop), and neither earned
	// its place — going back one step is the app's own back command, which needs
	// no panel at all, and re-applying where you already are is what closing the
	// dialog does. Both cost a hint line over the list.
	private renderHere(): void {
		const card = this.hereEl;
		card.empty();
		const entry = this.nav.entries[this.nav.index];
		if (!entry)
			return;
		const d = this.describe(this.nav.index);
		const head = card.createDiv({ cls: 'nav-here-head' });
		head.createSpan({ text: `● ${t('navHistory.current')}`, cls: 'nav-here-title' });
		head.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });
		const main = card.createDiv({ cls: 'nav-here-main' });
		main.createSpan({ text: d.file, cls: 'nav-row-file' });
		if (d.line)
			main.createSpan({ text: d.line, cls: 'nav-row-line' });
		if (d.anchor)
			main.createSpan({ text: `“${d.anchor}”`, cls: 'nav-here-anchor' });
	}

	// (Re)draw the list only; the toolbar/here-card/preview persist around it.
	private renderList(): void {
		const keepSelected = this.selected;
		this.listEl.empty();
		this.descCache.clear();
		this.rowEls = new Map();
		this.visible = [];
		// The cells these flags described are gone with the old rows.
		this.trailHover = false;

		const query = this.filter.trim();
		// The scope narrows on the file picked in the toolbar; a query narrows
		// on text. They compose — the answer to "where in this note did 'scroll'
		// come up" is the intersection, not either half.
		const path = this.scopeTo;
		const keep = (i: number) =>
			inFileScope(this.nav.entries[i], path)
			&& (!query || matchesNavFilter(this.nav.entries[i], query));
		const emitted = this.renderChronological(keep);

		if (emitted === 0)
			this.listEl.createDiv({
				cls: 'position-restore-nav-empty',
				// Three different nothings: the query found nothing, the file
				// scope has nothing left to show, or there is no history at all.
				text: query
					? t('navHistory.noMatch')
					: path !== undefined
						? t('navHistory.scopeEmpty', baseName(path))
						: t('navHistory.empty'),
			});
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
		const { forward, back } = splitHistorySegments(this.nav.entries, this.nav.index, keep);
		let emitted = 0;
		if (forward.length) {
			this.segment(t('navHistory.seg.forward'), '→', forward.length);
			for (const r of mergeByLanding(forward, (i) => this.mergeKey(i)))
				emitted += this.row(r.indices);
		}
		if (back.length) {
			this.segment(t('navHistory.seg.back'), '←', back.length);
			for (const r of mergeByLanding(back, (i) => this.mergeKey(i)))
				emitted += this.row(r.indices);
		}
		return emitted;
	}

	// A merged row must never hide a reachable position, so the key carries
	// the leaf: two panes of one file at the same line are different places,
	// and merging them would make one of them unreachable from the panel. The
	// caller merges each segment separately, which is what keeps a back entry
	// from being swallowed by a forward one at the same landing.
	private mergeKey(i: number): string | undefined {
		const d = this.describe(i);
		return d.line === undefined ? undefined : `${d.line}|${this.nav.entries[i].leafId}`;
	}

	// Direction divider for the chronological view.
	private segment(label: string, arrow: string, count: number): void {
		const seg = this.listEl.createDiv({ cls: 'position-restore-nav-segment' });
		seg.createSpan({ text: arrow, cls: 'nav-seg-arrow' });
		seg.createSpan({ text: `${label} · ${t('navHistory.seg.count', count)}` });
		seg.createDiv({ cls: 'nav-seg-line' });
	}

	// The heading chain the entry's landing sits in. Empty for a view entry, a
	// deleted file, or an entry with no recorded line.
	private trailFor(entry: NavHistoryEntry, d: NavEntryDescription): string[] {
		if (entry.kind === 'view' || d.missing || d.lineIndex === undefined)
			return [];
		return headingTrailAtLine(this.headingsFor(entry.path), d.lineIndex);
	}

	// The file's parsed headings, mapped once per path. A file Obsidian has
	// not parsed yet simply has no section chain (the preview's own read still
	// shows its lines).
	private headingsFor(path: string): HeadingRef[] | undefined {
		if (this.headings.has(path))
			return this.headings.get(path);
		const file = this.app.vault.getAbstractFileByPath(path);
		const cache = file instanceof TFile ? this.app.metadataCache?.getFileCache?.(file) : null;
		const refs = cache?.headings?.map(h => ({
			heading: h.heading,
			level: h.level,
			line: h.position.start.line,
		}));
		this.headings.set(path, refs);
		return refs;
	}

	// Which live tab/pane an entry belongs to, or undefined when there is
	// nothing to disambiguate (see paneLabel). It belongs on the row because two
	// tabs of one file are otherwise identical rows — and telling those apart is
	// what decides which row to pick — but it is only ever a claim about what is
	// open NOW, which is why it is looked up from the workspace rather than read
	// off the entry.
	private paneName(entry: NavHistoryEntry): string | undefined {
		const label = paneLabel(this.panes, entry);
		if (!label)
			return undefined;
		// "2/3" — which of how many, in three characters: the word ("Pane",
		// "窗格") was the widest thing in the row's quiet zone and said nothing
		// the two numbers do not.
		return t('navHistory.pane', label.n, label.total);
	}

	// The main area as it stands right now: every main-area leaf, in the
	// layout order iterateAllLeaves yields, with the destination it currently
	// shows. This — not the recorded leaf ids — is what the pane marker is
	// derived from (see paneInfo for why): one tab walks through many notes, and
	// closing a tab leaves its entries behind, so a history-derived number named
	// windows the user could not see. Rebuilt per render, so the marker follows
	// the layout.
	private liveLeaves(): LiveLeaf[] {
		const live: LiveLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			// A sidebar panel holding the tracked note is not a second window of
			// it for this purpose: it is not a tab the reader switches between,
			// and the history never records it either.
			if (!isMainAreaLeaf(this.app, leaf))
				return;
			const view = leaf.view;
			if (view instanceof FileView) {
				if (view.file)
					live.push({ leafId: leafIdOf(leaf), key: view.file.path });
				return;
			}
			const viewType = view?.getViewType();
			if (viewType && RECORDABLE_VIEW_TYPES.has(viewType))
				live.push({ leafId: leafIdOf(leaf), key: viewDestinationKey(viewType) });
		});
		return live;
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
	// Returns 1 so callers can count what was drawn.
	private row(indices: number[]): number {
		const rep = indices[0];
		const entry = this.nav.entries[rep];
		const d = this.describe(rep);
		const row = this.listEl.createDiv({ cls: 'position-restore-nav-row' });
		if (d.missing) {
			// Rendered (the gap in the history is information) but never
			// selectable and never a jump target: jumping moves the stack
			// pointer while nothing can be restored.
			row.addClass('is-missing');
			row.setAttr('title', t('navHistory.disabledTip'));
		}

		row.dataset.rep = String(rep);
		// A dead step is marked on the name itself: the type column that used
		// to carry "missing" is gone, and a row a click cannot reach must look
		// different from one it can.
		const file = row.createSpan({
			cls: `nav-row-file${d.missing ? ' is-missing' : ''}`,
		});
		file.createSpan({ text: d.file, cls: 'nav-row-name' });

		// The section the landing sits in, deepest one or two levels: the coarse
		// index a reader matches against memory, and the second half of what the
		// row says. It follows the name immediately — a fixed-width name column
		// left a hole in the middle of every row with a short name.
		// The cell is created even when there is no section, and empty: the row
		// is a grid of tracks, so a missing element would let later cells slide
		// one track left.
		const trail = rowTrail(this.trailFor(entry, d), d.anchor);
		const crumb = row.createSpan({ cls: 'nav-row-trail' });
		for (let i = 0; i < trail.length; i++) {
			if (i > 0)
				crumb.createSpan({ text: '›', cls: 'nav-trail-sep' });
			crumb.createSpan({ text: trail[i] });
		}

		// The small print — how many steps this row stands for, which pane of the
		// file it came from, the coordinate it lands on, and when: row identity
		// rather than row content, all of it faint, all of it in one element so
		// that the two layouts can place it as a block. On a pointing device it
		// is a strip at the row's right edge, its four cells of fixed width
		// right-aligned inside it so they line up as columns down the list; on a
		// phone it is the row's second line, starting at the row's left edge
		// under the name (see styles.css). Either way every cell is created even
		// when it has nothing to say — the cells are fixed columns, and a missing
		// element would let the ones after it slide one column left (the age into
		// the count's slot). A pair is not worth a chip: "×2" is the commonest
		// count and the emptiest of them, so the count starts at three and below
		// that the row simply is what it is.
		const meta = row.createDiv({ cls: 'nav-row-meta' });
		const count = meta.createSpan({ cls: 'nav-row-count' });
		if (indices.length >= 3)
			count.setText(`×${indices.length}`);
		const pane = meta.createSpan({ cls: 'nav-row-pane' });
		const paneLabel = this.paneName(entry);
		if (paneLabel)
			pane.setText(paneLabel);
		const pos = meta.createDiv({ cls: 'nav-row-pos' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		else
			pos.createSpan({ text: '—', cls: 'nav-row-nopos' });

		meta.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });

		if (!d.missing) {
			row.addEventListener('click', () => this.onRowClick(rep));
			this.visible.push(rep);
		} else if (this.mobile) {
			// A dead step stays inert as a jump target, but on a touch device the
			// tap has to be able to ask for its panel: that panel is where "this
			// file is gone" is written, and there is no hover to ask with. The
			// panel grows no jump button for it (see renderPreview).
			row.addEventListener('click', () => this.onRowClick(rep));
		}
		// Every merged alias resolves to this element, so a preview or a
		// selection that lands on a duplicate still finds its row.
		for (const i of indices)
			this.rowEls.set(i, row);
		return 1;
	}

	private move(d: number): void {
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
		if (this.selected >= 0)
			this.rowEls.get(this.selected)?.removeClass('is-selected');
		this.selected = i >= 0 && this.visible.includes(i) ? i : -1;
		if (this.selected >= 0) {
			this.previewed = this.selected;
			const el = this.rowEls.get(this.selected);
			el?.addClass('is-selected');
			el?.scrollIntoView({ block: 'nearest' });
		}
		this.renderPreview();
		// On touch the panel hangs BELOW that row (see renderPreview), so the row
		// alone being on screen is not enough: the panel is where the button that
		// travels with a finger lives, and it must not open off the bottom edge.
		if (this.mobile && this.selected >= 0)
			this.previewEl.scrollIntoView({ block: 'nearest' });
	}

	// Real pointer movement over the list, hit-tested to a row. mouseenter is
	// deliberately NOT used: rows are rebuilt on every keystroke, and a
	// browser synthesises mouseenter for whatever lands under a stationary
	// pointer — which would steal the keyboard selection and silently
	// retarget Enter. Only movement the user actually made counts.
	// A touch device has no hover at all, and there this listener must stay out
	// of the way: a tap on the section column (the column below, the one part of
	// a row that does something a click does not) makes the WebView fire a
	// mousemove before the click, which pointed the panel at the row and asked
	// the core page preview for a popover — under the finger that opened it, so
	// tapping that column behaved nothing like tapping the rest of the row, and
	// the synthesized selection made the tap's click read as "close this row
	// again". Touch drives this panel with clicks alone.
	private onListHover(ev: MouseEvent): void {
		if (this.mobile)
			return;
		const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.position-restore-nav-row');
		const rep = row ? Number(row.dataset.rep) : NaN;
		if (!row || Number.isNaN(rep))
			return;
		if (rep !== this.previewed) {
			this.previewed = rep;
			// The new row has not been pointed at yet: entering its section
			// column is what asks for a preview.
			this.trailHover = false;
			// A missing file cannot be selected (Enter must never target it), but
			// its row still previews — the panel is where "deleted" is explained.
			if (this.visible.includes(rep))
				this.select(rep);
			else
				this.renderPreview();
		}
		// The whole note is previewed from the SECTION column alone: pointing at
		// a row selects it (and a click travels there), but throwing a whole-note
		// popover over the list every time the pointer crosses a row made the
		// list unusable for the scanning it is there for. The section is also the
		// part a reader points at to confirm a spot.
		const onTrail = this.overTrail(ev, row);
		if (onTrail && !this.trailHover && this.visible.includes(rep))
			this.requestPagePreview(ev, row, rep);
		this.trailHover = onTrail;
	}

	// Whether the pointer is over the section column — the row's preview target.
	// Tested by X rather than by DOM containment: a note without headings still
	// has the cell (the row's grid needs it), but an empty cell has no height to
	// be hit-tested on, while its column is exactly the strip a user points at.
	private overTrail(ev: MouseEvent, row: HTMLElement): boolean {
		const cell = row.querySelector<HTMLElement>('.nav-row-trail');
		if (!cell)
			return false;
		const box = cell.getBoundingClientRect();
		return ev.clientX >= box.left && ev.clientX <= box.right;
	}

	// Hand the pointed-at row to Obsidian's OWN page preview — the core "Page
	// preview" plugin listens for this event and shows a popover holding the
	// file's real preview view, which is the same thing ⌘/Ctrl + hovering a link
	// gives: the whole note, native scrolling, its own sizing. We only ANNOUNCE
	// the hover, and only from the row's section column (see onListHover).
	// Whether a preview appears, how big it is, how long it survives and whether
	// the Mod key is required are the plugin's business — that last one is
	// configured per source, under the id registered in main.ts.
	// `state` carries the landing line, so the preview opens at the spot the row
	// promises rather than at the top of the file — and because the plugin draws
	// the note before it applies that line, a row WITH a landing is held back
	// until the scroll has landed (see holdPreview).
	private requestPagePreview(ev: MouseEvent, row: HTMLElement, rep: number): void {
		const entry = this.nav.entries[rep];
		if (entry.kind === 'view')
			return;
		// The plugin aligns the popover with the anchor rather than with the
		// section cell, and hangs it below the row; say where it goes instead
		// (and re-say it on every hover, because the plugin rewrites the
		// position each time).
		this.placePagePreview(row);
		const d = this.describe(rep);
		if (d.lineIndex === undefined)
			// A row with no landing opens at the top of the file by design, so
			// there is no jump to hide — and a hold left over from a previous row
			// must not outlive this preview.
			this.revealPreview();
		else
			this.holdPreview(row);
		this.app.workspace.trigger('hover-link', {
			event: ev,
			source: HOVER_LINK_SOURCE_ID,
			hoverParent: this,
			targetEl: row,
			linktext: entry.path,
			sourcePath: entry.path,
			state: d.lineIndex === undefined ? undefined : { scroll: d.lineIndex },
		});
	}

	// The popover the plugin is currently showing for us, seen through the one
	// runtime field Obsidian's typings omit (see PopoverRuntime). A plain
	// assignment rather than a cast: that type only ADDS an optional field, so
	// the plugin's own type already satisfies it.
	private shownPopover(): PopoverRuntime | null {
		return this.hoverPopover;
	}

	// Hold the native popover invisible until the landing has been applied. The
	// plugin renders the whole note first and only then scrolls to the line (its
	// note renderer retries until the text is laid out), so left alone the user
	// sees a flash of the file's opening lines and then a jump. The renderer
	// marks the line it scrolled to (.is-flashing) in the same call that puts the
	// preview in place, so that mark appearing is the "ready" signal.
	// Two cases have nothing to wait for and are not held:
	//   - the row has no landing (see requestPagePreview);
	//   - the plugin answers with the popover it is ALREADY showing for this row
	//     (onHoverLink returns early for the same targetEl): nothing is rebuilt,
	//     so there is no flash to hide and holding would only delay a preview
	//     that is already in place.
	private holdPreview(row: HTMLElement): void {
		if (this.shownPopover()?.targetEl === row)
			return;
		this.stopRevealWatch();
		document.body.addClass(POPOVER_PENDING_CLASS);
		const deadline = Date.now() + REVEAL_DEADLINE_MS;
		const step = (): void => {
			this.revealWatch = undefined;
			const pop = this.shownPopover();
			const landed = pop?.targetEl === row
				&& !!pop.hoverEl?.querySelector(LANDING_MARK_CLASS);
			// The wait is over when the landing is on screen, when the browser
			// closed, or when the deadline says the preview is never going to
			// report one.
			if (landed || this.closed || Date.now() >= deadline)
				this.revealPreview();
			else
				this.revealWatch = window.requestAnimationFrame(step);
		};
		this.revealWatch = window.requestAnimationFrame(step);
	}

	// Let a held-back preview through again. Idempotent: it runs on the landing,
	// on close, when the wait runs out, and before a preview with nothing to wait
	// for.
	private revealPreview(): void {
		this.stopRevealWatch();
		document.body.removeClass(POPOVER_PENDING_CLASS);
	}

	private stopRevealWatch(): void {
		if (this.revealWatch === undefined)
			return;
		window.cancelAnimationFrame(this.revealWatch);
		this.revealWatch = undefined;
	}

	// The landing panel: where the pointed-at row sits (path, pane, type, line,
	// age), the heading chain it sits under, and the landing line with its
	// neighbours. Nothing when nothing is pointed at, rather than guessing.
	// TOUCH ONLY: on a pointing device the same hover asks the core page preview
	// for the whole note instead (see requestPagePreview), and rendering a panel
	// nobody can see would still cost a file read per hovered row.
	// It opens UNDER the selected row, in the list's own scroll flow. Parked at
	// the bottom of the dialog (where it used to live) it lost the fight for
	// height the moment there was history to scroll — and a panel nobody can see
	// is a "jump here" button nobody can tap. Inside the list it is always one
	// flick away from the row that opened it, and select() brings it into view.
	private renderPreview(): void {
		if (!this.mobile)
			return;
		const box = this.previewEl;
		box.empty();
		const entry = this.nav.entries[this.previewed];
		const row = entry ? this.rowEls.get(this.previewed) : undefined;
		if (!entry || !row) {
			// Nothing pointed at, or the filter took its row away: the panel has
			// no row to open under, so it waits out of the way.
			this.previewHost.appendChild(box);
			box.addClass('is-parked');
			return;
		}
		row.insertAdjacentElement('afterend', box);
		box.removeClass('is-parked');
		const d = this.describe(this.previewed);
		const head = box.createDiv({ cls: 'nav-preview-head' });
		head.createSpan({ text: d.title, cls: 'nav-preview-title' });
		const pane = this.paneName(entry);
		if (pane)
			head.createSpan({ text: pane, cls: 'nav-preview-pane' });
		// The row's old type column lives here: how the step was made is
		// confirmation of a choice, not part of making it.
		if (!d.missing)
			head.createSpan({ text: d.type, cls: `nav-preview-type${d.soft ? ' is-soft' : ''}` });
		if (d.line)
			head.createSpan({ text: d.line, cls: 'nav-row-line' });
		head.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });
		// A touch device has no Enter and no hover: without this button a tap
		// could point at a row but never go there. It is the panel's last line and
		// as wide as the panel, because a finger has to be able to hit it.
		if (!d.missing) {
			const go = box.createEl('button', { text: t('navHistory.jumpHere'), cls: 'nav-preview-go' });
			go.addEventListener('click', () => this.jump(this.previewed));
		}

		if (d.missing) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.gone') });
			return;
		}
		if (d.lineIndex === undefined || entry.kind === 'view') {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
			return;
		}
		const lines = this.linesFor(entry.path);
		if (lines === undefined) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.loading') });
			this.scheduleRead(entry.path);
			return;
		}
		if (lines === null) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
			return;
		}
		// WHICH section the landing sits in is the cue a reader recognizes a
		// spot by — three raw lines of prose say little on their own. The full
		// chain here (the row trims it), and it needs no file read.
		const trail = this.trailFor(entry, d);
		if (trail.length) {
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
		for (const line of previewWindow(lines, d.lineIndex, PREVIEW_RADIUS)) {
			const el = box.createDiv({
				cls: `nav-preview-line${line.mark ? ' is-landing' : ''}`,
			});
			el.createSpan({ text: `L${line.num}`, cls: 'nav-preview-num' });
			el.createSpan({
				text: line.text.trim() || t('navHistory.preview.blank'),
				cls: 'nav-preview-text',
			});
		}
	}

	// The lines of `path`, or undefined while they are still coming.
	// An OPEN note is read straight from its editor: no IO at all, so the
	// common case (looking at where you just were, in a note you still have
	// open) is instant even for a huge file. Everything else falls back to one
	// cached vault read, kept in a bounded cache.
	private linesFor(path: string): string[] | null | undefined {
		const cached = this.lines.get(path);
		if (cached !== undefined)
			return cached;
		const editor = this.liveEditor(path);
		if (!editor)
			return undefined;
		// Synchronous and IO-free; the split is paid once, every later hover
		// hits the cache. Unsaved edits are visible here, which is what the
		// user is looking at anyway.
		const lines = editor.getValue().split('\n');
		this.remember(path, lines);
		return lines;
	}

	private liveEditor(path: string): Editor | undefined {
		let found: Editor | undefined;
		this.app.workspace?.iterateAllLeaves?.((leaf) => {
			const view = leaf.view;
			if (!found && view instanceof MarkdownView && view.editor && view.file?.path === path)
				found = view.editor;
		});
		return found;
	}

	private remember(path: string, lines: string[] | null): void {
		this.lines.delete(path);
		this.lines.set(path, lines);
		while (this.lines.size > PREVIEW_CACHE_MAX) {
			const oldest = this.lines.keys().next().value;
			if (oldest === undefined)
				break;
			this.lines.delete(oldest);
		}
	}

	// A vault read only for a row the pointer rests on — see
	// PREVIEW_READ_DELAY_MS.
	private scheduleRead(path: string): void {
		if (this.closed || this.lines.has(path) || this.reading.has(path))
			return;
		if (this.readPath === path && this.readTimer !== undefined)
			return;
		this.cancelRead();
		this.readPath = path;
		this.readTimer = window.setTimeout(() => {
			this.readTimer = undefined;
			void this.readLines(this.readPath);
		}, PREVIEW_READ_DELAY_MS);
	}

	private cancelRead(): void {
		if (this.readTimer === undefined)
			return;
		window.clearTimeout(this.readTimer);
		this.readTimer = undefined;
	}

	private async readLines(path: string): Promise<void> {
		if (this.closed || this.lines.has(path) || this.reading.has(path))
			return;
		this.reading.add(path);
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			const text = file instanceof TFile ? await this.app.vault.cachedRead(file) : null;
			this.remember(path, text === null ? null : text.split('\n'));
		} catch (e) {
			console.error('Position Restore: can not read history preview:', e);
			this.remember(path, null);
		} finally {
			this.reading.delete(path);
		}
		if (!this.closed)
			this.renderPreview();
	}

	// A row's tap/click. On a pointing device the click IS the choice, as it
	// always was. On a touch device every tap does exactly one thing, on every
	// row: it OPENS that row's landing under it, or CLOSES it again when the same
	// row is tapped twice — the panel is the only preview a touch device can get
	// (there is no hover), and a tap that could only ever open left the list with
	// no way back. Travel is the panel's own "jump here" button, so the gesture
	// never changes meaning under the finger.
	private onRowClick(rep: number): void {
		if (this.mobile) {
			if (this.selected === rep || this.previewed === rep) {
				// Closing: nothing is pointed at any more, which is what parks
				// the panel (see renderPreview).
				this.previewed = -1;
				this.select(-1);
			} else if (this.visible.includes(rep)) {
				this.select(rep);
			} else {
				// A deleted step: previewable (that is where "file gone" is
				// explained) but never selectable, so Enter can never target it.
				this.previewed = rep;
				this.renderPreview();
			}
			return;
		}
		this.jump(rep);
	}

	private jump(i: number): void {
		this.close();
		void this.nav.jumpTo(i)
			.catch(e => console.error('Position Restore: history jump failed:', e));
	}
}
