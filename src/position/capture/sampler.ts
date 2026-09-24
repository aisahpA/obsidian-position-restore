import { App, FileView, MarkdownView, Platform, TFile, WorkspaceLeaf, debounce, type Editor, type EditorPosition, type EventRef } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { readEphemeralState, readNavEntryState, withNavDisplay } from './ephemeral';
import { isEphemeralStatesEquals, isCursorStatesEqual } from '@/shared/ephemeral-equals';
import { ExclusionChecker } from '@/position/policy/exclusion';
import { frontmatterDecisionFor } from '@/position/policy/frontmatter';
import { PositionState } from '@/position/state';
import type { NavFunnel } from '@/nav/funnel';

// Records cursor/scroll position changes for the shared PositionState baseline and the
// position store. Two inputs feed the store:
//  - sampleActiveView: the 100ms poll, active view only. Desktop records cursor
//    movement only (scroll deltas belong to the capture listener); mobile records
//    full-state changes, with scroll-only deltas trusted only when a user touch
//    accounts for them — mobile has no capture listener because WKWebView coalesces
//    and drops scroll events.
//  - onScrollCapture: a capture-phase scroll listener on the workspace root (desktop
//    only), which catches every pane the poll misses. It refuses two kinds of noise:
//    scrolls inside embedded renderers (dataview blocks, ![[embed]] — recording those
//    would write the HOST editor's state over movement the embedded content made) and
//    scroll deltas with no recent user input (programmatic re-renders).
// Owns the per-leaf capture baseline and the exclusion-path memoization; the plugin
// polls it via PositionManager, which stays the single entry point.
export class Sampler {
	private app: App;
	private store: PositionStore;
	private exclusions: ExclusionChecker;
	private state: PositionState;
	private settings: PluginSettings;
	private funnel: NavFunnel;

	private readonly STORE_INTERVAL = 97;

	// Search inputs whose focus means the view is about to be moved by a search engine
	// rather than the user: editor find (Cmd+F), quick switcher, command palette,
	// in-file heading prompts, the global search panel.
	private readonly SEARCH_INPUT_SELECTOR = '.document-search-input, .cm-search input, .prompt-input, .search-input-container input';

	// After a search input blurs, keep the anchor this long: a result click (the global
	// search panel) blurs the input before the jump it triggers registers.
	private readonly SEARCH_ANCHOR_GRACE_MS = 250;

	private searchGraceTimer = 0;

	// A finite searchAnchorUntil is a ceiling: once the view stops moving the landing is
	// over, so expire it a couple of ticks later instead of running out the window —
	// that would swallow the reader's first deliberate moves after the jump.
	private searchSettledTicks = 0;
	private lastAnchorDeadline = 0;

	// A scroll delta whose last user input (wheel/pointerdown/keydown) is older than
	// this is programmatic movement — layout shifts from dynamic re-renders, lazy embed
	// loads, plugin-driven scrolls — and must never overwrite the saved record.
	// Generous enough to cover trackpad momentum tails.
	private readonly SCROLL_INTENT_WINDOW_MS = 2000;

	// Scroll targets inside these boundaries belong to embedded renderers, not to the
	// view's own scroller: ![[note]]/image embeds, interactive code widgets,
	// dataview-style rendered blocks. Recording such a scroll writes the HOST editor's
	// state over movement the embedded content made.
	private readonly EMBED_BOUNDARY_SELECTOR = '.internal-embed, .cm-embed-block, [class*="block-language"]';

	// A scroll-only delta within this window of the last recording anchor that no user
	// touch accounts for is passive reflow (late editor measure / image decode right
	// after an open) and is absorbed. Long on purpose: mobile rendering can keep
	// re-measuring for seconds, and a genuine user scroll always carries a touch.
	private readonly SCROLL_SETTLE_GUARD_MS = 4000;

	// Anything that is not a positive number (a hand-edited data.json, a value synced
	// in from another device) reads as 0 = do not record: the safe direction for a
	// broken value is silence, never "every cursor move is a jump".
	private get teleportMinLines(): number {
		const n = Math.floor(this.settings.navHistoryTeleportMinLines);
		return Number.isFinite(n) && n > 0 ? n : 0;
	}

	// Rolling teleport baseline (desktop event path). lastAnchorAt bumps on every
	// programmatic re-anchor (restore landing, dedup re-assert — see PositionState), so
	// a mismatch means the cursor was re-placed since the last event and the baseline
	// must reset silently — otherwise the landing-to-old-baseline distance reads as a
	// jump.
	private teleportFrom: EditorPosition | undefined;
	private teleportFromPath: string | undefined;
	private teleportAnchorAt = 0;

	constructor(app: App, store: PositionStore, settings: PluginSettings, state: PositionState, funnel: NavFunnel) {
		this.app = app;
		this.store = store;
		this.settings = settings;
		this.exclusions = new ExclusionChecker(app, settings);
		this.state = state;
		this.funnel = funnel;
	}

	sampleActiveView() {
		// Stuck-anchor safety net: a focused search input removed from the DOM (quick
		// switcher closed, find bar dismissed) fires no focusout in Chromium — focus
		// silently reverts to body — which would leave searchAnchorUntil at Infinity
		// forever and disable ALL recording for the rest of the session. Must NOT run
		// while the post-blur grace timer is pending: a normal blur also returns
		// activeElement to body, so clearing Infinity here would cut the grace short and
		// the search jump landing after the blur would overwrite the saved position.
		if (this.state.searchAnchorUntil === Number.POSITIVE_INFINITY && !this.searchGraceTimer) {
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

		// Recording rules gate POSITION recording only — navigation history is
		// rule-independent (back/forward must work in excluded files too): the stored
		// record is dropped, but the tick keeps running so teleport detection still
		// pushes nav entries.
		const skipRecording = this.exclusions.shouldSkipRecording(view);
		if (skipRecording)
			this.store.deleteFile(filePath);

		const st = readEphemeralState(view);
		if (!st)
			return;

		const prev = this.state.lastEphemeralState;

		// A stale tick count from a previous landing must not expire the next one early.
		if (this.state.searchAnchorUntil !== this.lastAnchorDeadline) {
			this.lastAnchorDeadline = this.state.searchAnchorUntil;
			this.searchSettledTicks = 0;
		}

		// Early-expire a FINITE absorb once the view stops moving: the jump has landed.
		// Infinity (a live search input) is left to the safety net above.
		if (Number.isFinite(this.state.searchAnchorUntil) && this.state.isSearchAnchored()) {
			if (prev && isEphemeralStatesEquals(st, prev)) {
				if (++this.searchSettledTicks >= 2) {
					this.state.searchAnchorUntil = Date.now();
					this.searchSettledTicks = 0;
				// The settled read IS the landing. Attach it to the entry the jump was
				// pushed for (keyed → backfill/keep inside refreshTop, which guards
				// path+leaf) — the precise-return position, and the one the recent-files
				// list takes from here (`landing: true`; every other caller hands over
				// the reader's LEAVE, which the place must not mistake for the jump's
				// own spot).
				this.funnel.settled(filePath, this.state.leafId(view.leaf), readNavEntryState(view) ?? st);
				}
			} else {
				this.searchSettledTicks = 0;
			}
		}
		let write: EphemeralState | undefined;

		if (prev) {
			if (!this.state.isSearchAnchored()) {
				if (Platform.isMobileApp) {
					// Mobile fallback: DOM scroll events are unreliable under WKWebView, so
					// the poll must record the full state itself — with one exception: a
					// scroll-only delta no user touch accounts for is passive reflow (see
					// isTrustedMobileScroll) and must never overwrite the saved record.
					if (!isEphemeralStatesEquals(st, prev)) {
						if (!isCursorStatesEqual(st.cursor, prev.cursor)) {
							// Cursor/selection movement is always deliberate input.
							write = st;
						} else if (this.isTrustedMobileScroll()) {
							write = st;
						}
						// else: absorbed — lastEphemeralState is refreshed below without a
						// db write, so the shift becomes the new baseline.
					}
				} else {
					// Desktop: record only on cursor movement — scroll-only deltas belong to
					// the scroll-capture listener. The write is the state read in this tick
					// (the db record can lag one debounce behind). Comparison is
					// cursor-only: the baseline's restorer-seeded scroll is not a change.
					if (!isCursorStatesEqual(st.cursor, prev.cursor)) {
						write = st;
					}
				}
			}
			// else: a search session is live (see installSearchAnchor) — cursor movement
			// is the search engine hopping between matches, never written.

			if (write) {
				// No teleport detection on this path: the poll is the only cursor sampler a
				// touch device has, and it has nothing to infer from — a swipe moves no
				// cursor, and every deliberate far jump arrives as its own keyed entry. So
				// mobile back/forward stays about which file the reader came from.
				if (!skipRecording) {
					// The store updates the leaf layer and the file layer together (and
					// dedups both). On mobile there is no scroll-capture listener, so this
					// poll is the ONLY writer of the leaf layer there — without it, the same
					// file open in two tabs would restore both to the same per-file record
					// after a restart instead of each tab's own spot.
					this.store.write(this.state.leafId(view.leaf), filePath, write);
					// The user moved away from the restored spot: dismiss the cue
					// (grace-guarded in RestoreCue so mobile's post-restore jitter can't
					// flash it away).
					this.state.cue.dismissOnMove();
				}
			}
		}

		this.state.lastEphemeralState = st;
	}

	// Fires on every scroll event anywhere in the workspace; records the owning leaf's
	// position — active or background. This is what the active-view-only poll misses: a
	// pane scrolled while not active, then closed before it was ever activated.
	private onScrollCapture = (ev: Event) => {
		const target = ev.target as HTMLElement | null;
		if (!target) return;

		// A restore's glide/apply fires scroll events on the leaf being restored; skip
		// all recording while one is in flight so those events never overwrite saved
		// positions.
		if (this.state.isRestoringFile()) return;

		// A search jump also scrolls (scroll-to-match); like the cursor hops the poll
		// absorbs, programmatic search movement must not overwrite the saved record.
		if (this.state.isSearchAnchored()) return;

		// A scroll with no recent user input is programmatic movement, not a user
		// choice. Symmetric with the mobile poll's isTrustedMobileScroll.
		if (Date.now() - this.state.lastUserInputAt > this.SCROLL_INTENT_WINDOW_MS)
			return;

		// Resolve the scroll target to its owning leaf/view first...
		const leaf = this.findOwnerLeaf(target);
		const view = leaf?.view;
		if (!leaf || !(view instanceof FileView) || !view.file)
			return;

		// ...then refuse scrolls owned by embedded renderers: the movement belongs to the
		// embedded content, not the host scroller, and recording it would write the host
		// state — wrong by construction. The host state did not change, so the baseline
		// needs no adjustment either.
		const embedBoundary = target.closest(this.EMBED_BOUNDARY_SELECTOR);
		if (embedBoundary && view.containerEl.contains(embedBoundary))
			return;

		// ...then record. Excluded paths (and, for text views, files below
		// minLinesToRecord) never record; every record for the path is dropped — both
		// layers — so later valid states aren't deduped against a dropped one.
		const filePath = view.file.path;
		const leafId = this.state.leafId(leaf);

		if (this.exclusions.shouldSkipRecording(view)) {
			this.store.deleteFile(filePath);
			return;
		}

		// Markdown leaves record line/cursor state.
		if (view instanceof MarkdownView) {
			const st = readEphemeralState(view);
			if (!st) return;

			this.store.write(leafId, filePath, st);
			return;
		}

		// Base views are the only non-markdown files recorded, and only when opted in
		// (recordBaseScroll): their recordable state is a raw scroller scrollTop, which
		// is device-local — recording by default would let a synced record from another
		// device overwrite the local one with an offset that doesn't fit this viewport.
		// Their scroll events never bubble, so target is exactly the element that
		// scrolled. PDF is hard-excluded (native PDF.js history already remembers
		// same-device positions); other FileViews have no useful scroll.
		if (view.getViewType() !== 'bases' || !this.settings.recordBaseScroll) {
			this.store.forgetLeaf(leafId);
			return;
		}
		this.store.write(leafId, filePath, { scroll: Math.round(target.scrollTop) });
	};

	// Which pane actually scrolled: the recordable leaf whose view container contains
	// the scroll target.
	private findOwnerLeaf(target: HTMLElement): WorkspaceLeaf | undefined {
		// Fast path: the active leaf is by far the most common scroll source, and
		// resolving it directly avoids the DOM contains() scan below on every burst.
		const active = this.app.workspace.getActiveViewOfType(FileView);
		if (active?.file && active.containerEl.contains(target))
			return active.leaf;

		// Background panes: scan all leaves. `owner` short-circuits the callback work
		// once found (iteration itself can't be stopped).
		let owner: WorkspaceLeaf | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (owner) return;
			const view = leaf.view;
			if (view instanceof FileView && view.file && view.containerEl.contains(target))
				owner = leaf;
		});
		return owner;
	}

	// Leave-time flush for the setViewState patch: the regular writers lag (100ms poll,
	// 97ms debounced scroll capture), so a move + quick jump-away inside that window
	// loses the final position — the pending debounce fires after the swap, finds its
	// scroller detached from every view, and drops the write. Called synchronously with
	// the exact state of the view being swapped out, before the swap. The store's write
	// dedups: a no-op when nothing moved since the last one.
	flushOnLeave(view: MarkdownView, filePath: string, st: EphemeralState): void {
		if (this.exclusions.shouldSkipRecording(view))
			return;
		this.store.write(this.state.leafId(view.leaf), filePath, st);
	}

	// Capture scroll on every pane, which the poll does not see. Registered on the
	// workspace root in capture phase so scrolls from any nested scroller are caught.
	installScrollCapture(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		// scroll fires in bursts; debounce collapses the write storm into one trailing
		// call so we persist the movement's final resting position.
		const onScroll = debounce(this.onScrollCapture, this.STORE_INTERVAL, true);
		container.addEventListener('scroll', onScroll, {
			 capture: true, 
			 passive: true 
		});
		registerCleanup(() =>
			container.removeEventListener('scroll', onScroll, { capture: true })
		);
	}

	// Desktop only. Stamps user input so the scroll-capture listener can separate
	// user-driven scrolls from programmatic movement — the counterpart of the mobile
	// touch listener feeding isTrustedMobileScroll. Capture phase + passive: pure
	// timestamping. All user-scroll entry points are covered (trackpad/mouse = wheel,
	// scrollbar drag / touch = pointerdown, keyboard = keydown).
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

	// Desktop in-file teleport detection, per editor selection event rather than the
	// poll's 100ms tick: the tick quantizes cursor movement (held keys accumulate 5-10
	// lines per tick) and needs a floor high enough to swallow paragraph-scale jumps,
	// while selection events arrive one per user action. The nav stack only — position
	// records still come from the poll and the scroll capture.
	//
	// One workspace-level listener covers every markdown editor; embedded and mirrored
	// editors (distinct Editor instances) and background panes are filtered by the
	// active-editor identity check. 'editor-selection-change' is a runtime workspace
	// event absent from the official typings (fires with (editor, info) on every editor
	// selection change); the Events generic string overload registers it.
	installTeleportWatcher(registerCleanup: (fn: () => void) => void) {
		const ref = (this.app.workspace as unknown as {
			on(name: string, callback: (editor: Editor, info: unknown) => void, ctx?: unknown): unknown;
		}).on('editor-selection-change', this.onEditorSelection);
		registerCleanup(() => this.app.workspace.offref(ref as EventRef));
	}

	// The rolling baseline refreshes on EVERY accepted event — including movement the
	// gates below suppress — so a search session's hops re-baseline silently and the
	// first deliberate move after the anchor expires compares against the true previous
	// line (the same contract as the poll's unconditional refresh at the bottom of
	// sampleActiveView).
	private onEditorSelection = (editor: Editor): void => {
		const minLines = this.teleportMinLines;
		// At threshold 0 nothing is ever a jump; bail before any work, and reset the
		// baseline so raising the threshold again starts clean — a stale prev would read
		// as one false jump.
		if (minLines <= 0) {
			this.teleportFrom = undefined;
			return;
		}
		// Only the active markdown view participates: embedded/mirrored editors and
		// background panes are invisible to nav exactly as they are to the poll.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.editor !== editor)
			return;
		const filePath = view.file?.path;
		if (!filePath || filePath !== this.state.lastLoadedFilePath)
			return;

		const from = editor.getCursor('anchor');
		// Re-anchor epoch: a restore landing (or dedup re-assert) re-placed the cursor
		// programmatically since the last event, so reset the baseline silently instead
		// of reading the landing as a jump.
		const reanchored = this.teleportAnchorAt !== this.state.lastAnchorAt;
		this.teleportAnchorAt = this.state.lastAnchorAt;
		const prev = reanchored ? undefined : this.teleportFrom;
		const prevPath = reanchored ? undefined : this.teleportFromPath;
		this.teleportFrom = from;
		this.teleportFromPath = filePath;
		// A different file is a switch, not an in-file jump: reset silently.
		if (!prev || prevPath !== filePath)
			return;
		if (Math.abs(from.line - prev.line) < minLines)
			return;
		if (this.state.isRestoringFile() || this.state.isSearchAnchored())
			return;

		const leafId = this.state.leafId(view.leaf);
		// "Update on leave" for the entry being left: keyless open/activation tops get
		// the poll's latest read — the pre-jump position as of the last poll tick (at
		// most one tick stale, per withNavDisplay's doc). Keyed tops are skipped by the
		// stack: they keep the landing they were pushed with. CM applies the jump's
		// scrollIntoView after this event, so the visibility check still sees the
		// pre-jump viewport.
		if (this.state.lastEphemeralState)
			this.funnel.leave(filePath, leafId, withNavDisplay(view, this.state.lastEphemeralState));
		// The pushed entry carries the jump's landing: the post-jump live read (cursor
		// already at the target).
		this.funnel.recordTeleport(filePath, leafId, from.line, readNavEntryState(view));
		// The scroll lands AFTER this event — CM applies the jump's scrollIntoView in its
		// measure phase (observed 2026-09: an outline jump to line 323 saved the origin
		// scroll 232), so the push-time read carries the origin scroll. Re-read one frame
		// later and BROADCAST the correction; the stack takes it only while this teleport
		// is still its top step (see its onLanded). One rAF covers the deferred-measure
		// case; a still-stale read after that is not corrected.
		window.requestAnimationFrame(() => {
			if (this.app.workspace.getActiveViewOfType(MarkdownView) !== view)
				return;
			if (view.file?.path !== filePath)
				return;
			// The user moved on before the frame: their position is theirs, not the
			// jump's landing.
			if (editor.getCursor('anchor').line !== from.line)
				return;
			const settled = readNavEntryState(view);
			if (settled)
				this.funnel.landing({ kind: 'teleport', path: filePath, leafId, line: from.line, st: settled });
		});
	};

	// Whether a scroll-only delta observed by the mobile poll can be trusted as a real
	// user scroll. WKWebView's dropped scroll events make the DOM useless as a signal,
	// but touch events are reliable, and momentum after the finger lifts still counts.
	// Without a touch, a delta within SCROLL_SETTLE_GUARD_MS of the last anchor is
	// passive reflow — recording it would overwrite the saved position with a spot
	// roughly one screen above where the user actually was. After the guard any delta is
	// recorded: late reflow is rare and dropping real scrolls would be worse.
	private isTrustedMobileScroll(): boolean {
		if (this.state.lastTouchAt > this.state.lastAnchorAt)
			return true;
		return Date.now() - this.state.lastAnchorAt > this.SCROLL_SETTLE_GUARD_MS;
	}

	// Mobile only. touchstart is enough: it precedes every touch scroll, and the
	// momentum phase keeps counting because lastTouchAt only needs to postdate the
	// anchor.
	installTouchListener(registerCleanup: (fn: () => void) => void) {
		const container = this.app.workspace.containerEl;
		const onTouch = () => { this.state.lastTouchAt = Date.now(); };
		container.addEventListener('touchstart', onTouch, { capture: true, passive: true });
		registerCleanup(() =>
			container.removeEventListener('touchstart', onTouch, { capture: true })
		);
	}

	// Focusing a search input arms the guard so the jumps the search engine performs
	// never overwrite the saved position with a spot the user never chose — the
	// pre-search position, already in the db, stays the anchor the view returns to on
	// the next open. Blurring disarms after SEARCH_ANCHOR_GRACE_MS.
	installSearchAnchor(registerCleanup: (fn: () => void) => void) {
		const isSearchInput = (ev: FocusEvent): boolean => {
			const el = ev.target as HTMLElement | null;
			return !!el && typeof el.closest === 'function' && !!el.closest(this.SEARCH_INPUT_SELECTOR);
		};
		const onFocusIn = (ev: FocusEvent) => {
			if (!isSearchInput(ev)) return;
			// Re-focus while a grace timer from a previous blur is running: kill it and
			// stay armed.
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
				// A finite future anchor means the restorer re-armed recording for an
				// open-kind jump landing (restoreOpen) whose async arrival can exceed this
				// grace window — expiring it here would record the landing. Only expire
				// the Infinity this blur closed out.
				if (Number.isFinite(this.state.searchAnchorUntil))
					return;
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

	// Called when settings change, since the excluded-folders list may have changed.
	clearExclusionCache() {
		this.exclusions.clearPathCache();
		this.exclusions.clearFrontmatterCache();
	}

	// Frontmatter reactivation, two jobs on one event: the memoized decisions must follow
	// re-parses (metadata cache 'changed' fires after a file's metadata lands), and the
	// moment a file becomes frontmatter-excluded its records are dropped right away
	// instead of waiting for the next poll tick or a scroll — editing a file to
	// `position-restore: false` must not leave a record that restores once later.
	// Non-frontmatter exclusions are unchanged: the poll / scroll-capture gate handles
	// them.
	installFrontmatterWatch(registerCleanup: (fn: () => void) => void) {
		const onCacheChanged = (file: TFile) => {
			this.exclusions.invalidateFrontmatter(file.path);
			const decision = frontmatterDecisionFor(this.app, file, this.settings);
			if (decision?.skip)
				this.store.deleteFile(file.path);
		};
		const ref = this.app.metadataCache.on('changed', onCacheChanged);
		registerCleanup(() => {
			this.app.metadataCache.offref(ref);
		});
	}
}
