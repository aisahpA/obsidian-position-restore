// 一行**长什么样**：一行 = 一篇笔记、搜到的小节各占一行、名字与类型与路径、行上说的
// 那些话（提示条与时间）、一次点击与右键菜单去哪儿、以及同名的两篇笔记怎么被分开。
// 装置见 support/recent-files-modal-harness.ts。

import { describe, it, expect, vi } from 'vitest';
import { Menu } from './support/obsidian-stub';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { NavEntry } from '@/nav/entry';
import { t } from '@/i18n';
import {
	TIP_DELAY_MS,
} from '@/recent-files/browser/constants';
import {
	KeymapKnobs, MINUTE, NOW, SPREAD_DOC, SPREAD_HEADINGS, harness, installHarness, prefs, visit,
} from './support/recent-files-modal-harness';

installHarness();

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
