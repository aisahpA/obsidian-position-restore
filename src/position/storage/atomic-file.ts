import type { DataAdapter } from 'obsidian';

// 整份替换一个数据文件的工具，只负责「怎么写才不留下半截文件」，不知道写的是什么。
// 上层（位置库）管内容与时机，这里管暂存、就位与启动补完。
//
// 写盘三步：写暂存 → 删正式文件 → rename 就位。任何时刻都至少有一份完整文件：
//   1. 写暂存之前/之中被杀：正式文件还是上一份完整的；
//   2. 删了正式文件、还没 rename 时被杀：暂存里就是完整的新内容，启动时补位；
//   3. rename 之后：正式文件就是新的完整版。
// 刻意不留「上一版」：它多一套轮转、清理与恢复逻辑，而坏文件现在一律归零重来
// （见 database.ts 的 readDb），那份退路没有读者。

// 暂存目录。`.trash` 是同步工具的公共排除目录：Obsidian Sync 不带走隐藏文件夹，坚果云
// 默认 filterRules 含 `**/.trash`，vault 的 .gitignore 也忽略它。里面再套一层
// position-restore，免得和 Obsidian 自己回收站里的笔记混在一起。
export const STAGING_DIR = '.trash/position-restore';

// 暂存文件（写到一半的新内容）的名字。名字固定，两个写者交错会让其中一个 rename 落空，
// 所以调用方要自己串行化（database 的 writeChain）。
export function stagedPath(targetPath: string): string {
	return `${STAGING_DIR}/${fileBase(targetPath)}.next`;
}

// 暂存目录不存在就建一个；建不出来直接抛，让这次落盘失败（调用方退回整份直写）。
async function ensureStagingDir(adapter: DataAdapter): Promise<void> {
	if (await adapter.exists(STAGING_DIR))
		return;
	await adapter.mkdir(STAGING_DIR);
}

// 把整份 data 换成 targetPath 的内容。暂存那套用不了（目录建不出来、跨目录 rename 不成立）
// 时退回整份直写：截断风险回来，但总比一条都存不下去好。
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
		if (await adapter.exists(targetPath))
			await adapter.remove(targetPath);
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

// 正式文件不在时，把上一次没走完的落盘补上：暂存文件是完整的新内容（那次落盘只差最后
// 一次 rename）。parse 用来判断文件是不是我们要的东西（读不懂就按没有处理）；责任在
// 调用方，因为这个工具不知道文件格式。
// @returns 扶正后的内容；暂存不存在或读不懂时返回 null，调用方按「没有数据」处理。
export async function finishInterruptedWrite<T>(
	adapter: DataAdapter,
	targetPath: string,
	parse: (text: string) => T
): Promise<T | null> {
	const staged = stagedPath(targetPath);
	const text = await readIfExists(adapter, staged);
	if (text === null)
		return null;
	let value: T;
	try {
		value = parse(text);
	} catch {
		return null;
	}
	try {
		await adapter.rename(staged, targetPath);
		return value;
	} catch (e) {
		console.error(`Can't move ${staged} into place:`, e);
		return null;
	}
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

// 读一个次要文件（暂存）并按 parse 解析；不存在、读不了、读不懂一律 null。
// 正式文件读不懂时，用它判断「旁边还有没有一份完整的新内容」。
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
