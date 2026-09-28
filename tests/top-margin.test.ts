// Unit tests for the room above a note (shared/top-margin.ts): the one rule, where it lands, and
// the two things that make the row usable — applying is a REPLACEMENT and not an accumulation (the
// row is edited in place, and a second stylesheet per edit would leave the app matching against
// every number the reader ever dragged to), and the number belongs to the MACHINE rather than to
// the synced settings, so a margin a phone needs never follows the reader to another device.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
// FOR ITS SIDE EFFECTS: 'obsidian' resolves to tests/support/obsidian-stub.ts while this suite
// runs (see vitest.config.mts), and loading it is what installs the global createEl the
// stylesheet is built with. The type import above is erased, so it loads nothing.
import 'obsidian';

import {
	TOP_MARGIN_STYLE_ID,
	applyTopMargin,
	readTopMargin,
	removeTopMargin,
	writeTopMargin,
} from '@/shared/top-margin';

const styleEl = () => document.getElementById(TOP_MARGIN_STYLE_ID);

// The app's local storage, in the only shape this module uses: one slot behind one key.
function makeApp(initial: unknown = null) {
	let value: unknown = initial;
	return {
		app: {
			loadLocalStorage: vi.fn(() => value),
			saveLocalStorage: vi.fn((_key: string, data: unknown) => {
				value = data;
			}),
		} as unknown as App,
		stored: () => value,
	};
}

describe('the room above a note', () => {
	beforeEach(() => {
		removeTopMargin();
	});

	it('goes on as one element the plugin owns', () => {
		applyTopMargin(28);

		expect(document.querySelectorAll('style#' + TOP_MARGIN_STYLE_ID)).toHaveLength(1);
		expect(styleEl()?.textContent).toContain('padding-top: 28px;');
	});

	// The app's own allowance and ours are two different things: it pads the SCROLLING element, so
	// it scrolls away with the content and a landing in the middle of a file stays covered, while
	// ours pads the container and holds all the way down. Left side by side they show up together
	// at the top of a freshly opened note — so ours takes the app's over instead of adding to it.
	it('takes over the room the app gives only at the top of a file', () => {
		applyTopMargin(28);

		const css = styleEl()?.textContent ?? '';
		expect(css).toContain('> .cm-editor > .cm-scroller');
		expect(css).toContain('--view-top-spacing-markdown: var(--file-margins-y, 0px)');
	});

	// The whole point of the row: padding the scroller lifts the file's first line and then
	// scrolls away with the content, while padding the container AROUND it shortens the viewport,
	// so a landing in the middle of a file is clear of the obstruction too.
	it('pads the container around the scroller, not the scroller', () => {
		applyTopMargin(28);

		// Padded is the container, and only the container: the scroller is named by the OTHER rule,
		// which takes the app's allowance away rather than adding to it.
		const css = styleEl()?.textContent ?? '';
		const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
		const padded = blocks.filter((block: string) => block.includes('padding-top'));
		expect(padded).toHaveLength(1);
		expect(padded[0]).toContain('> .markdown-source-view > .cm-editor');
		expect(padded[0]).toContain('> .markdown-reading-view');
		expect(padded[0]).not.toContain('.cm-scroller');
	});

	it('replaces the rule instead of adding a second stylesheet', () => {
		applyTopMargin(8);
		applyTopMargin(40);

		expect(document.querySelectorAll('style#' + TOP_MARGIN_STYLE_ID)).toHaveLength(1);
		expect(styleEl()?.textContent).toContain('padding-top: 40px;');
		expect(styleEl()?.textContent).not.toContain('padding-top: 8px;');
	});

	// 0 is the stop at the end of the slider, and it has to mean what the row says it means.
	it('takes the element away at zero', () => {
		applyTopMargin(28);
		applyTopMargin(0);

		expect(styleEl()).toBeNull();
	});

	it('is remembered on this device, and nowhere else', () => {
		const { app, stored } = makeApp();

		writeTopMargin(app, 24);

		expect(app.saveLocalStorage).toHaveBeenCalledWith(expect.stringContaining('topMargin'), 24);
		expect(readTopMargin(app)).toBe(24);
		expect(stored()).toBe(24);
	});

	// What is stored may have been written by a hand or by an older build. Anything that is not a
	// usable number is no margin — which is also what "never set" means.
	it('reads no margin out of whatever else may be sitting in that slot', () => {
		expect(readTopMargin(makeApp(null).app)).toBe(0);
		expect(readTopMargin(makeApp('28').app)).toBe(0);
		expect(readTopMargin(makeApp(-8).app)).toBe(0);
		expect(readTopMargin(makeApp(3.6).app)).toBe(4);
	});
});
