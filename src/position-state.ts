import { WorkspaceLeaf } from 'obsidian';
import { EphemeralState, TabStateRecord, PluginSettings } from './types';
import { OpenCover } from './cover';
import { RestoreCue } from './cue';

export type OpenKind = 'anchorLink' | 'startPlainLink' | 'callerTarget';

// How long recording stays in absorb mode after an open-kind jump
// (anchorLink/startPlainLink/callerTarget) is dispatched at setViewState
// time (patcher.injectEphemeralStateOnOpen). The jump lands asynchronously
// (file load + scroll/cursor to the match or link target); during this
// window the poll re-baselines lastEphemeralState without writing and scroll
// capture skips, so the landing itself is never recorded as user movement.
// The sampler additionally expires the absorb early once the view stops
// moving (stability check), so this is a ceiling, not a hard delay.
export const LANDING_ABSORB_MS = 3000;

// Single owner of the cross-phase coordination state shared by recording,
// restore, and the open patches. The transient flags below are read and
// written across restore, inject, and the polling loop — fragmenting them
// across classes would let recording observe a half-applied restore, so they
// all live here and the collaborators (Restorer / OpenPatcher) take this
// instance.
export class PositionState {
	// Leaves whose saved position was injected into the open's ephemeral state
	// (setViewState patch) and therefore must not be restored a second time by
	// the file-open handler. Keyed by LEAF ID, not file path: with the same
	// file open in two tabs each tab injects its own (per-tab) position and
	// needs its own settle/reveal on first activation — a shared path key let
	// the first tab's file-open consume the marker and dedup the second's.
	// Consumed when the matching file-open arrives; a background open
	// (active:false) produces no file-open, so its entry stays until that tab
	// is activated — which is exactly when it is needed.
	injectedOpenLeafIds = new Set<string>();

	// File path of the leaf active before the most recent 'active-leaf-change'.
	// The event fires with only the NEW leaf — there is no oldLeaf argument —
	// so Restorer.completeInjectedRestore needs this sliding track to tell a
	// same-file activation (no 'file-open' will follow; restore here) from a
	// genuine file switch (its own 'file-open' owns the restore). Slid on every
	// activation, markdown or not.
	lastActiveFilePath: string | undefined = undefined;

	// ===== Restore run tracking =====
	restoreRun = 0;     // bumped per restore; stale restores detect supersession
	private activeRestores = 0; // restore chains in flight

	// Leaf id -> { filePath, run } of the restore currently in flight for
	// that leaf (restoreOpen entry until its chain unwinds). Lets a duplicate
	// re-assert for the same leaf+file detect that the restore is already
	// running and skip instead of superseding it — a second entry would
	// otherwise take the non-injected path and reveal the first-paint cover
	// mid-settle. This is the guard between the two restore entry points
	// ('file-open' and the 'active-leaf-change' completion), which can both
	// fire for one open. Keyed by leaf because rapid file switching reuses
	// the same view; the run discriminates the winning restore on cleanup.
	inFlightRestoreLeafRuns: Map<string, { filePath: string; run: number }> = new Map();

	// True while any file restore is in flight (from open until the landing is
	// anchored). Recording (polling + scroll capture) skips while this holds,
	// because restore's own glide/apply fires scroll events that would
	// otherwise overwrite the saved position.
	isRestoringFile(): boolean {
		return this.activeRestores > 0;
	}

	// Called by Restorer around its restore chain; the counter (not a plain
	// boolean) keeps the flag up while superseded restores unwind.
	restoreStarted() {
		this.activeRestores++;
	}

	restoreEnded() {
		this.activeRestores--;
	}

	// Leaf id -> whose restore must skip the anchor (background restores:
	// the recording baseline belongs to the active leaf only). Set by
	// BackgroundSettler, cleared in its finally; anchorToSettledState reads it.
	noAnchorLeafIds = new Set<string>();

	// ===== Recording baseline: written by restore, read by polling =====
	lastEphemeralState: EphemeralState | undefined;
	lastLoadedFilePath: string | undefined;

	// Timestamp of the last recording re-anchor (a restore landed, or a
	// dedup/jump re-anchored). Starts the mobile "post-open reflow window":
	// the sampler treats scroll-only deltas within SCROLL_SETTLE_GUARD_MS of
	// this stamp that no user touch accounts for as passive layout shift and
	// absorbs them instead of overwriting the saved record.
	lastAnchorAt = 0;

	// Timestamp of the last user touch on the workspace (mobile only).
	// Written by the sampler's touchstart listener; read by the sampler's
	// poll guard and the restorer's drift correction (which must never fight
	// a user scroll). Lives here because both collaborators share this
	// coordination state.
	lastTouchAt = 0;

	// Timestamp of the last user input on the workspace (desktop: wheel /
	// pointerdown / keydown, written by the sampler's input tracker). Lets
	// the desktop scroll capture separate user-driven scrolls from
	// programmatic movement (dynamic re-render layout shifts, plugin-driven
	// scrolls), mirroring the mobile touch-based guard.
	lastUserInputAt = 0;
	// leaf.id -> filePath whose open is fully handled: restored, injected, or
	// yielded to a caller/link target. Written by the file-open dedup path
	// AND by the setViewState patch (yielded opens, injected opens) so pairs
	// whose open never fires 'file-open' (background opens, startup restore)
	// still dedup later switches and re-asserts — the replay recognition the
	// patch depends on.
	handledLeafIdMap: Map<string, string> = new Map();

	// Device-local per-leaf last state position records.
	lastStateByLeaf: Map<string, TabStateRecord> = new Map();

	// ===== Open-kind tracking (transient flags passed between patches) =====

	// Per-leaf pending open kind: the source of the most recent open on a leaf
	// when it overrides the saved position. Set by injectEphemeralStateOnOpen
	// (which has the leaf in hand), consumed at the top of restoreEphemeralState
	// to dispatch anchorLink/startPlainLink/callerTarget early returns instead of restoring.
	// Per-leaf because a caller-target open that never fires 'file-open' (e.g. a
	// search-result click on an already-open file) must not leak onto another
	// leaf's restore — also reset at the top of every setViewState patch so a
	// stale entry on the same leaf can't either.
	pendingOpenKind: Map<WorkspaceLeaf, OpenKind> = new Map();

	// Transient slot written by the openLinkText patch (which doesn't know the
	// target leaf yet) and promoted onto pendingOpenKind by
	// injectEphemeralStateOnOpen, which runs synchronously inside the same
	// openLinkText call stack. Cleared on promotion; the timeout is a safety net
	// for openLinkText calls that never reach setViewState.
	pendingLinkKind: OpenKind | undefined;
	pendingLinkKindTimeout = 0;

	// ===== Search anchor (search-driven jump guard) =====
	// Deadline until which recording treats view movement as not the user's:
	// while a search input (editor find, quick switcher, search panel) holds
	// focus this is Infinity, and the sampler keeps it there for a short
	// grace window after the input blurs before expiring it to Date.now().
	// The patcher also sets it to a finite future value (LANDING_ABSORB_MS)
	// when an open-kind jump (anchorLink/startPlainLink/callerTarget — a
	// search-result match or link target) is dispatched, so the async landing
	// is absorbed into the baseline instead of recorded. The sampler expires
	// the finite value early once the view stops moving. The poll arms/clears
	// it — see Sampler.installSearchAnchor.
	searchAnchorUntil = 0;

	isSearchAnchored(): boolean {
		return Date.now() < this.searchAnchorUntil;
	}

	// ===== Cover (pre-first-paint mask) =====
	// Safety timers that lift the pre-first-paint cover of opens if the restore
	// never runs (background open, skipped restore). The restore's own reveal
	// clears the cover earlier.
	cover = new OpenCover();

	// ===== Post-restore orientation cue (landing highlight + breadcrumb) =====
	cue: RestoreCue;

	constructor(settings: PluginSettings) {
		this.cue = new RestoreCue(settings);
	}

	// leaf.id is part of Obsidian's runtime API but absent from its public
	// typings, so the cast collapses the per-site @ts-ignore noise.
	leafId(leaf: WorkspaceLeaf): string {
		return (leaf as unknown as { id: string }).id;
	}
}
