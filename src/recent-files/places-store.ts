import { App } from 'obsidian';
import { NavEntry } from '@/nav/entry';

// Device-local, per-vault persistence for the RECENT FILES list (see places.ts) —
// the same shape of module as the stack's store.ts, deliberately kept separate
// from it: the stack is a traversal device that lives minutes and is written on
// every navigation, while this is a place list that lives months and is written
// only when a place is touched. One blob for both would make each write pay for
// the other's size.

// This list's own format version, beside the blob it describes. A separate
// version from the stack's: the two are different things written at different
// cadences, and one must be droppable without the other.
export const RECENT_PLACES_VERSION = 1;

// Desktop localStorage is shared across vaults (same app origin); appId is the
// per-vault discriminator. Not in the public typings. (The key is its own: the
// two lists are separate stores, so one can be dropped without the other.)
export function navPlacesStorageKey(app: App): string {
	const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
	return `position-restore:nav-recent:${appId}`;
}

// The stored place list, oldest first (the array's order IS the MRU order: see
// places.ts — a touched place is moved to the end).
export function loadNavPlaces(app: App): NavEntry[] {
	try {
		const raw = window.localStorage.getItem(navPlacesStorageKey(app));
		if (!raw)
			return [];
		const parsed = JSON.parse(raw) as { v?: unknown; places?: unknown };
		// Version gate: a pre-versioned or foreign blob is dropped whole. The
		// list is disposable — an empty one refills itself as the reader works —
		// so no legacy format is migrated.
		if (parsed.v !== RECENT_PLACES_VERSION)
			return [];
		return Array.isArray(parsed.places)
			? parsed.places.filter((e): e is NavEntry => isPlaceEntry(e))
			: [];
	} catch (e) {
		console.error('Position Restore: can not read the recent files list:', e);
		return [];
	}
}

// The place-specific shape check: the stack's own per-entry check (store.ts)
// plus this list's one extra invariant — an INFERRED step (NavTeleport) is
// never a place, so a blob carrying one is not trusted at all. The tag is
// checked rather than a property, so a teleport cannot slip in by coincidence.
export function isPlaceEntry(e: unknown): e is NavEntry {
	if (!e || typeof e !== 'object')
		return false;
	const kind = (e as { kind?: unknown }).kind;
	if (kind !== 'visit' && kind !== 'jump' && kind !== 'view')
		return false;
	return isPlaceShape(e);
}

// Split out so the kind check above stays readable; the body is store.ts's
// check verbatim (kept local rather than exported from there: the two lists
// must be free to diverge, and this is the one place that decides).
function isPlaceShape(e: unknown): e is NavEntry {
	const entry = e as Record<string, unknown>;
	const str = (v: unknown): v is string => typeof v === 'string' && !!v;
	if (!str(entry.leafId) || typeof entry.t !== 'number')
		return false;
	if (entry.kind === 'view')
		return str(entry.viewType);
	if (entry.kind === 'jump')
		return str(entry.path) && str(entry.key);
	return str(entry.path);
}

export function serializeNavPlaces(entries: NavEntry[]): string {
	// entries is a plain array of plain objects — JSON-safe as is.
	return JSON.stringify({ v: RECENT_PLACES_VERSION, places: entries });
}

// Writes the list unless the blob is byte-identical to `previous` (the same
// owner-keeps-the-dedup contract as store.ts: the state belongs to the one
// instance that owns the list, never to this module).
export function persistNavPlaces(
	app: App,
	entries: NavEntry[],
	previous: string,
): string {
	const serialized = serializeNavPlaces(entries);
	if (serialized === previous)
		return previous;
	try {
		window.localStorage.setItem(navPlacesStorageKey(app), serialized);
		return serialized;
	} catch (e) {
		console.error('Position Restore: can not persist the recent files list:', e);
		return previous;
	}
}
