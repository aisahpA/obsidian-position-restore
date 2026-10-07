# 03 恢复：打开笔记怎么落回原处

## 这段是干什么的

这是整个项目最复杂的六文件。一句话概括：**要在读者看见第一帧之前，把位置已经在位上摆好。**

| 文件 | 职责 |
|---|---|
| `restore/patcher.ts` | 猴补丁 app 的打开管道，把已存位置塞进打开那一刻 |
| `restore/restorer.ts` | 调度中枢：这次要不要恢复、用哪种方式 |
| `restore/modes.ts` | 四种落位策略 |
| `restore/pixels.ts` | 源模式下的像素级校正 |
| `restore/anchor.ts` | 文件被编辑后，靠标题/块重新定位行号 |
| `restore/background-settle.ts` | 后台标签页的补恢复 |
| `ui/cover.ts` / `ui/cue.ts` | 打开保护盖布、恢复后的方位提示 |

## 入口在哪

- [`Restorer`](/src/position/restore/restorer.ts#L13)：[`restoreEphemeralState`](/src/position/restore/restorer.ts#L33)、[`restoreOpen`](/src/position/restore/restorer.ts#L173)。
- [`RestoreModes`](/src/position/restore/modes.ts#L22)：[`maskedRestore`](/src/position/restore/modes.ts#L92)、[`glideRestore`](/src/position/restore/modes.ts#L334)、
  [`landPreview`](/src/position/restore/modes.ts#L185)、[`restoreInjectedSource`](/src/position/restore/modes.ts#L40)、
  [`historyJumpApply`](/src/position/restore/modes.ts#L219)。
- [`OpenPatcher`](/src/position/restore/patcher.ts#L39)：[`installPatches`](/src/position/restore/patcher.ts#L57)。
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
   │                     ├─ glide（可见滑行）
   │                     ├─ land preview（注入过的阅读落点：不遮，等渲染再落）
   │                     └─ injected source（settle 后揭幕）
   │
   ▼
SourcePixelCorrector（仅源模式）── 用 CM6 的真实像素几何修准落点
   │
   ▼
anchorToSettledState ── 把「实落位置」回写进记录（这才是真正的落点）
   │
   ▼
OpenCover 揭幕 + RestoreCue 闪一下提示
```

## 有哪些坑

**落点吸收必须在 patcher 里武装，不能放在 `file-open` 处理器**（[`patcher.ts:223`](/src/position/restore/patcher.ts#L223)）：
同文件内的搜索跳转根本不触发 `file-open`，跳转本身会被记下来。

**注入分支必须排在 glide 前面**（[`restorer.ts:123`](/src/position/restore/restorer.ts#L123)）：历史跳转要求瞬时落位，
走 glide 会在一块永不揭幕的盖布下空转约 2 秒。

**`scroll <= 0` 的记录不加盖布**（[`modes.ts:137`](/src/position/restore/modes.ts#L137)）：给「什么都没恢复」也加遮罩只会多一段空白，
安卓上尤其明显。

**注入过的阅读落点也不加盖布**（[`restorer.ts:146`](/src/position/restore/restorer.ts#L146) → [`landPreview`](/src/position/restore/modes.ts#L185)）：阅读视图的首绘是异步的，
跨文件打开一篇大笔记能到 2~3 秒，把这段渲染期遮住就是一片空白（同一个文件因为渲染器早已
就绪则察觉不到）。而**注入过的落点已经交到 core 自己的渲染流水线上**（patcher 注入的
`{scroll}` → `applyScrollDelayed` 在渲染器就绪时落它），没有「未恢复的顶部」要藏 —— 于是
撤遮罩在这里是安全的。其余阅读恢复没有人替它落定，遮罩照旧。

**同一 leaf + 同一文件已有恢复在跑就直接返回**（[`restorer.ts:179`](/src/position/restore/restorer.ts#L179)）：不 supersede、不揭幕 ——
揭幕会掀掉 settle 期间首次绘制的盖布。supersession 按 **leaf** 作用域，不是全局（[`restorer.ts:242`](/src/position/restore/restorer.ts#L242)），
否则另一个面板的 masked 恢复会被判废、盖布永久停在 opacity 0。

**`.is-flashing` 存在就放弃恢复**（[`modes.ts:106`](/src/position/restore/modes.ts#L106)、[`modes.ts:187`](/src/position/restore/modes.ts#L187)）：那是 core 自己的目标优先
（issue #10/#32/#46/#51）。

**源模式必须自己量像素**（`pixels.ts` 存在的唯一理由）：`getScroll()` 会回显请求值，
骗过所有回读校验。所以要看 CM6 的真实几何，且有三道闸（[`pixels.ts:155`](/src/position/restore/pixels.ts#L155)）：
① 文档 identity 先过（同 leaf 切文件时 doc 还是上一篇，量出来是自洽的垃圾）；
② 每次从当前 doc 重新解析行 pos；③ 未渲染行的 `coordsAtPos` 是估计值，不许用。
**`null` 一律当「没有可信数字」，绝不当 0。** 最多校正 2 次（[`pixels.ts:257`](/src/position/restore/pixels.ts#L257)）—— 多轮拉锯就是
历史上那个可见抖动。

**一次「点名一行」的跳转是个例外**：源码模式下它的落点由**编辑器自己**给
（[`centerNamedLine()`](/src/position/restore/modes.ts#L288) 走 core 同一个 `scrollIntoView(..., true)`），
而回读要等那次滚动真的应用下去（[`settledScroll()`](/src/position/restore/modes.ts#L306)）——
读早了，上面那套纠正器会把刚落好的视口又拽回去。所以那一路只动一次、动在像素上；
来由见 00 §5。

**判「落位了」要两个条件都满足**（[`isRestoreStuck()`](/src/shared/wait.ts#L67)）：视图报告到了目标行 **且**（阅读模式）
真正的 scroller 动过 —— 阅读模式的回读会在像素没动之前就把请求值回显出来。

**盖布只隐藏内层 `.view-content`，不隐藏整个 `containerEl`**（[`cover.ts:87`](/src/position/ui/cover.ts#L87)）：
后者会把主题页背景露出来（`COVER_SAFETY_MS = 2000` 必须包住「内容就绪 + settle + 静默保持」全程）。

**cue 的宽限**（[`cue.ts:7`](/src/position/ui/cue.ts#L7)，`CUE_DISMISS_GRACE_MS = 2000`）：移动端恢复后的抖动会被轮询
误判成读者移动，没有宽限就是「一闪而过」。**面包屑的两道静音**（[`show()`](/src/position/ui/cue.ts#L67)）：这一屏里已经
能看到标题就不复述（[`hasVisibleHeading()`](/src/position/ui/cue.ts#L145)），整篇只有一个标题也不念
（[`breadcrumbPath()`](/src/position/ui/cue.ts#L38)）。**标出落点那一行是另一个开关**（[`flashLine()`](/src/position/ui/cue.ts#L102)）：
恢复时与大纲/搜索/前进后退的跳转后都走它，恢复那一侧在 [`markRestoredLine()`](/src/position/restore/modes.ts#L482)。
两种模式都**只画一下、绝不移动视图**，方式都借 core 自己的 `.is-flashing`（编辑模式加在那一行的
元素上、阅读模式加在渲染器章节元素 [`previewLineElement()`](/src/position/ui/cue.ts#L193) 上）。
⚠️ **阅读模式别改用 `setEphemeralState({line})`**：那条路把这一行拉回视口顶，手机上新让开的
那条带子会被一把收回，落点就又看不见了。

**anchor 重定位的四种 key**（[`anchor.ts:31`](/src/position/restore/anchor.ts#L31)）：`outline:<标题>`、`#slug`、`#^block`、
`caller:<时间戳>`。**`note.md#^id` 也带 `#`，必须先判块**，否则全被当成标题 slug（[`anchor.ts:71`](/src/position/restore/anchor.ts#L71)）。
`decodeURIComponent` 遇到孤立 `%` 会抛，必须 try/catch（[`decodeAnchor()`](/src/position/restore/anchor.ts#L113)）。

**被 supersede 的恢复绝不许锚定**（[`modes.ts:295`](/src/position/restore/modes.ts#L295)）；后台恢复走 `noAnchorLeafIds`
（[`background-settle.ts:151`](/src/position/restore/background-settle.ts#L151)），因为记录基线只有活动 leaf 有。

## 怎么验证它没坏

- `npx vitest run tests/restorer-dedup.test.ts`、`restorer-leaf-run.test.ts`、
  `restorer-injected-activate.test.ts`
- `npx vitest run tests/patcher-inject.test.ts`、`patcher-link-text.test.ts`
- `npx vitest run tests/anchor.test.ts`、`background-settle.test.ts`、`restore-popover-leaf.test.ts`
- 手工验：打开一篇长笔记，视线**不应**先看见文件顶部再跳走（这是整个插件存在的理由）。
