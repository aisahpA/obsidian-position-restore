import { MarkdownView } from 'obsidian';
import { EphemeralState, NavEntryState } from '@/types';

// 热读：100ms 轮询（Sampler）、滚动采集，以及恢复的校验 / 重落循环每 tick、每帧都会跑它。
// 只管位置 —— 不读文档字符串、不动布局。导航显示字段住在 readNavEntryState / withNavDisplay 里，
// 只有真要保存一条导航记录时才跑。
export function readEphemeralState(view: MarkdownView): EphemeralState | undefined {
	const scroll = liveScroll(view);
	if (scroll === undefined)
		return undefined;
	const state: EphemeralState = { scroll };
	const cursor = hotCursor(view);
	if (cursor)
		state.cursor = cursor;
	return state;
}

function liveScroll(view: MarkdownView): number | undefined {
	const scroll = view.currentMode?.getScroll();
	// 预览渲染器还没跟上时 getScroll() 报的是 null（不是 undefined）—— isNaN(null) 为 false，
	// 所以它会绕过旧守卫，而 Math.round(null) 会被读成「文件顶部」。
	if (scroll == null || !Number.isFinite(scroll))
		return undefined;

	// getScroll() 返回 0-based 的顶行行号，外加这一行已被滚过的比例（42.37 = 视口顶端落在第 43 行
	// 的 37% 处），这里量化到整行：
	//
	// 1. 阅读连续性：存下小数，落点就指进读者已经读了一半的那一行中间，重建这种状态逼着眼睛重扫
	//    一个断行。对高块（图片、嵌入）来说，带小数的恢复会得到半张图。
	// 2. 往返稳定：applyScroll(n) 正好落在行顶，落点的残余误差（约 0.04 行）因此留在 Math.round
	//    的 ±0.5 死区之内 —— 存 42、读回 42，永远不会写库。量化得更细会把死区缩到那个误差之下，
	//    漂移的回读就会每次打开都把存的 scroll 棘轮式地推一格。
	// 3. 必须是 Math.round 而不是 Math.floor：floor 的死区不对称（[n-1, n)），任何略低于存值的
	//    落点都会重新引入单向向下的漂移。只有对称的死区才能两个方向都吸收噪音。
	return Math.round(scroll);
}

// 光标那一半，每次读取共用。收在 (0,0) 的光标本来也是编辑器打开时的位置 —— 略去不记，
// 好让这类记录保持最小（[0] 墓碑 / 只有 scroll 的记录）。
function hotCursor(view: MarkdownView): EphemeralState['cursor'] | undefined {
	const editor = view.editor;
	if (!editor)
		return undefined;
	const from = editor.getCursor("anchor");
	const to = editor.getCursor("head");
	if (!from || !to || (from.line === 0 && from.ch === 0 && to.line === 0 && to.ch === 0))
		return undefined;
	return { from: { ch: from.ch, line: from.line }, to: { ch: to.ch, line: to.line } };
}

// 分割线（"---"、"***"、"___"）指认一个地方的本事不比空行强：重映射扫描从记录行向外找那段记录
// 文本，而一条分割线与下一条毫无区别，所以一个锚在分割线上的记录可能在读者从未到过的另一条
// 分割线上找回自己。没有锚胜过那样。
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/;

// 一个位置周围的导航显示字段：视口顶锚点（有功能 —— remapAnchoredState 在后续编辑后靠它找回那一行）
// 与文件的 mtime。**不**强制布局，也**不**读文档里的别的行：这两件事是搜索面上一度存在、
// 如今已撤掉的那块正文快照的全部代价，而它只买到一个「按内容找笔记」的能力 —— 那件事
// vault 自己的全文搜索做得更好（见 navSearchText 处的说明）。
function navDisplayFields(
	view: MarkdownView,
	topLine: number,
): Pick<NavEntryState, 'anchor' | 'mtime'> {
	const display: Pick<NavEntryState, 'anchor' | 'mtime'> = {};
	const editor = view.editor;
	if (!editor || typeof editor.getLine !== 'function')
		return display;
	// 锚点：采集时主行的 trim 文本。文件之后被编辑时记录的位置就会过期（上方的插入与删除会移动
	// 下面每一行）—— remapAnchoredState 在应用位置之前用这段文本找回那一行。空行不带锚
	// （空匹配会命中每一个空行）；分割线也不带。
	if (topLine >= 0 && topLine <= (editor.lastLine?.() ?? -1)) {
		const text = editor.getLine(topLine).trim().slice(0, 80);
		if (text && !THEMATIC_BREAK.test(text))
			display.anchor = text;
	}
	// 采集时文件的 mtime —— 记录自己的时间戳，是这一步发生那一刻文件的样子。它**不**驱动恢复
	// （恢复是对着一个活的编辑器缓冲区做的，后者未保存的文本可能与磁盘上的文件不同，mtime 管不着）。
	const mtime = view.file && typeof view.file.stat?.mtime === 'number' ? view.file.stat.mtime : undefined;
	if (mtime !== undefined)
		display.mtime = mtime;
	return display;
}

// 光标落在 `line` 的行首 —— app 自己的大纲把读者带到某个标题时留下的就是这个样子，
// 也是一个行号对一个地方所能承诺的全部。
export function caretAtLine(st: EphemeralState, line: number): EphemeralState {
	return { ...st, cursor: { from: { line, ch: 0 }, to: { line, ch: 0 } } };
}

// Obsidian 自带的逐标签滚动缓存 —— 运行时的，公开类型里没有。视图上的一个普通字段，没人填就是
// null：syncScroll 每次滚动都写它，setEphemeralState 每次应用也写，clear/setViewData 在重载或
// 切模式时写。
interface ScrollCaching { scroll?: number | null }

// 量化方式与实时读一致：缓存里存的是没取整的值。
function cachedScroll(view: MarkdownView): number | undefined {
	const cached = (view as unknown as ScrollCaching).scroll;
	return cached != null && Number.isFinite(cached) ? Math.round(cached) : undefined;
}

// 滚动采集背后的**最后位置**读取：用缓存而不是实时测量。填它的那次滚动（app 的 syncScroll）在
// 监听器触发时已经跑完，所以桌面端它是当前的 —— 而当窗格不在布局里时，它是唯一剩下的来源。
// 对还没有缓存的标签（从没滚过、刚切过模式、刚被清过）就实时读一遍：一个数字总比没有强。
export function readSampledState(view: MarkdownView): EphemeralState | undefined {
	const scroll = cachedScroll(view) ?? liveScroll(view);
	if (scroll === undefined)
		return undefined;
	const state: EphemeralState = { scroll };
	const cursor = hotCursor(view);
	if (cursor)
		state.cursor = cursor;
	return state;
}

// 隐藏标签的滚动容器不在布局里（堆叠的标签组只让活动标签可见），它的 scrollTop 因此读成 0，
// 无论读者滚了多远，实时读都会答「文件顶部」—— 离开时那次刷新就会把顶部存成他的位置。缓存能
// 扛住这一点。别处都是实时值赢：一次施行的恢复会把**请求值**写进缓存（pixels.ts），所以在一个
// 可见视图上信缓存等于把请求回声回来。
function trustedScroll(view: MarkdownView, live: number | undefined): number | undefined {
	const dom = (view.editor as unknown as { cm?: { scrollDOM?: HTMLElement } })?.cm?.scrollDOM;
	if (!dom || dom.offsetParent !== null)
		return live;
	return cachedScroll(view) ?? live;
}

// 导航读 —— 只低频用（切换文件时离开前的刷新、大纲点击前的读、前进后退之前离开前的刷新、
// 落点的落定采集、遥测跳变的落点）：热读加上一条导航记录要带的显示字段。绝不能当
// readEphemeralState 在热路径上的平替：它会读文档。
export function readNavEntryState(view: MarkdownView): NavEntryState | undefined {
	const st = readEphemeralState(view);
	if (!st)
		return undefined;
	// 位置和锚点用同一个 scroll：它们是一个地方。
	const scroll = trustedScroll(view, st.scroll);
	return { ...st, scroll, ...navDisplayFields(view, scroll ?? -1) };
}

// **落点的落定采集**（遥测跳变的落点、栈的 settle 都走这里）与上面那一次是**同一个**读取：
// 正文快照撤掉之后，落点身上再没有任何东西是「只有它才读」的 —— 位置、锚点、mtime 三样，
// 落点与步都一样。所以 `readLandingState` 是 `readNavEntryState` 的别名而不是第二个读法，
// 留着这个别名是为了**调用点自己说明它在记一条落点**，而那正是 review 时要看的区别。
//
// 它带的光标**不是**恢复到这里时会落下的那个光标：跳转落在它点名的标题上、光标在行首
// （见 caretAtLine），而一次 visit 保留它记下的。
export const readLandingState = readNavEntryState;

// 围绕一个**已经读出的**位置重建导航显示字段 —— 遥测跳变时交给 refreshTop 的那个轮询基线。
// 跳转前的状态没法重读（光标已经跳了；移动端 scroll 可能也已落地），所以显示字段是拿当前视图
// 对着记录的位置重建出来的：最多陈旧一个轮询 tick。浅拷贝 —— 绝不就地改那个共享基线
// （或任何共享它的条目）。
export function withNavDisplay(view: MarkdownView, st: EphemeralState): NavEntryState {
	return { ...st, ...navDisplayFields(view, st.scroll ?? -1) };
}

// 就近匹配的启发式：锚点行被改过、或整块被重写时找不到匹配，就留着那个陈旧的行号（原生历史的
// 行为）；重复得极多的行就解析到最近的那一份。升级路径：在锚点之上再叠 CM 的实时变更增量。
const REMAP_WINDOW = 30;

// 为锚点匹配归一文本：折叠大小写、去掉空白与标点，好让一条被轻改过的锚点行仍能匹配上它记录的
// 文本。CJK 不需要折叠大小写，但去掉空白有好处（「我的 标题」对「我的标题」）。比较仍是归一形式
// 上的精确匹配 —— 绝不用子串 —— 所以重复极多的行仍解析到最近的，一处无关的改动也不会假匹配。
export function normAnchor(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

// 任何能按行号读出行的东西：一个编辑器的缓冲区，或者从磁盘读出的文件的行。下面那个扫描需要的
// 全部形状，一分不多 —— 正是这一点让同一个扫描既能服务打开的笔记（它的缓冲区，比磁盘上的文件
// 领先读者已敲未存的那么多），也能服务没打开的。
export interface LineSource {
	getLine(line: number): string;
	lastLine(): number;
}

// 一个文件的行按那个形状包一下：笔记没打开时交给扫描的就是它。切一次，谁要谁留着。
export function linesSource(lines: string[]): LineSource {
	return {
		getLine: (line: number) => lines[line] ?? '',
		lastLine: () => lines.length - 1,
	};
}

// 锚点那一行**现在在哪**：唯一的那个扫描，对任何行来源都适用。一条记录点名一个行**号**，以及曾
// 站在那一行上的文本；文件从那以后动过 —— 上方的插入与删除会移动下面每一行 —— 所以那个行号是个
// 过期的地址，文本是唯一还记得那个地方的东西。从记录行起就近向外找，因为一次编辑只是把行挪几行、
// 不是搬迁；精确命中的优先级高于更近的归一命中，因为记录行的未编辑副本比一个改过的相似货更可信。
//
// UNDEFINED 意味着**不知道**、不是**没变**，这正是这个扫描回答一个行号而不是一个位移的全部原因：
// 一篇被改到认不出来的笔记没有答案可给，而一个把 undefined 读成「它还在原地」的调用方，会继续
// 引用一个它一无所知的数字。两遍，先纯文本：常见的未编辑情形只花字符串比较，只有落空才为归一付钱。
export function remapAnchorLine(
	anchor: string | undefined,
	recorded: number | undefined,
	src: LineSource,
): number | undefined {
	if (!anchor || recorded === undefined || recorded < 0)
		return undefined;
	const last = src.lastLine();
	const key = normAnchor(anchor);
	for (const hit of [
		(text: string) => text.trim() === anchor,
		(text: string) => normAnchor(text) === key,
	]) {
		if (recorded <= last && hit(src.getLine(recorded)))
			return recorded;
		for (let d = 1; d <= REMAP_WINDOW; d++) {
			for (const at of [recorded + d, recorded - d]) {
				if (at < 0 || at > last)
					continue;
				if (hit(src.getLine(at)))
					return at;
			}
		}
	}
	return undefined;
}

// 把一个过期的记录位置重映射到文件当前的行上：条目的文本锚点（见 readNavEntryState）定位到过去
// 坐在记录行号上的那一行。返回一份平移过的副本 —— 调用方的条目保持不可变（带键条目的语义），
// 原锚点留在条目上供下次应用。没有锚就没有扫描、也没有改动：位置完全按记录的样子应用。
export function remapAnchoredState(editor: LineSource, st: NavEntryState): NavEntryState {
	const base = st.scroll ?? st.cursor?.from.line;
	if (base === undefined || base < 0)
		return st;
	const at = remapAnchorLine(st.anchor, base, editor);
	return at === undefined || at === base ? st : shiftNavState(st, at - base);
}

// 把一个记录位置平移 `delta` 行 —— 结构锚点的漂移：它**当前**的行减去**记录时**的行，两者都由
// 调用方经 metadataCache 求出。机制同上一个重映射（不可变副本、scroll 在 0 处夹住、光标行也夹），
// 但由一条权威的结构行驱动，而不是 ±REMAP_WINDOW 的文本扫描，所以超出任何窗口的位移也照样落得下。
// 文本锚点被丢掉：它属于记录时那一行，而调用方已经按结构重新定位过位置了。
//
// 有意让两个消费者共用，它们必须对平移达成一致：一次文件内历史跳转
// （RestoreModes.historyJumpApply），以及跨文件遍历交给 open 流水线的那次落点
// （NavStack.landingFor，它跑不了文本重映射 —— 目标编辑器还不存在）。
export function shiftNavState(st: NavEntryState, delta: number): NavEntryState {
	if (delta === 0)
		return st;
	const mapped: NavEntryState = { ...st, anchor: undefined };
	if (mapped.scroll !== undefined)
		mapped.scroll = Math.max(0, mapped.scroll + delta);
	if (mapped.cursor) {
		mapped.cursor = {
			from: { ...mapped.cursor.from, line: Math.max(0, mapped.cursor.from.line + delta) },
			to: { ...mapped.cursor.to, line: Math.max(0, mapped.cursor.to.line + delta) },
		};
	}
	return mapped;
}

export function applyEphemeralState(view: MarkdownView, state: EphemeralState) {
	const stateToApply: Record<string, unknown> = {};
	if (state.cursor)
		stateToApply.cursor = state.cursor;
	if (state.scroll && state.scroll > 0)
		stateToApply.scroll = state.scroll;

	if (Object.keys(stateToApply).length > 0)
		view.setEphemeralState(stateToApply);
}

export function setCursorToEnd(view: MarkdownView) {
	const editor = view.editor;
	if (editor) {
		const lastLine = editor.lastLine();
		const lastLineLength = editor.getLine(lastLine).length;
		editor.setCursor({ line: lastLine, ch: lastLineLength });
		editor.scrollIntoView({ from: { line: lastLine, ch: 0 }, to: { line: lastLine, ch: lastLineLength } }, true);
	}
}
