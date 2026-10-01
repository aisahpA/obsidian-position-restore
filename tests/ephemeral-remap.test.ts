// Tests for ephemeral.ts: remapAnchoredState (a recorded position whose
// anchor line text moved re-maps to the line that now carries the anchor
// text; the copy carries the shift, the input stays untouched) and
// readEphemeralState's invalid-scroll guard (a null/NaN/undefined getScroll()
// readback — e.g. the preview renderer not caught up yet — must yield
// undefined, never a bogus "top of file" state).

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

// Minimal view stub: readEphemeralState only touches currentMode.getScroll()
// and (when present) the editor.
function viewWithScroll(scroll: unknown): MarkdownView {
	const view = new MarkdownView(undefined as never) as MarkdownView & Record<string, unknown>;
	view.currentMode = { getScroll: () => scroll as number } as never;
	return view;
}

describe('readEphemeralState', () => {
	it('预览渲染器报告 scroll 为 null 时返回 undefined', () => {
		// Regression: isNaN(null) is false and Math.round(null) is 0, so the
		// old guard turned "renderer not caught up yet" into {scroll: 0} —
		// a state the scroll capture / poll would then write over the
		// saved record.
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
		// anchor was line 2; two lines inserted above moved it to line 4
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
		// entry stays immutable; the applied copy drops the anchor
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
		// anchor was line 2; lines above deleted, it moved to line 0; a
		// cursor at line 1 would land before the file top
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
		// anchor recorded as "Bravo Line"; the line now reads "bravo line!" —
		// normalized forms match, so the position still re-maps.
		const lines = ['alpha', 'bravo line!', 'charlie', 'delta', 'echo'];
		const st: NavEntryState = { scroll: 2, anchor: 'Bravo  Line' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(1);
	});

	it('精确副本优先于更近、但只是归一化后才命中的候选', () => {
		// 'charlie!' (distance 1) only normalizes to the anchor; 'charlie'
		// (distance 2) is an unedited copy — the plain pass wins first.
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
		// recorded line 3 holds 'b'; closer duplicate at -1 wins over -3
		let lines = ['dup', 'a', 'dup', 'b', 'c'];
		let st: NavEntryState = { scroll: 3, anchor: 'dup' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(2);
		// equal distance: line+d is checked before line-d
		lines = ['dup', 'a', 'x', 'b', 'c', 'dup'];
		st = { scroll: 3, anchor: 'dup' };
		expect(remapAnchoredState(editor(lines), st).scroll).toBe(5);
	});
});
