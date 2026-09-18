// The history browser's RESIDENT shell (browser/view.ts): what makes it a
// sidebar panel rather than a dialog — the pane's own lifetime around the body,
// the pane's own width deciding the presentation, and the history being heard
// while it is up (see NavHistory.subscribe). The body itself — the tree, the
// landing panel, the keyboard, the travel — is covered in
// nav-history-browser-dom.test.ts, where it is driven through the modal.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile, WorkspaceLeaf } from 'obsidian';

import { NAV_HISTORY_VIEW_TYPE, NavHistoryView, activateNavHistoryView } from '@/nav-history/browser/view';
import type { NavBrowserPrefs } from '@/nav-history/browser/body';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';

// jsdom implements no layout, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

// The browser's two preferences as the plugin hands them over (see
// NavBrowserPrefs). The panel only READS them, so the shell tests need a set and
// nothing more — a fresh one per mount, so no test decides another's.
function browserPrefs(): NavBrowserPrefs {
	return {
		previewMode: () => 'spot',
		setPreviewMode: () => undefined,
		landings: () => 'last',
	};
}

const MINUTE = 60_000;
const NOW = Date.now();

const visit = (path: string, stamp: number): NavHistoryEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp });

// The history as the view sees it: entries, the pointer, jumpTo and subscribe.
// The real class is exercised against the same surface in
// nav-history-recording.test.ts; here the point is the SHELL, so the stack is a
// fixture that can be moved by hand.
class FakeNav {
	entries: NavHistoryEntry[] = [];
	index = -1;
	readonly jumped: number[] = [];
	private listeners = new Set<() => void>();

	// The real jump, in miniature: the target is re-pushed on top, which TRUNCATES
	// the forward part and makes the note it landed on the current one — so the list
	// is rewritten under the panel, which is the whole reason the panel has to
	// collapse first (see NavHistory.jumpTo / NavHistoryList.collapse).
	jumpTo = async (i: number): Promise<void> => {
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
) {
	const nav = new FakeNav();
	nav.entries = entries;
	nav.index = index;
	const app = makeApp(entries.flatMap(e => (e.kind === 'view' ? [] : [e.path])));
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

		// The body, whole: the toolbar, the list of notes (the current one pinned
		// first and marked), and the landing panel waiting beside them.
		expect(el.querySelector('.position-restore-nav-filter')).not.toBeNull();
		expect(names()).toEqual(['b.md', 'a.md']);
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent)
			.toBe('b.md');
		expect(el.querySelector('.position-restore-nav-preview')).not.toBeNull();

		// The classes the shared presentation rules are written against (see
		// styles.css): without them a sidebar panel would fall back to the stock
		// text tiers and the drawer's two-column layout.
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
		// …and it is still one click away, with the hint under it saying what a click
		// does — the pointer's own wording of the tap mode, since a desktop sidebar is
		// driven by a mouse that must not change anything by passing over it. The arrow
		// the sentence names is the row's own icon, drawn into the line (see
		// NavHistoryBrowser.hint).
		const hint = el.querySelector<HTMLElement>('.position-restore-nav-hint')!;
		expect(hint.textContent).toBe(t('navHistory.clickHint').replace('{arrow}', ''));
		expect(hint.querySelector('.nav-hint-go svg')?.getAttribute('data-icon')).toBe('corner-up-right');
	});

	it('follows the history while it is up', async () => {
		const { el, nav, names } = await mount([visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1);
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

	it('asks the PANE how much room there is, not the window', async () => {
		const { view, el } = await mount([visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1);
		// jsdom reports no layout: the inline presentation, which needs no second
		// column and cannot be wrong about a pane nobody has measured.
		expect(view.contentEl.classList.contains('is-inline')).toBe(true);
		// …and inline, nothing is opened under a row the reader has not tapped: with
		// no position there is no row to hang a panel under, so it waits out of the
		// list (see LandingPanel.render).
		expect(el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(true);

		// A wide rail — or, on a phone, the sidebar drawer covering the screen —
		// has room for the list AND the landing column. The window it sits in is
		// not asked: a 300px rail inside a 1400px window would be told "plenty".
		Object.defineProperty(view.contentEl, 'clientWidth', { value: 900, configurable: true });
		view.onResize();
		expect(view.contentEl.classList.contains('is-inline')).toBe(false);
	});
});

describe('NavHistoryView — the pointer is driven by clicks only', () => {
	// A note with several landings, so the tree has something to open and there is a
	// landing row to point at (see groupByFile). The stack runs OLDEST FIRST, which
	// is the order a real history is built in (see NavHistory.push): the newest thing
	// the reader did in a.md is the second step, not the first.
	const stack = () => [
		{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - 2 * MINUTE, st: { scroll: 10 } },
		{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, st: { scroll: 40 } },
		{ kind: 'visit', path: 'b.md', leafId: 'leaf-1', t: NOW, st: { scroll: 0 } },
	] as NavHistoryEntry[];

	const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// The RIGHT button: the gesture that travels without the arrow (see
	// NavHistoryList.onContextMenu). The button number IS the gesture — a lingering
	// finger's `contextmenu` carries the left one and must not travel.
	const rightClick = (el: HTMLElement) => el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
	);
	// The arrow every row carries, and the one control that travels in this panel (see
	// NavHistoryList.go). The test clicks it the way a reader does — it is a real
	// button, so a MouseEvent on it is the whole gesture.
	const arrow = (row: HTMLElement) => row.querySelector<HTMLElement>('.nav-row-go')!;

	it('opens and closes a note on an explicit click, and never on hover', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;

		// The tree as it opens: a.md's NEWEST landing — the spot the reader left it at
		// (see NavHistoryList.shownLandings) — and nothing for b.md, whose one landing
		// makes it a leaf (its row stands for the spot, see activeRep).
		expect(places()).toBe(1);

		// A mouse merely crossing the rows is not a choice: no note opens further,
		// nothing is pointed at, and no landing panel appears under a row nobody
		// clicked (which is what "hover to expand" used to do here).
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 40 }));
		expect(places()).toBe(1);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// ONE click opens the REST of that note's landings, and it opens NOW: nothing is
		// held back waiting for a second click that may never come. That wait is what
		// the double click cost — every plain click in the panel answered 300ms late,
		// which a reader feels as a dead list (see NavHistoryList.go) — and it goes
		// nowhere: opening is not going.
		click(note());
		expect(places()).toBe(2);
		expect(nav.jumped).toEqual([]);

		// …and one more closes them again, at once: the same gesture undoes itself,
		// back to the one landing the default prints.
		click(note());
		expect(places()).toBe(1);
		expect(nav.jumped).toEqual([]);
	});

	it('travels from the row\'s own arrow, in one click, without opening anything', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;

		// The arrow stands in front of the row and says what it does before it is used:
		// the reader who already knows where they are going spends ONE click — no
		// opening the note, no pointing at a landing.
		expect(arrow(note())).not.toBeNull();
		// …and the name follows it directly: the caret that used to lead the row is gone
		// (see NavHistoryList.fileRow).
		expect(arrow(note()).nextElementSibling?.className).toBe('nav-row-file');
		click(arrow(note()));

		// It travels to the landing the note's row stands for: the NEWEST one, where the
		// reader left that note — step 1, L40 — and not the top of the note (step 0,
		// L10), which is what the row meant while its landings ran in line order (see
		// NavHistoryList.activeRep). And the note never opened: the arrow's click is the
		// arrow's, not the row's.
		expect(nav.jumped).toEqual([1]);
		// The jump re-pushed that note on top, so the list it left is that note alone,
		// printing the one landing it now stands on.
		expect(places()).toBe(1);
	});

	it('travels on a right-click too, in the same one press', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;

		rightClick(note());

		// One press, one journey — the same contract as the arrow, for the hand that
		// is already on the mouse, and the same destination (the note's newest landing,
		// see activeRep). It used to open a one-item menu that had to be picked, which
		// is a confirmation for a gesture that was already a decision (see
		// NavHistoryList.onContextMenu).
		expect(nav.jumped).toEqual([1]);
	});

	it('leaves a press that was only held down where it was', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;

		// The same event a WebView raises for a long touch, with the LEFT button on it:
		// not the gesture this panel travels on, so the panel does not move (see
		// NavHistoryList.onContextMenu). It is the one that made a slow tap on a
		// tablet's file name look like a jump.
		const held = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
		note.dispatchEvent(held);

		expect(nav.jumped).toEqual([]);
		// Still refused, all the same: a row offers no menu, no callout and no
		// selection — a held press simply does nothing here.
		expect(held.defaultPrevented).toBe(true);
	});

	it('points at a landing on a click, puts it away on the next, and leaves the travelling to its row', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		click(note);

		// a.md's OLDER landing — the step recorded at scroll 10, printed "L11" (the
		// label is 1-based, see describeNavEntry) and the top of the note by line
		// order, which is the one the note's row does NOT stand for.
		const place = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L11')!;
		click(place);
		// The panel opens under the row that was clicked, describing that landing.
		expect(place.classList.contains('is-selected')).toBe(true);
		expect(el.querySelector('.nav-preview-modes')).not.toBeNull();

		// A second click on the same landing puts it away again: the panel goes with it,
		// and nothing was travelled to.
		click(place);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(nav.jumped).toEqual([]);

		// …and the row's own arrow is what travels — the panel has no button of its own
		// any more (see LandingPanel.caption). The panel stays up afterwards: this is
		// the resident form (the dialog closes itself — see modal.ts).
		click(place);
		click(arrow(place));
		expect(nav.jumped).toEqual([0]);
		expect(el.querySelector('.position-restore-nav-list')).not.toBeNull();
		expect(nav.listenerCount).toBe(1);
	});

	// The jump REWRITES the stack: the note it landed on is re-pushed on top and
	// pinned first, so every group index below it shifts. A tree that redraws from the
	// reader's old open notes therefore opens whatever slid into that slot — a panel
	// describing a note nobody chose. This is that list, and the regression it guards.
	it('starts the next list from a closed tree, not from the note that used to be in that slot', async () => {
		const entries = [
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - 5 * MINUTE, st: { scroll: 10 } },
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-1', t: NOW - 4 * MINUTE, st: { scroll: 5 } },
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-1', t: NOW - 3 * MINUTE, st: { scroll: 50 } },
			{ kind: 'visit', path: 'c.md', leafId: 'leaf-1', t: NOW - 2 * MINUTE, st: { scroll: 7 } },
			{ kind: 'visit', path: 'c.md', leafId: 'leaf-1', t: NOW - MINUTE, st: { scroll: 30 } },
			{ kind: 'visit', path: 'd.md', leafId: 'leaf-1', t: NOW, st: { scroll: 1 } },
		] as NavHistoryEntry[];
		// The tree as it stands: d (current) first, then c, b, a. c is the note below
		// the top one — the index the jump is about to give to b.
		const { el, nav } = await mount(entries, 5);
		const name = (n: string) => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === n)!;
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;
		const preview = () => el.querySelector<HTMLElement>('.position-restore-nav-preview')!;

		click(name('c.md'));
		// b prints its newest landing and c its two (that click just opened them): a and
		// d are leaves and print none (see shownLandings / expandable).
		expect(places()).toBe(3);
		// c's older landing — the step recorded at scroll 7, printed "L8": the top of
		// that note by line order, which is not the one its own row stands for (the
		// newest, scroll 30) but the one this reader picked.
		const place = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L8')!;
		click(place);
		expect(place.classList.contains('is-selected')).toBe(true);

		click(arrow(place));

		expect(nav.jumped).toEqual([3]);
		// The note travelled to is now the current one, pinned first — and b has taken
		// the group index c was opened at, which is the trap: without the collapse, b's
		// own tree would come back open under a row nobody opened, printing both of its
		// landings where the default prints one.
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent).toBe('c.md');
		// b's newest landing, and nothing else: c is a leaf now and prints none, a is a
		// leaf.
		expect(places()).toBe(1);
		// …and the panel went with it: nothing is pointed at, so the inline panel is
		// parked rather than describing the landing the old index happened to name.
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(preview().classList.contains('is-parked')).toBe(true);
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
