// 最近文件浏览器那些纯部件的测试（src/recent-files/browser/）：行的描述、树的
// 分组/合流、筛选与章节链。DOM 在这里不测；凡是读者会怀疑其正确性的都是纯的。

import { describe, it, expect } from 'vitest';

import {
	describeNavEntry, rowTrail, dropsOuterLevel, baseName,
	badgeOf, displayName,
	duplicateNames, folderOf, pathLabel, ageLabel, ageOf, newestStamp,
} from '@/recent-files/browser/model';
import {
	groupByFile, matchedHeading, matchedOnlyByOutline, matchesNavFilter, navSearchText,
} from '@/recent-files/browser/listing';
import { revealDelta } from '@/recent-files/browser/list';
import { headingTrailAtLine, headingsFromText } from '@/shared/headings';
import { t } from '@/i18n';
import { NavEntry } from '@/nav/entry';
import { NavEntryState } from '@/types';

const line = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });

describe('describeNavEntry', () => {
	it('一条文件步显示它的名字，不带扩展名', () => {
		// "meeting-notes.md" 就是笔记 "meeting-notes"：后缀不是读者称呼它的一部分，
		// 而一个全是 markdown 的仓库会在每一行印出同样那两个字符（见 displayName）。
		const d = describeNavEntry({ kind: 'visit', path: 'notes/project/a.md', leafId: 'leaf-1' } as NavEntry);
		expect(d.name).toBe('a');
		expect(d.line).toBeUndefined();
		expect(d.lineIndex).toBeUndefined();
	});

	it('jump 的标题行从它自己的 KEY 读，而不是从它记录的位置读', () => {
		// 两个列表各自保留的每个落点都是一次标题 jump，而 key 的那个行号就是
		// metadataCache 放置那个标题的行（见 NavJump.keyLine）—— 它是权威的，而滚动
		// 只是视口顶、光标只是读者最后点击的地方。
		const d = describeNavEntry({
			kind: 'jump', path: 'a.md', leafId: 'l', key: 'outline:## H', keyLine: 17,
			st: { scroll: 42, cursor: line(99) },
		} as NavEntry);
		expect(d.line).toBe('L18');
		// 同一个落点的 0-based 下标：列表据以为地点编 key 的东西，也是章节链所据以
		// 查找的东西
		expect(d.lineIndex).toBe(17);
	});

	it('其它那种步的标题行从它记录的位置读', () => {
		// 没有结构性的东西可据以作答：一个跳变，它自己的目标行就是这次 jump 的；以及
		// 一个目标后来被改名改掉的 jump。
		const edit = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
			st: { scroll: 42, cursor: line(99), anchor: 'viewport top' },
		} as NavEntry);
		// 记下的视口顶，不是光标
		expect(edit.line).toBe('L43');
		expect(edit.lineIndex).toBe(42);
	});

	it('跳变一直没有落地时，退回记录下来的目标行', () => {
		const d = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
		} as NavEntry);
		expect(d.line).toBe('L42');
	});

	it('一条 visit 的行号退回视口顶行', () => {
		// 文件记录自身不携带位置，所以这一行显示的行号是位置库上次看见笔记时的样子。
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, cursor: line(3), anchor: 'viewport top' },
		} as NavEntry);
		expect(d.line).toBe('L42');
		expect(d.lineIndex).toBe(41);
	});

	it('既没有光标也没有引文，仍然显示视口那一行', () => {
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, anchor: 'viewport top' },
		} as NavEntry);
		expect(d.line).toBe('L42');
	});

	it('笔记按读者自己配的属性来称呼，没配就用文件名', () => {
		// `titleOf` 是仓库的应答，不是这个模型的：读者在设置里命名的一个属性（见
		// reads.ts）。它的 **undefined** 是轮到文件名，而不是缺席 —— 一篇没有那个
		// 属性的笔记并非无名。
		const entry = { kind: 'visit', path: 'notes/a.md', leafId: 'leaf-1' } as NavEntry;
		const named = describeNavEntry(entry, undefined, () => '每周回顾');
		expect(named.name).toBe('每周回顾');
		// ……而坐标还是同一个老问题，答法也一样。
		expect(named.line).toBeUndefined();

		const plain = describeNavEntry(entry, undefined, () => undefined);
		expect(plain.name).toBe('a');
		// 完全没有名字读取器是平常情形：那是这个存在之前模型的做法。
		expect(describeNavEntry(entry).name).toBe('a');
	});

	it('连自己名字都没有的无路径视图退回兜底，并且不带行号', () => {
		const graph = describeNavEntry({ kind: 'view', viewType: 'graph', leafId: 'leaf-1' } as NavEntry);
		expect(graph.name).toBe(t('recentFiles.graphView'));
		expect(graph.line).toBeUndefined();
		expect(graph.lineIndex).toBeUndefined();
	});

	it('视图按它自己的标签取名，没有标签的退回兜底', () => {
		// 视图自己的名字就是读者在它里面时它标签页标题所说的（见 NavView.label），
		// 所以一行 Thino 说 "Thino"，而本列表不必认识那个插件；一个从没给自己命名的
		// 视图，若是图谱就得到本列表的措辞，否则得到它光秃秃的类型（见 viewName）。
		const named = describeNavEntry(
			{ kind: 'view', viewType: 'thino_view', label: 'Thino', leafId: 'leaf-1' } as NavEntry,
		);
		expect(named.name).toBe('Thino');

		const unnamed = describeNavEntry(
			{ kind: 'view', viewType: 'thino_view', leafId: 'leaf-1' } as NavEntry,
		);
		expect(unnamed.name).toBe('thino_view');
	});

	it('没有记录位置的步，退回文件层存的那一条', () => {
		const d = describeNavEntry(
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1' } as NavEntry,
			() => ({ scroll: 41, cursor: line(99) }),
		);
		// 存下的光标那行就是重新打开时所恢复的地点
		expect(d.line).toBe('L100');
	});

	it('记录里没有光标时退回存下来的顶行', () => {
		const d = describeNavEntry(
			{ kind: 'visit', path: 'a.md', leafId: 'leaf-1' } as NavEntry,
			() => ({ scroll: 7 }),
		);
		expect(d.line).toBe('L8');
	});
});

// 列表的那棵树：每篇笔记一次，它的各落点在它之下。
describe('groupByFile', () => {
	// 一篇笔记的一个**落点**，按最近文件列表持有它的样子：读者做过的一次 jump。
	// 笔记自己的记录（`visit`）是这一组的锚点，根本不添加落点（见 listing.ts）——
	// 一个代表它的行会打开读者已经身处的文件，那正是看起来什么都没做的那一行。
	const spot = (path: string, i: number, line: number): NavEntry =>
		({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
	// 每个步落在的那一行，按浏览器解析它的方式解析（见 RecentFilesList.render）。
	// 这个纯函数按它**被告知**的东西分组：一个对行什么都不说的调用方等于在说一篇
	// 笔记的每个步都是同一处地点，那正是一个没有坐标的文件所拥有的（见
	// landingKey）。
	const lines = (entries: NavEntry[]) => (i: number) =>
		entries[i].kind === 'view' ? undefined : entries[i].st?.scroll;

	it('同一篇笔记的步聚成一组，组内最新的在前，笔记之间按新旧排', () => {
		const entries = [
			spot('a.md', 0, 10),
			spot('b.md', 1, 20),
			spot('a.md', 2, 400),
			spot('c.md', 3, 40),
		];
		const groups = groupByFile(entries, 3, undefined, lines(entries));

		expect(groups.map(g => g.path)).toEqual(['c.md', 'a.md', 'b.md']);
		// ……而在一篇笔记里，各行是**顺着笔记往下**出来的：L10 在 L400 之前，不是
		// 按它们被访问的顺序（见 groupByFile）。
		expect(groups.map(g => g.indices)).toEqual([[3], [0, 2], [1]]);
		expect(groups[0].current).toBe(true);
	});

	it('读者所在的那篇按它的新旧排，不拎到前面', () => {
		// 「你在这里」是行上的一个标记（见 NavFileGroup.current），绝不是顺序里的
		// 一个位置：a.md 是正被读的笔记、也是两者里**较老**的那个，所以它留着自己
		// 的时间给它排的地方 —— 第二。
		const entries = [spot('a.md', 0, 10), spot('b.md', 1, 20)];
		const groups = groupByFile(entries, 0);

		expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md']);
		expect(groups[1].current).toBe(true);
		expect(groups[0].current).toBe(false);
	});

	it('当前这篇里没有一样东西能通过筛选时，把它整组丢掉', () => {
		// `keep` 是那个查询。一篇没有任何存活步的笔记不是本列表的事，无论是不是当前
		// 那篇；空组的情形是笔记在那里但已没有东西可打开。
		const entries = [spot('a.md', 0, 10), spot('b.md', 1, 20)];
		const groups = groupByFile(entries, 1, i => i === 0);

		expect(groups.map(g => g.path)).toEqual(['a.md']);
	});

	it('无路径视图步（关系图谱）按它自己的时间排，跟笔记一样', () => {
		// 图谱在这里是**最新**的地点：store 列表上最后一个步就是最近的那个（见
		// places.ts）。一个视图是读者去过的地方，所以它拿走它的时间给它的位置 ——
		// 若停靠在列表的末尾，它就会是一处其时间被顺序无视的地点。
		const entries = [
			spot('a.md', 0, 10),
			{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 9000 } as NavEntry,
		];
		const groups = groupByFile(entries, 0);

		expect(groups.map(g => g.path)).toEqual(['', 'a.md']);
	});

	// **每一处地点都是一行**，无论下一个站得多近。相近的落点以前会被折进一行
	// （一个 LANDING_MERGE_LINES 窗口，现已移除）：那一行盖住其他成员却只印**一个**
	// 成员的行号，于是点击够不到它们、折叠在行不再印范围后变得无形，而
	// 「你在这里」的点可能坐在一行上，那一行的行号并不是读者所在之处。
	// 'all' 是读者要求这篇笔记里的每一处地点（见 NavFileGroup）。
	describe('每个标题各占一行', () => {
		const at = (path: string, i: number, line: number): NavEntry =>
			({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
		const lineOf = (entries: NavEntry[]) => (i: number) => {
			const entry = entries[i];
			return entry.kind === 'view' ? undefined : entry.st?.scroll;
		};

		it('相隔几行的几个落点各占一行，顺着笔记往下排', () => {
			const entries = [at('a.md', 0, 10), at('a.md', 1, 18), at('a.md', 2, 26)];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			// 三处地相隔八行，三行 —— L11 在 L19 之前、L19 在 L27 之前，不是按它们
			// 被访问的顺序（见 groupByFile）—— 而每一处就是点击它时落到的步。
			expect(groups[0].indices).toEqual([0, 1, 2]);
		});

		it('一行由它最新的那一步代表，读者自己那一步优先', () => {
			// 同一行上的两个步是一个落点（见 landingKey）。行打开其中最新的那个 ——
			// 读者在这一行里的最后一处 —— 除非**当前**条目与它共用这一行：那时槽位
			// 留读者自己的那个步，因为那才是「这里」必须点名的步。
			const entries = [at('a.md', 0, 10), at('a.md', 1, 12), at('a.md', 2, 12)];

			const newest = groupByFile(entries, 0, undefined, lineOf(entries));
			expect(newest[0].indices).toEqual([0, 2]);

			const current = groupByFile(entries, 1, undefined, lineOf(entries));
			expect(current[0].indices).toEqual([0, 1]);
			expect(current[0].currentRep).toBe(1);
			expect(current[0].current).toBe(true);
		});

		it('标记读者所在的那一行，没有任何标题兜住他时一个也不标', () => {
			// 这个点是读者正站着的那个已列出落点 —— 而笔记**自己的**记录不是一个落
			// 点，所以一个身处笔记却没有在里面跳过的读者没有行可标（见
			// NavFileGroup.currentRep）。
			const entries = [
				{ kind: 'visit', path: 'a.md', leafId: 'leaf-1', t: 500 } as NavEntry,
				at('a.md', 1, 18),
			];

			const onLanding = groupByFile(entries, 1, undefined, lineOf(entries));
			expect(onLanding[0].indices).toEqual([1]);
			expect(onLanding[0].currentRep).toBe(1);

			const onNote = groupByFile(entries, 0, undefined, lineOf(entries));
			expect(onNote[0].indices).toEqual([1]);
			expect(onNote[0].current).toBe(true);
			expect(onNote[0].currentRep).toBeUndefined();
		});

		it('自身没有行号的那个标题，与有行号的那些分开摆', () => {
			// 一个 `.base`、一张图片、一个位置从未解析出来的步：一处地点，而它无法
			// 靠近任何东西 —— 没有号码可供靠近。
			const entries = [
				at('a.md', 0, 400),
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:H1', t: 1400, st: {} } as NavEntry,
			];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			expect(groups[0].indices).toEqual([0, 1]);
		});
	});

	// 一篇笔记底下的各落点是**地点**，不是步（见 landingKey）：一个步落在的那一行
	// 是区分两者中任意两个的东西，而它作为解析器传入，因为一行所印的行号不总是条
	// 目自己的（一个没记录块的步会退回到文件的存盘位置）。
	describe('一个标题，无论有多少步到过它', () => {
		const at = (path: string, i: number, line: number): NavEntry =>
			({ kind: 'jump', path, leafId: 'leaf-1', key: `outline:H${i}`, t: 1000 + i * 100, st: { scroll: line } });
		const lineOf = (entries: NavEntry[]) => (i: number) => {
			const entry = entries[i];
			return entry.kind === 'view' ? undefined : entry.st?.scroll;
		};

		it('每行一行、按行号排序，在组里只占一个槽位', () => {
			const entries = [
				at('a.md', 0, 10),
				at('a.md', 1, 400),
				at('a.md', 2, 400),
				at('a.md', 3, 400),
			];
			const groups = groupByFile(entries, 3, undefined, lineOf(entries));

			// L400 被到达三次，由三个步：一个目的地。两个落点顺着笔记出来 —— L10
			// 在 L400 之前，无论它们被访问的顺序（见 groupByFile）。
			expect(groups[0].indices).toEqual([0, 3]);
		});

		it('由当前那一步代表它同在的这个标题', () => {
			// 当前条目必须被画成「这里」，而它可能比与它共用落点的那个步**更老**：
			// 槽位留读者自己的那个步，而不是去同一处地点的较新那个。
			const entries = [at('a.md', 0, 10), at('a.md', 1, 400), at('a.md', 2, 400)];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			expect(groups[0].indices).toEqual([0, 2]);
			expect(groups[0].current).toBe(true);
		});

		it('行号谁都答不出来的那些步排在最后，它们那一行写「—」', () => {
			// 一个没有行号的步无法被放进笔记自己的顺序里，所以它的落点站在那些放得
			// 进的之后 —— 它不是对**哪儿**的猜测，它是一个没有坐标的文件所拥有的那
			// 一个落点（见 landingKey）。
			const entries = [
				at('a.md', 0, 10),
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B1', t: 1000 } as NavEntry,
				at('a.md', 2, 400),
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B3', t: 1200 } as NavEntry,
			];
			const groups = groupByFile(entries, 0, undefined, lineOf(entries));

			expect(groups[0].indices).toEqual([0, 2, 3]);
		});

		it('行号谁都答不出来的那些步合并成一个标题', () => {
			// 同一个文件的两个步、之间没有坐标：一个 `.base` 视图、一个 PDF、一张
			// 图片 —— 一个里面无处可处的文件。它们是同一处地点，而最新的那个步就是
			// 代表它的那个（见 landingKey：这以前会把每个这样的步都留成它自己的一
			// 行，于是每次访问都印出同样一条「—」行）。
			const entries = [
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B1', t: 1000 } as NavEntry,
				{ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:B2', t: 1100 } as NavEntry,
			];
			const groups = groupByFile(entries, 1, undefined, () => undefined);

			// **一个**落点，而它就是读者**正站在**的那个步：当前条目自己的（这里两
			// 者里较新的那个）。
			expect(groups[0].indices).toEqual([1]);
		});

		it('同一个标签页上的图谱步坍成一个', () => {
			// 一个无路径的视图步不是笔记里的一处地点：这一组就是图谱标签页，而无
			// 论它被切过去多少次，它都是一个目的地。
			const entries = [
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 900 } as NavEntry,
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 1000 } as NavEntry,
			];
			const groups = groupByFile(entries, 1, undefined, () => undefined);

			// ……而它是这一组的**锚点**而不是它底下的一个落点：一个视图里面没有地
			// 点，而它自己那一行才是读者前往的那一行。
			expect(groups[0].indices).toEqual([]);
			expect(groups[0].anchor).toBe(1);
			expect(groups[0].current).toBe(true);
		});

		it('两篇笔记绝不合并，无论它们的行有多像', () => {
			// 坍缩是按笔记的，所以记在同一行的两篇笔记仍是两个目的地 —— 解析器从
			// 不跨组边界被问。
			const entries = [at('a.md', 0, 400), at('b.md', 1, 400)];
			const groups = groupByFile(entries, 1, undefined, lineOf(entries));

			expect(groups.map(g => g.indices)).toEqual([[1], [0]]);
		});
	});

	// 一个**被按住的顺序**：列表正在展示的序列，交回给它，好让一次重画不重排读者
	// 正读的东西（见 RecentFilesList 的 `order` 选项）。这些 key 是各组的身份，不
	// 是它们的下标 —— 下标才是重画即将改的东西。
	describe('一个被按住的顺序', () => {
		// 最新的在**最后**，按地点列表保存它们的样子：a、b、c 是最旧在前，所以新鲜
		// 度顺序是倒过来的。
		const three = [spot('a.md', 0, 10), spot('b.md', 1, 20), spot('c.md', 2, 30)];

		it('每个组都拿到它被按住所用的那个键', () => {
			const entries = [
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 9000 } as NavEntry,
				...three,
			];
			const groups = groupByFile(entries, 0);

			// 一个文件就是它的路径。图谱**不能**是：它的路径是空的 NO_PATH，那说了
			// 它无路径，却没说它是哪个视图。
			expect(groups.map(g => g.key)).toEqual(['c.md', 'b.md', 'a.md', 'view:graph']);
		});

		it('保持给定的先后，不把当前这篇拽到最前面', () => {
			// 当前那一组是 a.md。新鲜度把它钉在最前（见上面的测试）；被按住的顺序
			// 不许这么做，因为那个钉正是读者点击后会看到的那一跳：他们点的那篇笔记
			// 就是移动的那一篇。
			const groups = groupByFile(three, 0, undefined, lines(three), ['b.md', 'a.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['b.md', 'a.md', 'c.md']);
			// 读者仍被告知他们在哪儿 —— 标记不是那个顺序。
			expect(groups.find(g => g.path === 'a.md')?.current).toBe(true);
		});

		it('这个顺序没听过的笔记排最前，被按住的那些排在它后面', () => {
			// 一个在顺序被取走之后才出现的组，按新鲜度是最新的地点，所以它去最前 ——
			// 那正是新被访问的笔记该在的地方 —— 而读者正看着的那些笔记保住自己的
			// 位置。
			const entries = [...three, spot('d.md', 3, 40)];
			const groups = groupByFile(entries, 0, undefined, lines(entries), ['a.md', 'b.md', 'c.md']);

			expect(groups.map(g => g.path)).toEqual(['d.md', 'a.md', 'b.md', 'c.md']);
		});

		it('顺序里没点名的笔记按它们自己的新旧排', () => {
			const entries = [...three, spot('d.md', 3, 40)];
			const groups = groupByFile(entries, 0, undefined, lines(entries), ['b.md']);

			// d、c 和 a 都没被听过，而新鲜度是 d、c、a：排序是稳定的，所以它们保持
			// 那个顺序，在被按住的那一篇笔记之前。（浏览器里被按住的顺序是整个列表，
			// 所以一个组只有刚出现时才没被听过 —— 见上面的测试。）
			expect(groups.map(g => g.path)).toEqual(['d.md', 'c.md', 'a.md', 'b.md']);
		});

		it('视图组没被按住时按新旧排，被按住时按给定顺序排', () => {
			const entries = [
				{ kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 9000 } as NavEntry,
				...three,
			];
			const held = groupByFile(entries, 1, undefined, lines(entries), ['view:graph', 'a.md']);
			const free = groupByFile(entries, 1, undefined, lines(entries));

			// 自由时：按新鲜度，而图谱在这里是**最老**的步，所以它凭自己的资格排在
			// 最后 —— 没有任何东西把它放那里（见 groupByFile）。
			expect(free.map(g => g.path)).toEqual(['c.md', 'b.md', 'a.md', '']);
			// 被按住时：图谱是顺序第一个点名的，而它从没听过的那些笔记（b、c）排在
			// 它认识的一切之前。被按住的顺序是读者的，视图也算在内。
			expect(held.map(g => g.path)).toEqual(['c.md', 'b.md', '', 'a.md']);
		});

		it('什么都没按住时就只看新旧，别的都不算', () => {
			// 让默认值保持诚实的那个回归：undefined 什么都不按住，所以列表就是各地点
			// 自己的新鲜度 —— 当前笔记也算在内。
			const groups = groupByFile(three, 0, undefined, lines(three), undefined);

			expect(groups.map(g => g.path)).toEqual(['c.md', 'b.md', 'a.md']);
		});
	});
});

// 浏览器的过滤框：各个词按 AND 跨条目记下的一切匹配（名字、路径、落点的
// context 块、jump 的 key），再加上**行**印出的文本（章节链和行号标签），由调用方
// 传入。没有 DOM，也没有 describeNavEntry：这个谓词可以单独测。
describe('matchesNavFilter', () => {
	const visit = (path: string, st?: NavEntryState): NavEntry =>
		({ kind: 'visit', path, leafId: 'leaf-1', st } as NavEntry);

	it('空串或只有空白的查询匹配一切', () => {
		expect(matchesNavFilter(visit('notes/a.md'), '')).toBe(true);
		expect(matchesNavFilter(visit('notes/a.md'), '   ')).toBe(true);
	});

	it('文件名与完整路径都参与匹配，不分大小写', () => {
		const e = visit('notes/project/Alpha.md');
		expect(matchesNavFilter(e, 'alpha')).toBe(true);
		expect(matchesNavFilter(e, 'PROJECT')).toBe(true);
		expect(matchesNavFilter(e, 'beta')).toBe(false);
	});

	it('每个用空白分开的词都得命中（AND）', () => {
		const e = visit('notes/project/Alpha.md', { anchor: 'Chapter One' });
		expect(matchesNavFilter(e, 'alpha chapter')).toBe(false); // 锚点不进搜索面
		expect(matchesNavFilter(e, 'alpha project')).toBe(true);
		expect(matchesNavFilter(e, 'alpha missing')).toBe(false);
	});

	it('无路径视图按它的类型、它自己的名字、以及本列表的措辞参与匹配', () => {
		const e = { kind: 'view', leafId: 'leaf-1', viewType: 'graph' } as NavEntry;
		expect(matchesNavFilter(e, 'graph')).toBe(true);
		expect(matchesNavFilter(e, t('recentFiles.graphView'))).toBe(true);
		expect(matchesNavFilter(e, 'canvas')).toBe(false);

		// 视图自己的名字也可搜：它是一个不知道视图**类型**的读者会打的那个词
		// （见 navSearchText）。
		const thino = { kind: 'view', leafId: 'leaf-1', viewType: 'thino_view', label: 'Memos' } as NavEntry;
		expect(matchesNavFilter(thino, 'memos')).toBe(true);
		expect(matchesNavFilter(thino, 'thino_view')).toBe(true);
	});

	it('笔记正文不参与搜索（2026-10-03 撤掉 st.context）', () => {
		// 落点下方那 4 行正文曾是这个搜索面唯一「按内容找笔记」的能力，而它只有「按 key
		// 跳进某个标题」的落点带着（placeRecord/settle 只给 jump 写 st）、是几周前的一次
		// 快照、无词边界的子串匹配还会把 `pro` 命中 `approve`。它撤掉了，替代品是各标题
		// 从 metadataCache 现查（见 navSearchText 的说明）。
		// 这条锁住**替换后**的形状：一个纯 visit 记录身上没有任何正文字段可搜。
		const e = visit('notes/a.md');
		expect(matchesNavFilter(e, '死区')).toBe(false);
		expect(matchesNavFilter(e, '换行')).toBe(false);
	});

	it('匹配这一行印出来的东西：标题链和行号标签', () => {
		// 取自仓库的标题缓存而不是这个条目，所以由调用方传入（见
		// RecentFilesList.render）。
		const e = visit('notes/a.md');
		expect(matchesNavFilter(e, '架构设计', 'L412 总览 › 架构设计')).toBe(true);
		expect(matchesNavFilter(e, 'L412', 'L412 总览')).toBe(true);
		expect(matchesNavFilter(e, 'L999', 'L412 总览')).toBe(false);
	});

	it("匹配 jump 自己的 key：那个标题，或者用户点中的锚点", () => {
		const outline = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'outline:## 架构设计' } as NavEntry;
		expect(matchesNavFilter(outline, '架构设计')).toBe(true);
		const link = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'b.md#安装步骤' } as NavEntry;
		expect(matchesNavFilter(link, '安装步骤')).toBe(true);
	});

	it('全篇标题是**调用方**给的第四个参数，不在条目自己的文字里', () => {
		// 这是「这一篇里有个叫『定价』的小节」那档搜索面：它现查自标题缓存（体积与笔记长度
		// 无关、永远是最新的），而 navSearchText 是只看得见条目自己的纯函数。
		const e = visit('notes/a.md');
		expect(matchesNavFilter(e, '定价')).toBe(false);
		expect(matchesNavFilter(e, '定价', undefined, '背景\n定价策略\n落地')).toBe(true);
		// 而 AND 的口径不变：每一个词都得在**某一处**命中。
		expect(matchesNavFilter(e, '定价 落地', undefined, '背景\n定价策略\n落地')).toBe(true);
		expect(matchesNavFilter(e, '定价 结算', undefined, '背景\n定价策略\n落地')).toBe(false);
		// 这个纯谓词**不**判断调用方该不该给全篇标题（那是 list.ts 的 outlineOf 的责任）：
		// 它拿到的就是 haystack 的一部分。视图那一档由 outlineOf 直接给 undefined。
		const view = { kind: 'view', leafId: 'leaf-1', viewType: 'graph' } as NavEntry;
		expect(matchesNavFilter(view, 'graph', undefined, undefined)).toBe(true);
	});

	it('重映射锚点不进搜索面', () => {
		// `st.anchor` 记的是采集那一刻**视口顶行**的文本：窗口高度与滚动位置一变，
		// 同一个落点的它就换一句（换台设备更是必然不同），而且它常常落在标题**之上**、
		// 是上一段的尾巴 ⇒ 它答的不是「这个地方叫什么」。它作为字段留着（文本变动后
		// 靠它找回行号是恢复路径的事），但不该让一行因为它而出现在列表上。
		const e = visit('notes/a.md', { anchor: '落点这一行' });
		expect(matchesNavFilter(e, '落点')).toBe(false);
		// 词还在同一条记录上、只是那个字段不参与匹配 —— 这正是「字段留着、搜索不用」
		// 的形状（重映射仍要靠它找回行号）。
		expect(navSearchText(e)).not.toContain('落点这一行');
	});

	it('忽略调用方传来的目标 key：那是一串时间戳，不是词', () => {
		// 调用方目标的 jump（一次搜索结果点击）以 `caller:<ms>` 编 key，纯粹是为了
		// 走带名的落点那一档 —— 那里面没有任何用户写的东西。
		const e = { kind: 'jump', path: 'a.md', leafId: 'l', key: 'caller:1730000000000' } as NavEntry;
		expect(matchesNavFilter(e, '1730000000000')).toBe(false);
	});

});

describe('matchedHeading —— 命中的是哪一个标题', () => {
	// 「这一篇里有个叫『定价』的小节」这句话的答案。它答不出时调用方必须**什么都不说** ——
	// 一行可能靠名字、path、别名或它所在的那一节匹配上，而那些每一个都已经印在行上或一次
	// 悬停就能看到。
	const outline = '面板设计\n呈现方案\n预览\n尾巴';

	it('就是容得下整个查询的那一个标题', () => {
		expect(matchedHeading(outline, '预览')).toBe('预览');
		// 一个站住一个标题上的短语，那是读者通常打的东西。
		expect(matchedHeading(outline, '呈现 预览')).toBe('呈现方案');
	});

	it('几个词散落在不同标题里时，退回第一个词所在的那一个', () => {
		// 过滤器是拿拼起来的整块匹配的（见 matchesNavFilter），所以没有哪个标题携带整个
		// 查询 —— 而一个那时什么都不说的行，会是一个靠魔法匹配上的行。
		expect(matchedHeading(outline, '预览 尾巴')).toBe('预览');
	});

	it('没有标题、没有查询、或那个词不在任何标题里时都是 undefined', () => {
		expect(matchedHeading(undefined, '预览')).toBeUndefined();
		expect(matchedHeading(outline, '')).toBeUndefined();
		expect(matchedHeading(outline, '   ')).toBeUndefined();
		expect(matchedHeading(outline, '没写过的词')).toBeUndefined();
		// 一行靠它的**名字**匹配上、而那个词恰好不是任何标题 —— 保持沉默比编一句强。
		expect(matchedHeading('', 'Alpha')).toBeUndefined();
	});

	it('不分大小写，跟匹配它的那个筛选一致', () => {
		expect(matchedHeading('Alpha Beta\nGamma', 'ALPHA')).toBe('Alpha Beta');
	});
});

describe('matchedOnlyByOutline —— 这一行是不是**只**因为那个小节才在列表上', () => {
	// 它换来的是一次**改道**（见 list.ts 的 HeadingHit）：点击不再去这一行一贯去的地方，
	// 而去那个小节。所以这里的判据必须严 —— 一个既靠名字也靠标题进得来的行不该被改道：
	// 搜「周」找「周回顾」的读者，不该被送进「周报」。
	const entry = (path: string) => ({ kind: 'visit', path, leafId: 'leaf-1', t: 1 }) as NavEntry;

	it('拿掉全篇标题就进不来 ⇒ 是', () => {
		expect(matchedOnlyByOutline(entry('a.md'), '预览', '', '面板设计\n预览')).toBe(true);
	});

	it('靠名字就能进来 ⇒ 不是', () => {
		// 名字里就写着那个词：这一行在列表上不是因为那个小节。
		expect(matchedOnlyByOutline(entry('预览.md'), '预览', '预览', '面板设计\n预览')).toBe(false);
	});

	it('靠打印出来的别名进来 ⇒ 不是', () => {
		expect(matchedOnlyByOutline(entry('a.md'), '周回顾', '周回顾', '周报')).toBe(false);
	});

	it('一个词命中名字、另一个只命中标题 ⇒ 是（两个词都是必要的）', () => {
		// 查询的每个词都必须命中（见 matchesNavFilter）：名字给了「周回顾」、标题给了
		// 「周报」，缺哪一个这一行都进不来 —— 所以那个小节**是**它出现在这里的理由，
		// 何况那一节的名字是读者亲手打出来的。
		const e = entry('周回顾.md');
		expect(matchedOnlyByOutline(e, '周回顾 周报', '周回顾', '周报')).toBe(true);
	});

	it('没有全篇标题可给时 ⇒ 不是（落点行从不靠它活过过滤）', () => {
		expect(matchedOnlyByOutline(entry('a.md'), '预览', '', undefined)).toBe(false);
		// 一个连查询都没有的行也不该被问成「只靠标题」。
		expect(matchedOnlyByOutline(entry('a.md'), '', '', '预览')).toBe(false);
	});
});

describe('folderOf / duplicateNames', () => {
	it('给出路径所在的文件夹，vault 根就是 "/"', () => {
		expect(folderOf('a/b/c.md')).toBe('a/b');
		expect(folderOf('root.md')).toBe('');
		// 一个无路径的组（图谱）没有文件夹可印
		expect(folderOf('')).toBeUndefined();
	});

	// 它数的是**印出来的**那些名字，调用方已经解析过了：一个名字可能来自文件，也
	// 可能来自读者命名的属性，而它是哪一个不是这个问题的事。
	it('报出来的正是那两个被重复印的名字', () => {
		const doubles = duplicateNames(['index', 'index', 'notes']);
		expect([...doubles]).toEqual(['index']);
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
	it('没有路径的组一个字也不印', () => {
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
		// 一个无路径的组（图谱）没有名字可缩短；列表从不问（它的名字是翻译过的视图
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
		// 无路径的组是一个视图，不是一个文件：它没有类型。
		expect(badgeOf('')).toBeUndefined();
	});
});

// 一行**有多旧**（见 ageOf / ageLabel / newestStamp）：一个扫着找「我刚在哪儿」的
// 读者据以比较各行的量级，说得紧凑，用的却是不必读者解码的词。列表**本来**就是这个
// 顺序 —— 标签加的是标尺，不是顺序 —— 所以边界才是要紧的，而它们正是这里钉住的
// 东西。
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

describe('newestStamp', () => {
	const entry = (stamp?: number) => ({ kind: 'visit', path: 'a.md', leafId: 'l', t: stamp } as NavEntry);

	it('取这一组里最新的那个戳，不管它落在哪一步上', () => {
		// 锚点通常是笔记的最后一次 visit，但它可能在笔记内部做的那些 jump 存活时被
		// 逐出 —— 而一组的 `indices` 是按**行序**、不是按时间序（见 groupByFile），
		// 所以这个答案是关于它们全体的一个问题。
		const entries = [entry(10), entry(40), entry(30)];
		expect(newestStamp(entries, [2], 0)).toBe(30);
		// ……而且完全没有锚点时它照样作答。
		expect(newestStamp(entries, [0, 1], undefined)).toBe(40);
	});

	it('一组连一个戳都没有时是 undefined', () => {
		// 那时各行什么都不印，而不是印「现在」—— 后者是一个缺失的采集戳本来会
		// 被读成的东西。
		expect(newestStamp([entry(undefined)], [], 0)).toBeUndefined();
		expect(newestStamp([], [], undefined)).toBeUndefined();
		// 一条不在那里的记录什么都不贡献（也不抛）：锚点和一个下标都可能点名一个
		// 列表后来丢掉了的地点。
		expect(newestStamp([entry(5)], [7, 0], 7)).toBe(5);
	});
});

// 一个落点所在的章节：读者据以扫视的粗粒度索引，也是一行能在不读它所处文件的
// 情况下说出它的理由 —— 解析过的标题就够了。
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

describe('rowTrail', () => {
	it('只留最深的两层', () => {
		expect(rowTrail(['A', 'B', 'C'])).toEqual(['B', 'C']);
		expect(rowTrail(['A'])).toEqual(['A']);
	});

	it('保留落点所在行自身带着的那个标题', () => {
		// 一次大纲 jump 落在它的标题**上**：那个标题**就是**最深的那一层，而这一行
		// 不印落点文本来重复它（只有预览面板会）—— 丢掉它会让行点名**父**章节，而
		// 那一层恰恰是读者无法据以定位那处地点的。
		expect(rowTrail(['A', 'B', '决策'])).toEqual(['B', '决策']);
	});
});

describe('dropsOuterLevel', () => {
	// 这些宽度是一个真实行的，从一个排过版的行上读来：外层所要的（`whole`）对
	// 行所能给它的（`shown`）。
	it('放得下的那层留着，被裁掉一两个字的也留着', () => {
		expect(dropsOuterLevel(80, 80)).toBe(false);
		// "面板设计与信息架…" still says which section it is
		expect(dropsOuterLevel(72, 80)).toBe(false);
		// 正好一半是那条线，而活下来的那一半仍读得出来
		expect(dropsOuterLevel(40, 80)).toBe(false);
	});

	it('连一半都没剩下的那层丢掉', () => {
		// "新插件 Positi…" 指认不出任何小节，而它旁边那一层的宽度它自己需要多少就拿多少，不管
		// 这一个在不在行上（见 styles.css）
		expect(dropsOuterLevel(39, 80)).toBe(true);
		// ……以及一个已被坍缩挤到零的层
		expect(dropsOuterLevel(0, 80)).toBe(true);
	});

	it('还没排过版的行，它那一层留着', () => {
		// 一个没有布局的行对两个问题都报告不出宽度，而一个什么都不报告的层没有被
		// 裁剪过 —— 它没被量过。（面板在问之前先对**列表**的宽度做守卫；这是一个
		// 坍缩从未碰过的层的答案。）
		expect(dropsOuterLevel(0, 0)).toBe(false);
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
