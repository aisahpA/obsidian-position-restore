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

import { describe, it, expect, afterEach } from 'vitest';
import { App, MarkdownPreviewRenderer } from 'obsidian';

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

// What a preview's renderer is asked to do: move to a line, and — core's own
// call bakes this in — flag it on arrival.
interface Move {
	line: number;
	opts?: { highlight?: boolean; center?: boolean };
}

// The method is not in the typings — core's own delayed scroll, internal — so
// both the patch and these tests meet it through this shape.
const rendererProto = () => MarkdownPreviewRenderer.prototype as unknown as {
	applyScrollDelayed?: (line: number, opts?: Move['opts']) => void;
};

// Stands in for core's delayed scroll so a test can read the options the patch
// passes down, and only those: the recorded move is the whole assertion.
const restorers: (() => void)[] = [];

function recordingRenderer() {
	const proto = rendererProto();
	const original = proto.applyScrollDelayed;
	const moves: Move[] = [];
	proto.applyScrollDelayed = function (line: number, opts?: Move['opts']) {
		moves.push({ line, opts });
	};
	restorers.push(() => {
		proto.applyScrollDelayed = original;
	});
	const renderer = new MarkdownPreviewRenderer() as unknown as {
		applyScrollDelayed: (line: number, opts?: Move['opts']) => void;
	};
	return {
		moves,
		to: (line: number, opts?: Move['opts']) => {
			renderer.applyScrollDelayed(line, opts);
			return moves.at(-1);
		},
	};
}

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
	const flash = recordingRenderer();
	target.install(fn => cleanups.push(fn));
	return {
		workspace,
		calls,
		cleanups,
		flash,
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

// Every install stacks a patch on the renderer's prototype; hand it back before
// the next test stacks another on top of it.
afterEach(() => {
	while (restorers.length)
		restorers.pop()?.();
});

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

// Core hangs a flash on the move to a line: `applyScrollDelayed` is called with
// `{highlight:true, center:true}` and a hover ask carries no field to say no.
// The move this plugin's line causes is the one move that runs without it.
describe('the flash that comes with the move', () => {
	it('is dropped on the move this plugin’s line causes', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12, { highlight: true, center: true })).toEqual({
			line: 12,
			opts: { highlight: false, center: true },
		});
	});

	it('stays for a move this plugin did not aim', () => {
		// The note's top is what ships, so the preview never asked for a line —
		// and a flash on a move nobody here caused is not ours to drop.
		const h = installed('head', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12, { highlight: true })!.opts).toEqual({ highlight: true });
	});

	it('stays for a move to another line', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(30, { highlight: true })!.opts).toEqual({ highlight: true });
	});

	it('is spent once, by the first move that would flash', () => {
		// One aim, one dropped flash: a second move to the same line is a move
		// this plugin no longer stands behind.
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12, { highlight: true })!.opts!.highlight).toBe(false);
		expect(h.flash.to(12, { highlight: true })!.opts!.highlight).toBe(true);
	});

	it('is left alone once another list has asked', () => {
		// The last ask wins: a hover from anywhere else means the next flash
		// belongs to that ask.
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');
		h.workspace.trigger('hover-link', { source: 'search', linktext: 'a.md' });

		expect(h.flash.to(12, { highlight: true })!.opts).toEqual({ highlight: true });
	});

	it('is not spent by a move that never asked to flash', () => {
		// Hover Editor calls the same method on resize, with no options at all:
		// that move wants no flash, so it must not use up the aim behind the one
		// that does.
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		h.fileList('a.md');

		expect(h.flash.to(12)!.opts).toBeUndefined();
		expect(h.flash.to(12, { highlight: true })!.opts!.highlight).toBe(false);
	});

	it('hands the renderer back on unload', () => {
		const h = installed('line', { 'a.md': { scroll: 12 } }, note);
		const patched = rendererProto().applyScrollDelayed;

		for (const cleanup of h.cleanups)
			cleanup();

		expect(rendererProto().applyScrollDelayed).not.toBe(patched);
	});
});
