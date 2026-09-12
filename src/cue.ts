import { MarkdownView } from 'obsidian';
import { PluginSettings } from './types';
import { getScroller } from './wait';
import { outlinePathAtLine } from './anchor-line';

const CUE_AUTO_HIDE_MS = 4000;
const CUE_DISMISS_GRACE_MS = 2000;
const FLASH_MS = 1000;
const FLASH_HOLD_RATIO = 0.2;

interface FlashTarget {
	element: HTMLElement;
	line: number;
	cursor: boolean;
}

// Minimal shape of the CodeMirror 6 EditorView the editor wraps —
// `editor.cm` is internal, absent from Obsidian's typings.
interface Cm6EditorView {
	state: { doc: { lines: number; line(n: number): { from: number } } };
	domAtPos(pos: number): { node: Node; offset: number };
}

	// The post-restore orientation cue: a transient highlight on the landing line
	// (the saved scroll is quantized to a line top, so "landing" = the top of the
	// viewport) plus a section breadcrumb in a small chip centered in the note on
	// both desktop and mobile, allowed to wrap to two lines for deep heading
	// chains. Both are cosmetic — every failure path degrades to showing nothing.
	// nothing. The highlight is Web Animations API; the chip's appearance
	// lives in styles.css (.position-restore-cue*). The mobile/desktop placement split
	// is body.is-mobile in styles.css, matching Obsidian's own flag.
export class RestoreCue {
	private settings: PluginSettings;
	private chip: HTMLElement | null = null;
	private hideTimer = 0;
	private shownAt = 0;

	constructor(settings: PluginSettings) {
		this.settings = settings;
	}

	// Shows the cue for a view that just finished restoring. Reads the
	// *settled* position from the view rather than the requested state, so it
	// covers saved-position restores and default jumps (end / before
	// footnotes) alike. Never throws: all lookups are guarded.
	show(view: MarkdownView) {
		this.clearHideTimer();
		if (this.settings.restoreIndicator === 'off')
			return;

		const target = this.resolveFlashTarget(view);
		if (!target)
			return;
		// Tombstone record (scroll 0, no cursor): nothing was restored, so a
		// cue would only point at the arbitrary top of the file.
		if (target.line === 0 && !target.cursor)
			return;

		const mode = this.settings.restoreIndicator;
		// The highlight is only meaningful when it points at a real editing
		// anchor; the viewport-top fallback is where the eye lands anyway.
		if (mode === 'both' && target.cursor) {
			this.flash(target.element);
		}
		if (mode === 'breadcrumb' || mode === 'both') {
			// Remove any chip from a previous restore only now, so a re-entrant
			// show() that resolves to no chip (e.g. a second file-open tick)
			// can't wipe a chip that's already correctly on screen. The chip has
			// pointer-events:none, so resolveFlashTarget's elementFromPoint is
			// unaffected by leaving it in place during resolution.
			this.removeChip();
			this.showCueAtLine(view, target);
		}

		this.shownAt = Date.now();
		this.hideTimer = window.setTimeout(() => this.hide(), CUE_AUTO_HIDE_MS);
	}

	// Called by the recording loop when the user moves away from the restored
	// spot. Suppressed for a short grace after the cue appears, because mobile's
	// post-restore layout/scroll jitter makes readEphemeralState differ from the
	// seeded baseline and would otherwise dismiss the cue on the very first
	// poll tick — a "flash by" with no user input.
	dismissOnMove() {
		if (!this.chip)
			return;
		if (Date.now() - this.shownAt < CUE_DISMISS_GRACE_MS)
			return;
		this.hide();
	}

	hide() {
		this.clearHideTimer();
		const chip = this.chip;
		if (!chip)
			return;
		this.chip = null;
		// Hide the base style immediately so the element can never pop back to
		// full opacity if the removal timer or animation is interrupted; the
		// fade animation holds its end state via fill:forwards.
		chip.setCssStyles({ opacity: '0' });
		chip.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
		window.setTimeout(() => chip.remove(), 220);
	}

	// Resolves the element to flash and the line that anchors the breadcrumb.
	// Source mode prefers the editor cursor when its line is rendered and on
	// screen (the editing anchor); otherwise falls back to the viewport-top
	// line — the reading anchor, which is what a restored view actually shows.
	// Preview mode has no cursor, so it always uses the topmost rendered block.
	private resolveFlashTarget(view: MarkdownView): FlashTarget | null {
		const scroll = Math.round(view.currentMode?.getScroll() ?? 0);

		if (view.getMode() === 'preview') {
			const el = this.previewTopBlock(view);
			// The element is only consumed by the cursor flash, which preview
			// never does (cursor is always false here) — the breadcrumb needs
			// only the line. On mobile a glide restore can still be settling
			// at the document top when the cue fires, where the probe point
			// lands in the preview's padding and finds no rendered block;
			// don't let that kill the chip.
			return { element: el ?? view.contentEl, line: scroll, cursor: false };
		}

		const cm = (view.editor as unknown as { cm?: Cm6EditorView }).cm;
		if (!cm)
			return null;
		const cursor = view.editor?.getCursor();
		const cursorEl = cursor && cursor.line > 0 ? this.sourceLineElement(cm, cursor.line) : null;
		// The breadcrumb follows the cursor only while it's on screen; an
		// off-screen cursor describes a section the user isn't looking at, so
		// fall back to the viewport-top line — what a restored view actually
		// shows.
		if (cursor && cursorEl && this.isVisibleInScroller(cursorEl, view))
			return { element: cursorEl, line: cursor.line, cursor: true };
		const topEl = this.sourceLineElement(cm, scroll);
		if (topEl)
			return { element: topEl, line: scroll, cursor: false };
		return null;
	}

	// The DOM element for a (0-based) source line, via the CM6 EditorView the
	// editor wraps. domAtPos returns the innermost node at the line start;
	// walking up to '.cm-line' normalizes it. Only rendered lines exist in the
	// DOM, so this also doubles as the "is the line on screen" check.
	private sourceLineElement(cm: Cm6EditorView, line: number): HTMLElement | null {
		try {
			const doc = cm.state.doc;
			const n = Math.min(Math.max(0, line), doc.lines - 1) + 1;
			const dom = cm.domAtPos(doc.line(n).from);
			const node = dom.node.instanceOf(Element) ? dom.node : dom.node.parentElement;
			return (node?.closest('.cm-line') as HTMLElement | null) ?? null;
		} catch {
			return null;
		}
	}

	private isVisibleInScroller(el: HTMLElement, view: MarkdownView): boolean {
		const scroller = view.contentEl.querySelector<HTMLElement>('.cm-scroller');
		if (!scroller)
			return false;
		const er = el.getBoundingClientRect();
		const sr = scroller.getBoundingClientRect();
		return er.top < sr.bottom && er.bottom > sr.top;
	}

	// The rendered block at the preview's viewport top. The saved scroll is a
	// line top, so after restore the viewport top sits exactly on the block
	// that contains the landing line.
	private previewTopBlock(view: MarkdownView): HTMLElement | null {
		const scroller = getScroller(view);
		if (!scroller)
			return null;
		const r = scroller.getBoundingClientRect();
		const el = document.elementFromPoint(r.left + r.width / 2, Math.max(0, r.top + 2));
		if (!el)
			return null;
		let node: Element | null = el;
		while (node && node !== scroller) {
			if (node.parentElement?.classList.contains('markdown-preview-sizer'))
				return node as HTMLElement;
			node = node.parentElement;
		}
		return null;
	}

	// Brief background flash on the anchor element, the same highlight color
	// Obsidian uses for .is-flashing heading links. Holds the color briefly
	// before the fade so it reads as a deliberate "here" rather than a blink.
	private flash(el: HTMLElement) {
		el.animate(
			[
				{ backgroundColor: 'var(--text-highlight-bg)', offset: 0 },
				{ backgroundColor: 'var(--text-highlight-bg)', offset: FLASH_HOLD_RATIO },
				{ backgroundColor: 'transparent', offset: 1 },
			],
			{ duration: FLASH_MS, easing: 'ease-out' },
		);
	}

	// Small transient chip naming the landing section, centered in the note on
	// both desktop and mobile so it clears the editor's chrome and the mobile
	// bars, and allowed to wrap to two lines for deep heading chains. Appended
	// to view.contentEl (not the line itself) so CodeMirror's line recycling
	// can never remove it. Cosmetic only; every failure path degrades to
	// showing nothing. All appearance is in styles.css (.position-restore-cue*); the
	// mobile/desktop placement split is body.is-mobile there, matching
	// Obsidian's own flag.
	private showCueAtLine(view: MarkdownView, target: FlashTarget) {
		// The scan stops at the target line, so only the prefix is needed.
		const path = outlinePathAtLine((view.data ?? '').split('\n', target.line + 1), target.line);
		if (path.length === 0)
			return;

		const content = view.contentEl;
		if (getComputedStyle(content).position === 'static')
			content.addClass('position-restore-cue-host');

		const chip = content.createDiv({ cls: 'position-restore-cue' });
		for (let i = 0; i < path.length; i++) {
			if (i > 0)
				chip.createSpan({ text: ' / ', cls: 'position-restore-cue-sep' });
			const isLast = i === path.length - 1;
			chip.createSpan({ text: path[i], cls: isLast ? 'position-restore-cue-seg is-deepest' : 'position-restore-cue-seg' });
		}
		chip.setAttribute('title', path.join(' / '));
		this.chip = chip;

		chip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
		chip.setCssStyles({ opacity: '1' });
	}

	private removeChip() {
		this.clearHideTimer();
		if (this.chip) {
			this.chip.remove();
			this.chip = null;
		}
	}

	private clearHideTimer() {
		if (this.hideTimer) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = 0;
		}
	}
}