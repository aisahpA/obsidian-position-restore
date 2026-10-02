// 按 leaf 划分的恢复取代语义的单元测试 —— 即「跨 leaf 卡住盖布」那个
// bug 的修复。恢复的新旧必须按 leaf 判定：只有**同一个** leaf 上更新的
// 恢复（或该 leaf 的视图挪到了别的文件）才能取代一次正在飞的恢复。在
// **不同** leaf 上并发跑的恢复绝不能把它作废，否则第一个 leaf 的遮罩
// 恢复会跳过揭幕（恢复遮罩没有安全计时器），窗格就永远停在 opacity 0。
//
// 两层：
//  - PositionState::beginLeafRestore / isCurrentLeafRestore，修复所依赖
//    的那套 API（快、确定性）；
//  - 一次完整的跨 leaf 全流水线恢复：leaf A 在恢复途中停在盖布底下，
//    leaf B 完整恢复，而 A 仍然必须揭幕。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarkdownView, FileView, type WorkspaceLeaf } from 'obsidian';

import { PositionState } from '@/position/state';
import { Restorer } from '@/position/restore/restorer';
import { PositionStore } from '@/position/storage/position-store';
import { DEFAULT_SETTINGS } from '@/types';

describe('PositionState 按 leaf 划分的恢复轮次', () => {
	it('别的标签页上的恢复不顶掉本标签页正在进行的恢复', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const runA = state.beginLeafRestore('leafA', 'a.md');
		const runB = state.beginLeafRestore('leafB', 'b.md');

		expect(state.isCurrentLeafRestore('leafA', runA)).toBe(true);
		expect(state.isCurrentLeafRestore('leafB', runB)).toBe(true);
	});

	it('同一个 leaf 上更新的恢复顶掉早先的', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const run1 = state.beginLeafRestore('leafA', 'a.md');
		const run2 = state.beginLeafRestore('leafA', 'b.md'); // 同 leaf 快速切换

		expect(state.isCurrentLeafRestore('leafA', run1)).toBe(false);
		expect(state.isCurrentLeafRestore('leafA', run2)).toBe(true);
	});

	it('清掉标签页的进行中条目会让它的各次运行作废（赢家已经跑完）', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const run = state.beginLeafRestore('leafA', 'a.md');

		state.inFlightRestoreLeafRuns.delete('leafA');

		expect(state.isCurrentLeafRestore('leafA', run)).toBe(false);
	});

	it('run id 在整个会话里唯一，所以清理绝不会打到复用的 id', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const runA = state.beginLeafRestore('leafA', 'a.md');
		const runB = state.beginLeafRestore('leafB', 'b.md');

		expect(runB).toBe(runA + 1);
	});
});

// ---- 跨 leaf 的全流水线回归 ----

// OpenCover 通过 Obsidian 给 HTMLElement 加的 setCssStyles 扩展
// 来给 leaf 的 DOM 上样式，jsdom 没有这个扩展。
beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};

function makeLeaf(id: string): WorkspaceLeaf {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf;
}

// 在 jsdom 里**永不**变成内容就绪的阅读模式视图（没有版面 →
// sizer.scrollHeight 一直是 0），所以它的遮罩恢复会停在盖布底下，
// 直到 CONTENT_READY_MAX_MS 期限。给交错测试一个确定性的停放点。
function makeParkedPreviewView(leaf: WorkspaceLeaf, filePath = 'a.md'): MarkdownView {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	const scroller = document.createElement('div');
	scroller.className = 'markdown-preview-view';
	scroller.style.height = '1000px';
	containerEl.append(scroller);
	let currentScroll = 0;
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf,
		file: { path: filePath },
		getMode: () => 'preview',
		currentMode: { getScroll: () => currentScroll },
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			currentScroll = (s.scroll as number) ?? 0;
			scroller.scrollTop = currentScroll;
		},
	});
	leaf.view = view;
	return view;
}

// 源码模式视图：瞬间恢复（没有异步渲染要等），所以当停着的那份预览
// 还被盖着时，它能一路跑完。
function makeSourceView(leaf: WorkspaceLeaf, filePath = 'b.md'): MarkdownView {
	const contentEl = document.createElement('div');
	const containerEl = document.createElement('div');
	let currentScroll = 0;
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	Object.assign(view, {
		leaf,
		file: { path: filePath },
		getMode: () => 'source',
		currentMode: { getScroll: () => currentScroll },
		data: 'x',
		contentEl,
		containerEl,
		editor: { getCursor: () => undefined },
		setEphemeralState: (s: Record<string, unknown>) => {
			currentScroll = (s.scroll as number) ?? 0;
		},
	});
	leaf.view = view;
	return view;
}

describe('跨 leaf 的恢复并发（卡住盖布那个回归）', () => {
	it('第二个 leaf 上的恢复不会把第一个 leaf 卡在盖布底下', async () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const leafA = makeLeaf('leafA');
		const leafB = makeLeaf('leafB');
		const viewA = makeParkedPreviewView(leafA, 'a.md');
		const viewB = makeSourceView(leafB, 'b.md');

		let activeView: MarkdownView | undefined = viewA;
		const app = {
			workspace: {
				layoutReady: true,
				// 桩替身照着 `MarkdownView extends FileView` 来。
				getActiveViewOfType: (Type: unknown) =>
					activeView && (Type === MarkdownView || Type === FileView) ? activeView : undefined,
				iterateAllLeaves: () => undefined,
			},
		};
		const store = new PositionStore(
			app as never,
			{ db: { 'a.md': RECORD, 'b.md': RECORD } } as never,
		);
		const restorer = new Restorer(app as never, DEFAULT_SETTINGS, store, state);

		// Leaf A 在自己的恢复盖布底下停在遮罩恢复途中。
		const promiseA = restorer.restoreEphemeralState();
		// A 还被盖着时 leaf B 打开了；它的恢复完整跑完。
		activeView = viewB;
		await restorer.restoreEphemeralState();
		expect(state.restoreRun).toBe(2); // 两次恢复都真的跑了

		// 让 A 走完它的内容就绪期限并揭幕。
		await promiseA;

		// A 也揭幕了：它的 contentEl opacity 被抬起来了。用旧的全局单计数器
		// isCurrent 时，它会永远停在 '0'。
		expect(viewA.contentEl.style.opacity).toBe('');
		expect(viewB.contentEl.style.opacity).toBe('');
	}, 15000);
});

afterEach(() => {
	vi.restoreAllMocks();
});