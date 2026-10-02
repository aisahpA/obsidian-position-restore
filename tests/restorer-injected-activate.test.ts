// Restorer.completeInjectedRestore 的单元测试 —— 它是给那些从未触发
// 'file-open' 的注入打开（后台打开、重启恢复的标签页在激活时不改文件）
// 做 'active-leaf-change' 收尾的。这里钉住的逻辑：
//  - 活动 leaf 上没有未消费的注入标记 -> 绝不跑恢复（一次真正的打开，
//    它自己的 file-open 已经消费掉标记，所以这里绝不能重复恢复、
//    更不能跟这次换文件抢跑）；
//  - layoutReady 之前什么都不跑（启动恢复有自己的 file-open 流程；
//    后台 leaf 还没建出来）；
//  - 非 markdown 的活动视图永不收尾。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileView, MarkdownView, type WorkspaceLeaf } from 'obsidian';

import { Restorer } from '@/position/restore/restorer';
import { RestoreModes } from '@/position/restore/modes';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

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

function makeLeaf(id: string): WorkspaceLeaf {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf;
}

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};

// 源码模式的 markdown 视图：注入标记只会为源码打开而设，所以恢复必须
// 派发到 restoreInjectedSource，它不需要异步的阅读渲染。没有 editor.cm
// 意味着像素落定空转。
function makeSourceView(leaf: WorkspaceLeaf, filePath = 'a.md'): MarkdownView {
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf,
		file: { path: filePath },
		getMode: () => 'source',
		currentMode: { getScroll: () => 10 },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: { getCursor: () => undefined },
		setEphemeralState: () => undefined,
	});
	// active-leaf-change 事件带着 leaf，而 completeInjectedRestore 会读
	// leaf.view.file.path 去滑动 lastActiveFilePath —— 接上它，好让这次
	// 滑动真的被测到，而不是静默变成 undefined。
	leaf.view = view;
	return view;
}

// 带「就绪」渲染器（sizer + 预览滚动容器）的阅读模式 markdown 视图，
// 好让遮罩下的恢复能应用并确认已存的滚动。
function makePreviewView(leaf: WorkspaceLeaf, filePath = 'a.md'): MarkdownView {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	const sizer = document.createElement('div');
	const child = document.createElement('div');
	sizer.className = 'markdown-preview-sizer';
	sizer.append(child);
	sizer.style.height = '1000px';
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	scroller.style.height = '1000px';
	containerEl.append(sizer, scroller);
	let currentScroll = 0;
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf,
		file: { path: filePath },
		getMode: () => 'preview',
		currentMode: { getScroll: () => currentScroll },
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			currentScroll = (s.scroll as number) ?? 0;
			scroller.scrollTop = currentScroll;
		},
	});
	leaf.view = view;
	return view;
}

type Harness = {
	state: PositionState;
	leaf: WorkspaceLeaf;
	restorer: Restorer;
};

let coveredLeaves: WorkspaceLeaf[] = [];
let harnessCovers: PositionState | undefined;

function makeHarness(opts: { layoutReady?: boolean; marker?: boolean; activeIsMarkdown?: boolean; filePath?: string; glideSource?: boolean } = {}): Harness {
	const { layoutReady = true, marker = true, activeIsMarkdown = true, filePath = 'a.md', glideSource = false } = opts;
	const state = new PositionState(DEFAULT_SETTINGS);
	const leaf = makeLeaf('leaf-1');
	const view = activeIsMarkdown ? makeSourceView(leaf, filePath) : undefined;
	const app = {
		workspace: {
			layoutReady,
			// 一个 MarkdownView 能同时满足 FileView 与 MarkdownView 两种查询
			// （桩替身照着 `MarkdownView extends FileView` 来）。
			getActiveViewOfType: (Type: unknown) =>
				activeIsMarkdown && (Type === MarkdownView || Type === FileView) ? view : undefined,
			iterateAllLeaves: () => undefined,
		},
	};
	const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
	const restorer = new Restorer(
		app as never,
		glideSource ? { ...DEFAULT_SETTINGS, sourceRestoreMethod: 'glide' } : DEFAULT_SETTINGS,
		store,
		state,
	);
	if (marker) {
		state.injectedOpenLeafIds.add('leaf-1');
		state.handledLeafIdMap.set('leaf-1', filePath);
		state.cover.cover(leaf);
		coveredLeaves.push(leaf);
		harnessCovers = state;
	}
	return { state, leaf, restorer };
}

afterEach(() => {
	// 停掉头一帧遮罩对那些被盖 leaf 的 rAF 重贴循环。
	coveredLeaves.forEach((leaf) => harnessCovers?.cover.uncover(leaf));
	coveredLeaves = [];
	harnessCovers = undefined;
	// 撤掉原型上的 spy（RestoreModes）—— 留一个下来会静默地把本文件里
	// 之后每个测试都指望跑的恢复顶成桩。
	vi.restoreAllMocks();
});

describe('Restorer.completeInjectedRestore', () => {
	it('活动 leaf 没有注入标记时什么都不做', async () => {
		const { state, leaf, restorer } = makeHarness({ marker: false });
		// 活动文件跟前一个 leaf 不同 —— 这是一次真打开的特征，它自己的
		// file-open 已经消费了标记并恢复过；这次收尾绝不能重复恢复，也不能跟它抢跑。
		state.lastActiveFilePath = 'b.md';

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.lastLoadedFilePath).toBeUndefined();
		expect(state.injectedOpenLeafIds.size).toBe(0);
		// 那条轨迹仍然（在 await 之前）滑到了新激活的文件上，
		// 为下一次激活做准备。
		expect(state.lastActiveFilePath).toBe('a.md');
	});

	it('完成一次还没被消费的注入打开：落定、揭幕、锚定', async () => {
		const { state, leaf, restorer } = makeHarness();

		await restorer.completeInjectedRestore(leaf);

		expect(state.injectedOpenLeafIds.size).toBe(0);
		expect(state.restoreRun).toBe(1);
		expect(state.lastLoadedFilePath).toBe('a.md');
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('glide 设置不会把一个盖着的注入打开变成 glide（盖布必须掀开）', async () => {
		// 一次历史遍历（前进/后退）不计 glide 设置一律注入并盖住
		// （「必须瞬间落定」）。把它派给 glideRestore 会让头一帧遮罩卡住 ——
		// glideRestore 从不会揭幕 —— 把 leaf 一直晾白到 2 秒的遮罩安全
		// 计时器：就是选了 edit-glide 时后退导航报的那个长时间空白。
		const { state, leaf, restorer } = makeHarness({ glideSource: true });

		await restorer.completeInjectedRestore(leaf);

		expect(state.injectedOpenLeafIds.size).toBe(0);
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('注入打开落定到补丁交给它的那个落点，而不是存储里的记录', async () => {
		// 一次跨文件的历史跳转：补丁注入**目标记录自己**的位置（也就是浏览器
		// 行上显示的那个），并把它交到这里。存储记录故意不同 —— 它存的是
		// 用户离开文件时漂到的那一处 —— 所以落定到它会把视图从 core 被告知
		// 要落到的那一行上拽走。
		const { state, leaf, restorer } = makeHarness();
		state.injectedLeafStates.set('leaf-1', { scroll: 77 });
		const settle = vi.spyOn(RestoreModes.prototype, 'restoreInjectedSource')
			.mockResolvedValue(undefined);

		await restorer.completeInjectedRestore(leaf);

		expect(settle).toHaveBeenCalledTimes(1);
		expect(settle.mock.calls[0][1]).toMatchObject({ scroll: 77 });
		// 随标记一同消费掉：之后的一次打开绝不能复用它
		expect(state.injectedLeafStates.size).toBe(0);
	});

	it('没有交下落点时就退回存储记录', async () => {
		const { state, leaf, restorer } = makeHarness();
		const settle = vi.spyOn(RestoreModes.prototype, 'restoreInjectedSource')
			.mockResolvedValue(undefined);

		await restorer.completeInjectedRestore(leaf);

		expect(settle.mock.calls[0][1]).toMatchObject({ scroll: RECORD.scroll });
		expect(state.injectedLeafStates.size).toBe(0);
	});

	it('一次导航跳转正在压着提示时不显示落点提示', async () => {
		// NavStack 在前进/后退时武装 cueSuppressUntil：恢复仍然会落定
		// （并锚定），但绝不能显示「位置已恢复」的徽标。
		const { state, leaf, restorer } = makeHarness();
		const show = vi.spyOn(state.cue, 'show');
		state.cueSuppressUntil = Date.now() + 1000;

		await restorer.completeInjectedRestore(leaf);

		expect(state.lastLoadedFilePath).toBe('a.md'); // 恢复跑了并锚定
		expect(show).not.toHaveBeenCalled();

		// 期限已过：下一次普通恢复又会显示徽标。
		state.injectedOpenLeafIds.add('leaf-1');
		state.cueSuppressUntil = Date.now() - 1;
		await restorer.completeInjectedRestore(leaf);
		expect(show).toHaveBeenCalled();
	});

	it('同一 leaf+file 的恢复正在飞时，跳过重复的那次再次声明', async () => {
		// 两个入口（'file-open' 与 'active-leaf-change' 收尾）可能为同一次打开
		// 都触发。第一个消费注入标记并启动落定；第二个在它还飞着的时候到达，
		// 必须被跳过 —— 不取代、不在落定途中揭开头一帧遮罩、不推高恢复轮次。
		const { state, restorer } = makeHarness();
		const first = restorer.restoreEphemeralState();
		const second = restorer.restoreEphemeralState();
		await Promise.all([first, second]);

		expect(state.restoreRun).toBe(1); // 重复那次没有取代
		expect(state.injectedOpenLeafIds.size).toBe(0); // 标记只消费一次
		expect(state.lastLoadedFilePath).toBe('a.md');
		expect(state.inFlightRestoreLeafRuns.size).toBe(0); // 清理干净
	});

	it('同一个 leaf 上换了文件，不被正在飞的那一对挡住', async () => {
		// 快速换文件：一次正在飞的 a.md 恢复绝不能让守卫吞掉同一个 leaf 上的
		// b.md 打开。把 a.md 那一对种成「飞行中」；同一个 leaf 上的 b.md 打开
		// 仍然必须恢复。
		const { state, restorer } = makeHarness({ filePath: 'b.md' });
		state.injectedOpenLeafIds.delete('leaf-1'); // a.md 的标记已消费
		state.handledLeafIdMap.delete('leaf-1'); // 全新的 b.md 打开，不去重
		state.inFlightRestoreLeafRuns.set('leaf-1', { filePath: 'a.md', run: 1 });

		await restorer.restoreEphemeralState();

		expect(state.lastLoadedFilePath).toBe('b.md');
		expect(state.restoreRun).toBe(1); // b.md 那次打开真的恢复了
		// b.md 的恢复取代了种下的 a.md 那条，并做了清理。
		expect(state.inFlightRestoreLeafRuns.size).toBe(0);
	});

	it('layout-ready 之前什么都不做，把标记留给真正的那次激活', async () => {
		const { state, leaf, restorer } = makeHarness({ layoutReady: false });

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
	});

	it('活动视图不是 markdown 视图时什么都不做', async () => {
		const { state, leaf, restorer } = makeHarness({ activeIsMarkdown: false });

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
	});

	it('同文件激活时恢复一个未处理的阅读 leaf（既没有标记，也没有 file-open）', async () => {
		// 一个被推迟的阅读标签页在激活时会建出自己的视图，但不改活动**文件**，
		// 所以 'file-open' 不触发、注入标记也从不存在。事件只带新 leaf，所以
		// 之前活动的文件由插件自己跟踪（lastActiveFilePath）；前一个文件
		// 恰好相同，正是这种情况的特征。
		const state = new PositionState(DEFAULT_SETTINGS);
		state.lastActiveFilePath = 'a.md';
		const leaf = makeLeaf('leaf-1');
		const view = makePreviewView(leaf, 'a.md');
		const app = {
			workspace: {
				layoutReady: true,
				getActiveViewOfType: (Type: unknown) =>
					(Type === MarkdownView || Type === FileView) ? view : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			store,
			state,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(1);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.lastLoadedFilePath).toBe('a.md');
	});

	it('活动文件变了就绝不恢复（一次真正的打开自己有 file-open）', async () => {
		// 之前活动的文件不同：这是一次真正的换文件，它自己的 'file-open'
		// 会做恢复 —— 收尾绝不能跟它抢跑。
		const state = new PositionState(DEFAULT_SETTINGS);
		state.lastActiveFilePath = 'b.md';
		const leaf = makeLeaf('leaf-1');
		const view = makePreviewView(leaf, 'a.md');
		const app = {
			workspace: {
				layoutReady: true,
				getActiveViewOfType: (Type: unknown) =>
					(Type === MarkdownView || Type === FileView) ? view : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			store,
			state,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.handledLeafIdMap.has('leaf-1')).toBe(false);
	});

	it('已经处理过的 leaf，其同文件激活跳过', async () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		state.lastActiveFilePath = 'a.md';
		const leaf = makeLeaf('leaf-1');
		const view = makePreviewView(leaf, 'a.md');
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const app = {
			workspace: {
				layoutReady: true,
				getActiveViewOfType: (Type: unknown) =>
					(Type === MarkdownView || Type === FileView) ? view : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			store,
			state,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});
});