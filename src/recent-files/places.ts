import { App, MarkdownView, Workspace } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from '@/types';
import { NavEntry, NavJump, NewNavEntry, navGroupKey } from '@/nav/entry';
import { PaneTarget } from '@/nav/pane';
import { caretAtLine } from '@/position/capture/ephemeral';
import { frontmatterOfPath, frontmatterRuleMatches } from '@/shared/frontmatter';
import { jumpTopBiasLines } from '@/shared/jump-landing';
import { loadNavPlaces, persistNavPlaces } from './places-store';

// 最近文件列表 —— 面板的（也仅是面板的）数据。
//
// 不是前进/后退栈（见 nav-history/stack.ts），两者是刻意分开的 store：栈是遍历装置
// —— 有序、绑定光标、且会**截断**，所以一次新的跳转就丢掉前进的那部分，而从中画出的
// 列表会在读者分叉的那一刻丢掉自己的一块。这是地点 store：无序、绝不因跳转而截断、
// 按地点去重。（一个地点仍可离开 —— 见 forget —— 但「去往某处」这件事本身不会移除
// 任何一个，也不会把任何一个补回来。）
//
// **列表只装笔记，不装位置。** 一次跳转（一次大纲点击、一个标题链接、一次搜索命中）
// 在这里被**降级**成一次访问：记的是「读者在这篇笔记里」，而不是「读者到了这一节」。
// 于是：
//   - 一条记录 = 一行，身份就是它的路径（一个无路径视图是它的视图类型）——
//     `navGroupKey` 是这份列表**唯一**的身份，没有第二套。
//   - 不存位置：一行的点击以**普通**方式打开文件，落在哪儿由位置数据库决定，与在文件
//     浏览器里点它完全一样（包括它的排除规则）。在这里复制那份位置会让两条打开路径
//     不一致。
//   - 上限就是行数，没有第二个池。
// 想要「回到某一节」的读者有两条路：前进/后退栈（它照记 jump，且带着落点），以及这个
// 面板的搜索框 —— 输一个标题词会把那一节作为一行画出来（见 browser/list.ts 的大纲行）。
//
// 里面没有什么：跳变（采样器**推断**出的光标移动）。
//
// 次序即 MRU 次序：被碰到的行移到末尾。面板把索引读作时钟，所以原地更新会让一个被
// 重新碰到的行看起来比它实际的更旧。
//
// 谁喂数据给它。这里什么都不去够取任何东西：组合根把这个 store 订阅到记录漏斗（见
// nav/funnel.ts），它听到的导航与栈听到的相同 —— 两个列表从一次记录中留下不同的东西。

export interface PlaceList {
	// 最旧的在前。当作一个普通的 NavEntry 列表来读：浏览器里每个消费者都取那个形态，
	// 并不因这个 store 而改变。**每条都是一行**：这里是 visit 与 view，别无其它。
	entries: NavEntry[];
	// 读者**此刻**所在的那一行，或 -1。不持久化：「此处」是关于工作区的活事实，
	// 不是重启能恢复的东西。
	index: number;
	// 去往一行所代表的那篇笔记：以普通方式打开它，落点由位置数据库决定。当读者要求的
	// 不是该文件已在的那个 tab 时，`target` 决定在哪打开（见 PaneTarget）；缺省即普通打开。
	travel(index: number, target?: PaneTarget): Promise<void>;
	// 去往一篇笔记里的**某个小节**：那一节不是一条记录 —— 它是读者搜到的（见 list.ts 的
	// HeadingHit），所以这次行走按大纲跳转的形状为它造出一条、交给打开管线。它落地之后，
	// 漏斗把这一步当作「读者在这篇笔记里」送回来（见 remember 的降级），于是这一节本身
	// 不进这份列表 —— 进的是那篇笔记。
	travelToHeading(
		path: string,
		heading: string,
		line: number,
		leafId: string,
		target?: PaneTarget,
	): Promise<void>;
	// 丢掉**一行**。key 是行的身份（见 nav/entry.ts 的 navGroupKey），而这里说的刻意就是
	// 行：一篇笔记无论被怎样打开过都是一行，读者也是从行上发问的。
	//
	// 它不动的东西，正是这份列表能可编辑的原因：文件本身，以及位置记录 ——
	// 那是另一个 store、按路径作键。被再次访问的文件会拿回自己的行，这是
	// 设计。一个永远不想看到某文件被列出的读者想要的是规则之一（见
	// recordable），那是策略而不是一次性的。
	forget(key: string): void;
	// 一次把**整份列表**拿掉：一个读者从未在其中工作过的 vault 会持有的东西。
	// 它放过的是读者钉选过的行 —— 一个钉选是手写下的答案。
	//
	// 它不动的就是 forget 不动的：不动文件，也不动位置记录。
	clear(): void;
	// 读者钉选过的行，按展示顺序 —— 最上的在前。是**行**身份（见 navGroupKey）：
	// 钉选是给一篇笔记的书签，而一篇笔记就是一行。
	pinned: readonly string[];
	// 钉选一行、取下钉选，或在钉选块内按 `delta` 个位次移动（一步即菜单的
	// 上/下移；一次会越过末端的移动会让该行**停在**那个末端，这正是「移到最前」
	// 想要的）。`key` 是行的身份，与 forget 所取的是同一个东西。
	pin(key: string): void;
	unpin(key: string): void;
	movePinned(key: string, delta: number): void;
	// 一行是否被钉选 —— 由绘制两个块的面板来问。
	isPinned(key: string): boolean;
	// 浏览器得为它重画的东西。
	subscribe(fn: () => void): () => void;
}

// store 行走所需的东西。注入进来（并由拥有打开管线的 NavStack 实现）而不是自己去够
// 取，好让本模块保持为一个纯列表：它可以在没有工作区的情况下被构建与测试。
export interface PlaceOpeners {
	// 以文件浏览器的方式打开一个文件：激活持有它的 tab，或在那里打开它。不注入
	// 落点 —— 由位置数据库决定。带 `target` 时，文件在 app 为该 target 挑的 leaf
	// 里打开（一个新 tab、一个分屏、一个窗口），落点规则不变（见 stack.ts）。
	openFile(path: string, leafId: string, target?: PaneTarget): Promise<void>;
	// 打开一次跳转所在的文件，并落到该跳转记录的位置。只有**去某个小节**的那一次
	// 行走用它（见 travelToHeading）：这份列表自己从不持有跳转记录。
	openJump(entry: NavEntry, target?: PaneTarget): Promise<void>;
	// 展示一个无路径视图：在已经持有它的 leaf 里，或在它无处可寻时的一个新 tab 里。
	// 条目整份到达，所以一个不得不被建起的 tab 按读者离开时的地点来建（见
	// NavView.state）。
	openView(entry: NavEntry, target?: PaneTarget): Promise<void>;
}

// 空操作 opener：在无工作区下构建的 store 仍会记录、仍会应答面板；只是无法行走。
const NO_OPENERS: PlaceOpeners = {
	openFile: async () => undefined,
	openJump: async () => undefined,
	openView: async () => undefined,
};

// 这个视图此刻**在布局里**吗（量得出宽高）。滚在后台标签页里的视图矩形全是 0 ——
// 从它身上量任何几何都会得到「零」，那不是一个小数字，是「没有答案」（见 alignView）。
// 量它是为了挑一个能回答的视图，所以这里只问容器自己的矩形，不碰任何内容。
function isMeasurable(view: MarkdownView): boolean {
	const rect = view.containerEl.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

// 退路用的图片后缀表：只在 app 的注册表问不到的时候上场（见 isImagePath）。它是会烂的
// —— 一个新格式进来就得有人回来补它 —— 所以它只装读者**现在**会碰到的那些，且从来
// 不是主判据。
const IMAGE_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'jfif', 'ico', 'tif', 'tiff',
	'heic', 'heif',
]);

// 这个路径是不是一张**图片**。主判据先问 app 自己：它知道每个后缀该由哪个视图打开
// （`viewRegistry.getTypeByExtension`，公开类型里没有它 —— 同 shared/leaf.ts 的
// viewTypeIsMissing 那套读法），于是新格式随 app 走，不需要有人回来补表。
//
// 只有**明确**答出 `'image'` 才算是图片：未知后缀（注册表答不出）与读不到注册表时
// 一律落在「不是图片」上，读不到方法时才退回上面那张表。这条门唯一能做的事是排除，
// 所以它失灵的方向必须是「照旧收录」—— 与 viewTypeIsMissing 同一个道理。
function isImagePath(app: App, path: string): boolean {
	const dot = path.lastIndexOf('.');
	// 点号落在最后一个 `/` 之前，那是文件夹名字里的点，不是后缀。
	if (dot < 0 || dot < path.lastIndexOf('/'))
		return false;
	const ext = path.slice(dot + 1).toLowerCase();
	if (!ext)
		return false;
	const registry = (app as unknown as {
		viewRegistry?: { getTypeByExtension?: (ext: string) => string | undefined };
	}).viewRegistry;
	if (typeof registry?.getTypeByExtension === 'function') {
		try {
			return registry.getTypeByExtension(ext) === 'image';
		} catch {
			// 掉到下面那张表去：问不出答案也比什么都不问好。
		}
	}
	return IMAGE_EXTENSIONS.has(ext);
}

export class NavPlaces implements PlaceList {
	entries: NavEntry[] = [];
	index = -1;
	// 读者钉选过的行，最上的在前，与地点本身一起持久化（见 places-store）：
	// 一个钉选与它所命名的行是一份列表的两半。
	//
	// 不是设置项。钉选是读者关于**这份**列表的答案，而列表属于做出它的那台机器 ——
	// 一个复制到另一台设备的 vault 要么把自己的行与钉选都带过去，要么都不带。
	//
	// 钉选被刻意排除在**上限**（见 trim）与**规则**（见 pruneExcluded）之外：
	// 两者约束的都是列表靠**自己**记住的东西，而被钉选的行是读者亲手命名的。
	// 代价是规则也管不着它，于是只有读者自己 unpin 才能把它从列表上拿走（见 unpin）。
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

	// 列表被保持到多少篇**笔记**：那个设置项，钳制过，以 DEFAULT_SETTINGS 作为
	// 一个根本不是数字的值的兜底（否则一个手改过的 data.json 会让每个
	// `length > cap` 比较都为假、彻底禁用上限 —— 与栈的 stackCap 同样的守卫）。
	// 它就是**行数**：一行就是一篇笔记（或一个视图），没有别的东西在跟它们争名额。
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
		// 图片。它是这里唯一一个要问「这个文件是什么」的测试 —— 上面几条问的都是
		// 它在哪儿 —— 而它由那个开关把着，关着时这一句一次也不跑。
		if (this.settings.recentFilesExcludeImages && isImagePath(this.app, path))
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
	// 缓存尚未解析的文件**会被**列出：缓存是懒填的，而一个凭猜测扣下的行是读者
	// 拿不回来的行，而一个误列的行是一个他们能丢掉的行。
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

	// 一行被访问了 —— 漏斗的 `onVisit`，对除跳变外的每次导航（见类注释）。
	// 在栈决定这一步是否值得留下**之前**调用：一个行被重新坐进是关于**这份**列表的
	// 事实，栈的去重或它的设置不能把它藏起来。已在列表上的行被移到末尾并重新盖章、
	// 绝不重复 —— 这正是让一个被打开十次的文件是一行的原因。
	//
	// **跳转一律降级成访问**：一次大纲点击、一个标题链接、一次搜索命中，在这里留下的
	// 都是「读者在这篇笔记里」。理由见类注释 —— 而落点本身并没有丢，它在栈里。
	remember(entry: NewNavEntry): void {
		if (entry.kind === 'teleport')
			return;
		const visit = entry.kind === 'jump'
			? { kind: 'visit' as const, path: entry.path, leafId: entry.leafId }
			: entry;
		if (visit.kind !== 'view' && !this.recordable(visit.path))
			return;
		const at = this.indexOf(navGroupKey(visit));
		const prev = at >= 0 ? this.entries[at] : undefined;
		if (at >= 0)
			this.entries.splice(at, 1);
		this.entries.push(placeRecord(visit, prev));
		// 读者正站在他们刚去往的那篇笔记里，这份列表听到的每次导航都会设它 ——
		// 漏斗的 `here` 广播单凭一次遍历就能到达它。在修剪之前设，好让它的
		// 豁免（见 trim）保护的是这一行，而不是一个陈旧的行。
		this.index = this.entries.length - 1;
		this.trim();
		this.changed();
	}

	// 一个**已存在**行的某个细节变得已知了 —— 漏斗的 `onLanded`。只有**视图**用得上它：
	// 读者离开一个视图时它自己的 state 被重读；行是读者点击的东西，所以回来的必须得是
	// 他们离开时的那个地点。一份笔记的位置不归这份列表管，那是位置数据库的事。
	settle(entry: NewNavEntry): void {
		if (entry.kind !== 'view' || !entry.state)
			return;
		// 读者刚离开的那个视图，重读。它的 state 是关于一个视图的唯一
		// 无法事后推导的东西（见 NavView.state）；名字与图标一同前来，
		// 是因为一个在那次访问中给自己改过名的视图应当被列在读者刚读到
		// 的名字下。时间戳随它们一同移动。
		const at = this.indexOf(navGroupKey(entry));
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
	}

	// 读者身在哪个行。栈的当前记录按身份映射到一行；一个推断出的步
	// （一次跳变）也映射到它的**文件**，因为读者无论怎么到的那里，都在那个文件里。
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

	// 取下一枚钉。钉选是这一行**唯一**能顶住规则的东西（见 pruneExcluded），所以把它
	// 拿掉就该让规则立刻算数：一个早被某条规则排除、只靠钉选活着的行，此刻当场丢掉。
	// 留到下一次规则变动才走是个更糟的答案 —— 读者今天还看得见它、明天就没了，
	// 而他们手上没有任何能解释这件事的线索。
	unpin(key: string): void {
		const at = this.pinned.indexOf(key);
		if (at < 0)
			return;
		this.pinned.splice(at, 1);
		const entry = this.entries.find(e => navGroupKey(e) === key);
		if (entry && entry.kind !== 'view' && !this.recordable(entry.path))
			this.dropRow(key);
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

	// 一次重命名会给那些命名了该文件的行重新作键。身份由 `path` 重算，所以没有
	// 任何已存的 key 需要重写。
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

	// 一次真正的 vault 删除会丢掉该文件的行。否则面板为它画的行会成为在受限列表里
	// 占着槽位的死名字。
	deleteFile(path: string): void {
		this.dropRow(path);
	}

	// 读者要求一行离开：行自己的那个 ×（见 RecentFilesBrowser.onForget）。与一次
	// vault 删除是同一种移除、同一条规则，是第二个名字而不是复用了记账员的入口点，
	// 因为两者回答不同的问题：那一个是 **VAULT** 在说文件没了，这一个是读者在说他们
	// 不想看到它。
	forget(key: string): void {
		this.dropRow(key);
	}

	// 整份列表，一次拿掉（见 RecentFilesView.onPaneMenu）。活下来的是**钉选块**，
	// 别无其它。
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

	// 上面两个名字所共同代表的那一种移除，按**行**作键（见 navGroupKey）。
	// 它取的是行而不是路径，因为一个视图没有路径 —— 一个按路径作键的过滤只能永远
	// 让每个视图都留下。
	private dropRow(key: string): void {
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
	// 排除的行，好让一个读者再也无法被展示的行不继续在受限列表里占着槽位。
	//
	// 钉住的行不在丢掉之列：规则管的是列表靠**自己**收录的东西，而钉是读者亲手打下的
	// 答案，比任何一条后来的规则都更明确（与 trim 里是同一处豁免）。一行被规则排除却
	// 仍在列表上，只可能是它还钉着；把钉取下来那一刻它就走（见 unpin）。
	// @returns 丢掉了多少行。
	pruneExcluded(): number {
		const current = this.entries[this.index];
		const pinned = new Set(this.pinned);
		const kept = this.entries.filter(e =>
			pinned.has(navGroupKey(e)) || e.kind === 'view' || this.recordable(e.path));
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

	// 去往一行所代表的笔记。记录 KIND 决定怎么去：
	//   - 一篇**笔记**以普通方式打开，与文件浏览器做的完全一样。它不携带位置，
	//     所以什么都不注入：位置数据库恢复它恢复的东西（对一个被排除的文件则是
	//     什么都不恢复），这让指向同一个文件的两个入口点表现得一致。
	//   - 一个**视图**由一个**展示**该视图的 leaf 来应答：它来自的那一个、任何其它一个，
	//     或在视图无处可寻时的一个新 tab（一行比它碰巧所在的那个 tab 活得久）。
	//     为它建起的 tab 带上读者在那里时视图所持有的 state 来建（见 NavView.state）
	//     —— 见 stack.ts 的 openViewPlace。
	// 当读者按住修饰键时，`target` 决定两者**在哪**打开（见 PaneTarget）。缺省 ——
	// 普通点击 —— 记录自己的 leaf 就是答案，这正是本插件的全部要点：一个地点把你带回
	// 它曾在之处，而那是 `getLeaf(false)` 表达不出的。
	async travel(index: number, target?: PaneTarget): Promise<void> {
		const entry = this.entries[index];
		if (!entry)
			return;
		if (entry.kind === 'view') {
			await this.open.openView(entry, target);
			return;
		}
		await this.open.openFile(entry.path, entry.leafId, target);
	}

	// 去往一篇笔记里的**某个小节**：与「点大纲面板的标题」同类的一步，只是发起方是这份
	// 列表 —— 那一节是读者搜到的（见 list.ts 的 HeadingHit），而它此刻没有记录，所以这里
	// 按大纲跳转的形状造出一条交出去。它落地之后，漏斗把这一步当作「读者在这篇笔记里」
	// 送回来（见 remember 的降级），所以这份列表记下的是那篇笔记、而不是那一节。
	//
	// `leafId` 由调用方给出（这一行一贯去往的那个标签页）：去的是**某个小节**，不是
	// 另一个地方。
	async travelToHeading(
		path: string,
		heading: string,
		line: number,
		leafId: string,
		target?: PaneTarget,
	): Promise<void> {
		const at = Math.max(0, line);
		// 视口顶 = 那一行**往上让出** core 会留的那一段（见 shared/jump-landing.ts）：
		// 源码模式让半个视口再往上收一行（那一行居中，和点大纲面板的标题一样），阅读模式
		// 桌面端不让、**顶上真有浮层压着内容时**才让开它（手机上的固定顶栏）。**行 0
		// 例外**：`applyEphemeralState` 不施加一个 0 的 scroll，所以「笔记第一行就是标题」
		// 那种笔记仍旧落在文件的顶上。
		const top = at > 0 ? Math.max(1, at - jumpTopBiasLines(this.alignView(path))) : 0;
		const place: NavJump = {
			kind: 'jump',
			path,
			key: `outline:${heading}`,
			// 落点就是那一节**此刻**所在的行：它是现查得来的（见 reads.ts 的
			// headingsFor），所以这一步不必等落定来校准（见 landedLine 的次序）。
			keyLine: at,
			// ……而这一处**必须**由 `st` 说出，光有 keyLine 不够：施加一次跳转的那一套读的
			// 是 `st`（stack.ts 的 landingOf / armLandingMark），而一个没有 `st` 的跳转会
			// 一路回落到位置数据库保存的阅读位置（patcher.ts 的 `navLanding ??
			// store.read(...)`、appliedLanding 的同一处兜底）—— 那恰恰是这一次前往要绕开的
			// 地方：去一个搜到的小节却落在读者上次读到的地方，那一行印着的标题就是一句空话。
			//
			// 光标落在该行行首，与点大纲面板的标题落在那里的方式一样（见 landingOf），
			// 而 `st` 在这里现造而不是等落定，是因为这一次前往**没有**落定可读：撑开落点
			// 吸收窗口的是大纲点击那个采集点（outline-capture.ts），这条路径没有经过它。
			//
			// `scroll` 记的是**视口顶**，不是那一行：它俩在源码模式下差半个视口，而一记下来
			// 就再也分不开 —— 之后每一次前进/后退（landingOf → historyJumpApply）都按这个值
			// 复现。这与 core 记一条大纲点击时做的事是同一件：它记的也是落定之后的视口。
			st: caretAtLine({ scroll: top }, at),
			leafId,
			t: Date.now(),
		};
		await this.open.openJump(place, target);
	}

	// 「那一行该落成什么样」问谁：这一行要去的是**那个标签页**（leafId 由调用方给出），
	// 但视图可能已经不在（一个地点活得比它的标签页久），所以退回**正显示着这篇笔记的**
	// 任何一个 markdown 视图，再退回活跃的那个，再退回随便一个 —— 一次普通的打开就发生在
	// 附近。量不到时返回 null，调用方退回「不让」（bias 0）。
	//
	// ⚠️ 只挑**量得出几何**的视图（见 isMeasurable）。一个滚在后台标签页里的视图矩形
	// 全是 0，从它身上读到的「一屏有多少行」自然也是 0 —— 偏移于是悄悄塌成「不让」，
	// 落点变成贴顶。那正是「有时候居中、有时候贴顶」的来源（2026-10-07 用户报的
	// 「有时候跳转位置不稳定」）。所以优先级是：
	//   显示着目标且在布局里 > 活跃且在布局里 > 任何在布局里的 > 其余
	// 最后两档是忠实的兜底：真量不出来时才退回旧行为，而不是永远。
	//
	// 刻意从工作区现问，而不是把 leafId 换成 leaf：leaf id 的解析（state.leafId）属于
	// 打开管线，而这个 store 在没有工作区时也必须能构造（见文件头）。这里的每一次
	// 求值都是导航路径上的冷读。
	private alignView(path: string): MarkdownView | null {
		const workspace = this.app.workspace as Workspace | undefined;
		if (!workspace || typeof workspace.iterateAllLeaves !== 'function')
			return null;
		let showing: MarkdownView | null = null;
		let showingUnmeasured: MarkdownView | null = null;
		let measured: MarkdownView | null = null;
		let any: MarkdownView | null = null;
		// 故意用块语句体：这个回调**必须**返回 undefined —— Obsidian 的 iterate 辅助
		// 函数会把回调结果当成提前中断的信号（见 restorer.ts 的 pruneStaleLeafIds）。
		workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file)
				return;
			const measurable = isMeasurable(view);
			if (view.file.path === path) {
				if (measurable)
					showing ??= view;
				else
					showingUnmeasured ??= view;
			}
			if (measurable)
				measured ??= view;
			any ??= view;
		});
		const active = typeof workspace.getActiveViewOfType === 'function'
			? workspace.getActiveViewOfType(MarkdownView)
			: null;
		return showing
			?? (active && isMeasurable(active) ? active : null)
			?? measured
			?? showingUnmeasured
			?? active
			?? any;
	}

	// 上限变了（设置标签页）：**现在**就修剪，而不是等下次访问 —— 等待会在之后
	// 一次丢掉一大块，且无从解释。
	// @returns 丢弃了多少行。
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

	private indexOf(key: string): number {
		for (let i = 0; i < this.entries.length; i++)
			if (navGroupKey(this.entries[i]) === key)
				return i;
		return -1;
	}

	// 一条栈记录所站的那一行。一个推断出的步站在它的文件上，而一个自己没了的
	// 记录（被淘汰了，或从未被记录）也站在它的文件上。
	private indexFor(entry?: NewNavEntry): number {
		if (!entry)
			return -1;
		if (entry.kind !== 'teleport') {
			const at = this.indexOf(navGroupKey(entry));
			if (at >= 0)
				return at;
		}
		if (entry.kind === 'view')
			return -1;
		return this.indexOf(entry.path);
	}

	// 通过丢掉最旧的行把列表保持在上限之内 —— 绝不丢读者所站的那一行，这样一行
	// 就不会被他们自己的访问所触发的修剪从他们脚下淘汰掉。
	//
	// 上限数的是读者**未**命名的行：钉选是加在那个数字**之上**、而不是从
	// 里面扣的，所以钉选一篇笔记不会悄悄让他们失去他们设的那五十个之一。
	// @returns 丢掉了多少行。
	private trim(): number {
		const before = this.entries.length;
		const pinned = new Set(this.pinned);
		let counted = 0;
		for (const entry of this.entries)
			if (!pinned.has(navGroupKey(entry)))
				counted++;
		const over = counted - this.cap();
		if (over <= 0)
			return 0;
		const kept: NavEntry[] = [];
		let dropped = 0;
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			// 钉选不会过期淘汰。上限约束的是列表靠自己所记住的东西，
			// 而一次读者没要求的淘汰，正是钉选存在的意义所在。
			if (dropped < over && i !== this.index && !pinned.has(navGroupKey(entry))) {
				dropped++;
				continue;
			}
			kept.push(entry);
		}
		this.keep(kept);
		return before - this.entries.length;
	}

	// 把一个过滤后的数组放进列表的位置，当那一行在过滤中存活下来时，
	// 让「你在这里」指针停在同一行上。
	private keep(kept: NavEntry[]): void {
		if (kept.length === this.entries.length)
			return;
		const current = this.entries[this.index];
		this.entries = kept;
		this.index = current && kept.includes(current) ? kept.indexOf(current) : -1;
	}
}

// 一条记录被写下时的样子。**不保留任何位置**：一篇笔记的行就是那篇笔记，而它落在哪儿
// 由位置数据库回答（见 travel）。
//
// 跳转在这里不可达 —— remember 已经把它们降级成访问了（见类注释），而这份列表持有的
// 每条记录都是一次访问或一个视图。
//
// `prev` 只为一个用途而传：一个**视图**的 state 是一次空手而归的读取唯一会抹掉的东西
// （视图抛了异常、答了空，或超过了上限 —— 见 shared/leaf.ts 的 viewState），而一次失败
// 的读取不该让读者失去他们离开时的地点。标签与图标则相反：它们被每次访问刷新，一个给
// 自己改过名的视图按它**此刻**说的话来命名与标记。
function placeRecord(entry: NewNavEntry, prev?: NavEntry): NavEntry {
	const t = Date.now();
	const kept = prev?.kind === 'view' ? prev : undefined;
	if (entry.kind === 'view')
		return {
			kind: 'view', leafId: entry.leafId, viewType: entry.viewType, t,
			label: entry.label, icon: entry.icon, state: entry.state ?? kept?.state,
		};
	return { kind: 'visit', path: entry.path, leafId: entry.leafId, t };
}
