import { CachedMetadata } from 'obsidian';
import { normAnchor } from '@/position/capture/ephemeral';

// Structural re-anchor for a keyed NavJump: instead of guessing the line
// from a text snippet (±30-line window in remapAnchoredState), resolve the
// jump's own anchor — a heading or block id the key already carries — to its
// CURRENT line in the file. Survives arbitrary insert/delete shifts (the
// heading still exists, so its line is authoritative) and never guesses: a
// renamed/removed anchor returns undefined and the caller falls back to the
// snippet remap. Cost is a metadataCache lookup + a scan of the (bounded)
// headings array — faster than remap's per-line doc reads, and only ever
// runs on a back/forward/jump-to apply.
//
// Key forms (see NavFunnel.recordOpen / OpenPatcher):
//   outline:<heading text>      raw heading text (outline panel click)
//   <file>#<slug> | #<slug>     heading link (anchor/caller linktext)
//   <file>^<block> | ^<block>   block reference
//   caller:<timestamp>          no anchor — not structural, returns undefined.
// The leading file path (if the linktext carried one) is stripped: a NavJump
// is always the same-file in-file jump, so we resolve against the entry's
// own file.
//
// Duplicate anchors: a heading text (or block id, rarer) can appear more
// than once. The recorded base line disambiguates — the correct instance is
// the one nearest the position the jump originally landed on — mirroring
// remapAnchoredState's "nearest duplicate" rule. With no base, the first
// (document-order) match wins.
export function resolveAnchorLine(
	cache: CachedMetadata | null,
	key: string,
	baseLine?: number,
): number | undefined {
	if (!cache || !key)
		return undefined;

	// outline:<heading> — two key forms:
	//   "outline:## My Heading"  UPGRADED (NavStack.upgradeKeyLine): the
	//     # count is the heading's absolute level, the rest is
	//     HeadingCache.heading's exact source — exact pass filtered by level
	//     (also disambiguates same-text headings at different depths);
	//     normalization only a fallback (e.g. the 80-char read truncation).
	//   "outline:T"              rendered text (pre-upgrade keys, or a landing
	//     that never settled): the plain two-pass match below.
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

	// An anchor/caller linktext: strip any leading file path, then take the
	// #heading / ^block part.
	const hashIdx = key.indexOf('#');
	const caretIdx = key.indexOf('^');
	if (hashIdx === -1 && caretIdx === -1)
		return undefined;
	const anchor = hashIdx !== -1
		? key.slice(hashIdx + 1)
		: key.slice(caretIdx + 1);
	if (!anchor)
		return undefined;

	if (hashIdx !== -1) {
		// The link anchor is a SLUG — a normalized form of the heading
		// ("My Heading" -> "my-heading") that decodeAnchor only URL-unwraps.
		// A plain-text compare against HeadingCache.heading can essentially
		// never hit it, so the exact pass would be a guaranteed-miss sweep:
		// go straight to the normalized scan.
		const target = normAnchor(decodeAnchor(anchor));
		return target
			? nearestLine(cache.headings ?? [], (h) => normAnchor(h.heading) === target, baseLine)
			: undefined;
	}

	// Block reference: the block id is an exact key, not a slug.
	const block = cache.blocks?.[anchor];
	return block?.position.start.line;
}

// Heading resolution for OUTLINE keys, two passes: plain text first — the
// common unedited case, nothing but string compares over all headings — and
// the normalized scan only when plain found nothing. A per-heading
// `exact || norm` predicate would NOT buy this: the unmatching majority
// (most headings) pays the regex on every scan. An exact hit outranks a
// nearer normalized one — an unedited heading is more credible than an
// edited lookalike. `level` (from an upgraded key's `#` count) filters both
// passes; link-slug keys skip this helper: their anchor is already a
// normalized form, the exact pass can never hit it.
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

// What a heading-cache hit carries back to the caller: the cache line (the
// authoritative RECORD-TIME line for a NavJump.keyLine upgrade), the level
// (rebuilds the upgraded outline key's # prefix), and the heading's exact
// source text.
export interface HeadingHit {
	line: number;
	level: number;
	heading: string;
}

// Locates a heading by normalized text (a rendered outline label or a link
// slug), `nearLine` breaking ties between same-text duplicates — the
// recorded view line only has to pick WHICH duplicate, so viewport drift
// (top-of-viewport vs. the heading itself) is harmless here. No match →
// undefined (the caller keeps its un-upgraded key/behavior).
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

// Picks the matching heading nearest `baseLine` (undefined base → first in
// document order). `headings` is document-ordered, so a plain "first match"
// would always hit the earliest duplicate, not the one the jump actually
// targeted; proximity to the recorded landing is the right tiebreak.
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
// The outline path of `line`: the chain of ATX headings the line falls under,
// outermost first. A heading ON the line itself is included as the deepest
// segment, so the path names the target line rather than skipping to its
// parent section. Empty when the line is under no heading.
//
// `lines` is the file split by '\n' — callers that only need this for one
// line can pass a slice ending there (the scan stops at the line anyway).
// Block-level states that hide heading-looking lines are honoured: fenced
// code, HTML comments, and Obsidian %% comments. A fence closes only on a
// same-type run at least as long as its opener (CommonMark backtick rule);
// comment blocks close at the next marker anywhere in a line.
export function outlinePathAtLine(lines: string[], line: number): string[] {
	const stack: { level: number; text: string }[] = [];
	let fence: { char: string; len: number } | null = null;
	let inHtml = false;
	let inObsidian = false;

	for (let i = 0; i <= line && i < lines.length; i++) {
		const raw = lines[i];

		if (inHtml) {
			if (raw.includes('-->'))
				inHtml = false;
			continue;
		}
		if (inObsidian) {
			if (raw.includes('%%'))
				inObsidian = false;
			continue;
		}
		if (fence) {
			const m = raw.match(/^\s*(`{3,}|~{3,})/);
			if (m && m[1][0] === fence.char && (fence.char === '`' ? m[1].length >= fence.len : true))
				fence = null;
			continue;
		}

		const fenceM = raw.match(/^\s*(`{3,}|~{3,})/);
		if (fenceM) {
			fence = { char: fenceM[1][0], len: fenceM[1].length };
			continue;
		}
		const htmlOpen = raw.indexOf('<!--');
		if (htmlOpen !== -1 && raw.indexOf('-->', htmlOpen) === -1) {
			inHtml = true;
			continue;
		}
		const obsOpen = raw.indexOf('%%');
		if (obsOpen !== -1 && raw.indexOf('%%', obsOpen + 2) === -1) {
			inObsidian = true;
			continue;
		}

		const m = raw.match(/^(#{1,6})\s+(.+)/);
		if (!m)
			continue;
		const text = m[2]
			.replace(/#+\s*$/, '')
			.replace(/<!--[\s\S]*-->/g, '')
			.replace(/%%[\s\S]*?%%/g, '')
			.trim();
		if (!text)
			continue;
		const level = m[1].length;
		while (stack.length && stack[stack.length - 1].level >= level)
			stack.pop();
		stack.push({ level, text });
	}
	return stack.map((h) => h.text);
}
