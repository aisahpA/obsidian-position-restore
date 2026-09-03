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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileView, MarkdownView, type WorkspaceLeaf } from 'obsidian';

import { Restorer } from '../src/restorer';
import { TabStore } from '../src/tab-store';
import { PositionState } from '../src/position-state';
import { DEFAULT_SETTINGS } from '../src/types';

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

function makeHarness(opts: { layoutReady?: boolean; marker?: boolean; activeIsMarkdown?: boolean; filePath?: string } = {}): Harness {
	const { layoutReady = true, marker = true, activeIsMarkdown = true, filePath = 'a.md' } = opts;
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
	const tabStore = new TabStore(app as never, { db: { 'a.md': RECORD } } as never, state);
	const restorer = new Restorer(
		app as never,
		DEFAULT_SETTINGS,
		tabStore,
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
});

describe('Restorer.completeInjectedRestore', () => {
	it('does nothing when the active leaf has no injected marker', async () => {
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

	it('completes an unconsumed injected open: settle, reveal, and anchor', async () => {
		const { state, leaf, restorer } = makeHarness();

		await restorer.completeInjectedRestore(leaf);

		expect(state.injectedOpenLeafIds.size).toBe(0);
		expect(state.restoreRun).toBe(1);
		expect(state.lastLoadedFilePath).toBe('a.md');
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('skips a duplicate re-assert while the same leaf+file restore is in flight', async () => {
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

	it('a different file on the same leaf is not blocked by the in-flight pair', async () => {
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

	it('does nothing before layout-ready and keeps the marker for the real activation', async () => {
		const { state, leaf, restorer } = makeHarness({ layoutReady: false });

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
	});

	it('does nothing when the active view is not a markdown view', async () => {
		const { state, leaf, restorer } = makeHarness({ activeIsMarkdown: false });

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
	});

	it('restores an unhandled reading leaf on a same-file activation (no marker, no file-open)', async () => {
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
		const tabStore = new TabStore(app as never, { db: { 'a.md': RECORD } } as never, state);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			tabStore,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(1);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.lastLoadedFilePath).toBe('a.md');
	});

	it('never restores when the active file changed (a genuine open owns its file-open)', async () => {
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
		const tabStore = new TabStore(app as never, { db: { 'a.md': RECORD } } as never, state);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			tabStore,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.handledLeafIdMap.has('leaf-1')).toBe(false);
	});

	it('skips a same-file activation of an already-handled leaf', async () => {
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
		const tabStore = new TabStore(app as never, { db: { 'a.md': RECORD } } as never, state);
		const restorer = new Restorer(
			app as never,
			DEFAULT_SETTINGS,
			tabStore,
		);

		await restorer.completeInjectedRestore(leaf);

		expect(state.restoreRun).toBe(0);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});
});