import { App, FileView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { CursorPositionDatabase } from './database';
import { getScroller, nextPaint } from './wait';
import { PositionState } from './position-state';
import { RestoreModes } from './restore-modes';

// Restores a saved position after an open. The per-mode restore strategies
// (masked / glide / injected-source, and the shared anchor) live in
// ./restore-modes, the source-mode pixel correction in ./pixels, pure
// view<->state helpers in ./ephemeral, paint/render observation in ./wait,
// and the first-paint cover and cue in ./state (via OpenCover / RestoreCue).
// All cross-phase coordination flags are owned by the shared PositionState
// this class takes.
export class Restorer {
	private app: App;
	private database: CursorPositionDatabase;
	private settings: PluginSettings;
	private state: PositionState;
	private modes: RestoreModes;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings, state: PositionState) {
		this.app = app;
		this.database = database;
		this.settings = settings;
		this.state = state;
		this.modes = new RestoreModes(settings, state);
	}

	// Dispatcher for restore. Markdown views delegate to restoreMarkdown;
	// base views whose scroll the scroll-capture listener records as raw
	// scrollTop pixels go through restoreFileViewScroll, a scroll-only
	// restore — opt-in via recordBaseScroll. PDF never restores: native
	// PDF.js history already handles same-device PDF positions, and a
	// cross-device scrollTop doesn't fit this device's viewport, so a second
	// restorer would only fight the native one. Other FileViews (image...)
	// are never recorded at all.
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

	// Markdown restore body: the shared restoreOpen pipeline owns the open
	// bookkeeping (cue, covers, jumps, dedup, run token); this only dispatches
	// by view mode — glideRestore (show the top, glide to the saved line),
	// restoreInjectedSource (source open whose state was injected into
	// setViewState), or maskedRestore (source default positions / source
	// fallbacks).
	private async restoreMarkdown(view: MarkdownView) {
		const filePath = view.file?.path;
		if (!filePath)
			return;

		await this.restoreOpen(view, filePath, async (isCurrent, injected) => {
			const st = this.database.db[filePath];
			const mode = view.getMode();

			// Dispatch by view mode; each branch owns its own no-record /
			// default-position handling so the two don't leak across modes.
			if (mode === 'source') {
				if (!st && this.settings.defaultPosition === 'default')
					return;
				if (this.shouldGlideSource(st))
					await this.modes.glideRestore(view, st, isCurrent);
				else if (injected)
					await this.modes.restoreInjectedSource(view, st, isCurrent);
				else if (st)
					await this.modes.maskedRestoreSt(view, st, isCurrent);
				else
					await this.modes.maskedRestoreDefault(view, isCurrent);
				return;
			}

			if (mode === 'preview') {
				// Reading view renders from the top and never applies a default
				// position — with no record there is nothing to restore.
				if (!st)
					return;
				if (this.settings.readingRestoreMethod === 'glide' && (st.scroll ?? 0) > 0)
					await this.modes.glideRestore(view, st, isCurrent);
				else
					await this.modes.maskedRestoreSt(view, st, isCurrent);
			}
		});
	}

	// Scroll-only restore for bases views. Their recordable state is a single
	// number — the raw scroller scrollTop the scroll-capture listener saved —
	// so restoring means applying that value once the view has a scroller
	// (landBaseScroll). No cover here: 'file-open' fires after the first
	// paint, so a cover applied this late could only add a blank flash on top
	// of the jump; the restore simply lands as soon as the scroller exists.
	private async restoreFileViewScroll(view: FileView) {
		const filePath = view.file?.path;
		if (!filePath)
			return;

		await this.restoreOpen(view, filePath, async (isCurrent) => {
			await this.landBaseScroll(view, filePath, isCurrent);
		});
	}

	// Shared restore pipeline for markdown and bases opens. Both need the
	// same sequence: reset the cue chip, lift any stale masked-restore cover
	// (markdown only — bases restores never cover), consume a pending
	// open-kind jump, dedup leaf+file, then bracket the dispatch body in the
	// restoreStarted/restoreEnded run token — every await inside the body
	// re-checks the returned isCurrent before touching the view. Returns
	// without running the body when the open needs no restore (jump or dedup):
	// skipRestoreAndAnchor has already re-anchored the recording baselines.
	private async restoreOpen(
		view: FileView,
		filePath: string,
		body: (isCurrent: () => boolean, injected: boolean) => Promise<void>,
	) {
		const isMarkdown = view instanceof MarkdownView;

		// Consumed before the reveal gating and the dedup check so a dedup
		// hit (mere tab activation) still clears the marker and a later
		// re-open of the same file restores again.
		const injected = isMarkdown && this.state.injectedOpenPaths.delete(filePath);

		// Lift any stale restore cover left by a superseded restore; the
		// dispatch body re-covers as needed. Bases restores never cover. An
		// injected open whose leaf first-paint cover is still up must NOT be
		// revealed here: view.contentEl and the leaf cover's .view-content
		// are the SAME element, so clearing contentEl lifts the first-paint
		// cover before the settle has run — the pre-settle pixels become the
		// visible flicker. The covered branch of restoreInjectedSource owns
		// that reveal.
		if (isMarkdown && !(injected && this.state.cover.isCovered(view.leaf)))
			this.state.cover.revealRestoreCover(view);

		// OpenKind jumps (anchorLink/startPlainLink/callerTarget): these are
		// precise native jumps — core already opened at its own target/start
		// and injection was skipped. Never restore; just re-anchor change
		// detection so the landing itself isn't recorded and only later user
		// movement is.
		const openKind = this.state.pendingOpenKind.get(view.leaf);
		if (openKind) {
			this.state.pendingOpenKind.delete(view.leaf);
			// A genuine open transition (link/caller jump): no new cue will
			// show, so drop any chip the previous file left. This is not a
			// mere re-activation, so hiding is safe here.
			this.state.cue.hide();
			this.skipRestoreAndAnchor(view, filePath);
			return;
		}

		// Source-mode markdown open whose saved position was injected into
		// setViewState by injectEphemeralStateOnOpen: core already applied it,
		// so the body re-anchors only. (Consumed above, before the reveal
		// gating, so a dedup hit still cleared the marker.)

		// Dedup: Obsidian fires 'file-open' repeatedly (pane switching,
		// workspace restore, mere tab activation). Restore each leaf+file
		// combination only once, otherwise the cursor would keep jumping back
		// to the saved position.
		if (this.hasOpenedLeafPath(view.leaf, filePath)) {
			// Mere re-activation of an already-restored leaf+file (pane
			// switching, workspace restore, duplicate 'file-open' events —
			// frequent on Android). Leave an already-showing cue alone: its
			// own auto-hide timer retires it. Hiding here killed a freshly
			// shown chip the instant a duplicate event landed after the
			// restore anchored — the breadcrumb "flashed by".
			this.skipRestoreAndAnchor(view, filePath);
			return;
		}

		// A real restore supersedes any chip left by the previous file's cue.
		this.state.cue.hide();

		// Cancel any restore still in flight: rapid file switching reuses the
		// same view instance, so a stale restore loop would keep applying the
		// previous file's position to the new note — random final positions,
		// flicker, and corrupted records via the polling loop.
		const run = ++this.state.restoreRun;
		const isCurrent = () => run === this.state.restoreRun && view.file?.path === filePath;

		this.state.restoreStarted();
		try {
			this.state.lastEphemeralState = undefined;
			this.state.lastLoadedFilePath = filePath;
			await body(isCurrent, injected);
		} finally {
			this.state.restoreEnded();
		}
	}

	// Read the saved pixels and land them once the bases view has a scroller.
	// The view builds its DOM asynchronously, so the scroller may not exist
	// yet; bounded wait. Once found it stays: `.bases-view` is the view's own
	// root container, and re-renders only replace the card content inside it.
	// Bases loads rows lazily, which can grow the document after a first
	// landing, so keep re-applying on drift until the value sticks (bounded);
	// re-applies are throttled so a value the content can't reach yet (or
	// ever) doesn't churn every frame.
	private async landBaseScroll(view: FileView, filePath: string, isCurrent: () => boolean) {
		const scroll = this.database.db[filePath]?.scroll ?? 0;
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

	// Skip restoring the saved position for this open. Re-anchor change
	// detection to the active file (lastLoadedFilePath) and clear the polling
	// baseline (lastEphemeralState) so later user movement — not the landing
	// spot — is the next recorded change; also lift any cover still applied
	// to this leaf.
	// Two call sites share this path:
	//  - dedup hit: nothing to re-apply; clearing the baseline avoids the
	//    polling loop mis-comparing against a stale record when Obsidian's
	//    own scroll restoration has slipped, which would otherwise overwrite
	//    the saved position with the landing spot.
	//  - openKind jumps (anchorLink/startPlainLink/callerTarget): core already opened at
	//    its own precise target; anchoring to the landing spot would otherwise
	//    record the jump itself.
	private skipRestoreAndAnchor(view: FileView, filePath: string) {
		this.state.lastEphemeralState = undefined;
		this.state.lastLoadedFilePath = filePath;
		// Start the post-open reflow guard window from here too: dedup'd
		// re-activations and open-kind jumps land via Obsidian's own pipeline
		// and can reflow just like a real restore.
		this.state.lastAnchorAt = Date.now();
		// Lift any leaf-level cover AND clear a stale maskedRestore cover on
		// view.contentEl — a superseded restore may have left it hidden.
		this.state.cover.uncover(view.leaf);
	}

	// A source open with a saved scroll is handled by glideRestore, which
	// animates from the top to the saved line, so nothing to inject. Same
	// predicate as the source branch of restoreEphemeralState.
	private shouldGlideSource(st: EphemeralState | undefined): boolean {
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
		// A leaf with no entry is a fresh open — never skip its restore. The old
		// code snapshotted every open leaf's *current* view.file here, but during
		// a rapid file switch that can already point at a file whose restore
		// hasn't run yet (setViewState swaps view.file before the debounced
		// 'file-open'), wrongly marking it handled and stranding it at the top.
		// Instead only record this leaf, and drop entries for closed leaves so a
		// reused leaf id can't wrongly dedup a later open.
		this.pruneStaleLeafIds();
		this.state.handledLeafIdMap.set(leafId, filePath);
		return false;
	}

	// Prune handled entries for leaves that are no longer open. Only leaf ids
	// (stable per leaf instance) are read — safe even mid-switch, unlike
	// view.file, which flips to the new file before 'file-open' fires.
	// Iterates ALL leaves, not just markdown ones: pdf/image leaves hold
	// dedup entries too, and pruning theirs would re-scroll the file on every
	// tab activation.
	private pruneStaleLeafIds(): void {
		const liveIds = new Set<string>();
		// Block body on purpose: this callback MUST return undefined.
		// Obsidian's iterate helpers treat the callback result as an
		// early-interrupt signal (documented on iterateRefs), so an
		// expression body returning the Set aborts the scan after a few
		// leaves — liveIds under-collects and live entries get wrongly
		// pruned (debugged 2026-09: 3 of 16 leaves visited).
		this.app.workspace.iterateAllLeaves((leaf) => {
			liveIds.add(this.state.leafId(leaf));
		});
		for (const id of this.state.handledLeafIdMap.keys())
			if (!liveIds.has(id))
				this.state.handledLeafIdMap.delete(id);
		// Also drop pending open-kind markers of closed leaves so the map
		// can't retain WorkspaceLeaf references forever.
		for (const leaf of this.state.pendingOpenKind.keys())
			if (!liveIds.has(this.state.leafId(leaf)))
				this.state.pendingOpenKind.delete(leaf);
	}
}
