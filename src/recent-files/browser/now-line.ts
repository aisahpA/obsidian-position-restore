import { CachedMetadata } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { anchorLineShift } from '@/position/restore/anchor';
import { LineSource, remapAnchorLine } from '@/position/capture/ephemeral';
import { NavEntryDescription } from './model';

// WHAT A ROW'S LINE NUMBER MEANS TODAY.
//
// Every line this list prints was a line NUMBER the day it was recorded, and a
// number is an address: edit the note above it and the address points somewhere
// else, while the spot itself has not moved. Two answers are therefore needed for
// the same row — "where was it" (the record, which is what the row prints and what
// its words were taken from) and "where is it now" (this module) — and only the
// second one can be handed to anything that opens the note.
//
// Three ways to know, tried in the order they cost:
//
//   1. THE FILE'S OWN CLOCK. A record keeps the mtime the file had when it was
//      taken; the file keeps the one it has now. Equal means nothing has been
//      written since, so the recorded number is still the truth and there is
//      nothing to re-find — the common case, and it costs one field read.
//   2. THE ANCHOR THE JUMP CARRIES (a keyed jump's heading or block id), resolved
//      against the file's metadata now: authoritative, and the only way across an
//      edit larger than the text scan's window.
//   3. THE ANCHOR LINE'S OWN TEXT, re-found in the file's current lines — an open
//      note's buffer when there is one (which is the text the reader is actually
//      looking at, saved or not), otherwise the text on disk.
//
// And one way NOT to know, which is the answer this module exists to be able to
// give: UNDEFINED. A note rewritten past recognition has no line to name, and a
// number it does not have is worse than no number at all — a preview that opens at
// the top of the note is a preview that was never wrong about where the spot was.
//
// NOTHING HERE WRITES BACK. The record stays as it was taken (a keyed landing is
// written once, when it settles, and is never overwritten afterwards); what is
// re-found is re-found per question, in memory, and lives no longer than the asking.

// The three things only the vault can answer, handed in so this module stays a pure
// function of a record and a file: testable without a workspace, and honest about
// what it had to be told.
export interface NowLineFacts {
	// The file's mtime as it stands now (see RecentFilesReads.mtimeOf). Undefined for a
	// path with no file behind it, which is a place the list is not drawing at all.
	mtimeOf(path: string): number | undefined;
	// The file's parsed metadata as it stands now: what a keyed jump's anchor is
	// resolved against.
	cacheFor(path: string): CachedMetadata | null;
	// The file's lines as they stand now, or undefined when they are not in hand.
	// `prime` is whether a reading may be STARTED to answer the question (see
	// RecentFilesReads.linesFor): a hover may wait one await, a render of fifty rows
	// may not.
	linesOf(path: string, prime: boolean): LineSource | undefined;
}

// Where the entry's line is NOW, or undefined when this module cannot say.
//
// `prime` — whether the file may be read to answer (see NowLineFacts.linesOf).
//
// The one case that keeps its recorded number without being able to prove it is the
// one with nothing to prove it BY: an entry that never carried an anchor (a record
// older than the field, or a file row whose line came from the position database)
// in a file the clock says has not been touched. There the number is the best thing
// anyone knows about the spot, and it is what the row prints anyway — answering
// undefined would make the list quieter without making it truer.
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

	// Nothing left to go on. An anchor that could not be found, or a file the clock
	// says has been written, is a question this module has to answer with silence;
	// a record that never had an anchor and shows no sign of having moved keeps the
	// number it has.
	const changed = taken !== undefined && now !== undefined && taken !== now;
	if (changed || entry.st?.anchor)
		return undefined;
	return recorded;
}
