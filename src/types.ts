
interface CursorPos {
	ch: number;
	line: number;
}

// The hot position record, produced by readEphemeralState on every poll tick,
// scroll-capture burst and reland frame: position only — no doc-string reads, no
// layout. Nav-display fields live on NavEntryState.
interface EphemeralState {
	// Dual meaning: markdown saves the quantized top visible line; base views save
	// the scroller's raw scrollTop pixels. A path is always exactly one kind, so the
	// slot is never ambiguous within a record.
	scroll?: number,
	cursor?: {
		from: CursorPos,
		to: CursorPos
	},
}

// One recorded line of a landing's context block: 0-based line number, as every
// other line number in a record, and the line's trimmed text.
interface NavContextLine {
	line: number,
	text: string,
}

// What a nav entry carries beyond the position, produced ONLY by the low-frequency
// nav reads when an entry is saved — never by the hot read. EphemeralState is
// structurally assignable, so baseline-fed states and legacy entries type-check
// against consumers typed NavEntryState.
//
// Only what a later reader can no longer derive belongs here: the text that sat at
// the landing, how big the file was, what the link said. Anything the vault or the
// metadata cache can still answer at browse time (heading chain, aliases, tags) is
// looked up there instead, so it is always current and costs no storage.
interface NavEntryState extends EphemeralState {
	// The landing's CONTEXT BLOCK: the lines the landing sat among at capture time,
	// in document order, with the landing itself at `contextAt`. It is what the
	// browser's SEARCH BOX matches — "the words I saw when I left" is how a reader
	// finds an old spot. SEARCH ONLY: re-anchoring stays `anchor`'s job, one line
	// with exact-match semantics — a multi-line block must never feed it.
	context?: NavContextLine[],
	// Index of the landing line within `context`.
	contextAt?: number,
	// The file's mtime at capture time. Deliberately NOT used to skip the text remap:
	// that runs against a live editor buffer, which can differ from the file on disk
	// — an unsaved edit changes the lines without touching the mtime.
	mtime?: number,
	// Trimmed text of the primary (viewport top) line at capture time. The one
	// FUNCTIONAL field: lets a stale line number be re-mapped to the line that now
	// carries this text before the position is applied — a single line with
	// exact-match semantics, which is why it stays separate from the block.
	anchor?: string,
}

// Device-local per-tab position records.
interface TabStateRecord {
	filePath: string;
	st: EphemeralState;
}

// How much of one note the list keeps, and how much of what it kept it DRAWS: one
// answer, three stops along it, because the two questions are not independent — a
// landing never recorded cannot be drawn.
//
//   'none' — notes and views only. No landing to draw, none to search by.
//   'last' — record landings, draw one row per note. The landings are an invisible
//            index: the search box finds a note by the lines beside a jump.
//   'all'  — record landings and draw one row each. The default: it is the only
//            stop from which the other two can be chosen with anything to choose
//            between, and moving down from here loses nothing.
//
// The stops are monotonic — each keeps and draws a superset of the one above — and
// every one is REVERSIBLE: coming down to 'none' stops new landings being recorded
// and draws none, but does not delete them, so moving back up finds them.
//
// Named here, beside the setting that holds it, because three places speak it;
// listing.ts re-exports it for the browser's modules.
type LandingsMode = 'none' | 'last' | 'all';

// How much of a row's PATH the list prints. The two "always" states are also a
// choice of what gives way when the row runs out of width: 'before' drops the NAME
// to a second line with the path whole, 'after' drops the PATH.
//
// 'smart' (the default) prints the folder only on rows whose name another row on
// screen shares — where it is the only thing telling two rows apart — and lays them
// out like 'before'.
type PathDisplayMode = 'smart' | 'before' | 'after';

// WHERE THE HOVER PREVIEW OPENS A NOTE'S OWN ROW — the two stops the app's own
// preview can be asked for, and the one loop no listing of ours escapes: hovering
// any row hands the note to the app and to nothing else.
//
//   'head' — the app's own answer, and the one every list it ships gives: the note
//            opens at its top, drawn once and never moved.
//   'line' — the reader's last line in it. The note cannot open there; it is drawn
//            to its head first and only scrolled once that is done, so a long note
//            sits empty and then jumps.
//
// 'head' is the default, for what the second stop costs: the row's CLICK already
// opens the note at that line, so what is being bought for a wait is a look at the
// same arrival one gesture early. A LANDING ROW IS OUTSIDE THIS CHOICE either way:
// it names a place of its own and asks for nothing it has to wait for.
type PreviewFocusMode = 'head' | 'line';

interface PluginSettings {
	dbFileName: string;
	// 0 = disabled, do not record positions for files with fewer lines
	minLinesToRecord: number;
	// do not record positions for files in these folders and their subfolders
	excludedFolders: string[];
	// do not record positions for files whose frontmatter contains ANY of these
	// property names (value ignored). Empty array = disabled.
	frontmatterExcludeProperties: string[];
	defaultPosition: 'default' | 'fileEnd';
	// where to open a plain file link (no #/^ target): saved position, or file start
	linkOpenPosition: 'restore' | 'start';
	// how to restore a saved position in source mode
	sourceRestoreMethod: 'instant' | 'glide';
	// how to restore a saved position in reading view
	readingRestoreMethod: 'instant' | 'glide';
	// what to show after a restore: section breadcrumb and/or a source-mode flash
	restoreIndicator: 'off' | 'breadcrumb' | 'both';
	// Opt-in recording of raw scroller scrollTop for base views. Off by default: the
	// value is device-local, so a synced record from another device would overwrite
	// the local one with a meaningless pixel offset. Other non-markdown FileViews are
	// never recorded.
	recordBaseScroll: boolean;

	// Navigation history (VSCode-style back/forward) tuning.
	// max entries kept in the nav history stack; oldest drop on overflow
	navHistoryCap: number;
	// a FILE tab's activation records as a navigation entry (a view tab's always does)
	navHistoryRecordActivation: boolean;
	// How many lines a cursor move must cross before it counts as an in-file jump: a
	// go-to-line, a far click, a vim page motion. 0 records none. A number and not a
	// switch because the question is how big a move the reader means. Desktop only:
	// on a touch screen every deliberate far jump already arrives as its own keyed
	// entry.
	navHistoryTeleportMinLines: number;

	// Files the list must NOT record — its OWN rule, not shared with
	// excludedFolders: that one answers "whose scroll position is worth remembering"
	// (a diary folder may be excluded from restores and still be exactly what the
	// reader navigates back to), while this one answers "which visits are worth
	// listing".
	recentFilesExcludeFolders: string[];
	// The list's own frontmatter rule, in the same `prop[: value]` form as the
	// position rules: a file whose frontmatter matches is never added. What it does
	// NOT read is the position feature's per-file escape hatch (`position-restore`):
	// that answers whether a POSITION is recorded, and a note opted out of position
	// recording is still a place the reader goes.
	recentFilesExcludeProperties: string[];
	// How much of the reader's navigation the list keeps and draws (see
	// LandingsMode). One setting and not two because a landing never recorded cannot
	// be drawn.
	recentFilesLandings: LandingsMode;
	// ===== The recent-files list: its own storage, and its own rules. =====
	// A different thing from the back/forward stack and from the position records:
	// what it holds is WHERE the reader has been, so a place may be lived in for
	// months where a stack step lives for minutes.
	// How many NOTES it remembers — the oldest drop on overflow, in every mode. The
	// landings are bounded separately and internally: their ceiling is storage
	// hygiene, not a number the reader is asked to invent.
	recentFilesCap: number;
	// whether a row prints the folder its note sits in, and on which side of the name
	recentFilesPathDisplay: PathDisplayMode;
	// Whether a row prints how long ago it was last visited. On by default: the list
	// already IS in that order, so what the label adds is the MAGNITUDE — two rows
	// are both "before" and only one is from this morning. It is the place's own `t`,
	// not the file's mtime.
	recentFilesRowTime: boolean;
	// The frontmatter property a row prints as the note's NAME, empty for none. A
	// vault that names its notes in a property rather than in their file names reads
	// by those names everywhere — the quick switcher, the backlinks, every `[[` —
	// and this list is where the reader comes looking for one. A note without the
	// property, or whose value is not a name, prints its file name.
	recentFilesTitleProperty: string;
	// Where the hover preview opens the note a row stands for (see
	// PreviewFocusMode). What stays out of it is a row naming a landing.
	recentFilesPreviewFocus: PreviewFocusMode;
	// Where the app's OWN file list opens its hover preview. Its own setting,
	// not shared with the one above: the two are different ground — one is a
	// list this plugin draws, the other the app's — and a reader may well want
	// one to open at the top and the other at the line they left.
	fileExplorerPreviewFocus: PreviewFocusMode;
}

export const SAFE_DB_FLUSH_INTERVAL = 5000;

// A view's state is re-read on a tick of its own, slower than the 100ms position poll:
// the read asks a third-party view for getState, whose cost we don't own, and an answer
// arriving late only delays a landing — the leave-read takes the last one.
export const VIEW_STATE_POLL_MS = 1000;

export const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '',
	minLinesToRecord: 20,
	excludedFolders: [],
	frontmatterExcludeProperties: [],
	defaultPosition: 'default',
	linkOpenPosition: 'restore',
	sourceRestoreMethod: 'instant',
	readingRestoreMethod: 'instant',
	restoreIndicator: 'off',
	recordBaseScroll: false,

	navHistoryCap: 50,
	navHistoryRecordActivation: true,
	navHistoryTeleportMinLines: 10,

	recentFilesExcludeFolders: [],
	recentFilesExcludeProperties: [],
	recentFilesLandings: 'all',
	recentFilesCap: 50,
	recentFilesPathDisplay: 'smart',
	recentFilesRowTime: true,
	recentFilesTitleProperty: '',
	recentFilesPreviewFocus: 'head',
	fileExplorerPreviewFocus: 'head',
};

export {
	CursorPos,
	EphemeralState,
	NavContextLine,
	NavEntryState,
	TabStateRecord,
	PluginSettings,
	LandingsMode,
	PathDisplayMode,
	PreviewFocusMode,
};
