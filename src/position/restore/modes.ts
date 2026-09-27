import { MarkdownView, Platform } from 'obsidian';
import { EphemeralState, NavEntryState, PluginSettings } from '@/types';
import { applyEphemeralState, readEphemeralState, remapAnchoredState, setCursorToEnd, shiftNavState } from '@/position/capture/ephemeral';
import { ANCHOR_SETTLE_DELAY, animateScrollTop, delay, getScroller, hasPreviewScrolled, nextPaint, waitForContentReady, waitForRestorePainted } from '@/shared/wait';
import { PositionState } from '@/position/state';
import { SETTLE_HOLD_MAX_MS, SETTLE_MAX_MS, SourcePixelCorrector } from './pixels';

// The restore strategies: how a saved position is applied to a markdown view
// once the dispatch pipeline decided a restore is needed — masked (under a
// contentEl cover), glide (visible, from the top), restoreInjectedSource
// (under the leaf first-paint cover), and the shared anchor every strategy
// ends with.
export class RestoreModes {
	private settings: PluginSettings;
	private state: PositionState;
	private pixels: SourcePixelCorrector;

	constructor(settings: PluginSettings, state: PositionState) {
		this.settings = settings;
		this.state = state;
		this.pixels = new SourcePixelCorrector(state);
	}

	// Source-mode restore for opens whose saved position was injected into
	// core's setViewState: core applied it synchronously, here we settle the
	// landing under the leaf first-paint cover, lift it, and re-anchor.
	// The cover can already be gone when the safety timer lifted it first (a
	// background open activated after ~2s): the landing has still drifted — a
	// freshly built editor lands off by up to half a screen — so the settle
	// runs anyway, uncovered and bounded, and only on this first file-open
	// (the injected marker dedups later activations). Reading view never
	// injects, so this per-leaf cover check must not skip its masked restore.
	async restoreInjectedSource(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		const entryAt = Date.now();
		// One touch baseline for settle and hold: a touch newer than the open's
		// own tap means the user took over — never hold the cover over their
		// scrolling.
		const touchBaseline = this.state.lastTouchAt;
		try {
			// One merged loop owns the whole covered phase: it verifies with
			// REAL pixel geometry (the getScroll() readback just echoes the
			// request) and reveals as soon as the landing is quiet AND aligned.
			// Bounded from restore entry so the cover safety timer stays the
			// outer bound.
			if (isCurrent() && st?.scroll)
				await this.pixels.settleAndHold(view, st.scroll, isCurrent, touchBaseline, entryAt + SETTLE_HOLD_MAX_MS);
		} finally {
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// Background-tab variant for an injected open that never fired
	// 'file-open' (a restart-restored split whose view IS built): the landing
	// drifts exactly like the active tab's, but nothing settles it until first
	// activation. Runs the same settle+reveal WITHOUT anchorToSettledState —
	// that writes the single-slot recording baseline and the cue, which belong
	// to the active leaf only.
	async settleInjectedReveal(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		const entryAt = Date.now();
		const touchBaseline = this.state.lastTouchAt;
		try {
			if (isCurrent() && st?.scroll)
				await this.pixels.settleAndHold(view, st.scroll, isCurrent, touchBaseline, entryAt + SETTLE_HOLD_MAX_MS);
		} finally {
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
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
		// Hide the restore under construction; the revealRestoreCover in
		// finally and the one at restoreEphemeralState's top (for superseded
		// restores) own lifting it back.
		this.state.cover.restoreCover(view);
		try {
			// Wait until the reading renderer has produced the note (bounded).
			// The link-highlight span appears with this render, so this also
			// times the .is-flashing re-check to when it can exist.
			await waitForContentReady(view, isCurrent);
			if (!isCurrent())
				return;

			// Catch-all for anchorLink highlights that bypassed openLinkText
			// (programmatic scrolls, API opens): core's target wins, restore
			// nothing. See #10, #32, #46, #51.
			if (view.containerEl.querySelector('.is-flashing'))
				return;

			await nextPaint();
			if (!isCurrent())
				return;

			const scrollable = apply();

			// Stay covered until the editor reports the line (bounded so
			// failures don't blank it). scrollable already implies st is
			// non-null and scrollable.
			if (scrollable && st) {
				await waitForRestorePainted(view, st, isCurrent);
			} else {
				// Sync restores; two frames ensure the result is painted.
				await nextPaint();
				await nextPaint();
			}
			if (!isCurrent())
				return;

			// Source mode: converge the editor's measurement and fix the
			// landing in ONE correction while still covered — a post-reveal
			// correction loop reads as a visible tug-of-war.
			await this.pixels.settleSourcePixels(view, st, isCurrent, SETTLE_MAX_MS);
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
	async maskedRestoreSt(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		if ((st.scroll ?? 0) <= 0) {
			// Scroll-0 record: the only applicable piece is the cursor, which
			// lands synchronously and never moves the viewport. Masking a
			// nothing-restore would only add a covered blank period — very
			// visible on slow devices (Android) — so apply in the open.
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
	async maskedRestoreDefault(view: MarkdownView, isCurrent: () => boolean) {
		await this.maskedRestore(view, undefined, isCurrent, () => {
			if (this.settings.defaultPosition === 'fileEnd') {
				setCursorToEnd(view);
			}
			return false;
		});
	}

	// In-file history jump (back/forward landing in the SAME note): the view
	// is already rendered — nothing to cover, no open pipeline to wait for.
	// Runs inside the funnel's restore bracket, so the poll cannot record the
	// applies as user movement.
	async historyJumpApply(view: MarkdownView, st: NavEntryState, isCurrent: () => boolean, shift?: number) {
		// The entry's lines predate edits made after it was recorded
		// (inserts/deletes above shift every line below). Two ways to
		// re-anchor: a structurally resolved shift (the jump's own
		// heading/block id re-located via metadataCache — authoritative), or
		// the text-snippet remap fallback.
		if (shift !== undefined)
			st = shiftNavState(st, shift);
		else
			st = remapAnchoredState(view.editor, st);
		applyEphemeralState(view, st);
		await nextPaint();
		if (!isCurrent())
			return;
		if (view.getMode() === 'source' && (st.scroll ?? 0) > 0)
			await this.pixels.settleSourcePixels(view, st, isCurrent, SETTLE_MAX_MS);
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// Glide restore: no mask, so no blank period. The note renders visibly
	// from the top (that async render is Obsidian's own); once the renderer
	// has produced content we scroll to the saved line.
	async glideRestore(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		if ((st.scroll ?? 0) <= 0)
			throw new Error('glideRestore: no saved scroll');

		await waitForContentReady(view, isCurrent);
		if (!isCurrent())
			return;

		// Catch-all for anchorLink highlights that bypassed openLinkText:
		// core's target wins, no glide. (Same guard as maskedRestore.)
		if (view.containerEl.querySelector('.is-flashing'))
			return;

		const scroller = getScroller(view);
		if (!scroller) {
			// Note isn't scrollable: let Obsidian's own applyScroll place it.
			applyEphemeralState(view, st);
			await nextPaint();
			await this.anchorToSettledState(view, st, isCurrent);
			return;
		}

		await this.glideScrollTo(view, scroller, st, isCurrent);
	}

	// Shared glide core: apply the saved line, wait for the renderer to
	// actually land it, then run the fixed short transition and verify.
	// applyScroll can defer the scroll to the renderer's next pass, so the
	// immediate readback is unreliable (stale 0 → falsely "already at the
	// line" → stuck at top); wait until the view reports the saved line AND
	// the scroller has moved (bounded). A single apply can also never land —
	// the staged pipeline can reset the scroll after it lands, and an apply
	// issued before the renderer caught up is a silent no-op — so re-apply on
	// drift.
	private async glideScrollTo(view: MarkdownView, scroller: HTMLElement, st: EphemeralState, isCurrent: () => boolean) {
		const scroll = st.scroll;
		if (!scroll || scroll <= 0)
			return;
		applyEphemeralState(view, st);
		const landDeadline = Date.now() + 2000;
		let lastApply = Date.now();
		// Landed = the renderer reports the saved line AND (outside source) the
		// real scroller has moved: reading view echoes the requested scroll in
		// getScroll() before any pixel moved.
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
		// capture, leaving the passed-in scroller detached at scrollTop 0.
		const liveScroller = getScroller(view) ?? scroller;
		const targetPx = liveScroller.scrollTop;
		if (targetPx <= 0) {
			// Note too short to scroll / saved line off the end: the state
			// already applied is the right landing.
			await nextPaint();
			await this.anchorToSettledState(view, st, isCurrent);
			return;
		}
		const prevBehavior = liveScroller.style.scrollBehavior;
		liveScroller.setCssStyles({ scrollBehavior: 'auto' }); // no theme can turn frames into anims
		try {
			// Fixed short transition: ramps to ~1200px/s and caps at 600ms, so
			// a deep note can't take long — an orientation cue and soft
			// landing, not a readable glide (scrolling is navigation).
			const duration = Math.max(150, Math.min(600, (targetPx / 1200) * 1000));
			await animateScrollTop(liveScroller, 0, targetPx, duration, isCurrent);
			if (!isCurrent())
				return;

			// Land exactly: restore the full saved state (cursor included) and
			// verify the line landed where requested; snap if something
			// drifted.
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
	// value we requested. Integer quantization absorbs applyScroll's landing
	// error, but images loading above the viewport shift the readback by whole
	// lines — past the dead zone. Anchoring to the requested value would let
	// the polling loop treat that layout-shift jump as a user scroll and
	// overwrite the saved position. ANCHOR_SETTLE_DELAY lets shifts settle.
	private async anchorToSettledState(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (this.state.noAnchorLeafIds.has(this.state.leafId(view.leaf)))
			return;
		await delay(ANCHOR_SETTLE_DELAY);
		// A superseded restore must never anchor: lastEphemeralState would
		// describe the wrong file and the polling loop would write it to the
		// db. Source mode corrects on ALL platforms (desktop injected opens
		// land off too); the reading readback loop stays mobile-only, where
		// preview drift is common enough to need a correction loop.
		if (isCurrent() && (view.getMode() === 'source' || Platform.isMobileApp))
			await this.pixels.relandDriftedScroll(view, st, isCurrent);
		if (isCurrent()) {
			this.state.lastEphemeralState = readEphemeralState(view) ?? st;
			this.state.lastAnchorAt = Date.now();
			// Every real restore path ends here, so the cue only fires after an
			// actual restore landed. NavStack traversals arm cueSuppressUntil —
			// the user chose the destination, no chip.
			if (Date.now() >= this.state.cueSuppressUntil)
				this.state.cue.show(view);
		}
	}
}
