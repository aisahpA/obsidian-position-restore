import { App, MarkdownPreviewRenderer } from 'obsidian';
import { PluginSettings } from '@/types';
import { CursorPositionDatabase } from '../storage/database';

// app 自己的文件列表在悬停询问里报告的 source id。所有来源都汇入同一个 workspace trigger，
// 靠它把改动限定在那一个列表上。
const FILE_EXPLORER_SOURCE = 'file-explorer';

// core 收到的「把预览移到某一行」长什么样。它会在那次调用里写死 `highlight: true`，
// 而悬停询问没有字段能说「移动但不标亮」，所以随移动一起发的那下闪只能在调用处丢掉。
type ScrollOpts = { highlight?: boolean; center?: boolean };
type ApplyScrollDelayed = (line: number, opts?: ScrollOpts) => void;

// 本模块读写的那几部分悬停询问 —— 事件本身、父级与目标元素都归 app。
interface HoverAsk {
	source?: string;
	linktext?: string;
	state?: { scroll?: number };
}

type Trigger = (name: string, ...data: unknown[]) => void;

// APP 自己的文件列表在哪里打开它的悬停预览。不动它的话，它只要笔记、不要位置，卡片就画在笔记
// 顶部 —— 那是 app 自己的答案，也是默认值（见 PluginSettings.fileExplorerPreviewFocus）。要行号
// 时，给它的是本插件为该**文件**最后记录的位置：不是最近文件列表里的某个落点，也不是今天这一行
// 现在的样子 —— 那需要一次异步读取来重新推导，而这次询问等不起。因此一个在别处改过的文件，
// 可能开在与读者离开时不同的一行上 —— 这就是同步作答的代价。
export class ExplorerPreviewFocus {
	// 本模块最近放进一次悬停询问的那一行，等着那次询问引发的移动。一次瞄准只抵一次闪，
	// 一个从未画出来的预览也不能把它留到以后用 —— 见 patchScrollFlash。
	private aimedLine: number | undefined;

	constructor(
		private app: App,
		private database: CursorPositionDatabase,
		private settings: PluginSettings,
	) {}

	install(registerCleanup: (fn: () => void) => void) {
		const workspace = this.app.workspace as unknown as { trigger: Trigger };
		const original = workspace.trigger;
		if (typeof original !== 'function')
			return;
		// 是补丁而不是监听器：core 的 page-preview 本身只是个 'hover-link' 监听器，它会在我们的
		// 任何监听器跑之前就把 linktext 和 state 从载荷里复制走，所以事后改载荷谁都收不到。trigger
		// 是那次复制之前的唯一一个点，它原样转发一切它不打算改的东西。
		workspace.trigger = (name: string, ...data: unknown[]) => {
			if (name === 'hover-link')
				this.aim(data[0]);
			return original.call(workspace, name, ...data);
		};
		registerCleanup(() => {
			workspace.trigger = original;
		});
		this.patchScrollFlash(registerCleanup);
	}

	// 闪一下是 core 对「你要找的东西在这儿」的回答。本模块交出去的那一行不是一次查找结果：
	// 那是读者本来就在的地方，卡片把它点亮，说不出任何他带不来的信息。所以由我们瞄准引发的那次
	// 移动不带闪，而其它每一次移动都保留它被要求的闪。
	private patchScrollFlash(registerCleanup: (fn: () => void) => void) {
		const proto = MarkdownPreviewRenderer.prototype as unknown as {
			applyScrollDelayed?: ApplyScrollDelayed;
		};
		const original = proto.applyScrollDelayed;
		if (typeof original !== 'function')
			return;
		// 箭头函数保住 `this` 的词法指向；下面的包装必须是普通函数，
		// 好让 core 的 `this`（渲染器）得以保留。
		const withoutOwnFlash = (line: number, opts?: ScrollOpts) =>
			this.withoutOwnFlash(line, opts);
		proto.applyScrollDelayed = function (line: number, opts?: ScrollOpts) {
			return original.call(this, line, withoutOwnFlash(line, opts));
		};
		registerCleanup(() => {
			proto.applyScrollDelayed = original;
		});
	}

	// 只有一次**本来会闪**的调用才配花掉这个令牌：Hover Editor 自己的 resize 处理器会调它、
	// 且不要闪，不能把那个真正要闪的调用背后的瞄准消耗掉。
	private withoutOwnFlash(line: number, opts?: ScrollOpts): ScrollOpts | undefined {
		if (!opts?.highlight || line !== this.aimedLine)
			return opts;
		this.aimedLine = undefined;
		return { ...opts, highlight: false };
	}

	// 只有一篇记录了不在顶部的 markdown 笔记才值得指向；其它一律按 app 本来的要求原样不动。
	private aim(payload: unknown): void {
		// 每一次悬停询问都先清掉令牌：来自别处的询问 —— 本插件自己的列表、app 的搜索 ——
		// 意味着下一次闪归那次询问发，不该被我们吞掉。
		this.aimedLine = undefined;
		if (this.settings.fileExplorerPreviewFocus !== 'line')
			return;
		if (!payload || typeof payload !== 'object')
			return;
		const ask = payload as HoverAsk;
		if (ask.source !== FILE_EXPLORER_SOURCE || !ask.linktext || ask.state)
			return;
		const file = this.app.vault.getFileByPath(ask.linktext);
		if (!file || file.extension !== 'md')
			return;
		const st = this.database.db[file.path];
		if ((st?.scroll ?? 0) > 0) {
			ask.state = { scroll: st.scroll };
			this.aimedLine = st.scroll;
		}
	}
}
