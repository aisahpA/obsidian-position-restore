// ONE WAY TO READ A NOTE'S HEADINGS, and one way to build the section chain a
// line sits in. Two callers must name a section identically or one place gets
// two names: the post-restore breadcrumb (position/ui/cue.ts) and the
// recent-files row's strip (recent-files/browser/body.ts).
//
// WHERE THE HEADINGS COME FROM is not this file's business and the two callers
// differ, for a good reason: the row reads the metadata cache (the app's own
// parse, already excluding headings inside fences and comments), the cue reads
// the live editor buffer, which can be ahead of the cache. What is shared is
// the TEXT fallback — for a note the cache says nothing about, or one the
// reader is editing right now — and the chain built on top.
export interface HeadingRef {
	heading: string;
	level: number;
	line: number;
}

// The headings in a note's own text, in document order — the FALLBACK for a note the metadata cache
// has nothing to say about: one a sync has just replaced, or one the app has not re-parsed, which on
// a phone it may not do for a file the reader never edits — and OPENING the file does not make it
// happen either (the editor reads the text, the cache does not). Without this a row printed its line
// alone — `L412` — for as long as that state lasted.
//
// Deliberately only ATX headings (`#` … `######`), and only where a space, a tab or the end of the
// line follows the marks: a line opening with `#tag` is one of the app's tags, and a `#` inside a
// fenced block is a comment in somebody's shell. The frontmatter is skipped for the same reason —
// `title: # 1` is a value.
export function headingsFromLines(lines: readonly string[]): HeadingRef[] {
	const out: HeadingRef[] = [];
	// The run that opened the fence still open, if one is: a block closes on a run of its own kind
	// AT LEAST AS LONG AS ITS OPENER (CommonMark), so three marks inside a six-mark block are an
	// ordinary line of it. Comment blocks close at the next marker anywhere in a line.
	let fence: string | undefined;
	let inHtml = false;
	let inObsidian = false;
	// Whether the frontmatter block is still open. It is the file's FIRST line or nothing at all.
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
		// Trailing marks are the closing half of the closed form (`## One ##`); a comment is not
		// part of what the heading says.
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

// The text-shaped entry point, for a caller holding the note whole. A caller that has already
// split it hands the LINES over instead: a note is split once per reading, not twice (see reads.ts).
export function headingsFromText(text: string): HeadingRef[] {
	return headingsFromLines(text.split('\n'));
}

// The chain of headings the line falls under, outermost first. A heading ON the line is included as
// the deepest segment: the chain names the target line rather than skipping to its parent section.
// `headings` is in document order, as the cache stores it.
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

// The chain a line sits in, read straight out of the note's own text — the shape a caller working
// from a live editor buffer has in hand (see position/ui/cue.ts).
export function outlinePathAtLine(lines: readonly string[], line: number): string[] {
	return headingTrailAtLine(headingsFromLines(lines), line);
}
