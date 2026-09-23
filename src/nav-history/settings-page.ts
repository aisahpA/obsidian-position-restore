import { SettingDefinitionItem } from 'obsidian';
import { SettingsPageContext, intro, hotkeys } from '@/settings/page';
import { t } from '@/i18n';

// THE "BACK AND FORWARD" PAGE — the stack's own face in the settings. All three
// knobs on it are gates the stack itself consults (see stack.ts): how many steps
// it keeps, and which kinds of step it records at all. It stands beside the
// stack rather than in the settings folder for that reason — the file you change
// when you wonder why a step was or was not recorded is the same one you read
// here.
//
// One group with no heading, deliberately: the page is already named "Back and
// forward", and a group heading saying it again under itself is a line of chrome
// that names nothing the page has not.
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
