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
	// path -> the leaves showing it, derived from the map above. It exists so a path
	// can be asked which leaves are on it instead of the layer being walked to find
	// out: the poll asks that of the file it is on, every 100ms, and the answer is
	// almost always no leaves at all.
	private leavesByPath = new Map<string, Set<string>>();

	constructor(app: App, database: CursorPositionDatabase) {
		this.app = app;
		this.database = database;
		this.leafStates = PositionStore.loadLeafStates(app);
		this.reindexLeaves();
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

	// Reading the leaf layer. Neither can go stale: both answer out of the map,
	// and no caller keeps what they hand back.
	private leafRecord(leafId: string): TabStateRecord | undefined {
		return this.leafStates.get(leafId);
	}

	private leafEntries(): IterableIterator<[string, TabStateRecord]> {
		return this.leafStates.entries();
	}

	// Which leaves are on a path, without walking the layer for them. Copied out
	// because both callers drop what they are handed.
	private leafIdsOnPath(filePath: string): string[] {
		const ids = this.leavesByPath.get(filePath);
		return ids ? [...ids] : [];
	}

	// Writing it. Every change goes through putLeaf() and dropLeaf() and there is
	// no third way — renameFile() re-keys by replacing a record rather than by
	// moving its path by hand.
	//
	// The index is REBUILT after a write, not patched: it is derived from the map,
	// and a patch has to know which path the leaf left, which is a second thing to
	// keep true. Rebuilding costs a walk of the tabs that are open — a write
	// happens when the reader moves, while what needs the index cheap is READING
	// it, once per poll.
	private putLeaf(leafId: string, record: TabStateRecord): void {
		this.leafStates.set(leafId, record);
		this.reindexLeaves();
	}

	private dropLeaf(leafId: string): void {
		this.leafStates.delete(leafId);
		this.reindexLeaves();
	}

	// The one place the index is maintained: rebuilt out of the map, so it cannot
	// drift from it. Runs after every write, and after the startup load — the one
	// bulk change that does not go through putLeaf().
	private reindexLeaves(): void {
		this.leavesByPath.clear();
		for (const [leafId, r] of this.leafStates) {
			const ids = this.leavesByPath.get(r.filePath);
			if (ids)
				ids.add(leafId);
			else
				this.leavesByPath.set(r.filePath, new Set([leafId]));
		}
	}

	// Two callers walk the layer and drop what matches, each for its own reason: a
	// leaf that closed, a file record the prune rejected. One walk instead of two,
	// and it drops through dropLeaf() like any other caller, so the index stays
	// true for these as well.
	// @returns whether any record was dropped.
	private dropLeavesWhere(drop: (leafId: string, record: TabStateRecord) => boolean): boolean {
		let dropped = false;
		for (const [leafId, r] of this.leafEntries())
			if (drop(leafId, r)) {
				this.dropLeaf(leafId);
				dropped = true;
			}
		return dropped;
	}

	// The record to restore for (leafId, filePath): the leaf's own spot when it has one for that
	// exact file, else the file record. The path guard is what keeps a leaf that moved on to another
	// file from repositioning it.
	read(leafId: string, filePath: string): EphemeralState | undefined {
		const r = this.leafRecord(leafId);
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
		const prev = this.leafRecord(leafId);
		// Whether the leaf already owns a record for this file — as opposed to meeting the file for
		// the first time (no record yet, or one naming a file the leaf has since left).
		const leafOwnsFile = prev !== undefined && prev.filePath === filePath;

		// Nothing moved since the previous tick.
		if (leafOwnsFile && isEphemeralStatesEquals(prev.st, st))
			return;

		// The leaf layer always takes the value: read() prefers it, which is what keeps two tabs of
		// one file apart. The file layer follows, except when it already holds the value — possible
		// only on a first sighting.
		this.putLeaf(leafId, { filePath, st });
		if (leafOwnsFile || !this.fileLayerHolds(filePath, st))
			this.database.setState(filePath, st);
	}

	// Forget one leaf's record (its view stopped being recordable: excluded file, a non-markdown
	// view, …). The file record is left alone — another leaf may still be showing that file.
	forgetLeaf(leafId: string): void {
		this.dropLeaf(leafId);
	}

	// The one act behind the two reasons below: hold nothing for a path, in either layer.
	// Both halves are mandatory — a surviving leaf record would be handed straight back
	// by read() for the path, and a file later created there would restore the old one's
	// spot.
	private dropPath(filePath: string): void {
		this.database.deleteFile(filePath);
		// Asked of the index rather than walked for: the poll asks this about the
		// file it is on, every 100ms, and the answer is almost always no leaves.
		for (const leafId of this.leafIdsOnPath(filePath))
			this.dropLeaf(leafId);
	}

	// The file is GONE: a vault delete that outlived its grace window (see
	// position/path-bookkeeping.ts).
	deleteFile(filePath: string): void {
		this.dropPath(filePath);
	}

	// The file is EXCLUDED — present, but the recording rules say no position is kept for
	// it. The same dropping, and with the same reach: what makes a record wrong is
	// per-file, so a tab that is not the one being polled loses its record too. A name of
	// its own because `deleteFile` in the sampler reads as a deletion happening there.
	dropExcluded(filePath: string): void {
		this.dropPath(filePath);
	}

	// Re-key both layers with a renamed file. Without the leaf half, the path guard in read() would
	// reject every leaf that was showing the file and the per-tab split would silently collapse onto
	// the file record.
	renameFile(newPath: string, oldPath: string): void {
		this.database.renameFile(newPath, oldPath);
		for (const leafId of this.leafIdsOnPath(oldPath)) {
			const r = this.leafRecord(leafId);
			if (r)
				this.putLeaf(leafId, { ...r, filePath: newPath });
		}
	}

	// Drop leaf records whose leaf is gone; a closed leaf cannot update its own record (there is no
	// close event), so this is the only cleanup. liveIds is the caller's single workspace scan —
	// Restorer already walks every leaf for its other per-leaf maps.
	// @returns whether any record was dropped.
	pruneDeadLeaves(liveIds: Set<string>): boolean {
		return this.dropLeavesWhere(leafId => !liveIds.has(leafId));
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

		const droppedLeaf = this.dropLeavesWhere(
			(_leafId, r) => hadRecord.has(r.filePath) && this.database.db[r.filePath] === undefined,
		);
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
		for (const [leafId, r] of this.leafEntries()) {
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
