import type { App, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, TabStateRecord } from './types';
import { PositionState } from './position-state';
import type { CursorPositionDatabase } from './database';

// Device-local per-tab position records, backed by desktop localStorage.
// The class holds the shared coordination state (PositionState) and the
// per-file database, both injected by the caller, plus the tab persistence
// concerns: the startup read, the quit/suspend snapshot write, and the
// restore-record lookup used by every restore dispatch branch.
export class TabStore {
	private app: App;
	private database: CursorPositionDatabase;
	readonly state: PositionState;
	private lastPersistedTabs = '';

	constructor(app: App, database: CursorPositionDatabase, state: PositionState) {
		this.app = app;
		this.database = database;
		this.state = state;
		this.state.lastStateByLeaf = TabStore.loadLastStateByLeaf(app);
	}

	// Desktop localStorage is shared across vaults (same app origin); appId is
	// the per-vault discriminator. Not in the public typings.
	private storageKey(): string {
		const appId = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
		return `position-restore:tabs:${appId}`;
	}

	// Startup read. Static because it must run before the PositionState it
	// feeds exists.
	static loadLastStateByLeaf(app: App): Map<string, TabStateRecord> {
		try {
			const appId = (app as unknown as { appId?: string }).appId ?? app.vault.getName();
			const raw = window.localStorage.getItem(`position-restore:tabs:${appId}`);
			if (!raw)
				return new Map();

			// Storage holds a plain object (Map does not JSON round-trip):
			// rebuild the Map explicitly, dropping malformed entries
			// (no filePath/st) instead of trusting the parse.
			const parsed = JSON.parse(raw) as Record<string, TabStateRecord>;
			const records = new Map<string, TabStateRecord>();
			for (const [leafId, r] of Object.entries(parsed))
				if (r && typeof r.filePath === 'string' && r.st)
					records.set(leafId, r);
			return records;
		} catch (e) {
			// Unreadable storage: degrade to empty — restore falls back to the
			// per-file database for the whole session.
			console.error('Position Restore: can not read tab states:', e);
			return new Map();
		}
	}

	// The snapshot's single storage write (quit/suspend only; sync, no flush race).
	persistLastStateByLeaf(lastStateByLeaf: Map<string, TabStateRecord>): void {
		try {
			// Keep only the records that are shared by multiple leaves for the same filePath 
			// (single-tab entries are handled by the per-file database)
			const filePathCount = new Map<string, number>();
			for (const { filePath } of lastStateByLeaf.values())
				if (filePath)
					filePathCount.set(filePath, (filePathCount.get(filePath) ?? 0) + 1);
			const records: Record<string, TabStateRecord> = {};
			for (const [leafId, r] of lastStateByLeaf)
				if (r.filePath && (filePathCount.get(r.filePath) ?? 0) > 1)
					records[leafId] = r;
			// Map has no toJSON: JSON.stringify would silently emit "{}".
			const serialized = JSON.stringify(records);
			if (serialized === this.lastPersistedTabs)
				return;
			window.localStorage.setItem(this.storageKey(), serialized);
			this.lastPersistedTabs = serialized;
		} catch (e) {
			// Quota exceeded / storage disabled: records stay in memory, so the
			// current session still restores per-tab after a suspend.
			console.error('Position Restore: can not persist tab states:', e);
		}
	}

	// The restore-record lookup shared by every restore dispatch branch
	// (preview/masked/glide/injected): the per-tab record wins when present,
	// otherwise the per-file database entry.
	getRestoreSt(leaf: WorkspaceLeaf, filePath: string): EphemeralState {
		const r = this.state.lastStateByLeaf.get(this.state.leafId(leaf));
		return r && r.filePath === filePath ? r.st : this.database.db[filePath];
	}
}