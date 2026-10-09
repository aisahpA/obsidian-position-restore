import { MarkdownView } from 'obsidian';
import { getScroller } from './wait';

// 一次 jump 点名的是「一行」：点大纲面板的一个标题、一个 `[[笔记#标题]]`、或这份列表里
// 搜出来的一节。那一行落到屏幕上之后摆在哪儿，从来不是这个插件说了算 —— **core 自己的
// 大纲点击有它自己的答案**，而我们造的每一次跳转都必须落出同一个几何，否则「点大纲面板
// 的标题」与「点搜索里的小节」这两个同类的动作会给出两种落法（2026-10-07 之前正是如此：
// 大纲点击居中、搜索小节贴顶）。
//
// core 的两条规则（解包 obsidian.asar 实测，见 docs/code-tour/00-改前必读.md §5）：
//   · 源码模式 —— `setHighlight({line})` 走 `scrollIntoView({from, to}, true)`：那一行**居中**。
//   · 阅读模式 —— `setEphemeralState({line})` 走 `applyScrollDelayed(line, {highlight:true})`，
//     **不带 center**：那一行摆在视口**顶上**。
//
// 所以这里只回答一件事：**要让点名的那一行落成 core 会落的样子，视口顶该在哪一行** ——
// 也就是那一行**往上让出多少行**。两种模式各一条规则：
//   · 源码模式：让出半个视口，再**往上收一行**（见下）。⚠️ 这个数**不是落点，只是种子**：
//     真正的居中由编辑器自己完成（见 modes.ts 的 centerNamedLine，走 core 同一个原语
//     `scrollIntoView(..., true)`）。种子的用处只有两个 ——
//       ① core 会先按它把视口摆在某处，居中那一步再纠正到真实像素上；两张画面之间的差就是
//          一次跳转里唯一可能被看到的那点抖动，种子靠近最终位置，抖动就小到看不见；
//       ② 居中万一做不到（视图还没建好、编辑器不认那个原语），落点退回种子，「大致中间」
//          总好过贴着顶。
//     **所以别去调这个数**（2026-10-07 用户试过 `-1` → `-2`：真机上没有任何可感差别）：
//     它只喂种子，而差一行本来就落在下游纠正器那 ±2 行的死区里。
//   · 阅读模式：桌面端一行都不让（贴着顶，core 怎么落就怎么落）；**顶上真有东西压着
//     内容时**才让开被压住的那一条（见 topFadeBandPx —— 手机上 Obsidian 的角落布局）。
//
// 这个偏移是**行数**、不是像素：`st.scroll` 是「视口顶那一行」（见 types.ts），栈与恢复
// 全靠它。而**行号在源码模式下换不出精确的像素** —— core 的 `applyScroll` 是拿那一行所在的
// **区块**（`cm.lineBlockAt`）插值出来的（2026-10-07 解包 obsidian.asar 抠到源码）：
//
//     scrollTop = 区块顶 + (块内行偏移 + 小数) × 区块高 ÷ 区块行数
//
// 一篇笔记里行高一不齐（标题、嵌入的图片、折行），「区块高 ÷ 区块行数」就是个平均值，落点
// 于是必然差一点 —— **这就是源码模式的落点不能靠行号算的根因**，也是 core 自己的大纲点击
// 根本不走 `applyScroll`、而走 `scrollIntoView({from, to}, true)`（真实像素几何）的原因。
// 阅读模式那边同理（渲染器按区块插值），只是它的目标仅仅「别贴着顶」，几行的出入无所谓。
//
// 量不到视图（没有滚动容器、还没布局、没有 markdown 视图）时返回 0：退回「顶」。
// 这是导航路径上的冷读，不是轮询里的热读。
export function jumpTopBiasLines(view: MarkdownView | null): number {
	if (!view)
		return 0;
	// 视图还没铺好时量不到任何东西：getScroller 假定这两个根元素都在（一个真的
	// MarkdownView 身上它们恒在），而一个刚构造出来的 / 测试里的空壳身上没有。
	const shaped = view as unknown as { contentEl?: HTMLElement; containerEl?: HTMLElement };
	if (!shaped.contentEl || !shaped.containerEl)
		return 0;
	const scroller = getScroller(view);
	if (!scroller)
		return 0;
	if (view.getMode() === 'preview') {
		const band = topFadeBandPx(shaped.containerEl, scroller);
		if (band <= 0)
			return 0;
		const lineHeight = previewLineHeightPx(scroller);
		// 向上取整：那层渐隐在 `band` 处才刚到全不透明，落在带子里就是「看不见」，
		// 让够一行比差一点强。
		return lineHeight > 0 ? Math.ceil(band / lineHeight) : 0;
	}
	// 源码模式：让半个视口 —— 再**往上收一行**。正中是偏下的：视口 40 行时让 20 行，
	// 那一行上方 20 行、下方只剩 19 行，眼睛读起来就在中线偏下。收一行（19）才是
	// 「中间」。这只给出种子，真正的居中归 centerNamedLine（见文件头）。
	return Math.max(0, Math.floor(visibleLineCount(view, scroller) / 2) - 1);
}

// CM6 EditorView 的最小形状 —— `editor.cm` 是内部的，Obsidian 的类型定义里没有。
interface CmLike {
	state: { doc: { lineAt(pos: number): { number: number } } };
	posAtCoords(coords: { x: number; y: number }): number | null;
	defaultLineHeight: number;
}

// 手机上压在阅读区顶上的那条看不见的带子有多高。
//
// Obsidian 在手机上把顶栏**提成流外的浮层**，内容从它底下滚过，再给内容压一层顶渐隐。
// 两件事的 CSS 条件是**同一条选择器**（解包 obsidian.asar 实测）：
//
//   .is-phone.is-floating-nav, .is-phone.auto-full-screen {
//       --view-header-position: fixed; ... }
//   .is-phone.is-floating-nav { --view-top-fade-mask:
//       linear-gradient(to bottom, rgba(0,0,0,var(--view-top-fade-opacity)) 0%,
//                       #000000 calc(var(--safe-area-inset-top) + var(--view-header-height) + 12px)); }
//
// 后三条常量分别是 `--view-top-fade-opacity: 0.25`、`--view-header-height: var(--touch-size-m)`
// 与那 12px 的余量：从内容区顶边往下「安全区 + 顶栏高 + 12px」那一段最多只有 25% 不透明，
// 落在里面的一行读起来就是「没有」。
//
// ⇒ **「顶栏有没有压着内容」本身就是「有没有那条带子」的判据**，于是这里只量它，一个 CSS
// 变量都不读：
//   · 顶栏被提成浮层时（上面那条选择器）它压着内容，重叠量正好是「安全区 + 顶栏高」，
//     再加那 12px 的余量就是带子的全高。
//   · 顶栏在流里时（桌面端、手机没开浮动导航）内容就从它下面开始，重叠量 ≤ 0 —— 没有带子，
//     一行都不让（`Math.round` 之前先判掉，别让浮点的零点几变成一行）。**这一条不能改成
//     「问平台是不是手机」**：手机的浮动导航是可以关的（`floatingNavigation`，出厂开），
//     关掉之后顶栏回到流里、带子随之消失，按平台一刀切会凭白多让一段。
//
// ⚠️ 也**不要去读 `--safe-area-inset-top` / `--view-header-height`**：两者的值本身还是
// `env()` / `var()` 的引用，真机上 `parseFloat` 出来是 NaN（2026-10-07 的第一版正是这样，
// 看上去和「没做」一模一样）。
const TOP_FADE_MARGIN_PX = 12;

function topFadeBandPx(containerEl: HTMLElement, scroller: HTMLElement): number {
	const header = containerEl.querySelector<HTMLElement>('.view-header');
	if (!header)
		return 0;
	const rect = header.getBoundingClientRect();
	if (rect.height <= 0)
		return 0;
	const overlap = rect.bottom - scroller.getBoundingClientRect().top;
	if (overlap <= 0)
		return 0;
	return Math.round(overlap) + TOP_FADE_MARGIN_PX;
}

function lengthPx(value: string): number {
	const n = parseFloat(value);
	return Number.isFinite(n) ? n : 0;
}

// 阅读视图里一行有多高。`line-height: normal` 时退回字号的一个常用倍数。
function previewLineHeightPx(scroller: HTMLElement): number {
	const styles = getComputedStyle(scroller);
	const lineHeight = lengthPx(styles.lineHeight);
	if (lineHeight > 0)
		return lineHeight;
	const fontSize = lengthPx(styles.fontSize);
	return fontSize > 0 ? fontSize * 1.6 : 0;
}

// 源码视图的视口里此刻有几行。编辑器答得出就由它答（问视口上下沿各自落在哪一行）；
// 答不出就按视口高除以行高估一个。都量不到时返回 0 —— 调用方会退回「不让」。
function visibleLineCount(view: MarkdownView, scroller: HTMLElement): number {
	const rect = scroller.getBoundingClientRect();
	if (rect.height <= 0)
		return 0;
	const cm = (view.editor as unknown as { cm?: CmLike }).cm;
	if (!cm?.state?.doc)
		return 0;
	const x = rect.left + rect.width / 2;
	const top = lineAtPoint(cm, x, rect.top + 2);
	const bottom = lineAtPoint(cm, x, rect.bottom - 2);
	if (top !== null && bottom !== null && bottom >= top)
		return bottom - top + 1;
	return cm.defaultLineHeight > 0 ? Math.round(rect.height / cm.defaultLineHeight) : 0;
}

// 一个屏幕坐标落在哪一行（0-based）。坐标落到文档之外时编辑器答 null。
function lineAtPoint(cm: CmLike, x: number, y: number): number | null {
	try {
		const pos = cm.posAtCoords({ x, y });
		return pos === null ? null : cm.state.doc.lineAt(pos).number - 1;
	} catch {
		return null;
	}
}
