// 最近文件浏览器的**常驻**外壳（browser/view.ts）：它是靠什么成为侧边栏面板
// 而不是对话框的 —— 窗格自己围着 body 的寿命、窗格自己的宽度决定呈现方式，以及
// 立着期间一直听着地点列表（见 NavPlaces.subscribe）。body 本身 —— 那棵树、大纲
// 行、键盘、前往 —— 在 recent-files-browser-dom.test.ts 里覆盖，那里它是经由
// 模态框驱动的。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keymap, Platform, TFile, WorkspaceLeaf } from 'obsidian';
// ……以及 app 的菜单，走它自己的路径而不经由 'obsidian'，理由和浏览器那个套件
// 一样（见 recent-files-browser-dom.test.ts）：测试从它读到的 —— 视图加的那些
// 条目 —— 是桩的登记簿，不是 app 的类型声明。
import { Menu } from './support/obsidian-stub';

import { RECENT_FILES_VIEW_TYPE, RecentFilesView, activateRecentFilesView } from '@/recent-files/browser/view';
import type { RecentFilesBrowserPrefs } from '@/recent-files/browser/body';
import type { RecentFilesBrowserArrows } from '@/recent-files/browser/arrows';
import type { PathDisplayMode } from '@/types';
import { navGroupKey, type NavEntry } from '@/nav/entry';
import type { PaneTarget } from '@/nav/pane';
import { t } from '@/i18n';
import type { HeadingRef } from '@/shared/headings';
import { PANEL_EXIT_GRACE_MS, TIME_REFRESH_MS } from '@/recent-files/browser/constants';

// jsdom 不实现布局，所以这里是缺失而不是坏掉。
Element.prototype.scrollIntoView = () => {};

// 在这个套件的**运行期**，'obsidian' 解析到 tests/support/obsidian-stub.ts
// （见 vitest.config.mts），但 tsc 从真实的、只含类型声明的包读它的类型 ——
// 那个包只声明插件问的那两个问题（isModEvent / isModifier），别的什么都没有。
// 桩的那些应答是测试设置的**输入**，所以它们经由一次诚实的 cast 抵达，而不是
// 硬安到 app 的类上。
const KeymapKnobs = Keymap as unknown as {
	reset(): void;
	modEvent: unknown;
	modifier: boolean;
};

// 插件交出的浏览器偏好（见 RecentFilesBrowserPrefs）：设置标签页所拥有那些值的
// **读取器** —— 每次挂载一套新的，所以没有哪个测试会决定另一个的。面板对一个在
// 它底下**变了的**值做什么，是外壳加的唯一一件事，所以这个 fixture 也可以被写：
// 那正是设置标签页做的事（见 SettingTab.setControlValue），随后面板被要求重画
// （见 RecentFilesView.refresh）。
type TestPrefs = RecentFilesBrowserPrefs & { setOutline: (on: boolean) => void };

function browserPrefs(
	// 搜索框是否把各篇笔记的小节标题也算进搜索面（见 RecentFilesBrowserPrefs）：这个
	// 套件里唯一一个会**改变列表形状**的偏好，所以「面板对一个变了的值做什么」那件事
	// 拿它来试。
	outline = true,
	path: PathDisplayMode = 'smart',
	time = false,
): TestPrefs {
	const held = { outline, path, time };
	return {
		outlineSearch: () => held.outline,
		// 列表往回够多远（见 PluginSettings.recentFilesCap）：一个面板只读的数字。
		placesCap: () => 200,
		// 一行的路径印出多少、印在名字的哪一侧（见 PathDisplayMode）。
		pathDisplay: () => held.path,
		// 每一行是否带日期（见 RecentFilesBrowserPrefs.rowTime）：一个开关，除非测试
		// 要求否则是关的 —— 标签说什么 是 body 的事，在 body 所在处覆盖（见
		// recent-files-browser-dom.test.ts）；外壳加的是那个让它保持新鲜的定时器的
		// 寿命（见下面的测试）。
		rowTime: () => held.time,
		// 一行怎么称呼这篇笔记：这些测试没有一个命名它，所以印出的是文件自己的
		// 名字（见浏览器套件）。
		titleProperty: () => '',
		// 悬停在哪里打开笔记：这些测试没有一个做悬停，而且这是一个按悬停、不是按
		// 面板问的问题（见 PreviewFocusMode）。
		previewFocus: () => 'head',
		setOutline: (on) => {
			held.outline = on;
		},
	};
}

// **那四个箭头**，按插件把它们交给外壳的方式（见 RecentFilesBrowserArrows）—— 而
// 每个外壳都会画出它们，所以这里没有一个开关说别的。测试想知道的关于它们的事
// 是：**哪一个**被按了，以及这四个是**何时**被重新问的：一个动作可能是异步的
// （一个步打开一篇笔记并等它），而那次询问也得等它。
function browserArrows(): RecentFilesBrowserArrows & {
	pressed: string[];
	// 测试说「把这个动作敞着」并自己结算它，好让「落地之后再问的」和「当场问
	// 的」区分开。
	hold(): void;
	release(): void;
	set(on: Partial<{ back: boolean; forward: boolean }>): void;
} {
	const pressed: string[] = [];
	// 这四个被**问**的东西（见 refreshArrows）：测试关掉其中一个，好看到它置灰的
	// 那个按钮 —— 就像没有步可走时历史的做法。
	const state = { back: true, forward: true };
	let holding = false;
	let settle: (() => void) | undefined;
	const press = (act: string) => (): Promise<void> | undefined => {
		pressed.push(act);
		if (!holding)
			return undefined;
		return new Promise<void>((resolve) => { settle = resolve; });
	};
	return {
		back: press('back'),
		forward: press('forward'),
		top: press('top'),
		bottom: press('bottom'),
		canBack: () => state.back,
		canForward: () => state.forward,
		canEdge: () => true,
		pressed,
		// ……以及这次翻转，好让「重新问过」看得见：应答在按下期间变了，而只有等
		// 动作的那个询问才展示得出。
		set(on: Partial<{ back: boolean; forward: boolean }>) {
			Object.assign(state, on);
		},
		hold() {
			holding = true;
		},
		release() {
			holding = false;
			settle?.();
			settle = undefined;
		},
	};
}

const MINUTE = 60_000;
const NOW = Date.now();

const visit = (path: string, stamp: number): NavEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp });

// 视图所看到的地点列表：entries、指针、travel 与 subscribe（见 places.ts 的
// PlaceList）。真实 store 在 recent-files-places.test.ts 里对着同一个面被演练；
// 这里的重点是**外壳**，所以列表是一个可以手工挪动的 fixture。
class FakeNav {
	entries: NavEntry[] = [];
	index = -1;
	// 读者钉住的那些行，按 store 交出它们的样子（见 NavPlaces.pinned）：测试直接
	// 写这个数组，这正是右键菜单对 store 那个数组做的事。
	pinned: string[] = [];
	readonly jumped: number[] = [];
	private listeners = new Set<() => void>();

	// 每次前往被要求开在哪里（见 PaneTarget）：记在地点旁边，因为面板自己对
	// 「哪里」的应答正是修饰键测试的要点。
	readonly targets: (PaneTarget | undefined)[] = [];

	// ……以及去往一个**搜到的小节**的那一种前往（见 list.ts 的 HeadingHit）：它不
	// 走一条记录，所以单独记。
	readonly headed: { path: string; heading: string; line: number; target?: PaneTarget }[] = [];

	// 真实的前往，缩微版：被前往的那个地点重新盖章并成为当前那个 —— 于是列表在
	// 面板底下被重写，这正是面板必须先折叠的全部理由（见 NavPlaces.travel /
	// RecentFilesList.collapse）。
	travel = async (i: number, target?: PaneTarget): Promise<void> => {
		this.jumped.push(i);
		this.targets.push(target);
		const visited = this.entries[i];
		this.entries = [...this.entries.slice(0, i), { ...visited, t: Date.now() }];
		this.index = this.entries.length - 1;
		for (const fn of this.listeners)
			fn();
	};

	travelToHeading = async (
		path: string, heading: string, line: number, _leafId: string, target?: PaneTarget,
	): Promise<void> => {
		this.headed.push({ path, heading, line, target });
	};

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	// 读者把一行从列表上拿掉（行本身的 × —— 见 RecentFilesBrowser.onForget）：
	// 真实 store 按行自己的 key 丢掉这行所据以绘制的每一条记录（见
	// NavPlaces.forget），并通知它的监听者，和它对别处做的改动一模一样。
	forget(key: string): void {
		this.entries = this.entries.filter(e => navGroupKey(e) !== key);
		for (const fn of this.listeners)
			fn();
	}

	// 钉住，缩微版：`pinned` 就是那一块，而一次改动通知监听者的方式和一次移除
	// 一模一样（见 NavPlaces.afterPinChange）。
	pin(key: string): void {
		if (!this.pinned.includes(key))
			this.pinned.push(key);
		for (const fn of this.listeners)
			fn();
	}

	unpin(key: string): { dropped: boolean } {
		const at = this.pinned.indexOf(key);
		if (at >= 0)
			this.pinned.splice(at, 1);
		for (const fn of this.listeners)
			fn();
		// 外壳套件不演排除规则：取钉从不带走行（见 NavPlaces.unpin）。
		return { dropped: false };
	}

	wouldUnpinDrop(): undefined {
		return undefined;
	}

	restorePinned(): void {}

	movePinned(key: string, delta: number): void {
		const at = this.pinned.indexOf(key);
		if (at < 0)
			return;
		const to = Math.min(Math.max(at + delta, 0), this.pinned.length - 1);
		if (to === at)
			return;
		this.pinned.splice(at, 1);
		this.pinned.splice(to, 0, key);
		for (const fn of this.listeners)
			fn();
	}

	isPinned(key: string): boolean {
		return this.pinned.includes(key);
	}

	// 整个列表，一次性拿掉（见 NavPlaces.clear）：真实 store 留下的是钉住的那一
	// 块，而监听者听到它的方式和听到一次移除一模一样。
	clear(): void {
		this.entries = this.entries.filter(e => this.pinned.includes(navGroupKey(e)));
		for (const fn of this.listeners)
			fn();
	}

	// 读者在别处做的一个步：屏幕上每个浏览器都被通知（见 NavPlaces.changed）。
	moved(index: number): void {
		this.index = index;
		for (const fn of this.listeners)
			fn();
	}

	get listenerCount(): number {
		return this.listeners.size;
	}
}

function makeApp(
	paths: string[] = [],
	// 这些笔记**各自的小节**，按 app 的元数据缓存交出它们的样子（见 reads.ts 的
	// readMeta）。一个测试要搜到某个小节，就得让它存在于 vault 里。
	headings: Record<string, { heading: string; level: number; line: number }[]> = {},
) {
	const files: Record<string, TFile> = {};
	for (const path of paths)
		// 一个 stat，正如每个 TFile 都有的那样：从文件自己的文本读出的章节链会连
		// 同它的 mtime 一起被记住（见 reads.ts）。
		files[path] = Object.assign(new TFile(), { path, stat: { ctime: 0, mtime: 0, size: 0 } });
	// app 自己的文件菜单事件：一行会问 **app** 它能拿这个文件做什么（见
	// RecentFilesBrowser.contextRow），而这个面板交给 app 的是菜单**对象** ——
	// 所以它被**记下**而不是被简单地吞掉。想知道是谁把菜单从屏幕上拿走的测试，
	// 得能再次找到它。
	const trigger = vi.fn();
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files[path] ?? null,
			cachedRead: async () => '',
			// 面板立着期间监听的那些文件事件（见 body.ts 的 watchExistence）。
			// 这里一个都不会触发 —— 这个套件讲的是外壳 —— 所以被桩掉的只是
			// 「监听不花代价」这一点。
			on: () => () => {},
			offref: () => undefined,
		},
		metadataCache: {
			getFileCache: (file: TFile) => {
				const hs = headings[file.path];
				return hs
					? { headings: hs.map(h => ({ ...h, position: { start: { line: h.line } } })) }
					: null;
			},
		},
		workspace: {
			rootSplit: { containerEl: document.createElement('div') },
			iterateAllLeaves: () => undefined,
			// 这个文件的 harness 里没有打开任何 markdown leaf，所以一行「会落在哪里」
			// 由位置数据库答、而不是由屏幕上的编辑器答（见 reads.ts）。
			getLeavesOfType: () => [],
			trigger,
		},
	};
	return { app: app as never, trigger };
}

// 一个挂载了的面板拥有两个定时器 —— 五分钟的滴答，以及一次迟到的读取所欠的重
// 画 —— 而关掉它就是停住它们的东西。若一直开着，其中一个会在它被绘制的环境消失
// 之后触发。
const mounted: RecentFilesView[] = [];

afterEach(async () => {
	while (mounted.length)
		await mounted.pop()?.onClose();
});

async function mount(
	entries: NavEntry[],
	index: number,
	prefs: RecentFilesBrowserPrefs = browserPrefs(),
	// 仓库持有、还没有任何条目点名的路径：一个在面板立着时往历史里追加步的测试，
	// 需要它背后的文件存在，否则列表会把新地点过滤掉（见 RecentFilesList.render）。
	extraPaths: string[] = [],
	arrows: ReturnType<typeof browserArrows> = browserArrows(),
	headings: Record<string, { heading: string; level: number; line: number }[]> = {},
) {
	const nav = new FakeNav();
	nav.entries = entries;
	nav.index = index;
	const { app, trigger } = makeApp(
		[...entries.flatMap(e => (e.kind === 'view' ? [] : [e.path])), ...extraPaths],
		headings,
	);
	const leaf = Object.assign(new WorkspaceLeaf(), { app });
	// jsdom 不做任何布局，所以窗格报告宽度 0 —— 那是**内联**呈现，即不需要第二
	// 列的那一种（见 RecentFilesView.measure）。
	const view = new RecentFilesView(leaf, nav as never, () => undefined, prefs, arrows);
	await view.onOpen();
	mounted.push(view);
	// 视图**自己的**容器与内容元素：窗格交给面板的东西，以及 Obsidian 要求视图
	// 在其中构建的东西。
	const el = view.containerEl;
	const rows = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'));
	const names = () => rows().map(r => r.querySelector('.nav-row-name')?.textContent);
	// listbox 本身：那些决定列表是否**正被阅读**的指针事件抵达之处（见
	// RecentFilesBrowser.freezeOrder）。
	const list = () => el.querySelector<HTMLElement>('.position-restore-nav-list')!;
	return { view, el, nav, rows, names, list, trigger, arrows };
}

describe('RecentFilesView —— 常驻面板', () => {
	beforeEach(() => {
		// app 自己的那些应答（见 Keymap）：一个测试设置的输入，若从前一个用例留
		// 下来就会决定这一个。
		KeymapKnobs.reset();
		document.body.empty();
	});

	it('把列表内容直接装进 pane，外面不套对话框', async () => {
		const { view, el, names } = await mount([visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1);

		// body，完整的：工具栏 —— 搜索框，旁边什么都没有 —— 以及笔记列表，当前
		// 那篇钉在最前并标记。没有自己的设置：那四个选择现在是插件设置标签页里的
		// 几行（见 RecentFilesBrowserPrefs）。
		expect(el.querySelector('.position-restore-nav-filter')).not.toBeNull();
		expect(el.querySelector('.position-restore-nav-settings')).toBeNull();
		expect(names()).toEqual(['b', 'a']);
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent)
			.toBe('b');

		// 共享呈现规则所针对的那些 class（见 styles.css）：没有它们，侧边栏面板
		// 会退回到原生的文字层级。
		expect(view.contentEl.classList.contains('position-restore-nav-panel')).toBe(true);
		expect(view.contentEl.classList.contains('position-restore-nav-view')).toBe(true);
	});

	it('光标留在编辑器里：面板恢复时不抢焦点', async () => {
		const { el } = await mount([visit('a.md', NOW)], 0);
		const input = el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		// 模态框在打开时聚焦这个框，而且做得对：它是有意被打开的，打字是穿过列表
		// 最快的方式。一个随工作区被恢复的面板，不许把光标从笔记里拿走。
		expect(document.activeElement).not.toBe(input);
		// ……而它仍是一次点击之外，也是方向键走列表的起点。旁边没有任何东西这么
		// 说：以前点明这个手势的那个提示没了（app 里别处一个列表中的行都应答点
		// 击），而这个列表只认点击 —— 指针经过它什么都不改（见 RecentFilesList）。
		expect(el.querySelector('.position-restore-nav-hint')).toBeNull();
	});

	it('面板开着的时候跟随浏览历史', async () => {
		const { el, nav, names } = await mount(
			[visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1, browserPrefs(), ['c.md']);
		expect(names()).toEqual(['b', 'a']);

		// 读者在 app 里别处走到另一篇笔记：栈在面板底下生长，面板为它重画。什么都没
		// 被重新打开；整个重点是这一个仍然立着。
		nav.entries = [...nav.entries, visit('c.md', NOW + MINUTE)];
		nav.moved(2);

		expect(names()).toEqual(['c', 'b', 'a']);
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent)
			.toBe('c');
	});

	// 指针在列表上时，列表被**按住不动**（见 RecentFilesBrowser.freezeOrder /
	// RecentFilesListOptions.order）。读者正在看的东西，恰恰是重画绝不能重新摆
	// 放的那一件：一行打开了笔记然后在打开它的那只手底下移动，就是一个用洗牌应
	// 答点击的列表。
	it('正被读的顺序先按住不动，指针离开后再补上', async () => {
		const { el, nav, names, list } = await mount([
			visit('a.md', NOW - 3 * MINUTE),
			visit('b.md', NOW - 2 * MINUTE),
			visit('c.md', NOW - MINUTE),
		], 2);
		const current = () =>
			el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent;
		// 最新在前：c、b、a。
		expect(names()).toEqual(['c', 'b', 'a']);

		list().dispatchEvent(new Event('pointerover', { bubbles: true }));

		// 读者回到 a.md —— 在 app 里别处，这个面板仍然立着。一个被再次坐进去的地
		// 点会重新盖章并移到列表**末尾**（见 places.remember），所以 store 持有的
		// 顺序不再是读者正看着的顺序：a.md 现在是三者里最新的。
		nav.entries = [
			...nav.entries.filter(e => e.kind === 'view' || e.path !== 'a.md'),
			visit('a.md', NOW),
		];
		nav.moved(2);

		// 什么都没动。列表仍是他们正在读的那个，唯一变的是他们**在哪儿**：标记现在
		// 在最末那一行上，也就是 a.md 保留下来的那一行（见 RecentFilesList.fileRow）。
		expect(names()).toEqual(['c', 'b', 'a']);
		expect(current()).toBe('a');

		// 指针离开，既然没人在读它，列表就自由地就地追赶 —— 而不是等历史的下一次
		// 改动，那可能是几分钟之后。追赶意味着 store 的顺序，现在 a.md 凭自己的
		// 资格排在最前（没有任何东西把当前笔记抬到顶上）。
		list().dispatchEvent(new Event('pointerleave', { bubbles: true }));

		expect(names()).toEqual(['a', 'c', 'b']);
		expect(current()).toBe('a');
	});

	// 行上的年纪是从时钟读的，所以一个只是立在那里的面板，本来会在它点名的笔记变
	// 成一小时旧时还一直说着「5m」。修这个的定时器属于 **body**（两种外壳都经由它
	// 被销毁）—— 而一个比它所重画的面板活得久的定时器，正是这里钉住的泄漏。
	it('站着的时候刷新时间差，面板一关就停', async () => {
		vi.useFakeTimers();
		try {
			const { view, el } = await mount([visit('a.md', NOW)], 0, browserPrefs(true, 'smart', true));
			const before = el.querySelector<HTMLElement>('.position-restore-nav-row.is-file')!;
			expect(before).not.toBeNull();

			// 一次滴答：列表被重建，所以手里那个元素不再是屏幕上的那个了。
			// （jsdom 不做布局，标签自己的文字可能根本没变 —— 一次滴答欠的是重画，
			// 不是换一个词。）
			vi.advanceTimersByTime(TIME_REFRESH_MS);
			expect(el.contains(before)).toBe(false);

			// ……而这个定时器随面板一起没了：一个已关闭的视图不许继续重画一个已
			// 被拆掉的 body。
			await view.onClose();
			const after = el.querySelector<HTMLElement>('.position-restore-nav-row.is-file')!;
			vi.advanceTimersByTime(TIME_REFRESH_MS * 3);
			expect(el.contains(after)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('关闭之后就不再听历史的消息', async () => {
		const { view, nav } = await mount([visit('a.md', NOW)], 0);
		expect(nav.listenerCount).toBe(1);

		await view.onClose();
		expect(nav.listenerCount).toBe(0);
		// 关闭之后到达的一个步不许触到一个已销毁的 body（它渲染的预览持有的组件
		// 已经卸载了）。
		expect(() => nav.moved(0)).not.toThrow();
	});

	// 面板实时读它的偏好，所以立着期间改的值不需要重新接线 —— 只要一次重画。这
	// 就是设置标签页那一行和面板必须达成一致的全部（见
	// PositionManager.refreshNavPanels）：值写在写设置的地方，而每一个立着的面板
	// 都被要求把自己再画一遍。
	it('改了它据以绘制的偏好时，正在显示的列表就地重画', async () => {
		const prefs = browserPrefs(false);
		const { view, el } = await mount(
			[visit('a.md', NOW)], 0, prefs, [], browserArrows(),
			{ 'a.md': [{ heading: '定价', level: 2, line: 10 }] },
		);
		const type = (text: string): void => {
			const input = el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};

		// 开关关着：搜索只认名字、路径与其它名字，而这篇笔记没有一样叫「定价」——
		// 于是一行都不剩下。
		type('定价');
		expect(el.querySelectorAll('.position-restore-nav-row')).toHaveLength(0);

		// 读者在设置标签页里打开大纲搜索：值写在那里，而这个面板被要求重画。
		prefs.setOutline(true);
		view.refresh();

		// 面板底下的列表在同一口气里就是新的 —— 什么都没被重新打开，读者也不必等
		// 历史走动。那一节现在有它自己的一行。
		expect(el.querySelectorAll('.position-restore-nav-row.is-heading')).toHaveLength(1);
	});

	// 抽屉是一个**形状**，不是一个 class：`this.leaf.parent` 是 app 放在那里的任何
	// 东西，而类型声明里的 WorkspaceMobileDrawer 不一定是 app 运行时模块导出的东
	// 西 —— 对一个缺失的名字做 `instanceof` 会抛，而（在这次前往之前）这让面板在
	// 手机上对任何点击都不应答。
	const drawer = () => {
		const d = {
			collapsed: false,
			collapse(): void { d.collapsed = true; },
		};
		return d;
	};

	it('手机上做前进后退时把抽屉收起来，好让被打开的那篇看得见', async () => {
		// 手机上常驻面板**就是**盖住整屏的一个抽屉：一行在它背后打开一篇笔记，看
		// 起来就像一行什么都没做。面板自己仍留在布局里 —— 折叠不是关闭，而把它放
		// 在哪儿是读者的事。
		const { el, nav, view } = await mount(
			[visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1);
		const pane = drawer();
		(view.leaf as unknown as { parent?: unknown }).parent = pane;
		const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

		// 桌面端 leaf 的父节点是一个标签页组，不是抽屉：什么都不动，因为面板已经
		// 立在笔记旁边了。
		click(note());
		expect(pane.collapsed).toBe(false);
		expect(nav.jumped).toHaveLength(1);

		const wasMobile = Platform.isMobile;
		Platform.isMobile = true;
		try {
			click(note());
			expect(pane.collapsed).toBe(true);
		} finally {
			Platform.isMobile = wasMobile;
		}
		expect(nav.jumped).toHaveLength(2);
	});

	it('先把弹起的菜单撤下屏幕，再收抽屉', async () => {
		// 菜单立在**文档**上，不在这个面板的元素里，而且它是 app 的：app 把菜单从
		// 屏幕上拿走的条件是在它外面点一下、在上面选中一项、或者 Escape。折叠抽屉
		// 哪个都不是，所以一个给读者让路面板得把自己的菜单一起带走（见
		// RecentFilesBrowser.closeMenu）。
		const wasMobile = Platform.isMobile;
		// ……而行的菜单控件是**手机**的（见 RecentFilesList.menuControl），它在面板
		// 挂载期间被决定。
		Platform.isMobile = true;
		try {
			const { el, trigger, view } = await mount(
				[visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 1);
			const pane = drawer();
			(view.leaf as unknown as { parent?: unknown }).parent = pane;
			const click = (on: HTMLElement) =>
				on.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const row = Array
				.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
				.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

			click(row.querySelector<HTMLElement>('.nav-row-menu')!);
			const menu = trigger.mock.calls[0][1] as { hidden: boolean };
			expect(menu.hidden).toBe(false);

			// ……然后读者前往，抽屉就折叠了。
			click(row);

			expect(pane.collapsed).toBe(true);
			expect(menu.hidden).toBe(true);
		} finally {
			Platform.isMobile = wasMobile;
		}
	});

	it('外壳的响应抛了错，前进后退照样走', async () => {
		// 读者要求去某处；外壳自己的反应（一个对话框关闭、一个抽屉折叠）是外壳的
		// 事。一个抛了的反应让他们付出的必须是这个反应，不是这趟行程 —— 这个测试
		// 所针对的故障模式，是一个每次点击都什么都不做的移动端面板。
		const { el, nav, view } = await mount(
			[visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1);
		(view.leaf as unknown as { parent?: unknown }).parent = {
			collapsed: false,
			collapse(): void { throw new Error('no drawer'); },
		};
		const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const note = () => Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

		const wasMobile = Platform.isMobile;
		Platform.isMobile = true;
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			click(note());
		} finally {
			Platform.isMobile = wasMobile;
			logged.mockRestore();
		}

		expect(nav.jumped).toHaveLength(1);
	});

	// 一次前往在它让本面板所在的抽屉开始滑出屏幕的同一刻重排列表：刚坐进去的地
	// 点成了最新的，于是读者瞄准的那一行爬到一个正在退场的列表顶端，
	// 「你在这里」的标记跟着一起。反正面板正在离开 —— 它欠读者的是一份下次拉开
	// 抽屉时为真的列表，中间什么都不欠（见 RecentFilesView.standAside）。
	it('面板离场期间按住列表不重画，等它走了再补', async () => {
		vi.useFakeTimers();
		try {
			const { el, nav, view, names } = await mount(
				[visit('a.md', NOW - 2 * MINUTE), visit('b.md', NOW - MINUTE), visit('c.md', NOW)], 2);
			const pane = drawer();
			(view.leaf as unknown as { parent?: unknown }).parent = pane;
			const click = (row: HTMLElement) =>
				row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const note = () => Array
				.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
				.find(r => r.querySelector('.nav-row-name')?.textContent === 'b')!;
			// 最新在前，而 c 是读者正站着的笔记。
			expect(names()).toEqual(['c', 'b', 'a']);

			const wasMobile = Platform.isMobile;
			Platform.isMobile = true;
			try {
				click(note());
			} finally {
				Platform.isMobile = wasMobile;
			}

			// 抽屉正在退场，而前往已经落地 —— 读者仍看着的列表没有动。若重画过，
			// b 早就在顶端了。
			expect(pane.collapsed).toBe(true);
			expect(nav.jumped).toEqual([1]);
			expect(names()).toEqual(['c', 'b', 'a']);

			// ……而面板一离开视野，它就**一次**重画追上：b 现在是那处最新的地点。
			vi.advanceTimersByTime(PANEL_EXIT_GRACE_MS);
			expect(names()).toEqual(['b', 'a']);
		} finally {
			vi.useRealTimers();
		}
	});

	// 一个面板可以在它压着一次重画时被关掉 —— 读者在同一几百毫秒里把抽屉划走，
	// 或者关上窗格。那时也什么都不欠：追赶随它所为之而压的那个面板一起死掉，而不
	// 是画进一个已被拆掉的 body。
	it('半路上就把面板关掉时，压着的那次重画直接丢掉', async () => {
		vi.useFakeTimers();
		try {
			const { el, view } = await mount([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1);
			(view.leaf as unknown as { parent?: unknown }).parent = drawer();
			const click = (row: HTMLElement) =>
				row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			const note = () => Array
				.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
				.find(r => r.querySelector('.nav-row-name')?.textContent === 'a')!;

			const wasMobile = Platform.isMobile;
			Platform.isMobile = true;
			try {
				click(note());
			} finally {
				Platform.isMobile = wasMobile;
			}
			await view.onClose();
			const row = el.querySelector('.position-restore-nav-row')!;

			vi.advanceTimersByTime(PANEL_EXIT_GRACE_MS);

			// 定时器随面板一起走了：若它触发过，列表就会被重建，而这个元素就不再
			// 是立在窗格里的那个了。
			expect(el.contains(row)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	// 桌面端这些都不适用，而这就是这里钉住的：面板留在原地，所以重排是**应答**
	// 而不是干扰 —— 读者去的那篇笔记拿走顶行和标记。一个立在众人眼前的面板，不许
	// 比它所展示的历史晚一步。
	it('面板原地不动时就地重画', async () => {
		const { el, names } = await mount(
			[visit('a.md', NOW - 2 * MINUTE), visit('b.md', NOW - MINUTE), visit('c.md', NOW)], 2);
		const click = (row: HTMLElement) =>
			row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const note = () => Array
			.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === 'b')!;
		expect(names()).toEqual(['c', 'b', 'a']);

		click(note());

		// 与这次前往在同一口气里画出：没有定时器，什么都没被压住。
		expect(names()).toEqual(['b', 'a']);
	});

	// **那四个箭头**，以及只有**常驻**的面板才展示得出的那一点：一个步是异步的
	// —— 它打开一篇笔记并等它 —— 所以这四个是在它**落地**之后再问，而不是在它
	// 底下问。当场问的话，一次在途的遍历会答「两边都没有步」，两个箭头就会一直
	// 灰着，就这样两个活按钮看起来像两个坏的。
	it('箭头动作落地之后才重问那四个按钮，不是在执行途中', async () => {
		const { el, arrows } = await mount([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1);
		const [back, forward] = Array.from(
			el.querySelectorAll<HTMLButtonElement>('.position-restore-nav-arrow'));
		expect([back.disabled, forward.disabled]).toEqual([false, false]);

		arrows.hold();
		back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// 这个步还敞着：应答在它底下变了，而什么都没被重新问 —— 所以也什么都没从
		// 它画出来。
		arrows.set({ back: false });
		await Promise.resolve();
		expect(back.disabled).toBe(false);

		arrows.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(back.disabled).toBe(true);
		expect(forward.disabled).toBe(false);
	});
});

describe('RecentFilesView —— 指针只由点击驱动', () => {
	// 三篇笔记、**三行**：一份列表不为同一篇笔记画两行（见 groupByFile）。列表按
	// **最新在前**排，所以读者此刻所在的 c.md 在最前。
	const stack = () => [
		visit('a.md', NOW - 2 * MINUTE),
		visit('b.md', NOW - MINUTE),
		visit('c.md', NOW),
	] as NavEntry[];

	// 读者**搜**到的那些小节（见 list.ts 的 HeadingHit）：a.md 里有一个叫「定价」的。
	const heads = { 'a.md': [{ heading: '定价', level: 2, line: 10 }] };

	const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// **右键**，以及手指的持久按压（同一个事件、带左键的编号）：两者都不打开任何
	// 东西（见 RecentFilesList.onContextMenu）。
	const rightClick = (el: HTMLElement) => el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
	);
	const noteRow = (el: HTMLElement, name: string) =>
		Array.from(el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'))
			.find(r => r.querySelector('.nav-row-name')?.textContent === name)!;
	// 往搜索框里打字：框里的文本**就是**列表的查询，所以每敲一次键列表就被重画。
	const type = (el: HTMLElement, text: string): void => {
		const input = el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	};

	// 修饰键是 app 的应答，而上一个用例设过的那个会决定这一个（见 Keymap）。
	beforeEach(() => {
		KeymapKnobs.reset();
	});

	it('悬停不选中任何东西：只有点击才算手势', async () => {
		const { el } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a');

		// 面板打开时什么都没被选中（见 RecentFilesList.choose：一个位置是一个 key
		// 或一次点击，而一次点击会行进）。
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// 鼠标仅仅经过这些行不算一个选择。这是列表所据以建立的规则（见
		// RecentFilesList）：一个在路过的鼠标底下突然一动一动的列表，会选中一行
		// 没人选过的行。
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 40 }));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();

		// ……键盘自己的位置也不会被它夺走：↓ 走，而指针经过它走到的地方时会把它
		// 留在原地。
		el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).not.toBeNull();
		note().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 12 }));
		expect(el.querySelector('.position-restore-nav-row.is-selected')).not.toBeNull();
	});

	it('搜到的那些小节各自成为一行，没搜到就一行都不画', async () => {
		const { el } = await mount(stack(), 2, browserPrefs(), [], browserArrows(), heads);

		// 没有查询就没有「搜到的东西」：这三行只是笔记。
		expect(el.querySelectorAll('.position-restore-nav-row.is-heading')).toHaveLength(0);

		type(el, '定价');

		// 只有 a.md 留了下来，而它搜到的那一节挂在它下面 —— 一节一行，且只有那一篇
		// 有（见 listing.ts 的 matchedHeadings）。
		expect(el.querySelectorAll('.position-restore-nav-row.is-file')).toHaveLength(1);
		expect(el.querySelector('.position-restore-nav-row.is-heading .nav-row-heading')?.textContent)
			.toBe('定价');
	});

	it('app 要求开新标签页时就开新标签页，面板保持不倒', async () => {
		// 修饰键是 **app** 的应答（见 Keymap.isModEvent），而面板自己的契约不随它
		// 变：一个常驻面板应答点击的方式是去某处，而它之后仍在那里 —— 笔记在它旁
		// 边打开，读者在列表里的位置被清掉而不是带过去（见
		// RecentFilesList.collapse）。
		const { el, nav } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a');
		KeymapKnobs.modEvent = 'tab';

		click(note());

		expect(nav.jumped).toEqual([0]);
		expect(nav.targets).toEqual(['tab']);
		expect(el.querySelector('.position-restore-nav-list')).not.toBeNull();
		expect(nav.listenerCount).toBe(1);
	});

	it('点一下行本身就打开这个文件', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = () => noteRow(el, 'a');

		// 行**就是**导航 —— 导航器就是干这个的，而名字就是目标。已经知道要去哪儿
		// 的读者只花**一次**点击。
		click(note());

		// 它打开那一行所代表的那篇笔记 —— 与在文件浏览器里点它完全一样，落在哪儿
		// 由位置数据库答（见 RecentFilesList.activeRep）。而且没有留下一行被选中：
		// 一次点击会行进。
		expect(nav.jumped).toEqual([0]);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
	});

	it('大纲行按它自己那一节前往，而不是那篇笔记的开头', async () => {
		const { el, nav } = await mount(stack(), 2, browserPrefs(), [], browserArrows(), heads);
		type(el, '定价');
		const row = el.querySelector<HTMLElement>('.position-restore-nav-row.is-heading')!;

		click(row);

		// 那一节自己带着去哪儿：它**此刻**在第 11 行（0-based 10，现查）。它不走
		// 一条记录 —— 那一节不是列表上的一个地点 —— 所以 `jumped` 一个都没有，而
		// 常驻面板仍立着。
		expect(nav.headed).toEqual(
			[{ path: 'a.md', heading: '定价', line: 10, target: undefined }],
		);
		expect(nav.jumped).toEqual([]);
		expect(el.querySelector('.position-restore-nav-list')).not.toBeNull();
		expect(nav.listenerCount).toBe(1);
	});

	it('右键什么也不打开', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = noteRow(el, 'a');

		rightClick(note);

		// 右键不再行进：一行靠点击它打开，而第二个打开同一件东西的按钮是一个学了
		// 也白学的手势（见 RecentFilesList.onContextMenu）。
		expect(nav.jumped).toEqual([]);
	});

	it('只是按住没有点实，就当它没发生', async () => {
		const { el, nav } = await mount(stack(), 2);
		const note = noteRow(el, 'a');

		// WebView 为一次长按触发的是同一个事件，上面带的是**左**键：什么都不打开
		// （见 RecentFilesList.onContextMenu）。正是它让平板上一次慢速点按文件名
		// 看起来像一次 jump。
		const held = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
		note.dispatchEvent(held);

		expect(nav.jumped).toEqual([]);
		// 仍然照样被拒：一行不提供菜单、不提供气泡、不提供选中 —— 一次持久按压在
		// 这里就是什么都不做。
		expect(held.defaultPrevented).toBe(true);
	});

	// 这次前往**重写**了历史：被坐进去的那篇笔记成了最新的一条，于是各行被重建。
	// 一个跨过这次重写保留下来的位置，会站在滑进它那个槽位的任何东西上 —— 那正是
	// 它必须被折叠掉的原因。这就是那份列表，以及它守着的回归。
	it('下一次列表从新历史起算，而没有一个位置被留给占着那个槽位的行', async () => {
		const entries = [
			visit('a.md', NOW - 3 * MINUTE),
			visit('b.md', NOW - 2 * MINUTE),
			visit('c.md', NOW - MINUTE),
			visit('d.md', NOW),
		] as NavEntry[];
		// 列表现在的样子：d（当前）在最前，然后 c、b、a。
		const { el, nav, names } = await mount(entries, 3);
		expect(names()).toEqual(['d', 'c', 'b', 'a']);

		// 键盘先停在 c 那一行上（↓ 两次）：位置属于**那一行**，而列表就要在它下面
		// 被重写。
		const input = el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(el.querySelector('.position-restore-nav-row.is-selected .nav-row-name')?.textContent)
			.toBe('c');

		click(noteRow(el, 'c'));

		expect(nav.jumped).toEqual([2]);
		// 前往到的那篇笔记现在是当前那一篇 —— 而既然它是刚被坐进去的地方，它就是
		// 最新的，所以它的行是列表的第一行……
		expect(el.querySelector('.position-restore-nav-row.is-current .nav-row-name')?.textContent).toBe('c');
		// ……而历史在面板底下被重写了：无论怎样，列表都是从它现在的样子画出的；
		// 折叠换来的是没有任何东西被**指着**（见 RecentFilesList.collapse）。
		expect(names()).toEqual(['c', 'b', 'a']);
		expect(el.querySelector('.position-restore-nav-row.is-selected')).toBeNull();
	});
});

// **标签页**自己的菜单：app 为标签页上的右键抬起它并交给视图去填（见
// RecentFilesView.onPaneMenu），所以面板欠的是一个**条目**而不是它自己的一面 ——
// 而它加的那一个条目是关于**列表**的，而 app 放在那里的每一样都是关于**窗格**
// 的。
//
// app 交出的菜单是 app 自己的类；测试能从上面读条目的是桩的，两者在一次 cast 里
// 相遇，就像本文件别处那样（见 mount 里的 `nav as never`）。
const menuFor = (view: RecentFilesView) => {
	const menu = new Menu();
	view.onPaneMenu(menu as never);
	return menu;
};

describe('RecentFilesView —— 标签页自己的菜单', () => {
	it('提供清空整个列表的菜单项，置顶区不受影响', async () => {
		// 列表按 store 持有它的样子 —— **最旧在前**，真实历史被建起来的顺序（见
		// NavPlaces.remember）—— 以及按面板绘制它的样子：钉住的那一块之下，最新
		// 在前。
		const { view, el, nav, names } = await mount([
			visit('c.md', NOW - 2 * MINUTE),
			visit('b.md', NOW - MINUTE),
			visit('a.md', NOW),
		], 2);
		nav.pin('a.md');
		expect(names()).toEqual(['a', 'b', 'c']);

		const menu = menuFor(view);

		expect(menu.items).toHaveLength(1);
		expect(menu.items[0].title).toBe(t('recentFiles.clearList'));
		// 'action' 是 app 把视图自己的条目排在自己的之前的地方（见 body.ts 的
		// contextRow）。
		expect(menu.items[0].section).toBe('action');

		// 选中之后：列表**靠自己**记住的每一样都去掉 —— b 和 c —— 而钉住的那个留
		// 着。面板是通过它的订阅听到的，而不是被要求：常驻面板按列表现在的样子画
		// （见 hearPlaces）。
		menu.items[0].click?.();

		expect(names()).toEqual(['a']);
		expect(el.querySelectorAll('.position-restore-nav-row')).toHaveLength(1);
	});

	it('清了也一个不少时，不提供清空项', async () => {
		// 一个清空不了任何东西的条目，比一个不在那里的条目更糟（见 body.ts 的
		// pinItems），而一份只有钉住项的列表，本来就已经是清空会留下的东西了。
		const { view, nav } = await mount([visit('a.md', NOW)], 0);
		nav.pin('a.md');

		expect(menuFor(view).items).toEqual([]);
	});

	it('列表一条都没有时不提供清空项', async () => {
		// 一个在读者还没去过任何地方之前就打开的面板：菜单是 app 的，而这个面板不
		// 往上面放任何东西。
		const { view } = await mount([], -1);

		expect(menuFor(view).items).toEqual([]);
	});
});

describe('activateRecentFilesView', () => {
	it('面板已经开着就把它唤回来，而不是再开一个', async () => {
		const leaf = new WorkspaceLeaf();
		const revealLeaf = vi.fn(async () => {});
		const getRightLeaf = vi.fn();
		const app = {
			workspace: {
				getLeavesOfType: (type: string) => (type === RECENT_FILES_VIEW_TYPE ? [leaf] : []),
				revealLeaf,
				getRightLeaf,
			},
		};

		await activateRecentFilesView(app as never, new FakeNav() as never, undefined, browserPrefs());

		expect(revealLeaf).toHaveBeenCalledWith(leaf);
		// 同一份历史的两个面板，各有自己的过滤器和自己打开的笔记，是一种被展示同
		// 一个问题两个不同答案的方式。
		expect(getRightLeaf).not.toHaveBeenCalled();
	});

	it('还没有面板时在右侧栏打开', async () => {
		// 桩的 leaf 带着最后一次 setViewState 所收到的 `state`；app 自己的类型声明
		// 没有声明它（见 obsidian-stub.ts）。
		const leaf = new WorkspaceLeaf() as WorkspaceLeaf & { state: unknown };
		const revealLeaf = vi.fn(async () => {});
		const app = {
			workspace: {
				getLeavesOfType: () => [],
				revealLeaf,
				getRightLeaf: () => leaf,
			},
		};

		await activateRecentFilesView(app as never, new FakeNav() as never, undefined, browserPrefs());

		expect(leaf.state).toEqual({ type: RECENT_FILES_VIEW_TYPE, active: true });
		expect(revealLeaf).toHaveBeenCalledWith(leaf);
	});
});
