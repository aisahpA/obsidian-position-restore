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
						const folders = ctx.plugin.settings.navRecentExcludeFolders;
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
							items: ctx.plugin.settings.navRecentExcludeFolders.map((folder) => ({
								name: folder + '/',
							})),
							onDelete: (index) => {
								const folders = ctx.plugin.settings.navRecentExcludeFolders.filter((_, i) => i !== index);
								void ctx.setValue('navRecentExcludeFolders', folders);
							},
							addItem: {
								name: t('recentFiles.folders.add'),
								action: () => {
									new FolderSuggestModal(
										ctx.app,
										ctx.plugin.settings.navRecentExcludeFolders,
										(path) => {
											const folders = [...ctx.plugin.settings.navRecentExcludeFolders, path];
											void ctx.setValue('navRecentExcludeFolders', folders);
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
				// PluginSettings.navRecentExcludeProperties): a note whose
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
						const props = ctx.plugin.settings.navRecentExcludeProperties;
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
							items: ctx.plugin.settings.navRecentExcludeProperties.map((prop) => ({
								name: prop,
							})),
							onDelete: (index) => {
								const props = ctx.plugin.settings.navRecentExcludeProperties.filter((_, i) => i !== index);
								void ctx.setValue('navRecentExcludeProperties', props);
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
												ctx.plugin.settings.navRecentExcludeProperties,
												(entry) => {
													const props = [...ctx.plugin.settings.navRecentExcludeProperties, entry];
													void ctx.setValue('navRecentExcludeProperties', props);
												}
											).open();
										}
									).open();
								},
							},
						},
					],
				},
				// WHAT A ROW PRINTS, and how far back the list reaches: the
				// browser's own preferences (see RecentFilesBrowserPrefs). They stand
				// here and no longer in a gear of the panel's toolbar — one
				// place that holds them, reached the way every other setting of
				// the plugin is, and no second copy inside a panel that is a
				// navigator rather than a control surface. A panel standing
				// open beside this page is redrawn as each of them is chosen
				// (the tab's write path repaints its panels — see settings/tab.ts),
				// so the question "what does the list look like" is answered in
				// front of the reader either way.
				{
					name: t('recentFiles.landings.name'),
					desc: t('recentFiles.landings.desc'),
					control: {
						type: 'dropdown',
						key: 'navLandings',
						options: {
							last: t('recentFiles.landings.options.last'),
							all: t('recentFiles.landings.options.all'),
						},
					},
				},
				{
					name: t('recentFiles.pathDisplay.name'),
					desc: t('recentFiles.pathDisplay.desc'),
					control: {
						type: 'dropdown',
						key: 'navPathDisplay',
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
						key: 'navRowTime',
					},
				},
				{
					name: t('recentFiles.cap.name'),
					desc: t('recentFiles.cap.desc'),
					control: {
						type: 'number',
						key: 'navRecentCap',
						min: 20,
						max: 500,
						step: 10,
					},
				},
			],
		},
	];
}
