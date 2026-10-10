# 03 恢复：打开笔记怎么落回原处

## 这段是干什么的

这是整个项目最复杂的六文件。一句话概括：**要在读者看见第一帧之前，把位置已经在位上摆好。**

| 文件 | 职责 |
|---|---|
| `restore/patcher.ts` | 猴补丁 app 的打开管道，把已存位置塞进打开那一刻 |
| `restore/restorer.ts` | 调度中枢：这次要不要恢复、用哪种方式 |
| `restore/modes.ts` | 三种落位策略 |
| `restore/pixels.ts` | 源模式下的像素级校正 |
| `restore/anchor.ts` | 文件被编辑后，靠标题/块重新定位行号 |
| `restore/background-settle.ts` | 后台标签页的补恢复 |
| `ui/cover.ts` / `ui/cue.ts` | 首绘盖布（前台短盖 / 后台标签页）、恢复后的方位提示 |

## 入口在哪

- [`Restorer`](/src/position/restore/restorer.ts#L13)：[`restoreEphemeralState`](/src/position/restore/restorer.ts#L33)、[`restoreOpen`](/src/position/restore/restorer.ts#L167)。
- [`RestoreModes`](/src/position/restore/modes.ts#L35)：[`maskedRestore`](/src/position/restore/modes.ts#L201)、
  [`landPreview`](/src/position/restore/modes.ts#L310)、[`restoreInjectedSource`](/src/position/restore/modes.ts#L78)、
  [`historyJumpApply`](/src/position/restore/modes.ts#L333)。
- [`OpenPatcher`](/src/position/restore/patcher.ts#L40)：[`installPatches`](/src/position/restore/patcher.ts#L61)。
- 触发点：`main.ts` 的 `file-open` / `active-leaf-change`，以及补丁本身。

## 数据怎么流

```
core 要打开文件
   │
   ▼
OpenPatcher 改写 setViewState 的 eState ── 唯一能做到「无闪烁」的时机
   │
   ▼
Restorer 决定策略 ──► RestoreModes
   │                     ├─ masked（盖布下恢复）
   │                     ├─ land preview（注入过的阅读落点：不遮，等渲染再落）
   │                     └─ injected source（短盖下等编辑器量完，量完就揭）
   │
   ▼
SourcePixelCorrector（仅源模式）── 用 CM6 的真实像素几何校准入没落下
   │
   ▼
anchorToSettledState ── 把「实落位置」回写进记录（这才是真正的落点）
   │
   ▼
RestoreCue 闪一下提示（都在遮罩揭开之后才响）
```

## 有哪些坑

**落点吸收必须在 patcher 里武装，不能放在 `file-open` 处理器**（[`patcher.ts:235`](/src/position/restore/patcher.ts#L235)）：
同文件内的搜索跳转根本不触发 `file-open`，跳转本身会被记下来。

**注入分支必须排在 masked 前面**（[`restorer.ts:124`](/src/position/restore/restorer.ts#L124)）：注入的落点已经在 core
换内容那一刻应用过了 —— 源码走收口（[`restoreInjectedSource`](/src/position/restore/modes.ts#L78)），阅读交给渲染器
（[`landPreview`](/src/position/restore/modes.ts#L310)）。掉到 masked 就等于「在遮罩下把同一个位置再施加一遍」：
多一段空白和一次看不见的纠正，而这两者都没有必要。

**「注入的落点已经在 core 那一刻应用过」是假定，所以要补一次**
（[`landingNotInSight`](/src/position/restore/pixels.ts#L321)，2026-10-10 用户在手机上报的「前进后退
有时候回到顶部」）：注入那条流水线**自己一次都不施加位置**，而那个假定在手机上会落空 —— core 的那次
施加赶在文档交换之前（读盘那几百 ms），换文档时 `scrollTop` 被抹掉 ⇒ 读者停在笔记顶部，而后面三步
没有一个会把他送过去：居中只服务于**点名了一行**的跳转、短盖**只等不纠**、揭幕后那道兜底又因为
「目标行没渲染出来」当场放弃。于是这里按**像素**问一句「目标行此刻在不在眼前」：量不出来、或离视口顶
超过半屏 ⇒ 趁短盖还盖着补一次施加，读者看不见它。
⚠️ 判据**只能**是像素：源码模式的 `getScroll()` 会**回显**请求的值，问它等于问自己想落到哪（见文件头
那条红线）。读不到编辑器、或目标行超出 EOF ⇒ 答「不补」—— 宁可漏一次纠正，也不在没读数的地方瞎猜。

**`scroll <= 0` 的记录不加盖布**（[`modes.ts:261`](/src/position/restore/modes.ts#L261)）：给「什么都没恢复」也加遮罩只会多一段空白，
安卓上尤其明显。

**源码的注入 open 要遮，但只遮到「编辑器量完」为止**（[`restoreInjectedSource`](/src/position/restore/modes.ts#L78)，
2026-10-08/09 用户拍板，多轮真机实测定的）：这条路上「空白 ↔ 内容自己动」只能选一个侧重 —— 编辑器
量完行高之前画出来的帧必定被随后的一次测量推动（core 的两段式落地，实测约 85~145ms），不遮就看得见
那几下。所以盖布（[`maybeCoverOpen`](/src/position/restore/patcher.ts#L374)）是**必须的**，可调的只有
时长（[`settleShortCover`](/src/position/restore/pixels.ts#L385)）：判据是**两个读数**在同一个窗口里都
**没离开过窗口起点** —— ① 保存那一行相对滚动容器顶的偏移（管「落点对不对」），② **视口里最后一条
可见行**的同一偏移（管「眼前那条带子会不会挪」，[`bottomVisibleMeasurer`](/src/position/restore/pixels.ts#L294)）。
**只看 ① 是量错了地方**：core 的重落把**同一行**落在同一个偏移上，那一行全程约等于 0，动的是它下面
那些刚从估算换成真值的区块，换算到屏幕上就是整条带子往下挪。**第二个读数不是整篇文档的测量高度**
（`scrollHeight`，2026-10-09 之前是它）：视口**下方**换真值、嵌入的图片与嵌入笔记加载完，都会改总高度
却改不动眼前那条带子，于是遮罩被一路按到上界；文件越大、视口外没量过的区块越多，白等得越久 ——
用户报的「稍微大一点的文件空白明显更长」就是它。⚠️ **别把「没离开起点」改回「与上一帧比」**（同日
手机实测）：测量是一小步一小步推进的，每帧只挪几个像素（都不到半行）⇒ 逐帧比一路判「没动」，32ms
后照揭，而内容还在挪。**揭幕下限从「第一次量到真几何」那一刻起算**（core 的重落是跟着内容交换走的）
加上 [`SOURCE_COVER_FLOOR_MS`](/src/position/restore/pixels.ts#L72) = 150ms；**上界从「读者看得见
这道遮罩」那一刻起算**（[`appliedAt`](/src/position/ui/cover.ts#L61)）—— [`SOURCE_COVER_MAX_MS`](/src/position/restore/pixels.ts#L73)
= 1000ms，到点照揭。**遮罩在 open 一开始就涂上、两端一致**（2026-10-09 第十二轮之后改判）；但「**读者
看得见**这道遮罩」的时刻两处不同：桌面上涂上就看得见；手机端那一刻全屏的文件列表还盖着正文，要等新内容
进视图（见下面那段）。
⚠️ **起手先推一趟测量、跨两帧再开始观察**（2026-10-09 晚，真机「内容出现后自己动」查到的最后一个洞）：
`noteArrived` 在 `setData` 那一刻就为真，而 CM6 只在 `state.doc` 上**同步**换掉文档 —— 视口重算与 DOM
重画排在它自己的测量趟里（rAF）。这段里 `coordsAtPos` 读到的还是**旧文档的像素**，而旧文档是稳的 ⇒
两个读数一动不动 ⇒ 窗口走完就揭幕，紧接着编辑器才把新画面推上来。起手先推一趟测量、跨两帧，把这段
**必然发生**的空窗吃掉（代价是每次 open 约两帧）。同一条改动还顺手把静默窗口改成
`max(32ms, 2 × 最近帧间隔)`，让慢设备也能按自己的真实节奏攒到两帧证据（桌面上恒等于 32ms）。
**而盖布什么时候动手：两端一致，都在 `setViewState` 那一刻就涂上**（2026-10-09 第十二轮之后改判）。
旧「甲」让桌面/平板**等新内容到了才涂**，理由是「别把一段纯 I/O 等待伪装成加载」（那时 `.view-content`
里留着的还是**上一篇笔记**）—— 可真机上它读起来是**上一篇闪一下**：文件不在内容缓存里时那次读盘要走
磁盘，那几帧屏幕上就是上一篇，接着才白、才换新，**与点击快慢无关**（结构性，用户报的「打开 C 时看见
上一篇的内容闪一下」，慢慢点也一样）。而那次读盘通常**远小于短盖自己的下限**（`SOURCE_COVER_FLOOR_MS`
150），拿它换「屏幕上绝不会出现别的笔记」是划算的。手机端本来就如此（选择文件的过程全屏盖住正文，旧
画面没有读者）。于是 `cover()` 收一个「新内容到了吗」的判据
（[`contentSwapGate`](/src/position/restore/patcher.ts#L412)）—— 它**不再**决定**什么时候涂**（放开了、
涂上照跑），只借给恢复流水线当「什么时候能碰编辑器」的闸门。判据是**两层，从粗到细**：① 编辑器里的
**文档对象**换掉了没有（[`noteArrived`](/src/position/restore/pixels.ts#L240)，挡住 core 异步读盘那几百 ms）；
② 按**内容**认「现在装的是不是**这一次**要打开的那篇」（`expectedContent`，拿 `vault.cachedRead(file)`
与 `view.data` 比）。⚠️ 第一层有个真洞：它只会答一次「换了」，**任何一个别的笔记都满足它**，而 core 的
`FileView.loadFile` 读盘回来**不复核**（2026-10-09 解包 `obsidian.asar` 实测；`onDelete` 里倒有这种守卫）
⇒ 快速连点 A→B→C 时中间篇就能在第一个「换了」上把短盖骗开（用户报的「打开 C 时看见 A 的内容闪一下」）。
所以第二层不是「更严」而是「认出哪一篇」。恢复流水线在新内容没到之前一点都不碰 DOM。
⚠️ 没有「上一篇」要等时（全新 leaf / 同一篇的重放）交回的是 **`undefined`（闸门缺席）**，不是
`() => true` —— 这两者在「读者看得见这道遮罩了吗」上不是一回事（见下文的 `markVisible` / `contentShown`）。
这道判据与跨文件派发原语前那道等待**共用同一段闭包**（见本文末），所以「什么时候能碰编辑器」只有一个答案。
⚠️ **别退回「doc 与 `view.data` 相符」**：`loadFile` 是「先换 `view.file` → `await` 读盘 → 最后
`setData`」，而 `setData` 先写 `data` 再换文档 —— 两者**一起**换，「相符」在读盘之前与之后都成立。
⚠️ **也别在读不到编辑器时答「到了」**（2026-10-09 晚，手机上「还是一样的」就是它）：`MarkdownView.editor`
是 getter，视图刚建 / 刚重建时确实是 `undefined`，而「屏幕上本来就没有上一篇」与「有上一篇、但这一刻
读不到它的文档」是**相反**的两种情况。后者答「到了」等于把闸门直接打开 —— 整条恢复流水线（居中、短盖
量的都是像素）跑在**上一篇**的几何上。读不到编辑器时照样返回一份身份、退到 `view.data` 比对（**空串
一律算没到**）。
这一段里**不做**任何落点纠正，精确纠正只有揭开后的**一次性**检查
（[`relandSourcePixels`](/src/position/restore/pixels.ts#L672)：只修半个视口以上的离谱误差，半屏内的偏差不追 ——
追它就是过去那场看得见的拉锯）。历史：先整条删掉遮罩 ⇒ 空白消失但那几帧的变动露出来 ⇒ 改回这个
短盖形态；再实测 ⇒ 大文件仍动（判据只盯目标行 + 下限早于真几何到手）⇒ 扩成两个读数、下限改锚到
真几何；手机再实测 ⇒ 大文件仍动（逐帧比漏掉小步推进）⇒ 改成与窗口起点比；再实测 ⇒ 空白仍偏长
（读盘被涂成空白 + 第二个读数拿整篇高度）⇒ 读数换成视口里最后一条可见行，并把盖布推迟到新内容到位
（旧「甲」）；**再实测 ⇒ 那个「推迟」在真机上就是「上一篇闪一下」（慢慢点也一样）⇒ 撤销旧「甲」，
两端都在 open 一开始就涂上**。后台标签页那条路另有一套
（[`background-settle.ts`](/src/position/restore/background-settle.ts#L131)）—— 它不可见，空白不花读者的时间。

**注入过的阅读落点也不加盖布**（[`restorer.ts:141`](/src/position/restore/restorer.ts#L141) → [`landPreview`](/src/position/restore/modes.ts#L310)）：阅读视图的首绘是异步的，
跨文件打开一篇大笔记能到 2~3 秒，把这段渲染期遮住就是一片空白（同一个文件因为渲染器早已
就绪则察觉不到）。而**注入过的落点已经交到 core 自己的渲染流水线上**（patcher 注入的
`{scroll}` → `applyScrollDelayed` 在渲染器就绪时落它），没有「未恢复的顶部」要藏 —— 于是
撤遮罩在这里是安全的。其余阅读恢复没有人替它落定，遮罩照旧。

**同一 leaf + 同一文件已有恢复在跑就直接返回**（[`restorer.ts:179`](/src/position/restore/restorer.ts#L179)）：不 supersede、不揭幕 ——
揭幕会掀掉 settle 期间首次绘制的盖布。supersession 按 **leaf** 作用域，不是全局（[`restorer.ts:243`](/src/position/restore/restorer.ts#L243)），
否则另一个面板的 masked 恢复会被判废、盖布永久停在 opacity 0。

**`.is-flashing` 存在就放弃恢复**（[`modes.ts:216`](/src/position/restore/modes.ts#L216)、[`modes.ts:300`](/src/position/restore/modes.ts#L300)）：那是 core 自己的目标优先
（issue #10/#32/#46/#51）。

**源模式必须自己量像素**（`pixels.ts` 存在的唯一理由）：`getScroll()` 会回显请求值，
骗过所有回读校验。所以要看 CM6 的真实几何，且有三道闸（[`pixels.ts:261`](/src/position/restore/pixels.ts#L261)）：
① 文档 identity 先过（同 leaf 切文件时 doc 还是上一篇，量出来是自洽的垃圾）；
② 每次从当前 doc 重新解析行 pos；③ 未渲染行的 `coordsAtPos` 是估计值，不许用。
**`null` 一律当「没有可信数字」，绝不当 0。** 最多校正 2 次（[`pixels.ts:600`](/src/position/restore/pixels.ts#L600)）—— 多轮拉锯就是
历史上那个可见抖动。

**一次「点名一行」的跳转是个例外**：源码模式下它的落点由**编辑器自己**给
（[`centerNamedLine()`](/src/position/restore/modes.ts#L420) 走 core 同一个 `scrollIntoView(..., true)`），
而回读要等那次滚动真的应用下去（[`settledScroll()`](/src/position/restore/modes.ts#L451)）——
读早了，上面那套纠正器会把刚落好的视口又拽回去。所以那一路只动一次、动在像素上；
来由见 00 §5。

**⚠️ 但派发之前必须等文档就位**（[`waitContentArrived`](/src/position/restore/modes.ts#L139)，2026-10-09 用户拍板）：
`file-open` 经由一个防抖回调发出，而同一个 leaf 上的文档交换是异步的 —— 两者之间那几百 ms 里编辑器
握着的还是**上一个文件**。此刻派发的 `scrollIntoView` 行号会被夹进旧文档的范围、回读到的也是旧文档
的滚动 ⇒ 这次居中完全作废，落点交给按行数估出来的种子（用户报的「点搜索小节位置完全不固定、有时
不在屏内」）。等不到就**干脆不居中**（退回种子）：一次落在旧文档上的居中的滚动 effect 可能在交换之后
才被应用，把视口甩到任意位置 —— 那比不居中更糟。判据的第一层是**编辑器里的文档对象换掉了没有**
（[`noteArrived`](/src/position/restore/pixels.ts#L240)），遮罩那道闸与它**共用同一段闭包**
（patcher 的 `contentSwapGate`，连按内容认的第二层一起共用 —— 所以「点名的这一篇到了吗」与「短盖能不能
揭」问的是同一个答案）—— 闸门只有一处：`centerNamedLine` 自己已经不再等（它只管派发），
等待归调用方（[`restoreInjectedSource`](/src/position/restore/modes.ts#L78)）。⚠️ **别退回「doc 与
`view.data` 相符」**（见上面短盖那一段）—— 「`view.data` 在交换之前就是新的」是个错觉：`setData`
先写 `data` 再换文档，两者一起换。同文件跳转（`historyJumpApply`）不受影响：文档本就在位，
那条路**不经过**这道等待。
**另一头也有一个洞：编辑器晚一步才挂上那个原语时不许放弃居中**（2026-10-09 晚，丙）：「这一步点名了
哪一行」与「编辑器此刻认不认那个原语」是两件事，早先 `namedLineAsk` 把它们混成一个 `undefined` ⇒
`centerNamedLine` 直接放弃居中，落点退回按行数估的种子（用户报的「位置完全不确定、有时不在屏内」）。
拆出只看标记的 `namedLineTarget` 之后，`centerNamedLine` 在两者之间最多等
`CENTER_READY_MAX_FRAMES`（3 帧，按**帧**计 —— 这个洞只在「内容已到、编辑器还差一步挂上」时出现，
那一步是视图构造里同步发生的）；等不到才放弃。

**判「落位了」要两个条件都满足，且「读不出来」算「还没落定」**（[`isRestoreStuck()`](/src/shared/wait.ts#L104)）：
视图报告到了目标行 **且**（阅读模式）真正的 scroller 动过 —— 阅读模式的回读会在像素没动之前
就把请求值回显出来。渲染器没量完时 `getScroll()` 报的是 `null`，那**不是**「已经落定」
（读成 0 就等于「文件顶部」），必须接着等。

**阅读的遮罩要盖到「真落定」，整段只用一条预算**（[`maskedRestore()`](/src/position/restore/modes.ts#L201) 里的 `maskDeadline`）：
预览渲染器**分趟**跑，而它的 `applyScroll` 要求目标行**之前**的每个 section 都已 `computed`
（否则直接拒绝）⇒ **什么时候能落由渲染器决定，与谁先请求无关**。所以拿源码那 600ms
（[`RESTORE_PAINT_DEADLINE`](/src/shared/wait.ts#L23)）去盖阅读，稍微大一点的笔记就会提前揭幕：
读者先看见还在顶部的半成品，而那次没能落下去、被排进渲染器 `rendered` 队列的施加随后才生效
—— 就是「先看见顶部、再接着跳」。阅读那条预算见
[`RESTORE_MASK_BUDGET_PREVIEW`](/src/shared/wait.ts#L40)：**内容就绪与揭幕确认共享它**
（拆成两条会相加，曾经 4 秒），超预算的笔记回到「先看见顶部再跳」，残差由移动端本来就有的
drift 纠正循环收尾。
⚠️ **别指望「让阅读 open 也注入落点」来解决它**：注入只是把请求提前，落不落仍由渲染器那道
`computed` 门说了算 —— 早请求 ≠ 早落。

**盖布只隐藏内层 `.view-content`，不隐藏整个 `containerEl`**（[`applyCover()`](/src/position/ui/cover.ts#L166)）：
后者会把主题页背景露出来（`COVER_SAFETY_MS = 2000` 必须包住「内容就绪 + settle + 静默保持」全程，
所以它从**读者看得见这道遮罩**那一刻起算，见 [`cover()`](/src/position/ui/cover.ts#L93) 与
[`markVisible`](/src/position/ui/cover.ts#L178) —— 遮罩在 open 一开始就涂上、两端一致，所以桌面上就是
涂上那一刻；手机端那一刻全屏列表还盖着正文，起点落在新内容到位。⚠️ 手机端「新内容到位」分两种：有
「上一篇」要等时问那道闸门，**没有**时（闸门缺席 —— 全新 leaf / 同一篇的重放，见上文）改问 leaf 自己
「这篇内容进视图了吗」（`contentShown`）—— 把缺席当成恒真，起点就落回涂上那一刻（全屏列表还没收完），
读盘与列表收起动画会白吃掉短盖的预算，2026-10-09 手机上报的「列表一收，新内容闪一下」正是它）。
前台短盖的时长另有自己的上界（[`SOURCE_COVER_MAX_MS`](/src/position/restore/pixels.ts#L73) = 1000ms），
这道保险定时器是两处的公共兜底。⚠️ 全新的 leaf（`.view-content` 还没建出来）只把容器刷成笔记背景；
手机端的起点要等 `contentShown` 答 true（视图还没有、内容也还没读进来 ⇒ 继续等）。
⚠️ **同一个 leaf 上再武装一次时，判据的归属要照顾两种重入**（[`cover()`](/src/position/ui/cover.ts#L93)
里的 `ready ?? existing?.ready` —— **定义了的替换旧的、缺席的留给旧的**）。core 会**重放**
`setViewState`（未激活标签页的延迟重建、快速切换器再次选中当前文件），重放那一刻 leaf 上那个视图握着的
**就是**这次要打开的文件 —— `contentSwapGate` 找不出「上一篇」的身份，只能交回**缺席**（`undefined`）。
若让缺席顶掉先武装的闸门，**恢复流水线**整条跑在**旧文档**的几何上 —— 旧文档是稳的，短盖当场判定
「量完了」而揭幕，读者正看见新内容自己画出来（2026-10-09 手机上报的「还是看见源码渲染的过程」就是它）。
所以**缺席时保住已有的那道**。但**换了文件**的重入（快速连点 A→B→C）要的相反：那几道闸门问的都是
「**这一篇**的内容进编辑器了吗」，**留住最先武装的那道**会让短盖等在 A 上 —— 中间篇被画出来的那一瞬
它就揭幕了（用户报的「打开 C 时看见 A 的内容闪一下」）。所以**定义了的判据要顶掉旧的**。
⚠️ 别写成三目（`existing ? existing.ready : ready`）：它把「缺席」与「有定义但先到」混成一种，换文件时
新判据永远顶不掉旧的。上界起点（`appliedAt`）是「先来的说了算」，但那与判据是两回事，别类推。

**cue 的宽限**（[`cue.ts:7`](/src/position/ui/cue.ts#L7)，`CUE_DISMISS_GRACE_MS = 2000`）：移动端恢复后的抖动会被轮询
误判成读者移动，没有宽限就是「一闪而过」。**面包屑的锚是「本次落点行」，不是视口顶那一行**
（[`show()`](/src/position/ui/cue.ts#L78) 的 `landingLine`，由 [`markLandingLine()`](/src/position/restore/modes.ts#L518)
的返回值给出）：一次点名了一行的跳转把落点摆到了视口**正中**，视口顶于是落在落点**上方**半屏处 ——
照它命名会念出上一个小节的名字（2026-10-09 用户报的「误报……上面顶部的章节」）。只有普通的保存位置
恢复给不出落点行（那一次落点**就是**视口顶，`getScroll()` 回显的也正是它）。
**面包屑念的前提是屏幕上没有标题**（[`show()`](/src/position/ui/cue.ts#L78) 的 `hasVisibleHeading`，
2026-10-09 用户拍板）：这一屏上有标题可看时，读者自己就知道在哪一节，复述是噪音 ⇒ 不念。判据是
**量「标题自己的 DOM 矩形」与滚动容器的可见矩形求交** —— 源码模式取标题行的 `.cm-line`
（[`sourceLineElement()`](/src/position/ui/cue.ts#L232)）、阅读模式扫 `h1~h6`；`viewport`（已渲染范围）
**只当收窄条件、不当判据**（屏外的标题根本不在 DOM 里，先按它滤掉）。⚠️ 这道门的判据换过三回、三次都
取错「哪一段」：① `.cm-scroller` 上下有 padding，贴着上下沿的取样点落进去 `posAtCoords` 答 null；
② `.cm-content`（`contentDOM`）是**整篇内容**那块，矩形高度 = **整篇文档的高度**，长笔记滚到中段时
取样点大半落在屏外；③ CM6 的 `viewport` 是**已渲染**范围、比可视区**大一圈**，静默太多（用户报
「点了多篇笔记只有一篇显示面包屑，就像完全消失了一样」）。**别再用取样点 / 已渲染范围去答「看没看见」**。
另一道门槛是 [`breadcrumbPath()`](/src/position/ui/cue.ts#L38)：整篇只有一个标题不念、落点还没走进任何
小节不念。**标出落点那一行是另一个开关**（[`flashLine()`](/src/position/ui/cue.ts#L110)）：
前进/后退走到的每一步，编辑模式都把落点居中、落定后闪光标行（[`armLandingMark()`](/src/nav-history/stack.ts#L788)，
[`markLandingLine()`](/src/position/restore/modes.ts#L518)），jump 两种模式都闪，visit/teleport 只在编辑模式；
普通恢复（不是前进后退）走 [`markRestoredLine()`](/src/position/restore/modes.ts#L540)，也只在编辑模式标光标行。
都**只画一下、绝不移动视图**，方式借 core 自己的 `.is-flashing`（编辑模式加在那一行的元素上、
阅读模式加在渲染器章节元素 [`previewLineElement()`](/src/position/ui/cue.ts#L211) 上）。
⚠️ **阅读模式别改用 `setEphemeralState({line})`**：那条路把这一行拉回视口顶，手机上新让开的
那条带子会被一把收回，落点就又看不见了。

**anchor 重定位的四种 key**（[`anchor.ts:31`](/src/position/restore/anchor.ts#L31)）：`outline:<标题>`、`#slug`、`#^block`、
`caller:<时间戳>`。**`note.md#^id` 也带 `#`，必须先判块**，否则全被当成标题 slug（[`anchor.ts:71`](/src/position/restore/anchor.ts#L71)）。
`decodeURIComponent` 遇到孤立 `%` 会抛，必须 try/catch（[`decodeAnchor()`](/src/position/restore/anchor.ts#L113)）。

**被 supersede 的恢复绝不许锚定**（[`modes.ts:465`](/src/position/restore/modes.ts#L465)）；后台恢复走 `noAnchorLeafIds`
（[`background-settle.ts:149`](/src/position/restore/background-settle.ts#L149)），因为记录基线只有活动 leaf 有。

## 怎么验证它没坏

- `npx vitest run tests/restorer-dedup.test.ts`、`restorer-leaf-run.test.ts`、
  `restorer-injected-activate.test.ts`、`restore-source-cover.test.ts`（短盖的边界、出口，循环的四条
  判据：目标行、视口里最后一条可见行、与窗口起点比、视口下方不再算数；遮罩「open 一开始就盖上」、
  读者看得见的起点分平台；以及跨文件那张「文档就位才派发」的闸门）
- `npx vitest run tests/patcher-inject.test.ts`、`patcher-link-text.test.ts`
  （patcher 那张里两条钉住 **A→B→C 的顺序点击**：「中间那篇被画出来时闸门不许开」按内容层认，
  「换了文件时新武装的判据要顶掉旧的」钉 `cover()` 的归属）
- `npx vitest run tests/cue-restore.test.ts`（面包屑的门：屏上有标题就不念、标题都滚出屏就念 ——
  阅读 / 源码各一；编辑器还没建出来也念；落点还没走进任何小节时不念）
- `npx vitest run tests/anchor.test.ts`、`background-settle.test.ts`、`restore-popover-leaf.test.ts`
- 手工验：打开一篇长笔记，视线**不应**先看见文件顶部再跳走（这是整个插件存在的理由）。
