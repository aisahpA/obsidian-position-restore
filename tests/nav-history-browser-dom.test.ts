// DOM-level tests for the history browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the landing preview panel, and the search
// box that is now the toolbar's only control.
// The pure pieces (describe/group/merge/filter/time/panes) are covered in
// nav-history-browser.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownRenderer, MarkdownView, Platform, TFile } from 'obsidian';

import { NavHistoryModal } from '@/nav-history/browser/modal';
import type { NavBrowserPrefs } from '@/nav-history/browser/body';
import type { LandingsMode } from '@/nav-history/browser/listing';
import type { PreviewMode } from '@/nav-history/browser/preview-content';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { NAV_CONTEXT_RADIUS } from '@/position/capture/ephemeral';
import { DEFAULT_SETTINGS } from '@/types';
import type { NavEntryState } from '@/types';
import { t } from '@/i18n';

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

// The markdown the drawer handed to Obsidian's renderer, in call order. Read off
// a spy on the real static — the stub draws it, but the tests typecheck against
// the app's own typings, which know nothing of a call log.
let rendered: string[] = [];

beforeEach(() => {
	rendered = [];
	const original = MarkdownRenderer.render;
	vi.spyOn(MarkdownRenderer, 'render').mockImplementation((app, markdown, el, path, component) => {
		rendered.push(markdown);
		return original(app, markdown, el, path, component);
	});
});

const MINUTE = 60_000;
const NOW = Date.now();

// A preference set for one harness (or for two, when a test wants to show that a
// choice made in one dialog is the choice the next one opens on). The write is
// recorded, so a test can assert that the panel asked the PLUGIN to remember the
// switch rather than keeping it to itself.
function prefs(start: { mode?: PreviewMode; landings?: LandingsMode; details?: boolean } = {}) {
	// The details column is ON here although the PLUGIN's default is off (see
	// types.ts): almost everything this file asserts is what that column does, so the
	// fixture turns it on unless a test says otherwise — and the suites that are about
	// the default itself pass `details: false` and say so.
	const state = { mode: 'spot' as PreviewMode, landings: 'last' as LandingsMode, details: true, ...start };
	return {
		state,
		browser: {
			previewMode: () => state.mode,
			setPreviewMode: (mode: PreviewMode) => {
				state.mode = mode;
			},
			landings: () => state.landings,
			setLandings: (how: LandingsMode) => {
				state.landings = how;
			},
			showDetails: () => state.details,
			setShowDetails: (on: boolean) => {
				state.details = on;
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
		prefs({ mode: 'spot', landings: 'all' }).browser);
}

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
	files: Record<string, string> = {},
	deleted: string[] = [],
	// paths held open in an editor: never read. The drawer's spot view shows the
	// entry's own recorded block, so this text must not appear in it, and
	// `cachedRead` staying untouched is the assertion that the spot read nothing.
	live: Record<string, string> = {},
	// parsed headings per path, as metadataCache would report them — or a whole
	// cache record, for the tests that need `frontmatterPosition`
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
	// The browser's own two preferences, as the plugin hands them to a shell (see
	// NavBrowserPrefs). A test that wants a dialog to OPEN on the whole note passes
	// its own set here — the same object twice, to show that the choice is not the
	// dialog's — and the default is a fresh one per harness, so tests cannot leak a
	// preference into each other through the settings file.
	browserPrefs: NavBrowserPrefs = defaultPrefs(),
) {
	const jumpTo = vi.fn(async () => {});
	// Following a link inside the rendered preview: the app's own open, which the
	// browser calls instead of letting the anchor navigate (see
	// NavPreviewContent.wire).
	const openLinkText = vi.fn(async () => {});
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
			openLinkText,
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
	// …and ONE click on the gutter control every row carries: the panel describes THAT
	// row — the recorded spot it stands for, or the note as it stands now — and a
	// second click on the same control puts the panel away again (see
	// NavHistoryList.disclose). It is the second half of a row, and the two hotspots
	// are separate: this one opens nothing.
	const point = (row: HTMLElement) =>
		row.querySelector<HTMLElement>('.nav-row-disclose')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// …and the same destination without the row: a right-click on the row opens it at
	// once, with no menu in between (see NavHistoryList.onContextMenu). The button
	// number is the whole gesture there — a lingering finger's `contextmenu` carries
	// the left one (see `longPress`).
	const rightClick = (row: HTMLElement) => row.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
	);
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
	// The drawer's content, as Obsidian's renderer received it: the recorded block
	// for a spot, the whole file for a note. What is ASSERTED on is this source —
	// the rendering itself is Obsidian's (see the stub's minimal stand-in).
	const source = () => rendered[rendered.length - 1] ?? '';
	// …and the mark a reader's eye lands on: the ==…== the recorded landing
	// carries, or the line found by its words in a whole note.
	const marks = () => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.nav-preview-content mark'))
		.map(m => m.textContent);
	const content = () => modal.contentEl.querySelector<HTMLElement>('.nav-preview-content');
	// Which content the panel shows is the plugin's own SETTING, chosen in the
	// toolbar's gear (see NavHistoryBrowser.openSettings): open the menu, pick the
	// answer by its label, and the menu closes on the pick — the same two clicks a
	// reader makes.
	const pickSetting = (label: string) => {
		clickRow(modal.contentEl.querySelector<HTMLElement>('.position-restore-nav-settings')!);
		const option = Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.nav-settings-option'))
			.find(b => b.querySelector('.nav-settings-label')?.textContent === label)!;
		clickRow(option);
	};
	return {
		modal, jumpTo, cachedRead, openLinkText, el: modal.contentEl,
		rows, notes, note, place, clickRow, point, rightClick, longPress, movePointer,
		key, source, marks, content, pickSetting,
	};
}

beforeEach(() => {
	document.body.innerHTML = '';
	// Children (and any class a test left on the body), or one test's DOM leaks
	// into the next.
	document.body.className = '';
	// The view switch is the plugin's own PERSISTED preference (see
	// NavBrowserPrefs), so there is no session state here to reset: every harness is
	// handed a fresh set unless the test passes its own in.
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
		// Every row carries the gutter control, the current one included: its details
		// are worth seeing, and the destination is not what the row loses — the row's
		// own click opens it too (see NavHistoryList.targetOf). The control is simply
		// the other half of the gesture.
		expect(notes[0].querySelector('.nav-row-disclose')).not.toBeNull();
		expect(notes[1].querySelector('.nav-row-disclose')?.nextElementSibling?.className).toBe('nav-row-file');
		expect(notes[1].querySelector('.nav-row-here')).toBeNull();
	});

	it('keeps the current note to ONE row, and points the panel at the spot it stands for', () => {
		const entries = [
			visit('a.md', NOW - 5 * MINUTE, { scroll: 3 }),
			visit('c.md', NOW - 2 * MINUTE, { scroll: 20 }),
			visit('c.md', NOW, { scroll: 90 }),
		];
		const h = harness(entries, 2, { 'a.md': '', 'c.md': '' });
		const described = () => h.el.querySelector('.position-restore-nav-preview .nav-row-line')?.textContent;

		// Two spots in c.md, and the DEFAULT list prints neither: one row per note is
		// the whole of what it is (see LandingsMode), and the row stands for the LAST
		// spot the reader was at in that note.
		expect(h.rows()).toHaveLength(0);
		expect(h.note('c.md').querySelector('.nav-row-here')).toBeNull();

		// …and that spot is where the reader already is (L91, the newest step), so a
		// click describes exactly that — one row, one meaning, and no row that quietly
		// means an older place in the note (see NavHistoryList.activeRep).
		h.point(h.note('c.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('c.md');
		expect(described()).toBe('L91');
		// …and the row is a destination all the same: a click opens c.md at that very
		// place, because the open re-lands it rather than pushing it again — which is
		// what a reader whose tab was closed is asking for (see NavHistoryList.targetOf).
		// The gutter control stays; it is the other half of the row.
		h.clickRow(h.note('c.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(2);
		expect(h.note('c.md').querySelector('.nav-row-disclose')).not.toBeNull();
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

	it('walks on from the row a click left the position on, and keeps it in view', () => {
		// One position for both hands: ↓ continues from wherever the position is —
		// including a row a CLICK put it on — and the list follows it, so the reader
		// can see where they are instead of a highlight moving off-screen. (jsdom lays
		// nothing out, so what this sees is the browser's own minimal scroll; the list's
		// real rule is revealDelta's, and the test below hands it a layout.)
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });
		const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
		const selected = () => Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-selected'))
			.map(r => r.querySelector('.nav-row-name')?.textContent);

		// c.md, b.md, a.md — the current note first, then by recency.
		h.point(h.notes()[1]);
		expect(selected()).toEqual(['b.md']);
		expect(spy).toHaveBeenCalled();
		spy.mockClear();

		h.key('ArrowDown'); // …and on to the next row from THERE, not from an older cursor
		expect(selected()).toEqual(['a.md']);
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

		// A click that lands on a row off the list gets the browser's minimal scroll —
		// being legible is all putting the position on a row is owed, and the list is
		// the reader's own viewport. What it must never get is the walk's jump to the
		// middle.
		h.point(h.notes()[3]); // d.md, below the box
		expect(listEl.scrollTop).toBe(0);
		expect(spy).toHaveBeenCalledWith({ block: 'nearest' });

		h.point(h.notes()[0]); // c.md, in sight
		expect(listEl.scrollTop).toBe(0);
		spy.mockClear(); // …and from here on, the walk alone moves the list

		h.key('ArrowDown'); // b.md, in sight
		expect(listEl.scrollTop).toBe(0);
		h.key('ArrowDown'); // a.md, flush with the foot of the list — still IN sight
		expect(listEl.scrollTop).toBe(0);

		h.key('ArrowDown'); // …and out of it: the list brings the row to its MIDDLE
		expect(listEl.scrollTop).toBe(40);
		expect(160 - listEl.scrollTop).toBe(120); // the row's top, at the box's middle
		expect(spy).not.toHaveBeenCalled(); // no browser scroll: the walk is the list's own
	});

	it('moves the position for a click and for nothing a pointer merely crosses', () => {
		// THE RULE OF THE PANEL (see NavHistoryList): a pointer that passes over a row
		// chooses nothing. It used to move THE position — the row the drawer describes
		// and Enter travels to — which meant a mouse crossing the list described a row
		// nobody chose and could undo the keyboard's walk. Every report here is a real
		// one, at a coordinate of its own, so what the panel is doing is ignoring a
		// pointer rather than never hearing from one.
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

		// The one thing that does move it: a click on the row.
		h.point(b);
		expect(selected()).toEqual(['b.md']);
	});

	it('walks the note rows, and ←→ opens nothing because nothing is printed', () => {
		// Two landings in b.md, and the cursor walks onto its row.
		const entries = [
			visit('a.md', NOW - 5 * MINUTE),
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-2', t: NOW - 3 * MINUTE, st: { scroll: 40 } } as NavHistoryEntry,
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-2', t: NOW - 2 * MINUTE, st: { scroll: 400 } } as NavHistoryEntry,
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

	it('walks the landing rows too when the setting prints them', () => {
		// The same list under 'all': the note's spots are rows of their own, so ↓ steps
		// into them and Enter travels to the one it is on (see NavHistoryList.move).
		const entries = [
			visit('a.md', NOW - 5 * MINUTE),
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-2', t: NOW - 3 * MINUTE, st: { scroll: 40 } } as NavHistoryEntry,
			{ kind: 'visit', path: 'b.md', leafId: 'leaf-2', t: NOW - 2 * MINUTE, st: { scroll: 400 } } as NavHistoryEntry,
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
		// The dialogs of this file open on the fixture's own set (see prefs): one row per
		// note, with the details column switched on.
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
		// THREE choices (see NavHistoryBrowser.openSettings): whether the list describes
		// a landing at all, how much of a note it prints, and which content that
		// description shows. Each is its own group with its own name — what is chosen has
		// to be audible without opening the list to look at its shape — and every ANSWER
		// carries the few words saying what it means, on its own row, which a menu cannot
		// carry. That is why this is the panel's own DOM and not the app's Menu.
		expect(panel.getAttribute('role')).toBe('group');
		expect(panel.getAttribute('aria-label')).toBe(t('navHistory.listSettings'));
		expect(panel.querySelectorAll('.nav-settings-group')).toHaveLength(3);
		expect(Array.from(panel.querySelectorAll('.nav-settings-title')).map(el => el.textContent))
			.toEqual([
				t('navHistory.landings.name'),
				t('navHistory.details.name'),
				t('navHistory.preview.name'),
			]);
		// The few words are read where the answer is, after it, and not out of one
		// paragraph under the group: no group-level note is left, and every answer
		// holds its own.
		expect(panel.querySelectorAll('.nav-settings-desc')).toHaveLength(0);
		expect(Array.from(panel.querySelectorAll('.nav-settings-option-desc')).map(el => el.textContent))
			.toEqual([
				t('navHistory.landings.options.last.desc'),
				t('navHistory.landings.options.all.desc'),
				t('navHistory.details.show.desc'),
				t('navHistory.preview.spot.desc'),
				t('navHistory.preview.note.desc'),
			]);
		expect(option(h, t('navHistory.landings.options.all'))
			.querySelector('.nav-settings-option-desc')?.textContent)
			.toBe(t('navHistory.landings.options.all.desc'));
		expect(Array.from(panel.querySelectorAll('[role="radiogroup"]')).map(el => el.getAttribute('aria-label')))
			.toEqual([t('navHistory.landings.name'), t('navHistory.preview.name')]);
		// The details column is a CHECK rather than a radio pair: "show it" and "hide it"
		// are not two answers a reader picks between, so its group carries one row — and
		// that row is a checkbox, so its one state is read the way the radios' are.
		const details = option(h, t('navHistory.details.show'));
		expect(details.getAttribute('role')).toBe('checkbox');
		expect(details.getAttribute('aria-checked')).toBe('true');
		expect(details.parentElement?.getAttribute('role')).toBe('group');
		expect(details.parentElement?.getAttribute('aria-label')).toBe(t('navHistory.details.name'));
		// A radio group, not a menu of commands: which of the two is in force has to be
		// audible without looking at the list's shape.
		expect(option(h, t('navHistory.landings.options.last')).getAttribute('aria-checked')).toBe('true');
		expect(option(h, t('navHistory.landings.options.all')).getAttribute('aria-checked')).toBe('false');
		expect(option(h, t('navHistory.preview.spot')).getAttribute('aria-checked')).toBe('true');
		expect(option(h, t('navHistory.preview.note')).getAttribute('aria-checked')).toBe('false');
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
		const all = prefs({ mode: 'spot', landings: 'all' });
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
		const held = prefs({ mode: 'spot', landings: 'last' });
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

	it('hands the panel\'s content choice to the plugin too, and redraws the row under it', async () => {
		// The same contract as the list's shape (see NavBrowserPrefs): which of the two
		// contents is shown is a SETTING now — chosen here rather than by a pair of
		// buttons on the panel's own caption line (see LandingPanel) — so choosing it
		// is one place for every panel, and the choice outlives the dialog it was made
		// in.
		const held = prefs({ mode: 'spot', landings: 'last' });
		const entries = [
			visit('a.md', NOW - MINUTE, { scroll: 3, context: [{ line: 3, text: '落点' }], contextAt: 0 }),
			visit('b.md', NOW),
		];
		const h = harness(entries, 1, { 'a.md': 'one\ntwo\nthree', 'b.md': '' }, [], {}, {}, false, [], {}, held.browser);

		h.point(h.note('a.md'));
		expect(h.el.querySelector('.nav-preview-content')?.className).toContain('is-spot');

		h.clickRow(gear(h));
		h.clickRow(option(h, t('navHistory.preview.note')));

		expect(held.state.mode).toBe('note');
		expect(menu(h)).toBeNull();
		// …and the row that was up is redrawn in the other view, on the spot: the read
		// the whole-note view needs is asynchronous, so the redraw lands a tick later.
		await vi.waitFor(() => {
			expect(h.el.querySelector('.nav-preview-content')?.className).toContain('is-note');
		});
	});

	// THE DETAILS COLUMN IS OFF AS THE PLUGIN SHIPS (see types.ts): the history is a
	// list of places to go back to, and what each step WAS is a reader's own choice —
	// made in the gear, from the list it changes. These two tests are the two directions
	// of that switch; the suites above them run with it on (see prefs).
	it('leaves the details column out entirely when the plugin says so', () => {
		expect(DEFAULT_SETTINGS.navShowDetails).toBe(false);
		const h = harness(entries(), 2, files, [], {}, {}, false, [], {}, prefs({ details: false }).browser);

		// No row carries the control that asks for a landing's details, and no row claims
		// to be described by a panel: the column is not there to describe anything.
		expect(h.el.querySelector('.nav-row-disclose')).toBeNull();
		expect(h.el.querySelector('.is-previewed')).toBeNull();
		// The body says so in its own class — the layout rule reads it, so the list takes
		// the room the column was holding (see styles.css) — and the panel drew nothing:
		// not even the head it draws for every entry (see LandingPanel.draw).
		expect(h.el.querySelector('.position-restore-nav-body')?.classList.contains('is-no-details')).toBe(true);
		expect(h.el.querySelector('.nav-preview-head')).toBeNull();
		const hint = h.el.querySelector<HTMLElement>('.position-restore-nav-hint')!;
		expect(hint.textContent).toBe(t('navHistory.clickHintOpen'));
		// …and it draws no glyph: the arrow it would stand for is not on the list.
		expect(hint.querySelector('.nav-hint-icon')).toBeNull();

		// What is left is the navigation itself, which the setting does not touch: the
		// keyboard still walks the list — the position is one row, and it is MARKED as
		// the position rather than as a row some panel is describing — and a row still
		// opens the file it stands for.
		h.key('ArrowDown');
		expect(h.el.querySelectorAll('.position-restore-nav-row.is-selected')).toHaveLength(1);
		expect(h.el.querySelector('.position-restore-nav-row.is-previewed')).toBeNull();
		h.clickRow(h.note('a.md'));
		expect(h.jumpTo).toHaveBeenCalled();
	});

	it('switches the column back on from the gear, rows, panel and hint together', () => {
		const held = prefs({ details: false });
		const h = harness(entries(), 2, files, [], {}, {}, false, [], {}, held.browser);
		expect(h.el.querySelector('.nav-row-disclose')).toBeNull();

		h.clickRow(gear(h));
		// The switch is off, and the menu asks nothing about a column that is not there:
		// two groups, the switch and the list's shape.
		const check = option(h, t('navHistory.details.show'));
		expect(check.getAttribute('aria-checked')).toBe('false');
		expect(menu(h)!.querySelectorAll('.nav-settings-group')).toHaveLength(2);

		h.clickRow(check);

		// The choice went to the plugin (see NavBrowserPrefs.setShowDetails), the menu is
		// away, and the browser is the one the reader asked for — in the same breath, on
		// a panel that may have been standing for hours.
		expect(held.state.details).toBe(true);
		expect(menu(h)).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-body')?.classList.contains('is-no-details')).toBe(false);
		expect(h.note('b.md').querySelector('.nav-row-disclose')).not.toBeNull();
		const hint = h.el.querySelector<HTMLElement>('.position-restore-nav-hint')!;
		expect(hint.textContent).toBe(t('navHistory.clickHint').replace('{arrow}', ''));
		expect(hint.querySelector('.nav-hint-icon svg')?.getAttribute('data-icon')).toBe('chevron-right');
		// The column is drawn for the row the list is on, so what was asked for is what
		// is there — not an empty column waiting for the next click.
		expect(h.el.querySelector('.nav-preview-head')).not.toBeNull();

		// …and back the other way, from the same switch: the rows lose the control, the
		// column leaves, and the line stops naming a gesture the list no longer has.
		h.clickRow(gear(h));
		h.clickRow(option(h, t('navHistory.details.show')));
		expect(held.state.details).toBe(false);
		expect(h.el.querySelector('.nav-row-disclose')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-body')?.classList.contains('is-no-details')).toBe(true);
		expect(h.el.querySelector('.nav-preview-head')).toBeNull();
		expect(h.el.querySelector<HTMLElement>('.position-restore-nav-hint')!.textContent)
			.toBe(t('navHistory.clickHintOpen'));
	});

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

describe('NavHistoryModal — links in the rendered content', () => {
	// A link is a navigation the reader asked for, and it is answered HERE. The app's
	// own reading view registers the click handler for the links it renders, and this
	// content is not inside one: nothing was listening, so the anchor's own href ran
	// instead — a hand cursor and a swallowed navigation on a desktop, and on a tablet
	// a WebView that follows the href and reloads the app under the reader's finger
	// (see NavPreviewContent.wire).
	const doc = ['# 面板', '', '见 [[b]] 与 [外部](https://example.com)', '', '尾巴'];
	const stack = () => [visit('a.md', NOW, captured(doc, 2))];
	const anchor = async (h: ReturnType<typeof harness>, sel: string) => await vi.waitFor(() => {
		const found = h.el.querySelector<HTMLAnchorElement>(sel);
		expect(found).not.toBeNull();
		return found!;
	});
	const press = (a: HTMLElement) => {
		const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
		a.dispatchEvent(ev);
		return ev;
	};

	it('follows a wikilink through the app, and never lets the href navigate', async () => {
		const h = harness(stack(), 0, { 'a.md': doc.join('\n') });
		const a = await anchor(h, 'a.internal-link');
		expect(a.getAttribute('data-href')).toBe('b');

		const ev = press(a);

		expect(ev.defaultPrevented).toBe(true);
		// The app's own open, from the note the link was READ in — the journey a row's
		// travel takes as well, so the dialog is out of the way before it runs.
		expect(h.openLinkText).toHaveBeenCalledWith('b', 'a.md', false);
		expect(h.modal.contentEl.isConnected).toBe(false);
	});

	it('hands an external link to the system rather than navigating the app', async () => {
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		const h = harness(stack(), 0, { 'a.md': doc.join('\n') });
		const a = await anchor(h, 'a.external-link');

		const ev = press(a);

		expect(ev.defaultPrevented).toBe(true);
		expect(open).toHaveBeenCalledWith('https://example.com');
		expect(h.openLinkText).not.toHaveBeenCalled();
	});

	it('sends a same-file anchor the same way, rather than reloading the page', async () => {
		const withAnchor = ['# 面板', '', '见 [[#面板设计]]', '', '尾巴'];
		const h = harness([visit('a.md', NOW, captured(withAnchor, 2))], 0, { 'a.md': withAnchor.join('\n') });
		const a = await anchor(h, 'a.internal-link');

		const ev = press(a);

		expect(ev.defaultPrevented).toBe(true);
		expect(h.openLinkText).toHaveBeenCalledWith('#面板设计', 'a.md', false);
	});
});

describe('NavHistoryModal — deleted entries', () => {
	it('lists a deleted note but never makes it a travel target', () => {
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'b.md': '' }, ['gone.md']);

		const row = h.notes()[1];
		expect(row.classList.contains('is-missing')).toBe(true);
		// the type cell that used to spell this out is gone; the name carries it
		expect(row.querySelector('.nav-row-file')?.classList.contains('is-missing')).toBe(true);

		// Every row carries the gutter control, a deleted note's included — the panel is
		// where "this file is gone, here is what stood there" is said, and the control is
		// how it is said (see NavHistoryList.disclose). What the row loses is the
		// DESTINATION, not the control.
		expect(row.querySelector('.nav-row-disclose')).not.toBeNull();

		// A right-click on it is refused the same way: the gesture has exactly one
		// meaning in this list — open it there — so a row with nowhere to open does
		// nothing at all, and its own tooltip is what says why (see
		// NavHistoryList.onContextMenu).
		h.rightClick(row);
		expect(h.jumpTo).not.toHaveBeenCalled();

		// Enter is a different question: it opens whatever the cursor is on, and the
		// cursor is on nothing here — no row has been pointed at — so it does nothing
		// at all. The assertion above is what pins the refusal: a missing note's row
		// opens the file (that is how its recorded landings and the "file deleted"
		// panel are reached), and never travels.
		h.key('Enter');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('says a note is dead in the accessibility tree, not only in a tooltip', () => {
		const entries = [
			visit('gone.md', NOW - 3 * MINUTE),
			visit('a.md', NOW - MINUTE),
			visit('c.md', NOW),
		];
		const h = harness(entries, 2, { 'a.md': '', 'c.md': '' }, ['gone.md']);

		const [live, dead] = [h.note('a.md'), h.note('gone.md')];
		expect(live.getAttribute('role')).toBe('option');
		expect(live.hasAttribute('aria-disabled')).toBe(false);

		expect(dead.getAttribute('role')).toBe('option');
		expect(dead.getAttribute('aria-disabled')).toBe('true');
	});

	it('still lists a deleted note, whose recorded landings are all that is left', () => {
		const entries = [
			visit('gone.md', NOW - 3 * MINUTE, { scroll: 40 }),
			visit('gone.md', NOW - 2 * MINUTE, { scroll: 400 }),
			visit('b.md', NOW),
		];
		const h = harnessAll(entries, 2, { 'b.md': '' }, ['gone.md']);

		// The landings are drawn — by LINE, top of the note first, whatever order
		// they were visited in — each marked dead: the recorded block behind them
		// is what the panel prints (see the landing-block suite).
		const places = h.rows();
		expect(places.map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L41', 'L401']);
		for (const place of places) {
			expect(place.classList.contains('is-missing')).toBe(true);
			expect(place.getAttribute('aria-disabled')).toBe('true');
			// …and the gutter control is on every one of them: the recorded block behind
			// them is what the panel prints, and that is the only thing left to do with a
			// row whose file is gone (see NavHistoryList.disclose).
			expect(place.querySelector('.nav-row-disclose')).not.toBeNull();
		}

		// The note's own row is still the note, and still points the panel at one of
		// those recorded spots — "this file is gone, here is what stood there" is what
		// the panel is for — but neither it nor they can be travelled to.
		h.point(h.note('gone.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('gone.md');
		expect(h.jumpTo).not.toHaveBeenCalled();
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
		// Most notes in a real history were visited once, and there is no choice to
		// make in those: the row is the note AND the spot, the drawer describes it
		// without anything being opened, and a "1" plus a caret would be two cells
		// spent saying there is nothing under them.
		const h = harnessAll([at('x.md', 100, 30), visit('y.md', NOW)], 1, files);

		const row = h.note('x.md');
		expect(row.querySelector('.nav-row-count')).toBeNull();
		// …and no caret either: the arrow leads, and the name follows it directly.
		expect(row.querySelector('.nav-file-caret')).toBeNull();
		expect(row.querySelector('.nav-row-disclose')?.nextElementSibling?.className).toBe('nav-row-file');

		// ONE spot is not a list, so not even 'all' prints a row for it (see
		// NavHistoryList.printsLandings): the note's own row stands for it.
		expect(h.rows()).toHaveLength(0);

		// A click points the panel at that spot — the row is the landing.
		h.point(row);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('x.md');

		// It is still a destination: a click on the row opens its one place.
		h.clickRow(h.note('x.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('travels from a note\'s arrow without the row\'s own click running too', () => {
		// x.md holds two places, so its row has an answer of its own: the NEWEST of
		// them. A click on the row opens it — one press, one destination — and the
		// GUTTER CONTROL, which is what points the panel, did not run on the way (see
		// NavHistoryList.disclose). The dialog closes itself on the open, so the row is
		// asked, detached, where it would have gone. (It used to OPEN its landings
		// instead, and a sublist
		// flashing open and shut is exactly what the double click cost the reader.)
		const h = harness([at('x.md', 100, 30), at('x.md', 412, 10), visit('y.md', NOW)], 2, files);

		h.clickRow(h.note('x.md'));

		// The note's NEWEST landing — where the reader left it (step 1, L413), not the
		// top of the note (step 0, L101), which is what its row meant while the
		// landings were ordered by line alone (see NavHistoryList.activeRep).
		expect(h.jumpTo).toHaveBeenCalledWith(1);
		// …and the row's own click did not run: no position was left on it, and the
		// drawer still answers "where I am" (y.md).
		expect(h.el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('y.md');
	});

	it('never takes the focus off the filter box — the gutter control refuses the press', () => {
		// A button takes the focus on mousedown, and the panel's keyboard lives in the
		// filter box: a click that moved the caret would leave the reader typing at
		// nothing. It is also what lets the control stay out of the accessibility tree —
		// an element that can take the focus is one the browser refuses to hide, and
		// warns about ("Blocked aria-hidden on an element because its descendant
		// retained focus") — so the refusal is a contract, not a detail (see
		// NavHistoryList.disclose).
		const h = harness([at('x.md', 100, 30), visit('y.md', NOW)], 1, files);
		const control = h.note('x.md').querySelector<HTMLElement>('.nav-row-disclose')!;

		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		control.dispatchEvent(press);

		expect(press.defaultPrevented).toBe(true);
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
		const all = prefs({ mode: 'spot', landings: 'all' });
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
	const pane = (path: string, leafId: string, stamp: number): NavHistoryEntry =>
		({ kind: 'visit', path, leafId, t: stamp, st: { scroll: stamp } });

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

		// The panel is driven by taps on touch (a synthesized mousemove is
		// ignored there — see the touch suite).
		h.point(h.rows()[0]);
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 1, 2));

		h.point(h.rows()[1]); // the other landing
		expect(h.el.querySelector('.nav-preview-pane')?.textContent).toBe(t('navHistory.pane', 2, 2));
	});

	it('says nothing about panes when a note lives in one leaf', () => {
		const entries = [pane('a.md', 'left', 100), pane('b.md', 'left', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' }, [], {}, {}, true, [
			{ leafId: 'left', path: 'a.md' },
		]);

		// a.md holds ONE landing, so there is no landing row to carry the marker: the
		// note's own row stands in for that landing, and the drawer it points at says
		// nothing about panes either.
		h.point(h.note('a.md'));

		expect(h.el.querySelector('.nav-preview-pane')).toBeNull();
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

describe('NavHistoryModal — landing preview', () => {
	const doc = ['one', 'two', 'three', 'LANDING', 'five', 'six', 'seven', 'eight'];
	const read = { 'a.md': doc.join('\n'), 'b.md': 'only line', 'c.md': 'x' };
	// b.md is current; a.md's capture lands on the "LANDING" line, so a pointed
	// landing has a recorded block to show.
	const withLanding = [
		visit('a.md', NOW - 5 * MINUTE, captured(doc, 3)),
		visit('b.md', NOW),
	];
	// On a touch device the panel is driven by TAPS: a synthesized mousemove is
	// deliberately ignored there (see the touch suite), so a row is tapped. What the
	// tap lands ON is what tells the two halves apart: the row opens the file, and the
	// control in its gutter asks the panel about it (see NavHistoryList) — so this
	// helper taps the gutter control of a row it is handed.
	const tap = (el: HTMLElement) => {
		const control = el.querySelector<HTMLElement>('.nav-row-disclose');
		(control ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
	};
	const tapLanding = (h: ReturnType<typeof harness>, name = 'a.md') => tap(h.note(name));

	it('stands in its own column on a pointing device, and in the list on touch', () => {
		// The two presentations of one renderer: on a pointing device the panel
		// IS the right-hand column and describes the current landing from the
		// start; on touch it waits out of the list until a landing is tapped.
		const desktop = harness(withLanding, 1, read);
		expect(desktop.modal.modalEl.classList.contains('is-touch')).toBe(false);
		// The drawer opens on "where I am" — the current entry's own landing.
		expect(desktop.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');

		const touch = harness(withLanding, 1, read, [], {}, {}, true);
		expect(touch.modal.modalEl.classList.contains('is-touch')).toBe(true);
		// Parked in the body until a landing is tapped, then inside the list under
		// that row — never a standing panel of its own (see the touch suite).
		expect(touch.el.querySelector('.position-restore-nav-body > .position-restore-nav-preview')).not.toBeNull();
		expect(touch.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(true);
		expect(touch.content()).toBeNull();
	});

	it('follows the row that was clicked, one landing at a time', () => {
		// The drawer answers for whatever row the reader clicked: clicking a.md's
		// landing — its row IS the landing, since a.md holds one — replaces the "you
		// are here" description with that spot's lines.
		const h = harness(withLanding, 1, read);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');

		h.point(h.note('a.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		expect(h.content()?.textContent).toContain('LANDING');
	});

	it('describes whatever row was used, and opens the file from that row', () => {
		// The drawer is the panel's own reading surface: what it describes follows the
		// reader's gutter control, and the JOURNEY is the row's own click — the panel
		// has no button of its own any more (see LandingPanel.caption).
		const h = harness(withLanding, 1, read);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');

		h.point(h.note('a.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		expect(h.content()?.textContent).toContain('LANDING');

		h.clickRow(h.note('a.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('follows the landing the tapped row stands for, showing its line in context', () => {
		const h = harness(withLanding, 1, read, [], {}, {}, true);

		tapLanding(h);

		// The whole recorded block, handed to Obsidian's renderer as MARKDOWN —
		// the landing line wrapped in Obsidian's own ==…== mark, so the reader's
		// eye lands on the spot even though the rendering has no gutter left to
		// point at it. Five non-blank lines either side, clamped to the document:
		// the eight lines this file has, none of them blank.
		expect(h.source()).toBe(doc.map(line => (line === 'LANDING' ? '==LANDING==' : line)).join('\n'));
		expect(h.marks()).toEqual(['LANDING']);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		// The coordinate survives in the head, plus the range the block covers.
		expect(h.el.querySelector('.nav-preview-head .nav-row-line')?.textContent).toBe('L4 / 8');
		expect(h.el.querySelector('.nav-preview-caption')?.textContent)
			.toBe(t('navHistory.preview.recorded', 1, 8));
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('opens the panel under the NOTE when its gutter control is tapped', () => {
		// A tap on the note row's gutter control points the panel at the place that row
		// stands for: a note with one place has no sublist to open, so the row a finger
		// hits is both — there is nothing to open first.
		const h = harness(withLanding, 1, read, [], {}, {}, true);

		tap(h.note('a.md'));

		expect(h.marks()).toEqual(['LANDING']);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		// the panel hangs under the row that was tapped, inside the list
		expect(h.note('a.md').nextElementSibling?.className).toContain('position-restore-nav-preview');
	});

	it('follows the keyboard selection just the same', () => {
		const h = harness(withLanding, 1, read, [], {}, {}, true);

		h.key('ArrowDown'); // b.md (pinned, current), then a.md
		h.key('ArrowDown');

		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		expect(h.marks()).toEqual(['LANDING']);
	});

	it('ignores a mouseenter that no pointer movement produced', () => {
		// A browser synthesises mouseenter for whatever lands under a
		// stationary pointer when rows are rebuilt; honouring it would steal
		// the keyboard selection and silently retarget Enter. Nothing in this list
		// listens for a pointer at all any more (see NavHistoryList), so the test is
		// the same one twice: the event changes nothing, and the click that follows
		// the walk is what points the panel.
		const h = harness(withLanding, 1, read, [], {}, {}, true);

		h.note('a.md').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
		expect(h.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(true);

		// Down selects a note, and Enter then travels to its newest landing.
		h.key('ArrowDown'); // b.md
		h.key('ArrowDown'); // a.md
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(0);
	});

	it('says so when the tapped landing has no landing to show', () => {
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, read, [], {}, {}, true);

		tapLanding(h);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.none'));
	});

	it('previews a deleted note without letting it become a travel target', () => {
		const h = harness(
			[visit('gone.md', NOW - MINUTE), visit('b.md', NOW)],
			1,
			read,
			['gone.md'],
			{},
			{},
			true,
		);

		tap(h.note('gone.md'));
		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.gone'));
		// Exactly one admission: with no recorded block there is nothing to add,
		// and "file deleted" has already said the thing that matters.
		expect(h.el.querySelectorAll('.nav-preview-note')).toHaveLength(1);
		// it grows no button to travel with
		expect(h.el.querySelector('.nav-preview-go')).toBeNull();

		// Enter never jumps to the dead note
		h.key('Enter');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});
});

describe('NavHistoryModal — where the type lives now', () => {
	it('keeps the rows free of a type cell, and prints a type only where it says something', async () => {
		// "Open" is what a step IS by default — the reader is looking at a history of
		// things they opened — so the panel prints nothing for it, and prints the other
		// four, which say something they may not know (see NavEntryDescription.plainOpen
		// and LandingPanel.head).
		const plain = harness([
			visit('a.md', NOW - MINUTE, { scroll: 3, context: [{ line: 3, text: '落点' }], contextAt: 0 }),
			visit('b.md', NOW),
		], 1, { 'a.md': '', 'b.md': '' }, [], {}, {}, true);
		expect(plain.notes()[0].querySelector('.nav-row-badge')).toBeNull();
		// a click, and the only gesture that describes anything (see the landing
		// preview suite)
		plain.point(plain.note('a.md'));
		// the panel is describing the spot (it prints its coordinate) and says nothing
		// about how the step was made
		expect(plain.el.querySelector('.nav-preview-meta .nav-row-line')?.textContent).toBe('L4');
		expect(plain.el.querySelector('.nav-preview-type')).toBeNull();

		const switcher = { kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: NOW - MINUTE, via: 'switch' } as NavHistoryEntry;
		const h = harness([switcher, visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' }, [], {}, {}, true);

		expect(h.notes()[0].querySelector('.nav-row-badge')).toBeNull();
		h.point(h.note('a.md'));
		expect(h.el.querySelector('.nav-preview-type')?.textContent).toBe(t('navHistory.type.switch'));
	});

	it('marks a deleted note on the name, since the cell that said so is gone', () => {
		const gone = { kind: 'visit', path: 'gone.md', leafId: 'leaf-1', t: NOW - MINUTE } as NavHistoryEntry;
		const h = harness([gone, visit('b.md', NOW)], 1, { 'b.md': '' }, ['gone.md']);

		const name = h.note('gone.md').querySelector('.nav-row-file');
		expect(name?.classList.contains('is-missing')).toBe(true);
		expect(name?.textContent).toContain('gone.md');
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

		// the deepest two levels, no file read needed
		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		expect(h.rows()[1].querySelector('.nav-row-trail')?.textContent).toBe('面板设计›尾巴');
		expect(h.cachedRead).not.toHaveBeenCalled();
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
		// an outline jump lands ON "### 预览". The row prints no landing text
		// (only the preview panel does), so that heading is the row's LAST level
		// — the one a reader places the spot by — and it stays in the chain.
		const jump = { kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:预览', t: NOW - MINUTE,
			st: captured(SPREAD_DOC, 4) } as NavHistoryEntry;
		const entries = [jump, visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)), visit('b.md', NOW)];
		const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS);

		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
	});

	it('puts the coordinate before the section, and no time column anywhere', () => {
		// The row used to be name | section | small print (pane, coordinate, age)
		// with the age in a measured column of its own. The note is the row now,
		// so a landing is the gutter control | coordinate | section, plus the pane
		// cell only while two live tabs hold that note — and the age has left the
		// list entirely (it survives in the panel).
		const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);

		const row = h.rows()[1];
		expect([...row.children].map(el => el.className))
			.toEqual(['nav-row-disclose svg-icon svg-icon-chevron-right', 'nav-row-pos', 'nav-row-trail']);
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


describe('NavHistoryModal — preview source', () => {
	const doc = '# 面板设计\n\n## 呈现方案\n\n### 预览\n\n预览条：悬停显示上下文三行\n\n尾巴\n';
	const entry = visit('a.md', NOW - MINUTE, captured(doc.split('\n'), 6));
	// touch harnesses: the panel opens on a tap of the row's gutter control, and a.md
	// holds ONE place — so its note row IS that place's row, and there is no note to
	// open first.
	const open = (h: ReturnType<typeof harness>) => {
		h.point(h.note('a.md'));
	};

	it('prints the recorded block, reading neither the vault nor the open editor', () => {
		// It used to consult the live editor for an open note and one vault read
		// otherwise. The block is what the user was looking at when they left, so
		// today's content — possibly rewritten — must never be printed where the
		// row promises the recorded spot. What changed is only how it is DRAWN:
		// as markdown through Obsidian's own renderer, so a heading arrives as a
		// heading instead of as the "## " the capture happened to store.
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': doc, 'b.md': '' }, [], { 'a.md': doc }, {}, true);

		open(h);

		// The doc's non-blank lines around line 6, with the landing marked.
		expect(h.source()).toBe([
			'# 面板设计',
			'## 呈现方案',
			'### 预览',
			'==预览条：悬停显示上下文三行==',
			'尾巴',
		].join('\n'));
		expect(h.el.querySelector('.nav-preview-caption')?.textContent)
			.toBe(t('navHistory.preview.recorded', 1, 9));
		// the raw source is not what is on screen: a heading line became a heading,
		// and the landing is the marked run inside it
		expect(h.content()?.querySelector('h1')).not.toBeNull();
		expect(h.content()?.querySelector('mark')?.textContent).toBe('预览条：悬停显示上下文三行');
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
	const open = (h: ReturnType<typeof harness>) => {
		h.point(h.note('a.md'));
	};
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

		expect(h.source()).toBe('上一段：从哪里来\n==落点这一行==\n下一段：到哪里去');
		expect(h.marks()).toEqual(['落点这一行']);
		// Nothing was read: not the vault, and not the open editor either — the
		// current file content must NOT leak into a block that says what was
		// there when the user left.
		expect(h.cachedRead).not.toHaveBeenCalled();
		expect(h.el.textContent).not.toContain('live eleven');
	});

	it('shows the recorded block for a DELETED file too', () => {
		// The file is gone; what stood there is not. This is the only thing left
		// to recognize the step by, and the reason the block is recorded rather
		// than read — and it is also why a deleted note gets no content switch:
		// there is no "as it stands now" to show.
		const h = harness([withBlock(), visit('b.md', NOW)], 1, files, ['a.md'], {}, {}, true);

		open(h);

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.gone'));
		expect(h.marks()).toEqual(['落点这一行']);
		expect(h.el.querySelector('.nav-preview-modes')).toBeNull();
		// still no way to travel there
		expect(h.el.querySelector('.nav-preview-go')).toBeNull();
		expect(h.cachedRead).not.toHaveBeenCalled();
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

	it('finds a note by any line of a recorded block', () => {
		// The landing's context block is searchable (see navSearchText), and what
		// the hit shows is the NOTE: the block is one of its landings.
		const h = harness([withBlock(), visit('b.md', NOW)], 1, files);

		search(h, '到哪里去');

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('a.md');
		// one place: a row with nothing to count
		expect(h.notes()[0].querySelector('.nav-row-count')).toBeNull();
	});

	it('finds a note by the section its landing row prints', () => {
		// The section chain is derived from the heading cache, not recorded on
		// the entry — and it is the column the user reads, so a query must be
		// able to hit it.
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
	// The panel is driven by TAPS on touch: a synthesized mousemove is deliberately
	// ignored (see the suite below). What a tap lands ON is what tells a row's two
	// halves apart — the row opens the file, and the control in its gutter asks the
	// panel about it (see NavHistoryList) — and what every test below is about is the
	// second, so this helper taps the GUTTER CONTROL of a row it is handed (and the
	// element itself for anything that is not a row).
	const tap = (el: HTMLElement) => {
		const control = el.querySelector<HTMLElement>('.nav-row-disclose');
		(control ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
	};
	// Two PLACES of one note, far enough apart to be two ROWS (see SPREAD_DOC): the
	// list folds landings within LANDING_MERGE_LINES of one another, so a fixture whose
	// two steps sit four lines apart holds one place however many steps landed in it.
	const SPREAD = () => [
		visit('a.md', NOW - 3 * MINUTE, captured(SPREAD_DOC, 6)),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
		visit('b.md', NOW),
	];
	const SPREAD_FILES = { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' };

	it('points at the landing a one-landing note stands for, and puts it away again', () => {
		// Every note here holds exactly one landing, so there is no tree to open: the
		// note row IS that landing's row, and its GUTTER CONTROL is what points the
		// panel at it — tap to point, tap again to put the panel away, which is the
		// only way back out of a preview without an Esc key. The row itself is the
		// other half of the gesture: a tap there opens the file (see NavHistoryList).
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.note('b.md'));
		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.note('b.md').classList.contains('is-selected')).toBe(true);
		// The panel describes the landing the row stands for — which is what a click
		// is for, on any device.
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
		expect(h.rows()).toHaveLength(0); // nothing to open
		expect(h.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(false);

		// The same row again puts the panel away, and the list is still there.
		tap(h.note('b.md'));
		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(true);

		// …and it opens again on the next tap.
		tap(h.note('b.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
	});

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

	it('leaves the looking to the gutter control: a tap on the row opens it', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		// the gutter control points the panel at the row and goes nowhere
		tap(h.note('b.md'));
		expect(h.note('b.md').classList.contains('is-selected')).toBe(true);
		expect(h.jumpTo).not.toHaveBeenCalled();

		// …and the ROW is the one press that goes there: b.md's own landing, index 1
		// of this stack (see NavHistoryList.onClick)
		h.clickRow(h.note('b.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('gives the whole note a scroller of its own, even inline', () => {
		// Inline, the panel is a block in the LIST's scroll — which is why finding the
		// recorded line in it could only ever mark the line and never move to it (see
		// NavPreviewContent.reveal). The whole note is the one case where the panel
		// brings a scroller of its own: a file is not a row's detail, and the recorded
		// line can be thousands of lines down it.
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.note('b.md'));
		// the recorded block is a row's detail: it shares the list's scroll
		expect(h.el.querySelector('.nav-preview-scroll')?.classList.contains('is-note')).toBe(false);

		h.pickSetting(t('navHistory.preview.note'));

		expect(h.el.querySelector('.nav-preview-scroll')?.classList.contains('is-note')).toBe(true);
		// …and it is still the list that holds the rows: the note did not replace them
		expect(h.el.querySelector('.position-restore-nav-list')).not.toBeNull();
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

		tap(h.note('a.md')); // the oldest note
		expect(h.note('a.md').nextElementSibling).toBe(panel);
		expect(panel.classList.contains('is-parked')).toBe(false);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');

		// …and it moves with the selection rather than multiplying.
		tap(h.note('b.md'));
		expect(h.note('b.md').nextElementSibling).toBe(panel);
		expect(h.el.querySelectorAll('.position-restore-nav-preview')).toHaveLength(1);
	});

	it('opens the panel under the row whose gutter control was used, note or landing', () => {
		// ONE tap, everywhere: the gutter control points the panel at the place the row
		// stands for — or puts it away again on the same control. In the default list
		// that place has no row of its own, so the panel opens UNDER the note's row,
		// which is where the finger that tapped can reach it. Where the places ARE
		// printed ('all') a note's own row opens its panel too — the details ARE what
		// its control promises — and its landings simply move down (see
		// NavHistoryList.panelAnchor).
		const h = harness(SPREAD(), 2, SPREAD_FILES, [], {}, {}, true);
		const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		const a = () => h.note('a.md');

		// The default list prints nothing under the note, so its control opens the
		// panel under that very row.
		expect(h.rows()).toHaveLength(0);
		tap(a());
		expect(a().classList.contains('is-selected')).toBe(true);
		expect(panel.classList.contains('is-parked')).toBe(false);
		expect(a().nextElementSibling).toBe(panel);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');

		// …and the same control again puts it away: one gesture, and it undoes itself.
		tap(a());
		expect(h.el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(panel.classList.contains('is-parked')).toBe(true);

		// Under 'all' the note's places are rows of their own, and the note's own
		// control still opens its panel — between the name and the places it stands
		// for, which is where the reader asked for it.
		const all = harnessAll(SPREAD(), 2, SPREAD_FILES, [], {}, {}, true);
		const allPanel = all.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		expect(all.rows()).toHaveLength(2);
		tap(all.note('a.md'));
		expect(all.note('a.md').classList.contains('is-selected')).toBe(true);
		expect(allPanel.classList.contains('is-parked')).toBe(false);
		expect(all.note('a.md').nextElementSibling).toBe(allPanel);

		// …and a tap on a LANDING's control opens the panel under THAT row, which is
		// what it describes.
		const landing = all.rows()[0];
		tap(landing);
		expect(landing.classList.contains('is-selected')).toBe(true);
		expect(allPanel.classList.contains('is-parked')).toBe(false);
		expect(landing.nextElementSibling).toBe(allPanel);
		expect(all.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');

		// a second tap on the same control puts it away again
		tap(landing);
		expect(allPanel.classList.contains('is-parked')).toBe(true);
	});

	it('leaves room under the tapped row for the panel it opens there', () => {
		// The panel hangs below its row, and it is taller than the list: bringing the
		// PANEL into view whole pushed the row — the only thing left to tap — off the top
		// (the phone report above). So the list moves just far enough to leave the panel's
		// pinned top under the row (see LandingPanel.reveal / PANEL_PEEK), and no further.
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const listEl = h.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		// jsdom has no layout: a 300px list, and a.md's row (the third) sitting 240px down
		// it — flush against the foot, with nowhere for a panel to open.
		const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect;
		vi.spyOn(listEl, 'getBoundingClientRect').mockReturnValue(rect(0, 300));
		const rows = h.notes();
		[20, 120, 200].forEach((top, i) =>
			vi.spyOn(rows[i], 'getBoundingClientRect').mockReturnValue(rect(top, 40)));

		// a row with room under it leaves the list where the reader put it
		tap(rows[0]);
		expect(listEl.scrollTop).toBe(0);

		// …and one at the foot is moved up by exactly what the panel needs
		tap(rows[2]);
		expect(listEl.scrollTop).toBe(40); // 240 (the row's foot) − (300 − 100)
	});

	it('never scrolls the note\'s own name out of the list to make room for the panel', () => {
		// The note's own row is the handle the panel is put away with (a second tap on the
		// landing that opened it, or on the note itself), and a phone reported the name
		// going out of sight the moment a landing's panel opened under it: the list
		// scrolled to show the panel's head and took the name along. The scroll now stops
		// when the note's own row reaches the top of the list, however much of the head is
		// still below the fold — and the landing that was picked sits under that row, so it
		// stays in sight with it (see LandingPanel.reveal / NavHistoryList.noteRowOf).
		const h = harnessAll(SPREAD(), 2, SPREAD_FILES, [], {}, {}, true);
		const listEl = h.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect;
		// jsdom has no layout: a 300px list, the note's own row 20px down it, and its
		// places — the one whose control is used at the very foot.
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
			if (this === listEl)
				return rect(0, 300);
			if (this.classList.contains('is-place'))
				return this.querySelector('.nav-row-line')?.textContent === 'L36' ? rect(260, 30) : rect(250, 30);
			if (this.querySelector('.nav-row-name')?.textContent === 'a.md')
				return rect(20, 30);
			return rect(0, 0);
		});

		tap(h.place('L36')); // point at the place at the foot of the list

		// The head wants 90px (290 − (300 − 100)); the note's own row allows 20.
		expect(listEl.scrollTop).toBe(20);
		expect(h.note('a.md').getBoundingClientRect().top - listEl.scrollTop).toBe(0);
	});

	it('pins the note\'s own row while its panel is scrolled past, so a tap can put it away', () => {
		// Inline the row above the panel IS the handle — one tap opens a note and a second
		// closes it again (see NavHistoryList.onClick) — and the panel hangs in the list's own
		// scroll: reading a long note scrolled the row off the top, which is what a phone
		// reported as "the name is gone and I cannot tap it any more". The row sticks to the
		// top while its panel is still on screen, and drops back into its slot once the panel
		// has gone by (see LandingPanel.sync).
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const listEl = h.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect;
		// jsdom has no layout: a 300px list, the row, and the panel hanging under it with an
		// 8px gap — so the panel's own top reaches the list's top 8px after the row's does.
		let panelTop = 120;
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
			if (this === listEl)
				return rect(0, 300);
			if (this.classList.contains('position-restore-nav-preview'))
				return rect(panelTop, 600);
			if (this.querySelector('.nav-row-name')?.textContent === 'b.md')
				return rect(panelTop - 38, 30);
			return rect(0, 0);
		});

		tap(h.note('b.md'));
		const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		const row = h.note('b.md');
		expect(row.classList.contains('is-stuck')).toBe(false);
		expect(panel.classList.contains('is-row-pinned')).toBe(false);
		// the block under the row starts at the row's own foot (the height it carries)
		expect(panel.style.getPropertyValue('--nav-pin-row')).toBe('30px');

		// the reader scrolls on: the row's slot leaves the top, and the row comes back to it
		panelTop = -120;
		listEl.dispatchEvent(new Event('scroll'));
		expect(row.classList.contains('is-stuck')).toBe(true);
		expect(panel.classList.contains('is-row-pinned')).toBe(true);
		expect(row.querySelector('.nav-row-name')?.textContent).toBe('b.md');

		// …and once the whole panel has gone by, the row goes back into its slot rather than
		// hanging over rows that have nothing to do with it
		panelTop = -700;
		listEl.dispatchEvent(new Event('scroll'));
		expect(row.classList.contains('is-stuck')).toBe(false);
		expect(panel.classList.contains('is-row-pinned')).toBe(false);

		// the pinned row is the same handle it always was: the tap that put the panel there
		// takes it away again, and the pin goes with it
		panelTop = -120;
		listEl.dispatchEvent(new Event('scroll'));
		expect(row.classList.contains('is-stuck')).toBe(true);
		tap(row);
		expect(panel.classList.contains('is-parked')).toBe(true);
		expect(row.classList.contains('is-stuck')).toBe(false);
		expect(panel.classList.contains('is-row-pinned')).toBe(false);

		// The drawer needs none of it: the panel is a column of its own there, and no scroll
		// of the list beside it can take a row out from under the panel.
		const drawer = harness(entries(), 2, files);
		drawer.point(drawer.note('b.md'));
		const beside = drawer.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		vi.spyOn(beside, 'getBoundingClientRect').mockReturnValue(rect(0, 300));
		vi.spyOn(drawer.note('b.md'), 'getBoundingClientRect').mockReturnValue(rect(-90, 30));
		beside.dispatchEvent(new Event('scroll'));
		expect(drawer.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
		expect(drawer.el.querySelectorAll('.is-stuck')).toHaveLength(0);
		expect(
			drawer.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-row-pinned'),
		).toBe(false);
	});

	it('comes back to the row a tap put the panel away from', () => {
		// A tap on the note's row is what closes a preview on touch, and the panel had the
		// row pinned because the reader was deep inside the note (see the test above). What
		// the panel's going away leaves behind is the middle of a note that is no longer on
		// screen: the row that was just tapped comes back to the top of the list instead, and
		// nothing moves when the row was in sight all along.
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const listEl = h.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect;
		let rowTop = 120;
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
			if (this === listEl)
				return rect(0, 300);
			if (this.querySelector('.nav-row-name')?.textContent === 'b.md')
				return rect(rowTop, 30);
			return rect(0, 0);
		});

		// the row is in sight when it is tapped, both ways: the list stays where the reader put it
		tap(h.note('b.md'));
		expect(h.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(false);
		expect(listEl.scrollTop).toBe(0);
		tap(h.note('b.md'));
		expect(listEl.scrollTop).toBe(0);

		// …and the reader scrolled on before tapping it: the list comes back to the row — 240px
		// of it — rather than staying on whatever the panel had scrolled away from
		tap(h.note('b.md'));
		rowTop = -240;
		listEl.scrollTop = 500;
		tap(h.note('b.md'));
		expect(listEl.scrollTop).toBe(260); // 500 − 240: the row's own distance above the top
	});

	it('pins the dialog so the LIST is the only scroller, however short the history', () => {
		// The panel opens inside the list's scroll, so a dialog that sizes to its content
		// hands the scrolling to the DIALOG as soon as a panel opens — and a scroll there
		// drags the whole list, the row that was just tapped included, up out of the
		// dialog. Pinned, the list is the one scroller there is (see
		// NavHistoryModal.applyPresentation).
		const short = harness(entries(), 2, files, [], {}, {}, true);
		expect(short.modal.modalEl.classList.contains('is-fixed')).toBe(true);

		// …while a pointing device keeps the old rule: a full-height box around a
		// three-entry history is mostly dead space
		const desktop = harness(entries(), 2, files);
		expect(desktop.modal.modalEl.classList.contains('is-fixed')).toBe(false);
	});

	it('puts the landing on screen without scrolling the list it shares', async () => {
		// The content's own reveal — centring the landing, which is how a landing that
		// cannot carry the ==…== mark in its source (a heading, a list item, a quote) and
		// the whole-note view are put on screen at all (see markdown.ts revealLanding) —
		// walks up to the nearest scroller. Inline that scroller is the LIST the rows are
		// in, so it scrolled the note's own row — the file name, the one handle a finger
		// has on closing the note — out of the list, and only for those landings: which is
		// the "sometimes it pushes the file name away" a phone reported. Inline the mark
		// is written and the list is left where the reader put it.
		const heading = ['# 面板设计', '## 呈现方案', '正文', '### 预览'];
		const files = { 'a.md': heading.join('\n'), 'b.md': '' };
		const entries = [visit('a.md', NOW - MINUTE, captured(heading, 3)), visit('b.md', NOW)];
		const centered: Element[] = [];
		vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
			this: Element, arg?: boolean | ScrollIntoViewOptions,
		) {
			if (typeof arg === 'object' && arg?.block === 'center')
				centered.push(this);
		});

		const touch = harness(entries, 1, files, [], {}, {}, true);
		tap(touch.note('a.md'));
		await vi.waitFor(() => {
			expect(touch.content()?.querySelector('.nav-preview-landing')).not.toBeNull();
		});
		expect(centered).toEqual([]);

		// …the drawer, by contrast, centres it inside its own column: there the scroller
		// the reveal walks up to is the panel's, and the rows are not in it
		const drawer = harness(entries, 1, files);
		drawer.point(drawer.note('a.md'));
		await vi.waitFor(() => {
			expect(centered).toHaveLength(1);
		});
		expect(centered[0]).toBe(drawer.content()?.querySelector('.nav-preview-landing'));
	});

	it('parks the panel again when the filter takes its row away', () => {
		const h = harness(entries(), 2, files, [], {}, {}, true);

		tap(h.note('b.md'));
		const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		expect(panel.classList.contains('is-parked')).toBe(false);

		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		input.value = 'nothing-like-this';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(0);
		expect(panel.classList.contains('is-parked')).toBe(true);
		expect(panel.parentElement?.className).toBe('position-restore-nav-body');
	});

	it('lets a pointing device open the file from the row itself, in one click', () => {
		// The row is not a touch affordance: a mouse gets the same one click, and it is
		// the whole journey — one press, one destination, and the panel has nothing to
		// do with it (see NavHistoryList.onClick).
		const h = harness(entries(), 2, files);

		h.clickRow(h.note('b.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('travels on a right-click, with no menu to confirm it in', () => {
		const h = harness(entries(), 2, files);

		h.rightClick(h.note('b.md'));

		// The gesture IS the decision: the menu that used to hold a single "jump
		// here" item put a second click between the reader and where they had already
		// said they were going (see NavHistoryList.onContextMenu) — and the row's own
		// click is the visible way to say the same thing.
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('sizes the gutter control itself, in pixels, for a finger', () => {
		// An `em` follows the reader's font, and a target must not: on a tablet the same
		// small UI font left the one control the hint names as "very small, like a dot"
		// (see TOUCH_ARROW_PX). The size is set on the glyph, so a stylesheet that
		// arrived a version behind it cannot shrink it back.
		const touch = harness(entries(), 2, files, [], {}, {}, true);
		const glyph = touch.note('b.md').querySelector<SVGElement>('.nav-row-disclose svg')!;
		expect(glyph.style.width).toBe('20px');
		expect(glyph.style.height).toBe('20px');

		// …and the box it lives in has no padding, on every device: the app pads every
		// button a tablet has (`.is-tablet button:not(.clickable-icon)`, 4px 20px), and
		// inside this 30px box that padding squeezed the glyph to nothing — an empty
		// gutter on the tablet, the control on the phone and the desktop (see
		// NavHistoryList.disclose and styles.css).
		expect(touch.note('b.md').querySelector<HTMLElement>('.nav-row-disclose')!.style.padding).toBe('0px');

		// A pointer's arrow keeps the panel's own measure — the stylesheet's, which
		// follows a desktop reader's font down as well as up.
		const pointer = harness(entries(), 2, files);
		const desktop = pointer.note('b.md').querySelector<SVGElement>('.nav-row-disclose svg')!;
		expect(desktop.style.width).toBe('');
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

		// The right button still travels, from the same row: the whole gesture is
		// the distinction, not the event.
		h.rightClick(row);
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
		const hint = h.el.querySelector<HTMLElement>('.position-restore-nav-hint')!;

		// The sentence is the locale's own with the placeholder left out, and the arrow
		// it names is DRAWN in the line: a hint that tells a reader to use the arrow has
		// to show the icon the rows carry, not a text stand-in of another shape (see
		// NavHistoryBrowser.hint).
		expect(hint.textContent).toBe(t('navHistory.touchHint').replace('{arrow}', ''));
		expect(hint.querySelector('.nav-hint-icon svg')?.getAttribute('data-icon')).toBe('chevron-right');
	});

	it('keeps the click wording on a pointing device, with the arrow it names', () => {
		const h = harness(entries(), 2, files);
		const hint = h.el.querySelector<HTMLElement>('.position-restore-nav-hint')!;

		// A finger is told "tap" and a mouse "click", and both sentences name the row's
		// own arrow — so both draw it (see NavHistoryBrowser.hint). There is no
		// keyboard-only wording left: the keys still work, but what the line has to
		// teach a hand is the one click.
		expect(hint.textContent).toBe(t('navHistory.clickHint').replace('{arrow}', ''));
		expect(hint.querySelector('.nav-hint-icon svg')?.getAttribute('data-icon')).toBe('chevron-right');
		expect(h.el.querySelector('.position-restore-nav-here')).toBeNull();
	});
});

describe('NavHistoryModal — a touch screen with room for two columns', () => {
	// A phone held sideways, or a tablet: the panel has somewhere to stand, so it stops
	// opening inside the list (see NavHistoryModal.inline / DRAWER_MIN_WIDTH). jsdom has
	// no matchMedia at all — it has no layout to answer with — so the window's width
	// query is supplied here, and flipped the way a rotation flips the real one.
	function widthQuery(wide: boolean) {
		const listeners = new Set<() => void>();
		let matches = wide;
		const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
		window.matchMedia = ((query: string) => ({
			matches, media: query, onchange: null,
			addEventListener: (_: string, cb: () => void) => { listeners.add(cb); },
			removeEventListener: (_: string, cb: () => void) => { listeners.delete(cb); },
			addListener: (cb: () => void) => { listeners.add(cb); },
			removeListener: (cb: () => void) => { listeners.delete(cb); },
			dispatchEvent: () => false,
		})) as unknown as typeof window.matchMedia;
		return {
			rotate(next: boolean) {
				matches = next;
				for (const cb of [...listeners])
					cb();
			},
			restore() {
				if (original)
					Object.defineProperty(window, 'matchMedia', original);
				else
					delete (window as { matchMedia?: unknown }).matchMedia;
			},
		};
	}

	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const entries = () => [
		visit('a.md', NOW - 5 * MINUTE, { scroll: 40 }),
		visit('b.md', NOW - 2 * MINUTE, { scroll: 80 }),
		visit('c.md', NOW, { scroll: 120 }),
	];
	// What a tap lands ON tells a row's two halves apart: the row opens the file, and
	// the control in its gutter asks the panel about it (see NavHistoryList) — and
	// what this suite is about is the second.
	const tap = (el: HTMLElement) => {
		const control = el.querySelector<HTMLElement>('.nav-row-disclose');
		(control ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
	};

	it('stands the panel beside the list, and follows the window when it turns upright', () => {
		const width = widthQuery(true);
		try {
			const h = harness(entries(), 2, files, [], {}, {}, true);

			// still a finger's device: a tap is the only way to point…
			expect(h.modal.modalEl.classList.contains('is-touch')).toBe(true);
			// …but the panel is the drawer — the body's second column, describing "where I
			// am" until a row is tapped, exactly as it does under a pointer
			expect(h.modal.modalEl.classList.contains('is-inline')).toBe(false);
			// …and with the panel in a column of its own, the height pin is back to the
			// pointer's rule: a short history does not need a full-height dialog
			expect(h.modal.modalEl.classList.contains('is-fixed')).toBe(false);
			const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
			expect(panel.classList.contains('is-parked')).toBe(false);
			expect(panel.parentElement?.className).toContain('position-restore-nav-body');
			expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('c.md');

			// a tap points the panel at the row, and the panel stays in its own column:
			// nothing opens inside the list
			tap(h.note('b.md'));
			expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
			expect(panel.parentElement?.className).toContain('position-restore-nav-body');
			expect(h.note('b.md').nextElementSibling?.className).not.toContain('position-restore-nav-preview');

			// turning it upright is a change of presentation, not of device: the panel
			// moves into the list under the row it describes (see watchWidth)
			width.rotate(false);
			expect(h.modal.modalEl.classList.contains('is-inline')).toBe(true);
			expect(panel.parentElement?.className).not.toContain('position-restore-nav-body');
			expect(panel.classList.contains('is-parked')).toBe(false);
			expect(h.note('b.md').nextElementSibling).toBe(panel);

			// …and a click on the row opens it wherever the panel stands. LAST, because
			// opening closes the dialog — and with it the width listener (see onClose).
			h.clickRow(h.note('b.md'));
			expect(h.jumpTo).toHaveBeenCalledWith(1);
		} finally {
			width.restore();
		}
	});
});

describe('NavHistoryModal — the landing drawer', () => {
	// a.md's capture lands on line 4 of a known document; b.md is the current
	// entry, and c.md holds a landing with no recorded block at all.
	const doc = ['one', 'two', 'three', 'LANDING', 'five', 'six', 'seven', 'eight'];
	const read = { 'a.md': doc.join('\n'), 'b.md': '', 'c.md': 'x' };
	const captured = (path: string, landing: number, agoMin: number) =>
		visit(path, NOW - agoMin * MINUTE, {
			scroll: landing,
			context: doc.map((text, line) => ({ line, text })),
			contextAt: landing,
			lineCount: doc.length,
		});
	const at = () => [
		captured('a.md', 3, 3),
		visit('c.md', NOW - 2 * MINUTE),
		visit('b.md', NOW),
	];

	it('opens on "where I am", before anything is pointed at', () => {
		// The current entry has no block of its own here, so the drawer says so
		// rather than sitting blank — the column is always answering something.
		const h = harness(at(), 2, read);
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.none'));
	});

	it('answers for whatever row was clicked, block and all', () => {
		const h = harness(at(), 2, read);

		// a.md holds ONE place, so its note row IS that place's row: the tap goes on the
		// row's gutter control.
		h.point(h.note('a.md'));

		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		// the recorded block as markdown, landing marked — drawn by the renderer
		// the reading view uses, not printed as the capture stored it
		expect(h.source()).toBe(doc.map(line => (line === 'LANDING' ? '==LANDING==' : line)).join('\n'));
		expect(h.marks()).toEqual(['LANDING']);
		// nothing was read: the block is what the entry recorded
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('describes the spot a click points at, on the note row or on a landing row', () => {
		// A click on a note's row is a click on the NOTE (see NavHistoryList.onClick):
		// it describes the landing that row STANDS FOR — its newest spot — so someone
		// hunting for a spot in that note is never
		// left reading the column's previous subject, another note's lines. A landing's
		// own row describes itself.
		const h = harnessAll([
			visit('x.md', NOW - 3 * MINUTE, { scroll: 100 }),
			visit('x.md', NOW - 2 * MINUTE, { scroll: 412 }),
			visit('y.md', NOW),
		], 2, { 'x.md': '', 'y.md': '' });
		const described = () => h.el.querySelector('.position-restore-nav-preview .nav-row-line')?.textContent;
		// nothing clicked: the column answers "where I am", which is y.md here
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('y.md');

		h.point(h.note('x.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('x.md');
		expect(described()).toBe('L413'); // its NEWEST landing, the one the row stands for

		// …and from there the reader reads the note one landing at a time: the spot a
		// click lands on is the spot the column describes.
		h.point(h.rows()[0]); // the older landing, L101
		expect(described()).toBe('L101');
		h.point(h.rows()[1]); // …and back to the newer one
		expect(described()).toBe('L413');
	});

	it('marks the row the drawer is describing, so the two sides pair up', () => {
		// The column and the row are one thing seen twice. Without the mark, the
		// note's name was the only line tying them together — read once on the left
		// and again on the right to be sure which note the lines belong to.
		const h = harness(at(), 2, read);
		const marked = () => h.el.querySelectorAll('.is-previewed');

		// Nothing has been pointed at yet: the drawer answers for "here", and the list
		// marks the row it is answering about — the note's own row, which stands for
		// that one spot (a.md and b.md hold one landing each, which is not a list of
		// its own: see NavHistoryList.printsLandings).
		expect([...marked()].map(el => el.querySelector('.nav-row-name')?.textContent))
			.toEqual(['b.md']);

		h.point(h.note('a.md'));
		expect([...marked()].map(el => el.querySelector('.nav-row-name')?.textContent))
			.toEqual(['a.md']);
	});

	it('marks the landing row the panel describes, and the note row where none is printed', () => {
		// What the column describes is a LANDING, so that is the row the mark belongs
		// on as soon as it has one — the note's row then goes back to being just the
		// note.
		const entries = () => [
			visit('x.md', NOW - 3 * MINUTE, { scroll: 100 }),
			visit('x.md', NOW - 2 * MINUTE, { scroll: 412 }),
			visit('y.md', NOW),
		];
		const h = harnessAll(entries(), 2, { 'x.md': '', 'y.md': '' });

		h.point(h.rows()[1]);

		expect(h.rows()[1].classList.contains('is-previewed')).toBe(true);
		expect(h.note('x.md').classList.contains('is-previewed')).toBe(false);
		expect(h.el.querySelectorAll('.is-previewed')).toHaveLength(1);

		// …and where the list prints no landing rows at all (the default: one row per
		// note) the NOTE's row is what stands in for the spot the column describes.
		const one = harness(entries(), 2, { 'x.md': '', 'y.md': '' });
		one.point(one.note('x.md'));
		expect(one.note('x.md').classList.contains('is-previewed')).toBe(true);
		expect(one.el.querySelectorAll('.is-previewed')).toHaveLength(1);
	});

	it('keeps the note row on its NEWEST landing, whatever was read below it', () => {
		// The rows under a note run in LINE order, so "the first one" is not the spot
		// the reader was reading — but the note's own row is not a memory of where the
		// reader last LOOKED: it is the note's newest step, always. Reading a landing's
		// details (or walking past it with the arrows) moves the description and nothing
		// else; the note's row still opens the last spot the reader was at in that note.
		const h = harnessAll([
			visit('x.md', NOW - 3 * MINUTE, { scroll: 100 }),
			visit('x.md', NOW - 2 * MINUTE, { scroll: 412 }),
			visit('y.md', NOW),
		], 2, { 'x.md': '', 'y.md': '' });
		const drawer = () => h.el.querySelector('.position-restore-nav-preview .nav-row-line')?.textContent;

		h.point(h.note('x.md')); // the note stands for its NEWEST landing
		expect(drawer()).toBe('L413');

		h.point(h.rows()[0]); // the reader reads the OTHER landing (the top of the note)
		expect(drawer()).toBe('L101');

		h.point(h.note('x.md')); // …and the note's own row is back on its newest landing
		expect(drawer()).toBe('L413');

		// …which is also where its own click goes: the spot read below never becomes
		// the note's destination (see NavHistoryList.activeRep).
		h.clickRow(h.note('x.md'));
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('stays on the spot that was clicked when nothing is pointed at any more', () => {
		// A second click on the row the position is on puts the position away with it
		// (see NavHistoryList.onClick), and the reader may then move the pointer off the
		// list: with neither, the drawer used to fall back to "where I am" — an
		// unrelated note the reader was not working with.
		const h = harnessAll([
			visit('x.md', NOW - 3 * MINUTE, { scroll: 100 }),
			visit('x.md', NOW - 2 * MINUTE, { scroll: 412 }),
			visit('y.md', NOW),
		], 2, { 'x.md': '', 'y.md': '' });

		h.point(h.rows()[0]); // the reader is reading L101
		h.point(h.rows()[0]); // …and puts the position away again

		h.el.querySelector<HTMLElement>('.position-restore-nav-list')!
			.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); // off every row, and irrelevant

		expect(h.el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('x.md');
		expect(h.el.querySelector('.position-restore-nav-preview .nav-row-line')?.textContent).toBe('L101');
	});

	it('moves ONE position, which a click and the keyboard share', () => {
		// A click is not a preview of its own: it moves THE position — the row the
		// drawer describes and Enter travels to (see NavHistoryList.choose) — so the
		// mouse and the arrow keys can never disagree about where the reader is.
		const h = harness(at(), 2, read);
		h.point(h.note('a.md')); // the gutter control: the position becomes a.md's row (a.md holds one spot)
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');

		h.point(h.note('b.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
		expect(h.note('b.md').classList.contains('is-selected')).toBe(true);
		expect(h.note('a.md').classList.contains('is-selected')).toBe(false);

		// A pointer over the list's own padding, or over a row: it chooses nothing, so
		// the position stays where the click left it, and so does the drawer.
		h.el.querySelector<HTMLElement>('.position-restore-nav-list')!
			.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
		expect(h.note('b.md').classList.contains('is-selected')).toBe(true);

		// …and Enter travels to the very row the position is on — the row of the spot
		// the reader is ALREADY standing in included: b.md is the current entry and its
		// one spot is "here", and the list opens it all the same (the jump re-lands the
		// place rather than pushing it again; see NavHistoryList.targetOf).
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(2);

		// …and a row that leads somewhere else travels from the same position: c.md.
		h.point(h.note('c.md'));
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('c.md');
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(1);
	});

	it('describes where the reader is standing when nothing has been pointed at', () => {
		const h = harness(at(), 2, read);
		// Nothing clicked: the drawer says where the reader is.
		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('b.md');
		expect(h.el.querySelector('.position-restore-nav-preview')?.classList.contains('is-parked')).toBe(false);
	});

	it('carries the full heading chain and the recorded coordinate', () => {
		const headings = {
			'a.md': [
				{ heading: '面板设计', level: 1, position: { start: { line: 0 } } },
				{ heading: '呈现方案', level: 2, position: { start: { line: 2 } } },
			],
		};
		const h = harness(at(), 2, read, [], {}, headings);
		h.point(h.note('a.md'));

		expect(h.el.querySelector('.nav-preview-trail')?.textContent).toBe('面板设计›呈现方案');
		expect(h.el.querySelector('.nav-preview-head .nav-row-line')?.textContent).toBe('L4 / 8');
	});

	it('says a note is gone while still printing what stood there', () => {
		const h = harness(at(), 2, read, ['a.md'], {}, {});
		h.point(h.note('a.md'));

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.gone'));
		expect(h.marks()).toEqual(['LANDING']);
		// no way to travel there, and no whole note to ask for either
		expect(h.el.querySelector('.nav-preview-go')).toBeNull();
		expect(h.el.querySelector('.nav-preview-modes')).toBeNull();
	});

	it('leaves the note row itself undescribed as a landing of its own', () => {
		// Clicking a NOTE row describes the landing it stands for — the first of
		// its landings, which for a one-landing note is the only one (the row is
		// what the reader is on) — and never an empty panel.
		const h = harness(at(), 2, read);
		h.point(h.note('a.md'));

		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		expect(h.content()?.textContent).toContain('LANDING');
	});
});

describe('NavHistoryModal — the drawer under a capture window', () => {
	// What the capture records is a WINDOW of lines around the landing, not a
	// document: it starts inside the properties, or in the middle of a table, or
	// on a file that is not markdown at all. What the drawer is handed must
	// already be repaired (see markdown.ts) — these pin the two ends of that: the
	// browser tells it where the frontmatter ends, and it tells the renderer that
	// a .base file is not prose.
	it('keeps a recorded block that starts inside the properties out of them', async () => {
		const entry = visit('a.md', NOW - MINUTE, {
			scroll: 12,
			context: [
				{ line: 10, text: 'aliases: 卡片盒' },
				{ line: 11, text: '---' },
				{ line: 12, text: '# 标题' },
			],
			contextAt: 2,
			mtime: 1000,
		});
		const h = harness([entry, visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' }, [], {}, {
			'a.md': { frontmatterPosition: { start: { line: 0 }, end: { line: 11 } } },
		});

		h.point(h.note('a.md'));

		// The YAML and the `---` that closed it are gone: neither is a spot the
		// reader could recognize.
		expect(h.source()).toBe('# 标题');
		// …and the landing is still marked, on the RENDERED heading: an inline
		// `==…==` in front of a `#` would have stopped it being a heading at all
		// and shown the reader the note's source (see landingMarkedInSource). The
		// mark is the block-level one the whole-note view uses, not a `mark`
		// element — there is no `==…==` in the source any more.
		await vi.waitFor(() => {
			expect(h.content()?.querySelector('h1')?.classList.contains('nav-preview-landing')).toBe(true);
		});
		expect(h.marks()).toEqual([]);
	});

	it('renders a .base file from its own source, never as prose', async () => {
		// The realistic entry: a capture of a Bases file records no markdown lines
		// at all (there is no editor to take them from), and the file is YAML — run
		// through the markdown renderer it is a paragraph of punctuation with
		// structure invented around it. So it is shown as what it is.
		const base = visit('数据库/读书.base', NOW - MINUTE, { scroll: 1 });
		const h = harness([base, visit('b.md', NOW)], 1, { '数据库/读书.base': 'filters:\n- file', 'b.md': '' });

		h.point(h.note('读书.base'));

		await vi.waitFor(() => expect(h.source()).toBe('```yaml\nfilters:\n- file\n```'));
		// one view, not a choice: there is no recorded spot to set against the note
		expect(h.el.querySelector('.nav-preview-modes')).toBeNull();
		expect(h.el.querySelector('.nav-preview-caption')?.textContent).toBe(t('navHistory.preview.source'));
		// …and no "nothing here" either: this IS the preview of that file
		expect(h.el.querySelector('.nav-preview-note')).toBeNull();
		expect(h.cachedRead).toHaveBeenCalledTimes(1);
	});

	it('says a PDF has nothing to show, without reading it to find that out', () => {
		// Decoded into a string a PDF is a wall of replacement characters, and a
		// 40 MB one costs a read to learn it. The extension is what says so. The
		// travel button is the one thing left to do about it, and the message names
		// it rather than leaving the reader to guess.
		const pdf = visit('论文/attention.pdf', NOW - MINUTE, { scroll: 3 });
		const h = harness([pdf, visit('b.md', NOW)], 1, { '论文/attention.pdf': '%PDF-1.4', 'b.md': '' });

		h.point(h.note('attention.pdf'));

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.binary'));
		// The message names the way out, and the way out is the row's own click — the
		// panel has no button of its own any more (see NavHistoryList.onClick /
		// LandingPanel.caption) — while the gutter control is what asked about it. The
		// PDF itself is never read to find out what it is.
		expect(h.note('attention.pdf').querySelector('.nav-row-disclose')).not.toBeNull();
		expect(h.cachedRead).not.toHaveBeenCalled();
	});
});

describe('NavHistoryModal — the drawer\'s controls', () => {
	const read = { 'a.md': 'one line', 'b.md': '' };
	const entry = () => [
		visit('a.md', NOW - MINUTE, { scroll: 3, context: [{ line: 3, text: '落点' }], contextAt: 0 }),
		visit('b.md', NOW),
	];

	it('keeps the caption in the pinned half, above the lines', () => {
		// What the caption carries is the one thing the content cannot say about
		// itself: which recorded lines these are. WHICH of the two contents is shown
		// is a setting now, chosen in the toolbar's gear (see
		// NavHistoryBrowser.openSettings), so there is no switch here to say it a
		// second time on every row — and the panel carries no travel button either:
		// the row's own click is what opens the file.
		const h = harness(entry(), 1, read);
		h.point(h.note('a.md'));

		const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		const row = panel.querySelector<HTMLElement>('.nav-preview-caption-row')!;
		const content = panel.querySelector<HTMLElement>('.nav-preview-content-host')!;
		expect(row.querySelector('.nav-preview-caption')?.textContent).toContain('L4');
		expect(panel.querySelector('.nav-preview-modes')).toBeNull();
		expect(panel.querySelector('.nav-preview-go')).toBeNull();
		// document order, which is what "above" means once the CSS is applied
		expect(row.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// …and nothing is left hanging under the lines: the content host is the
		// last thing in the block that scrolls
		const scroll = panel.querySelector<HTMLElement>('.nav-preview-scroll')!;
		expect(scroll.lastElementChild).toBe(content);
	});

	it('keeps the head its full shape for an entry that has nothing for it', () => {
		// The keyboard walks the list while the reader reads this column: a name, a
		// line of small print, a section line and a caption line are drawn for EVERY
		// entry — including a deleted note, which has no section, no pane and no type.
		// A block that is a line shorter for some rows makes every line under it jump
		// (the heights are pinned in styles.css; what is pinned here is that the
		// elements are always there to be pinned).
		const h = harness(entry(), 1, { 'b.md': '' }, ['a.md']);
		h.point(h.note('a.md'));

		const top = h.el.querySelector<HTMLElement>('.nav-preview-top')!;
		for (const what of ['.nav-preview-head', '.nav-preview-meta', '.nav-preview-trail'])
			expect(top.querySelector(what)).not.toBeNull();
		// empty, and that is the point: nothing to say about a file the vault no
		// longer has, and no line for the content below to move by
		expect(top.querySelector('.nav-preview-trail')?.textContent).toBe('');
		// …and the caption line still names the recorded lines the block behind it
		// covers, which is the only thing left to say about a note that is gone
		expect(top.querySelector('.nav-preview-caption')?.textContent).toContain('L4');
	});

	it('keeps the name, the section and the caption OUT of the scroller', () => {
		// The panel is two blocks (see LandingPanel.draw): what the spot IS — the
		// note, its section, the small print and the caption — and the lines. Only the
		// second one scrolls. A whole note is thousands of lines long, and the reader
		// who has scrolled into it must still be able to see which note it is, which
		// section the spot was in, and which lines the block covers.
		const h = harness(entry(), 1, read, [], {}, {
			'a.md': [{ heading: '章节', level: 1, position: { start: { line: 0 } } }],
		});
		h.point(h.note('a.md'));

		const panel = h.el.querySelector<HTMLElement>('.position-restore-nav-preview')!;
		const scroll = panel.querySelector<HTMLElement>('.nav-preview-scroll')!;
		const top = panel.querySelector<HTMLElement>('.nav-preview-top')!;

		// two blocks, and the whole panel is one of them
		expect([...panel.children].map(el => el.className)).toEqual(['nav-preview-top', 'nav-preview-scroll']);
		for (const what of ['.nav-preview-head', '.nav-preview-trail', '.nav-preview-caption-row'])
			expect(top.querySelector(what)).not.toBeNull();
		expect(scroll.querySelector('.nav-preview-head')).toBeNull();
		expect(scroll.querySelector('.nav-preview-caption')).toBeNull();
	});

	it('says what the content is only where there is something to say', () => {
		// A file that is not a note has one view — its own source — and says so; a
		// deleted note keeps the recorded range, because there is nothing left to read
		// whole and the recorded block is what stood there; the graph has no note
		// behind it at all, so it has no caption either. The whole-note view says
		// nothing at all: the content IS the note (see LandingPanel.captionText).
		const notANote = harness(
			[visit('a.pdf', NOW - MINUTE, { scroll: 3 }), visit('b.md', NOW)],
			1, { 'a.pdf': '%PDF-1.4', 'b.md': '' },
		);
		notANote.point(notANote.note('a.pdf'));
		expect(notANote.el.querySelector('.nav-preview-caption')?.textContent).toBe(t('navHistory.preview.source'));
		expect(notANote.el.querySelector('.nav-preview-modes')).toBeNull();

		const gone = harness(entry(), 1, { 'b.md': '' }, ['a.md']);
		gone.point(gone.note('a.md'));
		expect(gone.el.querySelector('.nav-preview-caption')?.textContent).toContain('L4');
		expect(gone.el.querySelector('.nav-preview-modes')).toBeNull();

		const view = harness(
			[{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW }] as NavHistoryEntry[],
			0, read,
		);
		expect(view.el.querySelector('.nav-preview-caption-row')).toBeNull();
	});
});

describe('NavHistoryModal — the drawer\'s whole-note view', () => {
	// Two landings of ONE note, plus the current entry. "全文" is the one thing in
	// this panel that claims to show today's file, so it is the one thing that
	// reads one — and it must read it once, not once per clicked row.
	// The note is long enough for its two places to be two ROWS (see SPREAD_DOC):
	// the list folds landings within LANDING_MERGE_LINES of one another, so a
	// fixture whose two steps sit four lines apart is one row.
	const liveLines = [
		'live one', '', 'live two', '', 'live three', '', 'live LANDING', '', 'live five',
		...Array.from({ length: 20 }, (_, i) => `live filler ${i + 1}`), '',
		'live tail',
	];
	const live = liveLines.join('\n');
	const read = { 'a.md': live, 'b.md': '' };
	// The recorded block quotes the note's own words AT its landing: the whole-note
	// view has to find the line again by them, because rendered markdown carries
	// no line numbers.
	const recorded = (line: number, agoMin: number): NavHistoryEntry =>
		visit('a.md', NOW - agoMin * MINUTE, {
			scroll: line,
			context: [
				{ line: line - 1, text: 'recorded above' },
				{ line, text: liveLines[line] },
				{ line: line + 1, text: 'recorded below' },
			],
			contextAt: 1,
			mtime: 1000,
		});
	// a.md L7 (older), a.md L31 (newer), then the current entry — so the note has
	// two places to walk and the drawer has a "here" to open on.
	const at = () => [recorded(6, 3), recorded(30, 2), visit('b.md', NOW)];
	const spot = () => [recorded(6, 3), visit('b.md', NOW)];
	const pickNote = (h: ReturnType<typeof harness>) =>
		h.pickSetting(t('navHistory.preview.note'));

	it('opens on the recorded spot, which is the plugin\'s own default', () => {
		// There is no switch on the panel any more: which of the two contents is
		// shown is a SETTING, chosen in the toolbar's gear (see
		// NavHistoryBrowser.openSettings). The spot is the default — it is what the
		// rows promise, and the only view that still works for a note the history has
		// seen and the vault no longer has.
		const h = harness(spot(), 0, read);

		expect(h.el.querySelector('.nav-preview-modes')).toBeNull();
		expect(h.source()).toBe('recorded above\n==live LANDING==\nrecorded below');
		expect(h.el.querySelector('.nav-preview-caption')?.textContent)
			.toBe(t('navHistory.preview.recorded', 6, 8));
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('shows the note as it stands now, with the landing found and marked in it', async () => {
		const h = harness(spot(), 0, read);

		pickNote(h);

		// the note is READ, so it arrives a moment after the setting is picked — and
		// what arrives is the file as it stands, not the recorded snippet
		await vi.waitFor(() => expect(h.source()).toBe(live));
		// …and there is no caption line at all: the content IS the note, so "this is
		// the note as it stands" would be the same sentence on every row (see
		// LandingPanel.captionText)
		expect(h.el.querySelector('.nav-preview-caption-row')).toBeNull();
		// the recorded line is found by its words and marked as the spot
		await vi.waitFor(() => {
			expect(h.content()?.querySelector('.nav-preview-landing')?.textContent).toBe('live LANDING');
		});
		// …and the recorded lines are not what is on screen any more
		expect(h.content()?.textContent).not.toContain('recorded above');
	});

	it('still lands in the right part of the note when the recorded words are gone', async () => {
		// The ordinary case, not an error: the note was edited, or the recorded
		// line was blank, or it was two characters long. Which words to look for is
		// then a question with no answer — but WHERE the line sat is not, so the
		// whole-note view uses the recorded line's share of the file. Without it
		// "全文" answered "here is the top of your note", which is not where I was.
		const gone = visit('a.md', NOW - MINUTE, {
			scroll: 6,
			// a blank landing line: `recordedLanding` reads no text from it at all
			context: [{ line: 6, text: '' }],
			contextAt: 0,
			mtime: 1000,
		});
		const h = harness([gone, visit('b.md', NOW)], 1, read);

		// jsdom lays nothing out, so every drawer scroller is given the size a real
		// one has — content taller than the box it sits in. The panel rebuilds its
		// elements on every render, so this goes on the prototype rather than on one
		// of them, and it is put back afterwards.
		const proto = Element.prototype as unknown as Record<string, PropertyDescriptor | undefined>;
		const saved = {
			scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
			clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
		};
		const box = (value: number): PropertyDescriptor => ({
			configurable: true,
			get(this: Element) { return this.classList.contains('nav-preview-scroll') ? value : 0; },
		});
		Object.defineProperty(Element.prototype, 'scrollHeight', box(800));
		Object.defineProperty(Element.prototype, 'clientHeight', box(200));
		try {
			// aim the drawer at the entry under test, then ask for the whole note
			h.point(h.note('a.md'));
			pickNote(h);
			await vi.waitFor(() => expect(h.source()).toBe(live));
			// nothing was matched, so nothing is marked…
			expect(h.content()?.querySelector('.nav-preview-landing')).toBeNull();
			// …and the reader is put at L7 of a 31-line file: six thirtieths of the way
			// down the 600px the box can travel
			await vi.waitFor(() => {
				const scroller = h.el.querySelector<HTMLElement>('.nav-preview-scroll')!;
				expect(scroller.scrollTop).toBe(120);
			});
		} finally {
			for (const [name, descriptor] of Object.entries(saved)) {
				if (descriptor)
					Object.defineProperty(Element.prototype, name, descriptor);
				else
					delete proto[name];
			}
		}
	});

	it('draws the note, not the snippet: the two views never blend', async () => {
		const h = harness(spot(), 0, read);
		pickNote(h);
		await vi.waitFor(() => expect(h.source()).not.toContain('recorded above'));

		// …and back: the spot view is the entry's own block again, with no line of
		// today's file in it
		h.pickSetting(t('navHistory.preview.spot'));
		expect(h.source()).toBe('recorded above\n==live LANDING==\nrecorded below');
		expect(h.source()).not.toContain('live five');
	});

	it('reads one note once, however many of its landings are walked', async () => {
		const h = harnessAll(at(), 2, read);
		h.point(h.rows()[0]); // the drawer is on a.md's older place (L7)
		pickNote(h);
		await vi.waitFor(() => expect(h.source()).toBe(live));
		expect(h.cachedRead).toHaveBeenCalledTimes(1);

		h.point(h.rows()[1]); // …and now on its other one (L31)

		expect(h.el.querySelector('.nav-preview-title')?.textContent).toBe('a.md');
		// …and still no caption: the whole-note view never carries one (see
		// LandingPanel.captionText)
		expect(h.el.querySelector('.nav-preview-caption-row')).toBeNull();
		// one note, one read: the rendered DOM is reused and only the mark moves
		expect(h.cachedRead).toHaveBeenCalledTimes(1);
		expect(h.source()).toBe(live);
	});

	it('moves the landing mark with the reader, one mark at a time', async () => {
		const h = harnessAll(at(), 2, read);
		h.point(h.rows()[0]);
		pickNote(h);
		await vi.waitFor(() => {
			expect(h.content()?.querySelector('.nav-preview-landing')?.textContent).toBe('live LANDING');
		});

		// the note's other place, in the same view: the old mark goes with it
		h.point(h.rows()[1]);

		await vi.waitFor(() => {
			expect(h.content()?.querySelectorAll('.nav-preview-landing')).toHaveLength(1);
		});
		expect(h.content()?.querySelector('.nav-preview-landing')?.textContent).toBe('live tail');
	});

	it('falls back to the recorded lines when the note cannot be read', async () => {
		// A note that exists but does not read: the drawer must not go blank, and
		// the recorded block is all there is left. (A DELETED note never gets this
		// far — it is not read at all.)
		const h = harness(spot(), 0, read);
		h.cachedRead.mockResolvedValueOnce('');
		pickNote(h);

		await vi.waitFor(() => {
			expect(h.content()?.textContent).toContain('recorded above');
		});
	});

	it('says so when the note will not read and nothing was recorded either', async () => {
		// Two places of one note, one with a recorded block and one without, and
		// a vault that refuses to read the file: the column has to say something
		// rather than sit empty under its caption.
		const bare = visit('a.md', NOW - 2 * MINUTE, { scroll: 30 });
		const h = harnessAll([recorded(6, 3), bare, visit('b.md', NOW)], 2, read);
		h.cachedRead.mockRejectedValue(new Error('unreadable'));
		h.point(h.rows()[0]); // the place that carries a block
		pickNote(h);
		await vi.waitFor(() => {
			expect(h.content()?.textContent).toContain('recorded above');
		});

		h.point(h.rows()[1]); // the other place, which recorded no block

		await vi.waitFor(() => {
			expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.none'));
		});
		expect(h.content()).toBeNull();
	});

	it('shows a note that is GONE from its recorded lines, whatever the setting says', async () => {
		// The content setting outlives the row it was chosen on. A note the vault no
		// longer has cannot be shown whole, so the panel shows what it recorded and
		// says WHICH lines those are — never "as it stands now".
		const gone = visit('gone.md', NOW - 2 * MINUTE, {
			scroll: 3,
			context: [
				{ line: 2, text: '上一行' },
				{ line: 3, text: '这一行' },
				{ line: 4, text: '下一行' },
			],
			contextAt: 1,
		});
		const h = harness([recorded(6, 3), gone, visit('b.md', NOW)], 2, { ...read, 'gone.md': 'x' }, ['gone.md']);
		h.point(h.note('a.md'));
		pickNote(h);
		await vi.waitFor(() => expect(h.source()).toBe(live));

		h.point(h.note('gone.md'));

		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.gone'));
		await vi.waitFor(() => expect(h.source()).toBe('上一行\n==这一行==\n下一行'));
		// …and the caption comes back with it: those ARE recorded lines, so which ones
		// they are is the one thing there is to say (see LandingPanel.captionText)
		expect(h.el.querySelector('.nav-preview-caption')?.textContent)
			.toBe(t('navHistory.preview.recorded', 3, 5));
		expect(h.el.querySelector('.nav-preview-modes')).toBeNull();
		// …and nothing was read for it: there is no file left to read
		expect(h.cachedRead).toHaveBeenCalledTimes(1);
	});

	it('never offers the whole note for a view step', () => {
		// The graph is not a note: there is nothing to show whole, and the drawer
		// says so — the content setting simply has nothing to act on.
		const h = harness(
			[{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW }] as NavHistoryEntry[],
			0, read,
		);

		expect(h.el.querySelector('.nav-preview-modes')).toBeNull();
		expect(h.el.querySelector('.nav-preview-note')?.textContent).toBe(t('navHistory.preview.none'));
		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('hands the choice to the plugin, so the next dialog opens on it', async () => {
		// The browser is opened, closed and opened again all day: a reader who chose
		// the whole note chose it for their reading, not for this one look — and being
		// put back on the recorded spot every time is a decision they have to make over
		// and over. The choice is the plugin's own PERSISTED preference (see
		// NavBrowserPrefs): the two dialogs below are handed the SAME set, which is
		// what the plugin's settings object is, and the panel keeps no memory of its
		// own that could disagree with it.
		const shared = prefs();
		const first = harness(spot(), 0, read, [], {}, {}, false, [], {}, shared.browser);
		pickNote(first);
		await vi.waitFor(() => expect(first.source()).toBe(live));
		// …which is the write the panel made: the preference itself now says "now".
		expect(shared.state.mode).toBe('note');

		const second = harness(at(), 2, read, [], {}, {}, false, [], {}, shared.browser);
		second.point(second.note('a.md'));

		// the second dialog is on the same choice, and it says so in its gear — the
		// panel has no switch of its own to read the answer off (see
		// NavHistoryBrowser.openSettings)
		await vi.waitFor(() => expect(second.source()).toBe(live));
		second.clickRow(second.el.querySelector<HTMLElement>('.position-restore-nav-settings')!);
		// The LAST group is the panel's content: the details switch opens the menu, then
		// the list's shape, and the content is a question only while the column exists.
		expect(second.el.querySelectorAll('.nav-settings-group')[2]
			.querySelector('.nav-settings-option[aria-checked="true"]')?.textContent)
			.toContain(t('navHistory.preview.note'));
	});
});

