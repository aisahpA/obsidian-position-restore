// shared/jump-landing.ts —— 一次 jump 点名的「一行」在屏幕上摆哪儿，按 core 自己的
// 两条规则算：源码模式居中（往上让半个视口**再收一行**；真正的居中由编辑器自己完成，
// 这里只是个起点），阅读模式贴着顶，只在**顶上真有东西压着内容**时才让开被压住的那一条
// （手机上的浮层顶栏 + 它下面那条渐隐）。这里钉的是**偏移怎么量**，以及量不到时退回什么。
//
// jsdom 里所有矩形都是零，所以每一条自己把滚动容器与顶栏的矩形、以及 getComputedStyle
// 该答的东西摆出来。「顶栏压不压着内容」全由两个矩形回答 ⇒ 桌面（在流里）与手机浮动
// 导航（提成浮层）是同一套输入的两个取值，不需要翻转任何平台标志。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarkdownView } from 'obsidian';

import { jumpTopBiasLines } from '@/shared/jump-landing';

const LINE_PX = 20;
const VIEWPORT_PX = 800;
// 手机上压在阅读区顶上的带子 = 顶栏压住的那一段（安全区 + 顶栏高）+ 12px 的渐隐余量。
const FADE_MARGIN_PX = 12;

const fakeView = (patch: Record<string, unknown>): MarkdownView =>
	Object.assign(new MarkdownView(undefined as never), patch) as unknown as MarkdownView;

const rect = (top: number, bottom: number): DOMRect =>
	({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top }) as DOMRect;

// 一个源码模式的视图：滚动容器量得出 800px 高，编辑器每 20px 答一行。
// 视口上下沿各缩进 2px，与 cue 的 hasVisibleHeading 同一套问法 ⇒ 0 到 39 行，共 40 行。
function sourceView(): MarkdownView {
	const contentEl = document.createElement('div');
	const scroller = document.createElement('div');
	scroller.className = 'cm-scroller';
	contentEl.appendChild(scroller);
	scroller.getBoundingClientRect = () => rect(0, VIEWPORT_PX);

	return fakeView({
		getMode: () => 'source',
		file: { path: 'a.md' },
		contentEl,
		containerEl: document.createElement('div'),
		editor: {
			cm: {
				state: { doc: { lineAt: (pos: number) => ({ number: pos + 1 }) } },
				posAtCoords: ({ y }: { y: number }) => Math.floor(y / LINE_PX),
				defaultLineHeight: LINE_PX,
			},
		},
	});
}

// 一个阅读模式的视图。带子全由两个矩形回答：**顶栏底边减滚动容器顶边** —— 顶栏在流里时
// 内容就从它下面开始（差 ≤ 0，没有带子），被提成浮层时内容从它底下滚过（差 = 安全区 +
// 顶栏高）。`header` 传 null 表示这个视图压根没有顶栏。行高问 getComputedStyle。
function previewView(opts: {
	lineHeight: string;
	fontSize?: string;
	header?: { top: number; height: number } | null;
	scrollerTop?: number;
}): MarkdownView {
	const containerEl = document.createElement('div');
	const header = opts.header === null ? null : (opts.header ?? { top: 0, height: 0 });
	if (header) {
		const el = document.createElement('div');
		el.className = 'view-header';
		el.getBoundingClientRect = () => rect(header.top, header.top + header.height);
		containerEl.appendChild(el);
	}
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	const scrollerTop = opts.scrollerTop ?? 0;
	scroller.getBoundingClientRect = () => rect(scrollerTop, scrollerTop + 600);
	containerEl.appendChild(scroller);

	const real = window.getComputedStyle.bind(window);
	vi.spyOn(window, 'getComputedStyle').mockImplementation(((target: Element) => {
		if (target !== scroller)
			return real(target);
		return {
			lineHeight: opts.lineHeight,
			fontSize: opts.fontSize ?? '16px',
			getPropertyValue: () => '',
		} as unknown as CSSStyleDeclaration;
	}) as typeof window.getComputedStyle);

	return fakeView({
		getMode: () => 'preview',
		file: { path: 'a.md' },
		contentEl: document.createElement('div'),
		containerEl,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('jumpTopBiasLines —— 点名的那一行该往上让出几行', () => {
	it('源码模式让半个视口再收一行（那一行居中，与点大纲面板的标题一样）', () => {
		// 视口 40 行 ⇒ 让 20 行时那一行上方 20 行、下方只剩 19 行，读起来偏下；
		// 收一行才是眼睛说的「中间」。
		expect(jumpTopBiasLines(sourceView())).toBe(VIEWPORT_PX / LINE_PX / 2 - 1);
	});

	it('阅读模式在桌面端不让 —— 顶栏在流里，内容就从它下面开始', () => {
		// 顶栏底边 == 滚动容器顶边 ⇒ 没有东西压着内容。
		expect(jumpTopBiasLines(previewView({ lineHeight: '20px', header: { top: 0, height: 103 }, scrollerTop: 103 }))).toBe(0);
	});

	it('手机上顶栏提成浮层时，让开被它盖住的那一条再加渐隐余量', () => {
		// 安全区 47 + 顶栏高 88 = 135px 被盖住，加 12px 余量 = 147px；147 / 20 = 7.35 ⇒ 8 行。
		const band = 47 + 88 + FADE_MARGIN_PX;
		expect(jumpTopBiasLines(previewView({ lineHeight: '20px', header: { top: 47, height: 88 } }))).toBe(
			Math.ceil(band / 20),
		);
	});

	it('手机上没开浮动导航时不让 —— 顶栏回到流里，带子随之消失', () => {
		// ⚠️ 这一条守着「按平台一刀切」那个错法：手机的浮动导航是可关的（floatingNavigation），
		// 关掉之后顶栏就在流里（底边 == 内容顶边），多让一段会把落点推到 core 落不到的地方。
		expect(jumpTopBiasLines(previewView({ lineHeight: '20px', header: { top: 47, height: 88 }, scrollerTop: 135 }))).toBe(0);
	});

	it('内容区顶边比顶栏底边还低时不让 —— 差值不是正数就没有带子', () => {
		// 内容自己有一段上边距（.view-content 的 padding），差值是负的。
		expect(jumpTopBiasLines(previewView({ lineHeight: '20px', header: { top: 0, height: 60 }, scrollerTop: 76 }))).toBe(0);
	});

	it('顶栏还没量出来（高度 0）时不让', () => {
		expect(jumpTopBiasLines(previewView({ lineHeight: '20px', header: { top: 47, height: 0 } }))).toBe(0);
	});

	it('没有顶栏的视图不让 —— 没有东西压着', () => {
		expect(jumpTopBiasLines(previewView({ lineHeight: '20px', header: null }))).toBe(0);
	});

	it('行高答不上来时退回字号，而不是让出一个荒唐的行数', () => {
		// 16px 字号 × 1.6 = 25.6px；带子 147px ⇒ 147 / 25.6 = 5.74 ⇒ 6 行。
		const band = 47 + 88 + FADE_MARGIN_PX;
		expect(jumpTopBiasLines(previewView({ lineHeight: 'normal', header: { top: 47, height: 88 } }))).toBe(
			Math.ceil(band / (16 * 1.6)),
		);
	});

	it('没有滚动容器 / 没有根元素（还没布局、或干脆是个空壳）时不让', () => {
		// 两个根元素都在，但里面还没有滚动容器（编辑器还没建出来）。
		const bare = fakeView({
			getMode: () => 'source',
			contentEl: document.createElement('div'),
			containerEl: document.createElement('div'),
		});
		expect(jumpTopBiasLines(bare)).toBe(0);
		// 连根元素都没有：量不到什么，就不让。
		expect(jumpTopBiasLines(fakeView({ getMode: () => 'source' }))).toBe(0);
		expect(jumpTopBiasLines(null)).toBe(0);
	});
});
