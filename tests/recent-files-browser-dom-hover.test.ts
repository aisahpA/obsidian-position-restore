// 悬停这条链路：指针**真的动了**才问 app 要一页（见 list.ts 的 hoverAt），要的那
// 一行是位置数据库对一次普通打开的回答，而 app 的答案迟到时面板不猜（见
// hover-settle.ts）。

import { describe, it, expect, vi } from 'vitest';
import type { HoverParent } from 'obsidian';
import { RecentFilesModal } from '@/recent-files/browser/modal';
import type { EphemeralState, PreviewFocusMode } from '@/types';
import type { NavEntry } from '@/nav/entry';
import { t } from '@/i18n';
import {
	LATE_READ_REDRAW_MS, NAV_SOURCE_ID,
} from '@/recent-files/browser/constants';
import {
	MINUTE, NOW, SPREAD_DOC, defaultPrefs, harness, installHarness, movedOnto, pointer, prefs, visit,
} from './support/recent-files-modal-harness';

installHarness();

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
