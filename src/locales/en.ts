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
	'dataStorage.dbFileName.messages.exists': 'A file already exists at that path, but it could not be read and merged. Remove it first.',
	'dataStorage.dbFileName.messages.merged': 'Adopted the existing database file and merged {0} record(s) from it.',
	'dataStorage.dbFileName.messages.moveFailed': 'Failed to move the database file: {0}',
	'dataStorage.dbFileName.messages.set': 'Database file set to {0}',

	'dataStorage.entries.name': 'Entry count',
	'dataStorage.entries.desc':
		'Currently recording positions for {0} files, up to a maximum of 750 entries. When the limit is exceeded, the positions of the least-recently-visited files are removed first.',

	'navHistory.heading': 'Navigation history',
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

	'navHistory.commands.navigateBack': 'Navigate back',
	'navHistory.commands.navigateForward': 'Navigate forward',
	'navHistory.commands.browseHistory': 'Browse navigation history',

	'navHistory.type.open': 'Open',
	'navHistory.type.switch': 'Switch',
	'navHistory.type.teleport': 'Jump',
	'navHistory.type.outline': 'Outline',
	'navHistory.type.link': 'Link',
	'navHistory.type.graph': 'Graph',
	'navHistory.graphView': 'Graph view',
	'navHistory.missing': 'missing',
	'navHistory.anchorTip': 'Text of the line the jump lands on, for quick recognition',
	'navHistory.columns.type': 'Type',
	'navHistory.columns.position': 'Location',
	'navHistory.empty': 'Navigation history is empty.',
};

export type En = typeof en;
