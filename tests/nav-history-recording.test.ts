// Tests for the VSCode-style navigation stack (nav-history/stack.ts), the
// recording funnel it listens to (nav/funnel.ts) and their integration points:
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
import { NavFunnel } from '@/nav/funnel';
import { NavStack } from '@/nav-history/stack';
import { NavPlaces } from '@/recent-files/places';
import { NAV_HISTORY_VERSION } from '@/nav-history/store';
import { NavEntry, NavJump, NavVisit } from '@/nav/entry';
import { OpenPatcher } from '@/position/restore/patcher';
import { Sampler } from '@/position/capture/sampler';
import { PositionState } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, EphemeralState, NavEntryState, PluginSettings } from '@/types';

const STORAGE_KEY = 'position-restore:nav-history:test-vault';

function makeApp(
	headings?: Array<{ heading: string; level: number; position: { start: { line: number } } }>,
): App & { commands: { executeCommandById: ReturnType<typeof vi.fn> } } {
	return {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
		},
		metadataCache: { getFileCache: () => (headings ? { headings } : null) },
		workspace: {
			layoutReady: true,
			rootSplit: { containerEl: { contains: (el: unknown) => el === 'main' } },
			getActiveViewOfType: () => null,
			iterateAllLeaves: (_cb: (leaf: WorkspaceLeaf) => void) => undefined,
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
		},
		commands: { executeCommandById: vi.fn() },
	} as unknown as App & { commands: { executeCommandById: ReturnType<typeof vi.fn> } };
}

// The two navigation readers, wired as the composition root wires them (see
// position/manager.ts): the CAPTURE points (the record* calls below) write to
// the funnel, and the funnel publishes to the stack and the place list. The
// harness hands all three back by name, so a test says which side it means —
// `funnel.` for a capture, `stack.` for the stack's own state and traversal,
// `places.` for the recent-files list.
function makeNav(
	app = makeApp(),
	settings: Partial<PluginSettings> = {},
	savedPosition?: (path: string) => EphemeralState | undefined,
) {
	const resolved = { ...DEFAULT_SETTINGS, ...settings } as PluginSettings;
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

function entry(path: string, leafId = 'leaf-1'): NavEntry {
	return { kind: 'visit', path, leafId, t: 1 };
}

// The settings panel mutates the settings object the stack was handed (they
// share one instance, see NavStack.settings) — this is that mutation, without
// going through the whole settings tab.
function setCap(nav: ReturnType<typeof makeNav>, cap: number): void {
	(nav.stack as unknown as { settings: PluginSettings }).settings.navStackCap = cap;
}

// These tests build file-only stacks (a graph entry appears in exactly one
// full-object equality assertion); the helpers narrow the file kinds so the
// per-index reads stay terse.
const pathOf = (e: NavEntry) => (e.kind !== 'view' ? e.path : undefined);
const keyOf = (e: NavEntry) => (e.kind === 'jump' ? e.key : e.kind === 'teleport' ? `teleport:${e.line}` : undefined);
const stOf = (e: NavEntry) => (e.kind !== 'view' ? e.st : undefined);
const viaOf = (e: NavEntry) => (e.kind === 'visit' ? e.via : undefined);

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

describe('NavStack stack logic', () => {
	it('records jumps and truncates the forward part on a fresh jump', () => {
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

	it('dedups: same file without a key or with the same key is not pushed', () => {
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

	it('gates: pre-layout startup does not record', () => {
		const app = makeApp();
		(app.workspace as unknown as { layoutReady: boolean }).layoutReady = false;
		const nav = makeNav(app);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		expect(nav.stack.entries.length).toBe(0);
	});

	it('recordTeleport fills the landing on a fresh push and keeps it on a deduped repeat', () => {
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

	it('refreshTop never overwrites a keyed landing; it backfills only an empty one', () => {
		const nav = makeNav();
		const landing: NavEntryState = { scroll: 7, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42, landing);

		// The user drifted after landing; a leave must not touch the landing.
		const drifted: NavEntryState = { scroll: 99, cursor: { from: { line: 42, ch: 0 }, to: { line: 42, ch: 0 } } };
		nav.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(nav.stack.entries[0])).toBe(landing);

		// Outline/anchor entries follow the same keyed rule: backfill when
		// empty (the settle-capture or the first leave), never overwrite.
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:Foo', force: true });
		nav.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(nav.stack.entries[1])).toBe(drifted);
		nav.funnel.leave('a.md', 'leaf-1', landing);
		expect(stOf(nav.stack.entries[1])).toBe(drifted);

		// Legacy persisted entry without a landing: backfilled once.
		const legacy = makeNav();
		legacy.funnel.recordTeleport('a.md', 'leaf-1', 42);
		expect(stOf(legacy.stack.entries[0])).toBeUndefined();
		legacy.funnel.leave('a.md', 'leaf-1', drifted);
		expect(stOf(legacy.stack.entries[0])).toBe(drifted);

		// Keyless open entries still take every leave read.
		legacy.funnel.recordOpen('a.md', 'leaf-1', { force: true });
		const leave: NavEntryState = { scroll: 3, cursor: { from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } } };
		legacy.funnel.leave('a.md', 'leaf-1', leave);
		expect(stOf(legacy.stack.entries[1])).toBe(leave);
		legacy.funnel.leave('a.md', 'leaf-1', landing);
		expect(stOf(legacy.stack.entries[1])).toBe(landing);
	});

	it('upgrades an outline key from the cache with its record-time line', () => {
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

	it('upgrades an anchor-link key with its record-time line (key untouched)', () => {
		const nav = makeNav(makeApp([
			{ heading: 'My Heading', level: 2, position: { start: { line: 12 } } },
		]));
		nav.funnel.recordOpen('a.md', 'leaf-1', { key: 'a.md#my-heading', force: true });
		nav.funnel.leave('a.md', 'leaf-1', { scroll: 12, anchor: '## My Heading' });
		expect(keyOf(nav.stack.entries[0])).toBe('a.md#my-heading');
		expect((nav.stack.entries[0] as NavJump).keyLine).toBe(12);
	});

	it('keeps the recorded key when no cache heading matches (remap fallback)', () => {
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

	it('dedups a re-click against an upgraded key (normalized outline keys)', () => {
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

	it('rename migrates entries; delete drops them and keeps the index in range', () => {
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

describe('NavStack activation recording', () => {
	it('a same-file activation of another tab is a real step; toggling back records again', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.funnel.recordActivation(leafWithFile('leaf-2', 'a.md'));
		expect(nav.stack.entries.map((e) => e.leafId)).toEqual(['leaf-1', 'leaf-2']);
		// Activation steps carry the switch badge (open steps have no via).
		expect(nav.stack.entries.map(viaOf)).toEqual(['switch', 'switch']);

		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.stack.entries.length).toBe(3);
		expect(nav.stack.index).toBe(2);
	});

	it('re-activating the same tab of the same file does not record', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.stack.entries.length).toBe(1);
	});

	it('an activation that follows an open of the same file in the same leaf merges', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		expect(nav.stack.entries.length).toBe(1);
		// The merged step keeps the open's identity: no switch badge.
		expect(nav.stack.entries.map(viaOf)).toEqual([undefined]);
	});

	it('a non-file view activation or a null leaf does not record', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1'));
		nav.funnel.recordActivation(null);
		expect(nav.stack.entries.length).toBe(0);
	});

	it('a sidebar panel (outline) activation does not record', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.funnel.recordActivation(leafWithFile('outline-leaf', 'a.md', 'sidebar'));
		expect(nav.stack.entries.map((e) => e.leafId)).toEqual(['leaf-1']);
	});

	it('a sidebar activation does not notify browsers — it would eat the press', () => {
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
		expect(nav.stack.entries[0].st).toBeUndefined();
		expect(nav.stack.entries).toHaveLength(1);
	});

	it('a keyed jump with the same key in another tab records its own step', () => {
		const nav = makeNav();
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42);
		nav.funnel.recordTeleport('a.md', 'leaf-2', 42);
		expect(nav.stack.entries.map((e) => e.leafId)).toEqual(['leaf-1', 'leaf-2']);
	});

	it('switching tabs captures the position of the file being left onto its entry', () => {
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

describe('NavStack recording settings', () => {
	it('navStackCap caps the stack, oldest entries drop, index stays at the top', () => {
		const nav = makeNav(makeApp(), { navStackCap: 2 });
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		nav.funnel.recordOpen('c.md', 'leaf-1');
		expect(nav.stack.entries.map(pathOf)).toEqual(['b.md', 'c.md']);
		expect(nav.stack.index).toBe(1);
	});

	it('a hand-edited navStackCap below 1 clamps to 1', () => {
		const nav = makeNav(makeApp(), { navStackCap: 0 });
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		expect(nav.stack.entries.map(pathOf)).toEqual(['b.md']);
	});

	it('a cap that is not a number at all falls back to the default', () => {
		// "abc" would make every `length > cap` comparison false and disable the
		// ceiling entirely; null would collapse it to 1.
		const nav = makeNav(makeApp(), { navStackCap: 'abc' as unknown as number });
		expect(nav.stack.stackCap()).toBe(DEFAULT_SETTINGS.navStackCap);
	});

	it('lowering the cap trims the stack at once, keeping the pointer on the top', () => {
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

	it('a cap that falls below the current depth stops the pointer on the oldest survivor', () => {
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

	it('a stored stack over the ceiling is trimmed on load', () => {
		// The cap is lowered (and persisted) while the stack blob still holds
		// the old, longer history: the ceiling must win from the first render.
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: NAV_HISTORY_VERSION,
			entries: [entry('a.md'), entry('b.md'), entry('c.md'), entry('d.md')],
			index: 3,
		}));

		const nav = makeNav(makeApp(), { navStackCap: 2 });

		expect(nav.stack.entries.map(pathOf)).toEqual(['c.md', 'd.md']);
		expect(nav.stack.index).toBe(1);
	});

	it('navRecordActivation off: tab (and graph) activation records nothing', () => {
		const nav = makeNav(makeApp(), { navRecordActivation: false });
		nav.funnel.recordActivation(leafWithFile('leaf-1', 'a.md'));
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		expect(nav.stack.entries.length).toBe(0);
	});

	it('navRecordTeleport off: cursor jumps record nothing', () => {
		const nav = makeNav(makeApp(), { navRecordTeleport: false });
		nav.funnel.recordTeleport('a.md', 'leaf-1', 42);
		nav.funnel.recordTeleport('a.md', 'leaf-1', 300);
		expect(nav.stack.entries.length).toBe(0);
	});
});

describe('NavStack persistence', () => {
	it('round-trips entries and index through localStorage', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-2', { key: '#x' });
		nav.stack.persist();

		const restored = makeNav();
		expect(restored.stack.entries).toEqual(nav.stack.entries);
		expect(restored.stack.index).toBe(nav.stack.index);
	});

	it('corrupt storage degrades to empty; a stale index clamps into range', () => {
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

	it('a foreign-format blob (missing or other version) is dropped whole', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			entries: [entry('a.md')],
			index: 0,
		}));
		const nav = makeNav();
		expect(nav.stack.entries.length).toBe(0);
		expect(nav.stack.index).toBe(-1);
	});

	it('malformed entries are dropped, valid ones survive the load filter', () => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
			v: NAV_HISTORY_VERSION,
			entries: [
				{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 }, // ok
				{ path: 'x.md' }, // no kind, no leafId: dropped
				{ kind: 'jump', path: 'y.md', leafId: 'leaf-2', key: 3, t: 1 }, // junk key: dropped
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-g', t: 1 }, // ok
				{ kind: 'visit', path: 'b.md', leafId: 'leaf-4' }, // no timestamp: dropped
				{ leafId: 'leaf-3' }, // neither kind nor path/viewType: dropped
			],
			index: 1,
		}));
		const nav = makeNav();
		expect(nav.stack.entries.length).toBe(2);
		expect(nav.stack.index).toBe(1);
	});

	it('the write dedup belongs to the instance, not to the module', () => {
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
	it('never leaves the stack bounds', async () => {
		const nav = makeNav();
		await nav.stack.navigate(-1);
		expect(nav.stack.index).toBe(-1);
		nav.funnel.recordOpen('a.md', 'leaf-1');
		await nav.stack.navigate(-1); // nothing before the first entry
		expect(nav.stack.index).toBe(0);
	});

	it('watchdog releases the traversal bracket when an open hangs forever', async () => {
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

	it('a same-file back applies the entry position to the view', async () => {
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

	it('a place branches from the current entry; back returns to the origin', async () => {
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
			// The landing the jump settled on, as the store keeps it.
			(nav.places.entries[at] as NavJump).st =
				{ scroll: 5, cursor: { from: { line: 60, ch: 0 }, to: { line: 60, ch: 0 } } };
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
		// applied the chosen place's recorded position
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

	it('re-lands the place the reader is already on instead of duplicating it', async () => {
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

	it('lands an unsettled teleport on the line it recorded, not nowhere', async () => {
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
		expect(nav.stack.entries[1].st).toBeUndefined();

		await nav.stack.navigate(-1);

		// the line the entry itself recorded is the landing the traversal applies
		expect(h.applied[0]).toMatchObject({ scroll: 60 });
	});

	it('applies the saved record for a place that recorded no landing of its own', async () => {
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
		expect(nav.places.entries[at].st).toBeUndefined();

		await nav.places.travel(at);

		// the record the row borrowed its line from is the landing the travel applies
		expect(h.applied[0]).toMatchObject({ scroll: 41 });
	});

	it('applies a same-file jump while a sidebar holds the focus', async () => {
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

	it('takes a jump place\'s landing from the settle, never from the leave', () => {
		// The stack backfills a keyed entry with the reader's LEAVE so a later back
		// returns somewhere. That read is not the jump's own spot, and a place's row
		// PROMISES the spot it prints — so a reader who clicked a heading, read on and
		// then switched files must not find that heading's recorded place moved to
		// wherever they happened to drift to.
		const settled = makeNav();
		settled.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## H' });
		const a = settled.places.entries.findIndex(e => e.kind === 'jump');
		settled.funnel.settled('a.md', 'leaf-1', { scroll: 152 });
		expect(settled.places.entries[a].st).toEqual({ scroll: 152 });

		const left = makeNav();
		left.funnel.recordOpen('a.md', 'leaf-1', { key: 'outline:## H' });
		const b = left.places.entries.findIndex(e => e.kind === 'jump');
		left.funnel.leave('a.md', 'leaf-1', { scroll: 900 });
		// the stack kept the drift (back needs a position) …
		expect(left.stack.entries[left.stack.index].st).toEqual({ scroll: 900 });
		// …and the place kept none: its row falls back to the file's own record
		// rather than freezing the drift as the heading's spot.
		expect(left.places.entries[b].st).toBeUndefined();
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
		nav.funnel.recordOpen('a.md', 'leaf-2');
		nav.funnel.recordOpen('c.md', 'leaf-1');
		await nav.stack.navigate(-1);

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

	it('a cross-tab back arms the target entry its own landing, not the file record', async () => {
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

	it('a cross-file landing is structurally re-anchored through its heading', async () => {
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

	it('a cross-tab back to a tab that still shows the file applies the entry landing', async () => {
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
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		await nav.stack.navigate(-1);

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
type HarnessLeaf = { id: string; isDeferred: boolean; containerEl: string; openFile: ReturnType<typeof vi.fn>; setViewState: ReturnType<typeof vi.fn>; view?: unknown };

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
		getLeaf: (target?: unknown) => unknown;
	};
	const openFile = vi.fn().mockResolvedValue(undefined);
	const setViewState = vi.fn().mockResolvedValue(undefined);
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
	// A BRAND-NEW leaf, as workspace.getLeaf hands one over for a target the reader
	// asked for elsewhere (a tab, a split, a window): it shows nothing yet, so the open
	// pipeline has to put the place in it. One object, so a test can ask whether the
	// open landed HERE (the `openFile` mock is shared, and its `this` is the answer).
	const newLeaf: HarnessLeaf = { id: 'leaf-new', isDeferred: false, containerEl: 'main', openFile, setViewState };
	ws.getLeaf = vi.fn(() => newLeaf);
	return { ws, nav: makeNav(app), openFile, setViewState, applied, leaves, newLeaf };
}

describe('NavStack.navigate from sidebar focus', () => {
	it('a same-file back reactivates the tab and applies the entry position', async () => {
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

	it('a closed start leaf falls back to the most recently active leaf', async () => {
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

	it('canNavigate follows the same fallbacks as navigate', () => {
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

	it('canNavigate is false with sidebar focus and nothing resolvable', () => {
		const h = makeSidebarHarness({ leaves: [] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		expect(nav.stack.canNavigate(-1)).toBe(false);
	});
});

// ===== NavStack: graph tab steps =====

function graphLeaf(id: string, containerEl: unknown = 'main'): WorkspaceLeaf {
	return {
		id,
		containerEl,
		view: { getViewType: () => 'graph' },
	} as unknown as WorkspaceLeaf;
}

describe('NavStack entry timestamps', () => {
	it('stamps every pushed entry with the push time', () => {
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

describe('NavStack graph view steps', () => {
	it('graph activation records a pathless view entry and dedups; sidebar does not record', () => {
		const nav = makeNav();
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		nav.funnel.recordActivation(graphLeaf('leaf-g')); // re-click same tab: dedup
		expect(nav.stack.entries).toEqual([{ kind: 'view', leafId: 'leaf-g', viewType: 'graph', t: expect.any(Number) }]);

		nav.funnel.recordActivation(graphLeaf('leaf-s', 'sidebar')); // sidebar local graph: not a step
		expect(nav.stack.entries.length).toBe(1);
	});

	it('back from the graph tab reactivates the previous file tab without reopening', async () => {
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

	it('forward from a file tab reactivates the graph tab without opening', async () => {
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

	it('forward re-asserts the graph view when a file replaced it in the same leaf', async () => {
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
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen(undefined, 'leaf-1', { viewType: 'graph' });
		nav.funnel.recordOpen('a.md', 'leaf-1');

		await nav.stack.navigate(-1); // back to the graph step

		expect(app.commands.executeCommandById).toHaveBeenCalledWith('app:go-back');
		expect(leaf.setViewState).not.toHaveBeenCalled();
		expect(leaf.openFile).not.toHaveBeenCalled();
	});

	it('a closed graph leaf is a no-op, never a swap over the active file', async () => {
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });
		const nav = h.nav;
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordOpen('b.md', 'leaf-1');
		nav.funnel.recordOpen(undefined, 'leaf-gone', { viewType: 'graph' }); // leaf since closed
		(nav.stack as unknown as { index: number }).index = 1; // simulate having gone back once

		await nav.stack.navigate(1);

		expect(nav.stack.index).toBe(2);
		expect(h.setViewState).not.toHaveBeenCalled();
		expect(h.openFile).not.toHaveBeenCalled();
	});

	it('a persisted graph entry survives the load filter', () => {
		const nav = makeNav();
		nav.funnel.recordOpen('a.md', 'leaf-1');
		nav.funnel.recordActivation(graphLeaf('leaf-g'));
		nav.stack.persist();

		const restored = makeNav();
		expect(restored.stack.entries).toEqual(nav.stack.entries);
		expect(restored.stack.index).toBe(1);
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

// A travel the reader asked to happen SOMEWHERE ELSE — the modifier-click, the
// middle button, the keyboard's Cmd/Ctrl+Enter (see PaneTarget / list.ts). It is a
// different question from every other branch of the open pipeline, which exists to go
// BACK to a place: here the place's own tab must not move.
describe('NavStack — a travel asked for elsewhere', () => {
	// The arming flag the setViewState patch consumes: the landing a traversal injects
	// over the native entry's cursor-only state (see armHistoryNav).
	const armed = (nav: ReturnType<typeof makeNav>) =>
		(nav.stack as unknown as {
			state: { pendingHistoryNav: boolean; pendingHistoryNavState?: unknown; pendingHistoryNavPath?: string };
		}).state;

	it('opens a JUMP place in the leaf the app picks, with the same landing armed', async () => {
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
		// travel arms, so the same note opened one tab over lands in the same spot.
		expect(armed(h.nav).pendingHistoryNav).toBe(true);
		expect(armed(h.nav).pendingHistoryNavState).toEqual({ scroll: 30 });
		expect(armed(h.nav).pendingHistoryNavPath).toBe('b.md');
	});

	it('opens a FILE place in the new leaf with nothing injected', async () => {
		// A file place carries no position of its own (see places.ts): the position
		// database decides where it lands, in a new tab exactly as in the old one.
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });

		await h.nav.stack.openFilePlain('b.md', 'leaf-1', 'tab');

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		expect(h.openFile.mock.contexts[0]).toBe(h.newLeaf);
		expect(armed(h.nav).pendingHistoryNav).toBe(false);
	});

	it('SHOWS a pathless view in the new leaf rather than opening a file', async () => {
		// The graph has no file to open: the leaf has to be told to show it, and
		// `active` is what brings it to the front.
		const h = makeSidebarHarness({ leaves: [{ id: 'leaf-1', file: 'a.md', markdown: true }] });

		await h.nav.stack.openViewPlace({ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 1 }, 'tab');

		expect(h.ws.getLeaf).toHaveBeenCalledWith('tab');
		expect(h.setViewState).toHaveBeenCalledWith({ type: 'graph', state: {}, active: true });
		expect(h.openFile).not.toHaveBeenCalled();
	});
});

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
		expect(h.leave).toHaveBeenCalledWith('a.md', 'leaf-1', {
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

	it('navRecordTeleport off: the selection event path stays fully silent', () => {
		const h = makeSamplerHarness({ navRecordTeleport: false });
		h.onSelection(h.view.editor); // baseline: line 60
		h.cursor.line = 3;
		h.onSelection(h.view.editor); // 57-line jump, setting off
		expect(h.recordTeleport).not.toHaveBeenCalled();
		expect(h.leave).not.toHaveBeenCalled();
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

describe('OpenPatcher navigation integration', () => {	it('every file-changing open records a jump entry', () => {
		const { leaf, inject, funnel } = makePatcherHarness({});
		inject(leaf, SOURCE_OPEN_A('a.md'), undefined);
		expect(funnel.recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', { key: undefined, force: false });
	});

	it('a same-file caller target (match) records with force and a unique caller key', () => {
		const { state, leaf, inject, funnel } = makePatcherHarness({});
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		inject(leaf, SOURCE_OPEN_A(), { match: {} });
		expect(funnel.recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', {
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
		// ...and the landing is handed to the restorer, so its injected settle
		// verifies the same line core was given.
		expect(state.injectedLeafStates.get('leaf-1')).toMatchObject({ scroll: 10 });
	});

	it('a traversal carrying the target entry landing injects THAT over the file record', () => {
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

	it('a landing armed for another file never lands on the open that stole the flag', () => {
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

