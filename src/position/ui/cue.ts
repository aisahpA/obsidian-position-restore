import { MarkdownView } from 'obsidian';
import { PluginSettings } from '@/types';
import { outlinePathAtLine } from '@/shared/headings';
import { getScroller } from '@/shared/wait';

const CUE_AUTO_HIDE_MS = 4000;
const CUE_DISMISS_GRACE_MS = 2000;
const FLASH_MS = 1000;
const FLASH_HOLD_RATIO = 0.2;

interface FlashTarget {
	element: HTMLElement;
	line: number;
	cursor: boolean;
}

// 编辑器包着的 CodeMirror 6 EditorView 的最小形状 ——
// `editor.cm` 是内部的，Obsidian 的类型定义里没有。
interface Cm6EditorView {
	state: { doc: { lines: number; line(n: number): { from: number } } };
	domAtPos(pos: number): { node: Node; offset: number };
}

	// 恢复后的方向提示 cue：落点行上一闪而过的高亮（存下来的 scroll 量化到行首，
	// 所以「落点」= 视口顶部）加上一个居中小提示条里的分节面包屑，桌面和移动端都有，
	// 深标题链时允许折成两行。两者都只是装饰 —— 每条失败路径都退化成什么都不显示。
	// 高亮走 Web Animations API；提示条的外观住在 styles.css (.position-restore-cue*)。
	// 移动端/桌面的摆放差异是 styles.css 里的 body.is-mobile，与 Obsidian 自己的标志一致。
export class RestoreCue {
	private settings: PluginSettings;
	private chip: HTMLElement | null = null;
	private hideTimer = 0;
	private shownAt = 0;

	constructor(settings: PluginSettings) {
		this.settings = settings;
	}

	// 给一个刚恢复完的视图显示 cue。它读视图**已落定**的位置而不是请求的状态，
	// 所以既覆盖保存位置的恢复、也覆盖默认跳转（到末尾 / 到脚注之前）。
	// 从不抛异常：所有查询都有防护。
	show(view: MarkdownView) {
		this.clearHideTimer();
		if (this.settings.restoreIndicator === 'off')
			return;

		const target = this.resolveFlashTarget(view);
		if (!target)
			return;
		// 墓碑记录（scroll 0、没有光标）：什么都没恢复，所以 cue 只会指向
		// 文件那个随便的顶部。
		if (target.line === 0 && !target.cursor)
			return;

		const mode = this.settings.restoreIndicator;
		// 高亮只有指向真实的编辑锚点才有意义；退回到视口顶部的那个位置，
		// 反正眼睛也会落到那儿。
		if (mode === 'both' && target.cursor) {
			this.flash(target.element);
		}
		if (mode === 'breadcrumb' || mode === 'both') {
			// 到这时才移除上一次恢复留下的提示条，这样一个重入的 show() 若解析不出
			// 提示条（例如第二次 file-open tick）就没法擦掉已经正确在屏上的那条。
			// 提示条有 pointer-events:none，所以解析期间把它留在原地不影响
			// resolveFlashTarget 的 elementFromPoint。
			this.removeChip();
			this.showCueAtLine(view, target);
		}

		this.shownAt = Date.now();
		this.hideTimer = window.setTimeout(() => this.hide(), CUE_AUTO_HIDE_MS);
	}

	// 只标记一行，方式和大纲点击标记它带读者去的那行标题一样。源码视图给它已经知道
	// 怎么找的行元素做动画；阅读视图压根没有行元素可说，所以改为向视图要它自己的
	// 标记式揭示 —— app 对 `{line}` 的回答，它会把那一行落定并高亮。
	flashLine(view: MarkdownView, line: number) {
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

	// 解析要闪烁的元素、以及给面包屑做锚的那一行。源码模式在光标所在行已渲染且在屏上时
	// 优先用光标（编辑锚点）；否则退回视口顶部那一行 —— 阅读锚点，也就是恢复后的视图
	// 实际展示的位置。阅读模式没有光标，所以永远用最顶上那个已渲染的块。
	private resolveFlashTarget(view: MarkdownView): FlashTarget | null {
		const scroll = Math.round(view.currentMode?.getScroll() ?? 0);

		if (view.getMode() === 'preview') {
			const el = this.previewTopBlock(view);
			// 这个元素只被光标闪烁消费，而阅读模式从不做（这里 cursor 永远是 false）——
			// 面包屑只需要那一行。移动端上 glide 恢复在 cue 触发时可能还在文档顶部落定中，
			// 那时探测点落在阅读模式的留白里、找不到已渲染的块；别让这干掉提示条。
			return { element: el ?? view.contentEl, line: scroll, cursor: false };
		}

		const cm = (view.editor as unknown as { cm?: Cm6EditorView }).cm;
		if (!cm)
			return null;
		const cursor = view.editor?.getCursor();
		const cursorEl = cursor && cursor.line > 0 ? this.sourceLineElement(cm, cursor.line) : null;
		// 面包屑只在光标在屏上时跟着它；一个不在屏上的光标描述的是用户没在看的
		// 那一节，所以退回视口顶部那一行 —— 恢复后的视图实际展示的位置。
		if (cursor && cursorEl && this.isVisibleInScroller(cursorEl, view))
			return { element: cursorEl, line: cursor.line, cursor: true };
		const topEl = this.sourceLineElement(cm, scroll);
		if (topEl)
			return { element: topEl, line: scroll, cursor: false };
		return null;
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

	private isVisibleInScroller(el: HTMLElement, view: MarkdownView): boolean {
		const scroller = view.contentEl.querySelector<HTMLElement>('.cm-scroller');
		if (!scroller)
			return false;
		const er = el.getBoundingClientRect();
		const sr = scroller.getBoundingClientRect();
		return er.top < sr.bottom && er.bottom > sr.top;
	}

	// 阅读视图视口顶部那个已渲染的块。存下来的 scroll 是行首，所以恢复后视口顶部
	// 正好落在包含落点行的那个块上。
	private previewTopBlock(view: MarkdownView): HTMLElement | null {
		const scroller = getScroller(view);
		if (!scroller)
			return null;
		const r = scroller.getBoundingClientRect();
		const el = document.elementFromPoint(r.left + r.width / 2, Math.max(0, r.top + 2));
		if (!el)
			return null;
		let node: Element | null = el;
		while (node && node !== scroller) {
			if (node.parentElement?.classList.contains('markdown-preview-sizer'))
				return node as HTMLElement;
			node = node.parentElement;
		}
		return null;
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
	// styles.css (.position-restore-cue*)；移动端/桌面的摆放差异是那里面的
	// body.is-mobile，与 Obsidian 自己的标志一致。
	private showCueAtLine(view: MarkdownView, target: FlashTarget) {
		// 扫描在目标行停下，所以只需要前缀。
		const path = outlinePathAtLine((view.data ?? '').split('\n', target.line + 1), target.line);
		if (path.length === 0)
			return;

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