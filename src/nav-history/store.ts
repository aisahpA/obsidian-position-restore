import { App } from 'obsidian';
import { NavEntry, pruneViewSnapshot } from '@/nav/entry';

// Device-local, per-vault navigation-history persistence: the startup read,
// the debounced write, and the per-entry shape check.

// A mismatched stored blob is dropped whole on load — the history is
// disposable, no migrations. It lives here, with the blob it describes, not in
// the shared entry vocabulary: the recent-files list has its own version in
// its own store, and either list must stay droppable without the other.
export const NAV_HISTORY_VERSION = 3;

// Desktop localStorage is shared across vaults (same app origin); appId is
// the per-vault discriminator. Not in the public typings.
export function navHistoryStorageKey(app: App): string {
	const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
	return `position-restore:nav-history:${appId}`;
}

export function loadNavHistory(app: App): { entries: NavEntry[]; index: number } {
	try {
		const raw = window.localStorage.getItem(navHistoryStorageKey(app));
		if (!raw)
			return { entries: [], index: -1 };
		const parsed = JSON.parse(raw) as { v?: unknown; entries?: unknown; index?: unknown };
		// Version gate: a pre-versioned or foreign blob is dropped whole. Bump
		// NAV_HISTORY_VERSION on format changes.
		if (parsed.v !== NAV_HISTORY_VERSION)
			return { entries: [], index: -1 };
		const entries = Array.isArray(parsed.entries)
			? parsed.entries.filter((e): e is NavEntry => isNavEntry(e))
			: [];
		// What a view entry CLAIMS about itself — state, name, icon — is read
		// back into a replay and into the DOM, and a hand edit, a sync or a
		// truncation can put anything here. Fields that are not what they claim
		// are dropped while the ENTRY stays: all three have a working fallback
		// (view rebuilt at defaults, row prints its own view type), so a bad
		// field costs a detail, never the place.
		for (const entry of entries)
			pruneViewSnapshot(entry);
		const index = typeof parsed.index === 'number'
			&& parsed.index >= -1 && parsed.index < entries.length
			? parsed.index
			: entries.length - 1;
		return { entries, index };
	} catch (e) {
		console.error('Position Restore: can not read navigation history:', e);
		return { entries: [], index: -1 };
	}
}

// Per-entry shape check (the storage may hold hand-edited or truncated data):
// the kind tag first, then that variant's required fields — an untagged or
// junk entry drops instead of passing a property coincidence. `t` is required
// too: the browser labels every row with a relative time, so an unstamped
// entry is junk.
export function isNavEntry(e: unknown): e is NavEntry {
	if (!e || typeof e !== 'object')
		return false;
	const entry = e as Record<string, unknown>;
	const str = (v: unknown): v is string => typeof v === 'string' && !!v;
	if (!str(entry.leafId) || typeof entry.t !== 'number')
		return false;
	switch (entry.kind) {
		case 'view':
			return str(entry.viewType);
		case 'jump':
			return str(entry.path) && str(entry.key);
		case 'teleport':
			return str(entry.path) && typeof entry.line === 'number';
		case 'visit':
			return str(entry.path);
		default:
			return false;
	}
}

export function serializeNavHistory(entries: NavEntry[], index: number): string {
	// entries is a plain array of plain objects — JSON-safe as is.
	return JSON.stringify({ v: NAV_HISTORY_VERSION, entries, index });
}

// Writes the history unless the blob is byte-identical to `previous` — the
// dedup that lets the 5s flush round cost one stringify when nothing moved.
// Returns the blob now on disk, which the CALLER keeps and passes back: the
// dedup state belongs to the owner of the history (one per plugin instance).
// Held here it would be shared by every instance in the page — a second vault
// would inherit the first one's blob and skip a write it owes.
// A failed write returns `previous` unchanged, so the next round retries.
export function persistNavHistory(
	app: App,
	entries: NavEntry[],
	index: number,
	previous: string,
): string {
	const serialized = serializeNavHistory(entries, index);
	if (serialized === previous)
		return previous;
	try {
		window.localStorage.setItem(navHistoryStorageKey(app), serialized);
		return serialized;
	} catch (e) {
		console.error('Position Restore: can not persist navigation history:', e);
		return previous;
	}
}
