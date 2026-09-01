import { MarkdownView } from 'obsidian';
import { EphemeralState } from './types';
import { applyEphemeralState, readEphemeralState } from './ephemeral';
import { delay, hasPreviewScrolled, nextPaint } from './wait';
import { PositionState } from './position-state';

// Minimal structural view of the CM6 EditorView reachable through
// (editor).cm — only what the pixel correction needs, no @codemirror
// dependency (Obsidian provides the instance at runtime).
export interface CmLike {
	state: { doc: { lines: number; length: number; line(n: number): { from: number }; toString(): string } };
	scrollDOM: HTMLElement;
	// CM6 public API: pos range of the currently rendered lines. Only
	// coordsAtPos of a RENDERED line returns real client-rect geometry; an
	// unrendered line returns a heightmap ESTIMATE, which during a file
	// swap (stale heightmap) is garbage — the source of the bogus
	// corrections debugged in session source-reland-flicker.
	viewport: { from: number; to: number };
	coordsAtPos(pos: number): { top: number } | null;
	// CM6 public API: schedule a geometry measure for the next frame. The
	// stale post-swap heightmap only becomes real when CM6 runs a measure
	// pass — which it does not schedule just because we are polling; the
	// pre-fix logs show it completing only ~850ms after a switch (or when
	// something else scrolled). Requesting it ourselves is what collapses
	// the garbage-measurement window.
	requestMeasure(): void;
	defaultLineHeight: number;
}

// Bounded budget for the mobile post-restore drift correction
// (relandDriftedScroll). Generous: mobile rendering can still be
// measuring/re-laying-out seconds after an open, and the correction is
// the only thing that fixes the landing.
const RELAND_MAX_MS = 3000;

// Reland correction cadence: starts tight (fix the big mislanding fast)
// and backs off (the open pipeline keeps re-applying its own scroll for a
// while after the landing; chasing every re-apply at a fixed fast cadence
// turns the fix into visible viewport jitter).
const RELAND_FIRST_STEP_MS = 200;
const RELAND_MAX_STEP_MS = 700;

// Budget for the pre-reveal pixel settle (settleSourcePixels). Bounded so
// the cover never holds the note blank for long: the cover safety timer
// (COVER_SAFETY_MS, 1200ms) must outlive the whole covered phase —
// content-ready wait + painted wait + this settle — with margin. On
// timeout the reveal proceeds anyway; the post-reveal one-shot check
// still catches gross landings.
export const SETTLE_MAX_MS = 800;

// Minimum time before the settle's first correction is trusted
// (settleSourcePixels, under maskedRestore's own cover; the covered
// injected path uses settleAndHold, whose stability clock replaces this
// dead wait). Debugged logs show core's own scroll
// re-applies all land within ~145ms of the open; 200ms clears that
// window with margin.
const SETTLE_MIN_MS = 200;

// After a settle correction, wait this long and verify it HELD: the
// pipeline can re-apply its own scroll a few hundred ms later. One
// re-correction (max 2 corrections total) keeps the final position
// correct while bounding visible jumps to two — a landing, never the
// old round-after-round tug-of-war.
const SETTLE_VERIFY_MS = 200;

// Quiet window the landing must hold before the cover lifts: any pixel
// movement of the saved line resets the clock, and core's own two-stage
// landing (estimate, then measure — observed at ~85ms) shows up as such
// a movement — so the window always runs on post-re-land ground truth.
// 100ms ≈ 6 frames: filters frame jitter and slow drift, while keeping
// the aligned-open blank near the physical floor (the cover cannot lift
// before CM has measured and re-landed its estimate — that alone costs
// ~90-145ms).
const SETTLE_HOLD_QUIET_MS = 100;
export const SETTLE_HOLD_MAX_MS = 1250;

// Source-mode pixel landing: convergence + correction under cover
// (settleSourcePixels / settleAndHold), the post-reveal one-shot gross
// check (relandSourcePixels), and the mobile adaptive readback loop
// (relandDriftedScroll). All measurement is guarded against the stale
// doc-swap heightmap paths debugged in session source-reland-flicker.
export class SourcePixelCorrector {
	private state: PositionState;

	constructor(state: PositionState) {
		this.state = state;
	}

	// Adaptive readback correction loop for reading view (called from
	// anchorToSettledState after the reveal) plus dispatch to the source
	// pixel one-shot. Restores land deep in a freshly opened document via
	// estimate-based / nearest-edge scroll semantics, so the saved top line
	// often ends up at the viewport BOTTOM (exactly one screen high) instead
	// of at the top — and whether it does depends on the layout state at
	// apply time, which is why the same switch sometimes lands correctly and
	// sometimes doesn't. Observed on mobile (WKWebView) and on desktop
	// injected source opens alike. Nothing else corrects it:
	// the injected source path only observes, and — decisively —
	// currentMode.getScroll() ECHOES the requested value while the pixels
	// sit elsewhere, so every readback-based verification (and any re-apply
	// of the same value) believed the landing was correct. That is why no
	// correction was ever visible.
	//
	// Source mode therefore verifies with PIXEL GEOMETRY through the CM6
	// instance ((editor).cm): where does the saved line actually sit in the
	// viewport right now (coordsAtPos client rects — no coordinate-system
	// assumptions). The correction happens in TWO phases:
	//  1. settleSourcePixels — BEFORE the cover lifts: wait for the editor's
	//     measurement to converge, then ONE decisive correction, invisible
	//     under the cover. This is where the landing is actually fixed.
	//  2. relandSourcePixels — after the reveal: a ONE-SHOT check that only
	//     corrects gross errors (half a viewport and beyond) for paths that
	//     got no settle (glide source) or whose settle timed out. No loop:
	//     chasing the open pipeline's own re-applies round after round was
	//     the visible tug-of-war behind the reported jitter.
	// Reading mode has no per-line DOM hook, so it keeps the adaptive
	// readback loop below (preview getScroll is pixel-derived once actually
	// scrolled; the echo phase is excluded via hasPreviewScrolled). Aborts
	// the moment the user touches the view (a NEW touch — the tap that
	// opened the file is snapshotted as the baseline) so it never fights a
	// user scroll. Runs while the restore bracket is still open, so the poll
	// cannot record the correction's own scroll as user movement; the db
	// record is never written by the correction (display-only).
	async relandDriftedScroll(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (!st || !st.scroll || st.scroll <= 0)
			return;
		const target = st.scroll;
		// The open's own tap must not count as "user is scrolling": only a
		// touch newer than this snapshot aborts the correction.
		const touchBaseline = this.state.lastTouchAt;
		const deadline = Date.now() + RELAND_MAX_MS;
		if (view.getMode() === 'source') {
			await this.relandSourcePixels(view, target, isCurrent, touchBaseline);
			return;
		}
		let applied = target;
		let bestMiss = Infinity;
		let noProgress = 0;
		let stepMs = RELAND_FIRST_STEP_MS;
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
			stepMs = Math.min(stepMs * 1.4, RELAND_MAX_STEP_MS);
		}
	}

	// The CM6 EditorView behind (editor).cm, or null when unreachable (view
	// not ready yet / Obsidian internals changed). Minimal structural view —
	// only what the pixel correction needs, no @codemirror dependency
	// (Obsidian provides the instance at runtime).
	private cmOf(view: MarkdownView): CmLike | null {
		const cm = (view.editor as { cm?: CmLike }).cm;
		return cm?.state?.doc && cm.scrollDOM ? cm : null;
	}

	// Whether the editor's document IS the target file's content yet. On a
	// same-leaf switch the doc keeps the previous file's content for several
	// hundred ms (Obsidian loads the new file asynchronously) — measurements
	// against it are self-consistent garbage that matches the OLD file's
	// geometry (debugged: corrections off by exactly the old-vs-new layout
	// delta, flipping back when the doc swap completed ~850ms in). view.data
	// is the content Obsidian loaded for the view — set before the doc swap —
	// so doc==data is exactly "the swap has happened". Cheap length check
	// first; full compare only when lengths match.
	private docMatchesView(view: MarkdownView, cm: CmLike): boolean {
		const data = view.data;
		if (typeof data !== 'string' || data.length === 0)
			return true; // nothing to compare against: never block on this
		const doc = cm.state.doc;
		if (doc.length !== data.length)
			return false;
		return doc.toString() === data;
	}

	// Guarded measurement of the saved line's pixel offset from the scroller
	// top, shared by the settle and the pre-reveal quiet hold. Three gates,
	// each closing a debugged garbage-measurement path:
	//  1. DOC IDENTITY FIRST: on a same-leaf switch the doc still holds the
	//     previous file for several hundred ms — measuring it produces
	//     self-consistent garbage that matches the OLD file's geometry
	//     (debugged: bogus corrections off by exactly the old-vs-new layout
	//     delta). No correct doc, no measurement. The identity check runs
	//     once per measurer: view.data is set before the doc swap, so once
	//     doc==data the swap has happened.
	//  2. Re-resolve the line pos from the CURRENT doc every call: the swap
	//     replaces the doc, and a pos captured earlier pointed into the old
	//     one. EOF check included (file changed on disk/sync).
	//  3. GROUND TRUTH ONLY: a rendered line's coordsAtPos is a real client
	//     rect; an unrendered line's is a heightmap ESTIMATE. No render, no
	//     measurement.
	// Returns null whenever a gate fails — callers must treat null as "no
	// trustworthy number", never as zero.
	private targetTopMeasurer(view: MarkdownView, cm: CmLike, targetLine1Based: number): () => number | null {
		const scroller = cm.scrollDOM;
		let docVerified = false;
		return () => {
			if (!docVerified) {
				if (!this.docMatchesView(view, cm))
					return null;
				docVerified = true;
			}
			if (targetLine1Based + 1 > cm.state.doc.lines)
				return null;
			const from = cm.state.doc.line(targetLine1Based + 1).from;
			if (from < cm.viewport.from || from >= cm.viewport.to)
				return null;
			const coords = cm.coordsAtPos(from);
			return coords
				? coords.top - scroller.getBoundingClientRect().top
				: null;
		};
	}

	// Merged precision landing + reveal gate for covered opens. One loop
	// decides BOTH whether the landing needs fixing and when the cover can
	// lift — replacing the old sequential settle(dead MIN wait)→hold, which
	// blanked every open for ~450ms even though the post-fix logs show
	// every injected landing converging with delta ≈ 5px and ZERO
	// corrections:
	//  - each frame, measure the saved line's pixel delta; any movement
	//    resets the stability clock (core's two-stage landing — estimate,
	//    then measured re-land at ~85ms — shows up as exactly such a
	//    movement, so the clock restarts after it);
	//  - the moment the clock starts, a measure pass is nudged, so the
	//    quiet window runs on real flushed geometry and the reveal needs
	//    no extra measure wait;
	//  - MISALIGNED → correct immediately, gated on a forced-fresh
	//    measurement; residuals (the round-5 logs show a +680px fix
	//    followed by a -75px re-measure drift) are corrected back-to-back
	//    within the same pass — max 2;
	//  - STABLE for SETTLE_HOLD_QUIET_MS → verify against current geometry
	//    and reveal: the cover lifts at ~200ms instead of blanking for a
	//    blanket deadline;
	//  - unmeasurable (doc swap in flight / unrendered line) → stay
	//    covered, nudge a measure pass.
	// Bounded by the deadline (SETTLE_HOLD_MAX_MS from restore entry; the
	// cover safety timer stays the outer bound) — on timeout the reveal
	// proceeds and the post-reveal one-shot check still catches gross
	// errors. Aborts on a touch newer than the open's own tap — never hold
	// the cover over the user's scrolling.
	async settleAndHold(
		view: MarkdownView,
		targetLine1Based: number,
		isCurrent: () => boolean,
		touchBaseline: number,
		deadline: number,
	) {
		const cm = this.cmOf(view);
		if (!cm)
			return;
		const measure = this.targetTopMeasurer(view, cm, targetLine1Based);
		const scroller = cm.scrollDOM;
		const lineHeight = cm.defaultLineHeight || 20;
		const alignedLimit = lineHeight * 2;
		let prev: number | null = null;
		let stableSince = -1;
		let corrections = 0;
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			const delta = measure();
			if (delta === null) {
				cm.requestMeasure(); // nudged: a stale heightmap only becomes real through a measure pass
				prev = null;
				stableSince = -1;
				await nextPaint();
				continue;
			}
			if (prev !== null && Math.abs(delta - prev) <= lineHeight / 2) {
				if (stableSince < 0) {
					stableSince = Date.now();
					// Nudge a measure pass NOW: it flushes real geometry
					// within a frame or two, so the quiet window and the
					// reveal decision run on measured ground truth without
					// extra paint waits at expiry.
					cm.requestMeasure();
				}
			} else {
				stableSince = -1;
			}
			prev = delta;
			const quiet = stableSince >= 0 && Date.now() - stableSince >= SETTLE_HOLD_QUIET_MS;
			const misaligned = Math.abs(delta) > alignedLimit;
			if (!misaligned && !quiet) {
				await nextPaint();
				continue;
			}
			if (misaligned) {
				// Wrong landing: fix the moment the reading is real — a
				// forced measure pass gates the correction (round-5 logs:
				// correcting at ~50-95ms instead of waiting out the quiet
				// window), and residuals are corrected back-to-back before
				// the quiet verify window even starts.
				cm.requestMeasure();
				await nextPaint();
				await nextPaint();
				if (!isCurrent())
					return;
				const rechecked = measure();
				if (rechecked === null)
					return; // gates closed again: reveal, the one-shot check guards
				if (Math.abs(rechecked) > alignedLimit) {
					if (corrections >= 2)
						return; // reveal anyway; the one-shot check guards
					scroller.scrollTop += rechecked; // exact residual correction
					corrections++;
					// Re-measure against the corrected viewport on the next
					// frames: further residuals are fixed back-to-back, and
					// only when aligned does the quiet verify window start.
					prev = null;
					stableSince = -1;
					await nextPaint();
					continue;
				}
				// Measured aligned after all (stale-heightmap false alarm):
				// track on the true geometry.
				prev = rechecked;
				if (quiet)
					return;
				await nextPaint();
				continue;
			}
			// Quiet-expired: verify against current geometry (already
			// flushed by the stability-start nudge — any heightmap update
			// mid-window would have shifted the readings and reset the
			// clock).
			const rechecked = measure();
			if (rechecked === null)
				return; // gates closed again: reveal, the one-shot check guards
			if (Math.abs(rechecked) > alignedLimit || Math.abs(rechecked - delta) > lineHeight / 2) {
				// Fake stability exposed: treat as movement, keep covered.
				stableSince = -1;
				prev = rechecked;
				await nextPaint();
				continue;
			}
			return;
		}
	}

	// Source pixel settle — the precision landing under maskedRestore's own
	// contentEl cover. The covered injected path uses settleAndHold, which
	// merges this converge+correct with the reveal decision.
	//
	// Timing is the whole design. A freshly opened editor is still
	// measuring: CM6 lands estimate-based scrolls, re-measures real line
	// heights and shifts content; the staged open pipeline re-applies its
	// own scroll for a few hundred ms. Three rules keep the number of
	// visible corrections at zero-to-two AND the final position correct:
	//  1. No correction before SETTLE_MIN_MS — convergence measured in the
	//     first ~300ms is the calm BEFORE the measure/re-apply shifts.
	//  2. Then converge: two consecutive frames agreeing on the residual
	//     within half a line; correct ONCE with the exact residual.
	//  3. Verify the correction HELD (SETTLE_VERIFY_MS later): if the
	//     pipeline overwrote it, re-correct once. Max 2 corrections total.
	// Aborts on a touch newer than the open's own tap (the user took over
	// the viewport) and on supersedence. Bounded by SETTLE_MAX_MS for the
	// converge phase: a never-settling layout reveals as-is and the
	// post-reveal one-shot check still catches gross errors.
	async settleSourcePixels(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean, maxMs: number) {
		if (!st || !st.scroll || st.scroll <= 0 || view.getMode() !== 'source')
			return;
		const cm = this.cmOf(view);
		if (!cm)
			return;
		const scroller = cm.scrollDOM;
		const targetLine1Based = st.scroll;
		const lineHeight = cm.defaultLineHeight || 20;
		// The open's own tap must not count as "user is scrolling": only a
		// touch newer than this snapshot aborts the settle.
		const touchBaseline = this.state.lastTouchAt;
		const start = Date.now();
		const deadline = start + maxMs;
		const measureDelta = this.targetTopMeasurer(view, cm, targetLine1Based);
		// Phase 1 — converge on REAL measurements. No heightmap coarse
		// jumps: while the line is unrendered there is nothing trustworthy
		// to act on. When nothing can be measured, actively request a CM6
		// measure pass — the stale post-swap heightmap only becomes real
		// through one, and CM6 won't schedule it just because we poll
		// (pre-fix logs: real geometry only ~850ms after a switch without
		// the nudge).
		let converged = false;
		let prevDelta: number | null = null;
		while (isCurrent() && Date.now() < deadline) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			const delta = measureDelta();
			if (delta === null) {
				prevDelta = null;
				cm.requestMeasure();
				await nextPaint();
				continue;
			}
			if (Date.now() - start >= SETTLE_MIN_MS
				&& prevDelta !== null
				&& Math.abs(delta - prevDelta) <= lineHeight / 2) {
				converged = true;
				break;
			}
			prevDelta = delta;
			await nextPaint();
		}
		if (!converged)
			return;

		// Phase 2 — correct, then verify the correction HELD (max 2). The
		// threshold ignores residuals under two lines: they're near-
		// invisible, and chasing them was the old jitter. BEFORE applying a
		// correction, force a CM6 measure pass and re-check: "rendered" per
		// the viewport gate can still mean unmeasured DOM whose coords
		// reflect the stale heightmap (pre-fix: a bogus +432px correction
		// fired exactly this way) — after the forced measure the same line
		// read its true delta (5px) and no correction was warranted.
		let corrections = 0;
		while (corrections < 2 && isCurrent()) {
			if (this.state.lastTouchAt > touchBaseline)
				return;
			const delta = measureDelta();
			if (delta === null)
				return;
			if (Math.abs(delta) <= lineHeight * 2)
				return; // aligned at the visual top
			cm.requestMeasure();
			await nextPaint();
			await nextPaint();
			const rechecked = measureDelta();
			if (rechecked === null)
				return;
			if (Math.abs(rechecked) <= lineHeight * 2)
				return;
			scroller.scrollTop += rechecked; // exact residual correction
			corrections++;
			const verifyDeadline = Date.now() + SETTLE_VERIFY_MS;
			while (isCurrent() && Date.now() < verifyDeadline) {
				if (this.state.lastTouchAt > touchBaseline)
					return;
				await nextPaint();
			}
		}
	}

	// Post-reveal ONE-SHOT gross-error check: corrects only a landing off
	// by more than half a viewport (bottom-landing etc.), exactly once. The
	// precision work already happened under cover (settleSourcePixels);
	// this exists for paths that got no settle (glide source) or whose
	// settle timed out. No loop by design: a multi-round correction against
	// the open pipeline's own re-applies is the visible tug-of-war; one fix
	// of a gross error reads as a single landing, never as jitter.
	private async relandSourcePixels(
		view: MarkdownView,
		target: number,
		isCurrent: () => boolean,
		touchBaseline: number,
	) {
		if (!isCurrent())
			return;
		// A touch newer than the open's own tap means the user already took
		// over the viewport — never yank it back.
		if (this.state.lastTouchAt > touchBaseline)
			return;
		const cm = this.cmOf(view);
		if (!cm)
			return;
		const scroller = cm.scrollDOM;
		if (!this.docMatchesView(view, cm))
			return; // doc still holds the previous file: any measurement is garbage
		if (target + 1 > cm.state.doc.lines)
			return; // saved line beyond EOF (file changed on disk/sync)
		const lineFrom = cm.state.doc.line(target + 1).from;
		// Same rendered-line gate as the settle: an unrendered line's
		// coordsAtPos is a heightmap estimate (garbage during a swap) —
		// correcting on it WAS a visible jump to a wrong position.
		if (lineFrom < cm.viewport.from || lineFrom >= cm.viewport.to)
			return;
		// Force a fresh measure pass before trusting the readback: "in
		// viewport" can still mean unmeasured DOM reading stale-heightmap
		// coords (the bogus one-shot yank of the pre-fix logs).
		cm.requestMeasure();
		await nextPaint();
		await nextPaint();
		const coords = cm.coordsAtPos(lineFrom);
		if (!coords)
			return;
		const delta = coords.top - scroller.getBoundingClientRect().top;
		if (Math.abs(delta) > scroller.clientHeight / 2)
			scroller.scrollTop += delta; // exact residual correction
	}
}
