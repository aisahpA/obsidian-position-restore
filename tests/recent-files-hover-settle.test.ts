// 盖在 app 自己那个页面预览上的遮罩：popover 从**被索要**某一行到抵达它之间在做什么
// （见 recent-files/browser/hover-settle.ts）。
//
// 这里的一切都是 core 那一半的替身：真实的 PeekPopover 在 jsdom 里造不出来，但也不
// 需要造 —— 观察者恰好只问它两件事（popover 那个元素，以及 core 在它落到的那一行上留
// 下的自己的标记），而这两件正是两边在 core 自己的代码里约定的东西。被测的是这道接缝
// 的这一侧：无论 app 的答复来得多晚，这段路程里没有任何一部分是看得见的。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HoverParent, HoverPopover } from 'obsidian';

import { PreviewSettle } from '@/recent-files/browser/hover-settle';

// core 把它的 popover 写进去的那个 parent，按 app 交过来的样子。
const parentOf = (el?: HTMLElement): HoverParent => ({
	hoverPopover: el ? ({ hoverEl: el } as unknown as HoverPopover) : null,
});

// popover 自己：一张卡片，里面装着 core 稍后渲染的东西。
const popover = () => {
	const el = document.createElement('div');
	const content = document.createElement('div');
	el.appendChild(content);
	document.body.appendChild(el);
	return { el, content };
};

// 观察者的眼睛看一次：它的时钟是那次绘制（见 shared/wait.ts 的 nextPaint），所以假时钟
// 走过它一整圈就是看一次。
const look = () => vi.advanceTimersByTimeAsync(150);

describe('PreviewSettle —— 盖在预览自己那段路程上的遮罩', () => {
	let settle: PreviewSettle;
	let opened: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		settle = new PreviewSettle();
		opened = vi.fn();
		document.body.innerHTML = '';
	});

	afterEach(() => {
		settle.stop();
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	it('popover 什么时候到都罩住它 —— 钥匙可能比提问晚很久才来', async () => {
		// 面板自己的注册说明必须按修饰键（见 main.ts），所以 app 是在读者**按下**它的时候才
		// 答复：先悬停十秒是件寻常事，而到那时已经收工的遮罩，换来的是那一下跳和闪回来
		// （见 hover-settle.ts 的导言）。
		const parent = parentOf();
		settle.attach(parent, opened);
		settle.ask(true);
		await vi.advanceTimersByTimeAsync(5000);

		const { el, content } = popover();
		parent.hoverPopover = { hoverEl: el } as unknown as HoverPopover;
		await look();

		expect(content.style.opacity).toBe('0');
		expect(opened).toHaveBeenCalledTimes(1);
		// ……而这个**卡片**随消息一起走：它是这个模块之外的人对 app 画了什么的唯一把手
		// （见 RecentFilesBrowser.liftPreview）。
		expect(opened).toHaveBeenCalledWith(el);
	});

	it('滚动自己的见证到达时才揭幕，而且搜索标记已经摘掉', async () => {
		// core 在移动滚动容器的**同一次**调用里把 `.is-flashing` 放到那一行上，所以那次闪是
		// 笔记已经落了地的确定消息 —— 而它是搜索命中的那三秒，从来不是给预览准备的，所以在
		// 结束遮罩的同一次注视里就被摘掉。
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		const hit = document.createElement('div');
		hit.classList.add('is-flashing');
		content.appendChild(hit);
		await look();

		expect(content.style.opacity).toBe('');
		expect(el.querySelector('.is-flashing')).toBeNull();
	});

	it('比卡片本身晚到的内容先藏着', async () => {
		// 内容节点比它所属的 popover 晚来，所以遮罩是每次注视都重新盖上，而不是只盖一次。
		const { el } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();

		const late = document.createElement('div');
		el.appendChild(late);
		await look();

		expect(late.style.opacity).toBe('0');
	});

	it('到了期限就停止等待，而不是一直举着一张空卡片', async () => {
		// 这个期限是为那种保留位置、丢掉闪的 app 版本准备的：一个始终没太跟上的 popover，会被
		// 整个揭开，而不是在我们琢磨它的时候一直空着。
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		await vi.advanceTimersByTimeAsync(700);

		expect(content.style.opacity).toBe('');
	});

	it('没有请求行号时报告「开了」，但不盖任何东西', async () => {
		// 小节就画在它所在的地方，没有路程要藏；但**开**这件事本身仍然是面板在等的消息
		// （见 NavRowTip）。
		const parent = parentOf();
		settle.attach(parent, opened);
		settle.ask(false);
		const { el, content } = popover();
		parent.hoverPopover = { hoverEl: el } as unknown as HoverPopover;
		await look();

		expect(opened).toHaveBeenCalledTimes(1);
		expect(content.style.opacity).toBe('');
	});

	it('下一次提问点名了行号时，把已经立着的 popover 罩上', async () => {
		// 指针从另一行划了过来：即将载入那张已打开卡片的笔记，走的是同一段路程，所以遮罩随
		// 提问一起开始 —— 露出笔记开头的一帧就已经太晚了。
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(false);
		await look();
		expect(opened).toHaveBeenCalledTimes(1);

		settle.ask(true);

		expect(content.style.opacity).toBe('0');
	});

	it('提问被回答成「什么都没有」时，到期限就把旧笔记放回去', async () => {
		// 盖住已经立着的那张卡片，是在赌一段路程即将开始；一次被拒的提问不该因此把读者的笔记
		// 一直藏着。
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(false);
		await look();

		settle.ask(true);
		expect(content.style.opacity).toBe('0');
		await vi.advanceTimersByTimeAsync(700);

		expect(content.style.opacity).toBe('');
	});

	it('悬停结束就放手 —— 下一次开始再重新盯着', async () => {
		// 指针离开列表结束的是**提问**，不是这个 popover：还盖着的遮罩会揭开，但卡片继续被
		// 跟踪着，所以指针回来时不会再被告知一次它「开了」。
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		settle.hoverEnded();
		expect(content.style.opacity).toBe('');

		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it('让更新的那个 popover 接管遮罩', async () => {
		// 一行接一行地被划过：app 已经答复了更新的那次提问之后，旧卡片没有道理继续被盖着。
		const first = popover();
		const parent = parentOf(first.el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(first.content.style.opacity).toBe('0');

		const second = popover();
		parent.hoverPopover = { hoverEl: second.el } as unknown as HoverPopover;
		await look();

		expect(first.content.style.opacity).toBe('');
		expect(second.content.style.opacity).toBe('0');
		expect(opened).toHaveBeenCalledTimes(2);
	});

	it('「有没有开着一个」由 app 自己的句柄回答，不靠记忆', async () => {
		// 那些行的提示在开口之前先问这个（见 NavRowTip）：一个记下来的答案，恰恰会在它最重要
		// 的时候过时 —— 指针从未离开列表，而 popover 已经关了。
		const { el } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		expect(settle.isOpen()).toBe(true);

		settle.ask(false);
		await look();
		el.remove();

		expect(settle.isOpen()).toBe(false);
	});

	it('提问换了目标时，把已经不再罩着的那张卡片恢复原样', async () => {
		// 一次提问可能在另一张卡片还盖在遮罩下时到来 —— app 在两次注视之间换掉了它的 popover，
		// 而新的提问点名了某一行。那张旧卡片该怎么显示，还是 app 的事，照原样就行。
		const first = popover();
		const parent = parentOf(first.el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(first.content.style.opacity).toBe('0');

		const second = popover();
		parent.hoverPopover = { hoverEl: second.el } as unknown as HoverPopover;
		settle.ask(true);

		expect(first.content.style.opacity).toBe('');
		expect(second.content.style.opacity).toBe('0');
	});

	it('面板离开时一件藏着的东西都不留', async () => {
		// 一个被留着盖住的 popover，会是一个比造成它的那些行活得更久的 bug。
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		settle.stop();

		expect(content.style.opacity).toBe('');
	});
});
