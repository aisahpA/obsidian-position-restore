// 阅读恢复的揭幕判据：遮罩要盖到「确认真的落定」为止，而不是盖到某个固定时刻。
// 四条各钉一件事（前三条是单元语义，后一条是那次真机回报的回归）：
//  - 没落定就一直等、一直重施加，撑满整个预算才收手；
//  - 落在目标上就提前收手，一次都不重贴；
//  - **回读答不出来**（阅读渲染器还没量完，`getScroll()` 报 null）算「还没落定」，
//    绝不是「已经落定」—— 把它当落定，遮罩就会在渲染中途揭开。
// 以及预算必须按模式分：阅读那份要盖住分趟渲染，源码那 600ms 盖不住稍微大一点的
// 笔记（读者先看见顶部，随后才被排进渲染器队列的那次施加拽走）。
//
// 另外钉死遮罩的**总时长就是一条预算**：内容就绪与揭幕确认共享它。

import { describe, it, expect, beforeEach } from 'vitest';
import { MarkdownView, type WorkspaceLeaf } from 'obsidian';

import {
	RESTORE_MASK_BUDGET_PREVIEW,
	RESTORE_PAINT_DEADLINE,
	waitForRestorePainted,
} from '@/shared/wait';
import { RestoreModes } from '@/position/restore/modes';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

beforeEach(() => {
	// OpenCover 经 Obsidian 对 HTMLElement 的 setCssStyles 扩展来上遮罩，jsdom 缺这个。
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

// 一个阅读模式的替身：contentEl（遮罩落在它身上）、containerEl 里挂着渲染器就绪
// 所需的 sizer 与滚动容器。`report()` 就是渲染器的嘴 —— 传 null 表示它还没量完
// （`getScroll()` 报 null），传数字表示它现在报这个位置。
function makePreviewView(leafId = 'leaf-1') {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	const sizer = document.createElement('div');
	sizer.className = 'markdown-preview-sizer';
	sizer.append(document.createElement('div'));
	// jsdom 不做版面，所以 scrollHeight 永远是 0 —— isContentReady 会一直为假，
	// waitForContentReady 会烧掉它 2000ms 的期限。把真浏览器算出来的那个
	// 「渲染器产出了内容」信号桩掉。
	Object.defineProperty(sizer, 'scrollHeight', { value: 1000, configurable: true });
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	containerEl.append(sizer, scroller);

	let reported: number | null = 0;
	const applies: number[] = [];
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf: { id: leafId, containerEl } as unknown as WorkspaceLeaf,
		file: { path: 'a.md' },
		getMode: () => 'preview',
		currentMode: { getScroll: () => reported },
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			applies.push((s.scroll as number) ?? 0);
		},
	});
	return {
		view,
		scroller,
		applies,
		// 渲染器报出位置：真 scroller 跟着动，hasPreviewScrolled 那道门才放行。
		report: (value: number | null) => {
			reported = value;
			scroller.scrollTop = value ?? 0;
		},
	};
}

describe('waitForRestorePainted 的等待语义', () => {
	it('没落定就一直重贴，撑满整个预算才收手', async () => {
		const p = makePreviewView();
		p.report(0); // 渲染器说「还在顶部」

		const startedAt = Date.now();
		await waitForRestorePainted(p.view, { scroll: 10 }, () => true, 200);

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
		expect(p.applies.length).toBeGreaterThan(1);
		expect(p.applies.every((scroll) => scroll === 10)).toBe(true);
	});

	it('已经在目标上就提前收手，一次都不重贴', async () => {
		const p = makePreviewView();
		p.report(10);

		const startedAt = Date.now();
		await waitForRestorePainted(p.view, { scroll: 10 }, () => true, RESTORE_MASK_BUDGET_PREVIEW);

		expect(Date.now() - startedAt).toBeLessThan(300);
		expect(p.applies).toEqual([]);
	});

	it('回读答不出来算「还没落定」—— 不许当成已经落定', async () => {
		const p = makePreviewView();
		p.report(null); // getScroll() 报 null：渲染器还没产出位置

		const startedAt = Date.now();
		await waitForRestorePainted(p.view, { scroll: 10 }, () => true, 200);

		// 既没有提前退出（那不是「已落定」），也一直在重贴。
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
		expect(p.applies.length).toBeGreaterThan(1);
	});
});

describe('阅读的遮罩盖到什么时候', () => {
	it('源码那份预算过后仍然遮着，直到渲染器真的落得下去', async () => {
		const p = makePreviewView();
		const state = new PositionState(DEFAULT_SETTINGS);
		// 只测遮罩与等待：共享收口那条路会写活动 leaf 的账本与提示，不属于这里。
		state.noAnchorLeafIds.add('leaf-1');
		const modes = new RestoreModes(state);

		p.report(0); // 此刻还在顶部：渲染器分趟跑着
		const startedAt = Date.now();
		const restore = modes.maskedRestoreSt(p.view, { scroll: 10 }, () => true);
		// 渲染器把目标行量出来、真落下去的时刻 —— 故意排在源码那 600ms 之后。
		window.setTimeout(() => p.report(10), RESTORE_PAINT_DEADLINE + 250);

		await wait(RESTORE_PAINT_DEADLINE + 100);
		expect(p.view.contentEl.style.opacity).toBe('0');

		await restore;
		expect(p.view.contentEl.style.opacity).toBe('');
		expect(p.scroller.scrollTop).toBe(10);
		// 落定了就揭，不等满预算。
		expect(Date.now() - startedAt).toBeLessThan(RESTORE_MASK_BUDGET_PREVIEW);
	});

	it('内容就绪与揭幕确认共享一条预算，不各算各的', async () => {
		const p = makePreviewView();
		const state = new PositionState(DEFAULT_SETTINGS);
		state.noAnchorLeafIds.add('leaf-1');
		const modes = new RestoreModes(state);

		p.report(null); // 渲染器还没量完：内容就绪这一段会一直等下去
		const startedAt = Date.now();
		const restore = modes.maskedRestoreSt(p.view, { scroll: 10 }, () => true);
		// 快到预算末尾才就绪，而且永远落不到目标行上（渲染器一直说「还在顶部」）。
		window.setTimeout(() => p.report(0), RESTORE_MASK_BUDGET_PREVIEW - 300);

		await restore;
		const elapsed = Date.now() - startedAt;
		// 两段各算各的会到「预算 + 剩下的那一截」；共享一条则贴着预算本身收手。
		expect(elapsed).toBeGreaterThanOrEqual(RESTORE_MASK_BUDGET_PREVIEW - 200);
		expect(elapsed).toBeLessThan(RESTORE_MASK_BUDGET_PREVIEW + 400);
		expect(p.view.contentEl.style.opacity).toBe('');
	});
});
