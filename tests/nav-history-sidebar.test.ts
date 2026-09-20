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
import type { LandingsMode } from '@/nav-history/browser/listing';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';

// jsdom implements no layout, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

// The browser's preferences as the plugin hands them over (see NavBrowserPrefs). The
// panel only READS them, so the shell tests need a set and nothing more — a fresh one
// per mount, so no test decides another's — except for the one that hands the WRITE
// back, which is how a test sees the panel ask the plugin to remember a value it was
// given (see setLandings). The details column is ON, as the fixture in the DOM suite
// is (see there): what these tests are about is the panel it draws.
function browserPrefs(landings: LandingsMode = 'last'): NavBrowserPrefs {
	return {
		previewMode: () => 'spot',
		setPreviewMode: () => undefined,
		landings: () => landings,
		setLandings: (how) => {
			landings = how;
		},
		showDetails: () => true,
		setShowDetails: () => undefined,
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

		// The body, whole: the toolbar (with the list's own setting at its end — this is
		// the same body the dialog mounts, so both shells carry it), the list of notes
		// (the current one pinned first and marked), and the landing panel waiting beside
		// them.
		expect(el.querySelector('.position-restore-nav-filter')).not.toBeNull();
		expect(el.querySelector('.position-restore-nav-settings')).not.toBeNull();
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

	// The resident panel is the same body as the dialog's (see body.ts), so the details
	// column's own preference reaches it unasked — and a reader who switched the column
	// off gets a sidebar that is the list and nothing else, with the line under it saying
	// only what the list does (see NavBrowserPrefs.showDetails).
	it('drops the details column in the sidebar too when the preference says so', async () => {
		const off: NavBrowserPrefs = { ...browserPrefs(), showDetails: () => false };
		const { el } = await mount([visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 0, off);

		expect(el.querySelector('.nav-row-disclose')).toBeNull();
		expect(el.querySelector('.position-restore-nav-body')?.classList.contains('is-no-details')).toBe(true);
		expect(el.querySelector('.nav-preview-head')).toBeNull();
		const hint = el.querySelector<HTMLElement>('.position-restore-nav-hint')!;
		expect(hint.textContent).toBe(t('navHistory.clickHintOpen'));
		expect(hint.querySelector('.nav-hint-icon')).toBeNull();
	});

	it('leaves the caret in the editor: a restored panel focuses nothing', async () => {
		const { el } = await mount([visit('a.md', NOW)], 0);
		const input = el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		// The modal focuses this box on open, and is right to: it was opened on
		// purpose, and typing is the fastest way through the list. A panel that is
		// restored with the workspace must not take the caret out of the note.
		expect(document.activeElement).not.toBe(input);
		// …and it is still one click away, with the hint under it saying what a click
		// does — the mouse's own wording, since the panel is click-only and a pointer
		// must not change anything by passing over it (see NavHistoryList). The arrow
		// the sentence names is the row's own icon, drawn into the line (see
		// NavHistoryBrowser.hint).
		const hint = el.querySelector<HTMLElement>('.position-restore-nav-hint')!;
		expect(hint.textContent).toBe(t('navHistory.clickHint').replace('{arrow}', ''));
		expect(hint.querySelector('.nav-hint-icon svg')?.getAttribute('data-icon')).toBe('chevron-right');
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

	it('carries the list setting, and redraws on the spot when it is changed', async () => {
		// The body is the one the dialog mounts as well; what a sidebar adds is that it
		// STAYS UP, so the setting has to reach a list that is already standing — the
		// panel redraws itself rather than waiting for the history to move.
		const prefs = browserPrefs('last');
		const entries: NavHistoryEntry[] = [
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - 2 * MINUTE, st: { scroll: 10 } },
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, st: { scroll: 40 } },
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
	// A note with several spots, so there is a landing row to point at once the list
	// is asked to print them (see groupByFile / LandingsMode). The stack runs OLDEST
	// FIRST, which is the order a real history is built in (see NavHistory.push): the
	// newest thing the reader did in a.md is the second step, not the first.
	const stack = () => [
		{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - 2 * MINUTE, st: { scroll: 10 } },
		{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, st: { scroll: 40 } },
		{ kind: 'visit', path: 'b.md', leafId: 'leaf-1', t: NOW, st: { scroll: 0 } },
	] as NavHistoryEntry[];

	const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// The RIGHT button: the same journey as the row's own click, for the hand that is
	// already on the mouse (see NavHistoryList.onContextMenu). The button number IS the
	// gesture — a lingering finger's `contextmenu` carries the left one and must not
	// open anything.
	const rightClick = (el: HTMLElement) => el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
	);
	// The gutter control every row carries, and the ONE thing that points the panel at a
	// row without leaving it (see NavHistoryList.disclose). The test clicks it the way a
	// reader does — it is a real button, so a MouseEvent on it is the whole gesture.
	const disclose = (row: HTMLElement) => row.querySelector<HTMLElement>('.nav-row-disclose')!;

	it('points at a row from its own gutter control, and never on hover', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;
		const panel = el.querySelector<HTMLElement>('.position-restore-nav-preview')!;

		// The list as it opens: ONE row per note, and a.md's two spots are not printed
		// (see LandingsMode). Nothing is pointed at, so nothing is described either.
		expect(places()).toBe(0);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// A mouse merely crossing the rows is not a choice: nothing is pointed at, and
		// no landing panel appears under a row nobody asked about (which is what "hover
		// to expand" used to do here).
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 40 }));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(panel.classList.contains('is-parked')).toBe(true);

		// ONE click on the row's own gutter control points the panel at it, and it
		// answers NOW: it opens under the row and describes the spot that row stands for
		// — a.md's newest one, L41. It goes nowhere: looking is not going, and the row's
		// own click is a different gesture entirely (see NavHistoryList.onClick).
		click(disclose(note()));
		expect(note().classList.contains('is-selected')).toBe(true);
		expect(panel.classList.contains('is-parked')).toBe(false);
		expect(note().nextElementSibling).toBe(panel);
		expect(el.querySelector('.position-restore-nav-preview .nav-row-line')?.textContent).toBe('L41');
		expect(nav.jumped).toEqual([]);

		// …and one more puts it away again, at once: the same control undoes itself.
		click(disclose(note()));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(panel.classList.contains('is-parked')).toBe(true);
		expect(nav.jumped).toEqual([]);
	});

	it('prints a note\'s places when the list is asked for them, and points at the row that was used', async () => {
		const { el, nav } = await mount(stack(), 2, browserPrefs('all'));
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		const panel = el.querySelector<HTMLElement>('.position-restore-nav-preview')!;

		// Both of a.md's places, and nothing under b.md, which holds one (see
		// NavHistoryList.printsLandings).
		expect(el.querySelectorAll('.position-restore-nav-row.is-place')).toHaveLength(2);

		// The note's own gutter control opens its panel too: the details are what the
		// control promises, so its landings simply move down (see
		// NavHistoryList.panelAnchor).
		click(disclose(note()));
		expect(note().classList.contains('is-selected')).toBe(true);
		expect(panel.classList.contains('is-parked')).toBe(false);

		// …and a landing row opens the panel under itself, describing that spot.
		const place = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L11')!;
		click(disclose(place));
		expect(place.classList.contains('is-selected')).toBe(true);
		expect(panel.classList.contains('is-parked')).toBe(false);
		expect(place.nextElementSibling).toBe(panel);
		expect(el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		expect(nav.jumped).toEqual([]);
	});

	it('opens the file from the row itself, in one click, without pointing at it', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;

		// The row IS the navigation — that is what a navigator is for, and the name is
		// the target. The reader who already knows where they are going spends ONE click
		// and gets no panel (see NavHistoryList.onClick).
		expect(disclose(note())).not.toBeNull();
		// …and the name follows the control directly: the caret that used to lead the
		// row opened a sublist and is gone (see NavHistoryList.fileRow).
		expect(disclose(note()).nextElementSibling?.className).toBe('nav-row-file');
		click(note());

		// It opens the landing the note's row stands for: the NEWEST one, where the
		// reader left that note — step 1, L40 — and not the top of the note (step 0,
		// L10), which is what the row meant while its landings ran in line order (see
		// NavHistoryList.activeRep). And the control's own click did not run on the way:
		// the two hotspots are separate (see NavHistoryList.disclose).
		expect(nav.jumped).toEqual([1]);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
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

	it('points at a place from its gutter control, puts it away on the next, and opens the file from its row', async () => {
		const { el, nav } = await mount(stack(), 2, browserPrefs('all'));
		const place = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L11')!;

		// a.md's OLDER landing — the step recorded at scroll 10, printed "L11" (the
		// label is 1-based, see describeNavEntry) and the top of the note by line
		// order, which is the one the note's row does NOT stand for.
		click(disclose(place));
		// The panel opens under the row whose control was used, describing that landing.
		expect(place.classList.contains('is-selected')).toBe(true);
		expect(el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');

		// A second click on the same control puts it away again: the panel goes with it,
		// and nothing was opened.
		click(disclose(place));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(nav.jumped).toEqual([]);

		// …and the ROW is what opens the file — the panel has no control of its own any
		// more (see LandingPanel.caption). The panel stays up afterwards: this is the
		// resident form (the dialog closes itself — see modal.ts).
		click(disclose(place));
		click(place);
		expect(nav.jumped).toEqual([0]);
		expect(el.querySelector('.position-restore-nav-list')).not.toBeNull();
		expect(nav.listenerCount).toBe(1);
	});

	// The jump REWRITES the stack: the note it landed on is re-pushed on top and
	// pinned first, so every stack index below it shifts and the groups are rebuilt. A
	// position kept across that rewrite stands on whatever slid into its slot — a
	// panel describing a spot nobody chose. This is that list, and the regression it
	// guards.
	it('starts the next list from a cleared position, not from the note that used to be in that slot', async () => {
		const entries = [
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - 5 * MINUTE, st: { scroll: 10 } },
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-1', t: NOW - 4 * MINUTE, st: { scroll: 5 } },
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-1', t: NOW - 3 * MINUTE, st: { scroll: 50 } },
			{ kind: 'visit', path: 'c.md', leafId: 'leaf-1', t: NOW - 2 * MINUTE, st: { scroll: 7 } },
			{ kind: 'visit', path: 'c.md', leafId: 'leaf-1', t: NOW - MINUTE, st: { scroll: 30 } },
			{ kind: 'visit', path: 'd.md', leafId: 'leaf-1', t: NOW, st: { scroll: 1 } },
		] as NavHistoryEntry[];
		// The list as it stands: d (current) first, then c, b, a. c is the note below
		// the top one, and its older landing is the index the jump is about to give to b.
		const { el, nav } = await mount(entries, 5, browserPrefs('all'));
		const name = (n: string) => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === n)!;
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;
		const preview = () => el.querySelector<HTMLElement>('.position-restore-nav-preview')!;

		// b prints its two spots and c its two: a and d hold one each, which is not a
		// list of its own (see NavHistoryList.printsLandings).
		expect(places()).toBe(4);
		// c's older landing — the step recorded at scroll 7, printed "L8": the top of
		// that note by line order, which is not the one its own row stands for (the
		// newest, scroll 30) but the one this reader picked.
		const place = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'))
			.find(r => r.querySelector('.nav-row-line')?.textContent === 'L8')!;
		click(disclose(place));
		expect(place.classList.contains('is-selected')).toBe(true);

		click(place);

		expect(nav.jumped).toEqual([3]);
		// The note travelled to is now the current one, pinned first …
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent).toBe('c.md');
		// …and the stack was rewritten under the panel: the jump left c holding ONE spot,
		// while b — which took the slot c's old landing index pointed into — prints its
		// own two. The list is drawn from the new stack either way; what the collapse
		// buys is that nothing is left POINTED at (see NavHistoryList.collapse).
		expect(places()).toBe(2);
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
