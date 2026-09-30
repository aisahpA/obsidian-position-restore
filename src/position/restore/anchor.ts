import { CachedMetadata } from 'obsidian';
import { blockAnchor } from '@/nav/entry';
import { normAnchor } from '@/position/capture/ephemeral';

// How far a keyed entry's anchor has DRIFTED: its line in the file NOW minus
// the line it sat on when the entry was recorded (NavJump.keyLine). One
// number, asked of the metadata cache and of nothing else — no file is read —
// so it is the cheap half of re-anchoring and the only half a caller without
// the file's text can run at all.
//
// Shared because two callers must agree on it: the traversal about to open
// the file (nav-history/stack.ts's landingFor, where no editor exists yet)
// and the browser's preview of a place it is not opening
// (recent-files/browser/now-line.ts). A drift read differently by the two
// would put one row's preview and its click on two different lines.
//
// Undefined when the anchor cannot be resolved — renamed or removed heading,
// or an entry that never settled into a keyLine: the caller falls back to the
// text-snippet remap or says nothing.
export function anchorLineShift(
	cache: CachedMetadata | null,
	key: string,
	keyLine: number,
): number | undefined {
	const line = resolveAnchorLine(cache, key, keyLine);
	return line === undefined ? undefined : line - keyLine;
}

// Structural re-anchor for a keyed NavJump: resolve the jump's own anchor —
// a heading or block id the key already carries — to its CURRENT line,
// instead of guessing from a text snippet. Survives arbitrary
// insert/delete shifts (a heading that still exists is authoritative) and
// never guesses: a renamed/removed anchor returns undefined and the caller
// falls back to remapAnchoredState. Only runs on a back/forward/jump apply.
//
// Key forms (see NavFunnel.recordOpen / OpenPatcher):
//   outline:<heading text>      raw heading text (outline panel click)
//   <file>#<slug> | #<slug>     heading link (anchor/caller linktext)
//   <file>#^<block> | #^<block> block reference (the form a [[note#^id]] link
//     arrives in; <file>^<block> is the same thing without the hash)
//   caller:<timestamp>          no anchor — not structural, returns undefined.
// A leading file path is stripped: a NavJump is always a same-file in-file
// jump, so it resolves against the entry's own file.
//
// Duplicate anchors: the recorded base line disambiguates — the right
// instance is the one nearest the position the jump originally landed on,
// mirroring remapAnchoredState's "nearest duplicate" rule.
export function resolveAnchorLine(
	cache: CachedMetadata | null,
	key: string,
	baseLine?: number,
): number | undefined {
	if (!cache || !key)
		return undefined;

	// outline:<heading> — two key forms:
	//   "outline:## My Heading"  upgraded (NavStack.upgradeKeyLine): the #
	//     count is the heading's absolute level, the rest is
	//     HeadingCache.heading's exact source — exact pass filtered by level,
	//     which also disambiguates same-text headings at different depths;
	//   "outline:T"              rendered text (pre-upgrade keys, or a
	//     landing that never settled): the plain two-pass match below.
	if (key.startsWith('outline:')) {
		const text = key.slice('outline:'.length).trim();
		const m = /^(#{1,6})\s+(.+)$/.exec(text);
		const level = m?.[1].length;
		const raw = (m ? m[2] : text).trim();
		const target = normAnchor(raw);
		return target
			? headingLine(cache, raw, target, baseLine, level)
			: undefined;
	}

	// Block reference: the id is an exact key, not a slug. It is asked BEFORE
	// the heading branch because `note.md#^id` carries a `#` as well — that is
	// the form Obsidian hands over for a `[[note#^id]]` link, and reading it as
	// a heading slug made every block link miss and fall back to the
	// text-snippet remap.
	const block = blockAnchor(key);
	if (block !== undefined)
		return cache.blocks?.[block]?.position.start.line;

	// An anchor/caller linktext: strip any leading file path, then take the
	// #heading part.
	const hashIdx = key.indexOf('#');
	if (hashIdx === -1)
		return undefined;
	const anchor = key.slice(hashIdx + 1);
	if (!anchor)
		return undefined;
	// The link anchor is a SLUG ("My Heading" -> "my-heading") that
	// decodeAnchor only URL-unwraps, so a plain-text compare against
	// HeadingCache.heading can essentially never hit it: go straight to
	// the normalized scan.
	const target = normAnchor(decodeAnchor(anchor));
	return target
		? nearestLine(cache.headings ?? [], (h) => normAnchor(h.heading) === target, baseLine)
		: undefined;
}

// Heading resolution for OUTLINE keys, two passes: plain text first (the
// common unedited case, nothing but string compares), the normalized scan
// only when plain found nothing — the unmatching majority would otherwise
// pay the regex on every scan. An exact hit outranks a nearer normalized one:
// an unedited heading is more credible than an edited lookalike. Link-slug
// keys skip this helper — their anchor is already normalized.
function headingLine(
	cache: CachedMetadata,
	raw: string,
	target: string,
	baseLine?: number,
	level?: number,
): number | undefined {
	const headings = cache.headings ?? [];
	const byLevel = (h: { level: number }) => level === undefined || h.level === level;
	const exact = nearestLine(headings, (h) => byLevel(h) && h.heading.trim() === raw, baseLine);
	if (exact !== undefined)
		return exact;
	return nearestLine(headings, (h) => byLevel(h) && normAnchor(h.heading) === target, baseLine);
}

// decodeURIComponent throws on a stray % (a literal percent in a heading
// slug) — fall back to the raw text rather than throwing into execute().
export function decodeAnchor(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

// What a heading-cache hit carries back: the cache line (the authoritative
// record-time line for a NavJump.keyLine upgrade), the level (rebuilds the
// upgraded outline key's # prefix), and the heading's exact source text.
export interface HeadingHit {
	line: number;
	level: number;
	heading: string;
}

// Locates a heading by normalized text (a rendered outline label or a link
// slug), `nearLine` breaking ties between same-text duplicates — the recorded
// view line only has to pick WHICH duplicate, so viewport drift is harmless
// here.
export function findHeading(
	cache: CachedMetadata | null,
	text: string,
	nearLine?: number,
): HeadingHit | undefined {
	const target = normAnchor(text);
	if (!cache || !target)
		return undefined;
	let best: HeadingHit | undefined;
	let bestDist = Infinity;
	for (const h of cache.headings ?? []) {
		if (normAnchor(h.heading) !== target)
			continue;
		if (nearLine === undefined)
			return { line: h.position.start.line, level: h.level, heading: h.heading };
		const dist = Math.abs(h.position.start.line - nearLine);
		if (dist < bestDist) {
			bestDist = dist;
			best = { line: h.position.start.line, level: h.level, heading: h.heading };
		}
	}
	return best;
}

// `headings` is document-ordered, so a plain "first match" would always hit
// the earliest duplicate, not the one the jump targeted.
function nearestLine<T extends { position: { start: { line: number } } }>(
	items: T[],
	matches: (it: T) => boolean,
	baseLine?: number,
): number | undefined {
	let best: number | undefined;
	let bestDist = Infinity;
	for (const it of items) {
		if (!matches(it))
			continue;
		const line = it.position.start.line;
		if (baseLine === undefined)
			return line; // first match wins without a base
		const dist = Math.abs(line - baseLine);
		if (dist < bestDist) {
			bestDist = dist;
			best = line;
		}
	}
	return best;
}

// The outline path of a line lives with the rest of the heading reading, in
// shared/headings.ts's outlinePathAtLine: the cue names a section from the live
// editor buffer and the recent-files row from the metadata cache, and the two
// answers have to agree.
