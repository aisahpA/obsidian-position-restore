// 最近文件浏览器的 **BODY**：关于这个面板、且不属于 shell 的一切。两个 shell 立在它周围
// —— 模态框与常驻侧边栏面板 —— 而它们共享的一切住在这里：工具栏、列表、键盘、行走。
// 一个 shell 只拥有它自己的生命周期、别无其它，这就是为什么行走是一个回调：
// 读者去往某处时模态框关闭，而侧边栏留下。
//
// **除了两件事之外是只读的**，而这正是常驻面板得以可能的原因：body 画出地点在
// render() 被调用那一刻所持有的东西，而它唯一能说回去的，是一行**可以**被要求的两件事
// —— 去那里，以及走开。

import { App, EventRef, Menu, MenuPositionDef, TAbstractFile, TFile, setIcon, Keymap } from 'obsidian';
import { navGroupKey } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { PlaceList } from '@/recent-files/places';
import { EphemeralState, PathDisplayMode, PreviewFocusMode } from '@/types';
import { t } from '@/i18n';
import { RecentFilesReads } from './reads';
import { HeadingHit, RecentFilesList, RecentFilesListOptions } from './list';
import { ArrowBar, type RecentFilesBrowserArrows } from './arrows';
import { RowPreview } from './row-preview';
import { LATE_READ_REDRAW_MS, TIME_REFRESH_MS } from './constants';

// 列表元素 id 用的每体序号。
let browserSeq = 0;

// 浏览器**据以绘制的**偏好，由持久化它们的插件交给每个 shell。全部都是**读取器**而不是值：
// 常驻面板在 render 期间的一次调用里画出它的列表，所以别处做出的一次改动会被下一次重画拾取，
// 而不是被冻结进碰巧打开着的那一个面板里。
export interface RecentFilesBrowserPrefs {
	// 搜索框是否把各篇笔记的小节标题也算进搜索面 —— 也就是是否在大纲命中时画大纲行
	// （见 list.ts 的 headingRow）。
	outlineSearch: () => boolean;
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

export interface RecentFilesBrowserOptions {
	app: App;
	// 行的绘制所依据的**地点** —— 最近文件列表，绝不是前进/后退栈：一个在新跳转上会截断的
	// 栈回答不出「我去过哪些文件」。
	places: PlaceList;
	// body 把自己构建进去的那个元素。它的大小是 shell 的事。
	host: HTMLElement;
	// 文件保存的记录：一行（以及它的预览）说到「会落在哪里」时所用的位置 —— 一份记录
	// 自身不携带任何位置，所以它说的正是普通打开所恢复的那个。
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
	// 列表**脚下**的那四个箭头（见 arrows.ts）：在列表之后建、每次绘制问、随本体一起走。
	private arrowBar!: ArrowBar;
	// 一行的**预览**（见 row-preview.ts）：app 的 popover 是它去要的，而它守候的那个答案
	// 属于它自己。
	private preview!: RowPreview;
	// 面板所做的每次 vault 查找，都被缓存 —— 全都是元数据缓存查找：一个条目的展示碎片、
	// 以及一个文件已解析的标题。
	private reads: RecentFilesReads;
	// 每体唯一：行的选项 id 由它构建，而过滤框的 aria-activedescendant 指向其中一个，
	// 所以侧边栏面板与模态框同时存在也不会撞车。
	private readonly listId = `position-restore-nav-list-${++browserSeq}`;
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
			outlineSearch: () => this.opts.prefs.outlineSearch(),
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
				return entry ? navGroupKey(entry) : undefined;
			},
			entries: this.opts.places.entries,
			currentIndex: this.opts.places.index,
			filter: () => this.filter,
			describe: rep => this.reads.describe(rep),
			clearDescribeCache: () => this.reads.clearDescribeCache(),
			// 一个地点究竟能否被列出：列表打不开的名字不是一行。store 会自己修剪这样一个
			// 地点；这里只是列表在认同。
			noteExists: path => this.reads.hasFile(path),
			// 这一篇的**各个**标题，搜索面与大纲行都用它们。
			// 现查、不存：metadataCache 没答时经 cachedRead 兜底（见 reads.ts），
			// 所以它永远是最新的，而体积与笔记长度无关。
			headingsFor: path => this.reads.headingsFor(path),
			// 文件的其它名字：可搜索，且除 tooltip 外哪都不打印。
			otherNames: (path, printed) => this.reads.otherNamesFor(path, printed),
			onActiveRow: id => this.setActiveRow(id),
			onTravel: (rep, target) => this.jump(rep, target),
			// 一次按标题词的搜索命中的那一节：去那里（见 list.ts 的 HeadingHit）。那一节
			// 此刻还没有记录，这次行走会为它造出一条 —— 与点大纲面板的标题同类的一步。
			onTravelHeading: (hit, target) => this.jumpToHeading(hit, target),
			// 该行命名的是**哪个文件**，该行是笔记本身还是它内部的一个点，以及（对一个大纲行）
			// 它去往的那一节 —— 交给 app 自己的预览用。这里没有任何东西为它行走。
			onHoverRow: (rep, ev, el, file, hit) => this.preview.hoverRow(rep, ev, el, file, hit),
			tipsQuiet: () => this.preview.quiet(),
			onHoverEnd: () => this.preview.hoverEnded(),
			// 一记右键问 **app** 它能拿这个文件做什么；菜单在这里构建，是因为列表不持有 app。
			onContextRow: (rep, ev, note, hit) => this.contextRow(rep, ev, note, hit),
			takeMenuBack: () => this.takeMenuBack(),
			// 一行自己的 ×：列表所要求、却无法自己做出的移除，因为地点在这里、不在那里。
			onForget: key => this.forgetRow(key),
			// 一根停在一行上的手指，只在没有悬停可用来武装该行时才被听到。
			touch: this.opts.touch,
		};
		this.list = new RecentFilesList(this.listOpts);
		// 预览的两端，一次绑好：**谁**去守候 app 的答案（每次 hoverRow 都交出的那个
		// parent），以及它到来时做什么 —— 给这张卡片在面板 shell 之上所需的空间，并把行上的
		// 提示从一篇已作答的页面上拿开（见 row-preview.ts）。
		this.preview = new RowPreview(
			this.opts.app,
			this.reads,
			// **活读**：常驻面板下面的地点列表会动，而列表按索引解析它的条目。
			() => this.opts.places.entries,
			() => this.opts.prefs.previewFocus(),
			() => this.list.hideTip(),
		);
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
		this.arrowBar = new ArrowBar(
			this.opts.host,
			this.opts.arrows,
			// 按下之前 shell 自己的反应 —— 让开路（见 shellReacts）。
			() => this.shellReacts(),
		);
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
		// 一行据以被描述的东西，在发问之前丢掉：它描述的是那篇笔记**现在**的样子
		// （它的名字、它保存的位置），而不是它上次被打开时的样子。每个 shell 只留一帧，
		// 所以下一次重画必须重新问一遍。
		this.reads.clearDescribeCache();
		// 地点**此刻**的样子，在有任何东西读它们之前：列表按索引解析它的条目，所以一个在
		// 常驻面板下面移动了的列表，只靠重新指向这两个字段、别无其它就被拾取。describe 缓存
		// 也按索引作键，随它们一同走。
		this.listOpts.entries = this.opts.places.entries;
		this.listOpts.currentIndex = this.opts.places.index;
		this.list.render();
		// ……以及那些箭头，它们的四个答案不是这个 body 该留的：在**任何地方**做出的一步
		// —— 哪怕是从这些按钮本身 —— 都会改变它们每一个是否能被按下，而那两端之下的是
		// 一篇这个面板不持有的笔记。
		this.arrowBar.refresh();
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
		// 该做的事（见 row-preview.ts）。
		this.preview.stop();
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
		// ……以及一次按下可能仍欠箭头的发问（见 arrows.ts 的 press）：它是为那些随持有
		// 它们的 shell 一起离开屏幕的按钮作答的。
		this.arrowBar.forget();
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

	// 一次行走之前的那一套，两种行走共用：先在 shell 保持立着的地方处理读者的位置
	// （去往一个地点会重排列表，而一次跳转会重新压入栈，所以一个留在原处的位置会命名
	// 滑进那个槽位的那个东西），然后是 shell 自己的反应，好让对话框在它所触发的打开
	// 之前让开路。
	private depart(run: () => Promise<void>): void {
		if (this.opts.collapseOnJump)
			this.list.collapse();
		this.shellReacts();
		void run().catch(e => console.error('Position Restore: recent-files travel failed:', e));
	}

	private jump(i: number, target?: PaneTarget): void {
		this.depart(() => this.opts.places.travel(i, target));
	}

	// **大纲行**上的一次前往：这一行所印的那一节（见 HeadingHit）。它不是一条记录 ——
	// 这一节是读者搜到的 —— 所以这次前往为它造出一条、交给打开管线（与点大纲面板的标题
	// 同类的一步）。
	private jumpToHeading(hit: HeadingHit, target?: PaneTarget): void {
		this.depart(() => this.opts.places.travelToHeading(
			hit.path, hit.heading, hit.line, hit.leafId, target,
		));
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
	// `note` 说出这是**哪一种**行 —— 一篇笔记，还是它内部搜到的一个节（见 HeadingHit）。
	// 一个大纲行没有钉选可给：钉选是给一篇笔记的书签，而那一节不是一条记录。
	// 但它**有**「在新标签页打开」：菜单那一项答应的是「打开这一行所去的地方」，而对一个
	// 大纲行来说那个地方就是那一节 —— 一个写着「在这里打开」却把读者送到别处的菜单，
	// 比没有这一项更糟。
	private contextRow(rep: number, at: MenuPositionDef, note: boolean, hit?: HeadingHit): void {
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
			// 一个大纲行也说「在这里打开」：它去的是一个**地方**，而不只是一个文件。
			.setTitle(t(hit
				? 'recentFiles.openHereInNewTab'
				: 'recentFiles.openInNewTab'))
			// app 对这个承诺自己的字形（`lucide-file-plus`，在它自己的每一个文件菜单上）：
			// 这个条目立在 app 的条目会立的地方，而对同一个承诺用第二个字形会读起来像另一个
			// 承诺。
			.setIcon('file-plus')
			.onClick(() => (hit ? this.jumpToHeading(hit, 'tab') : this.jump(rep, 'tab'))));
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

	// **钉选条目**，在笔记自己的行上、别人谁的行上都没有：钉选是给**一篇笔记**的书签，
	// 所以一个大纲行 —— 一个读者**搜到**的小节，而不是去过的一个地方 —— 没有什么可钉。
	// `key` 是该行的身份，与 × 交出的同一个（见 navGroupKey）。
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
