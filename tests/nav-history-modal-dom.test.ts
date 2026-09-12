// DOM-level tests for the history browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the two views, and the preview strip. The
// pure pieces (describe/group/merge/filter/time/segments/panes) are covered in
// nav-history-modal.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownView, Platform, TFile } from 'obsidian';

import { HOVER_LINK_SOURCE_ID, NavHistoryModal, POPOVER_LEFT_VAR } from '../src/nav-history-modal';
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
) {
	const jumpTo = vi.fn(async () => {});
	const cachedRead = vi.fn(async (file: { path: string }) => files[file.path] ?? '');
	// workspace.trigger: how the modal talks to the core plugins — here, asking
	// the "Page preview" plugin for a native preview of the hovered row.
	const trigger = vi.fn();
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
			iterateAllLeaves: (cb: (leaf: unknown) => void) => {
				for (const path of Object.keys(live)) {
					cb({
						view: Object.assign(Object.create(MarkdownView.prototype), {
							file: { path },
							editor: { getValue: () => live[path] },
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
	it('a bare Enter goes back one step instead of re-landing the current entry', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledTimes(1);
		expect(h.jumpTo).toHaveBeenCalledWith(2 - 1);
	});

	it('arrows move the selection and Enter jumps to it', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('ArrowDown'); // b.md (the newest back entry)
		h.key('ArrowDown'); // a.md
		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('the promise is only shown when a back entry is actually reachable', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' });
		expect(h.el.querySelector('.nav-here-hint')?.textContent).toBe(t('navHistory.enterBack'));

		// filtered down to the current entry alone: no shortcut to promise
		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter');
		input!.value = 'b.md';
		input!.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.el.querySelector('.nav-here-hint')).toBeNull();
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

	const box = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLInputElement>('.position-restore-nav-toggle input');
	const label = (h: ReturnType<typeof harness>) =>
		h.el.querySelector('.position-restore-nav-toggle span')?.textContent;
	const filterBox = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
	const setScope = (h: ReturnType<typeof harness>, on: boolean) => {
		const b = box(h)!;
		b.checked = on;
		b.dispatchEvent(new Event('change', { bubbles: true }));
	};

	it('names the chip after the pinned card, and offers none without a file', () => {
		const h = harness(entries(), 3, files);
		expect(label(h)).toBe(t('navHistory.onlyThisFile', 'c.md'));
		expect(box(h)!.checked).toBe(false);

		// a graph step is not a place in a note: there is nothing to scope to
		const graph = harness(
			[visit('a.md', NOW - MINUTE), { kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW }] as NavHistoryEntry[],
			1,
			files,
		);
		expect(graph.el.querySelector('.position-restore-nav-toggle')).toBeNull();
	});

	it('narrows the list to that note, and the segment counts follow it', () => {
		const h = harness(entries(), 3, files);
		expect(h.rows()).toHaveLength(3);

		setScope(h, true);

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
		setScope(h, true);
		expect(h.rows()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent)
			.toBe(t('navHistory.scopeEmpty', 'b.md'));
		// and Enter has nothing left to promise: the only back step is elsewhere
		expect(h.el.querySelector('.nav-here-hint')).toBeNull();
	});

	it('composes with the search box: the query is judged inside the scope', () => {
		const h = harness(entries(), 3, files);
		setScope(h, true);
		// this matches the OTHER note, which the scope has already dropped
		filterBox(h).value = 'b.md';
		filterBox(h).dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.rows()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('navHistory.noMatch'));
	});

	it('keeps a bare Enter inside the note while the scope is on', () => {
		const without = harness(entries(), 3, files);
		without.key('Enter');
		expect(without.jumpTo).toHaveBeenCalledWith(2); // b.md, the newest back step

		const scoped = harness(entries(), 3, files);
		setScope(scoped, true);
		scoped.key('Enter');
		expect(scoped.jumpTo).toHaveBeenCalledWith(1); // back to the earlier c.md spot
	});

	it('hands focus back to the search box, so the toggle does not stop typing', () => {
		const h = harness(entries(), 3, files);
		// a real click focuses the checkbox before it fires change
		box(h)!.focus();
		expect(document.activeElement).not.toBe(filterBox(h));

		setScope(h, true);

		expect(document.activeElement).toBe(filterBox(h));
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

	it('names the pane on the row, and only for a file held by two of them', () => {
		// a.md sits in two panes; b.md only in one (and is the current entry)
		const entries = [pane('a.md', 'left', NOW - 3 * MINUTE), pane('a.md', 'right', NOW - 2 * MINUTE), pane('b.md', 'left', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '' });

		// Two panes of one file are otherwise IDENTICAL rows, and telling them
		// apart is what decides which row to pick — so the pane goes on the row,
		// as a suffix of the file cell (never a column of its own).
		expect(h.rows()[0].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 2));
		expect(h.rows()[1].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 1));
		// ...and it is a suffix, not a cell: the row keeps its four tracks
		expect(h.rows()[0].querySelector('.nav-row-file .nav-row-name')?.textContent).toBe('a.md');

		h.rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); // the right pane
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 2));

		h.rows()[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); // the left one
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 1));
	});

	it('says nothing about panes when a file lives in one leaf', () => {
		const entries = [pane('a.md', 'left', NOW - 2 * MINUTE), pane('b.md', 'left', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' });

		expect(h.rows()[0].querySelector('.nav-row-pane')).toBeNull();
		h.rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		expect(h.el.querySelector('.nav-preview-pane')).toBeNull();
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
	// Pointer movement is the only hover signal the modal listens to.
	const hover = (row: HTMLElement) => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

	it('is a panel beside the list, not a strip under it', () => {
		const h = harness(withLanding, 1, read);

		// The column layout hangs off this: both are children of the body, and
		// the preview is a sibling of the list rather than part of its flow.
		expect(h.el.querySelector('.position-restore-nav-body > .position-restore-nav-list')).not.toBeNull();
		expect(h.el.querySelector('.position-restore-nav-body > .position-restore-nav-preview')).not.toBeNull();
		expect(h.el.querySelector('.position-restore-nav-list .position-restore-nav-preview')).toBeNull();
	});

	it('says nothing until a row is pointed at', () => {
		const h = harness(withLanding, 1, read);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.idle'));
		expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(0);
	});

	it('follows the row under the pointer, showing its landing line in context', async () => {
		const h = harness(withLanding, 1, read);

		hover(h.rows()[0]);

		// three lines either side of the landing, clamped to the document
		await vi.waitFor(() => {
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(7);
		});
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		const landing = h.el.querySelector('.nav-preview-line.is-landing');
		expect(landing?.textContent).toContain('LANDING');
		expect(landing?.textContent).toContain('L4');
		expect(h.el.querySelectorAll('.nav-preview-num')[0].textContent).toBe('L1');
	});

	it('follows the keyboard selection just the same', async () => {
		const h = harness(withLanding, 1, read);

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
		const h = harness(withLanding, 1, read);

		h.rows()[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.idle'));

		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(0); // still "go back one step"
	});

	it('says so when the pointed row has no landing to show', () => {
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, read);

		hover(h.rows()[0]);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.none'));
	});

	it('previews a deleted row without letting it become the selection', () => {
		const h = harness(
			[visit('gone.md', NOW - MINUTE), visit('b.md', NOW)],
			1,
			read,
			['gone.md'],
		);

		hover(h.rows()[0]);
		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.gone'));

		// Enter still means "go back one step" — never a jump to the dead row
		h.key('Enter');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});
});

describe('NavHistoryModal — where the type lives now', () => {
	it('keeps the row free of a type cell and names it in the strip', async () => {
		const switcher = { kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, via: 'switch' } as NavHistoryEntry;
		const h = harness([switcher, visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' });

		expect(h.rows()[0].querySelector('.nav-row-badge')).toBeNull();

		h.rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
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
	it('prefixes the row with the deepest section levels', () => {
		const body = visit('a.md', NOW - MINUTE, { mode: 'preview', scroll: 6, anchor: '预览条：悬停显示上下文三行' });
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);

		// the deepest two levels, no file read needed
		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('keeps every cell in place for a row with no section', () => {
		// The row is a 4-track grid: file | section | line | age. A conditionally
		// rendered section cell would shift the cells after it one track left,
		// on every note without headings.
		const noHeadings = { 'a.md': [] };
		const body = visit('a.md', NOW - MINUTE, { mode: 'preview', scroll: 6, anchor: '没有标题的笔记' });
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, noHeadings);

		const row = h.rows()[0];
		expect([...row.children].map(el => el.className)).toEqual([
			'nav-row-file',
			'nav-row-trail',
			'nav-row-pos',
			'nav-row-time',
		]);
		expect(row.querySelector('.nav-row-trail')?.textContent).toBe('');
	});

	it('shows the coordinates and the section, never the landing text', () => {
		const body = visit('a.md', NOW - MINUTE, { mode: 'preview', scroll: 6, anchor: '预览条：悬停显示上下文三行' });
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);

		const row = h.rows()[0];
		expect(row.querySelector('.nav-row-line')?.textContent).toBe('L7');
		expect(row.querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		// the words live in the strip (and the filter), not in the list
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
	const hover = (h: ReturnType<typeof harness>) =>
		h.rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

	it('reads an open note from its editor, without touching the vault', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], { 'a.md': doc });

		hover(h);

		await vi.waitFor(() => {
			// three lines either side of the landing: lines 4..10 of the doc
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(7);
		});
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('falls back to one vault read for a note that is not open', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' });

		hover(h);

		await vi.waitFor(() => {
			// three lines either side of the landing: lines 4..10 of the doc
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(7);
		});
		expect(h.cachedRead).toHaveBeenCalledTimes(1);
	});

	it('names the section the landing sits in, deepest last', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], { 'a.md': doc }, A_HEADINGS);

		hover(h);

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

	it('a first tap only points at the row; a second one travels', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.rows()[0]); // b.md
		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.rows()[0].classList.contains('is-selected')).toBe(true);
		// The panel describes what the tap pointed at — that is what the first
		// tap is for, and it is the only preview a touch device can get.
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');

		tap(h.rows()[0]);
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('tapping a different row re-points instead of travelling', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.rows()[0]); // b.md
		tap(h.rows()[1]); // a.md

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
	});

	it('offers a button, because a tap only points', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.rows()[0]);
		const go = h.el.querySelector<HTMLElement>('.nav-preview-go');
		expect(go?.textContent).toBe(t('navHistory.jumpHere'));

		go!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('leaves a pointing device its one-click travel', () => {
		const h = harness(entries(), 2, files);

		expect(h.el.querySelector('.nav-preview-go')).toBeNull();
		tap(h.rows()[0]);
		expect(h.jumpTo).toHaveBeenCalledWith(1);
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
	const hover = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
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
	const hover = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
	const left = () => document.body.style.getPropertyValue(POPOVER_LEFT_VAR);

	it('asks for the preview beside the row, not across the list', () => {
		// jsdom has no layout, so every rect is 0: what this pins is that the
		// value is OUR coordinate (the anchor's right edge + the gap) and that it
		// is rewritten per row, which is what the stylesheet's clamp consumes.
		const h = harness(at(), 1, files);
		expect(left()).toBe('8px'); // the resting value, before any hover

		hover(h.rows()[0]);

		expect(left()).toBe('8px'); // 0 + the 8px gap, in a layout-free document
		expect(document.body.classList.contains('position-restore-nav-open')).toBe(true);
	});

	it('clears its coordinate when the browser closes', () => {
		const h = harness(at(), 1, files);
		hover(h.rows()[0]);

		h.modal.close();

		expect(left()).toBe('');
	});
});
