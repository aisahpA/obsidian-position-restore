// 面板脚下的**四个箭头**：一个没有键盘的读者，以及他们否则无从要求的那四件事 —— 一步
// 后退与前步，以及他们打开着的笔记的两端。
//
// 这四个是**插件**的动作，由 shell 交下来、而不是由面板来跑：一个 body 不持有历史、也
// 不持有自己的笔记 —— 栈的两端、以及立在它们之下的那篇笔记，都是插件的 —— 所以这里只发问，
// 而正是这一点让一个什么都不会做的按钮变灰（见 refresh）。
//
// **每个 shell 都画出它们**，没有被关掉的开关：列表脚下的四个按钮不花列表任何东西（它们
// 不是行，也不随任何东西滚动），而一个没有键盘的读者没有其它办法要求这四个中的任何一个。
// 一个动作**可以**是异步的 —— 一步打开一篇笔记并等它 —— 而这个 promise 是本部件再次发问
// 的信号（见 press）。

import { setIcon } from 'obsidian';
import { t } from '@/i18n';

// **一个箭头**，而四个是这样：两个走读者自己的步，两个去往他们正站在其中的那篇笔记的
// 两端。
export type ArrowAct = 'back' | 'forward' | 'top' | 'bottom';

// **两个胶囊、而不是四个一行**：两对是不同的东西，而立在列表上方的四个箭头读起来像
// 四种滚动那张列表的方式 —— 那正是它们绝不能被误认为的东西。两者之间的那道空隙，
// 就是全部的区别所在。
const ARROW_GROUPS: readonly (readonly [ArrowAct, ArrowAct])[] = [
	['back', 'forward'],
	['top', 'bottom'],
];

// 箭头到线、而不是光秃秃的箭头：展示给读者的那个字形，其箭杆**终止于一条线**上，
// 而那正是一篇笔记的一端。一个尖角号（chevron）主张的是相反的事 —— 一步，朝着它
// 所指的方向。
const ARROW_ICON: Record<ArrowAct, string> = {
	back: 'arrow-left',
	forward: 'arrow-right',
	top: 'arrow-up-to-line',
	bottom: 'arrow-down-to-line',
};

// 一个按钮**叫**什么，借用自这四个所运行的命令：命令面板上与按钮上是同样的词，也是
// 面板里唯一说出其中两个去往**谁的**端的地方（"top of note" —— 笔记的端，不是这份列表的）。
const ARROW_NAME: Record<ArrowAct, Parameters<typeof t>[0]> = {
	back: 'navHistory.commands.navigateBack',
	forward: 'navHistory.commands.navigateForward',
	top: 'noteEdge.commands.top',
	bottom: 'noteEdge.commands.bottom',
};

// **箭头所承载的四个动作**，以及每一个是否能做。本部件不持有任何历史、也不持有自己的笔记
// —— 栈的两端、以及立在它们之下的那篇笔记，都是插件的 —— 所以 shell 把动作交下来、
// 这里只发问，而正是这个让一个什么都不会做的按钮变灰（见 refresh）。
export interface RecentFilesBrowserArrows {
	back: () => void | Promise<void>;
	forward: () => void | Promise<void>;
	top: () => void | Promise<void>;
	bottom: () => void | Promise<void>;
	canBack: () => boolean;
	canForward: () => boolean;
	// 是否有一篇笔记打开着、可供那两端作用。
	canEdge: () => boolean;
}

export class ArrowBar {
	// 那四个按钮，保留是因为每次绘制都会问它们每一个是否仍能被按下（见 refresh）。
	private byAct = new Map<ArrowAct, HTMLButtonElement>();

	// 建在 `host` 的**末尾**：面板由之构成的几条带（筛选、列表、箭头）是一个 flex 列，
	// 而这条横带是那个保住自己高度的 —— 一条钉在滚动列表下面的横带，就是这买到的一切。
	// 由 shell 在它的列表元素**之后**调用（见 body.ts 的 mount）。像工具栏一样每个 body
	// 只建一次：
	// 每次重画都重建的一个条会把读者正伸手去够的按钮从他们手底下抽走。
	//
	// `beforeAct` 是一次按下之前 shell 自己的反应 —— 让开路。在手机上，面板盖住了这些
	// 动作所作用的笔记，所以一次读者看不见的移动是一次没有发生的移动。
	constructor(
		private host: HTMLElement,
		private arrows: RecentFilesBrowserArrows,
		private beforeAct: () => void,
	) {
		const bar = host.createDiv({ cls: 'position-restore-nav-arrows' });
		for (const group of ARROW_GROUPS) {
			const capsule = bar.createDiv({ cls: 'position-restore-nav-arrow-group' });
			for (const act of group)
				this.byAct.set(act, this.button(capsule, act));
		}
	}

	// 每个箭头能否被按下，向插件发问而不是在这里算出来：步是栈的，而笔记是工作区的。
	// **每次绘制**都再问一次 —— 从任何地方走出的一步都会改变两个答案 —— 而没有笔记打开
	// 时那两端会安静下来，那是面板上唯一说出它们是谁的端的东西。
	refresh(): void {
		const arrows = this.arrows;
		this.enabled('back', arrows.canBack());
		this.enabled('forward', arrows.canForward());
		const edge = arrows.canEdge();
		this.enabled('top', edge);
		this.enabled('bottom', edge);
	}

	// 一个箭头被按下。**shell 先让开路**，正如它对一行所做的那样。
	press(act: ArrowAct): void {
		this.beforeAct();
		const arrows = this.arrows;
		const ran = act === 'back' ? arrows.back()
			: act === 'forward' ? arrows.forward()
			: act === 'top' ? arrows.top()
			: arrows.bottom();
		// **在该动作落地之后**再次发问，而不是当场问：一步打开一篇笔记并等它，而在它下面
		// 发问会让两个箭头一起变灰那么久 —— 这就是两个活按钮看起来像两个坏按钮的原因。
		// 对话框在按下时就关闭，所以它欠的那次发问，可能发现这四个已经不在屏幕上了。
		void Promise.resolve(ran).then(() => this.refresh());
	}

	// 本部件不再持有屏幕上的任何东西：一次按下可能仍欠着的那次发问，是为随持有它们的
	// shell 一起离开屏幕的按钮作答的。
	forget(): void {
		this.byAct.clear();
	}

	private button(capsule: HTMLElement, act: ArrowAct): HTMLButtonElement {
		const name = t(ARROW_NAME[act]);
		const button = capsule.createEl('button', {
			cls: 'clickable-icon position-restore-nav-arrow',
			attr: { type: 'button', 'aria-label': name, title: name },
		});
		setIcon(button, ARROW_ICON[act]);
		// **这次按下被拒绝取得焦点**，正如框的 × 拒绝它：一个取得光标的控件会把下一次击键
		// 变成什么都没有，而读者正在输入的东西会跑进这个控件旁边的框里。它照样仍是键盘
		// 穿过面板途中的一个停靠点 —— Tab 能到达它、Enter 能按下它 —— 那是不用指针就能
		// 按下一个按钮的唯一办法。
		button.addEventListener('mousedown', (ev) => ev.preventDefault());
		button.addEventListener('click', () => this.press(act));
		return button;
	}

	// 一个变灰的按钮不只是按不下去：它是「那里什么都没有」这个答案，给出在读者已经在看
	// 的地方。
	private enabled(act: ArrowAct, on: boolean): void {
		const button = this.byAct.get(act);
		if (!button)
			return;
		button.disabled = !on;
		button.toggleClass('is-disabled', !on);
	}
}
