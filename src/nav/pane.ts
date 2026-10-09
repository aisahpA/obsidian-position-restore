import { PaneType } from 'obsidian';

// 读者要求把某个地点打开在「文件所属之处以外的别处」时，那个「别处」叫什么。
// 直接借用 app 自己的词汇（`Keymap.isModEvent` → `workspace.getLeaf`），
// 自己再起一个枚举只会是一份丢信息的抄本。放在中立层：打开这个口子的两边都说同一套词。
export type PaneTarget = PaneType | boolean;
