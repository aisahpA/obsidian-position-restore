// Tests for the VSCode-style navigation history (nav-history.ts) and its
// integration points:
//  - stack logic: every jump pushes, a fresh jump truncates the forward part,
//    dedup drops repeated same-file jumps (key match), force wins;
//  - gates: the setting, and the startup window (layout not ready);
//  - rename/delete bookkeeping keeps the index meaningful;
//  - persistence: localStorage round-trip per vault, corrupt degrades to
//    empty, out-of-range index clamps;
//  - navigate: pointer movement, same-file jump applies the entry position,
//    cross-tab traversal reactivates the original leaf and opens the file,
//    same-tab file switch delegates to the native per-tab history only when
//    its next entry matches (else openFile fallback);
//  - graph tab steps: activation records a pathless view entry, traversal
//    reactivates the graph/file leaf without any open;
//  - sampler teleport detection (large cursor move within one tick);
//  - patcher historyNav injection: the saved position rides OVER the native
//    entry's cursor-only eState, marker consumed exactly once.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { App, FileView, MarkdownView, TFile } from 'obsidian';
import { NavHistory, NavHistoryEntry } from '../src/nav-history';
import { OpenPatcher } from '../src/patcher';
import { Sampler } from '../src/sampler';
import { PositionState } from '../src/position-state';
import { TabStore } from '../src/tab-store';
import { DEFAULT_SETTINGS, PluginSettings } from '../src/types';

const STORAGE_KEY = 'position-restore:nav-history:test-vault';

function makeApp(): App {
	return {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
		},
		workspace: {
			layoutReady: true,
			rootSplit: { containerEl: { contains: (el: unknown) => el === 'main' } },
			getActiveViewOfType: () => null,
			iterateAllLeaves: (_cb: (leaf: WorkspaceLeaf) => void) => undefined,
			setActiveLeaf: vi.fn(),
		},
		commands: { executeCommandById: vi.fn() },
	} as unknown as App;
}

function makeNav(
	app = makeApp(),
	settings: Partial<PluginSettings> = {},
) {
	return new NavHistory(
		app,
		{ ...DEFAULT_SETTINGS, ...settings } as PluginSettings,
		new PositionState({ ...DEFAULT_SETTINGS, ...settings } as PluginSettings),
	);
}

function entry(path: string, leafId = 'leaf-1'): NavHistoryEntry {
	return { path, leafId };
}

function leafWithFile(id: string, file?: string, containerEl: unknown = 'main'): WorkspaceLeaf {
	return {
		id,
		containerEl,
		view: file
			? Object.assign(Object.create(FileView.prototype), { file: { path: file } })
			: { getViewType: () => 'empty' },
	} as unknown as WorkspaceLeaf;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe('NavHistory stack logic', () => {
	it('records jumps and truncates the forward part on a fresh jump', () => {
		const nav = makeNav();
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		(nav as unknown as { index: number }).index = 0; // simulate having gone back
		nav.recordOpen('c.md', 'leaf-1');

		expect(nav.entries.map((e) => e.path)).toEqual(['a.md', 'c.md']);
		expect(nav.index).toBe(1);
		expect(nav.canGoBack()).toBe(true);
		expect(nav.canGoForward()).toBe(false);
	});

	it('dedups: same file without a key or with the same key is not pushed', () => {
		const nav = makeNav();
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('a.md', 'leaf-1'); // plain re-open: not a jump
		expect(nav.entries.length).toBe(1);

		nav.recordTeleport('a.md', 'leaf-1', 42); // keyed by target line
		expect(nav.entries.length).toBe(2);

		nav.recordOpen('a.md', 'leaf-1', { key: 'teleport:42' }); // same line again: same jump
		expect(nav.entries.length).toBe(2);

		nav.recordTeleport('a.md', 'leaf-1', 300); // different target line
		expect(nav.entries.length).toBe(3);

		nav.recordOpen('a.md', 'leaf-1', { key: '#other' }); // different anchor target
		expect(nav.entries.length).toBe(4);

		nav.recordOpen('a.md', 'leaf-1', { force: true }); // search match: always
		expect(nav.entries.length).toBe(5);
		expect(nav.index).toBe(4);
	});

	it('gates: pre-layout startup does not record', () => {
		const app = makeApp();
		(app.workspace as unknown as { layoutReady: boolean }).layoutReady = false;
		const nav = makeNav(app);
		nav.recordOpen('a.md', 'leaf-1');
		expect(nav.entries.length).toBe(0);
	});

	it('recordTeleport fills the landing on a fresh push and keeps it on a deduped repeat', () => {
		const nav = makeNav();
		const landing: NavHistoryEntry['st'] = { scroll: 7, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.recordTeleport('a.md', 'leaf-1', 42, landing);
		expect(nav.entries[0].key).toBe('teleport:42');
		expect(nav.entries[0].st).toBe(landing);

		// Same line again (deduped): the original landing survives.
		nav.recordTeleport('a.md', 'leaf-1', 42, { scroll: 9, cursor: { from: { line: 42, ch: 3 }, to: { line: 42, ch: 3 } } });
		expect(nav.entries.length).toBe(1);
		expect(nav.entries[0].st).toBe(landing);

		// A gated call (traversal executing) pushes nothing and fills nothing.
	});

	it('refreshTop never overwrites a keyed landing; it backfills only an empty one', () => {
		const nav = makeNav();
		const landing: NavHistoryEntry['st'] = { scroll: 7, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.recordTeleport('a.md', 'leaf-1', 42, landing);

		// The user drifted after landing; a leave must not touch the landing.
		const drifted: NavHistoryEntry['st'] = { scroll: 99, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.refreshTop('a.md', 'leaf-1', drifted);
		expect(nav.entries[0].st).toBe(landing);

		// Outline/anchor entries follow the same keyed rule: backfill when
		// empty (the settle-capture or the first leave), never overwrite.
		nav.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo', force: true });
		nav.refreshTop('a.md', 'leaf-1', drifted);
		expect(nav.entries[1].st).toBe(drifted);
		nav.refreshTop('a.md', 'leaf-1', landing);
		expect(nav.entries[1].st).toBe(drifted);

		// Legacy persisted entry without a landing: backfilled once.
		const legacy = makeNav();
		legacy.recordTeleport('a.md', 'leaf-1', 42);
		expect(legacy.entries[0].st).toBeUndefined();
		legacy.refreshTop('a.md', 'leaf-1', drifted);
		expect(legacy.entries[0].st).toBe(drifted);

		// Keyless open entries still take every leave read.
		legacy.recordOpen('a.md', 'leaf-1', { force: true });
		const leave: NavHistoryEntry['st'] = { scroll: 3, cursor: { from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } } };
		legacy.refreshTop('a.md', 'leaf-1', leave);
		expect(legacy.entries[1].st).toBe(leave);
		legacy.refreshTop('a.md', 'leaf-1', landing);
		expect(legacy.entries[1].st).toBe(landing);
	});

	it('rename migrates entries; delete drops them and keeps the index in range', () => {
		const nav = makeNav();
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		nav.recordOpen('c.md', 'leaf-1');

		nav.renameFile('b.md', 'renamed.md');
		expect(nav.entries.map((e) => e.path)).toEqual(['a.md', 'renamed.md', 'c.md']);

		(nav as unknown as { index: number }).index = 2; // sitting at c.md
		nav.deleteFile('c.md');
		expect(nav.entries.map((e) => e.path)).toEqual(['a.md', 'renamed.md']);
		expect(nav.index).toBe(1);

		nav.deleteFile('a.md');
		nav.deleteFile('renamed.md');
		expect(nav.entries.length).toBe(0);
		expect(nav.index).toBe(-1);
	});
});

describe('NavHistory activation recording', () => {
	it('a same-file activation of another tab is a real step; toggling back records again', () => {
		const nav = makeNav();
		nav.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.recordActivation(leafWithFile('leaf-2', 'a.md'));
		expect(nav.entries.map((e) => e.leafId)).toEqual(['leaf-1', 'leaf-2']);

		nav.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.entries.length).toBe(3);
		expect(nav.index).toBe(2);
	});

	it('re-activating the same tab of the same file does not record', () => {
		const nav = makeNav();
		nav.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.entries.length).toBe(1);
	});

	it('an activation that follows an open of the same file in the same leaf merges', () => {
		const nav = makeNav();
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.entries.length).toBe(1);
	});

	it('a non-file view activation or a null leaf does not record', () => {
		const nav = makeNav();
		nav.recordActivation(leafWithFile('leaf-1'));
		nav.recordActivation(null);
		expect(nav.entries.length).toBe(0);
	});

	it('a sidebar panel (outline) activation does not record', () => {
		const nav = makeNav();
		nav.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.recordActivation(leafWithFile('outline-leaf', 'a.md', 'sidebar'));
		expect(nav.entries.map((e) => e.leafId)).toEqual(['leaf-1']);
	});

	it('a keyed jump with the same key in another tab records its own step', () => {
		const nav = makeNav();
		nav.recordTeleport('a.md', 'leaf-1', 42);
		nav.recordTeleport('a.md', 'leaf-2', 42);
		expect(nav.entries.map((e) => e.leafId)).toEqual(['leaf-1', 'leaf-2']);
	});
});

describe('NavHistory recording settings', () => {
	it('navStackCap caps the stack, oldest entries drop, index stays at the top', () => {
		const nav = makeNav(makeApp(), { navStackCap: 2 });
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		nav.recordOpen('c.md', 'leaf-1');
		expect(nav.entries.map((e) => e.path)).toEqual(['b.md', 'c.md']);
		expect(nav.index).toBe(1);
	});

	it('a hand-edited navStackCap below 1 clamps to 1', () => {
		const nav = makeNav(makeApp(), { navStackCap: 0 });
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		expect(nav.entries.map((e) => e.path)).toEqual(['b.md']);
	});

	it('navRecordActivation off: tab (and graph) activation records nothing', () => {
		const nav = makeNav(makeApp(), { navRecordActivation: false });
		nav.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.recordActivation(graphLeaf('leaf-g'));
		expect(nav.entries.length).toBe(0);
	});

	it('navRecordTeleport off: cursor jumps record nothing', () => {
		const nav = makeNav(makeApp(), { navRecordTeleport: false });
		nav.recordTeleport('a.md', 'leaf-1', 42);
		nav.recordTeleport('a.md', 'leaf-1', 300);
		expect(nav.entries.length).toBe(0);
	});
});

describe('NavHistory persistence', () => {
	it('round-trips entries and index through localStorage', () => {
		const nav = makeNav();
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-2', { key: '#x' });
		nav.persist();

		const restored = makeNav();
		expect(restored.entries).toEqual(nav.entries);
		expect(restored.index).toBe(nav.index);
	});

	it('corrupt storage degrades to empty; a stale index clamps into range', () => {
		window.localStorage.setItem(STORAGE_KEY, '{not json');
		const empty = makeNav();
		expect(empty.entries.length).toBe(0);
		expect(empty.index).toBe(-1);

		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			entries: [entry('a.md'), entry('b.md')],
			index: 99,
		}));
		const clamped = makeNav();
		expect(clamped.entries.length).toBe(2);
		expect(clamped.index).toBe(1);
	});
});

describe('NavHistory.navigate', () => {
	it('never leaves the stack bounds', async () => {
		const nav = makeNav();
		await nav.navigate(-1);
		expect(nav.index).toBe(-1);
		nav.recordOpen('a.md', 'leaf-1');
		await nav.navigate(-1); // nothing before the first entry
		expect(nav.index).toBe(0);
	});

	it('watchdog releases the traversal bracket when an open hangs forever', async () => {
		vi.useFakeTimers();
		try {
			const app = makeApp();
			const nav = makeNav(app);
			nav.recordOpen('a.md', 'leaf-1');
			nav.recordOpen('b.md', 'leaf-1');
			(nav as unknown as { index: number }).index = 0;
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

			void nav.navigate(1); // hangs inside openFile
			expect(nav.canNavigate(-1)).toBe(false); // bracket up: traversal gated

			await vi.advanceTimersByTimeAsync(5000); // watchdog fires

			// Bracket released: a new traversal is no longer blocked.
			expect(nav.canNavigate(-1)).toBe(true);
			await nav.navigate(-1);
			expect(nav.index).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a same-file back applies the entry position to the view', async () => {
		const leaf = { id: 'leaf-1', isDeferred: false, view: { file: { path: 'a.md' } } };
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
		const app = makeApp();
		(app.workspace as unknown as {
			getActiveViewOfType: () => unknown;
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		}).getActiveViewOfType = () => view;
		(app.workspace as unknown as {
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		}).iterateAllLeaves = (cb) => cb(leaf);

		const nav = makeNav(app);
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('a.md', 'leaf-1', { key: 'teleport:60' });
		nav.entries[0].st = { scroll: 5, cursor: { from: { line: 60, ch: 0 }, to: { line: 60, ch: 0 } } };
		expect(nav.index).toBe(1);

		await nav.navigate(-1);

		expect(nav.index).toBe(0);
		// applied the target entry's position (cursor + quantized scroll)
		expect(applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		// the entry left behind was refreshed with the live read
		expect(nav.entries[1].st).toMatchObject({ scroll: 42 });
	});

	it('jumpTo lifts the chosen entry to the top; back returns to the origin', async () => {
		const leaf = { id: 'leaf-1', isDeferred: false, view: { file: { path: 'a.md' } } };
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
		const app = makeApp();
		(app.workspace as unknown as { getActiveViewOfType: () => unknown })
			.getActiveViewOfType = () => view;
		(app.workspace as unknown as {
			iterateAllLeaves: (cb: (l: unknown) => void) => void;
		}).iterateAllLeaves = (cb) => cb(leaf);

		const nav = makeNav(app);
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordTeleport('a.md', 'leaf-1', 60);
		nav.recordTeleport('a.md', 'leaf-1', 300);
		nav.entries[0].st = { scroll: 5, cursor: { from: { line: 60, ch: 0 }, to: { line: 60, ch: 0 } } };
		expect(nav.index).toBe(2);

		await nav.jumpTo(0);

		// the chosen entry is now the stack top (fresh-navigation semantics)
		expect(nav.index).toBe(2);
		expect(nav.entries.map(e => e.key)).toEqual(['teleport:60', 'teleport:300', undefined]);
		// applied the chosen entry's recorded position
		expect(applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		// nothing truncated: the displaced middle stays walkable via back
		expect(nav.entries.length).toBe(3);
		expect(nav.canGoBack()).toBe(true);
		expect(nav.canGoForward()).toBe(false);
		// the bracket released — traversal is immediately available again
		expect(nav.canNavigate(-1)).toBe(true);

		// back one step lands on the origin entry, refreshed at leave time
		await nav.navigate(-1);
		expect(nav.index).toBe(1);
		expect(applied[1]).toMatchObject({ scroll: 42 });
	});

	it('a cross-tab back reactivates the original leaf and opens the file there', async () => {
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
		nav.recordOpen('a.md', 'leaf-2');
		nav.recordOpen('c.md', 'leaf-1');
		await nav.navigate(-1);

		expect(ws.setActiveLeaf).toHaveBeenCalledWith(targetLeaf, { focus: true });
		expect(targetLeaf.openFile).toHaveBeenCalledTimes(1);
		expect(targetLeaf.openFile.mock.calls[0][0]).toMatchObject({ path: 'a.md' });
	});

	it('a cross-tab open arms pendingHistoryNav so the traversal lands instantly', async () => {
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
			const state = (nav as unknown as { state: PositionState }).state;
			let armedDuringOpen: boolean | undefined;
			targetLeaf.openFile.mockImplementation(() => {
				armedDuringOpen = state.pendingHistoryNav;
				return Promise.resolve();
			});
			nav.recordOpen('a.md', 'leaf-2');
			nav.recordOpen('c.md', 'leaf-1');
			await nav.navigate(-1);

			expect(armedDuringOpen).toBe(true);
			vi.advanceTimersByTime(1000);
			expect(state.pendingHistoryNav).toBe(false); // timeout cleared: no leak onto later opens
		} finally {
			vi.useRealTimers();
		}
	});

	it('a same-tab file switch delegates to the native history when its next entry matches', async () => {
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
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		await nav.navigate(-1);

		expect(app.commands.executeCommandById).toHaveBeenCalledWith('app:go-back');
		expect(leaf.openFile).not.toHaveBeenCalled();
	});

	it('a native/native-target mismatch falls back to openFile', async () => {
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
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		await nav.navigate(-1);

		expect(app.commands.executeCommandById).not.toHaveBeenCalled();
		expect(leaf.openFile).toHaveBeenCalledTimes(1);
		expect(leaf.openFile.mock.calls[0][0]).toMatchObject({ path: 'a.md' });
	});
});

// ===== NavHistory.navigate from sidebar focus =====

// A sidebar (file explorer, search, outline…) holds focus: getActiveViewOfType
// is null until the traversal's setActiveLeaf reactivates a file tab — the
// mock switches the "active view" exactly like the real workspace would.
type HarnessLeaf = { id: string; isDeferred: boolean; openFile: ReturnType<typeof vi.fn>; setViewState: ReturnType<typeof vi.fn>; view?: unknown };

function makeSidebarHarness(opts: {
	leaves: { id: string; file?: string; markdown?: boolean }[];
	mostRecentLeafId?: string;
}) {
	const app = makeApp();
	const ws = app.workspace as unknown as {
		getActiveViewOfType: () => unknown;
		iterateAllLeaves: (cb: (l: unknown) => void) => void;
		setActiveLeaf: (l: unknown, opts?: unknown) => void;
		getMostRecentLeaf: () => unknown;
	};
	const openFile = vi.fn().mockResolvedValue(undefined);
	const setViewState = vi.fn().mockResolvedValue(undefined);
	const applied: unknown[] = [];
	const viewsByLeaf: Record<string, unknown> = {};
	const leaves: HarnessLeaf[] = opts.leaves.map((spec) => {
		const leaf: HarnessLeaf = { id: spec.id, isDeferred: false, openFile, setViewState };
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
	return { ws, nav: makeNav(app), openFile, setViewState, applied, leaves };
}

describe('NavHistory.navigate from sidebar focus', () => {
	it('a same-file back reactivates the tab and applies the entry position', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('a.md', 'leaf-1', { key: 'teleport:60' });
		nav.entries[0].st = { scroll: 5, cursor: { from: { line: 60, ch: 0 }, to: { line: 60, ch: 0 } } };
		expect(nav.index).toBe(1);

		await nav.navigate(-1);

		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.leaves[0], { focus: true });
		expect(nav.index).toBe(0);
		expect(h.applied[0]).toMatchObject({ scroll: 5, cursor: { from: { line: 60, ch: 0 } } });
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('a closed start leaf falls back to the most recently active leaf', async () => {
		const h = makeSidebarHarness({
			leaves: [{ id: 'leaf-2', file: 'd.md' }],
			mostRecentLeafId: 'leaf-2',
		});
		const nav = h.nav;
		nav.recordOpen('a.md', 'leaf-1'); // leaf-1 has since been closed
		nav.recordOpen('b.md', 'leaf-1');
		await nav.navigate(-1);

		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.leaves[0], { focus: true });
		expect(h.openFile).toHaveBeenCalledTimes(1);
		expect(h.openFile.mock.calls[0][0]).toMatchObject({ path: 'a.md' });
	});

	it('canNavigate follows the same fallbacks as navigate', () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md' }] });
		const nav = h.nav;
		expect(nav.canNavigate(-1)).toBe(false); // empty stack
		nav.recordOpen('a.md', 'leaf-1');
		expect(nav.canNavigate(-1)).toBe(false); // bottom of the stack
		nav.recordOpen('b.md', 'leaf-1');
		expect(nav.canNavigate(-1)).toBe(true); // sidebar focused, tab resolvable
		expect(nav.canNavigate(1)).toBe(false);

		h.ws.setActiveLeaf(h.leaves[0]); // user focuses the file tab again
		expect(nav.canNavigate(-1)).toBe(true);
	});

	it('canNavigate is false with sidebar focus and nothing resolvable', () => {
		const h = makeSidebarHarness({ leaves: [] });
		const nav = h.nav;
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		expect(nav.canNavigate(-1)).toBe(false);
	});
});

// ===== NavHistory: graph tab steps =====

function graphLeaf(id: string, containerEl: unknown = 'main'): WorkspaceLeaf {
	return {
		id,
		containerEl,
		view: { getViewType: () => 'graph' },
	} as unknown as WorkspaceLeaf;
}

describe('NavHistory graph view steps', () => {
	it('graph activation records a pathless view entry and dedups; sidebar does not record', () => {
		const nav = makeNav();
		nav.recordActivation(graphLeaf('leaf-g'));
		nav.recordActivation(graphLeaf('leaf-g')); // re-click same tab: dedup
		expect(nav.entries).toEqual([{ leafId: 'leaf-g', viewType: 'graph' }]);

		nav.recordActivation(graphLeaf('leaf-s', 'sidebar')); // sidebar local graph: not a step
		expect(nav.entries.length).toBe(1);
	});

	it('back from the graph tab reactivates the previous file tab without reopening', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.recordOpen('a.md', 'leaf-1');
		h.leaves.push(graphLeaf('leaf-g') as never);
		nav.recordActivation(graphLeaf('leaf-g'));
		expect(nav.index).toBe(1);

		await nav.navigate(-1); // graph active (no FileView): current entry is the graph step

		expect(nav.index).toBe(0);
		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(h.leaves[0], { focus: true });
		expect(h.openFile).not.toHaveBeenCalled(); // a.md already in that tab
	});

	it('forward from a file tab reactivates the graph tab without opening', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.recordOpen('a.md', 'leaf-1');
		const gLeaf = graphLeaf('leaf-g');
		h.leaves.push(gLeaf as never);
		nav.recordActivation(gLeaf);
		(nav as unknown as { index: number }).index = 0; // simulate having gone back

		await nav.navigate(1);

		expect(nav.index).toBe(1);
		expect(h.ws.setActiveLeaf).toHaveBeenCalledWith(gLeaf, { focus: true });
		expect(h.setViewState).not.toHaveBeenCalled(); // the graph is already showing
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('forward re-asserts the graph view when a file replaced it in the same leaf', async () => {
		// graph:open tab reuse / a graph node click: the file open swapped the
		// graph out of its own leaf, so the graph entry shares the leaf id.
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen(undefined, 'leaf-1', { viewType: 'graph' });
		(nav as unknown as { index: number }).index = 0; // simulate having gone back

		await nav.navigate(1);

		expect(nav.index).toBe(1);
		expect(h.setViewState).toHaveBeenCalledWith({ type: 'graph', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('the same-leaf graph restore rides the native history when its entry matches', async () => {
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
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen(undefined, 'leaf-1', { viewType: 'graph' });
		nav.recordOpen('a.md', 'leaf-1');

		await nav.navigate(-1); // back to the graph step

		expect(app.commands.executeCommandById).toHaveBeenCalledWith('app:go-back');
		expect(leaf.setViewState).not.toHaveBeenCalled();
		expect(leaf.openFile).not.toHaveBeenCalled();
	});

	it('a closed graph leaf is a no-op, never a swap over the active file', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordOpen('b.md', 'leaf-1');
		nav.recordOpen(undefined, 'leaf-gone', { viewType: 'graph' }); // leaf since closed
		(nav as unknown as { index: number }).index = 1; // simulate having gone back once

		await nav.navigate(1);

		expect(nav.index).toBe(2);
		expect(h.setViewState).not.toHaveBeenCalled();
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('a persisted graph entry survives the load filter', () => {
		const nav = makeNav();
		nav.recordOpen('a.md', 'leaf-1');
		nav.recordActivation(graphLeaf('leaf-g'));
		nav.persist();

		const restored = makeNav();
		expect(restored.entries).toEqual(nav.entries);
		expect(restored.index).toBe(1);
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
	const fullSettings = { ...DEFAULT_SETTINGS, ...settings } as PluginSettings;
	const state = new PositionState(fullSettings);
	const refreshTop = vi.fn();
	const recordTeleport = vi.fn();
	const sampler = new Sampler(app as never, database as never, fullSettings, state, {
		entries: [] as NavHistoryEntry[],
		index: -1,
		recordOpen: vi.fn(),
		recordTeleport,
		refreshTop,
	} as never);
	state.lastLoadedFilePath = 'a.md';
	state.lastEphemeralState = { scroll: 0, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };
	const onSelection = (sampler as unknown as { onEditorSelection: (editor: unknown) => void }).onEditorSelection;
	return { sampler, state, recordTeleport, refreshTop, database, view, cursor, onSelection };
}

describe('Sampler in-file teleport detection', () => {
	it('a ≥10-line cursor jump records via the selection event and refreshes the left entry', () => {
		const h = makeSamplerHarness(); // view cursor sits at line 60; poll read at line 3
		h.onSelection(h.view.editor); // baseline: line 60
		h.cursor.line = 3;
		h.onSelection(h.view.editor);
		expect(h.recordTeleport).toHaveBeenCalledTimes(1);
		expect(h.recordTeleport.mock.calls[0]).toEqual(['a.md', 'leaf-1', 3, {
			scroll: 42,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
		}]);
		// the entry being left got the poll's read (harness baseline:
		// scroll 0, cursor line 3)
		expect(h.refreshTop).toHaveBeenCalledWith('a.md', 'leaf-1', {
			scroll: 0,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
		});
	});

	it('recording rules never gate navigation: an excluded file still records teleports, positions stay unwritten', () => {
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

	it('flushOnLeave writes the exact leaving state; recording rules still gate it', () => {
		const st = { scroll: 7, cursor: { from: { line: 5, ch: 0 }, to: { line: 5, ch: 0 } } };

		const h = makeSamplerHarness();
		h.sampler.flushOnLeave(h.view, 'a.md', st);
		expect(h.database.setState).toHaveBeenCalledWith('a.md', st);

		const excluded = makeSamplerHarness({ excludedFolders: ['a.md'] });
		excluded.sampler.flushOnLeave(excluded.view, 'a.md', st);
		expect(excluded.database.setState).not.toHaveBeenCalled();
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

function makeLeaf(id: string): WorkspaceLeaf {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf;
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
	const tabStore = new TabStore(app, { db } as never, state);
	const nav = { recordOpen: vi.fn(), recordTeleport: vi.fn(), refreshTop: vi.fn() };
	const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, tabStore, nav as never, { flushOnLeave: vi.fn() } as never);
	const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);
	disposables.push(() => state.cover.uncover(leaf));
	return { state, leaf, inject, nav };
}

afterEach(() => {
	disposables.forEach((fn) => fn());
	disposables = [];
});

describe('OpenPatcher navigation integration', () => {	it('every file-changing open records a jump entry', () => {
		const { leaf, inject, nav } = makePatcherHarness({});
		inject(leaf, SOURCE_OPEN_A('a.md'), undefined);
		expect(nav.recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', { key: undefined, force: false });
	});

	it('a same-file caller target (match) records with force and a unique caller key', () => {
		const { state, leaf, inject, nav } = makePatcherHarness({});
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		inject(leaf, SOURCE_OPEN_A(), { match: {} });
		expect(nav.recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', {
			key: expect.stringMatching(/^caller:/),
			force: true,
		});
	});

	it('a history traversal injects the saved position OVER the native eState', () => {
		const { state, leaf, inject } = makePatcherHarness({ 'a.md': RECORD });
		state.pendingHistoryNav = true;
		const eState = { cursor: { from: { line: 2, ch: 0 }, to: { line: 2, ch: 0 } } };

		const result = inject(leaf, SOURCE_OPEN_A(), eState) as Record<string, unknown>;

		// our record wins over the native cursor, and the native cursor slot is gone
		expect(result).toMatchObject({ scroll: 10, cursor: RECORD.cursor });
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.cover.isCovered(leaf)).toBe(true);
	});

	it('a traversal without a saved record keeps the native target and consumes the flag', () => {
		const { state, leaf, inject } = makePatcherHarness({});
		state.pendingHistoryNav = true;
		const eState = { cursor: { from: { line: 2, ch: 0 }, to: { line: 2, ch: 0 } } };

		expect(inject(leaf, SOURCE_OPEN_A(), eState)).toBe(eState);
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
	});

	it('a traversal on a replay consumes the flag without injecting', () => {
		const { state, leaf, inject } = makePatcherHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		state.pendingHistoryNav = true;
		const eState = { scroll: 10, cursor: RECORD.cursor };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);
		expect(result).toBe(eState);
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
	});

	it('a traversal of a non-markdown view is left native (flag consumed)', () => {
		const { state, leaf, inject } = makePatcherHarness({ 'a.pdf': { scroll: 3 } });
		state.pendingHistoryNav = true;
		const eState = { scroll: 3 };

		const result = inject(leaf, { type: 'pdf', state: { file: 'a.pdf' } }, eState);
		expect(result).toBe(eState);
		expect(state.pendingHistoryNav).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
	});
});
