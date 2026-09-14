// Unit tests for the leaf-scoped restore supersession semantics — the fix
// for the cross-leaf stuck-cover bug. Restore staleness must be decided per
// leaf: only a newer restore on the SAME leaf (or that leaf's view moving to
// another file) supersedes an in-flight restore. A restore running
// concurrently on a DIFFERENT leaf must not invalidate it, or the first
// leaf's masked restore skips its reveal (the restore cover has no safety
// timer) and the pane stays at opacity 0 indefinitely.
//
// Two layers:
//  - PositionState::beginLeafRestore / isCurrentLeafRestore, the API the
//    fix is built on (fast, deterministic);
//  - one full-pipeline cross-leaf restore: leaf A parks mid-restore under
//    its cover, leaf B restores fully, and A must still reveal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarkdownView, FileView, type WorkspaceLeaf } from 'obsidian';

import { PositionState } from '@/position/state';
import { Restorer } from '@/position/restore/restorer';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS } from '@/types';

describe('PositionState leaf-scoped restore runs', () => {
	it('a restore on a different leaf does not supersede this leaf\'s in-flight restore', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const runA = state.beginLeafRestore('leafA', 'a.md');
		const runB = state.beginLeafRestore('leafB', 'b.md');

		expect(state.isCurrentLeafRestore('leafA', runA)).toBe(true);
		expect(state.isCurrentLeafRestore('leafB', runB)).toBe(true);
	});

	it('a newer restore on the SAME leaf supersedes the earlier one', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const run1 = state.beginLeafRestore('leafA', 'a.md');
		const run2 = state.beginLeafRestore('leafA', 'b.md'); // rapid same-leaf switch

		expect(state.isCurrentLeafRestore('leafA', run1)).toBe(false);
		expect(state.isCurrentLeafRestore('leafA', run2)).toBe(true);
	});

	it('clearing a leaf\'s in-flight entry stales its runs (winner finished)', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const run = state.beginLeafRestore('leafA', 'a.md');

		state.inFlightRestoreLeafRuns.delete('leafA');

		expect(state.isCurrentLeafRestore('leafA', run)).toBe(false);
	});

	it('run ids are unique over the session, so a cleanup can never hit a reused id', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const runA = state.beginLeafRestore('leafA', 'a.md');
		const runB = state.beginLeafRestore('leafB', 'b.md');

		expect(runB).toBe(runA + 1);
	});
});

// ---- Full-pipeline cross-leaf regression ----

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

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};

function makeLeaf(id: string): WorkspaceLeaf {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf;
}

// Reading-mode view that NEVER becomes content-ready in jsdom (no layout →
// sizer.scrollHeight stays 0), so its masked restore parks under its cover
// until the CONTENT_READY_MAX_MS deadline. Deterministic parking for the
// interleave test.
function makeParkedPreviewView(leaf: WorkspaceLeaf, filePath = 'a.md'): MarkdownView {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	scroller.style.height = '1000px';
	containerEl.append(scroller);
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

// Source-mode view: restores instantly (no async render to wait for), so it
// runs to completion while the parked preview is still covered.
function makeSourceView(leaf: WorkspaceLeaf, filePath = 'b.md'): MarkdownView {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	let currentScroll = 0;
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf,
		file: { path: filePath },
		getMode: () => 'source',
		currentMode: { getScroll: () => currentScroll },
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			currentScroll = (s.scroll as number) ?? 0;
		},
	});
	leaf.view = view;
	return view;
}

describe('cross-leaf restore concurrency (stuck-cover regression)', () => {
	it('a restore on a second leaf does not leave the first leaf stuck under its cover', async () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const leafA = makeLeaf('leafA');
		const leafB = makeLeaf('leafB');
		const viewA = makeParkedPreviewView(leafA, 'a.md');
		const viewB = makeSourceView(leafB, 'b.md');

		let activeView: MarkdownView | undefined = viewA;
		const app = {
			workspace: {
				layoutReady: true,
				// The stub mirrors `MarkdownView extends FileView`.
				getActiveViewOfType: (Type: unknown) =>
					activeView && (Type === MarkdownView || Type === FileView) ? activeView : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(
			app as never,
			{ db: { 'a.md': RECORD, 'b.md': RECORD } } as never,
		);
		const restorer = new Restorer(app as never, DEFAULT_SETTINGS, store, state);

		// Leaf A parks mid-masked-restore under its own restore cover.
		const promiseA = restorer.restoreEphemeralState();
		// Leaf B opens while A is still covered; its restore completes fully.
		activeView = viewB;
		await restorer.restoreEphemeralState();
		expect(state.restoreRun).toBe(2); // both restores actually ran

		// Let A unwind past its content-ready deadline and reveal.
		await promiseA;

		// The reveal ran for A too: its contentEl opacity was lifted. Under
		// the old single-global-counter isCurrent this stayed '0' forever.
		expect(viewA.contentEl.style.opacity).toBe('');
		expect(viewB.contentEl.style.opacity).toBe('');
	}, 15000);
});

afterEach(() => {
	vi.restoreAllMocks();
});