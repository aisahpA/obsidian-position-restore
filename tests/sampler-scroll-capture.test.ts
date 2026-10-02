// 为动态渲染的仪表盘（dataviewjs 嵌入）新加的滚动采集守卫的单元测试：
//  - 嵌入块边界守卫：源自嵌入渲染器内部的滚动
//    （.internal-embed / .cm-embed-block / .block-language-*）绝不能
//    记成宿主视图的位置；
//  - 桌面用户意图守卫：没有近期用户输入的滚动增量
//    （程序化重绘的版面抖动、插件滚动）必须被吸收。
// onScrollCapture 流水线原有的几道闸门（恢复 bracket、搜索
// 锚、排除门）也一并覆盖，作为守卫次序的回归锚。

import { describe, it, expect, vi } from 'vitest';

import { FileView, MarkdownView, Platform } from 'obsidian';
import { Sampler } from '@/position/capture/sampler';
import { PositionState } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';
// leafStates 在 store 上是私有的；这是测试接缝。
import { leafStatesOf } from './support/position-store-seam';

// onScrollCapture 是私有的；测试直接通过这个别名驱动它。
type ScrollCapture = (ev: Event) => void;

type DatabaseStub = {
	db: Record<string, unknown>;
	setState: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
};

// 假的 markdown 视图：真原型链（好让 instanceof 通过），只带
// readEphemeralState / sampler 会碰的最小接口，用一次无类型赋值挂上去，
// 绕开 obsidian 的类型声明。
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
	// leaf 反向引用它的视图（findOwnerLeaf 会解析 leaf.view）。
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1', view };
	return view;
}

function makeEvent(target: HTMLElement): Event {
	const ev = new Event('scroll');
	Object.defineProperty(ev, 'target', { value: target });
	return ev;
}

// 造出实时预览仪表盘会产生的 DOM：宿主编辑器滚动容器里
// 套着一个带自己内层滚动容器的嵌入渲染器。
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
	// 模拟「用户刚交互过」：默认让意图守卫得到满足。
	state.lastUserInputAt = Date.now();
	return { sampler, state, database, store, view, dom, capture };
}

// 往某个 harness 仪表盘 DOM 的宿主滚动容器里
// 追加一个嵌入渲染器（带内层滚动容器）。
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

		// 先嵌入块滚动（噪声），再宿主滚动（信号）：信号必须被记录。
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
		// 清理之后监听器没了：不会再盖章。
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

// 自检：采集 setup 用的那套 mock 路由仍然匹配桌面端。
describe('环境自检', () => {
	it('打桩的 Platform 与桌面采集的假设一致', () => {
		expect(Platform.isDesktopApp).toBe(true);
		expect(Platform.isMobileApp).toBe(false);
	});
});

// sampleActiveView 是手机端专属的按标签页记录写入者
// （leaf 记录）：手机上没有滚动采集监听器，所以 100ms 轮询也必须喂
// 按标签页的基线，否则同一个文件在两个标签页里打开、重启后
// 两者都会恢复到同一条按文件记录。
describe('Sampler.sampleActiveView —— 手机端按标签页记录', () => {
	// 滚动值可设的 markdown 视图，好让一个 harness 模拟
	// 同一文件的两个标签页停在不同位置。
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
			// 种一个与两个标签页都不同的基线，好让第一次轮询
			// 记录的是标签页 1，而不是只给基线播种。
			h.state.lastEphemeralState = { scroll: 1, cursor: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } } };
			h.state.lastAnchorAt = Date.now();
			// 读者刚划过视图：正是近期的一次触摸让这个增量
			// 算他们的、而不是一次重绘造成的。
			h.state.lastTouchAt = Date.now();
			h.poll();

			// 同一文件的第二个标签页滚到了 99，现在是活动页。
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

			// 被吸收：没有触摸能解释这两个增量中的任何一个，所以干脆不写记录 ——
			// 这次重排不是读者的移动。
			expect(leafStatesOf(h.store).has('leaf-2')).toBe(false);
			expect(h.database.setState).not.toHaveBeenCalled();
		} finally {
			Platform.isMobileApp = origMobile;
		}
	});
});

// sampleActiveView 里那张「卡住的锚」安全网在失焦后的
// 宽限窗口内绝不能跑：普通失焦也会把 activeElement 留在 body 上，
// 此时清掉那个 Infinity 会把 SEARCH_ANCHOR_GRACE_MS 截短，
// 让搜索跳跃的落点覆盖掉已存的位置。
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
		// 一次普通失焦排了宽限计时器；activeElement 已经
		// 退回 body，但那个待定的计时器必须让锚保持武装，
		// 直到搜索跳跃登记进来。
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

// 同步客户端在打开的标签页底下替换掉的文件 —— 正是「同步后最后
// 一个位置丢了、重开落在页顶」背后的那种情况。文档换掉会重新
// 测量视口**并**在读者什么都没做的情况下重新映射光标，而任一半
// 单独就足以把已存记录覆盖成笔记顶部。
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
			// 替换对打开视图做了什么：视口退回顶部，
			// 同时 CodeMirror 把选区映射到新文档上。
			rewrite: () => { activeView = makeSyncView('a.md', 'leaf-1', 0, 120); },
			poll: () => sampler.sampleActiveView(),
		};
	}

	// 一个停在 300 行、最后一次动静发生在 `inputAt` 的读者。
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
			// `lastTouchAt > lastAnchorAt` 过去就是整个判据，而读者一旦
			// 碰过一次屏幕，它就永远为真。
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
