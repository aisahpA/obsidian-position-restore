import { App } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from '@/types';
import {
	isBlockKey, isCallerKey, landedLine, NavEntry, NavJump, NewNavEntry, navGroupKey,
} from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { normAnchor } from '@/position/capture/ephemeral';
import { frontmatterOfPath, frontmatterRuleMatches } from '@/shared/frontmatter';
import { loadNavPlaces, persistNavPlaces } from './places-store';

// 最近文件列表 —— 面板的（也仅是面板的）数据。
//
// 不是前进/后退栈（见 nav-history/stack.ts），两者是刻意分开的 store：栈是遍历装置
// —— 有序、绑定光标、且会**截断**，所以一次新的跳转就丢掉前进的那部分，而从中画出的
// 列表会在读者分叉的那一刻丢掉自己的一块。这是地点 store：无序、绝不因跳转而截断、
// 按地点去重。（一个地点仍可离开 —— 见 forget —— 但「去往某处」这件事本身不会移除
// 任何一个，也不会把任何一个补回来。）
//
// 里面有什么。两类地点：
//   - 每个路径一条文件记录（`kind: 'visit'`），自身不持有位置。面板打印的行号与普通
//     打开落到的位置都来自位置数据库，所以这里的一次点击表现得就像在文件浏览器里的一次
//     点击（包括它的排除规则）。在这里复制那份位置会让两条打开路径不一致。
//   - 每次跳转一条记录（`kind: 'jump'` —— 一次大纲点击、一个标题链接），携带它自己的
//     落点，那份落点在别处不存在。身份是标题 KEY，不是行号：一次编辑中移动过的标题仍是
//     同一个地点。且一个落点一条记录：两次碰巧停在同一行的跳转是一个地点，随落点落定而
//     合并（见 settle）。
//   - 目标的行说不出它的名字的，不记记录，而是记它所落进的那篇笔记：CALLER 目标（一次
//     搜索命中、一次反向链接命中 —— 见 nav/entry.ts 的 isCallerKey）不指出任何锚点、
//     它的 key 是一个时间戳；BLOCK 目标（isBlockKey）指出一个，但一行只能把它打印成
//     某节里的一行号，那不是读者能从列表里挑出来的东西。
// 无路径的视图（图谱、Thino 的 memo 列表）是一条记录，与面板中一样。
//
// 里面没有什么：跳变（采样器**推断**出的光标移动），以及 —— 在落点设置的最底一档 ——
// 跳转（见 LandingsMode）：两者都不是读者选择去往的地点。
//
// 次序即 MRU 次序：被碰到的地点移到末尾。面板把索引读作时钟（list.ts 的 activeRep），
// 所以原地更新会让一个被重新碰到的地点看起来比它实际的更旧。
//
// 谁喂数据给它。这里什么都不去够取任何东西：组合根把这个 store 订阅到记录漏斗（见
// nav/funnel.ts），它听到的导航与栈听到的相同 —— 两个列表从一次记录中留下不同的东西。

export interface PlaceList {
	// 最旧的在前。当作一个普通的 NavEntry 列表来读：浏览器里每个消费者都取那个形态，
	// 并不因这个 store 而改变。
	entries: NavEntry[];
	// 读者**此刻**所在的地点，或 -1。不持久化：「此处」是关于工作区的活事实，
	// 不是重启能恢复的东西。
	index: number;
	// 去往一个地点：FILE 记录以普通方式打开文件，JUMP 记录打开它并落到记录的位置
	// （见 NavPlaces.travel）。当读者要求的不是文件已在的那个 tab 时，`target` 决定
	// 在哪打开（见 PaneTarget）；缺省即普通打开。
	travel(index: number, target?: PaneTarget): Promise<void>;
	// 丢掉**一行**所代表的一切地点：一篇笔记自己的记录与它内部的每次跳转，
	// 或无路径视图持有的那一条记录。`key` 是行的身份（见 nav/entry.ts 的
	// navGroupKey），而这里说的刻意就是行：一篇笔记无论持有多少位置都是
	// 一行，读者也是从行上发问的。
	//
	// 是行的身份而不是路径，因为路径说不出一个无路径视图。
	//
	// 它不动的东西，正是这份列表能可编辑的原因：文件本身，以及位置记录 ——
	// 那是另一个 store、按路径作键。被再次访问的文件会拿回自己的地点，这是
	// 设计。一个永远不想看到某文件被列出的读者想要的是规则之一（见
	// recordable），那是策略而不是一次性的。
	forget(key: string): void;
	// 丢掉一篇笔记的**一个落点**：笔记自己那行**下面**那行所代表的地点，
	// 按身份（见下方 placeKey）而非按索引交出。一条规矩是一行一地点（见
	// settle），但面板只从它能看见的东西上绘制，而一次从未落定的跳转根本
	// 没有行 —— 所以调用方报出该行所代表的地点，而不是它被画出来所依据的
	// 那一个：落单的双胞胎会在重画完成前把那行放回来，那是一个什么都不做的 ×。
	//
	// 留下的是笔记自己的记录与它的其它地点。
	forgetLanding(keys: readonly string[]): void;
	// 一次把**整份列表**拿掉：一个读者从未在其中工作过的 vault 会持有的东西。
	// 它放过的是读者钉选过的行 —— 一个钉选是手写下的答案，而列表靠**自己**
	// 维持的每条规则本就放过它（见 pruneExcluded），清空不过是其中又多一条。
	//
	// 它不动的就是 forget 不动的：不动文件，也不动位置记录。被再次访问的笔记会
	// 拿回自己的地点 —— 连同它的位置，而那份位置从来就不是这份列表该留的。
	clear(): void;
	// 读者钉选过的行，按展示顺序 —— 最上的在前。是**行**身份（见 navGroupKey），
	// 从不是一个落点：钉选是给一篇笔记的书签，不是给它内部某个位置的。
	pinned: readonly string[];
	// 钉选一行、取下钉选，或在钉选块内按 `delta` 个位次移动（一步即菜单的
	// 上/下移；一次会越过末端的移动会让该行**停在**那个末端，这正是「移到最前」
	// 想要的）。`key` 是行的身份，与 forget 所取的是同一个东西，所以一个钉选
	// 比行内部的落点活得久，并随行一同离开。
	pin(key: string): void;
	unpin(key: string): void;
	movePinned(key: string, delta: number): void;
	// 一行是否被钉选 —— 由绘制两个块的面板来问。
	isPinned(key: string): boolean;
	// 一个坐标被笔记挪走了的落点，放回它所命名的锚点**此刻**所在之处（见
	// ReclaimedLine）。行号总是带着答案到达：这个 store 不读 vault，在这里
	// 猜出的数字会是一个没人能从行上已有的那个分辨出来的数。不是一次访问 ——
	// 地点保有自己的年龄，除了它的地址，关于它什么都没动。
	reland(lines: readonly ReclaimedLine[]): void;
	// 浏览器得为它重画的东西。
	subscribe(fn: () => void): () => void;
}

// 一个落点的坐标被放回它该在之处：「那个标题现在在哪」的答案，面板能给，而这个
// store 无法自己够取（行号活在 vault 里，这里没有任何东西持有它）。
export interface ReclaimedLine {
	// 那个地点，按它自己的身份（见 placeKey）：索引熬不过一次「在发问与写入之间
	// 有地点被忘掉」。
	key: string;
	// 落点的锚点**此刻**在笔记中的位置，0-based。
	line: number;
	// 答案所依据的、笔记的时钟，盖在记录上，只为它换来的一件事：面板不必在每次
	// 绘制时再去寻找行号（见 browser/now-line.ts 里最省的那条答案）。当文件自己的
	// 时钟是没人能读的那一个时缺省，此时记录什么也不说，而不是声称做过核对。
	mtime?: number;
}

// store 行走所需的东西。注入进来（并由拥有打开管线的 NavStack 实现）而不是自己去够
// 取，好让本模块保持为一个纯列表：它可以在没有工作区的情况下被构建与测试。
export interface PlaceOpeners {
	// 以文件浏览器的方式打开一个文件：激活持有它的 tab，或在那里打开它。不注入
	// 落点 —— 由位置数据库决定。带 `target` 时，文件在 app 为该 target 挑的 leaf
	// 里打开（一个新 tab、一个分屏、一个窗口），落点规则不变（见 stack.ts）。
	openFile(path: string, leafId: string, target?: PaneTarget): Promise<void>;
	// 打开一次跳转所在的文件，并落到该跳转记录的位置。
	openJump(entry: NavEntry, target?: PaneTarget): Promise<void>;
	// 展示一个无路径视图：在已经持有它的 leaf 里，或在它无处可寻时的一个新 tab 里。
	// 条目整份到达，所以一个不得不被建起的 tab 按读者离开时的地点来建（见
	// NavView.state）。
	openView(entry: NavEntry, target?: PaneTarget): Promise<void>;
}

// 空操作 opener：在无工作区下构建的 store 仍会记录地点、仍会应答面板；只是无法行走。
const NO_OPENERS: PlaceOpeners = {
	openFile: async () => undefined,
	openJump: async () => undefined,
	openView: async () => undefined,
};

export class NavPlaces implements PlaceList {
	entries: NavEntry[] = [];
	index = -1;
	// 读者钉选过的行，最上的在前，与地点本身一起持久化（见 places-store）：
	// 一个钉选与它所命名的行是一份列表的两半。
	//
	// 不是设置项。钉选是读者关于**这份**列表的答案，而列表属于做出它的那台机器 ——
	// 一个复制到另一台设备的 vault 要么把自己的地点与钉选都带过去，要么都不带
	// （见 #34 的愿望）。
	//
	// 钉选被刻意排除在上限（见 dropOldestRows）与规则（见 pruneExcluded）之外：
	// 两者都约束列表靠**自己**记住的东西，而被钉选的行是读者亲手命名的。
	pinned: string[] = [];

	private listeners = new Set<() => void>();
	private open: PlaceOpeners = NO_OPENERS;
	private lastPersisted = '';

	constructor(
		private app: App,
		// 那一个共享的设置对象：上限与这份列表自己的文件夹规则都是活读的，
		// 所以改动任一个都会在下一次写入时生效。
		private settings: PluginSettings,
	) {
		const blob = loadNavPlaces(app);
		this.entries = blob.entries;
		this.pinned = blob.pinned;
	}

	// 组合根在打开管线存在后把它交进来（见 position/manager.ts）。与构造分开，是因为
	// 两个对象彼此需要：漏斗喂这份列表，而这里的一次点击经由栈向外行走。
	attach(open: PlaceOpeners): void {
		this.open = open;
	}

	// ===== Configuration =====

	// 这份列表是否记录跳转 —— 除了落点设置的最底一档（见 LandingsMode），
	// 那一档下列表只有笔记与视图，别无其它。
	//
	// 它回答的是**记录**、且仅是记录，从不是留存：在上档记录下的一次跳转
	// 与任何其它地点一样，而降到 'none' 会让它留在原处 —— 它只是不再记录新的，
	// 而最终拿走旧的是修剪（见 dropOldestLandings）。这就是为什么没有哪一档
	// 是单向门。
	private recordsJumps(): boolean {
		return this.settings.recentFilesLandings !== 'none';
	}

	// 列表被保持到多少篇**笔记**：那个设置项，钳制过，以 DEFAULT_SETTINGS 作为
	// 一个根本不是数字的值的兜底（否则一个手改过的 data.json 会让每个
	// `length > cap` 比较都为假、彻底禁用上限 —— 与栈的 stackCap 同样的守卫）。
	// 它数的是笔记或视图所代表的那一行（见 rowCount），不是它内部的落点。
	cap(): number {
		const cap = Math.floor(this.settings.recentFilesCap);
		return Number.isFinite(cap) ? Math.max(1, cap) : DEFAULT_SETTINGS.recentFilesCap;
	}

	// 一个路径究竟能否被列出：这份列表**自己**的规则，不是别的功能的。读者的
	// 文件夹列表与属性列表回答的是「哪些访问值得列出」，且刻意不是位置记录的
	// excludedFolders 与 frontmatterExcludeProperties，后者回答的是另一个问题
	// （见 PluginSettings.recentFilesExcludeFolders / recentFilesExcludeProperties）。
	private recordable(path: string): boolean {
		if (!path)
			return false;
		// Vault 内部的路径从不被列出：配置文件夹（无论用户怎么命名它 —— 见
		// Vault#configDir）不是笔记，而 Obsidian 的废纸篓里装着记账员反正会丢掉的
		// 文件。
		const config = (this.app.vault as { configDir?: string }).configDir;
		if (config && (path === config || path.startsWith(`${config}/`)))
			return false;
		if (path.startsWith('.trash/'))
			return false;
		const folders = this.settings.recentFilesExcludeFolders ?? [];
		if (folders.some(folder => {
			const clean = folder.replace(/\/+$/, '');
			return !!clean && (path === clean || path.startsWith(`${clean}/`));
		}))
			return false;
		return !this.excludedByFrontmatter(path);
	}

	// `status` 把每个带该属性的文件都挡在外面、无论其值，`status: archived` 只挡值
	// 与它相等的文件 —— 这是本插件写下的唯一一种条目形式，与位置规则共用（见
	// shared/frontmatter.ts）。
	//
	// 最后才问，且仅在读者写过规则时问：它是这里唯一一个深入 vault 的测试，而在
	// 空列表下 —— 默认即是 —— 答案就是「否」，根本不去碰元数据缓存。
	//
	// 缓存尚未解析的文件**会被**列出：缓存是懒填的，而一个凭猜测扣下的地点是读者
	// 拿不回来的地点，而一个误列的地点是一个他们能丢掉的地点。
	private excludedByFrontmatter(path: string): boolean {
		const rules = this.settings.recentFilesExcludeProperties ?? [];
		if (rules.length === 0)
			return false;
		return frontmatterRuleMatches(frontmatterOfPath(this.app, path), rules);
	}

	// ===== Reading =====

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private changed(): void {
		for (const fn of this.listeners)
			fn();
	}

	// ===== Writing =====

	// 一个地点被访问了 —— 漏斗的 `onVisit`，对除跳变外的每次导航（见类注释）。
	// 在栈决定这一步是否值得留下**之前**调用：一个地点被重新坐进是关于**这份**列表的
	// 事实，栈的去重或它的设置不能把它藏起来。已在列表上的地点被移到末尾并重新盖章、
	// 绝不重复 —— 这正是让一个被打开十次的文件是一行的原因。
	remember(entry: NewNavEntry): void {
		if (entry.kind === 'teleport')
			return;
		// 问的是 KIND 而不是文件，且在列表自己的文件规则之前：那些回答的是一个文件
		// 能否被列出，与它内部的位置是否被记住是不同的问题。
		if (entry.kind === 'jump' && !this.recordsJumps())
			return;
		// 两个列表不为其保留任何地点的目标，但读者**确实**在他们落进的那篇笔记里：
		// 记为那篇笔记，这正是**在别的文件里**的一次命中已经得到的（一次跨文件的搜索
		// 命中不是同文件目标，所以它到这里时是一次普通访问）。
		//
		// CALLER 目标（一次搜索命中、一次反向链接命中 —— nav/entry.ts 的 isCallerKey）
		// 不指出任何锚点、它的 key 是一个时间戳；BLOCK 目标（isBlockKey）指出一个，
		// 但一行只能把它打印成某节里的一行号，读者无法把它与旁边那行区分开。两者都
		// 不是列表能命名的地点。
		if (entry.kind === 'jump' && (isCallerKey(entry.key) || isBlockKey(entry.key))) {
			this.remember({ kind: 'visit', path: entry.path, leafId: entry.leafId });
			return;
		}
		if (entry.kind !== 'view' && !this.recordable(entry.path))
			return;
		const key = placeKey(entry);
		const at = this.indexOf(key);
		const prev = at < 0 ? undefined : this.entries[at];
		const record = placeRecord(entry, prev);
		if (at >= 0)
			this.entries.splice(at, 1);
		this.entries.push(record);
		// 读者正站在他们刚去往的地点里，这份列表听到的每次导航都会设它 ——
		// 漏斗的 `here` 广播单凭一次遍历就能到达它。在修剪之前设，好让它的
		// 豁免（见 dropOldestRows / dropOldestLandings）保护的是这个地点，
		// 而不是一个陈旧的地点。
		this.index = this.entries.length - 1;
		this.trim();
		this.changed();
	}

	// 一个**已存在**地点的某个细节变得已知了 —— 漏斗的 `onLanded`。栈在跳转落定时
	// 填补它的落点（在上调 key 之后），并在读者离开一个**视图**时重读它自己的 state；
	// 行是读者点击的东西，所以回来的必须得是他们离开时的那个地点。
	settle(entry: NewNavEntry): void {
		if (entry.kind === 'view') {
			// 读者刚离开的那个视图，重读。它的 state 是关于一个视图的唯一
			// 无法事后推导的东西（见 NavView.state）；名字与图标一同前来，
			// 是因为一个在那次访问中给自己改过名的视图应当被列在读者刚读到
			// 的名字下。时间戳随它们一同移动。
			if (!entry.state)
				return;
			const at = this.indexOf(placeKey(entry));
			if (at < 0)
				return;
			const place = this.entries[at];
			if (place.kind !== 'view')
				return;
			place.state = entry.state;
			if (entry.label !== undefined)
				place.label = entry.label;
			if (entry.icon !== undefined)
				place.icon = entry.icon;
			place.t = Date.now();
			this.changed();
			return;
		}
		if (entry.kind !== 'jump' || !entry.st)
			return;
		const at = this.indexOf(placeKey(entry));
		if (at < 0)
			return;
		const place = this.entries[at];
		if (place.kind !== 'jump')
			return;
		// 栈在落点落定时把一个大纲 key 上调为标题的权威源形式
		// （"outline:T" -> "outline:## T"）。地点的 key 随之跟进，因为面板会把它
		// 读回来做结构性重锚；它的身份不变（placeKey 会归一化），这就是上面那次
		// 查找仍能找到它的原因。
		place.key = entry.key;
		if (typeof entry.keyLine === 'number')
			place.keyLine = entry.keyLine;
		// state 整份到达：这一行被搜索和引用所用的词是随落点本身一起读到的
		// （见 ephemeral.ts 的 readLandingState），所以这里没什么可取的。
		place.st = entry.st;
		place.t = Date.now();
		this.absorbSameLanding(place);
		this.changed();
	}

	// 读者身在哪个地点。栈的当前记录按身份映射到一个地点；一个推断出的步
	// （一次跳变）映射到它的**文件**，因为读者无论怎么到的那里，都在那个文件里。
	//
	// 「此处」是关于工作区的活事实，所以它不持久化、也不臆造：一个起动即空的列表
	// 会一直空着，直到读者去往某处，而这里不会把他们碰巧正在读的笔记放回他们自己的
	// 列表。
	markCurrent(entry?: NewNavEntry): void {
		const at = this.indexFor(entry);
		if (at === this.index)
			return;
		this.index = at;
		this.changed();
	}

	// ===== Pinning =====

	pin(key: string): void {
		if (!key || this.pinned.includes(key))
			return;
		// 最新的钉选排在最后：这个块是读者在填的一个书架，一个到达顶部的
		// 新钉选会把他们排列好的行推到它下面 —— 而这正是钉选不该对已经在那
		// 的钉选做的事。
		this.pinned.push(key);
		this.afterPinChange();
	}

	unpin(key: string): void {
		const at = this.pinned.indexOf(key);
		if (at < 0)
			return;
		this.pinned.splice(at, 1);
		this.afterPinChange();
	}

	// 按 `delta` 个位次上移（负）或下移（正），对于块不持有的行、或一次会让它留在
	// 原处的移动则什么也不做：读者在重新布置一个书架，不是在给一列排序。一次越过
	// 任一末端的移动会让它**停在**那个末端而不是被拒绝 —— 「移到最前」交过来的步数
	// 比块还长，而要调用方去数它们，就是让调用方对列表自己的形状做算术。
	movePinned(key: string, delta: number): void {
		const at = this.pinned.indexOf(key);
		if (at < 0)
			return;
		const to = Math.min(Math.max(at + delta, 0), this.pinned.length - 1);
		if (to === at)
			return;
		this.pinned.splice(at, 1);
		this.pinned.splice(to, 0, key);
		this.afterPinChange();
	}

	isPinned(key: string): boolean {
		return this.pinned.includes(key);
	}

	// 钉选**立刻**写下、不留给下一次 flush：钉选是稀有而刻意的举动，
	// 否则几秒后的一次退出就会把它收回 —— 那读起来就像一个故意遗忘的功能。
	private afterPinChange(): void {
		this.persist();
		this.changed();
	}

	// ===== Bookkeeping =====

	// 一次重命名会给那些命名了该文件的地点重新作键。身份由 `path` 重算，所以没有
	// 任何已存的 key 需要重写（跳转自己的 `key` 是一个标题/锚点）。
	renameFile(oldPath: string, newPath: string): void {
		let renamed = false;
		for (const entry of this.entries) {
			if (entry.kind === 'view' || entry.path !== oldPath)
				continue;
			entry.path = newPath;
			renamed = true;
		}
		// ……钉选也随之移动，因为钉选命名的是**行**，而一篇笔记的行是它的
		// 路径（见 navGroupKey）：这里改了名、那里却忘了改，会留下一个指向
		// 没人应答的名字的钉选。
		const at = this.pinned.indexOf(oldPath);
		if (at >= 0) {
			this.pinned[at] = newPath;
			renamed = true;
		}
		if (renamed)
			this.changed();
	}

	// 一次真正的 vault 删除会丢掉该文件的地点 —— 它的文件记录与它内部的每次跳转。
	// 否则面板为它们画的行会成为在受限列表里占着槽位的死名字。传下去的 key **就是**
	// 路径：一个文件的行身份是它的路径（见 navGroupKey）—— 行与路径相一致的唯一情形。
	deleteFile(path: string): void {
		this.dropPlaces(path);
	}

	// 读者要求一行离开：行自己的那个 ×（见 RecentFilesBrowser.onForget）。与一次
	// vault 删除是同一种移除、同一条规则，是第二个名字而不是复用了记账员的入口点，
	// 因为两者回答不同的问题：那一个是 **VAULT** 在说文件没了，这一个是读者在说他们
	// 不想看到它。
	forget(key: string): void {
		this.dropPlaces(key);
	}

	// 一篇笔记的一个落点，由读者取下（见 RecentFilesBrowser 的 forgetLanding ——
	// 落点自己那行上的 ×）。key 从面板传来，面板是唯一知道一行代表哪些地点的东西，
	// 而它们会与列表**自己**对地点的身份（见 placeKey）相匹配：一个对话框的快照可能
	// 比 store 慢一次点击。
	forgetLanding(keys: readonly string[]): void {
		const doomed = new Set(keys);
		if (doomed.size === 0)
			return;
		const before = this.entries.length;
		// ……而「你在这里」指针随过滤一同搭车，正像它在这里对每一次其它移除所做的那样
		// （见 keep）：一个正站在自己拿下的那个位置上的读者，是一个指针无处可站的读者，
		// 那是诚实的答案，而不是一个 bug。
		this.keep(this.entries.filter(e => !doomed.has(placeKey(e))));
		if (this.entries.length === before)
			return;
		this.changed();
	}

	// 一个被笔记挪走了坐标的落点，放回它的锚点现在所在之处（见 ReclaimedLine）。
	// 不是一次重读：**词**留下。它们是被有意取过一次的，再取一次不会让它们更真
	// —— 只会丢掉读者离开时带着的那些。移动的是一个地址，仅此而已。
	//
	// 什么都不广播：这些行号所属的行就是即将被绘制的行，且是由发问的那一个面板
	// 绘制的。立在它旁边的另一个 shell 下次绘制任何东西时都会画出同一个答案，
	// 而一个不在绘制的浏览器没有可告知的对象。它**确实**立刻写下，理由同 pin：
	// 一个地点活几个月，而一个它否则会在退出时丢掉的答案，是一个再也无法以
	// 完全相同的代价被重新问及的答案。
	reland(lines: readonly ReclaimedLine[]): void {
		let wrote = false;
		for (const r of lines) {
			const at = this.indexOf(r.key);
			if (at < 0)
				continue;
			const place = this.entries[at];
			if (place.kind !== 'jump')
				continue;
			if (place.keyLine === r.line && place.st?.mtime === r.mtime)
				continue;
			place.keyLine = r.line;
			place.st = r.mtime === undefined ? place.st : { ...place.st, mtime: r.mtime };
			wrote = true;
		}
		if (wrote)
			this.persist();
	}

	// 整份列表，一次拿掉（见 RecentFilesView.onPaneMenu）。活下来的是**钉选块**，
	// 别无其它。
	//
	// 一个被钉选的行保留它被绘制所依据的每条记录、落点包含在内：块绘制的是笔记、
	// 从不是它内部的某个位置，但该行仍会打开它所持有的最新那个，而那份诺言正是
	// 钉选的初衷。
	clear(): void {
		const pinned = new Set(this.pinned);
		const kept = this.entries.filter(e => pinned.has(navGroupKey(e)));
		if (kept.length === this.entries.length)
			return;
		this.keep(kept);
		// **立刻**写下，理由同钉选：这是一个稀有而刻意的举动，否则几秒后的一次
		// 退出就会把整份列表放回来 —— 那读起来就像一个故意遗忘的功能。
		this.persist();
		this.changed();
	}

	// 上面两个名字所共同代表的那一种移除，按**行**作键（见 navGroupKey）：该行被
	// 绘制所依据的每条记录一次全走。它取的是行而不是路径，因为一个视图没有路径
	// —— 一个按路径作键的过滤只能永远让每个视图都留下。
	private dropPlaces(key: string): void {
		const current = this.entries[this.index];
		const kept = this.entries.filter(e => navGroupKey(e) !== key);
		// 钉选随行一同离开 —— 一个没了的行（一个被删的文件，或读者从列表上
		// 拿下的一个）否则会留下一个什么也不展示、只能靠记得它才能找到的钉选。
		const at = this.pinned.indexOf(key);
		const unpinned = at >= 0;
		if (unpinned)
			this.pinned.splice(at, 1);
		if (kept.length === this.entries.length && !unpinned)
			return;
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
		this.changed();
	}

	// 列表的某条规则变了（设置标签页 —— 加了一个文件夹，或一个属性）：丢掉它现在
	// 排除的地点，好让一个读者再也无法被展示的地点不继续在受限列表里占着槽位。
	// @returns 丢掉了多少个地点。
	pruneExcluded(): number {
		const current = this.entries[this.index];
		const pinned = new Set(this.pinned);
		// 钉选比规则活得久。规则回答的是列表靠**自己**记住的东西 —— 一个
		// 读者说过不要记录的文件夹或属性 —— 而被钉选的行是他们亲手命名的，
		// 一条后来的规则不是关于那一行的后来的答案。
		const kept = this.entries.filter(e => e.kind === 'view'
			|| pinned.has(navGroupKey(e))
			|| this.recordable(e.path));
		const removed = this.entries.length - kept.length;
		if (removed === 0)
			return 0;
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
		this.changed();
		return removed;
	}

	// 列表仍然命名的每个文件路径（视图记录不命名任何路径）—— 启动清扫的输入
	// （见 PathBookkeeper.sweepMissingHistory）。
	knownPaths(): string[] {
		const seen = new Set<string>();
		for (const entry of this.entries)
			if (entry.kind !== 'view')
				seen.add(entry.path);
		return Array.from(seen);
	}

	// ===== Travel =====

	// 去往一个地点。**记录 KIND** 决定怎么去：
	//   - FILE 记录以普通方式打开文件，与文件浏览器做的完全一样。它不携带位置，
	//     所以什么都不注入：位置数据库恢复它恢复的东西（对一个被排除的文件则是
	//     什么都不恢复），这让指向同一个文件的两个入口点表现得一致。
	//   - JUMP 记录是一次显式导航，像前进/后退，所以它携带自己的落点并落到其上。
	//   - 视图记录由一个**展示**该视图的 leaf 来应答：它来自的那一个、任何其它一个，
	//     或在视图无处可寻时的一个新 tab（一个地点比它碰巧所在的那个 tab 活得久）。
	//     为它建起的 tab 带上读者在那里时视图所持有的 state 来建（见 NavView.state）
	//     —— 见 stack.ts 的 openViewPlace。
	// 当读者按住修饰键时，`target` 决定三者**在哪**打开（见 PaneTarget）。缺省 ——
	// 普通点击 —— 记录自己的 leaf 就是答案，这正是本插件的全部要点：一个地点把你带回
	// 它曾在之处，而那是 `getLeaf(false)` 表达不出的。
	async travel(index: number, target?: PaneTarget): Promise<void> {
		const entry = this.entries[index];
		if (!entry)
			return;
		if (entry.kind === 'jump') {
			await this.open.openJump(entry, target);
			return;
		}
		if (entry.kind === 'view') {
			await this.open.openView(entry, target);
			return;
		}
		await this.open.openFile(entry.path, entry.leafId, target);
	}

	// 上限变了（设置标签页）：**现在**就修剪，而不是等下次访问 —— 等待会在之后
	// 一次丢掉一大块，且无从解释。
	// @returns 丢弃了多少个地点。
	applyCap(): number {
		const removed = this.trim();
		if (removed > 0)
			this.changed();
		return removed;
	}

	// ===== Persistence =====

	// **本**实例写下的最后一份 blob（flush 去重 —— 见 persistNavPlaces）。是实例
	// 字段、不是模块状态：列表是按 vault 分的，而实例之间共享的去重会让一个实例
	// 跳过它欠下的一次写入。
	persist(): void {
		this.lastPersisted = persistNavPlaces(this.app, this.entries, this.pinned, this.lastPersisted);
	}

	// ===== Internals =====

	// 一个落点一条记录：一个落点刚变得已知的跳转会接管同文件里所有停在了**同一行**的
	// 更早跳转 —— 两个命名同一处位置的 key（一个标题，以及一个被编辑移到它那行的块
	// 引用）在读者看来是一个地点。
	//
	// 为什么在这里而不在 remember：跳转在它的落点落定之前就被记录，所以那一刻没有
	// 行号可比。
	//
	// 没有行号的跳转被放过：没有坐标，就不是一个关于它曾是哪个地点的主张。
	private absorbSameLanding(place: NavJump): void {
		const line = landedLine(place);
		if (line === undefined)
			return;
		this.keep(this.entries.filter(e => e === place
			|| e.kind !== 'jump'
			|| e.path !== place.path
			|| landedLine(e) !== line));
	}

	private indexOf(key: string): number {
		for (let i = 0; i < this.entries.length; i++)
			if (placeKey(this.entries[i]) === key)
				return i;
		return -1;
	}

	// 一条栈记录所站的地点索引，带「你在这里」标记所需的兜底：一个推断出的步站在它的
	// 文件上，而一个自己地点没了的跳转（被淘汰了，或从未被记录）也站在它的文件上。
	private indexFor(entry?: NewNavEntry): number {
		if (!entry)
			return -1;
		if (entry.kind !== 'teleport') {
			const at = this.indexOf(placeKey(entry));
			if (at >= 0)
				return at;
		}
		if (entry.kind === 'view')
			return -1;
		return this.indexOf(entry.path);
	}

	// 通过丢掉最旧的东西把列表保持在上限之内 —— 绝不丢读者所站的那一个，这样一行
	// 就不会被他们自己的访问所触发的修剪从他们脚下淘汰掉。这让上限保持精确，而不是
	// 让列表在读者坐在一个旧地点上时一直超着它跑。
	//
	// 两个上限、同一个数字：读者设的那个约束他们被**展示**的东西，而这一约束被**存储**
	// 的东西 —— 一个没被展示给他们的地点不能让他们失去一个正被展示的地点（见
	// PluginSettings.recentFilesCap）。
	//   - 先**行**。一行整份走 —— 笔记自己的记录与它内部的每个落点，如同 forget 取
	//     它们的方式 —— 所以一次跳转永远无法把一个文件挤出列表。
	//   - 再**落点**，在整份列表上计而不是按笔记计，因为一次跳转是这里最重的记录
	//     （它携带当时在屏幕上与它一起的行号，见 NavEntryState.context），而上限
	//     不数它。它丢最旧的落点，绝不丢它们所站的那一行。
	// @returns 丢掉了多少个。
	private trim(): number {
		const before = this.entries.length;
		this.dropOldestRows();
		this.dropOldestLandings();
		return before - this.entries.length;
	}

	// 丢整行，直到列表落回上限之内。在**每种**模式下，一行都是一篇笔记（或一个视图）
	// —— 上限数的是笔记，所以模式只改变一行画出来要占多少行。行按它们**最新**的地点
	// 排序：与面板读的同一个时钟，索引即时间（见 list.ts）。
	private dropOldestRows(): void {
		const pinned = new Set(this.pinned);
		const newest = new Map<string, number>();
		for (let i = 0; i < this.entries.length; i++)
			newest.set(navGroupKey(this.entries[i]), i);
		// 上限数的是读者**未**命名的行：钉选是加在那个数字**之上**、而不是从
		// 里面扣的，所以钉选一篇笔记不会悄悄让他们失去他们设的那五十个之一。
		let counted = 0;
		for (const key of newest.keys())
			if (!pinned.has(key))
				counted++;
		const over = counted - this.cap();
		if (over <= 0)
			return;
		const oldestFirst = Array.from(newest.entries())
			.sort((a, b) => a[1] - b[1])
			.map(([key]) => key);
		const currentKey = this.index >= 0 ? navGroupKey(this.entries[this.index]) : undefined;
		const doomed = new Set<string>();
		for (const key of oldestFirst) {
			if (doomed.size >= over)
				break;
			if (key === currentKey)
				continue;
			// 钉选不会过期淘汰。上限约束的是列表靠自己所记住的东西，
			// 而一次读者没要求的淘汰，正是钉选存在的意义所在。
			if (pinned.has(key))
				continue;
			doomed.add(key);
		}
		this.keep(this.entries.filter(e => !doomed.has(navGroupKey(e))));
	}

	// 列表画出多少行，这正是上限所数的：一篇笔记无论持有多少落点都是一行。三种模式
	// 下都一样 —— 一个让上限也数落点的模式会让读者的那个数字同时意味着两件事（见
	// PluginSettings.recentFilesCap）。
	rowCount(): number {
		const seen = new Set<string>();
		for (const entry of this.entries)
			seen.add(navGroupKey(entry));
		return seen.size;
	}

	// 落点自己的上限：同一个数字，在列表里每次跳转上一次计，而不是按笔记计。是一个
	// 共享的池而非各自一份预算，因为它约束的是列表**存储**的东西：它把池花在其上的
	// 那些跳转，是读者实际做出的跳转，所以一篇他们在里面跳来跳去的笔记保留它挣到的
	// 那么多，而一篇他们只是读过的笔记一个都不保留。
	private dropOldestLandings(): void {
		let held = 0;
		for (const entry of this.entries)
			if (entry.kind === 'jump')
				held++;
		const over = held - this.cap();
		if (over <= 0)
			return;
		const pinned = new Set(this.pinned);
		const kept: NavEntry[] = [];
		let dropped = 0;
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			// 被钉选的行，它的落点是它自己的：块绘制的是笔记，而这里的池
			// 约束的是列表靠自己存储的东西。
			if (entry.kind === 'jump' && dropped < over && i !== this.index
				&& !pinned.has(navGroupKey(entry))) {
				dropped++;
				continue;
			}
			kept.push(entry);
		}
		this.keep(kept);
	}

	// 把一个过滤后的数组放进列表的位置，当那个地点在过滤中存活下来时，
	// 让「你在这里」指针停在同一地点上。
	private keep(kept: NavEntry[]): void {
		if (kept.length === this.entries.length)
			return;
		const current = this.entries[this.index];
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
	}
}

// 一条记录在列表上的身份。不存储：它由记录重算（见 places-store 的加载器），所以
// 规则变化不会留下陈旧的 key。
//
//   - 一个 FILE 就是它的路径。每个文件一条记录，无论它在哪个 tab 里被读过：按 tab
//     的分裂是位置数据库的事，而面板每篇笔记画一行。
//   - 一个 JUMP 是它的标题/锚点 KEY，归一化过。key 才是在一次移动标题的编辑中存活
//     下来的东西（见 nav-history/stack.ts 的 upgradeKeyLine 与 resolveAnchorShift），
//     而归一化让渲染形式（"outline:T"）与权威源形式（"outline:## T"）成为**一个**
//     地点而不是两个 —— 与栈自己的去重所用的同一种归一化。
//   - 一个 VIEW 是它的视图类型，如同面板的分组。
// 按 NewNavEntry 定型：一条已存记录与一次从漏斗听到的记录都对它作答（记录是一次
// 录制加上了时间戳）。
export function placeKey(entry: NewNavEntry): string {
	switch (entry.kind) {
		case 'view':
			return `view:${entry.viewType}`;
		case 'jump':
			return `${entry.path}#${normalizeJumpKey(entry.key)}`;
		case 'teleport':
			return `${entry.path}#teleport:${entry.line}`;
		case 'visit':
			return entry.path;
	}
}

// 大纲 key 保留它的前缀（这样标题与同名的锚点就不是一个地点），并丢掉它两种形式
// 相差的那些井号；其它一切照写下的原样。
function normalizeJumpKey(key: string): string {
	const prefix = 'outline:';
	return key.startsWith(prefix)
		? `${prefix}${normAnchor(key.slice(prefix.length))}`
		: normAnchor(key);
}

// FILE 地点不保留位置（见类注释）—— 一篇笔记的地点就是那篇笔记。
function placeRecord(entry: NewNavEntry, prev?: NavEntry): NavEntry {
	const t = Date.now();
	switch (entry.kind) {
		case 'visit':
			return { kind: 'visit', path: entry.path, leafId: entry.leafId, t };
		case 'jump': {
			const kept = prev?.kind === 'jump' ? prev : undefined;
			return {
				kind: 'jump', path: entry.path, leafId: entry.leafId, key: entry.key, t,
				keyLine: entry.keyLine ?? kept?.keyLine,
				// 对标题的一次重复点击尚不携带落点（它随落定到达）：已记录的
				// 那一个在此之前一直立着，所以该行永远不会失去它所承诺的位置。
				st: entry.st ?? kept?.st,
			};
		}
		case 'view': {
			// 标签与图标被每次访问刷新：一个给自己改过名的视图按它**此刻**说的话
			// 来命名与标记。一次空手而归的读取干脆丢掉它们，行回落到这份列表自己
			// 的措辞。
			//
			// state 是例外，且是刻意的：一次 state 读取空手而归的访问（视图抛了
			// 异常、答了空，或超过了上限 —— 见 shared/leaf.ts 的 viewState）**保留**
			// 已记录的快照而不是抹掉它。一次失败的读取不该让读者失去他们离开时的
			// 地点。
			const kept = prev?.kind === 'view' ? prev : undefined;
			return {
				kind: 'view', leafId: entry.leafId, viewType: entry.viewType, t,
				label: entry.label, icon: entry.icon,
				state: entry.state ?? kept?.state,
			};
		}
		default:
			// 不可达：remember() 拒绝跳变。定为 visit 类型，好让未来某个变体在这里
			// 失败于类型检查，而不是悄无声息。
			return { kind: 'visit', path: entry.path, leafId: entry.leafId, t };
	}
}
