// Unit tests for the scroll-capture guards added for dynamically-rendered
// dashboards (dataviewjs embeds):
//  - embed-boundary guard: scrolls originating inside embedded renderers
//    (.internal-embed / .cm-embed-block / .block-language-*) must never be
//    recorded as the HOST view's position;
//  - desktop user-intent guard: scroll deltas with no recent user input
//    (programmatic re-render layout shifts, plugin scrolls) must be absorbed.
// The onScrollCapture pipeline's pre-existing guards (restore bracket, search
// anchor, exclusion gate) are covered too, as regression anchors for guard
// ordering.

import { describe, it, expect, vi } from 'vitest';

import { FileView, MarkdownView, Platform } from 'obsidian';
import { Sampler } from '../src/sampler';
import { PositionState } from '../src/position-state';
import { DEFAULT_SETTINGS, PluginSettings } from '../src/types';

// onScrollCapture is private; tests drive it directly through this alias.
type ScrollCapture = (ev: Event) => void;

type DatabaseStub = {
	db: Record<string, unknown>;
	setState: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
};

// A fake markdown view: real prototype chain (so instanceof passes) with the
// minimal surface readEphemeralState / the sampler touch, attached in one
// untyped assign to dodge the obsidian typings.
function makeFakeMarkdownView(path: string, containerEl: HTMLElement): MarkdownView {
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path },
		containerEl,
		currentMode: { getScroll: () => 42.3 }, // quantizes to 42
		editor: {
			lineCount: () => 100,
			getCursor: () => ({ line: 3, ch: 7 }),
		},
		getViewType: () => 'markdown',
	}) as MarkdownView;
	// The leaf references its view back (findOwnerLeaf resolves leaf.view).
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1', view };
	return view;
}

function makeEvent(target: HTMLElement): Event {
	const ev = new Event('scroll');
	Object.defineProperty(ev, 'target', { value: target });
	return ev;
}

// Builds the DOM a live-preview dashboard produces: the host editor scroller
// containing an embedded renderer with its own inner scroller.
function makeDashboardDom() {
	const containerEl = document.createElement('div');
	const hostScroller = document.createElement('div');
	hostScroller.className = 'cm-scroller';
	containerEl.appendChild(hostScroller);

	const embed = document.createElement('div');
	embed.className = 'cm-embed-block';
	const embedScroller = document.createElement('div');
	embedScroller.className = 'embed-inner-scroller';
	embed.appendChild(embedScroller);
	hostScroller.appendChild(embedScroller);

	return { containerEl, hostScroller, embed };
}

function makeHarness(options?: {
	excludedFolders?: string[];
	frontmatterExcludeProperties?: string[];
	frontmatters?: Record<string, unknown>;
}) {
	const dom = makeDashboardDom();
	const view = makeFakeMarkdownView('dashboard.md', dom.containerEl);
	const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
	const app = {
		workspace: {
			getActiveViewOfType: () => view,
			iterateAllLeaves: () => undefined,
			containerEl: dom.containerEl,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) =>
				options?.frontmatters && file.path in options.frontmatters
					? { frontmatter: options.frontmatters[file.path] }
					: null,
		},
	};
	const settings = {
		...DEFAULT_SETTINGS,
		excludedFolders: options?.excludedFolders ?? [],
		frontmatterExcludeProperties: options?.frontmatterExcludeProperties ?? [],
	} as PluginSettings;
	const state = new PositionState(settings);
	const sampler = new Sampler(app as never, database as never, settings, state);
	const capture = (sampler as unknown as { onScrollCapture: ScrollCapture }).onScrollCapture;
	// Simulate "user just interacted": by default the intent guard is satisfied.
	state.lastUserInputAt = Date.now();
	return { sampler, state, database, view, dom, capture };
}

// Appends one more embedded renderer (with an inner scroller) to the host
// scroller of a harness's dashboard DOM.
function appendEmbed(h: ReturnType<typeof makeHarness>, embedClass: string): HTMLElement {
	const embed = document.createElement('div');
	embed.className = embedClass;
	const inner = document.createElement('div');
	inner.className = 'embed-inner-scroller';
	embed.appendChild(inner);
	h.dom.hostScroller.appendChild(embed);
	return inner;
}

describe('Sampler.onScrollCapture — embed-boundary guard', () => {
	it('records a scroll of the host scroller itself', () => {
		const h = makeHarness();
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalledTimes(1);
		const [filePath, st] = h.database.setState.mock.calls[0];
		expect(filePath).toBe('dashboard.md');
		expect(st).toMatchObject({ scroll: 42, cursor: { from: { line: 3, ch: 7 } } });
	});

	it.each([
		['interactive ![[embed]]', 'internal-embed markdown-embed'],
		['live-preview code widget', 'cm-embed-block'],
		['dataview rendered block', 'block-language-dataviewjs'],
	])('skips a scroll whose target sits inside a %s', (_label, embedClass) => {
		const h = makeHarness();
		const inner = appendEmbed(h, embedClass);

		h.capture(makeEvent(inner));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('does not leak the skipped embed scroll into later records (baseline untouched)', () => {
		const h = makeHarness();
		const inner = appendEmbed(h, 'block-language-dataviewjs');

		// Embed scroll (noise), then host scroll (signal): the signal must record.
		h.capture(makeEvent(inner));
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalledTimes(1);
	});
});

describe('Sampler.onScrollCapture — desktop user-intent guard', () => {
	it('absorbs a scroll with no recent user input (re-render layout shift)', () => {
		const h = makeHarness();
		h.state.lastUserInputAt = Date.now() - 2100;
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('records a scroll right after user input (within the intent window)', () => {
		const h = makeHarness();
		h.state.lastUserInputAt = Date.now() - 500;
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalledTimes(1);
	});

	it('installUserIntentTracker stamps wheel, pointerdown and keydown', () => {
		const h = makeHarness();
		const cleanups: Array<() => void> = [];
		h.sampler.installUserIntentTracker(fn => cleanups.push(fn));

		h.dom.containerEl.dispatchEvent(new Event('wheel'));
		const afterWheel = h.state.lastUserInputAt;
		expect(afterWheel).toBeGreaterThan(0);

		h.dom.containerEl.dispatchEvent(new Event('pointerdown'));
		const afterPointer = h.state.lastUserInputAt;
		expect(afterPointer).toBeGreaterThanOrEqual(afterWheel);

		document.dispatchEvent(new KeyboardEvent('keydown'));
		expect(h.state.lastUserInputAt).toBeGreaterThanOrEqual(afterPointer);

		cleanups.forEach(fn => fn());
		// After cleanup the listeners are gone: no further stamping.
		const frozen = h.state.lastUserInputAt;
		h.dom.containerEl.dispatchEvent(new Event('wheel'));
		expect(h.state.lastUserInputAt).toBe(frozen);
	});
});

describe('Sampler.onScrollCapture — guard ordering with the pre-existing gates', () => {
	it('restore bracket still suppresses recording', () => {
		const h = makeHarness();
		h.state.restoreStarted();
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
	});

	it('search anchor still suppresses recording', () => {
		const h = makeHarness();
		h.state.searchAnchorUntil = Number.POSITIVE_INFINITY;
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
	});

	it('exclusion gate still drops the db record on a host scroll of an excluded file', () => {
		const h = makeHarness({ excludedFolders: ['dashboard.md'] });
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).toHaveBeenCalledWith('dashboard.md');
	});

	it('frontmatter B rule drops the db record on a host scroll of a matching file', () => {
		const h = makeHarness({
			frontmatterExcludeProperties: ['publish: true'],
			frontmatters: { 'dashboard.md': { publish: true } },
		});
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).toHaveBeenCalledWith('dashboard.md');
	});

	it('frontmatter B rule keeps the db record when the value does not match', () => {
		const h = makeHarness({
			frontmatterExcludeProperties: ['publish: true'],
			frontmatters: { 'dashboard.md': { publish: false } },
		});
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalled();
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('escape-hatch `position-restore: true` records despite an excluded folder', () => {
		const h = makeHarness({
			excludedFolders: ['dashboard.md'],
			frontmatters: { 'dashboard.md': { 'position-restore': true } },
		});
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalledTimes(1);
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('an embed scroll of an excluded file is pure noise: no write, no delete', () => {
		const h = makeHarness({ excludedFolders: ['dashboard.md'] });
		const inner = appendEmbed(h, 'cm-embed-block');

		h.capture(makeEvent(inner));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});
});

describe('Sampler.onScrollCapture — non-markdown views', () => {
	it('still records opted-in bases views (raw scrollTop), embed guard notwithstanding', () => {
		const containerEl = document.createElement('div');
		const scroller = document.createElement('div');
		scroller.className = 'bases-view';
		containerEl.appendChild(scroller);

		const basesView = Object.assign(Object.create(FileView.prototype), {
			file: { path: 'board.base' },
			containerEl,
			getViewType: () => 'bases',
		}) as FileView;
		(basesView as unknown as { leaf: unknown }).leaf = { id: 'leaf-bases', view: basesView };

		const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
		const app = {
			workspace: {
				getActiveViewOfType: () => basesView,
				iterateAllLeaves: () => undefined,
				containerEl,
			},
			metadataCache: { getFileCache: () => null }, // no frontmatter by default
		};
		const settings = { ...DEFAULT_SETTINGS, recordBaseScroll: true } as PluginSettings;
		const state = new PositionState(settings);
		const sampler = new Sampler(app as never, database as never, settings, state);
		const capture = (sampler as unknown as { onScrollCapture: ScrollCapture }).onScrollCapture;
		state.lastUserInputAt = Date.now();

		Object.defineProperty(scroller, 'scrollTop', { value: 180, configurable: true });
		capture(makeEvent(scroller));
		expect(database.setState).toHaveBeenCalledWith('board.base', { scroll: 180 });
	});
});

// Sanity: the mock routing used by the capture setup still matches desktop.
describe('environment sanity', () => {
	it('mocked Platform matches the desktop capture setup', () => {
		expect(Platform.isDesktopApp).toBe(true);
		expect(Platform.isMobileApp).toBe(false);
	});
});

// checkEphemeralStateChanged is the mobile-only writer of per-tab records
// (lastStateByLeaf): on mobile there is no scroll-capture listener, so the
// 100ms poll must feed the per-tab baseline too, or the same file open in
// two tabs restores both to the same per-file record after a restart.
describe('Sampler.checkEphemeralStateChanged — mobile per-tab recording', () => {
	// A markdown view whose scroll is settable, so one harness can simulate
	// two tabs of the same file at different positions.
	function makeScrollingView(path: string, scroll: number, leafId: string): MarkdownView {
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path },
			containerEl: document.createElement('div'),
			currentMode: { getScroll: () => scroll },
			editor: {
				lineCount: () => 100,
				getCursor: () => ({ line: 3, ch: 7 }),
			},
			getViewType: () => 'markdown',
		}) as MarkdownView;
		(view as unknown as { leaf: unknown }).leaf = { id: leafId, view };
		return view;
	}

	function makeMobileHarness() {
		const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
		const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
		const state = new PositionState(settings);
		let activeView = makeScrollingView('a.md', 42, 'leaf-1');
		const app = {
			workspace: {
				getActiveViewOfType: () => activeView,
				iterateAllLeaves: () => undefined,
				containerEl: document.createElement('div'),
			},
			metadataCache: { getFileCache: () => null }, // no frontmatter by default
		};
		const sampler = new Sampler(app as never, database as never, settings, state);
		const poll = () => sampler.checkEphemeralStateChanged();
		return {
			sampler, state, database,
			activate(view: MarkdownView) { activeView = view; },
			poll,
		};
	}

	it('records each tab of the same file at its own position (scroll-only, trusted)', () => {
		const origMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeMobileHarness();
			h.state.lastLoadedFilePath = 'a.md';
			// Seed a baseline that differs from both tabs so the first poll
			// records tab 1 instead of only seeding the baseline.
			h.state.lastEphemeralState = { scroll: 1, cursor: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } } };
			h.state.lastAnchorAt = Date.now();
			h.poll();
			// Trust the next scroll delta as user-driven. Must be strictly newer
			// than lastAnchorAt: both Date.now() calls can land in the same
			// millisecond, which would leave touch == anchor and absorb the delta.
			h.state.lastTouchAt = h.state.lastAnchorAt + 1;

			// Second tab of the same file scrolled to 99, now active.
			h.activate(makeScrollingView('a.md', 99, 'leaf-2'));
			h.poll();

			expect(h.state.lastStateByLeaf.get('leaf-1')).toEqual({ filePath: 'a.md', st: { scroll: 42, cursor: { from: { line: 3, ch: 7 }, to: { line: 3, ch: 7 } } } });
			expect(h.state.lastStateByLeaf.get('leaf-2')).toEqual({ filePath: 'a.md', st: { scroll: 99, cursor: { from: { line: 3, ch: 7 }, to: { line: 3, ch: 7 } } } });
			expect(h.database.setState).toHaveBeenCalledTimes(2);
		} finally {
			Platform.isMobileApp = origMobile;
		}
	});

	it('leaves the per-tab baseline untouched for an absorbed scroll-only delta', () => {
		const origMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeMobileHarness();
			h.state.lastLoadedFilePath = 'a.md';
			h.state.lastEphemeralState = { scroll: 1, cursor: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } } };
			h.state.lastAnchorAt = Date.now(); // fresh anchor keeps the reflow guard armed
			h.poll();
			h.state.lastTouchAt = 0; // no touch: the next delta is passive reflow

			h.activate(makeScrollingView('a.md', 99, 'leaf-2'));
			h.poll();

			// Absorbed: leaf-1's record stands, leaf-2 never appears.
			expect(h.state.lastStateByLeaf.has('leaf-2')).toBe(false);
			expect(h.database.setState).toHaveBeenCalledTimes(1);
		} finally {
			Platform.isMobileApp = origMobile;
		}
	});
});
