// Tests for shared/headings.ts: the section chain a line sits under, read out
// of a note's own text. Shared by two callers that must agree — the
// post-restore breadcrumb and the recent-files row's strip — so what is pinned
// here is the scan they both lean on, not either one's use of it.

import { describe, it, expect } from 'vitest';
import { outlinePathAtLine } from '@/shared/headings';

const trail = (lines: string[], line: number) => outlinePathAtLine(lines, line);

describe('outlinePathAtLine', () => {
	it('按标题层级嵌套，最外层在前', () => {
		const lines = ['# A', 'text', '## B', 'text', '### C', 'here'];
		expect(trail(lines, 5)).toEqual(['A', 'B', 'C']);
		// a shallower heading closes the deeper ones
		expect(trail(lines, 1)).toEqual(['A']);
	});

	it('正落在这一行上的标题算作最深的一段', () => {
		const lines = ['# A', '## B'];
		expect(trail(lines, 1)).toEqual(['A', 'B']);
	});

	it('第一个标题之上是空的', () => {
		expect(trail(['text', '# A'], 0)).toEqual([]);
	});

	it('代码块与注释里像标题的行一律忽略', () => {
		const lines = ['# Real', '```', '# not a heading', '```', '<!--', '# nor this', '-->', '%%', '# nor this', '%%', 'body'];
		expect(trail(lines, 11)).toEqual(['Real']);
	});

	// CommonMark: a fence closes on a run of its own kind AT LEAST AS LONG AS
	// its opener, so a shorter run is an ordinary line of the block. Both mark
	// characters obey it — a `~` block that closed on any run ended early, and
	// a `#` line inside it became a section the note does not have.
	it('围栏只有遇到不短于开始记号的一串才关', () => {
		expect(trail(['# Real', '~~~~~~', '# in', '~~~', '# still in', '~~~~~~', 'body'], 6)).toEqual(['Real']);
		expect(trail(['# Real', '``````', '# in', '```', '# still in', '``````', 'body'], 6)).toEqual(['Real']);
	});

	it('标题文本里行尾的闭合井号与行内注释会被剥掉', () => {
		expect(trail(['## Title ##'], 0)).toEqual(['Title']);
		expect(trail(['## Title %%note%%'], 0)).toEqual(['Title']);
	});

	// Three spaces of indent are still an ATX heading; four are a fence's
	// opening, which is why the scan stops at three.
	it('缩进的标题也认', () => {
		expect(trail(['# A', '   ## B'], 1)).toEqual(['A', 'B']);
	});

	// `title: # 1` is a value, not a section the note has.
	it('跳过 frontmatter', () => {
		expect(trail(['---', 'title: # 1', '---', '# Real'], 3)).toEqual(['Real']);
	});
});
