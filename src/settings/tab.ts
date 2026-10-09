import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type PositionRestorePlugin from '@/main';
import { positionSettingsPage } from '@/position/settings-page';
import { navHistorySettingsPage } from '@/nav-history/settings-page';
import { recentFilesSettingsPage } from '@/recent-files/settings-page';
import { SettingsPageContext } from './page';
import { t } from '@/i18n';

// 设置界面——框架认得的是这个 tab，加上三个页面共用的行构造器与选择器（page.ts、pickers.ts）。
// 各个页面住在它们所配置的功能旁边。
//
// 本文件是个「装配工」：getSettingDefinitions、getControlValue 和 setControlValue 是
// PluginSettingTab 的重写（@since 1.13.0），app 会在这个类的实例上调用它们，因此它们永远
// 搬不到别处。剩下的只是把三个页面点出来，对其内部一无所知。

// 常驻面板「作画依据」的偏好项（见 RecentFilesBrowserPrefs）。改动其中一项不欠任何派生状态
// ——面板是实时读它们的——但此刻开着的面板是用旧值画的，得请它重画一次。这份名单站在这里、
// 而不进 manager 的差分表，原因就在这：那张表做的是重新施加 store 持有的状态，而这里是请
// 一个视图去画。
const BROWSER_PREF_KEYS = new Set([
	'recentFilesOutlineSearch', 'recentFilesPathDisplay', 'recentFilesRowTime',
	'recentFilesTitleProperty',
]);

// 改的是「页面的形状」而不是页面上某个值的键——后果是某一行出现或不出现，或某句话读起来变了。
// 框架只写控件的值、不回调任何东西，所以这几个键的写入得自己去要重画（见 setControlValue）；
// 其余每个键改的只是一个数字或一个答案，持有它的那一行本来就带着新值。
const PAGE_SHAPE_KEYS = new Set<string>();

export class SettingTab extends PluginSettingTab {
	plugin: PositionRestorePlugin;

	constructor(app: App, plugin: PositionRestorePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	// 「唯一」的写入路径，也是唯一知道「写某个键会欠下什么后果」的地方——那是一次差分，不是
	// 一次查表：不点名的写入（手工改过的 data.json、同步落下来的）也得由同一张表来应对，而只有
	// 差分能同时应对两者。所以 tab 先拍快照、写入、把快照交出去；由 manager 那张表定夺。
	//
	// 快照刻意是浅的。这里没有任何就地修改数组的动作——文件夹列表永远整份替换——所以写入前的
	// 数组保持自身身份，manager 的逐元素比较也就仍是「比值」；对外部写入产生的、由 JSON.parse
	// 现建出来的数组来说，这一点是必须的（见 PositionManager.sameList）。
	async setControlValue(key: string, value: unknown): Promise<void> {
		const before = { ...this.plugin.settings };
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		this.plugin.manager.applyChangedSettings(before);
		if (BROWSER_PREF_KEYS.has(key))
			this.plugin.manager.refreshNavPanels();
		await this.plugin.saveSettings();
		// 在保存「之后」才要：重画会拿设置把每个页面重新建一遍，所以它必须看到刚写进去的那个
		// 值——而且必须在这里要，因为框架自己的写入路径在本方法就结束了，别处不会再回调进 tab。
		if (PAGE_SHAPE_KEYS.has(key))
			this.update();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const ctx = this.pageContext();
		return [
			{
				type: 'page',
				name: t('lastPosition.heading'),
				items: positionSettingsPage(ctx),
			},
			{
				type: 'page',
				name: t('navHistory.heading'),
				items: navHistorySettingsPage(ctx),
			},
			{
				type: 'page',
				name: t('recentFiles.name'),
				items: recentFilesSettingsPage(ctx),
			},
		] as SettingDefinitionItem[];
	}

	// 交给页面的东西。每次调用现重建、不存成字段：它是一组读取器加上本类已有的两个方法，
	// 里面没有状态可留——而字段得在构造函数里创建，那时 PluginSettingTab 还没处理完自己的事。
	private pageContext(): SettingsPageContext {
		return {
			app: this.app,
			plugin: this.plugin,
			// setControlValue 已经施加了该键的后果；页面只是在上面加一次重画，因为它刚改过的
			// 列表就在它正看着的这一页上。
			setValue: async (key, value) => {
				await this.setControlValue(key, value);
				this.update();
			},
			refresh: () => this.update(),
		};
	}
}
