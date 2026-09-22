// Runtime stand-in for the 'obsidian' module (a typings-only package with no
// runnable entry, which vite cannot resolve). Mapped to 'obsidian' via
// resolve.alias in vitest.config.mts, so every module under test — and the
// tests themselves — see these classes for their instanceof checks.
export class FileView {}
export class MarkdownView extends FileView {}
export class TFile {}

// The recent-files browser (recent-files/browser/modal) extends this. Real enough for DOM
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

// The recent-files browser draws the search box's × with Obsidian's icon helper (see
// RecentFilesBrowser.toolbar).
// jsdom has no icons, so it is stood in for: the icon builds the element a test can
// find and records WHICH icon it was asked for — the drawing is the app's, and a test
// asserts on the name, not on the paths.
export function setIcon(el: HTMLElement, icon: string): void {
	el.empty();
	el.addClass('svg-icon', `svg-icon-${icon}`);
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('data-icon', icon);
	el.appendChild(svg);
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

// The recent-files browser hangs its rendered preview on a Component and unloads it
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
						// Marked runs carry links like any other text (a landing line
						// with a wikilink in it is the ordinary case).
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

// The two link forms the content can carry, as the anchors Obsidian draws for them:
// `[[Target|alias]]` is an internal link (`data-href` is what the app's own click
// handler reads, the href is what it must never let navigate) and `[text](url)` an
// external one. The renderer here used to print both as plain text, which meant the
// browser's link handling — the crash a tablet reported — had nothing to be tested
// against.
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

// The app's own answers to the two questions a click raises: WHERE should this open
// (Keymap.isModEvent — 'tab' for Cmd/Ctrl or a middle-click, 'split' with Alt,
// 'window' with Alt+Shift, and `false` for a plain click) and WHETHER a modifier is
// down (Keymap.isModifier).
//
// The stand-in is DRIVEN BY THE TEST instead of reading real modifier state, and that
// is the honest way to test this: the plugin's job is to ASK the app and pass the
// answer along, so the answer is the input. Synthesising a Cmd+click in jsdom would
// only be testing jsdom. The middle-click rule is kept, because it is the one the
// plugin's own press handler relies on being the app's (`isModEvent` documents it) —
// a plugin that stopped asking would stop getting it.
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
	// Called between tests: an answer left set would silently decide the next case.
	static reset(): void {
		Keymap.modEvent = false;
		Keymap.modifier = false;
	}
}

// The app's own context menu (see RecentFilesBrowser.contextRow). What the plugin owes
// the app is a menu OBJECT with the right items in it — the floating DOM the real one
// builds is the app's business, and jsdom has no layout to position it in — so the
// stand-in records what was added and what each item would do when clicked.
export class MenuItem {
	section = '';
	title = '';
	icon = '';
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
	onClick(fn: () => void): this {
		this.click = fn;
		return this;
	}
}

export class Menu {
	items: MenuItem[] = [];
	shownAt: MouseEvent | undefined;
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
		this.shownAt = ev;
		return this;
	}
	setNoIcon(): this {
		return this;
	}
	hide(): void {}
	close(): void {}
}

// ---------------------------------------------------------------------------
// Obsidian's runtime mixes chainable DOM helpers into the element prototypes
// (createEl/createDiv/createSpan/empty/setText/addClass/removeClass/
// toggleClass/setAttr). jsdom has none of them, so any code that BUILDS DOM —
// the recent-files browser — needs this shim. Installed once, only when a helper
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
	// A run of text JOINED to what the element already holds — a text node appended
	// rather than set, so an icon drawn beside a sentence keeps its place (the
	// difference against proto.setText above).
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
	// The app's own way to style an element from script, which the browser uses where a
	// value has to be measured rather than declared (and where a stylesheet rule cannot
	// be trusted to win: see RecentFilesList.disclose). A test asserting what a reader would see
	// needs the element's own style to carry them.
	proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		Object.assign(this.style, styles);
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const key of Object.keys(props))
			this.style.setProperty(key.startsWith('--') ? key : `--${key}`, props[key]);
	};
}

installDomHelpers();
