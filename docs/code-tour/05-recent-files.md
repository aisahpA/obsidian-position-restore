# 05 最近文件面板

## 这段是干什么的

把去过的**笔记**列出来。**它是「笔记登记簿」，不是「走过的路」** —— 这与前进后退栈的区别
写在 [`places.ts:13`](/src/recent-files/places.ts#L13)：栈是遍历工具（有序、绑游标、跳转即截断，且**照记跳转与落点**），这个
列表是无序登记簿（跳转不截断、按笔记去重、**跳转一律降级成访问**）。

⇒ **一份记录 = 一行，身份就是它的 path**（无路径视图是它的视图类型），没有第二套身份
（`placeKey` 已于 2026-10-05 删掉），也没有第二个池子。**落点不在这里** —— 它在栈里；
读者想去某一节，是**搜**出来的（见下面的「大纲行」）。

| 文件 | 职责 |
|---|---|
| `recent-files/places.ts` | 仓库：去重、上限、钉住、MRU、**把 jump 降级成 visit** |
| `recent-files/places-store.ts` | 落盘（localStorage，版本 3） |
| `recent-files/browser/view.ts` / `modal.ts` | 两个壳：常驻侧栏 / 对话框 |
| `recent-files/browser/body.ts` | 两个壳共用的一切：工具栏、键盘、跳转、右键菜单 |
| `recent-files/browser/arrows.ts` | 列表脚下那四个箭头（后退/前进 + 笔记两端） |
| `recent-files/browser/row-preview.ts` | 一行的**悬停预览**：向 app 要 popover，并守候它的答案 |
| `recent-files/browser/list.ts` | 真正造 DOM 的地方（文件行 + 大纲行） |
| `recent-files/browser/listing.ts` / `model.ts` | 纯分组 / **纯过滤判据** / 纯显示 |
| `recent-files/browser/reads.ts` | **唯一**读 vault 的地方（带缓存） |
| `recent-files/browser/tip.ts` / `hover-settle.ts` / `long-press.ts` | 提示、预览落定、手机长按 |

## 入口在哪

- [`NavPlaces`](/src/recent-files/places.ts#L118)、[`cap`](/src/recent-files/places.ts#L151)、[`trim`](/src/recent-files/places.ts#L608)、
  [`remember`](/src/recent-files/places.ts#L228)（降级就在这里）、[`pruneExcluded`](/src/recent-files/places.ts#L409)、[`travelToHeading`](/src/recent-files/places.ts#L458)。
- [`RecentFilesBrowser`](/src/recent-files/browser/body.ts#L77)：[`mount`](/src/recent-files/browser/body.ts#L127)、[`render`](/src/recent-files/browser/body.ts#L253)、
  [`contextRow`](/src/recent-files/browser/body.ts#L498)。
- [`ArrowBar`](/src/recent-files/browser/arrows.ts#L61)：[`refresh`](/src/recent-files/browser/arrows.ts#L89)、[`press`](/src/recent-files/browser/arrows.ts#L99)。
- [`RowPreview`](/src/recent-files/browser/row-preview.ts#L28)：[`hoverRow`](/src/recent-files/browser/row-preview.ts#L53)、[`askFor`](/src/recent-files/browser/row-preview.ts#L126)、
  [`subpathHeading`](/src/recent-files/browser/row-preview.ts#L160)。
- [`RecentFilesList`](/src/recent-files/browser/list.ts#L183)：[`render`](/src/recent-files/browser/list.ts#L304)、[`facts`](/src/recent-files/browser/list.ts#L400)、
  [`fileRow`](/src/recent-files/browser/list.ts#L432)、[`headingRow`](/src/recent-files/browser/list.ts#L552)、[`hoverAt`](/src/recent-files/browser/list.ts#L814)、[`onClick`](/src/recent-files/browser/list.ts#L860)、
  [`goTo`](/src/recent-files/browser/list.ts#L943)。
- 行的身份：[`navGroupKey`](/src/nav/entry.ts#L95)。

## 数据怎么流

**一次重画**（[`body.ts:253`](/src/recent-files/browser/body.ts#L253)）：

```
重指 listOpts.entries / currentIndex
  → list.render()   ← 整表重建，没有 diff
  → arrowBar.refresh()
```

`list.render()` 内部又分（[`list.ts:304`](/src/recent-files/browser/list.ts#L304)）：记下光标所在的**槽位**（所属那一行 + 当它是大纲行时
它印着的那个小节）→ `list.empty()` 整表重建 → 清描述缓存 → `groupByFile` → 钉住的提到顶 →
标出重名 → 每组先画**文件行**、再画它**搜到的小节**各一行 → 按槽位恢复选中。

**悬停预览这条链路**（[`row-preview.ts:53`](/src/recent-files/browser/row-preview.ts#L53)）：

```
list.hoverAt → preview.hoverRow → hit ? hit.line : (wantsLine? d.lineIndex : undefined)
   → askFor（可点名的节 → linktext 'note.md#小节'；否则行号；否则什么都不给）
   → workspace.trigger('hover-link')（带 source: NAV_SOURCE_ID、linktext、state.scroll）
   → 等 app 把 popover 回写进 hoverParent.hoverPopover
   → PreviewSettle.tick 发现 → lift + body 的 list.hideTip()
```

## 有哪些坑

**重画成本几乎全在 DOM**（0.26ms/行，线性）⇒ 只做「少画几次」「别全量重建」；
**memo / 脏标记 / 合并重画都别做**。仓库里唯一做的「合并」发生在**离开视野**时
（手机让位 `view.ts`、迟到读取 [`body.ts:294`](/src/recent-files/browser/body.ts#L294) 的 `redrawSoon`），那是延迟，不是去脏。

**点击必须按身份解析**（`list.ts`）**：跳转会让 store 重排，索引立刻失效。
`el.click()` 这种没有 press 的点击**什么都不打开** —— 打不开是能承受的失败，
打开错笔记不能。

**大纲行是搜索的产物，不是记录**（判据与红线见 `00-改前必读.md` §5）：读者敲的词命中了某篇
笔记的**小节标题**时，那一节在笔记那一行**下面**自己画一行（`headingRow`）。它不入库 ——
没有时间、没有 ×、不能钉选 —— 但它是一个完整的行：可点、可预览、可被键盘走到，而点它去的
是那一节（`goTo` 一处收口）。判据是 `listing.ts` 的 `matchedHeadings`（严格全 token 优先，
否则首 token loose，按文档顺序，每篇最多 `OUTLINE_HIT_LIMIT` = 5）。

**hover 的判据是「指针真的动了」**（[`list.ts:814`](/src/recent-files/browser/list.ts#L814)）：`pointerover` 在元素「来到」指针下时
也会触发，热键在鼠标停住时弹出的面板会给每一行都报一次到达。面板听到的第一个事件不算移动。

**MRU 顺序靠数组末尾**（`places.ts`）：碰过的笔记移到数组末尾，因为 list 把索引当钟读
（`list.ts`）—— 原地更新会让刚碰过的笔记显得更旧。

**两条天花板，同一个数字**（[`places.ts:538`](/src/recent-files/places.ts#L608)）：按行裁（`cap()`）。钉住的行不计入上限也不会
被淘汰；当前所在的行不被裁掉。⚠️ **钉选不再豁免 [`pruneExcluded`](/src/recent-files/places.ts#L409)**：
它的 `kept` 只留 `view` 与 `recordable(path)` —— 一条后来的规则就是关于那一行的后来的答案。

**`visit` 记录故意不存位置**（`places.ts`）：否则「点文件浏览器打开」和「点这一行打开」
会给出不同落点。⇒ 一行的行号只有一处来源：**位置数据库**（`reads.ts` 的 `savedPosition`
→ `model.ts` 的 `lineIndex`）。**没有任何 now-line 换算** —— `now-line.ts` 与它的 mtime 闸门 /
live buffer / 磁盘文本三级链已于 2026-10-05 随落点行一起撤掉。

**缓存不记「未命中」**（`reads.ts`）：未解析 ≠ 无标题，记住一次 miss 会熬过整个同步窗口。
**`prime` 是性能闸门**（[`reads.ts:188`](/src/recent-files/browser/reads.ts#L188) 的 `ensureText`）：一次 hover 可以等一个 await，
五十行的重画不可以。

**`×` 绝对定位、不在流内、且 `stopPropagation`**（[`list.ts:581`](/src/recent-files/browser/list.ts#L581)）：否则按它会顺带把行记为 pressed。

**预览是观察器不是等待**（`hover-settle.ts`）：本面板要按 Mod 键，app 可能十秒后才答，
任何有期限的等待都会先回家。只动 `opacity` 不动布局。

## 怎么验证它没坏

- `npx vitest run tests/recent-files-browser.test.ts`（纯函数）
- `npx vitest run tests/recent-files-browser-dom` —— 交互，**五个文件**
  （`…-dom` 机制 / `-rows` 行的长相 / `-touch` 触屏 / `-hover` 悬停 / `-pins` 置顶与箭头），
  共用 `tests/support/recent-files-modal-harness.ts` 那个装置；每个文件在模块顶层调一次
  `installHarness()`。常驻面板另有 `recent-files-sidebar.test.ts`（自带装置）。
- `npx vitest run tests/recent-files-browser-styles.test.ts` —— **直接读 `styles.css` 断言**，
  因为 jsdom 从不加载样式表。**改样式必须同步改这个文件。**
- `npx vitest run tests/recent-files-places.test.ts`、`recent-files-sidebar.test.ts`、
  `recent-files-hover-settle.test.ts`
- 手工验：搜一个只出现在某个小节标题里的词 —— 那一节应自己成为一行、挂在它的笔记下面，
  点它应落在那一节（而不是笔记开头）。
