import { MarkdownView, Platform } from 'obsidian';
import { EphemeralState, NavEntryState, PluginSettings } from '@/types';
import { applyEphemeralState, readEphemeralState, remapAnchoredState, setCursorToEnd, shiftNavState } from '@/position/capture/ephemeral';
import { ANCHOR_SETTLE_DELAY, animateScrollTop, delay, getScroller, hasPreviewScrolled, nextPaint, waitForContentReady, waitForRestorePainted } from '@/shared/wait';
import { PositionState } from '@/position/state';
import { SETTLE_HOLD_MAX_MS, SETTLE_MAX_MS, SourcePixelCorrector } from './pixels';

// 一个被走过的行的标记，最多等它的落点多长时间：远超过任何一次 open 加上落定，
// 又短到读者不会把它误当成对刚才那个动作的回应。
const LINE_FLASH_ASK_MS = 5000;

// 各种恢复策略：分发流水线判定需要一次恢复之后，保存的位置如何被应用到
// 一个 markdown 视图上 —— masked（在 contentEl 遮罩下）、glide（可见，从顶部
// 开始）、restoreInjectedSource（在 leaf 首绘遮罩下），以及每一种策略最后都会
// 走到的共享锚点。
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
		try {
			// 一个合并的循环管着整个被遮住的阶段：它用**真实的像素几何**来
			// 校验（getScroll() 回读只是在复述请求），落点一静下来**且**对齐
			// 就揭开。从恢复入口起算有界，好让遮罩的安全定时器始终是外层
			// 界限。
			if (isCurrent() && st?.scroll)
				await this.pixels.settleAndHold(view, st.scroll, isCurrent, touchBaseline, entryAt + SETTLE_HOLD_MAX_MS);
		} finally {
			if (isCurrent())
				this.state.cover.uncover(view.leaf);
		}
		await this.anchorToSettledState(view, st, isCurrent);
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
	// setViewState 的源码模式 open。
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
		applyEphemeralState(view, st);
		await nextPaint();
		if (!isCurrent())
			return;
		if (view.getMode() === 'source' && (st.scroll ?? 0) > 0)
			await this.pixels.settleSourcePixels(view, st, isCurrent, SETTLE_MAX_MS);
		await this.anchorToSettledState(view, st, isCurrent);
	}

	// glide 恢复：没有蒙版，也就没有空白期。笔记从顶部可见地渲染出来（那次
	// 异步渲染是 Obsidian 自己的活）；渲染器一产出内容，我们就滚到保存的那一行。
	async glideRestore(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		if ((st.scroll ?? 0) <= 0)
			throw new Error('glideRestore: no saved scroll');

		await waitForContentReady(view, isCurrent);
		if (!isCurrent())
			return;

		// 兜底：那些绕过了 openLinkText 的 anchorLink 高亮：core 的目标说了算，
		// 不滑行。（与 maskedRestore 是同一个守卫。）
		if (view.containerEl.querySelector('.is-flashing'))
			return;

		const scroller = getScroller(view);
		if (!scroller) {
			// 笔记不可滚动：让 Obsidian 自己的 applyScroll 去安置它。
			applyEphemeralState(view, st);
			await nextPaint();
			await this.anchorToSettledState(view, st, isCurrent);
			return;
		}

		await this.glideScrollTo(view, scroller, st, isCurrent);
	}

	// 共享的滑行内核：应用保存的那一行，等渲染器真正落到那里，再跑那段固定的
	// 短过渡并校验。applyScroll 可以把这次滚动推迟到渲染器的下一趟，所以立即
	// 回读不可靠（读到过期的 0 → 误判成「已经在那一行」→ 卡在顶部）；要一直
	// 等到视图报出保存的那一行**并且**滚动容器已经动了（有界）。单次 apply
	// 也可能永远落不到 —— 分阶段的流水线会在它落下之后重置滚动，而在渲染器
	// 赶上之前发出的 apply 是个无声的空操作 —— 所以漂了就重发。
	private async glideScrollTo(view: MarkdownView, scroller: HTMLElement, st: EphemeralState, isCurrent: () => boolean) {
		const scroll = st.scroll;
		if (!scroll || scroll <= 0)
			return;
		applyEphemeralState(view, st);
		const landDeadline = Date.now() + 2000;
		let lastApply = Date.now();
		// 落定 = 渲染器报出保存的那一行**并且**（源码模式之外）真正的滚动容器
		// 已经动了：阅读视图会在任何像素移动之前，就把请求的滚动回显进
		// getScroll()。
		const landed = () => {
			if (Math.round(view.currentMode?.getScroll() ?? -1) !== scroll)
				return false;
			if (view.getMode() === 'preview' && !hasPreviewScrolled(view))
				return false;
			return true;
		};
		while (isCurrent() && Date.now() < landDeadline && !landed()) {
			await nextPaint();
			if (isCurrent() && Date.now() - lastApply >= 100 && !landed()) {
				applyEphemeralState(view, st);
				lastApply = Date.now();
			}
		}
		if (!isCurrent())
			return;
		// 渲染器（或一次模式翻转）可能在捕获之后换掉滚动元素，让传进来的这个
		// 滚动容器脱了链、停在 scrollTop 0。
		const liveScroller = getScroller(view) ?? scroller;
		const targetPx = liveScroller.scrollTop;
		if (targetPx <= 0) {
			// 笔记太短滚不动 / 保存的那一行掉到了末尾之外：已经应用进去的状态
			// 就是正确的落点。
			await nextPaint();
			await this.anchorToSettledState(view, st, isCurrent);
			return;
		}
		const prevBehavior = liveScroller.style.scrollBehavior;
		liveScroller.setCssStyles({ scrollBehavior: 'auto' }); // 没有哪个主题能把帧变成动画
		try {
			// 固定的短过渡：加速到约 1200px/s，并封顶在 600ms，所以再深的笔记
			// 也拖不久 —— 这是一个方向提示加柔和落点，不是让人读的滑行
			// （滚动即导航）。
			const duration = Math.max(150, Math.min(600, (targetPx / 1200) * 1000));
			await animateScrollTop(liveScroller, 0, targetPx, duration, isCurrent);
			if (!isCurrent())
				return;

			// 精确落位：恢复完整的保存状态（含光标），并校验那一行落到了请求
			// 的位置；有东西漂走了就校正回来。
			applyEphemeralState(view, st);
			await nextPaint();
			if (!isCurrent())
				return;
			const landed = Math.round(view.currentMode?.getScroll() ?? -1);
			if (landed !== scroll) {
				applyEphemeralState(view, st);
				await nextPaint();
			}
		} finally {
			liveScroller.style.scrollBehavior = prevBehavior;
		}

		await this.anchorToSettledState(view, st, isCurrent);
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
			// 每一条真正的恢复路径都终结在这里，所以 cue 只在一次真实的恢复
			// 落定之后才响。NavStack 的遍历会装好 cueSuppressUntil —— 目的地
			// 是用户自己选的，不给提示条。
			if (Date.now() >= this.state.cueSuppressUntil)
				this.state.cue.show(view);
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
}
