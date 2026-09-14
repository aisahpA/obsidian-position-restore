// PathBookkeeper (position/path-bookkeeping.ts) owns everything the plugin keys
// by a vault path, for both of the vault's path events:
//  - a RENAME moves the position record, the navigation-history entries and the
//    pipeline's current-file pointer together — and leaves the pointer alone
//    when it named some other file;
//  - a DELETE is scheduled, not acted on, and when the window closes the VAULT
//    decides: a path that is back is not deleted at all (the sync plugin's
//    remove-then-rename replacement), a path still missing is pruned exactly as
//    before, once, even if it was deleted repeatedly.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { App, TAbstractFile } from 'obsidian';

import { PathBookkeeper } from '@/position/path-bookkeeping';

// Timing is stated as "a beat" and "long after", never as the grace period
// itself: these tests pin the mechanism (deferred, decided by the vault, no
// overlapping windows), so retuning the window must not touch them.
const A_BEAT = 100;
const LONG_AFTER = 60_000;

function makeHarness() {
	// The vault's file index, as the re-check at close time sees it.
	const files = new Set<string>();
	const app = {
		vault: { getAbstractFileByPath: (path: string) => (files.has(path) ? { path } : null) },
	};
	const database = { renameFile: vi.fn(), deleteFile: vi.fn() };
	const nav = { renameFile: vi.fn(), deleteFile: vi.fn() };
	const state = { lastLoadedFilePath: undefined as string | undefined };
	const bookkeeper = new PathBookkeeper(
		app as unknown as App,
		database as never,
		nav as never,
		state as never,
	);
	const file = (path: string) => ({ path }) as TAbstractFile;
	return { bookkeeper, database, nav, state, files, file };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('PathBookkeeper rename', () => {
	it('moves the position record, the history entries and the current-file pointer', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'a.md';

		h.bookkeeper.renameFile(h.file('b.md'), 'a.md');

		// Each store keeps its own argument order: the db is (new, old), the
		// history is (old, new) — the bookkeeper is where both are stated once.
		expect(h.database.renameFile).toHaveBeenCalledWith('b.md', 'a.md');
		expect(h.nav.renameFile).toHaveBeenCalledWith('a.md', 'b.md');
		expect(h.state.lastLoadedFilePath).toBe('b.md');
	});

	it('leaves the current-file pointer alone when it named another file', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'c.md';

		h.bookkeeper.renameFile(h.file('b.md'), 'a.md');

		expect(h.nav.renameFile).toHaveBeenCalledWith('a.md', 'b.md');
		expect(h.state.lastLoadedFilePath).toBe('c.md');
	});
});

describe('PathBookkeeper delete', () => {
	it('a path that is back when the window closes is not pruned (the sync replacement)', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.files.add('a.md');

		// Gone at the delete, back before the window closes. The same result
		// follows from the path being back before the delete is even scheduled:
		// what decides is the vault read at close time, never an event pairing.
		h.files.delete('a.md');
		h.bookkeeper.deleteFile(h.file('a.md'));
		h.files.add('a.md');

		vi.advanceTimersByTime(LONG_AFTER);

		expect(h.database.deleteFile).not.toHaveBeenCalled();
		expect(h.nav.deleteFile).not.toHaveBeenCalled();
	});

	it('a path still missing when the window closes is pruned from both stores, and not before', () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		vi.advanceTimersByTime(A_BEAT); // a beat: deferred, not synchronous
		expect(h.database.deleteFile).not.toHaveBeenCalled();

		vi.advanceTimersByTime(LONG_AFTER);
		expect(h.database.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.database.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.nav.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.nav.deleteFile).toHaveBeenCalledWith('a.md');
	});

	it('repeated deletes of a still-missing path prune once: a later delete restarts the window', () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		vi.advanceTimersByTime(A_BEAT);
		h.bookkeeper.deleteFile(h.file('a.md')); // restarts the window
		vi.advanceTimersByTime(A_BEAT);
		expect(h.database.deleteFile).not.toHaveBeenCalled(); // neither window has closed

		// Long after BOTH windows: only the restarting one may have fired.
		vi.advanceTimersByTime(LONG_AFTER);
		expect(h.database.deleteFile).toHaveBeenCalledTimes(1);
	});
});
