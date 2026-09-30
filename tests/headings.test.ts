// Tests for shared/headings.ts: the section chain a line sits under, read out
// of a note's own text. Shared by two callers that must agree — the
// post-restore breadcrumb and the recent-files row's strip — so what is pinned
// here is the scan they both lean on, not either one's use of it.

import { describe, it, expect } from 'vitest';
import { outlinePathAtLine } from '@/shared/headings';

const trail = (lines: string[], line: number) => outlinePathAtLine(lines, line);

describe('outlinePathAtLine', () => {
	it('nests by heading level, outermost first', () => {
		const lines = ['# A', 'text', '## B', 'text', '### C', 'here'];
		expect(trail(lines, 5)).toEqual(['A', 'B', 'C']);
		// a shallower heading closes the deeper ones
		expect(trail(lines, 1)).toEqual(['A']);
	});

	it('includes a heading sitting on the line itself as the deepest segment', () => {
		const lines = ['# A', '## B'];
		expect(trail(lines, 1)).toEqual(['A', 'B']);
	});

	it('is empty above the first heading', () => {
		expect(trail(['text', '# A'], 0)).toEqual([]);
	});

	it('ignores heading-looking lines inside fences and comments', () => {
		const lines = ['# Real', '```', '# not a heading', '```', '<!--', '# nor this', '-->', '%%', '# nor this', '%%', 'body'];
		expect(trail(lines, 11)).toEqual(['Real']);
	});

	// CommonMark: a fence closes on a run of its own kind AT LEAST AS LONG AS
	// its opener, so a shorter run is an ordinary line of the block. Both mark
	// characters obey it — a `~` block that closed on any run ended early, and
	// a `#` line inside it became a section the note does not have.
	it('closes a fence only on a run at least as long as its opener', () => {
		expect(trail(['# Real', '~~~~~~', '# in', '~~~', '# still in', '~~~~~~', 'body'], 6)).toEqual(['Real']);
		expect(trail(['# Real', '``````', '# in', '```', '# still in', '``````', 'body'], 6)).toEqual(['Real']);
	});

	it('strips a closing hash run and inline comment from the heading text', () => {
		expect(trail(['## Title ##'], 0)).toEqual(['Title']);
		expect(trail(['## Title %%note%%'], 0)).toEqual(['Title']);
	});

	// Three spaces of indent are still an ATX heading; four are a fence's
	// opening, which is why the scan stops at three.
	it('reads an indented heading', () => {
		expect(trail(['# A', '   ## B'], 1)).toEqual(['A', 'B']);
	});

	// `title: # 1` is a value, not a section the note has.
	it('skips the frontmatter', () => {
		expect(trail(['---', 'title: # 1', '---', '# Real'], 3)).toEqual(['Real']);
	});
});
