import { App, MarkdownView, View, WorkspaceLeaf } from 'obsidian';

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

// The markdown view SHOWING one path right now, if any — the only place a note's
// lines can be read that is guaranteed to be the note as the reader has it, saved
// or not: the editor's buffer is ahead of the file on disk by whatever they have
// typed, and a position compared against the disk would be a position compared
// against a version of the note nobody is looking at.
//
// One answer for the whole workspace rather than a first-match walk of the reader's
// own tabs: which of several tabs showing the same note is "the" one is not a
// question this helper was asked, and all of them hold the same text.
export function markdownViewFor(app: App, path: string): MarkdownView | undefined {
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view as MarkdownView | undefined;
		if (view?.file?.path === path && typeof view.editor?.getLine === 'function')
			return view;
	}
	return undefined;
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

// The ICON a view gives itself, for the mark a row standing for it prints
// (see recent-files/browser/list.ts's fileRow). Same channel and same guards as
// the label above, for the same reasons: it is what the reader saw on the tab
// they clicked, it names a third-party view without this plugin knowing that
// plugin, and it is a foreign method called from an event handler.
//
// Absent is NO ICON, not a default one: a view that never named an icon leaves
// the row to say "view" in WORDS instead, which is deliberate — an icon id the
// app's build does not know draws an empty slot, and an empty slot says less
// than a word does (the same reasoning as the type badge, see the stylesheet's
// .nav-file-tag note).
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

// The most a single view's state may take in this plugin's storage. Counted as
// the serialized length (UTF-16 units) — the same number as bytes for the ASCII
// such states are nearly always made of, and close enough either way for a
// ceiling whose job is catching an order-of-magnitude mistake rather than
// metering. The blob it shares storage with is a whole list of places (see
// recent-files/places-store.ts), so a plugin that decides to keep its cache in
// its own view state must not be able to take the list's budget with it.
const VIEW_STATE_MAX_BYTES = 2048;

// The STATE a view had while the reader was there — what a place is rebuilt with
// when its own tab is gone (`setViewState({ type, state })`: the local graph's
// file, a search's query, a plugin view's filters). This is the difference
// between "the view" and "the place you went to", and it is the one thing about
// a view that cannot be re-derived later, which is why it is recorded rather
// than looked up (see nav/entry's NavView.state).
//
// Optional, and three gates decide that — each one a real way this can fail:
//   - it throws: no state (see the guards above);
//   - it is not a plain object, or serializes to nothing at all (every field
//     undefined): no state, because only an object can be replayed;
//   - it is over the ceiling above: no state. A place is still a place without
//     one — the row keeps its name and the view is rebuilt at its defaults —
//     and losing the whole list to one fat state is not a trade worth making.
//
// The JSON round-trip does two jobs, and the second is the one that is easy to
// miss: it rejects what cannot be stored at all (a cyclic reference throws), and
// it keeps a COPY. A view goes on mutating its own state object after the
// recording; a row holding a reference to it would drift along with the view —
// and replaying a place would then take the reader to wherever the view happens
// to be NOW, which is the opposite of what a recorded place is for.
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
