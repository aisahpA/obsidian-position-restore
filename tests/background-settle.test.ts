// BackgroundSettler.completeBackgroundRestores 的单元测试 —— 那趟启动清扫，
// 给那些打开时从未触发 'file-open' 的后台分屏标签页做落定。这里钉住的：
//  - 一个已建好的后台源码注入 leaf：在自己的盖布下落定、标记被消费、
//    盖布掀起 —— 而**活动 leaf** 的记录基线（lastLoadedFilePath /
//    lastEphemeralState）原封不动；
//  - 一个已建好的后台阅读 leaf（没有标记）：经无锚的遮罩路径从它
//    已存的记录恢复，并记为已处理；
//  - 已被 caller 目标接管的 leaf（以 Obsidian 原生缓存位置为准）跳过；
//  - 活动 leaf 绝不碰；
//  - 一个延迟 leaf（没有编辑器）保留它的标记并报告 pending；
//  - 一个陈旧标记（配对的那条已处理标记移到了别的文件）被消费掉，不落定；
//  - 被一次进行中恢复持有的 leaf 原封不动地跳过；
//  - 一个已建好却没有存档记录的 leaf 跳过；
//  - 一次 scroll 为 0（只有光标）的注入只揭幕，绝不落定。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MarkdownView, type WorkspaceLeaf } from 'obsidian';

import { BackgroundSettler } from '@/position/restore/background-settle';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

function makeLeaf(id: string, view: MarkdownView): WorkspaceLeaf {
	const leaf = { id, view, containerEl: view.containerEl } as unknown as WorkspaceLeaf;
	(view as { leaf?: unknown }).leaf = leaf;
	return leaf;
}

// 源码模式的记录：滚动加上源码保存所贡献的光标。
const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};

// 阅读模式的记录：只有 scroll —— 预览保存从不贡献光标。一条带光标的
// 记录会让 waitForRestorePainted 在整个期限内反复重贴（阅读的
// 回读对不上它），所以它只会拖慢阅读恢复测试，并不能钉住真实行为。
const READING_RECORD = { scroll: RECORD.scroll };

// 源码模式的 markdown 视图。没有 editor.cm 意味着像素落定空转。
function makeSourceView(filePath = 'a.md'): MarkdownView {
	// 桩替身的 MarkdownView 忽略它的 leaf 参数；一次 cast 满足真构造函数
	// 的签名（constructor(leaf: WorkspaceLeaf)）。
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		file: { path: filePath },
		getMode: () => 'source',
		currentMode: { getScroll: () => 10 },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: { getCursor: () => undefined },
		setEphemeralState: () => undefined,
	});
	return view;
}

// 渲染器「就绪」的阅读模式 markdown 视图：一个带内容的 sizer
// （isContentReady）和一个会被 setEphemeralState 移动的真预览滚动容器，
// 好让 waitForRestorePainted 确认已应用的滚动。Obsidian 的 MarkdownView
// 总会构造它自己的源码编辑器（模式只切换显示的子视图），所以阅读视图
// 也有一个 —— 只是它的 getCursor 回读给不出光标。
function makePreviewView(filePath = 'a.md'): MarkdownView & { setEphemeralState: (s: Record<string, unknown>) => void } {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	const sizer = document.createElement('div');
	const child = document.createElement('div');
	sizer.className = 'markdown-preview-sizer';
	sizer.append(child);
	sizer.style.height = '1000px';
	// jsdom 不做版面，所以 scrollHeight 永远是 0 —— isContentReady 会一直
	// 是 false，waitForContentReady 会烧掉它 2000ms 的期限。把真浏览器
	// 算出来的那个「渲染器产出了内容」信号桩掉。
	Object.defineProperty(sizer, 'scrollHeight', { value: 1000, configurable: true });
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	scroller.style.height = '1000px';
	containerEl.append(sizer, scroller);

	let currentScroll = 0;
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		file: { path: filePath },
		getMode: () => 'preview',
		currentMode: {
			getScroll: () => currentScroll,
		},
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			const scroll = (s.scroll as number) ?? 0;
			currentScroll = scroll;
			scroller.scrollTop = scroll;
		},
	});
	return view as MarkdownView & { setEphemeralState: (s: Record<string, unknown>) => void };
}

type LeafSpec = { id: string; view: MarkdownView };
type HarnessOpts = {
	active?: LeafSpec;
	leaves: LeafSpec[];
	layoutReady?: boolean;
	db?: Record<string, unknown>;
};

type Harness = {
	state: PositionState;
	settler: BackgroundSettler;
	leafObjs: Record<string, WorkspaceLeaf>;
};

function makeHarness(opts: HarnessOpts): Harness {
	const { active, leaves, layoutReady = true, db = { 'a.md': RECORD } } = opts;
	const state = new PositionState(DEFAULT_SETTINGS);
	const leafObjs: Record<string, WorkspaceLeaf> = {};
	for (const { id, view } of leaves)
		leafObjs[id] = makeLeaf(id, view);
	const activeView = active ? leafObjs[active.id]?.view : undefined;
	const app = {
		workspace: {
			layoutReady,
			getActiveViewOfType: (Type: unknown) =>
				active && activeView && (Type === MarkdownView) ? activeView : undefined,
			iterateAllLeaves: (cb: (leaf: unknown) => void) => {
				leaves.forEach(({ id }) => cb(leafObjs[id]));
			},
		},
	};
	const store = new PositionStore(app as never, { db } as never);
	const settler = new BackgroundSettler(app as never, DEFAULT_SETTINGS, store, state);
	return { state, settler, leafObjs };
}

let coveredLeaves: WorkspaceLeaf[] = [];
let harnessCovers: PositionState | undefined;

function markInjected(state: PositionState, leafObjs: WorkspaceLeaf[], filePath = 'a.md') {
	for (const leaf of leafObjs) {
		state.injectedOpenLeafIds.add((leaf as unknown as { id: string }).id);
		state.handledLeafIdMap.set((leaf as unknown as { id: string }).id, filePath);
		state.cover.cover(leaf);
		coveredLeaves.push(leaf);
	}
	harnessCovers = state;
}

afterEach(() => {
	coveredLeaves.forEach((leaf) => harnessCovers?.cover.uncover(leaf));
	coveredLeaves = [];
	harnessCovers = undefined;
});

describe('BackgroundSettler.completeBackgroundRestores', () => {
	it('落定一个已建好的后台源码注入 leaf，且不碰活动基线', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg] });
		markInjected(state, [leafObjs['leaf-bg']]);
		state.lastLoadedFilePath = 'active.md';
		state.lastEphemeralState = { scroll: 1 };

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(false);
		expect(state.cover.isCovered(leafObjs['leaf-bg'])).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('a.md');
		// 后台落定绝不能碰活动 leaf 的记录基线。
		expect(state.lastLoadedFilePath).toBe('active.md');
		expect(state.lastEphemeralState).toEqual({ scroll: 1 });
	});

	it('经盖布路径恢复一个已建好的后台阅读 leaf，并记为已处理', async () => {
		const bg = { id: 'leaf-bg', view: makePreviewView('a.md') };
		const { state, settler } = makeHarness({ leaves: [bg], db: { 'a.md': READING_RECORD } });
		state.lastLoadedFilePath = 'active.md';

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('a.md');
		// 已存的滚动被应用到了视图上。
		expect(bg.view.currentMode.getScroll()).toBe(RECORD.scroll);
		// 基线原封未动。
		expect(state.lastLoadedFilePath).toBe('active.md');
		expect(state.lastEphemeralState).toBeUndefined();
	});

	it('跳过已被 caller 目标接管的 leaf（以 Obsidian 原生缓存位置为准）', async () => {
		const bg = { id: 'leaf-bg', view: makePreviewView('a.md') };
		const { state, settler } = makeHarness({ leaves: [bg] });
		state.handledLeafIdMap.set('leaf-bg', 'a.md');

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('a.md');
		expect(bg.view.currentMode.getScroll()).toBe(0); // 什么都没应用
		expect(state.lastLoadedFilePath).toBeUndefined();
	});

	it('绝不碰活动 leaf', async () => {
		const active = { id: 'leaf-active', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ active, leaves: [active] });
		markInjected(state, [leafObjs['leaf-active']]);

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-active')).toBe(true);
		expect(state.cover.isCovered(leafObjs['leaf-active'])).toBe(true);
	});

	it('保留一个延迟 leaf（还没有编辑器）的标记，并报告 pending', async () => {
		const deferred = { id: 'leaf-def', view: makeSourceView('a.md') };
		delete (deferred.view as { editor?: unknown }).editor;
		const { state, settler, leafObjs } = makeHarness({ leaves: [deferred] });
		markInjected(state, [leafObjs['leaf-def']]);

		expect(await settler.completeBackgroundRestores()).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-def')).toBe(true);
		expect(state.cover.isCovered(leafObjs['leaf-def'])).toBe(true);
	});

	it('消费掉一个陈旧标记：与它配对的那条已处理标记移到了别的文件', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg] });
		markInjected(state, [leafObjs['leaf-bg']], 'a.md');
		state.handledLeafIdMap.set('leaf-bg', 'b.md'); // leaf 走了，标记陈旧

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(false);
		// 陈旧的那一对被放过 —— 清扫从未重新落定 b.md。
		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('b.md');
	});

	it('layout-ready 之前什么都不做', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg], layoutReady: false });
		markInjected(state, [leafObjs['leaf-bg']]);

		expect(await settler.completeBackgroundRestores()).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(true);
	});

	it('跳过正被一次进行中恢复持有的 leaf，一下都不碰', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg] });
		markInjected(state, [leafObjs['leaf-bg']]);
		state.inFlightRestoreLeafRuns.set('leaf-bg', { filePath: 'a.md', run: 1 });

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(true);
		expect(state.cover.isCovered(leafObjs['leaf-bg'])).toBe(true);
	});

	it('跳过已建好但没有存下记录的后台 leaf', async () => {
		const bg = { id: 'leaf-bg', view: makePreviewView('a.md') };
		const { state, settler } = makeHarness({ leaves: [bg], db: {} });

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.handledLeafIdMap.get('leaf-bg')).toBeUndefined();
		expect(bg.view.currentMode.getScroll()).toBe(0); // 什么都没应用
	});

	it('对 scroll 为 0（只有光标）的注入 leaf 直接揭幕，不落定', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({
			leaves: [bg],
			db: { 'a.md': { cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } } } },
		});
		markInjected(state, [leafObjs['leaf-bg']]);

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(false);
		expect(state.cover.isCovered(leafObjs['leaf-bg'])).toBe(false);
	});

	it('有一轮还在飞时，拒绝再来一轮', async () => {
		const deferred = { id: 'leaf-def', view: makeSourceView('a.md') };
		delete (deferred.view as { editor?: unknown }).editor;
		const { state, settler, leafObjs } = makeHarness({ leaves: [deferred] });
		markInjected(state, [leafObjs['leaf-def']]);

		// 借 app mock 的 leaf 迭代来数清扫趟数：一趟会够到它一次，
		// 被拒绝的一趟则永远不会。
		const app = (settler as unknown as {
			app: { workspace: { iterateAllLeaves: (cb: (leaf: unknown) => void) => void } };
		}).app;
		const originalIterate = app.workspace.iterateAllLeaves;
		let sweeps = 0;
		app.workspace.iterateAllLeaves = (cb) => {
			sweeps++;
			originalIterate(cb);
		};

		// 第一趟保持待定（延迟 leaf）；重叠的那次调用必须被拒绝，
		// 而不是把清扫跑两遍。
		const first = settler.completeBackgroundRestores();
		expect(await settler.completeBackgroundRestores()).toBe(false);
		await first;
		expect(sweeps).toBe(1);

		// 守卫释放：新的一趟又跑起来。
		expect(await settler.completeBackgroundRestores()).toBe(false);
		expect(sweeps).toBe(2);
	});
});