import { App, FileView, MarkdownView, Platform, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { CursorPositionDatabase } from './database';
import { applyEphemeralState, readEphemeralState, setCursorToEnd } from './ephemeral';
import { ANCHOR_SETTLE_DELAY, animateScrollTop, delay, getScroller, hasPreviewScrolled, nextPaint, waitForContentReady, waitForInjectedRestorePainted, waitForRestorePainted } from './wait';
import { PositionState } from './position-state';

// Minimal structural view of the CM6 EditorView reachable through
// (editor).cm — only what the mobile pixel correction needs, no @codemirror
// dependency (Obsidian provides the instance at runtime).
interface CmLike {
	state: { doc: { lines: number; line(n: number): { from: number } } };
	scrollDOM: HTMLElement;
	lineBlockAt(pos: number): { top: number };
	coordsAtPos(pos: number): { top: number } | null;
	defaultLineHeight: number;
}

// Restores a saved position after an open. Pure view<->state helpers live in
// ./ephemeral, paint/render observation in ./wait, the first-paint cover and
// cue in ./state (via OpenCover / RestoreCue). All cross-phase coordination
// flags are owned by the shared PositionState this class takes.
export class Restorer {
	private app: App;
	private database: CursorPositionDatabase;
	private settings: PluginSettings;
	private state: PositionState;

	// Bounded budget for the mobile post-restore drift correction
	// (relandDriftedScroll). Generous: mobile rendering can still be
	// measuring/re-laying-out seconds after an open, and the correction is
	// the only thing that fixes the landing.
	private readonly RELAND_MAX_MS = 3000;

	// Reland correction cadence: starts tight (fix the big mislanding fast)
	// and backs off (the open pipeline keeps re-applying its own scroll for a
	// while after the landing; chasing every re-apply at a fixed fast cadence
	// turns the fix into visible viewport jitter).
	private readonly RELAND_FIRST_STEP_MS = 200;
	private readonly RELAND_MAX_STEP_MS = 700;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings, state: PositionState) {
		this.app = app;
		this.database = database;
		this.settings = settings;
		this.state = state;
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
					await this.glideRestore(view, st, isCurrent);
				else if (injected)
					await this.restoreInjectedSource(view, st, isCurrent);
				else if (st)
					await this.maskedRestoreSt(view, st, isCurrent);
				else
					await this.maskedRestoreDefault(view, isCurrent);
				return;
			}

			if (mode === 'preview') {
				// Reading view renders from the top and never applies a default
				// position — with no record there is nothing to restore.
				if (!st)
					return;
				if (this.settings.readingRestoreMethod === 'glide' && (st.scroll ?? 0) > 0)
					await this.glideRestore(view, st, isCurrent);
				else
					await this.maskedRestoreSt(view, st, isCurrent);
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

		// Lift any stale restore cover left by a superseded restore; the
		// dispatch body re-covers as needed. Bases restores never cover.
		if (isMarkdown)
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
		// so the body re-anchors only. Consumed before the dedup check so a
		// dedup hit (mere tab activation) still clears the marker and a later
		// re-open of the same file restores again.
		const injected = isMarkdown && this.state.injectedOpenPaths.delete(filePath);

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

	// Source-mode restore for opens whose saved position was injected into
	// core's setViewState. Core applied it synchronously; here we wait for
	// paint, lift the cover, and re-anchor. Reading view never injects, so
	// this per-leaf cover check must not skip its masked restore.
	private async restoreInjectedSource(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (this.state.cover.isCovered(view.leaf)) {
			try {
				await waitForInjectedRestorePainted(view, st, isCurrent);
			} finally {
				if (isCurrent())
					this.state.cover.uncover(view.leaf);
			}
		}
		await this.anchorToSettledState(view, st, isCurrent);
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

	// Masked restore skeleton shared by saved-position and default-position
	// restores. The cover goes on before the first paint and comes off in the
	// same frame the restored position is confirmed painted, so the uncover is
	// invisible. opacity (not display:none) keeps layout intact while hidden,
	// so revealing is pure compositor work.
	//
	// `apply` applies the position and returns true when it is scrollable, so
	// the cover stays until the editor reports the line (bounded); sync
	// restores only wait two frames to confirm the result is painted.
	private async maskedRestore(
		view: MarkdownView,
		st: EphemeralState | undefined,
		isCurrent: () => boolean,
		apply: () => boolean,
	) {
		// Hide the restore under construction; the revealRestoreCover here in
		// finally and the one at restoreEphemeralState's top (for superseded
		// restores) own lifting it back.
		this.state.cover.restoreCover(view);
		try {
			// Wait until the reading renderer has produced the note (bounded
			// max for views that never catch up). The link-highlight span
			// appears with this render, so this also times the .is-flashing
			// re-check to when it can exist.
			await waitForContentReady(view, isCurrent);
			if (!isCurrent())
				return;

			// Catch-all for anchorLink highlights that bypassed openLinkText
			// (programmatic scrolls, API opens): core's target wins, restore
			// nothing. (anchorLink navs that went through openLinkText are caught
			// at the top of restoreEphemeralState.) See #10, #32, #46, #51.
			if (view.containerEl.querySelector('.is-flashing'))
				return;

			await nextPaint();
			if (!isCurrent())
				return;

			const scrollable = apply();

			// Stay covered until the editor reports the line
			// (bounded so failures don't blank it). scrollable already implies
			// st is non-null and scrollable, so only the type-narrowing guard
			// for waitForRestorePainted remains.
			if (scrollable && st) {
				await waitForRestorePainted(view, st, isCurrent);
			} else {
				// Sync restores; two frames ensure the result is painted.
				await nextPaint();
				await nextPaint();
			}
		} finally {
			if (isCurrent()) {
				// Lift the leaf-level cover (from coverOpen) AND clear this
				// restore's own cover on view.contentEl — two different
				// elements, both must be cleared to reveal.
				this.state.cover.uncover(view.leaf);
				this.state.cover.revealRestoreCover(view);
			}
		}

		await this.anchorToSettledState(view, st, isCurrent);
	}

	// Restore a saved position under a hidden cover — reading view and the
	// rare source-mode opens that bypassed setViewState.
	private async maskedRestoreSt(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		if ((st.scroll ?? 0) <= 0) {
			// Scroll-0 record: the only applicable piece is the cursor
			// selection, which lands synchronously and never moves the
			// viewport (applyEphemeralState skips scroll 0, and reading mode
			// ignores cursors). Masking a nothing-restore would only add a
			// covered blank period — very visible on slow devices (Android) —
			// so apply in the open and anchor instead.
			applyEphemeralState(view, st);
			await nextPaint();
			if (!isCurrent())
				return;
			await nextPaint();
			if (!isCurrent())
				return;
			await this.anchorToSettledState(view, st, isCurrent);
			return;
		}
		await this.maskedRestore(view, st, isCurrent, () => {
			applyEphemeralState(view, st);
			return true;
		});
	}

	// Apply a source-mode default position (no saved record) under a hidden
	// cover.
	private async maskedRestoreDefault(view: MarkdownView, isCurrent: () => boolean) {
		await this.maskedRestore(view, undefined, isCurrent, () => {
			if (this.settings.defaultPosition === 'fileEnd') {
				setCursorToEnd(view);
			}
			return false;
		});
	}

	// glide restore: no mask, so no blank period. The note
	// renders visibly from the top (async render is Obsidian's own, not
	// hidden by us); once the renderer has produced content we scroll to the
	// saved line. (Instant setting skips this in favor of
	// instantReadingRestore.)
	private async glideRestore(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		if ((st.scroll ?? 0) <= 0)
			throw new Error('glideRestore: no saved scroll');

		await waitForContentReady(view, isCurrent);
		if (!isCurrent())
			return;

		// Catch-all for anchorLink highlights that bypassed openLinkText: core's
		// target wins, no glide. (Same guard as maskedRestore.)
		if (view.containerEl.querySelector('.is-flashing'))
			return;

		const scroller = getScroller(view);
		if (!scroller) {
			// Note isn't scrollable: let Obsidian's own applyScroll place it.
			applyEphemeralState(view, st);
			await nextPaint();
			if (isCurrent())
				await this.anchorToSettledState(view, st, isCurrent);
			return;
		}

		await this.glideScrollTo(view, scroller, st, isCurrent);
	}

	// Shared glide core: apply the saved line, wait for the renderer to actually
	// land it, then run the fixed short transition and verify. applyScroll can
	// defer the actual scroll to the renderer's next pass, so the immediate
	// readback is unreliable (stale 0 → falsely "already at the line" → stuck
	// at top); wait until the view both reports the saved line and the scroller
	// has moved (bounded) before measuring. A single apply can also never land:
	// the staged open pipeline can reset the scroll after it first lands, and
	// an apply issued before the renderer caught up is a silent no-op — so
	// re-apply on drift (same reason waitForRestorePainted re-applies).
	private async glideScrollTo(view: MarkdownView, scroller: HTMLElement, st: EphemeralState, isCurrent: () => boolean) {
		const scroll = st.scroll;
		if (!scroll || scroll <= 0)
			return;
		applyEphemeralState(view, st);
		const landDeadline = Date.now() + 2000;
		let lastApply = Date.now();
		// Landed = renderer reports the saved line AND (outside source) the
		// real scroller has actually moved. Reading view echoes the requested
		// scroll in getScroll() before any pixel has moved — without the
		// movement check the loop would exit on the echo and measure a stale
		// targetPx of 0, falsely taking the "note too short" exit (same
		// reason isRestoreStuck requires the scroller to have moved).
		const landed = () => {
			if (Math.round(view.currentMode?.getScroll() ?? -1) !== scroll)
				return false;
			if (view.getMode() === 'preview' && !hasPreviewScrolled(view))
				return false;
			return true;
		};
		while (isCurrent() && Date.now() < landDeadline && !landed()) {
			await nextPaint();
			if (isCurrent() && Date.now() - lastApply >= 100 && !landed()) {
				applyEphemeralState(view, st);
				lastApply = Date.now();
			}
		}
		if (!isCurrent())
			return;
		// The renderer (or a mode flip) can replace the scroll element after
		// capture, leaving the passed-in scroller detached with a stuck
		// scrollTop of 0. Re-resolve from the view's CURRENT mode before
		// measuring and animating.
		const liveScroller = getScroller(view) ?? scroller;
		const targetPx = liveScroller.scrollTop;
		if (targetPx <= 0) {
			// Note too short to scroll / saved line off the end: the state
			// already applied is the right landing.
			await nextPaint();
			if (isCurrent())
				await this.anchorToSettledState(view, st, isCurrent);
			return;
		}
		const prevBehavior = liveScroller.style.scrollBehavior;
		liveScroller.setCssStyles({ scrollBehavior: 'auto' }); // no theme can turn frames into anims
		try {
			// Fixed short transition: ramps to ~1200px/s and caps at 600ms,
			// so a deep note can't take long — an orientation cue and soft
			// landing, not a readable glide (scrolling is navigation).
			const duration = Math.max(150, Math.min(600, (targetPx / 1200) * 1000));
			await animateScrollTop(liveScroller, 0, targetPx, duration, isCurrent);
			if (!isCurrent())
				return;

			// Land exactly: restore the full saved state (cursor included) and
			// verify the line landed where requested; snap if something drifted.
			applyEphemeralState(view, st);
			await nextPaint();
			if (!isCurrent())
				return;
			const landed = Math.round(view.currentMode?.getScroll() ?? -1);
			if (landed !== scroll) {
				applyEphemeralState(view, st);
				await nextPaint();
			}
		} finally {
			liveScroller.style.scrollBehavior = prevBehavior;
		}

		await this.anchorToSettledState(view, st, isCurrent);
	}

	// Anchor change detection to where the view actually settled, not the
	// value we requested. Integer quantization absorbs applyScroll's small
	// landing error inside its ±0.5 dead zone, but images loading *above*
	// the viewport can shift the readback by whole lines — past the dead
	// zone. Anchoring to the requested value would let the polling loop
	// treat that layout-shift jump as a user scroll and overwrite the saved
	// position. ANCHOR_SETTLE_DELAY lets layout shifts settle first.
	private async anchorToSettledState(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		await delay(ANCHOR_SETTLE_DELAY);
		// A superseded restore must never anchor: lastEphemeralState would
		// describe the wrong file and the polling loop would write it to the db.
		if (isCurrent() && Platform.isMobileApp)
			await this.relandDriftedScroll(view, st, isCurrent);
		if (isCurrent()) {
			this.state.lastEphemeralState = readEphemeralState(view) ?? st;
			this.state.lastAnchorAt = Date.now();
			// Every real restore path ends here (masked/glide/injected/default
			// jumps); dedup, link jumps, and native-default opens don't, so the
			// cue only fires after an actual restore landed.
			this.state.cue.show(view);
		}
	}

	// Mobile (WKWebView): restores land deep in a freshly opened document via
	// estimate-based / nearest-edge scroll semantics, so the saved top line
	// often ends up at the viewport BOTTOM (exactly one screen high) instead
	// of at the top — and whether it does depends on the layout state at
	// apply time, which is why the same switch sometimes lands correctly and
	// sometimes doesn't. Desktop rarely drifts (wide viewport keeps line
	// estimates close), hence the mobile gate. Nothing else corrects it:
	// the injected source path only observes, and — decisively —
	// currentMode.getScroll() ECHOES the requested value while the pixels
	// sit elsewhere, so every readback-based verification (and any re-apply
	// of the same value) believed the landing was correct. That is why no
	// correction was ever visible.
	//
	// Source mode therefore verifies with PIXEL GEOMETRY through the CM6
	// instance ((editor).cm): where does the saved line actually sit in the
	// viewport right now. lineBlockAt().top gives a coarse jump when the
	// line is not rendered; the residual is measured with coordsAtPos in
	// viewport space (client rects — no coordinate-system assumptions) and
	// removed exactly. The loop keeps re-checking for the full window so
	// late measure passes that re-shift the content get corrected too.
	// Reading mode has no per-line DOM hook, so it keeps the adaptive
	// readback loop (preview getScroll is pixel-derived once actually
	// scrolled; the echo phase is excluded via hasPreviewScrolled). Aborts
	// the moment the user touches the view (a NEW touch — the tap that
	// opened the file is snapshotted as the baseline) so it never fights a
	// user scroll. Runs while the restore bracket is still open, so the poll
	// cannot record the correction's own scroll as user movement; the db
	// record is never written by the correction (display-only).
	private async relandDriftedScroll(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (!st || !st.scroll || st.scroll <= 0)
			return;
		const target = st.scroll;
		// The open's own tap must not count as "user is scrolling": only a
		// touch newer than this snapshot aborts the correction.
		const touchBaseline = this.state.lastTouchAt;
		const deadline = Date.now() + this.RELAND_MAX_MS;
		if (view.getMode() === 'source') {
			await this.relandSourcePixels(view, target, isCurrent, touchBaseline, deadline);
			return;
		}
		let applied = target;
		let bestMiss = Infinity;
		let noProgress = 0;
		let stepMs = this.RELAND_FIRST_STEP_MS;
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			if (!hasPreviewScrolled(view))
				return; // echo phase: the renderer hasn't landed yet — let it
			const now = readEphemeralState(view);
			if (!now || now.scroll === undefined)
				return;
			if (now.scroll === target)
				return; // landed
			const miss = Math.abs(now.scroll - target);
			if (miss >= bestMiss) {
				// The last correction didn't shrink the gap — the request is
				// clamped (EOF) or the landing is unstable; stop rather than
				// churn.
				if (++noProgress >= 2)
					return;
			} else {
				noProgress = 0;
				bestMiss = miss;
			}
			applied += target - now.scroll;
			if (applied <= 0)
				return;
			applyEphemeralState(view, { ...st, scroll: applied });
			await delay(stepMs);
			stepMs = Math.min(stepMs * 1.4, this.RELAND_MAX_STEP_MS);
		}
	}

	private async relandSourcePixels(
		view: MarkdownView,
		target: number,
		isCurrent: () => boolean,
		touchBaseline: number,
		deadline: number,
	) {
		// Minimal structural view of the CM6 EditorView reachable through
		// (editor).cm — only what the pixel correction needs, no @codemirror
		// dependency (Obsidian provides the instance at runtime).
		const cm = (view.editor as { cm?: CmLike }).cm;
		if (!cm?.state?.doc || !cm.scrollDOM)
			return;
		const scroller = cm.scrollDOM;
		// Corrections trigger only beyond two lines: smaller offsets are
		// near-invisible, and reacting to them means chasing measure noise —
		// the visible tug-of-war behind the reported jitter. A real
		// bottom-landing measures a full viewport, far past this gate.
		const threshold = (cm.defaultLineHeight || 20) * 2;
		let stepMs = this.RELAND_FIRST_STEP_MS;
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			if (target + 1 > cm.state.doc.lines)
				return; // saved line beyond EOF (file changed on disk/sync)
			const line = cm.state.doc.line(target + 1);
			const coords = cm.coordsAtPos(line.from);
			if (coords) {
				// Ground truth: how far the saved line sits from the viewport
				// top, in client pixels. A bottom-landing measures a full
				// viewport here.
				const delta = coords.top - scroller.getBoundingClientRect().top;
				if (Math.abs(delta) <= threshold)
					return; // aligned at the visual top
				scroller.scrollTop += delta; // exact residual correction
			} else {
				// Line not rendered: coarse jump via heightmap coordinates,
				// refined by the client-rect branch on the next round.
				scroller.scrollTop = cm.lineBlockAt(line.from).top;
			}
			await delay(stepMs);
			stepMs = Math.min(stepMs * 1.4, this.RELAND_MAX_STEP_MS);
		}
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
		this.app.workspace.iterateAllLeaves((leaf) =>
			liveIds.add(this.state.leafId(leaf)));
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
