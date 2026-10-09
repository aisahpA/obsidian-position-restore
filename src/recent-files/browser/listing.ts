// 列表的纯记账：过滤后的记录怎么归成行，以及搜索框保留哪些。无 DOM —— 搜索框单靠这些谓词
// 就能测试。

import { NavEntry, navGroupKey } from '@/nav/entry';
import { HeadingRef } from '@/shared/headings';
import { NavEntryDescription, baseName, viewName } from './model';
import type { FileNames } from './reads';

// 列表上的**一行**：一篇笔记（或一个视图）。一条记录就是一行 —— 这正是「一篇被打开十次的
// 笔记是一行」的原因 —— 而一行点击下去是普通打开：落在哪儿由位置数据库回答，与在文件浏览器
// 里点它完全一样。
//
// 一份**视图**记录是它自己的一行、没有 path。
export interface NavFileGroup {
	// 没有 path 的组用 NO_PATH，它不可能与一个真实 path 撞上。
	path: string;
	// 这一行的**身份**（nav/entry.ts 的 navGroupKey）：它的 path，或对没有 path 的那一行的视图类型。
	// 带着它是因为没有 path 的那一行，其 key 无法从 `path` 复原，而一个持有列表顺序的调用方
	// 没有别的东西可稳定地持 —— 下标是列表当前的形态。
	key: string;
	// 托着这一行的那条记录在 `entries` 里的下标 —— 也就是它的新鲜度、它的 leaf、它打印的
	// 那一份。一个 key 只可能出现一条（见 NavPlaces.remember 的去重），所以这就是**那**一条。
	rep: number;
	// 读者**此刻**是否在这一行上。这不是一个排序事实：无论读者站在什么里，列表都按新鲜度
	// 排序，所以这只说明把标记画在哪儿。
	current: boolean;
}

// 一个没有 path 的行（视图）所携带的 path：给它一个，就会让它与同名的笔记合并。
export const NO_PATH = '';

// 过滤后的记录，每篇笔记一行。**行**按它们那条记录的新鲜度排出 —— 最**新**的在前 ——
// 而这正是列表本来的次序（见 NavPlaces：被碰过的行移到末尾），所以这份顺序与 store
// 自己的顺序是同一个答案的两种问法。
//
// `keep` 施加那个过滤器，所以被丢掉的记录，它的笔记也可能随之消失。
export function groupByFile(
	entries: NavEntry[],
	currentIndex: number,
	keep: (index: number) => boolean = () => true,
	// 把列表按行顺序固定在哪个顺序，按 key；undefined 表示按新鲜度排序。传了它的调用方是在说
	// 「读者**正在用**这份列表」。用 key 而不是下标，因为行顺序每次都是重新推导的。
	order?: readonly string[],
): NavFileGroup[] {
	const groups = new Map<string, NavFileGroup>();
	const open = (entry: NavEntry, index: number): NavFileGroup => {
		const key = navGroupKey(entry);
		const group: NavFileGroup = {
			path: entry.kind === 'view' ? NO_PATH : entry.path,
			key,
			rep: index,
			current: index === currentIndex,
		};
		groups.set(key, group);
		return group;
	};
	// 反向顺序：一篇笔记第一次被看到时，看到的就是它**最新**的那条记录，而 Map 的插入顺序
	// 恰好把这一点保留下来作为行的顺序。**当前**记录与其余的一起被算进去。
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!keep(i))
			continue;
		const entry = entries[i];
		if (!groups.has(navGroupKey(entry)))
			open(entry, i);
	}
	const out = Array.from(groups.values());
	if (order) {
		// 按住不动。这个顺序从没听说过的行，是自它被拍下之后才出现的，所以按新鲜度它们是
		// 最新的：它们取得 -1 的排名、落在最前面，并在彼此之间保持自己的新鲜度顺序
		// （排序是稳定的）。
		const rank = new Map(order.map((k, i): [string, number] => [k, i]));
		out.sort((a, b) => (rank.get(a.key) ?? -1) - (rank.get(b.key) ?? -1));
	}
	return out;
}

// 搜索框读取查询的方式：每一段空白一个 token，转小写，空串丢掉。两个调用方、同一个切法 ——
// 决定哪些留下的过滤器，以及说出查询命中了**哪一行**的那个 —— 因为一行若用一个与过滤器
// 不同的「词」概念来回答「我为什么在这份列表上」，回答的就是一个读者没问的问题。
export function queryTokens(query: string): string[] {
	return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// 纯过滤谓词：每个 token 都必须（不区分大小写地）出现在条目可搜索的文字里某个地方。
// 两个来源，在这里合成，因为只有调用方两者都认识：条目**自己**的文字（navSearchText），
// 以及 `extra`，即调用方从 **vault** 派生的一切 —— 文件的其它名字，以及**该文件的全部标题**。
//
// 「一次匹配能命中的一切都在行上」**不是**规则：一次命中是**读者**可能写过的、关于那个文件的
// 文字，而这正是那些额外来源的共同点。别名是最清楚的一例 —— 用一个读者隐约记得的名字
// 找到一篇笔记，就是搜索框在这里的全部理由。
//
// `outline` 是第二例，但它**不**靠一句 tooltip 自证：命中的那些小节由调用方**各自画成一行**
// （见 matchedHeadings 与 list.ts 的 headingRow）。所以这里只有一件事被决定 —— 这一行进不
// 进得来 —— 而它凭什么进得来，由画出来的那些行自己说。
export function matchesNavFilter(
	entry: NavEntry,
	query: string,
	extra?: string,
	// 「这一篇**所有**的小节」—— 由调用方从 metadataCache 现查（见 reads.ts 的
	// headingsFor），所以它永远是最新的，且体积与笔记长度无关。**不在** navSearchText
	// 里：它要 vault 才能回答，而那个纯函数只看得见条目自己。
	outline?: string,
): boolean {
	const tokens = queryTokens(query);
	if (tokens.length === 0)
		return true;
	const hay = `${navSearchText(entry)} ${extra ?? ''} ${outline ?? ''}`.toLowerCase();
	return tokens.every(tok => hay.includes(tok));
}

// 一行**凭什么在列表上**。
//
// 判据住在这里、不在画它的那个类里，因为「什么算一行」与「搜索面」是同一个问题的两半：
// 一个被搜到、却不画出来的东西，正是这份列表不做的事（见 matchedHeadings）。这**四处**
// 合起来是唯一一处判据 —— 别在别处再写一份。
//
// 它们每一个都要 vault 才能回答，所以调用方把它要问的那几个读取器一并交下来。**每次
// 重画现取**：`entries` 会被重新指向（常驻面板靠这个刷新），而缓存一份会让判据答的是
// 上一次重画的那份列表。
export interface RowFacts {
	// 行的绘制所依据的历史，作为一个快照。
	entries: NavEntry[];
	// 一个条目的展示碎片（由调用方缓存）。
	describe: (rep: number) => NavEntryDescription;
	// 文件的**其它**名字：可搜索、打印在行的 tooltip 上、别处一概不出现。`printed` 是
	// 该行展示的名字，它不属于它们之中（见 FileNames）。
	otherNames: (path: string, printed?: string) => FileNames;
	// 这一篇笔记的**各个**标题，文档顺序。现查，所以它永远是最新的，而体积与笔记长度无关。
	headingsFor: (path: string) => HeadingRef[] | undefined;
	// 一篇笔记是否仍在磁盘上。
	noteExists: (path: string) => boolean;
	// 搜索框是否把各篇笔记的小节标题也算进搜索面 —— 也就是是否画大纲行。
	outlineSearch: () => boolean;
}

// 究竟**什么**可以被列出：一个文件没了的行会在归组**之前**被丢掉 —— 没有行、没有大纲行、
// 没有任何「你在这里」会为一个打不开的名字而立。一个**视图**行被豁免（没有文件会没）。
export function rowListed(facts: RowFacts, i: number): boolean {
	const entry = facts.entries[i];
	return entry.kind === 'view' || facts.noteExists(entry.path);
}

// 一行**打印**的东西里，搜索框可以问的那些（见 matchesNavFilter 的 `extra`）。
export function rowPrinted(facts: RowFacts, i: number): string {
	const entry = facts.entries[i];
	const d = facts.describe(i);
	// 文件的其它名字走 `extra` 通道（见 matchesNavFilter）；按**路径**读，所以一篇笔记的
	// 每一行携带同样的名字 —— 两类都带，因为笔记自称的东西与它应答的名字一样值得输入。
	const other = entry.kind === 'view'
		? undefined
		: facts.otherNames(entry.path, d.name);
	const aka = other ? [other.frontTitle ?? '', ...other.aliases] : [];
	// **打印出来的名字**也进去：一篇读者用它的 frontmatter 标题来称呼的笔记，就用那个
	// 标题来搜索。（文件自己的名字已经在稻草堆里 —— 见 navSearchText。）
	return `${d.name ?? ''} ${aka.join(' ')}`;
}

// **这一篇的所有小节**，每行一个（`\n` 分隔，因为标题本身可以含任何字符而这只是一次子串
// 匹配），按文档顺序。
//
// 从不存：现查（`headingsFor`），所以它永远是最新的，而体积与笔记长度无关。一篇没有标题
// 的笔记、以及无路径的视图，都没有 —— 那是诚实的「没有」而不是空串（空串会让每个查询都
// 命中它）。而开关关掉时，它对每一行都是「没有」：那时搜索框不认标题，也不画大纲行 ——
// 「搜到了却不说」是这份列表不做的事。
export function rowOutline(facts: RowFacts, i: number): string | undefined {
	if (!facts.outlineSearch())
		return undefined;
	const entry = facts.entries[i];
	if (entry.kind === 'view')
		return undefined;
	const titles = facts.headingsFor(entry.path);
	return titles?.length ? titles.map(h => h.heading).join('\n') : undefined;
}

// 查询留下的那些行。一行被问的是**它自己**打印的东西，加上从 **vault** 派生的一切
// （文件的其它名字、**该文件的所有小节**）。
//
// 两样东西**不被问及**，且出于同一个理由：两者都不是关于**记录**的事实，而是关于读者
// 碰巧在哪。坐标（"L412"）是位置数据库的，在笔记被阅读时被重写；一个行号所处的链是从
// 那个坐标读出的，所以它跟着它走。一行此刻答得出一个标题、下一刻答不出，是一个搜索框
// 不能信赖的行。
export function rowKept(facts: RowFacts, i: number, query: string): boolean {
	if (!rowListed(facts, i))
		return false;
	if (!query)
		return true;
	return matchesNavFilter(
		facts.entries[i], query, rowPrinted(facts, i), rowOutline(facts, i),
	);
}

// 查询命中的**那些**小节 —— 「这一篇里有个叫『定价』的小节」这句话的答案，按文档顺序。
// 调用方把它们各画成一行，所以这里的次序就是读者看见的次序：一篇笔记里的小节按它们在那
// 篇笔记里的先后排出来，与它们被访问的先后无关。
//
// **截断是调用方的事**（`limit` 可选，省掉就是全部交出来）：一篇笔记画不下那么多行是
// 列表的取舍，而那个取舍还欠一句「截掉了几个」（见 list.ts 的 hitsFor 与 hiddenHits）——
// 那是只有知道**全部**命中的一方才说得出的数。
//
// 谁算命中：**全部** token 都出现在同一个标题里的那些。一个都没这么命中时，才退到
// 携带**第一个** token 的标题 —— 多个词可能分散在不同标题里，而它们仍然是同一个查询。
// 两档不混：一个既给出「面板设计」又给出「设计原则」的列表，答的是两个不同的问题。
//
// 答空的几种情形，调用方都必须**什么都不画**：一行可能靠它的名字、path 或别名匹配上，
// 而那些每一个都已经印在行上 —— 再说一遍是噪音。最要紧的一种是：这一行真的被某个标题
// 捞出来了、而那些标题我们没在同一帧里拿到（见 reads.ts 的异步文本兜底）—— 那时保持
// 沉默比编一个强。
export function matchedHeadings(
	headings: readonly HeadingRef[] | undefined,
	query: string,
	limit?: number,
): HeadingRef[] {
	const tokens = queryTokens(query);
	if (!headings?.length || !tokens.length || (limit !== undefined && limit <= 0))
		return [];
	const loose: HeadingRef[] = [];
	const strict: HeadingRef[] = [];
	for (const ref of headings) {
		const hay = ref.heading.toLowerCase();
		if (!hay)
			continue;
		if (tokens.every(tok => hay.includes(tok)))
			strict.push(ref);
		else if (hay.includes(tokens[0]))
			loose.push(ref);
	}
	// 两档不混（见上），而截断发生在**胜出的那一档上**，与底下那一档无关。
	const hits = strict.length ? strict : loose;
	return limit === undefined ? hits : hits.slice(0, limit);
}

// 条目自己的可搜索文字：**只有**名字与 path（一个视图是它的类型与名字）。全部并成一个
// 字符串，所以各部分之间的顺序不携带任何信息。
//
// **两个字段刻意不在这里，而它们的理由是同一条**：命中必须能解释自己。
//
// `st.anchor`（重映射锚点）记的是采集那一刻**视口顶行**的文本。它随窗口高度与滚动位置
// 变（同一个落点换台设备就换一句），且常落在标题**之上**、是上一段的尾巴 ⇒ 它答的不是
// 「这个地方叫什么」；它也从来没有被显示在任何地方，所以靠它命中的行答不出自己在列表上
// 为什么。作为**字段**它留着 —— 文本变动后靠它把行号重新找回来是恢复路径的事
// （见 ephemeral.ts 的 remapAnchorLine）。
//
// 落点下方那几行正文（曾叫 `st.context`，2026-10-03 撤）在一个**更小的副本**上犯同样的
// 错：它随笔记被读而一直过期，而它挡在更好的东西前面 —— 无词边界的子串匹配进主过滤路径
// 就是一台没有排名的噪音发生器（`pro` 命中 `approve`、单字中文命中一切），而按内容找一篇
// 笔记这件事，vault 自己的全文搜索（有排名、有上下文、看得见全 vault）赢得这个面板。
//
// 至于**「这篇笔记里有个叫『定价』的小节」**，它不需要快照：各标题从 metadataCache 现查
// 就行（见 reads.ts 的 headingsFor），永远是最新的，且体积与笔记长度无关。
//
// 一次跳转的 key（大纲点击时是标题的文字）不在这里：这份列表**不持有**跳转记录（见
// places.ts 的降级），所以没有哪一行的可搜索文字会来自那里。
export function navSearchText(entry: NavEntry): string {
	if (entry.kind === 'view')
		return `${entry.viewType} ${viewName(entry)}`;
	return [baseName(entry.path), entry.path].filter(Boolean).join(' ');
}
