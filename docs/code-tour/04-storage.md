# 04 存储与准入

## 这段是干什么的

位置记下来之后存在哪、怎么跨设备合并、多久写一次、以及**哪篇笔记根本就不该记**。还有一件 2026-11-02 的定案要说清：位置库文件读不懂或读不了时会发生什么。

| 文件 | 职责 |
|---|---|
| `position/storage/database.ts` | 位置库文件（默认 `position-restore-data.json`）的文件拥有者：读写、跨设备合并、换库、裁剪、落盘时机与提示 |
| `position/storage/disk-format.ts` | 磁盘格式：字节与 `CursorDatabase` 之间的纯编解码，schema 1/2/3 都读、只写 3 |
| `position/storage/atomic-file.ts` | 写盘工具：只负责「怎么写才不留下半截文件」，写暂存、rename 就位、启动补完，暂存那套用不了时退回整份直写 |
| `position/storage/position-store.ts` | 两层门面：按文件（同步层）+ 按标签页（本机层） |
| `position/policy/exclusion.ts` | 总闸：这篇笔记该不该记 |
| `position/policy/frontmatter.ts` | frontmatter 那一路规则 |
| `position/path-bookkeeping.ts` | rename / delete 之后，所有按路径索引的记录怎么改键 |

`position/storage/` 现在只有四个文件：`database.ts`（库的文件拥有者）、`disk-format.ts`（纯编解码）、`atomic-file.ts`（写盘工具）、`position-store.ts`（两层门面）。`db-recovery.ts` 已经在这次简化里删掉了：位置数据不是重要数据，为「坏文件也要救」养一套打捞、上一版与只读降级不划算，坏文件现在归零重来，但必须让用户知道（见「有哪些坑」）。

## 入口在哪

- [`CursorPositionDatabase`](/src/position/storage/database.ts#L38)：读 [`readDb`](/src/position/storage/database.ts#L321)、写 [`writeDb`](/src/position/storage/database.ts#L547)、合并 [`mergeExternalChanges`](/src/position/storage/database.ts#L500)、换库 [`switchDbFile`](/src/position/storage/database.ts#L132)、裁剪 [`pruneDb`](/src/position/storage/database.ts#L202)、记录 [`setState`](/src/position/storage/database.ts#L253)。
- 落盘那条链：[`writeDbPass`](/src/position/storage/database.ts#L555) 管时机，[`encodeDb`](/src/position/storage/database.ts#L590) 编码，[`writeDbFile`](/src/position/storage/database.ts#L606) 自检后交给 `atomic-file`。
- 启动与容错：补完被打断的落盘 [`recoverMissingDbFile`](/src/position/storage/database.ts#L361)、读不懂或读不了时 [`resetUnreadableDb`](/src/position/storage/database.ts#L381)、建父文件夹 [`ensureDbFolder`](/src/position/storage/database.ts#L101)、版本不一致的提示 [`noteSchema`](/src/position/storage/database.ts#L404)、一次性搬旧默认文件名 [`migrateDefaultDbFileName`](/src/position/storage/database.ts#L306)。
- [`atomic-file.ts`](/src/position/storage/atomic-file.ts#L1)：[`writeFileAtomically`](/src/position/storage/atomic-file.ts#L35)、[`finishInterruptedWrite`](/src/position/storage/atomic-file.ts#L64)、[`discardStagedFile`](/src/position/storage/atomic-file.ts#L90)、[`readFileIfParsable`](/src/position/storage/atomic-file.ts#L102)、[`stagedPath`](/src/position/storage/atomic-file.ts#L20)、[`STAGING_DIR`](/src/position/storage/atomic-file.ts#L16)。
- [`disk-format.ts`](/src/position/storage/disk-format.ts#L1)：[`CursorDatabase`](/src/position/storage/disk-format.ts#L8)、解析 [`parseDb`](/src/position/storage/disk-format.ts#L117)、按 schema 的解析器 [`parseSchema1`](/src/position/storage/disk-format.ts#L152)、[`parseSchema2`](/src/position/storage/disk-format.ts#L168)、[`parseSchema3`](/src/position/storage/disk-format.ts#L183)、换库时的严格校验 [`parseDbStrict`](/src/position/storage/disk-format.ts#L199)、编码 [`encodeValue`](/src/position/storage/disk-format.ts#L56)、默认光标判定 [`cursorIsDefault`](/src/position/storage/disk-format.ts#L44)、[`SCHEMA_VERSION`](/src/position/storage/disk-format.ts#L27)。
- [`PositionStore`](/src/position/storage/position-store.ts#L23)：[`read`](/src/position/storage/position-store.ts#L137)、[`write`](/src/position/storage/position-store.ts#L152)、[`persist`](/src/position/storage/position-store.ts#L260)、[`dropExcluded`](/src/position/storage/position-store.ts#L194)。
- [`ExclusionChecker`](/src/position/policy/exclusion.ts#L8) 的 [`shouldSkipRecording`](/src/position/policy/exclusion.ts#L17)；[`PathBookkeeper`](/src/position/path-bookkeeping.ts#L34) 的 [`renameFile`](/src/position/path-bookkeeping.ts#L53)、[`deleteFile`](/src/position/path-bookkeeping.ts#L65)、[`sweepMissingHistory`](/src/position/path-bookkeeping.ts#L91)。

## 数据怎么流

```
Sampler / Restorer / BackgroundSettler
        │  只跟 PositionStore 说话
        ▼
PositionStore ──► 按 leaf 的覆盖层（localStorage，同步写，只存有分歧的记录）
        │
        ▼
CursorPositionDatabase ──► disk-format.ts（把整份库编码成 JSON）
        │
        ▼
.trash/position-restore/<db 基名>.next（暂存，不在同步范围）
        │ 删正式文件 → rename 就位
        ▼
position-restore-data.json（默认在插件目录内）
        ▼
每 5 秒 flush（[`registerDbFlush()`](/src/main.ts#L210)）：先 mergeExternalChanges 再 storePositionData；退出时交给 app 的 Tasks
```

默认落盘是「写暂存 → 删正式文件 → rename 就位」三步（[`writeFileAtomically`](/src/position/storage/atomic-file.ts#L35)），正式文件要么是旧的整份、要么是新的整份，不会出现半截；刻意不留「上一版」，既然坏文件归零重来，那份退路已经没有读者。真正写盘之前 [`writeDbFile`](/src/position/storage/database.ts#L606) 还会先 [`parseDb`](/src/position/storage/disk-format.ts#L117) 自检一遍，写出去的东西必须能按同一套规则读回来。暂存目录建不出来或跨目录 rename 不成立时，退回整份直写一次（截断风险回来，但总比一条都存不下去好）。

启动读取（[`readDb`](/src/position/storage/database.ts#L321)）的顺序是：先把旧默认文件名 `positions.json` 一次性搬成 `position-restore-data.json`（只搬字节、不重编码，[`migrateDefaultDbFileName`](/src/position/storage/database.ts#L306)），再 stat 正式文件缓存它的 mtime；正式文件不在就看 `.next` 能不能扶正（[`recoverMissingDbFile`](/src/position/storage/database.ts#L361)）；在就整份读出来解析（[`parseDb`](/src/position/storage/disk-format.ts#L117)），成功之后清掉上次落盘留下的暂存残渣（[`discardStagedFile`](/src/position/storage/atomic-file.ts#L90)），失败则进 [`resetUnreadableDb`](/src/position/storage/database.ts#L381)。

为什么要两层：**同一篇笔记开在两个标签页，是两个位置**。按文件的记录才是要跟设备走的那个；按标签页的覆盖层只在本机，而且只持久化真正的分歧（与文件记录不一样的那些 leaf 记录），稳态下一个文件只开一个标签页时根本不写 localStorage。

5 秒心跳（[`registerDbFlush()`](/src/main.ts#L210)）每个 tick 固定先 [`mergeExternalChanges`](/src/position/storage/database.ts#L500) 再 [`storePositionData`](/src/position/manager.ts#L184)：同步工具会在我们脚下把库文件整个换掉，不先合并，整份写入就会把外来记录冲掉。合并不能等落盘时顺带做，因为库没脏的时候压根走不到写入，而一个只读会话可以无限期保持干净，外来记录就得干等着。mtime 没变时这次检查只是一次 `stat()`。

## 有哪些坑

**schema 现在的值是 3**（[`SCHEMA_VERSION`](/src/position/storage/disk-format.ts#L27)），形状是 `{schema:3, lastPositions:{path:{s?,c?,t?}}}`（写：[`encodeDb`](/src/position/storage/database.ts#L590)）。**只在形状变化时递增**，加可选字段不算。**三种都读，只写 3**：schema 1 的平坦数组、schema 2 的 `positions` 容器都照旧读出来，下一次落盘整份写成 3，所以把容器键从 `positions` 改成 `lastPositions` 不丢位置。**删老 schema 读取的时机是将来待办**：等基本没有旧版本插件在用时再删，现在删会让还在旧版上的设备读不懂新文件。版本不一致的常驻提示保留（[`noteSchema`](/src/position/storage/database.ts#L404)）：启动时读到旧版弹 `dataStorage.legacyDb.notice`，会话中途文件被旧 writer 盖回去弹 `noticeOverwritten`。

**跨设备合并**（[`runMergePass`](/src/position/storage/database.ts#L508)）：5 秒心跳先 stat 一次，mtime 与上次缓存相同就直接回来；不同就整份读出来解析，再逐键合并（[`mergeDiskDb`](/src/position/storage/database.ts#L478)）：磁盘独有的采纳、内存独有的保留、两边都有的比记录自带的采集戳 `t`，更新的赢、相等（包括两边都没有 `t`）留本地。四种「时间」别混：导航 push 的墙钟、笔记 mtime、db 文件的 mtime、记录入库时刻；合并只认最后这个（记录自带的 `t`），db 文件的 mtime 只用来判断「外部改过没有」。外部文件解析不了时（同步工具写了一半、冲突标记）留住内存里的记录，并把这次 mtime 记下来，免得每 5 秒重读同一份坏内容，等下一份能读的文件替换它时再合并。**内存独有的记录被留住时（`preserved > 0`）必须标脏**：同步工具整份换掉文件时盘上可能少了键，这些记录只活在内存里，用户之后只是阅读、没有新的滚动，不标脏就永远等不到下一次自然落盘，退出即丢。

**落盘必须走三步原子写，但不许再加「上一版」**（[`writeFileAtomically`](/src/position/storage/atomic-file.ts#L35)，内容与时机在 [`writeDbFile`](/src/position/storage/database.ts#L606)）：写 `.trash/position-restore/<db 基名>.next` → 删正式文件 → rename 就位。`adapter.rename` 在目标存在时会抛 `Destination file already exists!`，所以「覆盖」只能靠先删旧文件；中间那约 1ms 正式文件不存在，由启动补完兜住。暂存那套用不了时退回整份直写，控制台留一行警告，真机上看到这行说明这台设备的暂存方案得换。**不要改回整份 `adapter.write(dbPath, ...)` 当默认路径**，文件动作全在 [`atomic-file.ts`](/src/position/storage/atomic-file.ts#L1) 里，`database.ts` 只管内容与时机。

**暂存目录只能是 `.trash/position-restore`**（[`STAGING_DIR`](/src/position/storage/atomic-file.ts#L16)）：Obsidian Sync「隐藏文件夹不同步」，坚果云默认 filterRules 也含 `**/.trash`。放到 db 同目录会被当成内容同步，写到一半被推上去又是一份坏文件。

**启动时补完上一次被打断的落盘**（[`finishInterruptedWrite`](/src/position/storage/atomic-file.ts#L64)、[`recoverMissingDbFile`](/src/position/storage/database.ts#L361)）：正式文件不在时，只看 `.trash/position-restore/<db 基名>.next`（那次落盘只差最后一次 rename，内容完整），解析成功才 rename 扶正；没有或读不懂就按「没有数据」处理。正式文件读成功时，暂存残渣由 [`discardStagedFile`](/src/position/storage/atomic-file.ts#L90) 清掉。

**读不懂或读不了的正式文件：不抢救，归零重来，但提示必须常驻**（[`resetUnreadableDb`](/src/position/storage/database.ts#L381)）：`console.error` 之后先看 `.next` 能否解析，能就采纳它继续并 [`markDirty`](/src/position/storage/database.ts#L245)，否则 `db = {}` 从空库继续；两种结果都弹常驻提示 [`stickyNotice`](/src/shared/notice.ts#L6)（duration 0，用户点掉才消失）。这是 2026-11-02 的定案：位置数据不是重要数据，坏文件归零可接受，但用户必须知道这次位置被跳过了。**不许再捡回**打捞、`.corrupt-*` 副本、上一版 `.prev`、只读降级或「外部改回能读就自动解除」那一套，删掉的代码在提交 `6191df3`。归零和采纳 `.next` 两条都标脏，下一次 5 秒心跳就会把正式文件整份重写（采纳的写成救回的内容，空库的写成合法的空库），用户不用先滚动一下才不再看到提示；只有「连字节都没读到」（权限、被锁、瞬时失败）那条不标脏、也不碰文件，免得一次瞬时失败把可能完好的库覆盖成空库。

**换库（设置页改数据文件路径）**（[`switchDbFile`](/src/position/storage/database.ts#L132)、[`switchDbPass`](/src/position/storage/database.ts#L140)）：整段排进写盘链，不会和在途的 5 秒 flush 交错。目标路径已经存在时（多半是从另一台设备同步来的库），先 [`parseDbStrict`](/src/position/storage/disk-format.ts#L199) 做严格形态检查，现在还会校验记录值的形状，键是 `.md`/`.base` 但值不是记录的一律拒绝，误选 `package.json` 之类会被挡下；通过后用与外部合并相同的规则并进内存，然后**先把合并结果写到新路径，成功之后才删旧文件**，写失败就中止、旧库一个字节不动。目标不存在时同样是先写新文件再删旧文件，不再用 rename 搬旧文件。写完按写盘期间有没有新变更重算 `dbDirty`，并对着新路径重新缓存 mtime。

**父文件夹建不出来时不改设置、不写盘**（[`ensureDbFolder`](/src/position/storage/database.ts#L101)）：建不出父文件夹时这次落盘直接放弃（库保持脏，下一次 5 秒心跳重试），并弹一次常驻提示（`dataStorage.dbFileName.messages.folderFailed`），只提示一次免得每 5 秒刷一条。**不许静默把 `dbFileName` 改回默认路径**：读者会以为文件还在原处，下次启动才发现换了库。

**`parseDb` 的容错读法**（[`parseDb`](/src/position/storage/disk-format.ts#L117)）：`schema` 是数字才按编号读；缺 `schema` 键或它不是数字时，先看容器键，有 `lastPositions` 就按 schema 3 读、有 `positions` 就按 schema 2 读，两个容器都没有才按 schema 之前的平坦表读。平坦表要求每个值都是数字数组、长度 1/3/5（[`parseSchema1`](/src/position/storage/disk-format.ts#L152)），形状不对就整份判读不懂，交给「空库 + 常驻提示」，不许悄悄读成空记录。加这两条是因为同步工具的 JSON 合并可能把 `schema` 键弄丢：只按老规则会把新文件当成平坦表、读成一个垃圾键（`lastPositions`），下一次落盘整库清零。

**墓碑记录必须落盘**（[`encodeDb`](/src/position/storage/database.ts#L590)）：既无 `s` 又无 `c` 的记录表示「来过、停在顶部」。它在恢复行为上与「从未有记录」等价（两种都停在 Obsidian 自己打开笔记的那一行），但仍然要写：它出现在记录数的统计里，并且是容量上限优先淘汰的对象（见 [`trimToLimit`](/src/position/storage/database.ts#L274)）。

**容量 `MAX_ENTRIES = 750`，裁到 `TRIM_TARGET = 562`**（[`MAX_ENTRIES`](/src/position/storage/database.ts#L26)、[`TRIM_TARGET`](/src/position/storage/database.ts#L27)）：3/4 是滞后防抖。墓碑优先出局，但最近 `TOMB_RECENT_WINDOW = 187` 条内豁免（[`TOMB_RECENT_WINDOW`](/src/position/storage/database.ts#L31)）。

**默认光标行是 frontmatter 块之后那一行**（[`defaultCursorLine`](/src/position/storage/database.ts#L450)）：实测 85% 的笔记这一行是空的。

**按 leaf 读要过路径守卫**（[`read`](/src/position/storage/position-store.ts#L137)）：leaf 记录里的 `filePath` 必须与请求的 path 一致才用，否则退回文件记录，防止已经切走的 leaf 去定位别的文件。

**overlay 只持久化真正分叉的 leaf 记录**（[`persist`](/src/position/storage/position-store.ts#L260)）：稳态下「一个标签页一个文件」根本不写 localStorage。

**`position-restore: true` 是逃生舱**（[`shouldSkipRecording`](/src/position/policy/exclusion.ts#L17)）：压过排除文件夹、最小行数、B 规则。字符串 `"true"/"false"` 也算（[`markerValue`](/src/position/policy/frontmatter.ts#L34)），因为属性面板存文本值会带引号。**最近文件列表故意不读这个逃生舱**（[`recordable`](/src/recent-files/places.ts#L225)），那是「要不要记位置」，与「是不是读者去过的地方」是两件事。

**元数据没解析完时返回 `undefined` = 无决定**（[`frontmatterDecisionFor`](/src/position/policy/frontmatter.ts#L69)）：调用方下次再看，**不许缓存错误答案**。

**删除不能当场执行**（[`DELETE_PRUNE_GRACE_MS`](/src/position/path-bookkeeping.ts#L22)）：同一个 `delete` 事件既表示用户真删，也表示同步插件「删掉再改名覆盖」的前半步。所以排期 10 秒后由 vault 仲裁；rename 或 create 一到就取消排期。启动时只扫导航 store，**不动位置记录**（[`sweepMissingHistory`](/src/position/path-bookkeeping.ts#L91)），db 是同步文件，本设备还没物化的文件不能抹掉别的设备还要用的位置。

**不要在切后台 / 页面隐藏时主动写盘**：那一瞬移动端 WebView 最可能被冻住，没人能 await，写到一半就是半截文件。5 秒心跳 + 退出 `Tasks` 已经够（`visibilitychange` / `pagehide` 那条已删）。

## 怎么验证它没坏

- `npx vitest run tests/database.test.ts`、`tests/atomic-file.test.ts`、`tests/position-store.test.ts`
- `npx vitest run tests/frontmatter-rules.test.ts`（覆盖 `shared/frontmatter.ts`）
- `npx vitest run tests/path-bookkeeping.test.ts`、`tests/manager-path-bookkeeping.test.ts`
- 手工验容错：把数据文件改成一段坏 JSON 再重启，应当看到常驻提示、插件照常可用，下一次有位置落盘后文件被整份重写成能读的；把正式文件删掉、只留 `.trash/position-restore/<名>.next` 再重启，位置应当还在。
- 手工验换库：把数据文件路径改到一个已存在的有效库上，应当提示合并了多少条；改到一个不存在的路径，应当把当前库整份写过去、旧文件删除。
- ⚠️ `policy/` 两个文件**目前没有独立测试**，动它们之前先补测试。
