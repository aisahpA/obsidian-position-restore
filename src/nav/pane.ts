import { PaneType } from 'obsidian';

// Where a place is opened when the reader asked for somewhere other than where
// the file lives. The app's own vocabulary (`Keymap.isModEvent` →
// `workspace.getLeaf`), so a local enum would only be a lossy copy. Neutral
// layer: both sides of the open port speak it.
export type PaneTarget = PaneType | boolean;
