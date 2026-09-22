import { App, WorkspaceLeaf } from 'obsidian';

// Workspace-leaf helpers that are not specific to any one feature: the leaf
// identity used as a map key by both the position state and the nav history,
// and the "is this leaf part of the main editor area" test shared by the open
// patches and the recent-files browser. They live here — not in nav-history/entry —
// so the position core never has to depend on the navigation feature.

// Only main-area leaves record as navigation entries. Sidebar panels
// (outline, backlinks, local graph…) track the active file in their own
// view state: focusing the panel (or its state re-assertion) carries that
// file through activation/setViewState, and recording it creates a phantom
// entry whose "leaf" is the panel — a traversal targeting it would only
// re-focus the panel. Hover previews and pop-out windows are equally not
// entries of this workspace.
export function isMainAreaLeaf(app: App, leaf: WorkspaceLeaf): boolean {
	// (rootSplit.containerEl and leaf.containerEl are runtime API absent
	// from the public typings — same cast family as leafIdOf.)
	const root = app.workspace.rootSplit as { containerEl?: HTMLElement } | undefined;
	const el = (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
	return !!root?.containerEl && !!el && root.containerEl.contains(el);
}

// A leaf's id. Runtime API, absent from the public typings — the single place
// that knows how to read it (PositionState.leafId delegates here).
export function leafIdOf(leaf: WorkspaceLeaf): string {
	return (leaf as unknown as { id: string }).id;
}
