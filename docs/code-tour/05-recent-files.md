# 05 最近文件面板

## 这段是干什么的

把去过的地方列出来。**它是「地点登记簿」，不是「走过的路」** —— 这与前进后退栈的区别
写在 `places.ts:13`：栈是遍历工具（有序、绑游标、跳转即截断），这个列表是无序登记簿
（跳转不截断、按地点去重、不会被回填）。

| 文件 | 职责 |
|---|---|
| `recent-files/places.ts` | 地点仓库：去重、上限、钉住、MRU |
| `recent-files/places-store.ts` | 落盘（localStorage，版本 2） |
| `recent-files/browser/view.ts` / `modal.ts` | 两个壳：常驻侧栏 / 对话框 |
| `recent-files/browser/body.ts` | 两个壳共用的一切：工具栏、键盘、跳转、悬停、右键菜单 |
| `recent-files/browser/list.ts` | 真正造 DOM 的地方 |
| `recent-files/browser/listing.ts` / `model.ts` | 纯分组过滤 / 纯显示 |
| `recent-files/browser/reads.ts` | **唯一**读 vault 的地方（带缓存） |
| `recent-files/browser/now-line.ts` | 行号从「当时」换算到「现在」 |
| `recent-files/browser/tip.ts` / `hover-settle.ts` / `long-press.ts` | 提示、预览落定、手机长按 |

## 入口在哪

- `class NavPlaces`（`places.ts:157`）、`placeKey()`（`:823`）、`cap()`（`:212`）。
- `class RecentFilesBrowser`（`body.ts:147`）：`mount()`（`:233`）、`render()`（`:355`）。
- `class RecentFilesList`（`list.ts:200`）：`render()`（`:374`）、`fileRow()`（`:564`）、
  `placeRow()`（`:822`）、`hoverAt()`（`:1195`）、`onClick()`（`:1247`）。
- 换算：`nowLineFor()`（`now-line.ts:39`）。

## 数据怎么流

**一次重画**（`body.ts:355`）：

```
reclaim()          ← 先把被编辑挪走的行号整表归位，必须早于任何一行画出来
  → 重指 listOpts.entries / currentIndex
  → list.render()  ← 整表重建，没有 diff
  → refreshArrows()
```

`list.render()` 内部又分（`list.ts:374`）：记下光标所在的**槽位** → `list.empty()` 整表重建 →
清描述缓存 → `groupByFile` → 钉住的提到顶 → 标出重名 → 每组先画文件行再画地点行 →
`fitTrails` 收层次链 → 按槽位恢复选中。

**悬停预览这条链路**（`body.ts:771-838`）：

```
list.hoverAt → body.hoverRow → wantsLine? → nowLineFor → previewAsk
   → workspace.trigger('hover-link')（带 source: NAV_SOURCE_ID、linktext、state.scroll）
   → 等 app 把 popover 回写进 hoverParent.hoverPopover
   → PreviewSettle.tick 发现 → liftPreview + hideTip
```

## 有哪些坑

**重画成本几乎全在 DOM**（0.26ms/行，线性）⇒ 只做「少画几次」「别全量重建」；
**memo / 脏标记 / 合并重画都别做**。仓库里唯一做的「合并」发生在**离开视野**时
（手机让位 `view.ts:195`、迟到读取 `body.ts:394`），那是延迟，不是去脏。

**点击必须按身份解析**（`list.ts:1266`）：跳转会让 store 重排，索引立刻失效。
`el.click()` 这种没有 press 的点击**什么都不打开** —— 打不开是能承受的失败，
打开错笔记不能。

**hover 的判据是「指针真的动了」**（`list.ts:1175`）：`pointerover` 在元素「来到」指针下时
也会触发，热键在鼠标停住时弹出的面板会给每一行都报一次到达。面板听到的第一个事件不算移动。

**一行可能覆盖两个地点**（`list.ts:786`）：`landingKeys()` 把同一行上的所有 `placeKey`
一次交出去 —— 只删自己那条，行会立刻被放回来。

**`reclaim` 必须在任何行被画出来之前整表跑一遍**（`body.ts:639`）：否则行会按两个不同答案分组。
它不读文件，只读 app 已经解析过的东西；读者正站在其中的那个地点跳过。

**`nowLineAt` 一次 draw 每个地点只答一次**（`body.ts:679`）：reclaim 和标题链问的是同一件事，
两个答案会打架。`landingLost` 也有三个消费方（行上印什么、hover 警告什么、预览指向哪一节），
必须在同一处回答，否则会出现「印 Beta 却警告 Alpha 丢了」。

**MRU 顺序靠数组末尾**（`places.ts:42`）：碰过的地点移到数组末尾，因为 list 把索引当钟读
（`list.ts:319`）—— 原地更新会让刚碰过的地点显得更旧。

**两条天花板，同一个数字**（`places.ts:723`、`:774`）：先按行裁，再按标题全局裁。
钉住的行不计入上限也不会被淘汰；当前所在的行不被裁掉。

**`visit` 记录故意不存位置**（`places.ts:21`）：否则「点文件浏览器打开」和「点这一行打开」
会给出不同落点。

**缓存不记「未命中」**（`reads.ts:73`）：未解析 ≠ 无标题，记住一次 miss 会熬过整个同步窗口。
`linesFor` 不接受旧 mtime 的读数（`:234`）—— 行是被比较的对象本身，旧副本不是近似值而是答案缺席。
**`prime` 是性能闸门**（`:236`）：一次 hover 可以等一个 await，五十行的重画不可以。

**`×` 绝对定位、不在流内、且 `stopPropagation`**（`list.ts:698`）：否则按它会顺带把行记为 pressed。

**预览是观察器不是等待**（`hover-settle.ts:20`）：本面板要按 Mod 键，app 可能十秒后才答，
任何有期限的等待都会先回家。只动 `opacity` 不动布局。

## 怎么验证它没坏

- `npx vitest run tests/recent-files-browser.test.ts`（纯函数）、`recent-files-browser-dom.test.ts`（交互）
- `npx vitest run tests/recent-files-browser-styles.test.ts` —— **直接读 `styles.css` 断言**，
  因为 jsdom 从不加载样式表。**改样式必须同步改这个文件。**
- `npx vitest run tests/recent-files-places.test.ts`、`recent-files-sidebar.test.ts`、
  `recent-files-now-line.test.ts`、`recent-files-hover-settle.test.ts`
- 手工验：编辑一篇笔记把某标题往上挪十行，回到面板 —— 行上的行号应自己跟过去（reclaim），
  不该出现「提示丢了」与「行上还印着旧号」同时发生。
