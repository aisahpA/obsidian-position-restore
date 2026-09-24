import { App, FileView, WorkspaceLeaf } from 'obsidian';
import { NavEntryState } from '@/types';
import {
	NavEntry, NavTeleport, NavView, NewNavEntry, DistributiveOmit, isRecordableViewType,
} from './entry';
import { PositionState } from '@/position/state';
import { isMainAreaLeaf, viewIcon as readViewIcon, viewLabel as readViewLabel, viewState as readViewState } from '@/shared/leaf';
import { installOutlineCapture as installOutlineCaptureHook } from './outline-capture';

// THE RECORDING FUNNEL — one navigation, several readers.
//
// Recording used to live inside the back/forward stack (see nav-history/stack.ts),
// which made the stack a SECOND-HAND reporter of everything: the recent-files list
// could only hear about a navigation the stack had already decided to keep, so its
// own rules (a tab switch counts even when the stack is told not to record it; the
// reader's folders; what a place is) were silently governed by the stack's settings,
// its dedup, and its ceiling. The funnel is that reporting split out and made
// neutral: the CAPTURE POINTS (the setViewState patch, the poll, the outline panel,
// the workspace's active-leaf-change) write here, and the readers subscribe.
//
// TWO GROUPS OF METHODS, and the difference is who gets to decide:
//
//  - the CAPTURE SURFACE (record*, leave, settled). A capture point does not know
//    what a navigation means — it only knows what it saw. The funnel turns that into
//    a record (the vocabulary is entry.ts) and applies THE SHARED GATES, which
//    answer one question with nothing to do with any listener: did the reader
//    navigate, or did the plugin move the view itself? A traversal's own opens
//    (runBracketed) and the startup rebuild (layoutReady) are not navigations, so
//    nothing is published for them at all. A setting like "record tab switches" is
//    NOT such a gate: that is the stack's opinion about its own list, and each
//    reader applies its own below.
//  - the BROADCASTS (visit, landing, here). These are facts somebody has already
//    established — the stack when it decides a travel is a real step, whoever heard
//    a jump settle, the stack when its pointer moves — published to every listener.
//
// A READER IS A LISTENER. The stack keeps steps; the recent-files list keeps places.
// They are fed from the same recordings and keep different things, and neither knows
// the other exists. Every hook is optional: a listener that has no use for a fact
// simply does not implement it (the place list never wants a "leave", because its
// rows promise where a jump LANDED, never where the reader drifted).

// How a navigation got here — the only thing a reader cannot read off the record
// itself, and the reason two readers can apply different gates to the same fact
// (the stack's "record tab switches" is keyed on it PLUS the record's kind: a view
// can only ever arrive this way, so its own gate would swallow the whole kind — see
// stack.ts's onVisit. "Cursor jump distance" is keyed on the cause alone — how
// far a move actually went is the sampler's measurement, not the stack's.)
//   open     — an ordinary file open (the setViewState patch)
//   jump     — a keyed jump: an outline item, an anchor link, a search/backlink target
//   tab      — a tab/pane activation (VSCode records active-editor changes the same way)
//   teleport — an INFERRED same-file cursor jump (the sampler's heuristic)
export type NavCause = 'open' | 'jump' | 'tab' | 'teleport';

// One navigation, as it reaches the listeners. `record` is what it would look like
// as a step (see entry.ts); a LISTENER decides whether it keeps it.
export interface NavRecording {
	record: NewNavEntry;
	cause: NavCause;
	// An explicit target jump (a same-file search match / backlink flash): the
	// reader asked for that spot, so a step is recorded even when the top of the
	// stack already looks identical. Only the stack reads this.
	forced?: boolean;
}

// A position read: where a place WAS when the reader left it, or where a jump
// actually landed. The two are deliberately different facts — the stack takes both
// (it needs *some* position to return to), while a place keeps only the landing,
// because its row promises the jump's own spot and not wherever the reader drifted
// before leaving.
export type NavLeave =
	// The reader left this place; this is where they were.
	| { cause: 'read'; path: string; leafId: string; st: NavEntryState }
	// A jump's landing settled: this is the spot it actually took them to.
	| { cause: 'settled'; path: string; leafId: string; st: NavEntryState }
	// A tab/pane activation: the leaf taking over holds a position of its own, and
	// the entry being left still describes the file behind it.
	| { cause: 'tab'; leaf: WorkspaceLeaf };

// What a reader can be told. All optional — implement what you keep.
export interface NavFunnelSink {
	// A navigation happened (already past the shared gates). The stack compares it
	// against its own top before pushing; the place list re-orders its MRU.
	onVisit?(recording: NavRecording): void;
	// A position read (see NavLeave). Only the stack implements this today.
	onLeave?(leave: NavLeave): void;
	// A jump's landing is now known — a keyed jump settling, or a teleport's scroll
	// arriving one frame after the jump event. Carries the entry's IDENTIFYING fields
	// (a place's identity is the jump's key, which only the entry, after its key
	// upgrade, names) but not its stamp: a landing describes an entry that already
	// exists, and its `t` belongs to whoever pushed it (see the stack's push).
	onLanded?(entry: NewNavEntry): void;
	// "You are here" moved. Carries the step the pointer moved to; undefined when
	// there is none to stand on.
	onHere?(entry?: NavEntry): void;
}

// Watchdog releasing a bracket if a traversal await hangs (openFile /
// loadIfDeferred never resolve): without it the funnel would stay "moving"
// forever and permanently disable back/forward. Sits above the legit apply
// ceiling (SETTLE_MAX_MS 800 + RELAND_MAX_MS 3000 + anchor delays), so
// slow-but-progressing traversals are never cut off.
const BRACKET_WATCHDOG_MS = 5000;

export class NavFunnel {
	private readonly app: App;
	private readonly state: PositionState;
	private readonly sinks = new Set<NavFunnelSink>();

	// True while the plugin is moving the view itself: the opens a traversal
	// triggers are the traversal, not new jumps.
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

	// The shared gate: is this a navigation the reader made, or the plugin moving
	// itself? Both halves are the same question and neither has anything to do with
	// a listener — a traversal's own open and the startup rebuild are not
	// navigations for anybody.
	isRecording(): boolean {
		return !this.moving && this.app.workspace.layoutReady;
	}

	// Is a bracket up right now (a traversal of ours is in flight)? The question a
	// command has to ask before starting another one; not the same as the gate
	// above, which also answers "has the workspace finished coming up".
	isMoving(): boolean {
		return this.moving;
	}

	// ===== The capture surface =====

	// A file open (the setViewState patch), an in-file jump marker, or a pathless
	// view activation (opts.viewType — the graph tab and every other view).
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
			// A pathless view is reached by activating its leaf. Its name and icon
			// ride along when the caller has them: they are what the row will print
			// and draw (see NavView.label / NavView.icon), and a caller that knows
			// only the type leaves them off — the browser then answers with its own
			// wording and its own mark. So does its state, which is what the place
			// is rebuilt with if that leaf is gone by the time the reader returns
			// (see NavView.state).
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

	// Large same-file cursor jump (go-to-line, vim jump, far mouse click): one
	// per selection event, desktop only — a swipe moves no cursor and a tap lands
	// within the screenful, so a touch device has nothing left to infer. An
	// INFERRED move, not a deliberate jump — whether it is worth a step is the
	// stack's call (its navHistoryTeleportMinLines threshold); the landing is the
	// post-jump read when one arrived with the call.
	recordTeleport(path: string, leafId: string, line: number, landing?: NavEntryState) {
		if (!this.isRecording())
			return;
		const record: DistributiveOmit<NavTeleport, 't'> = { kind: 'teleport', path, leafId, line };
		if (landing)
			record.st = landing;
		this.publish({ record, cause: 'teleport' });
	}

	// Tab/pane activation as navigation (VSCode records active-editor changes the
	// same way). Sidebar panels are excluded — they track the active file in their
	// own view state, and recording one would make a phantom step out of the panel.
	// A VIEW activation is published the same way as a file tab's, and it is a step
	// whatever the stack's tab-switch setting says: activating the leaf is the only
	// way a view can ever be entered, so this is where every view record in the
	// whole plugin is born (see stack.ts's onVisit).
	recordActivation(leaf: WorkspaceLeaf | null) {
		if (!leaf || !isMainAreaLeaf(this.app, leaf) || !this.isRecording())
			return;
		// The tab being LEFT still holds the position of the file behind it, and the
		// activation is the only moment it is still readable (focusing another tab
		// fires no setViewState).
		this.publishLeave({ cause: 'tab', leaf });
		const view = leaf.view;
		const leafId = this.state.leafId(leaf);
		// A FileView is either the visit it names or nothing at all. One with NO file is
		// not another kind of destination — it is a moment: a sync replaces a note by
		// removing the file and renaming the download over it (see
		// position/path-bookkeeping.ts), and for that instant the tab still showing the
		// note is a FileView whose `file` is null. Recording it as a view used to mint a
		// phantom place — keyed `view:markdown`, wearing the note's own name and the
		// FileView's file icon, indistinguishable from a real row — that no delete could
		// ever clean up, because a view row has no file to go missing. It sat in the list
		// until the reader took it off by hand.
		if (view instanceof FileView) {
			if (view.file)
				this.publish({ record: { kind: 'visit', path: view.file.path, leafId, via: 'switch' }, cause: 'tab' });
			return;
		}
		// A main-area view is a destination in its own right, whatever its type is:
		// the reader went there, which is what this list records (see
		// isRecordableViewType for the one type that is not a place). Three things
		// about it are read here and nowhere else, because the moment is the only
		// one they are readable in: its display name (what the tab header said), the
		// icon beside that name, and its OWN STATE — which is the difference between
		// "the view" and "the place they went to", and the only thing about a view a
		// later reader cannot derive (see NavView.state). All three are optional and
		// a silent failure of any one beats taking the reader's own tab switch down
		// with it (see shared/leaf.ts).
		const viewType = view?.getViewType();
		if (!viewType || !isRecordableViewType(viewType))
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

	// "Update on leave": the position of the place being left, read while the view
	// still holds it. Called by the setViewState patch, the traversal, the outline
	// panel and the samplers' leave reads.
	leave(path: string, leafId: string, st: NavEntryState) {
		this.publishLeave({ cause: 'read', path, leafId, st });
	}

	// The landing has settled (the reader stopped moving after a jump): this is the
	// spot the jump took them to, and the one position a place accepts.
	settled(path: string, leafId: string, st: NavEntryState) {
		this.publishLeave({ cause: 'settled', path, leafId, st });
	}

	// Reading-mode outline clicks are invisible to every other recording path; the
	// capture hook lives in outline-capture.ts and needs only this funnel.
	installOutlineCapture(registerCleanup: (fn: () => void) => void) {
		installOutlineCaptureHook(this.app, {
			state: this.state,
			leave: (path, leafId, st) => this.leave(path, leafId, st),
			recordOpen: (path, leafId, opts) => this.recordOpen(path, leafId, opts),
		}, registerCleanup);
	}

	// One position change the PLUGIN is making (a back/forward step, a travel to a
	// place): its opens are the traversal itself, not new jumps, and the poll must
	// not record the programmatic applies as user movement. The bracket also covers
	// the traversal's startLeaf activation: that fires an activation, and when the
	// top step's leaf id is stale the dedup misses — the command itself would record
	// a step before any gate was up.
	async runBracketed(step: () => Promise<void>): Promise<void> {
		if (this.moving)
			return;
		this.moving = true;
		this.state.restoreStarted();
		// Watchdog and the finally share one settle: exactly one restoreEnded per
		// restoreStarted (the two keep a shared counter), and a hung traversal
		// releases the gate so back/forward stay usable. A late completion after the
		// watchdog fired simply no-ops here.
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

	// A step the stack decided on by itself — a travel to a place from the recent
	// files list. It bypasses the shared gate on purpose: the stack IS the plugin
	// moving, and it has already decided this one is a real navigation. The record
	// arrives with the step's own `t`, which the stack re-stamps when it pushes.
	visit(recording: NavRecording) {
		this.publish(recording);
	}

	// A landing is now known, from either side: the stack, for a keyed jump it
	// settled (with the entry, whose key it just upgraded), or a sampler, for a
	// teleport whose scroll arrived one frame after the jump event. Each listener
	// takes the kinds it keeps.
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
