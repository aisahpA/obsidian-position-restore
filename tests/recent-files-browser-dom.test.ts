// DOM-level tests for the recent-files browser's interaction semantics — the parts
// a reader cannot verify by reading a pure function: what a bare Enter does,
// which rows are selectable at all, the landing panel that describes a row, and
// the search box that is now the toolbar's only control.
// The pure pieces (describe/group/merge/filter/time) are covered in
// recent-files-browser.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keymap, MarkdownView, Platform, TFile } from 'obsidian';
// …and the menu's stand-in itself, which is reached by its own path rather than
// through 'obsidian' because the registry a test reads (Menu.shown) is the
// stub's and not the app's (see support/obsidian-stub).
import { Menu } from './support/obsidian-stub';
import type { HoverParent } from 'obsidian';

import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { RecentFilesBrowserPrefs } from '@/recent-files/browser/body';
import type { LandingsMode } from '@/recent-files/browser/listing';
import type { EphemeralState, PathDisplayMode, PreviewFocusMode } from '@/types';
import { navGroupKey, type NavEntry } from '@/nav/entry';
import { placeKey } from '@/recent-files/places';
import { ageLabel } from '@/recent-files/browser/model';
import { NAV_CONTEXT_RADIUS } from '@/position/capture/ephemeral';
import { DEFAULT_SETTINGS } from '@/types';
import type { NavEntryState } from '@/types';
import { t } from '@/i18n';
import {
	LATE_READ_REDRAW_MS,
	LONG_PRESS_MS,
	NAV_SOURCE_ID,
	PANEL_EXIT_GRACE_MS,
	ROW_PRESS_HOLD_MAX_MS,
	ROW_PRESS_MARK_MS,
	TIP_DELAY_MS,
} from '@/recent-files/browser/constants';

// jsdom has no PointerEvent, and `pointerType` is the one field the panel reads to tell a
// mouse from a finger: a MouseEvent stands in for it, with the kind written on afterwards.
// Shared by every suite that has to say WHICH pointer it is, because the panel answers the
// two differently on purpose (see body.ts's hover rules, RecentFilesList.hoverAt and
// tip.ts): a mouse hovering is a mouse reading, and a finger is about to tap.
// …and WHERE it is, which is the other half of what the panel reads: it asks the app for
// a page only when the pointer has MOVED, so two events at one place are one resting
// hand (a panel that came up under it), and an event a test does not place is put
// somewhere new. `held` says the hand did NOT move — the one case the panel has to tell
// apart from a move (see RecentFilesList.hoverAt).
let cursor = { x: 0, y: 0 };
const pointer = (type: string, kind: 'mouse' | 'touch' = 'mouse', held = false) => {
	if (!held)
		cursor = { x: cursor.x + 17, y: cursor.y + 11 };
	const ev = new MouseEvent(type, { bubbles: true, clientX: cursor.x, clientY: cursor.y });
	Object.defineProperty(ev, 'pointerType', { value: kind });
	return ev;
};
// A reader MOVING ONTO a row: the pointer was somewhere else — the list's edge, another
// row, wherever the hand was — and is now over this element. Two events, because what the
// panel hears is the MOVE and not the arrival: the first is the pointer as the panel first
// saw it (coming up under a hand that has not moved, which asks for nothing), the second
// is the hand moving onto the row.
const movedOnto = (el: HTMLElement, kind: 'mouse' | 'touch' = 'mouse') => {
	el.dispatchEvent(pointer('pointermove', kind));
	el.dispatchEvent(pointer('pointermove', kind));
};

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

// 'obsidian' resolves to tests/support/obsidian-stub.ts for the RUN TIME of this suite
// (see vitest.config.mts), but tsc reads its types from the real, typings-only
// package — which declares the two questions the plugin asks (isModEvent /
// isModifier) and nothing else. The stub's answers are INPUTS a test sets, so
// they are reached through one honest cast rather than pretended onto the app's
// class.
const KeymapKnobs = Keymap as unknown as {
	reset(): void;
	modEvent: unknown;
	modifier: boolean;
};

const MINUTE = 60_000;
const NOW = Date.now();

// A preference set for one harness (or for two, when a test wants to show that a
// choice made in the settings tab is the choice the next dialog opens on). The
// panel only READS them (see RecentFilesBrowserPrefs) — the values are the plugin's, and
// what changes them is the settings tab — so the fixture is a set of live readers
// over values a test can write, exactly as the settings tab writes them.
function prefs(start: {
	landings?: LandingsMode;
	path?: PathDisplayMode;
	time?: boolean;
	// The frontmatter property a row prints as the note's name, empty for none
	// (see PluginSettings.recentFilesTitleProperty).
	title?: string;
	// Where a hover preview opens the note (see PreviewFocusMode). 'head' is the
	// fixture's own default because it is the app's — a test that wants the note
	// opened at a line asks for it, which is also the honest reading of the four
	// tests below that assert a line was named.
	focus?: PreviewFocusMode;
} = {}) {
	const state = {
		landings: 'last' as LandingsMode,
		cap: 200,
		path: 'smart' as PathDisplayMode,
		time: false,
		title: '',
		focus: 'head' as PreviewFocusMode,
		...start,
	};
	return {
		state,
		browser: {
			landings: () => state.landings,
			// How far back the list reaches (see PluginSettings.recentFilesCap).
			placesCap: () => state.cap,
			// How much of a row's path is printed, and on which side of the name (see
			// PathDisplayMode).
			pathDisplay: () => state.path,
			// Whether each row is dated (see RecentFilesBrowserPrefs.rowTime).
			rowTime: () => state.time,
			// What a row calls the note (see reads.ts's titleOf): a test that wants
			// one named `title` passes it here and puts it in the files' cache.
			titleProperty: () => state.title,
			// Where a hover opens the note (see PreviewFocusMode): nothing here is
			// drawn from it, so a test passes it per hover rather than per panel.
			previewFocus: () => state.focus,
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
	entries: NavEntry[],
	index: number,
	files: Record<string, string> = {},
	deleted: string[] = [],
	live: Record<string, string> = {},
	headingMap: Record<string, unknown[] | Record<string, unknown>> = {},
	mobile = false,
	mtimes: Record<string, number> = {},
	// The saved positions the note rows are read from (see harness's own `saved`).
	saved: ((path: string) => EphemeralState | undefined) | undefined = undefined,
	// Where a hover opens the note (see PreviewFocusMode), for the suite whose rows
	// are places but whose SECTION comes from the headings above them.
	focus: PreviewFocusMode = 'head',
): ReturnType<typeof harness> {
	return harness(entries, index, files, deleted, live, headingMap, mobile, mtimes,
		prefs({ landings: 'all', focus }).browser, saved);
}

// A PLACE of the recent-files list, in the two shapes the store really produces
// (see places.ts): a step that carries a position is a JUMP the reader made — the
// only record that owns a landing — while a step without one is the FILE's own
// record, which is the note's row rather than a landing under it. A file record
// with a position is a shape the list never holds (the position database owns
// "where I left this file"), which is why this helper splits them.
const visit = (path: string, stamp: number, st?: NavEntryState): NavEntry => st
	? {
		kind: 'jump', path, leafId: 'leaf-1', t: stamp, st,
		key: `outline:## L${st.scroll ?? st.context?.[st.contextAt ?? 0]?.line ?? 0}`,
	} as NavEntry
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
	entries: NavEntry[],
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
	// paths held open in an editor. The panel's ROWS are drawn from the entries and
	// from nothing else — but a row's line number is re-found in the note as it stands
	// TODAY (see recent-files/browser/now-line.ts), and an open note's own buffer is the
	// best answer to that there is: it is ahead of the file on disk by whatever the
	// reader has typed and not saved. So the fake app hands these out through
	// `getLeavesOfType`, and a test that wants a note edited since the record was taken
	// says so here — which need not be the same text `files` holds for that path.
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
	// The position database's answer for a note (see RecentFilesBrowserOptions.
	// savedPosition): the line a plain open lands on, which is the line the note's OWN
	// row asks a preview for. Undefined by default, and deliberately so — a fixture
	// without one is a panel whose every note has no spot at all, which is what most of
	// this suite is about.
	saved: (path: string) => EphemeralState | undefined = () => undefined,
	// The rows the reader PINNED, as the store hands them over (see
	// NavPlaces.pinned): group keys, in the reader's own order. The array is
	// handed back to the test, so a test can pin a row the way the menu does
	// and then ask the panel to redraw (see `changed`).
	pinned: string[] = [],
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
				// A stat, as every TFile has one: the mtime is what a section chain read
				// out of the file's own text is remembered against (see reads.ts).
				file.stat = { ctime: 0, mtime: mtimes[path] ?? 0, size: 0 };
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
			// The leaves showing a markdown view: where a note's lines are read from when
			// it is OPEN (see shared/leaf.ts's markdownViewFor). The same tabs the walk
			// above sees, each with an editor that answers line by line.
			getLeavesOfType: (type: string) => type !== 'markdown' ? [] : tabs.map((tab) => {
				const lines = (live[tab.path] ?? '').split('\n');
				return {
					id: tab.leafId,
					view: Object.assign(Object.create(MarkdownView.prototype), {
						file: { path: tab.path },
						editor: {
							getValue: () => live[tab.path] ?? '',
							getLine: (n: number) => lines[n] ?? '',
							lastLine: () => lines.length - 1,
						},
					}),
				};
			}),
		},
	};
	// The modal reads Platform once, at construction: flip it for exactly that
	// long, so the tap semantics are decided the way a real device would.
	const previous = Platform.isMobile;
	Platform.isMobile = mobile;
	// The list's own removal (see body.ts's forgetRow): the panel hands the store a ROW's
	// identity and nothing else — the group key, which is a note's path or a view's type
	// (see nav/entry.ts's navGroupKey). The fixture answers it the way the store does —
	// every record the row was drawn from goes together, and the pointer is re-found
	// rather than left naming a slot that moved (see NavPlaces.forget / dropPlaces) — so
	// that a test can watch the row leave the screen rather than only the call being made.
	// The list is a fixture here (see above); the store's own rules are pinned in
	// recent-files-places.test.ts, and what this suite watches is the panel.
	const forget = vi.fn((key: string) => {
		const current = entries[index];
		for (let i = entries.length - 1; i >= 0; i--) {
			if (navGroupKey(entries[i]) === key)
				entries.splice(i, 1);
		}
		places.index = current && entries.includes(current) ? entries.indexOf(current) : -1;
	});
	// …and the same act on a LANDING's own row (see body.ts's forgetLanding): what goes
	// is ONE SPOT, named by the identity of every place that row stands for (see
	// RecentFilesList.landingKeys) — a row is a line, and two records that land on it
	// are one row, so a removal that named one of them would put the row straight back.
	const forgetLanding = vi.fn((keys: string[]) => {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (keys.includes(placeKey(entries[i])))
				entries.splice(i, 1);
		}
	});
	// …and the PIN, which the right-click menu writes (see body.ts's pinItems). The
	// fixture answers it the way the store does — the array IS the block, in the
	// reader's order — so a test can watch the row move rather than only the call.
	const pin = vi.fn((key: string) => {
		if (!pinned.includes(key))
			pinned.push(key);
	});
	const unpin = vi.fn((key: string) => {
		const at = pinned.indexOf(key);
		if (at >= 0)
			pinned.splice(at, 1);
	});
	// A move of ANY number of steps, the way the store answers one (see
	// NavPlaces.movePinned): a move past an end lands on it.
	const movePinned = vi.fn((key: string, delta: number) => {
		const at = pinned.indexOf(key);
		if (at < 0)
			return;
		const to = Math.min(Math.max(at + delta, 0), pinned.length - 1);
		if (to === at)
			return;
		pinned.splice(at, 1);
		pinned.splice(to, 0, key);
	});
	const places = {
		entries, index, travel: jumpTo, subscribe: () => () => {}, forget, forgetLanding, pinned,
		pin, unpin, movePinned, isPinned: (key: string) => pinned.includes(key),
	};
	let modal: RecentFilesModal;
	try {
		modal = new RecentFilesModal(app as never, places as never, saved, browserPrefs);
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
	// THE × A ROW CARRIES (see RecentFilesList.fileRow): the one control the list draws,
	// and the only way a reader takes a row off it. It is laid out OF the row's flow, so a
	// test finds it by its own class rather than by where it stands — jsdom lays nothing
	// out, and where it stands is the stylesheet's business (asserted in the styles suite).
	const forgetButton = (row: HTMLElement) =>
		row.querySelector<HTMLElement>('.nav-row-forget')!;
	return {
		modal, jumpTo, forget, forgetLanding, cachedRead, el: modal.contentEl, entries, list, pinned,
		pin, unpin, movePinned,
		trigger: app.workspace.trigger, cacheReads: () => cacheReads, changeFile,
		rows, notes, note, place, clickRow, pressRow, changed, rightClick, longPress, movePointer,
		key, hover, unhover, clearButton, clearFilter, forgetButton,
	};
}

beforeEach(() => {
	// The app's answers to "where should this open" and "is the modifier down" are
	// inputs a test sets per case (see the stub): one left over from the last case
	// would decide this one.
	KeymapKnobs.reset();
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
	it('shows the current note as a row like any other, with no dot of its own', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		// There is no second "you are here" anywhere: the card that used to stand
		// above the list said the same thing in a second place and a second layout,
		// and the row below is the authoritative one (see RecentFilesModal.render).
		expect(h.el.querySelector('.position-restore-nav-here')).toBeNull();

		// The current note is a row in the list like any other, and it leads because it
		// is the newest place here — and it carries no ●: the dot marks the LANDING that
		// holds the current entry (see RecentFilesList.placeRow), and a note's own
		// record is not a landing at all, nor does any note row here print landings.
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

		h.key('ArrowDown'); // c.md — the newest note, and the one the reader is in
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

		// c.md, b.md, a.md — the newest first: the list is the places' recency, the
		// current note included (see groupByFile).
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

		h.key('ArrowDown'); // c.md — the newest note, in sight
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
		h.key('ArrowDown'); // c.md — the newest note, and the one the reader is in
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
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:One', t: NOW - 3 * MINUTE, st: { scroll: 40 } } as NavEntry,
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:Two', t: NOW - 2 * MINUTE, st: { scroll: 400 } } as NavEntry,
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
		// on the note at the TOP where it is clicked most.
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
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:One', t: NOW - 3 * MINUTE, st: { scroll: 40 } } as NavEntry,
			{ kind: 'jump', path: 'b.md', leafId: 'leaf-2', key: 'outline:Two', t: NOW - 2 * MINUTE, st: { scroll: 400 } } as NavEntry,
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
	const entries = (): NavEntry[] => [
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
		// A landing row says nothing of the FILE: a spot is placed by the coordinate and
		// the section it prints, and the note's other names belong to the note rather than
		// to one spot in it (see placeRow / fileRow). It says nothing of the SECTION
		// either here, because this fixture's note has no headings at all — a row whose
		// chain is deeper than the two levels it prints says the whole chain on hover
		// (see the landing row suite).
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

	it('asks again about a file the cache has not answered yet', () => {
		// A sync replaces a note by removing the file and renaming the download over
		// it (see position/path-bookkeeping.ts), and the app fires NO 'changed' for a
		// rename — so a body that remembered the emptiness it saw in that moment went
		// on drawing a landing with no section chain at all until the body itself was
		// thrown away: a restart, or the dialog's next opening. Only ANSWERS are kept
		// now, so the very next render asks again — one map lookup — and the chain
		// comes back with no event behind it.
		const headings: Record<string, unknown[] | Record<string, unknown>> = {};
		const h = harnessAll([
			visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 6)),
			visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
			visit('b.md', NOW),
		], 2, { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' }, [], {}, headings);
		const trail = () => h.place('L7').querySelector('.nav-row-trail')?.textContent ?? '';

		expect(trail()).toBe(''); // nothing parsed yet: the row is its line alone

		headings['a.md'] = SPREAD_HEADINGS['a.md'];
		h.changed(); // any redraw will do — nothing told the panel the file changed

		expect(trail()).toBe('呈现方案›预览');
	});

	it('reads the chain out of the note itself when the cache has nothing', async () => {
		// The other half of the same sync, and the half that does not end: on a phone the
		// cache does not merely answer late, it may never answer at all — the note was
		// replaced under the app, and OPENING it does not make the app parse it either
		// (the editor reads the text, the cache does not). A body asked again every five
		// minutes and heard nothing every time, so the row stayed its line alone. The
		// text is right there, though: the chain is read out of it, one render late.
		const h = harnessAll([
			visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 6)),
			visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
			visit('b.md', NOW),
		], 2, { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' }, [], {}, {});
		const trail = () => h.place('L7').querySelector('.nav-row-trail')?.textContent ?? '';
		const reads = (path: string) => h.cachedRead.mock.calls.filter(c => c[0].path === path);

		expect(trail()).toBe(''); // the cache says nothing, and the row is drawn anyway

		// The read lands, and the redraw it owes the list comes with it (see
		// LATE_READ_REDRAW_MS).
		for (let i = 0; i < 10; i++)
			await Promise.resolve();
		vi.advanceTimersByTime(LATE_READ_REDRAW_MS);

		expect(trail()).toBe('呈现方案›预览');
		// ONCE, and not again: the reading is remembered against the mtime it was taken
		// at, which is the only clock an EXTERNAL change keeps — no event announces it.
		expect(reads('a.md')).toHaveLength(1);
		h.changed();
		expect(reads('a.md')).toHaveLength(1);
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

	it('shows no row for a current note whose file is gone', () => {
		// The reader may well be STANDING in the file that was just deleted (the tab is
		// still open in the app). The list still has no row for it: it lists what it can
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

		h.key('ArrowDown'); // the first row: the newest note, which is the one the reader is in
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
	const at = (path: string, line: number, agoMin: number): NavEntry =>
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

// jsdom lays nothing out, so the two questions the fit asks of a row — how wide the
// list is, and how much of a section level survived it — have to be answered for it
// (see RecentFilesList.fitTrails). Answered on the PROTOTYPE and not on the elements,
// because the rows the fit measures are the ones the render is drawing: an element a
// test could stub first does not exist yet. `answer` is asked on every read, so one
// test can render the same list at two widths.
function fakeLayout(answer: () => {
	list: number;
	// What the layout left of one level, by the text it prints: `whole` is the width
	// the level asks for, `shown` what the row could give it.
	level: (text: string) => { shown: number; whole: number };
}): () => void {
	const proto = Element.prototype;
	const kept = (['clientWidth', 'scrollWidth'] as const)
		.map(name => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
	const width = (el: Element, which: 'shown' | 'whole'): number => {
		if (el.classList.contains('position-restore-nav-list'))
			return answer().list;
		if (el.classList.contains('nav-trail-seg'))
			return answer().level(el.textContent ?? '')[which];
		return 0;
	};
	Object.defineProperty(proto, 'clientWidth', {
		configurable: true,
		get(this: Element) { return width(this, 'shown'); },
	});
	Object.defineProperty(proto, 'scrollWidth', {
		configurable: true,
		get(this: Element) { return width(this, 'whole'); },
	});
	return () => {
		for (const [name, saved] of kept)
			if (saved)
				Object.defineProperty(proto, name, saved);
	};
}

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

	it('labels every landing with the line it will OPEN', () => {
		// The list used to fold landings close enough together into one row, which printed
		// the NEWEST member's line while covering the rest: a click could reach only that
		// line, and the range the row covered survived as its tooltip. Every spot is a row
		// of its own now (see NavFileGroup), so the label IS the destination — and what a
		// row says on hover is the section chain it could not print, never the line (see
		// the tooltip's own test below).
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
		// …and a row opens the line it prints: the second one lands on the step behind
		// it. (The click is the last thing here for a reason: a travel closes the
		// dialog, and a row hovered after that answers nothing at all.)
		h.clickRow(rows[1]);
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('keeps the heading the landing line itself carries as the deepest level', () => {
		// an outline jump lands ON "### 预览". A row prints no landing text, so that
		// heading is the row's LAST level — the one a reader places the spot by — and it
		// stays in the chain.
		const jump = { kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:预览', t: NOW - MINUTE,
			st: captured(SPREAD_DOC, 4) } as NavEntry;
		const entries = [jump, visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)), visit('b.md', NOW)];
		const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS);

		expect(h.rows()[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
	});

	// WHAT A LANDING ROW SAYS ON HOVER (see RecentFilesList.placeRow): the row holds
	// the deepest two levels of the chain because it has one line of width, so a
	// landing three sections deep names the section and its parent and never the
	// chapter above them — and the chapter is the first thing a reader looking for a
	// place asks about. The chain is whole on hover, outermost first, the way the
	// note runs.
	it('says the whole chain on hover, and only where the row prints less than all of it', () => {
		const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);
		const rows = h.rows();

		// L7 sits under 面板设计 › 呈现方案 › 预览, and the row prints the last two.
		expect(rows[0].querySelector('.nav-row-trail')?.textContent).toBe('呈现方案›预览');
		const tip = h.hover(rows[0])!;
		expect(tip.querySelector('.nav-tip-text')?.textContent).toBe('面板设计 › 呈现方案 › 预览');
		// …and the tooltip is the chain and nothing else: the coordinate is on the row
		// and the note's name is on the row above it.
		expect(tip.querySelector('.nav-tip-path')).toBeNull();

	// L36 is the other half of the rule: its chain IS two levels, the row prints
	// both, so hover has nothing to add ABOUT THE CHAIN. The row is not silent,
	// though — it also says the line the landing was recorded on (see the quote's
	// own test below), which is the one thing about this place the row has never
	// printed.
	h.unhover(rows[0]);
	expect(rows[1].querySelector('.nav-row-trail')?.textContent).toBe('面板设计›尾巴');
	const plain = h.hover(rows[1])!;
	expect(plain.querySelector('.nav-tip-text')).toBeNull();
	expect(plain.querySelector('.nav-tip-quote')?.textContent)
		.toBe(`${t('recentFiles.landingLine')}最后一段`);
});

// WHAT A LANDING RECORDED AND NEVER PRINTED (see RecentFilesList.landingQuotes).
// The row says a coordinate and a section, and the search box matched the words the
// landing sat among — in silence, because those words are on screen nowhere at all.
// They are the one thing a query can hit that a reader cannot see, and they are what
// a landing's row could never answer before: what is this place, and why is it here.
it('says the line a landing was recorded on', () => {
	const entries = [
		visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 6)),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
		visit('b.md', NOW),
	];
	const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS);

	const tip = h.hover(h.place('L7'))!;
	expect(tip.querySelector('.nav-tip-quote')?.textContent)
		.toBe(`${t('recentFiles.landingLine')}预览条：悬停显示上下文三行`);
	// …and the chain stays where it was: a quoted line says what the place WAS,
	// not what it is called, and the reader still needs to know where it is.
	expect(tip.querySelector('.nav-tip-text')?.textContent).toBe('面板设计 › 呈现方案 › 预览');
});

it('says nothing more where nothing was recorded to quote', () => {
	// A place recorded before the block was captured carries a position and no
	// words (see NavEntryState.context): a tooltip is not a place to put a blank
	// line, so the row answers exactly as it did before.
	const entries = [
		visit('a.md', NOW - 2 * MINUTE, { scroll: 6 }),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 35)),
		visit('b.md', NOW),
	];
	const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS);

	const tip = h.hover(h.place('L7'))!;
	expect(tip.querySelector('.nav-tip-text')?.textContent).toBe('面板设计 › 呈现方案 › 预览');
	expect(tip.querySelector('.nav-tip-quote')).toBeNull();
	// …and the other landing, whose row prints the whole of its two-level chain
	// and was recorded on a line of its own, still has its own words to say.
	h.unhover(h.place('L7'));
	expect(h.hover(h.place('L36'))!.querySelector('.nav-tip-quote')?.textContent)
		.toBe(`${t('recentFiles.landingLine')}最后一段`);
});

it('names the line the query hit, ahead of the line the landing sat on', () => {
	// Two landings one line apart, so both of their blocks answer a query that
	// hits either: a note left with a single landing prints no landing rows at
	// all (see RecentFilesList.printsLandings), and there would be no row to ask.
	const entries = [
		visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 8)),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 9)),
		visit('b.md', NOW),
	];
	const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS);
	const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
	const quotes = () => Array.from(
		document.querySelectorAll('.position-restore-nav-tip .nav-tip-quote'),
	).map(q => q.textContent);

	// A line of the block that is NOT this landing's own: why this row survived a
	// query that says nothing about its name, its path or its section.
	box.value = '预览条';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	h.hover(h.place('L9'));
	expect(quotes()).toEqual([
		`${t('recentFiles.matchedLine')}预览条：悬停显示上下文三行`,
		`${t('recentFiles.landingLine')}正文第 1 行`,
	]);

	// …and when the hit IS the landing's own line, it is said once: the same words
	// twice under two labels is a tooltip that has stopped talking.
	h.unhover(h.place('L9'));
	box.value = '正文第 1 行';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	h.hover(h.place('L9'));
	expect(quotes()).toEqual([`${t('recentFiles.matchedLine')}正文第 1 行`]);
	// The row beside it, whose own line is the NEXT one, says both — the hit is the
	// same line for the two of them and the landing is not.
	h.unhover(h.place('L9'));
	h.hover(h.place('L10'));
	expect(quotes()).toEqual([
		`${t('recentFiles.matchedLine')}正文第 1 行`,
		`${t('recentFiles.landingLine')}正文第 2 行`,
	]);

	// A query the block never carried — this row matched on its own name.
	h.unhover(h.place('L10'));
	box.value = 'a.md';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	h.hover(h.place('L9'));
	expect(quotes()).toEqual([`${t('recentFiles.landingLine')}正文第 1 行`]);
});

it('says the note has been written since the line it quotes was taken', () => {
	// The quoted line is a photograph of the note as it stood the moment the place was
	// recorded, while the coordinate and the section the row prints are the note's as
	// it stands NOW. Nothing else on the row says the two may have parted, and an old
	// quote passing for a current one is the one thing this list can still get wrong
	// in silence — so the mtime the record kept is compared with the file's own.
	const taken = 1_000;
	const entries = [
		visit('a.md', NOW - 2 * MINUTE, { ...captured(SPREAD_DOC, 8), mtime: taken }),
		visit('a.md', NOW - MINUTE, { ...captured(SPREAD_DOC, 9), mtime: taken }),
		visit('b.md', NOW),
	];
	const notes = () => Array.from(
		document.querySelectorAll('.position-restore-nav-tip .nav-tip-note'),
	).map(n => n.textContent);

	// Written since: the file's clock is ahead of the one the record kept.
	const edited = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS, false,
		{ 'a.md': taken + 5_000 });
	edited.hover(edited.place('L9'));
	expect(notes()).toEqual([t('recentFiles.editedSince')]);
	// …and it stands UNDER the words it is about, and not among them: a quoted line
	// is the note's, this one is the panel's. (The row also says its whole section
	// chain here, which is why the note is last of three and not last of two.)
	const kinds = Array.from(
		document.querySelector('.position-restore-nav-tip')!.children,
	).map(c => c.className);
	expect(kinds.at(-1)).toBe('nav-tip-note');
	expect(kinds.indexOf('nav-tip-note')).toBeGreaterThan(kinds.lastIndexOf('nav-tip-quote'));
	edited.unhover(edited.place('L9'));

	// Untouched: the same clock, so the quote is the note as it stands.
	const same = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS, false, { 'a.md': taken });
	same.hover(same.place('L9'));
	expect(notes()).toEqual([]);
	same.unhover(same.place('L9'));

	// A clock that ran BACKWARDS — a sync putting an older copy back — says nothing
	// rather than claiming a rewrite that did not happen.
	const older = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS, false,
		{ 'a.md': taken - 500 });
	older.hover(older.place('L9'));
	expect(notes()).toEqual([]);
});

it('says nothing about the note when the record kept no time of its own', () => {
	// A record taken before the field existed, or by a read that had no file to stamp:
	// "unknown" is not "untouched", and a line claiming the note has been written has
	// nothing to stand on then. What is missing is that one line — the words it would
	// have spoken about are still there.
	const entries = [
		visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 8)),
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 9)),
		visit('b.md', NOW),
	];
	const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS, false, { 'a.md': 99_999 });
	h.hover(h.place('L9'));
	expect(document.querySelectorAll('.position-restore-nav-tip .nav-tip-note')).toHaveLength(0);
	expect(document.querySelectorAll('.position-restore-nav-tip .nav-tip-quote').length)
		.toBeGreaterThan(0);
});

it('says the line a query hit on the NOTE\'S ROW, when that row IS the place', () => {
	// A note's landings are printed under it only from two of them up (see
	// printsLandings): a note left with ONE place has no landing row at all, and its
	// own row is what stands for the place — the click goes there (see activeRep). That
	// is the case every filtered list is made of: a query that hit a sentence in a note
	// leaves one landing of one note on screen, and the words it matched were printed
	// nowhere. A row that opens a spot has to be able to say why the spot is here,
	// which is the whole of what a landing's own row does.
	const entries = [
		visit('a.md', NOW - MINUTE, captured(SPREAD_DOC, 8)),
		visit('b.md', NOW),
	];
	const h = harnessAll(entries, 1, files, [], {}, SPREAD_HEADINGS);
	const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
	const quotes = () => Array.from(
		document.querySelectorAll('.position-restore-nav-tip .nav-tip-quote'),
	).map(q => q.textContent);

	box.value = '预览条';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	expect(h.rows()).toHaveLength(0);
	expect(quotes()).toEqual([]);
	expect(h.hover(h.note('a'))).not.toBeNull();
	expect(quotes()).toEqual([
		`${t('recentFiles.matchedLine')}预览条：悬停显示上下文三行`,
		`${t('recentFiles.landingLine')}正文第 1 行`,
	]);
});

it('says nothing on a note\'s own row while that row is the FILE', () => {
	// The other half of the rule, and the reason the one above is a rule about the
	// row rather than about the note: a note whose own record is on the list is opened
	// the plain way by its row, and a plain open has no words recorded about it — the
	// record that carries them is the landing beside it, whose row is not on screen
	// because one place is not a list. The row says what it can say about the file.
	const entries = [
		visit('a.md', NOW - MINUTE),
		visit('a.md', NOW - 2 * MINUTE, captured(SPREAD_DOC, 8)),
		visit('b.md', NOW),
	];
	const h = harnessAll(entries, 2, files, [], {}, SPREAD_HEADINGS);
	const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
	box.value = 'a.md';
	box.dispatchEvent(new Event('input', { bubbles: true }));

	const tip = h.hover(h.note('a'))!;
	expect(tip.querySelector('.nav-tip-path')?.textContent).toBe('a.md');
	expect(tip.querySelector('.nav-tip-quote')).toBeNull();
});

	// THE SEPARATOR HANGS OFF THE LEVEL IT FOLLOWS rather than standing between the
	// two as a cell of its own: a cell keeps its width after the level in front of it
	// has been squeezed to nothing, and a row that had given up its outer level went
	// on printing a "›" with nothing to its left — standing where the deepest level,
	// the one the row is for, could have had the room (see styles.css's collapse
	// order). The row still READS the same, so nothing a reader looks at changed.
	it('hangs the separator on the level it follows, not between the two levels', () => {
		const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);
		const crumb = h.rows()[0].querySelector('.nav-row-trail')!;

		expect(crumb.textContent).toBe('呈现方案›预览');
		expect([...crumb.children].map(el => el.className))
			.toEqual(['nav-trail-seg', 'nav-trail-deep']);
		expect(crumb.querySelector('.nav-trail-sep')?.parentElement?.className)
			.toBe('nav-trail-seg');
	});

	// THE LEVEL A ROW COULD NOT PRINT (see RecentFilesList.fitTrails). A row is drawn
	// before anything has been measured, so the stylesheet can only SQUEEZE the outer
	// level of a chain — and what a squeeze leaves is a FRAGMENT: it names no section,
	// and the level beside it reads on regardless (the deepest level takes the width
	// its own text needs, however narrow the row gets). Past half of it, the fragment
	// is not worth the room it reads in; the pass reads the layout back and takes it
	// off the row, and what the row let go of is one hover away.
	//
	// (With no layout at all — every test above — nothing is dropped: a row that has
	// not been measured keeps both of its levels, which is what the rows above print.)
	it('takes off the outer level the row could not print, and says it on hover', () => {
		// L36's chain IS two levels, so its row prints both until the layout says
		// otherwise — the only row that can show what the pass lends a row, since L7's
		// three-level chain already has the whole chain on its hover.
		let squeezed = true;
		const restore = fakeLayout(() => ({
			list: 300,
			// a third of the level survived: "面板…" where the row needs "面板设计"
			level: (text) => (squeezed && text === '面板设计›'
				? { shown: 26, whole: 80 }
				: { shown: 80, whole: 80 }),
		}));
		try {
			const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);

			// The level is off the row — the row is its deepest level alone, which is
			// what the stylesheet does with the class (see the styles suite).
			expect(h.rows()[1].classList.contains('is-deep-only')).toBe(true);
			const tip = h.hover(h.rows()[1])!;
			expect(tip.querySelector('.nav-tip-text')?.textContent).toBe('面板设计 › 尾巴');

			// A row whose level fits keeps it, and hover says what it always said.
			h.unhover(h.rows()[1]);
			expect(h.rows()[0].classList.contains('is-deep-only')).toBe(false);
			expect(h.hover(h.rows()[0])!.querySelector('.nav-tip-text')?.textContent)
				.toBe('面板设计 › 呈现方案 › 预览');

			// …and a pane that GREW: the next render prints the level again, and the
			// words the pass lent the row are the row's own once more — a tooltip left
			// behind would repeat the row it is standing over. What is left is the
			// line the landing was recorded on, which was never the pass's to lend.
			h.unhover(h.rows()[0]);
			squeezed = false;
			h.changed();
			expect(h.rows()[1].classList.contains('is-deep-only')).toBe(false);
			const grown = h.hover(h.rows()[1])!;
			expect(grown.querySelector('.nav-tip-text')).toBeNull();
			expect(grown.querySelector('.nav-tip-quote')?.textContent)
				.toBe(`${t('recentFiles.landingLine')}最后一段`);
		} finally {
			restore();
		}
	});

	it('puts the coordinate before the section, with the row\'s own controls after it', () => {
		// The row used to be name | section | small print (pane, coordinate, age) with
		// the age in a measured column of its own. The note is the row now, so a landing
		// is coordinate | section | controls — and the controls are last and out of the
		// flow (see .nav-row-actions), because a landing carries the same × a note does.
		const h = harnessAll(body(), 2, files, [], {}, SPREAD_HEADINGS);

		const row = h.rows()[1];
		expect([...row.children].map(el => el.className))
			.toEqual(['nav-row-pos', 'nav-row-trail', 'nav-row-actions']);
		// …and no time while the reader has not asked for one: the setting is off in
		// this harness, and nothing in the list prints a time of its own accord.
		expect(row.querySelector('.nav-row-time')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-list .nav-row-time')).toBeNull();
	});

	it('gives a landing its OWN time — the last visit to that spot, not to the note', () => {
		// A note's row is stamped with the NEWEST of its places (see fileRow), which
		// answers "when was I in this file" and not "when was I here": a spot the
		// reader has not been back to keeps the time it earned, and that is the moment
		// the words its row quotes were captured at.
		const spots = [
			visit('x.md', NOW - 30 * MINUTE, captured(SPREAD_DOC, 6)),
			visit('x.md', NOW - 10 * MINUTE, captured(SPREAD_DOC, 35)),
			visit('y.md', NOW),
		];
		const h = harness(spots, 2, { 'x.md': '', 'y.md': '' }, [], {}, SPREAD_HEADINGS,
			false, {}, prefs({ landings: 'all', time: true }).browser);
		const time = (row: HTMLElement) => row.querySelector<HTMLElement>('.nav-row-time');

		// The note says the newest of the two spots; each spot says its own visit.
		expect(time(h.note('x'))?.textContent).toBe(ageLabel(NOW - 10 * MINUTE, Date.now()));
		expect(time(h.place('L7'))?.textContent).toBe(ageLabel(NOW - 30 * MINUTE, Date.now()));
		expect(time(h.place('L36'))?.textContent).toBe(ageLabel(NOW - 10 * MINUTE, Date.now()));
		// …and the row's shape follows the label it was built with, as a note's does.
		expect(h.place('L7').classList.contains('is-timed')).toBe(true);

		// The exact moment is one hover away, ON THE LABEL: hovering anywhere else on
		// the row says what the place was (see placeRow).
		h.unhover(h.place('L7'));
		expect(h.hover(time(h.place('L7'))!)?.textContent)
			.toBe(new Date(NOW - 30 * MINUTE).toLocaleString());
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
	const stack = (): NavEntry[] => [
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
		badge: row.querySelector('.nav-file-tag')?.textContent,
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

	it('marks a pathless view, and says nothing else about it', () => {
		// The graph is a view and not a file: it has no type to mark and no path to
		// print or to hover — its name is the view's own label, or this list's wording
		// for a view that has none (see model.ts's viewName). What the row DOES print
		// is the mark that tells a view from a note (see list.ts's fileRow), and a view
		// that named no icon is marked with a WORD rather than a stand-in glyph.
		const h = harness([
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
			...stack(),
		], 6, files);

		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		expect(graph).toBeDefined();
		expect(attr(graph)).toEqual({ name: t('recentFiles.graphView'), badge: t('recentFiles.viewBadge'), path: undefined });
		expect(graph.querySelector('.nav-row-view-icon')).toBeNull();
		expect(h.hover(graph)).toBeNull();
	});

	it('draws the icon a view named for itself, in place of the word', () => {
		// A view is asked for its icon the way it is asked for its name (see
		// shared/leaf.ts's viewIcon): the row then wears the same mark the reader saw
		// on that view's tab, without this plugin knowing which plugin it was. The
		// word is what that mark REPLACES — the two never stand together.
		const h = harness([
			{ kind: 'view', viewType: 'thino_view', label: 'Thino', icon: 'git-fork', leafId: 'leaf-1', t: NOW } as NavEntry,
			...stack(),
		], 6, files);

		const row = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === 'Thino')!;
		expect(row).toBeDefined();
		expect(attr(row).badge).toBeUndefined();
		const mark = row.querySelector('.nav-row-view-icon')!;
		expect(mark.querySelector('svg')?.getAttribute('data-icon')).toBe('git-fork');
		// Named for the reader who cannot see the glyph: the icon stands for the same
		// word the fallback would have printed.
		expect(mark.getAttribute('aria-label')).toBe(t('recentFiles.viewBadge'));
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
	const stack = (): NavEntry[] => [
		visit('notes.md', NOW - 3 * DAY),
		{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW - 2 * HOUR } as NavEntry,
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

		// The order is the rows' own ages: a/index.md (5m), then the graph (2h), then
		// notes.md (3d). A view is a place with a time like any other, so it stands
		// where that time puts it — not at the foot of the list (see groupByFile).
		expect(h.notes()).toHaveLength(3);
		expect(times(h)).toEqual(['5m ago', '2h ago', '3d ago']);
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
		const label = h.note('notes').querySelector<HTMLElement>('.nav-row-time')!;

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
	const entries = (): NavEntry[] => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	// A note with a LANDING and no file record — the shape a note has once its `visit`
	// has been evicted while the jumps made inside it survive (see places.ts). Its row
	// still opens the landing (see activeRep), so it is the row that can promise a
	// SPOT rather than a file.
	const jumped = (): NavEntry[] => [
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
		KeymapKnobs.modEvent = 'tab';
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
		h.key('ArrowDown'); // b.md, the current note — and, being the newest, the first row
		h.key('ArrowDown'); // a.md
		KeymapKnobs.modifier = true;
		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('hands the app a menu for a file row, with its own items on top', () => {
		// The menu is the app's — what a reader can do with a file is not this plugin's
		// business — and what is added is what the app cannot know: this row stands for a
		// PLACE, so "open in a new tab" here means this note, at the spot the row stands
		// for; and whether the note is pinned, which is this list's own answer and nobody
		// else's. Taking the row off the list is no longer in here: that is the × the row
		// carries, which needs no file to be about (see the two tests below).
		const h = harness(entries(), 1, files);
		const ev = h.rightClick(h.note('a'));

		expect(ev.defaultPrevented).toBe(true); // the long-press callout must not rise
		const menu = menuOf(h.trigger);
		expect(menu.items.map(i => i.title))
			.toEqual([t('recentFiles.openInNewTab'), t('recentFiles.pin')]);
		expect(menu.items[0].title).toBe(t('recentFiles.openInNewTab'));
		expect(menu.items[0].section).toBe('action');
		expect(menu.items[0].icon).toBe('external-link');
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

	it('takes the row off the list from the × on it', () => {
		// The one write the panel makes (see body.ts's forgetRow), and it goes to the list
		// and no further: the file itself, and the position database, are untouched (see
		// NavPlaces.forget). The row has to leave the screen as it goes — a × that left it
		// standing would read as having done nothing.
		const h = harness(entries(), 1, files);
		const names = () => h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);
		expect(names()).toContain('a');

		h.clickRow(h.forgetButton(h.note('a')));

		// …and that click OPENED nothing: the × answers it and the row does not (see
		// RecentFilesList.fileRow — the two gestures are one row apart).
		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.forget).toHaveBeenCalledWith('a.md');
		// …and only that row: the note removed is the one that was NOT current, so the list
		// is one note shorter and the position is still on b.md.
		expect(names()).not.toContain('a');
		expect(names()).toEqual(['b']);
	});

	it('does not open the note when the reader reaches for the ×', () => {
		// The press and the click are stopped AT the × rather than left to bubble (see
		// RecentFilesList.fileRow): with the press let through, the row would be recorded as
		// pressed and the release would open the file the reader was trying to drop — the
		// one outcome the × exists to be told apart from.
		const h = harness(entries(), 1, files);
		const button = h.forgetButton(h.note('a'));

		h.pressRow(button);
		h.clickRow(button);

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.forget).toHaveBeenCalledWith('a.md');
	});

	it('says WHICH place its own item opens, on a row that stands for a landing', () => {
		// A row whose note has no file record of its own opens the LANDING it stands for
		// (see activeRep), so "open in a new tab" would be a promise the row does not
		// keep: it is opened HERE, at that spot.
		const h = harness(jumped(), 1, files);
		h.rightClick(h.note('a'));

		const menu = menuOf(h.trigger);
		expect(menu.items[0].title).toBe(t('recentFiles.openHereInNewTab'));
		menu.items[0].click!();
		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('raises its OWN menu for a pathless view, and asks the app about nothing', () => {
		// The graph is not a file, so there is no file menu for it to be about: what
		// comes up is this list's own two items, and NO `file-menu` event is sent —
		// the app would be asked to speak about a file that does not exist.
		const h = harness([
			visit('a.md', NOW - MINUTE),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
		], 1, files);
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		const ev = h.rightClick(graph);

		expect(ev.defaultPrevented).toBe(true);
		expect(h.trigger).not.toHaveBeenCalled();
		// …and it was put on the screen, which is the only way to read a menu no
		// event was raised for (see obsidian-stub's Menu.shown).
		const menu = Menu.shown.at(-1)!;
		expect(menu.shownAt).toBeDefined();
		expect(menu.items.map(i => i.title))
			.toEqual([t('recentFiles.openInNewTab'), t('recentFiles.pin')]);
	});

	it('gives a pathless view the same × a note gets, since its row is a row', () => {
		// The graph is refused a FILE menu — there is no file for one to be about — and
		// while the removal lived in that menu, the refusal left it no way off the list at
		// all. The × needs no file, so every row carries one (see RecentFilesList.fileRow).
		const h = harness([
			visit('a.md', NOW - MINUTE),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
		], 1, files);
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

		h.clickRow(h.forgetButton(graph));

		// The store hears the row's own identity: a view is named by its TYPE, which is
		// exactly what a path cannot say (see nav/entry.ts's navGroupKey).
		expect(h.forget).toHaveBeenCalledWith('view:graph');
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
		// …and THE NAME AND ITS MARK are one piece: two siblings would let the cell
		// wrap between them, printing the type on a line of its own under the name it
		// belongs to (see styles.css's .nav-row-head). The folder is the cell's other
		// half.
		expect([...index.querySelector('.nav-row-file')!.children].map(el => el.className))
			.toEqual(['nav-row-head', 'nav-row-path']);
		expect([...index.querySelector('.nav-row-head')!.children].map(el => el.className))
			.toEqual(['nav-row-name']);
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
	const withBlock = (extra: NavEntryState = {}): NavEntry =>
		visit('a.md', NOW - MINUTE, blockState(extra));
	const files = { 'a.md': 'live ten\nlive eleven\nlive twelve', 'b.md': '' };
	// A step made by clicking a plain [[link]]: keyless, so it keeps an origin.
	const linkVisit = (viaPath: string, viaText: string, st?: NavEntryState): NavEntry =>
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

// A FINGER THAT STOPPED ON A ROW — what a hover is on a device that has none (see
// long-press.ts). The row answers for itself: the words it cannot print, and the two
// things THIS panel knows about it that the app cannot. Everything below is heard from
// a TOUCH harness, because a desktop's hover already answers all of it and needs none
// of this — which is what the last-but-one test here says.
describe('RecentFilesModal — a finger that stopped on a row', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const entries = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	const tip = () => document.querySelector<HTMLElement>('.position-restore-nav-tip');
	const phone = () => harness(entries(), 1, files, [], {}, {}, true);
	const timed = () =>
		harness(entries(), 1, files, [], {}, {}, true, {}, prefs({ time: true }).browser);
	// The three events a long press is made of, placed by hand: the gesture is judged by
	// WHERE the finger came down and whether it stayed there (see long-press.ts), so a
	// test cannot borrow the pointer helper that walks the cursor along.
	const finger = (el: HTMLElement, type: string, at = { x: 40, y: 40 }) =>
		el.dispatchEvent(
			new MouseEvent(type, { bubbles: true, button: 0, clientX: at.x, clientY: at.y }),
		);
	const down = (el: HTMLElement) => finger(el, 'pointerdown');
	const lift = (el: HTMLElement) => finger(el, 'pointerup');
	// …and the clock, which is the whole of what makes a press a long one rather than a
	// tap or the beginning of a scroll.
	const rest = () => vi.advanceTimersByTime(LONG_PRESS_MS);
	// The menu the panel handed the app, as the app's own event carries it (see
	// RecentFilesBrowser.contextRow): the armed row's second control is the only door a
	// phone has to it, the long press having become the row's own gesture.
	const menuOf = (trigger: unknown) => {
		const calls = (trigger as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls).toHaveLength(1);
		return calls[0][1] as {
			items: { title: string; icon: string; click?: () => void }[];
			shownAt?: { x: number; y: number };
			hidden: boolean;
			closed: boolean;
			hide(): void;
		};
	};
	// A FINGER HAS NO HOVER TO GO BY: between the finger coming down and the travel
	// going through, nothing on the row changes at all — and the travel is not the end
	// of it either, because on a phone the drawer folds away behind it. So the press
	// itself is what the row answers with (see list.ts's markPressed).
	it('marks the row a finger pressed, for as long as the reader can still see it', () => {
		const h = phone();
		const row = h.note('b');

		down(row);

		expect(row.classList.contains('is-pressed')).toBe(true);
		// …and NOT the row beside it: one finger, one press, one mark.
		expect(h.note('a').classList.contains('is-pressed')).toBe(false);

		// The finger comes up and the travel goes through, and the mark is STILL there
		// while the drawer folds away behind it (see PANEL_EXIT_GRACE_MS) — that is the
		// whole of the time the reader has to see which line they hit.
		lift(row);
		vi.advanceTimersByTime(PANEL_EXIT_GRACE_MS);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// …and then it goes BY ITSELF rather than waiting for anything else: a mark
		// that stayed would be a mark on a row the reader is no longer pointing at.
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS);
		expect(row.classList.contains('is-pressed')).toBe(false);

		// …and a gesture the platform took AWAY is not one the reader finished, so it
		// takes the mark with it at once rather than leaving the row lit for a beat it
		// did not earn.
		down(row);
		finger(row, 'pointercancel');
		expect(row.classList.contains('is-pressed')).toBe(false);
	});

	// The mark is ended by the LIFT and not by a moment fixed when the finger went
	// down: a finger that is still resting on its way to becoming a long press is a
	// finger the reader is still pointing with, and a mark that blinked out halfway
	// through would say the row had stopped answering (see list.ts's releaseMark).
	it('keeps the mark lit for the whole of a long press', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		// The beat a TAP's mark is given, and not the end of this one: the finger is
		// still down.
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// …and then the press becomes an arm, with the mark still on the row.
		rest();
		expect(row.classList.contains('is-armed')).toBe(true);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// …and the finger coming UP does not take it: the reader lifted it to reach for
		// what the arm put on the row, so the mark lasts as long as the arm does.
		lift(row);
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS * 2);
		expect(row.classList.contains('is-pressed')).toBe(true);
	});

	// …while a finger the platform never reported coming up does not leave a row lit
	// for good: the mark has a latest moment of its own (see ROW_PRESS_HOLD_MAX_MS).
	it('lets the mark go when the finger never came up at all', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		// Not a long press after all: the finger left the spot it came down on (see
		// LONG_PRESS_SLOP_PX), so nothing arms the row and nothing holds the mark.
		finger(row, 'pointermove', { x: 240, y: 240 });
		vi.advanceTimersByTime(ROW_PRESS_HOLD_MAX_MS);

		expect(row.classList.contains('is-armed')).toBe(false);
		expect(row.classList.contains('is-pressed')).toBe(false);
	});

	// …and it belongs to the ROW and not to the list, so it does not outlive one: the
	// travel the press asked for redraws the list, and the row drawn in its place is a
	// row the reader never pressed.
	it('takes the mark off with the row it was put on', () => {
		const h = phone();
		down(h.note('b'));
		expect(h.note('b').classList.contains('is-pressed')).toBe(true);

		h.clickRow(h.note('b'));

		expect(h.jumpTo).toHaveBeenCalled();
		expect(h.note('b').classList.contains('is-pressed')).toBe(false);
	});

	// …and a press does not stop being a press when it becomes an arm: the finger is
	// still on the row the whole time the arm is standing.
	it('keeps the mark under a finger that rested, and lets it go with the arm', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();

		// The clock that was going to take the mark off was set for a tap (see
		// ROW_PRESS_MARK_MS), and this was not one.
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS * 2);
		expect(row.classList.contains('is-armed')).toBe(true);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// …and the two go together: tapping another row takes the arm off this one, and
		// a mark left standing on it would be a mark on a row nobody is pointing at.
		h.pressRow(h.note('a'));
		h.clickRow(h.note('a'));
		expect(row.classList.contains('is-armed')).toBe(false);
		expect(row.classList.contains('is-pressed')).toBe(false);
	});

	it('arms the row a finger stopped on, and says what the row cannot print', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();

		expect(row.classList.contains('is-armed')).toBe(true);
		// The words are the ones a hover earns, and they are up AT ONCE: the finger has
		// already been resting for the whole of the press, which is longer than a mouse
		// is ever asked to wait (see tip.ts's speak).
		expect(tip()?.querySelector('.nav-tip-path')?.textContent).toBe('b.md');
		// …and ONE row is armed, because one finger can only stop on one.
		expect(h.note('a').classList.contains('is-armed')).toBe(false);
	});

	it('says the moment behind the age, when the finger stopped on the time', () => {
		// Which element the finger came down on decides WHICH of the two things the row
		// says, exactly as it does for a pointer (see tip.ts's subject): the time answers
		// for the moment behind it, and the row answers for which file this is.
		const h = timed();

		down(h.note('b').querySelector<HTMLElement>('.nav-row-time')!);
		rest();

		expect(tip()?.querySelector('.nav-tip-path')).toBeNull();
		expect(tip()?.querySelector('.nav-tip-text')?.textContent)
			.toBe(new Date(NOW).toLocaleString());
	});

	it('opens nothing on the click a long press delivers when the finger lifts', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		// The finger coming up is not the pointer leaving the row — a touch pointer
		// ceases to exist when it does, and the browser says `out` all the same — so the
		// words the press earned have to outlive it: the reader lifted the finger to
		// reach for what the press put on the row, not because they stopped looking.
		lift(row);
		row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
		expect(tip()).not.toBeNull();

		// …and the click the browser may still deliver is the press's own tail rather
		// than a second gesture: a reader who stopped on a row did not ask to go there.
		h.clickRow(row);

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('arms nothing when the finger was only beginning to scroll', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		// A drag and not a rest: the finger left the spot it came down on by more than
		// the slop a resting finger is allowed (see LONG_PRESS_SLOP_PX).
		finger(row, 'pointermove', { x: 240, y: 240 });
		rest();

		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('takes the row off the list from the × the arm put on it', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		// The press's own tail, which the lift delivers before any tap of the reader's
		// (see the test below): it is answered by nobody.
		lift(row);
		h.clickRow(row);
		h.clickRow(h.forgetButton(row));

		// The row's own identity, carried by the control rather than worked out from an
		// index a redraw may have moved (see RecentFilesList.fileRow).
		expect(h.forget).toHaveBeenCalledWith('b.md');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('raises the app\'s menu from the control the arm put on it', () => {
		// The menu a desktop gets from a right-click (see body.ts's contextRow): the app's
		// own actions for the file, with this panel's one item on top of them. On a phone
		// the long press that used to raise it arms the row instead, so the menu comes
		// back on the armed row's own control rather than behind the press.
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		// The finger comes up, and the browser clicks whatever is under it — the
		// press's own tail, which opens nothing (see the test above).
		lift(row);
		h.clickRow(row);
		// …and THEN the reader taps the control the press put on the row.
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);

		const menu = menuOf(h.trigger);
		expect(menu.items[0].title).toBe(t('recentFiles.openInNewTab'));
		// …and it was OPENED, and placed at the control the reader tapped rather than at
		// wherever the platform said the tap happened: a menu merely built is a menu
		// nobody can see, and one placed at the screen's corner is a menu to go looking
		// for (see RecentFilesList.menuControl).
		expect(menu.shownAt).toBeDefined();
		// NOTHING TRAVELLED, and that is the whole of the difference from the shortcut
		// this control used to be: the menu is a question, and opening the row one tab
		// over is one of its answers rather than the tap's.
		expect(h.jumpTo).not.toHaveBeenCalled();
		// …and the arm stays on the row behind the menu: it is still the row the reader
		// was reaching into when the menu closes.
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('opens the row one tab over from the menu\'s own item, on a phone as on a desktop', () => {
		// The one thing the app cannot know about this row (see body.ts's contextRow) is
		// still one tap away: it is the first item of the menu the control raises.
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);

		menuOf(h.trigger).items[0].click!();
		expect(h.jumpTo).toHaveBeenCalledWith(1, 'tab');
	});

	it('takes the menu with it when the panel itself closes', () => {
		// The menu is put on the DOCUMENT and not into the panel's element, so a shell
		// that closes takes none of it with it: a dialog closed under an open menu
		// would leave the app's menu standing over nothing at all (see
		// RecentFilesBrowser.destroy).
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);
		const menu = menuOf(h.trigger);

		h.modal.close();

		expect(menu.closed).toBe(true);
	});

	it('takes the menu back when the control that raised it is tapped again', () => {
		// ONE DOOR, TWO ENDS. The app cannot answer this tap: the control stops its own
		// press so that reaching for it does not open the note (see menuControl), and a
		// press the document never hears is a press that cannot close the app's menu
		// from outside it. So the tap is the answer itself — and raising the menu again
		// in the same breath would be a menu that never went away, which reads as a
		// control that does nothing.
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(more());
		const menu = menuOf(h.trigger);
		expect(menu.closed).toBe(false);

		// …and the SAME control again — a finger comes DOWN on it first, which is where
		// the question is asked and not at the click it delivers.
		down(more());
		h.clickRow(more());

		expect(menu.closed).toBe(true);
		// …and the app was not asked for a second one: a tap that took the menu back is
		// not a tap that asked for another.
		expect((h.trigger as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
		// …and the ARM IS STILL ON THE ROW: the menu was a question, and the × may yet
		// be the answer the reader was reaching for.
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('takes the menu back when the press lands on the menu\'s own surface', () => {
		// THE TABLET CASE, and the whole of why the control cannot answer it alone. When
		// there is no room below the point it was given, the app moves a menu UP BY ITS
		// OWN HEIGHT — over the row, and over the very control that raised it. A finger
		// aiming at the control then lands on the menu, and the app answers a press there
		// with nothing: only the backdrop beside the menu closes it, and only on a click.
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(more());
		const menu = menuOf(h.trigger);
		expect(menu.closed).toBe(false);

		// …and the menu is standing where the control was, so the finger lands on it.
		const surface = document.body.createDiv({ cls: 'menu' });
		down(surface);

		expect(menu.closed).toBe(true);
		surface.remove();
	});

	it('leaves the menu alone when the press lands on one of its items', () => {
		// The one press that must NOT take the menu away: choosing an item is the menu's
		// own answer, and a menu pulled out from under the press would take the item with
		// it — a tap that resolves to nothing at all.
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);
		const menu = menuOf(h.trigger);

		const item = document.body.createDiv({ cls: 'menu-item' });
		down(item);

		expect(menu.closed).toBe(false);
		item.remove();
	});

	it('raises a menu again after the app took the last one off itself', () => {
		// An item chosen on it, or a tap away from it: the app's own gestures, and the
		// app's own menu to take off the screen. From that moment the panel owes it
		// nothing — and the control goes back to RAISING one, because a tap that takes a
		// menu back only means that while one is standing (see contextRow).
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(more());
		menuOf(h.trigger).hide();

		// …and the same control again, now asking for a menu rather than for one to go.
		h.clickRow(more());

		expect((h.trigger as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2);
	});

	it('opens nothing when the press\'s own click lands on a control it put there', () => {
		// The controls arrive at the row's far end — which is where the finger may
		// already be resting. The click the lift then delivers is the press's tail and
		// not a second gesture: a reader who stopped on a row did not ask for its menu,
		// and above all did not ask to DROP it (see the × in fileRow).
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		h.clickRow(more());

		expect(h.trigger).not.toHaveBeenCalled();
		expect(h.forget).not.toHaveBeenCalled();
		// …and the arm is still on the row: the reader was reaching for it.
		expect(row.classList.contains('is-armed')).toBe(true);

		// The NEXT tap is the reader's own — and a tap is a finger coming DOWN first,
		// which is what spends the claim the press was holding (see long-press.ts's
		// release, and the test below).
		down(more());
		h.clickRow(more());
		expect(menuOf(h.trigger).items[0].title).toBe(t('recentFiles.openInNewTab'));
	});

	it('answers the first tap after a press whose own click NEVER came', () => {
		// Whether the tail of a long press is delivered at all is the platform's
		// business: a WebView that raised a menu for the press, or a finger that
		// drifted past the slop on its way up, may deliver no click with it. The
		// claim then OUTLIVES the press that made it — and the controls stop their
		// own presses from reaching the gesture (see RecentFilesList.fileRow), so
		// nothing reset it: the reader's first tap on a control did nothing, and the
		// tap after it landed on a row that had been disarmed under them and opened
		// the note. A finger arriving anywhere on the row's controls spends it.
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		// …and no click: the platform delivered nothing for the finger coming up.

		down(more());
		h.clickRow(more());

		expect(menuOf(h.trigger).items[0].title).toBe(t('recentFiles.openInNewTab'));
	});

	it('answers the first tap on the × after such a press, too', () => {
		// The same claim, on the control that is not survivable: a reader who stopped
		// on a row and then aimed at its × got nothing, and the tap after it opened
		// the note they were trying to drop.
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);

		down(h.forgetButton(row));
		h.clickRow(h.forgetButton(row));

		expect(h.forget).toHaveBeenCalledWith('b.md');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('opens nothing when a tap lands on the strip beside the controls', () => {
		// Two targets side by side are missed by a finger that drifts — and a finger
		// that comes down on one and lifts over the other has clicked NEITHER: the
		// browser clicks their nearest common ancestor, which without the strip's own
		// answer is the ROW (see RecentFilesList.actionStrip). A miss is a miss:
		// nothing opens, and the arm waits for the reader to aim again.
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-actions')!);

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('disarms the row when the reader taps another one', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		h.pressRow(h.note('a'));
		h.clickRow(h.note('a'));

		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
		// One row at a time, and the words go with it: an armed row that has stopped
		// saying anything is a row the reader has to guess at.
		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('disarms it on a scroll, and on a redraw', () => {
		// A scroll takes the rows out from under words that are standing still, and a
		// redraw throws away the row the finger stopped on: a × left standing on the row
		// drawn in its place would be a control for a row nobody armed.
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		h.list().dispatchEvent(new Event('scroll'));
		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();

		down(row);
		rest();
		h.changed();
		expect(h.note('b').classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('arms it from the menu event a WebView raises for the same finger', () => {
		// A long press arrives as a `contextmenu` on some platforms and not on others
		// (see long-press.ts), so both doors are open and the arm is idempotent: what
		// matters is that the row is armed either way, and that the app's file menu is
		// NOT raised — on a phone the press is the ROW's answer, not the file's.
		const h = phone();
		const row = h.note('b');

		const ev = h.longPress(row);

		expect(row.classList.contains('is-armed')).toBe(true);
		// …and the press is still refused, or the platform's own selection callout would
		// come up over the row while the reader is waiting for it to answer.
		expect(ev.defaultPrevented).toBe(true);
		expect(h.trigger).not.toHaveBeenCalled();
	});

	it('arms nothing on a desktop, where a rest is a hover', () => {
		// The gesture is not heard at all where a pointer can hover: the controls are
		// already on the row the pointer is over, and so are the words.
		const h = harness(entries(), 1, files);
		const row = h.note('b');

		down(row);
		rest();

		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('puts the row\'s menu on a note and on its landings, and the × on both', () => {
		// A landing is a record of its own on this list now, so it carries the same
		// removal the note's row does — what its × takes off is the SPOT, and the note's
		// row above stays (see onForgetLanding). The two rows say so differently: the
		// note's × is "remove from recent files", the spot's is "remove this place", and
		// a reader pointing at one of them is never guessing which one they got.
		//
		// The menu goes on both for the reason it always did: the spot IS a place a
		// reader can ask for one tab over, and only this panel knows which place that is.
		const spots = [
			visit('x.md', NOW - 30 * MINUTE, { scroll: 100 }),
			visit('x.md', NOW - 10 * MINUTE, { scroll: 412 }),
			visit('y.md', NOW),
		];
	const h = harnessAll(spots, 2, { 'x.md': '', 'y.md': '' }, [], {}, {}, true);
	const note = h.note('x');
	const landing = h.rows()[0];

	expect(note.querySelector('.nav-row-forget')).not.toBeNull();
	expect(note.querySelector('.nav-row-menu')?.getAttribute('aria-label'))
		.toBe(t('recentFiles.rowMenu'));
	expect(landing.querySelector('.nav-row-forget')?.getAttribute('aria-label'))
		.toBe(t('recentFiles.forgetLanding'));
	expect(landing.querySelector('.nav-row-menu')?.getAttribute('aria-label'))
		.toBe(t('recentFiles.rowMenu'));

	// …and the two controls stand in the SAME ORDER on both: the menu inside, the ×
	// at the very end. A reader who learned the row's far end on a note's row reads
	// the same end on a landing's, and the removal never moves inward.
	const ends = (el: HTMLElement) => Array.from(el.querySelectorAll('.nav-row-actions > *'))
		.map(c => c.classList.contains('nav-row-forget') ? 'x' : 'menu');
	expect(ends(note)).toEqual(['menu', 'x']);
	expect(ends(landing)).toEqual(['menu', 'x']);
});

	it('takes one spot off the list from the × on its own row, and leaves the note', () => {
		// What goes is the SPOT: the note keeps its own row, and so does every other
		// place in it. A row is a LINE, so what the × hands the store is the identity of
		// every place that landed on it (see landingKeys) — one of them alone would put
		// the row straight back.
		const spots = [
			visit('x.md', NOW - 30 * MINUTE, { scroll: 100 }),
			visit('x.md', NOW - 10 * MINUTE, { scroll: 412 }),
			visit('y.md', NOW),
		];
		const h = harnessAll(spots, 2, { 'x.md': '', 'y.md': '' });
		const gone = placeKey(spots[0]);

		h.clickRow(h.forgetButton(h.place('L101')));

		expect(h.forgetLanding).toHaveBeenCalledWith([gone]);
		// The spot is off the list; the note's own record and the other spot are not.
		expect(h.entries.map(e => (e.kind === 'jump' ? e.st?.scroll : 'note')))
			.toEqual([412, 'note']);
		expect(h.jumpTo).not.toHaveBeenCalled();
		// …and the redraw is the panel's own (see body.ts's forgetLanding), so the row is
		// gone from the screen too — with the note's row standing for the spot that is
		// left, since one place is not a list (see printsLandings).
		expect(h.rows()).toHaveLength(0);
		expect(h.note('x')).toBeDefined();
	});
});

// A HOVER OVER A ROW ASKS THE APP FOR THE NOTE ITSELF (see RecentFilesBrowser.hoverRow).
// There is no preview in this plugin and nothing to test of one: what this panel draws when
// a row is hovered is still nothing, and what it SAYS is one event naming the file the row
// stands for — so the popover a reader gets here is the app's own, written by whatever the
// app already answers every other list with, including whether hovering is enough at all.
// What this panel adds to the asking, and what is tested below, is the one thing only it
// knows: WHICH FILE, and WHERE in it.
describe('RecentFilesModal — a hover asks the app for the note', () => {
	const files = { 'a.md': '', 'b.md': '' };
	// A note the reader simply opened — a file row with no spot of its own.
	const plain = (): NavEntry[] => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	// …and one they also jumped into twice: under 'all' the spots are rows of their own
	// (a note with a SINGLE landing prints none — see RecentFilesList.printsLandings), and
	// the row the preview is asked about is the one eleven lines down.
	const jumped = (): NavEntry[] => [
		visit('a.md', NOW - MINUTE),
		visit('a.md', NOW - 2 * MINUTE, { scroll: 11 }),
		visit('a.md', NOW - 3 * MINUTE, { scroll: 40 }),
		visit('b.md', NOW),
	];
	// A note with parsed headings, as the metadata cache reports them: the row eleven
	// lines down sits inside "Beta", which starts at line 5.
	const heading = (text: string, line: number) => ({
		heading: text, level: line === 0 ? 1 : 2, position: { start: { line } },
	});
	// …and the same note with a spot of its own saved for it, which is what the note's
	// OWN row has wherever it can be previewed from (`focus` picks the stop, see
	// PreviewFocusMode: the row's line is a choice now, and not the row's default).
	const withHeadings = (
		headings: unknown[],
		saved?: Record<string, EphemeralState>,
		focus?: PreviewFocusMode,
	) => harnessAll(jumped(), 3, files, [], {}, { 'a.md': headings }, false, {},
		path => saved?.[path], focus);
	// The questions the app was asked, in order: the panel hands each one over as the
	// app's own event, with the request as its second argument (see hoverRow).
	const asked = (trigger: unknown) =>
		(trigger as { mock: { calls: unknown[][] } }).mock.calls
			.filter(c => c[0] === 'hover-link')
			.map(c => c[1] as {
				source?: string; targetEl?: HTMLElement; hoverParent?: HoverParent;
				linktext?: string; sourcePath?: string; state?: { scroll?: number };
			});
	// THE APP ANSWERING, as much of it as a test can stand in for: the core writes the
	// popover it opened back into the HOVER PARENT the panel handed it, and that field is
	// the whole of the handle this panel has on anything the app drew (see hover-settle.ts)
	// — there is no PeekPopover in jsdom, and none of what the core does next can happen
	// here. The panel looks for it between paints, so one turn of that clock is one look.
	// The card is returned because its END is half of the answer: taking it out of the
	// document is the preview being closed.
	const opened = async (h: ReturnType<typeof harness>): Promise<HTMLElement> => {
		const parent = asked(h.trigger).at(-1)!.hoverParent!;
		const card = document.body.createDiv({ cls: 'popover' });
		parent.hoverPopover = { hoverEl: card } as never;
		await vi.advanceTimersByTimeAsync(150);
		return card;
	};
	// The row's own hint, as the document carries it: the panel draws it there rather than
	// inside the list, which scrolls and clips (see tip.ts).
	const tip = () => document.querySelector<HTMLElement>('.position-restore-nav-tip');

	it('names the file a row stands for, once per arrival', () => {
		const h = harness(plain(), 1, files);
		const row = h.note('a');

		movedOnto(row);

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md');
		// The path on disk rather than the name printed on the row: the row's name is
		// shortened, may be neither unique nor spelled the way the vault spells it, and
		// is not what opens anyway (see displayName).
		expect(question[0].sourcePath).toBe('a.md');
		// WHO IS ASKING is how the app knows which answer to give: this panel's own id,
		// registered once for both shells (see main.ts's registerHoverLinkSource), and
		// named by nothing borrowed from another view.
		expect(question[0].source).toBe(NAV_SOURCE_ID);
		// The ROW, and not whichever word of it the pointer crossed: the popover belongs
		// to the line of the list the reader is on.
		expect(question[0].targetEl).toBe(row);

		// MOVING INSIDE that row asks nothing again: the name, the badge and the time are
		// all still one arrival on one row (see RecentFilesList.hoverAt) — otherwise a
		// hand crossing the row would be a hand asking six times for one page.
		row.querySelector('.nav-row-name')!.dispatchEvent(pointer('pointermove'));
		expect(asked(h.trigger)).toHaveLength(1);
	});

	it('asks nothing for a row the PANEL DREW UNDER a pointer that has not moved', () => {
		// THE DIALOG A HOTKEY OPENED with the mouse resting mid-screen: the rows are drawn
		// around the pointer, the browser reports an arrival on whichever one it landed on,
		// and the app would answer with a page opened over a row the reader never pointed
		// at — a note asked for by a keystroke. Arriving is not pointing (see
		// RecentFilesList.hoverAt), and two events at one place is one hand that has
		// not moved.
		const h = harness(plain(), 1, files);
		const row = h.note('a');

		// The arrival the browser reports for the row it drew around the pointer, and the
		// move that comes with it — both at the place the hand already was.
		row.dispatchEvent(pointer('pointerover'));
		row.dispatchEvent(pointer('pointermove', 'mouse', true));

		expect(asked(h.trigger)).toHaveLength(0);

		// …and the smallest move of that hand is all it takes to be asked: the row the
		// pointer came to rest on is still a row the reader can point at.
		row.dispatchEvent(pointer('pointermove'));

		expect(asked(h.trigger)).toHaveLength(1);
		expect(asked(h.trigger)[0].linktext).toBe('a.md');
	});

	it('asks nothing again for a row the list REDREW under a pointer that has not moved', () => {
		// The same arrival, one render later: the rows the reader is looking at are thrown
		// away and drawn again — a note taken off the list, the ages ticking, a query typed
		// — and the row now under the pointer is a row nobody has pointed at a second time.
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));
		expect(asked(h.trigger)).toHaveLength(1);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'a';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		h.note('a').dispatchEvent(pointer('pointermove', 'mouse', true));

		expect(asked(h.trigger)).toHaveLength(1);
	});

	it('asks again once the pointer has been away and come back', () => {
		// Leaving the LIST is what makes the next arrival an arrival (see the list's own
		// pointerleave): arriving on the same row twice in one visit is one question.
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));

		// A mouse's leave also lets the held order go, so the rows are drawn again on the
		// way out (see RecentFilesBrowser.thawOrder) — the row below is a NEW element,
		// and it answers for itself.
		h.list().dispatchEvent(pointer('pointerleave'));
		movedOnto(h.note('a'));

		expect(asked(h.trigger)).toHaveLength(2);
	});

	it('asks for the page at the line the landing row printed', () => {
		// This is the reason the asking is worth making from HERE rather than anywhere
		// else a file can be hovered: the row is a PLACE, and the popover opens on it.
		// `scroll` is the app's own name for a markdown view's top line — one number, in
		// the vocabulary the view reads (see EphemeralState) — and it is 0-based, as the
		// line a row prints is one-based.
		const h = harnessAll(jumped(), 3, files);
		expect(h.place('L12')).toBeDefined(); // the row whose line is the one asked about

		movedOnto(h.place('L12'));

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md');
		expect(question[0].state).toEqual({ scroll: 11 });
	});

	it('asks for the note and nothing else for the note’s own row', () => {
		// THE ROW IS THE FILE, so the file is what it asks to see — and it asks the way
		// every list the app ships asks: no section, and no line to travel to. The line
		// DOES sit under "Beta", and knowing that changes nothing, for two reasons. A
		// reader hovering "meeting-notes" and being shown its third heading has not been
		// shown what they pointed at, however soon it arrived. And the note opens there
		// anyway: the row's own CLICK is that arrival, one gesture later.
		const h = withHeadings([heading('Alpha', 0), heading('Beta', 5)], { 'a.md': { scroll: 11 } });

		movedOnto(h.note('a'));

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md');
		expect(question[0].state).toBeUndefined();
	});

	it('asks for the note WHOLE, moved to its line, when the reader chose that', () => {
		// The other stop (see PreviewFocusMode), asked for by name because it is not the
		// default: named a line, the app draws the whole note first and travels to it
		// behind the cover (see hover-settle.ts), arriving at the spot the row's click
		// would have opened at — which is what lets this preview agree with the click
		// standing behind it.
		const h = withHeadings([heading('Alpha', 0), heading('Beta', 5)], { 'a.md': { scroll: 11 } },
			'line');

		movedOnto(h.note('a'));

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md');
		expect(question[0].state).toEqual({ scroll: 11 });
	});

	it('reads no file for a preview that names no line', async () => {
		// What a line COSTS, and what the default stop therefore does not pay: a line is
		// re-found in the note's own TEXT, which for a note no tab is holding is a whole
		// file read — one that lands with the whole list redrawn sixty milliseconds
		// later, right where the app is drawing the card this hover asked for.
		const h = withHeadings([heading('Alpha', 0), heading('Beta', 5)], { 'a.md': { scroll: 11 } });

		movedOnto(h.note('a'));
		await vi.advanceTimersByTimeAsync(LATE_READ_REDRAW_MS * 2);

		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('names the SECTION the row stands in, when the note has one there', () => {
		// Asked for a line, the app's own popover cannot open at it: it draws the whole
		// note first and moves the scroller only once that render lands — and flashes
		// the target on the way (see hover-settle.ts). Asked for a section it draws ONLY
		// that section, so there is nothing left to travel to and nothing to flash.
		// Naming the section therefore costs no line at all: it is where the row stands.
		const h = withHeadings([heading('Alpha', 0), heading('Beta', 5)]);

		movedOnto(h.place('L12'));

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md#Beta');
		// …and there is no second instruction in the same breath: a line number beside a
		// section would be the app going somewhere it was not asked to go.
		expect(question[0].state).toBeUndefined();
	});

	it('falls back to the line for a heading the app could not tell apart', () => {
		// `#Beta` resolves to the FIRST heading with that text, so a note that says
		// "Beta" twice would open the wrong one of them — and a wrong section shown
		// without moving once is worse than the right place arriving late (which the
		// cover hides anyway, see PreviewSettle).
		const h = withHeadings([heading('Alpha', 0), heading('Beta', 5), heading('Beta', 20)]);

		movedOnto(h.place('L12'));

		expect(asked(h.trigger)[0].linktext).toBe('a.md');
		expect(asked(h.trigger)[0].state).toEqual({ scroll: 11 });
	});

	it('falls back to the line for a heading that cannot travel in a link', () => {
		// The characters below are link syntax to the parser, not part of a name: each
		// opens something else (a subpath, an alias, the link itself), so the heading
		// would arrive as something other than itself.
		const h = withHeadings([heading('Alpha', 0), heading('Beta | gamma', 5)]);

		movedOnto(h.place('L12'));

		expect(asked(h.trigger)[0].linktext).toBe('a.md');
		expect(asked(h.trigger)[0].state).toEqual({ scroll: 11 });
	});

	it('promises no line for a row whose note has no spot at all', () => {
		// Nothing is invented to fill the silence: the line a preview is asked for is a
		// place the note HAS, and a note the reader never left anywhere — no jump in it,
		// nothing saved for it — has none to be asked about. What the preview then shows is
		// the note from its head, which is what opening it plainly would have shown.
		const h = harness(plain(), 1, files);

		movedOnto(h.note('a'));

		expect(asked(h.trigger)[0].state).toBeUndefined();
	});

	it('asks for nothing behind a row that has no page', () => {
		// A pathless view names no file: there is nothing for the app to open a preview
		// of, and building this panel's own card about the graph is exactly the second
		// implementation the asking is meant to spare us (see hoverRow).
		const h = harness([
			visit('a.md', NOW - MINUTE),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
		], 1, files);
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

		movedOnto(graph);

		expect(asked(h.trigger)).toHaveLength(0);
	});

	it('asks nothing of a finger, and travels nowhere', () => {
		// A finger resting on a row is about to tap it, not to read it — and there is no
		// room on a phone for a page beside the row anyway (see RecentFilesList.onHoverRow).
		// Nothing travels either way: a hover is not a navigation, wherever it leads.
		const h = harness(plain(), 1, files);

		movedOnto(h.note('a'), 'touch');

		expect(asked(h.trigger)).toHaveLength(0);
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('marks the card the app opened, which is the card this panel has to lift', async () => {
		// The note answering a hover from the DIALOG shell opens behind it: the core
		// puts every popover on the document's body and paints it below a modal
		// container (see body.ts's liftPreview), so the page the dialog asked for is
		// the one thing its own frame is standing over. Neither the card's paint nor
		// the layers are here to test — no stylesheet runs in jsdom, and both values
		// are the app's — but the SEAM is: which cards get marked is exactly which
		// cards this panel asked the app for, and one it did not ask about is not
		// this panel's to dress up. Marked rather than styled inline, because how a
		// popover looks is the theme's answer and always has been.
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));

		const card = await opened(h);

		expect(card.classList.contains('position-restore-nav-preview')).toBe(true);
	});

	// WHAT THE ROWS SAY FOR THEMSELVES STANDS ASIDE FOR WHAT THE APP IS SHOWING. The hint
	// answers what the row could not print (see RecentFilesList.fileRow) — the path the
	// setting left off it, the other names a note goes by — and the note answers all of it
	// too: better, and on the page rather than in a box beside it. Nothing of this is the
	// asking being refused; it is two answers to one question being one answer too many.
	//
	// And nothing of it is REMEMBERED, either: whether a hint may speak is asked fresh at
	// every hover (see RecentFilesListOptions.tipsQuiet), so the answer's lifetime is the
	// popover's — not the pointer's, and not some flag's that a later hover has to clear.
	it('takes its own words back the moment the note is standing over the rows', async () => {
		const h = harness(plain(), 1, files);
		// A hovering that got nothing else to go on is a hovering with something to say.
		movedOnto(h.note('a'));
		expect(h.hover(h.note('a'))).not.toBeNull();

		// …and then the app opens one: the reader held its key, or has once said that
		// hovering is enough for every list the app has. What was said is taken back…
		await opened(h);
		expect(tip()).toBeNull();

		// …and nothing new is said while the note stands: the page has already answered
		// "which file is this" better than the box beside it could.
		expect(h.hover(h.note('b'))).toBeNull();
	});

	it('keeps what it has to say when the app answers nothing', async () => {
		// Refusing is not answering either: a preview plugin turned off, or a key still
		// being held back, is a hovering that got nothing at all — and the row's own words
		// are then the only thing reading it has earned.
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));
		await vi.advanceTimersByTimeAsync(2000);

		expect(h.hover(h.note('a'))).not.toBeNull();
	});

	it('speaks again once the note is gone — the pointer never having left the list', async () => {
		// The silence ends with the PREVIEW, not with a journey of the pointer's: a hint
		// that stayed off after the popover closed was the bug this asking is the answer
		// to (see tip.ts's `quiet`), and "away and back" is no longer part of the bargain.
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));
		expect(h.hover(h.note('a'))).not.toBeNull();
		const card = await opened(h);
		expect(tip()).toBeNull();

		card.remove();

		expect(h.hover(h.note('b'))).not.toBeNull();
	});
});

// A ROW'S LINE NUMBER IS AN ADDRESS, AND THE NOTE MOVES UNDER IT. What the app is
// asked for from here is a SPOT, and a spot recorded last week may have had the ground
// shift under its own number since: a paragraph written above it moves every line below.
// So the number handed over is the one the note's own text answers to TODAY — or none at
// all (see now-line.ts), which is the honest asking: a preview that opens the note without
// naming a line was never wrong about where the spot was.
describe('RecentFilesModal — a hover asks for the spot as it stands today', () => {
	// The note as it was when the record was taken, and the spot: line 11 of it.
	const SPOT = 11;
	const st = captured(SPREAD_DOC, SPOT);
	// …and as it stands now, with two lines written in above the spot: everything below
	// has moved down by two, and the spot's own text has moved down with it.
	const edited = [...SPREAD_DOC.slice(0, 2), '补记一行', '', ...SPREAD_DOC.slice(2)].join('\n');
	const files = { 'a.md': SPREAD_DOC.join('\n') };
	// The questions the app was asked, in order (see the suite above).
	const asked = (trigger: unknown) =>
		(trigger as { mock: { calls: unknown[][] } }).mock.calls
			.filter(c => c[0] === 'hover-link')
			.map(c => c[1] as { linktext?: string; state?: { scroll?: number } });
	const one = (): NavEntry[] => [visit('a.md', NOW, st)];

	// The three below ask for the line the app MOVED TO AFTERWARDS — which is the stop
	// this list offers rather than the one it ships (see PreviewFocusMode), so each one
	// says so where the panel read its own preference.
	it('names the line the spot stands at now, when the note is open', () => {
		// The buffer of a note that is OPEN is the only source that cannot be behind: it
		// is the text the reader is looking at, saved or not — and the file's own clock
		// says the note has been written since the record was taken.
		const h = harness(one(), 0, files, [], { 'a.md': edited }, {}, false, { 'a.md': 9 },
			prefs({ focus: 'line' }).browser);

		movedOnto(h.note('a'));

		expect(asked(h.trigger)[0]).toMatchObject({
			linktext: 'a.md',
			state: { scroll: SPOT + 2 },
		});
	});

	it('reads the note off the disk when no tab holds it, and names the line one hover later', async () => {
		// Nothing is in hand the first time — the lines sit behind an await, and an asking
		// is not going to wait for a file — so that hover asks for the note with NO number,
		// and the reading it started is what lets the next one name the spot.
		const h = harness(one(), 0, { 'a.md': edited }, [], {}, {}, false, { 'a.md': 9 },
			prefs({ focus: 'line' }).browser);

		movedOnto(h.note('a'));
		expect(asked(h.trigger)[0].state).toBeUndefined();

		// The reading lands, and the panel redraws with it (see redrawAfterLateRead).
		await vi.advanceTimersByTimeAsync(LATE_READ_REDRAW_MS * 2);
		movedOnto(h.note('a'));

		expect(asked(h.trigger).at(-1)!.state).toEqual({ scroll: SPOT + 2 });
	});

	it('keeps the recorded number when the note has not been written since', () => {
		// The file's clock says what the record says: nothing has been written, so the
		// recorded line is still the line.
		const h = harness([visit('a.md', NOW, { ...st, mtime: 4 })], 0, files, [], {}, {}, false,
			{ 'a.md': 4 }, prefs({ focus: 'line' }).browser);

		movedOnto(h.note('a'));

		expect(asked(h.trigger)[0].state).toEqual({ scroll: SPOT });
	});

	it('names no line where the ROW has one but the note is asked for the app’s own way', () => {
		// The same open note, the same spot two lines off and found again — and nothing
		// named, because the DEFAULT stop asks for the note the way every list the app
		// ships asks for it. Everything above this test is an expedition the reader
		// chose, not a duty this row has.
		const h = harness(one(), 0, files, [], { 'a.md': edited }, {}, false, { 'a.md': 9 });

		movedOnto(h.note('a'));

		const question = asked(h.trigger)[0];
		expect(question.linktext).toBe('a.md');
		expect(question.state).toBeUndefined();
	});

	it('names no line at all where the spot cannot be found again', () => {
		// The note was rewritten: nothing left in it is the line the record's anchor names.
		const h = harness(one(), 0, files, [], { 'a.md': '全新的一段\n'.repeat(20) }, {}, false,
			{ 'a.md': 9 });

		movedOnto(h.note('a'));

		const question = asked(h.trigger)[0];
		expect(question.state).toBeUndefined();
		// …and no SECTION either: a heading belongs to a line, and there is no line.
		expect(question.linktext).toBe('a.md');
	});
});

describe('RecentFilesModal — the pinned rows', () => {
	// A PIN is a bookmark for a NOTE, so the block holds one row per note and no
	// landings under any of them; what the reader loses is the list of spots, not
	// the newest one, which the row still stands for (see RecentFilesList).
	const three = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };

	it('draws the pinned rows first, in the reader’s own order, above a line', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['b.md', 'c.md']);

		const names = h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);
		// The pin order and not the clock: c.md is the newest place here and b.md
		// is the older of the two pins, and the reader put b first.
		expect(names).toEqual(['b', 'c', 'a']);
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
		expect(h.notes()[1].classList.contains('is-pinned')).toBe(true);
		expect(h.notes()[2].classList.contains('is-pinned')).toBe(false);
		// ONE line, under the block and nowhere else.
		const lines = h.el.querySelectorAll('.position-restore-nav-pinned-sep');
		expect(lines).toHaveLength(1);
		expect(lines[0].nextElementSibling).toBe(h.notes()[2]);
	});

	it('prints no landings under a pinned row, even where the setting asks for them', () => {
		const spots = [
			visit('a.md', NOW - 5 * MINUTE, { scroll: 10 }),
			visit('a.md', NOW - 4 * MINUTE, { scroll: 20 }),
			visit('b.md', NOW - 3 * MINUTE, { scroll: 100 }),
			visit('b.md', NOW - 2 * MINUTE, { scroll: 400 }),
			visit('c.md', NOW),
		];
		const h = harness(spots, 4, files, [], {}, {}, false, {},
			prefs({ landings: 'all' }).browser, undefined, ['b.md']);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['b', 'c', 'a']);
		// b.md's two spots are not printed — the block is one row per note — while
		// a.md, which nobody pinned, keeps both of its own.
		expect(h.rows().map(r => r.querySelector('.nav-row-line')?.textContent))
			.toEqual(['L11', 'L21']);
	});

	it('draws no line when the block is the whole list', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md', 'c.md']);

		expect(h.el.querySelector('.position-restore-nav-pinned-sep')).toBeNull();
	});

	it('skips a pin whose row is not on screen, and takes it up when the pin is made', () => {
		// A pin naming a note the filter dropped is not a promise that it is listed.
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['gone.md']);
		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['c', 'b', 'a']);
		expect(h.el.querySelector('.position-restore-nav-pinned-sep')).toBeNull();

		h.pinned.unshift('a.md');
		h.changed();
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('a');
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
	});

	it('opens what a pinned row stands for, and takes it off the list the same way', () => {
		const spots = [visit('a.md', NOW - MINUTE, { scroll: 412 }), visit('b.md', NOW)];
		const h = harness(spots, 1, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md']);

		h.clickRow(h.note('a'));
		// The row stands for the note's newest landing, as it does unpinned.
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);

		h.clickRow(h.forgetButton(h.note('a')));
		expect(h.forget).toHaveBeenCalledWith('a.md');
	});
});

describe('RecentFilesModal — the pin on a row’s menu', () => {
	// WHAT THIS LIST ADDS to the app's own menu for a file: the pin, which is a
	// bookmark for a NOTE and belongs on a note's row — and the two steps, which
	// are about the pinned block's own order and nowhere else.
	const three = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const open = t('recentFiles.openInNewTab');
	const items = (h: ReturnType<typeof harness>) => {
		const calls = (h.trigger as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls).toHaveLength(1);
		const menu = calls[0][1] as {
			items: { title: string; section: string; icon: string; click?: () => void }[];
		};
		return menu.items;
	};
	const item = (h: ReturnType<typeof harness>, title: string) =>
		items(h).find(i => i.title === title)!;
	const names = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);

	it('offers the pin on a note’s row, and not on a landing’s', () => {
		// A pin is a bookmark for the NOTE: a landing is a spot INSIDE one, and
		// pinning it would be a second, smaller kind of pin (see body.ts's pinItems).
		const spread = [
			visit('a.md', NOW - 3 * MINUTE, { scroll: 10 }),
			visit('a.md', NOW - 2 * MINUTE, { scroll: 20 }),
		];
		const h = harness(spread, 1, files, [], {}, {}, false, {},
			prefs({ landings: 'all' }).browser);
		h.rightClick(h.note('a'));
		expect(items(h).map(i => i.title)).toContain(t('recentFiles.pin'));
		expect(items(h)[1].section).toBe('action');

		const landing = harness(spread, 1, files, [], {}, {}, false, {},
			prefs({ landings: 'all' }).browser);
		landing.rightClick(landing.rows()[0]);
		expect(items(landing).map(i => i.title)).toEqual([t('recentFiles.openHereInNewTab')]);
	});

	it('pins the note and puts its row at the top of the list', () => {
		// The row moves AT ONCE: the panel is the only thing that can say so, and a
		// dialog does not subscribe to the store (see body.ts's pin).
		const h = harness(three(), 2, files);

		h.rightClick(h.note('a'));
		expect(items(h).map(i => i.title)).toEqual([open, t('recentFiles.pin')]);
		item(h, t('recentFiles.pin')).click!();

		expect(h.pin).toHaveBeenCalledWith('a.md');
		expect(names(h)).toEqual(['a', 'c', 'b']);
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
	});

	it('offers the two steps only where there is a step to take', () => {
		// At either end of the block an item that would do nothing is worse than an
		// item that is not there.
		const alone = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md']);
		alone.rightClick(alone.note('a'));
		expect(items(alone).map(i => i.title)).toEqual([open, t('recentFiles.unpin')]);

		const first = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md']);
		first.rightClick(first.note('a'));
		expect(items(first).map(i => i.title))
			.toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinDown')]);

		const last = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md']);
		last.rightClick(last.note('b'));
		expect(items(last).map(i => i.title))
			.toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp')]);
	});

	it('moves a pinned row one step inside the block, and draws what it did', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md']);

		h.rightClick(h.note('a'));
		item(h, t('recentFiles.pinDown')).click!();

		expect(h.movePinned).toHaveBeenCalledWith('a.md', 1);
		expect(h.pinned).toEqual(['b.md', 'a.md']);
		expect(names(h)).toEqual(['b', 'a', 'c']);
	});

	it('takes the pin off, and the row goes back to the list in its own place', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md']);

		h.rightClick(h.note('a'));
		item(h, t('recentFiles.unpin')).click!();

		expect(h.unpin).toHaveBeenCalledWith('a.md');
		expect(names(h)).toEqual(['c', 'b', 'a']);
		expect(h.el.querySelector('.position-restore-nav-pinned-sep')).toBeNull();
	});

	it('offers the whole way only where it is MORE than one step', () => {
		// "Move to the front" beside the front would do exactly what "move up"
		// just offered, so it is not there — a block of three has no row far
		// enough from either end to need one.
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md', 'c.md']);
		h.rightClick(h.note('b'));
		expect(items(h).map(i => i.title))
			.toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'), t('recentFiles.pinDown')]);

		// Four is where a row is two steps from an end: the FRONT row has no way
		// up at all, the one below it is one step up and two down.
		const four = { 'a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' };
		const block = harness([
			visit('a.md', NOW - 5 * MINUTE),
			visit('b.md', NOW - 4 * MINUTE),
			visit('c.md', NOW - 3 * MINUTE),
			visit('d.md', NOW),
		], 3, four, [], {}, {}, false, {}, defaultPrefs(),
		undefined, ['a.md', 'b.md', 'c.md', 'd.md']);
		const titles = (name: string) => {
			const row = harness([
				visit('a.md', NOW - 5 * MINUTE),
				visit('b.md', NOW - 4 * MINUTE),
				visit('c.md', NOW - 3 * MINUTE),
				visit('d.md', NOW),
			], 3, four, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md', 'c.md', 'd.md']);
			row.rightClick(row.note(name));
			return items(row).map(i => i.title);
		};
		expect(titles('a')).toEqual([open, t('recentFiles.unpin'),
			t('recentFiles.pinDown'), t('recentFiles.pinLast')]);
		expect(titles('b')).toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'),
			t('recentFiles.pinDown'), t('recentFiles.pinLast')]);
		expect(titles('c')).toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'),
			t('recentFiles.pinFirst'), t('recentFiles.pinDown')]);
		expect(titles('d')).toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'),
			t('recentFiles.pinFirst')]);
		// …and the block itself is still drawn in the reader's own order.
		expect(names(block)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('moves a pinned row to the end of the block in one answer', () => {
		const four = { 'a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' };
		const h = harness([
			visit('a.md', NOW - 5 * MINUTE),
			visit('b.md', NOW - 4 * MINUTE),
			visit('c.md', NOW - 3 * MINUTE),
			visit('d.md', NOW),
		], 3, four, [], {}, {}, false, {}, defaultPrefs(),
		undefined, ['a.md', 'b.md', 'c.md', 'd.md']);

		h.rightClick(h.note('b'));
		item(h, t('recentFiles.pinLast')).click!();

		// What the store is handed is the DISTANCE, not the index: how far a row
		// has to travel is the block's business.
		expect(h.movePinned).toHaveBeenCalledWith('b.md', 2);
		expect(h.pinned).toEqual(['a.md', 'c.md', 'd.md', 'b.md']);
		expect(names(h)).toEqual(['a', 'c', 'd', 'b']);
	});
});

describe('RecentFilesModal — the pin on a view’s row', () => {
	// WHAT the reader pins is their own business: a pathless view is a place this
	// list remembers and a row this list draws, and a pin is about the ROW. What
	// differs from a note is only the menu's SIZE — a view names no file, so
	// nothing is asked of the app (see body.ts's contextRow).
	const graph = { kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry;
	const spots = () => [visit('a.md', NOW - MINUTE), graph];
	const files = { 'a.md': '' };
	const graphRow = (h: ReturnType<typeof harness>) =>
		h.notes().find(r =>
			r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

	it('pins a view from its own menu, and the block draws it', () => {
		const h = harness(spots(), 1, files);

		h.rightClick(graphRow(h));
		Menu.shown.at(-1)!.items.find(i => i.title === t('recentFiles.pin'))!.click!();

		// A view is named by its TYPE, which is exactly what a path cannot say
		// (see nav/entry.ts's navGroupKey).
		expect(h.pin).toHaveBeenCalledWith('view:graph');
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
		expect(h.notes()[0]).toBe(graphRow(h));
	});

	it('gives a phone the same menu, from the armed row’s own control', () => {
		// The control is the ONLY door on a phone, and a view's row used to have
		// none at all — which left a view unpinnable where most readers pin.
		const h = harness(spots(), 1, files, [], {}, {}, true);
		const row = graphRow(h);

		h.longPress(row);
		const more = row.querySelector<HTMLElement>('.nav-row-menu');
		expect(more).not.toBeNull();
		h.clickRow(more!);

		expect(Menu.shown.at(-1)!.items.map(i => i.title))
			.toEqual([t('recentFiles.openInNewTab'), t('recentFiles.pin')]);
	});
});

describe('RecentFilesModal — the name a row calls the note', () => {
	// ONE property the reader named in the settings, and the file's own name
	// where a note has none of it: that is the whole of the rule, which is why
	// there is no second setting saying which to prefer (see reads.ts's titleOf).
	const spots = () => [visit('b.md', NOW - MINUTE), visit('a.md', NOW)];
	const files = { 'a.md': '', 'b.md': '' };
	const named = (title: string) => prefs({ title }).browser;
	const cacheWith = (props: Record<string, unknown>) => ({ frontmatter: props });
	const names = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);

	it('prints the property the reader named, and the file name where it is missing', () => {
		const h = harness(spots(), 1, files, [], {}, {
			'a.md': cacheWith({ title: '每周回顾' }),
			'b.md': cacheWith({}),
		}, false, {}, named('title'));

		// a.md is the newest, and it is the one with a name of its own.
		expect(names(h)).toEqual(['每周回顾', 'b']);
	});

	it('prints file names while the setting is empty, however the notes are written', () => {
		// OFF is the default and it has to mean OFF: a vault that names its notes
		// in their file names owes this row nothing, and a `title` sitting in a
		// note is then just another name it can be SEARCHED by (see the suite
		// above).
		const h = harness(spots(), 1, files, [], {}, {
			'a.md': cacheWith({ title: '每周回顾' }),
		}, false, {}, prefs().browser);

		expect(names(h)).toEqual(['a', 'b']);
	});

	it('takes only a single piece of text as a name', () => {
		// A list, a year or an emptied property is not a name: a row that guessed
		// would print "[object Object]" or "2024" where the reader's note goes.
		const h = harness([
			visit('b.md', NOW - 3 * MINUTE),
			visit('c.md', NOW - 2 * MINUTE),
			visit('a.md', NOW),
		], 2, { 'a.md': '', 'b.md': '', 'c.md': '' }, [], {}, {
			'a.md': cacheWith({ title: ['one', 'two'] }),
			'b.md': cacheWith({ title: 2024 }),
			'c.md': cacheWith({ title: '   ' }),
		}, false, {}, named('title'));

		expect(names(h)).toEqual(['a', 'c', 'b']);
	});

	it('finds a note by the name it PRINTS, and tells two same-named notes apart', () => {
		// What is searched and what is disambiguated is the same name the row
		// prints: a note renamed in frontmatter is one name everywhere on it.
		const h = harness([
			visit('notes/a.md', NOW - MINUTE),
			visit('other/b.md', NOW),
		], 1, { 'notes/a.md': '', 'other/b.md': '' }, [], {}, {
			'notes/a.md': cacheWith({ title: '周会' }),
			'other/b.md': cacheWith({ title: '周会' }),
		}, false, {}, named('title'));

		// Two rows reading 周会 are two rows a reader cannot choose between, so
		// the folder is printed — exactly as it is for two files of one name.
		expect(names(h)).toEqual(['周会', '周会']);
		expect(h.notes().map(r => r.querySelector('.nav-row-path')?.textContent))
			.toEqual(['other/', 'notes/']);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '周会';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(names(h)).toEqual(['周会', '周会']);
		// …and the file's own name still finds it, which is the name the reader
		// sees everywhere else.
		box.value = 'a.md';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(names(h)).toEqual(['周会']);
	});

	it('redraws when the name it prints changes, and not for any other edit', () => {
		// The reader is TYPING that property, in the note, while the row stands
		// there printing the old name. An edit anywhere in a note re-parses it,
		// so what earns a redraw is the name being different now — a full
		// rebuild of the list per keystroke is the cost of not comparing.
		const cache = { 'a.md': cacheWith({ title: 'One' }) };
		const h = harness([visit('a.md', NOW)], 0, files, [], {}, cache, false, {},
			named('title'));
		expect(names(h)).toEqual(['One']);

		// By position and not by name: the row's name is the thing that is
		// about to change under the reader.
		const row = h.notes()[0];
		cache['a.md'].frontmatter.title = 'Two';
		h.changeFile('a.md');
		expect(names(h)).toEqual(['Two']);
		// …and it was drawn again rather than patched: the row is a new element.
		expect(h.notes()[0]).not.toBe(row);

		const same = h.notes()[0];
		cache['a.md'].frontmatter.aliases = 'something else';
		h.changeFile('a.md');
		expect(names(h)).toEqual(['Two']);
		expect(h.notes()[0]).toBe(same);
	});
});
