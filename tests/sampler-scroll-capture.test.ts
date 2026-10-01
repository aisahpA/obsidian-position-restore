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
import { Sampler } from '@/position/capture/sampler';
import { PositionState } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';
// leafStates is private on the store; this is the test seam.
import { leafStatesOf } from './support/position-store-seam';

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
	const store = new PositionStore(app as never, database as never);
		const sampler = new Sampler(app as never, store, settings, state, { recordOpen: vi.fn(), recordTeleport: vi.fn(), refreshTop: vi.fn() } as never);
	const capture = (sampler as unknown as { onScrollCapture: ScrollCapture }).onScrollCapture;
	// Simulate "user just interacted": by default the intent guard is satisfied.
	state.lastUserInputAt = Date.now();
	return { sampler, state, database, store, view, dom, capture };
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

describe('Sampler.onScrollCapture —— 嵌入块边界的守卫', () => {
	it('宿主滚动容器自己的滚动会被记录', () => {
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

	it('被跳过的嵌入块滚动不会漏进之后的记录（基线不动）', () => {
		const h = makeHarness();
		const inner = appendEmbed(h, 'block-language-dataviewjs');

		// Embed scroll (noise), then host scroll (signal): the signal must record.
		h.capture(makeEvent(inner));
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalledTimes(1);
	});
});

describe('Sampler.onScrollCapture —— 桌面的用户意图守卫', () => {
	it('没有近期输入的那次滚动被吸收（重绘引起的版面抖动）', () => {
		const h = makeHarness();
		h.state.lastUserInputAt = Date.now() - 2100;
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('刚有输入之后的滚动会被记录（落在意图窗口内）', () => {
		const h = makeHarness();
		h.state.lastUserInputAt = Date.now() - 500;
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalledTimes(1);
	});

	it('installUserIntentTracker 给 wheel、pointerdown、keydown 盖章', () => {
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

describe('Sampler.onScrollCapture —— 与既有几道闸门的先后次序', () => {
	it('恢复的 bracket 仍然压住记录', () => {
		const h = makeHarness();
		h.state.restoreStarted();
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
	});

	it('搜索锚仍然压住记录', () => {
		const h = makeHarness();
		h.state.searchAnchorUntil = Number.POSITIVE_INFINITY;
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
	});

	it('排除闸门仍然在被排除文件的宿主滚动上不写库记录', () => {
		const h = makeHarness({ excludedFolders: ['dashboard.md'] });
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).toHaveBeenCalledWith('dashboard.md');
	});

	it('frontmatter 的 B 规则在命中的文件上不写库记录', () => {
		const h = makeHarness({
			frontmatterExcludeProperties: ['publish: true'],
			frontmatters: { 'dashboard.md': { publish: true } },
		});
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).toHaveBeenCalledWith('dashboard.md');
	});

	it('frontmatter 的 B 规则在值不匹配时保留库记录', () => {
		const h = makeHarness({
			frontmatterExcludeProperties: ['publish: true'],
			frontmatters: { 'dashboard.md': { publish: false } },
		});
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalled();
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('逃生舱 `position-restore: true` 即便在被排除的文件夹里也照样记录', () => {
		const h = makeHarness({
			excludedFolders: ['dashboard.md'],
			frontmatters: { 'dashboard.md': { 'position-restore': true } },
		});
		h.capture(makeEvent(h.dom.hostScroller));
		expect(h.database.setState).toHaveBeenCalledTimes(1);
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});

	it('被排除文件里的嵌入块滚动纯属噪声：既不写也不删', () => {
		const h = makeHarness({ excludedFolders: ['dashboard.md'] });
		const inner = appendEmbed(h, 'cm-embed-block');

		h.capture(makeEvent(inner));
		expect(h.database.setState).not.toHaveBeenCalled();
		expect(h.database.deleteFile).not.toHaveBeenCalled();
	});
});

describe('Sampler.onScrollCapture —— 非 markdown 视图', () => {
	it('主动加入的 bases 视图照样记录（原始 scrollTop），嵌入守卫也不拦', () => {
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
		const store = new PositionStore(app as never, database as never);
		const sampler = new Sampler(app as never, store, settings, state, { recordOpen: vi.fn(), recordTeleport: vi.fn(), refreshTop: vi.fn() } as never);
		const capture = (sampler as unknown as { onScrollCapture: ScrollCapture }).onScrollCapture;
		state.lastUserInputAt = Date.now();

		Object.defineProperty(scroller, 'scrollTop', { value: 180, configurable: true });
		capture(makeEvent(scroller));
		expect(database.setState).toHaveBeenCalledWith('board.base', { scroll: 180 });
	});
});

// Sanity: the mock routing used by the capture setup still matches desktop.
describe('环境自检', () => {
	it('打桩的 Platform 与桌面采集的假设一致', () => {
		expect(Platform.isDesktopApp).toBe(true);
		expect(Platform.isMobileApp).toBe(false);
	});
});

// sampleActiveView is the mobile-only writer of per-tab records
// (the leaf records): on mobile there is no scroll-capture listener, so the
// 100ms poll must feed the per-tab baseline too, or the same file open in
// two tabs restores both to the same per-file record after a restart.
describe('Sampler.sampleActiveView —— 手机端按标签页记录', () => {
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
		const store = new PositionStore(app as never, database as never);
		const sampler = new Sampler(app as never, store, settings, state, { recordOpen: vi.fn(), recordTeleport: vi.fn(), refreshTop: vi.fn() } as never);
		const poll = () => sampler.sampleActiveView();
		return {
			sampler, state, database, store,
			activate(view: MarkdownView) { activeView = view; },
			poll,
		};
	}

	it('同一文件的每个标签页各记各的位置（只有 scroll，可信）', () => {
		const origMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeMobileHarness();
			h.state.lastLoadedFilePath = 'a.md';
			// Seed a baseline that differs from both tabs so the first poll
			// records tab 1 instead of only seeding the baseline.
			h.state.lastEphemeralState = { scroll: 1, cursor: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } } };
			h.state.lastAnchorAt = Date.now();
			// The reader just flicked the view: a recent touch is what makes
			// the delta theirs rather than a re-render's.
			h.state.lastTouchAt = Date.now();
			h.poll();

			// Second tab of the same file scrolled to 99, now active.
			h.activate(makeScrollingView('a.md', 99, 'leaf-2'));
			h.state.lastTouchAt = Date.now();
			h.poll();

			expect(leafStatesOf(h.store).get('leaf-1')).toEqual({ filePath: 'a.md', st: { scroll: 42, cursor: { from: { line: 3, ch: 7 }, to: { line: 3, ch: 7 } } } });
			expect(leafStatesOf(h.store).get('leaf-2')).toEqual({ filePath: 'a.md', st: { scroll: 99, cursor: { from: { line: 3, ch: 7 }, to: { line: 3, ch: 7 } } } });
			expect(h.database.setState).toHaveBeenCalledTimes(2);
		} finally {
			Platform.isMobileApp = origMobile;
		}
	});

	it('被吸收的、只有 scroll 的变化不动按标签页的基线', () => {
		const origMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeMobileHarness();
			h.state.lastLoadedFilePath = 'a.md';
			h.state.lastEphemeralState = { scroll: 1, cursor: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } } };
			h.poll();
			h.state.lastTouchAt = 0; // no touch: the next delta is passive reflow

			h.activate(makeScrollingView('a.md', 99, 'leaf-2'));
			h.poll();

			// Absorbed: no touch accounts for either delta, so no record is
			// written at all — the reflow is not the reader's movement.
			expect(leafStatesOf(h.store).has('leaf-2')).toBe(false);
			expect(h.database.setState).not.toHaveBeenCalled();
		} finally {
			Platform.isMobileApp = origMobile;
		}
	});
});

// The stuck-anchor safety net in sampleActiveView must not run
// during the post-blur grace window: a normal blur also leaves activeElement
// on body, and clearing the Infinity there would cut SEARCH_ANCHOR_GRACE_MS
// short, letting the search jump's landing overwrite the saved position.
describe('Sampler.sampleActiveView —— 搜索锚的宽限窗口', () => {
	function makeAnchorHarness() {
		const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
		const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
		const state = new PositionState(settings);
		const app = {
			workspace: {
				getActiveViewOfType: () => makeFakeMarkdownView('a.md', document.createElement('div')),
				iterateAllLeaves: () => undefined,
				containerEl: document.createElement('div'),
			},
			metadataCache: { getFileCache: () => null }, // no frontmatter by default
		};
		const store = new PositionStore(app as never, database as never);
		const sampler = new Sampler(app as never, store, settings, state, { recordOpen: vi.fn(), recordTeleport: vi.fn(), refreshTop: vi.fn() } as never);
		return { sampler, state, poll: () => sampler.sampleActiveView() };
	}

	it('失焦之后的宽限窗口里一直把锚撑着', () => {
		const h = makeAnchorHarness();
		h.state.searchAnchorUntil = Number.POSITIVE_INFINITY;
		// A normal blur scheduled the grace timer; activeElement has already
		// reverted to body, but the pending timer must keep the anchor armed
		// until the search jump registers.
		(h.sampler as unknown as { searchGraceTimer: number }).searchGraceTimer = 1;

		h.poll();

		expect(h.state.searchAnchorUntil).toBe(Number.POSITIVE_INFINITY);
	});

	it('没有宽限计时器在跑时（输入框已从 DOM 移除）救回一个卡住的锚', () => {
		const h = makeAnchorHarness();
		h.state.searchAnchorUntil = Number.POSITIVE_INFINITY;
		(h.sampler as unknown as { searchGraceTimer: number }).searchGraceTimer = 0;

		h.poll();

		expect(h.state.searchAnchorUntil).toBe(0);
	});
});

// A file a sync client replaced under the open tab — the case behind "the last
// position gets lost after a sync, reopening lands at the top". The doc swap
// re-measures the viewport AND re-maps the cursor with the reader doing
// nothing, and either half alone was enough to overwrite the saved record with
// the top of the note.
describe('Sampler.sampleActiveView —— 同步重写不是读者的移动', () => {
	function makeSyncView(path: string, leafId: string, scroll: number, cursorLine: number): MarkdownView {
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path },
			containerEl: document.createElement('div'),
			currentMode: { getScroll: () => scroll },
			editor: { lineCount: () => 100, getCursor: () => ({ line: cursorLine, ch: 0 }) },
			getViewType: () => 'markdown',
		}) as MarkdownView;
		(view as unknown as { leaf: unknown }).leaf = { id: leafId, view };
		return view;
	}

	function makeSyncHarness() {
		const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
		const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
		const state = new PositionState(settings);
		let activeView = makeSyncView('a.md', 'leaf-1', 300, 300);
		const app = {
			workspace: {
				getActiveViewOfType: () => activeView,
				iterateAllLeaves: () => undefined,
				containerEl: document.createElement('div'),
			},
			metadataCache: { getFileCache: () => null },
			vault: { getName: () => 'vault' }, // the store's overlay key needs it
		};
		const store = new PositionStore(app as never, database as never);
		const sampler = new Sampler(app as never, store, settings, state, { recordOpen: vi.fn(), recordTeleport: vi.fn(), refreshTop: vi.fn(), settled: vi.fn() } as never);
		return {
			state, database, store,
			// What the swap does to the open view: the viewport falls back to
			// the top while CodeMirror maps the selection onto the new doc.
			rewrite: () => { activeView = makeSyncView('a.md', 'leaf-1', 0, 120); },
			poll: () => sampler.sampleActiveView(),
		};
	}

	// A reader parked at line 300 who last did anything at `inputAt`.
	function seated(h: ReturnType<typeof makeSyncHarness>, inputAt: number) {
		h.state.lastLoadedFilePath = 'a.md';
		h.state.lastEphemeralState = { scroll: 300, cursor: { from: { line: 300, ch: 0 }, to: { line: 300, ch: 0 } } };
		h.state.lastAnchorAt = Date.now() - 60000;
		h.state.lastUserInputAt = inputAt;
		h.state.lastTouchAt = inputAt;
	}

	it('手机：这一次替换什么都不写', () => {
		const orig = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeSyncHarness();
			seated(h, 0);
			h.rewrite();
			h.poll();

			expect(h.database.setState).not.toHaveBeenCalled();
			expect(leafStatesOf(h.store).size).toBe(0);
		} finally {
			Platform.isMobileApp = orig;
		}
	});

	it('手机：几分钟前的一次触摸不能给之后整段会话放行', () => {
		const orig = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeSyncHarness();
			// lastTouchAt > lastAnchorAt used to be the whole test, and it
			// stays true for good once the reader has touched the screen once.
			const touchedAt = Date.now() - 600000;
			seated(h, touchedAt);
			h.state.lastAnchorAt = touchedAt - 1000;
			h.rewrite();
			h.poll();

			expect(h.database.setState).not.toHaveBeenCalled();
		} finally {
			Platform.isMobileApp = orig;
		}
	});

	it('桌面：这一次替换什么都不写', () => {
		const orig = Platform.isMobileApp;
		Platform.isMobileApp = false;
		try {
			const h = makeSyncHarness();
			seated(h, 0);
			h.rewrite();
			h.poll();

			expect(h.database.setState).not.toHaveBeenCalled();
		} finally {
			Platform.isMobileApp = orig;
		}
	});

	it('桌面：刚敲过键之后的同样位移仍然记录', () => {
		const orig = Platform.isMobileApp;
		Platform.isMobileApp = false;
		try {
			const h = makeSyncHarness();
			seated(h, Date.now());
			h.rewrite();
			h.poll();

			expect(h.database.setState).toHaveBeenCalledWith('a.md', {
				scroll: 0,
				cursor: { from: { line: 120, ch: 0 }, to: { line: 120, ch: 0 } },
			});
		} finally {
			Platform.isMobileApp = orig;
		}
	});
});
