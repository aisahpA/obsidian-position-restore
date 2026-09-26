// The recent-files browser's pure model layer: what a row SAYS (display pieces, heading chain)
// derived from an entry, with the two things only the caller can answer — the file's saved
// position, and its mtime now — coming in as predicates. No DOM and no `this`.

import { landedLine, NavEntry, NavView } from '@/nav/entry';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';

// The display name of a path: its last segment.
export function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

// What a row PRINTS as the note's name: the last path segment without its extension. The extension
// is not part of what a reader calls a note — "meeting-notes.md" is the note "meeting-notes" — and
// a row that spelled the suffix out spent its narrowest space on the one part that never
// distinguishes two notes in a vault of markdown. The TYPE does distinguish (`x.canvas` next to
// `x.md`), and that is what the badge beside the name says (see badgeOf).
//
// A leading dot is not an extension: ".gitignore" is a name, not a file called "" — the `cut > 0`
// is what keeps it whole.
export function displayName(path: string): string {
	const name = baseName(path);
	const cut = name.lastIndexOf('.');
	return cut > 0 ? name.slice(0, cut) : name;
}

// The type badge beside the name: the extension in capitals. Markdown has NO badge, because in a
// vault it is the unmarked default — a badge on every ordinary note would be a column of noise —
// and the eye then reads the odd ones ("PDF", "CANVAS") as the exceptions they are. A file with no
// extension at all gets "FILE", which closes the rule: every name printed without an extension is
// either markdown or marked.
//
// An empty path is the PATHLESS group (a view — see listing.ts's NO_PATH): no file, no type.
export function badgeOf(path: string): string | undefined {
	if (!path)
		return undefined;
	const cut = path.lastIndexOf('.');
	// The dot has to be IN the last segment: "notes.v2/readme" has no extension.
	if (cut <= path.lastIndexOf('/') + 1)
		return 'FILE';
	const ext = path.slice(cut + 1).toLowerCase();
	return ext === 'md' ? undefined : ext.toUpperCase();
}

// The folder a path sits in: "" at the vault root, undefined for the pathless group (a view), whose
// name is a label rather than a path segment. Printed ONLY where the name collides — two notes
// called "index" are otherwise one row that cannot be told from the other, while on every other row
// the folder is the same folder repeated.
export function folderOf(path: string): string | undefined {
	if (path === '')
		return undefined;
	const cut = path.lastIndexOf('/');
	return cut === -1 ? '' : path.slice(0, cut);
}

// Which of these names are PRINTED twice, so the list can put the folder on exactly those rows.
// Built from the rows ON THE LIST rather than from the whole history: a colliding name the filter
// dropped is not on screen to be confused with anything.
//
// Names and not paths, because what can collide is the name as PRINTED — which is not always the
// file's own: two notes called `index` collide, and so do two notes whose frontmatter gives them
// the same title. The badge tells files apart too, but only to a reader who already knows to look;
// the folder answers "which one is this".
export function duplicateNames(names: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const twice = new Set<string>();
	for (const name of names) {
		if (seen.has(name))
			twice.add(name);
		seen.add(name);
	}
	return twice;
}

// What a ROW needs to know about one entry. Pure (the one thing only the caller can answer — the
// file's saved position — comes in as a predicate), so the browser's labels are testable without a
// DOM. A place whose FILE is gone is never described: the list filters it out before asking (see
// RecentFilesList.render).
export interface NavEntryDescription {
	// The note's display name (see displayName), or the view's own name for a pathless entry (see
	// viewName). The group's header prints it, with the badge and the folder beside it.
	name: string;
	// The row's caption: "L412". A step with no recorded line prints "—" instead.
	line?: string;
	// The same landing as a 0-based index — what groupByFile keys two steps as one spot, and what
	// the section chain is looked up against.
	lineIndex?: number;
}

// The WORDS of the line a landing sat on (see NavEntryState.context / contextAt) — the one thing
// about a place that is recorded and never displayed: what the note actually said there.
//
// Undefined where there are no words to quote, and that is most of an old list: a place recorded
// before the block was captured, a landing whose context read came back empty, or the blank line a
// paragraph was started on and left (a blank line is not a quote, and an empty line in a tooltip is
// a gap a reader has to explain).
export function landingText(entry: NavEntry): string | undefined {
	if (entry.kind === 'view')
		return undefined;
	const st = entry.st;
	if (!st?.context)
		return undefined;
	return st.context[st.contextAt ?? -1]?.text || undefined;
}

// The name a row prints for a PATHLESS entry — a view rather than a place in a note. It is the
// view's OWN, recorded when the reader went there: Obsidian's `getDisplayText` is what that view's
// tab header says, so the row agrees with the title the reader clicked, in the app's own language,
// and a third-party view names itself without this plugin having to know it exists (see
// shared/leaf.ts's viewLabel). With no label the view answers for itself: anything else prints its
// bare view type — the honest name when the view never offered one.
export function viewName(entry: NavView): string {
	if (entry.label)
		return entry.label;
	return entry.viewType === 'graph' ? t('recentFiles.graphView') : entry.viewType;
}

// One entry as its row prints it. The fallbacks are for a state that never went through the nav
// read: the file's saved position below, or a teleport whose landing never settled.
//
// `titleOf` is the reader's own name for the note (see reads.ts's titleOf): the vault's answer to
// "what is this note called", asked here so that everything downstream — the row, the search, the
// folder that tells two same-named notes apart — prints one name without knowing where it came
// from. Its undefined is the file name's turn rather than an absence.
export function describeNavEntry(
	entry: NavEntry,
	savedPosition?: (path: string) => EphemeralState | undefined,
	titleOf?: (path: string) => string | undefined,
): NavEntryDescription {
	if (entry.kind === 'view')
		return { name: viewName(entry) };
	let n: number | undefined;
	if (entry.st) {
		n = landedLine(entry);
	} else {
		// The entry carries no position of its own (a tab/pane activation predating the
		// leave-refresh, or a legacy persisted entry): fall back to the file's saved record — the
		// spot a reopen would restore, which is exactly this step's "where I was".
		const saved = savedPosition?.(entry.path);
		n = saved?.cursor?.from.line ?? saved?.scroll;
		if (n === undefined && entry.kind === 'teleport')
			// A landing that never settled: the recorded target line is still where the restore
			// will aim.
			n = entry.line;
	}
	return {
		name: titleOf?.(entry.path) ?? displayName(entry.path),
		line: n !== undefined ? `L${n + 1}` : undefined,
		lineIndex: n,
	};
}

// The section chain a landing sits in, built from the file's PARSED headings (metadataCache) rather
// than from its text: a row needs its section without reading the file at all. Obsidian's own parser
// is what excludes headings inside fenced code or comments, so this agrees with the outline pane.
// (The cue keeps its own raw-text scan because it works from a live editor buffer, which can be
// ahead of the cache.)
export interface HeadingRef {
	heading: string;
	level: number;
	line: number;
}

// ===== How old a row is =====

// The units a row's age is printed in, coarsest-last.
export type AgeUnit = 'now' | 'm' | 'h' | 'd' | 'w' | 'mo' | 'y';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// A month and a year as FIXED lengths, deliberately: this is a magnitude a reader scans ("roughly a
// month ago"), not a date. A calendar-accurate month would make the label jump for no one's benefit
// and would need the wall clock the stamp is read without.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// How old a record is, as a number and a unit. Truncated rather than rounded, so a label never
// claims more time than has passed ("4w" is between four and five weeks, never a rounded-up five).
//
// A stamp in the FUTURE is clamped to `now`: a clock that moved backwards (a machine waking from
// sleep with a corrected time, two devices syncing) would otherwise print "-3m".
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

// What a row prints as its age: the number and the unit's own word (`5m ago`, `5分钟`) — spelled out
// far enough to be read at a glance rather than decoded. The exact moment is a tooltip away (see
// list.ts's fileRow).
//
// The unit goes through an exhaustive switch rather than into a template string: t()'s signature is
// keyed by the locale's own key union, which a built string cannot satisfy — and the switch is what
// makes a unit added later a compile error rather than a missing word at run time.
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

// WHEN a group was last visited: the newest stamp among the records it holds. Not the anchor's own
// stamp, although the anchor usually IS the note's last visit: the anchor can have been evicted
// while the jumps made inside the note survive (see activeRep), and a group's `indices` are in LINE
// order (see groupByFile) rather than in time order.
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

// The headings in a note's own text, in document order — the FALLBACK for a note the metadata cache
// has nothing to say about: one a sync has just replaced, or one the app has not re-parsed, which on
// a phone it may not do for a file the reader never edits — and OPENING the file does not make it
// happen either (the editor reads the text, the cache does not). Without this a row printed its line
// alone — `L412` — for as long as that state lasted.
//
// Deliberately only ATX headings (`#` … `######`), and only where a space or the end of the line
// follows the marks: a line opening with `#tag` is one of the app's tags, and a `#` inside a fenced
// block is a comment in somebody's shell. The frontmatter is skipped for the same reason —
// `title: # 1` is a value.
export function headingsFromText(text: string): HeadingRef[] {
	const out: HeadingRef[] = [];
	const lines = text.split('\n');
	// The marks that opened the fence that is still open, if one is: a block closes on a fence of
	// its own kind, so ``` inside a ~~~ block is an ordinary line of it.
	let fence: string | undefined;
	// Whether the frontmatter block is still open. It is the file's FIRST line or nothing at all.
	let frontmatter = lines[0]?.trim() === '---';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (frontmatter) {
			if (i > 0 && line.trim() === '---')
				frontmatter = false;
			continue;
		}
		const marks = line.match(/^ {0,3}(```+|~~~+)/);
		if (marks) {
			if (!fence)
				fence = marks[1];
			else if (marks[1][0] === fence[0])
				fence = undefined;
			continue;
		}
		if (fence)
			continue;
		const atx = line.match(/^ {0,3}(#{1,6})(?:[ \t]|$)(.*)$/);
		if (!atx)
			continue;
		// Trailing marks are the closing half of the closed form (`## One ##`).
		const heading = atx[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
		if (heading)
			out.push({ heading, level: atx[1].length, line: i });
	}
	return out;
}

// The chain as a ROW prints it: the deepest `depth` levels only, outermost first (a row has one line
// of width). The deepest level is KEPT even when it is the heading the landing line itself carries:
// nothing else on the row names the landing's own text, and dropping it left the row naming its
// PARENT section instead.
export function rowTrail(trail: string[], depth = 2): string[] {
	return trail.slice(-depth);
}

// Whether a row has to give up the OUTER level of the chain it prints: less than HALF of the level
// survived the row's width. `whole` is the width the level asks for, `shown` what the row could give
// it — both read off a laid-out row by the one caller that has one (see RecentFilesList.fitTrails).
//
// Half, and not "any of it was cut": a clipped level that is still mostly there names its section
// (`面板设计与信息架…`), while what a squeezed one leaves is a FRAGMENT that names nothing
// (`新插件 Positi…`) — so the line is drawn where the level stops being READABLE, not where it stops
// being whole.
//
// Not about the deepest level's width: that level takes the width its own text needs whatever stands
// beside it (see styles.css's `flex: 0 0 auto`), so taking the outer level off buys it not a pixel.
// What it buys is the READING — and the section a row let go of is one hover away either way. A
// level that fits at all is never dropped (`whole === 0` means nothing is clipped).
export function dropsOuterLevel(shown: number, whole: number): boolean {
	return whole > 0 && shown * 2 < whole;
}
