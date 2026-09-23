import { App, TFile } from 'obsidian';
import { PluginSettings } from '@/types';
import { frontmatterRuleMatches } from '@/shared/frontmatter';

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
//
// Only the escape hatch is THIS feature's. The entry form itself — what
// `prop` and `prop: value` mean, and how a value is compared — is shared with
// the recent-files list's own rule and lives in shared/frontmatter.ts, so the
// two pages cannot drift apart in what an entry says.
//
// The recent-files list deliberately does NOT read the escape hatch back:
// `position-restore` answers whether a POSITION is recorded, and a note the
// reader opted out of position recording is still a place they navigate to
// (see recent-files/places.ts).

export const ESCAPE_HATCH_PROPERTY = 'position-restore';

export interface FrontmatterDecision {
	// `position-restore: true`: record regardless of every rule below.
	forceRecord: boolean;
	// `position-restore: false` or any configured B rule matched: never record.
	skip: boolean;
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
	} else if (frontmatterRuleMatches(frontmatter, settings.frontmatterExcludeProperties ?? [])) {
		// B rule: an entry matched (see shared/frontmatter.ts).
		decision.skip = true;
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
