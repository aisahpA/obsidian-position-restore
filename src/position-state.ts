import { WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { OpenCover } from './cover';
import { RestoreCue } from './cue';

export type OpenKind = 'anchorLink' | 'startPlainLink' | 'callerTarget';

// Single owner of the cross-phase coordination state shared by recording,
// restore, and the open patches. The transient flags below are read and
// written across restore, inject, and the polling loop — fragmenting them
// across classes would let recording observe a half-applied restore, so they
// all live here and the collaborators (Restorer / OpenPatcher) take this
// instance.
export class PositionState {
	// Files whose saved position was injected into the open's ephemeral state
	// (setViewState patch) and therefore must not be restored a second time by
	// the file-open handler. Consumed when the matching file-open arrives; a
	// background open (active:false) produces no file-open, so its entry stays
	// until that tab is activated — which is exactly when it is needed.
	injectedOpenPaths = new Set<string>();

	// ===== Restore run tracking =====
	restoreRun = 0;     // bumped per restore; stale restores detect supersession
	private activeRestores = 0; // restore chains in flight

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
	// Deadline until which recording treats view movement as search-driven:
	// while a search input (editor find, quick switcher, search panel) holds
	// focus this is Infinity, and the sampler keeps it there for a short
	// grace window after the input blurs before expiring it to Date.now().
	// The poll arms/clears it — see Sampler.installSearchAnchor.
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
