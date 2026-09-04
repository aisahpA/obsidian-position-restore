// Runtime stand-in for the 'obsidian' module (a typings-only package with no
// runnable entry, which vite cannot resolve). Mapped to 'obsidian' via
// resolve.alias in vitest.config.mts, so every module under test — and the
// tests themselves — see these classes for their instanceof checks.
export class FileView {}
export class MarkdownView extends FileView {}
export class TFile {}

// database.ts fires notices on failure paths (switchDbFile validation etc.).
export class Notice {}

export const Platform = { isDesktopApp: true, isMobileApp: false };

// The sampler wraps its capture listener with debounce(fn, interval, reset);
// for synchronous single-event tests an identity passthrough is equivalent.
export function debounce(fn: unknown): unknown {
	return fn;
}
