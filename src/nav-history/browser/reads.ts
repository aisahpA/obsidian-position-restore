import { App, TFile } from 'obsidian';
import { NavHistory } from '@/nav-history/history';
import { EphemeralState } from '@/types';
import { HeadingRef, NavEntryDescription, describeNavEntry } from './model';

// Everything the browser reads out of the vault, cached: an entry's display
// pieces (one render's worth), a file's parsed headings (per path), the last
// line of a file's frontmatter (per path), and — for the drawer's views that
// show today's file rather than the recorded lines — a file's text. The first
// three are metadata-cache lookups; the landing lines the panel prints come from
// the entries themselves (see NavEntryState.context), which is what let this
// module drop its deferred-read timer and its line cache entirely, and left
// exactly one read behind: a file a reader has asked to see whole.

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
	// path → the last line of the file's frontmatter. What the drawer needs to
	// keep a recorded block that starts INSIDE the properties from rendering as a
	// heading rule and a paragraph of YAML (see contextMarkdown).
	private fronts = new Map<string, number | undefined>();
	// path → the file's text. The promise is cached, not the string, so two draws
	// asking for the same note while the first read is in flight share ONE read.
	private texts = new Map<string, Promise<string | undefined>>();

	constructor(
		private app: App,
		private nav: NavHistory,
		private opts: NavHistoryReadsOptions,
	) {}

	// Whether the note still exists. An arrow field rather than a method: it is
	// handed to describeNavEntry as a plain predicate, and a method separated
	// from its object would lose the `app` it reads. Public because the list asks
	// it of a note ROW — whose own landing descriptions are not the note's
	// existence — while describeNavEntry asks it per entry.
	hasFile = (path: string): boolean =>
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

	// The last line of the file's frontmatter, or undefined when it has none, the
	// file is gone, or Obsidian has not parsed it. A metadata-cache lookup, like
	// the headings: the browser never reads a file to find out where its
	// properties end.
	frontmatterEnd(path: string): number | undefined {
		if (this.fronts.has(path))
			return this.fronts.get(path);
		const file = this.app.vault.getAbstractFileByPath(path);
		const cache = file instanceof TFile ? this.app.metadataCache?.getFileCache?.(file) : null;
		const end = cache?.frontmatterPosition?.end.line;
		this.fronts.set(path, end);
		return end;
	}

	// The file's text as it stands, or undefined when it cannot be read — deleted
	// since the history recorded it, or unreadable. This is the browser's ONLY
	// read of a file, and it serves both views that show today's file rather than
	// the recorded lines: the drawer's whole-note view of a note, and the one
	// source view of a file that is not a note (see PreviewContent). Cached for
	// the dialog's lifetime, because the reader walks a note's landings one click
	// at a time; a note written while the dialog is open keeps the text it had
	// when it was first asked for, which is a few seconds of a reader's attention
	// rather than a live view.
	textFor(path: string): Promise<string | undefined> {
		let text = this.texts.get(path);
		if (!text) {
			const file = this.app.vault.getAbstractFileByPath(path);
			text = file instanceof TFile
				? this.app.vault.cachedRead(file).catch(() => undefined)
				: Promise.resolve(undefined);
			this.texts.set(path, text);
		}
		return text;
	}
}
