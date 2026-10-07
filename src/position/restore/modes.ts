import { MarkdownView, Platform } from 'obsidian';
import { EphemeralState, NavEntryState, PluginSettings } from '@/types';
import { applyEphemeralState, readEphemeralState, remapAnchoredState, setCursorToEnd, shiftNavState } from '@/position/capture/ephemeral';
import { ANCHOR_SETTLE_DELAY, delay, nextPaint, waitForContentReady, waitForRestorePainted } from '@/shared/wait';
import { PositionState } from '@/position/state';
import { SETTLE_HOLD_MAX_MS, SETTLE_MAX_MS, SourcePixelCorrector } from './pixels';

// 一个被走过的行的标记，最多等它的落点多长时间：远超过任何一次 open 加上落定，
// 又短到读者不会把它误当成对刚才那个动作的回应。
const LINE_FLASH_ASK_MS = 5000;

// 回读一次居中落点最多等几帧。编辑器把 `scrollIntoView` 排进它自己的测量趟（那是一个
// effect，不是一次同步写），派发之后立刻回读拿到的是**旧**滚动；而少等一帧就回读，会让
// 下游那些「按 st.scroll 对齐到顶」的纠正器把刚居中的视口又拉回去。8 帧约 130ms —— 远在
// 任何一段遮罩预算之内（SETTLE_MAX_MS 是 800，遮罩保险是 2000）。
const CENTER_READ_MAX_FRAMES = 8;

// 各种恢复策略：分发流水线判定需要一次恢复之后，保存的位置如何被应用到
// 一个 markdown 视图上 —— masked（在 contentEl 遮罩下）、restoreInjectedSource
// （在 leaf 首绘遮罩下）、landPreview（阅读：不遮，交给渲染器落），以及每一种
// 策略最后都会走到的共享锚点。
export class RestoreModes {
	private settings: PluginSettings;
	private state: PositionState;
	private pixels: SourcePixelCorrector;

	constructor(settings: PluginSettings, state: PositionState) {
		this.settings = settings;
		this.state = state;
		this.pixels = new SourcePixelCorrector(state);
	}

	// 那些「保存的位置已被注入进 core 的 setViewState」的 open，走源码模式的
	// 恢复：core 已经同步应用过了，这里我们在这个 leaf 的首绘遮罩下落定落点、
	// 揭开遮罩、重新锚定。安全定时器先一步把遮罩揭掉时（约 2s 后才被激活的
	// 后台 open），遮罩可能已经不在了：落点照样漂了 —— 刚建出来的编辑器会
	// 偏最多半屏 —— 所以这次落定照跑，不遮不盖但有界，而且只跑这第一次
	// file-open（注入标记会给后来的激活去重）。阅读视图从不注入，所以这个
	// per-leaf 的遮罩检查绝不能把它的 masked 恢复跳过去。
	async restoreInjectedSource(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		const entryAt = Date.now();
		// 落定与保持共用一条触摸基准：比这次 open 自己那一下更晚的触摸，说明
		// 用户接管了 —— 绝不能拿遮罩压着他们的滚动。
		const touchBaseline = this.state.lastTouchAt;
		let landed = st;
		try {
			// 一次点名了一行的跳转：先让编辑器自己把那一行摆到正中（与点大纲面板同一个
			// 原语），再把回读到的视口顶当成落点 —— 落法于是和原生一模一样，也不再依赖
			// 「这一屏几行」那个估算。遮罩还盖着，所以「先落估算值、再居中」看不见。
			const centered = isCurrent() && st?.scroll
				? await this.centerNamedLine(view, isCurrent)
				: undefined;
			if (centered !== undefined && st)
				landed = { ...st, scroll: centered };
			// 一个合并的循环管着整个被遮住的阶段：它用**真实的像素几何**来
			// 校验（getScroll() 回读只是在复述请求），落点一静下来**且**对齐
			// 就揭开。从恢复入口起算有界，好让遮罩的安全定时器始终是外层
			// 界限。
			if (isCurrent() && landed?.scroll)
				await this.pixels.settleAndHold(view, landed.scroll, isCurrent, touchBaseline, entryAt + SETTLE_HOLD_MAX_MS);
		} finally {
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
		await this.anchorToSettledState(view, landed, isCurrent);
	}

	// 后台标签页的变体，针对一次从未触发 'file-open' 的注入 open（一个重启
	// 恢复出来、视图**已经建好**的分屏）：落点漂得和活动标签页一模一样，但在
	// 第一次激活之前没有任何东西去落定它。跑同样的 settle+reveal，但**不走**
	// anchorToSettledState —— 那个会写单槽的记录基准和 cue，而它们只属于活动
	// leaf。
	async settleInjectedReveal(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		const entryAt = Date.now();
		const touchBaseline = this.state.lastTouchAt;
		try {
			if (isCurrent() && st?.scroll)
				await this.pixels.settleAndHold(view, st.scroll, isCurrent, touchBaseline, entryAt + SETTLE_HOLD_MAX_MS);
		} finally {
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
	}

	// masked 恢复的骨架，保存位置与默认位置两种恢复共用。遮罩在首绘之前盖上，
	// 在确认恢复后的位置已经画出来的同一帧里揭掉，所以揭开是看不见的。
	// 用 opacity（不是 display:none）让隐藏期间布局保持完整，于是揭开纯粹是
	// 合成器的工作。
	//
	// `apply` 应用位置，并在可滚动时返回 true，这样遮罩会一直留着，直到编辑器
	// 报告出那一行（有界）；同步类恢复只等两帧来确认结果已经画出来。
	private async maskedRestore(
		view: MarkdownView,
		st: EphemeralState | undefined,
		isCurrent: () => boolean,
		apply: () => boolean,
	) {
		// 把正在构建的恢复藏起来；最后揭开它的是 finally 里的
		// revealRestoreCover 和 restoreEphemeralState 顶部那一个（给被顶掉的
		// 恢复用）。
		this.state.cover.restoreCover(view);
		try {
			// 等阅读渲染器把这篇笔记产出来（有界）。链接高亮的 span 会随这次
			// 渲染一起出现，所以这也把 .is-flashing 的重检安排在它可能存在
			// 的时刻。
			await waitForContentReady(view, isCurrent);
			if (!isCurrent())
				return;

			// 兜底：那些绕过了 openLinkText 的 anchorLink 高亮（程序化滚动、
			// API open）：core 的目标说了算，什么都不恢复。见 #10、#32、#46、#51。
			if (view.containerEl.querySelector('.is-flashing'))
				return;

			await nextPaint();
			if (!isCurrent())
				return;

			const scrollable = apply();

			// 一直遮着，直到编辑器报告出那一行（有界，免得失败时遮成一片
			// 空白）。scrollable 已经蕴含 st 非空且可滚动。
			if (scrollable && st) {
				await waitForRestorePainted(view, st, isCurrent);
			} else {
				// 同步类恢复；两帧确保结果已经画出来。
				await nextPaint();
				await nextPaint();
			}
			if (!isCurrent())
				return;

			// 源码模式：趁还遮着，用**一次**纠正收敛编辑器的测量并修正落点 ——
			// 揭开之后再纠正，读起来就是一场肉眼可见的拉锯。
			await this.pixels.settleSourcePixels(view, st, isCurrent, SETTLE_MAX_MS);
		} finally {
			if (isCurrent()) {
				// 既要揭掉 leaf 级的遮罩（来自 coverOpen）**又**要清掉这次恢复
				// 在 view.contentEl 上自己的遮罩 —— 两个不同的元素，两个都得
				// 清掉才能揭开。
				this.state.cover.uncover(view.leaf);
				this.state.cover.revealRestoreCover(view);
			}
		}

		await this.anchorToSettledState(view, st, isCurrent);
	}

	// 在隐藏的遮罩下恢复一个保存的位置 —— 阅读视图，以及少数绕过了
	// setViewState 的源码模式 open。阅读视图里**被注入过落点**的那一路不走这里
	// （core 自己会落定，没有顶部要藏，遮上只是空白 —— 见 landPreview）。
	async maskedRestoreSt(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		if ((st.scroll ?? 0) <= 0) {
			// scroll 为 0 的记录：唯一能用的那部分就是光标，它同步落地，从不
			// 移动视口。给一次空恢复加遮罩，只会多出一段被遮住的空白期 —— 在
			// 慢设备（Android）上非常显眼 —— 所以就在 open 里应用。
			applyEphemeralState(view, st);
			await nextPaint();
			if (!isCurrent())
				return;
			await nextPaint();
			if (!isCurrent())
				return;
			await this.anchorToSettledState(view, st, isCurrent);
			return;
		}
		await this.maskedRestore(view, st, isCurrent, () => {
			applyEphemeralState(view, st);
			return true;
		});
	}

	// 阅读模式的**无遮罩**落定 —— 只给「落点已经随 open 注入给 core」的那一路用
	// （见 restorer.ts 的阅读分支）。那一路上 core 自己的渲染流水线接着这个值
	// （applyScrollDelayed 会在渲染器就绪时落一次），所以**没有「未恢复的顶部」需要藏**，
	// 而遮罩在这条路上只会把整段异步渲染期变成一片空白 —— 跨文件打开一篇大笔记能到
	// 2~3 秒，同一个文件因为渲染器早已就绪则完全察觉不到（这正是「同一个文件内切换没有
	// 问题」的那半个现象）。
	//
	// 于是这里不遮：让笔记照常画出来，等渲染器就绪（有界）把落点应用上去、按住几帧，
	// 再走共享的收口 —— 与 maskedRestore 走的是同一个 anchorToSettledState，
	// 所以账本、提示、锚定基准一件都不少。那一次应用落在内容首绘的同一帧里
	// （waitForRestorePainted 每帧量一次、在 rAF 回调里施加），所以也不会读成
	// 「先看见顶部、再跳一下」。
	async landPreview(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		try {
			await waitForContentReady(view, isCurrent);
			if (!isCurrent())
				return;
			// 兜底：那些绕过了 openLinkText 的 anchorLink 高亮（程序化滚动、API open）
			// —— core 的目标说了算，什么都不恢复。（与 maskedRestore 同一个守卫。）
			if (view.containerEl.querySelector('.is-flashing'))
				return;
			await waitForRestorePainted(view, st, isCurrent);
		} finally {
			// 这条路径自己不遮（那正是它存在的理由），但**别人**可能还盖着这个 leaf：
			// 一次被顶掉的恢复，或一次注入的 open 留下的首绘遮罩。揭开它 —— 否则只能
			// 等遮罩的保险定时器（两秒）。
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// 在隐藏的遮罩下应用一个源码模式的默认位置（没有保存的记录）。
	async maskedRestoreDefault(view: MarkdownView, isCurrent: () => boolean) {
		await this.maskedRestore(view, undefined, isCurrent, () => {
			if (this.settings.defaultPosition === 'fileEnd') {
				setCursorToEnd(view);
			}
			return false;
		});
	}

	// 文件内的历史跳转（前进 / 后退落在**同一篇**笔记里）：视图已经渲染好了 ——
	// 没什么要遮的，也没有 open 流水线要等。跑在漏斗的恢复括号里，所以轮询
	// 不会把这些 apply 当成用户移动记下来。
	async historyJumpApply(view: MarkdownView, st: NavEntryState, isCurrent: () => boolean, shift?: number) {
		// 这一步的行号早于它被记录之后所做的编辑（上方的插入 / 删除会把下面
		// 每一行都推走）。两种重锚的路子：结构化解出的位移（这次跳转自己的
		// 标题 / 块 id 通过 metadataCache 重新定位 —— 权威），或者按文本片段
		// 重映射的退路。
		if (shift !== undefined)
			st = shiftNavState(st, shift);
		else
			st = remapAnchoredState(view.editor, st);

		// 一次点名了一行的跳转（见 namedLineAsk）：**先只落光标**，让编辑器自己把那一行摆正
		// —— 视口于是只动一次，而且动在真实像素上。种子（`st.scroll`）那一次不落：它是按
		// 行号估的（core 的 applyScroll 拿区块平均插值，见 shared/jump-landing.ts 文件头），
		// 落了就是「先估一个位置、再被居中纠正回来」的两下，第二下还看得见 —— 那正是
		// 「编辑模式跳转有时候有轻微的跳动」。core 的 setState 在带光标时会把滚动原样还回去
		// （`scrollTo(当前滚动)`），所以这一次施加不移动视口。
		const named = this.namedLineAsk(view) !== undefined;
		applyEphemeralState(view, named ? { ...st, scroll: 0 } : st);
		await nextPaint();
		if (!isCurrent())
			return;
		const centered = await this.centerNamedLine(view, isCurrent);
		if (centered !== undefined) {
			// 这次像素落定、锚定、记账于是都对着回读到的真实视口顶，而不是当初按
			// 「这一屏几行」估出来的那个数。
			st = { ...st, scroll: centered };
		} else if (named) {
			// 居中做不到（视图还没建好 / 编辑器不认那个原语）：退回种子 —— 这一刻它是唯一的
			// 落点，也正因如此它得留着（别把 jumpTopBiasLines 的源码分支删成 0）。
			applyEphemeralState(view, st);
			await nextPaint();
			if (!isCurrent())
				return;
		}
		if (view.getMode() === 'source' && (st.scroll ?? 0) > 0)
			await this.pixels.settleSourcePixels(view, st, isCurrent, SETTLE_MAX_MS);
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// 这一步点名的那一行 —— **只认跳转**：`pendingLineFlash` 正是「这一步点名了一行」（见
	// NavStack.armLandingMark）。一次普通打开的保存位置没有它 —— 那种落点是一整个**视口**，
	// 它那一行必须留在顶上，不能拿去居中。答不出来时返回 undefined，调用方退回种子：
	//   · 不是源码模式（阅读模式没有编辑器原语，落法由 jumpTopBiasLines 那边管）；
	//   · 不是点名的这篇笔记（标记是全局的）；
	//   · 标记过期（一次从未落地的打开要求的行，不许在后来某次恢复里居中）；
	//   · 编辑器不认这个原语（视图还没建好）。
	private namedLineAsk(view: MarkdownView): { line: number } | undefined {
		const ask = this.state.pendingLineFlash;
		if (!ask || view.getMode() !== 'source' || view.file?.path !== ask.path)
			return undefined;
		if (Date.now() - ask.at >= LINE_FLASH_ASK_MS)
			return undefined;
		if (typeof view.editor?.scrollIntoView !== 'function')
			return undefined;
		return ask;
	}

	// 一次「点名了一行」的落点，在源码模式里交给**编辑器自己**摆正：core 自己的大纲点击走
	// 的就是这个原语（`editor.scrollIntoView(range, true)` —— 解包 obsidian.asar 实测，它就是
	// `dispatch(scrollIntoView(range, {y: "center"}))`），所以它落在哪儿我们就落在哪儿 ——
	// 与视口多高无关，也就不会有「按一屏几行估出来的半个视口」那种时中时偏。**行号在这里
	// 不再是落点，只是「要点名哪一行」**：镐下去的是像素，回读出来的也是像素。
	//
	// 它同时是**唯一**一处让落点居中：别处一律按 `st.scroll` 把那一行对齐到顶部
	// （settleSourcePixels 等），所以这里的居中要靠它回读出来的视口顶来「说服」那些纠正器
	// —— 它们随后量到的偏差就是零。
	//
	// 返回 undefined 只有两种情形：**没有要求编辑器滚动**（见 namedLineAsk），或那个原语
	// 直接抛了。调用点都在遮罩下（跨文件）或紧接施加之后（同文件）。
	private async centerNamedLine(view: MarkdownView, isCurrent: () => boolean): Promise<number | undefined> {
		const ask = this.namedLineAsk(view);
		if (!ask)
			return undefined;
		const before = this.readScroll(view);
		try {
			view.editor.scrollIntoView({ from: { line: ask.line, ch: 0 }, to: { line: ask.line, ch: 0 } }, true);
		} catch {
			return undefined;
		}
		return this.settledScroll(view, isCurrent, before);
	}

	// 等编辑器把那次滚动真正应用下去，再回读视口顶（有界）。`scrollIntoView` 是一个 effect，
	// 编辑器把它排进自己的测量趟，所以派发之后立刻回读读到的是**旧**滚动 —— 而这个值要交给
	// 那些按 `st.scroll` 对齐到顶的纠正器，读旧了它们就会把刚居中的视口拉回去（越是不居中
	// 越明显）。等它动过、并且在两帧上一致了才算数（同 waitForRestorePainted 的做法）；一直
	// 不动（居中后的位置恰好与原来一样）就等满窗口，照样把读到的那个值交出去。
	private async settledScroll(view: MarkdownView, isCurrent: () => boolean, before: number | undefined): Promise<number | undefined> {
		let prev: number | undefined;
		let same = 0;
		for (let i = 0; i < CENTER_READ_MAX_FRAMES && isCurrent(); i++) {
			await nextPaint();
			const now = this.readScroll(view);
			if (now === undefined) {
				same = 0;
				continue;
			}
			same = prev !== undefined && Math.abs(now - prev) < 0.01 ? same + 1 : 0;
			prev = now;
			const moved = before === undefined || Math.abs(now - before) > 0.01;
			if (same >= 1 && (moved || i >= CENTER_READ_MAX_FRAMES - 1))
				return Math.max(1, Math.round(now));
		}
		return prev === undefined ? undefined : Math.max(1, Math.round(prev));
	}

	// 视口顶此刻在哪一行（可能带小数）。阅读渲染器还没跟上时报的是 null，编辑器还没建出来时
	// 报 undefined —— 两者都算「没有答案」，绝不当作 0。
	private readScroll(view: MarkdownView): number | undefined {
		const top = view.currentMode?.getScroll();
		return typeof top === 'number' && Number.isFinite(top) ? top : undefined;
	}

	// 把变化检测锚到视图**实际**落定的地方，而不是我们请求的那个值。整数量化
	// 能吸收 applyScroll 的落点误差，但视口上方加载的图片会把回读推走整数行 ——
	// 越过死区。锚到请求的那个值，会让轮询循环把这次布局位移当作用户滚动，
	// 覆盖掉保存的位置。ANCHOR_SETTLE_DELAY 让这些位移先稳定下来。
	private async anchorToSettledState(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (this.state.noAnchorLeafIds.has(this.state.leafId(view.leaf)))
			return;
		await delay(ANCHOR_SETTLE_DELAY);
		// 被顶掉的恢复绝不能锚定：lastEphemeralState 会描述错文件，轮询循环
		// 会把它写进数据库。源码模式在**所有**平台都纠正（桌面端注入的 open
		// 也会落偏）；阅读的回读循环则只在移动端跑，那里的预览漂移常见到需要
		// 一个纠正循环。
		if (isCurrent() && (view.getMode() === 'source' || Platform.isMobileApp))
			await this.pixels.relandDriftedScroll(view, st, isCurrent);
		if (isCurrent()) {
			this.state.lastEphemeralState = readEphemeralState(view) ?? st;
			this.state.lastAnchorAt = Date.now();
			this.markLandingLine(view);
			// 每一条真正的恢复路径都终结在这里，所以两个方向提示只在一次真实的恢复
			// 落定之后才响。NavStack 的遍历会装好 cueSuppressUntil —— 目的地是用户
			// 自己选的，不给提示；那一路的落点由 armLandingMark 单独标出（见
			// markLandingLine），所以这里也不会和它闪成两下。
			if (Date.now() >= this.state.cueSuppressUntil) {
				this.markRestoredLine(view);
				this.state.cue.show(view);
			}
		}
	}

	// 一个点了名的行、正在赶路的步，在笔记这一侧要做的事：给它打标记，就像 app 给它自己的
	// 大纲把读者带去的那一行打标记那样（见 NavStack.armLandingMark）。之所以在这一侧回答，
	// 是因为每一条真正的恢复都终结于此 —— 标记于是落在**落定后**的落点上，而不是当初
	// 请求的那一行。
	private markLandingLine(view: MarkdownView) {
		const ask = this.state.pendingLineFlash;
		if (!ask)
			return;
		if (Date.now() - ask.at >= LINE_FLASH_ASK_MS) {
			this.state.pendingLineFlash = undefined;
			return;
		}
		if (view.file?.path !== ask.path)
			return;
		this.state.pendingLineFlash = undefined;
		this.state.cue.flashLine(view, ask.line);
	}

	// 恢复后标出落点：编辑模式标光标那一行 —— 读者要接着打字的地方（视口顶部那一行不标：
	// 眼睛本来就在那儿，标了只是复述）；阅读模式没有光标，标落点本身那一块。行元素找不到
	// （光标在屏外，或视图刚重建还没画到那一行）就什么都不发生 —— flashLine 自己会安静
	// 地退回无操作，所以这里不必先判断一次可见性。开关在 flashLine 那一侧。
	private markRestoredLine(view: MarkdownView) {
		const line = view.getMode() === 'preview'
			? Math.round(view.currentMode?.getScroll() ?? 0)
			: view.editor?.getCursor()?.line;
		// 文件开头那一行不是一次落点：没有保存位置的文件就打开在这儿，标它只是噪音。
		if (!line)
			return;
		this.state.cue.flashLine(view, line);
	}
}
