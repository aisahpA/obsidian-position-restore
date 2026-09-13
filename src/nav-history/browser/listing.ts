// The list's pure bookkeeping: which steps collapse into one row, which ones a
// query or a file scope keeps, what the scope picker offers, and how the stack
// splits into the two chronological segments. No DOM — the search box and the
// picker are testable through these predicates alone.

import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { baseName } from './model';

// One displayed row: the stack indices it merges (newest first). A row is
// either a single entry or several entries that landed on the same place.
export interface NavEntryRow {
	indices: number[];
}

// Merge entries (newest-first stack indices) by landing position: the same
// place becomes one row carrying ×N. This is what keeps a long session's list
// scannable — bouncing between a note and its reference re-lands on the same
// spot over and over, and twenty identical rows say nothing the first one did
// not. Entries with no landing (landing() returns undefined — no recorded
// position) never merge; each keeps its own row.
export function mergeByLanding(
	indices: number[],
	landing: (index: number) => string | undefined,
): NavEntryRow[] {
	const rows: NavEntryRow[] = [];
	const byLanding = new Map<string, NavEntryRow>();
	for (const index of indices) {
		const key = landing(index);
		const existing = key !== undefined ? byLanding.get(key) : undefined;
		if (existing) {
			existing.indices.push(index);
			continue;
		}
		const row = { indices: [index] };
		if (key !== undefined)
			byLanding.set(key, row);
		rows.push(row);
	}
	return rows;
}

// Pure filter predicate for the search box: every whitespace-separated token
// must appear (case-insensitive) in the entry's own fields — file name, full
// path, and the landing/cursor anchor text. Reads the entry directly, never
// the DOM, so the browser's search is testable without a DOM.
export function matchesNavFilter(entry: NavHistoryEntry, query: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0)
		return true;
	let hay: string;
	if (entry.kind === 'view') {
		hay = `${entry.viewType} ${t('navHistory.graphView')}`;
	} else {
		const base = baseName(entry.path);
		hay = `${base} ${entry.path} ${entry.st?.anchor ?? ''} ${entry.st?.cursorAnchor ?? ''}`;
	}
	hay = hay.toLowerCase();
	return tokens.every(tok => hay.includes(tok));
}

// The file-scope filter (the picker's predicate): does the entry sit in the
// file the scope names? `path` is that file's path, or undefined for "all
// files" — then the scope is inert and lets everything through, so a stale
// choice can never blank the list. A view entry has no path, so it never
// matches a narrowed scope: the scope answers "where else in THIS note was I",
// and a graph step is not a place in a note.
export function inFileScope(entry: NavHistoryEntry, path: string | undefined): boolean {
	if (path === undefined)
		return true;
	return entry.kind !== 'view' && entry.path === path;
}

// One item of the scope picker: a note the history has been in, and how much of
// the history sits there. The count is STEPS, the unit the segment headers
// count in (see renderChronological) — it is what decides whether narrowing to
// this note is worth losing the rest of the list.
export interface HistoryFileOption {
	path: string;
	// What the item says: the last segment, exactly as a row names it.
	name: string;
	// The parent folder, set ONLY for a name that another option shares — two
	// notes called "index" in different folders are otherwise one item, and the
	// choice between them could not be made. Sparse rather than always-on
	// because the folder is long, faint, and usually the same on every item.
	folder?: string;
	count: number;
}

// The distinct files the history has been in. View entries (the graph) have no
// path and are skipped, as they are by every other file-scoped question (see
// inFileScope). Pure: what the picker offers is testable without a DOM.
export function historyFileOptions(entries: NavHistoryEntry[]): HistoryFileOption[] {
	const byPath = new Map<string, HistoryFileOption>();
	for (const entry of entries) {
		if (entry.kind === 'view')
			continue;
		const seen = byPath.get(entry.path);
		if (seen)
			seen.count++;
		else
			byPath.set(entry.path, { path: entry.path, name: baseName(entry.path), count: 1 });
	}
	const out = Array.from(byPath.values());
	// By NAME, not by recency. The panel answers "recently" twice already: the
	// pinned card and the direct "only this note" switch cover the note you are
	// in, and the list underneath is chronological with an age on every row. So
	// what is left for a picker is "the note called X" — a lookup, and a lookup
	// wants a position it can be found at TWICE, not a rank that moves every
	// time the note is visited. Alphabetical is also the one index the list
	// itself never shows. Folder order breaks a tie between same-named notes,
	// which are exactly the ones whose folders are on screen.
	out.sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
		|| a.path.localeCompare(b.path));
	const names = new Map<string, number>();
	for (const o of out)
		names.set(o.name, (names.get(o.name) ?? 0) + 1);
	for (const o of out) {
		if ((names.get(o.name) ?? 0) > 1) {
			const cut = o.path.lastIndexOf('/');
			o.folder = cut === -1 ? '/' : o.path.slice(0, cut);
		}
	}
	return out;
}

// A row's time label. This is the browser's PRIMARY index: a user recalls
// "the spot from a few minutes ago", not "three steps back" — which is why
// the old ±N step counter is gone. Beyond a week an absolute date is more
// useful than an ever-growing day count. Pure (now comes in) for testing.
export function formatRelativeTime(stamp: number, now: number = Date.now()): string {
	const minutes = Math.floor(Math.max(0, now - stamp) / 60000);
	if (minutes < 1)
		return t('navHistory.time.now');
	if (minutes < 60)
		return t('navHistory.time.minutes', minutes);
	const hours = Math.floor(minutes / 60);
	if (hours < 24)
		return t('navHistory.time.hours', hours);
	const days = Math.floor(hours / 24);
	if (days < 7)
		return t('navHistory.time.days', days);
	const d = new Date(stamp);
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

// The current entry is rendered as a pinned card, never as a list row, so the
// rest of the stack splits into the two directions around it: indices above
// the current entry are the FORWARD history, below it the BACK history. Both
// come back newest-first (what a user scans for). `keep` applies the filter.
export interface NavHistorySegments {
	forward: number[];
	back: number[];
}

export function splitHistorySegments(
	entries: NavHistoryEntry[],
	currentIndex: number,
	keep: (index: number) => boolean = () => true,
): NavHistorySegments {
	const forward: number[] = [];
	const back: number[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		if (i === currentIndex || !keep(i))
			continue;
		(i > currentIndex ? forward : back).push(i);
	}
	return { forward, back };
}
