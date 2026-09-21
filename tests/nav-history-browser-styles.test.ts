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
// 2. A note's row is its NAME, the type BADGE where the file is not markdown, and
//    the folder the row sits in — on one line until it does not fit, and on two
//    when it does not. Which half drops to the second line is the reader's setting
//    and is decided by ONE `order` declaration (see PathDisplayMode). The name is
//    capped (max-width: 20em), NOT measured across rows, and the pane cell is only
//    there while a row has one (two live tabs hold that note). The AGE is the row's
//    own far track rather than a fourth thing in the name, so the labels end on one
//    x down the list. A row is set in the app's own nav-list tier.
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
		// The note is a GRID and not a flex line: the age is not a fourth thing in the
		// name, it is the row's own second track (see is-timed).
		expect(browser).toMatch(/\.position-restore-nav-row\.is-file\s*\{[^}]*display: grid/);
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto/);
		// the landing steps in under the note it belongs to
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*margin-inline-start: 1\.5em/);
		// THE COORDINATE RESERVES NOTHING. Its box is the section's competition for the
		// row's width — the section's track is the only flexible one (see .is-place) —
		// so a fixed room for the widest label ("L9999" and the "L412–438" a folded
		// cluster used to print before that) is blank space spent on every row, and the
		// rows whose labels are short pay the most for it: the number ends, and up to
		// three characters of nothing stand between it and the section. What the column
		// holds is the number and nothing else (see .nav-row-pos), and what the section
		// stands off it by is the row's OWN column gap — no second start margin on the
		// section, which is the other half of the same blank.
		const pos = browser.match(/\.position-restore-nav-row \.nav-row-pos\s*\{[^}]*\}/)?.[0] ?? '';
		expect(pos).not.toBe('');
		expect(pos).not.toMatch(/min-width/);
		const trail = browser.match(/\.position-restore-nav-row \.nav-row-trail\s*\{[^}]*\}/)?.[0] ?? '';
		expect(trail).not.toBe('');
		expect(trail).not.toMatch(/margin-inline-start/);
		// and the name is capped rather than greedy
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 20em/);
	});

	// THE LIST'S TYPE is the app's own nav-list tier and not the 15px `body` hands
	// down to every panel: this list stands beside the file explorer, and it read a
	// size larger than every other sidebar. `--nav-item-size` is exactly the variable
	// the app sets its own lists in (13px on a desktop, the text size on a phone, see
	// its .tree-item-self), so a row matches its neighbour without this file picking a
	// number — and the strip and the setting menu keep the smaller tiers they name.
	it('sets a row in the app\'s own nav-list tier', () => {
		const row = browser.match(/\.position-restore-nav-row\s*\{[^}]*\}/)?.[0] ?? '';
		expect(row).not.toBe('');
		expect(row).toMatch(/font-size: var\(--nav-item-size/);
	});

	// THE TRAVEL ARROW is the row's first thing on screen, but NOT a grid track: it
	// A ROW IS ONE TARGET: the gutter that held the details control is gone with the
	// panel it opened (see NavHistoryList), so the row's padding is plain and nothing is
	// absolutely positioned inside it that could touch the row's height.
	it('gives a row one plain padding and nothing pinned inside it', () => {
		expect(browser).toMatch(/\.position-restore-nav-row\s*\{[^}]*padding: 4px 8px;/);
		expect(browser).not.toContain('nav-row-disclose');
		expect(browser).not.toContain('--nav-disclose-');
	});

	// The hint is ONE plain sentence per device — there is no control for it to draw, and
	// no `{arrow}` placeholder left in either locale.
	it('says its sentence without drawing anything into it', () => {
		expect(browser).toMatch(/\.position-restore-nav-hint\s*\{/);
		expect(browser).not.toContain('nav-hint-icon');
	});

	// A folder is printed only where the setting asks for it — the name two notes on
	// screen share, or every row — and WHICH HALF of the row gives way when it does not
	// fit is the same setting's other half: a flex line wraps at the end it is laid out
	// in, so the item ordered LAST is the one that drops to the second line. The DOM
	// order never changes (name, badge, folder), so this one class is the whole of the
	// difference between the two "always" modes (see PathDisplayMode).
	it('prints the folder on the side the setting asks for, and wraps the other half', () => {
		// The cell wraps, and separates what shares a line with a COLUMN gap: a margin
		// would indent the line that wrapped, and the two lines would read as unrelated.
		expect(browser).toMatch(/\.nav-row-file\s*\{[^}]*flex-wrap: wrap/);
		expect(browser).toMatch(/\.nav-row-file\s*\{[^}]*column-gap: 0\.5em/);
		// The folder is the faint tier, and it is what ellipsizes when even a line of
		// its own is not enough.
		expect(browser).toMatch(/\.nav-row-path\s*\{[^}]*flex: 0 1 auto[^}]*text-overflow: ellipsis/);
		expect(browser).toMatch(/\.nav-row-path\s*\{[^}]*color: var\(--nav-faint\)/);
		// …and the name still gives way last: it is capped, not greedy.
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*flex: 0 1 auto/);
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 20em/);
		// The whole of the side decision.
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-file\.is-path-before \.nav-row-path\s*\{\s*order: -1/,
		);
		// The old class is GONE, not kept as a second name for the same rule: a row
		// carrying both would answer to two layouts.
		expect(browser).not.toContain('nav-row-folder');
	});

	// The type badge (see badgeOf): TEXT in a box, never an icon. An icon name the
	// app's build does not have draws an empty slot where the badge should be — worse
	// than no badge, and invisible in any test that does not render a real theme.
	it('marks a note\'s type with text in a box, not with an icon', () => {
		const badge = browser.match(/\.nav-row-badge\s*\{[^}]*\}/)?.[0] ?? '';
		expect(badge).not.toBe('');
		expect(badge).toMatch(/border: 1px solid/);
		expect(badge).toMatch(/font-size: var\(--font-ui-smaller\)/);
		expect(badge).toMatch(/color: var\(--nav-faint\)/);
		// it cannot swallow the row however long the extension is
		expect(badge).toMatch(/max-width: 10ch/);
		expect(badge).toMatch(/text-overflow: ellipsis/);
	});


	// The row's AGE (see model.ts's ageLabel): the faint tier, in the row's own second
	// track at the far end. That TRACK is what makes a column of it — every row that
	// prints a label ends it on the same x, whatever the name and the folder beside it
	// did, and no row can squeeze or wrap the label away (the name ellipsizes first).
	// The row states the track only while it has a label (see is-timed), so a list with
	// the age switched off spends no second column: the automatic margin the label used
	// to be pushed with was a per-row trick that only worked where no folder printed.
	it('dates a row in the far track, which the row states only when it has one', () => {
		const time = browser.match(/\.nav-row-time\s*\{[^}]*\}/)?.[0] ?? '';
		expect(time).not.toBe('');
		expect(time).toMatch(/color: var\(--nav-faint\)/);
		expect(time).toMatch(/font-size: var\(--font-ui-smaller\)/);
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-file\.is-timed\s*\{\s*grid-template-columns: minmax\(0, 1fr\) auto/,
		);
		// …and ONE track until then: a second track nothing occupies would still take
		// its column gap out of the name.
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-file\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
		);
		expect(browser).not.toMatch(/\.nav-row-time\s*\{[^}]*margin-inline-start: auto/);
	});

	// "You are here" is a dot on the note and on the landing the current entry
	// recorded: the current position is marked INSIDE the list rather than held
	// out of it.
	it('marks the current landing with a dot in front of its coordinate', () => {
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*color: var\(--interactive-accent\)/);
		// …HUNG off the coordinate's own START edge, so it leads the number it marks
		// without standing in the coordinate's box: a dot laid out in there would be a
		// dot's worth of width taken from the SECTION on every landing row, to hold a
		// mark only one of them ever shows (see .nav-row-pos).
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*position: absolute/);
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*inset-inline-end: 100%/);
		// …and its distance from the number is a margin on its END edge, against the
		// box: what is fixed is the GAP, not the glyph's width, so a font is free to
		// draw ● as wide as it likes without ever touching the number.
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*margin-inline-end: 0\.3em/);
		// …and the landing row must not clip what hangs off it (see .is-place).
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*overflow: visible/);
	});

	// THE POSITION is the row the keyboard is on (see NavHistoryList.choose), and the
	// wash has to survive the pointer reaching that very row.
	it('paints the position, and keeps it under the pointer', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected\s*\{[^}]*background-color: color-mix\(in srgb, var\(--interactive-accent\)/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected:hover\s*\{[^}]*background-color: color-mix/,
		);
		expect(browser).not.toContain('is-previewed');
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

	// The list is the only column there is: it takes the whole width, and the dialog is
	// sized for one (see the modal's own rule).
	it('gives the list the whole width, and the dialog the width of a list', () => {
		expect(browser).toMatch(/\.position-restore-nav-list\s*\{[^}]*flex: 1 1 auto/);
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal\s*\{[^}]*width: min\(23em/);
		expect(browser).not.toContain('is-no-details');
		expect(browser).not.toContain('position-restore-nav-body');
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
		// The BOX's line is stated on the WRAPPER — the box and its × travel together
		// (see .position-restore-nav-search): a cell on the input alone would leave the
		// clear button out of the grid entirely.
		expect(browser).toMatch(/is-touch \.position-restore-nav-search\s*\{\s*grid-area: box/);
		expect(browser).toMatch(/is-touch \.position-restore-nav-hint\s*\{[^}]*grid-area: hint/);
		expect(browser).toMatch(/is-touch \.position-restore-nav-settings\s*\{[^}]*grid-area: gear/);
		// …and the hint is back to ONE line: sharing the row means it has less of it,
		// and a hint that wrapped would make the second row two lines tall — exactly
		// the height the layout was rearranged to save
		const hint = browser.slice(
			browser.indexOf('.position-restore-nav-hint {'),
			browser.indexOf('.position-restore-nav-settings {'),
		);
		expect(hint).toMatch(/white-space: nowrap/);
		expect(hint).toMatch(/text-overflow: ellipsis/);
		// A media query that only overrode `flex-wrap` would leave the upright phone's
		// GRID in place, so the landscape layout has to say `display: flex` as well
		expect(browser.slice(browser.indexOf('@media (max-height: 520px)'))).toMatch(
			/is-touch \.position-restore-nav-toolbar\s*\{[^}]*display: flex[^}]*flex-wrap: nowrap/,
		);
	});

	// THE PANEL OWNS ITS TOOLTIPS, and the app must not paint its own over them. Every
	// `aria-label` is a tooltip to the app (its tooltip listener matches on the
	// attribute), and the listbox's name — "Recent files", which a screen reader needs —
	// was being painted under the pointer every time a row was hovered. `--no-tooltip`
	// is the app's own switch and it INHERITS, so one declaration on the shared shell
	// covers the list and the setting groups together.
	it('keeps the app\'s own tooltips off the panel\'s accessible names', () => {
		const panel = browser.match(/\.position-restore-nav-panel\s*\{[^}]*\}/)?.[0] ?? '';
		expect(panel).toMatch(/--no-tooltip: true/);
	});

	// A ROW'S TOOLTIP is the panel's own (see tip.ts), and it exists because a native
	// `title` cannot be styled: the path was set in the browser's tooltip type, and the
	// `/` between two segments — the character the whole tooltip is read by — was the
	// least visible thing in the string. Both are decided here: the path in a LARGER
	// type than the app's tooltip uses, and the separators as their own spans with a
	// weight no font can thin away.
	it('draws the row\'s tooltip in a readable type, with separators of its own', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-tip\s*\{[^}]*position: fixed[^}]*pointer-events: none/,
		);
		const path = browser.match(/\.nav-tip-path\s*\{[^}]*\}/)?.[0] ?? '';
		expect(path).toMatch(/font-family: var\(--font-monospace\)/);
		// NOT the app's tooltip tier (--font-ui-smaller): the reader is making out a
		// folder name, and that is the one job this element has.
		expect(path).toMatch(/font-size: var\(--font-ui-medium\)/);
		const sep = browser.match(/\.nav-tip-sep\s*\{[^}]*\}/)?.[0] ?? '';
		expect(sep).toMatch(/font-weight: 700/);
		expect(sep).toMatch(/padding: 0 0\.12em/);
		// The folder steps back so the separator has something to stand against…
		expect(browser).toMatch(
			/\.nav-tip-seg\s*\{[^}]*color: color-mix\(in srgb, var\(--text-normal\)/,
		);
		// …and the second line (the file's other names) is a notch smaller than the path.
		expect(browser).toMatch(/\.nav-tip-text\s*\{[^}]*font-size: var\(--font-ui-small\)/);
	});

	// The × at the end of the box, and the one rule that makes it a control rather than
	// a mark: it is there exactly while there is something to clear, asked of the BOX's
	// own state (`:placeholder-shown` is what an empty, unfocused or focused, filter
	// looks like) instead of a class a listener has to keep in step.
	it('shows the clear button only while the box has something in it', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-search input:placeholder-shown ~ \.position-restore-nav-clear\s*\{\s*display: none/,
		);
		// …and the room it takes on the line is reserved only while it is there, so a
		// reader typing into an empty box is not typing into a narrower one.
		expect(browser).toMatch(
			/input\.position-restore-nav-filter\[type='text'\]:not\(:placeholder-shown\)\s*\{[^}]*padding-inline-end: 1\.6em/,
		);
	});

	// A pinned-height dialog must be FILLED by the list inside it. It carried
	// `max-height: 60vh` from when a "you are here" card stood above it and made the
	// difference up; with the card gone the list stopped two thirds of the way down a
	// dialog that had already claimed its height, and the rest was dead space the
	// scrollbar was not even in. The height is pinned so that filtering cannot resize and
	// re-center the dialog (see is-fixed), so the fix is to fill it.
	it('fills the pinned height with the list instead of stopping short of it', () => {
		expect(browser).toMatch(
			/is-fixed \.position-restore-nav-list\s*\{[^}]*flex: 1 1 auto[^}]*max-height: none/,
		);
		// the short-history case keeps its cap: there the dialog sizes to its content and
		// a 60vh list would be the tallest thing in it
		expect(browser).toMatch(/\.position-restore-nav-list\s*\{[^}]*max-height: 60vh/);
	});

	// The drawer's head reads as a headline over small print: the note's NAME is
	// the biggest thing in the panel (the row that led here names it too, and this
	// is the place with room to set it properly), the folder in front of it is
	// faint and gives way first (the collapse order the rows use), and the facts
	// about the step — pane, type, where a link came from, the coordinate, the
	// warning — are one quiet line under it. The panel's one action is a real
	// button, but deliberately not a filled accent one: the drawer is the second
	// column of a list the reader is scanning.

	// The panel carries no action and no switch of its own: the row's own click opens
	// the file, and the gutter control is what points the panel (see
	// NavHistoryList.onClick / disclose). The content switch that used to sit on the
	// caption line is gone with the two contents it chose between, so the stylesheet
	// must not have kept a home for it.
	it('offers no control of its own — no switch, no travel button', () => {
		expect(browser).not.toContain('.nav-preview');
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
		// …and the details panel needs no rule of its own here: it does not exist
		expect(landscape).not.toMatch(/nav-preview/);
	});
});
