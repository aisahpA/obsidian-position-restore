import { HoverParent, HoverPopover } from 'obsidian';
import { nextPaint } from '@/shared/wait';

// app 自己的预览在被要求去某一行时所做的那个跳转与那一闪，以及本模块是什么：
// 不是一个等它们完成的任务，而是一个**观察者**，只看着它们什么时候发生。
//
// 当被要求 `state: { scroll: n }` 时，core 的 markdown 弹出层**不会**开在那一行 —— 它做不到。
// 它的加载器先把整篇笔记画出来，之后才向渲染器要那个滚动：
// `applyScrollDelayed(scroll, {highlight:!0, center:!0})`。立即的那次尝试总是失败
// （文字还没渲染出来），于是它等 `onRendered`、在笔记落地时才施加滚动 —— 随之而来的是一个
// 三秒的 `.is-flashing` 高亮，那是上游给**搜索命中**打的标记。所以笔记先在其头部被看见，
// 然后跳一下，然后闪一下。
//
// 遮罩与藏住本插件自己那些恢复的是同一个思路（见 position/ui/cover.ts），但弹出层不是 leaf，
// 所以这里藏的是 app 的元素，是经由 app 交给我们的那个唯一把手借回来的：HoverParent 的
// `hoverPopover`，由 core 在预览打开时写入。不伸手去够任何私有东西 —— `hoverEl` 是有文档
// 记载的成员 —— 而这里任何东西找不到时，弹出层就不加遮罩地立着。
//
// 为什么用观察者而不是等待：app 什么时候作答是没有边界的。这个面板的注册要求按 Mod 键
// （见 main.ts），所以弹出层是在读者**按下**它时才出现的 —— 只要他们愿意，问过那一行之后
// 十秒钟才出现也行，到那时任何带截止时间的等待早已回家，把遮罩和「它开了」这条消息也一起带走。
// 所以一次询问**武装**一个循环，在悬停持续的整个期间盯着父级那个字段；剩下的唯一截止时间
// 是关于笔记自己那趟旅程的，而那是**有界**的 —— 一次渲染，然后一次滚动。

// 遮罩盖上之后，为那次延迟的滚动等多久、然后就展示那里的东西。只有在那一闪始终不来时才付这笔时间
// —— 渲染本身无论有没有遮罩都是一张空白卡片 —— 所以它保持很短：一篇先被看到头部、然后闪一下的
// 笔记，胜过一个被按住空白的卡片。
const LAND_MAX_MS = 600;

// core 给「延迟滚动落到的那个分节」起的名字，持续三秒。
const FLASH = 'is-flashing';

export class PreviewSettle {
	private parent?: HoverParent;
	// 在 app **已经**作答的那一刻说出，每个弹出层一次：到底有没有东西打开是 app 的决定 ——
	// 它的延迟、它的按键规则、它自己的开关。卡片随这条消息一起交出去，因为本模块之外
	// 没有别的东西另有把手够得到 app 画了什么（见 RecentFilesBrowser.liftPreview：
	// 从对话框里要来的预览必须把那个对话框清掉）。
	private onOpen?: (el: HTMLElement) => void;
	// 绘制循环，在它运行期间（见 start）。
	private running = false;
	// 指针是否**在列表上**：询问是活的，此时出现的弹出层属于它。由 hoverEnded 清除 ——
	// 那不是弹出层的结束（指针可能已经移到**它上面**去了），只是新询问的结束。
	private session = false;
	// 最新的那次询问是否点名了一行。分节就在它所在的地方被画出来、没有旅程要盖；
	// 而一行是先被整篇画出来、之后才被移动的。
	private wantCover = false;
	// 正在被跟踪的弹出层，在一个开着时 —— 即便悬停结束后也留着，好让一个回到列表的指针
	// 遇见一位老朋友，而不是第二次「发现」它（那会重报一次打开，而且对一次点名行的询问来说，
	// 会盖住一篇已经站在它那一行上的笔记）。它可能比弹出层本身活得还久：循环一旦停下，
	// 就没有东西清它，而弄清这一点的是下一次查看。
	private popover?: HoverPopover;
	// 此刻正在遮罩下面的那个元素，以及它里面到底被藏了什么：这里不去猜另一个元素的不透明度。
	private coveredEl?: HTMLElement;
	private hidden: HTMLElement[] = [];
	// 遮罩什么时候不再等那次滚动（见 LAND_MAX_MS）。
	private deadline = 0;

	// 这个面板知道、而本模块不知道的两件事：**盯谁**（每次询问都交给 app 的那个父级），
	// 以及 app 作答时**告诉谁**。
	attach(parent: HoverParent, onOpen: (el: HTMLElement) => void): void {
		this.parent = parent;
		this.onOpen = onOpen;
	}

	// 一行刚被交给 app（见 RecentFilesBrowser.hoverRow）：这里要说的全部，就是这次询问
	// 有没有点名一个**行**。这里所武装的循环有意比询问活得久，并在悬停结束时停下。
	ask(line: boolean): void {
		this.session = true;
		this.wantCover = line;
		// 一个已经立着的弹出层（指针从另一行横穿过来）：即将载入它的那篇笔记要走同一趟旅程，
		// 所以遮罩**现在**就盖上，而不是迟上一帧、让人瞥见笔记的头部。
		if (line) {
			const el = this.parent?.hoverPopover?.hoverEl;
			if (el && el.isConnected)
				this.beginCover(el);
		}
		this.start();
	}

	// 指针离开了**列表**：不再有活的询问，还盖着的遮罩就揭下来。弹出层本身仍被跟踪：
	// 关它是 app 的事，而读者可能正在读它。
	hoverEnded(): void {
		this.session = false;
		this.wantCover = false;
		if (this.coveredEl) {
			this.reveal();
			this.coveredEl = undefined;
		}
	}

	// 此刻是否有预览正立着开着，是问 app 自己的把手、而不是在这里记住：一个记下来的答案
	// 恰恰会在它要紧的那一刻过期。
	isOpen(): boolean {
		const el = this.parent?.hoverPopover?.hoverEl;
		return !!el && el.isConnected;
	}

	// 面板要走了：一个被留在遮罩下的弹出层，会是个比引起它的那些行活得还久的 bug。
	stop(): void {
		this.running = false;
		this.session = false;
		this.wantCover = false;
		this.popover = undefined;
		this.coveredEl = undefined;
		this.reveal();
	}

	private start(): void {
		if (this.running)
			return;
		this.running = true;
		void this.loop();
	}

	// 每次绘制看一眼，只要有东西可**等**：一次活的询问，或一个正在等笔记自己那趟旅程的遮罩。
	// 空闲的面板什么都不跑 —— 一个**已经结束**的悬停也不跑，无论它要来的那个弹出层之后
	// 立着多久。循环若还开着，它会找的也是来自 app 的一个**新**答案，而没有活的询问
	// 就不可能有：app 是依据指针打开它的预览的，而指针已经离开了列表。
	//
	// 所以那个被跟踪的弹出层不是维持它活着的东西。停下要恢复起来不费什么：下一次询问会
	// 重新启动循环，而它第一眼就会注意到那个旧弹出层已经关掉了。
	private async loop(): Promise<void> {
		while (this.running && (this.session || this.coveredEl)) {
			this.tick();
			await nextPaint();
		}
		this.running = false;
	}

	private tick(): void {
		const pop = this.parent?.hoverPopover ?? undefined;
		const el = pop?.hoverEl;
		if (!pop || !el || !el.isConnected) {
			// 关了 —— 或者从来就不在。这里揭开只是记账（那个元素是 app 拿走的东西），
			// 但恢复不费什么，而且万一 app 复用了这个节点，也不留任何侥幸。
			this.popover = undefined;
			this.coveredEl = undefined;
			this.reveal();
			return;
		}
		if (pop !== this.popover) {
			// **app 已经作答了**。先说这句，因为无论有没有东西要盖它都成立。
			this.reveal();
			this.popover = pop;
			this.coveredEl = undefined;
			this.onOpen?.(el);
			if (this.wantCover)
				this.beginCover(el);
			return;
		}
		if (this.coveredEl && this.coveredEl !== el) {
			// 同一个弹出层换上了新内容：这趟旅程重新开始。
			this.reveal();
			this.beginCover(el);
		}
		if (!this.coveredEl)
			return;
		// 每次查看都重新施加、而不是只做一次：内容节点比它所属的那张卡片到得晚，
		// 而一个在它存在之前就被藏过的节点根本没被藏住。
		this.hideNew(this.coveredEl);
		// 那次延迟的滚动落地了。它自己的标记就是答案：高亮是在移动滚动容器的同一次调用里
		// 被放到那一行上的，所以它的到达与那个位置的到达是同一瞬间 —— 而在同一次查看里
		// 就被拿掉，所以那一闪永远不会被看见。这里有意不要第二个见证：一个盖着遮罩的弹出层
		// 仍然会接管滚轮（opacity 是隐藏，不是禁用），而读者自己的滚动不是被等待的那次滚动。
		if (this.coveredEl.querySelector(`.${FLASH}`)) {
			this.unflash(this.coveredEl);
			this.reveal();
			this.coveredEl = undefined;
			return;
		}
		if (Date.now() > this.deadline) {
			this.reveal();
			this.coveredEl = undefined;
		}
	}

	private beginCover(el: HTMLElement): void {
		// 一次只有一个遮罩，而且恰好一个：一次询问可能在另一张卡片还在我们的遮罩下时到达，
		// 而一份被丢掉、又没有恢复的隐藏列表，是一个永久留在不可见状态的节点。
		this.reveal();
		this.coveredEl = el;
		this.deadline = Date.now() + LAND_MAX_MS;
		this.hideNew(el);
	}

	// 弹出层正在显示的一切，在**不**隐藏弹出层本身的前提下藏起来：卡片在它出现的那一瞬
	// 就出现，且笔记自己的空间已经预留好，所以读者看到的是「一篇笔记被揭开」而不是
	// 「一张卡片迟到」。只有 opacity 动 —— 隐藏期间布局不许有任何变化，否则卡片就会
	// 按还不存在的内容来定尺寸。
	private hideNew(el: HTMLElement): void {
		for (const child of Array.from(el.children)) {
			if (child.instanceOf(HTMLElement) && !this.hidden.includes(child)) {
				child.setCssStyles({ opacity: '0' });
				this.hidden.push(child);
			}
		}
	}

	// 把搜索命中的高亮从那一行上拿掉：这个面板里没有任何东西要过搜索。
	private unflash(el: HTMLElement): void {
		for (const marked of Array.from(el.querySelectorAll(`.${FLASH}`)))
			marked.classList.remove(FLASH);
	}

	private reveal(): void {
		for (const child of this.hidden)
			child.setCssStyles({ opacity: '' });
		this.hidden = [];
	}
}
