// 两个导航记录套件共用的辅助函数：nav-funnel.test.ts（漏斗自己的契约，以及写进漏斗的
// 那些采集点）与 nav-history-stack.test.ts（读它的那个栈）。
//
// 它**自己不是**测试文件 —— vitest 只收 `*.test.ts`。这一点跟
// tests/support/position-store-seam.ts 一样：一个套件 import 的普通模块。

import { vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { App, FileView, TFile } from 'obsidian';
import { NavFunnel } from '@/nav/funnel';
import { NavStack } from '@/nav-history/stack';
import { NavPlaces } from '@/recent-files/places';
import { NavEntry } from '@/nav/entry';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS, EphemeralState, PluginSettings } from '@/types';

// `missingViewTypes` 是这个库建不出来的那些：注册表里没有工厂，于是要它的标签页拿到一块
// 自称是它的占位窗格（见 shared/leaf）。其他每个类型都能用工厂应答，跟 app 自己装过的每个
// 类型一样。
// `blocks` 是块 id 到它所在行，库的缓存为 `^id` 目标带的就是这个形状。
export function makeApp(
	headings?: Array<{ heading: string; level: number; position: { start: { line: number } } }>,
	missingViewTypes: readonly string[] = [],
	blocks?: Record<string, number>,
): App & { commands: { executeCommandById: ReturnType<typeof vi.fn> } } {
	const missing = new Set(missingViewTypes);
	const cache = headings || blocks
		? {
			headings,
			blocks: blocks && Object.fromEntries(Object.entries(blocks).map(
				([id, line]) => [id, { id, position: { start: { line }, end: { line } } }],
			)),
		}
		: null;
	return {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
		},
		metadataCache: { getFileCache: () => cache },
		workspace: {
			layoutReady: true,
			rootSplit: { containerEl: { contains: (el: unknown) => el === 'main' } },
			getActiveViewOfType: () => null,
			iterateAllLeaves: (_cb: (leaf: WorkspaceLeaf) => void) => undefined,
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
			// 打开管道的视图分支会向工作区要「所有显示某个视图**类型**的 leaf」，一个都没有时再要一个
			// 新标签页（见 stack.ts 的 findLeafShowing / showViewInNewTab）。从不前往视图的套件两者
			// 都没有，所以在这里明说，而不是把这两个方法留空。
			getLeavesOfType: () => [],
			getLeaf: () => ({ setViewState: vi.fn(), detach: vi.fn() }),
		},
		commands: { executeCommandById: vi.fn() },
		viewRegistry: {
			getViewCreatorByType: (type: string) => missing.has(type) ? undefined : () => undefined,
		},
	} as unknown as App & { commands: { executeCommandById: ReturnType<typeof vi.fn> } };
}

// 两个导航读者，按组装根接线的方式接好（见 position/manager.ts）：**采集**点（那些 record*
// 调用）写进漏斗，漏斗再发布给栈与地点列表。脚手架把这三个按名字交回去，于是一个测试能说清
// 它指的是哪一边 —— 采集用 `funnel.`、栈自己的状态与遍历用 `stack.`、最近文件列表用
// `places.`。
export function makeNav(
	app = makeApp(),
	settings: Partial<PluginSettings> = {},
	savedPosition?: (path: string) => EphemeralState | undefined,
) {
	// 落点设置取中间那一档，出厂默认是 'none'（见 LandingsMode）：这里多数测试盯着地点列表
	// 看一次跳转**变成了**什么，而最低那一档会在还没东西可看之前就把跳转挡掉。默认值是一个
	// 设置、不是导航的行为，所以这里没有任何东西被它掰弯。
	// 阈值钉住，理由和落点档一样：这里量的是栈自己的闸门，而出厂的 0 会在每一次 teleport
	// 够到闸门之前就把它挡掉。
	const resolved = { ...DEFAULT_SETTINGS, recentFilesLandings: 'last',
		navHistoryTeleportMinLines: 10, ...settings } as PluginSettings;
	const state = new PositionState(resolved);
	const funnel = new NavFunnel(app, state);
	const stack = new NavStack(app, resolved, state, funnel, savedPosition);
	const places = new NavPlaces(app, resolved);
	funnel.subscribe(stack);
	funnel.subscribe({
		onVisit: (recording) => places.remember(recording.record),
		onLanded: (entry) => places.settle(entry),
		onHere: (entry) => places.markCurrent(entry),
	});
	places.attach({
		openFile: (path, leafId, target) => stack.openFilePlain(path, leafId, target),
		openJump: (entry, target) => stack.travelTo(entry, target),
		openView: (entry, target) => stack.openViewPlace(entry, target),
	});
	return { funnel, stack, places };
}

export function entry(path: string, leafId = 'leaf-1'): NavEntry {
	return { kind: 'visit', path, leafId, t: 1 };
}

// 视图是文件视图的那种 leaf —— 或者不带 `file` 时，空标签页的视图，它是主区域里唯一不算
// 地点的视图。`containerEl` 正是 isMainAreaLeaf 向工作区根问的东西，于是 'sidebar' 模拟
// 一个面板，而默认的 'main' 待在根里。
export function leafWithFile(id: string, file?: string, containerEl: unknown = 'main'): WorkspaceLeaf {
	return {
		id,
		containerEl,
		view: file
			? Object.assign(Object.create(FileView.prototype), { file: { path: file } })
			: { getViewType: () => 'empty' },
	} as unknown as WorkspaceLeaf;
}

// 装着一个非文件视图的 leaf —— 关系图谱、Thino 的备忘列表、主区域里的搜索。它报的每一样
// 都是视图关于**它自己**的说法：`label` 与 `icon` 是它标签页头部显示的名字与标记（代表它
// 的那一行打印与绘制的就是这个），`state` 是它答 getState 的东西 —— 一个地点在它自己的
// 标签页没了之后，就是拿这份 state **重建**起来的（见 nav/entry 的 NavView）。三样都可选：
// 全局图谱不报图标也没有 state，而什么都不报的视图是寻常情形，不是坏了的那种。
export function viewLeaf(
	id: string,
	viewType: string,
	opts: { label?: string; icon?: string; state?: Record<string, unknown>; containerEl?: unknown } = {},
): WorkspaceLeaf {
	return {
		id,
		containerEl: opts.containerEl ?? 'main',
		view: {
			getViewType: () => viewType,
			getDisplayText: () => opts.label,
			getIcon: () => opts.icon,
			getState: () => opts.state,
		},
	} as unknown as WorkspaceLeaf;
}

// 跟着笔记走、而不是代表某篇笔记的 FileView —— 大纲、反向链接、局部图谱、文件属性 ——
// 说的是它进到主区域之后的样子（手工在那里打开，或被手机版布局放到那里）。FileView 答的
// 每个问题它都答，见 shared/leaf 的 isFileDestination。
export function followingLeaf(
	id: string,
	viewType: string,
	file?: string,
	opts: { label?: string; icon?: string } = {},
): WorkspaceLeaf {
	return {
		id,
		containerEl: 'main',
		view: Object.assign(Object.create(FileView.prototype), {
			navigation: false,
			file: file ? { path: file } : null,
			getViewType: () => viewType,
			getDisplayText: () => opts.label,
			getIcon: () => opts.icon,
		}),
	} as unknown as WorkspaceLeaf;
}

// 从一份存档标签页恢复出来的 leaf，而**它的视图从未被建起来**（见 shared/leaf 的
// isDeferredLeaf）：它凭存下来的 state 回答视图的那些问题，自己却不是视图那个类。手机
// 就是这样回到它上次在读的那篇笔记的。
export function deferredLeaf(
	id: string,
	state?: Record<string, unknown>,
	viewType = 'markdown',
	containerEl: unknown = 'main',
): WorkspaceLeaf {
	return {
		id, containerEl, isDeferred: true,
		view: { getViewType: () => viewType, getState: () => state },
	} as unknown as WorkspaceLeaf;
}

// 这些测试搭的都是只有文件的栈（视图条目只在唯一一处整对象相等的断言里出现）；这几个
// 辅助函数把文件那几种 kind 收窄，好让按下标读的那些地方保持简短。
export const pathOf = (e: NavEntry) => (e.kind !== 'view' ? e.path : undefined);
export const keyOf = (e: NavEntry) => (e.kind === 'jump' ? e.key : e.kind === 'teleport' ? `teleport:${e.line}` : undefined);
export const stOf = (e: NavEntry) => (e.kind !== 'view' ? e.st : undefined);
