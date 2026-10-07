import { MarkdownView } from 'obsidian';
import { PluginSettings } from '@/types';
import { headingsFromLines, headingTrailAtLine, type HeadingRef } from '@/shared/headings';
import { getScroller } from '@/shared/wait';

const CUE_AUTO_HIDE_MS = 4000;
const CUE_DISMISS_GRACE_MS = 2000;
const FLASH_MS = 1000;
const FLASH_HOLD_RATIO = 0.2;

// 编辑器包着的 CodeMirror 6 EditorView 的最小形状 ——
// `editor.cm` 是内部的，Obsidian 的类型定义里没有。
interface Cm6EditorView {
	state: { doc: { lines: number; line(n: number): { from: number }; lineAt(pos: number): { number: number } } };
	domAtPos(pos: number): { node: Node; offset: number };
	posAtCoords(coords: { x: number; y: number }): number | null;
}

// 面包屑印哪几个名字：从一行的标题链里挑出值得念的那几个。三条规则都是为了让名字
// 只说眼睛看不出来的事 —— 与「这一屏里已经能看到标题」（见 hasVisibleHeading）无关，
// 那条看的是屏，这条看的是笔记：
//   · 整篇只有一个标题：那是笔记名或它唯一的小节，标签页上已经有了，不说；
//   · 整篇只有一个一级标题：把它从链里拿掉 —— 一级标题多半就是文章标题，正印在
//     标签页上（多个一级标题的笔记不拿：那是一章的名字，链里留着它才有用）；
//   · 剩下的链为空，就不说。
export function breadcrumbPath(headings: HeadingRef[], line: number): string[] {
	if (headings.length <= 1)
		return [];
	const named = headings.filter(h => h.level === 1).length === 1
		? headings.filter(h => h.level !== 1)
		: headings;
	return headingTrailAtLine(named, line);
}

// 恢复后的方向提示 cue：一个居中小提示条里的分节面包屑，桌面和移动端都有，深标题链时
// 允许折成两行。它只是装饰 —— 每条失败路径都退化成什么都不显示。外观住在
// styles.css (.position-restore-cue*)；移动端/桌面的摆放差异是那里面的 body.is-mobile，
// 与 Obsidian 自己的标志一致。
//
// 另一件方向提示不在这里：标出落点那一行（flashLine），它同时服务恢复后的落点和
// 一次跳转的落点，由读者自己的开关管（见 position/restore/modes.ts）。
export class RestoreCue {
	private settings: PluginSettings;
	private chip: HTMLElement | null = null;
	private hideTimer = 0;
	private shownAt = 0;

	constructor(settings: PluginSettings) {
		this.settings = settings;
	}

	// 给一个刚恢复完的视图显示面包屑。它读视图**已落定**的位置而不是请求的状态，
	// 所以既覆盖保存位置的恢复、也覆盖默认跳转（到末尾 / 到脚注之前）。
	// 从不抛异常：所有查询都有防护。
	show(view: MarkdownView) {
		this.clearHideTimer();
		if (!this.settings.restoreBreadcrumb)
			return;

		// 锚永远是视口顶部那一行：读者眼睛在的地方。编辑模式的光标不参与命名 ——
		// 它只用来标出光标那一行（见 modes.markRestoredLine），那件事由另一个开关管。
		const line = Math.round(view.currentMode?.getScroll() ?? 0);
		const headings = headingsFromLines((view.data ?? '').split('\n'));
		// 先算名字（纯文本、便宜），再去看屏上有没有标题（要问布局）。
		const path = breadcrumbPath(headings, line);
		if (path.length === 0)
			return;
		// 标题已经在屏幕上了：落点在哪一节一眼就能看出，复述一遍是噪音。这也是「什么都
		// 没恢复」那种打开会走到的分支 —— 文件顶上本来就没有标题可看。
		if (this.hasVisibleHeading(view, headings))
			return;

		// 到这时才移除上一次恢复留下的提示条，这样一个重入的 show() 若解析不出
		// 提示条（例如第二次 file-open tick）就没法擦掉已经正确在屏上的那条。
		this.removeChip();
		this.showChip(view, path);
		this.shownAt = Date.now();
		this.hideTimer = window.setTimeout(() => this.hide(), CUE_AUTO_HIDE_MS);
	}

	// 标出一行，方式和大纲点击标记它带读者去的那行标题一样。源码视图给它已经知道
	// 怎么找的行元素做动画；阅读视图压根没有行元素可说，所以改为向视图要它自己的
	// 标记式揭示 —— app 对 `{line}` 的回答，它会把那一行落定并高亮。
	//
	// 找不到行元素（那一行在屏外，或视图还没画到那里）就什么都不发生 —— 这就是
	// 「光标不在屏幕上自然标不出来」，不必先做一次可见性判断。
	flashLine(view: MarkdownView, line: number) {
		if (!this.settings.flashLandingLine)
			return;
		if (view.getMode() === 'preview') {
			view.setEphemeralState({ line });
			return;
		}
		const cm = (view.editor as unknown as { cm?: Cm6EditorView }).cm;
		const el = cm ? this.sourceLineElement(cm, line) : null;
		if (el)
			this.flash(el);
	}

	// 用户离开恢复的位置时由记录循环调用。cue 出现后有一小段宽限期内被抑制，
	// 因为移动端恢复后的布局/滚动抖动会让 readEphemeralState 与播种的基线不同，
	// 否则就会在第一个轮询 tick 就撤掉 cue —— 一次没有用户输入的「一闪而过」。
	dismissOnMove() {
		if (!this.chip)
			return;
		if (Date.now() - this.shownAt < CUE_DISMISS_GRACE_MS)
			return;
		this.hide();
	}

	hide() {
		this.clearHideTimer();
		const chip = this.chip;
		if (!chip)
			return;
		this.chip = null;
		// 立刻隐藏基础样式，这样移除定时器或动画被打断时，元素也绝不会弹回全不透明；
		// 淡出动画靠 fill:forwards 保持它的结束状态。
		chip.setCssStyles({ opacity: '0' });
		chip.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
		window.setTimeout(() => chip.remove(), 220);
	}

	// 视口里此刻有没有标题。两种模式两套看法：编辑模式问编辑器自己 —— 视口上下沿各自
	// 落在哪一行，标题行落在这个区间里就算看得见；阅读模式没有行号，只能扫那一块里
	// 已渲染的标题元素。答不上来（编辑器还没画、坐标落在文档之外）按「没有」处理：
	// 那正是长标题链最需要面包屑的时候。
	private hasVisibleHeading(view: MarkdownView, headings: HeadingRef[]): boolean {
		if (headings.length === 0)
			return false;

		if (view.getMode() === 'preview') {
			const root = getScroller(view);
			if (!root)
				return false;
			const r = root.getBoundingClientRect();
			for (const heading of Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
				const hr = heading.getBoundingClientRect();
				if (hr.top < r.bottom && hr.bottom > r.top)
					return true;
			}
			return false;
		}

		const cm = (view.editor as unknown as { cm?: Cm6EditorView }).cm;
		const scroller = view.contentEl.querySelector<HTMLElement>('.cm-scroller');
		if (!cm || !scroller)
			return false;
		const rect = scroller.getBoundingClientRect();
		if (rect.height <= 0)
			return false;
		const x = rect.left + rect.width / 2;
		const top = this.lineAtPoint(cm, x, rect.top + 2);
		const bottom = this.lineAtPoint(cm, x, rect.bottom - 2);
		if (top === null || bottom === null)
			return false;
		return headings.some(h => h.line >= top && h.line <= bottom);
	}

	// 一个屏幕坐标落在哪一行（0-based）。坐标落到文档之外时编辑器答 null。
	private lineAtPoint(cm: Cm6EditorView, x: number, y: number): number | null {
		try {
			const pos = cm.posAtCoords({ x, y });
			return pos === null ? null : cm.state.doc.lineAt(pos).number - 1;
		} catch {
			return null;
		}
	}

	// 一条（0-based）源码行的 DOM 元素，经由编辑器包着的 CM6 EditorView 取得。
	// domAtPos 返回行首最内层的节点；向上走到 '.cm-line' 把它归一。只有已渲染的行
	// 才存在于 DOM 里，所以这同时兼作「这一行在不在屏上」的检查。
	private sourceLineElement(cm: Cm6EditorView, line: number): HTMLElement | null {
		try {
			const doc = cm.state.doc;
			const n = Math.min(Math.max(0, line), doc.lines - 1) + 1;
			const dom = cm.domAtPos(doc.line(n).from);
			const node = dom.node.instanceOf(Element) ? dom.node : dom.node.parentElement;
			return (node?.closest('.cm-line') as HTMLElement | null) ?? null;
		} catch {
			return null;
		}
	}

	// 在锚点元素上短暂地闪一下背景，用 Obsidian 给 .is-flashing 标题链接的同一种高亮色。
	// 淡出前先短暂保持该颜色，好让它读起来是刻意的一句「在这儿」而不是眨一下眼。
	private flash(el: HTMLElement) {
		el.animate(
			[
				{ backgroundColor: 'var(--text-highlight-bg)', offset: 0 },
				{ backgroundColor: 'var(--text-highlight-bg)', offset: FLASH_HOLD_RATIO },
				{ backgroundColor: 'transparent', offset: 1 },
			],
			{ duration: FLASH_MS, easing: 'ease-out' },
		);
	}

	// 一个居中小提示条，说出落点是哪一节，桌面和移动端都居中在笔记里，
	// 好避开编辑器的外框和移动端的条栏，深标题链时允许折成两行。它被追加到
	// view.contentEl（不是那一行本身），这样 CodeMirror 的行回收永远删不掉它。
	// 只是装饰；每条失败路径都退化成什么都不显示。所有外观都在
	// styles.css (.position-restore-cue*)。
	private showChip(view: MarkdownView, path: string[]) {
		const content = view.contentEl;
		if (getComputedStyle(content).position === 'static')
			content.addClass('position-restore-cue-host');

		const chip = content.createDiv({ cls: 'position-restore-cue' });
		for (let i = 0; i < path.length; i++) {
			if (i > 0)
				chip.createSpan({ text: ' / ', cls: 'position-restore-cue-sep' });
			const isLast = i === path.length - 1;
			chip.createSpan({ text: path[i], cls: isLast ? 'position-restore-cue-seg is-deepest' : 'position-restore-cue-seg' });
		}
		chip.setAttribute('title', path.join(' / '));
		this.chip = chip;

		chip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
		chip.setCssStyles({ opacity: '1' });
	}

	private removeChip() {
		this.clearHideTimer();
		if (this.chip) {
			this.chip.remove();
			this.chip = null;
		}
	}

	private clearHideTimer() {
		if (this.hideTimer) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = 0;
		}
	}
}
