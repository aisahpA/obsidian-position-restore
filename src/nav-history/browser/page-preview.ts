import { App, HoverParent, HoverPopover } from 'obsidian';
import { NavHistoryEntry } from '../entry';
import {
	HOVER_LINK_SOURCE_ID, LANDING_MARK_CLASS, POPOVER_GAP, POPOVER_LEFT_VAR,
	POPOVER_PENDING_CLASS, POPOVER_TOP_VAR, REVEAL_DEADLINE_MS,
} from './constants';
import { NavEntryDescription } from './model';

// Obsidian's OWN page preview, driven from a row. We only ANNOUNCE the hover
// with the core plugin's 'hover-link' event and let it show a popover holding
// the file's real preview view — the same thing ⌘/Ctrl + hovering a link gives:
// the whole note, native scrolling, its own sizing. Whether a preview appears,
// how big it is, how long it survives and whether the Mod key is required are
// the plugin's business — that last one is configured per source, under the id
// registered in main.ts.
//
// Two things are ours, because the plugin cannot know them:
//   - WHERE the popover goes: a row's section column, not the row's far edge
//     (see place);
//   - WHEN it may be shown: only once the landing scroll has been applied, or
//     the user sees a flash of the file's opening lines first (see hold).

// The field the core popover carries that Obsidian's typings omit: the element
// it was opened for (the row this browser handed it). The browser needs it to
// tell ITS popover from one still up for another row, and it is assigned by the
// plugin at runtime — hoverEl, the element the preview is rendered into, IS
// typed. Type-only, read-only: the cast never escapes.
type PopoverRuntime = HoverPopover & { targetEl?: HTMLElement | null };

export interface PagePreviewBridgeOptions {
	app: App;
	// The dialog itself: the resting anchor for a preview with no row.
	modalEl: HTMLElement;
	// The HoverParent the core plugin parks its popover on (the dialog).
	hoverParent: HoverParent;
	// The popover the plugin has assigned to that parent (see PopoverRuntime).
	popover: () => PopoverRuntime | null;
	// The entry behind a stack index; the rows passed here are on screen.
	entryAt: (rep: number) => NavHistoryEntry;
	describe: (rep: number) => NavEntryDescription;
	// The browser is gone: a pending wait must not outlive it.
	isClosed: () => boolean;
}

export class PagePreviewBridge {
	// The animation frame that watches a held-back preview for its landing (see
	// hold). One at a time: a new hover supersedes the previous wait.
	private revealWatch: number | undefined;

	constructor(private opts: PagePreviewBridgeOptions) {}

	// Tell the stylesheet where the native preview goes: its LEFT edge just right
	// of the section cell the pointer is on — the column a row's hover preview
	// belongs to, and the part a reader points at to confirm a spot — and its TOP
	// edge level with the row itself, both in viewport coordinates. The plugin's
	// own placement aligns the popover with the whole row and hangs it below, so
	// a row whose section sits at the panel's left put the preview half a panel
	// down and to the right of the text being pointed at. No row (before any
	// hover, or after a filter dropped the pointed-at one) → the dialog itself is
	// the resting anchor.
	place(row?: HTMLElement | null): void {
		const anchor = row ?? this.opts.modalEl;
		const cell = row?.querySelector<HTMLElement>('.nav-row-trail') ?? anchor;
		document.body.style.setProperty(POPOVER_LEFT_VAR, `${cell.getBoundingClientRect().right + POPOVER_GAP}px`);
		document.body.style.setProperty(POPOVER_TOP_VAR, `${anchor.getBoundingClientRect().top}px`);
	}

	// Hand the pointed-at row to Obsidian's own page preview (see the class
	// comment). `state` carries the landing line, so the preview opens at the spot
	// the row promises rather than at the top of the file — and because the plugin
	// draws the note before it applies that line, a row WITH a landing is held
	// back until the scroll has landed (see hold).
	request(ev: MouseEvent, row: HTMLElement, rep: number): void {
		const entry = this.opts.entryAt(rep);
		if (entry.kind === 'view')
			return;
		// The plugin aligns the popover with the anchor rather than with the
		// section cell, and hangs it below the row; say where it goes instead
		// (and re-say it on every hover, because the plugin rewrites the
		// position each time).
		this.place(row);
		const d = this.opts.describe(rep);
		if (d.lineIndex === undefined)
			// A row with no landing opens at the top of the file by design, so
			// there is no jump to hide — and a hold left over from a previous row
			// must not outlive this preview.
			this.reveal();
		else
			this.hold(row);
		this.opts.app.workspace.trigger('hover-link', {
			event: ev,
			source: HOVER_LINK_SOURCE_ID,
			hoverParent: this.opts.hoverParent,
			targetEl: row,
			linktext: entry.path,
			sourcePath: entry.path,
			state: d.lineIndex === undefined ? undefined : { scroll: d.lineIndex },
		});
	}

	// Keep a SHOWING popover anchored to the row it was opened for: the row moves
	// out from under it when the list scrolls. Looked up from the popover itself
	// (not from what is pointed at now — the pointer may have moved on to a row
	// whose preview has not been asked for yet), and nothing showing means
	// nothing to do: re-placing unconditionally would write the body's style on
	// every wheel tick.
	reposition(): void {
		const target = this.shown()?.targetEl;
		if (target)
			this.place(target);
	}

	// The popover the plugin is currently showing for us, seen through the one
	// runtime field Obsidian's typings omit (see PopoverRuntime).
	private shown(): PopoverRuntime | null {
		return this.opts.popover();
	}

	// Hold the native popover invisible until the landing has been applied. The
	// plugin renders the whole note first and only then scrolls to the line (its
	// note renderer retries until the text is laid out), so left alone the user
	// sees a flash of the file's opening lines and then a jump. The renderer
	// marks the line it scrolled to (.is-flashing) in the same call that puts the
	// preview in place, so that mark appearing is the "ready" signal.
	// Two cases have nothing to wait for and are not held:
	//   - the row has no landing (see request);
	//   - the plugin answers with the popover it is ALREADY showing for this row
	//     (onHoverLink returns early for the same targetEl): nothing is rebuilt,
	//     so there is no flash to hide and holding would only delay a preview
	//     that is already in place.
	private hold(row: HTMLElement): void {
		if (this.shown()?.targetEl === row)
			return;
		this.stopRevealWatch();
		document.body.addClass(POPOVER_PENDING_CLASS);
		const deadline = Date.now() + REVEAL_DEADLINE_MS;
		const step = (): void => {
			this.revealWatch = undefined;
			const pop = this.shown();
			const landed = pop?.targetEl === row
				&& !!pop.hoverEl?.querySelector(LANDING_MARK_CLASS);
			// The wait is over when the landing is on screen, when the browser
			// closed, or when the deadline says the preview is never going to
			// report one.
			if (landed || this.opts.isClosed() || Date.now() >= deadline)
				this.reveal();
			else
				this.revealWatch = window.requestAnimationFrame(step);
		};
		this.revealWatch = window.requestAnimationFrame(step);
	}

	// Let a held-back preview through again. Idempotent: it runs on the landing,
	// on close, when the wait runs out, and before a preview with nothing to wait
	// for.
	reveal(): void {
		this.stopRevealWatch();
		document.body.removeClass(POPOVER_PENDING_CLASS);
	}

	// Everything this bridge wrote on the way out: a held preview is let through
	// and the two placement coordinates are dropped, so the next dialog does not
	// inherit a popover parked for a row that is gone.
	dispose(): void {
		this.reveal();
		document.body.style.removeProperty(POPOVER_LEFT_VAR);
		document.body.style.removeProperty(POPOVER_TOP_VAR);
	}

	private stopRevealWatch(): void {
		if (this.revealWatch === undefined)
			return;
		window.cancelAnimationFrame(this.revealWatch);
		this.revealWatch = undefined;
	}
}
