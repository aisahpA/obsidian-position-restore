// The history browser's constants: its hover-link source id, the body classes
// and CSS variables it writes for the core page preview, and the tuning numbers
// behind its layout.

// The id this panel registers as a hover-link source (see main.ts). The core
// "Page preview" plugin keys its per-source options — including whether the Mod
// key is required — off this string, so both ends must agree on it.
export const HOVER_LINK_SOURCE_ID = 'position-restore-nav-history';

// Put on document.body while the browser is open. The core page preview mounts
// its popover on the body at var(--layer-popover) (30), i.e. BELOW a modal
// (var(--layer-modal) = 50) — see styles.css, which lifts it back above the
// dialog for exactly as long as this class is present.
export const BODY_OPEN_CLASS = 'position-restore-nav-open';

// Where the native preview should put its left edge, in viewport coordinates:
// just right of the SECTION cell the pointer is on (see placePagePreview). The
// core plugin aligns a popover's left edge with its anchor's — the whole row —
// so left to itself this 450px panel starts at the row's far edge, up to half a
// panel away from the text the user is actually pointing at, and the hover-link
// payload has no field for the side. It recomputes that position on every show,
// so the only durable way to say where the popover goes is a CSS variable that
// styles.css reads with !important (which beats the inline style the plugin
// writes).
export const POPOVER_LEFT_VAR = '--position-restore-popover-left';

// Where it should put its TOP edge, in viewport coordinates: the pointed-at
// ROW's own top. The plugin hangs the popover under its anchor row (or bottom-
// anchors it above), so the panel reads as something that drifted away from the
// row it describes; the row's top edge keeps the two level, and styles.css'
// clamp only steps in when the window has no room for the whole preview.
export const POPOVER_TOP_VAR = '--position-restore-popover-top';

// Put on document.body for as long as the native popover is still building its
// preview (see holdPreview). styles.css keeps the popover invisible for exactly
// that long: the plugin draws the top of the note first and applies the landing
// scroll afterwards, so without the hold the user sees a flash of the file's
// opening lines before the preview jumps to the row's position.
export const POPOVER_PENDING_CLASS = 'is-preview-pending';

// How far right of the section cell the preview starts.
export const POPOVER_GAP = 8;

// How long a preview may be held back waiting for its landing scroll to be
// applied. A file Obsidian never finishes laying out — or an empty one — would
// otherwise keep the popover invisible for good; past this it is shown as it is.
export const REVEAL_DEADLINE_MS = 1200;

// The class the note renderer puts on the line it scrolled to (and flashes). Its
// arrival is the popover's "the landing is applied" signal — the only one the
// plugin offers from outside — and it is written by the same call that positions
// the preview, so the popover is complete by the time it appears.
export const LANDING_MARK_CLASS = '.is-flashing';

// Above this many entries the modal pins its height and scrolls the list
// inside it (filtering must not resize and re-center the dialog). Below it
// the modal sizes to its content — a three-entry history in a 640px box was
// mostly dead space.
export const FIXED_HEIGHT_MIN_ENTRIES = 12;

// The age column is sized from the labels actually on screen (see
// fitTimeColumn), clamped to these two pixel bounds: a floor so a list of
// "just now" rows does not collapse the column, and a ceiling equal to what
// the old fixed 11ch track reserved, so the fit can only ever take width back.
export const TIME_COL_MIN = 40;
export const TIME_COL_MAX = 112;

// The cap the name column is measured against (see fitNameColumn): the same
// 16em the name box itself carries in styles.css, so the column can never be
// wider than a name is allowed to be drawn.
export const NAME_COL_CAP_EM = 16;

// …and the other cap, in share of the panel: however long the longest name is,
// the section column may not be squeezed out of existence by it. One long title
// in a narrow window would otherwise take the whole row (the small print keeps
// its fixed cells, the section collapses to nothing, and the list stops saying
// WHERE in the note each step was — the half of a row's meaning that is not the
// name). At the panel's usual width this never binds: 35% of 760px is 266px,
// above the 16em cap.
export const NAME_COL_WIDTH_SHARE = 0.35;
