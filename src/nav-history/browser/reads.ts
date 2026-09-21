import { App, EventRef, TFile } from 'obsidian';
import { NavHistoryEntry } from '@/nav-history/entry';
import { EphemeralState } from '@/types';
import { HeadingRef, NavEntryDescription, describeNavEntry } from './model';

// Everything the browser reads out of the vault, cached: an entry's display
// pieces (one render's worth) and, per path, the two things a file's metadata cache
// answers — its parsed headings and the other names it goes by. All of them are
// metadata-cache lookups — this module reads no file. The landing lines a row or
// the panel prints come from the entries themselves (see NavEntryState.context)
// and the section chain comes from the cache, which is what let this module drop
// its deferred-read timer, its line cache and the one whole-file read it used to
// keep for the panel's content views.

export interface NavHistoryReadsOptions {
	// The file's saved record: the position source for a place that carries none
	// of its own — which, on the recent-files list, is every FILE record (see
	// places.ts). The line such a row prints is therefore the line a plain open
	// will land on, which is exactly the promise the row makes.
	savedPosition?: (path: string) => EphemeralState | undefined;
	// The places as they stand: a reader, not a snapshot, because the list is
	// re-pointed on every render of a resident panel (see body.ts's render).
	entries: () => NavHistoryEntry[];
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

export class NavHistoryReads {
	// Per-render describe cache: filtering re-renders on every keystroke, so
	// the vault lookups behind describeNavEntry are not repeated per row.
	private descCache = new Map<number, NavEntryDescription>();
	// path → what the file's metadata says. Cheap to hold (tens of small records) and
	// otherwise re-mapped on every row render… and NOT dropped per render, unlike the
	// describe cache above: it is keyed by PATH, so it survives the list being
	// filtered, re-ordered and rebuilt (see aliasesFor).
	private meta = new Map<string, FileMeta>();
	// The metadataCache listener that keeps those other names honest (see the
	// constructor). Held so the panel can stop listening when it goes.
	private metaRef?: EventRef;

	constructor(
		private app: App,
		private opts: NavHistoryReadsOptions,
	) {
		// A renamed alias is exactly when a stale memory is worst: the reader is typing
		// the name they just changed. What a change invalidates is ONE file's record and
		// not the whole map — clearing everything would make the next keystroke re-read
		// every path on the list. (The same watch, for the same reason, in
		// position/capture/sampler.ts's installFrontmatterWatch.)
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
	// file's existence, and `NavHistoryList` is its only asker: a place whose file is
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

	// What the file's metadata says, mapped once per path.
	metaFor(path: string): FileMeta {
		let m = this.meta.get(path);
		if (!m) {
			m = readMeta(this.app, path);
			this.meta.set(path, m);
		}
		return m;
	}

	// The file's parsed headings (a file Obsidian has not parsed yet simply has no
	// section chain — see FileMeta.headings).
	headingsFor(path: string): HeadingRef[] | undefined {
		return this.metaFor(path).headings;
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
// for a pathless view (the graph): there is no file to look up.
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
function readMeta(app: App, path: string): FileMeta {
	const file = path ? app.vault.getAbstractFileByPath(path) : null;
	const cache = file instanceof TFile ? app.metadataCache?.getFileCache?.(file) : null;
	const headings = cache?.headings?.map(h => ({
		heading: h.heading,
		level: h.level,
		line: h.position.start.line,
	}));
	const fm: Record<string, unknown> | undefined = cache?.frontmatter;
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
