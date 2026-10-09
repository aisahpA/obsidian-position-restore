// 一行的**预览**：把指针移动到的一行交给 app，问一次它是否愿意被预览。
//
// app 自己的预览是被**请求**的，而不是在这里重建的。Obsidian 里每一个命名一篇笔记的其它
// 地方，都由**一个** core 机制预览，它应答读者关于那件事的那一个设置；我们自己的预览会是
// 第二个 popover、带着第二套规则，无论读者是否想要都打开。请求会继承一切，包括「什么都
// 不发生」。
//
// 这里没有任何东西是**导航**：地点不动，没有行移动，没有列表被重画。一个无路径视图
// 不被问及 —— 它背后没有页面。

import { App, HoverParent } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { PreviewFocusMode } from '@/types';
import { headingTrailAtLine } from '@/shared/headings';
import { RecentFilesReads } from './reads';
import { PreviewSettle } from './hover-settle';
import type { HeadingHit } from './list';
import { NAV_SOURCE_ID } from './constants';

// 一个无法在 linktext 里行走的标题：这些字符每一个都会被读作链接语法、而不是节名的一部分 ——
// `#` 与 `^` 开一个子路径，`|` 开一个别名，`[` 与 `]` 开链接。
const UNTRAVELABLE = /[#^|[\]]/;

// 加在 app 为这个面板打开的那张卡片上、别处一概不加：popover 是 core 的对象、由 core 自己的
// 规则绘制，而这个面板关于它外观唯一说的话就是**它立在哪**。
const PREVIEW_CLASS = 'position-restore-nav-preview';

export class RowPreview {
	// 这个面板在 app 的悬停预览系统里的槽位，整个生命期只用一个对象：app 把它打开的
	// popover 写回给它、之后再问它，所以每次到达都新建一个会是没记忆的那个。
	readonly hoverParent: HoverParent = { hoverPopover: null };
	// 用来遮住 popover 自己走向它所被要求的行号的旅程：app 究竟有没有作答，是在这个面板
	// 之外、在该行被要求之后的若干帧才决定的。
	private readonly settle = new PreviewSettle();

	// `onShown` 是 app 作答之后这个面板要做的事 —— 把行上的提示从一篇已作答的页面上拿开
	// —— 而它属于持有那些行的那一侧。
	constructor(
		private app: App,
		private reads: RecentFilesReads,
		// **活读**：常驻面板下面的地点列表会动，所以每次悬停重新取。
		private entries: () => NavEntry[],
		private previewFocus: () => PreviewFocusMode,
		private onShown: () => void,
	) {
		this.settle.attach(this.hoverParent, card => {
			this.lift(card);
			this.onShown();
		});
	}

	// 指针**移动到了**的一行，交给 **app**：问一次，它是否愿意被预览。
	hoverRow(rep: number, ev: PointerEvent, row: HTMLElement, file: boolean, hit?: HeadingHit): void {
		const entry = this.entries()[rep];
		if (!entry || entry.kind === 'view')
			return;
		// **该行会落在哪里**，不是它「曾经」落在哪里：一份记录不携带位置，所以这个数字
		// 就是位置数据库对一次普通打开的回答 —— 也正是这一行的点击会给出的那一个到达。
		// 当这个面板说不出时，这次请求完全不携带行号，笔记在 app 自己的默认位置打开。
		//
		// 一个**大纲行**不同：它自己就带着那一节此刻在哪一行（现查，见 list.ts 的
		// hitsFor），所以它没有要寻找的东西 —— 而它索要的正是那一节。
		const d = this.reads.describe(rep);
		const line = hit
			? hit.line
			: this.wantsLine(file) ? d.lineIndex : undefined;
		const ask = this.askFor(entry, entry.path, file, line);
		this.app.workspace.trigger('hover-link', {
			event: ev,
			// 谁在发问：插件注册的那个 id，正是它让 app 得以应用读者给**这个**面板的答案
			// —— 而只有那次读取决定究竟有没有东西打开。
			source: NAV_SOURCE_ID,
			hoverParent: this.hoverParent,
			// 是**那一行**，不是指针落在的那个子元素：popover 属于列表的那一行，不属于被越过
			// 的那个词。
			targetEl: row,
			// 按它被打开所用的路径来指这篇笔记 —— 它在磁盘上的自己的名字，而不是行上打印的
			// 那个缩短过的名字。
			linktext: ask.linktext,
			sourcePath: entry.path,
			state: ask.state,
		});
		// 从这里开始，发问属于 settle：以「它是否命名了一个行号」武装 —— 那是唯一有旅程要走
		// 的一种 —— 它在**悬停**持续的期间守候 app 的答案，而不是在猜测所持续的期间。读者的
		// 按键可能在该行之后十秒才来。
		this.settle.ask(ask.state !== undefined);
	}

	// 指针离开了列表：一次悬停会话结束了，app 被要求的一切都可退下。
	hoverEnded(): void {
		this.settle.hoverEnded();
	}

	// 行上的提示此刻是否应当**沉默**，在每次悬停时重新发问（见 body.ts 的 tipsQuiet）。
	quiet(): boolean {
		return this.settle.isOpen();
	}

	// app 建起的 popover 仍是 app 的、并活过我们，所以在走之前把我们所遮住的揭开是我们
	// 该做的事。
	stop(): void {
		this.settle.stop();
	}

	// **一行如何命名它的位置**：靠它所在的**节**、靠它的**行号**、或什么都不靠。交给它一个
	// 数字（state.scroll）时，popover 先画出整篇笔记，等那次绘制落地后把滚动器移到那里，
	// 让目标闪一下（见 hover-settle.ts）。交给它一个节（`note.md#Heading`）时，这些都不
	// 发生：加载器**只**画那个节。两个都不给时，笔记在它的开头打开，正如 app 自带每一份列表
	// 打开它的方式。
	//
	// **代表文件的行**按**读者的选项**要求行号：那买到的是该行自己的点击本就会给出的到达，
	// 只是早一个手势；而它花掉的是一整篇笔记被渲染、然后被移动 —— 所以 app 自己的答案才是
	// 出厂的那个（见 PreviewFocusMode）。
	//
	// **大纲行**命名的是笔记**内部**的一个地点，也因此被要一个：它上方的那个标题，交给
	// 它一个节就是交给它一个到达。那个标题不能被信赖会在链接的另一边命名同一个节时，它
	// 回落到行号 —— 一次都没移动就交付的错误节，比正确的地点晚到更糟。
	//
	// 一行究竟是否命名行号在这里定，而不是在悬停开始处定，因为它是两者都需要的**一个**答案：
	// hoverRow 问它，是为了知道要不要去问位置数据库；这一个问它，是为了知道交给 app 什么。
	private wantsLine(file: boolean): boolean {
		return !file || this.previewFocus() === 'line';
	}

	// 一行如何命名它的位置，交给 app（见上面）：一个**节**，或一个**行号**，或什么都不给。
	private askFor(
		entry: NavEntry,
		path: string,
		file: boolean,
		line: number | undefined,
	): { linktext: string; state?: { scroll: number } } {
		if (file) {
			if (!this.wantsLine(file))
				return { linktext: path };
			return {
				linktext: path,
				// 预览**在笔记的哪里**打开由这个面板说，而它是从这里请求的预览所能提供、别处
				// 请求的不能提供的那一件事：popover 打开在**那一行**上，而不是在笔记的开头。
				// `scroll` 是 app 对「一个 markdown 视图最顶端可见行」自己的叫法 —— 与位置
				// 数据库保存的是同一个数字 —— 所以这里没有臆造一个 state 形状。这个数字是
				// **今天**的，不是记录的那个。
				state: line === undefined ? undefined : { scroll: line },
			};
		}
		const heading = line === undefined ? undefined : this.subpathHeading(entry, path, line);
		if (heading !== undefined)
			return { linktext: `${path}#${heading}` };
		return {
			linktext: path,
			state: line === undefined ? undefined : { scroll: line },
		};
	}

	// 一行上方最深的标题，在它能被**信赖**会在 app 再次解析 `#heading` 之后命名同一个节时。
	// 两个守卫：app 取那个文本的**第一个**标题，所以一篇两次写着 "Notes" 的笔记会打开错的
	// 那一个；而一个携带 `#`、`^`、`|`、`[` 或 `]` 的标题会被读作链接语法。
	//
	// 行号本身**不需要**守卫：一个大纲行的行号是现查的（见 list.ts 的 hitsFor），所以
	// 它今天仍落在读者搜到的那一节上。
	private subpathHeading(entry: NavEntry, path: string, line: number): string | undefined {
		if (entry.kind === 'view')
			return undefined;
		const headings = this.reads.headingsFor(path);
		const trail = headingTrailAtLine(headings, line);
		const deepest = trail[trail.length - 1];
		if (!deepest || UNTRAVELABLE.test(deepest))
			return undefined;
		if (headings && headings.filter(h => h.heading === deepest).length !== 1)
			return undefined;
		return deepest;
	}

	// **app 刚刚打开的那张卡片**，以及这个面板关于它唯一说的话。
	//
	// 从**对话框**请求的预览打开在那个对话框后面：core 把每个 popover 放在 document 的 body
	// 上、以 `--layer-popover`（30）绘制它，而一个模态容器坐在 `--layer-modal`（50）。卡片
	// 作答了，而它的每一行都被请求它的那个 shell 盖住。core 据以预览的表面，没有一个本身在
	// 一个对话框内，而**这个**面板的表面有一半在 —— 所以每张卡片是被抬到对话框图层**之上**
	// 而不是抬**到它上面**，因为共享同一个 z-index 的两个元素是按谁最后被追加来排序的，而
	// 那何时发生是 app 的事。
	private lift(card: HTMLElement): void {
		card.addClass(PREVIEW_CLASS);
	}
}
