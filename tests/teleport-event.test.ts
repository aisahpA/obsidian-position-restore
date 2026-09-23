// Unit tests for the desktop per-selection-event teleport detection
// (Sampler.onEditorSelection): event granularity replaces the poll's
// 100ms-tick rule on desktop, with the reader's own line threshold (VSCode's 10
// is where it starts). Covers the
// rolling baseline contract (refreshed even on gated-off movement), the
// file-switch reset, the re-anchor epoch (restore landings reset silently),
// the restore/search-anchor gates, and the landing-position contract: the
// pushed entry carries the post-jump read and is never overwritten by a
// later leave (precise-return semantics).

import { describe, it, expect, vi } from 'vitest';

import { MarkdownView, Platform } from 'obsidian';
import { Sampler } from '@/position/capture/sampler';
import { PositionManager } from '@/position/manager';
import { PositionState } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, EphemeralState, PluginSettings } from '@/types';
import { NavJump, NavTeleport, NavVisit } from '@/nav/entry';

// The harness only ever builds pathful entries; excluding NavView (which has
// neither path nor st) keeps `.path`/`.st` readable without casts.
type TestEntry = NavJump | NavVisit | NavTeleport;

// A fake markdown view: real prototype chain (so instanceof passes) with the
// minimal surface the handler touches, attached in one untyped assign to
// dodge the obsidian typings.
function makeFakeMarkdownView(path: string): MarkdownView {
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path },
		currentMode: { getScroll: () => 42.3 }, // quantizes to 42
		editor: null as unknown,
	}) as MarkdownView;
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1' };
	return view;
}

// Builds the sampler over a spy FUNNEL that also plays the stack's half of each
// broadcast, so the entries the tests read are the ones the real stack would
// build: recordTeleport pushes (filling the landing from its 4th argument), leave
// refreshes the top — path+leaf guarded, keyed entries keep/backfill their
// landing, keyless ones overwritten — and landing replaces the top teleport's
// landing, exactly as the stack's onLanded does.
function makeHarness(options?: { entries?: TestEntry[]; settings?: Partial<PluginSettings> }) {
	const view = makeFakeMarkdownView('a.md');
	const app = {
		workspace: {
			getActiveViewOfType: () => view,
		},
	};
	const settings = { ...DEFAULT_SETTINGS, ...options?.settings } as PluginSettings;
	const state = new PositionState(settings);
	state.lastLoadedFilePath = 'a.md';
	const entries = options?.entries ?? [];
	// The stack's pointer, boxed so the live getter below can expose it.
	const index = { value: entries.length - 1 };
	const funnel = {
		leave: vi.fn((path: string, leafId: string, st: EphemeralState) => {
			const top = entries[index.value];
			if (top && top.path === path && top.leafId === leafId) {
				if (top.kind === 'jump' || top.kind === 'teleport') {
					if (!top.st)
						top.st = st;
					return;
				}
				top.st = st;
			}
		}),
		recordTeleport: vi.fn((path: string, leafId: string, line: number, landing?: EphemeralState) => {
			entries.length = index.value + 1;
			entries.push({ kind: 'teleport', path, leafId, line, t: Date.now() });
			index.value = entries.length - 1;
			const top = entries[index.value];
			if (landing && !top.st)
				top.st = landing;
		}),
		// The stack's onLanded: a late landing only reaches a teleport still on top.
		landing: vi.fn((entry: { kind: string; path: string; leafId: string; line: number; st?: EphemeralState }) => {
			const top = entries[index.value];
			if (!top || top.kind !== 'teleport' || top.path !== entry.path
				|| top.leafId !== entry.leafId || top.line !== entry.line)
				return;
			if (entry.st)
				top.st = entry.st;
		}),
	};
	const store = new PositionStore(
		app as never,
		{ db: {}, setState: vi.fn(), deleteFile: vi.fn() } as never,
	);
	const sampler = new Sampler(
		app as never,
		store,
		settings,
		state,
		funnel as never,
	);
	const onSelection = (sampler as unknown as { onEditorSelection: (editor: unknown) => void }).onEditorSelection;
	// The handler runs against this editor; the cursor is mutated per step.
	const cursor = { line: 3, ch: 0 };
	const editor = { getCursor: () => ({ ...cursor }) };
	view.editor = editor as never;
	return {
		sampler, state, funnel, view, onSelection, cursor, editor, entries,
		get index() { return index.value; },
	};
}

describe('Sampler.onEditorSelection — per-event teleport detection', () => {
	it('pushes a far jump with its landing position and refreshes the open entry with the poll read', () => {
		const h = makeHarness({ entries: [{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 }] });
		const pollRead: EphemeralState = { scroll: 10, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };
		h.state.lastEphemeralState = pollRead;

		h.onSelection(h.editor); // baseline: line 3
		h.cursor.line = 500;
		h.onSelection(h.editor);

		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 500, {
			scroll: 42,
			cursor: { from: { line: 500, ch: 0 }, to: { line: 500, ch: 0 } },
		});
		expect(h.funnel.leave).toHaveBeenCalledWith('a.md', 'leaf-1', pollRead);
	});

	it('never pushes for held-key small moves, but keeps the baseline rolling', () => {
		const h = makeHarness();

		h.cursor.line = 5;
		h.onSelection(h.editor);
		h.cursor.line = 7;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// A later far jump compares against the rolled baseline (7), not the
		// initial one (3).
		h.cursor.line = 20;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 20, expect.anything());
	});

	it('the reader’s threshold decides: the same move is nothing below it and a jump above it', () => {
		const h = makeHarness({ settings: { navTeleportMinLines: 30 } });

		h.cursor.line = 5;
		h.onSelection(h.editor); // baseline: line 5
		h.cursor.line = 25; // 20 lines — under the 30 the reader asked for
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.cursor.line = 90; // 65 lines from the rolled baseline, over it
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 90, expect.anything());
	});

	it('resets the baseline on a file switch, then records jumps in the new file', () => {
		const h = makeHarness();

		h.onSelection(h.editor); // baseline: line 3 in a.md
		h.cursor.line = 600;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 600, expect.anything());

		(h.view as { file: { path: string } }).file = { path: 'b.md' };
		h.state.lastLoadedFilePath = 'b.md';
		h.cursor.line = 2;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledTimes(1); // switch absorbed

		h.cursor.line = 900;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenLastCalledWith('b.md', 'leaf-1', 900, expect.anything());
	});

	it('skips the file the plugin has not loaded', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'other.md';

		h.cursor.line = 600;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();
	});

	it('search-anchored hops re-baseline silently so the post-anchor move is clean', () => {
		const h = makeHarness();

		h.onSelection(h.editor); // baseline: line 3
		h.state.searchAnchorUntil = Number.POSITIVE_INFINITY;

		h.cursor.line = 800;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// Anchor expired: the first deliberate move is small and must NOT
		// read as a jump against the stale pre-search line.
		h.state.searchAnchorUntil = 0;
		h.cursor.line = 802;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.cursor.line = 900;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenLastCalledWith('a.md', 'leaf-1', 900, expect.anything());
	});

	it('resets the baseline on a restore re-anchor even within the same file', () => {
		const h = makeHarness();

		h.onSelection(h.editor); // baseline: line 3
		h.state.lastAnchorAt = Date.now(); // restore landed at line 800

		h.cursor.line = 805;
		h.onSelection(h.editor);
		// 805 vs the stale baseline 3 would read as a jump without the epoch reset.
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.cursor.line = 900;
		h.onSelection(h.editor);
		// Baseline rolled to 805: a 95-line move from there is a real jump.
		expect(h.funnel.recordTeleport).toHaveBeenLastCalledWith('a.md', 'leaf-1', 900, expect.anything());
	});

	it('restores in flight absorb but re-baseline for the next move', () => {
		const h = makeHarness();

		h.onSelection(h.editor); // baseline: line 3
		h.state.restoreStarted();

		h.cursor.line = 800;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.state.restoreEnded();
		h.cursor.line = 805;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled(); // 5-line move, baseline rolled to 800
	});

	it('ignores editors that are not the active view\'s editor', () => {
		const h = makeHarness();
		h.state.lastEphemeralState = { scroll: 1, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		const embedEditor = { getCursor: () => ({ line: 900, ch: 0 }) };
		h.onSelection(embedEditor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// The baseline must be untouched: a 1-line real move is not a jump.
		h.cursor.line = 4;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();
	});

	it('lands a left entry on the viewport when its cursor sat outside it', () => {
		// The user scrolled the cursor line off screen, then jumped away: the
		// left entry must describe the viewport it actually showed, not the
		// invisible cursor line — the capture decides this and records the
		// answer (contextAt), so the assertion is the recorded landing.
		const h = makeHarness({ entries: [{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 }] });
		const pollRead: EphemeralState = { scroll: 10, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };
		h.state.lastEphemeralState = pollRead;
		// Line 4 (1-based) sits at offset 30; the rendered range ends at 25 —
		// the baseline cursor line is unrendered, i.e. off screen.
		const editor = h.editor as unknown as Record<string, unknown>;
		editor.getLine = (n: number) => `line ${n}`;
		editor.lastLine = () => 1000;
		editor.cm = {
			state: { doc: { lines: 1000, line: (n: number) => ({ from: (n - 1) * 10 }) } },
			viewport: { from: 0, to: 25 },
			scrollDOM: document.createElement('div'),
			coordsAtPos: () => null,
			defaultLineHeight: 20,
		};

		h.onSelection(h.editor); // baseline: line 3
		h.cursor.line = 500;
		h.onSelection(h.editor);

		expect(h.funnel.leave).toHaveBeenCalledWith('a.md', 'leaf-1', {
			scroll: 10,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
			anchor: 'line 10',
			// The off-screen cursor makes the landing the VIEWPORT top (10), and
			// the recorded block runs five lines either side of it.
			context: Array.from({ length: 11 }, (_, i) => ({ line: 5 + i, text: `line ${5 + i}` })),
			contextAt: 5,
		});
	});

	it('a rapid second jump leaves the first landing intact and pushes its own', () => {
		const h = makeHarness();
		// Stale poll read (both jumps happen inside one tick) — it must never
		// touch the first jump's landing.
		h.state.lastEphemeralState = { scroll: 10, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		h.onSelection(h.editor); // baseline: line 3
		h.cursor.line = 500; // jump 1
		h.onSelection(h.editor);
		h.cursor.line = 900; // jump 2: the teleport top must not be overwritten
		h.onSelection(h.editor);

		const first = h.entries[h.index - 1];
		expect((first as { line?: number }).line).toBe(500);
		expect(first.st).toEqual({
			scroll: 42,
			cursor: { from: { line: 500, ch: 0 }, to: { line: 500, ch: 0 } },
		});
		expect((h.entries[h.index] as { line?: number }).line).toBe(900);
		expect(h.entries[h.index].st).toEqual({
			scroll: 42,
			cursor: { from: { line: 900, ch: 0 }, to: { line: 900, ch: 0 } },
		});
	});

	it('replaces the landing scroll once CM applies the jump scroll after the event', () => {
		// CM applies the jump's scrollIntoView in its measure phase, after the
		// selection event: the push-time read still sees the origin scroll.
		const rafCbs: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCbs.push(cb); return rafCbs.length; });
		try {
			const h = makeHarness();
			h.onSelection(h.editor); // baseline: line 3
			h.cursor.line = 500;
			h.onSelection(h.editor);

			// Push-time landing: cursor at the target, scroll still the origin's.
			expect(h.entries[h.index].st).toEqual({
				scroll: 42,
				cursor: { from: { line: 500, ch: 0 }, to: { line: 500, ch: 0 } },
			});

			// The jump scroll lands; the frame correction replaces the landing.
			(h.view as unknown as { currentMode: { getScroll: () => number } }).currentMode.getScroll = () => 480.4;
			rafCbs.forEach((cb) => cb(0));
			expect(h.entries[h.index].st).toEqual({
				scroll: 480,
				cursor: { from: { line: 500, ch: 0 }, to: { line: 500, ch: 0 } },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('the scroll correction skips an entry the user or a later jump has left', () => {
		const rafCbs: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCbs.push(cb); return rafCbs.length; });
		try {
			const h = makeHarness();
			h.onSelection(h.editor); // baseline: line 3
			h.cursor.line = 500;
			h.onSelection(h.editor); // jump 1
			h.cursor.line = 900;
			h.onSelection(h.editor); // jump 2 — top moved on before any frame fired

			(h.view as unknown as { currentMode: { getScroll: () => number } }).currentMode.getScroll = () => 480.4;
			rafCbs.forEach((cb) => cb(0));
			// The 500 entry keeps its push-time landing (its cursor guard fails:
			// the cursor is at 900, and it is no longer the top entry); the 900
			// entry gets its own correction.
			expect(h.entries[h.index - 1].st).toEqual({
				scroll: 42,
				cursor: { from: { line: 500, ch: 0 }, to: { line: 500, ch: 0 } },
			});
			expect(h.entries[h.index].st).toEqual({
				scroll: 480,
				cursor: { from: { line: 900, ch: 0 }, to: { line: 900, ch: 0 } },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('degrades silently when the landing is unreadable', () => {
		const h = makeHarness();
		(h.view as unknown as { currentMode: unknown }).currentMode = { getScroll: () => NaN };

		h.onSelection(h.editor); // baseline: line 3
		h.cursor.line = 500;
		h.onSelection(h.editor);

		expect((h.entries[h.index] as { line?: number }).line).toBe(500);
		expect(h.entries[h.index].st).toBeUndefined();
	});
});

// The other half of "mobile records no cursor jumps". The handler above is
// driven by a workspace listener, and that listener is a DESKTOP-ONLY install
// (PositionManager.installPatches branches on Platform.isDesktopApp); the
// mobile poll path is deleted. A touch device therefore has no teleport source
// at all — which is what the threshold setting's own description promises the
// reader, so the branch that keeps that promise is pinned here.
describe('the teleport watcher is installed on desktop only', () => {
	function installCount(desktop: boolean): number {
		const wasDesktop = Platform.isDesktopApp;
		Platform.isDesktopApp = desktop;
		try {
			const spy = vi.spyOn(Sampler.prototype, 'installTeleportWatcher');
			const app = {
				workspace: {
					containerEl: document.createElement('div'),
					on: () => ({}),
					offref: () => undefined,
					getActiveViewOfType: () => null,
					iterateAllLeaves: () => undefined,
				},
				metadataCache: { on: () => ({}), offref: () => undefined, getFileCache: () => null },
				vault: { getName: () => 'Test', getAbstractFileByPath: () => null },
			};
			const manager = new PositionManager(
				app as never,
				{ db: {} } as never,
				{ ...DEFAULT_SETTINGS } as PluginSettings,
			);
			manager.installPatches(() => undefined);
			return spy.mock.calls.length;
		} finally {
			Platform.isDesktopApp = wasDesktop;
			vi.restoreAllMocks();
		}
	}

	it('desktop installs the per-event watcher', () => {
		expect(installCount(true)).toBe(1);
	});

	it('mobile installs nothing — and its poll infers nothing either', () => {
		expect(installCount(false)).toBe(0);
	});
});
