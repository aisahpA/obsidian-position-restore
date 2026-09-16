// The drawer's content: the landing's recorded lines, or the whole note, drawn
// by OBSIDIAN'S OWN markdown renderer.
//
// Two things were wrong with printing the recorded block as pre-formatted text.
// It looked like a debug dump — smallest type, faintest colour, raw syntax — and
// it was a second, worse answer to a question Obsidian already answers: what
// does this note look like? Handing the same lines to MarkdownRenderer gives the
// drawer the reader's theme, the reader's fonts, live links and everything a
// preview pane has, and it costs one function call instead of a hand-built
// renderer that would never quite agree with the note it came from.
//
// WHAT is rendered is still the recorded block by default, never the file: the
// rows promise the spot the reader left, and today's text is a different claim
// (see LandingPanel). The whole note is one switch away, and it is the ONE place
// this browser reads a file — everything else it knows comes out of the entries
// themselves or the metadata cache.

import { App, Component, MarkdownRenderer } from 'obsidian';
import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { NavEntryDescription } from './model';
import { contextMarkdown, fileSource, isBinary, isMarkdown, landingMarkedInSource, looksBinary, revealFraction, revealLanding } from './markdown';

// Which of the drawer's two contents is showing: the spot the step recorded, or
// the note as it stands now.
export type PreviewMode = 'spot' | 'note';

// Where the landing is, for the render to put on screen afterwards: the words it
// recorded, and — as the fallback for when those words are not in the note any
// more — how far into it the landing sat. Both are optional, and neither is a
// claim about the text: see revealLanding and revealFraction.
interface LandingPoint {
	anchor?: string;
	// How much of the anchor has to survive as words for the search to be worth
	// making (see revealLanding): the whole-note view's default floor, or the spot
	// view's smaller one.
	minNeedle?: number;
	fraction?: number;
}

// The view the reader picked, kept for the WHOLE app session rather than per
// dialog. Opening the browser is asking "where was I", and being put back on the
// recorded spot at every open is a decision the reader has to make again and
// again — one they already made, and one this panel has no business second-
// guessing. Module state is the right lifetime: it is a preference about this
// session's reading, not a setting to persist across restarts.
let sessionMode: PreviewMode = 'spot';

export function previewMode(): PreviewMode {
	return sessionMode;
}

export function setPreviewMode(mode: PreviewMode): void {
	sessionMode = mode;
}

export interface PreviewContentOptions {
	app: App;
	// The note's text as it stands now, or undefined when it cannot be read.
	read: (path: string) => Promise<string | undefined>;
	// The last line of a file's frontmatter, so the recorded lines that sit inside
	// it are not rendered as a heading rule and a paragraph of YAML. Undefined for
	// a file the vault cannot stat or the cache has not parsed.
	frontmatterEnd: (path: string) => number | undefined;
}

export class NavPreviewContent {
	// The rendered DOM, and the component its child renders are hung on. Held
	// across draws because the reader walks a whole note's landings one hover at
	// a time: re-rendering a long note per row would be work nobody sees.
	private comp: Component | null = null;
	private el: HTMLElement | null = null;
	// What the cached DOM was rendered for. A different landing, note or mode is
	// a different render (and unloads the old one).
	private key = '';
	// Which draw is wanted. Reading a note is asynchronous and the pointer keeps
	// moving while it is in flight, so only the newest request is allowed to
	// write — otherwise a slow read lands on a panel that has moved on.
	private gen = 0;

	constructor(private opts: PreviewContentOptions) {}

	// Draw the content for one landing into `host`. @returns whether there was
	// anything to draw, so the panel can admit it when there was not.
	show(host: HTMLElement, mode: PreviewMode, entry: NavHistoryEntry, d: NavEntryDescription): boolean {
		const gen = ++this.gen;
		// A view step (the graph) has no lines and no note behind it.
		if (entry.kind === 'view')
			return false;
		// A file that is not a note has ONE view, and it is not the two the switch
		// offers: the capture records markdown lines, so there is no recorded spot
		// to prefer, and its source is the only thing there is to show.
		if (!isMarkdown(entry.path))
			return this.showFile(host, entry.path, gen);
		// What the file's frontmatter is as the cache knows it — trusted only while
		// the file still is what the step recorded. A file written since may have
		// moved (or dropped) its frontmatter, and hiding lines the reader recorded
		// as content would be worse than showing metadata as prose.
		const front = !d.stale && !d.missing ? this.opts.frontmatterEnd(entry.path) : undefined;
		if (mode === 'spot') {
			const source = contextMarkdown(entry, front);
			if (!source)
				return false;
			// The entry's own stamp identifies the block: two entries of one note
			// recorded at one line cannot both be on the list (see groupByFile),
			// so a shared stamp is a shared block.
			this.draw(host, 'spot', `spot|${entry.path}|${entry.t}|${front ?? ''}`, source, entry.path, this.landing(d));
			return true;
		}
		// The whole note. Keyed on the recorded mtime too, so two landings of one
		// unchanged note share a render while a note written since does not.
		const key = `note|${entry.path}|${entry.st?.mtime ?? 0}`;
		void this.opts.read(entry.path).then((text) => {
			if (gen !== this.gen)
				return;
			if (text) {
				// The note as it stands now: for a markdown path, fileSource hands
				// the text straight to the renderer (a file that is not a note never
				// reaches here — showFile wraps it instead).
				this.draw(host, 'note', key, fileSource(entry.path, text), entry.path, {
					anchor: d.anchor,
					// How far into the note the recorded line is, over the note as it
					// stands NOW: the denominator has to be the file being rendered,
					// not the one the step was recorded in.
					fraction: this.placeIn(d, text),
				});
				return;
			}
			// Unreadable — deleted, or the vault refused it: the recorded lines
			// are all there is left to show, and they are what the spot view
			// would have shown anyway.
			const fallback = contextMarkdown(entry, front);
			if (fallback) {
				this.draw(host, 'spot', `spot|${entry.path}|${entry.t}|${front ?? ''}`, fallback, entry.path, this.landing(d));
				return;
			}
			// Nothing to fall back on either: say so rather than leave the column
			// blank under a caption.
			host.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.none') });
		});
		return true;
	}

	// Where the landing is in what is about to be rendered. A `==…==` mark already
	// in the source is the precise answer and needs no second pass; every other
	// landing is found again in the RENDERED DOM, by its own words (see
	// revealLanding) — a heading or a list item cannot carry that mark without
	// turning into its own source (see landingMarkedInSource), so the words have to
	// travel to the other side of the render.
	// The floor is 2 rather than the whole-note view's 4: this is a dozen recorded
	// lines with the landing among them, where a two-character heading is a place
	// ("标题") and not a coincidence.
	private landing(d: NavEntryDescription): LandingPoint | undefined {
		return landingMarkedInSource(d.anchor ?? '') ? undefined : { anchor: d.anchor, minNeedle: 2 };
	}

	// …and how far into the note that landing sits, for a landing whose words are
	// not there any more (see revealFraction).
	private placeIn(d: NavEntryDescription, text: string): number | undefined {
		if (d.lineIndex === undefined)
			return undefined;
		const lines = text.split('\n').length;
		return lines > 1 ? d.lineIndex / (lines - 1) : 0;
	}

	// Throw the rendered DOM away, and the components it registered. Called when
	// the dialog closes: an embedded note's render can hold plugins' children.
	destroy(): void {
		this.gen++;
		this.drop();
	}

	// A file that is not a note: its own source in a code block, whatever the view
	// switch says. A PDF, an image or an archive has no source to show at all, and
	// says so instead — with the one thing that can still be done about it, the
	// travel button, named (jumping to the step opens the file).
	private showFile(host: HTMLElement, path: string, gen: number): boolean {
		if (isBinary(path)) {
			host.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.binary') });
			return true;
		}
		void this.opts.read(path).then((text) => {
			if (gen !== this.gen)
				return;
			if (!text || looksBinary(text)) {
				host.createDiv({ cls: 'nav-preview-note', text: t('navHistory.preview.binary') });
				return;
			}
			this.draw(host, 'note', `file|${path}`, fileSource(path, text), path);
		});
		return true;
	}

	private draw(host: HTMLElement, mode: PreviewMode, key: string, source: string, path: string, at?: LandingPoint): void {
		if (this.el && this.key === key) {
			host.appendChild(this.el);
			this.reveal(this.el, at);
			return;
		}
		this.drop();
		// Both classes are what the reading view puts on its scroller, and they
		// are what makes the theme style the content as a note rather than as
		// some div a plugin invented. The panel's own CSS undoes the viewport
		// box they bring with them (see styles.css).
		const el = host.createDiv({
			cls: `nav-preview-content markdown-preview-view markdown-rendered is-${mode}`,
		});
		this.el = el;
		this.key = key;
		const comp = new Component();
		comp.load();
		this.comp = comp;
		void MarkdownRenderer.render(this.opts.app, source, el, path, comp)
			.then(() => {
				// The DOM is the one this draw made, or a newer draw replaced it:
				// the landing is marked only in the first case.
				if (this.el === el)
					this.reveal(el, at);
			})
			.catch(e => console.error('Position Restore: preview render failed:', e));
	}

	// Put the landing on screen: its own recorded words first, because those are
	// exact — and the recorded line's position in the note when they are gone, so
	// that "全文" is never an answer that silently shows the top of the file.
	private reveal(root: HTMLElement, at?: LandingPoint): void {
		if (!revealLanding(root, at?.anchor, at?.minNeedle))
			revealFraction(root, at?.fraction);
	}

	private drop(): void {
		this.el?.remove();
		this.el = null;
		this.key = '';
		this.comp?.unload();
		this.comp = null;
	}
}
