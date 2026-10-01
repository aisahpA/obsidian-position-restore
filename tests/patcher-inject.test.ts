// Unit tests for the setViewState-patch open classification in OpenPatcher
// (injectEphemeralStateOnOpen). The logic this pins down — each with a
// debugged regression behind it:
//  - a fresh open injects the saved position and records the leaf+file pair
//    (seeded handled marker), so pairs whose open never fires 'file-open'
//    (background opens, startup restore) still dedup later switches;
//  - a REPLAY (setViewState for an already-handled leaf+file) must never read
//    the leaf's own cached eState as a caller target — that misjudgment
//    skipped the first-paint cover on the deferred rebuild after restart
//    (visible flicker) and left the pair unrecorded (the next switch
//    re-restored visibly);
//  - a replay re-injects ONLY when the replayed eState echoes the saved
//    record. An eState-less re-assert (quick switcher re-picking the current
//    file: setViewState, no following file-open) must stay native — covering
//    it leaves the mask up until the safety timer (~2s blank).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { MarkdownView } from 'obsidian';

import { OpenPatcher } from '@/position/restore/patcher';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { TabStateRecord,DEFAULT_SETTINGS } from '@/types';
// leafStates is private on the store; this is the test seam.
import { setLeafStates } from './support/position-store-seam';

// injectEphemeralStateOnOpen is private; tests drive it through this alias.
type ViewState = { type?: unknown; state?: { file?: unknown; mode?: unknown } };
type InjectFn = (
	leaf: WorkspaceLeaf,
	viewState: ViewState,
	eState: Record<string, unknown> | undefined,
) => unknown;

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

function makeLeaf(id: string, containerEl: ParentNode = document.createElement('div')): WorkspaceLeaf & { containerEl: ParentNode } {
	return {
		id,
		containerEl,
	} as unknown as WorkspaceLeaf & { containerEl: ParentNode };
}

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};
const SOURCE_OPEN_A = (file = 'a.md'): ViewState => ({
	type: 'markdown',
	state: { file, mode: 'source' },
});

beforeEach(() => {
	window.localStorage.clear();
});

let disposables: Array<() => void> = [];

function makeHarness(
	db: Record<string, unknown> = {},
	lastStateByLeaf: Map<string, TabStateRecord> = new Map(),
	layoutReady = true,
	// Where the leaf lives decides what it is: the default is a main-area pane,
	// and a test about a leaf hosted by a popover passes its own.
	leaf: WorkspaceLeaf & { containerEl: ParentNode } = makeLeaf('leaf-1'),
) {
	const state = new PositionState(DEFAULT_SETTINGS);
	const app = {
		workspace: {
			layoutReady,
			// Main area = the container this test leaf lives in.
			rootSplit: { containerEl: { contains: (el: unknown) => el === leaf.containerEl } },
		},
	} as never;
	const store = new PositionStore(app, { db } as never);
	// The store constructor seeds leafStates from storage; tests with a preset
	// map replace it after construction (private member → the seam cast).
	setLeafStates(store, lastStateByLeaf);
	const recordOpen = vi.fn();
	// The patcher is a pure CAPTURE point: it writes to the funnel and reads no
	// reader, so spies for what it calls are all it needs.
	const funnel = { recordOpen, recordTeleport: vi.fn(), leave: vi.fn(), settled: vi.fn(), landing: vi.fn() };
	const flushOnLeave = vi.fn();
	const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, store, state, funnel as never, { flushOnLeave } as never);
	const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);
	disposables.push(() => state.cover.uncover(leaf));
	return { state, leaf, inject, flushOnLeave, recordOpen };
}

afterEach(() => {
	disposables.forEach((fn) => fn());
	disposables = [];
});

describe('OpenPatcher 对「这是一次什么打开」的判定', () => {
	it('一次全新打开注入已存位置、盖上盖布，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('打开时把正要离开的视图状态刷进记录（快速移动会丢数据的那个窗口）', () => {
		const { leaf, inject, flushOnLeave } = makeHarness();
		const leavingView = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'b.md' },
			currentMode: { getScroll: () => 2.6 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }) },
		});
		(leaf as unknown as { view: unknown }).view = leavingView;

		inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(flushOnLeave).toHaveBeenCalledWith(leavingView, 'b.md', { scroll: 3 });
	});

	it('悬停浮层托着的 leaf 什么都不注入', () => {
		// A preview that happens to be an editable pane is a preview: it opens
		// where the app opens one. Restoring there lands the card on a line no
		// one pointed at, and the cover that comes with it holds the card blank
		// for as long as the settle takes.
		const popover = document.createElement('div');
		popover.className = 'hover-popover';
		const host = document.createElement('div');
		popover.appendChild(host);
		document.body.appendChild(popover);
		const { state, leaf, inject, recordOpen } =
			makeHarness({ 'a.md': RECORD }, undefined, true, makeLeaf('leaf-1', host));

		const result = inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(result).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		// Not a pane the reader opened, so not a step in their navigation either.
		expect(recordOpen).not.toHaveBeenCalled();
		popover.remove();
	});

	it('带 caller 目标（搜索命中）的全新打开让位给 core，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('只带着缓存 eState（启动时的原生缓存）的全新打开让位，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { scroll: 5 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('eState 与记录一致的回放，在盖布下重新注入', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { scroll: 10, cursor: RECORD.cursor };

		const result = inject(leaf, SOURCE_OPEN_A(), eState) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		// The replay keeps the handled marker and sets no open kind: the
		// follow-up file-open must reach the injected body, not the openKind
		// early return.
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('回放会清掉一次从未触发 file-open 的打开留下的陈旧 pending open kind', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		state.pendingOpenKind.set(leaf, 'callerTarget');
		const eState = { scroll: 10, cursor: RECORD.cursor };

		inject(leaf, SOURCE_OPEN_A(), eState);

		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('eState 为空的回放（快速切换器再次选中）保持原生行为', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(result).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});
	
	it('启动时带着没有位置的 eState 的回放（{focus:true} 重建）重新注入', () => {
		// Debugged 2026-09: before layout-ready, core re-asserts the ACTIVE
		// leaf with a second setViewState whose eState carries only
		// {focus:true} — the rebuilt editor loses the injected position and
		// lands at the top. Pre-layout-ready an empty eState is always that
		// rebuild, so the saved position must be injected again.
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD }, new Map(), false);
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A(), { focus: true }) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('带 focus 的 caller 目标 eState，在启动回放时仍然让位', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD }, new Map(), false);
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { focus: true, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('缓存位置已经与记录分叉的回放保持原生行为', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { scroll: 99 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('回放仍然对真正的 caller 目标（命中）让位', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('同一 leaf 上换了文件会重置已处理标记', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined);

		// No record for b.md, default position: nothing to inject.
		expect(result).toBeUndefined();
		expect(state.handledLeafIdMap.has('leaf-1')).toBe(false);
	});

	it('按标签页的记录胜过按文件的记录', () => {
		// Per-file says scroll 10; this tab was at scroll 99 when Obsidian quit.
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 99 });
	});

	it('按标签页的记录盖不住 caller 目标', () => {
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);
		const eState = { match: {} };

		expect(inject(leaf, SOURCE_OPEN_A(), eState)).toBe(eState);
	});

	it('文件已经变了的按标签页记录当作没有记录（路径守卫）', () => {
		const { leaf, inject } = makeHarness(
			{ 'b.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
	});

	it('侧边栏面板重新声明 state（大纲带着它所跟踪的文件）不算一次记录', () => {
		const { leaf, inject, recordOpen } = makeHarness();

		// The outline panel re-asserts its view state with the tracked file
		// in state.file; its leaf is not in the main area → no record.
		inject(
			makeLeaf('outline-leaf', document.createElement('aside')),
			{ type: 'outline', state: { file: 'a.md' } },
			undefined,
		);
		expect(recordOpen).not.toHaveBeenCalled();

		// Control: a main-area open records.
		inject(leaf, SOURCE_OPEN_A(), undefined);
		expect(recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', { key: undefined, force: false });
	});

	it('带 key 的锚点链接保留它的 key', () => {
		const { state, leaf, inject, recordOpen } = makeHarness();
		state.pendingLinkText = 'b.md#安装步骤';

		inject(leaf, SOURCE_OPEN_A('b.md'), undefined);

		expect(recordOpen).toHaveBeenCalledWith('b.md', 'leaf-1', {
			key: 'b.md#安装步骤',
			force: false,
		});
	});
});
