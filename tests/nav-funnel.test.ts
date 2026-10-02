// Tests for the RECORDING FUNNEL (nav/funnel.ts) — the neutral layer that holds
// what a navigation WAS and publishes it to whoever keeps it.
//
// This suite is what the funnel's extraction bought: a funnel plus a spy sink
// is the whole fixture, with no stack and no workspace behind them, because a
// capture point's job is to write the right RECORDING and the funnel's is to
// deliver it. Whether a recording is worth KEEPING is the readers' business.
//  - the shared gate: the startup window (layout not ready) and the traversal
//    bracket (runBracketed, watchdog included) publish nothing;
//  - what each capture point publishes — recordOpen (a keyless visit, a keyed
//    jump, a pathless view), recordTeleport, recordActivation (a tab switch is
//    a leave of the old tab plus a visit of the new one — or, for a view tab of
//    any type but the empty tab, a place of its own);
//  - the two kinds of position read: `leave` (where the reader was) versus
//    `settled` (where the jump landed) — ungated, and told apart so that a
//    place list can take only the second;
//  - the broadcasts: `visit` bypasses the gate on purpose, `landing`/`here`
//    reach every listener, a listener implements only the hooks it wants, and
//    unsubscribing stops delivery;
//  - the sampler's teleport capture, a capture point writing to this funnel.

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

// A funnel with a spy sink. Every hook records what it heard, so a test can ask
// what was published without any reader standing behind it.
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
		// The startup rebuild opens every restored tab through the same patched
		// setViewState an ordinary open uses; none of it is a navigation.
		const app = makeApp();
		const { funnel, visits } = makeFunnel(app);
		(app.workspace as { layoutReady: boolean }).layoutReady = false;

		funnel.recordOpen('a.md', 'leaf-1');
		funnel.recordTeleport('a.md', 'leaf-1', 300);
		funnel.recordActivation(leafWithFile('leaf-2', 'b.md'));

		expect(visits).toEqual([]);
	});

	it('插件自己在挪的那次移动什么都不发布，并在之后放开闸门', async () => {
		// A traversal's own opens ARE the traversal, not new jumps; the bracket
		// says so for exactly as long as it is up.
		const { funnel, visits } = makeFunnel();
		expect(funnel.isMoving()).toBe(false);

		await funnel.runBracketed(async () => {
			expect(funnel.isMoving()).toBe(true);
			funnel.recordOpen('a.md', 'leaf-1');
		});

		expect(visits).toEqual([]);
		expect(funnel.isMoving()).toBe(false);
		// …and recording is live again once the bracket is down.
		funnel.recordOpen('a.md', 'leaf-1');
		expect(visits).toHaveLength(1);
	});

	it('已经有一个 bracket 开着时第二个会被拒绝；卡住的那个由看门狗放开', async () => {
		// An open that never resolves (loadIfDeferred can hang) must not leave the
		// gate up forever, or back/forward would be dead for the rest of the
		// session.
		vi.useFakeTimers();
		try {
			const { funnel, visits } = makeFunnel();
			void funnel.runBracketed(() => new Promise<void>(() => undefined)); // never settles
			expect(funnel.isMoving()).toBe(true);

			// A command pressed inside the bracket must not start a second one.
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
		// The two are separate facts on purpose: only the leave knows where the
		// reader was, and it is readable only at this moment (focusing another tab
		// fires no setViewState).
		const { funnel, visits, leaves } = makeFunnel();
		const next = leafWithFile('leaf-2', 'b.md');

		funnel.recordActivation(next);

		expect(leaves).toEqual([{ cause: 'tab', leaf: next }]);
		expect(visits).toEqual([
			{ record: { kind: 'visit', path: 'b.md', leafId: 'leaf-2' }, cause: 'tab' },
		]);
	});

	it('侧边栏拿到焦点这件事根本不算导航', () => {
		// A panel tracks the active file in its own view state; recording one would
		// make a phantom step out of the panel itself.
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
		// The list used to hold 'graph' and nothing else. A reader who went to Thino
		// therefore kept the FILE THEY CAME FROM as the newest place on their list —
		// an unrelated note standing in for where they actually were (see
		// nav/entry.ts's NON_DESTINATION_VIEW_TYPES).
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', { label: 'Thino' }));

		expect(visits).toEqual([{
			record: { kind: 'view', leafId: 'leaf-t', viewType: 'thino_view', label: 'Thino' },
			cause: 'tab',
		}]);
	});

	it('从没给自己起过名的视图不记 label：面板自己有说法', () => {
		// Not an empty string and not the view type either: the recording says only
		// what it knows, and what a row prints for it is the browser's call (see
		// recent-files/browser/model.ts's viewName).
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-g', 'graph'));

		expect(visits).toEqual([{
			record: { kind: 'view', leafId: 'leaf-g', viewType: 'graph' },
			cause: 'tab',
		}]);
	});

	it('空标签页是唯一不算地点的视图', () => {
		// What a main-area leaf shows with nothing in it: there is nothing behind it
		// to go back to, so nothing is published for it.
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-e', 'empty'));

		expect(visits).toEqual([]);
	});

	it('视图是空标签页的那个主区 leaf，仍然算一次离开', () => {
		// The tab being left keeps its position whatever is taking over — only the
		// half that would make a STEP out of the new view is skipped, and the empty
		// tab is the one view that is not a place.
		const { funnel, visits, leaves } = makeFunnel();
		const empty = leafWithFile('leaf-2'); // view type 'empty'

		funnel.recordActivation(empty);

		expect(visits).toEqual([]);
		expect(leaves).toHaveLength(1);
	});

	it('视图还没建起来就被恢复的标签页，就是它所代表的那篇笔记', () => {
		// Mobile comes back to the note it was last reading as a DEFERRED tab: a placeholder
		// that answers a view's questions off the state it was saved with, and is not a
		// FileView at all. Recorded as a view it would mint a place keyed `view:markdown`,
		// wearing the note's own name and the file icon, which no delete could ever clean up
		// — and whose row opens the note without its saved position.
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(deferredLeaf('leaf-2', { file: 'b.md', mode: 'source' }));

		expect(visits).toEqual([
			{ record: { kind: 'visit', path: 'b.md', leafId: 'leaf-2' }, cause: 'tab' },
		]);
	});

	it('存下的 state 没点名文件的延迟标签页，仍然是它所代替的那个视图', () => {
		// A pathless view restored this way keeps its place (the type is the one thing the
		// placeholder answers honestly) — dropping it would leave a reader standing in the
		// view with no step behind them.
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(deferredLeaf('leaf-2', undefined, 'graph'));

		expect(visits).toEqual([
			{ record: { kind: 'view', leafId: 'leaf-2', viewType: 'graph' }, cause: 'tab' },
		]);
	});

	it('这个仓库已经造不出来的视图不算地点', () => {
		// A plugin switched off, uninstalled, or not loaded yet: restoring its tab raises a
		// placeholder pane that answers getViewType() with the type it stands in for. Recorded
		// as itself it takes the real place's OWN key and overwrites it, and nothing the reader
		// does later can return to it.
		const app = makeApp(undefined, ['thino_view']);
		const { funnel, visits } = makeFunnel(app);

		funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', { label: 'thino_view', icon: 'lucide-ghost' }));

		expect(visits).toEqual([]);
	});

	it('同一个视图，在还造得出它的仓库里照样被记录', () => {
		// The registry read is the ONLY thing that tells the two apart, and it must never
		// exclude by accident: a table this build does not expose keeps every view a place.
		const { funnel, visits } = makeFunnel(makeApp());

		funnel.recordActivation(viewLeaf('leaf-t', 'thino_view', { label: 'Thino' }));

		expect(visits).toHaveLength(1);
	});

	it('没能说清自己是 file view 的 markdown 标签页，不算一个视图地点', () => {
		// Same phantom as the two above, from the last door left: a markdown tab is always a
		// note, so a place keyed `view:markdown` can never be one the reader went to.
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(viewLeaf('leaf-2', 'markdown', { label: 'b', icon: 'file' }));

		expect(visits).toEqual([]);
	});

	it('文件已经不在了的 file view 不算自己的地点', () => {
		// A sync replaces a note by removing the file and renaming the download over
		// it (see position/path-bookkeeping.ts), and for that instant the tab still
		// showing the note is a FileView whose `file` is null. Recording it as a view
		// used to mint a phantom place — keyed `view:markdown`, wearing the note's own
		// name and the file view's icon, indistinguishable from a real row — that no
		// delete could ever clean up, because a view row has no file to go missing;
		// it sat in the list until the reader took it off by hand. A FileView is
		// either the visit it names or nothing at all: an instant is not a
		// destination. The tab it stands in is still a leave.
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
		// Outline, backlinks, the local graph and the properties panes extend FileView and turned
		// the app's own destination flag off: they show whatever note the reader is standing in.
		// The sidebar hides them (they are not main-area leaves), but "open in main" puts one in
		// the reader's way — and recorded as the file it points at, the list grows a second row
		// for a note they never went to.
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(followingLeaf('leaf-o', 'outline', 'b.md', { label: 'Outline' }));

		expect(visits).toEqual([
			{ record: { kind: 'view', leafId: 'leaf-o', viewType: 'outline', label: 'Outline' }, cause: 'tab' },
		]);
	});

	it('没有笔记可跟的面板视图仍然是它那个视图', () => {
		// Nothing changes about what it IS when the file it tracks is gone: the row with no note
		// behind it is no truer than the one above.
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(followingLeaf('leaf-o', 'backlink'));

		expect(visits).toEqual([
			{ record: { kind: 'view', leafId: 'leaf-o', viewType: 'backlink' }, cause: 'tab' },
		]);
	});

	it('丢了那个标记的 file view 就是它点名的那篇笔记', () => {
		// The flag is runtime-only, so a build that renames it reads undefined, and the test above
		// is then indistinguishable from the ordinary note below it: ONLY `false` may exclude, or
		// losing the field would take every file recording with it.
		const { funnel, visits } = makeFunnel();

		funnel.recordActivation(leafWithFile('leaf-2', 'b.md'));

		expect(visits).toEqual([
			{ record: { kind: 'visit', path: 'b.md', leafId: 'leaf-2' }, cause: 'tab' },
		]);
	});

	it('除名字之外，还记下视图自己报告的 state 与图标', () => {
		// All three are the view's own account of itself (see shared/leaf.ts), and all
		// three are read at the one moment they are readable. The state is what the
		// place gets REBUILT with if this tab is gone by the time the reader comes back
		// (see NavView.state); the icon is the mark its row wears.
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
		// getDisplayText / getIcon / getState are foreign methods called from a
		// workspace event handler: a view that throws in one of them must not take the
		// reader's own tab switch down with it, and the PLACE is worth more than any of
		// the three (see the guards in shared/leaf.ts).
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
		// The distinction is the whole reason a place list can take only the
		// second: a jump's row promises the jump's own spot, never wherever the
		// reader drifted to before leaving. Ungated because the capture points that
		// call them (the patch, the sampler) have already decided.
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
		// What the stack hands over when it travels to a place: inside its own
		// bracket the gate would (correctly) refuse everything.
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
		// The place list never implements onLeave: its rows promise where a jump
		// LANDED, not where the reader drifted.
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
		// The composition root wires this (see position/manager.ts); the funnel
		// itself only ever publishes.
		const { funnel, stack, places } = makeNav();

		funnel.recordOpen('a.md', 'leaf-1');

		expect(stack.entries.map(pathOf)).toEqual(['a.md']);
		expect(places.entries.map(pathOf)).toEqual(['a.md']);
	});

	it('闸门是共用的，所以一条栈被吩咐不留的记录仍然会到达地点列表', () => {
		// The stack's own gates (record tab switches / cursor jumps) are about ITS
		// list; the funnel publishes before any of them, which is exactly why the
		// two stores could be split apart.
		const { funnel, stack, places } = makeNav(makeApp(), { navHistoryRecordActivation: false });

		funnel.recordActivation(leafWithFile('leaf-2', 'b.md'));

		expect(stack.entries).toEqual([]);
		expect(places.entries.map(pathOf)).toEqual(['b.md']);
	});
});

// ===== Sampler: in-file teleport detection =====

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
	// The threshold is pinned: DEFAULT_SETTINGS ships 0 (inferred steps off), and
	// these tests are about the detector, not about the default.
	const fullSettings = { ...DEFAULT_SETTINGS, navHistoryTeleportMinLines: 10,
		...settings } as PluginSettings;
	const state = new PositionState(fullSettings);
	const leave = vi.fn();
	const recordTeleport = vi.fn();
	const store = new PositionStore(app as never, database as never);
	// The funnel the sampler writes to. The sampler is purely a CAPTURE point —
	// it never reads the stack — so a spy funnel is the whole of what it needs.
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
		// the entry being left got the poll's read — the harness seeds that
		// baseline by hand, so unlike a real poll read it carries no stamp
		expect(h.leave).toHaveBeenCalledWith('a.md', 'leaf-1', {
			scroll: 0,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
		});
	});

	it('记录规则从不拦导航：被排除的文件照样记录跳变，位置则不写', () => {
		const h = makeSamplerHarness({ excludedFolders: ['a.md'] });
		// Poll path: the db record is dropped, nothing written — rules
		// govern positions only.
		h.sampler.sampleActiveView();
		expect(h.database.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.database.setState).not.toHaveBeenCalled();
		// Event path: nav recording never consults exclusions.
		h.onSelection(h.view.editor); // baseline: line 60
		h.cursor.line = 3;
		h.onSelection(h.view.editor);
		expect(h.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 3, expect.anything());
	});

	it('手机上轮询不做任何推断：一次 57 行的光标移动写位置、但不压步', () => {
		// The poll is the only cursor sampler a touch device has, and it has
		// nothing worth inferring from: a swipe moves no cursor and a tap lands
		// within the screenful already on screen. So a mobile reader's
		// back/forward is about which FILE they came from — which is also the
		// part of it no scroll-back can replace.
		const origMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			const h = makeSamplerHarness(); // view cursor at 60, poll read at 3
			// The reader tapped the note: their touch is what makes the move
			// theirs rather than a re-render's.
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
