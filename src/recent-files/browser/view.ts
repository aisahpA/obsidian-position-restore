// 最近文件面板作为**常驻**侧栏：与模态框同一个主体（见 body.ts），站在一个工作区 leaf 里、
// 而不是对话框里。
//
// 它为什么与模态框并存：模态框回答一次「我刚才在哪儿，带我去」就关闭。一个反复这样做的
// 读者，每次跳都要付一次打开、一次阅读、一次关闭，而那个本该帮他的面板，恰是他工作时
// 唯一看不到的东西。常驻之后，同一份列表是工作区里的一个地方：它待在他们放它的地方，
// 一次行进把它留在原地站着。
//
// 这个外壳**拥有**的东西，仅此而已：leaf 的生命期、样式表所读的那些 class，以及在
// 一次行进之后（手机上）让开路（见 standAside）。
//
// 它是一个**视图**、而不是浮动面板，好让 Obsidian 自己的机制去做其余的事：leaf 会跨重启
// 记住它在布局里的位置，它可以被拖到另一侧侧栏或主区域，它服从窗格自己的「关闭」，
// 而 `revealLeaf` 会把它带回来。

import { App, ItemView, Menu, Platform, WorkspaceLeaf } from 'obsidian';
import { navGroupKey } from '@/nav/entry';
import { PlaceList } from '@/recent-files/places';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { RecentFilesBrowser, RecentFilesBrowserPrefs } from './body';
import type { RecentFilesBrowserArrows } from './arrows';
import { NAV_SOURCE_ID, PANEL_EXIT_GRACE_MS } from './constants';

// 它也是面板在 app 悬停预览体系里应答用的名字（见 constants.ts 的 NAV_SOURCE_ID）：
// 对话框也用它，所以在那里和这里悬停一行，对 app 来说是同一个名字。这也正是改这个字符串
// 会把一个保存下来的侧栏变成孤儿的原因：它是一个持久的 id，然后才是一个标签。
export const RECENT_FILES_VIEW_TYPE = NAV_SOURCE_ID;

export class RecentFilesView extends ItemView {
	// 两者都是这个视图自己的：模态框没有相应的东西，因为没有任何东西比对话框活得久。
	private browser: RecentFilesBrowser | null = null;
	private unsubscribe: (() => void) | null = null;
	// 定时器**就是**那个标志 —— 只有在它立着的时候才是在等某件事过去 —— 而它会随面板一起
	// 清掉，所以一个已关闭的视图绝不会再被画进去。
	private suspendTimer?: number;
	// 面板一走后，用**一次**重画补齐，无论离开的路上到了多少变化：一个没人在看的面板，
	// 不欠每次变化一次重画，它欠的是一份在再次被看时是**真**的列表。
	private missedRender = false;

	constructor(
		leaf: WorkspaceLeaf,
		// 面板唯一的数据来源。前进/后退的栈**不**在这里 —— 这个窗格列的是地点，
		// 而每一个都按照它自己的记录所说的方式行进。
		private places: PlaceList,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// 插件拥有并持久化这些；这个外壳只是把它们往下交。
		private prefs: RecentFilesBrowserPrefs,
		// 四个箭头：后退与前进各一步，以及读者打开的那篇笔记的两端。每个外壳都画它们，
		// 而且是往下交、而不是自己留着 —— 那些步是历史的、那篇笔记是工作区的
		// （见 RecentFilesBrowserArrows）。
		private arrows: RecentFilesBrowserArrows,
	) {
		super(leaf);
	}

	getViewType(): string {
		return RECENT_FILES_VIEW_TYPE;
	}

	// 不是给面板起的第二个名字：它里面的工具栏什么都不命名，而窗格是读者找它的地方
	// （见 modal.ts，它设的也是同一个字符串）。
	getDisplayText(): string {
		return t('recentFiles.name');
	}

	// 一个时钟，因为各行是按它们上次被坐进去的**时间**排序的。不用 'list'：
	// 那是大纲的图标，借它过来会让两个窗格顶着同一个标记。
	getIcon(): string {
		return 'clock';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('position-restore-nav-panel', 'position-restore-nav-view');
		// 触摸布局是关于这个窗格的一个事实，而不是关于它所在的房间的。
		if (Platform.isMobile)
			this.contentEl.addClass('is-touch');
		this.browser = new RecentFilesBrowser({
			app: this.app,
			places: this.places,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			// 这份列表只认点击，与对话框里完全一样（见 list.ts）：没有任何东西会跟随一个只是从它
			// 上面经过的指针。**设备**仍然为它自己的工效学作答。
			touch: Platform.isMobile,
			// 一次行进从一份清空的列表开始：它会重排各行（被访问的地点移到末尾），所以被指着的那一行
			// 即将在同一个槽位里代表一个不同的地点（见 RecentFilesList.collapse）。
			collapseOnJump: true,
			// 手机上，面板自己让开路：常驻面板在那里是盖住整个屏幕的抽屉，所以一行在它背后打开
			// 一篇笔记，看起来就像一行什么都没做。
			onJump: () => this.standAside(),
			// 常驻面板是**随工作区一起**恢复的，所以把光标从编辑器里拿走不是读者要的事。
			focusFilter: false,
			arrows: this.arrows,
			prefs: this.prefs,
		});
		this.browser.mount();
		this.unsubscribe = this.places.subscribe(() => this.hearPlaces());
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.browser?.destroy();
		this.browser = null;
		// 无论它之前是为了什么压着一次重画，它都不再立着了：一个比视图活得还久的定时器，
		// 会画进一个已经被拆掉的主体里。
		this.stopSuspending();
	}

	// 在设置标签页里改的一项偏好，是由主体实时读的，所以一个开着的面板要展示刚选的那个答案，
	// 只需要这么多。是问面板、而不是推进它，因为它到底有没有立着是工作区的事
	// （见 PositionManager.refreshNavPanels）。
	refresh(): void {
		this.browser?.render();
	}

	// **标签页自己的菜单** —— app 在标签页上右键、以及窗格的「更多选项」时会升起它，
	// 并把它交给视图去添东西（app 自己的视图用来加「关闭」和「切换阅读视图」的那扇门）。
	// app 放在那里的是关于**窗格**的；这个面板添加的是关于**列表**的。
	//
	// **一个**条目，而且只在有东西可拿走时：一个会清空不了任何东西的条目，比一个根本不在的
	// 条目更糟（见 body.ts 的 pinItems）。它清空**整份**列表、让钉选块继续立着 ——
	// 那是读者亲手搭起的一个搁板（见 NavPlaces.clear）。不做任何确认：走掉的是他们去过的
	// 地方，不是一个文件，而一篇被再次打开的笔记会把它那一行要回来。
	onPaneMenu(menu: Menu): void {
		if (!this.clearable())
			return;
		menu.addItem(item => item
			.setSection('action')
			.setTitle(t('recentFiles.clearList'))
			// app 自己用来清空历史的字形 —— web viewer 的「清除历史」就站在这个菜单里。
			// 一个承诺，一个标记。
			.setIcon('eraser')
			.onClick(() => this.places.clear()));
	}

	// 一次清空会不会拿走任何东西：熬过它的是钉选块，所以一份全是钉选的列表没什么可清的了。
	private clearable(): boolean {
		return this.places.entries.some(e => !this.places.isPinned(navGroupKey(e)));
	}

	// 一个读者仍看得见的面板会当场再画一次；一个正在离开的不会（见 suspendRedraws）——
	// 它在走后被画一次。
	private hearPlaces(): void {
		if (this.suspendTimer !== undefined) {
			this.missedRender = true;
			return;
		}
		this.browser?.render();
	}

	// 手机上的一次行进：面板让开路，它留在身后的那份列表也让开 —— 对读者来说是一件事，
	// 所以这里是同一个反应。抽屉先合上（见 dismissOnMobile），因为那正是回答
	// 「为什么好像什么都没发生」的那一半。然后列表停止被画，因为行进会立刻重排它，
	// 而一份在离开的路上自己洗牌的列表，是没人要的变化。
	//
	// 桌面上两者都不发生：面板站在它刚打开的笔记旁边，而那次重排**就是**答案 ——
	// 他们瞄准的那一行爬到顶部，并带着「你在这里」标记一起。
	private standAside(): void {
		if (!Platform.isMobile)
			return;
		// 菜单**最先**走：它是从这个面板的某一行升起的、站在文档上，所以 app 没法听到面板正在
		// 离开 —— 合上一个抽屉不是它据以把菜单从屏幕上拿掉的那些手势之一
		// （见 RecentFilesBrowser.closeMenu）。
		this.browser?.closeMenu();
		this.dismissOnMobile();
		this.suspendRedraws();
	}

	// 面板在这几百毫秒里会画的东西，没有一样值得画：读者的注意力已经跟着他打开的笔记走了。
	// 面板欠的是一份在抽屉被再次拉开时是**真**的列表 —— 而无论到了多少变化，**一次**重画
	// 就能兑现这一点，因为列表是从当时地点的样子画的（见 RecentFilesBrowser.render）。
	private suspendRedraws(): void {
		// 同一个窗口期内的第二次行进会重启它、而不是叠加第二个定时器：一个面板只有一个出口。
		this.stopSuspending();
		this.suspendTimer = window.setTimeout(() => {
			this.suspendTimer = undefined;
			if (!this.missedRender)
				return;
			this.missedRender = false;
			this.browser?.render();
		}, PANEL_EXIT_GRACE_MS);
	}

	private stopSuspending(): void {
		if (this.suspendTimer === undefined)
			return;
		window.clearTimeout(this.suspendTimer);
		this.suspendTimer = undefined;
		this.missedRender = false;
	}

	// 面板本身**留在**布局里 —— 折叠不是关闭，而把它放哪儿是读者的事。手机上的抽屉**就是**
	// leaf 的父级，所以不存在它在哪一侧的问题 —— 而它是按**形状**检查的，绝不用 `instanceof`。
	//
	// 这不是一个风格偏好：类型定义里声明了 WorkspaceMobileDrawer，但一个只有类型定义的包
	// 并不是 app 的运行时模块，而对一个打包产物并不导出的名字做 `instanceof` 会**抛异常** ——
	// 而这段代码是外壳对一次行进的反应，所以结果是手机上这个面板对点击一概不应答。
	private dismissOnMobile(): void {
		const parent = this.leaf.parent as unknown as
			{ collapsed?: boolean; collapse?: () => void } | undefined;
		if (parent?.collapsed === false && typeof parent.collapse === 'function')
			parent.collapse();
	}

}

// 把面板升起来，或把它带回来：面板是一个**地方**，所以第二次调用必须找到已经开着的那个，
// 而不是打开同一份列表的第二份拷贝（同一段历史的两块面板、各有各的筛选，是一种会显示
// 两个答案的做法）。
export async function activateRecentFilesView(
	app: App,
	places: PlaceList,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: RecentFilesBrowserPrefs,
): Promise<void> {
	const existing = app.workspace.getLeavesOfType(RECENT_FILES_VIEW_TYPE)[0];
	if (existing) {
		await app.workspace.revealLeaf(existing);
		return;
	}
	const leaf = app.workspace.getRightLeaf(false);
	if (!leaf)
		return;
	await leaf.setViewState({ type: RECENT_FILES_VIEW_TYPE, active: true });
	await app.workspace.revealLeaf(leaf);
}

// 放在它所构建的那个类旁边，好让 leaf 的运行时接线是一份文件里的一件事。
export function createRecentFilesView(
	places: PlaceList,
	savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
	prefs: RecentFilesBrowserPrefs,
	arrows: RecentFilesBrowserArrows,
): (leaf: WorkspaceLeaf) => RecentFilesView {
	return leaf => new RecentFilesView(leaf, places, savedPosition, prefs, arrows);
}
