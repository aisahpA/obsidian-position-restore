// A FINGER THAT STOPPED MOVING — the one gesture a phone has where a desktop has a
// hover. It names no row and draws nothing: which element a press landed on is a
// question about the rows, not about the gesture (see RecentFilesList.arm).
//
// WHY NOT `contextmenu`: a WebView does raise it for a long touch, but not on every
// platform a reader might be holding, and a gesture this panel hangs a removal on
// cannot be one that only sometimes arrives. So the clock is the ONE judge, and an
// early `contextmenu` is merely the same press arriving by another door (see
// RecentFilesList.onContextMenu) — arming is idempotent, which keeps both doors open.
//
// WHY NOT A SWIPE: the list stands in a drawer on a phone, and the list's own
// `touch-action` leaves the horizontal axis to the shell on purpose. A press that
// does not move claims nothing anyone else is using.
export interface LongPressOptions {
	ms: number;
	slop: number;
	// The finger's own target, handed over whole rather than resolved.
	onArm: (target: Node) => void;
}

export class LongPress {
	private timer?: number;
	private at?: { x: number; y: number };
	// Whether this press armed a row, and so whether the click the finger may still
	// deliver when it lifts is the press's own (see consumeClick).
	private claimed = false;
	// The window the list stands in, and not the top one: a panel may be in a popout.
	private win: Window;

	constructor(private el: HTMLElement, private opts: LongPressOptions) {
		this.win = el.ownerDocument.defaultView ?? window;
		// All four are heard on the LIST and not on the rows: a row is rebuilt on every
		// render, and what is being heard is one finger's journey.
		this.el.addEventListener('pointerdown', this.onDown);
		this.el.addEventListener('pointermove', this.onMove);
		this.el.addEventListener('pointerup', this.onEnd);
		this.el.addEventListener('pointercancel', this.onEnd);
	}

	destroy(): void {
		this.cancel();
		this.el.removeEventListener('pointerdown', this.onDown);
		this.el.removeEventListener('pointermove', this.onMove);
		this.el.removeEventListener('pointerup', this.onEnd);
		this.el.removeEventListener('pointercancel', this.onEnd);
	}

	// A row was armed by this press — from the clock, or from the `contextmenu` the
	// same finger raised.
	markArmed(): void {
		this.claimed = true;
	}

	// Answered ONCE: a long press that arms a row also delivers a click when the
	// finger comes up, and a reader who stopped on a row did not ask to go there.
	consumeClick(): boolean {
		const claimed = this.claimed;
		this.claimed = false;
		return claimed;
	}

	// WHY THIS HAS TO BE SAID FROM OUTSIDE: the row's own controls stop their presses
	// from reaching this module (see RecentFilesList.fileRow), so a finger landing on
	// a control the previous press put there is a finger never heard here — and a
	// claim outliving its own press SWALLOWS that tap: the reader aims at the ×,
	// nothing happens, and the next tap opens the note instead.
	//
	// Whether the tail click arrives at all is the platform's business: a WebView that
	// raised a menu for the press may deliver no click with it. A claim cannot be held
	// until something happens to spend it.
	release(): void {
		this.cancel();
		this.claimed = false;
	}

	private onDown = (ev: PointerEvent): void => {
		this.cancel();
		this.claimed = false;
		// A middle press opens and a right press raises a menu; only a finger rests.
		if (ev.button !== 0)
			return;
		this.at = { x: ev.clientX, y: ev.clientY };
		// Read NOW and not when the clock runs out: the row under the finger is the row
		// it came down on, and a render in between would hand over its replacement.
		const target = ev.target instanceof Node ? ev.target : this.el;
		this.timer = this.win.setTimeout(() => {
			this.timer = undefined;
			this.at = undefined;
			this.opts.onArm(target);
		}, this.opts.ms);
	};

	// Enough of a move and the press was a scroll or a drag, not a rest — dropped for
	// good rather than restarted: a finger that left its row is not coming back to it.
	private onMove = (ev: PointerEvent): void => {
		if (!this.at)
			return;
		if (Math.abs(ev.clientX - this.at.x) > this.opts.slop
			|| Math.abs(ev.clientY - this.at.y) > this.opts.slop)
			this.cancel();
	};

	// The finger came up, or the gesture was taken away from us (a second finger, the
	// phone turning). Whether it armed a row is already recorded (see markArmed).
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
