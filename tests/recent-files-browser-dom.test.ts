// 最近文件浏览器交互语义的 DOM 级测试 —— 那些读者光读一个纯函数验证不了的部分：
// 一个光秃秃的回车做什么、哪些行压根可选、描述一行的那个落点面板，以及那个如今
// 是工具条唯一控件的搜索框。
// 纯的那些部分（describe/group/merge/filter/time）由 recent-files-browser.test.ts 覆盖。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keymap, MarkdownView, Platform, TFile } from 'obsidian';
// ……以及菜单那个替身本身，它走自己的路径而不是经由 'obsidian'，因为测试读的那本
// 登记簿（Menu.shown）是桩的、不是 app 的（见 support/obsidian-stub）。
import { Menu } from './support/obsidian-stub';
import type { HoverParent } from 'obsidian';

import { RecentFilesModal } from '@/recent-files/browser/modal';
import type {
	RecentFilesBrowserArrows,
	RecentFilesBrowserPrefs,
} from '@/recent-files/browser/body';
import type { EphemeralState, PathDisplayMode, PreviewFocusMode } from '@/types';
import { navGroupKey, type NavEntry } from '@/nav/entry';
import { ageLabel } from '@/recent-files/browser/model';
import { DEFAULT_SETTINGS } from '@/types';
import type { NavEntryState } from '@/types';
import { t } from '@/i18n';
import {
	LATE_READ_REDRAW_MS,
	LONG_PRESS_MS,
	NAV_SOURCE_ID,
	PANEL_EXIT_GRACE_MS,
	ROW_PRESS_HOLD_MAX_MS,
	ROW_PRESS_MARK_MS,
	TIP_DELAY_MS,
} from '@/recent-files/browser/constants';

// jsdom 没有 PointerEvent，而 `pointerType` 是面板用来分辨鼠标与手指的那一个字段：
// 用一个 MouseEvent 顶替它，种类随后写上去。凡是必须说出「是哪一种指针」的套件都共用
// 它，因为面板对这两者**故意**给不同的答案（见 body.ts 的悬停规则、
// RecentFilesList.hoverAt 与 tip.ts）：鼠标悬停是鼠标在读，手指则将要点击。
// ……以及它在**哪儿**，这是面板所读的另一半：只有当指针**移动过**，它才会向 app 要
// 一页，所以在同一处的两个事件是一只手没动过（面板在它底下冒出来），而测试没有指定
// 位置的事件被放到一个新地方。`held` 说这只手**没有**动 —— 那是面板必须与「移动」
// 区分开来的唯一情形（见 RecentFilesList.hoverAt）。
let cursor = { x: 0, y: 0 };
const pointer = (type: string, kind: 'mouse' | 'touch' = 'mouse', held = false) => {
	if (!held)
		cursor = { x: cursor.x + 17, y: cursor.y + 11 };
	const ev = new MouseEvent(type, { bubbles: true, clientX: cursor.x, clientY: cursor.y });
	Object.defineProperty(ev, 'pointerType', { value: kind });
	return ev;
};
// 读者**移动到**一行上：指针本来在别处 —— 列表边缘、另一行、手原来在哪就是哪 ——
// 现在落在这个元素上。两个事件，因为面板听到的是那次**移动**而不是到达：第一个是
// 面板最初看见的那个指针（在一只没有动过的手底下冒出来，什么也不问），第二个是那只手
// 移到这一行上。
const movedOnto = (el: HTMLElement, kind: 'mouse' | 'touch' = 'mouse') => {
	el.dispatchEvent(pointer('pointermove', kind));
	el.dispatchEvent(pointer('pointermove', kind));
};

// jsdom 根本不实现 layout，所以这是**缺**的，不是**坏**的。
Element.prototype.scrollIntoView = () => {};

// 在本套件**运行时**，'obsidian' 解析到 tests/support/obsidian-stub.ts（见
// vitest.config.mts），但 tsc 从真正那个只有类型的包里读它的类型 —— 那个包只声明了
// 插件要问的两个问题（isModEvent / isModifier），别的一概没有。桩的答案是测试设定的
// **输入**，所以通过一次诚实的类型断言抵达它们，而不是假扮到 app 自己的类上。
const KeymapKnobs = Keymap as unknown as {
	reset(): void;
	modEvent: unknown;
	modifier: boolean;
};

const MINUTE = 60_000;
const NOW = Date.now();

// 为一个 harness 准备的一套偏好（有时是两套，当测试想展示在设置页做出的选择就是下一个
// 对话框打开时所遵照的选择）。面板只**读**它们（见 RecentFilesBrowserPrefs）—— 那些值
// 是插件的，改它们的是设置页 —— 所以这个 fixture 是一组对测试可写的值的**实时读者**，
// 正如设置页写它们那样。
function prefs(start: {
	// 搜索框是否把各篇笔记的小节标题也算进搜索面 —— 也就是是否把搜到的小节画成
	// 它自己的一行（见 list.ts 的 headingRow）。
	outline?: boolean;
	path?: PathDisplayMode;
	time?: boolean;
	// 行拿去当作笔记名打印的那个 frontmatter 属性，没有就是空
	// （见 PluginSettings.recentFilesTitleProperty）。
	title?: string;
	// 悬停预览把笔记开在哪儿（见 PreviewFocusMode）。'head' 是这个 fixture 自己的默认，
	// 因为它也是 app 的默认 —— 想让笔记开在某一行上的测试自己要求，这也是下面四个断言
	// 「点出了某一行」的测试的诚实读法。
	focus?: PreviewFocusMode;
} = {}) {
	const state = {
		outline: true,
		cap: 200,
		path: 'smart' as PathDisplayMode,
		time: false,
		title: '',
		focus: 'head' as PreviewFocusMode,
		...start,
	};
	return {
		state,
		browser: {
			outlineSearch: () => state.outline,
			// 列表往回够多远（见 PluginSettings.recentFilesCap）。
			placesCap: () => state.cap,
			// 一行的路径印出多少，以及印在名字的哪一侧（见 PathDisplayMode）。
			pathDisplay: () => state.path,
			// 每一行是否带时间（见 RecentFilesBrowserPrefs.rowTime）。
			rowTime: () => state.time,
			// 行怎么称呼这篇笔记（见 reads.ts 的 titleOf）：想让某一行叫 `title` 的测试把
			// 它传在这里，并放进那些文件的缓存里。
			titleProperty: () => state.title,
			// 悬停把笔记开在哪儿（见 PreviewFocusMode）：这里没有任何东西从它画出来，
			// 所以测试是按每一次悬停传它，而不是按面板传。
			previewFocus: () => state.focus,
		} satisfies RecentFilesBrowserPrefs,
	};
}

// 测试什么都不说时 harness 拿到的那套普通值：一篇笔记一行，详情那一列打开（见 prefs）。
function defaultPrefs(): RecentFilesBrowserPrefs {
	return prefs().browser;
}

// 那四个箭头，按插件把它们交给一个 shell 的样子（见 RecentFilesBrowserArrows）：那几个
// 动作是插件的命令，所以测试想从它们身上要的是「按下了**哪一个**」—— 而 body 据以把它
// 们置灰的那些答案是测试设定的输入，正如上面那些偏好一样。（一个动作可以是异步的 ——
// 一步会打开一篇笔记并等它 —— 而面板在它落定后会再问一遍那四个；那段时序归侧边栏套件
// 覆盖，因为对话框在按下时就关了。）
function defaultArrows(): RecentFilesBrowserArrows & {
	pressed: string[];
	set(on: Partial<{ back: boolean; forward: boolean; edge: boolean }>): void;
} {
	const state = { back: true, forward: true, edge: true };
	const pressed: string[] = [];
	const press = (act: string) => () => {
		pressed.push(act);
	};
	return {
		back: press('back'),
		forward: press('forward'),
		top: press('top'),
		bottom: press('bottom'),
		canBack: () => state.back,
		canForward: () => state.forward,
		canEdge: () => state.edge,
		pressed,
		set(on) {
			Object.assign(state, on);
		},
	};
}

// 最近文件列表的一行，按 store 真正持有的那**一种**形状（见 places.ts）：读者去过一篇
// 笔记 —— 一个 **visit**。带位置的那一步（一次 **jump**）从不进这份列表：它在前进/后退
// 栈里，而在这里被降级成一次访问。带位置的文件记录是列表从不持有的形状（位置库拥有
// 「我把这个文件留在哪儿」）。
const visit = (path: string, stamp: number): NavEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp });

// 一次采集，按插件如今记录的样子：落点自己的位置，加视口顶那一行的锚点
// （见 NavEntryState）。它曾多带一件事——落点**下面**的那些**非空**行
// （`st.context`），镜像 capture/ephemeral.ts 里的 contextBelow；2026-10-03 与它的搜索面
// 一起撤掉了，于是这个 fixture 少掉那一半，而**位置与锚点**是生产形状。
function captured(doc: string[], landing: number): NavEntryState {
	return {
		scroll: landing,
		anchor: doc[landing].trim(),
	};
}

// 下面那个 fixture 笔记的解析后标题，按 metadata cache 交出它们的形状（层级从 1 起、
// 位置是文件里的位置）。
const A_DOC = '# 面板设计\n\n## 呈现方案\n\n### 预览\n\n预览条：悬停显示上下文三行\n\n尾巴\n';
const A_HEADINGS = {
	'a.md': [
		{ heading: '面板设计', level: 1, position: { start: { line: 0 } } },
		{ heading: '呈现方案', level: 2, position: { start: { line: 2 } } },
		{ heading: '预览', level: 3, position: { start: { line: 4 } } },
	],
};

// 一篇足够长的笔记，长到它的**小节**可以散在相隔很远的行上。填充文字的作用就是把第二节
// 推到笔记足够靠下的地方，好让「两个标题只隔三行」的 fixture 与「两个标题隔着一整节」的
// fixture 说的仍是不同的事 —— 而一篇笔记被搜到的小节各画一行（见 list.ts 的 headingRow），
// 所以它们各自的**行号**也隔得够远，不会被读成同一处。
const SPREAD_LINES = Array.from({ length: 24 }, (_, i) => `正文第 ${i + 1} 行`);
const SPREAD_DOC = [
	'# 面板设计', '', '## 呈现方案', '', '### 预览', '',
	'预览条：悬停显示上下文三行', '',
	...SPREAD_LINES, '',
	'## 尾巴', '', '最后一段', '',
];
const SPREAD_HEADINGS = {
	'a.md': [
		{ heading: '面板设计', level: 1, position: { start: { line: 0 } } },
		{ heading: '呈现方案', level: 2, position: { start: { line: 2 } } },
		{ heading: '预览', level: 3, position: { start: { line: 4 } } },
		{ heading: '尾巴', level: 2, position: { start: { line: 33 } } },
	],
};

function harness(
	entries: NavEntry[],
	index: number,
	// vault，按那个假 app 报告的样子。如今只问它**在不在** —— 这里没有的路径就是列表
	// 不会画的地点 —— 因为浏览器根本不读文件（见 RecentFilesReads）。文本留着是给那个假
	// 的 `cachedRead` 的，而没人调它。
	files: Record<string, string> = {},
	// fixture 想要**记了却没了**的那些路径：历史里的一个地点，而 vault 已经没有它的文件
	// 了（见「已经没了的文件」那个套件）。它压过 `files`，所以测试可以说「它本来在那里，
	// 现在不在了」。
	deleted: string[] = [],
	// 在编辑器里开着的那些路径。面板的**行**是从 entries 画的、别的什么都不取自，而一行
	// 的行号是位置数据库对这篇笔记的回答（见 reads.ts 的 savedPosition）—— 这个假 app 仍
	// 通过 `getLeavesOfType` 交出那些标签页，因为列表在别处要数它们，而那些想要一篇**开着**
	// 的笔记的测试就在这里说。那不必与 `files` 为该路径持有的文本相同。
	live: Record<string, string> = {},
	// 每个路径的解析后标题，按 metadataCache 会报告的样子
	headingMap: Record<string, unknown[] | Record<string, unknown>> = {},
	// 触屏设备。列表两种情况下都应答点击（见 RecentFilesList），所以这个标志在这里决定的
	// 是**呈现** —— jsdom 没有 matchMedia 可问，所以触屏设备就是内联那一种（见
	// RecentFilesModal.inline）—— 外加触屏的那些人体工学：手指下 × 的点击目标、以及让
	// 过滤框不被聚焦。
	mobile = false,
	// 上面那些文件的 mtime，按 vault 现在会报告的样子：浏览器拿它们与 entry 记下的 mtime
	// 相比。
	mtimes: Record<string, number> = {},
	// 浏览器自己的偏好，按插件把它们交给一个外壳的样子（见 RecentFilesBrowserPrefs）。
	// 想让对话框带着「每个落点都印出来」打开的测试在这里传自己那一套 —— 同一个对象传两次，
	// 以表明这个选择不是对话框的 —— 而默认是每个 harness 一套全新的，这样测试之间没法通过
	// 设置文件把偏好泄给彼此。
	browserPrefs: RecentFilesBrowserPrefs = defaultPrefs(),
	// 位置库对一篇笔记的答案（见 RecentFilesBrowserOptions.savedPosition）：普通打开落在
	// 哪一行，也就是这篇笔记**自己**那一行向预览要的那一行。默认 undefined，且是刻意的 ——
	// 没有它的 fixture 就是一个每篇笔记都没有落点的面板，而本套件大半讲的就是这个。
	saved: (path: string) => EphemeralState | undefined = () => undefined,
	// 读者**钉住**的那些行，按 store 交出它们的样子（见 NavPlaces.pinned）：group key，
	// 按读者自己的次序。这个数组会交回给测试，所以测试可以照菜单那样钉住一行，然后请面板
	// 重画（见 `changed`）。
	pinned: string[] = [],
	// 那四个箭头，以及这个外壳画不画它们：参数里的**最后一个**，这样上面的套件照旧说着它
	// 一直说的话。每个 harness 一套全新的，理由同那些偏好。
	arrows: ReturnType<typeof defaultArrows> = defaultArrows(),
) {
	// 地点列表的行进：面板交给它一个地点下标，由列表决定怎么去那儿（文件按普通方式打开，
	// jump 则落地 —— 见 places.ts）。这个 spy 保留它原来的名字，好让下面每一条断言读起来
	// 仍是它一直在问的：「这就是那一行把读者带到的地方」。
	const jumpTo = vi.fn(async () => {});
	// ……以及**改道**的那一次行进：面板交给它的不是列表上的一个地点，而是那一节自己的
	// 名字、它此刻的行号、以及这一行一贯去往的那个标签页（见 list.ts 的 HeadingHit）
	// —— 那一节此刻还没有记录，这次行走会为它造出一条。单独一个 spy，因为「去了哪个
	// 地点」与「去了哪个小节」是两个不同的问题。
	const jumpToHeading = vi.fn(async () => {});
	const cachedRead = vi.fn(async (file: { path: string }) => files[file.path] ?? '');
	// 主根分栏，里面每个 leaf 一个元素。如今没有东西再遍历它 —— 那个说出是哪个活标签页
	// 持有落点的徽标已经没了 —— 但那些 leaf 仍是下面那些编辑器立足的地方，所以假 app 保留
	// 它一直有的那个形状。
	const rootEl = document.createElement('div');
	document.body.appendChild(rootEl);
	// 这个 harness 应答过的那些元数据读取，以及一个 `changed` 事件会抵达的那些监听者
	// （见下面那个假的 metadataCache）。
	let cacheReads = 0;
	const metaListeners = new Set<(file: { path: string }) => void>();
	// vault 的文件事件，以及谁在听它们：一行的笔记存不存在是**绘制时** vault 的答案，而
	// 这个答案变了并不自带重画 —— 一次同步会把一篇笔记拿走再放回来（见 body.ts 的
	// watchExistence）。
	const vaultListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
	const tabs = Object.keys(live).map((path) => ({ leafId: `open:${path}`, path }));
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (deleted.includes(path) || !(path in files))
					return null;
				const file = Object.assign(new TFile(), { path });
				// 一个 stat，每个 TFile 都有的那个：从文件自己的文本里读出的节链，就是对着
				// 这个 mtime 记住的（见 reads.ts）。
				file.stat = { ctime: 0, mtime: mtimes[path] ?? 0, size: 0 };
				return file;
			},
			cachedRead,
			// `on` 把回调本身当作 `offref` 要的把手交回来，而浏览器对它做的就这么多。
			on: (name: string, cb: (...args: unknown[]) => void) => {
				(vaultListeners[name] ??= []).push(cb);
				return cb;
			},
			offref: (ref: unknown) => {
				for (const cbs of Object.values(vaultListeners)) {
					const at = cbs.indexOf(ref as (...args: unknown[]) => void);
					if (at >= 0)
						cbs.splice(at, 1);
				}
			},
		},
		metadataCache: {
			// 一个路径要么映射到它解析后的标题（常见情形），要么映射到整条 cache 记录 ——
			// 给那些需要 frontmatter 范围的测试用，抽屉靠它把一个块挡在 properties
			// 之外 —— 以及，既然浏览器也会搜一个文件的别名，还给它 frontmatter 本身。
			//
			// 这些读取是**计数**的：浏览器为一个 body 的一生按 path 记一条记录（见
			// RecentFilesReads），而这个计数就是测试看出这份记忆在干活的方式。
			getFileCache: (file: { path: string }) => {
				cacheReads++;
				const cache = headingMap[file.path];
				if (!cache)
					return null;
				return Array.isArray(cache) ? { headings: cache } : cache;
			},
			// 浏览器唯一听的那个 metadataCache 事件（见 RecentFilesReads）：一个文件的
			// frontmatter 变了，所以它的记录 —— 以及随之而来的别名 —— 过期了。`on` 把回调
			// 本身当作 `offref` 要的把手交回来，而浏览器对它做的就这么多。
			on: (name: string, cb: (file: { path: string }) => void) => {
				if (name === 'changed')
					metaListeners.add(cb);
				return cb;
			},
			offref: (ref: unknown) => {
				metaListeners.delete(ref as (file: { path: string }) => void);
			},
		},
		workspace: {
			rootSplit: { containerEl: rootEl },
			// app 自己的菜单事件：浏览器请 **app** 去填这个菜单（见
			// RecentFilesBrowser.contextRow），所以测试能看见的就是它被交到的那个 menu
			// 对象 —— 那正是这个插件贡献的全部。
			trigger: vi.fn(),
			iterateAllLeaves: (cb: (leaf: unknown) => void) => {
				for (const tab of tabs) {
					const containerEl = document.createElement('div');
					rootEl.appendChild(containerEl);
					cb({
						id: tab.leafId,
						containerEl,
						view: Object.assign(Object.create(MarkdownView.prototype), {
							file: { path: tab.path },
							editor: { getValue: () => live[tab.path] ?? '' },
						}),
					});
				}
			},
			// 那些显示 markdown 视图的 leaf：笔记**开着**时它的行从哪里读（见
			// shared/leaf.ts 的 markdownViewFor）。与上面那次遍历看到的是同一批标签页，
			// 每一个都带一个逐行应答的编辑器。
			getLeavesOfType: (type: string) => type !== 'markdown' ? [] : tabs.map((tab) => {
				const lines = (live[tab.path] ?? '').split('\n');
				return {
					id: tab.leafId,
					view: Object.assign(Object.create(MarkdownView.prototype), {
						file: { path: tab.path },
						editor: {
							getValue: () => live[tab.path] ?? '',
							getLine: (n: number) => lines[n] ?? '',
							lastLine: () => lines.length - 1,
						},
					}),
				};
			}),
		},
	};
	// 模态框在构造时读一次 Platform：就翻转那么久，好让点击语义按真实设备的方式定下来。
	const previous = Platform.isMobile;
	Platform.isMobile = mobile;
	// 列表自己的移除（见 body.ts 的 forgetRow）：面板交给 store 的是**一行**的身份，别的
	// 什么都不给 —— group key，也就是一篇笔记的 path 或一个视图的 type（见 nav/entry.ts
	// 的 navGroupKey）。这个 fixture 照 store 的方式应答 —— 一行据以画出的每一条记录一起
	// 走，指针被重新找到，而不是留在一个已经挪走的槽位上（见 NavPlaces.forget /
	// dropPlaces）—— 好让测试看着这一行离开屏幕，而不只是看着这次调用发生。这里列表是个
	// fixture（见上）；store 自己的规则钉在 recent-files-places.test.ts 里，而本套件看的
	// 是面板。
	const forget = vi.fn((key: string) => {
		const current = entries[index];
		for (let i = entries.length - 1; i >= 0; i--) {
			if (navGroupKey(entries[i]) === key)
				entries.splice(i, 1);
		}
		places.index = current && entries.includes(current) ? entries.indexOf(current) : -1;
	});
	// ……以及**钉住**，那是右键菜单写下的（见 body.ts 的 pinItems）。这个 fixture 照 store
	// 的方式应答 —— 那个数组**就是**置顶块，按读者的次序 —— 好让测试看着这一行挪动，而不
	// 只是看着这次调用。
	const pin = vi.fn((key: string) => {
		if (!pinned.includes(key))
			pinned.push(key);
	});
	const unpin = vi.fn((key: string) => {
		const at = pinned.indexOf(key);
		if (at >= 0)
			pinned.splice(at, 1);
	});
	// 任意步数的挪动，按 store 应答它的方式（见 NavPlaces.movePinned）：挪过一端就停在那一
	// 端上。
	const movePinned = vi.fn((key: string, delta: number) => {
		const at = pinned.indexOf(key);
		if (at < 0)
			return;
		const to = Math.min(Math.max(at + delta, 0), pinned.length - 1);
		if (to === at)
			return;
		pinned.splice(at, 1);
		pinned.splice(to, 0, key);
	});
	const places = {
		entries, index, travel: jumpTo, travelToHeading: jumpToHeading,
		subscribe: () => () => {}, forget, pinned,
		pin, unpin, movePinned, isPinned: (key: string) => pinned.includes(key),
	};
	let modal: RecentFilesModal;
	try {
		modal = new RecentFilesModal(app as never, places as never, saved, browserPrefs, arrows);
	} finally {
		Platform.isMobile = previous;
	}
	modal.open();
	// 列表是**一篇笔记一行**，外加读者**搜到**的那些小节各一行（见 list.ts 的
	// headingRow）。三个选择器，因为测试说的是三件不同的事 —— 屏幕上有哪些行、哪些是
	// 笔记、哪些是搜到的小节。
	const rows = () =>
		Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.position-restore-nav-row'));
	const notes = () =>
		Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-file'));
	const note = (name: string) =>
		notes().find(r => r.querySelector('.nav-row-name')?.textContent === name)!;
	const headings = () =>
		Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-heading'));
	const heading = (text: string) =>
		headings().find(r => r.querySelector('.nav-row-heading')?.textContent === text)!;
	// 在**行**上的一次点击：面板是个导航器，所以这会**打开**该行代表的文件 —— 笔记自己最新
	// 的那个落点，或那个落点本身（见 RecentFilesList.onClick）。读者已经在的那个地点并不
	// 豁免：这次打开会重新落到它上面。只有一篇已删的笔记哪儿都不去。
	const clickRow = (row: HTMLElement) =>
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	// ……以及一次真实点击的**后半**那一次按下（见 RecentFilesList.onPress）。测试把两者
	// 拆开只是为了在中间挪一下列表；一次普通点击就是一次按下紧接着一次点击，而那些只派发
	// 点击的测试讲的是程序化激活（或辅助技术的），它没有按下可记。
	const pressRow = (row: HTMLElement) =>
		row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
	// 那些地点在面板底下挪动。store 做的是**就地**重排它们 —— 浏览器读的数组还是同一个
	// 数组，被 splice 与 push（见 places.remember）—— 然后告诉它的那些监听者。对话框没有
	// 订阅可告诉（它是一张快照，第一次行进就关，见 modal.ts），所以测试自己完成这次挪动，
	// 然后向面板要那次**侧边栏**本会收到的重画：在过滤框上发一个 `input` 事件，那是对话框
	// 自己重建列表的方式。框保持**空**，所以列表是被重建，而不是被收窄。
	const filterInput = modal.contentEl.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
	const changed = (rep?: number) => {
		if (rep !== undefined) {
			const [moved] = entries.splice(rep, 1);
			entries.push(moved);
		}
		filterInput.dispatchEvent(new Event('input', { bubbles: true }));
	};
	// ……以及那些被压下去的手势：一次右键，和一根手指的久久按住（WebView 为两者都抛同一个
	// `contextmenu` —— 见 RecentFilesList.onContextMenu）。两者如今哪儿都不去了；要紧的是
	// 两者都**不打开**任何东西，而且两者仍被拒绝。
	const rightClick = (row: HTMLElement) => {
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
		row.dispatchEvent(ev);
		return ev;
	};
	// ……以及同一个事件从一次仅仅是按住不放的按下里来：WebView 为一次长按触也抛
	// `contextmenu`，上面带着**左**键的编号，而据此去打开会把一次普通的慢点击变成一次跳转。
	// 它带回那个事件，因为「有没有被拒绝」是它所说内容的一半。
	const longPress = (row: HTMLElement) => {
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
		row.dispatchEvent(ev);
		return ev;
	};
	// 一次真实的指针移动落在一行上。列表里没有东西听它 —— 面板只认点击（见
	// RecentFilesList），所以鼠标划过一行不选中任何东西、不打开任何东西、也不挪任何位置 ——
	// 而说这件事的那些测试就是这样递交报告的。这个处理程序从前按事件 **target** 做命中
	// 测试；坐标每次调用都前进，好让哪怕一个把移动当成选择的列表也没法把其中两个读成一个。
	let pointer = 0;
	const movePointer = (row: HTMLElement, at?: { x: number; y: number }) =>
		row.dispatchEvent(new MouseEvent('mousemove', {
			bubbles: true,
			clientX: at?.x ?? (pointer += 20),
			clientY: at?.y ?? pointer,
		}));
	const key = (k: string) => modal.contentEl.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
	// listbox 本身 —— 一行的点击经它冒泡上去，以及读者按下的那一行被重建掉之后浏览器把
	// 点击交给的那个东西。
	const list = () => modal.contentEl.querySelector<HTMLElement>('.position-restore-nav-list')!;
	// 一行在悬停上说什么。tooltip 如今是面板自己的元素，画在 document 上而不是列表里
	// （见 tip.ts），所以测试从 body 里把它读出来 —— 而且只在指针在那儿**停住**够那段延迟
	// 之后，下面那个假时钟就是为此而设。`hover` 返回那个元素或 null，所以断言读起来就是
	// 「悬停这一行会说……」。
	const hover = (el: HTMLElement): HTMLElement | null => {
		el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
		vi.advanceTimersByTime(TIP_DELAY_MS);
		return document.querySelector<HTMLElement>('.position-restore-nav-tip');
	};
	// ……以及离开：指针本来在这一行上，现在在别处了。
	const unhover = (el: HTMLElement) => {
		el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
		return document.querySelector<HTMLElement>('.position-restore-nav-tip');
	};
	// vault 里的一次元数据变更：一个文件的 frontmatter 被重写时 app 抛的东西，也是浏览器
	// 据以丢掉那个 path 的记忆的东西。
	const changeFile = (path: string) => {
		for (const cb of [...metaListeners])
			cb({ path });
	};
	// ……以及 vault 自己那句「一个文件**出现**了、走了或挪了」：一次同步对列表所站着的那
	// 篇笔记做了什么，以及那个说出「列表不再画的那一行可以再画出来」的唯一事件。
	const fileEvent = (name: string, file: { path: string }, oldPath?: string) => {
		for (const cb of [...(vaultListeners[name] ?? [])])
			cb(file, oldPath);
	};
	// 过滤框末尾那个 ×（见 RecentFilesBrowser.toolbar）。无论框里有没有东西它都在 DOM
	// 里 —— 框空时把它藏起来的是样式表（这条在样式套件里断言，因为 jsdom 不加载样式
	// 表）—— 所以测试照读者的方式点它。
	const clearButton = () =>
		modal.contentEl.querySelector<HTMLElement>('.position-restore-nav-clear')!;
	const clearFilter = () => clickRow(clearButton());
	// 一行自己带的那个 ×（见 RecentFilesList.fileRow）：列表所画的唯一一个控件，也是
	// 读者把一行从列表上拿掉的唯一办法。它**脱离**那一行的流来排布，所以测试按它自己的
	// class 找它，而不是按它站的地方 —— jsdom 不排布任何东西，而它站在哪儿是样式表的
	// 事（在样式套件里断言）。
	const forgetButton = (row: HTMLElement) =>
		row.querySelector<HTMLElement>('.nav-row-forget')!;
	return {
		modal, jumpTo, jumpToHeading, forget, cachedRead,
		el: modal.contentEl, entries, list,
		pinned, pin, unpin, movePinned, arrows,
		trigger: app.workspace.trigger, cacheReads: () => cacheReads, changeFile, fileEvent,
		rows, notes, note, headings, heading, clickRow, pressRow, changed, rightClick, longPress,
		movePointer, key, hover, unhover, clearButton, clearFilter, forgetButton,
	};
}

beforeEach(() => {
	// app 对「这个该开在哪儿」与「修饰键按着吗」的答案是测试按用例设定的输入（见那个
	// 桩）：上一个用例留下来的那个会替这个用例做决定。
	KeymapKnobs.reset();
	document.body.innerHTML = '';
	// 子节点（以及测试留在 body 上的任何 class），否则一个测试的 DOM 会漏进下一个。
	document.body.className = '';
	// tooltip 自己的时钟（见 tip.ts）：那段延迟是测试唯一必须能跨过去的东西，而只假造
	// 那两个定时器函数 —— `Date` 放着不动，所以各个 fixture 用到的年纪就是各行印出来的
	// 年纪。
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	// 宽度查询是测试安装的唯一一个全局（见 widthQuery）：jsdom 自己一个都没有，而漏在
	// 那儿的一个会替它之后每个测试决定面板的呈现。
	delete (window as { matchMedia?: unknown }).matchMedia;
	document.body.innerHTML = '';
	document.body.className = '';
});

describe('RecentFilesModal —— 被丢掉的步那条脚注', () => {
	it('已经撤掉：平时栈总停在上限处，它从来没挣到过一行', () => {
		// 它从列表末尾报告上限丢掉过什么 —— 而列表末尾恰好在**真的**丢过 entry 时才落到
		// 折叠线以下（把对话框撑出滚动条的正是一个停在上限处的栈），所以从没有人看见过
		// 它。列表如今不再渲染这样一条脚注。
		const entries = [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' });

		expect(h.el.querySelector('.position-restore-nav-cap-note')).toBeNull();
	});
});

describe('RecentFilesModal —— 当前位置', () => {
	it('当前笔记跟别的笔记一样就是一行，自己不带圆点', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		// 别处再没有第二个「你在这里」：从前立在列表上方的那张卡片在第二个地方、用第二套
		// 排布说着同样的话，而下面那一行才是权威的那个（见 RecentFilesModal.render）。
		expect(h.el.querySelector('.position-restore-nav-here')).toBeNull();

		// 当前笔记就是列表里普普通通的一行，它排在最前是因为它是这里最新的地点 —— 而它
		// 不带 ●：那个圆点标的是持有当前 entry 的那个**落点**（见
		// RecentFilesList.placeRow），而一篇笔记自己的记录压根不是落点，这里的笔记行也
		// 都不印落点。
		const notes = h.notes();
		expect(notes).toHaveLength(3);
		expect(notes[0].textContent).toContain('c');
		expect(notes[0].querySelector('.nav-row-here')).toBeNull();
		// 一个地点也不是个计数：那个「+N」随展开一起走了，而从前引在一个名字前面的插入符
		// 更早就不在了。
		expect(notes[0].querySelector('.nav-row-count')).toBeNull();
		expect(notes[0].querySelector('.nav-file-caret')).toBeNull();
		expect(notes[1].querySelector('.nav-row-here')).toBeNull();
	});

	it('一篇笔记就是一行，并在它自己那里打开它', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '', 'c.md': '' });

		// 一篇笔记一行就是它的全部 —— 这份列表不记位置，所以没有哪个落点可以印在它
		// 底下（见 places.ts）。
		expect(h.rows()).toHaveLength(2);
		expect(h.note('c').querySelector('.nav-row-here')).toBeNull();

		// ……而这一行仍是个目的地：点击以普通方式打开 c.md，落在哪儿由位置数据库回答
		// —— 与在文件浏览器里点它完全一样。
		h.clickRow(h.note('c'));
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('只有一步的历史就是只有一行的列表，那一行照样能打开', () => {
		// 从前，当当前 entry 的笔记是列表上仅剩的那一个地点时，列表会自称是空的，而那一行
		// 谁也不应答：读者把所有标签页都关掉后唯一会看见的那份列表，恰恰是唯一一份没有路
		// 回去的列表。如今那一行是个目的地（见 RecentFilesList.targetOf），所以「无处
		// 可去」那句话属于一个什么都没匹配到的查询，或属于一段笔记真的都没了的历史 ——
		// 永远不属于读者正站着的那个地点。
		const h = harness([visit('only.md', NOW)], 0, { 'only.md': '' });

		expect(h.notes()).toHaveLength(1);
		expect(h.el.querySelector('.position-restore-nav-empty')).toBeNull();

		h.clickRow(h.note('only'));
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
	});

	it('只有当查询真的把列表清空时，才说「没有匹配」', () => {
		// 那句话是**查询**的答案，而不是对读者所站地点的判决：什么都没匹配到的过滤会把
		// 列表清空，而只留下当前笔记的过滤留下的是一行与别行一样能打开的行（见
		// RecentFilesList.render 里 refs.some(targetOf) 那个分支）。
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' });
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		const search = (q: string) => {
			box.value = q;
			box.dispatchEvent(new Event('input', { bubbles: true }));
		};

		search('zzz');
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('recentFiles.noMatch'));

		search('b.md'); // 只有当前笔记一行
		expect(h.el.querySelector('.position-restore-nav-empty')).toBeNull();
		h.clickRow(h.note('b'));
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('笔记正文不参与搜索：那一行不会靠正文里的一句话留在列表上', () => {
		// 搜索面里没有任何一块正文：navSearchText 只拼名字与 path，而各小节的标题是从
		// vault 现查的（见 reads.ts 的 headingsFor）。所以笔记里的任何一句话都进不来 ——
		// 「按内容找一篇笔记」交给 vault 自己的全文搜索。
		const h = harness([visit('a.md', NOW)], 0, { 'a.md': A_DOC }, [], {}, A_HEADINGS);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览条';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent)
			.toBe(t('recentFiles.noMatch'));
	});

	it('搜到的小节自己成为一行：点击去那一节，悬停补上它在笔记里的位置', () => {
		// 一篇笔记**有哪些小节**是关于这篇笔记的事实，与读者此刻站在哪儿无关 —— 而它现
		// 查、不存任何快照（见 reads.ts 的 headingsFor），所以它参与搜索。命中不写在笔记
		// 那一行上：那一节有**它自己**的一行，那一行点下去就是去它。少了这个，一次按标题
		// 词的搜索会得到一行光秃秃的笔记名，而读者无从知道它为什么在这儿。
		const h = harness(
			[visit('a.md', NOW), visit('plain.md', NOW - MINUTE)], 0,
			{ 'a.md': A_DOC, 'plain.md': '' }, [], {}, A_HEADINGS,
		);
		// 没有查询就没有「搜到的东西」。
		expect(h.headings()).toHaveLength(0);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		// 那一节自己一行，挂在它的笔记下面。
		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['a']);
		const row = h.heading('预览');
		expect(row).toBeDefined();
		// 悬停补上行上印不下的那半句：那一节**在这篇笔记的哪里**。
		const tip = h.hover(row)!;
		expect(tip.querySelector('.nav-tip-trail')?.textContent)
			.toBe('面板设计 › 呈现方案 › 预览');
		// ……而点击去的是那一节，不是那篇笔记。
		h.clickRow(row);
		expect(h.jumpToHeading).toHaveBeenCalledWith('a.md', '预览', 4, 'leaf-1', undefined);
		expect(h.jumpTo).not.toHaveBeenCalled();

		// 一个这篇笔记**没有**的小节仍然找不到 —— 全篇标题不是万能的。
		h.unhover(row);
		box.value = '不存在的一节';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.notes()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent)
			.toBe(t('recentFiles.noMatch'));
	});

	it('名字命中的行去那篇笔记，它下面搜到的那一节才去那一节', () => {
		// 这篇笔记的名字里就写着那个词，所以它进得来；它里面恰巧也有个叫「预览」的小节
		// —— 那一节有自己的一行，而**笔记**那一行点下去仍然只是打开那篇笔记（一次普通
		// 打开，落在哪儿由位置数据库回答）。
		const h = harness(
			[visit('预览.md', NOW), visit('plain.md', NOW - MINUTE)], 0,
			{ '预览.md': A_DOC, 'plain.md': '' }, [], {},
			{ '预览.md': A_HEADINGS['a.md'] },
		);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		// 那一节照样画出来……
		expect(h.heading('预览')).toBeDefined();
		// ……而笔记那一行不去它。
		h.clickRow(h.note('预览'));
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
		expect(h.jumpToHeading).not.toHaveBeenCalled();
	});

	it('被钉住的行也画出搜到的小节：它站在同一个搜索框底下', () => {
		// 钉选是书签，但它不是「用标题搜不到那一节」的理由 —— 读者在同一个框里输的那个
		// 词，对这两种行问的是同一个问题。
		const h = harness(
			[visit('a.md', NOW), visit('plain.md', NOW - MINUTE)], 0,
			{ 'a.md': A_DOC, 'plain.md': '' }, [], {}, A_HEADINGS,
			false, {}, undefined, undefined, ['a.md'],
		);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		h.clickRow(h.heading('预览'));
		expect(h.jumpToHeading).toHaveBeenCalledWith('a.md', '预览', 4, 'leaf-1', undefined);
	});

	it('键盘走到那一行、按下回车，去的是同一节 —— 大纲行不只挂在点击上', () => {
		const h = harness([visit('a.md', NOW)], 0, { 'a.md': A_DOC }, [], {}, A_HEADINGS);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		h.key('ArrowDown'); // 笔记那一行
		h.key('ArrowDown'); // 它下面搜到的那一节
		h.key('Enter');
		expect(h.jumpToHeading).toHaveBeenCalledWith('a.md', '预览', 4, 'leaf-1', undefined);
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('菜单里那一项说的也是「在这里打开」—— 大纲行去的地方就是那一节', () => {
		// 一个写着「在这里打开」却把读者送到别处的菜单，比没有这一项更糟。
		const h = harness([visit('a.md', NOW)], 0, { 'a.md': A_DOC }, [], {}, A_HEADINGS);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		h.rightClick(h.heading('预览'));
		const menu = Menu.shown.at(-1)!;
		expect(menu.items[0].title).toBe(t('recentFiles.openHereInNewTab'));
		menu.items[0].click!();
		expect(h.jumpToHeading).toHaveBeenCalledWith('a.md', '预览', 4, 'leaf-1', 'tab');
	});

	it('笔记那一行的悬停不说任何节：那条链只给搜到的那一节', () => {
		// 链说的是「那个地方叫什么」，而一篇笔记的行不代表某一个地方 —— 它的点击以普通
		// 方式打开它，落在哪儿由位置数据库回答。在这里点出一个小节，会是一个它的点击
		// 并不兑现的落点。
		const files = { 'a.md': A_DOC, 'b.md': A_DOC };
		const h = harness([visit('a.md', NOW), visit('b.md', NOW - MINUTE)], 0,
			files, [], {}, A_HEADINGS);
		const tip = h.hover(h.note('a'))!;
		expect(tip).not.toBeNull();
		expect(tip.querySelector('.nav-tip-trail')).toBeNull();
	});
});

// 一次点击，而它的行已经被列表在它底下重建掉了：读者按的是一篇笔记，而松开时到达的
// 元素已经不在列表上、或在列表上但换了地方。一行的下标是关于**某一次渲染**的事实
// （每次 visit 地点都会在列表底下动），所以在重建之后去读它的点击会打开滑进那个槽位的
// 东西 —— 打开错的那篇笔记。点击改用的答案，是读者**按下**时的那个地点（见
// RecentFilesList.onPress / onClick）。
describe('RecentFilesModal —— 列表重建之后的一次点击', () => {
	// 这里 a 是**最旧**的，所以按新鲜度它排**最后**：三行，a.md 第三。
	const three = () => [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };

	it('打开的是被按下的那篇笔记，而不是下标此刻指着的那一篇', () => {
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('a');
		expect(h.notes().map(r => r.textContent)).toEqual(['c', 'b', 'a']);

		// 按下这一行，然后让那些地点照读者自己那次点击即将挪动它们的方式挪动（a.md 挪到
		// 末尾，按新鲜度它就到**最前**），再让列表重建。手里那个元素现在是脱离的，而它带
		// 的那个 group 下标（2）指的是 b.md。
		h.pressRow(row);
		h.changed(0);

		expect(h.notes().map(r => r.textContent)).toEqual(['a', 'c', 'b']);
		h.clickRow(row);

		// a.md 挪之前是 entries[2]，挪之后也是 entries[2]；那个过期元素带的下标（第三个
		// **group**）现在指的是 b.md，而 b.md 是 entries[0] —— 所以这里错的答案是 0，
		// 不是 2。
		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});

	it('它原来代表的那个地点已经不在列表上了，就什么都不打开', () => {
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('a');

		h.pressRow(row);
		// 那个地点没了：文件被删了、上限把它裁掉了、查询不再匹配它。没有一行还代表它。
		entries.splice(0, 1);
		h.changed();

		h.clickRow(row);

		// 什么都不打开是这份列表唯一赔得起的失误。打开占了那个槽位的那篇笔记，是它赔不起
		// 的那个。
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('前面没有按下时，仍然打开点击落着的那一行', () => {
		// 一次程序化激活，或辅助技术的：没有按下可记，所以事件自己那一行就是答案 —— 而且
		// 是正确的那个，因为这样的点击只可能落在**确实在**列表上的元素上。
		const entries = three();
		const h = harness(entries, 2, files);

		h.clickRow(h.note('a'));

		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
	});

	it('列表没有重建时，打开点击落着的那一行', () => {
		// 一次普通的点击，分两半：按下与松开，中间什么都没有。手里那个元素仍是列表画的
		// 那个，所以它自己的下标就是准确答案，不需要查找。
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('b');

		h.pressRow(row);
		h.clickRow(row);

		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('被按下的那一行已经没了、浏览器把点击交给了列表时，也照样应答', () => {
		// 一次元素在松开前被移除的按下，并不总会回到那个元素上：浏览器会把这次点击解析到
		// document 里仍在的最近祖先上，所以没有任何一行看见它。那就是从前什么都不做的
		// 那次点击（见 RecentFilesList.onUnansweredClick）。
		const entries = three();
		const h = harness(entries, 2, files);
		const row = h.note('a');

		h.pressRow(row);
		h.changed(0);
		h.list().dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});

	it('没有先按下的、落在列表上的点击，什么都不做', () => {
		// 列表自己的背景 —— 最后一行底下的那片空。它不是一行，也不代表任何地点：什么都
		// 没被按下，也就什么都不可以打开。
		const entries = three();
		const h = harness(entries, 2, files);

		h.list().dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('按下的是另一行的、那一次还悬着时，按这次点击落着的地方来答', () => {
		// 一次被读者放弃的按下 —— 指针拖离了这一行，或是一次右键把这一行的菜单调了出来
		// —— 不许埋伏在那里、稍后去打开它点名的那一行。仍在列表上的元素自己应答（见
		// onClick），所以打开的是被点击的那个：这里是 c.md（entries[2]），而不是
		// a.md（entries[0]）——按下的那个。
		const entries = three();
		const h = harness(entries, 2, files);

		h.pressRow(h.note('a'));
		h.changed();
		h.clickRow(h.note('c'));

		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});
});

describe('RecentFilesModal —— 键盘', () => {
	it('还没指到任何一行之前，回车什么都不做', () => {
		// 从前回车会退回去做「后退一步」，那意味着同一个键视指针有没有划过某一行而做两件
		// 不同的事 —— 还复制了 app 自己的后退命令。后退一步压根不需要面板。
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('Enter');

		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('方向键挪选中项，回车跳到它点名的那篇笔记', () => {
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('ArrowDown'); // c.md —— 最新的笔记，也是读者所在的那篇
		h.key('ArrowDown'); // b.md，后退栈里最新的那篇
		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('每按一次挪一行，并让挪到的那一行留在视野里', () => {
		// 一个位置，一次挪一行，而列表跟着它 —— 这样读者能看见自己在哪儿，而不是一个高亮
		// 移出屏幕。（jsdom 不排布任何东西，所以这里看到的是浏览器自己那点最小的滚动；
		// 列表真正的规则是 revealDelta 的，下一个测试给它一套 layout。）
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });
		const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
		const selected = () => Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-selected'))
			.map(r => r.querySelector('.nav-row-name')?.textContent);

		// c.md、b.md、a.md —— 最新的在前：列表就是那些地点的新鲜度，当前笔记也包括在
		// 内（见 groupByFile）。
		h.key('ArrowDown');
		expect(selected()).toEqual(['c']);
		expect(spy).toHaveBeenCalled();
		spy.mockClear();

		h.key('ArrowDown');
		expect(selected()).toEqual(['b']);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('挪列表是为了走位、不是为了一次点击；走出视野的行会被拉到正中间', () => {
		// 列表也是读者的视口，而这就是教会它这件事的那个 bug：位置每按一次键走**一行**，
		// 所以把它滚回视野所需的最小距离，会让列表挪动的距离与那一行挪动的完全一样。于是
		// 那一行紧贴着边缘，而此后每一步都在一个从不移动的标记底下滚着那些笔记名 —— 站在
		// 列表末尾的读者按 ↓，看着滚动条跑而选中项站着不动（见 revealDelta）。
		const entries = [
			visit('d.md', NOW - 7 * MINUTE), visit('a.md', NOW - 5 * MINUTE),
			visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW),
		];
		const h = harness(entries, 3, { 'a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' });
		const listEl = h.el.querySelector<HTMLElement>('.position-restore-nav-list')!;
		// jsdom 没有 layout：给列表一个从 100 开始的 60px 盒子，给每一行 20px 高、一行
		// 接一行（第四行于是出了视野，紧贴着）。
		const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect;
		vi.spyOn(listEl, 'getBoundingClientRect').mockReturnValue(rect(100, 60));
		Array.from(listEl.querySelectorAll<HTMLElement>('.position-restore-nav-row'))
			.forEach((row, i) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(100 + i * 20, 20)));
		const spy = vi.spyOn(Element.prototype, 'scrollIntoView');

		// **一次点击什么都不挪**：它打开它落着的那一行，而列表是读者自己的视口 ——
		// 对一个别人指过的行，只要可读就够了，而那次走动跳到正中间的不是。
		h.clickRow(h.notes()[3]); // d.md，在框的下方
		expect(listEl.scrollTop).toBe(0);
		h.clickRow(h.notes()[0]); // c.md，在视野内
		expect(listEl.scrollTop).toBe(0);
		spy.mockClear(); // ……而从这里起，只有走位会挪动列表

		h.key('ArrowDown'); // c.md —— 最新的笔记，在视野内
		h.key('ArrowDown'); // b.md，在视野内
		expect(listEl.scrollTop).toBe(0);
		h.key('ArrowDown'); // a.md，紧贴列表脚边 —— 仍在**视野内**
		expect(listEl.scrollTop).toBe(0);

		h.key('ArrowDown'); // ……而出了视野：列表把这一行带到它的**正中间**
		expect(listEl.scrollTop).toBe(40);
		expect(160 - listEl.scrollTop).toBe(120); // 这一行的顶边，正在框的正中间
		expect(spy).not.toHaveBeenCalled(); // 没有浏览器滚动：走位是列表自己的
	});

	it('只有按键会挪位置，指针光是划过什么都不挪', () => {
		// **列表的规则**（见 RecentFilesList）：划过一行的指针什么都不选中。它从前会挪
		// **那个**位置 —— 回车所去往的那一行 —— 那意味着鼠标划过列表就选中了一行没人选过
		// 的行，还可能把键盘的走动撤掉。这里每一份报告都是真报告、各有各的坐标，所以列表
		// 做的是**无视**指针，而不是压根收不到指针的报告。
		const entries = [visit('a.md', NOW - 5 * MINUTE), visit('b.md', NOW - 2 * MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });
		const selected = () => Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-row.is-selected'))
			.map(r => r.querySelector('.nav-row-name')?.textContent);
		const a = h.notes()[0];
		const b = h.notes()[1];

		h.movePointer(b, { x: 40, y: 40 });
		h.movePointer(b, { x: 41, y: 40 });
		h.movePointer(a, { x: 120, y: 40 });
		expect(selected()).toEqual([]);

		// ……而键盘自己那个位置被原样留在原处：无论是指向它走到的那一行的指针报告，还是
		// 指向任何别处的，都拿不走它。
		h.key('ArrowDown'); // c.md —— 最新的笔记，也是读者所在的那篇
		expect(selected()).toEqual(['c']);
		h.movePointer(b, { x: 44, y: 41 });
		h.movePointer(h.el.querySelector<HTMLElement>('.position-restore-nav-list')!, { x: 200, y: 90 });
		expect(selected()).toEqual(['c']);

		// ……点击也不挪它：点击**打开**那一行（下面的行进），而这就是列表对指针做的全部。
		h.clickRow(b);
		expect(h.jumpTo).toHaveBeenCalled();
		expect(selected()).toEqual(['c']);
	});

	it('只在笔记行之间走；←→ 什么都不打开，因为行上什么都没显示', () => {
		const entries = [
			visit('a.md', NOW - 5 * MINUTE),
			visit('b.md', NOW - 2 * MINUTE),
			visit('c.md', NOW),
		];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		h.key('ArrowDown'); // c.md
		h.key('ArrowDown'); // b.md —— 一行，无论这篇笔记里有什么
		expect(h.headings()).toHaveLength(0);
		expect(h.note('b').classList.contains('is-selected')).toBe(true);

		// 回车行进到那一行所代表的那篇笔记 —— 一次普通打开，落在哪儿由位置数据库回答
		// —— 而 ↓ 继续走到下一篇笔记。
		h.key('Enter');
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
		h.key('ArrowDown');
		expect(h.note('a').classList.contains('is-selected')).toBe(true);

		// ←→ 在这里不被任何东西消费：已经没有树可开可关（见
		// RecentFilesBrowser.onKeyDown），所以两个键在搜索框里保留它们平常的含义。
		const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
		h.modal.contentEl.dispatchEvent(right);
		expect(right.defaultPrevented).toBe(false);
		expect(h.headings()).toHaveLength(0);
	});

	it('一篇笔记被打开多少次都只是一行，点它去的就是那篇笔记', () => {
		// 文件自己的记录就是笔记那一**行**（见 listing.ts 的 groupByFile）。为它多画一行
		// 会画出一行明显什么都不做的行 —— 对屏幕上这篇笔记的一次普通打开 —— 而且偏偏排
		// 在最**前**、被点得最多的那篇笔记上。
		const entries = [
			visit('a.md', NOW - 3 * MINUTE),
			visit('a.md', NOW - 2 * MINUTE),
			visit('b.md', NOW),
		];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '' });

		expect(h.notes()).toHaveLength(2);
		// ……而点击行进到托着这一行的**那条**记录 —— 这篇笔记最新的那一次访问。
		h.clickRow(h.note('a'));
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('搜到了小节时，键盘也走进那一节那一行', () => {
		// 大纲行是**完整的行**（见 list.ts 的 headingRow）：可点、可预览、也可被键盘走
		// 到 —— 一个只能靠鼠标去的地方，在没有鼠标的设备上就不是地方。
		const entries = [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'a.md': A_DOC, 'b.md': '' }, [], {}, A_HEADINGS);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		h.key('ArrowDown'); // a.md
		h.key('ArrowDown'); // 它下面搜到的那一节
		expect(h.heading('预览').classList.contains('is-selected')).toBe(true);
		h.key('Enter');
		expect(h.jumpToHeading).toHaveBeenCalledWith('a.md', '预览', 4, 'leaf-1', undefined);
		expect(h.jumpTo).not.toHaveBeenCalled();
	});
});

describe('RecentFilesModal —— 文件范围选择器已经撤掉', () => {
	// 这里从前立着的是两个控件、共用一个状态：一个「只限这篇笔记」的开关，以及一个打开
	// 「历史去过的每篇笔记」菜单的提示条。两者回答的都是「我在笔记里还去过哪儿」，而搜索框
	// 已经回答了 —— 笔记的名字就是它自己的那些步可以被搜到的文本 —— 所以工具条留下那个框、
	// 旁边什么都不留，而列表留下那份宽度与提示从前站的那一行。列表**印**什么也不是工具条
	// 回答的问题：那四个选择如今是插件设置页里的几行（见 RecentFilesBrowserPrefs）。
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const entries = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('c.md', NOW - 4 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];

	it('工具栏上只剩搜索框和它的 ×', () => {
		const h = harness(entries(), 3, files);

		expect(h.el.querySelector('.position-restore-nav-toggle')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-scope')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-scope-menu')).toBeNull();
		// 那个框，别的什么都没有：从前站在这一条带子远端的那个齿轮随它载着的四个选择一起
		// 走了（见 RecentFilesBrowserPrefs），那句从前写着「点一行就能打开它」的提示也
		// 走了 —— 列表里的一行在 app 别处哪里都应答点击，而那句话让列表赔上了一行。框上
		// 那个 × 不是带子上的第二样东西：它在框自己的元素**里面**，挂在读者打字的那一行
		// 上。
		const strip = Array.from(h.el.querySelectorAll<HTMLElement>('.position-restore-nav-toolbar > *'));
		expect(strip.map(el => el.className.split(' ')[0])).toEqual(['position-restore-nav-search']);
		expect(h.el.querySelector('.position-restore-nav-hint')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-settings')).toBeNull();
		expect(strip[0].querySelector('.position-restore-nav-clear')).toBe(h.clearButton());
	});

	it('用行尾那个 × 清空输入框', () => {
		// app 自己的手势，抄自它的快速切换器（见 RecentFilesBrowser.toolbar）：这次按下
		// 被**拒绝**，好让插入符从不离开那个框，而点击把框清空、并据它重新读一遍列表。
		// 无论框里有没有东西它都在 DOM 里；框空时把它藏起来的是**样式表**（这条在样式
		// 套件里断言 —— jsdom 不加载样式表）—— 除了在对话框里，那里框空恰恰是这个字形
		// 干它**另一份**活的时候（见下）。
		const h = harness(entries(), 3, files);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		expect(h.clearButton().querySelector('svg')?.getAttribute('data-icon')).toBe('x');
		// 在它上面的一次按下被拒绝，所以焦点留在读者正在打字的地方。
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		h.clearButton().dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);

		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.notes()).toHaveLength(1);
		// ……而有东西可清时，**清空**就是这个字形自称在做的事 —— 名字是从框上读出来的、
		// 而不是存起来的，所以这两个动作没法彼此漂开。
		expect(h.clearButton().getAttribute('aria-label')).toBe(t('recentFiles.clearFilter'));
		expect(h.clearButton().getAttribute('title')).toBe(t('recentFiles.clearFilter'));

		h.clearFilter();

		// 框空了、列表重新是整份列表、插入符也回到了框里 —— 正是这一点让那个 × 成为更快
		// 打出下一个查询的方式。
		expect(box.value).toBe('');
		expect(h.notes()).toHaveLength(3);
		expect(document.activeElement).toBe(box);
		expect(h.clearButton().getAttribute('aria-label')).toBe(t('recentFiles.close'));
	});

	it('什么都没输入时，同一个 × 用来关掉这个对话框', () => {
		// **一个字形，两个动作**，就在 app 自己那个 prompt 把它们放的位置上：打了字的
		// 清空（见上），没打字的则是**出去**的路。一个顶上就是自己那个框的对话框，没有
		// 别的指针够得到的关闭方式 —— 头部那个 × 随它旁边的名字一起走了 —— 而两个都留着
		// 会是一个念头用两个字形。
		const h = harness(entries(), 3, files);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		const close = vi.spyOn(h.modal, 'close');

		expect(h.clearButton().getAttribute('aria-label')).toBe(t('recentFiles.close'));
		h.clearFilter();

		expect(close).toHaveBeenCalledTimes(1);
		// ……而且仅此而已：什么都没被过滤掉、什么都没行进。
		expect(box.value).toBe('');
		expect(h.notes()).toHaveLength(3);

		// 打字把这个字形的第一份活交回给它 —— 除了框自己的文本之外没有别的状态要同步，
		// 正如清空又把那条出去的路从它身上拿走一样。
		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.clearButton().getAttribute('aria-label')).toBe(t('recentFiles.clearFilter'));
		h.clearFilter();
		expect(close).toHaveBeenCalledTimes(1);
		expect(box.value).toBe('');
		h.clearFilter();
		expect(close).toHaveBeenCalledTimes(2);
	});

	it('按笔记自己的名字筛到它，这正是当初那个范围选择器要干的事', () => {		const h = harness(entries(), 3, files);
		expect(h.notes()).toHaveLength(3);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'b.md';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('b');
	});
});

// 一个文件所**另外**叫的那些名字（见 RecentFilesReads.otherNamesFor）：可搜索，而在
// 行上除了它自己的 tooltip 外哪儿都不印。它们是查询能命中的、字面上不在行上的第四样
// 东西，也是第一个刻意关于读者的记忆、而不是关于那次 visit 的东西。
describe('RecentFilesModal —— 按笔记的别的名字搜', () => {
	// 这个窗口打开时带着两篇笔记各自的 `visit`，所以一个查询的命中可以按行来数。
	const entries = (): NavEntry[] => [
		visit('a.md', NOW - 3 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('a.md', NOW - MINUTE),
	];
	const cache = {
		'a.md': {
			headings: [],
			frontmatter: { title: 'Weekly sync', aliases: ['周会', 'standup'] },
		},
		'b.md': { headings: [], frontmatter: { aliases: 'solo' } },
	};
	const files = { 'a.md': '', 'b.md': '' };
	const search = (h: ReturnType<typeof harness>, query: string) => {
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const names = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);
	// tooltip 里那几行名字，按绘制的次序：笔记自称什么，然后它还应答什么（见
	// TipContent）。
	const namesOn = (tip: HTMLElement) =>
		Array.from(tip.querySelectorAll('.nav-tip-text')).map(l => l.textContent);

	it('按别名、按 title 都能找到一篇笔记；不相干的词不行', () => {
		const h = harness(entries(), 2, files, [], {}, cache);

		search(h, '周会');
		expect(names(h)).toEqual(['a']);
		// `title` 也读 —— 那是社区惯例、不是原生属性（见 readMeta）—— 而它里面命中就是
		// 命中，一个 token 一个 token 地算。
		search(h, 'weekly');
		expect(names(h)).toEqual(['a']);
		search(h, 'sync');
		expect(names(h)).toEqual(['a']);
		// 与查询的其它部分一样不分大小写。
		search(h, 'STANDUP');
		expect(names(h)).toEqual(['a']);

		search(h, 'nothing-here');
		expect(names(h)).toEqual([]);
	});

	it('别名写成单个字符串也认，不只有列表形式', () => {
		// `aliases: solo` 与常见的块列表一样是合法的 frontmatter 行，而 Obsidian 自己的
		// 匹配两种都认（见 readMeta）。
		const h = harness(entries(), 2, files, [], {}, cache);

		search(h, 'solo');

		expect(names(h)).toEqual(['b']);
	});

	it('名字可能来自两处，两处的词按「与」一起判', () => {
		const h = harness(entries(), 2, files, [], {}, cache);

		// 一个 token 来自 title、一个来自别名：两者都必须在这一行所代表的东西里某处，而
		// 它们确实在。
		search(h, 'weekly 周会');
		expect(names(h)).toEqual(['a']);

		// ……但一个哪儿都不持有的 token 会让这次匹配沉掉，无论另一半持有的是谁。
		search(h, 'weekly b.md');
		expect(names(h)).toEqual([]);
	});

	it('不重新排序：靠别名命中的也仍然按最近用过的次序排', () => {
		// 这个次序是「我去过哪儿」，而一个读者只记得一半的名字，对他们何时去过那儿什么
		// 都没说。两篇笔记带同一个别名，而读者**正在**的那篇不带，所以剩下就是两者匹配的
		// 那两篇的普通 MRU 次序：b 比 a 后访问，所以 b 在前。
		const h = harness([
			visit('a.md', NOW - 3 * MINUTE),
			visit('b.md', NOW - 2 * MINUTE),
			visit('c.md', NOW),
		], 2, { 'a.md': '', 'b.md': '', 'c.md': '' }, [], {}, {
			'a.md': { headings: [], frontmatter: { aliases: ['x'] } },
			'b.md': { headings: [], frontmatter: { aliases: ['x'] } },
		});

		search(h, 'x');

		expect(names(h)).toEqual(['b', 'a']);
	});

	it('把别的名字印在这一行的提示条上，排在路径之后', () => {
		// 一篇**有**名字的笔记与一篇没有的，好让这条规则的后一半立在前一半旁边：那些名字
		// 是对 tooltip 的**补充**，不是替换。
		const h = harness([visit('a.md', NOW - MINUTE), visit('plain.md', NOW)], 1,
			{ 'a.md': '', 'plain.md': '' }, [], {}, cache);

		// 先是路径，然后是笔记**自称**的名字（单独一行），再是别名（见 readMeta）：行既不
		// 印扩展名也不印文件夹，所以这里是读者还看得见它们的地方；而路径是**一段一段**画
		// 出来的，所以那些分隔符是各自的元素（见 tip.ts）—— 读者复制到的字符串两种画法
		// 都一样。
		const withNames = h.hover(h.note('a'))!;
		expect(withNames.querySelector('.nav-tip-path')?.textContent).toBe('a.md');
		expect(Array.from(withNames.querySelectorAll('.nav-tip-sep')).map(s => s.textContent)).toEqual([]);
		expect(namesOn(withNames)).toEqual([
			`${t('recentFiles.title')} Weekly sync`,
			`${t('recentFiles.aliases')} 周会 · standup`,
		]);

		// ……而没有别的名字的笔记只说路径，别的什么都不说。
		h.unhover(h.note('a'));
		const plain = h.hover(h.note('plain'))!;
		expect(plain.querySelector('.nav-tip-path')?.textContent).toBe('plain.md');
		expect(plain.querySelector('.nav-tip-text')).toBeNull();
	});

	it('行上已经印着的那个名字，不再重复说', () => {
		// 读者把 `title` 设成了行所印的那个属性，所以笔记自己的名字已经在行上了：tooltip
		// 不欠它什么，剩下要说的就是别名。一个**就是**文件自己名字的 `title` 是同一个情形
		// 的「设置关掉」版 —— 行两种情况下都印它，所以那里也不说。
		const h = harness([visit('a.md', NOW - MINUTE), visit('same.md', NOW)], 1,
			{ 'a.md': '', 'same.md': '' }, [], {}, {
				...cache,
				'same.md': { headings: [], frontmatter: { title: 'same', aliases: ['同样'] } },
			}, false, {}, prefs({ title: 'title' }).browser);

		const named = h.note('Weekly sync');
		expect(namesOn(h.hover(named)!)).toEqual([`${t('recentFiles.aliases')} 周会 · standup`]);
		h.unhover(named);
		expect(namesOn(h.hover(h.note('same'))!)).toEqual([`${t('recentFiles.aliases')} 同样`]);
	});

	it('文件夹路径按各段画出来，分隔符画在段与段之间', () => {
		// 面板之所以自己画 tooltip 的唯一理由：两个长段之间的一个 `/` 是整串里最不显眼的
		// 字符，所以要让它成为自己的一个 span，好让样式表给它加权重（见 styles.css），而
		// 那些文件夹段向后退一步，好让它有东西可作对照。
		const h = harness([visit('deep/folder/note.md', NOW)], 0, { 'deep/folder/note.md': '' });

		const tip = h.hover(h.note('note'))!;
		expect(Array.from(tip.querySelectorAll('.nav-tip-sep')).map(s => s.textContent))
			.toEqual(['/', '/']);
		expect(Array.from(tip.querySelectorAll('.nav-tip-seg')).map(s => s.textContent))
			.toEqual(['deep', 'folder']);
		expect(tip.querySelector('.nav-tip-name')?.textContent).toBe('note.md');
		// 整串读起来仍是一条路径。
		expect(tip.querySelector('.nav-tip-path')?.textContent).toBe('deep/folder/note.md');
	});

	it('大纲行的提示条不动：它只说那一节在笔记里的哪里', () => {
		// 大纲行不对**文件**说任何东西：它说的是一个搜到的小节，而笔记的别的名字属于那
		// 篇笔记，不属于它里面的某一处（见 list.ts 的 headingRow）。那些名字改向笔记
		// 自己那一行去问。
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, files, [], {}, {
			...cache,
			'a.md': { headings: A_HEADINGS['a.md'], frontmatter: cache['a.md'].frontmatter },
		});
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		const tip = h.hover(h.heading('预览'))!;
		expect(tip.querySelector('.nav-tip-trail')?.textContent).toBe('面板设计 › 呈现方案 › 预览');
		expect(tip.querySelector('.nav-tip-path')).toBeNull();
		expect(tip.querySelector('.nav-tip-text')).toBeNull();
		// ……而文件的别的名字由笔记自己那一行说。
		h.unhover(h.heading('预览'));
		expect(h.hover(h.note('a'))!.textContent).toContain('周会');
	});

	it('每个路径只读一次，只有文件变了才再读一次', () => {
		// 两篇笔记，各读一次：这条记录在一个 body 的一生里按 **PATH** 记忆（见
		// RecentFilesReads），所以过滤、重排以及此后每一次渲染都从记忆里应答 —— 而一次
		// frontmatter 变更恰好丢掉一个 path。
		const h = harness(entries(), 2, files, [], {}, cache);
		expect(h.cacheReads()).toBe(2);

		search(h, 'weekly');
		expect(h.cacheReads()).toBe(2); // 这次查询没多读任何东西
		search(h, '');
		expect(h.cacheReads()).toBe(2); // 清空它也没多读

		h.changeFile('a.md');
		search(h, 'weekly');
		expect(h.cacheReads()).toBe(3); // 一个路径被重读，另一个仍记得
	});

	it('缓存还没回答过的文件会再问一次', () => {
		// 一次同步是这样替换一篇笔记的：把文件删掉，再把下载下来的重命名到它上面（见
		// position/path-bookkeeping.ts），而 app 对一次重命名**不**抛 'changed' —— 所以
		// 一个记住了它那一刻所见的空无的 body，会继续画着一篇搜不到任何小节的笔记，直到
		// 这个 body 自己被扔掉：一次重启，或对话框下一次打开。如今只留**答案**，所以紧接
		// 着的那次渲染会再问一遍 —— 一次 map 查找 —— 而那些小节没有任何事件在背后就回来了。
		const headings: Record<string, unknown[] | Record<string, unknown>> = {};
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1,
			{ 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' }, [], {}, headings);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '尾巴';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		const found = () => h.headings().map(r => r.querySelector('.nav-row-heading')?.textContent);

		expect(found()).toEqual([]); // 还没解析出任何东西：搜不到那一节

		headings['a.md'] = SPREAD_HEADINGS['a.md'];
		h.changed(); // 随便一次重画都行 —— 没有任何东西告诉面板文件变了

		expect(found()).toEqual(['尾巴']);
	});

	it('缓存里什么都没有时，直接从笔记本身读那些小节', async () => {
		// 同一次同步的另一半，也是不会结束的那一半：在手机上缓存不只是答得晚，它可能压根
		// 从不作答 —— 笔记是在 app 底下被替换掉的，而**打开**它也不会让 app 去解析它
		// （编辑器读文本，缓存不读）。一个 body 每五分钟问一次、每一次都听不到任何东西，
		// 于是搜索就搜不到这篇笔记里的任何一节。可是文本就在那儿：那些小节是从它里面读出
		// 来的，晚一次渲染。
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1,
			{ 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' }, [], {}, {});
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '尾巴';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		const found = () => h.headings().map(r => r.querySelector('.nav-row-heading')?.textContent);
		const reads = (path: string) => h.cachedRead.mock.calls.filter(c => c[0].path === path);

		expect(found()).toEqual([]); // 缓存什么都没说，这一行照样被画出来

		// 这次读取落地，而它欠列表的那次重画随之而来（见 LATE_READ_REDRAW_MS）。
		for (let i = 0; i < 10; i++)
			await Promise.resolve();
		vi.advanceTimersByTime(LATE_READ_REDRAW_MS);

		expect(found()).toEqual(['尾巴']);
		// **一次**，不再来第二次：这次读取是对着取它时的那个 mtime 记住的，而那是
		// **外部**变更唯一保有的时钟 —— 没有事件宣告它。
		expect(reads('a.md')).toHaveLength(1);
		h.changed();
		expect(reads('a.md')).toHaveLength(1);
	});

	it('悬停不再为那一行去读文件：行号来自位置数据库', async () => {
		// 一行的「会落在哪儿」是位置数据库的答案（见 describeNavEntry），不是面板从笔记
		// 里读出来的东西 —— 所以一次悬停不欠任何文件一次读取。为**一次重画**读一篇笔记
		// 尚且付不起（见 reads.ts 的 ensureText），一次悬停更读不起。
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1,
			{ 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' }, [], {}, {},
			false, {}, prefs({ focus: 'line' }).browser,
			path => (path === 'a.md' ? { scroll: 35 } : undefined));
		const reads = (path: string) => h.cachedRead.mock.calls.filter(c => c[0].path === path);

		movedOnto(h.note('a'));
		expect(h.trigger).toHaveBeenCalled();
		expect(reads('a.md')).toHaveLength(0);
	});
});

describe('RecentFilesModal —— 列表的长相归设置页管', () => {
	// 列表**印**什么不再由面板选择：工具条那个齿轮从前载着的四个选择如今是插件设置页里的
	// 几行（见 RecentFilesBrowserPrefs），所以这条带子只剩那个框，而一个只活一秒钟的对话框
	// 里反正也没有值得改的东西。
	const entries = () => [
		visit('a.md', NOW - 3 * MINUTE),
		visit('b.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '' };

	it('按插件里现在的那些值画，不提供任何改动的地方', () => {
		const h = harness(entries(), 1, files);

		// 带子上没有齿轮，也就没有挂在它下面的菜单 —— 也没有自己的键要收回：Escape 是
		// app 的（它关掉对话框），而我们没有任何东西立着时，这里什么都不得消费它。
		expect(h.el.querySelector('.position-restore-nav-settings')).toBeNull();
		expect(h.el.querySelector('.position-restore-nav-settings-menu')).toBeNull();
		const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		h.modal.contentEl.dispatchEvent(escape);
		expect(escape.defaultPrevented).toBe(false);

		// 列表印什么就是插件那个值所说的，实时读的：那两篇笔记，按新鲜度（整件事见
		// 那些行的测试）。
		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['b', 'a']);
	});
});

describe('RecentFilesModal —— 已经没了的文件', () => {
	// 文件已经不在了的地点压根不会被列出：没有行、没有落点、没有「你在这里」—— 连读者正
	// 站着的那篇笔记也没有。最近文件 store 在 vault 自己的删除事件上修剪掉这样的地点（见
	// places.ts）；列表在当场就与它一致，而这也就是覆盖那次修剪落地之前那一刻的东西（见
	// RecentFilesList.render）。
	it('已经删掉的笔记整个不进列表', () => {
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'b.md': '' }, ['gone.md']);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['b']);
		// 关于它没有任何东西在屏幕上，无论列表会画的哪种形状
		expect(h.el.querySelector('.is-missing')).toBeNull();
		expect(h.el.textContent).not.toContain('gone.md');
	});

	it('当前笔记的文件已经没了时，不给它画行', () => {
		// 读者很可能正**站在**那个刚被删掉的文件里（标签页在 app 里还开着）。列表照旧
		// 没有它的行：它列的是它能打开的东西，而没有东西声称自己是「这里」。
		const entries = [visit('a.md', NOW - MINUTE), visit('gone.md', NOW)];
		const h = harness(entries, 1, { 'a.md': '' }, ['gone.md']);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['a']);
		expect(h.el.querySelector('.position-restore-nav-row.is-current')).toBeNull();
	});

	it('没了文件的笔记，连搜到的小节也不列', () => {
		// 一篇没被列出的笔记没有一行可以挂那些小节：搜索面先问的是「这一行进不进得来」。
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('b.md', NOW)];
		const h = harness(entries, 1, { 'b.md': '' }, ['gone.md'], {}, {
			'gone.md': A_HEADINGS['a.md'],
		});
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '预览';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.rows()).toHaveLength(0);
		expect(h.notes()).toHaveLength(0);
	});

	it('它记着的每个地点都没了时，说历史是空的', () => {
		// 过滤造出来的那一种情形：一段地点全都点着已没了文件的历史，读起来像空的一样。
		// 那是诚实的答案 —— 这份列表里无处可去 —— 而且它与一段空的历史是**同一条**消息，
		// 因为对读者来说那是同一种处境。
		const entries = [visit('gone.md', NOW - 2 * MINUTE), visit('also-gone.md', NOW)];
		const h = harness(entries, 1, {}, ['gone.md', 'also-gone.md']);

		expect(h.notes()).toHaveLength(0);
		expect(h.el.querySelector('.position-restore-nav-empty')?.textContent).toBe(t('recentFiles.empty'));
	});

	it('仓库里又有了这篇笔记时，把这一行重新画出来', () => {
		// 一次同步把笔记拿走、过一会儿又送回来。那个地点仍在列表里 —— store 只有在一个
		// 足够分辨「替换」与「删除」的宽限窗口之后才会丢掉一个（见 PathBookkeeper）——
		// 所以缺的是那次**绘制**，而 vault 自己那个答案里没有任何东西带着一次绘制。
		const entries = [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
		const gone = ['b.md'];
		const h = harness(entries, 1, { 'a.md': '', 'b.md': '' }, gone);
		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['a']);

		// 替换落地了：vault 说那个文件又在那儿了。
		gone.length = 0;
		h.fileEvent('create', { path: 'b.md' });
		vi.advanceTimersByTime(LATE_READ_REDRAW_MS);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['b', 'a']);
	});
});

describe('RecentFilesModal —— 键盘的无障碍声明', () => {
	// 焦点从不离开过滤框（打字与走动用的是同一批键，列表就靠它们收窄），所以那个框是压在
	// 列表上的一个 ARIA combobox，而当前 option 由 aria-activedescendant 指明。没有那个
	// 属性，方向键挪动的是一个屏幕阅读器看不见的高亮。
	it('把筛选框接到列表上，并让方向键能走', () => {
		const entries = [visit('a.md', NOW - 2 * MINUTE), visit('b.md', NOW - MINUTE), visit('c.md', NOW)];
		const h = harness(entries, 2, { 'a.md': '', 'b.md': '', 'c.md': '' });

		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter');
		const list = h.el.querySelector('.position-restore-nav-list');
		expect(input?.getAttribute('role')).toBe('combobox');
		expect(input?.getAttribute('aria-expanded')).toBe('true');
		// 列表自己的 id，无论浏览器把它编成几号：两头只要一致就行。
		expect(input?.getAttribute('aria-controls')).toBe(list?.id);
		// 打开时什么都没选中，所以还没有东西可宣告。
		expect(input?.hasAttribute('aria-activedescendant')).toBe(false);

		h.key('ArrowDown'); // 第一行：最新的笔记，也就是读者所在的那篇
		const first = h.notes()[0];
		expect(input?.getAttribute('aria-activedescendant')).toBe(first.id);
		expect(first.getAttribute('aria-selected')).toBe('true');

		h.key('ArrowDown');
		const second = h.notes()[1];
		expect(input?.getAttribute('aria-activedescendant')).toBe(second.id);
		expect(second.getAttribute('aria-selected')).toBe('true');
		// 被落下的那一行不再声称自己是当前的。
		expect(first.getAttribute('aria-selected')).toBe('false');
	});
});

describe('RecentFilesModal —— 一篇笔记，一行', () => {
	// **一行 = 一篇笔记**：一次访问记的是「读者在这篇笔记里」，而不是「读者到了这一节」
	//（见 places.ts 的降级），所以一篇被打开十次的笔记是一行。
	const at = (path: string, agoMin: number): NavEntry => visit(path, NOW - agoMin * MINUTE);
	const files = { 'x.md': '', 'y.md': '', 'z.md': '' };

	it('反复访问同一篇笔记，合并成一行', () => {
		// 在被写的笔记与它的参考之间来回跳：每一次回到 x.md 都是**同一行**，无论怎么到
		// 的、到过多少次。一份三行一模一样的「x」是用三种说法说一个目的地，而读者得把
		// 三行都读完才知道这一点。每一处**被访问过多少次**是编年史，那不是这个面板回答的
		// 东西。
		const entries = [
			at('x.md', 30), at('x.md', 25), at('x.md', 20), at('x.md', 10),
			visit('y.md', NOW),
		];
		const h = harness(entries, 4, files);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['y', 'x']);
		// 一个地点也不是个计数：那个「+N」随展开一起走了。
		expect(h.el.textContent).not.toContain('×');
	});

	it('只被访问过一次的笔记就是一行：没有计数、没有插入符', () => {
		// 真实历史里大多数笔记只被访问过一次，而那些没什么可选的：这一行**既是**笔记
		// **也是**读者去过的那个地方，而一个「1」加一个插入符会是花掉两个格子来说它们
		// 底下没有东西。
		const h = harness([at('x.md', 30), visit('y.md', NOW)], 1, files);

		const row = h.note('x');
		expect(row.querySelector('.nav-row-count')).toBeNull();
		expect(row.querySelector('.nav-file-caret')).toBeNull();

		// ……而这一行是个目的地：点它以普通方式打开那篇笔记。
		h.clickRow(h.note('x'));
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
	});

	it('没有坐标的文件也是一行，开过多少次都一样', () => {
		// 一个 `.base` 视图、一份 PDF、一张图：一个里面没地方可**待**的文件。它的每一次
		// 访问都落在同一个地方，所以这篇笔记就是一行。
		const h = harness([
			visit('board.base', NOW - 3 * MINUTE),
			visit('board.base', NOW - 2 * MINUTE),
			visit('board.base', NOW - MINUTE),
			visit('b.md', NOW),
		], 3, { 'board.base': '', 'b.md': '' });

		const row = h.note('board');
		expect(row.querySelector('.nav-row-count')).toBeNull();
		expect(h.notes()).toHaveLength(2);
		// ……而它仍是个目的地：点这一行去的是这篇笔记**最新**的那次访问所在的标签页。
		h.clickRow(row);
		expect(h.jumpTo).toHaveBeenCalledWith(2, undefined);
	});

	it('两篇笔记绝不合并，哪怕它们的步再像', () => {
		// **一个**标签页从 x.md 走到 z.md，而两者都被采集在同一条行上 —— 并排读两篇
		// 笔记的普通方式。不同的笔记永远是不同的行。
		const h = harness([
			at('x.md', 20), at('z.md', 10), visit('y.md', NOW),
		], 2, files);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['y', 'z', 'x']);
	});

	it('按最新那次访问排各篇笔记', () => {
		// x.md 被打开过三次，但它最后一次比 y.md 的那次更旧，所以它排第二：行是那篇
		// 笔记，次序仍然是新鲜度。
		const h = harness([
			at('x.md', 40), at('x.md', 30), at('y.md', 5), visit('z.md', NOW),
		], 3, files);

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['z', 'y', 'x']);
	});
});

// 一个**搜到的小节**是它自己的一行（见 list.ts 的 headingRow）：它不是一条记录 —— 这份
// 列表只记笔记 —— 所以它没有时间、没有 ×、也不能被钉选。但它是一个完整的行：可点、可
// 预览、可被键盘走到，而点它去的是那一节。
describe('RecentFilesModal —— 大纲行', () => {
	const files = { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' };
	const body = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	const search = (h: ReturnType<typeof harness>, query: string) => {
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const found = (h: ReturnType<typeof harness>) =>
		h.headings().map(r => r.querySelector('.nav-row-heading')?.textContent);

	it('没有查询就没有大纲行：它画的是读者**搜到**的东西', () => {
		const h = harness(body(), 1, files, [], {}, SPREAD_HEADINGS);
		expect(h.headings()).toHaveLength(0);

		search(h, '尾巴');
		expect(found(h)).toEqual(['尾巴']);
		// ……而它挂在它的笔记下面，不是顶替它。
		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent)).toEqual(['a']);
	});

	it('按文档顺序画，而不是按它们被访问的先后', () => {
		// 一篇笔记里的小节按它们在那篇笔记里的先后排出来 —— 与读者何时去过无关（见
		// listing.ts 的 matchedHeadings）。
		const h = harness(body(), 1, files, [], {}, SPREAD_HEADINGS);

		search(h, '面板');
		expect(found(h)).toEqual(['面板设计']);
		// 两个词都在**同一个**标题里才算命中，否则退到携带第一个词的那些 —— 两档不混：
		// 一个既给出「面板设计」又给出「设计原则」的列表，答的是两个不同的问题。
		search(h, '设计 预览');
		expect(found(h)).toEqual(['面板设计']);
	});

	it('一篇最多五个：这份列表不是一篇笔记的大纲', () => {
		const many = Array.from({ length: 8 }, (_, i) => ({
			heading: `小节 ${i + 1}`, level: 2, position: { start: { line: i * 2 } },
		}));
		const h = harness(body(), 1, files, [], {}, { 'a.md': many });
		search(h, '小节');

		expect(h.headings()).toHaveLength(5);
	});

	it('关掉那个开关就不再画：搜索框那时不认标题', () => {
		// 「搜到了却不说」是这份列表不做的事（见 list.ts 的 outlineAt）。
		const h = harness(body(), 1, files, [], {}, SPREAD_HEADINGS,
			false, {}, prefs({ outline: false }).browser);

		search(h, '尾巴');
		expect(h.rows()).toHaveLength(0);
	});

	it('大纲行没有时间、也没有 ×：它不是一条可以被丢掉的记录', () => {
		const h = harness(body(), 1, files, [], {}, SPREAD_HEADINGS,
			false, {}, prefs({ time: true }).browser);
		search(h, '尾巴');
		const row = h.heading('尾巴');

		expect(row.querySelector('.nav-row-time')).toBeNull();
		expect(row.querySelector('.nav-row-forget')).toBeNull();
		// ……它也没有钉选可给：钉选是给一篇笔记的书签，而那一节不是一条记录（见
		// body.ts 的 pinItems）。
		h.rightClick(row);
		expect(Menu.shown.at(-1)!.items.map(item => item.title))
			.toEqual([t('recentFiles.openHereInNewTab')]);
	});

	it('悬停补上那一节在笔记里的位置，而且只在不止一层时才说', () => {
		// 行上印的只是那一节自己的名字，而两个同名的小节只靠它是分不开的。
		const h = harness(body(), 1, files, [], {}, SPREAD_HEADINGS);
		search(h, '尾巴');

		// 「尾巴」上面还有一层。
		expect(h.hover(h.heading('尾巴'))!.querySelector('.nav-tip-trail')?.textContent)
			.toBe('面板设计 › 尾巴');
	});
});


// 一行对背后那个**文件**说什么：不带扩展名的名字、值得说类型时的类型**徽标**、按设置
// 要求那一侧的文件夹，以及悬停上的完整路径（见 displayName / badgeOf / PathDisplayMode）。
describe('RecentFilesModal —— 名字、类型和路径', () => {
	const files = {
		'a/index.md': '', 'b/index.md': '', 'notes.md': '',
		'report.pdf': '', 'LICENSE': '', 'board.canvas': '',
	};
	const stack = (): NavEntry[] => [
		visit('a/index.md', NOW - 6 * MINUTE),
		visit('b/index.md', NOW - 5 * MINUTE),
		visit('notes.md', NOW - 4 * MINUTE),
		visit('report.pdf', NOW - 3 * MINUTE),
		visit('LICENSE', NOW - 2 * MINUTE),
		visit('board.canvas', NOW),
	];
	// 一行按它所代表的**文件**来找到，依据的是这一行**印**出来的东西：两篇 index 笔记印
	// 同一个名字，所以单靠名字不成其为查找依据，而区分它们的是文件夹 —— 'smart' 恰好印
	// 冲突所需的那些文件夹，两个「always」模式则把它们全印出来，所以那个「名字 + 文件
	// 夹」的组合在每种设置下都是唯一的。tooltip 如今**不再**是查找依据：它属于面板，只在
	// 指针停在某一行上时才存在于 document 里（见 tip.ts）。
	const rowFor = (h: ReturnType<typeof harness>, path: string) => {
		const cut = path.lastIndexOf('/');
		const folder = cut < 0 ? '/' : path.slice(0, cut + 1);
		const file = path.slice(cut + 1).replace(/\.[^./]+$/, '');
		const row = h.notes().find(r =>
			r.querySelector('.nav-row-name')?.textContent === file
			&& (r.querySelector('.nav-row-path')?.textContent ?? '/') === folder);
		expect(row, `no row for ${path}`).toBeDefined();
		return row!;
	};
	const attr = (row: HTMLElement) => ({
		name: row.querySelector('.nav-row-name')?.textContent,
		badge: row.querySelector('.nav-file-tag')?.textContent,
		path: row.querySelector('.nav-row-path')?.textContent,
	});
	// 一个文件的行在悬停上说什么，按 fixture 给它起的那个路径找到它。
	const hoverOf = (h: ReturnType<typeof harness>, path: string) => h.hover(rowFor(h, path));
	// 这个栈里**一篇**笔记的元数据：它另有名字，那些名字在行上哪儿都不印，而它们是一行
	// 已经印了路径时悬停还唯一能补充的东西（见别名套件与 fileRow）。
	const cache = {
		'a/index.md': { headings: [], frontmatter: { title: 'Weekly sync', aliases: ['周会', 'standup'] } },
	};

	it('名字不带扩展名，除 markdown 外的每种类型都带标记', () => {
		const h = harness(stack(), 5, files);

		expect(attr(rowFor(h, 'notes.md')))
			.toEqual({ name: 'notes', badge: undefined, path: undefined });
		// 一份 PDF 会大写地说出这件事 —— 扩展名不是它印在下面的那个名字的一部分，所以
		// 徽标是唯一说出类型的地方。
		expect(attr(rowFor(h, 'report.pdf')))
			.toEqual({ name: 'report', badge: 'PDF', path: undefined });
		// ……而没有扩展名的文件也拿到一个，否则「没有徽标」会同时意味着「markdown」与
		// 「类型未知」（见 badgeOf）。
		expect(attr(rowFor(h, 'LICENSE')))
			.toEqual({ name: 'LICENSE', badge: 'FILE', path: undefined });
		expect(attr(rowFor(h, 'board.canvas')))
			.toEqual({ name: 'board', badge: 'CANVAS', path: undefined });
	});

	it('行上没印路径的地方，提示条带上文件的完整路径，连扩展名一起', () => {
		// 行既不印扩展名、也不（默认）印文件夹，所以 tooltip 是两者还能被说出的最后地方。
		// 它是**面板的** tooltip、不是它从前那个原生的 `title`（见 tip.ts）：浏览器原生
		// tooltip 没法被样式化，而这个是必须可读的 —— 它也不是写成 `aria-label`，那会
		// **替换**掉这个 option 的无障碍名称（见 fileRow）。
		const h = harness(stack(), 5, files);

		expect(h.hover(rowFor(h, 'notes.md'))!.querySelector('.nav-tip-path')?.textContent)
			.toBe('notes.md');
		h.unhover(rowFor(h, 'notes.md'));
		expect(h.hover(rowFor(h, 'LICENSE'))!.querySelector('.nav-tip-path')?.textContent)
			.toBe('LICENSE');
	});

	it('行上已经印了路径的地方，悬停时不再说', () => {
		// 读者把路径打开，就是要它们（见 PathDisplayMode），所以悬停没有东西可补了：一个
		// 印出自己文件夹的行，就是一个在悬停上什么都不说的行 —— 光一个扩展名不值一个
		// tooltip（见 fileRow）。这就是这条规则的全部，它两半都说了。
		const always = harness(stack(), 5, files, [], {}, {}, false, {}, prefs({ path: 'before' }).browser);
		for (const path of ['a/index.md', 'notes.md', 'report.pdf', 'LICENSE', 'board.canvas'])
			expect(hoverOf(always, path), path).toBeNull();

		// ……而在 'smart' 下同一条规则挑出那些印文件夹的行：两篇 index 笔记撞名、印了
		// 自己的文件夹，所以它们在悬停上什么都不说，而一个文件夹**没被**印出的行仍会说
		// 出整条路径。
		const smart = harness(stack(), 5, files);
		expect(hoverOf(smart, 'a/index.md')).toBeNull();
		expect(hoverOf(smart, 'b/index.md')).toBeNull();
		expect(hoverOf(smart, 'notes.md')?.querySelector('.nav-tip-path')?.textContent).toBe('notes.md');
	});

	it('行上印了路径的地方，照样说别的名字', () => {
		// 那些名字在行上哪儿都不印、且可搜索，所以它们是悬停还欠一个把路径显示在屏幕上的
		// 读者的唯一一样东西 —— 路径那一行走了，名字那一行留着（见 fileRow）。
		const h = harness(stack(), 5, files, [], {}, cache, false, {}, prefs({ path: 'after' }).browser);

		const tip = h.hover(rowFor(h, 'a/index.md'))!;
		expect(tip.querySelector('.nav-tip-path')).toBeNull();
		expect(Array.from(tip.querySelectorAll('.nav-tip-text')).map(l => l.textContent))
			.toEqual([
				`${t('recentFiles.title')} Weekly sync`,
				`${t('recentFiles.aliases')} 周会 · standup`,
			]);
	});

	it('无路径视图带个标记，此外不再说它什么', () => {
		// 图谱是一个视图、不是一个文件：它没有类型可标、也没有路径可印或可悬停 —— 它的
		// 名字是视图自己的标签，或本列表给一个没有标签的视图的措辞（见 model.ts 的
		// viewName）。这一行**确实**印的是那个把视图与笔记区分开的标记（见 list.ts 的
		// fileRow），而一个没起图标名的视图用一个**词**来标，而不是一个替身字形。
		const h = harness([
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
			...stack(),
		], 6, files);

		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		expect(graph).toBeDefined();
		expect(attr(graph)).toEqual({ name: t('recentFiles.graphView'), badge: t('recentFiles.viewBadge'), path: undefined });
		expect(graph.querySelector('.nav-row-view-icon')).toBeNull();
		expect(h.hover(graph)).toBeNull();
	});

	it('画出视图自己起的那个图标，代替文字', () => {
		// 问一个视图要它的图标，与问它要名字的方式一样（见 shared/leaf.ts 的 viewIcon）：
		// 于是这一行戴上读者在那个视图的标签页上见过的同一个标记，而本插件无需知道那是
		// 哪个插件。那个词是这个标记所**替换**的东西 —— 两者从不并立。
		const h = harness([
			{ kind: 'view', viewType: 'thino_view', label: 'Thino', icon: 'git-fork', leafId: 'leaf-1', t: NOW } as NavEntry,
			...stack(),
		], 6, files);

		const row = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === 'Thino')!;
		expect(row).toBeDefined();
		expect(attr(row).badge).toBeUndefined();
		const mark = row.querySelector('.nav-row-view-icon')!;
		expect(mark.querySelector('svg')?.getAttribute('data-icon')).toBe('git-fork');
		// 是为看不见那个字形的读者命名的：这个图标代表的正是回退方案本会印出的那个词。
		expect(mark.getAttribute('aria-label')).toBe(t('recentFiles.viewBadge'));
	});

	it('每一行都印上文件夹，按设置要求的那一侧', () => {
		const ctx = (path: 'before' | 'after') =>
			harness(stack(), 5, files, [], {}, {}, false, {}, prefs({ path }).browser);
		// 'before' 是快速切换器的形状：整条路径铺在名字前面，而这一行排不下时**名字**是
		// 被丢掉的那个（见 styles.css）。
		const before = ctx('before');
		expect(attr(rowFor(before, 'a/index.md')).path).toBe('a/');
		expect(attr(rowFor(before, 'notes.md')).path).toBe('/');
		expect(before.notes().every(r => r.classList.contains('is-path-before'))).toBe(true);

		// 'after' 印同样的那些文件夹，丢掉的却是**路径**：名字留在左列，而那就是选它的
		// 全部理由。
		const after = ctx('after');
		expect(attr(rowFor(after, 'a/index.md')).path).toBe('a/');
		expect(after.notes().some(r => r.classList.contains('is-path-before'))).toBe(false);
		// **仓库根**在每种模式下都印「/」而不是什么都不印：一个空格子是「没有文件夹可印
		// 的笔记」的样子，而这是两件不同的事实（见 fileRow）。
		expect(attr(rowFor(after, 'notes.md')).path).toBe('/');
	});

	it('默认只在名字撞车的那几行印文件夹', () => {
		// 'smart' 是默认，也是说得最少的那个设置：文件夹是消歧用的，所以它恰好出现在有
		// 东西要消歧的地方 —— 别处一概不出现。
		const h = harness(stack(), 5, files);

		expect(rowFor(h, 'a/index.md').querySelector('.nav-row-path')?.textContent).toBe('a/');
		expect(rowFor(h, 'b/index.md').querySelector('.nav-row-path')?.textContent).toBe('b/');
		expect(rowFor(h, 'notes.md').querySelector('.nav-row-path')).toBeNull();
		expect(rowFor(h, 'report.pdf').querySelector('.nav-row-path')).toBeNull();
		// ……而它把那些行排得像 'before'，因为名字前面的那个文件夹正是那些消歧行所要的。
		expect(rowFor(h, 'a/index.md').classList.contains('is-path-before')).toBe(true);
	});
});

// 行的 tooltip 作为一个来而复去的东西（见 tip.ts）。它如今是面板自己的元素，画在
// document 上而不是由浏览器画，所以它**何时**在那儿是面板的决定：划过列表的指针什么都
// 不说，停住的指针拿到一个答案，而它描述的东西一旦不再是指针所在的那个、或干脆不再在
// 屏幕上，答案就走。
describe('RecentFilesModal —— 行的提示条', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const entries = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	const tip = () => document.querySelector<HTMLElement>('.position-restore-nav-tip');

	it('只有在行上停住的指针才应答', () => {
		// 一个在指针碰到行的瞬间就出现的 tooltip，会是一条以鼠标速度沿列表闪下的文字带
		// （见 TIP_DELAY_MS）。
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
		expect(tip()).toBeNull();

		vi.advanceTimersByTime(TIP_DELAY_MS);
		expect(tip()?.querySelector('.nav-tip-path')?.textContent).toBe('a.md');
	});

	it('只是从行上划过的指针，什么都不说', () => {
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
		row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
		vi.advanceTimersByTime(TIP_DELAY_MS);

		expect(tip()).toBeNull();
	});

	it('指针离开这一行就把答案收走', () => {
		// 一行就是一个目标：tooltip 属于指针**所在**的东西，而指针移开它 —— 哪怕是移到
		// 另一个什么都不说的行上 —— 就把它带走。
		const h = harness(entries(), 1, files);

		expect(h.hover(h.note('a'))).not.toBeNull();
		expect(h.unhover(h.note('a'))).toBeNull();
	});

	it('底下的列表重建时把它收走', () => {
		// 每一次按键都会重画那些行，所以一个被留下的 tooltip 会指着一条已经不存在的行
		// —— 并在描述一份读者刚刚过滤过的列表（见 RecentFilesList.render）。
		const h = harness(entries(), 1, files);
		expect(h.hover(h.note('a'))).not.toBeNull();

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		expect(tip()).toBeNull();
	});

	it('滚动时收走，即将前往的那一次按下也收走', () => {
		// tooltip 是钉在行自己那个盒子上的、不随它动：一次滚动会把它挂在滑到它底下的
		// 任何东西上方。一次按下是同一件事实晚一刻的样子 —— 这一行即将打开，或列表即将
		// 被重建。
		const h = harness(entries(), 1, files);
		expect(h.hover(h.note('a'))).not.toBeNull();
		h.list().dispatchEvent(new Event('scroll'));
		expect(tip()).toBeNull();

		expect(h.hover(h.note('a'))).not.toBeNull();
		h.pressRow(h.note('a'));
		expect(tip()).toBeNull();
	});

	it('把它画在 document 上，在面板自己的元素之外', () => {
		// 它必须能挂在列表**下面** —— 靠近末尾的那些行正是读者最需要它的 —— 而列表会
		// 滚动并裁掉自己的内容。
		const h = harness(entries(), 1, files);
		const shown = h.hover(h.note('a'))!;

		expect(h.el.contains(shown)).toBe(false);
		expect(shown.parentElement).toBe(document.body);
	});

	it('面板关掉时把它的元素一起带走', () => {
		// tooltip 是 body 放在它自己元素**外面**的唯一一样东西，所以移除面板的东西都
		// 移除不了它（见 RecentFilesBrowser.destroy）。
		const h = harness(entries(), 1, files);
		expect(h.hover(h.note('a'))).not.toBeNull();

		h.modal.close();

		expect(tip()).toBeNull();
	});
});

// 每一行的笔记上次被访问是**多久以前**（见 model.ts 的 ageLabel）。它是个开关、不是
// 一个刻度：关掉时，那些行与这个标注存在之前一模一样；打开时，每一行都带一个 —— 包括
// 背后压根没有文件的行。
describe('RecentFilesModal —— 行上的时间', () => {
	const DAY = 24 * 60 * MINUTE;
	const HOUR = 60 * MINUTE;
	const on = () => prefs({ time: true }).browser;
	// **最旧的在前**，照 store 真正保存它们的样子（见 places.remember）：列表自己的
	// 次序是倒着扫这个数组，所以一个把它打乱的 fixture 测的会是面板从没见过的次序。
	const stack = (): NavEntry[] => [
		visit('notes.md', NOW - 3 * DAY),
		{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW - 2 * HOUR } as NavEntry,
		visit('a/index.md', NOW - 5 * MINUTE),
	];
	const files = { 'a/index.md': '', 'notes.md': '' };
	const times = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-time')?.textContent);

	it('默认关闭，行上一点痕迹都不留', () => {
		// 不是藏起来而是**不在**：那条设置是这个元素存在的唯一理由，而一个留在 DOM 里
		// 等着被样式化掉的 span 仍会是一个行自己的网格要排布的格子。
		const h = harness(stack(), 2, files);

		expect(h.notes().length).toBeGreaterThan(0);
		expect(h.el.querySelectorAll('.nav-row-time')).toHaveLength(0);
		// ……而没有行认领那条远端轨道：一行的**形状**跟着它的标注走（见 is-timed），
		// 所以一份把标注关掉的列表不会为它们花掉第二列。
		expect(h.el.querySelectorAll('.is-timed')).toHaveLength(0);
	});

	it('说出每篇笔记有多旧，按它最新那一步算', () => {
		const h = harness(stack(), 2, files, [], {}, {}, false, {}, on());

		// 次序是各行自己的年纪：a/index.md（5m），然后是图谱（2h），再是 notes.md
		// （3d）。一个视图与别的地点一样是个带时间的地点，所以它站在那个时间把它放的
		// 位置 —— 不是列表的末尾（见 groupByFile）。
		expect(h.notes()).toHaveLength(3);
		expect(times(h)).toEqual(['5m ago', '2h ago', '3d ago']);
	});

	it('无路径视图也标时间，每一行都同一个算法', () => {
		// 图谱与别行一样是一行、也与别行一样被访问过：它答不出的东西是**文件**（没有
		// 路径、没有类型 —— 见 badgeOf），不是时间。
		const h = harness(stack(), 2, files, [], {}, {}, false, {}, on());
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

		expect(graph.querySelector('.nav-row-time')?.textContent).toBe('2h ago');
		expect(graph.classList.contains('is-timed')).toBe(true);
		expect(graph.querySelector('.nav-row-path')).toBeNull();
	});

	it('精确时刻放在这个标签自己的提示里', () => {
		// 那个标注是缩写的（「5m 前」），所以那个时刻离悬停只有一步 —— 而它是**时间**
		// 的 tooltip，所以这一行自己的那个仍说着是哪个文件。时间在这个行**里面**，所以
		// 这里是指针最近的标的不是这一行本身的唯一地方（见 NavRowTip.subject）。
		const h = harness(stack(), 2, files, [], {}, {}, false, {}, on());
		const label = h.note('notes').querySelector<HTMLElement>('.nav-row-time')!;

		expect(h.hover(label)?.textContent).toBe(new Date(NOW - 3 * DAY).toLocaleString());
		h.unhover(label);
		expect(h.hover(h.note('notes'))?.querySelector('.nav-tip-path')?.textContent).toBe('notes.md');
	});

	it('每个带时间的行都给一条容下它的远侧轨道，有没有文件夹都一样', () => {
		// 年纪是**行**的格子、不是名字的格子（见 RecentFilesList.fileRow）：正是这一点
		// 把每一行的标注放在列表里同一个 x 上，无论这一行旁边印什么。样式表所读的那个
		// class 是**随**标注一起写上的，所以一行没法认领一条它没东西可放的轨道 —— 而那
		// 个标注是这一行的子节点，因为放在名字格子里它会成为参与换行的一部分，而那条轨道
		// 存在的意义正是保住那一列。
		const smart = harness(stack(), 2, files, [], {}, {}, false, {}, on());
		const graph = smart.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		expect(smart.note('notes').classList.contains('is-timed')).toBe(true);
		expect(graph.classList.contains('is-timed')).toBe(true);
		// 一个 'smart' 下名字没有冲突的行压根不印文件夹……
		expect(smart.note('notes').querySelector('.nav-row-path')).toBeNull();
		expect(graph.querySelector('.nav-row-path')).toBeNull();
		// ……而那个标注是这一行自己的子节点，不是名字格子的。
		expect(smart.note('notes').querySelector('.nav-row-time')!.parentElement)
			.toBe(smart.note('notes'));

		// 在 'always' 下根笔记印「/」，那是行上一个与别个一样的文件夹 —— 而它保留它的
		// 年纪所处的那同一条远端轨道。
		const always = harness(stack(), 2, files, [], {}, {}, false, {}, prefs({ time: true, path: 'before' }).browser);
		expect(always.note('notes').querySelector('.nav-row-path')?.textContent).toBe('/');
		expect(always.note('notes').classList.contains('is-timed')).toBe(true);
		expect(always.note('notes').querySelector('.nav-row-time')!.parentElement)
			.toBe(always.note('notes'));
	});
});

// 当读者发话时，一行开在**哪儿**：修饰键、中键、键盘自己的等价键，以及右键时 app 的
// 菜单。它们中大多数讲的是其中哪些由 app 决定、而不是由本插件决定（见
// Keymap / PaneTarget）。
describe('RecentFilesModal —— 一行开到哪儿，以及右键菜单', () => {
	// a.md 是**更旧**的那篇笔记，所以按新鲜度它排**第二**：两行，b.md 在前。
	const files = { 'a.md': '', 'b.md': '' };
	const entries = (): NavEntry[] => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	// 一个**搜到的小节**的行：它不是一条记录 —— 这份列表只记笔记 —— 所以它去的是那
	// 一节，而不是那篇笔记（见 list.ts 的 headingRow）。它是唯一能许诺一处**地点**
	// 而非一个文件的行。
	const hitRow = (query: string) => {
		const h = harness(entries(), 1, { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' },
			[], {}, SPREAD_HEADINGS);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		return h;
	};
	// 浏览器交给 app 的那个菜单：app 的事件把它作为第二个参数带着，而插件的贡献就显现在
	// 那里。
	const menuOf = (trigger: unknown) => {
		const calls = (trigger as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls).toHaveLength(1);
		return calls[0][1] as { items: { title: string; section: string; icon: string; click?: () => void }[] };
	};

	it('问 app 该开到哪儿，就在那儿打开', () => {
		// 一次普通点击：app 说「它本来就在的地方」（它的 `false`），而本插件把它归成
		// 压根没有目标（见 RecentFilesList.onClick）。
		const h = harness(entries(), 1, files);
		h.clickRow(h.note('a'));
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);

		// ……而按着修饰键时，这一行开在**app** 说的那个地方 —— 插件自己从不读
		// ctrlKey/metaKey，所以一个插件一无所知的平台也仍是 app 的答案。
		const held = harness(entries(), 1, files);
		KeymapKnobs.modEvent = 'tab';
		held.clickRow(held.note('a'));
		expect(held.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('中键点击在新标签页里打开，从按下那一刻就开始', () => {
		// 中键抛的是 `auxclick`、不是 `click`，所以一个等点击的处理程序永远跑不到；而在
		// 按下时 preventDefault 正是把 WebView 的中键自动滚动挡在列表之外的东西（见
		// RecentFilesList.onPress）。
		const h = harness(entries(), 1, files);
		const press = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 1 });
		h.note('a').dispatchEvent(press);

		expect(press.defaultPrevented).toBe(true);
		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('其它按键的按下不理会', () => {
		// 右键抛出这一行的菜单、从不抛出点击（见下面那个套件）；别的任何东西 —— 第四个
		// 键、一个汇报悬停的指针 —— 不打开任何东西，也不声称任何东西。
		const h = harness(entries(), 1, files);
		for (const button of [2, 3, 4])
			h.note('a').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }));
		h.clickRow(h.note('a'));

		// 这次点击由它落着的那一行来应答，而不是由一个走岔的按下留下的身份来应答：a.md
		// 是第二行，它的地点下标是 0，而 b.md 的是 1。
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
		expect(h.trigger).not.toHaveBeenCalled();
	});

	it('Cmd/Ctrl+Enter 把一行开在新标签页里', () => {
		// 焦点从不离开过滤框，所以一行的修饰键点击够不到：键盘自己的那个答案才是 app 里
		// 每份列表都接受的手势。修饰键按没按着由 app 说了算（见 Keymap.isModifier）。
		const h = harness(entries(), 1, files);
		h.key('ArrowDown'); // b.md，当前笔记 —— 也是最新的，所以是第一行
		h.key('ArrowDown'); // a.md
		KeymapKnobs.modifier = true;
		h.key('Enter');

		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('给文件行交给 app 一份菜单，自己的几项排在最上面', () => {
		// 那个菜单是 app 的 —— 读者能对一个文件做什么不是本插件的事 —— 而加进去的是 app
		// 无法知道的东西：这一行代表一个**地点**，所以这里的「开在新标签页里」意味着这
		// 篇笔记、在那一行代表的那处地点上；以及这篇笔记有没有被钉住，那是本列表自己、
		// 不是别人的答案。把这一行拿掉已经不在里面了：那是这一行自己带的那个 ×，它不需要
		// 有文件可关于（见下面两个测试）。
		const h = harness(entries(), 1, files);
		const ev = h.rightClick(h.note('a'));

		expect(ev.defaultPrevented).toBe(true); // 长按的浮层绝不能升起
		const menu = menuOf(h.trigger);
		expect(menu.items.map(i => i.title))
			.toEqual([t('recentFiles.openInNewTab'), t('recentFiles.pin')]);
		expect(menu.items[0].title).toBe(t('recentFiles.openInNewTab'));
		expect(menu.items[0].section).toBe('action');
		// ……而它带着 app 自己的新标签页字形，所以这一项读起来像是上面那一行里 app 自己
		// 的承诺，而不是第二种打开方式。
		expect(menu.items[0].icon).toBe('file-plus');
		// 要的 context 是**链接**的，不是文件管理器的：那里该有什么由 app 决定，而文件
		// 管理类的动作不在其内（见 contextRow）。
		expect(h.trigger).toHaveBeenCalledWith(
			'file-menu', menu, expect.objectContaining({ path: 'a.md' }), 'link-context-menu',
		);

		// ……而点那一项会把这一行自己的地点开在隔壁标签页里 —— 与普通点击打开的是同一个
		// 地点。
		menu.items[0].click!();
		expect(h.jumpTo).toHaveBeenCalledWith(0, 'tab');
	});

	it('用它上面的 × 把这一行从列表里拿掉', () => {
		// 面板所做的唯一一次写（见 body.ts 的 forgetRow），而它只写到列表、不再往前：
		// 文件本身与位置库都没被碰（见 NavPlaces.forget）。这一行必须随它一起离开屏幕
		// —— 一个让它立着的 × 会读起来像什么都没做。
		const h = harness(entries(), 1, files);
		const names = () => h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);
		expect(names()).toContain('a');

		h.clickRow(h.forgetButton(h.note('a')));

		// ……而那一次点击**没有打开**任何东西：应答它的是那个 ×，不是这一行（见
		// RecentFilesList.fileRow —— 两个手势只隔一行）。
		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.forget).toHaveBeenCalledWith('a.md');
		// ……而且只有那一行：被移除的笔记不是当前那篇，所以列表少了一篇笔记，而位置仍在
		// b.md 上。
		expect(names()).not.toContain('a');
		expect(names()).toEqual(['b']);
	});

	it('读者伸手去点 × 时不打开笔记', () => {
		// 按下与点击都在 × **处**被拦住，而不是放任它冒泡（见 RecentFilesList.fileRow）：
		// 若让按下穿过去，这一行就会被记成按下过，而松开就会打开读者正想丢掉的那个文件
		// —— 那正是 × 存在的意义所要区分开的结果。
		const h = harness(entries(), 1, files);
		const button = h.forgetButton(h.note('a'));

		h.pressRow(button);
		h.clickRow(button);

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(h.forget).toHaveBeenCalledWith('a.md');
	});

	it('行代表的是一个搜到的小节时，自己那一项说的是「在这里打开」', () => {
		// 一个大纲行打开的是它所代表的那一**节**（见 HeadingHit），所以「开在新标签页
		// 里」会是一个它兑不了的承诺：它开在**这里**，就是那一处。
		const h = hitRow('尾巴');
		h.rightClick(h.heading('尾巴'));

		const menu = menuOf(h.trigger);
		expect(menu.items[0].title).toBe(t('recentFiles.openHereInNewTab'));
		// ……而点那一项把那一节开在隔壁标签页里 —— 与普通点击打开的是同一处。
		menu.items[0].click!();
		// 那一节、它此刻在哪一行、它上面那一行一贯去往的那个标签页。
		expect(h.jumpToHeading).toHaveBeenCalledWith('a.md', '尾巴', 33, 'leaf-1', 'tab');
	});

	it('无路径视图用自己那份菜单，什么都不去问 app', () => {
		// 图谱不是一个文件，所以没有可关于它的文件菜单：出来的是本列表自己的那两项，而且
		// **没有** `file-menu` 事件被发出 —— 那会请 app 去说一个并不存在的文件。
		const h = harness([
			visit('a.md', NOW - MINUTE),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
		], 1, files);
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;
		const ev = h.rightClick(graph);

		expect(ev.defaultPrevented).toBe(true);
		expect(h.trigger).not.toHaveBeenCalled();
		// ……而它被放上了屏幕，这是读一个没有任何事件为它抛出过的菜单的唯一办法（见
		// obsidian-stub 的 Menu.shown）。
		const menu = Menu.shown.at(-1)!;
		expect(menu.shownAt).toBeDefined();
		expect(menu.items.map(i => i.title))
			.toEqual([t('recentFiles.openInNewTab'), t('recentFiles.pin')]);
	});

	it('无路径视图也配上和笔记一样的 ×，它那一行反正也是一行', () => {
		// 图谱被拒绝一个**文件**菜单 —— 没有文件可给一个菜单去关于 —— 而当年移除就住在
		// 那个菜单里的时候，这次拒绝让它压根没有离开列表的路。× 不需要文件，所以每一行都
		// 带一个（见 RecentFilesList.fileRow）。
		const h = harness([
			visit('a.md', NOW - MINUTE),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
		], 1, files);
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

		h.clickRow(h.forgetButton(graph));

		// store 听到的是这一行自己的身份：一个视图由它的 **TYPE** 来命名，而那恰恰是
		// path 说不出的东西（见 nav/entry.ts 的 navGroupKey）。
		expect(h.forget).toHaveBeenCalledWith('view:graph');
	});

	it('行背后的文件已经没了时，不弹菜单', () => {
		// 列表打不开其文件的地点压根**不被绘制**（见 RecentFilesList.render），所以这里
		// 唯一的可能是那个文件走掉在渲染与右键之间 —— 一次同步把它删了、一次删除刚落定。
		// 那时就没有东西可向 app 询问了。
		const deleted: string[] = [];
		const h = harness(entries(), 1, files, deleted);
		const row = h.note('a');
		deleted.push('a.md');

		const ev = h.rightClick(row);

		expect(ev.defaultPrevented).toBe(true);
		expect(h.trigger).not.toHaveBeenCalled();
	});
});

describe('RecentFilesModal —— 同名的笔记', () => {
	// 这个面板用在仓库里，不是代码仓库里：「index.md」在五个文件夹里都有，而一个只印它最后
	// 一段路径的行会把五个都叫成同一个名字。文件夹恰好印在名字撞车的地方、别处一概不印 ——
	// 一个名字唯一的行只印名字。
	const files = { 'a/index.md': '', 'b/index.md': '', 'notes.md': '' };

	it('两篇笔记同名时印上文件夹，别的地方不印', () => {
		const h = harness([
			visit('a/index.md', NOW - 3 * MINUTE),
			visit('b/index.md', NOW - 2 * MINUTE),
			visit('notes.md', NOW),
		], 2, files);

		const folders = h.notes().map(r => r.querySelector('.nav-row-path')?.textContent ?? '');
		expect(folders).toEqual(['', 'b/', 'a/']); // notes.md（当前）在前，然后是两篇 index.md，最新的在前
		expect(h.note('notes').querySelector('.nav-row-path')).toBeNull();
		// 文件夹排在它所消歧的名字**前面** —— 靠一个 **class**，不是靠插入次序：这一行
		// 是名字先建的，好让它无论怎么画都**读**得一样，而把路径放到前面的是样式表的
		// `order`（见 styles.css，以及没有应用它的 `after` 模式）。
		const index = h.note('index');
		expect(index.classList.contains('is-path-before')).toBe(true);
		// ……而**名字与它的标记**是一整块：两个兄弟节点会让那个格子从它们之间换行，把
		// 类型印在它所归属的名字下面单独一行（见 styles.css 的 .nav-row-head）。文件夹
		// 是这个格子的另一半。
		expect([...index.querySelector('.nav-row-file')!.children].map(el => el.className))
			.toEqual(['nav-row-head', 'nav-row-path']);
		expect([...index.querySelector('.nav-row-head')!.children].map(el => el.className))
			.toEqual(['nav-row-name']);
	});

	it('位于仓库根目录的同名笔记也给它一个文件夹可显示', () => {
		// 「/」与「a/」是两个答案，而两者都不是空白：一个空格子是 /-笔记从前渲染出来的
		// 样子，那读起来像「没有文件夹」，而不是「根」。
		const root = harness([
			visit('index.md', NOW - 3 * MINUTE),
			visit('a/index.md', NOW),
		], 1, { 'index.md': '', 'a/index.md': '' });

		// a/index.md 是当前 entry，所以它在前；根笔记跟着。
		const folders = root.notes().map(r => r.querySelector('.nav-row-path')?.textContent);
		expect(folders).toEqual(['a/', '/']);
	});

	it('撞名一消失就把文件夹去掉', () => {
		// 一个被查询移除掉的冲突不在屏幕上、没什么可混淆的，所以活下来的那一行不再为它
		// 付代价。
		const h = harness([
			visit('a/index.md', NOW - 3 * MINUTE),
			visit('b/index.md', NOW),
		], 1, files);

		expect(h.notes()[0].querySelector('.nav-row-path')).not.toBeNull();

		const input = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		input.value = 'a/index';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].querySelector('.nav-row-path')).toBeNull();
	});
});


describe('RecentFilesModal —— 触屏', () => {
	// 三篇笔记，停在 c.md 上：每篇笔记一行，而那是这里每个测试所关于的形状。
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const entries = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];

	it('用 × 清空输入框，不把键盘叫出来', () => {
		// 面板在触屏上刻意让那个框不被聚焦 —— 屏幕键盘盖住半个手机（见 body.ts 的
		// mount）—— 所以那个 × 也不得把焦点放到那儿：点它的手指是在清空，不是打字。
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.notes()).toHaveLength(1);

		h.clearFilter();

		expect(box.value).toBe('');
		expect(h.notes()).toHaveLength(3);
		expect(document.activeElement).not.toBe(box);
	});

	it('点在行内任何一个格子上都算点在行上', () => {
		// 触屏 WebView 在点击前发 mousemove。手指底下是哪一格不改变发生的事：笔记自己的
		// 名字格子与这一行的内边都作用在这一行上 —— 而这一行做的是**打开**它代表的那个
		// 文件（见 RecentFilesList.onClick）。
		const h = harness(entries(), 2, files, [], {}, {}, true);
		h.note('b').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		const target = h.note('b').querySelector<HTMLElement>('.nav-row-file')!;

		target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0 }));
		target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('无视点按合成出来的那次 mousemove，好让随后的点击仍然打开笔记', () => {
		// 触屏 WebView 在点击前发 mouseover/mousemove。列表已经没有 mousemove 处理程序
		// 把那个当成悬停（见 RecentFilesList），所以那份指针报告什么都不选中 —— 而后面
		// 的点击是这一行自己的，它打开文件，而不是被读成对一行已经打开过的行的第二次
		// 按下。
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const row = h.note('b');

		row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
		expect(row.classList.contains('is-selected')).toBe(false);

		h.clickRow(row);
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('带指针的设备一次点击就能从行本身打开文件', () => {
		// 这一行不是触屏专属的交互：鼠标得到的是同一次点击，而它就是整段行程 —— 一次按
		// 下、一个目的地，面板与它毫无关系（见 RecentFilesList.onClick）。
		const h = harness(entries(), 2, files);

		h.clickRow(h.note('b'));
		expect(h.jumpTo).toHaveBeenCalledWith(1, undefined);
	});

	it('右键不打开任何东西，并拒绝这次手势', () => {
		const h = harness(entries(), 2, files);

		const ev = h.rightClick(h.note('b'));

		// 一行靠点它来打开。右键从前也会行进 —— 那是给一只已经停在上面的手准备的快捷
		// 方式 —— 而那已经没了：一个含义一个手势，而看得见的那个是点击（见
		// RecentFilesList.onContextMenu）。
		expect(h.jumpTo).not.toHaveBeenCalled();
		// ……而它仍被拒绝，而不是交给 app：一行没有文本可复制、没有东西可检查，而长按
		// 不得在列表上方拉起任何 callout。
		expect(ev.defaultPrevented).toBe(true);
	});

	it('只是按住没动的那次按下，不会前往', () => {
		const h = harness(entries(), 2, files);
		const row = h.note('b');

		// WebView 为一次长按触、也为一次右键抛 `contextmenu`，而两者靠事件带的那个
		// **button** 分辨：真实的右键按下是 2，一根逗留的手指所带的是左键的 0。把后一个
		// 当成前一个，就是让一次慢点击跳起来的原因 —— 平板上的报告是「点文件名也会跳」。
		const held = h.longPress(row);
		expect(h.jumpTo).not.toHaveBeenCalled();
		// ……而按下仍被拒绝：在一行上的长按没有菜单、没有 callout、没有文本选择可提供
		// —— 它就是哪儿都不去。
		expect(held.defaultPrevented).toBe(true);

		// ……右键也不，就在同一行上：这个手势无论从哪条路来都被拒绝。
		h.rightClick(row);
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('打开时不弹出软键盘', () => {
		// 聚焦搜索框正是在手机屏幕下半部把键盘展开、盖住面板所为之而存在的那个列表的
		// 原因。用户真想打字时，那个框离一次点击只有一步。
		const touch = harness(entries(), 2, files, [], {}, {}, true);
		expect(touch.el.querySelector('.position-restore-nav-filter')).not.toBe(document.activeElement);

		// 指针设备没有键盘可展开，而打字比点击更快地收窄列表，所以它保留焦点。
		const desktop = harness(entries(), 2, files);
		expect(desktop.el.querySelector('.position-restore-nav-filter')).toBe(document.activeElement);
	});

	it('点 × 时键盘保持收着', () => {
		// × 是带子上手指唯一会去够的控件，而之后把插入符放回框里会在列表上方展开屏幕
		// 键盘 —— 与这次点击所要的正好相反（见 RecentFilesBrowser.toolbar）。框照样
		// 清空；只有焦点留在读者把它留在的地方。
		const h = harness(entries(), 2, files, [], {}, {}, true);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));

		h.clearFilter();

		expect(box.value).toBe('');
		expect(document.activeElement).not.toBe(box);
		// ……而框旁边没有提示说一次点击做什么：列表里的一行在 app 别处哪里都应答点击。
		expect(h.el.querySelector('.position-restore-nav-hint')).toBeNull();
	});

});

// **列表里的一根手指**（见 body.ts 与 tip.ts）。触摸送来与鼠标**一样的**指针事件 ——
// 按下时一个 over，浏览器判定手指在平移、或 app 在拖东西的那一刻一个 out/leave —— 但
// 那个 leave 到达时手指**还按着**。鼠标的 leave 是关于注意力的事实（「没人在读这份列表
// 了」）；手指的则是关于那个手势的事实，把它当成鼠标的来应答，会在一次正在变成滚动的
// 触摸底下重建每一行 —— 那正是手机的列表滚不动的原因，也是把一个折起的抽屉留成半开的
// 原因。
describe('RecentFilesModal —— 手指落在列表上', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const entries = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];

	it('手指离开列表时不重画', () => {
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		h.list().dispatchEvent(pointer('pointerover', 'touch'));
		h.list().dispatchEvent(pointer('pointerleave', 'touch'));

		// 那些行与手指到达之前是**同一批元素**：触摸底下什么都没被重建（见
		// RecentFilesBrowser.thawOrder）。
		expect(h.note('a')).toBe(row);
	});

	it('鼠标离开时才重画，那个次序就是为此留着的', () => {
		// 同样这两个事件从指针设备来，就是面板对「有人在读这份列表吗」的全部答案 ——
		// 进来时接下那个次序，出去时列表补上。
		const h = harness(entries(), 1, files);
		const row = h.note('a');

		h.list().dispatchEvent(pointer('pointerover', 'mouse'));
		h.list().dispatchEvent(pointer('pointerleave', 'mouse'));

		expect(h.note('a')).not.toBe(row);
		expect(h.note('a').querySelector('.nav-row-name')?.textContent).toBe('a');
	});

	it('手指不触发悬停说话', () => {
		// 手指不悬停：它按下，而按下把答案拿走（见 tip.ts）。一次触摸的 over 所抬起的
		// tooltip 会在手指早已挪走之后的 400ms 出现，还压在一行列表可能已经重画过的行上。
		const h = harness(entries(), 1, files);

		h.note('a').dispatchEvent(pointer('pointerover', 'touch'));
		vi.advanceTimersByTime(TIP_DELAY_MS);

		expect(document.querySelector('.position-restore-nav-tip')).toBeNull();
	});
});

// **停在一行上的手指** —— 在一个没有悬停的设备上，悬停就是它（见 long-press.ts）。
// 这一行自己应答：它印不出来的那些话，以及**本**面板知道、app 不知道的那两件事。下面的
// 一切都是从**触摸** harness 听来的，因为桌面的悬停已经应答了全部这些、压根不需要这一套
// —— 这里倒数第二个测试说的就是这个。
describe('RecentFilesModal —— 手指停在某一行上', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const entries = () => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	const tip = () => document.querySelector<HTMLElement>('.position-restore-nav-tip');
	const phone = () => harness(entries(), 1, files, [], {}, {}, true);
	const timed = () =>
		harness(entries(), 1, files, [], {}, {}, true, {}, prefs({ time: true }).browser);
	// ……以及**搜到了一个小节**的那一部手机：一篇笔记下面那一行，去的是那一节而不是
	// 那篇笔记（见 list.ts 的 headingRow）。
	const touched = (query: string) => {
		const h = harness(entries(), 1, { 'a.md': SPREAD_DOC.join('\n'), 'b.md': '' },
			[], {}, SPREAD_HEADINGS, true);
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		return h;
	};
	// 一次长按由哪三个事件构成，手工摆放的：这个手势靠手指**落在哪儿**、以及它有没有留在
	// 那儿来判定（见 long-press.ts），所以测试没法借用那个一路挪动光标的 pointer
	// helper。
	const finger = (el: HTMLElement, type: string, at = { x: 40, y: 40 }) =>
		el.dispatchEvent(
			new MouseEvent(type, { bubbles: true, button: 0, clientX: at.x, clientY: at.y }),
		);
	const down = (el: HTMLElement) => finger(el, 'pointerdown');
	const lift = (el: HTMLElement) => finger(el, 'pointerup');
	// ……以及那个时钟，而正是它使一次按下成为长按，而不是一次点击或一次滚动的开始。
	const rest = () => vi.advanceTimersByTime(LONG_PRESS_MS);
	// 面板交给 app 的那个菜单，按 app 自己的事件带着它的样子（见
	// RecentFilesBrowser.contextRow）：被武装那一行的第二个控件是手机通向它的唯一一扇
	// 门，因为长按已经成了这一行自己的手势。
	const menuOf = (trigger: unknown) => {
		const calls = (trigger as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls).toHaveLength(1);
		return calls[0][1] as {
			items: { title: string; icon: string; click?: () => void }[];
			shownAt?: { x: number; y: number };
			hidden: boolean;
			closed: boolean;
			hide(): void;
		};
	};
	// **手指没有悬停可依靠**：从手指落下到行进走完之间，这一行上什么都不变 —— 而那次
	// 行进也不是它的终点，因为在手机上抽屉会在它背后折走。所以这一行用来应答的就是那次
	// 按下本身（见 list.ts 的 markPressed）。
	it('手指按过的那一行留个标记，只要读者还看得见它', () => {
		const h = phone();
		const row = h.note('b');

		down(row);

		expect(row.classList.contains('is-pressed')).toBe(true);
		// ……而**不是**它旁边那一行：一根手指、一次按下、一个标记。
		expect(h.note('a').classList.contains('is-pressed')).toBe(false);

		// 手指抬起来、行进走完，而标记在抽屉于它背后折走时**仍在**（见
		// PANEL_EXIT_GRACE_MS）—— 那就是读者能看清自己打中了哪一行的全部时间。
		lift(row);
		vi.advanceTimersByTime(PANEL_EXIT_GRACE_MS);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// ……然后它**自己**走掉，而不是等别的什么：留下来的标记会是一个落在读者已经不再
		// 指着的行上的标记。
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS);
		expect(row.classList.contains('is-pressed')).toBe(false);

		// ……而被平台**抢走**的手势不是读者做完的手势，所以它立刻把标记一起带走，而不是
		// 让那一行亮着它没挣到的那一拍。
		down(row);
		finger(row, 'pointercancel');
		expect(row.classList.contains('is-pressed')).toBe(false);
	});

	// 标记由**抬起**来结束，而不是由手指落下时定下的某个时刻：一根仍在停着、正走向长按
	// 的手指，是读者仍在用来指着的手指，而一个中途灭掉的标记会说明这一行已经停止应答
	// （见 list.ts 的 releaseMark）。
	it('整个长按过程里标记一直亮着', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		// **点击**的标记所分到的那一拍，不是这一个的结束：手指还按着。
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// ……然后这次按下变成一次武装，标记仍留在那一行上。
		rest();
		expect(row.classList.contains('is-armed')).toBe(true);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// ……而手指**抬起**也带不走它：读者抬起来是为了够武装放到这一行上的东西，所以
		// 标记与武装一样久。
		lift(row);
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS * 2);
		expect(row.classList.contains('is-pressed')).toBe(true);
	});

	// ……而一个平台从没报告抬起的手指不会把一行永久点亮：标记有它自己的最晚时刻（见
	// ROW_PRESS_HOLD_MAX_MS）。
	it('手指始终没抬起来时，标记放开', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		// 终究不是一次长按：手指离开了它落下的那一点（见 LONG_PRESS_SLOP_PX），所以没有
		// 东西武装这一行，也没有东西留住那个标记。
		finger(row, 'pointermove', { x: 240, y: 240 });
		vi.advanceTimersByTime(ROW_PRESS_HOLD_MAX_MS);

		expect(row.classList.contains('is-armed')).toBe(false);
		expect(row.classList.contains('is-pressed')).toBe(false);
	});

	// ……而它属于**行**、不属于列表，所以它不会活得比一行久：那次按下所要求的行进重画了
	// 列表，而取代它画出来的那一行是读者从没按过的一行。
	it('标记跟着它所在的那一行一起消失', () => {
		const h = phone();
		down(h.note('b'));
		expect(h.note('b').classList.contains('is-pressed')).toBe(true);

		h.clickRow(h.note('b'));

		expect(h.jumpTo).toHaveBeenCalled();
		expect(h.note('b').classList.contains('is-pressed')).toBe(false);
	});

	// ……而一次按下在变成武装时并没有不再是按下：武装立着的整段时间里，手指都还在那一行
	// 上。
	it('手指停住时标记留着，随触发一起放开', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();

		// 那个本会把标记摘掉的时钟是为一次点击设的（见 ROW_PRESS_MARK_MS），而这并不是
		// 一次点击。
		vi.advanceTimersByTime(ROW_PRESS_MARK_MS * 2);
		expect(row.classList.contains('is-armed')).toBe(true);
		expect(row.classList.contains('is-pressed')).toBe(true);

		// ……而两者一起走：点另一行会把武装从这一行上摘掉，而留在它上面的标记会是一个落在
		// 没人在指的行上的标记。
		h.pressRow(h.note('a'));
		h.clickRow(h.note('a'));
		expect(row.classList.contains('is-armed')).toBe(false);
		expect(row.classList.contains('is-pressed')).toBe(false);
	});

	it('手指停住的那一行被触发，并说出行上印不出来的话', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();

		expect(row.classList.contains('is-armed')).toBe(true);
		// 那些话是悬停所挣到的那些，而它们**立刻**就上来：手指在这次按下的整段时间里已经
		// 停着了，那比一只鼠标被要求等的任何时候都长（见 tip.ts 的 speak）。
		expect(tip()?.querySelector('.nav-tip-path')?.textContent).toBe('b.md');
		// ……而**一行**被武装了，因为一根手指只能停在一行上。
		expect(h.note('a').classList.contains('is-armed')).toBe(false);
	});

	it('手指停在时间上时，说出那个年纪背后的准确时刻', () => {
		// 手指落在哪个元素上，决定这一行说两件事中的**哪一件**，与指针的情况完全一样
		// （见 tip.ts 的 subject）：时间应答的是它背后那个时刻，而这一行应答的是这是哪个
		// 文件。
		const h = timed();

		down(h.note('b').querySelector<HTMLElement>('.nav-row-time')!);
		rest();

		expect(tip()?.querySelector('.nav-tip-path')).toBeNull();
		expect(tip()?.querySelector('.nav-tip-text')?.textContent)
			.toBe(new Date(NOW).toLocaleString());
	});

	it('长按在手指抬起时送来的那次点击，不打开任何东西', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		// 手指抬起不是指针离开这一行 —— 一个触摸指针在抬起时就停止存在了，而浏览器照样
		// 说 `out` —— 所以这次按下挣到的那些话必须活得比它久：读者抬起手指是为了够按下
		// 放到这一行上的东西，不是因为他们不看了。
		lift(row);
		row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
		expect(tip()).not.toBeNull();

		// ……而浏览器可能仍会送来的那次点击是这次按下自己的尾巴，而不是第二个手势：在一行
		// 上停住的读者没有要求去那儿。
		h.clickRow(row);

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('手指刚开始滑动时，什么都不触发', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		// 一次拖动、不是一次静置：手指离开它落下的那一点，超过了停着的手指所允许的余量
		// （见 LONG_PRESS_SLOP_PX）。
		finger(row, 'pointermove', { x: 240, y: 240 });
		rest();

		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('用触发时加上的那个 × 把这一行拿掉', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		// 这次按下自己的尾巴，抬起会在读者任何一次点击之前送来（见下一个测试）：它不被
		// 任何人应答。
		lift(row);
		h.clickRow(row);
		h.clickRow(h.forgetButton(row));

		// 这一行自己的身份，由那个控件带着，而不是从一个可能被重画挪动过的下标算出来
		// （见 RecentFilesList.fileRow）。
		expect(h.forget).toHaveBeenCalledWith('b.md');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('用触发时加上的那个控件把 app 的菜单弹出来', () => {
		// 桌面从右键拿到的那个菜单（见 body.ts 的 contextRow）：app 自己的那些针对文件的
		// 动作，本面板的那一项盖在最上面。在手机上，从前抬起它的长按改成武装这一行，所以
		// 菜单改从被武装那一行自己的控件上回来，而不是藏在按下背后。
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		// 手指抬起，浏览器点它底下的任何东西 —— 那是这次按下自己的尾巴，什么都不打开
		// （见上面那个测试）。
		lift(row);
		h.clickRow(row);
		// ……然后读者才点那次按放到这一行上的控件。
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);

		const menu = menuOf(h.trigger);
		expect(menu.items[0].title).toBe(t('recentFiles.openInNewTab'));
		// ……而它被**打开了**，并且放在读者点下的那个控件处，而不是平台所说的点击发生的
		// 任何地方：一个只是被建起来的菜单是没人看得见的菜单，而一个放在屏幕角落的菜单是
		// 要去找的菜单（见 RecentFilesList.menuControl）。
		expect(menu.shownAt).toBeDefined();
		// **什么都没行进**，而这就是它与这个控件从前的快捷方式之间的全部区别：菜单是一个
		// 问题，而把这一行开在隔壁标签页里是它的答案之一，不是这次点击的。
		expect(h.jumpTo).not.toHaveBeenCalled();
		// ……而武装留在菜单背后的那一行上：菜单关上时，它仍是读者正在伸手去够的那一行。
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('从菜单自己那一项把这一行开在隔壁标签页里，手机和桌面一样', () => {
		// app 无法知道的关于这一行的那件事（见 body.ts 的 contextRow）仍离一次点击只有
		// 一步：它是那个控件所抬起的菜单的第一项。
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);

		menuOf(h.trigger).items[0].click!();
		expect(h.jumpTo).toHaveBeenCalledWith(1, 'tab');
	});

	it('面板自己关掉时把菜单一起带走', () => {
		// 那个菜单被放到 **document** 上、不是放进面板的元素里，所以关掉的外壳一行都不
		// 带走：在一个打开的菜单底下关掉的对话框，会让 app 的菜单悬在一个什么都没有的
		// 地方（见 RecentFilesBrowser.destroy）。
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);
		const menu = menuOf(h.trigger);

		h.modal.close();

		expect(menu.closed).toBe(true);
	});

	it('再点一次那个弹菜单的控件，就把菜单收回去', () => {
		// **一扇门，两个端头**。app 答不了这次点击：那个控件拦下自己的按下，好让伸手去
		// 够它不会打开笔记（见 menuControl），而 document 从没听过的按下，是一次没法从
		// 外面关掉 app 菜单的按下。所以这次点击本身就是那个答案 —— 而同一口气里又抬起
		// 菜单会是一个从没走开的菜单，那读起来像一个什么都不做的控件。
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(more());
		const menu = menuOf(h.trigger);
		expect(menu.closed).toBe(false);

		// ……而**同一个**控件再来一次 —— 手指先**落**在它上面，问题就是在那里问的，不是
		// 在它送出的那次点击上。
		down(more());
		h.clickRow(more());

		expect(menu.closed).toBe(true);
		// ……而 app 没有被要求第二个：一次把菜单收回的点击，不是一次要求再要一个的点击。
		expect((h.trigger as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
		// ……而**武装仍在那一行上**：菜单是个问题，而那个 × 可能才是读者正在伸手去够的
		// 答案。
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('按下落在菜单自己那块面上时，把菜单收回', () => {
		// **平板上的那种情形**，也是这个控件为何没法单独应答它的全部原因。当给它的那个
		// 点底下没有空间时，app 会把菜单**按它自己的高度向上**挪 —— 挪到那一行上方，也挪
		// 到那个抬起它的控件上方。于是一只瞄准那个控件的手指落在菜单上，而 app 在那里对
		// 一次按下什么都不应答：只有菜单旁边的背景能关掉它，而且只在一次点击上。
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(more());
		const menu = menuOf(h.trigger);
		expect(menu.closed).toBe(false);

		// ……而菜单正立在那控件原本的位置上，所以手指落在它上面。
		const surface = document.body.createDiv({ cls: 'menu' });
		down(surface);

		expect(menu.closed).toBe(true);
		surface.remove();
	});

	it('按下落在菜单某项上时，菜单不动', () => {
		// 唯一一次**不**得把菜单带走的按下：选一项是菜单自己的答案，而一个从按下底下被
		// 抽走的菜单会把那一项一起带走 —— 一次解析为什么都没有的点击。
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);
		const menu = menuOf(h.trigger);

		const item = document.body.createDiv({ cls: 'menu-item' });
		down(item);

		expect(menu.closed).toBe(false);
		item.remove();
	});

	it('app 自己把上一个菜单收掉之后，还能再弹一次', () => {
		// 在它上面选了一项，或在它外面点了一下：app 自己的手势，也是 app 自己的菜单要
		// 离开屏幕。从那一刻起面板不欠它什么 —— 而那个控件回到**抬起**一个菜单，因为一次
		// 把菜单收回的点击只有在一个菜单正立着时才是那个意思（见 contextRow）。
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(more());
		menuOf(h.trigger).hide();

		// ……而同一个控件再来一次，这次是要一个菜单，而不是要它走。
		h.clickRow(more());

		expect((h.trigger as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2);
	});

	it('那次按下自己的点击落在它加上的控件上时，什么都不打开', () => {
		// 那些控件到达这一行的远端 —— 而手指可能已经停在的那里。抬起随后送来的那次点击
		// 是这次按下的尾巴、不是第二个手势：在一行上停住的读者没有要求它的菜单，尤其没有
		// 要求**丢掉**它（见 fileRow 里的 ×）。
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		h.clickRow(more());

		expect(h.trigger).not.toHaveBeenCalled();
		expect(h.forget).not.toHaveBeenCalled();
		// ……而武装仍在那一行上：读者正在伸手去够它。
		expect(row.classList.contains('is-armed')).toBe(true);

		// **下一次**点击是读者自己的 —— 而一次点击首先是手指**落下**，正是这一点花掉那次
		// 按下所持有的主张（见 long-press.ts 的 release，以及下面那个测试）。
		down(more());
		h.clickRow(more());
		expect(menuOf(h.trigger).items[0].title).toBe(t('recentFiles.openInNewTab'));
	});

	it('按下之后它自己那一次点击始终没来，此时第一次点按照样应答', () => {
		// 一次长按的尾巴到底送不送来，是平台的事：一个为这次按抬起过菜单的 WebView，或
		// 一根在抬起路上漂过余量的手指，可能压根不送出点击。于是那个主张**活得比**做出它
		// 的那次按下更久 —— 而控件拦住自己的按下不让它抵达这个手势（见
		// RecentFilesList.fileRow），所以没有东西重置它：读者在某个控件上的第一次点击
		// 什么都没做，而它之后那次点击落在一行已经在他们底下被解除武装的行上，打开了笔记。
		// 一根落在这一行控件任何地方的手指都会花掉它。
		const h = phone();
		const row = h.note('b');
		const more = () => row.querySelector<HTMLElement>('.nav-row-menu')!;

		down(row);
		rest();
		lift(row);
		// ……而没有点击：平台没有为手指抬起送来任何东西。

		down(more());
		h.clickRow(more());

		expect(menuOf(h.trigger).items[0].title).toBe(t('recentFiles.openInNewTab'));
	});

	it('这种按下之后第一次点 × 也照样应答', () => {
		// 同一个主张，落在那个人们撑不过去的控件上：一个在一行上停住、然后把目标对着它的
		// × 的读者什么都没得到，而之后那次点击打开了他们正想丢掉的笔记。
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);

		down(h.forgetButton(row));
		h.clickRow(h.forgetButton(row));

		expect(h.forget).toHaveBeenCalledWith('b.md');
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('点按落在控件旁边那条空白区时，什么都不打开', () => {
		// 并排的两个目标会被一根漂移的手指错过 —— 而一根落在其中一个、却在另一个上面抬起
		// 的手指，**两个都没**点到：浏览器会点它们最近的共同祖先，而若没有那条控件区自己
		// 的答复，那就是这一**行**（见 RecentFilesList.actionStrip）。没打中就是没打中：
		// 什么都不打开，而武装等着读者重新瞄准。
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-actions')!);

		expect(h.jumpTo).not.toHaveBeenCalled();
		expect(row.classList.contains('is-armed')).toBe(true);
	});

	it('读者点另一行时，把这一行的触发解除', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		h.pressRow(h.note('a'));
		h.clickRow(h.note('a'));

		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);
		// 一次一行，而话随之而走：一个已经不再说什么的武装行，是一个读者得去猜的行。
		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('滚动时、重画时都解除', () => {
		// 一次滚动把那些行从立着不动的话底下抽走，而一次重画丢掉手指停住的那一行：一个
		// 留在取代它画出的那一行上的 ×，会是一个属于没人武装过的行的控件。
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		h.list().dispatchEvent(new Event('scroll'));
		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();

		down(row);
		rest();
		h.changed();
		expect(h.note('b').classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('WebView 为同一根手指发来的菜单事件也能触发它', () => {
		// 一次长按在某些平台上以 `contextmenu` 到达、在另一些平台上不是（见
		// long-press.ts），所以两扇门都开着、而武装是幂等的：要紧的是这一行无论走哪条路
		// 都被武装，以及 app 的文件菜单**没有**被抬起 —— 在手机上这次按下是**行**的答案，
		// 不是文件的。
		const h = phone();
		const row = h.note('b');

		const ev = h.longPress(row);

		expect(row.classList.contains('is-armed')).toBe(true);
		// ……而按下仍被拒绝，否则平台自己的选择 callout 会在读者等它应答的时候在那一行
		// 上方冒出来。
		expect(ev.defaultPrevented).toBe(true);
		expect(h.trigger).not.toHaveBeenCalled();
	});

	it('桌面上什么都不触发 —— 那里停住就是悬停', () => {
		// 在指针能悬停的地方这个手势压根不被听到：那些控件已经在指针所在的那一行上，那些
		// 话也是。
		const h = harness(entries(), 1, files);
		const row = h.note('b');

		down(row);
		rest();

		expect(row.classList.contains('is-armed')).toBe(false);
		expect(tip()).toBeNull();
	});

	it('大纲行带着那个菜单控件，但不带 ×', () => {
		// 一个搜到的小节不是一条记录（这份列表只记笔记），所以它没有什么可被丢掉的
		// —— 一个 × 会是「从最近文件里移除一篇从未进去过的东西」（见 list.ts 的
		// headingRow）。但「在新标签页打开」对它同样成立：它去的是那一**节**，而不只
		// 是那篇笔记，所以那扇门照旧在。
		const h = touched('尾巴');
		const row = h.heading('尾巴');

		expect(row.querySelector('.nav-row-forget')).toBeNull();
		expect(row.querySelector('.nav-row-menu')?.getAttribute('aria-label'))
			.toBe(t('recentFiles.rowMenu'));
		// ……而它的那一端只有那一个控件：菜单就在远端上，因为 × 是唯一会把它推到里面
		// 去的东西。
		expect(Array.from(row.querySelectorAll('.nav-row-actions > *'))
			.map(c => c.classList.contains('nav-row-menu') ? 'menu' : 'x'))
			.toEqual(['menu']);
	});

	it('手指停在一个搜到的小节上时，菜单说的是「在这里打开」', () => {
		// 与笔记行同一个控件、同一个手势（见上面那些测试），而菜单上那一项说的是这
		// 一行所去的地方：不是那篇笔记的开头，而是那一节。
		const h = touched('尾巴');
		const row = h.heading('尾巴');

		down(row);
		rest();
		lift(row);
		h.clickRow(row);
		h.clickRow(row.querySelector<HTMLElement>('.nav-row-menu')!);

		const menu = menuOf(h.trigger);
		expect(menu.items.map(item => item.title))
			.toEqual([t('recentFiles.openHereInNewTab')]);
		menu.items[0].click!();
		// 那一节、它此刻在哪一行、它上面那一行一贯去往的那个标签页。
		expect(h.jumpToHeading).toHaveBeenCalledWith('a.md', '尾巴', 33, 'leaf-1', 'tab');
	});
});

// 悬停在一行上是向 app 要**那篇笔记本身**（见 RecentFilesBrowser.hoverRow）。本插件里
// 没有预览，也没有预览的什么可测：一行被悬停时这个面板画的仍是什么都没有，而它**说的**
// 是一个命名这一行所代表的文件的事件 —— 所以读者在这里拿到的 popover 是 app 自己的，
// 由 app 已经用来应答每一份别的列表的那套东西写下，包括悬停究竟够不够。这个面板给那次
// 询问加上的、也是下面所测的，是只有它知道的那一件事：**哪个文件**，以及文件里的
// **哪里**。
describe('RecentFilesModal —— 悬停向 app 要这篇笔记', () => {
	const files = { 'a.md': '', 'b.md': '' };
	// 一篇读者只是打开过的笔记 —— 一个没有自己地点的文件行。
	const plain = (): NavEntry[] => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
	// 一篇有解析后标题的笔记，按 metadata cache 报告的样子。
	const heading = (text: string, line: number) => ({
		heading: text, level: line === 0 ? 1 : 2, position: { start: { line } },
	});
	// ……以及同一篇笔记、为它保存了自己的一处位置，这就是笔记**自己**那一行在能被预览
	// 的地方所持有的东西（`focus` 挑那个停靠点，见 PreviewFocusMode：这一行的行号如今是
	// 一个选择，而不是这一行的默认）。
	const savedNote = (
		headings: unknown[],
		saved?: Record<string, EphemeralState>,
		focus?: PreviewFocusMode,
	) => harness(plain(), 1, files, [], {}, { 'a.md': headings }, false, {},
		focus ? prefs({ focus }).browser : defaultPrefs(), path => saved?.[path]);
	// ……以及一个**搜到的小节**的那一行：这一行的悬停要的是那一节，而不只是那篇笔记
	//（见 body.ts 的 previewAsk）。行号是那一节**此刻**在哪一行，现查。
	const hitNote = (headings: unknown[], query: string) => {
		const h = harness(plain(), 1, files, [], {}, { 'a.md': headings });
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		return h;
	};
	// app 被问过的那些问题，按次序：面板每一个都按 app 自己的事件交出去，请求作为第二个
	// 参数（见 hoverRow）。
	const asked = (trigger: unknown) =>
		(trigger as { mock: { calls: unknown[][] } }).mock.calls
			.filter(c => c[0] === 'hover-link')
			.map(c => c[1] as {
				source?: string; targetEl?: HTMLElement; hoverParent?: HoverParent;
				linktext?: string; sourcePath?: string; state?: { scroll?: number };
			});
	// **app 应答**，尽一个测试能替身到的程度：core 把它打开的那个 popover 写回面板交给
	// 它的那个 **HOVER PARENT** 里，而那个字段就是本面板对 app 画出的任何东西所持有的
	// 全部把手（见 hover-settle.ts）—— jsdom 里没有 PeekPopover，core 接下来做的没有
	// 一件能在这里发生。面板在两次绘制之间找它，所以那个时钟转一圈就是看一眼。这张卡片
	// 被返回，是因为它的**结束**是答案的一半：把它从 document 拿走就是预览被关上了。
	const opened = async (h: ReturnType<typeof harness>): Promise<HTMLElement> => {
		const parent = asked(h.trigger).at(-1)!.hoverParent!;
		const card = document.body.createDiv({ cls: 'popover' });
		parent.hoverPopover = { hoverEl: card } as never;
		await vi.advanceTimersByTimeAsync(150);
		return card;
	};
	// 这一行自己的提示，按 document 带着它的样子：面板把它画在那儿，而不是画在会滚动、
	// 会裁剪的列表里面（见 tip.ts）。
	const tip = () => document.querySelector<HTMLElement>('.position-restore-nav-tip');

	it('说出这一行代表的是哪个文件，每次到达只说一次', () => {
		const h = harness(plain(), 1, files);
		const row = h.note('a');

		movedOnto(row);

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md');
		// 是磁盘上的路径，而不是行上印的名字：行的名字被缩短过、可能既不唯一、拼写也不照
		// vault 的拼法，而且它反正不是打开时用的东西（见 displayName）。
		expect(question[0].sourcePath).toBe('a.md');
		// **谁在问**是 app 据以知道该给哪个答案的东西：本面板自己的 id，为两个外壳各注册
		// 一次（见 main.ts 的 registerHoverLinkSource），而且不借用任何别的视图的名字。
		expect(question[0].source).toBe(NAV_SOURCE_ID);
		// **那一行**，而不是指针划过的那一行里随便哪个词：popover 属于读者所在的列表
		// 那一行。
		expect(question[0].targetEl).toBe(row);

		// 在那一行**里面**移动不再问任何东西：名字、徽标与时间都仍是同一行上的一次到达
		// （见 RecentFilesList.hoverAt）—— 否则一只横穿这一行的手会是一只为一页东西问
		// 六次的手。
		row.querySelector('.nav-row-name')!.dispatchEvent(pointer('pointermove'));
		expect(asked(h.trigger)).toHaveLength(1);
	});

	it('指针没动、面板在它底下新画出来的行，不去问', () => {
		// **一个快捷键打开的对话框**，而鼠标正停在屏幕中央：那些行是围着指针画出来的，
		// 浏览器报告了它在哪一行上的一次到达，而 app 会用一个开在读者从没指过的行上方的
		// 页面来应答 —— 一篇被一次按键要来的笔记。到达不是指着（见
		// RecentFilesList.hoverAt），而在同一处的两个事件是一只手没有动过。
		const h = harness(plain(), 1, files);
		const row = h.note('a');

		// 浏览器为它围着指针画出的那一行报告的到达，以及随之而来的那次移动 —— 两者都在
		// 那只手本来就所在的地方。
		row.dispatchEvent(pointer('pointerover'));
		row.dispatchEvent(pointer('pointermove', 'mouse', true));

		expect(asked(h.trigger)).toHaveLength(0);

		// ……而那只手最小的移动就足以被问：指针停下来所在的那一行，仍是读者能指的一行。
		row.dispatchEvent(pointer('pointermove'));

		expect(asked(h.trigger)).toHaveLength(1);
		expect(asked(h.trigger)[0].linktext).toBe('a.md');
	});

	it('指针没动、列表在它底下重画过的行，也不再问', () => {
		// 同一次到达，一次渲染之后：读者正在看的那些行被扔掉又画一遍 —— 一篇笔记被拿下
		// 列表、年纪在走、一个查询被打出来 —— 而如今在指针底下的那一行是一行没人第二次
		// 指过的行。
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));
		expect(asked(h.trigger)).toHaveLength(1);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = 'a';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		h.note('a').dispatchEvent(pointer('pointermove', 'mouse', true));

		expect(asked(h.trigger)).toHaveLength(1);
	});

	it('指针走开又回来之后，会再问一次', () => {
		// 离开**列表**正是让下一次到达成为一次到达的东西（见列表自己的 pointerleave）：
		// 在一次造访里两次到达同一行是一个问题。
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));

		// 鼠标的离开也会把被扣住的次序放掉，所以那些行在出去的路上又被画了一遍（见
		// RecentFilesBrowser.thawOrder）—— 下面那一行是一个**新**元素，它自己应答。
		h.list().dispatchEvent(pointer('pointerleave'));
		movedOnto(h.note('a'));

		expect(asked(h.trigger)).toHaveLength(2);
	});

	it('悬停一个搜到的小节时，要的是那一节', () => {
		// 这就是这次询问值得从**这里**、而不是从别的任何能悬停文件的地方发出的原因：这
		// 一行是一个笔记**内部**的地方，而 popover 开在它上面。行号来自那一节此刻在哪
		// —— 现查（见 list.ts 的 hitsFor），所以它不是一份快照。
		const h = hitNote([heading('Alpha', 0), heading('Beta', 5)], 'Beta');

		movedOnto(h.heading('Beta'));

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md#Beta');
		// ……而同一口气里没有第二条指令：一个挨着小节的行号会是 app 去一个它没被要求去的
		// 地方。
		expect(question[0].state).toBeUndefined();
	});

	it('笔记自己那一行只要笔记，不要别的', () => {
		// **这一行就是那个文件**，所以它要看的正是那个文件 —— 而它按 app 自带的每一份
		// 列表要它的方式去要：不要小节，也不要行号可去。那篇笔记**确实**保存了一个位置，
		// 而知道这一点不改变什么，有两个理由。一个悬停「meeting-notes」却被显示它第三个
		// 标题的读者，并没有被显示他们指的东西，无论它到得多快。而且这篇笔记反正会开在
		// 那里：这一行自己的**点击**就是那次到达，晚一个手势。
		const h = savedNote([heading('Alpha', 0), heading('Beta', 5)], { 'a.md': { scroll: 11 } });

		movedOnto(h.note('a'));

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md');
		expect(question[0].state).toBeUndefined();
	});

	it('读者选了那种方式时，要的是整篇笔记、并挪到它那一行', () => {
		// 另一个停靠点（见 PreviewFocusMode），按名字点名要来是因为它不是默认：被点出一
		// 条行号时，app 先把整篇笔记画出来、再在遮罩背后行进去（见 hover-settle.ts），
		// 到达这一行的点击本会打开的那处地点 —— 正是这一点让这个预览与站在它背后的那次
		// 点击一致。
		const h = savedNote([heading('Alpha', 0), heading('Beta', 5)], { 'a.md': { scroll: 11 } },
			'line');

		movedOnto(h.note('a'));

		const question = asked(h.trigger);
		expect(question).toHaveLength(1);
		expect(question[0].linktext).toBe('a.md');
		expect(question[0].state).toEqual({ scroll: 11 });
	});

	it('点名不了任何行的预览，不读文件', async () => {
		// 一行号**要花**什么，以及默认停靠点因此不必付什么：一个没被点名的地方不必在笔记
		// 自己的**文本**里重新找到，而对一篇没有标签页持有的笔记来说那是一次整文件读取
		// —— 它落地时会带着整份列表在六十毫秒后重画，正好在 app 正在画这次悬停所要的那
		// 张卡片的地方。
		const h = savedNote([heading('Alpha', 0), heading('Beta', 5)], { 'a.md': { scroll: 11 } });

		movedOnto(h.note('a'));
		await vi.advanceTimersByTimeAsync(LATE_READ_REDRAW_MS * 2);

		expect(h.cachedRead).not.toHaveBeenCalled();
	});

	it('app 分辨不出的标题，退回按行号', () => {
		// `#Beta` 解析到带那段文本的**第一个**标题，所以一篇两次写着「Beta」的笔记会打开
		// 错的那一个 —— 而一个一次都不移动就显示的错小节，比晚到的正确地点更糟（反正遮罩
		// 会把它藏住，见 PreviewSettle）。退回的是那一节**此刻**的行号。
		const h = hitNote(
			[heading('Alpha', 0), heading('Beta', 5), heading('Beta', 20)], 'Beta');

		movedOnto(h.headings()[0]);

		expect(asked(h.trigger)[0].linktext).toBe('a.md');
		expect(asked(h.trigger)[0].state).toEqual({ scroll: 5 });
	});

	it('没法写进链接里的标题，退回按行号', () => {
		// 下面那些字符对解析器来说是链接语法、不是名字的一部分：每一个都开启别的东西
		// （一个子路径、一个别名、链接本身），所以那个标题会以不是它自己的东西到达。
		const h = hitNote([heading('Alpha', 0), heading('Beta | gamma', 5)], 'gamma');

		movedOnto(h.heading('Beta | gamma'));

		expect(asked(h.trigger)[0].linktext).toBe('a.md');
		expect(asked(h.trigger)[0].state).toEqual({ scroll: 5 });
	});

	it('笔记连一处位置都没有的行，不承诺任何行号', () => {
		// 不编造任何东西来填补这份沉默：预览被要的行号是笔记**拥有**的一个地方，而一篇
		// 读者从没在哪离开过的笔记 —— 里面没有 jump、也没为它保存过任何东西 —— 没有可被
		// 要的行号。那时预览显示的是从开头起的这篇笔记，而那正是普通打开它本会显示的东西。
		const h = harness(plain(), 1, files);

		movedOnto(h.note('a'));

		expect(asked(h.trigger)[0].state).toBeUndefined();
	});

	it('没有页面可给的行，背后什么都不去要', () => {
		// 一个没有路径的视图不命名任何文件：没有东西可让 app 打开预览，而为图谱搭这个面板
		// 自己的卡片，恰恰是这次询问本就意在替我们省掉的第二套实现（见 hoverRow）。
		const h = harness([
			visit('a.md', NOW - MINUTE),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry,
		], 1, files);
		const graph = h.notes().find(r => r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

		movedOnto(graph);

		expect(asked(h.trigger)).toHaveLength(0);
	});

	it('手指问不出任何东西，也不前往任何地方', () => {
		// 停在一行上的手指是即将点它，不是要读它 —— 而且手机上本来也没有空间在一行旁边
		// 放一页（见 RecentFilesList.onHoverRow）。两条路都不行进：悬停不是导航，无论它
		// 通向哪里。
		const h = harness(plain(), 1, files);

		movedOnto(h.note('a'), 'touch');

		expect(asked(h.trigger)).toHaveLength(0);
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('给 app 打开的那张卡片做标记，面板要托起来的正是它', async () => {
		// 从**对话框**外壳应答悬停的那篇笔记开在它背后：core 把每一个 popover 都放到
		// document 的 body 上、把它画在一个模态容器下面（见 body.ts 的 liftPreview），
		// 所以对话框要的那一页是它自己的框所站着的唯一一样东西。这里要测的既不是那张卡片
		// 的绘制、也不是那些层 —— jsdom 里不跑样式表，而两个值都是 app 的 —— 而是那个
		// **接缝**：哪些卡片被标记，恰恰就是这个面板向 app 要过的那些卡片，而一个它没问过
		// 的卡片不是这个面板该去装扮的。用标记而不是内联样式，因为 popover 长什么样是主题
		// 的答案，历来如此。
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));

		const card = await opened(h);

		expect(card.classList.contains('position-restore-nav-preview')).toBe(true);
	});

	// 行自己说的那些话给 app 正在显示的东西让路。提示回答的是这一行印不出来的东西（见
	// RecentFilesList.fileRow）—— 设置留在它外面的路径、一篇笔记另叫的那些名字 —— 而那篇
	// 笔记也把这一切都回答了：答得更好，而且是在页面上、不是在旁边一个盒子里。这些都不是
	// 询问被拒绝；它是同一个问题的两个答案，多了一个。
	//
	// 而且这一切都**不被记住**：一条提示可不可以说话，在每一次悬停时都重新问一遍（见
	// RecentFilesListOptions.tipsQuiet），所以这个答案的寿命就是那个 popover 的 —— 不是
	// 指针的，也不是某个此后某次悬停还得去清的标志的。
	it('笔记一盖到列表上，就把自己说的话收回', async () => {
		const h = harness(plain(), 1, files);
		// 一次除此之外什么都得不到的悬停，是一次有话说要说的悬停。
		movedOnto(h.note('a'));
		expect(h.hover(h.note('a'))).not.toBeNull();

		// ……然后 app 打开了一个：读者按住了它的键，或曾经说过「悬停对 app 的每一份列表
		// 都够了」。说过的话被收回……
		await opened(h);
		expect(tip()).toBeNull();

		// ……而笔记立着的时候不再说新的话：那一页对「这是哪个文件」的回答已经比旁边那个
		// 盒子能给的更好。
		expect(h.hover(h.note('b'))).toBeNull();
	});

	it('app 什么都没回答时，该说的话留着', async () => {
		// 拒绝也不是应答：一个被关掉的预览插件、或一个仍被扣着的键，是一次什么都没得到的
		// 悬停 —— 而那时这一行自己的话就是读它唯一挣到的东西。
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));
		await vi.advanceTimersByTimeAsync(2000);

		expect(h.hover(h.note('a'))).not.toBeNull();
	});

	it('笔记一消失又能开口 —— 指针始终没离开过列表', async () => {
		// 沉默随**预览**结束，而不是随指针的一段旅程结束：一个在 popover 关上后仍关着的
		// 提示，正是这次询问所回答的那个 bug（见 tip.ts 的 `quiet`），而「走开又回来」不再
		// 是这笔交易的一部分。
		const h = harness(plain(), 1, files);
		movedOnto(h.note('a'));
		expect(h.hover(h.note('a'))).not.toBeNull();
		const card = await opened(h);
		expect(tip()).toBeNull();

		card.remove();

		expect(h.hover(h.note('b'))).not.toBeNull();
	});
});

// 一行的行号是一个**地址**，而把它交给 app 的，是位置数据库**此刻**对这篇笔记的回答 ——
// 不是这条记录里的什么东西：一份记录不携带任何位置（见 places.ts 的降级）。所以交出去的
// 那个数字，就是一次普通打开会落到的那一行，而数据库什么都没说时，一个行号都不点 ——
// 那是诚实的询问：一个打开笔记却不点出行号的预览，从来没有搞错过那篇笔记在哪儿。
describe('RecentFilesModal —— 悬停要的那一行来自位置数据库', () => {
	// 位置数据库对这篇笔记的回答：它的第 11 行。
	const SPOT = 11;
	const files = { 'a.md': SPREAD_DOC.join('\n') };
	// app 被问过的那些问题，按次序（见上面那个套件）。
	const asked = (trigger: unknown) =>
		(trigger as { mock: { calls: unknown[][] } }).mock.calls
			.filter(c => c[0] === 'hover-link')
			.map(c => c[1] as { linktext?: string; state?: { scroll?: number } });
	const one = (): NavEntry[] => [visit('a.md', NOW)];
	const savedAt = (line: number) => () => ({ scroll: line }) as EphemeralState;

	// 下面两个要的是 app **此后挪到**的那一行 —— 那是这份列表提供的停靠点，而不是它自带
	// 的那个（见 PreviewFocusMode），所以每一个都在面板读它自己那条偏好的地方说明了。
	it('读者选了那个停靠点时，点出位置数据库说的那一行', () => {
		// 位置数据库是**唯一**说得出「一次普通打开会落在哪儿」的东西，而这一行的点击
		// 瞄准的正是那儿 —— 所以预览与它背后那次点击说的是同一个地方。
		const h = harness(one(), 0, files, [], {}, {}, false, {},
			prefs({ focus: 'line' }).browser, savedAt(SPOT));

		movedOnto(h.note('a'));

		expect(asked(h.trigger)[0]).toMatchObject({
			linktext: 'a.md',
			state: { scroll: SPOT },
		});
	});

	it('位置数据库什么都没说时，一个行号都不点', () => {
		// 一篇从没被在哪儿离开过的笔记 —— 数据库里没有它 —— 没有可以被点出的行号。那时
		// 预览显示的是从开头起的这篇笔记，而那正是普通打开它本会显示的东西。
		const h = harness(one(), 0, files, [], {}, {}, false, {},
			prefs({ focus: 'line' }).browser);

		movedOnto(h.note('a'));

		expect(asked(h.trigger)[0].state).toBeUndefined();
	});

	it('行上有行号、但笔记是按 app 自己那套去问的时候，不点行号', () => {
		// 同一篇笔记、同一处被数据库说出的地点 —— 而什么都没被点出，因为**默认**停靠点
		// 按 app 自带的每一份列表要这篇笔记的方式去要它。这个测试上面的一切都是读者选择
		// 的一次远征，不是这一行有的义务。
		const h = harness(one(), 0, files, [], {}, {}, false, {}, defaultPrefs(), savedAt(SPOT));

		movedOnto(h.note('a'));

		const question = asked(h.trigger)[0];
		expect(question.linktext).toBe('a.md');
		expect(question.state).toBeUndefined();
	});
});

describe('RecentFilesModal —— 置顶的行', () => {
	// 一个**钉**是一篇**笔记**的书签，所以置顶块一本笔记一行、底下没有任何落点；读者失去
	// 的是那些地点的清单，不是最新的那一个 —— 那一行仍代表它（见 RecentFilesList）。
	const three = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	// b.md 里有一个可被搜到的小节；a.md 里有一个，供下面那个测试用。
	const B_TAIL = { 'b.md': [{ heading: '尾巴', level: 2, position: { start: { line: 9 } } }] };
	const A_TAIL = { 'a.md': [{ heading: '尾巴', level: 2, position: { start: { line: 9 } } }] };
	const search = (h: ReturnType<typeof harness>, query: string) => {
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	};

	it('置顶的行最先画，按读者自己排的次序，下方有一条分隔线', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['b.md', 'c.md']);

		const names = h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);
		// 是钉住的次序、不是时钟：c.md 是这里最新的地点，而 b.md 是两个钉里较旧的那个，
		// 而读者把 b 放在前面。
		expect(names).toEqual(['b', 'c', 'a']);
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
		expect(h.notes()[1].classList.contains('is-pinned')).toBe(true);
		expect(h.notes()[2].classList.contains('is-pinned')).toBe(false);
		// **一条**线，在块下面、别处一概没有。
		const lines = h.el.querySelectorAll('.position-restore-nav-pinned-sep');
		expect(lines).toHaveLength(1);
		expect(lines[0].nextElementSibling).toBe(h.notes()[2]);
	});

	it('置顶行下面照样画出它搜到的小节', () => {
		// 一个钉是一篇**笔记**的书签，而一个搜到的小节挂在它的笔记**下面** —— 它去的是
		// 那一节，与那篇笔记有没有被钉住无关（见 list.ts 的 render）。
		const h = harness(three(), 2, files, [], {}, B_TAIL, false, {}, defaultPrefs(),
			undefined, ['b.md']);
		search(h, '尾巴');

		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['b']);
		// ……而它紧跟着被钉住的那一行，而不是替掉它。
		expect(h.rows()[1].classList.contains('is-heading')).toBe(true);
	});

	it('整份列表都是置顶区时，不画那条线', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md', 'c.md']);

		expect(h.el.querySelector('.position-restore-nav-pinned-sep')).toBeNull();
	});

	it('行不在屏幕上的钉子跳过；等这一条被钉住时再补上', () => {
		// 一个钉住了一篇被过滤掉的笔记的钉，不是「它被列出了」的承诺。
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['gone.md']);
		expect(h.notes().map(r => r.querySelector('.nav-row-name')?.textContent))
			.toEqual(['c', 'b', 'a']);
		expect(h.el.querySelector('.position-restore-nav-pinned-sep')).toBeNull();

		h.pinned.unshift('a.md');
		h.changed();
		expect(h.notes()[0].querySelector('.nav-row-name')?.textContent).toBe('a');
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
	});

	it('置顶行代表什么就打开什么，从列表里拿掉也走同一条路', () => {
		const notes = [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];
		const h = harness(notes, 1, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md']);

		h.clickRow(h.note('a'));
		// 这一行代表这篇笔记，与它没被钉住时一样。
		expect(h.jumpTo).toHaveBeenCalledWith(0, undefined);

		h.clickRow(h.forgetButton(h.note('a')));
		expect(h.forget).toHaveBeenCalledWith('a.md');
	});
});

describe('RecentFilesModal —— 行菜单上的「钉住」', () => {
	// 本列表给 app 自己那个文件菜单**加上**的东西：钉住 —— 那是一篇**笔记**的书签、属于
	// 笔记行 —— 以及那两步，它们只关于置顶块自己的次序，别处一概无关。
	const three = () => [
		visit('a.md', NOW - 5 * MINUTE),
		visit('b.md', NOW - 2 * MINUTE),
		visit('c.md', NOW),
	];
	const files = { 'a.md': '', 'b.md': '', 'c.md': '' };
	const open = t('recentFiles.openInNewTab');
	// a.md 里有一个可被搜到的小节。
	const A_TAIL = { 'a.md': [{ heading: '尾巴', level: 2, position: { start: { line: 9 } } }] };
	const search = (h: ReturnType<typeof harness>, query: string) => {
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = query;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const items = (h: ReturnType<typeof harness>) => {
		const calls = (h.trigger as { mock: { calls: unknown[][] } }).mock.calls;
		expect(calls).toHaveLength(1);
		const menu = calls[0][1] as {
			items: { title: string; section: string; icon: string; click?: () => void }[];
		};
		return menu.items;
	};
	const item = (h: ReturnType<typeof harness>, title: string) =>
		items(h).find(i => i.title === title)!;
	const names = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);

	it('笔记行上给「钉住」这一项，大纲行上不给', () => {
		// 一个钉是一篇**笔记**的书签：一个搜到的小节是读者**搜到**的、不是去过的一处
		// 地点，钉住它会是第二种、更小的钉（见 body.ts 的 pinItems）。
		const h = harness(three(), 2, files, [], {}, A_TAIL);
		search(h, '尾巴');
		h.rightClick(h.note('a'));
		expect(items(h).map(i => i.title)).toContain(t('recentFiles.pin'));
		expect(items(h)[1].section).toBe('action');

		const hit = harness(three(), 2, files, [], {}, A_TAIL);
		search(hit, '尾巴');
		hit.rightClick(hit.heading('尾巴'));
		expect(items(hit).map(i => i.title)).toEqual([t('recentFiles.openHereInNewTab')]);
	});

	it('把这篇笔记钉住，它那一行挪到列表最上面', () => {
		// 这一行**立刻**挪动：面板是唯一说得出这件事的东西，而对话框不订阅 store（见
		// body.ts 的 pin）。
		const h = harness(three(), 2, files);

		h.rightClick(h.note('a'));
		expect(items(h).map(i => i.title)).toEqual([open, t('recentFiles.pin')]);
		item(h, t('recentFiles.pin')).click!();

		expect(h.pin).toHaveBeenCalledWith('a.md');
		expect(names(h)).toEqual(['a', 'c', 'b']);
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
	});

	it('有步可挪时才给那两项', () => {
		// 在块的两端，一个什么都不做的项比一个不存在的项更糟。
		const alone = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md']);
		alone.rightClick(alone.note('a'));
		expect(items(alone).map(i => i.title)).toEqual([open, t('recentFiles.unpin')]);

		const first = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md']);
		first.rightClick(first.note('a'));
		expect(items(first).map(i => i.title))
			.toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinDown')]);

		const last = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md']);
		last.rightClick(last.note('b'));
		expect(items(last).map(i => i.title))
			.toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp')]);
	});

	it('把置顶行在块内挪一步，并把挪的结果画出来', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md']);

		h.rightClick(h.note('a'));
		item(h, t('recentFiles.pinDown')).click!();

		expect(h.movePinned).toHaveBeenCalledWith('a.md', 1);
		expect(h.pinned).toEqual(['b.md', 'a.md']);
		expect(names(h)).toEqual(['b', 'a', 'c']);
	});

	it('取消钉住，这一行回到列表里原来那个位置', () => {
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md']);

		h.rightClick(h.note('a'));
		item(h, t('recentFiles.unpin')).click!();

		expect(h.unpin).toHaveBeenCalledWith('a.md');
		expect(names(h)).toEqual(['c', 'b', 'a']);
		expect(h.el.querySelector('.position-restore-nav-pinned-sep')).toBeNull();
	});

	it('超过一步时才给「挪到头」那一项', () => {
		// 在最前面的旁边放「挪到最前」做的正是「上移」刚提供的，所以它不在那儿 —— 三行的
		// 一个块没有离任一端够远、需要这一项的行。
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md', 'c.md']);
		h.rightClick(h.note('b'));
		expect(items(h).map(i => i.title))
			.toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'), t('recentFiles.pinDown')]);

		// 四行才有离某一端两步的行：**最前**那一行压根没有上移的路，它下面那一行则是上移
		// 一步、下移两步。
		const four = { 'a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' };
		const block = harness([
			visit('a.md', NOW - 5 * MINUTE),
			visit('b.md', NOW - 4 * MINUTE),
			visit('c.md', NOW - 3 * MINUTE),
			visit('d.md', NOW),
		], 3, four, [], {}, {}, false, {}, defaultPrefs(),
		undefined, ['a.md', 'b.md', 'c.md', 'd.md']);
		const titles = (name: string) => {
			const row = harness([
				visit('a.md', NOW - 5 * MINUTE),
				visit('b.md', NOW - 4 * MINUTE),
				visit('c.md', NOW - 3 * MINUTE),
				visit('d.md', NOW),
			], 3, four, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md', 'b.md', 'c.md', 'd.md']);
			row.rightClick(row.note(name));
			return items(row).map(i => i.title);
		};
		expect(titles('a')).toEqual([open, t('recentFiles.unpin'),
			t('recentFiles.pinDown'), t('recentFiles.pinLast')]);
		expect(titles('b')).toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'),
			t('recentFiles.pinDown'), t('recentFiles.pinLast')]);
		expect(titles('c')).toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'),
			t('recentFiles.pinFirst'), t('recentFiles.pinDown')]);
		expect(titles('d')).toEqual([open, t('recentFiles.unpin'), t('recentFiles.pinUp'),
			t('recentFiles.pinFirst')]);
		// ……而块本身仍按读者自己的次序画。
		expect(names(block)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('一次就把它挪到置顶区末尾', () => {
		const four = { 'a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' };
		const h = harness([
			visit('a.md', NOW - 5 * MINUTE),
			visit('b.md', NOW - 4 * MINUTE),
			visit('c.md', NOW - 3 * MINUTE),
			visit('d.md', NOW),
		], 3, four, [], {}, {}, false, {}, defaultPrefs(),
		undefined, ['a.md', 'b.md', 'c.md', 'd.md']);

		h.rightClick(h.note('b'));
		item(h, t('recentFiles.pinLast')).click!();

		// 交给 store 的是那个**距离**、不是下标：一行要挪多远是块自己的事。
		expect(h.movePinned).toHaveBeenCalledWith('b.md', 2);
		expect(h.pinned).toEqual(['a.md', 'c.md', 'd.md', 'b.md']);
		expect(names(h)).toEqual(['a', 'c', 'd', 'b']);
	});
});

describe('RecentFilesModal —— 视图行上的「钉住」', () => {
	// 读者钉**什么**是他们自己的事：一个没有路径的视图是本列表记住的一处地点、也是本列表
	// 画的一行，而一个钉是关于那一**行**的。与笔记不同的只是菜单的**大小** —— 一个视图
	// 不命名任何文件，所以什么都不向 app 询问（见 body.ts 的 contextRow）。
	const graph = { kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: NOW } as NavEntry;
	const spots = () => [visit('a.md', NOW - MINUTE), graph];
	const files = { 'a.md': '' };
	const graphRow = (h: ReturnType<typeof harness>) =>
		h.notes().find(r =>
			r.querySelector('.nav-row-name')?.textContent === t('recentFiles.graphView'))!;

	it('视图从自己那份菜单里被钉住，置顶区把它画出来', () => {
		const h = harness(spots(), 1, files);

		h.rightClick(graphRow(h));
		Menu.shown.at(-1)!.items.find(i => i.title === t('recentFiles.pin'))!.click!();

		// 视图以它的**类型**命名，而这正是路径说不出的事（见 nav/entry.ts 的
		// navGroupKey）。
		expect(h.pin).toHaveBeenCalledWith('view:graph');
		expect(h.notes()[0].classList.contains('is-pinned')).toBe(true);
		expect(h.notes()[0]).toBe(graphRow(h));
	});

	it('手机上从被触发行自己那个控件调出同一份菜单', () => {
		// 在手机上这个控件是**唯一**的门，而一个视图的行从前根本没有它 ——
		// 这让视图在读者最常钉住的地方钉不了。
		const h = harness(spots(), 1, files, [], {}, {}, true);
		const row = graphRow(h);

		h.longPress(row);
		const more = row.querySelector<HTMLElement>('.nav-row-menu');
		expect(more).not.toBeNull();
		h.clickRow(more!);

		expect(Menu.shown.at(-1)!.items.map(i => i.title))
			.toEqual([t('recentFiles.openInNewTab'), t('recentFiles.pin')]);
	});
});

describe('RecentFilesModal —— 行怎么称呼这篇笔记', () => {
	// 读者在设置里指定的**一个**属性，笔记没有该属性时则用文件自己的名字：整条
	// 规则就这些，所以没有第二个设置去说更偏好哪个（见 reads.ts 的 titleOf）。
	const spots = () => [visit('b.md', NOW - MINUTE), visit('a.md', NOW)];
	const files = { 'a.md': '', 'b.md': '' };
	const named = (title: string) => prefs({ title }).browser;
	const cacheWith = (props: Record<string, unknown>) => ({ frontmatter: props });
	const names = (h: ReturnType<typeof harness>) =>
		h.notes().map(r => r.querySelector('.nav-row-name')?.textContent);

	it('印出读者指定的那个属性，缺了就退回文件名', () => {
		const h = harness(spots(), 1, files, [], {}, {
			'a.md': cacheWith({ title: '每周回顾' }),
			'b.md': cacheWith({}),
		}, false, {}, named('title'));

		// a.md 是最新的，它也是那个自带名字的。
		expect(names(h)).toEqual(['每周回顾', 'b']);
	});

	it('设置还空着时一律印文件名，笔记里怎么写都不管', () => {
		// 关是默认值，它就得意味着关：一个用文件名给笔记命名的 vault 不欠这一行
		// 任何东西，此时待在一篇笔记里的 `title` 只是它还能被**搜索**的另一个名字
		// （见上面的套件）。
		const h = harness(spots(), 1, files, [], {}, {
			'a.md': cacheWith({ title: '每周回顾' }),
		}, false, {}, prefs().browser);

		expect(names(h)).toEqual(['a', 'b']);
	});

	it('只认单段文本当名字', () => {
		// 一个列表、一个年份或一个被清空的属性都不是名字：一个瞎猜的行会在本该是
		// 读者笔记的地方印出 "[object Object]" 或 "2024"。
		const h = harness([
			visit('b.md', NOW - 3 * MINUTE),
			visit('c.md', NOW - 2 * MINUTE),
			visit('a.md', NOW),
		], 2, { 'a.md': '', 'b.md': '', 'c.md': '' }, [], {}, {
			'a.md': cacheWith({ title: ['one', 'two'] }),
			'b.md': cacheWith({ title: 2024 }),
			'c.md': cacheWith({ title: '   ' }),
		}, false, {}, named('title'));

		expect(names(h)).toEqual(['a', 'c', 'b']);
	});

	it('按它印出来的名字能搜到，两篇同名的也能分辨', () => {
		// 被搜索的和被分辨的是同一个名字，即这一行印出来的那个：一篇在前置元数据
		// 里改过名的笔记，在它上面处处是同一个名字。
		const h = harness([
			visit('notes/a.md', NOW - MINUTE),
			visit('other/b.md', NOW),
		], 1, { 'notes/a.md': '', 'other/b.md': '' }, [], {}, {
			'notes/a.md': cacheWith({ title: '周会' }),
			'other/b.md': cacheWith({ title: '周会' }),
		}, false, {}, named('title'));

		// 两行都读作 周会，是读者无从挑选的两行，所以会印出一个路径 —— 和两个同名文件的情形
		// 一模一样。印的是**文件自己的**路径，而不是光文件夹：这些名字是借来的，所以文件夹不是
		// 错答案，只是个答了一半的答案。
		expect(names(h)).toEqual(['周会', '周会']);
		expect(h.notes().map(r => r.querySelector('.nav-row-path')?.textContent))
			.toEqual(['other/b.md', 'notes/a.md']);

		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		box.value = '周会';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(names(h)).toEqual(['周会', '周会']);
		// ……而文件自己的名字仍然能找到它，那也是读者在别处处处见到的名字。
		box.value = 'a.md';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(names(h)).toEqual(['周会']);
	});

	it('名字是借来的之后，仍然说得出它是哪个文件', () => {
		// 一个把每条路径都印出来的行，比一个什么都不印的行说得多不了哪去：光凭文件夹
		// 命名不了任何文件，而在一个借来的名字下名字单元格也一样 —— 所以两种「总是」
		// 模式都欠文件它自己的名字、且要在同一行上，否则这一行所代表的笔记就是它从不
		// 说出口的那一件事。
		const h = harness(spots(), 1, files, [], {}, {
			'a.md': cacheWith({ title: '每周回顾' }),
		}, false, {}, prefs({ title: 'title', path: 'before' }).browser);

		expect(names(h)).toEqual(['每周回顾', 'b']);
		expect(h.notes().map(r => r.querySelector('.nav-row-path')?.textContent))
			.toEqual(['a.md', '/']);
		// ……悬停上也不再提路径：这一行刚说过它了，而悬停是留给行省略掉的东西的
		// （见 fileRow）。
		expect(h.hover(h.notes()[0])).toBeNull();

		// 在哪里都不印路径时，文件自己的名字就在一次悬停之外 —— 一个没要求显示路径
		// 的读者，不是一个没法问这是哪篇笔记的读者。
		const quiet = harness(spots(), 1, files, [], {}, {
			'a.md': cacheWith({ title: '每周回顾' }),
		}, false, {}, named('title'));
		expect(quiet.notes()[0].querySelector('.nav-row-path')).toBeNull();
		expect(quiet.hover(quiet.notes()[0])?.querySelector('.nav-tip-path')?.textContent)
			.toBe('a.md');
	});

	it('印出来的名字变了才重画，别的编辑不重画', () => {
		// 读者正在笔记里**键入**那个属性，而行就立在那里印着旧名字。笔记里任何一处
		// 编辑都会让它重新解析，所以值得重画的是名字**此刻**变了 —— 每敲一键就整份
		// 重建列表，就是不比较的代价。
		const cache = { 'a.md': cacheWith({ title: 'One' }) };
		const h = harness([visit('a.md', NOW)], 0, files, [], {}, cache, false, {},
			named('title'));
		expect(names(h)).toEqual(['One']);

		// 按位置而不是按名字：这一行的名字正是读者脚下即将变掉的东西。
		const row = h.notes()[0];
		cache['a.md'].frontmatter.title = 'Two';
		h.changeFile('a.md');
		expect(names(h)).toEqual(['Two']);
		// ……而它是被重新画出来、不是被打补丁：这一行是个新元素。
		expect(h.notes()[0]).not.toBe(row);

		const same = h.notes()[0];
		cache['a.md'].frontmatter.aliases = 'something else';
		h.changeFile('a.md');
		expect(names(h)).toEqual(['Two']);
		expect(h.notes()[0]).toBe(same);
	});

	it('读者换一个属性时，重画它印出来的名字', () => {
		// 这个属性是一个**读者**而不是一个值，设置页一有变动就会请常驻面板重画一次
		// （见 BROWSER_PREF_KEYS）。跟它一起必须走的是名字的记忆：那些是**按路径**存
		// 的、能活过一次重画（见 reads.ts），所以一个留着它们不放的缓存在读者换过属性
		// 之后，会印出它在读者已然抛下的那个属性下读到的名字。
		const cache = {
			'a.md': cacheWith({ title: '每周回顾', name: '另一个名字' }),
		};
		const chosen = prefs({ title: 'title' });
		const h = harness(spots(), 1, files, [], {}, cache, false, {}, chosen.browser);
		expect(names(h)).toEqual(['每周回顾', 'b']);

		chosen.state.title = 'name';
		h.changed();
		expect(names(h)).toEqual(['另一个名字', 'b']);

		// ……而清空后又回到关：此时一篇笔记由它自己的名字来称呼，无论它怎么写。
	chosen.state.title = '';
	h.changed();
	expect(names(h)).toEqual(['a', 'b']);
});

// 那四个箭头 —— 面板为没有键盘的设备给出的答案，也是其中唯一一个作用于**笔记**
// 而不是作用于列表的控件。这里测的是 body 那一半：一次按压会运行插件指定的那个
// 动作、一次 body 答不出的按压会被置灰而不是用空来作答、以及这条箭头条在每个外壳
// 里都会被画出来 —— 它没有开关，列表脚边四个按钮不费列表任何东西，而一个没有键盘
// 的读者也没有别的办法来发问。
describe('RecentFilesModal —— 那四个箭头', () => {
	const files = { 'a.md': '', 'b.md': '' };
	const two = (): NavEntry[] => [visit('a.md', NOW - MINUTE), visit('b.md', NOW)];

	// 这条箭头条和它的四个按钮，是按它们自己的 class 而不是按它们站的位置来找到的：
	// 条站在哪儿是样式表的事（手机把它放在列表下方，在样式套件里断言），而 jsdom
	// 不做任何布局。
	const strip = (h: ReturnType<typeof harness>) =>
		h.el.querySelector<HTMLElement>('.position-restore-nav-arrows')!;
	const buttons = (h: ReturnType<typeof harness>) =>
		Array.from(h.el.querySelectorAll<HTMLButtonElement>('.position-restore-nav-arrow'));
	const press = (button: HTMLButtonElement) =>
		button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

	it('执行插件指定的那个动作，为此关掉这个对话框', () => {
		// 每个各按一次，而对话框**先**关掉：它挡在这些动作所作用的笔记上面，所以一次
		// 读者看不见的移动就是一次没发生过的移动。
		for (const [at, act] of [[0, 'back'], [1, 'forward'], [2, 'top'], [3, 'bottom']] as const) {
			const h = harness(two(), 1, files);
			const close = vi.spyOn(h.modal, 'close');
			press(buttons(h)[at]);
			expect(h.arrows.pressed).toEqual([act]);
			expect(close).toHaveBeenCalled();
		}
	});

	it('每个按钮都用它运行的命令来命名', () => {
		// 与命令面板里同样的字眼，也是面板上唯一说出后两个去往**谁的**两端的地方：
		// 「笔记顶部」，不是「这个列表的顶部」。
		const h = harness(two(), 1, files);
		expect(buttons(h).map(b => b.getAttribute('aria-label'))).toEqual([
			t('navHistory.commands.navigateBack'),
			t('navHistory.commands.navigateForward'),
			t('noteEdge.commands.top'),
			t('noteEdge.commands.bottom'),
		]);
	});

	it('它虽然挨着列表，自己不是列表里的一行', () => {
		// 在列表上放四个箭头的全部难处：箭头条属于面板，而列表是那个 listbox。
		const h = harness(two(), 1, files);
		expect(h.list().contains(strip(h))).toBe(false);
		expect(strip(h).parentElement).toBe(h.el);
		// ……而它排在列表**之后**，因为那才是它在屏幕上的位置（见样式套件）：没有任何
		// 东西重排它，所以 Tab 按眼睛的顺序到达它、而不是先跳到面板脚边。
		const bands = Array.from(h.el.children);
		expect(bands.indexOf(strip(h))).toBeGreaterThan(bands.indexOf(h.list()));
	});

	it('做不了事的箭头置灰，每次重画都再问一次', () => {
		const h = harness(two(), 1, files);
		const [back, forward, top, bottom] = buttons(h);
		expect([back.disabled, forward.disabled, top.disabled, bottom.disabled])
			.toEqual([false, false, false, false]);

		// 两端跟随的是**笔记**而不是这个列表，这正是把它们置灰所一直在明说的：没有
		// 打开的笔记，它们就没有可去之处。
		h.arrows.set({ back: false, edge: false });
		h.changed();
		expect([back.disabled, forward.disabled]).toEqual([true, false]);
		expect([top.disabled, bottom.disabled]).toEqual([true, true]);
		expect(bottom.classList.contains('is-disabled')).toBe(true);
	});

	it('方向键留给拿着焦点的那个控件', () => {
		// 列表的走法是过滤框的走法：一个拿着焦点的按钮自己应答方向键，而回车就是它
		// 自己的按压。
		const h = harness(two(), 1, files);
		const onPanel = new KeyboardEvent('keydown', {
			key: 'ArrowDown', bubbles: true, cancelable: true,
		});
		h.el.dispatchEvent(onPanel);
		expect(onPanel.defaultPrevented).toBe(true);

		const onButton = new KeyboardEvent('keydown', {
			key: 'ArrowDown', bubbles: true, cancelable: true,
		});
		buttons(h)[2].dispatchEvent(onButton);
		expect(onButton.defaultPrevented).toBe(false);
	});
});
});
