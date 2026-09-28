// Unit tests for the reader's own CSS: the <style> element the plugin owns
// (shared/custom-css.ts), and the one consequence a change to it owes — being
// applied again, through the same diff every other setting goes through
// (PositionManager.applyChangedSettings). What is pinned is that applying is a
// REPLACEMENT and not an accumulation: the row is edited in place, and a
// plugin that appended a stylesheet per edit would leave the app matching
// against every version the reader ever typed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';

import { PositionManager } from '@/position/manager';
import { CUSTOM_CSS_STYLE_ID, applyCustomCss, removeCustomCss } from '@/shared/custom-css';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

const styleEl = () => document.getElementById(CUSTOM_CSS_STYLE_ID);

// The manager is the composition root, so a settings change can only be
// observed end to end through it. Only the shape its constructor walks.
function makeHarness() {
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: () => null,
			adapter: { exists: async () => false },
		},
		metadataCache: { getFileCache: () => null },
		workspace: {
			layoutReady: true,
			rootSplit: { containerEl: { contains: () => false } },
			getActiveViewOfType: () => null,
			iterateAllLeaves: () => undefined,
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
		},
	};
	const database = {
		db: {} as Record<string, { scroll: number }>,
		setState: vi.fn(),
		renameFile: vi.fn(),
		deleteFile: vi.fn(),
	};
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(app as unknown as App, database as never, settings);
	return { manager, settings };
}

describe("the reader's own CSS", () => {
	beforeEach(() => {
		removeCustomCss();
	});

	it('goes on as one element the plugin owns', () => {
		applyCustomCss('.cm-editor { padding-top: 28px; }');

		expect(styleEl()?.textContent).toBe('.cm-editor { padding-top: 28px; }');
		expect(document.querySelectorAll('style#' + CUSTOM_CSS_STYLE_ID)).toHaveLength(1);
	});

	it('replaces what was there instead of adding a second stylesheet', () => {
		applyCustomCss('.a { color: red; }');
		applyCustomCss('.b { color: blue; }');

		expect(document.querySelectorAll('style#' + CUSTOM_CSS_STYLE_ID)).toHaveLength(1);
		expect(styleEl()?.textContent).toBe('.b { color: blue; }');
	});

	it('takes the element away when the box is emptied', () => {
		applyCustomCss('.a { color: red; }');
		applyCustomCss('   ');

		expect(styleEl()).toBeNull();
	});

	// The settings row writes one key and the manager diffs it: a stylesheet is
	// the app's own layout, so the consequence is being applied again — while
	// the reader is looking at the box they just typed in.
	it('is applied again when the setting changes', () => {
		const { manager, settings } = makeHarness();
		const before = { ...settings };
		settings.customCss = '.cm-editor { padding-top: 28px; }';

		manager.applyChangedSettings(before);

		expect(styleEl()?.textContent).toBe('.cm-editor { padding-top: 28px; }');
	});

	// …and not on every write: another key changing is no reason to hand the
	// app a stylesheet it already has.
	it('is left alone when another setting is the one that changed', () => {
		const { manager, settings } = makeHarness();
		applyCustomCss('.a { color: red; }');
		const before = { ...settings };
		settings.minLinesToRecord = 30;

		manager.applyChangedSettings(before);

		expect(styleEl()?.textContent).toBe('.a { color: red; }');
	});
});
