import { FileView, MarkdownView } from 'obsidian';
import { PluginSettings } from './types';

const EXCLUDED_CACHE_SIZE = 32;

// Memoizes exclusion-path lookups per path. Called from the 100ms polling
// loop, so results are memoized; the cache is cleared when settings change.
export class ExclusionChecker {
	private cache: Map<string, boolean> = new Map();
	private settings: PluginSettings;

	constructor(settings: PluginSettings) {
		this.settings = settings;
	}

	shouldSkipRecording(view: FileView): boolean {
		if (view.file && this.isExcludedPath(view.file.path))
			return true;

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

		const cached = this.cache.get(filePath);
		if (cached !== undefined)
			return cached;

		let result = false;
		for (const folder of excludedFolders) {
			if (filePath === folder || filePath.startsWith(folder + '/')) {
				result = true;
				break;
			}
		}

		if (this.cache.size >= EXCLUDED_CACHE_SIZE)
			this.cache.clear();
		this.cache.set(filePath, result);
		return result;
	}

	// Clears the exclusion-path memoization. Called when settings change, since
	// the excluded-folders list may have changed.
	clearPathCache(): void {
		this.cache.clear();
	}
}
