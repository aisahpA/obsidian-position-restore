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

// i18n.ts picks its locale at import time via getLanguage().
export function getLanguage(): string {
	return 'en';
}

// The sampler wraps its capture listener with debounce(fn, interval, reset);
// for synchronous single-event tests an identity passthrough is equivalent.
export function debounce(fn: unknown): unknown {
	return fn;
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
