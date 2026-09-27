// The recent-files browser's tuning numbers.

// The id this panel answers by in Obsidian's hover-preview system — the same
// string for the dialog and the resident leaf, because either way the reader is
// looking at ONE panel. Must stay the panel view's type (see view.ts): that is
// what the app tells its sources apart by.
export const NAV_SOURCE_ID = 'position-restore-recent-files';

// Above this many entries the modal pins its height and scrolls: filtering must
// not resize and re-center the dialog.
export const FIXED_HEIGHT_MIN_ENTRIES = 12;

// How often an IDLE panel re-derives the ages on its rows. Any real use of the
// app moves the places, and that redraw re-derives them on the way.
export const TIME_REFRESH_MS = 5 * 60_000;

// How long the pointer rests before a row says what is on it. The list is
// crossed as often as it is read, and a tooltip answering every row passed over
// would be a band of text flashing down it.
export const TIP_DELAY_MS = 1000;

// How far the tooltip stands off the row it is about, in pixels.
export const TIP_GAP_PX = 6;

// How long a finger rests before its row is armed. Too short and a drag arms
// the row it started on; too long and the gesture stops answering at all. 500ms
// is what the platform's own long press waits.
export const LONG_PRESS_MS = 500;

// How far the finger may drift and still be resting on its row, in pixels. A
// finger rolls, so a still press reports a pixel or two.
export const LONG_PRESS_SLOP_PX = 10;

// How long the row a finger PRESSED keeps the mark saying so. Held past the
// finger because a phone has no hover and the travel folds the drawer away
// behind it — a mark that went with the finger is a mark never seen. A number
// rather than the lift, because a press is also the beginning of a scroll.
export const ROW_PRESS_MARK_MS = 320;

// The CEILING on that mark while the finger is still down. The lift that ends a
// press is not always delivered (a drawer may take the gesture, a second finger
// may land), and a row left lit has to have a latest moment of its own — but
// one that outlasts a finger resting all the way through a long press.
export const ROW_PRESS_HOLD_MAX_MS = LONG_PRESS_MS + ROW_PRESS_MARK_MS;

// How long the RESIDENT panel holds its redraws after a travel on a PHONE. On a
// phone the panel is a drawer that folds away while the travel re-orders the
// list, so without this the reader watches the row they aimed at climb to the
// top of a list that is leaving. A desktop panel stays put and that re-ordering
// IS the answer, so nothing is held back there.
export const PANEL_EXIT_GRACE_MS = 300;

// How long the panel waits before redrawing for a section chain that arrived
// LATE: a list the cache knows nothing about asks for every note at once and
// they land in one burst, so one redraw at the end of it replaces one apiece.
export const LATE_READ_REDRAW_MS = 60;
