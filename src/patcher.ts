import { App, MarkdownView, Vault, Workspace, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { TabStore } from './tab-store';
import { PositionState, OpenKind } from './position-state';

// The view/ephemeral state payloads flowing through setViewState on opens
// are internal and untyped; declare the minimal fields this plugin reads.
interface OpenViewState {
	type: unknown;
	state?: {
		file?: unknown;
		mode?: unknown;
	};
}

// The same ephemeral-state argument also carries caller-submitted targets
// (search match, outline/backlinks' is-flashing) on top of the position
// fields.
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

// Installs the patches restore relies on — setViewState (inject saved
// position into the open's ephemeral state; the primary flicker-free
// source-mode restore) and openLinkText (flag heading/block link navigations
// so saved positions yield to link targets) — and the injection helpers that
// run inside them. All cross-phase coordination flags are owned by the
// shared PositionState this class takes.
export class OpenPatcher {
	private app: App;
	private settings: PluginSettings;
	private state: PositionState;
	private tabStore: TabStore;

	constructor(app: App, settings: PluginSettings, tabStore: TabStore) {
		this.app = app;
		this.settings = settings;
		this.tabStore = tabStore;
		this.state = tabStore.state;
	}

	// Installs the patches the restore relies on. registerCleanup must undo
	// both on plugin unload.
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
		const patcher = this;
		leafProto.setViewState = function (this: WorkspaceLeaf, viewState: OpenViewState, eState?: OpenEphemeralState) {
			eState = patcher.injectEphemeralStateOnOpen(this, viewState, eState);
			return originalSetViewState.call(this, viewState, eState);
		};
		registerCleanup(() => {
			// Restores the method captured at install time. If another plugin
			// wrapped our patch after us, its wrapper is dropped too — an
			// accepted limitation of prototype patching (uninstall order is
			// opaque to us).
			leafProto.setViewState = originalSetViewState;
		});
	}

	private patchOpenLinkText(registerCleanup: (fn: () => void) => void) {
		const workspace = this.app.workspace as Workspace & { openLinkText: OpenLinkText };
		// Intentionally captured unbound: the wrapper re-binds it per call
		// (`originalOpenLinkText.apply(this, args)`) so core's chosen `this`
		// is preserved.
		// eslint-disable-next-line @typescript-eslint/unbound-method -- intentional capture for per-call rebinding
		const originalOpenLinkText = workspace.openLinkText;
		if (typeof originalOpenLinkText !== 'function')
			return;
		const patcher = this;
		workspace.openLinkText = async function (this: Workspace, ...args: unknown[]) {
			// Stash the link kind in the transient pendingLinkKind slot
			// (openLinkText doesn't know the target leaf yet) — promoted onto
			// pendingOpenKind by the setViewState patch in this call stack.
			// 'anchorLink' = heading/block target; 'startPlainLink' = 'start' setting
			// (open at file start, leave saved record untouched). Clear first
			// so a stale entry from a previous openLinkText that never reached
			// setViewState can't contaminate this one.
			patcher.state.pendingLinkKind = undefined;
			const linktext: unknown = args[0];
			const hasTarget = typeof linktext === 'string'
				&& (linktext.includes('#') || linktext.includes('^'));
			if (hasTarget) {
				patcher.state.pendingLinkKind = 'anchorLink';
			} else if (patcher.settings.linkOpenPosition === 'start') {
				patcher.state.pendingLinkKind = 'startPlainLink';
			}
			try {
				return await originalOpenLinkText.apply(this, args);
			} finally {
				window.clearTimeout(patcher.state.pendingLinkKindTimeout);
				patcher.state.pendingLinkKindTimeout = window.setTimeout(() => {
					patcher.state.pendingLinkKind = undefined;
				}, 500);
			}
		};
		registerCleanup(() => {
			workspace.openLinkText = originalOpenLinkText;
		});
	}

	// Injects the saved position into an open request's ephemeral-state
	// argument, so core applies it in the exact pipeline slot it uses for its
	// own position restore: synchronously with the content swap, before any
	// paint. This is the ONLY place a source-mode restore can be flicker-free
	// — 'file-open' is emitted through a debounced (setTimeout 0) callback,
	// i.e. after the note has already been painted at its default position.
	private injectEphemeralStateOnOpen(leaf: WorkspaceLeaf, viewState: OpenViewState, eState: OpenEphemeralState | undefined): OpenEphemeralState | undefined {
		if (!viewState || typeof viewState.type !== 'string')
			return eState;
		const filePath = viewState.state?.file;
		if (typeof filePath !== 'string' || !filePath)
			return eState;
		const leafId = this.state.leafId(leaf);

		// A setViewState for an already-handled leaf+file is Obsidian
		// REPLAYING the leaf's own cached view state, not a new open: the
		// deferred-view rebuild when an inactive tab is first activated (its
		// cached eState — which includes the position injected at startup —
		// comes back here), or a same-file re-assert (quick switcher re-pick:
		// setViewState with an empty eState and NO following file-open).
		// (leaf.view can't detect this: at patch time the tab's view is not
		// installed yet, so a view-based check never matches.) Keep the
		// handled marker — no resetLeafOpenState — and drop any pending open
		// kind that never met its file-open.
		const isReplay = this.state.handledLeafIdMap.get(leafId) === filePath;
		if (isReplay) {
			this.state.pendingOpenKind.delete(leaf);
		} else {
			// Any other setViewState replaces this leaf's content (a
			// different file, or no file at all — the 'empty' state after
			// closing the last tab): prior open bookkeeping is stale, drop
			// it so a later reopen of the same file restores again.
			this.resetLeafOpenState(leaf);
		}

		if (this.takeOverridingOpenKind(leaf, eState, isReplay)) {
			// A yielded open (link/caller target) needs no file-open restore
			// body — record the pair so later switches and re-asserts dedup
			// into tracking-only updates, even when this open never fires
			// 'file-open' (a background target open).
			this.state.handledLeafIdMap.set(leafId, filePath);
			return eState;
		}

		// Non-markdown FileViews (pdf, image, ...): their restore is
		// scroll-only, applied by restoreFileViewScroll from the file-open
		// handler — nothing to inject here.
		if (viewState.type !== 'markdown')
			return eState;

		// Reading view never injects: it renders asynchronously and the
		// file-open handler restores (masked/glide) from the top.
		const isSourceMode = this.isSourceModeOpen(leaf, viewState);
		if (!isSourceMode)
			return eState;

		// the same file open in two tabs must restore each tab's own spot after
		// a restart.
		const st = this.tabStore.getRestoreSt(leaf, filePath);
		if (this.shouldGlideSource(st))
			return eState;

		const merged = this.buildMergedState(st, true);
		if (merged.scroll === undefined && merged.cursor === undefined)
			return eState;

		// A replay re-injects (re-covering the deferred rebuild's editor gap)
		// only when the replayed eState echoes the saved record — the
		// signature of our own earlier injection (or an equal native cache)
		// coming back through core's leaf cache. Anything else stays native:
		// an eState-less re-assert would cover an open that never fires
		// 'file-open' (cover stuck until the safety timer — e.g. the quick
		// switcher re-picking the current file), and a diverged position must
		// not yank the user back to the record.
		//
		// EXCEPTION — the startup rebuild (debugged 2026-09): before
		// layout-ready, core re-asserts the ACTIVE leaf's state through a
		// second setViewState whose eState is EMPTY (it re-opens the file
		// fresh instead of replaying the leaf cache, unlike a background
		// tab's replay, which echoes the cached eState back). The rebuilt
		// editor lands at the top and the injection is lost; the following
		// file-open's restore can't recover it (its settle only fine-tunes
		// a rendered target line, never launches an off-viewport landing).
		// Pre-layout-ready the user cannot have diverged yet and no
		// quick-switcher re-assert can occur, so an empty eState there is
		// always that rebuild — re-inject; the file-open that follows for
		// the active leaf runs the settle/reveal.
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
		// stays in restoreEphemeralState). Keyed by leaf id: with the same
		// file open in two tabs, each tab's file-open must consume its own
		// marker and run its own settle/reveal.
		this.state.injectedOpenLeafIds.add(leafId);
		// The injected open's file-open runs restoreInjectedSource (settle +
		// cover reveal) via the injected marker; recording the pair NOW keeps
		// later activations deduped even when this open is a background one
		// whose file-open never fires.
		this.state.handledLeafIdMap.set(leafId, filePath);

		return { ...merged, ...eState };
	}

	// Every content change on this leaf supersedes its prior open bookkeeping
	// — markdown and other FileViews alike. setViewState ALSO fires when
	// Obsidian re-asserts an already-open tab's cached state (tab switch);
	// injectEphemeralStateOnOpen takes its replay branch before this for that
	// same-file case, keeping the handled marker so the switch dedups to a
	// tracking-only update in restoreEphemeralState. Here (different file, or
	// no file): dropping the handled entry lets a close-and-reopen of the
	// same file restore again instead of being wrongly deduped, and dropping
	// a stale pendingOpenKind marker from an open that never fired 'file-open'
	// can't misdirect this open's restore. Per-leaf only — other leaves'
	// markers stay until their tab is activated.
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

	// Consumes the overriding open kind (anchorLink/startPlainLink/callerTarget)
	// for this open: returns it when the open should yield to a non-saved target,
	// and as a side effect sets pendingOpenKind so restoreEphemeralState can
	// dispatch. Otherwise clears nothing and returns undefined.
	private takeOverridingOpenKind(leaf: WorkspaceLeaf, eState: OpenEphemeralState | undefined, isReplay: boolean): OpenKind | undefined {
		// Promote the transient link kind (set by the openLinkText patch, which
		// doesn't know the target leaf yet) onto this leaf's pending entry,
		// then clear the transient slot. Link nav wins over the saved position
		// and over a coincidental eState cursor/scroll — core's link target is
		// authoritative. Checked before callerTarget for that reason.
		const linkKind = this.state.pendingLinkKind;
		if (linkKind) {
			this.state.pendingOpenKind.set(leaf, linkKind);
			this.state.pendingLinkKind = undefined;
			window.clearTimeout(this.state.pendingLinkKindTimeout);
			return linkKind;
		}

		// Caller-submitted target (search match in eState.match, or
		// cursor/scroll/is-flashing from outline/backlinks): core put it in
		// the ephemeral-state argument meaning "open here", so merging the
		// saved position on top would override it. Anchor at core's target
		// instead of restoring (see anchorToTargetSettled).
		// On a replay the eState is the leaf's OWN cached ephemeral state, so
		// its bare cursor/scroll is that cached position, not a caller target
		// — only the distinctive markers (match / is-flashing) count there.
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

	// Build the merged state to inject: saved position wins when present;
	// otherwise apply the configured default (only 'fileEnd' has an injection
	// form, and only in source mode). The placeholder cursor is clamped to
	// the last line by the editor; content length is unknown here.
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

	// Cover opens whose first frames could otherwise paint the un-restored
	// top or the settle's corrections. EVERY source-mode open with a scroll
	// injection is covered — brand-new leaves AND same-leaf switches alike:
	//  - a brand-new leaf's editor is constructed later, measures its
	//    document, then the injected scroll lands — the first frame would
	//    show the default top;
	//  - a same-leaf switch rides core's staged open pipeline (its own
	//    position, then the injected one) and its post-swap re-measure can
	//    shift pixels after the atomic apply — the settle corrections that
	//    fix this must run hidden, or each reads as a visible jump.
	// A cursor-only injection never moves the viewport (the note opens at
	// its top and stays there), so the first frame is already the final
	// state and covering it would only add a blank period. Reading opens
	// are never covered — the note renders visibly from the top and
	// glideRestore scrolls to the saved line, so masking would only add a
	// blank period. The injected branch of restoreEphemeralState waits for
	// the position to settle, then lifts the cover; the safety timer bounds
	// it for background opens.
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
