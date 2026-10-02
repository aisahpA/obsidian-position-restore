// restore/anchor.ts 的测试：resolveAnchorLine 把一个带 key 的 NavJump 的结构性锚点
// （大纲标题、#标题 链接、^块 引用）解析到它在文件里**当前**的那一行，能扛住任意的
// 插入/删除位移 —— 与它为带 key 的跳转所取代的那套「±30 行文字片段重换算」相对。
//
// 一行所处的分节链不再在这里回答 —— 它搬到了 shared/headings.ts 的
// outlinePathAtLine，它的用例也跟着过去了。

import { describe, it, expect } from 'vitest';
import { resolveAnchorLine } from '@/position/restore/anchor';
import { outlineHeading } from '@/nav/entry';

function cache(headings: Array<[string, number] | [string, number, number]>, blocks?: Record<string, number>) {
	return {
		headings: headings.map(([heading, line, level = 1]) => ({
			heading,
			level,
			position: { start: { line }, end: { line } },
		})),
		blocks: blocks ? Object.fromEntries(
			Object.entries(blocks).map(([id, line]) => [id, { id, position: { start: { line }, end: { line } } }]),
		) : undefined,
	} as never;
}

describe('resolveAnchorLine', () => {
	it('把大纲标题 key 解析到它现在的行', () => {
		// 上面插入了 40 行；那个标题现在在第 42 行。
		const c = cache([['Alpha', 0], ['Beta', 42], ['Gamma', 90]]);
		expect(resolveAnchorLine(c, 'outline:Beta')).toBe(42);
	});

	it('大纲标题文本不区分大小写与空白', () => {
		const c = cache([['Some Heading', 7]]);
		expect(resolveAnchorLine(c, 'outline:some  heading')).toBe(7);
	});

	it('经归一化解析 #标题 链接（slug）', () => {
		const c = cache([['My Heading', 12]]);
		expect(resolveAnchorLine(c, 'note.md#my-heading')).toBe(12);
	});

	it('按精确 id 解析 ^块 引用', () => {
		const c = cache([], { '2024-01-01': 5 });
		expect(resolveAnchorLine(c, 'note.md^2024-01-01')).toBe(5);
	});

	it('解析 Obsidian 写出来的那种块链接形式', () => {
		// [[note#^id]] 交过来的是 `note.md#^id`，而那个 `#` 从前会把它送进标题 slug 那一支 ——
		// 那里没有任何标题是以块 id 命名的 —— 于是每一个块链接都错过了它的块，退回到文字片段
		// 重换算。
		const c = cache([], { b1: 7 });
		expect(resolveAnchorLine(c, 'note.md#^b1')).toBe(7);
		expect(resolveAnchorLine(c, '#^b1')).toBe(7);
	});

	it('块 id 与缓存键大小写不同也能解析', () => {
		// 缓存给 `blocks` 作键时会把 id **转小写**，而 core 匹配链接的 id 也是同样做法，所以
		// 手写的 `^Quote-Of-The-Day` 照样能指名那个块。原样读就会错过，那一步就改坐文字片段
		// 重换算那趟车了。
		const c = cache([], { 'quote-of-the-day': 7 });
		expect(resolveAnchorLine(c, 'note.md#^Quote-Of-The-Day')).toBe(7);
		expect(resolveAnchorLine(c, '#^QUOTE-OF-THE-DAY')).toBe(7);
	});

	it('标题被改名或删掉时返回 undefined', () => {
		const c = cache([['Alpha', 0]]);
		expect(resolveAnchorLine(c, 'outline:Vanished')).toBeUndefined();
		expect(resolveAnchorLine(c, 'note.md#Vanished')).toBeUndefined();
		expect(resolveAnchorLine(c, 'note.md^missing-block')).toBeUndefined();
	});

	it('非结构性的 key 返回 undefined', () => {
		expect(resolveAnchorLine(cache([]), 'caller:123')).toBeUndefined();
		expect(resolveAnchorLine(null, 'outline:Alpha')).toBeUndefined();
		expect(resolveAnchorLine(cache([]), '')).toBeUndefined();
	});

	it('有重复标题时取离记录基准行最近的那个', () => {
		// 两个 "Notes" 标题，在第 10 行与第 50 行；这次跳转落到第二个（基准 50）—— 解析必须
		// 返回 50，不是文档里第一个的 10。
		const c = cache([['Intro', 0], ['Notes', 10], ['Body', 30], ['Notes', 50], ['End', 70]]);
		expect(resolveAnchorLine(c, 'outline:Notes', 50)).toBe(50);
		expect(resolveAnchorLine(c, 'outline:Notes', 8)).toBe(10);
	});

	it('没有基准行时退到第一个重复项', () => {
		const c = cache([['Notes', 10], ['Notes', 50]]);
		expect(resolveAnchorLine(c, 'outline:Notes')).toBe(10);
	});

	it('链接锚里冒出一个孤立的 % 也能活下来（解码兜底）', () => {
		// decodeURIComponent 遇到 "%50%" 这类垃圾会抛；由原文顶上，而这次调用绝不许把异常抛进
		// execute()。
		const c = cache([['50', 3]]);
		expect(resolveAnchorLine(c, 'note.md#%50%')).toBe(3);
	});

	it('精确命中的标题优先于更近、但只是归一化后才命中的那个', () => {
		// 'Notes!'（第 10 行，离基准 12 更近）只有在归一化之后才落在 key 上；而没被改动过的
		// 'Notes'（第 0 行）先赢下那趟朴素比对。
		const c = cache([['Notes', 0], ['Notes!', 10]]);
		expect(resolveAnchorLine(c, 'outline:Notes', 12)).toBe(0);
	});

	it('按精确文本与层级解析升级后的源行 key', () => {
		// "outline:## My Heading"：# 的个数 = 层级 2，其余是那个标题**精确的源文本** —— 一个
		// 带 markdown 语法的标题（当纯文本匹配是匹配不上的）仍然能按结构解析出来。
		const c = cache([['**Bold** Title', 20, 2]]);
		expect(resolveAnchorLine(c, 'outline:## **Bold** Title')).toBe(20);
	});

	it('文本相同的标题按 key 的层级消歧', () => {
		// '## Setup' 与 '#### Setup' 文本相同；key 的层级挑出正确的那一个，与远近无关。
		const c = cache([['Setup', 10, 2], ['Setup', 50, 4]]);
		expect(resolveAnchorLine(c, 'outline:## Setup', 48)).toBe(10);
		expect(resolveAnchorLine(c, 'outline:#### Setup', 48)).toBe(50);
	});

	it('按层级过滤没命中时，不许盖住「按渲染文本兜底」这条路', () => {
		// 一个升级过的 key，若它的文本后来匹配不上了（标题被改名），就保持 undefined —— 不许
		// 跨层级乱猜。
		const c = cache([['Setup', 10, 2]]);
		expect(resolveAnchorLine(c, 'outline:## Renamed')).toBeUndefined();
	});
});
// 一个大纲 key 命名的是**什么** —— 这问题恰恰是在文件答不出来的时候被问的：一篇笔记的
// 标题里已经不再有这个了，那么这些字就是唯一还在给这个落点命名的东西（见
// recent-files/browser/body.ts 的 trailFor）。
describe('outlineHeading', () => {
	it('两种 key 形态都读得出标题', () => {
		// 落定时会升级到的那种**源**形式（层级 + 精确源文本），以及一个 key 在升级之前持有的
		// 那种渲染形式：一个标题，一个答案。
		expect(outlineHeading('outline:## Beta')).toBe('Beta');
		expect(outlineHeading('outline:Beta')).toBe('Beta');
	});

	it('标题自己写着什么就保留什么', () => {
		// 层级不是文字，它后面那个空格也不是 —— 而一个自带标记的标题，它的文字就是它自己。
		expect(outlineHeading('outline:   ###  Beta ')).toBe('Beta');
		expect(outlineHeading('outline:## 3 個步驟')).toBe('3 個步驟');
	});

	it('不带标题的 key 什么也读不出来', () => {
		// 标题链接的 slug、一个块 id、一个 caller 目标，都不是一行能当成它那一节印出来的文字 ——
		// 印了的那一行，就是在指认另一样东西了。
		expect(outlineHeading('note.md#beta')).toBeUndefined();
		expect(outlineHeading('note.md#^id')).toBeUndefined();
		expect(outlineHeading('caller:1700000000000')).toBeUndefined();
		expect(outlineHeading('outline:')).toBeUndefined();
		expect(outlineHeading(undefined)).toBeUndefined();
	});
});
