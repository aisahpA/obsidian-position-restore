import type { DataAdapter } from 'obsidian';

// 整份替换一个数据文件的工具，只负责「怎么写才不留下半截文件」，不知道写的是什么。
// 上层（位置库）管内容与时机，这里管暂存、轮转与就位三步。

// 暂存目录。`.trash` 是同步工具的公共排除目录：Obsidian Sync 不带走隐藏文件夹，坚果云
// 默认 filterRules 含 `**/.trash`，vault 的 .gitignore 也忽略它。里面再套一层
// position-restore，免得和 Obsidian 自己回收站里的笔记混在一起。
export const STAGING_DIR = '.trash/position-restore';

// 暂存文件（写到一半的新内容）与上一版（上一次落盘成功的那份）的来源标记。
export type RecoverySource = 'staged' | 'previous';

// 暂存文件：这个名字是固定的，所以两个写者交错会让其中一个 rename 落空，调用方要自己串行化。
export function stagedPath(targetPath: string): string {
	return `${STAGING_DIR}/${fileBase(targetPath)}.next`;
}

// 上一版：每次落盘成功前把旧文件挪到这里，白得一份本机备份，而且不在同步范围内。
export function previousPath(targetPath: string): string {
	return `${STAGING_DIR}/${fileBase(targetPath)}.prev`;
}

// 暂存目录不存在就建一个；建不出来直接抛，让这次落盘失败（调用方退回整份直写）。
async function ensureStagingDir(adapter: DataAdapter): Promise<void> {
	if (await adapter.exists(STAGING_DIR))
		return;
	await adapter.mkdir(STAGING_DIR);
}

// 把整份 data 换成 targetPath 的内容，且任何时刻都能读到一个完整版本（老版本或新版本）：
//   1. 写暂存文件 —— 写到一半被打断，正式文件仍然完整；
//   2. 上一版挪成 `.prev` —— 本机留下一份完整退路，不占同步流量；
//   3. 暂存文件 rename 就位 —— rename 是原子的，正式文件不会出现半截内容。
// 第 3 步之前正式文件会短暂不存在，启动时 finishInterruptedWrite() 会把这次落盘补完。
// 暂存那套用不了（目录建不出来、跨目录 rename 不成立）时退回整份直写：截断风险还在，
// 但总比一条都存不下去好。
// 调用方负责先建好 targetPath 的父文件夹 —— 这里只管暂存目录。
// @returns 是否落到正式文件上。
export async function writeFileAtomically(
	adapter: DataAdapter,
	targetPath: string,
	data: string
): Promise<boolean> {
	try {
		await ensureStagingDir(adapter);
		const staged = stagedPath(targetPath);
		await adapter.write(staged, data);

		if (await adapter.exists(targetPath)) {
			const previous = previousPath(targetPath);
			if (await adapter.exists(previous))
				await adapter.remove(previous);
			await adapter.rename(targetPath, previous);
		}
		await adapter.rename(staged, targetPath);
		return true;
	} catch (e) {
		console.error('Position Restore: atomic write unavailable, falling back to a direct write:', e);
		try {
			await adapter.write(targetPath, data);
			return true;
		} catch (e2) {
			console.error(`Can't write ${targetPath}:`, e2);
			return false;
		}
	}
}

// 正式文件不在时，把上一次没走完的落盘补上：暂存是完整的新内容（那次落盘只差最后一次
// rename），上一版是完整的老内容。顺序有意义：新的优先，内容更全。
// parse 用来判断文件是不是我们要的东西（读不懂就试下一份）；责任在调用方，因为这个工具
// 不知道文件格式。
// @returns 扶正后的内容与它的来源；两份都读不出来返回 null，调用方按「没有数据」处理。
export async function finishInterruptedWrite<T>(
	adapter: DataAdapter,
	targetPath: string,
	parse: (text: string) => T
): Promise<{ source: RecoverySource; value: T } | null> {
	const candidates: [RecoverySource, string][] = [
		['staged', stagedPath(targetPath)],
		['previous', previousPath(targetPath)],
	];
	for (const [source, path] of candidates) {
		const text = await readIfExists(adapter, path);
		if (text === null)
			continue;
		let value: T;
		try {
			value = parse(text);
		} catch {
			continue; // 这份也读不懂，换下一份
		}
		try {
			await adapter.rename(path, targetPath);
			return { source, value };
		} catch (e) {
			console.error(`Can't move ${path} into place:`, e);
		}
	}
	return null;
}

// 正式文件读成功之后，上次落盘留下的暂存文件就是残渣。清不掉也不影响读取，只是多占
// 几 KB（那还是在不同步的 `.trash` 里）。
export async function discardStagedFile(adapter: DataAdapter, targetPath: string): Promise<void> {
	try {
		const staged = stagedPath(targetPath);
		if (await adapter.exists(staged))
			await adapter.remove(staged);
	} catch {
		// 清不掉算了，下一次落盘会把它整份覆盖。
	}
}

// 读一个次要文件（暂存 / 上一版）并按 parse 解析；不存在、读不了、读不懂一律 null。
// 从坏文件退到上一版时，调用方拿它当第二选择。
export async function readFileIfParsable<T>(
	adapter: DataAdapter,
	path: string,
	parse: (text: string) => T
): Promise<T | null> {
	const text = await readIfExists(adapter, path);
	if (text === null)
		return null;
	try {
		return parse(text);
	} catch (e) {
		console.error(`Position Restore: can't parse ${path}:`, e);
		return null;
	}
}

function fileBase(targetPath: string): string {
	return targetPath.split('/').pop() ?? targetPath;
}

async function readIfExists(adapter: DataAdapter, path: string): Promise<string | null> {
	try {
		if (!(await adapter.exists(path)))
			return null;
		return await adapter.read(path);
	} catch (e) {
		console.error(`Position Restore: can't read ${path}:`, e);
		return null;
	}
}
