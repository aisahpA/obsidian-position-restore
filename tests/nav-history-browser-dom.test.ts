// DOM-level tests for the history browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the landing panel that describes a row, and
// the search box that is now the toolbar's only control.
// The pure pieces (describe/group/merge/filter/time/panes) are covered in
// nav-history-browser.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownView, Platform, TFile } from 'obsidian';

import { NavHistoryModal } from '@/nav-history/browser/modal';
import type { NavBrowserPrefs } from '@/nav-history/browser/body';
import type { LandingsMode } from '@/nav-history/browser/listing';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { NAV_CONTEXT_RADIUS } from '@/position/capture/ephemeral';
import { DEFAULT_SETTINGS } from '@/types';
import type { NavEntryState } from '@/types';
import { t } from '@/i18n';

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

const MINUTE = 60_000;
const NOW = Date.now();

// A preference set for one harness (or for two, when a test wants to show that a
// choice made in one dialog is the choice the next one opens on). The write is
// recorded, so a test can assert that the list asked the PLUGIN to remember the
// choice rather than keeping it to itself.
function prefs(start: { landings?: LandingsMode } = {}) {
	const state = { landings: 'last' as LandingsMode, cap: 200, ...start };
	return {
		state,
		browser: {
			landings: () => state.landings,
			setLandings: (how: LandingsMode) => {
				state.landings = how;
			},
			// How far back the list reaches: chosen in the panel's gear (see
			// NavBrowserPrefs.placesCap).
			placesCap: () => state.cap,
			setPlacesCap: (cap: number) => {
				state.cap = cap;
			},
		} satisfies NavBrowserPrefs,
	};
}

// The plain set a harness gets when a test says nothing: one row per note, with the
// details column on (see prefs).
function defaultPrefs(): NavBrowserPrefs {
	return prefs().browser;
}

// …and the set a test asks for when it is about the ROWS: 'all' prints each note's
// distinct spots under its name, which is the only setting that puts them on screen
// (a landing row, a pane marker on one, the drawer walking a note one landing at a
// time). Spelled as a harness of its own because the preference is the LAST of the
// positional arguments and the row tests otherwise repeat six empty defaults to
// reach it.
function harnessAll(
	entries: NavHistoryEntry[],
	index: number,
	files: Record<string, string> = {},
	deleted: string[] = [],
	live: Record<string, string> = {},
	headingMap: Record<string, unknown[] | Record<string, unknown>> = {},
	mobile = false,
	layout: { leafId: string; path: string }[] = [],
	mtimes: Record<string, number> = {},
): ReturnType<typeof harness> {
	return harness(entries, index, files, deleted, live, headingMap, mobile, layout, mtimes,
		prefs({ landings: 'all' }).browser);
}

// A PLACE of the recent-files list, in the two shapes the store really produces
// (see places.ts): a step that carries a position is a JUMP the reader made — the
// only record that owns a landing — while a step without one is the FILE's own
// record, which is the note's row rather than a landing under it. A file record
// with a position is a shape the list never holds (the position database owns
// "where I left this file"), which is why this helper splits them.
const visit = (path: string, stamp: number, st?: NavEntryState): NavHistoryEntry => st
	? {
		kind: 'jump', path, leafId: 'leaf-1', t: stamp, st,
		key: `outline:## L${st.scroll ?? st.context?.[st.contextAt ?? 0]?.line ?? 0}`,
	} as NavHistoryEntry
	: { kind: 'visit', path, leafId: 'leaf-1', t: stamp };

// A capture as the plugin records one now: the landing's surrounding NON-BLANK
// lines with `contextAt` marking it (see NavEntryState.context). Mirrors
// contextBlock in capture/ephemeral.ts at the same radius, so a fixture's panel
// content is the production shape instead of a hand-built one.
function captured(doc: string[], landing: number): NavEntryState {
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

// A note long enough for TWO of its places to be two PLACES. The list folds
// landings within LANDING_MERGE_LINES of each other into one row (see
// groupByFile), so a fixture whose sections sit four lines apart holds ONE place
// however many steps landed in it — which is the behaviour, not a fixture quirk.
// The filler is what puts the second section more than the window below the
// first; the two heads below are the two places the landing-row suite draws.
const SPREAD_LINES = Array.from({ length: 24 }, (_, i) => `正文第 ${i + 1} 行`);
const SPREAD_DOC = [
	'# 面板设计', '', '## 呈现方案', '', '### 预览', '',
	'预览条：悬停显示上下文三行', '',
	...SPREAD_LINES, '',
	'## 尾巴', '', '最后一段', '',
];
const SPREAD_HEADINGS = {
	'a.md': [
		{ heading: '面板设计', level: 1, position: { start: { line: 0 } } },
		{ heading: '呈现方案', level: 2, position: { start: { line: 2 } } },
		{ heading: '预览', level: 3, position: { start: { line: 4 } } },
		{ heading: '尾巴', level: 2, position: { start: { line: 33 } } },
	],
};

function harness(
	entries: NavHistoryEntry[],
	index: number,
	// The vault as the fake app reports it. Only EXISTENCE is asked of it now — a path
	// absent here is a place the list will not draw — because the browser reads no file
	// at all (see NavHistoryReads). The text is kept for the fake `cachedRead`, which
	// nothing calls.
	files: Record<string, string> = {},
	// Paths the fixture wants to be RECORDED AND GONE: a place in the history whose file
	// the vault no longer has (see the "a file that is gone" suite). It wins over
	// `files`, so a test can say "this was there, and is not any more".
	deleted: string[] = [],
	// paths held open in an editor: the panel describes a place from the ENTRY it
	// was recorded in and never from a live editor, so nothing here is ever read
	// for the panel — the fake app exposes the editors only for the pane marker.
	live: Record<string, string> = {},
	// parsed headings per path, as metadataCache would report them
	headingMap: Record<string, unknown[] | Record<string, unknown>> = {},
	// a touch device. The list answers a click either way (see NavHistoryList), so
	// what this flag decides here is the PRESENTATION — jsdom has no matchMedia to
	// ask, so a touch device is the inline one (see NavHistoryModal.inline) — plus the
	// touch ergonomics: the hint's wording, the arrow's size under a finger, and the
	// filter box left unfocused.
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
	// The browser's own preferences, as the plugin hands them to a shell (see
	// NavBrowserPrefs). A test that wants a dialog to open with every landing
	// printed passes its own set here — the same object twice, to show that the
	// choice is not the dialog's — and the default is a fresh one per harness, so
	// tests cannot leak a preference into each other through the settings file.
	browserPrefs: NavBrowserPrefs = defaultPrefs(),
) {
	// The place list's travel: the panel hands it a place index and the list
	// decides how to go there (a file opens the plain way, a jump lands — see
	// places.ts). The spy keeps its old name so every assertion below reads as
	// what it always asked: "this is the place the row took the reader to".
	const jumpTo = vi.fn(async () => {});
	const cachedRead = vi.fn(async (file: { path: string }) => files[file.path] ?? '');
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
			// A path maps either to its parsed headings (the common case) or to the
			// whole cache record, for the tests that need the frontmatter range the
			// drawer uses to keep a block out of the properties.
			getFileCache: (file: { path: string }) => {
				const cache = headingMap[file.path];
				if (!cache)
					return null;
				return Array.isArray(cache) ? { headings: cache } : cache;
			},
		},
		workspace: {
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
			entries, index, travel: jumpTo, subscribe: () => () => {},
		} as never, undefined, browserPrefs);
	} finally {
		Platform.isMobile = previous;
	}
	modal.open();
	// The list is ONE ROW PER NOTE, and a landing row only where the setting prints
	// them (see LandingsMode). Three selectors, because the tests say three different
	// things — which notes exist, which landing rows are on screen (none by default),
	// and where a note's own header is.
	const rows = () =>
		Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-place'));
	const notes = () =>
		Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'));
	const note = (name: string) =>
		notes().find(r => r.querySelector('.nav-row-name')?.textContent === name)!;
	const place = (line: string) =>
		rows().find(r => r.querySelector('.nav-row-line')?.textContent === line)!;
	// ONE click on the ROW: the panel is a navigator, so this OPENS the file the row
	// stands for — the note's own newest landing, or the landing itself (see
	// NavHistoryList.onClick). The place the reader is
	// already in is not exempt: the open re-lands it. Only a deleted note goes nowhere.
	const clickRow = (row: HTMLElement) =>
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// …and the muted gestures: a right-click, and a finger's lingering press (a
	// WebView raises the same `contextmenu` for both — see NavHistoryList.onContextMenu).
	// Neither goes anywhere any more; what matters is that neither OPENS anything, and
	// that both are still refused.
	const rightClick = (row: HTMLElement) => {
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
		row.dispatchEvent(ev);
		return ev;
	};
	// …and the same event from a press that was merely held: a WebView raises
	// `contextmenu` for a long touch too, with the LEFT button's number on it, and an
	// open taken on that turned an ordinary slow tap into a jump. It answers with
	// the event, because whether it was refused is half of what it says.
	const longPress = (row: HTMLElement) => {
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
		row.dispatchEvent(ev);
		return ev;
	};
	// A real pointer move over a row. Nothing in the list listens for it — the panel
	// is click-only (see NavHistoryList), so a mouse crossing a row chooses nothing,
	// opens nothing and moves no position — and this is how the tests that say so
	// deliver the report. The handler used to hit-test by event TARGET; the
	// coordinates advance per call so that even a list that counted movement as a
	// choice could not read two of these as one.
	let pointer = 0;
	const movePointer = (row: HTMLElement, at?: { x: number; y: number }) =>
		row.dispatchEvent(new MouseEvent('mousemove', {
			bubbles: true,
			clientX: at?.x ?? (pointer += 20),
			clientY: at?.y ?? pointer,
		}));
	const key = (k: string) => modal.contentEl.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
	// A choice in the toolbar's gear (see NavHistoryBrowser.openSettings): open the
	// menu, pick the answer by its label, and the menu closes on the pick — the same
	// two clicks a reader makes.
	const pickSetting = (label: string) => {
		clickRow(modal.contentEl.querySelector<HTMLElement>('.position-restore-nav-settings')!);
		const option = Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.nav-settings-option'))
			.find(b => b.querySelector('.nav-settings-label')?.textContent === label)!;
		clickRow(option);
	};
	return {
		modal, jumpTo, cachedRead, el: modal.contentEl,
		rows, notes, note, place, clickRow, rightClick, longPress, movePointer,
		key, pickSetting,
	};
}

beforeEach(() => {
	document.body.innerHTML = '';
	// Children (and any class a test left on the body), or one test's DOM leaks
	// into the next.
	document.body.className = '';
});

afterEach(() => {
	vi.restoreAllMocks();
	// The width query is the one global a test installs (see widthQuery): jsdom has none
	// of its own, and one left behind would decide the panel's presentation for every
	// test after it.
	delete (window as { matchMedia?: unknown }).matchMedia;
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
	it('pins the current note first, with no dot of its own', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		// There is no second "you are here" anywhere: the card that used to stand
		// above the list said the same thing in a second place and a second layout,
		// and the row below is the authoritative one (see NavHistoryModal.render).
		expect(h.el.querySelector('.position-restore-nav-here')).toBeNull();

		// The current note is a row in the list like any other, first — and it carries
		// no ●: the current note is pinned first, so a dot on it could only ever sit on
		// row one, saying what the position already says. The dot is for the LANDING
		// that holds the current entry, which has its note's other rows beside it (see
		// NavHistoryList.placeRow), and no note row here prints landings.
		const notes = h.notes();
		expect(notes).toHaveLength(3);
		expect(notes[0].textContent).toContain('c.md');
		expect(notes[0].querySelector('.nav-row-here')).toBeNull();
		// One spot is not a count either: the "+N" went with the expansion, and the
		// caret that used to lead a name was gone even before that.
		expect(notes[0].querySelector('.nav-row-count')).toBeNull();
		expect(notes[0].querySelector('.nav-file-caret')).toBeNull();
		expect(notes[1].querySelector('.nav-row-here')).toBeNull();
	});

	it('keeps the current note to ONE row, and opens it at the spot it stands for', () => {
		const entries = [
			visit('a.md', NOW - 5 * MINUTE, { scroll: 3 }),
			visit('c.md', NOW - 2 * MINUTE, { scroll: 20 }),
			visit('c.md', NOW, { scroll: 90 }),
		];
		const h = harness(entries, 2, { 'a.md': '', 'c.md': '' });

		// Two spots in c.md, and the DEFAULT list prints neither: one row per note is
		// the whole of what it is (see LandingsMode), and the row stands for the LAST
		// spot the reader was at in that note (see NavHistoryList.activeRep).
		expect(h.rows()).toHaveLength(0);
		expect(h.note('c.md').querySelector('.nav-row-here')).toBeNull();

		// …and the row is a destination all the same: a click opens c.md at that very
		// place, because the open re-lands it rather than pushing it again — which is
		// what a reader whose tab was closed is asking for (see NavHistoryList.targetOf).
		h.clickRow(h.note('c.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(2);
	});

	it('keeps a one-step history a one-row list, and opens that row', () => {
		// The list used to call itself empty when the current entry's note was the only
		// place left on it, and that row answered nothing: the one list a reader with
		// every tab closed ever sees was the one list with no way back in. The row is a
		// destination now (see NavHistoryList.targetOf), so the sentence about having
		// nowhere to go belongs to a query that matched nothing, or to a history whose
		// notes are genuinely gone — never to the spot the reader is standing in.
		const h = harness([visit('only.md', NOW)], 0, { 'only.md': '' });

		expect(h.notes()).toHaveLength(1);
		expect(h.el.querySelector('.position-restore-nav-empty')).toBeNull();

		h.clickRow(h.note('only.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('says "no match" only when the query really emptied the list', () => {
		// The sentence is the QUERY's answer and not a verdict on the place the reader
		// is standing in: a filter that matches nothing empties the list, while a filter
		// that keeps only the current note leaves a row that opens like any other (see
		// NavHistoryList.render's refs.some(targetOf) branch).
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' });
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		const search = (q: string) => {
			box.value = q;
			box.dispatchEvent(new Event('input', { bubbles: true }));
		};

		search('zzz');
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('navHistory.noMatch'));

		search('b.md'); // the current note alone
		expect(h.el.querySelector('.position-restore-nav-empty')).toBeNull();
		h.clickRow(h.note('b.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('prints both spots, the current one marked, when the setting asks for them', () => {
		const entries = [
			visit('a.md', NOW - 5 * MINUTE, { scroll: 3 }),
			visit('c.md', NOW - 2 * MINUTE, { scroll: 20 }),
			visit('c.md', NOW, { scroll: 90 }),
		];
		const h = harnessAll(entries, 2, { 'a.md': '', 'c.md': '' });

		// Both of the note's landings, down the note by line, one of them the current
		// one — marked where it is, not first.
		const places = h.rows();
		expect(places).toHaveLength(2);
		expect(places.map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L21', 'L91']);
		expect(places[0].querySelector('.nav-row-here')).toBeNull();
		expect(places[1].querySelector('.nav-row-here')).not.toBeNull();

		// BOTH are destinations, the one the reader is standing in included: the list
		// does not hold back the place they are already in (see NavHistoryList.targetOf),
		// so a note's sub-list under its own row opens like any other note's.
		h.clickRow(places[0]);
		expect(h.jumpTo).toHaveBeenCalledWith(1);
		h.clickRow(places[1]);
		expect(h.jumpTo).toHaveBeenCalledWith(2);
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

	it('arrows move the selection and Enter jumps to the note it names', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('ArrowDown'); // c.md — the current note, pinned first
		h.key('ArrowDown'); // b.md, the newest back note
		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('walks one row per key, and keeps the row it walks to in view', () => {
		// One position, moved one row at a time, and the list follows it — so the
		// reader can see where they are instead of a highlight moving off-screen.
		// (jsdom lays nothing out, so what this sees is the browser's own minimal
		// scroll; the list's real rule is revealDelta's, and the next test hands it a
		// layout.)
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });
		const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
		const selected = () => Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-selected'))
			.map(r => r.querySelector('.nav-row-name')?.textContent);

		// c.md, b.md, a.md — the current note first, then by recency.
		h.key('ArrowDown');
		expect(selected()).toEqual(['c.md']);
		expect(spy).toHaveBeenCalled();
		spy.mockClear();

		h.key('ArrowDown');
		expect(selected()).toEqual(['b.md']);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('moves the list for the walk and not for a click, and brings a row that leaves it to its middle', () => {
		// The list is the reader's viewport too, and this is the bug that taught it:
		// the position walks ONE row per key, so scrolling it the minimum distance back
		// into sight moves the list exactly as far as the row moved. The row then sits
		// flush against the edge, and every further step scrolls the note names under a
		// mark that never moves — the reader at the foot of the list presses ↓ and
		// watches the scrollbar run while the selection stands still (see revealDelta).
		const entries = [
			visit('d.md', NOW - 7 * MINUTE), visit('a.md', NOW - 5 * MINUTE),
			visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW),
		];
		const h = harness(entries, 3, { 'a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' });
		const listEl = h.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		// jsdom has no layout: hand the list a 60px box starting at 100, and every row a
		// 20px height one below the next (the fourth row is then out of sight, flush).
		const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect;
		vi.spyOn(listEl, 'getBoundingClientRect').mockReturnValue(rect(100, 60));
		Array.from(listEl.querySelectorAll<HTMLElement>('.position-restore-nav-row'))
			.forEach((row, i) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(100 + i * 20, 20)));
		const spy = vi.spyOn(Element.prototype, 'scrollIntoView');

		// A CLICK moves nothing: it opens the row it landed on, and the list is the
		// reader's own viewport — being legible is all that is owed to a row someone
		// pointed at, and the walk's jump to the middle is not.
		h.clickRow(h.notes()[3]); // d.md, below the box
		expect(listEl.scrollTop).toBe(0);
		h.clickRow(h.notes()[0]); // c.md, in sight
		expect(listEl.scrollTop).toBe(0);
		spy.mockClear(); // …and from here on, the walk alone moves the list

		h.key('ArrowDown'); // c.md — the current note, pinned first, in sight
		h.key('ArrowDown'); // b.md, in sight
		expect(listEl.scrollTop).toBe(0);
		h.key('ArrowDown'); // a.md, flush with the foot of the list — still IN sight
		expect(listEl.scrollTop).toBe(0);

		h.key('ArrowDown'); // …and out of it: the list brings the row to its MIDDLE
		expect(listEl.scrollTop).toBe(40);
		expect(160 - listEl.scrollTop).toBe(120); // the row's top, at the box's middle
		expect(spy).not.toHaveBeenCalled(); // no browser scroll: the walk is the list's own
	});

	it('moves the position for a key and for nothing a pointer merely crosses', () => {
		// THE RULE OF THE LIST (see NavHistoryList): a pointer that passes over a row
		// chooses nothing. It used to move THE position — the row Enter travels to —
		// which meant a mouse crossing the list selected a row nobody chose and could
		// undo the keyboard's walk. Every report here is a real one, at a coordinate of
		// its own, so what the list is doing is ignoring a pointer rather than never
		// hearing from one.
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });
		const selected = () => Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-selected'))
			.map(r => r.querySelector('.nav-row-name')?.textContent);
		const a = h.notes()[0];
		const b = h.notes()[1];

		h.movePointer(b, { x: 40, y: 40 });
		h.movePointer(b, { x: 41, y: 40 });
		h.movePointer(a, { x: 120, y: 40 });
		expect(selected()).toEqual([]);

		// …and the keyboard's own position is left exactly where it was: no pointer
		// report, over the row it walked to or over any other, takes it away.
		h.key('ArrowDown'); // c.md — the current note, pinned first
		expect(selected()).toEqual(['c.md']);
		h.movePointer(b, { x: 44, y: 41 });
		h.movePointer(h.el.querySelector<HTMLElement>('.position-restore-nav-list')!, { x: 200, y: 90 });
		expect(selected()).toEqual(['c.md']);

		// …and a click does not move it either: a click OPENS the row (the travel below),
		// which is the whole of what the list does with a pointer.
		h.clickRow(b);
		expect(h.jumpTo).toHaveBeenCalled();
		expect(selected()).toEqual(['c.md']);
	});

	it('walks the note rows, and ←→ opens nothing because nothing is printed', () => {
		// Two landings in b.md, and the cursor walks onto its row.
		const entries = [
			visit('a.md', NOW - 5 * MINUTE),
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:One', t: NOW - 3 * MINUTE, st: { scroll: 40 } } as NavHistoryEntry,
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:Two', t: NOW - 2 * MINUTE, st: { scroll: 400 } } as NavHistoryEntry,
			visit('c.md', NOW),
		];
		const h = harness(entries, 3, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('ArrowDown'); // c.md
		h.key('ArrowDown'); // b.md — one row, whatever the note holds
		expect(h.rows()).toHaveLength(0);
		expect(h.note('b.md').classList.contains('is-selected')).toBe(true);

		// Enter travels to the spot that row stands for — the note's NEWEST landing,
		// where the reader left it (see NavHistoryList.activeRep) — and ↓ walks on to
		// the next NOTE, because there is no landing row in between to step into.
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(2);
		h.key('ArrowDown');
		expect(h.note('a.md').classList.contains('is-selected')).toBe(true);

		// ←→ is not consumed by anything here: there is no tree left to open or close
		// (see NavHistoryBrowser.onKeyDown), so both keys keep their ordinary meaning
		// in the search box.
		const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
		h.modal.contentEl.dispatchEvent(right);
		expect(right.defaultPrevented).toBe(false);
		expect(h.rows()).toHaveLength(0);
	});

	it('lists the jumps a note holds, never the note\'s own record', () => {
		// The file's own record is the note's ROW (see listing.ts's `anchor`). A
		// landing row standing for it would open the file the reader is already in —
		// a plain open of the note on screen, i.e. a row that visibly does nothing,
		// on the note pinned FIRST where it is clicked most.
		const entries = [
			visit('a.md', NOW - 3 * MINUTE, { scroll: 10 }),
			visit('a.md', NOW - 2 * MINUTE, { scroll: 40 }),
			visit('a.md', NOW - MINUTE),
			visit('b.md', NOW),
		];
		const h = harnessAll(entries, 3, { 'a.md': '', 'b.md': '' });

		// The two jumps, and no third row for the record.
		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L11', 'L41']);
		// …and a click on one of them travels to THAT JUMP — never to the record,
		// whose travel is a plain open (see places.travel).
		h.clickRow(h.rows()[0]);
		expect(h.jumpTo).toHaveBeenCalledWith(0);
		expect(h.jumpTo).not.toHaveBeenCalledWith(2);
	});

	it('walks the landing rows too when the setting prints them', () => {
		// The same list under 'all': the note's spots are rows of their own, so ↓ steps
		// into them and Enter travels to the one it is on (see NavHistoryList.move).
		const entries = [
			visit('a.md', NOW - 5 * MINUTE),
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:One', t: NOW - 3 * MINUTE, st: { scroll: 40 } } as NavHistoryEntry,
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:Two', t: NOW - 2 * MINUTE, st: { scroll: 400 } } as NavHistoryEntry,
			visit('c.md', NOW),
		];
		const h = harnessAll(entries, 3, { 'a.md': '', 'b.md': '', 'c.md': '' });

		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L41', 'L401']);
		h.key('ArrowDown'); // c.md
		h.key('ArrowDown'); // b.md
		h.key('ArrowDown'); // …into its landings, the older one first (line order)
		expect(h.rows()[0].classList.contains('is-selected')).toBe(true);
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});
});

describe('NavHistoryModal — the file scope is gone', () => {
	// What stood here was two controls carrying one state: an "only this note"
	// switch and a chip opening a menu of every note the history had been in.
	// Both answered "where else in this note was I", and the search box already
	// answers it — a note's name is text its own steps are searchable by — so the
	// toolbar keeps the box and the hint, and the list keeps the width. (The one
	// control beside them is the list's own setting, which is about what the list
	// PRINTS rather than about the query — see NavHistoryBrowser.settings.)
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const entries = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('c.md', NOW - 4 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];

	it('leaves the toolbar to the search box, the hint and the list setting', () => {
		const h = harness(entries(), 3, files);

		expect(h.el.querySelector('.position-restore-nav-toggle')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-scope')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-scope-menu')).toBeNull();
		// Box, hint, and the panel's own setting at the far end (see
		// NavHistoryBrowser.settings) — nothing else. The button's class list is read
		// one class deep because drawing the icon adds the app's own icon classes to it
		// (see setIcon).
		const strip = Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-toolbar > *'));
		expect(strip.map(el => el.className.split(' ')[0])).toEqual([
			'position-restore-nav-filter',
			'position-restore-nav-hint',
			'clickable-icon',
		]);
		expect(strip[2].classList.contains('position-restore-nav-settings')).toBe(true);
	});

	it('narrows to a note by its own name, which is what the scope was for', () => {		const h = harness(entries(), 3, files);
		expect(h.notes()).toHaveLength(3);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'b.md';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('b.md');
	});
});

describe('NavHistoryModal — the settings menu', () => {
	// The setting the panel carries on the PAGE rather than in the settings tab (see
	// NavHistoryBrowser.settings): the small button at the far end of the strip opens
	// a radio group of two, and the list under it is what changes. Two spots in a.md
	// and b.md current, so 'all' has something to print.
	const entries = () => [
		visit('a.md', NOW - 3 * MINUTE, { scroll: 100 }),
		visit('a.md', NOW - 2 * MINUTE, { scroll: 412 }),
		visit('b.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '' };
	const gear = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLElement>('.position-restore-nav-settings')!;
	const menu = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLElement>('.position-restore-nav-settings-menu');
	const option = (h: ReturnType<typeof harness>, label: string) =>
		Array.from(h.el.querySelectorAll<HTMLElement>('.nav-settings-option'))
			.find(b => b.querySelector('.nav-settings-label')?.textContent === label)!;

	it('opens from the strip, and says which of the two values is in force', () => {
		const h = harness(entries(), 2, files);
		const btn = gear(h);

		// A gear is not a word: the name is said for the reader who has to have it, and
		// the button says whether the panel it opens is up.
		expect(btn.getAttribute('aria-label')).toBe(t('navHistory.listSettings'));
		expect(btn.getAttribute('aria-haspopup')).toBe('true');
		expect(btn.getAttribute('aria-expanded')).toBe('false');
		expect(menu(h)).toBeNull();

		h.clickRow(btn);

		const panel = menu(h)!;
		expect(btn.getAttribute('aria-expanded')).toBe('true');
		// TWO choices (see NavHistoryBrowser.openSettings): how much of a note the list
		// prints, and how far back it reaches. Each is its own group with its own name —
		// what is chosen has to be audible without opening the list to look at its shape
		// — and every ANSWER carries the few words saying what it means, on its own row,
		// which a menu cannot carry. That is why this is the panel's own DOM and not the
		// app's Menu.
		expect(panel.getAttribute('role')).toBe('group');
		expect(panel.getAttribute('aria-label')).toBe(t('navHistory.listSettings'));
		expect(panel.querySelectorAll('.nav-settings-group')).toHaveLength(2);
		expect(Array.from(panel.querySelectorAll('.nav-settings-title')).map(el => el.textContent))
			.toEqual([
				t('navHistory.landings.name'),
				t('navHistory.recentCap.name'),
			]);
		// The few words are read where the answer is, after it, and not out of one
		// paragraph under the group: no group-level note is left, and every answer
		// holds its own.
		expect(panel.querySelectorAll('.nav-settings-desc')).toHaveLength(0);
		expect(Array.from(panel.querySelectorAll('.nav-settings-option-desc')).map(el => el.textContent))
			.toEqual([
				t('navHistory.landings.options.last.desc'),
				t('navHistory.landings.options.all.desc'),
				t('navHistory.recentCap.short'),
				t('navHistory.recentCap.medium'),
				t('navHistory.recentCap.long'),
			]);
		expect(option(h, t('navHistory.landings.options.all'))
			.querySelector('.nav-settings-option-desc')?.textContent)
			.toBe(t('navHistory.landings.options.all.desc'));
		expect(Array.from(panel.querySelectorAll('[role="radiogroup"]')).map(el => el.getAttribute('aria-label')))
			.toEqual([t('navHistory.landings.name'), t('navHistory.recentCap.name')]);
		// A radio group, not a menu of commands: which of the two is in force has to be
		// audible without looking at the list's shape.
		expect(option(h, t('navHistory.landings.options.last')).getAttribute('aria-checked')).toBe('true');
		expect(option(h, t('navHistory.landings.options.all')).getAttribute('aria-checked')).toBe('false');
		// …and it is marked as well as tinted: the tint is a theme's to take away, so the
		// check in front of the label is what a reader reads when the two backgrounds
		// come out nearly the same (see styles.css). The mark's SLOT is on both rows —
		// that is what keeps the two labels on one x — so what is asked of it is whether
		// it HOLDS the mark.
		const marked = option(h, t('navHistory.landings.options.last')).querySelector('.nav-settings-tick');
		const blank = option(h, t('navHistory.landings.options.all')).querySelector('.nav-settings-tick');
		expect(marked?.querySelector('svg')?.getAttribute('data-icon')).toBe('check');
		expect(blank).not.toBeNull();
		expect(blank?.querySelector('svg')).toBeNull();

		// …and the button is a toggle: a second press puts it away.
		h.clickRow(btn);
		expect(menu(h)).toBeNull();
		expect(btn.getAttribute('aria-expanded')).toBe('false');
	});

	it('opens on the value the plugin holds, not on its own default', () => {
		const all = prefs({ landings: 'all' });
		const h = harness(entries(), 2, files, [], {}, {}, false, [], {}, all.browser);

		h.clickRow(gear(h));

		expect(option(h, t('navHistory.landings.options.all')).getAttribute('aria-checked')).toBe('true');
		expect(option(h, t('navHistory.landings.options.last')).getAttribute('aria-checked')).toBe('false');
	});

	it('hands the choice to the plugin and redraws the list under it', () => {
		// The value is the PLUGIN's to keep (see NavBrowserPrefs): the same object the
		// settings file is saved from, so the next dialog, the resident panel and the
		// next app run open on it. What the panel does with it is redraw at once —
		// seeing the list that follows is the whole reason the choice is offered here.
		const held = prefs({ landings: 'last' });
		const h = harness(entries(), 2, files, [], {}, {}, false, [], {}, held.browser);
		expect(h.rows()).toHaveLength(0);

		h.clickRow(gear(h));
		h.clickRow(option(h, t('navHistory.landings.options.all')));

		expect(held.state.landings).toBe('all');
		// …and the list is the new one, with the panel out of the way: a.md's two spots.
		expect(menu(h)).toBeNull();
		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L101', 'L413']);

		// …and back the other way, from the same button.
		h.clickRow(gear(h));
		h.clickRow(option(h, t('navHistory.landings.options.last')));
		expect(held.state.landings).toBe('last');
		expect(h.rows()).toHaveLength(0);
	});

	// THE DETAILS COLUMN IS OFF AS THE PLUGIN SHIPS (see types.ts): the history is a
	// list of places to go back to, and what each step WAS is a reader's own choice —
	// made in the gear, from the list it changes. These two tests are the two directions
	// of that switch; the suites above them run with it on (see prefs).
	it('closes on Escape without closing the dialog, and on a press outside', () => {
		const h = harness(entries(), 2, files);
		const escape = () => {
			const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
			h.modal.contentEl.dispatchEvent(ev);
			return ev;
		};

		h.clickRow(gear(h));
		// The key puts THAT away, and stops there: the reader is closing the setting,
		// not the dialog it happens to be standing in.
		expect(escape().defaultPrevented).toBe(true);
		expect(menu(h)).toBeNull();
		expect(h.modal.contentEl.isConnected).toBe(true);

		// With no setting up, Escape is not this panel's key at all — it is the app's
		// (which closes the dialog), and nothing here may consume it.
		expect(escape().defaultPrevented).toBe(false);

		// Anything outside the panel and its button — the list, the filter box, the rest
		// of the app — puts it away: a small panel over a list is something to be done
		// with, not a place to stay.
		h.clickRow(gear(h));
		expect(menu(h)).not.toBeNull();
		h.el.querySelector<HTMLElement>('.position-restore-nav-list')!
			.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(menu(h)).toBeNull();
	});
});

describe('NavHistoryModal — a file that is gone', () => {
	// A place whose file no longer exists is not listed at all: no row, no landing,
	// no "you are here" — not even for the note the reader is standing in. The
	// recent-files store prunes such a place on the vault's own delete event (see
	// places.ts); the list agrees with it on the spot, which is also what covers the
	// moment before that prune lands (see NavHistoryList.render).
	it('leaves a deleted note out of the list entirely', () => {
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'b.md': '' }, ['gone.md']);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['b.md']);
		// nothing about it is on screen, in any shape the list knows how to draw
		expect(h.el.querySelector('.is-missing')).toBeNull();
		expect(h.el.textContent).not.toContain('gone.md');
	});

	it('does not pin a current note whose file is gone', () => {
		// The reader may well be STANDING in the file that was just deleted (the tab is
		// still open in the app). The list still has no row for it: it pins what it can
		// open, and nothing claims to be "here".
		const entries = [visit('a.md', NOW - MINUTE), visit('gone.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '' }, ['gone.md']);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['a.md']);
		expect(h.el.querySelector('.position-restore-nav-row.is-current')).toBeNull();
	});

	it('leaves its LANDINGS out too, even with every landing printed', () => {
		const entries = [
			visit('gone.md', NOW - 3 * MINUTE, { scroll: 40 }),
			visit('gone.md', NOW - 2 * MINUTE, { scroll: 400 }),
			visit('b.md', NOW),
		];
		const h = harnessAll(entries, 2, { 'b.md': '' }, ['gone.md']);

		// The setting prints a note's places under its name; a note that is not listed
		// has no name to print them under.
		expect(h.rows()).toHaveLength(0);
		expect(h.notes()).toHaveLength(1);
	});

	it('says the history is empty when every place it holds is gone', () => {
		// The one case the filtering creates: a history whose places all name missing
		// files reads as an empty one. That is the honest answer — there is nowhere in
		// this list to go — and it is the SAME message as an empty history, because it
		// is the same situation for the reader.
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('also-gone.md', NOW)];
		const h = harness(entries, 1, {}, ['gone.md', 'also-gone.md']);

		expect(h.notes()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('navHistory.empty'));
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

		h.key('ArrowDown'); // the first row, the current note pinned first
		const first = h.notes()[0];
		expect(input?.getAttribute('aria-activedescendant')).toBe(first.id);
		expect(first.getAttribute('aria-selected')).toBe('true');

		h.key('ArrowDown');
		const second = h.notes()[1];
		expect(input?.getAttribute('aria-activedescendant')).toBe(second.id);
		expect(second.getAttribute('aria-selected')).toBe('true');
		// The row left behind stops claiming to be current.
		expect(first.getAttribute('aria-selected')).toBe('false');
	});
});

describe('NavHistoryModal — one note, many landings', () => {
	// A reading capture lands on a viewport line: every landing of one note is a
	// row under that note, and two DIFFERENT lines stay two rows.
	const at = (path: string, line: number, agoMin: number): NavHistoryEntry =>
		visit(path, NOW - agoMin * MINUTE, { scroll: line });
	const files = { 'x.md': '', 'y.md': '', 'z.md': '' };

	it('collapses repeat visits to one landing into one spot', () => {
		// Bouncing between the note being written and its reference: every return
		// to x.md L412 was the same PLACE, however it was reached and however many
		// times. What the list prints of a note is the places in it the reader can
		// go back to, so the three steps are one row — a list of three identical
		// "L413" rows is three ways to say one destination, and the reader has to
		// read all three to find that out. How OFTEN each was visited is
		// chronology, which is not what this panel answers.
		const entries = [
			at('x.md', 100, 30), at('x.md', 412, 25), at('x.md', 412, 20), at('x.md', 412, 10),
			visit('y.md', NOW),
		];

		// The default list says it with ONE row for the note: nothing is printed
		// under it (see LandingsMode), so a note visited ten times is one line.
		expect(harness(entries, 4, files).rows()).toHaveLength(0);

		// …and asked for, the note's spots come out down the note, not by when it
		// was visited: L101 (step 0) before L413 (the three later steps, one place).
		const h = harnessAll(entries, 4, files);
		expect(h.notes()).toHaveLength(2); // x.md, then y.md
		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L101', 'L413']);
		expect(h.el.textContent).not.toContain('×');
	});

	it('makes a one-landing note a single row: no count, no caret, no landing row', () => {
		// Most notes in a real history were visited once, and there is no choice to make
		// in those: the row is the note AND the spot, and a "1" plus a caret would be two
		// cells spent saying there is nothing under them.
		const h = harnessAll([at('x.md', 100, 30), visit('y.md', NOW)], 1, files);

		const row = h.note('x.md');
		expect(row.querySelector('.nav-row-count')).toBeNull();
		expect(row.querySelector('.nav-file-caret')).toBeNull();

		// ONE spot is not a list, so not even 'all' prints a row for it (see
		// NavHistoryList.printsLandings): the note's own row stands for it.
		expect(h.rows()).toHaveLength(0);

		// …and the row is a destination: a click on it opens its one place.
		h.clickRow(h.note('x.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('gives a file with no coordinates ONE landing, however often it was opened', () => {
		// A `.base` view, a PDF, an image: a file with nowhere in it to BE. Every visit
		// is the same place, so the note holds one landing — and, having one, it is a
		// single row that prints nothing under it. What it did instead was print one
		// identical "—" row per visit, because a step that recorded no line was left
		// unkeyed (see landingKey).
		const h = harness([
			visit('board.base', NOW - 3 * MINUTE, {}),
			visit('board.base', NOW - 2 * MINUTE, {}),
			visit('board.base', NOW - MINUTE, {}),
			visit('b.md', NOW),
		], 3, { 'board.base': '', 'b.md': '' });

		const row = h.note('board.base');
		// One spot, so nothing under the row — not even under 'all': one place is not
		// a list (see NavHistoryList.printsLandings).
		expect(row.querySelector('.nav-row-count')).toBeNull();
		expect(h.rows()).toHaveLength(0);
		expect(harnessAll([
			visit('board.base', NOW - 3 * MINUTE, {}),
			visit('board.base', NOW - 2 * MINUTE, {}),
			visit('board.base', NOW - MINUTE, {}),
			visit('b.md', NOW),
		], 3, { 'board.base': '', 'b.md': '' }).rows()).toHaveLength(0);

		// …and it is still a destination: a click on the row goes to the place the row
		// stands for, which is the newest of them.
		h.clickRow(row);
		expect(h.jumpTo).toHaveBeenCalledWith(2);
	});

	it('prints every landing when the settings ask for all of them', () => {
		// The other side of the setting (see LandingsMode): every distinct spot under
		// the note, in the note's own order — and no count anywhere, because the list
		// no longer has anything to hide behind one.
		const all = prefs({ landings: 'all' });
		const h = harness([
			at('x.md', 100, 30), at('x.md', 412, 25), at('x.md', 412, 10), visit('y.md', NOW),
		], 3, files, [], {}, {}, false, [], {}, all.browser);

		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L101', 'L413']);
		expect(h.note('x.md').querySelector('.nav-row-count')).toBeNull();
	});

	it('never merges two notes, however alike their steps are', () => {
		// ONE tab walks from x.md to z.md and both were captured at the same
		// line — the ordinary way to read two notes side by side. Different notes
		// are different rows, always.
		const h = harness([
			at('x.md', 100, 20), at('z.md', 100, 10), visit('y.md', NOW),
		], 2, files);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['y.md', 'z.md', 'x.md']);
	});

	it('orders the notes by their newest landing', () => {
		// x.md was opened three times, but its last one is older than y.md's, so
		// it comes second: the row is the note, the order is still recency.
		const h = harness([
			at('x.md', 10, 40), at('x.md', 412, 30), at('y.md', 20, 5), visit('z.md', NOW),
		], 3, files);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['z.md', 'y.md', 'x.md']);
	});
});

describe('NavHistoryModal — panes', () => {
	// A landing of a note, taken in one tab: a jump the reader made (see places.ts).
	const pane = (path: string, leafId: string, stamp: number): NavHistoryEntry =>
		({ kind: 'jump', path, leafId, key: `outline:${leafId}`, t: stamp, st: { scroll: stamp } });

	it('names the pane on the landing, and only for a note two live tabs hold', () => {
		// a.md is open in two tabs; b.md in one (and is the current entry).
		const entries = [pane('a.md', 'left', 100), pane('a.md', 'right', 200), pane('b.md', 'left', NOW)];
		const h = harnessAll(entries, 2, { 'a.md': '', 'b.md': '' }, [], {}, {}, true, [
			{ leafId: 'left', path: 'a.md' },
			{ leafId: 'right', path: 'a.md' },
		]);

		// The pane marker is a property of a LANDING (two tabs of one note are
		// otherwise identical landings), so it belongs on the row of a landing — which
		// the list prints under 'all'. Its landings run down the note: L101 was taken
		// in the left tab, L201 in the right one, whatever order the visits happened
		// in.
		expect(h.rows()).toHaveLength(2);

		// Which of how many, with no word: "2/2" rather than "Pane 2".
		expect(h.rows()[0].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 1, 2));
		expect(h.rows()[1].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 2, 2));
		// ...and it is the note's own name that stays authoritative
		expect(h.note('a.md').querySelector('.nav-row-name')?.textContent).toBe('a.md');
	});

	it('says nothing about panes when a note lives in one leaf', () => {
		const entries = [pane('a.md', 'left', 100), pane('b.md', 'left', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' }, [], {}, {}, true, [
			{ leafId: 'left', path: 'a.md' },
		]);

		// a.md holds ONE landing, so there is no landing row to carry the marker: one
		// live tab means no number to print, and a note with one place prints no rows.
		expect(h.rows()).toHaveLength(0);
		expect(h.note('a.md').querySelector('.nav-row-pane')).toBeNull();
	});

	it('drops the number once that tab has moved to another note', () => {
		// The tab still exists — showing a DIFFERENT note. A number read off the
		// history kept claiming it as this note's second window; read off the live
		// layout it is simply not one of them any more, while a tab the history
		// never saw still counts.
		const entries = [pane('a.md', 'tab1', 100), pane('a.md', 'tab2', 200), pane('b.md', 'tab1', NOW)];
		const h = harnessAll(entries, 2, { 'a.md': '', 'b.md': '' }, [], {}, {}, true, [
			{ leafId: 'tab1', path: 'b.md' }, // walked away from a.md
			{ leafId: 'tab2', path: 'a.md' },
			{ leafId: 'tab3', path: 'a.md' }, // a note tab the history never saw
		]);

		// L101's tab has walked away, so that landing carries no cell at all:
		// there is no column to reserve any more (the note and its landings align
		// by their own grid, not by a list-wide strip).
		expect(h.rows()[0].querySelector('.nav-row-pane')).toBeNull();
		expect(h.rows()[1].querySelector('.nav-row-pane')?.textContent).toBe(t('navHistory.pane', 1, 2));
	});
});

describe('NavHistoryModal — a landing row', () => {
	// The landings a note holds are rows of their own under 'all', so these tests ask
	// for them: the note here holds TWO places — L7 under "预览" and L36 under
	// "尾巴" — far enough apart that they are two rows at all (see SPREAD_DOC), and a
	// note with ONE prints none either way — a single place is not a list (see
	// NavHistoryList.printsLandings).
	const body = () => [
		visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 6)),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
		visit('b.md', NOW),
	];
	const files = { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' };

	it('prefixes the landing with the deepest section levels', () => {
		const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);

		// the deepest two levels, straight off the heading cache — the ROWS never read
		// the vault (the one read on mount is the drawer's own, see the drawer suite)
		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		expect(h.rows()[1].querySelector('.nav-row-trail')?.textContent).toBe('面板设计›尾巴');
	});

	it('shows the coordinate and the section, never the landing text', () => {
		const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);

		// Down the note: L7 first, then L36.
		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L7', 'L36']);
		const row = h.rows()[1];
		expect(row.querySelector('.nav-row-trail')?.textContent).toBe('面板设计›尾巴');
		// the words live in the preview (and the filter), not in the list
		expect(row.textContent).not.toContain('最后一段');
	});

	it('labels a folded row with the line it will OPEN, and keeps the span as its scope', () => {
		// Two of a note's places close enough to be ONE row, plus a third far enough
		// that the note still prints rows at all (a note with a single place prints
		// none — see printsLandings). The folded row stands for its NEWEST member, so
		// it prints THAT line and not the range it covers: the row is an OPEN, and a
		// "L7–L13" over a click that lands on L13 was a promise the row did not keep.
		// The span is still what the row covers, and survives as its own tooltip.
		const entries = [
			visit('a.md', NOW - 3 * MINUTE, captured(SPREAD_DOC, 6)),
			visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 12)),
			visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
			visit('b.md', NOW),
		];
		const h = harnessAll(entries, 3, files, [], {}, SPREAD_HEADINGS);

		// Down the note: the folded cluster (L7 and L13, represented by the newer
		// L13), then L36 — whose one landing has no span to carry.
		const rows = h.rows();
		expect(rows.map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L13', 'L36']);
		expect(rows[0].getAttribute('title')).toBe(t('navHistory.lineRange', 7, 13));
		expect(rows[1].getAttribute('title')).toBeNull();

		h.clickRow(rows[0]);
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('keeps the heading the landing line itself carries as the deepest level', () => {
		// an outline jump lands ON "### 预览". A row prints no landing text, so that
		// heading is the row's LAST level — the one a reader places the spot by — and it
		// stays in the chain.
		const jump = { kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:预览', t: NOW - MINUTE,
			st: captured(SPREAD_DOC, 4) } as NavHistoryEntry;
		const entries = [jump, visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)), visit('b.md', NOW)];
		const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS);

		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
	});

	it('puts the coordinate before the section, and no time column anywhere', () => {
		// The row used to be name | section | small print (pane, coordinate, age) with
		// the age in a measured column of its own. The note is the row now, so a landing
		// is coordinate | section, plus the pane cell only while two live tabs hold that
		// note — and no time anywhere: nothing in the list prints one.
		const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);

		const row = h.rows()[1];
		expect([...row.children].map(el => el.className)).toEqual(['nav-row-pos', 'nav-row-trail']);
		expect(row.querySelector('.nav-row-time')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-list .nav-row-time')).toBeNull();
	});
});


describe('NavHistoryModal — same-named notes', () => {
	// The panel is used in a vault, not a code repo: "index.md" exists in five
	// folders, and a row that printed only its last path segment named all five
	// the same. The folder is printed exactly where the name collides, and
	// nowhere else — a row whose name is unique prints the name alone.
	const files = { 'a/index.md': '', 'b/index.md': '', 'notes.md': '' };

	it('prints the folder on a name two notes share, and on nothing else', () => {
		const h = harness([
			visit('a/index.md', NOW - 3 * MINUTE),
			visit('b/index.md', NOW - 2 * MINUTE),
			visit('notes.md', NOW),
		], 2, files);

		const folders = h.notes().map(r => r.querySelector('.nav-row-folder')?.textContent ?? '');
		expect(folders).toEqual(['', 'b/', 'a/']); // notes.md (current) first, then the two index.md, newest first
		expect(h.note('notes.md').querySelector('.nav-row-folder')).toBeNull();
		// the folder comes BEFORE the name it disambiguates
		const index = h.note('index.md');
		// …and with one landing there is no count riding after the name.
		expect([...index.querySelector('.nav-row-file')!.children].map(el => el.className))
			.toEqual(['nav-row-folder', 'nav-row-name']);
	});

	it('gives a same-named note at the vault root a folder to show', () => {
		// "/" and "a/" are the two answers, and neither is blank: a blank cell is
		// what the /-note used to render, which read as "no folder" rather than
		// as "the root".
		const root = harness([
			visit('index.md', NOW - 3 * MINUTE),
			visit('a/index.md', NOW),
		], 1, { 'index.md': '', 'a/index.md': '' });

		// a/index.md is the current entry, so it leads; the root note follows.
		const folders = root.notes().map(r => r.querySelector('.nav-row-folder')?.textContent);
		expect(folders).toEqual(['a/', '/']);
	});

	it('drops the folder again once the collision is gone', () => {
		// A collision the query removed is not on screen to be
		// confused with anything, so the surviving row stops paying for it.
		const h = harness([
			visit('a/index.md', NOW - 3 * MINUTE),
			visit('b/index.md', NOW),
		], 1, files);

		expect(h.notes()[0].querySelector('.nav-row-folder')).not.toBeNull();

		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		input.value = 'a/index';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-folder')).toBeNull();
	});
});


describe('NavHistoryModal — the recorded landing block', () => {
	// An entry carries the lines it was left on (see NavEntryState.context). The
	// SEARCH BOX is the block's one reader: "the words I saw when I left" is how a
	// reader finds an old spot, and a phrase from anywhere in the recorded window has
	// to hit the note. (The details panel that rendered those lines is gone — see
	// body.ts — which is why search is the only reader pinned here.)
	const blockState = (extra: NavEntryState = {}): NavEntryState => ({
		scroll: 11,
		context: [
			{ line: 10, text: '上一段：从哪里来' },
			{ line: 11, text: '落点这一行' },
			{ line: 12, text: '下一段：到哪里去' },
		],
		contextAt: 1,
		mtime: 1000,
		...extra,
	});
	const withBlock = (extra: NavEntryState = {}): NavHistoryEntry =>
		visit('a.md', NOW - MINUTE, blockState(extra));
	const files = { 'a.md': 'live ten\nlive eleven\nlive twelve', 'b.md': '' };
	// A step made by clicking a plain [[link]]: keyless, so it keeps an origin.
	const linkVisit = (viaPath: string, viaText: string, st?: NavEntryState): NavHistoryEntry =>
		({ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, st, via: 'link', viaPath, viaText });
	const search = (h: ReturnType<typeof harness>, q: string) => {
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = q;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	};

	it('finds a note by any line of a recorded block', () => {
		const h = harness([withBlock(), visit('b.md', NOW)], 1, files);

		search(h, '到哪里去');

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('a.md');
	});

	it('finds a note by the section its landing row prints', () => {
		// The section chain is derived from the heading cache, not recorded on the
		// entry — and it is a column the reader reads, so a query must be able to hit it.
		const headings = { 'a.md': [{ heading: '架构设计', level: 1, position: { start: { line: 0 } } }] };
		const h = harness(
			[visit('a.md', NOW - MINUTE, captured(files['a.md'].split('\n'), 2)), visit('b.md', NOW)],
			1, files, [], {}, headings,
		);

		search(h, '架构设计');

		expect(h.notes()).toHaveLength(1);
	});

	it('finds a note by the note a plain link came from', () => {
		const linked = linkVisit('notes/来源笔记.md', 'a');
		const h = harness([linked, visit('b.md', NOW)], 1, files);

		search(h, '来源笔记');

		expect(h.notes()).toHaveLength(1);
	});
});

describe('NavHistoryModal — touch', () => {
	// Three notes, sitting on c.md. Each earlier step carries a landing line, so
	// the row it stands for has a coordinate of its own to describe — and each
	// note holds exactly one place, which is the ordinary shape of a vault's history
	// and keeps every test here about one row per note.
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const entries = () => [
		visit('a.md', NOW - 5 * MINUTE, { scroll: 40 }),
		visit('b.md', NOW - 2 * MINUTE, { scroll: 80 }),
		visit('c.md', NOW, { scroll: 120 }),
	];
	// Two PLACES of one note, far enough apart to be two ROWS (see SPREAD_DOC): the
	// list folds landings within LANDING_MERGE_LINES of one another, so a fixture whose
	// two steps sit four lines apart holds one place however many steps landed in it.
	const SPREAD = () => [
		visit('a.md', NOW - 3 * MINUTE, captured(SPREAD_DOC, 6)),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
		visit('b.md', NOW),
	];
	const SPREAD_FILES = { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' };

	it('treats a tap inside any cell of a row as a tap on the row', () => {
		// A touch WebView sends mousemove before the click. Nothing about the cell
		// under the finger may change what happens: the note's own name cell and the
		// row's padding both act on the row — and what the row does is OPEN the file
		// it stands for (see NavHistoryList.onClick).
		const h = harness(entries(), 2, files, [], {}, {}, true);
		h.note('b.md').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		const target = h.note('b.md').querySelector<HTMLElement>('.nav-row-file')!;

		target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('ignores the mousemove a tap synthesises, so the click still opens the note', () => {
		// A touch WebView sends mouseover/mousemove before the click. The list has no
		// mousemove handler to take that for a hover any more (see NavHistoryList), so
		// the pointer report selects nothing — and the click that follows is the row's
		// own, which opens the file rather than being read as a second press on an
		// already-open row.
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const row = h.note('b.md');

		row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		expect(row.classList.contains('is-selected')).toBe(false);

		h.clickRow(row);
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('lets a pointing device open the file from the row itself, in one click', () => {
		// The row is not a touch affordance: a mouse gets the same one click, and it is
		// the whole journey — one press, one destination, and the panel has nothing to
		// do with it (see NavHistoryList.onClick).
		const h = harness(entries(), 2, files);

		h.clickRow(h.note('b.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('opens nothing on a right-click, and refuses the gesture', () => {
		const h = harness(entries(), 2, files);

		const ev = h.rightClick(h.note('b.md'));

		// A row is opened by clicking it. The right button used to travel as well — a
		// shortcut for a hand already resting on it — and that is gone: one gesture per
		// meaning, and the visible one is the click (see NavHistoryList.onContextMenu).
		expect(h.jumpTo).not.toHaveBeenCalled();
		// …and it is still refused rather than handed to the app: a row has no text to
		// copy, nothing to inspect, and a long press must raise no callout over the list.
		expect(ev.defaultPrevented).toBe(true);
	});

	it('does not travel on a press that was only held down', () => {
		const h = harness(entries(), 2, files);
		const row = h.note('b.md');

		// A WebView raises `contextmenu` for a long touch as well as for a right
		// click, and the two are told apart by the BUTTON the event carries: a real
		// right press has 2, a lingering finger's has the left button's 0. Taking
		// the second for the first is what made a slow tap jump — the tablet report
		// was "tapping the file name jumps too".
		const held = h.longPress(row);
		expect(h.jumpTo).not.toHaveBeenCalled();
		// …and the press is still refused: a long press on a row has no menu, no
		// callout and no text selection to offer — it just goes nowhere.
		expect(held.defaultPrevented).toBe(true);

		// …and neither does the right button, from the same row: the gesture is
		// refused whichever way it arrives.
		h.rightClick(row);
		expect(h.jumpTo).not.toHaveBeenCalled();
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
		const hint = h.el.querySelector<HTMLElement>('.position-restore-nav-hint')!;

		// One sentence, and it is the DEVICE's own: a finger taps. (It used to name the
		// row's gutter control and draw that control's glyph into the line; the control
		// is gone with the details panel, so the sentence names the one gesture a row
		// has and carries nothing else.)
		expect(hint.textContent).toBe(t('navHistory.touchHint'));
	});

});
