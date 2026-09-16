// Tests for the drawer's markdown layer (src/nav-history/browser/markdown.ts):
// the recorded block turned into a document Obsidian's renderer can draw, and
// the recorded line found again in a note that WAS drawn — where nothing carries
// the source line numbers any more.

import { describe, it, expect, vi } from 'vitest';

import {
	contextMarkdown, contextRange, fileSource, isBinary, landingMarkedInSource, looksBinary,
	plainText, revealFraction, revealLanding,
} from '@/nav-history/browser/markdown';
import type { NavHistoryEntry } from '@/nav-history/entry';
import type { NavEntryState } from '@/types';

// jsdom implements no layout at all, so this is missing rather than broken.
Element.prototype.scrollIntoView = () => {};

const block = (contextAt: number): NavEntryState => ({
	scroll: 11,
	context: [
		{ line: 10, text: '上一段：从哪里来' },
		{ line: 11, text: '落点这一行' },
		{ line: 12, text: '下一段：到哪里去' },
	],
	contextAt,
});

const visit = (st?: NavEntryState, path = 'a.md'): NavHistoryEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: 1, st });

describe('contextMarkdown', () => {
	it('joins the recorded lines as one document, with the landing marked', () => {
		// The mark is Obsidian's own ==…==, so it survives rendering: the block
		// arrives as markdown and there is no bookkeeping of ours to carry into
		// the DOM.
		expect(contextMarkdown(visit(block(1))))
			.toBe('上一段：从哪里来\n==落点这一行==\n下一段：到哪里去');
	});

	it('trims the lines: indentation would render a paragraph as a code block', () => {
		const indented = { ...block(1), context: block(1).context!.map(l => ({ ...l, text: `    ${l.text}` })) };
		expect(contextMarkdown(visit(indented))).toBe('上一段：从哪里来\n==落点这一行==\n下一段：到哪里去');
	});

	it('leaves a line that cannot carry a mark unmarked', () => {
		// A fence or a break IS its own first characters: wrapping them in ==…==
		// would stop the fence being a fence and turn the break into text. They go
		// unmarked — the caption above the block still says which range the reader
		// is looking at.
		const at = (text: string): NavEntryState => ({
			context: [{ line: 0, text: 'before' }, { line: 1, text }, { line: 2, text: 'after' }],
			contextAt: 1,
		});
		for (const text of ['---', '***', '___']) {
			expect(contextMarkdown(visit(at(text)))).toBe(`before\n${text}\nafter`);
		}
		// …and a fence that the window CUT OPEN is closed by the repair, so the
		// rest of the snippet is not swallowed by it
		expect(contextMarkdown(visit(at('```ts')))).toBe('before\n```ts\nafter\n```');
	});

	it('leaves a line that BEGINS a block unmarked, and marks the rendered block instead', () => {
		// `==## 标题==` is not a marked heading, it is a paragraph that begins with
		// two equals signs — the reader is shown the note's source, which is the one
		// thing rendering the block exists to avoid. So the mark goes on the
		// RENDERED block (see landingMarkedInSource, and PreviewContent, which is
		// what knows the landing was not marked here).
		const at = (text: string): NavEntryState => ({
			context: [{ line: 0, text: 'before' }, { line: 1, text }, { line: 2, text: 'after' }],
			contextAt: 1,
		});
		for (const text of ['# 标题', '## 标题', '###### 标题', '- 事项', '* 事项', '+ 事项',
			'1. 事项', '3) 事项', '2024. 年份', '> 引用的话', '- [ ] 待办']) {
			expect(contextMarkdown(visit(at(text)))).toBe(`before\n${text}\nafter`);
			expect(landingMarkedInSource(text)).toBe(false);
		}
		// Everything else is still marked in place: a plain line, and an emphasis
		// that only LOOKS like a list marker. A table row is marked too, inside its
		// first cell.
		for (const text of ['普通一行', '**加粗**'])
			expect(landingMarkedInSource(text)).toBe(true);
		expect(landingMarkedInSource('| a | b |')).toBe(true);
		expect(contextMarkdown(visit(at('| a | b |')))).toBe('before\n| ==a== | b |\nafter');
	});

	it('has nothing to say without a recorded block, or for a view step', () => {
		expect(contextMarkdown(visit({ scroll: 4 }))).toBeUndefined();
		expect(contextMarkdown({ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 1 } as NavHistoryEntry))
			.toBeUndefined();
	});

	it('names the lines the block covers, 1-based', () => {
		expect(contextRange(visit(block(1)))).toEqual({ from: 11, to: 13 });
		expect(contextRange(visit({ scroll: 4 }))).toBeUndefined();
	});
});

describe('plainText', () => {
	it('reduces markdown to the words a rendered note shows', () => {
		expect(plainText('## 呈现方案')).toBe('呈现方案');
		expect(plainText('- 一条要点')).toBe('一条要点');
		expect(plainText('> 引用里的话')).toBe('引用里的话');
		expect(plainText('见 [[别的笔记|这里]]')).toBe('见 这里');
		expect(plainText('见 [[别的笔记]]')).toBe('见 别的笔记');
		expect(plainText('见 [这些字](别的笔记.md)')).toBe('见 这些字');
		expect(plainText('**加粗** 与 *斜体* 与 `代码`')).toBe('加粗 与 斜体 与 代码');
	});

	it('collapses whitespace, so a wrapped line still matches', () => {
		expect(plainText('一  行\n  话')).toBe('一 行 话');
	});
});

describe('revealLanding', () => {
	const rendered = (html: string): HTMLElement => {
		const root = document.createElement('div');
		root.className = 'markdown-preview-view markdown-rendered';
		root.innerHTML = html;
		return root;
	};

	it('marks the block that carries the recorded line', () => {
		const root = rendered('<p>一段话</p><p>落点这一行</p><p>另一段</p>');

		expect(revealLanding(root, '落点这一行')).toBe(true);
		expect(Array.from(root.querySelectorAll('.nav-preview-landing')).map(el => el.textContent))
			.toEqual(['落点这一行']);
	});

	it('marks the DEEPEST match: a wrapper holds the whole section, not the spot', () => {
		// A list, a callout or a blockquote also "contains" the words of the line
		// inside it — marking the wrapper would paint half the note as the spot.
		const root = rendered('<ul><li>第一项</li><li>落点这一行</li></ul>');

		revealLanding(root, '落点这一行');

		const marked = root.querySelector('.nav-preview-landing')!;
		expect(marked.tagName).toBe('LI');
		expect(root.querySelector('ul')?.classList.contains('nav-preview-landing')).toBe(false);
	});

	it('finds the line through its markdown, not through its source', () => {
		// The anchor is recorded as the file had it — "### 呈现方案" — and the
		// rendered note shows the words.
		const root = rendered('<h3>呈现方案</h3><p>正文</p>');

		expect(revealLanding(root, '### 呈现方案')).toBe(true);
		expect(root.querySelector('.nav-preview-landing')?.tagName).toBe('H3');
	});

	it('moves ONE mark: the reader walking a note\'s landings leaves the last one behind', () => {
		const root = rendered('<p>第一处的文字</p><p>第二处的文字</p>');
		revealLanding(root, '第一处的文字');
		revealLanding(root, '第二处的文字');

		expect(Array.from(root.querySelectorAll('.nav-preview-landing')).map(el => el.textContent))
			.toEqual(['第二处的文字']);
	});

	it('scrolls the landing into view', () => {
		const root = rendered('<p>一段话</p><p>落点这一行</p>');
		const spy = vi.spyOn(Element.prototype, 'scrollIntoView');

		revealLanding(root, '落点这一行');

		expect(spy).toHaveBeenCalledWith({ block: 'center' });
		spy.mockRestore();
	});

	it('marks nothing when the words are gone, or too short to be a location', () => {
		// The note was rewritten since the step was recorded: today's file is
		// still a preview of today's file, and the head already says it is not the
		// recorded text.
		expect(revealLanding(rendered('<p>一段话</p>'), '落点这一行')).toBe(false);
		expect(revealLanding(rendered('<p>一段话</p>'), '话')).toBe(false);
		expect(revealLanding(rendered('<p>一段话</p>'), undefined)).toBe(false);
		expect(rendered('<p>一段话</p>').querySelector('.nav-preview-landing')).toBeNull();
	});
});

// The fallback for a landing whose words are not in the note any more: where the
// recorded line SAT, as a fraction of the file. jsdom lays nothing out, so the
// scroller is faked here — which is also the honest shape of the contract: a box
// that scrolls is a box whose content is taller than it.
describe('revealFraction', () => {
	const scroller = (root: HTMLElement, scrollable = true): HTMLElement => {
		const box = document.createElement('div');
		Object.defineProperty(box, 'scrollHeight', { value: scrollable ? 1000 : 100 });
		Object.defineProperty(box, 'clientHeight', { value: 100 });
		box.appendChild(root);
		document.body.appendChild(box);
		return box;
	};

	it('puts the reader at the recorded line\'s share of the note', () => {
		const root = document.createElement('div');
		const box = scroller(root);

		expect(revealFraction(root, 0.5)).toBe(true);
		expect(box.scrollTop).toBe(450); // (1000 - 100) × 0.5
		expect(revealFraction(root, 0)).toBe(true);
		expect(box.scrollTop).toBe(0);
		expect(revealFraction(root, 1)).toBe(true);
		expect(box.scrollTop).toBe(900);
	});

	it('clamps a line the note has since outgrown, and ignores nonsense', () => {
		const root = document.createElement('div');
		const box = scroller(root);

		// The file was edited down since the step was recorded: the recorded line
		// is past its end, and the honest place to land is the end of it.
		expect(revealFraction(root, 4)).toBe(true);
		expect(box.scrollTop).toBe(900);
		expect(revealFraction(root, undefined)).toBe(false);
		expect(revealFraction(root, Number.NaN)).toBe(false);
	});

	it('does nothing when nothing scrolls, or nothing knows where the landing is', () => {
		const short = document.createElement('div');
		scroller(short, false); // content fits: there is nowhere to go
		expect(revealFraction(short, 0.5)).toBe(false);

		const loose = document.createElement('div');
		document.body.appendChild(loose);
		expect(revealFraction(loose, 0.5)).toBe(false);
	});
});

// The capture takes a WINDOW of the lines around the landing, so what arrives is
// routinely the middle of something: frontmatter, a table whose header is five
// lines up, a code fence whose opening line is outside the window. Rendering that
// as-is is worse than raw text — a heading rule through the properties, a
// paragraph of pipes, half the block swallowed by an unclosed fence — so the
// snippet is repaired first. Every repair must be one a reader would have made
// themselves, and none of them may invent content: only delimiters are added.
describe('a snippet the window cut in half', () => {
	// `from` is the first recorded line's number in the file, which is what tells
	// a block that opens the file (and so carries its frontmatter) from one that
	// starts in the middle of it.
	const at = (lines: string[], landing = 1, from = 0): NavHistoryEntry =>
		visit({ context: lines.map((text, i) => ({ line: from + i, text })), contextAt: landing });

	describe('frontmatter', () => {
		it('drops the properties a block that opens the file carries', () => {
			const entry = at(['---', 'tags:', '  - a', '---', '# 标题', '正文'], 5);

			// The `---` that opened the properties would otherwise be a heading rule
			// and the tags a paragraph of YAML.
			expect(contextMarkdown(entry)).toBe('# 标题\n==正文==');
		});

		it('drops the properties wherever the cache says they end', () => {
			// The block starts INSIDE the frontmatter: nothing in "aliases: x" says
			// it is metadata, so the recorded lines cannot tell — the cache's own
			// range is what does (see NavHistoryReads.frontmatterEnd).
			const entry = at(['aliases: x', 'tags: a', '---', '# 标题', '正文'], 4, 6);

			expect(contextMarkdown(entry, 8)).toBe('# 标题\n==正文==');
			// …and without it, nothing is hidden on a guess
			expect(contextMarkdown(entry)).toBe('aliases: x\ntags: a\n---\n# 标题\n==正文==');
		});

		it('shows the properties as YAML when the landing is inside them', () => {
			// There is no prose to draw and no mark a YAML block would honour. The
			// properties are shown as what they are, which is the only honest thing
			// left: legible, and clearly metadata rather than a spot in the text.
			const entry = at(['---', 'tags: a', '---'], 1);

			expect(contextMarkdown(entry)).toBe('```yaml\n---\ntags: a\n---\n```');
		});
	});

	describe('a construct with its edges outside the window', () => {
		it('completes a table run with the separator markdown requires', () => {
			// Without one, a run of pipe rows draws as a paragraph of pipes. The
			// first captured row stands in as the header, and the landing is marked
			// INSIDE its cell — wrapping the whole row would stop it being a row.
			const entry = at(['| 名称 | 值 |', '| 卡片盒 | 笔记 |', '尾巴'], 1);

			expect(contextMarkdown(entry)).toBe('| 名称 | 值 |\n| --- | --- |\n| ==卡片盒== | 笔记 |\n尾巴');
		});

		it('leaves a table that already has its separator alone', () => {
			const entry = at(['| 名称 | 值 |', '| --- | --- |', '| 卡片盒 | 笔记 |'], 2);

			expect(contextMarkdown(entry))
				.toBe('| 名称 | 值 |\n| --- | --- |\n| ==卡片盒== | 笔记 |');
		});

		it('does not turn one pipe-bearing sentence into a table', () => {
			// A single row is as likely to be prose that happens to hold pipes, and
			// a separator under it would invent a table.
			const entry = at(['要么 A | 要么 B', '正文'], 1);

			expect(contextMarkdown(entry)).toBe('要么 A | 要么 B\n==正文==');
		});

		it('closes a code block the window opened and did not close', () => {
			// Left open, everything after the fence would render as code.
			const entry = at(['```ts', 'const a = 1;', '尾巴'], 1);

			expect(contextMarkdown(entry)).toBe('```ts\nconst a = 1;\n尾巴\n```');
		});

		it('renders a stray closer as the code block it belongs to', () => {
			// Its opening line is outside the window, so the closer is the only
			// fence in the snippet — which is an opener to markdown, and completing
			// it puts the code back inside a code block.
			const entry = at(['const a = 1;', '```', '尾巴'], 1);

			expect(contextMarkdown(entry)).toBe('const a = 1;\n```\n尾巴\n```');
		});

		it('closes an open maths block or comment', () => {
			// An unclosed `$$` swallows the rest into an equation; an unclosed `%%`
			// hides it outright.
			expect(contextMarkdown(at(['$$', 'a = b', '尾巴'], 1))).toBe('$$\na = b\n尾巴\n$$');
			expect(contextMarkdown(at(['%%', '悄悄话', '尾巴'], 1))).toBe('%%\n悄悄话\n尾巴\n%%');
		});

		it('marks nothing inside a verbatim construct', () => {
			// `==…==` there would be printed as code, hidden, or read as algebra.
			// The caption above the block still names the line.
			expect(contextMarkdown(at(['```', 'LANDING', '```'], 1))).toBe('```\nLANDING\n```');
			expect(contextMarkdown(at(['$$', 'LANDING'], 1))).toBe('$$\nLANDING\n$$');
		});

		it('reads a fence, a maths block and a comment as verbatim, pipes and all', () => {
			const entry = at(['```', '| a | b |', '| c | d |', '$$', '%%', '```'], 1);

			expect(contextMarkdown(entry)).toBe('```\n| a | b |\n| c | d |\n$$\n%%\n```');
		});
	});

	describe('a file that is not a note', () => {
		// Such a file never goes through contextMarkdown at all (see
		// PreviewContent.showFile): the capture records markdown lines, so there is
		// no recorded snippet to repair — the file's own source is what is drawn.
		it('draws a .base file as its own YAML, never as prose', () => {
			// A Bases file rendered as markdown is a paragraph of punctuation with
			// structure invented around it.
			expect(fileSource('数据库/读书.base', 'filters:\n  - file')).toBe('```yaml\nfilters:\n  - file\n```');
		});

		it('shows a canvas as JSON, and anything else by its own extension', () => {
			expect(fileSource('画布.canvas', '{"nodes": []}')).toBe('```json\n{"nodes": []}\n```');
			expect(fileSource('片段.css', 'a { color: red }')).toBe('```css\na { color: red }\n```');
			expect(fileSource('说明.txt', 'plain')).toBe('```\nplain\n```');
		});

		it('draws a note as itself, frontmatter and all', () => {
			expect(fileSource('a.md', '# 标题')).toBe('# 标题');
			expect(fileSource('a.md', '---\ntags: a\n---\n# 标题')).toBe('---\ntags: a\n---\n# 标题');
		});

		it('makes the fence longer than anything inside it, so nothing breaks out', () => {
			// A file whose own text contains a fence would otherwise end the block
			// early and spill its tail into the preview as prose.
			expect(fileSource('片段.txt', '```\ncode\n```')).toBe('````\n```\ncode\n```\n````');
		});

		it('knows what has no text to show at all', () => {
			for (const path of ['a.pdf', '图/image.PNG', '包.zip', '字.woff2'])
				expect(isBinary(path)).toBe(true);
			for (const path of ['a.md', '读书.base', '画布.canvas', '片段.css'])
				expect(isBinary(path)).toBe(false);
			// …and for an extension nobody listed, what was actually read decides
			expect(looksBinary('%PDF-1.4\n\u0000\u0001')).toBe(true);
			expect(looksBinary('filters:\n  - file')).toBe(false);
		});
	});
});
