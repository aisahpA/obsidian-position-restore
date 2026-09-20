// The history browser's BODY: everything about the panel that is not a shell.
//
// Two shells stand around it — the "Browse navigation history" modal
// (modal.ts) and the resident sidebar panel (view.ts) — and everything they
// have in common lives here: the toolbar, the list of notes, the landing panel
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
//   - list.ts               the list of notes, the position, the row's own gutter
//                           control
//   - landing-panel.ts      the landing described: head, trail, caption and the
//                           content itself — the right-hand drawer on a pointing
//                           device, the in-flow panel when there is no room for two
//                           columns. WHICH content is a setting, chosen in the
//                           toolbar's gear (see settings)
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

import { App, FileView, setIcon } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { NavHistoryEntry, RECORDABLE_VIEW_TYPES } from '@/nav-history/entry';
import { isMainAreaLeaf, leafIdOf } from '@/shared/leaf';
import { EphemeralState, LandingsMode } from '@/types';
import { t } from '@/i18n';
import { headingTrailAtLine, NavEntryDescription } from './model';
import { LiveLeaf, PaneInfo, paneInfo, paneLabel, viewDestinationKey } from './panes';
import { NavHistoryReads } from './reads';
import { LandingPanel } from './landing-panel';
import { NavPreviewContent, PreviewMode } from './preview-content';
import { NavHistoryList, NavHistoryListOptions } from './list';

// Per-body sequence for the list element's id (see NavHistoryBrowser.listId).
let browserSeq = 0;

// Where a hint's text wants the row's gutter glyph drawn into it (see `hint`). Written
// into the locale strings rather than assembled from fragments, so a translation can
// put the icon where its own sentence needs it — in front of the verb, after it, or
// in the middle.
const HINT_ICON = '{arrow}';

// The preferences the browser ITSELF owns, handed to every shell by the plugin
// that persists them (see PluginSettings and PositionManager.browserPrefs). All are
// READERS over the one shared settings object rather than values: a resident panel
// draws its list from a call made during render, so a change made in the panel is
// picked up by the next history change instead of being frozen into the panel that
// happened to be open. All also come as a pair — read plus write — because the
// panel is where each of them is CHOSEN: the content by the switch above the
// landing's lines (see LandingPanel), the list's shape and whether the details
// column exists at all by the toolbar's own setting (see
// NavHistoryBrowser.settings).
export interface NavBrowserPrefs {
	// Which content a landing opens on (see PreviewMode).
	previewMode: () => PreviewMode;
	// The panel's own switch: remember the reader's choice, for good.
	setPreviewMode: (mode: PreviewMode) => void;
	// How much of one note the list prints (see LandingsMode).
	landings: () => LandingsMode;
	// The toolbar's setting: still the plugin's choice to keep (see setPreviewMode).
	setLandings: (mode: LandingsMode) => void;
	// Whether the browser describes a landing at all (see
	// PluginSettings.navShowDetails): the row's gutter control, the panel it opens,
	// and the half of the hint that names it. Off by default, and the one preference
	// here whose off state takes a control AWAY from the list rather than shaping it —
	// which is why the browser asks it on every render (see render) and not once.
	showDetails: () => boolean;
	setShowDetails: (on: boolean) => void;
}

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
	// Whether this device is a touch device. It is about the device's own
	// ergonomics and nothing else — an on-screen keyboard that covers half a phone
	// when a field takes focus, and the wording of the hint ("tap" for a finger,
	// "click" for a mouse). The list's own interaction is the same either way: it is
	// click-only on every device (see NavHistoryList).
	touch: boolean;
	// Whether a travel CLEARS the reader's place in the list first: nothing pointed
	// at before the history is asked to move.
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
	// The browser's own preferences, handed down by the shell (see NavBrowserPrefs):
	// whether a landing is described at all, which content that description shows, and
	// how much of a note the list prints.
	prefs: NavBrowserPrefs;
}

export class NavHistoryBrowser {
	// The list of steps, its rows and what is pointed at (see NavHistoryList).
	private list!: NavHistoryList;
	// The list's options object, kept because two of its fields are the LIVE
	// stack and are re-pointed before every render (see render): the list reads
	// its entries through this object, so a resident panel is refreshed by
	// assigning to it rather than by rebuilding the list (which would drop the
	// aimed-at landings).
	private listOpts!: NavHistoryListOptions;
	// The search box's text. The list's own query.
	private filter = '';
	private previewEl!: HTMLElement;
	// Where the preview panel waits when it has no row to open under (inline).
	private previewHost!: HTMLElement;
	// The body element itself, kept because whether the details column exists is a fact
	// about the body's LAYOUT (see styles.css): the column is taken out of the DOM's
	// flow there, and the list takes the width it leaves.
	private bodyEl!: HTMLElement;
	private filterInput!: HTMLInputElement;
	// The hint's own line, kept so that it can be rewritten when the details column is
	// switched (see fillHint): the toolbar is built once and never redrawn, and a
	// sentence still naming the row's gutter control after the control has gone would
	// be the one line on the strip that lies.
	private hintEl!: HTMLElement;
	// The toolbar's own setting: the button in the strip's far corner, the small panel
	// it opens (undefined while it is closed), and the press-outside listener that
	// dismisses it. Held because only one may be up, and because that listener has to
	// come off the document when the panel closes or the body goes (see destroy).
	private settingsBtn!: HTMLElement;
	private settingsMenu?: HTMLElement;
	private dismissSettings?: (ev: Event) => void;
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

	// Whether the browser describes a landing at all (see
	// NavBrowserPrefs.showDetails): read live, because the reader switches it while
	// looking at the list it changes (see pickDetails).
	private get details(): boolean {
		return this.opts.prefs.showDetails();
	}

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
			// A link inside the rendered content goes through the browser's own
			// navigation seam, so it lands the way a travel does (see follow).
			follow: (linktext, sourcePath) => this.follow(linktext, sourcePath),
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
		// then the lines it exists to show are off-screen.
		const body = this.opts.host.createDiv({ cls: 'position-restore-nav-body' });
		this.bodyEl = body;
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
			// …and the device's own ergonomics again, for the one thing the list decides
			// itself rather than styling: how big the gutter control's glyph is under a
			// finger (see NavHistoryList.disclose).
			touch: this.opts.touch,
			// How much of a note to print: read LIVE (see NavBrowserPrefs), so the
			// toolbar's setting reaches a panel that is already up.
			landings: () => this.opts.prefs.landings(),
			// Whether a row carries the gutter control that asks for its details: read
			// LIVE for the same reason, and asked per ROW, so switching it redraws the
			// list into the other shape rather than leaving controls for a panel that is
			// no longer drawn (see NavBrowserPrefs.showDetails).
			disclose: () => this.details,
			// The live stack, re-pointed per render (see render).
			entries: this.opts.nav.entries,
			currentIndex: this.opts.nav.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			noteExists: path => this.reads.hasFile(path),
			trailFor: (entry, d) => this.trailFor(entry, d),
			paneName: entry => this.paneName(entry),
			// The panel's own two entries from the list: both are asked only while the
			// details column exists, so a click that points at a row — or that asks for
			// the row's own panel — costs nothing when the reader has switched it off.
			onPointed: () => {
				if (this.details)
					this.panel.render();
			},
			onActiveRow: id => this.setActiveRow(id),
			onRevealPanel: () => {
				if (this.details)
					this.panel.reveal();
			},
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
			// Which content the panel shows: the plugin's own preference, read live. The
			// choice itself is made in the toolbar's gear (see settings).
			previewMode: () => this.opts.prefs.previewMode(),
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
		// Whether the details column exists at all, said on the BODY before anything is
		// drawn: it is a fact about the layout (the column leaves the flow and the list
		// takes the width — see styles.css), and the panel is only drawn where there is
		// a place to draw it.
		this.bodyEl.toggleClass('is-no-details', !this.details);
		// The list first (it rebuilds rows, the selection and the panel), then the
		// panel around it.
		this.list.render();
		if (this.details)
			this.panel.render();
		else
			this.panel.putAway();
	}

	// Throw away what belongs to this body and nothing else: the rendered
	// preview and everything hung on it (embeds, math, plugin children), and the
	// toolbar's setting if it happens to be open — its press-outside listener lives
	// on the document, which outlives every panel (see the shell's teardown).
	destroy(): void {
		this.closeSettings();
		this.content.destroy();
	}

	private onKeyDown(ev: KeyboardEvent): void {
		// The toolbar's setting goes first, and the key STOPS here: a reader pressing
		// Escape at an open setting is putting THAT away, not closing the dialog it
		// happens to be standing in.
		if (ev.key === 'Escape' && this.closeSettings()) {
			ev.preventDefault();
			ev.stopPropagation();
			return;
		}
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.list.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.list.move(-1);
		} else if (ev.key === 'Enter') {
			// Enter acts on the POSITION and on nothing else — the one row a click
			// puts the panel on and the arrows walk (see the list's choose) — and
			// with no position it does nothing. (It used to fall back to "go back one
			// step", which made one key mean two things depending on whether the pointer
			// had crossed a row — and duplicated the app's own back command.)
			// The travel goes through the list, which is what knows whether the
			// row the position is on may be travelled to: only a deleted note
			// refuses (it is where "file deleted" is explained, so it opens the
			// details but never jumps) — the place the reader is already in
			// travels like any other row (see list.targetOf).
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
		// The hint, and then the panel's settings at the far end of the strip. The
		// file scope that used to sit between them — a "only this note" switch and a
		// chip of every note the history had been in — is gone: a note's name is text
		// the box already matches, so the two controls were a slower way to type
		// it, and they cost the list the width and the row they stood on.
		// What the panel can be driven by is what the hint names: a finger's tap on a
		// touch device, and a click everywhere else — the same list, the same two
		// gestures per row (open it, or look at it), whether the room around it is a
		// dialog or a sidebar. The second of those two gestures is the details column
		// itself, so a reader who switched that off reads a one-gesture sentence (see
		// fillHint). (The keyboard's own keys still work in both: the hint names the
		// gestures a reader has to be TOLD about, and the control in front of every row
		// is the one this panel is built on.)
		this.hint(bar);
		this.settings(bar);
	}

	// The hint, with the row's own gutter glyph DRAWN into it.
	//
	// The hint tells the reader to use that control, so the line has to show the glyph
	// the rows actually carry: a typed stand-in is a different shape from the icon —
	// "↪" is a text character with a hook, the icon is a squared corner — and a phone
	// reported exactly that mismatch, reading the sentence and then looking for an
	// arrow that was not on the list. The locale keeps the icon's PLACE in the
	// sentence (see HINT_ICON), so each language puts it where its own grammar wants
	// it — both of the sentences that name the control draw it.
	//
	// The line is written from the SETTING, and rewritten when the setting changes
	// (see fillHint): the second half of the sentence names the row's gutter control,
	// and whether that control exists at all is exactly the details column's own
	// preference. What the line never follows is any OTHER setting — a row opens the
	// same way whatever the list prints — so switching those leaves it alone.
	private hint(bar: HTMLElement): void {
		this.hintEl = bar.createSpan({ cls: 'position-restore-nav-hint' });
		this.fillHint();
	}

	// (Re)write the hint's line: one sentence per DEVICE, and — where the details
	// column is switched off (see showDetails) — a sentence that names only the click,
	// because the control the other one names is not on the list.
	private fillHint(): void {
		const line = this.hintEl;
		line.empty();
		const details = this.details;
		const key = details
			? this.opts.touch ? 'navHistory.touchHint' : 'navHistory.clickHint'
			: this.opts.touch ? 'navHistory.touchHintOpen' : 'navHistory.clickHintOpen';
		const parts = t(key).split(HINT_ICON);
		for (let i = 0; i < parts.length; i++) {
			// The icon stands between two runs of text, so the odd slots are the ones
			// the control goes in front of. (A sentence with no control in it has one
			// part and no icon, which is the one case this loop draws nothing.)
			if (i > 0) {
				// Not announced: the sentence around it already says what it does, and a
				// screen reader has ↑↓ for the same thing (see the list's move).
				const icon = line.createSpan({ cls: 'nav-hint-icon', attr: { 'aria-hidden': 'true' } });
				setIcon(icon, 'chevron-right');
			}
			line.appendText(parts[i]);
		}
	}

	// THE TOOLBAR'S SETTINGS: the small button at the strip's far end, and the panel it
	// opens over the list. Three choices — whether the list describes a landing at all,
	// how much of a note it prints, and which content that description shows.
	//
	// It stands here rather than in the settings tab because this is where the
	// questions are asked — a reader decides how long the list should be while looking
	// at it, whether they want a row's details while looking at the list, and which of
	// the two contents they want while reading one — and because the panel is a DIALOG
	// as often as it is a sidebar: a settings row would be the only way to reach a
	// choice about something that is not on screen at the time. It leaves the settings
	// tab with no second copy of any of these values that could drift from this one.
	//
	// The panel is plain DOM and not the app's own Menu: each choice is a radio group
	// of two — or, for the one question with two answers of its own, a single check row
	// — every answer carrying its own few words beside it, which a menu cannot carry.
	private settings(bar: HTMLElement): void {
		const btn = bar.createEl('button', {
			cls: 'clickable-icon position-restore-nav-settings',
			type: 'button',
			attr: {
				// The button is the only label the panel needs, and a gear is not a word:
				// the name is for the reader who has to have it said and for the tooltip.
				'aria-label': t('navHistory.listSettings'),
				'aria-haspopup': 'true',
				'aria-expanded': 'false',
				title: t('navHistory.listSettings'),
			},
		});
		setIcon(btn, 'settings-2');
		this.settingsBtn = btn;
		btn.addEventListener('click', () => {
			if (this.settingsMenu)
				this.closeSettings();
			else
				this.openSettings(bar);
		});
	}

	// Open the settings under the button: each choice is the name of the choice and its
	// answer(s), every answer carrying its own few words.
	//
	// The details column's own choice comes BEFORE the content group, and that group is
	// drawn only while the column exists: "which content should the panel show" is a
	// question with no panel to answer it, and the switch that took the column away is
	// the way back to it.
	private openSettings(bar: HTMLElement): void {
		const menu = bar.createDiv({
			cls: 'position-restore-nav-settings-menu',
			attr: { role: 'group', 'aria-label': t('navHistory.listSettings') },
		});
		this.settingGroup<LandingsMode>(menu, t('navHistory.landings.name'), [
			{
				value: 'last',
				label: t('navHistory.landings.options.last'),
				desc: t('navHistory.landings.options.last.desc'),
			},
			{
				value: 'all',
				label: t('navHistory.landings.options.all'),
				desc: t('navHistory.landings.options.all.desc'),
			},
		], this.opts.prefs.landings(), mode => this.pickLandings(mode));
		this.settingCheck(menu, t('navHistory.details.name'), this.details,
			t('navHistory.details.show'), t('navHistory.details.show.desc'),
			on => this.pickDetails(on));
		// …and the content the column prints: only a question while the column exists,
		// so with the switch off this is the last group the menu has.
		if (this.details) {
			this.settingGroup<PreviewMode>(menu, t('navHistory.preview.name'), [
				{
					value: 'spot',
					label: t('navHistory.preview.spot'),
					desc: t('navHistory.preview.spot.desc'),
				},
				{
					value: 'note',
					label: t('navHistory.preview.note'),
					desc: t('navHistory.preview.note.desc'),
				},
			], this.opts.prefs.previewMode(), mode => this.pickPreviewMode(mode));
		}
		this.settingsMenu = menu;
		this.settingsBtn.setAttr('aria-expanded', 'true');
		this.watchDismiss(menu);
	}

	// Anything outside the setting — the list, the filter box, the rest of the app —
	// puts it away. On the DOCUMENT and in the CAPTURE phase, so that it is gone before
	// the press it belongs to reaches whatever it landed on.
	private watchDismiss(menu: HTMLElement): void {
		const dismiss = (ev: Event) => {
			const target = ev.target as Node | null;
			if (target && (menu.contains(target) || this.settingsBtn.contains(target)))
				return;
			this.closeSettings();
		};
		this.dismissSettings = dismiss;
		document.addEventListener('mousedown', dismiss, true);
	}

	// One choice in the menu: its name, and its answers under it — each answer saying
	// what it means in a few words of its own, right after the word itself.
	//
	// The note used to stand under the group as one paragraph, a line per answer: two
	// short rows and then a wall of small print, which the reader had to pick apart to
	// find which sentence belonged to which answer, in a menu that is already the
	// width of the words it holds. Written after its own option, each answer's few
	// words are read where the answer is, and the paragraph that had to name its
	// options before it could say anything is gone.
	private settingGroup<T extends string>(
		menu: HTMLElement,
		title: string,
		options: { value: T; label: string; desc: string }[],
		current: T,
		pick: (value: T) => void,
	): void {
		const box = menu.createDiv({ cls: 'nav-settings-group' });
		box.createDiv({ cls: 'nav-settings-title', text: title });
		const group = box.createDiv({
			cls: 'nav-settings-options',
			attr: {
				// A radio group rather than a menu of commands: what is being chosen is
				// one of two answers, and the reader has to be able to hear WHICH one is
				// in force without opening the list to look at its shape.
				role: 'radiogroup',
				'aria-label': title,
			},
		});
		for (const option of options) {
			const checked = option.value === current;
			const row = group.createEl('button', {
				cls: 'nav-settings-option',
				type: 'button',
				attr: { role: 'radio', 'aria-checked': String(checked) },
			});
			// The value in force says so a second time, with a mark: the tint alone is a
			// fact a theme can take away (see styles.css), and this is the one cue left
			// when two backgrounds come out nearly the same. The mark's SLOT is written
			// on every row whether or not it holds a glyph — in front of the label, so
			// the two labels start on one x instead of the unticked one pulling left.
			const tick = row.createSpan({ cls: 'nav-settings-tick', attr: { 'aria-hidden': 'true' } });
			if (checked)
				setIcon(tick, 'check');
			row.createSpan({ cls: 'nav-settings-label', text: option.label });
			// The answer's few words travel in the row's own control, so they are part
			// of what the option is called when it is announced as well as of what is
			// read on screen. The BRACKETS around them are the locale's and not this
			// line's: which pair to draw is the language's own call, and the text here
			// is taken as it was written.
			row.createSpan({ cls: 'nav-settings-option-desc', text: option.desc });
			row.addEventListener('click', () => pick(option.value));
		}
	}

	// One choice in the menu that has two answers of its own: the question's name, and
	// ONE row under it that says whether the thing is on.
	//
	// A check row rather than a pair of answers, which is what the groups above are:
	// "show it" and "hide it" are not two things a reader is choosing between, and the
	// second would be a row of the menu spent saying "no". The mark's slot is the
	// group's usual one (see settingGroup), so the row lines up with the answers above
	// and below it, and the row is a checkbox to assistive tech so that its state is
	// read the same way the radios' is.
	private settingCheck(
		menu: HTMLElement,
		title: string,
		on: boolean,
		label: string,
		desc: string,
		pick: (on: boolean) => void,
	): void {
		const box = menu.createDiv({ cls: 'nav-settings-group' });
		box.createDiv({ cls: 'nav-settings-title', text: title });
		const group = box.createDiv({
			cls: 'nav-settings-options',
			attr: { role: 'group', 'aria-label': title },
		});
		const row = group.createEl('button', {
			cls: 'nav-settings-option',
			type: 'button',
			attr: { role: 'checkbox', 'aria-checked': String(on) },
		});
		const tick = row.createSpan({ cls: 'nav-settings-tick', attr: { 'aria-hidden': 'true' } });
		if (on)
			setIcon(tick, 'check');
		row.createSpan({ cls: 'nav-settings-label', text: label });
		row.createSpan({ cls: 'nav-settings-option-desc', text: desc });
		// The answer of a checkbox is its own opposite: the row says what the setting IS
		// (see the aria-checked above), and a press moves it to the other state.
		row.addEventListener('click', () => pick(!on));
	}

	// One of the two values: the plugin is asked to remember it (see NavBrowserPrefs),
	// and the list is redrawn on the spot — seeing the list that follows is the whole
	// reason the choice is offered here, so the panel goes first and the change lands
	// under it.
	private pickLandings(mode: LandingsMode): void {
		this.closeSettings();
		if (this.opts.prefs.landings() === mode)
			return;
		this.opts.prefs.setLandings(mode);
		this.render();
	}

	// …and the same for the content the panel shows: the setting is the plugin's (see
	// NavBrowserPrefs), and the row that is up is redrawn in the other view on the
	// spot.
	private pickPreviewMode(mode: PreviewMode): void {
		this.closeSettings();
		if (this.opts.prefs.previewMode() === mode)
			return;
		this.opts.prefs.setPreviewMode(mode);
		this.render();
	}

	// …and the same for whether there is a column to show at all. Switching it changes
	// three things at once, and all three are redrawn here rather than on the next
	// history move: the rows gain (or lose) their gutter control, the panel appears (or
	// leaves the body's flow), and the hint stops (or starts) naming a control — a
	// resident panel is up for hours, and a reader who switches the column on has to
	// see the column they asked for in the same breath (see NavBrowserPrefs).
	private pickDetails(on: boolean): void {
		this.closeSettings();
		if (this.opts.prefs.showDetails() === on)
			return;
		this.opts.prefs.setShowDetails(on);
		this.fillHint();
		this.render();
	}

	// Put the setting away, and say whether there was one up (@returns whether this
	// was the key the reader meant, see onKeyDown).
	private closeSettings(): boolean {
		const menu = this.settingsMenu;
		if (!menu)
			return false;
		this.settingsMenu = undefined;
		if (this.dismissSettings) {
			document.removeEventListener('mousedown', this.dismissSettings, true);
			this.dismissSettings = undefined;
		}
		this.settingsBtn.setAttr('aria-expanded', 'false');
		menu.remove();
		return true;
	}

	// The "you are here" CARD that used to stand between the toolbar and the list
	// is gone. The current entry is a row in the list like any other — pinned
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

	// A link inside the landing's rendered content was clicked (see
	// NavPreviewContent's `wire`). It is the same journey as a row's travel and it
	// goes through the same two steps, in the same order:
	//  - the reader's place first, where the shell is staying up. The open that follows
	//    pushes a history step, and the rows are rebuilt from the stack the moment it
	//    lands — a position left where it was would name whatever slid into that slot
	//    (see the option). Cleared, the redraw is nothing but the new list.
	//  - then the shell's own reaction: a dialog has answered its question the moment
	//    the reader went somewhere, and gets out of the way before the open it
	//    triggered runs.
	// A sidebar keeps standing, which is the whole point of it.
	private follow(linktext: string, sourcePath: string): void {
		if (this.opts.collapseOnJump) {
			this.panel.forget();
			this.list.collapse();
		}
		this.opts.onJump?.();
		void Promise.resolve(this.opts.app.workspace.openLinkText(linktext, sourcePath, false))
			.catch(e => console.error('Position Restore: link follow failed:', e));
	}

	private jump(i: number): void {
		// The reader's place first where the shell is staying up: the jump is about to
		// rewrite the stack, and a position left where it was would name whatever slid
		// into that slot (see the option). The panel is forgotten before the list,
		// because clearing the position redraws it.
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
