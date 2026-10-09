// 桌面端「逐选区事件」跳变检测（Sampler.onEditorSelection）的单元测试：
// 事件粒度取代了轮询的 100ms-tick 规则，阈值由读者自己定 —— 这里的 harness
// 钉死 10，因为这些测试考的是检测器、不是发布出去的默认值（0，由下面它自己的
// 测试钉住）。覆盖滚动基线契约（即便移动被门挡住也照样刷新）、选区排除、换文件
// 重置、重新锚定的纪元（恢复落点在静默中重置基线）、恢复/搜索锚的门，以及落点
// 契约：压入的记录带着跳跃后的读数，且永不被之后的离开覆盖（精确返回语义）。

import { describe, it, expect, vi } from 'vitest';

import { MarkdownView, Platform } from 'obsidian';
import { Sampler } from '@/position/capture/sampler';
import { PositionManager } from '@/position/manager';
import { PositionState } from '@/position/state';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS, EphemeralState, PluginSettings } from '@/types';
import { NavJump, NavTeleport, NavVisit } from '@/nav/entry';

// harness 只会造带路径的记录；排除 NavView（它既无 path 也无 st），
// 就能不做 cast 直接读 `.path`/`.st`。
type TestEntry = NavJump | NavVisit | NavTeleport;

// 假的 markdown 视图：真原型链（好让 instanceof 通过），只带处理函数会碰的
// 最小接口，用一次无类型赋值挂上去，绕开 obsidian 的类型声明。
function makeFakeMarkdownView(path: string): MarkdownView {
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path },
		currentMode: { getScroll: () => 42.3 }, // 量化为 42
		editor: null as unknown,
	}) as MarkdownView;
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1' };
	return view;
}

// 在 spy 出来的 FUNNEL 上搭 sampler，这个漏斗还扮演「每次广播里栈那一半」的
// 角色，好让测试读到的记录就是真栈会造出来的：recordTeleport 压入（用第 4 个
// 参数填落点），leave 刷新栈顶 —— 按 path+leaf 把门，带 key 的记录保留/回填
// 自己的落点、无 key 的直接覆盖 —— 而 landing 替换栈顶 teleport 的落点，跟
// 栈的 onLanded 分毫不差。
function makeHarness(options?: { entries?: TestEntry[]; settings?: Partial<PluginSettings> }) {
	const view = makeFakeMarkdownView('a.md');
	const app = {
		workspace: {
			getActiveViewOfType: () => view,
		},
	};
	// 阈值在这里钉死：DEFAULT_SETTINGS 发布的是 0（推断步关闭），
	// 下面这些考的都是检测器，不是默认值。
	const settings = { ...DEFAULT_SETTINGS, navHistoryTeleportMinLines: 10,
		...options?.settings } as PluginSettings;
	const state = new PositionState(settings);
	state.lastLoadedFilePath = 'a.md';
	const entries = options?.entries ?? [];
	// 栈的指针，装箱以便下面的实时 getter 暴露它。
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
		// 栈的 onLanded：迟到的落点只能触到仍在栈顶的那个 teleport。
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
	// 处理函数跑在这个 editor 上；光标每步都会被改。
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

		h.onSelection(h.editor); // 基线：第 3 行
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

		// 之后一次远跳是拿滚动后的基线（7）比的，不是最初那个（3）。
		h.cursor.line = 20;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 20, expect.anything());
	});

	it('阈值由读者定：同一个移动，低于它什么都不是、高于它就是一次跳跃', () => {
		const h = makeHarness({ settings: { navHistoryTeleportMinLines: 30 } });

		h.cursor.line = 5;
		h.onSelection(h.editor); // 基线：第 5 行
		h.cursor.line = 25; // 20 行 —— 低于读者要的 30
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.cursor.line = 90; // 距滚动后的基线 65 行，超过阈值
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 90, expect.anything());
	});

	it('默认值就是关掉：不记录任何推断出来的跳变', () => {
		expect(DEFAULT_SETTINGS.navHistoryTeleportMinLines).toBe(0);
		const h = makeHarness({
			settings: { navHistoryTeleportMinLines: DEFAULT_SETTINGS.navHistoryTeleportMinLines },
		});

		h.onSelection(h.editor); // 基线：第 3 行
		h.cursor.line = 900;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();
	});

	it('有选区不算跳跃，也不留下基线', () => {
		const h = makeHarness();
		const editor = h.editor as unknown as { somethingSelected: () => boolean };

		h.onSelection(h.editor); // 基线：第 3 行
		editor.somethingSelected = () => true;
		h.cursor.line = 900; // Cmd+A：锚点停在文件的一端
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// 选区在别处塌缩了：若拿它远端的锚来量，会把这次塌缩本身读成一次跳跃。
		editor.somethingSelected = () => false;
		h.cursor.line = 950;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// 基线在 950 处重新武装 —— 只有从那里算起的真实移动才算数。
		h.cursor.line = 1000;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenLastCalledWith('a.md', 'leaf-1', 1000, expect.anything());
	});

	it('换文件时重置基线，之后在新文件里记录跳跃', () => {
		const h = makeHarness();

		h.onSelection(h.editor); // 基线：a.md 的第 3 行
		h.cursor.line = 600;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledWith('a.md', 'leaf-1', 600, expect.anything());

		(h.view as { file: { path: string } }).file = { path: 'b.md' };
		h.state.lastLoadedFilePath = 'b.md';
		h.cursor.line = 2;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).toHaveBeenCalledTimes(1); // 换文件被吸收

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

		h.onSelection(h.editor); // 基线：第 3 行
		h.state.searchAnchorUntil = Number.POSITIVE_INFINITY;

		h.cursor.line = 800;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// 锚过期了：第一次有意移动很小，绝不能拿搜索前那条过期行来比、读成跳跃。
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

		h.onSelection(h.editor); // 基线：第 3 行
		h.state.lastAnchorAt = Date.now(); // 恢复落在第 800 行

		h.cursor.line = 805;
		h.onSelection(h.editor);
		// 若没有纪元重置，805 对着过期的基线 3 会被读成一次跳跃。
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.cursor.line = 900;
		h.onSelection(h.editor);
		// 基线滚到了 805：从那里算起的 95 行移动才算真跳跃。
		expect(h.funnel.recordTeleport).toHaveBeenLastCalledWith('a.md', 'leaf-1', 900, expect.anything());
	});

	it('进行中的恢复被吸收，但为下一次移动重置基线', () => {
		const h = makeHarness();

		h.onSelection(h.editor); // 基线：第 3 行
		h.state.restoreStarted();

		h.cursor.line = 800;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		h.state.restoreEnded();
		h.cursor.line = 805;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled(); // 5 行移动，基线滚到 800
	});

	it('不是活动视图那个 editor 的编辑器，一概无视', () => {
		const h = makeHarness();
		h.state.lastEphemeralState = { scroll: 1, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		const embedEditor = { getCursor: () => ({ line: 900, ch: 0 }) };
		h.onSelection(embedEditor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();

		// 基线必须原封不动：1 行的真实移动不算跳跃。
		h.cursor.line = 4;
		h.onSelection(h.editor);
		expect(h.funnel.recordTeleport).not.toHaveBeenCalled();
	});

	it('光标当时在视口外时，把一条离开步落到视口上', () => {
		// 用户把光标所在行滚出了屏幕，然后跳走：离开记录必须描述当时真正显示的
		// 视口，而不是那条看不见的光标行 —— 锚偏偏是从光标行取的。不带任何
		// 文字：一步不带文字（见 ephemeral.ts 的 landingContext，地点列表在
		// 记录落点时会去问它）。
		const h = makeHarness({ entries: [{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 }] });
		const pollRead: EphemeralState = { scroll: 10, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };
		h.state.lastEphemeralState = pollRead;
		// 第 4 行（1-based）位于偏移 30；已渲染范围止于 25 ——
		// 基线光标行未渲染，即不在屏幕上。
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

		h.onSelection(h.editor); // 基线：第 3 行
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
		// 过期的轮询读数（两次跳跃都发生在同一个 tick 内）—— 它绝不能碰到
		// 第一次跳跃的落点。
		h.state.lastEphemeralState = { scroll: 10, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		h.onSelection(h.editor); // 基线：第 3 行
		h.cursor.line = 500; // 跳跃 1
		h.onSelection(h.editor);
		h.cursor.line = 900; // 跳跃 2：栈顶 teleport 不能被覆盖
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
		// CM 在 measure 阶段才应用跳跃的 scrollIntoView，晚于选区事件：
		// 压入时的读数看到的还是起点滚动。
		const rafCbs: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCbs.push(cb); return rafCbs.length; });
		try {
			const h = makeHarness();
			h.onSelection(h.editor); // 基线：第 3 行
			h.cursor.line = 500;
			h.onSelection(h.editor);

			// 压入时的落点：光标已到目标，滚动还停在起点。
			expect(h.entries[h.index].st).toEqual({
				scroll: 42,
				cursor: { from: { line: 500, ch: 0 }, to: { line: 500, ch: 0 } },
			});

			// 跳跃滚动到位；这一帧的校正替换掉落点。
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
			h.onSelection(h.editor); // 基线：第 3 行
			h.cursor.line = 500;
			h.onSelection(h.editor); // 跳跃 1
			h.cursor.line = 900;
			h.onSelection(h.editor); // 跳跃 2 —— 还没等任何帧触发，栈顶就往前走了

			(h.view as unknown as { currentMode: { getScroll: () => number } }).currentMode.getScroll = () => 480.4;
			rafCbs.forEach((cb) => cb(0));
			// 500 那条保留压入时的落点（它的光标门没通过：光标在 900，且它
			// 已不是栈顶）；900 那条得到自己的校正。
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

		h.onSelection(h.editor); // 基线：第 3 行
		h.cursor.line = 500;
		h.onSelection(h.editor);

		expect((h.entries[h.index] as { line?: number }).line).toBe(500);
		expect(h.entries[h.index].st).toBeUndefined();
	});
});

// 「手机不记录光标跳跃」的另一半。上面的处理函数由 workspace 监听器驱动，
// 而这个监听器是**只在桌面**安装的（PositionManager.installPatches 按
// Platform.isDesktopApp 分支）；手机的轮询路径已删除。因此触屏设备根本没有
// 任何跳变来源 —— 这正是阈值设置自己的描述向读者承诺的，所以在这里把守住
// 这条承诺的分支钉住。
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
