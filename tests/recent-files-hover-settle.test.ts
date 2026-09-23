// The cover over the app's own page preview: what the popover does between being
// ASKED for a line and arriving at it (see recent-files/browser/hover-settle.ts).
//
// Everything here is a stand-in for the core's half of that: nothing about the real
// PeekPopover can be built in jsdom, but none of it needs to be — the observer asks
// exactly two things of it (the popover's element, and the core's own mark left on
// the line it landed on), and those are the two things the two sides agreed on in
// the core's own code. What is tested is this side of the seam: that no part of the
// journey is visible, however late the app's answer comes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HoverParent, HoverPopover } from 'obsidian';

import { PreviewSettle } from '@/recent-files/browser/hover-settle';

// The parent the core writes its popover into, as the app hands it over.
const parentOf = (el?: HTMLElement): HoverParent => ({
	hoverPopover: el ? ({ hoverEl: el } as unknown as HoverPopover) : null,
});

// The popover itself: a card, and inside it whatever the core renders later.
const popover = () => {
	const el = document.createElement('div');
	const content = document.createElement('div');
	el.appendChild(content);
	document.body.appendChild(el);
	return { el, content };
};

// One look of the observer's eye: its clock is the paint (see shared/wait.ts
// nextPaint), so one turn of the fake clock past it is one look.
const look = () => vi.advanceTimersByTimeAsync(150);

describe('PreviewSettle — the cover over the preview’s own journey', () => {
	let settle: PreviewSettle;
	let opened: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		settle = new PreviewSettle();
		opened = vi.fn();
		document.body.innerHTML = '';
	});

	afterEach(() => {
		settle.stop();
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	it('covers the popover whenever it arrives — the key may come long after the asking', async () => {
		// The panel's own registration says the Mod key is required (see main.ts), so
		// the app answers when the reader PRESSES it: ten seconds of hovering first is
		// an ordinary thing, and a cover that has gone home by then is the jump and
		// the flash coming back (see hover-settle.ts's header).
		const parent = parentOf();
		settle.attach(parent, opened);
		settle.ask(true);
		await vi.advanceTimersByTimeAsync(5000);

		const { el, content } = popover();
		parent.hoverPopover = { hoverEl: el } as unknown as HoverPopover;
		await look();

		expect(content.style.opacity).toBe('0');
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it('reveals when the scroll’s own witness arrives, with the search mark already off', async () => {
		// The core puts `.is-flashing` on the line in the SAME call that moves the
		// scroller, so the flash is the certain news that the note has landed — and it
		// is the search hit's three seconds, never meant for a preview, so it is taken
		// off in the same look that ends the cover.
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		const hit = document.createElement('div');
		hit.classList.add('is-flashing');
		content.appendChild(hit);
		await look();

		expect(content.style.opacity).toBe('');
		expect(el.querySelector('.is-flashing')).toBeNull();
	});

	it('hides content that arrives after the card itself', async () => {
		// The content node is later than the popover it belongs to, so the cover is
		// re-applied at every look rather than once.
		const { el } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();

		const late = document.createElement('div');
		el.appendChild(late);
		await look();

		expect(late.style.opacity).toBe('0');
	});

	it('stops waiting at the deadline rather than holding a blank card', async () => {
		// The deadline is for the version of the app that keeps the position and drops
		// the flash: a popover that never quite caught up is uncovered whole rather
		// than held blank while we wonder about it.
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		await vi.advanceTimersByTimeAsync(1600);

		expect(content.style.opacity).toBe('');
	});

	it('reports the opening — and covers nothing — when no line was asked', async () => {
		// A section is drawn where it stands, so there is no journey to hide; but the
		// OPENING itself is still news the panel is waiting for (see NavRowTip).
		const parent = parentOf();
		settle.attach(parent, opened);
		settle.ask(false);
		const { el, content } = popover();
		parent.hoverPopover = { hoverEl: el } as unknown as HoverPopover;
		await look();

		expect(opened).toHaveBeenCalledTimes(1);
		expect(content.style.opacity).toBe('');
	});

	it('covers an already-standing popover when the next asking names a line', async () => {
		// The pointer crossed over from another row: the note about to load into the
		// open card makes the same journey, so the cover starts with the asking —
		// one visible frame of the note's head is already too late.
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(false);
		await look();
		expect(opened).toHaveBeenCalledTimes(1);

		settle.ask(true);

		expect(content.style.opacity).toBe('0');
	});

	it('puts the old note back at the deadline when an asking is answered with nothing', async () => {
		// Covering the standing card is a bet that a journey is beginning; a refused
		// asking must not keep the reader's note hidden for it.
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(false);
		await look();

		settle.ask(true);
		expect(content.style.opacity).toBe('0');
		await vi.advanceTimersByTimeAsync(1600);

		expect(content.style.opacity).toBe('');
	});

	it('lets go when the hover ends — and watches again when one begins', async () => {
		// The pointer leaving the list ends the ASKING, not the popover: a cover still
		// on comes off, but the card stays tracked, so a pointer coming back is not
		// told a second time that it "opened".
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		settle.hoverEnded();
		expect(content.style.opacity).toBe('');

		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it('lets a newer popover own the cover', async () => {
		// Rows are crossed one after another: an older card has no business staying
		// covered once the app has answered a newer asking.
		const first = popover();
		const parent = parentOf(first.el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(first.content.style.opacity).toBe('0');

		const second = popover();
		parent.hoverPopover = { hoverEl: second.el } as unknown as HoverPopover;
		await look();

		expect(first.content.style.opacity).toBe('');
		expect(second.content.style.opacity).toBe('0');
		expect(opened).toHaveBeenCalledTimes(2);
	});

	it('answers "is one open" from the app’s own handle, not from memory', async () => {
		// The rows' hints ask this before speaking (see NavRowTip): a remembered
		// answer would go stale exactly when it mattered — the popover closing while
		// the pointer never left the list.
		const { el } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		expect(settle.isOpen()).toBe(true);

		settle.ask(false);
		await look();
		el.remove();

		expect(settle.isOpen()).toBe(false);
	});

	it('restores a card it is no longer covering when the asking moves on', async () => {
		// An asking can arrive while another card is still under the cover — the app
		// replaced its popover between looks, and the new asking names a line. The old
		// card is the app's to show again exactly as it was.
		const first = popover();
		const parent = parentOf(first.el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(first.content.style.opacity).toBe('0');

		const second = popover();
		parent.hoverPopover = { hoverEl: second.el } as unknown as HoverPopover;
		settle.ask(true);

		expect(first.content.style.opacity).toBe('');
		expect(second.content.style.opacity).toBe('0');
	});

	it('leaves nothing hidden when the panel goes away', async () => {
		// A popover left covered would be a bug that outlives the rows that caused it.
		const { el, content } = popover();
		const parent = parentOf(el);
		settle.attach(parent, opened);
		settle.ask(true);
		await look();
		expect(content.style.opacity).toBe('0');

		settle.stop();

		expect(content.style.opacity).toBe('');
	});
});
