// 读者坐在一个**视图**里时，一个属于它自己的节拍让当前那一步的 state 保持为真（见
// manager.ts 的 sampleActiveViewState）。它不是那个 100ms 的位置轮询：一个视图的 state
// 只需要一个更慢的节奏，而这个节奏花在视图上的代价也更小。
//
// 它之所以存在，是因为读者抵达一个视图时，视图的 state 还没定型。内置浏览器就是显示
// 这一点的例子：在它的页面 commit 并完成导航之前，它用 `{title, mode}` 回答 getState，
// 完全不带上 url —— 于是那次激活压下的那一步（以及地点列表盖在自己好好的 state 上的那
// 一行）命名了一个地点，却没说它在**哪儿**。别的东西要到读者离开时才再读它一次，而一个
// 打开后立刻关掉的标签页永远等不到那一刻。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TAbstractFile } from 'obsidian';

import { App, WorkspaceLeaf } from 'obsidian';
import { PositionManager } from '@/position/manager';
import type { NavFunnel } from '@/nav/funnel';
import type { NavStack } from '@/nav-history/stack';
import type { NavView } from '@/nav/entry';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

beforeEach(() => {
	window.localStorage.clear();
});

// 一个 manager，它的工作区只为**一个** leaf 作答，而它的活动视图是测试说是什么就是什么
// —— 轮询问的是工作区，所以这就是它能看到的整个世界。
function makeHarness() {
	let activeView: unknown = null;
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: () => null as TAbstractFile | null,
		},
		metadataCache: { getFileCache: () => null },
		workspace: {
			layoutReady: true,
			// 两者都算主区：isMainAreaLeaf 会问根节点它是否持有那个 leaf 的元素（见 shared/leaf.ts）。
			rootSplit: { containerEl: { contains: () => true } },
			getActiveViewOfType: () => activeView,
			iterateAllLeaves: () => undefined,
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
		},
	};
	const database = {
		db: {}, setState: vi.fn(), renameFile: vi.fn(), deleteFile: vi.fn(),
	};
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(app as unknown as App, database as never, settings);
	const funnel = (manager as unknown as { funnel: NavFunnel }).funnel;
	const stack = (manager as unknown as { stack: NavStack }).stack;
	return {
		app, manager, funnel, stack,
		setActiveView: (v: unknown) => { activeView = v; },
		step: () => stack.entries[stack.index] as NavView,
	};
}

describe('轮询让当前那一步的 state 保持真实', () => {
	it('标签页激活之后才送到的 view state 也读得到', () => {
		const h = makeHarness();
		// 一个刚打开的网页查看器标签页：页面还没 commit，所以它自己的 state 有一个标题和一个
		// 模式，但没有 url。
		let state: Record<string, unknown> = { title: 'Google', mode: 'blank' };
		let title = 'Google';
		const view = {
			leaf: { id: 'leaf-w', containerEl: {} } as unknown as WorkspaceLeaf,
			getViewType: () => 'webviewer',
			getState: () => state,
			getDisplayText: () => title,
			getIcon: () => 'globe-2',
		};
		(view.leaf as unknown as { view: unknown }).view = view;
		h.setActiveView(view);

		h.manager.recordActivation(view.leaf as unknown as WorkspaceLeaf);
		expect(h.step().state).toEqual({ title: 'Google', mode: 'blank' });

		// 页面 commit 了：查看器现在知道自己在哪里，也知道自己叫什么。
		state = { title: 'Google 搜索', mode: 'webview', url: 'https://www.google.com/' };
		title = 'Google 搜索';
		h.manager.sampleActiveViewState();

		expect(h.step()).toMatchObject({
			kind: 'view', viewType: 'webviewer', label: 'Google 搜索',
			state: { title: 'Google 搜索', mode: 'webview', url: 'https://www.google.com/' },
		});
	});

	it('什么都没动时保持安静，只替当前那一步说话', () => {
		const h = makeHarness();
		const view = {
			leaf: { id: 'leaf-w', containerEl: {} } as unknown as WorkspaceLeaf,
			getViewType: () => 'webviewer',
			getState: () => ({ url: 'https://www.google.com/', mode: 'webview' }),
			getDisplayText: () => 'Google',
			getIcon: () => 'globe-2',
		};
		(view.leaf as unknown as { view: unknown }).view = view;
		h.setActiveView(view);
		h.manager.recordActivation(view.leaf as unknown as WorkspaceLeaf);

		const landing = vi.spyOn(h.funnel, 'landing');
		h.manager.sampleActiveViewState();
		expect(landing).not.toHaveBeenCalled();

		// 读者继续去看一篇笔记：这个视图不再是他们所站的地方，所以它（变了的）state 不关任何人
		// 的事，直到他们离开它。
		h.funnel.recordOpen('a.md', 'leaf-1');
		h.setActiveView({ ...view, getState: () => ({ url: 'https://example.com/', mode: 'webview' }) });
		h.manager.sampleActiveViewState();
		expect(landing).not.toHaveBeenCalled();
	});
});
