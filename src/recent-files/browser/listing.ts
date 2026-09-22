// The list's pure bookkeeping: how the filtered steps group into notes and
// which ones the search box keeps. No DOM — the search box is testable through
// these predicates alone.

import { NavEntry, navGroupKey } from '@/nav/entry';
import { baseName, viewName } from './model';

// One FILE on the list: the note, and the steps that landed in it (by line,
// ascending — see groupByFile). The list is one of these per note — which is what
// makes a note opened ten times one row instead of ten, and what gives a
// same-named note somewhere to say which folder it is in — and under the 'all'
// setting its landings are printed beneath it (see RecentFilesList.shownLandings).
// A pathless view step (the graph, Thino's memo list) is a group of its own with
// no path and never more than one landing.
//
// The landings under a note are SPOTS, not steps (see landingKey): a note
// returned to at the same line five times has one row to pick, however many
// times and however differently it was got to. What is under a note is then
// "where in it I can go", which is the question its row is opened to answer;
// the chronological account of how often it was visited is what the count used
// to carry and no longer needs to.
//
// …AND EVERY SPOT IS A ROW. Nearby spots used to be FOLDED into one row (a
// LANDING_MERGE_LINES window, since removed). What that folding cost is what
// removed it: the row printed ONE member's line, so its other members became
// unreachable — a row can only land on the line it prints — the fold was
// invisible once the row stopped printing the range, and the "you are here" dot
// could sit on a row whose line was not where the reader was. A spot ten lines
// from another is a different place to go, and 'all' is the reader asking for
// every one of them.
export interface NavFileGroup {
	// The note's path. NO_PATH for a pathless group, which also cannot collide
	// with a real path (a vault path is never empty).
	path: string;
	// The group's IDENTITY (see nav/entry.ts's navGroupKey): its path, or the view
	// type for a
	// pathless one. Carried on the group because the key a pathless group is
	// named by cannot be recovered from `path` — NO_PATH says a group is
	// pathless, never WHICH view it is; what such a group PRINTS is the view's own
	// label, which is a separate thing again (see model.ts's viewName). Carried
	// because a caller that wants to hold the list's order still (see
	// groupByFile's `order`) has nothing else stable to hold: indices are the
	// list's current shape, and the path is not the key.
	key: string;
	// Stack indices of the note's landings, top of the note first: by line,
	// ascending (see the sort in groupByFile). One entry per distinct line the note
	// holds, standing for the NEWEST step that landed on it (the last place the
	// reader was in that line) — or for the reader's own step where the CURRENT
	// entry shares the line (see currentRep). Every one of them is a DESTINATION: a
	// note whose file is gone is not grouped at all (see the `keep` filter in
	// RecentFilesList.render), so a row on screen always has somewhere to go.
	indices: number[];
	// The note's OWN record — the place that stands for the file rather than for
	// a spot inside it (see places.ts), i.e. the `visit` (or the `view`) the
	// group was opened by. The file's row IS this record: it opens the file the
	// plain way, and its line (when the panel prints one) is the line a plain
	// open will land on. It is deliberately NOT one of `indices`: a note's own
	// record is not a landing to list under the note, it IS the note.
	anchor?: number;
	// The current entry's own group — the one whose row carries the "you are here"
	// mark. Deliberately NOT an ordering fact: the list is in recency order
	// whatever the reader happens to be standing in (see groupByFile), so this
	// says where to paint the mark and nothing about where the group sits.
	current: boolean;
	// The landing that holds the CURRENT entry — the row that carries the "you are
	// here" dot (see list.ts's placeRow). Undefined when the reader is standing in
	// the note but on no listed landing: their own record is the note's ANCHOR, and
	// a dot on the note's row would say what `current` already says.
	currentRep?: number;
}

// How much of one note the list prints (see the type's own note in types.ts, the
// module that also holds the settings record it is stored in). Re-exported here
// because the browser's modules have always taken it from this one.
export type { LandingsMode } from '@/types';

// The path a pathless group (a view — the graph, Thino's memo list) carries. A
// view step is not a place in a note: it has no path to group by, and giving it
// one would let it merge with a note of the same name.
export const NO_PATH = '';

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
// of identical graph steps. (Two Thino tabs collapse the same way: a view holds
// one destination however many leaves are showing it.)
const NO_LINE = 'none';

function landingKey(entry: NavEntry, line: number | undefined): string {
	if (entry.kind === 'view')
		return 'view';
	return line === undefined ? NO_LINE : `L${line}`;
}

// The filtered steps as one group per note. Groups come out by the recency of
// their NEWEST step — what a reader scanning for "where was I" expects, and the
// order the flat chronological list had. That includes a VIEW group (the graph):
// it is a place the reader went to, and a destination parked at the foot of the
// list is one nobody scans — "last" and "nowhere" read the same, and a view's own
// time is a fact the list is holding. INSIDE a group the order is the note's own:
// by line, ascending, every distinct line a row of its own. `keep` applies the
// filter (a dropped step is not on screen, so its note may disappear with it) —
// and the caller's filter is where a note whose FILE is gone is dropped too: this
// module groups and orders, and a group it never hears about is a group it never
// draws.
//
// `lineOf` resolves the line a step landed on, which is what makes two steps the
// same spot (see landingKey). It is INJECTED rather than read off the entry
// because the line a row prints is not always the entry's own: a step recorded
// before the block was captured falls back to the file's saved position, and only
// the caller can ask for that (see RecentFilesReads.describe). Whatever the caller
// passes must be the same number the row shows, or the list would collapse steps
// the reader can still see apart. The default — no line at all — keeps every
// step, so a caller that does not care is never surprised.
//
// The order is the caller's to HOLD, not to choose: `order` says which group
// keys go where (see its own note). It is a list of keys rather than of indices
// because this function's group order is derived afresh every time, while a key
// names the same note before and after the places move under it.
//
// The current entry gets no special place in either order. It is INCLUDED where
// its recency puts it, and the "you are here" dot is painted on the row that
// holds it (see list.ts's placeRow): a list that lifted the reader's note to the
// top would re-arrange itself under the hand that clicked a row — and the one
// note the reader is in is the newest one nearly always anyway.
export function groupByFile(
	entries: NavEntry[],
	currentIndex: number,
	keep: (index: number) => boolean = () => true,
	lineOf: (index: number) => number | undefined = () => undefined,
	// The group order to hold the list at, by group key (see NavFileGroup.key).
	// undefined orders by recency, which is what the list does whenever nobody is
	// looking at it. A caller that passes one is saying "the reader is USING this
	// list": the order they are reading is then not the model's to change, so the
	// groups keep the places they were given (see RecentFilesListOptions.order).
	order?: readonly string[],
): NavFileGroup[] {
	const groups = new Map<string, NavFileGroup>();
	// Per group, the landing each kept step stands for → its slot in the group's
	// landings: what a later step with the same landing is compared against.
	const seen = new Map<string, Map<string, number>>();
	// The distinct landings of a note as the reverse scan meets them — newest step
	// first, which is the order the step standing for each line is chosen in.
	const found = new Map<string, { line: number | undefined; index: number }[]>();
	const open = (entry: NavEntry): NavFileGroup => {
		const key = navGroupKey(entry);
		let group = groups.get(key);
		if (!group) {
			group = {
				path: entry.kind === 'view' ? NO_PATH : entry.path,
				key,
				indices: [],
				current: false,
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
		const key = navGroupKey(entry);
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
	// always stood.
	//
	// Every one of those landings becomes a row — nothing is folded (see
	// NavFileGroup). The step that stands for a line is the one the scan left in its
	// slot: the NEWEST step that landed there, or the reader's own step where the
	// current entry shares the line (see the scan above) — so the line a row prints
	// IS the line its click lands on, and the row that carries the "you are here"
	// dot is the row the reader is really standing on.
	const rank = (line: number | undefined) => line === undefined ? Number.MAX_SAFE_INTEGER : line;
	for (const [key, group] of groups) {
		const landings = found.get(key)!;
		landings.sort((a, b) => rank(a.line) - rank(b.line));
		group.indices = landings.map(l => l.index);
		if (landings.some(l => l.index === currentIndex))
			group.currentRep = currentIndex;
	}
	// The current note reaches the list by the same scan as every other note: its
	// own step has to survive `keep` — a note the query dropped is not this list's
	// business, current or not, and neither is a note whose file is gone, not even
	// the one the reader is standing in (the list has no row for a name it cannot
	// open; the gap is not worth a dead row). The `!groups.has` guard is only a
	// fallback for a current entry the scan somehow never opened — and a group
	// opened here is flagged current only: it takes the place its recency gives
	// it, like every other group.
	const current = entries[currentIndex];
	if (current && keep(currentIndex) && !groups.has(navGroupKey(current)))
		open(current).current = true;
	const out = Array.from(groups.values());
	// Reaching this line `out` is ALREADY the recency order, and nothing else is
	// applied to it: the reverse scan above inserted a group the first time it met
	// one of its steps, and the first step it meets scanning backwards is that
	// group's newest — so the insertion order is newest-first, the current group
	// included. (The graph used to be pushed to the END here, whatever its own
	// time said, and the current group used to be pinned FIRST. Both are gone: a
	// row whose position no longer answers "how recently" is a row the reader
	// cannot read a time off, and "you are here" is a mark on the row, not a
	// place in the order.)
	if (order) {
		// The order the reader is looking at, held still. What it deliberately
		// does NOT know about is groups it has never heard of: those are places
		// that appeared since the order was taken, which by recency are the NEWEST
		// ones, so they take rank -1 and land at the front. The sort is stable, so
		// they keep their own recency order among themselves, and the groups that
		// DO have a rank keep the order they were given.
		const rank = new Map(order.map((k, i): [string, number] => [k, i]));
		out.sort((a, b) => (rank.get(a.key) ?? -1) - (rank.get(b.key) ?? -1));
	}
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
export function matchesNavFilter(entry: NavEntry, query: string, extra?: string): boolean {
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
export function navSearchText(entry: NavEntry): string {
	if (entry.kind === 'view')
		return `${entry.viewType} ${viewName(entry)}`;
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
