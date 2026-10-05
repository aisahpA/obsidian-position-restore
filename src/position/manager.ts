import { App, FileView, TAbstractFile, Platform, View, WorkspaceLeaf } from 'obsidian';
import { PluginSettings } from '@/types';
import { CursorPositionDatabase } from './storage/database';
import { PositionStore } from './storage/position-store';
import { PositionState } from './state';
import { BackgroundSettler } from './restore/background-settle';
import { Restorer } from './restore/restorer';
import { OpenPatcher } from './restore/patcher';
import { ExplorerPreviewFocus } from './hover/explorer-preview';
import { Sampler } from './capture/sampler';
import { NavFunnel } from '@/nav/funnel';
import { NavStack } from '@/nav-history/stack';
import { NavPlaces } from '@/recent-files/places';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { RecentFilesBrowserPrefs } from '@/recent-files/browser/body';
import type { RecentFilesBrowserArrows } from '@/recent-files/browser/arrows';
import {
	RECENT_FILES_VIEW_TYPE,
	RecentFilesView,
	activateRecentFilesView,
	createRecentFilesView,
} from '@/recent-files/browser/view';
import { PathBookkeeper } from './path-bookkeeping';
import { isRecordableViewType } from '@/nav/entry';
import { isMainAreaLeaf, markdownViewInUse, viewIcon, viewLabel, viewState } from '@/shared/leaf';
import { atEdge, caretAtEdge, caretToEdge, holdEdge, moveToEdge, NoteEdge, syncViewScroll } from './edges';
import { readNavEntryState } from './capture/ephemeral';

// 门面，扣在若干协作者之上，归插件所有；main.ts 只跟这一个类打交道。
// 每个方法都派发给负责该关注点的那一块 —— 这里自己不持有任何状态。
// 它也是**唯一**同时认识两个导航 store 的地方：把漏斗接到两边、又把栈的打开流水线
// 交给地点列表，于是两个 store 互不 import。跨阶段的协调标志住在共享的 PositionState 里，
// 所以协作者们永远不会失步。
export class PositionManager {
	private app: App;
	private database: CursorPositionDatabase;
	private state: PositionState;
	private store: PositionStore;
	private restorer: Restorer;
	private patcher: OpenPatcher;
	private explorerPreview: ExplorerPreviewFocus;
	private sampler: Sampler;
	private backgroundSettler: BackgroundSettler;
	private funnel: NavFunnel;
	private stack: NavStack;
	private places: NavPlaces;
	private bookkeeper: PathBookkeeper;

	constructor(
		app: App,
		database: CursorPositionDatabase,
		// 那唯一的共享设置对象（main.ts 赋一次值，设置标签页就地对它做改动），
		// 存成字段是因为浏览器会从它身上实时读自己的偏好。
		private settings: PluginSettings,
	) {
		this.app = app;
		this.database = database;
		this.state = new PositionState(settings);
		// 先建记录漏斗：下面两个读者都需要它。
		this.funnel = new NavFunnel(app, this.state);
		this.stack = new NavStack(app, settings, this.state, this.funnel, (path) => this.database.db[path]);
		this.places = new NavPlaces(app, settings);
		// 漏斗的两个订阅者。栈本身就是其中一个；地点列表保有自己的词汇
		// （地点，不是步），所以那层端口的翻译住在这里。
		this.funnel.subscribe(this.stack);
		this.funnel.subscribe({
			onVisit: (recording) => this.places.remember(recording.record),
			onLanded: (entry) => this.places.settle(entry),
			onHere: (entry) => this.places.markCurrent(entry),
		});
		this.places.attach({
			openFile: (path, leafId, target) => this.stack.openFilePlain(path, leafId, target),
			openJump: (entry, target) => this.stack.travelTo(entry, target),
			openView: (entry, target) => this.stack.openViewPlace(entry, target),
		});
		this.store = new PositionStore(app, database);
		this.restorer = new Restorer(app, settings, this.store, this.state);
		this.sampler = new Sampler(app, this.store, settings, this.state, this.funnel);
		this.patcher = new OpenPatcher(app, settings, this.store, this.state, this.funnel, this.sampler);
		this.explorerPreview = new ExplorerPreviewFocus(app, database, settings);
		this.backgroundSettler = new BackgroundSettler(app, settings, this.store, this.state);
		this.bookkeeper = new PathBookkeeper(app, this.store, [this.stack, this.places], this.state);
	}

	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patcher.installPatches(registerCleanup);
		// 把大纲面板的点击当成文件内的导航跳转（阅读模式 —— 补丁和轮询都看不见的
		// 那唯一一条跳转路径）。大纲 DOM 解析不出来时静默地什么都不做。
		this.funnel.installOutlineCapture(registerCleanup);
		// 搜索锚：由搜索输入框获得焦点时武装，这样由搜索驱动的跳转就不会覆盖保存的位置。
		// 平台中立：桌面和移动端的轮询都会走这道防护。
		this.sampler.installSearchAnchor(registerCleanup);
		// frontmatter 记录规则：一篇文件一旦选择退出，立刻丢掉它的记录。
		this.sampler.installFrontmatterWatch(registerCleanup);
		if (Platform.isDesktopApp) {
			this.sampler.installScrollCapture(registerCleanup);
			// 移动端触摸监听在桌面的对应物：给用户输入盖时间戳，好让滚动采集
			// 分得清真的滚动和程序性的移动。
			this.sampler.installUserIntentTracker(registerCleanup);
			// 文件内跳转检测按「每次选区事件」的粒度做（VSCode 的 10 行阈值），
			// 而不是轮询的 100ms 量化。
			this.sampler.installTeleportWatcher(registerCleanup);
		} else {
			// 移动端：没有滚动采集（WKWebView 会丢掉事件），但轮询需要一个可靠的
			// 「用户碰过视图」信号，好把真的滚动和被动的重排区分开。
			this.sampler.installTouchListener(registerCleanup);
		}
	}

	// app 自己的文件列表把悬停预览开在哪里。它单独注册而不是折进 installPatches：
	// 它不改任何位置、也不读补丁喂的那些管线，而且万一它指向的预览将来被删掉，
	// 它自己仍能独立地回答。
	installExplorerPreview(registerCleanup: (fn: () => void) => void) {
		this.explorerPreview.install(registerCleanup);
	}

	restoreEphemeralState(): void {
		void this.restorer.restoreEphemeralState()
			.catch(e => console.error('Position Restore: restore failed:', e));
	}

	// 给那些从未触发 'file-open' 的 open 做 'active-leaf-change' 收尾（后台打开、
	// 重启后恢复的标签页、同文件被延后的标签页激活）。
	completeInjectedRestore(leaf: WorkspaceLeaf | null): void {
		void this.restorer.completeInjectedRestore(leaf)
			.catch(e => console.error('Position Restore: complete injected restore failed:', e));
	}

	// 给那些 open 从未触发 'file-open' 的后台分屏标签页做的启动清扫。有界轮询；
	// 没有已建好、还需要处理的 leaf 或过了截止时间就停。
	installBackgroundSettle(registerCleanup: (fn: () => void) => void) {
		this.backgroundSettler.start(registerCleanup);
	}

	// 100ms 的 tick。下面那个视图 state 的读取**不属于**它：后者搭的是自己那条更慢的
	// tick（见 main.ts 的 registerPolling）。
	sampleActiveView() {
		this.sampler.sampleActiveView();
	}

	// 读者进到一个视图里时，它的 state 还没定型：内置浏览器在页面提交、且它所在的 url 存在
	// 之前，用 `{title, mode}` 回答 getState，而地点列表会把这份同样没定型的 state 覆在
	// 自己那份好好的之上。直到读者离开之前没有任何东西重读它 —— 而对于一个打开后立刻
	// 关掉的标签页，那就是永远不。所以这条 tick 重读它，并把差异当作一次落点发布出去，
	// 走与「离开时读取」同一条线（见 funnel.ts 的 NavFunnelSink.onLanded），两个读者就位更新。
	//
	// 几乎每个 tick 都是安静的（对比的是这一步已经持有的东西），除了某个自己 getState 很贵的
	// 第三方视图：读者坐在它里面时，它每秒被问一次。所以有下面的顺序 —— 那两个回答
	// 「这是不是那一步？」的属性读取排在 isMainAreaLeaf 之前，后者要遍历工作区的元素树。
	sampleActiveViewState(): void {
		if (!this.funnel.isRecording())
			return;
		const view = this.app.workspace.getActiveViewOfType(View);
		if (!view || view instanceof FileView)
			return;
		const viewType = view.getViewType();
		if (!isRecordableViewType(viewType))
			return;
		const top = this.stack.entries[this.stack.index];
		if (!top || top.kind !== 'view' || top.viewType !== viewType)
			return;
		if (!isMainAreaLeaf(this.app, view.leaf))
			return;
		const state = viewState(view);
		if (!state || JSON.stringify(state) === JSON.stringify(top.state))
			return;
		this.funnel.landing({
			kind: 'view', leafId: top.leafId, viewType, state,
			label: viewLabel(view), icon: viewIcon(view),
		});
	}

	// 每一个持久化点（退出、挂起 flush、周期性 flush）都走这里。下面三个 store 同步写
	// localStorage；只有 db 文件是异步的，所以这个 promise 就是「是不是全都到磁盘了」的
	// 完整答案 —— 也正是它让退出处理器能交给 Obsidian 一个可等待的东西（见 main.ts 的 'quit'）。
	//
	// **写入失败时它也会 settle**，而这就是那个 catch 的意义：Obsidian 会在关窗之前，把交给
	// Tasks 的每个 promise 用 Promise.all 等完，所以这里一个 reject 就会让 app 卡在它那个
	// 「正在保存…」对话框上，把读者扣在它反正也保存不了的位置上。失败仍会报告，进日志。
	async storePositionData(): Promise<void> {
		try {
			// 关掉一个 leaf 不触发任何专门的事件，所以死掉的记录会一直活到下一次
			// 全新 open 的修剪。改为在每个持久化点都修剪。
			this.restorer.pruneStaleLeafIds();

			// 每个 leaf 的 overlay 按数据库的节奏持久化，而不是只在退出时：它是「同一个文件
			// 分在两个标签页」这一状态熬过重启的唯一去处。对它上一次的 blob 去重，
			// 所以没变的一轮只是一次 stringify。
			this.store.persist();

			// 导航 store 搭同样的持久化点，各自对自己上次写下的快照做脏检查。
			// 两次独立调用：谁也不替谁写。
			this.stack.persist();
			this.places.persist();

			await this.database.writeDb();
		} catch (e) {
			console.error('Position Restore: could not save positions:', e);
		}
	}

	// 在记录下来的跳转历史里前进/后退（VSCode 风格）。这个 promise **就是**遍历本身 ——
	// 一步打开一篇笔记并等它 —— 面板的箭头也等它（见 RecentFilesBrowser.pressArrow）。
	// 命令不等，并且在调用点明说了。
	navigateBack(): Promise<void> {
		return this.stack.navigate(-1)
			.catch(e => console.error('Position Restore: navigate back failed:', e));
	}

	navigateForward(): Promise<void> {
		return this.stack.navigate(1)
			.catch(e => console.error('Position Restore: navigate forward failed:', e));
	}

	// 一篇笔记的两端，作为导航。重点就是那一步：app 自己的按键只移动视图、什么都不留下，
	// 所以读者一要求去另一端，他原来站的那个位置就没了 —— 在手机上（那些按键根本不存在），
	// 那个位置再也回不去了。于是把他站的地点写到他正要离开的那一步上，而这次到达自己占一步：
	// 后退回到他站过的地方，前进到那一端。
	//
	// 两端都不是**带名**的目标，所以两步都是不带 key 的 visit —— 一个 jump key 会把一篇笔记的
	// 顶部变成最近文件列表里属于自己的一个地点，而那是标题的身份、不是笔记一端的身份。
	// 笔记是从读者刚才所在的标签页读来的，而不是从**活动** leaf 读的：一个站在面板里的
	// 控件 —— 手机上的箭头 —— 在被点的那一刻自己就是活动 leaf，`getActiveViewOfType`
	// 会什么都答不上来。
	goToEdge(edge: NoteEdge): void {
		const view = markdownViewInUse(this.app);
		if (!view?.file)
			return;
		// 「已经在那儿」是两个答案、不是一个：视图可能显示着顶部、而光标在 200 行以下，
		// 而一个要求去顶部的读者想要它被移过去。当它是唯一还欠着的事时，它**不走**这趟
		// 旅程的其余部分 —— 不记步，因为没有看得见的东西移动过、而从一个这样的步后退
		// 会答出一个纹丝不动的视图；也不 hold，因为没有任何滚动去了别处等着被撤销。
		// 但仍然括起来：一个跳了两百行的光标正是桌面采样器据以推断出一步的形态。
		if (atEdge(view, edge)) {
			if (!caretAtEdge(view, edge))
				void this.funnel.runBracketed(async () => {
					caretToEdge(view, edge);
				})
					.catch(e => console.error('Position Restore: move caret to edge failed:', e));
			return;
		}
		const path = view.file.path;
		const leafId = this.state.leafId(view.leaf);
		const st = readNavEntryState(view);
		if (st)
			this.funnel.leave(path, leafId, st);
		// 强制越过同地点去重：这次到达与那一步（记着他们站的地方）在同一个文件里，
		// 一个不强制的记录会被折进它 —— 而接下来的离开又会用新位置盖掉那一个位置。
		this.funnel.visit({ record: { kind: 'visit', path, leafId }, cause: 'open', forced: true });
		// 括起来：这次移动是插件的，采样器不能把它读成读者在滚动 —— 而它看起来恰恰就是
		// 那样子，一个 tick 里挪了整屏。hold 也待在同一对括号里：它做的纠正是这次移动的
		// 收尾，不是第二次导航。
		void this.funnel.runBracketed(async () => {
			moveToEdge(view, edge);
			await holdEdge(view, edge);
			// 放最后，好让它报告的是被 hold 的这次移动把笔记留在了哪里。
			await syncViewScroll(view);
		})
			.catch(e => console.error('Position Restore: go to edge failed:', e));
	}

	// 两端到底能不能被要求 —— 与箭头作用于同一篇笔记，这样一个变灰的按钮和一次
	// 什么都不做的按下不会互相打架（见 goToEdge）。
	canGoToEdge(): boolean {
		return !!markdownViewInUse(this.app)?.file;
	}

	// 前进/后退的命令可用性（checkCallback）—— 见 NavStack.canNavigate。
	canNavigate(dir: -1 | 1): boolean {
		return this.stack.canNavigate(dir);
	}

	// 「浏览最近文件」模态框（main.ts 的命令）—— 见 NavStack.travelTo。
	openRecentFilesModal() {
		new RecentFilesModal(
			this.app,
			this.places,
			(path) => this.database.db[path],
			this.browserPrefs(),
			this.recentFilesArrows(),
		).open();
	}

	// 同一个浏览器的常驻形态（main.ts 的命令）：同样的列表、同样的行，站在侧边栏里，
	// 而不是召之即来、挥之即去。
	openRecentFilesSidebar() {
		void activateRecentFilesView(this.app, this.places, (path) => this.database.db[path], this.browserPrefs());
	}

	// main.ts 交给 Plugin.registerView 的工厂：这个视图需要地点列表、保存的位置和
	// 浏览器的偏好，而这些全归这个门面所有。
	recentFilesViewCreator(): (leaf: WorkspaceLeaf) => RecentFilesView {
		return createRecentFilesView(
			this.places,
			(path) => this.database.db[path],
			this.browserPrefs(),
			this.recentFilesArrows(),
		);
	}

	// 面板的箭头做什么。四个动作是插件自己的（见 main.ts 的命令），是交下去、
	// 而不是由面板来跑：一个 body 不持有历史、也不持有笔记，所以它只能问 ——
	// 而正是这一点让一个会什么都不做的按钮变灰。
	private recentFilesArrows(): RecentFilesBrowserArrows {
		return {
			back: () => this.navigateBack(),
			forward: () => this.navigateForward(),
			top: () => this.goToEdge('top'),
			bottom: () => this.goToEdge('bottom'),
			// 这是**一步自己的**问题，不是命令的（见 NavStack.hasStep）：有没有一步可走，
			// 而这一点不因遍历正在进行而改变。改问命令的，会让两个箭头在一次步所需的
			// 整段时间里都变灰。
			canBack: () => this.stack.hasStep(-1),
			canForward: () => this.stack.hasStep(1),
			canEdge: () => this.canGoToEdge(),
		};
	}

	// 浏览器据以绘制的偏好：从共享设置对象上**实时**读，所以对话框和常驻面板不会各持一套
	// 说法，而设置标签页里做的一个选择，在一个已经站着的面板下一次重画时就生效。
	// **只读** —— 设置标签页自己写、自己持久化，所以没有第二个写入者要同步。
	private browserPrefs(): RecentFilesBrowserPrefs {
		return {
			// 搜索框是否也认各篇笔记的小节标题（见 list.ts 的 headingRow）。没有东西由它
			// 记录 —— 它只决定一次搜索能找到什么、以及画不画那些搜到的行。
			outlineSearch: () => this.settings.recentFilesOutlineSearch,
			// 列表往回够多远；调小它会当场修剪列表。
			placesCap: () => this.settings.recentFilesCap,
			// 列表把一行的路径打印多少、打在名字的哪一侧：它决定**下一次**渲染打印什么。
			pathDisplay: () => this.settings.recentFilesPathDisplay,
			// 每一行是否说明它上次被访问是多久之前。
			rowTime: () => this.settings.recentFilesRowTime,
			// 一行怎么称呼那篇笔记：读者自己命名了 frontmatter 属性时用他的属性，
			// 其余地方用文件名。
			titleProperty: () => this.settings.recentFilesTitleProperty,
			// 悬停在哪里打开一行所代表的笔记（见 PreviewFocusMode）。没有东西由它绘制，
			// 所以它在下一次悬停时生效、而不是下一次重画时 —— 这正是它不欠任何重画的原因
			// （见 settings/tab.ts 的 BROWSER_PREF_KEYS）。
			previewFocus: () => this.settings.recentFilesPreviewFocus,
		};
	}

	// 读者刚改了一项偏好，而一个面板可能正站在他看的那个页面旁边开着。面板实时读那些偏好
	// （见 browserPrefs），所以什么都不用重建或重接 —— 只需重画一次。
	refreshNavPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(RECENT_FILES_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof RecentFilesView)
				view.refresh();
		}
	}

	// 标签页/窗格的激活记一条导航条目（VSCode 语义）。
	recordActivation(leaf: WorkspaceLeaf | null): void {
		this.funnel.recordActivation(leaf);
	}

	// 搜索会话进行中时为真。main.ts 在轮询之外记录路径之前会检查它，例如挂起 flush。
	isSearchAnchored() {
		return this.state.isSearchAnchored();
	}

	// Vault 'rename' —— 每条按 path 为键的记录都跟着文件走。
	renameFile(file: TAbstractFile, oldPath: string) {
		this.bookkeeper.renameFile(file, oldPath);
	}

	// Vault 'delete' —— 一次预约的修剪，绝不是立刻的：同步插件「先删再改名」的替换会报
	// 同一个事件，而它的撤销过一会儿才到。
	deleteFile(file: TAbstractFile) {
		this.bookkeeper.deleteFile(file);
	}

	// Vault 'create' —— 一次预约的修剪所等待的那个文件回来了，在手机上这是同步在投递
	// 它的替换品。取消那次修剪（见 PathBookkeeper.cancelPending）：那个窗口是兜底，
	// 不是记录的存活要跟它赛跑的东西。
	fileCreated(file: TAbstractFile) {
		this.bookkeeper.fileCreated(file);
	}

	// 给导航 store 的启动清扫：Obsidian 关闭期间被删的文件不会触发 'delete' 事件，
	// 所以它们的条目会永久占住上限里的名额。位置记录有意不去动。
	sweepMissingHistory() {
		this.bookkeeper.sweepMissingHistory();
	}

	// 栈的上限变了：把它施加到内存里已有的栈上，而不是等下一次导航一次丢掉一大块。
	applyNavHistoryCap(): void {
		this.stack.applyStackCap();
	}

	// 列表自己的一条规则变了 —— 往「不列出」里加了一个文件夹或 frontmatter 属性。
	// 一个读者再也看不到的地点不该在一个有上限的列表里占着名额，直到他碰巧重访它；
	// 而这次丢弃必须在他正看着这项设置时就落下。
	applyRecentFilesExclusions(): void {
		if (this.places.pruneExcluded() > 0)
			this.places.applyCap();
	}

	// 列表的上限变了：立刻修剪，好让读者看到他刚设的上限。设置标签页和一次外部写入
	// （手工编辑 data.json、一次同步落地）都会调它，所以每个写入者都从这里过。
	//
	// 上限数的是**笔记**，所以它欠的只是「一个数字」那么多修剪，别无其他。
	//
	// 落点那项设置有意**不在**这张表里：它停止或开始**记录**，而列表在下一次导航
	// （NavPlaces.recordsJumps）才回应它，而不是一个要重新施加的后果；它也放着已经记下的东西不管。
	applyRecentFilesCap(): void {
		this.places.applyCap();
	}

	// `before` 里每一项与当前不同的设置，都把它派生出来的后果施加一遍。这里**就是**那个分发 ——
	// 只有这一份。来自设置标签页的一次写入也到达这里，带着标签页在写之前拍下的快照，
	// 于是这些后果不必按调用者各重复一遍。`before` 是在设置对象被就地覆盖之前紧挨着
	// 从它身上拷下来的一份，而这也是一次**外部**写入唯一能到来的一种形态：
	// data.json 不点名任何键，所以对比是两个调用者唯一的共同点。
	//
	// 重画一个开着的面板有意**不**在这里：每个面板都实时读自己的偏好（见 browserPrefs），
	// 所以什么都不需要重算 —— 那只是一个被要求再画一次的视图，而只有设置标签页知道
	// 一个读者刚在一个面板面前改了其中一项偏好。
	applyChangedSettings(before: PluginSettings): void {
		if (this.settings.navHistoryCap !== before.navHistoryCap)
			this.applyNavHistoryCap();
		if (this.settings.recentFilesCap !== before.recentFilesCap)
			this.applyRecentFilesCap();
		if (!sameList(this.settings.recentFilesExcludeFolders, before.recentFilesExcludeFolders)
			|| !sameList(this.settings.recentFilesExcludeProperties, before.recentFilesExcludeProperties))
			this.applyRecentFilesExclusions();
		if (!sameList(this.settings.excludedFolders, before.excludedFolders)
			|| !sameList(this.settings.frontmatterExcludeProperties, before.frontmatterExcludeProperties))
			this.prunePositions();
	}

	// 修剪当前设置排除掉的记录（顺带也修剪超过条目上限的那些）。经由那个 store 走，
	// 好让文件层和 leaf 层一起被修剪。
	prunePositions(): number {
		return this.store.pruneDatabase();
	}
}

// 字符串列表设置用的逐元素相等：每次 JSON.parse 都会新建一个数组，所以用身份比较会在每次
// 外部写入时都报「变了」、并重跑那次修剪。
function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
