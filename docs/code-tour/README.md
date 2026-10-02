# 代码导读 · 总览

这一组文档是给**要读这份代码的人**写的，不是给插件用户写的。每篇固定五段：
这段是干什么的 / 入口在哪 / 数据怎么流 / 有哪些坑 / 怎么验证它没坏。
术语以 `docs/glossary.md` 为准；代码符号一律保留英文原文放进反引号。

| 篇 | 内容 |
|---|---|
| [**00 改前必读**](./00-改前必读.md) | **动手改之前先看**：踩了会静默坏掉的红线（按模块分） |
| [01 导航：一次移动怎么变成记录](./01-navigation.md) | `nav/`、`nav-history/` |
| [02 采集：位置是怎么记下来的](./02-capture.md) | `position/capture/` |
| [03 恢复：打开笔记怎么落回原处](./03-restore.md) | `position/restore/`、`position/ui/` |
| [04 存储与准入](./04-storage.md) | `position/storage/`、`policy/`、`path-bookkeeping.ts` |
| [05 最近文件面板](./05-recent-files.md) | `recent-files/` |
| [06 装配、设置与边角](./06-assembly.md) | `main.ts`、`settings/`、`i18n/`、`position/hover/`、`edges.ts` |

建议的阅读顺序就是上表的顺序：**先搞清「一次导航是什么」，再看它被记录、被存储、被展示**。
前两篇读完，你就能判断一句话该写在哪一层。

**你要动手改代码的话，先读 `00`。** `01`~`06` 讲「这段在干什么」，`00` 讲「动了会坏什么」——
读懂了代码不代表知道它的约束从哪来。`00` 里的每条红线都带 `file:line`，可以直接跳到源码。

---

## 1. 这个插件做三件事

1. **记住位置**：每篇笔记记住光标停在第几行、滚到第几行，下次打开直接落回去（不在文件顶部闪一下）。
2. **前进后退**：把读者走过的路记成「步」，可以在步之间来回走。
3. **最近文件列表**：把去过的地方记成「地点」，列在面板上，能搜、能钉住、能悬停预览。

三件事共用的最底层是同一个东西：**位置是什么**。

## 2. 位置是什么：一个状态对象 `st`

`st`（类型 `NavEntryState`，见 `src/types.ts:37`）里最重要的是两个字段：

- `scroll`：**视口最上面那一行的行号，0 起算，不是像素**。
- `cursor`：**光标**，同样是行号单位。

外加三样「事后推不出来」的东西：`mtime`、`anchor`（落点那一行的原文，用于文本变动后重找）、
`context`（落点下面几行，只给搜索框用）。

记住两件事：

- **阅读模式下没有可显示的光标**（app 的阅读模式不还原 cursor），所以那里 `scroll` 是唯一坐标。
- **列表上显示的行号是「当时」的**，要真的打开笔记前必须换算成「现在」——换算函数是
  `nowLineFor()`（`recent-files/browser/now-line.ts:39`），它有三条路由，从便宜到贵。

## 3. 一次导航走过的路（全局链路）

```
读者动了（打开文件 / 点标题 / 切标签页 / 光标大跳）
        │
        ▼
   采集点：setViewState 补丁 · 100ms 轮询 · 大纲面板 · active-leaf-change
        │
        ▼
   nav/funnel.ts 的 NavFunnel          ← 公共闸门：这是读者动的，还是插件自己挪的？
        │
        ├──► NavStack（nav-history/stack.ts） 存「步」    → 前进后退
        └──► NavPlaces（recent-files/places.ts）存「地点」 → 最近文件列表
```

两个 store **互不 import**，谁也不知道对方存在。接线在 `position/manager.ts:62-77`：
manager 把 funnel 的两个订阅分别翻译成两个 store 各自的方言。

## 4. 「步」与「地点」不是一回事

| | 步（`NavStack`） | 地点（`NavPlaces`） |
|---|---|---|
| 是什么 | 走过的路，有序，绑着一个游标 | 去过的地方，按 MRU 排，没有游标 |
| 跳转时 | 砍掉整个前进段（VSCode 语义） | 不砍，只是把它移到最前 |
| 去重 | 与栈顶相同就不记 | 按 `placeKey` 去重 |
| 存哪 | localStorage，版本 3 | localStorage，版本 2 |
| 身份 | 数组下标 | `placeKey` |

而列表上的一**行**又是第三个概念：`navGroupKey`。**一行 ≠ 一个地点** ——
同一篇笔记里的三个标题是三个地点，但在列表上归并成一行。

四种种类的记录（`nav/entry.ts:6` 起的联合类型）：

| kind | 是什么 | 有没有 key |
|---|---|---|
| `jump` | 点大纲标题、点锚点链接、块引用跳转 | 有 |
| `visit` | 打开文件、切标签页 | 无 |
| `view` | 无文件的主区视图：关系图谱、搜索 | 无（身份是 viewType） |
| `teleport` | **推断**的同文件光标大跳跃（vim 跳转、跳到某行） | 无（身份是行号） |

## 5. 目录地图

```
src/
  main.ts                 插件入口，只跟 manager 一个门面说话
  types.ts                类型总表（EphemeralState / NavEntryState / PluginSettings）
  nav/                    共享词汇 + 采集漏斗        ← 中立层
  nav-history/            前进后退栈
  recent-files/           地点仓库 + 面板（browser/ 是 UI）
  position/
    manager.ts            组合根 / 门面
    state.ts              跨阶段协调状态的唯一所有者
    capture/              位置怎么读、怎么记
    restore/              打开时怎么落回去（最复杂的一层）
    storage/              positions.json + per-tab 覆盖层
    policy/               「这篇笔记该不该记」
    ui/                   打开保护盖布、方位提示、库路径弹窗
    hover/                文件列表悬停预览的开场位置
    edges.ts              到顶部 / 到底部
    path-bookkeeping.ts   rename / delete 之后的账
  settings/ i18n/ shared/
```

## 6. 五条一上来就该知道的规矩

1. **坐标是行号，不是像素**；列表上的行号是「当时」的，打开前要换算。
2. **移动端 scroll 事件会丢**，所以任何路径都不许用缓存值代替实时读取。
3. **切模式（含阅读模式）后不许直接写 `scrollTop`**，要走 `syncViewScroll` 那扇门。
4. **重画列表的成本几乎全在 DOM**，所以只做「少画几次」，不要加 memo / 脏标记 / 合并重画。
5. **交给 app `Tasks` 的 promise 必须 settle** —— 一个 reject 就卡在「Saving…」退不出去。
