import { App, MarkdownView, Vault, Workspace, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState, OpenKind, LANDING_ABSORB_MS } from '@/position/state';
import { readNavEntryState } from '@/position/capture/ephemeral';
import type { NavFunnel } from '@/nav/funnel';
import { isMainAreaLeaf } from '@/shared/leaf';
import type { Sampler } from '@/position/capture/sampler';

// The view/ephemeral state payloads flowing through setViewState on opens
// are internal and untyped; declare the minimal fields this plugin reads.
interface OpenViewState {
	type: unknown;
	state?: {
		file?: unknown;
		mode?: unknown;
	};
}

// The same argument also carries caller-submitted targets (search match,
// outline/backlinks' is-flashing) on top of the position fields.
type OpenEphemeralState = EphemeralState & {
	match?: unknown;
	'is-flashing'?: unknown;
};

type SetViewState = (
	this: WorkspaceLeaf,
	viewState: OpenViewState,
	eState?: OpenEphemeralState,
) => unknown;

type OpenLinkText = (this: Workspace, ...args: unknown[]) => Promise<void>;

// Installs the patches restore relies on — setViewState (inject the saved
// position into the open's ephemeral state) and openLinkText (flag
// heading/block link navigations so saved positions yield to link targets).
// All cross-phase coordination flags live on the shared PositionState.
export class OpenPatcher {
	private app: App;
	private settings: PluginSettings;
	private state: PositionState;
	private store: PositionStore;
	private funnel: NavFunnel;
	private sampler: Sampler;

	constructor(app: App, settings: PluginSettings, store: PositionStore, state: PositionState, funnel: NavFunnel, sampler: Sampler) {
		this.app = app;
		this.settings = settings;
		this.store = store;
		this.funnel = funnel;
		this.sampler = sampler;
		this.state = state;
	}

	// registerCleanup must undo both on plugin unload.
	installPatches(registerCleanup: (fn: () => void) => void) {
		this.patchSetViewState(registerCleanup);
		this.patchOpenLinkText(registerCleanup);
	}

	private patchSetViewState(registerCleanup: (fn: () => void) => void) {
		const leafProto = WorkspaceLeaf.prototype as {
			setViewState?: SetViewState;
		};
		const originalSetViewState = leafProto.setViewState;
		if (!originalSetViewState)
			return;
		// Arrow keeps `this` lexical; the wrapper below must stay a plain
		// function so core's `this` (the leaf) is preserved.
		const injectOnOpen = (leaf: WorkspaceLeaf, viewState: OpenViewState, eState?: OpenEphemeralState) =>
			this.injectEphemeralStateOnOpen(leaf, viewState, eState);
		leafProto.setViewState = function (this: WorkspaceLeaf, viewState: OpenViewState, eState?: OpenEphemeralState) {
			eState = injectOnOpen(this, viewState, eState);
			return originalSetViewState.call(this, viewState, eState);
		};
		registerCleanup(() => {
			leafProto.setViewState = originalSetViewState;
		});
	}

	private patchOpenLinkText(registerCleanup: (fn: () => void) => void) {
		const workspace = this.app.workspace as Workspace & { openLinkText: OpenLinkText };
		// Captured unbound on purpose: the wrapper re-binds it per call
		// (`apply(this, args)`) so core's chosen `this` (the workspace) wins.
		// eslint-disable-next-line @typescript-eslint/unbound-method -- intentional capture for per-call rebinding
		const originalOpenLinkText = workspace.openLinkText;
		if (typeof originalOpenLinkText !== 'function')
			return;
		const state = this.state;
		const settings = this.settings;
		workspace.openLinkText = async function (this: Workspace, ...args: unknown[]) {
			// Transient slot: openLinkText doesn't know the target leaf yet, so
			// the setViewState patch in this call stack promotes it onto
			// pendingOpenKind. 'anchorLink' = heading/block target;
			// 'startPlainLink' = the 'start' setting (open at file start, leave
			// the saved record untouched). Cleared first so a stale entry from an
			// open that never reached setViewState can't leak into this one.
			state.pendingLinkKind = undefined;
			state.pendingLinkText = undefined;
			state.pendingViaPath = undefined;
			state.pendingViaText = undefined;
			const linktext: unknown = args[0];
			const sourcePath: unknown = args[1];
			const hasTarget = typeof linktext === 'string'
				&& (linktext.includes('#') || linktext.includes('^'));
			// The link's origin for nav history (search + badge): which note it
			// was clicked in and what it said. Recorded for EVERY link open,
			// including a plain [[note]] — that case stays a keyless visit and
			// never feeds the key/dedup regime below.
			if (typeof linktext === 'string') {
				state.pendingViaText = linktext;
				if (typeof sourcePath === 'string')
					state.pendingViaPath = sourcePath;
			}
			if (hasTarget) {
				state.pendingLinkKind = 'anchorLink';
				state.pendingLinkText = linktext;
			} else if (settings.linkOpenPosition === 'start') {
				state.pendingLinkKind = 'startPlainLink';
			}
			try {
				return await originalOpenLinkText.apply(this, args);
			} finally {
				window.clearTimeout(state.pendingLinkKindTimeout);
				state.pendingLinkKindTimeout = window.setTimeout(() => {
					state.pendingLinkKind = undefined;
					state.pendingLinkText = undefined;
					state.pendingViaPath = undefined;
					state.pendingViaText = undefined;
				}, 500);
			}
		};
		registerCleanup(() => {
			workspace.openLinkText = originalOpenLinkText;
		});
	}

	// Injects the saved position into the open's ephemeral-state argument, so
	// core applies it in the exact pipeline slot it uses for its own restore:
	// synchronously with the content swap, before any paint. The ONLY place a
	// source-mode restore can be flicker-free — 'file-open' is emitted through
	// a debounced callback, i.e. after the note was painted at its default
	// position.
	private injectEphemeralStateOnOpen(leaf: WorkspaceLeaf, viewState: OpenViewState, eState: OpenEphemeralState | undefined): OpenEphemeralState | undefined {
		if (!viewState || typeof viewState.type !== 'string')
			return eState;
		const filePath = viewState.state?.file;
		if (typeof filePath !== 'string' || !filePath)
			return eState;
		const leafId = this.state.leafId(leaf);

		// A setViewState for an already-handled leaf+file is core REPLAYING the
		// leaf's cached view state, not a new open — the deferred rebuild of an
		// inactive tab, or a quick-switcher re-pick of the current file.
		// leaf.view can't detect it: at patch time the tab's view isn't
		// installed yet. Keep the handled marker; drop a pending kind that
		// never met its file-open.
		const isReplay = this.state.handledLeafIdMap.get(leafId) === filePath;
		if (isReplay) {
			this.state.pendingOpenKind.delete(leaf);
		} else {
			// Anything else replaces this leaf's content (a different file, or
			// the 'empty' state after closing the last tab): drop the stale
			// bookkeeping so a later reopen of the same file restores again.
			this.resetLeafOpenState(leaf);
		}

		// Every open that changes this leaf's file is a jump; a replay is one
		// only when it carries a same-file target (outline/backlinks clicks on
		// the open note fire no file-open). recordOpen applies its own gates.
		// "Update on leave" first: the view being swapped away still holds the
		// position the user jumps from — refresh the top entry so a later
		// traversal targeting it lands there. No-op once the top moved on.
		const leavingView = leaf.view;
		if (leavingView instanceof MarkdownView && leavingView.file) {
			const fromSt = readNavEntryState(leavingView);
			if (fromSt) {
				this.funnel.leave(leavingView.file.path, leafId, fromSt);
				// The record's regular writers lag (poll tick, debounced
				// capture): a move + quick jump-away inside that window loses
				// the final position. Dedup makes no-movement a no-op.
				this.sampler.flushOnLeave(leavingView, leavingView.file.path, fromSt);
			}
		}
		const sameFileTarget = !!eState?.match || !!eState?.['is-flashing'];
		// The link origin, if this open came from a click. Consumed here —
		// first setViewState in the click's own call stack — so a stale slot
		// cannot label a later, unrelated open. Only a keyless open keeps it:
		// a #/^ link is a keyed jump whose key already names the target.
		const viaPath = this.state.pendingViaPath;
		const viaText = this.state.pendingViaText;
		this.state.pendingViaPath = undefined;
		this.state.pendingViaText = undefined;
		const fromLink = !this.state.pendingLinkText && !!viaText;
		// Main-area leaves only — a sidebar panel re-asserting the tracked
		// file (outline/backlinks) is not a jump.
		if (isMainAreaLeaf(this.app, leaf))
			this.funnel.recordOpen(filePath, leafId, {
				// Caller targets (search match, backlinks is-flashing) carry no
				// linktext: key them uniquely so the entry takes the keyed
				// precise-landing regime — the settle-capture backfills the
				// landing and later leaves never overwrite it.
				key: this.state.pendingLinkText ?? (sameFileTarget ? `caller:${Date.now()}` : undefined),
				force: sameFileTarget,
				via: fromLink ? 'link' : undefined,
				viaPath: fromLink ? viaPath : undefined,
				viaText: fromLink ? viaText : undefined,
			});

		// A stack traversal (pendingHistoryNav, consumed here — single shot):
		// inject OUR saved position over the native entry's eState, which
		// carries only the cursor. Bypasses the callerTarget yield and the
		// glide choice on purpose — traversal must land instantly, on the file
		// record (or the entry's own landing when it carries one), not on the
		// native cursor. No record → the native target stands. Non-markdown
		// traversals fall through untouched — their positions are native.
		// File-guarded: the flag is global, so an unrelated open that stole it
		// must not be handed another file's position.
		if (this.state.pendingHistoryNav) {
			const navLanding = this.state.pendingHistoryNavPath === filePath
				? this.state.pendingHistoryNavState
				: undefined;
			this.state.pendingHistoryNav = false;
			this.state.pendingHistoryNavState = undefined;
			this.state.pendingHistoryNavPath = undefined;
			window.clearTimeout(this.state.pendingHistoryNavTimeout);
			if (!isReplay && viewState.type === 'markdown') {
				const st = navLanding ?? this.store.read(leafId, filePath);
				if (st && ((st.scroll ?? 0) > 0 || st.cursor)) {
					const merged = this.buildMergedState(st, this.isSourceModeOpen(leaf, viewState));
					this.maybeCoverOpen(leaf, (merged.scroll ?? 0) > 0);
					this.state.injectedOpenLeafIds.add(leafId);
					this.state.injectedLeafStates.set(leafId, st);
					this.state.handledLeafIdMap.set(leafId, filePath);
					return { ...eState, ...merged };
				}
			}
			this.state.handledLeafIdMap.set(leafId, filePath);
			return eState;
		}

		if (this.takeOverridingOpenKind(leaf, eState, isReplay)) {
			// A yielded open needs no file-open restore body — record the pair
			// so later switches and re-asserts dedup into tracking-only
			// updates, even when this open never fires 'file-open'.
			this.state.handledLeafIdMap.set(leafId, filePath);
			// Arm the landing absorb synchronously with the open: core's target
			// lands asynchronously, and recording must stay absorbing until it
			// settles. MUST live here and not in the file-open handler — a
			// same-file search click fires no 'file-open', so the restorer
			// never runs and the jump itself would be recorded.
			this.state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;
			return eState;
		}

		// Non-markdown FileViews (pdf, image, ...): scroll-only restore,
		// applied by restoreFileViewScroll from the file-open handler.
		if (viewState.type !== 'markdown')
			return eState;

		// Reading view never injects: it renders asynchronously and the
		// file-open handler restores from the top.
		const isSourceMode = this.isSourceModeOpen(leaf, viewState);
		if (!isSourceMode)
			return eState;

		// the same file open in two tabs must restore each tab's own spot after
		// a restart.
		const st = this.store.read(leafId, filePath);
		if (this.shouldGlideSource(st))
			return eState;

		const merged = this.buildMergedState(st, true);
		if (merged.scroll === undefined && merged.cursor === undefined)
			return eState;

		// A replay re-injects (re-covering the deferred rebuild's editor gap)
		// only when the replayed eState echoes the saved record — the signature
		// of our own earlier injection coming back through core's leaf cache.
		// Anything else stays native: an eState-less re-assert would cover an
		// open that never fires 'file-open' (cover stuck until the safety
		// timer), and a diverged position must not yank the user back.
		//
		// EXCEPTION — the startup rebuild: before layout-ready core re-asserts
		// the active leaf through a second setViewState whose eState is EMPTY
		// (it reopens the file fresh instead of replaying the cache). The
		// rebuilt editor lands at the top and the injection is lost; the
		// following file-open can't recover it, since its settle only
		// fine-tunes an already-rendered line. Pre-layout-ready the user
		// cannot have diverged yet, so an empty eState there is always that
		// rebuild — re-inject.
		const replayIsEmptyRebuild = !this.app.workspace.layoutReady
			&& !eState?.scroll && !eState?.cursor;
		if (isReplay && !(
			!!eState
			&& (eState.scroll ?? 0) === (merged.scroll ?? 0)
			&& (eState.cursor?.from.line ?? -1) === (merged.cursor?.from.line ?? -1)
		) && !replayIsEmptyRebuild)
			return eState;

		this.maybeCoverOpen(leaf, (merged.scroll ?? 0) > 0);

		// Let the file-open handler know the restore was applied here, so it
		// re-anchors bookkeeping without re-applying (bookkeeping ownership
		// stays in restoreEphemeralState). Keyed by leaf id: with the same file
		// open in two tabs, each tab's file-open must consume its own marker
		// and run its own settle/reveal. Recording the pair now also keeps
		// later activations deduped when this open is a background one whose
		// file-open never fires.
		this.state.injectedOpenLeafIds.add(leafId);
		this.state.handledLeafIdMap.set(leafId, filePath);

		return { ...merged, ...eState };
	}

	// Every content change on this leaf supersedes its prior open
	// bookkeeping, markdown and other FileViews alike. Dropping the handled
	// entry lets a close-and-reopen of the same file restore again instead of
	// being wrongly deduped; dropping a stale pendingOpenKind can't misdirect
	// this open. Per-leaf only — other leaves' markers stay until their tab
	// is activated.
	private resetLeafOpenState(leaf: WorkspaceLeaf) {
		this.state.handledLeafIdMap.delete(this.state.leafId(leaf));
		this.state.pendingOpenKind.delete(leaf);
	}

	// A source open with a saved scroll is handled by glideRestore, which
	// animates from the top to the saved line, so nothing to inject. Same
	// predicate as the source branch of restoreEphemeralState.
	private shouldGlideSource(st: EphemeralState | undefined): boolean {
		return this.settings.sourceRestoreMethod === 'glide'
			&& !!st && (st.scroll ?? 0) > 0;
	}

	// Consumes the overriding open kind (anchorLink/startPlainLink/
	// callerTarget): returns it when the open should yield to a non-saved
	// target, and sets pendingOpenKind so restoreEphemeralState can dispatch.
	private takeOverridingOpenKind(leaf: WorkspaceLeaf, eState: OpenEphemeralState | undefined, isReplay: boolean): OpenKind | undefined {
		// Promote the transient link kind onto this leaf's pending entry, then
		// clear the slot. Link nav wins over the saved position and over a
		// coincidental eState cursor/scroll — core's link target is
		// authoritative. Checked before callerTarget for that reason.
		const linkKind = this.state.pendingLinkKind;
		if (linkKind) {
			this.state.pendingOpenKind.set(leaf, linkKind);
			this.state.pendingLinkKind = undefined;
			this.state.pendingLinkText = undefined;
			window.clearTimeout(this.state.pendingLinkKindTimeout);
			return linkKind;
		}

		// Caller-submitted target (search match in eState.match, or
		// cursor/scroll/is-flashing from outline/backlinks): core put it in the
		// ephemeral-state argument meaning "open here", so merging the saved
		// position on top would override it. On a replay the eState is the
		// leaf's OWN cached state, so its bare cursor/scroll is that cached
		// position — only the distinctive markers count there.
		if (this.hasCallerTarget(eState, isReplay)) {
			this.state.pendingOpenKind.set(leaf, 'callerTarget');
			return 'callerTarget';
		}

		return undefined;
	}

	private hasCallerTarget(eState: OpenEphemeralState | undefined, isReplay = false): boolean {
		if (!eState)
			return false;
		if (eState.match || eState['is-flashing'])
			return true;
		if (isReplay)
			return false;
		return !!(eState.cursor || eState.scroll != null);
	}

	// Saved position wins when present; otherwise apply the configured default
	// (only 'fileEnd' has an injection form, and only in source mode). The
	// placeholder cursor is clamped to the last line by the editor — content
	// length is unknown here.
	private buildMergedState(st: EphemeralState | undefined, isSourceMode: boolean): Partial<EphemeralState> {
		const merged: Partial<EphemeralState> = {};
		if (st) {
			if ((st.scroll ?? 0) > 0) merged.scroll = st.scroll;
			if (st.cursor) merged.cursor = st.cursor;
		} else if (isSourceMode && this.settings.defaultPosition === 'fileEnd') {
			merged.scroll = Infinity;
			merged.cursor = {
				from: { line: Number.MAX_SAFE_INTEGER, ch: 0 },
				to:   { line: Number.MAX_SAFE_INTEGER, ch: 0 },
			};
		}
		return merged;
	}

	// Cover opens whose first frames would otherwise paint the un-restored top
	// or the settle's corrections. EVERY source-mode open with a scroll
	// injection is covered, brand-new leaves and same-leaf switches alike:
	//  - a brand-new leaf's editor is built later, measures its document, then
	//    the injected scroll lands — the first frame shows the default top;
	//  - a same-leaf switch rides core's staged pipeline, and its post-swap
	//    re-measure can shift pixels after the atomic apply; the settle that
	//    fixes this must run hidden or each correction reads as a jump.
	// A cursor-only injection never moves the viewport, so the first frame is
	// already the final state and covering would only add a blank period;
	// reading opens are never covered either. The injected branch of
	// restoreEphemeralState settles then lifts the cover; the safety timer
	// bounds it for background opens.
	private maybeCoverOpen(leaf: WorkspaceLeaf, hasScroll: boolean) {
		if (!hasScroll)
			return;
		this.state.cover.cover(leaf);
	}

	// The explicit mode is usually absent from the open's view state — it's
	// present only on view-mode toggles, where state.mode is the *target* mode
	// (leaf.view still reports the pre-toggle mode). Otherwise fall back to the
	// current markdown view's mode (covers same-leaf reopens); a brand-new leaf
	// has no view yet, so fall back to Obsidian's native default-view-mode
	// setting.
	private isSourceModeOpen(leaf: WorkspaceLeaf, viewState: OpenViewState): boolean {
		const mode = viewState.state?.mode;
		if (mode === 'source' || mode === 'preview')
			return mode === 'source';
		const view = leaf.view;
		if (view instanceof MarkdownView)
			return view.getMode() === 'source';
		const vault = this.app.vault as Vault & { getConfig(key: string): unknown };
		return vault.getConfig('defaultViewMode') !== 'preview';
	}
}
