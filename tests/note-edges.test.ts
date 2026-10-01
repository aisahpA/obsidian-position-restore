// A note's two ends, as commands of ours (see position/edges.ts and
// manager.goToEdge). What is worth pinning is the part that is NOT the
// scrolling:
//  - which element is moved, and to which end of its range — the bottom being the end of
//    the NOTE at the end of what the reader can SEE: not the furthest the view can
//    scroll once the app's backlinks pane is inside the same scroller, and not the
//    bottom of the window once the app floats one of its bars over it;
//  - the caret an editor key leaves, in BOTH modes: a reading view shows none, but
//    the editor behind it is real and outlives the switch to editing;
//  - a command pressed at the end it asks for moving nothing and recording
//    nothing — otherwise back needs as many presses to get back to where the
//    reader was;
//  - the arrival being told to the VIEW as well, which is what a mode switch
//    carries across — a move made on the DOM never reaches it in reading mode;
//  - the caret being the half that still moves when the view already stands
//    at that end: a note can show its top with the cursor 200 lines down;
//  - the step: where the reader stood stays on the stack, and the arrival is
//    a step of its own rather than a rewrite of it.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { App, MarkdownView } from 'obsidian';

import { atEdge, caretAtEdge, holdEdge, moveToEdge, syncViewScroll } from '@/position/edges';
import { PositionManager } from '@/position/manager';
import type { NavFunnel } from '@/nav/funnel';
import type { NavStack } from '@/nav-history/stack';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

// A scroll container with a real range: jsdom has no layout, so scrollHeight
// and clientHeight are stated here and scrollTop clamps the way a browser's
// does — the clamping is what puts the last line at the END of the viewport,
// which is the whole point of asking for the bottom.
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

// jsdom has no layout, so a box is stated here — a scroller's own top reads as 0.
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

// The app's backlinks pane, appended inside the scroller it shares with the note (reading: the
// renderer's footer section; source: the sizer). A height of 0 stands for the pane while the
// setting is off: created, hidden, and collapsed to no box at all.
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

// Gives an element the box jsdom will not compute for it.
function stubRect(el: HTMLElement, top: number, height: number): void {
	Object.defineProperty(el, 'getBoundingClientRect', {
		configurable: true,
		value: () => rectAt(top, height),
	});
}

// One of the app's own bars, floating over the foot of a note instead of above or below it. Both
// are mobile-only, so a desktop has none and measures nothing.
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
	// What the mode reports as its own position; null is a reading renderer that has not caught up.
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
	// Attached: the hold after a move stops when the view is no longer in the document.
	document.body.appendChild(containerEl);
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path: 'a.md', stat: { mtime: 1 } },
		getMode: () => opts.mode,
		currentMode: {
			getScroll: () => (opts.modeScroll !== undefined ? opts.modeScroll : opts.topLine ?? 300),
		},
		setEphemeralState: vi.fn(),
		// Both modes: `view.editor` is the leaf's edit mode, present and live whatever is
		// being displayed (see caretToEdge) — no caret is SHOWN in reading mode.
		editor,
		contentEl,
		containerEl,
		getViewType: () => 'markdown',
	}) as MarkdownView & {
		editor: typeof editor;
	};
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1', view };
	return { view, editor };
}

function makeManager(
	view: MarkdownView | null,
	// The leaves walked when the active leaf is NOT the note (see markdownViewInUse):
	// a fixture whose active view is the note never reaches them.
	leaves: { id?: string; view: unknown }[] = [],
) {
	const db: Record<string, { scroll: number }> = {};
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
			rootSplit: { containerEl: { contains: () => false } },
			getActiveViewOfType: () => view,
			// …and the walk the plugin falls back on when the ACTIVE leaf is a panel
			// rather than the note: a control standing in a panel is that leaf the moment
			// it is tapped (see markdownViewInUse). A fixture with no note anywhere has to
			// be able to answer "there is nothing to go to" without throwing.
			getLeavesOfType: () => leaves,
			iterateAllLeaves: () => undefined,
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

		// 1000 - 200: asking for more than the range has is clamped, and the
		// clamped value is the one that shows the last screenful.
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

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 2, ch: 5 }); // "three"
	});

	it('阅读视图也一样移动，它的光标不是用来显示的', () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view, editor } = makeView({ mode: 'preview', scroller, cursor: { line: 2, ch: 3 } });

		moveToEdge(view, 'top');

		expect(scroller.scrollTop).toBe(0);
		// Placed, not shown: switching to editing afterwards is when it becomes visible, and
		// the mode switch carries the scroll and the folds, never the selection.
		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
	});
});

// The bottom of a note is the end of what the reader wrote. The backlinks pane is a pane of the
// TAB, appended inside the same scroller, and one taller than a window puts the furthest
// scrollable point past the note's last line altogether.
describe('是笔记的末尾，不是标签页的末尾', () => {
	it('停在面板开始的地方，让最后一行还看得见', () => {
		const scroller = makeScroller(1000, 200, 0);
		withBacklinks(scroller, 700); // the pane fills 700..1000 of a 200-tall window
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		// 700 - 200, not 800: 800 is the end of the pane, not of the note.
		expect(scroller.scrollTop).toBe(500);
	});

	it('面板被关掉时就走到最远处', () => {
		const scroller = makeScroller(1000, 200, 0);
		withBacklinks(scroller, 700, 0);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(800);
	});

	it('reads the pane\'s edge as the end, so the far end is no longer "already there"', () => {
		const scroller = makeScroller(1000, 200, 800);
		withBacklinks(scroller, 700);
		const { view } = makeView({ mode: 'preview', scroller });

		expect(atEdge(view, 'bottom')).toBe(false); // the far end is past the note
		scroller.scrollTop = 500;
		expect(atEdge(view, 'bottom')).toBe(true);
	});

	// Too short to scroll: the pane's edge is above the window, so there is nowhere to stop
	// short of — and nowhere to go.
	it('对滚不动的笔记什么都不要求', () => {
		const scroller = makeScroller(200, 200);
		withBacklinks(scroller, 150);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(0);
	});
});

// The bottom of the window is not the bottom of what the reader can SEE: on a phone the app floats
// one of its own bars over the foot of a note. Which bar is there depends on the mode, and a soft
// keyboard moves it, so the strip is measured rather than read off a variable.
describe('窗口里读者看不见的那一部分', () => {
	// A 200-tall window, the note ending at 700, and a bar over its foot.
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

		// 700 - (200 - 40): the last line clears the bar, which the pane below it does not.
		expect(scroller.scrollTop).toBe(540);
	});

	// A soft keyboard pushes the bar off the window instead of over it.
	it('栏已经不挡道了就一点都不扣', () => {
		const { scroller, view } = underBar(210);

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(500);
	});

	// No pane means the app has already padded the foot of the note by half a window, so the last
	// line clears the bar on its own — and there is nowhere further to go anyway.
	it('没有面板可以提前停时就要求最远处', () => {
		const { scroller, view } = underBar(160, 40, false);

		moveToEdge(view, 'bottom');

		expect(scroller.scrollTop).toBe(800);
	});
});

// The end is not always kept: the reading renderer re-applies a scroll it captured BEFORE the
// move, one render pass later — a pass the reader's own scrolling queued, which finishes after
// the command has run. That is the flash at the top followed by the slide back.
describe('把端点按住', () => {
	// Every write to the scroller is followed, a tick later, by the old position coming back.
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

	// Two corrections and out: a view that keeps being clobbered is one the plugin cannot win,
	// and a command must not spend the rest of the session fighting it.
	it('停止校正，而不是跟一个一直赢的东西对打', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		const writes = clobber(scroller, 400, 99);

		moveToEdge(view, 'top');
		await holdEdge(view, 'top');

		// The move and two corrections: a view that keeps being clobbered is one the plugin
		// cannot win, and a command must not spend the rest of the session fighting it.
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

		// The move alone: the moment the reader takes over, the hold is fighting THEM.
		expect(writes.writes).toBe(1);
	});

	// The hold re-applies the end it moved to, which with a pane in the way is NOT the furthest:
	// every correction would otherwise land at the end of the pane instead of the note.
	it('holds the note\'s end rather than being pushed on to the far end', async () => {
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

	// A note shorter than its window cannot be scrolled to either end, so both
	// commands are already satisfied — and neither should record an arrival.
	it('短到根本滚不动的笔记，两端都算', () => {
		const { view } = makeView({ mode: 'preview', scroller: makeScroller(200, 200) });

		expect(atEdge(view, 'top')).toBe(true);
		expect(atEdge(view, 'bottom')).toBe(true);
	});

	// The scroll is only half of "already there" — see the caret below.
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

// The caret is what a reader still wants moved when the view already shows the end they asked
// for: a note can be sitting at its top with the cursor 200 lines down, and "go to the top" that
// answers "you are already there" leaves the reader to find it by hand.
describe('光标站在那一端', () => {
	const atTop = (cursor: { line: number; ch: number }) =>
		makeView({ mode: 'source', scroller: makeScroller(1000, 200, 0), cursor }).view;
	const atBottom = (cursor: { line: number; ch: number }) =>
		makeView({ mode: 'source', scroller: makeScroller(1000, 200, 800), cursor }).view;

	it('只有在移动会把它留在那儿时才算', () => {
		expect(caretAtEdge(atTop({ line: 0, ch: 0 }), 'top')).toBe(true);
		expect(caretAtEdge(atTop({ line: 0, ch: 2 }), 'top')).toBe(false);
		expect(caretAtEdge(atBottom({ line: 2, ch: 5 }), 'bottom')).toBe(true); // end of "three"
		expect(caretAtEdge(atBottom({ line: 2, ch: 3 }), 'bottom')).toBe(false);
	});

	// Reading mode is no exception: its caret is invisible, not absent.
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

// A mode switch does not resume from the DOM: setMode() carries `view.scroll`, and only
// view.syncScroll() fills that in — which a reading view calls from its own scroll handler only
// when the last render is at least 100ms old, something scrolling a virtualized preview never is.
// Asking for an end in reading mode and switching to editing therefore resumed where the reader
// stood BEFORE the command.
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
	// Stand in a.md at line 300, then ask for the bottom.
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

		// Two steps: the one holding line 300, and the arrival — which is a
		// step and not a rewrite of the first, so the first is still returnable.
		expect(stack.entries).toHaveLength(2);
		expect(stack.entries[0].kind).toBe('visit');
		expect(stack.entries[0].kind !== 'view' && stack.entries[0].st?.scroll).toBe(300);
		expect(stack.entries[1].kind !== 'view' && stack.entries[1].st).toBeUndefined();

		// Where they ended up lands on the arrival, leaving the standing place intact for
		// back. The hold is still open — the plugin is still moving the view — so wait it
		// out before asking whether back is available.
		funnel.leave('a.md', 'leaf-1', { scroll: 900 });
		expect(stack.entries[1].kind !== 'view' && stack.entries[1].st?.scroll).toBe(900);
		expect(stack.entries[0].kind !== 'view' && stack.entries[0].st?.scroll).toBe(300);
		await new Promise((resolve) => window.setTimeout(resolve, 500));
		expect(stack.canNavigate(-1)).toBe(true);
	});

	it('视图本来就在那一端时不记任何东西', async () => {
		const { manager, stack } = standingAt(800); // the furthest this view goes

		manager.goToEdge('bottom');
		await Promise.resolve();

		expect(stack.entries).toHaveLength(1);
	});

	// The view showing the top is not the same as the reader being there: the caret is half of
	// what the command moves. No step for it — back from a press that stirred nothing the eye
	// could see would answer with another such press.
	it('仍然挪动视图落在后面的光标，但不记步', async () => {
		const { manager, stack, editor } = standingAt(0, 'source', { line: 2, ch: 3 });

		manager.goToEdge('top');
		await Promise.resolve();

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
		expect(stack.entries).toHaveLength(1);
	});

	// …in reading mode too, where what gets placed is the caret the mode switch will uncover.
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

	// …and the arrival has to reach the view too, or switching modes resumes the place the reader
	// stood before the command (see the sync above).
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

	// …and a note the reader was in when the active leaf is NOT it: a control standing in
	// a panel — the arrows — IS the active leaf the moment it is tapped, and the app's own
	// `getActiveViewOfType` answers off that leaf alone, so a panel asking for an end would
	// be given nothing. This is the whole of what makes a button in a panel pressable.
	it('作用在读者所在的那个标签页上，而不是握着焦点的那个 leaf', () => {
		const scroller = makeScroller(1000, 200, 300);
		const { view } = makeView({ mode: 'preview', scroller, topLine: 300 });
		const { manager } = makeManager(null, [{ id: 'leaf-1', view }]);

		expect(manager.canGoToEdge()).toBe(true);
		manager.goToEdge('top');
		expect(scroller.scrollTop).toBe(0);
	});
});
