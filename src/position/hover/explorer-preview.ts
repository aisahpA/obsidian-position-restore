import { App } from 'obsidian';
import { PluginSettings } from '@/types';
import { CursorPositionDatabase } from '../storage/database';

// The id the app's own file list reports as the source of its hover ask. Every
// source funnels through the same workspace trigger, so this is what keeps the
// change to that one list.
const FILE_EXPLORER_SOURCE = 'file-explorer';

// The parts of a hover ask this module reads or writes — the event, the parent
// and the target element belong to the app.
interface HoverAsk {
	source?: string;
	linktext?: string;
	state?: { scroll?: number };
}

type Trigger = (name: string, ...data: unknown[]) => void;

// WHERE THE APP'S OWN FILE LIST OPENS ITS HOVER PREVIEW. Left alone it asks for
// the note and no position, so the card draws at the note's top — the app's own
// answer, and the default (see PluginSettings.fileExplorerPreviewFocus). Asked
// for the line, it is given the position this plugin last recorded for that
// FILE: not a landing out of the recent-files list, and not the line as it
// stands today, which is a re-derivation needing an async read this ask cannot
// wait for. A file changed elsewhere since may therefore open a line off from
// the one the reader left — the cost of answering synchronously.
export class ExplorerPreviewFocus {
	constructor(
		private app: App,
		private database: CursorPositionDatabase,
		private settings: PluginSettings,
	) {}

	install(registerCleanup: (fn: () => void) => void) {
		const workspace = this.app.workspace as unknown as { trigger: Trigger };
		const original = workspace.trigger;
		if (typeof original !== 'function')
			return;
		// A PATCH AND NOT A LISTENER: core's page-preview is itself only a
		// 'hover-link' listener, and it copies linktext and state out of the
		// payload before any listener of ours would run, so a payload edited
		// afterwards reaches nobody. The trigger is the one point ahead of that
		// copy, and it forwards untouched everything it does not mean to change.
		workspace.trigger = (name: string, ...data: unknown[]) => {
			if (name === 'hover-link')
				this.aim(data[0]);
			return original.call(workspace, name, ...data);
		};
		registerCleanup(() => {
			workspace.trigger = original;
		});
	}

	// Only a markdown note with a recorded position off the top is worth
	// pointing; everything else is left exactly as the app asked for it.
	private aim(payload: unknown): void {
		if (this.settings.fileExplorerPreviewFocus !== 'line')
			return;
		if (!payload || typeof payload !== 'object')
			return;
		const ask = payload as HoverAsk;
		if (ask.source !== FILE_EXPLORER_SOURCE || !ask.linktext || ask.state)
			return;
		const file = this.app.vault.getFileByPath(ask.linktext);
		if (!file || file.extension !== 'md')
			return;
		const st = this.database.db[file.path];
		if ((st?.scroll ?? 0) > 0)
			ask.state = { scroll: st.scroll };
	}
}
