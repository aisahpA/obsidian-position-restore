import { App, TFile } from 'obsidian';
import { PluginSettings } from './types';

// Frontmatter-driven recording control, shared by the recording gate
// (ExclusionChecker) and the db cleaner (CursorPositionDatabase.pruneDb) so a
// file excluded via frontmatter is treated identically everywhere. Both
// mechanisms read Obsidian's in-memory metadata cache — never the file text —
// so the hot path (100ms poll, scroll capture) costs one Map lookup.
//
//  - A (escape hatch): a property this plugin reserves — `position-restore` —
//    with a strict boolean meaning. `false` never records the file (absolute,
//    beats every other rule); `true` always records it (beats excluded
//    folders, the minimum-length filter and the B rule below). The string
//    forms "true"/"false" count as well — Obsidian's properties UI stores
//    text-typed values quoted ("false"), so a strict-boolean-only check would
//    silently miss a UI-entered marker. Any other value (numbers, null…) is
//    ignored, so YAML noise can't silently flip recording.
//  - B (rule): a configurable list of `prop[: value]` entries
//    (frontmatterExcludeProperties). With just a name — `publish` — any file
//    whose frontmatter CONTAINS the property is never recorded (values
//    ignored). With a value — `publish: true` — the file is only excluded
//    when the property matches that value. Both forms can mix in one list.
//    Empty list = disabled.

export const ESCAPE_HATCH_PROPERTY = 'position-restore';

export interface FrontmatterDecision {
	// `position-restore: true`: record regardless of every rule below.
	forceRecord: boolean;
	// `position-restore: false` or any configured B rule matched: never record.
	skip: boolean;
}

// Loose value comparison against a typed frontmatter value (the metadata cache
// already parsed the YAML). Booleans accept yes/no/on/off aliases; numbers and
// strings compare case-insensitively; arrays match when any element does.
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

// Normalizes the escape-hatch marker to a strict boolean: booleans pass
// through, the string forms "true"/"false" (case-insensitive, trimmed) are
// accepted because Obsidian's properties UI stores text-typed values quoted.
// Anything else returns undefined = "no marker".
function markerValue(v: unknown): boolean | undefined {
	if (typeof v === 'boolean')
		return v;
	if (typeof v === 'string') {
		const s = v.trim().toLowerCase();
		if (s === 'true')
			return true;
		if (s === 'false')
			return false;
	}
	return undefined;
}

// Pure decision over raw frontmatter — unit-testable without an App.
export function evaluateFrontmatter(frontmatter: unknown, settings: PluginSettings): FrontmatterDecision {
	const decision: FrontmatterDecision = { forceRecord: false, skip: false };
	if (!frontmatter || typeof frontmatter !== 'object')
		return decision;
	const obj = frontmatter as Record<string, unknown>;

	// Escape hatch first: an explicit per-file marker beats every bulk rule.
	const marker = markerValue(obj[ESCAPE_HATCH_PROPERTY]);
	if (marker === true) {
		decision.forceRecord = true;
	} else if (marker === false) {
		decision.skip = true;
	} else {
		// B rule: each entry is `prop` (presence-only) or `prop: value`
		// (value match). Short list (usually 0–3 entries); a plain loop is
		// faster than allocating a Set per call.
		for (const entry of settings.frontmatterExcludeProperties) {
			if (!entry)
				continue;
			const sep = entry.indexOf(':');
			const name = (sep === -1 ? entry : entry.slice(0, sep)).trim();
			const expected = sep === -1 ? '' : entry.slice(sep + 1).trim();
			if (!name || !(name in obj))
				continue;
			if (expected === '' || valueMatches(obj[name], expected)) {
				decision.skip = true;
				break;
			}
		}
	}
	return decision;
}

// Reads the decision from the metadata cache. Returns undefined while the file
// has not been parsed yet (the cache fills lazily) — callers treat that as "no
// decision" and re-check on the next metadata-cache-changed event or poll
// tick, instead of caching a wrong answer.
export function frontmatterDecisionFor(app: App, file: TFile | null, settings: PluginSettings): FrontmatterDecision | undefined {
	if (!file)
		return undefined;
	const cache = app.metadataCache.getFileCache(file);
	if (!cache)
		return undefined;
	return evaluateFrontmatter(cache.frontmatter, settings);
}