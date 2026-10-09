// 源码注入 open 的「短盖」在恢复这一侧的接线（modes.restoreInjectedSource 调
// pixels.settleShortCover）：盖多久、什么时候根本不盖，以及**循环本身**的判据。
//
// 前半段钉接线，钉的是边界值与出口：
//  · **上界从「读者看得见这道遮罩」那一刻起算**（见 ui/cover.ts），而下界不在这里 ——
//    它由循环从「第一次量到真几何」起算（core 的重落窗口跟着内容交换走）；
//  · **遮罩两端都在 open 一开始就涂上**（见 ui/cover.ts 的 cover()），读盘那段也盖上。
//    但「读者看得见」的时刻两处不同：桌面上涂上就看得见；手机端那一刻全屏的文件列表还盖着
//    正文，要等新内容进视图。上界从读者看得见那一刻起算，读盘才不会把短盖的预算白吃掉；
//  · 落点用**收口后**的值（一次点名一行的跳转回读到的居中位置），不是记录里那个；
//  · 没有盖布、或没有 scroll 时不等待（没有要藏的东西，等下去只是推迟锚定），但揭开
//    与共享收口照跑；遮罩一直没被读者看见（新内容迟迟不来）时也不等，到点照走。
//
// 后半段用假的 CM6 实例把循环真跑一遍（真几何不好造，但循环只从 CM 读四样东西：
// 文档身份、目标行、视口闸门、像素几何）—— 每条判据各自对应一次真机回报：① 目标行不动、
// 而**眼前那条带子**在挪 ⇒ 只盯目标行会漏掉读者看见的位移；② 下限从盖布起算 ⇒ 大文件的
// 交换把下限推到了 core 重落之前；③ 逐帧比「有没有动」⇒ 小步推进的测量一路被判「没动」
// （手机上的大文件）；④ 第二个读数是**整篇文档的测量高度** ⇒ 视口**下方**换真值也算进去，
// 大文件的空白白等一截；⑤ **起手不先让编辑器画出新文档** ⇒ 量的是旧文档那页（它一动不动），
// 窗口走完就揭幕，紧接着编辑器才把新画面推上来（2026-10-09 晚，手机上「内容出现后自己动」）。
//
// 末段是**跨文件打开的那道闸门**：把编辑器原语派发到旧文档上等于作废（甚至更糟 ——
// 它的滚动 effect 可能在交换之后才被应用），而在旧文档上量像素会得出「已经量完了」的假结论
// （短盖当场揭幕）。两道闸门问的是同一个问题（「新内容进编辑器了吗」），答案由**同一段闭包**
// 给出：patcher 在武装时装好（contentSwapGate），遮罩与恢复流水线都借它。这一段钉的就是
// 「闸门关着时谁也不许碰编辑器」。
//
// 闭包本身（怎么判断新内容到了）钉在 tests/patcher-inject.test.ts 里：那里能造出真实的
// 旧视图 + 文档对象，而这里的 harness 只认一个开关。「读不到编辑器时许不许答『到了』」也在那里。
//
// ⚠️ 那条判据**不是**「文档与 view.data 相符」：core 的 loadFile 先换 view.file、再 await
// 读盘、最后才 setData（先写 data 再换文档），所以 data 与文档是**一起**换的 ——
// 「相符」在读盘之前与之后都成立，拿它当闸门等于不判（详见 pixels.noteArrived）。
//
// 末尾一段（丙）钉**点名一行的居中**：编辑器晚一步才挂上那个原语时要等它，不能把「还没就位」
// 误读成「没有要点名的行」而静默放弃居中（落点于是退回按行数估的种子）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkdownView, Platform, type WorkspaceLeaf } from 'obsidian';

import { RestoreModes } from '@/position/restore/modes';
import { SourcePixelCorrector, DOC_READY_MAX_MS, SOURCE_COVER_FLOOR_MS, SOURCE_COVER_MAX_MS } from '@/position/restore/pixels';
import { PositionState } from '@/position/state';
import { DEFAULT_SETTINGS } from '@/types';

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};

type Pixels = {
	settleShortCover: (
		view: MarkdownView,
		line: number,
		isCurrent: () => boolean,
		touchBaseline: number,
		deadline: number,
	) => Promise<void>;
};

// modes 私有的那个像素纠正器 —— 要钉的正是它拿到的边界值（cue-restore 里 spy
// settleSourcePixels 是同一个路子）。
const pixelsOf = (modes: RestoreModes): Pixels =>
	(modes as unknown as { pixels: Pixels }).pixels;

let covered: Array<[PositionState, WorkspaceLeaf]> = [];

afterEach(() => {
	// 停掉遮罩每个 rAF 重贴一次的那个循环。
	covered.forEach(([state, leaf]) => state.cover.uncover(leaf));
	covered = [];
	vi.restoreAllMocks();
});

// 一个源码视图 + 一个 leaf；`cover` 为真时按补丁的做法先把盖布装上去（传函数则当那个
// 「新内容到了吗」的判据，见 ui/cover.ts 的 cover()）。遮罩当场涂上、两端一致；「读者
// 看得见」那一刻由 `Platform.isPhone` 分道（手机端要等新内容进视图，见 markVisible）。
// `cm` 传进来时挂到 editor 上（循环那一半要用它）；`data` 是 Obsidian 交给视图的内容，
// 与 cm 里那个文档的 `toString()` 一致 —— docMatchesView（测量器那道最低保证）要它们相符，
// 而「换文档了没有」与它无关（见本文件头部）。
function makeHarness(
	opts: { cover?: boolean | (() => boolean); scroll?: number | (() => number); cm?: unknown } = {},
) {
	const { cover = true, scroll = RECORD.scroll, cm } = opts;
	const containerEl = document.createElement('div');
	const viewContent = document.createElement('div');
	viewContent.className = 'view-content';
	containerEl.appendChild(viewContent);
	const leaf = { id: 'leaf-1', containerEl } as unknown as WorkspaceLeaf;
	const view = Object.assign(new MarkdownView(undefined as never), {
		leaf,
		file: { path: 'a.md' },
		getMode: () => 'source',
		currentMode: { getScroll: typeof scroll === 'function' ? scroll : () => scroll },
		data: 'x',
		contentEl: document.createElement('div'),
		containerEl,
		editor: { cm, getCursor: () => undefined, scrollIntoView: vi.fn() },
		setEphemeralState: () => undefined,
	}) as unknown as MarkdownView;
	// 遮罩的判据读的是 leaf **当下**的视图（旧画面那条路靠它），所以得挂上去。
	(leaf as unknown as { view: unknown }).view = view;
	const state = new PositionState(DEFAULT_SETTINGS);
	const modes = new RestoreModes(state);
	if (cover) {
		state.cover.cover(leaf, typeof cover === 'function' ? cover : undefined);
		covered.push([state, leaf]);
	}
	return { state, modes, leaf, view, viewContent };
}

// Obsidian 给 HTMLElement 加的 setCssStyles 扩展，jsdom 没有。
beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

describe('源码注入 open 的短盖', () => {
	it('上界从遮罩真正盖上那一刻起算，走出这条路就揭幕', async () => {
		const { state, modes, leaf, view } = makeHarness();
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);
		const appliedAt = state.cover.appliedAt(leaf) as number;

		await modes.restoreInjectedSource(view, RECORD, () => true);

		expect(settle).toHaveBeenCalledTimes(1);
		const call = settle.mock.calls[0];
		expect(call[0]).toBe(view);
		expect(call[1]).toBe(RECORD.scroll);
		// 只传上界：揭幕下限由循环自己从「第一次量到真几何」起算（见本文件头部）。
		expect(call[4]).toBe(appliedAt + SOURCE_COVER_MAX_MS);
		expect(state.cover.isCovered(leaf)).toBe(false);
		// 共享收口照跑（锚定基准是「读者从哪儿继续」的唯一来源）。
		expect(state.lastAnchorAt).toBeGreaterThan(0);
	});

	it('点名一行的跳转：等待对着回读到的居中位置，不是记录里那一行', async () => {
		const { state, modes, view } = makeHarness({ scroll: 41.6 });
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };

		await modes.restoreInjectedSource(view, RECORD, () => true);

		// 41.6 → 42：编辑器把那一行摆到的地方才是落点，而短盖等的是它。
		expect(settle.mock.calls[0][1]).toBe(42);
	});

	it('没有盖布时不等待（没有要藏的东西），但照样揭开并收口', async () => {
		const { state, modes, view } = makeHarness({ cover: false });
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);

		await modes.restoreInjectedSource(view, RECORD, () => true);

		expect(settle).not.toHaveBeenCalled();
		expect(state.lastAnchorAt).toBeGreaterThan(0);
	});

	it('只有光标的记录不等待 —— 它从不移动视口，第一帧就已经是最终状态', async () => {
		const { state, modes, view } = makeHarness();
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);

		await modes.restoreInjectedSource(view, { cursor: RECORD.cursor }, () => true);

		expect(settle).not.toHaveBeenCalled();
		expect(state.lastAnchorAt).toBeGreaterThan(0);
	});

	it('手机端：遮罩当场涂上，但「读者看得见」要等新内容到位 —— 读盘不吃短盖的预算', async () => {
		vi.useFakeTimers();
		const wasPhone = Platform.isPhone;
		Platform.isPhone = true;
		try {
			// 手机上选择文件的过程全屏盖着正文（见 ui/cover.ts 的 markVisible）：遮罩虽然也在
			// setViewState 那一刻就涂上，可那一刻全屏的文件列表还盖着正文 —— 读者什么也还没
			// 看见。短盖的上界从**读者看得见**那一刻起算，所以读盘那一段不会把它的预算白吃掉
			// （吃掉的话揭幕时编辑器可能还没量完，读者又看见内容自己动）。
			let arrived = false;
			const { state, leaf, viewContent } = makeHarness({ cover: () => arrived });
			const start = Date.now();

			// 读盘进行中：遮罩已经涂上（屏幕上那篇旧笔记被藏起来），但起点还没记。
			await vi.advanceTimersByTimeAsync(300);
			expect(state.cover.isCovered(leaf)).toBe(true);
			expect(viewContent.style.opacity).toBe('0');
			expect(state.cover.appliedAt(leaf)).toBeUndefined();

			// 新内容到位 —— 这一刻才是读者看得见的起点。
			arrived = true;
			await vi.advanceTimersByTimeAsync(32);
			const appliedAt = state.cover.appliedAt(leaf);
			expect(appliedAt).toBeDefined();
			// 读盘那 300ms 不算进预算（起点要是落在 start，短盖就只剩 700ms）。
			expect((appliedAt as number) - start).toBeGreaterThanOrEqual(300);
		} finally {
			Platform.isPhone = wasPhone;
			vi.useRealTimers();
		}
	});
});

// 「读者看得见这道遮罩」的起点在两种情形下问的不是同一件事：
//   · 有「上一篇」要等（跨文件切换）—— 等新内容到位（闸门函数答它，见 patcher.contentSwapGate）；
//   · 没有上一篇（全新 leaf / 同一篇的重放）—— 闸门**缺席**，得问 leaf 自己「这篇内容进视图了吗」。
// 第二条是 2026-10-09 手机上报的「列表一收，新内容闪一下」：把缺席当成恒真，起点就落回
// 「涂上容器背景」那一刻，读盘与列表收起动画白吃掉短盖的预算。
describe('手机端遮罩的起点：等这篇内容进视图', () => {
	it('没有上一篇时（闸门缺席），起点不落在「涂上容器背景」那一刻', async () => {
		vi.useFakeTimers();
		const wasPhone = Platform.isPhone;
		Platform.isPhone = true;
		try {
			// 全新 leaf：`.view-content` 还没建出来，`leaf.view` 也还没有。
			const containerEl = document.createElement('div');
			const leaf = { id: 'leaf-new', containerEl, view: null } as unknown as WorkspaceLeaf;
			const state = new PositionState(DEFAULT_SETTINGS);
			covered.push([state, leaf]);

			// 手机端（Platform.isPhone）+ 没有上一篇（ready 缺席）。
			state.cover.cover(leaf, undefined);
			expect(state.cover.isCovered(leaf)).toBe(true);
			// 此刻全屏的文件列表还盖着正文 —— 读者什么都还没看见，起点不该记。
			expect(state.cover.appliedAt(leaf)).toBeUndefined();

			// 视图建出来、内容读进来：这一刻才是读者看得见的起点。
			const view = Object.assign(new MarkdownView(undefined as never), {
				file: { path: 'a.md' },
				data: 'hello',
				getMode: () => 'source',
			}) as unknown as MarkdownView;
			(leaf as unknown as { view: unknown }).view = view;
			const vc = document.createElement('div');
			vc.className = 'view-content';
			containerEl.appendChild(vc);

			await vi.advanceTimersByTimeAsync(32);
			expect(state.cover.appliedAt(leaf)).toBeDefined();
		} finally {
			Platform.isPhone = wasPhone;
			vi.useRealTimers();
		}
	});

	it('桌面端不受影响：涂上就是读者看得见', () => {
		const containerEl = document.createElement('div');
		const vc = document.createElement('div');
		vc.className = 'view-content';
		containerEl.appendChild(vc);
		const leaf = { id: 'leaf-desk', containerEl, view: null } as unknown as WorkspaceLeaf;
		const state = new PositionState(DEFAULT_SETTINGS);
		covered.push([state, leaf]);

		state.cover.cover(leaf, undefined);

		// 桌面上遮罩也在 open 一开始就涂上，而涂上就看得见 —— 起点当场就有（手机端才要等
		// 新内容进视图，见上一条）。
		expect(state.cover.appliedAt(leaf)).toBeDefined();
	});
});

// 假的 CM6 实例：循环只从它读四样东西 —— 「目标行在不在已渲染的视口里」（闸门）、那一行的
// 像素几何（coordsAtPos；jsdom 的 getBoundingClientRect 全为 0，所以读数就是它的 top）、
// 「视口底边那一点落在哪一行」（posAtCoords），以及**那一条可见行**的像素几何。四者都由 feed
// 现取，测试于是能精确重现真机上那几种局面。文档身份闸门拿 doc 与视图的 data 比，所以它们
// 都得是 'x'。
//
// `height`（整篇文档的测量高度）**只喂给旧读数**：新算法根本不该读它，把它喂成一路在变的
// 样子，任何退回 scrollHeight 的改动都会被「视口下方在变 ⇒ 照揭」那条用例抓住。
function makeCm(feed: {
	top: () => number;
	height: () => number;
	bottom?: () => number;
	rendered: () => boolean;
}) {
	const scrollDOM = document.createElement('div');
	Object.defineProperty(scrollDOM, 'scrollHeight', {
		get: () => feed.height(),
		configurable: true,
	});
	const bottom = feed.bottom ?? (() => 1000);
	return {
		state: {
			doc: {
				lines: 200,
				length: 1,
				line: (n: number) => ({ from: (n - 1) * 10 }),
				toString: () => 'x',
			},
		},
		scrollDOM,
		get viewport() {
			// 目标行（第 10 行，pos 100）在不在视口里 —— 不在就量不到真几何。
			return feed.rendered() ? { from: 0, to: 1 << 30 } : { from: 0, to: 1 };
		},
		// 视口底边探到的行：pos 150。读数按行分派 —— 目标行（pos 100）给 top，别的给 bottom。
		posAtCoords: () => 150,
		coordsAtPos: (pos: number) => ({ top: pos === 100 ? feed.top() : bottom() }),
		requestMeasure: () => undefined,
		defaultLineHeight: 20,
	};
}

describe('源码注入 open 的短盖 —— 循环本身', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// 起手：一个盖着布、量得到真几何的视图，加一个记下揭幕时刻的循环。
	function startLoop(feed: {
		top: () => number;
		height: () => number;
		bottom?: () => number;
		rendered: () => boolean;
	}) {
		const { state, view } = makeHarness({ cm: makeCm(feed) });
		const pixels = new SourcePixelCorrector(state);
		const appliedAt = state.cover.appliedAt(view.leaf) as number;
		let revealedAt = -1;
		void pixels
			.settleShortCover(view, RECORD.scroll, () => true, state.lastTouchAt, appliedAt + SOURCE_COVER_MAX_MS)
			.then(() => {
				revealedAt = Date.now();
			});
		return { appliedAt, revealedAt: () => revealedAt };
	}

	it('目标行钉住不动、眼前那条带子还在挪时不揭幕 —— 只盯目标行会漏掉读者看见的位移', async () => {
		const start = Date.now();
		// 眼前那条带子一路往下挪（每帧都在变），到 churnUntil 那一刻正好落回基线。目标行的读数
		// 从始至终一动不动 —— 这正是真机上的形状：core 的重落把**同一行**落在同一个偏移上，
		// 动的是它下面那些刚从估算换成真值的区块，换算到屏幕上就是整条带子往下走。
		const churnUntil = start + 300;
		const { revealedAt } = startLoop({
			top: () => 100,
			bottom: () => 1000 + Math.max(0, churnUntil - Date.now()),
			height: () => 5000,
			rendered: () => true,
		});

		// 带子还在挪的这一段里：目标行一直是「已对齐」，但**不许**揭。
		await vi.advanceTimersByTimeAsync(churnUntil - start - 50);
		expect(revealedAt()).toBe(-1);

		await vi.advanceTimersByTimeAsync(2000);
		// 带子稳下来之后才揭，而且不早于它稳下来那一刻。
		expect(revealedAt()).toBeGreaterThanOrEqual(churnUntil);
	});

	it('视口**下方**还在换真值时不白等 —— 整篇文档的高度不再算数', async () => {
		const start = Date.now();
		// 总高度一路在变（视口下方那些区块在换成真值），而眼前那条带子与目标行全程不动：
		// 读者一点都看不见。旧读数（scrollHeight）会一路盖到 churnUntil 之后；新读数在这一帧
		// 就满足了「没离开起点」。
		const churnUntil = start + 600;
		const { revealedAt } = startLoop({
			top: () => 100,
			bottom: () => 1000,
			height: () => 5000 + Math.max(0, churnUntil - Date.now()),
			rendered: () => true,
		});

		await vi.advanceTimersByTimeAsync(SOURCE_COVER_FLOOR_MS + 100);
		// 空白接近物理下限：不等那截看不见的高度变化。
		expect(revealedAt()).toBeGreaterThanOrEqual(start + SOURCE_COVER_FLOOR_MS);
		expect(revealedAt()).toBeLessThan(churnUntil);
	});

	it('真几何姗姗来迟时，揭幕下限从它到手那一刻起算 —— 大文件的交换把盖布起点推到了重落之前', async () => {
		const start = Date.now();
		// 文档交换要 400ms 才完成（大文件）：在那之前一次真几何都量不到。
		const realAt = start + 400;
		const { revealedAt } = startLoop({
			top: () => 100,
			height: () => 1000,
			rendered: () => Date.now() >= realAt,
		});

		await vi.advanceTimersByTimeAsync(300);
		expect(revealedAt()).toBe(-1); // 还没量到真几何，没什么可揭的
		// 真几何到手了，但下限（它 + SOURCE_COVER_FLOOR_MS）还没走完 ⇒ 继续盖着。
		// 按下限从盖布起算的旧算法，这里（约 +450ms）已经揭了 —— 而 core 的重落正落在
		// 那之后，于是读者看见内容自己动。
		await vi.advanceTimersByTimeAsync(200);
		expect(revealedAt()).toBe(-1);

		await vi.advanceTimersByTimeAsync(2000);
		expect(revealedAt()).toBeGreaterThanOrEqual(realAt + SOURCE_COVER_FLOOR_MS);
	});

	it('读数只是小步挪动（每帧都不到半行）时也不揭 —— 逐帧比会一路判「没动」', async () => {
		const start = Date.now();
		// 目标行每帧挪约 5px（半行容差是 10px），一路挪到 driftUntil；眼前那条带子也一路跟着挪。
		// 逐帧比较的旧算法在这一路上都判「没动」，于是下限（真几何 + 150）一过就揭 —— 而内容
		// 还在挪（手机上的大文件正是这个形状：测量一小步一小步推进）。与窗口起点比则要求它
		// 整段没离开过起点，任何累积位移都把窗口打回起点。
		const driftUntil = start + 300;
		const { revealedAt } = startLoop({
			top: () => 100 + Math.max(0, Math.min(driftUntil, Date.now()) - start) * 0.3,
			height: () => 1000,
			rendered: () => true,
		});

		// 下限（+150）早过了，而读数还在挪 ⇒ 不许揭。
		await vi.advanceTimersByTimeAsync(250);
		expect(revealedAt()).toBe(-1);

		await vi.advanceTimersByTimeAsync(2000);
		expect(revealedAt()).toBeGreaterThanOrEqual(driftUntil);
	});

	it('起手先推一趟测量、跨两帧再开始观察 —— 否则量的是旧文档那页（它一动不动）', async () => {
		const start = Date.now();
		// 文档刚换掉、屏幕上还是**上一篇**：CM6 把视口重算与 DOM 重画排在它自己的测量趟里
		// （rAF）。paintAt 就是那一趟落地的时刻 —— 此前 coordsAtPos 读到的还是旧文档的像素，
		// 而旧文档是稳的（100）；此后一步跳到新文档的真值（500）。早先的循环起手立刻就读，
		// 读到的正是旧文档那页 ⇒ 读数一动不动 ⇒ 窗口走完就揭幕，紧接着编辑器才把新文档画出来
		// 并测量，读者看见的就是那一下。
		//
		// 那一趟是**必要的一帧**，起手先跨过它，所以跳变点摆在「下限将满而尚未满」处：
		// 不限这一帧的旧算法在这里（下限一过）就揭了，限了这一帧才会等到那一跳之后。
		const paintAt = start + SOURCE_COVER_FLOOR_MS + 24;
		const { revealedAt } = startLoop({
			top: () => (Date.now() < paintAt ? 100 : 500),
			bottom: () => (Date.now() < paintAt ? 1000 : 1400),
			height: () => 5000,
			rendered: () => true,
		});

		// 旧文档那页还稳着的时候：不许揭 —— 此刻揭了，读者马上就会看见新文档把它推走。
		await vi.advanceTimersByTimeAsync(paintAt - start - 60);
		expect(revealedAt()).toBe(-1);

		await vi.advanceTimersByTimeAsync(2000);
		// 必须等到那一跳之后才揭。
		expect(revealedAt()).toBeGreaterThanOrEqual(paintAt);
	});
});

// 遮罩**什么时候动手**：**open 一开始就盖上**（两端一致）。⚠️ 旧写法（甲）等新内容到了才
// 盖、把读盘那段留给旧画面，2026-10-09 已被真机推翻 —— 它其实读起来是**上一篇闪一下**
// （文件不在内容缓存里时那次读盘要走磁盘），与点击快慢无关（结构性）。见 ui/cover.ts 的
// cover() 与 patcher.maybeCoverOpen。
describe('遮罩在 open 一开始就盖上（推翻「甲」）', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('编辑器里还是上一篇笔记时也当场涂上 —— 读盘那段不再留给旧画面', async () => {
		const { state, leaf, viewContent } = makeHarness({ cover: () => false });

		// 读盘那几百 ms：旧写法（甲）在这里把上一篇留在屏幕上 —— 可真机上它读起来就是
		// 「上一篇闪一下」。现在遮罩当场涂上（屏幕上直接是笔记背景），而**这一刻**就是
		// 「读者看得见」的起点。
		expect(viewContent.style.opacity).toBe('0');
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.cover.appliedAt(leaf)).toBeDefined();
		// 而恢复流水线的闸门照旧关着 —— 编辑器里还是上一篇，谁也不许碰它。
		expect(state.cover.contentArrived(leaf)).toBe(false);

		// 每帧重施不会把「读者看得见」的时刻往后推（上界是一条绝对时刻）。
		const appliedAt = state.cover.appliedAt(leaf);
		await vi.advanceTimersByTimeAsync(300);
		expect(state.cover.appliedAt(leaf)).toBe(appliedAt);
	});

	it('闸门迟迟不开时照旧有界收口 —— 遮罩不会永远赖着', async () => {
		const { state, modes, view } = makeHarness({ cover: () => false });

		const done = modes.restoreInjectedSource(view, RECORD, () => true);
		// 闸门一直关着（新内容迟迟不来）：恢复流水线等它有界（DOC_READY_MAX_MS），到点照走。
		await vi.advanceTimersByTimeAsync(DOC_READY_MAX_MS + 500);
		await done;

		// 共享收口照跑，而遮罩也从它那条路上揭掉（读者不会永远被遮着）。
		expect(state.lastAnchorAt).toBeGreaterThan(0);
		expect(state.cover.isCovered(view.leaf)).toBe(false);
	});
});

describe('跨文件打开：编辑器上还是上一篇笔记时谁也不许动', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('新内容没进编辑器之前不居中 —— 落在旧文档上的那一次等于作废', async () => {
		const start = Date.now();
		const arrivedAt = start + 200;
		let scroll = 10;
		// 闸门由 patcher 在武装时装好（这里用一个开关代替，见本文件头部）：跨文件打开时
		// core 要异步读盘，那几百 ms 里编辑器握着的还是上一篇笔记。
		const { state, modes, view } = makeHarness({
			cover: () => Date.now() >= arrivedAt,
			scroll: () => scroll,
		});
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };
		const intoView = vi.fn(() => { scroll = 42; });
		(view.editor as unknown as { scrollIntoView: unknown }).scrollIntoView = intoView;
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);

		const done = modes.restoreInjectedSource(view, RECORD, () => true);
		await vi.advanceTimersByTimeAsync(100);
		// 文档还没换进来：一次都不许派发（此刻派发的 scrollIntoView 行号会被夹进旧文档的
		// 范围，回读到的也是旧文档的滚动 —— 这一次居中于是完全作废）。这一段屏幕上留着的
		// 还是上一篇笔记，所以等待不产生空白。
		expect(intoView).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		await done;
		expect(intoView).toHaveBeenCalledTimes(1);
		// 落点用居中后回读到的那一个，不是记录里、也不是按行数估的种子。
		expect(settle.mock.calls[0][1]).toBe(42);
	});

	it('新内容一直没进来时干脆不居中 —— 退回种子，不拿旧文档赌一次落点', async () => {
		const { state, modes, view } = makeHarness({ cover: () => false, scroll: () => 10 });
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };
		const intoView = vi.fn();
		(view.editor as unknown as { scrollIntoView: unknown }).scrollIntoView = intoView;
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);

		const done = modes.restoreInjectedSource(view, RECORD, () => true);
		await vi.advanceTimersByTimeAsync(2000);
		await done;

		// 一次落在旧文档上的居中比不居中更糟（它的滚动 effect 可能在交换之后才被应用，把视口
		// 甩到任意位置），所以到点就放弃居中，让按行数估的种子兜着。而遮罩照旧从它那条路上
		// 有界收口（open 一开始就盖上 ⇒ 短盖照跑，到 deadline 揭掉 —— 读者不会被永远遮着）。
		expect(intoView).not.toHaveBeenCalled();
		expect(settle).toHaveBeenCalledTimes(1);
		expect(state.lastAnchorAt).toBeGreaterThan(0);
	});
});

describe('点名一行的居中：编辑器晚一步挂上（丙）', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('编辑器晚到几帧就等它 —— 早先会静默跳过、落点退回按行数估的种子', async () => {
		// 这一步**确实**点名了一行（标记在、文件对得上、没过期），只是编辑器还没接上这个原语
		// （视图还在建 / 刚换完文档 —— `MarkdownView.editor` 是 getter，这一刻是 undefined）。
		// 早先 namedLineAsk 把这件「还没就位」和「根本没有要点名的行」混成一个 undefined ⇒
		// centerNamedLine 直接放弃居中，落点退回按行数估的种子：用户看到的就是「位置完全不确定，
		// 有时不在屏内」。等它几帧即可。
		let scroll = 10;
		const { state, modes, view } = makeHarness({ scroll: () => scroll });
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };
		const intoView = vi.fn(() => { scroll = 42; });
		// 编辑器这一刻摸不到那个原语。
		const editor = view.editor as unknown as { scrollIntoView?: unknown };
		delete editor.scrollIntoView;
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);

		const done = modes.restoreInjectedSource(view, RECORD, () => true);
		await vi.advanceTimersByTimeAsync(0);
		// 编辑器还没就位：一次都不许派发。
		expect(intoView).not.toHaveBeenCalled();

		// 编辑器挂上了：剩下那几帧里有界地等，就能补上这次居中。
		editor.scrollIntoView = intoView;
		await vi.advanceTimersByTimeAsync(2000);
		await done;

		expect(intoView).toHaveBeenCalledTimes(1);
		// 落点用居中后回读到的那一个，不是按行数估的种子。
		expect(settle.mock.calls[0][1]).toBe(42);
	});

	it('编辑器一直不认那个原语时到点就放弃 —— 不拿旧文档赌一次', async () => {
		const { state, modes, view } = makeHarness({ scroll: () => 10 });
		state.pendingLineFlash = { path: 'a.md', line: 60, at: Date.now() };
		const editor = view.editor as unknown as { scrollIntoView?: unknown };
		delete editor.scrollIntoView;
		const settle = vi.spyOn(pixelsOf(modes), 'settleShortCover').mockResolvedValue(undefined);

		const done = modes.restoreInjectedSource(view, RECORD, () => true);
		await vi.advanceTimersByTimeAsync(2000);
		await done;

		// 等满那几帧仍没人接：落点退回种子（记录里的 scroll），照常走完。
		expect(settle.mock.calls[0][1]).toBe(RECORD.scroll);
		expect(state.lastAnchorAt).toBeGreaterThan(0);
	});
});
