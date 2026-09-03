import { App, FileView, MarkdownView, Platform, WorkspaceLeaf, debounce } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { CursorPositionDatabase } from './database';
import { readEphemeralState, isEphemeralStatesEquals, isCursorStatesEqual } from './ephemeral';
import { ExclusionChecker } from './exclusion';
import { PositionState } from './position-state';

// Records cursor/scroll position changes for the shared PositionState baseline
// and the database. Two inputs feed the database:
//  - checkEphemeralStateChanged: the 100ms polling loop, active view only.
//    Desktop records cursor movement only (scroll deltas belong to the
//    capture listener); mobile records full-state changes, with scroll-only
//    deltas trusted only when a user touch accounts for them — mobile has
//    no capture listener because WKWebView coalesces/drops scroll events.
//  - onScrollCapture: a capture-phase scroll listener on the workspace root
//    (desktop only), which catches every pane (active and background) that
//    the poll misses. It refuses two kinds of noise: scrolls originating
//    inside embedded renderers (dataview blocks, ![[embed]] — recording
//    those would write the HOST editor's state over movement the embedded
//    content made), and scroll deltas with no recent user input
//    (programmatic re-renders / plugin-driven scrolls).
// Owns the per-leaf capture baseline and the exclusion-path memoization; the
// plugin polls it via PositionManager, which stays the single entry point.
export class Sampler {
	private app: App;
	private database: CursorPositionDatabase;
	private exclusions: ExclusionChecker;
	private state: PositionState;
	private settings: PluginSettings;

	private readonly STORE_INTERVAL = 97;

	// Search inputs whose focus means the view is about to be moved by a
	// search engine rather than the user: editor find (Cmd+F), quick
	// switcher / command palette / in-file heading prompts, and the global
	// search panel.
	private readonly SEARCH_INPUT_SELECTOR = '.document-search-input, .cm-search input, .prompt-input, .search-input-container input';

	// After a search input blurs, keep the anchor this long: a result click
	// (e.g. the global search panel) blurs the input before the jump it
	// triggers registers.
	private readonly SEARCH_ANCHOR_GRACE_MS = 250;

	private searchGraceTimer = 0;

	// Desktop scroll-capture intent window: a scroll delta whose last user
	// input (wheel/pointerdown/keydown) is older than this is programmatic
	// movement — dynamic re-render layout shifts (dataview dashboards), lazy
	// embed loads, plugin-driven scrolls — and must never overwrite the saved
	// record. Generous enough to cover trackpad momentum tails; a genuine
	// user scroll always carries one of the tracked input events.
	private readonly SCROLL_INTENT_WINDOW_MS = 2000;

	// Scroll targets inside these boundaries belong to embedded renderers —
	// ![[note]]/image embeds (the .internal-embed family), interactive code
	// widgets (.cm-embed-block), dataview-style rendered blocks
	// (.block-language-*) — not to the view's own scroller. Recording such a
	// scroll would write the HOST editor's cursor/scroll (readEphemeralState
	// only sees the view) over movement the embedded content made: the
	// misattributed record that breaks dynamically-rendered dashboards.
	private readonly EMBED_BOUNDARY_SELECTOR = '.internal-embed, .cm-embed-block, [class*="block-language"]';

	// Mobile reflow guard: scroll-only deltas within this window after the
	// last recording anchor that no user touch accounts for are treated as
	// passive layout shift (late editor measure / image decode right after
	// an open) and absorbed, never written to the db. Long on purpose:
	// mobile rendering can keep re-measuring for seconds after an open,
	// and a genuine user scroll always carries a touch, so the window
	// costs nothing.
	private readonly SCROLL_SETTLE_GUARD_MS = 4000;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings, state: PositionState) {
		this.app = app;
		this.database = database;
		this.settings = settings;
		this.exclusions = new ExclusionChecker(settings);
		this.state = state;
	}

	checkEphemeralStateChanged() {
		// Stuck-anchor safety net: a focused search input removed from the DOM
		// (quick switcher closed, find bar dismissed) fires no focusout in
		// Chromium — focus silently reverts to body — which would leave
		// searchAnchorUntil at Infinity forever and silently disable ALL
		// recording for the rest of the session. Expire it the moment no
		// search input holds focus. The finite grace value written by
		// onFocusOut is left alone; this only rescues the stuck Infinity.
		if (this.state.searchAnchorUntil === Number.POSITIVE_INFINITY) {
			const active = document.activeElement;
			if (!active || !active.closest(this.SEARCH_INPUT_SELECTOR))
				this.state.searchAnchorUntil = 0;
		}

		// The plugin only handles markdown views; other view types (canvas, PDF, etc.) are skipped entirely.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file)
			return;

		const filePath = view.file.path;

		// Skip while a restore is in flight, or when the active file is not the one we loaded
		// (lastLoadedFilePath is unset until the first load, in which case it never matches)
		if (this.state.isRestoringFile() || filePath !== this.state.lastLoadedFilePath)
			return;

		if (this.exclusions.shouldSkipRecording(view)) {
			this.database.deleteFile(filePath);
			return;
		}

		const st = readEphemeralState(view);
		if (!st)
			return;

		const prev = this.state.lastEphemeralState;
		let write: EphemeralState | undefined;

		if (prev) {
			if (!this.state.isSearchAnchored()) {
				if (Platform.isMobileApp) {
					// Mobile fallback: DOM scroll events are unreliable under
					// WKWebView (momentum scrolling coalesces or drops them), so
					// the scroll-capture listener cannot be trusted and the poll
					// must keep recording the full state itself — with one
					// exception: a scroll-only delta no user touch accounts for
					// is passive reflow (see isTrustedMobileScroll) and must
					// never overwrite the saved record.
					if (!isEphemeralStatesEquals(st, prev)) {
						if (!isCursorStatesEqual(st.cursor, prev.cursor)) {
							// Cursor/selection movement is always deliberate input.
							write = st;
						} else if (this.isTrustedMobileScroll()) {
							write = st;
						}
						// else: absorbed — lastEphemeralState is refreshed below
						// without a db write, so the shift becomes the new
						// baseline and only later user movement is recorded.
					}
				} else {
					// Desktop: record only on cursor movement — scroll-only deltas
					// belong to the scroll-capture listener. The write is the state
					// read in this tick (actual scroll, not the db record, which can
					// lag one debounce interval behind). Comparison is cursor-only:
					// the baseline's restorer-seeded scroll field is not a change.
					if (!isCursorStatesEqual(st.cursor, prev.cursor)) {
						write = st;
					}
				}
			}
			// else: a search session is live (see installSearchAnchor) — cursor
			// movement is the search engine hopping between matches, not the
			// user, and is never written. The baseline still refreshes below, so
			// the first deliberate move after the session ends records normally.

			if (write) {
				// Record through the shared per-leaf baseline (saveLeafState),
				// not just the per-file db: on mobile there is no scroll-capture
				// listener (desktop-only), so this poll is the ONLY writer of
				// lastStateByLeaf there — without it, the same file open in two
				// tabs would restore both to the same per-file record after a
				// restart instead of each tab's own spot. On desktop the poll
				// only moves the cursor baseline; saveLeafState dedups against
				// the per-leaf record either way.
				this.saveLeafState(this.state.leafId(view.leaf), filePath, write);
				// The user moved away from the restored spot: dismiss the cue
				// (grace-guarded in RestoreCue so mobile's post-restore jitter
				// can't flash it away).
				this.state.cue.dismissOnMove();
			}
		}

		this.state.lastEphemeralState = st;
	}

	// Scroll capture. Fires on every scroll event anywhere in the workspace;
	// records the owning leaf's position — active or background. This is what
	// the active-view-only poll misses: a pane scrolled while not active, then
	// closed or quit before it was ever activated.
	private onScrollCapture = (ev: Event) => {
		const target = ev.target as HTMLElement | null;
		if (!target) return;

		// A restore's glide/apply fires scroll events on the leaf being
		// restored; skip all recording while one is in flight so those
		// events never overwrite saved positions.
		if (this.state.isRestoringFile()) return;

		// A search jump also scrolls (scroll-to-match); like the cursor hops
		// the poll absorbs, programmatic search movement must not overwrite
		// the saved record. Skip while a search session is live.
		if (this.state.isSearchAnchored()) return;

		// Desktop user-intent guard: a scroll with no recent user input is
		// programmatic movement (re-render layout shift, plugin-driven
		// scroll), not a user choice — absorb it. Symmetric with the mobile
		// poll's isTrustedMobileScroll.
		if (Date.now() - this.state.lastUserInputAt > this.SCROLL_INTENT_WINDOW_MS)
			return;

		// Resolve the scroll target to its owning leaf/view first...
		const leaf = this.findOwnerLeaf(target);
		const view = leaf?.view;
		if (!leaf || !(view instanceof FileView) || !view.file)
			return;

		// ...then refuse scrolls owned by embedded renderers: the target sits
		// inside an embed boundary within the view, so the movement belongs to
		// the embedded content (dataview dashboard, ![[embed]]), not the host
		// scroller. Recording it would write the host state — wrong by
		// construction. The host state didn't change, so the baseline needs
		// no adjustment either.
		const embedBoundary = target.closest(this.EMBED_BOUNDARY_SELECTOR);
		if (embedBoundary && view.containerEl.contains(embedBoundary))
			return;

		// ...then record. Common exclusion gate first: excluded paths (and,
		// for text views, files below minLinesToRecord) never record; the db
		// entry is dropped and the per-leaf baseline cleared so later valid
		// states aren't deduped against a dropped one.
		const filePath = view.file.path;
		const leafId = this.state.leafId(leaf);

		if (this.exclusions.shouldSkipRecording(view)) {
			this.database.deleteFile(filePath);
			this.state.lastStateByLeaf.delete(leafId);
			return;
		}

		// Markdown leaves record line/cursor state.
		if (view instanceof MarkdownView) {
			const st = readEphemeralState(view);
			if (!st) return;

			this.saveLeafState(leafId, filePath, st);
			return;
		}

		// Base views are the only non-markdown files recorded, and only when
		// opted in (recordBaseScroll): their recordable state is a raw
		// scroller scrollTop, which is device-local — recording by default
		// would let a synced record from another device overwrite the local
		// one with an offset that doesn't fit this device's viewport. Their
		// scroll events never bubble, so target is exactly the element that
		// scrolled — its scrollTop is the whole recordable state (cf.
		// obsidian-scrolling's storeFileState), stored in
		// EphemeralState.scroll's non-markdown meaning.
		// PDF is hard-excluded (native PDF.js history already remembers
		// same-device positions); other FileViews (image...) have no useful
		// scroll. Either way, just clear the baseline.
		if (view.getViewType() !== 'bases' || !this.settings.recordBaseScroll) {
			this.state.lastStateByLeaf.delete(leafId);
			return;
		}
		this.saveLeafState(leafId, filePath, { scroll: Math.round(target.scrollTop) });
	};

	// Finds which pane actually scrolled: the recordable leaf whose view
	// container contains the scroll target. Markdown views and other
	// FileViews qualify; anything else yields no owner.
	private findOwnerLeaf(target: HTMLElement): WorkspaceLeaf | undefined {
		// Fast path: the active leaf is by far the most common scroll source.
		// Resolving it directly avoids the full leaf scan below (which runs a
		// DOM contains() per FileView leaf) on every burst.
		const active = this.app.workspace.getActiveViewOfType(FileView);
		if (active?.file && active.containerEl.contains(target))
			return active.leaf;

		// Background panes: scan all leaves. `owner` short-circuits the
		// callback work once found (iteration itself can't be stopped).
		let owner: WorkspaceLeaf | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (owner) return;
			const view = leaf.view;
			if (view instanceof FileView && view.file && view.containerEl.contains(target))
				owner = leaf;
		});
		return owner;
	}

	// Baseline-deduped record write for the scroll capture. The baseline is
	// scoped to (leaf, file): a leaf that switched files starts a
	// fresh first-sighting for the new file. First sighting seeds the baseline
	// without writing when it already matches the saved record, so opening + a
	// no-op scroll doesn't trigger a needless db write; afterwards save only
	// on change.
	private saveLeafState(leafId: string, filePath: string, st: EphemeralState): void {
		const prev = this.state.lastStateByLeaf.get(leafId);
		const sameFile = prev !== undefined && prev.filePath === filePath;
		if (sameFile && isEphemeralStatesEquals(prev.st, st))
			return;

		if (!sameFile) {
			const existing = this.database.db[filePath];
			if (existing && isEphemeralStatesEquals(existing, st)) {
				this.state.lastStateByLeaf.set(leafId, { filePath, st });
				return;
			}
		}

		this.state.lastStateByLeaf.set(leafId, { filePath, st });
		this.database.setState(filePath, st);
	}

	// Capture scroll on every pane (active and background), which the 100ms
	// poll does not see. Registered on the workspace root in capture phase
	// so scroll events from any nested scroller are caught.
	installScrollCapture(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		// scroll fires in bursts; debounce collapses the write storm into one
		// trailing call so we persist the movement's final resting position.
		const onScroll = debounce(this.onScrollCapture, this.STORE_INTERVAL, true);
		container.addEventListener('scroll', onScroll, {
			 capture: true, 
			 passive: true 
		});
		registerCleanup(() =>
			container.removeEventListener('scroll', onScroll, { capture: true })
		);
	}

	// Desktop only. Stamps user input (wheel / pointerdown / keydown) so the
	// scroll-capture listener can separate user-driven scrolls from programmatic
	// movement — the desktop counterpart of the mobile touch listener feeding
	// isTrustedMobileScroll. Capture phase + passive: pure timestamping, never
	// interferes with the scrolling itself. All user-scroll entry points are
	// covered (trackpad/mouse = wheel, scrollbar drag / touch = pointerdown,
	// keyboard = keydown); keydown also covers typing, which is safe — editor
	// auto-scrolls during typing arrive alongside cursor movement the poll
	// records anyway.
	installUserIntentTracker(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		const markUserInput = () => { this.state.lastUserInputAt = Date.now(); };
		container.addEventListener('wheel', markUserInput, { capture: true, passive: true });
		container.addEventListener('pointerdown', markUserInput, { capture: true, passive: true });
		document.addEventListener('keydown', markUserInput, { capture: true });
		registerCleanup(() => {
			container.removeEventListener('wheel', markUserInput, { capture: true });
			container.removeEventListener('pointerdown', markUserInput, { capture: true });
			document.removeEventListener('keydown', markUserInput, { capture: true });
		});
	}

	// Whether a scroll-only delta observed by the mobile poll can be trusted as
	// a real user scroll. WKWebView's dropped scroll events make the DOM useless
	// as a signal, but touch events are reliable: any touch on the workspace
	// marks subsequent scrolling — including momentum after the finger lifts —
	// as user-driven. Without a touch, a delta arriving within
	// SCROLL_SETTLE_GUARD_MS of the last recording anchor is passive reflow
	// (the editor/preview finishing its measure or decoding images right after
	// an open shifts the viewport by up to a screen with no user action);
	// recording it would overwrite the saved position with a spot roughly one
	// screen above where the user actually was. After the guard expires any
	// delta is recorded: late reflow is rare and dropping real scrolls would be
	// worse.
	private isTrustedMobileScroll(): boolean {
		if (this.state.lastTouchAt > this.state.lastAnchorAt)
			return true;
		return Date.now() - this.state.lastAnchorAt > this.SCROLL_SETTLE_GUARD_MS;
	}

	// Mobile only. Marks user interaction so isTrustedMobileScroll (and the
	// restorer's drift correction) can separate real user scrolls from
	// passive reflow. touchstart is enough: it precedes every touch scroll,
	// and the momentum phase keeps counting too because lastTouchAt only
	// needs to postdate the anchor.
	installTouchListener(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		const onTouch = () => { this.state.lastTouchAt = Date.now(); };
		container.addEventListener('touchstart', onTouch, { capture: true, passive: true });
		registerCleanup(() =>
			container.removeEventListener('touchstart', onTouch, { capture: true })
		);
	}

	// Search anchor. Focusing a search input arms the guard so the jumps the
	// search engine performs (cursor hops between matches in editor find,
	// scroll-to-match) never overwrite the saved position with a spot the
	// user never chose — the pre-search position, already in the db, stays
	// the anchor the view returns to on the next open. Blurring disarms the
	// guard after SEARCH_ANCHOR_GRACE_MS, so the first deliberate move after
	// the search ends records normally.
	installSearchAnchor(registerCleanup: (fn: () => void) => void) {
		const isSearchInput = (ev: FocusEvent): boolean => {
			const el = ev.target as HTMLElement | null;
			return !!el && typeof el.closest === 'function' && !!el.closest(this.SEARCH_INPUT_SELECTOR);
		};
		const onFocusIn = (ev: FocusEvent) => {
			if (!isSearchInput(ev)) return;
			// Re-focus while a grace timer from a previous blur is running:
			// kill it and stay armed.
			if (this.searchGraceTimer) {
				window.clearTimeout(this.searchGraceTimer);
				this.searchGraceTimer = 0;
			}
			this.state.searchAnchorUntil = Number.POSITIVE_INFINITY;
		};
		const onFocusOut = (ev: FocusEvent) => {
			if (!isSearchInput(ev)) return;
			if (this.searchGraceTimer) window.clearTimeout(this.searchGraceTimer);
			this.searchGraceTimer = window.setTimeout(() => {
				this.searchGraceTimer = 0;
				this.state.searchAnchorUntil = Date.now(); // expired
			}, this.SEARCH_ANCHOR_GRACE_MS);
		};
		document.addEventListener('focusin', onFocusIn, true);
		document.addEventListener('focusout', onFocusOut, true);
		registerCleanup(() => {
			document.removeEventListener('focusin', onFocusIn, true);
			document.removeEventListener('focusout', onFocusOut, true);
			if (this.searchGraceTimer) window.clearTimeout(this.searchGraceTimer);
		});
	}

	// Clears the exclusion-path memoization. Called when settings change, since
	// the excluded-folders list may have changed.
	clearExclusionCache() {
		this.exclusions.clearPathCache();
	}
}
