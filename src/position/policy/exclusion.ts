import { App, FileView, MarkdownView } from 'obsidian';
import { PluginSettings } from '@/types';
import { frontmatterDecisionFor } from './frontmatter';

// Consulted by the 100ms poll before every record, and deliberately uncached: both
// answers are already cheap in memory — a metadata read, a few startsWith — so a memo
// buys a Map get by paying for one, and adds a staleness rule for a working set whose
// size it cannot know.
export class ExclusionChecker {
	private app: App;
	private settings: PluginSettings;

	constructor(app: App, settings: PluginSettings) {
		this.app = app;
		this.settings = settings;
	}

	shouldSkipRecording(view: FileView): boolean {
		if (view.file) {
			// Escape hatch `position-restore: true`: record regardless of every
			// rule below (excluded folders, min lines, the B property rule).
			const decision = frontmatterDecisionFor(this.app, view.file, this.settings);
			if (decision?.forceRecord)
				return false;
			if (decision?.skip)
				return true;
			if (this.isExcludedPath(view.file.path))
				return true;
		}

		// minLinesToRecord is a text-only concern: only the markdown editor
		// has an Editor; other FileViews always pass this gate.
		const editor = view instanceof MarkdownView ? view.editor : undefined;
		const minLinesToRecord = this.settings.minLinesToRecord;
		if (minLinesToRecord > 0 && editor && editor.lineCount() < minLinesToRecord) {
			return true;
		}

		return false;
	}

	private isExcludedPath(filePath: string): boolean {
		const excludedFolders = this.settings.excludedFolders;
		if (excludedFolders.length === 0)
			return false;

		for (const folder of excludedFolders) {
			if (filePath === folder || filePath.startsWith(folder + '/'))
				return true;
		}
		return false;
	}
}
