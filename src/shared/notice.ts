import { Notice } from 'obsidian';

// A notice that stays until the user dismisses it (Obsidian's duration 0).
// Reserved for failures the user may not be watching when they happen and whose
// consequence outlives a toast — an unreadable data file, where records are
// either kept aside or already gone. Ordinary confirmations and input
// validation keep the default timeout so the corner does not fill up.
export function stickyNotice(message: string): void {
	new Notice(message, 0);
}
