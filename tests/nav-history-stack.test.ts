// VSCode 式导航栈（nav-history/stack.ts）及其各接入点的测试：
//  - 栈逻辑：每一次 jump 都压栈，一次新 jump 会把前进那一段截掉，
//    去重丢掉重复的同文件 jump（key 相配），force 优先；
//  - 闸门：栈自己的设置（记标签页切换 / 记光标跳变），以及漏斗的启动窗口
//    （布局未就绪）；
//  - 改名/删除的记账让下标一直有意义；
//  - 落盘：每个仓库一轮 localStorage 存取，垃圾数据退化成空，越界下标被夹回；
//  - navigate：指针移动、同文件的 jump 应用条目位置、跨标签页遍历重新激活原
//    来的 leaf 并打开文件、同标签页的文件切换只在下一步对得上时交给原生
//    的每标签页历史（否则退回 openFile）；
//  - 图谱标签页的步：激活记下一个无路径的视图条目，遍历重新激活图谱/文件
//    leaf 而不做任何打开；
//  - 一次被要求在别处进行的前往（按住修饰键开一个地点），以及一个地点带
//    的那句落点上的话，步不留它；
//  - patcher 的 historyNav 注入：存下的位置盖在原生条目那个只带光标的
//    eState 之上，标记恰好消费一次。
//
// 漏斗自己的契约（共享的那几道闸门、每个采集点发布什么、那些广播）以及采样
// 器的跳变采集就在隔壁 nav-funnel.test.ts。两个套件共用
// support/nav-recording-harness.ts。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { FileView, MarkdownView } from 'obsidian';
import { NAV_HISTORY_VERSION, serializeNavHistory } from '@/nav-history/store';
import { NavEntry, NavJump, NavView, NavVisit } from '@/nav/entry';
import { OpenPatcher } from '@/position/restore/patcher';
import { PositionState } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, NavEntryState, PluginSettings } from '@/types';
import {
	entry, keyOf, leafWithFile, makeApp, makeNav, pathOf, stOf, viewLeaf,
} from './support/nav-recording-harness';

const STORAGE_KEY = 'position-restore:nav-history:test-vault';

// 设置面板改的是交给栈的那个 settings 对象（它们共用一个实例，见
// NavStack.settings）—— 这里就是那次改动，不经过整个设置标签页。
function setCap(nav: ReturnType<typeof makeNav>, cap: number): void {
	(nav.stack as unknown as { settings: PluginSettings }).settings.navHistoryCap = cap;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe('NavStack —— 前往一个这个仓库造不出来的视图', () => {
	// 一个被关掉、卸载、或还没加载的插件不会给它的类型留下工厂，于是 app 会用一
	// 个自称是该类型的占位符来应答索取它的标签页（见 shared/leaf 的
	// viewTypeIsMissing）。它背后什么都造不出来，所以这个地点是死的，通向它的
	// 每一扇门都得这么说 —— 包括被那个占位符骗过的那扇。
	function missingApp() {
		const app = makeApp(undefined, ['thino_view']);
		const ws = app.workspace as unknown as {
			getLeavesOfType: (t: string) => unknown[];
			getLeaf: () => unknown;
		};
		return { app, ws };
	}

	it('不去开一个填不满的标签页，尽管占位符应答得了那个类型', async () => {
		const { app, ws } = missingApp();
		const detach = vi.fn();
		const built: { id: string; containerEl: string; detach: unknown; view?: { getViewType: () => string }; setViewState: unknown } = {
			id: 'leaf-new', containerEl: 'main', detach, view: undefined, setViewState: undefined,
		};
		built.setViewState = vi.fn((vs: { type: string }) => {
			built.view = { getViewType: () => vs.type }; // what the placeholder really answers
			return Promise.resolve();
		});
		ws.getLeavesOfType = () => [];
		ws.getLeaf = () => built;
		const { stack } = makeNav(app);

		await stack.openViewPlace({ kind: 'view', leafId: 'gone', viewType: 'thino_view', t: 1 });

		expect(built.setViewState).toHaveBeenCalled();
		expect(detach).toHaveBeenCalled();
	});

	it('哪里都不算「正显示着」：披着占位符的那个标签页不是这个地点', async () => {
		const { app, ws } = missingApp();
		const ghost = { id: 'leaf-ghost', containerEl: 'main', view: { getViewType: () => 'thino_view' } };
		const detach = vi.fn();
		ws.getLeavesOfType = () => [ghost];
		ws.getLeaf = () => ({
			id: 'leaf-new', containerEl: 'main', detach,
			setViewState: vi.fn(() => Promise.resolve()),
		});
		const { stack } = makeNav(app);

		await stack.openViewPlace({ kind: 'view', leafId: 'gone', viewType: 'thino_view', t: 1 });

		expect(app.workspace.setActiveLeaf).not.toHaveBeenCalledWith(ghost);
		expect(detach).toHaveBeenCalled();
	});
});

describe('NavStack —— 栈逻辑', () => {
	it('记录跳转；一次新跳转会截掉前进那一段', () => {
		const app = makeApp();
		(app.workspace as unknown as {
			iterateAllLeaves: (cb: (l: WorkspaceLeaf) => void) => void;
		}).iterateAllLeaves = (cb) => cb(leafWithFile('leaf-1', 'a.md'));
		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		(nav.stack as unknown as { index: number }).index = 0; // simulate having gone back
		nav.funnel.recordOpen('c.md', 'leaf-1');

		expect(nav.stack.entries.map(pathOf)).toEqual(['a.md', 'c.md']);
		expect(nav.stack.index).toBe(1);
		expect(nav.stack.canNavigate(-1)).toBe(true);
		expect(nav.stack.canNavigate(1)).toBe(false);
	});

	it('去重：同一文件不带 key、或带同一个 key，都不再压栈', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1'); // plain re-open: not a jump
		expect(nav.stack.entries.length).toBe(1);

		nav.funnel.recordTeleport('a.md', 'leaf-1', 42); // keyed by target line
		expect(nav.stack.entries.length).toBe(2);

		nav.funnel.recordTeleport('a.md', 'leaf-1', 42); // same line again: same jump
		expect(nav.stack.entries.length).toBe(2);

		nav.funnel.recordTeleport('a.md', 'leaf-1', 300); // different target line
		expect(nav.stack.entries.length).toBe(3);

		// 跳变自成一类：一次带着同一个 teleport key 的带名 jump
		// 不会和它去重。
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'teleport:42' });
		expect(nav.stack.entries.length).toBe(4);

		nav.funnel.recordOpen('a.md', 'leaf-1', { key: '#other' }); // different anchor target
		expect(nav.stack.entries.length).toBe(5);

		nav.funnel.recordOpen('a.md', 'leaf-1', { force: true }); // search match: always
		expect(nav.stack.entries.length).toBe(6);
		expect(nav.stack.index).toBe(5);
	});

	it('闸门：布局就绪之前的启动阶段什么都不记', () => {
		const app = makeApp();
		(app.workspace as unknown as { layoutReady: boolean }).layoutReady = false;
		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		expect(nav.stack.entries.length).toBe(0);
	});

	it('recordTeleport 在首次压栈时补上落点，去重重放时保住它', () => {
		const nav = makeNav();
		const landing: NavEntryState = { scroll: 7, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42, landing);
		expect(keyOf(nav.stack.entries[0])).toBe('teleport:42');
		expect(stOf(nav.stack.entries[0])).toBe(landing);

		// 同一行再来一次（被去重）：原来的落点留了下来。
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42, { scroll: 9, cursor: { from: { line: 42, ch: 3 }, to: { line: 42, ch: 3 } } });
		expect(nav.stack.entries.length).toBe(1);
		expect(stOf(nav.stack.entries[0])).toBe(landing);

		// 一次被闸住的调用（遍历正在执行）既不压栈也不填补。
	});

	it('refreshTop 绝不覆盖带 key 的落点，只给空的那个补上', () => {
		const nav = makeNav();
		const landing: NavEntryState = { scroll: 7, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42, landing);

		// 用户在落定之后漂走了；一次离开不许碰这个落点。
		const drifted: NavEntryState = { scroll: 99, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(nav.stack.entries[0])).toBe(landing);

		// 大纲/锚点条目守同一条带名的规则：空的时候回填（落定采集或第一次离
		// 开），绝不覆盖。按 key 找到：到它压栈时，从那上面跳变走开的漂移
		// 已经自成一个步了。
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo', force: true });
		const jump = nav.stack.entries.findIndex(e => keyOf(e) === 'outline:Foo');
		nav.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(nav.stack.entries[jump])).toBe(drifted);
		nav.funnel.leave('a.md', 'leaf-1', landing);
		expect(stOf(nav.stack.entries[jump])).toBe(drifted);

		// 旧版落盘条目没有落点：回填一次。
		const legacy = makeNav();
		legacy.funnel.recordTeleport('a.md', 'leaf-1', 42);
		expect(stOf(legacy.stack.entries[0])).toBeUndefined();
		legacy.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(legacy.stack.entries[0])).toBe(drifted);

		// 不带 key 的打开条目仍接受每一次离开读取。
		legacy.funnel.recordOpen('a.md', 'leaf-1', { force: true });
		const leave: NavEntryState = { scroll: 3, cursor: { from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } } };
		const plain = legacy.stack.entries.length - 1;
		legacy.funnel.leave('a.md', 'leaf-1', leave);
		expect(stOf(legacy.stack.entries[plain])).toBe(leave);
		legacy.funnel.leave('a.md', 'leaf-1', landing);
		expect(stOf(legacy.stack.entries[plain])).toBe(landing);
	});

	it('读者从一次跳转上走开之后，他们站的那一处自成一个步', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo' });
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 500 });
		// 他们继续往下读，然后跳到另一个标题。光是离开必须什么都不改 —— 这一步
		// 保住它点名的那个落点 —— 而漂移只有在 jump 把他们带离它之后才成一个步。
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 700 });
		expect(nav.stack.entries.length).toBe(1);
		expect(stOf(nav.stack.entries[0])).toEqual({ scroll: 500 });
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bar' });
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.entries[1].kind).toBe('visit');
		expect(stOf(nav.stack.entries[1])).toEqual({ scroll: 700 });
		expect(keyOf(nav.stack.entries[2])).toBe('outline:Bar');
		// 被消费、不是被复制：这一步保住它的落点，所以之后后退先到 700
		// （上面那一步），再到 500（这一步），而不是两次都落在 700 上。
		expect((nav.stack.entries[0] as NavJump).leftAt).toBeUndefined();
		// 是一个步，不是一个地点：栈旁边的列表留着那些被告知的 jump，不许为读者
		// 正在读的那处地点长出一行。
		expect(nav.places.entries.every((p) => p.kind === 'jump')).toBe(true);
	});

	it('漂移是相对视口量的，不是相对视口够不到的那个标题量的', () => {
		const nav = makeNav(makeApp([
			{ heading: 'Last Heading', level: 2, position: { start: { line: 505 } } },
		]));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Last Heading' });
		// 一个靠近笔记末尾的标题：视口够不到它，于是这一步点名第 505 行，却把读
		// 者留在第 490 行站着。
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 490 });
		// 这一步确实点名了那一行 —— 这个 bug 就挂在那个对不上上。
		expect((nav.stack.entries[0] as NavJump).keyLine).toBe(505);
		// ……然后他们读到了末尾。拿标题那一行来量，这根本不算移动；拿他们被留
		// 下站着的那处来量，是一屏。
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 505 });
		nav.funnel.recordOpen('b.md', 'leaf-1');
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.entries[1].kind).toBe('visit');
		expect(stOf(nav.stack.entries[1])).toEqual({ scroll: 505 });
	});

	it('没有离开落点的漂移不留步', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo' });
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 500 });
		// 在离开阈值之内（10 行）：他们还在读这一步点名的地方，所以那处不算别
		// 处，也就不拿它成步。
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 508 });
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bar' });
		expect(nav.stack.entries.length).toBe(2);
	});

	it('同一个标题再点一次，只要读者已经离开了它，就又是一步', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo' });
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 500 });
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 700 });
		// 和栈顶那一步同一个 key，而去重读的正是这个 —— 但读者在它下面 200
		// 行，所以这次点击是真 jump，只因为离开这一点先在栈上。若被去重，就会
		// 把他们挪走却无处可回。
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo' });
		expect(nav.stack.entries.length).toBe(3);
		expect(stOf(nav.stack.entries[1])).toEqual({ scroll: 700 });
	});

	it('读者已经不站在那一步上时，扣住的离开位置就丢掉', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('b.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo' });
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 500 });
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 700 });
		(nav.stack as unknown as { index: number }).index = 0; // a traversal moved off it
		nav.funnel.recordOpen('c.md', 'leaf-1');
		expect(nav.stack.entries.map(pathOf)).toEqual(['b.md', 'c.md']);
	});

	it('用缓存里记录当时的那一行，把大纲 key 升级', () => {
		const nav = makeNav(makeApp([
			{ heading: '**Bold** Title', level: 2, position: { start: { line: 20 } } },
		]));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bold Title', force: true });
		// 源码模式：落定的光标坐在标题上；升级这件事本身取自缓存（权威来源 +
		// 层级 + 行号），st 的视图行只在同文本打平时才用。
		const settle: NavEntryState = {
			scroll: 14,
			cursor: { from: { line: 20, ch: 0 }, to: { line: 20, ch: 3 } },
		};
		nav.funnel.leave('a.md', 'leaf-1', settle);
		expect(keyOf(nav.stack.entries[0])).toBe('outline:## **Bold** Title');
		expect((nav.stack.entries[0] as NavJump).keyLine).toBe(20);

		// 预览模式：视口那一行只用于打平，行号来自缓存。
		const nav2 = makeNav(makeApp([
			{ heading: 'Heading', level: 3, position: { start: { line: 5 } } },
		]));
		nav2.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Heading', force: true });
		nav2.funnel.leave('a.md', 'leaf-1', { scroll: 5, anchor: '### Heading' });
		expect(keyOf(nav2.stack.entries[0])).toBe('outline:### Heading');
		expect((nav2.stack.entries[0] as NavJump).keyLine).toBe(5);
	});

	it('用记录当时的那一行升级锚点链接的 key（key 本身不动）', () => {
		const nav = makeNav(makeApp([
			{ heading: 'My Heading', level: 2, position: { start: { line: 12 } } },
		]));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'a.md#my-heading', force: true });
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 12, anchor: '## My Heading' });
		expect(keyOf(nav.stack.entries[0])).toBe('a.md#my-heading');
		expect((nav.stack.entries[0] as NavJump).keyLine).toBe(12);
	});

	it('用块自己所在的那一行升级块链接的 key', () => {
		// [[a.md#^b1]] 交出 `a.md#^b1`，里面的 `#` 会让一个取第一个 `#` 的扫描
		// 把它读成标题 slug —— 没有哪个标题是以块 id 命名的，所以这一步留不下
		// keyLine，每个块步都退回到文本片段重映射。
		const nav = makeNav(makeApp(undefined, [], { b1: 9 }));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'a.md#^b1', force: true });
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 9, anchor: 'the block’s text' });
		expect(keyOf(nav.stack.entries[0])).toBe('a.md#^b1');
		expect((nav.stack.entries[0] as NavJump).keyLine).toBe(9);
	});

	it('缓存里没有标题对得上时留住记下的 key（重映射兜底）', () => {
		const nav = makeNav(makeApp([
			{ heading: 'Other', level: 1, position: { start: { line: 1 } } },
		]));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Real', force: true });
		nav.funnel.leave('a.md', 'leaf-1', {
			scroll: 1,
			cursor: { from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } },
		});
		expect(keyOf(nav.stack.entries[0])).toBe('outline:Real');
		expect((nav.stack.entries[0] as NavJump).keyLine).toBeUndefined();
	});

	it('再点一次能对上升级后的 key 从而去重（归一化后的大纲 key）', () => {
		const nav = makeNav(makeApp([
			{ heading: '**Bold** Title', level: 2, position: { start: { line: 20 } } },
		]));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bold Title', force: true });
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 20, anchor: '## **Bold** Title' });
		expect(keyOf(nav.stack.entries[0])).toBe('outline:## **Bold** Title');
		// 用户再点同一个大纲项：新记录带的是渲染后的文本，归一化后等于升级过
		// 的源码 key（# 会被剥掉）—— 一次 jump，没有重复条目。
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bold Title' });
		expect(nav.stack.entries.length).toBe(1);
	});

	it('改名把各步迁移过去；删除丢掉它们，并把下标收回范围内', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		nav.funnel.recordOpen('c.md', 'leaf-1');

		nav.stack.renameFile('b.md', 'renamed.md');
		expect(nav.stack.entries.map(pathOf)).toEqual(['a.md', 'renamed.md', 'c.md']);

		(nav.stack as unknown as { index: number }).index = 2; // sitting at c.md
		nav.stack.deleteFile('c.md');
		expect(nav.stack.entries.map(pathOf)).toEqual(['a.md', 'renamed.md']);
		expect(nav.stack.index).toBe(1);

		nav.stack.deleteFile('a.md');
		nav.stack.deleteFile('renamed.md');
		expect(nav.stack.entries.length).toBe(0);
		expect(nav.stack.index).toBe(-1);
	});
});

describe('NavStack —— 激活的记录', () => {
	it('同一文件在另一个标签页里的激活是真的一步；切回来会再记一次', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.funnel.recordActivation(leafWithFile('leaf-2', 'a.md'));
		expect(nav.stack.entries.map((e) => e.leafId)).toEqual(['leaf-1', 'leaf-2']);

		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.index).toBe(2);
	});

	it('同一文件、同一标签页再次激活不记', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.stack.entries.length).toBe(1);
	});

	it('同一 leaf 里打开同一文件之后紧接着的激活，两步合并', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		// 合并后的步保住那次打开的身份。
		expect(nav.stack.entries.length).toBe(1);
	});

	it('不是文件视图的激活、或 leaf 为空，都不记', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1'));
		nav.funnel.recordActivation(null);
		expect(nav.stack.entries.length).toBe(0);
	});

	it('侧边栏面板（大纲）的激活不记', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.funnel.recordActivation(leafWithFile('outline-leaf', 'a.md', 'sidebar'));
		expect(nav.stack.entries.map((e) => e.leafId)).toEqual(['leaf-1']);
	});

	it('侧边栏的激活不通知面板 —— 那会吃掉这一次点击', () => {
		// 离开刷新以前对任何新获得焦点的窗格都跑一次，并通知每一个浏览器
		// （refreshTop → changed）—— 于是常驻面板在读者按下时重建了它的行：点进
		// 面板会丢掉这次点击，同一行得再点第二次。刷新是给文件视图之间的标
		// 签页/窗格切换用的（见 refreshTopLeafOnActivation）。
		const fileLeaf = leafWithFile('leaf-1', 'a.md');
		const fileView = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'a.md' },
			leaf: fileLeaf,
			containerEl: document.createElement('div'),
			getMode: () => 'source',
			currentMode: { getScroll: () => 42.3 },
			editor: { getCursor: () => ({ line: 3, ch: 7 }), lineCount: () => 200 },
		});
		(fileLeaf as unknown as { view: unknown }).view = fileView;
		const sidebarLeaf = leafWithFile('outline-leaf', 'a.md', 'sidebar');

		const app = makeApp();
		(app.workspace as unknown as {
			iterateAllLeaves: (cb: (l: WorkspaceLeaf) => void) => void;
		}).iterateAllLeaves = (cb) => { cb(fileLeaf); cb(sidebarLeaf); };

		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-1');

		nav.funnel.recordActivation(sidebarLeaf);

		// 条目没有被文件视图重新盖章，也没有加任何步：侧边栏拿到焦点不是列表
		// 会记的那种标签页/窗格切换。
		expect(stOf(nav.stack.entries[0])).toBeUndefined();
		expect(nav.stack.entries).toHaveLength(1);
	});

	it('同一个 key 的带名跳转出现在另一个标签页里，自记一步', () => {
		const nav = makeNav();
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42);
		nav.funnel.recordTeleport('a.md', 'leaf-2', 42);
		expect(nav.stack.entries.map((e) => e.leafId)).toEqual(['leaf-1', 'leaf-2']);
	});

	it('切标签页时把被离开那个文件的位置补记到它那一步上', () => {
		// 标签页切换不触发 setViewState，所以没有任何东西会刷新被离开的那个
		// 条目 —— 激活处理器必须做这件事，否则浏览器会把那个文件显示成一个
		// 光秃秃的类型徽标。
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-1', file: 'a.md', markdown: true },
				{ id: 'leaf-2', file: 'b.md', markdown: true },
			],
		});
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf);

		const left = nav.stack.entries.find((e) => pathOf(e) === 'a.md')!;
		expect(stOf(left)).toMatchObject({ scroll: 42, cursor: { from: { line: 3 } } });
	});
});

describe('NavStack —— 记录相关的设置', () => {
	it('navHistoryCap 给栈设上限，最旧的步被丢掉，下标停在顶上', () => {
		const nav = makeNav(makeApp(), { navHistoryCap: 2 });
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		nav.funnel.recordOpen('c.md', 'leaf-1');
		expect(nav.stack.entries.map(pathOf)).toEqual(['b.md', 'c.md']);
		expect(nav.stack.index).toBe(1);
	});

	it('手工把 navHistoryCap 改到 1 以下会被夹回 1', () => {
		const nav = makeNav(makeApp(), { navHistoryCap: 0 });
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		expect(nav.stack.entries.map(pathOf)).toEqual(['b.md']);
	});

	it('根本不是数字的上限退回默认值', () => {
		// "abc" 会让每一次 `length > cap` 比较都为假，把上限整个关掉；null 则
		// 会把它塌成 1。
		const nav = makeNav(makeApp(), { navHistoryCap: 'abc' as unknown as number });
		expect(nav.stack.stackCap()).toBe(DEFAULT_SETTINGS.navHistoryCap);
	});

	it('调低上限会当场裁剪，指针停在顶上', () => {
		const nav = makeNav();
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])
			nav.funnel.recordOpen(p, 'leaf-1');
		expect(nav.stack.entries.length).toBe(5);

		// 设置面板改的是历史持有的那个 settings 对象。
		setCap(nav, 2);
		expect(nav.stack.applyStackCap()).toBe(3);

		expect(nav.stack.entries.map(pathOf)).toEqual(['d.md', 'e.md']);
		expect(nav.stack.index).toBe(1);
		// ……而且第二次调用不会再丢掉任何东西。
		expect(nav.stack.applyStackCap()).toBe(0);
	});

	it('上限降到比当前深度还低时，指针停在最旧的那个幸存者上', () => {
		// 一个活跃的文件视图，好让 canNavigate 报告栈自身的可达性，而不是
		// 「什么都没聚焦」。
		const app = makeApp();
		const leaf = leafWithFile('leaf-1', 'd.md');
		const ws = app.workspace as unknown as {
			getActiveViewOfType: () => unknown;
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		};
		ws.getActiveViewOfType = () => leaf.view;
		ws.iterateAllLeaves = (cb) => cb(leaf);

		const nav = makeNav(app);
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])
			nav.funnel.recordOpen(p, 'leaf-1');
		(nav.stack as unknown as { index: number }).index = 1; // two steps back
		setCap(nav, 2);

		nav.stack.applyStackCap();

		// 「当下」所在的那个条目没了。指针得落到一个合法的地方：最旧的幸存
		// 者，这样前进仍能走剩下那些，而不是遍历直接被废掉。
		expect(nav.stack.entries.map(pathOf)).toEqual(['d.md', 'e.md']);
		expect(nav.stack.index).toBe(0);
		expect(nav.stack.canNavigate(-1)).toBe(false);
		expect(nav.stack.canNavigate(1)).toBe(true);
	});

	it('存盘的栈超出上限时，读回当场裁剪', () => {
		// 上限被调低（并落盘）时，栈那一坨里还握着旧的、更长的历史：从第一次
		// 渲染起上限就必须赢。
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: NAV_HISTORY_VERSION,
			entries: [entry('a.md'), entry('b.md'), entry('c.md'), entry('d.md')],
			index: 3,
		}));

		const nav = makeNav(makeApp(), { navHistoryCap: 2 });

		expect(nav.stack.entries.map(pathOf)).toEqual(['c.md', 'd.md']);
		expect(nav.stack.index).toBe(1);
	});

	it('navHistoryRecordActivation 关闭时：文件标签页的切换不成步，视图标签页仍然成步', async () => {
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-a', file: 'a.md', markdown: true },
				{ id: 'leaf-b', file: 'b.md', markdown: true },
			],
		});
		const nav = h.nav;
		// 这道闸门是从设置面板改的那个对象上读的（见 setCap）。
		(nav.stack as unknown as { settings: PluginSettings }).settings.navHistoryRecordActivation = false;

		nav.funnel.recordOpen('a.md', 'leaf-a');
		nav.funnel.recordOpen('b.md', 'leaf-b');
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf); // back to a.md's tab
		expect(nav.stack.entries.map(pathOf)).toEqual(['a.md', 'b.md']);

		// 关系图谱只能靠激活它的 leaf 进入，所以这道闸门不能管到它：光看原因
		// 会把这一整类都从历史里拿掉，而那不是「记标签页切换」的意思。
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.entries[2]).toEqual({ kind: 'view', leafId: 'leaf-g', viewType: 'graph', t: expect.any(Number) });
		expect(nav.stack.index).toBe(2);

		// 正是那一步让栈对读者站在哪儿保持诚实：如果不记，从图谱后退会落到
		// a.md 上、跳过 b.md —— 那是他们刚离开的笔记。
		await nav.stack.navigate(-1);
		expect(nav.stack.index).toBe(1);
		expect(pathOf(nav.stack.entries[nav.stack.index])).toBe('b.md');
	});

	it('阈值为 0：光标跳变一个也不记', () => {
		const nav = makeNav(makeApp(), { navHistoryTeleportMinLines: 0 });
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42);
		nav.funnel.recordTeleport('a.md', 'leaf-1', 300);
		expect(nav.stack.entries.length).toBe(0);
	});
});

describe('NavStack —— 落盘与读回', () => {
	it('各步与下标经 localStorage 存取一轮，数据不丢', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-2', { key: '#x' });
		nav.stack.persist();

		const restored = makeNav();
		expect(restored.stack.entries).toEqual(nav.stack.entries);
		expect(restored.stack.index).toBe(nav.stack.index);
	});

	it('读到垃圾数据就退化成空；过期的下标夹回合法范围', () => {
		window.localStorage.setItem(STORAGE_KEY, '{not json');
		const empty = makeNav();
		expect(empty.stack.entries.length).toBe(0);
		expect(empty.stack.index).toBe(-1);

		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: NAV_HISTORY_VERSION,
			entries: [entry('a.md'), entry('b.md')],
			index: 99,
		}));
		const clamped = makeNav();
		expect(clamped.stack.entries.length).toBe(2);
		expect(clamped.stack.index).toBe(1);
	});

	it('小数下标会被夹住，而不是一路顶到 entries.length', () => {
		// 栈用 `entries.length = index + 1` 截自己，而 2.5 会让它变成 3.5
		// —— RangeError: Invalid array length，就在下一次压栈时。只有手改过
		// 或被截断的一坨才带得动这种值。
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: NAV_HISTORY_VERSION,
			entries: [entry('a.md'), entry('b.md')],
			index: 1.5,
		}));
		const nav = makeNav();
		expect(nav.stack.index).toBe(1);
		// 而这里正是它本来会抛的地方：压栈先做截断。
		nav.funnel.recordOpen('c.md', 'leaf-3');
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.index).toBe(2);
	});

	it('别的格式的那一坨（缺版本号或是别的版本）整个丢掉', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			entries: [entry('a.md')],
			index: 0,
		}));
		const nav = makeNav();
		expect(nav.stack.entries.length).toBe(0);
		expect(nav.stack.index).toBe(-1);
	});

	it('格式不对的步被丢掉，合法的能过读取过滤', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: NAV_HISTORY_VERSION,
			entries: [
				{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 }, // ok
				{ path: 'x.md' }, // no kind, no leafId: dropped
				{ kind: 'jump', path: 'y.md', leafId: 'leaf-2', key: 3, t: 1 }, // junk key: dropped
				{ kind: 'view', viewType: 'thino_view', label: 'Thino', leafId: 'leaf-g', t: 1 }, // ok (a view keeps its own name)
				{ kind: 'visit', path: 'b.md', leafId: 'leaf-4' }, // no timestamp: dropped
				{ leafId: 'leaf-3' }, // neither kind nor path/viewType: dropped
			],
			index: 1,
		}));
		const nav = makeNav();
		expect(nav.stack.entries.length).toBe(2);
		expect(nav.stack.index).toBe(1);
	});

	it('写盘去重属于实例，不属于模块', () => {
		// 这个去重不许是共享状态：否则第二个历史（同页面里的另一个仓库，或者
		// 下一个测试）会以为盘上那一坨是自己的，跳过它欠的一次写。
		const setItem = vi.spyOn(Storage.prototype, 'setItem');
		// 按 key 计数：persist() 现在写两坨（栈和最近文件列表，见
		// NavStack.persist），而被测的这个去重是栈的那个。
		const writes = () => setItem.mock.calls.filter(c => c[0] === STORAGE_KEY).length;
		try {
			const first = makeNav();
			first.funnel.recordOpen('a.md', 'leaf-1');
			first.stack.persist();
			expect(writes()).toBe(1);
			first.stack.persist(); // unchanged: deduped
			expect(writes()).toBe(1);

			const second = makeNav();
			second.stack.persist();
			expect(writes()).toBe(2);
		} finally {
			setItem.mockRestore();
		}
	});
});

// 跨标签页遍历的 fixture：leaf-2 是条目自己的（目标）标签页，leaf-1 握着
// 活跃文件视图。`targetLeafView` 是那个标签页现在显示的东西 ——
// { file: undefined } 强制走打开那条路，一个显示着目标文件的 MarkdownView
// 则走「标签页已经在了」那条路。
function makeCrossTabHarness(app = makeApp(), targetLeafView: unknown = { file: undefined }) {
	const targetLeaf = {
		id: 'leaf-2',
		isDeferred: false,
		view: targetLeafView,
		openFile: vi.fn().mockResolvedValue(undefined),
	};
	const activeLeaf = { id: 'leaf-1', isDeferred: false };
	const view = Object.assign(Object.create(FileView.prototype), {
		file: { path: 'c.md' },
		leaf: activeLeaf,
	});
	const ws = app.workspace as unknown as {
		getActiveViewOfType: () => unknown;
		iterateAllLeaves: (cb: (l: unknown) => void) => void;
	};
	ws.getActiveViewOfType = () => view;
	ws.iterateAllLeaves = (cb) => { cb(activeLeaf); cb(targetLeaf); };
	return { app, targetLeaf, view };
}

describe('NavStack.navigate', () => {
	it('绝不越出栈的两端', async () => {
		const nav = makeNav();
		await nav.stack.navigate(-1);
		expect(nav.stack.index).toBe(-1);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		await nav.stack.navigate(-1); // nothing before the first entry
		expect(nav.stack.index).toBe(0);
	});

	it('一次打开永远卡住时，看门狗放开遍历的闸门', async () => {
		vi.useFakeTimers();
		try {
			const app = makeApp();
			const nav = makeNav(app);
			nav.funnel.recordOpen('a.md', 'leaf-1');
			nav.funnel.recordOpen('b.md', 'leaf-1');
			(nav.stack as unknown as { index: number }).index = 0;
			// 在同一 leaf 上前进到 b.md 会落到 openInLeaf → leaf.openFile，
			// 那里被桩成永不 resolve。
			const activeLeaf = { id: 'leaf-1', containerEl: 'main' } as unknown as WorkspaceLeaf;
			const activeView = Object.assign(Object.create(FileView.prototype), {
				file: { path: 'a.md' },
				leaf: activeLeaf,
			});
			(activeLeaf as unknown as { view: unknown }).view = activeView;
			(activeLeaf as unknown as { openFile: () => Promise<never> }).openFile =
				() => new Promise<never>(() => undefined);
			(app.workspace as unknown as { getActiveViewOfType: () => unknown })
				.getActiveViewOfType = () => activeView;

			void nav.stack.navigate(1); // hangs inside openFile
			expect(nav.stack.canNavigate(-1)).toBe(false); // bracket up: traversal gated

			await vi.advanceTimersByTimeAsync(5000); // watchdog fires

			// bracket 松开：新的遍历不再被挡。
			expect(nav.stack.canNavigate(-1)).toBe(true);
			await nav.stack.navigate(-1);
			expect(nav.stack.index).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('同文件的后退把这一步的位置应用到视图上', async () => {
		// 这个 leaf 的 view 就是视图本身 —— app 的形状（一个视图带着它自己的
		// leaf 反引用），也是 execute() 应用文件内 jump 的那个（见同文件那一
		// 支）：一个 leaf 握着光秃秃的 `{ file }` 桩，是 app 永远不会产生的形状。
		const leaf: { id: string; isDeferred: boolean; view?: unknown } = { id: 'leaf-1', isDeferred: false };
		const applied: unknown[] = [];
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'a.md' },
			leaf,
			containerEl: document.createElement('div'),
			getMode: () => 'source',
			currentMode: { getScroll: () => 42.3 },
			editor: {
				getCursor: () => ({ line: 3, ch: 7 }),
				lineCount: () => 200,
			},
			setEphemeralState: (st: unknown) => { applied.push(st); },
		});
		leaf.view = view;
		const app = makeApp();
		(app.workspace as unknown as {
			getActiveViewOfType: () => unknown;
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		}).getActiveViewOfType = () => view;
		(app.workspace as unknown as {
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		}).iterateAllLeaves = (cb) => cb(leaf);

		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'teleport:60' });
		(nav.stack.entries[0] as NavVisit).st = { scroll: 5, cursor: { from: { line: 60, ch: 0 }, to: { line: 60, ch: 0 } } };
		expect(nav.stack.index).toBe(1);

		await nav.stack.navigate(-1);

		expect(nav.stack.index).toBe(0);
		// 应用了目标条目的位置（光标 + 量化后的滚动）
		expect(applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		// 被落在后面的那个条目用实时读取刷新过
		expect(stOf(nav.stack.entries[1])).toMatchObject({ scroll: 42 });
	});

	it('从一次跳转后退、再前进回到它，落在跳转上，不是落在漂移上', async () => {
		// 他们跳到某个标题然后继续读。后退/前进是这个栈在走它自己的步，不是读者
		// 离开：前进得落在这一步点名的那个标题上。漂移只有在一次导航把他们带离
		// 它之后才自成一个步。
		const h = fileLeafHarness(700.4, 3);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;
		const nav = makeNav(h.app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 100 });
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo' });
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 500 });

		await nav.stack.navigate(-1);
		expect(nav.stack.index).toBe(0);
		expect(h.applied.at(-1)).toMatchObject({ scroll: 100 });
		// 那个标题 —— 栈里别的任何东西都不持有的唯一一处地点。
		await nav.stack.navigate(1);
		expect(nav.stack.index).toBe(1);
		expect(h.applied.at(-1)).toMatchObject({ scroll: 500 });
		// ……而遍历读到的那个漂移没了：拿它成步的话，会永远夹在读者和标题之间。
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bar' });
		expect(nav.stack.entries.map((e) => e.kind)).toEqual(['visit', 'jump', 'jump']);
		expect(keyOf(nav.stack.entries[1])).toBe('outline:Foo');
	});

	// 最近文件列表的两条前往路径（见 places.ts）：一个 jump 地点打开文件并落在
	// 它记下的那一处，而且从读者所在的地方分叉 —— 所以后退会回到起点。测试要前
	// 往的那个地点下标是按身份找的，不是写死的：跳变不是地点，所以列表的下标和
	// 栈的对不齐。
	const placeOf = (nav: ReturnType<typeof makeNav>, pred: (e: NavEntry) => boolean): number =>
		nav.places.entries.findIndex(pred);
	// 一个 markdown leaf，它自己的 view 会报告位置，外加把它接成活跃（或最近）
	// 文件视图的那套线。下面每个用例都关于打开管线对这个视图做了什么。
	function fileLeafHarness(scroll: number, line: number) {
		const leaf: { id: string; isDeferred: boolean; view?: unknown } = { id: 'leaf-1', isDeferred: false };
		const applied: unknown[] = [];
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'a.md' },
			leaf,
			containerEl: document.createElement('div'),
			getMode: () => 'source',
			currentMode: { getScroll: () => scroll },
			editor: { getCursor: () => ({ line, ch: 0 }), lineCount: () => 500 },
			setEphemeralState: (st: unknown) => { applied.push(st); },
		});
		leaf.view = view;
		const app = makeApp();
		(app.workspace as unknown as {
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		}).iterateAllLeaves = (cb) => cb(leaf);
		return { app, leaf, view, applied };
	}

	it('一个地点从当前这一步分叉；后退回到起点', async () => {
		const h = fileLeafHarness(42.3, 3);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;

		const nav = makeNav(h.app);
		// 两个不同的挂钟时刻：这次前往的副本必须重新盖章（它是一个新的导航
		// 时刻），而不是重放所记地点的 t。
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
		try {
			nav.funnel.recordOpen('a.md', 'leaf-1');
			nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## One' });
			nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## Two' });
			const at = placeOf(nav, e => e.kind === 'jump' && e.key === 'outline:## One');
			// 这次 jump 落定的那个落点，按 store 保存它的样子：没有光标（见
			// readLandingState），以及标题自己的行号 —— 它不必等于记下的滚动值。
			(nav.places.entries[at] as NavJump).keyLine = 60;
			(nav.places.entries[at] as NavJump).st = { scroll: 5 };
			expect(nav.stack.index).toBe(2);

			nowSpy.mockReturnValue(2000);
			await nav.places.travel(at);
		} finally {
			nowSpy.mockRestore();
		}

		// 目标被重新推到当前条目之上（分叉语义）
		expect(nav.stack.index).toBe(3);
		expect(nav.stack.entries.map(keyOf)).toEqual([
			undefined, 'outline:## One', 'outline:## Two', 'outline:## One',
		]);
		// 压进去的条目是一个副本 —— 原来的地点保住它自己的位置
		expect(nav.stack.entries[3]).not.toBe(nav.stack.entries[1]);
		// ……以及它自己的（全新的）采集戳
		expect(nav.stack.entries[1].t).toBe(1000);
		expect(nav.stack.entries[3].t).toBe(2000);
		// 和前往一个步或地点时应用的是同一个落点：笔记停在它记下的滚动处，光
		// 标在 jump 点名的**那一行的行首**（见 landedLine）。
		expect(h.applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		// 起点就是正下方那个条目 —— 后退一步就回到它
		expect(nav.stack.canNavigate(-1)).toBe(true);
		expect(nav.stack.canNavigate(1)).toBe(false);

		await nav.stack.navigate(-1);
		expect(nav.stack.index).toBe(2);
		expect(h.applied[1]).toMatchObject({ scroll: 42 });
		// 遍历期间落点 cue 被抑制（在前往时武装一次，在同文件应用时再武装
		// 一次）
		const state = (nav.stack as unknown as { state: PositionState }).state;
		expect(state.cueSuppressUntil).toBeGreaterThan(Date.now());
	});

	it('笔记落到那行之后，标出跳转点名的那一行', async () => {
		// jump 会点名一行，所以落点得读起来像 app 自己对「在大纲里点那个标题」
		// 的应答 —— 而最近文件里一个标题行正是那个大纲。在前往时提出、在落点落定
		// 后才回答，所以被标出的是这一行现在的样子，不是当初求的那一行。
		const h = fileLeafHarness(42.3, 3);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;

		const nav = makeNav(h.app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## One' });
		nav.funnel.recordOpen('b.md', 'leaf-1'); // step away, so this is a travel to somewhere else
		const at = placeOf(nav, e => e.kind === 'jump');
		(nav.places.entries[at] as NavJump).keyLine = 60;
		(nav.places.entries[at] as NavJump).st = { scroll: 5 };
		const state = (nav.stack as unknown as { state: PositionState }).state;
		const flashLine = vi.spyOn(state.cue, 'flashLine').mockImplementation(() => undefined);

		await nav.places.travel(at);

		expect(flashLine).toHaveBeenCalledWith(h.view, 60);
		// 求一次便用掉：一个仍被留作待求的行，不属于任何一次前往。
		expect(state.pendingLineFlash).toBeUndefined();
	});

	it('没有点名任何行的步，什么都不标', async () => {
		// 一个步记的是阅读位置，不是标题，所以没有行可标，而它记下的光标原样
		// 一路带过去。
		const h = fileLeafHarness(42.3, 3);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;

		const nav = makeNav(h.app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		(nav.stack.entries[0] as NavVisit).st = { scroll: 5, cursor: { from: { line: 60, ch: 0 }, to: { line: 60, ch: 0 } } };
		const state = (nav.stack as unknown as { state: PositionState }).state;
		const flashLine = vi.spyOn(state.cue, 'flashLine').mockImplementation(() => undefined);

		await nav.stack.navigate(-1);

		expect(h.applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		expect(flashLine).not.toHaveBeenCalled();
	});

	it('读者已经站着的那个地点就地重落，而不是复制一份', async () => {
		// 在读者正站着的那个行上再按一次，必须就地重落那个地点，而不是压一份副
		// 本：遍历的栈顶就是那个地点，而一个重复的步会让起点成为新的「上一个」
		// 条目，于是下一次后退又会直接弹回前进（A → B → A …），每按一次多一条。
		const h = fileLeafHarness(1, 0);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;

		const nav = makeNav(h.app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## One' });
		expect(nav.stack.index).toBe(1);

		await nav.places.travel(placeOf(nav, e => e.kind === 'jump'));

		expect(nav.stack.index).toBe(1);
		expect(nav.stack.entries.map(keyOf)).toEqual([undefined, 'outline:## One']);
	});

	it('没有落定的跳变落在它记下的那一行，而不是哪儿都不去', async () => {
		// 一个跳转后读取始终没到的跳变只留着它瞄准的那一行（`st` 缺失）。它不
		// 是一个地点（见 places.ts），但遍历仍够得到它 —— 那时必须把读者带到那
		// 一行，而不是哪儿都不去。
		const h = fileLeafHarness(0, 0);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;

		const nav = makeNav(h.app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordTeleport('a.md', 'leaf-1', 60); // recorded with no landing read
		nav.funnel.recordOpen('b.md', 'leaf-1'); // step away, so leaving a.md does not fill it
		expect(stOf(nav.stack.entries[1])).toBeUndefined();

		await nav.stack.navigate(-1);

		// 条目自己记下的那一行，就是遍历所应用的落点
		expect(h.applied[0]).toMatchObject({ scroll: 60 });
	});

	it('地点自己没记下落点时，应用存盘的那条记录', async () => {
		// 这样的地点从文件的存盘记录里取走它的行（见 describeNavEntry），所以
		// 前往它时会应用那条记录：没有它，行点名了一行而点击什么都没应用。
		const h = fileLeafHarness(0, 0);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;

		const nav = makeNav(h.app, {}, (path) => (path === 'a.md' ? { scroll: 41 } : undefined));
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## One' }); // no landing ever settled
		nav.funnel.recordOpen('b.md', 'leaf-1'); // step away
		const at = placeOf(nav, e => e.kind === 'jump');
		expect(stOf(nav.places.entries[at])).toBeUndefined();

		await nav.places.travel(at);

		// 行借来它那一行的那条记录，就是这次前往所应用的落点
		expect(h.applied[0]).toMatchObject({ scroll: 41 });
	});

	it('侧边栏拿着焦点时，同文件的跳转照样应用', async () => {
		// 常驻的最近文件面板拿着焦点时，没有活跃的文件视图 —— 工作区的活跃视图
		// 是侧边栏，不是 FileView —— 而它背后的文件标签页仍然显示着笔记。jump
		// 应用的是条目**自己的** leaf，起点也是从那里采集的；工作区的活跃视图两
		// 样都答不上。
		const h = fileLeafHarness(90, 90);
		// getActiveViewOfType 保持 null（makeApp 的默认）：侧边栏是活跃的。
		(h.app.workspace as unknown as { getMostRecentLeaf: () => unknown }).getMostRecentLeaf = () => h.leaf;

		const nav = makeNav(h.app, {}, (path) => (path === 'a.md' ? { scroll: 41 } : undefined));
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## One' });
		nav.funnel.recordOpen('b.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1'); // the note the reader is in, keyless
		const at = placeOf(nav, e => e.kind === 'jump');
		expect(at).toBeGreaterThanOrEqual(0);
		const origin = nav.stack.index;

		await nav.places.travel(at);

		// ……已在屏幕上的这篇笔记较老的那个地点被应用
		expect(h.applied[0]).toMatchObject({ scroll: 41 });
		// ……而起点是在前往之前从条目**自己的** leaf 采到的，所以「后退」会回到
		// 读者实际所在的地方（见 refreshTopFromActiveView）：侧边栏拿着焦点时没
		// 有活跃文件视图可读。
		const branch = nav.stack.entries.findIndex((e, i) => i > origin && keyOf(e) === 'outline:## One');
		expect(branch).toBeGreaterThan(0);
		expect(stOf(nav.stack.entries[branch - 1])).toMatchObject({ scroll: 90 });
	});

	it('跳转地点的落点取自落定，绝不取自离开', () => {
		// 栈用读者的「离开」回填一个带名的条目，好让之后的后退有处可回。那次读
		// 取不是这个 jump 自己的那处地点，而一个地点的行**承诺**它印出的那处地点
		// —— 所以一个点了标题、继续读、然后切换文件的读者，绝不能发现那个标题所
		// 记的地点被挪到了他们碰巧漂到的地方。
		const settled = makeNav();
		settled.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## H' });
		const a = settled.places.entries.findIndex(e => e.kind === 'jump');
		settled.funnel.settled('a.md', 'leaf-1', { scroll: 152 });
		expect(stOf(settled.places.entries[a])).toEqual({ scroll: 152 });

		const left = makeNav();
		left.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## H' });
		const b = left.places.entries.findIndex(e => e.kind === 'jump');
		left.funnel.leave('a.md', 'leaf-1', { scroll: 900 });
		// 栈留住了漂移（后退需要一个位置）……
		expect(stOf(left.stack.entries[left.stack.index])).toEqual({ scroll: 900 });
		// ……而地点一个都没留：它的行退回到文件自己的记录，而不是把漂移冻成标
		// 题的那处地点。
		expect(stOf(left.places.entries[b])).toBeUndefined();

		// 在那次回填**之后**才到的落点仍然赢，地点那时也听得到它：一个读者在它
		// 落定之前就离开的 jump，不是一个没有落点的 jump。
		const late = makeNav();
		late.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## H' });
		const c = late.places.entries.findIndex(e => e.kind === 'jump');
		late.funnel.leave('a.md', 'leaf-1', { scroll: 900 });
		late.funnel.settled('a.md', 'leaf-1', { scroll: 152 });
		expect(stOf(late.stack.entries[late.stack.index])).toEqual({ scroll: 152 });
		expect(stOf(late.places.entries[c])).toEqual({ scroll: 152 });
	});

	it('跨标签页后退会重新激活原来那个 leaf，并在那里打开文件', async () => {
		const targetLeaf = {
			id: 'leaf-2',
			isDeferred: false,
			view: { file: undefined },
			openFile: vi.fn().mockResolvedValue(undefined),
		};
		const activeLeaf = { id: 'leaf-1', isDeferred: false };
		const view = Object.assign(Object.create(FileView.prototype), {
			file: { path: 'c.md' },
			leaf: activeLeaf,
		});
		const app = makeApp();
		const ws = app.workspace as unknown as {
			getActiveViewOfType: () => unknown;
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
			setActiveLeaf: (l: unknown, opts?: unknown) => void;
		};
		ws.getActiveViewOfType = () => view;
		ws.iterateAllLeaves = (cb) => { cb(activeLeaf); cb(targetLeaf); };

		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-2');
		nav.funnel.recordOpen('c.md', 'leaf-1');
		await nav.stack.navigate(-1);

		expect(ws.setActiveLeaf).toHaveBeenCalledWith(targetLeaf, { focus: true });
		expect(targetLeaf.openFile).toHaveBeenCalledTimes(1);
		expect(targetLeaf.openFile.mock.calls[0][0]).toMatchObject({ path: 'a.md' });
	});

	it('跨标签页打开会触发 pendingHistoryNav，好让遍历立刻落地', async () => {
		// openInLeaf 必须武装 delegateNative 武装的同一个标记：setViewState 补
		// 丁随后把按文件的记录注在朴素打开之上，绕开 glide 那一档（历史遍历
		// 瞬时落定；这里若用原生 glide，会扫过未渲染的内容留下一片空白）。
		vi.useFakeTimers();
		try {
			const targetLeaf = {
				id: 'leaf-2',
				isDeferred: false,
				view: { file: undefined },
				openFile: vi.fn().mockResolvedValue(undefined),
			};
			const activeLeaf = { id: 'leaf-1', isDeferred: false };
			const view = Object.assign(Object.create(FileView.prototype), {
				file: { path: 'c.md' },
				leaf: activeLeaf,
			});
			const app = makeApp();
			const ws = app.workspace as unknown as {
				getActiveViewOfType: () => unknown;
				iterateAllLeaves: (cb: (l: unknown) => void) => void;
				setActiveLeaf: (l: unknown, opts?: unknown) => void;
			};
			ws.getActiveViewOfType = () => view;
			ws.iterateAllLeaves = (cb) => { cb(activeLeaf); cb(targetLeaf); };

			const nav = makeNav(app);
			const state = (nav.stack as unknown as { state: PositionState }).state;
			let armedDuringOpen: boolean | undefined;
			targetLeaf.openFile.mockImplementation(() => {
				armedDuringOpen = state.pendingHistoryNav;
				return Promise.resolve();
			});
			nav.funnel.recordOpen('a.md', 'leaf-2');
			nav.funnel.recordOpen('c.md', 'leaf-1');
			await nav.stack.navigate(-1);

			expect(armedDuringOpen).toBe(true);
			vi.advanceTimersByTime(1000);
			expect(state.pendingHistoryNav).toBe(false); // timeout cleared: no leak onto later opens
			// 遍历的恢复期间落点 cue 被抑制
			expect(state.cueSuppressUntil).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('跨标签页后退触发的，是目标步自己的落点，不是文件记录', async () => {
		vi.useFakeTimers();
		try {
			const { app } = makeCrossTabHarness();
			const nav = makeNav(app);
			const state = (nav.stack as unknown as { state: PositionState }).state;
			nav.funnel.recordOpen('a.md', 'leaf-2');
			(nav.stack.entries[0] as NavVisit).st = {
				scroll: 42,
				cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } },
			};
			nav.funnel.recordOpen('c.md', 'leaf-1');

			await nav.stack.navigate(-1);

			// 条目**自己的**位置一路带到打开管线（文件记录只是兜底），所以
			// 浏览器那一行显示的行，就是这次打开被告知要落在的那一行。
			expect(state.pendingHistoryNav).toBe(true);
			expect(state.pendingHistoryNavState).toMatchObject({ scroll: 42 });

			// ……而安全超时把落点和标记一起丢掉：一个从没走到
			// setViewState 的命令，不许把它漏到之后某次无关的打开上。
			vi.advanceTimersByTime(1000);
			expect(state.pendingHistoryNav).toBe(false);
			expect(state.pendingHistoryNavState).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('跨文件的落点经由它的标题做结构性重锚', async () => {
		// 条目记下之后，标题从 40 挪到了 100（+60）。注入的这次打开没有目标编
		// 辑器可跑文本片段重映射，所以结构性位移是它能得到的唯一编辑校正 ——
		// 而且必须在落点移交之前应用。
		const app = makeApp([{ heading: 'T', level: 2, position: { start: { line: 100 } } }]);
		makeCrossTabHarness(app);
		const nav = makeNav(app);
		const state = (nav.stack as unknown as { state: PositionState }).state;
		nav.funnel.recordOpen('a.md', 'leaf-2', { key: 'outline:## T' });
		const jump = nav.stack.entries[0] as NavJump;
		jump.keyLine = 40;
		jump.st = { scroll: 45, anchor: 'T' };
		nav.funnel.recordOpen('c.md', 'leaf-1');

		await nav.stack.navigate(-1);

		expect(state.pendingHistoryNavState).toMatchObject({ scroll: 105 });
	});

	it('跨标签页后退到仍显示该文件的标签页时，应用这一步的落点', async () => {
		// 用户切走时那个标签页被留在 L7，但条目（以及浏览器那一行）承诺的是
		// L42 —— 所以遍历会重新摆放那个活着的标签页，而不是只在它碰巧所在的
		// 位置激活它。
		const applied: unknown[] = [];
		const targetLeaf: { id: string; isDeferred: boolean; view?: unknown } = { id: 'leaf-2', isDeferred: false };
		targetLeaf.view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'a.md' },
			leaf: targetLeaf,
			containerEl: document.createElement('div'),
			getMode: () => 'source',
			currentMode: { getScroll: () => 7.2 },
			editor: { getCursor: () => ({ line: 7, ch: 0 }), lineCount: () => 200 },
			setEphemeralState: (st: unknown) => { applied.push(st); },
		});
		const { app } = makeCrossTabHarness(makeApp(), targetLeaf.view);
		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-2');
		(nav.stack.entries[0] as NavVisit).st = {
			scroll: 42,
			cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } },
		};
		nav.funnel.recordOpen('c.md', 'leaf-1');

		await nav.stack.navigate(-1);

		expect(applied[0]).toMatchObject({ scroll: 42 });
	});

	it('同标签页的文件切换，在下一步对得上时交给原生历史', async () => {
		const leaf = {
			id: 'leaf-1',
			isDeferred: false,
			containerEl: document.createElement('div'),
			view: { file: { path: 'b.md' } },
			history: {
				backHistory: [{ state: { state: { file: 'a.md' } } }],
				forwardHistory: [],
			},
			openFile: vi.fn().mockResolvedValue(undefined),
		};
		const view = Object.assign(Object.create(FileView.prototype), {
			file: { path: 'b.md' },
			leaf,
		});
		const app = makeApp();
		const ws = app.workspace as unknown as {
			getActiveViewOfType: () => unknown;
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		};
		ws.getActiveViewOfType = () => view;
		ws.iterateAllLeaves = (cb) => cb(leaf);
		app.commands.executeCommandById.mockImplementation(() => {
			(leaf.view as { file: { path: string } }).file = { path: 'a.md' };
		});

		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		await nav.stack.navigate(-1);

		expect(app.commands.executeCommandById).toHaveBeenCalledWith('app:go-back');
		expect(leaf.openFile).not.toHaveBeenCalled();
	});

	it('原生历史与原生目标对不上时退回 openFile', async () => {
		const leaf = {
			id: 'leaf-1',
			isDeferred: false,
			containerEl: document.createElement('div'),
			view: { file: { path: 'b.md' } },
			history: {
				backHistory: [{ state: { state: { file: 'x.md' } } }], // native disagrees
				forwardHistory: [],
			},
			openFile: vi.fn().mockResolvedValue(undefined),
		};
		const view = Object.assign(Object.create(FileView.prototype), {
			file: { path: 'b.md' },
			leaf,
		});
		const app = makeApp();
		const ws = app.workspace as unknown as {
			getActiveViewOfType: () => unknown;
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		};
		ws.getActiveViewOfType = () => view;
		ws.iterateAllLeaves = (cb) => cb(leaf);

		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		await nav.stack.navigate(-1);

		expect(app.commands.executeCommandById).not.toHaveBeenCalled();
		expect(leaf.openFile).toHaveBeenCalledTimes(1);
		expect(leaf.openFile.mock.calls[0][0]).toMatchObject({ path: 'a.md' });
	});
});

// ===== 侧边栏拿着焦点时的 NavStack.navigate =====

// 一个侧边栏（文件浏览器、搜索、大纲……）拿着焦点：在遍历的 setActiveLeaf
// 重新激活一个文件标签页之前，getActiveViewOfType 一直是 null —— 这个 mock
// 切换「活跃视图」的方式和真实工作区一模一样。
type HarnessLeaf = { id: string; isDeferred: boolean; containerEl: string; openFile: ReturnType<typeof vi.fn>; setViewState: ReturnType<typeof vi.fn>; detach?: ReturnType<typeof vi.fn>; view?: unknown };

function makeSidebarHarness(opts: {
	leaves: { id: string; file?: string; markdown?: boolean; viewType?: string; state?: Record<string, unknown> }[];
	mostRecentLeafId?: string;
}) {
	const app = makeApp();
	const ws = app.workspace as unknown as {
		getActiveViewOfType: () => unknown;
		iterateAllLeaves: (cb: (l: unknown) => void) => void;
		setActiveLeaf: (l: unknown, opts?: unknown) => void;
		getMostRecentLeaf: () => unknown;
		getLeaf: (target?: unknown) => unknown;
		getLeavesOfType: (viewType: string) => unknown[];
	};
	const openFile = vi.fn().mockResolvedValue(undefined);
	// 一个被**告知**去显示某个视图的 leaf 就显示它：app 会把它要的视图造出来，
	// 打开管线之后再确认它到位了（见 stack.ts 的 showViewInNewTab）。一个已经
	// 显示着东西的 leaf 则保留原样 —— 那些是 SWAP 的情形，它们断言的是调用，
	// 不是 leaf 的内容。
	const setViewState = vi.fn(function (this: HarnessLeaf, vs: { type: string }) {
		if (!this.view)
			this.view = { getViewType: () => vs.type };
		return Promise.resolve();
	});
	const detach = vi.fn();
	const applied: unknown[] = [];
	const viewsByLeaf: Record<string, unknown> = {};
	const leaves: HarnessLeaf[] = opts.leaves.map((spec) => {
		// 主区的文件标签页：isMainAreaLeaf 问工作区根节点是否持有这个 leaf 的元
		// 素，而 makeApp 的根节点持有 'main'（见 isMainAreaLeaf）—— 一个没有它的
		// leaf 会被读成侧边栏，被激活刷新跳过。
		const leaf: HarnessLeaf = { id: spec.id, isDeferred: false, containerEl: 'main', openFile, setViewState };
		if (spec.markdown) {
			leaf.view = Object.assign(Object.create(MarkdownView.prototype), {
				file: { path: spec.file },
				leaf,
				containerEl: document.createElement('div'),
				getViewType: () => 'markdown',
				getMode: () => 'source',
				currentMode: { getScroll: () => 42.3 },
				editor: {
					getCursor: () => ({ line: 3, ch: 7 }),
					lineCount: () => 200,
				},
				setEphemeralState: (st: unknown) => { applied.push(st); },
			});
		} else if (spec.viewType) {
			// 一个非文件的视图标签页。它报告自己的类型和自己的 state，那正是激活
			// 刷新在离开时重读的东西（见 stack.ts 的
			// refreshTopLeafOnActivation）。
			leaf.view = {
				getViewType: () => spec.viewType,
				getDisplayText: () => undefined,
				getState: () => spec.state,
			};
		} else if (spec.file) {
			leaf.view = Object.assign(Object.create(FileView.prototype), { file: { path: spec.file }, leaf, getViewType: () => 'pdf' });
		}
		viewsByLeaf[spec.id] = leaf.view;
		return leaf;
	});
	let activeView: unknown = null;
	ws.getActiveViewOfType = () => activeView;
	ws.iterateAllLeaves = (cb) => leaves.forEach((l) => cb(l as unknown as WorkspaceLeaf));
	ws.setActiveLeaf = vi.fn((target: unknown) => {
		activeView = viewsByLeaf[(target as { id: string }).id] ?? null;
	});
	ws.getMostRecentLeaf = () => leaves.find((l) => l.id === opts.mostRecentLeafId) ?? null;
	// 打开管线的视图那一支向工作区要的东西：每一个**正显示着**这个视图类型的
	// leaf，按它现在的样子读（一个被告知去显示某个视图的 leaf，从那一刻起就有
	// 了它 —— 见上面的 setViewState）。
	ws.getLeavesOfType = (viewType: string) => leaves.filter(
		(l) => (l.view as { getViewType?: () => string } | undefined)?.getViewType?.() === viewType,
	);
	// 一个全新的 leaf，正如 workspace.getLeaf 为读者在别处要的目标（一个标签
	// 页、一次分屏、一个窗口）交出那种 —— 或者为一个自己的标签页已经没了的视
	// 图。同一个对象，所以测试能问这次打开是不是落**在这里**（`openFile` 那个
	// 桩是共用的，它的 `this` 就是答案）。
	const newLeaf: HarnessLeaf = { id: 'leaf-new', isDeferred: false, containerEl: 'main', openFile, setViewState, detach };
	ws.getLeaf = vi.fn(() => newLeaf);
	return { ws, nav: makeNav(app), openFile, setViewState, detach, applied, leaves, newLeaf };
}

describe('NavStack.navigate —— 侧边栏拿着焦点时', () => {
	it('同文件的后退重新激活标签页，并应用这一步的位置', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'teleport:60' });
		(nav.stack.entries[0] as NavVisit).st = { scroll: 5, cursor: { from: { line: 60, ch: 0 }, to: { line: 60, ch: 0 } } };
		expect(nav.stack.index).toBe(1);

		await nav.stack.navigate(-1);

		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.leaves[0], { focus: true });
		expect(nav.stack.index).toBe(0);
		expect(h.applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('起点那个 leaf 已经关了，退回最近活跃的 leaf', async () => {
		const h = makeSidebarHarness({
			leaves: [{ id: 'leaf-2', file: 'd.md' }],
			mostRecentLeafId: 'leaf-2',
		});
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1'); // leaf-1 has since been closed
		nav.funnel.recordOpen('b.md', 'leaf-1');
		await nav.stack.navigate(-1);

		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.leaves[0], { focus: true });
		expect(h.openFile).toHaveBeenCalledTimes(1);
		expect(h.openFile.mock.calls[0][0]).toMatchObject({ path: 'a.md' });
	});

	it('canNavigate 跟着 navigate 用同一套兜底', () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md' }] });
		const nav = h.nav;
		expect(nav.stack.canNavigate(-1)).toBe(false); // empty stack
		nav.funnel.recordOpen('a.md', 'leaf-1');
		expect(nav.stack.canNavigate(-1)).toBe(false); // bottom of the stack
		nav.funnel.recordOpen('b.md', 'leaf-1');
		expect(nav.stack.canNavigate(-1)).toBe(true); // sidebar focused, tab resolvable
		expect(nav.stack.canNavigate(1)).toBe(false);

		h.ws.setActiveLeaf(h.leaves[0]); // user focuses the file tab again
		expect(nav.stack.canNavigate(-1)).toBe(true);
	});

	it('侧边栏拿着焦点又什么都解不出来时，canNavigate 为 false', () => {
		const h = makeSidebarHarness({ leaves: [] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		expect(nav.stack.canNavigate(-1)).toBe(false);
	});
});

// ===== NavStack：视图标签页的步 =====

function graphLeaf(id: string, containerEl: unknown = 'main'): WorkspaceLeaf {
	return viewLeaf(id, 'graph', { containerEl });
}

describe('NavStack —— 步的采集戳', () => {
	it('每一步压栈时都盖上压栈那一刻的时间', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2025-09-12T10:00:00Z'));
			const nav = makeNav();
			nav.funnel.recordOpen('a.md', 'leaf-1');
			expect(nav.stack.entries[0].t).toBe(Date.parse('2025-09-12T10:00:00Z'));
			vi.setSystemTime(new Date('2025-09-12T10:05:00Z'));
			nav.funnel.recordOpen('b.md', 'leaf-1');
			expect(nav.stack.entries[1].t).toBe(Date.parse('2025-09-12T10:05:00Z'));
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('NavStack —— 视图标签页的步', () => {
	it('关系图谱的激活记下一个无路径视图步并去重；侧边栏不记', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		nav.funnel.recordActivation(graphLeaf('leaf-g')); // re-click same tab: dedup
		expect(nav.stack.entries).toEqual([{ kind: 'view', leafId: 'leaf-g', viewType: 'graph', t: expect.any(Number) }]);

		nav.funnel.recordActivation(graphLeaf('leaf-s', 'sidebar')); // sidebar local graph: not a step
		expect(nav.stack.entries.length).toBe(1);
	});

	it('任何视图标签页都是一步，不只是关系图谱 —— 连同它自称的名字', () => {
		// 栈不是列表（见 nav-history/stack.ts）：它的步只被遍历、从不被画出来，
		// 所以它留着 label 只因它整条持久化条目 —— 而任何类型的视图标签页都是
		// 本插件移动到过的一个地点。
		const nav = makeNav();
		nav.funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', { label: 'Thino' }));
		nav.funnel.recordActivation(viewLeaf('leaf-t2', 'empty')); // the empty tab: nothing to return to

		expect(nav.stack.entries).toEqual([
			{ kind: 'view', leafId: 'leaf-t', viewType: 'thino_view', label: 'Thino', t: expect.any(Number) },
		]);
	});

	it('从关系图谱标签页后退，重新激活上一个文件标签页，不重新打开', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		h.leaves.push(graphLeaf('leaf-g') as never);
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		expect(nav.stack.index).toBe(1);

		await nav.stack.navigate(-1); // graph active (no FileView): current entry is the graph step

		expect(nav.stack.index).toBe(0);
		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.leaves[0], { focus: true });
		expect(h.openFile).not.toHaveBeenCalled(); // a.md already in that tab
	});

	it('从文件标签页前进，重新激活关系图谱标签页，不打开', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		const gLeaf = graphLeaf('leaf-g');
		h.leaves.push(gLeaf as never);
		nav.funnel.recordActivation(gLeaf);
		(nav.stack as unknown as { index: number }).index = 0; // simulate having gone back

		await nav.stack.navigate(1);

		expect(nav.stack.index).toBe(1);
		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(gLeaf, { focus: true });
		expect(h.setViewState).not.toHaveBeenCalled(); // the graph is already showing
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('state 没动过的视图步，只是把它激活', async () => {
		const live = { file: 'x.md' };
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-a', file: 'a.md', markdown: true },
				{ id: 'leaf-g', viewType: 'graph', state: live },
			],
		});
		const nav = h.nav;
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf); // the graph, on x.md
		nav.funnel.recordOpen('a.md', 'leaf-a'); // …then a note
		h.ws.setActiveLeaf(h.leaves[0]); // the reader is in the note

		await nav.stack.navigate(-1);

		expect(nav.stack.index).toBe(0);
		expect(h.setViewState).not.toHaveBeenCalled();
	});

	it('state 动过的视图步，把那个 state 放回正显示它的 leaf 上', async () => {
		// 这条存在的理由：局部图谱跟着活跃文件走，所以读者不在时它的标签页会一
		// 直画着另一个邻域 —— 激活它得到的是视图的默认行为，而不是这一步点名的
		// 那处地点。
		const live = { file: 'x.md' };
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-a', file: 'a.md', markdown: true },
				{ id: 'leaf-g', viewType: 'graph', state: live },
			],
		});
		const nav = h.nav;
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf);
		expect((nav.stack.entries[0] as NavView).state).toEqual({ file: 'x.md' }); // a snapshot, not a reference
		nav.funnel.recordOpen('a.md', 'leaf-a');
		h.ws.setActiveLeaf(h.leaves[0]);

		live.file = 'y.md'; // the view moved on while the reader was elsewhere

		await nav.stack.navigate(-1);

		expect(nav.stack.index).toBe(0);
		expect(h.setViewState).toHaveBeenCalledWith({ type: 'graph', state: { file: 'x.md' }, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('视图步从地点上读它的 state，即使它自己那个标签页已经重建过', () => {
		// 视图条目的 leafId 从不被写回（见 execute），所以一旦这个地点在一个
		// **新**标签页里回来，这一步点名的就是一个已消失的标签页。快照仍得跟上
		// 那个地点，否则遍历会一直重放重建之前的状态。
		const before = { file: 'x.md' };
		const after = { file: 'y.md' };
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-a', file: 'a.md', markdown: true },
				{ id: 'leaf-g', viewType: 'graph', state: before },
			],
		});
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-a');
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf);
		expect((nav.stack.entries[1] as NavView).state).toEqual({ file: 'x.md' });

		h.leaves.splice(1, 1); // the graph's tab is closed…
		h.leaves.push(viewLeaf('leaf-g2', 'graph', { state: after }) as never); // …and the place rebuilt

		// 离开图谱（激活那篇笔记）时，就是读这一步 state 的时机。
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect((nav.stack.entries[1] as NavView).state).toEqual({ file: 'y.md' });
	});

	it('离开一个视图会重读它的名字，不只是它的 state', () => {
		// 内置浏览器就是那个情形：它的标签页标题是网页标题（Obsidian 的
		// WebviewerView 用 this.title 应答 getDisplayText），所以读者坐在里面
		// 时视图给出的名字会变。代表那个地点的步和行，最终得叫它们最后一次读到
		// 的名字。
		const spec = { label: 'Page one', icon: 'globe-2', state: { url: 'https://one.example/' } };
		const viewer = viewLeaf('leaf-w', 'webviewer', spec);
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-a', file: 'a.md', markdown: true }] });
		h.leaves.push(viewer as never);
		const nav = h.nav;

		nav.funnel.recordActivation(viewer);
		expect(nav.stack.entries[0]).toMatchObject({ label: 'Page one' });
		expect(nav.places.entries.find(p => p.kind === 'view')).toMatchObject({ label: 'Page one' });

		// 读者继续浏览，然后切到一篇笔记：离开是它们俩最后能被问到的时刻。
		spec.label = 'Page two';
		spec.state = { url: 'https://two.example/' };
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect(nav.stack.entries[0]).toMatchObject({
			kind: 'view', label: 'Page two', state: { url: 'https://two.example/' },
		});
		expect(nav.places.entries.find(p => p.kind === 'view')).toMatchObject({ label: 'Page two' });
	});

	it('同一 leaf 里文件把关系图谱挤掉之后，前进会把图谱重新立起来', async () => {
		// graph:open 的标签页复用 / 一次图谱节点点击：文件打开把图谱从它自己的
		// leaf 里挤掉了，所以图谱条目与文件共用那个 leaf id。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen(undefined, 'leaf-1', { viewType: 'graph' });
		(nav.stack as unknown as { index: number }).index = 0; // simulate having gone back

		await nav.stack.navigate(1);

		expect(nav.stack.index).toBe(1);
		expect(h.setViewState).toHaveBeenCalledWith({ type: 'graph', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('同 leaf 的图谱还原在下一步对得上时，搭原生历史的车', async () => {
		const app = makeApp();
		const leaf = {
			id: 'leaf-1',
			isDeferred: false,
			containerEl: document.createElement('div'),
			view: Object.assign(Object.create(MarkdownView.prototype), {
				file: { path: 'a.md' },
				getViewType: () => 'markdown',
				leaf: null as unknown,
			}),
			setViewState: vi.fn().mockResolvedValue(undefined),
			openFile: vi.fn().mockResolvedValue(undefined),
			history: {
				backHistory: [{ state: { type: 'graph', state: {} } }],
				forwardHistory: [],
			},
		};
		(leaf.view as { leaf: unknown }).leaf = leaf;
		const view = Object.assign(Object.create(FileView.prototype), { file: { path: 'a.md' }, leaf });
		const ws = app.workspace as unknown as {
			getActiveViewOfType: () => unknown;
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
			setActiveLeaf: (l: unknown, opts?: unknown) => void;
		};
		ws.getActiveViewOfType = () => view;
		ws.iterateAllLeaves = (cb) => cb(leaf as unknown as WorkspaceLeaf);
		app.commands.executeCommandById.mockImplementation(() => {
			(leaf.view as unknown as { getViewType: () => string }).getViewType = () => 'graph';
		});

		const nav = makeNav(app);
		// 文件 → 图谱（同一个 leaf，被换掉）→ 节点点击又打开了文件
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen(undefined, 'leaf-1', { viewType: 'graph' });
		nav.funnel.recordOpen('a.md', 'leaf-1');

		await nav.stack.navigate(-1); // back to the graph step

		expect(app.commands.executeCommandById).toHaveBeenCalledWith('app:go-back');
		expect(leaf.setViewState).not.toHaveBeenCalled();
		expect(leaf.openFile).not.toHaveBeenCalled();
	});

	it('leaf 已经没了的视图建在新标签页里，绝不盖在正读着的文件上', async () => {
		// 读者自己的情形：他们去了 Thino，关掉了所有标签页，打开了别的笔记，
		// 然后点了当初的那个条目。这个地点比记录它的标签页活得久，所以视图是被
		// **构造**出来的 —— 而且绝不在读者正读着的那个标签页里，这是无路径条目
		// 最不能被误读成的那一件事（`state: {}` 时，正是 Obsidian 自己的
		// `graph:open` 所要的东西）。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		nav.funnel.recordOpen(undefined, 'leaf-gone', { viewType: 'graph' }); // leaf since closed
		(nav.stack as unknown as { index: number }).index = 1; // simulate having gone back once

		await nav.stack.navigate(1);

		expect(nav.stack.index).toBe(2);
		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		expect(h.setViewState).toHaveBeenCalledWith({ type: 'graph', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
		expect(h.detach).not.toHaveBeenCalled(); // the view arrived, so the tab stays
	});

	it('标签页没了的视图行会把视图再打开一次 —— 读者的真实场景', async () => {
		// 同一个问题，从最近文件列表而不是一次遍历提出：这一行是读者还在 Thino
		// 时写下的，Thino 的标签页早已不在，而这一行仍得把他们带到那儿（见
		// places.ts 的 travel）。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordActivation(viewLeaf('leaf-t1', 'thino_view', { label: 'Thino' }));
		const at = nav.places.entries.findIndex(e => e.kind === 'view');

		await nav.places.travel(at);

		expect(h.setViewState).toHaveBeenCalledWith({ type: 'thino_view', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('已经有别的标签页在显示这个视图时，由它来应答这个地点', async () => {
		// 两个 Thino 标签页是**一个**地点（见 places.ts 的 placeKey），而条目点
		// 名的是最后被激活的那个。关掉它，这个地点仍立在读者手里还剩的那个标签页
		// 里，所以什么都不用建：条目是「Thino」这个名字，不是某个特定标签页的把
		// 手。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const other = viewLeaf('leaf-t2', 'thino_view');
		h.leaves.push(other as never);
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordActivation(viewLeaf('leaf-t1', 'thino_view')); // recorded there, tab since closed
		(nav.stack as unknown as { index: number }).index = 0; // simulate having gone back

		await nav.stack.navigate(1);

		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(other, { focus: true });
		expect(h.ws.getLeaf).not.toHaveBeenCalled(); // nothing had to be built
		expect(h.setViewState).not.toHaveBeenCalled();
	});

	it('侧边栏面板不算这个地点：改为建一个主区标签页', async () => {
		// 一个显示着同一个视图的面板不是读者去过的地方 —— 出于同样的理由它也不
		// 被记（见 isMainAreaLeaf）。所以它也不代表那个地点：条目指的是它自己的
		// 一个标签页。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		h.leaves.push(viewLeaf('leaf-side', 'thino_view', { containerEl: 'sidebar' }) as never);
		const nav = h.nav;
		nav.funnel.recordActivation(viewLeaf('leaf-t1', 'thino_view')); // since closed
		const at = nav.places.entries.findIndex(e => e.kind === 'view');

		await nav.places.travel(at);

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
	});

	it('视图标签页按这个视图当初的 state 重建，而不是用它的默认值', async () => {
		// 读者自己的情形，比标签页消失再进一步：他们在设了过滤器的 Thino 里，
		// 关掉所有标签页，几天后回来。这个地点按**类型**重建，而他们在时记下的
		// state 就是重建所用之物 —— 这就是「视图」与「他们去过的那个地点」之间
		// 的全部差别（见 nav/entry 的 NavView.state）。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordActivation(viewLeaf('leaf-t1', 'thino_view', { state: { filter: 'today' } }));
		const at = nav.places.entries.findIndex(e => e.kind === 'view');

		await nav.places.travel(at);

		expect(h.setViewState).toHaveBeenCalledWith({
			type: 'thino_view', state: { filter: 'today' }, active: true,
		});
	});

	it('离开一个视图会重读它的 state，两份列表都听得到', async () => {
		// 一个地点重建所用的 state，必须是读者**离开**它时的那个 state，而离开的
		// 那一刻是它还能被读到的最后时刻（见 stack.ts 的
		// refreshTopLeafOnActivation）。两个列表听到的是同一次刷新 —— 栈通过
		// onLanded，地点列表通过 settle —— 所以一个视图**步**和一个视图**地点**
		// 不会对读者在哪儿产生分歧。
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-1', file: 'a.md', markdown: true },
				{ id: 'leaf-t', viewType: 'thino_view', state: { filter: 'today' } },
			],
		});
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf);
		expect(nav.stack.entries[nav.stack.entries.length - 1])
			.toMatchObject({ kind: 'view', viewType: 'thino_view', state: { filter: 'today' } });

		// 读者在这个视图里干活：过滤器往前变了。然后他们切走。
		(h.leaves[1].view as { getState: () => unknown }).getState = () => ({ filter: 'week' });
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect(nav.stack.entries.find(e => e.kind === 'view')).toMatchObject({ state: { filter: 'week' } });
		expect(nav.places.entries.find(e => e.kind === 'view')).toMatchObject({ state: { filter: 'week' } });
	});

	it('标签页已经不再显示这个视图时，不去重读它的 state', async () => {
		// 一次图谱节点点击会在同一个标签页里把文件打开**盖在**图谱之上，所以条
		// 目的 leaf 可能还活着却在显示别的东西：那时从它读到的是**笔记**的 state，
		// 把它写到视图地点上就是拿一个真快照换一个错快照（见
		// refreshTopLeafOnActivation 里那道守卫）。
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-1', file: 'a.md', markdown: true },
				{ id: 'leaf-t', viewType: 'thino_view', state: { filter: 'today' } },
			],
		});
		const nav = h.nav;
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf);
		// 与此同时那个标签页被换成了笔记。
		(h.leaves[1].view as { getViewType: () => string }).getViewType = () => 'markdown';
		(h.leaves[1].view as { getState: () => unknown }).getState = () => ({ elsewhere: true });
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect(nav.stack.entries.find(e => e.kind === 'view')).toMatchObject({ state: { filter: 'today' } });
	});

	it('延迟 leaf 的 state 不去重读', async () => {
		// 一个被卸载的后台标签页什么都问不出来：DeferredView 背后的视图不在那
		// 儿，所以从它读到的「空」答案不许抹掉快照（见
		// refreshTopLeafOnActivation）。
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-1', file: 'a.md', markdown: true },
				{ id: 'leaf-t', viewType: 'thino_view', state: { filter: 'today' } },
			],
		});
		const nav = h.nav;
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf);
		h.leaves[1].isDeferred = true;
		(h.leaves[1].view as { getState: () => unknown }).getState = () => ({ filter: 'week' });
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect(nav.stack.entries.find(e => e.kind === 'view')).toMatchObject({ state: { filter: 'today' } });
	});

	it('已经没有东西造得出来的视图，不留半个开着的标签页', async () => {
		// 视图背后的插件被禁用或没了：要了这个类型却从不到来（app 用空页应答）。
		// 这个标签页又被关上，而不是留立在一个本仓库已不再有的地点上 —— 在那里
		// 点击什么都不做才是最诚实的结果，也是它一向的做法。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		h.newLeaf.view = { getViewType: () => 'empty' };
		const nav = h.nav;
		nav.funnel.recordActivation(viewLeaf('leaf-t1', 'thino_view')); // since closed
		const at = nav.places.entries.findIndex(e => e.kind === 'view');

		await nav.places.travel(at);

		expect(h.setViewState).toHaveBeenCalledWith({ type: 'thino_view', state: {}, active: true });
		expect(h.detach).toHaveBeenCalled();
	});

	it('落盘的关系图谱步能过读取过滤', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		nav.stack.persist();

		const restored = makeNav();
		expect(restored.stack.entries).toEqual(nav.stack.entries);
		expect(restored.stack.index).toBe(1);
	});
});

// 一次读者要求**在别处**进行的前往 —— 按住修饰键的点击、中键、键盘的
// Cmd/Ctrl+Enter（见 PaneTarget / list.ts）。它和打开管线的其他每一支都是不同
// 的问题：那些的存在是为了**回到**一个地点，而在这里，地点自己的标签页不许动。
describe('NavStack —— 要去别处的一次前往', () => {
	// setViewState 补丁消费的那个武装标记：遍历注入的落点，盖在原生条目那个只
	// 带光标的状态之上（见 armHistoryNav）。
	const armed = (nav: ReturnType<typeof makeNav>) =>
		(nav.stack as unknown as {
			state: { pendingHistoryNav: boolean; pendingHistoryNavState?: unknown; pendingHistoryNavPath?: string };
		}).state;

	it('在 app 挑中的 leaf 里打开一个跳转地点，触发同一个落点', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const place: NavEntry = {
			kind: 'jump', path: 'b.md', leafId: 'leaf-1', key: 'outline:## T', t: 1,
			st: { scroll: 30 },
		};

		await h.nav.stack.travelTo(place, 'tab');

		// 由 app 自己的应答决定 leaf（见 Keymap.isModEvent）：插件只是把它转
		// 交。
		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		// ……而这次打开落在**那个** leaf 里，不是条目来的那个标签页里。
		expect(h.openFile.mock.contexts[0]).toBe(h.newLeaf);
		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.newLeaf, { focus: true });
		// 落点不在差别之列：这就是一次朴素前往所武装的同一个注入，所以同一篇笔
		// 记在隔壁标签页打开时会落在同一处 —— 那处地点给这一行带来的滚动和光标
		// （见 landingOf）。
		expect(armed(h.nav).pendingHistoryNav).toBe(true);
		expect(armed(h.nav).pendingHistoryNavState).toEqual({
			scroll: 30, cursor: { from: { line: 30, ch: 0 }, to: { line: 30, ch: 0 } },
		});
		expect(armed(h.nav).pendingHistoryNavPath).toBe('b.md');
	});

	it('在新 leaf 里打开一个文件地点，什么也不注入', async () => {
		// 一个文件地点不带自己的位置（见 places.ts）：由位置数据库决定它落在哪
		// 儿，在新标签页里和旧标签页里一模一样。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });

		await h.nav.stack.openFilePlain('b.md', 'leaf-1', 'tab');

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		expect(h.openFile.mock.contexts[0]).toBe(h.newLeaf);
		expect(armed(h.nav).pendingHistoryNav).toBe(false);
	});

	it('在新 leaf 里显示一个无路径视图，而不是打开文件', async () => {
		// 图谱没有文件可打开：得告诉 leaf 去显示它，而 `active` 才是把它带到前
		// 台的东西。
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });

		await h.nav.stack.openViewPlace({ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 1 }, 'tab');

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		expect(h.setViewState).toHaveBeenCalledWith({ type: 'graph', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});
});

// 一个地点带着它落点被记下时周围的那句话 —— 最近文件列表的引文，它的搜索框所
// 匹配的东西。一个步是按**位置**恢复的，所以它在唯一写下它的那个地方把它们留下
// （见 nav-history/store.ts）。
describe('NavStack —— 落盘时不留落点上的那句话', () => {
	it('把它前往的那一步连位置一起写下，那句话一个字不留', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const place: NavEntry = {
			kind: 'jump', path: 'b.md', leafId: 'leaf-1', key: 'outline:## T', t: 1,
			st: { scroll: 30, context: ['## T'] },
		};

		await h.nav.stack.travelTo(place, 'tab');
		h.nav.stack.persist();

		const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
		expect(stored.entries[stored.entries.length - 1].st).toEqual({ scroll: 30 });
		// 内存里的那个步就是它前往时所带的状态：那句话是在**写**下去时被丢掉的，
		// 不是在进来的路上 —— 只有一处，无论一个状态是怎么到达这个列表的。
		expect(stOf(h.nav.stack.entries[h.nav.stack.index])).toEqual(place.st);
	});
});

// ===== Patcher：historyNav 注入 =====

type ViewState = { type?: unknown; state?: { file?: unknown; mode?: unknown } };
type InjectFn = (
	leaf: WorkspaceLeaf,
	viewState: ViewState,
	eState: Record<string, unknown> | undefined,
) => unknown;

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};
const SOURCE_OPEN_A = (file = 'a.md'): ViewState => ({
	type: 'markdown',
	state: { file, mode: 'source' },
});

function makeLeaf(id: string): WorkspaceLeaf & { containerEl: HTMLElement } {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf & { containerEl: HTMLElement };
}

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

let disposables: Array<() => void> = [];

function makePatcherHarness(db: Record<string, unknown> = {}) {
	const state = new PositionState(DEFAULT_SETTINGS);
	const leaf = makeLeaf('leaf-1');
	const app = {
		workspace: {
			layoutReady: true,
			rootSplit: { containerEl: { contains: (el: unknown) => el === leaf.containerEl } },
		},
	} as never;
	const store = new PositionStore(app, { db } as never);
	// patcher 写入的那个漏斗。和采样器一样，patcher 纯粹是一个**采集**点 —— 它
	// 记录打开和离开读取，从不读栈 —— 所以用一个间谍漏斗替身代替它。
	const funnel = {
		recordOpen: vi.fn(),
		recordTeleport: vi.fn(),
		recordActivation: vi.fn(),
		leave: vi.fn(),
		settled: vi.fn(),
		landing: vi.fn(),
	};
	const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, store, state, funnel as never, { flushOnLeave: vi.fn() } as never);
	const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);
	disposables.push(() => state.cover.uncover(leaf));
	return { state, leaf, inject, funnel };
}

afterEach(() => {
	disposables.forEach((fn) => fn());
	disposables = [];
});

describe('OpenPatcher —— 导航接入', () => {	it('每一次改动文件的打开都记下一个跳转步', () => {
		const { leaf, inject, funnel } = makePatcherHarness({});
		inject(leaf, SOURCE_OPEN_A('a.md'), undefined);
		expect(funnel.recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', { key: undefined, force: false });
	});

	it('同文件的调用方目标（match）带 force 和独有的 caller key 记录', () => {
		const { state, leaf, inject, funnel } = makePatcherHarness({});
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		inject(leaf, SOURCE_OPEN_A(), { match: {} });
		expect(funnel.recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', {
			key: expect.stringMatching(/^caller:/),
			force: true,
		});
	});

	it('历史遍历把存下的位置盖在原生 eState 之上注入', () => {
		const { state, leaf, inject } = makePatcherHarness({ 'a.md': RECORD });
		state.pendingHistoryNav = true;
		const eState = { cursor: { from: { line: 2, ch: 0 }, to: { line: 2, ch: 0 } } };

		const result = inject(leaf, SOURCE_OPEN_A(), eState) as Record<string, unknown>;

		// 我们的记录赢过原生光标，而原生光标那个槽位没了
		expect(result).toMatchObject({ scroll: 10, cursor: RECORD.cursor });
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.cover.isCovered(leaf)).toBe(true);
		// ……而落点被交给恢复器，好让它注入的落定核验的是交给 core 的同一行。
		expect(state.injectedLeafStates.get('leaf-1')).toMatchObject({ scroll: 10 });
	});

	it('带着目标步落点的遍历，把它盖在文件记录之上注入', () => {
		// 一次跨文件的历史 jump：条目自己的落点（行所显示的那个）必须赢过文件记
		// 录 —— 后者在继续阅读之后握着用户漂到的那处地点。
		const { state, leaf, inject } = makePatcherHarness({ 'a.md': RECORD });
		state.pendingHistoryNav = true;
		state.pendingHistoryNavPath = 'a.md';
		state.pendingHistoryNavState = {
			scroll: 99,
			cursor: { from: { line: 99, ch: 0 }, to: { line: 99, ch: 0 } },
		};

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 99 });
		expect(state.injectedLeafStates.get('leaf-1')).toMatchObject({ scroll: 99 });
		// 落点随标记一起被消费 —— 一发即止，不漏
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.pendingHistoryNavState).toBeUndefined();
	});

	it('为另一个文件触发的落点，绝不落在抢走标记的那次打开上', () => {
		// 这个标记是全局的：武装窗口内一次无关的打开会拿走它。落点是按文件的，
		// 所以必须把它丢掉，让实际正在打开的那个文件的记录立住。
		const { state, leaf, inject } = makePatcherHarness({ 'b.md': RECORD });
		state.pendingHistoryNav = true;
		state.pendingHistoryNavState = { scroll: 99 };
		state.pendingHistoryNavPath = 'a.md';

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: RECORD.scroll });
		expect(state.injectedLeafStates.get('leaf-1')).toMatchObject({ scroll: RECORD.scroll });
		expect(state.pendingHistoryNavState).toBeUndefined();
		expect(state.pendingHistoryNavPath).toBeUndefined();
	});

	it('没有存盘记录的遍历保留原生目标，并消费掉标记', () => {
		const { state, leaf, inject } = makePatcherHarness({});
		state.pendingHistoryNav = true;
		const eState = { cursor: { from: { line: 2, ch: 0 }, to: { line: 2, ch: 0 } } };

		expect(inject(leaf, SOURCE_OPEN_A(), eState)).toBe(eState);
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
	});

	it('重放中的遍历只消费标记，不注入', () => {
		const { state, leaf, inject } = makePatcherHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		state.pendingHistoryNav = true;
		const eState = { scroll: 10, cursor: RECORD.cursor };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);
		expect(result).toBe(eState);
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
	});

	it('非 markdown 视图的遍历保持原生（标记照样消费）', () => {
		const { state, leaf, inject } = makePatcherHarness({ 'a.pdf': { scroll: 3 } });
		state.pendingHistoryNav = true;
		const eState = { scroll: 3 };

		const result = inject(leaf, { type: 'pdf', state: { file: 'a.pdf' } }, eState);
		expect(result).toBe(eState);
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
	});
});

describe('serializeNavHistory —— 一步在身后留下什么', () => {
	it('落点上的那句话留在身后；位置本身不带采集戳', () => {
		const entries: NavEntry[] = [{
			kind: 'jump', leafId: 'leaf-1', t: 1000, path: 'a.md', key: 'outline:H',
			st: { scroll: 42, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } }, context: ['w'] },
		}];

		const parsed = JSON.parse(serializeNavHistory(entries, 0)) as {
			entries: { st: Record<string, unknown> }[];
		};

		// 步**自己的** t（它被压栈的时间）留着 —— 行印出的「5 分钟前」就取自它。
		// 位置不需要自己的采集戳：store 在归档一条记录时给它盖上，而这段历史从
		// 不经过那里。
		expect(parsed.entries[0].st).toEqual({
			scroll: 42,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
		});
	});
});
