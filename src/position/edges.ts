import { MarkdownView } from 'obsidian';
import { getScroller, nextPaint } from '@/shared/wait';

// 一篇笔记的两端。两端的哪一个，app 都没有命令：Ctrl+Home / Ctrl+End 是编辑器按键，
// 而且只在桌面端有 —— 手机上根本没有办法要求到一个端点。
//
// 端点**显示**在哪儿不是可选项，这是关于它唯一值得一说的事：第一行与最后一行就坐在可滚动
// 范围的两端，所以把它们居中、或在它们上面留出上下文，落点一模一样 —— 滚动容器会夹住。
// 真正由我们决定的是光标（编辑器键会移动它，滚动不会）与那一步（见 manager.goToEdge）。
export type NoteEdge = 'top' | 'bottom';

// 阅读渲染器会把它在一次移动**之前**捕获到的滚动，晚一趟渲染重新应用：读者自己那次滚动
// 排队的那趟，在命令已经跑完之后才结束，而它手里握着的值是读者原来所在的位置 —— 于是有了
// 顶部那一闪与滑回去。插件自己的恢复流水线也撞上过这个、并且用同样的方式回答它
// （见 pixels.ts）：检查位置有没有**守住**，没守住就放回去。这里的剂量更小，因为命令背后
// 没有遮罩可以藏这场拉锯：两次纠正，收工。
const HOLD_MAX_MS = 400;
const HOLD_CORRECTIONS = 2;

// 表示读者在自己动手的输入 —— 到这一步，这次保持就是在跟**他们**较劲。
const YIELD_EVENTS = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;

// 等阅读渲染器说得出自己在哪儿，最多等几帧（见下）。
const SYNC_TRIES = 3;

// app 的反向链接面板是**追加在同一个滚动容器内部**的 —— 阅读模式：渲染器的页脚区；源码
// 模式：那个撑高元素 —— 所以视图能滚到的最远处是那个面板的末尾，而一个比窗口还高的面板，
// 会让笔记的最后一行完全落在视口上方。它是**标签页**的面板，不是笔记的，所以它不属于
// 任何一端。
const BACKLINKS_SELECTOR = '.embedded-backlinks';

// app 自己的那些条是**浮在**笔记脚部之上，而不是坐在它上面或下面，所以手机上窗口的底部
// 并不是读者能看到的区域的底部。两者都只在移动端，这正是它在桌面端量不出任何东西的原因。
const OVERLAY_SELECTORS = ['.mobile-navbar', '.mobile-toolbar'];

// 亚像素偏移与缩放意味着落点很少正好等于要求的那个数。
const EDGE_EPSILON = 1;

// 已经站在那个端点上了 —— 只是答案里**滚动**的那一半。否则连按两次的命令会把同一次到达
// 记两遍，而「后退」就得按同样多次才回得到读者原来的位置。
export function atEdge(view: MarkdownView, edge: NoteEdge): boolean {
	const el = getScroller(view);
	return !!el && isAtEdge(el, edge);
}

// **光标**那一半：`caretToEdge` 会不会改变什么。一个视图可以在光标还在下面 200 行时显示
// 笔记顶部，而要求到顶部的读者是想把它移上去 —— 所以「无事可做」是滚动与光标**都**同意，
// 不是只看滚动（见 manager.goToEdge）。
export function caretAtEdge(view: MarkdownView, edge: NoteEdge): boolean {
	const editor = view.editor;
	if (!editor)
		return true;
	const at = editor.getCursor();
	if (edge === 'top')
		return at.line === 0 && at.ch === 0;
	const last = editor.lastLine();
	return at.line === last && at.ch >= (editor.getLine(last) ?? '').length;
}

export function moveToEdge(view: MarkdownView, edge: NoteEdge): void {
	caretToEdge(view, edge);
	const el = getScroller(view);
	if (el)
		applyEdge(el, edge);
}

// 移动之后再保持这个端点一小会儿。纠正与移动是同一次写入，所以没被顶掉的读者根本看不到
// 纠正；保持到一半就被关掉的 leaf、或从文档上脱链的滚动容器，都会把它结束掉。
export async function holdEdge(view: MarkdownView, edge: NoteEdge): Promise<void> {
	const el = getScroller(view);
	if (!el)
		return;
	let yielded = false;
	const onInput = () => {
		yielded = true;
	};
	for (const type of YIELD_EVENTS)
		el.addEventListener(type, onInput, { capture: true, once: true });
	try {
		const deadline = Date.now() + HOLD_MAX_MS;
		let corrections = 0;
		while (!yielded && el.isConnected && Date.now() < deadline) {
			await nextPaint();
			if (yielded || !el.isConnected || isAtEdge(el, edge))
				continue;
			if (++corrections > HOLD_CORRECTIONS)
				return;
			applyEdge(el, edge);
		}
	} finally {
		for (const type of YIELD_EVENTS)
			el.removeEventListener(type, onInput, { capture: true });
	}
}

// 切模式不从 DOM 续上：setMode() 带的是 `view.scroll`，而它只有 view.syncScroll() 会填 ——
// 阅读视图又只在上一趟渲染至少 100ms 之前时，才会从它自己的滚动处理器里调那个 —— 而滚动
// 一个虚拟化的预览永远不满足这个条件。所以在这里做的一次移动对切换是不可见的，再切回编辑
// 就会把笔记放回读者**执行命令之前**站的地方。阅读视图在 resize 时重新应用的也是同一个
// 字段。
export async function syncViewScroll(view: MarkdownView): Promise<void> {
	for (let tries = 0; tries < SYNC_TRIES; tries++) {
		const at = view.currentMode?.getScroll();
		// 阅读渲染器还没跟上时是 null：等一帧，而不是把一个并不代表笔记位置
		// 的数字交给切换。
		if (at != null && Number.isFinite(at)) {
			// setMode() 自己走的那扇门：它设好这个字段**并且**移动当前模式，对我们
			// 来说就是重新应用一遍已经持有的位置。
			view.setEphemeralState({ scroll: at });
			return;
		}
		await nextPaint();
	}
}

// 笔记**不再**是笔记的地方，按内容坐标算。
function noteEnd(el: HTMLElement): number {
	const aside = el.querySelector<HTMLElement>(BACKLINKS_SELECTOR);
	if (!aside)
		return el.scrollHeight;
	const box = aside.getBoundingClientRect();
	// 它自己没有盒子：设置关掉时，这个面板是隐藏着创建、被清空的，它的矩形会塌缩 ——
	// 否则塌缩的矩形会被读成「笔记在顶部就结束了」。
	if (box.width <= 0 || box.height <= 0)
		return el.scrollHeight;
	const top = box.top - el.getBoundingClientRect().top + el.scrollTop;
	return top > 0 ? top : el.scrollHeight;
}

// 窗口脚部有多少是读者看不到的。靠**实测**而不是读某个变量：那里是哪条 bar 取决于模式，
// 而软键盘会挪动当前那条。
function hiddenAtBottom(el: HTMLElement): number {
	const box = el.getBoundingClientRect();
	// 完全没有盒子（视图还没进布局）：不可能有东西盖着它。
	if (box.height <= 0)
		return 0;
	let hidden = 0;
	for (const selector of OVERLAY_SELECTORS) {
		for (const bar of Array.from(el.ownerDocument.querySelectorAll<HTMLElement>(selector))) {
			const over = bar.getBoundingClientRect();
			// 没伸到窗口脚部：一条浮在笔记**中部**之上的 bar，两端都不占。
			if (over.height <= 0 || over.bottom < box.bottom)
				continue;
			if (over.right <= box.left || over.left >= box.right)
				continue;
			hidden = Math.max(hidden, Math.min(box.bottom, over.bottom) - Math.max(box.top, over.top));
		}
	}
	return Math.max(0, Math.min(hidden, box.height));
}

// 笔记底部该在的位置：最后一行落在窗口里读者**看得见**的那部分的底部。要求的超过范围本身
// 时就夹住，正因如此，最后一屏无论多高都会待在那里。
function bottomTarget(el: HTMLElement): number {
	const furthest = Math.max(0, el.scrollHeight - el.clientHeight);
	const shown = el.clientHeight - hiddenAtBottom(el);
	return Math.max(0, Math.min(furthest, Math.round(noteEnd(el) - shown)));
}

function edgeTarget(el: HTMLElement, edge: NoteEdge): number {
	return edge === 'top' ? 0 : bottomTarget(el);
}

function isAtEdge(el: HTMLElement, edge: NoteEdge): boolean {
	// 落点本身，不是「到了或超过了」：一个滚过笔记末尾、滚进反向链接面板的读者，是过了
	// 笔记的末端，再要一次得把他们带回来。
	return Math.abs(el.scrollTop - edgeTarget(el, edge)) <= EDGE_EPSILON;
}

function applyEdge(el: HTMLElement, edge: NoteEdge): void {
	el.scrollTop = edgeTarget(el, edge);
}

// 编辑器键会留下的那个光标：第一行行首，或最后一行的行尾。
// **两种**模式都给一个：阅读视图不显示光标，但 `view.editor` 是它的编辑模式，随 leaf 一起
// 建出来、留在预览背后 —— 而切换模式会把滚动与折叠带过去，从不带选区。在这里放好它，正是
// 让「先到阅读模式、之后才切过来」的读者得到第一行光标的原因。它也正是「要求一个端点」与
// 「要求一次滚动」的区别所在。
export function caretToEdge(view: MarkdownView, edge: NoteEdge): void {
	const editor = view.editor;
	if (!editor)
		return;
	const line = edge === 'top' ? 0 : editor.lastLine();
	editor.setCursor({ line, ch: edge === 'top' ? 0 : editor.getLine(line).length });
}
