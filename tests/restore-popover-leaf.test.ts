// Unit tests for the one place a pane is not a pane: a real leaf hosted inside
// a hover popover — what a plugin that makes the app's preview editable puts
// there. 'file-open' fires for it like any other, and restoring it lands the
// card on a line nobody pointed at, behind a cover that holds it blank for as
// long as the settle takes. The preview opens where the app opens one.

import { describe, it, expect } from 'vitest';
import { MarkdownView, type WorkspaceLeaf } from 'obsidian';

import { Restorer } from '@/position/restore/restorer';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';
import { isPopoverLeaf } from '@/shared/leaf';

// The only thing separating "a preview" from "a pane" is where the leaf lives.
function makeView(inPopover: boolean) {
	const root = document.createElement('div');
	const host = document.createElement('div');
	if (inPopover) {
		const popover = document.createElement('div');
		popover.className = 'hover-popover';
		popover.appendChild(host);
		root.appendChild(popover);
	} else {
		root.appendChild(host);
	}
	const leaf = { id: 'leaf-1', containerEl: host } as unknown as WorkspaceLeaf;
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path: 'a.md' },
		leaf,
	}) as MarkdownView;
	// The store names its overlay per vault on construction; without it the
	// store logs a read failure into every run of these tests.
	const app = {
		workspace: { getActiveViewOfType: () => view },
		vault: { getName: () => 'vault' },
	};
	const state = new PositionState(DEFAULT_SETTINGS);
	const store = new PositionStore(app as never, { db: { 'a.md': { scroll: 10 } } } as never);
	return {
		state,
		leaf,
		restorer: new Restorer(app as never, DEFAULT_SETTINGS, store, state),
	};
}

describe('a leaf a hover popover hosts', () => {
	it('is told apart by where it lives, not by what it shows', () => {
		expect(isPopoverLeaf(makeView(true).leaf)).toBe(true);
		expect(isPopoverLeaf(makeView(false).leaf)).toBe(false);
	});

	it('is left where the app opened it', async () => {
		const { state, leaf, restorer } = makeView(true);

		await restorer.restoreEphemeralState();

		// No pair recorded and no cover: the restore never began, so the card
		// shows what the app drew rather than a blank held until a settle that
		// was never going to arrive for a reader who only hovered.
		expect(state.handledLeafIdMap.get('leaf-1')).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
	});
});
