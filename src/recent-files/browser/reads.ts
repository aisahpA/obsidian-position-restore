import { App, EventRef, TFile } from 'obsidian';
import { NavEntry } from '@/nav/entry';
import { EphemeralState } from '@/types';
import { HeadingRef, headingsFromLines } from '@/shared/headings';
import { NavEntryDescription, describeNavEntry } from './model';

// 浏览器从 vault 里读出来的一切，带缓存：一条条目的显示碎片（一帧渲染的量），
// 以及按 path 分，文件元数据缓存所回答的东西 —— 它的各标题、和它另有的那些名字。
// 这些都不需要文件的文本。
//
// **一个**问题可能要去问文本，而且只在缓存被问过、且什么都没说之后：一篇 app 还没重新
// 解析的笔记的标题链（见 headingsFor）。

export interface RecentFilesReadsOptions {
	// 文件记录自身不携带位置，所以这样一行显示的行号，就是一次普通打开会落到的行 ——
	// 这正是这一行所做的承诺。
	savedPosition?: (path: string) => EphemeralState | undefined;
	// 是一个读取器，不是一个快照：常驻面板每次渲染都会被重新指向。
	entries: () => NavEntry[];
	// 一次在一行被画出来时还不存在的读取已经落地。列表是唯一能展示它的东西，
	// 而只有一次重画才能做到。
	onLateRead?: () => void;
	// 一行拿来当作笔记名字显示的 frontmatter 属性，没有时为**空**
	// （见 PluginSettings.recentFilesTitleProperty）。每次询问都读、而不是只取一次：
	// 一个在设置里把它打开的读者，正看着那个必须在他们手底下变的面板。
	titleProperty?: () => string;
	// 一篇笔记**显示的名字**变了。列表是唯一展示它的东西，而只有一次重画才能做到。
	// 有意少发：笔记里任何地方的一次编辑都会让它重新解析，所以单看那个元数据事件
	// 说不出关于名字的任何事 —— 触发它的是「现在这个名字不一样了」。
	onTitleChange?: () => void;
}

// 一个文件的元数据说了什么：落点行显示的标题链，以及这个文件另有的、搜索框据以匹配的
// 那些名字。两者共一个记录，因为 `getFileCache` 一次调用就把两者都答了。
export interface FileMeta {
	// Obsidian 还没解析这个文件时为 undefined —— 这与「链是空的文件」不是同一个答案
	// （见 readMeta）。
	headings?: HeadingRef[];
	// Obsidian **自己**的属性，且只有它：app 专有词就叫「别名」，而读者遇到它的其它任何地方
	// —— 快速切换器、`[[`、反向链接 —— 指的都是这些名字。
	aliases: string[];
	// `title` 属性，一个社区惯例、不是原生的。与别名**分开**存，因为它不是其中之一：
	// 它是笔记给自己起的名字，而一行可能正在显示它（见 `title`）。
	frontTitle?: string;
	// 一行拿来当笔记名显示的东西，取自读者所命名的属性 —— 没有这样的属性、或它的值不是一个
	// 名字时为 undefined，那时就轮到文件自己的名字了。
	title?: string;
}

// 一篇笔记**除了**它那一行所显示的那个之外另有的名字，作为一个问题问出、作为**两个**来回答：
// 两者中只有一个是 app 所称的别名，而一个被归档到「别名」下的 `title`，
// 是对一个读者没问的问题的回答。
export interface FileNames {
	// 笔记自称什么；当这一行已经在显示它时不存在。
	frontTitle?: string;
	aliases: string[];
}

export class RecentFilesReads {
	// 筛选每敲一个键就重渲染一次，所以 describeNavEntry 背后那些 vault 查询不会按行重复。
	private descCache = new Map<number, NavEntryDescription>();
	// 按 **path** 为键，所以与上面的缓存不同，它会熬过列表被筛选、被重建。
	//
	// **缓存作答之前什么都不留**：文件未解析时 `getFileCache` 是 null —— 恰恰是同步正在
	// 替换一个文件的时刻 —— 而改名不触发 'changed'，所以一个被记住的「未命中」没有事件
	// 剩下来可以作废它；它会比那次同步本身活得还久，并让这一行失去它的链，直到主体死掉。
	// 所以一次未命中的会在下一次渲染时再问一遍，那只是一次 map 查询，而这份 map 省下的
	// 工作量，只在有一个答案可省时才发生。
	private meta = new Map<string, FileMeta>();
	// 那些被记住的名字是在哪个属性下读的。**每次询问都比对**，而不是靠事件作废：
	// 那个属性是一个这个缓存订阅不了的读取器，而那个在设置里改了它的读者，
	// 正看着那个必须在他们手底下变的面板（见 RecentFilesBrowserPrefs.titleProperty）。
	private titledFor?: string;
	// 文件**自己的文本**，供缓存答不了的那**一个**问题：一篇它还没重新解析的笔记的链
	// （见 headingsFor）。
	//
	// 对着 mtime 记住、而不是靠事件作废：让这样一次读取过期的是**外部**变更，
	// 而外部变更不触发 'changed' —— 这正是这个兜底存在的全部理由。
	private heads = new Map<string, { mtime: number; headings: HeadingRef[] }>();
	// 此刻正在读的 path：无论多少帧来问，文件只被读一次。
	private reading = new Set<string>();
	private metaRef?: EventRef;

	constructor(
		private app: App,
		private opts: RecentFilesReadsOptions,
	) {
		// 改掉一个别名，正是过期记忆最糟的时候 —— 读者正在敲他们刚改的那个名字。
		// 一次变更作废的是**一个**文件的记录，不是整张 map。
		//
		// 一个**读者正在敲的名字**也会在他们手底下变，而那一行正站在那儿显示着旧的。
		// 是对比、而不是假定：笔记里任何地方的一次编辑都会让它重新解析，所以单看这个事件
		// 说不出关于名字的任何事，而每敲一个键就重画一次，是对一份读起来一模一样的行
		// 做整份重建（见调用方的 render）。
		this.metaRef = app.metadataCache?.on?.('changed', (file: TFile) => {
			const before = this.meta.get(file.path)?.title;
			this.meta.delete(file.path);
			if (!this.opts.titleProperty?.())
				return;
			if (this.titleOf(file.path) !== before)
				this.opts.onTitleChange?.();
		});
	}

	// 两个外壳都经由浏览器的 destroy 关闭，而对话框每次打开都是一个新的 reads 对象。
	dispose(): void {
		if (this.metaRef)
			this.app.metadataCache?.offref?.(this.metaRef);
		this.metaRef = undefined;
	}

	// 浏览器关于「文件是否存在」的**唯一**一个问题，而 RecentFilesList 是它唯一的提问者：
	// 一个文件没了的地点会在画出一行之前被滤掉，所以下游什么都不必费心。store 会在 vault 的
	// delete 事件里自己修剪这样一个地点；这个覆盖的是那件事落地之前的窗口期。
	// 做成箭头字段，好让它作为一个普通谓词被交出去。
	hasFile = (path: string): boolean =>
		this.app.vault.getAbstractFileByPath(path) instanceof TFile;

	// 一行怎么称呼那篇笔记：读者所命名的属性，当笔记有这个属性时。undefined 不是关于这篇
	// 笔记的一个答案 —— 那是轮到文件自己的名字了（见 describeNavEntry）。设置为空时整个
	// 跳过：一个从未要过这个的 vault，不会为它被问任何元数据问题。
	titleOf = (path: string): string | undefined => {
		if (!path || !this.opts.titleProperty?.())
			return undefined;
		return this.metaFor(path).title;
	};

	describe(i: number): NavEntryDescription {
		let d = this.descCache.get(i);
		if (!d) {
			d = describeNavEntry(this.opts.entries()[i], this.opts.savedPosition, this.titleOf);
			this.descCache.set(i, d);
		}
		return d;
	}

	clearDescribeCache(): void {
		this.descCache.clear();
	}

	// 每个 path 只映射一次 —— 而且只在缓存作答之后（见 `meta`）。
	//
	// 一个「名字是在读者后来改掉的那个属性下读的」记录，是对没人问的问题的回答，而它是按
	// **path** 留的 —— 所以它会比那次必须显示新名字的重画活得还久。记录的其余部分随之一起走：
	// 它的每一部分都只是一次缓存查询，而「两个问题下只读一半」是多出来的一条要推理的规则。
	metaFor(path: string): FileMeta {
		const prop = this.opts.titleProperty?.() ?? '';
		if (prop !== this.titledFor) {
			this.titledFor = prop;
			this.meta.clear();
		}
		const known = this.meta.get(path);
		if (known)
			return known;
		const read = readMeta(this.app, path, prop);
		if (!read)
			return noMeta();
		this.meta.set(path, read);
		return read;
	}

	// 得知一条链的**两种**办法：已经解析好的元数据缓存，以及笔记自己的文本。文本只在第一种
	// 什么都没说时才用 —— 而「什么都没说」包括**空**链：一篇同步刚放回来的笔记，可能在它还在
	// 被写的时候就被解析过了，而在手机上那个记录可能就此代表整个会话剩下的部分。
	headingsFor(path: string): HeadingRef[] | undefined {
		const fromCache = this.metaFor(path).headings;
		if (fromCache && fromCache.length)
			return fromCache;
		return this.textHeadings(path);
	}

	// **提问免费、作答不免费**：文本在一个 await 之后，所以现在正被画的这一行是没带链画的。
	// 在这次读取落地之前，显示的是在这个 mtime 下上次拍的那次读取 —— 一条旧一次同步的链
	// 仍然说得出那一分节，比一个行号能做的还多。
	//
	// ……所以这个不管那条记录是在哪个 mtime 下拍的都拿它作答，而下面的 linesFor 不行。
	private textHeadings(path: string): HeadingRef[] | undefined {
		this.ensureText(path, true);
		return this.heads.get(path)?.headings;
	}

	// 开始读一篇笔记的文本，除非那条链已经在文件**当前**的 mtime 下到手了。
	//
	// `prime` 是「是否可以**开始**一次读取」。一次悬停可以 —— 答案只隔一个 await。
	// 一次五十行的渲染不行：为给五十行贴标签而读五十个文件，不是一次重画付得起的价钱。
	// （唯一为它传 false 的调用方曾是那条链自己；如今两者都不等，所以链随下一次重画到达 ——
	// 见调用方的 redrawSoon。）
	private ensureText(path: string, prime: boolean): number | undefined {
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(file instanceof TFile))
			return undefined;
		const mtime = file.stat.mtime;
		if (this.heads.get(path)?.mtime !== mtime && prime && !this.reading.has(path)) {
			this.reading.add(path);
			void this.readText(path, file, mtime);
		}
		return mtime;
	}

	// 对着它被读时的 mtime 记住。一次**失败**的读取被记成「没有标题」，
	// 而不是留着悬空：一个读不了的文件，是这份列表反正即将停止绘制的（见 hasFile），
	// 而一个悬空的问题会在主体活着的整个期间、每次重画都被再问一遍。
	private async readText(path: string, file: TFile, mtime: number): Promise<void> {
		let headings: HeadingRef[] = [];
		try {
			headings = headingsFromLines((await this.app.vault.cachedRead(file)).split('\n'));
		} catch {
			// 那就没什么可说：这一行没有大纲可搜。
		}
		this.reading.delete(path);
		this.heads.set(path, { mtime, headings });
		this.opts.onLateRead?.();
	}

	// 从缓存里**实时**读、而不是存在某个地点上：一个别名是 vault 对某个文件**现在**的说法，
	// 不是上周发生的一次访问的一部分 —— 而一份冻结的列表，恰恰会在读者去找一个他们刚改的
	// 名字时出错。对没有 path 的视图为空，因为它不是一个文件。
	//
	// `printed` 是这一行正在显示的名字，它不是这篇笔记**另有的**名字之一。只有调用方知道它：
	// 读者选的那个属性，或没有属性时文件自己的名字（见 describeNavEntry）。
	otherNamesFor(path: string, printed?: string): FileNames {
		if (!path)
			return { aliases: [] };
		const meta = this.metaFor(path);
		// ……减去这一行**显示**的那个名字，它不是笔记另有的名字之一：一个写着「又名 读书笔记」
		// 的提示框，出现在一行写着 读书笔记 的行下面，是把同一件事说了两遍。
		const aliases = printed ? meta.aliases.filter(a => a !== printed) : meta.aliases;
		return {
			frontTitle: meta.frontTitle === printed ? undefined : meta.frontTitle,
			aliases,
		};
	}
}

// 读一个 path 的元数据，经由缓存、绝不碰磁盘。`path` 对没有 path 的视图为空：没有文件可查。
//
// NULL 的意思是「Obsidian 还没解析这个文件」—— 一个它还在建索引的、或一个同步刚放回来的
// —— 这与「一个没有标题的文件」不是同一个答案：后者是一次真实的读取，而且会被留下
// （见 metaFor）。
// 读者要求一行把笔记**叫作**什么：一个 frontmatter 属性，只在这个属性持有一个**名字**时才读
// 它。一个**列表**算，取**第一项** —— 那是读者把想要的那个写在最前面的地方，`aliases: [读书笔记,
// 周会]` 命名的是 读书笔记。一个数字、一个日期、一个被清空的值、或首项不是文本的列表都不是
// 名字：一个靠猜的行会在本该是名字的地方显示一个年份。
//
// 大小写只在写下的那个没命中之后才试：在设置里命名这个属性的读者，不记得笔记里写的是 `title`
// 还是 `Title`，而一次未命中就是一行默默改为显示它的文件名。
function frontmatterName(
	fm: Record<string, unknown> | undefined,
	prop: string,
): string | undefined {
	if (!prop || !fm)
		return undefined;
	const asName = (value: unknown): string | undefined => {
		// 列表只认第一项，**不往后找**第一个能用的：那是猜。
		const first: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
		if (typeof first !== 'string')
			return undefined;
		const text = first.trim();
		return text || undefined;
	};
	const direct = asName(fm[prop]);
	if (direct)
		return direct;
	const wanted = prop.toLowerCase();
	for (const key of Object.keys(fm))
		if (key.toLowerCase() === wanted)
			return asName(fm[key]);
	return undefined;
}

function readMeta(app: App, path: string, titleProperty: string): FileMeta | null {
	const file = path ? app.vault.getAbstractFileByPath(path) : null;
	const cache = file instanceof TFile ? app.metadataCache?.getFileCache?.(file) : null;
	if (!cache)
		return null;
	const headings = cache.headings?.map(h => ({
		heading: h.heading,
		level: h.level,
		line: h.position.start.line,
	}));
	const fm: Record<string, unknown> | undefined = cache.frontmatter;
	const aliases: string[] = [];
	const seen = new Set<string>();
	// 一层嵌套，这就是这个属性的各种形态所需的全部：一个列表可能装字符串，
	// 而一个手工编辑的可能装列表的列表。
	const push = (value: unknown): void => {
		if (typeof value === 'string') {
			const text = value.trim();
			if (text && !seen.has(text)) {
				seen.add(text);
				aliases.push(text);
			}
		} else if (Array.isArray(value)) {
			for (const item of value)
				push(item);
		}
	};
	// `aliases` 是 Obsidian 自己的属性，可能是一个字符串**或**一个列表 —— 手写的
	// `aliases: weekly` 与块列表一样有效。它与快速切换器和 `[[` 建议所匹配的是同一套词汇：
	// 这次搜索是与 app 一致的，而不是另发明一条规则。
	// `title` 不是原生的，而是一个社区惯例（Front Matter Title），它**分开**于别名来读，
	// 因为它不是别名之一：它是笔记给自己起的名字，提示框会让它占单独一行（见 otherNamesFor）。
	push(fm?.aliases);
	return {
		headings,
		aliases,
		frontTitle: frontmatterName(fm, 'title'),
		title: frontmatterName(fm, titleProperty),
	};
}

// 给一个 Obsidian 还没解析的文件的那次读取。每次都新建，而且有意**不**放进 map（见 metaFor）。
function noMeta(): FileMeta {
	return { headings: undefined, aliases: [] };
}
