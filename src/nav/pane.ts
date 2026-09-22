import { PaneType } from 'obsidian';

// Where a place is opened, when the reader asked for somewhere other than where
// the file already lives: a new tab, a split, a new window — or a plain boolean,
// which is the same question asked by the app's own `getLeaf(true)`.
//
// It is `PaneType | boolean` rather than a flag of ours because that is the app's
// own vocabulary and there is no reason to translate it twice: the value comes from
// `Keymap.isModEvent` (the browser) and goes straight to `workspace.getLeaf` (the
// open pipeline), both of which are Obsidian's. A local enum in the middle could
// only ever be a lossy copy of this one.
//
// It lives in the neutral layer because BOTH sides of the open port speak it: the
// place list asks for "somewhere else", the stack's pipeline answers where. Neither
// has to import the other for the word they share.
export type PaneTarget = PaneType | boolean;
