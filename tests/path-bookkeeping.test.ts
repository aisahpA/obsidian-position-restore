// PathBookkeeper (position/path-bookkeeping.ts) owns everything the plugin keys
// by a vault path, for both of the vault's path events:
//  - a RENAME moves the position records (both layers, in one store call), the
//    navigation stores' entries (each re-keying its OWN records) and the
//    pipeline's current-file pointer together — and leaves the pointer alone
//    when it named some other file;
//  - a DELETE is scheduled, not acted on, and when the window closes the VAULT
//    decides: a path that is back is not deleted at all (the sync plugin's
//    remove-then-rename replacement), a path still missing is pruned exactly as
//    before, once, even if it was deleted repeatedly.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { App, TAbstractFile } from 'obsidian';

import { PathBookkeeper, type PathStore } from '@/position/path-bookkeeping';

// Timing is stated as "a beat" and "long after", never as the grace period
// itself: these tests pin the mechanism (deferred, decided by the vault, no
// overlapping windows), so retuning the window must not touch them.
const A_BEAT = 100;
const LONG_AFTER = 60_000;

// `extraNavStore` joins the list the bookkeeper is handed, so a test can check
// it reaches EVERY navigation store and not just the first (the production list
// is [stack, recent-files list]).
function makeHarness(extraNavStore?: PathStore) {
	// The vault's file index, as the re-check at close time sees it.
	const files = new Set<string>();
	const app = {
		vault: { getAbstractFileByPath: (path: string) => (files.has(path) ? { path } : null) },
	};
	const store = { renameFile: vi.fn(), deleteFile: vi.fn() };
	// One path-keyed navigation store (the back/forward stack, in production):
	// it re-keys/drops its own records, and so would every sibling in the list.
	const navStore = {
		renameFile: vi.fn(),
		deleteFile: vi.fn(),
		persist: vi.fn(),
		knownPaths: vi.fn((): string[] => []),
	};
	const state = { lastLoadedFilePath: undefined as string | undefined };
	const bookkeeper = new PathBookkeeper(
		app as unknown as App,
		store as never,
		extraNavStore ? [navStore, extraNavStore] : [navStore],
		state as never,
	);
	const file = (path: string) => ({ path }) as TAbstractFile;
	return { bookkeeper, store, navStore, state, files, file };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('PathBookkeeper rename', () => {
	it('moves the position record, the history entries and the current-file pointer', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'a.md';

		h.bookkeeper.renameFile(h.file('b.md'), 'a.md');

		// Each store keeps its own argument order: the position store is
		// (new, old), the history is (old, new) — the bookkeeper is where both
		// are stated once.
		expect(h.store.renameFile).toHaveBeenCalledWith('b.md', 'a.md');
		expect(h.navStore.renameFile).toHaveBeenCalledWith('a.md', 'b.md');
		expect(h.state.lastLoadedFilePath).toBe('b.md');
	});

	it('leaves the current-file pointer alone when it named another file', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'c.md';

		h.bookkeeper.renameFile(h.file('b.md'), 'a.md');

		expect(h.navStore.renameFile).toHaveBeenCalledWith('a.md', 'b.md');
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

		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
	});

	it('a path still missing when the window closes is pruned from both stores, and not before', () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		vi.advanceTimersByTime(A_BEAT); // a beat: deferred, not synchronous
		expect(h.store.deleteFile).not.toHaveBeenCalled();

		vi.advanceTimersByTime(LONG_AFTER);
		expect(h.store.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.store.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.navStore.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
	});

	it('repeated deletes of a still-missing path prune once: a later delete restarts the window', () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		vi.advanceTimersByTime(A_BEAT);
		h.bookkeeper.deleteFile(h.file('a.md')); // restarts the window
		vi.advanceTimersByTime(A_BEAT);
		expect(h.store.deleteFile).not.toHaveBeenCalled(); // neither window has closed

		// Long after BOTH windows: only the restarting one may have fired.
		vi.advanceTimersByTime(LONG_AFTER);
		expect(h.store.deleteFile).toHaveBeenCalledTimes(1);
	});
});

describe('PathBookkeeper startup sweep', () => {
	it('drops the history of a path the vault does not have — and only the history', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md', 'b.md']);
		h.files.add('b.md'); // still there: not swept

		h.bookkeeper.sweepMissingHistory();
		vi.advanceTimersByTime(A_BEAT); // a beat: deferred, like a live delete
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();

		vi.advanceTimersByTime(LONG_AFTER);
		expect(h.navStore.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
		// The position records are kept on purpose: the db is a synced file, so
		// a vault that has not finished materializing a file on this device
		// must not erase the positions the other devices still need.
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		// The prune is written out at once (the point of the sweep is that the
		// dead rows are gone), rather than left to the next flush.
		expect(h.navStore.persist).toHaveBeenCalled();
	});

	it('a swept path that is back within the window keeps its history', () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		h.files.add('a.md'); // the sync plugin finished downloading

		vi.advanceTimersByTime(LONG_AFTER);

		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.persist).not.toHaveBeenCalled();
	});

	it('a live delete of a swept path still drops both stores', () => {
		// The two deferrals are independent maps, so a vault 'delete' arriving
		// while a sweep is pending must not be narrowed to history-only by it.
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		h.bookkeeper.deleteFile(h.file('a.md'));

		vi.advanceTimersByTime(LONG_AFTER);

		expect(h.store.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
	});

	it('reaches every navigation store, not just the first', () => {
		// The bookkeeper is handed a LIST (the stack and the recent-files list in
		// production), and each store re-keys/drops its OWN records — so a drop that
		// only ever reached the first would leave the second holding dead rows.
		vi.useFakeTimers();
		const other: PathStore = {
			renameFile: vi.fn(),
			deleteFile: vi.fn(),
			persist: vi.fn(),
			knownPaths: vi.fn((): string[] => ['b.md']),
		};
		const h = makeHarness(other);
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.renameFile(h.file('c.md'), 'a.md');
		expect(other.renameFile).toHaveBeenCalledWith('a.md', 'c.md');

		// The sweep walks the UNION of the stores' paths and prunes it in each, so
		// a path only the second store knows is swept too.
		h.bookkeeper.sweepMissingHistory();
		vi.advanceTimersByTime(LONG_AFTER);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('b.md');
		expect(other.deleteFile).toHaveBeenCalledWith('a.md');
		expect(other.deleteFile).toHaveBeenCalledWith('b.md');
		expect(other.persist).toHaveBeenCalled();
	});
});
