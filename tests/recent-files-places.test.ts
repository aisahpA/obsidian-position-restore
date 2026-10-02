// 「最近文件」列表（recent-files/places.ts + places-store.ts）的测试：这个 store
// 既是面板据以绘制、据以前往的东西，也是栈喂数据的地方。
//
// 这里钉住的是本功能赖以成立的那条分界：一个地点不是栈里的一步。地点列表绝不
// 截断，按地点而非按步去重，把推断出来的移动（跳变）整个丢掉，对 FILE 不保留
// 位置（「我把这篇笔记留在哪」归位置数据库管），而对 JUMP 保留它自己的位置
// （那是别处都不会记下的唯一一处）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, TFile } from 'obsidian';

import { NavPlaces, placeKey } from '@/recent-files/places';
import { RECENT_PLACES_VERSION } from '@/recent-files/places-store';
import { NavEntry, NavJump, NavTeleport, NavVisit } from '@/nav/entry';
import { DEFAULT_SETTINGS, NavEntryState, PluginSettings } from '@/types';

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

// 打开流水线，缩微版：一次前往索要了什么，以及它们的次序。
function openers() {
	const calls: string[] = [];
	return {
		calls,
		open: {
			openFile: async (path: string, leafId: string) => { calls.push(`file:${path}@${leafId}`); },
			openJump: async (entry: NavEntry) => { calls.push(`jump:${placeKey(entry)}`); },
			openView: async (entry: NavEntry) => { calls.push(`view:${placeKey(entry)}`); },
		},
	};
}

// 这个 harness 取的是落点设置**中间**那一档，而不是出厂的默认档 'none'（见
// LandingsMode）：本文件大部分都在讲**落点**是什么，而最底那一档会在断言走到之前
// 就把它们全部拒掉。默认档本身由下面单独一个测试把守，而不是由文件里其余每个测试
// 各自把守。
function makePlaces(settings: Partial<PluginSettings> = {}, app = makeApp()) {
	const places = new NavPlaces(app, makeSettings({ recentFilesLandings: 'last', ...settings }));
	const opened = openers();
	places.attach(opened.open);
	return { places, calls: opened.calls, app };
}

const visit = (path: string, leafId = 'leaf-1'): NavVisit =>
	({ kind: 'visit', path, leafId, t: 0 });
const jump = (path: string, key: string, leafId = 'leaf-1'): NavJump =>
	({ kind: 'jump', path, leafId, key, t: 0 });
const teleport = (path: string, line: number, leafId = 'leaf-1'): NavTeleport =>
	({ kind: 'teleport', path, leafId, line, t: 0 });
const view = (viewType = 'graph', leafId = 'leaf-1'): NavEntry =>
	({ kind: 'view', leafId, viewType, t: 0 });

const paths = (places: NavPlaces) => places.entries.map(e => placeKey(e));

beforeEach(() => {
	window.localStorage.clear();
});

describe('NavPlaces —— 什么算一个地点', () => {
	it('每个文件一条记录，再看一遍就挪到末尾', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(visit('a.md'));

		// 每个文件一条记录 —— 一个开了十次的文件就是一行 —— 而数组**就是** MRU 次序
		// （面板把索引读作时钟，见 list.ts 的 activeRep）。
		expect(paths(places)).toEqual(['b.md', 'a.md']);
	});

	it('重访只是重新盖章，不复制出一个新地点', () => {
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
		// 采样器的启发式不是读者选择的地点，而这正是这份列表需要第二层淘汰的原因
		// （见 places.ts）。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(teleport('a.md', 500));

		expect(paths(places)).toEqual(['a.md']);
	});

	it('文件地点可以不带位置，跳转地点要带位置', () => {
		const { places } = makePlaces();
		places.remember({ ...visit('a.md'), st: { scroll: 120 } } as NavVisit);
		places.remember({ ...jump('a.md', 'outline:## T'), st: { scroll: 7 } } as NavJump);

		// FILE 地点不保留自己的位置：「我把这篇笔记留在哪」归位置数据库管，这里再存一份
		// 只会让面板上的行与普通打开各自说一套。
		const file = places.entries.find(e => e.kind === 'visit') as NavVisit;
		expect(file.st).toBeUndefined();
		// ……而一个 jump 的落点在别处不存在，它那一行也把它承诺给了读者。
		const j = places.entries.find(e => e.kind === 'jump') as NavJump;
		expect(j.st).toEqual({ scroll: 7 });
	});

	it('标题落地之后接管这个跳转地点，连 key 一起升级', () => {
		const { places } = makePlaces();
		places.remember({ ...jump('a.md', 'outline:T') } as NavJump);

		places.settle({
			...jump('a.md', 'outline:## T'), keyLine: 12, st: { scroll: 3 },
		} as NavJump);

		const j = places.entries[0] as NavJump;
		expect(j.key).toBe('outline:## T');
		expect(j.keyLine).toBe(12);
		expect(j.st).toEqual({ scroll: 3 });
		// 渲染出来的形式和权威的来源形式是**同一个**地点，不是两个：身份会把那些井号规范掉
		// （见 placeKey）。
		expect(places.entries).toHaveLength(1);
	});

	it('key 升级之后，仍能找回落盘形式记下的那个跳转地点', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## T'));
		places.remember(jump('a.md', 'outline:T'));

		expect(places.entries).toHaveLength(1);
	});

	it('无路径视图自己就是一个地点', () => {
		const { places } = makePlaces();
		places.remember(view('graph'));
		places.remember(visit('a.md'));

		expect(paths(places)).toEqual(['view:graph', 'a.md']);
	});

	it('视图保留它自己的名字，每次访问都刷新一遍', () => {
		// 标签不是地点**身份**的一部分 —— 身份是视图类型（见 placeKey），两个 Thino 标签页
		// 是同一个目的地。它是那一行**打印**出来的东西，且每次都从这次记录里取：一个给自己
		// 改过名的视图，按它**此刻**说的话命名（见 places.ts 的 placeRecord）。
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

		// 一个地点，改了名 —— 不是两个。
		expect(places.entries).toHaveLength(1);
		expect(labelAt(0)).toBe('Memos');
	});

	it('视图保留它自己的状态和图标，每次访问都刷新一遍', () => {
		// 一个地点在它自己的标签页没了之后**靠什么重建**：读者还在里面时视图持有的 state，
		// 加上它那一行戴着的标记。两者都取自这次记录，和上面的标签一样 —— 而 state 是视图
		// 身上唯一**事后推不出来**的东西（见 NavView.state），所以一次读取空手而归的访问会
		// 保留已经记下的快照，而不是把它抹掉：一次读取失败绝不该让读者丢掉他们离开的那个
		// 地点。
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
		expect(places.entries).toHaveLength(1); // still one place: the type is the identity
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBe('calendar');

		// 一次 state 读取空手而归的访问（视图抛了、答了个空、或超过上限 —— 见
		// shared/leaf.ts 的 viewState）会保留原有的东西；而一个不指名任何图标的视图就干脆
		// 把它丢掉，那一行退回用文字（见 list.ts 的 fileRow）。
		places.remember(thino());
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBeUndefined();
	});

	it('视图地点就地落地：它的状态，以及随之而来的时间戳', () => {
		// 漏斗给视图的 `onLanded` —— 栈在读者离开时就重读了视图的 state（见 stack.ts 的
		// refreshTopLeafOnActivation），而这份列表必须听到，因为读者点的是**一行**。什么都
		// **不挪**：地点保留它在列表里的位置，只刷新关于它的事实，于是在面板里往下前往的读者
		// 永远不会看到行在指针底下重排。
		const { places } = makePlaces();
		places.remember(view('thino_view'));
		places.remember(visit('a.md'));

		places.settle({
			kind: 'view', viewType: 'thino_view', leafId: 'leaf-1',
			state: { filter: 'week' }, label: 'Thino',
		});

		expect(paths(places)).toEqual(['view:thino_view', 'a.md']);
		const settled = places.entries[0];
		expect(settled.kind === 'view' ? settled.state : undefined).toEqual({ filter: 'week' });
		expect(settled.kind === 'view' ? settled.label : undefined).toBe('Thino');
	});

	it('不在列表上的地点，视图落地一律无视', () => {
		// 没什么可刷新的：那一行要么被读者拿掉了，要么被上限裁掉了。
		const { places } = makePlaces();
		places.remember(visit('a.md'));

		places.settle({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', state: { filter: 'week' } });

		expect(paths(places)).toEqual(['a.md']);
	});
});

describe('NavPlaces —— 一个标题一条记录', () => {
	// 一个 jump 在它的落点落定之前就被记下，所以合并发生在落定那一刻 —— 那是两个 jump
	// 第一次能被分辨开的时刻。它管的是两个 key 命名**同一处**的情形：一次大纲点击和一个
	// 链接，两者都命名同一个标题。
	it('停在同一行的两个跳转合并成一个', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('a.md', 'a.md#one'));
		places.settle({ ...jump('a.md', 'a.md#one'), st: { scroll: 12 } });

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'a.md#one'))]);
	});

	it('留最新的那一个 —— 也就是这一行本来就是照它画的那个', () => {
		// 面板是照它最新的那一步画出一行的（见 groupByFile），所以活下来的那条记录正是读者
		// 本来就在点的那一个。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('a.md', 'a.md#one'));
		places.settle({ ...jump('a.md', 'a.md#one'), st: { scroll: 12 } });

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'a.md#one'))]);
		expect(places.index).toBe(0);
	});

	it('不同行上的两个标题各自留着', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('a.md', 'outline:## Two'));
		places.settle({ ...jump('a.md', 'outline:## Two'), st: { scroll: 40 } });

		expect(paths(places)).toEqual([
			placeKey(jump('a.md', 'outline:## One')),
			placeKey(jump('a.md', 'outline:## Two')),
		]);
	});

	it('还没有落地的跳转不去动它 —— 没有坐标不等于有了行号', () => {
		// ……这也正是合并不放在 remember 里做的原因：在那儿，没有哪个 jump 有落点。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));

		expect(places.entries).toHaveLength(2);
	});

	it('跨文件绝不合并', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('b.md', 'outline:## One'));
		places.settle({ ...jump('b.md', 'outline:## One'), st: { scroll: 12 } });

		expect(paths(places)).toEqual([
			placeKey(jump('a.md', 'outline:## One')),
			placeKey(jump('b.md', 'outline:## One')),
		]);
	});
});

describe('NavPlaces —— 标题被记下来时带着的状态', () => {
	it('交到手上的状态原样保留，里面那几句引文也在', () => {
		// 那些字是和落点一起读到的（见 ephemeral.ts 的 readLandingState）；这份列表按 state
		// 到达时的样子收下它，而不是逐字段拼回去。
		const { places } = makePlaces();
		const st: NavEntryState = { scroll: 10, context: ['L9'] };
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st });

		expect((places.entries[0] as NavJump).st).toBe(st);
	});
});

describe('NavPlaces —— 调用方指定的目标是那篇笔记，不是一个标题', () => {
	// 已经打开的那篇笔记内部的一次搜索命中、或一次反向链接命中：core 把目标作为一个
	// ephemeral state 交过来，于是它不指名任何锚点、它的 key 是一个时间戳（见
	// nav/entry.ts 的 isCallerKey）。它那一行除了一个已经印在上一行的行号以外说不出别的，
	// 所以记下的是**那篇笔记** —— 这也正是另一文件里的命中本来就是的样子。
	it('记下命中落在哪篇笔记，一个标题也不记', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'caller:111'));
		places.settle({ ...jump('a.md', 'caller:111'), st: { scroll: 12 } });

		expect(paths(places)).toEqual(['a.md']);
	});

	it('一篇笔记里点了多少次搜索命中，都只占一行', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'caller:111'));
		places.remember(jump('a.md', 'caller:222'));
		places.remember(jump('a.md', 'caller:333'));

		expect(paths(places)).toEqual(['a.md']);
	});

	it('读者所在那篇挪到末尾，跟一次访问一样', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(jump('a.md', 'caller:111'));

		expect(paths(places)).toEqual(['b.md', 'a.md']);
	});

	it('指明了去处的跳转仍然照记', () => {
		// 这条规则管的是 KEY，不是 jump：一次大纲点击是一个地点。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'outline:## One'))]);
	});
});

describe('NavPlaces —— 块目标是那篇笔记，不是一个标题', () => {
	// `[[note#^id]]`：key 是链接文本，它携带的块 id 命名的是这么一处地方 —— 一行只能把它
	// 打印成某节里的一个行号，同一节里的两个看着一模一样，不悬停就分辨不出。所以记下的是
	// 那篇笔记。栈仍然留着这些步：回到一个块是一步真实的步。
	it('记下这个块所在的那篇笔记，一个标题也不记', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'a.md#^b1'));
		places.settle({ ...jump('a.md', 'a.md#^b1'), st: { scroll: 12 } });

		expect(paths(places)).toEqual(['a.md']);
	});

	it('光秃秃的 ^id 形式也照样读', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', '^b1'));

		expect(paths(places)).toEqual(['a.md']);
	});

	it('一篇笔记里点了多少个块，都只占一行', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'a.md#^b1'));
		places.remember(jump('a.md', 'a.md#^b2'));
		places.remember(jump('a.md', 'a.md#^b3'));

		expect(paths(places)).toEqual(['a.md']);
	});

	it('指向标题的链接仍然照记 —— 那是这一行叫得出名字的', () => {
		// 这条规则管的是**目标**，不是链接：一个标题命名的是一个节。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'a.md#one'));

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'a.md#one'))]);
	});
});

describe('NavPlaces —— 它自己的文件夹规则', () => {
	it('跳过读者排除的路径，以及 vault 自己的内部路径', () => {
		const { places } = makePlaces({ recentFilesExcludeFolders: ['私人', '归档/旧'] });
		places.remember(visit('笔记/a.md'));
		places.remember(visit('私人/b.md'));
		places.remember(visit('私人')); // the folder path itself
		places.remember(visit('归档/旧/c.md'));
		places.remember(visit('.trash/d.md'));
		places.remember(visit('.obsidian/workspace.json'));

		// 这条规则是**列表**自己的，刻意不是记录规则那边的那套文件夹
		// （见 PluginSettings.recentFilesExcludeFolders）。
		expect(paths(places)).toEqual(['笔记/a.md']);
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

		expect(paths(places)).toEqual(['日记/today.md', 'tiny.md']);
	});

	it('新近排除的文件夹里已经记下的地点要丢掉', () => {
		const settings = makeSettings();
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('私人/a.md'));
		places.remember(visit('公开/b.md'));
		places.markCurrent(visit('私人/a.md'));
		expect(places.index).toBe(0);

		settings.recentFilesExcludeFolders = ['私人'];
		expect(places.pruneExcluded()).toBe(1);
		expect(paths(places)).toEqual(['公开/b.md']);
		// 读者原先站着的那个地点没了：没有东西「在这里」
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
		expect(paths(places)).toEqual(['published/b.md', 'notes/c.md']);
	});

	it('新近排除的属性已经记下的地点要丢掉', () => {
		const app = makeAppWithFrontmatter({
			'看板/board.md': { 'kanban-plugin': 'basic' },
			'notes/a.md': { status: 'draft' },
		});
		const settings = makeSettings({ recentFilesLandings: 'last' });
		const places = new NavPlaces(app, settings);
		places.remember(visit('看板/board.md'));
		places.remember(jump('看板/board.md', 'outline:## T'));
		places.remember(visit('notes/a.md'));

		// **整行**都走 —— 那篇笔记以及它里面做出的每个 jump —— 和一个刚被排除的文件夹一样
		// （见 pruneExcluded）。
		settings.recentFilesExcludeProperties = ['kanban-plugin'];
		expect(places.pruneExcluded()).toBe(2);
		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('不读「恢复位置」功能自己那个逐文件标记', () => {
		// `position-restore: false` 回答的是这个文件要不要**记位置** —— 它对读者会不会去那儿
		// 一句话也不说。
		const app = makeAppWithFrontmatter({ 'notes/a.md': { 'position-restore': false } });
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, app);
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('frontmatter 还没解析的文件照样列出来', () => {
		// 元数据缓存是惰性填充的。凭猜测就扣下的地点，是读者拿不回来的地点；下一次访问会
		// 重新问一遍。
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, makeAppWithFrontmatter({}));
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('读者一条规则都没写时，一句也不去问 vault', () => {
		// 默认情形：没有规则，就不读元数据缓存。makeApp() 压根没有 metadataCache，所以这里
		// 去查一下就会抛。
		const { places } = makePlaces();
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});
});

describe('NavPlaces —— 上限', () => {
	it('丢掉最旧的地点，列表保持最近用过的在前', () => {
		const { places } = makePlaces({ recentFilesCap: 3 });
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.remember(visit(p));

		expect(paths(places)).toEqual(['b.md', 'c.md', 'd.md']);
	});

	it('读者正站着的那个地点绝不会丢', () => {
		const settings = makeSettings({ recentFilesCap: 3 });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));
		// 回到最旧的那个地点 —— 一次遍历，不访问任何新东西。
		places.markCurrent(visit('a.md'));

		// ……然后列表才不得不让出一行：上限在一个此后没再动过的读者底下压低了。
		settings.recentFilesCap = 2;
		places.applyCap();

		// 移除止于当前的索引：'a.md' 就是他们所在的那一行。
		expect(paths(places)).toEqual(['a.md', 'c.md']);
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
		expect(paths(places)).toEqual(['c.md']);
	});

	it('手工填坏的上限把它夹回合法范围，而不是干脆取消上限', () => {
		const { places } = makePlaces({ recentFilesCap: 'abc' as unknown as number });
		expect(places.cap()).toBe(DEFAULT_SETTINGS.recentFilesCap);
		expect(makePlaces({ recentFilesCap: 0 }).places.cap()).toBe(1);
	});

	// 上限数的是**行**，而行就是读者**被展示**的东西：在 'last' 下，一篇笔记无论持有多少
	// 落点都是一行，所以一个落点永远不能让一个文件丢掉它在列表上的位置 —— 这正是两个上限
	// 分开数数的全部理由（见 NavPlaces.trim）。
	it('一篇笔记无论有多少个标题都只算一行', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		// 三篇笔记，只放得下两行：走掉的那一篇把它的落点一起带走，因为**行**才是被丢掉的东西
		// （见 forget）。
		expect(paths(places)).toEqual(['b.md', 'c.md']);
	});

	it('读者正站着的那一行连同它的标题一个也不丢', () => {
		const settings = makeSettings({ recentFilesCap: 3 });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));
		// 回到最旧的那一行：那篇笔记**和**它里面的落点，就是上限必须跨过去的那一行。
		places.markCurrent(visit('a.md'));

		settings.recentFilesCap = 2;
		places.applyCap();

		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'c.md']);
		expect(places.index).toBe(0);
	});

	// ……而落点有它们自己的上限，数字相同，好让它们所处的那个列表即使一个都不成行也保持
	// 有界。
	it('标题有它们自己的上限，超了丢最旧的那个', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		for (const key of ['h1', 'h2', 'h3', 'h4'])
			places.remember(jump('a.md', key));

		// 笔记那一行从来不成问题 —— 它自始至终就是一行 —— 但只有最新的两个落点留住，而走掉的
		// 是**落点**，不是它所在的那篇笔记。
		expect(paths(places)).toEqual(['a.md', 'a.md#h3', 'a.md#h4']);
	});

	// 最顶那一档把每个落点都**画**成一行，但它不改变上限数的是什么：一篇笔记仍是一行，所以
	// 多出来的行不会让读者少一篇笔记 —— 这正是让他们设的数字在每一档都含义相同的东西
	// （见 NavPlaces.trim）。
	it('每个标题都画成一行，但不占上限的名额', () => {
		const { places } = makePlaces({ recentFilesCap: 3, recentFilesLandings: 'all' });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		// 三篇笔记，上限是三，落点全算上：读者看到的比那个数字长 —— 那一档只加这一条。
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'a.md#h2', 'b.md', 'c.md']);
		expect(places.rowCount()).toBe(3);
	});

	// ……于是在两档之间挪动从不重新裁剪：上限从来数的就不是那个变了的东西。
	it('读者在两个停靠点之间挪动时不重新裁剪', () => {
		const settings = makeSettings({ recentFilesCap: 3, recentFilesLandings: 'last' });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		expect(places.rowCount()).toBe(3);
		settings.recentFilesLandings = 'all';
		expect(places.applyCap()).toBe(0);
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'a.md#h2', 'b.md', 'c.md']);
	});
});

// 落点设置**最底**那一档（见 LandingsMode）：它管的是**记不记**，且只管记录 —— 已经
// 记下的东西和任何别的地点一样，没有哪一档会删掉它。
describe('NavPlaces —— 记不记跳转', () => {
	// 出厂的默认档（见 LandingsMode），以及它为什么是最顶那一档：出厂的应当是这份列表
	// 能记录的全部，因为只有从这一档往下，其余两档才有可比较的东西可选 —— 一个从 'none'
	// 起步、后来才碰到这个设置的读者，在它下面会发现什么都没记。上面的 harness 把它调低，
	// 好让落点能被当成一个独立的东西来谈。
	it('默认记下跳转', () => {
		const places = new NavPlaces(makeApp(), makeSettings());
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));

		expect(paths(places)).toEqual(['a.md', 'a.md#h1']);
	});

	it('调到最低档时一个跳转也不记', () => {
		const { places } = makePlaces({ recentFilesLandings: 'none' });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));

		// 那篇笔记仍是一个地点；它里面那一处不是。
		expect(paths(places)).toEqual(['a.md']);
	});

	it('视图仍然照记 —— 它是个地点，不是笔记里的某一处', () => {
		const { places } = makePlaces({ recentFilesLandings: 'none' });
		places.remember(view('graph'));

		expect(paths(places)).toEqual(['view:graph']);
	});

	// 最底那一档让列表**停止记录**；它不回头删掉已经有的东西。一个落点在它所在的笔记被挤出
	// 时才走（见 NavPlaces.trim），不会更早 —— 这正是每一档都可逆的原因：一个试着「多细」
	// 又回来的读者，会发现他们的落点还在原处。
	it('选了最低档时，已经记下的标题留住', () => {
		const settings = makeSettings({ recentFilesLandings: 'last' });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(visit('b.md'));

		settings.recentFilesLandings = 'none';
		// 从这里起，一次访问只记下一个文件……
		places.remember(jump('b.md', 'h2'));
		places.remember(visit('c.md'));
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'b.md', 'c.md']);

		// ……而回来时能找到它原先那个落点，不是一篇空笔记。
		settings.recentFilesLandings = 'all';
		expect(places.entries.filter(e => e.kind === 'jump')).toHaveLength(1);
	});
});

describe('NavPlaces —— 当前地点', () => {
	it('标记出读者正站在它那次访问上的那个文件', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.markCurrent(visit('a.md'));

		expect(places.index).toBe(0);
	});

	it('普通访问和跳转都跟得上，这两种都不广播「在这里」', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		expect(places.index).toBe(1);

		// ……而一个 jump 站在**落点**上，不在笔记上 —— 面板那个圆点画的正是这个差别。
		places.remember(jump('b.md', 'outline:## T'));
		expect(places.index).toBe(2);
	});

	it('推断出来的步标记的是那个文件，它本身不是一个地点', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));

		places.markCurrent(teleport('a.md', 900));

		expect(places.index).toBe(0);
	});

	it('跳转没有自己的地点时退回文件', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));

		places.markCurrent(jump('a.md', 'outline:## Gone'));

		expect(places.index).toBe(0);
	});

	it('绝不为正在读的那篇凭空造一个地点 —— 「在这里」不算一个地点', () => {
		// 启动时恢复的工作区，会经由一条什么都没记录过的路径打开它的文件。那种情况下列表
		// **真的**保持空：「你在这里」在读者去某处之前没有任何东西可站 —— 列表不会把正在坐着
		// 的那篇笔记放回它自己身上，也没有任何东西能把一个地点补进来（见下面 forget）。
		const { places } = makePlaces();
		places.markCurrent(visit('restored.md'));

		expect(paths(places)).toEqual([]);
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces —— 前进后退按记录所说的走', () => {
	it('没有自己标题的文件地点，照普通方式打开', async () => {
		const { places, calls } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));

		await places.travel(0);

		// FILE 地点不带位置，所以什么都不注入：由位置数据库决定 —— 和在文件浏览器里点同一个
		// 文件一模一样。这正是让两个入口行为一致的东西。
		expect(calls).toEqual(['file:a.md@leaf-1']);
	});

	it('跳转地点落到它记录下来的那一处上', async () => {
		const { places, calls } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));

		await places.travel(1);

		// placeKey 会把标题里的井号规范掉（见 placeKey）：前往时报告的是身份，而记录留着
		// 可读的形式。
		expect(calls).toEqual([`jump:${placeKey(jump('a.md', 'outline:## T'))}`]);
		expect((places.entries[1] as NavJump).key).toBe('outline:## T');
	});

	it('视图地点是重新激活', async () => {
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

describe('NavPlaces —— 忘掉一个文件', () => {
	it('丢掉这条文件记录，以及在它里面做过的每个跳转', () => {
		// 读者说「我不想在这儿看到这篇笔记」指的是那个**文件**：一篇笔记一行是列表自己的形状
		// （见 list.ts），所以一次把落点留在原处的移除，会把那一行也一起留下。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(visit('b.md'));

		places.forget('a.md');

		expect(paths(places)).toEqual(['b.md']);
	});

	it('其它文件和无路径视图照旧站得住', () => {
		// 视图没有路径，所以没有路径能指名它：这次移除针对的是一个 FILE，而图谱不是
		// （见 places.ts 的 forget）。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(view('graph'));
		places.remember(jump('b.md', 'outline:## T'));

		places.forget('a.md');

		// 经由 placeKey 命名而不是写字面量：这里钉住的是哪些地点**活了下来**，而 key 是这个
		// store 自己给地点命名的方式（见 placeKey）。
		expect(paths(places)).toEqual([
			placeKey(view('graph')),
			placeKey(jump('b.md', 'outline:## T')),
		]);
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

		// 如上一节，经由 placeKey 命名而不是写字面量：这里钉住的是哪些地点**活了下来**。
		expect(paths(places)).toEqual(['a.md', placeKey(view('thino-memo'))]);
	});

	it('通知面板，好让读者眼看着那些行消失', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forget('a.md');

		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('忘掉的正好是正在读的那个地点时，不再站在任何地方', () => {
		// 「此处」是列表里的一个索引：一个没了的地点绝不能留下一个索引，否则下一篇到来的笔记
		// 会被指名成读者所在之处。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.markCurrent(visit('a.md'));
		expect(places.index).toBe(0);

		places.forget('a.md');

		expect(places.entries).toEqual([]);
		expect(places.index).toBe(-1);
	});

	it('忘掉的是别的文件时，仍站在原来的地点上', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(visit('b.md'));
		places.markCurrent(visit('b.md'));
		expect(places.index).toBe(1);

		places.forget('a.md');

		// 索引是**按身份**重新找回来的，不是靠算术（见 dropPlaces）：滑下一格的那个地点还是
		// 同一个地点。
		expect(paths(places)).toEqual(['b.md']);
		expect(places.index).toBe(0);
	});

	it('列表从来没收过的路径，一句话也不说', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forget('nowhere.md');

		expect(paths(places)).toEqual(['a.md']);
		expect(seen).not.toHaveBeenCalled();
	});
});

describe('NavPlaces —— 忘掉一个标题', () => {
	// **落点**自己那一行上的 ×（见 list.ts 的 onForgetLanding）：走掉的是一个点，而上面
	// 笔记那一行留着 —— 这两个动作现在落在两行不同的行上，于是谁都不必靠手势来分辨。
	it('只丢这一处，留下这篇笔记以及它别的位置', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(visit('b.md'));

		places.forgetLanding([placeKey(jump('a.md', 'outline:## One'))]);

		// 经由 placeKey 命名而不是写字面量：这里钉住的是哪些地点**活了下来**，而 key 是这个
		// store 自己给地点命名的方式。
		expect(paths(places)).toEqual([
			'a.md',
			placeKey(jump('a.md', 'outline:## Two')),
			'b.md',
		]);
	});

	it('把一行所代表的每个地点都丢掉，让这一行回不来', () => {
		// 一行就是**一行**，面板把落在它上面的每个地点都收拢到它身上 —— 一次大纲点击到达的
		// 标题和一次链接到达的标题，对读者来说是一行（见 list.ts 的 landingKeys）。一次只指名
		// 其中一个的移除，会在那一行刚被拿掉的瞬间把另一个留下、又把这行画回来，那就是一个什么
		// 都不做的 ×。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'a.md#one'));
		places.remember(visit('b.md'));

		places.forgetLanding([
			placeKey(jump('a.md', 'outline:## One')),
			placeKey(jump('a.md', 'a.md#one')),
		]);

		expect(paths(places)).toEqual(['b.md']);
	});

	it('通知面板，好让读者眼看着这一行消失', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forgetLanding([placeKey(jump('a.md', 'outline:## One'))]);

		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('列表从来没收过的那些键，一句话也不说', () => {
		// 这些 key 来自一个可能比 store 慢一拍的面板（一个拿着快照的对话框），所以一个已经没了
		// 的地点不是一项要报告的变化。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forgetLanding([placeKey(jump('a.md', 'outline:## Gone'))]);

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'outline:## One'))]);
		expect(seen).not.toHaveBeenCalled();
	});

	it('忘掉的正好是正在读的那一处时，不再站在任何地方', () => {
		// 「此处」是列表里的一个索引：一个没了的地点绝不能留下一个索引，否则下一篇到来的笔记
		// 会被指名成读者所在之处。
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.markCurrent(jump('a.md', 'outline:## One'));
		expect(places.index).toBe(0);

		places.forgetLanding([placeKey(jump('a.md', 'outline:## One'))]);

		expect(places.entries).toEqual([]);
		expect(places.index).toBe(-1);
	});
});

describe('NavPlaces —— 簿记', () => {
	it('给每个指名过被改名文件的地点换键', () => {
		const { places } = makePlaces();
		places.remember(visit('old.md'));
		places.remember(jump('old.md', 'outline:## T'));
		places.remember(visit('other.md'));

		places.renameFile('old.md', 'new.md');

		// jump 自己的 key 是一个标题，不是路径：它在改名中留存下来，而身份是按路径重算的
		// （见 placeKey）。
		expect(places.entries.map(e => e.kind === 'view' ? '' : e.path))
			.toEqual(['new.md', 'new.md', 'other.md']);
		expect((places.entries[1] as NavJump).key).toBe('outline:## T');
	});

	it('丢掉被删掉的文件，以及在它里面做过的每个跳转', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));
		places.remember(visit('b.md'));

		places.deleteFile('a.md');

		expect(paths(places)).toEqual(['b.md']);
	});

	it('报出它持有的每个路径，交给启动时那一轮清扫', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('b.md', 'outline:## T'));
		places.remember(view('graph'));

		expect(places.knownPaths().sort()).toEqual(['a.md', 'b.md']);
	});
});

// 一个**钉**是读者对某一行的亲口答复：它被挡在上限之外、规则之外、裁剪之外，并随着它
// 所指名的那一行一起离开。
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
		expect(paths(places)).toEqual(['b.md', 'd.md', 'e.md']);
	});

	it('钉住的行，它自己的标题也不计入标题的上限', () => {
		const { places } = makePlaces({ recentFilesCap: 1 });
		places.remember(visit('a.md'));
		places.pin('a.md');
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));

		expect(places.applyCap()).toBe(0);
		expect(places.entries.filter(e => e.kind === 'jump')).toHaveLength(2);
	});

	it('后来加的规则本该排除它时，钉住的行仍然留住', () => {
		const settings = makeSettings();
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('notes/a.md'));
		places.remember(visit('b.md'));
		places.pin('notes/a.md');

		settings.recentFilesExcludeFolders = ['notes'];

		expect(places.pruneExcluded()).toBe(0);
		expect(paths(places)).toEqual(['notes/a.md', 'b.md']);
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
	it('丢掉列表自己记住的每个地点，置顶区留下', () => {
		// 清空留下的，正是读者亲手写下的东西：上限与规则本来就饶过钉住的行（见
		// pruneExcluded），而清空列表是列表**自己**做的又一件事。
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.remember(view('graph'));
		places.pin('b.md');

		places.clear();

		expect(paths(places)).toEqual(['b.md']);
	});

	it('钉住的行，它自己的标题也留下 —— 那是它自己的', () => {
		// 置顶区画的是笔记，从不画它里面的某一处（见 list.ts 的 printsLandings）—— 但那一行
		// 仍然**打开**最新的那一处，而一次清空没有理由违背读者钉下时的承诺。
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.pin('a.md');

		places.clear();

		expect(paths(places)).toEqual(['a.md', placeKey(jump('a.md', 'outline:## One'))]);
	});

	it('清掉的正好是正在读的那个地点时，不再站在任何地方', () => {
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

		expect(paths(places)).toEqual(['a.md']);
		expect(seen).not.toHaveBeenCalled();
	});
});

describe('NavPlaces —— 落盘与读回', () => {
	it('按 vault 各自存取一轮，数据不丢', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));
		places.persist();

		const restored = new NavPlaces(makeApp(), makeSettings());
		expect(restored.entries.map(e => e.kind)).toEqual(['visit', 'jump']);
		expect((restored.entries[1] as NavJump).key).toBe('outline:## T');
		expect(paths(restored)).toEqual(paths(places));
	});

	it('别的格式版本写的那一坨直接丢掉', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: RECENT_PLACES_VERSION + 1,
			places: [visit('a.md')],
		}));

		expect(new NavPlaces(makeApp(), makeSettings()).entries).toEqual([]);
	});

	it('带着推断步的一坨拒绝接收 —— 它从来不算地点', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: RECENT_PLACES_VERSION,
			places: [visit('a.md'), teleport('a.md', 5), { kind: 'nonsense' }],
		}));

		expect(paths(new NavPlaces(makeApp(), makeSettings()))).toEqual(['a.md']);
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
// 底下动过。这信号从前来自栈（见 nav-history/stack.ts）—— 现在面板画的是地点，所以得由
// 地点列表来说这件事。
describe('NavPlaces —— 变更通知', () => {
	it('订阅者能收到地点的变更，退订之后就收不到', () => {
		const { places } = makePlaces();
		const seen = vi.fn();
		const off = places.subscribe(seen);

		places.remember(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);

		// 面板关了：此后记下的地点绝不能被画进一个已经被拆掉的身体里。
		off();
		places.remember(visit('b.md'));
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it('当前地点换了才通知订阅者，没换就不通知', () => {
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
		places.remember(visit('c.md')); // the trim drops 'z.md'
		expect(seen).toHaveBeenCalledTimes(3);

		places.deleteFile('b.md');
		expect(seen).toHaveBeenCalledTimes(4);
		places.deleteFile('b.md');
		expect(seen).toHaveBeenCalledTimes(4);

		// 被规则过滤掉的路径从来不是一个地点，所以它也从来不是新闻。
		places.remember(visit('.trash/x.md'));
		expect(seen).toHaveBeenCalledTimes(4);
	});
});

describe('NavPlaces.reland —— 把一个标题放回它现在站着的位置', () => {
	// 行号是带着答案来的：这个 store 自己不留 vault，它写下的东西就是面板在某个 vault 里
	// 找到的。
	const landing = (line: number, mtime: number): NavJump => ({
		...jump('a.md', 'outline:## T'), keyLine: line,
		st: { scroll: line, anchor: 'a line', context: ['below it'], mtime },
	});
	const there = (places: NavPlaces) => places.entries[0] as NavJump;

	it('只改地址，这个地点的其它一概不动', () => {
		const { places } = makePlaces();
		places.remember(landing(4, 100));
		const aged = there(places).t;
		places.reland([{ key: placeKey(there(places)), line: 14, mtime: 500 }]);

		expect(there(places).keyLine).toBe(14);
		expect(there(places).st?.mtime).toBe(500);
		// 那些**字**留住：它们只读过一次，再读一遍不会让它们更真 —— 反而会丢掉读者离开时带着
		// 的那些。
		expect(there(places).st?.anchor).toBe('a line');
		expect(there(places).st?.context).toEqual(['below it']);
		// 既不是一次访问，也不是一次重记：一行按它本来就有的那个采集戳变旧。
		expect(there(places).t).toBe(aged);
	});

	it('不通知任何人，只把自己写了下去', () => {
		// 什么都不广播，因为没有**别的**东西需要知道：这些行所属的那些行，正是即将被画出来的
		// 那些行，而且是由发问的那个面板画的。但一个地点能活好几个月，所以答案立刻写进存储。
		const { places } = makePlaces();
		places.remember(landing(4, 100));
		const seen = vi.fn();
		places.subscribe(seen);

		places.reland([{ key: placeKey(there(places)), line: 14, mtime: 500 }]);
		expect(seen).not.toHaveBeenCalled();
		expect(window.localStorage.getItem(STORAGE_KEY)).toContain('"keyLine":14');
	});

	it('行本来就站在那里时什么都不写', () => {
		// 每一次都是紧接着的下一次绘制：一条带着笔记自己时钟的记录，是面板手里最便宜的答案，
		// 于是没有东西再问一遍。这正是让写这些记录的那一趟不至于变成死循环的东西。
		const { places } = makePlaces();
		places.remember(landing(4, 100));
		places.reland([{ key: placeKey(there(places)), line: 4, mtime: 100 }]);
		const wrote = places.persist = vi.fn();

		places.reland([{ key: placeKey(there(places)), line: 4, mtime: 100 }]);
		expect(wrote).not.toHaveBeenCalled();
	});

	it('答不出任何行号时，这个地点原样不动', () => {
		// 那一趟从未提到过的条目保留**一切**，包括它旧的时钟 —— 这正是让它那一行继续说着
		// 「找不到这一处」的东西。
		const { places } = makePlaces();
		places.remember(landing(4, 100));
		const st = there(places).st;
		places.reland([{ key: 'a.md#outline:## Gone', line: 9, mtime: 500 }]);
		expect(there(places).keyLine).toBe(4);
		expect(there(places).st).toBe(st);
		// ……而一个没人读得出的时钟，会让那条记录什么都不说，而不是声称做过一次从未做过的检查。
		places.reland([{ key: placeKey(there(places)), line: 9 }]);
		expect(there(places).keyLine).toBe(9);
		expect(there(places).st?.mtime).toBe(100);
	});
});
