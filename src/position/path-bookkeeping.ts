import { App, TAbstractFile } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { PositionStore } from './storage/position-store';
import { PositionState } from './state';

// Path-keyed state — the position store (which owns BOTH the per-file record
// and the per-leaf records, so a path change re-keys or drops them together),
// the navigation history, the pipeline's current-file pointer — kept in step
// with the vault's rename and delete events in one place, so the three cannot
// disagree about what a path change means.
//
// A delete cannot be acted on when the event arrives: the vault fires the same
// 'delete' both for a file the user removed and for a sync plugin replacing a
// changed file (Nutstore Sync on mobile removes the target and renames the
// download over it — see downloadRemoteFileInChunks), so acting on it drops
// records that are valid again a moment later. The delete is therefore
// scheduled, and the VAULT decides when the window closes: a path that is back
// is not deleted at all. Reading the vault, rather than pairing the delete with
// a create/rename event, also makes the answer independent of the two events'
// delivery order.

// How long a deleted path has to stay gone before its records are dropped. The
// wait is the whole protection, so it is the one trade in the mechanism: a real
// delete's records live exactly this long. The sync replacement's remove and its
// rename are adjacent adapter calls, so 2s covers one filesystem-watcher
// delivery with room to spare.
const DELETE_PRUNE_GRACE_MS = 2000;

export class PathBookkeeper {
	// Deleted paths waiting out their window (path → timer).
	private pendingDeletes = new Map<string, number>();
	// The startup sweep's paths, waiting out the same window. A map of its own
	// because the outcome differs, not the timing: a vault delete drops the
	// position records too, while a swept path keeps them — the db is a SYNCED
	// file, so a vault that has not finished materializing a file on this
	// device must not erase the positions the other devices still need (which
	// is also why db pruning never consults the vault, see pruneDatabase).
	private pendingSweeps = new Map<string, number>();

	constructor(
		private app: App,
		private store: PositionStore,
		private nav: NavHistory,
		private state: PositionState,
	) {}

	// Each store re-keys itself; the pointer follows only the file it named.
	// The position store is one call because a per-leaf record still naming the
	// old path would fail its path guard and silently collapse the per-tab
	// split onto the file record.
	renameFile(file: TAbstractFile, oldPath: string) {
		this.store.renameFile(file.path, oldPath);
		this.nav.renameFile(oldPath, file.path);
		if (this.state.lastLoadedFilePath == oldPath)
			this.state.lastLoadedFilePath = file.path;
	}

	// A second delete for the same path restarts the window, so windows never
	// overlap.
	deleteFile(file: TAbstractFile) {
		this.deferMissing(this.pendingDeletes, file.path, () => this.prune(file.path));
	}

	// The startup sweep for navigation history: a file deleted while Obsidian
	// was closed fires no 'delete' event, so its entries would sit in the
	// browser as dead rows forever — and, worse, hold slots in the capped
	// stack. Only the history is swept, deliberately: see pendingSweeps.
	// Deferred through the same window as a live delete, and for the same
	// reason (a sync plugin that is still downloading the file must not lose
	// it) — which also means the sweep's vault check runs well after onload,
	// with the index certainly built.
	sweepMissingHistory() {
		for (const path of this.nav.knownPaths())
			if (!this.app.vault.getAbstractFileByPath(path))
				this.deferMissing(this.pendingSweeps, path, () => {
					this.nav.deleteFile(path);
					// The prune is the point: don't leave it to the next flush
					// (the history is device-local, so writing it out cannot
					// race another device).
					this.nav.persist();
				});
	}

	// (Re)start the grace window for `path`, then run `act` only if the vault
	// still does not have it. The vault is the arbiter (see the class
	// comment): the same 'delete' arrives for a sync plugin's temporary
	// remove, and a path that is back a moment later is not deleted at all.
	private deferMissing(map: Map<string, number>, path: string, act: () => void) {
		const pending = map.get(path);
		if (pending !== undefined)
			window.clearTimeout(pending);
		map.set(path, window.setTimeout(() => {
			map.delete(path);
			if (this.app.vault.getAbstractFileByPath(path))
				return;
			act();
		}, DELETE_PRUNE_GRACE_MS));
	}

	// The path really is gone: drop it from both stores.
	private prune(path: string) {
		this.store.deleteFile(path);
		this.nav.deleteFile(path);
	}
}
