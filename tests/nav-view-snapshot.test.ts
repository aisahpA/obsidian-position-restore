// Tests for what a VIEW tells the plugin about ITSELF: the name, the icon and the
// state read off a view while the reader is in it (shared/leaf.ts), the shape a
// stored one is trusted to have (nav/entry.ts's pruneViewSnapshot), and the two
// lists' loading of them.
//
// They live together because the three fields are the only part of a nav entry that
// comes from a FOREIGN method and the only part read back out into a replay
// (`setViewState`) or into the DOM. Every gate below answers the same question:
// what may be believed about a view that is not talking to us any more.

import { describe, it, expect, beforeEach } from 'vitest';
import type { View } from 'obsidian';

import { NavEntry, pruneViewSnapshot } from '@/nav/entry';
import { viewIcon, viewLabel, viewState } from '@/shared/leaf';
import { NAV_HISTORY_VERSION, loadNavHistory, navHistoryStorageKey } from '@/nav-history/store';
import { RECENT_PLACES_VERSION, loadNavPlaces, navPlacesStorageKey } from '@/recent-files/places-store';
import { makeApp } from './support/nav-recording-harness';

beforeEach(() => {
	window.localStorage.clear();
});

// A view stub: the three methods this plugin asks a view about itself, each a thunk
// so a test can make one of them throw — the failure mode every guard in
// shared/leaf.ts exists for.
function viewOf(parts: {
	label?: unknown; icon?: unknown; state?: unknown;
	throwAt?: 'label' | 'icon' | 'state';
}): View {
	const call = (method: 'label' | 'icon' | 'state', value: unknown) => () => {
		if (parts.throwAt === method)
			throw new Error(`${method} exploded`);
		return value;
	};
	return {
		getDisplayText: call('label', parts.label),
		getIcon: call('icon', parts.icon),
		getState: call('state', parts.state),
	} as unknown as View;
}

describe('what a view says about itself', () => {
	it('keeps a plain object state, as a COPY', () => {
		// A copy and not the view's own object: a view goes on mutating its state, and
		// a recording holding the reference would drift along with it — replaying the
		// place would then take the reader to wherever the view is NOW.
		const live = { filter: 'today' };

		const kept = viewState(viewOf({ state: live }))!;

		expect(kept).toEqual({ filter: 'today' });
		expect(kept).not.toBe(live);
	});

	it('answers nothing for every way the read can fail', () => {
		// Each has a working fallback downstream: no state replays the view at its
		// defaults, no icon makes the row say "view", no name makes it print the view
		// type.
		expect(viewState(undefined)).toBeUndefined();
		expect(viewState(viewOf({ throwAt: 'state' }))).toBeUndefined();
		expect(viewState(viewOf({ state: undefined }))).toBeUndefined();
		expect(viewState(viewOf({ state: [] }))).toBeUndefined();
		expect(viewState(viewOf({ state: 'nope' }))).toBeUndefined();
		// Nothing left after serialization is nothing to replay: the global graph
		// answers with an empty object, and `{}` is what it would be rebuilt with
		// anyway (see stack.ts's `state ?? {}`).
		expect(viewState(viewOf({ state: {} }))).toBeUndefined();
		expect(viewState(viewOf({ state: { gone: undefined } }))).toBeUndefined();
	});

	it('refuses a state over the ceiling', () => {
		// The blob shares localStorage with a whole list of places, so one plugin that
		// decides to keep its cache in its own view state must not be able to take the
		// list's budget with it.
		expect(viewState(viewOf({ state: { blob: 'x'.repeat(2048) } }))).toBeUndefined();
		expect(viewState(viewOf({ state: { blob: 'x'.repeat(1200) } })))
			.toEqual({ blob: 'x'.repeat(1200) });
	});

	it('refuses a state it cannot serialize at all', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(viewState(viewOf({ state: cyclic }))).toBeUndefined();
	});

	it('keeps a name and an icon only where the view really named one', () => {
		expect(viewLabel(viewOf({ label: 'Thino' }))).toBe('Thino');
		expect(viewLabel(viewOf({ label: '' }))).toBeUndefined();
		expect(viewLabel(viewOf({ throwAt: 'label' }))).toBeUndefined();

		expect(viewIcon(viewOf({ icon: 'git-fork' }))).toBe('git-fork');
		expect(viewIcon(viewOf({ icon: '' }))).toBeUndefined();
		expect(viewIcon(viewOf({ throwAt: 'icon' }))).toBeUndefined();
	});
});

describe('pruning a stored view entry', () => {
	const viewEntry = (over: Record<string, unknown> = {}): NavEntry =>
		({ kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', t: 1, ...over }) as NavEntry;

	it('drops the fields that are not what they claim, and keeps the entry', () => {
		// The blob is device-local storage that anything could have written. Dropping
		// the whole entry over one field would lose the PLACE, and all three fields
		// have a working fallback (see pruneViewSnapshot).
		const entry = viewEntry({ state: 'nope', icon: 42, label: '' });

		pruneViewSnapshot(entry);

		expect(entry).toEqual({ kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', t: 1 });
	});

	it('leaves a sound entry alone, and never touches another kind', () => {
		const sound = viewEntry({ state: { filter: 'today' }, icon: 'git-fork', label: 'Thino' });
		pruneViewSnapshot(sound);
		expect(sound).toMatchObject({ state: { filter: 'today' }, icon: 'git-fork', label: 'Thino' });

		const visit = { kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 } as NavEntry;
		pruneViewSnapshot(visit);
		expect(visit).toEqual({ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 });
	});
});

describe('loading a stored view snapshot', () => {
	it('prunes the state on the way in, and keeps the place', () => {
		const app = makeApp();
		window.localStorage.setItem(navPlacesStorageKey(app), JSON.stringify({
			v: RECENT_PLACES_VERSION,
			places: [
				{ kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', t: 1, state: ['not', 'an', 'object'] },
			],
		}));

		const places = loadNavPlaces(app);

		expect(places).toHaveLength(1);
		expect((places[0] as { state?: unknown }).state).toBeUndefined();
	});

	it('reads a sound snapshot straight back, in either list', () => {
		const app = makeApp();
		window.localStorage.setItem(navHistoryStorageKey(app), JSON.stringify({
			v: NAV_HISTORY_VERSION,
			index: 0,
			entries: [
				{ kind: 'view', leafId: 'leaf-1', viewType: 'localgraph', t: 1, state: { file: 'a.md' }, icon: 'git-fork' },
			],
		}));

		const { entries } = loadNavHistory(app);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ state: { file: 'a.md' }, icon: 'git-fork' });
	});
});
