// position/ui/cue.ts 的两次「出声」——恢复后的面包屑与落点标记——以及它们各自的开关。
//   · breadcrumbPath：面包屑念哪几个名字（纯，从笔记文本读）；
//   · show() 的两道门：开关关着不碰视图；**这一屏上有标题就不复述**（`hasVisibleHeading` ——
//     念的前提是屏幕上没有标题，2026-10-09 用户拍板）；
//   · 从一次真实恢复走到底：落点标记只在编辑模式取光标那一行（阅读模式恢复不标），
//     标的方式是给元素加 core 自己的 .is-flashing、不动视口，
//     以及前进后退带来的恢复不标（那一路自己标过一次）；
//   · 编辑模式下一次「点名一行」的跳转怎么落：视口只动一次（居中那一次），种子不落，
//     居中做不到时才退回种子，而回读到的落点要等编辑器真正应用了那次滚动。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
// 它的小节元素由一个假的渲染器章节给出 —— flashLine 在阅读模式下做的就是给那个
// 元素加 core 自己的 .is-flashing（**不再**去要一次揭示：那条路会把落点拉回视口顶，
// 把手机上刚让开的带子收回）。恢复路径现在不碰它，用例断言它没被标。
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
		// scroll 那一行所在的章节：jump 路径下 flashLine 会闪它，恢复路径不再碰。
		// start.line == scroll，lines 1 覆盖它。
		previewMode: { renderer: { sections: [{ start: { line: scroll }, lines: 1, el: sectionEl }] } },
	});
	return { view, sectionEl };
}

// 小节元素有没有被标。阅读模式下闪与不闪唯一的可见表现就是它。
const isFlashing = (el: HTMLElement): boolean => el.classList.contains('is-flashing');

const rect = (top: number, bottom: number): DOMRect =>
	({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top }) as DOMRect;

afterEach(() => {
	vi.restoreAllMocks();
});

describe('面包屑的开关', () => {
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
});

// 带假 CM6 的源码视图：源码模式下 flashLine 经 editor.cm.domAtPos 找 .cm-line。
// jsdom 的 Node 没有 Obsidian 打的 instanceOf 补丁（见 cue.ts 的 sourceLineElement），
// 假行元素自己补一个。
function makeCmSourceView(cursorLine: number): { view: MarkdownView; lineEl: HTMLElement } {
	const lineEl = document.createElement('div');
	lineEl.className = 'cm-line';
	(lineEl as unknown as { instanceOf: (C: Function) => boolean }).instanceOf =
		function (this: HTMLElement, C: Function) { return this instanceof C; };
	const view = fakeView({
		leaf: { id: 'leaf-1' },
		file: { path: 'a.md' },
		getMode: () => 'source',
		currentMode: { getScroll: () => 30 },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: {
			getCursor: () => ({ line: cursorLine, ch: 0 }),
			cm: {
				state: { doc: { lines: 100, line: (n: number) => ({ from: n - 1 }) } },
				domAtPos: () => ({ node: lineEl, offset: 0 }),
				posAtCoords: () => null,
			},
		},
		setEphemeralState: vi.fn(),
	});
	return { view, lineEl };
}

describe('落点标记（flashLandingLine）', () => {
	it('恢复后，阅读视图什么都不标', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(state);
		const { view, sectionEl } = makePreviewView(12);

		await modes.historyJumpApply(view, { scroll: 12 }, () => true, 0);

		// 即使开关开着：阅读模式恢复不闪，视口顶就是唯一落点。
		expect(isFlashing(sectionEl)).toBe(false);
	});

	it('编辑视图恢复选的是光标那一行，不是视口顶部那一行', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(state);
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

	it('光标那一行真的拿到 core 的 .is-flashing', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(state);
		const { view, lineEl } = makeCmSourceView(7);

		await modes.historyJumpApply(view, { scroll: 0 }, () => true, 0);

		expect(isFlashing(lineEl)).toBe(true);
	});

	it('关掉之后，恢复不再标出', async () => {
		const s = settings({ flashLandingLine: false });
		const state = new PositionState(s);
		const modes = new RestoreModes(state);
		const { view, lineEl } = makeCmSourceView(7);

		await modes.historyJumpApply(view, { scroll: 0 }, () => true, 0);

		expect(isFlashing(lineEl)).toBe(false);
	});

	it('前进后退带来的恢复不标，即使编辑模式也不标：那一路自己标过一次', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(state);
		const { view } = makeSourceView(0);
		const flashLine = vi.spyOn(state.cue, 'flashLine').mockImplementation(() => undefined);
		// NavStack 的遍历装的就是它：目的地是读者自己选的，不带提示。
		state.cueSuppressUntil = Date.now() + 60_000;

		await modes.historyJumpApply(view, { scroll: 0 }, () => true, 0);

		expect(flashLine).not.toHaveBeenCalled();
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
		const modes = new RestoreModes(state);
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
		const modes = new RestoreModes(state);
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
		const modes = new RestoreModes(state);
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
		const modes = new RestoreModes(state);
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
		const modes = new RestoreModes(state);
		const { view, applied } = makeSourceView(30);

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(60) }, () => true, 0);

		expect(applied[0]).toEqual({ scroll: 25, cursor: cursorAt(60) });
	});
});

// 面包屑的锚是哪一行 —— 2026-10-09 用户报的「误报……上面顶部的章节」。
describe('面包屑的锚：本次落点，不是视口顶', () => {
	const cursorAt = (line: number) => ({ from: { line, ch: 0 }, to: { line, ch: 0 } });

	it('点名一行的跳转：念的是落点那一节，不是半屏之上那一节', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(state);
		// 视口顶落在第 30 行 —— 而落点（点名的第 60 行）被摆到了视口正中，于是
		// 「上面顶部那一行」在**上一个**小节里，照它命名就会念错名字。
		const { view } = makeSourceView(30);
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };
		const show = vi.spyOn(state.cue, 'show').mockImplementation(() => undefined);

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(60) }, () => true, 0);

		expect(show).toHaveBeenCalledWith(view, 60);
	});

	it('普通的位置恢复：调用方给不出落点行，退回视口顶那一行', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(state);
		const { view } = makeSourceView(30);
		const show = vi.spyOn(state.cue, 'show').mockImplementation(() => undefined);

		await modes.historyJumpApply(view, { scroll: 25, cursor: cursorAt(7) }, () => true, 0);

		// 一次保存位置的恢复里，落点**就是**视口顶 —— 没有「点名了一行」这回事。
		expect(show).toHaveBeenCalledWith(view, undefined);
	});
});

// 面包屑**念的前提是屏幕上没有标题**（2026-10-09 用户拍板）—— 这一屏上只要有标题可看，
// 读者自己就知道在哪一节，复述是噪音。判据是「标题自己的 DOM 矩形」与滚动容器的可见矩形
// 求交：屏上看得见标题 ⇒ 不念；标题都在屏外 ⇒ 念。
//
// ⚠️ 这不是「把旧门加回来」那么简单：旧的三版判据都**不看标题的矩形** —— 第十、十一、十二轮
// 分别在 `.cm-scroller` 取样点、`contentDOM` 五点取样、CM6 的 `viewport` 上摔过（前两个的取样
// 点会落空 / 大半落在屏外；`viewport` 是**已渲染**范围、比可视区大一圈）。两条反向验证各钉住
// 一端：①「屏上有标题却照念」（无门那版）；②「标题滚出屏还静默」（`viewport` 那版）。
describe('面包屑：这一屏上有标题就不复述', () => {
	// showChip / hide 都会调 Web Animations API，jsdom 没有。
	beforeEach(() => {
		(Element.prototype as unknown as { animate: unknown }).animate = () => ({});
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// 一篇**很长**的笔记：第 0 行一个一级标题（breadcrumbPath 会把它拿掉），此后每 10 行一个
	// 二级标题，其余是正文。标题行：0, 10, 20, …（0-based）。落点取第 25 行 —— 它那一节的名字
	// 是 H20，于是面包屑有话可说（不会在 breadcrumbPath 那一步就空掉）。
	const LINES = 200;
	const text = Array.from(
		{ length: LINES },
		(_, i) => (i % 10 === 0 ? `${i === 0 ? '#' : '##'} H${i}` : `l${i}`),
	).join('\n');
	const LANDING = 25;

	const hasChip = (view: MarkdownView): boolean => view.contentEl.querySelector('.position-restore-cue') !== null;

	// 一个**阅读**视图：屏上摆几个标题（各自的矩形由调用方给）由调用方定。容器留给
	// getScroller（它找 `.markdown-preview-view`）与 hasVisibleHeading（它扫 h1~h6）。
	const previewView = (headingRects: DOMRect[]): MarkdownView => {
		const scroller = document.createElement('div');
		scroller.className = 'markdown-preview-view';
		scroller.getBoundingClientRect = () => rect(0, 400);
		for (const hr of headingRects) {
			const h = document.createElement('h2');
			h.getBoundingClientRect = () => hr;
			scroller.appendChild(h);
		}
		const containerEl = document.createElement('div');
		containerEl.appendChild(scroller);
		return fakeView({
			getMode: () => 'preview',
			containerEl,
			contentEl: document.createElement('div'),
			currentMode: { getScroll: () => LANDING },
			data: text,
		});
	};

	// 一个**源码**视图：编辑器报的已渲染范围（`viewport`）与每一行「在不在屏上」由调用方摆。
	// 行的元素按 **1-based 行号**登记；可见的行给容器内的矩形，其余给容器外的。
	const sourceView = (opts: {
		rendered: { from: number; to: number };
		visibleLines: number[];
		editor?: unknown;
	}): MarkdownView => {
		const scroller = document.createElement('div');
		scroller.className = 'cm-scroller';
		scroller.getBoundingClientRect = () => rect(0, 400);
		const contentEl = document.createElement('div');
		contentEl.appendChild(scroller);
		const visible = new Set(opts.visibleLines);
		const els = new Map<number, HTMLElement>();
		const lineEl = (n: number): HTMLElement => {
			let el = els.get(n);
			if (!el) {
				el = document.createElement('div');
				el.className = 'cm-line';
				// jsdom 的 Node 没有 Obsidian 打的 instanceOf 补丁（见 cue.ts 的 sourceLineElement）。
				(el as unknown as { instanceOf: (C: Function) => boolean }).instanceOf =
					function (this: HTMLElement, C: Function) { return this instanceof C; };
				el.getBoundingClientRect = visible.has(n) ? () => rect(120, 150) : () => rect(1000, 1030);
				els.set(n, el);
			}
			return el;
		};
		const doc = {
			lines: LINES,
			length: LINES,
			line: (n: number) => ({ from: n }),               // from 取 1-based 行号
			lineAt: (pos: number) => ({ number: Math.min(Math.max(pos, 1), LINES) }),
		};
		const editor = opts.editor ?? {
			cm: {
				state: { doc },
				viewport: opts.rendered,
				domAtPos: (pos: number) => ({ node: lineEl(pos), offset: 0 }),
			},
		};
		return fakeView({
			getMode: () => 'source',
			contentEl,
			containerEl: document.createElement('div'),
			currentMode: { getScroll: () => 0 },
			data: text,
			editor,
		});
	};

	it('阅读模式：这一屏上已经能看到标题，就不复述', () => {
		// 一个 <h2> 落在容器 0~400 里（屏上）。落点在 H20 那一节、而 H20 已经在眼前。
		const view = previewView([rect(40, 70)]);
		new RestoreCue(settings()).show(view, LANDING);
		expect(hasChip(view)).toBe(false);
	});

	it('阅读模式：标题都滚出屏了，就念', () => {
		// 唯一的 <h2> 在容器上方之外。
		const view = previewView([rect(-200, -170)]);
		new RestoreCue(settings()).show(view, LANDING);
		expect(hasChip(view)).toBe(true);
	});

	it('源码模式：标题行在屏上，就不复述', () => {
		// 已渲染 1~200 行；标题行（1-based）是 1/11/21/…。让 H20 那一行（21）的矩形落在容器里。
		const view = sourceView({ rendered: { from: 1, to: LINES }, visibleLines: [21] });
		new RestoreCue(settings()).show(view, LANDING);
		expect(hasChip(view)).toBe(false);
	});

	it('源码模式：标题都在已渲染范围里、却都滚出屏了，就念', () => {
		// ⚠️ 这条钉的正是 `viewport` 那版判据的错：标题行都落在**已渲染**范围里，但没有任何一个
		// 标题的**矩形**还在屏上 —— 老判据会以为「看得见」而静默，新判据照念。
		const view = sourceView({ rendered: { from: 1, to: LINES }, visibleLines: [] });
		new RestoreCue(settings()).show(view, LANDING);
		expect(hasChip(view)).toBe(true);
	});

	it('源码模式：编辑器还没建出来也念 —— 那正是长标题链最需要面包屑的时候', () => {
		const view = sourceView({ rendered: { from: 1, to: LINES }, visibleLines: [], editor: {} });
		new RestoreCue(settings()).show(view, LANDING);
		expect(hasChip(view)).toBe(true);
	});

	it('落点还没走进任何小节里时不念 —— 那是 breadcrumbPath 的事，与屏幕无关', () => {
		const view = sourceView({ rendered: { from: 1, to: LINES }, visibleLines: [] });
		// 落点在第 5 行：唯一的那个一级标题已被 breadcrumbPath 拿掉，还没走到 H10 那一节。
		new RestoreCue(settings()).show(view, 5);
		expect(hasChip(view)).toBe(false);
	});
});
