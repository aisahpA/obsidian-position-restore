// DOM-level tests for the recent-files browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the landing panel that describes a row, and
// the search box that is now the toolbar's only control.
// The pure pieces (describe/group/merge/filter/time) are covered in
// nav-history-browser.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keymap, MarkdownView, Platform, TFile } from 'obsidian';

import { RecentFilesModal } from '@/nav-history/browser/modal';
import type { RecentFilesBrowserPrefs } from '@/nav-history/browser/body';
import type { LandingsMode } from '@/nav-history/browser/listing';
import type { PathDisplayMode } from '@/types';
import type { NavHistoryEntry } from '@/nav-history/entry';
import { NAV_CONTEXT_RADIUS } from '@/position/capture/ephemeral';
import { DEFAULT_SETTINGS } from '@/types';
import type { NavEntryState } from '@/types';
import { t } from '@/i18n';
import { TIP_DELAY_MS } from '@/nav-history/browser/constants';

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

const MINUTE = 60_000;
const NOW = Date.now();

// A preference set for one harness (or for two, when a test wants to show that a
// choice made in the settings tab is the choice the next dialog opens on). The
// panel only READS them (see RecentFilesBrowserPrefs) — the values are the plugin's, and
// what changes them is the settings tab — so the fixture is a set of live readers
// over values a test can write, exactly as the settings tab writes them.
function prefs(start: { landings?: LandingsMode; path?: PathDisplayMode; time?: boolean } = {}) {
	const state = {
		landings: 'last' as LandingsMode,
		cap: 200,
		path: 'smart' as PathDisplayMode,
		time: false,
		...start,
	};
	return {
		state,
		browser: {
			landings: () => state.landings,
			// How far back the list reaches (see PluginSettings.navRecentCap).
			placesCap: () => state.cap,
			// How much of a row's path is printed, and on which side of the name (see
			// PathDisplayMode).
			pathDisplay: () => state.path,
			// Whether each row is dated (see RecentFilesBrowserPrefs.rowTime).
			rowTime: () => state.time,
		} satisfies RecentFilesBrowserPrefs,
	};
}

// The plain set a harness gets when a test says nothing: one row per note, with the
// details column on (see prefs).
function defaultPrefs(): RecentFilesBrowserPrefs {
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
	mtimes: Record<string, number> = {},
): ReturnType<typeof harness> {
	return harness(entries, index, files, deleted, live, headingMap, mobile, mtimes,
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

// A note long enough for its places to be MORE than the two headings a few lines
// apart cannot be. Every distinct line is a row of its own now (see NavFileGroup),
// but a landing row is only printed at all when the note holds more than one (see
// RecentFilesList.printsLandings) — so a fixture with two heads three lines apart
// still says something different from one with two heads a section apart: the
// filler is what puts a second section far enough down the note for the suite's
// second place to be a place of its own, under a heading of its own.
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
	// at all (see RecentFilesReads). The text is kept for the fake `cachedRead`, which
	// nothing calls.
	files: Record<string, string> = {},
	// Paths the fixture wants to be RECORDED AND GONE: a place in the history whose file
	// the vault no longer has (see the "a file that is gone" suite). It wins over
	// `files`, so a test can say "this was there, and is not any more".
	deleted: string[] = [],
	// paths held open in an editor: the panel describes a place from the ENTRY it
	// was recorded in and never from a live editor, so nothing here is ever read
	// for the panel. The fake app exposes them anyway, because a fixture that
	// could not show a leaf holding a note would not be the app the browser was
	// written against.
	live: Record<string, string> = {},
	// parsed headings per path, as metadataCache would report them
	headingMap: Record<string, unknown[] | Record<string, unknown>> = {},
	// a touch device. The list answers a click either way (see RecentFilesList), so
	// what this flag decides here is the PRESENTATION — jsdom has no matchMedia to
	// ask, so a touch device is the inline one (see RecentFilesModal.inline) — plus the
	// touch ergonomics: the ×'s target under a finger, and the filter box left
	// unfocused.
	mobile = false,
	// mtimes for the files above, as the vault would report them now: the
	// browser compares them with the mtime an entry recorded.
	mtimes: Record<string, number> = {},
	// The browser's own preferences, as the plugin hands them to a shell (see
	// RecentFilesBrowserPrefs). A test that wants a dialog to open with every landing
	// printed passes its own set here — the same object twice, to show that the
	// choice is not the dialog's — and the default is a fresh one per harness, so
	// tests cannot leak a preference into each other through the settings file.
	browserPrefs: RecentFilesBrowserPrefs = defaultPrefs(),
) {
	// The place list's travel: the panel hands it a place index and the list
	// decides how to go there (a file opens the plain way, a jump lands — see
	// places.ts). The spy keeps its old name so every assertion below reads as
	// what it always asked: "this is the place the row took the reader to".
	const jumpTo = vi.fn(async () => {});
	const cachedRead = vi.fn(async (file: { path: string }) => files[file.path] ?? '');
	// The main root split, with one element per leaf inside it. Nothing walks it
	// any more — the badge that named which live tab held a landing is gone — but
	// the leaves are still where the editors below stand, so the fake app keeps
	// the shape it has always had.
	const rootEl = document.createElement('div');
	document.body.appendChild(rootEl);
	// The metadata reads this harness has answered, and the listeners a `changed`
	// event will reach (see the fake metadataCache below).
	let cacheReads = 0;
	const metaListeners = new Set<(file: { path: string }) => void>();
	const tabs = Object.keys(live).map((path) => ({ leafId: `open:${path}`, path }));
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
			// drawer uses to keep a block out of the properties — and, since the
			// browser also searches a file's aliases, for the frontmatter itself.
			//
			// The reads are COUNTED: the browser memoizes one record per path for the
			// life of a body (see RecentFilesReads), and the count is how a test sees
			// that the memory is doing its job.
			getFileCache: (file: { path: string }) => {
				cacheReads++;
				const cache = headingMap[file.path];
				if (!cache)
					return null;
				return Array.isArray(cache) ? { headings: cache } : cache;
			},
			// The one metadataCache event the browser listens for (see
			// RecentFilesReads): a file's frontmatter changed, so its record — and with
			// it its aliases — is stale. `on` hands back the callback itself as the
			// handle `offref` takes, which is all the browser does with it.
			on: (name: string, cb: (file: { path: string }) => void) => {
				if (name === 'changed')
					metaListeners.add(cb);
				return cb;
			},
			offref: (ref: unknown) => {
				metaListeners.delete(ref as (file: { path: string }) => void);
			},
		},
		workspace: {
			rootSplit: { containerEl: rootEl },
			// The app's own menu event: the browser asks the APP to fill the menu in (see
			// RecentFilesBrowser.contextRow), so what a test can see is the menu object it
			// was handed — which is the whole of what this plugin contributes.
			trigger: vi.fn(),
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
	let modal: RecentFilesModal;
	try {
		modal = new RecentFilesModal(app as never, {
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
	// RecentFilesList.onClick). The place the reader is
	// already in is not exempt: the open re-lands it. Only a deleted note goes nowhere.
	const clickRow = (row: HTMLElement) =>
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// …and the press that a real click is the SECOND half of (see
	// RecentFilesList.onPress). A test drives the two apart only to move the list in
	// between; an ordinary click is a press followed immediately by a click, and the
	// tests that dispatch the click alone are the ones about a programmatic activation
	// (or an assistive technology's), which has no press to remember.
	const pressRow = (row: HTMLElement) =>
		row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
	// The places moved under the panel. What the store does is re-order them IN
	// PLACE — the array the browser reads is the same array, spliced and pushed (see
	// places.remember) — and then tell its listeners. The dialog has no subscription
	// to tell (it is a snapshot that closes on the first travel, see modal.ts), so a
	// test does the move itself and then asks the panel for the redraw the SIDEBAR
	// would have been handed: one `input` event on the filter box, which is the
	// dialog's own way to rebuild its list. The box stays EMPTY, so the list is
	// rebuilt rather than narrowed.
	const filterInput = modal.contentEl.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
	const changed = (rep?: number) => {
		if (rep !== undefined) {
			const [moved] = entries.splice(rep, 1);
			entries.push(moved);
		}
		filterInput.dispatchEvent(new Event('input', { bubbles: true }));
	};
	// …and the muted gestures: a right-click, and a finger's lingering press (a
	// WebView raises the same `contextmenu` for both — see RecentFilesList.onContextMenu).
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
	// is click-only (see RecentFilesList), so a mouse crossing a row chooses nothing,
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
	// The listbox itself — what a row's click bubbles through, and what the browser
	// hands a click to when the row the reader pressed has been rebuilt away.
	const list = () => modal.contentEl.querySelector<HTMLElement>('.position-restore-nav-list')!;
	// WHAT A ROW SAYS ON HOVER. The tooltip is the panel's own element now, drawn on the
	// document rather than in the list (see tip.ts), so a test reads it out of the body
	// — and only after the pointer has RESTED there for the delay, which is what the
	// fake clock below is for. `hover` answers with the element or null, so the
	// assertions read as "hovering this row says…".
	const hover = (el: HTMLElement): HTMLElement | null => {
		el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
		vi.advanceTimersByTime(TIP_DELAY_MS);
		return document.querySelector<HTMLElement>('.position-restore-nav-tip');
	};
	// …and leaving: the pointer was on the row and is now somewhere else.
	const unhover = (el: HTMLElement) => {
		el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
		return document.querySelector<HTMLElement>('.position-restore-nav-tip');
	};
	// A metadata change in the vault: what the app fires when a file's frontmatter is
	// rewritten, and what the browser drops its memory of that path for.
	const changeFile = (path: string) => {
		for (const cb of [...metaListeners])
			cb({ path });
	};
	// The × at the end of the filter box (see RecentFilesBrowser.toolbar). It is in the
	// DOM whether or not the box has anything in it — the stylesheet is what hides it
	// while the box is empty (asserted in the styles suite, since jsdom loads no
	// stylesheet) — so a test clicks it the way a reader does.
	const clearButton = () =>
		modal.contentEl.querySelector<HTMLElement>('.position-restore-nav-clear')!;
	const clearFilter = () => clickRow(clearButton());
	return {
		modal, jumpTo, cachedRead, el: modal.contentEl, entries, list,
		trigger: app.workspace.trigger, cacheReads: () => cacheReads, changeFile,
		rows, notes, note, place, clickRow, pressRow, changed, rightClick, longPress, movePointer,
		key, hover, unhover, clearButton, clearFilter,
	};
}

beforeEach(() => {
	// The app's answers to "where should this open" and "is the modifier down" are
	// inputs a test sets per case (see the stub): one left over from the last case
	// would decide this one.
	Keymap.reset();
	document.body.innerHTML = '';
	// Children (and any class a test left on the body), or one test's DOM leaks
	// into the next.
	document.body.className = '';
	// The tooltip's own clock (see tip.ts): the delay is the one thing a test has to be
	// able to step over, and only the two timer functions are faked — `Date` is left
	// alone, so the ages the fixtures were built with are the ages the rows print.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	// The width query is the one global a test installs (see widthQuery): jsdom has none
	// of its own, and one left behind would decide the panel's presentation for every
	// test after it.
	delete (window as { matchMedia?: unknown }).matchMedia;
	document.body.innerHTML = '';
	document.body.className = '';
});

describe('RecentFilesModal — the dropped-steps footnote', () => {
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

describe('RecentFilesModal — current position', () => {
	it('pins the current note first, with no dot of its own', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		// There is no second "you are here" anywhere: the card that used to stand
		// above the list said the same thing in a second place and a second layout,
		// and the row below is the authoritative one (see RecentFilesModal.render).
		expect(h.el.querySelector('.position-restore-nav-here')).toBeNull();

		// The current note is a row in the list like any other, first — and it carries
		// no ●: the current note is pinned first, so a dot on it could only ever sit on
		// row one, saying what the position already says. The dot is for the LANDING
		// that holds the current entry, which has its note's other rows beside it (see
		// RecentFilesList.placeRow), and no note row here prints landings.
		const notes = h.notes();
		expect(notes).toHaveLength(3);
		expect(notes[0].textContent).toContain('c');
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
		// spot the reader was at in that note (see RecentFilesList.activeRep).
		expect(h.rows()).toHaveLength(0);
		expect(h.note('c').querySelector('.nav-row-here')).toBeNull();

		// …and the row is a destination all the same: a click opens c.md at that very
		// place, because the open re-lands it rather than pushing it again — which is
		// what a reader whose tab was closed is asking for (see RecentFilesList.targetOf).
		h.clickRow(h.note('c'));
		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});

	it('keeps a one-step history a one-row list, and opens that row', () => {
		// The list used to call itself empty when the current entry's note was the only
		// place left on it, and that row answered nothing: the one list a reader with
		// every tab closed ever sees was the one list with no way back in. The row is a
		// destination now (see RecentFilesList.targetOf), so the sentence about having
		// nowhere to go belongs to a query that matched nothing, or to a history whose
		// notes are genuinely gone — never to the spot the reader is standing in.
		const h = harness([visit('only.md', NOW)], 0, { 'only.md': '' });

		expect(h.notes()).toHaveLength(1);
		expect(h.el.querySelector('.position-restore-nav-empty')).toBeNull();

		h.clickRow(h.note('only'));
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
	});

	it('says "no match" only when the query really emptied the list', () => {
		// The sentence is the QUERY's answer and not a verdict on the place the reader
		// is standing in: a filter that matches nothing empties the list, while a filter
		// that keeps only the current note leaves a row that opens like any other (see
		// RecentFilesList.render's refs.some(targetOf) branch).
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' });
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		const search = (q: string) => {
			box.value = q;
			box.dispatchEvent(new Event('input', { bubbles: true }));
		};

		search('zzz');
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('recentFiles.noMatch'));

		search('b.md'); // the current note alone
		expect(h.el.querySelector('.position-restore-nav-empty')).toBeNull();
		h.clickRow(h.note('b'));
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
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
		// …in front of the coordinate it marks, and not laid out inside the box: the
		// dot's place in the DOM is where the eye finds it, and the stylesheet keeps it
		// out of the track so the number itself does not move (see .nav-row-here).
		expect([...places[1].querySelector('.nav-row-pos')!.children].map(el => el.className))
			.toEqual(['nav-row-here', 'nav-row-line']);

		// BOTH are destinations, the one the reader is standing in included: the list
		// does not hold back the place they are already in (see RecentFilesList.targetOf),
		// so a note's sub-list under its own row opens like any other note's.
		h.clickRow(places[0]);
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
		h.clickRow(places[1]);
		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});
});

// A click whose row the list has rebuilt away from under it: the reader pressed one
// note and the release arrives at an element that is no longer ON the list, or is on
// it at a different place. The row's index is a fact about ONE render (the places move
// under the list on every visit), so a click that reads it after a rebuild opens
// whatever slid into that slot — the wrong note. What the click is answered with
// instead is the place the reader PRESSED (see RecentFilesList.onPress / onClick).
describe('RecentFilesModal — a click after the list was rebuilt', () => {
	// a is the OLDEST here, so recency puts it LAST: three rows, a.md third.
	const three = () => [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };

	it('opens the note that was PRESSED, not whatever the index names now', () => {
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('a');
		expect(h.notes().map(r => r.textContent)).toEqual(['c', 'b', 'a']);

		// Press the row, then let the places move the way the reader's own click is
		// about to move them (a.md to the end, which by recency puts it FIRST), and
		// let the list be rebuilt. The element in hand is now detached, and the group
		// index it carries (2) names b.md.
		h.pressRow(row);
		h.changed(0);

		expect(h.notes().map(r => r.textContent)).toEqual(['a', 'c', 'b']);
		h.clickRow(row);

		// a.md was entries[2] before the move, and is entries[2] after it; the index
		// the stale element carried (the third GROUP) now names b.md, which is
		// entries[0] — so the wrong answer here is 0 and not 2.
		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});

	it('opens nothing when the place it stood for is off the list now', () => {
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('a');

		h.pressRow(row);
		// The place is gone: the file was deleted, the cap trimmed it, the query
		// stopped matching. There is no row left that stands for it.
		entries.splice(0, 1);
		h.changed();

		h.clickRow(row);

		// Opening nothing is the one failure this list can afford. Opening the note
		// that took the slot is the one it cannot.
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('still opens the row under the click when no press preceded it', () => {
		// A programmatic activation, or an assistive technology's: there is no press
		// to remember, so the event's own row is the answer — and it is the right one,
		// because such a click can only ever land on an element that IS on the list.
		const entries = three();
		const h = harness(entries, 2, files);

		h.clickRow(h.note('a'));

		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
	});

	it('opens the row under the click when the list did NOT rebuild', () => {
		// The ordinary click, in two halves: press and release with nothing in
		// between. The element in hand is still the one the list drew, so its own
		// index is the exact answer and no lookup is needed.
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('b');

		h.pressRow(row);
		h.clickRow(row);

		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('answers a click that the browser gave to the LIST, when the pressed row was gone', () => {
		// A press whose element is removed before the release does not always come
		// back to that element: the browser resolves the click on the nearest
		// ancestor still in the document, so no row sees it at all. That is the
		// click that used to do nothing whatever (see RecentFilesList.onUnansweredClick).
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('a');

		h.pressRow(row);
		h.changed(0);
		h.list().dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});

	it('does nothing with a click on the list that no press preceded', () => {
		// The list's own background — the gap under the last row. It is not a row,
		// and it stands for no place: nothing was pressed and nothing may be opened.
		const entries = three();
		const h = harness(entries, 2, files);

		h.list().dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('answers what the click LANDED on, when a press for another row is outstanding', () => {
		// A press the reader abandons — the pointer dragged off the row, or a
		// right-click that raised the row's menu instead — must not lie in wait and
		// open the row it names later on. An element still on the list answers for
		// itself (see onClick), so what is opened is what was clicked: here c.md
		// (entries[2]) and not a.md (entries[0]), which is what was pressed.
		const entries = three();
		const h = harness(entries, 2, files);

		h.pressRow(h.note('a'));
		h.changed();
		h.clickRow(h.note('c'));

		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});
});

describe('RecentFilesModal — keyboard', () => {
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

		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
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
		expect(selected()).toEqual(['c']);
		expect(spy).toHaveBeenCalled();
		spy.mockClear();

		h.key('ArrowDown');
		expect(selected()).toEqual(['b']);
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
		// THE RULE OF THE LIST (see RecentFilesList): a pointer that passes over a row
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
		expect(selected()).toEqual(['c']);
		h.movePointer(b, { x: 44, y: 41 });
		h.movePointer(h.el.querySelector<HTMLElement>('.position-restore-nav-list')!, { x: 200, y: 90 });
		expect(selected()).toEqual(['c']);

		// …and a click does not move it either: a click OPENS the row (the travel below),
		// which is the whole of what the list does with a pointer.
		h.clickRow(b);
		expect(h.jumpTo).toHaveBeenCalled();
		expect(selected()).toEqual(['c']);
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
		expect(h.note('b').classList.contains('is-selected')).toBe(true);

		// Enter travels to the spot that row stands for — the note's NEWEST landing,
		// where the reader left it (see RecentFilesList.activeRep) — and ↓ walks on to
		// the next NOTE, because there is no landing row in between to step into.
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
		h.key('ArrowDown');
		expect(h.note('a').classList.contains('is-selected')).toBe(true);

		// ←→ is not consumed by anything here: there is no tree left to open or close
		// (see RecentFilesBrowser.onKeyDown), so both keys keep their ordinary meaning
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
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
		expect(h.jumpTo).not.toHaveBeenCalledWith(2);
	});

	it('walks the landing rows too when the setting prints them', () => {
		// The same list under 'all': the note's spots are rows of their own, so ↓ steps
		// into them and Enter travels to the one it is on (see RecentFilesList.move).
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
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});
});

describe('RecentFilesModal — the file scope is gone', () => {
	// What stood here was two controls carrying one state: an "only this note"
	// switch and a chip opening a menu of every note the history had been in.
	// Both answered "where else in this note was I", and the search box already
	// answers it — a note's name is text its own steps are searchable by — so the
	// toolbar keeps the box and nothing beside it, and the list keeps the width and
	// the row the hint used to stand on. What the list PRINTS is not a question the
	// toolbar answers either: those four choices are rows of the plugin's settings
	// tab now (see RecentFilesBrowserPrefs).
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const entries = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('c.md', NOW - 4 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];

	it('leaves the toolbar to the search box and its ×', () => {
		const h = harness(entries(), 3, files);

		expect(h.el.querySelector('.position-restore-nav-toggle')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-scope')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-scope-menu')).toBeNull();
		// The box, and nothing else: the gear that used to stand at the strip's far end
		// is gone with the four choices it carried (see RecentFilesBrowserPrefs), and so is the
		// hint that used to say "click a row to open it" — a row in a list answers a
		// click everywhere else in the app, and the sentence cost the list its line. The
		// box's × is not a second thing in the strip: it is INSIDE the box's own element,
		// hung on the line the reader typed on.
		const strip = Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-toolbar > *'));
		expect(strip.map(el => el.className.split(' ')[0])).toEqual(['position-restore-nav-search']);
		expect(h.el.querySelector('.position-restore-nav-hint')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-settings')).toBeNull();
		expect(strip[0].querySelector('.position-restore-nav-clear')).toBe(h.clearButton());
	});

	it('empties the box from the × at the end of the line', () => {
		// The app's own gesture, copied from its quick switcher (see RecentFilesBrowser
		// .toolbar): the press is REFUSED so the caret never leaves the box, and the click
		// clears the box and re-reads the list from it. It is in the DOM whether or not
		// the box has anything in it; the STYLESHEET is what hides it while the box is
		// empty (asserted in the styles suite — jsdom loads no stylesheet).
		const h = harness(entries(), 3, files);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		expect(h.clearButton().getAttribute('aria-label')).toBe(t('recentFiles.clearFilter'));
		expect(h.clearButton().querySelector('svg')?.getAttribute('data-icon')).toBe('x');
		// A press on it is refused, so the focus stays where the reader's typing is.
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		h.clearButton().dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);

		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.notes()).toHaveLength(1);

		h.clearFilter();

		// The box is empty, the list is the whole list again, and the caret is back in
		// the box — which is what makes the × a faster way to type the next query.
		expect(box.value).toBe('');
		expect(h.notes()).toHaveLength(3);
		expect(document.activeElement).toBe(box);
	});

	it('narrows to a note by its own name, which is what the scope was for', () => {		const h = harness(entries(), 3, files);
		expect(h.notes()).toHaveLength(3);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'b.md';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('b');
	});
});

// The OTHER NAMES a file goes by (see RecentFilesReads.aliasesFor): searchable, and
// printed nowhere on the row but its own tooltip. They are the fourth thing a query
// can hit that is not literally on the row, and the first one that is deliberately
// about the reader's memory rather than about the visit.
describe('RecentFilesModal — searching a note by its other names', () => {
	// The window opens with the note's `visit` (the file's own record) and one jump
	// into it, so a query's hits can be counted as rows AND as landing rows.
	const entries = (): NavHistoryEntry[] => [
		visit('a.md', NOW - 3 * MINUTE, { scroll: 400 }),
		visit('b.md', NOW - 2 * MINUTE),
		visit('a.md', NOW - MINUTE),
	];
	const cache = {
		'a.md': {
			headings: [],
			frontmatter: { title: 'Weekly sync', aliases: ['周会', 'standup'] },
		},
		'b.md': { headings: [], frontmatter: { aliases: 'solo' } },
	};
	const files = { 'a.md': '', 'b.md': '' };
	const search = (h: ReturnType<typeof harness>, query: string) => {
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const names = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);

	it('finds a note by an alias, by its title, and not by an unrelated word', () => {
		const h = harness(entries(), 2, files, [], {}, cache);

		search(h, '周会');
		expect(names(h)).toEqual(['a']);
		// The `title` is read too — a community convention and not a native property
		// (see readMeta) — and a hit inside it is a hit, token by token.
		search(h, 'weekly');
		expect(names(h)).toEqual(['a']);
		search(h, 'sync');
		expect(names(h)).toEqual(['a']);
		// Case-insensitive like every other part of the query.
		search(h, 'STANDUP');
		expect(names(h)).toEqual(['a']);

		search(h, 'nothing-here');
		expect(names(h)).toEqual([]);
	});

	it('takes an alias written as a single string, not only as a list', () => {
		// `aliases: solo` is as valid a frontmatter line as the usual block list, and
		// Obsidian's own matching takes both (see readMeta).
		const h = harness(entries(), 2, files, [], {}, cache);

		search(h, 'solo');

		expect(names(h)).toEqual(['b']);
	});

	it('ANDs tokens across the two places a name can come from', () => {
		const h = harness(entries(), 2, files, [], {}, cache);

		// One token from the title, one from the aliases: both must be somewhere in
		// what the row stands for, and they are.
		search(h, 'weekly 周会');
		expect(names(h)).toEqual(['a']);

		// …but a token nothing holds sinks the match, whichever half held the other.
		search(h, 'weekly b.md');
		expect(names(h)).toEqual([]);
	});

	it('does not re-order anything: an alias match is still the MRU list', () => {
		// The order is "where have I been", and a name the reader half-remembers says
		// nothing about when they were there. Two notes carry the same alias and the
		// note the reader is IN does not, so what is left is the plain MRU order of the
		// two that match: b was visited later than a, so b leads.
		const h = harness([
			visit('a.md', NOW - 3 * MINUTE),
			visit('b.md', NOW - 2 * MINUTE),
			visit('c.md', NOW),
		], 2, { 'a.md': '', 'b.md': '', 'c.md': '' }, [], {}, {
			'a.md': { headings: [], frontmatter: { aliases: ['x'] } },
			'b.md': { headings: [], frontmatter: { aliases: ['x'] } },
		});

		search(h, 'x');

		expect(names(h)).toEqual(['b', 'a']);
	});

	it('prints the other names on the row\'s tooltip, after the path', () => {
		// A note WITH names and one without, so the second half of the rule is visible
		// beside the first: the names are an addition to the tooltip, not a replacement.
		const h = harness([visit('a.md', NOW - MINUTE), visit('plain.md', NOW)], 1,
			{ 'a.md': '', 'plain.md': '' }, [], {}, cache);

		// The path first, then the names — title before aliases, in the order the
		// frontmatter lists them (see readMeta). The row prints neither the extension
		// nor the folder, so this is where a reader can still see them; and the path is
		// drawn SEGMENT BY SEGMENT, so the separators are elements of their own (see
		// tip.ts) — the string a reader copies is the same one either way.
		const withNames = h.hover(h.note('a'))!;
		expect(withNames.querySelector('.nav-tip-path')?.textContent).toBe('a.md');
		expect(Array.from(withNames.querySelectorAll('.nav-tip-sep')).map(s => s.textContent)).toEqual([]);
		expect(withNames.querySelector('.nav-tip-text')?.textContent)
			.toBe(`${t('recentFiles.aka')} Weekly sync · 周会 · standup`);

		// …and a note with no other names says the path and nothing else.
		h.unhover(h.note('a'));
		const plain = h.hover(h.note('plain'))!;
		expect(plain.querySelector('.nav-tip-path')?.textContent).toBe('plain.md');
		expect(plain.querySelector('.nav-tip-text')).toBeNull();
	});

	it('draws a folder path as its segments, with the separators between them', () => {
		// The one reason the panel draws its own tooltip: a `/` between two long segments
		// is the least visible character in the string, so it is a span of its own for
		// the stylesheet to weight (see styles.css), and the folder segments step back so
		// it has something to stand against.
		const h = harness([visit('deep/folder/note.md', NOW)], 0, { 'deep/folder/note.md': '' });

		const tip = h.hover(h.note('note'))!;
		expect(Array.from(tip.querySelectorAll('.nav-tip-sep')).map(s => s.textContent))
			.toEqual(['/', '/']);
		expect(Array.from(tip.querySelectorAll('.nav-tip-seg')).map(s => s.textContent))
			.toEqual(['deep', 'folder']);
		expect(tip.querySelector('.nav-tip-name')?.textContent).toBe('note.md');
		// The whole thing still reads as the path it is.
		expect(tip.querySelector('.nav-tip-path')?.textContent).toBe('deep/folder/note.md');
	});

	it('leaves a landing row\'s tooltip alone', () => {
		// A landing row has no tooltip at all: a spot is placed by the coordinate and the
		// section it prints, and the file's other names belong to the FILE rather than to
		// one spot in it (see placeRow / fileRow).
		const h = harness([
			visit('a.md', NOW - 3 * MINUTE, { scroll: 10 }),
			visit('a.md', NOW - 2 * MINUTE, { scroll: 400 }),
			visit('b.md', NOW),
		], 2, files, [], {}, cache, false, {}, prefs({ landings: 'all' }).browser);

		const place = h.rows().find(r => r.querySelector('.nav-row-line')?.textContent === 'L401')!;
		expect(place).toBeDefined();
		// …so it says nothing on hover, and the file's other names are asked of the note's
		// own row instead.
		expect(h.hover(place)).toBeNull();
		expect(h.hover(h.note('a'))!.textContent).toContain('周会');
	});

	it('reads each path once, and reads it again only when the file changes', () => {
		// Two notes, one read each: the record is memoized per PATH for the life of the
		// body (see RecentFilesReads), so filtering, re-ordering and every later render
		// are answered from memory — and a frontmatter change drops exactly one path.
		const h = harness(entries(), 2, files, [], {}, cache);
		expect(h.cacheReads()).toBe(2);

		search(h, 'weekly');
		expect(h.cacheReads()).toBe(2); // the query added nothing
		search(h, '');
		expect(h.cacheReads()).toBe(2); // nor does clearing it

		h.changeFile('a.md');
		search(h, 'weekly');
		expect(h.cacheReads()).toBe(3); // one path re-read, the other still remembered
	});
});

describe('RecentFilesModal — the list\'s looks belong to the settings tab', () => {
	// What the list PRINTS is no longer chosen in the panel: the four choices the
	// toolbar's gear used to carry are rows of the plugin's settings tab now (see
	// RecentFilesBrowserPrefs), so the strip is the box alone, and a dialog that lives a
	// second has nothing in it worth changing anyway. Two spots in a.md and
	// b.md current, so 'all' has something to print.
	const entries = () => [
		visit('a.md', NOW - 3 * MINUTE, { scroll: 100 }),
		visit('a.md', NOW - 2 * MINUTE, { scroll: 412 }),
		visit('b.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '' };

	it('draws from the values the plugin holds, and offers nowhere to change them', () => {
		const h = harness(entries(), 2, files, [], {}, {}, false, {},
			prefs({ landings: 'all' }).browser);

		// No gear in the strip, no menu hanging off it — and no key of its own to put
		// away: Escape is the app's (it closes the dialog), and with nothing of ours up
		// nothing here may consume it.
		expect(h.el.querySelector('.position-restore-nav-settings')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-settings-menu')).toBeNull();
		const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		h.modal.contentEl.dispatchEvent(escape);
		expect(escape.defaultPrevented).toBe(false);

		// What the list prints is what the plugin's value says, read live: a.md's two
		// spots, in line order (see the row tests for the whole of that).
		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent))
			.toEqual(['L101', 'L413']);
	});
});

describe('RecentFilesModal — a file that is gone', () => {
	// A place whose file no longer exists is not listed at all: no row, no landing,
	// no "you are here" — not even for the note the reader is standing in. The
	// recent-files store prunes such a place on the vault's own delete event (see
	// places.ts); the list agrees with it on the spot, which is also what covers the
	// moment before that prune lands (see RecentFilesList.render).
	it('leaves a deleted note out of the list entirely', () => {
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'b.md': '' }, ['gone.md']);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['b']);
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

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['a']);
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
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('recentFiles.empty'));
	});
});

describe('RecentFilesModal — keyboard is announced', () => {
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

describe('RecentFilesModal — one note, many landings', () => {
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

		const row = h.note('x');
		expect(row.querySelector('.nav-row-count')).toBeNull();
		expect(row.querySelector('.nav-file-caret')).toBeNull();

		// ONE spot is not a list, so not even 'all' prints a row for it (see
		// RecentFilesList.printsLandings): the note's own row stands for it.
		expect(h.rows()).toHaveLength(0);

		// …and the row is a destination: a click on it opens its one place.
		h.clickRow(h.note('x'));
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
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

		const row = h.note('board');
		// One spot, so nothing under the row — not even under 'all': one place is not
		// a list (see RecentFilesList.printsLandings).
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
		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});

	it('prints every landing when the settings ask for all of them', () => {
		// The other side of the setting (see LandingsMode): every distinct spot under
		// the note, in the note's own order — and no count anywhere, because the list
		// no longer has anything to hide behind one.
		const all = prefs({ landings: 'all' });
		const h = harness([
			at('x.md', 100, 30), at('x.md', 412, 25), at('x.md', 412, 10), visit('y.md', NOW),
		], 3, files, [], {}, {}, false, {}, all.browser);

		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L101', 'L413']);
		expect(h.note('x').querySelector('.nav-row-count')).toBeNull();
	});

	it('never merges two notes, however alike their steps are', () => {
		// ONE tab walks from x.md to z.md and both were captured at the same
		// line — the ordinary way to read two notes side by side. Different notes
		// are different rows, always.
		const h = harness([
			at('x.md', 100, 20), at('z.md', 100, 10), visit('y.md', NOW),
		], 2, files);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['y', 'z', 'x']);
	});

	it('orders the notes by their newest landing', () => {
		// x.md was opened three times, but its last one is older than y.md's, so
		// it comes second: the row is the note, the order is still recency.
		const h = harness([
			at('x.md', 10, 40), at('x.md', 412, 30), at('y.md', 20, 5), visit('z.md', NOW),
		], 3, files);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['z', 'y', 'x']);
	});
});

describe('RecentFilesModal — a landing row', () => {
	// The landings a note holds are rows of their own under 'all', so these tests ask
	// for them: the note here holds TWO places — L7 under "预览" and L36 under
	// "尾巴" — far enough apart that they are two rows at all (see SPREAD_DOC), and a
	// note with ONE prints none either way — a single place is not a list (see
	// RecentFilesList.printsLandings).
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

	it('labels every landing with the line it will OPEN, and says nothing on hover', () => {
		// The list used to fold landings close enough together into one row, which printed
		// the NEWEST member's line while covering the rest: a click could reach only that
		// line, and the range the row covered survived as its tooltip. Every spot is a row
		// of its own now (see NavFileGroup), so the label IS the destination — and a
		// landing row has nothing left to say on hover, because a spot is placed by the
		// coordinate and the section it already prints.
		const entries = [
			visit('a.md', NOW - 3 * MINUTE, captured(SPREAD_DOC, 6)),
			visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 12)),
			visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
			visit('b.md', NOW),
		];
		const h = harnessAll(entries, 3, files, [], {}, SPREAD_HEADINGS);

		// Down the note: L7 and L13 are two spots, so they are two rows — whatever the
		// distance between them — and L36 follows.
		const rows = h.rows();
		expect(rows.map(r => r.querySelector('.nav-row-line')?.textContent)).toEqual(['L7', 'L13', 'L36']);
		// …and a row opens the line it prints: the second one lands on the step behind it.
		h.clickRow(rows[1]);
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
		expect(h.hover(rows[1])).toBeNull();
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


// WHAT A ROW SAYS about the FILE behind it: the name without its extension, the type
// badge where the type is worth saying, the folder on the side the setting asks for,
// and the full path on hover (see displayName / badgeOf / PathDisplayMode).
describe('RecentFilesModal — the name, the type and the path', () => {
	const files = {
		'a/index.md': '', 'b/index.md': '', 'notes.md': '',
		'report.pdf': '', 'LICENSE': '', 'board.canvas': '',
	};
	const stack = (): NavHistoryEntry[] => [
		visit('a/index.md', NOW - 6 * MINUTE),
		visit('b/index.md', NOW - 5 * MINUTE),
		visit('notes.md', NOW - 4 * MINUTE),
		visit('report.pdf', NOW - 3 * MINUTE),
		visit('LICENSE', NOW - 2 * MINUTE),
		visit('board.canvas', NOW),
	];
	// A row found by the FILE it stands for, out of what the row PRINTS: the two index
	// notes print the same name, so the name alone cannot be the lookup, and the folder
	// is what tells them apart — 'smart' prints exactly the folders a collision needs
	// and the two "always" modes print all of them, so the pair is unique under every
	// setting. The tooltip is NOT a lookup key any more: it belongs to the panel and
	// exists in the document only while the pointer rests on a row (see tip.ts).
	const rowFor = (h: ReturnType<typeof harness>, path: string) => {
		const cut = path.lastIndexOf('/');
		const folder = cut < 0 ? '/' : path.slice(0, cut + 1);
		const file = path.slice(cut + 1).replace(/\.[^./]+$/, '');
		const row = h.notes().find(r =>
			r.querySelector('.nav-row-name')?.textContent === file
			&& (r.querySelector('.nav-row-path')?.textContent ?? '/') === folder);
		expect(row, `no row for ${path}`).toBeDefined();
		return row!;
	};
	const attr = (row: HTMLElement) => ({
		name: row.querySelector('.nav-row-name')?.textContent,
		badge: row.querySelector('.nav-row-badge')?.textContent,
		path: row.querySelector('.nav-row-path')?.textContent,
	});
	// What one file's row says on hover, found by the path the fixture named it with.
	const hoverOf = (h: ReturnType<typeof harness>, path: string) => h.hover(rowFor(h, path));
	// The metadata of ONE note in this stack: it goes by other names, which are printed
	// nowhere on the row and are the one thing a hover can still add to a row that
	// already prints its path (see the aliases suite and fileRow).
	const cache = {
		'a/index.md': { headings: [], frontmatter: { title: 'Weekly sync', aliases: ['周会', 'standup'] } },
	};

	it('prints the name without the extension, and marks every type but markdown', () => {
		const h = harness(stack(), 5, files);

		expect(attr(rowFor(h, 'notes.md')))
			.toEqual({ name: 'notes', badge: undefined, path: undefined });
		// A PDF says so, in capitals — the extension is not part of the name it is
		// printed under, so the badge is the only place the type is said at all.
		expect(attr(rowFor(h, 'report.pdf')))
			.toEqual({ name: 'report', badge: 'PDF', path: undefined });
		// …and a file with NO extension gets one too, or "no badge" would mean both
		// "markdown" and "no type known" (see badgeOf).
		expect(attr(rowFor(h, 'LICENSE')))
			.toEqual({ name: 'LICENSE', badge: 'FILE', path: undefined });
		expect(attr(rowFor(h, 'board.canvas')))
			.toEqual({ name: 'board', badge: 'CANVAS', path: undefined });
	});

	it('carries the file\'s full path, extension and all, where the row does not print it', () => {
		// The row prints neither the extension nor (by default) the folder, so the
		// tooltip is the last place either is still said. It is the PANEL's tooltip and
		// not the native `title` it used to be (see tip.ts): a browser tooltip cannot be
		// styled, and this one has to be legible — and it is not written as an
		// `aria-label`, which would REPLACE the option's accessible name (see fileRow).
		const h = harness(stack(), 5, files);

		expect(h.hover(rowFor(h, 'notes.md'))!.querySelector('.nav-tip-path')?.textContent)
			.toBe('notes.md');
		h.unhover(rowFor(h, 'notes.md'));
		expect(h.hover(rowFor(h, 'LICENSE'))!.querySelector('.nav-tip-path')?.textContent)
			.toBe('LICENSE');
	});

	it('says nothing on hover where the row already prints the path', () => {
		// The reader asked for the paths by turning them on (see PathDisplayMode), so the
		// hover has nothing left to add: a row that prints its folder is a row that says
		// nothing on hover — the extension alone is not worth a tooltip (see fileRow).
		// This is the whole of the rule, told in both of its halves.
		const always = harness(stack(), 5, files, [], {}, {}, false, {}, prefs({ path: 'before' }).browser);
		for (const path of ['a/index.md', 'notes.md', 'report.pdf', 'LICENSE', 'board.canvas'])
			expect(hoverOf(always, path), path).toBeNull();

		// …and under 'smart' the same rule picks out the rows that print a folder: the two
		// index notes collide and print theirs, so they say nothing on hover, while a row
		// whose folder is NOT printed still says the whole path.
		const smart = harness(stack(), 5, files);
		expect(hoverOf(smart, 'a/index.md')).toBeNull();
		expect(hoverOf(smart, 'b/index.md')).toBeNull();
		expect(hoverOf(smart, 'notes.md')?.querySelector('.nav-tip-path')?.textContent).toBe('notes.md');
	});

	it('says the other names even where the row prints the path', () => {
		// The names are printed NOWHERE on a row and are searchable, so they are the one
		// thing a hover still owes a reader whose paths are on screen — the path line goes
		// and the names' line stays (see fileRow).
		const h = harness(stack(), 5, files, [], {}, cache, false, {}, prefs({ path: 'after' }).browser);

		const tip = h.hover(rowFor(h, 'a/index.md'))!;
		expect(tip.querySelector('.nav-tip-path')).toBeNull();
		expect(tip.querySelector('.nav-tip-text')?.textContent)
			.toBe(`${t('recentFiles.aka')} Weekly sync · 周会 · standup`);
	});

	it('says nothing about a pathless view: no badge, no folder, no tooltip', () => {
		// The graph is a view and not a file: it has no type to mark and no path to
		// print or to hover — its own name is the translated view label.
		const h = harness([
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavHistoryEntry,
			...stack(),
		], 6, files);

		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		expect(graph).toBeDefined();
		expect(attr(graph)).toEqual({ name: t('recentFiles.graphView'), badge: undefined, path: undefined });
		expect(h.hover(graph)).toBeNull();
	});

	it('prints the folder on every row, on the side the setting asks for', () => {
		const ctx = (path: 'before' | 'after') =>
			harness(stack(), 5, files, [], {}, {}, false, {}, prefs({ path }).browser);
		// 'before' is the quick switcher's shape: the whole path laid out in front of
		// the name, and the NAME is what drops when the row runs out (see styles.css).
		const before = ctx('before');
		expect(attr(rowFor(before, 'a/index.md')).path).toBe('a/');
		expect(attr(rowFor(before, 'notes.md')).path).toBe('/');
		expect(before.notes().every(r => r.classList.contains('is-path-before'))).toBe(true);

		// 'after' prints the same folders, and drops the PATH instead: the names stay
		// in the left column, which is the whole reason to choose it.
		const after = ctx('after');
		expect(attr(rowFor(after, 'a/index.md')).path).toBe('a/');
		expect(after.notes().some(r => r.classList.contains('is-path-before'))).toBe(false);
		// The vault ROOT prints "/" and not nothing, in every mode: a blank cell is
		// what a note with no folder to print looks like, and the two are different
		// facts (see fileRow).
		expect(attr(rowFor(after, 'notes.md')).path).toBe('/');
	});

	it('prints the folder on the colliding rows only, by default', () => {
		// 'smart' is the default, and it is the setting that says the least: the
		// folder is a disambiguator, so it appears exactly where there is something to
		// disambiguate — and nowhere else.
		const h = harness(stack(), 5, files);

		expect(rowFor(h, 'a/index.md').querySelector('.nav-row-path')?.textContent).toBe('a/');
		expect(rowFor(h, 'b/index.md').querySelector('.nav-row-path')?.textContent).toBe('b/');
		expect(rowFor(h, 'notes.md').querySelector('.nav-row-path')).toBeNull();
		expect(rowFor(h, 'report.pdf').querySelector('.nav-row-path')).toBeNull();
		// …and it lays those rows out like 'before', because the folder in front of the
		// name is what the disambiguating rows are for.
		expect(rowFor(h, 'a/index.md').classList.contains('is-path-before')).toBe(true);
	});
});

// THE ROW'S TOOLTIP AS A THING THAT COMES AND GOES (see tip.ts). It is the panel's own
// element now, drawn on the document rather than by the browser, so WHEN it is there is
// the panel's decision: a pointer crossing the list says nothing, a pointer that rests
// gets an answer, and the answer goes the moment the thing it describes is no longer
// what the pointer is on — or is no longer on screen at all.
describe('RecentFilesModal — the row\'s tooltip', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const entries = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	const tip = () => document.querySelector<HTMLElement>('.position-restore-nav-tip');

	it('answers only a pointer that RESTS on the row', () => {
		// A tooltip that appeared the instant the pointer touched a row would be a band
		// of text flashing down the list at the speed of the mouse (see TIP_DELAY_MS).
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
		expect(tip()).toBeNull();

		vi.advanceTimersByTime(TIP_DELAY_MS);
		expect(tip()?.querySelector('.nav-tip-path')?.textContent).toBe('a.md');
	});

	it('says nothing for a pointer that only crossed the row', () => {
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
		row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
		vi.advanceTimersByTime(TIP_DELAY_MS);

		expect(tip()).toBeNull();
	});

	it('takes the answer away when the pointer leaves the row', () => {
		// The row is one target: the tooltip belongs to what the pointer is ON, and the
		// pointer moving off it — even onto another row that says nothing — takes it away.
		const h = harness(entries(), 1, files);

		expect(h.hover(h.note('a'))).not.toBeNull();
		expect(h.unhover(h.note('a'))).toBeNull();
	});

	it('takes it away when the list is rebuilt under it', () => {
		// Every keystroke redraws the rows, so a tooltip left standing would be pointing
		// at a row that no longer exists — and describing a list the reader has just
		// filtered (see RecentFilesList.render).
		const h = harness(entries(), 1, files);
		expect(h.hover(h.note('a'))).not.toBeNull();

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		expect(tip()).toBeNull();
	});

	it('takes it away on a scroll, and on a press that is about to travel', () => {
		// A tooltip is pinned to the row's own box and does not move with it: a scroll
		// leaves it hanging over whatever slid underneath. A press is the same fact one
		// moment later — the row is about to open, or the list to be rebuilt.
		const h = harness(entries(), 1, files);
		expect(h.hover(h.note('a'))).not.toBeNull();
		h.list().dispatchEvent(new Event('scroll'));
		expect(tip()).toBeNull();

		expect(h.hover(h.note('a'))).not.toBeNull();
		h.pressRow(h.note('a'));
		expect(tip()).toBeNull();
	});

	it('draws it on the document, outside the panel\'s own element', () => {
		// It has to be able to hang BELOW the list — the rows near the foot are the ones
		// a reader needs it for — and the list scrolls and clips its own content.
		const h = harness(entries(), 1, files);
		const shown = h.hover(h.note('a'))!;

		expect(h.el.contains(shown)).toBe(false);
		expect(shown.parentElement).toBe(document.body);
	});

	it('takes its element with it when the panel goes', () => {
		// The tooltip is the one thing the body put OUTSIDE its own element, so nothing
		// that removes the panel removes it (see RecentFilesBrowser.destroy).
		const h = harness(entries(), 1, files);
		expect(h.hover(h.note('a'))).not.toBeNull();

		h.modal.close();

		expect(tip()).toBeNull();
	});
});

// HOW LONG AGO each row's note was last visited (see model.ts's ageLabel). It is a
// switch and not a scale: off, the rows are exactly the rows that were there before
// the label existed, and on, every row carries one — including the ones with no file
// behind them at all.
describe('RecentFilesModal — the time on a row', () => {
	const DAY = 24 * 60 * MINUTE;
	const HOUR = 60 * MINUTE;
	const on = () => prefs({ time: true }).browser;
	// OLDEST FIRST, as the store really keeps them (see places.remember): the list's
	// own order is the reverse scan of this array, so a fixture that shuffles it would
	// be testing an order the panel never sees.
	const stack = (): NavHistoryEntry[] => [
		visit('notes.md', NOW - 3 * DAY),
		{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW - 2 * HOUR } as NavHistoryEntry,
		visit('a/index.md', NOW - 5 * MINUTE),
	];
	const files = { 'a/index.md': '', 'notes.md': '' };
	const times = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-time')?.textContent);

	it('is off by default, and leaves nothing at all on the row', () => {
		// Not hidden but ABSENT: the setting is the only reason the element exists, and
		// a span kept in the DOM to be styled away would still be a cell the row's own
		// grid has to lay out.
		const h = harness(stack(), 2, files);

		expect(h.notes().length).toBeGreaterThan(0);
		expect(h.el.querySelectorAll('.nav-row-time')).toHaveLength(0);
		// …and no row claims the far track either: the row's SHAPE follows its label
		// (see is-timed), so a list with the labels switched off spends no second
		// column on them.
		expect(h.el.querySelectorAll('.is-timed')).toHaveLength(0);
	});

	it('says the age of each note, from the newest step the note holds', () => {
		const h = harness(stack(), 2, files, [], {}, {}, false, {}, on());

		// The current note (a/index.md) leads, then notes.md; the graph is LAST
		// whatever it holds, because a pathless group never competes with the notes for
		// the reader's scan order (see groupByFile) — including when it is where the
		// reader is standing.
		expect(h.notes()).toHaveLength(3);
		expect(times(h)).toEqual(['5m ago', '3d ago', '2h ago']);
	});

	it('dates the pathless view too, and every row the same way', () => {
		// The graph is a row like any other and it was visited like any other: what it
		// has no answer for is a FILE (no path, no type — see badgeOf), not a time.
		const h = harness(stack(), 2, files, [], {}, {}, false, {}, on());
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

		expect(graph.querySelector('.nav-row-time')?.textContent).toBe('2h ago');
		expect(graph.classList.contains('is-timed')).toBe(true);
		expect(graph.querySelector('.nav-row-path')).toBeNull();
	});

	it('carries the exact moment as the label\'s own tooltip', () => {
		// The label is abbreviated ("5m ago"), so the moment is one hover away — and it
		// is the TIME's tooltip, so the row's own still says which file. The
		// time is INSIDE the row, so this is the one place the pointer's nearest subject
		// is not the row itself (see NavRowTip.subject).
		const h = harness(stack(), 2, files, [], {}, {}, false, {}, on());
		const label = h.note('notes').querySelector('.nav-row-time')!;

		expect(h.hover(label)?.textContent).toBe(new Date(NOW - 3 * DAY).toLocaleString());
		h.unhover(label);
		expect(h.hover(h.note('notes'))?.querySelector('.nav-tip-path')?.textContent).toBe('notes.md');
	});

	it('gives every dated row the far track its age stands in, folder or no folder', () => {
		// The age is a cell of the ROW and not of the name (see
		// RecentFilesList.fileRow): that is what puts every label at the same x down the
		// list, whatever the row prints beside it. The class the stylesheet reads is
		// written WITH the label, so a row cannot claim a track it has nothing to put
		// in — and the label is a child of the row, because inside the name cell it
		// would be part of what wraps, which is the column the track exists to keep.
		const smart = harness(stack(), 2, files, [], {}, {}, false, {}, on());
		const graph = smart.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		expect(smart.note('notes').classList.contains('is-timed')).toBe(true);
		expect(graph.classList.contains('is-timed')).toBe(true);
		// A 'smart' row whose name nothing collides with prints no folder at all…
		expect(smart.note('notes').querySelector('.nav-row-path')).toBeNull();
		expect(graph.querySelector('.nav-row-path')).toBeNull();
		// …and the label is the row's own child, not the name cell's.
		expect(smart.note('notes').querySelector('.nav-row-time')!.parentElement)
			.toBe(smart.note('notes'));

		// Under 'always' the root note prints "/", which is a folder on the row like any
		// other — and it keeps the same far track its age stands in.
		const always = harness(stack(), 2, files, [], {}, {}, false, {}, prefs({ time: true, path: 'before' }).browser);
		expect(always.note('notes').querySelector('.nav-row-path')?.textContent).toBe('/');
		expect(always.note('notes').classList.contains('is-timed')).toBe(true);
		expect(always.note('notes').querySelector('.nav-row-time')!.parentElement)
			.toBe(always.note('notes'));
	});
});

// WHERE a row opens, when the reader says so: the modifier keys, the middle button,
// the keyboard's own equivalent, and the app's menu on a right-click. Which of these
// the app decides rather than this plugin is the point of most of them (see
// Keymap / PaneTarget).
describe('RecentFilesModal — where a row opens, and the right-click menu', () => {
	// a.md is the OLDER note, so recency puts it SECOND: two rows, b.md first.
	const files = { 'a.md': '', 'b.md': '' };
	const entries = (): NavHistoryEntry[] => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	// A note with a LANDING and no file record — the shape a note has once its `visit`
	// has been evicted while the jumps made inside it survive (see places.ts). Its row
	// still opens the landing (see activeRep), so it is the row that can promise a
	// SPOT rather than a file.
	const jumped = (): NavHistoryEntry[] => [
		visit('a.md', NOW - MINUTE, { scroll: 30 }),
		visit('b.md', NOW),
	];
	// The menu the browser handed the app: the app's event carries it as its second
	// argument, and that is where the plugin's own contribution is visible.
	const menuOf = (trigger: unknown) => {
		const calls = (trigger as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls).toHaveLength(1);
		return calls[0][1] as { items: { title: string; section: string; icon: string; click?: () => void }[] };
	};

	it('asks the app where to open, and opens there', () => {
		// A plain click: the app says "where it already is" (its `false`), which this
		// plugin normalises to no target at all (see RecentFilesList.onClick).
		const h = harness(entries(), 1, files);
		h.clickRow(h.note('a'));
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);

		// …and with a modifier down, the row opens where the APP said — the plugin never
		// reads ctrlKey/metaKey itself, so a platform the plugin knows nothing about is
		// still the app's answer.
		const held = harness(entries(), 1, files);
		Keymap.modEvent = 'tab';
		held.clickRow(held.note('a'));
		expect(held.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('opens a middle-click in a new tab, from the press itself', () => {
		// The middle button raises `auxclick` and not `click`, so a handler waiting for
		// the click would never run; and preventDefault on the press is what keeps the
		// WebView's middle-click autoscroll out of the list (see RecentFilesList.onPress).
		const h = harness(entries(), 1, files);
		const press = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 1 });
		h.note('a').dispatchEvent(press);

		expect(press.defaultPrevented).toBe(true);
		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('leaves a press of any other button alone', () => {
		// The right button raises the row's menu and never a click (see the suite
		// below); anything else — a fourth button, a hover-reporting pointer — opens
		// nothing and claims nothing.
		const h = harness(entries(), 1, files);
		for (const button of [2, 3, 4])
			h.note('a').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }));
		h.clickRow(h.note('a'));

		// The click is answered by the row it landed on, and not by an identity a stray
		// press left behind: a.md is the second row, and its place index is 0 while
		// b.md's is 1.
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
		expect(h.trigger).not.toHaveBeenCalled();
	});

	it('opens a row in a new tab on Cmd/Ctrl+Enter', () => {
		// The focus never leaves the filter box, so a row's modifier-click is out of
		// reach: the keyboard's own answer is the gesture every list in the app takes.
		// Whether the modifier is down is the app's call (see Keymap.isModifier).
		const h = harness(entries(), 1, files);
		h.key('ArrowDown'); // b.md, the current note, pinned first
		h.key('ArrowDown'); // a.md
		Keymap.modifier = true;
		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('hands the app a menu for a file row, with its own item on top', () => {
		// The menu is the app's — what a reader can do with a file is not this plugin's
		// business — and the ONE item added is the one the app cannot know: this row
		// stands for a PLACE, so "open in a new tab" here means this file.
		const h = harness(entries(), 1, files);
		const ev = h.rightClick(h.note('a'));

		expect(ev.defaultPrevented).toBe(true); // the long-press callout must not rise
		const menu = menuOf(h.trigger);
		expect(menu.items).toHaveLength(1);
		expect(menu.items[0].title).toBe(t('recentFiles.menu.openInNewTab'));
		expect(menu.items[0].section).toBe('action');
		expect(menu.items[0].icon).toBe('file-plus');
		// The context asked for is a LINK's, not the file explorer's: the app decides
		// what belongs there, and the file-managing actions do not (see contextRow).
		expect(h.trigger).toHaveBeenCalledWith(
			'file-menu', menu, expect.objectContaining({ path: 'a.md' }), 'link-context-menu',
		);

		// …and clicking that item opens the row's own place, one tab over — the same
		// place a plain click opens.
		menu.items[0].click!();
		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('says WHICH place its own item opens, on a row that stands for a landing', () => {
		// A row whose note has no file record of its own opens the LANDING it stands for
		// (see activeRep), so "open in a new tab" would be a promise the row does not
		// keep: it is opened HERE, at that spot.
		const h = harness(jumped(), 1, files);
		h.rightClick(h.note('a'));

		const menu = menuOf(h.trigger);
		expect(menu.items[0].title).toBe(t('recentFiles.menu.openHereInNewTab'));
		menu.items[0].click!();
		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('raises no menu at all for a pathless view', () => {
		// The graph is not a file: a file menu has nothing to be about, so the event is
		// refused (the callout) and nothing is built.
		const h = harness([
			visit('a.md', NOW - MINUTE),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavHistoryEntry,
		], 1, files);
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		const ev = h.rightClick(graph);

		expect(ev.defaultPrevented).toBe(true);
		expect(h.trigger).not.toHaveBeenCalled();
	});

	it('raises no menu when the file behind the row is gone', () => {
		// A place whose file the list cannot open is not DRAWN at all (see
		// RecentFilesList.render), so the only way here is a file that went between the
		// render and the right-click — a sync removing it, a delete landing a moment
		// ago. There is then nothing to ask the app about.
		const deleted: string[] = [];
		const h = harness(entries(), 1, files, deleted);
		const row = h.note('a');
		deleted.push('a.md');

		const ev = h.rightClick(row);

		expect(ev.defaultPrevented).toBe(true);
		expect(h.trigger).not.toHaveBeenCalled();
	});
});

describe('RecentFilesModal — same-named notes', () => {
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

		const folders = h.notes().map(r => r.querySelector('.nav-row-path')?.textContent ?? '');
		expect(folders).toEqual(['', 'b/', 'a/']); // notes.md (current) first, then the two index.md, newest first
		expect(h.note('notes').querySelector('.nav-row-path')).toBeNull();
		// The folder comes BEFORE the name it disambiguates — as a CLASS and not as
		// an insertion order: the row is built name-first so that it READS the same
		// however it is drawn, and the stylesheet's `order` is what puts the path in
		// front (see styles.css, and the `after` mode, where it is not applied).
		const index = h.note('index');
		expect(index.classList.contains('is-path-before')).toBe(true);
		// …and with one landing there is no count riding after the name.
		expect([...index.querySelector('.nav-row-file')!.children].map(el => el.className))
			.toEqual(['nav-row-name', 'nav-row-path']);
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
		const folders = root.notes().map(r => r.querySelector('.nav-row-path')?.textContent);
		expect(folders).toEqual(['a/', '/']);
	});

	it('drops the folder again once the collision is gone', () => {
		// A collision the query removed is not on screen to be
		// confused with anything, so the surviving row stops paying for it.
		const h = harness([
			visit('a/index.md', NOW - 3 * MINUTE),
			visit('b/index.md', NOW),
		], 1, files);

		expect(h.notes()[0].querySelector('.nav-row-path')).not.toBeNull();

		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		input.value = 'a/index';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-path')).toBeNull();
	});
});


describe('RecentFilesModal — the recorded landing block', () => {
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
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('a');
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

describe('RecentFilesModal — touch', () => {
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
	// Two PLACES of one note, far enough apart to sit under two different headings
	// (see SPREAD_DOC): every distinct line is a row of its own, but a note prints its
	// landings at all only while it holds more than one.
	const SPREAD = () => [
		visit('a.md', NOW - 3 * MINUTE, captured(SPREAD_DOC, 6)),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
		visit('b.md', NOW),
	];
	const SPREAD_FILES = { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' };

	it('empties the box from the × without summoning the keyboard', () => {
		// The panel deliberately leaves the box unfocused on touch — the on-screen
		// keyboard covers half a phone (see body.ts's mount) — so the × must not put the
		// focus there either: a finger that taps it is clearing, not typing.
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.notes()).toHaveLength(1);

		h.clearFilter();

		expect(box.value).toBe('');
		expect(h.notes()).toHaveLength(3);
		expect(document.activeElement).not.toBe(box);
	});

	it('treats a tap inside any cell of a row as a tap on the row', () => {
		// A touch WebView sends mousemove before the click. Nothing about the cell
		// under the finger may change what happens: the note's own name cell and the
		// row's padding both act on the row — and what the row does is OPEN the file
		// it stands for (see RecentFilesList.onClick).
		const h = harness(entries(), 2, files, [], {}, {}, true);
		h.note('b').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		const target = h.note('b').querySelector<HTMLElement>('.nav-row-file')!;

		target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('ignores the mousemove a tap synthesises, so the click still opens the note', () => {
		// A touch WebView sends mouseover/mousemove before the click. The list has no
		// mousemove handler to take that for a hover any more (see RecentFilesList), so
		// the pointer report selects nothing — and the click that follows is the row's
		// own, which opens the file rather than being read as a second press on an
		// already-open row.
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const row = h.note('b');

		row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		expect(row.classList.contains('is-selected')).toBe(false);

		h.clickRow(row);
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('lets a pointing device open the file from the row itself, in one click', () => {
		// The row is not a touch affordance: a mouse gets the same one click, and it is
		// the whole journey — one press, one destination, and the panel has nothing to
		// do with it (see RecentFilesList.onClick).
		const h = harness(entries(), 2, files);

		h.clickRow(h.note('b'));
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('opens nothing on a right-click, and refuses the gesture', () => {
		const h = harness(entries(), 2, files);

		const ev = h.rightClick(h.note('b'));

		// A row is opened by clicking it. The right button used to travel as well — a
		// shortcut for a hand already resting on it — and that is gone: one gesture per
		// meaning, and the visible one is the click (see RecentFilesList.onContextMenu).
		expect(h.jumpTo).not.toHaveBeenCalled();
		// …and it is still refused rather than handed to the app: a row has no text to
		// copy, nothing to inspect, and a long press must raise no callout over the list.
		expect(ev.defaultPrevented).toBe(true);
	});

	it('does not travel on a press that was only held down', () => {
		const h = harness(entries(), 2, files);
		const row = h.note('b');

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

	it('keeps the keyboard down when the × is tapped', () => {
		// The × is the one control in the strip a finger reaches for, and putting the
		// caret back in the box afterwards would unfold the on-screen keyboard over
		// the list — the opposite of what the tap asked for (see
		// RecentFilesBrowser.toolbar). The box still empties; only the focus stays
		// where the reader left it.
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		h.clearFilter();

		expect(box.value).toBe('');
		expect(document.activeElement).not.toBe(box);
		// …and there is no hint beside the box to say what a tap does: a row in a list
		// answers a tap everywhere else in the app.
		expect(h.el.querySelector('.position-restore-nav-hint')).toBeNull();
	});

});

// A FINGER IN THE LIST (see body.ts and tip.ts). Touch delivers the SAME pointer
// events a mouse does — an over with the press, and an out/leave the moment the
// browser decides the finger is panning or the app is dragging something — but the
// leave arrives while the finger is STILL DOWN. A mouse's leave is a fact about
// attention ("nobody is reading this list any more"); a finger's is a fact about
// the gesture, and answering it as if it were the mouse's rebuilds every row
// underneath a touch that is in the middle of becoming a scroll — which is what a
// phone's list could not be scrolled by, and what left a folded drawer half-open.
describe('RecentFilesModal — a finger in the list', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const entries = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	// jsdom has no PointerEvent, and `pointerType` is the one field the panel reads:
	// a MouseEvent stands in for it, with the kind written on afterwards.
	const pointer = (type: string, kind: 'mouse' | 'touch') => {
		const ev = new MouseEvent(type, { bubbles: true });
		Object.defineProperty(ev, 'pointerType', { value: kind });
		return ev;
	};

	it('does not redraw the list when a finger leaves it', () => {
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		h.list().dispatchEvent(pointer('pointerover', 'touch'));
		h.list().dispatchEvent(pointer('pointerleave', 'touch'));

		// The rows are the SAME ELEMENTS as before the finger arrived: nothing was
		// rebuilt under the touch (see RecentFilesBrowser.thawOrder).
		expect(h.note('a')).toBe(row);
	});

	it('redraws it when a MOUSE leaves it, which is what the order is held for', () => {
		// The same two events from a pointing device are the panel's whole answer to
		// "is anybody reading this list?" — the order is taken on the way in and the
		// list catches up on the way out.
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		h.list().dispatchEvent(pointer('pointerover', 'mouse'));
		h.list().dispatchEvent(pointer('pointerleave', 'mouse'));

		expect(h.note('a')).not.toBe(row);
		expect(h.note('a').querySelector('.nav-row-name')?.textContent).toBe('a');
	});

	it('says nothing on hover for a finger', () => {
		// A finger does not hover: it presses, and the press takes the answer away
		// (see tip.ts). A tooltip raised by a touch's over would appear 400ms after a
		// finger that has already moved on, over a row the list may have redrawn.
		const h = harness(entries(), 1, files);

		h.note('a').dispatchEvent(pointer('pointerover', 'touch'));
		vi.advanceTimersByTime(TIP_DELAY_MS);

		expect(document.querySelector('.position-restore-nav-tip')).toBeNull();
	});
});
