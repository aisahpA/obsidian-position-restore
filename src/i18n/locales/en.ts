export const en = {
	'openAndRestore.heading': 'Open & restore',
	'openAndRestore.defaultPosition.name': 'Default position in edit view',
	'openAndRestore.defaultPosition.desc':
		'When no saved position exists for a file, move the cursor and scroll position here. Note: this setting only applies to the edit view; reading view does not use it.',
	'openAndRestore.defaultPosition.options.default': 'Start of file (Obsidian default)',
	'openAndRestore.defaultPosition.options.fileEnd': 'End of file',

	'openAndRestore.linkOpenPosition.name': 'Wikilink open position',
	'openAndRestore.linkOpenPosition.desc':
		'When clicking a plain wikilink (without a # heading or ^ block target), whether to always open from the file start or use the saved position.',
	'openAndRestore.linkOpenPosition.options.start': 'File start',
	'openAndRestore.linkOpenPosition.options.restore': 'Saved position',

	'openAndRestore.sourceRestoreMethod.name': 'Edit view restore method',
	'openAndRestore.sourceRestoreMethod.desc':
		'How to restore a saved position in the edit view. "Instant" jumps directly to the saved line; "Glide" scrolls from the top to that line.',
	'openAndRestore.sourceRestoreMethod.options.instant': 'Instant',
	'openAndRestore.sourceRestoreMethod.options.glide': 'Glide',

	'openAndRestore.readingRestoreMethod.name': 'Reading view restore method',
	'openAndRestore.readingRestoreMethod.desc':
		'How to restore a saved position in reading view. "Instant" jumps directly once rendered; "Glide" scrolls from the top to the saved line.',
	'openAndRestore.readingRestoreMethod.options.instant': 'Instant',
	'openAndRestore.readingRestoreMethod.options.glide': 'Glide',

	'openAndRestore.restoreIndicator.name': 'Position restore indicator',
	'openAndRestore.restoreIndicator.desc':
		'The notice shown to the user after a position is restored. Breadcrumb: shows the heading path of the current location; cursor highlight: briefly flashes the line the cursor is on.',
	'openAndRestore.restoreIndicator.options.off': 'Off',
	'openAndRestore.restoreIndicator.options.breadcrumb': 'Breadcrumb only',
	'openAndRestore.restoreIndicator.options.both': 'Breadcrumb + cursor highlight',

	'recordingRules.heading': 'Recording rules',

	'recordingRules.folders.name': 'Excluded folders',
	'recordingRules.folders.desc': 'Don\'t record the cursor/scroll position for files in these folders and their subfolders.',
	'recordingRules.folders.list.empty': 'No folders excluded',
	'recordingRules.folders.add': 'Add folder',
	'recordingRules.folders.search.placeholder': 'Type to search folders...',
	'recordingRules.folders.search.empty': 'No folders found',

	'recordingRules.minLinesToRecord.name': 'Do not record files shorter than',
	'recordingRules.minLinesToRecord.desc':
		'Don\'t record the cursor/scroll position for files with fewer lines than this value. Set to "0" to disable this filter.',

	'recordingRules.frontmatterExclude.name': 'Exclude by frontmatter property/value',
	'recordingRules.frontmatterExclude.desc':
		'Don\'t record files whose frontmatter matches any of these entries. An entry is either a property name (`publish`) — any file that merely has the property is excluded — or `name: value` (`publish: true`), which only excludes files whose property equals that value (yes/no/on/off count as booleans; arrays match when any element does). The properties usually already exist for another plugin, so no file needs editing. Remove all entries to disable. Beware bare names: "tags" would exclude nearly every note.',
	'recordingRules.frontmatterExclude.list.empty': 'No properties excluded',
	'recordingRules.frontmatterExclude.add': 'Add property',
	'recordingRules.frontmatterExclude.search.placeholder': 'Type to search properties...',
	'recordingRules.frontmatterExclude.search.empty': 'No properties found',
	'recordingRules.frontmatterExclude.value.title': 'Exclude when {0} equals',
	'recordingRules.frontmatterExclude.value.name': 'Value',
	'recordingRules.frontmatterExclude.value.desc': 'Leave empty to exclude any file that has this property, whatever its value.',
	'recordingRules.frontmatterExclude.value.placeholder': 'e.g. true',
	'recordingRules.frontmatterExclude.duplicate': '{0} is already in the list',

	'recordingRules.escapeHatch.name': 'Per-file override property',
	'recordingRules.escapeHatch.desc':
		'Any file can also opt out or in individually without touching settings: `{0}: false` never records it (overrides every rule above), `{0}: true` always records it (overrides excluded folders, the minimum-length filter and the property rule). Any other value is ignored.',

	'recordingRules.recordBaseScroll.name': 'Record scroll position for Base files',
	'recordingRules.recordBaseScroll.desc':
		'Off by default. The saved value is a raw pixel offset that only fits the device it was recorded on — if the database syncs across devices, another device\'s record would overwrite the local one with an offset that doesn\'t fit this screen. PDF is always excluded: Obsidian natively remembers PDF reading positions on each device. Other non-Markdown files (images, etc.) are never recorded.',

	'dataStorage.heading': 'Data storage',

	'dataStorage.dbFileName.name': 'Database file',
	'dataStorage.dbFileName.desc': 'JSON file that stores position records.',
	'dataStorage.dbFileName.current': 'Current path: {0}',
	'dataStorage.dbFileName.change': 'Change',
	'dataStorage.dbFileName.modal.title': 'Set database file',
	'dataStorage.dbFileName.modal.default': 'Use default',
	'dataStorage.dbFileName.modal.cancel': 'Cancel',
	'dataStorage.dbFileName.apply': 'Confirm and apply',
	'dataStorage.dbFileName.pickFolder': 'Choose folder',
	'dataStorage.dbFileName.pickFile': 'Pick an existing JSON file in the vault',
	'dataStorage.dbFileName.search.placeholder': 'Type to search JSON files in the vault',
	'dataStorage.dbFileName.search.empty': 'No JSON file found',
	'dataStorage.dbFileName.messages.default': 'Using the default database file.',
	'dataStorage.dbFileName.messages.invalid': 'The database file must be a vault-relative path ending in .json.',
	'dataStorage.dbFileName.messages.exists': 'A file already exists at that path but is not a valid position database. Nothing was changed — pick another file or remove it first.',
	'dataStorage.dbFileName.mergeHint':
		'If the chosen file already exists, its records are merged into the current database before moving there. If it does not exist, the current database is simply moved to it.',
	'dataStorage.dbFileName.messages.merged': 'Adopted the existing database file and merged {0} record(s) from it.',
	'dataStorage.dbFileName.messages.moveFailed': 'Failed to move the database file: {0}',
	'dataStorage.dbFileName.messages.set': 'Database file set to {0}',
	// Where the file sits is a FACT the settings item may state; whether it
	// therefore syncs is not — that depends on the client the reader uses, and
	// several of them (Nutstore Sync, Remotely Save, iCloud, git) do carry a
	// plugin folder that Obsidian Sync skips. So the page says where the file
	// is and no more, and the modal's folded note names Obsidian Sync and its
	// rules, because that is the question it is asked there.
	'dataStorage.dbFileName.syncLocal': 'Inside the plugin folder (the default) — whether it travels with your vault depends on the sync client.',
	'dataStorage.dbFileName.syncVault': 'Inside the vault — an ordinary vault file, which any sync client can carry.',
	'dataStorage.dbFileName.syncHidden': 'Inside a hidden folder — some sync clients skip folders whose name starts with ".".',
	'dataStorage.dbFileName.syncSummary': 'Will Obsidian Sync carry this file?',
	'dataStorage.dbFileName.syncHint':
		'Obsidian Sync takes only data.json, main.js, manifest.json and styles.css out of a community plugin folder, so the database never leaves the device it was written on while it sits in the default location. To make positions follow you between devices, point this setting at a path inside the vault — the buttons below pick or create the folder for you — and enable "Sync all other types" in Obsidian Sync on every device. Folders whose name starts with "." are never synced by Obsidian Sync, so choose an ordinary vault folder.',

	'dataStorage.corruptDb.notice':
		'The database file could not be parsed (a sync client may have been rewriting it). A copy was kept at {0}. Starting from empty — positions are re-recorded as you open notes.',
	'dataStorage.corruptDb.noticeNoCopy':
		'The database file could not be parsed (a sync client may have been rewriting it) and no copy could be written, so its positions are unrecoverable. Starting from empty — positions are re-recorded as you open notes (see the console for details).',

	'dataStorage.entries.name': 'Entry count',
	'dataStorage.entries.desc':
		'Currently recording positions for {0} files, up to a maximum of 750 entries. When the limit is exceeded, the positions of the least-recently-visited files are removed first.',

	'navHistory.heading': 'Navigation history',
	// The settings item is its own heading's content, so it must not repeat the
	// heading (see settings-tab): what it actually holds is the hotkey list.
	'navHistory.hotkeys.name': 'Hotkeys',
	// The modal's own title, where there is no heading above it to repeat.
	'navHistory.overview.name': 'Navigation history',
	'navHistory.overview.desc':
		'VSCode-style "Navigate back" / "Navigate forward" across file switches and in-file jumps (links, outline, search results, large cursor moves). Always on — it only needs hotkeys, none are pre-assigned. Same-tab file switches ride Obsidian\'s native per-tab history (PDF, canvas and other views included); the stack (size configurable below) is device-local and survives restarts.',
	'navHistory.overview.hotkeyUnbound': 'Not bound — click the button to set it up',
	'navHistory.overview.openHotkeySettings': 'Open hotkey settings',

	'navHistory.stackCap.name': 'History stack size',
	'navHistory.stackCap.desc': 'Maximum number of entries kept in the navigation history. When exceeded, the oldest entries are dropped first.',
	'navHistory.recordActivation.name': 'Record tab switches',
	'navHistory.recordActivation.desc': 'Clicking another tab or pane pushes a history step, like VSCode. Turn off for a jump-only history: only file opens and in-file jumps are recorded (graph view steps stop being recorded too).',
	'navHistory.recordTeleport.name': 'Record large cursor jumps',
	'navHistory.recordTeleport.desc': 'A cursor move spanning many lines in one step (far mouse click, go-to-line, vim {/} page jumps) pushes a history step. Turn off if scrolling or misclicks keep polluting the history.',
	// How many spots in one note the history list prints. The setting itself stands on
	// the page too — the small button at the far end of the toolbar (see
	// NavHistoryBrowser.settings) — because the reader decides it while looking at the
	// list: by default the list follows the reader's own navigation, which is by file,
	// and the newest spot is the one their back button keeps returning to. That spot is
	// exactly what the note's row stands for (the panel describes it, the row opens it
	// — the row of the note the reader is already in included, where the open re-lands
	// the place rather than pushing it again), so nothing has to be printed under the
	// row for it.
	'navHistory.landings.name': 'Landings in the list',
	'navHistory.listSettings': 'Settings',
	// The few words an answer carries, written AFTER the answer itself (see
	// NavHistoryBrowser.settingGroup), in brackets so that they are read as a note on
	// the answer and not as a second label: one paragraph under the group had to name
	// its two options before it could say anything about them, and the reader had to
	// pick the sentence that belonged to the answer they were looking at out of a wall
	// of small print; beside the answer, the words are read where the answer is. The
	// brackets travel WITH the words, because which pair of them to draw is the
	// language's own call.
	'navHistory.landings.options.last': 'One row per note',
	'navHistory.landings.options.last.desc': '(last spot only)',
	'navHistory.landings.options.all': 'Every landing',
	'navHistory.landings.options.all.desc': '(all spots listed)',
	// Whether the list describes a landing at all (see
	// PluginSettings.navShowDetails). OFF by default: the history is a list of places
	// to go back to, and the column that says WHAT each spot was is a reader's own
	// choice — made here, from the list it changes. The group has ONE row rather than
	// the two of the groups above, because "show it" and "hide it" are not two answers
	// a reader picks between: the row is the switch, and the mark is its state.
	'navHistory.details.name': 'Spot details',
	'navHistory.details.show': 'Show',
	'navHistory.details.show.desc': '(what each spot was, from the row’s arrow)',

	'navHistory.commands.navigateBack': 'Navigate back',
	'navHistory.commands.navigateForward': 'Navigate forward',
	'navHistory.commands.browseHistory': 'Browse navigation history',
	// The resident form of the same browser: a sidebar panel instead of a dialog
	// (see view.ts). Named as a PLACE rather than as an action, because that is
	// the difference — the panel stays where it is put.
	'navHistory.commands.browseHistorySidebar': 'Open navigation history in sidebar',

	'navHistory.type.open': 'Open',
	'navHistory.type.switch': 'Switch',
	'navHistory.type.teleport': 'Jump',
	'navHistory.type.outline': 'Outline',
	'navHistory.type.link': 'Link',
	'navHistory.type.graph': 'Graph',
	'navHistory.graphView': 'Graph view',
	'navHistory.searchPlaceholder': 'Filter by note name or text…',
	'navHistory.noMatch': 'No matching entry.',
	// There used to be a file scope here: an "only this note" switch plus a chip
	// listing every note the history had been in. Both asked a question the
	// search box already answers — a note's name IS text it matches on — and each
	// cost the toolbar a cell and the dialog a piece of state, so both are gone
	// (see modal.ts).
	'navHistory.empty': 'Nowhere to go.',

	// Browser chrome: the click affordances. The list is a NAVIGATOR now: a click on a
	// row opens the file that row stands for, and the control in the row's left gutter
	// looks at that row's own details (see NavHistoryList.disclose). Two actions, two
	// targets, and that is what these lines teach.
	// `{arrow}` is where the row's OWN icon is drawn into the sentence (see
	// NavHistoryBrowser.hint) — the reader is told to look for the gutter control, so
	// the line shows the glyph that is actually on the list.
	// "Expand" is not in either sentence: WHICH details are shown is the button in the
	// gear (see NavHistoryBrowser.settings) and says nothing about the gesture, so the
	// line does not name it and cannot be left behind by it.
	// WHETHER there are details at all DOES change the sentence, and the line is
	// rewritten when that changes (see fillHint): the two lines below are the ones that
	// name a control, and the two after them are the ones a reader gets who has
	// switched the details column off.
	'navHistory.touchHint': 'Tap a row to open it, {arrow} to see this spot',
	// …and the same gestures with a mouse, in both shells: the list is click-only
	// (see NavHistoryList), opening is the row's own job, the gutter control looks,
	// and nothing at all happens on hover — a pointer that merely crosses a row moves
	// no position and opens nothing. (The keyboard still works — ↑↓ walk, Enter opens
	// — it is simply not what this line has to teach.)
	'navHistory.clickHint': 'Click a row to open it · {arrow} to see this spot',
	// The same two devices, with no details column to look at: one gesture, and a
	// sentence that says it and stops. No `{arrow}` in either — the glyph it stands for
	// is not on the list (see NavHistoryList.disclose).
	'navHistory.touchHintOpen': 'Tap a row to open it',
	'navHistory.clickHintOpen': 'Click a row to open it',
	// The gutter control's own word: it carries it as its tooltip.
	'navHistory.showDetails': 'View details',
	// A leaf holding a second tab/pane of the same file: without this the
	// browser's rows for the two panes are indistinguishable. Rendered as
	// "which of how many" — two digits and no word, because the word was the
	// widest thing in the row's quiet zone.
	'navHistory.pane': '{0}/{1}',
	'navHistory.disabledTip': 'File deleted — this step cannot be restored',
	// The span a row prints when it folds several nearby landings into one (see
	// groupByFile and LANDING_MERGE_LINES). The second L is dropped: it and the first
	// sit in the same column, and that column is narrow on a phone.
	'navHistory.lineRange': 'L{0}–{1}',
	// Relative time is no longer a column of the list (see listing.ts): it
	// survives in the landing panel's head alone.
	'navHistory.time.now': 'just now',
	'navHistory.time.minutes': '{0} min ago',
	'navHistory.time.hours': '{0} h ago',
	'navHistory.time.days': '{0} d ago',
	// Landing drawer. It prints the entry's own recorded context block — the
	// lines the user was looking at when they left, with no read behind it — or
	// the note as it stands now (one vault read, see PreviewContent). Both go
	// through Obsidian's OWN markdown renderer, so there is no "reading…" state
	// and no raw source on screen.
	'navHistory.preview.none': 'No line to preview here (no markdown landing).',
	'navHistory.preview.gone': 'File deleted.',
	// The drawer's two contents. They are no longer a pair of buttons in the panel:
	// which one is shown is a setting that travels with every panel, chosen in the
	// toolbar's gear (see NavHistoryBrowser.openSettings), so these two words are now
	// the labels of a group in that menu. One word each, because the few words
	// written after each of them say the rest.
	'navHistory.preview.name': 'Panel content',
	'navHistory.preview.spot': 'Then',
	'navHistory.preview.spot.desc': '(the lines you left on)',
	'navHistory.preview.note': 'Now',
	'navHistory.preview.note.desc': '(the note as it stands)',
	// The range the recorded block covers: the rendered lines have no gutter of
	// their own left to say which numbers they are. Not printed in the whole-note
	// view — those lines are today's note, and say nothing about the record.
	'navHistory.preview.recorded': 'On screen then · L{0}–L{1}',
	// A file that is not a note has one view — its own source — and no recorded
	// spot to name a range for.
	'navHistory.preview.source': 'File source',
	// …and one with no text at all (a PDF, an image). Clicking the row is what opens
	// it, so that is what the message names.
	'navHistory.preview.binary': 'Nothing to preview in a file like this (a PDF, an image…) — clicking the row opens it',
	// The note a plain link was clicked in, and the file's "written since the
	// step was recorded" marker.
	'navHistory.preview.via': 'via {0}',
	'navHistory.preview.modified': 'written since',
	// The drawer's empty state: the history has no entry at all, so the column says
	// what it is for instead of sitting blank.
	'navHistory.preview.pick': 'This column shows one place: use the control at the start of a row to open it',
};

export type En = typeof en;
