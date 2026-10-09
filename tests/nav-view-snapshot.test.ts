// 一个**视图**对插件说的关于**它自己**的话的测试：读者还在里面时从视图上读到的名字、
// 图标与 state（shared/leaf.ts），一个存下来的快照被信任成什么样（nav/entry.ts 的
// pruneViewSnapshot），以及两张列表对它们的加载。
//
// 它们住在一起，是因为这三个字段是一条导航记录里唯一来自**外来**方法的部分，也是唯一
// 会被读回去、进到一次回放（`setViewState`）或 DOM 里的部分。下面每一道闸门回答的都是
// 同一个问题：一个已经不再跟我们说话的视图，关于它能信什么。

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

// 一个视图桩：本插件就视图自身问它的那三个方法，各自是个 thunk，好让测试能叫其中一个
// 抛 —— 这正是 shared/leaf.ts 里每一道守卫为之存在的失败模式。
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
		// 是副本，不是视图自己那个对象：视图会继续改动它的 state，而一条持有引用的记录会跟着
		// 一起漂 —— 那样回放这个地点时，会把读者带到视图**此刻**所在的地方。
		const live = { filter: 'today' };

		const kept = viewState(viewOf({ state: live }))!;

		expect(kept).toEqual({ filter: 'today' });
		expect(kept).not.toBe(live);
	});

	it('读取失败的每一种情形都回答「没有」', () => {
		// 每一种都在下游有一条能用的退路：没有 state 就按默认值回放该视图，没有图标就让那一行
		// 说「视图」，没有名字就让它印出视图类型。
		expect(viewState(undefined)).toBeUndefined();
		expect(viewState(viewOf({ throwAt: 'state' }))).toBeUndefined();
		expect(viewState(viewOf({ state: undefined }))).toBeUndefined();
		expect(viewState(viewOf({ state: [] }))).toBeUndefined();
		expect(viewState(viewOf({ state: 'nope' }))).toBeUndefined();
		// 序列化之后什么都不剩，就是没什么可回放的：全局图谱答的是一个空对象，而 `{}` 本来也是
		// 它重建时会用的东西（见 stack.ts 的 `state ?? {}`）。
		expect(viewState(viewOf({ state: {} }))).toBeUndefined();
		expect(viewState(viewOf({ state: { gone: undefined } }))).toBeUndefined();
	});

	it('超过上限的 state 拒收', () => {
		// 这一坨与一整张地点列表共用同一个 localStorage，所以某个决定把自己的缓存塞进自己 view
		// state 的插件，绝不能顺手把列表的预算也带走。
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
		// 这一坨是本机存储，什么都有可能写过它。为一个字段就把整条记录丢掉会丢掉那个**地点**，
		// 而这三个字段每一个都有能用的退路（见 pruneViewSnapshot）。
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
