import { App, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { NavEntryState } from './types';
import { PositionState, LANDING_ABSORB_MS } from './position-state';
import { readNavEntryState } from './ephemeral';

// The recording surface the outline capture needs from NavHistory.
export interface OutlineCaptureHost {
	state: PositionState;
	refreshTop(path: string, leafId: string, st: NavEntryState): void;
	recordOpen(path: string, leafId: string, opts: { key: string }): void;
}

// Reading-mode outline clicks are invisible to every other
// recording path: core resolves an item click into setActiveLeaf +
// view.setEphemeralState({ line }) — no openLinkText, no setViewState,
// and preview has no cursor for the poll's teleport — so nothing pushes.
// Source mode is recorded here TOO: the capture itself pushes the keyed
// outline entry, and the landing-absorb window it arms gates the
// imminent cursor jump on both teleport paths (selection event / poll),
// so one click pushes exactly one entry (no teleport double-record).
// This capture listener runs before core's handlers (capture phase on
// the workspace root), which is what lets refreshTop see the exact
// pre-click position. Every resolution step degrades silently: unknown
// DOM, missing outline view, unresolvable target leaf — the hook does
// nothing and the standard pipeline covers the not-open case on its own.
export function installOutlineCapture(
	app: App,
	host: OutlineCaptureHost,
	registerCleanup: (fn: () => void) => void,
): void {
	const onClick = (ev: MouseEvent) => {
		if (!(ev.target instanceof HTMLElement))
			return;
		// Collapse arrows preventDefault core's jump handler downstream, but
		// this capture listener runs before that happens — exclude them here.
		if (ev.target.closest('.collapse-icon'))
			return;
		// Outline tree items only (the clickable selfEl): excludes the
		// panel's search box, toolbar buttons, and every non-outline click.
		const selfEl = ev.target.closest('.tree-item-self.is-clickable');
		const contentEl = selfEl?.closest('.workspace-leaf-content[data-type="outline"]');
		if (!selfEl || !contentEl)
			return;
		// The outline leaf owning the clicked panel (a view's containerEl IS
		// the workspace-leaf-content element).
		let outlineLeaf: WorkspaceLeaf | undefined;
		app.workspace.iterateAllLeaves((leaf) => {
			if (!outlineLeaf && leaf.view.getViewType() === 'outline'
				&& leaf.view.containerEl === contentEl)
				outlineLeaf = leaf;
		});
		const outlineFile = (outlineLeaf?.view as unknown as { file?: unknown })?.file;
		if (!(outlineFile instanceof TFile))
			return;
		// The markdown leaf the jump will land in — mirrors core's
		// findCorrespondingLeaf: linked-pane group first, else the active
		// markdown view when it tracks the same file. No match means core
		// opens the file fresh (new leaf) — that open records through the
		// setViewState pipeline already.
		// (leaf.group is runtime API absent from the public typings — same
		// cast family as isMainAreaLeaf's containerEl.)
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
			// Core's findCorrespondingLeaf resolves through getActiveFileView,
			// NOT getActiveViewOfType: the click's pointerdown focuses the
			// outline panel's leaf FIRST (the capture phase sees activeLeaf =
			// the outline view), and getActiveViewOfType — strictly the
			// focused leaf — returns null there, so the jump would never
			// record. getActiveFileView falls back to the most recently
			// active FILE view. (Runtime API absent from the public typings —
			// same cast family as isMainAreaLeaf's containerEl.)
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
			host.refreshTop(view.file.path, leafId, fromSt);
		// Key = heading text (core renders the heading as the item's inner
		// text): repeated clicks to one heading dedup, different headings
		// push — the anchor-link key semantics. No text → no key → skip
		// (a keyless entry would wrongly absorb every later click).
		const heading = selfEl.querySelector('.tree-item-inner')?.textContent?.trim();
		if (heading) {
			host.recordOpen(view.file.path, leafId, { key: `outline:${heading}` });
			// Arm the landing absorb (same contract as open-kind jumps):
			// core resolves the jump asynchronously, and the poll/scroll
			// capture must stay absorbed until it settles — the settled read
			// then becomes this entry's precise landing (Sampler
			// settle-capture). Not armed when nothing was recorded (no
			// heading text): the settle-capture would overwrite an unrelated
			// top entry.
			host.state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;
		}
	};
	app.workspace.containerEl.addEventListener('click', onClick, { capture: true });
	registerCleanup(() =>
		app.workspace.containerEl.removeEventListener('click', onClick, { capture: true }));
}
