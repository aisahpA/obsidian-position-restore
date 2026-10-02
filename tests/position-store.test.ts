// PositionStore（position/storage/position-store.ts）的测试，它是架在
// 两个位置层之上的唯一门面：
//  - loadLeafStates：重启时把已存的覆盖层读进那张表；存储坏了退化成
//    空；残缺的条目（没有 path/state）直接丢掉，而不是照信；
//  - read：对它所命名的文件，标签页记录优先，否则退回文件记录，
//    带路径校验，且读了从不消耗；
//  - write：两层都更新，标签页记录没变时去重，头一次见到时只播种、
//    不碰文件层；
//  - persist：只写**真正的分歧** —— 那些文件记录里还没持有的标签页
//    值 —— 所以每个文件只有一个标签页时永远到不了 localStorage；
//  - renameFile / deleteFile：路径生命周期在**两层**上跑（这个门面正是
//    为修这个回归而生：一条记着已删路径的按标签页记录，会在该路径下
//    新出现的文件上被再次恢复）；
//  - pruneDeadLeaves：已关闭的标签页无法更新自己的记录。

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { App } from 'obsidian';
import { PositionStore } from '@/position/storage/position-store';
import { EphemeralState, TabStateRecord } from '@/types';
// leafStates / loadLeafStates 在 store 上是私有的；这是测试接缝。
import { leafStatesOf, loadLeafStates, setLeafStates } from './support/position-store-seam';

const APP_STUB = {
	appId: 'test-vault',
	vault: { getName: () => 'Test' },
} as unknown as App;

const STORAGE_KEY = 'position-restore:tabs:test-vault';

// CursorPositionDatabase 的最小替身：只带够观察 store 两层逻辑的文件层，
// 不把真类（及其 i18n / Notice 依赖）拖进一个存储单元测试里。
interface DbStub {
	db: Record<string, EphemeralState>;
	setState(filePath: string, st: EphemeralState): void;
	deleteFile(filePath: string): void;
	renameFile(newPath: string, oldPath: string): void;
	pruneDb(): number;
}

function makeDb(seed: Record<string, EphemeralState> = {}): DbStub {
	const db: Record<string, EphemeralState> = { ...seed };
	return {
		db,
		setState(filePath, st) { db[filePath] = st; },
		deleteFile(filePath) { delete db[filePath]; },
		renameFile(newPath, oldPath) {
			if (db[oldPath] === undefined) return;
			db[newPath] = db[oldPath];
			delete db[oldPath];
		},
		// 真正的裁剪拥有排除规则；store 只是镜像它的结果，
		// 所以测试直接删路径来驱动它。
		pruneDb: () => 0,
	};
}

function makeStore(db: DbStub = makeDb()): { store: PositionStore; db: DbStub } {
	return { store: new PositionStore(APP_STUB, db as never), db };
}

function seedStorage(records: Record<string, TabStateRecord> | string) {
	window.localStorage.setItem(STORAGE_KEY, typeof records === 'string' ? records : JSON.stringify(records));
}

function rec(path: string, scroll: number): TabStateRecord {
	return { filePath: path, st: { scroll } };
}

function persisted(): unknown {
	return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
}

beforeEach(() => {
	window.localStorage.clear();
});

describe('loadLeafStates', () => {
	it('把已存的覆盖层读成一张以标签页为键的表', () => {
		seedStorage({ 'leaf-1': rec('a.md', 42) });
		const records = loadLeafStates(APP_STUB);
		expect(records.get('leaf-1')).toEqual(rec('a.md', 42));
	});

	it('存的内容坏了就退化成空读，不抛错', () => {
		seedStorage('{not json');
		expect(loadLeafStates(APP_STUB).size).toBe(0);
	});

	it('丢掉残缺的条目（没有 path 或没有 state），而不是照信解析结果', () => {
		seedStorage(JSON.stringify({ 'leaf-1': { scroll: 1 }, 'leaf-2': rec('b.md', 2) }));
		const records = loadLeafStates(APP_STUB);
		expect(records.has('leaf-1')).toBe(false);
		expect(records.get('leaf-2')).toEqual(rec('b.md', 2));
	});
});

describe('read', () => {
	it('优先用它所指文件的标签页记录，带路径校验，读了也不消耗', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 } }));
		setLeafStates(store, [['leaf-1', rec('a.md', 42)]]);

		expect(store.read('leaf-1', 'a.md')).toEqual({ scroll: 42 });
		// 路径校验：标签页已经挪到另一个文件 → 由文件记录作答。
		expect(store.read('leaf-1', 'b.md')).toBeUndefined();
		// 未知标签页 → 由文件记录作答。
		expect(store.read('leaf-x', 'a.md')).toEqual({ scroll: 1 });
		// 读取从不消耗。
		expect(leafStatesOf(store).has('leaf-1')).toBe(true);
		expect(db.db['a.md']).toEqual({ scroll: 1 });
	});
});

describe('write', () => {
	it('两层都写', () => {
		const { store, db } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 7 });
		expect(db.db['a.md']).toEqual({ scroll: 7 });
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('a.md', 7));
	});

	it('标签页记录没变时空转不做', () => {
		const { store, db } = makeStore();
		const setState = (db.setState = vi.fn());
		setLeafStates(store, [['leaf-1', rec('a.md', 7)]]);

		store.write('leaf-1', 'a.md', { scroll: 7 });

		expect(setState).not.toHaveBeenCalled();
	});

	it('头一次见就与文件记录一致时只播种，不去写文件', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 7 } }));
		const setState = (db.setState = vi.fn());

		store.write('leaf-1', 'a.md', { scroll: 7 });

		expect(setState).not.toHaveBeenCalled();
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('a.md', 7));
	});

	it('同一个文件的两个标签页互不干扰（文件层拿着最后一次写）', () => {
		const { store, db } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });

		expect(db.db['a.md']).toEqual({ scroll: 100 });
		expect(store.read('leaf-1', 'a.md')).toEqual({ scroll: 10 });
		expect(store.read('leaf-2', 'a.md')).toEqual({ scroll: 100 });
	});
});

describe('persist —— 覆盖层只放真正的分歧', () => {
	it('每个标签页都与文件记录一致时，一个也不存', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.persist();
		expect(persisted()).toEqual({});
	});

	it('只存那些文件记录里没有的标签页值', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });
		// 文件记录里是 100，所以只有 leaf-1 有分歧。
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });
	});

	it('文件记录追上某个标签页后就不再存它', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });

		// leaf-2 挪到了 leaf-1 的位置：文件记录里现在也是 10，
		// 于是两个标签页都不再有分歧。
		store.write('leaf-2', 'a.md', { scroll: 10 });
		store.persist();
		expect(persisted()).toEqual({});
	});

	it('完全没有文件记录的标签页记录要留住（它是唯一的一份）', () => {
		const { store } = makeStore();
		setLeafStates(store, [['leaf-1', rec('a.md', 10)]]);
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });
	});

	it('localStorage 拒绝写入时安静降级（配额用尽 / 被禁用）', () => {
		const { store } = makeStore();
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		setLeafStates(store, [['leaf-1', rec('a.md', 10)]]);
		expect(() => store.persist()).not.toThrow();
		spy.mockRestore();
	});
});

describe('renameFile', () => {
	it('文件记录和指着该路径的标签页记录都要换键', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 } }));
		setLeafStates(store, [['leaf-1', rec('a.md', 42)]]);

		store.renameFile('b.md', 'a.md');

		expect(db.db['b.md']).toEqual({ scroll: 1 });
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('b.md', 42));
		// 换过键的标签页对新路径依然作答……
		expect(store.read('leaf-1', 'b.md')).toEqual({ scroll: 42 });
		// ……而旧路径已从两层里消失。
		expect(store.read('leaf-1', 'a.md')).toBeUndefined();
	});

	it('重启之后标签页仍认得改名后的文件', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 } }));
		setLeafStates(store, [['leaf-1', rec('a.md', 42)]]);
		store.renameFile('b.md', 'a.md');
		store.persist();

		const restarted = new PositionStore(APP_STUB, db as never);
		expect(restarted.read('leaf-1', 'b.md')).toEqual({ scroll: 42 });
	});
});

describe('deleteFile', () => {
	it('文件记录和所有指着该路径的标签页记录都丢掉', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 }, 'b.md': { scroll: 2 } }));
		setLeafStates(store, [
			['leaf-1', rec('a.md', 42)],
			['leaf-2', rec('a.md', 99)],
			['leaf-3', rec('b.md', 7)],
		]);

		store.deleteFile('a.md');

		expect(db.db['a.md']).toBeUndefined();
		expect(leafStatesOf(store).has('leaf-1')).toBe(false);
		expect(leafStatesOf(store).has('leaf-2')).toBe(false);
		// 其它路径原封未动。
		expect(leafStatesOf(store).get('leaf-3')).toEqual(rec('b.md', 7));
	});

	it('删掉的位置不许再交给同路径下的新文件', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 42 });
		store.deleteFile('a.md');

		// 文件在同一路径下被重新创建，并在同一个标签页里打开。
		expect(store.read('leaf-1', 'a.md')).toBeUndefined();
		store.write('leaf-1', 'a.md', { scroll: 3 });
		expect(store.read('leaf-1', 'a.md')).toEqual({ scroll: 3 });
	});

	it('路径删掉之后就不再落盘', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 10 });
		store.write('leaf-2', 'a.md', { scroll: 100 });
		store.persist();
		expect(persisted()).toEqual({ 'leaf-1': rec('a.md', 10) });

		store.deleteFile('a.md');
		store.persist();
		expect(persisted()).toEqual({});
	});
});

describe('dropExcluded', () => {
	// 文件还在 —— 只是记录规则拒绝它。这跟一次删除本质上是同一个动作，
	// 所以那个不在被轮询的标签页也会丢掉它的记录。
	it('丢掉与删除相同的那两层', () => {
		const { store, db } = makeStore(makeDb({ 'a.md': { scroll: 1 }, 'b.md': { scroll: 2 } }));
		setLeafStates(store, [
			['leaf-1', rec('a.md', 42)],
			['leaf-2', rec('a.md', 99)],
			['leaf-3', rec('b.md', 7)],
		]);

		store.dropExcluded('a.md');

		expect(db.db['a.md']).toBeUndefined();
		expect(leafStatesOf(store).has('leaf-1')).toBe(false);
		expect(leafStatesOf(store).has('leaf-2')).toBe(false);
		expect(leafStatesOf(store).get('leaf-3')).toEqual(rec('b.md', 7));
	});

	// 丢掉的东西是经「路径 → 标签页索引」找到的，而不是遍历这一层，
	// 所以索引必须跟着记录一起搬家。
	it('按标签页当前所在的文件丢，而不是它已经离开的那个', () => {
		const { store } = makeStore();
		store.write('leaf-1', 'a.md', { scroll: 42 });
		store.write('leaf-1', 'b.md', { scroll: 7 });

		// 标签页离开的那个文件上已经没有标签页了。
		store.dropExcluded('a.md');
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('b.md', 7));

		store.dropExcluded('b.md');
		expect(leafStatesOf(store).has('leaf-1')).toBe(false);
	});

	it('找得到被改名挪到新路径上的那些标签页', () => {
		const { store } = makeStore();
		setLeafStates(store, [['leaf-1', rec('a.md', 42)]]);
		store.renameFile('b.md', 'a.md');

		// 旧路径上现在什么都没有……
		store.dropExcluded('a.md');
		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('b.md', 42));

		// ……新路径上则有。
		store.dropExcluded('b.md');
		expect(leafStatesOf(store).has('leaf-1')).toBe(false);
	});
});

describe('pruneDatabase', () => {
	it('把文件层的清理镜像到标签页层', () => {
		const db = makeDb({ 'ex.txt': { scroll: 1 }, 'ok.md': { scroll: 2 } });
		db.pruneDb = () => {
			delete db.db['ex.txt']; // what the exclusion rules removed
			return 1;
		};
		const { store } = makeStore(db);
		setLeafStates(store, [
			['leaf-1', rec('ex.txt', 42)],
			['leaf-2', rec('ok.md', 7)],
		]);

		expect(store.pruneDatabase()).toBe(1);

		// 被排除的路径已从两层里消失；另一个完好无损。
		expect(leafStatesOf(store).has('leaf-1')).toBe(false);
		expect(leafStatesOf(store).get('leaf-2')).toEqual(rec('ok.md', 7));
		expect(store.read('leaf-1', 'ex.txt')).toBeUndefined();
	});

	it('文件层从未持有过的那类标签页记录，不去动它', () => {
		const db = makeDb({ 'other.md': { scroll: 1 } });
		db.pruneDb = () => {
			delete db.db['other.md'];
			return 1;
		};
		const { store } = makeStore(db);
		// new.md 从来就没有过文件记录：「不在 db 里」不能
		// 被读成「刚被裁剪掉」。
		setLeafStates(store, [['leaf-1', rec('new.md', 42)]]);

		store.pruneDatabase();

		expect(leafStatesOf(store).get('leaf-1')).toEqual(rec('new.md', 42));
	});

	it('丢掉过记录时要把覆盖层写出去（设置面板不是落盘点）', () => {
		const db = makeDb({ 'ex.txt': { scroll: 1 } });
		db.pruneDb = () => {
			delete db.db['ex.txt'];
			return 1;
		};
		const { store } = makeStore(db);
		setLeafStates(store, [['leaf-1', rec('ex.txt', 42)]]);

		store.pruneDatabase();

		expect(persisted()).toEqual({});
	});
});

describe('pruneDeadLeaves', () => {
	it('已经不存在的标签页，记录丢掉；还活着的留住', () => {
		const { store } = makeStore();
		setLeafStates(store, [
			['leaf-live', rec('a.md', 1)],
			['leaf-closed', rec('a.md', 2)],
		]);

		expect(store.pruneDeadLeaves(new Set(['leaf-live']))).toBe(true);
		expect(leafStatesOf(store).has('leaf-closed')).toBe(false);
		expect(leafStatesOf(store).get('leaf-live')).toEqual(rec('a.md', 1));
		// 无可丢弃 → 返回 false，好让调用方能跳过落盘。
		expect(store.pruneDeadLeaves(new Set(['leaf-live']))).toBe(false);
	});
});
