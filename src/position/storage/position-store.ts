import type { App } from 'obsidian';
import { EphemeralState, TabStateRecord } from '@/types';
import { isEphemeralStatesEquals } from '@/shared/ephemeral-equals';
import type { CursorPositionDatabase } from './database';

// The single facade over the plugin's two position layers. Every read, write
// and path change goes through here, so the two layers cannot drift apart.
//
// Layer 1 — the FILE layer (CursorPositionDatabase, `positions.json`): one
//   record per vault path. Shared and synced: it is the position that follows
//   you to another device.
// Layer 2 — the LEAF layer (leafStates): one record per workspace leaf. It is
//   device-local and exists for exactly one reason — the same file open in two
//   tabs is two positions, and the file layer can only hold one of them.
//
// Read precedence is per leaf: a leaf's own record wins when it names the file
// being opened, otherwise the file record answers. That is the same two-level
// lookup as before; what changed is that both the lookup and the write now
// live in one place instead of being split between this storage layer and the
// sampler.
//
// What is PERSISTED of layer 2 is not the whole map but the true divergence:
// exactly those leaf records whose value differs from the file record for the
// same path. Everything else is already on disk in layer 1, so persisting it
// would only duplicate it (and a duplicate is a copy that can go stale). The
// overlay therefore holds, in the steady state, nothing at all — a single tab
// per file never writes to localStorage.
//
// That rule is also what makes the two layers self-healing: a rename re-keys
// both (renameFile), a delete drops both (deleteFile), and a leaf whose value
// the file layer has since caught up with simply stops being persisted instead
// of pinning a position the user has already left.

export class PositionStore {
	// leaf.id -> the leaf's last recorded position, path-guarded on read.
	// The in-memory truth for layer 2: the sampler's change-detection baseline
	// and the source of a tab's own spot on restore. Seeded from the persisted
	// overlay at construction.
	leafStates: Map<string, TabStateRecord> = new Map();

	private app: App;
	private database: CursorPositionDatabase;
	// Last blob written to localStorage: the persist dedup, so an unchanged
	// round (the 5s flush tick when nothing diverged) costs one stringify.
	private lastPersisted = '';

	constructor(app: App, database: CursorPositionDatabase) {
		this.app = app;
		this.database = database;
		this.leafStates = PositionStore.loadLeafStates(app);
	}

	// Desktop localStorage is shared across vaults (same app origin); appId is
	// the per-vault discriminator. Not in the public typings.
	private storageKey(): string {
		const appId = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
		return `position-restore:tabs:${appId}`;
	}

	// Startup read. Static because it must run before the store instance exists
	// (the constructor above seeds leafStates through it).
	static loadLeafStates(app: App): Map<string, TabStateRecord> {
		try {
			const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
			const raw = window.localStorage.getItem(`position-restore:tabs:${appId}`);
			if (!raw)
				return new Map();

			// Storage holds a plain object (Map does not JSON round-trip):
			// rebuild the Map explicitly, dropping malformed entries
			// (no filePath/st) instead of trusting the parse.
			const parsed = JSON.parse(raw) as Record<string, TabStateRecord>;
			const records = new Map<string, TabStateRecord>();
			for (const [leafId, r] of Object.entries(parsed))
				if (r && typeof r.filePath === 'string' && r.st)
					records.set(leafId, r);
			return records;
		} catch (e) {
			// Unreadable storage: degrade to empty — restore falls back to the
			// per-file database for the whole session.
			console.error('Position Restore: can not read the position overlay:', e);
			return new Map();
		}
	}

	// The record to restore for (leafId, filePath): the leaf's own spot when it
	// has one for that exact file, else the file record. The path guard is what
	// keeps a leaf that moved on to another file from repositioning it.
	read(leafId: string, filePath: string): EphemeralState | undefined {
		const r = this.leafStates.get(leafId);
		return r && r.filePath === filePath ? r.st : this.database.db[filePath];
	}

	// Record a position for (leafId, filePath) in BOTH layers.
	//
	// The dedup mirrors what the two writers used to do separately: an
	// unchanged leaf record is a no-op, and the first sighting of a leaf+file
	// whose value already matches the file record only seeds the baseline — no
	// database write, so opening a file and not moving records nothing.
	write(leafId: string, filePath: string, st: EphemeralState): void {
		const prev = this.leafStates.get(leafId);
		const sameFile = prev !== undefined && prev.filePath === filePath;
		if (sameFile && isEphemeralStatesEquals(prev.st, st))
			return;

		if (!sameFile) {
			const existing = this.database.db[filePath];
			if (existing && isEphemeralStatesEquals(existing, st)) {
				this.leafStates.set(leafId, { filePath, st });
				return;
			}
		}

		this.leafStates.set(leafId, { filePath, st });
		this.database.setState(filePath, st);
	}

	// Forget one leaf's record (its view stopped being recordable: excluded
	// file, a non-markdown view, ...). The file record is left alone — another
	// leaf may still be legitimately showing that file.
	forgetLeaf(leafId: string): void {
		this.leafStates.delete(leafId);
	}

	// Drop every record for a path: the file record AND every leaf record that
	// named it. Both halves are mandatory. A surviving leaf record would be
	// handed straight back by read() for the deleted path — and, worse, a new
	// file later created at the same path would restore the old file's spot.
	deleteFile(filePath: string): void {
		this.database.deleteFile(filePath);
		for (const [leafId, r] of this.leafStates)
			if (r.filePath === filePath)
				this.leafStates.delete(leafId);
	}

	// Re-key both layers with a renamed file. Without the leaf half, the path
	// guard in read() would reject every leaf that was showing the file and the
	// per-tab split would silently collapse onto the file record.
	renameFile(newPath: string, oldPath: string): void {
		this.database.renameFile(newPath, oldPath);
		for (const r of this.leafStates.values())
			if (r.filePath === oldPath)
				r.filePath = newPath;
	}

	// Drop leaf records whose leaf is gone; a closed leaf cannot update its own
	// record (there is no close event), so this is the only cleanup. liveIds is
	// the caller's single workspace scan — Restorer already walks every leaf for
	// its other per-leaf maps, so no second scan happens here.
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

	// Runs the file layer's own prune (excluded folders, frontmatter opt-outs,
	// the entry cap) and mirrors it onto the leaf layer: a path the file layer
	// just rejected must not survive as a leaf record either. Restore does not
	// check the exclusion rules, so a leftover leaf record would reposition a
	// file the rules exclude — the same way a leftover db record would, which is
	// why the db record is pruned in the first place.
	// A path that reaches the cap while its tab is open loses its leaf record
	// too; that matches the old behaviour for a singly-open file and is
	// re-recorded the moment the tab moves.
	// @returns the number of file records removed (what the caller reported
	//          before), so the settings panel's entry count can use it.
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
		// Written out at once: this runs from the settings panel, which is not a
		// persist point, and the point of the prune is that the records are gone.
		if (droppedLeaf)
			this.persist();
		return removed;
	}

	// The persisted overlay: only the leaf records that still diverge from
	// their file record. A record with no file record at all is kept too — it
	// is then the only copy there is.
	private overlayRecords(): Record<string, TabStateRecord> {
		const records: Record<string, TabStateRecord> = {};
		for (const [leafId, r] of this.leafStates) {
			if (!r.filePath)
				continue;
			const fileSt = this.database.db[r.filePath];
			if (fileSt && isEphemeralStatesEquals(fileSt, r.st))
				continue;
			records[leafId] = r;
		}
		return records;
	}

	// The overlay's storage write. Sync, and deduped against the last blob.
	//
	// It runs at the same cadence as the database flush (PositionManager.
	// storePositionData: the 5s tick, quit, suspend) — not only at quit as it
	// once did. The overlay is the only place a same-file-in-two-tabs split
	// survives a restart, so leaving it to the quit/suspend snapshot alone lost
	// it to a crash, a force quit or a kill with the data still only in memory.
	persist(): void {
		try {
			const serialized = JSON.stringify(this.overlayRecords());
			if (serialized === this.lastPersisted)
				return;
			window.localStorage.setItem(this.storageKey(), serialized);
			this.lastPersisted = serialized;
		} catch (e) {
			// Quota exceeded / storage disabled: the records stay in memory, so
			// the current session still restores per-tab — only the restart
			// snapshot is missing.
			console.error('Position Restore: can not persist the position overlay:', e);
		}
	}
}
