import { App } from 'obsidian';

// ROOM ABOVE A NOTE, in one <style> element the plugin owns. Some phones draw a note up to the
// screen's physical edge, so its first line ends up under the system status bar — and no recorded
// position can fix that, because the note IS at its first line. What can be moved is the viewport,
// and that takes a margin on the container AROUND the scroller: padding the scroller lifts the
// file's first line and scrolls away with the content, while padding here shortens the viewport,
// so a landing in the middle of a file is clear of the obstruction too.
//
// The element is FOUND, not counted, so applying again is a replacement rather than a second
// stylesheet, and a margin of 0 takes the element away rather than leaving a blank one behind.
export const TOP_MARGIN_STYLE_ID = 'position-restore-top-margin';

// Per DEVICE and not per vault: data.json is synced, and a margin one phone needs is noise on
// every other machine the same reader sits at. The app's own LOCAL storage is the only place that
// follows the machine and nothing else.
const TOP_MARGIN_KEY = 'position-restore.topMargin';

// A tab's own content only: a note drawn inside an embed or a canvas card is not a note being
// read at the top of a screen.
const SELECTOR = '.workspace-leaf-content .view-content > .markdown-reading-view,'
	+ ' .workspace-leaf-content .view-content > .markdown-source-view > .cm-editor';

// The system bar's own height is added to whatever the reader asked for, so the number is only
// "how much more" — and where the app already gets the top right, the inset is 0 and the number
// is the whole margin.
function cssFor(px: number): string {
	return `${SELECTOR} {\n\tpadding-top: calc(var(--safe-area-inset-top, 0px) + ${px}px);\n}`;
}

export function applyTopMargin(px: number): void {
	const extra = Math.max(0, Math.round(px));
	const el = document.getElementById(TOP_MARGIN_STYLE_ID);
	if (extra === 0) {
		el?.remove();
		return;
	}
	if (el) {
		el.textContent = cssFor(extra);
		return;
	}
	document.head.appendChild(createEl('style', { attr: { id: TOP_MARGIN_STYLE_ID }, text: cssFor(extra) }));
}

export function removeTopMargin(): void {
	document.getElementById(TOP_MARGIN_STYLE_ID)?.remove();
}

// Whatever is stored may have been written by a hand or by an older build; a value that is not a
// usable number is no margin, which is also what "never set" means.
export function readTopMargin(app: App): number {
	const raw: unknown = app.loadLocalStorage(TOP_MARGIN_KEY);
	return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
}

export function writeTopMargin(app: App, px: number): void {
	const extra = Math.max(0, Math.round(px));
	app.saveLocalStorage(TOP_MARGIN_KEY, extra);
	applyTopMargin(extra);
}
