import { App } from 'obsidian';
import { NavEntry, pruneViewSnapshot } from '@/nav/entry';

// 给**最近文件**列表用的、设备本地的、按 vault 分的持久化 —— 模块形态与栈的 store.ts
// 一样，但有意与它分开：栈是个遍历装置，只活几分钟、每次导航都写；而这是一个地点列表，
// 活几个月、只在某个地点被碰过时才写。两者合用一份 blob 会让每次写入都为对方的体量买单。

// 这份列表自己的格式版本，摆在它所描述的 blob 旁边：两者是不同的东西、以不同的节奏写，
// 而且必须能丢掉一个而不动另一个。**形态**变化时升它（2 加了钉选列表）——
// 来自别的版本的 blob 整份丢掉、而不是迁移，这负担得起，因为列表是可丢弃的：
// 一个空的会自己重新填满。
export const RECENT_PLACES_VERSION = 2;

// 桌面的 localStorage 跨 vault 共享（同一个 app 源）；appId 是按 vault 区分的依据。
// 不在公开类型定义里。键是它自己的，所以两份列表可以各自独立地丢掉。
export function navPlacesStorageKey(app: App): string {
	const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
	return `position-restore:nav-recent:${appId}`;
}

// blob 装的东西：地点，以及读者钉选过的行（见 NavPlaces.pinned）。两者作为一对来读，
// 因为它们是一份列表 —— 一个地点没了的钉选，是个没东西可展示的钉选，
// 而把它们放进分开的键会让两者漂开。
export interface NavPlacesBlob {
	entries: NavEntry[];
	pinned: string[];
}

// 最旧的在前 —— 数组的顺序**就是** MRU 顺序（被碰过的地点会被移到末尾，见 places.ts）。
export function loadNavPlaces(app: App): NavPlacesBlob {
	try {
		const raw = window.localStorage.getItem(navPlacesStorageKey(app));
		if (!raw)
			return { entries: [], pinned: [] };
		const parsed = JSON.parse(raw) as { v?: unknown; places?: unknown; pinned?: unknown };
		// 版本闸门：一个尚未带版本、或来自别处的 blob 整份丢掉。列表是可丢弃的 ——
		// 一个空的会自己重新填满 —— 所以什么都不迁移。
		if (parsed.v !== RECENT_PLACES_VERSION)
			return { entries: [], pinned: [] };
		const places = Array.isArray(parsed.places)
			? parsed.places.filter((e): e is NavEntry => isPlaceEntry(e))
			: [];
		// 一个视图地点自己的快照（state / label / icon）会被重放并绘制，
		// 而这是任何东西都可能写过的存储：名不副实的字段丢掉，地点本身留下。
		for (const place of places)
			pruneViewSnapshot(place);
		return { entries: places, pinned: readPinned(parsed.pinned) };
	} catch (e) {
		console.error('Position Restore: can not read the recent files list:', e);
		return { entries: [], pinned: [] };
	}
}

// 一个钉选是一个**行**身份（见 navGroupKey）。是过滤、不是校验：这张钉选列表是读者
// 自己做的笔记，所以一个不是字符串的名字从来就不是钉选，而一个行没了的钉选只是累赘，
// 不是一个值得为它丢掉整份列表的错误。
function readPinned(raw: unknown): string[] {
	return Array.isArray(raw)
		? raw.filter((k): k is string => typeof k === 'string' && !!k)
		: [];
}

// 栈的逐条目检查，加上这份列表多出来的一条不变量 —— 一个**推断**出来的步
// （NavTeleport）永远不是地点。查的是那个标签、不是一个属性，所以一次 teleport
// 不可能凑巧溜进来。
export function isPlaceEntry(e: unknown): e is NavEntry {
	if (!e || typeof e !== 'object')
		return false;
	const kind = (e as { kind?: unknown }).kind;
	if (kind !== 'visit' && kind !== 'jump' && kind !== 'view')
		return false;
	return isPlaceShape(e);
}

// 拆出来是为了让上面的 kind 检查保持可读。留在这里、而不从 store.ts 导出：
// 两份列表必须能自由地分化，而这里是唯一做决定的地方。
function isPlaceShape(e: unknown): e is NavEntry {
	const entry = e as Record<string, unknown>;
	const str = (v: unknown): v is string => typeof v === 'string' && !!v;
	if (!str(entry.leafId) || typeof entry.t !== 'number')
		return false;
	if (entry.kind === 'view')
		return str(entry.viewType);
	if (entry.kind === 'jump')
		return str(entry.path) && str(entry.key);
	return str(entry.path);
}

export function serializeNavPlaces(entries: NavEntry[], pinned: readonly string[]): string {
	// entries 是一个装着普通对象的普通数组 —— 原样就是 JSON 安全的。
	return JSON.stringify({ v: RECENT_PLACES_VERSION, places: entries, pinned });
}

// 除非这份 blob 与 `previous` 逐字节相同，否则写入列表（与 store.ts 同样的
// 「拥有者负责去重」契约：那份状态属于拥有这份列表的那一个实例）。
export function persistNavPlaces(
	app: App,
	entries: NavEntry[],
	pinned: readonly string[],
	previous: string,
): string {
	const serialized = serializeNavPlaces(entries, pinned);
	if (serialized === previous)
		return previous;
	try {
		window.localStorage.setItem(navPlacesStorageKey(app), serialized);
		return serialized;
	} catch (e) {
		console.error('Position Restore: can not persist the recent files list:', e);
		return previous;
	}
}
