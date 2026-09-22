import { App, View, WorkspaceLeaf } from 'obsidian';

// Workspace-leaf helpers that are not specific to any one feature: the leaf
// identity used as a map key by both the position state and the nav history,
// and the "is this leaf part of the main editor area" test shared by the open
// patches and the recent-files browser. They live here — not in nav/entry —
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

// The name a view gives itself — what its own tab header prints, and therefore
// what a recent-files row standing for it says (see nav/entry's NavView.label).
// Obsidian's getDisplayText is the app's own channel for this, so the global graph
// answers in the app's language and a third-party view names itself without this
// plugin having to know that plugin exists.
//
// Empty (or absent) is NO NAME rather than an empty one: a view that never
// overrode it has nothing to say, and the browser has its own wording for that
// case (see recent-files/browser/model.ts's viewName). Guarded because this is a
// foreign method called from a workspace event handler: a view that throws here
// would take the reader's own tab switch down with it, and a row's wording is
// never worth that.
export function viewLabel(view: View | undefined): string | undefined {
	if (!view)
		return undefined;
	try {
		const label = view.getDisplayText();
		return typeof label === 'string' && label ? label : undefined;
	} catch {
		return undefined;
	}
}
