import { App, Notice, SettingGroupItem, Hotkey, Modifier, Platform } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { t } from '@/i18n';

// 设置页是它那份上下文的函数。每个页面由住在它所配置的功能旁边的函数建起来
// （position/、nav-history/、recent-files/），所以 `src/settings/` 只留与设置
// 「界面」本身有关的东西：这个 tab、下面两个行构造器，以及页面伸手去取的选择器。
//
// 这份上下文刻意做得小，每个成员都是页面少不了的许可：读设置、弹出一个模态框、
// 写「一个」设置，以及——对那个不走行、自己写库的模态框——把页面再画一次。
export interface SettingsPageContext {
	app: App;
	plugin: PositionRestorePlugin;
	// 写一个设置，再把页面画一次。调用它的全是刚改过本页某个列表的行。某个键该带来
	// 什么后果，刻意「不」放在这里：调低上限要修剪、新增文件夹规则要丢弃，两者都只在
	// 一个地方施加——`PositionManager.applyChangedSettings`，拿 tab 的快照做差分。
	setValue(key: string, value: unknown): Promise<void>;
	// 不写任何东西，只把页面画一次。只有数据库路径模态框需要它：它自己改完设置，再让
	// 页面跟上（见 DbPathModal 的 onApply）。其余的重画都发生在一次写入之后，走 setValue。
	refresh(): void;
}

// 页面自己的那句话，立在本页每一个向读者提问的行之上：这一页在说什么——任何一行都
// 替不了。它不是某一行的帮助文字，所以身边没有控件、自己也没有名字。
// `searchable: false` 让这条无名命中不进设置搜索。
export function intro(desc: string): SettingGroupItem {
	return {
		name: '',
		searchable: false,
		render: (setting) => {
			setting.setDesc(desc);
			setting.settingEl.addClass('position-restore-page-intro');
		},
	};
}

// 一行快捷键，为某个页面而建：先是它自己那句话，然后是「属于该页」的命令，以及每条
// 命令被绑到哪个键（以 app 报告的为准）。一条什么都没绑的命令也直说，这正是这一行
// 存在的意义——读者在这里知道这个功能到底有没有快捷键。旁边的按钮打开 app 自己的
// 快捷键设置，并预先筛到本插件。
//
// 提示只在列表之后印一次——否则两条命令会各重复一遍同样的话，读起来像唠叨。它按
// 按钮「长什么样」来指认它，绝不说它在哪一侧：手机窄屏上 app 的 CSS 会把按钮换行到
// 这一行「下方」，这时说「右边的按钮」就指向了空气。绑好的键只有物理键盘才按得出来。
export function hotkeys(
	plugin: PositionRestorePlugin,
	desc: string,
	commands: { id: string; name: string }[],
): SettingGroupItem {
	return {
		name: t('hotkeys.name'),
		render: (setting) => {
			const frag = createFragment();
			frag.createDiv({ text: desc });
			const list = frag.createEl('ul', { cls: 'mod-muted' });
			for (const command of commands)
				list.createEl('li', {
					text: `${command.name}: ${currentHotkeyText(plugin, command.id)}`,
				});
			frag.createDiv({ cls: 'mod-muted', text: t('hotkeys.hint') });
			setting.setDesc(frag);
			setting.addExtraButton((btn) => {
				btn.setIcon('keyboard').setTooltip(t('hotkeys.open'))
					.onClick(() => openHotkeySettings(plugin));
			});
		},
	};
}

// 把一条快捷键格式化：macOS 上用修饰键符号、别处用文字，次序按 Obsidian
// 规定的修饰键顺序。
function formatHotkey(hk: Hotkey): string {
	const isMac = Platform.isMacOS;
	const symbol: Record<Modifier, string> = {
		Mod: isMac ? '⌘' : 'Ctrl',
		Ctrl: isMac ? '⌃' : 'Ctrl',
		Meta: isMac ? '⌘' : 'Win',
		Shift: isMac ? '⇧' : 'Shift',
		Alt: isMac ? '⌥' : 'Alt',
	};
	const mods = (['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt'] as Modifier[])
		.filter((m) => hk.modifiers.includes(m))
		.map((m) => symbol[m]);
	const text = mods.join(isMac ? ' ' : '+');
	let keyShow;
	if (hk.key === 'ArrowLeft')
		keyShow = '←';
	else if (hk.key === 'ArrowRight')
		keyShow = '→';
	else
		keyShow = hk.key;
	return text ? `${text}${isMac ? ' ' : '+'}${keyShow}` : keyShow;
}

// （hotkeyManager 是运行时 API，公开类型定义里没有。）
function currentHotkeyText(plugin: PositionRestorePlugin, commandId: string): string {
	const manager = (plugin.app as unknown as {
		hotkeyManager?: { getHotkeys(id: string): Hotkey[] | null };
	}).hotkeyManager;
	const hotkeys = manager?.getHotkeys(`${plugin.manifest.id}:${commandId}`);
	if (!hotkeys || hotkeys.length === 0)
		return t('hotkeys.unbound');
	return hotkeys.map(formatHotkey).join(' / ');
}

// 把 Obsidian 的快捷键设置打开在本插件的命令上。
//
// 先 open()，再取 openTabById 交回的 tab——app 自己的插件行就是这么做的。open() 对
// 已经显示着的窗口是纯 no-op（它看自己容器的 parent 在不在），所以不会叠出第二个
// 模态框；它划开的是「在一个谁也看不见的窗口上切 tab」和「真正把它打开」。openTabById
// 当场返回那个 tab，没有就返回 null。不等它：重试定时器会活得比读者已经关掉的那个设置
// 窗口还久，然后报一个从未发生的失败。真就一直没来的 tab 就明说：点了不动的按钮，比
// 没有按钮更糟。
function openHotkeySettings(plugin: PositionRestorePlugin): void {
	const setting = (plugin.app as unknown as {
		setting?: {
			open(): void;
			openTabById(id: string): { setQuery?(query: string): void } | null;
		};
	}).setting;
	// 两种情形同一句话：当初许诺的是一条绑键的门路，读者眼前剩下的是结果，不是原因。
	if (!setting) {
		new Notice(t('hotkeys.openFailed'));
		return;
	}
	setting.open();
	const tab = setting.openTabById('hotkeys');
	if (!tab) {
		new Notice(t('hotkeys.openFailed'));
		return;
	}
	// 预填搜索是顺手之便，不是本职：就算这个 tab 没法预填，读者要去的也还是它。
	tab.setQuery?.(plugin.manifest.name);
}
