import { App, TAbstractFile } from 'obsidian';
import { PositionStore } from './storage/position-store';
import { PositionState } from './state';

// 按 path 作键的那些状态 —— 位置 store（它同时拥有逐文件记录与逐 leaf 记录，所以 path 一变就一起
// 改键或一起丢）、几个导航 store（各自改键或丢自己的记录）、流水线的当前文件指针 —— 集中在一处
// 跟随 vault 的 rename / delete 事件，好让它们对「path 变了意味着什么」不会各说各话。
//
// delete 事件到达时不能立即动手：用户删掉一个文件、与某个同步插件替换一个改动过的文件
// （手机上坚果云同步会先删目标、再把下载下来的文件改名覆盖上去），vault 发出的是同一个 'delete'；
// 照它动手会丢掉一批片刻之后又恢复有效的记录。所以删除是**预约**的，由 **vault** 决定窗口何时
// 关闭：又回来的 path 就根本不删。读 vault 而不是把 delete 跟 create/rename 事件配对，
// 也让结论与两个事件的到达顺序无关。
//
// 窗口只是**兜底**。一次替换若以自身事件的形式到达 vault —— 一次 create，或覆盖到目标上的
// rename —— 会直接取消待处理的 prune（见 cancelPending）：手机上的同步不承诺在任何窗口内把文件
// 放回来，下载是一次网络往返，app 还可能在其中一段被冻住。

// 一个被删的 path 要消失多久，它的记录才被丢弃。这段等待就是这套机制的代价：一次真删除的记录
// 恰好活这么久。之所以长，是因为要罩住的不再是相邻两次 adapter 调用，而是一次 vault 压根没
// 报告过的替换 —— 慢的，或者背着 vault 写的。
const DELETE_PRUNE_GRACE_MS = 10_000;

// 记账器对一个导航 store 的需求：栈与最近文件列表都按 path 作键、都答这四个方法 —— 但两者存的
// 记录不同，所以各自单独通知、各自改键或丢弃自己的。在这里声明而不是 import，是为了让记账器
// 不必知道有哪些 store 存在：由组装点把列表交给它（见 position/manager.ts）。
export interface PathStore {
	renameFile(oldPath: string, newPath: string): void;
	deleteFile(path: string): void;
	knownPaths(): string[];
	persist(): void;
}

export class PathBookkeeper {
	// 正在窗口期里等待的被删 path（path → 定时器）。
	private pendingDeletes = new Map<string, number>();
	// 启动清扫的那些 path，等的是同一个窗口。单独一张表是因为结果不同、不是时机不同：vault 的
	// 删除连位置记录一起丢，而清扫掉的 path 保留它们 —— db 是**同步**文件，一台设备上 vault 还没
	// 物化出某个文件，不能就此抹掉别的设备还需要的位置（这也是 db 修剪从不查 vault 的原因，
	// 见 pruneDatabase）。
	private pendingSweeps = new Map<string, number>();

	constructor(
		private app: App,
		private store: PositionStore,
		// 各导航 store，单独通知，各自对自己的记录负责。
		private navStores: PathStore[],
		private state: PositionState,
	) {}

	// 每个 store 自己改键；指针只跟它点过名的那个文件走。位置 store 是一次调用，因为一条仍然
	// 写着旧 path 的逐 leaf 记录会过不了自己的 path 守卫，把分标签的位置静默塌缩到文件记录上。
	renameFile(file: TAbstractFile, oldPath: string) {
		// path 又回来了 —— rename 是一次「同步先删后改名」替换的后半程，它撤销掉的那次
		// delete 不能活过它。
		this.cancelPending(file.path);
		this.store.renameFile(file.path, oldPath);
		for (const nav of this.navStores)
			nav.renameFile(oldPath, file.path);
		if (this.state.lastLoadedFilePath == oldPath)
			this.state.lastLoadedFilePath = file.path;
	}

	// 同一个 path 第二次 delete 会重启窗口，窗口因此永不重叠。
	deleteFile(file: TAbstractFile) {
		this.deferMissing(this.pendingDeletes, file.path, () => this.prune(file.path));
	}

	// vault 的 'create' —— 同步替换可能以它作为另一半到达，也是「先删后写」落下的那半。
	// 答案同上一个 rename：文件在，那次 delete 就从来不是 delete。
	fileCreated(file: TAbstractFile) {
		this.cancelPending(file.path);
	}

	// 丢掉一条 path 已回来的预约修剪。两张表都查：同步后来送来的一个被清扫 path，与它替换掉的
	// 那个被删 path 一样是活的，两个都不欠修剪。
	private cancelPending(path: string) {
		for (const map of [this.pendingDeletes, this.pendingSweeps]) {
			const pending = map.get(path);
			if (pending === undefined)
				continue;
			window.clearTimeout(pending);
			map.delete(path);
		}
	}

	// 对导航 store 的启动清扫：Obsidian 关闭期间被删的文件不会触发 'delete' 事件，它的条目就会
	// 永远在栈和列表里当死行 —— 更糟的是还占着各自上限里的槽位。只清扫导航 store 是有意的：
	// 见 pendingSweeps。与一次真删除走同一个窗口推迟，理由也一样 —— 这也意味着清扫的 vault
	// 检查远在 onload 之后、索引已建好时才跑。
	sweepMissingHistory() {
		// 对几个 store 所点名的 path 取并集跑一遍，好让两个都认识的 path 只被预约（与复查）一次。
		const paths = new Set<string>();
		for (const nav of this.navStores)
			for (const path of nav.knownPaths())
				paths.add(path);
		for (const path of paths)
			if (!this.app.vault.getAbstractFileByPath(path))
				this.deferMissing(this.pendingSweeps, path, () => {
					for (const nav of this.navStores)
						nav.deleteFile(path);
					// 修剪才是重点：别留给下一次 flush（每个 store 都是本机私有的，
					// 写出去不会与另一台设备抢）。
					for (const nav of this.navStores)
						nav.persist();
				});
	}

	// 为 `path`（重新）启动宽限窗口，然后只在 path 仍然不在时才执行 `act`。vault 是裁决者
	// （见类的注释）：同步插件的临时删除发来的也是同一个 'delete'，片刻后回来的 path 根本不算被删。
	private deferMissing(map: Map<string, number>, path: string, act: () => void) {
		const pending = map.get(path);
		if (pending !== undefined)
			window.clearTimeout(pending);
		const id = window.setTimeout(() => {
			void this.confirmGone(map, path, id, act);
		}, DELETE_PRUNE_GRACE_MS);
		map.set(path, id);
	}

	// vault 的索引在「path 是否存在」上不是最终答案。同步插件直接穿过 adapter 写文件 ——
	// 坚果云同步与 Remotely Save 在手机上都这么干 —— 会把文件放回**磁盘**而索引毫不知情；
	// 照一个还说「没了」的索引动手就会抹掉保存的位置。所以磁盘也要问一次，
	// 两者任一说有，记录就留着不动。
	private async confirmGone(map: Map<string, number>, path: string, id: number, act: () => void) {
		if (this.app.vault.getAbstractFileByPath(path)) {
			map.delete(path);
			return;
		}
		let onDisk: boolean;
		try {
			onDisk = await this.app.vault.adapter.exists(path);
		} catch {
			// 答不上来的 adapter 不等于 path 没了：留一条读者其实不再想要的记录不要钱，
			// 丢一条却正是他察觉到的。
			onDisk = true;
		}
		// 这个 await 开出第二个窗口：path 可能回来，也可能有更新的延后顶掉这一条。
		// 只有本定时器所属的那次延后才有资格动手。
		if (onDisk || map.get(path) !== id)
			return;
		map.delete(path);
		act();
	}

	// path 真的没了：从每个 store 里丢掉它。
	private prune(path: string) {
		this.store.deleteFile(path);
		for (const nav of this.navStores)
			nav.deleteFile(path);
	}
}
