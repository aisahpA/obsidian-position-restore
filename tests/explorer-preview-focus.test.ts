// 插件给 **app 自己的**文件列表（ExplorerPreviewFocus）那个悬停预览瞄准点的单元测试。
// app 向 core 要那个预览时不带位置 —— `trigger("hover-link", { linktext: path })`，
// 没有 state —— 所以卡片画在笔记顶部；这里是唯一可以给它补一个位置的地方。
//
// 各用例钉住的东西：
//  - 出厂的就是笔记顶部，所以默认安装什么都不改变；
//  - 被索要行号时，载荷携带的是为那个**文件**记下的位置 —— 不是从列表里取的一个落点，
//    也不是重新推导出来的行号；
//  - 每一个答不出来的情形，都让这次索要和 app 发出时一模一样；
//  - 这个补丁就是个补丁：它无意更改的一切都被转发，而 unload 会把 trigger 交回去。

import { describe, it, expect, afterEach } from 'vitest';
import { App, MarkdownPreviewRenderer } from 'obsidian';

import { ExplorerPreviewFocus } from '@/position/hover/explorer-preview';
import { CursorPositionDatabase } from '@/position/storage/database';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

// app 的文件列表在它的悬停索要里放的东西，也是本模块在它里面唯一能碰的东西。
interface Ask {
	source: string;
	linktext: string;
	state?: { scroll: number };
}

type PreviewFocusMode = PluginSettings['fileExplorerPreviewFocus'];

// 一个预览的渲染器被要求做的事：移到某一行，并在抵达时把它标出来 —— 后者是 core 自己
// 那次调用烤进去的。
interface Move {
	line: number;
	opts?: { highlight?: boolean; center?: boolean };
}

// 这个方法不在类型声明里 —— 它是 core 自己那个延迟滚动，是内部的 —— 所以补丁和这些
// 测试都经由这个形状去碰它。
const rendererProto = () => MarkdownPreviewRenderer.prototype as unknown as {
	applyScrollDelayed?: (line: number, opts?: Move['opts']) => void;
};

// 替代 core 的延迟滚动，好让测试读到补丁往下传的那些选项，而且只读那些：记下来的那次
// 移动就是全部断言。
const restorers: (() => void)[] = [];

function recordingRenderer() {
	const proto = rendererProto();
	const original = proto.applyScrollDelayed;
	const moves: Move[] = [];
	proto.applyScrollDelayed = function (line: number, opts?: Move['opts']) {
		moves.push({ line, opts });
	};
	restorers.push(() => {
		proto.applyScrollDelayed = original;
	});
	const renderer = new MarkdownPreviewRenderer() as unknown as {
		applyScrollDelayed: (line: number, opts?: Move['opts']) => void;
	};
	return {
		moves,
		to: (line: number, opts?: Move['opts']) => {
			renderer.applyScrollDelayed(line, opts);
			return moves.at(-1);
		},
	};
}

function installed(
	focus: PreviewFocusMode,
	db: Record<string, { scroll?: number }>,
	files: Record<string, string>,
) {
	const calls: { name: string; data: unknown[] }[] = [];
	const original = (name: string, ...data: unknown[]) => {
		calls.push({ name, data });
	};
	const workspace = { trigger: original };
	const app = {
		workspace,
		vault: {
			getFileByPath: (path: string) =>
				(path in files ? { path, extension: files[path] } : null),
		},
	} as unknown as App;
	const settings: PluginSettings = { ...DEFAULT_SETTINGS, fileExplorerPreviewFocus: focus };
	const target = new ExplorerPreviewFocus(
		app,
		{ db } as unknown as CursorPositionDatabase,
		settings,
	);
	const cleanups: (() => void)[] = [];
	const flash = recordingRenderer();
	target.install(fn => cleanups.push(fn));
	return {
		workspace,
		calls,
		cleanups,
		flash,
		// app 自己发出的那种索要：一个路径，没有位置。
		fileList: (linktext: string, state?: { scroll: number }): Ask => {
			const ask: Ask = { source: 'file-explorer', linktext };
			if (state)
				ask.state = state;
			workspace.trigger('hover-link', ask);
			return ask;
		},
	};
}

const note = { 'a.md': 'md', 'scan.pdf': 'pdf' };

// 每次安装都会在渲染器的原型上叠一个补丁；在下一个测试在它上面再叠一个之前交回去。
afterEach(() => {
	while (restorers.length)
		restorers.pop()?.();
});

describe('app 文件列表的悬停预览', () => {
	it('笔记本来就该开在顶部时，什么也不加', () => {
		const h = installed('head', { 'a.md': { scroll: 12 } }, note);

		const ask = h.fileList('a.md');

		expect(ask.state).toBeUndefined();
		expect(h.calls).toHaveLength(1);
	});

	it('被问到时说出这篇笔记最后记下的那一行', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);

		const ask = h.fileList('a.md');

		expect(ask.state).toEqual({ scroll: 12 });
	});

	it('本插件没记过位置的，不说行号', () => {
		const h = installed('line', {}, note);

		expect(h.fileList('a.md').state).toBeUndefined();
	});

	it('记下的位置就是顶部时也不说', () => {
		// 一条 scroll 为 0 的记录会买下整段等待，却哪儿都不挪。
		const h = installed('line', { 'a.md': { scroll: 0 } }, note);

		expect(h.fileList('a.md').state).toBeUndefined();
	});

	it('不是笔记的文件不说', () => {
		const h = installed('line', { 'scan.pdf': { scroll: 40 } }, note);

		expect(h.fileList('scan.pdf').state).toBeUndefined();
	});

	it('别的来源发出的提问一律不动', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		const ask: Ask = { source: 'search', linktext: 'a.md' };

		h.workspace.trigger('hover-link', ask);

		expect(ask.state).toBeUndefined();
	});

	it('提问已经自带位置时不覆盖它', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);

		expect(h.fileList('a.md', { scroll: 3 }).state).toEqual({ scroll: 3 });
	});

	it('不打算改的事件原样转发', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);

		h.workspace.trigger('file-open', { path: 'a.md' });

		expect(h.calls).toEqual([{ name: 'file-open', data: [{ path: 'a.md' }] }]);
	});

	it('卸载时把 trigger 还回去', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		const patched = h.workspace.trigger;

		for (const cleanup of h.cleanups)
			cleanup();

		expect(h.workspace.trigger).not.toBe(patched);
		expect(h.fileList('a.md').state).toBeUndefined();
	});
});

// core 在「移到某一行」上挂了一次闪：`applyScrollDelayed` 被调用时带着
// `{highlight:true, center:true}`，而一次悬停索要没有任何字段能说不。本插件的行号引起
// 的那次移动，是唯一一次不带它跑的移动。
describe('随这次移动而来的高亮', () => {
	it('本插件指定行号引起的那次移动，高亮被丢掉', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12, { highlight: true, center: true })).toEqual({
			line: 12,
			opts: { highlight: false, center: true },
		});
	});

	it('本插件没有指定目标的移动，高亮保留', () => {
		// 出厂的就是笔记顶部，所以这次预览压根没索要行号 —— 而一次不是这里引起的移动上的闪，
		// 轮不到我们来丢。
		const h = installed('head', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12, { highlight: true })!.opts).toEqual({ highlight: true });
	});

	it('移到别的行时高亮保留', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(30, { highlight: true })!.opts).toEqual({ highlight: true });
	});

	it('只被第一次会闪的那次移动花掉', () => {
		// 一次瞄准，丢一次闪：第二次移到同一行的移动，已经不是本插件还站在它背后的那次了。
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12, { highlight: true })!.opts!.highlight).toBe(false);
		expect(h.flash.to(12, { highlight: true })!.opts!.highlight).toBe(true);
	});

	it('别的列表已经问过就别再动它', () => {
		// 最后一次索要赢：从别处来的一次悬停意味着下一次闪属于那次索要。
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');
		h.workspace.trigger('hover-link', { source: 'search', linktext: 'a.md' });

		expect(h.flash.to(12, { highlight: true })!.opts).toEqual({ highlight: true });
	});

	it('一次从没要求闪的移动不会花掉它', () => {
		// Hover Editor 在 resize 时会用完全不给选项的方式调用同一个方法：那次移动不要闪，所以
		// 它绝不能把后面那次要闪的移动所依靠的这次瞄准用掉。
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12)!.opts).toBeUndefined();
		expect(h.flash.to(12, { highlight: true })!.opts!.highlight).toBe(false);
	});

	it('卸载时把渲染器还回去', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		const patched = rendererProto().applyScrollDelayed;

		for (const cleanup of h.cleanups)
			cleanup();

		expect(rendererProto().applyScrollDelayed).not.toBe(patched);
	});
});
