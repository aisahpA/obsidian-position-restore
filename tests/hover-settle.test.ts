// PreviewSettle（recent-files/browser/hover-settle.ts）的测试，它是个观察者，
// 盯着 app 自己的页面预览，并遮住它在被要求跳到某一行时所做的那次跳动。
//
// 这里钉的是**循环的寿命**，也就是两个方向上都容易搞错的那部分。app 答得
// 晚时它必须**还在**看 —— 这个面板的预览需要 Mod 键，所以 popover 可能在
// 行被提问十秒之后才出现 —— 而悬停一结束它就必须**不再**看，否则读者正在
// 读的卡片会一直敞着，底下却挂着一个已无事可等的 paint 循环。定夺这一点的
// 不是被跟踪的 popover，而是那次提问。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { HoverParent, HoverPopover } from 'obsidian';
import { PreviewSettle } from '@/recent-files/browser/hover-settle';

// app 句柄够用的那一份：提问被交给的 parent，以及本模块从它身上读的
// 那一个成员。
type Parent = { hoverPopover?: HoverPopover };

function makePopover(): HoverPopover {
	const el = document.createElement('div');
	// 循环问的是 isConnected：一张已被 app 收走的卡片就是没了，
	// 即便那个字段还指着它。
	document.body.appendChild(el);
	return { hoverEl: el } as unknown as HoverPopover;
}

function harness() {
	const parent: Parent = {};
	const opened: HTMLElement[] = [];
	const settle = new PreviewSettle();
	settle.attach(parent as unknown as HoverParent, el => opened.push(el));
	return { parent, opened, settle };
}

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
	frames = [];
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
});

// 让循环把它在等的那几次注视取走，并让每次注视之后的 await 都落定。
// paint 本身是桩，所以一次注视是一帧，而不是一个时钟。
async function paint(times = 1): Promise<void> {
	for (let i = 0; i < times; i++) {
		const due = frames;
		frames = [];
		for (const cb of due)
			cb(0);
		for (let k = 0; k < 5; k++)
			await Promise.resolve();
	}
}

describe('PreviewSettle', () => {
	// 循环为何是观察者而不是等待：app 答话的时机没有上界，
	// 所以几帧的沉默不能把它结束掉。
	it('app 答晚了它还在看', async () => {
		const h = harness();
		h.settle.ask(false); // 一段：它就画在它待的地方
		await paint(3);

		h.parent.hoverPopover = makePopover();
		await paint(2);

		expect(h.opened).toHaveLength(1);
	});

	it('悬停期间 app 换了 popover 会被报告出来', async () => {
		const h = harness();
		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);

		h.parent.hoverPopover = makePopover();
		await paint(2);

		expect(h.opened).toHaveLength(2);
	});

	// 循环等什么由那次提问界定：app 是跟着指针打开预览的，所以指针一旦
	// 离开列表，就意味着不会再有答案来了 —— 不管它留下的那张卡片还要
	// 敞多久。
	it('悬停一结束就撤下来，不管有没有 popover', async () => {
		const h = harness();
		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);
		expect(h.opened).toHaveLength(1);

		h.settle.hoverEnded();
		await paint(2);

		h.parent.hoverPopover = makePopover();
		await paint(3);

		expect(h.opened).toHaveLength(1);
	});

	// 撤下来不是永久的：下一次提问会重新启动它，而它的头一次注视
	// 会发现它记住的那个 popover 已经关上了。
	it('下一次提问时重新开始', async () => {
		const h = harness();
		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);
		h.settle.hoverEnded();
		await paint(2);

		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);

		expect(h.opened).toHaveLength(2);
	});
});
