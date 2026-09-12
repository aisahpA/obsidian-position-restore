import { App, Editor, HoverPopover, MarkdownView, Modal, Platform, TFile } from 'obsidian';
import { NavHistory } from './nav-history';
import { NavHistoryEntry } from './nav-entry';
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

// Where the native preview should put its left edge, in viewport coordinates.
// The core plugin aligns its popover's left edge with the anchor's — the row —
// so left to itself it opens a 450px-wide preview ACROSS the list the user is
// scanning, and the hover-link payload has no field for the side. It recomputes
// that position on every show, so the only durable way to say "beside the row,
// not over it" is a CSS variable that styles.css reads with !important (which
// beats the inline style the plugin writes).
export const POPOVER_LEFT_VAR = '--position-restore-popover-left';

// How far right of the row the preview starts.
const POPOVER_GAP = 8;

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
	// The same landing line as a 0-based index — what the preview window
	// reads. `line` stays the display form ('L412').
	lineIndex?: number;
	anchor?: string;
	missing: boolean;
	// An inferred entry (NavTeleport): the user did not deliberately jump
	// there — the badge renders dimmed to signal lower confidence.
	soft?: boolean;
}

// The row shows the line the restore lands on plus THAT line's text: a
// reading capture lands on the viewport top line (its remap anchor), an edit
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
// pathless view entry. Used to tell whether a file is held by several panes.
export function destinationKey(entry: NavHistoryEntry): string {
	return entry.kind === 'view' ? `view:${entry.viewType}` : entry.path;
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

// The file-scope filter ("only in this note"): does the entry sit in the file
// the pinned card shows? `path` is that file's path, or undefined when there is
// nothing to scope to (an empty history, a pathless view step) — then the scope
// is inert and lets everything through, so a stale toggle can never blank the
// list. A view entry has no path, so it never matches: the scope answers "where
// else in THIS note was I", and a graph step is not a place in a note.
export function inFileScope(entry: NavHistoryEntry, path: string | undefined): boolean {
	if (path === undefined)
		return true;
	return entry.kind !== 'view' && entry.path === path;
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

// Same file, more than one leaf (two tabs or two panes): without a chip the
// browser's rows for those panes are indistinguishable — and merging them by
// landing line would make one of them unreachable from the panel. Numbering
// is per destination and starts at the leaf that was seen first, so a file's
// panes always read 1..n; `ambiguous` keeps the chip off every other row,
// where it would be pure noise.
export interface PaneInfo {
	labels: Map<string, Map<string, number>>;
	ambiguous: Set<string>;
}

export function paneInfo(entries: NavHistoryEntry[]): PaneInfo {
	const labels = new Map<string, Map<string, number>>();
	const seen = new Map<string, Set<string>>();
	for (const entry of entries) {
		const key = destinationKey(entry);
		let byLeaf = labels.get(key);
		if (!byLeaf) {
			byLeaf = new Map();
			labels.set(key, byLeaf);
		}
		if (!byLeaf.has(entry.leafId))
			byLeaf.set(entry.leafId, byLeaf.size + 1);
		let leaves = seen.get(key);
		if (!leaves) {
			leaves = new Set();
			seen.set(key, leaves);
		}
		leaves.add(entry.leafId);
	}
	const ambiguous = new Set<string>();
	for (const [key, leaves] of seen)
		if (leaves.size > 1)
			ambiguous.add(key);
	return { labels, ambiguous };
}

// The chip number for an entry, or undefined when its destination lives in a
// single leaf (nothing to disambiguate).
export function paneLabel(info: PaneInfo, entry: NavHistoryEntry): number | undefined {
	const key = destinationKey(entry);
	if (!info.ambiguous.has(key))
		return undefined;
	return info.labels.get(key)?.get(entry.leafId);
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

// "Browse navigation history" modal. A destination picker, laid out around
// how a user actually gets lost:
//  - the CURRENT location is a pinned card at the top, so "you are here"
//    never scrolls out of view;
//  - the default list is CHRONOLOGICAL (newest first), split into forward and
//    back segments around the pinned card, each row labelled with a relative
//    time — the index a user remembers "where I was" by;
//  - a bare Enter goes BACK ONE STEP (the reflex that opens this panel), never
//    a re-land of the current position;
//  - hovering (or, on a touch device, tapping) a row previews its landing in a
//    SCROLLING panel beside the list, because recognition beats retrieval for
//    picking a spot in a long note — and because a panel that reserves its own
//    column costs the list nothing, it can afford the context a fixed strip at
//    the bottom could never have;
//  - the toolbar can narrow the list to the note the pinned card shows (the
//    scope), and to matching text; the two compose, and the scope is what makes
//    "where in this note was I" askable at all;
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
	// Nothing is selected on open: that is what makes Enter mean "go back".
	private selected = -1;
	// The row the preview panel describes. Driven by the keyboard selection
	// AND by pointer movement, so the two never disagree about what is being
	// pointed at; -1 = nothing pointed at, and the panel says so instead of
	// guessing (a missing entry can be previewed but never selected).
	private previewed = -1;
	private filter = '';
	// The file scope toggle (see inFileScope): off by default, because the
	// question this panel is opened with is usually "where was I", not "where
	// in this note was I". Not called `scope`: Modal already owns that name for
	// its keymap scope, and shadowing it with a boolean does not typecheck.
	private fileOnly = false;
	private listEl!: HTMLElement;
	private hereEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private panes: PaneInfo = { labels: new Map(), ambiguous: new Set() };
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
	// Where the core "Page preview" plugin parks the popover it shows for us
	// (the HoverParent contract). Declared because Obsidian's Modal is not a
	// HoverParent in its own typings, even though the plugin assigns this field
	// at runtime and reads it back to hide its own popover.
	hoverPopover: HoverPopover | null = null;

	constructor(
		app: App,
		private nav: NavHistory,
		private savedPosition?: (path: string) => EphemeralState | undefined,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		// The native page preview we ask for from a row would otherwise render
		// behind this dialog (see BODY_OPEN_CLASS).
		document.body.addClass(BODY_OPEN_CLASS);
		// A resting place for the preview's left edge: without a value the
		// stylesheet's clamp would pin the first popover to the window's left
		// edge before any row has been pointed at.
		this.placePagePreview(this.modalEl);
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
		this.hereEl = this.contentEl.createDiv({ cls: 'position-restore-nav-here' });
		// The list and the preview share a row (see styles.css): the list takes
		// the slack, the preview keeps a fixed width of its own. On a narrow
		// pane the same two elements stack instead, preview underneath.
		const body = this.contentEl.createDiv({ cls: 'position-restore-nav-body' });
		this.listEl = body.createDiv({ cls: 'position-restore-nav-list' });
		// Pointer movement is the only hover signal — see onListHover.
		this.listEl.addEventListener('mousemove', (ev) => this.onListHover(ev));
		this.previewEl = body.createDiv({ cls: 'position-restore-nav-preview' });
		this.render();
		if (this.nav.entries.length > 0)
			this.filterInput.focus();
	}

	onClose() {
		this.closed = true;
		this.cancelRead();
		document.body.removeClass(BODY_OPEN_CLASS);
		document.body.style.removeProperty(POPOVER_LEFT_VAR);
		window.removeEventListener('resize', this.onWindowResize);
	}

	private onWindowResize = (): void => {
		const row = this.rowEls.get(this.previewed);
		this.placePagePreview(row ?? this.modalEl);
	};

	// Tell the stylesheet where the native preview may start: just right of the
	// anchor, in viewport coordinates. The clamp that keeps it on screen lives
	// in styles.css, next to the rule that consumes the value.
	private placePagePreview(anchor: HTMLElement): void {
		const right = anchor.getBoundingClientRect().right;
		document.body.style.setProperty(POPOVER_LEFT_VAR, `${right + POPOVER_GAP}px`);
	}

	private onKeyDown(ev: KeyboardEvent): void {
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.move(-1);
		} else if (ev.key === 'Enter') {
			const target = this.selected >= 0 ? this.selected : this.enterTarget();
			if (target < 0)
				return;
			ev.preventDefault();
			this.jump(target);
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
			// The pinned card's Enter hint depends on what the filter leaves
			// visible, so the whole body re-renders (the toolbar does not).
			this.render();
		});
		this.filterInput = input;
		// The file-scope chip sits beside the search box: "where else in this
		// note was I" is a question the chronological list answers badly, since
		// a handful of cross-file hops buries a note's own landings. The toggle
		// only exists when there is a file to scope to (see scopePath), and its
		// label is the note's name — that is what tells the user which file the
		// narrowed list is now about.
		const path = this.scopePath();
		if (path !== undefined) {
			const label = bar.createEl('label', { cls: 'position-restore-nav-toggle' });
			const box = label.createEl('input', { type: 'checkbox' });
			label.createSpan({ text: t('navHistory.onlyThisFile', baseName(path)) });
			box.addEventListener('change', () => {
				this.fileOnly = box.checked;
				label.toggleClass('is-active', this.fileOnly);
				this.render();
				// The search box is this toolbar's keyboard surface and the
				// modal's keydown handler routes every key through the modal:
				// a click that narrows the list must not cost the user the
				// ability to keep typing in it.
				this.filterInput.focus();
			});
		}
		bar.createSpan({ cls: 'position-restore-nav-hint', text: t('navHistory.keyboardHint') });
	}

	// The file the scope narrows to: the pinned card's file. A view step (the
	// graph) has none, and then the chip is not rendered at all rather than
	// offering a filter that cannot mean anything. The current entry cannot
	// change while the modal is open (only jump() moves the pointer, and it
	// closes first), so this is stable for the modal's lifetime — which is why
	// the chip's label can be built once, with the rest of the toolbar.
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
		this.panes = paneInfo(this.nav.entries);
		// The list first: the pinned card's Enter hint depends on what the
		// current filter leaves selectable (this.visible).
		this.renderList();
		this.renderHere();
		this.renderPreview();
	}

	// The pinned "you are here" card: the one entry the list never shows.
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
		// Only promise the bare-Enter shortcut when it can actually fire.
		if (this.enterTarget() >= 0)
			card.createDiv({ cls: 'nav-here-hint', text: t('navHistory.enterBack') });
		card.addEventListener('click', () => this.jump(this.nav.index));
	}

	// (Re)draw the list only; the toolbar/here-card/preview persist around it.
	private renderList(): void {
		const keepSelected = this.selected;
		this.listEl.empty();
		this.descCache.clear();
		this.rowEls = new Map();
		this.visible = [];

		const query = this.filter.trim();
		// The scope narrows on the current entry's file; a query narrows on
		// text. They compose — the answer to "where in this note did 'scroll'
		// come up" is the intersection, not either half.
		const path = this.fileOnly ? this.scopePath() : undefined;
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

	// Which tab/pane an entry belongs to, or undefined when its destination
	// lives in a single leaf (nothing to disambiguate). On a row it is a SUFFIX
	// of the file cell, never a cell of its own: a chip in the line-number
	// column pushed that column's left edge around and made the list hard to
	// scan. It belongs on the row at all because two panes of one file are
	// otherwise identical rows — and telling those apart is exactly what
	// decides which row to pick.
	private paneName(entry: NavHistoryEntry): string | undefined {
		const n = paneLabel(this.panes, entry);
		return n === undefined ? undefined : t('navHistory.pane', n);
	}

	// One row: a single entry, or several entries that landed on the same place.
	// Cells left to right: file | section | line | age — the note, where in it,
	// its exact coordinate, and when. Only what decides WHICH row goes here; how
	// the step was made (open/switch/link/outline) is confirmation, not
	// selection, and lives in the preview panel's head. The landing's own text
	// is deliberately NOT here either: as a second line it doubled the row
	// height, and beside the section it squeezed both into ellipses.
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
		const pane = this.paneName(entry);
		if (pane)
			file.createSpan({ text: pane, cls: 'nav-row-pane' });

		// The section the landing sits in, deepest one or two levels: the coarse
		// index that makes a bare line number mean something — and the part a
		// reader matches against memory, so it comes before the number.
		// The cell is created even when there is no section, and empty: the row
		// is a grid of four tracks, so a missing element would let later cells
		// slide one track left.
		const trail = rowTrail(this.trailFor(entry, d), d.anchor);
		const crumb = row.createSpan({ cls: 'nav-row-trail' });
		for (let i = 0; i < trail.length; i++) {
			if (i > 0)
				crumb.createSpan({ text: '›', cls: 'nav-trail-sep' });
			crumb.createSpan({ text: trail[i] });
		}

		// The landing's coordinates. Still a cell of their own — the number is
		// what the eye lands on after the section, and a fixed track keeps a
		// column of them aligned (see styles.css for the age's own fixed track,
		// which is what makes that possible now that the number sits before it).
		const pos = row.createDiv({ cls: 'nav-row-pos' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		else
			pos.createSpan({ text: '—', cls: 'nav-row-nopos' });
		if (indices.length > 1)
			pos.createSpan({ text: `×${indices.length}`, cls: 'nav-row-count' });
		row.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });

		if (!d.missing) {
			row.addEventListener('click', () => this.onRowClick(rep));
			this.visible.push(rep);
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

	// The entry a bare Enter goes to: the newest back entry still on screen.
	// Opening the panel and hitting Enter is the "take me back" reflex — it
	// must never re-land the current position. With the file scope on, "on
	// screen" means "in this note": the same reflex then reads "back to my
	// previous spot in this file", which is the whole point of the toggle.
	private enterTarget(): number {
		for (const i of this.visible)
			if (i < this.nav.index)
				return i;
		return -1;
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
	}

	// Real pointer movement over the list, hit-tested to a row. mouseenter is
	// deliberately NOT used: rows are rebuilt on every keystroke, and a
	// browser synthesises mouseenter for whatever lands under a stationary
	// pointer — which would steal the keyboard selection and silently
	// retarget Enter. Only movement the user actually made counts.
	private onListHover(ev: MouseEvent): void {
		const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.position-restore-nav-row');
		const rep = row ? Number(row.dataset.rep) : NaN;
		if (!row || Number.isNaN(rep) || rep === this.previewed)
			return;
		this.previewed = rep;
		// A missing file cannot be selected (Enter must never target it), but
		// its row still previews — the panel is where "deleted" is explained.
		if (this.visible.includes(rep)) {
			this.select(rep);
			this.requestPagePreview(ev, row, rep);
		} else {
			this.renderPreview();
		}
	}

	// Hand the pointed-at row to Obsidian's OWN page preview — the core "Page
	// preview" plugin listens for this event and shows a popover holding the
	// file's real preview view, which is the same thing ⌘/Ctrl + hovering a link
	// gives: the whole note, native scrolling, its own sizing. We only ANNOUNCE
	// the hover. Whether a preview appears, how big it is, how long it survives
	// and whether the Mod key is required are the plugin's business — that last
	// one is configured per source, under the id registered in main.ts.
	// `state` carries the landing line, so the preview opens at the spot the row
	// promises rather than at the top of the file.
	private requestPagePreview(ev: MouseEvent, row: HTMLElement, rep: number): void {
		const entry = this.nav.entries[rep];
		if (entry.kind === 'view')
			return;
		// The plugin aligns the popover's left edge with the anchor's, which
		// would cover the list; say where it should go instead (and re-say it on
		// every hover, because the plugin rewrites the position each time).
		this.placePagePreview(row);
		const d = this.describe(rep);
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

	// The preview panel: where the pointed-at row sits (path, pane, type, line,
	// age), the heading chain it sits under, and the landing line with its
	// neighbours. Nothing when nothing is pointed at, rather than guessing.
	private renderPreview(): void {
		const box = this.previewEl;
		box.empty();
		const entry = this.nav.entries[this.previewed];
		if (!entry) {
			box.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.idle') });
			return;
		}
		const d = this.describe(this.previewed);
		const head = box.createDiv({ cls: 'nav-preview-head' });
		head.createSpan({ text: d.title, cls: 'nav-preview-title' });
		const pane = this.paneName(entry);
		if (pane)
			head.createSpan({ text: pane, cls: 'nav-preview-pane', attr: { title: entry.leafId } });
		// The row's old type column lives here: how the step was made is
		// confirmation of a choice, not part of making it.
		if (!d.missing)
			head.createSpan({ text: d.type, cls: `nav-preview-type${d.soft ? ' is-soft' : ''}` });
		if (d.line)
			head.createSpan({ text: d.line, cls: 'nav-row-line' });
		head.createSpan({ text: formatRelativeTime(entry.t), cls: 'nav-row-time' });
		// A touch device has no Enter and no hover: without this button a tap
		// could point at a row but never go there.
		if (this.mobile && !d.missing) {
			const go = head.createEl('button', { text: t('navHistory.jumpHere'), cls: 'nav-preview-go' });
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
	// always was. On a touch device the first tap is the pointer's "point at
	// this row" — there is no hover to do it — and only a second tap on that
	// same row travels; the preview panel's own button is the explicit way to
	// go there. Tapping a DIFFERENT row moves the preview instead of jumping,
	// which is what makes the list explorable without a mouse.
	private onRowClick(rep: number): void {
		if (this.mobile && this.selected !== rep) {
			this.select(rep);
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
