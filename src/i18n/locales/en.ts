export const en = {
	// ═══ Position record ═══ what is kept, how it comes back, where it lives
	'lastPosition.heading': 'Last position',
	'lastPosition.intro':
		'Every note remembers where its cursor sat and how far it was scrolled, and opening it again lands on that spot — no flash at the top first, no jump afterwards. Positions are kept in a JSON file inside the vault, by default in the plugin folder — Obsidian Sync does not carry it from there, so to take your positions to another device, point the path inside the vault (under Data storage below).',

	'openAndRestore.heading': 'Open & restore',
	'openAndRestore.linkOpenPosition.name': 'Wikilink open position',
	'openAndRestore.linkOpenPosition.desc':
		'When clicking a plain wikilink (without a # heading or ^ block target), whether to always open from the file start or use the saved position.',
	'openAndRestore.linkOpenPosition.options.start': 'File start',
	'openAndRestore.linkOpenPosition.options.restore': 'Saved position',

	'openAndRestore.restoreBreadcrumb.name': 'Name the restored section',
	'openAndRestore.restoreBreadcrumb.desc':
		'After a position is restored, briefly show the heading path of where you landed — but only when no heading is visible on screen. Nothing is shown when a heading is already in view (you can see where you are), when the note has only one heading, or for a note\'s single level-1 heading, which is usually just the note title.',
	'openAndRestore.flashLandingLine.name': 'Mark the landing line',
	'openAndRestore.flashLandingLine.desc':
		'Briefly mark the line you arrive on: when a note reopens at your last position, and after an outline click, a section hit in search, or a back/forward landing on a line. Reading view marks the section instead. A cursor off screen simply has nothing to mark.',

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
		'Exclude a whole class of notes by frontmatter: a file matching any entry in the list is not recorded.',
	'recordingRules.frontmatterExclude.formName': 'A property name on its own (`status`): any file carrying the property is skipped, whatever its value.',
	'recordingRules.frontmatterExclude.formValue': 'A name with a value (`status: archived`): only files whose value equals it are skipped. yes/no/on/off compare as booleans; an array matches when any one element does.',
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
		'This page can also be bypassed one file at a time: in its frontmatter, `{0}: false` means never record it — while `{0}: true` means record it anyway, over excluded folders, the minimum-length filter and the property rule above. Only true and false mean anything; write anything else and it reads as if you had never written the property.',

	'recordingRules.recordBaseScroll.name': 'Record scroll position for Base files',
	'recordingRules.recordBaseScroll.desc':
		'A Base has no line numbers to anchor to the way Markdown does, so the only thing worth saving is the pixel offset you scrolled to — and that stops meaning anything once the screen size differs: two devices syncing the database would overwrite each other\'s number. Off by default. This switch concerns Base alone: PDF reading positions are already remembered natively on each device, and images and other non-Markdown files have no scroll state worth keeping.',

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
	'dataStorage.dbFileName.syncLocal': 'Inside the plugin folder (the default) — whether it travels with your vault depends on the sync client.',
	'dataStorage.dbFileName.syncVault': 'Inside the vault — an ordinary vault file, which any sync client can carry.',
	'dataStorage.dbFileName.syncHidden': 'Inside a hidden folder — some sync clients skip folders whose name starts with ".".',
	'dataStorage.dbFileName.syncSummary': 'Will Obsidian Sync carry this file?',
	'dataStorage.dbFileName.syncHint':
		'Obsidian Sync takes only data.json, main.js, manifest.json and styles.css out of a community plugin folder, so the database never leaves the device it was written on while it sits in the default location. To make positions follow you between devices, point this setting at a path inside the vault — the buttons below pick or create the folder for you — and enable "Sync all other types" in Obsidian Sync on every device. Folders whose name starts with "." are never synced by Obsidian Sync, so choose an ordinary vault folder.',

	'dataStorage.corruptDb.notice':
		'Position Restore: The database file could not be parsed (a sync client may have been rewriting it). A copy was kept at {0}. Starting from empty — positions are re-recorded as you open notes.',
	'dataStorage.corruptDb.noticeNoCopy':
		'Position Restore: The database file could not be parsed (a sync client may have been rewriting it) and no copy could be written, so its positions are unrecoverable. Starting from empty — positions are re-recorded as you open notes (see the console for details).',
	'dataStorage.legacyDb.notice':
		'Position Restore: the data file is in the format an older version of the plugin wrote. Every position in it was read, and the next save writes the whole file in the current format. If another device still runs an older version, update it too: the older version cannot read the new file, treats it as empty and rewrites it whole, so only the notes opened on that device survive — while versions differ, every sync can drop a batch of positions.',
	'dataStorage.legacyDb.noticeOverwritten':
		'Position Restore: the data file was just rewritten in the older format by a device that has not been updated yet. The older version cannot read the new file, so it wrote back only its own positions; everything another device had recorded in the new format is gone from the file. What this device recorded is untouched and goes back on the next save. Update the plugin on your other devices, or this repeats on every sync.',

	'dataStorage.entries.name': 'Entry count',
	'dataStorage.entries.desc':
		'Currently recording positions for {0} files, up to a maximum of 750 entries. When the limit is exceeded, the least-recently-visited records that sit at the default position are dropped first; the rest go least-recently-visited first.',
	'dataStorage.entries.atDefault':
		'Of these, {0} sit at the default position (the first line after the frontmatter) and hold no actual position.',

	// ═══ Hotkeys ═══ one row, needed by both pages
	'hotkeys.name': 'Hotkeys',
	'hotkeys.unbound': 'Not bound',
	'hotkeys.hint': 'To bind one: use the keyboard button on this row to open Settings → Hotkeys. A bound key only fires from a physical keyboard.',
	'hotkeys.open': 'Open hotkey settings',
	'hotkeys.openFailed': 'Could not open the hotkey settings. Go to Settings → Hotkeys and find this plugin\'s commands there.',

	// ═══ Back and forward ═══ the navigation stack
	'navHistory.heading': 'Back and forward',
	'navHistory.steps.heading': 'Steps recorded',
	'navHistory.intro':
		'VSCode-style "navigate back" / "navigate forward". Each of these takes a step: opening another note; jumping somewhere inside one — a link, the outline, a search result; switching tabs; opening a view with no file behind it, such as the graph; and a cursor move that crosses many lines at once (desktop only). A switch inside one tab travels on Obsidian\'s own per-tab history, so PDF, canvas and the other views this plugin cannot reposition come back too. The stack is kept on this device only — it does not sync with the vault — and survives restarts.',
	'navHistory.hotkeys.desc':
		'One command per direction, walking the steps above. Neither is bound by default — run either by name from the command palette.',
	'navHistory.stackCap.name': 'Back/forward steps kept',
	'navHistory.stackCap.desc': 'Maximum number of entries kept in the navigation history. When exceeded, the oldest entries are dropped first.',
	'navHistory.recordActivation.name': 'Record tab switches',
	'navHistory.recordActivation.desc': 'Clicking another tab pushes a back/forward step. Turned off, switching tabs stops leaving steps and the history keeps file opens and in-file jumps — except for views with no file behind them, such as the graph, which still take one: without that step, back from the graph would overshoot to an earlier note. It governs the back/forward history only: the recent-files list records those views either way.',
	'navHistory.teleportMinLines.name': 'Minimum lines in one cursor move',
	'navHistory.teleportMinLines.desc': 'A cursor move crossing at least this many lines in one action — clicking a spot far away in the note, a go-to-line command, a keyboard motion that crosses many lines at once — counts as an in-file jump and pushes a back/forward step. Set 0 to never record one — the default, since a step inferred from a cursor move is one the reader never asked for. Desktop only: the phone and tablet apps run no such detection.',
	'navHistory.commands.navigateBack': 'Navigate back',
	'navHistory.commands.navigateForward': 'Navigate forward',

	// ═══ The two ends of a note ═══ a place to go to, not a way to move
	'noteEdge.commands.top': 'Go to top of note',
	'noteEdge.commands.bottom': 'Go to bottom of note',

	// ═══ Recent files ═══ a list of places, and its panel
	'recentFiles.name': 'Recent files',

	'recentFiles.rules.heading': 'What gets listed',
	'recentFiles.display.heading': 'Display',

	'recentFiles.intro':
		'A list of places you have been: notes opened recently, and the main area\'s file-less views (the graph above all) — each one row, and a row opens that spot again. The filter can also search the headings inside each note: whichever ones it matches are drawn as rows beneath it, and one jumps straight to that section (see "Search headings" below). The list keeps no place inside a note — a section you have visited is what the "Back and forward" stack is for. The list is kept on this device only — it does not sync with the vault — and survives restarts.',

	'recentFiles.folders.name': 'Folders not listed',
	'recentFiles.folders.desc': 'Files in these folders are not added to the recent files list.',
	'recentFiles.folders.list.empty': 'Every folder is listed.',
	'recentFiles.folders.add': 'Add folder',
	'recentFiles.frontmatterExclude.name': 'Properties not listed',
	'recentFiles.frontmatterExclude.desc':
		'Exclude a whole class of notes by frontmatter: a file matching any entry in the list is never added to the recent files list.',
	'recentFiles.frontmatterExclude.formName': 'A property name on its own (`status`): any file carrying the property is left out, whatever its value.',
	'recentFiles.frontmatterExclude.formValue': 'A name with a value (`status: archived`): only files whose value equals it are left out. yes/no/on/off compare as booleans; an array matches when any one element does.',
	'recentFiles.frontmatterExclude.list.empty': 'Every file is listed.',
	'recentFiles.frontmatterExclude.add': 'Add property',
	'recentFiles.excludeImages.name': 'Leave out images',
	'recentFiles.excludeImages.desc':
		'Opening an image file no longer adds it to the recent files list. Turning this on also drops the image rows already on the list; turning it off starts listing images again, but the rows it dropped do not come back.',
	'recentFiles.cap.name': 'Notes to remember',
	'recentFiles.cap.desc':
		'How many notes the recent files list remembers (a view counts as one). Past that, the ones you have not opened for the longest are dropped; lowering it takes effect at once, and what it drops does not come back. Pinned rows do not count.',
	'recentFiles.outlineSearch.name': 'Search headings',
	'recentFiles.outlineSearch.desc':
		'Whether the filter matches the headings inside each note, on top of its name (and its aliases and path). On: every heading it matches is drawn as a row beneath that note, and clicking one jumps to it. Off: a query only ever names the note itself.',
	'recentFiles.pathDisplay.name': 'Folder path in the list',
	'recentFiles.pathDisplay.desc': 'Whether a row shows the folder its note sits in — on every row, or only where another row on screen shares the name — and on which side of the name. The side also decides which half gives way when the row runs out of width: the one laid out last drops to a second line.',
	'recentFiles.pathDisplay.options.smart': 'Only when names repeat',
	'recentFiles.pathDisplay.options.before': 'Always, before the name',
	'recentFiles.pathDisplay.options.after': 'Always, after the name',
	'recentFiles.rowTime.name': 'Time on each row',
	'recentFiles.rowTime.desc': 'Show how long ago each row was last visited — the last time you were there, and not the file\'s modification time. The exact moment is one hover away, on the label itself.',
	'recentFiles.titleProperty.name': 'Name from a property',
	'recentFiles.titleProperty.desc': 'Which frontmatter property a row prints as the note\'s name. A note without it — or whose value is not a single piece of text — keeps its file name.',
	'recentFiles.titleProperty.placeholder': 'e.g. title',
	'recentFiles.age.now': 'now',
	'recentFiles.age.m': 'm ago',
	'recentFiles.age.h': 'h ago',
	'recentFiles.age.d': 'd ago',
	'recentFiles.age.w': 'w ago',
	'recentFiles.age.mo': 'mo ago',
	'recentFiles.age.y': 'y ago',
	'recentFiles.title': 'title:',
	'recentFiles.aliases': 'aliases:',
	'recentFiles.openInNewTab': 'Open in new tab',
	'recentFiles.openHereInNewTab': 'Open here in a new tab',
	'recentFiles.forget': 'Remove from recent files',
	'recentFiles.clearList': 'Clear the whole list',
	'recentFiles.rowMenu': 'More actions',
	'recentFiles.pin': 'Pin to top',
	'recentFiles.unpin': 'Unpin',
	'recentFiles.pinUp': 'Move up',
	'recentFiles.pinDown': 'Move down',
	'recentFiles.pinFirst': 'Move to front',
	'recentFiles.pinLast': 'Move to end',
	'recentFiles.commands.open': 'Browse recent files',
	'recentFiles.commands.openSidebar': 'Open recent files in sidebar',
	'recentFiles.hotkeys.desc':
		'Two ways into the list: a dialog that answers once and closes, or a panel that stays in the sidebar. Neither is bound by default — the command palette opens either by name.',

	'recentFiles.graphView': 'Graph view',
	'recentFiles.viewBadge': 'View',
	'recentFiles.searchPlaceholder': 'Filter by note name or text…',
	'recentFiles.clearFilter': 'Clear filter',
	'recentFiles.close': 'Close',
	'recentFiles.noMatch': 'No matching entry.',
	'recentFiles.empty': 'Nowhere to go.',

	// ═══ Hover preview ═══ where the note opens
	'previewFocus.recentFiles.name': 'Where a preview opens the note',
	'previewFocus.recentFiles.desc':
		'The spot the app\'s own preview opens a hovered row\'s note at: its top, the way every list the app itself ships opens one, or the line you were last reading it at. Naming a line costs a wait — the note is drawn whole first and only then moved to it, so on a long note the card stands empty and then jumps. A row standing for a place in a note opens at that place either way.',
	'previewFocus.recentFiles.options.head': 'Its top',
	'previewFocus.recentFiles.options.line': 'Your last line',
	'previewFocus.fileExplorer.name': 'Where a file list preview opens the note',
	'previewFocus.fileExplorer.desc':
		'The spot the app\'s own file list opens its hover preview at: a note\'s top, which is what the app asks for and what it ships, or the last line this plugin recorded for that note. Naming a line costs the same wait it costs everywhere — the note is drawn whole first and only then moved there — and the line it opens is the one last recorded here, so a note changed on another device since may not open where you left it.',
	'previewFocus.fileExplorer.options.head': 'Its top',
	'previewFocus.fileExplorer.options.line': 'Your last line',
};

export type En = typeof en;
