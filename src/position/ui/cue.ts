import { MarkdownView } from 'obsidian';
import { PluginSettings } from '@/types';
import { headingsFromLines, headingTrailAtLine, type HeadingRef } from '@/shared/headings';
import { getScroller } from '@/shared/wait';

const CUE_AUTO_HIDE_MS = 4000;
const CUE_DISMISS_GRACE_MS = 2000;
// 落点闪一下持续多久。core 自己两种模式用的不是同一个数：编辑模式 750ms（解包实测的
// `uE()`），阅读模式的小节高亮是 3000ms（渲染器的 `highlightEl`）。这里统一取 750 ——
// 它是「一行闪一下」的节拍，恢复与跳转共用；3000ms 那个是 core 给一次链接跳转留的
// 「你到了」窗口，比一次落点标记长得多。
const FLASH_MS = 750;

// 编辑器包着的 CodeMirror 6 EditorView 的最小形状 ——
// `editor.cm` 是内部的，Obsidian 的类型定义里没有。
interface Cm6EditorView {
	state: { doc: { lines: number; length: number; line(n: number): { from: number }; lineAt(pos: number): { number: number } } };
	viewport: { from: number; to: number };
	domAtPos(pos: number): { node: Node; offset: number };
}

// 阅读渲染器的一节：`renderer.sections` 里的一项。它带着这一节在文档里占的行区间以及
// 它的那块 DOM —— 正是 core 自己把一次小节高亮画到哪儿去的依据（`position.start.line` /
// `lines` / `el`），所以这里也照它取。运行时的内部结构，公开类型里没有。
interface PreviewSection {
	start?: { line: number };
	lines?: number;
	el?: HTMLElement;
}

// 面包屑印哪几个名字：从一行的标题链里挑出值得念的那几个。三条规则都是为了让名字
// 只说眼睛看不出来的事 —— 它们看的是**笔记**（有哪些小节），与屏幕无关（屏幕那侧另有一道
// `hasVisibleHeading`，见 `show()`）：
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
	//
	// **锚行由调用方给**（`landingLine`，见 modes.anchorToSettledState）：一次「点名了一行」的
	// 跳转已经把那一行摆到了视口正中，视口顶于是落在落点**上方**半屏处 —— 拿它命名会念出
	// 上一个小节的名字（2026-10-09 用户报的「误报……上面顶部的章节」正是它：落点在第二节里，
	// 而半屏之上还印着第一节）。调用方给不出落点行时才退回视口顶那一行：一次保存位置的恢复，
	// 落点**就是**视口顶，那一行也正是读者眼睛在的地方。编辑模式的光标不参与命名 ——
	// 它只用来标出光标那一行（见 modes.markRestoredLine），那件事由另一个开关管。
	//
	// **念的前提是屏幕上没有标题**（2026-10-09 用户拍板）：落点落在某个小节里、而**这一屏上
	// 看不到任何标题**时才念 —— 标题就在读者眼前的话，他自己看得出在哪一节，复述是噪音。
	// 那道门是下面的 `hasVisibleHeading`（它的判据换过三回，读它上面那段）。
	show(view: MarkdownView, landingLine?: number) {
		this.clearHideTimer();
		if (!this.settings.restoreBreadcrumb)
			return;

		const line = landingLine ?? Math.round(view.currentMode?.getScroll() ?? 0);
		const headings = headingsFromLines((view.data ?? '').split('\n'));
		// 先算名字（纯文本、便宜），再去看屏上有没有标题（要问布局）。
		const path = breadcrumbPath(headings, line);
		if (path.length === 0)
			return;
		// 屏幕上已经有标题可看：落点在哪一节一眼就能看出，复述是噪音。
		if (this.hasVisibleHeading(view, headings))
			return;

		// 到这时才移除上一次恢复留下的提示条，这样一个重入的 show() 若解析不出
		// 提示条（例如第二次 file-open tick）就没法擦掉已经正确在屏上的那条。
		this.removeChip();
		this.showChip(view, path);
		this.shownAt = Date.now();
		this.hideTimer = window.setTimeout(() => this.hide(), CUE_AUTO_HIDE_MS);
	}

	// 标出一行，方式和大纲点击标记它带读者去的那行标题一样 —— 两种模式都只**画一下**，
	// 绝不移动视图：落点已经落好了，闪只是回答「到了吗」。
	//
	// 找不到目标元素（那一行在屏外、视图还没画到那里，或阅读模式那一节还没渲染出来）
	// 就什么都不发生，不必先做一次可见性判断。
	//
	// ⚠️ 阅读模式**不要**改用 `setEphemeralState({line})`：那条路会把这一行拉到视口顶，
	// 于是落点被挪走 —— 手机上顶栏那条渐隐正压在那里（见 shared/jump-landing.ts），
	// 刚让开的带子会被它一把收回，落点就又看不见了。
	flashLine(view: MarkdownView, line: number) {
		if (!this.settings.flashLandingLine)
			return;
		if (view.getMode() === 'preview') {
			const el = this.previewLineElement(view, line);
			if (el)
				this.flash(el);
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

	// 视口里此刻有没有标题。两种模式两套画法，同一把尺：把**标题自己的 DOM 矩形**与滚动
	// 容器的可见矩形求交 —— 有任何一个标题落在屏上，就算看得见（此时复述它只是噪音）。
	//
	// 源码模式为什么去量元素、而不去问编辑器「视口上下沿各落在哪一行」：那条路
	// （`posAtCoords` 取样点）在滚动容器的 padding 里会答 null，而取样点恰恰贴着上下沿 ——
	// 屏上明明有标题也答「看不见」。**别把取样点那版加回来**：第十一轮（换 `contentDOM`
	// 五点取样）、第十二轮（换 CM6 的 `viewport`）都在「取哪一段」上摔过 —— `viewport` 是
	// **已渲染**范围、比可视区**大一圈**（标题刚滚出屏、还在渲染缓冲里也算「看得见」），
	// `contentDOM` 的矩形又等于**整篇文档**（取样点大半落在屏外）。量标题自己的矩形没有
	// 这两个坑：它在屏幕坐标系里的位置就是它的位置。
	//
	// 答不上来（编辑器还没建、视图还没铺好）按「没有」处理 —— 那正是长标题链最需要
	// 面包屑的时候。
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
		const scroller = getScroller(view);
		if (!cm || !scroller)
			return false;
		const rect = scroller.getBoundingClientRect();
		if (rect.height <= 0)
			return false;
		// 只有**已渲染**的行才在 DOM 里、才可能看得见 —— 先用编辑器报的已渲染范围收窄。
		// 这是必要条件、不是判据本身：可见与否由下面每个标题自己的矩形说了算。
		const doc = cm.state.doc;
		const firstRendered = doc.lineAt(cm.viewport.from).number;
		const lastRendered = doc.lineAt(cm.viewport.to).number;
		for (const h of headings) {
			const lineNo = h.line + 1;
			if (lineNo < firstRendered || lineNo > lastRendered)
				continue;
			const el = this.sourceLineElement(cm, h.line);
			if (!el)
				continue;
			const hr = el.getBoundingClientRect();
			if (hr.top < rect.bottom && hr.bottom > rect.top)
				return true;
		}
		return false;
	}

	// 阅读视图里一行所在的那一块。core 自己的小节高亮就是给这一块加 .is-flashing
	// （`renderer.sections` 里的 `start.line` / `lines` / `el` 就是它的依据），所以这里
	// 照它取 —— 于是阅读模式的闪与原生完全同款，而且不动视口。
	//
	// 取不到（渲染器内部结构变了、那一行还没渲染出来）就什么都不做：闪是装饰，
	// 绝不值得为它去挪视图。
	private previewLineElement(view: MarkdownView, line: number): HTMLElement | null {
		const renderer = (view as unknown as {
			previewMode?: { renderer?: { sections?: PreviewSection[] } };
		}).previewMode?.renderer;
		const sections = renderer?.sections;
		if (!Array.isArray(sections))
			return null;
		for (const section of sections) {
			const start = section?.start?.line;
			const count = section?.lines;
			if (typeof start !== 'number' || typeof count !== 'number')
				continue;
			if (line >= start && line <= start + Math.max(0, count - 1))
				return section.el ?? null;
		}
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

	// 在元素上短暂地闪一下——直接借 Obsidian 自己的 `.is-flashing`：颜色、圆角、混合模式
	// 全部由它定，跟点大纲时 core 闪的是同一套，读者看到的就是同一个东西。到期自己摘掉，
	// 与 core 的节拍一样。
	//
	// ⚠️ 曾经这里的动画写的是 `var(--text-highlight-bg)`。**那个变量已经不定义了** ——
	// 现在的定义是 `--highlight-background: var(--text-highlight-bg, var(--highlight-background-yellow))`，
	// 也就是说 `--text-highlight-bg` 只剩一个只读不写的兜底来源。拿一个没有值的变量去动画，
	// 整条声明在计算值阶段失效、动画等于没跑（2026-10-07 用户报的「编辑模式 jump 高亮都消失了」
	// 就是它）。改用 core 的类名，这类失效不会再发生。
	private flash(el: HTMLElement) {
		el.addClass('is-flashing');
		window.setTimeout(() => el.removeClass('is-flashing'), FLASH_MS);
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
