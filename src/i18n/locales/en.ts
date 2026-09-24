export const en = {
	// ── Feature 1 · Saved positions: what is recorded, how it comes back,
	//    and where the records live ─────────────────────────────────────
	'lastPosition.heading': 'Last position',
	// WHAT THE PAGE IS ABOUT, once at the top (settings/page's intro row):
	// what is remembered, and where the record lives. No row below can say
	// either. The per-tab memory is left out on purpose: it is a device-local
	// overlay, and saying it beside "a JSON file inside the vault" would
	// promise that it travels too.
	'lastPosition.intro':
		'Every note remembers where its cursor sat and how far it was scrolled, and opening it again lands on that spot — no flash at the top first, no jump afterwards. Positions are kept in a JSON file inside the vault, by default in the plugin folder — Obsidian Sync does not carry it from there, so to take your positions to another device, point the path inside the vault (under Data storage below).',

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
		'The database file could not be parsed (a sync client may have been rewriting it). A copy was kept at {0}. Starting from empty — positions are re-recorded as you open notes.',
	'dataStorage.corruptDb.noticeNoCopy':
		'The database file could not be parsed (a sync client may have been rewriting it) and no copy could be written, so its positions are unrecoverable. Starting from empty — positions are re-recorded as you open notes (see the console for details).',

	'dataStorage.entries.name': 'Entry count',
	'dataStorage.entries.desc':
		'Currently recording positions for {0} files, up to a maximum of 750 entries. When the limit is exceeded, the positions of the least-recently-visited files are removed first.',

	// ── Shared · what a hotkey row says, on either page that binds one ──
	// Named for what it HOLDS, not for the page it stands on: a reader looking
	// for one of these is looking for the key, not for the page.
	'hotkeys.name': 'Hotkeys',
	// The button that opens the app's hotkey settings is an extra button that
	// wraps BELOW the row on a narrow screen, so no sentence here may point at
	// a side — only at what it looks like.
	'hotkeys.unbound': 'Not bound',
	// "Physical keyboard", not "external": true on both ends.
	'hotkeys.hint': 'To bind one: use the keyboard button on this row to open Settings → Hotkeys. A bound key only fires from a physical keyboard.',
	'hotkeys.open': 'Open hotkey settings',
	// Fallback when the button never lands on that tab.
	'hotkeys.openFailed': 'Could not open the hotkey settings. Go to Settings → Hotkeys and find this plugin\'s commands there.',

	// ── Feature 2 · Back and forward: the navigation stack ──────────────
	'navHistory.heading': 'Back and forward',
	// WHAT THE PAGE IS ABOUT: what a step is, and where the stack lives — the
	// two things no row below can say for itself, and why those rows can be
	// short: a toggle only has to say whether its own kind of step counts.
	'navHistory.intro':
		'VSCode-style "navigate back" / "navigate forward". Each of these takes a step: opening another note; jumping somewhere inside one — a link, the outline, a search result; switching tabs; opening a view with no file behind it, such as the graph; and a cursor move that crosses many lines at once (desktop only). A switch inside one tab travels on Obsidian\'s own per-tab history, so PDF, canvas and the other views this plugin cannot reposition come back too. The stack is kept on this device only — it does not sync with the vault — and survives restarts.',
	// One command per direction. Nothing here repeats the sentence above:
	// "back" and "forward" have already been said on this page.
	'navHistory.hotkeys.desc':
		'One command per direction, walking the steps above. Neither is bound by default — run either by name from the command palette.',
	'navHistory.stackCap.name': 'Back/forward steps kept',
	'navHistory.stackCap.desc': 'Maximum number of entries kept in the navigation history. When exceeded, the oldest entries are dropped first.',
	'navHistory.recordActivation.name': 'Record tab switches',
	'navHistory.recordActivation.desc': 'Clicking another tab pushes a back/forward step. Turned off, switching tabs stops leaving steps and the history keeps file opens and in-file jumps — except for views with no file behind them, such as the graph, which still take one: without that step, back from the graph would overshoot to an earlier note. It governs the back/forward history only: the recent-files list records those views either way.',
	'navHistory.teleportMinLines.name': 'Cursor jump distance',
	'navHistory.teleportMinLines.desc': 'A cursor move crossing at least this many lines in one action — clicking a spot far away in the note, a go-to-line command, a keyboard motion that crosses many lines at once — counts as an in-file jump and pushes a back/forward step. Set 0 to never record one. Desktop only: the phone and tablet apps run no such detection.',
	'navHistory.commands.navigateBack': 'Navigate back',
	'navHistory.commands.navigateForward': 'Navigate forward',

	// ── Feature 3 · Recent files: the list of places, and its panel ─────
	// The modal's own title, and the PANEL's name: a list of places — recent
	// notes plus the headings and anchors jumped to inside them — and NOT the
	// back/forward stack. The two answer different questions.
	'recentFiles.name': 'Recent files',

	// WHAT THE PAGE IS ABOUT: what one ROW stands for, and what this list is
	// not — the reader arrives here from "Back and forward", and the two stores
	// answer different questions while looking like two views of one history.
	// The one fact borrowed from a row below is that row's DEFAULT, so it has
	// to move with LandingsMode's default ('all'): a reader who never opens
	// "How much it keeps" still has a list behaving one way.
	'recentFiles.intro':
		'A list of places you have been: notes opened recently, and the main area\'s file-less views (the graph above all) — each one row, and a row opens that spot again. The headings and blocks you jumped to inside a note get rows of their own as well — how many, is the "How much it keeps" row below, and by default every one of them is kept. It is not the "Back and forward" stack: that one holds how you got here, this one holds where you have been, and the two are kept apart. The list is kept on this device only — it does not sync with the vault — and survives restarts.',

	// This list's OWN folder rule (recentFilesExcludeFolders), and not the
	// position records' — the two are not on one page, so it says what it does
	// and stops there.
	'recentFiles.folders.name': 'Folders not listed',
	'recentFiles.folders.desc': 'Files in these folders are not added to the recent files list.',
	'recentFiles.folders.list.empty': 'Every folder is listed.',
	'recentFiles.folders.add': 'Add folder',
	// The folder rule's question answered by the note itself instead of by
	// where it sits. Both forms get a line: nearly every reader arrives to
	// check which of the two to type.
	'recentFiles.frontmatterExclude.name': 'Properties not listed',
	'recentFiles.frontmatterExclude.desc':
		'Exclude a whole class of notes by frontmatter: a file matching any entry in the list is never added to the recent files list.',
	'recentFiles.frontmatterExclude.formName': 'A property name on its own (`status`): any file carrying the property is left out, whatever its value.',
	'recentFiles.frontmatterExclude.formValue': 'A name with a value (`status: archived`): only files whose value equals it are left out. yes/no/on/off compare as booleans; an array matches when any one element does.',
	'recentFiles.frontmatterExclude.list.empty': 'Every file is listed.',
	'recentFiles.frontmatterExclude.add': 'Add property',
	// Counts NOTES and views only — never the landings inside them, so the
	// number keeps its meaning whichever stop of the landings setting the
	// reader is on. Hence two sentences: at the top stop landings are drawn as
	// rows, so the list on screen runs longer than this number.
	'recentFiles.cap.name': 'Notes to remember',
	'recentFiles.cap.desc.plain':
		'How many notes the recent files list remembers (a view counts as one). Past that, the ones you have not opened for the longest are dropped; lowering it takes effect at once, and what it drops does not come back.',
	'recentFiles.cap.desc.all':
		'How many notes the recent files list remembers (a view counts as one) — the landings inside a note do not count, but each is drawn as a row of its own, so the list runs longer than this number. Past that, the ones you have not opened for the longest are dropped; lowering it takes effect at once, and what it drops does not come back.',
	// HOW MUCH IS KEPT, AND HOW MUCH OF IT IS DRAWN — three stops on one axis
	// (LandingsMode), not two controls: how much is drawn depends on how much
	// was kept. Every stop is reversible, so the sentence carries no price:
	// coming back down stops new landings and draws none, but keeps them.
	'recentFiles.landings.name': 'How much it keeps',
	'recentFiles.landings.desc':
		'How finely the list remembers where you have been: the notes you opened only, or the headings and blocks you jumped to inside them as well. And once they are recorded, whether they are drawn: the note still takes one row and its landings only answer the search box, or every landing gets a row of its own. Moving either way costs nothing: coming back to "notes only" merely stops recording new ones — the landings already recorded are kept, and going back down finds them there, until the note they stand in is crowded out.',
	'recentFiles.landings.options.none': 'Notes only',
	'recentFiles.landings.options.last': 'Landings, one row per note',
	'recentFiles.landings.options.all': 'Landings, a row each',
	// What the reader is really choosing is what gives way when the row runs
	// out of width — a flex line wraps at its end, so whichever half is laid
	// out last drops to a second line. "Only when names repeat" says the
	// least: the folder is a disambiguator.
	'recentFiles.pathDisplay.name': 'Folder path in the list',
	'recentFiles.pathDisplay.desc': 'Whether a row shows the folder its note sits in — on every row, or only where another row on screen shares the name — and on which side of the name. The side also decides which half gives way when the row runs out of width: the one laid out last drops to a second line.',
	'recentFiles.pathDisplay.options.smart': 'Only when names repeat',
	'recentFiles.pathDisplay.options.before': 'Always, before the name',
	'recentFiles.pathDisplay.options.after': 'Always, after the name',
	// The place's own `t` — the last time the reader was there, and NOT the
	// file's modification time, which is the first thing a reader guesses at a
	// time printed on a file row. The exact moment rides on the tooltip.
	'recentFiles.rowTime.name': 'Time on each row',
	'recentFiles.rowTime.desc': 'Show how long ago each row was last visited — the last time you were there, and not the file\'s modification time. The exact moment is one hover away, on the label itself.',
	'recentFiles.age.now': 'now',
	'recentFiles.age.m': 'm ago',
	'recentFiles.age.h': 'h ago',
	'recentFiles.age.d': 'd ago',
	'recentFiles.age.w': 'w ago',
	'recentFiles.age.mo': 'mo ago',
	'recentFiles.age.y': 'y ago',
	// TWO answers because a row stands for a PLACE, not merely a file: a jump
	// row promises a landing, so "open in a new tab" has to mean opening it
	// THERE. The menu it sits in is the app's; this is the one item the app
	// cannot know.
	// A file's OTHER names, on the row's own tooltip: searchable, occupying no
	// cell, so the hover is the only place a reader sees them. The colon is
	// part of the value — whether to draw one is the language's call.
	'recentFiles.aka': 'aka:',
	// The two QUOTED lines on a landing row's tooltip: both the note's own
	// words, recorded when the place was taken and printed nowhere else. "As
	// recorded" is the point — the note may have been edited since.
	'recentFiles.matchedLine': 'Matched:',
	'recentFiles.landingLine': 'As recorded:',
	'recentFiles.editedSince': 'Edited since this was recorded',
	'recentFiles.openInNewTab': 'Open in new tab',
	'recentFiles.openHereInNewTab': 'Open here in a new tab',
	// The row's own removal, drawn as a ×. "Remove" and not "delete": what
	// goes is the record — the file and the position database are untouched,
	// and visiting the file again puts a place back.
	'recentFiles.forget': 'Remove from recent files',
	// The same × on a LANDING's row: what goes is one place inside the note
	// and the note keeps its own row. "Place" and not "line": the row is the
	// line AND its section, and a place that moved in an edit is still it.
	'recentFiles.forgetLanding': 'Remove this place',
	// What this control raises is the APP'S own menu for the file. "More
	// actions" and not "menu" — and not "open in a new tab", which is one item
	// ON that menu.
	'recentFiles.rowMenu': 'More actions',
	// "Browse" and not "open": what opens is the LIST, and "open recent files"
	// reads as opening the one file the reader was last in. It is also what
	// separates the two commands in the palette — the other is "Open …".
	'recentFiles.commands.open': 'Browse recent files',
	// The resident form: a sidebar panel instead of a dialog. Named as a PLACE
	// rather than as an action — the panel stays where it is put.
	'recentFiles.commands.openSidebar': 'Open recent files in sidebar',
	// Their keys stand on this page and NOT beside the back/forward ones: a
	// reader looking for the key that opens the LIST should not have to know
	// it lives under a heading about travel.
	'recentFiles.hotkeys.desc':
		'Two ways into the list: a dialog that answers once and closes, or a panel that stays in the sidebar. Neither is bound by default — the command palette opens either by name.',

	// Fallback name for a view step carrying none of its own: the graph. A view
	// with a name of its own prints that; one without prints its bare type.
	'recentFiles.graphView': 'Graph view',
	// What a view row prints in place of an icon when the view named none.
	'recentFiles.viewBadge': 'View',
	'recentFiles.searchPlaceholder': 'Filter by note name or text…',
	// The × at the end of the filter box: the button's accessible name and
	// tooltip, so written as the action rather than as the glyph.
	'recentFiles.clearFilter': 'Clear filter',
	'recentFiles.noMatch': 'No matching entry.',
	'recentFiles.empty': 'Nowhere to go.',
};

export type En = typeof en;
