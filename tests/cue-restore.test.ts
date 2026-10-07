// position/ui/cue.ts 的两次「出声」——恢复后的面包屑与落点标记——以及它们各自的开关。
// 三层：
//   · breadcrumbPath：面包屑念哪几个名字（纯，从笔记文本读）；
//   · show() 的两道门：开关关着不碰视图、屏上已经有标题就不复述；
//   · 从一次真实恢复走到底：落点标记按模式各取哪一行（编辑取光标那一行、阅读取落点），
//     标的方式（阅读给落点那一块加 core 自己的 .is-flashing，不动视口），
//     以及前进后退带来的恢复不标（那一路自己标过一次）；
//   · 编辑模式下一次「点名一行」的跳转怎么落：视口只动一次（居中那一次），种子不落，
//     居中做不到时才退回种子，而回读到的落点要等编辑器真正应用了那次滚动。
//
// 屏幕上的几何（视口内有没有标题）在 jsdom 里一律是零矩形，所以那一条自己把矩形摆出来；
// CM6 那一侧（源码模式问编辑器视口上下沿落在哪一行）没有 jsdom 替身，不在本文件里。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarkdownView } from 'obsidian';

import { RestoreCue, breadcrumbPath } from '@/position/ui/cue';
import { headingsFromText } from '@/shared/headings';
import { RestoreModes } from '@/position/restore/modes';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS, type PluginSettings } from '@/types';

const path = (text: string, line: number) => breadcrumbPath(headingsFromText(text), line);

describe('breadcrumbPath：面包屑念哪几个名字', () => {
	it('整篇只有一个标题时，什么都不念', () => {
		// 那是笔记名，或它唯一的小节 —— 标签页上已经有了。
		expect(path('# Title\ntext', 1)).toEqual([]);
		expect(path('## Only\ntext', 1)).toEqual([]);
	});

	it('整篇只有一个一级标题时，把它从链里拿掉', () => {
		// 一级标题多半就是文章标题，正印在标签页上。
		const text = '# Title\ntext\n## A\ntext\n### B\ntext';
		expect(path(text, 5)).toEqual(['A', 'B']);
		expect(path(text, 3)).toEqual(['A']);
		// 落点还在那唯一的一级标题底下、但还没走到 A：链是空的，不必说话。
		expect(path(text, 1)).toEqual([]);
	});

	it('多个一级标题时留着它 —— 那是一章的名字', () => {
		expect(path('# Ch1\ntext\n# Ch2\n## B\ntext', 4)).toEqual(['Ch2', 'B']);
	});

	it('没有一级标题时，链原样', () => {
		expect(path('## A\ntext\n### B\ntext', 3)).toEqual(['A', 'B']);
	});
});

const settings = (patch: Partial<PluginSettings> = {}): PluginSettings => ({ ...DEFAULT_SETTINGS, ...patch });

const fakeView = (patch: Record<string, unknown>): MarkdownView =>
	Object.assign(new MarkdownView(undefined as never), patch) as unknown as MarkdownView;

// 一个什么都不做、只管记账的阅读视图：够 applyEphemeralState 与 flashLine 走完。
// 它的「落点那一块」由一个假的渲染器章节给出 —— flashLine 在阅读模式下做的就是给那个
// 元素加 core 自己的 .is-flashing（**不再**去要一次揭示：那条路会把落点拉回视口顶，
// 把手机上刚让开的带子收回），所以断言看的是那个类名。
function makePreviewView(scroll: number, cursorLine = 5): { view: MarkdownView; sectionEl: HTMLElement } {
	const sectionEl = document.createElement('div');
	sectionEl.className = 'markdown-preview-section';
	const view = fakeView({
		leaf: { id: 'leaf-1' },
		file: { path: 'a.md' },
		getMode: () => 'preview',
		currentMode: { getScroll: () => scroll },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: { getCursor: () => ({ line: cursorLine, ch: 0 }) },
		setEphemeralState: vi.fn(),
		// 落点那一行（markRestoredLine 在阅读模式下取 getScroll()）所在的章节 ——
		// flashLine 会闪它。start.line == 落点行，lines 1 覆盖它。
		previewMode: { renderer: { sections: [{ start: { line: scroll }, lines: 1, el: sectionEl }] } },
	});
	return { view, sectionEl };
}

// 落点那一块被标出来了吗。阅读模式的落点标记现在唯一的可见表现就是它。
const isFlashing = (el: HTMLElement): boolean => el.classList.contains('is-flashing');

const rect = (top: number, bottom: number): DOMRect =>
	({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top }) as DOMRect;

afterEach(() => {
	vi.restoreAllMocks();
});

describe('面包屑的开关与静音', () => {
	it('关掉之后，恢复什么都不做', () => {
		const cue = new RestoreCue(settings({ restoreBreadcrumb: false }));
		// 一碰就炸的视图：开关关着时 show() 不该碰它任何东西。
		const view = fakeView({ getMode: () => 'preview' });
		Object.defineProperty(view, 'data', {
			get: () => {
				throw new Error('开关关着时不该读笔记');
			},
		});
		expect(() => cue.show(view)).not.toThrow();
	});

	it('这一屏里已经能看到标题时，不复述', () => {
		const cue = new RestoreCue(settings());
		const containerEl = document.createElement('div');
		const scroller = document.createElement('div');
		scroller.className = 'markdown-preview-view';
		const heading = document.createElement('h2');
		heading.textContent = 'A';
		scroller.appendChild(heading);
		containerEl.appendChild(scroller);
		scroller.getBoundingClientRect = () => rect(0, 400);
		heading.getBoundingClientRect = () => rect(40, 70);

		const view = fakeView({
			getMode: () => 'preview',
			containerEl,
			contentEl: document.createElement('div'),
			currentMode: { getScroll: () => 3 },
			data: '# Title\ntext\n## A\ntext',
		});

		cue.show(view);

		expect(view.contentEl.querySelector('.position-restore-cue')).toBeNull();
	});
});

describe('落点标记（flashLandingLine）', () => {
	it('恢复后，阅读视图标出落点那一块（core 自己的 .is-flashing，不动视口）', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const { view, sectionEl } = makePreviewView(12);

		await modes.historyJumpApply(view, { scroll: 12 }, () => true, 0);

		expect(isFlashing(sectionEl)).toBe(true);
	});

	it('关掉之后，恢复不再标那一块', async () => {
		const s = settings({ flashLandingLine: false });
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const { view, sectionEl } = makePreviewView(12);

		await modes.historyJumpApply(view, { scroll: 12 }, () => true, 0);

		expect(isFlashing(sectionEl)).toBe(false);
	});

	it('编辑视图标的是光标那一行，不是视口顶部那一行', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const view = fakeView({
			leaf: { id: 'leaf-1' },
			file: { path: 'a.md' },
			getMode: () => 'source',
			currentMode: { getScroll: () => 30 },
			data: 'x',
			contentEl: document.createElement('div'),
			containerEl: document.createElement('div'),
			editor: { getCursor: () => ({ line: 7, ch: 0 }) },
			setEphemeralState: vi.fn(),
		});
		const flashLine = vi.spyOn(state.cue, 'flashLine').mockImplementation(() => undefined);

		// 落点给 0：这一次要钉住的是「标哪一行」，不是像素落定。
		await modes.historyJumpApply(view, { scroll: 0 }, () => true, 0);

		expect(flashLine).toHaveBeenCalledWith(view, 7);
	});

	it('前进后退带来的恢复不标 —— 那一路自己标过一次', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const { view, sectionEl } = makePreviewView(12);
		// NavStack 的遍历装的就是它：目的地是读者自己选的，不带提示。
		state.cueSuppressUntil = Date.now() + 60_000;

		await modes.historyJumpApply(view, { scroll: 12 }, () => true, 0);

		expect(isFlashing(sectionEl)).toBe(false);
	});
});

// 一个只管记账的源码视图：记下每一次 setEphemeralState 的参数（`applyEphemeralState` 就是
// 由它施加的），并让「视口顶」按给定的读数作答 —— 传函数时**逐次**求值，好让「编辑器晚一步
// 才应用那次滚动」这件事能被摆出来。
function makeSourceView(
	scroll: number | (() => number),
	cursorLine = 7,
): { view: MarkdownView; applied: Record<string, unknown>[] } {
	const applied: Record<string, unknown>[] = [];
	const view = fakeView({
		leaf: { id: 'leaf-1' },
		file: { path: 'a.md' },
		getMode: () => 'source',
		currentMode: { getScroll: typeof scroll === 'function' ? scroll : () => scroll },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: { getCursor: () => ({ line: cursorLine, ch: 0 }), scrollIntoView: vi.fn() },
		setEphemeralState: (st: Record<string, unknown>) => { applied.push(st); },
	});
	return { view, applied };
}

// modes 私有的那个像素纠正器 —— 要钉住的是「交给下游的落点」是哪一个值（另一个开关那条
// 用例 spy flashLine 是同一个路子）。
const pixelsOf = (modes: RestoreModes): { settleSourcePixels: (...args: unknown[]) => Promise<void> } =>
	(modes as unknown as { pixels: { settleSourcePixels: (...args: unknown[]) => Promise<void> } }).pixels;

describe('编辑模式跳转的落点：交给编辑器居中，视口只动一次', () => {
	const cursorAt = (line: number) => ({ from: { line, ch: 0 }, to: { line, ch: 0 } });

	it('点名一行时那一步只落光标 —— 视口不动，居中留给编辑器', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const { view, applied } = makeSourceView(30);
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(60) }, () => true, 0);

		// 种子（scroll 25）**不落**：它是按行号估的，core 的 applyScroll 拿区块平均插值，
		// 落下去必然离真实像素差一点 —— 而 core 的 setState 在带光标时会把滚动原样还回去，
		// 所以这一步不移动视口。跳转于是只动一下：居中那一下，动在真实像素上。
		expect(applied[0]).toEqual({ cursor: cursorAt(60) });
	});

	it('居中的结果交给下游：像素落定对着回读到的视口顶', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const { view } = makeSourceView(41.6);
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };
		const settle = vi.spyOn(pixelsOf(modes), 'settleSourcePixels').mockResolvedValue(undefined);

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(60) }, () => true, 0);

		// 41.6 → 42：落点记的是编辑器实际把那一行摆到的地方，不是当初估的那一行。
		expect(settle).toHaveBeenCalledWith(view, expect.objectContaining({ scroll: 42 }), expect.any(Function), expect.any(Number));
	});

	it('编辑器晚一帧才应用那次滚动时，回读等它 —— 不拿旧滚动去当落点', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		// `scrollIntoView` 是一个 effect，编辑器把它排进自己的测量趟：派发时那次回读、加上
		// 第一帧的回读，看到的都还是旧滚动，之后才落到居中处。
		let reads = 0;
		const { view } = makeSourceView(() => (reads++ < 2 ? 30 : 41.6));
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };
		const settle = vi.spyOn(pixelsOf(modes), 'settleSourcePixels').mockResolvedValue(undefined);

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(60) }, () => true, 0);

		// 拿旧滚动（30）当落点，会让下游那些「按 st.scroll 对齐到顶」的纠正器把刚居中的
		// 视口又拉回去。
		expect(settle).toHaveBeenCalledWith(view, expect.objectContaining({ scroll: 42 }), expect.any(Function), expect.any(Number));
	});

	it('居中做不到时退回种子 —— 那一刻它就是唯一的落点', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const { view, applied } = makeSourceView(30);
		// 编辑器还不认这个原语（例如视图刚建出来）。
		(view.editor as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
			throw new Error('editor not ready');
		};
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(60) }, () => true, 0);

		expect(applied[0]).toEqual({ cursor: cursorAt(60) });
		// 种子顶上 —— 这就是 jumpTopBiasLines 的源码分支如今唯一还承重的地方。
		expect(applied[1]).toEqual({ scroll: 25, cursor: cursorAt(60) });
	});

	it('没有点名一行的那一次（一次普通的 visit）：照旧整份施加', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const { view, applied } = makeSourceView(30);

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(60) }, () => true, 0);

		expect(applied[0]).toEqual({ scroll: 25, cursor: cursorAt(60) });
	});
});
