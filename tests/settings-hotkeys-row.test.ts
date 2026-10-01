// The hotkeys row has to say WHERE a key can be bound, and it cannot say it by
// pointing at a side: the button is an extra button, so on a phone-width screen
// the app's own CSS wraps it BELOW the row and "the button on the right" would
// be pointing at nothing. What holds on both ends is what the button LOOKS
// like — a keyboard — so that is what the row says.
//
// These tests hold that line, plus two things the rewrite fixed with it: the
// instruction is said once for the whole row instead of after every unbound
// command, and a click that never reaches the hotkeys tab says so out loud
// instead of doing nothing.
import { describe, expect, it, beforeEach } from 'vitest';
import { Notice } from './support/obsidian-stub';
import { hotkeys } from '@/settings/page';
import { zh } from '@/i18n/locales/zh';

interface FakeButton {
	setIcon(icon: string): FakeButton;
	setTooltip(tip: string): FakeButton;
	onClick(fn: () => void): FakeButton;
}

// A row is rendered against the smallest object that answers everything the
// renderer asks of a Setting: somewhere to put the description, and a control
// slot for the button. The plugin under it is reduced to the two fields the
// row reads — the app it opens settings through, and its own manifest.
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

	// The hint belongs to the row, not to the commands: two commands must not
	// turn it into two copies of the same instruction.
	it('按键说明整行只印一次，不是每条命令印一次', () => {
		const { desc } = renderRow(undefined, commands);
		expect(countOccurrences(desc, 'Back: Not bound')).toBe(1);
		expect(countOccurrences(desc, 'Forward: Not bound')).toBe(1);
		expect(countOccurrences(desc, 'keyboard button on this row')).toBe(1);
	});

	// An unbound command used to carry the instruction itself ("click the
	// button on the right to set it up"). Now it carries only the fact.
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
		// The window first: switching tabs on one that is not showing changes
		// nothing the reader can see. (open() is a no-op on a window already
		// up, so this cannot stack a second modal.)
		expect(calls).toEqual(['open', 'hotkeys']);
		expect(queries).toEqual(['Position Restore']);
		expect(Notice.instances).toHaveLength(0);
	});

	// Arriving on the tab is the job; the query is a convenience it cannot
	// always do. A tab with no setQuery is still a tab the reader was sent to.
	it('拿到的 tab 没法预填查询时，什么也不说', () => {
		const { click } = renderRow({ open() {}, openTabById: () => ({}) }, commands);
		click();
		expect(Notice.instances).toHaveLength(0);
	});

	// A button that does nothing is worse than no button: the row promised a
	// way to bind a key, and the reader is left standing on it. Said AT ONCE —
	// a reader who has since closed the settings window must not be told a
	// second later about a failure that never happened.
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

// The Chinese string is the one that carried the direction: it read "点击右侧
// 按钮设置". Nothing in the hotkeys row may name a side, because which side the
// button ends up on is the app's layout, not the plugin's.
describe('热键那一行的中文文案', () => {
	const sideWords = ['右侧', '左边', '上面', '下面', '上方', '下方'];

	it('不提按钮可能在哪一侧', () => {
		for (const word of sideWords)
			for (const key of ['hotkeys.hint', 'hotkeys.unbound', 'hotkeys.openFailed'] as const)
				expect(zh[key]).not.toContain(word);
	});

	// What it names instead is the button's own look — the keyboard icon.
	it('按按钮长什么样来称呼它', () => {
		expect(zh['hotkeys.hint']).toContain('键盘按钮');
	});

	it('未绑定这个事实照实说', () => {
		expect(zh['hotkeys.unbound']).toBe('未绑定');
	});

	// "物理键盘", not "外接键盘": a soft keyboard cannot press a combination,
	// and a desktop keyboard is physical already — one sentence, both ends.
	it('只承诺一个已绑定的按键真能按下去的场合', () => {
		expect(zh['hotkeys.hint']).toContain('物理键盘');
	});
});
