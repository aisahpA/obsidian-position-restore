// The history browser's RESIDENT shell (browser/view.ts): what makes it a
// sidebar panel rather than a dialog — the pane's own lifetime around the body,
// the pane's own width deciding the presentation, and the history being heard
// while it is up (see NavHistory.subscribe). The body itself — the tree, the
// landing panel, the keyboard, the travel — is covered in
// nav-history-browser-dom.test.ts, where it is driven through the modal.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Menu, TFile, WorkspaceLeaf } from 'obsidian';

import { NAV_HISTORY_VIEW_TYPE, NavHistoryView, activateNavHistoryView } from '@/nav-history/browser/view';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';

// jsdom implements no layout, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

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

async function mount(entries: NavHistoryEntry[], index: number) {
	const nav = new FakeNav();
	nav.entries = entries;
	nav.index = index;
	const app = makeApp(entries.flatMap(e => (e.kind === 'view' ? [] : [e.path])));
	const leaf = Object.assign(new WorkspaceLeaf(), { app });
	// jsdom lays nothing out, so the pane reports width 0 — which is the INLINE
	// presentation, the one that needs no second column (see NavHistoryView.measure).
	const view = new NavHistoryView(leaf, nav as never, () => undefined);
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
		// driven by a mouse that must not change anything by passing over it.
		expect(el.querySelector('.position-restore-nav-hint')?.textContent).toBe(t('navHistory.clickHint'));
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
		expect(el.querySelector('.position-restore-nav-row.is-place')).toBeNull();

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
	// landing row to point at (see groupByFile).
	const stack = () => [
		{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW, st: { scroll: 10 } },
		{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, st: { scroll: 40 } },
		{ kind: 'visit', path: 'b.md', leafId: 'leaf-1', t: NOW - 2 * MINUTE, st: { scroll: 0 } },
	] as NavHistoryEntry[];

	const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	const rightClick = (el: HTMLElement) => el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
	);
	// The arrow every row carries, and the one control that travels in this panel (see
	// NavHistoryList.go). The test clicks it the way a reader does — it is a real
	// button, so a MouseEvent on it is the whole gesture.
	const arrow = (row: HTMLElement) => row.querySelector<HTMLElement>('.nav-row-go')!;

	// Menus are built by the browser and dropped in one statement, so the stub keeps
	// the ones that were shown; one test's menu must not be read by the next.
	beforeEach(() => Menu.reset());

	it('opens and closes a note on an explicit click, and never on hover', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;

		// Nothing is open to begin with: the tree is the notes.
		expect(places()).toBe(0);

		// A mouse merely crossing the rows is not a choice: no note opens, nothing is
		// pointed at, and no landing panel appears under a row nobody clicked (which
		// is what "hover to expand" used to do here).
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 40 }));
		expect(places()).toBe(0);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// ONE click opens it, and it opens NOW: nothing is held back waiting for a
		// second click that may never come. That wait is what the double click cost —
		// every plain click in the panel answered 300ms late, which a reader feels as a
		// dead list (see NavHistoryList.go) — and it goes nowhere: opening is not going.
		click(note());
		expect(places()).toBe(2);
		expect(nav.jumped).toEqual([]);

		// …and one more closes it again, at once: the same gesture undoes itself.
		click(note());
		expect(places()).toBe(0);
		expect(nav.jumped).toEqual([]);
	});

	it('travels from the row\'s own arrow, in one click, without opening anything', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		const places = () => el.querySelectorAll('.position-restore-nav-row.is-place').length;

		// The arrow stands in front of the row and says what it does before it is used:
		// the reader who already knows where they are going spends ONE click — no
		// opening the note, no pointing at a landing, no reaching for the panel's button.
		expect(arrow(note())).not.toBeNull();
		click(arrow(note()));

		// It travels to the landing the note's row stands for (the top of the note — see
		// NavHistoryList.activeRep), and the note never opened: the arrow's click is the
		// arrow's, not the row's.
		expect(nav.jumped).toEqual([0]);
		expect(places()).toBe(0);
	});

	it('offers the same travel in a right-click menu', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;

		rightClick(note());

		// The menu is the arrow's meaning in words — the same destination, and the same
		// word the panel's own button uses.
		const item = Menu.last?.items[0];
		expect(item?.title).toBe(t('navHistory.jumpHere'));
		expect(item?.disabled).toBe(false);
		// Opening a menu is not choosing from it.
		expect(nav.jumped).toEqual([]);

		item!.pick();
		expect(nav.jumped).toEqual([0]);
	});

	it('points at a landing on a click, puts it away on the next, and travels with the panel button', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a.md')!;
		click(note);

		const place = el.querySelector<HTMLElement>('.position-restore-nav-row.is-place')!;
		click(place);
		// The panel opens under the row that was clicked, with a button that travels to
		// the same landing the row's own arrow does.
		expect(place.classList.contains('is-selected')).toBe(true);
		expect(el.querySelector('.nav-preview-go')).not.toBeNull();

		// A second click on the same landing puts it away again: the panel goes with it,
		// and nothing was travelled to.
		click(place);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(nav.jumped).toEqual([]);

		// …and the panel's own button is what travels. The panel stays up afterwards:
		// this is the resident form (the dialog closes itself — see modal.ts).
		click(place);
		click(el.querySelector<HTMLElement>('.nav-preview-go')!);
		expect(nav.jumped).toHaveLength(1);
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
		expect(places()).toBe(2);
		// The first landing of c (the top of the note — see groupByFile's line order).
		const place = el.querySelector<HTMLElement>('.position-restore-nav-row.is-place')!;
		click(place);
		expect(el.querySelector('.nav-preview-go')).not.toBeNull();

		click(el.querySelector<HTMLElement>('.nav-preview-go')!);

		expect(nav.jumped).toEqual([3]);
		// The note travelled to is now the current one, pinned first — and b has taken
		// the group index c was opened at, which is the trap: without the collapse, b's
		// two landings would be on screen under a row nobody opened.
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent).toBe('c.md');
		expect(places()).toBe(0);
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

		await activateNavHistoryView(app as never, new FakeNav() as never);

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

		await activateNavHistoryView(app as never, new FakeNav() as never);

		expect(leaf.state).toEqual({ type: NAV_HISTORY_VIEW_TYPE, active: true });
		expect(revealLeaf).toHaveBeenCalledWith(leaf);
	});
});
