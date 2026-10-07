import { App, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { EphemeralState } from '@/types';
import { PositionStore } from '@/position/storage/position-store';
import { nextPaint } from '@/shared/wait';
import { PositionState } from '@/position/state';
import { RestoreModes } from './modes';

// 落定那些 open 从未触发 'file-open' 的后台分屏（重启恢复出来、视图**已经
// 建好**的标签页）。被注入的源码标签页身上揣着一个没被消费的注入标记；阅读与
// 源码标签页则是从各自的记录恢复出来的，根本没有标记。没有这一轮清扫，
// 就只有活动标签页的 'file-open' 会纠正它的落点 —— 后台标签页会一直停在漂了
// 的（源码）位置或顶部（阅读），直到第一次被激活。每一个没被消费的 leaf 都在
// 它自己的遮罩下恢复，**不碰**活动 leaf 的记录基准
// （见 RestoreModes.settleInjectedReveal）。
//
// 跳过谁：活动 leaf（它自己的 'file-open' / completeInjectedRestore 管它）、
// 正在恢复的、过期的标记（已处理的那一对挪去了另一个文件），以及已经处理过的
// leaf（caller 目标的 open 借 Obsidian 自己缓存的位置，与活动标签页行为
// 一致）。被推迟的 leaf（视图还没建）留住自己的状态，等激活时再落定。
export class BackgroundSettler {
	private app: App;
	private state: PositionState;
	private store: PositionStore;
	private modes: RestoreModes;
	// 可重入保护：一轮清扫通常会跑得比那次 200ms 轮询还久，而重叠的两轮会在
	// 那些「标记要到每轮末尾才被消费」的 leaf 上把 settle/restoreBackground
	// 跑两遍。
	private settleInProgress = false;

	constructor(app: App, store: PositionStore, state: PositionState) {
		this.app = app;
		this.store = store;
		this.state = state;
		this.modes = new RestoreModes(this.state);
	}

	// 视图一建好，就在它们各自的首绘遮罩下落定：一段有界的短轮询，等到没有
	// 已建视图的 leaf 还需要干活就停。被推迟的标签页（视图还没建）留住状态，
	// 等激活时由 completeInjectedRestore 落定。
	start(registerCleanup: (fn: () => void) => void) {
		const deadline = Date.now() + 10000;
		const interval = window.setInterval(() => {
			// 还有一轮在跑：跳过这个 tick —— 由正在跑的那轮自己决定 `done`，
			// 被跳过的 tick 下次重试就是。
			if (this.settleInProgress)
				return;
			void this.completeBackgroundRestores().then(done => {
				if (done || Date.now() > deadline)
					window.clearInterval(interval);
			});
		}, 200);
		registerCleanup(() => window.clearInterval(interval));
	}

	// 当没有已建视图的 leaf 还需要干活时为 true，好让调用方停止轮询；被推迟的
	// leaf 会一直返回 false，直到过了截止时间。重叠的调用不碰任何 leaf，直接
	// 返回 false。
	async completeBackgroundRestores(): Promise<boolean> {
		if (this.settleInProgress)
			return false;
		this.settleInProgress = true;
		try {
			return await this.completeBackgroundRestoresInner();
		} finally {
			this.settleInProgress = false;
		}
	}

	private async completeBackgroundRestoresInner(): Promise<boolean> {
		if (!this.app.workspace.layoutReady)
			return false;
		await nextPaint();
		const leaves: WorkspaceLeaf[] = [];
		// 故意用块语句体：Obsidian 的 iterate 辅助函数会把回调返回的真值当成
		// 提前中断的信号（见 pruneStaleLeafIds）。
		this.app.workspace.iterateAllLeaves((leaf) => {
			leaves.push(leaf);
		});
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		const activeLeafId = active?.leaf ? this.state.leafId(active.leaf) : undefined;
		let pending = false;
		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file)
				continue;
			const leafId = this.state.leafId(leaf);
			const filePath = view.file.path;
			if (leafId === activeLeafId)
				continue;
			if (this.state.inFlightRestoreLeafRuns.get(leafId)?.filePath === filePath)
				continue; // 此刻有一次真正的恢复占着这个 leaf
			const marker = this.state.injectedOpenLeafIds.has(leafId);
			if (marker && this.state.handledLeafIdMap.get(leafId) !== filePath) {
				// 过期的标记（这个 leaf 在注入之后挪去了另一个文件）：当前
				// 这次 open 不是注入来的。把标记消费掉，免得它误导后来的
				// 某次激活。
				this.state.injectedOpenLeafIds.delete(leafId);
				continue;
			}
			if (!view.editor) {
				pending = true; // 被推迟 / 视图未建：等激活时落定
				continue;
			}
			if (marker) {
				await this.settleBackground(view, leafId, filePath);
			} else if (this.state.handledLeafIdMap.get(leafId) !== filePath) {
				// 既未处理又未被注入：一个阅读或源码标签页，它保存的位置
				// 从未被应用过。
				const st = this.store.read(leafId, filePath);
				if (!st)
					continue;
				await this.restoreBackground(view, leafId, filePath, st);
			}
		}
		return !pending;
	}

	// 在它自己的遮罩下落定一个已建视图、被注入的源码后台 leaf 的落点，并消费掉
	// 它的标记。scroll 为 0（只有光标）的注入从未动过视口，所以它只揭开。
	private async settleBackground(view: MarkdownView, leafId: string, filePath: string) {
		const st = this.store.read(leafId, filePath);
		const isCurrent = () => view.file?.path === filePath;
		const hasScroll = !!st && (st.scroll ?? 0) > 0;
		if (hasScroll) {
			// 这次纠正必须在看不见的状态下跑：如果遮罩的安全定时器已经把 leaf
			// 遮罩揭掉了，就重新遮上，然后落定、揭开。
			if (!this.state.cover.isCovered(view.leaf))
				this.state.cover.cover(view.leaf);
			this.state.restoreStarted();
			try {
				await this.modes.settleInjectedReveal(view, st, isCurrent);
			} finally {
				this.state.restoreEnded();
			}
		} else if (isCurrent()) {
			this.state.cover.uncover(view.leaf);
		}
		if (isCurrent())
			this.state.injectedOpenLeafIds.delete(leafId);
	}

	// 从一个已建视图的后台阅读 / 源码标签页的记录里恢复它（没有注入标记 ——
	// 这次 open 从未被遮罩 / 注入过）。与 restoreMarkdown 的 masked 恢复完全
	// 一样，只是关掉了共享锚点（记录基准只属于活动 leaf）。
	// 把处理过的那一对记下来，好让后来的激活去重，而不是再恢复一遍。
	private async restoreBackground(view: MarkdownView, leafId: string, filePath: string, st: EphemeralState) {
		const isCurrent = () => view.file?.path === filePath;
		// anchorToSettledState 会读这个 per-leaf 的标记并跳过。
		this.state.noAnchorLeafIds.add(leafId);
		this.state.restoreStarted();
		try {
			await this.modes.maskedRestoreSt(view, st, isCurrent);
		} finally {
			this.state.noAnchorLeafIds.delete(leafId);
			this.state.restoreEnded();
		}
		if (isCurrent())
			this.state.handledLeafIdMap.set(leafId, filePath);
	}
}
