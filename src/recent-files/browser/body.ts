// 最近文件浏览器的 **BODY**：关于这个面板、且不属于 shell 的一切。两个 shell 立在它周围
// —— 模态框与常驻侧边栏面板 —— 而它们共享的一切住在这里：工具栏、列表、键盘、行走。
// 一个 shell 只拥有它自己的生命周期、别无其它，这就是为什么行走是一个回调：
// 读者去往某处时模态框关闭，而侧边栏留下。
//
// **除了两件事之外是只读的**，而这正是常驻面板得以可能的原因：body 画出地点在
// render() 被调用那一刻所持有的东西，而它唯一能说回去的，是一行**可以**被要求的两件事
// —— 去那里，以及走开。

import { App, CachedMetadata, EventRef, HoverParent, Menu, MenuPositionDef, TAbstractFile, TFile, setIcon, Keymap } from 'obsidian';
import { NavEntry, NavJump, navGroupKey, outlineHeading } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { PlaceList, placeKey, ReclaimedLine } from '@/recent-files/places';
import { EphemeralState, LandingsMode, PathDisplayMode, PreviewFocusMode } from '@/types';
import { t } from '@/i18n';
import { linesSource } from '@/position/capture/ephemeral';
import { headingTrailAtLine } from '@/shared/headings';
import { markdownViewFor } from '@/shared/leaf';
import { nowLineFor, NowLineFacts } from './now-line';
import { NavEntryDescription } from './model';
import { RecentFilesReads } from './reads';
import { RecentFilesList, RecentFilesListOptions } from './list';
import { PreviewSettle } from './hover-settle';
import { LATE_READ_REDRAW_MS, NAV_SOURCE_ID, TIME_REFRESH_MS } from './constants';

// 列表元素 id 用的每体序号。
let browserSeq = 0;

// 一个无法在 linktext 里行走的标题：这些字符每一个都会被读作链接语法、而不是节名的一部分 ——
// `#` 与 `^` 开一个子路径，`|` 开一个别名，`[` 与 `]` 开链接。
const UNTRAVELABLE = /[#^|[\]]/;

// **一个箭头**，而四个是这样：两个走读者自己的步，两个去往他们正站在其中的那篇笔记的
// 两端。
type ArrowAct = 'back' | 'forward' | 'top' | 'bottom';

// **两个胶囊、而不是四个一行**：两对是不同的东西，而立在列表上方的四个箭头读起来像
// 四种滚动那张列表的方式 —— 那正是它们绝不能被误认为的东西。两者之间的那道空隙，
// 就是全部的区别所在。
const ARROW_GROUPS: readonly (readonly [ArrowAct, ArrowAct])[] = [
	['back', 'forward'],
	['top', 'bottom'],
];

// 箭头到线、而不是光秃秃的箭头：展示给读者的那个字形，其箭杆**终止于一条线**上，
// 而那正是一篇笔记的一端。一个尖角号（chevron）主张的是相反的事 —— 一步，朝着它
// 所指的方向。
const ARROW_ICON: Record<ArrowAct, string> = {
	back: 'arrow-left',
	forward: 'arrow-right',
	top: 'arrow-up-to-line',
	bottom: 'arrow-down-to-line',
};

// 一个按钮**叫**什么，借用自这四个所运行的命令：命令面板上与按钮上是同样的词，也是
// 面板里唯一说出其中两个去往**谁的**端的地方（"top of note" —— 笔记的端，不是这份列表的）。
const ARROW_NAME: Record<ArrowAct, Parameters<typeof t>[0]> = {
	back: 'navHistory.commands.navigateBack',
	forward: 'navHistory.commands.navigateForward',
	top: 'noteEdge.commands.top',
	bottom: 'noteEdge.commands.bottom',
};

// 加在 app 为这个面板打开的那张卡片上、别处一概不加：popover 是 core 的对象、由 core 自己的
// 规则绘制，而这个面板关于它外观唯一说的话就是**它立在哪**。
const PREVIEW_CLASS = 'position-restore-nav-preview';

// 浏览器**据以绘制的**偏好，由持久化它们的插件交给每个 shell。全部都是**读取器**而不是值：
// 常驻面板在 render 期间的一次调用里画出它的列表，所以别处做出的一次改动会被下一次重画拾取，
// 而不是被冻结进碰巧打开着的那一个面板里。
export interface RecentFilesBrowserPrefs {
	// 列表打印一篇笔记的多少（见 LandingsMode）。
	landings: () => LandingsMode;
	// 最近文件列表保留多少个地点。
	placesCap: () => number;
	// 列表打印一行的路径多少，以及打印在名字的哪一侧。
	pathDisplay: () => PathDisplayMode;
	rowTime: () => boolean;
	// 一行作为笔记名字来打印的 frontmatter 属性，为空表示没有
	// （见 PluginSettings.recentFilesTitleProperty）。每次重画时读：它决定下一次
	// 打印什么。
	titleProperty: () => string;
	// 一行的预览**在笔记的哪里**打开（见 PreviewFocusMode）。每次悬停读、而不是每次重画读：
	// 它不命名任何被绘制的东西，而它决定一次悬停究竟是否非得去寻找那篇笔记的行号。
	previewFocus: () => PreviewFocusMode;
}

// **箭头所承载的四个动作**，以及每一个是否能做。body 不持有任何历史、也不持有自己的笔记
// —— 栈的两端、以及立在它们之下的那篇笔记，都是插件的 —— 所以 shell 把动作交下来、
// body 只发问，而正是这个让一个什么都不会做的按钮变灰（见 refreshArrows）。
//
// **每个 shell 都画出它们**，没有被关掉的开关：列表脚下的四个按钮不花列表任何东西
// （它们不是行，也不随任何东西滚动），而一个没有键盘的读者没有其它办法要求这四个中的
// 任何一个。一个动作可以**是异步的** —— 一步打开一篇笔记并等它 —— 而这个 promise
// 是 body 再次发问的信号（见 pressArrow）。
export interface RecentFilesBrowserArrows {
	back: () => void | Promise<void>;
	forward: () => void | Promise<void>;
	top: () => void | Promise<void>;
	bottom: () => void | Promise<void>;
	canBack: () => boolean;
	canForward: () => boolean;
	// 是否有一篇笔记打开着、可供那两端作用。
	canEdge: () => boolean;
}

export interface RecentFilesBrowserOptions {
	app: App;
	// 行的绘制所依据的**地点** —— 最近文件列表，绝不是前进/后退栈：一个在新跳转上会截断的
	// 栈回答不出「我去过哪些文件」。
	places: PlaceList;
	// body 把自己构建进去的那个元素。它的大小是 shell 的事。
	host: HTMLElement;
	// 文件保存的记录：每个 **FILE** 行的行号据以绘制的位置（一个地点不携带任何位置），
	// 以及普通打开所恢复的位置。
	savedPosition?: (path: string) => EphemeralState | undefined;
	// 设备自身的人机考量、别无其它 —— 一个盖住半个手机的屏幕键盘，一个值得轻点的 ×。
	// 无论哪种，列表都只用点击。
	touch: boolean;
	// 一次行走是否**先清空**读者在列表里的位置。一个保持立着的 shell 需要它：那次跳转会把
	// 另一篇笔记钉选在那个槽位里，而任何留下的位置都会命名滑进它的那个东西。
	collapseOnJump: boolean;
	// 过滤框是否在挂载时取得焦点。对话框想要它；常驻面板不该 —— 它随工作区被恢复，
	// 而从编辑器里抢走光标不是读者要求的事。
	focusFilter: boolean;
	// shell 自己对一次行走的反应，在历史被要求移动**之前**运行。
	onJump?: () => void;
	// 一个**没有键盘**的读者，以及他们否则无从要求的那四件事：一步后退与前步，以及
	// 他们打开着的笔记的两端。由 shell 交下来（见 RecentFilesBrowserArrows）。
	arrows: RecentFilesBrowserArrows;
	// shell 的**出路**，只由拥有它的 shell 提供：没输入任何东西时按下，框的 × 是关闭
	// 而不是清空（见 toolbar，以及快速切换器自己的）。一个保持立着的面板不提供，它的 ×
	// 只做清空。
	onDismiss?: () => void;
	prefs: RecentFilesBrowserPrefs;
}

export class RecentFilesBrowser {
	private list!: RecentFilesList;
	// 列表的选项对象，保留是因为它的两个字段在每次重画前被重新指向：常驻面板靠给它赋值来
	// 刷新，而不是重建列表（那样会丢掉读者所在的位置）。
	private listOpts!: RecentFilesListOptions;
	// 搜索框的文本。也就是列表自己的查询。
	private filter = '';
	private filterInput!: HTMLInputElement;
	// 那四个按钮，保留是因为每次绘制都会问它们每一个是否仍能被按下（见 refreshArrows）。
	private arrowsByAct = new Map<ArrowAct, HTMLButtonElement>();
	// 面板所做的每次 vault 查找，都被缓存 —— 全都是元数据缓存查找：一个条目的展示碎片、
	// 以及一个文件已解析的标题。
	private reads: RecentFilesReads;
	// 每体唯一：行的选项 id 由它构建，而过滤框的 aria-activedescendant 指向其中一个，
	// 所以侧边栏面板与模态框同时存在也不会撞车。
	private readonly listId = `position-restore-nav-list-${++browserSeq}`;
	// 这个面板在 app 的悬停预览系统里的槽位，整个 body 生命期只用一个对象：app 把它打开的
	// popover 写回给它、之后再问它，所以每次到达都新建一个会是没记忆的那个。
	private readonly hoverParent: HoverParent = { hoverPopover: null };
	// 用来遮住 popover 自己走向它所被要求的行号的旅程：app 究竟有没有作答，是在这个面板
	// 之外、在该行被要求之后的若干帧才决定的。
	private readonly settle = new PreviewSettle();
	// 指针停在列表上时列表被**保持**在的组次序。是 key 而不是行：这个次序必须活过它存在
	// 所为了阻止的那次重画。
	private frozenOrder?: string[];
	private timer?: number;
	// 欠给「在该行被画出之后才到达的某样东西」的重画 —— 一条节链，或一篇笔记自己的存在。
	// 被合并：整份列表一次发问，而每个各来一次重画会重建每一行。
	private lateTimer?: number;
	// vault 的文件事件，在这个 body 立着期间一直被监视（见 watchExistence）。
	private existenceRefs: EventRef[] = [];
	// 这个 body 升起的那个菜单，在它立着期间。留在这里是为了 app 看不见的两端：升起它的那个
	// 控件（它的按下 app 永远听不到），以及一个让开读者道路的 shell。
	private menu?: Menu;

	// 为了让一个行号被重新找到、vault 必须作答的那三个事实。每次发问都穿透读取：
	// 它们的一份副本会是一份会变陈旧的副本。
	private nowLines: NowLineFacts;
	// 每个地点的行号**此刻**所在之处，一次绘制里每个条目一个答案，由发问它的两样东西共享
	// —— 下面的回收，以及每一行打印的链。按条目的**索引**作键，那是这次绘制关于它自己的
	// 答案（见 reclaim）。
	private nowLineBy = new Map<number, number | undefined>();

	constructor(private opts: RecentFilesBrowserOptions) {
		this.reads = new RecentFilesReads(opts.app, {
			savedPosition: opts.savedPosition,
			// 活列表，每次重画重新指向：常驻面板描述的是地点现在的样子，而不是它打开时
			// 的样子。
			entries: () => opts.places.entries,
			// 从笔记自己的文本里读出的一条链会晚一次重画到达：它所属的那一行已经被画出、
			// 没有它。
			onLateRead: () => this.redrawSoon(),
			// 一行称呼这篇笔记用什么，以及读者在看的时候唯一能改变它的东西：他们正在
			// 输入那个命名它的属性。
			titleProperty: () => this.opts.prefs.titleProperty(),
			onTitleChange: () => this.render(),
		});
		this.nowLines = {
			mtimeOf: path => this.reads.mtimeOf(path),
			cacheFor: (path: string): CachedMetadata | null => {
				const file = this.opts.app.vault.getAbstractFileByPath(path);
				return file instanceof TFile
					? this.opts.app.metadataCache.getFileCache(file)
					: null;
			},
		// 一篇**打开着**的笔记是唯一不会落后于实际的来源：它自己的缓冲区正是读者在看的东西，
		// 无论保存与否。其它一切从磁盘读出，且只在发问方愿意等它时。
		linesOf: (path, prime) => {
				const open = markdownViewFor(this.opts.app, path);
				if (open)
					return open.editor;
				const lines = this.reads.linesFor(path, prime);
				return lines ? linesSource(lines) : undefined;
			},
		};
	}

	// 在 shell 的元素里构建工具栏与列表。每个 body 调用一次：工具栏**不**随每次重画重建，
	// 所以在输入重画它下面的列表时，过滤输入框保有自己的焦点与光标。
	mount(): void {
		// 面板由之构成的那些条带 —— 过滤、列表、箭头 —— 是一个 flex 列（见 styles.css），
		// 而这个 class 由 shell 自己的元素来携带，而不是针对某个 shell 写的一条规则。
		// `is-touch` 也搭在它上面：对话框把它带在对话框的根上，常驻面板则带在这个元素上。
		this.opts.host.addClass('position-restore-nav-host');
		if (this.opts.touch)
			this.opts.host.addClass('is-touch');
		this.toolbar();
		const listEl = this.opts.host.createDiv({ cls: 'position-restore-nav-list' });
		// 一个 listbox，它的 option 就是那些行，而它的当前 option 由过滤框通过
		// aria-activedescendant 命名 —— 这正是那个 id 使之成为可能的事。
		listEl.setAttr('id', this.listId);
		listEl.setAttr('role', 'listbox');
		listEl.setAttr('aria-label', t('recentFiles.name'));
		this.listOpts = {
			list: listEl,
			listId: this.listId,
			// **活读**，好让工具栏的设置能到达一个已经立着的面板。
			landings: () => this.opts.prefs.landings(),
			pathDisplay: () => this.opts.prefs.pathDisplay(),
			rowTime: () => this.opts.prefs.rowTime(),
			// 每次重画时读：钉选是读者的，而立在那里的面板必须在一次钉选被做出的
			// 那一刻就听到它。
			pinned: () => this.opts.places.pinned,
			// 每次重画时读，好让一次发生在读者正停在列表上时的重画，按他们正在阅读的
			// 次序出来。
			order: () => this.frozenOrder,
			// 让两个地点成为一个的东西，为了一次其行已在它下面被重建掉的点击。
			// 是 store 自己对身份的看法。
			keyOf: (rep) => {
				const entry = this.opts.places.entries[rep];
				return entry ? placeKey(entry) : undefined;
			},
			entries: this.opts.places.entries,
			currentIndex: this.opts.places.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			// 一个地点究竟能否被列出：列表打不开的名字不是一行。store 会自己修剪这样一个
			// 地点；这里只是列表在认同。
			noteExists: path => this.reads.hasFile(path),
			trailFor: (entry, d, i) => this.trailFor(entry, d, i),
			// 这一篇的**各个**标题，搜索面用它（只有文件行走这条，见 render 的 keep）。
			// 现查、不存：metadataCache 没答时经 cachedRead 兜底（见 reads.ts），
			// 所以它永远是最新的，而体积与笔记长度无关。
			headingsFor: path => this.reads.headingsFor(path),
			// 这一行的落点是否**丢了**它所命名的标题（见 landingLost）：一个答案，由那**唯一**
			// 一个已经问过行号现在何处的方面给出，好让一行的词、它所警告的东西、以及它去往
			// 何处不能互相不一致。
			lostLanding: (entry, d, i) => this.landingLost(entry, this.nowLineAt(i, entry, d)),
			// 文件的其它名字：可搜索，且除 tooltip 外哪都不打印。
			otherNames: (path, printed) => this.reads.otherNamesFor(path, printed),
			onActiveRow: id => this.setActiveRow(id),
			onTravel: (rep, target) => this.jump(rep, target),
			// 该行命名的是**哪个文件**，以及该行是笔记本身还是它内部的一个点 —— 交给 app
			// 自己的预览用。这里没有任何东西为它行走。
			onHoverRow: (rep, ev, el, file) => this.hoverRow(rep, ev, el, file),
			tipsQuiet: () => this.settle.isOpen(),
			onHoverEnd: () => this.settle.hoverEnded(),
			// 一记右键问 **app** 它能拿这个文件做什么；菜单在这里构建，是因为列表不持有 app。
			onContextRow: (rep, ev, note) => this.contextRow(rep, ev, note),
			takeMenuBack: () => this.takeMenuBack(),
			// 一行自己的 ×：列表所要求、却无法自己做出的移除，因为地点在这里、不在那里。
			onForget: key => this.forgetRow(key),
			// ……以及**落点行**上同样的那个 ×，它丢掉那个位置、留下笔记立着。
			onForgetLanding: keys => this.forgetLanding(keys),
			// 一根停在一行上的手指，只在没有悬停可用来武装该行时才被听到。
			touch: this.opts.touch,
		};
		this.list = new RecentFilesList(this.listOpts);
		// settle 的两端，一次绑好：**谁**去守候 app 的答案（每次 hoverRow 都交出的那个
		// parent），以及它到来时做什么 —— 给这张卡片在面板 shell 之上所需的空间，并把行上的
		// 提示从一篇已作答的页面上拿开。
		this.settle.attach(this.hoverParent, card => {
			this.liftPreview(card);
			this.list.hideTip();
		});
		// 指针是 body 得知读者**正在用**这份列表的方式，而那正是被保持的次序所回答的问题。
		//
		// 用 pointerover 而不是 pointerenter：一个在已经停在那里的指针下面冒出来的面板
		// （启动时恢复的侧边栏、鼠标停在屏幕中央时打开的模态框）从不跨越边界，所以 enter
		// 从不触发。
		//
		// **手指在这里不是一个指针**：触摸投递同一对事件，而 leave 在手指**仍按着**时到达，
		// 于是 thawOrder 的重画会在一次触摸变成滚动时替换掉每一行 —— 它落在的那一行没了，
		// 连同那个手势一起。
		listEl.addEventListener('pointerover', (ev) => {
			if (ev.pointerType !== 'touch')
				this.freezeOrder();
		});
		listEl.addEventListener('pointerleave', (ev) => {
			if (ev.pointerType !== 'touch')
				this.thawOrder();
		});
		// ……以及那些行**没有**回答的点击：一次其行元素在按下与松开之间被重建掉的点击，
		// 而那正是列表按身份作答的那种点击。
		listEl.addEventListener('click', (ev) => this.list.onUnansweredClick(ev));
		// **箭头最后来**，因为那是它们立的地方 —— 在列表下面，在每台设备上（见 styles.css）。
		// 在第一次绘制之前建好，好让那次绘制把不能按下的变灰，而不是留它们活着直到下一次。
		this.arrows();
		// shell 元素上的一个 keydown 监听器同时覆盖过滤输入框与列表：输入时方向键导航、
		// Enter 跳转（否则输入框会移动自己的光标）。
		this.opts.host.addEventListener('keydown', (ev) => this.onKeyDown(ev));
		this.render();
		// 那些「多久以前」是从时钟读出的，所以一个没人碰的面板会漂。两样东西让它诚实：
		// 立在那里的面板所用的间隔，以及重新变得可见 —— 间隔覆盖不到的那种情形，因为一个
		// 切到后台的标签页的计时器会被节流好几个小时。
		this.timer = window.setInterval(() => {
			if (document.hidden || !this.opts.prefs.rowTime())
				return;
			this.render();
		}, TIME_REFRESH_MS);
		document.addEventListener('visibilitychange', this.onVisibilityChange);
		this.watchExistence();
		// 在触摸下框保持不聚焦：屏幕键盘会盖住小屏幕的一半。
		if (this.opts.focusFilter && !this.opts.touch && this.opts.places.entries.length > 0)
			this.filterInput.focus();
	}

	// （重）画地点与过滤所决定的一切。由 shell 在挂载时调用，且 —— 对常驻面板而言 ——
	// 每次地点变化时调用。
	render(): void {
		// 被笔记挪走的行号，在有任何东西据它绘制**之前**放回：下面的行打印它们将要行走到的
		// 坐标，而问两次会打印两个答案（见 reclaim）。
		this.reclaim();
		// 地点**此刻**的样子，在有任何东西读它们之前：列表按索引解析它的条目，所以一个在
		// 常驻面板下面移动了的列表，只靠重新指向这两个字段、别无其它就被拾取。describe 缓存
		// 也按索引作键，随它们一同走。
		this.listOpts.entries = this.opts.places.entries;
		this.listOpts.currentIndex = this.opts.places.index;
		this.list.render();
		// ……以及那些箭头，它们的四个答案不是这个 body 该留的：在**任何地方**做出的一步
		// —— 哪怕是从这些按钮本身 —— 都会改变它们每一个是否能被按下，而那两端之下的是
		// 一篇这个面板不持有的笔记。
		this.refreshArrows();
	}

	// 指针在列表上，所以列表**正被阅读**：保持它正在展示的次序。问题不是哪次变化是真的，
	// 而是是否还有人看着，而指针是那个问题的诚实答案。幂等。
	private freezeOrder(): void {
		if (this.frozenOrder)
			return;
		const keys = this.list.orderedKeys();
		// 空列表什么都不保持：保持 `[]` 会把此后每一次到达都钉到最前（见 groupByFile 的
		// rank）。
		if (keys.length)
			this.frozenOrder = keys;
	}

	// 指针离开了：没人在读这份列表了，所以它可以追上地点。重画发生**在这里** —— 在读者的
	// 注意力落在他们刚打开的笔记上时 —— 而不是在下一次历史变化时，那可能几分钟都不来。
	private thawOrder(): void {
		if (!this.frozenOrder)
			return;
		this.frozenOrder = undefined;
		this.render();
	}

	// 为一串自身不携带重画的到达做一次重画，而不是每个各来一次、或一次也没有：从一篇笔记
	// 自己的文本里读出的一条链在该行被画出之后才到达，而常驻面板自己欠的下一次重画是
	// 五分钟那个 tick。
	private redrawSoon(): void {
		if (this.lateTimer !== undefined)
			return;
		this.lateTimer = window.setTimeout(() => {
			this.lateTimer = undefined;
			this.render();
		}, LATE_READ_REDRAW_MS);
	}

	// 一行究竟能否被画出，是绘制时 **vault** 的答案（见 list.ts 的 noteExists），而这个答案
	// 的变化自身不携带任何事件：一次同步替换一篇笔记会把它拿走再放回，而在这中间被画出的行
	// —— 或之前就立着的那一行 —— 会被过滤掉，直到有东西重画，那在常驻面板上可能是几分钟。
	// 地点本身按设计活过这段空隙（见 PathBookkeeper），所以那一行并没有从列表里消失；
	// 是列表没被再次问及而已。
	private watchExistence(): void {
		const vault = this.opts.app.vault;
		this.existenceRefs = [
			vault.on('create', (file: TAbstractFile) => this.redrawForPath(file.path)),
			vault.on('delete', (file: TAbstractFile) => this.redrawForPath(file.path)),
			vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				this.redrawForPath(oldPath);
				this.redrawForPath(file.path);
			}),
		];
	}

	// 只对这份列表命名的路径：一次同步为它替换的那篇笔记触发，不为读者没去过的任何东西，
	// 而 vault 创建别的任何东西都不是这份列表的变化。
	private redrawForPath(path: string): void {
		// 一个 **VIEW** 地点不命名任何文件，所以 vault 关于一个文件的答案不是关于它的。
		if (!this.opts.places.entries.some(e => e.kind !== 'view' && e.path === path))
			return;
		this.redrawSoon();
	}

	// 丢掉属于这个 body 的东西：下面每一件都是在 shell 拥有的元素旁边注册的，而它们每一个
	// 都活过那些元素。
	destroy(): void {
		// 菜单立在 **document** 上而不是面板的元素里，所以关闭的 shell 带不走它的任何东西。
		this.closeMenu();
		// 列表把它的 tooltip 放在了 document 上，所以一个不走这一步就离开的 body，会为每一个
		// 曾打开过的对话框留下一个游离的元素。
		this.list.destroy();
		// 元数据监视器属于 reads，并活过它被建在其旁边的 DOM：一个对话框每次打开都是一个新
		// reads 对象。
		this.reads.dispose();
		// app 建起的 popover 仍是 app 的、并活过我们，所以在走之前把我们所遮住的揭开是我们
		// 该做的事。
		this.settle.stop();
		if (this.timer !== undefined)
			window.clearInterval(this.timer);
		this.timer = undefined;
		// ……以及一次迟到的读取可能仍欠的重画：它会重画一张元素已经没了的列表。
		if (this.lateTimer !== undefined)
			window.clearTimeout(this.lateTimer);
		this.lateTimer = undefined;
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
		for (const ref of this.existenceRefs)
			this.opts.app.vault.offref(ref);
		this.existenceRefs = [];
		// ……以及一次按下可能仍欠箭头的发问（见 pressArrow）：它是为那些随持有它们的 shell
		// 一起离开屏幕的按钮作答的。
		this.arrowsByAct.clear();
	}

	private onVisibilityChange = (): void => {
		if (!document.hidden && this.opts.prefs.rowTime())
			this.render();
	};

	private onKeyDown(ev: KeyboardEvent): void {
		// 在某个**箭头**持焦点时按下的键，由那个按钮自己作答：Enter 是它的按下，而方向键
		// 属于读者手下的控件，不属于它下面的列表。
		const on = ev.target instanceof Element ? ev.target : null;
		if (on?.closest('.position-restore-nav-arrows'))
			return;
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			this.list.move(1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.list.move(-1);
		} else if (ev.key === 'Enter') {
			// Enter 作用于**位置**、别的什么都不作用 —— 即箭头所走的那个行 —— 没有位置时它
			// 什么都不做。行走经由列表进行，那是知道位置在哪一行的一方。
			//
			// 'Mod' 是 app 对 Cmd/Ctrl 的平台无关名称；在这里读 metaKey/ctrlKey 会是那条
			// 规则的第二份副本。键盘需要它自己的「新标签页」：焦点从不离开过滤框，所以行的
			// 修饰键点击够不着。
			const target = Keymap.isModifier(ev, 'Mod') ? 'tab' : undefined;
			if (this.list.travel(undefined, target))
				ev.preventDefault();
		}
	}

	// 告诉辅助技术键盘正停在哪个 option 上。焦点从不离开过滤框，所以这个属性是让方向键
	// **唯一**能被听见的东西 —— 没有它，这个框读起来就像一个空的文本字段。
	private setActiveRow(id: string | undefined): void {
		if (id)
			this.filterInput.setAttr('aria-activedescendant', id);
		else
			this.filterInput.removeAttribute('aria-activedescendant');
	}

	// 那四个箭头，像工具栏一样每个 body 只建一次：每次重画都重建的一个条会把读者正伸手
	// 去够的按钮从他们手底下抽走。
	private arrows(): void {
		const bar = this.opts.host.createDiv({ cls: 'position-restore-nav-arrows' });
		for (const group of ARROW_GROUPS) {
			const capsule = bar.createDiv({ cls: 'position-restore-nav-arrow-group' });
			for (const act of group)
				this.arrowsByAct.set(act, this.arrowButton(capsule, act));
		}
	}

	private arrowButton(capsule: HTMLElement, act: ArrowAct): HTMLButtonElement {
		const name = t(ARROW_NAME[act]);
		const button = capsule.createEl('button', {
			cls: 'clickable-icon position-restore-nav-arrow',
			attr: { type: 'button', 'aria-label': name, title: name },
		});
		setIcon(button, ARROW_ICON[act]);
		// **这次按下被拒绝取得焦点**，正如框的 × 拒绝它：一个取得光标的控件会把下一次击键
		// 变成什么都没有，而读者正在输入的东西会跑进这个控件旁边的框里。它照样仍是键盘
		// 穿过面板途中的一个停靠点 —— Tab 能到达它、Enter 能按下它 —— 那是不用指针就能
		// 按下一个按钮的唯一办法。
		button.addEventListener('mousedown', (ev) => ev.preventDefault());
		button.addEventListener('click', () => this.pressArrow(act));
		return button;
	}

	// 一个箭头被按下。**shell 先让开路**，正如它对一行所做的那样：在手机上，面板盖住了
	// 这些动作所作用的笔记，所以一次读者看不见的移动是一次没有发生的移动。
	private pressArrow(act: ArrowAct): void {
		this.shellReacts();
		const arrows = this.opts.arrows;
		const ran = act === 'back' ? arrows.back()
			: act === 'forward' ? arrows.forward()
			: act === 'top' ? arrows.top()
			: arrows.bottom();
		// **在该动作落地之后**再次发问，而不是当场问：一步打开一篇笔记并等它，而在它下面
		// 发问会让两个箭头一起变灰那么久 —— 这就是两个活按钮看起来像两个坏按钮的原因。
		// 对话框在按下时就关闭，所以它欠的那次发问，可能发现这四个已经不在屏幕上了。
		void Promise.resolve(ran).then(() => this.refreshArrows());
	}

	// 每个箭头能否被按下，向插件发问而不是在这里算出来：步是栈的，而笔记是工作区的。
	// **每次绘制**都再问一次 —— 从任何地方走出的一步都会改变两个答案 —— 而没有笔记打开
	// 时那两端会安静下来，那是面板上唯一说出它们是谁的端的东西。
	private refreshArrows(): void {
		const arrows = this.opts.arrows;
		this.arrowEnabled('back', arrows.canBack());
		this.arrowEnabled('forward', arrows.canForward());
		const edge = arrows.canEdge();
		this.arrowEnabled('top', edge);
		this.arrowEnabled('bottom', edge);
	}

	// 一个变灰的按钮不只是按不下去：它是「那里什么都没有」这个答案，给出在读者已经在看
	// 的地方。
	private arrowEnabled(act: ArrowAct, on: boolean): void {
		const button = this.arrowsByAct.get(act);
		if (!button)
			return;
		button.disabled = !on;
		button.toggleClass('is-disabled', !on);
	}

	private toolbar(): void {
		const bar = this.opts.host.createDiv({ cls: 'position-restore-nav-toolbar' });
		// 框与它的 × 是一个控件：× 挂在框自己那一行上，在没有它可做的事时让开路。
		const strip = bar.createDiv({ cls: 'position-restore-nav-search' });
		const input = strip.createEl('input', {
			type: 'text',
			cls: 'position-restore-nav-filter',
			attr: {
				placeholder: t('recentFiles.searchPlaceholder'),
				// 这个框**就是**列表的键盘：方向键走那些行时它保持焦点，所以它是列表之上的一个
				// combobox（永远展开 —— 列表在屏幕上，不是一个弹出层），而当前 option 通过
				// aria-activedescendant 报告，而不是靠移动焦点。
				role: 'combobox',
				'aria-controls': this.listId,
				'aria-expanded': 'true',
				'aria-autocomplete': 'list',
			},
		});
		const clear = strip.createDiv({ cls: 'clickable-icon position-restore-nav-clear' });
		setIcon(clear, 'x');
		// 一个字形、两个动作（见下面的点击），所以它的**名字**说出它即将做哪一个：一个
		// 不是靠视觉到达的控件，在它做的事是关闭时就得说「关闭」。
		const nameClear = (): void => {
			const name = input.value !== '' || !this.opts.onDismiss
				? t('recentFiles.clearFilter')
				: t('recentFiles.close');
			clear.setAttr('aria-label', name);
			clear.setAttr('title', name);
		};
		// 读者输入的东西**就是**列表的查询，所以列表据它重画。
		const apply = (): void => {
			this.filter = input.value;
			nameClear();
			this.render();
		};
		input.addEventListener('input', apply);
		this.filterInput = input;
		nameClear();
		// **那个 ×**：按下被**拒绝**，好让光标从不离开框 —— 一个取得焦点的控件会把下一次
		// 击键变成什么都没有。是一个普通的 div 而不是 button，正如 app 自己的那个：它不是
		// 键盘穿过面板途中的一个停靠点。
		clear.addEventListener('mousedown', (ev) => ev.preventDefault());
		clear.addEventListener('click', () => {
			// **两个动作，就在 app 自己的 prompt 把它们放的那一个位置**：输入的清空，
			// 而没输入任何东西时这次按下反而是 shell 的**出路** —— 不提供出路的 shell
			// 让这个字形只做那一件事（见 onDismiss）。
			if (input.value === '') {
				this.opts.onDismiss?.();
				return;
			}
			input.value = '';
			apply();
			// 在**触摸**下焦点保持原样：在半个面板上召出屏幕键盘，与那次轻点所求的正好
			// 相反。
			if (!this.opts.touch)
				input.focus();
		});
	}

	// **被笔记挪走了的那些行号**，在有任何一行存在之前放回。
	//
	// **对整份列表只走一遍**，且在别的任何东西问它一行号之前：下面每一行都据它将要行走到的
	// 行号绘制（见 trailFor），而一份在一行移动时行已建了一半的列表，会按两个不同的答案把
	// 自己归组。
	//
	// **这里什么都不读文件。** 只问 vault 已经解析过的东西 —— 这既是让它对五十行来说负担
	// 得起的全部原因，也是让它保持诚实的全部原因：那些说不出的地方，就什么都不写，那行留给
	// 它自己去说（见 list.ts 的 landingNote）。
	//
	// **既不是一次访问、也不是一次重读。** 移动的是一个**地址**；地点保留着读者据以认识它
	// 的时间戳，也保留着它被记录时所用的词。
	private reclaim(): void {
		this.nowLineBy.clear();
		// 一行据以被描述的东西，在发问之前丢掉：下面的一次写会改变那些行所打印的正是这一
		// 行号。
		this.reads.clearDescribeCache();
		const entries = this.opts.places.entries;
		const moved: ReclaimedLine[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			// 只有**被一个 key 命名的**落点才有地址可放回：别的任何携带地址的东西都是从位置
			// 数据库得到的，而它每次都自己作答。
			if (entry.kind !== 'jump' || typeof entry.keyLine !== 'number')
				continue;
			// 读者正站在其中的一个地点：它的落点即将被「离开它之后随即到来的落定」再度整份
			// 读一遍，而在这里写下的答案会是一个「看着一篇没人离开过的文件」的面板给出的。
			if (i === this.opts.places.index)
				continue;
			const d = this.reads.describe(i);
			const line = this.nowLineAt(i, entry, d);
			if (line === undefined || line === d.lineIndex)
				continue;
			moved.push({ key: placeKey(entry), line, mtime: this.reads.mtimeOf(entry.path) });
		}
		if (moved.length)
			this.opts.places.reland(moved);
	}

	// 一个条目的行号**此刻**所在之处，或当这个面板说不出时返回 undefined（见 now-line.ts）。
	// **每次绘制每个地点只答一次**：上面的回收与下面的链对同一篇笔记问同一个问题，而两个
	// 答案可能不一致。
	//
	// `prime` 为 false，与它存在之前完全一样：一行被画出时不等待文件被读取，而行号随那次
	// 读取一同到达。
	private nowLineAt(i: number, entry: NavEntry, d: NavEntryDescription): number | undefined {
		if (this.nowLineBy.has(i))
			return this.nowLineBy.get(i);
		const line = nowLineFor(entry, d, this.nowLines, false);
		this.nowLineBy.set(i, line);
		return line;
	}

	// **一个落点是否丢了它所命名的标题**：该行代表一个标题，而笔记被写过之后，其中已不再有
	// 任何这个面板能据以找到该行位置的东西。
	//
	// 三样东西**挂在这个答案上、且不允许不一致**，这就是为什么它在这里问、而不是在它们
	// 每一个里问：行作为节**打印**什么（trailFor）、它在悬停上**警告**什么（list.ts 的
	// landingNote）、以及它的预览被指向哪个节（previewAsk）。一行读着 "Beta" 却在警告一个
	// 丢失的 "Alpha"，就是这里全部古怪之处：三个答案从三个地方读出，而只有一个是真的。
	//
	// `line` 是 nowLineFor 为这一行答出的东西，无论它是怎么被问的 —— 对行是每次绘制一次，
	// 对预览是每次悬停一次，而后者自己的发问**可能**读文件（见 nowLineAt）。
	private landingLost(entry: NavEntry, line: number | undefined): entry is NavJump {
		// 只有一个**地址是它 key 背后那个锚点**的落点才可能丢；别的任何东西都携带一个位置
		// 数据库为之作答的数字，而以笔记自己的名字行走的行从来就没有标题可丢。
		if (entry.kind !== 'jump' || typeof entry.keyLine !== 'number')
			return false;
		if (line !== undefined)
			return false;
		// ……且只在 vault 真的**读过**这篇笔记时：一次同步刚放回的笔记有一阵子不携带已解析的
		// 标题（在手机上则是永久），而那份沉默不是一个判决。
		return this.reads.hasHeadings(entry.path);
	}

	// 一个地点所处的节链，在它**此刻**所在的行号读、而不是它被记录时的行号 —— 两半必须来自
	// 同一个「此刻」。
	//
	// 在一个文件已挪走的行号上读出的链，命名的是**另一个**位置所处的节，而且它这么做时不
	// 移动、不闪烁、也没有别的任何会暴露它的东西：该行悄悄地对一条现在位于 "Alpha" 之下的
	// 行说 "Beta"，而预览打开的是 Alpha。记录下的数字仍然代表**行自己的词**：一个节内部的
	// 几行漂移不是另一个节。
	//
	// 一旦该行**自己的标题丢了**就不是了（见 landingLost）。那时没有漂移可原谅 —— 笔记被
	// 从锚点下面重写了，而在记录的行号上读出的链命名的是那个数字今天碰巧落在的节，那是这个
	// 行从未代表过的节。它改为打印的是它被记录时的那个标题：那些词是它自己的，是读者据以
	// 认识这个地点的，也恰恰是它的警告所谈论的那些词。一个不携带任何标题的 key —— 一个
	// linktext、一个块 id —— 得到的是「没有链」而不是错的链。
	//
	// 答案被要求时的 `prime` 是 nowLineAt 的事（包括「五十行不得读五十个文件」那条规则）：
	// 一次晚到一次重画的链，随那次读取一同到达（见 redrawSoon）。
	private trailFor(entry: NavEntry, d: NavEntryDescription, i: number): string[] {
		if (entry.kind === 'view')
			return [];
		const line = this.nowLineAt(i, entry, d);
		if (line === undefined && this.landingLost(entry, line)) {
			const named = outlineHeading(entry.key);
			return named ? [named] : [];
		}
		const at = line ?? d.lineIndex;
		if (at === undefined)
			return [];
		return headingTrailAtLine(this.reads.headingsFor(entry.path), at);
	}

	private jump(i: number, target?: PaneTarget): void {
		// 在 shell 保持立着的地方，先处理读者的位置：去往一个地点会重排列表，而一次跳转会
		// 重新压入栈，所以一个留在原处的位置会命名滑进那个槽位的那个东西。
		if (this.opts.collapseOnJump)
			this.list.collapse();
		// ……然后是 shell 自己的反应，好让对话框在它所触发的打开之前让开路。
		this.shellReacts();
		void this.opts.places.travel(i, target)
			.catch(e => console.error('Position Restore: recent-files travel failed:', e));
	}

	// 指针**移动到了**的一行，交给 **app**：问一次，它是否愿意被预览。
	//
	// app 自己的预览是被**请求**的，而不是在这里重建的。Obsidian 里每一个命名一篇笔记的其它
	// 地方，都由**一个** core 机制预览，它应答读者关于那件事的那一个设置；我们自己的预览会是
	// 第二个 popover、带着第二套规则，无论读者是否想要都打开。请求会继承一切，包括「什么都
	// 不发生」。
	//
	// 这里没有任何东西是**导航**：地点不动，没有行移动，没有列表被重画。一个无路径视图
	// 不被问及 —— 它背后没有页面。
	private hoverRow(rep: number, ev: PointerEvent, row: HTMLElement, file: boolean): void {
		const entry = this.opts.places.entries[rep];
		if (!entry || entry.kind === 'view')
			return;
		// **该行的行号今天在哪**，不是它被记录时在哪：一个行号是一个地址、不是一个地点。
		// 当这个面板说不出时，这次请求完全不携带行号，笔记在 app 自己的默认位置打开。
		// `prime` 在这里为 true，且只在这里：一次悬停可以为一个文件等一次 await，而没有
		// 任何东西随该答案被绘制。
		//
		// 当那个答案会被丢掉时**不去寻找**（见 wantsLine）：不命名行号少花整整一次读取，
		// 连同那次读取欠给已画出的行的重画一起 —— 在一次发问之后六十毫秒到期，而 app 可能
		// 仍在作答。
		const d = this.reads.describe(rep);
		const line = this.wantsLine(file)
			? nowLineFor(entry, d, this.nowLines)
			: undefined;
		// 一个**丢了**的落点会大声说出来（见 landingLost），所以这里没有任何东西可以与之
		// 相抵 —— 而向 app 请求一个节就会相抵，正如打印一个节那样。
		const ask = this.previewAsk(entry, entry.path, file, line, this.landingLost(entry, line));
		this.opts.app.workspace.trigger('hover-link', {
			event: ev,
			// 谁在发问：插件注册的那个 id，正是它让 app 得以应用读者给**这个**面板的答案
			// —— 而只有那次读取决定究竟有没有东西打开。
			source: NAV_SOURCE_ID,
			hoverParent: this.hoverParent,
			// 是**那一行**，不是指针落在的那个子元素：popover 属于列表的那一行，不属于被越过
			// 的那个词。
			targetEl: row,
			// 按它被打开所用的路径来指这篇笔记 —— 它在磁盘上的自己的名字，而不是行上打印的
			// 那个缩短过的名字。
			linktext: ask.linktext,
			sourcePath: entry.path,
			state: ask.state,
		});
		// 从这里开始，发问属于 settle：以「它是否命名了一个行号」武装 —— 那是唯一有旅程要走
		// 的一种 —— 它在**悬停**持续的期间守候 app 的答案，而不是在猜测所持续的期间。读者的
		// 按键可能在该行之后十秒才来。
		this.settle.ask(ask.state !== undefined);
	}

	// **一行如何命名它的位置**：靠它所在的**节**、靠它的**行号**、或什么都不靠。交给它一个
	// 数字（state.scroll）时，popover 先画出整篇笔记，等那次绘制落地后把滚动器移到那里，
	// 让目标闪一下（见 hover-settle.ts）。交给它一个节（`note.md#Heading`）时，这些都不
	// 发生：加载器**只**画那个节。两个都不给时，笔记在它的开头打开，正如 app 自带每一份列表
	// 打开它的方式。
	//
	// **代表文件的行**按**读者的选项**要求行号：那买到的是该行自己的点击本就会给出的到达，
	// 只是早一个手势；而它花掉的是一整篇笔记被渲染、然后被移动 —— 所以 app 自己的答案才是
	// 出厂的那个（见 PreviewFocusMode）。
	//
	// **落点行**命名的是笔记**内部**的一个地点，也因此被要一个。其行号上方没有标题、或其
	// 标题不能被信赖会在链接的另一边命名同一个地点的行，回落到行号 —— 一次都没移动就交付的
	// 错误节，比正确的地点晚到更糟。其行号这个面板找不到的行，两个都不命名。
	//
	// 一行究竟是否命名行号在这里定，而不是在悬停开始处定，因为它是两者都需要的**一个**答案：
	// hoverRow 问它，是为了知道要不要去读一个文件；这一个问它，是为了知道交给 app 什么。
	private wantsLine(file: boolean): boolean {
		return !file || this.opts.prefs.previewFocus() === 'line';
	}

	// 一个自己**标题丢了**的落点行，什么节都不命名：它记录的行号现在所落入的那个节属于另一行，
	// 而 app 会打开笔记、读着一个读者从未去过的地点。它的行打印它被记录时的那个标题并警告它
	// 已经没了（见 trailFor）；预览仍能携带的是那个**行号**。
	private previewAsk(
		entry: NavEntry,
		path: string,
		file: boolean,
		line: number | undefined,
		lost: boolean,
	): { linktext: string; state?: { scroll: number } } {
		if (file) {
			if (!this.wantsLine(file))
				return { linktext: path };
			return {
				linktext: path,
				// 预览**在笔记的哪里**打开由这个面板说，而它是从这里请求的预览所能提供、别处
				// 请求的不能提供的那一件事：popover 打开在**那一行**上，而不是在笔记的开头。
				// `scroll` 是 app 对「一个 markdown 视图最顶端可见行」自己的叫法 —— 与位置
				// 数据库保存的是同一个数字 —— 所以这里没有臆造一个 state 形状。这个数字是
				// **今天**的，不是记录的那个。
				state: line === undefined ? undefined : { scroll: line },
			};
		}
		const heading = line === undefined || lost
			? undefined
			: this.subpathHeading(entry, path, line);
		if (heading !== undefined)
			return { linktext: `${path}#${heading}` };
		return {
			linktext: path,
			state: line === undefined ? undefined : { scroll: line },
		};
	}

	// 一行上方最深的标题，在它能被**信赖**会在 app 再次解析 `#heading` 之后命名同一个节时。
	// 两个守卫：app 取那个文本的**第一个**标题，所以一篇两次写着 "Notes" 的笔记会打开错的
	// 那一个；而一个携带 `#`、`^`、`|`、`[` 或 `]` 的标题会被读作链接语法。
	//
	// 无需守卫的是那个标题仍然存在 —— 链是从缓存读出的，而缓存就是笔记**此刻**的样子。
	// **确实**需要守卫的是它被读取时的那个**行号**：记录的数字在笔记于它上方被编辑之后命名
	// 的是另一个位置，所以标题在这里只在一条已经重新找到的行号上被读取。
	private subpathHeading(entry: NavEntry, path: string, line: number): string | undefined {
		if (entry.kind === 'view')
			return undefined;
		const headings = this.reads.headingsFor(path);
		const trail = headingTrailAtLine(headings, line);
		const deepest = trail[trail.length - 1];
		if (!deepest || UNTRAVELABLE.test(deepest))
			return undefined;
		if (headings && headings.filter(h => h.heading === deepest).length !== 1)
			return undefined;
		return deepest;
	}

	// **app 刚刚打开的那张卡片**，以及这个面板关于它唯一说的话。
	//
	// 从**对话框**请求的预览打开在那个对话框后面：core 把每个 popover 放在 document 的 body
	// 上、以 `--layer-popover`（30）绘制它，而一个模态容器坐在 `--layer-modal`（50）。卡片
	// 作答了，而它的每一行都被请求它的那个 shell 盖住。core 据以预览的表面，没有一个本身在
	// 一个对话框内，而**这个**面板的表面有一半在 —— 所以每张卡片是被抬到对话框图层**之上**
	// 而不是抬**到它上面**，因为共享同一个 z-index 的两个元素是按谁最后被追加来排序的，而
	// 那何时发生是 app 的事。
	private liftPreview(card: HTMLElement): void {
		card.addClass(PREVIEW_CLASS);
	}

	// 一行被右键点击：为它背后的文件升起 **app** 自己的菜单，上面放**我们**的条目。读者能拿
	// 一个文件做什么是 app 的事，而在这里再写一份那些命令的列表会是一份陈旧的副本。所加的是
	// app 无法知道的：这一行代表一个**地点**，所以这里的「在新标签页中打开」承诺的是这一行
	// 所代表的落点 —— 以及一个钉选，那是这份列表关于一篇笔记自己的答案、别人的都不是。
	//
	// 所请求的上下文是**链接**那一个，不是文件浏览器的：一行是指向一个文件的指针，而不是它
	// 在自己那棵树里的文件。一个**无路径视图**不被问及任何东西：没有文件可供 app 的菜单关于
	// 它，所以为它升起的菜单单是我们自己的。
	//
	// **触摸设备从另一扇门到这里**：一次长按武装该行，所以菜单从已武装行自己的控件升起。
	// 两扇门在同一处汇合，这就是为什么菜单按一个**点**摆放、而不是按事件。
	//
	// `note` 说出这是**哪一种**行 —— 笔记自己的，还是它内部的一个点。
	private contextRow(rep: number, at: MenuPositionDef, note: boolean): void {
		const entry = this.opts.places.entries[rep];
		if (!entry)
			return;
		// **一扇门、两端**，而这次轻点是哪一端，取决于是否已有一个菜单立着。**app 无法回答
		// 这次轻点**：控件停住了自己的按下，所以按下永远到不了 document，而 app 永远听不到
		// 那记本会关闭它菜单的移开点击。没有这个，这次轻点会在一次呼吸里把立着的菜单拿掉、
		// 又放回来。
		if (this.menu) {
			this.closeMenu();
			return;
		}
		const menu = new Menu();
		// 我们自己的条目排**最前**（'action'，app 会把它排在自己的各个 section 之前）：只有
		// 这份列表知道该行所代表的落点。
		menu.addItem(item => item
			.setSection('action')
			.setTitle(t(entry.kind === 'jump'
				? 'recentFiles.openHereInNewTab'
				: 'recentFiles.openInNewTab'))
			// app 对这个承诺自己的字形（`lucide-file-plus`，在它自己的每一个文件菜单上）：
			// 这个条目立在 app 的条目会立的地方，而对同一个承诺用第二个字形会读起来像另一个
			// 承诺。
			.setIcon('file-plus')
			.onClick(() => this.jump(rep, 'tab')));
		// ……以及钉选，它是关于**行**的、不是关于文件的：只有笔记自己的行才有可给的
		// （见 pinItems）。
		if (note)
			this.pinItems(menu, navGroupKey(entry));
		// ……而对一个视图，不再向 app 要求别的：读者能拿一个**文件**做什么是 app 的事，在这里
		// 那份的一个副本会是一份陈旧的，但一个视图根本不命名任何文件。
		if (entry.kind !== 'view') {
			const file = this.opts.app.vault.getAbstractFileByPath(entry.path);
			// 一个在重画与这次右键之间消失的文件 —— 一次同步把它移除了、一次删除刚刚落地
			// —— 不留下任何可问的东西。
			if (!(file instanceof TFile))
				return;
			this.opts.app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		}
		this.menu = menu;
		// ……而当 app 用它**自己的**某个手势把它拿掉时，那个控件回到「升起一个」而不是
		// 「收回一个」。
		menu.onHide(this.forgetMenu);
		menu.showAtPosition(at);
		this.hearPresses(true);
	}

	// **钉选条目**，在笔记自己的行上、别人谁的行上都没有：钉选是给**笔记**的书签，所以一个
	// 落点行 —— 笔记内部的一个点 —— 没有什么可钉。`key` 是该行的身份，与 × 交出的同一个
	// （见 navGroupKey）。
	//
	// 上移/下移只在**存在**一步时出现：在块的两端，一个什么都不会做的条目比一个不存在的
	// 条目更糟，而块的次序是这些唯一关于的次序。「一路到头」只在它**多于**一步时提供 ——
	// 紧挨着一个端点时它做的正好是它上面那个条目刚刚提供的。
	private pinItems(menu: Menu, key: string): void {
		const at = this.opts.places.pinned.indexOf(key);
		if (at < 0) {
			this.pinItem(menu, 'recentFiles.pin', 'pin', () => this.pin(key));
			return;
		}
		const last = this.opts.places.pinned.length - 1;
		this.pinItem(menu, 'recentFiles.unpin', 'pin-off', () => this.unpin(key));
		if (at > 0) {
			this.pinItem(menu, 'recentFiles.pinUp', 'arrow-up', () => this.movePin(key, -1));
			if (at > 1)
				this.pinItem(menu, 'recentFiles.pinFirst', 'arrow-up-to-line', () => this.movePin(key, -at));
		}
		if (at < last) {
			this.pinItem(menu, 'recentFiles.pinDown', 'arrow-down', () => this.movePin(key, 1));
			if (at < last - 1)
				this.pinItem(menu, 'recentFiles.pinLast', 'arrow-down-to-line', () => this.movePin(key, last - at));
		}
	}

	private pinItem(
		menu: Menu,
		title: Parameters<typeof t>[0],
		icon: string,
		run: () => void,
	): void {
		menu.addItem(item => item
			.setSection('action')
			.setTitle(t(title))
			.setIcon(icon)
			.onClick(run));
	}

	// 钉选是读者关于一篇笔记自己的答案，由 store 立刻写下（见 NavPlaces.pin）。**重画**在这里
	// 被要求、而不是留给各个 shell，理由同一次移除的：一个**对话框**不订阅 store，所以钉选
	// 否则会让那一行停在原处，直到对话框被重新打开。
	private pin(key: string): void {
		this.opts.places.pin(key);
		this.render();
	}

	private unpin(key: string): void {
		this.opts.places.unpin(key);
		this.render();
	}

	private movePin(key: string, delta: number): void {
		this.opts.places.movePinned(key, delta);
		this.render();
	}

	// 把一个立着的菜单从屏幕上拿掉。由升起它的控件、由让开读者道路的 shell、以及由 destroy
	// 要求 —— 菜单做的**别的**一切都是 app 的事，而这些都是关于这个面板而不是关于文件的部分。
	closeMenu(): void {
		this.hearPresses(false);
		const menu = this.menu;
		this.menu = undefined;
		menu?.close();
	}

	// app 自己关闭了它：它不再归我们关闭。
	private forgetMenu = (): void => {
		this.hearPresses(false);
		this.menu = undefined;
	};

	// 这个 body 升起的菜单是否立着 —— 若立着，则**收回**它。
	//
	// 在**按下**时问而不是在点击时问：到点击到达时，app 的菜单可能正立在升起它的那个控件
	// 上方。在给它的那个点下方没有空间时，app 会把菜单**按它自己的高度向上移**，那会把它
	// 放到该行上方 —— 而一次落在菜单自己表面上的按下，谁都到不了。
	takeMenuBack(): boolean {
		if (!this.menu)
			return false;
		this.closeMenu();
		return true;
	}

	// 在一个菜单立着期间，**任何地方**、只要不是它自己的某个条目的一次按下都会把它收回 ——
	// 包括落在菜单自己空白表面上的一次按下，而那 app 是完完全全用「没有」来作答的。
	//
	// **在捕获阶段、在 document 上听**，那是唯一一个能在菜单吞掉它之前听到它的地方：菜单被
	// 放在 document 的 body 上、而不是放进这个面板。一个瞄准那个控件的读者，常常正瞄准着
	// 那个菜单。
	private onAnyPress = (ev: Event): void => {
		if (!this.menu)
			return;
		const el = ev.target instanceof Element ? ev.target : null;
		// ……但不是在它某个**条目**上：那是菜单自己该给的答案。也不是在升起它的那个控件上，
		// 那个控件必须发现菜单仍立着。
		if (el?.closest('.menu-item, .nav-row-menu'))
			return;
		this.closeMenu();
	};

	private hearPresses(on: boolean): void {
		const doc = this.opts.host.ownerDocument;
		if (!doc)
			return;
		if (on)
			doc.addEventListener('pointerdown', this.onAnyPress, true);
		else
			doc.removeEventListener('pointerdown', this.onAnyPress, true);
	}

	// 读者从行上的 × 要求一行离开。**key 随 × 一同到达**，而不是在这里算出来：控件是由画出
	// 该行的那次重画构建的，所以它携带的是那一行的身份，而不是某个可能已在它下面移动过的
	// 索引。
	//
	// 重画在**这里**被要求、而不是留给各个 shell：一个**对话框**不订阅 store，所以一次移除
	// 否则会让那一行一直立着，直到对话框被重新打开。
	private forgetRow(key: string): void {
		this.opts.places.forget(key);
		this.render();
	}

	// **一个落点**被取下，从它自己那行上的 ×：笔记与它的其它位置留下。到达的是一组地点
	// **key**，而不是该行的索引 —— 一行代表一篇笔记的哪些地点，是关于该行**被画出来时**
	// 的问题。
	private forgetLanding(keys: string[]): void {
		this.opts.places.forgetLanding(keys);
		this.render();
	}

	// 运行 shell 自己对一次行走的反应，并让它所做的**任何事**都不拦住它后面的旅程：读者要求
	// 去某处，所以一个抛异常的 shell 让他们失去的必须是那个反应，而不是那次行走。
	private shellReacts(): void {
		try {
			this.opts.onJump?.();
		} catch (e) {
			console.error('Position Restore: the panel shell failed to react to a travel:', e);
		}
	}
}
