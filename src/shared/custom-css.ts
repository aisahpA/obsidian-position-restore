// THE READER'S OWN CSS, in one <style> element the plugin owns. An escape hatch for layout the app
// gets wrong on a device — Android's full-screen mode, where the top of a note sits under the
// system status bar, being the one that prompted it. What the reader typed is what the app gets,
// on top of their theme.
export const CUSTOM_CSS_STYLE_ID = 'position-restore-custom-css';

// Idempotent by construction: the element is FOUND, not counted, so applying twice is a replacement
// rather than a second stylesheet — the last write wins, which is what editing a settings row
// means. An emptied box takes the element away rather than leaving a blank one behind: a stylesheet
// with no rules still costs the app a node to match against.
export function applyCustomCss(css: string): void {
	const text = css.trim();
	const el = document.getElementById(CUSTOM_CSS_STYLE_ID);
	if (!text) {
		el?.remove();
		return;
	}
	if (el) {
		el.textContent = text;
		return;
	}
	const style = createEl('style', { attr: { id: CUSTOM_CSS_STYLE_ID }, text });
	document.head.appendChild(style);
}

export function removeCustomCss(): void {
	document.getElementById(CUSTOM_CSS_STYLE_ID)?.remove();
}
