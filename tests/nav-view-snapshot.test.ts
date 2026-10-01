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

describe('一个视图怎么介绍自己', () => {
	it('保留普通对象形式的 state，而且是副本', () => {
		// A copy and not the view's own object: a view goes on mutating its state, and
		// a recording holding the reference would drift along with it — replaying the
		// place would then take the reader to wherever the view is NOW.
		const live = { filter: 'today' };

		const kept = viewState(viewOf({ state: live }))!;

		expect(kept).toEqual({ filter: 'today' });
		expect(kept).not.toBe(live);
	});

	it('读取失败的每一种情形都回答「没有」', () => {
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

	it('超过上限的 state 拒收', () => {
		// The blob shares localStorage with a whole list of places, so one plugin that
		// decides to keep its cache in its own view state must not be able to take the
		// list's budget with it.
		expect(viewState(viewOf({ state: { blob: 'x'.repeat(2048) } }))).toBeUndefined();
		expect(viewState(viewOf({ state: { blob: 'x'.repeat(1200) } })))
			.toEqual({ blob: 'x'.repeat(1200) });
	});

	it('根本序列化不了的 state 拒收', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(viewState(viewOf({ state: cyclic }))).toBeUndefined();
	});

	it('只有视图真的给了名字或图标时才保留', () => {
		expect(viewLabel(viewOf({ label: 'Thino' }))).toBe('Thino');
		expect(viewLabel(viewOf({ label: '' }))).toBeUndefined();
		expect(viewLabel(viewOf({ throwAt: 'label' }))).toBeUndefined();

		expect(viewIcon(viewOf({ icon: 'git-fork' }))).toBe('git-fork');
		expect(viewIcon(viewOf({ icon: '' }))).toBeUndefined();
		expect(viewIcon(viewOf({ throwAt: 'icon' }))).toBeUndefined();
	});
});

describe('裁剪一条存下来的视图记录', () => {
	const viewEntry = (over: Record<string, unknown> = {}): NavEntry =>
		({ kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', t: 1, ...over }) as NavEntry;

	it('丢掉那些名不副实的字段，记录本身留下', () => {
		// The blob is device-local storage that anything could have written. Dropping
		// the whole entry over one field would lose the PLACE, and all three fields
		// have a working fallback (see pruneViewSnapshot).
		const entry = viewEntry({ state: 'nope', icon: 42, label: '' });

		pruneViewSnapshot(entry);

		expect(entry).toEqual({ kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', t: 1 });
	});

	it('健康的记录不去动它，也绝不动别的 kind', () => {
		const sound = viewEntry({ state: { filter: 'today' }, icon: 'git-fork', label: 'Thino' });
		pruneViewSnapshot(sound);
		expect(sound).toMatchObject({ state: { filter: 'today' }, icon: 'git-fork', label: 'Thino' });

		const visit = { kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 } as NavEntry;
		pruneViewSnapshot(visit);
		expect(visit).toEqual({ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 1 });
	});
});

describe('读回一份存下来的视图快照', () => {
	it('进来时就裁掉 state，地点留下', () => {
		const app = makeApp();
		window.localStorage.setItem(navPlacesStorageKey(app), JSON.stringify({
			v: RECENT_PLACES_VERSION,
			places: [
				{ kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', t: 1, state: ['not', 'an', 'object'] },
			],
		}));

		const blob = loadNavPlaces(app);

		expect(blob.entries).toHaveLength(1);
		expect((blob.entries[0] as { state?: unknown }).state).toBeUndefined();
	});

	it('健康的快照在两张列表里都原样读回', () => {
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
