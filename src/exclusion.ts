import { App, FileView, MarkdownView, TFile } from 'obsidian';
import { PluginSettings } from './types';
import { FrontmatterDecision, frontmatterDecisionFor } from './frontmatter';

const EXCLUDED_CACHE_SIZE = 32;

// Frontmatter lookups are already O(1) via the metadata cache, but the poll
// runs every 100ms; memoizing the derived decision keeps each tick to a Map
// get. Cleared on metadata-cache-changed (the frontmatter may have changed)
// and when settings change.
const FRONTMATTER_CACHE_SIZE = 128;

// Memoizes exclusion lookups per path. Called from the 100ms polling
// loop, so results are memoized; the caches are cleared when settings change
// or when the metadata cache re-parses a file.
export class ExclusionChecker {
	private app: App;
	private settings: PluginSettings;
	private cache: Map<string, boolean> = new Map();
	private frontmatterCache: Map<string, FrontmatterDecision> = new Map();

	constructor(app: App, settings: PluginSettings) {
		this.app = app;
		this.settings = settings;
	}

	shouldSkipRecording(view: FileView): boolean {
		if (view.file) {
			// Escape hatch `position-restore: true`: record regardless of every
			// rule below (excluded folders, min lines, the B property rule).
			const decision = this.getFrontmatterDecision(view.file);
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

	private getFrontmatterDecision(file: TFile): FrontmatterDecision | undefined {
		const cached = this.frontmatterCache.get(file.path);
		if (cached !== undefined)
			return cached;
		// Never memoize "not parsed yet": the metadata cache fills in lazily,
		// and the answer must flip the moment parsing lands. The lookup itself
		// is a Map read, so re-checking per tick costs nothing.
		const decision = frontmatterDecisionFor(this.app, file, this.settings);
		if (decision === undefined)
			return undefined;
		if (this.frontmatterCache.size >= FRONTMATTER_CACHE_SIZE)
			this.frontmatterCache.clear();
		this.frontmatterCache.set(file.path, decision);
		return decision;
	}

	// Drops the memoized decision for one path after the metadata cache
	// re-parsed that file.
	invalidateFrontmatter(filePath: string): void {
		this.frontmatterCache.delete(filePath);
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

	// Clears the frontmatter-decision memoization. Called when settings change
	// (the B property name may have changed).
	clearFrontmatterCache(): void {
		this.frontmatterCache.clear();
	}
}