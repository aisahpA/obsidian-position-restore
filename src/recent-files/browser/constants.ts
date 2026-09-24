// The recent-files browser's tuning numbers.

// The id this panel answers by in Obsidian's own hover-preview system — the same string
// whether the panel is a dialog or a resident sidebar leaf, because either way the reader
// is looking at ONE panel: the rows are the same rows, ordered the same way, and the
// preview a row asks for is asked by the panel rather than by the window it stands in.
// Registering it puts a line named after the panel into the settings of the core plugin
// that answers the request (see main.ts, and body.ts's hoverRow): ONE row for this panel,
// not one per shell. The resident panel's view type is the same string (see view.ts) —
// that is what the app already tells its sources apart by, and the dialog borrows it so
// that answering either shell says one name.
export const NAV_SOURCE_ID = 'position-restore-recent-files';

// Above this many entries the modal pins its height and scrolls the list inside it:
// filtering must not resize and re-center the dialog. Below it the modal sizes to its
// content — a three-entry history in a 640px box was mostly dead space.
export const FIXED_HEIGHT_MIN_ENTRIES = 12;

// How often a panel that is just standing there re-derives the ages on its rows.
//
// Only an IDLE panel needs this at all: any real use of the app — opening a note,
// switching a tab — moves the places, and the redraw the store triggers re-derives
// every label on the way. What the interval is for is the panel nobody is touching,
// and its only visible effect there is how stale the minute figures may be (usually
// a digit going from "5m" to "12m", not a unit changing).
export const TIME_REFRESH_MS = 5 * 60_000;

// How long the pointer has to REST on a row before the panel says what is on it
// (see tip.ts). The list is crossed with the pointer as often as it is read — on the
// way to the row below, or to the gear — and a tooltip that answered every row the
// pointer passed over would be a band of text flashing down the list. Long enough
// that a crossing says nothing, short enough that a reader who stopped to ask is
// answered while they are still looking at the row. The native `title` it replaces
// waited about as long; this is the same promise, said by an element the panel can
// style.
export const TIP_DELAY_MS = 1000;

// How far the tooltip stands off the row it is about, in pixels (see tip.ts).
export const TIP_GAP_PX = 6;

// How long a finger has to REST on a row before the row is armed (see long-press.ts) —
// long enough that a finger put down on its way to a scroll is not one, short enough
// that a reader who meant it is answered while they are still looking at the row.
//
// The two ways of getting it wrong are not equally visible, and the number sits between
// them rather than near either: too short and a list that is being dragged arms the row
// the drag started on, so a reader who meant to move the list finds a × under their
// thumb; too long and the gesture stops answering at all, because a reader who meant it
// has decided nothing is coming and lifted their finger first. 500ms is what the
// platform's own long press waits, which is also what makes the gesture one a reader
// has already tried.
export const LONG_PRESS_MS = 500;

// How far the finger may drift and still be resting on the row it came down on, in
// pixels (see long-press.ts). A finger is not a mouse: it rolls, and the skin around
// the point of contact moves with it, so a press that is perfectly still to its owner
// reports a pixel or two of drift — and a threshold of zero would arm nothing at all.
// Ten is the number the platform's own touch slop uses, and it is far below the
// distance a list has to be dragged before it scrolls.
export const LONG_PRESS_SLOP_PX = 10;

// How long the row a finger PRESSED keeps the mark that says so (see
// RecentFilesList.markPressed), in milliseconds.
//
// Why it is held past the finger at all: a phone has no hover, so nothing on a row
// changes between the finger coming down and the travel going through — and the travel
// is not the end of it either, because on a phone this panel is a drawer that folds
// away behind it (see PANEL_EXIT_GRACE_MS below). A mark that went with the finger
// would be a mark the reader never saw, on a row they were never sure they hit.
//
// Why it is a number and not the finger coming up: a press is also the beginning of a
// scroll, and the lift that ends a press is not the lift that ends a tap — the two are
// the same event, and only the clock tells them apart. 320 is a beat longer than the
// drawer's own grace, so the row is still saying "this one" for exactly as long as it
// is still on screen.
export const ROW_PRESS_MARK_MS = 320;

// The CEILING on that mark while the finger is still down (see
// RecentFilesList.markPressed), in milliseconds: one long press plus one tap's worth of
// mark.
//
// Why it exists: the mark is ended by the finger coming UP, which is an event the
// platform does not always deliver — a drawer may take the gesture, a second finger may
// land, the phone may turn. A row left lit because a lift was never heard is a row the
// reader has to explain away, so the mark has a latest moment of its own.
//
// Why it is this long: it has to outlast a finger that is resting all the way through a
// long press without ending it — a ceiling that ran out before the arm arrived would
// blink the mark out halfway through the very gesture it was drawn for. The ordinary
// press ends far below it, on the lift.
export const ROW_PRESS_HOLD_MAX_MS = LONG_PRESS_MS + ROW_PRESS_MARK_MS;

// How long the RESIDENT panel holds its redraws back after a travel on a PHONE (see
// RecentFilesView.standAside), in milliseconds.
//
// Why it is held at all: on a phone this panel IS a drawer over the whole screen, so a
// travel folds the drawer away — and the travel also re-orders the list (the place just
// sat in becomes the newest). The two happen at once, so a reader who pointed at a row
// watched the list shuffle itself on the way out: the row they aimed at climbed to the
// top of a list that was leaving, and the "you are here" mark rode along with it. A
// panel that is on its way out of the reader's sight owes them a list that is TRUE the
// next time the drawer is pulled open, and nothing in between. On a desktop the panel
// stays put and the re-ordering IS the answer — the mark moves to the note they just
// went to — so nothing is held back there.
//
// Why it is a number: nothing in the app says when the drawer has finished moving, and
// both ways of guessing wrong are harmless. Too short and only the tail of the slide is
// quiet — which is what the panel does today, one redraw earlier. Too long and a reader
// who pulls the drawer straight back is shown the old order for the rest of the
// difference, which is a fraction of a second and is over before the first row is read.
export const PANEL_EXIT_GRACE_MS = 300;
