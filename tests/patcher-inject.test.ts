// OpenPatcher 里 setViewState 补丁那次「这是一次什么打开」判定的单元测试
// （injectEphemeralStateOnOpen）。这里钉住的逻辑 —— 每一条背后都有一次排查过的回归：
//  - 一次全新打开注入已存位置，并记下 leaf+file 这一对（预置已处理标记），好让那些
//    打开时从不触发 'file-open' 的对（后台打开、启动恢复）仍然能在之后的切换里去重；
//    带 scroll 的源码注入**同时预遮** leaf（遮罩只盖到编辑器给出真几何 —— 见
//    modes.ts 的 restoreInjectedSource）；只有光标、以及阅读类的注入不预遮；
//  - **遮罩在 open 一开始就盖上，两端一致**：旧写法（甲）在桌面上等新内容到了才遮、把读盘
//    那几百 ms 留给旧画面，可真机上它读起来是**上一篇闪一下**（文件不在内容缓存里时那次读盘
//    要走磁盘），2026-10-09 第十二轮之后被推翻；
//  - 但**「读者看得见这道遮罩」比「遮上去」晚**，且两端不是同一时刻：桌面上涂上就看得见；
//    手机端那一刻全屏的文件列表还盖着正文（原生列表、插件侧面板、对话框），要等新内容进
//    视图 —— 短盖的上界起点因此落在那一刻，见 restore-source-cover.test.ts 与
//    ui/cover.ts 的 markVisible；
//  - **回放**（对一个已处理过的 leaf+file 再发 setViewState）绝不能把 leaf 自己
//    缓存的 eState 当成 caller 目标来读 —— 那个误判会让这一对没被记下（下一次切换会
//    再恢复一次）；
//  - 回放只在被回放的 eState 与已存记录相符时才重新注入。一次不带 eState 的重申
//    （快速切换器再次选中当前文件：setViewState，后面没有 file-open）必须保持原生。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Platform } from 'obsidian';

import { OpenPatcher } from '@/position/restore/patcher';
import { PositionStore } from '@/position/storage/position-store';
import { PositionState } from '@/position/state';
import { TabStateRecord,DEFAULT_SETTINGS } from '@/types';
// leafStates 在 store 上是私有的；这就是那道测试接缝。
import { setLeafStates } from './support/position-store-seam';

// injectEphemeralStateOnOpen 是私有的；测试经由这个别名驱动它。
type ViewState = { type?: unknown; state?: { file?: unknown; mode?: unknown } };
type InjectFn = (
	leaf: WorkspaceLeaf,
	viewState: ViewState,
	eState: Record<string, unknown> | undefined,
) => unknown;

// OpenCover 经 Obsidian 对 HTMLElement 的 setCssStyles 扩展来给 leaf 的 DOM 加样式，
// 而 jsdom 缺这个。
beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, 'setCssStyles', {
		value(this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		},
		configurable: true,
		writable: true,
	});
});

function makeLeaf(id: string, containerEl: ParentNode = document.createElement('div')): WorkspaceLeaf & { containerEl: ParentNode } {
	return {
		id,
		containerEl,
	} as unknown as WorkspaceLeaf & { containerEl: ParentNode };
}

const RECORD = {
	scroll: 10,
	cursor: { from: { line: 10, ch: 0 }, to: { line: 10, ch: 0 } },
};
const SOURCE_OPEN_A = (file = 'a.md'): ViewState => ({
	type: 'markdown',
	state: { file, mode: 'source' },
});

beforeEach(() => {
	window.localStorage.clear();
});

let disposables: Array<() => void> = [];

function makeHarness(
	db: Record<string, unknown> = {},
	lastStateByLeaf: Map<string, TabStateRecord> = new Map(),
	layoutReady = true,
	// leaf 住在哪儿决定它是什么：默认是一个主区窗格，而讲「被浮层托着的 leaf」的测试会
	// 传自己的那个。
	leaf: WorkspaceLeaf & { containerEl: ParentNode } = makeLeaf('leaf-1'),
	// 假的 vault：只有讲「按内容认这一篇」的测试才需要（真机上是 `app.vault`）。
	// 不给时 `contentSwapGate` 的第二层判据缺席，闸门退回「文档对象换掉了没有」。
	vault: unknown = undefined,
) {
	const state = new PositionState(DEFAULT_SETTINGS);
	const app = {
		workspace: {
			layoutReady,
			// 主区 = 这个测试 leaf 所住的那个容器。
			rootSplit: { containerEl: { contains: (el: unknown) => el === leaf.containerEl } },
		},
		vault,
	} as never;
	const store = new PositionStore(app, { db } as never);
	// store 的构造函数会从存储里播下 leafStates；带预置映射的测试在构造之后替换它
	// （私有成员 → 走接缝 cast）。
	setLeafStates(store, lastStateByLeaf);
	const recordOpen = vi.fn();
	// patcher 是一个纯粹的**采集点**：它往漏斗里写，不读任何读取方，所以它需要的全套东西
	// 就是对它调用的那些探子。
	const funnel = { recordOpen, recordTeleport: vi.fn(), leave: vi.fn(), settled: vi.fn(), landing: vi.fn() };
	const flushOnLeave = vi.fn();
	const patcher = new OpenPatcher(app, DEFAULT_SETTINGS, store, state, funnel as never, { flushOnLeave } as never);
	const inject = (patcher as unknown as { injectEphemeralStateOnOpen: InjectFn }).injectEphemeralStateOnOpen.bind(patcher);
	disposables.push(() => state.cover.uncover(leaf));
	return { state, leaf, inject, flushOnLeave, recordOpen };
}

afterEach(() => {
	disposables.forEach((fn) => fn());
	disposables = [];
});

describe('OpenPatcher 对「这是一次什么打开」的判定', () => {
	it('一次全新打开注入已存位置、预遮 leaf，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		// 带 scroll 的源码注入预遮 leaf，而遮罩的出口在恢复那条路上（先等真几何）。
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('编辑器里还是上一篇笔记时也当场遮上 —— 读盘那段不再留给旧画面', () => {
		const containerEl = document.createElement('div');
		const viewContent = document.createElement('div');
		viewContent.className = 'view-content';
		containerEl.appendChild(viewContent);
		const leaf = makeLeaf('leaf-1', containerEl);
		const { state, inject } = makeHarness({ 'a.md': RECORD }, new Map(), true, leaf);
		// core 换文件时是这样：view.file 已经指向新文件，而**编辑器里**还是上一篇笔记的内容
		// （文档交换是异步的，文件越大越久）。关键在 data 与文档**是相符的**、而且**一起**换
		// （setData 先写 data 再 setViewData）—— 所以「两者相符」区分不出「换过了没有」：
		// 判据只能是**文档对象本身**换掉了（noteArrived）。
		const cm = { state: { doc: { length: 3, toString: () => 'old' } }, scrollDOM: document.createElement('div') };
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'old.md' },
			data: 'old',
			currentMode: { getScroll: () => 0 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }), cm },
		});
		(leaf as unknown as { view: unknown }).view = view;

		inject(leaf, SOURCE_OPEN_A(), undefined);

		// 遮罩**当场动手**：屏幕上那篇旧笔记这一帧就被藏起来（读者眼里是笔记背景）。⚠️ 旧写法
		// （甲）特意把读盘那段留给旧画面（「别把 I/O 等待伪装成加载」），可真机上它读起来是
		// **上一篇闪一下**（2026-10-09 第十二轮之后推翻）。
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.cover.appliedAt(leaf)).toBeDefined();
		expect(viewContent.style.opacity).toBe('0');

		// loadFile 往前走了一步：view.file 换成了新文件，而读盘还在进行 —— 编辑器里还是上一篇。
		// data 与文档此刻**相符**，正是这一点让「文档与 data 相符」区分不出换没换（所以闸门只
		// 认**文档对象本身**）。恢复那条路（modes.waitContentArrived）借的是同一段闭包：
		// 没换过来之前不许碰编辑器。
		(view as unknown as { file: { path: string } }).file = { path: 'a.md' };
		expect(state.cover.contentArrived(leaf)).toBe(false);

		// 读盘结束：core 把新笔记灌进编辑器 —— data 与文档**一起**换成新的。判据成立，
		// 此刻才允许碰编辑器。
		(view as unknown as { data: string }).data = 'new';
		cm.state.doc = { length: 3, toString: () => 'new' };
		expect(state.cover.contentArrived(leaf)).toBe(true);
	});

	it('手机端「读者看得见遮罩」要等新内容进视图 —— 列表还盖着正文时那道空白没人看见', () => {
		// 手机上点一个文件：原生文件列表、插件侧面板、对话框都是**全屏**盖住正文的。遮罩虽然
		// 也在 open 一开始就涂上（两端一致），可那一刻全屏列表还盖着正文 —— 读者什么都还没
		// 看见。于是上界起点（appliedAt）等新内容到位才记，否则读盘与列表收起动画会把短盖的
		// 预算白吃一截（见 ui/cover.ts 的 markVisible）。
		const containerEl = document.createElement('div');
		const viewContent = document.createElement('div');
		viewContent.className = 'view-content';
		containerEl.appendChild(viewContent);
		const leaf = makeLeaf('leaf-1', containerEl);
		const { state, inject } = makeHarness({ 'a.md': RECORD }, new Map(), true, leaf);
		const cm = { state: { doc: { length: 3, toString: () => 'old' } }, scrollDOM: document.createElement('div') };
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'old.md' },
			data: 'old',
			currentMode: { getScroll: () => 0 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }), cm },
		});
		(leaf as unknown as { view: unknown }).view = view;

		const wasPhone = Platform.isPhone;
		Platform.isPhone = true;
		try {
			inject(leaf, SOURCE_OPEN_A(), undefined);
		} finally {
			Platform.isPhone = wasPhone;
		}

		// 遮罩**当场动手**：屏幕上那篇旧笔记这一帧就被藏起来（读者眼里是笔记背景）—— 两端一致。
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(viewContent.style.opacity).toBe('0');

		// ⚠️ 但「**读者看得见**这道遮罩」还谈不上：那一刻全屏的文件列表还盖着正文，没人看见
		// 这段。上界起点（appliedAt）于是等新内容到位才记 —— 否则读盘会把短盖的预算白吃一截。
		// 而恢复流水线的闸门（contentArrived）照旧是关的：它靠的是同一条判据，与**遮罩动手的
		// 时机**是两回事（在上一篇的几何上居中、量像素都作废）。
		expect(state.cover.appliedAt(leaf)).toBeUndefined();
		expect(state.cover.contentArrived(leaf)).toBe(false);

		// 新内容真到了，判据才成立 —— 短盖这才开始量。
		(view as unknown as { data: string }).data = 'new';
		cm.state.doc = { length: 3, toString: () => 'new' };
		expect(state.cover.contentArrived(leaf)).toBe(true);
	});

	it('重放交回一个缺席的判据回来，也不能顶掉正在等新内容的那道闸门', () => {
		const containerEl = document.createElement('div');
		const viewContent = document.createElement('div');
		viewContent.className = 'view-content';
		containerEl.appendChild(viewContent);
		const leaf = makeLeaf('leaf-1', containerEl);
		const { state, inject } = makeHarness({ 'a.md': RECORD }, new Map(), true, leaf);

		// 第一次：屏幕上还是上一篇笔记 —— 遮罩当场涂上，闸门同时武装好（判据是「装进编辑器的
		// 是不是这一篇」）。
		const cm = { state: { doc: { length: 3, toString: () => 'old' } }, scrollDOM: document.createElement('div') };
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'old.md' },
			data: 'old',
			currentMode: { getScroll: () => 0 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }), cm },
		});
		(leaf as unknown as { view: unknown }).view = view;
		inject(leaf, SOURCE_OPEN_A(), undefined);
		expect(state.cover.isCovered(leaf)).toBe(true);

		// core 在同一个 leaf 上**重放** setViewState（未激活标签页的延迟重建、快速切换器
		// 再次选中当前文件）：这一刻 leaf 上那个视图握着的**就是**这次要打开的文件，
		// contentSwapGate 找不出「上一篇」的身份，只能交回**缺席**（undefined）—— 而缺席必须
		// **保住**上面那道仍在等新内容的闸门（`ready ?? existing?.ready`）。保住的话，恢复
		// 流水线照旧等到这篇内容真进编辑器；顶掉了（让恒真顶替），它立刻在**旧文档**的几何上
		// 开跑（居中、短盖量的都是像素）。
		(view as unknown as { file: { path: string } }).file = { path: 'a.md' };
		inject(leaf, SOURCE_OPEN_A(), { scroll: 10, cursor: RECORD.cursor });

		// 遮罩照旧盖着（重放属于同一次 open，不该被推迟），判据也照旧在等 —— 文档对象还是旧的。
		expect(viewContent.style.opacity).toBe('0');
		expect(state.cover.contentArrived(leaf)).toBe(false);

		// 新内容真到了：判据成立。
		(view as unknown as { data: string }).data = 'new';
		cm.state.doc = { length: 3, toString: () => 'new' };
		expect(state.cover.contentArrived(leaf)).toBe(true);
	});

	it('读不到编辑器时也绝不答「到了」—— 那等于把闸门直接打开', () => {
		// 「屏幕上本来就没有上一篇」（全新 leaf / 非 markdown / 同篇重放）与「有上一篇、但
		// 这一刻摸不到它的文档」是**相反**的两种情况，早先共用一个 undefined 出口 ⇒ 后者
		// 被当成前者、闸门直接打开：恢复流水线（居中、短盖量的都是像素）整条跑在**上一篇**的
		// 几何上 —— 那正是 2026-10-09 晚手机上「还是一样的」的形状。遮罩本身照旧在 open 一开始
		// 就涂上（两端一致），这里钉的是**闸门**。
		const containerEl = document.createElement('div');
		const viewContent = document.createElement('div');
		viewContent.className = 'view-content';
		containerEl.appendChild(viewContent);
		const leaf = makeLeaf('leaf-1', containerEl);
		const { state, inject } = makeHarness({ 'a.md': RECORD }, new Map(), true, leaf);
		// 编辑器这一刻摸不到（视图刚建出来 / 编辑器还没挂上）：editor 在，但拿不到 cm。
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'old.md' },
			data: 'old',
			currentMode: { getScroll: () => 0 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }) },
		});
		(leaf as unknown as { view: unknown }).view = view;

		inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(viewContent.style.opacity).toBe('0');
		// 旧内容还在（data 仍是 'old'）⇒ 没到，谁也不许碰编辑器。
		expect(state.cover.contentArrived(leaf)).toBe(false);

		// 内容换进来了（setData 写 data 与换文档是同一件事）：判据成立。
		(view as unknown as { data: string }).data = 'new';
		expect(state.cover.contentArrived(leaf)).toBe(true);
	});

	// 快速连点 A→B→C 的**中间那篇**：core 的 `FileView.loadFile` 只在自己入口比一次
	// `this.file === file`，`await onLoadFile(file)` 之后没有任何复核（2026-10-09 解包
	// obsidian.asar 实测）—— 所以 A 与 B 的读盘都可能晚于 C 回来、把中间那篇画上去。
	// 而「文档对象换掉了没有」只会答一次「换了」，**任何一个中间篇都满足它**：短盖于是
	// 在中间那篇上就揭幕了，随后晚到的那一篇一闪（用户报的「打开 C 时看见 A 的内容闪一下」）。
	// 闸门因此要按**内容**认「这一篇」。
	function raceHarness(contents: Record<string, string>) {
		const containerEl = document.createElement('div');
		containerEl.appendChild(document.createElement('div')).className = 'view-content';
		const leaf = makeLeaf('leaf-1', containerEl);
		const vault = {
			getAbstractFileByPath: (p: string) => (contents[p] !== undefined ? { path: p } : null),
			cachedRead: async (f: { path: string }) => contents[f.path],
		};
		const db = Object.fromEntries(Object.keys(contents).map((p) => [p, RECORD]));
		const { state, inject } = makeHarness(db, new Map(), true, leaf, vault);
		const cm = { state: { doc: { length: 3, toString: () => 'old' } }, scrollDOM: document.createElement('div') };
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'old.md' },
			data: 'old',
			currentMode: { getScroll: () => 0 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }), cm },
		});
		(leaf as unknown as { view: unknown }).view = view;
		// core 把一篇内容灌进编辑器：data 与文档**一起**换。
		const paint = (text: string) => {
			(view as unknown as { data: string }).data = text;
			cm.state.doc = { length: text.length, toString: () => text };
		};
		return { state, leaf, inject, paint };
	}

	it('快速连点 A→B→C：中间那篇被画出来时闸门不许开', async () => {
		const { state, leaf, inject, paint } = raceHarness({ 'a.md': 'A-CONTENT' });
		inject(leaf, SOURCE_OPEN_A(), undefined);
		await Promise.resolve(); // cachedRead 落定

		// B 的读盘先回来（用户连点时路过的那一篇）：文档对象换了，但内容不是 a.md 的 ——
		// 此刻揭幕，读者就会看见 B，然后才被 A 顶掉。
		paint('B-CONTENT');
		expect(state.cover.contentArrived(leaf)).toBe(false);

		// 真正要打开的那篇到了：这才许碰编辑器、也才轮到遮罩动手。
		paint('A-CONTENT');
		expect(state.cover.contentArrived(leaf)).toBe(true);
	});

	it('换了文件时，新武装的判据要顶掉旧的 —— 否则短盖会等在上一篇上', async () => {
		const { state, leaf, inject, paint } = raceHarness({ 'a.md': 'A-CONTENT', 'b.md': 'B-CONTENT' });
		// 先武装 a.md。
		inject(leaf, SOURCE_OPEN_A(), undefined);
		await Promise.resolve();
		// 紧接着点了 b.md（同一 leaf）：这次要等的是 **b.md** 的内容。
		inject(leaf, SOURCE_OPEN_A('b.md'), undefined);
		await Promise.resolve();

		// a.md 的内容到了也不许开闸 —— 它已经是上一篇了。
		paint('A-CONTENT');
		expect(state.cover.contentArrived(leaf)).toBe(false);

		paint('B-CONTENT');
		expect(state.cover.contentArrived(leaf)).toBe(true);
	});

	it('屏幕上就是同一篇（重放）时判据恒真 —— 没有别的笔记要等它让位', () => {		// 延迟重建的重放：leaf 上那个视图握着的**就是**这次要打开的文件，文档不会（也不该）
		// 再换一次 —— 判据要是还等一次「换文档」，这一次 open 会白等到上界，遮罩也永远不盖。
		const containerEl = document.createElement('div');
		containerEl.appendChild(document.createElement('div')).className = 'view-content';
		const leaf = makeLeaf('leaf-1', containerEl);
		const { state, inject } = makeHarness({ 'a.md': RECORD }, new Map(), true, leaf);
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		(leaf as unknown as { view: unknown }).view = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'a.md' },
			data: 'x',
			currentMode: { getScroll: () => 0 },
			editor: {
				getCursor: () => ({ line: 0, ch: 0 }),
				cm: { state: { doc: { length: 1, toString: () => 'x' } }, scrollDOM: document.createElement('div') },
			},
		});

		// 带上与记录一致的位置 —— 这才是那条会重新注入、重新遮住空档的重放。
		inject(leaf, SOURCE_OPEN_A(), { scroll: 10, cursor: RECORD.cursor });

		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.cover.contentArrived(leaf)).toBe(true);
	});

	it('打开时把正要离开的视图状态刷进记录（快速移动会丢数据的那个窗口）', () => {
		const { leaf, inject, flushOnLeave } = makeHarness();
		const leavingView = Object.assign(Object.create(MarkdownView.prototype), {
			file: { path: 'b.md' },
			currentMode: { getScroll: () => 2.6 },
			editor: { getCursor: () => ({ line: 0, ch: 0 }) },
		});
		(leaf as unknown as { view: unknown }).view = leavingView;

		inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(flushOnLeave).toHaveBeenCalledWith(leavingView, 'b.md', { scroll: 3 });
	});

	it('悬停浮层托着的 leaf 什么都不注入', () => {
		// 一个碰巧是可编辑窗格的预览仍然是预览：它在 app 打开预览的地方打开。在那里恢复会把
		// 卡片落到没人指过的行上，而随之而来的盖布会让卡片一直空着，直到落定为止。
		const popover = document.createElement('div');
		popover.className = 'hover-popover';
		const host = document.createElement('div');
		popover.appendChild(host);
		document.body.appendChild(popover);
		const { state, leaf, inject, recordOpen } =
			makeHarness({ 'a.md': RECORD }, undefined, true, makeLeaf('leaf-1', host));

		const result = inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(result).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		// 不是读者打开的窗格，所以也不是他们导航里的一步。
		expect(recordOpen).not.toHaveBeenCalled();
		popover.remove();
	});

	it('带 caller 目标（搜索命中）的全新打开让位给 core，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('只带着缓存 eState（启动时的原生缓存）的全新打开让位，并记下这一对', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		const eState = { scroll: 5 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('eState 与记录一致的回放，在盖布下重新注入', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { scroll: 10, cursor: RECORD.cursor };

		const result = inject(leaf, SOURCE_OPEN_A(), eState) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		// 重放（未激活标签页的延迟重建）也遮 —— 那次重建后面不跟 file-open 的恢复，
		// 遮罩是它唯一能藏住首绘的手段。
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		// 回放保住已处理标记，也不设 open kind：随后那次 file-open 必须走到注入过的正文里，
		// 而不是在 openKind 提前返回那里停住。
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('回放会清掉一次从未触发 file-open 的打开留下的陈旧 pending open kind', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		state.pendingOpenKind.set(leaf, 'callerTarget');
		const eState = { scroll: 10, cursor: RECORD.cursor };

		inject(leaf, SOURCE_OPEN_A(), eState);

		expect(state.pendingOpenKind.has(leaf)).toBe(false);
	});

	it('eState 为空的回放（快速切换器再次选中）保持原生行为', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A(), undefined);

		expect(result).toBeUndefined();
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});
	
	it('启动时带着没有位置的 eState 的回放（{focus:true} 重建）重新注入', () => {
		// 2026-09 排查过：在 layout-ready 之前，core 会用第二次 setViewState 重申**活动的**
		// leaf，它带的 eState 里只有 {focus:true} —— 重建后的编辑器丢掉注入的位置、落到顶部。
		// 在 layout-ready 之前，空的 eState 永远就是那次重建，所以已存位置必须再注入一次。
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD }, new Map(), false);
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A(), { focus: true }) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
		expect(state.cover.isCovered(leaf)).toBe(true);
		expect(state.injectedOpenLeafIds.has('leaf-1')).toBe(true);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('带 focus 的 caller 目标 eState，在启动回放时仍然让位', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD }, new Map(), false);
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { focus: true, cursor: { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } } };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
	});

	it('缓存位置已经与记录分叉的回放保持原生行为', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { scroll: 99 };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.cover.isCovered(leaf)).toBe(false);
		expect(state.handledLeafIdMap.get('leaf-1')).toBe('a.md');
	});

	it('回放仍然对真正的 caller 目标（命中）让位', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');
		const eState = { match: {} };

		const result = inject(leaf, SOURCE_OPEN_A(), eState);

		expect(result).toBe(eState);
		expect(state.pendingOpenKind.get(leaf)).toBe('callerTarget');
	});

	it('同一 leaf 上换了文件会重置已处理标记', () => {
		const { state, leaf, inject } = makeHarness({ 'a.md': RECORD });
		state.handledLeafIdMap.set('leaf-1', 'a.md');

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined);

		// b.md 没有记录，默认位置：没有什么可注入的。
		expect(result).toBeUndefined();
		expect(state.handledLeafIdMap.has('leaf-1')).toBe(false);
	});

	it('按标签页的记录胜过按文件的记录', () => {
		// 按文件的记录说是 scroll 10；而 Obsidian 退出时这个标签页在 scroll 99。
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A(), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 99 });
	});

	it('按标签页的记录盖不住 caller 目标', () => {
		const { leaf, inject } = makeHarness(
			{ 'a.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);
		const eState = { match: {} };

		expect(inject(leaf, SOURCE_OPEN_A(), eState)).toBe(eState);
	});

	it('文件已经变了的按标签页记录当作没有记录（路径守卫）', () => {
		const { leaf, inject } = makeHarness(
			{ 'b.md': RECORD },
			new Map([['leaf-1', { filePath: 'a.md', st: { scroll: 99 } }]]),
		);

		const result = inject(leaf, SOURCE_OPEN_A('b.md'), undefined) as Record<string, unknown>;

		expect(result).toMatchObject({ scroll: 10 });
	});

	it('侧边栏面板重新声明 state（大纲带着它所跟踪的文件）不算一次记录', () => {
		const { leaf, inject, recordOpen } = makeHarness();

		// 大纲面板重申自己的 view state，把所跟踪的文件放在 state.file 里；它的 leaf 不在主区
		// → 不记录。
		inject(
			makeLeaf('outline-leaf', document.createElement('aside')),
			{ type: 'outline', state: { file: 'a.md' } },
			undefined,
		);
		expect(recordOpen).not.toHaveBeenCalled();

		// 对照：一次主区的打开会记录。
		inject(leaf, SOURCE_OPEN_A(), undefined);
		expect(recordOpen).toHaveBeenCalledWith('a.md', 'leaf-1', { key: undefined, force: false });
	});

	it('带 key 的锚点链接保留它的 key', () => {
		const { state, leaf, inject, recordOpen } = makeHarness();
		state.pendingLinkText = 'b.md#安装步骤';

		inject(leaf, SOURCE_OPEN_A('b.md'), undefined);

		expect(recordOpen).toHaveBeenCalledWith('b.md', 'leaf-1', {
			key: 'b.md#安装步骤',
			force: false,
		});
	});
});
