// The recent-files browser's pure model layer: what a row SAYS (its display pieces,
// its heading chain) derived from an entry, with the two things only the caller
// can answer — the file's saved position, and its mtime now — coming in as
// predicates. No DOM and no `this`: every function here is testable on its own.

import { NavEntry } from '@/nav/entry';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';

// The display name of a path: its last segment. What a row labels itself with,
// and what the drawer sets as its headline (the folder in front of it is what
// says WHICH note, when a name is not enough — see folderOf).
export function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

// What a row PRINTS as the note's name: its last path segment without the
// extension. Obsidian's own file explorer prints notes this way, and the list
// follows it because the extension is not part of what a reader calls a note —
// "meeting-notes.md" is the note "meeting-notes" — while a row that spelled the
// suffix out spent its narrowest space on the one part that never distinguishes
// two notes in a vault of markdown. The TYPE does distinguish (`x.canvas` next to
// `x.md`), and that is what the badge beside the name says (see badgeOf).
//
// A leading dot is not an extension: ".gitignore" is a name, not a file called
// "" with the extension "gitignore" — the `cut > 0` is what keeps it whole.
export function displayName(path: string): string {
	const name = baseName(path);
	const cut = name.lastIndexOf('.');
	return cut > 0 ? name.slice(0, cut) : name;
}

// The type badge a row prints beside the name: the file's extension in capitals.
// Markdown has NO badge, because in a vault it is the unmarked default — a badge
// on every ordinary note would be a column of noise saying what the list is —
// and the eye then reads the odd ones ("PDF", "CANVAS") as the exceptions they
// are. A file with no extension at all gets "FILE", which closes the rule: every
// name printed without an extension is either markdown or marked.
//
// An empty path is the PATHLESS group (the graph, see listing.ts's NO_PATH): it
// is a view rather than a file and has no type to report.
export function badgeOf(path: string): string | undefined {
	if (!path)
		return undefined;
	const cut = path.lastIndexOf('.');
	// The dot has to be IN the last segment: "notes.v2/readme" has no extension,
	// and "notes.v2/" is not one either.
	if (cut <= path.lastIndexOf('/') + 1)
		return 'FILE';
	const ext = path.slice(cut + 1).toLowerCase();
	return ext === 'md' ? undefined : ext.toUpperCase();
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

// Which of these paths share a DISPLAYED name (see displayName), so the list can
// print the folder on exactly those rows. Built from the entries ON THE LIST
// rather than from the whole history: a colliding name the filter dropped is not
// on screen to be confused with anything.
//
// What collides is the name as PRINTED, which is the name without its extension
// and WITHOUT its badge: "a/x.md" and "b/x.canvas" are one row twice, and a
// folder is what tells them apart. (The badge tells them apart too, but only to a
// reader who already knows to look — the two rows still read as the same word,
// and the folder is the answer to "which one is this".)
export function duplicateNames(paths: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const twice = new Set<string>();
	for (const path of paths) {
		const name = displayName(path);
		if (seen.has(name))
			twice.add(name);
		seen.add(name);
	}
	return twice;
}

// What a ROW needs to know about one entry, derived from the entry. Pure (the one
// thing only the caller can answer — the file's saved position — comes in as a
// predicate) so the recent-files browser's labels are testable without a DOM. A place
// whose FILE is gone is never described: the list filters it out before asking (see
// RecentFilesList.render).
//
// It is deliberately SMALL. The details panel used to print a page of small print
// about each step — how it was made, where a link came from, the size the file had
// then, whether it had been written since — and this interface carried all of it.
// The panel is gone (a row's own click is what a reader wants, and it lands exactly
// where they left), so what is left is what the two kinds of row actually print: the
// name, the coordinate, and the coordinate as an index for the section lookup.
export interface NavEntryDescription {
	// The note's display name: its last path segment WITHOUT its extension (see
	// displayName), or the view's own label for a pathless step (the graph). The
	// file group's header prints it, with the type badge and the folder beside it
	// (see badgeOf / folderOf).
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
export function landedLine(entry: NavEntry): number | undefined {
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
	entry: NavEntry,
	savedPosition?: (path: string) => EphemeralState | undefined,
): NavEntryDescription {
	if (entry.kind === 'view')
		return { name: t('recentFiles.graphView') };
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
		name: displayName(entry.path),
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

// ===== How old a row is =====

// The units a row's age is printed in, coarsest-last. Themselves the label's
// alphabet: the word for each one is the locale's (see ageLabel).
export type AgeUnit = 'now' | 'm' | 'h' | 'd' | 'w' | 'mo' | 'y';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// A month and a year as FIXED lengths, deliberately: this is a magnitude a reader
// scans ("roughly a month ago"), not a date. A calendar-accurate month would make
// the label jump for no one's benefit and would need the wall clock the reader is
// in — the very thing the stamp is read without.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// How old a record is, as a number and a unit. Truncated rather than rounded, so
// a label never claims more time than has passed ("4w" is between four and five
// weeks, never a rounded-up five).
//
// A stamp in the FUTURE is clamped to `now`: a clock that moved backwards (a
// machine waking from sleep with a corrected time, two devices syncing) would
// otherwise print "-3m", which is worse than a slightly wrong "now".
export function ageOf(at: number, now: number): { n: number; unit: AgeUnit } {
	const d = Math.max(0, now - at);
	if (d < MINUTE)
		return { n: 0, unit: 'now' };
	if (d < HOUR)
		return { n: Math.floor(d / MINUTE), unit: 'm' };
	if (d < DAY)
		return { n: Math.floor(d / HOUR), unit: 'h' };
	if (d < WEEK)
		return { n: Math.floor(d / DAY), unit: 'd' };
	if (d < 5 * WEEK)
		return { n: Math.floor(d / WEEK), unit: 'w' };
	if (d < YEAR)
		return { n: Math.floor(d / MONTH), unit: 'mo' };
	return { n: Math.floor(d / YEAR), unit: 'y' };
}

// What a row prints as its age: the number and the unit's own word (`5m ago`,
// `5分钟`) — short, but spelled out far enough to be read at a glance rather than
// decoded. The exact moment is a tooltip away (see list.ts's fileRow).
//
// The unit goes through an exhaustive switch rather than into a template string:
// t()'s signature is keyed by the locale's own key union, which a built string
// cannot satisfy — and the switch is what makes a unit added later a compile
// error rather than a missing word at run time. (`at` and not `t`: `t` is the
// translator.)
export function ageLabel(at: number, now: number): string {
	const { n, unit } = ageOf(at, now);
	switch (unit) {
		case 'now': return t('recentFiles.age.now');
		case 'm': return `${n}${t('recentFiles.age.m')}`;
		case 'h': return `${n}${t('recentFiles.age.h')}`;
		case 'd': return `${n}${t('recentFiles.age.d')}`;
		case 'w': return `${n}${t('recentFiles.age.w')}`;
		case 'mo': return `${n}${t('recentFiles.age.mo')}`;
		case 'y': return `${n}${t('recentFiles.age.y')}`;
	}
}

// WHEN a group was last visited: the newest stamp among the records it holds.
//
// Not the anchor's own stamp, although the anchor usually IS the note's last
// visit: the anchor can have been evicted while the jumps made inside the note
// survive (see activeRep), and a group's `indices` are in LINE order (see
// groupByFile) rather than in time order — so what the group's age is is a
// question about all of them. Undefined for a group with no stamp at all, which
// the rows then print nothing for.
export function newestStamp(
	entries: NavEntry[],
	indices: number[],
	anchor?: number,
): number | undefined {
	let newest: number | undefined;
	const look = (i: number | undefined) => {
		if (i === undefined)
			return;
		const stamp = entries[i]?.t;
		if (typeof stamp === 'number' && (newest === undefined || stamp > newest))
			newest = stamp;
	};
	look(anchor);
	for (const i of indices)
		look(i);
	return newest;
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
