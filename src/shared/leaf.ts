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

// A leaf whose VIEW HAS NOT BEEN BUILT: the workspace restores a tab as a placeholder that
// answers a view's questions off the state it was saved with — and that placeholder is not the
// view's own class, so `instanceof FileView` is false for a note's tab (mobile comes back to
// one this way). Runtime-only, absent from the public typings.
export function isDeferredLeaf(leaf: WorkspaceLeaf | null | undefined): boolean {
	return !!(leaf as unknown as { isDeferred?: boolean } | null | undefined)?.isDeferred;
}

// Whether the app can still BUILD that view. Its factory table holds one entry per type, and a
// type with none (a plugin switched off, uninstalled, or not loaded yet) is answered by a
// placeholder pane that CLAIMS to be it — nothing the reader can ever return to. A read that
// fails, or a table this build does not expose, answers "not missing": the call can only ever
// EXCLUDE, so losing it degrades to today rather than to recording nothing at all.
export function viewTypeIsMissing(app: App, viewType: string): boolean {
	const registry = (app as unknown as {
		viewRegistry?: { getViewCreatorByType?: (type: string) => unknown };
	}).viewRegistry;
	if (!registry?.getViewCreatorByType)
		return false;
	try {
		return !registry.getViewCreatorByType(viewType);
	} catch {
		return false;
	}
}

// Whether that FileView IS the note's destination. A FileView may instead FOLLOW the note it is
// looking at — outline, backlinks, local graph, file properties — which the app records in a
// runtime-only flag absent from the typings. Those answer every question a FileView does, so in
// the main area only this tells them apart (see nav/funnel.ts for what recording them as the file
// costs: a second row for a note the reader never went to).
//
// ONLY `false` excludes: a build that renames or drops the field reads undefined, and answering
// "not a file" then would take every real file view with it.
export function isFileDestination(view: View): boolean {
	return (view as unknown as { navigation?: boolean }).navigation !== false;
}

// The file a deferred placeholder stands in for, read off the state it was restored with: the
// tab is still that note, and recording it as a view would mint a place with no file behind it.
export function deferredFilePath(view: View | undefined): string | undefined {
	const file = viewState(view)?.file;
	return typeof file === 'string' && file ? file : undefined;
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
