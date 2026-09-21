
interface CursorPos {
	ch: number;
	line: number;
}

// The hot position record. Produced by readEphemeralState on every 100ms
// poll tick, every scroll-capture burst, and every restore verification /
// reland frame: position only — no doc-string reads, no layout. Nav-display
// fields live on NavEntryState.
interface EphemeralState {
	// Dual meaning: markdown saves the quantized top visible line; base views
	// save the scroller's raw scrollTop pixels instead. A file path is always
	// exactly one kind, so the slot is never ambiguous within a record.
	scroll?: number,
	cursor?: {
		from: CursorPos,
		to: CursorPos
	},
}

// One recorded line of a landing's context block: 0-based line number, as
// every other line number in a record, and the line's trimmed text.
interface NavContextLine {
	line: number,
	text: string,
}

// What a NavHistory entry carries beyond the position: the nav-display
// fields, produced ONLY by the low-frequency nav reads (readNavEntryState /
// withNavDisplay) at the moment a navigation entry is saved — never by the
// hot read. EphemeralState is structurally assignable, so baseline-fed
// states and legacy persisted entries type-check against consumers typed
// NavEntryState (their display fields are simply absent).
//
// The rule for what belongs here: only what a later reader can no longer
// derive — the text that sat at the landing, how big the file was, what the
// link the user clicked said. Anything the vault or the metadata cache can
// still answer at browse time (the heading chain, a file's line count now,
// aliases, tags) is looked up there instead, so it is always current and
// costs no storage.
interface NavEntryState extends EphemeralState {
	// The landing's CONTEXT BLOCK: the lines the landing sat among at capture
	// time, in document order, with the landing itself at `contextAt`. It is what
	// the browser's SEARCH BOX matches — "the words I saw when I left" is how a
	// reader finds an old spot — and was once what the details panel rendered.
	// SEARCH ONLY: re-anchoring stays `anchor`'s job, one line with exact-match
	// semantics (remapAnchoredState) — a multi-line block is a different algorithm
	// and must never feed it.
	context?: NavContextLine[],
	// Index of the landing line within `context`.
	contextAt?: number,
	// The file's mtime at capture time. Nothing displays it (the panel that said
	// "written since" is gone), and it is deliberately NOT used to skip the text
	// remap: that runs against a live editor buffer, which can differ
	// from the file on disk — an unsaved edit changes the lines without
	// touching the mtime.)
	mtime?: number,
	// Trimmed text of the primary (viewport top) line at capture time. The one
	// FUNCTIONAL field of the block above: lets a stale line number (the file
	// was edited after the position was recorded) be re-mapped to the line that
	// now carries this text before the position is applied
	// (remapAnchoredState) — a single line with exact-match semantics, which is
	// why it stays separate from the context block.
	anchor?: string,
}

// Device-local per-tab position records.
interface TabStateRecord {
	filePath: string;
	st: EphemeralState;
}

// How much of one note the history list prints: 'last' keeps the list to one row
// per note — the note's own row stands for the last spot the reader was at in it
// (see NavHistoryList.activeRep), and a click points the panel at that spot —
// while 'all' prints every distinct spot the note was left at under its name.
//
// Named here, beside the setting that holds it, because three places speak it: the
// settings record, the list's own options and the toolbar's setting (see
// NavBrowserPrefs.landings); listing.ts re-exports it for the browser's modules.
type LandingsMode = 'last' | 'all';

interface PluginSettings {
	dbFileName: string;
	minLinesToRecord: number; // 0 = disabled, do not record positions for files with fewer lines
	excludedFolders: string[]; // do not record positions for files in these folders and their subfolders
	// B rule: do not record positions for files whose frontmatter contains ANY
	// of these property names (value ignored — the properties usually already
	// exist for another plugin). Empty array = disabled.
	frontmatterExcludeProperties: string[];
	defaultPosition: 'default' | 'fileEnd';
	linkOpenPosition: 'restore' | 'start'; // where to open a plain file link (no #/^ target): saved position, or file start
	sourceRestoreMethod: 'instant' | 'glide'; // how to restore a saved position in source mode
	readingRestoreMethod: 'instant' | 'glide'; // how to restore a saved position in reading view
	restoreIndicator: 'off' | 'breadcrumb' | 'both'; // what to show after a restore: section breadcrumb and/or a source-mode flash on the cursor line
	// opt-in recording of raw scroller scrollTop for base views, keyed by
	// their 'bases' view type. Off by default: the value is device-local, so a
	// synced record from another device would overwrite the local one with a
	// meaningless pixel offset. Other non-markdown FileViews (pdf, image...)
	// are never recorded: pdf is native-managed, the rest have no useful
	// scroll.
	recordBaseScroll: boolean;
	// Navigation history (VSCode-style back/forward) tuning.
	navStackCap: number; // max entries kept in the nav history stack; oldest drop on overflow
	navRecordActivation: boolean; // tab/pane activation records as a navigation entry
	navRecordTeleport: boolean; // large same-file cursor jumps record as navigation entries
	// The recent-files list's own storage. It is a DIFFERENT thing from the
	// back/forward stack above (and from the position records): what it holds is
	// which files the reader has been in and which headings/anchors they jumped
	// to, so a place may be lived in for months where a stack step lives for
	// minutes. Its ceiling is chosen in the panel's own gear (see
	// NavBrowserPrefs.placesCap), because that is where the reader is looking at
	// the list whose length it decides.
	navRecentCap: number; // max places kept in the recent-files list; oldest drop on overflow
	// The files the recent-files list must NOT record — its OWN rule, deliberately
	// not shared with excludedFolders above: that one answers "whose scroll
	// position is worth remembering" (a diary folder may be excluded from stale
	// restores and still be exactly what the reader wants to navigate back to),
	// while this one answers "which visits are worth listing".
	navRecentExcludeFolders: string[];
	// The history browser's own preferences. They are persisted rather than held
	// in the panel because both outlive the panel they are chosen in: a reader who
	// wants one row per note wants that of every note. Both are chosen IN the
	// panel — the list's shape and whether the details column exists at all, by the
	// toolbar's own setting button — because that is where the reader is looking at
	// what they change, and the settings tab keeps no second copy of either.
	navLandings: LandingsMode; // one row per note (the last spot it stands for), or every distinct spot printed under it
}

export const SAFE_DB_FLUSH_INTERVAL = 5000;

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
	navStackCap: 50,
	navRecordActivation: true,
	navRecordTeleport: true,
	navRecentCap: 200,
	navRecentExcludeFolders: [],
	navLandings: 'last',
};

export {
	CursorPos,
	EphemeralState,
	NavContextLine,
	NavEntryState,
	TabStateRecord,
	PluginSettings,
	LandingsMode,
};
