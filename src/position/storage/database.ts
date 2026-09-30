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

// How many of the newest entries recency protects from the tombstone-first
// eviction below. Sized as a fraction of the cap so the two move together.
const TOMB_RECENT_WINDOW = Math.floor(MAX_ENTRIES / 4);

// On-disk shape version; both are read, only schema 2 is written. Bump it only
// when the SHAPE changes — adding an optional field is not a bump, since
// unknown fields are ignored on read. The file is rewritten wholesale on every
// flush, so the last writer owns all of it and a version number inside the
// file cannot protect it: a stale writer overwrites that too.
//   schema 1: {"a.md": [scroll, line, ch, toLine, toCh]} — the array's LENGTH
//             was the type tag (1 no cursor, 3 a point, 5 a selection), which
//             left no way to add a field an older reader would not misread.
//   schema 2: {"schema": 2, "positions": {"a.md": {"s": 120, "c": [l,ch,tl,tc],
//             "t": 1770000000000}}} — `t` says when the position was recorded,
//               and it is what settles a key two devices both hold.
//             — a record with neither `s` nor `c` is a tombstone: the note was
//               visited and left at the top, unlike never having a record.
const SCHEMA_VERSION = 2;

// `s` is dual-meaning exactly as EphemeralState.scroll is: markdown saves the
// quantized top visible line, the Bases view (the only other recordable
// FileView, opt-in via recordBaseScroll — pdf/image/canvas are never recorded)
// saves the scroller's raw scrollTop. `c` is always the full cursor, from then
// to — never length-tagged, never partial.
interface PositionRecord {
	s?: number;
	c?: number[];
	t?: number;
}

// The cursor says nothing when it sits where Obsidian opens the note: line 0
// for a file without frontmatter, otherwise the line right AFTER the frontmatter
// block — ON that line even when it is blank, which is the common case (85% of
// the notes in a measured vault have a blank line there, and 10 of 10 untouched
// opens sat on it, none on the first non-blank line). `defaultLine` undefined =
// unknown (file gone, metadata not parsed yet) — then only (0,0) counts.
function cursorIsDefault(cursor: EphemeralState['cursor'], defaultLine: number | undefined): boolean {
	if (!cursor)
		return true;
	if (cursor.from.ch !== 0 || cursor.to.ch !== 0 || cursor.from.line !== cursor.to.line)
		return false;
	return cursor.from.line === (defaultLine ?? 0);
}

// Restore only scrolls when scroll > 0, so a non-positive scroll is not stored;
// what is left is then the tombstone described above — no `s` therefore means
// "at the top", not "unknown". A `c`-only record is normally a genuine position
// (a short note fits the viewport with the cursor well below its top) — except
// when the cursor is the open-default above, which is what a note that was
// merely opened leaves behind; that one is written as `{}`.
function encodeValue(st: EphemeralState, defaultLine: number | undefined): PositionRecord {
	const rec: PositionRecord = {};
	const scroll = st.scroll ?? 0;
	if (scroll > 0)
		rec.s = scroll;
	const c = st.cursor;
	// Only an at-the-top record is judged: with a scroll, the cursor is stored
	// as it is.
	if (c && (scroll > 0 || !cursorIsDefault(c, defaultLine)))
		rec.c = [c.from.line, c.from.ch, c.to.line, c.to.ch];
	if (st.time !== undefined)
		rec.t = st.time;
	return rec;
}

// Unknown fields are ignored rather than rejected: a file written by a newer
// plugin version must still yield the positions it shares with us.
function decodeValue(value: unknown): EphemeralState {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return {};
	const rec = value as { s?: unknown; c?: unknown; t?: unknown };
	const st: EphemeralState = {};

	// Corrupted disk data must not leak NaN/undefined into records: a
	// non-finite scroll would silently disable restore.
	if (typeof rec.s === 'number' && Number.isFinite(rec.s) && rec.s > 0)
		st.scroll = rec.s;
	if (typeof rec.t === 'number' && Number.isFinite(rec.t))
		st.time = rec.t;

	const c = rec.c;
	if (Array.isArray(c) && c.length >= 4 && c.every((n) => typeof n === 'number' && Number.isFinite(n))) {
		const [fromLine, fromCh, toLine, toCh] = c as number[];
		const from = { line: fromLine, ch: fromCh };
		const to = { line: toLine, ch: toCh };
		if (!cursorIsDefault({ from, to }, undefined))
			st.cursor = { from, to };
	}
	return st;
}

// schema 1: files written by an older plugin — here before an update, or on
// another device still running one — stay readable.
function decodeArrayValue(value: unknown): EphemeralState {
	if (!Array.isArray(value) || value.some((n) => !Number.isFinite(n)))
		return {};
	const arr = value as number[];
	const st: EphemeralState = {};
	if (arr[0] > 0)
		st.scroll = arr[0];
	if (arr.length === 3) {
		const p = { line: arr[1], ch: arr[2] };
		st.cursor = { from: p, to: p };
	} else if (arr.length >= 5) {
		st.cursor = { from: { line: arr[1], ch: arr[2] }, to: { line: arr[3], ch: arr[4] } };
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
	// behind our back. A key both sides hold is then settled per record by
	// its capture stamp (see mergeDiskDb) — not by when we last flushed.
	private lastDiskMtime = 0;

	// The schema of the file as last read. Paired with the notified flags it
	// separates "this file was already old when we started" from "our own
	// current file was just replaced by an older writer" — only the second is
	// fresh news, since the first is said once at startup.
	private lastSeenSchema = 0;
	private legacyStartupNotified = false;
	private legacyOverwriteNotified = false;

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
		// Stamped here rather than by the capture: this is the moment a record
		// becomes ours, and it is the only path that reaches the db file — the
		// capture also feeds the tab layer and the nav history, neither of
		// which is ever synced. A record that already carries a stamp keeps
		// it: moving one to another path is not the reader moving. Spread,
		// not `st.time = …`: the caller keeps its own object.
		const stamped: EphemeralState =
			st.time === undefined ? { ...st, time: Date.now() } : st;
		const existed = this.db[filePath] !== undefined;
		if (existed && filePath === this.lastKey) {
			this.db[filePath] = stamped;
		} else {
			if (existed) delete this.db[filePath];
			this.db[filePath] = stamped;
			this.lastKey = filePath;
		}
		this.markDirty();
	}

	// Recency is the insertion order: setState() always moves a touched key to
	// the end, so the tail holds the most-recently-modified files — no
	// timestamp needed. Tombstones are cheaper to lose than real positions,
	// and without that preference a habit of scrolling back to the top would
	// slowly fill the cap with empty records and crowd out the real ones.
	private trimToLimit(): void {
		const keys = Object.keys(this.db);
		if (keys.length <= MAX_ENTRIES)
			return;

		// Cheapness only applies OUTSIDE the recency window: a note just
		// scrolled back to the top is the newest thing that happened to it,
		// and evicting it in favour of a months-old real position is what
		// would make that note jump to defaultPosition on the next open.
		const windowStart = Math.max(0, keys.length - TOMB_RECENT_WINDOW);
		const cheap: string[] = [];
		const rest: string[] = [];
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			if (i < windowStart && this.isEmptyRecord(key, this.db[key]))
				cheap.push(key);
			else
				rest.push(key);
		}

		// Tombstones lead the eviction order, so they are what falls off the
		// head; the rest keeps its (oldest-first) place in line.
		const doomed = new Set([...cheap, ...rest].slice(0, keys.length - TRIM_TARGET));
		this.db = Object.fromEntries(
			keys.filter((key) => !doomed.has(key)).map((key) => [key, this.db[key]])
		);
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
			const { schema, db } = this.parseDb(data);
			this.db = db;
			await this.cacheDiskMtime();
			this.noteSchema(schema, true);
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
	// foreign file): it never quietly becomes an empty db. A schema newer than
	// ours is read anyway — unknown fields are ignored — so a device that
	// updated first cannot make the file unreadable here.
	// @returns the records, plus the schema the file was written with.
	private parseDb(data: string): { schema: number; db: CursorDatabase } {
		const parsed: unknown = JSON.parse(data);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new Error('database content is not a JSON object');
		const raw = parsed as Record<string, unknown>;

		// No numbered schema means the pre-schema flat map, whose keys are the
		// note paths themselves. Every schema from 2 up shares one container
		// shape, so a newer file parses here too.
		const schema = typeof raw.schema === 'number' ? raw.schema : 1;
		const db = schema >= 2 ? this.parseSchema2(raw) : this.parseSchema1(raw);
		return { schema, db };
	}

	// The untagged flat map: {"a.md": [scroll, line, ch, toLine, toCh]} — schema 1
	// wrote arrays and nothing else.
	private parseSchema1(raw: Record<string, unknown>): CursorDatabase {
		const db: CursorDatabase = {};
		for (const key of Object.keys(raw))
			db[key] = decodeArrayValue(raw[key]);
		return db;
	}

	// {"schema": n, "positions": {"a.md": {...}}} — the map holds records.
	private parseSchema2(raw: Record<string, unknown>): CursorDatabase {
		const container = raw.positions;
		if (!container || typeof container !== 'object' || Array.isArray(container))
			throw new Error('database has no position map');
		const map = container as Record<string, unknown>;
		const db: CursorDatabase = {};
		for (const key of Object.keys(map))
			db[key] = decodeValue(map[key]);
		return db;
	}

	// A file written by another plugin version is still readable — unknown
	// fields are ignored — but the mismatch is worth reporting: our next flush
	// replaces the whole file, and an older writer does the same to ours, so
	// the mismatch itself is what loses records, not the read.
	private noteSchema(schema: number, atStartup: boolean): void {
		const wasCurrent = this.lastSeenSchema >= SCHEMA_VERSION;
		this.lastSeenSchema = schema;
		if (schema >= SCHEMA_VERSION)
			return;

		if (atStartup) {
			if (this.legacyStartupNotified)
				return;
			this.legacyStartupNotified = true;
			stickyNotice(t('dataStorage.legacyDb.notice'));
			return;
		}
		// Mid-session, only a CHANGE from a current file to an old one is news;
		// a file that has been old all along was already reported at startup.
		if (!wasCurrent || this.legacyOverwriteNotified)
			return;
		this.legacyOverwriteNotified = true;
		stickyNotice(t('dataStorage.legacyDb.noticeOverwritten'));
	}

	// What the settings page says beside the entry count: how many of those
	// records hold no position at all. The same test as the eviction below, so
	// the page and the trim never disagree about which records are worthless.
	countDefaultPosition(): number {
		let n = 0;
		for (const key of Object.keys(this.db))
			if (this.isEmptyRecord(key, this.db[key]))
				n++;
		return n;
	}

	// Nothing worth restoring: no scroll, and a cursor sitting only where
	// Obsidian puts it on open. That is what a note that was merely opened
	// leaves behind, and it is the cheapest record to lose. The frontmatter
	// moves the open-default off (0,0), so the cursor alone cannot be the test.
	private isEmptyRecord(path: string, st: EphemeralState): boolean {
		if ((st.scroll ?? 0) > 0)
			return false;
		if (!st.cursor)
			return true;
		return cursorIsDefault(st.cursor, this.defaultCursorLine(path));
	}

	// The line Obsidian leaves the cursor on when `path` is opened: the one
	// right after the frontmatter block, or 0 when it has none. Two in-memory
	// Map lookups (path -> file -> metadata cache), never a read of the file.
	// Undefined = unknown (file gone, or metadata not parsed yet) — callers keep
	// the cursor rather than act on a guess.
	private defaultCursorLine(path: string): number | undefined {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile))
			return undefined;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache)
			return undefined;
		return cache.frontmatterPosition ? cache.frontmatterPosition.end.line + 1 : 0;
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

	// Strict shape check for adopting a target file: accepts only a position db
	// — schema 2, or the pre-schema flat map — whose every key is a recordable
	// note path (.md / .base), exactly what writeDb emits (an empty `{}`
	// included). The key check is what rejects a foreign JSON that happens to
	// hold numeric arrays (chart series, vectors); without it such a file would
	// be adopted and the real one deleted.
	// @returns the parsed db, or null when the content is not a position db.
	private parseDbStrict(data: string): CursorDatabase | null {
		let parsed: { schema: number; db: CursorDatabase };
		try {
			parsed = this.parseDb(data);
		} catch {
			return null;
		}
		for (const key of Object.keys(parsed.db)) {
			const lower = key.toLowerCase();
			if (!lower.endsWith('.md') && !lower.endsWith('.base'))
				return null;
		}
		return parsed.db;
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
	//   shared keys      -> the LATER capture wins; equal (or both unstamped,
	//                       which is every record written before `t` existed)
	//                       keeps ours, so a merge never moves the reader's
	//                       own spot without a reason to.
	// @returns the number of disk records that survived the merge.
	private mergeDiskDb(diskDb: CursorDatabase): number {
		let adopted = Object.keys(diskDb).length;
		for (const key of Object.keys(this.db)) {
			const oursIsLater = (this.db[key].time ?? 0) >= (diskDb[key]?.time ?? 0);
			if (diskDb[key] === undefined || oursIsLater) {
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
			const { schema, db } = this.parseDb(data);
			this.mergeDiskDb(db);
			this.lastDiskMtime = mtime;
			this.noteSchema(schema, false);
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

		// Snapshot the revision right before serializing: everything mutated
		// at or before this instant IS in `data`, and anything landing during
		// the awaits below must not be cleared by this flush — rev catches
		// that (dbDirty below). Such a record also wins any intervening merge
		// by itself: its capture stamp is later than the disk copy's.
		const rev = this.rev;

		// Tombstones are written, not skipped: "left at the top" is a real state
		// that has to reach the other device, and keeping the key is what stops
		// defaultPosition from firing again on the next open.
		const encoded: { [path: string]: PositionRecord } = {};
		for (const key of Object.keys(this.db)) {
			const st = this.db[key];
			// Only an at-the-top record needs the file's open-default line.
			const defaultLine = (st.scroll ?? 0) > 0 ? undefined : this.defaultCursorLine(key);
			encoded[key] = encodeValue(st, defaultLine);
		}
		const data = JSON.stringify({ schema: SCHEMA_VERSION, positions: encoded });
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
				// Nothing hit disk: leave dbDirty untouched so a later flush
				// retries the same records.
				console.error("Can't write database:", e2);
				return;
			}
		}

		// Our own write changed the file — re-cache its mtime so the next
		// external-change check doesn't mistake this write for someone else's.
		// dbDirty is cleared only when no mutation landed while the flush was
		// in flight: a mid-flush setState keeps the db dirty so the next
		// flush persists it.
		await this.cacheDiskMtime();
		this.lastSeenSchema = SCHEMA_VERSION;
		this.dbDirty = rev !== this.rev;
	}

	renameFile(newPath: string, oldPath: string) {
		if (!this.db[oldPath])
			return;
		this.db[newPath] = this.db[oldPath];
		delete this.db[oldPath];
		this.markDirty();
	}

	deleteFile(path: string) {
		if (!this.db[path])
			return;
		delete this.db[path];
		this.markDirty();
	}
}
