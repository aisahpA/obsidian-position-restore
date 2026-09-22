import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro, hotkeys } from '@/settings/page';
import { FolderSuggestModal } from '@/settings/pickers';
import { t } from '@/i18n';

// THE "RECENT FILES" PAGE — the place list's own face in the settings. Two of
// its rows are the list's own rules (which folders it refuses, how far back it
// reaches), two more are how it LOOKS (see RecentFilesBrowserPrefs). It stands
// beside the place list and its browser rather than in the settings folder, so
// that "how do I change what a row prints" lands on the same shelf as the code
// that prints it.
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
