# 01 导航：一次移动怎么变成记录

## 这段是干什么的

整个插件里所有「读者动了」这件事，都要先过同一个漏斗，再由两个互不相识的 store 各取所需。
这一层是**中立**的：它不知道有前进后退，也不知道有最近文件列表。

三个文件构成一套词汇，一个文件是漏斗本身：

| 文件 | 角色 |
|---|---|
| `nav/entry.ts` | 共享词汇表：一条记录长什么样、身份怎么算、什么叫「同一个落点」 |
| `nav/funnel.ts` | 采集漏斗：把「采集点看到的」变成「一条记录」，并套上公共闸门 |
| `nav/outline-capture.ts` | 补一个盲区：阅读模式下点大纲条目 |
| `nav/pane.ts` | 一个类型别名，借用 app 自己的词 |

## 入口在哪

- 漏斗本体：`class NavFunnel`（`nav/funnel.ts:83`）。采集面是 `recordOpen`（`:120`）、
  `recordTeleport`（`:161`）、`recordActivation`（`:174`）、`leave`（`:242`）、`settled`（`:248`）；
  广播是 `visit`（`:295`）、`landing`（`:302`）、`here`（`:308`）。
- 公共闸门：`isRecording()`（`nav/funnel.ts:106`）—— 只有两个条件：插件自己没在挪视图
  （`!moving`）且工作区已经起来（`layoutReady`）。
- 订阅：`subscribe(sink)`（`nav/funnel.ts:97`）。订阅者实现 `NavFunnelSink` 里用得到的钩子即可，
  全部可选（`nav/funnel.ts:63`）。

## 数据怎么流

**采集面**回答的是「我看到了什么」，它不知道这次移动意味着什么：

```
setViewState 补丁 ─┐
100ms 轮询        ─┤
大纲面板点击      ─┼─► funnel.recordOpen / recordTeleport / recordActivation / leave / settled
active-leaf-change─┘                              │
                                                  ▼
                                    applyEphemeralState 之外唯一的门：isRecording()
                                                  │
                                                  ▼
                                            发布给所有 sink
```

**广播**则是「已经有人认定的事实」：`visit()` 是栈自己拍板的一步（它故意绕过闸门，
因为栈**就是**那个正在挪视图的插件，`nav/funnel.ts:292`）；`landing()` 是某个落点现在知道了；
`here()` 是「你在这里」这个标记移动了。

一次跳转的三拍（`nav/outline-capture.ts:79-97` 是这一拍的完整样板）：
先 `leave()` 记下**点击前**的精确位置 → 再 `recordOpen()` 压入带 key 的记录 →
最后撑开落点吸收窗口（`LANDING_ABSORB_MS`），让紧随其后那次光标跳变被挡在门外。
**点一次，恰好压入一条记录。**

## 有哪些坑

**闸门只回答一个问题**（`nav/funnel.ts:104`）：这次是读者在导航，还是插件在挪自己？
像「记录标签页切换」这种设置**不算**闸门 —— 那是栈对自己那张列表的主张，由读取方各自应用。
所以设置项在栈里（`stack.ts:134`），不在漏斗里。

**哪些东西看起来该记、偏偏不能记**（`nav/funnel.ts:182-225`，这一段的注释占这个文件的一半）：

- 没有 `file` 的 FileView：那是**一个瞬间**，不是另一种目的地。同步替换笔记的做法是先删文件、
  再把下载的那个改名盖上去，在那一个瞬间标签页还在显示旧笔记而 `file` 是 null。
  记成视图会凭空造出一个 key 为 `view:markdown`、还挂着笔记名字的幽灵地点。
- 延迟打开的 leaf（`isDeferredLeaf`）：占位符不是视图，笔记自己的标签页会掉出 `instanceof` 判断。
- **markdown 标签页永远是一篇笔记**（`nav/funnel.ts:221`），不管上面哪一步没能说清楚。
- app 已经造不出来的视图类型不算地点：恢复它只会得到一个自称是它的占位符。

**bracket 在看门狗手里**（`nav/funnel.ts:78`、`:271`）：一次跳转会锁住闸门，若其中某个 await
永远不 resolve，前进后退就永久废了。所以有 `BRACKET_WATCHDOG_MS = 5000`，与 `finally` 共用
一次 settle —— 一次 `restoreStarted` 恰好对应一次 `restoreEnded`。

**大纲点击必须挂在捕获阶段**（`nav/outline-capture.ts:19`）：跑在 core 的处理器之前，
才读得到点击前的位置。这个文件的每一步解析都静默降级 —— 未知的 DOM、找不到大纲、
目标 leaf 无法确定，剩下的交给常规管线。

**身份算法写在 entry.ts，不写在各自的 store 里**（`nav/entry.ts:102`、`:202`）：
「属于列表哪一行」由 `navGroupKey` 答，「什么叫同一个落点」由 `landedLine` 答。
两者都有**两个**判定者（面板折叠行、store 去重），写两遍就会漂。

## 怎么验证它没坏

- `npx vitest run tests/nav-funnel.test.ts` —— 漏斗的闸门与分发。
- `npx vitest run tests/nav-history-stack.test.ts` —— 步怎么进栈（脚手架在
  `tests/support/nav-recording-harness.ts`，一次装齐漏斗 + 栈 + 地点）。
- `npx vitest run tests/landing-absorb.test.ts` —— 一次点击恰好一步。
- 手工验：点大纲里同一个标题两次，前进后退里只应多出一步。
