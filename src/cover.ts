import { MarkdownView, WorkspaceLeaf } from 'obsidian';

// Worst-case bound for the first-paint cover; only fires if a restore never
// runs or completes. Larger than the sum of the two waits above so a slow
// restore is never cut off mid-paint (which would flash the un-restored
// top).
const COVER_SAFETY_MS = 1200;

// Hides an open before its first paint. 'file-open' fires through a
// debounced (setTimeout 0) callback — after the view has already painted at
// the top — so the restore cover alone can't hide that first frame. The
// leaf's persistent .view-content is reused by the incoming view, so hiding
// it here (synchronously with the open) covers the first paint; the restore
// reveals at the restored position, and a bounded safety timer guarantees
// the cover can never stick (background opens produce no file-open, and
// restore skips/link navigation never call the restore).
//
// Both reading opens (async render) and injected source opens (a new editor
// measures before its scroll lands) can paint the un-restored top, so both
// go through cover().
export class OpenCover {
	private pendingTimers: Map<WorkspaceLeaf, number> = new Map();

	isCovered(leaf: WorkspaceLeaf): boolean {
		return this.pendingTimers.has(leaf);
	}

	cover(leaf: WorkspaceLeaf): void {
		this.coverLeaf(leaf);
		const existing = this.pendingTimers.get(leaf);
		if (existing)
			window.clearTimeout(existing);
		// Safety timer: lifts the cover if a restore never runs. uncover()
		// owns removing the map entry, so the entry stays the single source
		// of truth for "covered" — uncover's early-return stays correct.
		this.pendingTimers.set(leaf, window.setTimeout(() => {
			this.uncover(leaf);
		}, COVER_SAFETY_MS));

		// A brand-new leaf creates its .view-content only inside the incoming
		// view's constructor, which runs after this patch returns. Keep
		// re-applying the cover on every frame (ahead of paint) so the freshly
		// built .view-content is hidden before its first frame can show the
		// un-restored top. Stops once the restore reveals (or the safety timer
		// lifted) the cover — both go through uncover().
		requestAnimationFrame(() => this.reapplyCover(leaf));
	}

	uncover(leaf: WorkspaceLeaf): void {
		const pending = this.pendingTimers.get(leaf);
		if (!pending)
			return; // not covered: no timer to clear, no DOM to restore
		window.clearTimeout(pending);
		this.pendingTimers.delete(leaf);
		// @ts-ignore no-official-API
		const vc = leaf.containerEl.querySelector('.view-content');
		if (vc instanceof HTMLElement)
			vc.style.opacity = '';
		// @ts-ignore no-official-API
		leaf.containerEl.style.opacity = '';
		// @ts-ignore no-official-API
		leaf.containerEl.style.backgroundColor = '';
	}

	// maskedRestore hides a restore under construction by setting the view's
	// contentEl opacity to 0 (its own restore cover). All contentEl cover
	// manipulation is owned here so restore paths never scatter raw style
	// access: cover()/uncover() are the leaf's first-paint cover, and the two
	// methods below are the restore cover. Both are keyed per leaf and revealed
	// through their own cleanup paths.
	restoreCover(view: MarkdownView): void {
		view.contentEl.style.opacity = '0';
	}

	// Lift a restore cover. A superseded maskedRestore leaves contentEl hidden
	// because its finally only clears while still current; this is called back
	// at the start of the next restore — before the first await — so the
	// follow-up restore starts visible. It is also the cleanup maskedRestore's
	// finally runs when still current. Every restore branch either re-applies
	// this cover synchronously before paint (maskedRestore) or should show
	// core's already-applied state, so revealing here can never flash the
	// un-restored top.
	revealRestoreCover(view: MarkdownView): void {
		view.contentEl.style.opacity = '';
	}

	// Hides the open without exposing the theme's page background. Making
	// leaf.containerEl itself opacity:0 would render the whole leaf (and its
	// content card) transparent, revealing whatever the theme paints behind the
	// leaf — e.g. Soft Paper's sapphire --tab-container-background. Instead only
	// the inner .view-content (the actual content) is hidden, so the card's own
	// background stays visible; while that element does not exist yet (a
	// brand-new leaf), paint the leaf container with the theme's note background
	// so the area reads as a blank note rather than the page behind it.
	// @returns true when the leaf's .view-content exists and is now covered;
	//          false when only the container background was painted (vc not
	//          built yet).
	private coverLeaf(leaf: WorkspaceLeaf): boolean {
		// @ts-ignore no-official-API
		const vc = leaf.containerEl.querySelector('.view-content');
		if (vc instanceof HTMLElement) {
			vc.style.opacity = '0';
			// @ts-ignore no-official-API
			leaf.containerEl.style.backgroundColor = '';
			return true;
		}
		// @ts-ignore no-official-API
		leaf.containerEl.style.backgroundColor = 'var(--background-primary)';
		return false;
	}

	// Re-applies the pre-paint cover on every frame while an open is still
	// covered. Catches the freshly built .view-content of a first open so no
	// frame of the un-restored top is ever shown. Stops as soon as the cover
	// is lifted (the restore reveal or the safety timer), both of which go
	// through uncover().
	private reapplyCover(leaf: WorkspaceLeaf): void {
		if (!this.pendingTimers.has(leaf))
			return;
		// .view-content now exists and is hidden: only uncover() can clear it,
		// so per-frame re-application is redundant — stop the loop instead of
		// burning a DOM query per frame until the reveal.
		if (this.coverLeaf(leaf))
			return;
		requestAnimationFrame(() => this.reapplyCover(leaf));
	}
}
