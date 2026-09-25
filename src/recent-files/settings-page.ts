import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro, hotkeys } from '@/settings/page';
import { FolderSuggestModal, PropertySuggestModal, PropertyValueModal } from '@/settings/pickers';
import { t } from '@/i18n';

// THE "RECENT FILES" PAGE — the place list's own face in the settings. Three of
// its rows are the list's own rules (which folders it refuses, which
// frontmatter, how far back it reaches), three more are how it LOOKS (see
// RecentFilesBrowserPrefs). It stands beside the place list and its browser
// rather than in the settings folder, so that "how do I change what a row
// prints" lands on the same shelf as the code that prints it.
//
// One group with no heading, for the reason the back/forward page has none: the
// page is already named "Recent files".
export function recentFilesSettingsPage(ctx: SettingsPageContext): SettingDefinitionItem[] {
	return [
		{
			type: 'group',
			items: [
				intro(t('recentFiles.intro')),
				// The two commands that OPEN this list, on the page that is about
				// it (see the hotkeys row builder). The back/forward pair is on
				// its own page.
				hotkeys(ctx.plugin, t('recentFiles.hotkeys.desc'), [
					{ id: 'browse-recent-files', name: t('recentFiles.commands.open') },
					// The resident panel is a command like the other one, so it is
					// bound (or not) in the same place — see view.ts.
					{ id: 'open-recent-files-sidebar', name: t('recentFiles.commands.openSidebar') },
				]),
				{
					type: 'page',
					name: t('recentFiles.folders.name'),
					desc: (() => {
						const frag = createFragment();
						frag.createDiv({ text: t('recentFiles.folders.desc') });
						const folders = ctx.plugin.settings.recentFilesExcludeFolders;
						if (folders.length === 0)
							return frag;
						const list = frag.createEl('ul', { cls: 'mod-muted' });
						for (const folder of folders.slice(0, 5))
							list.createEl('li', { text: folder + '/' });
						if (folders.length > 5)
							list.createEl('li', { text: '...' });
						return frag;
					})(),
					items: [
						{
							type: 'list',
							emptyState: t('recentFiles.folders.list.empty'),
							items: ctx.plugin.settings.recentFilesExcludeFolders.map((folder) => ({
								name: folder + '/',
							})),
							onDelete: (index) => {
								const folders = ctx.plugin.settings.recentFilesExcludeFolders.filter((_, i) => i !== index);
								void ctx.setValue('recentFilesExcludeFolders', folders);
							},
							addItem: {
								name: t('recentFiles.folders.add'),
								action: () => {
									new FolderSuggestModal(
										ctx.app,
										ctx.plugin.settings.recentFilesExcludeFolders,
										(path) => {
											const folders = [...ctx.plugin.settings.recentFilesExcludeFolders, path];
											void ctx.setValue('recentFilesExcludeFolders', folders);
										}
									).open();
								},
							},
						},
					],
				},
				// WHICH FRONTMATTER THE LIST REFUSES — the same question the
				// folder rule above asks, answered one note at a time by the
				// note itself rather than by where it sits: a board another
				// plugin owns, a page marked published, a template. It is the
				// list's OWN list and not the position page's, for the same
				// reason the folders are (see
				// PluginSettings.recentFilesExcludeProperties): a note whose
				// cursor position is not worth keeping is still a note the
				// reader navigates to.
				//
				// The two pickers it opens are shared with the position page
				// (see settings/pickers.ts) — a property name is a property
				// name whichever page asks for one — so the entry form a reader
				// learns there is the form that works here.
				{
					type: 'page',
					name: t('recentFiles.frontmatterExclude.name'),
					desc: (() => {
						const frag = createFragment();
						frag.createDiv({ text: t('recentFiles.frontmatterExclude.desc') });
						frag.createDiv({
							cls: 'mod-muted',
							text: t('recentFiles.frontmatterExclude.formName'),
						});
						frag.createDiv({
							cls: 'mod-muted',
							text: t('recentFiles.frontmatterExclude.formValue'),
						});
						const props = ctx.plugin.settings.recentFilesExcludeProperties;
						if (props.length === 0)
							return frag;
						const list = frag.createEl('ul', { cls: 'mod-muted' });
						for (const prop of props.slice(0, 5))
							list.createEl('li', { text: prop });
						if (props.length > 5)
							list.createEl('li', { text: '...' });
						return frag;
					})(),
					items: [
						{
							type: 'list',
							emptyState: t('recentFiles.frontmatterExclude.list.empty'),
							items: ctx.plugin.settings.recentFilesExcludeProperties.map((prop) => ({
								name: prop,
							})),
							onDelete: (index) => {
								const props = ctx.plugin.settings.recentFilesExcludeProperties.filter((_, i) => i !== index);
								void ctx.setValue('recentFilesExcludeProperties', props);
							},
							addItem: {
								name: t('recentFiles.frontmatterExclude.add'),
								action: () => {
									new PropertySuggestModal(
										ctx.app,
										(name) => {
											new PropertyValueModal(
												ctx.app,
												name,
												ctx.plugin.settings.recentFilesExcludeProperties,
												(entry) => {
													const props = [...ctx.plugin.settings.recentFilesExcludeProperties, entry];
													void ctx.setValue('recentFilesExcludeProperties', props);
												}
											).open();
										}
									).open();
								},
							},
						},
					],
				},
				// HOW MUCH OF ONE NOTE THE LIST KEEPS, AND HOW MUCH OF WHAT IT
				// KEPT IT DRAWS — one row, three stops along a single axis
				// (see LandingsMode). The two halves are ONE question because
				// a landing that was never recorded cannot be drawn: a reader
				// choosing how much to see has already answered how much to
				// keep, and asking them twice produced a fourth answer that
				// meant nothing. The stops are monotonic — each keeps and
				// draws a superset of the one above — which is what lets them
				// sit in one dropdown instead of two controls.
				//
				// 'all' is the default: the list ships showing every spot
				// the reader left, which is the only stop from which the
				// two below it can be chosen with anything to choose
				// between — a reader who started at 'none' and only later
				// came upon this row would find nothing recorded under it.
				// And no stop is a one-way door: coming down stops the list
				// RECORDING new landings, but what it already recorded stays
				// until the note it stands in is crowded out.
				{
					name: t('recentFiles.landings.name'),
					desc: t('recentFiles.landings.desc'),
					control: {
						type: 'dropdown',
						key: 'recentFilesLandings',
						options: {
							none: t('recentFiles.landings.options.none'),
							last: t('recentFiles.landings.options.last'),
							all: t('recentFiles.landings.options.all'),
						},
					},
				},
				// HOW MANY NOTES THE LIST REMEMBERS — one number with one
				// meaning, whichever stop of the row above the reader is
				// on: it counts the notes and the views, never the landings
				// inside them, so moving between the stops does not move
				// the goal posts of a number they already set.
				//
				// It stands BELOW that row and not above it, because that
				// row is the only thing this one needs read first: a reader
				// who has not yet answered "how finely do I want my
				// navigation kept" cannot say what a number of notes is a
				// number of — the row above is what makes the row below
				// answerable. (And its sentence is written twice, but only
				// because the top stop owes one extra clause: landings are
				// drawn as rows there, so the list on screen runs longer
				// than this number even though the number still counts
				// notes.)
				{
					name: t('recentFiles.cap.name'),
					desc: ctx.plugin.settings.recentFilesLandings === 'all'
						? t('recentFiles.cap.desc.all')
						: t('recentFiles.cap.desc.plain'),
					control: {
						type: 'number',
						key: 'recentFilesCap',
						min: 20,
						max: 500,
						step: 10,
					},
				},
				{
					name: t('recentFiles.pathDisplay.name'),
					desc: t('recentFiles.pathDisplay.desc'),
					control: {
						type: 'dropdown',
						key: 'recentFilesPathDisplay',
						options: {
							smart: t('recentFiles.pathDisplay.options.smart'),
							before: t('recentFiles.pathDisplay.options.before'),
							after: t('recentFiles.pathDisplay.options.after'),
						},
					},
				},
				{
					name: t('recentFiles.rowTime.name'),
					desc: t('recentFiles.rowTime.desc'),
					control: {
						type: 'toggle',
						key: 'recentFilesRowTime',
					},
				},
				// WHAT A ROW CALLS THE NOTE. One property and not a list of
				// them: which one counts is the answer a reader can hold in
				// their head, and a note without it is not nameless — it falls
				// back to its file name, which is why there is no second
				// setting saying which to prefer.
				//
				// Empty is OFF, and off is the default: a vault that names its
				// notes in their file names owes this row nothing, and a vault
				// that does not is the only one that has to say so.
				{
					name: t('recentFiles.titleProperty.name'),
					desc: t('recentFiles.titleProperty.desc'),
					control: {
						type: 'text',
						key: 'recentFilesTitleProperty',
						placeholder: t('recentFiles.titleProperty.placeholder'),
					},
				},
				// WHERE A HOVERED ROW OPENS THE NOTE IN THE APP'S OWN PREVIEW. The
				// note's head ships, because the other stop costs a wait: naming a
				// line has the whole note drawn first and the card moved to it
				// afterwards, buying for that wait the arrival the row's own CLICK
				// already gives. A row standing for a PLACE in the note is outside
				// the choice either way — it opens at that place.
				{
					name: t('previewFocus.recentFiles.name'),
					desc: t('previewFocus.recentFiles.desc'),
					control: {
						type: 'dropdown',
						key: 'recentFilesPreviewFocus',
						options: {
							head: t('previewFocus.recentFiles.options.head'),
							line: t('previewFocus.recentFiles.options.line'),
						},
					},
				},
			],
		},
	];
}
