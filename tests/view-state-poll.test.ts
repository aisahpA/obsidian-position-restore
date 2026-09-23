// The poll's other half: while the reader sits in a VIEW, the tick keeps the
// current step's own state true (see manager.ts's sampleActiveViewState).
//
// It exists because a view's state is not finished when the reader arrives in it.
// The built-in browser is the case that shows it: until its page has committed and
// it has navigated, it answers getState with `{title, mode}` and no url at all —
// so the step pushed by that activation (and the row the place list writes over
// its own good state) names a place without saying WHERE it is. Nothing else reads
// it again until the reader leaves, which is the moment a tab closed straight
// after opening never gets to.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TAbstractFile } from 'obsidian';

import { App, WorkspaceLeaf } from 'obsidian';
import { PositionManager } from '@/position/manager';
import type { NavFunnel } from '@/nav/funnel';
import type { NavStack } from '@/nav-history/stack';
import type { NavView } from '@/nav/entry';
import { DEFAULT_SETTINGS, PluginSettings } from '@/types';

beforeEach(() => {
	window.localStorage.clear();
});

// A manager whose workspace answers for ONE leaf, and whose active view is
// whatever the test says it is — the poll asks the workspace, so this is the whole
// of the world it can see.
function makeHarness() {
	let activeView: unknown = null;
	const app = {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: () => null as TAbstractFile | null,
		},
		metadataCache: { getFileCache: () => null },
		workspace: {
			layoutReady: true,
			// Main-area for both of them: isMainAreaLeaf asks the root whether it
			// holds the leaf's element (see shared/leaf.ts).
			rootSplit: { containerEl: { contains: () => true } },
			getActiveViewOfType: () => activeView,
			iterateAllLeaves: () => undefined,
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
		},
	};
	const database = {
		db: {}, setState: vi.fn(), renameFile: vi.fn(), deleteFile: vi.fn(),
	};
	const settings = { ...DEFAULT_SETTINGS } as PluginSettings;
	const manager = new PositionManager(app as unknown as App, database as never, settings);
	const funnel = (manager as unknown as { funnel: NavFunnel }).funnel;
	const stack = (manager as unknown as { stack: NavStack }).stack;
	return {
		app, manager, funnel, stack,
		setActiveView: (v: unknown) => { activeView = v; },
		step: () => stack.entries[stack.index] as NavView,
	};
}

describe('the poll keeps the current step state true', () => {
	it('reads a view state that only arrives after the tab was activated', () => {
		const h = makeHarness();
		// A web viewer tab, just opened: the page has not committed, so its own
		// state has a title and a mode but no url.
		let state: Record<string, unknown> = { title: 'Google', mode: 'blank' };
		let title = 'Google';
		const view = {
			leaf: { id: 'leaf-w', containerEl: {} } as unknown as WorkspaceLeaf,
			getViewType: () => 'webviewer',
			getState: () => state,
			getDisplayText: () => title,
			getIcon: () => 'globe-2',
		};
		(view.leaf as unknown as { view: unknown }).view = view;
		h.setActiveView(view);

		h.manager.recordActivation(view.leaf as unknown as WorkspaceLeaf);
		expect(h.step().state).toEqual({ title: 'Google', mode: 'blank' });

		// The page commits: the viewer knows where it is now, and what it is called.
		state = { title: 'Google 搜索', mode: 'webview', url: 'https://www.google.com/' };
		title = 'Google 搜索';
		h.manager.sampleActiveView();

		expect(h.step()).toMatchObject({
			kind: 'view', viewType: 'webviewer', label: 'Google 搜索',
			state: { title: 'Google 搜索', mode: 'webview', url: 'https://www.google.com/' },
		});
	});

	it('is quiet while nothing moves, and only speaks for the current step', () => {
		const h = makeHarness();
		const view = {
			leaf: { id: 'leaf-w', containerEl: {} } as unknown as WorkspaceLeaf,
			getViewType: () => 'webviewer',
			getState: () => ({ url: 'https://www.google.com/', mode: 'webview' }),
			getDisplayText: () => 'Google',
			getIcon: () => 'globe-2',
		};
		(view.leaf as unknown as { view: unknown }).view = view;
		h.setActiveView(view);
		h.manager.recordActivation(view.leaf as unknown as WorkspaceLeaf);

		const landing = vi.spyOn(h.funnel, 'landing');
		h.manager.sampleActiveView();
		expect(landing).not.toHaveBeenCalled();

		// The reader moves on to a note: the view is no longer what they stand on,
		// so its (changed) state is nobody's business until they leave it.
		h.funnel.recordOpen('a.md', 'leaf-1');
		h.setActiveView({ ...view, getState: () => ({ url: 'https://example.com/', mode: 'webview' }) });
		h.manager.sampleActiveView();
		expect(landing).not.toHaveBeenCalled();
	});
});
