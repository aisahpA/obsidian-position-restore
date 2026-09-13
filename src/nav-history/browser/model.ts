// The history browser's pure model layer: what a row SAYS (its display pieces,
// its heading chain) derived from an entry, with the vault lookup coming in as a
// predicate. No DOM and no `this` — every function here is testable on its own.

import { NavHistoryEntry } from '../entry';
import { EphemeralState } from '../../types';
import { t } from '../../i18n';

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
	anchor?: string;
	missing: boolean;
	// An inferred entry (NavTeleport): the user did not deliberately jump
	// there — the badge renders dimmed to signal lower confidence.
	soft?: boolean;
}

// Which line a step lands on, and the text that goes with it (the row shows the
// number, the preview shows the text): a reading capture lands on the viewport
// top line (its remap anchor), an edit
// capture lands on the cursor line (its cursorAnchor — never the viewport
// top text, a different line; missing for blank cursor lines and legacy
// entries). An edit capture whose cursor sat OUTSIDE the viewport
// (cursorOffscreen — source-mode scrolling leaves the cursor behind) falls
// back to the viewport top line + anchor: the restore lands on the viewport,
// so that is where the user actually was. Line number semantics by capture
// mode (see NavEntryState.mode): a reading capture carries the editor's
// stale pre-preview cursor, so only the recorded mode disambiguates —
// pre-upgrade entries (no mode) fall back to the cursor-first heuristic.
export function describeNavEntry(
	entry: NavHistoryEntry,
	hasFile: (path: string) => boolean,
	savedPosition?: (path: string) => EphemeralState | undefined,
): NavEntryDescription {
	if (entry.kind === 'view') {
		return {
			file: t('navHistory.graphView'),
			title: entry.viewType,
			type: t('navHistory.type.graph'),
			missing: false,
		};
	}
	// Jump type from the entry kind; a keyless visit is an open by default
	// and a tab/pane activation when tagged (via: 'switch'). A teleport is
	// its own kind (an inferred move, not a deliberate jump).
	let type: string;
	if (entry.kind === 'jump') {
		if (entry.key.startsWith('outline:'))
			type = t('navHistory.type.outline');
		else
			type = t('navHistory.type.link');
	} else if (entry.kind === 'teleport') {
		type = t('navHistory.type.teleport');
	} else {
		type = entry.via === 'switch' ? t('navHistory.type.switch') : t('navHistory.type.open');
	}
	const st = entry.st;
	let n: number | undefined;
	let anchor: string | undefined;
	if (st) {
		if (st.mode === 'preview') {
			n = st.scroll;
			anchor = st.anchor;
		} else if (st.cursor && !st.cursorOffscreen) {
			n = st.cursor.from.line;
			anchor = st.cursorAnchor;
		} else {
			n = st.scroll;
			anchor = st.anchor;
		}
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
	return {
		file: baseName(entry.path),
		title: entry.path,
		type,
		line: n !== undefined ? `L${n + 1}` : undefined,
		lineIndex: n,
		anchor,
		missing: !hasFile(entry.path),
		soft: entry.kind === 'teleport',
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

// The chain as a ROW prints it: the deepest `depth` levels only (a row has one
// line of width), with the heading the landing line itself carries dropped —
// the row already quotes that text, so naming the section too would say the
// same thing twice.
export function rowTrail(trail: string[], landingText: string | undefined, depth = 2): string[] {
	const out = trail.slice();
	if (landingText !== undefined && out.length) {
		const line = normalizeHeadingText(landingText);
		if (line && normalizeHeadingText(out[out.length - 1]) === line)
			out.pop();
	}
	return out.slice(-depth);
}

function normalizeHeadingText(text: string): string {
	return text
		.replace(/^#{1,6}\s*/, '')
		.replace(/#+\s*$/, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}
