// Unit tests for Restorer.completeInjectedRestore — the 'active-leaf-change'
// completion for injected opens that never fired 'file-open' (background
// opens, restart-restored tabs whose activation changes no file). The logic
// this pins down:
//  - no unconsumed injected marker on the active leaf -> never run a restore
//    (a real open's own file-open already consumed its marker, so this must
//    not double-restore / race the file switch);
//  - pre-layoutReady nothing runs (startup restore owns its own file-open
//    flow; background leaves aren't built yet);
//  - a non-markdown active view never completes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileView, MarkdownView, type WorkspaceLeaf } from 'obsidian';

import { Restorer } from '@/position/restore/restorer';
import { RestoreModes } from '@/position/restore/modes';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

// OpenCover styles leaf DOM via Obsidian's HTMLElement.setCssStyles
// extension, which jsdom lacks.
beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

function makeLeaf(id: string): WorkspaceLeaf {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf;
}

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};

// Source-mode markdown view: the injected marker is only ever set for a
// source open, so the restore must dispatch to restoreInjectedSource, which
// needs no async reading render. No editor.cm means the pixel settle no-ops.
function makeSourceView(leaf: WorkspaceLeaf, filePath = 'a.md'): MarkdownView {
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf,
		file: { path: filePath },
		getMode: () => 'source',
		currentMode: { getScroll: () => 10 },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: { getCursor: () => undefined },
		setEphemeralState: () => undefined,
	});
	// The active-leaf-change event carries the leaf, and completeInjectedRestore
	// reads leaf.view.file.path to slide lastActiveFilePath — wire it so the
	// slide is exercised, not silently undefined.
	leaf.view = view;
	return view;
}

// Reading-mode markdown view with a "ready" renderer (sizer + preview
// scroller) so the masked restore can apply and confirm the saved scroll.
function makePreviewView(leaf: WorkspaceLeaf, filePath = 'a.md'): MarkdownView {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	const sizer = document.createElement('div');
	const child = document.createElement('div');
	sizer.className = 'markdown-preview-sizer';
	sizer.append(child);
	sizer.style.height = '1000px';
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	scroller.style.height = '1000px';
	containerEl.append(sizer, scroller);
	let currentScroll = 0;
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf,
		file: { path: filePath },
		getMode: () => 'preview',
		currentMode: { getScroll: () => currentScroll },
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			currentScroll = (s.scroll as number) ?? 0;
			scroller.scrollTop = currentScroll;
		},
	});
	leaf.view = view;
	return view;
}

type Harness = {
	state: PositionState;
	leaf: WorkspaceLeaf;
	restorer: Restorer;
};

let coveredLeaves: WorkspaceLeaf[] = [];
let harnessCovers: PositionState | undefined;

function makeHarness(opts: { layoutReady?: boolean; marker?: boolean; activeIsMarkdown?: boolean; filePath?: string; glideSource?: boolean } = {}): Harness {
	const { layoutReady = true, marker = true, activeIsMarkdown = true, filePath = 'a.md', glideSource = false } = opts;
	const state = new PositionState(DEFAULT_SETTINGS);
	const leaf = makeLeaf('leaf-1');
	const view = activeIsMarkdown ? makeSourceView(leaf, filePath) : undefined;
	const app = {
		workspace: {
			layoutReady,
			// A MarkdownView satisfies both FileView and MarkdownView queries
			// (the stub mirrors `MarkdownView extends FileView`).
			getActiveViewOfType: (Type: unknown) =>
				activeIsMarkdown && (Type === MarkdownView || Type === FileView) ? view : undefined,
			iterateAllLeaves: () => undefined,
		},
	};
	const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
	const restorer = new Restorer(
		app as never,
		glideSource ? { ...DEFAULT_SETTINGS, sourceRestoreMethod: 'glide' } : DEFAULT_SETTINGS,
		store,
		state,
	);
	if (marker) {
		state.injectedOpenLeafIds.add('leaf-1');
		state.handledLeafIdMap.set('leaf-1', filePath);
		state.cover.cover(leaf);
		coveredLeaves.push(leaf);
		harnessCovers = state;
	}
	return { state, leaf, restorer };
}

afterEach(() => {
	// Stop the first-paint cover's rAF reapply loop for covered leaves.
	coveredLeaves.forEach((leaf) => harnessCovers?.cover.uncover(leaf));
	coveredLeaves = [];
	harnessCovers = undefined;
	// Drop prototype spies (RestoreModes) — a surviving one would silently
	// stub out the restore every later test in this file expects to run.
	vi.restoreAllMocks();
});

describe('Restorer.completeInjectedRestore', () => {
	it('活动 leaf 没有注入标记时什么都不做', async () => {
		const { state, leaf, restorer } = makeHarness({ marker: false });
		// The active file changed from the previous leaf — the signature of a
		// genuine open whose own file-open already consumed the marker and
		// restored; this completion must not double-restore or race it.
		state.lastActiveFilePath = 'b.md';

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.lastLoadedFilePath).toBeUndefined();
		expect(state.injectedOpenLeafIds.size).toBe(0);
		// The track still slid (pre-await) to the newly active file for the
		// NEXT activation.
		expect(state.lastActiveFilePath).toBe('a.md');
	});

	it('完成一次还没被消费的注入打开：落定、揭幕、锚定', async () => {
		const { state, leaf, restorer } = makeHarness();

		await restorer.completeInjectedRestore(leaf);

		expect(state.injectedOpenLeafIds.size).toBe(0);
		expect(state.restoreRun).toBe(1);
		expect(state.lastLoadedFilePath).toBe('a.md');
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('glide 设置不会把一个盖着的注入打开变成 glide（盖布必须掀开）', async () => {
		// A history traversal (back/forward) injects and covers REGARDLESS of
		// the glide setting ("must land instantly"). Dispatching it to
		// glideRestore left the first-paint cover stuck — glideRestore never
		// uncovers — blanking the leaf until the 2s cover safety timer: the
		// long blank reported on navigate-back with edit-glide selected.
		const { state, leaf, restorer } = makeHarness({ glideSource: true });

		await restorer.completeInjectedRestore(leaf);

		expect(state.injectedOpenLeafIds.size).toBe(0);
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('注入打开落定到补丁交给它的那个落点，而不是存储里的记录', async () => {
		// A cross-file history jump: the patch injects the TARGET ENTRY's own
		// position (what the browser row shows) and hands it over here. The
		// store record deliberately differs — it holds the spot the user had
		// drifted to when they left the file — so settling to it would yank
		// the view off the line core was told to land on.
		const { state, leaf, restorer } = makeHarness();
		state.injectedLeafStates.set('leaf-1', { scroll: 77 });
		const settle = vi.spyOn(RestoreModes.prototype, 'restoreInjectedSource')
			.mockResolvedValue(undefined);

		await restorer.completeInjectedRestore(leaf);

		expect(settle).toHaveBeenCalledTimes(1);
		expect(settle.mock.calls[0][1]).toMatchObject({ scroll: 77 });
		// consumed with the marker: a later open must not reuse it
		expect(state.injectedLeafStates.size).toBe(0);
	});

	it('没有交下落点时就退回存储记录', async () => {
		const { state, leaf, restorer } = makeHarness();
		const settle = vi.spyOn(RestoreModes.prototype, 'restoreInjectedSource')
			.mockResolvedValue(undefined);

		await restorer.completeInjectedRestore(leaf);

		expect(settle.mock.calls[0][1]).toMatchObject({ scroll: RECORD.scroll });
		expect(state.injectedLeafStates.size).toBe(0);
	});

	it('一次导航跳转正在压着提示时不显示落点提示', async () => {
		// NavStack arms cueSuppressUntil on back/forward: the restore still
		// lands (and anchors) but must not show the position-restored chip.
		const { state, leaf, restorer } = makeHarness();
		const show = vi.spyOn(state.cue, 'show');
		state.cueSuppressUntil = Date.now() + 1000;

		await restorer.completeInjectedRestore(leaf);

		expect(state.lastLoadedFilePath).toBe('a.md'); // restore ran and anchored
		expect(show).not.toHaveBeenCalled();

		// Expired deadline: the next ordinary restore shows the chip again.
		state.injectedOpenLeafIds.add('leaf-1');
		state.cueSuppressUntil = Date.now() - 1;
		await restorer.completeInjectedRestore(leaf);
		expect(show).toHaveBeenCalled();
	});

	it('同一 leaf+file 的恢复正在飞时，跳过重复的那次再次声明', async () => {
		// The two entry points ('file-open' and the 'active-leaf-change'
		// completion) can both fire for one open. The first consumes the
		// injected marker and starts the settle; the second, landing while it
		// is still in flight, must be skipped — not supersede, not reveal the
		// first-paint cover mid-settle, not bump the restore run.
		const { state, restorer } = makeHarness();
		const first = restorer.restoreEphemeralState();
		const second = restorer.restoreEphemeralState();
		await Promise.all([first, second]);

		expect(state.restoreRun).toBe(1); // no supersession from the duplicate
		expect(state.injectedOpenLeafIds.size).toBe(0); // marker consumed once
		expect(state.lastLoadedFilePath).toBe('a.md');
		expect(state.inFlightRestoreLeafRuns.size).toBe(0); // cleaned up
	});

	it('同一个 leaf 上换了文件，不被正在飞的那一对挡住', async () => {
		// Rapid file switch: an in-flight restore of a.md must not make the
		// guard swallow a b.md open on the same leaf. Seed the a.md pair as
		// in-flight; the b.md open on the same leaf must still restore.
		const { state, restorer } = makeHarness({ filePath: 'b.md' });
		state.injectedOpenLeafIds.delete('leaf-1'); // a.md's marker consumed
		state.handledLeafIdMap.delete('leaf-1'); // fresh b.md open, no dedup
		state.inFlightRestoreLeafRuns.set('leaf-1', { filePath: 'a.md', run: 1 });

		await restorer.restoreEphemeralState();

		expect(state.lastLoadedFilePath).toBe('b.md');
		expect(state.restoreRun).toBe(1); // the b.md open actually restored
		// The b.md restore superseded the seeded a.md entry and cleaned up.
		expect(state.inFlightRestoreLeafRuns.size).toBe(0);
	});

	it('layout-ready 之前什么都不做，把标记留给真正的那次激活', async () => {
		const { state, leaf, restorer } = makeHarness({ layoutReady: false });

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
	});

	it('活动视图不是 markdown 视图时什么都不做', async () => {
		const { state, leaf, restorer } = makeHarness({ activeIsMarkdown: false });

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
	});

	it('同文件激活时恢复一个未处理的阅读 leaf（既没有标记，也没有 file-open）', async () => {
		// A deferred reading tab's activation builds its view but changes no
		// active FILE, so no 'file-open' fires and the injected marker never
		// exists. The event carries only the new leaf, so the previously
		// active file is tracked by the plugin itself (lastActiveFilePath);
		// a matching previous file is the signature of exactly this case.
		const state = new PositionState(DEFAULT_SETTINGS);
		state.lastActiveFilePath = 'a.md';
		const leaf = makeLeaf('leaf-1');
		const view = makePreviewView(leaf, 'a.md');
		const app = {
			workspace: {
				layoutReady: true,
				getActiveViewOfType: (Type: unknown) =>
					(Type === MarkdownView || Type === FileView) ? view : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			store,
			state,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(1);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.lastLoadedFilePath).toBe('a.md');
	});

	it('活动文件变了就绝不恢复（一次真正的打开自己有 file-open）', async () => {
		// The previously active file differs: this is a real file switch,
		// whose own 'file-open' will restore — the completion must not race it.
		const state = new PositionState(DEFAULT_SETTINGS);
		state.lastActiveFilePath = 'b.md';
		const leaf = makeLeaf('leaf-1');
		const view = makePreviewView(leaf, 'a.md');
		const app = {
			workspace: {
				layoutReady: true,
				getActiveViewOfType: (Type: unknown) =>
					(Type === MarkdownView || Type === FileView) ? view : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			store,
			state,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.handledLeafIdMap.has('leaf-1')).toBe(false);
	});

	it('已经处理过的 leaf，其同文件激活跳过', async () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		state.lastActiveFilePath = 'a.md';
		const leaf = makeLeaf('leaf-1');
		const view = makePreviewView(leaf, 'a.md');
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const app = {
			workspace: {
				layoutReady: true,
				getActiveViewOfType: (Type: unknown) =>
					(Type === MarkdownView || Type === FileView) ? view : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(app as never, { db: { 'a.md': RECORD } } as never);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			store,
			state,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});
});