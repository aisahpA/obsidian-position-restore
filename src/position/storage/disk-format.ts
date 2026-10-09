import { EphemeralState } from '@/types';

// 位置库文件（默认 position-restore-data.json）的磁盘格式层：字节 ↔ 内存里的
// CursorDatabase。全是纯函数，不碰任何状态 —— 读（database.ts 的 readDb / runMergePass /
// switchDbFile 采纳目标文件）与写（writeDb）两条路都经过这里，好让「文件长什么样」与
// 「什么时候读写它」分开。

export type CursorDatabase = { [file_path: string]: EphemeralState };

// 磁盘上的形态版本；三个都能读，只写 schema 3。只在**形态**变化时升它 —— 加一个可选字段
// 不算升，因为读的时候未知字段会被忽略。文件每次落盘都是整份重写，所以最后写的那个
// writer 拥有它的全部，文件里的版本号保护不了它：一个过期的 writer 连它也一起覆盖掉。
//   schema 1: {"a.md": [scroll, line, ch, toLine, toCh]} —— 数组的**长度**就是类型标签
//             （1 无光标，3 一个点，5 一段选区），这让旧读者没法不误读地新增字段。
//   schema 2: {"schema": 2, "positions": {"a.md": {"s": 120, "c": [l,ch,tl,tc],
//             "t": 1770000000000}}} —— `t` 说这条位置是什么时候记的，正是它来定夺
//               两台设备都持有的同一个键。
//             —— 一条既没有 `s` 也没有 `c` 的记录是墓碑：笔记被访问过、停在顶部，
//               这跟从来没有记录不一样。
//   schema 3: {"schema": 3, "lastPositions": {"a.md": {...}}} —— 与 schema 2 同形状，
//             只把容器键从 `positions` 改名成 `lastPositions`：这个文件将来还要装别的
//             需要同步的数据，各占一个平级键，`lastPositions` 只说它装的是哪一份。
//             读 1/2 都照旧读出、下一次落盘整份写成 3 ⇒ 这一次改名不丢位置。
//             ⚠️ 但 parseDb 只取这个容器、writeDb 又整份重写 ⇒ **别的顶层键读进来就被丢掉**。
//             将来真加平级键（`recentNotes` 之类）之前，得先把这条处理好，否则中间版本
//             一落盘就把它们抹了。
export const SCHEMA_VERSION = 3;

// `s` 的含义和对 EphemeralState.scroll 一样是双重的：markdown 存量化后的顶行行号，
// Bases 视图（唯一另一个可记录的 FileView，由 recordBaseScroll 选择开启 —— pdf/图片/
// canvas 从不记录）存滚动容器的裸 scrollTop。`c` 永远是完整光标，从 from 到 to ——
// 从不按长度打标签，从不残缺。
export interface PositionRecord {
	s?: number;
	c?: number[];
	t?: number;
}

// 当光标就坐在 Obsidian 打开笔记时它会放的地方时，它什么也没说明：没有 frontmatter 的
// 文件是第 0 行，否则是 frontmatter 块**紧接**的那一行 —— 即使它是空行也**就落在**那一行，
// 而这是常见情形（实测一个 vault 里 85% 的笔记那里是空行，10 次未改动过的打开有 10 次
// 落在它上面，没有一次落在第一个非空行）。`defaultLine` 为 undefined = 未知（文件没了、
// metadata 还没解析）—— 那时只有 (0,0) 算数。
export function cursorIsDefault(cursor: EphemeralState['cursor'], defaultLine: number | undefined): boolean {
	if (!cursor)
		return true;
	if (cursor.from.ch !== 0 || cursor.to.ch !== 0 || cursor.from.line !== cursor.to.line)
		return false;
	return cursor.from.line === (defaultLine ?? 0);
}

// 恢复只在 scroll > 0 时才滚，所以非正的 scroll 不存；剩下的就是上面说的墓碑 —— 于是
// 没有 `s` 意味着「在顶部」，不是「未知」。只有 `c` 的记录通常是真实的位置（短笔记的
// 视口装得下，光标落在离它顶部很远的地方）—— 除非那个光标正是上面的「打开默认值」，
// 那是一次仅被打开的笔记留下的东西；那一条写成 `{}`。
export function encodeValue(st: EphemeralState, defaultLine: number | undefined): PositionRecord {
	const rec: PositionRecord = {};
	const scroll = st.scroll ?? 0;
	if (scroll > 0)
		rec.s = scroll;
	const c = st.cursor;
	// 只评判「在顶部」的记录：有 scroll 时，光标原样存下。
	if (c && (scroll > 0 || !cursorIsDefault(c, defaultLine)))
		rec.c = [c.from.line, c.from.ch, c.to.line, c.to.ch];
	if (st.time !== undefined)
		rec.t = st.time;
	return rec;
}

// 未知字段被忽略而不是被拒：更新的插件版本写的文件，仍必须交出它与我们共享的那些位置。
function decodeValue(value: unknown): EphemeralState {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return {};
	const rec = value as { s?: unknown; c?: unknown; t?: unknown };
	const st: EphemeralState = {};

	// 损坏的磁盘数据绝不能把 NaN/undefined 漏进记录：一个非有限的 scroll 会无声地
	// 让恢复失效。
	if (typeof rec.s === 'number' && Number.isFinite(rec.s) && rec.s > 0)
		st.scroll = rec.s;
	if (typeof rec.t === 'number' && Number.isFinite(rec.t))
		st.time = rec.t;

	const c = rec.c;
	if (Array.isArray(c) && c.length >= 4 && c.every((n) => typeof n === 'number' && Number.isFinite(n))) {
		const [fromLine, fromCh, toLine, toCh] = c as number[];
		const from = { line: fromLine, ch: fromCh };
		const to = { line: toLine, ch: toCh };
		if (!cursorIsDefault({ from, to }, undefined))
			st.cursor = { from, to };
	}
	return st;
}

// schema 1：旧插件写的文件 —— 更新之前留下的，或者在另一台还跑着旧版的设备上 ——
// 保持可读。
function decodeArrayValue(value: unknown): EphemeralState {
	if (!Array.isArray(value) || value.some((n) => !Number.isFinite(n)))
		return {};
	const arr = value as number[];
	const st: EphemeralState = {};
	if (arr[0] > 0)
		st.scroll = arr[0];
	if (arr.length === 3) {
		const p = { line: arr[1], ch: arr[2] };
		st.cursor = { from: p, to: p };
	} else if (arr.length >= 5) {
		st.cursor = { from: { line: arr[1], ch: arr[2] }, to: { line: arr[3], ch: arr[4] } };
	}
	return st;
}

// 启动读取与外部变更合并共用。任何不是 JSON 对象的东西都会抛（写了一半、冲突标记、
// 外来文件）：它绝不悄悄变成一个空 db。比我们更新的 schema 照样读 —— 未知字段被忽略
// —— 所以先更新的那台设备不能让文件在这里变得读不了。
// @returns 那些记录，外加写这个文件时用的 schema。
export function parseDb(data: string): { schema: number; db: CursorDatabase } {
	const parsed: unknown = JSON.parse(data);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		throw new Error('database content is not a JSON object');
	const raw = parsed as Record<string, unknown>;

	// 没有编号 schema 就是 schema 之前的平坦表，它的键就是笔记路径本身。从 2 起每个
	// schema 都是「一个容器键装整张表」，只是键名不同，所以更旧的写法在这里逐级回退 ——
	// 一个比我们新的文件也走这条回退（它的容器键还在，未知字段被忽略）。
	const schema = typeof raw.schema === 'number' ? raw.schema : 1;
	let db: CursorDatabase;
	if (schema >= 3)
		db = parseSchema3(raw);
	else if (schema >= 2)
		db = parseSchema2(raw);
	else
		db = parseSchema1(raw);
	return { schema, db };
}

// 不打标签的平坦表：{"a.md": [scroll, line, ch, toLine, toCh]} —— schema 1 只写数组，
// 别的什么都不写。
function parseSchema1(raw: Record<string, unknown>): CursorDatabase {
	const db: CursorDatabase = {};
	for (const key of Object.keys(raw))
		db[key] = decodeArrayValue(raw[key]);
	return db;
}

// schema 2：容器键叫 `positions`。现在只读不写 —— 留着读 beta 通道与 dev 存量文件，
// 它们下一次落盘就整份变成 schema 3。
// {"schema": n, "positions": {"a.md": {...}}} —— 那张表里装的是记录。
function parseSchema2(raw: Record<string, unknown>): CursorDatabase {
	const container = raw.positions;
	if (!container || typeof container !== 'object' || Array.isArray(container))
		throw new Error('database has no position map');
	const map = container as Record<string, unknown>;
	const db: CursorDatabase = {};
	for (const key of Object.keys(map))
		db[key] = decodeValue(map[key]);
	return db;
}

// schema 3：与 schema 2 同形状，容器键改叫 `lastPositions`。与那两个一样，这里是这个
// schema 自己的 parser，不去复用别的 schema 的容器读取 —— 每个 schema 是一段冻结的历史，
// 改一个不该动到另一个。
// {"schema": 3, "lastPositions": {"a.md": {...}}} —— 那张表里装的是记录。
function parseSchema3(raw: Record<string, unknown>): CursorDatabase {
	const container = raw.lastPositions;
	if (!container || typeof container !== 'object' || Array.isArray(container))
		throw new Error('database has no lastPositions map');
	const map = container as Record<string, unknown>;
	const db: CursorDatabase = {};
	for (const key of Object.keys(map))
		db[key] = decodeValue(map[key]);
	return db;
}

// 采纳目标文件时的严格形态检查：只接受一个位置 db —— schema 3、schema 2，或 schema 之前
// 的平坦表 —— 且它的每个键都是可记录的笔记路径（.md / .base），恰好是 writeDb 会写出的东西
// （包括空的 `{}`）。这个键检查正是拒掉一个碰巧装着数字数组（图表序列、向量）的外来
// JSON 的地方；没有它，这样的文件会被采纳，而真文件被删掉。
// @returns 解析出的 db；内容不是位置 db 时为 null。
export function parseDbStrict(data: string): CursorDatabase | null {
	let parsed: { schema: number; db: CursorDatabase };
	try {
		parsed = parseDb(data);
	} catch {
		return null;
	}
	for (const key of Object.keys(parsed.db)) {
		const lower = key.toLowerCase();
		if (!lower.endsWith('.md') && !lower.endsWith('.base'))
			return null;
	}
	return parsed.db;
}
