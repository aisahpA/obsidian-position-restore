import { App, TFile } from 'obsidian';
import { PluginSettings } from '@/types';
import { frontmatterRuleMatches } from '@/shared/frontmatter';

// frontmatter 驱动的记录开关，记录门（ExclusionChecker）与 db 清理器
// （CursorPositionDatabase.pruneDb）共用，好让一个被 frontmatter 排除的文件在各处得到同样的对待。
// 两处都读 Obsidian 的内存 metadata 缓存 —— 从不读文件正文 —— 所以热路径（100ms 轮询、滚动采集）
// 只花一次 Map 取。
//
// A（逃生口）：本插件保留的属性 —— `position-restore` —— 语义是严格布尔。`false` 永不记录该文件
// （绝对，压过其它一切规则）；`true` 永远记录（压过排除文件夹、最小长度过滤和下面的 B 规则）。
// 字符串形式 "true"/"false" 也算 —— Obsidian 的属性 UI 把文本型的值加引号存，只认严格布尔的检查
// 会静默漏掉 UI 里填的标记。别的值一律无视，YAML 噪音就没法悄悄翻转记录与否。
//
// B（规则）：一份可配置的 `prop[: value]` 条目列表（frontmatterExcludeProperties）。只写名字 ——
// `publish` —— 则任何 frontmatter **含有**该属性的文件都不记录（值无视）；写成「名: 值」——
// `publish: true` —— 则只有属性匹配它时才不记录。两种形式可以混在同一份列表里。空列表 = 关闭。
// 条目本身的形态住在 shared/frontmatter.ts，所以两个使用方不会对同一条目给出不同解读。
//
// 最近文件列表故意**不**回读这个逃生口：`position-restore` 回答的是「位置」记不记，而读者主动放弃
// 记录位置的一篇笔记，仍然是他会导航过去的一个地点（见 recent-files/places.ts）。

export const ESCAPE_HATCH_PROPERTY = 'position-restore';

export interface FrontmatterDecision {
	// `position-restore: true`：无视下面每一条规则照记。
	forceRecord: boolean;
	// `position-restore: false` 或者匹配上任何一条配置的 B 规则：永不记录。
	skip: boolean;
}

// 把逃生口标记归一到严格布尔：布尔值直接过；字符串 "true"/"false"（忽略大小写、先 trim）也接受，
// 因为 Obsidian 的属性 UI 把文本型的值加引号存。其它一律返回 undefined =「没有标记」。
function markerValue(v: unknown): boolean | undefined {
	if (typeof v === 'boolean')
		return v;
	if (typeof v === 'string') {
		const s = v.trim().toLowerCase();
		if (s === 'true')
			return true;
		if (s === 'false')
			return false;
	}
	return undefined;
}

// 对原始 frontmatter 的纯决策 —— 不需要 App 就能单测。
export function evaluateFrontmatter(frontmatter: unknown, settings: PluginSettings): FrontmatterDecision {
	const decision: FrontmatterDecision = { forceRecord: false, skip: false };
	if (!frontmatter || typeof frontmatter !== 'object')
		return decision;
	const obj = frontmatter as Record<string, unknown>;

	// 先看逃生口：逐文件的显式标记压过一切批量规则。
	const marker = markerValue(obj[ESCAPE_HATCH_PROPERTY]);
	if (marker === true) {
		decision.forceRecord = true;
	} else if (marker === false) {
		decision.skip = true;
	} else if (frontmatterRuleMatches(frontmatter, settings.frontmatterExcludeProperties ?? [])) {
		// B 规则：有一条条目匹配上了（见 shared/frontmatter.ts）。
		decision.skip = true;
	}
	return decision;
}

// 从 metadata 缓存里读这个决策。文件还没被解析时返回 undefined（缓存是懒填的）—— 调用方把它当
// 「没有决策」，等下一次 metadata-cache-changed 事件或轮询 tick 再查，而不是缓存一个错的答案。
export function frontmatterDecisionFor(app: App, file: TFile | null, settings: PluginSettings): FrontmatterDecision | undefined {
	if (!file)
		return undefined;
	const cache = app.metadataCache.getFileCache(file);
	if (!cache)
		return undefined;
	return evaluateFrontmatter(cache.frontmatter, settings);
}
