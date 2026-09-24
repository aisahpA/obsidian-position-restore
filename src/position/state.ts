import { WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { leafIdOf } from '@/shared/leaf';
import { OpenCover } from './ui/cover';
import { RestoreCue } from './ui/cue';

export type OpenKind = 'anchorLink' | 'startPlainLink' | 'callerTarget';

// How long recording stays in absorb mode after an open-kind jump is dispatched at
// setViewState time: the jump lands asynchronously, and during this window the poll
// re-baselines without writing, so the landing is never recorded as user movement. A
// ceiling, not a hard delay — the sampler expires it early once the view stops moving.
export const LANDING_ABSORB_MS = 3000;

// Single owner of the cross-phase coordination state shared by recording, restore and
// the open patches: fragmenting it would let recording observe a half-applied restore.
export class PositionState {
	// Leaves whose saved position was injected into the open's ephemeral state and
	// therefore must not be restored a second time. Keyed by LEAF ID, not path: with one
	// file in two tabs each tab injects its own per-tab position. A background open
	// produces no file-open, so its entry stays until that tab is activated.
	injectedOpenLeafIds = new Set<string>();

	// The path active before the last 'active-leaf-change'. The event fires with only the
	// NEW leaf, so completeInjectedRestore needs this track to tell a same-file activation
	// from a genuine file switch.
	lastActiveFilePath: string | undefined = undefined;

	// ===== Restore run tracking =====
	restoreRun = 0;
	// A counter, so the flag stays up while superseded restores unwind.
	private activeRestores = 0;

	// Leaf id -> { filePath, run } of the restore in flight for that leaf. Lets a
	// duplicate re-assert for the same leaf+file skip instead of superseding — a second
	// entry would take the non-injected path and reveal the first-paint cover mid-settle.
	inFlightRestoreLeafRuns: Map<string, { filePath: string; run: number }> = new Map();

	beginLeafRestore(leafId: string, filePath: string): number {
		const run = ++this.restoreRun;
		this.inFlightRestoreLeafRuns.set(leafId, { filePath, run });
		return run;
	}

	// Scoped per leaf on purpose: only a newer restore on the SAME leaf makes a run
	// stale. A restore on a DIFFERENT leaf must never supersede it — that would leave
	// this leaf's cover up forever.
	isCurrentLeafRestore(leafId: string, run: number): boolean {
		const cur = this.inFlightRestoreLeafRuns.get(leafId);
		return !!cur && cur.run === run;
	}

	// Recording skips while this holds: restore's own glide fires scroll events that
	// would otherwise overwrite the saved position.
	isRestoringFile(): boolean {
		return this.activeRestores > 0;
	}

	restoreStarted() {
		this.activeRestores++;
	}

	restoreEnded() {
		this.activeRestores--;
	}

	// Whose restore must skip the anchor (background restores: the recording baseline
	// belongs to the active leaf only). Set by BackgroundSettler, cleared in its finally.
	noAnchorLeafIds = new Set<string>();

	// ===== Recording baseline: written by restore, read by polling =====
	lastEphemeralState: EphemeralState | undefined;
	lastLoadedFilePath: string | undefined;

	// Starts the mobile "post-open reflow window": the sampler absorbs scroll-only deltas
	// within SCROLL_SETTLE_GUARD_MS of this stamp that no user touch accounts for.
	lastAnchorAt = 0;

	// Last user touch (mobile only), and last user input (desktop: wheel / pointerdown /
	// keydown) — each the signal its platform's scroll guard reads.
	lastTouchAt = 0;
	lastUserInputAt = 0;

	// leaf.id -> filePath whose open is fully handled. Written by the file-open dedup path
	// AND by the setViewState patch, so pairs whose open never fires 'file-open'
	// (background opens, startup restore) still dedup later switches.
	handledLeafIdMap: Map<string, string> = new Map();

	// ===== Open-kind tracking (transient flags passed between patches) =====

	// Per-leaf pending open kind. Per-leaf because a caller-target open that never fires
	// 'file-open' must not leak onto another leaf's restore.
	pendingOpenKind: Map<WorkspaceLeaf, OpenKind> = new Map();

	// Written by the openLinkText patch (which does not know the target leaf yet) and
	// promoted onto pendingOpenKind by injectEphemeralStateOnOpen, synchronously inside
	// the same call stack. The timeout is a safety net for calls that never reach
	// setViewState.
	pendingLinkKind: OpenKind | undefined;
	pendingLinkKindTimeout = 0;

	// The raw linktext, stashed alongside: the nav-history dedup key for same-file anchor
	// jumps. Cleared together with pendingLinkKind.
	pendingLinkText: string | undefined;

	// The same call's ORIGIN, for the nav history. Separate because it must not touch the
	// dedup regime (a plain [[note]] link stays a keyless visit) and because it is wanted
	// for links WITHOUT a target, which pendingLinkText ignores.
	pendingViaPath: string | undefined;
	pendingViaText: string | undefined;

	// Armed by NavStack right before it invokes app:go-back / app:go-forward: the
	// resulting setViewState must inject THIS plugin's saved position over the native
	// entry's eState, which carries only the cursor.
	pendingHistoryNav = false;
	pendingHistoryNavTimeout = 0;

	// The landing the pending traversal's open must be given, when the target entry carries
	// its own recorded position. undefined = the file record stands. Cleared together with
	// the flag — a landing left behind would be injected into an unrelated later open.
	pendingHistoryNavState: EphemeralState | undefined;

	// The file that landing belongs to: the flag is global, so a landing applies only to
	// the open it was armed for.
	pendingHistoryNavPath: string | undefined;

	// leafId -> the landing the last injected open on that leaf was handed. The
	// restorer's injected-source settle must verify the SAME line core was given — after
	// a cross-file history jump the two deliberately differ.
	injectedLeafStates: Map<string, EphemeralState> = new Map();

	// Until when a restore's landing cue is suppressed: NavStack arms it whenever a
	// traversal triggers a restore, so back/forward hops land without the chip — the
	// reader chose the destination. Deadline-based because the cross-file restore runs
	// from the debounced 'file-open' handler, AFTER the traversal's bracket closed.
	cueSuppressUntil = 0;

	// ===== Search anchor (search-driven jump guard) =====
	// Until when recording treats view movement as not the reader's: Infinity while a
	// search input holds focus, then a short grace after it blurs. The patcher also sets a
	// finite value (LANDING_ABSORB_MS) when an open-kind jump is dispatched.
	searchAnchorUntil = 0;

	isSearchAnchored(): boolean {
		return Date.now() < this.searchAnchorUntil;
	}

	// ===== Cover (pre-first-paint mask) =====
	cover = new OpenCover();

	// ===== Post-restore orientation cue =====
	cue: RestoreCue;

	constructor(settings: PluginSettings) {
		this.cue = new RestoreCue(settings);
	}

	// leaf.id is runtime API absent from the public typings; the cast collapses the
	// per-site @ts-ignore noise.
	leafId(leaf: WorkspaceLeaf): string {
		return leafIdOf(leaf);
	}
}
