// The recorded lines, dressed as MARKDOWN for Obsidian's own renderer.
//
// The drawer used to print the block as pre-formatted lines with a gutter — the
// raw source the capture happened to store, in the smallest type the dialog had.
// That is a debug view, not a preview: a heading arrived as "## 呈现方案", a link
// as "[[别的笔记]]", an emphasis as "**加粗**", and the reader had to render it in
// their head before they could recognize the spot. So the block goes back through
// the renderer the reading view uses (see PreviewContent), and this module is
// everything that has to happen to the recorded lines before that.
//
// AND IT IS A SNIPPET, not a document. The capture takes a window of the lines
// around the landing, so what arrives here routinely starts in the middle of
// something: a table with its header outside the window, a code fence whose
// opening line is five lines up, a frontmatter the landing happens to sit inside.
// Handing that to a markdown parser produces the one thing worse than raw text — a
// paragraph of literal pipes, an <hr> through the middle of the properties, half
// the block swallowed by an unclosed fence. So the snippet is REPAIRED before it
// is rendered: frontmatter is dropped (or shown as what it is) and truncated
// constructs are closed or completed. Every repair has to be one a reader would
// have made themselves, and none of them may invent content: lines are only ever
// ADDED as delimiters, never as text.
//
// A file that is not a note is not a snippet at all and never comes through that
// path: it has no prose in it, and is shown as the source it is (see fileSource).

import { NavHistoryEntry } from '@/nav-history/entry';

// The lines a recorded block covers, 1-based, as the caption prints them: the
// numbers the gutter used to put in front of every line. The rendered block has
// no gutter, and one range says the same thing in one place.
export interface ContextRange {
	from: number;
	to: number;
}

export function contextRange(entry: NavHistoryEntry): ContextRange | undefined {
	const lines = entry.kind === 'view' ? undefined : entry.st?.context;
	if (!lines?.length)
		return undefined;
	return { from: lines[0].line + 1, to: lines[lines.length - 1].line + 1 };
}

// One recorded line on its way to the renderer. The landing is carried SEPARATELY
// from the text because the repairs below append and insert lines: a flag that
// travels with the line cannot be lost by them the way a remembered index can.
interface SnippetLine {
	// The line's number in the file, or -1 for a line this module invented.
	line: number;
	text: string;
	landing: boolean;
}

// The recorded block as ONE markdown document, for a file that IS a note (see
// isMarkdown; anything else is drawn from its own source by fileSource).
// `frontmatterEnd` is the last line of the file's frontmatter as the metadata
// cache knows it (see NavHistoryReads.frontmatterEnd); without it — a deleted
// file, a file written since, a file the cache has not parsed — only a block that
// OPENS the file can be recognized as carrying frontmatter at all (see
// openingFrontmatterEnd).
//
// Lines are trimmed: the capture stores them as they were in the file, and four
// spaces of indentation would turn a paragraph into a code block the moment it
// is rendered.
export function contextMarkdown(entry: NavHistoryEntry, frontmatterEnd?: number): string | undefined {
	if (entry.kind === 'view')
		return undefined;
	const st = entry.st;
	if (!st?.context?.length)
		return undefined;
	const at = st.contextAt ?? -1;
	const raw: SnippetLine[] = st.context.map((l, i) => ({
		line: l.line,
		text: l.text.trim(),
		landing: i === at,
	}));
	const end = frontmatterEnd ?? openingFrontmatterEnd(raw);
	const kept = end === undefined ? raw : raw.filter(l => l.line > end);
	// The landing is IN the properties. There is no prose to show and no `==…==`
	// that a YAML block would honour, so the properties are shown as the YAML they
	// are — legible, and honest about being metadata rather than a spot in the
	// text.
	if (!kept.length)
		return fenced('yaml', raw.map(l => l.text).join('\n'));
	return complete(kept)
		.map(l => (l.landing ? marked(l.text) : l.text))
		.join('\n');
}

// What the WHOLE-NOTE view — and every view of a file that is not a note — hands
// to the renderer: a note's text as it stands, or a file that is not markdown
// wrapped in a code block, because that is what it is. A Bases file or a canvas
// run through a markdown parser comes out as a paragraph of punctuation with
// structure invented around it.
export function fileSource(path: string, text: string): string {
	return isMarkdown(path) ? text : fenced(languageOf(path), text);
}

// Whether a path is a note. Only the note formats are drawn as prose: everything
// else in a vault (Bases, canvases, JSON, CSS snippets) is data, and is shown as
// the source it is (see fileSource).
export function isMarkdown(path: string): boolean {
	return /\.(md|markdown)$/i.test(path);
}

// A file that has no text to show at all: decoded into a string and drawn in the
// drawer, a PDF is a wall of replacement characters and an image is worse. Skipped
// by EXTENSION rather than by reading: finding out what a 40 MB PDF is by reading
// it is not a trade a preview may make.
const BINARY = new Set([
	'pdf', 'epub', 'mobi', 'azw3', 'djvu',
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'bmp', 'tiff', 'ico', 'svg',
	'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus',
	'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v',
	'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
	'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
	'ttf', 'otf', 'woff', 'woff2', 'eot', 'dmg', 'exe', 'bin', 'wasm', 'sqlite', 'db',
]);

export function isBinary(path: string): boolean {
	return BINARY.has(extensionOf(path));
}

// …and for a file the list above does not know: a NUL byte, or a run of control
// characters in the first couple of kilobytes, is what binary looks like once it
// has been decoded into a string. Anything else is shown as its source.
export function looksBinary(text: string): boolean {
	const sample = text.slice(0, 4096);
	let control = 0;
	for (const ch of sample) {
		const code = ch.codePointAt(0) ?? 0;
		if (code === 0)
			return true;
		if (code < 32 && code !== 9 && code !== 10 && code !== 13)
			control++;
	}
	return sample.length > 0 && control / sample.length > 0.05;
}

function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const cut = name.lastIndexOf('.');
	return cut === -1 ? '' : name.slice(cut + 1).toLowerCase();
}

// The language a code block is labelled with. Bases are YAML and canvases are
// JSON, whatever they are called; everything else is its own extension, which is
// what a fence wants and what the highlighter falls back from harmlessly.
function languageOf(path: string): string {
	const ext = extensionOf(path);
	if (ext === 'base')
		return 'yaml';
	if (ext === 'canvas')
		return 'json';
	if (ext === 'txt' || ext === 'text')
		return '';
	return ext;
}

// A source that is not prose: legible, copyable, and impossible to mis-parse. The
// fence is made longer than any run of backticks inside the text, so nothing can
// break out of the block.
function fenced(language: string, text: string): string {
	const longest = Array.from(text.matchAll(/`{3,}/g), m => m[0].length);
	const bars = '`'.repeat(Math.max(3, ...longest.map(n => n + 1)));
	return `${bars}${language}\n${text}\n${bars}`;
}

// The end of the frontmatter a block that OPENS THE FILE carries: from the `---`
// on line 0 to its closing `---`. A block that starts in the MIDDLE of frontmatter
// cannot be recognized from the recorded lines alone — nothing in a bare
// "aliases: […]" says it is metadata — which is what the cache's own range is for
// (NavHistoryReads.frontmatterEnd). An opening with no closing inside the block
// means the whole block is properties: the last recorded line stands in as the
// end, so the block is shown as YAML rather than as a heading rule and prose.
function openingFrontmatterEnd(lines: SnippetLine[]): number | undefined {
	if (lines[0].line !== 0 || !isDelimiter(lines[0].text))
		return undefined;
	const closing = lines.find((l, i) => i > 0 && isDelimiter(l.text));
	return closing?.line ?? lines[lines.length - 1].line;
}

function isDelimiter(text: string): boolean {
	return /^(-{3,}|\.{3,})$/.test(text);
}

// A line that can carry an inline `==…==` mark and still be the line it was. A
// fence or a thematic break IS its own first characters: prefixing them turns the
// fence into a paragraph (and swallows the code that followed it) and the break
// into text. Those lines go unmarked — the caption above the block still says
// which range the reader is looking at.
function markable(text: string): boolean {
	if (text === '')
		return false;
	if (fenceMarker(text))
		return false;
	return !/^(?:-{3,}|\*{3,}|_{3,})$/.test(text);
}

// A line whose own first characters ARE the construct: a heading, a list item, a
// quote or a callout. An inline `==…==` in front of one is not an emphasis of that
// line, it is a DIFFERENT line — "==## 呈现方案==" is a paragraph that happens to
// begin with two equals signs, and the reader is shown the note's source, which is
// the one thing rendering the block exists to avoid. These landings are marked on
// the RENDERED block instead (see revealLanding), which is what the whole-note view
// does with every landing it finds.
// This reads the line's SHAPE rather than parsing it: it decides how the landing is
// drawn, never what the block contains.
function blockLine(text: string): boolean {
	return /^\s{0,3}(?:#{1,6}(?=\s|$)|>|[-*+](?=\s|$)|\d+[.)](?=\s|$))/.test(text);
}

// Whether a landing line gets its mark INSIDE the source handed to the renderer:
// the `==…==` mark around the line, or — inside a table, where wrapping the line
// would stop it being a row — the first cell of it. False means the mark has to be
// put on the rendered block afterwards, and it is the caller that has to know,
// since it is the caller that renders (see NavPreviewContent.show). One rule, used
// in both places: `marked` below and the caller.
export function landingMarkedInSource(text: string): boolean {
	if (!markable(text))
		return false;
	if (isTableRow(text))
		return true;
	return !blockLine(text);
}

// The landing, marked. Inside a TABLE the mark has to stay inside a cell:
// wrapping the whole line, pipes and all, would stop it being a row and the table
// would collapse into a paragraph of pipes — the very thing the repair above
// exists to prevent. So the first cell is what carries the mark.
function marked(text: string): string {
	if (!landingMarkedInSource(text))
		return text;
	if (!isTableRow(text))
		return `==${text}==`;
	return text.replace(/^(\s*\|)([^|]*)\|/, (_all, lead: string, cell: string) => `${lead} ==${cell.trim()}== |`);
}

// ---------------------------------------------------------------------------
// Repairing the fragment (see the header): what the window cut in half is closed
// or completed, so the parser sees the construct the reader saw.
// ---------------------------------------------------------------------------

function complete(lines: SnippetLine[]): SnippetLine[] {
	const out: SnippetLine[] = [];
	// The opening marker while a code block is open. Everything inside one is
	// verbatim: a fence's contents are not tables, not math, not anything.
	let fence: string | null = null;
	let maths = false;
	let comment = false;
	let table: SnippetLine[] = [];
	const closeTable = (): void => {
		if (table.length)
			out.push(...completeTable(table));
		table = [];
	};
	for (const line of lines) {
		const marker = fenceMarker(line.text);
		if (marker) {
			// A fence line either closes the open block or opens one — the same
			// thing markdown does, and what makes a stray closer (its opener
			// outside the window) render as the code block it belongs to.
			closeTable();
			if (fence && marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
			else if (!fence)
				fence = marker;
			out.push(quiet(line));
			continue;
		}
		// A delimiter of an open state closes it, so it is read before the
		// verbatim branch below.
		if (!fence && line.text === '$$') {
			closeTable();
			maths = !maths;
			out.push(quiet(line));
			continue;
		}
		if (!fence && line.text === '%%') {
			closeTable();
			comment = !comment;
			out.push(quiet(line));
			continue;
		}
		// Inside a code block, a maths block or a comment: verbatim, and blind to
		// the table detection below (a fence's contents are not a table). Nothing
		// in here can carry a mark either — `==…==` would be printed as code, or
		// hidden, or read as algebra.
		if (fence || maths || comment) {
			closeTable();
			out.push(quiet(line));
			continue;
		}
		if (isTableRow(line.text)) {
			table.push(line);
			continue;
		}
		closeTable();
		out.push(line);
	}
	closeTable();
	// Whatever the window opened and did not close: closed here, so the snippet is
	// a WHOLE document and no renderer has to guess where the construct ended. For
	// a fence, a maths block or a comment this rarely changes what a reader sees —
	// markdown already runs those to the end of its input — but the guess is what
	// varies between renderers, and a snippet that depends on being the last thing
	// rendered is a snippet that breaks the day something is drawn after it.
	if (fence)
		out.push({ line: -1, text: fence, landing: false });
	if (maths)
		out.push({ line: -1, text: '$$', landing: false });
	if (comment)
		out.push({ line: -1, text: '%%', landing: false });
	return out;
}

// A line of a verbatim construct (code, maths, a comment) is never the spot the
// reader is looking for: the mark would be printed as source, hidden, or read as
// algebra. The landing stays unmarked there, and the caption still names it.
function quiet(line: SnippetLine): SnippetLine {
	return line.landing ? { ...line, landing: false } : line;
}

// A run of pipe rows with no separator among them is not a table to markdown: it
// draws as a paragraph of pipes. The capture took a WINDOW, so the separator — and
// the header row above it — may simply be outside it. The run is completed with a
// separator, and its first captured row stands in as the header: the columns are
// the reader's own, and the landing line is still the line it was.
function completeTable(rows: SnippetLine[]): SnippetLine[] {
	// One row is as likely to be prose that happens to hold pipes as a table, and
	// a separator under a single row would invent a table out of a sentence.
	if (rows.length < 2 || rows.some(r => isSeparatorRow(r.text)))
		return rows;
	const cells = Math.max(1, rows[0].text.trim().replace(/^\||\|$/g, '').split('|').length);
	const separator = `| ${Array.from({ length: cells }, () => '---').join(' | ')} |`;
	return [rows[0], { line: -1, text: separator, landing: false }, ...rows.slice(1)];
}

// A table row: a leading pipe and at least one more, which is what a row of two
// or more cells looks like. Prose with one pipe in it stays prose.
function isTableRow(text: string): boolean {
	return /^\s*\|.*\|/.test(text);
}

// The separator row of a table: dashes and colons between pipes, nothing else.
function isSeparatorRow(text: string): boolean {
	return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(text);
}

// The opening marker of a fenced code block, when the line is one.
function fenceMarker(text: string): string | null {
	return /^(`{3,}|~{3,})/.exec(text)?.[1] ?? null;
}

// What a line of markdown says once it has been RENDERED, as a single line of
// plain words: the syntax that does not survive rendering is stripped, and all
// whitespace collapses. Used to find a recorded line again in a rendered note,
// where nothing carries the source line numbers.
export function plainText(text: string): string {
	return text
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
		.replace(/^\s{0,3}>\s?/gm, '')
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
		.replace(/!?\[\[([^\]]*)\]\]/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// The block-level elements a landing can be looked for among: the ones a
// rendered note is made of, so a match is a paragraph, a heading, a list item —
// never the whole document.
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, .callout-title-inner';

// Find the recorded landing line inside a rendered note and put it on screen.
// The full-note view is the file as it stands NOW, so its line numbers are not
// necessarily the recorded one any more (the head says so when it knows); the
// line's own words are what survives a rewrite, and they are what this looks
// for. Nothing found is not an error: the note is still a preview of the note,
// and a reader who has scrolled can see it from the top.
// `minNeedle` is how much of the line has to survive as words before the search
// is worth making. The default is for the WHOLE note, where two or three
// characters ("标题", "TODO") match half the file and the first hit could be any
// of them; the spot view — a dozen recorded lines, one of which is known to be the
// landing — can afford to look for less (see NavPreviewContent.show).
// @returns whether a landing was found and marked.
export function revealLanding(root: HTMLElement, anchor: string | undefined, minNeedle = 4): boolean {
	// The previous landing goes first: this DOM is reused while the reader walks
	// the landings of ONE note, and two marked lines would be two "you are here".
	for (const marked of Array.from(root.querySelectorAll('.nav-preview-landing')))
		marked.classList.remove('nav-preview-landing');
	const needle = plainText(anchor ?? '');
	if (needle.length < minNeedle)
		return false;
	const hit = Array.from(root.querySelectorAll<HTMLElement>(BLOCKS)).find((el) => {
		if (!plainText(el.textContent ?? '').includes(needle))
			return false;
		// The DEEPEST match wins: a list or a callout also contains the words of
		// its items, and marking the wrapper would paint half the note as the spot.
		return !Array.from(el.children).some(child => plainText(child.textContent ?? '').includes(needle));
	});
	if (!hit)
		return false;
	hit.classList.add('nav-preview-landing');
	hit.scrollIntoView({ block: 'center' });
	return true;
}

// The other half of that answer: WHERE in the note the landing is, when its words
// could not be found. The recorded line index is expressed as a fraction of the
// note AS IT STANDS NOW (see NavPreviewContent.placeIn) — the file actually being
// rendered, which is not necessarily the one the step was recorded in — so the
// fraction gets the reader to roughly the right part of it. An approximation, and
// said to be one: it marks nothing, since the block it lands on is not known to
// be the spot.
//
// This exists because "the line's words are gone" is the ordinary case, not an
// error: the note was edited, the landing was a blank line, the line was two
// characters long, or the entry recorded no text at all (a saved-position step).
// Without it the whole-note view simply showed the top of the file, which is not
// an answer to "take me to where I was".
// @returns whether the content was moved at all.
export function revealFraction(root: HTMLElement, fraction: number | undefined): boolean {
	if (fraction === undefined || !Number.isFinite(fraction))
		return false;
	const scroller = scrollableAncestor(root);
	if (!scroller)
		return false;
	const span = scroller.scrollHeight - scroller.clientHeight;
	if (span <= 0)
		return false;
	const at = Math.max(0, Math.min(1, fraction));
	scroller.scrollTop = at * span;
	return true;
}

// The nearest ancestor that actually scrolls, which is the drawer's own scroller
// on a pointing device and the list on touch (see styles.css). Walked rather than
// named: the panel is moved around the DOM (see LandingPanel.render), and a class
// the CSS owns is not a contract this module should hold.
function scrollableAncestor(el: HTMLElement): HTMLElement | undefined {
	for (let up = el.parentElement; up; up = up.parentElement) {
		if (up.scrollHeight > up.clientHeight + 1)
			return up;
	}
	return undefined;
}
