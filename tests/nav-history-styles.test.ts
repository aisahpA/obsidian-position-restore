// Guards for the history browser's little print — read out of styles.css, not
// the DOM, because jsdom never loads a stylesheet and every one of these is a
// contract no rendering test here could catch.
//
// Two of them:
//
// 1. The quiet tiers (the section, the coordinate, the age, the toolbar chrome)
//    must NOT be painted with --text-faint / --text-muted. Those are ordinary
//    theme variables, and a theme may re-hue them to something louder than the
//    panel's own text: under Soft Paper (a Catppuccin theme) --text-faint is a
//    saturated cyan and --text-muted a second hue, so the FAINTEST tier came out
//    as the most eye-catching thing in the list while the note's name stayed
//    gray. styles.css mixes its own tiers out of --text-normal toward
//    transparent instead — always the same hue as the text it sits under,
//    always lighter against the background, in any palette.
//
// 2. The row is name | section | small print: the name column is measured so it
//    comes out the SAME width on every row (the section starts at one x down the
//    list — the column the eye runs down), and the small print (×N, pane,
//    coordinate, age) is one block of fixed cells after it. The name column is
//    never a fixed 16em: it is the widest name on screen, capped at 16em and at
//    a share of the panel, so a shorter name leaves only the difference to the
//    longest one rather than a hole the eye cannot cross — and never a dead 11ch
//    age track either, since that one is measured from the labels too.
//
// 3. A touch device gets the same six cells on two lines rather than the old
//    rule that hid the coordinate and the age below 480px, which left the list
//    saying nothing but file names.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// vitest runs from the project root; `import.meta.url` is not a file: URL here.
const css = readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');

// Only the browser's own rules: the restore cue above the marker and the
// db-path modal are different surfaces with their own colour decisions.
const browser = css.slice(css.indexOf('/* History browser (NavHistoryModal)'));

describe('history browser quiet tiers', () => {
	it('slices out the browser section', () => {
		expect(browser).toContain('.position-restore-nav-row');
		expect(browser.length).toBeGreaterThan(2000);
	});

	it('derives both tiers from the theme primary text colour', () => {
		for (const name of ['--nav-muted', '--nav-faint'])
			expect(browser).toContain(`${name}: color-mix(in srgb, var(--text-normal)`);
	});

	it('paints no tier with a variable a theme is free to re-hue', () => {
		// `var(...)` and not the bare names: the rules above explain the
		// rejected variables in prose, and that prose may name them.
		expect(browser.match(/var\(--text-(?:faint|muted)\)/g) ?? []).toEqual([]);
	});

	// The name column used to be a fixed 16em track, which left a hole the width
	// of the longest note between the name and the section of every shorter-named
	// row; content-sizing it fixed the hole but made the section start at a
	// different x on every row. It is measured now — one width for the whole
	// list, bounded by the name's own cap and by a share of the panel — and that
	// is the whole fix, so it is worth pinning. The coordinate keeps its own
	// width inside the small-print block (5ch, in the mono font it is set in),
	// and the age column is the other measured one, not a fixed track.
	it('aligns the section column on a measured, capped name track', () => {
		expect(browser).toMatch(
			/grid-template-columns: minmax\(0, var\(--nav-name-col, max-content\)\) minmax\(0, 1fr\) auto;/,
		);
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 16em/);
		expect(browser).toMatch(/\.nav-row-trail\s*\{[^}]*margin-inline-start/);
		expect(browser).toMatch(/\.nav-row-pos\s*\{[^}]*min-width: 5ch/);
		expect(browser).toMatch(/\.nav-row-time\s*\{[^}]*width: var\(--nav-time-col/);
	});

	// A phone gets two lines per row instead of the narrow-screen rule that hid
	// the coordinate and the age — the list then said nothing but file names.
	// What is worth pinning is that the touch layout keeps every cell (a hidden
	// one is information the phone cannot show at all), that the second line
	// hangs off the ROW rather than the name column (whose width changes from row
	// to row), and that nothing hides the age or the line number any more.
	it('gives a touch device two lines and hides no cell', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-modal\.is-touch \.position-restore-nav-row\s*\{[^}]*grid-template-areas/,
		);
		for (const rule of ['nav-row-file { grid-area: name', 'nav-row-trail { grid-area: trail', 'nav-row-meta { grid-area: meta'])
			expect(browser).toContain(`.position-restore-nav-modal.is-touch .${rule}; }`);
		expect(browser).not.toMatch(/@media \(max-width: 480px\)/);
	});

	// The landing panel used to be pinned under the list with a max-height of its
	// own: a long history took the height it needed away and pushed it off the
	// bottom of the screen, with the only button a finger can travel with. In the
	// list's own flow, with no height of its own, nothing can squeeze it out.
	it('keeps the touch landing panel in the list flow, with a finger-sized button', () => {
		expect(browser).toMatch(/is-touch \.position-restore-nav-preview\s*\{[^}]*display: block/);
		expect(browser).not.toMatch(/is-touch \.position-restore-nav-preview\s*\{[^}]*max-height/);
		expect(browser).toContain('.position-restore-nav-modal.is-touch .position-restore-nav-preview.is-parked {');
		expect(browser).toMatch(/is-touch \.nav-preview-go\s*\{[^}]*width: 100%/);
	});

	// Sharing the toolbar row with the filter box cut the touch hint off at the
	// panel's edge — the box shrinks, a nowrap line does not.
	it('lets the touch hint wrap onto a line of its own', () => {
		expect(browser).toMatch(
			/is-touch \.position-restore-nav-hint\s*\{[^}]*flex: 1 0 100%[^}]*white-space: normal/,
		);
	});

	// The core "Page preview" plugin owns the popover, and what the browser can
	// say about it is said through two variables and a hold class
	// (nav-history-modal.placePagePreview / holdPreview). None of that renders in
	// jsdom, so the contract is pinned here: both plugin placement edges are
	// overridden by OUR coordinates (its own choice put the preview under the row
	// and across the panel), and the hold hides the popover while it is still
	// showing the top of the note — invisible, but not out of the layout the
	// renderer is still measuring.
	it('places and holds the native preview popover from the browser own rules', () => {
		const popover = browser.slice(0, browser.indexOf('.modal.position-restore-nav-modal {'));
		expect(popover).toContain('body.position-restore-nav-open > .popover.hover-popover');
		expect(popover).toContain('var(--position-restore-popover-left, 0px)');
		expect(popover).toContain('var(--position-restore-popover-top, 0px)');
		// the plugin bottom-anchors the popover when it chooses to open upward
		expect(popover).toContain('bottom: auto !important');
		expect(popover).toMatch(
			/body\.position-restore-nav-open\.is-preview-pending > \.popover\.hover-popover \{\s*visibility: hidden !important;/,
		);
	});

	// A phone held sideways has ~370px of height for everything (title bar,
	// filter, "you are here" card, list): every one of these is a line the list
	// gets back.
	it('compacts the short-dialog (landscape phone) layout', () => {
		const landscape = browser.slice(browser.indexOf('@media (max-height: 520px)'));
		expect(landscape.length).toBeGreaterThan(1000);

		// the hint goes entirely
		expect(landscape).toMatch(/is-touch \.position-restore-nav-hint\s*\{\s*display: none/);
		// the box and the scope chip share one line instead of wrapping
		expect(landscape).toMatch(/is-touch \.position-restore-nav-toolbar\s*\{[^}]*flex-wrap: nowrap/);
		expect(landscape).toMatch(/nav-toggle > span\s*\{[^}]*max-width: 12em/);
		// the card is one line: marker, file, coordinate — no age or anchor
		expect(landscape).toMatch(/position-restore-nav-here\s*\{[^}]*display: flex/);
		expect(landscape).toMatch(
			/nav-here-head \.nav-row-time,\s*\.position-restore-nav-modal \.position-restore-nav-here \.nav-here-anchor \{\s*display: none;/,
		);
		// rows back to one line each
		expect(landscape).toMatch(/is-touch \.position-restore-nav-row\s*\{[^}]*grid-template-areas: none/);
		// and the travel button is no longer a full-width band
		expect(landscape).toMatch(/is-touch \.nav-preview-go\s*\{[^}]*width: auto/);
	});
});
