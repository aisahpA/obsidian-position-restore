# 04 存储与准入

## 这段是干什么的

位置记下来之后存在哪、怎么跨设备合并、多久写一次、以及**哪篇笔记根本就不该记**。

| 文件 | 职责 |
|---|---|
| `position/storage/database.ts` | `positions.json` 的文件层：读写、合并、裁剪、损坏保护 |
| `position/storage/position-store.ts` | 两层外观：按文件（同步层）+ 按标签页（本机层） |
| `position/policy/exclusion.ts` | 总闸：这篇笔记该不该记 |
| `position/policy/frontmatter.ts` | frontmatter 那一路规则 |
| `position/path-bookkeeping.ts` | rename / delete 之后，所有按路径索引的记录怎么改键 |

## 入口在哪

- [`CursorPositionDatabase`](/src/position/storage/database.ts#L115)：[`setState`](/src/position/storage/database.ts#L330)、[`readDb`](/src/position/storage/database.ts#L378)、
  [`writeDb`](/src/position/storage/database.ts#L633)、[`mergeExternalChanges`](/src/position/storage/database.ts#L591)、[`switchDbFile`](/src/position/storage/database.ts#L209)、[`pruneDb`](/src/position/storage/database.ts#L279)。
- [`PositionStore`](/src/position/storage/position-store.ts#L22)：[`read`](/src/position/storage/position-store.ts#L136)、[`write`](/src/position/storage/position-store.ts#L151)、
  [`persist`](/src/position/storage/position-store.ts#L255)、[`dropExcluded`](/src/position/storage/position-store.ts#L193)。
- [`ExclusionChecker`](/src/position/policy/exclusion.ts#L8)：[`shouldSkipRecording`](/src/position/policy/exclusion.ts#L17)。
- [`PathBookkeeper`](/src/position/path-bookkeeping.ts#L34)：`renameFile`（[`renameFile()`](/src/position/path-bookkeeping.ts#L53)）、`deleteFile`（[`deleteFile()`](/src/position/path-bookkeeping.ts#L65)）、
  [`sweepMissingHistory`](/src/position/path-bookkeeping.ts#L91)。

## 数据怎么流

```
Sampler / Restorer / BackgroundSettler
        │  只跟 PositionStore 说话
        ▼
PositionStore ──► 按 leaf 的覆盖层（localStorage，同步写）
        │
        ▼
CursorPositionDatabase ──► positions.json（默认在插件目录内）
        │
        ▼
每 5 秒 flush（[`registerDbFlush()`](/src/main.ts#L211)），退出时交给 app 的 Tasks
```

为什么要两层：**同一篇笔记开在两个标签页，是两个位置**。按文件的记录才是要跟设备走的那个；
按标签页的覆盖层只是本机的。

## 有哪些坑

**schema 现在的值是 2**（[`SCHEMA_VERSION`](/src/position/storage/database.ts#L29)），形状是 `{schema:2, positions:{path:{s?,c?,t?}}}`。
**只在形状变化时递增**，加可选字段不算 —— schema 1 用数组长度当类型标签，加不了字段。

**墓碑记录必须落盘**（[`database.ts:649`](/src/position/storage/database.ts#L649)、[`database.ts:658`](/src/position/storage/database.ts#L658)）：既无 `s` 又无 `c` 的记录表示「来过、停在顶部」。
它在恢复行为上与「从未有记录」等价（两种都停在 Obsidian 自己打开笔记的那一行），但仍然要写：它出现在记录数的统计里，
并且是容量上限优先淘汰的对象（见 `trimToLimit`）。

**容量 `MAX_ENTRIES = 750`，裁到 `TRIM_TARGET = 562`**（[`database.ts:12`](/src/position/storage/database.ts#L12)）：3/4 是滞后防抖。
墓碑优先出局，但最近 `TOMB_RECENT_WINDOW = 187` 条内豁免（[`database.ts:17`](/src/position/storage/database.ts#L17)）。

**默认光标行是 frontmatter 块之后那一行**（[`defaultCursorLine()`](/src/position/storage/database.ts#L496)）：实测 85% 的笔记这一行是空的。

**跨设备谁赢**：记录自带采集戳 `t`，**较新者胜、相等保留我方**（[`database.ts:575`](/src/position/storage/database.ts#L575)）。
四种「时间」别混：导航 push 的墙钟、笔记 mtime、db mtime、入库时刻。

**换库文件时做严格形状校验**（[`database.ts:550`](/src/position/storage/database.ts#L550)）：只接受 `.md`/`.base` 键 ——
否则误选 `package.json` 会被当成空库，然后把真库删掉。

**解析失败不静默丢弃**（[`preserveUnreadableDb()`](/src/position/storage/database.ts#L511)）：先复制一份到插件目录旁，再弹一个不会自动消失的提示。

**按 leaf 读要过路径守卫**（[`position-store.ts:138`](/src/position/storage/position-store.ts#L138)）：leaf 记录里的 `filePath` 必须与请求的
path 一致才用，否则退回文件记录 —— 防止已经切走的 leaf 去定位别的文件。

**落盘只写真正分叉的 leaf 记录**（[`position-store.ts:258`](/src/position/storage/position-store.ts#L258)）：稳态下「一个标签页一个文件」
根本不写 localStorage。

**`position-restore: true` 是逃生舱**（[`exclusion.ts:22`](/src/position/policy/exclusion.ts#L22)）：压过排除文件夹、最小行数、
B 规则。字符串 `"true"/"false"` 也算（[`frontmatter.ts:39`](/src/position/policy/frontmatter.ts#L39)），因为属性面板存文本值会带引号。
**最近文件列表故意不读这个逃生舱**（[`recordable()`](/src/recent-files/places.ts#L225)）—— 那是「要不要记位置」，
与「是不是读者去过的地方」是两件事。

**元数据没解析完时返回 `undefined` = 无决定**（[`frontmatter.ts:73`](/src/position/policy/frontmatter.ts#L73)）：
调用方下次再看，**不许缓存错误答案**。

**删除不能当场执行**（[`path-bookkeeping.ts:10`](/src/position/path-bookkeeping.ts#L10)）：同一个 `delete` 事件既表示用户真删，
也表示同步插件「删掉再改名覆盖」的前半步。所以排期 `DELETE_PRUNE_GRACE_MS = 10s` 后由 vault 仲裁；
rename 或 create 一到就取消排期。启动时只扫导航 store，**不动位置记录**（[`sweepMissingHistory()`](/src/position/path-bookkeeping.ts#L91)）——
db 是同步文件，本设备还没物化的文件不能抹掉别的设备还要用的位置。

## 怎么验证它没坏

- `npx vitest run tests/database.test.ts`、`position-store.test.ts`
- `npx vitest run tests/frontmatter-rules.test.ts`（覆盖 `shared/frontmatter.ts`）
- `npx vitest run tests/path-bookkeeping.test.ts`、`manager-path-bookkeeping.test.ts`
- ⚠️ `policy/` 两个文件**目前没有独立测试**，动它们之前先补测试。
