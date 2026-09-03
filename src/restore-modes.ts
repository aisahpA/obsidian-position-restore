import { MarkdownView, Platform } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { applyEphemeralState, readEphemeralState, setCursorToEnd } from './ephemeral';
import { ANCHOR_SETTLE_DELAY, animateScrollTop, delay, getScroller, hasPreviewScrolled, nextPaint, waitForContentReady, waitForRestorePainted } from './wait';
import { PositionState } from './position-state';
import { SETTLE_HOLD_MAX_MS, SETTLE_MAX_MS, SourcePixelCorrector } from './pixels';

// The restore strategies: how a saved position is applied to a markdown
// view once the dispatch pipeline (restorer.ts restoreOpen) decided a
// restore is needed. maskedRestore family (under a contentEl cover),
// glideRestore family (visible glide from the top), restoreInjectedSource
// (under the leaf first-paint cover), and the shared anchor
// (anchorToSettledState) every strategy ends with.
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
	// core's setViewState. Core applied it synchronously; here we settle the
	// landing under the leaf first-paint cover (applied for every scroll
	// injection — brand-new leaves and same-leaf switches alike), lift the
	// cover, and re-anchor.
	//
	// The cover can already be gone here when the safety timer lifted it
	// first (a background open activated after ~2s): the injected landing
	// has still drifted (CM's estimate-based apply on a freshly built
	// editor, debugged 2026-09: line 30 saved → 27.6 landed, half a screen
	// possible on worse estimates), so the settle still runs — uncovered,
	// bounded, and only on this first file-open (the injected marker makes
	// later activations dedup into tracking-only updates). Reading view
	// never injects, so this per-leaf cover check must not skip its masked
	// restore.
	async restoreInjectedSource(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		const entryAt = Date.now();
		// One touch baseline shared by settle and hold: a touch newer than
		// the open's own tap means the user took over — never hold the cover
		// over their scrolling.
		const touchBaseline = this.state.lastTouchAt;
		try {
			// One merged decision loop owns the whole covered phase: it
			// verifies with REAL pixel geometry (the getScroll() readback
			// this path used to wait for just echoes the request — pure
			// dead wait), reveals as soon as the landing is quiet AND
			// aligned (minimal blank), keeps the cover through a
			// correction when it is not. Bounded from restore entry so
			// the cover safety timer stays the outer bound.
			if (isCurrent() && st?.scroll)
				await this.pixels.settleAndHold(view, st.scroll, isCurrent, touchBaseline, entryAt + SETTLE_HOLD_MAX_MS);
		} finally {
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// Background-tab variant of restoreInjectedSource for an injected open
	// that never fired 'file-open' (a restart-restored split whose view IS
	// built): the injected landing drifts exactly like the active tab's, but
	// nothing settles it until first activation — the tab sits at the drifted
	// spot until clicked. Runs the same settle+reveal, WITHOUT
	// anchorToSettledState: that writes the single-slot recording baseline
	// (lastLoadedFilePath / lastEphemeralState) and the cue, which belong to
	// the ACTIVE leaf only.
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
			if (!isCurrent())
				return;

			// Source mode: converge the editor's measurement and fix the
			// landing in ONE correction while still covered (see
			// settleSourcePixels) — a post-reveal correction loop is the
			// visible tug-of-war this plugin used to show.
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
	async maskedRestoreDefault(view: MarkdownView, isCurrent: () => boolean) {
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
	async glideRestore(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
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
		if (this.state.noAnchorLeafIds.has(this.state.leafId(view.leaf)))
			return;
		await delay(ANCHOR_SETTLE_DELAY);
		// A superseded restore must never anchor: lastEphemeralState would
		// describe the wrong file and the polling loop would write it to the db.
		// Source mode corrects on ALL platforms: desktop injected opens land
		// one screen off too (the 2026-08 "jumps up one screen" report) — the
		// old desktop exemption trusted a readback that echoes the request.
		// The reading readback loop stays mobile-only: desktop preview rarely
		// drifts, and its pixel-derived readback needs no correction loop.
		if (isCurrent() && (view.getMode() === 'source' || Platform.isMobileApp))
			await this.pixels.relandDriftedScroll(view, st, isCurrent);
		if (isCurrent()) {
			this.state.lastEphemeralState = readEphemeralState(view) ?? st;
			this.state.lastAnchorAt = Date.now();
			// Every real restore path ends here (masked/glide/injected/default
			// jumps); dedup, link jumps, and native-default opens don't, so the
			// cue only fires after an actual restore landed.
			this.state.cue.show(view);
		}
	}
}
