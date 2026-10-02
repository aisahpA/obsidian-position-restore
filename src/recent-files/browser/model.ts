// 最近文件浏览器的纯模型层：一行**说什么**（显示碎片、标题链），由条目派生，而只有调用方
// 能回答的两件事 —— 文件保存的位置、以及它现在的 mtime —— 以谓词的形式传进来。
// 无 DOM、也没有 `this`。

import { landedLine, NavEntry, NavView } from '@/nav/entry';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';

// 一个 path 的显示名：它最后的一段。
export function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

// 一行拿来**显示**笔记名字的东西：最后一段 path、去掉扩展名。扩展名不是读者所称笔记的一部分
// —— "meeting-notes.md" 这篇笔记叫 "meeting-notes" —— 而一行若把后缀拼出来，就是在它最窄的
// 空间里，把地方花在一个在一个满是 markdown 的 vault 里永远不区分两篇笔记的部分上。
// **类型**确实会区分（`x.canvas` 挨着 `x.md`），而那正是名字旁边那个徽标所说的（见 badgeOf）。
//
// 开头的一个点是名字的一部分、不是扩展名：".gitignore" 是一个名字，不是一个叫 "" 的文件 ——
// `cut > 0` 就是让它保持完整的东西。
export function displayName(path: string): string {
	const name = baseName(path);
	const cut = name.lastIndexOf('.');
	return cut > 0 ? name.slice(0, cut) : name;
}

// 名字旁边的类型徽标：大写的扩展名。markdown 没有徽标，因为在一个 vault 里它是无标记的默认 ——
// 给每一篇普通笔记都加徽标会成一条噪音列 —— 而眼睛于是会把那些不寻常的（"PDF"、"CANVAS"）
// 读成它们本就是的例外。一个完全没有扩展名的文件得到 "FILE"，这收拢了那条规则：
// 每一个不带扩展名显示的名字，要么是 markdown、要么是被标记过的。
//
// 一个空的 path 就是那**没有 path** 的组（一个视图 —— 见 listing.ts 的 NO_PATH）：没有文件，
// 没有类型。
export function badgeOf(path: string): string | undefined {
	if (!path)
		return undefined;
	const cut = path.lastIndexOf('.');
	// 那个点必须在最后一段**里面**："notes.v2/readme" 没有扩展名。
	if (cut <= path.lastIndexOf('/') + 1)
		return 'FILE';
	const ext = path.slice(cut + 1).toLowerCase();
	return ext === 'md' ? undefined : ext.toUpperCase();
}

// 一个 path 所在的文件夹：在 vault 根是 ""，对没有 path 的组（一个视图）是 undefined，
// 它的名字是一个标签、而不是一段 path。只在名字撞车的地方显示 —— 两篇都叫 "index" 的笔记
// 否则就是两行无法彼此分辨，而在其它每一行上，那个文件夹只是同一个文件夹的重复。
export function folderOf(path: string): string | undefined {
	if (path === '')
		return undefined;
	const cut = path.lastIndexOf('/');
	return cut === -1 ? '' : path.slice(0, cut);
}

// 一行在决定要显示任何东西之后，显示它的笔记在哪儿（见 PathDisplayMode）：**文件夹** ——
// 它自己的名字格已经命名了那个文件 —— 或在名字格命名的是别的东西时显示文件的**完整** path，
// 因为一行若从 frontmatter 属性取了名字，就再没有别的地方说明它是哪个文件。根两种情况都
// 显示 "/"：一个空 span 看起来与「一个文件夹没有被显示的笔记」一模一样，而那是另一个事实。
// 只对**有** path 的笔记问 —— 视图的组没有。
export function pathLabel(path: string, name: string): string {
	const folder = folderOf(path);
	if (folder === undefined)
		return '';
	if (name !== displayName(path))
		return path;
	return folder === '' ? '/' : `${folder}/`;
}

// 这些名字里哪些被**显示**了两次，好让列表恰好把文件夹放在那几行上。是**从列表上的**那些行
// 建出来的、而不是从整段历史：一个被过滤器丢掉的重名，并不在屏幕上、不会与什么东西混淆。
//
// 是名字、不是 path，因为可能撞车的是**显示出来的**那个名字 —— 它不总是文件自己的：
// 两篇都叫 `index` 的笔记会撞，frontmatter 给它们同名 title 的两篇也会撞。徽标也能分辨文件，
// 但只对一个已经知道要去看的读者；文件夹回答的是「这是哪一个」。
export function duplicateNames(names: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const twice = new Set<string>();
	for (const name of names) {
		if (seen.has(name))
			twice.add(name);
		seen.add(name);
	}
	return twice;
}

// 一行关于一条条目需要知道的东西。纯（只有调用方能回答的那一件事 —— 文件保存的位置 ——
// 以谓词的形式传进来），所以浏览器的标签不用 DOM 就能测试。一个**文件**没了的地点永远不会被
// 描述：列表在问之前就把它滤掉了（见 RecentFilesList.render）。
export interface NavEntryDescription {
	// 笔记的显示名（见 displayName），或对一个没有 path 的条目用视图自己的名字（见 viewName）。
	// 组的表头显示它，旁边是徽标和文件夹。
	name: string;
	// 这一行的附注文字："L412"。一个没有记录行号的步改为显示 "—"。
	line?: string;
	// 同一个落点的 0-based 下标 —— groupByFile 据以把两步当作一个地点的东西，
	// 也是标题链据以被查找的东西。
	lineIndex?: number;
}

// 一行为一个**没有 path** 的条目 —— 一个视图，而不是笔记里的某个地点 —— 显示的名字。
// 它是视图**自己的**，在读者去那里时记下：Obsidian 的 `getDisplayText` 就是那个视图的标签页
// 表头所说的，所以这一行与读者点过的那个标题一致、用 app 自己的语言，而一个第三方视图
// 无需本插件知道它存在就能自报名字（见 shared/leaf.ts 的 viewLabel）。没有标签时视图自答：
// 其它任何情况都显示它光秃秃的视图类型 —— 当视图从未提供过名字时，那是诚实的名字。
export function viewName(entry: NavView): string {
	if (entry.label)
		return entry.label;
	return entry.viewType === 'graph' ? t('recentFiles.graphView') : entry.viewType;
}

// 一条条目，按它那一行的显示方式。那些兜底是给一种从未走过导航读取的状态的：下面文件保存的
// 位置，或一次落点从未落定的 teleport。
//
// `titleOf` 是读者给笔记起的名字（见 reads.ts 的 titleOf）：vault 对「这篇笔记叫什么」的回答，
// 在这里问出来，好让下游的一切 —— 那一行、搜索、把两篇同名笔记分辨开的文件夹 —— 显示
// 一个名字而无需知道它从哪儿来。它的 undefined 是轮到文件名，而不是缺席。
export function describeNavEntry(
	entry: NavEntry,
	savedPosition?: (path: string) => EphemeralState | undefined,
	titleOf?: (path: string) => string | undefined,
): NavEntryDescription {
	if (entry.kind === 'view')
		return { name: viewName(entry) };
	let n: number | undefined;
	if (entry.st) {
		n = landedLine(entry);
	} else {
		// 这条条目自身不携带位置（一次早于「离开时刷新」的标签页/窗格激活，或一条遗留的持久化
		// 条目）：退回文件保存的记录 —— 一次重新打开会恢复的位置，也就是这一步的「我刚才在哪儿」。
		const saved = savedPosition?.(entry.path);
		n = saved?.cursor?.from.line ?? saved?.scroll;
		if (n === undefined && entry.kind === 'teleport')
			// 一次从未落定的落点：记录下来的目标行仍然是恢复会瞄准的地方。
			n = entry.line;
	}
	return {
		name: titleOf?.(entry.path) ?? displayName(entry.path),
		line: n !== undefined ? `L${n + 1}` : undefined,
		lineIndex: n,
	};
}

// ===== 一行有多旧 =====

// 一行的「多久之前」所用的单位，最粗的在后。
export type AgeUnit = 'now' | 'm' | 'h' | 'd' | 'w' | 'mo' | 'y';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// 月与年**有意**用固定长度：这是一个读者拿来扫的量级（「大约一个月前」），不是一个日期。
// 一个按日历精确的月会让标签跳动、对谁都没好处，而且会需要那个读出时间戳时并不用的挂钟。
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// 一条记录有多旧，以一个数字加一个单位表示。是截断、不是四舍五入，所以标签从不声称比已经过去
// 的更多的时间（"4w" 是在四周到五周之间，绝不会被进位成五）。
//
// 一个在**未来**的时间戳被夹到 `now`：否则一个倒退了的时钟（一台从睡眠中醒来、时间被校正的
// 机器，两台正在同步的设备）会显示 "-3m"。
export function ageOf(at: number, now: number): { n: number; unit: AgeUnit } {
	const d = Math.max(0, now - at);
	if (d < MINUTE)
		return { n: 0, unit: 'now' };
	if (d < HOUR)
		return { n: Math.floor(d / MINUTE), unit: 'm' };
	if (d < DAY)
		return { n: Math.floor(d / HOUR), unit: 'h' };
	if (d < WEEK)
		return { n: Math.floor(d / DAY), unit: 'd' };
	if (d < 5 * WEEK)
		return { n: Math.floor(d / WEEK), unit: 'w' };
	if (d < YEAR)
		return { n: Math.floor(d / MONTH), unit: 'mo' };
	return { n: Math.floor(d / YEAR), unit: 'y' };
}

// 一行拿来当它的「多久之前」显示的东西：数字加上单位自己的词（`5m ago`、`5分钟`）——
// 拼得够完整，能一眼读出而不用解码。确切的时刻是一次悬停之遥（见 list.ts 的 fileRow）。
//
// 单位走一个穷尽的 switch、而不是塞进模板串：t() 的签名以 locale 自己的键联合为键，
// 而一个拼出来的字符串满足不了它 —— 这个 switch 也是让「以后加的一个单位」变成编译错误、
// 而不是运行时少一个词的东西。
export function ageLabel(at: number, now: number): string {
	const { n, unit } = ageOf(at, now);
	switch (unit) {
		case 'now': return t('recentFiles.age.now');
		case 'm': return `${n}${t('recentFiles.age.m')}`;
		case 'h': return `${n}${t('recentFiles.age.h')}`;
		case 'd': return `${n}${t('recentFiles.age.d')}`;
		case 'w': return `${n}${t('recentFiles.age.w')}`;
		case 'mo': return `${n}${t('recentFiles.age.mo')}`;
		case 'y': return `${n}${t('recentFiles.age.y')}`;
	}
}

// 一组**上次**被访问是什么时候：它持有的那些记录里最新的那个时间戳。不是锚点自己的时间戳，
// 尽管锚点通常**就是**这篇笔记的上次访问：锚点可能已经被淘汰，而在笔记内部做出的那些跳转
// 还活着（见 activeRep），而且一组的 `indices` 是**行号**顺序（见 groupByFile）、不是时间顺序。
export function newestStamp(
	entries: NavEntry[],
	indices: number[],
	anchor?: number,
): number | undefined {
	let newest: number | undefined;
	const look = (i: number | undefined) => {
		if (i === undefined)
			return;
		const stamp = entries[i]?.t;
		if (typeof stamp === 'number' && (newest === undefined || stamp > newest))
			newest = stamp;
	};
	look(anchor);
	for (const i of indices)
		look(i);
	return newest;
}

// 一条**行**显示的那条链的样子：只要最深的 `depth` 个层级，最外层在前（一行只有一行的宽度）。
// 最深的那一层**保留**，即便它正是落点行自身所携带的那个标题：这一行上没有别的东西命名
// 落点自己的文字，而把它丢掉会让这一行改为命名它的**父**分节。
export function rowTrail(trail: string[], depth = 2): string[] {
	return trail.slice(-depth);
}

// 一行是否必须放弃它所显示链的**外层**层级：这个层级存活下来的不到**一半**。`whole` 是这个层级
// 所要的宽度，`shown` 是这一行能给它的 —— 两者都由唯一持有「已排版的这一行」的那个调用方
// 从那一行上读出（见 RecentFilesList.fitTrails）。
//
// 是一半，不是「被切掉了一点」：一个被裁剪、但大体还在的层级仍然命名它的分节
// （`面板设计与信息架…`），而一个被挤扁的层级留下的是一个什么都不命名的**碎片**
// （`新插件 Positi…`）—— 所以这条界线画在层级不再**可读**的地方，而不是它不再完整的地方。
//
// 这与最深层的宽度无关：那一层不管旁边站着什么，都取它自己文字所需的宽度（见 styles.css 的
// `flex: 0 0 auto`），所以把外层拿掉连一个像素都买不到。它买到的是**可读性** —— 而一行放掉的
// 那个分节，反正都是一次悬停之遥。一个多少放得下的层级永远不会被丢掉（`whole === 0` 表示
// 什么都没被裁）。
export function dropsOuterLevel(shown: number, whole: number): boolean {
	return whole > 0 && shown * 2 < whole;
}
