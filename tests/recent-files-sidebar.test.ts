// The recent-files browser's RESIDENT shell (browser/view.ts): what makes it a
// sidebar panel rather than a dialog — the pane's own lifetime around the body,
// the pane's own width deciding the presentation, and the place list being heard
// while it is up (see NavPlaces.subscribe). The body itself — the tree, the
// landing panel, the keyboard, the travel — is covered in
// recent-files-browser-dom.test.ts, where it is driven through the modal.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keymap, Platform, TFile, WorkspaceLeaf } from 'obsidian';

import { RECENT_FILES_VIEW_TYPE, RecentFilesView, activateRecentFilesView } from '@/recent-files/browser/view';
import type { RecentFilesBrowserPrefs } from '@/recent-files/browser/body';
import type { LandingsMode } from '@/recent-files/browser/listing';
import type { PathDisplayMode } from '@/types';
import { navGroupKey, type NavEntry } from '@/nav/entry';
import type { PaneTarget } from '@/nav/pane';
import { t } from '@/i18n';
import { PANEL_EXIT_GRACE_MS, TIME_REFRESH_MS } from '@/recent-files/browser/constants';

// jsdom implements no layout, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

// 'obsidian' resolves to tests/support/obsidian-stub.ts for the RUN TIME of this suite
// (see vitest.config.mts), but tsc reads its types from the real, typings-only
// package — which declares the two questions the plugin asks (isModEvent /
// isModifier) and nothing else. The stub's answers are INPUTS a test sets, so
// they are reached through one honest cast rather than pretended onto the app's
// class.
const KeymapKnobs = Keymap as unknown as {
	reset(): void;
	modEvent: unknown;
	modifier: boolean;
};

// The browser's preferences as the plugin hands them over (see RecentFilesBrowserPrefs):
// READERS over values the settings tab owns — a fresh set per mount, so no test
// decides another's. What the panel does with a value that CHANGED underneath it is
// the one thing the shell adds, so the fixture can be written to as well: that is
// what the settings tab does (see SettingTab.setControlValue), and the panel is then
// asked to draw again (see RecentFilesView.refresh).
type TestPrefs = RecentFilesBrowserPrefs & { setLandings: (how: LandingsMode) => void };

function browserPrefs(
	landings: LandingsMode = 'last',
	path: PathDisplayMode = 'smart',
	time = false,
): TestPrefs {
	const held = { landings, path, time };
	return {
		landings: () => held.landings,
		// How far back the list reaches (see PluginSettings.recentFilesCap): a number
		// the panel only reads.
		placesCap: () => 200,
		// How much of a row's path is printed, and on which side of the name (see
		// PathDisplayMode).
		pathDisplay: () => held.path,
		// Whether each row is dated (see RecentFilesBrowserPrefs.rowTime): a switch, off unless
		// a test asks — what the LABEL says is the body's business and is covered where
		// the body is (see recent-files-browser-dom.test.ts); what the shell adds is the
		// lifetime of the timer that keeps it fresh (see the test below).
		rowTime: () => held.time,
		setLandings: (how) => {
			held.landings = how;
		},
	};
}

const MINUTE = 60_000;
const NOW = Date.now();

const visit = (path: string, stamp: number): NavEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp });

// A PLACE of a note: a jump the reader made. A note's own record (`visit`) is the
// note's ROW and carries no position at all (see places.ts), so a fixture that
// means "a spot in this note" builds the jump — a positioned visit is a shape the
// list never holds.
const place = (path: string, stamp: number, line: number): NavEntry =>
	({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:L${line}@${stamp}`, t: stamp, st: { scroll: line } });

// The place list as the view sees it: entries, the pointer, travel and subscribe
// (see places.ts's PlaceList). The real store is exercised against the same
// surface in recent-files-places.test.ts; here the point is the SHELL, so the list is a
// fixture that can be moved by hand.
class FakeNav {
	entries: NavEntry[] = [];
	index = -1;
	// The rows the reader pinned, as the store hands them over (see
	// NavPlaces.pinned): a test writes the array itself, which is what the
	// right-click menu does to the store's.
	pinned: string[] = [];
	readonly jumped: number[] = [];
	private listeners = new Set<() => void>();

	// Where each travel was told to open (see PaneTarget): recorded beside the place,
	// because the panel's own answer to "where" is what a modifier test is about.
	readonly targets: (PaneTarget | undefined)[] = [];

	// The real travel, in miniature: the place visited is re-stamped and becomes the
	// current one — so the list is rewritten under the panel, which is the whole
	// reason the panel has to collapse first (see NavPlaces.travel /
	// RecentFilesList.collapse).
	travel = async (i: number, target?: PaneTarget): Promise<void> => {
		this.jumped.push(i);
		this.targets.push(target);
		const visited = this.entries[i];
		this.entries = [...this.entries.slice(0, i), { ...visited, t: Date.now() }];
		this.index = this.entries.length - 1;
		for (const fn of this.listeners)
			fn();
	};

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	// The reader took a row off the list (the × on the row itself — see
	// RecentFilesBrowser.onForget): the real store drops every record the row was drawn
	// from, by the row's own key (see NavPlaces.forget), and tells its listeners, exactly
	// as it does for a change made anywhere else.
	forget(key: string): void {
		this.entries = this.entries.filter(e => navGroupKey(e) !== key);
		for (const fn of this.listeners)
			fn();
	}

	// The pin, in miniature: `pinned` IS the block, and a change tells the listeners
	// exactly as a removal does (see NavPlaces.afterPinChange).
	pin(key: string): void {
		if (!this.pinned.includes(key))
			this.pinned.push(key);
		for (const fn of this.listeners)
			fn();
	}

	unpin(key: string): void {
		const at = this.pinned.indexOf(key);
		if (at >= 0)
			this.pinned.splice(at, 1);
		for (const fn of this.listeners)
			fn();
	}

	movePinned(key: string, delta: number): void {
		const at = this.pinned.indexOf(key);
		if (at < 0)
			return;
		const to = Math.min(Math.max(at + delta, 0), this.pinned.length - 1);
		if (to === at)
			return;
		this.pinned.splice(at, 1);
		this.pinned.splice(to, 0, key);
		for (const fn of this.listeners)
			fn();
	}

	// A step the reader made elsewhere: every browser on screen is told (see
	// NavPlaces.changed).
	moved(index: number): void {
		this.index = index;
		for (const fn of this.listeners)
			fn();
	}

	get listenerCount(): number {
		return this.listeners.size;
	}
}

function makeApp(paths: string[] = []) {
	const files: Record<string, TFile> = {};
	for (const path of paths)
		// A stat, as every TFile has one: a section chain read out of the file's own
		// text is remembered against its mtime (see reads.ts).
		files[path] = Object.assign(new TFile(), { path, stat: { ctime: 0, mtime: 0, size: 0 } });
	// The app's own file-menu event: a row asks the APP what it can do with the file
	// (see RecentFilesBrowser.contextRow), and what this panel hands the app is the
	// menu OBJECT — so it is RECORDED rather than merely swallowed. A test that wants
	// to know who took a menu off the screen has to be able to find it again.
	const trigger = vi.fn();
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files[path] ?? null,
			cachedRead: async () => '',
		},
		metadataCache: { getFileCache: () => null },
		workspace: {
			rootSplit: { containerEl: document.createElement('div') },
			iterateAllLeaves: () => undefined,
			// No markdown leaf is open in this file's harness: a note's lines are read
			// off the disk here, if they are read at all (see now-line.ts).
			getLeavesOfType: () => [],
			trigger,
		},
	};
	return { app: app as never, trigger };
}

async function mount(
	entries: NavEntry[],
	index: number,
	prefs: RecentFilesBrowserPrefs = browserPrefs(),
	// Paths the VAULT holds that no entry names yet: a test that appends a step to the
	// history while the panel is up needs the file behind it to exist, or the list
	// filters the new place out (see RecentFilesList.render).
	extraPaths: string[] = [],
) {
	const nav = new FakeNav();
	nav.entries = entries;
	nav.index = index;
	const { app, trigger } = makeApp([...entries.flatMap(e => (e.kind === 'view' ? [] : [e.path])), ...extraPaths]);
	const leaf = Object.assign(new WorkspaceLeaf(), { app });
	// jsdom lays nothing out, so the pane reports width 0 — which is the INLINE
	// presentation, the one that needs no second column (see RecentFilesView.measure).
	const view = new RecentFilesView(leaf, nav as never, () => undefined, prefs);
	await view.onOpen();
	// The view's OWN container and content elements: what the pane hands the
	// panel, and what Obsidian asks the view to build in.
	const el = view.containerEl;
	const rows = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'));
	const names = () => rows().map(r => r.querySelector('.nav-row-name')?.textContent);
	// The listbox itself: what the pointer events that decide whether the list is
	// being READ arrive on (see RecentFilesBrowser.freezeOrder).
	const list = () => el.querySelector<HTMLElement>('.position-restore-nav-list')!;
	return { view, el, nav, rows, names, list, trigger };
}

describe('RecentFilesView — the resident panel', () => {
	beforeEach(() => {
		// The app's own answers (see Keymap): an input a test sets, and one left over
		// from the case before it would decide this one.
		KeymapKnobs.reset();
		document.body.empty();
	});

	it('mounts the browser body into the pane, with no dialog around it', async () => {
		const { view, el, names } = await mount([visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1);

		// The body, whole: the toolbar — the search box, and nothing beside it — and
		// the list of notes, the current one pinned first and marked. No setting of its
		// own: the four choices are rows of the plugin's settings tab now (see
		// RecentFilesBrowserPrefs).
		expect(el.querySelector('.position-restore-nav-filter')).not.toBeNull();
		expect(el.querySelector('.position-restore-nav-settings')).toBeNull();
		expect(names()).toEqual(['b', 'a']);
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent)
			.toBe('b');

		// The classes the shared presentation rules are written against (see
		// styles.css): without them a sidebar panel would fall back to the stock
		// text tiers.
		expect(view.contentEl.classList.contains('position-restore-nav-panel')).toBe(true);
		expect(view.contentEl.classList.contains('position-restore-nav-view')).toBe(true);
	});

	it('leaves the caret in the editor: a restored panel focuses nothing', async () => {
		const { el } = await mount([visit('a.md', NOW)], 0);
		const input = el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		// The modal focuses this box on open, and is right to: it was opened on
		// purpose, and typing is the fastest way through the list. A panel that is
		// restored with the workspace must not take the caret out of the note.
		expect(document.activeElement).not.toBe(input);
		// …and it is still one click away, and it is where the arrow keys walk the list
		// from. Nothing beside it says so: the hint that used to name the gesture is gone
		// (a row in a list answers a click everywhere else in the app), and the list is
		// click-only — a pointer passing over it changes nothing (see RecentFilesList).
		expect(el.querySelector('.position-restore-nav-hint')).toBeNull();
	});

	it('follows the history while it is up', async () => {
		const { el, nav, names } = await mount(
			[visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1, browserPrefs(), ['c.md']);
		expect(names()).toEqual(['b', 'a']);

		// The reader walks to another note elsewhere in the app: the stack grows
		// under the panel and the panel redraws for it. Nothing was reopened; the
		// whole point is that this one is still standing.
		nav.entries = [...nav.entries, visit('c.md', NOW + MINUTE)];
		nav.moved(2);

		expect(names()).toEqual(['c', 'b', 'a']);
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent)
			.toBe('c');
	});

	// The list is HELD STILL while the pointer is on it (see
	// RecentFilesBrowser.freezeOrder / RecentFilesListOptions.order). What a reader is
	// looking at is the one thing a redraw must not re-arrange: a row that opens a
	// note and then moves under the hand that opened it is a list that answers a
	// click with a shuffle.
	it('holds the order it is being read at, and catches up when the pointer leaves', async () => {
		const { el, nav, names, list } = await mount([
			place('a.md', NOW - 3 * MINUTE, 10),
			place('b.md', NOW - 2 * MINUTE, 20),
			place('c.md', NOW - MINUTE, 30),
		], 2);
		const current = () =>
			el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent;
		// Newest first: c, b, a.
		expect(names()).toEqual(['c', 'b', 'a']);

		list().dispatchEvent(new Event('pointerover', { bubbles: true }));

		// The reader goes back to a.md — elsewhere in the app, with this panel still
		// standing. A place that is sat in again is re-stamped and moves to the END of
		// the list (see places.remember), so the order the store holds is no longer the
		// order the reader is looking at: a.md is now the newest of the three.
		nav.entries = [
			...nav.entries.filter(e => e.kind === 'view' || e.path !== 'a.md'),
			place('a.md', NOW, 10),
		];
		nav.moved(2);

		// Nothing moved. The list is still the one they were reading, and the only
		// thing that changed is WHERE they are: the mark is on the last row now, which
		// is the row a.md kept (see RecentFilesList.fileRow).
		expect(names()).toEqual(['c', 'b', 'a']);
		expect(current()).toBe('a');

		// The pointer leaves, and with nobody reading it the list is free to catch up
		// on the spot — rather than waiting for the next change to the history, which
		// may be minutes away. Catching up means the store's order, which is now a.md
		// first on its own merits (nothing lifts the current note to the top).
		list().dispatchEvent(new Event('pointerleave', { bubbles: true }));

		expect(names()).toEqual(['a', 'c', 'b']);
		expect(current()).toBe('a');
	});

	// The ages on the rows are read off a clock, so a panel that just stands there
	// would otherwise keep saying "5m" while the note it names got an hour old. The
	// interval that fixes that belongs to the BODY (both shells are destroyed through
	// it) — and a timer that outlives the panel it redraws is the leak this pins.
	it('refreshes the ages while it stands, and stops when the panel closes', async () => {
		vi.useFakeTimers();
		try {
			const { view, el } = await mount([visit('a.md', NOW)], 0, browserPrefs('last', 'smart', true));
			const before = el.querySelector<HTMLElement>('.position-restore-nav-row.is-file')!;
			expect(before).not.toBeNull();

			// One tick: the list is rebuilt, so the element in hand is not the one on
			// screen any more. (jsdom lays nothing out and the label's own text may not
			// have changed at all — what a tick owes is a redraw, not a new word.)
			vi.advanceTimersByTime(TIME_REFRESH_MS);
			expect(el.contains(before)).toBe(false);

			// …and the interval is gone with the panel: a closed view must not go on
			// redrawing a body that has been torn down.
			await view.onClose();
			const after = el.querySelector<HTMLElement>('.position-restore-nav-row.is-file')!;
			vi.advanceTimersByTime(TIME_REFRESH_MS * 3);
			expect(el.contains(after)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops hearing about the history once it is closed', async () => {
		const { view, nav } = await mount([visit('a.md', NOW)], 0);
		expect(nav.listenerCount).toBe(1);

		await view.onClose();
		expect(nav.listenerCount).toBe(0);
		// A step arriving after the close must not reach a destroyed body (the
		// preview it renders holds components that are already unloaded).
		expect(() => nav.moved(0)).not.toThrow();
	});

	// The panel reads its preferences live, so a value changed while it stands needs
	// no re-wiring — only a redraw. That is the whole of what the settings tab's row
	// and the panel have to agree on (see PositionManager.refreshNavPanels): the
	// value is written where settings are written, and every standing panel is asked
	// to draw itself again.
	it('redraws a standing list when a preference it draws by is changed', async () => {
		const prefs = browserPrefs('last');
		const entries: NavEntry[] = [
			place('a.md', NOW - 2 * MINUTE, 10),
			place('a.md', NOW - MINUTE, 40),
			visit('b.md', NOW),
		];
		const { view, el } = await mount(entries, 2, prefs);
		expect(el.querySelectorAll('.position-restore-nav-row.is-place')).toHaveLength(0);

		// The reader picks "every landing" in the settings tab: the value is written
		// there, and this panel is asked to draw again.
		prefs.setLandings('all');
		view.refresh();

		// The list under the panel is the new one, in the same breath — nothing was
		// reopened, and the reader did not have to wait for the history to move.
		expect(el.querySelectorAll('.position-restore-nav-row.is-place')).toHaveLength(2);
	});

	// The drawer is a SHAPE, not a class: `this.leaf.parent` is whatever the app put
	// there, and the typings' WorkspaceMobileDrawer is not necessarily something the
	// app's runtime module exports — an `instanceof` against a missing name throws,
	// and (before the travel) that made the panel answer no click at all on a phone.
	const drawer = () => {
		const d = {
			collapsed: false,
			collapse(): void { d.collapsed = true; },
		};
		return d;
	};

	it('collapses the phone\'s drawer on a travel, so the note it opened can be seen', async () => {
		// On a phone the resident panel IS a drawer over the whole screen: a row that
		// opens a note behind it looks like a row that did nothing. The panel itself
		// stays in the layout — collapsing is not closing, and where to put it is the
		// reader's business.
		const { el, nav, view } = await mount(
			[place('a.md', NOW - MINUTE, 10), visit('b.md', NOW)], 1, browserPrefs('all'));
		const pane = drawer();
		(view.leaf as unknown as { parent?: unknown }).parent = pane;
		const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

		// A desktop leaf's parent is a tab group, not a drawer: nothing moves, because
		// the panel stands beside the note already.
		click(note());
		expect(pane.collapsed).toBe(false);
		expect(nav.jumped).toHaveLength(1);

		const wasMobile = Platform.isMobile;
		Platform.isMobile = true;
		try {
			click(note());
			expect(pane.collapsed).toBe(true);
		} finally {
			Platform.isMobile = wasMobile;
		}
		expect(nav.jumped).toHaveLength(2);
	});

	it('takes the menu it raised off the screen before it folds the drawer away', async () => {
		// The menu stands on the DOCUMENT and not in this panel's element, and it is the
		// app's: what the app takes one off the screen for is a click outside it, an
		// item chosen on it, or Escape. Folding a drawer is none of those, so a panel
		// that steps out of the reader's way has to take its own menu with it (see
		// RecentFilesBrowser.closeMenu).
		const wasMobile = Platform.isMobile;
		// …and the row's menu control is a PHONE's (see RecentFilesList.menuControl),
		// which is decided while the panel is being mounted.
		Platform.isMobile = true;
		try {
			const { el, trigger, view } = await mount(
				[visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1);
			const pane = drawer();
			(view.leaf as unknown as { parent?: unknown }).parent = pane;
			const click = (on: HTMLElement) =>
				on.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const row = Array
				.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
				.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

			click(row.querySelector<HTMLElement>('.nav-row-menu')!);
			const menu = trigger.mock.calls[0][1] as { closed: boolean };
			expect(menu.closed).toBe(false);

			// …and then the reader travels, and the drawer folds.
			click(row);

			expect(pane.collapsed).toBe(true);
			expect(menu.closed).toBe(true);
		} finally {
			Platform.isMobile = wasMobile;
		}
	});

	it('travels even when the shell\'s reaction throws', async () => {
		// The reader asked to go somewhere; the shell's own reaction (a dialog closing,
		// a drawer folding) is the shell's business. One that throws must cost them the
		// reaction, not the journey — the failure mode this test exists for was a
		// mobile panel where every click did nothing at all.
		const { el, nav, view } = await mount(
			[place('a.md', NOW - MINUTE, 10), visit('b.md', NOW)], 1, browserPrefs('all'));
		(view.leaf as unknown as { parent?: unknown }).parent = {
			collapsed: false,
			collapse(): void { throw new Error('no drawer'); },
		};
		const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

		const wasMobile = Platform.isMobile;
		Platform.isMobile = true;
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			click(note());
		} finally {
			Platform.isMobile = wasMobile;
			logged.mockRestore();
		}

		expect(nav.jumped).toHaveLength(1);
	});

	// A travel re-orders the list at the same moment it starts the drawer this panel
	// stands in sliding off the screen: the place just sat in becomes the newest, so the
	// row the reader aimed at climbs to the top of a list that is on its way out, and the
	// "you are here" mark rides along with it. The panel is leaving anyway — what it owes
	// the reader is a list that is true the next time the drawer is pulled open, and
	// nothing in between (see RecentFilesView.standAside).
	it('holds the list still while the panel leaves the screen, and catches up once it has gone', async () => {
		vi.useFakeTimers();
		try {
			const { el, nav, view, names } = await mount(
				[visit('a.md', NOW - 2 * MINUTE), visit('b.md', NOW - MINUTE), visit('c.md', NOW)], 2);
			const pane = drawer();
			(view.leaf as unknown as { parent?: unknown }).parent = pane;
			const click = (row: HTMLElement) =>
				row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const note = () => Array
				.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
				.find(r => r.querySelector('.nav-row-name')?.textContent === 'b')!;
			// Newest first, and c is the note the reader is standing in.
			expect(names()).toEqual(['c', 'b', 'a']);

			const wasMobile = Platform.isMobile;
			Platform.isMobile = true;
			try {
				click(note());
			} finally {
				Platform.isMobile = wasMobile;
			}

			// The drawer is on its way out and the travel has landed — the list the reader
			// is still looking at has not moved. Drawn, b would be at the top already.
			expect(pane.collapsed).toBe(true);
			expect(nav.jumped).toEqual([1]);
			expect(names()).toEqual(['c', 'b', 'a']);

			// …and once the panel is out of sight it catches up in ONE redraw: b is the
			// newest place now.
			vi.advanceTimersByTime(PANEL_EXIT_GRACE_MS);
			expect(names()).toEqual(['b', 'a']);
		} finally {
			vi.useRealTimers();
		}
	});

	// A panel can be closed while it is holding a redraw back — the reader swipes the
	// drawer away, or closes the pane, inside the same few hundred milliseconds. Nothing
	// is owed then either: the catch-up dies with the panel it was held for, rather than
	// drawing into a body that has been torn down.
	it('drops the redraw it is holding back when the panel is closed on the way out', async () => {
		vi.useFakeTimers();
		try {
			const { el, view } = await mount([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1);
			(view.leaf as unknown as { parent?: unknown }).parent = drawer();
			const click = (row: HTMLElement) =>
				row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const note = () => Array
				.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
				.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

			const wasMobile = Platform.isMobile;
			Platform.isMobile = true;
			try {
				click(note());
			} finally {
				Platform.isMobile = wasMobile;
			}
			await view.onClose();
			const row = el.querySelector('.position-restore-nav-row')!;

			vi.advanceTimersByTime(PANEL_EXIT_GRACE_MS);

			// The timer went with the panel: had it fired, the list would have been rebuilt
			// and this element would no longer be the one standing in the pane.
			expect(el.contains(row)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	// On a desktop none of it applies, and that is what this pins: the panel stays put,
	// so the re-ordering is the ANSWER rather than a distraction — the note the reader
	// went to takes the top row and the mark with it. A panel standing in full view must
	// not be a step behind the history it is showing.
	it('redraws on the spot where the panel stays put', async () => {
		const { el, names } = await mount(
			[visit('a.md', NOW - 2 * MINUTE), visit('b.md', NOW - MINUTE), visit('c.md', NOW)], 2);
		const click = (row: HTMLElement) =>
			row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const note = () => Array
			.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'b')!;
		expect(names()).toEqual(['c', 'b', 'a']);

		click(note());

		// Drawn in the same breath as the travel: no timer, nothing held back.
		expect(names()).toEqual(['b', 'a']);
	});
});

describe('RecentFilesView — the pointer is driven by clicks only', () => {
	// A note with several spots, so there is a landing row to click once the list is
	// asked to print them (see groupByFile / LandingsMode). The list runs OLDEST FIRST,
	// which is the order a real history is built in (see NavStack.push): the newest
	// thing the reader did in a.md is the second step, not the first.
	const stack = () => [
		place('a.md', NOW - 2 * MINUTE, 10),
		place('a.md', NOW - MINUTE, 40),
		place('b.md', NOW, 0),
	] as NavEntry[];

	const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// The RIGHT button, and a finger's lingering press (the same event with the left
	// button's number): neither opens anything (see RecentFilesList.onContextMenu).
	const rightClick = (el: HTMLElement) => el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
	);
	const noteRow = (el: HTMLElement, name: string) =>
		Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === name)!;

	it('chooses nothing on hover: only a click is a gesture', async () => {
		const { el } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a');

		// Nothing is chosen as the panel opens (see RecentFilesList.choose: a position is
		// a key or a click, and a click travels).
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// A mouse merely crossing the rows is not a choice. This is the rule the list is
		// built on (see RecentFilesList): a list that lurches under a passing mouse
		// selects a row nobody chose.
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 40 }));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// …and neither is the keyboard's own position taken away by one: ↓ walks, and the
		// pointer crossing what it walked to leaves it where it is.
		el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).not.toBeNull();
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 12 }));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).not.toBeNull();
	});

	it('prints a note\'s places when the list is asked for them', async () => {
		const { el } = await mount(stack(), 2, browserPrefs('all'));

		// Both of a.md's places, and nothing under b.md, which holds one (see
		// RecentFilesList.printsLandings): one place is not a list.
		expect(el.querySelectorAll('.position-restore-nav-row.is-place')).toHaveLength(2);
		expect(el.querySelectorAll('.position-restore-nav-row.is-file')).toHaveLength(2);
	});

	it('opens in a new tab where the app says so, and stays standing', async () => {
		// The modifier is the APP's answer (see Keymap.isModEvent), and the panel's own
		// contract does not change with it: a resident panel answers a click by going
		// somewhere, and it is still there afterwards — the note opened beside it, the
		// reader's place in the list cleared rather than carried over (see
		// RecentFilesList.collapse).
		const { el, nav } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a');
		KeymapKnobs.modEvent = 'tab';

		click(note());

		expect(nav.jumped).toEqual([1]);
		expect(nav.targets).toEqual(['tab']);
		expect(el.querySelector('.position-restore-nav-list')).not.toBeNull();
		expect(nav.listenerCount).toBe(1);
	});

	it('opens the file from the row itself, in one click', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a');

		// The row IS the navigation — that is what a navigator is for, and the name is the
		// target. The reader who already knows where they are going spends ONE click.
		click(note());

		// It opens the landing the note's row stands for: the NEWEST one, where the
		// reader left that note — step 1, L40 — and not the top of the note (step 0,
		// L10), which is what the row meant while its landings ran in line order (see
		// RecentFilesList.activeRep). And no row is left selected: a click travels.
		expect(nav.jumped).toEqual([1]);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
	});

	it('opens a landing row at ITS place', async () => {
		const { el, nav } = await mount(stack(), 2, browserPrefs('all'));
		const place = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L11')!;

		// a.md's OLDER landing — the step recorded at scroll 10, printed "L11" (the label
		// is 1-based, see describeNavEntry) and the one the note's own row does NOT stand
		// for. A landing row is a destination of its own.
		click(place);

		expect(nav.jumped).toEqual([0]);
		// A resident panel stays standing: the travel rewrites the list under it.
		expect(el.querySelector('.position-restore-nav-list')).not.toBeNull();
		expect(nav.listenerCount).toBe(1);
	});

	it('opens nothing on a right-click', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = noteRow(el, 'a');

		rightClick(note);

		// The right button no longer travels: a row is opened by clicking it, and a
		// second button that opens the same thing is a gesture to learn for nothing
		// (see RecentFilesList.onContextMenu).
		expect(nav.jumped).toEqual([]);
	});

	it('leaves a press that was only held down where it was', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = noteRow(el, 'a');

		// The same event a WebView raises for a long touch, with the LEFT button on it:
		// nothing opens (see RecentFilesList.onContextMenu). It is the one that made a slow
		// tap on a tablet's file name look like a jump.
		const held = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
		note.dispatchEvent(held);

		expect(nav.jumped).toEqual([]);
		// Still refused, all the same: a row offers no menu, no callout and no selection
		// — a held press simply does nothing here.
		expect(held.defaultPrevented).toBe(true);
	});

	// The jump REWRITES the stack: the note it landed on is re-pushed on top, so every
	// stack index below it shifts and the groups are rebuilt. A position
	// kept across that rewrite stands on whatever slid into its slot. This is that list,
	// and the regression it guards.
	it('starts the next list from a cleared position, not from the row that used to be in that slot', async () => {
		const entries = [
			place('a.md', NOW - 5 * MINUTE, 10),
			place('b.md', NOW - 4 * MINUTE, 5),
			place('b.md', NOW - 3 * MINUTE, 50),
			place('c.md', NOW - 2 * MINUTE, 7),
			place('c.md', NOW - MINUTE, 30),
			place('d.md', NOW, 1),
		] as NavEntry[];
		// The list as it stands: d (current) first, then c, b, a. c is the note below the
		// top one, and its older landing is the index the jump is about to give to b.
		const { el, nav } = await mount(entries, 5, browserPrefs('all'));
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;

		// b prints its two spots and c its two: a and d hold one each, which is not a list
		// of its own (see RecentFilesList.printsLandings).
		expect(places()).toBe(4);
		// c's older landing — the step recorded at scroll 7, printed "L8": the top of that
		// note by line order, which is not the one its own row stands for (the newest,
		// scroll 30) but the one this reader picked.
		const row = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L8')!;
		click(row);

		expect(nav.jumped).toEqual([3]);
		// The note travelled to is now the current one — and, being the place just sat
		// in, the newest one, so its row is the list's first…
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent).toBe('c');
		// …and the stack was rewritten under the panel: the jump left c holding ONE spot,
		// while b — which took the slot c's old landing index pointed into — prints its own
		// two. The list is drawn from the new stack either way; what the collapse buys is
		// that nothing is left POINTED at (see RecentFilesList.collapse).
		expect(places()).toBe(2);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
	});
});

describe('activateRecentFilesView', () => {
	it('brings the panel that is already open back rather than opening a second', async () => {
		const leaf = new WorkspaceLeaf();
		const revealLeaf = vi.fn(async () => {});
		const getRightLeaf = vi.fn();
		const app = {
			workspace: {
				getLeavesOfType: (type: string) => (type === RECENT_FILES_VIEW_TYPE ? [leaf] : []),
				revealLeaf,
				getRightLeaf,
			},
		};

		await activateRecentFilesView(app as never, new FakeNav() as never, undefined, browserPrefs());

		expect(revealLeaf).toHaveBeenCalledWith(leaf);
		// Two panels of one history, each with its own filter and its own open
		// notes, is a way to be shown two different answers to one question.
		expect(getRightLeaf).not.toHaveBeenCalled();
	});

	it('opens the panel in the right sidebar when there is none', async () => {
		// The stub's leaf carries the `state` the last setViewState was handed;
		// the app's own typings do not declare it (see obsidian-stub.ts).
		const leaf = new WorkspaceLeaf() as WorkspaceLeaf & { state: unknown };
		const revealLeaf = vi.fn(async () => {});
		const app = {
			workspace: {
				getLeavesOfType: () => [],
				revealLeaf,
				getRightLeaf: () => leaf,
			},
		};

		await activateRecentFilesView(app as never, new FakeNav() as never, undefined, browserPrefs());

		expect(leaf.state).toEqual({ type: RECENT_FILES_VIEW_TYPE, active: true });
		expect(revealLeaf).toHaveBeenCalledWith(leaf);
	});
});
