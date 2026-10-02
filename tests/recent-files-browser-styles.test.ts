// Guards for the recent-files browser's little print — read out of styles.css, not
// the DOM, because jsdom never loads a stylesheet and every one of these is a
// contract no rendering test here could catch.
//
// Six of them:
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

// Only the browser's own rules: the restore cue above this rule and the
// db-path modal are different surfaces with their own colour decisions.
const browser = css.slice(css.indexOf('.modal.position-restore-nav-modal'));

describe('最近文件面板的两档弱墨', () => {
	it('切出面板自己那一段样式', () => {
		expect(browser).toContain('.position-restore-nav-row');
		expect(browser.length).toBeGreaterThan(2000);
	});

	it('两档都由主题的主文本色派生', () => {
		for (const name of ['--nav-muted', '--nav-faint'])
			expect(browser).toContain(`${name}: color-mix(in srgb, var(--text-normal)`);
	});

	it('哪一档都不许直接用主题可以随意改色相的变量', () => {
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
	it('笔记行就是它的名字，标题行是行号 + 所属标题', () => {
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
	it('标题链由外向内收', () => {
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
	it('挤到印不出来的那层外层，直接摘掉', () => {
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
	it('行的字号取 app 自己 nav-list 的那一档', () => {
		// The row's OWN rule, and not the desktop dialog's override of its padding, which
		// starts with the same class: anchored at the line's start so nothing prefixed
		// can be read as it.
		const row = browser.match(/(?:^|\n)\.position-restore-nav-row \{[^}]*\}/)?.[0] ?? '';
		expect(row).not.toBe('');
		expect(row).toMatch(/font-size: var\(--nav-item-size/);
	});

	// THE TRAVEL ARROW is the row's first thing on screen, but NOT a grid track: it
	// A ROW IS ONE TARGET: the gutter that held the details control is gone with the
	// panel it opened (see RecentFilesList), so the row's padding is plain and nothing is
	// absolutely positioned inside it that could touch the row's height.
	it('行只有一套朴素内边距，里面没有绝对定位的东西', () => {
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
	it('文件夹按设置指定的那一边印，让行的另一半去挤', () => {
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

	// ROOM BOUGHT ONE THING IN THE WIDE DIALOG, and it is not a second line forced on every
	// row: a path too long for the row is WRAPPED rather than cut. Where the path stands is
	// still the reader's setting (asserted above) — the dialog does not override the SIDE it
	// asked for, only whether the path may spend a line saying all of itself.
	it('桌面对话框里长路径换行显示，而不是截断', () => {
		const path = browser.match(
			/\.modal\.position-restore-nav-modal:not\(\.is-touch\) \.position-restore-nav-row \.nav-row-path\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(path).not.toBe('');
		expect(path).toMatch(/white-space: normal/);
		expect(path).toMatch(/overflow-wrap: break-word/);
		expect(path).toMatch(/text-overflow: clip/);
		// PRINTED IN FRONT OF THE NAME and not faintly behind it, the faintest tier was too
		// quiet to read; one step up, still under the name's own.
		expect(path).toMatch(/color: var\(--nav-muted\)/);
		// …and the SIDE IS STILL THE READER'S: this rule may not reorder the two halves, or
		// 'before' and 'after' would answer the same question with one answer.
		expect(path).not.toMatch(/order:/);
		// NO CELL IS A STACK either: giving the path a line of its own in every row is the
		// shape that was tried here and undone — the wrap above happens only when it must.
		expect(browser).not.toMatch(
			/(?:^|\n)\.position-restore-nav-row \.nav-row-file\s*\{[^}]*flex-direction: column/,
		);
	});

	// The type (see badgeOf) is marked with the APP'S OWN tag — the class the file
	// explorer puts beside a file's name — and not with a box of our own: a type that
	// looked like a type everywhere but here was a type the reader had to learn twice,
	// and a look of ours is a look no theme can reach. Two things the class brings are
	// right for the explorer and wrong for a name, and both are taken back: the tag
	// there is pushed to the FAR END of its line (it stands for the whole row) and it
	// is allowed to shrink (a squeezed tag reads "PD / F").
	it('笔记的类型用 app 自己的标签来标，只做修正', () => {
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
	it('名字和它的标记始终同一行，无论这一行还剩多少地方', () => {
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
	it('日期放在远端那一轨，行只有真的有日期时才声明这一轨', () => {
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
	it('行的控件浮在那一端之上，显示它们不挤动任何东西', () => {
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
	it('当前标题用行号前面的一个圆点标出', () => {
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
	it('位置那几个字是有颜色的，指针压上去也不改', () => {
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
	it('指针悬停只给整行上色，不动位置那几个字，也跟手指无关', () => {
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
	it('按下落在哪一行就标记哪一行，并压过那两种它可能让位的着色', () => {
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
	it('工具条只留给搜索框 —— 没有齿轮、没有菜单、旁边也没有提示语', () => {
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
	it('列表占满整个宽度，对话框按一个列表的宽度来', () => {
		expect(browser).toMatch(/\.position-restore-nav-list\s*\{[^}]*flex: 1 1 auto/);
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal\s*\{[^}]*width: min\(23em/);
		expect(browser).not.toContain('is-no-details');
		expect(browser).not.toContain('position-restore-nav-body');
	});

	// THE DESKTOP DIALOG IS SIZED THE WAY THE APP SIZES ITS OWN answer to the same question
	// (the quick switcher): the width its prompt takes, standing where that prompt stands, in
	// the type its suggestions are set in. Every one of those is READ OUT OF THE APP rather
	// than measured here, so a theme that retunes the prompt retunes this dialog with it — and
	// so none of them can be allowed to fall back to a number of this file's own. A PHONE
	// KEEPS ITS OWN SIZE (see the base rules these two override): a 700px dialog is a screen
	// it cannot put away.
	it('桌面对话框的尺寸照 app 自己那个 prompt 的量法来', () => {
		const desktop =
			browser.match(/\.modal\.position-restore-nav-modal:not\(\.is-touch\) \{[^}]*\}/)?.[0] ?? '';
		expect(desktop).not.toBe('');
		// the app's own prompt width, and the closely-related `--nav-modal-top` the same
		// rule names for the two places below to read
		expect(desktop).toMatch(/width: var\(--prompt-width/);
		expect(desktop).toMatch(/max-width: min\(var\(--prompt-max-width/);
		expect(desktop).toMatch(/--nav-modal-top: 80px/);
		// UP, AND NOT CENTRED: the container centres what it holds, so this is the dialog
		// asking for the start of that line instead.
		expect(desktop).toMatch(/align-self: flex-start/);
		expect(desktop).toMatch(/margin-top: var\(--nav-modal-top\)/);
		// A ROW IS SET IN A TIER OF THE APP'S OWN: `--nav-item-size` is the variable it sets
		// its own nav lists in — 13px here, 15px on a phone — so the desktop asks for the
		// phone's number rather than inventing a fourth one (see the row's own rule).
		expect(desktop).toMatch(/--nav-item-size: var\(--font-ui-medium\)/);
		// …and the base rule the phone answers is still its own narrow width, so nothing
		// above can fall back onto a phone.
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal \{[^}]*width: min\(23em/);
	});

	// …and THE HEIGHT IS PINNED WHATEVER THE LIST HOLDS (see modal.ts: on a desktop `is-fixed`
	// no longer waits for a long history). The whole reason the height is pinned is that a
	// dialog sized by its content SHRINKS under every keystroke and drags itself back toward
	// the middle of the window while the reader is still typing, so this is the assertion that
	// keeps anyone from making the pin conditional on the list again. A phone keeps its own.
	it('桌面对话框的高度钉死，筛选也撑不动它', () => {
		const pinned =
			browser.match(
				/\.modal\.position-restore-nav-modal\.is-fixed:not\(\.is-touch\) \{[^}]*\}/,
			)?.[0] ?? '';
		expect(pinned).not.toBe('');
		expect(pinned).toMatch(/height: min\(var\(--prompt-max-height/);
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal\.is-fixed \{[^}]*height: min\(84vh/);
	});

	// THE DESKTOP DIALOG OPENS ON THE BOX and not on its own name standing over it: a heading
	// spends the dialog's first row saying what the reader already asked for, and it is the
	// one thing left between this dialog and the app's answer to the same question (a prompt
	// is a filter box and a list, nothing above them). The name is not unset but DISPLAYED
	// AWAY — the title going empty leaves the header its row, margin-bottom and all — and the
	// list below still carries the string for assistive tech (see body.ts).
	it('筛选框放在桌面对话框的顶部', () => {
		const header = browser.match(
			/\.modal\.position-restore-nav-modal:not\(\.is-touch\) \.modal-header\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(header).not.toBe('');
		expect(header).toMatch(/display: none/);
		// A phone KEEPS ITS NAME: the short-window rules set it aside by their own class.
		expect(browser).not.toMatch(/\.position-restore-nav-modal \.modal-header\s*\{[^}]*display: none/);
	});

	// …and with the name goes THE × THAT STOOD BESIDE IT, rather than the dialog showing two
	// glyphs for one act. The way out is not lost with it: in a shell that can be put away, the
	// box's own × closes it when there is nothing typed to clear (see RecentFilesBrowser.toolbar)
	// — one glyph doing both jobs where the app's own prompt puts it. A phone keeps the app's ×,
	// since it keeps the name that × belongs to.
	it('app 留一个 × 的地方，也只留一个 ×', () => {
		const x = browser.match(
			/\.modal\.position-restore-nav-modal\.is-dismissive:not\(\.is-touch\) \.modal-header-button,\n[^}]*\}/,
		)?.[0] ?? '';
		expect(x).not.toBe('');
		expect(x).toMatch(/display: none/);
		// Nothing else has to make room for it, then: the toolbar's own inset is left alone.
		expect(browser).not.toMatch(/\.position-restore-nav-toolbar\s*\{[^}]*padding-inline-end: var\(--size-4-6/);
	});

	// WHERE THE PINNED ROWS STOP is a line and nothing else: a heading would spend a
	// row's height saying what the line already says, and an icon on each pinned row
	// has nowhere to stand — the row's far end belongs to its own controls.
	it('置顶区末尾有一条线收住，但不给这个区写名字', () => {
		const sep = browser.match(/\.position-restore-nav-pinned-sep\s*\{[^}]*\}/)?.[0] ?? '';
		expect(sep).not.toBe('');
		expect(sep).toMatch(/border-top: 1px solid/);
		// A line, not a row: no height of its own, no text, no icon of ours.
		expect(sep).toMatch(/height: 0/);
		expect(browser).not.toContain('nav-pinned-title');
		expect(browser).not.toContain('nav-row-pin');
	});

	// A phone gets the SAME rows as a desktop — every cell, one line each — instead
	// of the narrow-screen rule that hid the coordinate and the age and left the list
	// saying nothing but file names. What is worth pinning is that nothing is hidden
	// on touch, and that the row is a finger's target.
	it('手机上照用桌面的行：一行一条，绝没有藏起来的格子', () => {
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
	it('触屏工具条保持一行，× 保持手指点得到的尺寸', () => {
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
	it('不许 app 自己的 tooltip 混进面板的无障碍名字', () => {
		const panel = browser.match(/\.position-restore-nav-panel\s*\{[^}]*\}/)?.[0] ?? '';
		expect(panel).toMatch(/--no-tooltip: true/);
	});

	// A ROW'S TOOLTIP is the panel's own (see tip.ts), and it exists because a native
	// `title` cannot be styled: the path was set in the browser's tooltip type, and the
	// `/` between two segments — the character the whole tooltip is read by — was the
	// least visible thing in the string. Both are decided here: the path one tier above
	// the app's own tooltip type (--font-ui-small, where the app's is the smaller one),
	// and the separators as their own spans with a weight no font can thin away.
	it('行的 tooltip 用可读的字号画，分隔符自己提供', () => {
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
	it('被引的那一行按引文的样子画，并允许换行', () => {
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
	it('说明引文的那一行靠墨色区分开，不靠分隔线', () => {
		const note = browser.match(/\.nav-tip-note\s*\{[^}]*\}/)?.[0] ?? '';
		expect(note).toMatch(/color: var\(--nav-faint\)/);
		expect(note).not.toMatch(/border-inline-start/);
	});

	// The × at the end of the box, and the one rule that makes it a control rather than
	// a mark: it is there exactly while there is something to clear, asked of the BOX's
	// own state (`:placeholder-shown` is what an empty, unfocused or focused, filter
	// looks like) instead of a class a listener has to keep in step. A box whose × also
	// DISMISSES the shell it stands in never has nothing for it to do, and so never
	// hid it — see RecentFilesBrowser.toolbar.
	it('只有框里有内容时才显示清除按钮', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-dismissive\) \.position-restore-nav-search input:placeholder-shown ~ \.position-restore-nav-clear\s*\{\s*display: none/,
		);
		// …and the room it takes on the line is reserved only while it is there, so a
		// reader typing into an empty box is not typing into a narrower one — except
		// where the glyph stays for good, and says so with its own selector.
		expect(browser).toMatch(
			/\.position-restore-nav-modal\.is-dismissive:not\(\.is-touch\) input\.position-restore-nav-filter\[type='text'\]\s*\{[^}]*padding-inline-end: 1\.6em/,
		);
	});

	// A pinned-height dialog must be FILLED by the list inside it. It carried
	// `max-height: 60vh` from when a "you are here" card stood above it and made the
	// difference up; with the card gone the list stopped two thirds of the way down a
	// dialog that had already claimed its height, and the rest was dead space the
	// scrollbar was not even in. The height is pinned so that filtering cannot resize and
	// re-center the dialog (see is-fixed), so the fix is to fill it.
	it('钉死的高度由列表填满，而不是差一截填不到底', () => {
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
	it('自己不提供任何控件 —— 没有开关，也没有前进后退按钮', () => {
		expect(browser).not.toContain('.nav-preview');
	});

	// A phone held sideways has ~370px of height for everything (the dialog's name, the
	// filter, the list): every one of these is a line the list gets back.
	it('矮对话框（手机横屏）的布局更紧凑', () => {
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
	it('常驻面板按面板自身来限定范围，而不是按 viewType 字符串', () => {
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

	// 6. A landing whose heading the note has LOST keeps printing the words the
	//    record carries, struck through and down a tier — those words are the last
	//    thing naming the spot, and what is struck is only the claim that the note
	//    still has them (see RecentFilesList.placeRow / landingNote).
	it('笔记已经没有的那个标题加删除线，而不是把它丢掉', () => {
		const lost = browser.match(/\.position-restore-nav-row \.nav-row-trail\.is-lost \{[^}]*\}/)?.[0] ?? '';
		expect(lost).not.toBe('');
		expect(lost).toMatch(/text-decoration: line-through/);
		// …two shades down from the tier a live section sits at, and still mixed out
		// of the theme's own text rather than painted with a theme's variable
		expect(lost).toMatch(/color: var\(--nav-faint\)/);
	});

	// A PHONE SCROLLS THE LIST WITH A FINGER, inside a pane that a finger also drags
	// sideways to fold away (see RecentFilesView.dismissOnMobile), and the app decides
	// which of the two a drag is by walking up from the element the finger landed on
	// and looking for something it can scroll. So the list says what it is rather
	// than leaving itself to be measured: a vertical drag is its own, a horizontal
	// one is not a scroll at all, and a drag that reaches either end stops there
	// instead of being handed on to whatever scrolls around the pane.
	it('手机上拖动按列表滚动来响应', () => {
		// The base rule, not the one the resident pane restates it with: anchored at
		// the line's start so a longer selector ending in this class cannot match.
		const list = browser.match(/(?:^|\n)\.position-restore-nav-list \{[^}]*\}/)?.[0] ?? '';
		expect(list).toMatch(/overflow-y: auto/);
		expect(list).toMatch(/touch-action: pan-y pinch-zoom/);
		expect(list).toMatch(/overscroll-behavior: contain/);
	});

	// THE FOUR ARROWS (see body.ts) — the panel's answer for a device with no keyboard,
	// and the one control in it that acts on the NOTE rather than on the list. What the
	// stylesheet has to hold is the whole of the difficulty: four arrows standing over a
	// list are read as four ways to scroll that list, and no rule here may let them be.
	it('箭头装在两个胶囊里，列表的任何一行都不画在它们里面', () => {
		const strip = browser.match(/\.position-restore-nav-arrows \{[^}]*\}/)?.[0] ?? '';
		expect(strip).not.toBe('');
		expect(strip).toMatch(/display: flex/);
		// The two pairs are two different things, and the gap between the two capsules is
		// the whole of the telling apart: a gap the width of a button leaves them reading
		// as one row of four.
		expect(strip).toMatch(/gap: 22px/);
		const capsule = browser.match(/\.position-restore-nav-arrow-group \{[^}]*\}/)?.[0] ?? '';
		expect(capsule).not.toBe('');
		// A capsule and not a row: a bordered, rounded box on the app's own quiet ground
		// is not a shape anything in the list below is ever drawn in — that one is a
		// full-width line which tints under the pointer.
		expect(capsule).toMatch(/border: 1px solid var\(--background-modifier-border\)/);
		expect(capsule).toMatch(/border-radius/);
		expect(capsule).toMatch(/background: var\(--background-secondary\)/);
		// …and the two buttons inside one meet almost edge to edge: a gap wide enough to
		// separate them is a gap wide enough to read them as two controls, which is what
		// a row of four would be.
		expect(capsule).toMatch(/gap: 2px/);
	});

	// An arrow is a TARGET and a glyph: one number, named once and stepped up on a phone
	// to the app's own touch size, so the box a finger has to land in cannot disagree
	// with the room the strip takes. And one that would do nothing goes quiet rather
	// than answering with nothing — which is also the panel's standing answer about whose
	// ends the last two of them go to.
	it('箭头做成可点的尺寸，点了没用的那个置灰', () => {
		const arrow = browser.match(/\.position-restore-nav-arrow \{[^}]*\}/)?.[0] ?? '';
		expect(arrow).not.toBe('');
		expect(arrow).toMatch(/width: var\(--nav-arrow-target\)/);
		expect(arrow).toMatch(/height: var\(--nav-arrow-target\)/);
		expect(browser).toMatch(/\.position-restore-nav-panel \{[^}]*--nav-arrow-target: 28px/);
		expect(browser).toMatch(
			/is-touch \.position-restore-nav-arrows \{[^}]*--nav-arrow-target: var\(--touch-size-m\)/,
		);
		// INK OF THE PANEL'S OWN, and not the theme's: the app's icon skin reads
		// `--icon-color`, which a theme is free to point at its faintest tier — under which
		// a glyph drawn at full strength on the button is still a glyph nobody can see.
		// Named on the panel, so every icon in it is drawn in the same ink — and at FULL
		// opacity: the app fades a `clickable-icon`'s glyph by `--icon-opacity`, which a
		// theme is free to turn down, and a faded glyph is one the ink cannot rescue.
		expect(browser).toMatch(/\.position-restore-nav-panel \{[^}]*--icon-color: var\(--text-normal\)/);
		expect(browser).toMatch(/\.position-restore-nav-panel \{[^}]*--icon-opacity: 1/);
		// …and one element further down, because a shape carrying its own stroke width as an
		// ATTRIBUTE does not take one from the element above it.
		const glyph = browser.match(
			/\.position-restore-nav-arrow svg,\n\.position-restore-nav-arrow svg \* \{[^}]*\}/,
		)?.[0] ?? '';
		expect(glyph).not.toBe('');
		expect(glyph).toMatch(/color: var\(--text-normal\)/);
		expect(glyph).toMatch(/stroke: currentColor/);
		expect(glyph).toMatch(/stroke-width: 2/);
		const off = browser.match(/\.position-restore-nav-arrow\.is-disabled \{[^}]*\}/)?.[0] ?? '';
		// INK, and not a colour of this file's: a theme re-hues its own variables freely,
		// and a greyed button must not come out louder than a live one.
		expect(off).toMatch(/opacity: 0\.35/);
		expect(off).not.toMatch(/color:/);
	});

	// THEY STAND UNDER THE LIST — ON EVERY DEVICE, and not only on a phone: at the top they
	// stood beside the filter box, where a hand going for the box lands on an arrow instead.
	// So the base rule says it, once, and the DOM says it too (asserted in the DOM suite):
	// no `order` is needed, and Tab reaches them where the eye does.
	it('箭头放在列表下方，每种设备都放，不只是手机', () => {
		const strip = browser.match(/\.position-restore-nav-arrows \{[^}]*\}/)?.[0] ?? '';
		expect(strip).not.toBe('');
		// CENTRED, and not laid against the list's left edge: buttons that line up with
		// the rows above them read as one of those rows.
		expect(strip).toMatch(/justify-content: center/);
		// …and a LINE above them, so a strip standing under fifty rows cannot be read as
		// one of them.
		expect(strip).toMatch(/border-top: 1px solid var\(--background-modifier-border\)/);
		// What puts them last is the DOM, not `order` — the only ordering the keyboard
		// reads too. (`\b` keeps this off "border:".)
		expect(browser).not.toMatch(/\border: 1/);
		// The host is a flex column so the list is what grows and the strip what keeps its
		// height — which is the whole of what standing under a scrolling list needs.
		const host = browser.match(/(?:^|\n)\.position-restore-nav-host \{[^}]*\}/)?.[0] ?? '';
		expect(host).toMatch(/display: flex/);
		expect(host).toMatch(/flex-direction: column/);
	});

	// A PHONE GIVES THEM ROOM UNDER THEM as well: the app's own toolbar stands at the foot
	// of a phone screen, and a strip that touches it reads as part of it.
	it('箭头避开手机自己的工具条', () => {
		const touch = browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-arrows \{[^}]*\}/,
		)?.[0] ?? '';
		expect(touch).not.toBe('');
		expect(touch).toMatch(/padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\)/);
	});

	// …AND A DESKTOP GIVES THEM ROOM OF THEIR OWN, for the same reason one floor up: the
	// app's status bar is a FLOATING one, pinned over the bottom of the window (app.css:
	// `position: fixed; bottom: 0; right: 0`), so the foot of a resident pane is not the
	// foot of anything — it is under the bar. A strip flush with that foot is a strip the
	// bar covers. A DIALOG needs none of it: it is centred, nowhere near the window's foot.
	it('在够得到状态栏的面板里，把箭头抬离 app 自己的状态栏', () => {
		const pane = browser.match(
			/\.position-restore-nav-view \.position-restore-nav-arrows \{[^}]*\}/,
		)?.[0] ?? '';
		expect(pane).not.toBe('');
		expect(pane).toMatch(/padding-bottom: 34px/);
	});

	// …BUT NOT IN THE LEFT RAIL, WHICH THE BAR NEVER REACHES: it is pinned to the window's
	// bottom-RIGHT corner and sized to its own content (app.css: `right: 0`, `width: auto`),
	// so a pane standing on the left has a foot that is the screen's own, and 34px of air
	// under these four is 34px of pane spent on a bar at the far side of the window.
	it('左栏里的面板可以让箭头落到面板底部', () => {
		const left = browser.match(
			/(?:^|\n)\.mod-left-split \.position-restore-nav-arrows \{[^}]*\}/,
		)?.[0] ?? '';
		expect(left).not.toBe('');
		expect(left).toMatch(/padding-bottom: 8px/);
		// …and on TWO classes, not three: a phone's rule carries three and must outrank it
		// on specificity — the app puts a `mod-left-split` in a phone's workspace too, and
		// there the room under the strip is the toolbar's, not nothing's.
		expect(left).not.toMatch(/is-touch/);
	});
});
