// OpenPatcher 里 setViewState 补丁那次「这是一次什么打开」判定的单元测试
// （injectEphemeralStateOnOpen）。这里钉住的逻辑 —— 每一条背后都有一次排查过的回归：
//  - 一次全新打开注入已存位置，并记下 leaf+file 这一对（预置已处理标记），好让那些
//    打开时从不触发 'file-open' 的对（后台打开、启动恢复）仍然能在之后的切换里去重；
//  - 一次**回放**（对一个已处理过的 leaf+file 再发 setViewState）绝不能把 leaf 自己
//    缓存的 eState 当成 caller 目标来读 —— 那个误判会让重启后在延迟重建上跳过首帧盖布
//    （肉眼可见的闪），并让这一对没被记下（下一次切换会再可见地恢复一次）；
//  - 回放只在被回放的 eState 与已存记录相符时才重新注入。一次不带 eState 的重申
//    （快速切换器再次选中当前文件：setViewState，后面没有 file-open）必须保持原生 ——
//    盖住它会让遮罩一直挂着，直到安全定时器（约 2s 空白）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { MarkdownView } from 'obsidian';

import { OpenPatcher } from '@/position/restore/patcher';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { TabStateRecord,DEFAULT_SETTINGS } from '@/types';
// leafStates 在 store 上是私有的；这就是那道测试接缝。
import { setLeafStates } from './support/position-store-seam';

// injectEphemeralStateOnOpen 是私有的；测试经由这个别名驱动它。
type ViewState = { type?: unknown; state?: { file?: unknown; mode?: unknown } };
type InjectFn = (
	leaf: WorkspaceLeaf,
	viewState: ViewState,
	eState: Record<string, unknown> | undefined,
) => unknown;

// OpenCover 经 Obsidian 对 HTMLElement 的 setCssStyles 扩展来给 leaf 的 DOM 加样式，
// 而 jsdom 缺这个。
beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

function makeLeaf(id: string, containerEl: ParentNode = document.createElement('div')): WorkspaceLeaf & { containerEl: ParentNode } {
	return {
		id,
		containerEl,
	} as unknown as WorkspaceLeaf & { containerEl: ParentNode };
}

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};
const SOURCE_OPEN_A = (file = 'a.md'): ViewState => ({
	type: 'markdown',
	state: { file, mode: 'source' },
});

beforeEach(() => {
	window.localStorage.clear();
});

let disposables: Array<() => void> = [];

function makeHarness(
	db: Record<string, unknown> = {},
	lastStateByLeaf: Map<string, TabStateRecord> = new Map(),
	layoutReady = true,
	// leaf 住在哪儿决定它是什么：默认是一个主区窗格，而讲「被浮层托着的 leaf」的测试会
	// 传自己的那个。
	leaf: WorkspaceLeaf & { containerEl: ParentNode } = makeLeaf('leaf-1'),
) {
	const state = new PositionState(DEFAULT_SETTINGS);
	const app = {
		workspace: {
			layoutReady,
			// 主区 = 这个测试 leaf 所住的那个容器。
			rootSplit: { containerEl: { contains: (el: unknown) => el === leaf.containerEl } },
		},
	} as never;
	const store = new PositionStore(app, { db } as never);
	// store 的构造函数会从存储里播下 leafStates；带预置映射的测试在构造之后替换它
	// （私有成员 → 走接缝 cast）。
	setLeafStates(store, lastStateByLeaf);
	const recordOpen = vi.fn();
	// patcher 是一个纯粹的**采集点**：它往漏斗里写，不读任何读取方，所以它需要的全套东西
	// 就是对它调用的那些探子。
	const funnel = { recordOpen, recordTeleport: vi.fn(), leave: vi.fn(), settled: vi.fn(), landing: vi.fn() };
	const flushOnLeave = vi.fn();
	const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, store, state, funnel as never, { flushOnLeave } as never);
	const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);
	disposables.push(() => state.cover.uncover(leaf));
	return { state, leaf, inject, flushOnLeave, recordOpen };
}

afterEach(() => {
	disposables.forEach((fn) => fn());
	disposables = [];
});

describe('OpenPatcher 对「这是一次什么打开」的判定', () => {
	it('一次全新打开注入已存位置、盖上盖布，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('打开时把正要离开的视图状态刷进记录（快速移动会丢数据的那个窗口）', () => {
		const { leaf, inject, flushOnLeave } = makeHarness();
		const leavingView = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'b.md' },
			currentMode: { getScroll: () => 2.6 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }) },
		});
		(leaf as unknown as { view: unknown }).view = leavingView;

		inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(flushOnLeave).toHaveBeenCalledWith(leavingView, 'b.md', { scroll: 3 });
	});

	it('悬停浮层托着的 leaf 什么都不注入', () => {
		// 一个碰巧是可编辑窗格的预览仍然是预览：它在 app 打开预览的地方打开。在那里恢复会把
		// 卡片落到没人指过的行上，而随之而来的盖布会让卡片一直空着，直到落定为止。
		const popover = document.createElement('div');
		popover.className = 'hover-popover';
		const host = document.createElement('div');
		popover.appendChild(host);
		document.body.appendChild(popover);
		const { state, leaf, inject, recordOpen } =
			makeHarness({ 'a.md': RECORD }, undefined, true, makeLeaf('leaf-1', host));

		const result = inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(result).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		// 不是读者打开的窗格，所以也不是他们导航里的一步。
		expect(recordOpen).not.toHaveBeenCalled();
		popover.remove();
	});

	it('带 caller 目标（搜索命中）的全新打开让位给 core，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('只带着缓存 eState（启动时的原生缓存）的全新打开让位，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { scroll: 5 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('eState 与记录一致的回放，在盖布下重新注入', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { scroll: 10, cursor: RECORD.cursor };

		const result = inject(leaf, SOURCE_OPEN_A(), eState) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		// 回放保住已处理标记，也不设 open kind：随后那次 file-open 必须走到注入过的正文里，
		// 而不是在 openKind 提前返回那里停住。
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('回放会清掉一次从未触发 file-open 的打开留下的陈旧 pending open kind', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		state.pendingOpenKind.set(leaf, 'callerTarget');
		const eState = { scroll: 10, cursor: RECORD.cursor };

		inject(leaf, SOURCE_OPEN_A(), eState);

		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('eState 为空的回放（快速切换器再次选中）保持原生行为', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(result).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});
	
	it('启动时带着没有位置的 eState 的回放（{focus:true} 重建）重新注入', () => {
		// 2026-09 排查过：在 layout-ready 之前，core 会用第二次 setViewState 重申**活动的**
		// leaf，它带的 eState 里只有 {focus:true} —— 重建后的编辑器丢掉注入的位置、落到顶部。
		// 在 layout-ready 之前，空的 eState 永远就是那次重建，所以已存位置必须再注入一次。
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD }, new Map(), false);
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A(), { focus: true }) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('带 focus 的 caller 目标 eState，在启动回放时仍然让位', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD }, new Map(), false);
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { focus: true, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('缓存位置已经与记录分叉的回放保持原生行为', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { scroll: 99 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('回放仍然对真正的 caller 目标（命中）让位', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('同一 leaf 上换了文件会重置已处理标记', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined);

		// b.md 没有记录，默认位置：没有什么可注入的。
		expect(result).toBeUndefined();
		expect(state.handledLeafIdMap.has('leaf-1')).toBe(false);
	});

	it('按标签页的记录胜过按文件的记录', () => {
		// 按文件的记录说是 scroll 10；而 Obsidian 退出时这个标签页在 scroll 99。
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 99 });
	});

	it('按标签页的记录盖不住 caller 目标', () => {
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);
		const eState = { match: {} };

		expect(inject(leaf, SOURCE_OPEN_A(), eState)).toBe(eState);
	});

	it('文件已经变了的按标签页记录当作没有记录（路径守卫）', () => {
		const { leaf, inject } = makeHarness(
			{ 'b.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
	});

	it('侧边栏面板重新声明 state（大纲带着它所跟踪的文件）不算一次记录', () => {
		const { leaf, inject, recordOpen } = makeHarness();

		// 大纲面板重申自己的 view state，把所跟踪的文件放在 state.file 里；它的 leaf 不在主区
		// → 不记录。
		inject(
			makeLeaf('outline-leaf', document.createElement('aside')),
			{ type: 'outline', state: { file: 'a.md' } },
			undefined,
		);
		expect(recordOpen).not.toHaveBeenCalled();

		// 对照：一次主区的打开会记录。
		inject(leaf, SOURCE_OPEN_A(), undefined);
		expect(recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', { key: undefined, force: false });
	});

	it('带 key 的锚点链接保留它的 key', () => {
		const { state, leaf, inject, recordOpen } = makeHarness();
		state.pendingLinkText = 'b.md#安装步骤';

		inject(leaf, SOURCE_OPEN_A('b.md'), undefined);

		expect(recordOpen).toHaveBeenCalledWith('b.md', 'leaf-1', {
			key: 'b.md#安装步骤',
			force: false,
		});
	});
});
