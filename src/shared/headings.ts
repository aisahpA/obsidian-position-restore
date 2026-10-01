// 读一篇笔记的标题只有一种写法，算某一行落在哪条标题链上也只有一种 —— 两个调用方必须给出
// 同一个说法，否则同一个地点会有两个名字：恢复后的面包屑（position/ui/cue.ts）与最近文件
// 那一行的层次条（recent-files/browser/body.ts）。
//
// 标题从哪来不是本文件的事，而且两个调用方故意不同：行读 metadata cache（app 自己的解析，
// 天然排除代码块与注释里的 `##`），cue 读活的编辑器缓冲区（可能比缓存新）。共享的只是
// 「从文本兜底」这一层 —— 给缓存答不上来的笔记，或读者此刻正在编辑的笔记 —— 以及建在其上的链。
export interface HeadingRef {
	heading: string;
	level: number;
	line: number;
}

// 从笔记自己的文本里读标题，按文档顺序 —— 这是给 metadata cache 答不上来的笔记留的兜底：
// 刚被同步替换掉的、app 还没重新解析的（手机上读者从不编辑的文件可能一直不解析），而打开
// 这个文件也不会促成那件事（编辑器读的是文本，缓存不是）。没有这一层，一行就只会印出一个
// 孤立的行号 `L412`，直到那阵状态过去。
//
// 刻意只认 ATX 标题（`#` … `######`），且井号后面必须跟空格、tab 或行尾：`#tag` 开头的一行是
// 标签，代码块里的 `#` 是别人脚本里的注释。跳过 frontmatter 是同一个道理 —— `title: # 1`
// 只是一个值。
export function headingsFromLines(lines: readonly string[]): HeadingRef[] {
	const out: HeadingRef[] = [];
	// 当前还开着的那串围栏（如果有）：按 CommonMark，围栏块的结束记号必须至少和开始的一样长，
	// 所以六个反引号的块里出现三个反引号，只是块里普通的一行。注释块则在行内任意位置遇到
	// 下一个结束标记就关。
	let fence: string | undefined;
	let inHtml = false;
	let inObsidian = false;
	// frontmatter 块是否还开着。它只可能是文件的第一行，别的行都不算。
	let frontmatter = lines[0]?.trim() === '---';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (frontmatter) {
			if (i > 0 && line.trim() === '---')
				frontmatter = false;
			continue;
		}
		if (inHtml) {
			if (line.includes('-->'))
				inHtml = false;
			continue;
		}
		if (inObsidian) {
			if (line.includes('%%'))
				inObsidian = false;
			continue;
		}
		const marks = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (marks) {
			if (!fence)
				fence = marks[1];
			else if (marks[1][0] === fence[0] && marks[1].length >= fence.length)
				fence = undefined;
			continue;
		}
		if (fence)
			continue;
		const htmlOpen = line.indexOf('<!--');
		if (htmlOpen !== -1 && line.indexOf('-->', htmlOpen) === -1) {
			inHtml = true;
			continue;
		}
		const obsOpen = line.indexOf('%%');
		if (obsOpen !== -1 && line.indexOf('%%', obsOpen + 2) === -1) {
			inObsidian = true;
			continue;
		}
		const atx = line.match(/^ {0,3}(#{1,6})(?:[ \t]|$)(.*)$/);
		if (!atx)
			continue;
		// 行尾那串井号是闭合写法（`## One ##`）的后半边；注释不属于标题要说的内容。
		const heading = atx[2]
			.replace(/[ \t]+#+[ \t]*$/, '')
			.replace(/<!--[\s\S]*-->/g, '')
			.replace(/%%[\s\S]*?%%/g, '')
			.trim();
		if (heading)
			out.push({ heading, level: atx[1].length, line: i });
	}
	return out;
}

// 给手握整篇文本的调用方用的入口。已经切好行的调用方应当直接把 LINES 交出来：一篇笔记一次
// 阅读只切一次，不切两次（见 reads.ts）。
export function headingsFromText(text: string): HeadingRef[] {
	return headingsFromLines(text.split('\n'));
}

// 这一行落在哪条标题链里，最外层在前。标题正好在这一行上时也算作最深的一段：这条链要给目标
// 行命名，而不是跳到它的父一级。`headings` 按文档顺序传入，与缓存里的顺序一致。
export function headingTrailAtLine(headings: HeadingRef[] | undefined, line: number): string[] {
	if (!headings || !headings.length)
		return [];
	const stack: HeadingRef[] = [];
	for (const h of headings) {
		if (h.line > line)
			break;
		while (stack.length && stack[stack.length - 1].level >= h.level)
			stack.pop();
		stack.push(h);
	}
	return stack.map(h => h.heading);
}

// 直接从笔记自己的文本算出某行的标题链 —— 从活的编辑器缓冲区出发的调用方手里正好是这个形状
// （见 position/ui/cue.ts）。
export function outlinePathAtLine(lines: readonly string[], line: number): string[] {
	return headingTrailAtLine(headingsFromLines(lines), line);
}
