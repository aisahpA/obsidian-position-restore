// 一行上的行号**今天**意味着什么（见 src/recent-files/browser/now-line.ts）。
//
// 行号是一个**地址**，而笔记是会被编辑的：在某处上面写下一段，就把它下面每一行都挪了
// 位置，而从前给那一处命名的地址，改去命名别的东西了。列表继续印它记下的那个数字 ——
// 那一行讲的就是这件事 —— 但任何**打开**这篇笔记的东西，都必须拿到笔记**现在**认的那个
// 数字，要么就一个都不给。
//
// 本模块知道的三种办法、以及它承认自己不知道的那一种，全都在这儿对着手工搭出的事实
// 回答：没有工作区、没有文件、没有 vault。

import { describe, it, expect } from 'vitest';
import type { CachedMetadata } from 'obsidian';
import { nowLineFor, type NowLineFacts } from '@/recent-files/browser/now-line';
import { linesSource } from '@/position/capture/ephemeral';
import type { NavEntry } from '@/nav/entry';
import type { NavEntryDescription } from '@/recent-files/browser/model';
import type { NavEntryState } from '@/types';

// 一个文件解析出来的标题，按元数据缓存交过来的形状。
const cache = (...at: [string, number][]): CachedMetadata =>
	({
		headings: at.map(([heading, line]) => ({
			heading, level: 2, position: { start: { line } },
		})),
	}) as CachedMetadata;

// 测试可以手工作答的那些事实。它们默认全都是「无从下手」，所以下面每个用例都确切地说出
// 它是关于**什么**的用例。
const facts = (over: Partial<NowLineFacts> = {}): NowLineFacts => ({
	mtimeOf: () => undefined,
	cacheFor: () => null,
	linesOf: () => undefined,
	...over,
});

// 一个带落点的 jump，按 store 保存它的样子：它落到的那一行，以及它落地时立在那行上的
// 文字。
const jump = (st: NavEntryState, key?: string, keyLine?: number): NavEntry => ({
	kind: 'jump', path: 'a.md', leafId: 'leaf-1', t: 0, st,
	key: key ?? 'outline:## Beta',
	keyLine,
});

const at = (line: number): NavEntryDescription => ({ name: 'a', line: `L${line + 1}`, lineIndex: line });

describe('nowLineFor', () => {
	it('文件此后没被写过就沿用记下的行号', () => {
		// 记录自己的时钟和文件的时钟说的是同一件事：那些字被取走之后没再写过东西，所以这个数字
		// 仍然是那个地址。
		const entry = jump({ scroll: 40, anchor: '正文', mtime: 7 });
		expect(nowLineFor(entry, at(40), facts({ mtimeOf: () => 7 }))).toBe(40);
		// ……而且不去读文件的任何一行来证明它：时钟已经答了。
		const linesOf = () => linesSource(['nothing', 'like', 'it']);
		expect(nowLineFor(entry, at(40), facts({ mtimeOf: () => 7, linesOf }))).toBe(40);
	});

	it('带 key 的跳转靠自己的 anchor 重新定位，隔多远都行', () => {
		// 这次跳转所指向的标题往下挪了五十行 —— 远过任何文字扫描会去够的距离 —— 而它自己的
		// 那一行仍然是权威。
		const entry = jump({ scroll: 40, anchor: '正文' }, 'outline:## Beta', 30);
		const got = nowLineFor(entry, at(40), facts({
			mtimeOf: () => 9,
			cacheFor: () => cache(['Beta', 80]),
		}));
		expect(got).toBe(90);
	});

	it('在笔记此刻的文本里重新找到 anchor 那一行', () => {
		const lines = Array.from({ length: 60 }, (_, i) => `第 ${i} 行`);
		lines[43] = 'the line that was there';
		const entry = jump({ scroll: 40, anchor: 'the line that was there' });
		expect(nowLineFor(entry, at(40), facts({
			mtimeOf: () => 9,
			linesOf: () => linesSource(lines),
		}))).toBe(43);
	});

	it('anchor 文本没了就沉默以对', () => {
		// 这篇笔记被重写了：里面没有任何东西是记录所指名的那一行。一个本模块没有的数字，不是
		// 它会去猜的数字。
		const entry = jump({ scroll: 40, anchor: 'the line that was there' });
		expect(nowLineFor(entry, at(40), facts({
			mtimeOf: () => 9,
			linesOf: () => linesSource(Array.from({ length: 60 }, (_, i) => `第 ${i} 行`)),
		}))).toBeUndefined();
	});

	it('文件被改过、又没有 anchor 可依时，什么都不说', () => {
		// 一条旧记录、一个时钟说此后被动过的文件：这里没有任何东西能把它重新找回来，而一个
		// 已知挪过位置的数字，不值得交给任何会打开这篇笔记的东西。
		const entry = jump({ scroll: 40, mtime: 3 });
		expect(nowLineFor(entry, at(40), facts({ mtimeOf: () => 9 }))).toBeUndefined();
	});

	it('没有任何东西能重新定位时，就保留手上那个数字', () => {
		// 没有 anchor，也没有哪个时钟说有什么变了：记下的那个数字是所有人对这一处所知道的最好
		// 的东西，也正是那一行印出来的。
		const entry = jump({ scroll: 40 });
		expect(nowLineFor(entry, at(40), facts())).toBe(40);
	});

	it('为一次悬停可以去读文件，为一次重画绝不可以', () => {
		// `prime` 就是「一次悬停等一次 await」与「五十行读五十个文件」之间的差别
		// （见 RecentFilesReads.linesFor）。
		const seen: boolean[] = [];
		const entry = jump({ scroll: 40, anchor: 'the line that was there' });
		const lines = Array.from({ length: 60 }, (_, i) => `第 ${i} 行`);
		lines[41] = 'the line that was there';
		const linesOf = (_path: string, prime: boolean) => {
			seen.push(prime);
			return prime ? linesSource(lines) : undefined;
		};
		nowLineFor(entry, at(40), facts({ mtimeOf: () => 9, linesOf }));
		nowLineFor(entry, at(40), facts({ mtimeOf: () => 9, linesOf }), false);
		expect(seen).toEqual([true, false]);
	});

	it('视图根本没有行号可言', () => {
		const entry: NavEntry = { kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 0 };
		expect(nowLineFor(entry, { name: 'graph' }, facts())).toBeUndefined();
	});
});
