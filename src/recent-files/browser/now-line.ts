import { CachedMetadata } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { anchorLineShift } from '@/position/restore/anchor';
import { LineSource, remapAnchorLine } from '@/position/capture/ephemeral';
import { NavEntryDescription } from './model';

// 一行的行号**今天**是什么意思。记录下来的行号是个**地址**：在它上方编辑，地址就指向
// 别处，而那个位置本身并没有动。所以每一行都需要两个答案 —— 它曾经在哪（记录，
// 也就是这一行显示的东西）和它现在在哪（本模块）—— 而只有后者可以交给任何要打开
// 这篇笔记的东西。
//
// 三种得知的办法，从最便宜的先试：文件的**时钟**（mtime 未变 ⇒ 数字仍然成立）、
// 跳转自己的**锚点**对现在的元数据求解、以及把锚点行**自己的文字**在当前的各行里
// 重新找到（有打开的缓冲区就用它，否则用磁盘）。
//
// **undefined 也是一个答案**，而且是本模块存在的意义：一个它答不出的数字比没有更糟 ——
// 一个开在笔记顶部的预览，从来没有在「位置在哪」这件事上答错。这里什么都不回写。

// 只有 vault 能回答的东西，传进来，好让本模块保持为「记录 + 文件」的纯函数。
export interface NowLineFacts {
	// 对背后没有文件的 path 返回 undefined —— 那是列表没在画的地点。
	mtimeOf(path: string): number | undefined;
	// 带 key 的 jump，其锚点据以求解的东西。
	cacheFor(path: string): CachedMetadata | null;
	// `prime`：是否可以为作答而**开始**一次读取（一次悬停可以等一个 await；
	// 一次五十行的渲染不行）。
	linesOf(path: string, prime: boolean): LineSource | undefined;
}

// 这条条目的行**现在**在哪，本模块答不出时是 undefined。
//
// 一条没有东西可以**据以**证明自己行号的条目 —— 没有锚点、又身处一个时钟说没动过的
// 文件里 —— 就保留它已有的数字：那是关于这个位置任何人知道的最好答案，
// 反正这一行显示的也是它。
export function nowLineFor(
	entry: NavEntry,
	d: NavEntryDescription,
	facts: NowLineFacts,
	prime = true,
): number | undefined {
	const recorded = d.lineIndex;
	if (entry.kind === 'view' || recorded === undefined)
		return undefined;

	// 1. 自记录拍下以来未被碰过。
	const taken = entry.st?.mtime;
	const now = facts.mtimeOf(entry.path);
	if (taken !== undefined && now !== undefined && taken === now)
		return recorded;

	// 2. 跳转自己的锚点，按结构求解。
	if (entry.kind === 'jump' && entry.key && typeof entry.keyLine === 'number') {
		const shift = anchorLineShift(facts.cacheFor(entry.path), entry.key, entry.keyLine);
		if (shift !== undefined)
			return Math.max(0, recorded + shift);
	}

	// 3. 那一行自己的文字，在笔记的当前形态里重新找到。
	const src = facts.linesOf(entry.path, prime);
	if (src) {
		const at = remapAnchorLine(entry.st?.anchor, recorded, src);
		if (at !== undefined)
			return at;
	}

	// 再没有别的可依据：一个找不到的锚点，或一个时钟说被写过的文件，
	// 是一个只有沉默来作答的问题。
	const changed = taken !== undefined && now !== undefined && taken !== now;
	if (changed || entry.st?.anchor)
		return undefined;
	return recorded;
}
