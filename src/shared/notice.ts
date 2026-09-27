import { Notice } from 'obsidian';

// Stays until dismissed (duration 0). Reserved for failures the user may not
// be watching when they happen and whose consequence outlives a toast — an
// unreadable data file. Ordinary confirmations keep the default timeout so the
// corner does not fill up.
export function stickyNotice(message: string): void {
	new Notice(message, 0);
}
