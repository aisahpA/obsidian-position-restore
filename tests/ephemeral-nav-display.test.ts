// 两级读取拆分（ephemeral.ts）的测试：热读取（readEphemeralState）只携带位置 ——
// 100ms 轮询与恢复时的校验/重落循环每一拍、每一帧都在跑它，所以它绝不能付
// doc-string 读取或布局的代价 —— 而导航读取（readNavEntryState / withNavDisplay）
// 组装一步**携带**的那些字段：视口 anchor 与文件的 mtime。
//
// 落点的**文字**是第三级（landingContext），由**一次**读取（readLandingState）读 ——
// 就是记录落点的那一次。别的读取都不为它们付钱：那些 doc 读取不付，光标可见性检查
// 逼出来的布局也不付。那些文字是这一行**被搜索**所依据的东西；而它把读者带到了哪一
// 行，由 jump 自己的 key 来说。

import { describe, it, expect } from 'vitest';

import { MarkdownView } from 'obsidian';
import {
	landingContext, readEphemeralState, readLandingState, readNavEntryState, readSampledState, withNavDisplay,
} from '@/position/capture/ephemeral';
import { EphemeralState, NavEntryState } from '@/types';

// 一个 cm 桩：1-based 的 line(n) 落在偏移 (n-1)*10 处；`to` 界定被渲染的偏移范围。
// coordsAtPos 把一个偏移映射到一个客户端 top（乘 2）；滚动盒是 [100, 700)，所以一条
// 被渲染的行，其 top 落在 100..700 之内就算在屏幕上，别的都算屏幕外。
function makeCm(opts: { viewport: { from: number; to: number }; coordsTop?: number; hidden?: boolean }) {
	return {
		state: { doc: { lines: 1000, line: (n: number) => ({ from: (n - 1) * 10 }) } },
		viewport: opts.viewport,
		scrollDOM: {
			getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 0, right: 800 }),
			// null = 不在布局里（一个藏起来的标签页）—— 这是实时读取唯一答不出来的情形。
			offsetParent: opts.hidden ? null : ({} as unknown as HTMLElement),
		},
		coordsAtPos: () => (opts.coordsTop === undefined ? null : { top: opts.coordsTop }),
		defaultLineHeight: 20,
	};
}

// 一个假的 markdown 视图：真实原型链（instanceof）加上读取恰好触到的那点表面。
// getMode 只在被要求时才挂上（一个光秃秃的类视图对象必须能活着 —— 模式采集戳是可选
// 调用的）。getScroll 原样透传：显式的 null 用来走一遍「渲染器没追上」那道守卫。
function makeView(opts: {
	scroll?: number | null;
	cursorLine?: number;
	mode?: 'source' | 'preview';
	lines?: string[];
	cm?: ReturnType<typeof makeCm>;
	// 文件的 mtime，用于记下的那个「自那时起写过」的采集戳
	mtime?: number;
}): MarkdownView {
	const lines = opts.lines ?? [];
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		currentMode: { getScroll: () => opts.scroll },
		getMode: opts.mode ? () => opts.mode : undefined,
		file: opts.mtime === undefined ? undefined : { path: 'a.md', stat: { mtime: opts.mtime } },
		editor: {
			getCursor: () => ({ line: opts.cursorLine ?? 0, ch: 0 }),
			getLine: (n: number) => lines[n] ?? '',
			lastLine: () => lines.length - 1,
			cm: opts.cm,
		},
	}) as MarkdownView;
	return view;
}

const cursor = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });

// 给某次落点的那几句话，按读者会看到它们的那个状态。
function words(view: MarkdownView, st: EphemeralState = { scroll: 1, cursor: cursor(0) }): NavEntryState {
	return { ...st, ...(landingContext(view, st) ?? {}) };
}

// 这一行被搜索所依据的东西：记在落点**下面**的那些行。
const below = (st: NavEntryState | undefined): string[] | undefined => st?.context;

describe('readEphemeralState —— 热读取只取位置', () => {
	it('一个导航显示字段都不带，即便视图给得出', () => {
		const view = makeView({ scroll: 42.3, cursorLine: 3, mode: 'source', lines: ['a', 'b', 'c', 'd'] });
		expect(readEphemeralState(view)).toEqual({
			scroll: 42,
			cursor: cursor(3),
		});
	});
});

// 滚动采集的那次读取是**唯一**允许取用 app 自己那份每标签页缓存的：填上它的那次滚动在
// 监听器触发时早就跑完了，而一个不在布局里的窗格没有 scrollTop 可量。别的每一次读取都
// 量 DOM。
describe('readSampledState —— 上一次位置的读法', () => {
	it('优先用缓存的 scroll，而不是实时量', () => {
		const view = Object.assign(
			makeView({ scroll: 10, cursorLine: 686, mode: 'source', lines: ['x'] }),
			{ scroll: 680.59 },
		);

		expect(readSampledState(view)).toEqual({ scroll: 681, cursor: cursor(686) });
	});

	// 一个从没滚过的标签页、一次切模式、一次重载：缓存是 null，而实时量一下总好过压根没有
	// 位置。
	it('标签页还没有缓存时退到实时读取', () => {
		const view = makeView({ scroll: 42.3, cursorLine: 3, mode: 'source', lines: ['x'] });

		expect(readSampledState(view)).toEqual({ scroll: 42, cursor: cursor(3) });
	});
});

// 一步携带的是它能被重新找回来的 anchor、以及它的文字被取走时的 mtime —— 而没有文字。
// 栈会把每一步落盘，所以写在某一步上的一段文字，会被存下来给一个永远看不到它的读者。
describe('readNavEntryState —— 一步带着什么', () => {
	it('加上视口 anchor 与 mtime，但不带落点的文字', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', 'viewport line', 'x', 'cursor line'],
			cm, mtime: 1_730_000_000_000,
		});

		const st = readNavEntryState(view);

		expect(st).toEqual({
			scroll: 1,
			cursor: cursor(3),
			// anchor 属于视口顶部 —— 一条陈旧记录据以重新换算的那一行，也是这里唯一有功能的字段。
			anchor: 'viewport line',
			mtime: 1_730_000_000_000,
		});
		expect(st).not.toHaveProperty('context');
	});

	// 一条分割线按文字算是一个合法的 anchor，按本性却是个没用的：重换算扫描从记录的那一行
	// 朝外找，而在一篇有几条分割线的笔记里它会找到另一条。所以像空行一样处理 —— 不记
	// anchor，于是行号自己站得住或站不住。
	it('视口顶行是一条分割线时不记 anchor', () => {
		for (const rule of ['---', '***', '___']) {
			const view = makeView({
				scroll: 1.2, cursorLine: 3, mode: 'source',
				lines: ['top', rule, 'x', 'cursor line'],
				cm: makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 }),
				mtime: 1_730_000_000_000,
			});
			expect(readNavEntryState(view)?.anchor).toBeUndefined();
		}
	});

	it('列表项照样记 anchor —— 只有光秃秃的分割线才丢掉', () => {
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', '- a list item', 'x', 'cursor line'],
			cm: makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 }),
			mtime: 1_730_000_000_000,
		});
		expect(readNavEntryState(view)?.anchor).toBe('- a list item');
	});

	it('热读取是 undefined 时也是 undefined（渲染器没追上）', () => {
		const view = makeView({ scroll: null as unknown as number, cursorLine: 3 });
		expect(readNavEntryState(view)).toBeUndefined();
	});

	// 一个堆叠的标签页组只把它的活动标签页留在布局里：藏起来的那个滚动容器 scrollTop 读出来
	// 是 0，于是实时读取会对一个身处 680 行以下的读者说「文件顶部」，而离开时那次刷新就把
	// 那个顶部存成了他们的位置。仍然知道实情的是 Obsidian 自己那份每标签页缓存 —— 而 anchor
	// 必须取自那一行，不是那个假的。
	it('标签页不在布局里时用缓存的 scroll', () => {
		const lines: string[] = Array.from({ length: 700 }, (_, i) => (i === 681 ? 'deep line' : 'x'));
		lines[10] = 'top line';
		const view = Object.assign(makeView({
			scroll: 10, cursorLine: 686, mode: 'source', lines,
			cm: makeCm({ viewport: { from: 0, to: 100 }, hidden: true }),
		}), { scroll: 680.59 });

		const st = readNavEntryState(view);

		expect(st?.scroll).toBe(681);
		expect(st?.anchor).toBe('deep line');
	});

	// 可见的视图继续量 DOM：一次应用了的恢复会把**被索要**的值写进那份缓存，所以在这里信它，
	// 就等于把那个请求当作读者的位置回声回来。
	it('视图在布局里时保留实时读取，有缓存也不管', () => {
		const view = Object.assign(makeView({
			scroll: 10, cursorLine: 686, mode: 'source', lines: Array.from({ length: 700 }, () => 'x'),
			cm: makeCm({ viewport: { from: 0, to: 100 } }),
		}), { scroll: 680.59 });

		expect(readNavEntryState(view)?.scroll).toBe(10);
	});
});

// 一次采集落在**哪一行**决定这扇窗口从哪开始，而它上面一个字都不取 —— 所以记下来的东西
// 说的就是当时敲定的那一行。这里经由文字而不是经由一个盖了戳的索引来钉：落点**所在**的
// 那一行该由 jump 的 key 来说（见 nav/entry.ts 的 landedLine），而文字永远只回答
// 「它下面站着什么」。
describe('landingContext —— 这扇窗口从哪一行开始', () => {
	const lines = Array.from({ length: 12 }, (_, i) => `L${i}`);
	const after = (n: number) => [`L${n + 1}`, `L${n + 2}`, `L${n + 3}`, `L${n + 4}`];

	it('光标行在屏幕上时就从光标行开始（源码模式）', () => {
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 300 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(3));
	});

	it('光标行根本没被渲染时就从视口顶行开始', () => {
		// 第 4 行（1-based）落在偏移 30 处；被渲染的范围到 25 为止。
		const cm = makeCm({ viewport: { from: 0, to: 25 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(1));
	});

	it('光标的像素落在滚动盒之外时从视口顶行开始', () => {
		// 偏移 30 处的第 4 行渲染在视口之内；coordsAtPos 读出 top 60（偏移乘 2）—— 滚动盒从
		// 100 起，所以那一行位于盒子之上：被滚走了，在屏幕外。
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 60 });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(1));
	});

	it('拿不到编辑器视图时假定光标可见', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(3));
	});

	it('坐标还没量出来时假定光标可见', () => {
		const cm = makeCm({ viewport: { from: 0, to: 200 } });
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(3));
	});

	it('阅读模式的采集从视口顶行开始（进预览之前那个光标已经陈了）', () => {
		const view = makeView({ scroll: 1.2, cursorLine: 3, mode: 'preview', lines });

		expect(below(words(view, { scroll: 1, cursor: cursor(3) }))).toEqual(after(1));
	});

	it('记下的位置一个行号都没点名时为 undefined', () => {
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: ['a', 'b'] });

		expect(landingContext(view, {})).toBeUndefined();
	});
});

describe('landingContext —— 记下哪些文字', () => {
	it('只数非空行，到预算为止', () => {
		// 一行一句、中间隔空行（中文 markdown 笔记的寻常样子）：若照原样取四行，窗口会全花在
		// 空行上。
		const lines = [
			'# 标题', '', '第一段', '', '落点',
			'', '本节第一段', '', '本节第二段', '', '本节第三段', '', '本节第四段', '', '本节第五段',
		];
		const cm = makeCm({ viewport: { from: 0, to: 400 }, coordsTop: 300 });
		const view = makeView({ scroll: 4, cursorLine: 4, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 4, cursor: cursor(4) })))
			.toEqual(['本节第一段', '本节第二段', '本节第三段', '本节第四段']);
	});

	it('落点之上一行都不取 —— 那些字属于前面那一节', () => {
		// 每个落点都是一次标题跳转，而标题那一行正是它那一节**开始**的地方：上面的字属于前面
		// 那一节，而记录它们，正是从前让「搜那一节的字」把这行也捞上来的原因。
		const lines = ['上一节的正文', '', '## Beta', '本节第一段'];
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 300 });
		const view = makeView({ scroll: 2, cursorLine: 2, mode: 'source', lines, cm });

		expect(below(words(view, { scroll: 2, cursor: cursor(2) }))).toEqual(['本节第一段']);
	});

	it('落点之后只剩空行时为 undefined（标题就在末尾）', () => {
		const lines = ['a', 'b', '## Last', '', ''];
		const cm = makeCm({ viewport: { from: 0, to: 200 }, coordsTop: 300 });
		const view = makeView({ scroll: 2, cursorLine: 2, mode: 'source', lines, cm });

		expect(landingContext(view, { scroll: 2, cursor: cursor(2) })).toBeUndefined();
	});

	it('单行也有长度上限，免得一行一整段的笔记把列表撑爆', () => {
		const long = 'x'.repeat(500);
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: [long, long] });

		expect(below(words(view, { scroll: 0, cursor: cursor(0) }))?.[0]).toHaveLength(120);
	});

	it('行要 trim，记下的文字就是面板印出来的那些', () => {
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines: ['r0', '\t  缩进的段落  '] });

		expect(below(words(view, { scroll: 0, cursor: cursor(0) }))).toEqual(['缩进的段落']);
	});

	it('找非空行只看有限的距离（这趟读取必须便宜）', () => {
		// 越过那个界限它就什么都不记，而不是一路走过长长的一片空白、直到笔记末尾。
		const lines = ['落点', ...Array.from({ length: 400 }, () => '')];
		const view = makeView({ scroll: 0, cursorLine: 0, mode: 'source', lines });

		expect(below(words(view, { scroll: 0, cursor: cursor(0) }))).toBeUndefined();
	});
});

// 落点在它落定的那一刻被记录，而用来搜索它、引用它的那些文字，就在**同一次**读取里读：
// 这个 state 完整地到达两张列表，而栈在写一步时把它们留在身后。
describe('readLandingState —— 记录落点的那次读取', () => {
	it('等于一步带着的东西，再加上落点下面的文字', () => {
		const cm = makeCm({ viewport: { from: 0, to: 100 }, coordsTop: 300 });
		const view = makeView({
			scroll: 1.2, cursorLine: 3, mode: 'source',
			lines: ['top', 'viewport line', 'x', 'cursor line', 'a1', 'a2', 'a3', 'a4', 'a5'],
			cm, mtime: 1_730_000_000_000,
		});

		expect(readLandingState(view)).toEqual({
			scroll: 1,
			cursor: cursor(3),
			anchor: 'viewport line',
			mtime: 1_730_000_000_000,
			// 窗口从光标那一行（在屏幕上）开始，取它后面的东西。
			context: ['a1', 'a2', 'a3', 'a4'],
		});
	});
});

describe('withNavDisplay —— 在一个已有位置外面重建显示字段', () => {
	it('给基线加注解，但不改它', () => {
		const baseline: EphemeralState = { scroll: 500, cursor: cursor(101) };
		// 光标第 102 行（1-based）落在偏移 1010 处 —— 在被渲染的范围 [0, 500) 之外：这条基线是
		// 光标在屏幕外时读到的。
		const cm = makeCm({ viewport: { from: 0, to: 500 } });
		const lines = Array.from({ length: 1000 }, (_, i) => `L${i}`);
		const view = makeView({ mode: 'source', lines, cm });

		const st = withNavDisplay(view, baseline);
		expect(st).toEqual({
			scroll: 500,
			cursor: cursor(101),
			anchor: 'L500',
		});
		// 输入原封不动：这条基线是与轮询和数据库共享的，而之后的一次重建绝不能追溯地把一条
		// 记录翻过来。
		expect(baseline).toEqual({ scroll: 500, cursor: cursor(101) });
	});
});
