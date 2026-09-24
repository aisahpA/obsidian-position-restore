import { MarkdownView, WorkspaceLeaf } from 'obsidian';

// Worst-case bound for the first-paint cover, only reached when no restore runs. Must
// outlive the whole covered phase — content-ready wait + settle + the pre-reveal quiet
// hold (SETTLE_HOLD_MAX_MS 1250ms from restore entry) — with margin, so a slow restore
// is never cut off mid-paint or mid-hold.
const COVER_SAFETY_MS = 2000;

// WorkspaceLeaf.containerEl is internal — absent from Obsidian's public typings.
function leafContainer(leaf: WorkspaceLeaf): HTMLElement {
	return (leaf as unknown as { containerEl: HTMLElement }).containerEl;
}

// Hides an open before its first paint. 'file-open' fires through a debounced
// (setTimeout 0) callback — after the view has already painted at the top — so the
// restore cover alone cannot hide that first frame. The leaf's persistent .view-content
// is reused by the incoming view, so hiding it here, synchronously with the open,
// covers the first paint; the restore reveals at the restored position, and a bounded
// safety timer guarantees the cover can never stick (background opens produce no
// file-open, and restore skips / link navigation never call the restore).
//
// Both reading opens (async render) and injected source opens (a new editor measures
// before its scroll lands) can paint the un-restored top, so both go through cover().
export class OpenCover {
	private pendingTimers: Map<WorkspaceLeaf, number> = new Map();

	isCovered(leaf: WorkspaceLeaf): boolean {
		return this.pendingTimers.has(leaf);
	}

	cover(leaf: WorkspaceLeaf): void {
		// A re-cover while already covered (replayed re-inject) must not start a second
		// reapplyCover loop — the running loop keeps covering until uncover(); only the
		// safety timer below is refreshed.
		const wasCovered = this.pendingTimers.has(leaf);
		this.coverLeaf(leaf);
		const existing = this.pendingTimers.get(leaf);
		if (existing)
			window.clearTimeout(existing);
		// uncover() owns removing the map entry, so the entry stays the single source of
		// truth for "covered" and uncover's early return stays correct.
		this.pendingTimers.set(leaf, window.setTimeout(() => {
			this.uncover(leaf);
		}, COVER_SAFETY_MS));

		// A brand-new leaf creates its .view-content only inside the incoming view's
		// constructor, which runs after this patch returns; a same-leaf switch can
		// REPLACE the covered node with the incoming view's own. Re-apply every frame
		// (ahead of paint) until the reveal, so any freshly built .view-content is
		// hidden before its first frame. Stops at the reveal or the safety timer — both
		// go through uncover().
		if (!wasCovered)
			window.requestAnimationFrame(() => this.reapplyCover(leaf));
	}

	uncover(leaf: WorkspaceLeaf): void {
		const pending = this.pendingTimers.get(leaf);
		if (!pending)
			return; // not covered: no timer to clear, no DOM to restore
		window.clearTimeout(pending);
		this.pendingTimers.delete(leaf);
		const vc = leafContainer(leaf).querySelector('.view-content');
		if (vc instanceof HTMLElement)
			vc.setCssStyles({ opacity: '' });
		leafContainer(leaf).setCssStyles({ opacity: '' });
		leafContainer(leaf).setCssStyles({ backgroundColor: '' });
	}

	// maskedRestore hides a restore under construction by setting the view's contentEl
	// opacity to 0 (its own restore cover). All contentEl cover manipulation is owned
	// here so restore paths never scatter raw style access: cover()/uncover() are the
	// leaf's first-paint cover, and the two methods below are the restore cover. Both
	// are keyed per leaf and revealed through their own cleanup paths.
	restoreCover(view: MarkdownView): void {
		view.contentEl.setCssStyles({ opacity: '0' });
	}

	// A superseded maskedRestore leaves contentEl hidden, because its finally only
	// clears while still current; this is called back at the start of the next restore
	// — before the first await — so the follow-up restore starts visible. It is also
	// the cleanup maskedRestore's finally runs when still current. Every restore branch
	// either re-applies this cover synchronously before paint or should show core's
	// already-applied state, so revealing here can never flash the un-restored top.
	revealRestoreCover(view: MarkdownView): void {
		view.contentEl.setCssStyles({ opacity: '' });
	}

	// Hides the open without exposing the theme's page background. Making
	// leaf.containerEl itself opacity:0 would render the whole leaf (and its content
	// card) transparent, revealing whatever the theme paints behind it — e.g. Soft
	// Paper's sapphire --tab-container-background. Only the inner .view-content is
	// hidden instead, so the card's own background stays visible; while that element
	// does not exist yet (a brand-new leaf), paint the container with the theme's note
	// background so the area reads as a blank note rather than the page behind it.
	// @returns true when the leaf's .view-content exists and is now covered;
	//          false when only the container background was painted.
	private coverLeaf(leaf: WorkspaceLeaf): boolean {
		const vc = leafContainer(leaf).querySelector('.view-content');
		if (vc instanceof HTMLElement) {
			vc.setCssStyles({ opacity: '0' });
			leafContainer(leaf).setCssStyles({ backgroundColor: '' });
			return true;
		}
		leafContainer(leaf).setCssStyles({ backgroundColor: 'var(--background-primary)' });
		return false;
	}

	// Catches the freshly built .view-content of a first open and the REPLACED one of a
	// same-leaf view swap — a replaced node is born unhidden, so "hidden once" is not
	// "hidden until the reveal". uncover() is the only exit.
	private reapplyCover(leaf: WorkspaceLeaf): void {
		if (!this.pendingTimers.has(leaf))
			return;
		this.coverLeaf(leaf);
		window.requestAnimationFrame(() => this.reapplyCover(leaf));
	}
}
