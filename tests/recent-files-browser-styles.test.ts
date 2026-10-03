// 最近文件面板那些小字号的约束 —— 读的是 styles.css、不是 DOM，因为 jsdom 从不加载
// 样式表，而这里每一条都是这儿的渲染测试抓不到的契约。
//
// 一共六条：
//
// 1. 那几档安静的文字（小节、坐标、时间、工具条上的装饰）**不许**用
//    --text-faint / --text-muted 上色。它们是主题的普通变量，主题完全可以把它们改得比
//    面板自己的正文更响：在 Soft Paper（一个 Catppuccin 主题）下 --text-faint 是饱和
//    青色、--text-muted 是另一种色相，于是**最淡**的那一档反而成了列表里最扎眼的东西，
//    而笔记名还是灰的。styles.css 改从 --text-normal 往透明方向混出自己的档位 ——
//    永远与它所衬托的文字同色相，在任何配色下都永远比背景更浅。
//
// 2. 笔记行就是它的**名字**、文件不是 markdown 时的类型**徽标**、以及这一行所在的
//    文件夹 —— 放得下就一行，放不下就两行。哪一半掉到第二行是读者的设置，由一个
//    `order` 声明决定（见 PathDisplayMode）。名字有上限（max-width: 20em），**不**跨行
//    去量。时间是行自己那条轨的远端，不是名字里的第四样东西，于是各行的标签都收在
//    同一个 x 上。一行用 app 自己那个 nav-list 档位排版。
//
// 3. 触屏上，各行保留它们拥有的每一个格子 —— 落点行上的坐标与小节、笔记行上的名字与
//    时间 —— 而不是从前那条在 480px 以下藏起坐标与时间、让列表除了文件名什么都不说的
//    规则。
//
// 4. 行的控件 —— 把它从列表里拿掉的 ×，以及手机上把它开在旁边的那个标签页 —— **浮**在
//    行的远端之上，在行自身流之外**一个**盒子里，于是召唤它们不挪动任何东西；而它们与
//    时间换位时让开的是时间的颜色，不是它站的那条轨。触屏上没有悬停可用来召唤：改由
//    **长按**把行武装起来，而行把这个武装状态作为自己的一个类带着，因为一次按压必须比
//    按出它的那根手指活得久。**悬停**一次只有一行，且不挪动任何东西，所以时间让出的是
//    它的颜色；手机上被武装的行还要让出**地方**，因为立在一个名字上的两个图标是同时读
//    的两件事 —— 而行没被武装时什么都不预留，时间是它自己独占行的远端，正如设置所
//    要求的那样。
//
// 5. 落点行的小节链**由外向内**收，且**只**从外面收：外层扛下亏空的每一个像素，而最深
//    那一层根本不是可收缩的项 —— 它拿自己文字需要的宽度，最多到整行 —— 于是落点**据以
//    定位**的那一层，面板再窄也保得住自己的文字。两层之间的「›」跟着它后面那一层走，
//    于是一层被挤出行时把它的箭头一起带走，而不是留一个箭头立在行首。收缩给外层留下的
//    是一段不指认任何小节的碎片，而回读布局的那一趟会把它从被挤过半的行上摘掉
//    （`is-deep-only`）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// vitest 从项目根跑；这里 `import.meta.url` 不是一个 file: URL。
const css = readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');

// 只要浏览器自己那些规则：这条规则上面的恢复提示条、以及库路径模态框，是另外的界面，
// 有它们自己的配色决定。
const browser = css.slice(css.indexOf('.modal.position-restore-nav-modal'));

describe('最近文件面板的两档弱墨', () => {
	it('切出面板自己那一段样式', () => {
		expect(browser).toContain('.position-restore-nav-row');
		expect(browser.length).toBeGreaterThan(2000);
	});

	it('两档都由主题的主文本色派生', () => {
		for (const name of ['--nav-muted', '--nav-faint'])
			expect(browser).toContain(`${name}: color-mix(in srgb, var(--text-normal)`);
	});

	it('哪一档都不许直接用主题可以随意改色相的变量', () => {
		// 用 `var(...)` 而不是裸变量名：上面的规则用散文解释了那些被否掉的变量，
		// 而那散文里会点到它们的名字。
		expect(browser.match(/var\(--text-(?:faint|muted)\)/g) ?? []).toEqual([]);
	});

	// 默认一篇笔记一行：笔记行就是它的**名字**（箭头引着它，但在行自身的流之外 —— 见下一个
	// 测试），而设置让落点也印出来时，落点缩进到它下面，坐标排在小节前面。列表级量出来的
	// 那一列没有了 —— 它当年存在，是为了让一节列在**平铺**列表上一路起在同一个 x 上，而现在
	// 列表用它的缩进说同一件事（见下一个测试）。
	it('笔记行就是它的名字，标题行是行号 + 所属标题', () => {
		// 那个插入符号整个没了，数一次点击会打开什么的 "+N" 也没了：已经没有树可开，于是每行都
		// 重复这个状态的一列，是白花两遍的一列（见 RecentFilesList.fileRow）。
		expect(browser).not.toContain('nav-file-caret');
		expect(browser).not.toContain('nav-row-count');
		// 笔记行是**网格**而不是 flex 行：时间不是名字里的第四样东西，它是行自己的第二条轨
		//（见 is-timed）。
		expect(browser).toMatch(/\.position-restore-nav-row\.is-file\s*\{[^}]*display: grid/);
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\);/);
		// 落点缩进到它所属的那篇笔记下面
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*margin-inline-start: 1\.5em/);
		// 坐标有个**下限**，不是一条固定留白。每个标签都用同一个等宽字体排，但 "L1" 没有
		// "L9999" 宽 —— 而一个按自己文字定宽的盒子，会让每行的小节起在不同的 x 上。所以这一列
		// 以最宽的**普通**标签为下限，五个字符："L1" 被补到同样五个，那是一片让小节对齐其上的
		// 空白；而五位数的行号（"L10000"）会把盒子撑到它自己的标签宽，而不是丢掉一位。那个下限
		// 就是全部预留 —— 没有固定留白、没有轨道 —— 小节与它相隔的是行**自己的**列间距，小节
		// 自己身上没有第二道起始外边（见 .nav-row-pos、.nav-row-trail）。
		const pos = browser.match(/\.position-restore-nav-row \.nav-row-pos\s*\{[^}]*\}/)?.[0] ?? '';
		expect(pos).not.toBe('');
		expect(pos).toMatch(/min-width: 5ch/);
		const trail = browser.match(/\.position-restore-nav-row \.nav-row-trail\s*\{[^}]*\}/)?.[0] ?? '';
		expect(trail).not.toBe('');
		expect(trail).not.toMatch(/margin-inline-start/);
		// 而名字是有上限的，不是贪心的
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 20em/);
	});

	// 落点的小节链**由外向内**让位，且**只**从外面让（这正是行印最深两层、而不印它们上面
	// 那一章的全部理由）：最深那一层根本不是可收缩的项，于是外层扛下亏空的每一个像素，落点
	// **据以定位**的那一层只要行还有一点地方就保得住自己的文字。**量过**，在真实布局里 ——
	// 这里没有 jsdom —— 行上两层分别是 141px 与 63px：260px 的面板下，外层从它的 141 读出
	// 118、最深那层读出完整的 63；而这条规则从前带的收缩**权重**（100 对 1）会让最深那层
	// 短 0.2px —— 0.2px 可不是没有，因为 `text-overflow: ellipsis` 对任何一点溢出都要收下
	// 一整个字形：那一行印成了「新插件 Positi… 2026-09-…」。
	it('标题链由外向内收', () => {
		const seg = browser.match(/\.position-restore-nav-row \.nav-row-trail \.nav-trail-seg\s*\{[^}]*\}/)?.[0] ?? '';
		const deep = browser.match(/\.position-restore-nav-row \.nav-row-trail \.nav-trail-deep\s*\{[^}]*\}/)?.[0] ?? '';
		expect(seg).not.toBe('');
		expect(deep).not.toBe('');
		// 外层是唯一收缩的东西，而且它能被挤到一点不剩，这正是让最深那层在一条窄得放不下两层
		// 的行上单独站着的原因……
		expect(seg).toMatch(/flex: 0 1 auto/);
		expect(seg).toMatch(/min-width: 0/);
		// ……因为最深那层不是被收缩而是被**夹住**：完全没有收缩系数，而它的省略号以整条链本身
		// 为上限。
		expect(deep).toMatch(/flex: 0 0 auto/);
		expect(deep).toMatch(/max-width: 100%/);
		for (const rule of [seg, deep]) {
			expect(rule).toMatch(/overflow: hidden/);
			expect(rule).toMatch(/text-overflow: ellipsis/);
			expect(rule).toMatch(/white-space: nowrap/);
		}
		// 分隔符**不是**自己的一个格子：作为格子时，它前面那层被挤掉之后它还留着自己的 ~15px，
		// 于是行印出一个左边什么都没有的 "›"。改成写在那一层**里面**（见
		// RecentFilesList.placeRow），也再没有哪条规则把它当格子来定尺寸。
		expect(browser).not.toMatch(/\.nav-trail-sep\s*\{[^}]*flex:/);
	});

	// ……而收缩不是答案的全部：它给外层留下的是不指认任何小节的**碎片**（日期前面的
	// 「新插件 Positi…」），所以回读布局的那一趟会把它从被挤过半的行上摘掉（见
	// RecentFilesList.fitTrails）。样式表这一半就一条规则，是 `display: none` —— 换成
	// **宽度**会让这块碎片还站在它刚被摘下的那一行里。
	it('挤到印不出来的那层外层，直接摘掉', () => {
		const off = browser.match(
			/\.position-restore-nav-row\.is-deep-only \.nav-trail-seg\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(off).not.toBe('');
		expect(off).toMatch(/display: none/);
	});

	// 列表的字号用 app 自己那个 nav-list 档，不是 `body` 递给每个面板的 15px：这个列表站在
	// 文件浏览器旁边，而它读起来比别的每个侧栏都大一号。`--nav-item-size` 正是 app 给自己
	// 那些列表设字号的变量（桌面 13px、手机上是正文字号，见它的 .tree-item-self），于是一行
	// 跟它邻居一致，而这个文件不用挑一个数字 —— 工具条与设置菜单保持它们各自点名的更小档。
	it('行的字号取 app 自己 nav-list 的那一档', () => {
		// 行**自己**那条规则，不是桌面对话框覆盖内边的那条（后者以同一个类开头）：锚在行首，
		// 这样任何带前缀的写法都不会被当成它。
		const row = browser.match(/(?:^|\n)\.position-restore-nav-row \{[^}]*\}/)?.[0] ?? '';
		expect(row).not.toBe('');
		expect(row).toMatch(/font-size: var\(--nav-item-size/);
	});

	// **一行就是一个目标**：行进箭头是行在屏幕上最先出现的东西，它坐在行的流式内容里、
	// **不是**一条网格轨（这条规则没有 `display: grid`）；装详情控件的那条留白随着它打开的
	// 那个面板一起没了（见 RecentFilesList），所以行的内边是朴素的，里面也没有绝对定位的
	// 东西能碰到行高。
	it('行只有一套朴素内边距，里面没有绝对定位的东西', () => {
		expect(browser).toMatch(/\.position-restore-nav-row\s*\{[^}]*padding: 4px 8px;/);
		expect(browser).not.toContain('nav-row-disclose');
		expect(browser).not.toContain('--nav-disclose-');
	});

	// 文件夹只在设置要求的地方印 —— 屏幕上两篇笔记共有的那个名字，或者每一行 —— 而放不下
	// 时行的**哪一半**让位，是同一个设置的另一半：flex 行在它排布的末端换行，所以 `order`
	// 排在**最后**的那一项才掉到第二行。DOM 顺序从不改变（先是名字自己的盒子，再是文件夹），
	// 于是这一个类就是两种「总是显示」模式之间的全部差别（见 PathDisplayMode）。
	it('文件夹按设置指定的那一边印，让行的另一半去挤', () => {
		// 这个格子会换行，并用**列间距**把同一行上的东西分开：用外边会把换行的那一行缩进，
		// 两行读起来就不相干了。
		expect(browser).toMatch(/\.nav-row-file\s*\{[^}]*flex-wrap: wrap/);
		expect(browser).toMatch(/\.nav-row-file\s*\{[^}]*column-gap: 0\.5em/);
		// 文件夹是最淡那一档，连单独一行都不够时，省略的是它。
		expect(browser).toMatch(/\.nav-row-path\s*\{[^}]*flex: 0 1 auto[^}]*text-overflow: ellipsis/);
		expect(browser).toMatch(/\.nav-row-path\s*\{[^}]*color: var\(--nav-faint\)/);
		// ……而名字仍然是最后让位的：它有上限，不是贪心的。
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*flex: 0 1 auto/);
		expect(browser).toMatch(/\.nav-row-name\s*\{[^}]*max-width: 20em/);
		// 左右这一整套决定，就这一条。
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-file\.is-path-before \.nav-row-path\s*\{\s*order: -1/,
		);
		// 老类**没了**，没有留作同一条规则的第二名字：同时带两者的行会听两套布局的话。
		expect(browser).not.toContain('nav-row-folder');
	});

	// 宽对话框里腾出的地方买来了一件事，而不是给每一行强加第二行：太长放不下的路径是
	// **换行**而不是截断。路径站在哪边仍是读者的设置（上面断言过）—— 对话框不覆盖它要的
	// 那**一边**，只管路径能不能花一行把话说完。
	it('桌面对话框里长路径换行显示，而不是截断', () => {
		const path = browser.match(
			/\.modal\.position-restore-nav-modal:not\(\.is-touch\) \.position-restore-nav-row \.nav-row-path\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(path).not.toBe('');
		expect(path).toMatch(/white-space: normal/);
		expect(path).toMatch(/overflow-wrap: break-word/);
		expect(path).toMatch(/text-overflow: clip/);
		// 印在名字**前面**而不是淡淡地在其后，最淡那一档太安静、读不出来；往上一档，
		// 仍在名字自己那一档之下。
		expect(path).toMatch(/color: var\(--nav-muted\)/);
		// ……而**左右仍是读者的**：这条规则不许重排那两半，否则「前」与「后」会用同一个答案
		// 回答同一个问题。
		expect(path).not.toMatch(/order:/);
		// 也没有哪个格子是**竖排**的：给路径在每一行都单占一行，是这个文件试过又撤掉的样子
		// —— 上面那个换行只在非换不可时发生。
		expect(browser).not.toMatch(
			/(?:^|\n)\.position-restore-nav-row \.nav-row-file\s*\{[^}]*flex-direction: column/,
		);
	});

	// 类型（见 badgeOf）用 **app 自己的**标签来标 —— 文件浏览器摆在文件名旁边的那个类 ——
	// 不用我们自己的盒子：一个除了这里以外处处都像类型的类型，是读者得学两遍的类型；而我们
	// 自己的样子，是主题够不到的样子。这个类带来的两件事对文件浏览器是对的、对名字是错的，
	// 两件都收回来：那边的标签被推到它那一行的**远端**（它代表整行），而且允许收缩（挤过的
	// 标签读作 "PD / F"）。
	it('笔记的类型用 app 自己的标签来标，只做修正', () => {
		const tag = browser.match(/\.position-restore-nav-row \.nav-file-tag\s*\{[^}]*\}/)?.[0] ?? '';
		expect(tag).not.toBe('');
		expect(tag).toMatch(/margin-inline-start: 0/);
		expect(tag).toMatch(/flex: 0 0 auto/);
		// ……而它长什么样，再没有别的是我们说了算的：没有颜色、没有边框、没有我们自己的字号。
		expect(tag).not.toMatch(/color:/);
		expect(tag).not.toMatch(/border/);
		expect(tag).not.toMatch(/font-size/);
		// 老徽标**没了**，没有留在它旁边：同时带两者的行会把类型印两遍。
		expect(browser).not.toContain('nav-row-badge');
	});

	// ……而标记始终留在**名字那一行**：作为名字的兄弟，它会成为这个会换行的格子最先丢下的
	// 东西，那会把类型印在它自己的一行上、印在它所属的名字下面。名字和它的标记是一个从不
	// 换行的盒子。
	it('名字和它的标记始终同一行，无论这一行还剩多少地方', () => {
		const head = browser.match(/\.nav-row-head\s*\{[^}]*\}/)?.[0] ?? '';
		expect(head).not.toBe('');
		expect(head).toMatch(/flex-wrap: nowrap/);
		// ……而这个盒子里让位的是**名字**，不是标记：盒子收缩（见 .nav-row-name），标记保持
		// 自己的宽度。
		expect(head).toMatch(/min-width: 0/);
	});


	// 行的时间（见 model.ts 的 ageLabel）：最淡那一档，在行自己那条远端的第二轨里。正是
	// 这条**轨**让它成为一列 —— 每个印标签的行都把它收在同一个 x 上，无论名字与旁边的文件夹
	// 干了什么，也没有哪一行能把它挤掉或折走（先省略的是名字）。行只在**有**标签时才声明
	// 这条轨（见 is-timed），所以关掉时间的列表不花第二列：从前用来把标签推过去的那个自动
	// 外边，是一个只在没印文件夹时才管用的逐行小把戏。
	it('日期放在远端那一轨，行只有真的有日期时才声明这一轨', () => {
		const time = browser.match(/\.nav-row-time\s*\{[^}]*\}/)?.[0] ?? '';
		expect(time).not.toBe('');
		expect(time).toMatch(/color: var\(--nav-faint\)/);
		expect(time).toMatch(/font-size: var\(--font-ui-smaller\)/);
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-file\.is-timed\s*\{\s*grid-template-columns: minmax\(0, 1fr\) auto/,
		);
		// ……在那之前只有**一条**轨：一条没人占的第二轨，照样会从名字那里拿走它的列间距。
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-file\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
		);
		expect(browser).not.toMatch(/\.nav-row-time\s*\{[^}]*margin-inline-start: auto/);
		// ……而落点行把自己的时间收在**同一个**列上：它是 坐标 | 小节 | 时间，其中小节是接住
		// 松弛并让位的那条轨。两类行的时间于是读作同一列，而印它们要的就是这个。
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-place\.is-timed\s*\{\s*grid-template-columns: auto minmax\(0, 1fr\) auto/,
		);
	});

	// ……而行的控件搭在**同一个**远端上，在行自身的流之外（见 list.ts 的 fileRow）。绝对
	// 定位是吃重的那部分：排在行里面，它们会从名字那里拿宽度，行就会在召唤它们的指针底下
	// 挪动 —— 这是这个列表从不做的一件事（见下面的悬停着色）。两者换位时，时间让出的是它的
	// **颜色**而不是它的轨，所以那里也不动。
	it('行的控件浮在那一端之上，显示它们不挤动任何东西', () => {
		const actions =
			browser.match(/\.position-restore-nav-row \.nav-row-actions\s*\{[^}]*\}/)?.[0] ?? '';
		expect(actions).not.toBe('');
		expect(actions).toMatch(/position: absolute/);
		expect(actions).toMatch(/inset-inline-end: 4px/);
		// 用行**自己**的底色画，不用这个文件自己的颜色，于是图标下面那条带子就是它们所站的
		// 那一行 —— 悬停着色、武装自己的着色，或者位置那抹强调色。
		expect(actions).toMatch(/background: inherit/);
		// **一个盒子装下两者**，于是只带其中一个的行，不会在另一个本该站的位置留下空隙。
		const controls = browser.match(
			/\.position-restore-nav-row \.nav-row-forget,\s*\.position-restore-nav-row \.nav-row-menu\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(controls).not.toBe('');
		// ……而没被指向之前，它们什么都不说。
		expect(controls).toMatch(/opacity: 0/);
		expect(controls).toMatch(/pointer-events: none/);
		// 它们不在时，它们所站的那条带子也**不在**：带子压在时间之上，而时间是有自己答案的
		// 一个格子（"5m" 背后那一刻，见 list.ts 的 fileRow）—— 一条看不见却吞掉指针的带子，
		// 会替**整行**作答，而「哪个文件」并不是一个指着时间看的读者问的问题。
		expect(actions).toMatch(/pointer-events: none/);
		// ……而它随它们一起回来，两种设备上都如此，好让落进带子里、却没落在任一控件上的按压
		// 算**落空**，而不是点击了整行：一根从一个控件滑到另一个控件的手指哪个都没点到，而
		// 浏览器点的是它们共同的那个祖先（见 RecentFilesList.actionStrip）。
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover \.nav-row-actions,\s*\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions\s*\{[^}]*pointer-events: auto/,
		);

		// 时间保住它的轨，只让出颜色……
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover \.nav-row-time\s*\{[^}]*color: transparent/,
		);
		// ……控件以完全一样的条件到场，和悬停着色一样被排除在触屏之外（手指的一次点按会把
		// `:hover` 粘在它碰过的那一行上）……
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover \.nav-row-actions > \*\s*\{[^}]*opacity: 1/,
		);
		// ……而**触屏上它们改由长按到场**，这正是悬停在一个没有悬停的设备上的样子（见
		// long-press.ts）：行把武装状态作为自己的类带着，而不是指针的一种状态，因为一次按压
		// 必须比按出它的手指活得久 —— 读者要抬起那根手指，才够得到按压放到行上的东西。
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions > \*\s*\{[^}]*opacity: 1/,
		);
		// ……目标大到一根手指不用瞄就能命中，取的是**最小宽度**，好让图标保持自己的尺寸、长的
		// 只是它外面的盒子 —— 而且只命名一次（--nav-action-target），这样行让出的地方不可能
		// 跟它对不上。
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions > \*\s*\{[^}]*min-width: var\(--nav-action-target\)/,
		);
		// ……而**行被武装时，带子就是整条行的远端**：跟行一样高（由行裁掉），两个控件
		// **边挨边**相接 —— 它们之间的缝隙从前是一条让手指漏到行上去的通道。
		//（这条带子被两条规则命名 —— 这一条，和让它可被触及的那一条 —— 所以这里断言的是给它
		// 定尺寸的那一条。）
		const armedStrip = (browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-actions\s*\{[^}]*\}/g,
		) ?? []).find(rule => rule.includes('inset-block')) ?? '';
		expect(armedStrip).not.toBe('');
		expect(armedStrip).toMatch(/inset-block: 0/);
		expect(armedStrip).toMatch(/gap: 0/);
		// ……两个控件两侧的留白是**带子自己**的内边，而不是它旁边的空间，于是一根落在那里面的
		// 手指落在带子里 —— 它什么都不作答 —— 而不是落在行上、把笔记打开。
		expect(armedStrip).toMatch(/padding-inline: 8px 4px/);
		expect(armedStrip).toMatch(/inset-inline-end: 0/);
		// ……而被武装的行会说出自己**是哪一行**：手机上再没有别的东西给行上色。
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed:not\(\.is-pressed\)\s*\{[^}]*background: var\(--background-modifier-hover\)/,
		);
		// ……而**被武装的行把地方让给这两个**，量的是目标用的同一个数：一条盖在行上的带子，
		// 就是一条盖在文件夹和名字上的带子，而两个叠在文字上还看得清的图标，是同时读的两件事。
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed\s*\{[^}]*padding-inline-end: calc\(2 \* var\(--nav-action-target\)/,
		);
		// ……而且**不管**手指还在不在行上，这块地方都预留着：向按压让位的是武装的底色，绝不是
		// 控件所站的空间。带子是用行自己的底色画的，而那是很薄的一层（见上面
		// `background: inherit`）—— 盖在一个没让开的名字上，就是同时读的两件事，而且两件都
		// 读不清。
		expect(browser).not.toMatch(
			/\.is-armed:not\(\.is-pressed\)\s*\{[^}]*padding-inline-end/,
		);
		// 武装**占的是**时间的位置，而不是站在它旁边，跟悬停完全一样 —— 而行没被武装时什么
		// 都不预留，于是一个手机（在那里这个列表就是读者全部的历史）保得住设置要的那些时间
		//（见 recentFilesRowTime）。
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed \.nav-row-time\s*\{[^}]*color: transparent/,
		);
		expect(browser).not.toMatch(/is-touch [^{]*\.is-file\s*\{[^}]*padding-inline-end/);
	});

	// 「你在这里」是笔记行上、以及当前条目所记录的那个落点上的一颗圆点：当前位置是**印在
	// 列表里面**的，而不是被拿到列表之外。
	it('当前标题用行号前面的一个圆点标出', () => {
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*color: var\(--interactive-accent\)/);
		// ……**挂在**坐标自己的**起始边**上，于是它引着它所标的那个数字，却不站在坐标的盒子
		// 里：排在里面的一颗圆点，会从**每一**个落点行的小节那里拿走一颗圆点的宽度，只为装一个
		// 只有其中一行才会显示出来的标记（见 .nav-row-pos）。
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*position: absolute/);
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*inset-inline-end: 100%/);
		// ……而它与数字的距离是它**末端**一道对着盒子的外边：固定的是**间距**，不是字形的宽度，
		// 于是字体想把这个 ● 画多宽都行，永远碰不到数字。
		expect(browser).toMatch(/\.nav-row-here\s*\{[^}]*margin-inline-end: 0\.3em/);
		// ……而落点行不许裁掉挂在它外面的东西（见 .is-place）。
		expect(browser).toMatch(/\.position-restore-nav-row\.is-place\s*\{[^}]*overflow: visible/);
	});

	// 位置就是键盘所在的那一行（见 RecentFilesList.choose），而指针伸到那一行上时，
	// 这层底色得挺得住。
	it('位置那几个字是有颜色的，指针压上去也不改', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected\s*\{[^}]*background-color: color-mix\(in srgb, var\(--interactive-accent\)/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected:hover\s*\{[^}]*background-color: color-mix/,
		);
		expect(browser).not.toContain('is-previewed');
	});

	// 指针**底下的行**取 app 自己的悬停着色，好让读者在点下去之前就看得出这一击会落在哪
	// 一行（见 body.ts）。关于它有三件事是吃重的：
	//   - 用的是 app 的悬停变量，不是这个文件自己的颜色 —— 设置行跟文件浏览器用的都是同一层；
	//   - **位置**那一行被排除在外，因为它那层强调色是更响的标记，指针不许用更弱的一个把它
	//     顶掉；
	//   - 它被排除在触屏之外：手指的一次点按会把 `:hover` 粘在它碰过的那一行上，而为一个
	//     已经走掉的指针上色的行，说什么都不是真的。
	it('指针悬停只给整行上色，不动位置那几个字，也跟手指无关', () => {
		const hover =
			browser.match(
				/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover:not\(\.is-selected\):not\(\.is-pressed\)\s*\{[^}]*\}/,
			)?.[0] ?? '';
		expect(hover).not.toBe('');
		expect(hover).toMatch(/background-color: var\(--background-modifier-hover\)/);
		// ……而位置仍然是两者里更强的那个，于是一行被悬停着色，永远不会被误认成键盘所在的那
		// 一行。
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected\s*\{[^}]*background-color: color-mix\(in srgb, var\(--interactive-accent\) 12%/,
		);
	});

	// 手指没有悬停可作为依据，而一次点按要的那趟行进还差一刻、且发生在别处 —— 一篇笔记
	// 打开、一个抽屉合上 —— 所以按压本身就是一行唯一能用来作答的东西（见 list.ts 的
	// markPressed）。
	it('按下落在哪一行就标记哪一行，并压过那两种它可能让位的着色', () => {
		const pressed =
			browser.match(
				/\.position-restore-nav-panel \.position-restore-nav-row\.is-pressed\s*\{[^}]*\}/,
			)?.[0] ?? '';
		expect(pressed).not.toBe('');
		// 主题有的话就用 app 自己那层**按下**色，于是一次按压读作指针对一行做的两件事里更深
		// 的那件 —— 主题没有的话，这个标记仍然落在悬停色上，而不是落空。
		expect(pressed).toMatch(
			/background-color: var\(--background-modifier-active, var\(--background-modifier-hover\)\)/,
		);
		// ……**不**排除触屏：桌面已经用悬停回答鼠标了，但按在一个行上的鼠标键是一次按压，而
		// 悬停分不出它和一个恰好待在那里的指针。
		expect(pressed).not.toMatch(/is-touch/);
		// ……而它**盖过**同一刻本来会把行上色的那两层：悬停那层（不管怎样它的指针都在行上），
		// 以及武装那层（手指**走了**之后行留下的就是它）。
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-touch\) \.position-restore-nav-row:hover:not\(\.is-selected\):not\(\.is-pressed\)\s*\{/,
		);
		expect(browser).toMatch(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\.is-armed:not\(\.is-pressed\)\s*\{/,
		);
		// ……而**位置**那一行在按压下是加深，而不是把强调色让给一个中性色，跟它在悬停下的
		// 表现完全一样。
		expect(browser).toMatch(
			/\.position-restore-nav-row\.is-selected\.is-pressed\s*\{[^}]*color-mix\(in srgb, var\(--interactive-accent\)/,
		);
	});

	// 工具条**不带**自己的设置：齿轮从前装的那四个选项，现在是插件设置页里的行（见
	// RecentFilesBrowserPrefs），于是面板再没有控件面要画 —— 没有按钮、没有挂在工具条上的
	// 菜单，也没有为它们跟主题争的墨色。工具条就是搜索框，而导航要的只有这个。
	it('工具条只留给搜索框 —— 没有齿轮、没有菜单、旁边也没有提示语', () => {
		expect(browser).not.toMatch(/position-restore-nav-settings/);
		expect(browser).not.toMatch(/nav-settings-/);
		expect(browser).not.toMatch(/nav-settings-ink/);
		// ……也没有从前站在框旁边的那句话（「点一行就能打开」）：列表里的一行在 app 别处都答
		// 点击，而那句话占的那一行本该是列表的。
		expect(browser).not.toContain('position-restore-nav-hint');
		// ……也再没有什么锚定在工具条上：它从前用来挂面板的那个菜单，是它唯一绝对定位的
		// 子元素（× 搭在框自己的包装上，见 .position-restore-nav-search）。
		const toolbar = browser.match(/\.position-restore-nav-toolbar\s*\{[^}]*\}/)?.[0] ?? '';
		expect(toolbar).not.toBe('');
		expect(toolbar).not.toMatch(/position: relative/);
		expect(browser).toMatch(/\.position-restore-nav-search\s*\{[^}]*position: relative/);
	});

	// 列表是仅有的那一列：它占满整个宽度，而对话框就是按一列来定尺寸的（见模态框自己
	// 那条规则）。
	it('列表占满整个宽度，对话框按一个列表的宽度来', () => {
		expect(browser).toMatch(/\.position-restore-nav-list\s*\{[^}]*flex: 1 1 auto/);
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal\s*\{[^}]*width: min\(23em/);
		expect(browser).not.toContain('is-no-details');
		expect(browser).not.toContain('position-restore-nav-body');
	});

	// 桌面对话框的尺寸，照 app 给自己那个回答同一个问题的东西（快速切换器）定尺寸的
	// 方式：它的 prompt 占多宽、站在那个 prompt 站的位置、用它给建议排的字号。这几样每一样
	// 都是**从 app 读出来**的，不是在这里量出来的，所以重新调 prompt 的主题会连这个对话框
	// 一起调 —— 也因此它们一个都不许回退到本文件自己的数字。手机**保持自己的尺寸**（见这两
	// 条覆盖掉的那些基础规则）：一个 700px 的对话框，是手机收不起来的一屏。
	it('桌面对话框的尺寸照 app 自己那个 prompt 的量法来', () => {
		const desktop =
			browser.match(/\.modal\.position-restore-nav-modal:not\(\.is-touch\) \{[^}]*\}/)?.[0] ?? '';
		expect(desktop).not.toBe('');
		// app 自己的 prompt 宽度，以及同一条规则为下面两处读取而命名的、关系很近的
		// `--nav-modal-top`
		expect(desktop).toMatch(/width: var\(--prompt-width/);
		expect(desktop).toMatch(/max-width: min\(var\(--prompt-max-width/);
		expect(desktop).toMatch(/--nav-modal-top: 80px/);
		// **靠上，不居中**：容器会把里面的东西居中，所以这里是对话框改而要那一行的开头。
		expect(desktop).toMatch(/align-self: flex-start/);
		expect(desktop).toMatch(/margin-top: var\(--nav-modal-top\)/);
		// 行的字号取 app 自己的某一档：`--nav-item-size` 是它给自己 nav 列表设字号的变量
		// —— 这里 13px、手机上 15px —— 所以桌面要的是手机那个数，而不是再编出第四个数（见行
		// 自己那条规则）。
		expect(desktop).toMatch(/--nav-item-size: var\(--font-ui-medium\)/);
		// ……而手机答的是那条基础规则，仍是它自己那个窄宽度，于是上面这些没有一条会漏到手机上。
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal \{[^}]*width: min\(23em/);
	});

	// ……而**高度钉死，不管列表里是什么**（见 modal.ts：桌面上 `is-fixed` 不再等一段长
	// 历史）。高度之所以钉死，全是因为按内容定尺寸的对话框会在每一次敲键下**缩**、在读者
	// 还在打字的时候把自己往窗口中间拽，所以这条断言就是拦住任何人再把「钉死」变成看列表
	// 而定。手机保持它自己的。
	it('桌面对话框的高度钉死，筛选也撑不动它', () => {
		const pinned =
			browser.match(
				/\.modal\.position-restore-nav-modal\.is-fixed:not\(\.is-touch\) \{[^}]*\}/,
			)?.[0] ?? '';
		expect(pinned).not.toBe('');
		expect(pinned).toMatch(/height: min\(var\(--prompt-max-height/);
		expect(browser).toMatch(/\.modal\.position-restore-nav-modal\.is-fixed \{[^}]*height: min\(84vh/);
	});

	// 桌面对话框**开在筛选框上**，不是开在立在它上面的自己的名字上：一个标题会花掉对话框
	// 的第一行去说读者已经要过的东西，而它正是这个对话框与 app 对同一个问题的回答之间剩下
	// 的那一样（一个 prompt 就是一个筛选框加一个列表，上面什么都没有）。名字不是取消设置
	// 而是**显示掉** —— 标题置空会给头部留下它那一行、连同 margin-bottom —— 而下面的列表
	// 仍然带着给辅助技术用的那个字符串（见 body.ts）。
	it('筛选框放在桌面对话框的顶部', () => {
		const header = browser.match(
			/\.modal\.position-restore-nav-modal:not\(\.is-touch\) \.modal-header\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(header).not.toBe('');
		expect(header).toMatch(/display: none/);
		// 手机**保住它的名字**：矮窗口那几条规则用它们自己的类把它放到一边。
		expect(browser).not.toMatch(/\.position-restore-nav-modal \.modal-header\s*\{[^}]*display: none/);
	});

	// ……而随名字一起去的是**立在它旁边的那个 ×**，免得对话框为一个动作显示两个字形。出去
	// 的路没有跟着丢：在一个收得起来的壳里，没有输入可清时，框自己的 × 关上它（见
	// RecentFilesBrowser.toolbar）—— 一个字形干两件事，就放在 app 自己的 prompt 放它的
	// 地方。手机保留 app 的那个 ×，因为它保留了那个 × 所属的名字。
	it('app 留一个 × 的地方，也只留一个 ×', () => {
		const x = browser.match(
			/\.modal\.position-restore-nav-modal\.is-dismissive:not\(\.is-touch\) \.modal-header-button,\n[^}]*\}/,
		)?.[0] ?? '';
		expect(x).not.toBe('');
		expect(x).toMatch(/display: none/);
		// 这样一来也没有别的要为它让地方：工具条自己的内缩不去动。
		expect(browser).not.toMatch(/\.position-restore-nav-toolbar\s*\{[^}]*padding-inline-end: var\(--size-4-6/);
	});

	// 置顶行的**结尾**是一条线、别的什么都没有：一个标题会花掉一行的高度来说这条线已经说
	// 了的事，而每个置顶行上的图标也没地方站 —— 行的远端属于它自己的控件。
	it('置顶区末尾有一条线收住，但不给这个区写名字', () => {
		const sep = browser.match(/\.position-restore-nav-pinned-sep\s*\{[^}]*\}/)?.[0] ?? '';
		expect(sep).not.toBe('');
		expect(sep).toMatch(/border-top: 1px solid/);
		// 是一条线，不是一行：没有自己的高度、没有文字、没有我们自己的图标。
		expect(sep).toMatch(/height: 0/);
		expect(browser).not.toContain('nav-pinned-title');
		expect(browser).not.toContain('nav-row-pin');
	});

	// 手机用的**和桌面一样的行** —— 每个格子都在、一行一条 —— 而不是从前那条在窄屏上藏起
	// 坐标与时间、让列表除了文件名什么都不说的规则。值得钉住的是：触屏上什么都没藏，以及行
	// 是手指的目标。
	it('手机上照用桌面的行：一行一条，绝没有藏起来的格子', () => {
		// 行给手指的**地方**，不是这个选择器匹配到的第一条规则 —— 手机的行带了不止一条（见
		// 上面长按自己那条规则）。
		const touch = browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-row\s*\{[^}]*padding: 6px 8px[^}]*\}/,
		)?.[0] ?? '';
		expect(touch).toMatch(/padding: 6px 8px/);
		// ……也没有哪个落点有自己的第二行：坐标与小节就是落点的全部，手机给它的那一行放得下。
		expect(browser).not.toMatch(/is-touch \.position-restore-nav-row\.is-place/);
		expect(browser).not.toContain('grid-area:');
		expect(browser).not.toContain('nav-row-pane');
		expect(browser).not.toMatch(/@media \(max-width: 480px\)/);
	});

	// 触屏上工具条是**一行**：从前占掉第二行的提示语没了，声明那两行的**网格**也跟着走了
	// —— 一个叫 'box' 的单独格子，会是个在说 flex 行已经说过的话的网格。触屏布局仍然向
	// 工具条要的是那个 ×：一个手指点得到的目标。
	it('触屏工具条保持一行，× 保持手指点得到的尺寸', () => {
		expect(browser).not.toMatch(/is-touch \.position-restore-nav-toolbar\s*\{[^}]*display: grid/);
		expect(browser).not.toContain('grid-area: box');
		const clear = browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-search \.position-restore-nav-clear\s*\{[^}]*\}/,
		)?.[0] ?? '';
		expect(clear).toMatch(/padding: 5px/);
		expect(clear).toMatch(/--icon-size: var\(--icon-s\)/);
	});

	// 面板拥有它自己的那些 tooltip，app 不许把它自己的画在它们上面。每个 `aria-label`
	// 对 app 来说都是一个 tooltip（它的 tooltip 监听器就匹配这个属性），而 listbox 的名字
	// —— "Recent files"，屏幕阅读器需要的那个 —— 从前每次悬停一行都会被画在指针底下。
	// `--no-tooltip` 是 app 自己的开关，而且它**继承**，于是在共用的壳上写一句，就把列表与
	// 设置分组一起盖住了。
	it('不许 app 自己的 tooltip 混进面板的无障碍名字', () => {
		const panel = browser.match(/\.position-restore-nav-panel\s*\{[^}]*\}/)?.[0] ?? '';
		expect(panel).toMatch(/--no-tooltip: true/);
	});

	// 行的 tooltip 是面板自己的（见 tip.ts），它之所以存在，是因为原生 `title` 没法上
	// 样式：路径从前用浏览器那套 tooltip 字体，而两段之间的 `/` —— 整条 tooltip 靠它来读的
	// 那个字符 —— 是串里最不显眼的东西。两件事都在这儿定：路径比 app 自己的 tooltip 字体高
	// 一档（--font-ui-small，而 app 那个是更小的一档），分隔符则做成自己的 span，用任何字体
	// 都削不掉的粗细。
	it('行的 tooltip 用可读的字号画，分隔符自己提供', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-tip\s*\{[^}]*position: fixed[^}]*pointer-events: none/,
		);
		const path = browser.match(/\.nav-tip-path\s*\{[^}]*\}/)?.[0] ?? '';
		expect(path).toMatch(/font-family: var\(--font-monospace\)/);
		// **不**用 app 的 tooltip 档（--font-ui-smaller）：读者是在辨认一个文件夹名，而那是
		// 这个元素唯一的活。高一档，不是它曾经的两档：列表的字号定下来时，整条 tooltip 也跟着
		// 降了一档，所以要守住的是这个**档差**，不是那一档的名字。
		expect(path).toMatch(/font-size: var\(--font-ui-small\)/);
		const sep = browser.match(/\.nav-tip-sep\s*\{[^}]*\}/)?.[0] ?? '';
		expect(sep).toMatch(/font-weight: 700/);
		expect(sep).toMatch(/padding: 0 0\.12em/);
		// 文件夹往后退一步，好让分隔符有个可以靠着的东西……
		expect(browser).toMatch(
			/\.nav-tip-seg\s*\{[^}]*color: color-mix\(in srgb, var\(--text-normal\)/,
		);
		// ……而第二行（文件的其他名字）比路径小一号，于是它仍是一个次要的回答，而不是跟读者
		// 悬停所求的那样东西争。
		expect(browser).toMatch(/\.nav-tip-text\s*\{[^}]*font-size: var\(--font-ui-smaller\)/);
	});

	// 「这一篇里有个叫 X 的小节」那一行（见 TipContent.matched）：与链同档 —— 两者都是这个
	// 面板派生的话、而不是笔记里的原文 —— 且同样不借引文那道竖线（那个装饰只留给「这些字
	// 是读者自己写的」，而这里的话是面板的）。
	it('「命中的小节」与链同档，且不借引文那道竖线', () => {
		const matched = browser.match(/\.position-restore-nav-tip\s*\.nav-tip-matched\s*\{[^}]*\}/)?.[0] ?? '';
		expect(matched).not.toBe('');
		expect(matched).toMatch(/font-size: var\(--font-ui-smaller\)/);
		expect(matched).toMatch(/overflow-wrap: anywhere/);
		expect(matched).not.toMatch(/border-inline-start/);
		const trail = browser.match(/\.position-restore-nav-tip\s*\.nav-tip-trail\s*\{[^}]*\}/)?.[0] ?? '';
		expect(matched.replace('.nav-tip-matched', '.nav-tip-trail')).toBe(trail);
	});

	// 引文那一行（.nav-tip-quote）连同它的竖线在 2026-10-03 撤掉了 —— 落点下面那块正文
	// 随它的搜索面一起没了，于是没有任何东西需要「这些字是读者自己写的」这道装饰。
	// 锁住它**不再有规则**（注释里还会提到它，那句说的是这道装饰的由来）。
	it('引文那一行与它的竖线已经不在了', () => {
		expect(browser).not.toMatch(/\.nav-tip-quote\s*\{/);
		expect(browser).not.toMatch(/border-inline-start:\s*2px solid var\(--background-modifier-border\)/);
	});

	// 标题链那一行（见 TipContent.trail，`'last' | 'none'` 两档下文件行的唯一解释）：
	// 与文件的其他名字**同档**，因为两者是同一类东西 —— 这个面板派生的、供分辨用的名字。
	// 刻意**不给**那条竖线：在这个面板里竖线只留给「这些字是读者自己写的」（nav-tip-quote），
	// 而链是定位、不是引用。折行而不裁 —— 一篇笔记的标题可以是长句。
	it('标题链与文件的其他名字同档，且不借引文那条竖线', () => {
		// 锚在完整的命名空间前缀上：`.nav-tip-trail {` 单独匹配会连
		// `.position-restore-nav-tip .nav-tip-trail {` 一起命中，那不是「无前缀」而是
		// 「匹配错了地方」，所以这里要求带上前缀那半截。
		const block = browser.match(/\.position-restore-nav-tip\s*\.nav-tip-trail\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).not.toBe('');
		expect(block).toMatch(/font-size: var\(--font-ui-smaller\)/);
		expect(block).toMatch(/overflow-wrap: anywhere/);
		expect(block).not.toMatch(/border-inline-start/);
		// 与 nav-tip-text 同一档：链是「这地方叫什么」，而那是同一个问题的另一个形式。
		const text = browser.match(/\.position-restore-nav-tip\s*\.nav-tip-text\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block.replace('.nav-tip-trail', '.nav-tip-text')).toBe(text);
	});

	// ……而悬停**就那些引文**说的那一行 —— 这些引文取下来之后笔记又被写过了 —— 靠**墨色**
	// 而不是靠一条线区分开：这是本面板在就笔记的话发言，读者得能一眼把两者分清。比引文更
	// 淡，而且用面板自己的淡档而不是 --text-faint（主题可以随意改它的色相）。
	it('说明引文的那一行靠墨色区分开，不靠分隔线', () => {
		const note = browser.match(/\.nav-tip-note\s*\{[^}]*\}/)?.[0] ?? '';
		expect(note).toMatch(/color: var\(--nav-faint\)/);
		expect(note).not.toMatch(/border-inline-start/);
	});

	// 框末端的那个 ×，以及让它成为控件而不是一个标记的那一条规则：它恰好在有东西可清时
	// 才在，而且是问**框自己**的状态（`:placeholder-shown` 就是一个空的筛选框 —— 无论有
	// 没有焦点 —— 的样子），不是一个要监听器去保持同步的类。一个 × 同时还会**关掉**它所在
	// 那个壳的框，永远不会没活干，于是永远不藏它 —— 见 RecentFilesBrowser.toolbar。
	it('只有框里有内容时才显示清除按钮', () => {
		expect(browser).toMatch(
			/\.position-restore-nav-panel:not\(\.is-dismissive\) \.position-restore-nav-search input:placeholder-shown ~ \.position-restore-nav-clear\s*\{\s*display: none/,
		);
		// ……而它在行上占的地方只在它在时才预留，于是一个往空框里打字的读者，不是在往一个更窄
		// 的框里打 —— 除非那个字形永远留着不走，而那由它自己的选择器说明。
		expect(browser).toMatch(
			/\.position-restore-nav-modal\.is-dismissive:not\(\.is-touch\) input\.position-restore-nav-filter\[type='text'\]\s*\{[^}]*padding-inline-end: 1\.6em/,
		);
	});

	// 钉死高度的对话框必须被它里面的列表**填满**。它带着 `max-height: 60vh`，来自当年
	// 一块「你在这里」卡片立在它上面、把差额补上的时候；卡片一走，列表在一个已经声明了高度
	// 的对话框里到三分之二处就停住，剩下的是连滚动条都不在的死区。高度钉死是为了让筛选改
	// 不了对话框的尺寸、也重新居中不了它（见 is-fixed），所以修法是把它填满。
	it('钉死的高度由列表填满，而不是差一截填不到底', () => {
		expect(browser).toMatch(
			/is-fixed \.position-restore-nav-list\s*\{[^}]*flex: 1 1 auto[^}]*max-height: none/,
		);
		// 历史很短的那种情况保留它的上限：那里对话框按内容定尺寸，而一个 60vh 的列表会是它
		// 里面最高的东西
		expect(browser).toMatch(/\.position-restore-nav-list\s*\{[^}]*max-height: 60vh/);
	});

	// 抽屉的头部读起来像大标题压着小字：笔记的**名字**是面板里最大的东西（引到这里来的
	// 那一行也点它的名，而这里是有地方把它排好的那处），排在它前面的文件夹是淡的、也最先
	// 让位（行用的那套收缩次序），而关于这一步的事实 —— 窗格、类型、链接从哪来、坐标、
	// 警告 —— 是它下面安安静静的一行。面板唯一的动作是一个真按钮，但刻意不是填满的强调色
	// 按钮：抽屉是读者正在扫的那份列表的第二列。

	// 面板不带自己的动作、也不带自己的开关：行自己的点击打开文件，而留白上那个控件才是
	// 给面板指方向的（见 RecentFilesList.onClick / disclose）。从前坐在说明行上的内容切换
	// 器，随着它所选的那两个内容一起没了，所以样式表里不许还给它留着一个家。
	it('自己不提供任何控件 —— 没有开关，也没有前进后退按钮', () => {
		expect(browser).not.toContain('.nav-preview');
	});

	// 横着拿的手机总共只有约 370px 高度（对话框的名字、筛选框、列表都要在里面）：下面
	// 每一条都是还给列表的一行。
	it('矮对话框（手机横屏）的布局更紧凑', () => {
		const landscape = browser.slice(browser.indexOf('@media (max-height: 520px)'));
		expect(landscape.length).toBeGreaterThan(500);

		// 对话框的**名字**去掉：390px 高的对话框里单个最大的东西，而且它只是重复下面列表
		// 已经说了的话
		expect(landscape).toMatch(/is-touch \.modal-header\s*\{\s*display: none/);
		// ……而工具条**连同 app 的关闭按钮一起**拿下它们所在的那一行，那个按钮不在头部、而是
		// 浮在内容之上：内容的上内边降到按钮自己的内缩、工具条跟它的盒子一样高，于是按钮不可能
		// 悬在列表第一行之上（一个关掉对话框的 44px 目标，正坐在一根手指伸过去的那一行上）……
		expect(landscape).toMatch(/is-touch \.modal-content\s*\{[^}]*padding-top: var\(--size-4-3/);
		expect(landscape).toMatch(/is-touch \.position-restore-nav-toolbar\s*\{[^}]*min-height: var\(--touch-size-m/);
		// ……而它让出按钮那一列，否则筛选框会跑到它底下
		expect(landscape).toMatch(
			/is-touch \.position-restore-nav-toolbar\s*\{[^}]*padding-inline-end: calc\(var\(--touch-size-m/,
		);
		// 框保住工具条仅有的那一行，并把它整个占下
		expect(landscape).toMatch(/input\.position-restore-nav-filter\s*\{[^}]*flex: 1 1 5em/);
		// ……而它从前压缩过的那些装饰一点不剩：「你在这里」卡片与文件范围都没了
		//（见 RecentFilesModal）
		expect(browser).not.toContain('position-restore-nav-here');
		expect(browser).not.toContain('position-restore-nav-scope');
		expect(browser).not.toContain('position-restore-nav-toggle');
		// ……而落点在这里不需要自己的规则：它就是桌面给它的那一行，整条宽度都用来放坐标与
		// 小节。
		expect(landscape).not.toMatch(/is-touch \.position-restore-nav-row\.is-place/);
		// ……而详情面板在这里不需要自己的规则：它根本不存在
		expect(landscape).not.toMatch(/nav-preview/);
	});

	// 常驻窗格自己的高度（见 RecentFilesView）：leaf 把读者把侧栏拖到多高，窗格就拿到
	// 多高，所以窗格得接住它。app 自己的 `.view-content` 是个带自己内缩的滚动容器，留在那
	// 儿就是列表外面**第二个**滚动容器 —— 两个滚动容器等着 app 拿手指的拖动去比对 —— 再加上
	// 一层内缩，它那 32px 的脚就是手机在屏上键盘上方露出的那条空带。
	//
	// 这条规则是照着窗格的**类**写的，不是照着 leaf 的 `data-type`（它带着
	// RECENT_FILES_VIEW_TYPE）：那个常量随着面板一起改了名，而规则却还在照着一个再没有哪个
	// leaf 带的字符串写 —— 这件事没有任何构建步骤、也没有任何测试能发现，这就是这个测试在
	// 这里的原因。类不会漂：窗格在同一处调用里自己把它加上。
	it('常驻面板按面板自身来限定范围，而不是按 viewType 字符串', () => {
		const pane = browser.match(/\.workspace-leaf-content [^{]*position-restore-nav-view\s*\{[^}]*\}/)?.[0] ?? '';
		expect(pane).not.toBe('');
		expect(pane).toMatch(/display: flex/);
		expect(pane).toMatch(/flex-direction: column/);
		// 只有一个滚动容器，就是列表
		expect(pane).toMatch(/overflow: hidden/);
		// ……而这个窗格自己给工具条和列表留了内缩，里面就不要 app 的内缩了
		expect(pane).toMatch(/padding: 0/);
		// 面板里再没有哪条规则是照着 `data-type` 写的：从前有那么一条 —— 窗格改名之前带的
		// 那个视图类型 —— 而它正是这个测试存在的原因。
		expect(browser).not.toMatch(/\[data-type=/);
		expect(browser).not.toContain('position-restore-nav-history');
	});

	// 6. 笔记已经**丢掉**那个标题的落点，仍然印记录带着的那些字，加删除线、降一档 ——
	//    那些字是最后还在给那个位置命名的东西，而被划掉的只是「笔记还有它们」这个断言（见
	//    RecentFilesList.placeRow / landingNote）。
	it('笔记已经没有的那个标题加删除线，而不是把它丢掉', () => {
		const lost = browser.match(/\.position-restore-nav-row \.nav-row-trail\.is-lost \{[^}]*\}/)?.[0] ?? '';
		expect(lost).not.toBe('');
		expect(lost).toMatch(/text-decoration: line-through/);
		// ……比还活着的小节所在那一档低两阶，而且仍是从主题自己的正文色混出来的，不是用主题
		// 的变量直接上色
		expect(lost).toMatch(/color: var\(--nav-faint\)/);
	});

	// 手机用一根手指滚列表，而它所在的窗格又是同一根手指横向拖动去收起的那个（见
	// RecentFilesView.dismissOnMobile），app 是从手指落到的元素往上走、找可以滚的东西，来
	// 判断一次拖动是两者里的哪一种。所以列表自己说明自己是什么，而不是留给别人去量：纵向
	// 拖动是它的、横向拖动根本不是滚动，而拖到任一端就在那里停住，不会被交给窗格周围别的
	// 滚动容器。
	it('手机上拖动按列表滚动来响应', () => {
		// 基础那条规则，不是常驻窗格重述它的那条：锚在行首，这样以这个类结尾的更长选择器
		// 匹配不到。
		const list = browser.match(/(?:^|\n)\.position-restore-nav-list \{[^}]*\}/)?.[0] ?? '';
		expect(list).toMatch(/overflow-y: auto/);
		expect(list).toMatch(/touch-action: pan-y pinch-zoom/);
		expect(list).toMatch(/overscroll-behavior: contain/);
	});

	// 那四个箭头（见 body.ts）—— 面板给没有键盘的设备准备的答案，也是它里面唯一作用于
	// **笔记**而不是作用于列表的控件。样式表要守住的就是全部难处：立在列表上的四个箭头会被
	// 读成四种滚动那个列表的方式，而这里没有哪条规则能允许它们这样。
	it('箭头装在两个胶囊里，列表的任何一行都不画在它们里面', () => {
		const strip = browser.match(/\.position-restore-nav-arrows \{[^}]*\}/)?.[0] ?? '';
		expect(strip).not.toBe('');
		expect(strip).toMatch(/display: flex/);
		// 那两对是两样不同的东西，而两个胶囊之间的空隙就是全部的区分：一个按钮宽的空隙，
		// 会让它们读成一行四个。
		expect(strip).toMatch(/gap: 22px/);
		const capsule = browser.match(/\.position-restore-nav-arrow-group \{[^}]*\}/)?.[0] ?? '';
		expect(capsule).not.toBe('');
		// 是胶囊，不是一行：一个坐在 app 自己那层安静底色上的、有边框、带圆角的盒子，不是
		// 下面列表里任何东西会被画成的形状 —— 那边是整宽的线，指针压上去会着色。
		expect(capsule).toMatch(/border: 1px solid var\(--background-modifier-border\)/);
		expect(capsule).toMatch(/border-radius/);
		expect(capsule).toMatch(/background: var\(--background-secondary\)/);
		// ……而一个胶囊里的两个按钮几乎边挨边：宽到能把它们分开的缝，就宽到能让它们读成两个
		// 控件，而一行四个正会是这样。
		expect(capsule).toMatch(/gap: 2px/);
	});

	// 箭头既是**目标**也是一个字形：一个数字，只命名一次，手机上抬到 app 自己的触摸
	// 尺寸，于是手指必须落进去的那个盒子，不可能跟带子占的地方对不上。而一个什么都不会做的
	// 箭头会静下来，而不是用「什么都不做」来作答 —— 这也是本面板对「最后两个归谁」那一问
	// 一贯的回答。
	it('箭头做成可点的尺寸，点了没用的那个置灰', () => {
		const arrow = browser.match(/\.position-restore-nav-arrow \{[^}]*\}/)?.[0] ?? '';
		expect(arrow).not.toBe('');
		expect(arrow).toMatch(/width: var\(--nav-arrow-target\)/);
		expect(arrow).toMatch(/height: var\(--nav-arrow-target\)/);
		expect(browser).toMatch(/\.position-restore-nav-panel \{[^}]*--nav-arrow-target: 28px/);
		expect(browser).toMatch(
			/is-touch \.position-restore-nav-arrows \{[^}]*--nav-arrow-target: var\(--touch-size-m\)/,
		);
		// **面板自己的墨色**，不是主题的：app 的图标皮肤读 `--icon-color`，而主题可以把它
		// 指向自己最淡的那一档 —— 那样的话，按钮上一个用全力画出来的字形，仍然是个谁也看不见的
		// 字形。在这里命名，面板里每个图标就都落在**同一种**墨色上 —— 且是**全**不透明：app
		// 会用 `--icon-opacity` 把 `clickable-icon` 的字形调淡，而主题可以把那个值调低，一个被
		// 调淡的字形是墨色救不回来的。
		expect(browser).toMatch(/\.position-restore-nav-panel \{[^}]*--icon-color: var\(--text-normal\)/);
		expect(browser).toMatch(/\.position-restore-nav-panel \{[^}]*--icon-opacity: 1/);
		// ……还要再往下一个元素，因为一个把描边宽度作为**属性**带在身上的形状，不会从它上面的
		// 元素那里继承。
		const glyph = browser.match(
			/\.position-restore-nav-arrow svg,\n\.position-restore-nav-arrow svg \* \{[^}]*\}/,
		)?.[0] ?? '';
		expect(glyph).not.toBe('');
		expect(glyph).toMatch(/color: var\(--text-normal\)/);
		expect(glyph).toMatch(/stroke: currentColor/);
		expect(glyph).toMatch(/stroke-width: 2/);
		const off = browser.match(/\.position-restore-nav-arrow\.is-disabled \{[^}]*\}/)?.[0] ?? '';
		// 是**墨色**，不是这个文件自己的颜色：主题会随意改自己那些变量的色相，而一个置灰的
		// 按钮不该比一个活着的按钮更响。
		expect(off).toMatch(/opacity: 0\.35/);
		expect(off).not.toMatch(/color:/);
	});

	// 它们**立在列表下方 —— 每种设备都如此**，不只是手机：从前在顶上时它们站在筛选框
	// 旁边，而一只伸向框的手会落在箭头上。所以基础规则把它说一遍，DOM 也这么说（在 DOM
	// 套件里断言过）：不需要 `order`，而 Tab 到它们那里，跟眼睛到的地方一致。
	it('箭头放在列表下方，每种设备都放，不只是手机', () => {
		const strip = browser.match(/\.position-restore-nav-arrows \{[^}]*\}/)?.[0] ?? '';
		expect(strip).not.toBe('');
		// **居中**，不贴着列表左缘排：与上面那些行对齐的按钮，读起来像那些行里的一行。
		expect(strip).toMatch(/justify-content: center/);
		// ……而它们上方有一条**线**，于是一条站在五十行下面的带子，不会被读成其中一行。
		expect(strip).toMatch(/border-top: 1px solid var\(--background-modifier-border\)/);
		// 把它们放到最后的是 DOM，不是 `order` —— 那也是键盘唯一会读的顺序。（`\b` 是为了
		// 不匹配到 "border:"。）
		expect(browser).not.toMatch(/\border: 1/);
		// 宿主是 flex 列，于是长大的是列表、保住高度的是那条带子 —— 站在一个会滚的列表下面，
		// 要的就这些。
		const host = browser.match(/(?:^|\n)\.position-restore-nav-host \{[^}]*\}/)?.[0] ?? '';
		expect(host).toMatch(/display: flex/);
		expect(host).toMatch(/flex-direction: column/);
	});

	// 手机还**在它们下面留出地方**：app 自己的工具条立在手机屏幕底部，而一条贴着它的
	// 带子会读成它的一部分。
	it('箭头避开手机自己的工具条', () => {
		const touch = browser.match(
			/\.position-restore-nav-panel\.is-touch \.position-restore-nav-arrows \{[^}]*\}/,
		)?.[0] ?? '';
		expect(touch).not.toBe('');
		expect(touch).toMatch(/padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\)/);
	});

	// ……而桌面也**给它们留出自己的地方**，理由跟上一层一样：app 的状态栏是**浮**的，
	// 钉在窗口底部之上（app.css：`position: fixed; bottom: 0; right: 0`），所以常驻窗格
	// 的脚不是任何东西的脚 —— 它在那个栏下面。一条紧贴那个脚的带子，就是被栏盖住的带子。
	// 对话框一点都不需要它：它是居中的，离窗口的脚远得很。
	it('在够得到状态栏的面板里，把箭头抬离 app 自己的状态栏', () => {
		const pane = browser.match(
			/\.position-restore-nav-view \.position-restore-nav-arrows \{[^}]*\}/,
		)?.[0] ?? '';
		expect(pane).not.toBe('');
		expect(pane).toMatch(/padding-bottom: 34px/);
	});

	// ……但**左栏里不用**，那个栏从来够不到那里：它钉在窗口的右下角、按自己的内容定宽
	//（app.css：`right: 0`、`width: auto`），所以站在左边的窗格，脚就是屏幕自己的脚，而
	// 这四个下面留 34px 空气，等于把 34px 的窗格花在窗口另一边的那个栏上。
	it('左栏里的面板可以让箭头落到面板底部', () => {
		const left = browser.match(
			/(?:^|\n)\.mod-left-split \.position-restore-nav-arrows \{[^}]*\}/,
		)?.[0] ?? '';
		expect(left).not.toBe('');
		expect(left).toMatch(/padding-bottom: 8px/);
		// ……而且是靠**两个**类，不是三个：手机那条规则带三个类，必须在特指度上压过它 ——
		// app 在手机的 workspace 里也会放 `mod-left-split`，而那里带子下面的地方是工具条的，
		// 不是没有的。
		expect(left).not.toMatch(/is-touch/);
	});
});
