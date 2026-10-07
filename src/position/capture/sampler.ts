import { App, FileView, MarkdownView, Platform, TFile, WorkspaceLeaf, debounce, type Editor, type EditorPosition, type EventRef } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { readEphemeralState, readLandingState, readNavEntryState, readSampledState, withNavDisplay } from './ephemeral';
import { isEphemeralStatesEquals, isCursorStatesEqual } from '@/shared/ephemeral-equals';
import { ExclusionChecker } from '@/position/policy/exclusion';
import { frontmatterDecisionFor } from '@/position/policy/frontmatter';
import { PositionState } from '@/position/state';
import type { NavFunnel } from '@/nav/funnel';

// 为共享的 PositionState 基线与位置 store 记录光标 / 滚动位置的变化。两路输入喂 store：
//  - sampleActiveView：100ms 轮询，只盯活动视图。桌面端只记光标移动（滚动增量归采集监听器）；
//    移动端记整个状态的变化，其中只有 scroll 变化的增量，还要有一次用户触摸为它作证才认
//    —— 移动端没有采集监听器，因为 WKWebView 会合并、丢弃 scroll 事件。
//  - onScrollCapture：挂在 workspace 根上的捕获阶段 scroll 监听器（仅桌面端），捞住轮询漏掉的
//    每一个窗格。它拒收两类噪音：嵌入渲染器内部的滚动（dataview 块、![[embed]] —— 记这些会把
//    **宿主**编辑器的状态写到嵌入内容自己的移动上），以及没有近期用户输入的滚动增量
//    （程序化重渲染）。
// 拥有逐 leaf 的采集基线。它**不**给排除判断做 memo：每轮轮询问一次检查器，正因如此，
// frontmatter 的编辑无需任何人作废什么就能立刻生效（见 ExclusionChecker）。插件经
// PositionManager 轮询它，后者始终是唯一入口。
export class Sampler {
	private app: App;
	private store: PositionStore;
	private exclusions: ExclusionChecker;
	private state: PositionState;
	private settings: PluginSettings;
	private funnel: NavFunnel;

	private readonly STORE_INTERVAL = 97;

	// 这些搜索框一持焦，就意味着视图即将被搜索引擎、而不是用户移动：编辑器内查找（Cmd+F）、
	// 快速切换、命令面板、文件内标题提示、全局搜索面板。
	private readonly SEARCH_INPUT_SELECTOR = '.document-search-input, .cm-search input, .prompt-input, .search-input-container input';

	// 搜索框失焦之后，锚点再保留这么久：点一条结果（全局搜索面板）会先让输入框失焦，
	// 然后它引发的跳转才登记。
	private readonly SEARCH_ANCHOR_GRACE_MS = 250;

	private searchGraceTimer = 0;

	// 有限的 searchAnchorUntil 是上限：视图一停稳，落地就结束了，所以晚几个 tick 就让它作废，
	// 而不是耗完整个窗口 —— 那会吞掉读者在跳转之后头几次有意为之的移动。
	private searchSettledTicks = 0;
	private lastAnchorDeadline = 0;

	// 一次位置增量 —— scroll 或 cursor —— 若它上一次用户输入（wheel、pointerdown、keydown，
	// 移动端还有触摸）比这个更旧，就是程序化移动：动态重渲染引起的布局位移、懒加载嵌入、
	// 插件驱动的滚动，尤其是同步客户端在打开的标签底下换掉的文件 —— 它会在毫无输入的情况下
	// 重新测量视口、重新映射光标。这个窗口够宽，能罩住触控板惯性滑行的尾巴。
	private readonly INTENT_WINDOW_MS = 2000;

	// 这些边界内的滚动目标属于嵌入渲染器，不属于视图自己的滚动容器：![[note]] / 图片嵌入、
	// 交互式代码组件、dataview 风格的渲染块。记录这样的滚动，就是把**宿主**编辑器的状态写到
	// 嵌入内容自己的移动上。
	private readonly EMBED_BOUNDARY_SELECTOR = '.internal-embed, .cm-embed-block, [class*="block-language"]';

	// 一切不是正数的值（手改过的 data.json、从别的设备同步来的值）都读成 0 = 不记录：一个坏值的
	// 安全方向是沉默，绝不是「每次光标移动都算一次跳转」。
	private get teleportMinLines(): number {
		const n = Math.floor(this.settings.navHistoryTeleportMinLines);
		return Number.isFinite(n) && n > 0 ? n : 0;
	}

	// 滚动的遥测跳变基线（桌面事件路径）。每次程序化重锚定（恢复落地、去重重申 —— 见
	// PositionState）lastAnchorAt 都会抬，所以两者不等就意味着光标自上次事件以来被重新放置过，
	// 基线必须静默重设 —— 否则从落点到旧基线的距离会被读成一次跳转。
	private teleportFrom: EditorPosition | undefined;
	private teleportFromPath: string | undefined;
	private teleportAnchorAt = 0;

	constructor(app: App, store: PositionStore, settings: PluginSettings, state: PositionState, funnel: NavFunnel) {
		this.app = app;
		this.store = store;
		this.settings = settings;
		this.exclusions = new ExclusionChecker(app, settings);
		this.state = state;
		this.funnel = funnel;
	}

	sampleActiveView() {
		// 卡死锚点的安全网：一个持焦的搜索框被移出 DOM（快速切换关掉、查找栏收起）时，Chromium
		// 不发 focusout —— 焦点悄悄退回 body —— 那会让 searchAnchorUntil 永远停在 Infinity，
		// 把本会话之后的所有记录全禁掉。失焦后的宽限定时器还挂着时**绝不能**跑这里：一次正常的
		// 失焦也会把 activeElement 退回 body，此时在这里清掉 Infinity 会截断宽限，失焦后落地的
		// 搜索跳转就会盖掉保存的位置。
		if (this.state.searchAnchorUntil === Number.POSITIVE_INFINITY && !this.searchGraceTimer) {
			const active = document.activeElement;
			if (!active || !active.closest(this.SEARCH_INPUT_SELECTOR))
				this.state.searchAnchorUntil = 0;
		}

		// 本插件只处理 markdown 视图；其它类型（canvas、PDF 等）完全跳过。
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file)
			return;

		const filePath = view.file.path;

		// 有恢复在进行中时跳过，或者当前活动文件不是我们加载的那个时跳过
		// （首次加载前 lastLoadedFilePath 未设，那时它永远匹配不上）
		if (this.state.isRestoringFile() || filePath !== this.state.lastLoadedFilePath)
			return;

		// 记录规则只拦**位置**记录 —— 导航历史与规则无关（前进后退在排除的文件里也得能用）：
		// 存下的记录被丢掉，但 tick 继续跑，遥测跳变的检测因此仍能推导航条目。
		const skipRecording = this.exclusions.shouldSkipRecording(view);
		if (skipRecording)
			this.store.dropExcluded(filePath);

		const st = readEphemeralState(view);
		if (!st)
			return;

		const prev = this.state.lastEphemeralState;

		// 上一次落地留下的陈旧 tick 计数不能把下一次提前作废。
		if (this.state.searchAnchorUntil !== this.lastAnchorDeadline) {
			this.lastAnchorDeadline = this.state.searchAnchorUntil;
			this.searchSettledTicks = 0;
		}

		// 视图一停稳就让**有限的**吸收提前作废：跳转已经落地。Infinity（有个搜索框正持焦）
		// 交给上面的安全网。
		if (Number.isFinite(this.state.searchAnchorUntil) && this.state.isSearchAnchored()) {
			if (prev && isEphemeralStatesEquals(st, prev)) {
				if (++this.searchSettledTicks >= 2) {
					this.state.searchAnchorUntil = Date.now();
					this.searchSettledTicks = 0;
				// 这次落定读到的**就是**落点。把它挂到为这次跳转推入的那个条目上
				// （带键 → 在 refreshTop 里回填 / 保留，后者守着 path+leaf）—— 这才是
				// 精确返回的位置，也是最近文件列表从这里取走的那个（`landing: true`；
				// 别的调用方交上来的都是读者的**离开**位置，地点不能把它误当成跳转
				// 自己的落点）。
				this.funnel.settled(filePath, this.state.leafId(view.leaf), readLandingState(view) ?? st);
				}
			} else {
				this.searchSettledTicks = 0;
			}
		}
		let write: EphemeralState | undefined;

		if (prev) {
			if (!this.state.isSearchAnchored()) {
				// 一道门管两半、管两个平台：没有近期输入为之作证的增量就是程序化移动，记下它就是
				// 保存的位置被文件的顶部覆盖的方式 —— 同步客户端在打开的标签底下换掉笔记时，
				// 会在读者什么都不做的情况下重测视口**并**重映射光标。
				if (Platform.isMobileApp) {
					// 移动端的退路：WKWebView 下 DOM scroll 事件不可靠，所以由轮询自己记录
					// 整个状态，scroll 连同 cursor。
					if (!isEphemeralStatesEquals(st, prev) && this.hasUserIntent())
						write = st;
					// 否则：被吸收 —— 下面刷新 lastEphemeralState 但不写库，
					// 这次位移就成了新基线。
				} else {
					// 桌面端：只在光标移动时记录 —— 只有 scroll 变化的增量归滚动采集监听器。
					// 写进去的是本 tick 读到的状态（db 记录可能落后一个防抖周期）。只比较光标：
					// 基线里由恢复器种下的 scroll 不算变化。
					if (!isCursorStatesEqual(st.cursor, prev.cursor) && this.hasUserIntent())
						write = st;
				}
			}
			// 否则：有一场搜索正在进行（见 installSearchAnchor）—— 光标移动是搜索引擎在各匹配
			// 之间跳，永不写入。

			if (write) {
				// 这条路径上不做遥测跳变检测：轮询是触屏设备唯一的光标采样器，而它无从推断 ——
				// 滑一下不动光标，每一次有意为之的远跳都以自己的带键条目到达。所以移动端的
				// 前进后退仍然只关乎读者是从哪个文件来的。
				if (!skipRecording) {
					// store 同时更新 leaf 层与文件层（并对两者去重）。移动端没有滚动采集监听器，
					// 所以那里的轮询是 leaf 层的**唯一**写者 —— 没有它，同一个文件开在两个标签页
					// 时，重启后两个都会恢复成同一条逐文件记录，而不是各自的位置。
					this.store.write(this.state.leafId(view.leaf), filePath, write);
					// 用户从恢复的位置挪走了：收起提示（RestoreCue 里有宽限保护，
					// 免得移动端恢复后的抖动把它闪掉）。
					this.state.cue.dismissOnMove();
				}
			}
		}

		this.state.lastEphemeralState = st;
	}

	// workspace 里任何地方每次触发 scroll 都会跑；记录所属 leaf 的位置 —— 活动的或后台的都记。
	// 这正是只盯活动视图的轮询漏掉的：一个非活动时被滚过、又在被激活之前就关掉的窗格。
	private onScrollCapture = (ev: Event) => {
		const target = ev.target as HTMLElement | null;
		if (!target) return;

		// 恢复的滑动 / 应用会在被恢复的 leaf 上甩出 scroll 事件；有恢复在进行中时跳过一切记录，
		// 免得那些事件盖掉保存的位置。
		if (this.state.isRestoringFile()) return;

		// 搜索跳转也会滚动（滚到匹配处）；同轮询吸收掉的那些光标跳动一样，程序化的搜索移动
		// 不得盖掉保存的记录。
		if (this.state.isSearchAnchored()) return;

		// 没有近期用户输入的滚动是程序化移动、不是用户的选择 —— 与轮询对自己那些增量用的是
		// 同一道门。
		if (!this.hasUserIntent())
			return;

		// 先把滚动目标解析到它所属的 leaf / 视图……
		const leaf = this.findOwnerLeaf(target);
		const view = leaf?.view;
		if (!leaf || !(view instanceof FileView) || !view.file)
			return;

		// ……再拒收属于嵌入渲染器的滚动：这次移动属于嵌入内容、不属于宿主滚动容器，记下它就会
		// 写到宿主状态上 —— 从构造上就是错的。宿主状态并没有变，所以基线也无需调整。
		const embedBoundary = target.closest(this.EMBED_BOUNDARY_SELECTOR);
		if (embedBoundary && view.containerEl.contains(embedBoundary))
			return;

		// ……再记录。被排除的 path（以及文本视图里低于 minLinesToRecord 的文件）永不记录；
		// 该 path 的每一条记录都被丢掉 —— 两层都丢 —— 免得后来的有效状态跟一条已丢的记录去重。
		const filePath = view.file.path;
		const leafId = this.state.leafId(leaf);

		if (this.exclusions.shouldSkipRecording(view)) {
			this.store.dropExcluded(filePath);
			return;
		}

		// markdown 的 leaf 记行 / 光标状态。
		if (view instanceof MarkdownView) {
			// 被捕获的这次滚动本身就是 app 填视图缓存的信号，所以这里它已是当前的 —— 而且它是
			// 唯一仍知道一个不在布局里的窗格之位置的东西，本监听器也会记那种情形（一个后台窗格
			// 被滚过、又在被激活之前关掉）。
			const st = readSampledState(view);
			if (!st) return;

			this.store.write(leafId, filePath, st);
			return;
		}

		// Base 视图是唯一被记录的非 markdown 文件，且只在明确开启时才记（recordBaseScroll）：
		// 它可记录的状态是一个裸的滚动容器 scrollTop，是设备私有的 —— 默认记录会让一台别的设备
		// 同步来的记录用一个不适配本视口的偏移盖掉本地那条。它们的 scroll 事件从不冒泡，
		// 所以 target 正好就是滚动的那个元素。PDF 被硬排除（PDF.js 原生历史已经记得同设备的位置）；
		// 别的 FileView 没有可用的滚动。
		if (view.getViewType() !== 'bases' || !this.settings.recordBaseScroll) {
			this.store.forgetLeaf(leafId);
			return;
		}
		this.store.write(leafId, filePath, { scroll: Math.round(target.scrollTop) });
	};

	// 到底是哪个窗格滚了：那个可记录的、其视图容器包含滚动目标的 leaf。
	private findOwnerLeaf(target: HTMLElement): WorkspaceLeaf | undefined {
		// 快路径：活动 leaf 是压倒性最常见的滚动来源，直接解析它能免掉每一轮爆发都跑下面
		// 那次 DOM contains() 扫描。
		const active = this.app.workspace.getActiveViewOfType(FileView);
		if (active?.file && active.containerEl.contains(target))
			return active.leaf;

		// 后台窗格：扫所有 leaf。找到之后 `owner` 短路掉剩下的回调工作（迭代本身停不下来）。
		let owner: WorkspaceLeaf | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (owner) return;
			const view = leaf.view;
			if (view instanceof FileView && view.file && view.containerEl.contains(target))
				owner = leaf;
		});
		return owner;
	}

	// 给 setViewState 补丁用的离开时刷新：常规写者都有滞后（100ms 轮询、97ms 防抖的滚动采集），
	// 所以在这个窗口里挪一下又迅速跳走就会丢掉最后的位置 —— 待处理的防抖在交换之后才触发，
	// 那时它的滚动容器已经跟每个视图脱开，这次写就被丢了。这里在交换之前、同步地拿正要被换出去的
	// 视图的确切状态调它。store 的写入会去重：自上一条以来什么都没动时是空操作。
	//
	// 它同时是唯一**同步**发生的写入，所以不像那三个滞后的写者那样等得起恢复落定：一篇笔记
	// 打开后还在等首绘（阅读模式最长 2 秒）时读者点链接跳走，这里读到的就是尚未落地的中间态
	// —— 多半是顶部 —— 写进去就把这篇笔记保存的位置永久顶掉了。所以恢复期间它跟另外三个
	// 写者走同一道门：宁可赔上一个 tick 的滞后，也不能把读者的位置改错。
	flushOnLeave(view: MarkdownView, filePath: string, st: EphemeralState): void {
		if (this.state.isRestoringFile())
			return;
		if (this.exclusions.shouldSkipRecording(view))
			return;
		this.store.write(this.state.leafId(view.leaf), filePath, st);
	}

	// 采集每个窗格的滚动，那是轮询看不到的。挂在 workspace 根上、捕获阶段，好把任何嵌套滚动容器
	// 的滚动都捞住。
	installScrollCapture(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		// scroll 成串地发；防抖把这一阵写入风暴收敛成一次末尾调用，好把这次移动最终停下的位置
		// 持久化下来。
		const onScroll = debounce(this.onScrollCapture, this.STORE_INTERVAL, true);
		container.addEventListener('scroll', onScroll, {
			 capture: true, 
			 passive: true 
		});
		registerCleanup(() =>
			container.removeEventListener('scroll', onScroll, { capture: true })
		);
	}

	// 仅桌面端。给用户输入盖时间戳，好让滚动采集监听器把用户驱动的滚动与程序化移动分开 ——
	// 这是轮询与本监听器共用的那道意图门的桌面端那一半。捕获阶段 + passive：纯粹的盖戳。
	// 用户滚动的入口全被覆盖（触控板 / 鼠标 = wheel，拖滚动条 / 触摸 = pointerdown，
	// 键盘 = keydown）。
	installUserIntentTracker(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		const markUserInput = () => { this.state.lastUserInputAt = Date.now(); };
		container.addEventListener('wheel', markUserInput, { capture: true, passive: true });
		container.addEventListener('pointerdown', markUserInput, { capture: true, passive: true });
		document.addEventListener('keydown', markUserInput, { capture: true });
		registerCleanup(() => {
			container.removeEventListener('wheel', markUserInput, { capture: true });
			container.removeEventListener('pointerdown', markUserInput, { capture: true });
			document.removeEventListener('keydown', markUserInput, { capture: true });
		});
	}

	// 桌面端的文件内遥测跳变检测，按编辑器选区事件逐次跑，而不是轮询的 100ms tick：tick 会把
	// 光标移动量化（按住键每 tick 累积 5–10 行），门槛因此得抬到足以吞掉段落级的跳动；而选区
	// 事件是一次用户动作一个。只喂导航栈 —— 位置记录仍然来自轮询与滚动采集。
	//
	// 一个 workspace 级的监听器覆盖每个 markdown 编辑器；嵌入的与镜像的编辑器（不同的 Editor
	// 实例）以及后台窗格，靠活动编辑器身份核对过滤掉。'editor-selection-change' 是运行时的
	// workspace 事件、官方类型里没有（每次编辑器选区变化都以 (editor, info) 触发）；用 Events
	// 的泛型字符串重载注册它。
	installTeleportWatcher(registerCleanup: (fn: () => void) => void) {
		const ref = (this.app.workspace as unknown as {
			on(name: string, callback: (editor: Editor, info: unknown) => void, ctx?: unknown): unknown;
		}).on('editor-selection-change', this.onEditorSelection);
		registerCleanup(() => this.app.workspace.offref(ref as EventRef));
	}

	// 滚动基线在**每一次**被接受的事件上刷新 —— 包括下面那些门所压制的移动 —— 所以一场搜索
	// 期间的跳动会静默重设基线，锚点失效后的第一次有意移动，比较的是真正的前一行（与轮询在
	// sampleActiveView 末尾那次无条件刷新同一份契约）。
	private onEditorSelection = (editor: Editor): void => {
		const minLines = this.teleportMinLines;
		// 阈值为 0 时什么都不是跳转；在做任何事之前退出，并重设基线，好让再次抬高阈值时从干净
		// 状态开始 —— 一个陈旧的 prev 会被读成一次假跳转。
		if (minLines <= 0) {
			this.teleportFrom = undefined;
			return;
		}
		// 只有活动的 markdown 视图参与：嵌入 / 镜像的编辑器与后台窗格对导航不可见，
		// 正如它们对轮询也不可见。
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.editor !== editor)
			return;
		const filePath = view.file?.path;
		if (!filePath || filePath !== this.state.lastLoadedFilePath)
			return;

		const from = editor.getCursor('anchor');
		// 重锚定纪元：自上次事件以来，一次恢复落地（或去重重申）程序化地重新放置了光标，
		// 所以静默重设基线，而不是把落地读成一次跳转。
		const reanchored = this.teleportAnchorAt !== this.state.lastAnchorAt;
		this.teleportAnchorAt = this.state.lastAnchorAt;
		const prev = reanchored ? undefined : this.teleportFrom;
		const prevPath = reanchored ? undefined : this.teleportFromPath;
		this.teleportFrom = from;
		this.teleportFromPath = filePath;
		// 选区不是光标：anchor 与 head 跨的是选了多少，不是读者走了多远 —— Cmd+A 会把它们放在
		// 文件两端。没有阈值能滤掉这个，所以基线也一并丢掉：下一次事件绝不能从一个读者从未站过的
		// 点量起。一场搜索会为此赔上一次移动 —— 它的跳动都是带键的，不需要推断出的步。
		if (editor.somethingSelected()) {
			this.teleportFrom = undefined;
			return;
		}
		// 换了文件就是一次切换、不是文件内跳转：静默重设。
		if (!prev || prevPath !== filePath)
			return;
		if (Math.abs(from.line - prev.line) < minLines)
			return;
		if (this.state.isRestoringFile() || this.state.isSearchAnchored())
			return;

		const leafId = this.state.leafId(view.leaf);
		// 对正要离开的那个条目做「离开时更新」：无键的 open / 激活型栈顶拿到轮询最近一次读到的
		// 值 —— 按最后一个轮询 tick 计的跳转前位置（最多陈旧一个 tick，见 withNavDisplay 的
		// 说明）。带键的栈顶被栈跳过：它们保留推入时的那个落点。CM 在这个事件之后才应用跳转的
		// scrollIntoView，所以可见性检查看到的仍是跳转前的视口。
		if (this.state.lastEphemeralState)
			this.funnel.leave(filePath, leafId, withNavDisplay(view, this.state.lastEphemeralState));
		// 推入的条目带的是这次跳转的落点：跳转后的实时读（光标已在目标处）。
		this.funnel.recordTeleport(filePath, leafId, from.line, readNavEntryState(view));
		// 滚动在这个事件**之后**才落地 —— CM 在它的 measure 阶段应用跳转的 scrollIntoView
		// （2026-09 实测：一次跳到第 323 行的大纲跳转，记下的源 scroll 是 232），所以推入时
		// 读到的是源 scroll。晚一帧再读一次，并**广播**这次更正；栈只在这次遥测跳变仍是它的
		// 栈顶步时才接受（见它的 onLanded）。一个 rAF 足以罩住延迟测量那种情形；那之后再读到
		// 的仍然是陈旧值就不更正了。
		window.requestAnimationFrame(() => {
			if (this.app.workspace.getActiveViewOfType(MarkdownView) !== view)
				return;
			if (view.file?.path !== filePath)
				return;
			// 在这一帧之前用户又动了：他的位置是他的，不是这次跳转的落点。
			if (editor.getCursor('anchor').line !== from.line)
				return;
			const settled = readNavEntryState(view);
			if (settled)
				this.funnel.landing({ kind: 'teleport', path: filePath, leafId, line: from.line, st: settled });
		});
	};

	// 轮询刚观察到的增量可不可能就是读者自己的移动 —— 每次写入背后都是这一个问题。触摸与桌面端的
	// 那些戳并列，因为它是手机唯一可靠送来的信号：WKWebView 会丢 scroll 事件，软键盘可能一个
	// keydown 都不发。
	//
	// 这个窗口是绝对的，绝不从上次恢复锚点量起：一次同步可能落在阅读过程中的任何一分钟，而读者
	// 碰过一次屏幕，并不因此就把之后一小时都算作他许可了。
	private hasUserIntent(): boolean {
		const stamp = Math.max(this.state.lastTouchAt, this.state.lastUserInputAt);
		return Date.now() - stamp < this.INTENT_WINDOW_MS;
	}

	// 仅移动端。touchstart 罩住每一次触摸滚动 —— 惯性阶段也算，因为戳只要够新就行。keydown 是让
	// 打字算数的那一环：软键盘不动编辑器就能移动光标，而移动了的光标是读者的、不是重渲染的。
	installTouchListener(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		const onTouch = () => { this.state.lastTouchAt = Date.now(); };
		const onKey = () => { this.state.lastUserInputAt = Date.now(); };
		container.addEventListener('touchstart', onTouch, { capture: true, passive: true });
		document.addEventListener('keydown', onKey, { capture: true });
		registerCleanup(() => {
			container.removeEventListener('touchstart', onTouch, { capture: true });
			document.removeEventListener('keydown', onKey, { capture: true });
		});
	}

	// 一个搜索框持焦就装好这道守卫，好让搜索引擎执行的跳转永远不能用用户从未选过的地点盖掉保存
	// 的位置 —— 搜索前的位置已在库里，仍是下次打开时视图回到的那个锚点。失焦后经过
	// SEARCH_ANCHOR_GRACE_MS 才解除。
	installSearchAnchor(registerCleanup: (fn: () => void) => void) {
		const isSearchInput = (ev: FocusEvent): boolean => {
			const el = ev.target as HTMLElement | null;
			return !!el && typeof el.closest === 'function' && !!el.closest(this.SEARCH_INPUT_SELECTOR);
		};
		const onFocusIn = (ev: FocusEvent) => {
			if (!isSearchInput(ev)) return;
			// 上一次失焦留下的宽限定时器还在跑时又聚焦：杀掉它，保持武装。
			if (this.searchGraceTimer) {
				window.clearTimeout(this.searchGraceTimer);
				this.searchGraceTimer = 0;
			}
			this.state.searchAnchorUntil = Number.POSITIVE_INFINITY;
		};
		const onFocusOut = (ev: FocusEvent) => {
			if (!isSearchInput(ev)) return;
			if (this.searchGraceTimer) window.clearTimeout(this.searchGraceTimer);
			this.searchGraceTimer = window.setTimeout(() => {
				this.searchGraceTimer = 0;
				// 一个有限的将来锚点意味着：恢复器为一次 open-kind 跳转的落地（restoreOpen）
				// 重新装了记录，而那件事的异步到达可能超过这个宽限窗口 —— 在这里让它作废就会把
				// 落地记下来。只作废本次失焦关掉的那个 Infinity。
				if (Number.isFinite(this.state.searchAnchorUntil))
					return;
				this.state.searchAnchorUntil = Date.now(); // 已过期
			}, this.SEARCH_ANCHOR_GRACE_MS);
		};
		document.addEventListener('focusin', onFocusIn, true);
		document.addEventListener('focusout', onFocusOut, true);
		registerCleanup(() => {
			document.removeEventListener('focusin', onFocusIn, true);
			document.removeEventListener('focusout', onFocusOut, true);
			if (this.searchGraceTimer) window.clearTimeout(this.searchGraceTimer);
		});
	}

	// 一个文件变成被 frontmatter 排除，就在那一刻丢掉它的记录（metadata 缓存的 'changed'
	// 在文件的 metadata 解析完后触发），而不是等下一个轮询 tick 或一次滚动 —— 把文件改成
	// `position-restore: false`，不能留下一条以后还会恢复一次的记录。非 frontmatter 的排除
	// 不变：由轮询 / 滚动采集那道门处理。
	installFrontmatterWatch(registerCleanup: (fn: () => void) => void) {
		const onCacheChanged = (file: TFile) => {
			const decision = frontmatterDecisionFor(this.app, file, this.settings);
			if (decision?.skip)
				this.store.dropExcluded(file.path);
		};
		const ref = this.app.metadataCache.on('changed', onCacheChanged);
		registerCleanup(() => {
			this.app.metadataCache.offref(ref);
		});
	}
}
