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
