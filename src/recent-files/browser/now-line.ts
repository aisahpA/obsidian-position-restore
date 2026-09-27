import { CachedMetadata } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { anchorLineShift } from '@/position/restore/anchor';
import { LineSource, remapAnchorLine } from '@/position/capture/ephemeral';
import { NavEntryDescription } from './model';

// WHAT A ROW'S LINE NUMBER MEANS TODAY. A recorded line is an ADDRESS: edit above
// it and the address points elsewhere while the spot itself has not moved. So
// every row needs two answers — where it was (the record, which is what the row
// prints) and where it is now (this module) — and only the second may be handed
// to anything that opens the note.
//
// Three ways to know, tried cheapest first: the file's CLOCK (mtime unchanged ⇒
// the number is still true), the jump's ANCHOR resolved against metadata now, and
// the anchor line's own TEXT re-found in the current lines (the open buffer when
// there is one, else the disk).
//
// UNDEFINED is an answer too, and the one this module exists to give: a number it
// does not have is worse than none — a preview opening at the top of the note was
// never wrong about where the spot was. Nothing here writes back.

// What only the vault can answer, handed in so this stays a pure function of a
// record and a file.
export interface NowLineFacts {
	// Undefined for a path with no file behind it — a place the list is not drawing.
	mtimeOf(path: string): number | undefined;
	// What a keyed jump's anchor is resolved against.
	cacheFor(path: string): CachedMetadata | null;
	// `prime`: whether a reading may be STARTED to answer (a hover may wait one
	// await; a render of fifty rows may not).
	linesOf(path: string, prime: boolean): LineSource | undefined;
}

// Where the entry's line is NOW, or undefined when this module cannot say.
//
// An entry with nothing to prove its number BY — no anchor, in a file the clock
// says is untouched — keeps the number it has: it is the best anyone knows about
// the spot, and it is what the row prints anyway.
export function nowLineFor(
	entry: NavEntry,
	d: NavEntryDescription,
	facts: NowLineFacts,
	prime = true,
): number | undefined {
	const recorded = d.lineIndex;
	if (entry.kind === 'view' || recorded === undefined)
		return undefined;

	// 1. Untouched since the record was taken.
	const taken = entry.st?.mtime;
	const now = facts.mtimeOf(entry.path);
	if (taken !== undefined && now !== undefined && taken === now)
		return recorded;

	// 2. The jump's own anchor, resolved structurally.
	if (entry.kind === 'jump' && entry.key && typeof entry.keyLine === 'number') {
		const shift = anchorLineShift(facts.cacheFor(entry.path), entry.key, entry.keyLine);
		if (shift !== undefined)
			return Math.max(0, recorded + shift);
	}

	// 3. The line's own text, re-found in the note as it stands.
	const src = facts.linesOf(entry.path, prime);
	if (src) {
		const at = remapAnchorLine(entry.st?.anchor, recorded, src);
		if (at !== undefined)
			return at;
	}

	// Nothing left to go on: an anchor that could not be found, or a file the clock
	// says has been written, is a question this answers with silence.
	const changed = taken !== undefined && now !== undefined && taken !== now;
	if (changed || entry.st?.anchor)
		return undefined;
	return recorded;
}
