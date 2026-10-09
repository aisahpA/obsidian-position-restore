// 一根停下来的手指 —— 手机有的、而桌面用悬停替代的那唯一一个手势。它不点名任何行、
// 也不画任何东西：一次按压落在哪个元素上，是关于行的问题，不是关于手势的问题
// （见 RecentFilesList.arm）。
//
// 为什么不用 `contextmenu`：WebView 确实会为一次长触摸触发它，但不是读者可能拿着的
// 每一个平台都会，而一个面板把「移除」挂在它上面的手势，不能是一个只偶尔才到达的手势。
// 所以时钟是**唯一**的裁判，而一次提前的 `contextmenu` 只是同一次按压从另一扇门进来
// （见 RecentFilesList.onContextMenu）—— 武装是幂等的，这让两扇门都留着。
//
// 为什么不用滑动：手机上列表站在抽屉里，而列表自己的 `touch-action` 是**有意**把水平轴
// 留给外壳的。一次不移动的按压，不认领任何别人正在用的东西。
export interface LongPressOptions {
	ms: number;
	slop: number;
	// 手指自己的目标，整个交过来、而不是解析好。
	onArm: (target: Node) => void;
}

export class LongPress {
	private timer?: number;
	private at?: { x: number; y: number };
	// 这次按压是否武装了某一行，因而手指抬起时它可能仍会发出的那次 click 是不是
	// 这次按压自己的（见 consumeClick）。
	private claimed = false;
	// 列表所在的那个窗口，而不是最顶层的那个：面板可能在弹出窗口里。
	private win: Window;

	constructor(private el: HTMLElement, private opts: LongPressOptions) {
		this.win = el.ownerDocument.defaultView ?? window;
		// 这四个都在**列表**上听，而不是在行上：每一行每次渲染都会被重建，
		// 而要听的是某一根手指的旅程。
		this.el.addEventListener('pointerdown', this.onDown);
		this.el.addEventListener('pointermove', this.onMove);
		this.el.addEventListener('pointerup', this.onEnd);
		this.el.addEventListener('pointercancel', this.onEnd);
	}

	destroy(): void {
		this.cancel();
		this.el.removeEventListener('pointerdown', this.onDown);
		this.el.removeEventListener('pointermove', this.onMove);
		this.el.removeEventListener('pointerup', this.onEnd);
		this.el.removeEventListener('pointercancel', this.onEnd);
	}

	// 这次按压武装了某一行 —— 来自时钟，或来自同一根手指触发的 `contextmenu`。
	markArmed(): void {
		this.claimed = true;
	}

	// 只回答**一次**：一次武装了某行的长按，在手指抬起时也会发出一次 click，
	// 而一个在行上停住的读者并没有要求去那里。
	consumeClick(): boolean {
		const claimed = this.claimed;
		this.claimed = false;
		return claimed;
	}

	// 为什么这件事必须从外面来说：行自己的控件会挡住自己的按压、不让它到达本模块
	// （见 RecentFilesList.fileRow），所以一根落在「上一次按压放上去的那个控件」上的手指
	// 在这里永远听不到 —— 而一个活得比自己那次按压还久的认领会**吞掉**那次点按：
	// 读者瞄准 ×，什么都没发生，而下一次点按反而打开了笔记。
	//
	// 尾部那次 click 到底来不来是平台的事：为这次按压弹过菜单的 WebView 可能一个 click
	// 都不带。一个认领不能一直挂着，直到有什么事情发生把它花掉。
	release(): void {
		this.cancel();
		this.claimed = false;
	}

	private onDown = (ev: PointerEvent): void => {
		this.cancel();
		this.claimed = false;
		// 中键按压会打开、右键按压会弹菜单；只有手指是「停住」。
		if (ev.button !== 0)
			return;
		this.at = { x: ev.clientX, y: ev.clientY };
		// 现在就读，而不是等时钟走完：手指底下的行就是它按下的那一行，
		// 中间若有一次渲染就会把它换成替代品。
		const target = ev.target instanceof Node ? ev.target : this.el;
		this.timer = this.win.setTimeout(() => {
			this.timer = undefined;
			this.at = undefined;
			this.opts.onArm(target);
		}, this.opts.ms);
	};

	// 移动得够多，这次按压就是一次滚动或拖动，不是停住 —— 直接作废而不是重新开始：
	// 一根离开了它那行的手指不会再回来。
	private onMove = (ev: PointerEvent): void => {
		if (!this.at)
			return;
		if (Math.abs(ev.clientX - this.at.x) > this.opts.slop
			|| Math.abs(ev.clientY - this.at.y) > this.opts.slop)
			this.cancel();
	};

	// 手指抬起了，或手势被从我们手里拿走了（第二根手指、手机转向）。它是否武装了
	// 某一行，已经被记下了（见 markArmed）。
	private onEnd = (): void => {
		this.cancel();
	};

	private cancel(): void {
		if (this.timer !== undefined)
			this.win.clearTimeout(this.timer);
		this.timer = undefined;
		this.at = undefined;
	}
}
