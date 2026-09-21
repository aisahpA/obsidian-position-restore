import { App, TFile } from 'obsidian';
import { NavHistoryEntry } from '@/nav-history/entry';
import { EphemeralState } from '@/types';
import { HeadingRef, NavEntryDescription, describeNavEntry } from './model';

// Everything the browser reads out of the vault, cached: an entry's display
// pieces (one render's worth) and a file's parsed headings (per path). Both are
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

export class NavHistoryReads {
	// Per-render describe cache: filtering re-renders on every keystroke, so
	// the vault lookups behind describeNavEntry are not repeated per row.
	private descCache = new Map<number, NavEntryDescription>();
	// path → the file's parsed headings. Cheap to hold (tens of small records)
	// and otherwise re-mapped on every row render.
	private headings = new Map<string, HeadingRef[] | undefined>();

	constructor(
		private app: App,
		private opts: NavHistoryReadsOptions,
	) {}

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

	// The file's parsed headings, mapped once per path. A file Obsidian has
	// not parsed yet simply has no section chain.
	headingsFor(path: string): HeadingRef[] | undefined {
		if (this.headings.has(path))
			return this.headings.get(path);
		const file = this.app.vault.getAbstractFileByPath(path);
		const cache = file instanceof TFile ? this.app.metadataCache?.getFileCache?.(file) : null;
		const refs = cache?.headings?.map(h => ({
			heading: h.heading,
			level: h.level,
			line: h.position.start.line,
		}));
		this.headings.set(path, refs);
		return refs;
	}
}
