export const en = {
	openAndRestore: 'Open & restore',
	recordingRules: 'Recording rules',
	dataStorage: 'Data storage',

	defaultPositionName: 'Default position in edit view',
	defaultPositionDesc:
		'When no saved position exists for a file, move the cursor and scroll position here. Note: this setting only applies to the edit view; reading view does not use it.',
	optionDefault: 'Start of file (Obsidian default)',
	optionFileEnd: 'End of file',

	linkOpenName: 'Wikilink open position',
	linkOpenDesc:
		'When clicking a plain wikilink (without a # heading or ^ block target), whether to always open from the file start or use the saved position.',
	optionFileStart: 'File start',
	optionSavedPosition: 'Saved position',

	sourceRestoreName: 'Edit view restore method',
	sourceRestoreDesc:
		'How to restore a saved position in the edit view. "Instant" jumps directly to the saved line; "Glide" scrolls from the top to that line.',
	optionInstant: 'Instant',
	optionGlide: 'Glide',

	readingRestoreName: 'Reading view restore method',
	readingRestoreDesc:
		'How to restore a saved position in reading view. "Instant" jumps directly once rendered; "Glide" scrolls from the top to the saved line.',

	indicatorName: 'Position restore indicator',
	indicatorDesc:
		'The notice shown to the user after a position is restored. Breadcrumb: shows the heading path of the current location; cursor highlight: briefly flashes the line the cursor is on.',
	optionOff: 'Off',
	optionBreadcrumb: 'Breadcrumb only',
	optionBoth: 'Breadcrumb + cursor highlight',

	minLinesName: 'Do not record files shorter than',
	minLinesDesc:
		'Don\'t record the cursor/scroll position for files with fewer lines than this value. Set to "0" to disable this filter.',

	baseScrollName: 'Record scroll position for Base files',
	baseScrollDesc:
		'Off by default. The saved value is a raw pixel offset that only fits the device it was recorded on — if the database syncs across devices, another device\'s record would overwrite the local one with an offset that doesn\'t fit this screen. PDF is always excluded: Obsidian natively remembers PDF reading positions on each device. Other non-Markdown files (images, etc.) are never recorded.',

	foldersName: 'Excluded folders',
	foldersDesc: 'Don\'t record the cursor/scroll position for files in these folders and their subfolders.',
	listNoFolders: 'No folders excluded',
	addFolder: 'Add folder',
	searchFolders: 'Type to search folders...',
	noFoldersFound: 'No folders found',

	frontmatterExcludeName: 'Exclude by frontmatter property/value',
	frontmatterExcludeDesc:
		'Don\'t record files whose frontmatter matches any of these entries. An entry is either a property name (`publish`) — any file that merely has the property is excluded — or `name: value` (`publish: true`), which only excludes files whose property equals that value (yes/no/on/off count as booleans; arrays match when any element does). The properties usually already exist for another plugin, so no file needs editing. Remove all entries to disable. Beware bare names: "tags" would exclude nearly every note.',
	listNoProperties: 'No properties excluded',
	addProperty: 'Add property',
	searchProperties: 'Type to search properties...',
	noPropertiesFound: 'No properties found',
	propertyValueTitle: 'Exclude when {0} equals',
	propertyValueName: 'Value',
	propertyValueDesc: 'Leave empty to exclude any file that has this property, whatever its value.',
	propertyValuePlaceholder: 'e.g. true',
	propertyDuplicate: '{0} is already in the list',
	escapeHatchName: 'Per-file override property',
	escapeHatchDesc:
		'Any file can also opt out or in individually without touching settings: `{0}: false` never records it (overrides every rule above), `{0}: true` always records it (overrides excluded folders, the minimum-length filter and the property rule). Any other value is ignored.',

	dbName: 'Database file',
	dbDesc:
		'Path to the JSON file storing positions, relative to the vault root. Leave empty for the default positions.json in the plugin directory.',
	confirmTooltip: 'Confirm and validate',
	dbDefault: 'Using the default database file.',
	dbInvalid: 'The database file must be a vault-relative path ending in .json.',
	dbNoFolder: 'The folder does not exist. Create it in the vault first.',
	dbExists: 'A file already exists at that path, but it could not be read and merged. Remove it first.',
	dbMerged: 'Adopted the existing database file and merged {0} record(s) from it.',
	dbMoveFailed: 'Failed to move the database file: {0}',
	dbSet: 'Database file set to {0}',
	entriesName: 'Entry count',
	entriesDesc:
		'Currently recording positions for {0} files, up to a maximum of 750 entries. When the limit is exceeded, the positions of the least-recently-visited files are removed first.',
};

export type En = typeof en;
