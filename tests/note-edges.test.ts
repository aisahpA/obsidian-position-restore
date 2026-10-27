// 一篇笔记的两端，作为我们自己的命令（见 position/edges.ts 与
// manager.goToEdge）。值得钉住的是其中**不是**滚动的部分：
//  - 移动的是哪个元素、移到它那段范围的哪一端 —— 底部是笔记的末尾、在读者**看得
//    见**的末尾：既不是 app 的反向链接面板进了同一个滚动容器之后视图还能滚到的最远
//    处，也不是 app 把某条栏浮在它上面之后窗口的底部；
//  - 编辑器按键留下的光标，**两种**模式下都算：阅读视图一个都不显示，但它背后的
//    编辑器是真实存在的，而且比切回编辑活得更久；
//  - 在它索要的那一端按下命令时，什么都不挪、也什么都不记 —— 否则 back 要按同样
//    多次才能回到读者原来的位置；
//  - 这次抵达也要告诉**视图**，切模式带过去的正是它 —— 在 DOM 上做的一次移动，在
//    阅读模式下永远到不了视图；
//  - 视图已经站在那一端时，光标是仍然会动的那一半：一篇笔记可以一边显示着顶部、
//    一边把光标留在 200 行开外；
//  - 那一步：读者原先站的位置留在栈上，而这次抵达是它自己单独的一步，不是对它的
//    改写。

import { afterEach, describe, it, expect, vi } from 'vitest';
import { App, FileView, MarkdownView, View } from 'obsidian';

import { atEdge, caretAtEdge, holdEdge, moveToEdge, syncViewScroll } from '@/position/edges';
import { scrollContainerIn } from '@/shared/wait';
import { PositionManager } from '@/position/manager';
import type { NavFunnel } from '@/nav/funnel';
import type { NavStack } from '@/nav-history/stack';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

// 一个带真实范围的滚动容器：jsdom 没有布局，所以 scrollHeight 和 clientHeight 在这里
// 是写死的，而 scrollTop 按浏览器的方式夹住 —— 正是这个夹取把最后一行放在视口的
// **末端**，而这正是索要底部的全部意义。
function makeScroller(content: number, viewport: number, top = 0): HTMLElement {
	const el = document.createElement('div');
	let cur = top;
	Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => content });
	Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => viewport });
	Object.defineProperty(el, 'scrollTop', {
		configurable: true,
		get: () => cur,
		set: (v: number) => {
			cur = Math.min(Math.max(0, v), Math.max(0, content - viewport));
		},
	});
	return el;
}

// jsdom 没有布局，所以盒子在这里是写死的 —— 滚动容器自己的 top 读出来是 0。
function rectAt(top: number, height: number): DOMRect {
	const width = height > 0 ? 150 : 0;
	return {
		top,
		bottom: top + height,
		left: 0,
		right: width,
		width,
		height,
		x: 0,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

// app 的反向链接面板，追加在它与笔记共享的那个滚动容器里面（阅读模式：渲染器的页脚
// 小节；源码模式：那个 sizer）。高度为 0 代表设置关着时的面板：创建了、藏起来了、并
// 塌缩成一个没有盒子可言的东西。
function withBacklinks(scroller: HTMLElement, topInContent: number, height = 300): HTMLElement {
	const el = document.createElement('div');
	el.className = 'embedded-backlinks';
	Object.defineProperty(el, 'getBoundingClientRect', {
		configurable: true,
		value: () => rectAt(height > 0 ? topInContent - scroller.scrollTop : 0, height),
	});
	scroller.appendChild(el);
	return el;
}

// 给元素补上 jsdom 不会为它算出来的盒子。
function stubRect(el: HTMLElement, top: number, height: number): void {
	Object.defineProperty(el, 'getBoundingClientRect', {
		configurable: true,
		value: () => rectAt(top, height),
	});
}

// app 自己的一条栏，浮在笔记的脚部之上，而不是在它上面或下面。两者都只在移动端出现，
// 所以桌面端一条也没有，什么都量不到。
function withFloatingBar(top: number, height: number, className = 'mobile-navbar'): HTMLElement {
	const el = document.createElement('div');
	el.className = className;
	stubRect(el, top, height);
	document.body.appendChild(el);
	return el;
}

afterEach(() => {
	for (const bar of document.querySelectorAll('.mobile-navbar, .mobile-toolbar'))
		bar.remove();
});

function makeView(opts: {
	mode: 'source' | 'preview';
	scroller: HTMLElement;
	topLine?: number;
	cursor?: { line: number; ch: number };
	// 该模式报告的自己那点位置；null 表示一个还没追上来的阅读渲染器。
	modeScroll?: number | null;
}) {
	const lines = ['one', 'two', 'three'];
	const cursor = opts.cursor ?? { line: 0, ch: 0 };
	const editor = {
		lineCount: () => lines.length,
		getLine: (n: number) => lines[n] ?? '',
		lastLine: () => lines.length - 1,
		getCursor: () => cursor,
		setCursor: vi.fn(),
	};
	opts.scroller.className = opts.mode === 'source' ? 'cm-scroller' : 'markdown-preview-view';
	const contentEl = document.createElement('div');
	contentEl.appendChild(opts.scroller);
	const containerEl = document.createElement('div');
	containerEl.appendChild(contentEl);
	// 已挂到文档上：一次移动之后的按住，会在视图不再位于文档里时停下。
	document.body.appendChild(containerEl);
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path: 'a.md', stat: { mtime: 1 } },
		getMode: () => opts.mode,
		currentMode: {
			getScroll: () => (opts.modeScroll !== undefined ? opts.modeScroll : opts.topLine ?? 300),
		},
		setEphemeralState: vi.fn(),
		// 两种模式都算：`view.editor` 是这个 leaf 的编辑模式，无论正在显示什么它都在、都活着
		// （见 caretToEdge）—— 阅读模式下不**显示**光标而已。
		editor,
		contentEl,
		containerEl,
		getViewType: () => 'markdown',
	}) as MarkdownView & {
		editor: typeof editor;
	};
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1', view, containerEl };
	return { view, editor };
}

function makeManager(
	// 活动视图（markdown 或第三方视图都行）：只被 getActiveViewOfType 原样答出来。
	view: unknown,
	// 当活动的 leaf **不是**那篇笔记时会去走的那些 leaf（见 viewInUse）：活动视图就是那篇
	// 笔记的 fixture 永远到不了它们。`containerEl` 让它们算作主区里的 leaf。
	leaves: { id?: string; view: unknown; containerEl?: HTMLElement; activeTime?: number }[] = [],
) {
	const db: Record<string, { scroll: number }> = {};
	const mainLeaves = leaves.map((leaf) => ({
		...leaf,
		containerEl: leaf.containerEl ?? (leaf.view as { containerEl?: HTMLElement }).containerEl,
	}));
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: () => null,
			adapter: { exists: async () => true },
		},
		metadataCache: { getFileCache: () => null },
		workspace: {
			layoutReady: true,
			// 这些 leaf 都算主区里的（真正的判据是 DOM 包含，见 shared/leaf.ts）。
			rootSplit: { containerEl: { contains: () => true } },
			activeEditor: null,
			getActiveViewOfType: () => view,
			// 活动 leaf 是面板（或没有笔记）时，插件退回**最近用过的那个主区 leaf**
			// （见 viewInUse）。一个哪儿都没有视图的 fixture，必须能在不抛异常的前提下
			// 答出「没有可去之处」。
			getLeavesOfType: () => mainLeaves,
			iterateAllLeaves: (cb: (leaf: unknown) => void) => {
				for (const leaf of mainLeaves)
					cb(leaf);
			},
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
		},
	};
	const database = {
		db,
		setState: vi.fn(),
		renameFile: vi.fn(),
		deleteFile: vi.fn(),
	};
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(app as unknown as App, database as never, settings);
	return {
		manager,
		app,
		funnel: (manager as unknown as { funnel: NavFunnel }).funnel,
		stack: (manager as unknown as { stack: NavStack }).stack,
	};
}

describe('移到笔记的一端', () => {
	it('把视图滚到它自己那段范围的顶端', () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'top');

		expect(scroller.scrollTop).toBe(0);
	});

	it('滚到最远端，让最后一行落在底部', () => {
		const scroller = makeScroller(1000, 200, 0);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		// 1000 - 200：索要超出范围的东西会被夹住，而夹住之后的那个值正是能显示出最后一屏的
		// 那一个。
		expect(scroller.scrollTop).toBe(800);
	});

	it('把光标留在第一行的行首（它是编辑器的按键行为）', () => {
		const { view, editor } = makeView({ mode: 'source', scroller: makeScroller(1000, 200, 400) });

		moveToEdge(view, 'top');

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
	});

	it('把光标留在最后一行的行尾', () => {
		const { view, editor } = makeView({ mode: 'source', scroller: makeScroller(1000, 200, 0) });

		moveToEdge(view, 'bottom');

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 2, ch: 5 }); // "three" 的末尾
	});

	it('阅读视图也一样移动，它的光标不是用来显示的', () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view, editor } = makeView({ mode: 'preview', scroller, cursor: { line: 2, ch: 3 } });

		moveToEdge(view, 'top');

		expect(scroller.scrollTop).toBe(0);
		// 是把它放好，不是把它显示出来：切到编辑之后它才变得可见，而切模式带过去的是滚动和
		// 折叠，从来不是选区。
		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
	});
});

// 一篇笔记的底部是读者写下的东西的末尾。反向链接面板是**标签页**的一块面板，追加在同一个
// 滚动容器里面，而一个比窗口还高的面板会把最远可滚点整个推到笔记最后一行之外。
describe('是笔记的末尾，不是标签页的末尾', () => {
	it('停在面板开始的地方，让最后一行还看得见', () => {
		const scroller = makeScroller(1000, 200, 0);
		withBacklinks(scroller, 700); // 面板填满 200 高窗口的 700..1000 这一段
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		// 700 - 200，不是 800：800 是面板的末尾，不是笔记的。
		expect(scroller.scrollTop).toBe(500);
	});

	it('面板被关掉时就走到最远处', () => {
		const scroller = makeScroller(1000, 200, 0);
		withBacklinks(scroller, 700, 0);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(800);
	});

	it('把面板的那条边当作末端，于是远端不再算「已经在那里」', () => {
		const scroller = makeScroller(1000, 200, 800);
		withBacklinks(scroller, 700);
		const { view } = makeView({ mode: 'preview', scroller });

		expect(atEdge(view, 'bottom')).toBe(false); // 最远处在笔记之外
		scroller.scrollTop = 500;
		expect(atEdge(view, 'bottom')).toBe(true);
	});

	// 短到滚不动：面板的那条边在窗口上方，所以没有地方可以提前停 —— 也没有地方可去。
	it('对滚不动的笔记什么都不要求', () => {
		const scroller = makeScroller(200, 200);
		withBacklinks(scroller, 150);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(0);
	});
});

// 窗口的底部不是读者**看得见**的东西的底部：在手机上，app 会把自己的一条栏浮在笔记的脚部
// 之上。那条栏是哪一个取决于模式，而软键盘会把它挪走，所以那条带子是量出来的，不是从一个
// 变量上读出来的。
describe('窗口里读者看不见的那一部分', () => {
	// 一个 200 高的窗口、在 700 处结束的笔记，以及压在它脚部上的一条栏。
	function underBar(barTop: number, barHeight = 40, withPane = true) {
		const scroller = makeScroller(1000, 200, 0);
		stubRect(scroller, 0, 200);
		if (withPane)
			withBacklinks(scroller, 700);
		withFloatingBar(barTop, barHeight);
		return { scroller, view: makeView({ mode: 'preview', scroller }).view };
	}

	it('让笔记结束在那条栏之上，而不是藏在它后面', () => {
		const { scroller, view } = underBar(160);

		moveToEdge(view, 'bottom');

		// 700 - (200 - 40)：最后一行越过了那条栏，而它下面的面板没有。
		expect(scroller.scrollTop).toBe(540);
	});

	// 软键盘把那条栏推离窗口，而不是让它压在上面。
	it('栏已经不挡道了就一点都不扣', () => {
		const { scroller, view } = underBar(210);

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(500);
	});

	// 没有面板意味着 app 已经给笔记的脚部垫了半个窗口，所以最后一行自己就越过了那条栏 ——
	// 而且本来也没有再远的地方可去。
	it('没有面板可以提前停时就要求最远处', () => {
		const { scroller, view } = underBar(160, 40, false);

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(800);
	});
});

// 端点不总是守得住：阅读渲染器会在晚一轮的渲染里，重新应用它在这次移动**之前**采集到的
// 滚动 —— 那一轮是读者自己的滚动排进队列的，在命令跑完之后才结束。这就是先闪到顶部、
// 再滑回去的那一幕。
describe('把端点按住', () => {
	// 每一次写进滚动容器之后，隔一拍都会跟着旧位置回来。
	function clobber(scroller: HTMLElement, backTo: number, times = 1) {
		const inner = Object.getOwnPropertyDescriptor(scroller, 'scrollTop')!;
		const counter = { writes: 0 };
		let left = times;
		Object.defineProperty(scroller, 'scrollTop', {
			configurable: true,
			get: inner.get,
			set: (v: number) => {
				inner.set?.call(scroller, v);
				counter.writes++;
				if (left-- > 0)
					window.setTimeout(() => inner.set?.call(scroller, backTo), 0);
			},
		});
		return counter;
	}

	it('晚到的那一轮渲染把旧位置贴回来时，把端点放回去', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		clobber(scroller, 400);

		moveToEdge(view, 'top');
		await holdEdge(view, 'top');

		expect(scroller.scrollTop).toBe(0);
	});

	// 校正两次就收手：一个一直被覆盖的视图是插件赢不了的那种，而一条命令不该把这一整节都拿去
	// 跟它对着打。
	it('停止校正，而不是跟一个一直赢的东西对打', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		const writes = clobber(scroller, 400, 99);

		moveToEdge(view, 'top');
		await holdEdge(view, 'top');

		// 一次移动加两次校正：一个一直被覆盖的视图是插件赢不了的那种，而一条命令不该把这一整节
		// 都拿去跟它对着打。
		expect(writes.writes).toBeLessThanOrEqual(3);
	});

	it('读者自己一动就立刻让位', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		const writes = clobber(scroller, 400, 99);

		moveToEdge(view, 'top');
		const holding = holdEdge(view, 'top');
		scroller.dispatchEvent(new Event('pointerdown'));
		await holding;

		// 只有这一次移动：读者一接手，按住就是在跟他们对着打。
		expect(writes.writes).toBe(1);
	});

	// 按住会重新应用它移到的那个端点，而这个端点在中间隔着面板时**不是**最远处：否则每一次
	// 校正都会落在面板的末尾，而不是笔记的末尾。
	it('停在笔记的末尾，而不是被推到远端', async () => {
		const scroller = makeScroller(1000, 200, 0);
		withBacklinks(scroller, 700);
		const { view } = makeView({ mode: 'preview', scroller });
		clobber(scroller, 800);

		moveToEdge(view, 'bottom');
		await holdEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(500);
	});

	it('已经不在文档里的滚动容器随它去', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		scroller.remove();

		await expect(holdEdge(view, 'top')).resolves.toBeUndefined();
	});
});

describe('本来就已经站在那一端', () => {
	it('顶部那端算在顶部，底部那端算在底部', () => {
		const atTop = makeView({ mode: 'preview', scroller: makeScroller(1000, 200, 0) }).view;
		const atBottom = makeView({ mode: 'preview', scroller: makeScroller(1000, 200, 800) }).view;
		const between = makeView({ mode: 'preview', scroller: makeScroller(1000, 200, 400) }).view;

		expect(atEdge(atTop, 'top')).toBe(true);
		expect(atEdge(atTop, 'bottom')).toBe(false);
		expect(atEdge(atBottom, 'bottom')).toBe(true);
		expect(atEdge(between, 'top')).toBe(false);
		expect(atEdge(between, 'bottom')).toBe(false);
	});

	// 比窗口还短的笔记，两端都滚不到，所以两条命令本来就都已满足 —— 而两者都不该记下一次
	// 抵达。
	it('短到根本滚不动的笔记，两端都算', () => {
		const { view } = makeView({ mode: 'preview', scroller: makeScroller(200, 200) });

		expect(atEdge(view, 'top')).toBe(true);
		expect(atEdge(view, 'bottom')).toBe(true);
	});

	// 滚动只是「已经在那里」的一半 —— 见下面的光标。
	it('光标在别处时，scroll 那一端仍然算', () => {
		const { view } = makeView({
			mode: 'source',
			scroller: makeScroller(1000, 200, 0),
			cursor: { line: 2, ch: 3 },
		});

		expect(atEdge(view, 'top')).toBe(true);
		expect(caretAtEdge(view, 'top')).toBe(false);
	});
});

// 视图已经显示出读者要的那一端时，光标才是他们仍然想挪的东西：一篇笔记可以一边待在顶部、
// 一边把光标留在 200 行开外，而一条答「你已经在那儿了」的「到页顶」，会让读者自己去用手
// 找。
describe('光标站在那一端', () => {
	const atTop = (cursor: { line: number; ch: number }) =>
		makeView({ mode: 'source', scroller: makeScroller(1000, 200, 0), cursor }).view;
	const atBottom = (cursor: { line: number; ch: number }) =>
		makeView({ mode: 'source', scroller: makeScroller(1000, 200, 800), cursor }).view;

	it('只有在移动会把它留在那儿时才算', () => {
		expect(caretAtEdge(atTop({ line: 0, ch: 0 }), 'top')).toBe(true);
		expect(caretAtEdge(atTop({ line: 0, ch: 2 }), 'top')).toBe(false);
		expect(caretAtEdge(atBottom({ line: 2, ch: 5 }), 'bottom')).toBe(true); // "three" 的末尾
		expect(caretAtEdge(atBottom({ line: 2, ch: 3 }), 'bottom')).toBe(false);
	});

	// 阅读模式不是例外：它的光标是看不见，不是不存在。
	it('在阅读视图上用同样的方式读', () => {
		const { view } = makeView({
			mode: 'preview',
			scroller: makeScroller(1000, 200, 0),
			cursor: { line: 2, ch: 3 },
		});

		expect(caretAtEdge(view, 'top')).toBe(false);
		expect(caretAtEdge(view, 'bottom')).toBe(false);
	});
});

// 切模式不从 DOM 续上：setMode() 带的是 `view.scroll`，而只有 view.syncScroll() 会把它填
// 上 —— 阅读视图只在上一轮渲染至少有 100ms 旧时，才会从它自己的滚动处理程序里调用它，
// 而滚一个虚拟化的预览永远达不到这个年纪。所以在阅读模式下要到某一端、再切到编辑，就会
// 续到读者**按下命令之前**站的位置。
describe('抵达要送到视图，而不只是送到滚动容器', () => {
	it('要告诉视图本身 —— setMode() 带过去的就是它', async () => {
		const { view } = makeView({
			mode: 'preview',
			scroller: makeScroller(1000, 200, 400),
			modeScroll: 142,
		});

		await syncViewScroll(view);

		expect(view.setEphemeralState).toHaveBeenCalledWith({ scroll: 142 });
	});

	it('等一个还没追上的渲染器，而不是捧着一个陈旧的数字往前走', async () => {
		const { view } = makeView({
			mode: 'preview',
			scroller: makeScroller(1000, 200, 400),
			modeScroll: null,
		});
		let caught = false;
		(view.currentMode as unknown as { getScroll: () => number | null })
			.getScroll = () => (caught ? 42 : null);

		const syncing = syncViewScroll(view);
		caught = true;
		await syncing;

		expect(view.setEphemeralState).toHaveBeenCalledWith({ scroll: 42 });
	});

	it('渲染器始终不回答时就什么也不说', async () => {
		const { view } = makeView({
			mode: 'preview',
			scroller: makeScroller(1000, 200, 400),
			modeScroll: null,
		});

		await syncViewScroll(view);

		expect(view.setEphemeralState).not.toHaveBeenCalled();
	});
});

describe('到端点这一下算不算一步', () => {
	// 站在 a.md 的第 300 行，然后索要底部。
	function standingAt(
		topLine: number,
		mode: 'source' | 'preview' = 'preview',
		cursor = { line: 0, ch: 0 },
	) {
		const scroller = makeScroller(1000, 200, topLine);
		const { view, editor } = makeView({ mode, scroller, topLine, cursor });
		const rig = makeManager(view);
		rig.funnel.recordOpen('a.md', 'leaf-1');
		rig.funnel.leave('a.md', 'leaf-1', { scroll: topLine });
		return { ...rig, scroller, view, editor };
	}

	it('保留读者原来站的位置，并给这次抵达单独一步', async () => {
		const { manager, stack, funnel } = standingAt(300);

		manager.goToEdge('bottom');
		await Promise.resolve();

		// 两步：持有第 300 行的那一步，以及这次抵达 —— 它是一步，不是对第一步的改写，所以第一步
		// 仍然回得去。
		expect(stack.entries).toHaveLength(2);
		expect(stack.entries[0].kind).toBe('visit');
		expect(stack.entries[0].kind !== 'view' && stack.entries[0].st?.scroll).toBe(300);
		expect(stack.entries[1].kind !== 'view' && stack.entries[1].st).toBeUndefined();

		// 他们最终落到的位置落在这次抵达上，把原先站的那个地点完好地留给 back。按住还开着 ——
		// 插件还在挪视图 —— 所以先等它结束，再问 back 可不可用。
		funnel.leave('a.md', 'leaf-1', { scroll: 900 });
		expect(stack.entries[1].kind !== 'view' && stack.entries[1].st?.scroll).toBe(900);
		expect(stack.entries[0].kind !== 'view' && stack.entries[0].st?.scroll).toBe(300);
		await new Promise((resolve) => window.setTimeout(resolve, 500));
		expect(stack.canNavigate(-1)).toBe(true);
	});

	it('视图本来就在那一端时不记任何东西', async () => {
		const { manager, stack } = standingAt(800); // 这个视图能走到的最远处

		manager.goToEdge('bottom');
		await Promise.resolve();

		expect(stack.entries).toHaveLength(1);
	});

	// 视图显示着顶部，不等于读者就在那儿：光标是这条命令挪动的一半。不为它记步 —— 从一次眼睛
	// 看不出任何动静的按压退回来，只会再用另一次这样的按压作答。
	it('仍然挪动视图落在后面的光标，但不记步', async () => {
		const { manager, stack, editor } = standingAt(0, 'source', { line: 2, ch: 3 });

		manager.goToEdge('top');
		await Promise.resolve();

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
		expect(stack.entries).toHaveLength(1);
	});

	// ……阅读模式下也一样，那里被放好的是切模式将会露出来的那个光标。
	it('阅读视图里那个看不见的光标同样挪动，也不记步', async () => {
		const { manager, stack, editor } = standingAt(0, 'preview', { line: 2, ch: 3 });

		manager.goToEdge('top');
		await Promise.resolve();

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
		expect(stack.entries).toHaveLength(1);
	});

	it('光标本来也在那一端时就什么都不做', async () => {
		const { manager, stack, editor } = standingAt(0, 'source', { line: 0, ch: 0 });

		manager.goToEdge('top');
		await Promise.resolve();

		expect(editor.setCursor).not.toHaveBeenCalled();
		expect(stack.entries).toHaveLength(1);
	});

	// ……而这次抵达也必须到达视图，否则切模式会续到读者按下命令之前站的那个位置（见上面的
	// sync）。
	it('把抵达的位置告诉视图，好让之后切模式还在那儿', async () => {
		const { manager, view } = standingAt(300, 'preview');

		manager.goToEdge('top');
		await new Promise((resolve) => window.setTimeout(resolve, 600));

		expect(view.setEphemeralState).toHaveBeenCalled();
	});

	it('只有在笔记是当前视图时才可用', () => {
		expect(makeManager(null).manager.canGoToEdge()).toBe(false);
		expect(standingAt(300).manager.canGoToEdge()).toBe(true);
	});

	// ……以及活动 leaf **不是**那篇笔记、而读者就在其中的情形：立在面板里的一个控件 —— 那些
	// 箭头 —— 在被点的那一刻**就是**活动的 leaf，而 app 自己的 `getActiveViewOfType` 只根据
	// 那个 leaf 作答，所以一个索要端点的面板会被给到空。这正是让面板里的一个按钮按得下去的
	// 全部。
	it('作用在读者所在的那个标签页上，而不是握着焦点的那个 leaf', () => {
		const scroller = makeScroller(1000, 200, 300);
		const { view } = makeView({ mode: 'preview', scroller, topLine: 300 });
		const { manager } = makeManager(null, [{ id: 'leaf-1', view }]);

		expect(manager.canGoToEdge()).toBe(true);
		manager.goToEdge('top');
		expect(scroller.scrollTop).toBe(0);
	});
});

// 第三方视图（youtnote 这类插件把正文画在自己的页里）。两端对它们只有「滚 + 拿得到时的
// 光标」，没有步：见 manager.goToViewEdge。
describe('第三方视图的两端', () => {
	// 一个不是 markdown、但正文容器是 app 自己的 .cm-scroller 的视图。
	function makeForeignView(scroller: HTMLElement, path = 'a.youtnote.md') {
		const containerEl = document.createElement('div');
		containerEl.appendChild(scroller);
		document.body.appendChild(containerEl);
		const view = Object.assign(Object.create(FileView.prototype), {
			file: { path, stat: { mtime: 1 } },
			containerEl,
			getViewType: () => 'youtnote',
		}) as unknown as FileView & { containerEl: HTMLElement; file: { path: string } };
		(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-y', view, containerEl };
		return view;
	}

	function makeForeignEditor(editor: unknown, file: unknown) {
		return { app: {}, file, editor };
	}

	it('滚到容器自己滚到底，而不是笔记的末尾', () => {
		const scroller = makeScroller(1000, 200, 0);
		scroller.className = 'cm-scroller';
		const view = makeForeignView(scroller);
		const { manager, stack } = makeManager(view);

		expect(manager.canGoToEdge()).toBe(true);
		manager.goToEdge('bottom');
		expect(scroller.scrollTop).toBe(800);
		manager.goToEdge('top');
		expect(scroller.scrollTop).toBe(0);

		// 不记步：这一期只做滚动（见 manager.goToViewEdge）。
		expect(stack.entries).toHaveLength(0);
	});

	it('拿得到编辑器时才挪光标，而且只在几何也对得上时', () => {
		const scroller = makeScroller(1000, 200, 300);
		scroller.className = 'cm-scroller';
		const view = makeForeignView(scroller);
		const setCursor = vi.fn();
		const editor = {
			getLine: () => 'last line',
			lastLine: () => 9,
			setCursor,
			getScrollInfo: () => ({ top: 300, left: 0, height: 1000, clientHeight: 200 }),
		};
		const { manager, app } = makeManager(view);
		(app.workspace as unknown as { activeEditor: unknown }).activeEditor =
			makeForeignEditor(editor, view.file);

		manager.goToEdge('bottom');
		expect(setCursor).toHaveBeenCalledWith({ line: 9, ch: 9 });

		setCursor.mockClear();
		manager.goToEdge('top');
		expect(setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
		expect(scroller.scrollTop).toBe(0);
	});

	it('几何对不上就只滚、不动别人家的光标', () => {
		const scroller = makeScroller(1000, 200, 300);
		scroller.className = 'cm-scroller';
		const view = makeForeignView(scroller);
		const setCursor = vi.fn();
		const editor = {
			getLine: () => '',
			lastLine: () => 9,
			setCursor,
			// 这不是我们找到的那个容器（高度不同）⇒ 证明不了它属于这个视图。
			getScrollInfo: () => ({ top: 0, left: 0, height: 500, clientHeight: 100 }),
		};
		const { manager, app } = makeManager(view);
		(app.workspace as unknown as { activeEditor: unknown }).activeEditor =
			makeForeignEditor(editor, view.file);

		manager.goToEdge('top');
		expect(setCursor).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(0);
	});

	// youtnote 的形状：真正滚的是 notes-list，编辑器自己的 `.cm-scroller` 随内容长高、不滚。
	// 光标仍然能动 —— 只要那个内层容器的几何与编辑器报的相等（这就是「它确实在这个视图里」
	// 的证明）。
	it('编辑器挂在一个不滚的内层容器上时，光标仍然能动', () => {
		const list = makeScroller(2948, 522, 0);
		list.style.overflowY = 'auto';
		const inner = makeScroller(2880, 2880);
		inner.className = 'cm-scroller';
		list.appendChild(inner);
		const view = makeForeignView(list);
		const setCursor = vi.fn();
		const editor = {
			getLine: () => 'last',
			lastLine: () => 119,
			setCursor,
			getScrollInfo: () => ({ top: 0, left: 0, height: 2880, clientHeight: 2880 }),
		};
		const { manager, app } = makeManager(view);
		(app.workspace as unknown as { activeEditor: unknown }).activeEditor =
			makeForeignEditor(editor, view.file);

		manager.goToEdge('bottom');
		expect(setCursor).toHaveBeenCalledWith({ line: 119, ch: 4 });
		expect(list.scrollTop).toBe(2426);
	});

	it('没有可滚的东西就不算能要求两端', () => {
		const containerEl = document.createElement('div');
		containerEl.appendChild(document.createElement('div'));
		document.body.appendChild(containerEl);
		const view = Object.assign(Object.create(FileView.prototype), {
			file: { path: 'a.gallery.md', stat: { mtime: 1 } },
			containerEl,
			getViewType: () => 'gallery',
		}) as unknown as FileView & { containerEl: HTMLElement; file: { path: string } };
		(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-g', view, containerEl };
		const { manager } = makeManager(view);

		expect(manager.canGoToEdge()).toBe(false);
		manager.goToEdge('top');
	});

	it('活动的是面板时，作用在读者最后待过的那个主区视图上', () => {
		const scroller = makeScroller(1000, 200, 300);
		scroller.className = 'cm-scroller';
		const view = makeForeignView(scroller);
		const { manager } = makeManager(null, [{ id: 'leaf-y', view, activeTime: 7 }]);

		expect(manager.canGoToEdge()).toBe(true);
		manager.goToEdge('bottom');
		expect(scroller.scrollTop).toBe(800);
	});
});

// 视图 → 正文滚动容器的判据（见 shared/wait.ts 的 scrollContainerIn）。
describe('给任意视图找正文滚动容器', () => {
	function fakeView(containerEl: HTMLElement): View {
		return { containerEl } as unknown as View;
	}

	it('优先 app 自己的正文容器，而不是页面里更大的那个', () => {
		const root = document.createElement('div');
		const note = makeScroller(1000, 400);
		note.className = 'cm-scroller';
		const list = makeScroller(2000, 800);
		list.style.overflowY = 'auto';
		root.append(note, list);

		expect(scrollContainerIn(fakeView(root))).toBe(note);
	});

	it('没有正文容器时，退到可见高度最大的可滚元素', () => {
		const root = document.createElement('div');
		const small = makeScroller(500, 100);
		small.style.overflowY = 'auto';
		const big = makeScroller(2000, 600);
		big.style.overflowY = 'auto';
		root.append(small, big);

		expect(scrollContainerIn(fakeView(root))).toBe(big);
	});

	// youtnote 的正文编辑器就是这种形状：`.cm-scroller` 随内容长高、自己不滚，真正滚的是外面
	// 那个 notes-list。先认名字会拿到一个永远滚不动的元素。
	it('正文容器自己不滚时，认真正在滚的那个外层', () => {
		const root = document.createElement('div');
		const cm = makeScroller(2880, 2880);
		cm.className = 'cm-scroller';
		const list = makeScroller(2948, 522);
		list.style.overflowY = 'auto';
		root.append(cm, list);

		expect(scrollContainerIn(fakeView(root))).toBe(list);
	});

	// 内容还没撑出滚动条时，两端命令仍然可用（按下去什么都不用做）—— 同一篇笔记长到可滚之后
	// 不该从「灰着」变成「可用」再变回去。
	it('短内容还没有滚动条时，仍答得出正文容器', () => {
		const root = document.createElement('div');
		const cm = makeScroller(400, 400);
		cm.className = 'cm-scroller';
		root.append(cm);

		expect(scrollContainerIn(fakeView(root))).toBe(cm);
	});

	it('overflow: hidden 与不滚的元素都不算', () => {
		const root = document.createElement('div');
		const hidden = makeScroller(2000, 600);
		hidden.style.overflowY = 'hidden';
		const short = makeScroller(500, 600);
		short.style.overflowY = 'auto';
		root.append(hidden, short);

		expect(scrollContainerIn(fakeView(root))).toBe(null);
	});
});
