// 触屏上的那份列表：没有悬停可用，于是**武装**一根停住的手指，而长按既升起菜单也
// 标记那一行（见 list.ts 的 arm / markPressed）。触屏设备是内联的那种，因为 jsdom
// 没有 matchMedia 可问（见装置的 mobile 参数）。

import { describe, it, expect, vi } from 'vitest';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import { t } from '@/i18n';
import {
	LONG_PRESS_MS, PANEL_EXIT_GRACE_MS, ROW_PRESS_HOLD_MAX_MS, ROW_PRESS_MARK_MS, TIP_DELAY_MS,
} from '@/recent-files/browser/constants';
import {
	MINUTE, NOW, SPREAD_DOC, SPREAD_HEADINGS, harness, installHarness, pointer, prefs, visit,
} from './support/recent-files-modal-harness';

installHarness();

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

	// 武装属于**这一根手指**：抬起结束不了它（读者抬起是为了去够那些控件），但一根在别处
	// 松手的手指不是在去够它们 —— 它移开了。而它在别处松手时，没有别的东西会替它收场：
	// 滑出列表的手指不会再让列表滚动一次，它的点击也到不了列表。
	it('手指在别处抬起时，那一行不再武装', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		expect(row.classList.contains('is-armed')).toBe(true);

		// 抬起发生在**另一行**上 —— 一根从它停住的那一行滑走的手指。
		lift(h.note('a'));

		expect(row.classList.contains('is-armed')).toBe(false);
		// ……而标记也随它走：留在那一行上的会是一个落在没人在指的行上的标记。
		expect(row.classList.contains('is-pressed')).toBe(false);
	});

	// 同上，而这次是平台把手势从这根手指手里拿走 —— 第二根手指落下、或一次滚动的开始。
	// 那从来不是读者做完的一次按下。
	it('手势被拿走时，那一行不再武装', () => {
		const h = phone();
		const row = h.note('b');

		down(row);
		rest();
		expect(row.classList.contains('is-armed')).toBe(true);

		finger(row, 'pointercancel');

		expect(row.classList.contains('is-armed')).toBe(false);
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
