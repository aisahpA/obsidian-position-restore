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
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
	openTabById(id: string): void;
	activeTab?: { id?: string; setQuery?(query: string): void };
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

// 20 retries at 50ms — see settings/page's openHotkeySettings.
const RETRY_BUDGET_MS = 20 * 50 + 200;

describe('hotkeys row', () => {
	beforeEach(() => {
		Notice.reset();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const commands = [
		{ id: 'navigate-back', name: 'Back' },
		{ id: 'navigate-forward', name: 'Forward' },
	];

	// The hint belongs to the row, not to the commands: two commands must not
	// turn it into two copies of the same instruction.
	it('prints the binding instruction once for the row, not once per command', () => {
		const { desc } = renderRow(undefined, commands);
		expect(countOccurrences(desc, 'Back: Not bound')).toBe(1);
		expect(countOccurrences(desc, 'Forward: Not bound')).toBe(1);
		expect(countOccurrences(desc, 'keyboard button on this row')).toBe(1);
	});

	// An unbound command used to carry the instruction itself ("click the
	// button on the right to set it up"). Now it carries only the fact.
	it('leaves an unbound command at just "Not bound"', () => {
		const { desc } = renderRow(undefined, [commands[0]]);
		expect(desc).toContain('Back: Not bound');
		expect(desc).not.toContain('Not bound —');
	});

	it('opens the hotkeys tab already filtered to this plugin', () => {
		const opened: string[] = [];
		const queries: string[] = [];
		const { click } = renderRow({
			openTabById(id) {
				opened.push(id);
			},
			activeTab: {
				id: 'hotkeys',
				setQuery(query) {
					queries.push(query);
				},
			},
		}, commands);
		click();
		expect(opened).toEqual(['hotkeys']);
		expect(queries).toEqual(['Position Restore']);
		expect(Notice.instances).toHaveLength(0);
	});

	// Arriving on the tab is the job; the query is a convenience it cannot
	// always do. A tab with no setQuery is still a tab the reader was sent to.
	it('says nothing when the tab arrives without a way to prefill the query', () => {
		const { click } = renderRow({
			openTabById() {},
			activeTab: { id: 'hotkeys' },
		}, commands);
		click();
		expect(Notice.instances).toHaveLength(0);
	});

	// A button that does nothing is worse than no button: the row promised a
	// way to bind a key, and the reader is left standing on it.
	it('says so when the click never lands on the hotkeys tab', () => {
		vi.useFakeTimers();
		const { click } = renderRow({
			openTabById() {},
			activeTab: { id: 'about' },
		}, commands);
		click();
		expect(Notice.instances).toHaveLength(0);
		vi.advanceTimersByTime(RETRY_BUDGET_MS);
		expect(Notice.instances).toHaveLength(1);
		expect(Notice.instances[0].message).toContain('Settings → Hotkeys');
	});

	it('says so when there is no settings surface at all', () => {
		vi.useFakeTimers();
		const { click } = renderRow(undefined, commands);
		click();
		vi.advanceTimersByTime(RETRY_BUDGET_MS);
		expect(Notice.instances).toHaveLength(1);
	});
});

// The Chinese string is the one that carried the direction: it read "点击右侧
// 按钮设置". Nothing in the hotkeys row may name a side, because which side the
// button ends up on is the app's layout, not the plugin's.
describe('hotkeys row copy, in Chinese', () => {
	const sideWords = ['右侧', '左边', '上面', '下面', '上方', '下方'];

	it('names no side the button could stand on', () => {
		for (const word of sideWords)
			for (const key of ['hotkeys.hint', 'hotkeys.unbound', 'hotkeys.openFailed'] as const)
				expect(zh[key]).not.toContain(word);
	});

	// What it names instead is the button's own look — the keyboard icon.
	it('names the button by what it looks like', () => {
		expect(zh['hotkeys.hint']).toContain('键盘按钮');
	});

	it('leaves the unbound fact alone', () => {
		expect(zh['hotkeys.unbound']).toBe('未绑定');
	});

	// "物理键盘", not "外接键盘": a soft keyboard cannot press a combination,
	// and a desktop keyboard is physical already — one sentence, both ends.
	it('promises only what a bound key can actually be pressed on', () => {
		expect(zh['hotkeys.hint']).toContain('物理键盘');
	});
});
