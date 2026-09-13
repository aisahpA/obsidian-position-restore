import { App, FileView, MarkdownView, Platform, TFile, WorkspaceLeaf, debounce, type Editor, type EditorPosition, type EventRef } from 'obsidian';
import { EphemeralState, PluginSettings } from '../../types';
import { CursorPositionDatabase } from '../storage/database';
import { readEphemeralState, readNavEntryState, withNavDisplay, isEphemeralStatesEquals, isCursorStatesEqual } from './ephemeral';
import { ExclusionChecker } from '../policy/exclusion';
import { frontmatterDecisionFor } from '../policy/frontmatter';
import { PositionState } from '../state';
import type { NavHistory } from '../../nav-history/history';

// Records cursor/scroll position changes for the shared PositionState baseline
// and the database. Two inputs feed the database:
//  - sampleActiveView: the 100ms polling loop, active view only.
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
	private nav: NavHistory;

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

	// Landing-absorb early-expiry state. A finite searchAnchorUntil (armed by
	// the patcher at an open-kind jump, or by this grace) is a ceiling: once
	// the view stops moving the landing is over, so expire a couple ticks
	// later instead of running out the full window — that would otherwise
	// swallow the user's first deliberate moves after the jump.
	private searchSettledTicks = 0;
	private lastAnchorDeadline = 0;

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

	// Mobile poll path only: minimum anchor-line delta within one poll tick
	// for the movement to read as an in-file navigation jump (NavHistory
	// teleport record) rather than typing or held-key movement. Held keys
	// move ~5-10 lines/tick; a deliberate far jump is dozens. Desktop detects
	// teleports per selection event instead (TELEPORT_MIN_LINES_EVENT) —
	// running both would let the poll's tick-delayed refreshTop overwrite
	// the event path's synthesized entry positions.
	private readonly TELEPORT_MIN_LINES = 50;

	// Desktop: minimum anchor-line delta within ONE selection event —
	// VSCode's TextEditorPaneSelection.TEXT_EDITOR_SELECTION_THRESHOLD. One
	// event moves 1 line for a held key and hundreds for a deliberate jump
	// (go-to-line, far click, vim {/}/half-page), so the threshold sits at 10
	// instead of the poll's per-tick 50, and paragraph-scale jumps reach the
	// nav stack.
	private readonly TELEPORT_MIN_LINES_EVENT = 10;

	// Rolling teleport baseline (desktop event path): the anchor position at
	// the last selection event, the file it belonged to, and the re-anchor
	// stamp it was taken under. lastAnchorAt bumps on every programmatic
	// re-anchor (restore landing, dedup re-assert — see PositionState), so a
	// mismatch tells the handler the view's cursor was re-placed since the
	// last event and the baseline must reset silently — otherwise the
	// landing-to-old-baseline distance would read as a jump.
	private teleportFrom: EditorPosition | undefined;
	private teleportFromPath: string | undefined;
	private teleportAnchorAt = 0;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings, state: PositionState, nav: NavHistory) {
		this.app = app;
		this.database = database;
		this.settings = settings;
		this.exclusions = new ExclusionChecker(app, settings);
		this.state = state;
		this.nav = nav;
	}

	sampleActiveView() {
		// Stuck-anchor safety net: a focused search input removed from the DOM
		// (quick switcher closed, find bar dismissed) fires no focusout in
		// Chromium — focus silently reverts to body — which would leave
		// searchAnchorUntil at Infinity forever and silently disable ALL
		// recording for the rest of the session. Expire it the moment no
		// search input holds focus. The finite grace value written by
		// onFocusOut is left alone; this only rescues the stuck Infinity.
		// Must NOT run while the post-blur grace timer is pending: a normal
		// blur also returns activeElement to body, so clearing Infinity here
		// would cut SEARCH_ANCHOR_GRACE_MS short and the search jump landing
		// after the blur would be recorded as a user scroll, overwriting the
		// saved position.
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
		// rule-independent (back/forward must work in excluded files too):
		// the db record is dropped, but the tick keeps running so the teleport
		// detection below still pushes nav entries.
		const skipRecording = this.exclusions.shouldSkipRecording(view);
		if (skipRecording)
			this.database.deleteFile(filePath);

		const st = readEphemeralState(view);
		if (!st)
			return;

		const prev = this.state.lastEphemeralState;

		// Reset the settle counter whenever the absorb deadline changes (a new
		// arm or an expiry): a stale tick count from a previous landing must
		// not expire the next landing's window early.
		if (this.state.searchAnchorUntil !== this.lastAnchorDeadline) {
			this.lastAnchorDeadline = this.state.searchAnchorUntil;
			this.searchSettledTicks = 0;
		}

		// Early-expire a FINITE absorb once the view stops moving: the jump
		// has landed. Infinity (a live search input) is left to the
		// stuck-anchor safety net above.
		if (Number.isFinite(this.state.searchAnchorUntil) && this.state.isSearchAnchored()) {
			if (prev && isEphemeralStatesEquals(st, prev)) {
				if (++this.searchSettledTicks >= 2) {
					this.state.searchAnchorUntil = Date.now();
					this.searchSettledTicks = 0;
				// The jump has landed and the view is quiet: the settled read IS
				// the landing. Attach it to the entry the jump was pushed for
				// (keyed → backfill/keep inside refreshTop, which guards
				// path+leaf) — the precise-return position. Nav read (low
				// frequency): the landing entry carries the display fields.
				this.nav.refreshTop(filePath, this.state.leafId(view.leaf), readNavEntryState(view) ?? st);
				}
			} else {
				this.searchSettledTicks = 0;
			}
		}
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
				// Mobile keeps the poll's coarse per-tick jump detection (see
				// teleportLines): refreshTop hands the pre-jump read (prev) to
				// the entry being left — open/activation entries only, a
				// teleport top keeps its landing inside refreshTop — and the
				// pushed entry carries the post-jump read as its precise
				// landing. Gated by navRecordTeleport: both calls serve the
				// teleport entry (see onEditorSelection) — dead when off.
				if (this.settings.navRecordTeleport && Platform.isMobileApp) {
					const jumpLines = this.teleportLines(prev, write);
					if (jumpLines !== null && !this.state.isSearchAnchored()) {
						// The pre-jump state cannot be re-read (the cursor has
						// already jumped): withNavDisplay rebuilds the entry
						// display around the baseline's position.
						this.nav.refreshTop(filePath, this.state.leafId(view.leaf), withNavDisplay(view, prev));
						this.nav.recordTeleport(filePath, this.state.leafId(view.leaf), write.cursor!.from.line, readNavEntryState(view) ?? write);
					}
				}
				if (!skipRecording) {
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

	// Leave-time flush for the setViewState patch: the record's regular
	// writers lag (100ms poll tick, 97ms debounced scroll capture), so a
	// move + quick jump-away inside that window loses the final position —
	// the pending debounce fires after the swap, finds its scroller detached
	// from every view, and drops the write. Called synchronously with the
	// exact state of the view being swapped out, before the swap.
	// saveLeafState dedups: a no-op when nothing moved since the last write.
	flushOnLeave(view: MarkdownView, filePath: string, st: EphemeralState): void {
		if (this.exclusions.shouldSkipRecording(view))
			return;
		this.saveLeafState(this.state.leafId(view.leaf), filePath, st);
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

	// Desktop in-file teleport detection, per editor selection event instead
	// of the poll's 100ms tick. The tick quantizes cursor movement (held
	// keys accumulate 5-10 lines per tick), forcing the mobile threshold of
	// 50 and swallowing paragraph-scale jumps (vim {/}, half-page motions);
	// selection events arrive one per user action — 1 line for a held key —
	// so TELEPORT_MIN_LINES_EVENT applies and those jumps reach the nav
	// stack. NavHistory only: position records still come from the poll and
	// the scroll capture.
	//
	// One workspace-level listener covers every markdown editor; embedded
	// and mirrored editors (distinct Editor instances) and background panes
	// are filtered by the active-editor identity check — the poll's
	// active-view-only semantics. 'editor-selection-change' is a runtime
	// workspace event absent from the official typings (fires with
	// (editor, info) on every editor selection change); the Events generic
	// string overload registers it.
	installTeleportWatcher(registerCleanup: (fn: () => void) => void) {
		const ref = (this.app.workspace as unknown as {
			on(name: string, callback: (editor: Editor, info: unknown) => void, ctx?: unknown): unknown;
		}).on('editor-selection-change', this.onEditorSelection);
		registerCleanup(() => this.app.workspace.offref(ref as EventRef));
	}

	// The rolling baseline refreshes on EVERY accepted event — including
	// movement the gates below suppress — so a search session's hops
	// re-baseline silently and the first deliberate move after the anchor
	// expires compares against the true previous line (the same contract as
	// the poll's unconditional baseline refresh at the bottom of
	// sampleActiveView).
	private onEditorSelection = (editor: Editor): void => {
		// The whole handler exists for the teleport record: with the setting
		// off, recordTeleport no-ops and the leave-refresh would be
		// overwritten by refreshTopFromActiveView at the next traverse anyway
		// (no teleport entry sits on top). Bail before any work; reset the
		// baseline so re-enabling starts clean — a stale prev would read as
		// one false jump.
		if (!this.settings.navRecordTeleport) {
			this.teleportFrom = undefined;
			return;
		}
		// Only the active markdown view participates: embedded/mirrored
		// editors and background panes are invisible to nav exactly as they
		// are to the poll.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.editor !== editor)
			return;
		const filePath = view.file?.path;
		// Poll parity: only the file this plugin loaded records; a path-key
		// mismatch below resets the baseline on the newly loaded file's
		// first event.
		if (!filePath || filePath !== this.state.lastLoadedFilePath)
			return;

		const from = editor.getCursor('anchor');
		// Re-anchor epoch: a restore landing (or dedup re-assert) re-placed
		// the cursor programmatically since the last event — the anchor
		// stamp moved, so reset the baseline silently instead of reading the
		// landing as a jump.
		const reanchored = this.teleportAnchorAt !== this.state.lastAnchorAt;
		this.teleportAnchorAt = this.state.lastAnchorAt;
		const prev = reanchored ? undefined : this.teleportFrom;
		const prevPath = reanchored ? undefined : this.teleportFromPath;
		this.teleportFrom = from;
		this.teleportFromPath = filePath;
		// A different file is a switch, not an in-file jump: reset silently.
		if (!prev || prevPath !== filePath)
			return;
		if (Math.abs(from.line - prev.line) < this.TELEPORT_MIN_LINES_EVENT)
			return;
		if (this.state.isRestoringFile() || this.state.isSearchAnchored())
			return;

		const leafId = this.state.leafId(view.leaf);
		// "Update on leave" for the entry being left: keyless open/activation
		// tops get the poll's latest read — the pre-jump position as of the
		// last poll tick (the event fires before the next tick can
		// re-baseline; at most one tick stale, per withNavDisplay's doc).
		// Keyed tops (a teleport top included) are skipped inside refreshTop:
		// they keep the landing they were pushed with.
		// withNavDisplay rebuilds the display fields around that baseline (the
		// pre-jump state cannot be re-read; CM applies the jump's
		// scrollIntoView after this event, so the visibility check still sees
		// the pre-jump viewport).
		if (this.state.lastEphemeralState)
			this.nav.refreshTop(filePath, leafId, withNavDisplay(view, this.state.lastEphemeralState));
		// The pushed entry carries the jump's landing: the post-jump live
		// read (cursor already at the target).
		this.nav.recordTeleport(filePath, leafId, from.line, readNavEntryState(view));
		// The scroll, though, lands AFTER this event fires — CM applies the
		// jump's scrollIntoView in its measure phase (observed 2026-09: an
		// outline jump to line 323 saved the origin scroll 232), so the
		// push-time read above carries the origin scroll. Re-read one frame
		// later and replace the landing while the jump is still the last
		// thing that happened. ponytail: one rAF covers the deferred-measure
		// case (CM's own measure rAF is registered first); a still-stale
		// read after that is not corrected.
		window.requestAnimationFrame(() => {
			if (this.app.workspace.getActiveViewOfType(MarkdownView) !== view)
				return;
			if (view.file?.path !== filePath)
				return;
			// The user moved on before the frame: their position is theirs,
			// not the jump's landing.
			if (editor.getCursor('anchor').line !== from.line)
				return;
			const top = this.nav.entries[this.nav.index];
			if (!top || top.kind !== 'teleport'
				|| top.path !== filePath || top.leafId !== leafId
				|| top.line !== from.line)
				return;
			const settled = readNavEntryState(view);
			if (settled)
				top.st = settled;
		});
	};

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

	// Mobile poll path (desktop: onEditorSelection). VSCode-style in-file
	// jump detection: a cursor/selection whose anchor line moves
	// ≥ TELEPORT_MIN_LINES within one 100ms tick is a navigation
	// action (go-to-line, vim jump, far mouse click), not typing or held-key
	// movement. Returns the line delta, or null when the movement is not a
	// teleport. (A giant paste/delete can produce a false positive — one
	// harmless extra history entry.) Callers gate on the search anchor: a
	// search/find hop is engine-driven, never a teleport.
	// ponytail: threshold heuristic; explicit-jump hooks (1/2 in patcher) stay
	// the reliable sources, widen only if misses are reported.
	private teleportLines(prev: EphemeralState, st: EphemeralState): number | null {
		const from = prev.cursor?.from.line;
		const to = st.cursor?.from.line;
		if (from === undefined || to === undefined)
			return null;
		const delta = Math.abs(to - from);
		return delta >= this.TELEPORT_MIN_LINES ? delta : null;
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
				// A finite future anchor means the restorer re-armed recording
				// for an open-kind jump landing (restorer.ts restoreOpen) whose
				// async arrival can exceed this grace window — expiring it here
				// would record the landing. Only expire the Infinity this blur
				// closed out.
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

	// Clears the exclusion-path memoization. Called when settings change, since
	// the excluded-folders list may have changed.
	clearExclusionCache() {
		this.exclusions.clearPathCache();
		this.exclusions.clearFrontmatterCache();
	}

	// Frontmatter reactivation. Two jobs, one event:
	//  - the memoized frontmatter decisions must follow re-parses (metadata
	//    cache 'changed' fires after a file's metadata — incl. frontmatter —
	//    lands or changes), otherwise an edited marker would keep its stale
	//    value for the life of the memo;
	//  - the moment a file becomes frontmatter-excluded, drop its db record
	//    right away instead of waiting for the next poll tick (active view
	//    only) or a scroll (background tabs): editing a file to
	//    `position-restore: false` must not leave a record that restores once
	//    later. Non-frontmatter exclusions (folders, min lines) are unchanged:
	//    the poll / scroll-capture gate already handles them.
	installFrontmatterWatch(registerCleanup: (fn: () => void) => void) {
		const onCacheChanged = (file: TFile) => {
			this.exclusions.invalidateFrontmatter(file.path);
			const decision = frontmatterDecisionFor(this.app, file, this.settings);
			if (decision?.skip)
				this.database.deleteFile(file.path);
		};
		const ref = this.app.metadataCache.on('changed', onCacheChanged);
		registerCleanup(() => {
			this.app.metadataCache.offref(ref);
		});
	}
}
