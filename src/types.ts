
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
	// time, in document order, with the landing itself at `contextAt`. The
	// history browser renders this block instead of re-reading the file (no
	// IO, works for a file that has since been deleted, and shows what the
	// user actually saw when they left) and the search box matches its text.
	// DISPLAY + SEARCH ONLY: re-anchoring stays `anchor`'s job, one line with
	// exact-match semantics (remapAnchoredState) — a multi-line block is a
	// different algorithm and must never feed it.
	context?: NavContextLine[],
	// Index of the landing line within `context`.
	contextAt?: number,
	// The file's line count at capture time — the denominator for the row's
	// "L412" (see the landing panel's head).
	lineCount?: number,
	// The file's mtime at capture time. Display-only: a live mtime that
	// differs means the file was written after this step was recorded, so the
	// text above may already be gone. (It is deliberately NOT used to skip the
	// text remap: that runs against a live editor buffer, which can differ
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
	// The history browser's own two preferences. They are persisted rather than held
	// in the panel because both outlive the panel they are chosen in: a reader who
	// wants the note as it stands now wants it tomorrow too, and a reader who wants
	// one landing per note wants that of every note. The MODE has no row in the
	// settings tab — the switch above the landing's content is where it is chosen
	// (see LandingPanel) — while the landings setting is an ordinary settings row.
	navPreviewMode: 'spot' | 'note'; // which content a landing opens on: the spot the step recorded, or the note as it stands now
	navLandings: 'last' | 'all'; // how many landings one note prints: only the newest, or every distinct spot
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
	navPreviewMode: 'spot',
	navLandings: 'last',
};

export {
	CursorPos,
	EphemeralState,
	NavContextLine,
	NavEntryState,
	TabStateRecord,
	PluginSettings,
};
