// 「最近文件」列表（recent-files/places.ts + places-store.ts）的测试：这个 store
// 既是面板据以绘制、据以前往的东西，也是栈喂数据的地方。
//
// 这里钉住的是本功能赖以成立的那条分界：**这份列表只装笔记，不装位置。** 一行的
// 点击以普通方式打开文件，落在哪儿由位置数据库回答；一次跳转（一个标题、一个块、
// 一次搜索命中）在这里一律降级成访问。于是：一条记录 = 一行，身份就是它的路径
// （一个无路径视图是它的视图类型），没有第二套身份，也没有第二个池子。
//
// 它仍然不是前进/后退栈：那个 store 照记跳转、且带着落点，所以「回到某一节」在
// 那里还在 —— 而在这里，那一节是**搜**出来的（见 browser/list.ts 的大纲行）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, MarkdownView, TFile } from 'obsidian';

import { NavPlaces } from '@/recent-files/places';
import { RECENT_PLACES_VERSION } from '@/recent-files/places-store';
import { landedLine, NavEntry, NavJump, NavTeleport, NavVisit, navGroupKey } from '@/nav/entry';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

const STORAGE_KEY = 'position-restore:nav-recent:test-vault';

function makeApp(): App {
	return {
		appId: 'test-vault',
		vault: {
			configDir: '.obsidian',
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
		},
	} as unknown as App;
}

// 一个笔记带 frontmatter 的 vault：列表自己的属性规则会去读元数据缓存（见
// shared/frontmatter.ts），而这是它唯一会问 app 的地方 —— 其余一切都还是上面那个
// 光秃秃的桩。`props` 里缺席的路径，会表现得像缓存还没解析过的文件。
function makeAppWithFrontmatter(props: Record<string, Record<string, unknown>>): App {
	return {
		...makeApp(),
		metadataCache: {
			getFileCache: (file: TFile) => {
				const fm = props[file.path];
				return fm ? { frontmatter: fm } : null;
			},
		},
	} as unknown as App;
}

function makeSettings(over: Partial<PluginSettings> = {}): PluginSettings {
	return { ...DEFAULT_SETTINGS, ...over } as PluginSettings;
}

// 一个知道「每个后缀由哪个视图打开」的 app —— 图片开关的主判据去问它（见
// recent-files/places.ts 的 isImagePath）。光秃秃的 makeApp 没有这张表，那正是钉住
// 那张硬编码退路的形态。
function makeAppWithViewTypes(types: Record<string, string>): App {
	return {
		...makeApp(),
		viewRegistry: {
			getTypeByExtension: (ext: string) => types[ext],
		},
	} as unknown as App;
}

// 打开流水线，缩微版：一次前往索要了什么，以及它们的次序。`jumps` 留下被交出去的那**整条**
// 记录 —— 一次前往落在哪是由记录自己说的，光看身份看不出来。
function openers() {
	const calls: string[] = [];
	const jumps: NavEntry[] = [];
	return {
		calls,
		jumps,
		open: {
			openFile: async (path: string, leafId: string) => { calls.push(`file:${path}@${leafId}`); },
			openJump: async (entry: NavEntry) => {
				calls.push(`jump:${navGroupKey(entry)}`);
				jumps.push(entry);
			},
			openView: async (entry: NavEntry) => { calls.push(`view:${navGroupKey(entry)}`); },
		},
	};
}

function makePlaces(settings: Partial<PluginSettings> = {}, app = makeApp()) {
	const places = new NavPlaces(app, makeSettings(settings));
	const opened = openers();
	places.attach(opened.open);
	return { places, calls: opened.calls, jumps: opened.jumps, app };
}

const visit = (path: string, leafId = 'leaf-1'): NavVisit =>
	({ kind: 'visit', path, leafId, t: 0 });
const jump = (path: string, key: string, leafId = 'leaf-1'): NavJump =>
	({ kind: 'jump', path, leafId, key, t: 0 });
const teleport = (path: string, line: number, leafId = 'leaf-1'): NavTeleport =>
	({ kind: 'teleport', path, leafId, line, t: 0 });
const view = (viewType = 'graph', leafId = 'leaf-1'): NavEntry =>
	({ kind: 'view', leafId, viewType, t: 0 });

// 一行的身份，按这个 store 自己给它命名的方式（见 nav/entry.ts 的 navGroupKey）。
const keys = (places: NavPlaces) => places.entries.map(e => navGroupKey(e));

beforeEach(() => {
	window.localStorage.clear();
});

describe('NavPlaces —— 什么算一行', () => {
	it('每个文件一条记录，再看一遍就挪到末尾', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(visit('a.md'));

		// 每个文件一条记录 —— 一个开了十次的文件就是一行 —— 而数组**就是** MRU 次序
		// （面板把索引读作时钟，见 list.ts 的 activeRep）。
		expect(keys(places)).toEqual(['b.md', 'a.md']);
	});

	it('重访只是重新盖章，不复制出一个新行', () => {
		const { places } = makePlaces();
		const spy = vi.spyOn(Date, 'now').mockReturnValue(1000);
		try {
			places.remember(visit('a.md'));
			spy.mockReturnValue(2000);
			places.remember(visit('a.md'));
		} finally {
			spy.mockRestore();
		}

		expect(places.entries).toHaveLength(1);
		expect(places.entries[0].t).toBe(2000);
	});

	it('推断出来的步（跳变）整个丢掉', () => {
		// 采样器的启发式不是读者选择的地方，而这正是这份列表需要第二层淘汰的原因
		// （见 places.ts）。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(teleport('a.md', 500));

		expect(keys(places)).toEqual(['a.md']);
	});

	it('一条记录不携带任何位置', () => {
		// 「我把这篇笔记留在哪」归位置数据库管。这里再存一份，只会让这一行的点击与
		// 一次普通打开各自说一套 —— 而它们的整个要点就是**一样**。
		const { places } = makePlaces();
		places.remember({ ...visit('a.md'), st: { scroll: 120 } } as NavVisit);

		expect(places.entries).toHaveLength(1);
		expect((places.entries[0] as NavVisit).st).toBeUndefined();
	});

	it('无路径视图自己就是一行', () => {
		const { places } = makePlaces();
		places.remember(view('graph'));
		places.remember(visit('a.md'));

		expect(keys(places)).toEqual(['view:graph', 'a.md']);
	});

	it('视图保留它自己的名字，每次访问都刷新一遍', () => {
		// 标签不是行**身份**的一部分 —— 身份是视图类型（见 navGroupKey），两个 Thino
		// 标签页是同一个地方。它是那一行**打印**出来的东西，且每次都从这次记录里取：
		// 一个给自己改过名的视图，按它**此刻**说的话命名（见 places.ts 的 placeRecord）。
		const { places } = makePlaces();
		const labelAt = (i: number) => {
			const entry = places.entries[i];
			return entry.kind === 'view' ? entry.label : undefined;
		};
		const thino = (label?: string): NavEntry =>
			({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', label, t: 0 });

		places.remember(thino('Thino'));
		expect(labelAt(0)).toBe('Thino');

		places.remember(thino('Memos'));

		// 一行，改了名 —— 不是两行。
		expect(places.entries).toHaveLength(1);
		expect(labelAt(0)).toBe('Memos');
	});

	it('视图保留它自己的状态和图标，每次访问都刷新一遍', () => {
		// 一行在它自己的标签页没了之后**靠什么重建**：读者还在里面时视图持有的 state，
		// 加上它那一行戴着的标记。两者都取自这次记录，和上面的标签一样 —— 而 state 是视图
		// 身上唯一**事后推不出来**的东西（见 NavView.state），所以一次读取空手而归的访问会
		// 保留已经记下的快照，而不是把它抹掉：一次读取失败绝不该让读者丢掉他们离开的那个
		// 地方。
		const { places } = makePlaces();
		const stateAt = (i: number) => {
			const entry = places.entries[i];
			return entry.kind === 'view' ? entry.state : undefined;
		};
		const iconAt = (i: number) => {
			const entry = places.entries[i];
			return entry.kind === 'view' ? entry.icon : undefined;
		};
		const thino = (state?: Record<string, unknown>, icon?: string): NavEntry =>
			({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', t: 0, state, icon });

		places.remember(thino({ filter: 'today' }, 'git-fork'));
		expect(stateAt(0)).toEqual({ filter: 'today' });
		expect(iconAt(0)).toBe('git-fork');

		// 之后的一次访问把两者都重读了。
		places.remember(thino({ filter: 'week' }, 'calendar'));
		expect(places.entries).toHaveLength(1); // 仍是一行：类型就是身份
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBe('calendar');

		// 一次 state 读取空手而归的访问（视图抛了、答了个空、或超过上限 —— 见
		// shared/leaf.ts 的 viewState）会保留原有的东西；而一个不指名任何图标的视图就干脆
		// 把它丢掉，那一行退回用文字（见 list.ts 的 fileRow）。
		places.remember(thino());
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBeUndefined();
	});

	it('视图行就地落地：它的状态，以及随之而来的时间戳', () => {
		// 漏斗给视图的 `onLanded` —— 栈在读者离开时就重读了视图的 state（见 stack.ts 的
		// refreshTopLeafOnActivation），而这份列表必须听到，因为读者点的是**一行**。什么都
		// **不挪**：这一行保留它在列表里的位置，只刷新关于它的事实，于是在面板里往下前往的
		// 读者永远不会看到行在指针底下重排。
		const { places } = makePlaces();
		places.remember(view('thino_view'));
		places.remember(visit('a.md'));

		places.settle({
			kind: 'view', viewType: 'thino_view', leafId: 'leaf-1',
			state: { filter: 'week' }, label: 'Thino',
		});

		expect(keys(places)).toEqual(['view:thino_view', 'a.md']);
		const settled = places.entries[0];
		expect(settled.kind === 'view' ? settled.state : undefined).toEqual({ filter: 'week' });
		expect(settled.kind === 'view' ? settled.label : undefined).toBe('Thino');
	});

	it('不在列表上的行，视图落地一律无视', () => {
		// 没什么可刷新的：那一行要么被读者拿掉了，要么被上限裁掉了。
		const { places } = makePlaces();
		places.remember(visit('a.md'));

		places.settle({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', state: { filter: 'week' } });

		expect(keys(places)).toEqual(['a.md']);
	});
});

// 这份列表**只装笔记**（见类注释）：一次跳转记的是「读者在这篇笔记里」，而不是
// 「读者到了这一节」。落点本身并没有丢 —— 它在栈里 —— 而读者要回到那一节时，用的是
// 这个面板的搜索框（见 browser/list.ts 的大纲行）。
describe('NavPlaces —— 跳转一律降级成访问', () => {
	it('一次大纲点击记的是那篇笔记', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));

		// 一行，不是两行 —— 而它点下去就是普通打开。
		expect(keys(places)).toEqual(['a.md']);
		expect(places.entries.every(e => e.kind === 'visit')).toBe(true);
	});

	it('一篇笔记里点了多少个标题，都只占一行', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(jump('a.md', 'a.md#one'));

		expect(keys(places)).toEqual(['a.md']);
	});

	it('一次跳转把它那一行挪到末尾，跟一次访问一样', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(jump('a.md', 'outline:## One'));

		expect(keys(places)).toEqual(['b.md', 'a.md']);
		expect(places.index).toBe(1);
	});

	it('调用方指定的目标（一次搜索命中）也是那篇笔记', () => {
		// 已经打开的那篇笔记内部的一次搜索命中、或一次反向链接命中：core 把目标作为一个
		// ephemeral state 交过来，于是它不指名任何锚点、它的 key 是一个时间戳（见
		// nav/entry.ts 的 isCallerKey）。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'caller:111'));
		places.remember(jump('a.md', 'caller:222'));

		expect(keys(places)).toEqual(['a.md']);
	});

	it('块目标也是那篇笔记', () => {
		// `[[note#^id]]`：块 id 命名的是这么一处地方 —— 一行只能把它打印成某节里的一个
		// 行号，同一节里的两个看着一模一样。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'a.md#^b1'));
		places.remember(jump('a.md', '^b2'));

		expect(keys(places)).toEqual(['a.md']);
	});

	it('被降级后的那一行仍然过这份列表自己的规则', () => {
		// 降级发生在**规则之内**，而不是绕过它：一个被排除的文件夹里的跳转，不会靠
		// 换一副面孔溜进列表。
		const { places } = makePlaces({ recentFilesExcludeFolders: ['私人'] });
		places.remember(jump('私人/a.md', 'outline:## One'));

		expect(keys(places)).toEqual([]);
	});

	it('落定（settle）对一条笔记什么都不做', () => {
		// 一份笔记的位置不归这份列表管，那是位置数据库的事（见 settle）。只有**视图**
		// 需要落定：它自己的 state 是事后推不出来的东西。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.settle({ ...jump('a.md', 'outline:## One'), keyLine: 12, st: { scroll: 3 } });

		expect(keys(places)).toEqual(['a.md']);
		expect(seen).not.toHaveBeenCalled();
	});
});

describe('NavPlaces —— 它自己的文件夹规则', () => {
	it('跳过读者排除的路径，以及 vault 自己的内部路径', () => {
		const { places } = makePlaces({ recentFilesExcludeFolders: ['私人', '归档/旧'] });
		places.remember(visit('笔记/a.md'));
		places.remember(visit('私人/b.md'));
		places.remember(visit('私人')); // 文件夹路径本身
		places.remember(visit('归档/旧/c.md'));
		places.remember(visit('.trash/d.md'));
		places.remember(visit('.obsidian/workspace.json'));

		// 这条规则是**列表**自己的，刻意不是记录规则那边的那套文件夹
		// （见 PluginSettings.recentFilesExcludeFolders）。
		expect(keys(places)).toEqual(['笔记/a.md']);
	});

	it('完全不去问「该不该记位置」那一套规则', () => {
		// 一个短文件、一个带 frontmatter 标记的文件、一个被排除在**位置**记录之外的文件夹：
		// 它们全都仍是读者会导航过去的文件。
		const { places } = makePlaces({
			excludedFolders: ['日记'],
			minLinesToRecord: 1000,
			frontmatterExcludeProperties: ['kanban-plugin'],
		});
		places.remember(visit('日记/today.md'));
		places.remember(visit('tiny.md'));

		expect(keys(places)).toEqual(['日记/today.md', 'tiny.md']);
	});

	it('新近排除的文件夹里已经记下的行要丢掉', () => {
		const settings = makeSettings();
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('私人/a.md'));
		places.remember(visit('公开/b.md'));
		places.markCurrent(visit('私人/a.md'));
		expect(places.index).toBe(0);

		settings.recentFilesExcludeFolders = ['私人'];
		expect(places.pruneExcluded()).toBe(1);
		expect(keys(places)).toEqual(['公开/b.md']);
		// 读者原先站着的那一行走掉了：没有东西「在这里」
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces —— 它自己的 frontmatter 规则', () => {
	it('frontmatter 命中属性规则的文件跳过', () => {
		const app = makeAppWithFrontmatter({
			'看板/board.md': { 'kanban-plugin': 'basic' },
			'published/a.md': { publish: true },
			'published/b.md': { publish: false },
			'notes/c.md': { status: 'draft' },
		});
		const { places } = makePlaces({ recentFilesExcludeProperties: ['kanban-plugin', 'publish: true'] }, app);
		places.remember(visit('看板/board.md'));
		places.remember(visit('published/a.md'));
		places.remember(visit('published/b.md'));
		places.remember(visit('notes/c.md'));

		// 光一个名字会挡掉每个带着它的文件（`kanban-plugin`）；带值的名字只挡掉值相等的文件
		// （`publish: true`，所以还没发布的 b.md 照样列出）。这项写法正是位置规则本来就会说的
		// 那种（见 shared/frontmatter.ts）。
		expect(keys(places)).toEqual(['published/b.md', 'notes/c.md']);
	});

	it('新近排除的属性已经记下的行要丢掉', () => {
		const app = makeAppWithFrontmatter({
			'看板/board.md': { 'kanban-plugin': 'basic' },
			'notes/a.md': { status: 'draft' },
		});
		const settings = makeSettings();
		const places = new NavPlaces(app, settings);
		places.remember(visit('看板/board.md'));
		places.remember(jump('看板/board.md', 'outline:## T'));
		places.remember(visit('notes/a.md'));

		// **整行**都走 —— 那篇笔记以及它里面做出的每次跳转 —— 和一个刚被排除的文件夹一样
		// （见 pruneExcluded）。
		settings.recentFilesExcludeProperties = ['kanban-plugin'];
		expect(places.pruneExcluded()).toBe(1);
		expect(keys(places)).toEqual(['notes/a.md']);
	});

	it('不读「恢复位置」功能自己那个逐文件标记', () => {
		// `position-restore: false` 回答的是这个文件要不要**记位置** —— 它对读者会不会去那儿
		// 一句话也不说。
		const app = makeAppWithFrontmatter({ 'notes/a.md': { 'position-restore': false } });
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, app);
		places.remember(visit('notes/a.md'));

		expect(keys(places)).toEqual(['notes/a.md']);
	});

	it('frontmatter 还没解析的文件照样列出来', () => {
		// 元数据缓存是惰性填充的。凭猜测就扣下的一行，是读者拿不回来的一行；下一次访问会
		// 重新问一遍。
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, makeAppWithFrontmatter({}));
		places.remember(visit('notes/a.md'));

		expect(keys(places)).toEqual(['notes/a.md']);
	});

	it('读者一条规则都没写时，一句也不去问 vault', () => {
		// 默认情形：没有规则，就不读元数据缓存。makeApp() 压根没有 metadataCache，所以这里
		// 去查一下就会抛。
		const { places } = makePlaces();
		places.remember(visit('notes/a.md'));

		expect(keys(places)).toEqual(['notes/a.md']);
	});
});

// 图片开关 —— 这份列表唯一一条问「这个文件**是什么**」的规则（其余几条问的都是它在哪儿、
// 写了什么）。出厂关：默认情况下每个目的地都收录，图片是不是其中之一由读者说。
describe('NavPlaces —— 图片开关', () => {
	const app = makeAppWithViewTypes({
		png: 'image', jpg: 'image', md: 'markdown', pdf: 'pdf', canvas: 'canvas',
	});

	it('关着时图片照常收录', () => {
		const { places } = makePlaces({}, app);
		places.remember(visit('附件/截图.png'));
		places.remember(visit('notes/a.md'));

		expect(keys(places)).toEqual(['附件/截图.png', 'notes/a.md']);
	});

	it('开着时只有图片不收录，其它目的地照旧', () => {
		// pdf 与 canvas 同图片一样不是笔记，但它们能翻页、能容纳一个地点 —— 而一张图片
		// 在这份列表里只剩一个文件名可印。
		const { places } = makePlaces({ recentFilesExcludeImages: true }, app);
		places.remember(visit('notes/a.md'));
		places.remember(visit('附件/截图.png'));
		places.remember(visit('附件/旧照.jpg'));
		places.remember(visit('附件/手册.pdf'));
		places.remember(visit('画板/流程.canvas'));

		expect(keys(places)).toEqual(['notes/a.md', '附件/手册.pdf', '画板/流程.canvas']);
	});

	it('app 认不得的后缀不算图片', () => {
		// 注册表答不出来时朝「照旧收录」落：这条门唯一能做的事是排除，失灵时退回现状。
		const { places } = makePlaces({ recentFilesExcludeImages: true }, app);
		places.remember(visit('附件/数据.xyz'));

		expect(keys(places)).toEqual(['附件/数据.xyz']);
	});

	it('问不到 app 时退回那张硬编码后缀表', () => {
		// makeApp() 没有 viewRegistry（公开类型里没有它），所以这是老构建 / 别家客端上
		// 的形态：png 仍被认出，pdf 与未知后缀不受影响。
		const { places } = makePlaces({ recentFilesExcludeImages: true });
		places.remember(visit('附件/截图.png'));
		places.remember(visit('附件/手册.pdf'));
		places.remember(visit('notes/a.md'));

		expect(keys(places)).toEqual(['附件/手册.pdf', 'notes/a.md']);
	});

	it('文件夹名字里的点不是后缀', () => {
		const { places } = makePlaces({ recentFilesExcludeImages: true }, app);
		places.remember(visit('notes.v2/a'));
		places.remember(visit('看图.png/readme.md'));

		expect(keys(places)).toEqual(['notes.v2/a', '看图.png/readme.md']);
	});

	it('打开开关后，列表上已有的图片行要丢掉', () => {
		const settings = makeSettings();
		const places = new NavPlaces(app, settings);
		places.remember(visit('notes/a.md'));
		places.remember(visit('附件/截图.png'));
		places.remember(visit('附件/手册.pdf'));

		settings.recentFilesExcludeImages = true;
		expect(places.pruneExcluded()).toBe(1);
		expect(keys(places)).toEqual(['notes/a.md', '附件/手册.pdf']);
	});
});

// 上限就是**行数**：一行就是一篇笔记（或一个视图），没有别的东西在跟它们争名额。
describe('NavPlaces —— 上限', () => {
	it('丢掉最旧的行，列表保持最近用过的在前', () => {
		const { places } = makePlaces({ recentFilesCap: 3 });
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.remember(visit(p));

		expect(keys(places)).toEqual(['b.md', 'c.md', 'd.md']);
	});

	it('读者正站着的那一行绝不会丢', () => {
		const settings = makeSettings({ recentFilesCap: 3 });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));
		// 回到最旧的那一处 —— 一次遍历，不访问任何新东西。
		places.markCurrent(visit('a.md'));

		// ……然后列表才不得不让出一行：上限在一个此后没再动过的读者底下压低了。
		settings.recentFilesCap = 2;
		places.applyCap();

		// 移除止于当前的索引：'a.md' 就是他们所在的那一行。
		expect(keys(places)).toEqual(['a.md', 'c.md']);
		expect(places.index).toBe(0);
	});

	it('上限调低时就地裁剪，并报出丢了几个', () => {
		const settings = makeSettings({ recentFilesCap: 2 });
		const places = new NavPlaces(makeApp(), settings);
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));

		expect(places.applyCap()).toBe(0);
		settings.recentFilesCap = 1;
		expect(places.applyCap()).toBe(1);
		expect(keys(places)).toEqual(['c.md']);
	});

	it('手工填坏的上限把它夹回合法范围，而不是干脆取消上限', () => {
		const { places } = makePlaces({ recentFilesCap: 'abc' as unknown as number });
		expect(places.cap()).toBe(DEFAULT_SETTINGS.recentFilesCap);
		expect(makePlaces({ recentFilesCap: 0 }).places.cap()).toBe(1);
	});

	it('一篇笔记无论点过多少标题都只算一行', () => {
		// 落点不占名额 —— 它们根本不在这份列表里。三篇笔记，只放得下两行。
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		expect(keys(places)).toEqual(['b.md', 'c.md']);
	});
});

describe('NavPlaces —— 当前所在', () => {
	it('标记出读者正站在它那次访问上的那个文件', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.markCurrent(visit('a.md'));

		expect(places.index).toBe(0);
	});

	it('一次访问把它那一行标成「在这里」', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		expect(places.index).toBe(1);

		// ……一次跳转标的是它降级后的那一行，也就是那篇笔记。
		places.remember(jump('b.md', 'outline:## T'));
		expect(places.index).toBe(1);
	});

	it('推断出来的步标记的是那个文件，它本身不是一行', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.markCurrent(teleport('a.md', 900));

		expect(places.index).toBe(0);
	});

	it('跳转没有自己的行时退回文件', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));

		places.markCurrent(jump('a.md', 'outline:## Gone'));

		expect(places.index).toBe(0);
	});

	it('绝不为正在读的那篇凭空造一行 —— 「在这里」不算一行', () => {
		// 启动时恢复的工作区，会经由一条什么都没记录过的路径打开它的文件。那种情况下列表
		// **真的**保持空：「你在这里」在读者去某处之前没有任何东西可站 —— 列表不会把正在坐着
		// 的那篇笔记放回它自己身上，也没有任何东西能把一行补进来（见下面 forget）。
		const { places } = makePlaces();
		places.markCurrent(visit('restored.md'));

		expect(keys(places)).toEqual([]);
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces —— 前往', () => {
	it('一行照普通方式打开 —— 不注入任何位置', async () => {
		const { places, calls } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));

		await places.travel(0);

		// 一条记录不携带位置，所以什么都不注入：由位置数据库决定 —— 和在文件浏览器里点同一个
		// 文件一模一样。这正是让两个入口行为一致的东西。
		expect(calls).toEqual(['file:a.md@leaf-1']);
	});

	it('视图行是重新激活', async () => {
		const { places, calls } = makePlaces();
		places.remember(view('graph'));

		await places.travel(0);

		expect(calls).toEqual(['view:view:graph']);
	});

	it('下标根本不存在时，哪儿也不去', async () => {
		const { places, calls } = makePlaces();
		await places.travel(7);
		expect(calls).toEqual([]);
	});
});

// 一个**大纲行**的交割（见 list.ts 的 HeadingHit）：那一行印着那一节的名字，所以这次
// 前往必须落在它上面。它是这条链路里唯一一处「行上的字与点击的去处必须一致」的硬契约
// —— 而恰恰是这一处最容易只在 key 上说、忘了在落点上说。
describe('NavPlaces.travelToHeading —— 前往落在它自己印出的那一节上', () => {
	it('造出的那一步把那一节作为**落点**，而不只是作为 key', async () => {
		const { places, jumps } = makePlaces();
		await places.travelToHeading('a.md', '预览', 12, 'leaf-1');

		expect(jumps).toHaveLength(1);
		const place = jumps[0] as NavJump;
		expect(place.key).toBe('outline:预览');
		// 落点：这一步落在第几行由 **`st`** 答出，不是由 keyLine —— 施加一次跳转的那一套
		// （stack.ts 的 landingOf / armLandingMark）读的是 `st`。少了它，这次前往会一路回落
		// 到位置数据库保存的阅读位置，也就是这一行要绕开的那个地方。
		expect(landedLine(place)).toBe(12);
		expect(place.st).toEqual({
			scroll: 12,
			cursor: { from: { line: 12, ch: 0 }, to: { line: 12, ch: 0 } },
		});
	});

	it('去的是**那个标签页**，不是一个新地方', async () => {
		// 前往换的是落点，不是地方：`leafId` 由调用方给出（这一行一贯去往的那个标签页）。
		const { places, jumps } = makePlaces();
		await places.travelToHeading('a.md', '预览', 12, 'leaf-7');

		expect(jumps[0].leafId).toBe('leaf-7');
	});

	it('一个负数行号先被夹住 —— 这一行不会把读者带到一个不存在的行', async () => {
		const { places, jumps } = makePlaces();
		await places.travelToHeading('a.md', '预览', -3, 'leaf-1');

		const place = jumps[0] as NavJump;
		expect(place.keyLine).toBe(0);
		expect(place.st?.scroll).toBe(0);
	});

	it('这一节自己不进这份列表 —— 进的是那篇笔记', async () => {
		// 交出去的那一步是给**栈**的（它照记跳转、且带着落点）。这份列表听到的仍是
		// 「读者在这篇笔记里」（见 remember 的降级）。
		const { places, jumps } = makePlaces();
		await places.travelToHeading('a.md', '预览', 12, 'leaf-1');
		places.remember(jumps[0]);

		expect(places.entries).toHaveLength(1);
		expect(keys(places)).toEqual(['a.md']);
	});
});

// 落点的**几何**：同一件事（「去这一节」）在 core 里有两种落法（源码模式居中、阅读模式
// 贴顶），而这份列表造出来的步必须落成同一个样子 —— 否则点大纲面板的标题与点搜索里的
// 小节会给出两种到达方式。判据全在 shared/jump-landing.ts，这里钉的是它接在哪儿。
const VIEWPORT_PX = 800;
const LINE_PX = 20;

// `measured: false` 造出一个**滚在后台标签页里**的视图：那时整个 leaf 是 display:none，
// 每个后代的矩形都变成 0（jsdom 里则**本来**就是 0，正好是同一件事）—— 从这里量不出任何
// 几何，连滚动容器也一样（见 alignView 与 jump-landing.ts）。
function sourceViewShowing(path: string, opts: { measured?: boolean } = {}): MarkdownView {
	const { measured = true } = opts;
	const contentEl = document.createElement('div');
	const scroller = document.createElement('div');
	scroller.className = 'cm-scroller';
	contentEl.appendChild(scroller);
	const containerEl = document.createElement('div');
	if (measured) {
		const rect = () =>
			({ top: 0, bottom: VIEWPORT_PX, left: 0, right: 400, width: 400, height: VIEWPORT_PX }) as DOMRect;
		scroller.getBoundingClientRect = rect;
		containerEl.getBoundingClientRect = rect;
	}
	return Object.assign(new MarkdownView(undefined as never), {
		getMode: () => 'source',
		file: { path },
		contentEl,
		containerEl,
		editor: {
			cm: {
				state: { doc: { lineAt: (pos: number) => ({ number: pos + 1 }) } },
				posAtCoords: ({ y }: { y: number }) => Math.floor(y / LINE_PX),
				defaultLineHeight: LINE_PX,
			},
		},
	}) as unknown as MarkdownView;
}

function makeAppWithView(...views: MarkdownView[]): App {
	return {
		...makeApp(),
		workspace: {
			iterateAllLeaves: (fn: (leaf: unknown) => void) => {
				for (const view of views)
					fn({ view });
			},
		},
	} as unknown as App;
}

describe('NavPlaces.travelToHeading —— 落点与 core 自己的大纲点击同一几何', () => {
	it('源码模式：把点名那一行摆到中间，`st.scroll` 因此是半个视口之上的视口顶', async () => {
		// 「该落成什么样」问的是**那个标签页的视图**：视口 40 行 ⇒ 往上让 19 行
		// （半个视口再收一行）⇒ 60-19=41。记在 `scroll` 上（而不是只在光标上）是硬要求：
		// 之后每一次前进/后退都按这个值复现，正如 core 记一条大纲点击时记的也是落定之后
		// 的视口，而不是标题所在的行号。
		const { places, jumps } = makePlaces({}, makeAppWithView(sourceViewShowing('a.md')));
		await places.travelToHeading('a.md', '预览', 60, 'leaf-1');

		const place = jumps[0] as NavJump;
		expect(landedLine(place)).toBe(60);
		expect(place.st?.scroll).toBe(41);
		expect(place.st?.cursor?.from).toEqual({ line: 60, ch: 0 });
	});

	it('要去的那个 tag 显示着别的笔记时，拿那个视图量 —— 一次普通的打开就发生在附近', async () => {
		const { places, jumps } = makePlaces({}, makeAppWithView(sourceViewShowing('other.md')));
		await places.travelToHeading('a.md', '预览', 60, 'leaf-1');

		expect((jumps[0] as NavJump).st?.scroll).toBe(41);
	});

	it('量得出几何的视图优先 —— 滚在后台标签页里的那个问不出任何东西', async () => {
		// 后台标签页里的视图矩形全是 0，从它身上读到的「一屏有多少行」也是 0 ⇒ 偏移悄悄
		// 塌成「不让」、落点变贴顶。那正是「有时候居中、有时候贴顶」的来源：挑谁由工作区
		// 的遍历顺序决定。所以要先挑一个量得出来的。
		const hidden = sourceViewShowing('a.md', { measured: false });
		const visible = sourceViewShowing('other.md');
		const { places, jumps } = makePlaces({}, makeAppWithView(hidden, visible));

		await places.travelToHeading('a.md', '预览', 60, 'leaf-1');

		expect((jumps[0] as NavJump).st?.scroll).toBe(41);
	});

	it('只有量不出来的视图时，退回旧行为（贴顶），而不是崩掉', async () => {
		const hidden = sourceViewShowing('a.md', { measured: false });
		const { places, jumps } = makePlaces({}, makeAppWithView(hidden));

		await places.travelToHeading('a.md', '预览', 60, 'leaf-1');

		expect((jumps[0] as NavJump).st?.scroll).toBe(60);
	});

	it('量不到视图（没有工作区 / 还没有 markdown 视图）时退回贴顶', async () => {
		// 这条路径必须能在没有工作区的 store 上跑（见文件头），而那时唯一的答案就是
		// 「不让」—— 也正是这次改动之前的行为。
		const { places, jumps } = makePlaces();
		await places.travelToHeading('a.md', '预览', 60, 'leaf-1');

		expect((jumps[0] as NavJump).st?.scroll).toBe(60);
	});

	it('第一行就是标题的那种笔记：不让，仍落在文件顶上', async () => {
		const { places, jumps } = makePlaces({}, makeAppWithView(sourceViewShowing('a.md')));
		await places.travelToHeading('a.md', '标题', 0, 'leaf-1');

		expect((jumps[0] as NavJump).st?.scroll).toBe(0);
	});

	it('往上让不满一行时夹到 1 —— `applyEphemeralState` 不施加一个 0 的 scroll', async () => {
		// 点名的那一行本来就在顶上半个视口之内：它没法居中，但落点仍要贴住文件的开头，
		// 不能因为「顶 = 0」而被当成「没有滚动请求」。
		const { places, jumps } = makePlaces({}, makeAppWithView(sourceViewShowing('a.md')));
		await places.travelToHeading('a.md', '预览', 7, 'leaf-1');

		expect((jumps[0] as NavJump).st?.scroll).toBe(1);
	});
});

describe('NavPlaces —— 忘掉一行', () => {
	it('丢掉这条记录，以及它那篇笔记做过的每次跳转', () => {
		// 读者说「我不想在这儿看到这篇笔记」指的是那个**文件**：一篇笔记一行是列表自己的形状
		// （见 list.ts），所以一次把跳转留在原处的移除，会把那一行也一起留下。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(visit('b.md'));

		places.forget('a.md');

		expect(keys(places)).toEqual(['b.md']);
	});

	it('其它文件和无路径视图照旧站得住', () => {
		// 视图没有路径，所以没有路径能指名它：这次移除针对的是一篇笔记，而图谱不是
		// （见 places.ts 的 forget）。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(view('graph'));
		places.remember(jump('b.md', 'outline:## T'));

		places.forget('a.md');

		// 经由 navGroupKey 命名而不是写字面量：这里钉住的是哪些行**活了下来**，而 key 是
		// 这个 store 自己给行命名的方式（见 navGroupKey）。
		expect(keys(places)).toEqual(['view:graph', 'b.md']);
	});

	it('无路径视图照样丢得掉 —— 虽然没有路径能指名它', () => {
		// 视图是和任何其它行一样的**一行**，所以它像任何其它行一样从列表上下来 —— 而唯一能
		// 指名它的东西是它自己的**类型**（见 nav/entry.ts 的 navGroupKey）。这个过滤从前会
		// 无条件留住每一条无路径记录，结果让图谱成了一行读者看得见却永远拿不掉的东西。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(view('graph'));
		places.remember(view('thino-memo'));

		places.forget('view:graph');

		expect(keys(places)).toEqual(['a.md', 'view:thino-memo']);
	});

	it('通知面板，好让读者眼看着那一行消失', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forget('a.md');

		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('忘掉的正好是正在读的那一行时，不再站在任何地方', () => {
		// 「此处」是列表里的一个索引：一个没了的行绝不能留下一个索引，否则下一篇到来的笔记
		// 会被指名成读者所在之处。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.markCurrent(visit('a.md'));
		expect(places.index).toBe(0);

		places.forget('a.md');

		expect(places.entries).toEqual([]);
		expect(places.index).toBe(-1);
	});

	it('忘掉的是别的行时，仍站在原来的那一行上', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.markCurrent(visit('b.md'));
		expect(places.index).toBe(1);

		places.forget('a.md');

		// 索引是**按身份**重新找回来的，不是靠算术（见 keep）：滑下一格的那一行还是
		// 同一行。
		expect(keys(places)).toEqual(['b.md']);
		expect(places.index).toBe(0);
	});

	it('列表从来没收过的路径，一句话也不说', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forget('nowhere.md');

		expect(keys(places)).toEqual(['a.md']);
		expect(seen).not.toHaveBeenCalled();
	});
});

describe('NavPlaces —— 簿记', () => {
	it('给每个指名过被改名文件的行换键', () => {
		const { places } = makePlaces();
		places.remember(visit('old.md'));
		places.remember(visit('other.md'));

		places.renameFile('old.md', 'new.md');

		// 身份是按路径重算的，所以没有任何已存的 key 需要重写（见 renameFile）。
		expect(places.entries.map(e => e.kind === 'view' ? '' : e.path))
			.toEqual(['new.md', 'other.md']);
	});

	it('丢掉被删掉的文件那一整行', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));
		places.remember(visit('b.md'));

		places.deleteFile('a.md');

		expect(keys(places)).toEqual(['b.md']);
	});

	it('报出它持有的每个路径，交给启动时那一轮清扫', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('b.md', 'outline:## T'));
		places.remember(view('graph'));

		expect(places.knownPaths().sort()).toEqual(['a.md', 'b.md']);
	});
});

// 一个**钉**是读者对某一行的亲口答复：它被挡在上限之外、裁剪之外，并随着它所指名的
// 那一行一起离开。**它不比规则活得久** —— 一条后来的规则就是关于那一行的后来的答案。
describe('NavPlaces —— 把一行钉到顶部', () => {
	it('新钉的行放在置顶区末尾，同一行不会钉两次', () => {
		// 新钉的行若落在顶部，会把读者已经排好的那些行往下推；这个置顶区是他们正在填的一个
		// 书架，不是一个栈。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.pin('a.md');
		places.pin('b.md');
		places.pin('b.md');

		expect(places.pinned).toEqual(['a.md', 'b.md']);
	});

	it('一次挪一步，到了两头就挪不动', () => {
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.pin('a.md');
		places.pin('b.md');
		places.pin('c.md');
		expect(places.pinned).toEqual(['a.md', 'b.md', 'c.md']);

		places.movePinned('a.md', -1);
		expect(places.pinned).toEqual(['a.md', 'b.md', 'c.md']);
		places.movePinned('a.md', 1);
		expect(places.pinned).toEqual(['b.md', 'a.md', 'c.md']);
		places.movePinned('c.md', 1);
		expect(places.pinned).toEqual(['b.md', 'a.md', 'c.md']);
		places.movePinned('c.md', -1);
		expect(places.pinned).toEqual(['b.md', 'c.md', 'a.md']);
		places.movePinned('nope.md', -1);
		expect(places.pinned).toEqual(['b.md', 'c.md', 'a.md']);
	});

	it('一次挪到底，落在末端而不是越过它', () => {
		// 「移到最前」交过来的步数比置顶区还长，而它的意思就是末端：去数它们是**调用方**对
		// 一个它并不拥有的形状做的算术（见 NavPlaces.movePinned）。
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.remember(visit(p));
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.pin(p);
		expect(places.pinned).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);

		places.movePinned('c.md', -2);
		expect(places.pinned).toEqual(['c.md', 'a.md', 'b.md', 'd.md']);
		// 步数比置顶区还多：那一行**落在**它要的那一端上。
		places.movePinned('a.md', -99);
		expect(places.pinned).toEqual(['a.md', 'c.md', 'b.md', 'd.md']);
		places.movePinned('b.md', 99);
		expect(places.pinned).toEqual(['a.md', 'c.md', 'd.md', 'b.md']);
	});

	it('可以取消置顶；从来没钉过的行一句话也不说', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.pin('a.md');
		places.pin('b.md');

		places.unpin('a.md');
		places.unpin('nope.md');

		expect(places.pinned).toEqual(['b.md']);
		expect(places.isPinned('b.md')).toBe(true);
		expect(places.isPinned('a.md')).toBe(false);
	});

	// **上限**数的是读者**没有**亲口指名的那些行：一个钉被留在那个数字**之上**而不是其中，
	// 所以钉住一篇笔记不会让他们少掉五十里的任何一个。
	it('钉住的行算在上限之外，而不是占上限里面的名额', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.pin('b.md');

		for (const p of ['d.md', 'e.md'])
			places.remember(visit(p));

		// 未被指名的行是 c、d、e —— 多了一个，其中最早的那个走。
		expect(keys(places)).toEqual(['b.md', 'd.md', 'e.md']);
	});

	it('钉住的行也不过期淘汰 —— 那正是钉选存在的意义', () => {
		const settings = makeSettings({ recentFilesCap: 1 });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.pin('a.md');
		places.remember(visit('b.md'));

		expect(places.applyCap()).toBe(0);
		expect(keys(places)).toEqual(['a.md', 'b.md']);
	});

	it('后来加的规则本该排除它时，钉住的行照样丢掉', () => {
		// 一条后来的规则就是关于那一行的后来的答案，而一个钉选是几个月前的一次手势，它
		// 不知道读者后来想要什么（见 pruneExcluded）。
		const settings = makeSettings();
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('notes/a.md'));
		places.remember(visit('b.md'));
		places.pin('notes/a.md');

		settings.recentFilesExcludeFolders = ['notes'];

		expect(places.pruneExcluded()).toBe(1);
		expect(keys(places)).toEqual(['b.md']);
		// ……钉选也跟着走：一个没了的行的钉选，是个什么也不展示的钉选。
		expect(places.pinned).toEqual([]);
	});

	it('钉住的行跟着它所指名的那个文件一起走', () => {
		const { places } = makePlaces();
		places.remember(visit('old.md'));
		places.pin('old.md');

		places.renameFile('old.md', 'new.md');

		expect(places.pinned).toEqual(['new.md']);
	});

	it('行没了，钉住它的那一枚也一起撤', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.pin('a.md');

		places.deleteFile('a.md');
		expect(places.pinned).toEqual([]);

		places.pin('b.md');
		places.forget('b.md');
		expect(places.pinned).toEqual([]);
	});

	it('置顶立刻写盘，不留给下一次落盘', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.persist();
		places.pin('a.md');

		expect(new NavPlaces(makeApp(), makeSettings()).pinned).toEqual(['a.md']);
	});

	it('钉住了才通知面板；什么也没钉住时一个通知也不发', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.pin('a.md');
		places.pin('a.md');
		places.unpin('nope.md');

		expect(seen).toHaveBeenCalledTimes(1);
	});
});

describe('NavPlaces —— 清空列表', () => {
	it('丢掉列表自己记住的每一行，置顶区留下', () => {
		// 清空留下的，正是读者亲手写下的东西：上限与裁剪本来就饶过钉住的行（见 trim），
		// 而清空列表是列表**自己**做的又一件事。
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.remember(view('graph'));
		places.pin('b.md');

		places.clear();

		expect(keys(places)).toEqual(['b.md']);
	});

	it('清掉的正好是正在读的那一行时，不再站在任何地方', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.markCurrent(visit('b.md'));
		expect(places.index).toBe(1);

		places.clear();

		expect(places.entries).toEqual([]);
		expect(places.index).toBe(-1);
	});

	it('清空后立刻写盘，不留给下一次落盘', () => {
		// 理由和「钉住立刻写盘」一样：清空是一次罕见、刻意的动作，否则几秒后一次退出就会把整份
		// 列表放回来。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.persist();

		places.clear();

		expect(new NavPlaces(makeApp(), makeSettings()).entries).toEqual([]);
	});

	it('通知面板，好让读者眼看着那些行消失', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.clear();

		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('列表里除了钉住的行什么都没有时，一句话也不说', () => {
		// 清空一份已经就是清空结果的东西，什么都不改变，而一次没有发生的改变不欠任何重画、也不
		// 欠任何写盘。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.pin('a.md');
		const seen = vi.fn();
		places.subscribe(seen);

		places.clear();

		expect(keys(places)).toEqual(['a.md']);
		expect(seen).not.toHaveBeenCalled();
	});
});

describe('NavPlaces —— 落盘与读回', () => {
	it('按 vault 各自存取一轮，数据不丢', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));
		places.pin('a.md');
		places.persist();

		const restored = new NavPlaces(makeApp(), makeSettings());
		// 一次跳转在到达这里之前就降级了，所以读回来的是**一篇笔记**。
		expect(restored.entries.map(e => e.kind)).toEqual(['visit']);
		expect(keys(restored)).toEqual(keys(places));
		expect(restored.pinned).toEqual(['a.md']);
	});

	it('别的格式版本写的那一坨直接丢掉', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: RECENT_PLACES_VERSION + 1,
			places: [visit('a.md')],
		}));

		expect(new NavPlaces(makeApp(), makeSettings()).entries).toEqual([]);
	});

	it('带着推断步的一坨拒绝接收 —— 它从来不算一行', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: RECENT_PLACES_VERSION,
			places: [visit('a.md'), teleport('a.md', 5), { kind: 'nonsense' }],
		}));

		expect(keys(new NavPlaces(makeApp(), makeSettings()))).toEqual(['a.md']);
	});

	it('一个声称是跳转的条目不是这份列表会画的东西', () => {
		// 存储是任何东西都可能写过的：这份列表只装笔记与视图（见 places-store.ts 的
		// isPlaceEntry）。
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: RECENT_PLACES_VERSION,
			places: [visit('a.md'), jump('b.md', 'outline:## T')],
		}));

		expect(keys(new NavPlaces(makeApp(), makeSettings()))).toEqual(['a.md']);
	});

	it('自己的写入会去重', () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem');
		try {
			const places = new NavPlaces(makeApp(), makeSettings());
			places.remember(visit('a.md'));
			places.persist();
			expect(setItem).toHaveBeenCalledTimes(1);
			places.persist();
			expect(setItem).toHaveBeenCalledTimes(1);
		} finally {
			setItem.mockRestore();
		}
	});

	it('读到垃圾数据就退化成空列表', () => {
		window.localStorage.setItem(STORAGE_KEY, '{not json');
		expect(new NavPlaces(makeApp(), makeSettings()).entries).toEqual([]);
	});
});

// **常驻**面板赖以活着的信号（见 NavPlaces.subscribe）：对话框在一次渲染里打开、读完、
// 关闭，完全不需要这个；但侧边栏面板会在屏幕上待上几个小时，没有别的办法知道列表在它
// 底下动过。这信号从前来自栈（见 nav-history/stack.ts）—— 现在面板画的是行，所以得由
// 这个 store 来说这件事。
describe('NavPlaces —— 变更通知', () => {
	it('订阅者能收到行的变更，退订之后就收不到', () => {
		const { places } = makePlaces();
		const seen = vi.fn();
		const off = places.subscribe(seen);

		places.remember(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);

		// 面板关了：此后记下的行绝不能被画进一个已经被拆掉的身体里。
		off();
		places.remember(visit('b.md'));
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('当前所在换了才通知订阅者，没换就不通知', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.markCurrent(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);
		// 本来就站在那儿：屏幕上什么都没动。
		places.markCurrent(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);
		places.markCurrent(undefined);
		expect(seen).toHaveBeenCalledTimes(2);
	});

	it('改名、按规则剔除、裁剪都通知订阅者 —— 什么都没变的事一个也不通知', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.renameFile('a.md', 'z.md');
		expect(seen).toHaveBeenCalledTimes(1);
		places.renameFile('nothing.md', 'else.md');
		expect(seen).toHaveBeenCalledTimes(1);

		places.remember(visit('b.md'));
		places.remember(visit('c.md')); // 裁剪把 'z.md' 丢掉
		expect(seen).toHaveBeenCalledTimes(3);

		places.deleteFile('b.md');
		expect(seen).toHaveBeenCalledTimes(4);
		places.deleteFile('b.md');
		expect(seen).toHaveBeenCalledTimes(4);

		// 被规则过滤掉的路径从来不是一行，所以它也从来不是新闻。
		places.remember(visit('.trash/x.md'));
		expect(seen).toHaveBeenCalledTimes(4);
	});
});
