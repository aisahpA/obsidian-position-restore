import { TIP_DELAY_MS, TIP_GAP_PX } from './constants';

// 一行在悬停时说什么，以及说它的那个元素。
//
// 不用原生的 `title`：原生提示框只吃纯文本、没有样式表碰得到它，所以路径出来得很小、
// 它的 `/` 分隔符几乎看不见。自己画还让一行只说它还没显示的东西（见
// RecentFilesList.fileRow）：`title` 是个静态字符串，而这个是针对它所覆盖的那一行
// 现问的，所以一行已经显示了它的文件夹，就可以把路径省掉。
//
// 也不用 app 自己的提示框（见 `setTooltip`）：那个是写成 `aria-label` 的，而对于一个
// 身为 listbox 某个**选项**的行来说，这会**替换**掉它本就携带的无障碍名称。
// 这个元素是 `aria-hidden` 的装饰；各行保留它们对外宣布的名字。
export interface TipContent {
	// 文件的完整路径，含扩展名 —— 一行在没有读者许可时唯一不能显示的东西
	// （见 PathDisplayMode）。
	path?: string;
	// 笔记**自称**什么，占单独一行：笔记自己对「它叫什么」的回答，
	// 这不是它「只是应答」的那些名字之一（见 reads.ts 的 otherNamesFor）。
	frontTitle?: string;
	// 那下面的一行普通文字：笔记**应答**的那些名字，或者某个格子改为持有的那一条事实
	// （一个「多久之前」标签所代表的确切时刻）。
	text?: string;
	// **从笔记里引出来**的行：记录落点时它周围的那几个词，以及查询进行中时查询命中的
	// 那一行（见 landingQuotes）。它们是一次搜索能匹配、却在屏幕上**任何地方**都不出现的
	// 唯一文字 —— 一行显示的是坐标和分节 —— 而这正是落点的行以前从来答不出来的：
	// 这一行为什么会在这份列表上。
	quotes?: string[];
	// 引文下面**一行**，是关于笔记的、而不是从笔记里来的：这些词被拍下之后文件有没有
	// 被写过（见 landingNote）。引文是一张照片，而这一行上再没有别的东西说明那是谁的照片。
	note?: string;
}

// 每份列表**一个**提示框，只在指针停在一个有话可说的东西上时才在屏上。它住在
// **文档的 body** 上、而不是列表里面，因为列表会滚动、会裁剪：一个在它里面的提示框
// 会在它所属的那一行处被切掉 —— 而两端附近的行恰恰是读者最需要它的。
export class NavRowTip {
	// 每个元素说什么：行本身，或它其中的一个格子（时间标签 —— 「那一刻」而不是
	// 「哪个文件」）。按**元素**为键，因为这个问题是由指针事件问出来的，
	// 它点名的就是一个元素、别无其他。
	private tips = new WeakMap<HTMLElement, TipContent>();
	private el?: HTMLElement;
	private anchor?: HTMLElement;
	// 屏上的东西是被**长按**问出来的、而不是指针停出来的（见 speak）：一根抬起的手指
	// 发出的 `pointerout` 与鼠标离开那一行发出的是一样的，而一次长按挣来的提示必须活得
	// 比它久 —— 读者抬起手指是为了去够那一行的控件。只有一次显式的收回才结束它（见 retract）。
	private held = false;
	// 一个路过列表去别处的指针，不能在它经过的每一行下都闪一个提示框（见 TIP_DELAY_MS）。
	private timer?: number;
	private doc: Document;
	private win: Window;

	// `quiet` 回答「这个提示到底该不该说」，每次悬停都重新问一遍、延迟结束时再问一遍：
	// 让它沉默的东西 —— 笔记本身站在这些行上方开着（见 hoverRow）—— 是这个元素看不见的。
	// 是问、而不是记住，因为这个答案的生命期属于那个弹出层，所以一个已经关掉的预览
	// 会把声音还给各行，无论指针在哪。
	constructor(private list: HTMLElement, private quiet?: () => boolean) {
		// 列表自己的文档，不是最顶层的那个：面板可能站在弹出窗口里，而提示框必须在
		// 读者正看着的那个窗口里被建出来、摆好。`defaultView` 就是那个窗口 —— 摆放对着它
		// 测量、延迟用它的时钟 —— 最顶层的窗口是没有 defaultView 的文档的兜底。
		this.doc = list.ownerDocument;
		this.win = this.doc.defaultView ?? window;
		// 在**列表**上而不是在行上：每一行每次渲染都会被重建。
		this.list.addEventListener('pointerover', this.onOver);
		this.list.addEventListener('pointerout', this.onOut);
		// 一次按压要么即将行进、要么即将重建列表，而一个钉在它所点名的行上的提示框
		// 会被留在原地、指着一个已经不在了的行。
		this.list.addEventListener('pointerdown', this.onLeave);
		// ……而一次滚动会把每一行都从一个站着不动的提示框底下挪走。
		this.list.addEventListener('scroll', this.onLeave, { passive: true });
	}

	attach(el: HTMLElement, content: TipContent): void {
		this.tips.set(el, content);
	}

	// 收纳那一趟把它从一行上拿掉的分节层级的词交给那行，又在这行有地方重新显示
	// 那个层级时把它们**收回去**（见 fitTrails）—— 一个被留下的提示框会重复它所覆盖的那一行。
	detach(el: HTMLElement): void {
		this.tips.delete(el);
	}

	// 收回已说出的和即将说出的：app 已经把**笔记本身**放到这些行上方了（见 hoverRow），
	// 而一盒子小字能给这个页面增添的东西等于零。它**不**做的事是记住任何东西 —— 见 `quiet`。
	retract(): void {
		this.forget();
	}

	// 一根**停在一行上**的手指，在没有悬停的设备上这就是悬停（见 long-press.ts）。
	// 它说什么词是元素的事，决定方式与指针一样（见 `subject`）：一根在**时间**上的手指
	// 问的是「5m」背后的那一刻；行上任何其它地方问的是这是哪个文件。
	//
	// **没有**延迟，因为那次等待已经发生过了：手指在整个长按期间一直按着，
	// 比 TIP_DELAY_MS 对一只鼠标要求的还久。
	//
	// 所说的话是被**保持住的**（见 `held`），而不是交给指针的来来去去：一次长按被回答一次、
	// 被收回一次，而收回属于那件结束了这次按压的事。
	speak(target: Node | null): void {
		// 在触摸设备上不可达 —— 这个面板在那里从不要求预览（见 hoverAt）—— 但出于
		// 同样的理由还是问一遍：这个提示能不能说话，永远不是这个元素说了算、也不是它该记的。
		if (this.quiet?.())
			return;
		const subject = this.subject(target);
		if (!subject)
			return;
		const content = this.tips.get(subject);
		if (!content)
			return;
		this.forget();
		this.anchor = subject;
		this.held = true;
		this.show(subject, content);
	}

	// 列表正在被**重建**（见 render）：登记过的提示所属的那些行没了。
	// 登记表不需要清理 —— 它是弱键的。
	reset(): void {
		this.forget();
	}

	destroy(): void {
		this.forget();
		this.list.removeEventListener('pointerover', this.onOver);
		this.list.removeEventListener('pointerout', this.onOut);
		this.list.removeEventListener('pointerdown', this.onLeave);
		this.list.removeEventListener('scroll', this.onLeave);
	}

	// 只有**主体**变了才算数：这个事件会在它已经所在的那一行的每个子元素上再触发一次，
	// 而应答这些会在一只不动的手上重新开始计延迟。
	private onOver = (ev: PointerEvent): void => {
		// 手指不悬停 —— 它按压，而按压会遗忘。应答一次触摸的 over 会在一根早已行进过去的
		// 手指之后 400ms 竖起一个提示框，覆盖在一行上，而这期间列表可能已经重画过了。
		if (ev.pointerType === 'touch') {
			this.forget();
			return;
		}
		if (this.quiet?.()) {
			this.forget();
			return;
		}
		const target = this.subject(ev.target as Node | null);
		if (target === this.anchor)
			return;
		this.forget();
		if (!target)
			return;
		const content = this.tips.get(target);
		if (!content)
			return;
		this.anchor = target;
		this.timer = this.win.setTimeout(() => {
			this.timer = undefined;
			// 延迟结束时**再**问一遍：一个在指针不动期间打开的预览，已经在这期间替这次悬停作答了。
			if (this.anchor === target && !this.quiet?.())
				this.show(target, content);
		}, TIP_DELAY_MS);
	};

	// 一次**留在主体内部**的移动不是离开：行自己的子元素在彼此之间穿过时会触发它。
	//
	// 一根**抬起**的手指同样不是离开：一个触摸指针在抬起时就不存在了，所以浏览器
	// 报出的 `out` 与鼠标离开那一行时一样 —— 而屏上的提示是一次长按挣来的（见 speak）。
	// 一个被保持的提示在按压的答案结束时结束，而不是在手指结束时。
	private onOut = (ev: PointerEvent): void => {
		if (this.held)
			return;
		const to = ev.relatedTarget as Node | null;
		if (this.anchor && to && this.anchor.contains(to))
			return;
		this.forget();
	};

	private onLeave = (): void => {
		this.forget();
	};

	// 最近的有话可说的元素：时间标签自报，行则替它里面的其它一切答复（见 fileRow）。
	// 一路向上走到列表为止，把那个**绝不该**应答的元素 —— listbox，它的 aria-label 不是
	// 提示框 —— 挡在外面。
	private subject(node: Node | null): HTMLElement | undefined {
		let el: HTMLElement | null = node && node.nodeType === 1
			? node as HTMLElement
			: node?.parentElement ?? null;
		while (el && el !== this.list) {
			if (this.tips.has(el))
				return el;
			el = el.parentElement;
		}
		return undefined;
	}

	// 提示框和当时被悬停的东西永远一起动：一个只要其中一个的调用方会把另一个留在原地站岗。
	private forget(): void {
		this.clearTimer();
		this.hide();
		this.anchor = undefined;
		this.held = false;
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			this.win.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private hide(): void {
		this.el?.remove();
		this.el = undefined;
	}

	private show(target: HTMLElement, content: TipContent): void {
		const el = this.doc.body.createDiv({
			cls: 'position-restore-nav-tip',
			// 装饰，别无其他：这里面的每一个词都在某个屏幕阅读器已经够得到的地方说过
			// （行自己的文字）。
			attr: { 'aria-hidden': 'true' },
		});
		if (content.path)
			this.pathLine(el, content.path);
		if (content.frontTitle)
			el.createDiv({ cls: 'nav-tip-text', text: content.frontTitle });
		if (content.text)
			el.createDiv({ cls: 'nav-tip-text', text: content.text });
		// 按调用方给出的顺序 —— 查询命中的那一处在前，落点所在的那一行在后。各自一个元素，
		// 好让一块笔记自己的文字读起来是一块文字，而不是这个面板写的一句话。
		for (const quote of content.quotes ?? [])
			if (quote)
				el.createDiv({ cls: 'nav-tip-quote', text: quote });
		// ……而关于它们的那一行放**最后**：它讲的是它上面的引文，而它本身不是引文，
		// 是这个面板的话、不是笔记的。
		if (content.note)
			el.createDiv({ cls: 'nav-tip-note', text: content.note });
		this.el = el;
		this.place(el, target);
	}

	// 每一段一个 span、每一对之间一个分隔符：一串文字正中间的一个 `/` 是路径里最难看清的
	// 字符，样式表给了它自己的字重（见 .nav-tip-sep）。最后一段是文件自己的名字，
	// 也就是读者在找的那个。
	private pathLine(box: HTMLElement, path: string): void {
		const line = box.createDiv({ cls: 'nav-tip-path' });
		const segments = path.split('/');
		segments.forEach((segment, i) => {
			if (i > 0)
				line.createSpan({ cls: 'nav-tip-sep', text: '/' });
			if (segment)
				line.createSpan({
					cls: i === segments.length - 1 ? 'nav-tip-name' : 'nav-tip-seg',
					text: segment,
				});
		});
	}

	// 在它所讲的那一行下方，从行自己的 inline start 挂下来，好让路径与名字从同一条边开始读。
	// 窗口底部太近时它翻到上方，远端会跑出去时它向内滑。在它进入文档**之后**才测量，
	// 因为它的宽度就是那条路径最终的长度。
	private place(el: HTMLElement, target: HTMLElement): void {
		const row = target.getBoundingClientRect();
		const box = el.getBoundingClientRect();
		const view = { w: this.win.innerWidth, h: this.win.innerHeight };
		let top = row.bottom + TIP_GAP_PX;
		if (top + box.height > view.h)
			top = Math.max(TIP_GAP_PX, row.top - TIP_GAP_PX - box.height);
		let left = row.left;
		if (left + box.width > view.w)
			left = view.w - box.width - TIP_GAP_PX;
		el.setCssStyles({
			top: `${Math.round(top)}px`,
			left: `${Math.round(Math.max(TIP_GAP_PX, left))}px`,
		});
	}
}
