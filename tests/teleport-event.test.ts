// Unit tests for the desktop per-selection-event teleport detection
// (Sampler.onEditorSelection): event granularity replaces the poll's
// 100ms-tick rule on desktop, with the reader's own line threshold — the harness
// pins 10 because these tests are about the detector, not the shipped default
// (0, pinned by its own test below). Covers the rolling baseline contract
// (refreshed even on gated-off movement), the selection exclusion, the
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
	// The threshold is pinned here: DEFAULT_SETTINGS ships 0 (inferred steps off),
	// and everything below is about the detector, not about the default.
	const settings = { ...DEFAULT_SETTINGS, navHistoryTeleportMinLines: 10,
		...options?.settings } as PluginSettings;
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
	const editor = { getCursor: () => ({ ...cursor }), somethingSelected: () => false };
	view.editor = editor as never;
	return {
		sampler, state, funnel, view, onSelection, cursor, editor, entries,
		get index() { return index.value; },
	};
}

describe('Sampler.onEditorSelection —— 逐事件的跳变检测', () => {
	it('压入一次远距离跳跃及其落点，并用轮询读数刷新那条打开记录', () => {
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

	it('按住键的小幅移动永不压入，但基线继续滚动', () => {
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

	it('阈值由读者定：同一个移动，低于它什么都不是、高于它就是一次跳跃', () => {
		const h = makeHarness({ settings: { navHistoryTeleportMinLines: 30 } });

		h.cursor.line = 5;
		h.onSelection(h.editor); // baseline: line 5
		h.cursor.line = 25; // 20 lines — under the 30 the reader asked for
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.cursor.line = 90; // 65 lines from the rolled baseline, over it
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 90, expect.anything());
	});

	it('默认值就是关掉：不记录任何推断出来的跳变', () => {
		expect(DEFAULT_SETTINGS.navHistoryTeleportMinLines).toBe(0);
		const h = makeHarness({
			settings: { navHistoryTeleportMinLines: DEFAULT_SETTINGS.navHistoryTeleportMinLines },
		});

		h.onSelection(h.editor); // baseline: line 3
		h.cursor.line = 900;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();
	});

	it('有选区不算跳跃，也不留下基线', () => {
		const h = makeHarness();
		const editor = h.editor as unknown as { somethingSelected: () => boolean };

		h.onSelection(h.editor); // baseline: line 3
		editor.somethingSelected = () => true;
		h.cursor.line = 900; // Cmd+A: the anchor sits at one end of the file
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// The selection collapsed elsewhere: measuring from its far anchor would read
		// the collapse itself as a jump.
		editor.somethingSelected = () => false;
		h.cursor.line = 950;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// Baseline re-armed at 950 — only a real move from there counts.
		h.cursor.line = 1000;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenLastCalledWith('a.md', 'leaf-1', 1000, expect.anything());
	});

	it('换文件时重置基线，之后在新文件里记录跳跃', () => {
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

	it('跳过插件还没加载完的那个文件', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'other.md';

		h.cursor.line = 600;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();
	});

	it('被搜索锚住的那一跳静默重置基线，好让锚之后的这次移动是干净的', () => {
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

	it('即便在同一文件内，恢复时的重新锚定也会重置基线', () => {
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

	it('进行中的恢复被吸收，但为下一次移动重置基线', () => {
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

	it('光标当时在视口外时，把一条离开步落到视口上', () => {
		// The user scrolled the cursor line off screen, then jumped away: the
		// left entry must describe the viewport it actually showed, not the
		// invisible cursor line — which is where the anchor is taken from. NO
		// WORDS come along: a step keeps none (see ephemeral.ts's landingContext,
		// which the place list asks for when it records a landing).
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
		});
	});

	it('紧接着的第二次跳跃不动第一次的落点，自己另压一条', () => {
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

	it('事件之后 CM 才应用跳跃滚动时，替换掉落点的 scroll', () => {
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

	it('滚动校正跳过一条已经被用户或后一次跳跃离开的记录', () => {
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

	it('落点读不出来时静默降级', () => {
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
describe('跳变监听器只在桌面安装', () => {
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

	it('桌面安装逐事件的监听器', () => {
		expect(installCount(true)).toBe(1);
	});

	it('手机什么都不装 —— 它的轮询也不做任何推断', () => {
		expect(installCount(false)).toBe(0);
	});
});
