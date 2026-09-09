
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

// What a NavHistory entry carries beyond the position: the nav-display
// fields, produced ONLY by the low-frequency nav reads (readNavEntryState /
// withNavDisplay) at the moment a navigation entry is saved — never by the
// hot read. EphemeralState is structurally assignable, so baseline-fed
// states and legacy persisted entries type-check against consumers typed
// NavEntryState (their display fields are simply absent).
interface NavEntryState extends EphemeralState {
	// Trimmed text of the primary line (scroll line, else cursor line) at
	// capture time. Lets a stale line number (the file was edited after the
	// position was recorded) be re-mapped to the line that now carries this
	// text before the position is applied (remapAnchoredState).
	anchor?: string,
	// Trimmed text of the CURSOR line at capture time (source mode only —
	// a reading capture's cursor is the stale pre-preview one). Display-only:
	// the history browser shows the landing line's own text, while the remap
	// anchor above always belongs to the viewport top line.
	cursorAnchor?: string,
	// The view mode at capture time ('source' | 'preview'), stamped by the
	// nav reads. Display-only (the history browser shows the cursor line for
	// edit captures, the viewport top line for reading ones): a reading-mode
	// capture carries the editor's stale pre-preview cursor, so the mode
	// cannot be inferred from the state's shape. Consumers that read only
	// cursor/scroll ignore it; pre-upgrade persisted nav entries lack it and
	// fall back to the cursor-first heuristic.
	mode?: 'source' | 'preview',
	// Display-only: the cursor line was OUTSIDE the viewport at capture time
	// (source-mode scrolling does not move the cursor) — the history browser
	// falls back to the viewport top line + anchor instead of showing an
	// invisible cursor line. Set only when decidable; undecidable geometry
	// (no editor view, coords not yet measured, line beyond EOF) reads as
	// visible.
	cursorOffscreen?: true,
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
};

export {
	CursorPos,
	EphemeralState,
	NavEntryState,
	TabStateRecord,
	PluginSettings,
};
