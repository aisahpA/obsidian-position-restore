// 最近文件**对话框**的测试装置：那个假 app、那个 harness，以及每个套件都要的那对
// beforeEach/afterEach。
//
// 它是从 tests/recent-files-browser-dom.test.ts 搬出来的 —— 那个文件一度把这些装在
// 自己头上，于是 27 个套件共用一个 350 行的装置，而任何想只跑其中一个套件的人也得把
// 它们全读一遍。**常驻面板有自己的一套**（见 recent-files-sidebar.test.ts），本文件
// 只管对话框。
//
// 各套件按名字取用这里的每一样东西；`installHarness()` 必须在**模块顶层**调用一次，
// 因为它装的是钩子 —— 放进一个 describe 里就只罩住那一个。

import { beforeEach, afterEach, vi } from 'vitest';
import { Keymap, MarkdownView, Platform, TFile } from 'obsidian';
import type { EphemeralState, PathDisplayMode, PreviewFocusMode } from '@/types';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { RecentFilesBrowserPrefs } from '@/recent-files/browser/body';
import type { RecentFilesBrowserArrows } from '@/recent-files/browser/arrows';
import { navGroupKey, type NavEntry } from '@/nav/entry';
import type { NavEntryState } from '@/types';
import { TIP_DELAY_MS } from '@/recent-files/browser/constants';

// jsdom 没有 PointerEvent，而 `pointerType` 是面板用来分辨鼠标与手指的那一个字段：
// 用一个 MouseEvent 顶替它，种类随后写上去。凡是必须说出「是哪一种指针」的套件都共用
// 它，因为面板对这两者**故意**给不同的答案（见 body.ts 的悬停规则、
// RecentFilesList.hoverAt 与 tip.ts）：鼠标悬停是鼠标在读，手指则将要点击。
// ……以及它在**哪儿**，这是面板所读的另一半：只有当指针**移动过**，它才会向 app 要
// 一页，所以在同一处的两个事件是一只手没动过（面板在它底下冒出来），而测试没有指定
// 位置的事件被放到一个新地方。`held` 说这只手**没有**动 —— 那是面板必须与「移动」
// 区分开来的唯一情形（见 RecentFilesList.hoverAt）。
let cursor = { x: 0, y: 0 };
export const pointer = (type: string, kind: 'mouse' | 'touch' = 'mouse', held = false) => {
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
export const movedOnto = (el: HTMLElement, kind: 'mouse' | 'touch' = 'mouse') => {
	el.dispatchEvent(pointer('pointermove', kind));
	el.dispatchEvent(pointer('pointermove', kind));
};


// 在本套件**运行时**，'obsidian' 解析到 tests/support/obsidian-stub.ts（见
// vitest.config.mts），但 tsc 从真正那个只有类型的包里读它的类型 —— 那个包只声明了
// 插件要问的两个问题（isModEvent / isModifier），别的一概没有。桩的答案是测试设定的
// **输入**，所以通过一次诚实的类型断言抵达它们，而不是假扮到 app 自己的类上。
export const KeymapKnobs = Keymap as unknown as {
	reset(): void;
	modEvent: unknown;
	modifier: boolean;
};

export const MINUTE = 60_000;
export const NOW = Date.now();

// 为一个 harness 准备的一套偏好（有时是两套，当测试想展示在设置页做出的选择就是下一个
// 对话框打开时所遵照的选择）。面板只**读**它们（见 RecentFilesBrowserPrefs）—— 那些值
// 是插件的，改它们的是设置页 —— 所以这个 fixture 是一组对测试可写的值的**实时读者**，
// 正如设置页写它们那样。
export function prefs(start: {
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
export function defaultPrefs(): RecentFilesBrowserPrefs {
	return prefs().browser;
}

// 那四个箭头，按插件把它们交给一个 shell 的样子（见 RecentFilesBrowserArrows）：那几个
// 动作是插件的命令，所以测试想从它们身上要的是「按下了**哪一个**」—— 而 body 据以把它
// 们置灰的那些答案是测试设定的输入，正如上面那些偏好一样。（一个动作可以是异步的 ——
// 一步会打开一篇笔记并等它 —— 而面板在它落定后会再问一遍那四个；那段时序归侧边栏套件
// 覆盖，因为对话框在按下时就关了。）
export function defaultArrows(): RecentFilesBrowserArrows & {
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
export const visit = (path: string, stamp: number): NavEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp });

// 一次采集，按插件如今记录的样子：落点自己的位置，加视口顶那一行的锚点
// （见 NavEntryState）。它曾多带一件事——落点**下面**的那些**非空**行
// （`st.context`），镜像 capture/ephemeral.ts 里的 contextBelow；2026-10-03 与它的搜索面
// 一起撤掉了，于是这个 fixture 少掉那一半，而**位置与锚点**是生产形状。
export function captured(doc: string[], landing: number): NavEntryState {
	return {
		scroll: landing,
		anchor: doc[landing].trim(),
	};
}

// 下面那个 fixture 笔记的解析后标题，按 metadata cache 交出它们的形状（层级从 1 起、
// 位置是文件里的位置）。
export const A_DOC = '# 面板设计\n\n## 呈现方案\n\n### 预览\n\n预览条：悬停显示上下文三行\n\n尾巴\n';
export const A_HEADINGS = {
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
export const SPREAD_LINES = Array.from({ length: 24 }, (_, i) => `正文第 ${i + 1} 行`);
export const SPREAD_DOC = [
	'# 面板设计', '', '## 呈现方案', '', '### 预览', '',
	'预览条：悬停显示上下文三行', '',
	...SPREAD_LINES, '',
	'## 尾巴', '', '最后一段', '',
];
export const SPREAD_HEADINGS = {
	'a.md': [
		{ heading: '面板设计', level: 1, position: { start: { line: 0 } } },
		{ heading: '呈现方案', level: 2, position: { start: { line: 2 } } },
		{ heading: '预览', level: 3, position: { start: { line: 4 } } },
		{ heading: '尾巴', level: 2, position: { start: { line: 33 } } },
	],
};

export function harness(
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
	// 这些行此刻**只靠钉顶着排除规则**（见 NavPlaces.wouldUnpinDrop）：取消置顶会让它们
	// 当场离开。fixture 统一按「文件夹」那类规则演，菜单与提示的测试只需要有一条规则在场。
	unpinExcludes: string[] = [],
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
	// 取消置顶的缩微版，照真实 store 的两种结局演（见 NavPlaces.unpin）：普通行只摘钉；
	// unpinExcludes 里的行连条目一起被带走，结果里带着原因与那条记录，供提示的撤销放回。
	const unpin = vi.fn((key: string) => {
		const at = pinned.indexOf(key);
		if (at < 0)
			return { dropped: false } as const;
		pinned.splice(at, 1);
		if (!unpinExcludes.includes(key))
			return { dropped: false } as const;
		const rowAt = entries.findIndex(e => navGroupKey(e) === key);
		const [place] = rowAt >= 0 ? entries.splice(rowAt, 1) : [undefined];
		const current = entries[index];
		places.index = current ? entries.indexOf(current) : -1;
		return place
			? { dropped: true as const, reason: 'folder' as const, place }
			: { dropped: false } as const;
	});
	// 菜单事前问的那一句（见 NavPlaces.wouldUnpinDrop）。
	const wouldUnpinDrop = vi.fn((key: string) =>
		unpinExcludes.includes(key) ? 'folder' as const : undefined);
	// 撤销：条目与钉都原样回来（见 NavPlaces.restorePinned）。
	const restorePinned = vi.fn((place: NavEntry) => {
		const key = navGroupKey(place);
		if (!entries.some(e => navGroupKey(e) === key))
			entries.push(place);
		if (!pinned.includes(key))
			pinned.push(key);
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
		pin, unpin, wouldUnpinDrop, restorePinned, movePinned,
		isPinned: (key: string) => pinned.includes(key),
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
		pinned, pin, unpin, restorePinned, movePinned, arrows,
		trigger: app.workspace.trigger, cacheReads: () => cacheReads, changeFile, fileEvent,
		rows, notes, note, headings, heading, clickRow, pressRow, changed, rightClick, longPress,
		movePointer, key, hover, unhover, clearButton, clearFilter, forgetButton,
	};
}


// 每个套件都要的那对钩子。必须在**模块顶层**调用：它们装的是 jsdom 的收拾工作与
// 那个假时钟，而放进一个 describe 里就只罩住那一个。
export function installHarness(): void {
	// jsdom 根本不实现 layout，所以这是**缺**的，不是**坏**的。
	Element.prototype.scrollIntoView = () => {};

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
}
