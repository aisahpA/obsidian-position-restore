import { App, FileView, WorkspaceLeaf } from 'obsidian';
import { NavEntryState } from '@/types';
import {
	NavEntry, NavTeleport, NavView, NewNavEntry, DistributiveOmit, isRecordableViewType,
} from './entry';
import { PositionState } from '@/position/state';
import {
	deferredFilePath, isDeferredLeaf, isMainAreaLeaf, viewTypeIsMissing,
	viewIcon as readViewIcon, viewLabel as readViewLabel, viewState as readViewState,
} from '@/shared/leaf';
import { installOutlineCapture as installOutlineCaptureHook } from './outline-capture';

// THE RECORDING FUNNEL — one navigation, several readers. The CAPTURE POINTS (the setViewState
// patch, the poll, the outline panel, the workspace's active-leaf-change) write here, and the
// readers subscribe; neither reader is a second-hand reporter of the other.
//
// TWO GROUPS OF METHODS, and the difference is who gets to decide:
//
//  - the CAPTURE SURFACE (record*, leave, settled). A capture point does not know what a navigation
//    means — it only knows what it saw. The funnel turns that into a record and applies THE SHARED
//    GATES, which answer one question with nothing to do with any listener: did the reader navigate,
//    or did the plugin move the view itself? A setting like "record tab switches" is NOT such a
//    gate: that is the stack's opinion about its own list, and each reader applies its own.
//  - the BROADCASTS (visit, landing, here) — facts somebody has already established, published to
//    every listener.
//
// A READER IS A LISTENER. The stack keeps steps; the recent-files list keeps places. They are fed
// from the same recordings and keep different things, and neither knows the other exists. Every hook
// is optional: a listener that has no use for a fact simply does not implement it.

// How a navigation got here — the only thing a reader cannot read off the record itself, and the
// reason two readers can apply different gates to the same fact (the stack's "record tab switches"
// is keyed on it PLUS the record's kind; "cursor jump distance" on the cause alone).
//   open     — an ordinary file open (the setViewState patch)
//   jump     — a keyed jump: an outline item, an anchor link, a search/backlink target
//   tab      — a tab/pane activation (VSCode records active-editor changes the same way)
//   teleport — an INFERRED same-file cursor jump (the sampler's heuristic)
export type NavCause = 'open' | 'jump' | 'tab' | 'teleport';

// One navigation, as it reaches the listeners. `record` is what it would look like as a step (see
// entry.ts); a LISTENER decides whether it keeps it.
export interface NavRecording {
	record: NewNavEntry;
	cause: NavCause;
	// An explicit target jump (a same-file search match / backlink flash): the reader asked for that
	// spot, so a step is recorded even when the top of the stack already looks identical. Only the
	// stack reads this.
	forced?: boolean;
}

// A position read: where a place WAS when the reader left it, or where a jump actually landed. The
// two are deliberately different facts — the stack takes both (it needs *some* position to return
// to), while a place keeps only the landing.
export type NavLeave =
	// The reader left this place; this is where they were.
	| { cause: 'read'; path: string; leafId: string; st: NavEntryState }
	// A jump's landing settled: this is the spot it actually took them to.
	| { cause: 'settled'; path: string; leafId: string; st: NavEntryState }
	// A tab/pane activation: the leaf taking over holds a position of its own.
	| { cause: 'tab'; leaf: WorkspaceLeaf };

// What a reader can be told. All optional — implement what you keep.
export interface NavFunnelSink {
	// A navigation happened (already past the shared gates). The stack compares it against its own
	// top before pushing; the place list re-orders its MRU.
	onVisit?(recording: NavRecording): void;
	// A position read (see NavLeave). Only the stack implements this today.
	onLeave?(leave: NavLeave): void;
	// A jump's landing is now known — a keyed jump settling, or a teleport's scroll arriving one
	// frame after the jump event. Carries the entry's IDENTIFYING fields (a place's identity is the
	// jump's key, which only the entry names) but not its stamp: a landing describes an entry that
	// already exists, and its `t` belongs to whoever pushed it.
	onLanded?(entry: NewNavEntry): void;
	// "You are here" moved.
	onHere?(entry?: NavEntry): void;
}

// Watchdog releasing a bracket if a traversal await hangs (openFile / loadIfDeferred never
// resolve): without it the funnel would stay "moving" forever and permanently disable back/forward.
// Sits above the legit apply ceiling (SETTLE_MAX_MS 800 + RELAND_MAX_MS 3000 + anchor delays).
const BRACKET_WATCHDOG_MS = 5000;

export class NavFunnel {
	private readonly app: App;
	private readonly state: PositionState;
	private readonly sinks = new Set<NavFunnelSink>();

	// True while the plugin is moving the view itself: the opens a traversal triggers are the
	// traversal, not new jumps.
	private moving = false;

	constructor(app: App, state: PositionState) {
		this.app = app;
		this.state = state;
	}

	subscribe(sink: NavFunnelSink): () => void {
		this.sinks.add(sink);
		return () => {
			this.sinks.delete(sink);
		};
	}

	// The shared gate: is this a navigation the reader made, or the plugin moving itself? A
	// traversal's own open and the startup rebuild are not navigations for anybody.
	isRecording(): boolean {
		return !this.moving && this.app.workspace.layoutReady;
	}

	// Is a bracket up right now (a traversal of ours is in flight)? Not the same as the gate above,
	// which also answers "has the workspace finished coming up".
	isMoving(): boolean {
		return this.moving;
	}

	// ===== The capture surface =====

	// A file open (the setViewState patch), an in-file jump marker, or a pathless view activation
	// (opts.viewType — the graph tab and every other view).
	recordOpen(
		path: string | undefined,
		leafId: string,
		opts: {
			key?: string; force?: boolean; viewType?: string; viewLabel?: string;
			viewIcon?: string; viewState?: Record<string, unknown>;
			via?: 'switch' | 'link'; viaPath?: string; viaText?: string;
		} = {},
	) {
		if (!this.isRecording())
			return;
		if (opts.viewType) {
			// A pathless view is reached by activating its leaf. Its name, icon and state ride along
			// when the caller has them: they are what the row prints and draws, and the state is what
			// the place is rebuilt with if that leaf is gone by the time the reader returns. A caller
			// that knows only the type leaves them off.
			const record: DistributiveOmit<NavView, 't'> = { kind: 'view', leafId, viewType: opts.viewType };
			if (opts.viewLabel)
				record.label = opts.viewLabel;
			if (opts.viewIcon)
				record.icon = opts.viewIcon;
			if (opts.viewState)
				record.state = opts.viewState;
			this.publish({ record, cause: 'open' });
			return;
		}
		// A pathless, typeless call has nothing to restore — no record.
		if (!path)
			return;
		this.publish({
			record: opts.key
				? { kind: 'jump', path, leafId, key: opts.key }
				: { kind: 'visit', path, leafId, via: opts.via, viaPath: opts.viaPath, viaText: opts.viaText },
			cause: opts.key ? 'jump' : 'open',
			forced: opts.force,
		});
	}

	// Large same-file cursor jump (go-to-line, vim jump, far mouse click): one per selection event,
	// desktop only — a swipe moves no cursor and a tap lands within the screenful. An INFERRED move,
	// not a deliberate jump — whether it is worth a step is the stack's call (its
	// navHistoryTeleportMinLines threshold).
	recordTeleport(path: string, leafId: string, line: number, landing?: NavEntryState) {
		if (!this.isRecording())
			return;
		const record: DistributiveOmit<NavTeleport, 't'> = { kind: 'teleport', path, leafId, line };
		if (landing)
			record.st = landing;
		this.publish({ record, cause: 'teleport' });
	}

	// Tab/pane activation as navigation (VSCode records active-editor changes the same way).
	// Sidebar panels are excluded — they track the active file in their own view state. A VIEW
	// activation is published the same way as a file tab's and is a step whatever the stack's
	// tab-switch setting says: activating the leaf is the only way a view can ever be entered.
	recordActivation(leaf: WorkspaceLeaf | null) {
		if (!leaf || !isMainAreaLeaf(this.app, leaf) || !this.isRecording())
			return;
		// The tab being LEFT still holds the position of the file behind it, and the activation is
		// the only moment it is still readable (focusing another tab fires no setViewState).
		this.publishLeave({ cause: 'tab', leaf });
		const view = leaf.view;
		const leafId = this.state.leafId(leaf);
		// A FileView with NO file is not another kind of destination — it is a moment: a sync
		// replaces a note by removing the file and renaming the download over it (see
		// position/path-bookkeeping.ts), and for that instant the tab still showing the note is a
		// FileView whose `file` is null. Recorded as a view it would mint a phantom place keyed
		// `view:markdown` — wearing the note's own name — that no delete could ever clean up,
		// because a view row has no file to go missing.
		if (view instanceof FileView) {
			if (view.file)
				this.publish({ record: { kind: 'visit', path: view.file.path, leafId, via: 'switch' }, cause: 'tab' });
			return;
		}
		// A DEFERRED leaf is a placeholder, not its view: it answers a view's questions off the
		// state it was restored with, so a note's own tab fails the instanceof above — and recorded
		// as a view it would mint a place keyed `view:markdown`, wearing the note's name and file
		// icon, that no delete could ever clean up. A file in that state is the note it stands for.
		if (isDeferredLeaf(leaf)) {
			const restored = deferredFilePath(view);
			if (restored) {
				this.publish({ record: { kind: 'visit', path: restored, leafId, via: 'switch' }, cause: 'tab' });
				return;
			}
		}
		// A main-area view is a destination in its own right, whatever its type is (see
		// isRecordableViewType for the one that is not a place). Three things about it are read here
		// and nowhere else, because the moment is the only one they are readable in: its display
		// name, the icon beside it, and its OWN STATE — the difference between "the view" and "the
		// place they went to" (see NavView.state). All three are optional: a silent failure of one
		// beats taking the reader's own tab switch down with it (see shared/leaf.ts).
		const viewType = view?.getViewType();
		if (!viewType || !isRecordableViewType(viewType))
			return;
		// A type this vault cannot build again is not a place: restoring its tab raises a
		// placeholder that claims to be it, and a place keyed on that claim can never be returned
		// to — and would be keyed like the real one, so it would also overwrite it.
		if (viewTypeIsMissing(this.app, viewType))
			return;
		// A markdown tab is ALWAYS a note — whatever failed to say so above. As a view it would be
		// a place with no file behind it, which nothing the reader or the vault does can ever
		// clean up.
		if (viewType === 'markdown')
			return;
		const record: DistributiveOmit<NavView, 't'> = { kind: 'view', leafId, viewType };
		const label = readViewLabel(view);
		if (label)
			record.label = label;
		const icon = readViewIcon(view);
		if (icon)
			record.icon = icon;
		const state = readViewState(view);
		if (state)
			record.state = state;
		this.publish({ record, cause: 'tab' });
	}

	// "Update on leave": the position of the place being left, read while the view still holds it.
	// Called by the setViewState patch, the traversal, the outline panel and the samplers' leave
	// reads.
	leave(path: string, leafId: string, st: NavEntryState) {
		this.publishLeave({ cause: 'read', path, leafId, st });
	}

	// The landing has settled (the reader stopped moving after a jump): this is the spot the jump
	// took them to, and the one position a place accepts.
	settled(path: string, leafId: string, st: NavEntryState) {
		this.publishLeave({ cause: 'settled', path, leafId, st });
	}

	// Reading-mode outline clicks are invisible to every other recording path; the capture hook
	// lives in outline-capture.ts and needs only this funnel.
	installOutlineCapture(registerCleanup: (fn: () => void) => void) {
		installOutlineCaptureHook(this.app, {
			state: this.state,
			leave: (path, leafId, st) => this.leave(path, leafId, st),
			recordOpen: (path, leafId, opts) => this.recordOpen(path, leafId, opts),
		}, registerCleanup);
	}

	// One position change the PLUGIN is making (a back/forward step, a travel to a place): its opens
	// are the traversal itself, and the poll must not record the programmatic applies as user
	// movement. The bracket also covers the traversal's startLeaf activation: that fires an
	// activation, and when the top step's leaf id is stale the dedup misses.
	async runBracketed(step: () => Promise<void>): Promise<void> {
		if (this.moving)
			return;
		this.moving = true;
		this.state.restoreStarted();
		// Watchdog and the finally share one settle: exactly one restoreEnded per restoreStarted (the
		// two keep a shared counter), and a hung traversal releases the gate so back/forward stay
		// usable. A late completion after the watchdog fired no-ops here.
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(watchdog);
			this.state.restoreEnded();
			this.moving = false;
		};
		const watchdog = window.setTimeout(settle, BRACKET_WATCHDOG_MS);
		try {
			await step();
		} finally {
			settle();
		}
	}

	// ===== The broadcasts =====

	// A step the stack decided on by itself — a travel to a place from the recent-files list. It
	// bypasses the shared gate on purpose: the stack IS the plugin moving, and it has already decided
	// this one is a real navigation. The record arrives with the step's own `t`.
	visit(recording: NavRecording) {
		this.publish(recording);
	}

	// A landing is now known, from either side: the stack, for a keyed jump it settled, or a sampler,
	// for a teleport whose scroll arrived one frame after the jump event. Each listener takes the
	// kinds it keeps.
	landing(entry: NewNavEntry) {
		for (const sink of this.sinks)
			sink.onLanded?.(entry);
	}

	// "You are here" moved — on the stack and on the place list alike.
	here(entry?: NavEntry) {
		for (const sink of this.sinks)
			sink.onHere?.(entry);
	}

	// ===== Internals =====

	private publish(recording: NavRecording) {
		for (const sink of this.sinks)
			sink.onVisit?.(recording);
	}

	private publishLeave(leave: NavLeave) {
		for (const sink of this.sinks)
			sink.onLeave?.(leave);
	}
}
