import { App, TAbstractFile } from 'obsidian';
import { PositionStore } from './storage/position-store';
import { PositionState } from './state';

// Path-keyed state — the position store (which owns BOTH the per-file record and the per-leaf
// records, so a path change re-keys or drops them together), the navigation stores (which re-key or
// drop their OWN records), the pipeline's current-file pointer — kept in step with the vault's
// rename and delete events in one place, so they cannot disagree about what a path change means.
//
// A delete cannot be acted on when the event arrives: the vault fires the same 'delete' both for a
// file the user removed and for a sync plugin replacing a changed file (Nutstore Sync on mobile
// removes the target and renames the download over it), so acting on it drops records that are
// valid again a moment later. The delete is therefore scheduled, and the VAULT decides when the
// window closes: a path that is back is not deleted at all. Reading the vault, rather than pairing
// the delete with a create/rename event, also makes the answer independent of the two events'
// delivery order.
//
// The window is only the BACKSTOP. A replacement that reaches the vault as its own event — a
// create, or the rename over the target — cancels the pending prune outright (see cancelPending),
// because a phone's sync does not promise to put the file back inside any window: the download is
// a network round trip and the app may be frozen for part of it.

// How long a deleted path has to stay gone before its records are dropped. The wait is the trade
// in the mechanism: a real delete's records live exactly this long. Long, because what it has to
// cover is no longer an adjacent pair of adapter calls but a replacement the vault never reported
// at all — a slow one, or one written behind the vault's back.
const DELETE_PRUNE_GRACE_MS = 10_000;

// What the bookkeeper needs from a navigation store: the stack and the recent-files list are both
// keyed by path and both answer these four — but they keep DIFFERENT records, so each is told
// separately and each re-keys/drops its own. Declared here rather than imported so the bookkeeper
// does not have to know which stores exist: the composition root hands it the list (see
// position/manager.ts).
export interface PathStore {
	renameFile(oldPath: string, newPath: string): void;
	deleteFile(path: string): void;
	knownPaths(): string[];
	persist(): void;
}

export class PathBookkeeper {
	// Deleted paths waiting out their window (path → timer).
	private pendingDeletes = new Map<string, number>();
	// The startup sweep's paths, waiting out the same window. A map of its own because the outcome
	// differs, not the timing: a vault delete drops the position records too, while a swept path
	// keeps them — the db is a SYNCED file, so a vault that has not finished materializing a file on
	// this device must not erase the positions the other devices still need (which is also why db
	// pruning never consults the vault, see pruneDatabase).
	private pendingSweeps = new Map<string, number>();

	constructor(
		private app: App,
		private store: PositionStore,
		// The navigation stores, told separately and each accountable for its own records.
		private navStores: PathStore[],
		private state: PositionState,
	) {}

	// Each store re-keys itself; the pointer follows only the file it named. The position store is
	// one call because a per-leaf record still naming the old path would fail its path guard and
	// silently collapse the per-tab split onto the file record.
	renameFile(file: TAbstractFile, oldPath: string) {
		// The path is back — a rename is the second half of a sync's remove-and-rename
		// replacement, and the delete it undoes must not survive it.
		this.cancelPending(file.path);
		this.store.renameFile(file.path, oldPath);
		for (const nav of this.navStores)
			nav.renameFile(oldPath, file.path);
		if (this.state.lastLoadedFilePath == oldPath)
			this.state.lastLoadedFilePath = file.path;
	}

	// A second delete for the same path restarts the window, so windows never overlap.
	deleteFile(file: TAbstractFile) {
		this.deferMissing(this.pendingDeletes, file.path, () => this.prune(file.path));
	}

	// Vault 'create' — the other half a sync replacement can arrive as, and the one a
	// remove-then-write lands. Same answer as the rename above: the file is here, so the
	// delete was never a delete.
	fileCreated(file: TAbstractFile) {
		this.cancelPending(file.path);
	}

	// Drop a scheduled prune whose path is back. Both maps: a swept path that the sync has
	// since delivered is as alive as a deleted one it replaced, and neither owes a prune.
	private cancelPending(path: string) {
		for (const map of [this.pendingDeletes, this.pendingSweeps]) {
			const pending = map.get(path);
			if (pending === undefined)
				continue;
			window.clearTimeout(pending);
			map.delete(path);
		}
	}

	// The startup sweep for the navigation stores: a file deleted while Obsidian was closed fires no
	// 'delete' event, so its entries would sit in the stack and the list as dead rows forever — and,
	// worse, hold slots in their caps. Only the navigation stores are swept, deliberately: see
	// pendingSweeps. Deferred through the same window as a live delete, and for the same reason —
	// which also means the sweep's vault check runs well after onload, with the index built.
	sweepMissingHistory() {
		// One pass over the union of the paths the stores name, so a path both of them know is
		// scheduled (and re-checked) once.
		const paths = new Set<string>();
		for (const nav of this.navStores)
			for (const path of nav.knownPaths())
				paths.add(path);
		for (const path of paths)
			if (!this.app.vault.getAbstractFileByPath(path))
				this.deferMissing(this.pendingSweeps, path, () => {
					for (const nav of this.navStores)
						nav.deleteFile(path);
					// The prune is the point: don't leave it to the next flush (each store is
					// device-local, so writing it out cannot race another device).
					for (const nav of this.navStores)
						nav.persist();
				});
	}

	// (Re)start the grace window for `path`, then run `act` only if the path is still missing.
	// The vault is the arbiter (see the class comment): the same 'delete' arrives for a sync plugin's
	// temporary remove, and a path that is back a moment later is not deleted at all.
	private deferMissing(map: Map<string, number>, path: string, act: () => void) {
		const pending = map.get(path);
		if (pending !== undefined)
			window.clearTimeout(pending);
		const id = window.setTimeout(() => {
			void this.confirmGone(map, path, id, act);
		}, DELETE_PRUNE_GRACE_MS);
		map.set(path, id);
	}

	// The vault's index is not the last word on whether a path exists. A sync plugin writing
	// straight through the adapter — what Nutstore Sync and Remotely Save both do on a phone —
	// puts the file back ON THE DISK without the index hearing about it, and acting on an index
	// that still says "gone" erases the saved position. The disk is therefore asked too, and
	// either one having the path leaves the record alone.
	private async confirmGone(map: Map<string, number>, path: string, id: number, act: () => void) {
		if (this.app.vault.getAbstractFileByPath(path)) {
			map.delete(path);
			return;
		}
		let onDisk: boolean;
		try {
			onDisk = await this.app.vault.adapter.exists(path);
		} catch {
			// An adapter that cannot answer is not a path that is gone: a record kept that the
			// reader no longer wants costs nothing, one dropped is exactly what they notice.
			onDisk = true;
		}
		// The await opens a second window in which the path can come back, or a newer deferral
		// can replace this one. Only the deferral this timer belongs to may act.
		if (onDisk || map.get(path) !== id)
			return;
		map.delete(path);
		act();
	}

	// The path really is gone: drop it from every store.
	private prune(path: string) {
		this.store.deleteFile(path);
		for (const nav of this.navStores)
			nav.deleteFile(path);
	}
}
