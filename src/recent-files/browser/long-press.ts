// A FINGER THAT STOPPED MOVING — the one gesture a phone has where a desktop has a
// hover, and the only thing this module recognises.
//
// WHAT IT DECIDES is narrow on purpose: a press that came down, stayed inside a few
// pixels, and was still there LONG_PRESS_MS later. Everything else — a tap, a scroll,
// a drag that folded the drawer away, a second finger — is not a long press, and this
// module forgets it as soon as it knows. It names no row, draws nothing and holds no
// state that outlives the press: the ROW it happened on is the list's to work out (see
// RecentFilesList.arm), because which element a press landed on is a question about
// the rows and not about the gesture.
//
// WHY IT IS HEARD HERE AND NOT FROM `contextmenu`: a WebView does raise `contextmenu`
// for a long touch as well as for a right click — the two are told apart by the BUTTON
// the event carries (see RecentFilesList.onContextMenu) — but it does not do so on
// every platform a reader might be holding, and a gesture this panel is about to hang
// a removal on cannot be one that only sometimes arrives. So the clock is the ONE
// judge, and a `contextmenu` that comes early is merely the same press arriving by
// another door: it arms the row (see RecentFilesList.onContextMenu) and the clock, if
// it is still running, finds the row already armed. Arming is idempotent, which is
// what lets both doors be open at once.
//
// WHY IT IS NOT A SWIPE: the list stands in a DRAWER on a phone, and the drawer is
// folded away by a horizontal drag — the list's own `touch-action` gives the panel the
// vertical axis and leaves the horizontal one to the shell on purpose. A gesture that
// claimed the sideways drag would be a gesture competing with the drawer for it, and
// there is no way to test the outcome from here: the drawer is the app's, closed, and
// only a phone can say who won. A press that does not move claims nothing anyone else
// is using.
export interface LongPressOptions {
	// How long the finger rests before the press is a long one (see LONG_PRESS_MS).
	ms: number;
	// How far it may drift and still count as resting (see LONG_PRESS_SLOP_PX).
	slop: number;
	// The press became a long press, on this element: the finger's own target, handed
	// over whole rather than resolved, because what is under the finger is a question
	// about the rows (see RecentFilesList.arm, and tip.ts's own `subject`).
	onArm: (target: Node) => void;
}

export class LongPress {
	// The clock of the press that is down, and where it came down — both dropped the
	// moment the press stops being a candidate (it moved, or it ended).
	private timer?: number;
	private at?: { x: number; y: number };
	// Whether this press ARMED a row, and so whether the click the finger may still
	// deliver when it lifts is the press's own rather than the reader's (see
	// consumeClick). Reset by the next press, because a click that never came leaves
	// no claim for a later one to inherit.
	private claimed = false;
	// The window the list stands in, and not the top one: a panel may be in a popout,
	// and its clock is that window's (see tip.ts on the same rule).
	private win: Window;

	constructor(private el: HTMLElement, private opts: LongPressOptions) {
		this.win = el.ownerDocument.defaultView ?? window;
		// All four are heard on the LIST and not on the rows: a row is rebuilt on every
		// render, and what is being heard is one finger's journey rather than whichever
		// row it happens to be over.
		this.el.addEventListener('pointerdown', this.onDown);
		this.el.addEventListener('pointermove', this.onMove);
		this.el.addEventListener('pointerup', this.onEnd);
		this.el.addEventListener('pointercancel', this.onEnd);
	}

	// The panel is going (see RecentFilesList.destroy).
	destroy(): void {
		this.cancel();
		this.el.removeEventListener('pointerdown', this.onDown);
		this.el.removeEventListener('pointermove', this.onMove);
		this.el.removeEventListener('pointerup', this.onEnd);
		this.el.removeEventListener('pointercancel', this.onEnd);
	}

	// A row was armed by this press — from the clock, or from the `contextmenu` the
	// same finger raised. Whatever the browser delivers when the finger lifts is then
	// the press's own tail and not a second gesture (see consumeClick).
	markArmed(): void {
		this.claimed = true;
	}

	// Whether the click arriving now belongs to the press that armed a row. Answered
	// ONCE: a long press that arms a row also delivers a click when the finger comes
	// up, and a reader who stopped on a row did not ask to go there.
	consumeClick(): boolean {
		const claimed = this.claimed;
		this.claimed = false;
		return claimed;
	}

	// A finger came down again, and the click the last press earned is either spent
	// or never coming — either way the claim is over.
	//
	// WHY THIS HAS TO BE SAID FROM OUTSIDE: the press hears the list, and the row's
	// own controls stop their presses from reaching it (see RecentFilesList.fileRow),
	// because a press on a control is not a press on a row. So a finger landing on a
	// control the previous press put there is a finger this module never hears — and
	// a claim that outlives its own press SWALLOWS that tap: the reader aims at the
	// ×, nothing happens, and the tap after it, aimed at the same place, lands on a
	// disarmed row and opens the note instead.
	//
	// Whether the tail click arrives at all is the platform's business: a WebView
	// that raised a menu for the press (see the class comment) may deliver no click
	// with it, and so may a finger that drifted past the slop on its way up. A claim
	// cannot be held until something happens to spend it.
	release(): void {
		this.cancel();
		this.claimed = false;
	}

	// A finger came down: the only moment a long press can begin.
	//
	// A press with any other button is not one: a middle press opens (see
	// RecentFilesList.onPress) and a right press raises a menu, and neither is a
	// finger resting. On a touch device there is only the one button anyway, and the
	// check is what keeps a stylus's barrel press out of it.
	private onDown = (ev: PointerEvent): void => {
		this.cancel();
		this.claimed = false;
		if (ev.button !== 0)
			return;
		this.at = { x: ev.clientX, y: ev.clientY };
		// The finger's own target, read NOW and not when the clock runs out: the row
		// under the finger is the row the press came down on, and a render in between
		// would otherwise hand over whatever took its place.
		const target = ev.target instanceof Node ? ev.target : this.el;
		this.timer = this.win.setTimeout(() => {
			this.timer = undefined;
			this.at = undefined;
			this.opts.onArm(target);
		}, this.opts.ms);
	};

	// The finger moved. Enough of a move and the press was never a rest at all — it
	// was a scroll beginning, or a drag taking the drawer with it — and the clock is
	// dropped for good rather than restarted: a finger that has left its row is not
	// coming back to it.
	private onMove = (ev: PointerEvent): void => {
		if (!this.at)
			return;
		if (Math.abs(ev.clientX - this.at.x) > this.opts.slop
			|| Math.abs(ev.clientY - this.at.y) > this.opts.slop)
			this.cancel();
	};

	// The finger came up, or the gesture was taken away from us (the app began
	// dragging something, a second finger landed, the phone turned). Either way the
	// press is over; whether it armed a row is already recorded (see markArmed).
	private onEnd = (): void => {
		this.cancel();
	};

	private cancel(): void {
		if (this.timer !== undefined)
			this.win.clearTimeout(this.timer);
		this.timer = undefined;
		this.at = undefined;
	}
}
