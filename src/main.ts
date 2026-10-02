import { Platform, Plugin, type Tasks } from 'obsidian';
import { SettingTab } from './settings/tab';
import { PluginSettings, SAFE_DB_FLUSH_INTERVAL, VIEW_STATE_POLL_MS, DEFAULT_SETTINGS } from './types';
import { CursorPositionDatabase } from './position/storage/database';
import { PositionManager } from './position/manager';
import { RECENT_FILES_VIEW_TYPE } from './recent-files/browser/view';
import { NAV_SOURCE_ID } from './recent-files/browser/constants';
import { t } from './i18n';


export default class PositionRestorePlugin extends Plugin {
	// 不重新赋值（never reassigned）—— 为什么这个**对象的身份**重要，见 loadSettings。
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	database!: CursorPositionDatabase;
	manager!: PositionManager;

	async onload() {
		await this.loadSettings();
		this.database = new CursorPositionDatabase(this, this.settings);
		this.manager = new PositionManager(this.app, this.database, this.settings);
		await this.database.readDb();

		this.addSettingTab(new SettingTab(this.app, this));

		this.registerView(RECENT_FILES_VIEW_TYPE, this.manager.recentFilesViewCreator());
		this.registerPreviewSource();

		this.manager.installPatches(cleanup => this.register(cleanup));
		this.manager.installExplorerPreview(cleanup => this.register(cleanup));
		this.manager.installBackgroundSettle(cleanup => this.register(cleanup));
		this.registerCommands();

		this.registerWorkspaceEvents();
		this.registerPolling();
		this.registerDbFlush();
		this.registerSuspendFlush();

		// 这两件清理都不必赶，而且此刻 vault 的索引还在预热 —— 挪到 layoutReady 不额外花
		// 时间，还能让 prune() 查到一份已经装满的 metadataCache。
		this.app.workspace.onLayoutReady(() => {
			this.manager.prunePositions();
			this.manager.sweepMissingHistory();
		});

		this.manager.restoreEphemeralState();
	}

	//----------------------------------------------------------------------------------------

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<PluginSettings>;
		// 是**合并进**现有对象，绝不整个覆盖掉。NavPlaces 与 PositionManager 都在构造时抓住
		// 了这个引用，之后一直透过它实时读（places.cap()、面板的那些偏好），所以一旦把对象换掉，
		// 它们从此读的就是一份旧副本。
		Object.assign(this.settings, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// data.json 在插件已经加载之后被人改了 —— 可能是读者、同步插件，或替我们写文件的另一个
	// 插件。Obsidian 会在**运行中**的实例上调这里；没有它，改动要等下次重启才生效。
	//
	// 值本身只要重新加载就够：两个消费方都是实时读 settings 对象。不会自己发生的，是少数几个
	// 键改动时欠下的那点活 —— 上限调低了要裁掉超出部分、文件夹规则新增了要丢一批 —— 所以把
	// 合并前的副本交给 manager 去做差比。这里不调 saveSettings：把文件原样回写，正是两个写手
	// 来回打乒乓的方式。
	async onExternalSettingsChange() {
		const before = { ...this.settings };
		await this.loadSettings();
		this.manager.applyChangedSettings(before);
	}

	//----------------------------------------------------------------------------------------
	// 下面是生命周期的注册。每个方法只管 onload 的其中一桩事。

	// 最近文件的行是读者**悬停出发**的地方，所以面板以一个 id 挂进 app 自己的页预览体系
	// （见 constants.ts 的 NAV_SOURCE_ID）：悬停时就向那套体系要「这一行所说那篇笔记」的预览，
	// 而不是本面板自己画一个浮窗 —— 那会变成读者要学第二套规则（见 hoverRow）。
	//
	// 注册还会让面板**按名字**出现在那个插件的设置里，本处唯一的问题就在那里作答：悬停就够，
	// 还是得按住 Cmd/Ctrl。`defaultMod: true` 是那一行的初始状态，因为 app 在别处都默认开着
	// —— 文件浏览器和搜索都在其中。按键是在**行上**等的，所以 hoverRow 要传 `targetEl`。
	private registerPreviewSource(): void {
		this.registerHoverLinkSource(NAV_SOURCE_ID, {
			display: t('recentFiles.name'),
			defaultMod: true,
		});
	}

	// VSCode 那套前进后退。不设默认快捷键 —— 读者自己在 Obsidian 的快捷键设置里绑。
	// 任何文件视图上都能用：同一标签页内换文件走的是 app 自带的按标签页历史（PDF、白板也在
	// 内），跨标签页的行进会重新激活原来那个标签页，文件内的跳转则直接套用记录下来的位置。
	// 焦点在侧栏里时也照样可用：行进会激活最近那个文件标签页，并从那里起步。
	private registerCommands() {
		this.addCommand({
			id: 'navigate-back',
			name: t('navHistory.commands.navigateBack'),
			icon: 'arrow-left',
			checkCallback: (checking) => {
				if (!this.manager.canNavigate(-1)) return false;
				if (!checking) void this.manager.navigateBack();
				return true;
			},
		});
		this.addCommand({
			id: 'navigate-forward',
			name: t('navHistory.commands.navigateForward'),
			icon: 'arrow-right',
			checkCallback: (checking) => {
				if (!this.manager.canNavigate(1)) return false;
				if (!checking) void this.manager.navigateForward();
				return true;
			}
		});
		// 一篇笔记的两个端点。app 两头的命令都没有 —— Ctrl+Home / Ctrl+End 是编辑器按键，而且
		// 只在桌面端 —— 那些按键又不会留下步，读者一问另一端，他所站的那处就丢了。这两个命令会把它
		// 记下来，这正是「到结尾」里属于一个位置插件的那部分。
		this.addCommand({
			id: 'go-to-top',
			name: t('noteEdge.commands.top'),
			icon: 'arrow-up',
			checkCallback: (checking) => {
				if (!this.manager.canGoToEdge()) return false;
				if (!checking) this.manager.goToEdge('top');
				return true;
			},
		});
		this.addCommand({
			id: 'go-to-bottom',
			name: t('noteEdge.commands.bottom'),
			icon: 'arrow-down',
			checkCallback: (checking) => {
				if (!this.manager.canGoToEdge()) return false;
				if (!checking) this.manager.goToEdge('bottom');
				return true;
			},
		});
		// 最近文件：那是**地点**列表，最近的一个排在最后（见 places.ts）—— 一篇笔记一行，点这一行
		// 就在它代表的那处打开文件。它**不是**前进后退栈：那个 store 属于上面那两条命令。没有可用性
		// 门槛（不置灰）。
		//
		// 图标是一口**钟**：这些行是按最后一次坐下的时间排序的地点。不用 'list' —— 那是大纲面板的
		// 图标，两样在命令面板里会被读成同一个东西。面板自己的那个标签页用同一枚图标（见
		// RecentFilesView.getIcon）。
		this.addCommand({
			id: 'browse-recent-files',
			name: t('recentFiles.commands.open'),
			icon: 'clock',
			callback: () => this.manager.openRecentFilesModal(),
		});
		// ……还是同一个列表，不过是做成**常驻**的侧栏面板：它是工作区里的一处地方，而不是一个问完
		// 就关掉的问题。刻意做成两条命令 —— 同一个问题有两种心情要问（一个是挑东西的选择器，一个是
		// 放在手边干活用的面板），想要哪个只有读者在开口那一刻才知道。
		this.addCommand({
			id: 'open-recent-files-sidebar',
			name: t('recentFiles.commands.openSidebar'),
			icon: 'panel-right',
			callback: () => this.manager.openRecentFilesSidebar(),
		});
		// ribbon 上的入口：每个平台都是**同一枚**图标，因为这个列表是本插件唯一有张脸的部分 ——
		// 恢复位置是自己发生的，前进后退得读者先绑了快捷键才存在。一扇看不见的门，只能干等着本来就
		// 晓得它在那儿的读者来推。
		//
		// 图标**打开什么**由平台自己的答案决定。桌面上侧栏是留得住的地，所以图标打开常驻面板 ——
		// 已经站着一个时还会把它带回来（见 activateRecentFilesView）。手机上图标是问完就走 —— 那个
		// 模态框；不是因为面板在那里碍事：一次行进会把它所在的抽屉合上（见 dismissOnMobile），而想
		// 让它站在那儿的读者有那条侧栏命令，之后还有一划。
		//
		// 我们这边不给它设开关：app 允许读者取消勾选任何一个 ribbon 动作并跨设备记住，再来第二份，
		// 就是在一个早有答案的问题前面又插一个旋钮。
		const openFromRibbon = Platform.isMobile
			? () => this.manager.openRecentFilesModal()
			: () => this.manager.openRecentFilesSidebar();
		// 不是 navHistory.heading：ribbon 打开的是最近文件列表，图标要报出的是那个页面的名字。
		this.addRibbonIcon('clock', t('recentFiles.name'), openFromRibbon);
	}

	// 工作区上的反应：打开时恢复位置、退出时写盘，并让位置库在文件改名 / 删除之后始终按当前
	// 路径归档。
	private registerWorkspaceEvents() {
		this.registerEvent(this.app.workspace.on('file-open', () => this.manager.restoreEphemeralState()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			this.manager.completeInjectedRestore(leaf);
			this.manager.recordActivation(leaf);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.manager.renameFile(file, oldPath)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.manager.deleteFile(file)));
		this.registerEvent(this.app.vault.on('create', (file) => this.manager.fileCreated(file)));
		// Obsidian 退出前会等着交给 Tasks 的那些 promise。没有这一句，写库就是发后不管、跟关窗去
		// 抢时间，上一次周期落盘以来记下的东西全丢。三个内存里的 store 是同步写的；这里是那个文件。
		// 即使写入失败它也一定 settle（见 storePositionData）—— 这一点必须成立：这里要有一个 reject
		// 出去的 promise，app 会卡在它的 "Saving..." 对话框上。
		this.registerEvent(this.app.workspace.on('quit', (tasks: Tasks) => {
			tasks.addPromise(this.manager.storePositionData());
		}));
	}

	// 用 100ms 轮询而不是事件驱动：任务是「离开之前把位置记住」，没有实时性要求，而且每一 tick
	// 只调 CodeMirror 的内存 getter、从不触发重排 —— 成本约等于 0。事件方案要多出约 3 倍代码，还得
	// 另外加几道防线（跳过恢复期间、vim 模式、目标到 leaf 的查找）；轮询这种「整份快照」永远不会
	// 悄悄丢掉一次变动。
	//
	// 读视图 state 是第二个、更慢的 tick：它调的是视图自己的 getState，代价归写视图的人，答得慢
	// 也只是把落点知道得晚一点。
	private registerPolling() {
		this.registerInterval(
			window.setInterval(() => this.manager.sampleActiveView(), 100)
		);
		this.registerInterval(
			window.setInterval(() => this.manager.sampleActiveViewState(), VIEW_STATE_POLL_MS)
		);
	}

	// 周期性把脏位置整份落盘，前面固定先做一次外部改动合并 —— 它与采样轮询是两桩事（节奏不同、
	// 属主不同），所以自己注册一次。
	//
	// 合并正是多设备同步能用下去的原因（同步插件会在我们脚下把库文件替换掉）。它不能只挂在
	// writeDb() 上：那份在库干净时会提前返回，而一个只读会话可以无限期地保持干净，于是外来记录就
	// 要干等着本地哪次写入发生。每 tick 一次 stat() 把采纳延迟压在 5s 以内 —— 窗口失焦时也一样，
	// Electron 只会把定时器向下对齐到 1s —— 而 mtime 没变时它一分钱不花。每次落盘前先合并，也保证
	// writeDb() 的整份写入不会把外来记录冲掉。
	private registerDbFlush() {
		this.registerInterval(
			window.setInterval(() => {
				// 没人在 await 它，而没人 catch 的异常 app 会打到控制台 —— 所以这里自己 catch。
				void this.database.mergeExternalChanges()
					.then(() => this.manager.storePositionData())
					.catch(e => console.error('Position Restore: periodic flush failed:', e));
			}, SAFE_DB_FLUSH_INTERVAL)
		);
	}

	// 赶在 app 可能被挂起之前，把最后那个可见位置写下去。移动端 WebView 在退到后台后不久就把 JS
	// 冻住，之后被杀掉时也不会给 'quit' 事件 —— 100ms 轮询和 5s 落盘都可能错过最后那一下滚动：
	// 手指刚划完就锁屏，那一下就没了。visibilitychange / pagehide 是最后还能指望的回调 —— 先把
	// 活动视图的状态记下，再写库。桌面上无害（切标签页、最小化），只是这次落盘提早了一点。
	private registerSuspendFlush() {
		const flushBeforeSuspend = () => {
			// 正处于一次搜索会话里，说明眼睛看到的那处是搜索命中、不是读者自己的 —— 跳过记录这一步，
			// 只把已经存下的东西写盘，好让搜索之前的那个锚点完整留存过这次挂起。
			if (!this.manager.isSearchAnchored()) {
				this.manager.sampleActiveView();
				this.manager.sampleActiveViewState();
			}
			// 不等它，这里也没有东西可用来等：挂起时拿不到 Tasks 可托付，JS 还随时可能在写入中途被冻住。
			// 三个内存 store 上面已经同步写过了；这里只是那个文件。
			void this.manager.storePositionData();
		};
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden)
				flushBeforeSuspend();
		});
		this.registerDomEvent(window, 'pagehide', () => flushBeforeSuspend());
	}

}
