# 06 装配、设置与边角

## 这段是干什么的

谁把前面五篇的零件装起来、设置项怎么落到存储里、以及那些不进主链路但仍要有人管的小功能。

| 文件 | 职责 |
|---|---|
| `main.ts` | 插件入口，装配顺序、命令、两个轮询、落盘时机 |
| `position/manager.ts` | 组合根 / 门面：`main.ts` 只跟它说话 |
| `position/state.ts` | 跨阶段协调状态的**唯一所有者** |
| `settings/tab.ts`、`page.ts`、`pickers.ts` | 设置页的装配、公共设施、四个小弹窗 |
| `i18n/index.ts` + `locales/` | 文案：zh 与 en 两份，**key 相同** |
| `position/hover/explorer-preview.ts` | 文件列表悬停预览的开场位置 |
| `position/edges.ts` | 到顶部 / 到底部 |
| `shared/` | 谁都能用的小工具：leaf 判定、等待原语、frontmatter 规则、标题扫描、提示 |

## 入口在哪

- `onload`（`main.ts:17`）。**装配顺序有讲究**，见下。
- `class PositionManager`（`manager.ts:31`）—— 门面。安装期三个 `install*`，运行期
  `sampleActiveView`、`navigateBack/Forward`、`goToEdge`、`applyChangedSettings` 等。
- `class PositionState`（`state.ts:15`）—— 所有跨阶段状态都挂在它上面。

## 数据怎么流：装配顺序（`main.ts:17-47`）

```
1. loadSettings()         ← Object.assign 合并进既有对象，对象身份不能换（见下）
2. new CursorPositionDatabase / new PositionManager
3. await database.readDb()
4. addSettingTab(...)
5. registerView(RECENT_FILES_VIEW_TYPE, ...)     ← 最近文件面板
6. registerHoverLinkSource(NAV_SOURCE_ID, ...)   ← 面板在 app 预览系统里的 id
7. manager.installPatches / installExplorerPreview / installBackgroundSettle
8. registerCommands()     ← 6 条命令 + ribbon
9. registerWorkspaceEvents()
10. 两个轮询：位置 100ms / 视图 state 1000ms
11. registerDbFlush()     ← 每 5 秒：先 mergeExternalChanges 再 storePositionData
12. registerSuspendFlush()← visibilitychange + pagehide
13. onLayoutReady 里延后两件事：prunePositions / sweepMissingHistory
14. restoreEphemeralState()（最后一次，同步）
```

**设置对象身份不能换**（`main.ts:51`）：`PositionManager` 与 `NavPlaces` 在构造时就抓住这个
引用并实时读它，所以只能用 `Object.assign` 就地合并。

**两个 store 的接线在这里**（`manager.ts:62-77`）：

```
funnel.subscribe(stack)                                  ← 栈自己实现 NavFunnelSink
funnel.subscribe({onVisit→places.remember,
                  onLanded→places.settle,
                  onHere→places.markCurrent})            ← 端口翻译
places.attach({openFile→stack.openFilePlain,
               openJump→stack.travelTo,
               openView→stack.openViewPlace})            ← 地点列表借用栈的开路管道
```

这就是它们**互不 import** 却能协同的原因。

## 有哪些坑

**设置写入只有一条路径**（`settings/tab.ts:54`）：浅拷贝快照 → 就地写字段 →
`manager.applyChangedSettings(before)`（按 diff 决定后果）→ 命中 `BROWSER_PREF_KEYS`
就请求面板重画 → `saveSettings()` → 命中 `PAGE_SHAPE_KEYS` 就整页重绘。
外部改写 `data.json`（`main.ts:73`）走**同一张表**。

`BROWSER_PREF_KEYS` 装的是「已经站在屏幕上的面板据以绘制的偏好」（四个 recentFiles* 键）——
它们不产生派生状态，但旁边已经画好的面板得被要求重画一次。

**`NAV_SOURCE_ID` 必须等于面板 view 的 type**（`browser/constants.ts:7`）。
**`RECENT_FILES_VIEW_TYPE` 改字符串会让已保存的侧栏变孤儿**（`view.ts:27`）—— 它是持久 id。

**`dismissOnMobile` 必须按形状检查**（`view.ts:216`）：`instanceof` 对只在 typings 里存在的
名字会抛异常。

**设置页里的弹窗只用原生 DOM，不用 `Setting`/`TextComponent`**（`ui/db-path-modal.ts:23`）：
它们是 thenable，在声明式设置页里开弹窗会卡死整个 app。输入框要关掉首字母大写与自动更正
（`:56`，vault 路径大小写敏感）。

**悬停预览必须是补丁而不是监听器**（`hover/explorer-preview.ts:51`）：core 自己也是
`hover-link` 的监听器，会先把 payload 拷走 —— 之后再改就没人收到了。它用的是记录的
**文件位置**而不是今天重算的行号（`:30`）：这一次是同步调用，等不了异步读取。

**到顶部 / 到底部要「保持」**（`edges.ts:19`）：阅读渲染器会把它移动前捕获的 scroll 在下一个
渲染 pass 重贴，表现为「闪回顶部再滑回来」，所以要 `holdEdge`（最多 2 次、400ms）。
**移动后不许直接写 `scrollTop`**，必须走 `setEphemeralState({scroll})` 这扇门。
底部要扣掉反向链接面板与手机底部浮层。

**交给 `Tasks` 的 promise 必须 settle**（`main.ts` 的 quit）：core 是 `Promise.all` 之后才关窗口，
一个 reject 就卡在「Saving…」退不出去。`storePositionData()` 整包 try/catch，只 log 不抛。
三个 localStorage store 是同步写，早于文件写完成，所以退出被掐断也保得住 per-tab 快照。

## 怎么验证它没坏

- `npx vitest run tests/position-manager-persist.test.ts`、`view-state-poll.test.ts`
- `npx vitest run tests/note-edges.test.ts`、`explorer-preview-focus.test.ts`
- `npx vitest run tests/settings-hotkeys-row.test.ts`（设置页那行「热键」）
- 手工验：改一个 `recentFiles*` 设置（如路径显示方式），**已经打开**的面板应当立刻变；
  改「排除文件夹」，则只有重开笔记后才生效（这是 diff 表决定的）。
- 手工验退出：滚到长笔记中间 → 立刻退出 app → 重开，位置应在（走了 Tasks 那条路）。
