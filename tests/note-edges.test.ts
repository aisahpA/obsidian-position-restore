// A note's two ends, as commands of ours (see position/edges.ts and
// manager.goToEdge). What is worth pinning is the part that is NOT the
// scrolling:
//  - which element is moved, and to which end of its range;
//  - the caret a source view leaves (an editor key moves one, a scroll does
//    not) and reading mode having none to move;
//  - a command pressed at the end it asks for recording nothing — otherwise
//    back needs as many presses to get back to where the reader was;
//  - the caret being the half that still moves when the view already stands
//    at that end: a note can show its top with the cursor 200 lines down;
//  - the step: where the reader stood stays on the stack, and the arrival is
//    a step of its own rather than a rewrite of it.

import { describe, it, expect, vi } from 'vitest';
import { App, MarkdownView } from 'obsidian';

import { atEdge, caretAtEdge, holdEdge, moveToEdge } from '@/position/edges';
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

function makeView(opts: {
	mode: 'source' | 'preview';
	scroller: HTMLElement;
	topLine?: number;
	cursor?: { line: number; ch: number };
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
		currentMode: { getScroll: () => opts.topLine ?? 300 },
		editor: opts.mode === 'source' ? editor : undefined,
		contentEl,
		containerEl,
		getViewType: () => 'markdown',
	}) as MarkdownView & {
		editor: typeof editor | undefined;
	};
	(view as unknown as { leaf: unknown }).leaf = { id: 'leaf-1', view };
	return { view, editor };
}

function makeManager(view: MarkdownView | null) {
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

describe('moving to an end of a note', () => {
	it('scrolls the view to the top of its own range', () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'top');

		expect(scroller.scrollTop).toBe(0);
	});

	it('scrolls to the far end, where the last line sits at the bottom', () => {
		const scroller = makeScroller(1000, 200, 0);
		const { view } = makeView({ mode: 'preview', scroller });

		moveToEdge(view, 'bottom');

		// 1000 - 200: asking for more than the range has is clamped, and the
		// clamped value is the one that shows the last screenful.
		expect(scroller.scrollTop).toBe(800);
	});

	it('leaves the caret at the head of the first line, being an editor key', () => {
		const { view, editor } = makeView({ mode: 'source', scroller: makeScroller(1000, 200, 400) });

		moveToEdge(view, 'top');

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
	});

	it('leaves the caret at the end of the last line', () => {
		const { view, editor } = makeView({ mode: 'source', scroller: makeScroller(1000, 200, 0) });

		moveToEdge(view, 'bottom');

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 2, ch: 5 }); // "three"
	});

	it('moves a reading view, which has no caret to leave', () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });

		expect(() => moveToEdge(view, 'top')).not.toThrow();
		expect(scroller.scrollTop).toBe(0);
	});
});

// The end is not always kept: the reading renderer re-applies a scroll it captured BEFORE the
// move, one render pass later — a pass the reader's own scrolling queued, which finishes after
// the command has run. That is the flash at the top followed by the slide back.
describe('holding the end', () => {
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

	it('puts the end back when a late render pass restores the old position', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		clobber(scroller, 400);

		moveToEdge(view, 'top');
		await holdEdge(view, 'top');

		expect(scroller.scrollTop).toBe(0);
	});

	// Two corrections and out: a view that keeps being clobbered is one the plugin cannot win,
	// and a command must not spend the rest of the session fighting it.
	it('stops correcting rather than fighting something that keeps winning', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		const writes = clobber(scroller, 400, 99);

		moveToEdge(view, 'top');
		await holdEdge(view, 'top');

		// The move and two corrections: a view that keeps being clobbered is one the plugin
		// cannot win, and a command must not spend the rest of the session fighting it.
		expect(writes.writes).toBeLessThanOrEqual(3);
	});

	it('yields the moment the reader moves on their own', async () => {
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

	it('leaves a scroller no longer in the document alone', async () => {
		const scroller = makeScroller(1000, 200, 400);
		const { view } = makeView({ mode: 'preview', scroller });
		scroller.remove();

		await expect(holdEdge(view, 'top')).resolves.toBeUndefined();
	});
});

describe('already standing at that end', () => {
	it('is true at the top for the top, and at the bottom for the bottom', () => {
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
	it('is true of both ends in a note too short to scroll', () => {
		const { view } = makeView({ mode: 'preview', scroller: makeScroller(200, 200) });

		expect(atEdge(view, 'top')).toBe(true);
		expect(atEdge(view, 'bottom')).toBe(true);
	});

	// The scroll is only half of "already there" — see the caret below.
	it('is still true of the scroll when the caret is somewhere else', () => {
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
describe('the caret standing at that end', () => {
	const atTop = (cursor: { line: number; ch: number }) =>
		makeView({ mode: 'source', scroller: makeScroller(1000, 200, 0), cursor }).view;
	const atBottom = (cursor: { line: number; ch: number }) =>
		makeView({ mode: 'source', scroller: makeScroller(1000, 200, 800), cursor }).view;

	it('is true only where the move would leave it', () => {
		expect(caretAtEdge(atTop({ line: 0, ch: 0 }), 'top')).toBe(true);
		expect(caretAtEdge(atTop({ line: 0, ch: 2 }), 'top')).toBe(false);
		expect(caretAtEdge(atBottom({ line: 2, ch: 5 }), 'bottom')).toBe(true); // end of "three"
		expect(caretAtEdge(atBottom({ line: 2, ch: 3 }), 'bottom')).toBe(false);
	});

	// A reading view gets no caret move at all, so for it the scroll is the whole answer —
	// otherwise every press in reading mode would take a step it cannot act on.
	it('is true of a reading view, which has no caret to stand anywhere', () => {
		const { view } = makeView({ mode: 'preview', scroller: makeScroller(1000, 200, 0) });

		expect(caretAtEdge(view, 'top')).toBe(true);
		expect(caretAtEdge(view, 'bottom')).toBe(true);
	});
});

describe('the step an end takes', () => {
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

	it('keeps where the reader stood and gives the arrival a step of its own', async () => {
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

	it('records nothing when the view already stands at that end', async () => {
		const { manager, stack } = standingAt(800); // the furthest this view goes

		manager.goToEdge('bottom');
		await Promise.resolve();

		expect(stack.entries).toHaveLength(1);
	});

	// The view showing the top is not the same as the reader being there: the caret is half of
	// what the command moves, and a press that moves it is a press that took the reader somewhere.
	it('still moves a caret the view had left behind, and steps for it', async () => {
		const { manager, stack, editor } = standingAt(0, 'source', { line: 2, ch: 3 });

		manager.goToEdge('top');
		await Promise.resolve();

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });
		expect(stack.entries).toHaveLength(2);
	});

	it('does nothing when the caret already stands at that end too', async () => {
		const { manager, stack, editor } = standingAt(0, 'source', { line: 0, ch: 0 });

		manager.goToEdge('top');
		await Promise.resolve();

		expect(editor.setCursor).not.toHaveBeenCalled();
		expect(stack.entries).toHaveLength(1);
	});

	it('is available only while a note is the active view', () => {
		expect(makeManager(null).manager.canGoToEdge()).toBe(false);
		expect(standingAt(300).manager.canGoToEdge()).toBe(true);
	});
});
