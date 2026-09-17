// The history browser's BODY: everything about the panel that is not a shell.
//
// Two shells stand around it — the "Browse navigation history" modal
// (modal.ts) and the resident sidebar panel (view.ts) — and everything they
// have in common lives here: the toolbar, the tree of notes, the landing panel
// beside it (or under it), the keyboard, and travel. A shell owns its own
// lifetime and nothing else: when it opens, it mounts one of these into an
// element it owns and reads the presentation decision back out of its own
// geometry; when it closes, it destroys it. That is the whole of the
// difference between a dialog and a sidebar here, and it is why travel is a
// callback (see onJump): the modal puts the panel away when the reader goes
// somewhere, the sidebar stays.
//
// Every other piece is a module beside this one:
//   - constants.ts          the tuning numbers
//   - model.ts / listing.ts / panes.ts   the pure model
//   - reads.ts              every vault read, cached
//   - list.ts               the tree of notes, the position, the travel arrow
//   - landing-panel.ts      the landing described: head, trail, content switch
//                           and the travel button — the right-hand drawer on a
//                           pointing device, the in-flow panel when there is no
//                           room for two columns
//   - preview-content.ts    what that panel draws: the recorded lines, or the
//                           whole note, through Obsidian's markdown renderer
//   - markdown.ts           the recorded lines dressed as markdown for it
// The name says BROWSER because the history itself — how a step is recorded,
// persisted and restored — is the rest of nav-history/ (history.ts, entry.ts,
// store.ts, outline-capture.ts), which this panel only reads and never writes.
//
// READ-ONLY, and that is what makes a RESIDENT panel possible at all: the body
// draws whatever the stack holds at the moment render() is called. The list's
// own snapshot is refreshed from the stack on every render (see render), so a
// shell that lives for hours shows the history as it stands rather than as it
// stood when the panel opened — and one that lives for a second (the modal) is
// not asked for anything more.

import { App, FileView } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { NavHistoryEntry, RECORDABLE_VIEW_TYPES } from '@/nav-history/entry';
import { isMainAreaLeaf, leafIdOf } from '@/shared/leaf';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { headingTrailAtLine, NavEntryDescription } from './model';
import { LiveLeaf, PaneInfo, paneInfo, paneLabel, viewDestinationKey } from './panes';
import { NavHistoryReads } from './reads';
import { LandingPanel } from './landing-panel';
import { NavPreviewContent } from './preview-content';
import { NavHistoryList, NavHistoryListOptions } from './list';

// Per-body sequence for the list element's id (see NavHistoryBrowser.listId).
let browserSeq = 0;

export interface NavHistoryBrowserOptions {
	app: App;
	// The history the rows are drawn from. One snapshot per render (see render),
	// never a copy held across it.
	nav: NavHistory;
	// The element the body builds itself into. Its size is the shell's business;
	// the body only fills it.
	host: HTMLElement;
	// The file's saved record, for an entry carrying no position of its own.
	savedPosition?: (path: string) => EphemeralState | undefined;
	// Whether the panel is driven by discrete clicks rather than by hover: a finger,
	// and the resident sidebar panel, where the reader asked for a list that does not
	// change under a passing mouse. It picks the list's whole interaction mode (see
	// NavHistoryListOptions.tap) — with no hover, one click says everything a click
	// can say (a note opens its landings, a landing is pointed at, a second click puts
	// the panel away), and travel is the row's own arrow or the landing panel's button.
	// Read once by the shell, because it is a decision about the SHELL, not about the
	// pane's width. The arrow is the same in both modes, so no shell loses its way to
	// go somewhere.
	tap: boolean;
	// Whether this device is a touch device. A different question from `tap`: it is
	// about the device's own ergonomics — an on-screen keyboard that covers half a
	// phone when a field takes focus, and the wording of the hint ("tap" for a
	// finger, "click" for a pointer driving the same tap-mode list).
	touch: boolean;
	// Whether a travel COLLAPSES the reader's place in the tree first: every note
	// closed, nothing pointed at, before the history is asked to move.
	//
	// A shell that stays up needs it (see view.ts). The jump rewrites the stack and
	// pins the note it landed on first, so the note the reader had opened is about to
	// be a different note in the same slot — and the panel that was describing one
	// landing would come back describing another. The dialog says no: it closes on the
	// first travel (see onJump) and never redraws.
	collapseOnJump: boolean;
	// Whether the landing panel opens INSIDE the list, under the row it describes,
	// instead of standing beside it as a second column (see LandingPanel). Asked
	// on every render, because the answer can change while the body is up: see
	// the modal's width listener and the view's own measurement.
	inline: () => boolean;
	// Whether the filter box takes the focus as soon as the body is mounted. A
	// dialog wants it (typing is the fastest way through the list, and the
	// dialog was opened on purpose); a resident panel must not (it is restored
	// with the workspace, and stealing the caret out of the editor to open a
	// sidebar is not something the reader asked for).
	focusFilter: boolean;
	// The shell's own reaction to a travel, run BEFORE the history is asked to
	// move: the modal closes here (a picker has answered its question), the
	// sidebar does nothing (staying put is the whole point of it).
	onJump?: () => void;
}

export class NavHistoryBrowser {
	// The list of steps, its rows and what is pointed at (see NavHistoryList).
	private list!: NavHistoryList;
	// The list's options object, kept because two of its fields are the LIVE
	// stack and are re-pointed before every render (see render): the list reads
	// its entries through this object, so a resident panel is refreshed by
	// assigning to it rather than by rebuilding the list (which would drop the
	// open notes and the aimed-at landings).
	private listOpts!: NavHistoryListOptions;
	// The search box's text. The list's own query.
	private filter = '';
	private previewEl!: HTMLElement;
	// Where the preview panel waits when it has no row to open under (inline).
	private previewHost!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private panes: PaneInfo = { live: new Map() };
	// Every vault lookup the panel makes, cached: an entry's display pieces, a
	// file's parsed headings, the end of a file's frontmatter, and a file's text
	// (see reads.ts).
	private reads: NavHistoryReads;
	// The landing panel: the standing second column beside the list, or the in-flow
	// panel under the pointed-at row (see LandingPanel).
	private panel!: LandingPanel;
	// What the panel draws as the landing's content: the recorded lines, or the
	// whole note, both through Obsidian's own markdown renderer (see
	// PreviewContent). Owned here, because the rendered DOM and the components
	// hung on it have to be unloaded when the body goes (see destroy).
	private content: NavPreviewContent;
	// The list element's id, unique per body: the rows' option ids are built
	// from it and the filter box's aria-activedescendant points at one of them,
	// so a second browser mounted beside this one — a sidebar panel and the
	// modal at once — cannot collide with it.
	private readonly listId = `position-restore-nav-list-${++browserSeq}`;

	constructor(private opts: NavHistoryBrowserOptions) {
		this.reads = new NavHistoryReads(opts.app, opts.nav, {
			savedPosition: opts.savedPosition,
		});
		this.content = new NavPreviewContent({
			app: opts.app,
			// The browser's only vault read: the panel's whole-note view of a note,
			// and the source view of a file that is not one (see NavHistoryReads.textFor).
			read: path => this.reads.textFor(path),
			// …and the metadata lookup that keeps a recorded block starting inside
			// the properties from rendering as a heading rule (see contextMarkdown).
			frontmatterEnd: path => this.reads.frontmatterEnd(path),
			// Inline, the panel shares the list's scroll, so putting the landing on
			// screen must not move it (see NavPreviewContent's option).
			inline: () => opts.inline(),
		});
	}

	// Build the toolbar and the body inside the shell's element. One call per
	// body: the toolbar is NOT rebuilt per render, so the filter input keeps its
	// focus and its caret while typing redraws the list underneath it.
	mount(): void {
		this.toolbar();
		// The list, and the landing panel. With the drawer the panel IS the body's
		// second column (see styles.css) and follows the position. Inline it does not
		// stay there: it opens UNDER the row it describes, inside the list's
		// own scroll (see LandingPanel.render) — a panel parked at the bottom of
		// the dialog runs out of room the moment there is history to scroll, and
		// then the one control that can travel with a finger (its "jump here"
		// button) is off-screen.
		const body = this.opts.host.createDiv({ cls: 'position-restore-nav-body' });
		const listEl = body.createDiv({ cls: 'position-restore-nav-list' });
		// The list is a listbox whose options are the rows (the list tags them;
		// see NavHistoryList.row) and whose current option the filter box names
		// through aria-activedescendant (see setActiveRow). The id is what makes
		// that reference possible, and the label is the panel's own name.
		listEl.setAttr('id', this.listId);
		listEl.setAttr('role', 'listbox');
		listEl.setAttr('aria-label', t('navHistory.overview.name'));
		this.listOpts = {
			list: listEl,
			listId: this.listId,
			tap: this.opts.tap,
			// The live stack, re-pointed per render (see render).
			entries: this.opts.nav.entries,
			currentIndex: this.opts.nav.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			noteExists: path => this.reads.hasFile(path),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			onPointed: () => this.panel.render(),
			onActiveRow: id => this.setActiveRow(id),
			onRevealPanel: () => this.panel.reveal(),
			onTravel: rep => this.jump(rep),
		};
		this.list = new NavHistoryList(this.listOpts);
		this.previewEl = body.createDiv({ cls: 'position-restore-nav-preview' });
		// Where the panel waits while it has no row to open under.
		this.previewHost = body;
		this.panel = new LandingPanel({
			panel: this.previewEl,
			parkAt: this.previewHost,
			list: listEl,
			inline: () => this.opts.inline(),
			position: () => this.list.position,
			here: () => this.opts.nav.index,
			standsFor: rep => this.list.standsFor(rep),
			entryAt: rep => this.opts.nav.entries[rep],
			anchorRow: () => this.list.panelAnchor(),
			noteRowOf: row => this.list.noteRowOf(row),
			onPreviewed: rep => this.list.markPreviewed(rep),
			describe: rep => this.reads.describe(rep),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			content: (host, mode, entry, d) => this.content.show(host, mode, entry, d),
			jump: rep => this.jump(rep),
		});
		// One keydown listener on the shell's own element covers both the filter
		// input and the list: while typing, arrows navigate and Enter jumps (the
		// input would otherwise move its caret); Escape stays native (closes the
		// dialog, and in a sidebar does nothing, which is what "resident" means).
		this.opts.host.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		this.render();
		// A touch device raises its on-screen keyboard the moment an input takes
		// focus, and the keyboard covers half of a small screen — the panel's
		// whole reason for being is the list under it. So on touch the box stays
		// unfocused (one tap away, when the user actually means to type); on a
		// pointing device the keyboard costs nothing and typing is the fastest
		// way through the list, so it keeps the focus.
		if (this.opts.focusFilter && !this.opts.touch && this.opts.nav.entries.length > 0)
			this.filterInput.focus();
	}

	// (Re)draw everything the stack and the filter decide. Called by the shell
	// when it mounts, by the modal when the window crosses the width the drawer
	// needs, and — for a resident panel — every time the history changes (see
	// NavHistory.subscribe).
	render(): void {
		// The stack as it stands NOW, before anything reads it: the list holds
		// its options object across renders, and the panel resolves "here" and
		// the entries by index, so a history that moved under a resident panel
		// is picked up by re-pointing these two fields and nothing else. The
		// describe cache goes with them — it is keyed by index, and an index
		// means another entry the moment the stack is truncated or pruned.
		this.listOpts.entries = this.opts.nav.entries;
		this.listOpts.currentIndex = this.opts.nav.index;
		this.panes = paneInfo(this.liveLeaves());
		// The list first (it rebuilds rows, the selection and the panel), then the
		// panel around it.
		this.list.render();
		this.panel.render();
	}

	// Throw away what belongs to this body and nothing else: the rendered
	// preview and everything hung on it (embeds, math, plugin children). The
	// shell calls this from its own teardown.
	destroy(): void {
		this.content.destroy();
	}

	private onKeyDown(ev: KeyboardEvent): void {
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.list.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.list.move(-1);
		} else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
			// The tree's own moves: close and open the note under the position,
			// which is what a row's single click does and the vertical walk
			// cannot. Only an open/close is consumed — the left and right arrows
			// keep their ordinary meaning in the filter box otherwise.
			if (this.list.handleKey(ev))
				ev.preventDefault();
		} else if (ev.key === 'Enter') {
			// Enter acts on the POSITION and on nothing else — the one row the mouse
			// moves by hovering and the arrows by walking (see the list's choose) — and
			// with no position it does nothing. (It used to fall back to "go back one
			// step", which made one key mean two things depending on whether the pointer
			// had crossed a row — and duplicated the app's own back command.)
			// The travel goes through the list, which is what knows whether the
			// row the position is on may be travelled to: a note whose file is gone
			// opens (and is where "file deleted" is explained) but never jumps.
			if (this.list.travel())
				ev.preventDefault();
		}
	}

	// Tell assistive tech which option the keyboard is on. The focus never
	// leaves the filter box, so this attribute is the ONLY thing that makes the
	// arrow keys audible — without it the box reads as an empty text field while
	// the user walks the list.
	private setActiveRow(id: string | undefined): void {
		if (id)
			this.filterInput.setAttr('aria-activedescendant', id);
		else
			this.filterInput.removeAttribute('aria-activedescendant');
	}

	// The toolbar is built once (not per render), so the filter input keeps
	// its focus and caret while typing re-renders the list underneath.
	private toolbar(): void {
		const bar = this.opts.host.createDiv({ cls: 'position-restore-nav-toolbar' });
		const input = bar.createEl('input', {
			type: 'text',
			cls: 'position-restore-nav-filter',
			attr: {
				placeholder: t('navHistory.searchPlaceholder'),
				// The box IS the list's keyboard: it keeps the focus while the
				// arrow keys walk the rows, so it is a combobox over the list
				// (always expanded — the list is on screen, not a popup) and the
				// current option is reported through aria-activedescendant (see
				// setActiveRow) instead of by moving focus.
				role: 'combobox',
				'aria-controls': this.listId,
				'aria-expanded': 'true',
				'aria-autocomplete': 'list',
			},
		});
		input.addEventListener('input', () => {
			this.filter = input.value;
			// The list and the panel both follow the filter, so the
			// whole body re-renders (the toolbar does not).
			this.render();
		});
		this.filterInput = input;
		// The hint, and nothing else: the box is the whole toolbar. The file
		// scope that used to sit beside it — a "only this note" switch and a chip
		// of every note the history had been in — is gone: a note's name is text
		// the box already matches, so the two controls were a slower way to type
		// it, and they cost the list the width and the row they stood on.
		// What the panel can be driven by is the whole difference between the modes,
		// so the hint names the gestures the reader actually has: a finger's tap on a
		// touch device, a click in the resident panel (which uses the same tap-mode
		// list for a pointer — see `tap`), and the keyboard where the list follows the
		// mouse as well.
		bar.createSpan({
			cls: 'position-restore-nav-hint',
			text: t(this.opts.touch ? 'navHistory.touchHint'
				: this.opts.tap ? 'navHistory.clickHint' : 'navHistory.keyboardHint'),
		});
	}

	// The "you are here" CARD that used to stand between the toolbar and the list
	// is gone. The current entry is a row in the tree like any other — pinned
	// first, marked `●` — and the card said the same thing a second time, in a
	// second place, in a second layout: one line of chrome bought with the height
	// the list needed, and a reader had to learn which of the two "current
	// position"s was authoritative. The row is.

	// The heading chain the entry's landing sits in. Empty for a view entry, a
	// deleted file, or an entry with no recorded line.
	private trailFor(entry: NavHistoryEntry, d: NavEntryDescription): string[] {
		if (entry.kind === 'view' || d.missing || d.lineIndex === undefined)
			return [];
		return headingTrailAtLine(this.reads.headingsFor(entry.path), d.lineIndex);
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
		this.opts.app.workspace.iterateAllLeaves((leaf) => {
			// A sidebar panel holding the tracked note is not a second window of
			// it for this purpose: it is not a tab the reader switches between,
			// and the history never records it either. This plugin's own sidebar
			// panel is not even a FileView, so it could not be mistaken for one.
			if (!isMainAreaLeaf(this.opts.app, leaf))
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

	private jump(i: number): void {
		// The tree first where the shell is staying up: the jump is about to rewrite the
		// stack, and a tree that redraws from the reader's old open notes would open
		// whatever slid into their slots (see the option). The panel is forgotten before
		// the list, because clearing the position redraws it.
		if (this.opts.collapseOnJump) {
			this.panel.forget();
			this.list.collapse();
		}
		// …then the shell's own reaction, so a dialog is out of the way before
		// the open it triggers runs (see NavHistoryBrowserOptions.onJump).
		this.opts.onJump?.();
		void this.opts.nav.jumpTo(i)
			.catch(e => console.error('Position Restore: history jump failed:', e));
	}
}
