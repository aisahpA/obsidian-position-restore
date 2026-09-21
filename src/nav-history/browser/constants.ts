// The history browser's tuning numbers.

// Above this many entries the modal pins its height and scrolls the list inside it:
// filtering must not resize and re-center the dialog. Below it the modal sizes to its
// content — a three-entry history in a 640px box was mostly dead space.
export const FIXED_HEIGHT_MIN_ENTRIES = 12;

// How far apart two spots of ONE note may be and still be ONE row of the 'all'
// setting, measured in lines. A phone shows fifteen-odd lines at once: two landings
// that close together are a place the reader was in, not two places they can tell
// apart, and printing both is the "many rows with nearly the same number" the list
// was reported for (see groupByFile).
//
// Measured from a cluster's HEAD rather than from the previous line, so a dense run
// of steps cannot chain one cluster across a whole section: a cluster is never wider
// than this window. A different note, or the same note further down, is a different
// row — which is what makes the number a tuning knob rather than a rule.
export const LANDING_MERGE_LINES = 20;

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
export const TIP_DELAY_MS = 400;

// How far the tooltip stands off the row it is about, in pixels (see tip.ts).
export const TIP_GAP_PX = 6;
