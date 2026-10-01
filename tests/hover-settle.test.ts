// Tests for PreviewSettle (recent-files/browser/hover-settle.ts), the observer
// that watches the app's own page preview and covers the jump it makes when it
// is asked for a line.
//
// What is pinned here is the LOOP'S LIFETIME, the part that is easy to get
// wrong in either direction. It has to still be looking when the app answers
// late — this panel's preview needs the Mod key, so the popover may appear ten
// seconds after the row was asked — and it has to NOT still be looking once
// the hover has ended, or a card the reader is reading stands open under a
// paint loop that has nothing left to wait for. The tracked popover is not
// what decides that; the asking is.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { HoverParent, HoverPopover } from 'obsidian';
import { PreviewSettle } from '@/recent-files/browser/hover-settle';

// Enough of the app's handle: the parent the asking is handed to, and the one
// member this module reads off it.
type Parent = { hoverPopover?: HoverPopover };

function makePopover(): HoverPopover {
	const el = document.createElement('div');
	// isConnected is what the loop asks: a card the app has taken away is gone
	// even while the field still names it.
	document.body.appendChild(el);
	return { hoverEl: el } as unknown as HoverPopover;
}

function harness() {
	const parent: Parent = {};
	const opened: HTMLElement[] = [];
	const settle = new PreviewSettle();
	settle.attach(parent as unknown as HoverParent, el => opened.push(el));
	return { parent, opened, settle };
}

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
	frames = [];
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
});

// Let the loop take the looks it is waiting on, and let the awaits after each
// of them settle. The paint itself is stubbed, so a look is a frame and not a
// clock.
async function paint(times = 1): Promise<void> {
	for (let i = 0; i < times; i++) {
		const due = frames;
		frames = [];
		for (const cb of due)
			cb(0);
		for (let k = 0; k < 5; k++)
			await Promise.resolve();
	}
}

describe('PreviewSettle', () => {
	// The reason the loop is an observer and not a wait: when the app answers is
	// not bounded, so several frames of silence must not end it.
	it('app 答晚了它还在看', async () => {
		const h = harness();
		h.settle.ask(false); // a section: it is drawn where it stands
		await paint(3);

		h.parent.hoverPopover = makePopover();
		await paint(2);

		expect(h.opened).toHaveLength(1);
	});

	it('悬停期间 app 换了 popover 会被报告出来', async () => {
		const h = harness();
		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);

		h.parent.hoverPopover = makePopover();
		await paint(2);

		expect(h.opened).toHaveLength(2);
	});

	// What the loop waits for is bounded by the asking: the app opens its preview
	// off the pointer, so a pointer that has left the list means no further answer
	// is coming — however long the card it left behind stands open.
	it('悬停一结束就撤下来，不管有没有 popover', async () => {
		const h = harness();
		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);
		expect(h.opened).toHaveLength(1);

		h.settle.hoverEnded();
		await paint(2);

		h.parent.hoverPopover = makePopover();
		await paint(3);

		expect(h.opened).toHaveLength(1);
	});

	// Standing down is not permanent: the next asking starts it again, and its
	// first look is the one that notices the popover it remembered has closed.
	it('下一次提问时重新开始', async () => {
		const h = harness();
		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);
		h.settle.hoverEnded();
		await paint(2);

		h.settle.ask(false);
		h.parent.hoverPopover = makePopover();
		await paint(2);

		expect(h.opened).toHaveLength(2);
	});
});
