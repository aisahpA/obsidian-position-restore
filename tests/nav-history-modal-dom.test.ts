// DOM-level tests for the history browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the two views, and the preview strip. The
// pure pieces (describe/group/merge/filter/time/segments/panes) are covered in
// nav-history-modal.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownView, TFile } from 'obsidian';

import { NavHistoryModal } from '../src/nav-history-modal';
import type { NavHistoryEntry } from '../src/nav-entry';
import type { NavEntryState } from '../src/types';
import { t } from '../src/i18n';

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

const MINUTE = 60_000;
const NOW = Date.now();

const visit = (path: string, stamp: number, st?: NavEntryState): NavHistoryEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp, st });

function harness(
	entries: NavHistoryEntry[],
	index: number,
	files: Record<string, string> = {},
	deleted: string[] = [],
	// paths held open in an editor: the strip reads these WITHOUT touching the
	// vault, so `cachedRead` staying untouched is the assertion that it did.
	live: Record<string, string> = {},
) {
	const jumpTo = vi.fn(async () => {});
	const cachedRead = vi.fn(async (file: { path: string }) => files[file.path] ?? '');
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (deleted.includes(path) || !(path in files))
					return null;
				return Object.assign(new TFile(), { path });
			},
			cachedRead,
		},
		workspace: {
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
	const modal = new NavHistoryModal(app as never, { entries, index, jumpTo } as never);
	modal.open();
	const rows = () => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.position-restore-nav-row'));
	const key = (k: string) => modal.modalEl.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
	return { modal, jumpTo, cachedRead, el: modal.contentEl, rows, key };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
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

describe('NavHistoryModal — deleted entries', () => {
	it('lists a deleted step but never makes it a jump target', () => {
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'b.md': '' }, ['gone.md']);

		const row = h.rows()[0];
		expect(row.classList.contains('is-missing')).toBe(true);
		expect(row.textContent).toContain(t('navHistory.missing'));

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

	it('names the pane in the preview, and only for a file held by two of them', () => {
		// a.md sits in two panes; b.md only in one (and is the current entry)
		const entries = [pane('a.md', 'left', NOW - 3 * MINUTE), pane('a.md', 'right', NOW - 2 * MINUTE), pane('b.md', 'left', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '' });

		// pane identity is detail, not row furniture: the rows stay clean and
		// the strip names the pane the pointed-at row came from
		expect(h.el.querySelectorAll('.nav-row-pane')).toHaveLength(0);

		h.rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); // the right pane
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 2));

		h.rows()[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); // the left one
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 1));
	});

	it('says nothing about panes when a file lives in one leaf', () => {
		const entries = [pane('a.md', 'left', NOW - 2 * MINUTE), pane('b.md', 'left', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' });

		h.rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		expect(h.el.querySelector('.nav-preview-pane')).toBeNull();
	});
});

describe('NavHistoryModal — landing preview', () => {
	const read = { 'a.md': 'first\nsecond\nthird\nfourth', 'b.md': 'only line', 'c.md': 'x' };
	// b.md is current; the row BELOW it is a.md's reading capture (viewport
	// line 2, text "third"), so a pointed row has a landing to show.
	// Two entries only: the list then holds exactly one row (a.md), with no
	// forward half to sort above it.
	const withLanding = [
		visit('a.md', NOW - 5 * MINUTE, { mode: 'preview', scroll: 2, anchor: 'third' }),
		visit('b.md', NOW),
	];
	// Pointer movement is the only hover signal the modal listens to.
	const hover = (row: HTMLElement) => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

	it('says nothing until a row is pointed at', () => {
		const h = harness(withLanding, 1, read);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.idle'));
		expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(0);
	});

	it('follows the row under the pointer, showing its landing line in context', async () => {
		const h = harness(withLanding, 1, read);

		hover(h.rows()[0]);

		await vi.waitFor(() => {
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(3);
		});
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		const landing = h.el.querySelector('.nav-preview-line.is-landing');
		expect(landing?.textContent).toContain('third');
		expect(landing?.textContent).toContain('L3');
		expect(h.el.querySelectorAll('.nav-preview-num')[0].textContent).toBe('L2');
	});

	it('follows the keyboard selection just the same', async () => {
		const h = harness(withLanding, 1, read);

		h.key('ArrowDown'); // selects a.md, the row below the current entry

		await vi.waitFor(() => {
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(3);
		});
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		expect(h.el.querySelector('.nav-preview-line.is-landing')?.textContent).toContain('third');
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

describe('NavHistoryModal — row badge', () => {
	const badgeOf = (h: ReturnType<typeof harness>) =>
		h.rows()[0].querySelector('.nav-row-badge')?.textContent;

	it('leaves a plain open unlabelled, and labels every other origin', () => {
		const files = { 'a.md': '', 'b.md': '' };
		const open = { kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE } as NavHistoryEntry;

		// the default origin says nothing the row does not already say
		expect(badgeOf(harness([open, visit('b.md', NOW)], 1, files))).toBeUndefined();

		// everything the user actually chose keeps its label
		const switcher = { ...open, via: 'switch' } as NavHistoryEntry;
		expect(badgeOf(harness([switcher, visit('b.md', NOW)], 1, files))).toBe(t('navHistory.type.switch'));
		const outline = { kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:X', t: NOW - MINUTE } as NavHistoryEntry;
		expect(badgeOf(harness([outline, visit('b.md', NOW)], 1, files))).toBe(t('navHistory.type.outline'));
		const jump = { kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 9, t: NOW - MINUTE } as NavHistoryEntry;
		expect(badgeOf(harness([jump, visit('b.md', NOW)], 1, files))).toBe(t('navHistory.type.teleport'));
	});

	it('always labels a deleted step, whatever its origin', () => {
		const gone = { kind: 'visit', path: 'gone.md', leafId: 'leaf-1', t: NOW - MINUTE } as NavHistoryEntry;
		const h = harness([gone, visit('b.md', NOW)], 1, { 'b.md': '' }, ['gone.md']);
		expect(badgeOf(h)).toBe(t('navHistory.missing'));
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
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(3);
		});
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('falls back to one vault read for a note that is not open', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' });

		hover(h);

		await vi.waitFor(() => {
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(3);
		});
		expect(h.cachedRead).toHaveBeenCalledTimes(1);
	});

	it('names the section the landing sits in, deepest last', async () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], { 'a.md': doc });

		hover(h);

		await vi.waitFor(() => {
			expect(h.el.querySelector('.nav-preview-trail')).not.toBeNull();
		});
		const trail = h.el.querySelector('.nav-preview-trail')!;
		expect(trail.textContent).toBe(`面板设计›呈现方案›预览`);
		expect(trail.querySelector('.nav-trail-deep')?.textContent).toBe('预览');
	});
});
