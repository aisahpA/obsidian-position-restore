// Shared helpers for the two navigation-recording suites: nav-funnel.test.ts
// (the funnel's own contract, and the capture points that write to it) and
// nav-history-stack.test.ts (the stack that reads it).
//
// NOT a test file itself — vitest only collects `*.test.ts`. This mirrors
// tests/support/position-store-seam.ts: a plain module the suites import.

import { vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';

import { App, FileView, TFile } from 'obsidian';
import { NavFunnel } from '@/nav/funnel';
import { NavStack } from '@/nav-history/stack';
import { NavPlaces } from '@/recent-files/places';
import { NavEntry } from '@/nav/entry';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS, EphemeralState, PluginSettings } from '@/types';

export function makeApp(
	headings?: Array<{ heading: string; level: number; position: { start: { line: number } } }>,
): App & { commands: { executeCommandById: ReturnType<typeof vi.fn> } } {
	return {
		appId: 'test-vault',
		vault: {
			getName: () => 'Test',
			getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }),
		},
		metadataCache: { getFileCache: () => (headings ? { headings } : null) },
		workspace: {
			layoutReady: true,
			rootSplit: { containerEl: { contains: (el: unknown) => el === 'main' } },
			getActiveViewOfType: () => null,
			iterateAllLeaves: (_cb: (leaf: WorkspaceLeaf) => void) => undefined,
			setActiveLeaf: vi.fn(),
			getMostRecentLeaf: () => null,
			// The view branch of the open pipeline asks the workspace for every leaf
			// showing a view TYPE and, when there is none, for a new tab (see stack.ts's
			// findLeafShowing / showViewInNewTab). A suite that never travels to a view
			// has neither, and says so here rather than leaving the methods missing.
			getLeavesOfType: () => [],
			getLeaf: () => ({ setViewState: vi.fn(), detach: vi.fn() }),
		},
		commands: { executeCommandById: vi.fn() },
	} as unknown as App & { commands: { executeCommandById: ReturnType<typeof vi.fn> } };
}

// The two navigation readers, wired as the composition root wires them (see
// position/manager.ts): the CAPTURE points (the record* calls) write to the
// funnel, and the funnel publishes to the stack and the place list. The harness
// hands all three back by name, so a test says which side it means — `funnel.`
// for a capture, `stack.` for the stack's own state and traversal, `places.`
// for the recent-files list.
export function makeNav(
	app = makeApp(),
	settings: Partial<PluginSettings> = {},
	savedPosition?: (path: string) => EphemeralState | undefined,
) {
	// The middle stop of the landings setting, against the shipped default of
	// 'none' (see LandingsMode): most of these tests watch the place list to see
	// what a jump BECAME, and the bottom stop would refuse the jump before there
	// was anything to look at. The default is a setting, not a behaviour of
	// navigation, so nothing here is bent by it.
	const resolved = { ...DEFAULT_SETTINGS, recentFilesLandings: 'last', ...settings } as PluginSettings;
	const state = new PositionState(resolved);
	const funnel = new NavFunnel(app, state);
	const stack = new NavStack(app, resolved, state, funnel, savedPosition);
	const places = new NavPlaces(app, resolved);
	funnel.subscribe(stack);
	funnel.subscribe({
		onVisit: (recording) => places.remember(recording.record),
		onLanded: (entry) => places.settle(entry),
		onHere: (entry) => places.markCurrent(entry),
	});
	places.attach({
		openFile: (path, leafId, target) => stack.openFilePlain(path, leafId, target),
		openJump: (entry, target) => stack.travelTo(entry, target),
		openView: (entry, target) => stack.openViewPlace(entry, target),
	});
	return { funnel, stack, places };
}

export function entry(path: string, leafId = 'leaf-1'): NavEntry {
	return { kind: 'visit', path, leafId, t: 1 };
}

// A leaf whose view is a file view — or, with no `file`, the EMPTY TAB's view,
// which is the one main-area view that is not a place. `containerEl` is what
// isMainAreaLeaf asks the workspace root about, so 'sidebar' models a panel while
// the default 'main' sits in the root.
export function leafWithFile(id: string, file?: string, containerEl: unknown = 'main'): WorkspaceLeaf {
	return {
		id,
		containerEl,
		view: file
			? Object.assign(Object.create(FileView.prototype), { file: { path: file } })
			: { getViewType: () => 'empty' },
	} as unknown as WorkspaceLeaf;
}

// A leaf holding a non-file view — the graph, Thino's memo list, a main-area
// search. Everything it reports is what the view says about ITSELF: `label` and
// `icon` are the name and mark its tab header shows (what a row standing for it
// prints and draws), and `state` is what it answers getState with — the state a
// place is REBUILT with when its own tab is gone (see nav/entry's NavView). All
// three are optional: the global graph names no icon and has no state, and a view
// that reports nothing is the ordinary case rather than the broken one.
export function viewLeaf(
	id: string,
	viewType: string,
	opts: { label?: string; icon?: string; state?: Record<string, unknown>; containerEl?: unknown } = {},
): WorkspaceLeaf {
	return {
		id,
		containerEl: opts.containerEl ?? 'main',
		view: {
			getViewType: () => viewType,
			getDisplayText: () => opts.label,
			getIcon: () => opts.icon,
			getState: () => opts.state,
		},
	} as unknown as WorkspaceLeaf;
}

// These tests build file-only stacks (a graph entry appears in exactly one
// full-object equality assertion); the helpers narrow the file kinds so the
// per-index reads stay terse.
export const pathOf = (e: NavEntry) => (e.kind !== 'view' ? e.path : undefined);
export const keyOf = (e: NavEntry) => (e.kind === 'jump' ? e.key : e.kind === 'teleport' ? `teleport:${e.line}` : undefined);
export const stOf = (e: NavEntry) => (e.kind !== 'view' ? e.st : undefined);
export const viaOf = (e: NavEntry) => (e.kind === 'visit' ? e.via : undefined);
