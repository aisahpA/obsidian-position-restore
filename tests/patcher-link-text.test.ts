// Unit tests for the openLinkText-patch capture in OpenPatcher: what a link
// navigation hands the funnel as its JUMP KEY. The regression behind them — a
// wikilink arrives WHOLE, display alias and all (`a.md#^b1|Example 2:`), and
// with the label left on, the key names a block that does not exist and a slug
// no heading equals. Neither anchor resolved, so the step kept no keyLine and
// the traversal fell back to the text-snippet remap — which is how back could
// land somewhere other than where the reader stood.

import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';

import { OpenPatcher } from '@/position/restore/patcher';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

function makeHarness() {
	const state = new PositionState(DEFAULT_SETTINGS);
	const workspace = { openLinkText: vi.fn(async () => undefined) };
	const app = { workspace, vault: { getName: () => 'Test' } } as unknown as App;
	const store = new PositionStore(app, { db: {} } as never);
	// The patcher is a pure CAPTURE point: it writes to the funnel and reads no
	// reader, so a spy for what it calls is all it needs.
	const funnel = {
		recordOpen: vi.fn(), recordTeleport: vi.fn(), leave: vi.fn(), settled: vi.fn(), landing: vi.fn(),
	};
	const patcher = new OpenPatcher(
		app, DEFAULT_SETTINGS, store, state, funnel as never, { flushOnLeave: vi.fn() } as never,
	);
	// patchOpenLinkText is private; the test drives it through this alias, the
	// same way the composition root does (see position/manager.ts).
	(patcher as unknown as { patchOpenLinkText(fn: () => void): void }).patchOpenLinkText(() => undefined);
	return { state, open: workspace.openLinkText as unknown as (...args: unknown[]) => Promise<void> };
}

describe('OpenPatcher 抓取链接', () => {
	it('块链接按链接本身作 key，不按它标着什么', async () => {
		const { state, open } = makeHarness();
		await open('a.md#^b1|Example 2:', 'src.md');
		expect(state.pendingLinkKind).toBe('anchorLink');
		expect(state.pendingLinkText).toBe('a.md#^b1');
	});

	it('标题链接按链接本身作 key，不按它标着什么', async () => {
		const { state, open } = makeHarness();
		await open('a.md#my-heading|Example', 'src.md');
		expect(state.pendingLinkText).toBe('a.md#my-heading');
	});

	it('没有标签的链接原样放过', async () => {
		const { state, open } = makeHarness();
		await open('a.md#^b1', 'src.md');
		expect(state.pendingLinkText).toBe('a.md#^b1');
		await open('#my-heading', 'src.md');
		expect(state.pendingLinkText).toBe('#my-heading');
	});

	it('没点名锚点的链接不记 key', async () => {
		// `[[a.md|Alias]]` opens the note whole: it is an open, not a jump, and a
		// key taken from it would absorb every later landing on that note.
		const { state, open } = makeHarness();
		await open('a.md|Alias', 'src.md');
		expect(state.pendingLinkKind).toBeUndefined();
		expect(state.pendingLinkText).toBeUndefined();
	});
});
