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
	// The DISK, asked on its own (see confirmGone): a sync plugin puts a file back through
	// the adapter, which the index need not hear about — so the two may disagree.
	const disk = new Set<string>();
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => (files.has(path) ? { path } : null),
			adapter: { exists: async (path: string) => disk.has(path) },
		},
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
	const restore = (path: string) => {
		files.add(path);
		disk.add(path);
	};
	const remove = (path: string) => {
		files.delete(path);
		disk.delete(path);
	};
	return { bookkeeper, store, navStore, state, files, disk, file, restore, remove };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('PathBookkeeper 改名', () => {
	it('挪走位置记录、历史条目与当前文件指针', () => {
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

	it('当前文件指针指的是别的文件时不动它', () => {
		const h = makeHarness();
		h.state.lastLoadedFilePath = 'c.md';

		h.bookkeeper.renameFile(h.file('b.md'), 'a.md');

		expect(h.navStore.renameFile).toHaveBeenCalledWith('a.md', 'b.md');
		expect(h.state.lastLoadedFilePath).toBe('c.md');
	});
});

describe('PathBookkeeper 删除', () => {
	it('窗口结束时又回来的路径不清掉（同步替换）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.restore('a.md');

		// Gone at the delete, back before the window closes. The same result
		// follows from the path being back before the delete is even scheduled:
		// what decides is the vault read at close time, never an event pairing.
		h.remove('a.md');
		h.bookkeeper.deleteFile(h.file('a.md'));
		h.restore('a.md');

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
	});

	it('窗口结束时仍然缺失的路径从两个 store 清掉，且绝不提前', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT); // a beat: deferred, not synchronous
		expect(h.store.deleteFile).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.store.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.navStore.deleteFile).toHaveBeenCalledTimes(1);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
	});

	it('对仍然缺失的路径反复删除只清一次：后一次删除会重启窗口', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.bookkeeper.deleteFile(h.file('a.md')); // restarts the window
		await vi.advanceTimersByTimeAsync(A_BEAT);
		expect(h.store.deleteFile).not.toHaveBeenCalled(); // neither window has closed

		// Long after BOTH windows: only the restarting one may have fired.
		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).toHaveBeenCalledTimes(1);
	});

	// The reported bug: a phone's sync takes the note away and puts it back, and the
	// replacement is a network round trip, so whether it lands inside the window is not
	// something the record's survival may depend on. The vault's own word that the path
	// is back cancels the prune — the window is only what happens to a delete nothing
	// ever contradicts.
	it('为已删路径新建文件会取消清理（同步的删掉再写入）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.bookkeeper.fileCreated(h.file('a.md'));

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
	});

	it('覆盖到已删路径的改名取消清理（同步的删掉再改名）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		// The download lands under a temp name and is renamed over the target.
		h.bookkeeper.renameFile(h.file('a.md'), 'a.md.tmp');

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
		// …and the re-key it also is still happens: a cancelled prune is not a
		// cancelled rename.
		expect(h.store.renameFile).toHaveBeenCalledWith('a.md', 'a.md.tmp');
	});

	// A phone's sync writes the downloaded file straight through the adapter, and the index need
	// not hear about it: the delete it triggered is answered by a disk that has the file back and
	// an index that still does not. The record has to survive that disagreement — an index that
	// lags the disk is one sync behind, not a file that is gone.
	it('磁盘上有、索引里没有的路径不清掉（同步绕过了 vault 直接写）', async () => {
		vi.useFakeTimers();
		const h = makeHarness();

		h.bookkeeper.deleteFile(h.file('a.md'));
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.disk.add('a.md'); // back on disk; the index never hears about it

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.store.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
	});
});

describe('PathBookkeeper 启动扫描', () => {
	it('丢掉 vault 里没有的那个路径的历史 —— 而且只丢历史', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md', 'b.md']);
		h.restore('b.md'); // still there: not swept

		h.bookkeeper.sweepMissingHistory();
		await vi.advanceTimersByTimeAsync(A_BEAT); // a beat: deferred, like a live delete
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
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

	it('被扫到的路径在窗口内回来了就保留历史', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		h.restore('a.md'); // the sync plugin finished downloading

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.persist).not.toHaveBeenCalled();
	});

	it('被扫到的路径被实时删除时，仍然清掉两个 store', async () => {
		// The two deferrals are independent maps, so a vault 'delete' arriving
		// while a sweep is pending must not be narrowed to history-only by it.
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		h.bookkeeper.deleteFile(h.file('a.md'));

		await vi.advanceTimersByTimeAsync(LONG_AFTER);

		expect(h.store.deleteFile).toHaveBeenCalledWith('a.md');
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('a.md');
	});

	it('够到每一个导航 store，不只是第一个', async () => {
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
		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.navStore.deleteFile).toHaveBeenCalledWith('b.md');
		expect(other.deleteFile).toHaveBeenCalledWith('a.md');
		expect(other.deleteFile).toHaveBeenCalledWith('b.md');
		expect(other.persist).toHaveBeenCalled();
	});

	it('窗口还站着时同步送来的那个被扫路径保留历史', async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		h.navStore.knownPaths.mockReturnValue(['a.md']);

		h.bookkeeper.sweepMissingHistory();
		await vi.advanceTimersByTimeAsync(A_BEAT);
		h.bookkeeper.fileCreated(h.file('a.md'));

		await vi.advanceTimersByTimeAsync(LONG_AFTER);
		expect(h.navStore.deleteFile).not.toHaveBeenCalled();
		expect(h.navStore.persist).not.toHaveBeenCalled();
	});
});
