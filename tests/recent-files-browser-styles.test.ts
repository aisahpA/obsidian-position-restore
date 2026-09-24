// Guards for the recent-files browser's little print — read out of styles.css, not
// the DOM, because jsdom never loads a stylesheet and every one of these is a
// contract no rendering test here could catch.
//
// Five of them:
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
//    capped (max-width: 20em), NOT measured across rows. The AGE is the row's
//    own far track rather than a fourth thing in the name, so the labels end on one
//    x down the list. A row is set in the app's own nav-list tier.
//
// 3. On touch the rows keep every cell they have — the coordinate and the section on
//    a landing, the name and the age on a note — rather than the old rule that hid
//    the coordinate and the age below 480px and left the list saying nothing but
//    file names.
//
// 4. The row's controls — the × that takes it off the list, and on a phone the tab
//    that opens it one over — FLOAT over the row's far end, in ONE box out of the
//    row's own flow, so summoning them moves nothing; and what gives way when they
//    trade places with the age is the age's colour, not the track it stands in. On
//    touch there is no hover to summon them with: a LONG PRESS arms the row instead,
//    and the row carries the arm as a class of its own, because a press has to outlive
//    the finger that made it. A HOVER is one row at a time and moves nothing, so what
//    the age gives up is its colour; an ARMED row on a phone gives up the ROOM as
//    well, because two icons standing over a name are two things read at once — and
//    nothing is reserved while the row is not armed, so the age keeps the row's far
//    end to itself, as the setting asks.
//
// 5. A landing row's section chain collapses FROM THE OUTSIDE IN, and ONLY from there:
//    the outer level carries every pixel of a deficit, while the deepest level is not a
//    shrinkable item at all — it takes the width its own text needs, up to the whole
//    row — so the level a landing is PLACED by keeps its text however narrow the pane
//    gets. The "›" between two levels rides with the level it follows, so a level
//    squeezed out of the row takes its arrow with it instead of leaving one standing at
//    the head of the row. What the collapse leaves of the outer level is a fragment
//    that names no section, and the pass that reads the layout back takes it off a row
//    squeezed past half of it (`is-deep-only`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// vitest runs from the project root; `import.meta.url` is not a file: URL here.
const css = readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');

// Only the browser's own rules: the restore cue above the marker and the
// db-path modal are different surfaces with their own colour decisions.
const browser = css.slice(css.indexOf('/* Recent-files browser (RecentFilesModal)'));

describe('recent-files browser quiet tiers', () => {
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
		// that state is a column spent twice (see RecentFilesList.fileRow).
		expect(browser).not.toContain('nav-file-caret');
		expect(browser).not.toContain('nav-row-count');
		// The note is a GRID and not a flex line: the age is not a fourth thing in the
		// name, it is the row's own second track (see is-timed).
		expect(browser).toMatch(/\.position-restore-nav-row\.is-file\s*\{[^}]*display: grid/);
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\);/);
		// the landing steps in under the note it belongs to
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*margin-inline-start: 1\.5em/);
		// THE COORDINATE KEEPS A FLOOR, NOT A GUTTER. Every label is set in the same
		// mono font, but "L1" is not as wide as "L9999" — and a box sized to its own
		// text would start each row's section at a different x. So the column floors at
		// the widest ORDINARY label, five characters: "L1" is padded out to the same
		// five, which is blank space the sections line up on, and a five-digit line
		// ("L10000") grows the box to its own label rather than losing a digit. That
		// floor is the whole of the reservation — no fixed gutter, no track — and what
		// the section stands off it by is the row's OWN column gap, with no second start
		// margin on the section itself (see .nav-row-pos, .nav-row-trail).
		const pos = browser.match(/\.position-restore-nav-row \.nav-row-pos\s*\{[^}]*\}/)?.[0] ?? '';
		expect(pos).not.toBe('');
		expect(pos).toMatch(/min-width: 5ch/);
		const trail = browser.match(/\.position-restore-nav-row \.nav-row-trail\s*\{[^}]*\}/)?.[0] ?? '';
		expect(trail).not.toBe('');
		expect(trail).not.toMatch(/margin-inline-start/);
		// and the name is capped rather than greedy
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 20em/);
	});

	// A LANDING'S SECTION CHAIN GIVES WAY FROM THE OUTSIDE IN, AND ONLY FROM THERE (the
	// whole reason a row prints the deepest two levels and not the chapter above them):
	// the deepest level is not a shrinkable item at all, so the outer level carries
	// every pixel of a deficit and the level a landing is PLACED by keeps its text while
	// the row has any room at all. MEASURED in a real layout — no jsdom here — on a row
	// whose two levels are 141px and 63px: at a 260px panel the outer level reads 118px
	// of its 141 and the deepest reads its whole 63, where the shrink WEIGHTS this rule
	// used to carry (100 against 1) left the deepest level 0.2px short — and 0.2px is
	// not nothing when `text-overflow: ellipsis` charges a whole glyph for any overflow
	// at all: that row printed "新插件 Positi… 2026-09-…".
	it('collapses a section chain from the outside in', () => {
		const seg = browser.match(/\.position-restore-nav-row \.nav-row-trail \.nav-trail-seg\s*\{[^}]*\}/)?.[0] ?? '';
		const deep = browser.match(/\.position-restore-nav-row \.nav-row-trail \.nav-trail-deep\s*\{[^}]*\}/)?.[0] ?? '';
		expect(seg).not.toBe('');
		expect(deep).not.toBe('');
		// the outer level is the only thing that shrinks, and it can be squeezed to
		// nothing at all, which is what lets the deepest stand alone on a row too narrow
		// for two…
		expect(seg).toMatch(/flex: 0 1 auto/);
		expect(seg).toMatch(/min-width: 0/);
		// …because the deepest level is not shrunk but CLAMPED: no shrink factor at all,
		// and the trail itself as the ceiling its own ellipsis answers to.
		expect(deep).toMatch(/flex: 0 0 auto/);
		expect(deep).toMatch(/max-width: 100%/);
		for (const rule of [seg, deep]) {
			expect(rule).toMatch(/overflow: hidden/);
			expect(rule).toMatch(/text-overflow: ellipsis/);
			expect(rule).toMatch(/white-space: nowrap/);
		}
		// THE SEPARATOR IS NOT A CELL OF ITS OWN: as one it kept its ~15px after the
		// level in front of it had been squeezed out, so the row printed a "›" with
		// nothing to its left. It is written INSIDE that level instead (see
		// RecentFilesList.placeRow), and there is no rule left that sizes it as a cell.
		expect(browser).not.toMatch(/\.nav-trail-sep\s*\{[^}]*flex:/);
	});

	// …and the collapse is not the whole of the answer: what it leaves of the outer
	// level is a FRAGMENT that names no section ("新插件 Positi…" in front of a date),
	// so the pass that reads the layout back takes it off a row squeezed past half of it
	// (see RecentFilesList.fitTrails). The stylesheet's half of that is one rule, and it
	// is `display: none` — a WIDTH would leave the fragment standing in the row it was
	// taken off.
	it('takes off the outer level a row could not print', () => {
		const off = browser.match(
			/\.position-restore-nav-row\.is-deep-only \.nav-trail-seg\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(off).not.toBe('');
		expect(off).toMatch(/display: none/);
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
	// panel it opened (see RecentFilesList), so the row's padding is plain and nothing is
	// absolutely positioned inside it that could touch the row's height.
	it('gives a row one plain padding and nothing pinned inside it', () => {
		expect(browser).toMatch(/\.position-restore-nav-row\s*\{[^}]*padding: 4px 8px;/);
		expect(browser).not.toContain('nav-row-disclose');
		expect(browser).not.toContain('--nav-disclose-');
	});

	// A folder is printed only where the setting asks for it — the name two notes on
	// screen share, or every row — and WHICH HALF of the row gives way when it does not
	// fit is the same setting's other half: a flex line wraps at the end it is laid out
	// in, so the item ordered LAST is the one that drops to the second line. The DOM
	// order never changes (the name's own box, then the folder), so this one class is
	// the whole of the difference between the two "always" modes (see
	// PathDisplayMode).
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

	// The type (see badgeOf) is marked with the APP'S OWN tag — the class the file
	// explorer puts beside a file's name — and not with a box of our own: a type that
	// looked like a type everywhere but here was a type the reader had to learn twice,
	// and a look of ours is a look no theme can reach. Two things the class brings are
	// right for the explorer and wrong for a name, and both are taken back: the tag
	// there is pushed to the FAR END of its line (it stands for the whole row) and it
	// is allowed to shrink (a squeezed tag reads "PD / F").
	it('marks a note\'s type with the app\'s own tag, and only corrects it', () => {
		const tag = browser.match(/\.position-restore-nav-row \.nav-file-tag\s*\{[^}]*\}/)?.[0] ?? '';
		expect(tag).not.toBe('');
		expect(tag).toMatch(/margin-inline-start: 0/);
		expect(tag).toMatch(/flex: 0 0 auto/);
		// …and nothing else is ours to say about how it looks: no colour, no border,
		// no size of our own.
		expect(tag).not.toMatch(/color:/);
		expect(tag).not.toMatch(/border/);
		expect(tag).not.toMatch(/font-size/);
		// The old badge is GONE, not kept beside it: a row carrying both would print
		// the type twice.
		expect(browser).not.toContain('nav-row-badge');
	});

	// …and the mark stays ON THE NAME'S LINE: as a sibling of the name it is the first
	// thing the wrapping cell drops, which prints the type on a line of its own, under
	// the name it belongs to. The name and its mark are one box that never wraps.
	it('keeps the name and its mark on one line, whatever the row has room for', () => {
		const head = browser.match(/\.nav-row-head\s*\{[^}]*\}/)?.[0] ?? '';
		expect(head).not.toBe('');
		expect(head).toMatch(/flex-wrap: nowrap/);
		// …and it is the NAME inside that box which gives way, not the mark: the box
		// shrinks (see .nav-row-name) and the mark keeps its own width.
		expect(head).toMatch(/min-width: 0/);
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
		// …and a LANDING's row ends its own age in the SAME column: it is coordinate |
		// section | age, where the section is the track that takes the slack and gives
		// way. The times of the two kinds of row then read as one column, which is the
		// whole point of printing them.
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-place\.is-timed\s*\{\s*grid-template-columns: auto minmax\(0, 1fr\) auto/,
		);
	});

	// …and the row's controls ride in that SAME far end, out of the row's own flow (see
	// list.ts's fileRow). Being absolutely positioned is the load-bearing part: laid out
	// inside the row they would take their width from the name, and the row would move
	// under the pointer that summoned them — the one thing this list never does (see the
	// hover tint below). The age gives up its COLOUR and not its track when the two trade
	// places, so nothing moves there either.
	it('floats the row\'s controls over that far end, and moves nothing to show them', () => {
		const actions =
			browser.match(/\.position-restore-nav-row \.nav-row-actions\s*\{[^}]*\}/)?.[0] ?? '';
		expect(actions).not.toBe('');
		expect(actions).toMatch(/position: absolute/);
		expect(actions).toMatch(/inset-inline-end: 4px/);
		// Painted with the ROW's own wash rather than a colour of this file's, so the strip
		// under the icons is the row they stand on — the hover tint, the arm's own tint, or
		// the position's accent.
		expect(actions).toMatch(/background: inherit/);
		// ONE BOX HOLDS BOTH, so a row that carries only one of them leaves no gap where
		// the other would have stood.
		const controls = browser.match(
			/\.position-restore-nav-row \.nav-row-forget,\s*\.position-restore-nav-row \.nav-row-menu\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(controls).not.toBe('');
		// …and they say nothing until the row is pointed at.
		expect(controls).toMatch(/opacity: 0/);
		expect(controls).toMatch(/pointer-events: none/);
		// THE STRIP THEY STAND IN IS NOT THERE EITHER while they are not: it lies over
		// the age, and the age is a cell with an answer of its own (the moment behind
		// "5m", see list.ts's fileRow) — a strip that swallowed the pointer while
		// invisible would answer for the ROW instead, and "which file" is not what a
		// reader pointing at a time asked.
		expect(actions).toMatch(/pointer-events: none/);
		// …and it comes back WITH them, on either device, so that a press landing inside
		// it but on neither control is a MISS and not a click on the row: a finger that
		// drifts from one control to the next has clicked neither, and what the browser
		// clicks is their common ancestor (see RecentFilesList.actionStrip).
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover \.nav-row-actions,\s*\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions\s*\{[^}]*pointer-events: auto/,
		);

		// The age keeps its track and gives up only its colour…
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover \.nav-row-time\s*\{[^}]*color: transparent/,
		);
		// …the controls arrive on the very same terms, scoped away from touch exactly as
		// the hover tint is (a finger's tap leaves `:hover` stuck on the row it touched)…
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover \.nav-row-actions > \*\s*\{[^}]*opacity: 1/,
		);
		// …and ON TOUCH THEY ARRIVE FOR A LONG PRESS INSTEAD, which is what a hover is on
		// a device that has none (see long-press.ts): the row carries the arm as a class of
		// its own rather than as a state of the pointer's, because a press has to OUTLIVE
		// the finger that made it — the reader lifts that finger to reach for what the
		// press put on the row.
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions > \*\s*\{[^}]*opacity: 1/,
		);
		// …with a target a finger can hit without aiming, taken as a MINIMUM WIDTH so
		// the icon keeps its size and only the box around it grows — and named once
		// (--nav-action-target) so the room the row gives up cannot disagree with it.
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions > \*\s*\{[^}]*min-width: var\(--nav-action-target\)/,
		);
		// …and WHILE THE ROW IS ARMED THE STRIP IS THE ROW'S WHOLE FAR END: as tall as
		// the row (which clips it), and with the two controls meeting EDGE TO EDGE —
		// the gap between them was a lane a finger fell through onto the row.
		// (The strip is named by two rules — this one, and the one that makes it
		// reachable — so the one being asserted here is the one that sizes it.)
		const armedStrip = (browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions\s*\{[^}]*\}/g,
		) ?? []).find(rule => rule.includes('inset-block')) ?? '';
		expect(armedStrip).not.toBe('');
		expect(armedStrip).toMatch(/inset-block: 0/);
		expect(armedStrip).toMatch(/gap: 0/);
		// …and the gutters either side of the two controls are the STRIP's own padding
		// rather than room beside it, so a finger landing there lands in the strip —
		// which answers nothing — and not on the row, which opens the note.
		expect(armedStrip).toMatch(/padding-inline: 8px 4px/);
		expect(armedStrip).toMatch(/inset-inline-end: 0/);
		// …and an armed row says WHICH ONE it is: nothing else on a phone tints a row.
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed:not\(\.is-pressed\)\s*\{[^}]*background: var\(--background-modifier-hover\)/,
		);
		// …and the ARMED ROW GIVES THE TWO OF THEM THE ROOM, measured from the same
		// number the targets are: a strip painted over the row was a strip painted
		// over the folder and the name, and two icons legible over text are two
		// things read at once.
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed\s*\{[^}]*padding-inline-end: calc\(2 \* var\(--nav-action-target\)/,
		);
		// …and the room is reserved WHETHER OR NOT the finger is still on the row: what
		// gives way to a press is the arm's wash, never the space the controls stand in.
		// A strip is painted with the row's own wash, which is a thin one (see the
		// `background: inherit` above) — over a name that had not stepped aside it is
		// two things read at once, and neither of them read.
		expect(browser).not.toMatch(
			/\.is-armed:not\(\.is-pressed\)\s*\{[^}]*padding-inline-end/,
		);
		// The arm takes the age's PLACE rather than standing beside it, exactly as a hover
		// does — and NOTHING IS RESERVED while the row is not armed, so a phone, where
		// this list is the whole of the reader's history, keeps the times the setting
		// asked for (see recentFilesRowTime).
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-time\s*\{[^}]*color: transparent/,
		);
		expect(browser).not.toMatch(/is-touch [^{]*\.is-file\s*\{[^}]*padding-inline-end/);
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

	// THE POSITION is the row the keyboard is on (see RecentFilesList.choose), and the
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

	// A ROW UNDER THE POINTER takes the app's own hover tint, so the reader can see
	// which line a click would land on before making it (see body.ts). Three things
	// about it are load-bearing:
	//   - it is the app's hover variable and not a colour of this file's own, the same
	//     tint the setting rows and the file explorer use;
	//   - the POSITION's own row is excluded, because its accent wash is the louder
	//     mark and the pointer must not replace it with a weaker one;
	//   - it is scoped away from touch: a finger's tap leaves `:hover` stuck on the row
	//     it touched, and a row tinted for a pointer that is gone says nothing true.
	it('tints the row under the pointer, without touching the position or a finger', () => {
		const hover =
			browser.match(
				/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover:not\(\.is-selected\):not\(\.is-pressed\)\s*\{[^}]*\}/,
			)?.[0] ?? '';
		expect(hover).not.toBe('');
		expect(hover).toMatch(/background-color: var\(--background-modifier-hover\)/);
		// …and the position is still the stronger of the two, so a hovered row can never
		// be mistaken for the row the keyboard is on.
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected\s*\{[^}]*background-color: color-mix\(in srgb, var\(--interactive-accent\) 12%/,
		);
	});

	// A FINGER HAS NO HOVER TO GO BY, and the travel a tap asked for is a moment away
	// and happens somewhere else — a note opening, a drawer folding away — so the press
	// itself is the only thing a row can answer with (see list.ts's markPressed).
	it('marks the row a press landed on, and outranks the two tints it could lose to', () => {
		const pressed =
			browser.match(
				/\.position-restore-nav-panel \.position-restore-nav-row\.is-pressed\s*\{[^}]*\}/,
			)?.[0] ?? '';
		expect(pressed).not.toBe('');
		// The app's own ACTIVE tint where its theme has one, so a press reads as the
		// deeper of the two things a pointer does to a row — and where it has none the
		// mark still lands on the hover tint rather than on nothing at all.
		expect(pressed).toMatch(
			/background-color: var\(--background-modifier-active, var\(--background-modifier-hover\)\)/,
		);
		// …NOT scoped to touch: a desktop answers a mouse with a hover already, but a
		// button held down on a row is a press, and a hover cannot tell that from a
		// pointer that simply happens to be there.
		expect(pressed).not.toMatch(/is-touch/);
		// …and it WINDOWS over both of the tints that would otherwise paint the row at
		// the same moment: the hover's, whose pointer is on the row in either case, and
		// the arm's, whose wash is what the row keeps once the finger has GONE.
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover:not\(\.is-selected\):not\(\.is-pressed\)\s*\{/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed:not\(\.is-pressed\)\s*\{/,
		);
		// …and the POSITION'S own row deepens under a press rather than losing its
		// accent to a neutral tint, exactly as it does under a hover.
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected\.is-pressed\s*\{[^}]*color-mix\(in srgb, var\(--interactive-accent\)/,
		);
	});

	// The strip carries NO setting of its own: the four choices the gear used to hold
	// are rows of the plugin's settings tab now (see RecentFilesBrowserPrefs), so the panel
	// has no control surface left to paint — no button, no menu hanging off the strip,
	// and no ink fought over with a theme on their behalf. The strip is the search
	// box, which is all a navigator needs.
	it('leaves the strip to the box — no gear, no menu, no hint beside it', () => {
		expect(browser).not.toMatch(/position-restore-nav-settings/);
		expect(browser).not.toMatch(/nav-settings-/);
		expect(browser).not.toMatch(/nav-settings-ink/);
		// …nor the sentence that used to stand beside the box ("click a row to open
		// it"): a row in a list answers a click everywhere else in the app, and the
		// line the sentence stood on was the list's.
		expect(browser).not.toContain('position-restore-nav-hint');
		// …and nothing is anchored to the strip any more: the menu it used to hang its
		// panel off was the only absolutely positioned child it had (the × rides the
		// box's own wrapper, see .position-restore-nav-search).
		const toolbar = browser.match(/\.position-restore-nav-toolbar\s*\{[^}]*\}/)?.[0] ?? '';
		expect(toolbar).not.toBe('');
		expect(toolbar).not.toMatch(/position: relative/);
		expect(browser).toMatch(/\.position-restore-nav-search\s*\{[^}]*position: relative/);
	});

	// The list is the only column there is: it takes the whole width, and the dialog is
	// sized for one (see the modal's own rule).
	it('gives the list the whole width, and the dialog the width of a list', () => {
		expect(browser).toMatch(/\.position-restore-nav-list\s*\{[^}]*flex: 1 1 auto/);
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal\s*\{[^}]*width: min\(23em/);
		expect(browser).not.toContain('is-no-details');
		expect(browser).not.toContain('position-restore-nav-body');
	});

	// A phone gets the SAME rows as a desktop — every cell, one line each — instead
	// of the narrow-screen rule that hid the coordinate and the age and left the list
	// saying nothing but file names. What is worth pinning is that nothing is hidden
	// on touch, and that the row is a finger's target.
	it('gives a phone the desktop rows, one line each and never a hidden cell', () => {
		// The ROOM a row gives a finger, and not the first rule the selector matches —
		// a phone's rows carry more than one (see the long press's own rule above).
		const touch = browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\s*\{[^}]*padding: 6px 8px[^}]*\}/,
		)?.[0] ?? '';
		expect(touch).toMatch(/padding: 6px 8px/);
		// …and no landing gets a second line of its own: the coordinate and the
		// section are all a landing has, and they fit the line a phone gives them.
		expect(browser).not.toMatch(/is-touch \.position-restore-nav-row\.is-place/);
		expect(browser).not.toContain('grid-area:');
		expect(browser).not.toContain('nav-row-pane');
		expect(browser).not.toMatch(/@media \(max-width: 480px\)/);
	});

	// On touch the toolbar is ONE row: the hint that used to take the second one is
	// gone, and the GRID that stated the two rows went with it — a single cell named
	// 'box' would have been a grid saying what a flex line already said. What the
	// touch layout still asks of the strip is the ×: a target a finger can hit.
	it('leaves the touch toolbar one line, and the × a target a finger can hit', () => {
		expect(browser).not.toMatch(/is-touch \.position-restore-nav-toolbar\s*\{[^}]*display: grid/);
		expect(browser).not.toContain('grid-area: box');
		const clear = browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-search \.position-restore-nav-clear\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(clear).toMatch(/padding: 5px/);
		expect(clear).toMatch(/--icon-size: var\(--icon-s\)/);
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
	// least visible thing in the string. Both are decided here: the path one tier above
	// the app's own tooltip type (--font-ui-small, where the app's is the smaller one),
	// and the separators as their own spans with a weight no font can thin away.
	it('draws the row\'s tooltip in a readable type, with separators of its own', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-tip\s*\{[^}]*position: fixed[^}]*pointer-events: none/,
		);
		const path = browser.match(/\.nav-tip-path\s*\{[^}]*\}/)?.[0] ?? '';
		expect(path).toMatch(/font-family: var\(--font-monospace\)/);
		// NOT the app's tooltip tier (--font-ui-smaller): the reader is making out a
		// folder name, and that is the one job this element has. ONE tier up, not the
		// two it once was: the tooltip as a whole stepped down when the list's type was
		// settled, so what has to hold is the STEP and not the tier's name.
		expect(path).toMatch(/font-size: var\(--font-ui-small\)/);
		const sep = browser.match(/\.nav-tip-sep\s*\{[^}]*\}/)?.[0] ?? '';
		expect(sep).toMatch(/font-weight: 700/);
		expect(sep).toMatch(/padding: 0 0\.12em/);
		// The folder steps back so the separator has something to stand against…
		expect(browser).toMatch(
			/\.nav-tip-seg\s*\{[^}]*color: color-mix\(in srgb, var\(--text-normal\)/,
		);
		// …and the second line (the file's other names) is a notch smaller than the path,
		// so it stays a second answer rather than competing with the thing the reader
		// hovered for.
		expect(browser).toMatch(/\.nav-tip-text\s*\{[^}]*font-size: var\(--font-ui-smaller\)/);
	});

	// A line quoted out of the note (see TipContent.quotes): set off by a rule rather
	// than by a typeface, and never clipped — a line of the note cut off in the middle
	// says something the note never said, and this is the one thing on a landing's row
	// the reader is reading for its own sake.
	it('draws a quoted line as a quote, and lets it wrap', () => {
		const quote = browser.match(/\.nav-tip-quote\s*\{[^}]*\}/)?.[0] ?? '';
		expect(quote).toMatch(/border-inline-start: 2px solid var\(--background-modifier-border\)/);
		expect(quote).toMatch(/padding-inline-start: 6px/);
		expect(quote).toMatch(/overflow-wrap: anywhere/);
		// No line-clamp, and no max-height: the whole line is the answer.
		expect(quote).not.toMatch(/line-clamp/);
		expect(quote).not.toMatch(/text-overflow/);
	});

	// …and the one line a hover says ABOUT those quotes — the note has been written
	// since they were taken — is set apart by INK and not by a rule: it is this panel
	// speaking about the note's words, and a reader has to be able to tell the two
	// apart at a glance. Fainter than a quote, and in the panel's own faint tier
	// rather than --text-faint, which a theme is free to re-hue.
	it('sets the line about the quotes apart by ink, not by a rule', () => {
		const note = browser.match(/\.nav-tip-note\s*\{[^}]*\}/)?.[0] ?? '';
		expect(note).toMatch(/color: var\(--nav-faint\)/);
		expect(note).not.toMatch(/border-inline-start/);
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
	// RecentFilesList.onClick / disclose). The content switch that used to sit on the
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
		// the box keeps the one line the toolbar has, and takes all of it
		expect(landscape).toMatch(/input\.position-restore-nav-filter\s*\{[^}]*flex: 1 1 5em/);
		// …and nothing of the chrome it used to compact is left: the "you are
		// here" card and the file scope both went (see RecentFilesModal)
		expect(browser).not.toContain('position-restore-nav-here');
		expect(browser).not.toContain('position-restore-nav-scope');
		expect(browser).not.toContain('position-restore-nav-toggle');
		// …and a landing needs no rule of its own here: it is the one line the desktop
		// gives it, with the whole width to hold the coordinate and the section.
		expect(landscape).not.toMatch(/is-touch \.position-restore-nav-row\.is-place/);
		// …and the details panel needs no rule of its own here: it does not exist
		expect(landscape).not.toMatch(/nav-preview/);
	});

	// THE RESIDENT PANE'S OWN HEIGHT (see RecentFilesView): a leaf hands the pane
	// whatever height the reader has dragged the sidebar to, so the pane has to take
	// it. The app's own `.view-content` is a scroller with an inset of its own, and
	// left standing it was a SECOND scroller around the list — two scrollers for the
	// app to read a finger's drag against — plus an inset whose 32px foot is the
	// blank band a phone shows above its on-screen keyboard.
	//
	// The rule is written against the pane's CLASS and not the leaf's `data-type`,
	// which carries RECENT_FILES_VIEW_TYPE: that constant was renamed with the panel,
	// and the rule went on being written against a string no leaf carries any more —
	// which no build step and no test could notice, and which is why this test is
	// here. A class cannot drift: the pane adds it itself, in the same call.
	it('bounds the resident pane by the pane itself, not by a view-type string', () => {
		const pane = browser.match(/\.workspace-leaf-content [^{]*position-restore-nav-view\s*\{[^}]*\}/)?.[0] ?? '';
		expect(pane).not.toBe('');
		expect(pane).toMatch(/display: flex/);
		expect(pane).toMatch(/flex-direction: column/);
		// one scroller, and it is the list
		expect(pane).toMatch(/overflow: hidden/);
		// …and no inset of the app's inside a pane that insets its own toolbar and list
		expect(pane).toMatch(/padding: 0/);
		// NOTHING in the panel is written against a `data-type` any more: the one that
		// was — the view type the pane carried before it was renamed — is the reason
		// this test exists.
		expect(browser).not.toMatch(/\[data-type=/);
		expect(browser).not.toContain('position-restore-nav-history');
	});

	// A PHONE SCROLLS THE LIST WITH A FINGER, inside a pane that a finger also drags
	// sideways to fold away (see RecentFilesView.dismissOnMobile), and the app decides
	// which of the two a drag is by walking up from the element the finger landed on
	// and looking for something it can scroll. So the list says what it is rather
	// than leaving itself to be measured: a vertical drag is its own, a horizontal
	// one is not a scroll at all, and a drag that reaches either end stops there
	// instead of being handed on to whatever scrolls around the pane.
	it('answers a phone\'s drag as a scroll of the list', () => {
		// The base rule, not the one the resident pane restates it with: anchored at
		// the line's start so a longer selector ending in this class cannot match.
		const list = browser.match(/(?:^|\n)\.position-restore-nav-list \{[^}]*\}/)?.[0] ?? '';
		expect(list).toMatch(/overflow-y: auto/);
		expect(list).toMatch(/touch-action: pan-y pinch-zoom/);
		expect(list).toMatch(/overscroll-behavior: contain/);
	});
});
