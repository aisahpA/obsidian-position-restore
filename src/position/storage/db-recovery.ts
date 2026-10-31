import type { DataAdapter } from 'obsidian';

import { stickyNotice } from '@/shared/notice';
import { t } from '@/i18n';
import { CursorDatabase, parseDb, salvageDb } from './disk-format';
import { previousPath, readFileIfParsable } from './atomic-file';

// 读不懂的数据文件怎么善后：先留一份原始字节，再按「打捞 → 上一版 → 无法恢复」三级决策。
// 只管决策与提示，不动内存里的库、也不决定「这一会话还写不写」—— 那是 CursorPositionDatabase
// 的事。拆出来的原因：这段是纯善后流程，和「库」的常态读写没有共用状态。

// 一次恢复的结论。前两种带回能用的库；`unreadable` 表示这一会话救不回来，调用方会把落盘
// 切成只读，这个文件一个字节都不再写。
export type RecoveryOutcome =
	| { kind: 'salvaged'; db: CursorDatabase; keptCopy: string | null }
	| { kind: 'previous'; db: CursorDatabase; keptCopy: string | null }
	| { kind: 'unreadable'; keptCopy: string | null };

export class DatabaseRecovery {
	// 上次留下的那份坏字节。按内容去重：重试循环反复读到同一份内容时不该生成第二份拷贝；
	// 内容不同就是不同的损坏。
	private preservedText: string | null = null;
	// 那份拷贝落在哪；提示里要报出这个路径（写不出来时是 null）。
	private copyPath: string | null = null;
	// 序号让同一毫秒、同一路径的两份拷贝不重名 —— 靠的是计数，不是时间戳。
	private copySeq = 0;
	// 一次会话里只报一次：合并重试可能反复走到这里。
	private notified = false;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly manifestDir: string
	) {}

	// 启动时读不懂数据文件：先留副本，再按三级顺序找出还能用的内容。
	async recover(dbPath: string, data: string, reason: unknown): Promise<RecoveryOutcome> {
		const keptCopy = await this.preserve(dbPath, data, reason);

		// 第一选择：从文件自身的可读前缀里打捞。同步工具截断、拼接文件时，前面的记录通常
		// 还完整；打捞出来的内容随下一次落盘写回文件，坏文件就此修好。
		const salvaged = salvageDb(data);
		if (salvaged) {
			this.notify(keptCopy, Object.keys(salvaged).length, 'recovered');
			return { kind: 'salvaged', db: salvaged, keptCopy };
		}

		// 第二选择：上一版。它只在本机（`.trash/position-restore` 不同步），所以别处没有
		// 这一份可退。
		const previous = await readFileIfParsable(this.adapter, previousPath(dbPath), parseDb);
		if (previous) {
			this.notify(keptCopy, Object.keys(previous.db).length, 'recovered');
			return { kind: 'previous', db: previous.db, keptCopy };
		}

		// 什么也救不回来：调用方会切只读。整份盖掉一份坏文件，只会让同步工具把损坏扩散到
		// 别的设备，所以这里宁可什么都不写。
		console.error('Position Restore: the database file is unreadable and nothing could be recovered; it is left untouched for this session');
		this.notify(keptCopy, 0, 'readOnly');
		return { kind: 'unreadable', keptCopy };
	}

	// 会话中途遇到读不懂的外部内容（下载到一半、冲突标记、推了一半）：只留副本。
	// 内存里那份不动 —— 调用方随后那次落盘会用我们的替换掉文件。
	// @returns 副本路径；没能写出时为 null。
	async preserve(dbPath: string, data: string, reason: unknown): Promise<string | null> {
		if (data === this.preservedText)
			return this.copyPath;
		this.preservedText = data;

		const path = this.corruptCopyPath(dbPath);
		let kept = true;
		try {
			await this.adapter.write(path, data);
		} catch (e) {
			kept = false;
			console.error("Can't keep a copy of the unreadable database:", e);
		}
		console.error(kept
			? `Position Restore: unreadable database file, kept a copy at ${path}`
			: 'Position Restore: unreadable database file, and no copy could be written', reason);
		this.copyPath = kept ? path : null;
		return this.copyPath;
	}

	// 副本放在插件目录，不是放在 db 旁边（db 通常坐在 vault 里一个同步文件夹中，那里一份
	// 残留的拷贝会被当成内容捡起来）。
	private corruptCopyPath(dbPath: string): string {
		const base = dbPath.split('/').pop() ?? 'position-restore-data.json';
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		return `${this.manifestDir}/${base.replace(/\.json$/i, '')}.corrupt-${stamp}-${++this.copySeq}.json`;
	}

	// 只报一次。常驻通知（不自动消失）—— 「少了一截位置」比一闪而过的提示活得久，而且
	// 这可能发生在用户不在场的时候（同步工具在后台改文件）。
	private notify(keptCopy: string | null, count: number, kind: 'recovered' | 'readOnly'): void {
		if (this.notified)
			return;
		this.notified = true;
		if (kind === 'recovered') {
			console.warn(`Position Restore: recovered ${count} record(s) from an unreadable database file`);
			stickyNotice(keptCopy
				? t('dataStorage.corruptDb.recovered', String(count), keptCopy)
				: t('dataStorage.corruptDb.recoveredNoCopy', String(count)));
			return;
		}
		stickyNotice(keptCopy
			? t('dataStorage.corruptDb.readOnly', keptCopy)
			: t('dataStorage.corruptDb.readOnlyNoCopy'));
	}
}
