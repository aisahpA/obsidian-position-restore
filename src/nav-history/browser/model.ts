// The history browser's pure model layer: what a row SAYS (its display pieces,
// its heading chain) derived from an entry, with the vault lookup coming in as a
// predicate. No DOM and no `this` — every function here is testable on its own.

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

// One row's display pieces, derived from the entry. Pure (the vault lookup
// comes in as a predicate) so the history browser's labels are testable
// without a DOM.
export interface NavEntryDescription {
	// The note's display name: its last path segment. The file group's header
	// prints it, and prints the folder beside it when another path shares the
	// name (see folderOf).
	name: string;
	type: string;
	// …and whether that type says anything. An OPEN is what a step is by default —
	// the file was opened — so printing it is printing the unremarkable case on every
	// row's small print; the other four (a link, the outline, a tab switch, an
	// inferred move) are the ones a reader may want to know about. The panel prints
	// the type only when this is false (see LandingPanel.head).
	plainOpen?: boolean;
	line?: string;
	// The same landing line as a 0-based index (what the drawer reads to place the
	// landing in the note, and where `line` is computed from). `line` is the
	// display form: "L412".
	lineIndex?: number;
	// The file's line count at capture time, when the entry recorded one — the
	// denominator that turns "L412" into a place in the note ("L412 / 1200").
	lineCount?: number;
	// The file was WRITTEN after this position was recorded (its live mtime
	// differs from the recorded one), so the recorded landing text may no
	// longer be what is there. Said out loud rather than hidden: the search box
	// matches that recorded text.
	stale?: boolean;
	anchor?: string;
	missing: boolean;
	// An inferred entry (NavTeleport): the user did not deliberately jump
	// there — the badge renders dimmed to signal lower confidence.
	soft?: boolean;
	// For a step made by clicking a link (see NavVisit.viaPath): the note the
	// link was clicked in, and the link's own text, which may carry a
	// |display alias. Only the SOURCE is shown, and only in the landing panel's
	// head (the row has no room); both are searchable.
	viaName?: string;
	viaText?: string;
}

// The display text of a link's own href: `Note|The words shown` keeps only the
// words, since the target half only repeats the destination the row already
// names.
export function linkDisplayText(viaText: string): string {
	const bar = viaText.lastIndexOf('|');
	return (bar === -1 ? viaText : viaText.slice(bar + 1)).trim();
}

// The landing a step recorded, in the entry's own terms: which line it left the
// reader on, and the text of that line when the recorded block carries it. It
// comes straight out of the capture's context block, where `contextAt` already
// names the landing — the capture decided that from the view mode and the
// cursor's visibility, which is geometry no later reader can reconstruct (see
// capture/ephemeral.ts) — with the viewport top and then the cursor as the
// fallbacks for a state that never went through that read.
//
// Exported because this is what "the SAME landing" means anywhere the browser
// has to tell two steps apart without a DOM: the list collapses the steps that
// landed on one line into one spot (see groupByFile), and the panel's caption
// names the range the block covers.
export interface RecordedLanding {
	line?: number;
	text?: string;
}

export function recordedLanding(entry: NavHistoryEntry): RecordedLanding | undefined {
	if (entry.kind === 'view')
		return undefined;
	const st = entry.st;
	if (!st)
		return undefined;
	const at = st.context?.[st.contextAt ?? -1];
	return { line: at?.line ?? st.scroll ?? st.cursor?.from.line, text: at?.text || undefined };
}

// Which line a step lands on, and the text that goes with it (the row shows the
// number, the panel shows the block). The fallbacks are for a state that never
// went through the nav read: the file's saved record below, or a view-like
// object a test feeds in.
export function describeNavEntry(
	entry: NavHistoryEntry,
	hasFile: (path: string) => boolean,
	savedPosition?: (path: string) => EphemeralState | undefined,
	mtimeOf?: (path: string) => number | undefined,
): NavEntryDescription {
	if (entry.kind === 'view') {
		return {
			name: t('navHistory.graphView'),
			type: t('navHistory.type.graph'),
			missing: false,
		};
	}
	// Jump type from the entry kind; a keyless visit is an open by default,
	// a tab/pane activation when tagged (via: 'switch'), and an open that came
	// from clicking a link when tagged (via: 'link'). A teleport is its own
	// kind (an inferred move, not a deliberate jump).
	let type: string;
	let plainOpen = false;
	if (entry.kind === 'jump') {
		if (entry.key.startsWith('outline:'))
			type = t('navHistory.type.outline');
		else
			type = t('navHistory.type.link');
	} else if (entry.kind === 'teleport') {
		type = t('navHistory.type.teleport');
	} else if (entry.via === 'switch') {
		type = t('navHistory.type.switch');
	} else if (entry.via === 'link') {
		type = t('navHistory.type.link');
	} else {
		type = t('navHistory.type.open');
		plainOpen = true;
	}
	const st = entry.st;
	// The landing is READ, not derived: the capture recorded the block with the
	// landing line marked (contextAt) — the choice it made from the view mode
	// and the cursor's visibility (see navDisplayFields). Without a block (a
	// state that never went through the nav read: the position record below, or
	// a view-like object a test feeds in) the viewport top is the honest guess,
	// then the cursor.
	const recorded = recordedLanding(entry);
	let n: number | undefined;
	let anchor: string | undefined;
	if (st) {
		n = recorded?.line;
		anchor = recorded?.text;
	} else {
		// The entry itself carries no position (a tab/pane activation
		// predating the leave-refresh, or a legacy persisted entry): fall
		// back to the file's saved record — the spot a reopen would restore,
		// which is exactly this step's "where I was". The record has no
		// anchor text, so the row shows the line number only.
		const saved = savedPosition?.(entry.path);
		n = saved?.cursor?.from.line ?? saved?.scroll;
		if (n === undefined && entry.kind === 'teleport')
			// A landing that never settled: the recorded target line is
			// still where the restore will aim.
			n = entry.line;
	}
	const missing = !hasFile(entry.path);
	// Recorded-then-written: the live mtime no longer matches the one stamped
	// into the entry, so the landing text this browser shows and searches may
	// be gone. Only decidable for an entry that recorded an mtime; a file
	// Obsidian cannot stat reads as unchanged.
	const live = mtimeOf?.(entry.path);
	return {
		name: baseName(entry.path),
		type,
		plainOpen,
		line: n !== undefined ? `L${n + 1}` : undefined,
		lineIndex: n,
		lineCount: st?.lineCount,
		stale: !missing && st?.mtime !== undefined && live !== undefined && live !== st.mtime,
		anchor,
		missing,
		soft: entry.kind === 'teleport',
		viaName: entry.kind === 'visit' && entry.viaPath ? baseName(entry.viaPath) : undefined,
		viaText: entry.kind === 'visit' ? entry.viaText : undefined,
	};
}

// The section chain a landing sits in, built from the file's PARSED headings
// (metadataCache) rather than from its text: a row needs its section without —
// and long before — the preview's file read. Obsidian's own parser is what
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
// the heading the landing line itself carries: a row prints no landing text (the
// preview panel does), so that heading is the last, most specific level the row
// can name — dropping it left the row naming its PARENT section instead.
export function rowTrail(trail: string[], depth = 2): string[] {
	return trail.slice(-depth);
}
