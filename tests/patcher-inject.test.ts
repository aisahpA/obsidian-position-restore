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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { OpenPatcher } from '../src/patcher';
import { TabStore } from '../src/tab-store';
import { PositionState } from '../src/position-state';
import { TabStateRecord,DEFAULT_SETTINGS } from '../src/types';

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
) {
	const state = new PositionState(DEFAULT_SETTINGS);
	const leaf = makeLeaf('leaf-1');
	const app = { workspace: { layoutReady } } as never;
	const tabStore = new TabStore(app, { db } as never, state);
	// The TabStore constructor loads lastStateByLeaf from storage; tests with
	// a preset map re-assign it after construction.
	state.lastStateByLeaf = lastStateByLeaf;
	const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, tabStore);
	const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);
	disposables.push(() => state.cover.uncover(leaf));
	return { state, leaf, inject };
}

afterEach(() => {
	disposables.forEach((fn) => fn());
	disposables = [];
});

describe('OpenPatcher open classification', () => {
	it('a fresh open injects the saved position, covers, and records the pair', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('a fresh open with a caller target (search match) yields and records the pair', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('a fresh open with a bare cached eState (startup native cache) yields and records the pair', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { scroll: 5 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('a replay whose eState echoes the record re-injects under the cover', () => {
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

	it('a replay clears a stale pending open kind from an open that never fired file-open', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		state.pendingOpenKind.set(leaf, 'callerTarget');
		const eState = { scroll: 10, cursor: RECORD.cursor };

		inject(leaf, SOURCE_OPEN_A(), eState);

		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('a replay with an empty eState (quick switcher re-pick) stays native', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(result).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});
	
	it('a startup replay with a position-less eState ({focus:true} rebuild) re-injects', () => {
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

	it('a caller-target eState carrying focus still yields on a startup replay', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD }, new Map(), false);
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { focus: true, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('a replay whose cached position diverged from the record stays native', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { scroll: 99 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('a replay still yields to a genuine caller target (match)', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('a different file on the same leaf resets the handled marker', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined);

		// No record for b.md, default position: nothing to inject.
		expect(result).toBeUndefined();
		expect(state.handledLeafIdMap.has('leaf-1')).toBe(false);
	});

	it('a per-tab record wins over the per-file record', () => {
		// Per-file says scroll 10; this tab was at scroll 99 when Obsidian quit.
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 99 });
	});

	it('a per-tab record does not shadow a caller target', () => {
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);
		const eState = { match: {} };

		expect(inject(leaf, SOURCE_OPEN_A(), eState)).toBe(eState);
	});

	it('a per-tab record whose file changed reads as no record (path guard)', () => {
		const { leaf, inject } = makeHarness(
			{ 'b.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
	});
});
