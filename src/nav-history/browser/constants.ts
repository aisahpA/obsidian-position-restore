// The history browser's tuning numbers.

// Above this many entries the modal pins its height and scrolls the list
// inside it (filtering must not resize and re-center the dialog). Below it
// the modal sizes to its content — a three-entry history in a 640px box was
// mostly dead space.
export const FIXED_HEIGHT_MIN_ENTRIES = 12;
