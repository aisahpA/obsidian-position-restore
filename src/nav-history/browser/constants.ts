// The history browser's tuning numbers.

// Above this many entries the modal pins its height and scrolls the list
// inside it (filtering must not resize and re-center the dialog). Below it
// the modal sizes to its content — a three-entry history in a 640px box was
// mostly dead space. The pin is not a preference on touch: with the panel open
// inside the list, a content-sized dialog hands the scrolling to the dialog itself
// (see NavHistoryModal.applyPresentation), so there it is pinned whatever the
// history's length.
export const FIXED_HEIGHT_MIN_ENTRIES = 12;

// How much room the INLINE landing panel's own top needs under the row it opened
// under: the small print about the step, the section, and the caption line with the view
// switch at its end — measured at 85px on a phone with the switch sharing that line
// (see styles.css), plus the slack a theme's own line-height can add. The row alone
// being on screen is not enough — the panel's pinned top is what says which spot is
// being described and which of the two contents is on screen, and the panel as a whole
// cannot be fitted, because it is taller than the list it sits in.
// So the list is scrolled just far enough to leave this much below the row, and no
// further: the note's own row has to stay on screen (see LandingPanel.reveal).
export const PANEL_PEEK = 100;

// The window width at which even a TOUCH device has room for the drawer's second
// column beside the list (see NavHistoryModal.inline). Below it the panel opens inside
// the list: a phone held upright has neither the width for two columns nor the height
// to stack a tall panel under a row and still keep that row on screen. At or above it —
// a phone held sideways, a tablet — the panel stands beside the list exactly as it does
// on a pointing device, where its pinned head keeps the caption and the view switch
// in reach whatever the note's length.
export const DRAWER_MIN_WIDTH = 720;
