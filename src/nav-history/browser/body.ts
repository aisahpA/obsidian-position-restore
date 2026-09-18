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
//   - list.ts               the list of notes, the position, the travel arrow
//   - landing-panel.ts      the landing described: head, trail, caption and the
//                           switch between the two contents — the right-hand
//                           drawer on a pointing device, the in-flow panel when
//                           there is no room for two columns
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

// Where a hint's text wants the travel arrow drawn into it (see `hint`). Written
// into the locale strings rather than assembled from fragments, so a translation can
// put the icon where its own sentence needs it — in front of the verb, after it, or
// in the middle.
const HINT_ICON = '{arrow}';

// The two preferences the browser ITSELF owns, handed to every shell by the plugin
// that persists them (see PluginSettings and PositionManager.browserPrefs). Both are
// READERS over the one shared settings object rather than values: a resident panel
// draws its list from a call made during render, so a change made in the panel is
// picked up by the next history change instead of being frozen into the panel that
// happened to be open. Both also come as a pair — read plus write — because the
// panel is where each of them is CHOSEN: the content by the switch above the
// landing's lines (see LandingPanel), the list's shape by the toolbar's own setting
// (see NavHistoryBrowser.settings).
export interface NavBrowserPrefs {
	// Which content a landing opens on (see PreviewMode).
	previewMode: () => PreviewMode;
	// The panel's own switch: remember the reader's choice, for good.
	setPreviewMode: (mode: PreviewMode) => void;
	// How much of one note the list prints (see LandingsMode).
	landings: () => LandingsMode;
	// The toolbar's setting: still the plugin's choice to keep (see setPreviewMode).
	setLandings: (mode: LandingsMode) => void;
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
	// The browser's own two preferences, handed down by the shell (see
	// NavBrowserPrefs): which content a landing opens on, and how much of a note the
	// list prints.
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
	private filterInput!: HTMLInputElement;
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
			// itself rather than styling: how big the arrow's glyph is under a finger
			// (see NavHistoryList.go).
			touch: this.opts.touch,
			// How much of a note to print: read LIVE (see NavBrowserPrefs), so the
			// toolbar's setting reaches a panel that is already up.
			landings: () => this.opts.prefs.landings(),
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
			// The panel's own switch over the plugin's preference: read live, written
			// back through the same pair the settings file is saved from.
			previewMode: () => this.opts.prefs.previewMode(),
			setPreviewMode: mode => this.opts.prefs.setPreviewMode(mode),
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
		// The hint, and then the panel's one setting at the far end of the strip. The
		// file scope that used to sit between them — a "only this note" switch and a
		// chip of every note the history had been in — is gone: a note's name is text
		// the box already matches, so the two controls were a slower way to type
		// it, and they cost the list the width and the row they stood on.
		// What the panel can be driven by is what the hint names: a finger's tap on a
		// touch device, and a click everywhere else — the same list, the same one
		// gesture per row, whether the room around it is a dialog or a sidebar. (The
		// keyboard's own keys still work in both: the hint names the gesture a reader
		// has to be TOLD about, and the arrow in front of every row is the one this
		// panel is built on.)
		this.hint(bar);
		this.settings(bar);
	}

	// The hint, with the row's own arrow DRAWN into it.
	//
	// The hint tells the reader to use the arrow, so the line has to show the arrow
	// the rows actually carry: a typed stand-in is a different shape from the icon —
	// "↪" is a text character with a hook, the icon is a squared corner — and a phone
	// reported exactly that mismatch, reading the sentence and then looking for an
	// arrow that was not on the list. The locale keeps the icon's PLACE in the
	// sentence (see HINT_ICON), so each language puts it where its own grammar wants
	// it — both of the sentences this panel now has name the arrow, and both draw it.
	//
	// One sentence per DEVICE and none per setting: the list answers a click the same
	// way whatever it is printing (a note row points the panel at the spot it stands
	// for; a landing row, where 'all' prints them, points at itself) — so the line
	// cannot go stale under a setting the toolbar changes without rebuilding it.
	private hint(bar: HTMLElement): void {
		const key = this.opts.touch ? 'navHistory.touchHint' : 'navHistory.clickHint';
		const line = bar.createSpan({ cls: 'position-restore-nav-hint' });
		const parts = t(key).split(HINT_ICON);
		for (let i = 0; i < parts.length; i++) {
			// The icon stands between two runs of text, so the odd slots are the ones
			// the arrow goes in front of.
			if (i > 0) {
				// Not announced: the sentence around it already says "jump", and a
				// screen reader has Enter for the same thing (see the list's go).
				const icon = line.createSpan({ cls: 'nav-hint-go', attr: { 'aria-hidden': 'true' } });
				setIcon(icon, 'corner-up-right');
			}
			line.appendText(parts[i]);
		}
	}

	// THE TOOLBAR'S SETTING: the small button at the strip's far end, and the panel it
	// opens over the list.
	//
	// It stands here rather than in the settings tab because this is where the
	// question is asked — a reader decides how long the list should be while looking at
	// it — and because the panel is a DIALOG as often as it is a sidebar: a settings
	// row would be the only way to reach a choice about something that is not on screen
	// at the time. It is the same move the landing panel makes with its two content
	// views (see LandingPanel.modes), and it leaves the settings tab with no second
	// copy of the value that could drift from this one.
	//
	// The panel is plain DOM and not the app's own Menu: it is a radio group of two
	// with the one sentence that says what the two mean, which a menu cannot carry.
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

	// Open the setting under the button: the name of the choice, its two values, and
	// the sentence that says what each of them prints.
	private openSettings(bar: HTMLElement): void {
		const menu = bar.createDiv({
			cls: 'position-restore-nav-settings-menu',
			attr: { role: 'radiogroup', 'aria-label': t('navHistory.landings.name') },
		});
		menu.createDiv({ cls: 'nav-settings-title', text: t('navHistory.landings.name') });
		for (const mode of ['last', 'all'] as LandingsMode[]) {
			const key = mode === 'last' ? 'navHistory.landings.options.last' : 'navHistory.landings.options.all';
			const checked = mode === this.opts.prefs.landings();
			const option = menu.createEl('button', {
				cls: 'nav-settings-option',
				type: 'button',
				attr: {
					// A radio group rather than a menu of commands: what is being chosen is
					// one of two answers, and the reader has to be able to hear WHICH one is
					// in force without opening the list to look at its shape.
					role: 'radio',
					'aria-checked': String(checked),
				},
			});
			// The value in force says so a second time, with a mark: the tint alone is a
			// fact a theme can take away (see styles.css), and this is the one cue left
			// when two backgrounds come out nearly the same. The mark's SLOT is written
			// on every row whether or not it holds a glyph — in front of the label, so
			// the two labels start on one x instead of the unticked one pulling left.
			const tick = option.createSpan({ cls: 'nav-settings-tick', attr: { 'aria-hidden': 'true' } });
			if (checked)
				setIcon(tick, 'check');
			option.createSpan({ cls: 'nav-settings-label', text: t(key) });
			option.addEventListener('click', () => this.pickLandings(mode));
		}
		menu.createDiv({ cls: 'nav-settings-desc', text: t('navHistory.landings.desc') });
		this.settingsMenu = menu;
		this.settingsBtn.setAttr('aria-expanded', 'true');
		// Anything outside it — the list, the filter box, the rest of the app — puts it
		// away. On the DOCUMENT and in the CAPTURE phase, so that it is gone before the
		// press it belongs to reaches whatever it landed on.
		const dismiss = (ev: Event) => {
			const target = ev.target as Node | null;
			if (target && (menu.contains(target) || this.settingsBtn.contains(target)))
				return;
			this.closeSettings();
		};
		this.dismissSettings = dismiss;
		document.addEventListener('mousedown', dismiss, true);
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
