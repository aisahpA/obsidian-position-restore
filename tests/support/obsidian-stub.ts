// 'obsidian' 模块（只有 typings、没有可运行入口的包，vite 解析不了）的运行时替身。靠
// vitest.config.mts 里的 resolve.alias 映射到 'obsidian'，于是被测的每个模块 —— 以及测试
// 自己 —— 的 instanceof 检查看到的都是这些类。
export class FileView {}
export class MarkdownView extends FileView {}
export class TFile {}

// 最近文件浏览器（recent-files/browser/modal）继承它。够 DOM 测试用的真实度：它建出子类
// 往里写的三个元素，而 open() / close() 转发到子类的钩子上。
export class Modal {
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	constructor(public app: unknown) {
		this.containerEl = document.createElement('div');
		this.modalEl = this.containerEl.createDiv();
		this.titleEl = this.modalEl.createDiv();
		this.contentEl = this.modalEl.createDiv();
		document.body.appendChild(this.containerEl);
	}
	open(): void {
		this.onOpen();
	}
	close(): void {
		this.onClose();
		this.containerEl.remove();
	}
	onOpen(): void {}
	onClose(): void {}
}

// database.ts 在失败路径上弹提示（switchDbFile 的校验、读不了的库文件）。消息与时长都
// 记了下来，好让测试断言告诉过用户什么、以及那句话要不要用户手动关掉；看它们的测试逐个
// 用例重置这个列表。
export class Notice {
	static instances: Notice[] = [];
	readonly message: string;
	readonly duration: number | undefined;
	// 挂按钮的地方（最近文件浏览器的「撤销」）：建进 body，测试才能像读者那样点到它。
	// 真货 1.8.7 起叫 messageEl（旧名 noticeEl 已弃用），桩只给新名。
	readonly messageEl: HTMLElement;
	hidden = false;
	constructor(message: string, duration?: number) {
		this.message = message;
		this.duration = duration;
		this.messageEl = document.createElement('div');
		this.messageEl.textContent = message;
		document.body.appendChild(this.messageEl);
		Notice.instances.push(this);
	}
	hide(): void {
		this.hidden = true;
		this.messageEl.remove();
	}
	static reset(): void {
		Notice.instances = [];
	}
}

// isPhone：手机端与桌面/平板在「**读者看得见**遮罩」的时刻上分道（见 ui/cover.ts 的 markVisible）
// —— 遮罩两端都在 open 一开始就涂上，但手机端涂上那一刻全屏的文件列表还盖着正文，起点要等新
// 内容进视图。测试按需翻转 isPhone —— 与 recent-files-modal-harness 翻转 isMobile 是同一手法。
export const Platform = {
	isDesktopApp: true,
	isMobileApp: false,
	isMobile: false,
	isPhone: false,
	isTablet: false,
};

// 最近文件浏览器用 Obsidian 的图标助手画搜索框那个 ×（见 RecentFilesBrowser.toolbar）。
// jsdom 没有图标，所以这里替一个：这个图标建出测试找得到的元素，并记下**要的是哪个**图标
// —— 画出来什么样子是 app 的事，测试断言的是名字，不是那些路径。
export function setIcon(el: HTMLElement, icon: string): void {
	el.empty();
	el.addClass('svg-icon', `svg-icon-${icon}`);
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('data-icon', icon);
	el.appendChild(svg);
}

// i18n.ts 在 import 时经 getLanguage() 选定它的语言。
export function getLanguage(): string {
	return 'en';
}

// 采样器用 debounce(fn, interval, reset) 包它的采集监听器；对同步的单事件测试来说，
// 原样透传是等价的。
export function debounce(fn: unknown): unknown {
	return fn;
}

// 最近文件浏览器把渲染出来的预览挂在一个 Component 上，对话框关闭时卸载它（见
// PreviewContent）。真实生命周期的这一部分就够测试看出这两件事发生了哪一件。
export class Component {
	loaded = false;
	load(): void {
		this.loaded = true;
		this.onload();
	}
	unload(): void {
		this.loaded = false;
		this.onunload();
	}
	onload(): void {}
	onunload(): void {}
}

// 常驻的历史面板是一个 ItemView（见 browser/view.ts）：插件把它注册给工作区，某个 leaf
// 把它建起来，工作区再把它打开与关上。这点形状就够测试手工挂一个 —— 视图把它的 DOM 建在
// contentEl 里，那是真类里这个面板唯一碰的元素 —— 也够看出它被打开还是被关上了。
export class WorkspaceLeaf {
	view: unknown = null;
	async setViewState(state: unknown): Promise<void> {
		this.state = state;
	}
	state: unknown = null;
	async loadIfDeferred(): Promise<void> {}
}

export class View extends Component {
	leaf: WorkspaceLeaf;
	app: unknown;
	containerEl: HTMLElement;
	constructor(leaf: WorkspaceLeaf) {
		super();
		this.leaf = leaf;
		this.app = (leaf as unknown as { app?: unknown }).app;
		this.containerEl = document.createElement('div');
		this.containerEl.className = 'workspace-leaf-content';
	}
	getViewType(): string {
		return '';
	}
	onResize(): void {}
}

export class ItemView extends View {
	contentEl: HTMLElement;
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
	}
}

// 抽屉用 Obsidian **自己的**渲染器画内容，那个渲染器住在 app 里，不在这份 typings 包里。
// 这个替身刻意最小：空行分隔的每一块一个块级元素、`==…==` 作 <mark>、标题按级别、单个换行
// 作 <br>（Obsidian 就把它们渲染成换行）。测试断言的是记下来的**原文**和读者会看到的标记，
// 从不断言 Obsidian 自己的排版 —— 那是 app 的事，不是这个插件的。
// 这个插件遇见的 app 预览渲染器：文件列表预览够得到的那一个方法（见
// position/hover/explorer-preview.ts）。typings 里没有它，所以测试在打补丁之前先往原型上
// 装自己的记录器 —— 空方法体要让补丁卡在它自己的守卫上。
export class MarkdownPreviewRenderer {
	applyScrollDelayed(_line: number, _opts?: { highlight?: boolean; center?: boolean }): void {}
}

export class MarkdownRenderer {
	static async render(
		_app: unknown,
		markdown: string,
		el: HTMLElement,
		_sourcePath: string,
		_component: unknown,
	): Promise<void> {
		for (const block of markdown.split(/\n{2,}/)) {
			const lines = block.split('\n');
			const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
			if (heading)
				lines[0] = heading[2];
			const node = document.createElement(heading ? `h${heading[1].length}` : 'p');
			lines.forEach((line, i) => {
				if (i)
					node.appendChild(document.createElement('br'));
				// `==words==` 用捕获组切分：奇数槽是标出来的那几段，偶数槽是它们周围的文字。
				line.split(/==([^=]+)==/).forEach((part, slot) => {
					if (part === '')
						return;
					if (slot % 2 === 1) {
						const mark = document.createElement('mark');
						// 标出来的那几段跟别的文字一样带链接（落点行里带个 wikilink 是寻常情形）。
						links(mark, part);
						node.appendChild(mark);
					} else {
						links(node, part);
					}
				});
			});
			el.appendChild(node);
		}
	}
}

// 内容可能带的两种链接形式，作 Obsidian 为它们画的锚点：`[[Target|alias]]` 是内部链接
// （`data-href` 是 app 自己那个点击处理器读的，href 则是它绝不能让它跳转的），
// `[text](url)` 是外部链接。这里的渲染器从前把两者都打成纯文本，于是浏览器的链接处理 ——
// 平板报的那个崩溃 —— 没有任何东西可测。
function links(node: Node, text: string): void {
	const pattern = /\[\[([^\][|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let at = 0;
	for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
		if (m.index > at)
			node.appendChild(document.createTextNode(text.slice(at, m.index)));
		const a = document.createElement('a');
		if (m[1] !== undefined) {
			const target = m[1].trim();
			a.setAttribute('data-href', target);
			a.setAttribute('href', target);
			a.setAttribute('class', 'internal-link');
			a.textContent = (m[2] ?? target).trim();
		} else {
			a.setAttribute('href', m[4]);
			a.setAttribute('class', 'external-link');
			a.textContent = m[3];
		}
		node.appendChild(a);
		at = m.index + m[0].length;
	}
	if (at < text.length)
		node.appendChild(document.createTextNode(text.slice(at)));
}

// app 自己对一次点击提出的两个问题的回答：该在**哪儿**打开（Keymap.isModEvent ——
// Cmd/Ctrl 或中键给 'tab'、Alt 给 'split'、Alt+Shift 给 'window'、纯点击给 `false`），以及
// 按着修饰键没有（Keymap.isModifier）。
//
// 这个替身**由测试驱动**，不去读真实的修饰键状态，而这是测这件事的诚实做法：插件的活是
// **问** app 再把回答带过去，所以回答本身就是输入。在 jsdom 里合成一次 Cmd+点击，测的只会
// 是 jsdom。中键那条规则留着，因为插件自己的按压处理器正依赖它是 app 的（`isModEvent` 里
// 写着）—— 一个不再问的插件也就再也拿不到它。
export class Keymap {
	static modEvent: unknown = false;
	static modifier = false;
	static isModEvent(evt?: { button?: number }): unknown {
		if (evt?.button === 1)
			return 'tab';
		return Keymap.modEvent;
	}
	static isModifier(_evt: unknown, _modifier: string): boolean {
		return Keymap.modifier;
	}
	// 在测试之间调用：一个留下来的回答会悄悄替下一个用例做决定。
	static reset(): void {
		Keymap.modEvent = false;
		Keymap.modifier = false;
	}
}

// app 自己的右键菜单（见 RecentFilesBrowser.contextRow）。插件欠 app 的是一个装着对味项的
// 菜单**对象** —— 真货建出来的那个浮动 DOM 是 app 的事，何况 jsdom 没有布局可让它定位 ——
// 所以这个替身记下加了什么、以及每一项被点时该做什么。
export class MenuItem {
	section = '';
	title = '';
	icon = '';
	// app 把警示项画成红色：取消置顶会把一行交给规则的那一项用它（见 body.ts 的
	// pinItems）。
	warning = false;
	click: (() => void) | undefined;
	setSection(section: string): this {
		this.section = section;
		return this;
	}
	setTitle(title: string): this {
		this.title = title;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setWarning(warning: boolean): this {
		this.warning = warning;
		return this;
	}
	onClick(fn: () => void): this {
		this.click = fn;
		return this;
	}
}

export class Menu {
	items: MenuItem[] = [];
	// 每一个被要求打开的菜单，按顺序。身后没有**文件**的菜单 —— 无路径视图那个 —— 是不带
	// app 的 `file-menu` 事件就升起来的，于是想读它上面有什么的测试没有事件可读。
	static shown: Menu[] = [];
	// 它被要求在哪儿打开，不管面板是从两道门里的哪一道进来的（见
	// RecentFilesBrowser.contextRow）：右键按它事件的坐标定位、手机的菜单控件按它自己的盒子
	// 定位，而测试想知道的是这个菜单**被摆出来过**，不只是被建出来过。
	shownAt: { x: number; y: number } | undefined;
	addItem(build: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		build(item);
		this.items.push(item);
		return this;
	}
	addSeparator(): this {
		return this;
	}
	showAtMouseEvent(ev: MouseEvent): this {
		this.shownAt = { x: ev.clientX, y: ev.clientY };
		Menu.shown.push(this);
		return this;
	}
	showAtPosition(position: { x: number; y: number }): this {
		this.shownAt = position;
		Menu.shown.push(this);
		return this;
	}
	setNoIcon(): this {
		return this;
	}
	// 它到底从屏幕上下来了没有，以及把它弄下来的是不是**这个面板**
	// （见 RecentFilesBrowser.closeMenu）。两者分得这么清，是因为只有一件是插件的承诺：
	// app 会为它自己的手势把菜单从屏幕上拿走 —— 选中一项、点开别处、Escape —— 而这些都
	// 不是抽屉合上。
	hidden = false;
	closed = false;
	// app 自己把它从屏幕上拿走时该通知谁：app 关掉的菜单，不再是面板还持有的那一个
	// （见 RecentFilesBrowser）。
	private hideCbs: (() => void)[] = [];
	onHide(cb: () => void): void {
		this.hideCbs.push(cb);
	}
	hide(): void {
		this.hidden = true;
		for (const cb of [...this.hideCbs])
			cb();
	}
	close(): void {
		this.closed = true;
		this.hide();
	}
}

// ---------------------------------------------------------------------------
// Obsidian 的运行时把一串可链式的 DOM 助手混进元素原型
// （createEl/createDiv/createSpan/empty/setText/addClass/removeClass/
// toggleClass/setAttr）。jsdom 一个都没有，所以任何**建 DOM** 的代码 ——
// 最近文件浏览器 —— 都需要这个垫片。只装一次，且只在某个助手真的缺的时候。
// ---------------------------------------------------------------------------
interface ElInfo {
	cls?: string | string[];
	text?: string | DocumentFragment;
	title?: string;
	type?: string;
	value?: string;
	placeholder?: string;
	attr?: Record<string, string | number | boolean | null>;
}

function applyElInfo(el: HTMLElement, info?: ElInfo): void {
	if (!info)
		return;
	if (info.cls)
		el.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
	if (info.text !== undefined) {
		if (typeof info.text === 'string')
			el.textContent = info.text;
		else
			el.appendChild(info.text);
	}
	if (info.title !== undefined)
		el.title = info.title;
	if (info.type !== undefined)
		el.setAttribute('type', info.type);
	if (info.value !== undefined)
		el.setAttribute('value', info.value);
	if (info.placeholder !== undefined)
		el.setAttribute('placeholder', info.placeholder);
	if (info.attr) {
		for (const key of Object.keys(info.attr)) {
			const value = info.attr[key];
			if (value !== null && value !== false)
				el.setAttribute(key, String(value));
		}
	}
}

function installDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (proto.createEl)
		return;
	const createIn = function (this: HTMLElement, tag: string, info?: ElInfo) {
		const el = document.createElement(tag);
		applyElInfo(el, info);
		this.appendChild(el);
		return el;
	};
	proto.createEl = function (this: HTMLElement, tag: string, info?: ElInfo) {
		return createIn.call(this, tag, info);
	};
	proto.createDiv = function (this: HTMLElement, info?: ElInfo) {
		return createIn.call(this, 'div', info);
	};
	proto.createSpan = function (this: HTMLElement, info?: ElInfo) {
		return createIn.call(this, 'span', info);
	};
	proto.empty = function (this: HTMLElement) {
		this.textContent = '';
	};
	proto.setText = function (this: HTMLElement, text: string) {
		this.textContent = text;
	};
	// 一段**接在**元素已有内容后面的文字 —— 追加一个文本节点而不是设置它，这样画在一句话
	// 旁边的图标还能待在自己的位置上（与上面 proto.setText 的区别）。
	proto.appendText = function (this: HTMLElement, text: string) {
		this.appendChild(document.createTextNode(text));
	};
	proto.addClass = function (this: HTMLElement, ...classes: string[]) {
		this.classList.add(...classes);
	};
	proto.removeClass = function (this: HTMLElement, ...classes: string[]) {
		this.classList.remove(...classes);
	};
	proto.toggleClass = function (this: HTMLElement, classes: string | string[], value: boolean) {
		for (const cls of Array.isArray(classes) ? classes : [classes])
			this.classList.toggle(cls, value);
	};
	proto.setAttr = function (this: HTMLElement, name: string, value: string | number | boolean | null) {
		if (value === null || value === false)
			this.removeAttribute(name);
		else
			this.setAttribute(name, String(value));
	};
	// app 自己那套从脚本给元素上样式的方式，浏览器在值必须**量出来**而不是声明出来时用它
	// （以及样式表规则未必赢得了的时候：见 RecentFilesList.disclose）。要断言读者会看到什么
	// 的测试，需要元素自己那份 style 来承载它们。
	proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		Object.assign(this.style, styles);
	};
	// Obsidian 自己那套 `instanceof` 的替代，在 app 真有的好几个窗口（弹出窗、iframe）之间
	// 都安全。源码用的是它而不是那个运算符（见 hover-settle.ts），所以测试走到哪片它看不见的
	// DOM，它就得在哪儿存在。
	(Element.prototype as unknown as Record<string, unknown>).instanceOf = function (
		this: Element,
		ctor: new (...args: never[]) => unknown,
	) {
		return this instanceof ctor;
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const key of Object.keys(props))
			this.style.setProperty(key.startsWith('--') ? key : `--${key}`, props[key]);
	};
}

installDomHelpers();

// 自我描述的一行会建进一个 DocumentFragment（见 settings/page），而片段是 Node 却不是
// HTMLElement —— 所以那些助手也得拷到它身上。是拷而不是声明两遍：createDiv 干的是什么事，
// 只有一个定义，不管在哪个节点上调用它。
const fragmentHelpers = [
	'createEl', 'createDiv', 'createSpan', 'empty', 'setText', 'appendText',
	'addClass', 'removeClass', 'toggleClass', 'setAttr', 'setCssStyles', 'setCssProps',
];
const fragmentProto = DocumentFragment.prototype as unknown as Record<string, unknown>;
const elementProto = HTMLElement.prototype as unknown as Record<string, unknown>;
for (const name of fragmentHelpers)
	fragmentProto[name] = elementProto[name];

// createFragment 是 Obsidian 的全局之一 —— 只声明、从不 import —— 所以它该待在全局对象
// 上，而不是这个模块的导出里。
(globalThis as unknown as { createFragment: () => DocumentFragment }).createFragment =
	function createFragment(): DocumentFragment {
		installDomHelpers();
		return document.createDocumentFragment();
	};
