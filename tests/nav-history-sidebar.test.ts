// The history browser's RESIDENT shell (browser/view.ts): what makes it a
// sidebar panel rather than a dialog — the pane's own lifetime around the body,
// the pane's own width deciding the presentation, and the history being heard
// while it is up (see NavHistory.subscribe). The body itself — the tree, the
// landing panel, the keyboard, the travel — is covered in
// nav-history-browser-dom.test.ts, where it is driven through the modal.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Platform, TFile, WorkspaceLeaf } from 'obsidian';

import { NAV_HISTORY_VIEW_TYPE, NavHistoryView, activateNavHistoryView } from '@/nav-history/browser/view';
import type { NavBrowserPrefs } from '@/nav-history/browser/body';
import type { LandingsMode } from '@/nav-history/browser/listing';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';

// jsdom implements no layout, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

// The browser's preferences as the plugin hands them over (see NavBrowserPrefs). The
// panel only READS them, so the shell tests need a set and nothing more — a fresh one
// per mount, so no test decides another's — except for the one that hands the WRITE
// back, which is how a test sees the panel ask the plugin to remember a value it was
// given (see setLandings).
function browserPrefs(landings: LandingsMode = 'last'): NavBrowserPrefs {
	return {
		landings: () => landings,
		setLandings: (how) => {
			landings = how;
		},
		// How far back the list reaches: chosen in the panel's gear (see
		// NavBrowserPrefs.placesCap).
		placesCap: () => 200,
		setPlacesCap: () => undefined,
	};
}

const MINUTE = 60_000;
const NOW = Date.now();

const visit = (path: string, stamp: number): NavHistoryEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp });

// A PLACE of a note: a jump the reader made. A note's own record (`visit`) is the
// note's ROW and carries no position at all (see places.ts), so a fixture that
// means "a spot in this note" builds the jump — a positioned visit is a shape the
// list never holds.
const place = (path: string, stamp: number, line: number): NavHistoryEntry =>
	({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:L${line}@${stamp}`, t: stamp, st: { scroll: line } });

// The place list as the view sees it: entries, the pointer, travel and subscribe
// (see places.ts's PlaceList). The real store is exercised against the same
// surface in nav-places.test.ts; here the point is the SHELL, so the list is a
// fixture that can be moved by hand.
class FakeNav {
	entries: NavHistoryEntry[] = [];
	index = -1;
	readonly jumped: number[] = [];
	private listeners = new Set<() => void>();

	// The real travel, in miniature: the place visited is re-stamped and becomes the
	// current one — so the list is rewritten under the panel, which is the whole
	// reason the panel has to collapse first (see NavPlaces.travel /
	// NavHistoryList.collapse).
	travel = async (i: number): Promise<void> => {
		this.jumped.push(i);
		const target = this.entries[i];
		this.entries = [...this.entries.slice(0, i), { ...target, t: Date.now() }];
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

	// A step the reader made elsewhere: every browser on screen is told (see
	// NavHistory.changed).
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
		files[path] = Object.assign(new TFile(), { path });
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files[path] ?? null,
			cachedRead: async () => '',
		},
		metadataCache: { getFileCache: () => null },
		workspace: {
			rootSplit: { containerEl: document.createElement('div') },
			iterateAllLeaves: () => undefined,
		},
	};
	return app as never;
}

async function mount(
	entries: NavHistoryEntry[],
	index: number,
	prefs: NavBrowserPrefs = browserPrefs(),
	// Paths the VAULT holds that no entry names yet: a test that appends a step to the
	// history while the panel is up needs the file behind it to exist, or the list
	// filters the new place out (see NavHistoryList.render).
	extraPaths: string[] = [],
) {
	const nav = new FakeNav();
	nav.entries = entries;
	nav.index = index;
	const app = makeApp([...entries.flatMap(e => (e.kind === 'view' ? [] : [e.path])), ...extraPaths]);
	const leaf = Object.assign(new WorkspaceLeaf(), { app });
	// jsdom lays nothing out, so the pane reports width 0 — which is the INLINE
	// presentation, the one that needs no second column (see NavHistoryView.measure).
	const view = new NavHistoryView(leaf, nav as never, () => undefined, prefs);
	await view.onOpen();
	// The view's OWN container and content elements: what the pane hands the
	// panel, and what Obsidian asks the view to build in.
	const el = view.containerEl;
	const rows = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'));
	const names = () => rows().map(r => r.querySelector('.nav-row-name')?.textContent);
	return { view, el, nav, rows, names };
}

describe('NavHistoryView — the resident panel', () => {
	beforeEach(() => {
		document.body.empty();
	});

	it('mounts the browser body into the pane, with no dialog around it', async () => {
		const { view, el, names } = await mount([visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1);

		// The body, whole: the toolbar (with the list's own setting at its end — this is
		// the same body the dialog mounts, so both shells carry it) and the list of notes,
		// the current one pinned first and marked.
		expect(el.querySelector('.position-restore-nav-filter')).not.toBeNull();
		expect(el.querySelector('.position-restore-nav-settings')).not.toBeNull();
		expect(names()).toEqual(['b.md', 'a.md']);
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent)
			.toBe('b.md');

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
		// …and it is still one click away, with the hint under it saying what that click
		// does — the mouse's own wording, since the list is click-only and a pointer must
		// not change anything by passing over it (see NavHistoryList).
		const hint = el.querySelector<HTMLElement>('.position-restore-nav-hint')!;
		expect(hint.textContent).toBe(t('navHistory.clickHint'));
	});

	it('follows the history while it is up', async () => {
		const { el, nav, names } = await mount(
			[visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1, browserPrefs(), ['c.md']);
		expect(names()).toEqual(['b.md', 'a.md']);

		// The reader walks to another note elsewhere in the app: the stack grows
		// under the panel and the panel redraws for it. Nothing was reopened; the
		// whole point is that this one is still standing.
		nav.entries = [...nav.entries, visit('c.md', NOW + MINUTE)];
		nav.moved(2);

		expect(names()).toEqual(['c.md', 'b.md', 'a.md']);
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent)
			.toBe('c.md');
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

	it('carries the list setting, and redraws on the spot when it is changed', async () => {
		// The body is the one the dialog mounts as well; what a sidebar adds is that it
		// STAYS UP, so the setting has to reach a list that is already standing — the
		// panel redraws itself rather than waiting for the history to move.
		const prefs = browserPrefs('last');
		const entries: NavHistoryEntry[] = [
			place('a.md', NOW - 2 * MINUTE, 10),
			place('a.md', NOW - MINUTE, 40),
			visit('b.md', NOW),
		];
		const { el } = await mount(entries, 2, prefs);
		expect(el.querySelectorAll('.position-restore-nav-row.is-place')).toHaveLength(0);

		el.querySelector<HTMLElement>('.position-restore-nav-settings')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const all = Array.from(el.querySelectorAll<HTMLElement>('.nav-settings-option'))
			.find(b => b.querySelector('.nav-settings-label')?.textContent === t('navHistory.landings.options.all'))!;
		all.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		// The choice went to the plugin (see NavBrowserPrefs.setLandings), and the list
		// under the panel is the new one, in the same breath.
		expect(prefs.landings()).toBe('all');
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
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;

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
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;

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

});

describe('NavHistoryView — the pointer is driven by clicks only', () => {
	// A note with several spots, so there is a landing row to click once the list is
	// asked to print them (see groupByFile / LandingsMode). The stack runs OLDEST FIRST,
	// which is the order a real history is built in (see NavHistory.push): the newest
	// thing the reader did in a.md is the second step, not the first.
	const stack = () => [
		place('a.md', NOW - 2 * MINUTE, 10),
		place('a.md', NOW - MINUTE, 40),
		place('b.md', NOW, 0),
	] as NavHistoryEntry[];

	const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// The RIGHT button, and a finger's lingering press (the same event with the left
	// button's number): neither opens anything (see NavHistoryList.onContextMenu).
	const rightClick = (el: HTMLElement) => el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
	);
	const noteRow = (el: HTMLElement, name: string) =>
		Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === name)!;

	it('chooses nothing on hover: only a click is a gesture', async () => {
		const { el } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a.md');

		// Nothing is chosen as the panel opens (see NavHistoryList.choose: a position is
		// a key or a click, and a click travels).
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// A mouse merely crossing the rows is not a choice. This is the rule the list is
		// built on (see NavHistoryList): a list that lurches under a passing mouse
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
		// NavHistoryList.printsLandings): one place is not a list.
		expect(el.querySelectorAll('.position-restore-nav-row.is-place')).toHaveLength(2);
		expect(el.querySelectorAll('.position-restore-nav-row.is-file')).toHaveLength(2);
	});

	it('opens the file from the row itself, in one click', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a.md');

		// The row IS the navigation — that is what a navigator is for, and the name is the
		// target. The reader who already knows where they are going spends ONE click.
		click(note());

		// It opens the landing the note's row stands for: the NEWEST one, where the
		// reader left that note — step 1, L40 — and not the top of the note (step 0,
		// L10), which is what the row meant while its landings ran in line order (see
		// NavHistoryList.activeRep). And no row is left selected: a click travels.
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
		const note = noteRow(el, 'a.md');

		rightClick(note);

		// The right button no longer travels: a row is opened by clicking it, and a
		// second button that opens the same thing is a gesture to learn for nothing
		// (see NavHistoryList.onContextMenu).
		expect(nav.jumped).toEqual([]);
	});

	it('leaves a press that was only held down where it was', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = noteRow(el, 'a.md');

		// The same event a WebView raises for a long touch, with the LEFT button on it:
		// nothing opens (see NavHistoryList.onContextMenu). It is the one that made a slow
		// tap on a tablet's file name look like a jump.
		const held = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
		note.dispatchEvent(held);

		expect(nav.jumped).toEqual([]);
		// Still refused, all the same: a row offers no menu, no callout and no selection
		// — a held press simply does nothing here.
		expect(held.defaultPrevented).toBe(true);
	});

	// The jump REWRITES the stack: the note it landed on is re-pushed on top and pinned
	// first, so every stack index below it shifts and the groups are rebuilt. A position
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
		] as NavHistoryEntry[];
		// The list as it stands: d (current) first, then c, b, a. c is the note below the
		// top one, and its older landing is the index the jump is about to give to b.
		const { el, nav } = await mount(entries, 5, browserPrefs('all'));
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;

		// b prints its two spots and c its two: a and d hold one each, which is not a list
		// of its own (see NavHistoryList.printsLandings).
		expect(places()).toBe(4);
		// c's older landing — the step recorded at scroll 7, printed "L8": the top of that
		// note by line order, which is not the one its own row stands for (the newest,
		// scroll 30) but the one this reader picked.
		const row = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L8')!;
		click(row);

		expect(nav.jumped).toEqual([3]);
		// The note travelled to is now the current one, pinned first …
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent).toBe('c.md');
		// …and the stack was rewritten under the panel: the jump left c holding ONE spot,
		// while b — which took the slot c's old landing index pointed into — prints its own
		// two. The list is drawn from the new stack either way; what the collapse buys is
		// that nothing is left POINTED at (see NavHistoryList.collapse).
		expect(places()).toBe(2);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
	});
});

describe('activateNavHistoryView', () => {
	it('brings the panel that is already open back rather than opening a second', async () => {
		const leaf = new WorkspaceLeaf();
		const revealLeaf = vi.fn(async () => {});
		const getRightLeaf = vi.fn();
		const app = {
			workspace: {
				getLeavesOfType: (type: string) => (type === NAV_HISTORY_VIEW_TYPE ? [leaf] : []),
				revealLeaf,
				getRightLeaf,
			},
		};

		await activateNavHistoryView(app as never, new FakeNav() as never, undefined, browserPrefs());

		expect(revealLeaf).toHaveBeenCalledWith(leaf);
		// Two panels of one history, each with its own filter and its own open
		// notes, is a way to be shown two different answers to one question.
		expect(getRightLeaf).not.toHaveBeenCalled();
	});

	it('opens the panel in the right sidebar when there is none', async () => {
		const leaf = new WorkspaceLeaf();
		const revealLeaf = vi.fn(async () => {});
		const app = {
			workspace: {
				getLeavesOfType: () => [],
				revealLeaf,
				getRightLeaf: () => leaf,
			},
		};

		await activateNavHistoryView(app as never, new FakeNav() as never, undefined, browserPrefs());

		expect(leaf.state).toEqual({ type: NAV_HISTORY_VIEW_TYPE, active: true });
		expect(revealLeaf).toHaveBeenCalledWith(leaf);
	});
});
