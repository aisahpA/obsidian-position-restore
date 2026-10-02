// 热键那一行必须说出按键可以绑在**哪里**，而它不能靠指某一侧来说：那个按钮是个额外按钮，
// 所以在手机宽度的屏幕上 app 自己的 CSS 会把它折到这一行**下面**，「右边那个按钮」就成了
// 指着空气。两端都成立的是按钮**长什么样** —— 一个键盘 —— 所以这一行说的就是它。
//
// 这些测试守住这条线，外加这次重写随之修好的两件事：说明整行只说一次，而不是每条未绑定的
// 命令后面都说一遍；以及一次没能落到热键标签页上的点击会大声说出来，而不是什么都不做。
import { describe, expect, it, beforeEach } from 'vitest';
import { Notice } from './support/obsidian-stub';
import { hotkeys } from '@/settings/page';
import { zh } from '@/i18n/locales/zh';

interface FakeButton {
	setIcon(icon: string): FakeButton;
	setTooltip(tip: string): FakeButton;
	onClick(fn: () => void): FakeButton;
}

// 这一行是对着一个最小的对象渲染的，它回答渲染器向 Setting 问的一切：一个放说明的地方，
// 以及一个给按钮的控制槽。它底下那个插件被削减到这一行会读的两个字段 —— 它据以打开设置
// 的 app，以及它自己的 manifest。
function renderRow(setting: {
	open(): void;
	openTabById(id: string): { setQuery?(query: string): void } | null;
} | undefined, commands: { id: string; name: string }[]): {
	desc: string;
	click: () => void;
} {
	const item = hotkeys(
		{ app: { setting }, manifest: { id: 'position-restore', name: 'Position Restore' } } as unknown as Parameters<typeof hotkeys>[0],
		'what these commands do',
		commands,
	) as unknown as { render(setting: unknown): void };
	let text = '';
	let click: () => void = () => {};
	item.render({
		setDesc(frag: DocumentFragment) {
			text = frag.textContent ?? '';
		},
		addExtraButton(build: (btn: FakeButton) => void) {
			const btn: FakeButton = {
				setIcon() {
					return btn;
				},
				setTooltip() {
					return btn;
				},
				onClick(fn) {
					click = fn;
					return btn;
				},
			};
			build(btn);
		},
	});
	return { desc: text, click };
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe('热键那一行', () => {
	beforeEach(() => {
		Notice.reset();
	});

	const commands = [
		{ id: 'navigate-back', name: 'Back' },
		{ id: 'navigate-forward', name: 'Forward' },
	];

	// 这条提示属于**这一行**，不属于那些命令：两条命令不该把它变成同一条说明的两份拷贝。
	it('按键说明整行只印一次，不是每条命令印一次', () => {
		const { desc } = renderRow(undefined, commands);
		expect(countOccurrences(desc, 'Back: Not bound')).toBe(1);
		expect(countOccurrences(desc, 'Forward: Not bound')).toBe(1);
		expect(countOccurrences(desc, 'keyboard button on this row')).toBe(1);
	});

	// 一条未绑定的命令从前会自己带着那条说明（「点击右侧按钮来设置」）。现在它只带那个事实。
	it('没有绑定按键的命令就只写「未绑定」', () => {
		const { desc } = renderRow(undefined, [commands[0]]);
		expect(desc).toContain('Back: Not bound');
		expect(desc).not.toContain('Not bound —');
	});

	it('先把设置窗口抬起来，再切到热键页，并按本插件名过滤', () => {
		const calls: string[] = [];
		const queries: string[] = [];
		const { click } = renderRow({
			open() {
				calls.push('open');
			},
			openTabById(id) {
				calls.push(id);
				return {
					setQuery(query) {
						queries.push(query);
					},
				};
			},
		}, commands);
		click();
		// 先开窗口：在一个没显示的窗口上切标签页，改变不了读者看得见的任何东西。（对一个已经
		// 开着的窗口，open() 是空操作，所以这不会叠出第二个模态框。）
		expect(calls).toEqual(['open', 'hotkeys']);
		expect(queries).toEqual(['Position Restore']);
		expect(Notice.instances).toHaveLength(0);
	});

	// 抵达那个标签页才是正事；预填查询只是它做不到每次都行的便利。一个没有 setQuery 的
	// 标签页，仍然是读者被送去的标签页。
	it('拿到的 tab 没法预填查询时，什么也不说', () => {
		const { click } = renderRow({ open() {}, openTabById: () => ({}) }, commands);
		click();
		expect(Notice.instances).toHaveLength(0);
	});

	// 一个什么都不做的按钮比没有按钮更糟：这一行承诺了一条绑键的路，而读者就停在那儿了。
	// **当场**说 —— 一个此后已经关掉设置窗口的读者，不该过一秒再被告知一次从未发生的失败。
	it('点击没落到热键 tab 上时当场说明', () => {
		const { click } = renderRow({ open() {}, openTabById: () => null }, commands);
		click();
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain('Settings → Hotkeys');
	});

	it('压根没有设置窗口时也照样说明', () => {
		const { click } = renderRow(undefined, commands);
		click();
		expect(Notice.instances).toHaveLength(1);
	});
});

// 中文串就是那个带着方向的那一条：它写的是「点击右侧按钮设置」。热键这一行里不许有任何
// 东西指认某一侧，因为按钮最终落在哪一侧是 app 的排版，不是插件的。
describe('热键那一行的中文文案', () => {
	const sideWords = ['右侧', '左边', '上面', '下面', '上方', '下方'];

	it('不提按钮可能在哪一侧', () => {
		for (const word of sideWords)
			for (const key of ['hotkeys.hint', 'hotkeys.unbound', 'hotkeys.openFailed'] as const)
				expect(zh[key]).not.toContain(word);
	});

	// 它改而指认的是按钮自己的样子 —— 那个键盘图标。
	it('按按钮长什么样来称呼它', () => {
		expect(zh['hotkeys.hint']).toContain('键盘按钮');
	});

	it('未绑定这个事实照实说', () => {
		expect(zh['hotkeys.unbound']).toBe('未绑定');
	});

	// 是「物理键盘」，不是「外接键盘」：软键盘按不出一个组合键，而桌面键盘本来就是物理的 ——
	// 一句话，两端都照顾到。
	it('只承诺一个已绑定的按键真能按下去的场合', () => {
		expect(zh['hotkeys.hint']).toContain('物理键盘');
	});
});
