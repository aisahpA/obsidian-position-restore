import { App, TFile } from 'obsidian';

// 「prop[: value]」这条 frontmatter 规则 —— 一种写法，被两个能让读者一次性排除一整类笔记的
// 功能共用：位置记录规则（position/policy/frontmatter.ts）与最近文件列表（recent-files/places.ts）。
// 它独立于两者之外，是因为「一条规则到底什么意思」不属于任何一个功能：`status` 命中所有带这个
// 属性的笔记（不管值是什么），`status: archived` 只命中值恰好相等的；而且在一个设置页填下的
// 规则，到另一个设置页必须是同一个意思。空列表 = 没有规则。
//
// 两个读取方都从内存里的 metadata cache 取 frontmatter —— 绝不去读文件文本 —— 所以问一条规则
// 只花一次 Map 查找。正因为这么便宜，位置轮询和每一次导航才敢随便问。

// 布尔值接受 yes/no/on/off 这些别名；数字与字符串不区分大小写地比；数组任一元素命中即可。
function valueMatches(cached: unknown, expected: string): boolean {
	const exp = expected.trim().toLowerCase();
	if (Array.isArray(cached))
		return cached.some((v) => valueMatches(v, expected));
	if (typeof cached === 'boolean') {
		const aliases: Record<string, boolean> = { true: true, false: false, yes: true, no: false, on: true, off: false };
		return exp in aliases && aliases[exp] === cached;
	}
	if (cached === null || typeof cached === 'object')
		return false;
	if (typeof cached !== 'string' && typeof cached !== 'number')
		return false;
	return cached.toString().toLowerCase() === exp;
}

// 通常只有 0~3 条；直接循环比建一个 Set 划算。
export function frontmatterRuleMatches(frontmatter: unknown, entries: readonly string[]): boolean {
	if (!frontmatter || typeof frontmatter !== 'object')
		return false;
	const obj = frontmatter as Record<string, unknown>;
	for (const entry of entries) {
		if (!entry)
			continue;
		const sep = entry.indexOf(':');
		const name = (sep === -1 ? entry : entry.slice(0, sep)).trim();
		const expected = sep === -1 ? '' : entry.slice(sep + 1).trim();
		// 只认自有属性：`in` 会顺着原型链往上走，而「只写名字」的形式根本不看值 ——
		// 一旦 `toString` / `constructor` 混进这条规则，就会命中每一篇带 frontmatter 的笔记。
		if (!name || !Object.prototype.hasOwnProperty.call(obj, name))
			continue;
		if (expected === '' || valueMatches(obj[name], expected))
			return true;
	}
	return false;
}

// 路径上没有文件、或还没解析完时返回 undefined —— 缓存是懒填充的。调用方应当把它看成
// 「现在还没有答案」继续走，而不是看成「该排除」的决定：从一个没解析完的文件里猜出来的答案，
// 下一次访问很可能就把它推翻了。
export function frontmatterOfPath(app: App, path: string): Record<string, unknown> | undefined {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile))
		return undefined;
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter;
}
