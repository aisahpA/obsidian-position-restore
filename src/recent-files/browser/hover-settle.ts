import { HoverParent, HoverPopover } from 'obsidian';
import { nextPaint } from '@/shared/wait';

// THE JUMP AND THE FLASH THE APP'S OWN PREVIEW MAKES WHEN IT IS ASKED FOR A LINE, and what this
// module is: not a task that waits for them, but an OBSERVER simply watching when they happen.
//
// Asked `state: { scroll: n }`, the core's markdown popover does NOT open at that line — it cannot.
// Its loader draws the whole note first and only afterwards asks the renderer for the scroll:
// `applyScrollDelayed(scroll, {highlight:!0, center:!0})`. The immediate attempt always fails (the
// text has not rendered yet), so it waits for `onRendered` and applies the scroll when the note
// lands — and with it a three-second `.is-flashing` highlight, the mark upstream puts on a SEARCH
// hit. So the note is seen at its head, then jumps, then flashes.
//
// The cover is the same idea as the one that hides this plugin's own restores (see
// position/ui/cover.ts), but the popover is not a leaf, so what is hidden here is the app's element,
// borrowed back through the one handle the app handed us: a HoverParent's `hoverPopover`, written by
// the core when the preview opens. Nothing private is reached for — `hoverEl` is a documented member
// — and when anything here fails to be found the popover stands uncovered.
//
// WHY AN OBSERVER AND NOT A WAIT: when the app answers is not bounded. This panel's registration
// requires the Mod key (see main.ts), so the popover appears when the reader PRESSES it — ten
// seconds after the row was asked if they like, by which time a wait with any deadline has gone
// home, taking the cover and the "it opened" news with it. So an asking ARMS a loop that watches the
// parent's field for as long as the hover lasts; the only deadlines left are the ones about the
// note's own journey, which IS bounded — a render, then a scroll.

// How long, once the cover is on, to wait for the delayed scroll before showing whatever is there.
// It lands when the render lands, which is soon — this bound is for the version of the app that
// keeps the position and drops the flash, whose popover must not be held blank.
const LAND_MAX_MS = 1500;

// What the core calls the section the delayed scroll landed on, for three seconds.
const FLASH = 'is-flashing';

export class PreviewSettle {
	private parent?: HoverParent;
	// Said the moment the app HAS answered, once per popover: whether anything opened at all is the
	// app's decision — its delay, its key rule, its own switch. The CARD is handed over with the
	// news, because nothing outside this module has another handle on what the app drew (see
	// RecentFilesBrowser.liftPreview: a preview asked from a dialog has to clear that dialog).
	private onOpen?: (el: HTMLElement) => void;
	// The paint loop, while it runs (see start).
	private running = false;
	// Whether the pointer is ON THE LIST: the asking is live, and a popover that appears belongs to
	// it. Cleared by hoverEnded — which is not the popover's end (the pointer may have moved ONTO
	// it), only the end of new askings.
	private session = false;
	// Whether the NEWEST asking named a line. A section is drawn where it stands and has no journey
	// to cover; a line is drawn whole first and moved after.
	private wantCover = false;
	// The popover being tracked, while one is open — kept even after the hover ends, so a pointer
	// coming back to the list meets an old friend rather than "discovering" it a second time (which
	// would re-report the opening and, for a line-asking, cover a note already standing at its line).
	private popover?: HoverPopover;
	// The element under the cover right now, and what exactly was hidden in it: nothing here guesses
	// at another element's opacity.
	private coveredEl?: HTMLElement;
	private hidden: HTMLElement[] = [];
	// When the cover stops waiting for the scroll (see LAND_MAX_MS).
	private deadline = 0;

	// The two things this panel knows and this module cannot: WHO to watch (the parent handed to the
	// app with every asking), and WHO TO TELL when the app answers.
	attach(parent: HoverParent, onOpen: (el: HTMLElement) => void): void {
		this.parent = parent;
		this.onOpen = onOpen;
	}

	// A row was just handed to the app (see RecentFilesBrowser.hoverRow): whether the asking named a
	// LINE is all that has to be said here. The loop this arms outlives the asking by design and
	// stands down when the hover does.
	ask(line: boolean): void {
		this.session = true;
		this.wantCover = line;
		// A popover already standing (the pointer crossed over from another row): the note about to
		// load into it makes the same journey, so the cover starts NOW rather than one visible frame
		// of the note's head late.
		if (line) {
			const el = this.parent?.hoverPopover?.hoverEl;
			if (el && el.isConnected)
				this.beginCover(el);
		}
		this.start();
	}

	// The pointer left the LIST: no asking is live any more, and a cover still on comes off. The
	// popover itself stays tracked: it is the app's to close, and the reader may be reading it.
	hoverEnded(): void {
		this.session = false;
		this.wantCover = false;
		if (this.coveredEl) {
			this.reveal();
			this.coveredEl = undefined;
		}
	}

	// Whether a preview is standing open right now, asked of the app's own handle rather than
	// remembered here: a remembered answer would go stale exactly when it mattered.
	isOpen(): boolean {
		const el = this.parent?.hoverPopover?.hoverEl;
		return !!el && el.isConnected;
	}

	// The panel is going away: a popover left covered would be a bug that outlives the rows that
	// caused it.
	stop(): void {
		this.running = false;
		this.session = false;
		this.wantCover = false;
		this.popover = undefined;
		this.coveredEl = undefined;
		this.reveal();
	}

	private start(): void {
		if (this.running)
			return;
		this.running = true;
		void this.loop();
	}

	// One look per paint, for as long as there is anything to look at: a live asking, or a popover
	// still open. An idle panel runs nothing.
	private async loop(): Promise<void> {
		while (this.running && (this.session || this.popover !== undefined || this.coveredEl)) {
			this.tick();
			await nextPaint();
		}
		this.running = false;
	}

	private tick(): void {
		const pop = this.parent?.hoverPopover ?? undefined;
		const el = pop?.hoverEl;
		if (!pop || !el || !el.isConnected) {
			// Closed — or never there. Uncovering is bookkeeping here (the element is the app's to
			// take away), but restoring costs nothing and leaves nothing to chance if the app re-uses
			// the node.
			this.popover = undefined;
			this.coveredEl = undefined;
			this.reveal();
			return;
		}
		if (pop !== this.popover) {
			// THE APP HAS ANSWERED. Said first, because it is true whether or not there is anything to
			// cover.
			this.reveal();
			this.popover = pop;
			this.coveredEl = undefined;
			this.onOpen?.(el);
			if (this.wantCover)
				this.beginCover(el);
			return;
		}
		if (this.coveredEl && this.coveredEl !== el) {
			// The same popover wearing new content: the journey starts over.
			this.reveal();
			this.beginCover(el);
		}
		if (!this.coveredEl)
			return;
		// Re-applied every look rather than once: the content node arrives later than the card it
		// belongs to, and a node only ever hidden before it exists is not hidden at all.
		this.hideNew(this.coveredEl);
		// The delayed scroll landed. Its own mark is the answer: the highlight is put on the line in
		// the same call that moves the scroller, so its arrival and the arrival of the position are
		// the same instant — and taken off in the same look, so the flash is never seen. There is
		// deliberately no second witness: a covered popover still takes the wheel (opacity hides, it
		// does not disable), and the reader's own scroll is not the scroll being waited for.
		if (this.coveredEl.querySelector(`.${FLASH}`)) {
			this.unflash(this.coveredEl);
			this.reveal();
			this.coveredEl = undefined;
			return;
		}
		if (Date.now() > this.deadline) {
			this.reveal();
			this.coveredEl = undefined;
		}
	}

	private beginCover(el: HTMLElement): void {
		// One cover at a time, and exactly one: an asking can arrive while another card is still
		// under ours, and a hidden list dropped without restoring is a node left invisible for good.
		this.reveal();
		this.coveredEl = el;
		this.deadline = Date.now() + LAND_MAX_MS;
		this.hideNew(el);
	}

	// Everything the popover is showing, hidden WITHOUT hiding the popover: the card appears the
	// instant it appears, with the note's own space already reserved, so what the reader sees is a
	// note being uncovered rather than a card arriving late. Only opacity moves — nothing about
	// layout may change while it is hidden, or the card would be sized for content that is not there
	// yet.
	private hideNew(el: HTMLElement): void {
		for (const child of Array.from(el.children)) {
			if (child.instanceOf(HTMLElement) && !this.hidden.includes(child)) {
				child.setCssStyles({ opacity: '0' });
				this.hidden.push(child);
			}
		}
	}

	// Take the search hit's highlight off the line: nothing in this panel ever asked for a search.
	private unflash(el: HTMLElement): void {
		for (const marked of Array.from(el.querySelectorAll(`.${FLASH}`)))
			marked.classList.remove(FLASH);
	}

	private reveal(): void {
		for (const child of this.hidden)
			child.setCssStyles({ opacity: '' });
		this.hidden = [];
	}
}
