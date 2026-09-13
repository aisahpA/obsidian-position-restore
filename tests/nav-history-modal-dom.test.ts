// DOM-level tests for the history browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the landing preview panel, and the file
// scope — its direct "only this note" switch, the picker chip beside it, and
// who owns the keyboard while the menu is up.
// The pure pieces (describe/group/merge/filter/time/segments/panes/files) are
// covered in nav-history-modal.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownView, Platform, TFile } from 'obsidian';

import { HOVER_LINK_SOURCE_ID, NavHistoryModal, POPOVER_LEFT_VAR, POPOVER_PENDING_CLASS, POPOVER_TOP_VAR } from '../src/nav-history-modal';
import type { NavHistoryEntry } from '../src/nav-entry';
import type { NavEntryState } from '../src/types';
import { t } from '../src/i18n';

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

const MINUTE = 60_000;
const NOW = Date.now();

const visit = (path: string, stamp: number, st?: NavEntryState): NavHistoryEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp, st });

// Parsed headings for the fixture note below, in the shape the metadata cache
// hands them over (1-based levels, positions in the file).
const A_DOC = '# 面板设计\n\n## 呈现方案\n\n### 预览\n\n预览条：悬停显示上下文三行\n\n尾巴\n';
const A_HEADINGS = {
	'a.md': [
		{ heading: '面板设计', level: 1, position: { start: { line: 0 } } },
		{ heading: '呈现方案', level: 2, position: { start: { line: 2 } } },
		{ heading: '预览', level: 3, position: { start: { line: 4 } } },
	],
};

function harness(
	entries: NavHistoryEntry[],
	index: number,
	files: Record<string, string> = {},
	deleted: string[] = [],
	// paths held open in an editor: the preview reads these WITHOUT touching the
	// vault, so `cachedRead` staying untouched is the assertion that it did.
	live: Record<string, string> = {},
	// parsed headings per path, as metadataCache would report them
	headingMap: Record<string, unknown[]> = {},
	// a touch device: no hover, so a tap both points and chooses
	mobile = false,
	// The main area's current layout: which tab (leaf id) shows which path, in
	// layout order. The pane marker is derived from THIS rather than from the
	// entries' own leafIds (see paneInfo), so a test that wants a marker has to
	// say which tabs are open now. Without it the `live` editors stand in as one
	// tab per path — which is never ambiguous, as in a real vault.
	layout: { leafId: string; path: string }[] = [],
) {
	const jumpTo = vi.fn(async () => {});
	const cachedRead = vi.fn(async (file: { path: string }) => files[file.path] ?? '');
	// workspace.trigger: how the modal talks to the core plugins — here, asking
	// the "Page preview" plugin for a native preview of the hovered row.
	const trigger = vi.fn();
	// The main root split, with one element per leaf inside it: isMainAreaLeaf
	// asks whether a leaf's element sits in the root's.
	const rootEl = document.createElement('div');
	document.body.appendChild(rootEl);
	const tabs = layout.length
		? layout
		: Object.keys(live).map((path) => ({ leafId: `open:${path}`, path }));
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (deleted.includes(path) || !(path in files))
					return null;
				return Object.assign(new TFile(), { path });
			},
			cachedRead,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) =>
				file.path in headingMap ? { headings: headingMap[file.path] } : null,
		},
		workspace: {
			trigger,
			rootSplit: { containerEl: rootEl },
			iterateAllLeaves: (cb: (leaf: unknown) => void) => {
				for (const tab of tabs) {
					const containerEl = document.createElement('div');
					rootEl.appendChild(containerEl);
					cb({
						id: tab.leafId,
						containerEl,
						view: Object.assign(Object.create(MarkdownView.prototype), {
							file: { path: tab.path },
							editor: { getValue: () => live[tab.path] ?? '' },
						}),
					});
				}
			},
		},
	};
	// The modal reads Platform once, at construction: flip it for exactly that
	// long, so the tap semantics are decided the way a real device would.
	const previous = Platform.isMobile;
	Platform.isMobile = mobile;
	let modal: NavHistoryModal;
	try {
		modal = new NavHistoryModal(app as never, { entries, index, jumpTo } as never);
	} finally {
		Platform.isMobile = previous;
	}
	modal.open();
	const rows = () => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.position-restore-nav-row'));
	const key = (k: string) => modal.modalEl.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
	return { modal, jumpTo, cachedRead, trigger, el: modal.contentEl, rows, key };
}

beforeEach(() => {
	document.body.innerHTML = '';
	// the browser marks the body while it is open (see BODY_OPEN_CLASS): clear
	// children AND classes, or one test's marker leaks into the next
	document.body.className = '';
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
	document.body.className = '';
});

describe('NavHistoryModal — current position', () => {
	it('pins the current entry as a card and keeps it out of the list', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		const card = h.el.querySelector('.position-restore-nav-here');
		expect(card?.textContent).toContain(t('navHistory.current'));
		expect(card?.textContent).toContain('c.md');

		// the list is "everything else": the current entry is the card, not a row
		const texts = h.rows().map(r => r.textContent ?? '');
		expect(texts).toHaveLength(2);
		expect(texts.some(x => x.includes('c.md'))).toBe(false);
		// ...and it is split into directions around it (no forward half here)
		const segments = Array.from(h.el.querySelectorAll('.position-restore-nav-segment')).map(s => s.textContent ?? '');
		expect(segments.some(s => s.includes(t('navHistory.seg.back')))).toBe(true);
		expect(segments.some(s => s.includes(t('navHistory.seg.forward')))).toBe(false);
	});

	it('labels rows with a relative time instead of a step count', () => {
		const entries = [visit('a.md', NOW - 3 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' });
		expect(h.rows()[0].querySelector('.nav-row-time')?.textContent)
			.toBe(t('navHistory.time.minutes', 3));
	});
});

describe('NavHistoryModal — keyboard', () => {
	it('does nothing on Enter until a row is pointed at', () => {
		// Enter used to fall back to "go back one step", which meant the same key
		// did two different things depending on whether the pointer had crossed a
		// row — and duplicated the app's own back command. Going back one step
		// needs no panel at all.
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('Enter');

		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('arrows move the selection and Enter jumps to it', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('ArrowDown'); // b.md (the newest back entry)
		h.key('ArrowDown'); // a.md
		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('promises nothing on the pinned card: it is an indicator, not a control', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' });

		// no hint line, and no click target: the card says where you are, and
		// nothing else (the list below is where things happen)
		expect(h.el.querySelector('.nav-here-hint')).toBeNull();
		h.el.querySelector<HTMLElement>('.position-restore-nav-here')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.jumpTo).not.toHaveBeenCalled();
	});
});

describe('NavHistoryModal — file scope', () => {
	// Sitting on c.md, with a fresher back step in ANOTHER note: the back steps
	// newest-first are b.md, c.md (older), a.md — so the scope has something to
	// drop in every direction, and Enter has a different answer with it on.
	const entries = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('c.md', NOW - 4 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };

	const chip = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLElement>('.position-restore-nav-scope-btn');
	const chipLabel = (h: ReturnType<typeof harness>) =>
		h.el.querySelector('.nav-scope-label')?.textContent;
	const menu = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLElement>('.position-restore-nav-scope-menu');
	const menuOpen = (h: ReturnType<typeof harness>) =>
		menu(h) !== null && !menu(h)!.classList.contains('is-closed');
	const click = (el: Element | null | undefined) =>
		el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	const openMenu = (h: ReturnType<typeof harness>) => click(chip(h));
	const items = (h: ReturnType<typeof harness>) =>
		Array.from(h.el.querySelectorAll<HTMLElement>('.nav-scope-item'));
	// The item by what it SAYS: names are what a user picks by, and the tags
	// around them (◂ folder, count) are decoration on the same string.
	const named = (h: ReturnType<typeof harness>, label: string) =>
		items(h).find(i => i.textContent?.includes(label));
	const pick = (h: ReturnType<typeof harness>, label: string) => click(named(h, label));
	// The direct switch beside the chip: "only this note", one click, the
	// commonest pick — and the same state the chip shows, seen from the note's
	// side.
	const switchBox = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLInputElement>('.position-restore-nav-toggle input');
	const setSwitch = (h: ReturnType<typeof harness>, on: boolean) => {
		const b = switchBox(h)!;
		b.checked = on;
		b.dispatchEvent(new Event('change', { bubbles: true }));
	};
	const filterBox = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

	it('shows the whole history until a file is picked, and offers the notes it has been in', () => {
		const h = harness(entries(), 3, files);
		// Nothing is narrowed on open: both controls say so and the menu is down.
		expect(chipLabel(h)).toBe(t('navHistory.scope.all'));
		expect(menuOpen(h)).toBe(false);
		expect(switchBox(h)!.checked).toBe(false);
		expect(h.rows()).toHaveLength(3);

		openMenu(h);
		expect(menuOpen(h)).toBe(true);

		// "all files" first, then every note the history has been in, by NAME:
		// the panel answers "recently" elsewhere (the pinned card, the switch,
		// the chronological list), so the picker is the lookup index.
		const labels = items(h).map(i => i.querySelector('.nav-scope-item-name')?.textContent);
		expect(labels).toEqual([t('navHistory.scope.all'), 'a.md', 'b.md', 'c.md']);
		// The count is the list the pick will show, so the current note's own
		// step — the card, never a row — is not counted: c.md has two, one of
		// them the card.
		expect(named(h, 'a.md')?.textContent).toContain(t('navHistory.scope.count', 1));
		expect(named(h, 'c.md')?.textContent).toContain(t('navHistory.scope.count', 1));
	});

	it('narrows the list to ANY note the history has been in', () => {
		// This is what the checkbox could not do: it only ever meant the note
		// the pinned card shows.
		const h = harness(entries(), 3, files);
		expect(h.rows()).toHaveLength(3);

		openMenu(h);
		pick(h, 'a.md');

		expect(menuOpen(h)).toBe(false);
		expect(chipLabel(h)).toBe('a.md');
		expect(chip(h)!.classList.contains('is-active')).toBe(true);
		expect(chip(h)!.getAttribute('title')).toBe(t('navHistory.onlyThisFileTip', 'a.md'));

		const rows = h.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain('a.md');
		expect(rows.some(r => /[bc]\.md/.test(r.textContent ?? ''))).toBe(false);
	});

	it('offers no picker at all when the history holds no file', () => {
		// A graph-only stack has nothing to narrow to: no chip rather than a
		// chip whose menu is empty.
		const graph = harness(
			[{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW }] as NavHistoryEntry[],
			0,
			files,
		);
		expect(graph.el.querySelector('.position-restore-nav-scope')).toBeNull();
		expect(graph.el.querySelector('.position-restore-nav-toggle')).toBeNull();
	});

	it('offers no switch when the pinned card is not a note', () => {
		// The card is a graph step, so there is no "this note" — but the history
		// HAS been in a.md, and that is still worth a picker. (The old chip
		// vanished entirely here, which lost the scope along with the shortcut.)
		const graph = harness(
			[visit('a.md', NOW - MINUTE), { kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW }] as NavHistoryEntry[],
			1,
			files,
		);
		expect(graph.el.querySelector('.position-restore-nav-toggle')).toBeNull();
		expect(graph.el.querySelector('.position-restore-nav-scope')).not.toBeNull();
	});

	it('keeps the switch and the picker on one state', () => {
		const h = harness(entries(), 3, files);

		// the switch narrows to the current note; the chip names it
		setSwitch(h, true);
		expect(chipLabel(h)).toBe('c.md');

		// picking ANOTHER note unchecks the switch: the scope is no longer this
		// note, and a checked box would claim it was
		openMenu(h);
		pick(h, 'a.md');
		expect(switchBox(h)!.checked).toBe(false);
		expect(chipLabel(h)).toBe('a.md');

		// picking THIS note checks it again — one state, two controls
		openMenu(h);
		pick(h, 'c.md');
		expect(switchBox(h)!.checked).toBe(true);
		expect(h.el.querySelector('.position-restore-nav-toggle')?.classList.contains('is-active')).toBe(true);

		// …and switching off from there is "no scope", not "that other note"
		setSwitch(h, false);
		expect(chipLabel(h)).toBe(t('navHistory.scope.all'));
		expect(h.rows()).toHaveLength(3);
	});

	it('takes the picked file back off the list again', () => {
		const h = harness(entries(), 3, files);
		openMenu(h);
		pick(h, 'a.md');
		expect(h.rows()).toHaveLength(1);

		openMenu(h);
		pick(h, t('navHistory.scope.all'));

		expect(chipLabel(h)).toBe(t('navHistory.scope.all'));
		expect(chip(h)!.classList.contains('is-active')).toBe(false);
		expect(h.rows()).toHaveLength(3);
	});

	it('narrows the list to that note, and the segment counts follow it', () => {
		const h = harness(entries(), 3, files);
		expect(h.rows()).toHaveLength(3);

		setSwitch(h, true);

		// one click, no menu: this is the pick the switch exists for
		expect(chipLabel(h)).toBe('c.md');
		expect(chip(h)!.classList.contains('is-active')).toBe(true);
		expect(h.el.querySelector('.position-restore-nav-toggle')?.classList.contains('is-active')).toBe(true);

		const rows = h.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain('c.md');
		expect(rows.some(r => /[ab]\.md/.test(r.textContent ?? ''))).toBe(false);
		// the header counts STEPS, so it has to count the ones still on screen
		const seg = Array.from(h.el.querySelectorAll('.position-restore-nav-segment'))
			.map(s => s.textContent ?? '').join(' ');
		expect(seg).toContain(t('navHistory.seg.count', 1));
		// the current position itself is the card, never a row, scope or not
		expect(h.el.querySelector('.position-restore-nav-here')?.textContent).toContain('c.md');
	});

	it('asks for "no other position" rather than blaming an absent query', () => {
		// the current note has no other landing at all
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, files);
		setSwitch(h, true);
		expect(h.rows()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent)
			.toBe(t('navHistory.scopeEmpty', 'b.md'));
	});

	it('composes with the search box: the query is judged inside the scope', () => {
		const h = harness(entries(), 3, files);
		setSwitch(h, true);
		// this matches the OTHER note, which the scope has already dropped
		filterBox(h).value = 'b.md';
		filterBox(h).dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.rows()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('navHistory.noMatch'));
	});

	it('narrows what the selection and Enter can reach after the scope is on', () => {
		const h = harness(entries(), 3, files);

		h.key('ArrowDown'); // b.md, the newest back step
		expect(h.rows()[0].querySelector('.nav-row-name')?.textContent).toBe('b.md');
		expect(h.rows()[0].classList.contains('is-selected')).toBe(true);

		// Scoping to c.md drops b.md, and the selection goes with it: the only
		// back step left is c.md's earlier spot.
		setSwitch(h, true);
		expect(h.rows()).toHaveLength(1);
		expect(h.rows()[0].classList.contains('is-selected')).toBe(false);

		h.key('ArrowDown');
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('gives the menu the arrows and Enter while it is up, and Escape only the menu', () => {
		const h = harness(entries(), 3, files);
		openMenu(h);

		// ↓ walks the MENU from the scope the list already shows ("all files"),
		// and the selection behind the overlay must not move with it.
		h.key('ArrowDown');
		expect(h.rows().some(r => r.classList.contains('is-selected'))).toBe(false);
		h.key('Enter');
		expect(menuOpen(h)).toBe(false);
		expect(chipLabel(h)).toBe('a.md');

		// Escape is next: the menu's own key while it is up. The app closes a
		// modal on Escape through a document handler, so the event must not
		// reach one — stopping it is what keeps the panel open for one more
		// look at the list.
		const seen: string[] = [];
		const spy = (ev: KeyboardEvent) => seen.push(ev.key);
		document.addEventListener('keydown', spy);
		openMenu(h);
		const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		h.modal.modalEl.dispatchEvent(esc);
		document.removeEventListener('keydown', spy);

		expect(menuOpen(h)).toBe(false);
		expect(esc.defaultPrevented).toBe(true);
		expect(seen).toEqual([]);
	});

	it('puts the menu away when the user clicks elsewhere or starts typing', () => {
		const h = harness(entries(), 3, files);

		openMenu(h);
		click(filterBox(h));
		expect(menuOpen(h)).toBe(false);

		openMenu(h);
		h.key('b'); // a printable key means "I am typing a filter, not choosing"
		expect(menuOpen(h)).toBe(false);

		// ...and so does editing what is already there
		openMenu(h);
		h.key('Backspace');
		expect(menuOpen(h)).toBe(false);
	});

	it('hands focus back to the search box, so neither control stops typing', () => {
		const h = harness(entries(), 3, files);
		// a real click focuses a control before its handler runs
		chip(h)!.focus();
		expect(document.activeElement).not.toBe(filterBox(h));

		openMenu(h);
		expect(document.activeElement).toBe(filterBox(h));

		pick(h, 'a.md');
		expect(document.activeElement).toBe(filterBox(h));

		switchBox(h)!.focus();
		expect(document.activeElement).not.toBe(filterBox(h));
		setSwitch(h, true);
		expect(document.activeElement).toBe(filterBox(h));
	});

	it('does not raise the keyboard when a finger narrows the list', () => {
		// Same two controls, touch device: taking the focus is what unfolds the
		// on-screen keyboard over the list the user just narrowed.
		const h = harness(entries(), 3, files, [], {}, {}, true);

		openMenu(h);
		pick(h, 'a.md');

		expect(document.activeElement).not.toBe(filterBox(h));
		expect(chip(h)!.classList.contains('is-active')).toBe(true);
		expect(h.rows()).toHaveLength(1);

		setSwitch(h, false);
		expect(document.activeElement).not.toBe(filterBox(h));
		expect(h.rows()).toHaveLength(3);
	});
});

describe('NavHistoryModal — deleted entries', () => {
	it('lists a deleted step but never makes it a jump target', () => {
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'b.md': '' }, ['gone.md']);

		const row = h.rows()[0];
		expect(row.classList.contains('is-missing')).toBe(true);
		// the type cell that used to spell this out is gone; the name carries it
		expect(row.querySelector('.nav-row-file')?.classList.contains('is-missing')).toBe(true);

		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.jumpTo).not.toHaveBeenCalled();

		// and it is not on the keyboard path either: with no other entry left,
		// Enter has nowhere to go (jumping would move the stack pointer onto a
		// step that cannot be restored).
		h.key('Enter');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});
});

describe('NavHistoryModal — repeat landings', () => {
	// A reading capture lands on a viewport line, which is what the list
	// collapses by.
	const at = (path: string, line: number, agoMin: number): NavHistoryEntry =>
		visit(path, NOW - agoMin * MINUTE, { mode: 'preview', scroll: line, anchor: `line ${line}` });
	const files = { 'x.md': '', 'y.md': '' };

	it('collapses repeat landings into one row, keeping the newest time', () => {
		// Bouncing between the note being written and its reference: every
		// return to x.md L412 is the same place, not four places.
		const h = harness([
			at('x.md', 100, 30), at('x.md', 412, 25), at('x.md', 412, 20), at('x.md', 412, 10),
			visit('y.md', NOW),
		], 4, files);

		expect(h.rows()).toHaveLength(2); // L100 and L412 — not four rows
		expect(h.rows()[0].textContent).toContain('×3');
		// the count is its own cell in the row's right-hand strip, and the file
		// cell holds nothing but the name
		expect(h.rows()[0].querySelector('.nav-row-count')?.textContent).toBe('×3');
		expect(h.rows()[0].querySelector('.nav-row-file .nav-row-count')).toBeNull();
		expect(h.rows()[0].querySelector('.nav-row-time')?.textContent)
			.toBe(t('navHistory.time.minutes', 10));
		// the row's newest member is what a click travels to
		h.rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.jumpTo).toHaveBeenCalledWith(3);
	});

	it('never merges a back row with a forward one at the same landing', () => {
		// x.md L100 sits on both sides of the current entry: one is reachable
		// by going back, the other by going forward, so they stay two rows.
		const h = harness([at('x.md', 412, 30), at('x.md', 100, 20), at('x.md', 412, 5), at('x.md', 100, 1)], 2, files);

		expect(h.rows()).toHaveLength(3);
		expect(h.rows().some(r => r.textContent?.includes('×'))).toBe(false);
	});

	it('says nothing for a pair: ×2 is a count not worth a chip', () => {
		// The row IS merged (two steps, one landing) — but two is the commonest
		// count there is, and the chip cost every row 4ch of quiet zone to say
		// it. The count starts at three, so the cell is there and empty.
		const h = harness([at('x.md', 412, 20), at('x.md', 412, 10), visit('y.md', NOW)], 2, files);

		expect(h.rows()).toHaveLength(1);
		expect(h.rows()[0].querySelector('.nav-row-count')?.textContent).toBe('');
		expect(h.rows()[0].textContent).not.toContain('×');
	});

	it('counts steps in the segment headers, not rows', () => {
		const h = harness([at('x.md', 412, 30), at('x.md', 412, 20), at('x.md', 412, 10), visit('y.md', NOW)], 3, files);

		expect(h.rows()).toHaveLength(1);
		const back = Array.from(h.el.querySelectorAll('.position-restore-nav-segment'))
			.map(seg => seg.textContent ?? '')
			.find(text => text.includes(t('navHistory.seg.back')));
		expect(back).toContain(t('navHistory.seg.count', 3));
	});
});

describe('NavHistoryModal — panes', () => {
	const pane = (path: string, leafId: string, stamp: number): NavHistoryEntry =>
		({ kind: 'visit', path, leafId, t: stamp });

	it('names the pane on the row, and only for a file held by two live tabs', () => {
		// a.md is open in two tabs; b.md in one (and is the current entry)
		const entries = [pane('a.md', 'left', NOW - 3 * MINUTE), pane('a.md', 'right', NOW - 2 * MINUTE), pane('b.md', 'left', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '' }, [], {}, {}, true, [
			{ leafId: 'left', path: 'a.md' },
			{ leafId: 'right', path: 'a.md' },
		]);

		// Two tabs of one file are otherwise IDENTICAL rows, and telling them
		// apart is what decides which row to pick. Which of how many, with no
		// word: "2/2" rather than "Pane 2".
		expect(h.rows()[0].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 2, 2));
		expect(h.rows()[1].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 1, 2));
		// ...and it is the file cell's name that stays authoritative
		expect(h.rows()[0].querySelector('.nav-row-file .nav-row-name')?.textContent).toBe('a.md');

		// The panel is driven by taps on touch (a synthesized mousemove is
		// ignored there — see the touch suite).
		h.rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); // the second tab
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 2, 2));

		h.rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); // the first
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 1, 2));
	});

	it('says nothing about panes when a file lives in one leaf', () => {
		const entries = [pane('a.md', 'left', NOW - 2 * MINUTE), pane('b.md', 'left', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' }, [], {}, {}, true, [
			{ leafId: 'left', path: 'a.md' },
		]);

		expect(h.rows()[0].querySelector('.nav-row-pane')?.textContent).toBe('');
		h.rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.el.querySelector('.nav-preview-pane')).toBeNull();
	});

	it('drops the number once that tab has moved to another file', () => {
		// The tab still exists — showing a DIFFERENT note. A number read off the
		// history kept claiming it as this file's second window; read off the
		// live layout it is simply not one of them any more, while a tab the
		// history never saw still counts.
		const entries = [pane('a.md', 'tab1', NOW - 3 * MINUTE), pane('a.md', 'tab2', NOW - 2 * MINUTE), pane('b.md', 'tab1', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '' }, [], {}, {}, true, [
			{ leafId: 'tab1', path: 'b.md' }, // walked away from a.md
			{ leafId: 'tab2', path: 'a.md' },
			{ leafId: 'tab3', path: 'a.md' }, // a tab the history never saw
		]);

		expect(h.rows()[0].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 1, 2));
		expect(h.rows()[1].querySelector('.nav-row-pane')?.textContent).toBe('');
	});
});

describe('NavHistoryModal — landing preview', () => {
	const read = { 'a.md': 'one\ntwo\nthree\nLANDING\nfive\nsix\nseven\neight', 'b.md': 'only line', 'c.md': 'x' };
	// b.md is current; the row BELOW it is a.md's reading capture (viewport
	// line 3, text "LANDING"), so a pointed row has a landing to show.
	// Two entries only: the list then holds exactly one row (a.md), with no
	// forward half to sort above it.
	const withLanding = [
		visit('a.md', NOW - 5 * MINUTE, { mode: 'preview', scroll: 3, anchor: 'LANDING' }),
		visit('b.md', NOW),
	];
	// On a touch device the panel is driven by TAPS: a synthesized mousemove is
	// deliberately ignored there (see the touch suite), so the row is clicked.
	const tap = (row: HTMLElement) => row.dispatchEvent(new MouseEvent('click', { bubbles: true }));

	it('renders only on a touch device, waiting out of the list until a row is tapped', () => {
		// A pointing device has the native page preview on hover instead, so the
		// panel must not exist there at all (it would be a hidden copy, paid for
		// with a file read per hovered row).
		const desktop = harness(withLanding, 1, read);
		expect(desktop.modal.modalEl.classList.contains('is-touch')).toBe(false);
		expect(desktop.el.querySelector('.nav-preview-note')).toBeNull();

		const touch = harness(withLanding, 1, read, [], {}, {}, true);
		expect(touch.modal.modalEl.classList.contains('is-touch')).toBe(true);
		// Parked in the body until a row is opened, then inside the list under
		// that row — never a standing panel of its own (see the touch suite).
		expect(touch.el.querySelector('.position-restore-nav-body > .position-restore-nav-preview')).not.toBeNull();
		expect(touch.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(true);
		expect(touch.el.querySelectorAll('.nav-preview-line')).toHaveLength(0);
	});

	it('follows the row that was tapped, showing its landing line in context', async () => {
		const h = harness(withLanding, 1, read, [], {}, {}, true);

		tap(h.rows()[0]);

		// three lines either side of the landing, clamped to the document
		await vi.waitFor(() => {
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(7);
		});
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		const landing = h.el.querySelector('.nav-preview-line.is-landing');
		expect(landing?.textContent).toContain('LANDING');
		// the same "Lnn" in the head's coordinate and in the gutter
		expect(landing?.querySelector('.nav-preview-num')?.textContent).toBe('L4');
		expect(h.el.querySelectorAll('.nav-preview-num')[0].textContent).toBe('L1');
	});

	it('follows the keyboard selection just the same', async () => {
		const h = harness(withLanding, 1, read, [], {}, {}, true);

		h.key('ArrowDown'); // selects a.md, the row below the current entry

		await vi.waitFor(() => {
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(7);
		});
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		expect(h.el.querySelector('.nav-preview-line.is-landing')?.textContent).toContain('LANDING');
	});

	it('ignores a mouseenter that no pointer movement produced', () => {
		// A browser synthesises mouseenter for whatever lands under a
		// stationary pointer when rows are rebuilt; honouring it would steal
		// the keyboard selection and silently retarget Enter.
		const h = harness(withLanding, 1, read, [], {}, {}, true);

		h.rows()[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
		expect(h.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(true);

		// Down selects the row, and Enter then travels to exactly that row.
		h.key('ArrowDown');
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('says so when the tapped row has no landing to show', () => {
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, read, [], {}, {}, true);

		tap(h.rows()[0]);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.none'));
	});

	it('previews a deleted row without letting it become the selection', () => {
		const h = harness(
			[visit('gone.md', NOW - MINUTE), visit('b.md', NOW)],
			1,
			read,
			['gone.md'],
			{},
			{},
			true,
		);

		tap(h.rows()[0]);
		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.gone'));
		// it is not a selection, and it grows no button to travel with
		expect(h.rows()[0].classList.contains('is-selected')).toBe(false);
		expect(h.el.querySelector('.nav-preview-go')).toBeNull();

		// Enter still means "go back one step" — never a jump to the dead row
		h.key('Enter');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});
});

describe('NavHistoryModal — where the type lives now', () => {
	it('keeps the row free of a type cell and names it in the panel', async () => {
		const switcher = { kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, via: 'switch' } as NavHistoryEntry;
		const h = harness([switcher, visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' }, [], {}, {}, true);

		expect(h.rows()[0].querySelector('.nav-row-badge')).toBeNull();

		// a tap, not a hover: on touch the panel is opened by tapping (see the
		// landing preview suite)
		h.rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.el.querySelector('.nav-preview-type')?.textContent).toBe(t('navHistory.type.switch'));
	});

	it('marks a deleted step on the file name, since the cell that said so is gone', () => {
		const gone = { kind: 'visit', path: 'gone.md', leafId: 'leaf-1', t: NOW - MINUTE } as NavHistoryEntry;
		const h = harness([gone, visit('b.md', NOW)], 1, { 'b.md': '' }, ['gone.md']);

		const name = h.rows()[0].querySelector('.nav-row-file');
		expect(name?.classList.contains('is-missing')).toBe(true);
		expect(name?.textContent).toBe('gone.md');
	});
});

describe('NavHistoryModal — section chain in a row', () => {
	// Two visible rows need two landings: entries sharing a leaf id and a line
	// are merged into one row (see mergeByLanding), and the harness's `visit`
	// builds them all on 'leaf-1'. The newest entry is the current one, pinned
	// in the card at the top rather than listed.
	const named = (pairs: [string, string][], files: Record<string, string>) =>
		harness(
			pairs.map(([path, leafId], i) => ({
				kind: 'visit',
				path,
				leafId,
				t: NOW - i * MINUTE,
			})) as NavHistoryEntry[],
			0,
			files,
		);

	it('prefixes the row with the deepest section levels', () => {
		const body = visit('a.md', NOW - MINUTE, { mode: 'preview', scroll: 6, anchor: '预览条：悬停显示上下文三行' });
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);

		// the deepest two levels, no file read needed
		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('sizes the age column from the labels on screen', () => {
		// jsdom has no layout at all, so the measurement reads zero and the
		// clamp's floor stands. What this pins is that the fit RUNS: without it
		// the track falls back to max-content, every row sizes its own age, and
		// the small print stops lining up down the list.
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' });

		const list = h.el.querySelector<HTMLElement>('.position-restore-nav-list');
		expect(list?.style.getPropertyValue('--nav-time-col')).toBe('40px');
	});

	// Every row is its own grid, so a `max-content` track would give each row its
	// own name width and the section would start at a different x on every line.
	// The column is measured once for the whole list instead — and in a document
	// with no layout engine there is nothing to measure, so the property must be
	// left UNSET (the stylesheet's fallback) rather than written as 0px, which
	// would draw every name in no space at all.
	it('leaves the name column unmeasured rather than 0px when there is no layout', () => {
		const h = named([
			['current.md', 'leaf-0'],
			['a.md', 'leaf-1'],
			['a-considerably-longer-name.md', 'leaf-2'],
		], { 'current.md': '', 'a.md': '', 'a-considerably-longer-name.md': '' });

		const list = h.el.querySelector<HTMLElement>('.position-restore-nav-list');
		expect(list?.style.getPropertyValue('--nav-name-col')).toBe('');
	});

	it('sizes the name column to the widest name, capped at 16em', () => {
		// A stub for the one thing jsdom lacks: text metrics. The font size comes
		// from the stub too, since that is what the 16em cap is computed from.
		const widths = new Map<string, number>([
			['a.md', 30],
			['a-considerably-longer-name.md', 500],
		]);
		let measured: Node | null = null;
		const ranges = vi.spyOn(document, 'createRange').mockImplementation(() => ({
			selectNodeContents(node: Node) {
				measured = node;
			},
			getBoundingClientRect: () => ({ width: measured ? widths.get(measured.textContent ?? '') ?? 0 : 0 }),
		}) as unknown as Range);
		const styles = vi
			.spyOn(window, 'getComputedStyle')
			.mockImplementation(() => ({ fontSize: '10px' }) as CSSStyleDeclaration);

		try {
			const h = named([
				['current.md', 'leaf-0'],
				['a.md', 'leaf-1'],
				['a-considerably-longer-name.md', 'leaf-2'],
			], { 'current.md': '', 'a.md': '', 'a-considerably-longer-name.md': '' });

			const list = h.el.querySelector<HTMLElement>('.position-restore-nav-list');
			// 500px of title, 160px of cap (16em at the stubbed 10px).
			expect(list?.style.getPropertyValue('--nav-name-col')).toBe('160px');
		} finally {
			ranges.mockRestore();
			styles.mockRestore();
		}
	});

	it('never lets the name column eat the section column on a narrow panel', () => {
		// The 16em cap is a cap in FONT units; in a narrow window it can still be
		// most of the row, and the section — half of what a row says — collapses
		// to nothing. The measured column is therefore also bounded by a share of
		// the panel it is measured in.
		const widths = new Map<string, number>([
			['a.md', 500],
			['a-considerably-longer-name.md', 500],
		]);
		let measured: Node | null = null;
		const ranges = vi.spyOn(document, 'createRange').mockImplementation(() => ({
			selectNodeContents(node: Node) {
				measured = node;
			},
			getBoundingClientRect: () => ({ width: measured ? widths.get(measured.textContent ?? '') ?? 0 : 0 }),
		}) as unknown as Range);
		const styles = vi
			.spyOn(window, 'getComputedStyle')
			.mockImplementation(() => ({ fontSize: '10px' }) as CSSStyleDeclaration);
		// jsdom lays nothing out, so the one number the fit needs from layout — how
		// wide the list actually is — has to be supplied.
		const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
			configurable: true,
			get: () => 300,
		});

		try {
			const h = named([
				['current.md', 'leaf-0'],
				['a.md', 'leaf-1'],
				['a-considerably-longer-name.md', 'leaf-2'],
			], { 'current.md': '', 'a.md': '', 'a-considerably-longer-name.md': '' });

			const list = h.el.querySelector<HTMLElement>('.position-restore-nav-list');
			// 35% of 300px, well under both the 160px font cap and the 500px name.
			expect(list?.style.getPropertyValue('--nav-name-col')).toBe('105px');
		} finally {
			if (clientWidth)
				Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
			ranges.mockRestore();
			styles.mockRestore();
		}
	});

	it('keeps every cell in place for a row with no section', () => {
		// The row is name | section | small print, and the small print is a block
		// of four cells: ×N | pane | coordinate | age. Every cell is rendered even
		// when empty. A cell left out would let the ones after it slide one column
		// left — the age into the ×N slot — on every note without headings, and
		// the strip's columns would stop lining up.
		const noHeadings = { 'a.md': [] };
		const body = visit('a.md', NOW - MINUTE, { mode: 'preview', scroll: 6, anchor: '没有标题的笔记' });
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, noHeadings);

		const row = h.rows()[0];
		expect([...row.children].map(el => el.className)).toEqual([
			'nav-row-file',
			'nav-row-trail',
			'nav-row-meta',
		]);
		expect([...row.querySelector('.nav-row-meta')!.children].map(el => el.className)).toEqual([
			'nav-row-count',
			'nav-row-pane',
			'nav-row-pos',
			'nav-row-time',
		]);
		expect(row.querySelector('.nav-row-trail')?.textContent).toBe('');
		expect(row.querySelector('.nav-row-count')?.textContent).toBe('');
	});

	it('shows the coordinates and the section, never the landing text', () => {
		const body = visit('a.md', NOW - MINUTE, { mode: 'preview', scroll: 6, anchor: '预览条：悬停显示上下文三行' });
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);

		const row = h.rows()[0];
		expect(row.querySelector('.nav-row-line')?.textContent).toBe('L7');
		expect(row.querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		// the words live in the preview (and the filter), not in the list
		expect(row.textContent).not.toContain('预览条');
	});

	it('does not repeat the heading the landing line itself carries', () => {
		// an outline jump lands ON "### 预览": the row already quotes it
		const jump = { kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:预览', t: NOW - MINUTE,
			st: { mode: 'preview', scroll: 4, anchor: '### 预览' } } as NavHistoryEntry;
		const h = harness([jump, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);

		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('面板设计›呈现方案');
	});
});

describe('NavHistoryModal — preview source', () => {
	const doc = '# 面板设计\n\n## 呈现方案\n\n### 预览\n\n预览条：悬停显示上下文三行\n\n尾巴\n';
	const entry = visit('a.md', NOW - MINUTE, { mode: 'preview', scroll: 6, anchor: '预览条：悬停显示上下文三行' });
	// touch harnesses: the panel opens on a tap
	const open = (h: ReturnType<typeof harness>) =>
		h.rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

	it('reads an open note from its editor, without touching the vault', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], { 'a.md': doc }, {}, true);

		open(h);

		await vi.waitFor(() => {
			// three lines either side of the landing: lines 4..10 of the doc
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(7);
		});
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('falls back to one vault read for a note that is not open', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], {}, {}, true);

		open(h);

		await vi.waitFor(() => {
			// three lines either side of the landing: lines 4..10 of the doc
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(7);
		});
		expect(h.cachedRead).toHaveBeenCalledTimes(1);
	});

	it('names the section the landing sits in, deepest last', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], { 'a.md': doc }, A_HEADINGS, true);

		open(h);

		await vi.waitFor(() => {
			expect(h.el.querySelector('.nav-preview-trail')).not.toBeNull();
		});
		const trail = h.el.querySelector('.nav-preview-trail')!;
		expect(trail.textContent).toBe(`面板设计›呈现方案›预览`);
		expect(trail.querySelector('.nav-trail-deep')?.textContent).toBe('预览');
	});
});

describe('NavHistoryModal — touch', () => {
	// Three notes, sitting on c.md: the back steps are b.md then a.md.
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const entries = () => [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
	const tap = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

	it('a tap opens the row and a second tap closes it again', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.rows()[0]); // b.md
		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.rows()[0].classList.contains('is-selected')).toBe(true);
		// The panel describes what the tap pointed at — that is what a tap is
		// for on touch, since there is no hover to preview with.
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');

		// The same row again: still no travel, and the panel closes. Opening was
		// the only thing a tap could do before, which left no way back to the
		// list without closing the whole dialog.
		tap(h.rows()[0]);
		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.rows()[0].classList.contains('is-selected')).toBe(false);
		expect(h.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(true);

		// …and it opens again on the next tap.
		tap(h.rows()[0]);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
	});

	it('tapping a different row only re-points', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.rows()[0]); // b.md
		tap(h.rows()[1]); // a.md

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
	});

	it('treats every column the same — the section column is not a special target', () => {
		// The section column is the row's hover-preview trigger on a pointing
		// device. On touch a tap there used to leak into that path (a WebView
		// sends a mousemove before the click), which made ONE column of a row
		// behave unlike the rest — the "why did that one jump?" report.
		for (const cell of ['.nav-row-file', '.nav-row-trail', '.nav-row-meta']) {
			const h = harness(entries(), 2, files, [], {}, {}, true);
			const target = h.rows()[0].querySelector<HTMLElement>(cell)!;

			target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
			target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(h.jumpTo).not.toHaveBeenCalled();
			expect(h.rows()[0].classList.contains('is-selected')).toBe(true);
			expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
		}
	});

	it('ignores the mousemove a tap synthesises, so the tap still opens the row', () => {
		// A touch WebView sends mouseover/mousemove before the click. The list's
		// mousemove handler used to take that for a hover: it selected the row
		// AND (over the section column, the one part of a row that does something
		// extra) asked the core page preview for a popover under the finger — so
		// that column behaved nothing like the rest of the row, and the click that
		// followed read as "this row is already open, close it again".
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const row = h.rows()[0];

		row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		expect(h.trigger).not.toHaveBeenCalled();
		expect(row.classList.contains('is-selected')).toBe(false);

		tap(row);
		expect(row.classList.contains('is-selected')).toBe(true);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
	});

	it('offers a button, because a tap only points', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.rows()[0]);
		const go = h.el.querySelector<HTMLElement>('.nav-preview-go');
		expect(go?.textContent).toBe(t('navHistory.jumpHere'));

		go!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('opens the landing under the row that was tapped, inside the list', () => {
		// The panel used to sit at the bottom of the dialog, where a long history
		// left it no height at all — off the bottom of the screen, with the only
		// button a finger can travel with. In the list's own flow it is always the
		// next thing below its row.
		const h = harness(entries(), 2, files, [], {}, {}, true);

		const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		expect(panel.classList.contains('is-parked')).toBe(true);
		expect(panel.parentElement?.className).toBe('position-restore-nav-body');

		tap(h.rows()[1]); // a.md — the oldest step
		expect(h.rows()[1].nextElementSibling).toBe(panel);
		expect(panel.classList.contains('is-parked')).toBe(false);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');

		// …and it moves with the selection rather than multiplying.
		tap(h.rows()[0]); // b.md
		expect(h.rows()[0].nextElementSibling).toBe(panel);
		expect(h.el.querySelectorAll('.position-restore-nav-preview')).toHaveLength(1);
	});

	it('parks the panel again when the filter takes its row away', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.rows()[0]); // b.md
		const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		expect(panel.classList.contains('is-parked')).toBe(false);

		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		input.value = 'c.md'; // matches nothing
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.rows()).toHaveLength(0);
		expect(panel.classList.contains('is-parked')).toBe(true);
		expect(panel.parentElement?.className).toBe('position-restore-nav-body');
	});

	it('leaves a pointing device its one-click travel', () => {
		const h = harness(entries(), 2, files);

		expect(h.el.querySelector('.nav-preview-go')).toBeNull();
		tap(h.rows()[0]);
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('opens without raising the on-screen keyboard', () => {
		// Focusing the search box is what unfolds a phone's keyboard across the
		// bottom half of the panel, over the list the panel exists for. The box
		// is one tap away when the user does mean to type.
		const touch = harness(entries(), 2, files, [], {}, {}, true);
		expect(touch.el.querySelector('.position-restore-nav-filter')).not.toBe(document.activeElement);

		// A pointing device has no keyboard to raise, and typing narrows the list
		// faster than tapping does, so it keeps the focus.
		const desktop = harness(entries(), 2, files);
		expect(desktop.el.querySelector('.position-restore-nav-filter')).toBe(document.activeElement);
	});

	it('talks about fingers, not keyboard keys', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		expect(h.el.querySelector('.position-restore-nav-hint')?.textContent).toBe(t('navHistory.touchHint'));
	});

	it('leaves the pinned card inert: it says where you are, nothing else', () => {
		// It used to take a tap as "go back one step" — the app's own back command,
		// which needs no panel at all, and a destination the first row of the back
		// segment already offers (with its landing shown before the click commits).
		const h = harness(entries(), 2, files, [], {}, {}, true);

		expect(h.el.querySelector('.nav-here-hint')).toBeNull();
		tap(h.el.querySelector<HTMLElement>('.position-restore-nav-here')!);
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('keeps the keyboard wording on a pointing device', () => {
		const h = harness(entries(), 2, files);

		expect(h.el.querySelector('.position-restore-nav-hint')?.textContent).toBe(t('navHistory.keyboardHint'));
		expect(h.el.querySelector('.nav-here-hint')).toBeNull();
	});
});

describe('NavHistoryModal — native page preview', () => {
	// a.md carries a landing at line 6; b.md is the current entry.
	const doc = { 'a.md': 'x'.repeat(10) + '\n' + Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'), 'b.md': '' };
	const landing = { mode: 'preview', scroll: 6, anchor: 'line 5' } as const;
	const at = () => [
		visit('a.md', NOW - 3 * MINUTE, { ...landing }),
		visit('b.md', NOW),
	];
	// jsdom lays nothing out, so every rect is zero and the section column is a
	// zero-width strip at x=0: a pointer move at x=0 is ON it, one at x=50 is
	// not. That is exactly the distinction the trigger makes.
	const hover = (el: HTMLElement, x = 0) =>
		el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x }));
	const payloadOf = (h: ReturnType<typeof harness>) => h.trigger.mock.calls[0][1] as Record<string, unknown>;

	it('hands the hovered row to the Page preview plugin, as a source it knows', () => {
		const h = harness(at(), 1, doc);

		hover(h.rows()[0]);

		expect(h.trigger).toHaveBeenCalledTimes(1);
		expect(h.trigger.mock.calls[0][0]).toBe('hover-link');
		const payload = payloadOf(h);
		// the id both ends agree on (main.ts registers it as a hover source)
		expect(payload.source).toBe(HOVER_LINK_SOURCE_ID);
		expect(payload.linktext).toBe('a.md');
		expect(payload.sourcePath).toBe('a.md');
		expect(payload.targetEl).toBe(h.rows()[0]);
		// the plugin parks its popover here and reads it back to hide it again
		expect(payload.hoverParent).toBe(h.modal);
		expect(payload.event).toBeInstanceOf(MouseEvent);
	});

	it('opens the preview at the landing line, not at the top of the file', () => {
		const h = harness(at(), 1, doc);

		hover(h.rows()[0]);

		expect(payloadOf(h).state).toEqual({ scroll: 6 });
	});

	it('sends no landing when the row has none to send', () => {
		// no recorded position: the preview simply opens at the top of the file
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, doc);

		hover(h.rows()[0]);

		expect(payloadOf(h).state).toBeUndefined();
	});

	it('does not ask for a deleted file, which has nothing to show', () => {
		const h = harness([visit('gone.md', NOW - MINUTE), visit('b.md', NOW)], 1, { 'b.md': '' }, ['gone.md']);

		hover(h.rows()[0]);

		expect(h.trigger).not.toHaveBeenCalled();
	});

	it('never asks twice in a row for the same row', () => {
		const h = harness(at(), 1, doc);

		hover(h.rows()[0]);
		hover(h.rows()[0]);

		expect(h.trigger).toHaveBeenCalledTimes(1);
	});

	it('asks only from the section column, not from the rest of the row', () => {
		// Pointing at a row still selects it (a click travels there); what the
		// row is NOT is a whole-note popover under the pointer every time the
		// list is scanned.
		const h = harness(at(), 1, doc);

		hover(h.rows()[0], 50); // the file name / coordinates, say
		expect(h.trigger).not.toHaveBeenCalled();
		// ...and the row is selected all the same
		expect(h.rows()[0].classList.contains('is-selected')).toBe(true);

		hover(h.rows()[0], 0); // onto the section column
		expect(h.trigger).toHaveBeenCalledTimes(1);
	});

	it('re-arms the section after the pointer leaves the list', () => {
		const h = harness(at(), 1, doc);

		hover(h.rows()[0]);
		expect(h.trigger).toHaveBeenCalledTimes(1);

		h.el.querySelector('.position-restore-nav-list')
			?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
		hover(h.rows()[0]);

		expect(h.trigger).toHaveBeenCalledTimes(2);
	});

	it('marks the body while it is open, so the popover clears the dialog', () => {
		// The core popover mounts on the body at --layer-popover (30), under
		// --layer-modal (50): styles.css needs this class to lift it.
		const h = harness(at(), 1, doc);
		expect(document.body.classList.contains('position-restore-nav-open')).toBe(true);

		h.modal.close();
		expect(document.body.classList.contains('position-restore-nav-open')).toBe(false);
	});
});

describe('NavHistoryModal — where the native preview goes', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const at = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	const hover = (el: HTMLElement, x = 0) =>
		el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x }));
	const left = () => document.body.style.getPropertyValue(POPOVER_LEFT_VAR);
	const top = () => document.body.style.getPropertyValue(POPOVER_TOP_VAR);

	it('asks for the preview beside the section cell, level with the row', () => {
		// jsdom has no layout, so every rect is 0: what this pins is that both
		// values are OUR coordinates (the section cell's right edge + the gap,
		// and the row's own top) and that they are rewritten per row, which is
		// what the stylesheet's clamps consume.
		const h = harness(at(), 1, files);
		expect(left()).toBe('8px'); // the resting value, before any hover
		expect(top()).toBe('0px');

		hover(h.rows()[0]);

		expect(left()).toBe('8px'); // 0 + the 8px gap, in a layout-free document
		expect(top()).toBe('0px');
		expect(document.body.classList.contains('position-restore-nav-open')).toBe(true);
	});

	it('anchors on the section cell and the row, not on the row box the plugin uses', () => {
		// jsdom lays nothing out, so the rects come from a stub keyed by class:
		// the row is wide and sits 240px down, its section cell ends well before
		// the row does. The popover must start at the CELL's right edge — the
		// column the pointer is on — and at the row's OWN top: the plugin's own
		// choice (the whole row's edge, one row further down) is what put the
		// preview half a panel away from the text being pointed at.
		const boxes: Record<string, { left: number; right: number; top: number }> = {
			'position-restore-nav-row': { left: 10, right: 700, top: 240 },
			'nav-row-trail': { left: 300, right: 420, top: 240 },
		};
		const original = Element.prototype.getBoundingClientRect;
		Element.prototype.getBoundingClientRect = function (this: Element) {
			const cls = Object.keys(boxes).find(c => this.classList.contains(c));
			const box = cls ? boxes[cls] : { left: 0, right: 0, top: 0 };
			return {
				...box,
				bottom: box.top + 20,
				width: box.right - box.left,
				height: 20,
				x: box.left,
				y: box.top,
				toJSON: () => ({}),
			} as DOMRect;
		};
		try {
			const h = harness(at(), 1, files);

			hover(h.rows()[0], 350); // on the section cell (see the stub above)

			expect(left()).toBe('428px'); // the cell's 420 + the 8px gap
			expect(top()).toBe('240px'); // the row's own top, not a row below it
		} finally {
			Element.prototype.getBoundingClientRect = original;
		}
	});

	it('clears its coordinates when the browser closes', () => {
		const h = harness(at(), 1, files);
		hover(h.rows()[0]);

		h.modal.close();

		expect(left()).toBe('');
		expect(top()).toBe('');
	});
});

describe('NavHistoryModal — the native preview waits for its landing', () => {
	// A file long enough that the landing is a real scroll, and the current
	// entry (b.md) so a.md is a row of the back segment.
	const doc = { 'a.md': Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'), 'b.md': '' };
	const landing = { mode: 'preview', scroll: 20, anchor: 'line 20' } as const;
	const at = (st?: NavEntryState) =>
		[visit('a.md', NOW - MINUTE, st), visit('b.md', NOW)];
	const hover = (el: HTMLElement) =>
		el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
	const pending = () => document.body.classList.contains(POPOVER_PENDING_CLASS);
	const frame = () => new Promise(r => requestAnimationFrame(() => r(null)));
	// The plugin's popover as the browser sees it: the element it renders into
	// and the row it was opened for. `landed` marks the line the renderer
	// scrolled to — the signal the hold is waiting for.
	const showPopover = (h: ReturnType<typeof harness>, row: HTMLElement, landed: boolean) => {
		const hoverEl = document.createElement('div');
		document.body.appendChild(hoverEl);
		if (landed)
			hoverEl.createDiv({ cls: 'is-flashing' });
		h.modal.hoverPopover = { hoverEl, targetEl: row } as never;
		return hoverEl;
	};

	it('holds the preview until the landing has been applied, then lets it through', async () => {
		const h = harness(at(landing), 1, doc);
		const row = h.rows()[0];

		hover(row);
		// The popover is being built: nothing is on screen yet, and the hold is
		// already on the body for styles.css to keep it invisible.
		expect(pending()).toBe(true);

		showPopover(h, row, true);
		await frame();

		expect(pending()).toBe(false);
	});

	it('keeps holding while the preview still shows the top of the file', async () => {
		const h = harness(at(landing), 1, doc);
		const row = h.rows()[0];

		hover(row);
		showPopover(h, row, false); // rendered, but the landing has not landed
		await frame();

		expect(pending()).toBe(true);
	});

	it('shows the preview anyway when no landing ever arrives', () => {
		vi.useFakeTimers();
		try {
			const h = harness(at(landing), 1, doc);
			const row = h.rows()[0];

			hover(row);
			showPopover(h, row, false);
			expect(pending()).toBe(true);

			vi.advanceTimersByTime(2000); // past the wait's deadline

			expect(pending()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not hold a preview with no landing to wait for', () => {
		// No recorded position: the preview opens at the top of the file by
		// design, so holding it would only make the user wait for nothing.
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, doc);

		hover(h.rows()[0]);

		expect(pending()).toBe(false);
	});

	it('does not hold the popover the plugin is already showing for the row', () => {
		// The plugin answers a repeat hover of the same row with the popover it
		// has (onHoverLink returns early for the same targetEl): nothing is
		// rebuilt, so there is no flash to hide.
		const h = harness(at(landing), 1, doc);
		const row = h.rows()[0];

		showPopover(h, row, true);
		hover(row);

		expect(pending()).toBe(false);
	});

	it('drops a hold left over from another row', () => {
		// Pointing at a landing row, then at one with nothing to land on: the
		// second preview must not wait on the first one's hold.
		const h = harness([
			visit('a.md', NOW - 3 * MINUTE, { ...landing }),
			visit('b.md', NOW - 2 * MINUTE),
			visit('c.md', NOW),
		], 2, { ...doc, 'c.md': '' });

		hover(h.rows().find(r => r.dataset.rep === '0')!);
		expect(pending()).toBe(true);

		hover(h.rows().find(r => r.dataset.rep === '1')!);

		expect(pending()).toBe(false);
	});

	it('lets a held preview through when the browser closes', () => {
		const h = harness(at(landing), 1, doc);

		hover(h.rows()[0]);
		expect(pending()).toBe(true);

		h.modal.close();

		expect(pending()).toBe(false);
	});
});
