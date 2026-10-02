// Tests for the VSCode-style navigation stack (nav-history/stack.ts) and its
// integration points:
//  - stack logic: every jump pushes, a fresh jump truncates the forward part,
//    dedup drops repeated same-file jumps (key match), force wins;
//  - gates: the stack's own settings (record tab switches / record cursor
//    jumps) and the funnel's startup window (layout not ready);
//  - rename/delete bookkeeping keeps the index meaningful;
//  - persistence: localStorage round-trip per vault, corrupt degrades to
//    empty, out-of-range index clamps;
//  - navigate: pointer movement, same-file jump applies the entry position,
//    cross-tab traversal reactivates the original leaf and opens the file,
//    same-tab file switch delegates to the native per-tab history only when
//    its next entry matches (else openFile fallback);
//  - graph tab steps: activation records a pathless view entry, traversal
//    reactivates the graph/file leaf without any open;
//  - a travel asked for elsewhere (the modifier-held place open), and the landing
//    words a place carries, which a step does not keep;
//  - patcher historyNav injection: the saved position rides OVER the native
//    entry's cursor-only eState, marker consumed exactly once.
//
// The FUNNEL's own contract (the shared gates, what each capture point
// publishes, the broadcasts) and the sampler's teleport capture sit next door
// in nav-funnel.test.ts. Both suites share support/nav-recording-harness.ts.

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

// The settings panel mutates the settings object the stack was handed (they
// share one instance, see NavStack.settings) — this is that mutation, without
// going through the whole settings tab.
function setCap(nav: ReturnType<typeof makeNav>, cap: number): void {
	(nav.stack as unknown as { settings: PluginSettings }).settings.navHistoryCap = cap;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe('NavStack —— 前往一个这个仓库造不出来的视图', () => {
	// A plugin switched off, uninstalled, or not loaded yet leaves no factory for its type, and
	// the app answers a tab asking for it with a placeholder that claims to be that type (see
	// shared/leaf's viewTypeIsMissing). Nothing can be built behind it, so the place is dead and
	// every door to it has to say so — including the one the placeholder fools.
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

		// A teleport is its own kind: a keyed jump carrying the same
		// teleport key does NOT dedup against it.
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

		// Same line again (deduped): the original landing survives.
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42, { scroll: 9, cursor: { from: { line: 42, ch: 3 }, to: { line: 42, ch: 3 } } });
		expect(nav.stack.entries.length).toBe(1);
		expect(stOf(nav.stack.entries[0])).toBe(landing);

		// A gated call (traversal executing) pushes nothing and fills nothing.
	});

	it('refreshTop 绝不覆盖带 key 的落点，只给空的那个补上', () => {
		const nav = makeNav();
		const landing: NavEntryState = { scroll: 7, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42, landing);

		// The user drifted after landing; a leave must not touch the landing.
		const drifted: NavEntryState = { scroll: 99, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(nav.stack.entries[0])).toBe(landing);

		// Outline/anchor entries follow the same keyed rule: backfill when
		// empty (the settle-capture or the first leave), never overwrite. Found by key:
		// the drift off the teleport above is a step of its own by the time this pushes.
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo', force: true });
		const jump = nav.stack.entries.findIndex(e => keyOf(e) === 'outline:Foo');
		nav.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(nav.stack.entries[jump])).toBe(drifted);
		nav.funnel.leave('a.md', 'leaf-1', landing);
		expect(stOf(nav.stack.entries[jump])).toBe(drifted);

		// Legacy persisted entry without a landing: backfilled once.
		const legacy = makeNav();
		legacy.funnel.recordTeleport('a.md', 'leaf-1', 42);
		expect(stOf(legacy.stack.entries[0])).toBeUndefined();
		legacy.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(legacy.stack.entries[0])).toBe(drifted);

		// Keyless open entries still take every leave read.
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
		// They read on, then jump to another heading. The leave alone must change nothing —
		// the step keeps the landing it names — and the drift only becomes a step once the
		// jump carries them off it.
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 700 });
		expect(nav.stack.entries.length).toBe(1);
		expect(stOf(nav.stack.entries[0])).toEqual({ scroll: 500 });
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bar' });
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.entries[1].kind).toBe('visit');
		expect(stOf(nav.stack.entries[1])).toEqual({ scroll: 700 });
		expect(keyOf(nav.stack.entries[2])).toBe('outline:Bar');
		// Consumed, not copied: the step keeps its landing, so a later back reaches 700
		// (the step above) and then 500 (this one) instead of landing on 700 twice.
		expect((nav.stack.entries[0] as NavJump).leftAt).toBeUndefined();
		// A step, not a place: the list beside the stack keeps the jumps it was told about
		// and must not grow a row for the spot the reader was reading.
		expect(nav.places.entries.every((p) => p.kind === 'jump')).toBe(true);
	});

	it('漂移是相对视口量的，不是相对视口够不到的那个标题量的', () => {
		const nav = makeNav(makeApp([
			{ heading: 'Last Heading', level: 2, position: { start: { line: 505 } } },
		]));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Last Heading' });
		// A heading near the end of the note: the viewport stops short of it, so the step
		// NAMES line 505 while leaving the reader standing at 490.
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 490 });
		// The step does name that line — it is the mismatch the bug hung on.
		expect((nav.stack.entries[0] as NavJump).keyLine).toBe(505);
		// …and they read to the end. Measured against the heading's line this is no movement
		// at all; measured against where they were left standing, it is a screenful.
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
		// Inside the departure threshold (10 lines): they are still reading what the step
		// names, so the spot is not somewhere else and no step is made of it.
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 508 });
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bar' });
		expect(nav.stack.entries.length).toBe(2);
	});

	it('同一个标题再点一次，只要读者已经离开了它，就又是一步', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo' });
		nav.funnel.settled('a.md', 'leaf-1', { scroll: 500 });
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 700 });
		// Same key as the top step, which is what dedup reads — but the reader is 200 lines
		// below it, so the click is a real jump only because the departure is on the stack
		// first. Deduped, it would move them with nowhere to come back to.
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
		// Source mode: the settled cursor sits on the heading; the upgrade
		// itself draws from the CACHE (authoritative source + level + line),
		// the st view line only breaks same-text ties.
		const settle: NavEntryState = {
			scroll: 14,
			cursor: { from: { line: 20, ch: 0 }, to: { line: 20, ch: 3 } },
		};
		nav.funnel.leave('a.md', 'leaf-1', settle);
		expect(keyOf(nav.stack.entries[0])).toBe('outline:## **Bold** Title');
		expect((nav.stack.entries[0] as NavJump).keyLine).toBe(20);

		// Preview mode: the viewport line only breaks ties; line comes from
		// the cache.
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
		// [[a.md#^b1]] hands over `a.md#^b1`, and the `#` in it makes a scan that takes the
		// first `#` read it as a heading slug — no heading is named after a block id, so the
		// step kept no keyLine and every block step fell back to the text-snippet remap.
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
		// The user clicks the same outline item again: the new record carries
		// the rendered text, which normalizes equal to the upgraded source
		// key (# strips) — one jump, no duplicate entry.
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
		// The merged step keeps the open's identity.
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
		// The leave-refresh used to run for ANY newly focused pane and notified every
		// browser (refreshTop → changed) — and the resident panel rebuilt its rows
		// under the reader's press: clicking into the panel lost the click, so the
		// same row had to be clicked a second time. The refresh is for tab/pane
		// switches between FILE views (see refreshTopLeafOnActivation).
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

		// The entry was not re-stamped from the file view, and no step was added:
		// a sidebar taking the focus is not a tab/pane switch the list records.
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
		// A tab switch fires no setViewState, so nothing refreshes the entry
		// being left — the activation handler must do it, or the browser
		// shows that file as a bare type badge.
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
		// "abc" would make every `length > cap` comparison false and disable the
		// ceiling entirely; null would collapse it to 1.
		const nav = makeNav(makeApp(), { navHistoryCap: 'abc' as unknown as number });
		expect(nav.stack.stackCap()).toBe(DEFAULT_SETTINGS.navHistoryCap);
	});

	it('调低上限会当场裁剪，指针停在顶上', () => {
		const nav = makeNav();
		for (const p of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])
			nav.funnel.recordOpen(p, 'leaf-1');
		expect(nav.stack.entries.length).toBe(5);

		// The settings panel mutates the settings object the history holds.
		setCap(nav, 2);
		expect(nav.stack.applyStackCap()).toBe(3);

		expect(nav.stack.entries.map(pathOf)).toEqual(['d.md', 'e.md']);
		expect(nav.stack.index).toBe(1);
		// ...and nothing more is dropped on a second call.
		expect(nav.stack.applyStackCap()).toBe(0);
	});

	it('上限降到比当前深度还低时，指针停在最旧的那个幸存者上', () => {
		// An active file view, so canNavigate reports the STACK's reachability
		// rather than "nothing is focused".
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

		// The entry "now" was on is gone. The pointer has to land somewhere
		// valid: the oldest survivor, so forward still walks what is left
		// instead of traversal being disabled outright.
		expect(nav.stack.entries.map(pathOf)).toEqual(['d.md', 'e.md']);
		expect(nav.stack.index).toBe(0);
		expect(nav.stack.canNavigate(-1)).toBe(false);
		expect(nav.stack.canNavigate(1)).toBe(true);
	});

	it('存盘的栈超出上限时，读回当场裁剪', () => {
		// The cap is lowered (and persisted) while the stack blob still holds
		// the old, longer history: the ceiling must win from the first render.
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
		// The gate is read off the object the settings panel mutates (see setCap).
		(nav.stack as unknown as { settings: PluginSettings }).settings.navHistoryRecordActivation = false;

		nav.funnel.recordOpen('a.md', 'leaf-a');
		nav.funnel.recordOpen('b.md', 'leaf-b');
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf); // back to a.md's tab
		expect(nav.stack.entries.map(pathOf)).toEqual(['a.md', 'b.md']);

		// The graph can ONLY be entered by activating its leaf, so the gate must
		// not reach it: reading the cause alone would take the whole kind out of
		// the history, which is not what "record tab switches" says.
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.entries[2]).toEqual({ kind: 'view', leafId: 'leaf-g', viewType: 'graph', t: expect.any(Number) });
		expect(nav.stack.index).toBe(2);

		// That step is what keeps the stack honest about where the reader
		// stands: unrecorded, back from the graph landed on a.md and skipped
		// b.md, the note they had just left.
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
		// The stack truncates itself with `entries.length = index + 1`, and 2.5
		// would make that 3.5 — RangeError: Invalid array length, on the very
		// next push. Only a hand-edited or truncated blob can carry one.
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: NAV_HISTORY_VERSION,
			entries: [entry('a.md'), entry('b.md')],
			index: 1.5,
		}));
		const nav = makeNav();
		expect(nav.stack.index).toBe(1);
		// And this is where it would have thrown: the push truncates first.
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
		// The dedup must not be shared state: a second history (another vault in
		// the same page, or the next test) would otherwise assume the blob on
		// disk is its own and skip a write it owes.
		const setItem = vi.spyOn(Storage.prototype, 'setItem');
		// Counted per KEY: persist() now writes two blobs (the stack and the
		// recent-files list, see NavStack.persist), and the dedup under test is the
		// stack's.
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

// A cross-tab traversal fixture: leaf-2 is the entry's own (target) tab,
// leaf-1 holds the active file view. `targetLeafView` is what that tab shows
// now — { file: undefined } forces the open path, a MarkdownView showing the
// target file exercises the "tab already there" path.
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
			// Forward step b.md on the same leaf lands in openInLeaf →
			// leaf.openFile, stubbed to never resolve.
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

			// Bracket released: a new traversal is no longer blocked.
			expect(nav.stack.canNavigate(-1)).toBe(true);
			await nav.stack.navigate(-1);
			expect(nav.stack.index).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('同文件的后退把这一步的位置应用到视图上', async () => {
		// The leaf's view is the view itself — the shape the app has (a view carries
		// its own leaf back-reference), and the one execute() applies an in-file jump
		// to (see the same-file branch): a leaf holding a bare `{ file }` stub is a
		// shape the app never produces.
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
		// applied the target entry's position (cursor + quantized scroll)
		expect(applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		// the entry left behind was refreshed with the live read
		expect(stOf(nav.stack.entries[1])).toMatchObject({ scroll: 42 });
	});

	it('从一次跳转后退、再前进回到它，落在跳转上，不是落在漂移上', async () => {
		// They jumped to a heading and read on. Back/forward is this stack walking its own
		// steps, not the reader leaving: forward has to land on the heading the step names.
		// The drift becomes a step of its own only when a NAVIGATION carries them off it.
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
		// The heading, which is the one spot nothing else in the stack holds.
		await nav.stack.navigate(1);
		expect(nav.stack.index).toBe(1);
		expect(h.applied.at(-1)).toMatchObject({ scroll: 500 });
		// …and the drift the traversal read is gone: a step made of it would sit between
		// the reader and the heading forever.
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Bar' });
		expect(nav.stack.entries.map((e) => e.kind)).toEqual(['visit', 'jump', 'jump']);
		expect(keyOf(nav.stack.entries[1])).toBe('outline:Foo');
	});

	// The two travel paths of the recent-files list (see places.ts): a JUMP place
	// opens the file and lands on its recorded spot, and it branches from where the
	// reader is — so back returns to the origin. The place index a test travels to is
	// found by IDENTITY rather than hard-coded: teleports are not places, so the
	// list's indices do not line up with the stack's.
	const placeOf = (nav: ReturnType<typeof makeNav>, pred: (e: NavEntry) => boolean): number =>
		nav.places.entries.findIndex(pred);
	// A markdown leaf whose own view reports a position, plus the wiring that makes
	// it the active (or most recent) file view. Every case below is about what the
	// open pipeline does to that view.
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
		// Two distinct wall times: the travel's copy must be re-stamped (it is a new
		// navigation moment), not replay the recorded place's t.
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
		try {
			nav.funnel.recordOpen('a.md', 'leaf-1');
			nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## One' });
			nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## Two' });
			const at = placeOf(nav, e => e.kind === 'jump' && e.key === 'outline:## One');
			// The landing the jump settled on, as the store keeps it: no caret (see
			// readLandingState) and the heading's own line, which need not be the recorded scroll.
			(nav.places.entries[at] as NavJump).keyLine = 60;
			(nav.places.entries[at] as NavJump).st = { scroll: 5 };
			expect(nav.stack.index).toBe(2);

			nowSpy.mockReturnValue(2000);
			await nav.places.travel(at);
		} finally {
			nowSpy.mockRestore();
		}

		// the target is re-pushed on top of the current entry (branch semantics)
		expect(nav.stack.index).toBe(3);
		expect(nav.stack.entries.map(keyOf)).toEqual([
			undefined, 'outline:## One', 'outline:## Two', 'outline:## One',
		]);
		// the pushed entry is a copy — the original place keeps its own position
		expect(nav.stack.entries[3]).not.toBe(nav.stack.entries[1]);
		// ...and its own (fresh) timestamp
		expect(nav.stack.entries[1].t).toBe(1000);
		expect(nav.stack.entries[3].t).toBe(2000);
		// the same landing a travel to step or place applies: the note at its recorded
		// scroll, the caret at the head of the LINE the jump names (see landedLine).
		expect(h.applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		// the origin is the entry right below — back one step returns to it
		expect(nav.stack.canNavigate(-1)).toBe(true);
		expect(nav.stack.canNavigate(1)).toBe(false);

		await nav.stack.navigate(-1);
		expect(nav.stack.index).toBe(2);
		expect(h.applied[1]).toMatchObject({ scroll: 42 });
		// the landing cue is suppressed for the traversal (armed at the travel and
		// again at the same-file apply)
		const state = (nav.stack as unknown as { state: PositionState }).state;
		expect(state.cueSuppressUntil).toBeGreaterThan(Date.now());
	});

	it('笔记落到那行之后，标出跳转点名的那一行', async () => {
		// A jump NAMES a line, so the landing has to read like the app's own answer to
		// clicking that heading in the outline — and a recent-files heading row IS that
		// outline. Asked for at the travel and answered after the landing settled, so
		// what gets marked is the line as it stands now, not the one asked for.
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
		// Asked once and spent: a line left asked for belongs to no travel at all.
		expect(state.pendingLineFlash).toBeUndefined();
	});

	it('没有点名任何行的步，什么都不标', async () => {
		// A step records a READING POSITION, not a heading, so there is no line to mark
		// and the caret it recorded rides along untouched.
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
		// A second press on the row the reader is standing on must re-land that place,
		// not push a copy of it: the traversal top IS the place, and a duplicate step
		// would make the origin the new "previous" entry, so the next back bounced
		// straight forward again (A → B → A …), adding one entry per press.
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
		// A teleport whose post-jump read never arrived keeps only the line it aimed at
		// (`st` missing). It is not a place (see places.ts), but a traversal can still
		// reach it — and then it must take the reader to that line rather than nowhere.
		const h = fileLeafHarness(0, 0);
		(h.app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => h.view;

		const nav = makeNav(h.app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordTeleport('a.md', 'leaf-1', 60); // recorded with no landing read
		nav.funnel.recordOpen('b.md', 'leaf-1'); // step away, so leaving a.md does not fill it
		expect(stOf(nav.stack.entries[1])).toBeUndefined();

		await nav.stack.navigate(-1);

		// the line the entry itself recorded is the landing the traversal applies
		expect(h.applied[0]).toMatchObject({ scroll: 60 });
	});

	it('地点自己没记下落点时，应用存盘的那条记录', async () => {
		// Such a place draws its line from the file's saved record (see
		// describeNavEntry), so travelling to it applies that record: without it the
		// row named a line and the click applied nothing at all.
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

		// the record the row borrowed its line from is the landing the travel applies
		expect(h.applied[0]).toMatchObject({ scroll: 41 });
	});

	it('侧边栏拿着焦点时，同文件的跳转照样应用', async () => {
		// With the resident recent-files panel focused there is NO active file view —
		// the workspace's active view is the sidebar, not a FileView — while the file
		// tab behind it still shows the note. The entry's OWN leaf is what the jump
		// applies to and what the origin is captured from; the workspace's active view
		// would answer neither.
		const h = fileLeafHarness(90, 90);
		// getActiveViewOfType stays null (makeApp's default): the sidebar is active.
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

		// …the older place of the note already on screen is applied
		expect(h.applied[0]).toMatchObject({ scroll: 41 });
		// …and the origin was captured from the entry's OWN leaf before the travel, so
		// "back" returns to where the reader actually was (see
		// refreshTopFromActiveView): with a sidebar focused there is no active file view
		// to read it from.
		const branch = nav.stack.entries.findIndex((e, i) => i > origin && keyOf(e) === 'outline:## One');
		expect(branch).toBeGreaterThan(0);
		expect(stOf(nav.stack.entries[branch - 1])).toMatchObject({ scroll: 90 });
	});

	it('跳转地点的落点取自落定，绝不取自离开', () => {
		// The stack backfills a keyed entry with the reader's LEAVE so a later back
		// returns somewhere. That read is not the jump's own spot, and a place's row
		// PROMISES the spot it prints — so a reader who clicked a heading, read on and
		// then switched files must not find that heading's recorded place moved to
		// wherever they happened to drift to.
		const settled = makeNav();
		settled.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## H' });
		const a = settled.places.entries.findIndex(e => e.kind === 'jump');
		settled.funnel.settled('a.md', 'leaf-1', { scroll: 152 });
		expect(stOf(settled.places.entries[a])).toEqual({ scroll: 152 });

		const left = makeNav();
		left.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## H' });
		const b = left.places.entries.findIndex(e => e.kind === 'jump');
		left.funnel.leave('a.md', 'leaf-1', { scroll: 900 });
		// the stack kept the drift (back needs a position) …
		expect(stOf(left.stack.entries[left.stack.index])).toEqual({ scroll: 900 });
		// …and the place kept none: its row falls back to the file's own record
		// rather than freezing the drift as the heading's spot.
		expect(stOf(left.places.entries[b])).toBeUndefined();

		// A landing that arrives AFTER that backfill still wins, and the place hears of it
		// then: a jump the reader left before it settled is not a jump with no landing.
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
		// openInLeaf must arm the same flag delegateNative arms: the
		// setViewState patch then injects the per-file record over the plain
		// open and bypasses the glide choice (history traversals land
		// instantly; a raw glide here swept blank through unrendered content).
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
			// the landing cue is suppressed for the traversal's restore
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

			// The entry's OWN position rides along to the open pipeline (the
			// file record is only the fallback), so the line the browser row
			// shows is the line the open is told to land on.
			expect(state.pendingHistoryNav).toBe(true);
			expect(state.pendingHistoryNavState).toMatchObject({ scroll: 42 });

			// ...and the safety timeout drops the landing WITH the flag: a
			// command that never reached setViewState must not leak it onto a
			// later unrelated open.
			vi.advanceTimersByTime(1000);
			expect(state.pendingHistoryNav).toBe(false);
			expect(state.pendingHistoryNavState).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('跨文件的落点经由它的标题做结构性重锚', async () => {
		// The heading moved 40 -> 100 (+60) after the entry was recorded. The
		// injected open has no target editor to run the text-snippet remap
		// against, so the structural shift is the only edit correction it can
		// get — and it must be applied BEFORE the landing is handed over.
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
		// The tab was left at L7 when the user switched away, but the entry
		// (and the browser row) promise L42 — so the traversal re-positions
		// the live tab instead of only activating it where it happens to be.
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

// ===== NavStack.navigate from sidebar focus =====

// A sidebar (file explorer, search, outline…) holds focus: getActiveViewOfType
// is null until the traversal's setActiveLeaf reactivates a file tab — the
// mock switches the "active view" exactly like the real workspace would.
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
	// A leaf that is TOLD to show a view shows it: the app builds the view it was
	// asked for, and the open pipeline checks afterwards that it arrived (see
	// stack.ts's showViewInNewTab). A leaf that already shows something keeps it —
	// those are the SWAP cases, and they assert the call, not the leaf's contents.
	const setViewState = vi.fn(function (this: HarnessLeaf, vs: { type: string }) {
		if (!this.view)
			this.view = { getViewType: () => vs.type };
		return Promise.resolve();
	});
	const detach = vi.fn();
	const applied: unknown[] = [];
	const viewsByLeaf: Record<string, unknown> = {};
	const leaves: HarnessLeaf[] = opts.leaves.map((spec) => {
		// The file tabs of the MAIN area: isMainAreaLeaf asks the workspace root
		// whether it holds the leaf's element, and makeApp's root holds 'main' (see
		// isMainAreaLeaf) — a leaf without one would read as a sidebar and be skipped
		// by the activation refresh.
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
			// A non-file view tab. It reports its type and its OWN state, which is what
			// the activation refresh re-reads on the way out (see stack.ts's
			// refreshTopLeafOnActivation).
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
	// What the view branch of the open pipeline asks of the workspace: every leaf
	// SHOWING this view type, read off the leaf as it stands now (a leaf that has been
	// told to show a view has it from that moment on — see setViewState above).
	ws.getLeavesOfType = (viewType: string) => leaves.filter(
		(l) => (l.view as { getViewType?: () => string } | undefined)?.getViewType?.() === viewType,
	);
	// A BRAND-NEW leaf, as workspace.getLeaf hands one over for a target the reader
	// asked for elsewhere (a tab, a split, a window) — or for a view whose own tab is
	// gone. One object, so a test can ask whether the open landed HERE (the `openFile`
	// mock is shared, and its `this` is the answer).
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

// ===== NavStack: view-tab steps =====

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
		// The stack is not the list (see nav-history/stack.ts): its steps are
		// traversed, never drawn, so it keeps the label only because it persists the
		// entry whole — and a view tab of any type is a place this plugin moved to.
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
		// The case this exists for: a local graph follows the active file, so its
		// tab keeps drawing a different neighbourhood while the reader is away —
		// activating it answers with the view's default behaviour rather than the
		// place the step names.
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
		// A view entry's leafId is never written back (see execute), so once the
		// place comes back in a NEW tab the step names a tab that is gone. The
		// snapshot still has to keep up with the PLACE, or a traversal would go on
		// replaying the state from before the rebuild.
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

		// Leaving the graph (activating the note) is when the step's state is read.
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect((nav.stack.entries[1] as NavView).state).toEqual({ file: 'y.md' });
	});

	it('离开一个视图会重读它的名字，不只是它的 state', () => {
		// The built-in browser is the case: its tab header is the page TITLE
		// (Obsidian's WebviewerView answers getDisplayText with this.title), so the
		// name a view gives changes while the reader sits in it. The step and the
		// row standing for that place have to end up called what they last read.
		const spec = { label: 'Page one', icon: 'globe-2', state: { url: 'https://one.example/' } };
		const viewer = viewLeaf('leaf-w', 'webviewer', spec);
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-a', file: 'a.md', markdown: true }] });
		h.leaves.push(viewer as never);
		const nav = h.nav;

		nav.funnel.recordActivation(viewer);
		expect(nav.stack.entries[0]).toMatchObject({ label: 'Page one' });
		expect(nav.places.entries.find(p => p.kind === 'view')).toMatchObject({ label: 'Page one' });

		// The reader browses on, then switches to a note: leaving is the last moment
		// either of them can be asked.
		spec.label = 'Page two';
		spec.state = { url: 'https://two.example/' };
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect(nav.stack.entries[0]).toMatchObject({
			kind: 'view', label: 'Page two', state: { url: 'https://two.example/' },
		});
		expect(nav.places.entries.find(p => p.kind === 'view')).toMatchObject({ label: 'Page two' });
	});

	it('同一 leaf 里文件把关系图谱挤掉之后，前进会把图谱重新立起来', async () => {
		// graph:open tab reuse / a graph node click: the file open swapped the
		// graph out of its own leaf, so the graph entry shares the leaf id.
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
		// file → graph (one leaf, swapped) → node click opened the file again
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen(undefined, 'leaf-1', { viewType: 'graph' });
		nav.funnel.recordOpen('a.md', 'leaf-1');

		await nav.stack.navigate(-1); // back to the graph step

		expect(app.commands.executeCommandById).toHaveBeenCalledWith('app:go-back');
		expect(leaf.setViewState).not.toHaveBeenCalled();
		expect(leaf.openFile).not.toHaveBeenCalled();
	});

	it('leaf 已经没了的视图建在新标签页里，绝不盖在正读着的文件上', async () => {
		// The reader's own case: they went to Thino, closed every tab, opened other
		// notes, and then clicked the entry from back then. The place outlives the tab
		// it was recorded in, so the view is CONSTRUCTED — and never in the tab the
		// reader is reading, which is the one thing a pathless entry must not be taken
		// to mean (with `state: {}`, the same thing Obsidian's own `graph:open` asks
		// for).
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
		// The same question asked from the recent-files list rather than a traversal:
		// the row was written when the reader was in Thino, Thino's tab is long gone, and
		// the row still has to take them there (see places.ts's travel).
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordActivation(viewLeaf('leaf-t1', 'thino_view', { label: 'Thino' }));
		const at = nav.places.entries.findIndex(e => e.kind === 'view');

		await nav.places.travel(at);

		expect(h.setViewState).toHaveBeenCalledWith({ type: 'thino_view', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('已经有别的标签页在显示这个视图时，由它来应答这个地点', async () => {
		// Two Thino tabs are ONE place (see places.ts's placeKey), and the entry names
		// whichever of them was activated last. Closing that one leaves the place
		// standing in the tab the reader still has, so nothing is built: the entry was
		// a name for "Thino", not a handle on one particular tab.
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
		// A panel showing the same view is not where the reader went — it is not
		// recorded for the same reason (see isMainAreaLeaf). So it does not stand in
		// for the place either: the entry means a tab of its own.
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		h.leaves.push(viewLeaf('leaf-side', 'thino_view', { containerEl: 'sidebar' }) as never);
		const nav = h.nav;
		nav.funnel.recordActivation(viewLeaf('leaf-t1', 'thino_view')); // since closed
		const at = nav.places.entries.findIndex(e => e.kind === 'view');

		await nav.places.travel(at);

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
	});

	it('视图标签页按这个视图当初的 state 重建，而不是用它的默认值', async () => {
		// The reader's own case, one step past the tab being gone: they were in Thino
		// with a filter set, closed every tab, and came back days later. The place is
		// rebuilt by TYPE, and the state recorded while they were there is what it is
		// rebuilt WITH — the whole of the difference between "the view" and "the place
		// they went to" (see nav/entry's NavView.state).
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
		// The state a place is rebuilt with has to be the state the reader LEFT it in,
		// and the moment of leaving is the last one it is readable in (see stack.ts's
		// refreshTopLeafOnActivation). Both lists hear the same refresh — the stack
		// through onLanded, the place list through settle — so a view STEP and a view
		// PLACE cannot disagree about where the reader was.
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

		// The reader works in the view: the filter moves on. Then they switch away.
		(h.leaves[1].view as { getState: () => unknown }).getState = () => ({ filter: 'week' });
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect(nav.stack.entries.find(e => e.kind === 'view')).toMatchObject({ state: { filter: 'week' } });
		expect(nav.places.entries.find(e => e.kind === 'view')).toMatchObject({ state: { filter: 'week' } });
	});

	it('标签页已经不再显示这个视图时，不去重读它的 state', async () => {
		// A graph node click opens the file OVER the graph in the same tab, so the
		// entry's leaf can be alive and showing something else: what is readable from it
		// then is the NOTE's state, and writing that onto the view place would trade a
		// real snapshot for a wrong one (see the guard in refreshTopLeafOnActivation).
		const h = makeSidebarHarness({
			leaves: [
				{ id: 'leaf-1', file: 'a.md', markdown: true },
				{ id: 'leaf-t', viewType: 'thino_view', state: { filter: 'today' } },
			],
		});
		const nav = h.nav;
		nav.funnel.recordActivation(h.leaves[1] as unknown as WorkspaceLeaf);
		// The tab was swapped to a note in the meantime.
		(h.leaves[1].view as { getViewType: () => string }).getViewType = () => 'markdown';
		(h.leaves[1].view as { getState: () => unknown }).getState = () => ({ elsewhere: true });
		nav.funnel.recordActivation(h.leaves[0] as unknown as WorkspaceLeaf);

		expect(nav.stack.entries.find(e => e.kind === 'view')).toMatchObject({ state: { filter: 'today' } });
	});

	it('延迟 leaf 的 state 不去重读', async () => {
		// A background tab that has been unloaded cannot be asked anything: the view
		// behind the DeferredView is not there, so an "empty" answer read off it must not
		// be allowed to erase the snapshot (see refreshTopLeafOnActivation).
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
		// The plugin behind the view is disabled or gone: the type is asked for and
		// never arrives (the app answers with the empty page). The tab is closed again
		// rather than left standing on a place this vault no longer has — the click
		// doing nothing being the honest outcome there, and what it always used to do.
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

// A travel the reader asked to happen SOMEWHERE ELSE — the modifier-click, the
// middle button, the keyboard's Cmd/Ctrl+Enter (see PaneTarget / list.ts). It is a
// different question from every other branch of the open pipeline, which exists to go
// BACK to a place: here the place's own tab must not move.
describe('NavStack —— 要去别处的一次前往', () => {
	// The arming flag the setViewState patch consumes: the landing a traversal injects
	// over the native entry's cursor-only state (see armHistoryNav).
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

		// The app's own answer decides the leaf (see Keymap.isModEvent): the plugin only
		// passes it on.
		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		// …and the open landed in THAT leaf, not in the tab the entry came from.
		expect(h.openFile.mock.contexts[0]).toBe(h.newLeaf);
		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.newLeaf, { focus: true });
		// The landing is not part of the difference: this is the same injection a plain
		// travel arms, so the same note opened one tab over lands in the same spot —
		// scroll and the caret that spot puts on the line (see landingOf).
		expect(armed(h.nav).pendingHistoryNav).toBe(true);
		expect(armed(h.nav).pendingHistoryNavState).toEqual({
			scroll: 30, cursor: { from: { line: 30, ch: 0 }, to: { line: 30, ch: 0 } },
		});
		expect(armed(h.nav).pendingHistoryNavPath).toBe('b.md');
	});

	it('在新 leaf 里打开一个文件地点，什么也不注入', async () => {
		// A file place carries no position of its own (see places.ts): the position
		// database decides where it lands, in a new tab exactly as in the old one.
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });

		await h.nav.stack.openFilePlain('b.md', 'leaf-1', 'tab');

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		expect(h.openFile.mock.contexts[0]).toBe(h.newLeaf);
		expect(armed(h.nav).pendingHistoryNav).toBe(false);
	});

	it('在新 leaf 里显示一个无路径视图，而不是打开文件', async () => {
		// The graph has no file to open: the leaf has to be told to show it, and
		// `active` is what brings it to the front.
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });

		await h.nav.stack.openViewPlace({ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 1 }, 'tab');

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		expect(h.setViewState).toHaveBeenCalledWith({ type: 'graph', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});
});

// A place carries the words its landing was recorded among — the recent-files list's quote, the
// thing its search box matches. A step is restored by POSITION, so it leaves them behind at the one
// place it is written (see nav-history/store.ts).
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
		// The step in memory is the state it travelled with: the words are dropped at the WRITE, not
		// on the way in — one place, however a state reached this list.
		expect(stOf(h.nav.stack.entries[h.nav.stack.index])).toEqual(place.st);
	});
});

// ===== Patcher: historyNav injection =====

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
	// The funnel the patcher writes to. Like the sampler, the patcher is purely a
	// CAPTURE point — it records the open and the leave-read, never reads the
	// stack — so a spy funnel stands in for it.
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

		// our record wins over the native cursor, and the native cursor slot is gone
		expect(result).toMatchObject({ scroll: 10, cursor: RECORD.cursor });
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.cover.isCovered(leaf)).toBe(true);
		// ...and the landing is handed to the restorer, so its injected settle
		// verifies the same line core was given.
		expect(state.injectedLeafStates.get('leaf-1')).toMatchObject({ scroll: 10 });
	});

	it('带着目标步落点的遍历，把它盖在文件记录之上注入', () => {
		// A cross-file history jump: the entry's own landing (what the row
		// shows) must win over the file record, which after reading on holds
		// the spot the user had drifted to.
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
		// the landing is consumed with the flag — one shot, no leak
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.pendingHistoryNavState).toBeUndefined();
	});

	it('为另一个文件触发的落点，绝不落在抢走标记的那次打开上', () => {
		// The flag is global: an unrelated open inside the arming window takes
		// it. The landing is file-specific, so it must be dropped and the
		// record of the file actually being opened must stand.
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

		// The step's OWN t (when it was pushed) stays — the row prints "5m ago"
		// from it. The position needs no stamp of its own: the store puts one on
		// a record when it files it, and this history never goes through it.
		expect(parsed.entries[0].st).toEqual({
			scroll: 42,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
		});
	});
});
