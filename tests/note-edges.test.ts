// A note's two ends, as commands of ours (see position/edges.ts and
// manager.goToEdge). What is worth pinning is the part that is NOT the
// scrolling:
//  - which element is moved, and to which end of its range;
//  - the caret a source view leaves (an editor key moves one, a scroll does
//    not) and reading mode having none to move;
//  - a command pressed at the end it asks for recording nothing — otherwise
//    back needs as many presses to get back to where the reader was;
//  - the step: where the reader stood stays on the stack, and the arrival is
//    a step of its own rather than a rewrite of it.

import { describe, it, expect, vi } from 'vitest';
import { App, MarkdownView } from 'obsidian';

import { atEdge, moveToEdge } from '@/position/edges';
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
	Object.defineProperty(el, 'scrollHeight', { get: () => content });
	Object.defineProperty(el, 'clientHeight', { get: () => viewport });
	Object.defineProperty(el, 'scrollTop', {
		get: () => cur,
		set: (v: number) => {
			cur = Math.min(Math.max(0, v), Math.max(0, content - viewport));
		},
	});
	return el;
}

function makeView(opts: { mode: 'source' | 'preview'; scroller: HTMLElement; topLine?: number }) {
	const lines = ['one', 'two', 'three'];
	const editor = {
		lineCount: () => lines.length,
		getLine: (n: number) => lines[n] ?? '',
		lastLine: () => lines.length - 1,
		getCursor: () => ({ line: 0, ch: 0 }),
		setCursor: vi.fn(),
	};
	opts.scroller.className = opts.mode === 'source' ? 'cm-scroller' : 'markdown-preview-view';
	const contentEl = document.createElement('div');
	contentEl.appendChild(opts.scroller);
	const containerEl = document.createElement('div');
	containerEl.appendChild(contentEl);
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
});

describe('the step an end takes', () => {
	// Stand in a.md at line 300, then ask for the bottom.
	function standingAt(topLine: number) {
		const scroller = makeScroller(1000, 200, topLine);
		const { view } = makeView({ mode: 'preview', scroller, topLine });
		const rig = makeManager(view);
		rig.funnel.recordOpen('a.md', 'leaf-1');
		rig.funnel.leave('a.md', 'leaf-1', { scroll: topLine });
		return { ...rig, scroller };
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

		// Where they ended up lands on the arrival, leaving the standing place
		// intact for back.
		funnel.leave('a.md', 'leaf-1', { scroll: 900 });
		expect(stack.entries[1].kind !== 'view' && stack.entries[1].st?.scroll).toBe(900);
		expect(stack.canNavigate(-1)).toBe(true);
		expect(stack.entries[0].kind !== 'view' && stack.entries[0].st?.scroll).toBe(300);
	});

	it('records nothing when the view already stands at that end', async () => {
		const { manager, stack } = standingAt(800); // the furthest this view goes

		manager.goToEdge('bottom');
		await Promise.resolve();

		expect(stack.entries).toHaveLength(1);
	});

	it('is available only while a note is the active view', () => {
		expect(makeManager(null).manager.canGoToEdge()).toBe(false);
		expect(standingAt(300).manager.canGoToEdge()).toBe(true);
	});
});
