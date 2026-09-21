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
	// The PANEL's name. It is a list of places the reader has been — recent
	// files, plus the headings and anchors they jumped to inside them (see
	// places.ts) — and NOT the back/forward stack, which is why it is not
	// called "Navigation history" any more: the two answer different questions
	// and only one of them is a history of travel.
	'navHistory.overview.name': 'Recent files',
	'navHistory.overview.desc':
		'VSCode-style "Navigate back" / "Navigate forward" across file switches and in-file jumps (links, outline, search results, large cursor moves). Always on — it only needs hotkeys, none are pre-assigned. Same-tab file switches ride Obsidian\'s native per-tab history (PDF, canvas and other views included); the stack (size configurable below) is device-local and survives restarts.',
	'navHistory.overview.hotkeyUnbound': 'Not bound — click the button to set it up',
	'navHistory.overview.openHotkeySettings': 'Open hotkey settings',

	// The recent-files list's OWN folder rule (see
	// PluginSettings.navRecentExcludeFolders): which visits are worth listing.
	// Its own list, deliberately not the recording rules' folders above.
	'navHistory.recentFolders.name': 'Folders not listed',
	'navHistory.recentFolders.desc': 'Files in these folders are not added to the recent files list. Separate from the recording rules above: a folder you do not want to remember positions in may still be one you want to navigate back to.',
	'navHistory.recentFolders.list.empty': 'Every folder is listed.',
	'navHistory.recentFolders.add': 'Add folder',
	// How far back the list reaches: the panel's own storage knob, chosen in the
	// panel (see NavBrowserPrefs.placesCap).
	'navHistory.recentCap.name': 'Places to keep',
	'navHistory.recentCap.short': '(last 100)',
	'navHistory.recentCap.medium': '(last 200)',
	'navHistory.recentCap.long': '(last 500)',
	'navHistory.stackCap.name': 'Back/forward steps kept',
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
	// How much of a row's PATH is printed, and on which side of the name (see
	// PathDisplayMode). The two "always" answers are written as what happens when the
	// row is too narrow, because that — and not the side — is what the reader is
	// really choosing: a flex line wraps at its end, so whichever half is laid out
	// last is the half that drops to a second line. "Only when names repeat" is the
	// default and the one that says the least: the folder is a disambiguator, so it
	// is printed where there is something to disambiguate.
	'navHistory.pathDisplay.name': 'Folder path in the list',
	'navHistory.pathDisplay.options.smart': 'Only when names repeat',
	'navHistory.pathDisplay.options.smart.desc': '(hidden otherwise)',
	'navHistory.pathDisplay.options.before': 'Always, before the name',
	'navHistory.pathDisplay.options.before.desc': '(name drops below if long)',
	'navHistory.pathDisplay.options.after': 'Always, after the name',
	'navHistory.pathDisplay.options.after.desc': '(path drops below if long)',
	// Whether each row says how long ago it was last visited, and the words the age
	// itself is built from. Each value is a UNIT plus the word "ago"
	//  — and a row's age is exactly the thing a reader should not have to decode.
	// The exact moment is carried as the label's own tooltip instead.
	//
	// "time since last visit" is not decoration: a reader's first guess at a time
	// printed on a file row is the file's own modification time, which is a different
	// fact and not what this is.
	'navHistory.rowTime.name': 'Time on each row',
	'navHistory.rowTime.options.on': 'Show',
	'navHistory.rowTime.options.on.desc': '(time since last visit)',
	'navHistory.rowTime.options.off': 'Hide',
	'navHistory.rowTime.options.off.desc': '(nothing on the row)',
	'navHistory.age.now': 'now',
	'navHistory.age.m': 'm ago',
	'navHistory.age.h': 'h ago',
	'navHistory.age.d': 'd ago',
	'navHistory.age.w': 'w ago',
	'navHistory.age.mo': 'mo ago',
	'navHistory.age.y': 'y ago',
	// The row's right-click menu (see NavHistoryBrowser.contextRow). The menu itself is
	// the app's; the ONE item added is the one the app cannot know, because a row here
	// stands for a PLACE and not merely for a file: a jump row promises a landing, and
	// "open it in a new tab" has to mean opening it THERE. Hence two answers rather than
	// one — "the file" and "this spot in it" are different promises.
	// The word a file's OTHER names are introduced by, on the row's own tooltip (see
	// NavHistoryReads.aliasesFor). They are searchable and occupy no cell, so the hover
	// is the only place a reader ever sees them; the colon is part of the value because
	// whether to draw one is the language's call.
	'navHistory.aka': 'aka:',
	'navHistory.menu.openInNewTab': 'Open in new tab',
	'navHistory.menu.openHereInNewTab': 'Open here in a new tab',
	'navHistory.commands.navigateBack': 'Navigate back',
	'navHistory.commands.navigateForward': 'Navigate forward',
	'navHistory.commands.browseHistory': 'Open recent files',
	// The resident form of the same browser: a sidebar panel instead of a dialog
	// (see view.ts). Named as a PLACE rather than as an action, because that is
	// the difference — the panel stays where it is put.
	'navHistory.commands.browseHistorySidebar': 'Open recent files in sidebar',
	// The one destructive command: it throws the reader's own recent list away. Named
	// for what it empties rather than for "reset" or "clear history", because the
	// back/forward stack is a different store and is NOT what this touches.
	'navHistory.commands.clearRecent': 'Clear recent files',

	// What a step with no file (the graph) is called in the list.
	'navHistory.graphView': 'Graph view',
	'navHistory.searchPlaceholder': 'Filter by note name or text…',
	// The × at the end of the filter box (see NavHistoryBrowser.toolbar): the app's own
	// gesture, named for what it empties. It is the button's accessible name and its
	// tooltip, so it is written as the action rather than as the glyph.
	'navHistory.clearFilter': 'Clear filter',
	'navHistory.noMatch': 'No matching entry.',
	// There used to be a file scope here: an "only this note" switch plus a chip
	// listing every note the history had been in. Both asked a question the
	// search box already answers — a note's name IS text it matches on — and each
	// cost the toolbar a cell and the dialog a piece of state, so both are gone
	// (see modal.ts).
	'navHistory.empty': 'Nowhere to go.',

	// The line of chrome in the toolbar, one sentence per device. The list is a plain
	// navigator now: a row has ONE gesture — a click opens what it stands for (see
	// NavHistoryList) — and nothing at all happens on hover. (The keyboard still works
	// — ↑↓ walk, Enter opens — it is simply not what this line has to teach.)
	'navHistory.touchHint': 'Tap a row to open it',
	'navHistory.clickHint': 'Click a row to open it',
	// A leaf holding a second tab/pane of the same file: without this the
	// browser's rows for the two panes are indistinguishable. Rendered as
	// "which of how many" — two digits and no word, because the word was the
	// widest thing in the row's quiet zone.
	'navHistory.pane': '{0}/{1}',
};

export type En = typeof en;
