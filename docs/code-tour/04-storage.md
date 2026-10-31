# 04 存储与准入

## 这段是干什么的

位置记下来之后存在哪、怎么跨设备合并、多久写一次、以及**哪篇笔记根本就不该记**。

| 文件 | 职责 |
|---|---|
| `position/storage/database.ts` | 位置库文件（默认 `position-restore-data.json`）的文件拥有者：读写、合并、换库、裁剪、原子落盘、损坏恢复 |
| `position/storage/disk-format.ts` | 磁盘格式：字节 ↔ `CursorDatabase` 的编解码（纯函数） |
| `position/storage/atomic-file.ts` | 原子落盘工具：暂存 → 上一版轮转 → rename 就位，以及启动时补完被打断的落盘 |
| `position/storage/db-recovery.ts` | 读不懂的数据文件怎么善后：留副本、打捞、退上一版、只读降级与提示 |
| `position/storage/position-store.ts` | 两层外观：按文件（同步层）+ 按标签页（本机层） |
| `position/policy/exclusion.ts` | 总闸：这篇笔记该不该记 |
| `position/policy/frontmatter.ts` | frontmatter 那一路规则 |
| `position/path-bookkeeping.ts` | rename / delete 之后，所有按路径索引的记录怎么改键 |

## 入口在哪

- [`CursorPositionDatabase`](/src/position/storage/database.ts#L33)：[`setState`](/src/position/storage/database.ts#L249)、[`readDb`](/src/position/storage/database.ts#L317)、
  [`writeDb`](/src/position/storage/database.ts#L527)、[`mergeExternalChanges`](/src/position/storage/database.ts#L480)、[`switchDbFile`](/src/position/storage/database.ts#L125)、[`pruneDb`](/src/position/storage/database.ts#L198)、
  恢复三件套 [`recoverMissingDbFile`](/src/position/storage/database.ts#L355)、[`recoverFromUnreadableDb`](/src/position/storage/database.ts#L373)、[`writeDbFile`](/src/position/storage/database.ts#L582)。
- [`DatabaseRecovery`](/src/position/storage/db-recovery.ts#L19)：[`recover`](/src/position/storage/db-recovery.ts#L36)、[`preserve`](/src/position/storage/db-recovery.ts#L65)。
- [`atomic-file.ts`](/src/position/storage/atomic-file.ts#L1)：[`writeFileAtomically`](/src/position/storage/atomic-file.ts#L40)、
  [`finishInterruptedWrite`](/src/position/storage/atomic-file.ts#L75)、[`discardStagedFile`](/src/position/storage/atomic-file.ts#L106)、
  [`readFileIfParsable`](/src/position/storage/atomic-file.ts#L118)、`STAGING_DIR`。
- [`disk-format.ts:8`](/src/position/storage/disk-format.ts#L8)：[`parseDb`](/src/position/storage/disk-format.ts#L117)、[`salvageDb`](/src/position/storage/disk-format.ts#L180)、[`parseDbStrict`](/src/position/storage/disk-format.ts#L209)、[`encodeValue`](/src/position/storage/disk-format.ts#L56)、[`cursorIsDefault`](/src/position/storage/disk-format.ts#L44)、[`SCHEMA_VERSION`](/src/position/storage/disk-format.ts#L27)。
- [`PositionStore`](/src/position/storage/position-store.ts#L23)：[`read`](/src/position/storage/position-store.ts#L137)、[`write`](/src/position/storage/position-store.ts#L152)、
  [`persist`](/src/position/storage/position-store.ts#L256)、[`dropExcluded`](/src/position/storage/position-store.ts#L194)。
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
CursorPositionDatabase ──► disk-format.ts ──► .trash/position-restore/*.next（暂存，不同步）
        │                                        │ rename 就位（原子）
        │                                        ▼
        │                             position-restore-data.json（默认在插件目录内）
        ▼
每 5 秒 flush（[`registerDbFlush()`](/src/main.ts#L210)），退出时交给 app 的 Tasks
```

落盘永远是「写暂存 → 旧版进 `.trash/position-restore` → rename 就位」三步（[`atomic-file.ts`](/src/position/storage/atomic-file.ts#L1)），正式文件要么是旧的整份、要么是新的整份，
不会出现半截。切后台**不单独写盘**（挂起那一瞬正是移动端最可能被冻住的时刻）。

为什么要两层：**同一篇笔记开在两个标签页，是两个位置**。按文件的记录才是要跟设备走的那个；
按标签页的覆盖层只是本机的。

## 有哪些坑

**schema 现在的值是 3**（[`SCHEMA_VERSION`](/src/position/storage/disk-format.ts#L27)），形状是 `{schema:3, lastPositions:{path:{s?,c?,t?}}}`。
**只在形状变化时递增**，加可选字段不算 —— schema 1 用数组长度当类型标签，加不了字段。
**三种都读，只写 3**：schema 1 的平坦数组、schema 2 的 `positions` 容器都照旧读出来，下一次落盘整份写成 3
⇒ 把容器键从 `positions` 改名成 `lastPositions` 不丢位置。

**默认文件名也从 `positions.json` 改成 `position-restore-data.json`**，只在用的是默认位置时把旧文件搬过来
（[`migrateDefaultDbFileName()`](/src/position/storage/database.ts#L302)，搬字节、不重编码 —— 重编码要
`metadataCache`，而 `readDb()` 跑在它就绪之前，那时墓碑判定会不准）。
**自定义路径不碰**：那是用户选定的，升级后仍在原处，只靠上面的 schema 迁移。

**墓碑记录必须落盘**（[`database.ts:530`](/src/position/storage/database.ts#L530)、[`database.ts:539`](/src/position/storage/database.ts#L539)）：既无 `s` 又无 `c` 的记录表示「来过、停在顶部」。
它在恢复行为上与「从未有记录」等价（两种都停在 Obsidian 自己打开笔记的那一行），但仍然要写：它出现在记录数的统计里，
并且是容量上限优先淘汰的对象（见 `trimToLimit`）。

**容量 `MAX_ENTRIES = 750`，裁到 `TRIM_TARGET = 562`**（[`database.ts:19`](/src/position/storage/database.ts#L19)）：3/4 是滞后防抖。
墓碑优先出局，但最近 `TOMB_RECENT_WINDOW = 187` 条内豁免（[`database.ts:24`](/src/position/storage/database.ts#L24)）。

**默认光标行是 frontmatter 块之后那一行**（[`defaultCursorLine()`](/src/position/storage/database.ts#L435)）：实测 85% 的笔记这一行是空的。

**跨设备谁赢**：记录自带采集戳 `t`，**较新者胜、相等保留我方**（[`database.ts:456`](/src/position/storage/database.ts#L456)）。
四种「时间」别混：导航 push 的墙钟、笔记 mtime、db mtime、入库时刻。

**换库文件时做严格形状校验**（[`parseDbStrict()`](/src/position/storage/disk-format.ts#L209)）：只接受 `.md`/`.base` 键 ——
否则误选 `package.json` 会被当成空库，然后把真库删掉。

**解析失败不静默丢弃**（[`preserve()`](/src/position/storage/db-recovery.ts#L65)）：先按内容去重复制一份到插件目录旁，
再按结果弹一个不会自动消失的提示。提示文案只说真发生了的事：救回多少条、或者进入只读。
善后流程整个在 [`db-recovery.ts`](/src/position/storage/db-recovery.ts#L1)：它只给结论（救回/退上一版/救不回），
`database.ts` 负责把结论落到内存和「这一会话还写不写」。

**读不懂的文件按三级恢复，不写空库**（[`recoverFromUnreadableDb()`](/src/position/storage/database.ts#L373)，决策在 [`db-recovery.ts`](/src/position/storage/db-recovery.ts#L36)）：
先 [`salvageDb()`](/src/position/storage/disk-format.ts#L180) 从文件自身的可读前缀里打捞（同步工具截断/拼接时前面的记录通常还完整，
补上容器括号就能解析）；捞不出来再用 `.trash/position-restore` 里上一版；都救不回来才进**只读降级**（`readOnly`），
本会话不再写这个文件 —— 整份盖掉一份坏文件，只会让同步工具把损坏推到所有设备。
外部把文件换成能读的内容后，下一次合并自动解除降级。

**启动时补完上一次被打断的落盘**（[`recoverMissingDbFile()`](/src/position/storage/database.ts#L355)）：正式文件不在时，先看
`.trash/position-restore/<名>.next`（那次落盘只差最后一次 rename，内容完整），再看 `.prev`。

**暂存目录只能是 `.trash/position-restore`**（`STAGING_DIR`，在 [`atomic-file.ts`](/src/position/storage/atomic-file.ts#L10)）：
Obsidian Sync「隐藏文件夹不同步」，坚果云默认 filterRules 也含 `**/.trash`。放到 db 同目录会被当成内容同步，
写到一半被推上去又是一份坏文件。目录建不出来或跨目录 rename 不成立时，[`writeFileAtomically`](/src/position/storage/atomic-file.ts#L40)
退回整份直写一次（截断风险回来，但总比一条都存不下去好），控制台留一行警告 —— 真机上如果看到这行，
说明这台设备的暂存方案得换。

**不要改回整份 `adapter.write(dbPath, ...)`**：`adapter.rename` 在目标存在时会抛
`Destination file already exists!`，所以「覆盖」只能靠先挪走旧文件；中间那约 1ms 正式文件不存在，
由启动恢复兜住。内容与时机留在 [`database.writeDbFile`](/src/position/storage/database.ts#L582)，
文件动作都在 [`atomic-file.ts`](/src/position/storage/atomic-file.ts#L1) 里，两层别混。

**按 leaf 读要过路径守卫**（[`position-store.ts:139`](/src/position/storage/position-store.ts#L139)）：leaf 记录里的 `filePath` 必须与请求的
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
