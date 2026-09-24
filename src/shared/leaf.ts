import { App, MarkdownView, View, WorkspaceLeaf } from 'obsidian';

// Leaf helpers shared by the position core and the nav feature. They live here
// and not in nav/entry, so the position core never depends on navigation.

// Only main-area leaves record as navigation entries. A sidebar panel (outline,
// backlinks, local graph) tracks the active file in its own view state, so
// recording it makes a phantom entry whose traversal only re-focuses the panel.
export function isMainAreaLeaf(app: App, leaf: WorkspaceLeaf): boolean {
	const root = app.workspace.rootSplit as { containerEl?: HTMLElement } | undefined;
	const el = (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
	return !!root?.containerEl && !!el && root.containerEl.contains(el);
}

// The markdown view SHOWING one path right now, if any — the only place a note's
// lines can be read as the reader has it, saved or not: the editor is ahead of
// the disk by whatever they typed.
export function markdownViewFor(app: App, path: string): MarkdownView | undefined {
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view as MarkdownView | undefined;
		if (view?.file?.path === path && typeof view.editor?.getLine === 'function')
			return view;
	}
	return undefined;
}

// A leaf's id. Runtime API, absent from the public typings — and the same cast
// family as the one above.
export function leafIdOf(leaf: WorkspaceLeaf): string {
	return (leaf as unknown as { id: string }).id;
}

// The name a view gives itself — what its own tab header prints. getDisplayText
// is the app's own channel for it, so a third-party view names itself without
// this plugin knowing that plugin exists.
//
// Empty is NO NAME rather than an empty one: the row has its own wording for a
// view that never named one. Guarded because it is a foreign method called from
// a workspace event handler — a throw here would take a tab switch down with it.
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

// The icon a view gives itself, for the mark a row standing for it prints. Same
// channel, same guards.
//
// Absent is NO ICON and not a default one: an icon id the app's build does not
// know draws an empty slot, and an empty slot says less than a word does.
export function viewIcon(view: View | undefined): string | undefined {
	if (!view)
		return undefined;
	try {
		const icon = view.getIcon();
		return typeof icon === 'string' && icon ? icon : undefined;
	} catch {
		return undefined;
	}
}

// The most one view's state may take in storage, as serialized length. The blob
// it shares is a whole list of places (places-store.ts), so a plugin keeping its
// cache in its view state must not be able to take the list's budget.
const VIEW_STATE_MAX_BYTES = 2048;

// The state a view had while the reader was there — what the place is rebuilt
// with when its tab is gone (`setViewState({ type, state })`). The one thing
// about a view that cannot be re-derived later.
//
// The JSON round-trip's second job is the one that is easy to miss: it keeps a
// COPY. A view goes on mutating its own state object, and a row holding a
// reference would drift with it — replaying the place would then take the reader
// to wherever the view happens to be NOW.
export function viewState(view: View | undefined): Record<string, unknown> | undefined {
	if (!view)
		return undefined;
	try {
		const raw = view.getState();
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			return undefined;
		const json = JSON.stringify(raw);
		if (!json || json === '{}' || json.length > VIEW_STATE_MAX_BYTES)
			return undefined;
		const copy = JSON.parse(json) as unknown;
		return copy && typeof copy === 'object' && !Array.isArray(copy)
			? copy as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}
