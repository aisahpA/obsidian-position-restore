import { App, TFile } from 'obsidian';

// THE `prop[: value]` FRONTMATTER RULE — one form, spoken by every feature
// that lets the reader keep a whole class of notes out at once: the position
// recording rules (position/policy/frontmatter.ts) and the recent-files list
// (recent-files/places.ts). It stands outside both because what an ENTRY
// MEANS is not either feature's business: `status` matches any file carrying
// the property whatever its value, `status: archived` only those whose value
// equals it, and an entry typed on one settings page must mean the same thing
// on the other. Empty list = no rule at all.
//
// Both readers take the frontmatter from the in-memory metadata cache — never
// from the file's text — so asking a rule costs one Map lookup, which is what
// lets the position poll and every navigation afford to ask.

// Booleans accept yes/no/on/off aliases; numbers and strings compare
// case-insensitively; arrays match when any element does.
function valueMatches(cached: unknown, expected: string): boolean {
	const exp = expected.trim().toLowerCase();
	if (Array.isArray(cached))
		return cached.some((v) => valueMatches(v, expected));
	if (typeof cached === 'boolean') {
		const aliases: Record<string, boolean> = { true: true, false: false, yes: true, no: false, on: true, off: false };
		return exp in aliases && aliases[exp] === cached;
	}
	if (cached === null || typeof cached === 'object')
		return false;
	if (typeof cached !== 'string' && typeof cached !== 'number')
		return false;
	return cached.toString().toLowerCase() === exp;
}

// Short list (usually 0–3 entries); a plain loop beats allocating a Set.
export function frontmatterRuleMatches(frontmatter: unknown, entries: readonly string[]): boolean {
	if (!frontmatter || typeof frontmatter !== 'object')
		return false;
	const obj = frontmatter as Record<string, unknown>;
	for (const entry of entries) {
		if (!entry)
			continue;
		const sep = entry.indexOf(':');
		const name = (sep === -1 ? entry : entry.slice(0, sep)).trim();
		const expected = sep === -1 ? '' : entry.slice(sep + 1).trim();
		if (!name || !(name in obj))
			continue;
		if (expected === '' || valueMatches(obj[name], expected))
			return true;
	}
	return false;
}

// Undefined when there is no file at that path, or while it has not been
// parsed yet — the cache fills lazily. Callers take that as "no answer yet"
// and carry on, rather than as a decision to keep: an answer guessed from an
// unparsed file is one a later visit contradicts.
export function frontmatterOfPath(app: App, path: string): Record<string, unknown> | undefined {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile))
		return undefined;
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter;
}
