import { App } from 'obsidian';
import { NavEntry, pruneViewSnapshot } from '@/nav/entry';

// 本机、按库各一份的导航历史持久化：启动时的读取、防抖写入，以及逐条目的形状校验。

// 版本对不上的存档整份丢弃——历史可以不要，不做迁移。它住在这里、和自己描述的那块
// 存储待在一起，不放进去共用的条目词汇表：最近文件列表在自己那份 store 里有自己的
// 版本号，两份列表必须各自能丢，互不牵连。
export const NAV_HISTORY_VERSION = 3;

// 桌面端 localStorage 是所有库共用的（同一个 app 源）；appId 是按库区分的标记。
// 公开类型定义里没有它。
export function navHistoryStorageKey(app: App): string {
	const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
	return `position-restore:nav-history:${appId}`;
}

export function loadNavHistory(app: App): { entries: NavEntry[]; index: number } {
	try {
		const raw = window.localStorage.getItem(navHistoryStorageKey(app));
		if (!raw)
			return { entries: [], index: -1 };
		const parsed = JSON.parse(raw) as { v?: unknown; entries?: unknown; index?: unknown };
		// 版本闸门：没有版本号的、或来路不明的存档整份丢弃。格式一改就升
		// NAV_HISTORY_VERSION。
		if (parsed.v !== NAV_HISTORY_VERSION)
			return { entries: [], index: -1 };
		const entries = Array.isArray(parsed.entries)
			? parsed.entries.filter((e): e is NavEntry => isNavEntry(e))
			: [];
		// 视图条目「自称」的东西——state、名字、图标——会被读回去重放、也会进 DOM，而手工
		// 改过、同步下来或被截断的数据什么都能塞进来。不像样的字段丢弃，但「条目」留着：
		// 三者都有可用的兜底（视图按默认值重建、行印它自己的视图类型），所以坏字段丢的是一个
		// 细节，绝不是那个地点。
		for (const entry of entries)
			pruneViewSnapshot(entry);
		// 必须是在范围内的整数：栈用 `entries.length = index + 1` 截断自己，混进来的小数
		// 下标会让下一次 push 变成 `RangeError: Invalid array length`。
		const index = typeof parsed.index === 'number' && Number.isInteger(parsed.index)
			&& parsed.index >= -1 && parsed.index < entries.length
			? parsed.index
			: entries.length - 1;
		return { entries, index };
	} catch (e) {
		console.error('Position Restore: can not read navigation history:', e);
		return { entries: [], index: -1 };
	}
}

// 逐条目的形状校验（存储里可能是手工改过或截断的数据）：先看 kind 标签，再看那一型
// 必填的字段——没标签的、垃圾的条目丢出去，而不是靠字段碰巧对上来蒙混过关。`t` 也是
// 必填：面板会给每一行标相对时间，没盖时间戳的条目就是垃圾。
export function isNavEntry(e: unknown): e is NavEntry {
	if (!e || typeof e !== 'object')
		return false;
	const entry = e as Record<string, unknown>;
	const str = (v: unknown): v is string => typeof v === 'string' && !!v;
	if (!str(entry.leafId) || typeof entry.t !== 'number')
		return false;
	switch (entry.kind) {
		case 'view':
			return str(entry.viewType);
		case 'jump':
			return str(entry.path) && str(entry.key);
		case 'teleport':
			return str(entry.path) && typeof entry.line === 'number';
		case 'visit':
			return str(entry.path);
		default:
			return false;
	}
}

export function serializeNavHistory(entries: NavEntry[], index: number): string {
	// 步把落点的文字留下的唯一一处：那是最近文件列表的引文，而步是按「位置」恢复的，
	// 一个字都不读。用解构摘掉、不用 delete——`delete` 会把对象打成字典模式，下面
	// stringify 多花的比省下的字节还多。别的都不剥：记录带的戳（`time`）是位置 store
	// 盖的，这份历史从不经过那里。
	const steps = entries.map(e => {
		if (e.kind === 'view' || !e.st)
			return e;
		const { context, ...st } = e.st;
		return { ...e, st };
	});
	// entries 就是一个普通对象组成的普通数组——原样就是 JSON 安全的。
	return JSON.stringify({ v: NAV_HISTORY_VERSION, entries: steps, index });
}

// 存档与 `previous` 逐字节相同时不写——这个去重让 5s 一轮的 flush 在什么都没动时只
// 花一次 stringify。返回现在盘上的存档，由「调用方」持有并回传：去重状态属于这份
// 历史的持有者（每个插件实例一份）。放在这里会被页面里每个实例共用——第二个库会继承
// 第一个的存档，跳过它该写的那一次。
// 写失败原样返回 `previous`，下一轮再试。
export function persistNavHistory(
	app: App,
	entries: NavEntry[],
	index: number,
	previous: string,
): string {
	const serialized = serializeNavHistory(entries, index);
	if (serialized === previous)
		return previous;
	try {
		window.localStorage.setItem(navHistoryStorageKey(app), serialized);
		return serialized;
	} catch (e) {
		console.error('Position Restore: can not persist navigation history:', e);
		return previous;
	}
}
