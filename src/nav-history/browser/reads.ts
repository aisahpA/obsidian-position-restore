import { App, TFile } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { EphemeralState } from '@/types';
import { HeadingRef, NavEntryDescription, describeNavEntry } from './model';

// Everything the browser reads out of the vault, cached: an entry's display
// pieces (one render's worth) and a file's parsed headings (per path). Both are
// metadata-cache lookups — no file content is ever read here. The landing lines
// the panel prints come from the entries themselves (see
// NavEntryState.context), which is what let this module drop its vault reads,
// its deferred-read timer and its line cache entirely.

export interface NavHistoryReadsOptions {
	// The file's saved record, for an entry carrying no position of its own (see
	// describeNavEntry).
	savedPosition?: (path: string) => EphemeralState | undefined;
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
		private nav: NavHistory,
		private opts: NavHistoryReadsOptions,
	) {}

	private hasFile = (path: string): boolean =>
		this.app.vault.getAbstractFileByPath(path) instanceof TFile;

	// The file's mtime NOW, against the one the entry recorded at capture time
	// (see NavEntryState.mtime): unequal is shown as "written since". A
	// metadata lookup, no read.
	private mtimeOf = (path: string): number | undefined => {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file.stat?.mtime : undefined;
	};

	describe(i: number): NavEntryDescription {
		let d = this.descCache.get(i);
		if (!d) {
			d = describeNavEntry(this.nav.entries[i], this.hasFile, this.opts.savedPosition, this.mtimeOf);
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
