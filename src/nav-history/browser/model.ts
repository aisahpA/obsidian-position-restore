// The history browser's pure model layer: what a row SAYS (its display pieces,
// its heading chain) derived from an entry, with the vault lookup coming in as a
// predicate. No DOM and no `this` — every function here is testable on its own.

import { NavHistoryEntry } from '@/nav-history/entry';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';

// The display name of a path: its last segment. What a row labels itself with,
// and what the file-scope chip names (the full path is the row's hover title).
export function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

// One row's display pieces, derived from the entry. Pure (the vault lookup
// comes in as a predicate) so the history browser's labels are testable
// without a DOM.
export interface NavEntryDescription {
	file: string;
	title: string;
	type: string;
	line?: string;
	// The same landing line as a 0-based index (what the preview window reads,
	// and where `line` is computed from). `line` is the display form: "L412".
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

// Which line a step lands on, and the text that goes with it (the row shows the
// number, the panel shows the block): both come straight out of the capture's
// recorded context block, where `contextAt` already names the landing — the
// capture decided it from the view mode and the cursor's visibility, which is
// geometry no later reader can reconstruct (see capture/ephemeral.ts). The
// fallbacks are for a state that never went through that read: the file's
// saved record below, or a view-like object a test feeds in.
export function describeNavEntry(
	entry: NavHistoryEntry,
	hasFile: (path: string) => boolean,
	savedPosition?: (path: string) => EphemeralState | undefined,
	mtimeOf?: (path: string) => number | undefined,
): NavEntryDescription {
	if (entry.kind === 'view') {
		return {
			file: t('navHistory.graphView'),
			title: entry.viewType,
			type: t('navHistory.type.graph'),
			missing: false,
		};
	}
	// Jump type from the entry kind; a keyless visit is an open by default,
	// a tab/pane activation when tagged (via: 'switch'), and an open that came
	// from clicking a link when tagged (via: 'link'). A teleport is its own
	// kind (an inferred move, not a deliberate jump).
	let type: string;
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
	}
	const st = entry.st;
	// The landing is READ, not derived: the capture recorded the block with the
	// landing line marked (contextAt) — the choice it made from the view mode
	// and the cursor's visibility (see navDisplayFields). Without a block (a
	// state that never went through the nav read: the position record below, or
	// a view-like object a test feeds in) the viewport top is the honest guess,
	// then the cursor.
	const landing = st?.context?.[st.contextAt ?? -1];
	let n: number | undefined;
	let anchor: string | undefined;
	if (st) {
		n = landing?.line ?? st.scroll ?? st.cursor?.from.line;
		anchor = landing?.text || undefined;
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
		file: baseName(entry.path),
		title: entry.path,
		type,
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
