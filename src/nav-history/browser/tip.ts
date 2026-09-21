import { TIP_DELAY_MS, TIP_GAP_PX } from './constants';

// WHAT A ROW SAYS ON HOVER, and the element that says it.
//
// The row's own tooltip used to be the native `title` — one line per fact, drawn by
// the BROWSER. Two things were wrong with it, and both are the reader's own report:
// the path came out in the browser's tooltip type, which is small and cannot be
// styled, and its `/` separators were nearly invisible in it. A native tooltip takes
// plain text and no stylesheet touches it, so the only way to say a path LEGIBLY is
// to draw the tooltip ourselves.
//
// The panel's own tooltip is also what lets a row say only what the row does not
// already print (see NavHistoryList.fileRow): a `title` is a static string, while
// this one is asked for the row it is drawn over — so a row that prints its folder
// can let the path go, and hover is quiet exactly where the reader has already asked
// for the path to be on screen.
//
// It is NOT this app's own tooltip (see `setTooltip`), and that is deliberate: the
// app's tooltip is written as an `aria-label`, which for a row that is an OPTION of
// the listbox REPLACES the accessible name the row already carries ("option:
// meeting-notes"). This element is `aria-hidden` decoration in the visual layer; the
// rows keep the names they announce.
export interface TipContent {
	// The file's full path, extension and all — the one thing a row cannot print
	// without the reader's permission (see PathDisplayMode). Drawn segment by
	// segment so the separators can be drawn as what they are.
	path?: string;
	// A plain line under the path: the file's OTHER names, or the one fact a cell
	// holds instead (the exact moment an age label stands for, the line range a
	// folded landing covers). Nothing here is styled per character.
	text?: string;
}

// ONE TOOLTIP PER LIST, on screen only while the pointer rests on something that has
// something to say: the element is built by the hover that earned it and taken away the
// moment the pointer moves on — or the list is redrawn, scrolled or clicked. It lives
// on the DOCUMENT'S BODY rather than inside the list, because the list scrolls and
// clips (overflow: auto): a tooltip inside it would be cut off at the row it belongs
// to, and the rows near either end are exactly the ones a reader needs it for.
export class NavRowTip {
	// What each element says on hover: the row itself, or one cell of it (the time
	// label — "the moment" instead of "which file", see NavHistoryList.fileRow's
	// age). Keyed by ELEMENT rather than by row identity, because the question is
	// asked by a pointer event, which names an element and nothing else.
	private tips = new WeakMap<HTMLElement, TipContent>();
	// The element on screen, while there is one, and the element it belongs to.
	private el?: HTMLElement;
	private anchor?: HTMLElement;
	// The hover's own clock: a pointer crossing the list on its way somewhere else
	// must not flash a tooltip under every row it passed (see TIP_DELAY_MS).
	private timer?: number;
	private doc: Document;
	private win: Window;

	constructor(private list: HTMLElement) {
		// The list's own document, not the top one: a panel may stand in a popout
		// window, and a tooltip has to be built and placed in the window the reader is
		// looking at (see NavHistoryView). Its `defaultView` is that window — the
		// placement measures against it and the delay is its own clock — and the top
		// window is the fallback for a document that has none (a test's).
		this.doc = list.ownerDocument;
		this.win = this.doc.defaultView ?? window;
		// The listeners are on the LIST element and not on the rows: a row is rebuilt on
		// every render, and a listener per row would have to be wired and dropped with
		// each of them. Everything below is the pointer's own reading of where it is.
		this.list.addEventListener('pointerover', this.onOver);
		this.list.addEventListener('pointerout', this.onOut);
		this.list.addEventListener('pointerleave', this.onLeave);
		// A press is about to travel or to rebuild the list, and a tooltip pinned to the
		// row it names would be left pointing at a row that is no longer there. The
		// WRITE half of the panel's reading: the list is click-only, so this is the one
		// pointer event it reacts to.
		this.list.addEventListener('pointerdown', this.onLeave);
		// …and a scroll moves every row out from under a tooltip that is standing still.
		this.list.addEventListener('scroll', this.onLeave, { passive: true });
	}

	// Let one element answer for the hover: what it says, and nothing about when.
	attach(el: HTMLElement, content: TipContent): void {
		this.tips.set(el, content);
	}

	// The list is being REBUILT (see NavHistoryList.render): the rows the registered
	// tips belong to are gone, so the one on screen — which points at a row of the
	// previous render — has to go with them. The registry itself needs no clearing: it
	// is keyed weakly, so the elements the rebuild dropped take their entries with them.
	reset(): void {
		this.forget();
	}

	// The panel is going: out of the document, and off the events.
	destroy(): void {
		this.forget();
		this.list.removeEventListener('pointerover', this.onOver);
		this.list.removeEventListener('pointerout', this.onOut);
		this.list.removeEventListener('pointerleave', this.onLeave);
		this.list.removeEventListener('pointerdown', this.onLeave);
		this.list.removeEventListener('scroll', this.onLeave);
	}

	// The pointer arrived somewhere in the list. Only a change of SUBJECT counts: the
	// event fires again for every child element of the row it is already on, and
	// answering those would restart the delay on a hand that has not moved.
	private onOver = (ev: PointerEvent): void => {
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
			if (this.anchor === target)
				this.show(target, content);
		}, TIP_DELAY_MS);
	};

	// The pointer left. A move that stays INSIDE the subject is not a leave (the row's
	// own children fire this on their way past each other), and anything else is.
	private onOut = (ev: PointerEvent): void => {
		const to = ev.relatedTarget as Node | null;
		if (this.anchor && to && this.anchor.contains(to))
			return;
		this.forget();
	};

	private onLeave = (): void => {
		this.forget();
	};

	// The element the pointer is on, seen as the nearest element that has something to
	// say: the time label inside a note's row answers for itself, and the row answers
	// for everything else in it (see fileRow). Walking up to the list is how the one
	// element that must not answer — the listbox, whose aria-label is not a tooltip —
	// stays out of it.
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

	// Take the tooltip away and drop what was being hovered: the two always move
	// together, and a caller that only wanted one of them would be a caller that left
	// the other standing.
	private forget(): void {
		this.clearTimer();
		this.hide();
		this.anchor = undefined;
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
			// reader can already reach (the row's own text), and this element is not
			// focusable and never will be.
			attr: { 'aria-hidden': 'true' },
		});
		if (content.path)
			this.pathLine(el, content.path);
		if (content.text)
			el.createDiv({ cls: 'nav-tip-text', text: content.text });
		this.el = el;
		this.place(el, target);
	}

	// The path, one segment per span and one separator between each pair: a `/` in the
	// middle of a run of text is the hardest character in the path to see, and the
	// stylesheet gives it a weight of its own instead of leaving it to the font (see
	// .nav-tip-sep). The segments are spans for the same reason: the last one is the
	// file's own name and is the one the reader is looking for.
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

	// Where the tooltip stands: under the row it is about, hanging from the row's own
	// inline start so the path reads from the same edge as the name it belongs to. It
	// flips above the row when the window's foot is too close, and slides inward when
	// its far end would run off — a tooltip that is half off-screen says less than no
	// tooltip at all. Measured AFTER it is in the document, because its width is
	// whatever the path turned out to be.
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
