// The list's pure bookkeeping: how the filtered steps group into notes and
// which ones the search box keeps. No DOM — the search box is testable through
// these predicates alone.

import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { LANDING_MERGE_LINES } from './constants';
import { baseName } from './model';

// What one row of the list stands for under the 'all' setting: the span of lines a
// cluster of nearby landings covers, and how many landings went into it. The span is
// the row's SCOPE, not its coordinate: the row PRINTS the representative's own line —
// the one the click opens — and keeps this span as its tooltip, so the reader can see
// what was folded without the label promising a line the row will not land on. Drawn
// from the members themselves, so the scope and the set of steps it folds are the
// same fact (see landingKey).
export interface ClusterSpan {
	// The lowest and highest line the cluster covers, as the rows' own lines (0-based
	// as recorded; the row adds one). Both undefined for a cluster with no coordinate
	// at all — a `.base`, an image, a step whose position never resolved.
	from?: number;
	to?: number;
	// How many distinct landings the cluster folds. One means the row is an ordinary
	// spot and prints its whole story; more means it prints a range.
	count: number;
}

// One FILE on the list: the note, and the steps that landed in it (by line,
// ascending — see groupByFile). The list is one of these per note — which is what
// makes a note opened ten times one row instead of ten, and what gives a
// same-named note somewhere to say which folder it is in — and under the 'all'
// setting its landings are printed beneath it (see NavHistoryList.shownLandings).
// A pathless view step (the graph) is a group of its own with no path and never
// more than one step.
//
// The landings under a note are SPOTS, not steps (see landingKey): a note
// returned to at the same line five times has one row to pick, however many
// times and however differently it was got to. What is under a note is then
// "where in it I can go", which is the question its row is opened to answer;
// the chronological account of how often it was visited is what the count used
// to carry and no longer needs to.
//
// AND NEARBY SPOTS ARE ONE SPOT (see LANDING_MERGE_LINES): a note the reader
// scrolled through leaves a trail of landings a few lines apart, and printing each
// of them is a wall of rows whose numbers all look alike. The trail is clustered
// into the places a reader can tell apart, and a cluster is one row.
export interface NavFileGroup {
	// The note's path. NO_PATH for a pathless group, which also cannot collide
	// with a real path (a vault path is never empty).
	path: string;
	// The group's IDENTITY (see groupKey): its path, or the view type for a
	// pathless one. Carried on the group because the key a pathless group is
	// named by cannot be recovered from `path` — NO_PATH says a group is
	// pathless, never WHICH view it is — and because a caller that wants to hold
	// the list's order still (see groupByFile's `order`) has nothing else stable
	// to hold: indices are the list's current shape, and the path is not the key.
	key: string;
	// Stack indices of the note's landings, top of the note first: by line,
	// ascending (see the sort in groupByFile). Each one is a CLUSTER's
	// representative — the newest step among the nearby landings it folds — and
	// stands for every step that landed in that place. Every one of them is a
	// DESTINATION: a note whose file is gone is not grouped at all (see the `keep`
	// filter in NavHistoryList.render), so a row on screen always has somewhere to go.
	indices: number[];
	// The note's OWN record — the place that stands for the file rather than for
	// a spot inside it (see places.ts), i.e. the `visit` (or the `view`) the
	// group was opened by. The file's row IS this record: it opens the file the
	// plain way, and its line (when the panel prints one) is the line a plain
	// open will land on. It is deliberately NOT one of `indices`: a note's own
	// record is not a landing to list under the note, it IS the note.
	anchor?: number;
	// The current entry's own group: pinned to the top of the list, so "you are
	// here" is a place in the same list.
	current: boolean;
	// What each cluster covers, keyed by its representative: the row's own scope,
	// which it carries as its tooltip (see ClusterSpan).
	spans: Map<number, ClusterSpan>;
	// The representative whose cluster holds the CURRENT entry, when one of them
	// does. It is what "here" means once several spots are one row: the entry itself
	// may be a member the cluster does not stand for. The row is still a destination
	// — clicking it re-lands that place, closed tab and all (see
	// NavHistoryList.targetOf).
	currentRep?: number;
}

// How much of one note the list prints (see the type's own note in types.ts, the
// module that also holds the settings record it is stored in). Re-exported here
// because the browser's modules have always taken it from this one.
export type { LandingsMode } from '@/types';

// The path a pathless group (the graph) carries. A view step is not a place in
// a note: it has no path to group by, and giving it one would let it merge with
// a note of the same name.
export const NO_PATH = '';

// The key a group is identified by: its path, or the view type for a pathless
// view step — two graph steps are two landings of the same "file" (the graph
// tab), not two files.
function groupKey(entry: NavHistoryEntry): string {
	return entry.kind === 'view' ? `view:${entry.viewType}` : entry.path;
}

// The key that makes two steps ONE landing: the line they landed on. How the
// step was made (a link, the outline, a tab switch, a scroll that settled) is
// not part of where it is, so a note the reader returned to at L412 five times
// — by five different routes — holds one spot, not five rows that read
// identically and travel to the same place.
//
// A step that recorded NO line gets the one `none` key, and that is not a guess: a
// file without coordinates — a `.base` view, a PDF, an image, a canvas — has exactly
// one place to be, and so does a markdown step whose position could not be resolved.
// Leaving them unkeyed (which is what this did) made every visit its own landing:
// opening one `.base` five times put five identical "—" rows under its name, each of
// them the same destination. Where there is no coordinate there is no way to tell two
// spots apart, so they are one.
//
// A VIEW step gets the one constant key: a group of them holds a single
// destination, so the row that opens onto it is "the graph tab" rather than a list
// of identical graph steps.
const NO_LINE = 'none';

function landingKey(entry: NavHistoryEntry, line: number | undefined): string {
	if (entry.kind === 'view')
		return 'view';
	return line === undefined ? NO_LINE : `L${line}`;
}

// The filtered steps as one group per note. Groups come out by the recency of
// their NEWEST step — what a reader scanning for "where was I" expects, and the
// order the flat chronological list had — except the current entry's group,
// which is pinned first (unless `order` holds the list still; see below). INSIDE
// a group the order is the note's own: by line,
// ascending, with the spots close enough to be one place already CLUSTERED into
// one row (see LANDING_MERGE_LINES). `keep` applies the filter (a dropped step is
// not on screen, so its note may disappear with it) — and the caller's filter is
// where a note whose FILE is gone is dropped too: this module groups and orders,
// and a group it never hears about is a group it never draws.
//
// `lineOf` resolves the line a step landed on, which is what makes two steps the
// same spot (see landingKey) and what decides whether two of them are NEARBY. It
// is INJECTED rather than read off the entry because the line a row prints is not
// always the entry's own: a step recorded before the block was captured falls back
// to the file's saved position, and only the caller can ask for that (see
// NavHistoryReads.describe). Whatever the caller passes must be the same number
// the row shows, or the list would collapse steps the reader can still see apart —
// and now also cluster rows the reader can see the numbers of. The default — no
// line at all — keeps every step, so a caller that does not care is never
// surprised.
//
// The order is the caller's to HOLD, not to choose: `order` says which group
// keys go where (see its own note). It is a list of keys rather than of indices
// because this function's group order is derived afresh every time, while a key
// names the same note before and after the places move under it.
export function groupByFile(
	entries: NavHistoryEntry[],
	currentIndex: number,
	keep: (index: number) => boolean = () => true,
	lineOf: (index: number) => number | undefined = () => undefined,
	// The group order to hold the list at, by group key (see NavFileGroup.key).
	// undefined orders by recency, which is what the list does whenever nobody is
	// looking at it. A caller that passes one is saying "the reader is USING this
	// list": the order they are reading is then not the model's to change, so the
	// current group is not pulled to the front and groups keep the places they
	// were given (see NavHistoryListOptions.order).
	order?: readonly string[],
): NavFileGroup[] {
	const groups = new Map<string, NavFileGroup>();
	// Per group, the landing each kept step stands for → its slot in the group's
	// landings: what a later step with the same landing is compared against.
	const seen = new Map<string, Map<string, number>>();
	// The distinct landings of a note as the reverse scan meets them — newest step
	// first, which is the order a cluster's representative is chosen in.
	const found = new Map<string, { line: number | undefined; index: number }[]>();
	const open = (entry: NavHistoryEntry): NavFileGroup => {
		const key = groupKey(entry);
		let group = groups.get(key);
		if (!group) {
			group = {
				path: entry.kind === 'view' ? NO_PATH : entry.path,
				key,
				indices: [],
				current: false,
				spans: new Map(),
			};
			groups.set(key, group);
			seen.set(key, new Map());
			found.set(key, []);
		}
		return group;
	};
	// Reverse order: the first time a note is seen is its newest surviving step,
	// and Map insertion order preserves exactly that as the group order. The
	// CURRENT entry is included with the rest: the list pins its note first and
	// marks the landing that holds it (the ● of .nav-row-here) instead of
	// holding it out of the list, so a note that was only ever opened once still
	// has a row to name.
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!keep(i))
			continue;
		const entry = entries[i];
		const key = groupKey(entry);
		const group = open(entry);
		// The note's own record names the FILE rather than a spot inside it, so it
		// becomes the group's ANCHOR (see `anchor`) and adds NO landing. What is
		// listed under a note is the jumps the reader made inside it, and a row
		// standing for the file's own record would be a row whose click opens the
		// file the reader is already in — i.e. a row that visibly does nothing
		// (see list.ts's activeRep, and places.travel: a FILE place opens plainly).
		// The record still marks the group as the CURRENT one: the reader standing
		// in this note is standing on the file, whether or not they jumped inside it.
		if (entry.kind === 'visit' || entry.kind === 'view') {
			if (group.anchor === undefined)
				group.anchor = i;
			if (i === currentIndex)
				group.current = true;
			continue;
		}
		const line = lineOf(i);
		const landing = landingKey(entry, line);
		const at = seen.get(key)?.get(landing);
		const landings = found.get(key)!;
		if (at !== undefined) {
			// Already on the list: the step adds no destination. It is still the
			// step the reader is ON when it is the current entry, whose own
			// landing has to be the one drawn as "here" (the newer step in that
			// slot is the same place, and the marker is the only difference).
			if (i === currentIndex) {
				landings[at].index = i;
				group.current = true;
			}
			continue;
		}
		seen.get(key)?.set(landing, landings.length);
		landings.push({ line, index: i });
		if (i === currentIndex)
			group.current = true;
	}
	// Under one note the rows come out by LINE, ascending — the order of the
	// document they are places in. Between notes recency still decides (a note is
	// a "where was I", and time answers that), but INSIDE one nothing is learned
	// from the order the spots were visited in: what the reader is doing is
	// looking for a place in a text, and a text runs from line 1 down. A step with
	// no recorded line cannot be placed in that order at all: it keeps its recency
	// order at the END of its note's list, where the rows with no coordinate have
	// always stood — and being alone there, it comes out a cluster of its own.
	//
	// …and the sorted landings are then CLUSTERED (see LANDING_MERGE_LINES): a
	// landing opens a new cluster the moment it sits more than the window below
	// the cluster's HEAD. Measured from the head and not from the previous line,
	// so a dense run of steps cannot chain one cluster across a whole section: a
	// cluster is never wider than the window. Each cluster becomes one row,
	// represented by its NEWEST step — "the last spot the reader was at in that
	// place", the same answer the note's own row gives (see
	// NavHistoryList.activeRep) — so the line the row prints IS the line it opens,
	// and the span it covers rides along as its tooltip (see ClusterSpan).
	const rank = (line: number | undefined) => line === undefined ? Number.MAX_SAFE_INTEGER : line;
	for (const [key, group] of groups) {
		const landings = found.get(key)!;
		landings.sort((a, b) => rank(a.line) - rank(b.line));
		let members: { line: number | undefined; index: number }[] = [];
		let head: number | undefined;
		const close = () => {
			if (!members.length)
				return;
			const newest = members.reduce((a, b) => (a.index > b.index ? a : b));
			const lines = members.map(m => m.line).filter((l): l is number => l !== undefined);
			group.indices.push(newest.index);
			group.spans.set(newest.index, {
				from: lines.length ? Math.min(...lines) : undefined,
				to: lines.length ? Math.max(...lines) : undefined,
				count: members.length,
			});
			if (members.some(m => m.index === currentIndex))
				group.currentRep = newest.index;
			members = [];
		};
		for (const landing of landings) {
			if (members.length && (landing.line === undefined || head === undefined
				|| landing.line - head > LANDING_MERGE_LINES))
				close();
			if (!members.length)
				head = landing.line;
			members.push(landing);
		}
		close();
	}
	// The current note reaches the list by the same scan as every other note: its
	// own step has to survive `keep` — a note the query dropped is not this list's
	// business, current or not, and neither is a note whose file is gone, not even
	// the one the reader is standing in (the list has no row for a name it cannot
	// open; the gap is not worth a dead row). The `!groups.has` guard is only a
	// fallback for a current entry the scan somehow never opened.
	const current = entries[currentIndex];
	if (current && keep(currentIndex) && !groups.has(groupKey(current)))
		open(current).current = true;
	const out = Array.from(groups.values());
	if (!order) {
		// Recency decides: the current entry's group is pinned first, so "you are
		// here" is a place in the same list.
		const here = out.findIndex(g => g.current);
		if (here > 0)
			out.unshift(out.splice(here, 1)[0]);
	} else {
		// The order the reader is looking at, held still. Two things it
		// deliberately does NOT do:
		//
		//  - It does not pull the current group to the front. That pin is exactly
		//    what a click would otherwise drag the list around with: the reader
		//    clicks row 3, the places list moves that note to the end, and the pin
		//    would answer by flinging it to row 1. The "you are here" MARK still
		//    moves to the row that was clicked (it is painted per row, see
		//    list.ts); only the rows stay put.
		//
		//  - It does not know about groups the order has never heard of. Those are
		//    places that appeared since the order was taken, which by recency are
		//    the NEWEST ones, so they take rank -1 and land at the front. The sort
		//    is stable, so they keep their own recency order among themselves, and
		//    the groups that DO have a rank keep the order they were given.
		const rank = new Map(order.map((k, i): [string, number] => [k, i]));
		out.sort((a, b) => (rank.get(a.key) ?? -1) - (rank.get(b.key) ?? -1));
	}
	// A pathless group sits at the END, after every note: it is not a place in a
	// note, so it does not compete with them for the reader's scan order. This is
	// a rendering invariant rather than an ordering preference — it holds under
	// either branch above, and so it is applied last, unconditionally.
	const pathless = out.findIndex(g => g.path === NO_PATH);
	if (pathless !== -1 && pathless !== out.length - 1)
		out.push(out.splice(pathless, 1)[0]);
	return out;
}

// Pure filter predicate for the search box: every whitespace-separated token
// must appear (case-insensitive) somewhere in the entry's searchable text.
// Two sources, composed here because only the caller knows both:
//   - the entry's OWN text (navSearchText: file name, path, the recorded
//     landing context block, the legacy anchors, and the jump's key / link
//     origin), and
//   - `extra`, everything the caller derives from the VAULT rather than from the
//     entry: what the row prints (the section chain and the line label) and the
//     other names the file goes by (see reads.ts's aliasesFor).
// Reads no DOM, so the browser's search is testable without one.
//
// "Everything a match can hit is on the row" is NOT the rule, and never quite was
// (the landing context block has no panel left to print it, and a link's origin is
// nowhere on screen): a hit is text the READER could have written about that file,
// which is what the extra sources have in common. An alias is the clearest case of
// that — it is another name for the file, and finding a note by a name the reader
// half-remembers is the whole reason a search box is here.
export function matchesNavFilter(entry: NavHistoryEntry, query: string, extra?: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0)
		return true;
	const hay = `${navSearchText(entry)} ${extra ?? ''}`.toLowerCase();
	return tokens.every(tok => hay.includes(tok));
}

// The entry's own searchable text: name and path, the recorded context block,
// and the remap anchor on top (it belongs to the viewport's top line, which the
// block — built around the landing — does not always reach). The block is the
// part that says what the step WAS, the lines the user was looking at when they
// left, while the name and path only say where; all of it is joined into one
// haystack, so the order of the parts carries nothing.
export function navSearchText(entry: NavHistoryEntry): string {
	if (entry.kind === 'view')
		return `${entry.viewType} ${t('navHistory.graphView')}`;
	const parts = [baseName(entry.path), entry.path];
	const st = entry.st;
	if (st) {
		for (const line of st.context ?? [])
			parts.push(line.text);
		parts.push(st.anchor ?? '');
	}
	// The jump's key: for an outline click the heading's text, for an anchor
	// link the target the user picked (`Note#heading`, `^block`). It is the
	// user's own click vocabulary — and the one form a rename cannot fix —
	// but a caller target's synthetic `caller:<ms>` key is a timestamp, not
	// words, so it is dropped.
	if (entry.kind === 'jump' && !entry.key.startsWith('caller:'))
		parts.push(entry.key.startsWith('outline:') ? entry.key.slice('outline:'.length) : entry.key);
	// Where a plain link came from, and what it said (see NavVisit.viaPath).
	if (entry.kind === 'visit') {
		if (entry.viaPath)
			parts.push(baseName(entry.viaPath));
		if (entry.viaText)
			parts.push(entry.viaText);
	}
	return parts.filter(Boolean).join(' ');
}
