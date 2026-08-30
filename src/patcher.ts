import { App, MarkdownView, Vault, Workspace, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { CursorPositionDatabase } from './database';
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
	private database: CursorPositionDatabase;
	private settings: PluginSettings;
	private state: PositionState;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings, state: PositionState) {
		this.app = app;
		this.database = database;
		this.settings = settings;
		this.state = state;
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

		this.resetLeafOpenState(leaf);
		if (this.takeOverridingOpenKind(leaf, eState))
			return eState;

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

		const st = this.database.db[filePath];
		if (this.shouldGlideSource(st))
			return eState;

		const merged = this.buildMergedState(st, true);
		if (merged.scroll === undefined && merged.cursor === undefined)
			return eState;

		this.maybeCoverOpen(leaf, (merged.scroll ?? 0) > 0);
		// Let the file-open handler know the restore was applied here, so it
		// re-anchors bookkeeping without re-applying (bookkeeping ownership
		// stays in restoreEphemeralState).
		this.state.injectedOpenPaths.add(filePath);

		return { ...merged, ...eState };
	}

	// Every open supersedes this leaf's prior open bookkeeping — markdown and
	// other FileViews alike —: setViewState runs once per open — never on
	// mere tab activation (that fires only 'file-open') — so dropping the
	// handled entry here lets a close-and-reopen of the same file restore
	// again instead of being wrongly deduped, and dropping a stale
	// pendingOpenKind marker from an open that never fired 'file-open' can't
	// misdirect this open's restore. Per-leaf only — other leaves' markers
	// stay until their tab is activated.
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
	private takeOverridingOpenKind(leaf: WorkspaceLeaf, eState: OpenEphemeralState | undefined): OpenKind | undefined {
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
		if (this.hasCallerTarget(eState)) {
			this.state.pendingOpenKind.set(leaf, 'callerTarget');
			return 'callerTarget';
		}

		return undefined;
	}

	private hasCallerTarget(eState: OpenEphemeralState | undefined): boolean {
		return !!(eState && (eState.match || eState.cursor || eState.scroll != null || eState['is-flashing']));
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

	// Cover opens whose first frame could otherwise paint the un-restored top.
	// Only brand-new SOURCE-mode views with a scroll injection need it: their
	// editor is constructed later, measures its document, then the injected
	// scroll lands — the first frame would show the default top. A cursor-only
	// injection never moves the viewport (the note opens at its top and stays
	// there), so the first frame is already the final state and covering it
	// would only add a blank period. Reading opens are never covered — the
	// note renders visibly from the top and glideRestore scrolls to the saved
	// line, so masking would only add a blank period. Existing source-mode
	// markdown views need no cover — setViewState applies scroll/cursor
	// atomically. The injected branch of restoreEphemeralState waits for the
	// position to paint, then lifts the cover; the safety timer bounds it for
	// background opens.
	private maybeCoverOpen(leaf: WorkspaceLeaf, hasScroll: boolean) {
		if (!hasScroll)
			return;
		const newLeaf = !(leaf.view instanceof MarkdownView);
		if (newLeaf)
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
