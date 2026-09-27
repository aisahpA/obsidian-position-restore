import { App } from 'obsidian';
import { NavEntry, pruneViewSnapshot } from '@/nav/entry';

// Device-local, per-vault persistence for the RECENT FILES list — the same
// shape of module as the stack's store.ts, deliberately kept separate from it:
// the stack is a traversal device that lives minutes and is written on every
// navigation, while this is a place list that lives months and is written only
// when a place is touched. One blob for both would make each write pay for the
// other's size.

// This list's own format version, beside the blob it describes: the two are
// different things written at different cadences, and one must be droppable
// without the other. Raised when the SHAPE changes (2 added the pin list) —
// a blob from another version is dropped whole rather than migrated, which is
// affordable because the list is disposable: an empty one refills itself.
export const RECENT_PLACES_VERSION = 2;

// Desktop localStorage is shared across vaults (same app origin); appId is the
// per-vault discriminator. Not in the public typings. The key is its own, so
// the two lists can be dropped independently.
export function navPlacesStorageKey(app: App): string {
	const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
	return `position-restore:nav-recent:${appId}`;
}

// What the blob holds: the places, and the rows the reader pinned (see
// NavPlaces.pinned). Read as a pair because the two are one list — a pin whose
// place is gone is a pin with nothing to show, and keeping them in separate
// keys would let them drift apart.
export interface NavPlacesBlob {
	entries: NavEntry[];
	pinned: string[];
}

// Oldest first — the array's order IS the MRU order (a touched place is moved
// to the end, see places.ts).
export function loadNavPlaces(app: App): NavPlacesBlob {
	try {
		const raw = window.localStorage.getItem(navPlacesStorageKey(app));
		if (!raw)
			return { entries: [], pinned: [] };
		const parsed = JSON.parse(raw) as { v?: unknown; places?: unknown; pinned?: unknown };
		// Version gate: a pre-versioned or foreign blob is dropped whole. The
		// list is disposable — an empty one refills itself — so nothing is
		// migrated.
		if (parsed.v !== RECENT_PLACES_VERSION)
			return { entries: [], pinned: [] };
		const places = Array.isArray(parsed.places)
			? parsed.places.filter((e): e is NavEntry => isPlaceEntry(e))
			: [];
		// A view place's own snapshot (state / label / icon) is replayed and
		// drawn, and this is storage anything could have written: fields that
		// are not what they claim to be go, the place itself stays.
		for (const place of places)
			pruneViewSnapshot(place);
		return { entries: places, pinned: readPinned(parsed.pinned) };
	} catch (e) {
		console.error('Position Restore: can not read the recent files list:', e);
		return { entries: [], pinned: [] };
	}
}

// A pin is a ROW identity (see navGroupKey). Filtered rather than validated:
// the list of them is the reader's own note-taking, so a name that is not a
// string was never a pin and a pin whose row is gone is dead weight, not an
// error worth dropping the whole list over.
function readPinned(raw: unknown): string[] {
	return Array.isArray(raw)
		? raw.filter((k): k is string => typeof k === 'string' && !!k)
		: [];
}

// The stack's per-entry check plus this list's one extra invariant — an
// INFERRED step (NavTeleport) is never a place. The tag is checked rather
// than a property, so a teleport cannot slip in by coincidence.
export function isPlaceEntry(e: unknown): e is NavEntry {
	if (!e || typeof e !== 'object')
		return false;
	const kind = (e as { kind?: unknown }).kind;
	if (kind !== 'visit' && kind !== 'jump' && kind !== 'view')
		return false;
	return isPlaceShape(e);
}

// Split out so the kind check above stays readable. Kept local rather than
// exported from store.ts: the two lists must be free to diverge, and this is
// the one place that decides.
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

export function serializeNavPlaces(entries: NavEntry[], pinned: readonly string[]): string {
	// entries is a plain array of plain objects — JSON-safe as is.
	return JSON.stringify({ v: RECENT_PLACES_VERSION, places: entries, pinned });
}

// Writes the list unless the blob is byte-identical to `previous` (the same
// owner-keeps-the-dedup contract as store.ts: the state belongs to the one
// instance that owns the list).
export function persistNavPlaces(
	app: App,
	entries: NavEntry[],
	pinned: readonly string[],
	previous: string,
): string {
	const serialized = serializeNavPlaces(entries, pinned);
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
