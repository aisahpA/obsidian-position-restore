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
// 2. The list is a TREE: a note's row is its caret plus the name (and its count,
//    where there are landings to open), and a landing indents under it as
//    coordinate | section | pane. The name is capped (max-width: 20em), NOT
//    measured across rows — the tree says with its indent what the flat list
//    needed a shared name column for — and the pane cell is only there while a
//    row has one (two live tabs hold that note). The age is not a row cell at
//    all any more: it lives in the drawer's head.
//
// 3. On touch a LANDING gets two lines — the coordinate and the section, then the
//    pane — while a note's row stays on one, rather than the old rule that hid
//    the coordinate and the age below 480px and left the list saying nothing but
//    file names.

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

	// The list is one row per NOTE by default: a note's row is its NAME (the arrow
	// leads it, but out of the row's flow — see the next test), and where the setting
	// prints them a landing indents under it with the coordinate in front of its
	// section. There is no list-wide measured column any more — that existed so a
	// single column of sections started on one x down a FLAT list, and the list says
	// the same thing with its indent (see the next test).
	it('lays a note out as its name, and a landing as coordinate + section', () => {
		// The caret is gone outright, and so is the "+N" that counted what a click would
		// open: there is no tree to open any more, so a column of every row repeating
		// that state is a column spent twice (see NavHistoryList.fileRow).
		expect(browser).not.toContain('nav-file-caret');
		expect(browser).not.toContain('nav-row-count');
		expect(browser).toMatch(/\.position-restore-nav-row\.is-file\s*\{[^}]*display: flex/);
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto/);
		// the landing steps in under the note it belongs to
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*margin-inline-start: 1\.5em/);
		// the coordinate keeps its own width — wide enough for a folded cluster's
		// RANGE, "L412–438": sections start on one x only if every row reserves the
		// same room, and a row that printed a one-line label while its neighbour
		// printed a range would not line up with it
		expect(browser).toMatch(/\.nav-row-pos\s*\{[^}]*min-width: 8ch/);
		// and the name is capped rather than greedy
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 20em/);
	});

	// THE TRAVEL ARROW is the row's first thing on screen, but NOT a grid track: it
	// sits in the row's own left PADDING, pinned to the row's own height. That is the
	// difference between a list whose rows are as tall as their text and one whose rows
	// grew a pixel or two when a button moved in — a <button> carries the browser's
	// font and line box, which is a size the row knows nothing about. It replaced the
	// travel arrow, which itself replaced a double click: a click cannot be told from a
	// double-click until the second has arrived, so the row's own action waited out the
	// double-click window — while a control that does something ELSE than the row has no
	// such problem (see NavHistoryList.disclose).
	it('keeps the gutter control out of the row\'s flow, in a gutter of its own', () => {
		// One gutter (and one gap, and one glyph size) for the two row kinds, so they
		// start their text on one x.
		expect(browser).toMatch(/--nav-disclose-track: 1\.7em/);
		expect(browser).toMatch(/--nav-disclose-gap: 8px/);
		expect(browser).toMatch(/--nav-disclose-icon: 1\.05em/);
		// The row RESERVES gutter and gap together, and can hold what it reserves.
		expect(browser).toMatch(
			/\.position-restore-nav-row\s*\{[^}]*position: relative[^}]*padding: 4px 8px 4px calc\(var\(--nav-disclose-track\) \+ var\(--nav-disclose-gap\)\)/,
		);
		// …and the arrow fills the GUTTER (not the gap), top to bottom: pinned to both
		// edges it cannot make the row any taller than it already is. The height pair is
		// not decoration — the app styles every button it has, and an over-constrained
		// absolute box (top, bottom and a height) throws its `bottom` away. The width is
		// the point of the fix a tablet reported: a box as wide as the whole padding put
		// the target on the file name, so a tap on the name travelled.
		expect(browser).toMatch(
			/\.nav-row-disclose\s*\{[^}]*position: absolute[^}]*inset-block: 0[^}]*inset-inline-start: 0[^}]*width: var\(--nav-disclose-track\)/,
		);
		expect(browser).not.toMatch(/width: calc\(var\(--nav-disclose-track\)/);
		expect(browser).toMatch(/\.nav-row-disclose\s*\{[^}]*height: auto[^}]*min-height: 0/);
		// THE SELECTOR IS ONE CLASS LONGER THAN THE STRIP, and that class is the whole of
		// the difference between the devices a reader reported: the app's own tablet rule
		// is `.is-tablet button:not(.clickable-icon)` — two classes and a TYPE, so it
		// outranks a two-class rule — and it pads every button it finds by 4px 20px. Inside
		// this 30px border box that is a content box of nothing, and the glyph was squeezed
		// away: a tablet showed an empty gutter while the phone and the desktop drew the
		// arrow. Two classes lost the fight; three (panel, row, arrow) win it.
		expect(browser).toMatch(
			/\.position-restore-nav-panel\s+\.position-restore-nav-row\s+\.nav-row-disclose\s*\{[^}]*position: absolute/,
		);
		// The BOX is the gutter exactly, and the GAP stays dead ground: nothing of the
		// target may lean into the text, so there is no padding of its own to spill
		// (that padding used to sit to the right of the gutter, and a theme that flipped
		// box-sizing put it outside the box and over the name).
		expect(browser).toMatch(/\.nav-row-disclose\s*\{[^}]*box-sizing: border-box[^}]*padding: 0;/);
		expect(browser).not.toMatch(/\.nav-row-disclose\s*\{[^}]*padding-inline-end/);
		// …and it is painted ON TOP of the row's own text. The spec says so of a
		// positioned box, but a tablet painted the arrow BEHIND the file name it
		// overlapped and showed no arrow at all — while the button kept working.
		expect(browser).toMatch(/\.nav-row-disclose\s*\{[^}]*z-index: 0/);
		// A control, and the ROW's: no box of its own (a wall of outlined buttons would
		// run down the list), the faintest tier the panel has, and the row's font rather
		// than the browser's, which is what `em` inside it has to be measured in.
		expect(browser).toMatch(/\.nav-row-disclose\s*\{[^}]*font: inherit/);
		expect(browser).toMatch(/\.nav-row-disclose\s*\{[^}]*padding: 0[^}]*border: none/);
		expect(browser).toMatch(/\.nav-row-disclose\s*\{[^}]*color: var\(--nav-faint\)/);
		// The glyph has a size of its own, and the app's own icon variable carries it as
		// well: the panel's rule on the `svg` is what a reader's theme usually sees, and
		// a global icon rule that got there first would otherwise decide it.
		expect(browser).toMatch(/\.nav-row-disclose svg\s*\{[^}]*width: var\(--nav-disclose-icon\)/);
		expect(browser).toMatch(/\.nav-row-disclose\s*\{[^}]*--icon-size: var\(--nav-disclose-icon\)/);
		// A finger gets a bigger target AND a bigger glyph, and there they are PIXELS:
		// the gutter was already a fingertip's worth of height, but an em-sized glyph
		// follows the reader's font — and a tablet, whose rows carry the same small UI
		// font on a screen held further away, reported the arrow as "very small, like a
		// dot".
		expect(browser).toMatch(/\.[\w-]*is-touch\s*\{\s*--nav-disclose-track: 30px;\s*--nav-disclose-icon: 20px;/);
		// …and the touch row still RESERVES gutter and gap. The two-value shorthand that
		// stood here dropped the left padding to 8px, which is what put the arrow's
		// whole target on top of the file name on a phone (and behind it on a tablet).
		expect(browser).toMatch(
			/is-touch \.position-restore-nav-row\s*\{[^}]*padding: 6px 8px 6px calc\(var\(--nav-disclose-track\) \+ var\(--nav-disclose-gap\)\)/,
		);
		// …and there the arrow is a tier louder: a finger has no hover to bring it
		// forward, so the faintest tier would be the one thing the hint tells it to hit.
		expect(browser).toMatch(
			/is-touch \.position-restore-nav-row \.nav-row-disclose\s*\{[^}]*color: var\(--nav-muted\)/,
		);
	});

	// The hint tells the reader to use the arrow, so it draws the arrow the rows carry
	// rather than a text stand-in of another shape (see NavHistoryBrowser.hint).
	it('draws the row\'s arrow into the hint that names it', () => {
		expect(browser).toMatch(/\.position-restore-nav-hint \.nav-hint-icon\s*\{[^}]*display: inline-flex/);
		// An inline SVG sits ON the baseline, which leaves it riding high beside
		// lowercase text; the hint's own small tier sizes it.
		expect(browser).toMatch(/\.nav-hint-icon\s*\{[^}]*vertical-align: -0\.2em/);
		expect(browser).toMatch(/\.nav-hint-icon svg\s*\{[^}]*width: 1\.15em/);
	});

	// A folder is printed only where two notes on screen share a name, and it may
	// be clipped when the name needs the room: the name is what a reader scans,
	// the folder only what decides between two of them.
	it('prints the disambiguating folder before the name, and lets the name win', () => {
		expect(browser).toMatch(/\.nav-row-folder\s*\{[^}]*flex: 0 100 auto[^}]*text-overflow: ellipsis/);
		expect(browser).toMatch(/\.nav-row-folder\s*\{[^}]*color: var\(--nav-faint\)/);
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*flex: 0 1 auto/);
	});


	// "You are here" is a dot on the note and on the landing the current entry
	// recorded: the current position is marked INSIDE the list rather than held
	// out of it.
	it('marks the current note and its current landing with a dot', () => {
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*color: var\(--interactive-accent\)/);
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*flex: 0 0 auto/);
	});

	// THE POSITION is painted in one colour whichever hand moved it: the row a click
	// put the panel on and the row the arrows walked are the same row (see
	// NavHistoryList.choose), so they must not look different — and the wash has to
	// survive the pointer reaching that very row.
	it('paints the position the same for the pointer and the keyboard', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected,\s*\n\.position-restore-nav-row\.is-previewed\s*\{[^}]*background-color: color-mix\(in srgb, var\(--interactive-accent\)/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected:hover,\s*\n\.position-restore-nav-row\.is-previewed:hover\s*\{[^}]*background-color: color-mix/,
		);
	});

	// The toolbar's own setting (see NavHistoryBrowser.settings): its button rides at
	// the far end of the strip whatever the box and the hint do with the room, and the
	// panel it opens hangs off the strip rather than taking part in its line — an
	// absolutely positioned child of the toolbar, whose own `position: relative` is
	// what anchors it.
	it('puts the list setting at the far end, and opens its panel off the strip', () => {
		expect(browser).toMatch(/\.position-restore-nav-toolbar\s*\{[^}]*position: relative/);
		expect(browser).toMatch(/\.position-restore-nav-settings\s*\{[^}]*margin-left: auto/);
		expect(browser).toMatch(/\.position-restore-nav-settings-menu\s*\{[^}]*position: absolute/);
		// …and the value in force takes the app's own "active" tint — the wash the
		// position's own row is painted with (see .position-restore-nav-row.is-selected)
		// — rather than a fill that would change the button's size.
		expect(browser).toMatch(
			/\.nav-settings-option\[aria-checked='true'\]\s*\{[^}]*background-color: var\(--background-modifier-active-hover\)/,
		);
	});

	// A theme left this button all but invisible — twice (see the rules above): the
	// app's icon skin paints with --icon-color and dims with --icon-opacity, and any
	// tier MIXED toward the strip is only as visible as the strip's own background
	// allows. So the button is pinned to the theme's PRIMARY text colour, both icon
	// variables are set on it, and the ink travels in a variable only this plugin
	// writes — declared under a selector deep enough (panel + toolbar + button) that a
	// theme cannot outrank the `color`/`--icon-color` fight, and read back one element
	// down for the glyph itself, where no theme rule knows to look.
	it('paints the list setting in a tier a theme cannot wash out', () => {
		const painted =
			browser.match(
				/\.position-restore-nav-panel \.position-restore-nav-toolbar \.position-restore-nav-settings\s*\{[^}]*\}/,
			)?.[0] ?? '';
		expect(painted).toMatch(/--nav-settings-ink: var\(--text-normal\)/);
		expect(painted).toMatch(/color: var\(--nav-settings-ink\)/);
		expect(painted).toMatch(/--icon-color: var\(--nav-settings-ink\)/);
		expect(painted).toMatch(/--icon-opacity: 1/);
		expect(painted).toMatch(/opacity: 1/);
		expect(painted).not.toMatch(/--nav-faint|--nav-muted/);
		expect(browser).toMatch(
			/\.position-restore-nav-settings svg\s*\{[^}]*color: var\(--nav-settings-ink\)/,
		);
		// The mark that says which value is in force stands IN FRONT of its label — at
		// the far end the panel's own width sat between the two — and it keeps its slot
		// on the row that is not ticked, so the two labels start on one x.
		expect(browser).toMatch(/\.nav-settings-option\s*\{[^}]*justify-content: flex-start/);
		expect(browser).toMatch(/\.nav-settings-tick\s*\{[^}]*color: var\(--interactive-accent\)/);
		expect(browser).toMatch(/\.nav-settings-tick\s*\{[^}]*width: 1\.1em/);
		// The few words of an answer stand ON the answer's own row, right after its
		// label (see the locale and NavHistoryBrowser.settingGroup): the tier that
		// printed a paragraph under the group is gone, so nothing has to keep a break
		// in it, and what is styled instead is the answer's own line.
		expect(browser).not.toMatch(/\.nav-settings-desc\s*\{/);
		expect(browser).toMatch(
			/\.nav-settings-option-desc\s*\{[^}]*font-size: var\(--font-ui-smaller\)/,
		);
		expect(browser).toMatch(/\.nav-settings-option-desc\s*\{[^}]*color: var\(--nav-muted\)/);
	});

	// THE DETAILS COLUMN SWITCHED OFF (see NavBrowserPrefs.showDetails): the panel leaves
	// the body's flow, the list takes the room it was holding, and the rows give up the
	// gutter that was the control's ground — stated for the touch layout as well, which
	// sets that same padding again in pixels.
	it('gives the list the room the details column was holding', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-body\.is-no-details \.position-restore-nav-preview\s*\{[^}]*display: none/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-body\.is-no-details \.position-restore-nav-list\s*\{[^}]*flex: 1 1 auto/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-body\.is-no-details \.position-restore-nav-row\s*\{[^}]*padding-left: 8px/,
		);
		// …and the DIALOG, whose extra width was the second column (see the rule): asked
		// of the body's own class, so the shell owns no copy of the preference.
		expect(browser).toMatch(
			/\.modal\.position-restore-nav-modal:has\(\.position-restore-nav-body\.is-no-details\)\s*\{[^}]*width: min\(23em/,
		);
	});


	// A phone gets two lines per row instead of the narrow-screen rule that hid
	// the coordinate and the age — the list then said nothing but file names.
	// What is worth pinning is that the touch layout keeps every cell (a hidden
	// one is information the phone cannot show at all), that the second line
	// hangs off the ROW rather than the name column (whose width changes from row
	// to row), and that nothing hides the age or the line number any more.
	it('gives a phone a two-line LANDING and a one-line note', () => {
		// A note's row stays one line: two lines for the tree's top level would
		// push the landings — the reason the list is worth scrolling — off a small
		// screen. A landing gets the two lines, and its section keeps its row.
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-areas:/,
		);
		// …and the arrow is NOT one of those areas: it is out of the flow, in the
		// row's padding, on every row of both kinds (see the go test above).
		expect(browser).not.toContain('go name trail');
		expect(browser).toContain('.position-restore-nav-panel.is-touch .nav-row-trail { grid-area: trail; }');
		// the pane badge, the one cell that can still be a column, keeps its own
		// place on that second line
		expect(browser).toMatch(/\.position-restore-nav-panel\.is-touch \.nav-row-pane\s*\{[^}]*grid-area: meta/);
		expect(browser).not.toMatch(/@media \(max-width: 480px\)/);
	});

	// On touch the toolbar is TWO rows, and they are stated rather than left to
	// wrapping: the box takes the first, and the hint keeps the second company with
	// the setting at its far end. Wrapping alone could not say that — a 100% basis on
	// the hint leaves no room beside it (so the setting rode the BOX's line, which
	// reads as a blank row with a gear at its end), and with no basis at all the two
	// rows depend on how wide the panel happens to be.
	it('states the touch toolbar\'s two rows, with the setting beside the hint', () => {
		expect(browser).toMatch(
			/is-touch \.position-restore-nav-toolbar\s*\{[^}]*display: grid[^}]*grid-template-areas:\s*'box box'\s*'hint gear'/,
		);
		expect(browser).toMatch(/is-touch \.position-restore-nav-filter\s*\{\s*grid-area: box/);
		expect(browser).toMatch(/is-touch \.position-restore-nav-hint\s*\{[^}]*grid-area: hint/);
		expect(browser).toMatch(/is-touch \.position-restore-nav-settings\s*\{[^}]*grid-area: gear/);
		// …and the hint is back to ONE line: sharing the row means it has less of it,
		// and a hint that wrapped would make the second row two lines tall — exactly
		// the height the layout was rearranged to save
		const hint = browser.slice(
			browser.indexOf('.position-restore-nav-hint {'),
			browser.indexOf('.position-restore-nav-hint .nav-hint-icon'),
		);
		expect(hint).toMatch(/white-space: nowrap/);
		expect(hint).toMatch(/text-overflow: ellipsis/);
		// A media query that only overrode `flex-wrap` would leave the upright phone's
		// GRID in place, so the landscape layout has to say `display: flex` as well
		expect(browser.slice(browser.indexOf('@media (max-height: 520px)'))).toMatch(
			/is-touch \.position-restore-nav-toolbar\s*\{[^}]*display: flex[^}]*flex-wrap: nowrap/,
		);
	});

	// The landing panel has TWO presentations (see LandingPanel), and which one is on
	// is the browser's answer about ROOM, not about the device (see
	// NavHistoryModal.inline): a pointing device always has room for the drawer, and so
	// does a touch device wide enough. The contract worth pinning is that the drawer is
	// a real column of the body (no fixed height of its own — the body's own growth must
	// not squeeze it out), and that the inline panel is in the list's flow with a
	// finger-sized travel button.
	it('stands the drawer in its own column, and keeps the inline panel in the flow', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-body\s*\{[^}]*flex-direction: row/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-list\s*\{[^}]*width: 20em/,
		);
		// The rule is anchored at a LINE start: `.position-restore-nav-preview {`
		// also ends the is-fixed selector list (see the fill test below), and a
		// bare indexOf would slice from there and swallow the list rules too.
		const drawer = browser.slice(
			browser.indexOf('\n.position-restore-nav-preview {'),
			browser.indexOf('.position-restore-nav-panel.is-inline .position-restore-nav-preview {'),
		);
		expect(drawer).toContain('flex: 1 1 auto');
		expect(drawer).toContain('overflow-y: auto');
		// the drawer has no fixed height of its own to be pushed around by: only
		// the min/max pair the body's growth respects
		expect(drawer).not.toMatch(/(^|[^-])height:/);
		// …and the inline panel is a block in the list's flow, of its content's own
		// height: the list is the one scroller there, and a second one nested in it is
		// a way for a finger to get stuck
		expect(browser).toMatch(
			/is-inline \.position-restore-nav-preview\s*\{[^}]*width: auto[^}]*max-height: none/,
		);
		// …and it is a BOUNDED card: four sides of its own, so a reader can see where
		// the recorded lines (or a whole note) end and the rows below begin. A left rule
		// alone left the note's text running into the next file's row, which a reader
		// read straight through before realising the text had changed hands.
		expect(browser).toMatch(
			/is-inline \.position-restore-nav-preview\s*\{[^}]*border: 1px solid var\(--background-modifier-border\)[^}]*border-radius: var\(--radius-s\)/,
		);
		// …and the WHOLE NOTE gets a scroller of its own back: a file is not a row's
		// detail, and finding the recorded line thousands of lines into it has to be
		// able to move something other than the list (see PreviewContent.reveal)
		expect(browser).toMatch(
			/is-inline \.nav-preview-scroll\.is-note\s*\{[^}]*max-height: 60vh[^}]*overflow-y: auto/,
		);
	});

	// A pinned-height dialog must be FILLED by the columns inside it. Both
	// carried `max-height: 60vh` from when a "you are here" card stood above them
	// and made the difference up; with the card gone the list stopped two thirds
	// of the way down a dialog that had already claimed its height, and the rest
	// was dead space the scrollbar was not even in. The height is pinned so that
	// filtering cannot resize and re-center the dialog (see is-fixed), so the fix
	// is to fill it.
	it('fills the pinned height with the columns instead of stopping short of it', () => {
		expect(browser).toMatch(
			/is-fixed \.position-restore-nav-list,\s*\.modal\.position-restore-nav-modal\.is-fixed \.position-restore-nav-preview\s*\{\s*max-height: none/,
		);
		// and the short-history case keeps its cap: there the dialog sizes to its
		// content and a 60vh column would be the tallest thing in it
		expect(browser).toMatch(/\.position-restore-nav-list\s*\{[^}]*max-height: 60vh/);
		// inline the body is a COLUMN, so the list — the one scroller there, with the
		// panel inside it — has to take the leftover height rather than keep sizing
		// itself
		expect(browser).toMatch(
			/is-fixed\.is-inline \.position-restore-nav-list\s*\{\s*flex: 1 1 auto/,
		);
	});

	// The drawer is a COLUMN WITH ONE SCROLLER: the note's name, its section and
	// the two controls are pinned at the top, and only the lines move under them.
	// Reading a long recorded block — or any whole note — used to push all three
	// out of the panel, so the reader scrolled back UP to travel, which is the one
	// thing the panel exists for. (The DOM half of this contract is pinned in
	// nav-history-browser-dom.test.ts: the two blocks and what is in each.)
	it('pins the head and the controls, and scrolls only the lines', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-preview\s*\{[^}]*display: flex[^}]*flex-direction: column[^}]*overflow: hidden/,
		);
		// the header is a recessed strip that runs to the panel's own edge: the
		// drawer's padding-left is the CONTENT inset, so the strip takes it back
		expect(browser).toMatch(
			/\.nav-preview-top\s*\{[^}]*margin-left: -12px[^}]*background-color: var\(--background-secondary\)/,
		);
		// …and inline it is pinned by the LIST it hangs in instead of by a scroller of
		// its own: the panel is a child of the list's scroll, so `sticky` is what keeps
		// the travel button and the view switch in reach while a whole note moves under
		// them — the reader who had switched to the whole note otherwise had to scroll
		// the whole note back to switch out of it. Its background is opaque (rows now
		// slide under it) and is the dialog's own, so the band reads as the top of the
		// list rather than as one more row; the drawer's recessed strip and its negative
		// start margin are undone.
		expect(browser).toMatch(
			/is-inline \.nav-preview-top\s*\{[^}]*position: sticky[^}]*margin-left: 0[^}]*background-color: var\(--modal-background\)/,
		);
		// the fixed half does not grow or shrink
		expect(browser).toMatch(/\.nav-preview-top\s*\{[^}]*flex: 0 0 auto[^}]*border-bottom: 1px solid/);
		// …and the moving half is the one scroller: `min-height: 0` is what lets a
		// flex item be shorter than its content at all
		expect(browser).toMatch(
			/\.nav-preview-scroll\s*\{[^}]*flex: 1 1 auto[^}]*min-height: 0[^}]*overflow-y: auto/,
		);
		// inline the panel is in the LIST's scroll: a second scroll area nested
		// inside the only one a finger can use is a way to get stuck
		expect(browser).toMatch(/is-inline \.nav-preview-scroll\s*\{[^}]*overflow: visible/);
	});

	// Inline the panel hangs directly under the row that names the note, so the name
	// again is the panel reading its own heading back to the reader — and the line it
	// spent on it is a line of the content's room on a phone. What is left of the head
	// is the small print about the step, on one line with the age at its far end.
	it('drops the repeated name inline, and keeps the small print on one line', () => {
		expect(browser).toMatch(/is-inline \.nav-preview-ident\s*\{\s*display: none/);
		expect(browser).toMatch(/is-inline \.nav-preview-head\s*\{[^}]*flex-wrap: nowrap/);
		// the age moves back to the far end (the DOM order is name, age, small print)
		// and the machinery takes what is left of the one line
		expect(browser).toMatch(/is-inline \.nav-preview-meta\s*\{[^}]*flex: 1 1 auto/);
		expect(browser).toMatch(/is-inline \.nav-preview-head \.nav-row-time\s*\{[^}]*order: 2/);
	});

	// …and the row the panel hangs under is pinned by that same scroll for as long as the
	// panel is under it: inline the row IS the handle (one tap opens a note, a second closes
	// it — see NavHistoryList.onClick), and reading a long note used to scroll it off the top
	// and leave the reader with a panel they had to scroll back for. Opaque, because the rows
	// below slide under it, and the position's wash goes OVER that base: the wash alone is a
	// tint of nothing. (What pins it, and only while the panel is on screen, is
	// LandingPanel.sync; the DOM half is in nav-history-browser-dom.test.ts.)
	it('pins the row the panel hangs under, above the pinned block', () => {
		expect(browser).toMatch(/is-inline \.position-restore-nav-row\.is-stuck\s*\{[^}]*position: sticky[^}]*top: 0/);
		expect(browser).toMatch(
			/is-inline \.position-restore-nav-row\.is-stuck\s*\{[^}]*background-color: var\(--modal-background\)/,
		);
		// squared off: a rounded corner is a hole onto whatever is sliding under it
		expect(browser).toMatch(/is-inline \.position-restore-nav-row\.is-stuck\s*\{[^}]*border-radius: 0/);
		// the wash is painted over the opaque base rather than replacing it
		expect(browser).toMatch(
			/is-stuck\.is-selected,[^}]*is-stuck\.is-previewed\s*\{[^}]*background-image: linear-gradient/,
		);
		// …and the block below starts where the row ends, not under it: the height the panel
		// measured off the row while it was still in its slot
		expect(browser).toMatch(/is-row-pinned \.nav-preview-top\s*\{[^}]*top: var\(--nav-pin-row/);
	});

	// The drawer's head reads as a headline over small print: the note's NAME is
	// the biggest thing in the panel (the row that led here names it too, and this
	// is the place with room to set it properly), the folder in front of it is
	// faint and gives way first (the collapse order the rows use), and the facts
	// about the step — pane, type, where a link came from, the coordinate, the
	// warning — are one quiet line under it. The panel's one action is a real
	// button, but deliberately not a filled accent one: the drawer is the second
	// column of a list the reader is scanning.
	it('sets the note name as the panel\'s headline over a line of small print', () => {
		expect(browser).toMatch(/\.nav-preview-title\s*\{[^}]*font-size: var\(--font-ui-medium\)[^}]*font-weight: 600/);
		expect(browser).toMatch(/\.nav-preview-folder\s*\{[^}]*flex: 0 100 auto[^}]*text-overflow: ellipsis/);
		expect(browser).toMatch(/\.nav-preview-meta\s*\{[^}]*flex: 1 0 100%/);
		// Every line of the pinned block keeps its room whether or not the entry
		// has anything for it: the pointer walks the list, and a block that is one
		// line shorter for the entries with no section (or a deleted note, which
		// has no controls at all) makes everything under it jump.
		expect(browser).toMatch(/\.nav-preview-trail\s*\{[^}]*min-height: 1lh/);
		expect(browser).toMatch(/\.nav-preview-meta\s*\{[^}]*flex-wrap: nowrap[^}]*min-height: 1lh/);
		// …a token too long for the column is ellipsized rather than given a line
		expect(browser).toMatch(/\.nav-preview-meta > span\s*\{[^}]*text-overflow: ellipsis/);
		// …and the reserved-but-empty lines are a DRAWER answer only: inline a tap
		// opens one panel under its row, so there is no shape to hold still and
		// the empty lines are dropped instead
		expect(browser).toMatch(
			/is-inline \.nav-preview-meta:empty,\s*\.position-restore-nav-panel\.is-inline \.nav-preview-trail:empty\s*\{\s*display: none/,
		);
		// …and there is no switch of any kind left in the panel: which of the two
		// contents is shown is a SETTING now, chosen in the toolbar's gear (see
		// NavHistoryBrowser.openSettings), so what the caption line carries is the one
		// thing the content cannot say about itself — the recorded range (see the
		// caption test below)
		expect(browser).not.toContain('.nav-preview-modes');
		expect(browser).not.toContain('.nav-preview-mode');
	});

	// The caption line is the one thing the content cannot say about itself: which
	// recorded lines the block covers. It sits in the PINNED half, so a reader who has
	// scrolled into a long block can still see which lines they are looking at — and
	// WHICH of the two contents is shown is not said here at all, because that is a
	// setting and the same on every row (see NavHistoryBrowser.openSettings).
	it('keeps the caption in the pinned half, with no switch on it', () => {
		expect(browser).toMatch(/\.nav-preview-caption-row\s*\{[^}]*display: flex[^}]*align-items: center/);
		// the caption gives way by ellipsis: it repeats the coordinate the head already
		// carries, while the lines below it are what the room is for
		expect(browser).toMatch(/\.nav-preview-caption\s*\{[^}]*flex: 1 1 auto[^}]*text-overflow: ellipsis/);
		// …and the panel carries no action of its own: the row's own click opens the
		// file, and the gutter control is what points the panel (see
		// NavHistoryList.onClick / disclose)
		expect(browser).not.toContain('.nav-preview-go');
		expect(browser).not.toContain('.nav-preview-bar');
		expect(browser).not.toContain('.nav-preview-actions');
		expect(browser).not.toContain('.nav-preview-modes');
	});

	// The content is Obsidian's own rendered markdown, which is why the drawer
	// stopped reading as a debug dump: both classes are the reading view's, and
	// the type therefore comes from the theme rather than from this plugin. The
	// one thing that must NOT come with them is the reading view's box — a
	// viewport height and the file's margins inside a dialog column would fight
	// the drawer's own scroll and padding.
	it('draws the content as a reading view, with the view box undone', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-preview \.nav-preview-content\.markdown-preview-view\s*\{[^}]*height: auto[^}]*padding: 0[^}]*overflow: visible/,
		);
		// the spot is a snippet, not a document: its headings must not outrank the
		// panel they sit in
		expect(browser).toMatch(/\.nav-preview-content\.is-spot :is\(h1, h2, h3, h4, h5, h6\)\s*\{[^}]*font-size:/);
		// the landing is marked in both views: by Obsidian's own ==…== in the
		// recorded block, and by this class for a line found in a whole note
		expect(browser).toMatch(/\.nav-preview-content mark\s*\{/);
		expect(browser).toMatch(/\.nav-preview-content \.nav-preview-landing\s*\{/);
	});

	// A phone held sideways has ~370px of height for everything (the dialog's name, the
	// filter, the list): every one of these is a line the list gets back.
	it('compacts the short-dialog (landscape phone) layout', () => {
		const landscape = browser.slice(browser.indexOf('@media (max-height: 520px)'));
		expect(landscape.length).toBeGreaterThan(500);

		// the dialog's NAME goes: the largest single thing in a 390px-tall dialog, and
		// the one thing there that only repeats what the list under it says
		expect(landscape).toMatch(/is-touch \.modal-header\s*\{\s*display: none/);
		// …and the toolbar takes the row it was in TOGETHER WITH the app's close button,
		// which is not in the header but floats over the content: the content's top
		// padding comes down to the button's own inset and the toolbar is as tall as its
		// box, so the button cannot hang over the list's first row (a 44px target that
		// closes the dialog, sitting on the row a finger is reaching for)…
		expect(landscape).toMatch(/is-touch \.modal-content\s*\{[^}]*padding-top: var\(--size-4-3/);
		expect(landscape).toMatch(/is-touch \.position-restore-nav-toolbar\s*\{[^}]*min-height: var\(--touch-size-m/);
		// …and it yields the button's column, or the filter box runs under it
		expect(landscape).toMatch(
			/is-touch \.position-restore-nav-toolbar\s*\{[^}]*padding-inline-end: calc\(var\(--touch-size-m/,
		);
		// the hint goes entirely
		expect(landscape).toMatch(/is-touch \.position-restore-nav-hint\s*\{\s*display: none/);
		// the box keeps the one line the toolbar has left
		expect(landscape).toMatch(/is-touch \.position-restore-nav-toolbar\s*\{[^}]*flex-wrap: nowrap/);
		expect(landscape).toMatch(/input\.position-restore-nav-filter\s*\{[^}]*flex: 1 1 5em/);
		// …and nothing of the chrome it used to compact is left: the "you are
		// here" card and the file scope both went (see NavHistoryModal)
		expect(browser).not.toContain('position-restore-nav-here');
		expect(browser).not.toContain('position-restore-nav-scope');
		expect(browser).not.toContain('position-restore-nav-toggle');
		// the landing row goes back to one line too (the note's never left one)
		expect(landscape).toMatch(/is-touch \.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-areas: none/);
		// …and the travel button needs no rule of its own here any more: it is never a
		// full-width band (see the touch bar test above), so a short dialog has nothing
		// left to compact about it
		expect(landscape).not.toMatch(/nav-preview-go/);
	});
});
