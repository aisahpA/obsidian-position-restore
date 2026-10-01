// Tests for the RECENT FILES list (recent-files/places.ts + places-store.ts): the
// store the panel draws and travels through, and which the stack feeds.
//
// What is being pinned here is the separation the feature is built on: a place is
// not a stack step. A place list never truncates, dedupes by place instead of by
// step, drops inferred moves (teleports) entirely, keeps no position for a FILE
// (the position database owns "where I left this file"), and keeps its own for a
// JUMP (the one spot nothing else records).

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

// A vault whose notes carry frontmatter: the list's own property rule reads the
// metadata cache (see shared/frontmatter.ts), and that is the only part of the
// app it asks — everything else is still the bare stub above. A path absent from
// `props` answers like a file the cache has not parsed yet.
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

// The open pipeline, in miniature: what a travel asked for, and the order.
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

// The harness picks the MIDDLE stop of the landings setting, against the
// shipped default of 'none' (see LandingsMode): most of this file is about what
// a LANDING is, and the bottom stop would refuse every one of them before the
// assertion was reached. The default itself is held by one test of its own
// below rather than by every other test in the file.
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

		// One record per file — a file opened ten times is one row — and the array IS
		// the MRU order (the panel reads an index as a clock, see list.ts's activeRep).
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
		// The sampler's heuristic is not a place the reader chose, and it was the
		// reason the list needed a second eviction tier (see places.ts).
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(teleport('a.md', 500));

		expect(paths(places)).toEqual(['a.md']);
	});

	it('文件地点可以不带位置，跳转地点要带位置', () => {
		const { places } = makePlaces();
		places.remember({ ...visit('a.md'), st: { scroll: 120 } } as NavVisit);
		places.remember({ ...jump('a.md', 'outline:## T'), st: { scroll: 7 } } as NavJump);

		// The FILE place keeps no position of its own: the position database owns
		// "where I left this file", and a second copy here would make the panel's line
		// and the plain open disagree.
		const file = places.entries.find(e => e.kind === 'visit') as NavVisit;
		expect(file.st).toBeUndefined();
		// …while a jump's landing exists nowhere else, and its row promises it.
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
		// The rendered form and the authoritative source form are ONE place, not two:
		// identity normalizes the hashes away (see placeKey).
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
		// The label is not part of a place's IDENTITY — that is the view type (see
		// placeKey), and two Thino tabs are one destination. It is what the row
		// PRINTS, and it is taken from the recording each time: a view that renamed
		// itself is named by what it says now (see places.ts's placeRecord).
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

		// One place, re-named — not two.
		expect(places.entries).toHaveLength(1);
		expect(labelAt(0)).toBe('Memos');
	});

	it('视图保留它自己的状态和图标，每次访问都刷新一遍', () => {
		// What a place is REBUILT with when its own tab is gone: the state the view
		// had while the reader was in it, plus the mark its row wears. Both come off
		// the recording, like the label above — and the state is the one thing about a
		// view that cannot be derived later (see NavView.state), so a visit whose read
		// came back EMPTY keeps the snapshot already recorded instead of erasing it:
		// one failed read must not cost the reader the place they left.
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

		// A later visit re-read both.
		places.remember(thino({ filter: 'week' }, 'calendar'));
		expect(places.entries).toHaveLength(1); // still one place: the type is the identity
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBe('calendar');

		// A visit whose state read came back empty (the view threw, answered with
		// nothing, or went over the ceiling — see shared/leaf.ts's viewState) keeps
		// what is there; a view that names no icon simply drops it, and the row falls
		// back to the word (see list.ts's fileRow).
		places.remember(thino());
		expect(stateAt(0)).toEqual({ filter: 'week' });
		expect(iconAt(0)).toBeUndefined();
	});

	it('视图地点就地落地：它的状态，以及随之而来的时间戳', () => {
		// The funnel's `onLanded` for a view — the stack re-read the view's state as the
		// reader left it (see stack.ts's refreshTopLeafOnActivation), and this list has to
		// hear about it because a ROW is what the reader clicks. Nothing MOVES: the place
		// keeps its own position in the list and only the facts about it are refreshed,
		// so a reader travelling down the panel never sees rows shuffle under the pointer.
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
		// Nothing to refresh: the reader removed the row, or the ceiling trimmed it.
		const { places } = makePlaces();
		places.remember(visit('a.md'));

		places.settle({ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1', state: { filter: 'week' } });

		expect(paths(places)).toEqual(['a.md']);
	});
});

describe('NavPlaces —— 一个标题一条记录', () => {
	// A jump is recorded before its landing settles, so the merge is made at the settle —
	// the first moment two jumps can be told apart. What it covers is two keys naming ONE
	// spot: an outline click and a link, both naming one heading.
	it('停在同一行的两个跳转合并成一个', () => {
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st: { scroll: 12 } });
		places.remember(jump('a.md', 'a.md#one'));
		places.settle({ ...jump('a.md', 'a.md#one'), st: { scroll: 12 } });

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'a.md#one'))]);
	});

	it('留最新的那一个 —— 也就是这一行本来就是照它画的那个', () => {
		// The panel draws a line from its newest step (see groupByFile), so the record
		// that survives is the one the reader was already clicking.
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
		// …and this is also why the merge is not made in remember, where no jump has one.
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
		// The words were read WITH the landing (see ephemeral.ts's readLandingState); this list takes
		// the state as it arrives, rather than reassembling it field by field.
		const { places } = makePlaces();
		const st: NavEntryState = { scroll: 10, context: ['L9'] };
		places.remember(jump('a.md', 'outline:## One'));
		places.settle({ ...jump('a.md', 'outline:## One'), st });

		expect((places.entries[0] as NavJump).st).toBe(st);
	});
});

describe('NavPlaces —— 调用方指定的目标是那篇笔记，不是一个标题', () => {
	// A search match, or a backlink hit, inside the note already open: core hands the target
	// over as an ephemeral state, so it names no anchor and its key is a timestamp (see
	// nav/entry.ts's isCallerKey). Its row could say nothing but a line number already on the
	// row above, so it is the NOTE that gets recorded — which is what a hit in another file
	// already was.
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
		// The rule is about the KEY, not about jumps: an outline click is a place.
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'outline:## One'))]);
	});
});

describe('NavPlaces —— 块目标是那篇笔记，不是一个标题', () => {
	// `[[note#^id]]`: the key is the linktext, and the block id it carries names a spot a row
	// could only print as a line number inside a section — two of them in the same section look
	// alike, and neither can be told apart without hovering. So it is the note that gets
	// recorded. The stack still keeps these steps: going back to a block is a real step.
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
		// The rule is about the TARGET, not about links: a heading names a section.
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

		// The rule is the LIST's own, deliberately not the recording rules' folders
		// (see PluginSettings.recentFilesExcludeFolders).
		expect(paths(places)).toEqual(['笔记/a.md']);
	});

	it('完全不去问「该不该记位置」那一套规则', () => {
		// A short file, a file with a frontmatter marker, a folder excluded from
		// POSITION recording: all of them are still files the reader navigates to.
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
		// the place the reader was standing in is gone: nothing is "here"
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

		// A name on its own keeps out every file carrying it (`kanban-plugin`);
		// a name with a value only the file whose value equals it (`publish: true`,
		// so the still-unpublished b.md is listed). The entry form is the one the
		// position rules already speak (see shared/frontmatter.ts).
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

		// The whole ROW goes — the note and each jump made inside it — as it does
		// for a folder that was just excluded (see pruneExcluded).
		settings.recentFilesExcludeProperties = ['kanban-plugin'];
		expect(places.pruneExcluded()).toBe(2);
		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('不读「恢复位置」功能自己那个逐文件标记', () => {
		// `position-restore: false` answers whether a POSITION is recorded for
		// this file — it says nothing about whether the reader goes there.
		const app = makeAppWithFrontmatter({ 'notes/a.md': { 'position-restore': false } });
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, app);
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('frontmatter 还没解析的文件照样列出来', () => {
		// The metadata cache fills lazily. A place withheld on a guess is a place
		// the reader cannot get back; the next visit asks again.
		const { places } = makePlaces({ recentFilesExcludeProperties: ['status'] }, makeAppWithFrontmatter({}));
		places.remember(visit('notes/a.md'));

		expect(paths(places)).toEqual(['notes/a.md']);
	});

	it('读者一条规则都没写时，一句也不去问 vault', () => {
		// The default: no rule, no metadata-cache read. makeApp() has no
		// metadataCache at all, so a lookup here would throw.
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
		// Back to the oldest place — a traversal, which visits nothing new.
		places.markCurrent(visit('a.md'));

		// …and THEN the list has to give a row up: the ceiling came down
		// under a reader who has not moved since.
		settings.recentFilesCap = 2;
		places.applyCap();

		// Removal stops at the current index: 'a.md' is the row they are on.
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

	// WHAT THE CEILING COUNTS is rows, and a row is what the reader is SHOWN:
	// under 'last' a note is one row however many landings it holds, so a
	// landing can never cost a file its place on the list — which is the whole
	// reason the two ceilings are counted apart (see NavPlaces.trim).
	it('一篇笔记无论有多少个标题都只算一行', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		// Three notes, room for two: the one that goes takes its landings with
		// it, because a ROW is the thing being dropped (see forget).
		expect(paths(places)).toEqual(['b.md', 'c.md']);
	});

	it('读者正站着的那一行连同它的标题一个也不丢', () => {
		const settings = makeSettings({ recentFilesCap: 3 });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));
		// Back to the oldest row: the note AND the landing inside it are the
		// row the ceiling has to step over.
		places.markCurrent(visit('a.md'));

		settings.recentFilesCap = 2;
		places.applyCap();

		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'c.md']);
		expect(places.index).toBe(0);
	});

	// …and the landings have a ceiling of their own, the same number, so the
	// list they live in stays bounded even where none of them is a row.
	it('标题有它们自己的上限，超了丢最旧的那个', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		places.remember(visit('a.md'));
		for (const key of ['h1', 'h2', 'h3', 'h4'])
			places.remember(jump('a.md', key));

		// The note's row is never in question — it is one row all along — but
		// only the two newest landings are kept, and it is the LANDING that
		// goes rather than the note it stands in.
		expect(paths(places)).toEqual(['a.md', 'a.md#h3', 'a.md#h4']);
	});

	// The top stop DRAWS every landing as a row, but it does not change what
	// the ceiling counts: a note is still one row, so the extra lines cost the
	// reader no note — which is what keeps the number they set meaning the same
	// thing at every stop (see NavPlaces.trim).
	it('每个标题都画成一行，但不占上限的名额', () => {
		const { places } = makePlaces({ recentFilesCap: 3, recentFilesLandings: 'all' });
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(jump('a.md', 'h2'));
		places.remember(visit('b.md'));
		places.remember(visit('c.md'));

		// Three notes in a ceiling of three, landings and all: what the reader
		// sees runs longer than the number — the one clause that stop adds.
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'a.md#h2', 'b.md', 'c.md']);
		expect(places.rowCount()).toBe(3);
	});

	// …and so moving between the stops never re-trims: the ceiling was never
	// counting the thing that changed.
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

// The BOTTOM stop of the landings setting (see LandingsMode): it answers
// RECORDING, and recording only — what is already recorded is a place like any
// other and no stop deletes it.
describe('NavPlaces —— 记不记跳转', () => {
	// The shipped default (see LandingsMode), and why it is the TOP stop: what
	// ships is the whole of what the list can record, because it is the only
	// stop from which the two below it can be chosen with anything to choose
	// between — a reader who started at 'none' and only later came upon the
	// setting would find nothing recorded under it. The harness above turns it
	// down so that landings can be talked about as a separate thing.
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

		// The note is still a place; the spot inside it is not.
		expect(paths(places)).toEqual(['a.md']);
	});

	it('视图仍然照记 —— 它是个地点，不是笔记里的某一处', () => {
		const { places } = makePlaces({ recentFilesLandings: 'none' });
		places.remember(view('graph'));

		expect(paths(places)).toEqual(['view:graph']);
	});

	// The bottom stop stops the list RECORDING; it does not reach back and
	// delete what it already has. A landing goes when the note it stands in is
	// crowded out (see NavPlaces.trim), and not before — which is what makes
	// every stop reversible: a reader trying "how finely" out and coming back
	// finds their landings where they were.
	it('选了最低档时，已经记下的标题留住', () => {
		const settings = makeSettings({ recentFilesLandings: 'last' });
		const places = new NavPlaces(makeApp(), settings);
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'h1'));
		places.remember(visit('b.md'));

		settings.recentFilesLandings = 'none';
		// From here on a file is all that is recorded of a visit…
		places.remember(jump('b.md', 'h2'));
		places.remember(visit('c.md'));
		expect(paths(places)).toEqual(['a.md', 'a.md#h1', 'b.md', 'c.md']);

		// …and coming back down finds the landing it had, not an empty note.
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

		// …and a jump stands on the LANDING, not on the note — that is the
		// difference the panel's dot is drawn for.
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
		// A workspace restored at startup opens its file through a path nothing
		// recorded. The list stays TRULY empty in that case: "you are here" has nothing
		// to stand on until the reader goes somewhere — the list does not put the note
		// being sat in back on itself, and nothing fills a place in (see forget below).
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

		// A FILE place carries no position, so nothing is injected: the position
		// database decides — exactly as clicking the same file in the file explorer
		// does. This is what keeps the two entry points from behaving differently.
		expect(calls).toEqual(['file:a.md@leaf-1']);
	});

	it('跳转地点落到它记录下来的那一处上', async () => {
		const { places, calls } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## T'));

		await places.travel(1);

		// placeKey normalizes the heading's hashes away (see placeKey): the identity
		// is what the travel reports, while the record keeps the readable form.
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
		// What a reader means by "I do not want to see this note here" is the FILE: one
		// row per note is the list's own shape (see list.ts), so a removal that left the
		// landings behind would leave the row behind with them.
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(visit('b.md'));

		places.forget('a.md');

		expect(paths(places)).toEqual(['b.md']);
	});

	it('其它文件和无路径视图照旧站得住', () => {
		// A view has no path, so no path names it: the removal is about a FILE, and the
		// graph is not one (see places.ts's forget).
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(view('graph'));
		places.remember(jump('b.md', 'outline:## T'));

		places.forget('a.md');

		// Named through placeKey rather than spelled out: what is pinned here is which
		// places SURVIVED, and a key is the store's own way of naming one (see placeKey).
		expect(paths(places)).toEqual([
			placeKey(view('graph')),
			placeKey(jump('b.md', 'outline:## T')),
		]);
	});

	it('无路径视图照样丢得掉 —— 虽然没有路径能指名它', () => {
		// A view is a ROW like any other, so it comes off the list like any other — and the
		// only thing that can name it is its own TYPE (see nav/entry.ts's navGroupKey).
		// The filter used to keep every pathless record unconditionally, which left the
		// graph a row the reader could see and never take away.
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(view('graph'));
		places.remember(view('thino-memo'));

		places.forget('view:graph');

		// Named through placeKey rather than spelled out, as above: what is pinned is which
		// places SURVIVED.
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
		// "Here" is an index into the list: a place that is gone must not leave one
		// behind, or the note that arrives next would be named as where the reader is.
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

		// The index is re-found by IDENTITY and not by arithmetic (see dropPlaces): the
		// place that slid down one slot is the same place.
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
	// The × on a LANDING's own row (see list.ts's onForgetLanding): what goes is one
	// spot, and the note's row above stays — the two acts are on two different rows
	// now, so neither has to be told apart by a gesture.
	it('只丢这一处，留下这篇笔记以及它别的位置', () => {
		const { places } = makePlaces();
		places.remember(visit('a.md'));
		places.remember(jump('a.md', 'outline:## One'));
		places.remember(jump('a.md', 'outline:## Two'));
		places.remember(visit('b.md'));

		places.forgetLanding([placeKey(jump('a.md', 'outline:## One'))]);

		// Named through placeKey rather than spelled out: what is pinned is which
		// places SURVIVED, and a key is the store's own way of naming one.
		expect(paths(places)).toEqual([
			'a.md',
			placeKey(jump('a.md', 'outline:## Two')),
			'b.md',
		]);
	});

	it('把一行所代表的每个地点都丢掉，让这一行回不来', () => {
		// A row is a LINE, and the panel collapses onto it every place that landed
		// there — a heading reached by an outline click and by a link are one row to
		// the reader (see list.ts's landingKeys). A removal that named one of them
		// would leave the other to draw the row again the moment it was taken off,
		// which is a × that does nothing.
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
		// The keys arrive from a panel that may be a click behind the store (a dialog
		// holding a snapshot), so a place already gone is not a change to report.
		const { places } = makePlaces();
		places.remember(jump('a.md', 'outline:## One'));
		const seen = vi.fn();
		places.subscribe(seen);

		places.forgetLanding([placeKey(jump('a.md', 'outline:## Gone'))]);

		expect(paths(places)).toEqual([placeKey(jump('a.md', 'outline:## One'))]);
		expect(seen).not.toHaveBeenCalled();
	});

	it('忘掉的正好是正在读的那一处时，不再站在任何地方', () => {
		// "Here" is an index into the list: a place that is gone must not leave one
		// behind, or the note that arrives next would be named as where the reader is.
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

		// The jump's own key is a heading, not a path: it survives the rename, and the
		// identity is recomputed from the path (see placeKey).
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

// A PIN is the reader's own answer about a row: it is kept out of the ceiling,
// out of the rules and out of the trim, and it leaves with the row it names.
describe('NavPlaces —— 把一行钉到顶部', () => {
	it('新钉的行放在置顶区末尾，同一行不会钉两次', () => {
		// A pin arriving at the top would push down the rows the reader had
		// already arranged; the block is a shelf they are filling, not a stack.
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
		// "Move to the front" hands over more steps than the block is long, and
		// what it means is the end: counting them is the CALLER's arithmetic
		// about a shape it does not own (see NavPlaces.movePinned).
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.remember(visit(p));
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md'])
			places.pin(p);
		expect(places.pinned).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);

		places.movePinned('c.md', -2);
		expect(places.pinned).toEqual(['c.md', 'a.md', 'b.md', 'd.md']);
		// More steps than there is block: the row lands ON the end it asked for.
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

	// THE CEILING counts the rows the reader did NOT name: a pin is kept on top of
	// the number and not out of it, so pinning a note costs them none of the fifty.
	it('钉住的行算在上限之外，而不是占上限里面的名额', () => {
		const { places } = makePlaces({ recentFilesCap: 2 });
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.pin('b.md');

		for (const p of ['d.md', 'e.md'])
			places.remember(visit(p));

		// The unnamed rows are c, d, e — one over, and the oldest of them goes.
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
		// What a clear leaves is what the reader wrote down by hand: the ceiling and
		// the rules already spare a pin (see pruneExcluded), and emptying the list is
		// one more thing the list does BY ITSELF.
		const { places } = makePlaces();
		for (const p of ['a.md', 'b.md', 'c.md'])
			places.remember(visit(p));
		places.remember(view('graph'));
		places.pin('b.md');

		places.clear();

		expect(paths(places)).toEqual(['b.md']);
	});

	it('钉住的行，它自己的标题也留下 —— 那是它自己的', () => {
		// The pinned block draws the note and never a spot inside it (see list.ts's
		// printsLandings) — but the row still OPENS the newest one, and a clear is no
		// reason to break the promise the reader pinned.
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
		// For the reason a pin is written down at once: a clear is a rare, deliberate
		// act, and a quit a few seconds later would otherwise put the whole list back.
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
		// A clear of a list that is already what a clear leaves behind changes
		// nothing, and a change that did not happen owes no redraw and no write.
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

// The signal a RESIDENT panel lives on (see NavPlaces.subscribe): the dialog is
// opened, read and closed inside one render and needs none of this, but a sidebar
// panel is on screen for hours and has no other way to learn that the list moved
// under it. It used to come from the stack (see nav-history/stack.ts) — the panel draws
// places now, so the place list is what has to say so.
describe('NavPlaces —— 变更通知', () => {
	it('订阅者能收到地点的变更，退订之后就收不到', () => {
		const { places } = makePlaces();
		const seen = vi.fn();
		const off = places.subscribe(seen);

		places.remember(visit('a.md'));
		expect(seen).toHaveBeenCalledTimes(1);

		// The panel was closed: a place recorded afterwards must not be drawn into a
		// body that has already been torn down.
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
		// Already standing there: nothing on screen moved.
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

		// A filtered path is never a place, so it is never news either.
		places.remember(visit('.trash/x.md'));
		expect(seen).toHaveBeenCalledTimes(4);
	});
});

describe('NavPlaces.reland —— 把一个标题放回它现在站着的位置', () => {
	// The line arrives already answered: the store keeps no vault of its own, and what
	// it writes is what the panel found in one.
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
		// The WORDS stay: they were read once, and reading them again would not make
		// them truer — it would lose the ones the reader left with.
		expect(there(places).st?.anchor).toBe('a line');
		expect(there(places).st?.context).toEqual(['below it']);
		// Neither a visit nor a re-recording: a row ages by the stamp it already had.
		expect(there(places).t).toBe(aged);
	});

	it('不通知任何人，只把自己写了下去', () => {
		// Nothing is broadcast because nothing ELSE needs to know: the rows these lines
		// belong to are the rows about to be drawn, and by the panel that asked. A place
		// lives for months, though, so the answer goes to storage at once.
		const { places } = makePlaces();
		places.remember(landing(4, 100));
		const seen = vi.fn();
		places.subscribe(seen);

		places.reland([{ key: placeKey(there(places)), line: 14, mtime: 500 }]);
		expect(seen).not.toHaveBeenCalled();
		expect(window.localStorage.getItem(STORAGE_KEY)).toContain('"keyLine":14');
	});

	it('行本来就站在那里时什么都不写', () => {
		// The very next draw, every time: a record carrying the note's own clock is the
		// cheapest answer the panel has, so nothing asks again. Which is what stops the
		// pass that writes these from being a loop.
		const { places } = makePlaces();
		places.remember(landing(4, 100));
		places.reland([{ key: placeKey(there(places)), line: 4, mtime: 100 }]);
		const wrote = places.persist = vi.fn();

		places.reland([{ key: placeKey(there(places)), line: 4, mtime: 100 }]);
		expect(wrote).not.toHaveBeenCalled();
	});

	it('答不出任何行号时，这个地点原样不动', () => {
		// An entry the pass never mentioned keeps EVERYTHING, its old clock included —
		// which is exactly what lets its row go on saying it cannot find the spot.
		const { places } = makePlaces();
		places.remember(landing(4, 100));
		const st = there(places).st;
		places.reland([{ key: 'a.md#outline:## Gone', line: 9, mtime: 500 }]);
		expect(there(places).keyLine).toBe(4);
		expect(there(places).st).toBe(st);
		// …and a clock nobody could read leaves the record saying nothing rather than
		// claiming a check that was never made.
		places.reland([{ key: placeKey(there(places)), line: 9 }]);
		expect(there(places).keyLine).toBe(9);
		expect(there(places).st?.mtime).toBe(100);
	});
});
