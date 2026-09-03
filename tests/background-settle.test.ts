// Unit tests for BackgroundSettler.completeBackgroundRestores — the startup
// sweep that settles background split tabs whose open never fired
// 'file-open'. What this pins down:
//  - a built background source-injected leaf: settled under its cover, marker
//    consumed, cover lifted — and the ACTIVE-leaf recording baseline
//    (lastLoadedFilePath / lastEphemeralState) is left untouched;
//  - a built background reading leaf (no marker): restored from its saved
//    record via the no-anchor masked path and recorded as handled;
//  - a caller-target-handled leaf (Obsidian's own cached position) is skipped;
//  - the active leaf is never touched;
//  - a deferred leaf (no editor) keeps its marker and reports pending;
//  - a stale marker (handled pair moved to another file) is consumed, not settled;
//  - a leaf owned by an in-flight restore is skipped untouched;
//  - a built leaf with no saved record is skipped;
//  - a scroll-0 (cursor-only) injection is revealed only, never settled.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MarkdownView, type WorkspaceLeaf } from 'obsidian';

import { BackgroundSettler } from '../src/background-settle';
import { TabStore } from '../src/tab-store';
import { PositionState } from '../src/position-state';
import { DEFAULT_SETTINGS } from '../src/types';

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

function makeLeaf(id: string, view: MarkdownView): WorkspaceLeaf {
	const leaf = { id, view, containerEl: view.containerEl } as unknown as WorkspaceLeaf;
	(view as { leaf?: unknown }).leaf = leaf;
	return leaf;
}

// Source-mode record: scroll plus the cursor a source save contributes.
const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};

// Reading-mode record: scroll-only — a preview save never contributes a
// cursor. A cursor-bearing record would keep waitForRestorePainted
// re-applying for its full deadline (the reading readback can't match it),
// so it would slow the reading-restore test without pinning real behavior.
const READING_RECORD = { scroll: RECORD.scroll };

// Source-mode markdown view. No editor.cm means the pixel settle no-ops.
function makeSourceView(filePath = 'a.md'): MarkdownView {
	// The stub's MarkdownView ignores its leaf arg; a cast satisfies the real
	// constructor signature (constructor(leaf: WorkspaceLeaf)).
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		file: { path: filePath },
		getMode: () => 'source',
		currentMode: { getScroll: () => 10 },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: { getCursor: () => undefined },
		setEphemeralState: () => undefined,
	});
	return view;
}

// Reading-mode markdown view whose renderer is "ready": a sizer with content
// (isContentReady) and a real preview scroller that setEphemeralState moves,
// so waitForRestorePainted confirms the applied scroll. Obsidian's MarkdownView
// always constructs its source editor (mode only swaps the shown subview), so
// a reading view still has one — its getCursor readback just yields no cursor.
function makePreviewView(filePath = 'a.md'): MarkdownView & { setEphemeralState: (s: Record<string, unknown>) => void } {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	const sizer = document.createElement('div');
	const child = document.createElement('div');
	sizer.className = 'markdown-preview-sizer';
	sizer.append(child);
	sizer.style.height = '1000px';
	// jsdom does no layout, so scrollHeight is always 0 — isContentReady would
	// stay false and waitForContentReady would burn its 2000ms deadline. Stub
	// the "renderer produced content" signal the real browser computes.
	Object.defineProperty(sizer, 'scrollHeight', { value: 1000, configurable: true });
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	scroller.style.height = '1000px';
	containerEl.append(sizer, scroller);

	let currentScroll = 0;
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		file: { path: filePath },
		getMode: () => 'preview',
		currentMode: {
			getScroll: () => currentScroll,
		},
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			const scroll = (s.scroll as number) ?? 0;
			currentScroll = scroll;
			scroller.scrollTop = scroll;
		},
	});
	return view as MarkdownView & { setEphemeralState: (s: Record<string, unknown>) => void };
}

type LeafSpec = { id: string; view: MarkdownView };
type HarnessOpts = {
	active?: LeafSpec;
	leaves: LeafSpec[];
	layoutReady?: boolean;
	db?: Record<string, unknown>;
};

type Harness = {
	state: PositionState;
	settler: BackgroundSettler;
	leafObjs: Record<string, WorkspaceLeaf>;
};

function makeHarness(opts: HarnessOpts): Harness {
	const { active, leaves, layoutReady = true, db = { 'a.md': RECORD } } = opts;
	const state = new PositionState(DEFAULT_SETTINGS);
	const leafObjs: Record<string, WorkspaceLeaf> = {};
	for (const { id, view } of leaves)
		leafObjs[id] = makeLeaf(id, view);
	const activeView = active ? leafObjs[active.id]?.view : undefined;
	const app = {
		workspace: {
			layoutReady,
			getActiveViewOfType: (Type: unknown) =>
				active && activeView && (Type === MarkdownView) ? activeView : undefined,
			iterateAllLeaves: (cb: (leaf: unknown) => void) => {
				leaves.forEach(({ id }) => cb(leafObjs[id]));
			},
		},
	};
	const tabStore = new TabStore(app as never, { db } as never, state);
	const settler = new BackgroundSettler(app as never, DEFAULT_SETTINGS, tabStore);
	return { state, settler, leafObjs };
}

let coveredLeaves: WorkspaceLeaf[] = [];
let harnessCovers: PositionState | undefined;

function markInjected(state: PositionState, leafObjs: WorkspaceLeaf[], filePath = 'a.md') {
	for (const leaf of leafObjs) {
		state.injectedOpenLeafIds.add((leaf as unknown as { id: string }).id);
		state.handledLeafIdMap.set((leaf as unknown as { id: string }).id, filePath);
		state.cover.cover(leaf);
		coveredLeaves.push(leaf);
	}
	harnessCovers = state;
}

afterEach(() => {
	coveredLeaves.forEach((leaf) => harnessCovers?.cover.uncover(leaf));
	coveredLeaves = [];
	harnessCovers = undefined;
});

describe('BackgroundSettler.completeBackgroundRestores', () => {
	it('settles a built background source-injected leaf and leaves the active baseline alone', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg] });
		markInjected(state, [leafObjs['leaf-bg']]);
		state.lastLoadedFilePath = 'active.md';
		state.lastEphemeralState = { scroll: 1 };

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(false);
		expect(state.cover.isCovered(leafObjs['leaf-bg'])).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('a.md');
		// The background settle must never touch the active leaf's recording baseline.
		expect(state.lastLoadedFilePath).toBe('active.md');
		expect(state.lastEphemeralState).toEqual({ scroll: 1 });
	});

	it('restores a built background reading leaf via the masked path and records it handled', async () => {
		const bg = { id: 'leaf-bg', view: makePreviewView('a.md') };
		const { state, settler } = makeHarness({ leaves: [bg], db: { 'a.md': READING_RECORD } });
		state.lastLoadedFilePath = 'active.md';

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('a.md');
		// The saved scroll was applied to the view.
		expect(bg.view.currentMode.getScroll()).toBe(RECORD.scroll);
		// Baseline untouched.
		expect(state.lastLoadedFilePath).toBe('active.md');
		expect(state.lastEphemeralState).toBeUndefined();
	});

	it('skips a caller-target-handled leaf (Obsidian native cached position wins)', async () => {
		const bg = { id: 'leaf-bg', view: makePreviewView('a.md') };
		const { state, settler } = makeHarness({ leaves: [bg] });
		state.handledLeafIdMap.set('leaf-bg', 'a.md');

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('a.md');
		expect(bg.view.currentMode.getScroll()).toBe(0); // nothing applied
		expect(state.lastLoadedFilePath).toBeUndefined();
	});

	it('never touches the active leaf', async () => {
		const active = { id: 'leaf-active', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ active, leaves: [active] });
		markInjected(state, [leafObjs['leaf-active']]);

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-active')).toBe(true);
		expect(state.cover.isCovered(leafObjs['leaf-active'])).toBe(true);
	});

	it('keeps the marker of a deferred leaf (no editor) and reports pending', async () => {
		const deferred = { id: 'leaf-def', view: makeSourceView('a.md') };
		delete (deferred.view as { editor?: unknown }).editor;
		const { state, settler, leafObjs } = makeHarness({ leaves: [deferred] });
		markInjected(state, [leafObjs['leaf-def']]);

		expect(await settler.completeBackgroundRestores()).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-def')).toBe(true);
		expect(state.cover.isCovered(leafObjs['leaf-def'])).toBe(true);
	});

	it('consumes a stale marker whose handled pair moved to another file', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg] });
		markInjected(state, [leafObjs['leaf-bg']], 'a.md');
		state.handledLeafIdMap.set('leaf-bg', 'b.md'); // leaf moved on, marker stale

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(false);
		// The stale pair was left alone — the sweep never re-settled b.md.
		expect(state.handledLeafIdMap.get('leaf-bg')).toBe('b.md');
	});

	it('does nothing before layout-ready', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg], layoutReady: false });
		markInjected(state, [leafObjs['leaf-bg']]);

		expect(await settler.completeBackgroundRestores()).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(true);
	});

	it('skips a leaf owned by an in-flight restore, untouched', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({ leaves: [bg] });
		markInjected(state, [leafObjs['leaf-bg']]);
		state.inFlightRestoreLeafRuns.set('leaf-bg', { filePath: 'a.md', run: 1 });

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(true);
		expect(state.cover.isCovered(leafObjs['leaf-bg'])).toBe(true);
	});

	it('skips a built background leaf with no saved record', async () => {
		const bg = { id: 'leaf-bg', view: makePreviewView('a.md') };
		const { state, settler } = makeHarness({ leaves: [bg], db: {} });

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.handledLeafIdMap.get('leaf-bg')).toBeUndefined();
		expect(bg.view.currentMode.getScroll()).toBe(0); // nothing applied
	});

	it('reveals a scroll-0 (cursor-only) injected leaf without settling', async () => {
		const bg = { id: 'leaf-bg', view: makeSourceView('a.md') };
		const { state, settler, leafObjs } = makeHarness({
			leaves: [bg],
			db: { 'a.md': { cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } } } },
		});
		markInjected(state, [leafObjs['leaf-bg']]);

		expect(await settler.completeBackgroundRestores()).toBe(true);

		expect(state.injectedOpenLeafIds.has('leaf-bg')).toBe(false);
		expect(state.cover.isCovered(leafObjs['leaf-bg'])).toBe(false);
	});
});