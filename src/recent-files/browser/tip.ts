import { TIP_DELAY_MS, TIP_GAP_PX } from './constants';

// WHAT A ROW SAYS ON HOVER, and the element that says it.
//
// Not the native `title`: a native tooltip takes plain text and no stylesheet touches
// it, so the path came out small and its `/` separators nearly invisible. Drawing it
// ourselves also lets a row say only what it does not already print (see
// RecentFilesList.fileRow): a `title` is a static string, while this one is asked for
// the row it is drawn over, so a row that prints its folder can let the path go.
//
// NOT the app's own tooltip either (see `setTooltip`): that is written as an
// `aria-label`, which for a row that is an OPTION of the listbox REPLACES the
// accessible name it already carries. This element is `aria-hidden` decoration; the
// rows keep the names they announce.
export interface TipContent {
	// The file's full path, extension and all — the one thing a row cannot print
	// without the reader's permission (see PathDisplayMode).
	path?: string;
	// A plain line under the path: the file's other names, or the one fact a cell
	// holds instead (the exact moment an age label stands for).
	text?: string;
	// Lines QUOTED OUT OF THE NOTE: the words the landing sat among when it was taken,
	// and, while a query is up, the line the query hit (see landingQuotes). They are
	// the only words a search can match that appear NOWHERE on screen — the row prints
	// a coordinate and a section — which is what a landing's row could never answer
	// before: why this row is on the list at all.
	quotes?: string[];
	// ONE line under the quotes, about the note rather than out of it: whether the
	// file has been written since those words were taken (see landingNote). The quotes
	// are a photograph, and nothing else on the row says whose picture that is.
	note?: string;
}

// ONE TOOLTIP PER LIST, on screen only while the pointer rests on something that has
// something to say. It lives on the DOCUMENT'S BODY rather than inside the list,
// because the list scrolls and clips: a tooltip inside it would be cut off at the row
// it belongs to — and the rows near either end are the ones a reader needs it for.
export class NavRowTip {
	// What each element says: the row itself, or one cell of it (the time label — "the
	// moment" instead of "which file"). Keyed by ELEMENT because the question is asked
	// by a pointer event, which names an element and nothing else.
	private tips = new WeakMap<HTMLElement, TipContent>();
	private el?: HTMLElement;
	private anchor?: HTMLElement;
	// Whether what is on screen was asked for by a LONG PRESS rather than by a pointer
	// resting (see speak): a finger that lifts delivers the same `pointerout` a mouse
	// leaving the row does, and the hint a long press earned has to outlive it — the
	// reader lifted the finger to reach for the row's controls. Only an explicit
	// taking-back ends it (see retract).
	private held = false;
	// A pointer crossing the list on its way elsewhere must not flash a tooltip under
	// every row it passed (see TIP_DELAY_MS).
	private timer?: number;
	private doc: Document;
	private win: Window;

	// `quiet` answers SHOULD THE HINT SPEAK AT ALL, asked fresh at every hover and
	// again at the end of its delay: what silences it — the NOTE itself standing open
	// over the rows (see hoverRow) — is a thing this element cannot see. Asked rather
	// than remembered because the answer's lifetime is the popover's, so a preview
	// that has closed gives the rows their voice back wherever the pointer is.
	constructor(private list: HTMLElement, private quiet?: () => boolean) {
		// The list's own document, not the top one: a panel may stand in a popout, and
		// the tooltip has to be built and placed in the window the reader is looking
		// at. `defaultView` is that window — placement measures against it and the
		// delay is its clock — the top window is the fallback for a document with none.
		this.doc = list.ownerDocument;
		this.win = this.doc.defaultView ?? window;
		// On the LIST and not on the rows: a row is rebuilt on every render.
		this.list.addEventListener('pointerover', this.onOver);
		this.list.addEventListener('pointerout', this.onOut);
		// A press is about to travel or to rebuild the list, and a tooltip pinned to the
		// row it names would be left pointing at a row that is no longer there.
		this.list.addEventListener('pointerdown', this.onLeave);
		// …and a scroll moves every row out from under a tooltip that is standing still.
		this.list.addEventListener('scroll', this.onLeave, { passive: true });
	}

	attach(el: HTMLElement, content: TipContent): void {
		this.tips.set(el, content);
	}

	// The fit pass hands a row the words of the section level it took off, and takes
	// them BACK when the row has room to print that level again (see fitTrails) — a
	// tooltip left behind would be repeating the row it stands over.
	detach(el: HTMLElement): void {
		this.tips.delete(el);
	}

	// TAKE BACK what was said and what was about to be: the app has put the NOTE itself
	// over the rows (see hoverRow), and what a box of small print could add to the page
	// is nothing. What this does NOT do is remember anything — see `quiet`.
	retract(): void {
		this.forget();
	}

	// A FINGER STOPPED ON A ROW, which on a device with no hover is what a hover is
	// (see long-press.ts). Which words it says is the element's, decided the same way a
	// pointer's is (see `subject`): a finger on the TIME is asking for the moment
	// behind "5m"; anywhere else on the row asks which file this is.
	//
	// There is NO DELAY, because the wait already happened: the finger has been down
	// for the whole of the long press, longer than TIP_DELAY_MS asks of a mouse.
	//
	// What is said is HELD (see `held`) rather than left to the pointer's comings and
	// goings: a long press is answered once and taken back once, and the taking back
	// belongs to whatever ended the press.
	speak(target: Node | null): void {
		// Unreachable on a touch device — this panel never asks for a preview there
		// (see hoverAt) — but asked for the same reason: whether the hint may speak is
		// never this element's to remember.
		if (this.quiet?.())
			return;
		const subject = this.subject(target);
		if (!subject)
			return;
		const content = this.tips.get(subject);
		if (!content)
			return;
		this.forget();
		this.anchor = subject;
		this.held = true;
		this.show(subject, content);
	}

	// The list is being REBUILT (see render): the rows the registered tips belong to
	// are gone. The registry needs no clearing — it is keyed weakly.
	reset(): void {
		this.forget();
	}

	destroy(): void {
		this.forget();
		this.list.removeEventListener('pointerover', this.onOver);
		this.list.removeEventListener('pointerout', this.onOut);
		this.list.removeEventListener('pointerdown', this.onLeave);
		this.list.removeEventListener('scroll', this.onLeave);
	}

	// Only a change of SUBJECT counts: the event fires again for every child of the row
	// it is already on, and answering those would restart the delay on a still hand.
	private onOver = (ev: PointerEvent): void => {
		// A finger does not hover — it presses, and the press forgets. Answering a
		// touch's over would raise a tooltip 400ms after a finger that has already
		// travelled, over a row the list may have redrawn since.
		if (ev.pointerType === 'touch') {
			this.forget();
			return;
		}
		if (this.quiet?.()) {
			this.forget();
			return;
		}
		const target = this.subject(ev.target as Node | null);
		if (target === this.anchor)
			return;
		this.forget();
		if (!target)
			return;
		const content = this.tips.get(target);
		if (!content)
			return;
		this.anchor = target;
		this.timer = this.win.setTimeout(() => {
			this.timer = undefined;
			// Asked AGAIN at the end of the delay: a preview that opened while the
			// pointer sat still answers the hover in the meantime.
			if (this.anchor === target && !this.quiet?.())
				this.show(target, content);
		}, TIP_DELAY_MS);
	};

	// A move that stays INSIDE the subject is not a leave: the row's own children fire
	// this on their way past each other.
	//
	// A FINGER LIFTING IS NOT A LEAVE EITHER: a touch pointer ceases to exist when it
	// comes up, so the browser reports the same `out` a mouse leaving the row would —
	// while the hint on screen is the one the long press earned (see speak). A held
	// hint ends when the press's answer ends, not when the finger does.
	private onOut = (ev: PointerEvent): void => {
		if (this.held)
			return;
		const to = ev.relatedTarget as Node | null;
		if (this.anchor && to && this.anchor.contains(to))
			return;
		this.forget();
	};

	private onLeave = (): void => {
		this.forget();
	};

	// The nearest element that has something to say: the time label answers for itself,
	// the row for everything else in it (see fileRow). Walking up to the list keeps the
	// one element that must not answer — the listbox, whose aria-label is no tooltip —
	// out of it.
	private subject(node: Node | null): HTMLElement | undefined {
		let el: HTMLElement | null = node && node.nodeType === 1
			? node as HTMLElement
			: node?.parentElement ?? null;
		while (el && el !== this.list) {
			if (this.tips.has(el))
				return el;
			el = el.parentElement;
		}
		return undefined;
	}

	// The tooltip and what was being hovered always move together: a caller that wanted
	// only one of them would leave the other standing.
	private forget(): void {
		this.clearTimer();
		this.hide();
		this.anchor = undefined;
		this.held = false;
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			this.win.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private hide(): void {
		this.el?.remove();
		this.el = undefined;
	}

	private show(target: HTMLElement, content: TipContent): void {
		const el = this.doc.body.createDiv({
			cls: 'position-restore-nav-tip',
			// Decoration, and nothing else: every word in here is said somewhere a screen
			// reader can already reach (the row's own text).
			attr: { 'aria-hidden': 'true' },
		});
		if (content.path)
			this.pathLine(el, content.path);
		if (content.text)
			el.createDiv({ cls: 'nav-tip-text', text: content.text });
		// In the order the caller gave them — the match a query hit first, then the line
		// the landing sat on. One element each, so a block of the note's own words reads
		// as a block and not as a sentence this panel wrote.
		for (const quote of content.quotes ?? [])
			if (quote)
				el.createDiv({ cls: 'nav-tip-quote', text: quote });
		// …and the line about them LAST: it speaks of the quotes above it, and it is not
		// quoted, being this panel's words and not the note's.
		if (content.note)
			el.createDiv({ cls: 'nav-tip-note', text: content.note });
		this.el = el;
		this.place(el, target);
	}

	// One segment per span and one separator between each pair: a `/` in the middle of a
	// run of text is the hardest character in the path to see, and the stylesheet gives
	// it a weight of its own (see .nav-tip-sep). The last segment is the file's own
	// name, the one the reader is looking for.
	private pathLine(box: HTMLElement, path: string): void {
		const line = box.createDiv({ cls: 'nav-tip-path' });
		const segments = path.split('/');
		segments.forEach((segment, i) => {
			if (i > 0)
				line.createSpan({ cls: 'nav-tip-sep', text: '/' });
			if (segment)
				line.createSpan({
					cls: i === segments.length - 1 ? 'nav-tip-name' : 'nav-tip-seg',
					text: segment,
				});
		});
	}

	// Under the row it is about, hanging from the row's own inline start so the path
	// reads from the same edge as the name. It flips above when the window's foot is
	// too close and slides inward when its far end would run off. Measured AFTER it is
	// in the document, because its width is whatever the path turned out to be.
	private place(el: HTMLElement, target: HTMLElement): void {
		const row = target.getBoundingClientRect();
		const box = el.getBoundingClientRect();
		const view = { w: this.win.innerWidth, h: this.win.innerHeight };
		let top = row.bottom + TIP_GAP_PX;
		if (top + box.height > view.h)
			top = Math.max(TIP_GAP_PX, row.top - TIP_GAP_PX - box.height);
		let left = row.left;
		if (left + box.width > view.w)
			left = view.w - box.width - TIP_GAP_PX;
		el.setCssStyles({
			top: `${Math.round(top)}px`,
			left: `${Math.round(Math.max(TIP_GAP_PX, left))}px`,
		});
	}
}
