import { Platform, Plugin, type Tasks } from 'obsidian';
import { SettingTab } from './settings/tab';
import { PluginSettings, SAFE_DB_FLUSH_INTERVAL, VIEW_STATE_POLL_MS, DEFAULT_SETTINGS } from './types';
import { CursorPositionDatabase } from './position/storage/database';
import { PositionManager } from './position/manager';
import { RECENT_FILES_VIEW_TYPE } from './recent-files/browser/view';
import { NAV_SOURCE_ID } from './recent-files/browser/constants';
import { t } from './i18n';


export default class PositionRestorePlugin extends Plugin {
	settings!: PluginSettings;
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

		// 需要等到 layoutReady 后才能执行，因为此刻 metadataCache 还没有准备好。
		this.app.workspace.onLayoutReady(() => {
			this.manager.prunePositions();
			this.manager.sweepMissingHistory();
		});

		this.manager.restoreEphemeralState();
	}

	//----------------------------------------------------------------------------------------

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<PluginSettings>;
		// DEFAULT_SETTINGS 铺在前、loaded 盖在后：存档是 Partial —— 旧版本写下的 data.json 里
		// 没有后来新增的那些键，不先铺一遍就是 undefined。
		//
		// 第一次加载时对象还不存在（字段用 `!` 声明、没有初值），直接建一份。此后只能**合并进**
		// 现有对象，绝不 `this.settings = {...}` 整个换掉：database 与 manager 在构造时抓住了这个
		// 引用，之后一直透过它实时读（places.cap()、面板的那些偏好），换对象会让它们从此读一份旧
		// 副本。这条约束在**重新加载**时最容易破 —— onExternalSettingsChange 也走这里，那时写成
		// 赋值，两个消费方读的旧副本要到下次重启才回来。
		if (!this.settings) {
			this.settings = { ...DEFAULT_SETTINGS, ...loaded };
		} else {
			Object.assign(this.settings, DEFAULT_SETTINGS, loaded);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// data.json 在插件已经跑起来之后被**外部**改了：要么读者自己编辑了那个文件，要么同步软件
	// （坚果云、iCloud 一类）把另一台设备上的版本换了过来。app 会在**运行中**的这个实例上调
	// 这里；没有它，改动要等下次重启才生效。
	//
	// 值本身只要重新加载就够 —— 两个消费方都实时读 settings 对象（见 loadSettings）。但少数键
	// 改动还欠着善后的活：上限调低了要裁掉超出的记录、文件夹规则新增了要丢掉一批对不上号的。
	// 把合并前的旧副本交给 manager 做差比，就是为了让它发现这些键。
	async onExternalSettingsChange() {
		const before = { ...this.settings };
		await this.loadSettings();
		this.manager.applyChangedSettings(before);
	}

	//----------------------------------------------------------------------------------------
	// 下面是生命周期的注册。每个方法只管 onload 的其中一桩事。

	// 把「最近文件」注册成 app 悬停预览（页预览）体系里的一个来源，id 是 NAV_SOURCE_ID
	// （见 constants.ts）。注册之后，悬停列表上的某一行，弹出的预览浮窗由 app 来画。
	//
	// 它会**按名字**出现在页预览的设置里，下面这个字段决定那一行初始长什么样：
	// `defaultMod: true` = 默认「要按住 Cmd/Ctrl 悬停才预览」，光悬停不弹窗。这也是文件浏览器、
	// 搜索那几行在 app 里的默认状态，跟它们保持一致。想改的读者自己在设置里改。
	private registerPreviewSource(): void {
		this.registerHoverLinkSource(NAV_SOURCE_ID, {
			display: t('recentFiles.name'),
			defaultMod: true,
		});
	}

	private registerCommands() {
		// 前进后退
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
		// 跳到当前笔记的开头 / 结尾
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
		// 打开最近文件列表 —— 一个挑东西用的选择框，问完就关。
		this.addCommand({
			id: 'browse-recent-files',
			name: t('recentFiles.commands.open'),
			icon: 'clock',
			callback: () => this.manager.openRecentFilesModal(),
		});
		// 打开最近文件列表 —— 常驻的侧栏面板。
		this.addCommand({
			id: 'open-recent-files-sidebar',
			name: t('recentFiles.commands.openSidebar'),
			icon: 'panel-right',
			callback: () => this.manager.openRecentFilesSidebar(),
		});
		// ribbon 上的入口
		// 图标**打开什么**按平台分：桌面上侧栏是留得住的地，所以打开常驻面板；手机上打开那个问完
		// 就走的选择框 —— 一次操作会把面板所在的抽屉合上，想让它站在那儿的读者可以打开侧边栏。
		const openFromRibbon = Platform.isMobile
			? () => this.manager.openRecentFilesModal()
			: () => this.manager.openRecentFilesSidebar();
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
		// 关窗前把库写下去。app 退出时会等完 Tasks 上挂的每一个 promise：挂在这里，写库才不会
		// 发后不管、跟关窗抢时间，否则上次周期落盘以来记下的东西全丢（三个内存 store 平时是同步
		// 写的，这里补的是落到库文件这一下）。
		//
		// 挂上去的 promise **必须 settle**，不能 reject 出去：app 等的是一个 Promise.all，只要有
		// 一个不落地，它就一直卡在 "Saving..." 那个对话框上。所以写失败也要变成 resolve ——
		// 见 storePositionData 里的整包 try/catch。
		this.registerEvent(this.app.workspace.on('quit', (tasks: Tasks) => {
			tasks.addPromise(this.manager.storePositionData());
		}));
	}

	// 两条周期采样，各管一桩事。
	private registerPolling() {
		// 位置采样：每 100ms 看一次活动视图。它和桌面上那条滚动监听是**互补的两条输入**，不是
		// 二选一 —— 轮询只盯活动视图、只调 CodeMirror 的内存 getter，从不触发重排；滚动监听挂
		// 在工作区根节点上（见 sampler.installScrollCapture），接住轮询看不见的那些面板。还要
		// 轮询的另一个理由：它拿的是「整份快照」，没人喊它也会看，一处悄悄发生的变动不会漏。
		this.registerInterval(
			window.setInterval(() => this.manager.sampleActiveView(), 100)
		);
		// 视图状态（getState）：慢得多的第二个 tick。代价由写那个视图的人说了算（可能触发一次
		// 序列化），所以不能跟着 100ms 跑；答得慢的后果也只是把落点知道得晚一点。
		this.registerInterval(
			window.setInterval(() => this.manager.sampleActiveViewState(), VIEW_STATE_POLL_MS)
		);
	}

	// 周期把脏位置整份落盘，每 tick 固定先合并一次外部改动 —— 与采样轮询是两桩事（节奏不同、
	// 属主不同），所以自己注册一次。
	//
	// 合并是多设备同步能用下去的原因：同步软件会在我们脚下把库文件整个换掉。它得每 tick 自己做，
	// 不能等到落盘时顺带做 —— 库没脏的时候压根走不到写入，而一个只读会话可以无限期地保持干净，
	// 外来记录就得干等着本地哪次写入发生。每 tick 一次 stat() 把采纳延迟压在 5s 内（mtime 没变时
	// 一分钱不花），也保证整份写入不会把外来记录冲掉。
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
	// 冻住，之后被杀掉时也不会给 'quit' 事件 —— 手指刚划完就锁屏，100ms 轮询和 5s 落盘都可能错过
	// 最后那一下滚动。visibilitychange / pagehide 是最后还能指望的两个回调。
	//
	// 桌面上这两个事件照样会触发（切到别的标签页、最小化窗口），只是让这次落盘提早了一点，无害。
	private registerSuspendFlush() {
		const flushBeforeSuspend = () => {
			// 焦点正落在搜索框里（编辑器查找、快速切换、命令面板、全局搜索都算），说明此刻看到的那处
			// 是搜索带着走到的、不是读者自己走到的 —— 跳过采样这一步，只把已经存下的写盘，好让搜索
			// 之前那个位置完整留存过这次挂起。
			if (!this.manager.isSearchAnchored()) {
				this.manager.sampleActiveView();
				this.manager.sampleActiveViewState();
			}
			// 不等它，也没有东西可用来等：挂起时没有 Tasks 可托付，JS 还随时可能在写到一半时被冻住。
			// 三个内存 store 上面已经同步写过了，这里补的是那个文件。
			void this.manager.storePositionData();
		};
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden)
				flushBeforeSuspend();
		});
		this.registerDomEvent(window, 'pagehide', () => flushBeforeSuspend());
	}

}
