import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro, hotkeys } from '@/settings/page';
import { t } from '@/i18n';

// 「前进与后退」页——栈在设置里的那张脸。上面的三个旋钮都是栈自己要问的闸门
// （见 stack.ts）：留多少步、以及到底记哪几种步。它站在栈旁边、而不是放进设置目录，
// 原因就在这：你琢磨「这一步为什么记/没记」时要去改的那个文件，就是你在这里读到的
// 这个。
//
// 刻意只有一个分组、且没有分组名：本页已经叫「前进与后退」，再在下面写一遍分组名
// 只是一行没说出任何新东西的装饰。
export function navHistorySettingsPage(ctx: SettingsPageContext): SettingDefinitionItem[] {
	return [
		{
			type: 'group',
			items: [
				intro(t('navHistory.intro')),
				hotkeys(ctx.plugin, t('navHistory.hotkeys.desc'), [
					{ id: 'navigate-back', name: t('navHistory.commands.navigateBack') },
					{ id: 'navigate-forward', name: t('navHistory.commands.navigateForward') },
				]),
				{
					name: t('navHistory.stackCap.name'),
					desc: t('navHistory.stackCap.desc'),
					control: {
						type: 'number',
						key: 'navHistoryCap',
						min: 10,
						max: 500,
						step: 1,
					},
				},
				{
					name: t('navHistory.recordActivation.name'),
					desc: t('navHistory.recordActivation.desc'),
					control: {
						type: 'toggle',
						key: 'navHistoryRecordActivation',
					},
				},
				{
					name: t('navHistory.teleportMinLines.name'),
					desc: t('navHistory.teleportMinLines.desc'),
					control: {
						type: 'number',
						key: 'navHistoryTeleportMinLines',
						min: 0,
						max: 500,
						step: 1,
					},
				},
			],
		},
	];
}
