import { App, EventRef, TFile } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { EphemeralState } from '@/types';
import { HeadingRef, NavEntryDescription, describeNavEntry, headingsFromText } from './model';

// Everything the browser reads out of the vault, cached: an entry's display pieces
// (one render's worth) and, per path, what the file's metadata cache answers — its
// headings and the other names it goes by. None of these needs the file's text.
//
// ONE question may go to the text, and only after the cache has been asked and said
// nothing: the section chain of a note the app has not re-parsed (see headingsFor).

export interface RecentFilesReadsOptions {
	// A file record carries no position of its own, so the line such a row prints is
	// the line a plain open will land on — which is the promise the row makes.
	savedPosition?: (path: string) => EphemeralState | undefined;
	// A reader, not a snapshot: a resident panel is re-pointed on every render.
	entries: () => NavEntry[];
	// A reading that was not there when a row was drawn has landed. The list is the
	// only thing that can show it, and only a redraw does.
	onLateRead?: () => void;
}

// What one file's metadata says: the section chain a landing row prints, and the
// other names the file goes by, which the search box matches on. One record for both
// because `getFileCache` answers both in a single call.
export interface FileMeta {
	// Undefined while Obsidian has not parsed the file — which is not the same answer
	// as a file whose chain is empty (see readMeta).
	headings?: HeadingRef[];
	// `title` first, then `aliases`, in frontmatter order.
	aliases: string[];
}

export class RecentFilesReads {
	// Filtering re-renders on every keystroke, so the vault lookups behind
	// describeNavEntry are not repeated per row.
	private descCache = new Map<number, NavEntryDescription>();
	// Keyed by PATH, so unlike the cache above it survives the list being filtered and
	// rebuilt.
	//
	// NOTHING IS KEPT UNTIL THE CACHE ANSWERS: `getFileCache` is null while a file is
	// unparsed — exactly the moment a sync is replacing one — and a rename fires no
	// 'changed', so a remembered miss would have no event left to invalidate it; it
	// would outlive the sync itself and cost the row its chain until the body died. So
	// a miss is asked again next render, which is one map lookup, while the work this
	// map spares only happens once there is an answer to spare it on.
	private meta = new Map<string, FileMeta>();
	// The file's own TEXT, for the two questions the cache cannot answer: the chain of
	// a note it has not re-parsed (see headingsFor), and the line a stale number has
	// moved to (see linesFor). One reading serves both — a note's lines are the lines
	// its headings sit on.
	//
	// Remembered against mtime rather than invalidated by an event: what makes such a
	// reading stale is an EXTERNAL change, and an external change fires no 'changed' —
	// that is the whole reason this fallback exists.
	private text = new Map<string, { mtime: number; headings: HeadingRef[]; lines: string[] }>();
	// Paths being read right now: however many renders ask, the file is read once.
	private reading = new Set<string>();
	private metaRef?: EventRef;

	constructor(
		private app: App,
		private opts: RecentFilesReadsOptions,
	) {
		// A renamed alias is when a stale memory is worst — the reader is typing the
		// name they just changed. What a change invalidates is ONE file's record, not
		// the whole map.
		this.metaRef = app.metadataCache?.on?.('changed', (file: TFile) => {
			this.meta.delete(file.path);
		});
	}

	// Both shells close through the browser's destroy, and a dialog is a new reads
	// object every time it opens.
	dispose(): void {
		if (this.metaRef)
			this.app.metadataCache?.offref?.(this.metaRef);
		this.metaRef = undefined;
	}

	// The browser's ONE question about a file's existence, and RecentFilesList is its
	// only asker: a place whose file is gone is filtered out before a row is drawn, so
	// nothing downstream has to wonder. The store prunes such a place itself on the
	// vault's delete event; this covers the window before that lands. An arrow field so
	// it can be handed over as a plain predicate.
	hasFile = (path: string): boolean =>
		this.app.vault.getAbstractFileByPath(path) instanceof TFile;

	// Half of landingNote's comparison: the record keeps the mtime the quoted words
	// were taken at, and the file keeps the one it has now. Read off the vault's own
	// file object rather than remembered, because what matters is the one that changed.
	mtimeOf(path: string): number | undefined {
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		return file instanceof TFile ? file.stat.mtime : undefined;
	}

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

	// Mapped once per path — and only once the cache has answered (see `meta`).
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

	// TWO ways to know a chain: the metadata cache, already parsed, and the note's own
	// text. The text is only for when the first says nothing — and "nothing" includes
	// an EMPTY chain: a note a sync has just put back can have been parsed while it was
	// still being written, and on a phone that record can stand for the rest of the
	// session.
	headingsFor(path: string): HeadingRef[] | undefined {
		const fromCache = this.metaFor(path).headings;
		if (fromCache && fromCache.length)
			return fromCache;
		return this.textHeadings(path);
	}

	// ASKING IS FREE AND ANSWERING IS NOT: the text sits behind an await, so the row
	// being drawn now is drawn without the chain. Until the reading lands, what shows
	// is the last reading taken at this mtime — a chain one sync old still names the
	// section, which is more than a line number does.
	private textHeadings(path: string): HeadingRef[] | undefined {
		return this.ensureText(path)?.headings ?? this.text.get(path)?.headings;
	}

	// The lines a stale line number is re-found in (see nowLineFor). Never a reading
	// taken at an older mtime: the lines are the thing being compared against, so a
	// stale copy of them is not an approximation of the answer but its absence.
	//
	// `prime` is whether a reading may be STARTED. One hover may — the answer is one
	// await away. A render of fifty rows may not: fifty files read to label fifty rows
	// is not a price a redraw pays.
	linesFor(path: string, prime: boolean): string[] | undefined {
		return this.ensureText(path, prime)?.lines;
	}

	// The text when it is in hand at the file's current mtime. Otherwise start reading
	// it — unless `prime` says the asker will not wait — and answer undefined: the
	// caller draws with what it had and hears about the reading when it lands.
	private ensureText(path: string, prime = true) {
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(file instanceof TFile))
			return undefined;
		const known = this.text.get(path);
		const mtime = file.stat.mtime;
		if (known && known.mtime === mtime)
			return known;
		if (prime && !this.reading.has(path)) {
			this.reading.add(path);
			void this.readText(path, file, mtime);
		}
		return undefined;
	}

	// Remembered against the mtime it was read at. A read that FAILS is remembered as
	// no headings and no lines rather than left open: a file that will not read is one
	// this list is about to stop drawing anyway (see hasFile), and an open question
	// would be asked again on every redraw for as long as the body lived.
	private async readText(path: string, file: TFile, mtime: number): Promise<void> {
		let headings: HeadingRef[] = [];
		let lines: string[] = [];
		try {
			const content = await this.app.vault.cachedRead(file);
			headings = headingsFromText(content);
			lines = content.split('\n');
		} catch {
			// Nothing to say about it, then: the row keeps its line number.
		}
		this.reading.delete(path);
		this.text.set(path, { mtime, headings, lines });
		this.opts.onLateRead?.();
	}

	// Read LIVE from the cache rather than stored on a place: an alias is the vault's
	// word for a file NOW, not part of a visit that happened last week — and a frozen
	// list would be wrong exactly when the reader looks for a name they just changed.
	// Empty for a pathless view, which is not a file.
	aliasesFor(path: string): string[] {
		return path ? this.metaFor(path).aliases : [];
	}
}

// Read one path's metadata, through the cache and never the disk. `path` is empty for
// a pathless view: there is no file to look up.
//
// NULL means "Obsidian has not parsed this file yet" — one it is still indexing, or
// one a sync has just put back — which is NOT the same answer as a file with no
// headings: that is a real reading, and it is kept (see metaFor).
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
	// `aliases` is Obsidian's own property and may be a string OR a list — a
	// hand-written `aliases: weekly` is as valid as the block list. It is the same
	// vocabulary the quick switcher and `[[` suggestions match on: this search agrees
	// with the app rather than inventing a second rule.
	// `title` is not native but a community convention (Front Matter Title).
	push(fm?.title);
	push(fm?.aliases);
	return { headings, aliases };
}

// The reading for a file Obsidian has not parsed yet. Fresh each time, and
// deliberately NOT put in the map (see metaFor).
function noMeta(): FileMeta {
	return { headings: undefined, aliases: [] };
}
