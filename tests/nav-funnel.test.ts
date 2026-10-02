// 「记录漏斗」（nav/funnel.ts）的测试 —— 那个中立的层：它握住一次导航**是什么**，
// 并把它发布给每一个保留它的人。
//
// 这个套件正是漏斗被抽出来所换来的东西：一个漏斗加一个探子 sink 就是全部 fixture，
// 背后既没有栈也没有工作区，因为采集点的职责是写下正确的**记录**，而漏斗的职责是把
// 它送到。一条记录值不值得**留下**，是读取方的事。
//  - 共享闸门：启动窗口（布局未就绪）与遍历 bracket（runBracketed，含看门狗）
//    什么都不发布；
//  - 每个采集点发布什么 —— recordOpen（不带 key 的 visit、带 key 的 jump、无路径的
//    视图）、recordTeleport、recordActivation（一次标签页切换 = 旧标签页的一次离开 +
//    新标签页的一次 visit —— 或者，对一个除空标签页以外任何类型的视图标签页，是它
//    自己的一个地点）；
//  - 两种位置读取：`leave`（读者当时在哪）与 `settled`（跳转落到哪）—— 都不受闸门
//    管，且分得很清，好让地点列表只取第二种；
//  - 那些广播：`visit` 故意绕开闸门，`landing`/`here` 送到每一个监听者，一个监听者
//    只实现它要的钩子，而退订会停止投递；
//  - 采样器的跳变采集，一个往这个漏斗写数据的采集点。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { FileView, MarkdownView, Platform } from 'obsidian';
import { NavFunnel, NavLeave, NavRecording } from '@/nav/funnel';
import { NavEntry, NewNavEntry } from '@/nav/entry';
import { Sampler } from '@/position/capture/sampler';
import { PositionState } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';
import { deferredLeaf, entry, followingLeaf, leafWithFile, makeApp, makeNav, pathOf, viewLeaf } from './support/nav-recording-harness';

beforeEach(() => {
	window.localStorage.clear();
});

// 一个带探子 sink 的漏斗。每个钩子都记下它听到了什么，好让测试能问出发布了什么，
// 而背后没有任何读取方站着。
function makeFunnel(app = makeApp()) {
	const state = new PositionState(DEFAULT_SETTINGS);
	const funnel = new NavFunnel(app, state);
	const visits: NavRecording[] = [];
	const leaves: NavLeave[] = [];
	const landings: NewNavEntry[] = [];
	const heres: (NavEntry | undefined)[] = [];
	funnel.subscribe({
		onVisit: (recording) => visits.push(recording),
		onLeave: (leave) => leaves.push(leave),
		onLanded: (entry) => landings.push(entry),
		onHere: (entry) => heres.push(entry),
	});
	return { funnel, state, visits, leaves, landings, heres };
}

describe('NavFunnel —— 公共闸门', () => {
	it('工作区还没起来之前不发布任何东西', () => {
		// 启动时的重建会经由普通打开所用的同一个打过补丁的 setViewState 打开每一个被恢复的
		// 标签页；其中没有一次是导航。
		const app = makeApp();
		const { funnel, visits } = makeFunnel(app);
		(app.workspace as { layoutReady: boolean }).layoutReady = false;

		funnel.recordOpen('a.md', 'leaf-1');
		funnel.recordTeleport('a.md', 'leaf-1', 300);
		funnel.recordActivation(leafWithFile('leaf-2', 'b.md'));

		expect(visits).toEqual([]);
	});

	it('插件自己在挪的那次移动什么都不发布，并在之后放开闸门', async () => {
		// 一次遍历自己的那些打开**就是**这次遍历，不是新的跳转；bracket 立着多久，它就替这
		// 件事说多久。
		const { funnel, visits } = makeFunnel();
		expect(funnel.isMoving()).toBe(false);

		await funnel.runBracketed(async () => {
			expect(funnel.isMoving()).toBe(true);
			funnel.recordOpen('a.md', 'leaf-1');
		});

		expect(visits).toEqual([]);
		expect(funnel.isMoving()).toBe(false);
		// ……而 bracket 一落下，记录就重新活了。
		funnel.recordOpen('a.md', 'leaf-1');
		expect(visits).toHaveLength(1);
	});

	it('已经有一个 bracket 开着时第二个会被拒绝；卡住的那个由看门狗放开', async () => {
		// 一次永不 resolve 的打开（loadIfDeferred 可能挂住）绝不能把闸门永远立着，否则前进
		// 后退在这一节的余下时间就全废了。
		vi.useFakeTimers();
		try {
			const { funnel, visits } = makeFunnel();
			void funnel.runBracketed(() => new Promise<void>(() => undefined)); // never settles
			expect(funnel.isMoving()).toBe(true);

			// 在 bracket 里按下的一条命令，绝不能开启第二个 bracket。
			await funnel.runBracketed(async () => {
				funnel.recordOpen('nested.md', 'leaf-1');
			});
			expect(visits).toEqual([]);

			vi.advanceTimersByTime(5000); // BRACKET_WATCHDOG_MS
			expect(funnel.isMoving()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('NavFunnel —— 采集点发布些什么', () => {
	it('普通打开是不带 key 的 visit；带 key 的是 jump', () => {
		const { funnel, visits } = makeFunnel();

		funnel.recordOpen('a.md', 'leaf-1');
		funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## T' });

		expect(visits).toHaveLength(2);
		expect(visits[0]).toMatchObject({
			cause: 'open',
			record: { kind: 'visit', path: 'a.md', leafId: 'leaf-1' },
		});
		expect(visits[1]).toMatchObject({
			cause: 'jump',
			record: { kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:## T' },
		});
	});

	it('无路径的视图靠激活它的 leaf 抵达；既无路径又无类型的调用什么都不是', () => {
		const { funnel, visits } = makeFunnel();

		funnel.recordOpen(undefined, 'leaf-1', { viewType: 'graph' });
		funnel.recordOpen(undefined, 'leaf-1');
		funnel.recordOpen('', 'leaf-1');

		expect(visits).toEqual([
			{ record: { kind: 'view', leafId: 'leaf-1', viewType: 'graph' }, cause: 'open' },
		]);
	});

	it('teleport 带着它瞄准的那一行，落定之后再带上落点', () => {
		const { funnel, visits } = makeFunnel();

		funnel.recordTeleport('a.md', 'leaf-1', 300);
		funnel.recordTeleport('a.md', 'leaf-1', 500, { scroll: 12 });

		expect(visits).toEqual([
			{ record: { kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 300 }, cause: 'teleport' },
			{ record: { kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 500, st: { scroll: 12 } }, cause: 'teleport' },
		]);
	});

	it('一次标签页激活 = 被离开那个的 LEAVE + 接管过来那个的 visit', () => {
		// 这两者是刻意分开的两个事实：只有那次离开知道读者当时在哪，而且它只在这一刻可读
		// （聚焦另一个标签页不会触发 setViewState）。
		const { funnel, visits, leaves } = makeFunnel();
		const next = leafWithFile('leaf-2', 'b.md');

		funnel.recordActivation(next);

		expect(leaves).toEqual([{ cause: 'tab', leaf: next }]);
		expect(visits).toEqual([
			{ record: { kind: 'visit', path: 'b.md', leafId: 'leaf-2' }, cause: 'tab' },
		]);
	});

	it('侧边栏拿到焦点这件事根本不算导航', () => {
		// 面板在自己的 view state 里跟着当前文件走；把它记下来，会把面板本身变成一个幽灵
		// 的步。
		const { funnel, visits, leaves } = makeFunnel();
		const sidebar = {
			id: 'side', containerEl: 'sidebar', view: { getViewType: () => 'outline' },
		} as unknown as WorkspaceLeaf;

		funnel.recordActivation(sidebar);
		funnel.recordActivation(null);

		expect(visits).toEqual([]);
		expect(leaves).toEqual([]);
	});

	it('主区视图不论什么类型都算地点：类型不再是白名单', () => {
		// 这份列表从前只留 'graph'，别的什么都不留。所以一个去了 Thino 的读者，会把
		// **他们来的那个文件**当成列表上最新的地点 —— 一篇无关的笔记替了他们真正去的地方
		// （见 nav/entry.ts 的 NON_DESTINATION_VIEW_TYPES）。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', { label: 'Thino' }));

		expect(visits).toEqual([{
			record: { kind: 'view', leafId: 'leaf-t', viewType: 'thino_view', label: 'Thino' },
			cause: 'tab',
		}]);
	});

	it('从没给自己起过名的视图不记 label：面板自己有说法', () => {
		// 既不是空串，也不是视图类型：这条记录只说它知道的东西，而那一行给它印什么由浏览器
		// 决定（见 recent-files/browser/model.ts 的 viewName）。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-g', 'graph'));

		expect(visits).toEqual([{
			record: { kind: 'view', leafId: 'leaf-g', viewType: 'graph' },
			cause: 'tab',
		}]);
	});

	it('空标签页是唯一不算地点的视图', () => {
		// 主区 leaf 什么都不装的时候显示的东西：它背后没有任何东西可以回去，所以不为它发布
		// 任何东西。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-e', 'empty'));

		expect(visits).toEqual([]);
	});

	it('视图是空标签页的那个主区 leaf，仍然算一次离开', () => {
		// 被离开的那个标签页无论如何都保留它的位置 —— 只有那半截会把新视图变成**一步**的东西
		// 被跳过，而空标签页是唯一不算地点的视图。
		const { funnel, visits, leaves } = makeFunnel();
		const empty = leafWithFile('leaf-2'); // view type 'empty'

		funnel.recordActivation(empty);

		expect(visits).toEqual([]);
		expect(leaves).toHaveLength(1);
	});

	it('视图还没建起来就被恢复的标签页，就是它所代表的那篇笔记', () => {
		// 移动端回到它上次在读的那篇笔记时，它是一个**延迟**标签页：一个照着保存下来的 state
		// 回答视图问题的占位符，压根不是 FileView。把它记成视图，会凭空造出一个 key 为
		// `view:markdown` 的地点 —— 还挂着这篇笔记自己的名字与文件图标 —— 任何删除都清理不掉
		// 它，而且它那一行打开这篇笔记时还不带保存的位置。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(deferredLeaf('leaf-2', { file: 'b.md', mode: 'source' }));

		expect(visits).toEqual([
			{ record: { kind: 'visit', path: 'b.md', leafId: 'leaf-2' }, cause: 'tab' },
		]);
	});

	it('存下的 state 没点名文件的延迟标签页，仍然是它所代替的那个视图', () => {
		// 这样恢复的无路径视图保留它的地点（类型是占位符唯一老实回答的东西）—— 把它丢掉，会让
		// 一个站在该视图里的读者背后没有任何一步。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(deferredLeaf('leaf-2', undefined, 'graph'));

		expect(visits).toEqual([
			{ record: { kind: 'view', leafId: 'leaf-2', viewType: 'graph' }, cause: 'tab' },
		]);
	});

	it('这个仓库已经造不出来的视图不算地点', () => {
		// 一个被关掉、卸载、或还没加载的插件：恢复它的标签页会得到一个占位面板，它用自己代替
		// 的那个类型来回答 getViewType()。把它按它自己记下来，会拿走真实地点**自己的** key 并
		// 覆盖掉它，而读者之后做什么都回不到那个真地点了。
		const app = makeApp(undefined, ['thino_view']);
		const { funnel, visits } = makeFunnel(app);

		funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', { label: 'thino_view', icon: 'lucide-ghost' }));

		expect(visits).toEqual([]);
	});

	it('同一个视图，在还造得出它的仓库里照样被记录', () => {
		// 读注册表是分辨这两者**唯一**的东西，而它绝不能误伤：这个构建没有暴露出来的那张表，
		// 会让每一个视图都保住它的地点。
		const { funnel, visits } = makeFunnel(makeApp());

		funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', { label: 'Thino' }));

		expect(visits).toHaveLength(1);
	});

	it('没能说清自己是 file view 的 markdown 标签页，不算一个视图地点', () => {
		// 与上面两个一样的幽灵，从剩下的最后一扇门进来：一个 markdown 标签页永远是一篇笔记，
		// 所以一个 key 为 `view:markdown` 的地点，永远不可能是读者去过的。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-2', 'markdown', { label: 'b', icon: 'file' }));

		expect(visits).toEqual([]);
	});

	it('文件已经不在了的 file view 不算自己的地点', () => {
		// 一次同步替换一篇笔记的做法是先删掉文件、再把下载的那个改名盖上去（见
		// position/path-bookkeeping.ts），在那一个瞬间，仍显示着这篇笔记的标签页就是一个
		// `file` 为 null 的 FileView。把它记成视图，从前会凭空造出一个幽灵地点 —— key 为
		// `view:markdown`、挂着这篇笔记自己的名字与文件视图的图标、与真实的一行无从分辨 ——
		// 而任何删除都清理不掉它，因为视图那一行背后没有文件可以「失踪」；它会一直坐在列表上，
		// 直到读者亲手把它拿掉。一个 FileView 要么是它点名的那次访问，要么什么都不是：一个
		// 瞬间不是目的地。它所在的标签页仍然算一次离开。
		const { funnel, visits, leaves } = makeFunnel();
		const emptied = {
			id: 'leaf-2',
			containerEl: 'main',
			view: Object.assign(Object.create(FileView.prototype), { file: null }),
		} as unknown as WorkspaceLeaf;

		funnel.recordActivation(emptied);

		expect(visits).toEqual([]);
		expect(leaves).toHaveLength(1);
	});

	it('跟着笔记走的面板视图就是它那个视图，不是对这篇笔记的第二次 visit', () => {
		// 大纲、反向链接、局部图谱与属性这几个面板继承 FileView，并把 app 自己的目的地标记关掉
		// 了：它们显示读者正站在其中的那篇笔记。侧边栏把它们藏起来（它们不是主区 leaf），但
		// 「在主区打开」会把其中一个放到读者眼前 —— 而把它记成它指向的那个文件，列表就会为
		// 一篇读者从未去过的笔记多长出一行。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(followingLeaf('leaf-o', 'outline', 'b.md', { label: 'Outline' }));

		expect(visits).toEqual([
			{ record: { kind: 'view', leafId: 'leaf-o', viewType: 'outline', label: 'Outline' }, cause: 'tab' },
		]);
	});

	it('没有笔记可跟的面板视图仍然是它那个视图', () => {
		// 它跟着的那个文件没了，也不改变它**是什么**：背后没有笔记的那一行并不比上面那一行更真。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(followingLeaf('leaf-o', 'backlink'));

		expect(visits).toEqual([
			{ record: { kind: 'view', leafId: 'leaf-o', viewType: 'backlink' }, cause: 'tab' },
		]);
	});

	it('丢了那个标记的 file view 就是它点名的那篇笔记', () => {
		// 这个标记只在运行时存在，所以改了它名字的构建会读到 undefined，而上面那个测试就跟它
		// 下面那个普通笔记无从分辨了：**只有** `false` 可以排除，否则丢了这个字段会把每一条
		// 文件记录一起带走。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(leafWithFile('leaf-2', 'b.md'));

		expect(visits).toEqual([
			{ record: { kind: 'visit', path: 'b.md', leafId: 'leaf-2' }, cause: 'tab' },
		]);
	});

	it('除名字之外，还记下视图自己报告的 state 与图标', () => {
		// 三样都是视图对自己的说法（见 shared/leaf.ts），而且都在唯一读得到的那一刻读。读者
		// 回来时这个标签页若已经没了，那个地点**靠什么重建**就是 state（见 NavView.state）；
		// 图标是它那一行戴着的标记。
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', {
			label: 'Thino', icon: 'git-fork', state: { filter: 'today' },
		}));

		expect(visits).toEqual([{
			record: {
				kind: 'view', leafId: 'leaf-t', viewType: 'thino_view',
				label: 'Thino', icon: 'git-fork', state: { filter: 'today' },
			},
			cause: 'tab',
		}]);
	});

	it('一个介绍自己时抛异常的视图照样被记录，只是不带那些附加项', () => {
		// getDisplayText / getIcon / getState 是从 workspace 事件处理程序里调用的外来方法：
		// 一个在其中一个里抛异常的视图，绝不能把读者自己的那次标签页切换一起拖垮，而且**这个
		// 地点**比那三样里的任何一个都值钱（见 shared/leaf.ts 里的那些守卫）。
		const { funnel, visits } = makeFunnel();
		const hostile = {
			id: 'leaf-x',
			containerEl: 'main',
			view: {
				getViewType: () => 'thino_view',
				getDisplayText: () => { throw new Error('no name'); },
				getIcon: () => { throw new Error('no icon'); },
				getState: () => { throw new Error('no state'); },
			},
		} as unknown as WorkspaceLeaf;

		funnel.recordActivation(hostile);

		expect(visits).toEqual([{
			record: { kind: 'view', leafId: 'leaf-x', viewType: 'thino_view' },
			cause: 'tab',
		}]);
	});
});

describe('NavFunnel —— 两种位置读取', () => {
	it('leave（读者当时在哪）与 settled（跳转落到哪）分得很清，两者都不受闸门管', () => {
		// 这个区分正是地点列表能只取第二种的全部理由：一个 jump 的那一行承诺的是它自己那一处，
		// 从来不是读者离开之前漂到哪。不受闸门管，因为调用它们的那些采集点（补丁、采样器）已经
		// 拍过板了。
		const app = makeApp();
		const { funnel, leaves } = makeFunnel(app);
		(app.workspace as { layoutReady: boolean }).layoutReady = false;

		funnel.leave('a.md', 'leaf-1', { scroll: 7 });
		funnel.settled('a.md', 'leaf-1', { scroll: 9 });

		expect(leaves).toEqual([
			{ cause: 'read', path: 'a.md', leafId: 'leaf-1', st: { scroll: 7 } },
			{ cause: 'settled', path: 'a.md', leafId: 'leaf-1', st: { scroll: 9 } },
		]);
	});
});

describe('NavFunnel —— 广播', () => {
	it('visit 是已经拍板的一次导航，所以公共闸门不适用于它', () => {
		// 栈前往一个地点时交出来的东西：在它自己的 bracket 里，闸门会（正确地）把一切都拒掉。
		const app = makeApp();
		const { funnel, visits } = makeFunnel(app);
		(app.workspace as { layoutReady: boolean }).layoutReady = false;

		funnel.visit({ record: { kind: 'visit', path: 'a.md', leafId: 'leaf-1' }, cause: 'open' });

		expect(visits).toHaveLength(1);
	});

	it('landing 与 here 送到每一个订阅者', () => {
		const { funnel, landings, heres } = makeFunnel();
		const jumped = entry('a.md');
		const other = { onLanded: vi.fn(), onHere: vi.fn() };
		funnel.subscribe(other);

		funnel.landing(jumped);
		funnel.here(jumped);

		expect(landings).toEqual([jumped]);
		expect(heres).toEqual([jumped]);
		expect(other.onLanded).toHaveBeenCalledWith(jumped);
		expect(other.onHere).toHaveBeenCalledWith(jumped);
	});

	it('订阅者只收到它实现了的那些钩子', () => {
		// 地点列表从不实现 onLeave：它的那些行承诺的是一个 jump **落到**了哪，不是读者漂到了哪。
		const { funnel } = makeFunnel();
		const onlyLanded = { onLanded: vi.fn() };
		funnel.subscribe(onlyLanded);

		funnel.recordOpen('a.md', 'leaf-1');       // onVisit
		funnel.leave('a.md', 'leaf-1', { scroll: 1 }); // onLeave
		funnel.landing(entry('a.md'));             // onLanded
		funnel.here(entry('a.md'));                // onHere

		expect(onlyLanded.onLanded).toHaveBeenCalledTimes(1);
	});

	it('取消订阅只停止发给那一个订阅者', () => {
		const { funnel, visits } = makeFunnel();
		const second: NavRecording[] = [];
		const unhook = funnel.subscribe({ onVisit: (recording) => second.push(recording) });

		funnel.recordOpen('a.md', 'leaf-1');
		unhook();
		funnel.recordOpen('b.md', 'leaf-1');

		expect(second).toHaveLength(1);
		expect(visits).toHaveLength(2);
	});
});

describe('NavFunnel —— 一份记录，多个读取方', () => {
	it('栈与地点列表都听得到它，而且谁也不知道对方存在', () => {
		// 组合根把它接起来（见 position/manager.ts）；漏斗自己只管发布。
		const { funnel, stack, places } = makeNav();

		funnel.recordOpen('a.md', 'leaf-1');

		expect(stack.entries.map(pathOf)).toEqual(['a.md']);
		expect(places.entries.map(pathOf)).toEqual(['a.md']);
	});

	it('闸门是共用的，所以一条栈被吩咐不留的记录仍然会到达地点列表', () => {
		// 栈自己那几道闸门（记标签页切换 / 记光标跳跃）管的是**它**那张列表；漏斗在它们任何
		// 一个之前就发布了，这正是两个 store 能被拆开的原因。
		const { funnel, stack, places } = makeNav(makeApp(), { navHistoryRecordActivation: false });

		funnel.recordActivation(leafWithFile('leaf-2', 'b.md'));

		expect(stack.entries).toEqual([]);
		expect(places.entries.map(pathOf)).toEqual(['b.md']);
	});
});

// ===== 采样器：文件内的跳变检测 =====

type DatabaseStub = { db: Record<string, unknown>; setState: ReturnType<typeof vi.fn>; deleteFile: ReturnType<typeof vi.fn> };

function makeSamplerHarness(settings: Partial<PluginSettings> = {}) {
	const cursor = { line: 60, ch: 0 };
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path: 'a.md' },
		containerEl: document.createElement('div'),
		currentMode: { getScroll: () => 42.3 },
		editor: {
			lineCount: () => 200,
			getCursor: () => ({ ...cursor }),
			somethingSelected: () => false,
		},
		getViewType: () => 'markdown',
	});
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1', view };
	const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
	const app = {
		workspace: {
			getActiveViewOfType: () => view,
			iterateAllLeaves: () => undefined,
			layoutReady: true,
		},
		metadataCache: { getFileCache: () => null },
	};
	// 阈值是钉死的：DEFAULT_SETTINGS 出厂是 0（推断出来的步关着），而这些测试讲的是这个
	// 探测器，不是默认值。
	const fullSettings = { ...DEFAULT_SETTINGS, navHistoryTeleportMinLines: 10,
		...settings } as PluginSettings;
	const state = new PositionState(fullSettings);
	const leave = vi.fn();
	const recordTeleport = vi.fn();
	const store = new PositionStore(app as never, database as never);
	// 采样器往哪个漏斗写。采样器纯粹是一个**采集点** —— 它从不读栈 —— 所以一个探子漏斗就是
	// 它需要的全部。
	const funnel = {
		recordOpen: vi.fn(),
		recordTeleport,
		recordActivation: vi.fn(),
		leave,
		settled: vi.fn(),
		landing: vi.fn(),
	};
	const sampler = new Sampler(app as never, store, fullSettings, state, funnel as never);
	state.lastLoadedFilePath = 'a.md';
	state.lastEphemeralState = { scroll: 0, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };
	const onSelection = (sampler as unknown as { onEditorSelection: (editor: unknown) => void }).onEditorSelection;
	return { sampler, state, recordTeleport, leave, database, view, cursor, onSelection };
}

describe('Sampler 的文件内跳变检测', () => {
	it('一次 ≥10 行的光标跳跃经 selection 事件记录，并刷新那条离开记录', () => {
		const h = makeSamplerHarness(); // view cursor sits at line 60; poll read at line 3
		h.onSelection(h.view.editor); // baseline: line 60
		h.cursor.line = 3;
		h.onSelection(h.view.editor);
		expect(h.recordTeleport).toHaveBeenCalledTimes(1);
		expect(h.recordTeleport.mock.calls[0]).toEqual(['a.md', 'leaf-1', 3, {
			scroll: 42,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
		}]);
		// 被离开的那个条目拿到了轮询的读数 —— 这个 fixture 是手工播下那个基线的，所以它不像
		// 一次真正的轮询读取那样带着采集戳
		expect(h.leave).toHaveBeenCalledWith('a.md', 'leaf-1', {
			scroll: 0,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
		});
	});

	it('记录规则从不拦导航：被排除的文件照样记录跳变，位置则不写', () => {
		const h = makeSamplerHarness({ excludedFolders: ['a.md'] });
		// 轮询这条路：数据库记录被丢掉，什么都没写 —— 规则只管位置。
		h.sampler.sampleActiveView();
		expect(h.database.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.database.setState).not.toHaveBeenCalled();
		// 事件这条路：导航记录从不查排除规则。
		h.onSelection(h.view.editor); // baseline: line 60
		h.cursor.line = 3;
		h.onSelection(h.view.editor);
		expect(h.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 3, expect.anything());
	});

	it('手机上轮询不做任何推断：一次 57 行的光标移动写位置、但不压步', () => {
		// 轮询是触摸设备唯一有的光标采样器，而它没有什么值得推断的东西：一次滑动不移动光标，
		// 一次轻点也落在本就在屏幕上的这一屏之内。所以移动端读者的前进后退讲的是他们从哪个
		// **文件**来 —— 这也正是它之中任何滚动回退都替代不了的那部分。
		const origMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeSamplerHarness(); // view cursor at 60, poll read at 3
			// 读者点了这篇笔记：是他们的触摸让这次移动属于他们，而不是属于一次重渲染。
			h.state.lastTouchAt = Date.now();
			h.sampler.sampleActiveView();
			expect(h.recordTeleport).not.toHaveBeenCalled();
			expect(h.leave).not.toHaveBeenCalled();
			expect(h.database.setState).toHaveBeenCalled();
		} finally {
			Platform.isMobileApp = origMobile;
		}
	});

	it('阈值为 0 时，selection 事件这条路径完全沉默', () => {
		const h = makeSamplerHarness({ navHistoryTeleportMinLines: 0 });
		h.onSelection(h.view.editor); // baseline: line 60
		h.cursor.line = 3;
		h.onSelection(h.view.editor); // 57-line jump, threshold 0
		expect(h.recordTeleport).not.toHaveBeenCalled();
		expect(h.leave).not.toHaveBeenCalled();
	});

	it('flushOnLeave 写下精确的离开状态；记录规则照样管着它', () => {
		const st = { scroll: 7, cursor: { from: { line: 5, ch: 0 }, to: { line: 5, ch: 0 } } };

		const h = makeSamplerHarness();
		h.sampler.flushOnLeave(h.view, 'a.md', st);
		expect(h.database.setState).toHaveBeenCalledWith('a.md', st);

		const excluded = makeSamplerHarness({ excludedFolders: ['a.md'] });
		excluded.sampler.flushOnLeave(excluded.view, 'a.md', st);
		expect(excluded.database.setState).not.toHaveBeenCalled();
	});
});
