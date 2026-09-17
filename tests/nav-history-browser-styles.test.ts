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

	// The list is a TREE: a note's row is its caret plus the name, and a landing
	// indents under it with the coordinate in front of its section. There is no
	// list-wide measured column any more — that existed so a single column of
	// sections started on one x down a FLAT list, and the tree says the same
	// thing with its indent (see the next test).
	it('lays out a note as caret + name, and a landing as coordinate + section', () => {
		expect(browser).toMatch(/\.position-restore-nav-row\.is-file\s*\{[^}]*grid-template-columns: 1\.1em minmax\(0, 1fr\)/);
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto/);
		// the landing steps in under the note it belongs to
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*margin-inline-start: 1\.5em/);
		// the caret is a fixed square, so a run of names starts on one x
		expect(browser).toMatch(/\.nav-file-caret\s*\{[^}]*text-align: center/);
		// the coordinate keeps its own width: the sections below still line up
		expect(browser).toMatch(/\.nav-row-pos\s*\{[^}]*min-width: 5ch/);
		// and the name is capped rather than greedy
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 20em/);
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

	// THE POSITION is painted in one colour whichever hand moved it: the row the
	// mouse hovered and the row the arrows walked are the same row (see
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

	// How many landings open under a note rides with the name, so no column is
	// reserved for it on the rows that carry no count.
	it('rides the landing count with the note name', () => {
		expect(browser).toMatch(/\.nav-row-count\s*\{[^}]*margin-inline-start: 0\.4em/);
		expect(browser).toMatch(/\.nav-row-count\s*\{[^}]*color: var\(--nav-faint\)/);
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
			/\.position-restore-nav-modal\.is-touch \.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-areas:/,
		);
		expect(browser).toContain('.position-restore-nav-modal.is-touch .nav-row-trail { grid-area: trail; }');
		expect(browser).toMatch(
			/\.position-restore-nav-modal\.is-touch \.position-restore-nav-row\.is-file\s*\{[^}]*display: flex/,
		);
		// the pane badge, the one cell that can still be a column, keeps its own
		// place on that second line
		expect(browser).toMatch(/\.position-restore-nav-modal\.is-touch \.nav-row-pane\s*\{[^}]*grid-area: meta/);
		expect(browser).not.toMatch(/@media \(max-width: 480px\)/);
	});

	// Sharing the toolbar row with the filter box cut the touch hint off at the
	// panel's edge — the box shrinks, a nowrap line does not.
	it('lets the touch hint wrap onto a line of its own', () => {
		expect(browser).toMatch(
			/is-touch \.position-restore-nav-hint\s*\{[^}]*flex: 1 0 100%[^}]*white-space: normal/,
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
			browser.indexOf('.position-restore-nav-modal.is-inline .position-restore-nav-preview {'),
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
		expect(browser).toMatch(/is-touch \.nav-preview-bar \.nav-preview-go\s*\{[^}]*font-size: var\(--font-ui-small\)/);
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
	// it — see NavHistoryList.onTap), and reading a long note used to scroll it off the top
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
		// the panel's one action is a QUIET accent button: an accent wash under the
		// accent's own text — the app's filled primary button was too loud beside a
		// list the reader is scanning, and a plain outline read as disabled in dark
		// themes. Its height is shared with the switch beside it (24px; the app
		// sizes a button at --input-height, 30px, a line too tall for this bar), and
		// on touch it is a band a finger can hit.
		expect(browser).toMatch(
			/\.nav-preview-go\s*\{[^}]*height: 24px[^}]*background-color: color-mix\(in srgb, var\(--interactive-accent\)[^}]*color: var\(--text-accent\)/,
		);
		expect(browser).toMatch(/\.nav-preview-modes \.nav-preview-mode\s*\{[^}]*height: 22px/);
		expect(browser).toMatch(/is-touch \.nav-preview-bar \.nav-preview-go\s*\{[^}]*height: auto/);
		// Every line of the pinned block keeps its room whether or not the entry
		// has anything for it: the pointer walks the list, and a block that is one
		// line shorter for the entries with no section (or a deleted note, which
		// has no controls at all) makes everything under it jump.
		expect(browser).toMatch(/\.nav-preview-trail\s*\{[^}]*min-height: 1lh/);
		expect(browser).toMatch(/\.nav-preview-meta\s*\{[^}]*flex-wrap: nowrap[^}]*min-height: 1lh/);
		// …a token too long for the column is ellipsized rather than given a line
		expect(browser).toMatch(/\.nav-preview-meta > span\s*\{[^}]*text-overflow: ellipsis/);
		expect(browser).toMatch(/\.nav-preview-bar\s*\{[^}]*min-height: 24px/);
		// …and the reserved-but-empty lines are a DRAWER answer only: inline a tap
		// opens one panel under its row, so there is no shape to hold still and
		// the empty lines are dropped instead
		expect(browser).toMatch(
			/is-inline \.nav-preview-meta:empty,\s*\.position-restore-nav-modal\.is-inline \.nav-preview-trail:empty,[^}]*display: none/,
		);
		// the two view buttons are ONE control: one box, a hairline between the
		// halves, and the selected half on the app's own active tint
		expect(browser).toMatch(/\.nav-preview-modes\s*\{[^}]*border: 1px solid var\(--background-modifier-border\)/);
		expect(browser).toMatch(
			/\.nav-preview-mode \+ \.nav-preview-mode\s*\{[^}]*border-left: 1px solid var\(--background-modifier-border\)/,
		);
		expect(browser).toMatch(/\.nav-preview-mode\.is-active\s*\{[^}]*background-color: var\(--background-modifier-active-hover\)/);
		// the switch may not resize under the click that set it: the active state
		// changes colour and background, never type weight or padding
		const active = browser.slice(
			browser.indexOf('.nav-preview-modes .nav-preview-mode.is-active {'),
			browser.indexOf('.nav-preview-caption {'),
		);
		expect(active.length).toBeGreaterThan(20);
		expect(active).not.toMatch(/font-weight|padding/);
	});

	// The two things a reader can DO about a landing — go there, and say which
	// view to read — share one bar ABOVE the content: at the foot of the panel a
	// long note pushed the travel button off the bottom, so the only control for
	// "I want to go there" was the one thing that had to be scrolled to. On touch
	// the button keeps a finger's height but not a band's width, so that the switch
	// fits on the SAME line: two lines of a phone's height spent on controls is
	// height taken from the content the panel is open for.
	it('puts the travel button above the content, beside the view switch', () => {
		expect(browser).toMatch(/\.nav-preview-bar\s*\{[^}]*display: flex[^}]*flex-wrap: wrap/);
		expect(browser).toMatch(/\.nav-preview-bar \.nav-preview-go\s*\{[^}]*font-size: var\(--font-ui-smaller\)/);
		expect(browser).toMatch(
			/is-touch \.nav-preview-bar \.nav-preview-go\s*\{[^}]*width: auto[^}]*height: auto/,
		);
		// the switch rides at the far end of that one line, away from the button it must
		// not be mistaken for
		expect(browser).toMatch(/\.nav-preview-modes\s*\{[^}]*margin-left: auto/);
		// nothing is left hanging under the content
		expect(browser).not.toContain('.nav-preview-actions');
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
		// and the content switch says which of the two is showing
		expect(browser).toMatch(/\.nav-preview-modes \.nav-preview-mode\.is-active\s*\{[^}]*color: var\(--text-normal\)/);
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
