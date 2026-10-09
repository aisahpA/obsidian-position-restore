// 置顶（钉住）与面板脚下那四个箭头：钉选是读者关于一篇笔记自己的答案，存成
// 按次序的 key 列表；箭头是给没有键盘的读者的那四件事（见 arrows.ts）。

import { describe, it, expect, vi } from 'vitest';
import { Menu, Notice } from './support/obsidian-stub';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { NavEntry } from '@/nav/entry';
import { t } from '@/i18n';
import {
	MINUTE, NOW, defaultPrefs, harness, installHarness, prefs, visit,
} from './support/recent-files-modal-harness';

installHarness();

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
			items: {
				title: string; section: string; icon: string; warning: boolean; click?: () => void;
			}[];
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

	it('只靠钉顶着规则的行，菜单项事前写明后果并标成警示', () => {
		// 读者立过的规则自己早忘了：没有这项预警，取消置顶后行当场消失会被读成删除
		// （见 body.ts 的 pinItems / places.ts 的 wouldUnpinDrop）。
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md'], undefined, ['a.md']);
		h.rightClick(h.note('a'));
		const warned = items(h).find(i => i.icon === 'pin-off')!;
		expect(warned.title).toBe(t('recentFiles.unpinExcluded'));
		expect(warned.warning).toBe(true);

		// 规则管不着的行只摘钉：原文案、不标警示。
		const other = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['b.md']);
		other.rightClick(other.note('b'));
		const plain = items(other).find(i => i.icon === 'pin-off')!;
		expect(plain.title).toBe(t('recentFiles.unpin'));
		expect(plain.warning).toBe(false);
	});

	it('点下预警项，行当场离开；提示里的撤销把它原样钉回来', () => {
		// 行的离开方式不变（立刻、不用确认），补上的是事后那一条路：提示念出规则名，
		// 撤销把条目和钉一起放回（见 body.ts 的 explainUnpinDrop）。
		Notice.reset();
		const h = harness(three(), 2, files, [], {}, {}, false, {}, defaultPrefs(),
			undefined, ['a.md'], undefined, ['a.md']);

		h.rightClick(h.note('a'));
		item(h, t('recentFiles.unpinExcluded')).click!();

		expect(h.unpin).toHaveBeenCalledWith('a.md');
		expect(names(h)).toEqual(['c', 'b']);
		expect(h.pinned).toEqual([]);
		expect(Notice.instances).toHaveLength(1);
		const notice = Notice.instances[0];
		expect(notice.message)
			.toBe(t('recentFiles.unpin.removedByRule', t('recentFiles.folders.name')));
		const undo = notice.messageEl.querySelector('button')!;
		expect(undo.textContent).toBe(t('recentFiles.unpin.undo'));

		undo.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.restorePinned).toHaveBeenCalledTimes(1);
		expect(names(h)).toEqual(['a', 'c', 'b']);
		expect(h.pinned).toEqual(['a.md']);
		expect(notice.hidden).toBe(true);
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

	it('列表取第一项，其余不是文字的值不算名字', () => {
		// 读者把想要的那个写在列表最前面，所以列表认首元。一个年份、或一个被清空的属性
		// 都不是名字：一个瞎猜的行会在本该是读者笔记的地方印出 "2024"。
		const h = harness([
			visit('b.md', NOW - 3 * MINUTE),
			visit('c.md', NOW - 2 * MINUTE),
			visit('a.md', NOW),
		], 2, { 'a.md': '', 'b.md': '', 'c.md': '' }, [], {}, {
			'a.md': cacheWith({ title: ['one', 'two'] }),
			'b.md': cacheWith({ title: 2024 }),
			'c.md': cacheWith({ title: '   ' }),
		}, false, {}, named('title'));

		expect(names(h)).toEqual(['one', 'c', 'b']);
	});

	it('首项不是文字就不算名字，不往后找', () => {
		// 「取第一项」是一条规则，不是一个搜索：一个空列表、一个首项是年份的列表、
		// 一个首项是空白的列表都退回文件名，而不是拿第二项凑一个名字出来。
		const h = harness([
			visit('a.md', NOW - 2 * MINUTE),
			visit('b.md', NOW - MINUTE),
			visit('c.md', NOW),
		], 2, { 'a.md': '', 'b.md': '', 'c.md': '' }, [], {}, {
			'a.md': cacheWith({ title: [] }),
			'b.md': cacheWith({ title: [2024, 'x'] }),
			'c.md': cacheWith({ title: ['  ', 'x'] }),
		}, false, {}, named('title'));

		expect(names(h)).toEqual(['c', 'b', 'a']);
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
