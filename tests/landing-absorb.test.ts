// Regression tests for the landing-absorb fix: an open-kind jump
// (anchorLink/startPlainLink/callerTarget — a sidebar search-result click or
// link target) lands asynchronously, so recording must stay in absorb mode
// until the landing settles, or the jump itself gets written as user
// movement.
//
//  - the patcher arms the absorb synchronously at setViewState time — NOT in
//    the restorer's file-open handler, because a same-file search-result
//    click fires no 'file-open' and the restorer would never arm;
//  - while armed, the 100ms poll re-baselines lastEphemeralState to the
//    landing point without writing to the db;
//  - the poll expires the finite absorb early once the view stops moving
//    (stability check), so the ceiling (LANDING_ABSORB_MS) is not a hard
//    delay swallowing post-landing user movement;
//  - the search-input blur grace timer must not expire the armed finite
//    anchor mid-landing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MarkdownView, WorkspaceLeaf } from 'obsidian';
import { OpenPatcher } from '../src/patcher';
import { Sampler } from '../src/sampler';
import { PositionState, LANDING_ABSORB_MS } from '../src/position-state';
import { TabStore } from '../src/tab-store';
import { DEFAULT_SETTINGS, PluginSettings } from '../src/types';

type DatabaseStub = {
	db: Record<string, unknown>;
	setState: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
};

// OpenCover styles leaf DOM via Obsidian's HTMLElement.setCssStyles
// extension, which jsdom lacks.
beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

type ViewState = { type?: unknown; state?: { file?: unknown; mode?: unknown } };
type InjectFn = (
	leaf: WorkspaceLeaf,
	viewState: ViewState,
	eState: Record<string, unknown> | undefined,
) => unknown;

const SOURCE_OPEN_A = (file = 'a.md'): ViewState => ({
	type: 'markdown',
	state: { file, mode: 'source' },
});

function makeLeaf(id: string): WorkspaceLeaf {
	return {
		id,
		containerEl: document.createElement('div'),
	} as unknown as WorkspaceLeaf;
}

function makeFakeMarkdownView(path: string, containerEl: HTMLElement): MarkdownView {
	containerEl.setCssStyles = vi.fn();
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path },
		containerEl,
		contentEl: containerEl,
		leaf: { id: 'leaf-1', containerEl },
		currentMode: { getScroll: () => 42.3 }, // quantizes to 42
		editor: {
			lineCount: () => 100,
			getCursor: () => ({ line: 3, ch: 7 }),
		},
		getViewType: () => 'markdown',
	}) as MarkdownView;
	return view;
}

function makePollHarness() {
	const containerEl = document.createElement('div');
	const view = makeFakeMarkdownView('a.md', containerEl);
	const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
	const app = {
		workspace: { getActiveViewOfType: () => view, containerEl },
		metadataCache: { getFileCache: () => null },
	};
	const settings = DEFAULT_SETTINGS as PluginSettings;
	const state = new PositionState(settings);
	const sampler = new Sampler(app as never, database as never, settings, state);
	state.lastLoadedFilePath = 'a.md';
	return { sampler, state, database, view };
}

function setCursor(view: MarkdownView, line: number, ch: number) {
	(view as unknown as { editor: { getCursor: () => { line: number; ch: number } } }).editor.getCursor =
		() => ({ line, ch });
}

describe('OpenPatcher — arms the landing absorb at setViewState time', () => {
	it('arms a finite absorb when a caller-target open (search match) is dispatched', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const leaf = makeLeaf('leaf-1');
		const app = { workspace: { layoutReady: true } } as never;
		const tabStore = new TabStore(app, { db: {} } as never, state);
		const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, tabStore);
		const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);

		// Search-result clicks pass eState.match (verified against core's
		// search-view onResultClick). The absorb must be armed synchronously
		// here — a same-file result click fires no 'file-open', so the
		// restorer would never get the chance.
		const eState = { match: {} };
		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
		expect(state.searchAnchorUntil).toBeGreaterThan(Date.now());
		expect(state.searchAnchorUntil).toBeLessThanOrEqual(Date.now() + LANDING_ABSORB_MS);
		expect(Number.isFinite(state.searchAnchorUntil)).toBe(true);
	});

	it('does not arm for an injected (non-overridden) open', () => {
		const state = new PositionState(DEFAULT_SETTINGS);
		const leaf = makeLeaf('leaf-1');
		const app = { workspace: { layoutReady: true } } as never;
		const tabStore = new TabStore(app, { db: { 'a.md': { scroll: 5 } } } as never, state);
		const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, tabStore);
		const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 5 });
		expect(state.searchAnchorUntil).toBe(0);
	});
});

describe('Sampler poll — absorbs the landing while armed', () => {
	it('re-baselines lastEphemeralState to the landing without a db write', () => {
		const { sampler, state, database, view } = makePollHarness();

		// Patcher armed the absorb for the open-kind jump.
		state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;

		// Tick 1: baseline seed (pre-landing state, cursor at 3:7).
		sampler.checkEphemeralStateChanged();
		expect(database.setState).not.toHaveBeenCalled();
		expect(state.lastEphemeralState?.cursor).toMatchObject({ from: { line: 3, ch: 7 } });

		// The jump lands: cursor hops to the search match.
		setCursor(view, 12, 3);
		sampler.checkEphemeralStateChanged();
		// Absorbed: no db write, baseline tracks the landing.
		expect(database.setState).not.toHaveBeenCalled();
		expect(state.lastEphemeralState?.cursor).toMatchObject({ from: { line: 12, ch: 3 } });

		// Absorb expired: the first deliberate user move records normally.
		state.searchAnchorUntil = Date.now() - 1;
		setCursor(view, 20, 0);
		sampler.checkEphemeralStateChanged();
		expect(database.setState).toHaveBeenCalledTimes(1);
	});

	it('expires the finite absorb early once the view stops moving', () => {
		const { sampler, state } = makePollHarness();
		state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;

		// Seed the baseline (prev undefined on tick 1).
		sampler.checkEphemeralStateChanged();
		expect(state.searchAnchorUntil).toBeGreaterThan(Date.now());

		// Two consecutive stable ticks = the landing has settled -> expire.
		sampler.checkEphemeralStateChanged();
		sampler.checkEphemeralStateChanged();
		expect(state.searchAnchorUntil).toBeLessThanOrEqual(Date.now());
	});
});

describe('Sampler.installSearchAnchor — blur grace timer vs landing absorb', () => {
	let cleanups: (() => void)[];

	beforeEach(() => {
		cleanups = [];
		vi.useFakeTimers();
	});
	afterEach(() => {
		cleanups.forEach((fn) => fn());
		cleanups = [];
		vi.useRealTimers();
	});

	function makeAnchorHarness() {
		const state = new PositionState(DEFAULT_SETTINGS);
		const database: DatabaseStub = { db: {}, setState: vi.fn(), deleteFile: vi.fn() };
		const sampler = new Sampler({} as never, database as never, DEFAULT_SETTINGS, state);
		sampler.installSearchAnchor((fn) => cleanups.push(fn));
		return { sampler, state };
	}

	function makeSearchInput() {
		const wrapper = document.createElement('div');
		wrapper.className = 'search-input-container';
		const input = document.createElement('input');
		wrapper.appendChild(input);
		document.body.appendChild(wrapper);
		return input;
	}

	function focusInput(input: HTMLElement) {
		input.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
	}

	function blurInput(input: HTMLElement) {
		input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
	}

	it('does not expire a finite anchor armed for a landing', () => {
		const { state } = makeAnchorHarness();
		const input = makeSearchInput();

		// Focus the search input (anchor = Infinity), then the patcher
		// re-arms a finite landing-absorb window at the result click.
		focusInput(input);
		expect(state.searchAnchorUntil).toBe(Number.POSITIVE_INFINITY);
		state.searchAnchorUntil = Date.now() + LANDING_ABSORB_MS;

		// The result click blurs the input; 250ms later the grace timer must
		// NOT expire the armed absorb (it only expires the Infinity blur).
		blurInput(input);
		vi.advanceTimersByTime(300);
		expect(state.searchAnchorUntil).toBeGreaterThan(Date.now());
	});

	it('still expires a plain blur normally', () => {
		const { state } = makeAnchorHarness();
		const input = makeSearchInput();

		focusInput(input);
		blurInput(input);
		vi.advanceTimersByTime(300);
		expect(state.searchAnchorUntil).toBeLessThanOrEqual(Date.now());
	});
});