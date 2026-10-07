// position/ui/cue.ts 的两次「出声」——恢复后的面包屑与落点标记——以及它们各自的开关。
// 三层：
//   · breadcrumbPath：面包屑念哪几个名字（纯，从笔记文本读）；
//   · show() 的两道门：开关关着不碰视图、屏上已经有标题就不复述；
//   · 从一次真实恢复走到底：落点标记按模式各取哪一行（编辑取光标那一行、阅读取落点），
//     以及前进后退带来的恢复不标（那一路自己标过一次）。
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

// 一个什么都不做、只管记账的视图：够 applyEphemeralState 与 flashLine 走完，
// 而它记下的 setEphemeralState 参数正是「要不要向视图要那次揭示」的答案。
function makePreviewView(scroll: number, cursorLine = 5): MarkdownView {
	return fakeView({
		leaf: { id: 'leaf-1' },
		file: { path: 'a.md' },
		getMode: () => 'preview',
		currentMode: { getScroll: () => scroll },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl: document.createElement('div'),
		editor: { getCursor: () => ({ line: cursorLine, ch: 0 }) },
		setEphemeralState: vi.fn(),
	});
}

// 视图被要求「揭示」过吗。落点标记在阅读模式下的唯一表现就是它，所以只认
// `{line}` 那一种参数 —— applyEphemeralState 自己那次 `{scroll}` 不算。
const askedToReveal = (view: MarkdownView): boolean => {
	const spy = view.setEphemeralState as unknown as { mock: { calls: unknown[][] } };
	return spy.mock.calls.some(([arg]) => typeof arg === 'object' && arg !== null && 'line' in arg);
};

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
	it('恢复后，阅读视图按落点向视图要一次揭示', async () => {
		const s = settings();
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const view = makePreviewView(12);

		await modes.historyJumpApply(view, { scroll: 12 }, () => true, 0);

		expect(askedToReveal(view)).toBe(true);
	});

	it('关掉之后，恢复不再要那次揭示', async () => {
		const s = settings({ flashLandingLine: false });
		const state = new PositionState(s);
		const modes = new RestoreModes(s, state);
		const view = makePreviewView(12);

		await modes.historyJumpApply(view, { scroll: 12 }, () => true, 0);

		expect(askedToReveal(view)).toBe(false);
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
		const view = makePreviewView(12);
		// NavStack 的遍历装的就是它：目的地是读者自己选的，不带提示。
		state.cueSuppressUntil = Date.now() + 60_000;

		await modes.historyJumpApply(view, { scroll: 12 }, () => true, 0);

		expect(askedToReveal(view)).toBe(false);
	});
});
