import { App, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { NavEntryState } from '@/types';
import { PositionState, LANDING_ABSORB_MS } from '@/position/state';
import { readNavEntryState } from '@/position/capture/ephemeral';

// 漏斗要用到的两个调用，在这里声明一遍，是为了让本模块不依赖别的东西。
export interface OutlineCaptureHost {
	state: PositionState;
	leave(path: string, leafId: string, st: NavEntryState): void;
	recordOpen(path: string, leafId: string, opts: { key: string }): void;
}

// 阅读模式下点大纲，其它采集路径都看不见：core 把一次条目点击解析成
// setActiveLeaf + setEphemeralState({line}) —— 既没有 openLinkText，也没有 setViewState，
// 而预览模式下没有光标可供轮询去推断 teleport。源码模式**也**在这里采集：本钩子压入带 key 的
// 记录，它同时撑开的落地吸收窗口会把紧随其后的光标跳变挡在门外，所以点一次恰好压入一条记录。
// 监听器跑在 workspace 根节点的捕获阶段，也就是 core 的处理器之前 —— 正因为如此才能让
// refreshTop 看到点击之前的位置。
// 每一步解析都静默降级：未知的 DOM、找不到大纲、目标 leaf 无法确定 ⇒ 剩下的交给常规管线。
export function installOutlineCapture(
	app: App,
	host: OutlineCaptureHost,
	registerCleanup: (fn: () => void) => void,
): void {
	const onClick = (ev: MouseEvent) => {
		if (!(ev.target instanceof HTMLElement))
			return;
		// 折叠箭头会在下游 preventDefault 掉 core 的跳转，但本监听器跑在那之前 ——
		// 所以这里先把它排除掉。
		if (ev.target.closest('.collapse-icon'))
			return;
		// 只认大纲树的条目：这样就把面板的搜索框与工具栏排除掉了。
		const selfEl = ev.target.closest('.tree-item-self.is-clickable');
		const contentEl = selfEl?.closest('.workspace-leaf-content[data-type="outline"]');
		if (!selfEl || !contentEl)
			return;
		// 一个视图的 containerEl 就是 workspace-leaf-content 这个元素。
		let outlineLeaf: WorkspaceLeaf | undefined;
		app.workspace.iterateAllLeaves((leaf) => {
			if (!outlineLeaf && leaf.view.getViewType() === 'outline'
				&& leaf.view.containerEl === contentEl)
				outlineLeaf = leaf;
		});
		const outlineFile = (outlineLeaf?.view as unknown as { file?: unknown })?.file;
		if (!(outlineFile instanceof TFile))
			return;
		// 跳转落到哪个 leaf —— 这里照着 core 的 findCorrespondingLeaf 来：先找关联的窗格分组，
		// 找不到再看正在跟踪同一个文件的、处于激活状态的 markdown 视图。都匹配不上说明 core 会
		// 重新打开这个文件；那次打开已经由 setViewState 那条管线记录了。
		// （leaf.group 是运行期才有的字段，公开类型里没有。）
		const group = (outlineLeaf as unknown as { group?: string } | undefined)?.group;
		let view: MarkdownView | undefined;
		if (group) {
			for (const leaf of app.workspace.getGroupLeaves(group)) {
				const v = leaf.view;
				if (v instanceof MarkdownView && v.file === outlineFile) {
					view = v;
					break;
				}
			}
		} else {
			// 这里必须走 getActiveFileView，而不是 getActiveViewOfType：点击的 pointerdown
			// 会先聚焦大纲 leaf，所以严格按「聚焦」取值的 getActiveViewOfType 此时返回 null，
			// 这次跳转就永远记不下来了。getActiveFileView 会退回到最近激活过的那个**文件**视图。
			const active = (app.workspace as unknown as {
				getActiveFileView?: () => unknown;
			}).getActiveFileView?.();
			if (active instanceof MarkdownView && active.file === outlineFile)
				view = active;
		}
		if (!view || !view.file)
			return;
		// 「离开时更新」时给出点击之前的精确位置（此刻还没滚动），
		// 这样以后按后退才会落回用户真正在过的地方。
		const leafId = host.state.leafId(view.leaf);
		const fromSt = readNavEntryState(view);
		if (fromSt)
			host.leave(view.file.path, leafId, fromSt);
		// key = 标题文字：反复点同一个标题会去重，换一个标题则压栈 —— 这是锚点链接那套 key 语义。
		// 取不到文字 ⇒ 没有 key ⇒ 跳过（一条不带 key 的记录会把之后的每一次点击都错误地吸收掉）。
		const heading = selfEl.querySelector('.tree-item-inner')?.textContent?.trim();
		if (heading) {
			host.recordOpen(view.file.path, leafId, { key: `outline:${heading}` });
			// 撑开落地吸收窗口（与 open 类跳转同一套契约）：core 异步地解析这次跳转，
			// 采集必须一直处在吸收状态直到它落定 —— 落定那一刻的读取会成为这条记录精确的落地。
			// 什么都没记录时不撑开：那样落定时的采集会覆盖掉与之无关的栈顶记录。
			host.state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;
		}
	};
	app.workspace.containerEl.addEventListener('click', onClick, { capture: true });
	registerCleanup(() =>
		app.workspace.containerEl.removeEventListener('click', onClick, { capture: true }));
}
