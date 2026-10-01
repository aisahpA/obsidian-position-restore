// Tests for restore/anchor.ts: resolveAnchorLine resolves a keyed NavJump's
// structural anchor (outline heading, #heading link, ^block ref) to its
// CURRENT line in the file, surviving arbitrary insert/delete shifts — vs.
// the ±30-line text-snippet remap it replaces for keyed jumps.
//
// The section chain a line sits in is no longer answered here — it moved to
// shared/headings.ts's outlinePathAtLine, and its cases went with it.

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
		// 40 lines were inserted above; the heading is now at line 42.
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
		// [[note#^id]] hands over `note.md#^id`, and the `#` used to send it down the
		// heading-slug branch, where no heading is named after a block id — so every block
		// link missed its block and fell back to the text-snippet remap.
		const c = cache([], { b1: 7 });
		expect(resolveAnchorLine(c, 'note.md#^b1')).toBe(7);
		expect(resolveAnchorLine(c, '#^b1')).toBe(7);
	});

	it('块 id 与缓存键大小写不同也能解析', () => {
		// The cache keys `blocks` by the id LOWERCASED, and core matches a link's id the
		// same way, so a hand-written `^Quote-Of-The-Day` still names the block. Read
		// verbatim it missed, and the step rode the text-snippet remap instead.
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
		// Two "Notes" headings at 10 and 50; the jump landed on the second
		// one (base 50) — resolve must return 50, not the document-first 10.
		const c = cache([['Intro', 0], ['Notes', 10], ['Body', 30], ['Notes', 50], ['End', 70]]);
		expect(resolveAnchorLine(c, 'outline:Notes', 50)).toBe(50);
		expect(resolveAnchorLine(c, 'outline:Notes', 8)).toBe(10);
	});

	it('没有基准行时退到第一个重复项', () => {
		const c = cache([['Notes', 10], ['Notes', 50]]);
		expect(resolveAnchorLine(c, 'outline:Notes')).toBe(10);
	});

	it('链接锚里冒出一个孤立的 % 也能活下来（解码兜底）', () => {
		// decodeURIComponent would throw on "%50%"-style junk; the raw text
		// stands in and the call must not throw into execute().
		const c = cache([['50', 3]]);
		expect(resolveAnchorLine(c, 'note.md#%50%')).toBe(3);
	});

	it('精确命中的标题优先于更近、但只是归一化后才命中的那个', () => {
		// 'Notes!' (line 10, nearest base 12) only normalizes to the key;
		// the unedited 'Notes' (line 0) wins the plain pass first.
		const c = cache([['Notes', 0], ['Notes!', 10]]);
		expect(resolveAnchorLine(c, 'outline:Notes', 12)).toBe(0);
	});

	it('按精确文本与层级解析升级后的源行 key', () => {
		// "outline:## My Heading": # count = level 2, rest is the heading's
		// exact source text — a markdown-syntax heading (unrenderable as a
		// plain-text match) still resolves structurally.
		const c = cache([['**Bold** Title', 20, 2]]);
		expect(resolveAnchorLine(c, 'outline:## **Bold** Title')).toBe(20);
	});

	it('文本相同的标题按 key 的层级消歧', () => {
		// '## Setup' and '#### Setup' share the text; the key's level picks
		// the right instance regardless of proximity.
		const c = cache([['Setup', 10, 2], ['Setup', 50, 4]]);
		expect(resolveAnchorLine(c, 'outline:## Setup', 48)).toBe(10);
		expect(resolveAnchorLine(c, 'outline:#### Setup', 48)).toBe(50);
	});

	it('按层级过滤没命中时，不许盖住「按渲染文本兜底」这条路', () => {
		// An upgraded key whose text later fails to match (renamed heading)
		// stays undefined — no cross-level guessing.
		const c = cache([['Setup', 10, 2]]);
		expect(resolveAnchorLine(c, 'outline:## Renamed')).toBeUndefined();
	});
});
// WHAT AN OUTLINE KEY NAMES, which is asked exactly where the file cannot answer: a note
// whose headings no longer include this one leaves these words as the only thing still
// naming the landing (see recent-files/browser/body.ts's trailFor).
describe('outlineHeading', () => {
	it('两种 key 形态都读得出标题', () => {
		// The SOURCE form a settle upgrades to (level and exact source), and the rendered
		// form a key has until then: one heading, one answer.
		expect(outlineHeading('outline:## Beta')).toBe('Beta');
		expect(outlineHeading('outline:Beta')).toBe('Beta');
	});

	it('标题自己写着什么就保留什么', () => {
		// A level is not words, and neither is the space after it — while a heading carrying
		// its own marks is its own text.
		expect(outlineHeading('outline:   ###  Beta ')).toBe('Beta');
		expect(outlineHeading('outline:## 3 個步驟')).toBe('3 個步驟');
	});

	it('不带标题的 key 什么也读不出来', () => {
		// A heading link's slug, a block id and a caller target are not words a row could
		// print as its section — a row that did would be naming something else again.
		expect(outlineHeading('note.md#beta')).toBeUndefined();
		expect(outlineHeading('note.md#^id')).toBeUndefined();
		expect(outlineHeading('caller:1700000000000')).toBeUndefined();
		expect(outlineHeading('outline:')).toBeUndefined();
		expect(outlineHeading(undefined)).toBeUndefined();
	});
});
