// shared/headings.ts 的测试：一行所处的那条分节链，从笔记自己的文本里读出来。它由两个
// 必须一致的调用方共用 —— 恢复后的面包屑与最近文件那一行的小节条 —— 所以这里钉住的是
// 两者共同依靠的那趟扫描，而不是任何一方对它的用法。

import { describe, it, expect } from 'vitest';
import { outlinePathAtLine } from '@/shared/headings';

const trail = (lines: string[], line: number) => outlinePathAtLine(lines, line);

describe('outlinePathAtLine', () => {
	it('按标题层级嵌套，最外层在前', () => {
		const lines = ['# A', 'text', '## B', 'text', '### C', 'here'];
		expect(trail(lines, 5)).toEqual(['A', 'B', 'C']);
		// 更浅的标题会把更深的那些关掉
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

	// CommonMark：围栏只在遇到**不短于**开始记号的一串同类记号时关闭，所以更短的一串只是
	// 块里普通的一行。两种记号字符都遵守这条 —— 一个遇到任何一串就关闭的 `~` 块会提前结束，
	// 而它里面的一行 `#` 就变成了这篇笔记并没有的一个小节。
	it('围栏只有遇到不短于开始记号的一串才关', () => {
		expect(trail(['# Real', '~~~~~~', '# in', '~~~', '# still in', '~~~~~~', 'body'], 6)).toEqual(['Real']);
		expect(trail(['# Real', '``````', '# in', '```', '# still in', '``````', 'body'], 6)).toEqual(['Real']);
	});

	it('标题文本里行尾的闭合井号与行内注释会被剥掉', () => {
		expect(trail(['## Title ##'], 0)).toEqual(['Title']);
		expect(trail(['## Title %%note%%'], 0)).toEqual(['Title']);
	});

	// 三个空格缩进仍然是一个 ATX 标题；四个就是围栏的开始，所以这趟扫描停在三个。
	it('缩进的标题也认', () => {
		expect(trail(['# A', '   ## B'], 1)).toEqual(['A', 'B']);
	});

	// `title: # 1` 是一个值，不是这篇笔记拥有的某个小节。
	it('跳过 frontmatter', () => {
		expect(trail(['---', 'title: # 1', '---', '# Real'], 3)).toEqual(['Real']);
	});
});
