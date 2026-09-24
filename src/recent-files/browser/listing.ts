// The list's pure bookkeeping: how the filtered steps group into notes and which ones the search box
// keeps. No DOM — the search box is testable through these predicates alone.

import { NavEntry, navGroupKey } from '@/nav/entry';
import { baseName, viewName } from './model';

// One FILE on the list: the note, and the steps that landed in it (by line, ascending). One per note
// — which is what makes a note opened ten times one row — and under the 'all' setting its landings
// are printed beneath it. A pathless view step is a group of its own with no path.
//
// The landings under a note are SPOTS, not steps (see landingKey): a note returned to at the same
// line five times has one row to pick. Every spot is a row — a spot ten lines from another is a
// different place to go.
export interface NavFileGroup {
	// NO_PATH for a pathless group, which cannot collide with a real path.
	path: string;
	// The group's IDENTITY (nav/entry.ts's navGroupKey): its path, or the view type for a pathless
	// one. Carried because a pathless group's key cannot be recovered from `path`, and a caller
	// holding the list's order has nothing else stable to hold — indices are the list's current shape.
	key: string;
	// Stack indices of the note's landings, top of the note first. One per distinct line, standing
	// for the NEWEST step that landed on it — or for the reader's own step where the current entry
	// shares the line (see currentRep). Every one is a DESTINATION: a note whose file is gone is not
	// grouped at all.
	indices: number[];
	// The note's OWN record — the place that stands for the file rather than for a spot inside it,
	// and the row that opens the file the plain way. Deliberately NOT one of `indices`: a note is not
	// a landing under itself.
	anchor?: number;
	// The current entry's own group. Not an ordering fact: the list is in recency order whatever the
	// reader is standing in, so this only says where to paint the mark.
	current: boolean;
	// The landing that holds the CURRENT entry — the row carrying the "you are here" dot. Undefined
	// when the reader is in the note but on no listed landing: their own record is the ANCHOR.
	currentRep?: number;
}

// How much of one note the list prints. Re-exported because the browser's modules take it from here
// (the settings record it is stored in is types.ts).
export type { LandingsMode } from '@/types';

// The path a pathless group (a view) carries: giving it one would let it merge with a note of the
// same name.
export const NO_PATH = '';

// The key that makes two steps ONE landing: the line they landed on. How the step was made is not
// part of where it is, so a note returned to at L412 five times by five routes holds one spot.
//
// A step that recorded NO line gets the one `none` key: a file without coordinates — a `.base` view,
// a PDF, an image — has exactly one place to be. A VIEW step gets the one constant key.
const NO_LINE = 'none';

function landingKey(entry: NavEntry, line: number | undefined): string {
	if (entry.kind === 'view')
		return 'view';
	return line === undefined ? NO_LINE : `L${line}`;
}

// The filtered steps as one group per note. Groups come out by the recency of their NEWEST step;
// INSIDE a group the order is the note's own: by line, ascending, every distinct line a row of its
// own. `keep` applies the filter, so a dropped step's note may disappear with it.
//
// `lineOf` resolves the line a step landed on, INJECTED because the line a row prints is not always
// the entry's own: a step recorded before the block was captured falls back to the file's saved
// position. Whatever the caller passes must be the same number the row shows, or the list would
// collapse steps the reader can still tell apart.
//
// The current entry gets no special place in the order: it is included where its recency puts it and
// the dot is painted on the row that holds it. Lifting it to the top would re-arrange the list under
// the hand that clicked a row.
export function groupByFile(
	entries: NavEntry[],
	currentIndex: number,
	keep: (index: number) => boolean = () => true,
	lineOf: (index: number) => number | undefined = () => undefined,
	// The group order to hold the list at, by key; undefined orders by recency. A caller that passes
	// one is saying "the reader is USING this list". Keys rather than indices because the group order
	// is derived afresh every time.
	order?: readonly string[],
): NavFileGroup[] {
	const groups = new Map<string, NavFileGroup>();
	const seen = new Map<string, Map<string, number>>();
	// The distinct landings of a note as the reverse scan meets them — newest step first, which is
	// the order the step standing for each line is chosen in.
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
	// Reverse order: the first time a note is seen is its newest surviving step, and Map insertion
	// order preserves exactly that as the group order. The CURRENT entry is included with the rest —
	// the list marks the landing that holds it rather than holding it out.
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!keep(i))
			continue;
		const entry = entries[i];
		const key = navGroupKey(entry);
		const group = open(entry);
		// A visit or view names the FILE rather than a spot in it, so it becomes the ANCHOR and adds
		// NO landing: a row standing for the file's own record would be a row whose click does nothing
		// visible.
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
			// Already on the list: the step adds no destination, but it is still the step the reader
			// is ON when it is the current entry.
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
	// Under one note the rows come out by LINE, ascending — the order of the document they are places
	// in. Between notes recency decides ("where was I"), but inside one nothing is learned from the
	// order the spots were visited in. A step with no recorded line keeps its recency place at the
	// END.
	//
	// The step standing for a line is the NEWEST one that landed there, or the reader's own where the
	// current entry shares it — so the line a row prints IS the line its click lands on.
	const rank = (line: number | undefined) => line === undefined ? Number.MAX_SAFE_INTEGER : line;
	for (const [key, group] of groups) {
		const landings = found.get(key)!;
		landings.sort((a, b) => rank(a.line) - rank(b.line));
		group.indices = landings.map(l => l.index);
		if (landings.some(l => l.index === currentIndex))
			group.currentRep = currentIndex;
	}
	// The current note reaches the list by the same scan as every other: its own step has to survive
	// `keep` — a note the query dropped is not this list's business, current or not.
	const current = entries[currentIndex];
	if (current && keep(currentIndex) && !groups.has(navGroupKey(current)))
		open(current).current = true;
	const out = Array.from(groups.values());
	// `out` is ALREADY the recency order: the reverse scan inserted a group at its newest step, and
	// Map preserves insertion order.
	if (order) {
		// Held still. Groups this order has never heard of appeared since it was taken, so by recency
		// they are the NEWEST: they take rank -1 and land at the front, keeping their own recency
		// order among themselves (the sort is stable).
		const rank = new Map(order.map((k, i): [string, number] => [k, i]));
		out.sort((a, b) => (rank.get(a.key) ?? -1) - (rank.get(b.key) ?? -1));
	}
	return out;
}

// The query as the search box reads it: one token per run of whitespace, lower cased, empties
// dropped. Two callers and the same split in both — the filter that decides what stays, and the one
// that says WHICH line a query hit — because a row answering "why am I on this list" with a different
// notion of a word than the filter answers a question the reader did not ask.
export function queryTokens(query: string): string[] {
	return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// Pure filter predicate: every token must appear (case-insensitively) somewhere in the entry's
// searchable text. Two sources, composed here because only the caller knows both: the entry's OWN
// text (navSearchText), and `extra`, everything the caller derives from the VAULT.
//
// "Everything a match can hit is on the row" is NOT the rule: a hit is text the READER could have
// written about that file, which is what the extra sources have in common. An alias is the clearest
// case — finding a note by a name the reader half-remembers is the whole reason a search box is here.
export function matchesNavFilter(entry: NavEntry, query: string, extra?: string): boolean {
	const tokens = queryTokens(query);
	if (tokens.length === 0)
		return true;
	const hay = `${navSearchText(entry)} ${extra ?? ''}`.toLowerCase();
	return tokens.every(tok => hay.includes(tok));
}

// The entry's own searchable text: name and path, the recorded context block, and the remap anchor on
// top (it belongs to the viewport's top line, which the block — built around the landing — does not
// always reach). All joined into one haystack, so the order of the parts carries nothing.
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
	// The jump's key: for an outline click the heading's text, for an anchor link the target the
	// reader picked. A caller target's synthetic `caller:<ms>` key is a timestamp, not words.
	if (entry.kind === 'jump' && !entry.key.startsWith('caller:'))
		parts.push(entry.key.startsWith('outline:') ? entry.key.slice('outline:'.length) : entry.key);
	// Where a plain link came from, and what it said.
	if (entry.kind === 'visit') {
		if (entry.viaPath)
			parts.push(baseName(entry.viaPath));
		if (entry.viaText)
			parts.push(entry.viaText);
	}
	return parts.filter(Boolean).join(' ');
}

// WHICH LINE OF A LANDING'S CONTEXT THE QUERY HIT — the answer to "why is this row on my list",
// which the row cannot answer on its own: the block is what the search box matched and is printed
// nowhere, so a row that matched on a sentence looks exactly like one that matched on its name.
//
// The first line carrying ALL the tokens; failing that, the first line carrying the FIRST token — the
// filter matched over the block joined together, so two tokens may sit on two lines. Undefined when
// the query hit none of the block: a row may match on its name, path, an alias, its section or a
// link's words, and every one of those is already on the row or one hover away.
export function matchedContextLine(entry: NavEntry, query: string): string | undefined {
	const tokens = queryTokens(query);
	if (!tokens.length || entry.kind === 'view')
		return undefined;
	let loose: string | undefined;
	for (const line of entry.st?.context ?? []) {
		const hay = line.text.toLowerCase();
		if (!hay)
			continue;
		if (tokens.every(tok => hay.includes(tok)))
			return line.text;
		if (loose === undefined && hay.includes(tokens[0]))
			loose = line.text;
	}
	return loose;
}
