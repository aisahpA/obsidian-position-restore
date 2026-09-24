import { App, Notice, TFile } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { frontmatterDecisionFor } from '@/position/policy/frontmatter';
import { stickyNotice } from '@/shared/notice';
import type PositionRestorePlugin from '@/main';
import { t } from '@/i18n';

export type CursorDatabase = { [file_path: string]: EphemeralState };

// Keeps the data file well under 100 KB regardless of vault size; trimming to
// 3/4 of the cap adds hysteresis so pruning doesn't churn on every write.
const MAX_ENTRIES = 750;
const TRIM_TARGET = Math.floor(MAX_ENTRIES * 3 / 4);

// On-disk compact record, scroll first, length decides shape (no sentinels):
//   [scroll]                           -> no cursor (incl. a collapsed cursor
//                                          at (0,0), the editor default)
//   [scroll, line, ch]                 -> single-point cursor (from === to)
//   [scroll, line, ch, to.line, to.ch] -> selection
// The first slot is dual-meaning: markdown saves the quantized top visible
// line; the Bases view (the only other recordable FileView, opt-in via
// recordBaseScroll — pdf/image/canvas are never recorded) saves the
// scroller's raw scrollTop. A path is always exactly one kind, so the shape
// stays unambiguous. A [0] record is a tombstone: nothing to restore, but its
// presence marks the file visited for the session, so defaultPosition doesn't
// kick in again — tombstones are never persisted, since on disk they'd be
// indistinguishable from "never visited". Restore only scrolls when
// scroll > 0, so scroll <= 0 means "don't scroll".
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
	// non-finite scroll would silently disable restore.
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

	// Monotonic mutation counter. writeDb snapshots it before serializing and
	// clears dbDirty only when it is unchanged after the write — a setState
	// landing mid-flush keeps the db dirty instead of losing its record.
	private rev = 0;

	// Multi-device sync: an external sync client may replace the db file while
	// we run. lastDiskMtime caches the mtime observed after our own read or
	// write; a different value on the next stat() means the file changed
	// behind our back. Paired with keyTouchedAt/lastFlushTime this resolves
	// shared-key conflicts without changing the on-disk format: a key touched
	// locally after our last flush is definitely newer than anything on disk,
	// everything else yields to the external file.
	private lastDiskMtime = 0;
	private lastFlushTime = 0;
	private keyTouchedAt = new Map<string, number>();

	// Reentrancy serialization: the flush-tick merge and writeDb()'s pre-flush
	// merge can overlap; two concurrent read-modify passes would interleave and
	// corrupt the mtime bookkeeping. Each caller queues behind the in-flight
	// pass — a concurrent caller is never dropped, since skipping writeDb()'s
	// reconcile would clobber a newer foreign file.
	private mergeChain: Promise<void> = Promise.resolve();

	// Unreadable content (torn write, sync conflict markers, a foreign file) is
	// never dropped silently: it is copied aside and reported. Deduping on the
	// content keeps the retry loop from spawning one copy per merge pass;
	// distinct content is a distinct corruption. corruptCopySeq keeps two
	// copies made in the same millisecond off the same path.
	private preservedCorrupt: string | null = null;
	private corruptNotified = false;
	private corruptCopySeq = 0;

	// Tracks the last key in insertion order, so setState() can skip the
	// delete+insert (which moves a key to the end to mark it fresh) while
	// editing one file.
	private lastKey: string | null = null;

	private app: App;
	private plugin: PositionRestorePlugin;
	private manifestDir: string;
	private settings: PluginSettings;

	constructor(
		plugin: PositionRestorePlugin,
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

	// Next to the plugin, not next to the db (which usually sits in a synced
	// folder inside the vault, where a leftover copy would be picked up as
	// content). The sequence number, not the timestamp, makes the name unique.
	private corruptCopyPath(): string {
		const base = this.getDbPath().split('/').pop() ?? 'positions.json';
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		return `${this.manifestDir}/${base.replace(/\.json$/i, '')}.corrupt-${stamp}-${++this.corruptCopySeq}.json`;
	}

	// If the parent folder can't be created, fall back to the default path and
	// notify the user.
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
	// default location, keeping settings.dbFileName as ''. A bare file name
	// places the db at the vault root (adapter paths are vault-relative).
	// A target that already exists is usually a db synced from another device,
	// so instead of refusing: parse and adopt it, merging its records with the
	// same conflict rule as mergeExternalChanges() (disk wins, except keys
	// touched locally after our last flush), then remove the old file — the
	// same end state as a move. Only an unreadable target blocks the switch.
	// The caller should persist settings afterwards.
	// @returns true on success (including "already using newPath").
	async switchDbFile(newPath: string): Promise<boolean> {
		const targetPath = newPath === '' ? this.defaultDbFileName : newPath;
		if (!targetPath.endsWith('.json') || targetPath.startsWith('/') || targetPath.includes('\\')
			|| targetPath.split('/').includes('..')) {
			new Notice(t('dataStorage.dbFileName.messages.invalid'));
			return false;
		}

		const adapter = this.app.vault.adapter;
		const currentPath = this.getDbPath();
		if (targetPath === currentPath)
			return true;

		// @returns the number of records adopted, or null when the target is
		// unreadable — then the caller refuses.
		const adoptExisting = async (): Promise<number | null> => {
			try {
				// Strict shape check first: a wrong JSON file picked by mistake
				// (package.json, a snippet) would otherwise be read as a
				// near-empty db and the real file deleted below — data loss.
				const diskDb = this.parseDbStrict(await adapter.read(targetPath));
				if (diskDb === null)
					return null;
				// The old file must go, or its stale copy would linger next to
				// the adopted one; before mutating in-memory state, so a
				// failure here aborts the whole switch cleanly.
				if (await adapter.exists(currentPath))
					await adapter.remove(currentPath);

				const adopted = this.mergeDiskDb(diskDb);
				// The merged records reach the new file on the next natural
				// write (the settings save that follows).
				this.markDirty();
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
			if (parent && !(await adapter.exists(parent)))
				await adapter.mkdir(parent);
			if (await adapter.exists(targetPath)) {
				const adopted = await adoptExisting();
				if (adopted === null) {
					new Notice(t('dataStorage.dbFileName.messages.exists'));
					return false;
				}
				new Notice(t('dataStorage.dbFileName.messages.merged', String(adopted)));
			} else if (await adapter.exists(currentPath)) {
				// Atomic move; rename fails if the target exists, which the
				// adoptExisting branch above has already ruled out.
				await adapter.rename(currentPath, targetPath);
			}
		} catch (e) {
			console.error("Can't switch database file:", e);
			new Notice(t('dataStorage.dbFileName.messages.moveFailed', String(e)));
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
		if (removed > 0) this.markDirty();
		return removed;
	}

	// Restore does not check exclusions, so stale records there would wrongly
	// re-position.
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

	// Same rationale for frontmatter exclusion (`position-restore: false`, or
	// the configured B property present). Files the metadata cache has not
	// parsed yet are skipped — the recording gate drops their record on the
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

	// Every site that dirties the db goes through here so writeDb can detect a
	// mutation landing mid-flush (see rev).
	private markDirty(): void {
		this.dbDirty = true;
		this.rev++;
	}

	// If the key is already the most recently touched (lastKey), overwrite in
	// place — no delete+insert, which would needlessly churn the V8 object
	// shape. Otherwise delete+insert to move it to the end of insertion order,
	// so trimToLimit keeps it as "fresh".
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
		this.markDirty();
	}

	// Recency is the insertion order: setState() always moves a touched key to
	// the end, so the tail holds the most-recently-modified files — no
	// timestamp needed.
	private trimToLimit(): void {
		if (Object.keys(this.db).length <= MAX_ENTRIES)
			return;

		const entries = Object.entries(this.db);
		const kept = entries.slice(entries.length - TRIM_TARGET);
		this.db = Object.fromEntries(kept);

		// Dropped entries leave orphans in the touch-stamp map; prune them so
		// it can't grow without bound across long sessions.
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

		let data: string;
		try {
			data = await this.app.vault.adapter.read(this.getDbPath());
		} catch (e) {
			// Unreadable (permissions, a folder in the way): there is no
			// content to preserve, and no copy could be written either.
			console.error("Can't read database:", e);
			this.db = {};
			return;
		}

		try {
			this.db = this.parseDb(data);
			await this.cacheDiskMtime();
		} catch (e) {
			// The file exists but holds something else: clearing the in-memory
			// db is unavoidable (the records are unreachable), but the bytes
			// are kept aside first — the next flush writes a valid file, which
			// also repairs what the sync client merged.
			console.error("Can't read database:", e);
			this.db = {};
			await this.preserveUnreadableDb(data, e);
		}
	}

	// Shared by the startup read and the external-change merge. Throws on
	// anything that is not a JSON object (torn write, conflict markers, a
	// foreign file): it never quietly becomes an empty db.
	private parseDb(data: string): CursorDatabase {
		const parsed: unknown = JSON.parse(data);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new Error('database content is not a JSON object');
		const raw = parsed as Record<string, unknown>;
		const db: CursorDatabase = {};
		for (const key of Object.keys(raw)) {
			const value = raw[key];
			if (Array.isArray(value))
				db[key] = decodeValue(value as number[]);
		}
		return db;
	}

	// A parse failure makes those records unreachable for this session, and the
	// next flush overwrites the file with what we do have — so this copy (plus
	// the sync client's version history) is what keeps the loss recoverable.
	// The copy is written before the notice, so the notice can point at a file
	// that exists. A failed copy is reported too: that is the one case where
	// the records really are gone. Both notices are sticky — this can happen
	// while the user is elsewhere, and the outcome outlives any toast.
	private async preserveUnreadableDb(data: string, reason: unknown): Promise<void> {
		if (data === this.preservedCorrupt)
			return;
		this.preservedCorrupt = data;

		const path = this.corruptCopyPath();
		let kept = true;
		try {
			await this.app.vault.adapter.write(path, data);
		} catch (e) {
			kept = false;
			console.error("Can't keep a copy of the unreadable database:", e);
		}
		console.error(kept
			? `Position Restore: unreadable database file, kept a copy at ${path}`
			: 'Position Restore: unreadable database file, and no copy could be written', reason);

		if (this.corruptNotified)
			return;
		this.corruptNotified = true;
		stickyNotice(kept
			? t('dataStorage.corruptDb.notice', path)
			: t('dataStorage.corruptDb.noticeNoCopy'));
	}

	// Strict shape check for adopting a target file: accepts only a JSON
	// object whose every value is an array of finite numbers AND whose every
	// key is a recordable note path (.md / .base) — exactly what writeDb emits
	// (an empty `{}` included). The key check is what rejects a foreign JSON
	// that happens to hold numeric arrays (chart series, vectors); the value
	// check alone would let it through and delete the real file.
	// @returns the parsed db, or null when the content is not a position db.
	private parseDbStrict(data: string): CursorDatabase | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return null;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			return null;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			const lower = key.toLowerCase();
			if (!lower.endsWith('.md') && !lower.endsWith('.base'))
				return null;
			if (!Array.isArray(value) || value.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
				return null;
		}
		return this.parseDb(data);
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
	//                       after our last flush (then ours is newer — the
	//                       disk copy predates our flush)
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

	// Picks up a db file replaced externally while we run: a stat() whose mtime
	// differs from our cached value means it changed behind our back.
	// Never marks the db dirty: adopted records are already on disk, and kept
	// local records ride out on the next natural flush. A file torn mid-sync
	// fails JSON.parse, keeps its old mtime cache, and is retried later.
	async mergeExternalChanges(): Promise<void> {
		const pass = this.mergeChain.then(() => this.runMergePass());
		this.mergeChain = pass.catch(() => {});
		await pass;
	}

	// Guarded so it never throws (torn file / unreadable); the chain wrapper
	// only serializes, it does not add retry semantics.
	private async runMergePass(): Promise<void> {
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

		let data: string;
		try {
			data = await this.app.vault.adapter.read(this.getDbPath());
		} catch (e) {
			console.error("Can't merge external db changes:", e);
			return;
		}

		try {
			this.mergeDiskDb(this.parseDb(data));
			this.lastDiskMtime = mtime;
		} catch (e) {
			// Someone replaced the file with content we cannot parse (a torn
			// download, conflict markers, a half-written push). Keep our
			// records and a copy of theirs: the flush that follows replaces the
			// file with ours.
			console.error("Can't merge external db changes:", e);
			await this.preserveUnreadableDb(data, e);
		}
	}

	async writeDb() {
		if (!this.dbDirty) return;

		// Another device may have replaced the file since we last looked;
		// merge first so our whole-file write doesn't clobber its records.
		await this.mergeExternalChanges();

		// No-op unless the cap is exceeded.
		this.trimToLimit();

		// Snapshot the revision and wall-clock moment right before
		// serializing: everything mutated at or before this instant IS in
		// `data`, anything landing during the awaits below must not be cleared
		// by this flush and must still read as "touched after our last flush"
		// for the next merge. rev catches the former (dbDirty below);
		// lastFlushTime stamped HERE, not after the write, makes the latter
		// hold.
		const flushedThrough = Date.now();
		const rev = this.rev;

		const encoded: { [path: string]: number[] } = {};
		for (const key of Object.keys(this.db)) {
			const st = this.db[key];
			// Skip empty records (no cursor, no positive scroll): restoring
			// them is a no-op. The only thing they'd preserve is "already
			// visited" for defaultPosition — not worth dead entries on disk.
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
			// Slow path: folder likely missing — ensure it (or fall back to
			// the default path) and retry once.
			await this.ensureDbFolder();
			try {
				await this.app.vault.adapter.write(this.getDbPath(), data);
			} catch (e2) {
				// Nothing hit disk: leave dbDirty/lastFlushTime untouched so a
				// later flush retries the same records.
				console.error("Can't write database:", e2);
				return;
			}
		}

		// Our own write changed the file — re-cache its mtime so the next
		// external-change check doesn't mistake this write for someone else's.
		// dbDirty is cleared only when no mutation landed while the flush was
		// in flight: a mid-flush setState keeps the db dirty so the next flush
		// persists it, and its keyTouchedAt stays beyond lastFlushTime so it
		// wins any intervening external merge.
		await this.cacheDiskMtime();
		this.lastFlushTime = flushedThrough;
		this.dbDirty = rev !== this.rev;
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
		this.markDirty();
	}

	deleteFile(path: string) {
		if (!this.db[path])
			return;
		delete this.db[path];
		this.keyTouchedAt.delete(path);
		this.markDirty();
	}
}
