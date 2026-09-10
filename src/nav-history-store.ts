import { App } from 'obsidian';
import { NavHistoryEntry, NAV_HISTORY_VERSION } from './nav-entry';

// Device-local, per-vault navigation-history persistence (mirrors tab-store):
// the startup read, the debounced write, and the per-entry shape check.

// Desktop localStorage is shared across vaults (same app origin); appId is
// the per-vault discriminator. Not in the public typings.
export function navHistoryStorageKey(app: App): string {
	const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
	return `position-restore:nav-history:${appId}`;
}

export function loadNavHistory(app: App): { entries: NavHistoryEntry[]; index: number } {
	try {
		const raw = window.localStorage.getItem(navHistoryStorageKey(app));
		if (!raw)
			return { entries: [], index: -1 };
		const parsed = JSON.parse(raw) as { v?: unknown; entries?: unknown; index?: unknown };
		// Version gate: a pre-versioned (legacy) or foreign blob is
		// dropped whole — the history is disposable, no legacy formats
		// are migrated. Bump NAV_HISTORY_VERSION on format changes.
		if (parsed.v !== NAV_HISTORY_VERSION)
			return { entries: [], index: -1 };
		const entries = Array.isArray(parsed.entries)
			? parsed.entries.filter((e): e is NavHistoryEntry => isNavEntry(e))
			: [];
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

// Per-entry shape check (the storage may hold hand-edited or truncated
// data): the kind tag first, then that variant's required fields — an
// untagged or junk entry drops instead of passing a property coincidence.
export function isNavEntry(e: unknown): e is NavHistoryEntry {
	if (!e || typeof e !== 'object')
		return false;
	const entry = e as Record<string, unknown>;
	const str = (v: unknown): v is string => typeof v === 'string' && !!v;
	if (!str(entry.leafId))
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

export function serializeNavHistory(entries: NavHistoryEntry[], index: number): string {
	// entries is a plain array of plain objects — JSON-safe as is.
	return JSON.stringify({ v: NAV_HISTORY_VERSION, entries, index });
}

// Debounced write: the dedup against the last serialized blob lives here so
// callers don't track it.
let lastPersisted = '';
export function persistNavHistory(app: App, entries: NavHistoryEntry[], index: number): void {
	try {
		const serialized = serializeNavHistory(entries, index);
		if (serialized === lastPersisted)
			return;
		window.localStorage.setItem(navHistoryStorageKey(app), serialized);
		lastPersisted = serialized;
	} catch (e) {
		console.error('Position Restore: can not persist navigation history:', e);
	}
}
