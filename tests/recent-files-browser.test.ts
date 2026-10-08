// 最近文件浏览器那些纯部件的测试（src/recent-files/browser/）：行的描述、行的归组、
// 筛选，以及「这一篇里有哪些小节被命中」。DOM 在这里不测；凡是读者会怀疑其正确性的
// 都是纯的。

import { describe, it, expect } from 'vitest';

import {
	describeNavEntry, baseName,
	badgeOf, displayName,
	duplicateNames, folderOf, pathLabel, ageLabel, ageOf,
} from '@/recent-files/browser/model';
import {
	groupByFile, matchedHeadings, matchesNavFilter, navSearchText, queryTokens,
} from '@/recent-files/browser/listing';
import { revealDelta } from '@/recent-files/browser/list';
import { headingTrailAtLine, headingsFromText, type HeadingRef } from '@/shared/headings';
import { t } from '@/i18n';
import { NavEntry } from '@/nav/entry';
import { EphemeralState } from '@/types';

const line = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });

// 一条**笔记**记录：这份列表持有的就是它（一次跳转被降级成访问，见 places.ts）。
const note = (path: string, stamp?: number): NavEntry =>
	({ kind: 'visit', path, leafId: 'leaf-1', t: stamp } as NavEntry);
const view = (type: string, extra: Partial<NavEntry> = {}): NavEntry =>
	({ kind: 'view', viewType: type, leafId: 'leaf-1', ...extra } as NavEntry);

describe('describeNavEntry', () => {
	it('一条访问显示它的名字，不带扩展名', () => {
		// "meeting-notes.md" 就是笔记 "meeting-notes"：后缀不是读者称呼它的一部分，
		// 而一个全是 markdown 的仓库会在每一行印出同样那两个字符（见 displayName）。
		const d = describeNavEntry(note('notes/project/a.md'));
		expect(d.name).toBe('a');
		// 一份记录不携带位置：行号是位置数据库的事。
		expect(d.lineIndex).toBeUndefined();
	});

	it('笔记按读者自己配的属性来称呼，没配就用文件名', () => {
		// `titleOf` 是仓库的应答，不是这个模型的：读者在设置里命名的一个属性（见
		// reads.ts）。它的 **undefined** 是轮到文件名，而不是缺席 —— 一篇没有那个
		// 属性的笔记并非无名。
		const entry = note('notes/a.md');
		expect(describeNavEntry(entry, undefined, () => '每周回顾').name).toBe('每周回顾');
		expect(describeNavEntry(entry, undefined, () => undefined).name).toBe('a');
		// 完全没有名字读取器是平常情形：那是这个存在之前模型的做法。
		expect(describeNavEntry(entry).name).toBe('a');
	});

	it('一行的落点就是位置数据库对一次普通打开的回答', () => {
		// 一份记录不携带位置，所以这一行的「我刚才在哪儿」是别处存下来的那条 ——
		// 也正是这一行的点击与预览都瞄准的那个数字。
		const saved = (): EphemeralState => ({ scroll: 41, cursor: line(99) });
		expect(describeNavEntry(note('a.md'), saved).lineIndex).toBe(99);
		// 记录里没有光标时退回存下来的顶行。
		expect(describeNavEntry(note('a.md'), () => ({ scroll: 7 })).lineIndex).toBe(7);
		// 什么都没存下时是「没有」，而不是一个编出来的 0。
		expect(describeNavEntry(note('a.md')).lineIndex).toBeUndefined();
	});

	it('连自己名字都没有的无路径视图退回兜底，并且不带位置', () => {
		const graph = describeNavEntry(view('graph'));
		expect(graph.name).toBe(t('recentFiles.graphView'));
		expect(graph.lineIndex).toBeUndefined();
	});

	it('视图按它自己的标签取名，没有标签的退回兜底', () => {
		// 视图自己的名字就是读者在它里面时它标签页标题所说的（见 NavView.label），
		// 所以一行 Thino 说 "Thino"，而本列表不必认识那个插件；一个从没给自己命名的
		// 视图，若是图谱就得到本列表的措辞，否则得到它光秃秃的类型（见 viewName）。
		expect(describeNavEntry(view('thino_view', { label: 'Thino' })).name).toBe('Thino');
		expect(describeNavEntry(view('thino_view')).name).toBe('thino_view');
	});
});

// 列表的**行**：一篇笔记一行。一条记录不携带位置，所以没有东西要归组到它下面 ——
// 这正是「一篇被打开十次的笔记是一行」的原因（见 listing.ts 的 NavFileGroup）。
describe('groupByFile', () => {
	it('同一篇笔记的多次访问聚成一行，最新的在前', () => {
		const entries = [note('a.md', 1000), note('b.md', 2000), note('a.md', 3000)];
		const groups = groupByFile(entries, 0);

		expect(groups.map(g => g.path)).toEqual(['a.md', 'b.md']);
		// ……而这一行由它**最新**的那条记录代表：那是它的新鲜度、它的 leaf，也是它
		// 打印的那一份。
		expect(groups[0].rep).toBe(2);
	});

	it('读者所在的那一行带着标记，但位置仍由新鲜度给', () => {
		// 「你在这里」是行上的一个标记（见 NavFileGroup.current），绝不是顺序里的
		// 一个位置：a.md 是正被读的笔记、也是两者里**较新**的那个；换过来试也一样。
		const entries = [note('a.md', 1000), note('b.md', 2000)];
		const groups = groupByFile(entries, 0);

		expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md']);
		expect(groups[1].current).toBe(true);
		expect(groups[0].current).toBe(false);
	});

	it('当前这篇没通过筛选时，把它那一行整行丢掉', () => {
		// `keep` 是那个查询。一篇没有任何存活记录的笔记不是本列表的事，无论是不是
		// 当前那篇。
		const entries = [note('a.md', 1000), note('b.md', 2000)];
		expect(groupByFile(entries, 1, i => i === 0).map(g => g.path)).toEqual(['a.md']);
	});

	it('无路径视图（关系图谱）是它自己的一行，排在它自己的新鲜度上', () => {
		// 一个视图是读者去过的地方，所以它拿走它的时间给它的位置 —— 若被钉在列表
		// 的一端，它就会是一处其时间被顺序无视的地点。
		const groups = groupByFile([note('a.md', 1000), view('graph', { t: 9000 })], 0);

		expect(groups.map(g => g.path)).toEqual(['', 'a.md']);
		// 一个视图没有 path，所以它的**身份**是它的类型 —— 那正是它这一行的 key。
		expect(groups[0].key).toBe('view:graph');
	});

	// 一个**被按住的顺序**：列表正在展示的序列，交回给它，好让一次重画不重排读者
	// 正读的东西（见 RecentFilesList 的 `order` 选项）。这些 key 是各行的身份，不
	// 是它们的下标 —— 下标才是重画即将改的东西。
	describe('一个被按住的顺序', () => {
		// 最新的在**最后**，按地点列表保存它们的样子：a、b、c 是最旧在前，所以新鲜
		// 度顺序是倒过来的。
		const three = [note('a.md', 1000), note('b.md', 2000), note('c.md', 3000)];

		it('每个组都拿到它被按住所用的那个键', () => {
			const groups = groupByFile([view('graph', { t: 9000 }), ...three], 0);

			// 一个文件就是它的路径。图谱**不能**是：它的路径是空的 NO_PATH，那说了
			// 它无路径，却没说它是哪个视图。
			expect(groups.map(g => g.key)).toEqual(['c.md', 'b.md', 'a.md', 'view:graph']);
		});

		it('保持给定的先后，不把当前这篇拽到最前面', () => {
			// 当前那一组是 a.md。新鲜度把它钉在最后（见上面的测试）；被按住的顺序
			// 不许这么做，因为那个钉正是读者点击后会看到的那一跳：他们点的那篇笔记
			// 就是移动的那一篇。
			const groups = groupByFile(three, 0, undefined, ['b.md', 'a.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md', 'c.md']);
			// 读者仍被告知他们在哪儿 —— 标记不是那个顺序。
			expect(groups.find(g => g.path === 'a.md')?.current).toBe(true);
		});

		it('这个顺序没听过的笔记排最前，被按住的那些排在它后面', () => {
			// 一个在顺序被取走之后才出现的行，按新鲜度是最新的地点，所以它去最前 ——
			// 那正是新被访问的笔记该在的地方 —— 而读者正看着的那些笔记保住自己的
			// 位置。
			const entries = [...three, note('d.md', 4000)];
			const groups = groupByFile(entries, 0, undefined, ['a.md', 'b.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['d.md', 'a.md', 'b.md', 'c.md']);
		});

		it('顺序里没点名的笔记按它们自己的新旧排', () => {
			const entries = [...three, note('d.md', 4000)];
			const groups = groupByFile(entries, 0, undefined, ['b.md']);

			// d、c 和 a 都没被听过，而新鲜度是 d、c、a：排序是稳定的，所以它们保持
			// 那个顺序，在被按住的那一篇笔记之前。（浏览器里被按住的顺序是整个列表，
			// 所以一行只有刚出现时才没被听过 —— 见上面的测试。）
			expect(groups.map(g => g.path)).toEqual(['d.md', 'c.md', 'a.md', 'b.md']);
		});

		it('视图行没被按住时按新旧排，被按住时按给定顺序排', () => {
			const entries = [view('graph', { t: 9000 }), ...three];
			const held = groupByFile(entries, 1, undefined, ['view:graph', 'a.md']);
			const free = groupByFile(entries, 1, undefined);

			// 自由时：按新鲜度，而图谱在这里是**最老**的步，所以它凭自己的资格排在
			// 最后 —— 没有任何东西把它放那里（见 groupByFile）。
			expect(free.map(g => g.path)).toEqual(['c.md', 'b.md', 'a.md', '']);
			// 被按住时：图谱是顺序第一个点名的，而它从没听过的那些笔记（b、c）排在
			// 它认识的一切之前。被按住的顺序是读者的，视图也算在内。
			expect(held.map(g => g.path)).toEqual(['c.md', 'b.md', '', 'a.md']);
		});

		it('什么都没按住时就只看新旧，别的都不算', () => {
			// 让默认值保持诚实的那个回归：undefined 什么都不按住，所以列表就是各行
			// 自己的新鲜度 —— 当前笔记也算在内。
			expect(groupByFile(three, 0, undefined, undefined).map(g => g.path))
				.toEqual(['c.md', 'b.md', 'a.md']);
		});
	});
});

// 浏览器的过滤框：各个词按 AND 跨条目记下的一切匹配（名字、path、视图类型与名字），
// 再加上**调用方**从 vault 派生的一切（文件的其它名字，以及**该文件的全部标题**）。
// 没有 DOM，也没有 describeNavEntry：这个谓词可以单独测。
describe('matchesNavFilter', () => {
	it('空串或只有空白的查询匹配一切', () => {
		expect(matchesNavFilter(note('notes/a.md'), '')).toBe(true);
		expect(matchesNavFilter(note('notes/a.md'), '   ')).toBe(true);
	});

	it('文件名与完整路径都参与匹配，不分大小写', () => {
		const e = note('notes/project/Alpha.md');
		expect(matchesNavFilter(e, 'alpha')).toBe(true);
		expect(matchesNavFilter(e, 'PROJECT')).toBe(true);
		expect(matchesNavFilter(e, 'beta')).toBe(false);
	});

	it('每个用空白分开的词都得命中（AND）', () => {
		const e = note('notes/project/Alpha.md');
		expect(matchesNavFilter(e, 'alpha project')).toBe(true);
		expect(matchesNavFilter(e, 'alpha missing')).toBe(false);
	});

	it('无路径视图按它的类型、它自己的名字、以及本列表的措辞参与匹配', () => {
		expect(matchesNavFilter(view('graph'), 'graph')).toBe(true);
		expect(matchesNavFilter(view('graph'), t('recentFiles.graphView'))).toBe(true);
		expect(matchesNavFilter(view('graph'), 'canvas')).toBe(false);

		// 视图自己的名字也可搜：它是一个不知道视图**类型**的读者会打的那个词
		// （见 navSearchText）。
		expect(matchesNavFilter(view('thino_view', { label: 'Memos' }), 'memos')).toBe(true);
		expect(matchesNavFilter(view('thino_view', { label: 'Memos' }), 'thino_view')).toBe(true);
	});

	it('笔记正文不参与搜索（2026-10-03 撤掉 st.context）', () => {
		// 落点下方那几行正文曾是这个搜索面唯一「按内容找笔记」的能力，而是几周前的
		// 一次快照、无词边界的子串匹配还会把 `pro` 命中 `approve`。它撤掉了，替代品
		// 是各标题从 metadataCache 现查（见 navSearchText 的说明）。
		// 这条锁住**替换后**的形状：一个纯 visit 记录身上没有任何正文字段可搜。
		const e = note('notes/a.md');
		expect(matchesNavFilter(e, '死区')).toBe(false);
		expect(matchesNavFilter(e, '换行')).toBe(false);
	});

	it('重映射锚点不进搜索面', () => {
		// `st.anchor` 记的是采集那一刻**视口顶行**的文本：窗口高度与滚动位置一变，
		// 同一个落点的它就换一句（换台设备更是必然不同），而且它常常落在标题**之上**、
		// 是上一段的尾巴 ⇒ 它答的不是「这个地方叫什么」。它作为字段留着（文本变动后
		// 靠它找回行号是恢复路径的事），但不该让一行因为它而出现在列表上。
		const e = { ...note('notes/a.md'), st: { anchor: '落点这一行' } } as NavEntry;
		expect(matchesNavFilter(e, '落点')).toBe(false);
		expect(navSearchText(e)).not.toContain('落点这一行');
	});

	it('匹配调用方从 vault 派生的一切：文件的其它名字', () => {
		// 别名是最清楚的一例 —— 用一个读者隐约记得的名字找到一篇笔记，就是搜索框
		// 在这里的全部理由（见 matchesNavFilter 的 `extra`）。
		const e = note('notes/a.md');
		expect(matchesNavFilter(e, '每周回顾')).toBe(false);
		expect(matchesNavFilter(e, '每周回顾', '每周回顾 · 周报')).toBe(true);
	});

	it('全篇标题是**调用方**给的第四个参数，不在条目自己的文字里', () => {
		// 这是「这一篇里有个叫『定价』的小节」那档搜索面：它现查自标题缓存（体积与笔记长度
		// 无关、永远是最新的），而 navSearchText 是只看得见条目自己的纯函数。
		const e = note('notes/a.md');
		expect(matchesNavFilter(e, '定价')).toBe(false);
		expect(matchesNavFilter(e, '定价', undefined, '背景\n定价策略\n落地')).toBe(true);
		// 而 AND 的口径不变：每一个词都得在**某一处**命中。
		expect(matchesNavFilter(e, '定价 落地', undefined, '背景\n定价策略\n落地')).toBe(true);
		expect(matchesNavFilter(e, '定价 结算', undefined, '背景\n定价策略\n落地')).toBe(false);
		// 这个纯谓词**不**判断调用方该不该给全篇标题（那是 list.ts 的 outlineAt 的责任
		// —— 开关关掉时它对每一行都是「没有」）：它拿到的就是 haystack 的一部分。
		expect(matchesNavFilter(view('graph'), 'graph', undefined, undefined)).toBe(true);
	});
});

describe('queryTokens', () => {
	it('按空白切成小写的词，空串一个也不留', () => {
		expect(queryTokens('  定价  策略 ')).toEqual(['定价', '策略']);
		expect(queryTokens('')).toEqual([]);
		expect(queryTokens('ALPHA')).toEqual(['alpha']);
	});
});

// 「这一篇里有哪些小节被命中」的答案。它们**各画成一行**（见 list.ts 的 headingRow），
// 所以这里的次序就是读者看见的次序：顺着笔记往下，与它们被访问的先后无关。
describe('matchedHeadings', () => {
	const outline: HeadingRef[] = [
		{ heading: '面板设计', level: 1, line: 0 },
		{ heading: '呈现方案', level: 2, line: 10 },
		{ heading: '预览', level: 2, line: 20 },
		{ heading: '设计原则', level: 1, line: 30 },
	];

	it('就是容得下整个查询的那些标题，按文档顺序', () => {
		expect(matchedHeadings(outline, '预览', 5).map(h => h.heading)).toEqual(['预览']);
		// 一个站住一个标题上的短语，那是读者通常打的东西。
		expect(matchedHeadings(outline, '呈现 方案', 5).map(h => h.heading)).toEqual(['呈现方案']);
	});

	it('一次命中多个时全给，仍按文档顺序', () => {
		// 这是大纲行存在的全部理由：一个「只说第一个、却点去第一个」的行，正是这套
		// 测试要挡住的那个不自证。
		expect(matchedHeadings(outline, '设计', 5).map(h => h.heading))
			.toEqual(['面板设计', '设计原则']);
	});

	it('两个词散落在不同标题里时，退回携带**第一个**词的那些', () => {
		// 过滤器是拿拼起来的整块匹配的（见 matchesNavFilter），所以没有哪个标题携带
		// 整个查询 —— 而一个那时什么都不说的行，会是一个靠魔法匹配上的行。第一个词
		// 是读者最先打出来的那个，所以它是最可能指着他想要的那一节的那个。
		expect(matchedHeadings(outline, '预览 设计', 5).map(h => h.heading)).toEqual(['预览']);
		// ……认的是**第一个**词、不是「任一」词，所以两档绝不混：一个既给「面板设计」
		// 又给「呈现方案」的列表，答的是两个不同的问题。
		expect(matchedHeadings(outline, '呈现 设计', 5).map(h => h.heading)).toEqual(['呈现方案']);
	});

	it('给了 `limit` 就截到那么多个；省掉它就是**全都交出来**', () => {
		// 一篇两百个小节的笔记不该把列表撑爆（见 constants.ts 的 OUTLINE_HIT_LIMIT）——
		// 但截到几个是**调用方**的取舍：只有它知道自己还欠一句「截掉了几个」（见
		// list.ts 的 hitsFor 与 hiddenHits），而那个数要拿全部命中来算。
		const many: HeadingRef[] = Array.from({ length: 8 }, (_, i) =>
			({ heading: `第${i}节`, level: 1, line: i }));
		expect(matchedHeadings(many, '第', 5)).toHaveLength(5);
		expect(matchedHeadings(many, '第', 0)).toEqual([]);
		expect(matchedHeadings(many, '第')).toHaveLength(8);
	});

	it('没有标题、没有查询、或那个词不在任何标题里时都是空', () => {
		// 答空的几种情形，调用方都必须**什么都不画**：一行可能靠它的名字、path 或别名
		// 匹配上，而那些每一个都已经印在行上 —— 再说一遍是噪音。
		expect(matchedHeadings(undefined, '预览', 5)).toEqual([]);
		expect(matchedHeadings([], '预览', 5)).toEqual([]);
		expect(matchedHeadings(outline, '', 5)).toEqual([]);
		expect(matchedHeadings(outline, '   ', 5)).toEqual([]);
		expect(matchedHeadings(outline, '没写过的词', 5)).toEqual([]);
	});

	it('不分大小写，跟匹配它的那个筛选一致', () => {
		expect(matchedHeadings(outline, 'YUlan', 5)).toEqual([]);
		expect(matchedHeadings(outline, '预览', 5).map(h => h.heading)).toEqual(['预览']);
	});

	it('带着那一节**此刻**所在的行号 —— 行靠它去那儿', () => {
		expect(matchedHeadings(outline, '呈现', 5)[0].line).toBe(10);
	});
});

describe('folderOf / duplicateNames', () => {
	it('给出路径所在的文件夹，vault 根就是 "/"', () => {
		expect(folderOf('a/b/c.md')).toBe('a/b');
		expect(folderOf('root.md')).toBe('');
		// 一个无路径的行（视图）没有文件夹可印
		expect(folderOf('')).toBeUndefined();
	});

	// 它数的是**印出来的**那些名字，调用方已经解析过了：一个名字可能来自文件，也
	// 可能来自读者命名的属性，而它是哪一个不是这个问题的事。
	it('报出来的正是那两个被重复印的名字', () => {
		expect([...duplicateNames(['index', 'index', 'notes'])]).toEqual(['index']);
		expect(duplicateNames(['a', 'b']).size).toBe(0);
	});

	it('两行印出同一个名字就算撞名', () => {
		// 撞名讲的是屏幕上有什么，而屏幕上是不带扩展名的名字："x.md" 和 "x.canvas"
		// 是同一个词两次，所以两者都印出文件夹。（徽标不同 —— 那是眼睛落到正确的那
		// 一对行之后区分它们的东西 —— 但两行都读作 "x" 仍是读者无法在其间选择的
		// 两行。）
		expect([...duplicateNames(['x', 'x'])]).toEqual(['x']);
		// ……而印出不同名字的两篇笔记不撞名，无论它们的文件怎么叫。
		expect(duplicateNames(['a']).size).toBe(0);
	});
});

describe('baseName', () => {
	it('取路径最后一段；没有分段时就是路径本身', () => {
		expect(baseName('notes/deep/a.md')).toBe('a.md');
		expect(baseName('a.md')).toBe('a.md');
	});
});

// 说出笔记**在哪儿**的那一行，也是说出它是**哪个文件**的那一行 —— 两者要么一起
// 作答，要么都不作答（见 PathDisplayMode）。
describe('pathLabel', () => {
	it('没有路径的行一个字也不印', () => {
		// 一个视图没有文件、也不印文件夹；列表从不问（见 fileRow 自己的守卫），而
		// 这就是「没有路径」的意思，不是一个错误。
		expect(pathLabel('', 'Graph view')).toBe('');
	});

	it('行自己的名字就是文件名时，印的是文件夹', () => {
		expect(pathLabel('notes/deep/a.md', 'a')).toBe('notes/deep/');
		// 根也要算上：是 "/" 而不是空，空会被读成「没印」。
		expect(pathLabel('a.md', 'a')).toBe('/');
	});

	it('名字是借来的（取自属性）时，印出完整路径', () => {
		// 行的名字格那时唱的是笔记的 frontmatter，所以只印文件夹会留下一行，对它是
		// 哪篇笔记什么都说不出来。
		expect(pathLabel('notes/deep/a.md', '每周回顾')).toBe('notes/deep/a.md');
		expect(pathLabel('a.md', '每周回顾')).toBe('a.md');
	});
});

// 一行印出的笔记名字是什么（见 displayName / badgeOf）：路径最后一段去掉扩展名，
// 而类型另说。两者是一对 —— 每个不带扩展名印出的名字要么是 markdown（无徽标）
// 要么被标了 —— 而这些规则之所以闭合，全靠这一点。
describe('displayName / badgeOf', () => {
	it('印出不带扩展名的名字', () => {
		expect(displayName('notes/deep/a.md')).toBe('a');
		expect(displayName('a.md')).toBe('a');
		// 扩展名只算**最后**那一个：一个名字可能自己带点。
		expect(displayName('archive.tar.gz')).toBe('archive.tar');
		// ……而**开头**的点不是扩展名：那就是整个名字。
		expect(displayName('.gitignore')).toBe('.gitignore');
		// 一个无路径的行（视图）没有名字可缩短；列表从不问（它的名字是翻译过的视图
		// 标签），而这就是「没有路径」的意思。
		expect(displayName('')).toBe('');
	});

	it('除 markdown 之外的每种类型都加标记，没有类型的也加', () => {
		// Markdown 没有徽标：在一个仓库里它是没被标的那种默认，而每一行都挂个徽标
		// 会是一列噪音。
		expect(badgeOf('a.md')).toBeUndefined();
		expect(badgeOf('notes/a.MD')).toBeUndefined();
		// 其他每一样都说出它是什么。
		expect(badgeOf('report.PDF')).toBe('PDF');
		expect(badgeOf('board.canvas')).toBe('CANVAS');
		// 一个没有扩展名的文件照样得到徽标，否则「没有徽标」会意味着两件不同的
		// 事。
		expect(badgeOf('LICENSE')).toBe('FILE');
		expect(badgeOf('.gitignore')).toBe('FILE');
		// **文件夹**里的一个点不是文件里的扩展名。
		expect(badgeOf('notes.v2/readme')).toBe('FILE');
		expect(badgeOf('notes.v2/readme.md')).toBeUndefined();
		// 无路径的行是一个视图，不是一个文件：它没有类型。
		expect(badgeOf('')).toBeUndefined();
	});
});

// 一行**有多旧**（见 ageOf / ageLabel）：一个扫着找「我刚在哪儿」的读者据以比较各行的
// 量级，说得紧凑，用的却是不必读者解码的词。列表**本来**就是这个顺序 —— 标签加的是
// 标尺，不是顺序 —— 所以边界才是要紧的，而它们正是这里钉住的东西。
describe('ageOf / ageLabel', () => {
	const at = 1_000_000_000_000;
	const ago = (ms: number) => ageLabel(at, at + ms);
	const SECOND = 1000;
	const MINUTE = 60 * SECOND;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	it('一律向下取整，标签不会说出比实际更长的时间', () => {
		expect(ago(59 * SECOND)).toBe('now');
		// ……而单位恰好在边界处变，不早一刻。
		expect(ago(60 * SECOND)).toBe('1m ago');
		expect(ago(59 * MINUTE)).toBe('59m ago');
		expect(ago(60 * MINUTE)).toBe('1h ago');
		expect(ago(23 * HOUR)).toBe('23h ago');
		expect(ago(24 * HOUR)).toBe('1d ago');
		expect(ago(6 * DAY)).toBe('6d ago');
		expect(ago(7 * DAY)).toBe('1w ago');
		// 五周是周数不再有用的地方：4w 是最后一个按周的标签，从那里起由月接
		// 手。
		expect(ago(34 * DAY)).toBe('4w ago');
		expect(ago(35 * DAY)).toBe('1mo ago');
		expect(ago(364 * DAY)).toBe('12mo ago');
		expect(ago(365 * DAY)).toBe('1y ago');
		expect(ago(800 * DAY)).toBe('2y ago');
	});

	it('戳落在未来就夹到「现在」', () => {
		// 一个往回走了的时钟 —— 一台从睡眠中醒来的机器、两台同步的设备 —— 不许印
		// "-3m"，那读起来像列表里的 bug 而不是一个走错的时钟。
		expect(ageLabel(at, at - 3 * MINUTE)).toBe('now');
		expect(ageOf(at, at - 3 * MINUTE)).toEqual({ n: 0, unit: 'now' });
	});

	it('只说数字、单位和「前」，别的什么都不说', () => {
		// 单位是该**语言环境**对它用的词（测试桩是英文的，见 obsidian-stub.ts），
		// 而标签保持是一个扫视目标：没有日期、没有括号。
		expect(ageOf(at, at + 90 * MINUTE)).toEqual({ n: 1, unit: 'h' });
		expect(ageLabel(at, at + 90 * MINUTE)).toBe('1h ago');
	});
});

// 一个大纲行说出它**在这篇笔记的哪里**：两个同名的小节只靠名字是分不开的，而这一行
// 点下去去的就是链末端那一个。
describe('headingTrailAtLine', () => {
	const h = (heading: string, level: number, line: number) => ({ heading, level, line });

	it('按层级嵌套，最外层在前，到那一行为止', () => {
		const headings = [h('A', 1, 0), h('B', 2, 10), h('C', 3, 20), h('D', 2, 30)];
		expect(headingTrailAtLine(headings, 25)).toEqual(['A', 'B', 'C']);
		expect(headingTrailAtLine(headings, 10)).toEqual(['A', 'B']);
		// 一个同级或更浅的标题会关掉更深的那些
		expect(headingTrailAtLine(headings, 35)).toEqual(['A', 'D']);
	});

	it('第一个标题之上、以及全文没有标题时都是空', () => {
		expect(headingTrailAtLine([h('A', 1, 5)], 4)).toEqual([]);
		expect(headingTrailAtLine(undefined, 4)).toEqual([]);
	});
});

// ……以及从笔记自己的文本里取到的同一个解读 —— 当元数据缓存对这篇笔记无话可说
// 时，行就是从那里得到它的链（见 reads.ts）：一次同步替换了它，或者 app 还没重新
// 解析它，而在手机上这两者在笔记被打开时都不会结束。
describe('headingsFromText', () => {
	it('读出 ATX 标题以及它所在的那一行', () => {
		expect(headingsFromText('# 面板设计\n\n## 呈现方案\n\n正文\n'))
			.toEqual([
				{ heading: '面板设计', level: 1, line: 0 },
				{ heading: '呈现方案', level: 2, line: 2 },
			]);
	});

	it('命名与 metadata 缓存给出的那一节相同', () => {
		// 这个兜底的要点：它必须是**同一个**解读，否则行会在 app 还没解析笔记时说一
		// 件事，在解析之后又说另一件。
		const text = '# A\n\n## B\n\n正文\n\n### C\n';
		expect(headingsFromText(text)).toEqual([
			{ heading: 'A', level: 1, line: 0 },
			{ heading: 'B', level: 2, line: 2 },
			{ heading: 'C', level: 3, line: 6 },
		]);
		expect(headingTrailAtLine(headingsFromText(text), 4)).toEqual(['A', 'B']);
	});

	it('标签、注释、属性值里读不出标题', () => {
		// `#标签` 是 app 的**标签**之一；围栏里的一个 `#` 是某人 shell 脚本里的一行；`title: # 1`
		// 是一个 frontmatter 的**值**。对一个按 `#` 切分的读法来说，这三者都成了小节，而那一行
		// 就会指认一个并不存在的小节 —— 比一个都不指认更糟。
		expect(headingsFromText('#标签\n')).toEqual([]);
		expect(headingsFromText('```bash\n# 安装\n```\n')).toEqual([]);
		expect(headingsFromText('---\ntitle: # 1\n---\n# 真的标题\n'))
			.toEqual([{ heading: '真的标题', level: 1, line: 3 }]);
	});

	it('闭式标题收掉结尾那几个标记，只有开头标记的那种跳过', () => {
		expect(headingsFromText('## 一 ##\n#\n'))
			.toEqual([{ heading: '一', level: 2, line: 0 }]);
	});
});

describe('revealDelta', () => {
	// 一个 28px 的行在一个 200px 高的列表里，从 y=100 到 y=300：一行不在列表上时
	// 被带到的中间位置是 100 + (200 - 28) / 2 = 186。
	const box = { top: 100, height: 200 };

	it('行只要还有一部分在列表里，就一个像素也不滚', () => {
		// 悬停一行绝不许挪动读者正据以阅读的那个视图，而列表内部的一个步也不许挪
		// 动它 —— 包括紧贴列表底部的那一行。
		expect(revealDelta(150, 28, box.top, box.height)).toBeUndefined();
		expect(revealDelta(100, 28, box.top, box.height)).toBeUndefined();
		expect(revealDelta(272, 28, box.top, box.height)).toBeUndefined();
	});

	it('离开列表的行被带回列表中间，不管它是从哪一边离开的', () => {
		// 不是让行回到视野的最小滚动：那会把它停在紧贴边缘处，而走位随后会在一个
		// 永不移动的标记底下滚动列表。
		expect(revealDelta(320, 28, box.top, box.height)).toBe(134); // 320 → 中间
		expect(revealDelta(60, 28, box.top, box.height)).toBe(-126); // ……以及从上方
	});

	it('比列表还高的行让它居中，而不是硬塞进去', () => {
		// 这条规则讲的是行的中间，而一个列表容纳不下的行没有能装下它的滚动：中间
		// 是展示它最多的一处位置。
		expect(revealDelta(0, 200, 0, 100)).toBe(50);
	});
});
