// 最近文件**对话框**的 DOM 级交互测试 —— 面板的机制：光标停在哪儿、一次点击去哪儿、
// 键盘走什么、搜索框认出哪些名字、以及那些已经不在这儿了的行。
// 这一批是「面板怎么动」：行长什么样在 recent-files-browser-dom-rows.test.ts，触屏、
// 悬停、置顶与箭头各在同前缀的那几个文件里；装置见 support/recent-files-modal-harness.ts。
// 纯的那些部分（describe/group/merge/filter/time）由 recent-files-browser.test.ts 覆盖。

import { describe, it, expect, vi } from 'vitest';
import { Menu } from './support/obsidian-stub';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { NavEntry } from '@/nav/entry';
import { t } from '@/i18n';
import {
	LATE_READ_REDRAW_MS,
} from '@/recent-files/browser/constants';
import {
	A_DOC, A_HEADINGS, MINUTE, NOW, SPREAD_DOC, SPREAD_HEADINGS, harness, installHarness, movedOnto, prefs, visit,
} from './support/recent-files-modal-harness';

installHarness();

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

	it('按下之后拖到别处才松开的点击，什么都不打开', () => {
		// 一次跨行的拖拽也会把点击交给列表：浏览器解析的是按下处与松开处最近的那位共同
		// 祖先，而两行共享的正是列表自己。但读者拖离了那一篇 —— 他没有要求去那里。
		const entries = three();
		const h = harness(entries, 2, files);
		const at = (type: string, y: number) =>
			h.note('a').dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: 40, clientY: y }));

		at('pointerdown', 40);
		h.list().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 300 }));

		expect(h.jumpTo).not.toHaveBeenCalled();

		// ……而那次拖拽记下的身份也随它一起被收走：留在那里的会是一次埋伏 —— 下一次落在
		// 最后一行下面那片空上的点击会打开读者很早以前按过的那一篇。
		h.list().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 300 }));
		expect(h.jumpTo).not.toHaveBeenCalled();
	});

	it('原地按下的点击，哪怕行被重画掉了也照样应答', () => {
		// 同一件事的另一面：被按下的那一行没了、而手指**没有**挪动，那次点击要的正是它
		// 按下时点名的那一篇（见上一条用例）。
		const entries = three();
		const h = harness(entries, 2, files);
		h.note('a').dispatchEvent(
			new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 40 }),
		);
		h.changed(0);
		h.list().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 42 }));

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
describe('RecentFilesModal —— 输入法组合', () => {
	// 中文/日文/韩文经输入法打字时，每一次击键都会发一个 input，而那时框里还是一串没定型的
	// 中间态（拼音、未提交的假名）—— 它不是读者的查询，要到组合结束才交出去（见 body.ts 的
	// toolbar）。少了这一档，一个敲三下拼音的词会把整份列表白画三遍。
	it('组合期间不重画，组合结束才把查询交出去', () => {
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' });
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;
		// 一次重画是**整表重建**，所以「没重画」就是**同一批元素还在**。
		const before = h.note('a');

		// 组合中：框里已经攥着「a」，但列表一个字都没窄。
		box.value = 'a';
		box.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
		expect(h.notes()).toHaveLength(2);
		expect(h.note('a')).toBe(before);

		// 组合结束：这一次才把查询交出去 —— b.md 不含「a」，只剩它那一行。
		box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
		expect(h.notes()).toHaveLength(1);
		expect(h.note('a')?.querySelector('.nav-row-name')?.textContent).toBe('a');
	});

	it('非组合的输入照旧即时生效', () => {
		// 英文直输、粘贴、点 × 清空都不经过组合，所以它们不能被这一档连累。
		const h = harness([visit('a.md', NOW - MINUTE), visit('b.md', NOW)], 1, { 'a.md': '', 'b.md': '' });
		const box = h.el.querySelector<HTMLInputElement>('.position-restore-nav-filter')!;

		box.value = 'b';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		expect(h.notes()).toHaveLength(1);
		expect(h.note('b')?.querySelector('.nav-row-name')?.textContent).toBe('b');
	});
});
