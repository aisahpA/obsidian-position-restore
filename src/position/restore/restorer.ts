import { App, FileView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { getScroller, nextPaint } from '@/shared/wait';
import { PositionState } from '@/position/state';
import { RestoreModes } from './modes';

// Restores a saved position after an open. The per-mode strategies (masked / glide /
// injected-source, and the shared anchor) live in ./modes, the source-mode pixel
// correction in ./pixels, pure view<->state helpers in ../capture/ephemeral, paint
// observation in ../../shared/wait, and the first-paint cover and cue in ../ui. All
// cross-phase coordination flags are owned by the shared PositionState.
export class Restorer {
	private app: App;
	private settings: PluginSettings;
	private state: PositionState;
	private store: PositionStore;
	private modes: RestoreModes;

	constructor(app: App, settings: PluginSettings, store: PositionStore, state: PositionState) {
		this.app = app;
		this.settings = settings;
		this.store = store;
		this.state = state;
		this.modes = new RestoreModes(settings, this.state);
	}

	// Markdown views delegate to restoreMarkdown; base views, whose record is a raw
	// scrollTop the scroll-capture listener saved, go through restoreFileViewScroll
	// (opt-in via recordBaseScroll). PDF never restores: native PDF.js history already
	// handles same-device positions, and a cross-device scrollTop doesn't fit this
	// device's viewport, so a second restorer would only fight the native one. Other
	// FileViews are never recorded at all.
	async restoreEphemeralState() {
		const fv = this.app.workspace.getActiveViewOfType(FileView);
		if (!fv?.file)
			return;

		if (fv instanceof MarkdownView) {
			await this.restoreMarkdown(fv);
			return;
		} 
		
		if (fv.getViewType() === 'bases' && this.settings.recordBaseScroll)
			await this.restoreFileViewScroll(fv);
		else
			// No restore: still drop any chip left by the previous file,
			// matching restoreMarkdown's open-time cue reset.
			this.state.cue.hide();
	}

	// Completes the restore of an open that never fired 'file-open' on the freshly
	// activated leaf — two cases, told apart by an injected marker:
	//
	//  1. Injected marker: a background open injected the position at setViewState time,
	//     but only first activation builds the deferred view and the active file is
	//     unchanged, so no 'file-open' follows.
	//  2. Unmarked same-file activation: reading/source-glide tabs never inject, but a
	//     same-file activation is guaranteed file-open-less ('file-open' fires only when
	//     the active FILE changes). Genuine opens fire their own 'file-open' and are
	//     never handled here, so there is no race with it.
	//
	// 'active-leaf-change' carries only the NEW leaf, so the previous active file comes
	// from state.lastActiveFilePath, slid synchronously below (pre-await). Deferred one
	// frame and re-resolved against the CURRENT active view, because exact-once is not
	// left to timer ordering — the genuine open's debounced 'file-open' (setTimeout(0))
	// is not guaranteed to run before this rAF. Unmarked branch: the pre-await slide
	// means a genuine open's new file never matches. Marked branch: if this runs first
	// it restores the current file through restoreOpen, whose inflight + dedup guards
	// make the genuine open's own 'file-open' a no-op.
	async completeInjectedRestore(leaf: WorkspaceLeaf | null) {
		if (!this.app.workspace.layoutReady)
			return;
		// Slid synchronously (pre-await) so the NEXT activation sees the correct
		// previous file even across rapid switches.
		const oldFilePath = this.state.lastActiveFilePath;
		const newFilePath = (leaf?.view as FileView | undefined)?.file?.path;
		this.state.lastActiveFilePath = newFilePath;
		await nextPaint();
		const fv = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!fv?.file)
			return;
		const leafId = this.state.leafId(fv.leaf);
		const filePath = fv.file.path;
		if (this.state.injectedOpenLeafIds.has(leafId)) {
			// Marker still present -> no file-open will consume it: run the injected
			// restore (settle under the still-up first-paint cover, then reveal + anchor)
			// via the shared pipeline.
			await this.restoreEphemeralState();
			return;
		}
		// Unmarked branch: a same-file activation of an unhandled leaf (its deferred view
		// was just built). Its own restore must run via the shared pipeline, which
		// handles the active leaf's anchor + dedup.
		if (oldFilePath !== filePath)
			return;
		if (this.state.handledLeafIdMap.get(leafId) === filePath)
			return;
		await this.restoreEphemeralState();
	}

	// restoreOpen owns the open bookkeeping (cue, covers, jumps, dedup, run token); this
	// only dispatches by view mode.
	private async restoreMarkdown(view: MarkdownView) {
		const filePath = view.file?.path;
		if (!filePath)
			return;

		await this.restoreOpen(view, filePath, async (isCurrent, injected, injectedSt) => {
			// An injected open was handed a SPECIFIC landing by the patch (the traversal
			// target's own entry position, or the file record as the fallback). Settling
			// to the store record instead would fight the line core actually applied:
			// after a cross-file history jump the two deliberately differ — the record is
			// where the reader had drifted to, the entry's landing is what the row
			// promised.
			const st = injectedSt ?? this.store.read(this.state.leafId(view.leaf), filePath);
			const mode = view.getMode();

			// Each branch owns its own no-record / default-position handling so the two
			// don't leak across modes. Injected opens FIRST: a history traversal injects
			// and covers regardless of the glide choice ("must land instantly"), so
			// dispatching it to glideRestore would run the glide under a first-paint
			// cover it never lifts, blanking the leaf for ~2s.
			if (mode === 'source') {
				if (!st && this.settings.defaultPosition === 'default')
					return;
				if (injected)
					await this.modes.restoreInjectedSource(view, st, isCurrent);
				else if (this.shouldGlideSource(st))
					await this.modes.glideRestore(view, st, isCurrent);
				else if (st)
					await this.modes.maskedRestoreSt(view, st, isCurrent);
				else
					await this.modes.maskedRestoreDefault(view, isCurrent);
				return;
			}

			if (mode === 'preview') {
				// Reading view renders from the top and never applies a default position —
				// with no record there is nothing to restore.
				if (!st)
					return;
				if (this.settings.readingRestoreMethod === 'glide' && (st.scroll ?? 0) > 0)
					await this.modes.glideRestore(view, st, isCurrent);
				else
					await this.modes.maskedRestoreSt(view, st, isCurrent);
			}
		});
	}

	// Scroll-only restore for bases views: their recordable state is one number, so
	// restoring means applying it once the view has a scroller (landBaseScroll). No
	// cover here — 'file-open' fires after the first paint, so a cover applied this late
	// could only add a blank flash on top of the jump.
	private async restoreFileViewScroll(view: FileView) {
		const filePath = view.file?.path;
		if (!filePath)
			return;

		await this.restoreOpen(view, filePath, async (isCurrent) => {
			await this.landBaseScroll(view, filePath, isCurrent);
		});
	}

	// Shared pipeline for markdown and bases opens: reset the cue chip, lift any stale
	// masked-restore cover, consume a pending open-kind jump, dedup leaf+file, then
	// bracket the dispatch body in the restoreStarted/restoreEnded run token — every
	// await inside the body re-checks the returned isCurrent before touching the view.
	// Returns without running the body when the open needs no restore (jump or dedup):
	// skipRestoreAndAnchor has already re-anchored the recording baselines.
	private async restoreOpen(
		view: FileView,
		filePath: string,
		body: (isCurrent: () => boolean, injected: boolean, injectedSt: EphemeralState | undefined) => Promise<void>,
	) {
		const isMarkdown = view instanceof MarkdownView;
		const leafId = this.state.leafId(view.leaf);

		// A restore for this exact leaf+file is already in flight (a 'file-open' landing
		// while the active-leaf-change completion runs the settle, or vice versa). The
		// running restore owns the reveal: skip entirely — no supersede, no reveal (which
		// would lift the first-paint cover mid-settle), no re-anchor. A DIFFERENT file on
		// the same leaf still supersedes below.
		const inflight = this.state.inFlightRestoreLeafRuns.get(leafId);
		if (inflight && inflight.filePath === filePath)
			return;

		// Consumed before the reveal gating and the dedup check so a dedup hit (mere tab
		// activation) still clears the marker and a later re-open restores again. Keyed
		// by leaf id — with the same file in two tabs each tab's marker is consumed by
		// its own file-open (see injectedOpenLeafPaths).
		const injected = isMarkdown && this.state.injectedOpenLeafIds.delete(leafId);
		// The landing that injected open was handed, consumed with its marker (a later
		// duplicate file-open reads no marker, so it must not read a landing either).
		const injectedSt = injected ? this.state.injectedLeafStates.get(leafId) : undefined;
		if (injected)
			this.state.injectedLeafStates.delete(leafId);

		// Lift any stale restore cover; the dispatch body re-covers as needed. An
		// injected open whose leaf first-paint cover is still up must NOT be revealed
		// here: view.contentEl and the leaf cover's .view-content are the SAME element,
		// so clearing contentEl lifts the first-paint cover before the settle has run —
		// the pre-settle pixels become the visible flicker. The covered branch of
		// restoreInjectedSource owns that reveal.
		if (isMarkdown && !(injected && this.state.cover.isCovered(view.leaf)))
			this.state.cover.revealRestoreCover(view);

		// OpenKind jumps (anchorLink/startPlainLink/callerTarget) are precise native
		// jumps — core already opened at its own target and injection was skipped. Never
		// restore; just re-anchor change detection so the landing itself isn't recorded.
		const openKind = this.state.pendingOpenKind.get(view.leaf);
		if (openKind) {
			this.state.pendingOpenKind.delete(view.leaf);
			// A genuine open transition: no new cue will show, so drop any chip the
			// previous file left. Not a mere re-activation, so hiding is safe here.
			this.state.cue.hide();
			// The landing is absorbed via the anchor the patcher armed at setViewState
			// time (see injectEphemeralStateOnOpen) — arming here too would MISS
			// same-file search jumps, which never fire 'file-open'.
			this.skipRestoreAndAnchor(view, filePath);
			return;
		}

		// Dedup: Obsidian fires 'file-open' repeatedly (pane switching, workspace
		// restore, mere tab activation). Restore each leaf+file combination only once,
		// otherwise the cursor keeps jumping back to the saved position. Injected opens
		// bypass the dedup: their file-open must run restoreInjectedSource (settle +
		// cover reveal) even when the pair is already handled — the patcher records
		// handled pairs at injection time, so a replayed open would otherwise be deduped
		// into skipRestoreAndAnchor, which lifts the cover before the settle.
		if (!injected && this.hasOpenedLeafPath(view.leaf, filePath)) {
			// Mere re-activation (pane switching, duplicate 'file-open' events — frequent
			// on Android). Leave an already-showing cue alone: its own auto-hide timer
			// retires it. Hiding here kills a freshly shown chip the instant a duplicate
			// event lands after the restore anchored — the breadcrumb "flashes by".
			this.skipRestoreAndAnchor(view, filePath);
			return;
		}

		// A real restore supersedes any chip left by the previous file's cue.
		this.state.cue.hide();

		// Cancel any restore still in flight: rapid file switching reuses the same view
		// instance, so a stale restore loop would keep applying the previous file's
		// position to the new note — random final positions, flicker, and corrupted
		// records via the polling loop.
		//
		// Supersession is scoped per LEAF, never globally: opening Y in pane B while pane
		// A's masked restore is mid-cover must not invalidate pane A, whose cover has no
		// safety timer — it would stay at opacity 0 with its position never restored.
		const run = this.state.beginLeafRestore(leafId, filePath);
		const isCurrent = () => this.state.isCurrentLeafRestore(leafId, run)
			&& view.file?.path === filePath;

		this.state.restoreStarted();
		try {
			this.state.lastEphemeralState = undefined;
			this.state.lastLoadedFilePath = filePath;
			await body(isCurrent, injected, injectedSt);
		} finally {
			// Only the winning restore removes its entry: a superseded run no longer
			// matches, so it must not drop the newer entry for the same leaf.
			const cur = this.state.inFlightRestoreLeafRuns.get(leafId);
			if (cur && cur.run === run)
				this.state.inFlightRestoreLeafRuns.delete(leafId);
			this.state.restoreEnded();
		}
	}

	// Read the saved pixels and land them once the bases view has a scroller, which is
	// built asynchronously (bounded wait). Once found it stays: `.bases-view` is the
	// view's own root, and re-renders only replace the card content inside it. Bases
	// loads rows lazily, so the document can grow after a first landing — keep
	// re-applying on drift until the value sticks (bounded, and throttled so a value the
	// content cannot reach does not churn every frame).
	private async landBaseScroll(view: FileView, filePath: string, isCurrent: () => boolean) {
		const st = this.store.read(this.state.leafId(view.leaf), filePath);
		const scroll = st?.scroll ?? 0;
		if (scroll <= 0)
			return;

		const findDeadline = Date.now() + 500;
		let scroller: HTMLElement | null = null;
		while (isCurrent() && !scroller && Date.now() < findDeadline) {
			scroller = getScroller(view);
			if (!scroller)
				await nextPaint();
		}

		const landDeadline = Date.now() + 2000;
		let lastApply = 0;
		let stableFrames = 0;
		while (isCurrent() && scroller && Date.now() < landDeadline) {
			if (Math.abs(scroller.scrollTop - scroll) <= 1) {
				if (++stableFrames >= 3)
					break;
			} else {
				stableFrames = 0;
				if (Date.now() - lastApply >= 100) {
					scroller.scrollTop = scroll;
					lastApply = Date.now();
				}
			}
			await nextPaint();
		}
	}

	// Re-anchor change detection to the active file and clear the polling baseline, so
	// later user movement — not the landing spot — is the next recorded change; also
	// lift any cover still applied to this leaf.
	// Two call sites: a dedup hit (nothing to re-apply; clearing the baseline avoids the
	// poll mis-comparing against a stale record when Obsidian's own scroll restoration
	// has slipped) and open-kind jumps (core already opened at its own precise target;
	// anchoring to the landing would record the jump itself).
	private skipRestoreAndAnchor(view: FileView, filePath: string) {
		this.state.lastEphemeralState = undefined;
		this.state.lastLoadedFilePath = filePath;
		// Start the post-open reflow guard from here too: dedup'd re-activations and
		// open-kind jumps land via Obsidian's own pipeline and can reflow like a restore.
		this.state.lastAnchorAt = Date.now();
		// Lift any leaf-level cover AND clear a stale maskedRestore cover on
		// view.contentEl — a superseded restore may have left it hidden.
		this.state.cover.uncover(view.leaf);
	}

	// Same predicate as the source branch of restoreEphemeralState. The type predicate is
	// load-bearing: the caller dispatches to glideRestore on a true result, and
	// glideRestore needs a defined record.
	private shouldGlideSource(st: EphemeralState | undefined): st is EphemeralState {
		return this.settings.sourceRestoreMethod === 'glide'
			&& !!st && (st.scroll ?? 0) > 0;
	}

	private hasOpenedLeafPath(leaf: WorkspaceLeaf, filePath: string): boolean {
		const leafId = this.state.leafId(leaf);
		const existPath = this.state.handledLeafIdMap.get(leafId);
		if (existPath) {
			if (existPath === filePath)
				return true;
			this.state.handledLeafIdMap.set(leafId, filePath);
			return false;
		}
		// A leaf with no entry is a fresh open — never skip its restore. Only the leaf id
		// is recorded, never view.file: during a rapid switch that already points at a
		// file whose restore hasn't run yet (setViewState swaps view.file before the
		// debounced 'file-open'), which would strand it at the top.
		this.pruneStaleLeafIds();
		this.state.handledLeafIdMap.set(leafId, filePath);
		return false;
	}

	// Prune handled entries for leaves that are no longer open. Only leaf ids (stable per
	// leaf instance) are read — safe even mid-switch, unlike view.file. Iterates ALL
	// leaves, not just markdown ones: pdf/image leaves hold dedup entries too, and
	// pruning theirs would re-scroll the file on every tab activation. Runs on fresh
	// opens (dedup check) AND at persist points (storePositionData): closing a leaf has
	// no dedicated event, so without the persist-side call dead records would reach the
	// overlay snapshot. The single workspace scan is shared with the store's prune.
	public pruneStaleLeafIds(): void {
		const liveIds = new Set<string>();
		// Block body on purpose: this callback MUST return undefined. Obsidian's iterate
		// helpers treat the callback result as an early-interrupt signal (documented on
		// iterateRefs), so an expression body returning the Set aborts the scan after a
		// few leaves — liveIds under-collects and live entries get wrongly pruned
		// (debugged 2026-09: 3 of 16 leaves visited).
		this.app.workspace.iterateAllLeaves((leaf) => {
			liveIds.add(this.state.leafId(leaf));
		});
		for (const id of this.state.handledLeafIdMap.keys())
			if (!liveIds.has(id))
				this.state.handledLeafIdMap.delete(id);
		// Also drop injected markers of closed leaves (the background open whose
		// file-open never fired), for the same reason.
		for (const id of this.state.injectedOpenLeafIds)
			if (!liveIds.has(id))
				this.state.injectedOpenLeafIds.delete(id);
		for (const id of this.state.injectedLeafStates.keys())
			if (!liveIds.has(id))
				this.state.injectedLeafStates.delete(id);
		for (const leaf of this.state.pendingOpenKind.keys())
			if (!liveIds.has(this.state.leafId(leaf)))
				this.state.pendingOpenKind.delete(leaf);
		this.store.pruneDeadLeaves(liveIds);
	}
}
