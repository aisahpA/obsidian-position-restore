// 列表的纯记账：过滤后的步怎么归成笔记，以及搜索框保留哪些。无 DOM —— 搜索框单靠这些谓词
// 就能测试。

import { isCallerKey, NavEntry, navGroupKey } from '@/nav/entry';
import { baseName, viewName } from './model';

// 列表上的一个**文件**：那篇笔记，以及落在它里面的那些步（按行、升序）。每篇笔记一个 ——
// 这正是「一篇被打开十次的笔记是一行」的原因 —— 而在 'all' 设置下，它的落点显示在它下面。
// 一个没有 path 的视图步是它自己的一组、没有 path。
//
// 一篇笔记下的落点是**地点**，不是步（见 landingKey）：一篇被五次回到同一行的笔记只有一个
// 可挑的行。每个地点都是一行 —— 一个离另一个十行的地点，是一个不同的可去之处。
export interface NavFileGroup {
	// 没有 path 的组用 NO_PATH，它不可能与一个真实 path 撞上。
	path: string;
	// 这一组的**身份**（nav/entry.ts 的 navGroupKey）：它的 path，或对没有 path 的那一组的视图类型。
	// 带着它是因为没有 path 的组，其 key 无法从 `path` 复原，而一个持有列表顺序的调用方
	// 没有别的东西可稳定地持 —— 下标是列表当前的形态。
	key: string;
	// 这篇笔记各落点在栈里的下标，笔记顶部的在前。每个不同的行一个，代表落在它上面的**最新**
	// 那一步 —— 或者，在当前条目共用该行时，代表读者自己的那一步（见 currentRep）。
	// 每一个都是一个**目的地**：文件没了的笔记根本不被归组。
	indices: number[];
	// 这篇笔记**自己**的记录 —— 代表文件本身、而不是它里面某个地点的那个地点，也是以普通方式
	// 打开文件的那些行。有意**不**是 `indices` 之一：一篇笔记不是它自己底下的一个落点。
	anchor?: number;
	// 当前条目自己所在的组。这不是一个排序事实：无论读者站在什么里，列表都按新鲜度排序，
	// 所以这只说明把标记画在哪儿。
	current: boolean;
	// 托着**当前**条目的那个落点 —— 带着「你在这里」小点的那些行。读者在笔记里、但不在任何一个
	// 已列出的落点上时为 undefined：那时他们自己的记录就是**锚点**。
	currentRep?: number;
}

// 列表显示一篇笔记的多少。这里再导出，因为浏览器的各模块从这儿取它（它被存进的那个设置记录
// 在 types.ts）。
export type { LandingsMode } from '@/types';

// 一个没有 path 的组（视图）所携带的 path：给它一个，就会让它与同名的笔记合并。
export const NO_PATH = '';

// 让两步成为**一个**落点的键：它们落在的那一行。这一步是怎么做的不是「它在哪」的一部分，
// 所以一篇被五条不同路线五次回到 L412 的笔记只持有一个地点。
//
// 一个没有记录行号的步得到那一个 `none` 键：一个没有坐标的文件 —— `.base` 视图、PDF、图片 ——
// 只有一个可待的地方。一个**视图**步得到那一个常量键。
const NO_LINE = 'none';

function landingKey(entry: NavEntry, line: number | undefined): string {
	if (entry.kind === 'view')
		return 'view';
	return line === undefined ? NO_LINE : `L${line}`;
}

// 过滤后的步，每篇笔记一组。组按它们**最新**那一步的新鲜度排出；**组内**的顺序是笔记自己的：
// 按行、升序，每个不同的行都是它自己的一行。`keep` 施加那个过滤器，所以被丢掉的步，
// 它的笔记也可能随之消失。
//
// `lineOf` 解答一个步落在哪一行，是**注入**的，因为一行显示的行号不总是条目自己的：
// 一个在引文块被拍下之前记录的步，会退回到文件保存的位置。调用方传什么，就必须是这一行
// 显示的那个数字，否则列表会把它读者仍能分辨的步给并掉。
//
// 当前条目在顺序上没有特殊位置：它被算在它新鲜度所属的地方，小点画在托着它的那一行上。
// 把它抬到顶部，会在那只点过一行的手底下把列表重新排列。
export function groupByFile(
	entries: NavEntry[],
	currentIndex: number,
	keep: (index: number) => boolean = () => true,
	lineOf: (index: number) => number | undefined = () => undefined,
	// 把列表按组顺序固定在哪个顺序，按 key；undefined 表示按新鲜度排序。传了它的调用方是在说
	// 「读者**正在用**这份列表」。用 key 而不是下标，因为组顺序每次都是重新推导的。
	order?: readonly string[],
): NavFileGroup[] {
	const groups = new Map<string, NavFileGroup>();
	const seen = new Map<string, Map<string, number>>();
	// 一篇笔记的各不相同落点，按反向扫描遇到它们的顺序 —— 最新的步在前，这正是「代表每个行的
	// 那个步」据以被选出的顺序。
	const found = new Map<string, { line: number | undefined; index: number }[]>();
	const open = (entry: NavEntry): NavFileGroup => {
		const key = navGroupKey(entry);
		let group = groups.get(key);
		if (!group) {
			group = {
				path: entry.kind === 'view' ? NO_PATH : entry.path,
				key,
				indices: [],
				current: false,
			};
			groups.set(key, group);
			seen.set(key, new Map());
			found.set(key, []);
		}
		return group;
	};
	// 反向顺序：一篇笔记第一次被看到时，看到的就是它存活下来的最新那一步，而 Map 的插入顺序
	// 恰好把这一点保留下来作为组的顺序。**当前**条目与其余的一起被算进去 —— 列表标记的是
	// 托着它的那个落点，而不是把它排除在外。
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!keep(i))
			continue;
		const entry = entries[i];
		const key = navGroupKey(entry);
		const group = open(entry);
		// 一个 visit 或 view 点名的**是文件**、而不是它里面的某个地点，所以它成为**锚点**、
		// 不添加任何落点：一个代表文件自己记录的行，会是一个点了也看不出什么的行。
		if (entry.kind === 'visit' || entry.kind === 'view') {
			if (group.anchor === undefined)
				group.anchor = i;
			if (i === currentIndex)
				group.current = true;
			continue;
		}
		const line = lineOf(i);
		const landing = landingKey(entry, line);
		const at = seen.get(key)?.get(landing);
		const landings = found.get(key)!;
		if (at !== undefined) {
			// 已经在列表上了：这一步不添加目的地，但当它是当前条目时，它仍是读者**正踩在**上面的步。
			if (i === currentIndex) {
				landings[at].index = i;
				group.current = true;
			}
			continue;
		}
		seen.get(key)?.set(landing, landings.length);
		landings.push({ line, index: i });
		if (i === currentIndex)
			group.current = true;
	}
	// 在一篇笔记下，各行按**行号**、升序排出来 —— 也就是它们作为地点身处的那份文档的顺序。
	// 笔记之间由新鲜度决定（「我刚才在哪儿」），但在笔记内部，从地点被访问的顺序里学不到什么。
	// 一个没有记录行号的步，把它的新鲜度位置留在**最后**。
	//
	// 代表某一行的步，是落在那里**最新**的那一步；或在当前条目共用它时，是读者自己的那一步 ——
	// 所以一行显示的行号**就是**它点击时落到的行。
	const rank = (line: number | undefined) => line === undefined ? Number.MAX_SAFE_INTEGER : line;
	for (const [key, group] of groups) {
		const landings = found.get(key)!;
		landings.sort((a, b) => rank(a.line) - rank(b.line));
		group.indices = landings.map(l => l.index);
		if (landings.some(l => l.index === currentIndex))
			group.currentRep = currentIndex;
	}
	// 当前这篇笔记与其它一样，经由同一次扫描到达列表：它自己的步必须熬过 `keep` ——
	// 一篇被查询丢掉的笔记不归这份列表管，无论它是不是当前的。
	const current = entries[currentIndex];
	if (current && keep(currentIndex) && !groups.has(navGroupKey(current)))
		open(current).current = true;
	const out = Array.from(groups.values());
	// `out` **已经**是新鲜度顺序：反向扫描是在一篇笔记最新那一步处插入它的组，而 Map 保留插入顺序。
	if (order) {
		// 按住不动。这个顺序从没听说过的组，是自它被拍下之后才出现的，所以按新鲜度它们是最新的：
		// 它们取得 -1 的排名、落在最前面，并在彼此之间保持自己的新鲜度顺序（排序是稳定的）。
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
// `outline` 是第二例，而它是**唯一一种**能在一行不印任何东西的情况下自证的一类：命中的是
// 「这篇笔记里有个叫『定价』的小节」，而那一句由调用方在该行的 tooltip 上说出来（见
// matchedHeading 与 list.ts 的 fileRow）。落点行**不给**它这个 —— 那一行印的已经是它自己
// 那一节的链，再加全部标题只会让「我这一行是哪儿」变得答不出来。
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

// 查询命中的是**哪一个**标题（`outline` 里那些里的一个）—— 也就是「这一篇里有个叫
// 『定价』的小节」这句话的答案。第一条携带**全部** token 的标题；没有的话，就是第一条
// 携带**第一个** token 的标题（多个词可能分散在不同标题里，而它们仍然是同一个查询）。
//
// 回答 undefined 的那几种情形，调用方都必须**什么都不说**：一行可能靠它的名字、path、
// 别名或它所在的那一节匹配上，而这些每一个都已经印在行上或一次悬停就能看到 —— 再说一遍
// 是噪音。而这里答不出的最要紧的一种是：一行真的被某个标题捞出来了、而那个标题我们没在
// 同一帧里拿到（见 reads.ts 的异步文本兜底）—— 那时保持沉默比编一句强。
export function matchedHeading(outline: string | undefined, query: string): string | undefined {
	const tokens = queryTokens(query);
	if (!outline || !tokens.length)
		return undefined;
	let loose: string | undefined;
	for (const title of outline.split('\n')) {
		const hay = title.toLowerCase();
		if (!hay)
			continue;
		if (tokens.every(tok => hay.includes(tok)))
			return title;
		if (loose === undefined && hay.includes(tokens[0]))
			loose = title;
	}
	return loose;
}

// 条目自己的可搜索文字：**只有**名字、path，以及跳转自己的 key（大纲点击时是标题的
// 文字，锚点链接时是读者选的目标）。全部并成一个字符串，所以各部分之间的顺序不携带
// 任何信息。
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
// 错：只有「按 key 跳进某个标题」的落点带着它（`placeRecord`/`settle` 只给 jump 写 `st`），
// 单纯读完一篇笔记走人的记录一个字都没有；它是几周前的一次快照，而笔记此后一直在被读；
// 而它挡在更好的东西前面 —— 无词边界的子串匹配进主过滤路径就是一台没有排名的噪音
// 发生器（`pro` 命中 `approve`、单字中文命中一切），而按内容找一篇笔记这件事，vault
// 自己的全文搜索（有排名、有上下文、看得见全 vault）赢得这个面板。
//
// 至于**「这篇笔记里有个叫『定价』的小节」**，它不需要快照：各标题从 metadataCache 现查
// 就行（见 reads.ts 的 headingsFor），永远是最新的，且体积与笔记长度无关。
export function navSearchText(entry: NavEntry): string {
	if (entry.kind === 'view')
		return `${entry.viewType} ${viewName(entry)}`;
	const parts = [baseName(entry.path), entry.path];
	// 跳转的 key：大纲点击时是标题的文字，锚点链接时是读者选的目标。caller 目标的合成 key
	// 是一个时间戳、不是词（见 isCallerKey）。
	if (entry.kind === 'jump' && !isCallerKey(entry.key))
		parts.push(entry.key.startsWith('outline:') ? entry.key.slice('outline:'.length) : entry.key);
	return parts.filter(Boolean).join(' ');
}
