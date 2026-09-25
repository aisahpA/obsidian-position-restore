// The recent-files browser's BODY: everything about the panel that is not a shell. Two shells stand
// around it — the modal and the resident sidebar panel — and everything they share lives here: the
// toolbar, the list, the keyboard, travel. A shell owns its own lifetime and nothing else, which is
// why travel is a callback: the modal closes when the reader goes somewhere, the sidebar stays.
//
// READ-ONLY BUT FOR TWO THINGS, and that is what makes a resident panel possible at all: the body
// draws whatever the places hold at the moment render() is called, and the only things it says back
// are what ONE ROW can be asked for — go there, and go away.

import { App, CachedMetadata, HoverParent, Menu, MenuPositionDef, TFile, setIcon, Keymap } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { PlaceList, placeKey } from '@/recent-files/places';
import { EphemeralState, LandingsMode, PathDisplayMode } from '@/types';
import { t } from '@/i18n';
import { linesSource } from '@/position/capture/ephemeral';
import { markdownViewFor } from '@/shared/leaf';
import { nowLineFor, NowLineFacts } from './now-line';
import { headingTrailAtLine, NavEntryDescription } from './model';
import { RecentFilesReads } from './reads';
import { RecentFilesList, RecentFilesListOptions } from './list';
import { PreviewSettle } from './hover-settle';
import { LATE_READ_REDRAW_MS, NAV_SOURCE_ID, TIME_REFRESH_MS } from './constants';

// Per-body sequence for the list element's id.
let browserSeq = 0;

// A heading that cannot travel inside a linktext: each of these is read as link syntax rather than
// as part of the section's name — `#` and `^` open a subpath, `|` an alias, `[` and `]` the link.
const UNTRAVELABLE = /[#^|[\]]/;

// Put on the card the app opens for this panel, and on nothing else: the popover is the core's
// object, drawn by the core's own rules, and the one thing this panel says about how it looks is
// WHERE IT STANDS.
const PREVIEW_CLASS = 'position-restore-nav-preview';

// The preferences the browser DRAWS BY, handed to every shell by the plugin that persists them. All
// are READERS rather than values: a resident panel draws its list from a call made during render, so
// a change made elsewhere is picked up by the next redraw instead of being frozen into the panel
// that happened to be open.
export interface RecentFilesBrowserPrefs {
	// How much of one note the list prints (see LandingsMode).
	landings: () => LandingsMode;
	// How many places the recent-files list keeps.
	placesCap: () => number;
	// How much of a row's path the list prints, and on which side of the name.
	pathDisplay: () => PathDisplayMode;
	rowTime: () => boolean;
}

export interface RecentFilesBrowserOptions {
	app: App;
	// The PLACES the rows are drawn from — the recent-files list, never the back/forward stack: a
	// stack that truncates on a fresh jump cannot answer "which files have I been in".
	places: PlaceList;
	// The element the body builds itself into. Its size is the shell's business.
	host: HTMLElement;
	// The file's saved record: the position every FILE row's line is drawn from (a place carries
	// none), and the spot a plain open restores.
	savedPosition?: (path: string) => EphemeralState | undefined;
	// The device's own ergonomics and nothing else — an on-screen keyboard covering half a phone, a
	// × worth tapping. The list is click-only either way.
	touch: boolean;
	// Whether a travel CLEARS the reader's place in the list first. A shell that stays up needs it:
	// the jump pins another note in that slot, and any position left standing would name whatever
	// slid into it.
	collapseOnJump: boolean;
	// Whether the filter box takes the focus on mount. A dialog wants it; a resident panel must not
	// — it is restored with the workspace, and stealing the caret out of the editor is not something
	// the reader asked for.
	focusFilter: boolean;
	// The shell's own reaction to a travel, run BEFORE the history is asked to move.
	onJump?: () => void;
	prefs: RecentFilesBrowserPrefs;
}

export class RecentFilesBrowser {
	private list!: RecentFilesList;
	// The list's options object, kept because two of its fields are re-pointed before every render:
	// a resident panel is refreshed by assigning to it rather than by rebuilding the list (which
	// would drop the position the reader was on).
	private listOpts!: RecentFilesListOptions;
	// The search box's text. The list's own query.
	private filter = '';
	private filterInput!: HTMLInputElement;
	// Every vault lookup the panel makes, cached — all metadata-cache lookups: an entry's display
	// pieces and a file's parsed headings.
	private reads: RecentFilesReads;
	// Unique per body: the rows' option ids are built from it and the filter box's
	// aria-activedescendant points at one, so a sidebar panel and the modal at once cannot collide.
	private readonly listId = `position-restore-nav-list-${++browserSeq}`;
	// This panel's slot in the app's hover-preview system, ONE object for the life of the body: the
	// app writes the popover it opens back into it and asks it later, so one built per arrival would
	// be one with no memory.
	private readonly hoverParent: HoverParent = { hoverPopover: null };
	// What hides the popover's own journey to the line it was asked for: whether the app answered at
	// all is decided outside this panel, several frames after the row was asked for.
	private readonly settle = new PreviewSettle();
	// The group order the list is being HELD at while the pointer is on it. Keys rather than rows:
	// the order has to survive the redraw it exists to stop.
	private frozenOrder?: string[];
	private timer?: number;
	// The redraw owed to a chain that arrived after the row was drawn. Coalesced: the whole list
	// asks at once, and a redraw apiece would rebuild every row.
	private lateTimer?: number;
	// The menu this body raised, while one is standing. Held here for the two ends the app cannot
	// see: the control that raised it (whose press the app never hears) and a shell stepping out of
	// the reader's way.
	private menu?: Menu;

	// The three facts the vault has to answer for a line number to be re-found. Read through on
	// every asking: a copy of them would be a copy that goes stale.
	private nowLines: NowLineFacts;

	constructor(private opts: RecentFilesBrowserOptions) {
		this.reads = new RecentFilesReads(opts.app, {
			savedPosition: opts.savedPosition,
			// The live list, re-pointed per render: a resident panel describes the places as they
			// stand, not as they stood when it opened.
			entries: () => opts.places.entries,
			// A chain read out of a note's own text lands one render late: the row it belongs to
			// was already drawn without it.
			onLateRead: () => this.redrawAfterLateRead(),
		});
		this.nowLines = {
			mtimeOf: path => this.reads.mtimeOf(path),
			cacheFor: (path: string): CachedMetadata | null => {
				const file = this.opts.app.vault.getAbstractFileByPath(path);
				return file instanceof TFile
					? this.opts.app.metadataCache.getFileCache(file)
					: null;
			},
		// A note that is OPEN is the only source that cannot be behind: its own buffer is what the
		// reader is looking at, saved or not. Everything else is read off the disk, and only when
		// the asker will wait for it.
		linesOf: (path, prime) => {
				const open = markdownViewFor(this.opts.app, path);
				if (open)
					return open.editor;
				const lines = this.reads.linesFor(path, prime);
				return lines ? linesSource(lines) : undefined;
			},
		};
	}

	// Build the toolbar and the list inside the shell's element. One call per body: the toolbar is
	// NOT rebuilt per render, so the filter input keeps its focus and its caret while typing
	// redraws the list underneath it.
	mount(): void {
		this.toolbar();
		const listEl = this.opts.host.createDiv({ cls: 'position-restore-nav-list' });
		// A listbox whose options are the rows, and whose current option the filter box names
		// through aria-activedescendant — which is what the id makes possible.
		listEl.setAttr('id', this.listId);
		listEl.setAttr('role', 'listbox');
		listEl.setAttr('aria-label', t('recentFiles.name'));
		this.listOpts = {
			list: listEl,
			listId: this.listId,
			// Read LIVE, so the toolbar's setting reaches a panel that is already up.
			landings: () => this.opts.prefs.landings(),
			pathDisplay: () => this.opts.prefs.pathDisplay(),
			rowTime: () => this.opts.prefs.rowTime(),
			// Read per render: the pins are the reader's, and a panel that is
			// standing there has to hear about one the moment it is made.
			pinned: () => this.opts.places.pinned,
			// Read per render, so a render that happens while the reader is on the list comes out
			// in the order they are reading.
			order: () => this.frozenOrder,
			// What makes two places one, for a click whose row has been rebuilt away from under it.
			// The store's own notion of identity.
			keyOf: (rep) => {
				const entry = this.opts.places.entries[rep];
				return entry ? placeKey(entry) : undefined;
			},
			entries: this.opts.places.entries,
			currentIndex: this.opts.places.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			// Whether a place may be listed at all: a name the list cannot open is not a row. The
			// store prunes such a place on its own; this is the list agreeing.
			noteExists: path => this.reads.hasFile(path),
			trailFor: (entry, d) => this.trailFor(entry, d),
			mtimeFor: path => this.reads.mtimeOf(path),
			// The file's other names: searchable, and printed nowhere but the tooltip.
			aliasesFor: path => this.reads.aliasesFor(path),
			onActiveRow: id => this.setActiveRow(id),
			onTravel: (rep, target) => this.jump(rep, target),
			// Which FILE the row names, and whether the row is the note's own rather than a spot in
			// it, handed over for the app's own preview. Nothing here travels for it.
			onHoverRow: (rep, ev, el, file) => this.hoverRow(rep, ev, el, file),
			tipsQuiet: () => this.settle.isOpen(),
			onHoverEnd: () => this.settle.hoverEnded(),
			// A right-click asks the APP what it can do with this file; the menu is built here
			// because the list does not hold the app.
			onContextRow: (rep, ev) => this.contextRow(rep, ev),
			takeMenuBack: () => this.takeMenuBack(),
			// A row's own ×: the removal the list asks for and cannot make itself, because the
			// places are here and not there.
			onForget: key => this.forgetRow(key),
			// …and the same × on a LANDING's row, which drops the spot and leaves the note standing.
			onForgetLanding: keys => this.forgetLanding(keys),
			// A finger that stopped on a row is heard only where there is no hover to arm one with.
			touch: this.opts.touch,
		};
		this.list = new RecentFilesList(this.listOpts);
		// The settle's two ends, tied once: WHO to watch for the app's answer (the parent every
		// hoverRow hands over), and what to do when it comes — give the card the room it needs over
		// this panel's shell, and take the rows' hint off a page that has answered.
		this.settle.attach(this.hoverParent, card => {
			this.liftPreview(card);
			this.list.hideTip();
		});
		// The pointer is how the body knows the reader is USING this list, which is the question the
		// held order answers.
		//
		// pointerover rather than pointerenter: a panel that comes up under a pointer already
		// resting there (the sidebar restored at startup, the modal opened while the mouse sits
		// mid-screen) never crosses the boundary, so the enter never fires.
		//
		// A FINGER IS NOT A POINTER HERE: touch delivers the same pair, and the leave arrives while
		// the finger is STILL DOWN, so thawOrder's redraw would replace every row under a touch
		// becoming a scroll — the row it landed on gone, and with it the gesture.
		listEl.addEventListener('pointerover', (ev) => {
			if (ev.pointerType !== 'touch')
				this.freezeOrder();
		});
		listEl.addEventListener('pointerleave', (ev) => {
			if (ev.pointerType !== 'touch')
				this.thawOrder();
		});
		// …and the click the ROWS did not answer: one whose row element was rebuilt away between
		// the press and the release, which is exactly the click the list answers by identity.
		listEl.addEventListener('click', (ev) => this.list.onUnansweredClick(ev));
		// One keydown listener on the shell's element covers both the filter input and the list:
		// while typing, arrows navigate and Enter jumps (the input would otherwise move its caret).
		this.opts.host.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		this.render();
		// The ages are read off a clock, so a panel nobody is touching drifts. Two things keep it
		// honest: the interval for a panel standing there, and becoming visible again — the case an
		// interval cannot cover, since a backgrounded tab has its timers throttled for hours.
		this.timer = window.setInterval(() => {
			if (document.hidden || !this.opts.prefs.rowTime())
				return;
			this.render();
		}, TIME_REFRESH_MS);
		document.addEventListener('visibilitychange', this.onVisibilityChange);
		// On touch the box stays unfocused: the on-screen keyboard covers half a small screen.
		if (this.opts.focusFilter && !this.opts.touch && this.opts.places.entries.length > 0)
			this.filterInput.focus();
	}

	// (Re)draw everything the places and the filter decide. Called by the shell when it mounts and —
	// for a resident panel — every time the places change.
	render(): void {
		// The places as they stand NOW, before anything reads them: the list resolves its entries by
		// index, so a list that moved under a resident panel is picked up by re-pointing these two
		// fields and nothing else. The describe cache is keyed by index too, and goes with them.
		this.listOpts.entries = this.opts.places.entries;
		this.listOpts.currentIndex = this.opts.places.index;
		this.list.render();
	}

	// The pointer is on the list, so the list is being READ: hold the order it is showing. The
	// question is not which change was real but whether anyone is still looking, and the pointer is
	// that question's honest answer. Idempotent.
	private freezeOrder(): void {
		if (this.frozenOrder)
			return;
		const keys = this.list.orderedKeys();
		// An empty list holds nothing: holding `[]` would pin every later arrival to the front (see
		// groupByFile's rank).
		if (keys.length)
			this.frozenOrder = keys;
	}

	// The pointer has left: nobody is reading this list, so it may catch up with the places. The
	// redraw happens HERE — while the reader's attention is on the note they just opened — rather
	// than on the next history change, which may not come for minutes.
	private thawOrder(): void {
		if (!this.frozenOrder)
			return;
		this.frozenOrder = undefined;
		this.render();
	}

	// A chain the row was drawn without has been read out of the note's own text: the cache said
	// nothing at the time and the text has since. Coalesced (see LATE_READ_REDRAW_MS) rather than
	// left for the next redraw, which on a resident panel is the five-minute tick.
	private redrawAfterLateRead(): void {
		if (this.lateTimer !== undefined)
			return;
		this.lateTimer = window.setTimeout(() => {
			this.lateTimer = undefined;
			this.render();
		}, LATE_READ_REDRAW_MS);
	}

	// Throw away what belongs to this body: everything below was registered beside elements the
	// shell owns, and each of them outlives those elements.
	destroy(): void {
		// The menu stands on the DOCUMENT rather than in the panel's element, so a shell that closes
		// takes nothing of it with it.
		this.closeMenu();
		// The list put its tooltip on the document, so a body that goes without this leaves a stray
		// element behind for every dialog ever opened.
		this.list.destroy();
		// The metadata watcher belongs to the reads and outlives the DOM it was built beside: a
		// dialog is a new reads object every time it opens.
		this.reads.dispose();
		// A popover the app built is still the app's and outlives us, so uncovering what we hid is
		// ours to do before we go.
		this.settle.stop();
		if (this.timer !== undefined)
			window.clearInterval(this.timer);
		this.timer = undefined;
		// …and the redraw a late reading may still owe: it would redraw a list whose elements are
		// already gone.
		if (this.lateTimer !== undefined)
			window.clearTimeout(this.lateTimer);
		this.lateTimer = undefined;
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
	}

	private onVisibilityChange = (): void => {
		if (!document.hidden && this.opts.prefs.rowTime())
			this.render();
	};

	private onKeyDown(ev: KeyboardEvent): void {
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.list.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.list.move(-1);
		} else if (ev.key === 'Enter') {
			// Enter acts on the POSITION and on nothing else — the row the arrows walk — and with no
			// position it does nothing. The travel goes through the list, which is what knows which
			// row the position is on.
			//
			// 'Mod' is the app's platform-independent name for Cmd/Ctrl; reading metaKey/ctrlKey
			// here would be a second copy of that rule. The keyboard needs its own "new tab": the
			// focus never leaves the filter box, so the row's modifier-click is out of reach.
			const target = Keymap.isModifier(ev, 'Mod') ? 'tab' : undefined;
			if (this.list.travel(undefined, target))
				ev.preventDefault();
		}
	}

	// Tell assistive tech which option the keyboard is on. The focus never leaves the filter box, so
	// this attribute is the ONLY thing that makes the arrow keys audible — without it the box reads
	// as an empty text field.
	private setActiveRow(id: string | undefined): void {
		if (id)
			this.filterInput.setAttr('aria-activedescendant', id);
		else
			this.filterInput.removeAttribute('aria-activedescendant');
	}

	private toolbar(): void {
		const bar = this.opts.host.createDiv({ cls: 'position-restore-nav-toolbar' });
		// The box and its × are one control: the clear button is positioned against the box's own
		// line and hidden while there is nothing to clear.
		const strip = bar.createDiv({ cls: 'position-restore-nav-search' });
		const input = strip.createEl('input', {
			type: 'text',
			cls: 'position-restore-nav-filter',
			attr: {
				placeholder: t('recentFiles.searchPlaceholder'),
				// The box IS the list's keyboard: it keeps the focus while the arrow keys walk the
				// rows, so it is a combobox over the list (always expanded — the list is on screen,
				// not a popup) and the current option is reported through aria-activedescendant
				// instead of by moving focus.
				role: 'combobox',
				'aria-controls': this.listId,
				'aria-expanded': 'true',
				'aria-autocomplete': 'list',
			},
		});
		// What the reader typed IS the list's query, so the list is redrawn from it.
		const apply = (): void => {
			this.filter = input.value;
			this.render();
		};
		input.addEventListener('input', apply);
		this.filterInput = input;
		// THE ×: the press is REFUSED so the caret never leaves the box — a control that takes the
		// focus turns the next keystroke into nothing. A plain div and not a button, as the app's
		// own is: it is not a stop on the keyboard's way through the panel.
		const clear = strip.createDiv({
			cls: 'clickable-icon position-restore-nav-clear',
			attr: {
				'aria-label': t('recentFiles.clearFilter'),
				title: t('recentFiles.clearFilter'),
			},
		});
		setIcon(clear, 'x');
		clear.addEventListener('mousedown', (ev) => ev.preventDefault());
		clear.addEventListener('click', () => {
			if (input.value !== '') {
				input.value = '';
				apply();
			}
			// On TOUCH the focus is left as it was: summoning the on-screen keyboard over half the
			// panel is the opposite of what the tap asked for.
			if (!this.opts.touch)
				input.focus();
		});
	}

	// The section chain a place sits in, read at the line it is at NOW rather than the line it was
	// recorded at — the two halves have to come from the same "now".
	//
	// A chain read at a line number the file has moved out from under names the section a DIFFERENT
	// spot is in, and does so without moving, flashing, or anything else that would give it away:
	// the row quietly says "Beta" about a line now under "Alpha", and the preview opens Alpha. The
	// recorded number still stands for the ROW'S OWN WORDS: a few lines of drift inside one section
	// is not a different section.
	//
	// `prime` is false: a render of fifty rows must not read fifty files to label them. A chain that
	// arrives a render late arrives with the reading (see redrawAfterLateRead).
	private trailFor(entry: NavEntry, d: NavEntryDescription): string[] {
		if (entry.kind === 'view')
			return [];
		const line = nowLineFor(entry, d, this.nowLines, false) ?? d.lineIndex;
		if (line === undefined)
			return [];
		return headingTrailAtLine(this.reads.headingsFor(entry.path), line);
	}

	private jump(i: number, target?: PaneTarget): void {
		// The reader's place first where the shell is staying up: going to a place re-orders the
		// list and a jump re-pushes the stack, so a position left where it was would name whatever
		// slid into that slot.
		if (this.opts.collapseOnJump)
			this.list.collapse();
		// …then the shell's own reaction, so a dialog is out of the way before the open it triggers.
		this.shellReacts();
		void this.opts.places.travel(i, target)
			.catch(e => console.error('Position Restore: recent-files travel failed:', e));
	}

	// A row the pointer MOVED ONTO, handed over to the APP: asked, once, whether it would like to be
	// previewed.
	//
	// The app's own preview is ASKED FOR rather than rebuilt here. Every other place in Obsidian that
	// names a note is previewed by ONE core mechanism, answering the reader's one setting about it;
	// a preview of our own would be a second popover with second rules, open whether or not the
	// reader ever wanted one. Asking inherits everything, including "nothing happens".
	//
	// Nothing here is NAVIGATION: the places are untouched, no row moves, no list is drawn again. A
	// pathless view is not asked about — there is no page behind it.
	private hoverRow(rep: number, ev: PointerEvent, row: HTMLElement, file: boolean): void {
		const entry = this.opts.places.entries[rep];
		if (!entry || entry.kind === 'view')
			return;
		// WHERE THE ROW'S LINE IS TODAY, not where it was recorded: a line number is an address
		// rather than a place. When this panel cannot say, the asking carries no line at all and the
		// note opens at the app's own default. `prime` is true here, and only here: one hover may
		// wait one await for one file, and nothing is drawn with the answer.
		const line = nowLineFor(entry, this.reads.describe(rep), this.nowLines);
		const ask = this.previewAsk(entry, entry.path, file, line);
		this.opts.app.workspace.trigger('hover-link', {
			event: ev,
			// Who is asking: the id the plugin registered, which is what lets the app apply the
			// answer the reader gave THIS panel — and only that reading decides whether anything
			// opens at all.
			source: NAV_SOURCE_ID,
			hoverParent: this.hoverParent,
			// The ROW, and not the child the pointer landed on: the popover belongs to the line of
			// the list rather than to whichever word is crossed.
			targetEl: row,
			// The note by the path it is opened by — its own name on disk rather than the shortened
			// one printed on the row.
			linktext: ask.linktext,
			sourcePath: entry.path,
			state: ask.state,
		});
		// From here the asking is the settle's: armed with whether it named a line — the only kind
		// with a journey to cover — it watches for the app's answer for as long as the HOVER lasts,
		// not for as long as a guess would. The reader's key can come ten seconds after the row.
		this.settle.ask(ask.state !== undefined);
	}

	// HOW A ROW NAMES ITS SPOT: by the SECTION it sits in, or by its LINE NUMBER. The app decides
	// which. Handed a number (state.scroll), the popover draws the whole note first and moves the
	// scroller there once that render lands, flashing the target (see hover-settle.ts). Handed a
	// section (`note.md#Heading`) none of that happens: the loader draws ONLY that section.
	//
	// A NOTE'S OWN ROW NEVER NAMES A SECTION, WHATEVER HEADING ITS LINE SITS UNDER: the row stands
	// for the FILE, and a click opens the file the plain way. "The note" said as its third section
	// is a promise kept to nobody — a reader hovering "meeting-notes" and getting three paragraphs
	// of it has not been shown what they pointed at.
	//
	// A LANDING ROW is the other case: it names a place IN the note. Rows whose line has no heading
	// above it, or whose heading cannot be trusted to name the same place on the other side of the
	// link, fall back to the number — a wrong section delivered without moving once is worse than
	// the right place arriving late. A row whose line this panel cannot find names neither.
	private previewAsk(
		entry: NavEntry,
		path: string,
		file: boolean,
		line: number | undefined,
	): { linktext: string; state?: { scroll: number } } {
		const heading = file || line === undefined ? undefined : this.subpathHeading(entry, path, line);
		if (heading !== undefined)
			return { linktext: `${path}#${heading}` };
		return {
			linktext: path,
			// WHERE IN THE NOTE the preview opens is this panel's to say, and it is the one thing a
			// preview asked from here can offer that one asked elsewhere cannot: the popover opens
			// ON THAT LINE instead of at the note's head. `scroll` is the app's own name for a
			// markdown view's top visible line — the same number the position database keeps — so
			// nothing here invents a state shape. The number is TODAY's, not the recorded one.
			state: line === undefined ? undefined : { scroll: line },
		};
	}

	// The deepest heading over a line, when it can be TRUSTED to name the same section after the app
	// resolves `#heading` again. Two guards: the app takes the FIRST heading with that text, so a
	// note saying "Notes" twice would open the wrong one; and a heading carrying `#`, `^`, `|`, `[`
	// or `]` would be read as link syntax.
	//
	// What needs no guard is that the heading still exists — the trail is read from the cache, which
	// is the note as it stands NOW. What DOES need one is the LINE it is read at: the recorded
	// number names a different spot once the note is edited above it, so a heading is only ever read
	// here at a line already re-found.
	private subpathHeading(entry: NavEntry, path: string, line: number): string | undefined {
		if (entry.kind === 'view')
			return undefined;
		const headings = this.reads.headingsFor(path);
		const trail = headingTrailAtLine(headings, line);
		const deepest = trail[trail.length - 1];
		if (!deepest || UNTRAVELABLE.test(deepest))
			return undefined;
		if (headings && headings.filter(h => h.heading === deepest).length !== 1)
			return undefined;
		return deepest;
	}

	// The card THE APP HAS JUST OPENED, and the one thing about it this panel says.
	//
	// A preview asked for from the DIALOG opens behind that dialog: the core puts every popover on
	// the document's body and paints it at `--layer-popover` (30), while a modal container sits at
	// `--layer-modal` (50). The card answered, and every line of it is covered by the shell that
	// asked for it. No surface the core previews from is itself inside a dialog, and half of THIS
	// panel's surfaces are — so every card is lifted above the dialog layer rather than ONTO it,
	// because two elements sharing one z-index are ordered by which was appended last, and when that
	// happens is the app's business.
	private liftPreview(card: HTMLElement): void {
		card.addClass(PREVIEW_CLASS);
	}

	// A row was right-clicked: raise the APP's own menu for the file behind it, with OUR one entry
	// on top. What a reader can do with a file is the app's business, and a second list of those
	// commands here would be a stale copy. What is added is what the app cannot know: this row
	// stands for a PLACE, so "open in a new tab" here promises the landing this row stands for.
	//
	// The context asked for is the LINK one, not the file explorer's: a row is a pointer at a file
	// rather than the file in its own tree. A PATHLESS VIEW raises nothing: a file menu has no file
	// to be about — taking a row off the list is the × instead, which every row carries.
	//
	// A TOUCH DEVICE GETS HERE BY ANOTHER DOOR: a long press arms the row, so the menu is raised
	// from the armed row's own control. The two doors meet in the same place, which is why the menu
	// is placed by a POINT and not by the event.
	private contextRow(rep: number, at: MenuPositionDef): void {
		const entry = this.opts.places.entries[rep];
		// A pathless view has no file: the app's own menu for one has no subject.
		if (!entry || entry.kind === 'view')
			return;
		const file = this.opts.app.vault.getAbstractFileByPath(entry.path);
		if (!(file instanceof TFile))
			return;
		// ONE DOOR, TWO ENDS, and which one this tap is depends on whether a menu is already
		// standing. THE APP CANNOT ANSWER THIS TAP: the control stops its own press, so the press
		// never reaches the document and the app never hears the click-away that would close its
		// menu. Without this the tap would take the standing menu off and put it back in one breath.
		if (this.menu) {
			this.closeMenu();
			return;
		}
		const menu = new Menu();
		// Our own item goes FIRST ('action', which the app sorts ahead of its own sections): only
		// this list knows the landing the row stands for.
		menu.addItem(item => item
			.setSection('action')
			.setTitle(t(entry.kind === 'jump'
				? 'recentFiles.openHereInNewTab'
				: 'recentFiles.openInNewTab'))
			// The arrow leaving its box, not the glyph for a new file: nothing is created here, and
			// what opens is the row's own place one tab over.
			.setIcon('external-link')
			.onClick(() => this.jump(rep, 'tab')));
		this.opts.app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		this.menu = menu;
		// …and when the app takes it off by one of ITS OWN gestures, the control goes back to
		// raising one rather than taking one back.
		menu.onHide(this.forgetMenu);
		menu.showAtPosition(at);
		this.hearPresses(true);
	}

	// Take a standing menu off the screen. Asked by the control that raised it, by the shell stepping
	// out of the reader's way, and by destroy — everything ELSE a menu does is the app's business,
	// and these are the parts about this panel rather than about the file.
	closeMenu(): void {
		this.hearPresses(false);
		const menu = this.menu;
		this.menu = undefined;
		menu?.close();
	}

	// The app closed it itself: it is no longer ours to close.
	private forgetMenu = (): void => {
		this.hearPresses(false);
		this.menu = undefined;
	};

	// Whether a menu this body raised is standing — and if one is, TAKE IT BACK.
	//
	// Asked at the PRESS rather than at the click: by the time the click arrives, the app's menu may
	// be standing over the control that raised it. With no room below the point it was given, the
	// app moves a menu UP BY ITS OWN HEIGHT, which puts it over the row — and a press landing on the
	// menu's own surface reaches nobody.
	takeMenuBack(): boolean {
		if (!this.menu)
			return false;
		this.closeMenu();
		return true;
	}

	// While a menu stands, a press ANYWHERE that is not one of its own items takes it back —
	// including a press on the menu's own blank surface, which the app answers with nothing at all.
	//
	// HEARD IN THE CAPTURE PHASE AND AT THE DOCUMENT, the only place it can be heard before the menu
	// swallows it: the menu is put on the document's body rather than into this panel. A reader
	// aiming at the control is often aiming at the menu.
	private onAnyPress = (ev: Event): void => {
		if (!this.menu)
			return;
		const el = ev.target instanceof Element ? ev.target : null;
		// …but not on one of its ITEMS: that is the menu's own answer to give. Nor on the control
		// that raised it, which must find the menu still standing.
		if (el?.closest('.menu-item, .nav-row-menu'))
			return;
		this.closeMenu();
	};

	private hearPresses(on: boolean): void {
		const doc = this.opts.host.ownerDocument;
		if (!doc)
			return;
		if (on)
			doc.addEventListener('pointerdown', this.onAnyPress, true);
		else
			doc.removeEventListener('pointerdown', this.onAnyPress, true);
	}

	// The reader asked for a row to go, from the × on it. The KEY arrives WITH the × rather than
	// being worked out here: the control was built by the render that drew the row, so it carries
	// that row's identity rather than an index something may have moved under.
	//
	// The redraw is asked for HERE rather than left to the shells: a DIALOG does not subscribe to the
	// store, so a removal would otherwise leave the row standing until the dialog was reopened.
	private forgetRow(key: string): void {
		this.opts.places.forget(key);
		this.render();
	}

	// ONE LANDING taken off, from the × on its own row: the note and its other spots stay. What
	// arrives is a set of place KEYS rather than the row's index — which of a note's places one row
	// stands for is a question about the row as it was DRAWN.
	private forgetLanding(keys: string[]): void {
		this.opts.places.forgetLanding(keys);
		this.render();
	}

	// Run the shell's own reaction to a travel, and let NOTHING it does stop the journey behind it:
	// the reader asked to go somewhere, so a shell that throws must cost them the reaction, not the
	// travel.
	private shellReacts(): void {
		try {
			this.opts.onJump?.();
		} catch (e) {
			console.error('Position Restore: the panel shell failed to react to a travel:', e);
		}
	}
}
