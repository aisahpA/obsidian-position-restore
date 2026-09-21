// The history browser's pure model layer: what a row SAYS (its display pieces,
// its heading chain) derived from an entry, with the two things only the caller
// can answer — the file's saved position, and its mtime now — coming in as
// predicates. No DOM and no `this`: every function here is testable on its own.

import { NavHistoryEntry } from '@/nav-history/entry';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';

// The display name of a path: its last segment. What a row labels itself with,
// and what the drawer sets as its headline (the folder in front of it is what
// says WHICH note, when a name is not enough — see folderOf).
export function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

// The folder a path sits in, for a name another path shares — "" for a note at
// the vault root, and undefined for the placeholder group a pathless entry (the
// graph) gets, whose name is a translated label rather than a path segment. Two
// notes called "index" are otherwise one row that cannot be told from the other,
// and the folder is the only thing that distinguishes them; it is printed ONLY
// where the name collides, because on every other row it is the same folder
// repeated.
export function folderOf(path: string): string | undefined {
	if (path === '')
		return undefined;
	const cut = path.lastIndexOf('/');
	return cut === -1 ? '' : path.slice(0, cut);
}

// Which of these paths share a name (the last segment), so the list can print
// the folder on exactly those rows. Built from the entries ON THE LIST rather
// than from the whole history: a colliding name the filter dropped is not on
// screen to be confused with anything.
export function duplicateNames(paths: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const twice = new Set<string>();
	for (const path of paths) {
		const name = baseName(path);
		if (seen.has(name))
			twice.add(name);
		seen.add(name);
	}
	return twice;
}

// What a ROW needs to know about one entry, derived from the entry. Pure (the one
// thing only the caller can answer — the file's saved position — comes in as a
// predicate) so the history browser's labels are testable without a DOM. A place
// whose FILE is gone is never described: the list filters it out before asking (see
// NavHistoryList.render).
//
// It is deliberately SMALL. The details panel used to print a page of small print
// about each step — how it was made, where a link came from, the size the file had
// then, whether it had been written since — and this interface carried all of it.
// The panel is gone (a row's own click is what a reader wants, and it lands exactly
// where they left), so what is left is what the two kinds of row actually print: the
// name, the coordinate, and the coordinate as an index for the section lookup.
export interface NavEntryDescription {
	// The note's display name: its last path segment, or the view's own label for a
	// pathless step (the graph). The file group's header prints it, and prints the
	// folder beside it when another path shares the name (see folderOf).
	name: string;
	// The row's caption: "L412". A step with no recorded line prints "—" instead.
	line?: string;
	// The same landing as a 0-based index — what groupByFile keys two steps as one
	// spot, and what the section chain is looked up against.
	lineIndex?: number;
}

// Which line a step landed on, or undefined when it recorded none. READ, not
// derived: the capture recorded the block with the landing line marked (contextAt) —
// the choice it made from the view mode and the cursor's visibility (see
// navDisplayFields) — with the viewport top and then the cursor as the fallbacks for
// a state that never went through that read.
//
// This is what "the SAME landing" means anywhere the browser tells two steps apart
// without a DOM: the list collapses the steps that landed on one line into one spot
// (see groupByFile), and the row prints the number it returns.
export function landedLine(entry: NavHistoryEntry): number | undefined {
	if (entry.kind === 'view')
		return undefined;
	const st = entry.st;
	if (!st)
		return undefined;
	return st.context?.[st.contextAt ?? -1]?.line ?? st.scroll ?? st.cursor?.from.line;
}

// One entry as its row prints it. The fallbacks are for a state that never went
// through the nav read: the file's saved position below, or a teleport whose landing
// never settled.
export function describeNavEntry(
	entry: NavHistoryEntry,
	savedPosition?: (path: string) => EphemeralState | undefined,
): NavEntryDescription {
	if (entry.kind === 'view')
		return { name: t('navHistory.graphView') };
	let n: number | undefined;
	if (entry.st) {
		n = landedLine(entry);
	} else {
		// The entry carries no position of its own (a tab/pane activation predating the
		// leave-refresh, or a legacy persisted entry): fall back to the file's saved
		// record — the spot a reopen would restore, which is exactly this step's "where
		// I was".
		const saved = savedPosition?.(entry.path);
		n = saved?.cursor?.from.line ?? saved?.scroll;
		if (n === undefined && entry.kind === 'teleport')
			// A landing that never settled: the recorded target line is still where the
			// restore will aim.
			n = entry.line;
	}
	return {
		name: baseName(entry.path),
		line: n !== undefined ? `L${n + 1}` : undefined,
		lineIndex: n,
	};
}

// The section chain a landing sits in, built from the file's PARSED headings
// (metadataCache) rather than from its text: a row needs its section without
// reading the file at all. Obsidian's own parser is what
// excludes headings inside fenced code or comments, so this agrees with the
// outline pane. (The cue keeps its own raw-text scan because it works from a
// live editor buffer, which can be ahead of the cache.)
export interface HeadingRef {
	heading: string;
	level: number;
	line: number;
}

// The chain of headings the line falls under, outermost first. A heading ON
// the line is included as the deepest segment: the chain names the target line
// rather than skipping to its parent section. `headings` is in document order,
// as the cache stores it.
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

// The chain as a ROW prints it: the deepest `depth` levels only, outermost
// first (a row has one line of width). The deepest level is KEPT even when it is
// the heading the landing line itself carries: nothing else on the row names the
// landing's own text, so that heading is the last, most specific level the row
// can name — dropping it left the row naming its PARENT section instead.
export function rowTrail(trail: string[], depth = 2): string[] {
	return trail.slice(-depth);
}
