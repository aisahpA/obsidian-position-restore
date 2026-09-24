import { App, EventRef, TFile } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { EphemeralState } from '@/types';
import { HeadingRef, NavEntryDescription, describeNavEntry, headingsFromText } from './model';

// Everything the browser reads out of the vault, cached: an entry's display
// pieces (one render's worth) and, per path, the two things a file's metadata cache
// answers — its parsed headings and the other names it goes by. All of them are
// metadata-cache lookups, and every one of them is answered WITHOUT the file's text.
// The landing lines a row or the panel prints come from the entries themselves (see
// NavEntryState.context).
//
// ONE question may still go to the file's text, and only after the cache has been
// asked and said nothing: the section chain of a note the app has not re-parsed — a
// sync replaced it, or a phone's indexer has not got round to it. That reading is
// what a row falls back on instead of printing its line alone (see headingsFor).

export interface RecentFilesReadsOptions {
	// The file's saved record: the position source for a place that carries none
	// of its own — which, on the recent-files list, is every FILE record (see
	// places.ts). The line such a row prints is therefore the line a plain open
	// will land on, which is exactly the promise the row makes.
	savedPosition?: (path: string) => EphemeralState | undefined;
	// The places as they stand: a reader, not a snapshot, because the list is
	// re-pointed on every render of a resident panel (see body.ts's render).
	entries: () => NavEntry[];
	// Called when a reading that was NOT there the moment a row was drawn arrives
	// afterwards — the section chain taken out of a note's own text (see
	// headingsFor). The list is the only thing that can show it, and only a redraw
	// shows it; this is how the panel hears that it has something to redraw.
	onLateRead?: () => void;
}

// What the browser takes from ONE file's metadata cache: the section chain a
// landing's row prints, and the other names the file goes by, which the search box
// matches on. One record for both because `getFileCache` answers both in a single
// call (see readMeta): two maps would only mean asking twice.
export interface FileMeta {
	// The file's parsed headings, in document order — undefined when Obsidian has not
	// parsed it yet, which is a file with no section chain.
	headings?: HeadingRef[];
	// The other names the file goes by, in the order the frontmatter lists them (see
	// readMeta): the `title` first, then `aliases`.
	aliases: string[];
}

export class RecentFilesReads {
	// Per-render describe cache: filtering re-renders on every keystroke, so
	// the vault lookups behind describeNavEntry are not repeated per row.
	private descCache = new Map<number, NavEntryDescription>();
	// path → what the file's metadata says. Cheap to hold (tens of small records) and
	// otherwise re-mapped on every row render… and NOT dropped per render, unlike the
	// describe cache above: it is keyed by PATH, so it survives the list being
	// filtered, re-ordered and rebuilt (see aliasesFor).
	//
	// NOTHING IS KEPT UNTIL THE CACHE ANSWERS. `getFileCache` is null for a file
	// Obsidian has not parsed yet — which is exactly the moment a sync is replacing
	// one: it removes the file and renames the download over it (see
	// position/path-bookkeeping.ts), and the app does NOT fire 'changed' for a rename,
	// so a remembered miss then has no event left to invalidate it. It outlived the
	// sync itself: every later render of this body re-read the same emptiness, the row
	// lost its section chain and printed only `L412`, and it stayed that way until the
	// body was thrown away — a restart, or the dialog's next opening. So a miss is
	// asked again on the next render instead. What that costs is one map lookup, which
	// is all `getFileCache` is; the work this map actually spares — walking the
	// headings and flattening the frontmatter — only happens once there is an answer
	// to spare it on.
	private meta = new Map<string, FileMeta>();
	// The section chains taken out of a file's own text, for the notes the metadata
	// cache has nothing to say about (see headingsFor). Kept beside the mtime the
	// reading was taken at rather than invalidated by an event: the change that makes
	// such a reading stale is an EXTERNAL one — a sync — and an external change fires
	// no 'changed' (that is the whole reason this fallback exists), so the mtime is
	// the only clock this reading has, and it is a clock the file keeps itself.
	private text = new Map<string, { mtime: number; headings: HeadingRef[] }>();
	// The paths whose text is being read right now: however many renders ask before a
	// reading lands, the file is read once.
	private reading = new Set<string>();
	// The metadataCache listener that keeps those other names honest (see the
	// constructor). Held so the panel can stop listening when it goes.
	private metaRef?: EventRef;

	constructor(
		private app: App,
		private opts: RecentFilesReadsOptions,
	) {
		// A renamed alias is exactly when a stale memory is worst: the reader is typing
		// the name they just changed. What a change invalidates is ONE file's record and
		// not the whole map — clearing everything would make the next keystroke re-read
		// every path on the list. (The same watch, for the same reason, in
		// position/capture/sampler.ts's installFrontmatterWatch.) It is also the ONLY
		// watch, and a rename fires no 'changed' — which is why this map never records a
		// miss in the first place (see `meta`).
		this.metaRef = app.metadataCache?.on?.('changed', (file: TFile) => {
			this.meta.delete(file.path);
		});
	}

	// Stop listening. Called by the browser's own destroy (see body.ts): both shells
	// close through it, so this is the one place a listener that outlives the panel's
	// DOM can be forgotten — and a dialog is a new reads object every time it opens.
	dispose(): void {
		if (this.metaRef)
			this.app.metadataCache?.offref?.(this.metaRef);
		this.metaRef = undefined;
	}

	// Whether the note is still on disk. This is the browser's ONE question about a
	// file's existence, and `RecentFilesList` is its only asker: a place whose file is
	// gone is filtered out before a row is drawn (see the list's `keep`), so nothing
	// downstream — a row, the sheet, the describe cache — ever has to wonder whether
	// the thing it names is there. An arrow field rather than a method so it can be
	// handed to the list as a plain predicate.
	//
	// The recent-files store prunes such a place itself, on the vault's own delete
	// event and on a startup sweep (see PathBookkeeper). What this predicate covers is
	// the window before that lands, and a record that arrived from another device: a
	// name the list cannot open is not a row.
	hasFile = (path: string): boolean =>
		this.app.vault.getAbstractFileByPath(path) instanceof TFile;

	describe(i: number): NavEntryDescription {
		let d = this.descCache.get(i);
		if (!d) {
			d = describeNavEntry(this.opts.entries()[i], this.opts.savedPosition);
			this.descCache.set(i, d);
		}
		return d;
	}

	clearDescribeCache(): void {
		this.descCache.clear();
	}

	// What the file's metadata says, mapped once per path — and only once the cache
	// has answered (see `meta`): a miss is asked again next render rather than kept
	// as "this file has no section chain".
	metaFor(path: string): FileMeta {
		const known = this.meta.get(path);
		if (known)
			return known;
		const read = readMeta(this.app, path);
		if (!read)
			return noMeta();
		this.meta.set(path, read);
		return read;
	}

	// The file's parsed headings — a file Obsidian has not parsed yet simply has no
	// section chain (see FileMeta.headings).
	//
	// TWO ways to know them, and the second is only for when the first says nothing:
	// the metadata cache, which has them parsed already, and the note's own text (see
	// textHeadings). What counts as "says nothing" is not only a missing record: a
	// note a sync has just put back can have been parsed while it was still being
	// written, which is a record with NO headings in it, and on a phone that record
	// can stand for the rest of the session — the row printed `L412` alone the whole
	// time. So an empty chain is an unanswered question too, and the text is asked.
	//
	// The text is only ever the fallback: a cache that has answered is the same
	// reading, already done, and free.
	headingsFor(path: string): HeadingRef[] | undefined {
		const fromCache = this.metaFor(path).headings;
		if (fromCache && fromCache.length)
			return fromCache;
		return this.textHeadings(path);
	}

	// The section chain read out of the note's own text, for a note the metadata cache
	// has nothing to say about (see headingsFor).
	//
	// ASKING IS FREE AND ANSWERING IS NOT: the text sits behind an await, so the row
	// being drawn now is drawn without the chain, and the body hears about the reading
	// when it lands (see RecentFilesReadsOptions.onLateRead). Until then what it shows
	// is the last reading taken at this mtime, if there is one — a chain one sync old
	// still names the section, which is more than a line number does.
	private textHeadings(path: string): HeadingRef[] | undefined {
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(file instanceof TFile))
			return undefined;
		const known = this.text.get(path);
		const mtime = file.stat.mtime;
		if (known && known.mtime === mtime)
			return known.headings;
		if (!this.reading.has(path)) {
			this.reading.add(path);
			void this.readText(path, file, mtime);
		}
		return known?.headings;
	}

	// One file's headings, out of its text, remembered against the mtime they were read
	// at (see `text`). A read that FAILS is remembered as no headings at that mtime
	// rather than left to be asked again: a file that will not read is one this list is
	// about to stop drawing anyway (see hasFile), and a question left open would be
	// asked again on every redraw for as long as the body lived.
	private async readText(path: string, file: TFile, mtime: number): Promise<void> {
		let headings: HeadingRef[] = [];
		try {
			headings = headingsFromText(await this.app.vault.cachedRead(file));
		} catch {
			// Nothing to say about it, then: the row keeps its line number.
		}
		this.reading.delete(path);
		this.text.set(path, { mtime, headings });
		this.opts.onLateRead?.();
	}

	// The other names the file goes by: what the search box matches on, and what the
	// row's own tooltip prints (see list.ts). Read LIVE from the metadata cache rather
	// than stored on a place, which is the rule types.ts already states for everything
	// the vault can still answer (see NavEntryState): an alias is the vault's word for
	// a file NOW, not part of a visit that happened last week — and a place list that
	// froze it would be wrong exactly when the reader goes looking for a name they
	// just changed. Empty for a pathless view, which is not a file.
	aliasesFor(path: string): string[] {
		return path ? this.metaFor(path).aliases : [];
	}
}

// Read one path's metadata, through the cache and never the disk. `path` is empty
// for a pathless view (the graph, Thino's memo list): there is no file to look up.
//
// NULL means "Obsidian has not parsed this file yet" — one it is still indexing, or
// one a sync has just put back — which is NOT the same answer as a file with no
// headings: that is a real reading, and it is kept (see RecentFilesReads.metaFor).
//
//   - `aliases` is Obsidian's own property, and its value may be a string OR a list
//     of them, so both are taken (a hand-written `aliases: weekly` is as valid as the
//     usual block list). It is the same vocabulary the app's quick switcher and its
//     `[[` suggestions match on, which is the point: this search agrees with them
//     rather than inventing a second rule.
//   - `title` is not a native property but a community convention (Front Matter
//     Title). Reading it costs nothing when it is absent, and a vault that uses the
//     key for something else makes that text searchable too — a known cost of
//     hard-coding the pair instead of offering a setting (see the plan).
function readMeta(app: App, path: string): FileMeta | null {
	const file = path ? app.vault.getAbstractFileByPath(path) : null;
	const cache = file instanceof TFile ? app.metadataCache?.getFileCache?.(file) : null;
	if (!cache)
		return null;
	const headings = cache.headings?.map(h => ({
		heading: h.heading,
		level: h.level,
		line: h.position.start.line,
	}));
	const fm: Record<string, unknown> | undefined = cache.frontmatter;
	const aliases: string[] = [];
	const seen = new Set<string>();
	// One level of nesting, which is all either property shape needs: a list may hold
	// strings, and a hand-edited one may hold a list of lists.
	const push = (value: unknown): void => {
		if (typeof value === 'string') {
			const text = value.trim();
			if (text && !seen.has(text)) {
				seen.add(text);
				aliases.push(text);
			}
		} else if (Array.isArray(value)) {
			for (const item of value)
				push(item);
		}
	};
	// `title` first: of the two it is the one that reads as "the name of this note".
	push(fm?.title);
	push(fm?.aliases);
	return { headings, aliases };
}

// The reading for a file Obsidian has not parsed yet: no section chain, no other
// names. Fresh each time, because nothing owns it — and deliberately NOT put in the
// map (see RecentFilesReads.metaFor).
function noMeta(): FileMeta {
	return { headings: undefined, aliases: [] };
}
