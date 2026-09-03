import { App, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { TabStore } from './tab-store';
import { nextPaint } from './wait';
import { PositionState } from './position-state';
import { RestoreModes } from './restore-modes';

// Settles background splits whose open never fired 'file-open'
// (restart-restored tabs with BUILT views). Source-injected tabs hold an
// unconsumed injected marker; reading and source-glide tabs are restored
// from their saved record with no marker at all. Without this sweep, only
// the active tab's 'file-open' corrects its landing — background tabs sit
// at the drifted (source) or top (reading) position until first
// activation. Iterate all markdown leaves and restore each unconsumed one
// under its own cover, consuming its bookkeeping, WITHOUT touching the
// active-leaf recording baseline (see RestoreModes.settleInjectedReveal /
// the anchor-skipping background restore variants).
//
// Skips: the active leaf (its own 'file-open' / completeInjectedRestore
// owns it), in-flight restores, stale markers (handled pair moved to a
// different file), and leaves already handled (caller-target opens, which
// ride Obsidian's own cached position — matching the active tab's
// behavior). Deferred leaves (no built view) keep their state and settle
// on activation via completeInjectedRestore.
export class BackgroundSettler {
	private app: App;
	private settings: PluginSettings;
	private state: PositionState;
	private tabStore: TabStore;
	private modes: RestoreModes;

	constructor(app: App, settings: PluginSettings, tabStore: TabStore) {
		this.app = app;
		this.settings = settings;
		this.tabStore = tabStore;
		this.state = tabStore.state;
		this.modes = new RestoreModes(settings, this.state);
	}

	// Background split tabs restored at startup are BUILT (so they render)
	// but never fire 'file-open', so only the active tab's open corrects its
	// landing — background tabs sit at a drifted (source) or top (reading)
	// position until first activation (see completeBackgroundRestores).
	// Settle them under their own first-paint covers as soon as their views
	// exist: a short bounded poll that stops when no built leaf still needs
	// work. Deferred tabs (no built view) keep their state and settle on
	// activation via completeInjectedRestore.
	start(registerCleanup: (fn: () => void) => void) {
		const deadline = Date.now() + 10000;
		const interval = window.setInterval(() => {
			void this.completeBackgroundRestores().then(done => {
				if (done || Date.now() > deadline)
					window.clearInterval(interval);
			});
		}, 200);
		registerCleanup(() => window.clearInterval(interval));
	}

	// Returns true when no built leaf still needs work, so the caller can stop
	// polling; deferred leaves keep returning false until the caller's deadline.
	async completeBackgroundRestores(): Promise<boolean> {
		if (!this.app.workspace.layoutReady)
			return false;
		await nextPaint();
		const leaves: WorkspaceLeaf[] = [];
		// Block body on purpose: Obsidian's iterate helpers treat a truthy
		// callback result as an early-interrupt signal (see pruneStaleLeafIds).
		this.app.workspace.iterateAllLeaves((leaf) => {
			leaves.push(leaf);
		});
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		const activeLeafId = active?.leaf ? this.state.leafId(active.leaf) : undefined;
		let pending = false;
		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file)
				continue;
			const leafId = this.state.leafId(leaf);
			const filePath = view.file.path;
			if (leafId === activeLeafId)
				continue;
			if (this.state.inFlightRestoreLeafRuns.get(leafId)?.filePath === filePath)
				continue; // a real restore owns this leaf right now
			const marker = this.state.injectedOpenLeafIds.has(leafId);
			if (marker && this.state.handledLeafIdMap.get(leafId) !== filePath) {
				// Stale marker (the leaf moved to another file after injection):
				// the current open was not injected, nothing to settle. Consume
				// the marker so it can't misdirect a later activation.
				this.state.injectedOpenLeafIds.delete(leafId);
				continue;
			}
			if (!view.editor) {
				pending = true; // deferred/unbuilt: settle on activation
				continue;
			}
			if (marker) {
				await this.settleBackground(view, leafId, filePath);
			} else if (this.state.handledLeafIdMap.get(leafId) !== filePath) {
				// Unhandled and un-injected: a reading or source-glide tab
				// whose saved position was never applied. Restore it now.
				const st = this.tabStore.getRestoreSt(leaf, filePath);
				if (!st)
					continue;
				await this.restoreBackground(view, leafId, filePath, st);
			}
		}
		return !pending;
	}

	// Settle one built background source-injected leaf's landing under its
	// own cover and consume its marker. Bounded by the settle's own deadline;
	// a scroll-0 (cursor-only) injection never moved the viewport, so it only
	// reveals.
	private async settleBackground(view: MarkdownView, leafId: string, filePath: string) {
		const st = this.tabStore.getRestoreSt(view.leaf, filePath);
		const isCurrent = () => view.file?.path === filePath;
		const hasScroll = !!st && (st.scroll ?? 0) > 0;
		if (hasScroll) {
			// The correction must run hidden: re-cover if the cover safety
			// timer already lifted the leaf cover, then settle and reveal.
			if (!this.state.cover.isCovered(view.leaf))
				this.state.cover.cover(view.leaf);
			this.state.restoreStarted();
			try {
				await this.modes.settleInjectedReveal(view, st, isCurrent);
			} finally {
				this.state.restoreEnded();
			}
		} else if (isCurrent()) {
			this.state.cover.uncover(view.leaf);
		}
		if (isCurrent())
			this.state.injectedOpenLeafIds.delete(leafId);
	}

	// Restore one built background reading or source-glide tab from its saved
	// record (no injected marker — the open was never covered/injected).
	// Dispatches by view mode and the user's restore-method settings exactly
	// like restoreMarkdown, but with the shared anchor disabled (the recording
	// baseline belongs to the active leaf only). Records the handled pair so a
	// later activation / re-assert dedups instead of re-restoring.
	private async restoreBackground(view: MarkdownView, leafId: string, filePath: string, st: EphemeralState) {
		const isCurrent = () => view.file?.path === filePath;
		// The shared anchor is disabled for this restore (the recording
		// baseline belongs to the active leaf only); anchorToSettledState reads
		// the per-leaf flag and skips.
		this.state.noAnchorLeafIds.add(leafId);
		this.state.restoreStarted();
		try {
			if (view.getMode() === 'source') {
				if (this.settings.sourceRestoreMethod === 'glide' && (st.scroll ?? 0) > 0)
					await this.modes.glideRestore(view, st, isCurrent);
			} else if (this.settings.readingRestoreMethod === 'glide' && (st.scroll ?? 0) > 0) {
				await this.modes.glideRestore(view, st, isCurrent);
			} else {
				await this.modes.maskedRestoreSt(view, st, isCurrent);
			}
		} finally {
			this.state.noAnchorLeafIds.delete(leafId);
			this.state.restoreEnded();
		}
		if (isCurrent())
			this.state.handledLeafIdMap.set(leafId, filePath);
	}
}