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
