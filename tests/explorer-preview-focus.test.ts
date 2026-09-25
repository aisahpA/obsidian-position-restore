// Unit tests for the hover-preview aim the plugin gives the APP'S OWN file
// list (ExplorerPreviewFocus). The app asks core for that preview without a
// position — `trigger("hover-link", { linktext: path })`, no state — so the
// card draws at the note's top; this is the one place that may add one.
//
// What each case pins down:
//  - the note's top is what ships, so a default install changes nothing;
//  - asked for the line, the payload carries the position recorded for the
//    FILE — not a landing out of the list, and not a re-derived line;
//  - every case that cannot answer leaves the ask exactly as the app made it;
//  - the patch is a patch: everything it does not mean to change is forwarded,
//    and unload hands the trigger back.

import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';

import { ExplorerPreviewFocus } from '@/position/hover/explorer-preview';
import { CursorPositionDatabase } from '@/position/storage/database';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

// What the app's file list puts in its hover ask, and all this module may touch
// in it.
interface Ask {
	source: string;
	linktext: string;
	state?: { scroll: number };
}

type PreviewFocusMode = PluginSettings['fileExplorerPreviewFocus'];

function installed(
	focus: PreviewFocusMode,
	db: Record<string, { scroll?: number }>,
	files: Record<string, string>,
) {
	const calls: { name: string; data: unknown[] }[] = [];
	const original = (name: string, ...data: unknown[]) => {
		calls.push({ name, data });
	};
	const workspace = { trigger: original };
	const app = {
		workspace,
		vault: {
			getFileByPath: (path: string) =>
				(path in files ? { path, extension: files[path] } : null),
		},
	} as unknown as App;
	const settings: PluginSettings = { ...DEFAULT_SETTINGS, fileExplorerPreviewFocus: focus };
	const target = new ExplorerPreviewFocus(
		app,
		{ db } as unknown as CursorPositionDatabase,
		settings,
	);
	const cleanups: (() => void)[] = [];
	target.install(fn => cleanups.push(fn));
	return {
		workspace,
		calls,
		cleanups,
		// The ask the app itself sends: a path and no position.
		fileList: (linktext: string, state?: { scroll: number }): Ask => {
			const ask: Ask = { source: 'file-explorer', linktext };
			if (state)
				ask.state = state;
			workspace.trigger('hover-link', ask);
			return ask;
		},
	};
}

const note = { 'a.md': 'md', 'scan.pdf': 'pdf' };

describe('the app file list’s hover preview', () => {
	it('adds nothing while the note’s top is what ships', () => {
		const h = installed('head', { 'a.md': { scroll: 12 } }, note);

		const ask = h.fileList('a.md');

		expect(ask.state).toBeUndefined();
		expect(h.calls).toHaveLength(1);
	});

	it('names the line last recorded for the note, when asked to', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);

		const ask = h.fileList('a.md');

		expect(ask.state).toEqual({ scroll: 12 });
	});

	it('names nothing where this plugin recorded no position', () => {
		const h = installed('line', {}, note);

		expect(h.fileList('a.md').state).toBeUndefined();
	});

	it('names nothing for a note recorded at its top', () => {
		// A scroll-0 record would buy the whole wait and move nowhere.
		const h = installed('line', { 'a.md': { scroll: 0 } }, note);

		expect(h.fileList('a.md').state).toBeUndefined();
	});

	it('names nothing for a file that is not a note', () => {
		const h = installed('line', { 'scan.pdf': { scroll: 40 } }, note);

		expect(h.fileList('scan.pdf').state).toBeUndefined();
	});

	it('leaves every other source’s ask alone', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		const ask: Ask = { source: 'search', linktext: 'a.md' };

		h.workspace.trigger('hover-link', ask);

		expect(ask.state).toBeUndefined();
	});

	it('does not overwrite a position the ask already carried', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);

		expect(h.fileList('a.md', { scroll: 3 }).state).toEqual({ scroll: 3 });
	});

	it('forwards every event it does not mean to change', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);

		h.workspace.trigger('file-open', { path: 'a.md' });

		expect(h.calls).toEqual([{ name: 'file-open', data: [{ path: 'a.md' }] }]);
	});

	it('hands the trigger back on unload', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		const patched = h.workspace.trigger;

		for (const cleanup of h.cleanups)
			cleanup();

		expect(h.workspace.trigger).not.toBe(patched);
		expect(h.fileList('a.md').state).toBeUndefined();
	});
});
