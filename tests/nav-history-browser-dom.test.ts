// DOM-level tests for the history browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the landing preview panel, and the file
// scope — its direct "only this note" switch, the picker chip beside it, and
// who owns the keyboard while the menu is up.
// The pure pieces (describe/group/merge/filter/time/segments/panes/files) are
// covered in nav-history-browser.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownView, Platform, TFile } from 'obsidian';

import { NavHistoryModal } from '@/nav-history/browser/modal';
import {
	HOVER_LINK_SOURCE_ID, POPOVER_LEFT_VAR, POPOVER_PENDING_CLASS, POPOVER_TOP_VAR,
} from '@/nav-history/browser/constants';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { NAV_CONTEXT_RADIUS } from '@/position/capture/ephemeral';
import type { NavEntryState } from '@/types';
import { t } from '@/i18n';

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

const MINUTE = 60_000;
const NOW = Date.now();

const visit = (path: string, stamp: number, st?: NavEntryState): NavHistoryEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp, st });

// A capture as the plugin records one now: the landing's surrounding NON-BLANK
// lines with `contextAt` marking it (see NavEntryState.context). Mirrors
// contextBlock in capture/ephemeral.ts at the same radius, so a fixture's panel
// content is the production shape instead of a hand-built one.
function captured(doc: string[], landing: number, lineCount = doc.length): NavEntryState {
	const side = (from: number, step: 1 | -1) => {
		const out: { line: number; text: string }[] = [];
		for (let i = from, taken = 0; i >= 0 && i < doc.length && taken < NAV_CONTEXT_RADIUS; i += step) {
			const text = doc[i].trim();
			if (!text)
				continue;
			if (step < 0)
				out.unshift({ line: i, text });
			else
				out.push({ line: i, text });
			taken++;
		}
		return out;
	};
	const before = side(landing - 1, -1);
	return {
		scroll: landing,
		anchor: doc[landing].trim(),
		context: [...before, { line: landing, text: doc[landing].trim() }, ...side(landing + 1, 1)],
		contextAt: before.length,
		lineCount,
	};
}

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
	// mtimes for the files above, as the vault would report them now: the
	// browser compares them with the mtime an entry recorded.
	mtimes: Record<string, number> = {},
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
				const file = Object.assign(new TFile(), { path });
				if (path in mtimes)
					file.stat = { ctime: 0, mtime: mtimes[path], size: 0 };
				return file;
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
		modal = new NavHistoryModal(app as never, {
			entries, index, jumpTo, stackCap: () => 50,
		} as never);
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

describe('NavHistoryModal — the dropped-steps footnote', () => {
	it('is gone: the stack sits at its cap in ordinary use, so it never earned a line', () => {
		// It reported what the ceiling had discarded, from the foot of the list —
		// which is below the fold exactly when entries HAVE been dropped (a stack
		// at the cap is what overflows the dialog), so nobody ever saw it. The
		// list has no such footnote left to render.
		const entries = [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' });

		expect(h.el.querySelector('.position-restore-nav-cap-note')).toBeNull();
	});
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
	// The file in force, as the chip alone still reports it: its visible label is
	// a CONSTANT (the chip is the control a pick is made from, and must not move
	// when the pick lands), it carries no tooltip, and so the accessible name is
	// the only place the scope is written down.
	const chipNames = (h: ReturnType<typeof harness>, path: string) => {
		expect(chip(h)!.getAttribute('aria-label')).toBe(t('navHistory.scope.current', path));
		expect(chip(h)!.getAttribute('title')).toBeNull();
	};
	// …and the same pair while nothing is narrowed.
	const chipFree = (h: ReturnType<typeof harness>) => {
		expect(chipLabel(h)).toBe(t('navHistory.scope.filter'));
		expect(chip(h)!.getAttribute('aria-label')).toBe(t('navHistory.scope.filter'));
		expect(chip(h)!.getAttribute('title')).toBeNull();
		expect(chip(h)!.classList.contains('is-active')).toBe(false);
	};
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
		chipFree(h);
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
		// Which file, without the label having moved a pixel to say it: the chip
		// still reads as the fixed action it read before the pick.
		chipNames(h, 'a.md');
		expect(chip(h)!.classList.contains('is-active')).toBe(true);

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

		// the switch narrows to the current note; the chip reports which file
		setSwitch(h, true);
		chipNames(h, 'c.md');

		// picking ANOTHER note unchecks the switch: the scope is no longer this
		// note, and a checked box would claim it was
		openMenu(h);
		pick(h, 'a.md');
		expect(switchBox(h)!.checked).toBe(false);
		chipNames(h, 'a.md');

		// picking THIS note checks it again — one state, two controls
		openMenu(h);
		pick(h, 'c.md');
		expect(switchBox(h)!.checked).toBe(true);
		expect(h.el.querySelector('.position-restore-nav-toggle')?.classList.contains('is-active')).toBe(true);

		// …and switching off from there is "no scope", not "that other note"
		setSwitch(h, false);
		chipFree(h);
		expect(h.rows()).toHaveLength(3);
	});

	it('takes the picked file back off the list again', () => {
		const h = harness(entries(), 3, files);
		openMenu(h);
		pick(h, 'a.md');
		expect(h.rows()).toHaveLength(1);

		openMenu(h);
		pick(h, t('navHistory.scope.all'));

		chipFree(h);
		expect(h.rows()).toHaveLength(3);
	});

	it('keeps the chip its own size: the label never becomes the file name', () => {
		// The control a pick is made FROM must not move when the pick lands.
		// jsdom measures no layout, so the observable proxy is the label itself:
		// one string for unscoped, scoped and scoped-elsewhere alike, with the
		// file riding on the accessible name and the tooltip.
		const h = harness(entries(), 3, files);
		const fixed = chipLabel(h);
		chipFree(h);

		openMenu(h);
		pick(h, 'a.md');
		expect(chipLabel(h)).toBe(fixed);
		chipNames(h, 'a.md');

		setSwitch(h, true);
		expect(chipLabel(h)).toBe(fixed);
		chipNames(h, 'c.md');

		setSwitch(h, false);
		expect(chipLabel(h)).toBe(fixed);
		chipFree(h);
	});

	it('leaves the hover hints off both scope controls', () => {
		// Each control is named by its own label, and which note "this" is, is
		// what the pinned card below already shows. A tooltip over the switch and
		// another over the chip were one sentence said twice, once per control.
		const h = harness(entries(), 3, files);
		const toggle = () => h.el.querySelector('.position-restore-nav-toggle');
		expect(toggle()?.getAttribute('title')).toBeNull();
		expect(chip(h)!.getAttribute('title')).toBeNull();

		// …and narrowing the list does not put one back on either of them
		openMenu(h);
		pick(h, 'a.md');
		expect(toggle()?.getAttribute('title')).toBeNull();
		expect(chip(h)!.getAttribute('title')).toBeNull();
	});

	it('narrows the list to that note, and the segment counts follow it', () => {
		const h = harness(entries(), 3, files);
		expect(h.rows()).toHaveLength(3);

		setSwitch(h, true);

		// one click, no menu: this is the pick the switch exists for
		chipNames(h, 'c.md');
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
		chipNames(h, 'a.md');

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

	it('says a step is dead in the accessibility tree, not only in a tooltip', () => {
		// The current entry is the pinned card, so two rows sit below it: a live
		// step and the deleted one.
		const entries = [
			visit('gone.md', NOW - 3 * MINUTE),
			visit('a.md', NOW - MINUTE),
			visit('c.md', NOW),
		];
		const h = harness(entries, 2, { 'a.md': '', 'c.md': '' }, ['gone.md']);

		const [live, dead] = h.rows();
		expect(live.textContent).toContain('a.md');
		expect(live.getAttribute('role')).toBe('option');
		expect(live.hasAttribute('aria-disabled')).toBe(false);

		expect(dead.textContent).toContain('gone.md');
		expect(dead.getAttribute('role')).toBe('option');
		expect(dead.getAttribute('aria-disabled')).toBe('true');
	});
});

describe('NavHistoryModal — keyboard is announced', () => {
	// The focus never leaves the filter box (typing narrows the list from the
	// same keys that walk it), so the box is an ARIA combobox over the list and
	// the current option is named by aria-activedescendant. Without that
	// attribute the arrow keys move a highlight a screen reader cannot see.
	it('wires the filter box to the list and follows the arrow keys', () => {
		const entries = [visit('a.md', NOW - 2 * MINUTE), visit('b.md', NOW - MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter');
		const list = h.el.querySelector('.position-restore-nav-list');
		expect(input?.getAttribute('role')).toBe('combobox');
		expect(input?.getAttribute('aria-expanded')).toBe('true');
		// The list's own id, whatever the browser numbered it: the two ends only
		// have to agree.
		expect(input?.getAttribute('aria-controls')).toBe(list?.id);
		// Nothing is selected on open, so there is nothing to announce yet.
		expect(input?.hasAttribute('aria-activedescendant')).toBe(false);

		h.key('ArrowDown'); // the first row, newest first
		const first = h.rows()[0];
		expect(input?.getAttribute('aria-activedescendant')).toBe(first.id);
		expect(first.getAttribute('aria-selected')).toBe('true');

		h.key('ArrowDown');
		const second = h.rows()[1];
		expect(input?.getAttribute('aria-activedescendant')).toBe(second.id);
		expect(second.getAttribute('aria-selected')).toBe('true');
		// The row left behind stops claiming to be current.
		expect(first.getAttribute('aria-selected')).toBe('false');
	});
});

describe('NavHistoryModal — repeat landings', () => {
	// A reading capture lands on a viewport line, which is what the list
	// collapses by.
	const at = (path: string, line: number, agoMin: number): NavHistoryEntry =>
		visit(path, NOW - agoMin * MINUTE, { scroll: line });
	const files = { 'x.md': '', 'y.md': '', 'z.md': '' };

	it('collapses repeat landings into one row, keeping the newest time', () => {
		// Bouncing between the note being written and its reference: every
		// return to x.md L412 is the same place, not four places.
		const h = harness([
			at('x.md', 100, 30), at('x.md', 412, 25), at('x.md', 412, 20), at('x.md', 412, 10),
			visit('y.md', NOW),
		], 4, files);

		expect(h.rows()).toHaveLength(2); // L100 and L412 — not four rows
		expect(h.rows()[0].textContent).toContain('×3');
		// the count rides with the NAME it belongs to, right after it — it is not
		// a cell of the small-print strip
		expect(h.rows()[0].querySelector('.nav-row-file .nav-row-count')?.textContent).toBe('×3');
		expect(h.rows()[0].querySelector('.nav-row-meta .nav-row-count')).toBeNull();
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

	it('never merges two different notes that share a leaf and a line', () => {
		// ONE tab walks from x.md to z.md, and both steps were captured at the
		// same line — the ordinary way to read two notes side by side. Keyed on
		// "line|leaf" the two collapsed into a single row that named the NEWER
		// note over the older one's place, and x.md's place was then unreachable
		// from the panel (see mergeKey).
		const h = harness([
			at('x.md', 100, 20), at('z.md', 100, 10), visit('y.md', NOW),
		], 2, files);

		expect(h.rows()).toHaveLength(2);
		expect(h.rows().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['z.md', 'x.md']);
	});

	it('says nothing for a pair: ×2 is a count not worth printing', () => {
		// The row IS merged (two steps, one landing) — but two is the commonest
		// count there is, and the count starts at three. Nothing is printed at
		// all, next to the name or anywhere else.
		const h = harness([at('x.md', 412, 20), at('x.md', 412, 10), visit('y.md', NOW)], 2, files);

		expect(h.rows()).toHaveLength(1);
		expect(h.rows()[0].querySelector('.nav-row-count')).toBeNull();
		expect(h.rows()[0].textContent).not.toContain('×');
	});

	it('rides the count with the name, and reserves no column for it', () => {
		// A three-step landing prints ×3 — right after the name it belongs to, on
		// the row that owns it, and NOWHERE on the row that does not (there is no
		// column to reserve). The pane's column is a different question: no row
		// has a pane here, so no row may hold 4ch + a gap for one.
		const h = harness([
			at('x.md', 100, 40), at('x.md', 412, 30), at('x.md', 412, 20), at('x.md', 412, 10),
			visit('y.md', NOW),
		], 4, files);

		expect(h.rows()).toHaveLength(2); // the ×3 landing, then the single one
		expect(h.rows()[0].querySelector('.nav-row-file .nav-row-count')?.textContent).toBe('×3');
		// the element still comes AFTER the name in the DOM, so it reads as
		// "x.md ×3" and not the other way round
		expect(h.rows()[0].querySelector('.nav-row-file')?.lastElementChild?.className).toBe('nav-row-count');
		expect(h.rows()[0].querySelector('.nav-row-meta .nav-row-count')).toBeNull();
		// the row with no count of its own carries no cell at all
		expect(h.rows()[1].querySelector('.nav-row-count')).toBeNull();
		// and the badge is nowhere in the list
		expect(h.rows()[0].querySelector('.nav-row-pane')).toBeNull();
		expect(h.rows()[1].querySelector('.nav-row-pane')).toBeNull();
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

		expect(h.rows()[0].querySelector('.nav-row-pane')).toBeNull();
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
		// The row with no number of its own still gets the CELL: the column is
		// reserved list-wide the moment one row uses it, or the two coordinates
		// would not line up down the list (see list.ts renderChronological).
		expect(h.rows()[1].querySelector('.nav-row-pane')?.textContent).toBe('');
	});
});

describe('NavHistoryModal — landing preview', () => {
	const doc = ['one', 'two', 'three', 'LANDING', 'five', 'six', 'seven', 'eight'];
	const read = { 'a.md': doc.join('\n'), 'b.md': 'only line', 'c.md': 'x' };
	// b.md is current; the row BELOW it is a.md's capture, landing on the
	// "LANDING" line, so a pointed row has a recorded block to show.
	// Two entries only: the list then holds exactly one row (a.md), with no
	// forward half to sort above it.
	const withLanding = [
		visit('a.md', NOW - 5 * MINUTE, captured(doc, 3)),
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

		// The whole recorded block: five non-blank lines either side, clamped to
		// the document — the eight lines this file has, none of them blank.
		await vi.waitFor(() => {
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(8);
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
			expect(h.el.querySelectorAll('.nav-preview-line')).toHaveLength(8);
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
		// Exactly one admission: with no recorded block there is nothing to add,
		// and "file deleted" has already said the thing that matters.
		expect(h.el.querySelectorAll('.nav-preview-note')).toHaveLength(1);
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
		const body = visit('a.md', NOW - MINUTE, captured(A_DOC.split('\n'), 6));
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

	it('sizes the name column to the widest name, capped at 20em', () => {
		// A stub for the one thing jsdom lacks: text metrics. The font size comes
		// from the stub too, since that is what the 20em cap is computed from.
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
			// 500px of title, 200px of cap (20em at the stubbed 10px).
			expect(list?.style.getPropertyValue('--nav-name-col')).toBe('200px');
		} finally {
			ranges.mockRestore();
			styles.mockRestore();
		}
	});

	it('never lets the name column eat the section column on a narrow panel', () => {
		// The 20em cap is a cap in FONT units; in a narrow window it can still be
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
			// 45% of 300px, well under both the 200px font cap and the 500px name.
			expect(list?.style.getPropertyValue('--nav-name-col')).toBe('135px');
		} finally {
			if (clientWidth)
				Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
			ranges.mockRestore();
			styles.mockRestore();
		}
	});

	it('leaves the pane cell out of a list that has none', () => {
		// The row is name | section | small print, and the small print is down to
		// pane | coordinate | age (the ×N rides with the name): the pane cell is
		// created only while something in the list uses it (see list.ts
		// renderChronological) — reserved on every row it printed nothing, and the
		// 4ch + gap it held sat between the coordinate and the age of rows that
		// had none. What must not move is the order of the cells that remain.
		const noHeadings = { 'a.md': [] };
		const body = visit('a.md', NOW - MINUTE, captured(A_DOC.split('\n'), 6));
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, noHeadings);

		const row = h.rows()[0];
		expect([...row.children].map(el => el.className)).toEqual([
			'nav-row-file',
			'nav-row-trail',
			'nav-row-meta',
		]);
		expect([...row.querySelector('.nav-row-meta')!.children].map(el => el.className)).toEqual([
			'nav-row-pos',
			'nav-row-time',
		]);
		expect(row.querySelector('.nav-row-trail')?.textContent).toBe('');
		expect(row.querySelector('.nav-row-count')).toBeNull();
		expect(row.querySelector('.nav-row-pane')).toBeNull();
	});

	it('shows the coordinates and the section, never the landing text', () => {
		const body = visit('a.md', NOW - MINUTE, captured(A_DOC.split('\n'), 6));
		const h = harness([body, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);

		const row = h.rows()[0];
		expect(row.querySelector('.nav-row-line')?.textContent).toBe('L7');
		expect(row.querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		// the words live in the preview (and the filter), not in the list
		expect(row.textContent).not.toContain('预览条');
	});

	it('keeps the heading the landing line itself carries as the deepest level', () => {
		// an outline jump lands ON "### 预览". The row prints no landing text
		// (only the preview panel does), so that heading is the row's LAST level
		// — the one a reader places the spot by — and it stays in the chain.
		const jump = { kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:预览', t: NOW - MINUTE,
			st: captured(A_DOC.split('\n'), 4) } as NavHistoryEntry;
		const h = harness([jump, visit('b.md', NOW)], 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);

		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
	});
});

describe('NavHistoryModal — a file that holds several landings', () => {
	// A reading capture lands on a viewport line, which is what the list
	// collapses by; two DIFFERENT lines of one file stay two rows.
	const at = (path: string, line: number, agoMin: number): NavHistoryEntry =>
		visit(path, NOW - agoMin * MINUTE, { scroll: line });
	const files = { 'x.md': '', 'y.md': '', 'z.md': '' };
	const names = (h: ReturnType<typeof harness>) =>
		h.rows().map(r => ({
			text: r.querySelector('.nav-row-name')?.textContent,
			continuation: r.querySelector('.nav-row-name')?.classList.contains('is-continuation'),
		}));

	it('names the file once, on the first row of its own run', () => {
		// Three landings in one note: the block reads as one file's places
		// rather than as three copies of one name.
		const h = harness([at('x.md', 10, 30), at('x.md', 412, 20), at('x.md', 800, 10), visit('y.md', NOW)], 3, files);

		expect(h.rows()).toHaveLength(3);
		expect(names(h)).toEqual([
			{ text: 'x.md', continuation: false },
			{ text: 'x.md', continuation: true },
			{ text: 'x.md', continuation: true },
		]);
		// …and those rows SAY why their name is missing: a continuation mark
		// where the name would have been, not an empty cell.
		expect(h.rows()[0].querySelector('.nav-row-repeat')).toBeNull();
		expect(h.rows()[1].querySelector('.nav-row-repeat')?.textContent).toBe('↳');
		expect(h.rows()[2].querySelector('.nav-row-repeat')?.textContent).toBe('↳');
		// decorative: the clipped name in the same cell is what a screen reader
		// reads, so the mark is not part of the option's name
		expect(h.rows()[1].querySelector('.nav-row-repeat')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('names the file again after a row of another file', () => {
		const h = harness([at('x.md', 10, 30), at('y.md', 20, 20), at('x.md', 412, 10), visit('z.md', NOW)], 3, files);

		expect(names(h)).toEqual([
			{ text: 'x.md', continuation: false },
			{ text: 'y.md', continuation: false },
			{ text: 'x.md', continuation: false },
		]);
		expect(h.el.querySelectorAll('.nav-row-repeat')).toHaveLength(0);
	});

	it('names the file again under the second segment header', () => {
		// x.md sits on BOTH sides of the current entry, with two landings on the
		// forward side. The divider is a break in the reading order, so the run
		// does not continue across it: a mark under a header — like a blank name
		// before it — would point at nothing. The rows come forward-segment-first
		// (newest first).
		const h = harness([at('x.md', 10, 30), visit('y.md', NOW - 20 * MINUTE), at('x.md', 412, 20), at('x.md', 800, 10)], 1, files);

		expect(names(h)).toEqual([
			{ text: 'x.md', continuation: false },
			{ text: 'x.md', continuation: true },
			{ text: 'x.md', continuation: false },
		]);
		expect([...h.rows()].map(r => r.querySelector('.nav-row-repeat')?.textContent ?? ''))
			.toEqual(['', '↳', '']);
	});

	it('keeps the count on a row that repeats the name above', () => {
		// ×3 is how many steps landed on THIS row's spot — the row's own fact,
		// not the name's — so a row that carries the repeat mark still prints its
		// own count, right after the mark.
		const h = harness([
			at('x.md', 200, 40), at('x.md', 200, 30), at('x.md', 200, 20), at('x.md', 100, 10),
			visit('y.md', NOW),
		], 4, files);

		expect(h.rows()).toHaveLength(2);
		expect(names(h)).toEqual([
			{ text: 'x.md', continuation: false },
			{ text: 'x.md', continuation: true },
		]);
		expect(h.rows()[0].querySelector('.nav-row-count')).toBeNull();
		const repeatRow = h.rows()[1].querySelector('.nav-row-file')!;
		expect([...repeatRow.children].map(el => el.className)).toEqual([
			'nav-row-name is-continuation',
			'nav-row-repeat',
			'nav-row-count',
		]);
		expect(repeatRow.querySelector('.nav-row-repeat')?.textContent).toBe('↳');
		expect(repeatRow.querySelector('.nav-row-count')?.textContent).toBe('×3');
	});

	it('keeps naming a deleted file, whose name carries the warning', () => {
		// Two steps into a file that is gone: every row has to look dead, so the
		// name is never replaced for a missing file — no mark, no blank.
		const h = harness([
			visit('gone.md', NOW - 30 * MINUTE, { scroll: 10 }),
			visit('gone.md', NOW - 20 * MINUTE, { scroll: 412 }),
			visit('y.md', NOW),
		], 2, files, ['gone.md']);

		expect(names(h)).toEqual([
			{ text: 'gone.md', continuation: false },
			{ text: 'gone.md', continuation: false },
		]);
		expect(h.el.querySelectorAll('.nav-row-repeat')).toHaveLength(0);
	});
});

describe('NavHistoryModal — preview source', () => {
	const doc = '# 面板设计\n\n## 呈现方案\n\n### 预览\n\n预览条：悬停显示上下文三行\n\n尾巴\n';
	const entry = visit('a.md', NOW - MINUTE, captured(doc.split('\n'), 6));
	// touch harnesses: the panel opens on a tap
	const open = (h: ReturnType<typeof harness>) =>
		h.rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

	it('prints the recorded block, reading neither the vault nor the open editor', () => {
		// It used to consult the live editor for an open note and one vault read
		// otherwise. Both are gone: the block is what the user was looking at
		// when they left, so today's content — possibly rewritten — must never
		// be printed where the row promises the recorded spot.
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], { 'a.md': doc }, {}, true);

		open(h);

		// The doc's non-blank lines around line 6: three before, one after.
		expect(Array.from(h.el.querySelectorAll('.nav-preview-line')).map(l => l.textContent)).toEqual([
			'L1# 面板设计',
			'L3## 呈现方案',
			'L5### 预览',
			'L7预览条：悬停显示上下文三行',
			'L9尾巴',
		]);
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('names the section the landing sits in, deepest last', () => {
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], {}, A_HEADINGS, true);

		open(h);

		const trail = h.el.querySelector('.nav-preview-trail')!;
		expect(trail.textContent).toBe(`面板设计›呈现方案›预览`);
		expect(trail.querySelector('.nav-trail-deep')?.textContent).toBe('预览');
	});
});

describe('NavHistoryModal — the recorded landing block', () => {
	// An entry carries the lines it was left on (see NavEntryState.context), the
	// file's size then, and the mtime it had: the panel prints them and reads
	// nothing, and the search box matches them. This block is what the whole
	// recording change is for, so all three readers are pinned here.
	const blockState = (extra: NavEntryState = {}): NavEntryState => ({
		scroll: 11,
		context: [
			{ line: 10, text: '上一段：从哪里来' },
			{ line: 11, text: '落点这一行' },
			{ line: 12, text: '下一段：到哪里去' },
		],
		contextAt: 1,
		lineCount: 1200,
		mtime: 1000,
		...extra,
	});
	const withBlock = (extra: NavEntryState = {}): NavHistoryEntry =>
		visit('a.md', NOW - MINUTE, blockState(extra));
	const files = { 'a.md': 'live ten\nlive eleven\nlive twelve', 'b.md': '' };
	const open = (h: ReturnType<typeof harness>) =>
		h.rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// A step made by clicking a plain [[link]]: keyless, so it keeps an origin.
	const linkVisit = (viaPath: string, viaText: string, st?: NavEntryState): NavHistoryEntry =>
		({ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, st, via: 'link', viaPath, viaText });
	const search = (h: ReturnType<typeof harness>, q: string) => {
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = q;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	};

	it('prints the recorded lines instead of reading the file', () => {
		const h = harness([withBlock(), visit('b.md', NOW)], 1, files, [], {}, {}, true);

		open(h);

		expect(Array.from(h.el.querySelectorAll('.nav-preview-line')).map(l => l.textContent))
			.toEqual(['L11上一段：从哪里来', 'L12落点这一行', 'L13下一段：到哪里去']);
		expect(h.el.querySelector('.nav-preview-line.is-landing')?.textContent).toContain('落点这一行');
		// Nothing was read: not the vault, and not the open editor either — the
		// current file content must NOT leak into a block that says what was
		// there when the user left.
		expect(h.cachedRead).not.toHaveBeenCalled();
		expect(h.el.textContent).not.toContain('live eleven');
	});

	it('shows the recorded block for a DELETED file too', () => {
		// The file is gone; what stood there is not. This is the only thing left
		// to recognize the step by, and the reason the block is recorded rather
		// than read.
		const h = harness([withBlock(), visit('b.md', NOW)], 1, files, ['a.md'], {}, {}, true);

		open(h);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.gone'));
		expect(h.el.querySelector('.nav-preview-line.is-landing')?.textContent).toContain('落点这一行');
		// still no way to travel there
		expect(h.el.querySelector('.nav-preview-go')).toBeNull();
	});

	it('reads nothing even for an entry with no block: it says so and stops', () => {
		// The live-read fallback is gone, so the panel cannot consult the editor
		// or the vault at all. An entry without a block (a state that never went
		// through the nav read) gets the same admission, not a file read.
		const h = harness(
			[visit('a.md', NOW - MINUTE, { scroll: 1 }), visit('b.md', NOW)],
			1, files, [], { 'a.md': 'live ten\nlive eleven\nlive twelve' }, {}, true,
		);

		open(h);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.none'));
		expect(h.el.textContent).not.toContain('live eleven');
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('shows the coordinate against the recorded file size', () => {
		const h = harness([withBlock(), visit('b.md', NOW)], 1, files, [], {}, {}, true);

		open(h);

		expect(h.el.querySelector('.nav-preview-head .nav-row-line')?.textContent).toBe('L12 / 1200');
	});

	it('says so when the file was written after the step was recorded', () => {
		// Same entry, two live mtimes: unchanged (nothing said) and later (said).
		const fresh = harness([withBlock(), visit('b.md', NOW)], 1, files, [], {}, {}, true, [], { 'a.md': 1000 });
		open(fresh);
		expect(fresh.el.querySelector('.nav-preview-modified')).toBeNull();

		const written = harness([withBlock(), visit('b.md', NOW)], 1, files, [], {}, {}, true, [], { 'a.md': 2000 });
		open(written);
		expect(written.el.querySelector('.nav-preview-modified')?.textContent)
			.toBe(t('navHistory.preview.modified'));
	});

	it('names where a plain link came from, and how it was made', () => {
		const linked = linkVisit('notes/来源.md', 'a|另见', blockState());
		const h = harness([linked, visit('b.md', NOW)], 1, files, [], {}, {}, true);

		open(h);

		// The badge says the step was a link, and the head names the note it was
		// clicked in — plus the link's own words, which are not the note's name.
		expect(h.el.querySelector('.nav-preview-type')?.textContent).toBe(t('navHistory.type.link'));
		expect(Array.from(h.el.querySelectorAll('.nav-preview-via')).map(e => e.textContent))
			.toEqual([t('navHistory.preview.via', '来源.md'), '「另见」']);
	});

	it('finds a step by any line of its recorded block', () => {
		const h = harness([withBlock(), visit('b.md', NOW)], 1, files);

		search(h, '到哪里去');

		expect(h.rows()).toHaveLength(1);
		expect(h.rows()[0].querySelector('.nav-row-name')?.textContent).toBe('a.md');
	});

	it('finds a step by the section its row prints', () => {
		// The section chain is derived from the heading cache, not recorded on
		// the entry — and it is the column the user reads, so a query must be
		// able to hit it.
		const headings = { 'a.md': [{ heading: '架构设计', level: 1, position: { start: { line: 0 } } }] };
		const h = harness(
			[visit('a.md', NOW - MINUTE, captured(files['a.md'].split('\n'), 2)), visit('b.md', NOW)],
			1, files, [], {}, headings,
		);

		search(h, '架构设计');

		expect(h.rows()).toHaveLength(1);
	});

	it('finds a step by the note a plain link came from', () => {
		const linked = linkVisit('notes/来源笔记.md', 'a');
		const h = harness([linked, visit('b.md', NOW)], 1, files);

		search(h, '来源笔记');

		expect(h.rows()).toHaveLength(1);
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

	it('treats every column the same — the name column is not a special target', () => {
		// The NAME column is the row's hover-preview trigger on a pointing
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
		// AND (over the name column, the one part of a row that does something
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
	// jsdom lays nothing out, so every rect is zero and the NAME column — the
	// row's preview trigger — is a zero-width strip at x=0: a pointer move at x=0
	// is ON it, one at x=50 is not. That is exactly the distinction the trigger
	// makes.
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

	it('asks only from the name column, not from the rest of the row', () => {
		// Pointing at a row still selects it (a click travels there); what the
		// row is NOT is a whole-note popover under the pointer every time the
		// list is scanned.
		const h = harness(at(), 1, doc);

		hover(h.rows()[0], 50); // the section / coordinates, say
		expect(h.trigger).not.toHaveBeenCalled();
		// ...and the row is selected all the same
		expect(h.rows()[0].classList.contains('is-selected')).toBe(true);

		hover(h.rows()[0], 0); // onto the name column
		expect(h.trigger).toHaveBeenCalledTimes(1);
	});

	it('re-arms the name column after the pointer leaves the list', () => {
		const h = harness(at(), 1, doc);

		hover(h.rows()[0]);
		expect(h.trigger).toHaveBeenCalledTimes(1);

		h.el.querySelector('.position-restore-nav-list')
			?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
		hover(h.rows()[0]);

		expect(h.trigger).toHaveBeenCalledTimes(2);
	});

	it('re-arms the name column after crossing a non-row area inside the list', () => {
		// The pointer can leave the name column without leaving the list — onto a
		// segment header or the bottom padding. Re-entering the SAME row's name
		// must then ask for the preview again, just as leaving the list entirely
		// does.
		const h = harness(at(), 1, doc);

		hover(h.rows()[0]);
		expect(h.trigger).toHaveBeenCalledTimes(1);

		hover(h.el.querySelector<HTMLElement>('.position-restore-nav-list')!);
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

	it('asks for the preview beside the name cell, level with the row', () => {
		// jsdom has no layout, so every rect is 0: what this pins is that both
		// values are OUR coordinates (the name cell's right edge + the gap, and
		// the row's own top) and that they are rewritten per row, which is what
		// the stylesheet's clamps consume.
		const h = harness(at(), 1, files);
		expect(left()).toBe('8px'); // the resting value, before any hover
		expect(top()).toBe('0px');

		hover(h.rows()[0]);

		expect(left()).toBe('8px'); // 0 + the 8px gap, in a layout-free document
		expect(top()).toBe('0px');
		expect(document.body.classList.contains('position-restore-nav-open')).toBe(true);
	});

	it('anchors on the name cell and the row, not on the row box the plugin uses', () => {
		// jsdom lays nothing out, so the rects come from a stub keyed by class:
		// the row is wide and sits 240px down, its name cell ends well before the
		// row does. The popover must start at the CELL's right edge — the column
		// the pointer is on, the one that asked for the preview — and at the
		// row's OWN top: the plugin's own choice (the whole row's edge, one row
		// further down) is what put the preview half a panel away from the column
		// being pointed at.
		const boxes: Record<string, { left: number; right: number; top: number }> = {
			'position-restore-nav-row': { left: 10, right: 700, top: 240 },
			'nav-row-file': { left: 10, right: 180, top: 240 },
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

			hover(h.rows()[0], 100); // on the name cell (see the stub above)

			expect(left()).toBe('188px'); // the cell's 180 + the 8px gap
			expect(top()).toBe('240px'); // the row's own top, not a row below it
		} finally {
			Element.prototype.getBoundingClientRect = original;
		}
	});

	it('re-anchors a SHOWING popover when the list scrolls, and writes nothing when none is up', () => {
		// The popover hangs off a row's top edge, so the list scrolling moves the
		// row out from under it — but only while one is actually showing: a wheel
		// tick with no popover must not rewrite the body's style at all. And the
		// row re-placed against is the one the popover was OPENED for, not
		// whatever is pointed at now (the pointer may have moved on to a row whose
		// preview has not been asked for yet).
		const h = harness(at(), 1, files);
		const list = h.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		const scroll = () => list.dispatchEvent(new Event('scroll'));

		// Nothing is showing: the coordinates written on open must survive.
		document.body.style.setProperty(POPOVER_LEFT_VAR, 'sentinel');
		scroll();
		expect(left()).toBe('sentinel');

		h.modal.hoverPopover = { hoverEl: document.createElement('div'), targetEl: h.rows()[0] } as never;
		scroll();

		expect(left()).toBe('8px'); // the name cell's 0 + the gap
		expect(top()).toBe('0px');
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
