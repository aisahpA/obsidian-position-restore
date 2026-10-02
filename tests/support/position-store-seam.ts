// PositionStore 两个私有 overlay 成员的测试接缝。
//
// 这个类把 `leafStates`（每 leaf 一张映射）和 `loadLeafStates`（启动时的读取）留作私有：
// 生产里只有门面 —— read / write / forgetLeaf / deleteFile / renameFile / 那几趟 prune
// —— 才碰得到 overlay，而只为测试就把 API 放宽回 public，等于给生产代码开了第二条进来的
// 路。盯 overlay 行为的那些套件改从这一处 cast 进去，跟其他套件对待私有成员是同一个套路
// （它们的 InjectFn / ScrollCapture 别名）。

import type { App } from 'obsidian';
import { PositionStore } from '@/position/storage/position-store';
import type { TabStateRecord } from '@/types';

type Overlay = {
	leafStates: Map<string, TabStateRecord>;
	putLeaf(leafId: string, record: TabStateRecord): void;
	reindexLeaves(): void;
};

// store 那份活的 leaf 映射，只读。之所以只读，是因为 store 从它推导出 path → leaf
// 索引：一个通过这张映射塞数据的测试会把索引落在后面，store 于是找不到递给它的那个 leaf。
export function leafStatesOf(store: PositionStore): ReadonlyMap<string, TabStateRecord> {
	return (store as unknown as Overlay).leafStates;
}

// 整张换掉：给测试一个预置基线，就像构造函数刚从存储里把它读出来一样。重建索引也是
// 同一个理由 —— 真正的那次启动读取是由构造函数重建索引的。
export function setLeafStates(store: PositionStore, records: Iterable<readonly [string, TabStateRecord]>): void {
	const o = store as unknown as Overlay;
	o.leafStates = new Map(records);
	o.reindexLeaves();
}

// 一个 leaf 的预置记录，走 store 自己那条写入路径 —— 生产里记录就是这么进到映射里的。
export function seedLeaf(store: PositionStore, leafId: string, record: TabStateRecord): void {
	(store as unknown as Overlay).putLeaf(leafId, record);
}

// 启动时的那次读取，不必有 store 实例也能走到。
export function loadLeafStates(app: App): Map<string, TabStateRecord> {
	return (PositionStore as unknown as { loadLeafStates: (app: App) => Map<string, TabStateRecord> }).loadLeafStates(app);
}
