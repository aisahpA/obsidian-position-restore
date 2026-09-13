import { App, Editor, MarkdownView, TFile } from 'obsidian';
import { NavHistory } from '../history';
import { EphemeralState } from '../../types';
import { PREVIEW_CACHE_MAX, PREVIEW_READ_DELAY_MS } from './constants';
import { HeadingRef, NavEntryDescription, describeNavEntry } from './model';

// Everything the browser reads out of the vault, cached: an entry's display
// pieces (one render's worth), a file's parsed headings (per path), and a file's
// lines (per path, bounded). The deferred read is the only asynchronous thing
// the panel does — see scheduleRead — and it reports back through `onLinesRead`
// so whatever was showing "loading" can redraw itself.

export interface NavHistoryReadsOptions {
	// The file's saved record, for an entry carrying no position of its own (see
	// describeNavEntry).
	savedPosition?: (path: string) => EphemeralState | undefined;
	// A deferred read has landed: redraw what was waiting for it.
	onLinesRead: () => void;
	// The browser is gone: a read that lands afterwards must not touch it.
	isClosed: () => boolean;
}

export class NavHistoryReads {
	// Per-render describe cache: filtering re-renders on every keystroke, so
	// the vault lookups behind describeNavEntry are not repeated per row.
	private descCache = new Map<number, NavEntryDescription>();
	// path → the file's parsed headings. Cheap to hold (tens of small records)
	// and otherwise re-mapped on every row render.
	private headings = new Map<string, HeadingRef[] | undefined>();
	// Preview line cache: path → lines, or null when unreadable. undefined
	// (absent) means "not read yet". Bounded by PREVIEW_CACHE_MAX, oldest
	// first, so a long session cannot pin note after note in memory.
	private lines = new Map<string, string[] | null>();
	private reading = new Set<string>();
	private readTimer: number | undefined;
	private readPath = '';

	constructor(
		private app: App,
		private nav: NavHistory,
		private opts: NavHistoryReadsOptions,
	) {}

	private hasFile = (path: string): boolean =>
		this.app.vault.getAbstractFileByPath(path) instanceof TFile;

	describe(i: number): NavEntryDescription {
		let d = this.descCache.get(i);
		if (!d) {
			d = describeNavEntry(this.nav.entries[i], this.hasFile, this.opts.savedPosition);
			this.descCache.set(i, d);
		}
		return d;
	}

	clearDescribeCache(): void {
		this.descCache.clear();
	}

	// The file's parsed headings, mapped once per path. A file Obsidian has
	// not parsed yet simply has no section chain (the preview's own read still
	// shows its lines).
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

	// The lines of `path`, or undefined while they are still coming.
	// An OPEN note is read straight from its editor: no IO at all, so the
	// common case (looking at where you just were, in a note you still have
	// open) is instant even for a huge file. Everything else falls back to one
	// cached vault read, kept in a bounded cache.
	linesFor(path: string): string[] | null | undefined {
		const cached = this.lines.get(path);
		if (cached !== undefined)
			return cached;
		const editor = this.liveEditor(path);
		if (!editor)
			return undefined;
		// Synchronous and IO-free; the split is paid once, every later hover
		// hits the cache. Unsaved edits are visible here, which is what the
		// user is looking at anyway.
		const lines = editor.getValue().split('\n');
		this.remember(path, lines);
		return lines;
	}

	private liveEditor(path: string): Editor | undefined {
		let found: Editor | undefined;
		this.app.workspace?.iterateAllLeaves?.((leaf) => {
			const view = leaf.view;
			if (!found && view instanceof MarkdownView && view.editor && view.file?.path === path)
				found = view.editor;
		});
		return found;
	}

	private remember(path: string, lines: string[] | null): void {
		this.lines.delete(path);
		this.lines.set(path, lines);
		while (this.lines.size > PREVIEW_CACHE_MAX) {
			const oldest = this.lines.keys().next().value;
			if (oldest === undefined)
				break;
			this.lines.delete(oldest);
		}
	}

	// A vault read only for a row the pointer rests on — see
	// PREVIEW_READ_DELAY_MS.
	scheduleRead(path: string): void {
		if (this.opts.isClosed() || this.lines.has(path) || this.reading.has(path))
			return;
		if (this.readPath === path && this.readTimer !== undefined)
			return;
		this.cancelRead();
		this.readPath = path;
		this.readTimer = window.setTimeout(() => {
			this.readTimer = undefined;
			void this.readLines(this.readPath);
		}, PREVIEW_READ_DELAY_MS);
	}

	cancelRead(): void {
		if (this.readTimer === undefined)
			return;
		window.clearTimeout(this.readTimer);
		this.readTimer = undefined;
	}

	private async readLines(path: string): Promise<void> {
		if (this.opts.isClosed() || this.lines.has(path) || this.reading.has(path))
			return;
		this.reading.add(path);
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			const text = file instanceof TFile ? await this.app.vault.cachedRead(file) : null;
			this.remember(path, text === null ? null : text.split('\n'));
		} catch (e) {
			console.error('Position Restore: can not read history preview:', e);
			this.remember(path, null);
		} finally {
			this.reading.delete(path);
		}
		if (!this.opts.isClosed())
			this.opts.onLinesRead();
	}
}
