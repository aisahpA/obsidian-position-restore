import { App, FileView, MarkdownView } from 'obsidian';
import { PluginSettings } from '@/types';
import { frontmatterDecisionFor } from './frontmatter';

// 每次记录之前由那个 100ms 轮询查询，且故意不缓存：两个答案在内存里本来就很便宜 —— 一次
// metadata 读、几次 startsWith —— 一个 memo 省下一次 Map 取，却要先付出一次 Map 取，还给一个
// 规模未知的工作集添了一条过期规则。
export class ExclusionChecker {
	private app: App;
	private settings: PluginSettings;

	constructor(app: App, settings: PluginSettings) {
		this.app = app;
		this.settings = settings;
	}

	shouldSkipRecording(view: FileView): boolean {
		if (view.file) {
			// 逃生口 `position-restore: true`：无视下面每一条规则（排除的文件夹、
			// 最小行数、B 属性规则）照记。
			const decision = frontmatterDecisionFor(this.app, view.file, this.settings);
			if (decision?.forceRecord)
				return false;
			if (decision?.skip)
				return true;
			if (this.isExcludedPath(view.file.path))
				return true;
		}

		// minLinesToRecord 只管文本：只有 markdown 编辑器才有 Editor；
		// 别的 FileView 一律过这道门。
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
