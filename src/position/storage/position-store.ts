import type { App } from 'obsidian';
import { EphemeralState, TabStateRecord } from '@/types';
import { isEphemeralStatesEquals } from '@/shared/ephemeral-equals';
import type { CursorPositionDatabase } from './database';

// 插件两个位置层之上唯一的门面。每一次读、写与路径变更都走这里，所以两层不会各自漂开。
//
// 第 1 层 —— 文件层（CursorPositionDatabase，`positions.json`）：每个 vault 路径一条记录。
//   共享、会同步：它是跟着你去另一台设备的那个位置。
// 第 2 层 —— leaf 层（leafStates）：每个工作区 leaf 一条记录，设备本地，它存在只为一个
//   理由 —— 同一个文件开在两个标签页就是两个位置，而文件层只装得下其中一个。读取的优先级
//   是逐 leaf 的：当 leaf 自己的记录点的正是要打开的那个文件时它说了算，否则由文件记录回答。
//
// 第 2 层**持久化**的不是整张表，而是真正的分歧：恰好是那些值与同路径的文件记录不同的
// leaf 记录。其余的已经在第 1 层的磁盘上了，再持久化一遍只是重复（而重复是一份会过期的
// 拷贝）。所以这个 overlay 在稳态下什么都不装 —— 每个文件只有一个标签页时，从不写
// localStorage。
//
// 这条规则也正是让两层能自愈的原因：改名给两边都重新作键，删除把两边都丢掉，而一个值已经
// 被文件层追上的 leaf，就是简单地不再被持久化，而不是钉住一个读者早已离开的位置。

export class PositionStore {
	private app: App;
	private database: CursorPositionDatabase;
	// 上一次写进 localStorage 的 blob：持久化去重，于是一轮没变化的持久化（5s flush tick 而
	// 没有任何分歧时）只花一次 stringify。
	private lastPersisted = '';
	// leaf.id -> 这个 leaf 最后记录的位置，读取时按路径把关。第 2 层在内存里的真身：采样器
	// 变化检测的基准，也是恢复时某个标签页自己那处位置的来源。
	private leafStates: Map<string, TabStateRecord>;
	// path -> 正在显示它的那些 leaf，派生自上面那张表。它存在的意义是：可以直接问某个路径
	// 上有哪些 leaf，而不用把整层走一遍去找：轮询每 100ms 就问一次它所在的那个文件，
	// 而答案几乎总是「一个 leaf 都没有」。
	private leavesByPath = new Map<string, Set<string>>();

	constructor(app: App, database: CursorPositionDatabase) {
		this.app = app;
		this.database = database;
		this.leafStates = PositionStore.loadLeafStates(app);
		this.reindexLeaves();
	}

	// 桌面端的 localStorage 跨 vault 共享（同一个 app origin）；appId 是逐 vault 的区分项。
	// 不在公开类型里。做成静态，好让启动时的读取能在实例存在之前就拼出这个键：读方与写方
	// 必须对它完全一致，否则持久化的 overlay 会被写到下一次会话永远不看的地方。
	private static storageKeyFor(app: App): string {
		const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
		return `position-restore:tabs:${appId}`;
	}

	// 启动时的读取。做成静态是因为它必须在 store 实例存在之前跑；做成私有是因为只有这个门面
	// 才该看到 overlay。
	private static loadLeafStates(app: App): Map<string, TabStateRecord> {
		try {
			const storageKey = PositionStore.storageKeyFor(app);
			const raw = window.localStorage.getItem(storageKey);
			if (!raw)
				return new Map();

			// 存储里放的是普通对象（Map 没法 JSON 往返）：显式重建 Map，把畸形的条目
			// （没有 filePath/st）丢掉，而不是相信这次解析。
			const parsed = JSON.parse(raw) as Record<string, TabStateRecord>;
			const records = new Map<string, TabStateRecord>();
			for (const [leafId, r] of Object.entries(parsed))
				if (r && typeof r.filePath === 'string' && r.st)
					records.set(leafId, r);
			return records;
		} catch (e) {
			// 存储读不了：退化成空 —— 整个会话里恢复都退回逐文件的数据库。
			console.error('Position Restore: can not read the position overlay:', e);
			return new Map();
		}
	}

	// 读 leaf 层。两者都不会过期：都从表里作答，而且没有调用方会留着自己拿到的结果。
	private leafRecord(leafId: string): TabStateRecord | undefined {
		return this.leafStates.get(leafId);
	}

	private leafEntries(): IterableIterator<[string, TabStateRecord]> {
		return this.leafStates.entries();
	}

	// 某个路径上有哪些 leaf，不必为此走一遍整层。拷一份出来，因为两个调用方都会丢下
	// 拿到的东西。
	private leafIdsOnPath(filePath: string): string[] {
		const ids = this.leavesByPath.get(filePath);
		return ids ? [...ids] : [];
	}

	// 写它。每一次变更都走 putLeaf() 与 dropLeaf()，没有第三条路 —— renameFile() 是靠替换
	// 一条记录来重新作键，而不是手动搬它的路径。
	//
	// 索引在写入之后是**重建**的，不是打补丁：它派生自那张表，而打补丁得知道这个 leaf 离开
	// 了哪个路径，那是第二件要维持正确的事。重建的代价是把打开的标签页走一遍 —— 写入发生在
	// 读者移动时，而需要索引便宜的，是**读**它，每次轮询一次。
	private putLeaf(leafId: string, record: TabStateRecord): void {
		this.leafStates.set(leafId, record);
		this.reindexLeaves();
	}

	private dropLeaf(leafId: string): void {
		this.leafStates.delete(leafId);
		this.reindexLeaves();
	}

	// 索引唯一的维护点：从那张表重建出来，所以它不会漂开。每次写入之后都跑，启动加载之后
	// 也跑 —— 那是唯一一次不走 putLeaf() 的批量变更。
	private reindexLeaves(): void {
		this.leavesByPath.clear();
		for (const [leafId, r] of this.leafStates) {
			const ids = this.leavesByPath.get(r.filePath);
			if (ids)
				ids.add(leafId);
			else
				this.leavesByPath.set(r.filePath, new Set([leafId]));
		}
	}

	// 两个调用方都会走一遍整层、把匹配的丢掉，各有各的理由：一个关掉的 leaf，一条被修剪
	// 拒绝的文件记录。走一遍而不是两遍，而且它像其它任何调用方一样经 dropLeaf() 丢弃，
	// 所以索引对这些也保持正确。
	// @returns 有没有任何记录被丢掉。
	private dropLeavesWhere(drop: (leafId: string, record: TabStateRecord) => boolean): boolean {
		let dropped = false;
		for (const [leafId, r] of this.leafEntries())
			if (drop(leafId, r)) {
				this.dropLeaf(leafId);
				dropped = true;
			}
		return dropped;
	}

	// (leafId, filePath) 要恢复的那条记录：这个 leaf 对**这个确切的**文件有一处位置时就用它
	// 自己的，否则用文件记录。路径把关，正是它拦住一个已经挪去了别的文件的 leaf 去重新定位它。
	read(leafId: string, filePath: string): EphemeralState | undefined {
		const r = this.leafRecord(leafId);
		return r && r.filePath === filePath ? r.st : this.database.db[filePath];
	}

	// 共享的文件层是不是已经正好存着这个位置？write() 第二次跳过、以及 overlayRecords() 对
	// 「分歧」的定义，用的都是这个判据。
	private fileLayerHolds(filePath: string, st: EphemeralState): boolean {
		const fileSt = this.database.db[filePath];
		return fileSt !== undefined && isEphemeralStatesEquals(fileSt, st);
	}

	// 在**两层**里都记下 (leafId, filePath) 的位置。文件层是共享、会同步的，所以它必须留住
	// 最后一次真正的分歧，而不是碰巧轮询到的那个标签页的最后一 tick —— 于是有两种情况只轻轻
	// 碰它一下：一条没变过的记录，以及第一次见到文件层已经持有的某个值。
	write(leafId: string, filePath: string, st: EphemeralState): void {
		const prev = this.leafRecord(leafId);
		// 这个 leaf 是不是已经拥有这个文件的一条记录 —— 与之相对的是第一次遇到这个文件
		// （还没有记录，或记录点的文件它早已离开）。
		const leafOwnsFile = prev !== undefined && prev.filePath === filePath;

		// 自上一 tick 以来什么都没动。
		if (leafOwnsFile && isEphemeralStatesEquals(prev.st, st))
			return;

		// leaf 层永远收下这个值：read() 优先用它，这正是让同一个文件的两个标签页保持分开的
		// 原因。文件层跟上，除非它已经持有这个值 —— 只有第一次见到时才可能这样。
		this.putLeaf(leafId, { filePath, st });
		if (leafOwnsFile || !this.fileLayerHolds(filePath, st))
			this.database.setState(filePath, st);
	}

	// 忘记一个 leaf 的记录（它的视图不再可记录：被排除的文件、非 markdown 视图……）。文件
	// 记录不动 —— 可能还有另一个 leaf 在显示那个文件。
	forgetLeaf(leafId: string): void {
		this.dropLeaf(leafId);
	}

	// 下面两个理由背后同一个动作：对一个路径，两层里都不留任何东西。
	// 两半都是必需的 —— 一条残留的 leaf 记录会被 read() 直接为这个路径交还回来，而之后
	// 在那里新建的文件会恢复成旧那份的位置。
	private dropPath(filePath: string): void {
		this.database.deleteFile(filePath);
		// 问索引而不是走一遍去找：轮询每 100ms 就问一次它所在的那个文件，而答案几乎总是
		// 没有 leaf。
		for (const leafId of this.leafIdsOnPath(filePath))
			this.dropLeaf(leafId);
	}

	// 文件**没了**：一次活过了宽限窗口的 vault 删除（见 position/path-bookkeeping.ts）。
	deleteFile(filePath: string): void {
		this.dropPath(filePath);
	}

	// 文件被**排除**了 —— 它还在，但记录规则说不为它保留位置。同样的丢弃，同样的触及范围：
	// 让一条记录错误的原因是逐文件的，所以不是被轮询的那个标签页也会丢掉它的记录。之所以
	// 另起一个名字，是因为采样器里的 `deleteFile` 读起来像是那里正在发生一次删除。
	dropExcluded(filePath: string): void {
		this.dropPath(filePath);
	}

	// 文件改名时给两层都重新作键。少了 leaf 那一半，read() 里的路径把关会拒掉每一个正在显示
	// 这个文件的 leaf，逐标签页的分开就会无声地塌到文件记录上。
	renameFile(newPath: string, oldPath: string): void {
		this.database.renameFile(newPath, oldPath);
		for (const leafId of this.leafIdsOnPath(oldPath)) {
			const r = this.leafRecord(leafId);
			if (r)
				this.putLeaf(leafId, { ...r, filePath: newPath });
		}
	}

	// 丢掉那些 leaf 已经不在了的 leaf 记录；一个关掉的 leaf 无法更新自己的记录（没有关闭
	// 事件），所以这是唯一的清理。liveIds 是调用方那一次工作区扫描 —— Restorer 为它其它几张
	// 逐 leaf 的表本来就要走一遍每个 leaf。
	// @returns 有没有任何记录被丢掉。
	pruneDeadLeaves(liveIds: Set<string>): boolean {
		return this.dropLeavesWhere(leafId => !liveIds.has(leafId));
	}

	// 跑文件层自己的修剪（被排除的文件夹、frontmatter 的退出项、条目上限），并把它镜像到
	// leaf 层：文件层刚刚拒绝的一个路径，也不能作为 leaf 记录存活下来。恢复不检查排除规则，
	// 所以一条残留的 leaf 记录会重新定位一个规则排除的文件 —— 就像一条残留的 db 记录那样。
	// 标签页一动，它就会被重新记录。
	// @returns 被移除的文件记录条数，好让设置面板的条目计数用它。
	pruneDatabase(): number {
		const hadRecord = new Set(Object.keys(this.database.db));
		const removed = this.database.pruneDb();
		if (removed === 0)
			return 0;

		const droppedLeaf = this.dropLeavesWhere(
			(_leafId, r) => hadRecord.has(r.filePath) && this.database.db[r.filePath] === undefined,
		);
		// 立刻写出：它从设置面板跑，那里不是持久化点，而修剪的重点就是这些记录没了。
		if (droppedLeaf)
			this.persist();
		return removed;
	}

	// 被持久化的 overlay：只留那些仍与自己的文件记录有分歧的 leaf 记录。一条完全没有文件记录
	// 的记录也会留下 —— 这时它是唯一的一份。
	private overlayRecords(): Record<string, TabStateRecord> {
		const records: Record<string, TabStateRecord> = {};
		for (const [leafId, r] of this.leafEntries()) {
			if (!r.filePath)
				continue;
			if (this.fileLayerHolds(r.filePath, r.st))
				continue;
			records[leafId] = r;
		}
		return records;
	}

	// overlay 的存储写入。同步，并与上一个 blob 去重。
	//
	// 它的节奏与数据库落盘一致（PositionManager.storePositionData：5s tick、退出、挂起），
	// 而不只是在退出时：overlay 是「同一个文件开在两个标签页」这条分歧能活过重启的唯一地方，
	// 所以只留给退出 / 挂起的快照，一旦崩溃、强退或被杀，而数据还只在内存里，就丢了。
	persist(): void {
		try {
			const serialized = JSON.stringify(this.overlayRecords());
			if (serialized === this.lastPersisted)
				return;
			const storageKey = PositionStore.storageKeyFor(this.app);
			window.localStorage.setItem(storageKey, serialized);
			this.lastPersisted = serialized;
		} catch (e) {
			// 超出配额 / 存储被禁用：记录留在内存里，所以当前会话仍能逐标签页恢复 —— 只是
			// 少了重启时的快照。
			console.error('Position Restore: can not persist the position overlay:', e);
		}
	}
}
