// 「落点吸收」修复的回归测试：open 型跳跃
// （anchorLink/startPlainLink/callerTarget —— 侧栏搜索结果点击或链接
// 目标）是异步落地的，所以记录必须一直待在吸收模式里，直到落点落定，
// 否则这次跳跃本身会被写成用户移动。
//
//  - 补丁在 setViewState 那一刻同步武装吸收 —— **不是**在恢复器的
//    file-open 处理函数里，因为同文件的搜索结果点击不触发 'file-open'，
//    恢复器根本不会武装；
//  - 武装期间，100ms 轮询把 lastEphemeralState 的重置基准挪到落点，
//    且不写库；
//  - 视图一停下，轮询就提前结束这个有限吸收（稳定性检查），所以
//    上限（LANDING_ABSORB_MS）不是一个吞掉落定后用户移动的硬延时；
//  - 搜索输入框的失焦宽限计时器，绝不能在落点途中让已武装的有限
//    锚过期。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MarkdownView, WorkspaceLeaf } from 'obsidian';
import { OpenPatcher } from '@/position/restore/patcher';
import { Sampler } from '@/position/capture/sampler';
import { PositionState, LANDING_ABSORB_MS } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

type DatabaseStub = {
	db: Record<string, unknown>;
	setState: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
};

// OpenCover 通过 Obsidian 给 HTMLElement 加的 setCssStyles 扩展
// 来给 leaf 的 DOM 上样式，jsdom 没有这个扩展。
beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

type ViewState = { type?: unknown; state?: { file?: unknown; mode?: unknown } };
type InjectFn = (
	leaf: WorkspaceLeaf,
	viewState: ViewState,
	eState: Record<string, unknown> | undefined,
) => unknown;

const SOURCE_OPEN_A = (file = 'a.md'): ViewState => ({
	type: 'markdown',
	state: { file, mode: 'source' },
});

function makeLeaf(id: string): WorkspaceLeaf {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf;
}

function makeFakeMarkdownView(path: string, containerEl: HTMLElement): MarkdownView {
	containerEl.setCssStyles = vi.fn();
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path },
		containerEl,
		contentEl: containerEl,
		leaf: { id: 'leaf-1', containerEl },
		currentMode: { getScroll: () => 42.3 }, // quantizes to 42
		editor: {
			lineCount: () => 100,
			getCursor: () => ({ line: 3, ch: 7 }),
		},
		getViewType: () => 'markdown',
	}) as MarkdownView;
	return view;
}

// spy 漏斗：sampler 与补丁都是纯粹的**采集**点 —— 它们只往漏斗里写、
// 从不读读者 —— 所以把整个面 spy 起来就是两者各自所需的全部。
function spyFunnel() {
	return {
		recordOpen: vi.fn(),
		recordTeleport: vi.fn(),
		recordActivation: vi.fn(),
		leave: vi.fn(),
		settled: vi.fn(),
		landing: vi.fn(),
	};
}

function makePollHarness() {
	const containerEl = document.createElement('div');
	const view = makeFakeMarkdownView('a.md', containerEl);
	const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
	const app = {
		workspace: { getActiveViewOfType: () => view, containerEl },
		metadataCache: { getFileCache: () => null },
	};
	const settings = DEFAULT_SETTINGS as PluginSettings;
	const state = new PositionState(settings);
	const funnel = spyFunnel();
	const store = new PositionStore(app as never, database as never);
	const sampler = new Sampler(app as never, store, settings, state, funnel as never);
	state.lastLoadedFilePath = 'a.md';
	return { sampler, state, database, view, leave: funnel.leave, settled: funnel.settled };
}

function setCursor(view: MarkdownView, line: number, ch: number) {
	(view as unknown as { editor: { getCursor: () => { line: number; ch: number } } }).editor.getCursor =
		() => ({ line, ch });
}

describe('OpenPatcher —— 在 setViewState 那一刻撑开落点吸收窗口', () => {
	it('派发带 caller 目标的打开（搜索命中）时撑开一个有限吸收窗口', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const leaf = makeLeaf('leaf-1');
		const app = { workspace: { layoutReady: true } } as never;
		const store = new PositionStore(app, { db: {} } as never);
		const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, store, state, spyFunnel() as never, { flushOnLeave: vi.fn() } as never);
		const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);

		// 搜索结果点击会传 eState.match（已对照 core 的 search-view
		// onResultClick 核实）。吸收必须在这里同步武装 —— 同文件的结果点击
		// 不触发 'file-open'，所以恢复器永远等不到机会。
		const eState = { match: {} };
		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
		expect(state.searchAnchorUntil).toBeGreaterThan(Date.now());
		expect(state.searchAnchorUntil).toBeLessThanOrEqual(Date.now() + LANDING_ABSORB_MS);
		expect(Number.isFinite(state.searchAnchorUntil)).toBe(true);
	});

	it('注入式（未被覆盖）的打开不撑开', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const leaf = makeLeaf('leaf-1');
		const app = { workspace: { layoutReady: true } } as never;
		const store = new PositionStore(app, { db: { 'a.md': { scroll: 5 } } } as never);
		const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, store, state, spyFunnel() as never, { flushOnLeave: vi.fn() } as never);
		const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 5 });
		expect(state.searchAnchorUntil).toBe(0);
	});
});

describe('Sampler 轮询 —— 撑开期间吸收落点', () => {
	it('把 lastEphemeralState 的重置基准挪到落点，且不写库', () => {
		const { sampler, state, database, view } = makePollHarness();

		// 补丁已为这次 open 型跳跃武装了吸收。
		state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;

		// Tick 1：给基线播种（落点前的状态，光标在 3:7）。
		sampler.sampleActiveView();
		expect(database.setState).not.toHaveBeenCalled();
		expect(state.lastEphemeralState?.cursor).toMatchObject({ from: { line: 3, ch: 7 } });

		// 跳跃落地：光标跳到搜索命中处。
		setCursor(view, 12, 3);
		sampler.sampleActiveView();
		// 被吸收：不写库，基线跟着落点走。
		expect(database.setState).not.toHaveBeenCalled();
		expect(state.lastEphemeralState?.cursor).toMatchObject({ from: { line: 12, ch: 3 } });

		// 吸收过期：头一次有意的用户移动正常记录。
		state.searchAnchorUntil = Date.now() - 1;
		state.lastUserInputAt = Date.now(); // the reader moved the cursor themselves
		setCursor(view, 20, 0);
		sampler.sampleActiveView();
		expect(database.setState).toHaveBeenCalledTimes(1);
	});

	it('视图一停下就提前结束这个有限吸收窗口，并抓住落点', () => {
		const { sampler, state, settled } = makePollHarness();
		state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;

		// 给基线播种（tick 1 时 prev 是 undefined）。
		sampler.sampleActiveView();
		expect(state.searchAnchorUntil).toBeGreaterThan(Date.now());

		// 连续两个稳定 tick = 落点已落定 -> 过期，
		// 而这次落定读数会作为落点记录的精确位置挂上去（落定采集）。
		sampler.sampleActiveView();
		sampler.sampleActiveView();
		expect(state.searchAnchorUntil).toBeLessThanOrEqual(Date.now());
		// SETTLE 广播（区别于一次离开）说的是这次读数**就是**落点：
		// 最近文件列表只从这里取一个地点的位置，从不从离开取 —— 见
		// NavFunnel.settled。
		expect(settled).toHaveBeenCalledWith('a.md', 'leaf-1', {
			scroll: 42,
			cursor: { from: { line: 3, ch: 7 }, to: { line: 3, ch: 7 } },
		});
	});
});

describe('Sampler.installSearchAnchor —— 失焦宽限计时器与落点吸收之争', () => {
	let cleanups: (() => void)[];

	beforeEach(() => {
		cleanups = [];
		vi.useFakeTimers();
	});
	afterEach(() => {
		cleanups.forEach((fn) => fn());
		cleanups = [];
		vi.useRealTimers();
	});

	function makeAnchorHarness() {
		const state = new PositionState(DEFAULT_SETTINGS);
		const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
		const store = new PositionStore({} as never, database as never);
		const sampler = new Sampler({} as never, store, DEFAULT_SETTINGS, state, spyFunnel() as never);
		sampler.installSearchAnchor((fn) => cleanups.push(fn));
		return { sampler, state };
	}

	function makeSearchInput() {
		const wrapper = document.createElement('div');
		wrapper.className = 'search-input-container';
		const input = document.createElement('input');
		wrapper.appendChild(input);
		document.body.appendChild(wrapper);
		return input;
	}

	function focusInput(input: HTMLElement) {
		input.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
	}

	function blurInput(input: HTMLElement) {
		input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
	}

	it('为落点撑开的有限锚不会提前过期', () => {
		const { state } = makeAnchorHarness();
		const input = makeSearchInput();

		// 聚焦搜索输入框（锚 = Infinity），随后补丁在结果点击处
		// 重新武装一个有限的落点吸收窗口。
		focusInput(input);
		expect(state.searchAnchorUntil).toBe(Number.POSITIVE_INFINITY);
		state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;

		// 结果点击让输入框失焦；250ms 后宽限计时器绝不能
		// 让已武装的吸收过期（它只过期那个 Infinity 失焦）。
		blurInput(input);
		vi.advanceTimersByTime(300);
		expect(state.searchAnchorUntil).toBeGreaterThan(Date.now());
	});

	it('普通的失焦宽限照常过期', () => {
		const { state } = makeAnchorHarness();
		const input = makeSearchInput();

		focusInput(input);
		blurInput(input);
		vi.advanceTimersByTime(300);
		expect(state.searchAnchorUntil).toBeLessThanOrEqual(Date.now());
	});
});