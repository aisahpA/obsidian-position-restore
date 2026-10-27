import { App, Editor, MarkdownView, View, WorkspaceLeaf } from 'obsidian';

// 位置核心与导航功能共用的一小把 leaf 工具。放这儿而不是 nav/entry，是为了让位置核心
// 不必依赖导航。

// 只有主区的 leaf 会记成导航记录。侧边栏面板（大纲、反向链接、局部图谱）自己在 view state 里
// 就跟着当前文件走，把它记下来只会造出一条幽灵记录 —— 跳过去不过是把面板重新聚焦一次。
export function isMainAreaLeaf(app: App, leaf: WorkspaceLeaf): boolean {
	const root = app.workspace.rootSplit as { containerEl?: HTMLElement } | undefined;
	const el = (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
	return !!root?.containerEl && !!el && root.containerEl.contains(el);
}

// 悬停浮层里托着的真 leaf —— 把预览变成可编辑面板的插件会这么做。它是「预览」，不是读者打开的
// 窗格：在里面恢复位置会让这张卡片停在没人要看的那一行，而随恢复而来的打开保护窗口还要把它
// 压着空白到落位结束。
export function isPopoverLeaf(leaf: WorkspaceLeaf): boolean {
	const el = (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
	return !!el && !!el.closest?.('.hover-popover');
}

// 此刻正显示着某个路径的 markdown 视图（如果有）—— 这是唯一能把笔记的行读成「读者手上那份」
// 的地方，存没存都一样：编辑器比磁盘多出读者刚敲进去的内容。
export function markdownViewFor(app: App, path: string): MarkdownView | undefined {
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view as MarkdownView | undefined;
		if (view?.file?.path === path && typeof view.editor?.getLine === 'function')
			return view;
	}
	return undefined;
}

// 读者正站在的那个视图 —— 站在视图之外的控件（命令、面板脚下的箭头）该作用的对象。
//
// 活动 leaf 在主区里，就是它；否则（读者刚点了侧边栏面板，或活动的是本插件自己的列表）
// 退回**最近用过的那个主区 leaf**。不退回任何一个后台标签页：一个「跳到两端」的动作不该动
// 读者看不见的东西。`getActiveViewOfType` 只看活动 leaf，而读者一碰面板，激活的就变成面板
// 本身 ⇒ 那道退回正是箭头能被按下去的全部原因。
//
// 故意不限定 markdown：第三方视图也可以站在主区里，而两端命令要作用的正是它。
export function viewInUse(app: App): View | undefined {
	const active = app.workspace.getActiveViewOfType(View);
	if (active && !isSidebarView(app, active) && !isDeferredLeaf(active.leaf) && !isPopoverLeaf(active.leaf))
		return active;
	let best: View | undefined;
	let latest = -1;
	app.workspace.iterateAllLeaves((leaf) => {
		// 预览是一张卡片，不是读者打开的窗格；延迟标签页是个占位符，照着存下来的 state
		// 回答视图的问题。
		if (isDeferredLeaf(leaf) || isPopoverLeaf(leaf))
			return;
		if (!isMainAreaLeaf(app, leaf))
			return;
		const at = (leaf as unknown as { activeTime?: number }).activeTime ?? 0;
		if (at > latest) {
			latest = at;
			best = leaf.view;
		}
	});
	return best;
}

// 停靠在左右侧栏里的视图不是读者「正看着的正文」（大纲、反向链接、本插件自己的列表都在
// 那儿）。弹出窗口不算侧栏 —— 它有自己的窗口，也就不在主窗口的任何一侧。
//
// 这条判据只看 DOM，与 `isMainAreaLeaf` 共用同一类事实；分开写是因为「活动的那个」与
// 「主区里最近用过的那个」问的不是同一个问题。
function isSidebarView(app: App, view: View): boolean {
	const ws = app.workspace as unknown as {
		leftSplit?: { containerEl?: HTMLElement };
		rightSplit?: { containerEl?: HTMLElement };
	};
	const el = view.containerEl;
	if (!el)
		return true;
	return !!(ws.leftSplit?.containerEl?.contains(el) || ws.rightSplit?.containerEl?.contains(el));
}

// 第三方视图里的光标：公开 API 里唯一能拿到「那个视图的编辑器」的通道，是视图自己把它挂到
// `workspace.activeEditor` 上（d.ts 的 `MarkdownFileInfo`；youtnote 就挂了）。
//
// 严格得近乎偏执，因为它动的是别人家的编辑器：
//   · 活动视图必须**就是**这个视图 —— 读者还站在这儿，那条 activeEditor 不是上一刻的残留；
//   · 文件必须对得上 —— 同一个文件开在两个地方时，要的不是那一个；
//   · 它报的滚动几何必须对得上一个**在这个视图里**的正文容器 —— 这才证明这个编辑器就是我们
//     要找的那一个。那个容器可以就是滚动的那个（markdown 式），也可以是它里面的 `.cm-scroller`
//     （youtnote 式：编辑器随内容长高、真正滚的是外面的 notes-list）。两种都要求几何相等，
//     所以「猜一个编辑器碰碰运气」仍然过不了这一关。
// 任何一条不成立就返回 undefined：只滚，不动光标。
export function editorForView(app: App, view: View, scroller: HTMLElement): Editor | undefined {
	const active = app.workspace.activeEditor;
	const editor = active?.editor;
	if (!editor)
		return undefined;
	if (app.workspace.getActiveViewOfType(View) !== view)
		return undefined;
	const file = (view as unknown as { file?: { path?: string } } | null)?.file;
	if (!file?.path || active?.file?.path !== file.path)
		return undefined;
	let info: { height?: number; clientHeight?: number } | undefined;
	try {
		info = editor.getScrollInfo() as unknown as { height?: number; clientHeight?: number };
	} catch {
		return undefined;
	}
	if (!info)
		return undefined;
	const sameGeometry = (el: HTMLElement) =>
		Math.abs((info?.height ?? 0) - el.scrollHeight) <= 1
		&& Math.abs((info?.clientHeight ?? 0) - el.clientHeight) <= 1;
	if (sameGeometry(scroller))
		return editor;
	for (const inner of Array.from(scroller.querySelectorAll<HTMLElement>('.cm-scroller, .markdown-preview-view'))) {
		if (sameGeometry(inner))
			return editor;
	}
	return undefined;
}

// 取一个 leaf 的 id。这是运行期才有的字段，公开类型里没有 —— 和上面那几处是同一种 cast。
export function leafIdOf(leaf: WorkspaceLeaf): string {
	return (leaf as unknown as { id: string }).id;
}

// 视图给自己起的名字 —— 也就是它标签头部印的那串。`getDisplayText` 是 app 自己留的通道，
// 所以第三方视图不必让本插件知道它存在，也能报上自己的名字。
//
// 空出来是「没有名字」，而不是「名字是空的」：一行对没起过名字的视图有自己的说法。包 try 是因为
// 这是在 workspace 事件回调里调别人的方法 —— 这里一抛异常，连切换标签页都会一起挂掉。
export function viewLabel(view: View | undefined): string | undefined {
	if (!view)
		return undefined;
	try {
		const label = view.getDisplayText();
		return typeof label === 'string' && label ? label : undefined;
	} catch {
		return undefined;
	}
}

// 视图给自己配的图标，给代表它的那一行画标记用。同一个通道、同样的保护。
//
// 取不到是「没有图标」，不要替它填一个默认图标：app 这个构建版本不认识的图标 id 只会画出
// 一格空白，而一格空白比一个词说的还少。
export function viewIcon(view: View | undefined): string | undefined {
	if (!view)
		return undefined;
	try {
		const icon = view.getIcon();
		return typeof icon === 'string' && icon ? icon : undefined;
	} catch {
		return undefined;
	}
}

// 视图还没真正建起来的 leaf：workspace 恢复标签页时先放一个占位符，它照着存下的 state 来回答
// 视图的问题 —— 而这个占位符不是视图自己的类，所以对笔记的标签页来说 `instanceof FileView`
// 是 false（手机回到某个标签页就是这样的）。仅运行期存在，公开类型里没有。
export function isDeferredLeaf(leaf: WorkspaceLeaf | null | undefined): boolean {
	return !!(leaf as unknown as { isDeferred?: boolean } | null | undefined)?.isDeferred;
}

// app 现在还能不能造出这个视图。每种类型在工厂表里有一条记录；查不到的类型（插件被关掉、卸载、
// 或还没加载）会得到一个「自称是它」的占位窗格 —— 读者永远回不去的地方。读取失败、或这个构建
// 版本没暴露这张表，一律回答「没缺」：这个调用只可能用来排除，所以丢掉它最坏的结果是退回现状，
// 而不是从此什么都记不下来。
export function viewTypeIsMissing(app: App, viewType: string): boolean {
	const registry = (app as unknown as {
		viewRegistry?: { getViewCreatorByType?: (type: string) => unknown };
	}).viewRegistry;
	if (!registry?.getViewCreatorByType)
		return false;
	try {
		return !registry.getViewCreatorByType(viewType);
	} catch {
		return false;
	}
}

// 这个 FileView 是不是那篇笔记的目的地。FileView 也可能只是跟着它正在看的笔记走 —— 大纲、
// 反向链接、局部图谱、文件属性 —— app 把这个区别记在一个只在运行期存在、公开类型里没有的标记里。
// 这些能用 FileView 的每一个问题来回答自己在主区哪儿也不算？不：在主区只有这个标记能分辨它们
// （把它们记成这篇笔记的代价见 nav/funnel.ts：会给读者从没去过的笔记多出一行）。
//
// 只有 `false` 才算排除：万一某个构建版本把这字段改名或删了，读到的是 undefined，那时若回答
// 「不是文件」，会把所有真正的文件视图一起带走。
export function isFileDestination(view: View): boolean {
	return (view as unknown as { navigation?: boolean }).navigation !== false;
}

// 延迟占位符所代表的文件，从它恢复时用的 state 里读出来：这个标签页仍然是那篇笔记，把它记成
// 视图就会凭空造出一个背后没有文件的地点。
export function deferredFilePath(view: View | undefined): string | undefined {
	const file = viewState(view)?.file;
	return typeof file === 'string' && file ? file : undefined;
}

// 单个视图的 state 最多能占多少存储，按序列化后的长度算。它挤占的那份数据是整张地点列表
// （places-store.ts），所以某个插件把自己的缓存塞进 view state 也吃不掉这份预算。
const VIEW_STATE_MAX_BYTES = 2048;

// 读者在场时那个视图的 state —— 标签页没了的时候，地点就是拿它重建的
// （`setViewState({ type, state })`）。这是视图身上唯一事后推不出来的东西。
//
// 这个 JSON 往返还有一层容易被忽略的作用：它留下的是一份副本。视图会一直改自己的 state 对象，
// 一行要是攥着引用就会跟着漂 —— 那样重放这个地点会把读者送到视图此刻碰巧所在的地方。
export function viewState(view: View | undefined): Record<string, unknown> | undefined {
	if (!view)
		return undefined;
	try {
		const raw = view.getState();
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			return undefined;
		const json = JSON.stringify(raw);
		if (!json || json === '{}' || json.length > VIEW_STATE_MAX_BYTES)
			return undefined;
		const copy = JSON.parse(json) as unknown;
		return copy && typeof copy === 'object' && !Array.isArray(copy)
			? copy as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}
