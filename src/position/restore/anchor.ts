import { CachedMetadata } from 'obsidian';
import { blockAnchor } from '@/nav/entry';
import { normAnchor } from '@/position/capture/ephemeral';

// 一条带 key 的步，它的锚点漂了多远：锚点在文件里**现在**的行号，减去它被记录时
// 所在的行号（NavJump.keyLine）。一个数，只问 metadata 缓存、别的什么都不问 ——
// 不读文件 —— 所以重锚有两半，它是便宜的那半，也是拿不到文件正文的调用方
// 唯一能跑的那半。
//
// 之所以共享，是因为**落点**必须处处得出同一个答案：即将打开文件的那次遍历
// （nav-history/stack.ts 的 landingFor，那时还没有编辑器），以及它落地时的那次纠正。
// 两处读出不同的漂移，会让同一处地点在两行上着陆。
//
// 锚点解不出来时返回 undefined —— 标题被改名或删掉，或者那一步从未落定出一个
// keyLine：调用方退回按文本片段重映射，或者干脆不吭声。
export function anchorLineShift(
	cache: CachedMetadata | null,
	key: string,
	keyLine: number,
): number | undefined {
	const line = resolveAnchorLine(cache, key, keyLine);
	return line === undefined ? undefined : line - keyLine;
}

// 带 key 的 NavJump 的结构化重锚：把这次跳转自带的锚点 —— key 里本来就有的
// 标题或块 id —— 解到它**当前**所在的行，而不是拿文本片段去猜。任意插入 /
// 删除造成的整体位移都扛得住（标题只要还在就是权威），而且从不猜：锚点被
// 改名 / 删掉就返回 undefined，由调用方退回 remapAnchoredState。只在
// 前进 / 后退 / 跳转的那次 apply 上跑。
//
// key 的几种形式（见 NavFunnel.recordOpen / OpenPatcher）：
//   outline:<标题文本>          标题原文（点大纲面板）
//   <file>#<slug> | #<slug>     标题链接（锚点 / caller 的 linktext）
//   <file>#^<block> | #^<block> 块引用（[[note#^id]] 链接送来的形式；
//     <file>^<block> 是同一回事，只是少了那个 #）
//   caller:<时间戳>             没有锚点 —— 不是结构化的，返回 undefined。
// 开头的文件路径会剥掉：NavJump 永远是同一个文件内的跳转，所以它是对着
// 这一步自己的文件去解的。
//
// 重复锚点：靠记录下来的基准行来消歧 —— 对的那个实例，是离这次跳转最初落点
// 最近的那个，与 remapAnchoredState 的「最近的重复项」规则一致。
export function resolveAnchorLine(
	cache: CachedMetadata | null,
	key: string,
	baseLine?: number,
): number | undefined {
	if (!cache || !key)
		return undefined;

	// outline:<标题> —— 两种 key 形式：
	//   "outline:## 我的标题"  升级过的（NavStack.upgradeKeyLine）：# 的个数
	//     是这个标题的绝对层级，剩下的是 HeadingCache.heading 的原文 ——
	//     精确那一轮按层级过滤，这同时也把不同深度、文字相同的标题区分开；
	//   "outline:T"            渲染文本（升级前的 key，或从未落定过的落点）：
	//     走下面那套平铺的两轮匹配。
	if (key.startsWith('outline:')) {
		const text = key.slice('outline:'.length).trim();
		const m = /^(#{1,6})\s+(.+)$/.exec(text);
		const level = m?.[1].length;
		const raw = (m ? m[2] : text).trim();
		const target = normAnchor(raw);
		return target
			? headingLine(cache, raw, target, baseLine, level)
			: undefined;
	}

	// 块引用：那个 id 是精确的 key，不是 slug。它**先于**标题分支被问，因为
	// `note.md#^id` 里也带着一个 `#` —— 那是 Obsidian 为 `[[note#^id]]` 链接
	// 递过来的形式，而把它当成标题 slug 去读，会让每一个块链接都落空、退回
	// 文本片段重映射。
	const block = blockAnchor(key);
	if (block !== undefined)
		return cache.blocks?.[block]?.position.start.line;

	// 锚点 / caller 的 linktext：剥掉开头的文件路径，再取 #标题 那一段。
	const hashIdx = key.indexOf('#');
	if (hashIdx === -1)
		return undefined;
	const anchor = key.slice(hashIdx + 1);
	if (!anchor)
		return undefined;
	// 链接锚点是个 SLUG（"My Heading" -> "my-heading"），decodeAnchor 只做
	// URL 反转义，所以拿纯文本去比 HeadingCache.heading 基本永远命中不了：
	// 直接走归一化扫描。
	const target = normAnchor(decodeAnchor(anchor));
	return target
		? nearestLine(cache.headings ?? [], (h) => normAnchor(h.heading) === target, baseLine)
		: undefined;
}

// OUTLINE key 的标题解析，走两轮：先纯文本（未编辑过的常见情形，只有字符串
// 比较），只有在纯文本什么都没找到时才走归一化扫描 —— 否则对不上的是大多数，
// 每一趟扫描都要陪上正则。精确命中优先于更近的归一化命中：没编辑过的标题，
// 比一个改过的仿制品更可信。链接 slug 类的 key 跳过这个辅助函数 —— 它们的
// 锚点本来就是归一化的。
function headingLine(
	cache: CachedMetadata,
	raw: string,
	target: string,
	baseLine?: number,
	level?: number,
): number | undefined {
	const headings = cache.headings ?? [];
	const byLevel = (h: { level: number }) => level === undefined || h.level === level;
	const exact = nearestLine(headings, (h) => byLevel(h) && h.heading.trim() === raw, baseLine);
	if (exact !== undefined)
		return exact;
	return nearestLine(headings, (h) => byLevel(h) && normAnchor(h.heading) === target, baseLine);
}

// 遇到孤零零的 %（标题 slug 里一个真正的百分号）时 decodeURIComponent 会抛 ——
// 退回原文，而不是把异常抛进 execute()。
export function decodeAnchor(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

// 标题缓存的一次命中带回来的东西：缓存行号（NavJump.keyLine 升级所依据的、
// 记录时刻的权威行号）、层级（用来重建升级后 outline key 的 # 前缀），以及
// 标题的原文。
export interface HeadingHit {
	line: number;
	level: number;
	heading: string;
}

// 按归一化文本定位一个标题（大纲面板渲染出的标签，或链接 slug），`nearLine`
// 用来在文字相同的重复项之间破平 —— 那条记录下来的视图行只需要决定选**哪一个**
// 重复项，所以视口漂移在这里无害。
export function findHeading(
	cache: CachedMetadata | null,
	text: string,
	nearLine?: number,
): HeadingHit | undefined {
	const target = normAnchor(text);
	if (!cache || !target)
		return undefined;
	let best: HeadingHit | undefined;
	let bestDist = Infinity;
	for (const h of cache.headings ?? []) {
		if (normAnchor(h.heading) !== target)
			continue;
		if (nearLine === undefined)
			return { line: h.position.start.line, level: h.level, heading: h.heading };
		const dist = Math.abs(h.position.start.line - nearLine);
		if (dist < bestDist) {
			bestDist = dist;
			best = { line: h.position.start.line, level: h.level, heading: h.heading };
		}
	}
	return best;
}

// `headings` 是按文档顺序排的，所以朴素的「取第一个命中」永远会命中最早的
// 那个重复项，而不是这次跳转瞄准的那个。
function nearestLine<T extends { position: { start: { line: number } } }>(
	items: T[],
	matches: (it: T) => boolean,
	baseLine?: number,
): number | undefined {
	let best: number | undefined;
	let bestDist = Infinity;
	for (const it of items) {
		if (!matches(it))
			continue;
		const line = it.position.start.line;
		if (baseLine === undefined)
			return line; // 没有基准行时，第一个命中者就赢
		const dist = Math.abs(line - baseLine);
		if (dist < bestDist) {
			bestDist = dist;
			best = line;
		}
	}
	return best;
}

// 某一行的 outline 路径，和其余读标题的逻辑一起住在 shared/headings.ts（headingsFromLines
// 那趟扫描，以及建在它上面的 headingTrailAtLine）：cue 是从活的编辑器缓冲区给出一节的名字，
// 最近文件的行则是从 metadata 缓存给，两个答案必须一致。
