import type { App } from 'obsidian';
import { EphemeralState, TabStateRecord } from '@/types';
import { isEphemeralStatesEquals } from '@/shared/ephemeral-equals';
import type { CursorPositionDatabase } from './database';

// The single facade over the plugin's two position layers. Every read, write and path change goes
// through here, so the two layers cannot drift apart.
//
// Layer 1 — the FILE layer (CursorPositionDatabase, `positions.json`): one record per vault path.
//   Shared and synced: it is the position that follows you to another device.
// Layer 2 — the LEAF layer (leafStates): one record per workspace leaf, device-local, and it exists
//   for exactly one reason — the same file open in two tabs is two positions, and the file layer can
//   only hold one of them. Read precedence is per leaf: a leaf's own record wins when it names the
//   file being opened, otherwise the file record answers.
//
// What is PERSISTED of layer 2 is not the whole map but the true divergence: exactly those leaf
// records whose value differs from the file record for the same path. Everything else is already on
// disk in layer 1, so persisting it would only duplicate it (and a duplicate is a copy that can go
// stale). The overlay therefore holds, in the steady state, nothing at all — a single tab per file
// never writes to localStorage.
//
// That rule is also what makes the two layers self-healing: a rename re-keys both, a delete drops
// both, and a leaf whose value the file layer has since caught up with simply stops being persisted
// instead of pinning a position the reader has already left.

export class PositionStore {
	private app: App;
	private database: CursorPositionDatabase;
	// Last blob written to localStorage: the persist dedup, so an unchanged round (the 5s flush tick
	// when nothing diverged) costs one stringify.
	private lastPersisted = '';
	// leaf.id -> the leaf's last recorded position, path-guarded on read. The in-memory truth for
	// layer 2: the sampler's change-detection baseline and the source of a tab's own spot on restore.
	private leafStates: Map<string, TabStateRecord>;

	constructor(app: App, database: CursorPositionDatabase) {
		this.app = app;
		this.database = database;
		this.leafStates = PositionStore.loadLeafStates(app);
	}

	// Desktop localStorage is shared across vaults (same app origin); appId is the per-vault
	// discriminator. Not in the public typings. Static so the startup read can build the key before
	// an instance exists: the reader and the writer must agree on it exactly, or the persisted
	// overlay is written to a place the next session never looks.
	private static storageKeyFor(app: App): string {
		const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
		return `position-restore:tabs:${appId}`;
	}

	// Startup read. Static because it must run before the store instance exists; private because the
	// facade is the only caller that should ever see the overlay.
	private static loadLeafStates(app: App): Map<string, TabStateRecord> {
		try {
			const storageKey = PositionStore.storageKeyFor(app);
			const raw = window.localStorage.getItem(storageKey);
			if (!raw)
				return new Map();

			// Storage holds a plain object (Map does not JSON round-trip): rebuild the Map
			// explicitly, dropping malformed entries (no filePath/st) instead of trusting the parse.
			const parsed = JSON.parse(raw) as Record<string, TabStateRecord>;
			const records = new Map<string, TabStateRecord>();
			for (const [leafId, r] of Object.entries(parsed))
				if (r && typeof r.filePath === 'string' && r.st)
					records.set(leafId, r);
			return records;
		} catch (e) {
			// Unreadable storage: degrade to empty — restore falls back to the per-file database for
			// the whole session.
			console.error('Position Restore: can not read the position overlay:', e);
			return new Map();
		}
	}

	// The record to restore for (leafId, filePath): the leaf's own spot when it has one for that
	// exact file, else the file record. The path guard is what keeps a leaf that moved on to another
	// file from repositioning it.
	read(leafId: string, filePath: string): EphemeralState | undefined {
		const r = this.leafStates.get(leafId);
		return r && r.filePath === filePath ? r.st : this.database.db[filePath];
	}

	// Does the shared file layer already store exactly this position? The test behind write()'s
	// second skip and behind overlayRecords()'s definition of a divergence.
	private fileLayerHolds(filePath: string, st: EphemeralState): boolean {
		const fileSt = this.database.db[filePath];
		return fileSt !== undefined && isEphemeralStatesEquals(fileSt, st);
	}

	// Record a position for (leafId, filePath) in BOTH layers. The file layer is shared and synced,
	// so it must keep the last real divergence rather than the last tick of whichever tab polled —
	// hence the two cases that touch it only lightly: a record that has not changed, and the first
	// sighting of a value the file layer already holds.
	write(leafId: string, filePath: string, st: EphemeralState): void {
		const prev = this.leafStates.get(leafId);
		// Whether the leaf already owns a record for this file — as opposed to meeting the file for
		// the first time (no record yet, or one naming a file the leaf has since left).
		const leafOwnsFile = prev !== undefined && prev.filePath === filePath;

		// Nothing moved since the previous tick.
		if (leafOwnsFile && isEphemeralStatesEquals(prev.st, st))
			return;

		// The leaf layer always takes the value: read() prefers it, which is what keeps two tabs of
		// one file apart. The file layer follows, except when it already holds the value — possible
		// only on a first sighting.
		this.leafStates.set(leafId, { filePath, st });
		if (leafOwnsFile || !this.fileLayerHolds(filePath, st))
			this.database.setState(filePath, st);
	}

	// Forget one leaf's record (its view stopped being recordable: excluded file, a non-markdown
	// view, …). The file record is left alone — another leaf may still be showing that file.
	forgetLeaf(leafId: string): void {
		this.leafStates.delete(leafId);
	}

	// Drop every record for a path: the file record AND every leaf record that named it. Both halves
	// are mandatory — a surviving leaf record would be handed straight back by read() for the deleted
	// path, and a new file later created at the same path would restore the old file's spot.
	deleteFile(filePath: string): void {
		this.database.deleteFile(filePath);
		for (const [leafId, r] of this.leafStates)
			if (r.filePath === filePath)
				this.leafStates.delete(leafId);
	}

	// Re-key both layers with a renamed file. Without the leaf half, the path guard in read() would
	// reject every leaf that was showing the file and the per-tab split would silently collapse onto
	// the file record.
	renameFile(newPath: string, oldPath: string): void {
		this.database.renameFile(newPath, oldPath);
		for (const r of this.leafStates.values())
			if (r.filePath === oldPath)
				r.filePath = newPath;
	}

	// Drop leaf records whose leaf is gone; a closed leaf cannot update its own record (there is no
	// close event), so this is the only cleanup. liveIds is the caller's single workspace scan —
	// Restorer already walks every leaf for its other per-leaf maps.
	// @returns whether any record was dropped.
	pruneDeadLeaves(liveIds: Set<string>): boolean {
		let dropped = false;
		for (const id of this.leafStates.keys())
			if (!liveIds.has(id)) {
				this.leafStates.delete(id);
				dropped = true;
			}
		return dropped;
	}

	// Runs the file layer's own prune (excluded folders, frontmatter opt-outs, the entry cap) and
	// mirrors it onto the leaf layer: a path the file layer just rejected must not survive as a leaf
	// record either. Restore does not check the exclusion rules, so a leftover leaf record would
	// reposition a file the rules exclude — the same way a leftover db record would. It is re-recorded
	// the moment the tab moves.
	// @returns the number of file records removed, so the settings panel's entry count can use it.
	pruneDatabase(): number {
		const hadRecord = new Set(Object.keys(this.database.db));
		const removed = this.database.pruneDb();
		if (removed === 0)
			return 0;

		let droppedLeaf = false;
		for (const [leafId, r] of this.leafStates)
			if (hadRecord.has(r.filePath) && this.database.db[r.filePath] === undefined) {
				this.leafStates.delete(leafId);
				droppedLeaf = true;
			}
		// Written out at once: this runs from the settings panel, which is not a persist point, and
		// the point of the prune is that the records are gone.
		if (droppedLeaf)
			this.persist();
		return removed;
	}

	// The persisted overlay: only the leaf records that still diverge from their file record. A
	// record with no file record at all is kept too — it is then the only copy there is.
	private overlayRecords(): Record<string, TabStateRecord> {
		const records: Record<string, TabStateRecord> = {};
		for (const [leafId, r] of this.leafStates) {
			if (!r.filePath)
				continue;
			if (this.fileLayerHolds(r.filePath, r.st))
				continue;
			records[leafId] = r;
		}
		return records;
	}

	// The overlay's storage write. Sync, and deduped against the last blob.
	//
	// It runs at the same cadence as the database flush (PositionManager.storePositionData: the 5s
	// tick, quit, suspend) rather than only at quit: the overlay is the only place a
	// same-file-in-two-tabs split survives a restart, so leaving it to the quit/suspend snapshot
	// alone loses it to a crash, a force quit or a kill with the data still only in memory.
	persist(): void {
		try {
			const serialized = JSON.stringify(this.overlayRecords());
			if (serialized === this.lastPersisted)
				return;
			const storageKey = PositionStore.storageKeyFor(this.app);
			window.localStorage.setItem(storageKey, serialized);
			this.lastPersisted = serialized;
		} catch (e) {
			// Quota exceeded / storage disabled: the records stay in memory, so the current session
			// still restores per-tab — only the restart snapshot is missing.
			console.error('Position Restore: can not persist the position overlay:', e);
		}
	}
}
