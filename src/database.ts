import { App, Notice, TFile } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { frontmatterDecisionFor } from './frontmatter';
import type RememberCursorPosition from '../main';
import { t } from './i18n';

export type CursorDatabase = { [file_path: string]: EphemeralState };

// Hard cap on stored entries. Keeps the data file well under 100 KB regardless
// of vault size; trimming to 3/4 of the cap adds hysteresis so pruning does not
// churn on every write once the cap is reached.
const MAX_ENTRIES = 750;
const TRIM_TARGET = Math.floor(MAX_ENTRIES * 3 / 4);

// On-disk compact record, scroll first, length decides shape (no sentinels):
//   [scroll]                           -> no cursor (incl. a collapsed cursor at
//                                          (0,0), which is the editor default)
//   [scroll, line, ch]                 -> single-point cursor (from === to)
//   [scroll, line, ch, to.line, to.ch] -> selection
// The first slot is dual-meaning: markdown saves the quantized top visible
// line; the Bases view (the only other recordable FileView, opt-in via
// recordBaseScroll — pdf/image/canvas are never recorded) saves the
// scroller's raw scrollTop.
// A file path is always exactly one kind and only ever produces scroll-only
// or cursor records — never mixed — so the shape stays unambiguous.
// A [0] record is a tombstone: nothing to restore, but its presence in the
// in-memory db marks the file as visited for the rest of the session, so the
// defaultPosition setting does not kick in again. Tombstones are never
// persisted: on disk they would be indistinguishable from "never visited",
// and defaultPosition only matters for a file's first open anyway.
// Restore only scrolls when scroll > 0, so scroll <= 0 acts as "don't scroll".
function encodeValue(st: EphemeralState): number[] {
	const scroll = st.scroll ?? 0;
	if (!st.cursor)
		return [scroll];
	const { from, to } = st.cursor;
	if (from.line === to.line && from.ch === to.ch)
		return [scroll, from.line, from.ch];
	return [scroll, from.line, from.ch, to.line, to.ch];
}

function decodeValue(arr: number[]): EphemeralState {
	// Corrupted disk data must not leak NaN/undefined into records: a
	// non-finite scroll would silently disable restore, a broken cursor
	// could be handed to setEphemeralState.
	if (!Array.isArray(arr) || arr.some((n) => !Number.isFinite(n)))
		return {};
	const st: EphemeralState = {};

	if (arr[0] > 0)
		st.scroll = arr[0];

	if (arr.length === 3) {
		const p = { line: arr[1], ch: arr[2] };
		st.cursor = { from: p, to: p };
	} else if (arr.length >= 5) {
		st.cursor = {
			from: { line: arr[1], ch: arr[2] },
			to: { line: arr[3], ch: arr[4] },
		};
	}
	return st;
}

export class CursorPositionDatabase {
	db: CursorDatabase = {};
	dbDirty: boolean = false;

	// Multi-device sync support. An external sync client (坚果云 / Remotely
	// Save / iCloud / Obsidian Sync…) may replace the db file while we run.
	// lastDiskMtime caches the mtime we last observed after our own read or
	// write; a different value on the next stat() means the file was changed
	// behind our back and mergeExternalChanges() must reconcile it. Paired
	// with keyTouchedAt/lastFlushTime this resolves shared-key conflicts
	// without changing the on-disk format: a key touched locally after our
	// last flush is definitely newer than anything on disk, everything else
	// yields to the (newer) external file.
	private lastDiskMtime = 0;
	private lastFlushTime = 0;
	private keyTouchedAt = new Map<string, number>();

	// Reentrancy guard: the window-focus trigger and writeDb()'s pre-flush
	// merge can overlap; two concurrent read-modify passes over this.db
	// would interleave and corrupt the mtime bookkeeping.
	private merging = false;

	// Tracks the last key in insertion order. Used so setState() can skip the
	// delete+insert (which moves a key to the end to mark it fresh) when the key
	// is already the most recently touched one — i.e. while editing one file.
	private lastKey: string | null = null;

	private app: App;
	private plugin: RememberCursorPosition;
	private manifestDir: string;
	private settings: PluginSettings;

	constructor(
		plugin: RememberCursorPosition,
		settings: PluginSettings
	) {
		this.app = plugin.app;
		this.plugin = plugin;
		this.manifestDir = plugin.manifest.dir!;
		this.settings = settings;
	}

	get defaultDbFileName(): string {
		return this.manifestDir + '/positions.json';
	}

	private getDbPath(): string {
		return this.settings.dbFileName || this.defaultDbFileName;
	}

	// Ensures the parent folder of the configured db path exists. If it can't
	// be created, falls back to the default path (manifest folder) and notifies
	// the user.
	// @returns true if the configured path is usable unchanged; false if the
	//          setting was changed to the default (callers should save settings).
	private async ensureDbFolder(): Promise<void> {
		const dbPath = this.getDbPath();
		const parentFolder = dbPath.substring(0, dbPath.lastIndexOf("/"));

		// No parent folder - root folder — nothing to create.
		if (!parentFolder)
			return;

		try {
			if (!(await this.app.vault.adapter.exists(parentFolder)))
				await this.app.vault.adapter.mkdir(parentFolder);
		} catch (e) {
			console.error("Can't create db folder:", e);
			this.settings.dbFileName = '';
			void this.plugin.saveSettings();
		}
	}

	// Switch the database file to newPath; an empty newPath resets to the
	// default location (manifest folder), keeping settings.dbFileName as ''.
	// newPath may also be a bare file name, which places the db at the vault
	// root (adapter paths are vault-relative). Validation first: format check
	// and the parent folder must already exist (no auto-creation) — each
	// failure is surfaced to the user via a Notice here.
	// If the target file already exists it is usually a db file synced from
	// another device, so instead of refusing, it is parsed and adopted: its
	// records are merged into the in-memory db with the same conflict rule as
	// mergeExternalChanges() (disk wins, except keys touched locally after
	// our last flush), and the old file is removed — the same end state as a
	// move. Only an unreadable target still blocks the switch.
	// On success settings.dbFileName is updated; the caller should persist
	// settings afterwards.
	// @returns true on success (including "already using newPath").
	async switchDbFile(newPath: string): Promise<boolean> {
		const targetPath = newPath === '' ? this.defaultDbFileName : newPath;
		if (!targetPath.endsWith('.json') || targetPath.startsWith('/') || targetPath.includes('\\')
			|| targetPath.split('/').includes('..')) {
			new Notice(t('dbInvalid'));
			return false;
		}

		const adapter = this.app.vault.adapter;
		const currentPath = this.getDbPath();
		if (targetPath === currentPath)
			return true;

		// Parses an already-existing target file and merges it into the
		// in-memory db; removes the old db file once its records are merged
		// (move semantics). @returns the number of records adopted from disk,
		// or null when the target is unreadable — then the caller refuses.
		const adoptExisting = async (): Promise<number | null> => {
			try {
				const diskDb = this.parseDb(await adapter.read(targetPath));
				// The old file must go, or its stale copy would linger next to
				// the adopted one; do it before mutating in-memory state so a
				// failure here aborts the whole switch cleanly.
				if (await adapter.exists(currentPath))
					await adapter.remove(currentPath);

				const adopted = this.mergeDiskDb(diskDb);
				// The merged records must reach the new file; flush happens on
				// the next natural write (the settings save that follows).
				this.dbDirty = true;
				return adopted;
			} catch (e) {
				console.error("Can't adopt existing database file:", e);
				return null;
			}
		};

		try {
			// No slash → vault root: the adapter writes directly there, so
			// there is no parent folder to check.
			const slash = targetPath.lastIndexOf('/');
			const parent = slash === -1 ? '' : targetPath.substring(0, slash);
			if (parent && !(await adapter.exists(parent))) {
				new Notice(t('dbNoFolder'));
				return false;
			}
			if (await adapter.exists(targetPath)) {
				const adopted = await adoptExisting();
				if (adopted === null) {
					new Notice(t('dbExists'));
					return false;
				}
				new Notice(t('dbMerged', String(adopted)));
			} else if (await adapter.exists(currentPath)) {
				// Atomic move; rename fails if the target exists, which the
				// adoptExisting branch above has already ruled out.
				await adapter.rename(currentPath, targetPath);
			}
		} catch (e) {
			console.error("Can't switch database file:", e);
			new Notice(t('dbMoveFailed', String(e)));
			return false;
		}

		// lastDiskMtime cached the OLD path's mtime; re-cache against the new
		// path so the next external-change check compares like with like.
		this.lastDiskMtime = 0;
		await this.cacheDiskMtime();

		return true;
	}

	//----------------------------------------------------------------------------------------

	pruneDb(): number {
		const beforeLength = Object.keys(this.db).length;

		this.removeExcludedFolders();
		this.removeFrontmatterExcluded();

		this.trimToLimit();

		const removed = beforeLength - Object.keys(this.db).length;
		if (removed > 0) this.dbDirty = true;
		return removed;
	}

	// Always drop records for files in excluded folders: restore does not
	// check exclusions, so stale records there would wrongly re-position.
	private removeExcludedFolders(): void {
		const excludedFolders = this.settings.excludedFolders;
		if (excludedFolders.length === 0)
			return;
		for (const key of Object.keys(this.db)) {
			if (excludedFolders.some((folder) =>
				key === folder || key.startsWith(folder + '/')
			)) {
				delete this.db[key];
			}
		}
	}

	// Same rationale as removeExcludedFolders for frontmatter-based exclusion
	// (escape hatch `position-restore: false` or the configured B property
	// present): restore does not check frontmatter, so a stale record would
	// wrongly re-position. Files the metadata cache has not parsed yet (lazy
	// parsing) are skipped here — the recording gate drops their record on the
	// next open/poll once the metadata lands.
	private removeFrontmatterExcluded(): void {
		for (const key of Object.keys(this.db)) {
			const file = this.app.vault.getAbstractFileByPath(key);
			if (!(file instanceof TFile))
				continue;
			const decision = frontmatterDecisionFor(this.app, file, this.settings);
			if (decision?.skip)
				delete this.db[key];
		}
	}

	// Record a position for filePath. If the key is already the most recently
	// touched (lastKey), overwrite in place — no delete+insert, which would
	// needlessly churn the V8 object shape. Otherwise delete+insert to move it
	// to the end of insertion order, so trimToLimit keeps it as "fresh".
	setState(filePath: string, st: EphemeralState): void {
		const existed = this.db[filePath] !== undefined;
		if (existed && filePath === this.lastKey) {
			this.db[filePath] = st;
		} else {
			if (existed) delete this.db[filePath];
			this.db[filePath] = st;
			this.lastKey = filePath;
		}
		this.keyTouchedAt.set(filePath, Date.now());
		this.dbDirty = true;
	}

	// If the database exceeds MAX_ENTRIES, drops the oldest entries down to
	// TRIM_TARGET (3/4 of the cap) to add hysteresis. Recency is the insertion
	// order: setState() always moves a touched key to the end, so the tail holds
	// the most-recently-modified files. Keeping the tail is equivalent to the
	// old lastModified-based LRU but needs no timestamp.
	private trimToLimit(): void {
		if (Object.keys(this.db).length <= MAX_ENTRIES)
			return;

		const entries = Object.entries(this.db);
		const kept = entries.slice(entries.length - TRIM_TARGET);
		this.db = Object.fromEntries(kept);

		// Dropped entries leave orphans in the touch-stamp map; prune them so
		// it can't grow without bound across long sessions in vaults far
		// larger than the cap.
		for (const key of this.keyTouchedAt.keys())
			if (this.db[key] === undefined)
				this.keyTouchedAt.delete(key);
	}

	async readDb(): Promise<void> {
		this.lastDiskMtime = 0;

		if (!(await this.app.vault.adapter.exists(this.getDbPath()))) {
			this.db = {};
			return;
		}

		try {
			const data = await this.app.vault.adapter.read(this.getDbPath());
			this.db = this.parseDb(data);
			await this.cacheDiskMtime();
		} catch (e) {
			console.error("Can't read database:", e);
			this.db = {};
		}
	}

	// Parses raw db file content into the in-memory map. Shared by the startup
	// read and the external-change merge. A malformed file (not an object)
	// degrades to an empty db.
	private parseDb(data: string): CursorDatabase {
		const parsed: unknown = JSON.parse(data);
		const raw: Record<string, unknown> =
			parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
		const db: CursorDatabase = {};
		for (const key of Object.keys(raw)) {
			const value = raw[key];
			if (Array.isArray(value))
				db[key] = decodeValue(value as number[]);
		}
		return db;
	}

	private async cacheDiskMtime(): Promise<void> {
		try {
			const st = await this.app.vault.adapter.stat(this.getDbPath());
			this.lastDiskMtime = st ? st.mtime : 0;
		} catch {
			this.lastDiskMtime = 0;
		}
	}

	// Reconciles a freshly-parsed disk db against the in-memory one, per key:
	//   disk-only keys   -> adopted
	//   memory-only keys -> kept (ours, incl. session-only tombstones)
	//   shared keys      -> disk wins, unless the key was touched locally
	//                       after our last flush (then ours is definitely
	//                       newer — the disk copy predates our flush)
	// Replaces this.db with the merged result and resets lastKey.
	// @returns the number of disk records that survived the merge.
	private mergeDiskDb(diskDb: CursorDatabase): number {
		let adopted = Object.keys(diskDb).length;
		for (const key of Object.keys(this.db)) {
			const localTouched = (this.keyTouchedAt.get(key) ?? 0) > this.lastFlushTime;
			if (diskDb[key] === undefined || localTouched) {
				if (diskDb[key] !== undefined)
					adopted--;
				diskDb[key] = this.db[key];
			}
		}
		this.db = diskDb;
		this.lastKey = null;
		return adopted;
	}

	// Picks up a db file replaced externally by a device-sync client while we
	// run. A stat() whose mtime differs from our cached value means the file
	// changed behind our back; read it and reconcile per key (see
	// mergeDiskDb for the conflict rule).
	// Never marks the db dirty: adopted records are already on disk, and kept
	// local records ride out on the next natural flush. merge is a no-op (one
	// stat call) when nothing changed. A file that is torn mid-sync fails
	// JSON.parse, keeps its old mtime cache, and is retried on a later check.
	async mergeExternalChanges(): Promise<void> {
		if (this.merging)
			return;
		this.merging = true;
		try {
			let mtime: number;
			try {
				const st = await this.app.vault.adapter.stat(this.getDbPath());
				if (!st)
					return; // file missing — nothing to merge, keep what we have
				mtime = st.mtime;
			} catch {
				return; // file unreadable — keep what we have
			}
			if (mtime === this.lastDiskMtime)
				return;

			try {
				const data = await this.app.vault.adapter.read(this.getDbPath());
				this.mergeDiskDb(this.parseDb(data));
				this.lastDiskMtime = mtime;
			} catch (e) {
				console.error("Can't merge external db changes:", e);
			}
		} finally {
			this.merging = false;
		}
	}

	async writeDb() {
		if (!this.dbDirty) return;

		// Another device may have replaced the file since we last looked;
		// merge first so our whole-file write doesn't clobber its records.
		await this.mergeExternalChanges();

		// Keep the file bounded even across long sessions (pruning also runs on
		// startup); no-op unless the cap is exceeded.
		this.trimToLimit();

		const encoded: { [path: string]: number[] } = {};
		for (const key of Object.keys(this.db)) {
			const st = this.db[key];
			// Skip empty records (no cursor, no positive scroll): restoring
			// them is a no-op, same as having no record at all. The only thing
			// they would preserve is "this file was already visited" for
			// defaultPosition — not worth dead entries on disk.
			if (!st.cursor && (st.scroll ?? 0) <= 0)
				continue;
			encoded[key] = encodeValue(st);
		}
		const data = JSON.stringify(encoded);
		const dbPath = this.getDbPath();

		try {
			// Fast path: the folder (almost always) already exists.
			await this.app.vault.adapter.write(dbPath, data);
		} catch {
			// Slow path: folder likely missing — ensure it (or fall back to the
			// default path) and retry once.
			await this.ensureDbFolder();
			try {
				await this.app.vault.adapter.write(this.getDbPath(), data);
			} catch (e2) {
				console.error("Can't write database:", e2);
				return;
			}
		}

		// Our own write changed the file on disk — re-cache its mtime so our
		// next external-change check doesn't mistake this write for someone
		// else's. lastFlushTime marks "everything touched before this moment
		// is already on disk"; only keys touched after it may override disk
		// copies during a merge.
		await this.cacheDiskMtime();
		this.lastFlushTime = Date.now();
		this.dbDirty = false;
	}

	renameFile(newPath: string, oldPath: string) {
		if (!this.db[oldPath])
			return;
		this.db[newPath] = this.db[oldPath];
		delete this.db[oldPath];
		const touchedAt = this.keyTouchedAt.get(oldPath);
		if (touchedAt !== undefined) {
			this.keyTouchedAt.delete(oldPath);
			this.keyTouchedAt.set(newPath, touchedAt);
		}
		this.dbDirty = true;
	}

	deleteFile(path: string) {
		if (!this.db[path])
			return;
		delete this.db[path];
		this.keyTouchedAt.delete(path);
		this.dbDirty = true;
	}
}
