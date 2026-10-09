import { App, Notice, TFile } from 'obsidian';
import { EphemeralState, PluginSettings } from '@/types';
import { frontmatterDecisionFor } from '@/position/policy/frontmatter';
import { stickyNotice } from '@/shared/notice';
import type PositionRestorePlugin from '@/main';
import { t } from '@/i18n';
import {
	CursorDatabase,
	PositionRecord,
	SCHEMA_VERSION,
	cursorIsDefault,
	encodeValue,
	parseDb,
	parseDbStrict,
} from './disk-format';

// 让数据文件无论 vault 多大都远在 100 KB 以下；修剪到上限的 3/4 引入了滞回，
// 于是修剪不会每次写入都折腾。
const MAX_ENTRIES = 750;
const TRIM_TARGET = Math.floor(MAX_ENTRIES * 3 / 4);

// 下面的淘汰是墓碑优先，最新的多少条记录受「新鲜度」保护、不参与。取上限的一个分数，
// 好让两者一起变。
const TOMB_RECENT_WINDOW = Math.floor(MAX_ENTRIES / 4);

export class CursorPositionDatabase {
	db: CursorDatabase = {};
	dbDirty: boolean = false;

	// 单调的变更计数器。writeDb 在序列化之前给它拍快照，只有在写完之后它没变时才清
	// dbDirty —— 一次落在落盘途中的 setState 会让 db 保持 dirty，而不是丢掉它的记录。
	private rev = 0;

	// 多设备同步：某个外部同步客户端可能在我们跑着的时候替换 db 文件。lastDiskMtime
	// 缓存我们自己的读或写之后观察到的 mtime；下一次 stat() 拿到不同的值，说明文件在我们
	// 背后变了。两边都持有的键，于是按记录靠它自己的采集时间戳来定夺（见 mergeDiskDb）
	// —— 不是靠我们上次落盘的时机。
	private lastDiskMtime = 0;

	// 上次读到的文件 schema。与那两个「已通知」标记配对，它把「我们启动时这个文件就已经旧了」
	// 与「我们自己这个当前文件刚被一个更旧的 writer 替换了」区分开 —— 只有后者是新鲜消息，
	// 因为前者在启动时说一次就够了。
	private lastSeenSchema = 0;
	private legacyStartupNotified = false;
	private legacyOverwriteNotified = false;

	// 可重入的串行化：flush tick 的合并与 writeDb() 落盘前的那次合并可能重叠；两趟并发的
	// 「读-改」会交错，弄坏 mtime 账本。每个调用方都在在途那趟后面排队 —— 并发的调用方
	// 从不被丢掉，因为跳过 writeDb() 的对账会顶掉一个更新的外来文件。
	private mergeChain: Promise<void> = Promise.resolve();

	// 读不了的内容（写了一半、同步冲突标记、外来文件）绝不无声丢掉：它会被拷到一边并报告。
	// 按内容去重，免得重试循环每一趟合并就生成一份拷贝；内容不同就是不同的损坏。
	// corruptCopySeq 让同一毫秒、同一路径的两份拷贝不会重名。
	private preservedCorrupt: string | null = null;
	private corruptNotified = false;
	private corruptCopySeq = 0;

	// 追踪插入顺序里的最后一个键，好让 setState() 在编辑一个文件时能跳过「删了再插」
	// （那是把键挪到末尾、标记它为新鲜）。
	private lastKey: string | null = null;

	private app: App;
	private plugin: PositionRestorePlugin;
	private manifestDir: string;
	private settings: PluginSettings;

	constructor(
		plugin: PositionRestorePlugin,
		settings: PluginSettings
	) {
		this.app = plugin.app;
		this.plugin = plugin;
		this.manifestDir = plugin.manifest.dir!;
		this.settings = settings;
	}

	get defaultDbFileName(): string {
		return this.manifestDir + '/positions.json';
	}

	private getDbPath(): string {
		return this.settings.dbFileName || this.defaultDbFileName;
	}

	// 放在插件旁边，不是放在 db 旁边（db 通常坐在 vault 里一个同步文件夹中，那里一份残留的
	// 拷贝会被当成内容捡起来）。让名字唯一的是序号，不是时间戳。
	private corruptCopyPath(): string {
		const base = this.getDbPath().split('/').pop() ?? 'positions.json';
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		return `${this.manifestDir}/${base.replace(/\.json$/i, '')}.corrupt-${stamp}-${++this.corruptCopySeq}.json`;
	}

	// 父文件夹建不出来时，退回默认路径并通知用户。
	private async ensureDbFolder(): Promise<void> {
		const dbPath = this.getDbPath();
		const parentFolder = dbPath.substring(0, dbPath.lastIndexOf("/"));

		// 没有父文件夹 —— 就是根文件夹 —— 没什么要建的。
		if (!parentFolder)
			return;

		try {
			if (!(await this.app.vault.adapter.exists(parentFolder)))
				await this.app.vault.adapter.mkdir(parentFolder);
		} catch (e) {
			console.error("Can't create db folder:", e);
			this.settings.dbFileName = '';
			void this.plugin.saveSettings();
		}
	}

	// 把数据库文件切到 newPath；空的 newPath 重置回默认位置，settings.dbFileName 保持为 ''。
	// 一个裸文件名会把 db 放在 vault 根（adapter 的路径是相对 vault 的）。目标已经存在时，
	// 那通常是从另一台设备同步来的 db，所以不拒绝，而是：解析并采纳它，用与
	// mergeExternalChanges() 相同的冲突规则合并它的记录（磁盘赢，除非是我们在上次落盘之后
	// 本地碰过的键），然后删掉旧文件 —— 与一次移动得到同样的终态。只有读不了的目标才会
	// 挡住这次切换。调用方之后应当持久化设置。
	// @returns 成功时为 true（包括「本来就在用 newPath」）。
	async switchDbFile(newPath: string): Promise<boolean> {
		const targetPath = newPath === '' ? this.defaultDbFileName : newPath;
		if (!targetPath.endsWith('.json') || targetPath.startsWith('/') || targetPath.includes('\\')
			|| targetPath.split('/').includes('..')) {
			new Notice(t('dataStorage.dbFileName.messages.invalid'));
			return false;
		}

		const adapter = this.app.vault.adapter;
		const currentPath = this.getDbPath();
		if (targetPath === currentPath)
			return true;

		// @returns 被采纳的记录条数，目标读不了时为 null —— 那时调用方拒绝。
		const adoptExisting = async (): Promise<number | null> => {
			try {
				// 先做严格的形态检查：否则一个选错的 JSON 文件（package.json、
				// 一段代码片段）会被读成一个近乎空的 db，而下面真文件被删掉 —— 数据丢失。
				const diskDb = parseDbStrict(await adapter.read(targetPath));
				if (diskDb === null)
					return null;
				// 旧文件必须走，否则它那份过期的拷贝会窝在被采纳的那份旁边；放在改动
				// 内存状态之前，这样这里一旦失败，整个切换干净地中止。
				if (await adapter.exists(currentPath))
					await adapter.remove(currentPath);

				const adopted = this.mergeDiskDb(diskDb);
				// 合并后的记录会在下一次自然写入（随后的设置保存）时到达新文件。
				this.markDirty();
				return adopted;
			} catch (e) {
				console.error("Can't adopt existing database file:", e);
				return null;
			}
		};

		try {
			// 没有斜杠 → vault 根：adapter 直接写在那里，所以没有父文件夹要检查。
			const slash = targetPath.lastIndexOf('/');
			const parent = slash === -1 ? '' : targetPath.substring(0, slash);
			if (parent && !(await adapter.exists(parent)))
				await adapter.mkdir(parent);
			if (await adapter.exists(targetPath)) {
				const adopted = await adoptExisting();
				if (adopted === null) {
					new Notice(t('dataStorage.dbFileName.messages.exists'));
					return false;
				}
				new Notice(t('dataStorage.dbFileName.messages.merged', String(adopted)));
			} else if (await adapter.exists(currentPath)) {
				// 原子移动；目标存在时 rename 会失败，而这一点上面那个 adoptExisting
				// 分支已经排除了。
				await adapter.rename(currentPath, targetPath);
			}
		} catch (e) {
			console.error("Can't switch database file:", e);
			new Notice(t('dataStorage.dbFileName.messages.moveFailed', String(e)));
			return false;
		}

		// lastDiskMtime 缓存的是**旧**路径的 mtime；对着新路径重新缓存，好让下一次
		// 外部变更检查比的是同类的东西。
		this.lastDiskMtime = 0;
		await this.cacheDiskMtime();

		return true;
	}

	//----------------------------------------------------------------------------------------

	pruneDb(): number {
		const beforeLength = Object.keys(this.db).length;

		this.removeExcludedFolders();
		this.removeFrontmatterExcluded();

		this.trimToLimit();

		const removed = beforeLength - Object.keys(this.db).length;
		if (removed > 0) this.markDirty();
		return removed;
	}

	// 恢复不检查排除项，所以那里过期的记录会错误地重新定位。
	private removeExcludedFolders(): void {
		const excludedFolders = this.settings.excludedFolders;
		if (excludedFolders.length === 0)
			return;
		for (const key of Object.keys(this.db)) {
			if (excludedFolders.some((folder) =>
				key === folder || key.startsWith(folder + '/')
			)) {
				delete this.db[key];
			}
		}
	}

	// frontmatter 排除（`position-restore: false`，或配置的 B 属性存在）同理。metadata
	// 缓存还没解析的文件跳过 —— metadata 一落地，记录闸门会在下一次打开 / 轮询时丢掉
	// 它们的记录。
	private removeFrontmatterExcluded(): void {
		for (const key of Object.keys(this.db)) {
			const file = this.app.vault.getAbstractFileByPath(key);
			if (!(file instanceof TFile))
				continue;
			const decision = frontmatterDecisionFor(this.app, file, this.settings);
			if (decision?.skip)
				delete this.db[key];
		}
	}

	// 每一处把 db 弄脏的地方都走这里，好让 writeDb 能察觉一次落在落盘途中的变更
	// （见 rev）。
	private markDirty(): void {
		this.dbDirty = true;
		this.rev++;
	}

	// 这个键如果已经是最新碰过的那个（lastKey），就地覆盖 —— 不删了再插，那会无谓地
	// 折腾 V8 的对象形状。否则删了再插，把它挪到插入顺序的末尾，好让 trimToLimit
	// 当它是「新鲜」的留着。
	setState(filePath: string, st: EphemeralState): void {
		// 在这里盖章而不是在采集时：这是记录**成为我们的**那一刻，而且它是唯一会走到
		// db 文件的路径 —— 采集同时还喂给标签页层与导航历史，那两者都从不同步。已经带
		// 时间戳的记录保留它自己的：把一条记录挪到别的路径不是读者在移动。用展开而不是
		// `st.time = …`：调用方留着自己的对象。
		const stamped: EphemeralState =
			st.time === undefined ? { ...st, time: Date.now() } : st;
		const existed = this.db[filePath] !== undefined;
		if (existed && filePath === this.lastKey) {
			this.db[filePath] = stamped;
		} else {
			if (existed) delete this.db[filePath];
			this.db[filePath] = stamped;
			this.lastKey = filePath;
		}
		this.markDirty();
	}

	// 新鲜度就是插入顺序：setState() 总是把碰过的键挪到末尾，所以尾部装着最近改动过的
	// 文件 —— 不需要时间戳。墓碑比真实位置更廉价、更可丢，而少了这份偏好，一个老爱滚回
	// 顶部的习惯会慢慢用空记录填满上限、把真实的挤出去。
	private trimToLimit(): void {
		const keys = Object.keys(this.db);
		if (keys.length <= MAX_ENTRIES)
			return;

		// 「廉价」只在新鲜度窗口**之外**才适用：一篇刚被滚回顶部的笔记，是它身上发生的
		// 最新的事，而为了一个几个月前的真实位置把它淘汰掉，会让那篇笔记在下次打开时
		// 停在文件顶部 —— 记下来的位置没了。
		const windowStart = Math.max(0, keys.length - TOMB_RECENT_WINDOW);
		const cheap: string[] = [];
		const rest: string[] = [];
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			if (i < windowStart && this.isEmptyRecord(key, this.db[key]))
				cheap.push(key);
			else
				rest.push(key);
		}

		// 墓碑排在淘汰顺序的最前，所以从头部掉下去的是它们；其余的保持自己（最旧优先）
		// 的排队位置。
		const doomed = new Set([...cheap, ...rest].slice(0, keys.length - TRIM_TARGET));
		this.db = Object.fromEntries(
			keys.filter((key) => !doomed.has(key)).map((key) => [key, this.db[key]])
		);
	}

	async readDb(): Promise<void> {
		this.lastDiskMtime = 0;

		await this.cacheDiskMtime();
		if (this.lastDiskMtime === 0)
			return;

		let data: string;
		try {
			data = await this.app.vault.adapter.read(this.getDbPath());
		} catch (e) {
			// 读不了（权限、路上横着个文件夹）：没有内容要保留，也写不出任何拷贝。
			console.error("Can't read database:", e);
			this.db = {};
			return;
		}

		try {
			const { schema, db } = parseDb(data);
			this.db = db;
			this.noteSchema(schema, true);
		} catch (e) {
			// 文件存在但装的是别的东西：清掉内存里的 db 无法避免（那些记录够不着了），
			// 但这些字节会先被拷到一边 —— 下一次落盘写出一个合法文件，这也顺带修好了
			// 同步客户端合并出来的东西。
			console.error("Can't read database:", e);
			this.db = {};
			await this.preserveUnreadableDb(data, e);
		}
	}

	// 另一个插件版本写的文件仍可读 —— 未知字段被忽略 —— 但这个不匹配值得报告：我们下一次
	// 落盘会替换整个文件，而更旧的 writer 也对我们的做同样的事，所以丢掉记录的是这个不匹配
	// 本身，不是这次读。
	private noteSchema(schema: number, atStartup: boolean): void {
		const wasCurrent = this.lastSeenSchema >= SCHEMA_VERSION;
		this.lastSeenSchema = schema;
		if (schema >= SCHEMA_VERSION)
			return;

		if (atStartup) {
			if (this.legacyStartupNotified)
				return;
			this.legacyStartupNotified = true;
			stickyNotice(t('dataStorage.legacyDb.notice'));
			return;
		}
		// 会话中途，只有从一个当前文件**变成**旧文件才是新闻；一个一直都旧的文件在启动时
		// 已经报过了。
		if (!wasCurrent || this.legacyOverwriteNotified)
			return;
		this.legacyOverwriteNotified = true;
		stickyNotice(t('dataStorage.legacyDb.noticeOverwritten'));
	}

	// 设置页在条目计数旁边说的那句话：这些记录里有多少条根本不持有位置。与下面的淘汰用
	// 同一个判据，所以设置页和修剪在「哪些记录一文不值」上从不打架。
	countDefaultPosition(): number {
		let n = 0;
		for (const key of Object.keys(this.db))
			if (this.isEmptyRecord(key, this.db[key]))
				n++;
		return n;
	}

	// 没什么值得恢复：没有 scroll，光标也只坐在 Obsidian 打开时它会放的地方。那正是一次
	// 仅被打开的笔记留下的东西，也是最廉价、最可丢的记录。frontmatter 会把「打开默认值」
	// 挪离 (0,0)，所以光看光标不能作判据。
	private isEmptyRecord(path: string, st: EphemeralState): boolean {
		if ((st.scroll ?? 0) > 0)
			return false;
		if (!st.cursor)
			return true;
		return cursorIsDefault(st.cursor, this.defaultCursorLine(path));
	}

	// 打开 `path` 时 Obsidian 把光标留在的那一行：frontmatter 块紧接的那一行，没有就
	// 是 0。两次内存里的 Map 查找（path -> file -> metadata 缓存），从不读文件。
	// 为 undefined = 未知（文件没了，或 metadata 还没解析）—— 调用方保留光标，而不是
	// 按猜测行事。
	private defaultCursorLine(path: string): number | undefined {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile))
			return undefined;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache)
			return undefined;
		return cache.frontmatterPosition ? cache.frontmatterPosition.end.line + 1 : 0;
	}

	// 一次解析失败会让那些记录在本会话里够不着，而下一次落盘会用我们手头有的东西覆盖文件
	// —— 所以这份拷贝（加上同步客户端的历史版本）是让这次丢失还能挽回的东西。拷贝在通知
	// 之前写出，这样通知可以指向一个确实存在的文件。拷贝失败也会报告：那是记录真的没了的
	// 唯一一种情形。两条通知都是常驻的 —— 这可能发生在用户不在场的时候，而这个结果比任何
	// 一闪而过的提示活得久。
	private async preserveUnreadableDb(data: string, reason: unknown): Promise<void> {
		if (data === this.preservedCorrupt)
			return;
		this.preservedCorrupt = data;

		const path = this.corruptCopyPath();
		let kept = true;
		try {
			await this.app.vault.adapter.write(path, data);
		} catch (e) {
			kept = false;
			console.error("Can't keep a copy of the unreadable database:", e);
		}
		console.error(kept
			? `Position Restore: unreadable database file, kept a copy at ${path}`
			: 'Position Restore: unreadable database file, and no copy could be written', reason);

		if (this.corruptNotified)
			return;
		this.corruptNotified = true;
		stickyNotice(kept
			? t('dataStorage.corruptDb.notice', path)
			: t('dataStorage.corruptDb.noticeNoCopy'));
	}

	private async cacheDiskMtime(): Promise<void> {
		try {
			const st = await this.app.vault.adapter.stat(this.getDbPath());
			this.lastDiskMtime = st ? st.mtime : 0;
		} catch {
			this.lastDiskMtime = 0;
		}
	}

	// 把刚解析出的磁盘 db 与内存里的逐键对账：
	//   只在磁盘上的键 -> 采纳
	//   只在内存里的键 -> 保留（我们的，包括只存在于本会话的墓碑）
	//   两边共有的键   -> **更晚**的采集赢；相等（或两边都无时间戳，也就是 `t` 出现
	//                     之前写下的每一条记录）保留我们的，于是一次合并绝不会在没有
	//                     理由的情况下挪动读者自己那处位置。
	// @returns 在合并中存活下来的磁盘记录条数。
	private mergeDiskDb(diskDb: CursorDatabase): number {
		let adopted = Object.keys(diskDb).length;
		for (const key of Object.keys(this.db)) {
			const oursIsLater = (this.db[key].time ?? 0) >= (diskDb[key]?.time ?? 0);
			if (diskDb[key] === undefined || oursIsLater) {
				if (diskDb[key] !== undefined)
					adopted--;
				diskDb[key] = this.db[key];
			}
		}
		this.db = diskDb;
		this.lastKey = null;
		return adopted;
	}

	// 捡起一个在我们跑着的时候被外部替换掉的 db 文件：一次 stat() 的 mtime 与我们缓存的
	// 值不同，说明它在我们背后变了。从不把 db 标脏：采纳来的记录已经在磁盘上了，而保留下来的
	// 本地记录随下一次自然落盘一起出门。一个同步到一半被撕开的文件会 JSON.parse 失败、
	// 保留它旧的 mtime 缓存，之后重试。
	async mergeExternalChanges(): Promise<void> {
		const pass = this.mergeChain.then(() => this.runMergePass());
		this.mergeChain = pass.catch(() => {});
		await pass;
	}

	// 加了守卫，所以它从不抛（撕开的文件 / 读不了）；那个链式包装只做串行化，不添加重试
	// 语义。
	private async runMergePass(): Promise<void> {
		let mtime: number;
		try {
			const st = await this.app.vault.adapter.stat(this.getDbPath());
			if (!st)
				return; // 文件不在 —— 没什么可合并的，留住我们有的
			mtime = st.mtime;
		} catch {
			return; // 文件读不了 —— 留住我们有的
		}
		if (mtime === this.lastDiskMtime)
			return;

		let data: string;
		try {
			data = await this.app.vault.adapter.read(this.getDbPath());
		} catch (e) {
			console.error("Can't merge external db changes:", e);
			return;
		}

		try {
			const { schema, db } = parseDb(data);
			this.mergeDiskDb(db);
			this.lastDiskMtime = mtime;
			this.noteSchema(schema, false);
		} catch (e) {
			// 有人把文件换成了我们解析不了的内容（下载到一半、冲突标记、推了一半）。
			// 留住我们的记录，并留一份他们的拷贝：随后那次落盘会用我们的替换掉文件。
			console.error("Can't merge external db changes:", e);
			await this.preserveUnreadableDb(data, e);
		}
	}

	async writeDb() {
		if (!this.dbDirty) return;

		// 自我们上次看之后，另一台设备可能替换了文件；先合并，这样我们整份文件的写入
		// 才不会顶掉它的记录。
		await this.mergeExternalChanges();

		// 除非超过上限，否则是空操作。
		this.trimToLimit();

		// 在序列化之前给修订号拍快照：这一瞬或之前发生的每一次变更都**在** `data` 里，
		// 而下面那些 await 期间落下的任何东西，不能被这次落盘清掉 —— rev 抓住了这一点
		// （下面的 dbDirty）。这样一条记录也自己就赢下期间任何一次合并：它的采集时间戳
		// 比磁盘那份更晚。
		const rev = this.rev;

		// 墓碑是写出来的，不是跳过：「来过、停在顶部」是一个真实状态，它出现在记录数的
		// 统计里，并且是容量上限优先淘汰的对象（见 trimToLimit）。
		const encoded: { [path: string]: PositionRecord } = {};
		for (const key of Object.keys(this.db)) {
			const st = this.db[key];
			// 只有「在顶部」的记录才需要这个文件的「打开默认行」。
			const defaultLine = (st.scroll ?? 0) > 0 ? undefined : this.defaultCursorLine(key);
			encoded[key] = encodeValue(st, defaultLine);
		}
		const data = JSON.stringify({ schema: SCHEMA_VERSION, positions: encoded });
		const dbPath = this.getDbPath();

		try {
			// 快路径：文件夹（几乎总是）已经存在。
			await this.app.vault.adapter.write(dbPath, data);
		} catch {
			// 慢路径：文件夹多半不存在 —— 确保它存在（或退回默认路径）并重试一次。
			await this.ensureDbFolder();
			try {
				await this.app.vault.adapter.write(this.getDbPath(), data);
			} catch (e2) {
				// 什么都没落到磁盘：不动 dbDirty，好让之后的落盘重试同样的记录。
				console.error("Can't write database:", e2);
				return;
			}
		}

		// 我们自己的写入改动了文件 —— 重新缓存它的 mtime，好让下一次外部变更检查不把
		// 这次写入误当成别人的。dbDirty 只在落盘在途期间没有变更落下时才清掉：一次落在
		// 落盘途中的 setState 会让 db 保持 dirty，好让下一次落盘把它持久化。
		await this.cacheDiskMtime();
		this.lastSeenSchema = SCHEMA_VERSION;
		this.dbDirty = rev !== this.rev;
	}

	renameFile(newPath: string, oldPath: string) {
		if (!this.db[oldPath])
			return;
		this.db[newPath] = this.db[oldPath];
		delete this.db[oldPath];
		this.markDirty();
	}

	deleteFile(path: string) {
		if (!this.db[path])
			return;
		delete this.db[path];
		this.markDirty();
	}
}
