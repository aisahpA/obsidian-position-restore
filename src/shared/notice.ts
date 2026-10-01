import { Notice } from 'obsidian';

// 一直留着直到用户手动关掉（duration 0）。只留给这样一类失败：发生的时候用户可能根本没在看，
// 而后果比一条提示存在得更久 —— 比如读不出的数据文件。一般的确认仍走默认超时，
// 免得角落被占满。
export function stickyNotice(message: string): void {
	new Notice(message, 0);
}
