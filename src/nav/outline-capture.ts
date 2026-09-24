import { App, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { NavEntryState } from '@/types';
import { PositionState, LANDING_ABSORB_MS } from '@/position/state';
import { readNavEntryState } from '@/position/capture/ephemeral';

// The funnel's own two calls, stated here so this module depends on nothing else.
export interface OutlineCaptureHost {
	state: PositionState;
	leave(path: string, leafId: string, st: NavEntryState): void;
	recordOpen(path: string, leafId: string, opts: { key: string }): void;
}

// Reading-mode outline clicks are invisible to every other recording path:
// core resolves an item click into setActiveLeaf + setEphemeralState({line})
// — no openLinkText, no setViewState, and preview has no cursor for the
// poll's teleport. Source mode is recorded here TOO: the capture pushes the
// keyed entry, and the landing-absorb window it arms gates the imminent
// cursor jump, so one click pushes exactly one entry.
// The listener runs in the capture phase on the workspace root, i.e. before
// core's handlers — that's what lets refreshTop see the pre-click position.
// Every resolution step degrades silently: unknown DOM, missing outline,
// unresolvable target leaf → the standard pipeline covers the rest.
export function installOutlineCapture(
	app: App,
	host: OutlineCaptureHost,
	registerCleanup: (fn: () => void) => void,
): void {
	const onClick = (ev: MouseEvent) => {
		if (!(ev.target instanceof HTMLElement))
			return;
		// Collapse arrows preventDefault core's jump downstream, but this
		// listener runs before that — exclude them here.
		if (ev.target.closest('.collapse-icon'))
			return;
		// Outline tree items only: excludes the panel's search box and toolbar.
		const selfEl = ev.target.closest('.tree-item-self.is-clickable');
		const contentEl = selfEl?.closest('.workspace-leaf-content[data-type="outline"]');
		if (!selfEl || !contentEl)
			return;
		// A view's containerEl IS the workspace-leaf-content element.
		let outlineLeaf: WorkspaceLeaf | undefined;
		app.workspace.iterateAllLeaves((leaf) => {
			if (!outlineLeaf && leaf.view.getViewType() === 'outline'
				&& leaf.view.containerEl === contentEl)
				outlineLeaf = leaf;
		});
		const outlineFile = (outlineLeaf?.view as unknown as { file?: unknown })?.file;
		if (!(outlineFile instanceof TFile))
			return;
		// The leaf the jump lands in — mirrors core's findCorrespondingLeaf:
		// linked-pane group first, else the active markdown view tracking the
		// same file. No match means core opens the file fresh; that open
		// records through the setViewState pipeline already.
		// (leaf.group is runtime API absent from the public typings.)
		const group = (outlineLeaf as unknown as { group?: string } | undefined)?.group;
		let view: MarkdownView | undefined;
		if (group) {
			for (const leaf of app.workspace.getGroupLeaves(group)) {
				const v = leaf.view;
				if (v instanceof MarkdownView && v.file === outlineFile) {
					view = v;
					break;
				}
			}
		} else {
			// Must resolve through getActiveFileView, NOT getActiveViewOfType:
			// the click's pointerdown focuses the outline leaf FIRST, so the
			// strictly-focused getActiveViewOfType returns null there and the
			// jump would never record. getActiveFileView falls back to the most
			// recently active FILE view.
			const active = (app.workspace as unknown as {
				getActiveFileView?: () => unknown;
			}).getActiveFileView?.();
			if (active instanceof MarkdownView && active.file === outlineFile)
				view = active;
		}
		if (!view || !view.file)
			return;
		// "Update on leave" with the exact pre-click position (nothing has
		// scrolled yet) so a later back lands where the user actually was.
		const leafId = host.state.leafId(view.leaf);
		const fromSt = readNavEntryState(view);
		if (fromSt)
			host.leave(view.file.path, leafId, fromSt);
		// Key = heading text: repeated clicks to one heading dedup, different
		// headings push — the anchor-link key semantics. No text → no key →
		// skip (a keyless entry would wrongly absorb every later click).
		const heading = selfEl.querySelector('.tree-item-inner')?.textContent?.trim();
		if (heading) {
			host.recordOpen(view.file.path, leafId, { key: `outline:${heading}` });
			// Arm the landing absorb (same contract as open-kind jumps): core
			// resolves the jump asynchronously, and capture must stay absorbed
			// until it settles — the settled read becomes this entry's precise
			// landing. Not armed when nothing was recorded: the settle-capture
			// would overwrite an unrelated top entry.
			host.state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;
		}
	};
	app.workspace.containerEl.addEventListener('click', onClick, { capture: true });
	registerCleanup(() =>
		app.workspace.containerEl.removeEventListener('click', onClick, { capture: true }));
}
