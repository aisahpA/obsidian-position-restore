// Runtime stand-in for the 'obsidian' module (a typings-only package with no
// runnable entry, which vite cannot resolve). Mapped to 'obsidian' via
// resolve.alias in vitest.config.mts, so every module under test — and the
// tests themselves — see these classes for their instanceof checks.
export class FileView {}
export class MarkdownView extends FileView {}
export class TFile {}

// The history browser (nav-history/browser/modal) extends this. Real enough for DOM
// tests: it builds the three elements the subclass writes into, and open()/
// close() route to the subclass hooks.
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

// database.ts fires notices on failure paths (switchDbFile validation, an
// unreadable db file). Messages and durations are recorded so tests can assert
// what the user was told and whether it needed dismissing; tests that look at
// them reset the list per case.
export class Notice {
	static instances: Notice[] = [];
	readonly message: string;
	readonly duration: number | undefined;
	constructor(message: string, duration?: number) {
		this.message = message;
		this.duration = duration;
		Notice.instances.push(this);
	}
	static reset(): void {
		Notice.instances = [];
	}
}

export const Platform = { isDesktopApp: true, isMobileApp: false, isMobile: false };

// The history browser offers a row's travel in a right-click menu as well as on the
// row's own arrow (see NavHistoryList.rowMenu), and draws that arrow with Obsidian's
// icon helper. jsdom has neither menus nor icons, so the pair is stood in for: the
// icon records its NAME (the drawing is the app's), and a menu records the items put
// in it so a test can read what the reader would see and pick one the way a reader
// would. It is kept in `Menu.shown`, because the browser builds it and drops it in
// one statement and a test has nothing else to hold on to.
export function setIcon(el: HTMLElement, icon: string): void {
	el.addClass('svg-icon', `svg-icon-${icon}`);
	el.setAttribute('data-icon', icon);
}

export class MenuItem {
	title: string | DocumentFragment = '';
	icon: string | null = null;
	disabled = false;
	private action?: () => void;

	setTitle(title: string | DocumentFragment): this {
		this.title = title;
		return this;
	}
	setIcon(icon: string | null): this {
		this.icon = icon;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(action: () => void): this {
		this.action = action;
		return this;
	}
	/** The reader picked this item; a disabled item cannot be picked. */
	pick(): void {
		if (!this.disabled)
			this.action?.();
	}
}

export class Menu {
	/** Every menu shown since the last reset, newest last. */
	static shown: Menu[] = [];
	static reset(): void {
		Menu.shown = [];
	}
	static get last(): Menu | undefined {
		return Menu.shown[Menu.shown.length - 1];
	}
	readonly items: MenuItem[] = [];
	addItem(cb: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		this.items.push(item);
		cb(item);
		return this;
	}
	showAtMouseEvent(_ev: MouseEvent): this {
		Menu.shown.push(this);
		return this;
	}
}

// i18n.ts picks its locale at import time via getLanguage().
export function getLanguage(): string {
	return 'en';
}

// The sampler wraps its capture listener with debounce(fn, interval, reset);
// for synchronous single-event tests an identity passthrough is equivalent.
export function debounce(fn: unknown): unknown {
	return fn;
}

// The history browser hangs its rendered preview on a Component and unloads it
// when the dialog closes (see PreviewContent). Enough of the real lifecycle for
// a test to see which of the two happened.
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

// The resident history panel is an ItemView (see browser/view.ts): the plugin
// registers it with the workspace, a leaf builds it, and the workspace opens and
// closes it. Enough of that shape for a test to mount one by hand — the view
// builds its DOM in contentEl, which is the one element of the real class the
// panel touches — and to see whether it was opened or closed.
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

// The drawer draws its content with Obsidian's OWN renderer, which lives in the
// app and not in this typings package. The stand-in is deliberately minimal:
// one block element per blank-line-separated block, `==…==` as <mark>, headings
// by level, single newlines as <br> (Obsidian renders them as breaks). Tests
// assert on the recorded SOURCE and on the mark a reader would see, never on
// Obsidian's own typography — that is the app's, not this plugin's.
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
				// `==words==` split with a capture: the odd slots are the marked
				// runs, the even ones the text around them.
				line.split(/==([^=]+)==/).forEach((part, slot) => {
					if (part === '')
						return;
					if (slot % 2 === 1) {
						const mark = document.createElement('mark');
						mark.textContent = part;
						node.appendChild(mark);
					} else {
						node.appendChild(document.createTextNode(part));
					}
				});
			});
			el.appendChild(node);
		}
	}
}

// ---------------------------------------------------------------------------
// Obsidian's runtime mixes chainable DOM helpers into the element prototypes
// (createEl/createDiv/createSpan/empty/setText/addClass/removeClass/
// toggleClass/setAttr). jsdom has none of them, so any code that BUILDS DOM —
// the history browser — needs this shim. Installed once, only when a helper
// is actually missing.
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
}

installDomHelpers();
