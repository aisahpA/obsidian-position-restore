// ephemeral.ts 的测试：remapAnchoredState（一条记下的位置，若它的 anchor 行文字挪了，
// 就重新映射到**现在**携带那段 anchor 文字的那一行；副本带着位移，输入原封不动）以及
// readEphemeralState 的非法 scroll 守卫（getScroll() 回读出 null/NaN/undefined —— 比如
// 预览渲染器还没追上 —— 必须给出 undefined，绝不能给出一个假的「文件顶部」状态）。

import { describe, it, expect } from 'vitest';
import { MarkdownView } from 'obsidian';

import { readEphemeralState, remapAnchoredState } from '@/position/capture/ephemeral';
import { NavEntryState } from '@/types';

function editor(lines: string[]) {
	return {
		getLine: (line: number) => lines[line],
		lastLine: () => lines.length - 1,
	};
}

const BASE_LINES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

// 最小的视图桩：readEphemeralState 只碰 currentMode.getScroll() 和（在场时的）editor。
function viewWithScroll(scroll: unknown): MarkdownView {
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	view.currentMode = { getScroll: () => scroll as number } as never;
	return view;
}

describe('readEphemeralState', () => {
	it('预览渲染器报告 scroll 为 null 时返回 undefined', () => {
		// 回归：isNaN(null) 是 false，而 Math.round(null) 是 0，所以旧的守卫把「渲染器还没追上」
		// 变成了 {scroll: 0} —— 一个滚动采集 / 轮询随后会盖到已存记录上的状态。
		expect(readEphemeralState(viewWithScroll(null))).toBeUndefined();
	});

	it('scroll 是 NaN 或 undefined 时返回 undefined', () => {
		expect(readEphemeralState(viewWithScroll(Number.NaN))).toBeUndefined();
		expect(readEphemeralState(viewWithScroll(undefined))).toBeUndefined();
	});

	it('真的就停在文件顶部（scroll 为 0）时照样记录', () => {
		expect(readEphemeralState(viewWithScroll(0))).toEqual({ scroll: 0 });
	});

	it('把真实的 scroll 量化成整行', () => {
		expect(readEphemeralState(viewWithScroll(10.4))).toEqual({ scroll: 10 });
	});
});

describe('remapAnchoredState', () => {
	it('没有 anchor 时原样返回', () => {
		const st: NavEntryState = { scroll: 3 };
		expect(remapAnchoredState(editor(BASE_LINES), st)).toBe(st);
	});

	it('那一行还写着 anchor 文本时原样返回', () => {
		const st: NavEntryState = { scroll: 2, anchor: 'charlie' };
		expect(remapAnchoredState(editor(BASE_LINES), st)).toBe(st);
	});

	it('上方插入了行时 scroll 与 cursor 一起平移', () => {
		// anchor 本来在第 2 行；上面插了两行，把它挪到了第 4 行
		const lines = ['x1', 'x2', 'alpha', 'bravo', 'charlie', 'delta', 'echo'];
		const st: NavEntryState = {
			scroll: 2,
			cursor: { from: { line: 3, ch: 1 }, to: { line: 4, ch: 2 } },
			anchor: 'charlie',
		};
		const out = remapAnchoredState(editor(lines), st);
		expect(out.scroll).toBe(4);
		expect(out.cursor).toEqual({
			from: { line: 5, ch: 1 },
			to: { line: 6, ch: 2 },
		});
		// 记录保持不可变；被应用的那份副本把 anchor 丢掉
		expect(st.scroll).toBe(2);
		expect(st.cursor?.from.line).toBe(3);
		expect(out.anchor).toBeUndefined();
	});

	it('只有光标、没有 scroll 的记录也平移', () => {
		const st: NavEntryState = {
			cursor: { from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } },
			anchor: 'echo',
		};
		const out = remapAnchoredState(editor(BASE_LINES), st);
		expect(out.scroll).toBeUndefined();
		expect(out.cursor?.from.line).toBe(4);
	});

	it('平移量为负时把 scroll 夹在 0', () => {
		// anchor 本来在第 2 行；上面的行被删掉，它挪到了第 0 行；一个在第 1 行的光标会落到文件
		// 顶部之前
		const lines = ['charlie', 'delta', 'echo'];
		const st: NavEntryState = {
			scroll: 2,
			cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } },
			anchor: 'charlie',
		};
		const out = remapAnchoredState(editor(lines), st);
		expect(out.scroll).toBe(0);
		expect(out.cursor?.from.line).toBe(1);
	});

	it('行号越界（文件变短）时往上方找 anchor', () => {
		const lines = ['alpha', 'bravo', 'echo'];
		const st: NavEntryState = { scroll: 4, anchor: 'echo' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(2);
	});

	it('anchor 文本没了就保留旧行号', () => {
		const lines = ['alpha', 'bravo', 'rewritten', 'delta', 'echo'];
		const st: NavEntryState = { scroll: 2, anchor: 'charlie' };
		expect(remapAnchoredState(editor(lines), st)).toBe(st);
	});

	it('anchor 那一行被轻微编辑过（大小写 / 空白 / 标点）仍能重映射', () => {
		// anchor 记的是 "Bravo Line"；那一行现在读作 "bravo line!" —— 归一化之后两者相符，所以
		// 这个位置仍然重映射得成。
		const lines = ['alpha', 'bravo line!', 'charlie', 'delta', 'echo'];
		const st: NavEntryState = { scroll: 2, anchor: 'Bravo  Line' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(1);
	});

	it('精确副本优先于更近、但只是归一化后才命中的候选', () => {
		// 'charlie!'（距离 1）只有在归一化之后才落在 anchor 上；而 'charlie'（距离 2）是没被
		// 改动过的副本 —— 朴素那趟先赢。
		const lines = ['charlie', 'charlie!', 'bravo', 'x', 'echo'];
		const st: NavEntryState = { scroll: 2, anchor: 'charlie' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(0);
	});

	it('位移超出扫描窗口时保留旧行号', () => {
		const lines = ['far-away-anchor', ...Array(45).fill('filler')];
		const st: NavEntryState = { scroll: 40, anchor: 'far-away-anchor' };
		expect(remapAnchoredState(editor(lines), st)).toBe(st);
	});

	it('窗口内有重复时取最近的那个', () => {
		// 记下的第 3 行放着 'b'；-1 处那个更近的重复项赢过 -3 处那个
		let lines = ['dup', 'a', 'dup', 'b', 'c'];
		let st: NavEntryState = { scroll: 3, anchor: 'dup' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(2);
		// 距离相等时：先查 line+d，再查 line-d
		lines = ['dup', 'a', 'x', 'b', 'c', 'dup'];
		st = { scroll: 3, anchor: 'dup' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(5);
	});
});
