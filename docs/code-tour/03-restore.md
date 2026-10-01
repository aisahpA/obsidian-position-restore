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

- `class Restorer`（`restorer.ts:14`）：`restoreEphemeralState`（`:35`）、`restoreOpen`（`:177`）。
- `class RestoreModes`（`modes.ts:17`）：`maskedRestore`（`:85`）、`glideRestore`（`:206`）、
  `restoreInjectedSource`（`:37`）、`historyJumpApply`（`:184`）。
- `class OpenPatcher`（`patcher.ts:40`）：`installPatches`（`:58`）。
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

**落点吸收必须在 patcher 里武装，不能放在 `file-open` 处理器**（`patcher.ts:229`）：
同文件内的搜索跳转根本不触发 `file-open`，跳转本身会被记下来。

**注入分支必须排在 glide 前面**（`restorer.ts:125`）：历史跳转要求瞬时落位，
走 glide 会在一块永不揭幕的盖布下空转约 2 秒。

**`scroll <= 0` 的记录不加盖布**（`modes.ts:148`）：给「什么都没恢复」也加遮罩只会多一段空白，
安卓上尤其明显。

**同一 leaf + 同一文件已有恢复在跑就直接返回**（`restorer.ts:185`）：不 supersede、不揭幕 ——
揭幕会掀掉 settle 期间首次绘制的盖布。supersession 按 **leaf** 作用域，不是全局（`:253`），
否则另一个面板的 masked 恢复会被判废、盖布永久停在 opacity 0。

**`.is-flashing` 存在就放弃恢复**（`modes.ts:103`、`:214`）：那是 core 自己的目标优先
（issue #10/#32/#46/#51）。

**源模式必须自己量像素**（`pixels.ts` 存在的唯一理由）：`getScroll()` 会回显请求值，
骗过所有回读校验。所以要看 CM6 的真实几何，且有三道闸（`:162`）：
① 文档 identity 先过（同 leaf 切文件时 doc 还是上一篇，量出来是自洽的垃圾）；
② 每次从当前 doc 重新解析行 pos；③ 未渲染行的 `coordsAtPos` 是估计值，不许用。
**`null` 一律当「没有可信数字」，绝不当 0。** 最多校正 2 次（`:268`）—— 多轮拉锯就是
历史上那个可见抖动。

**判「落位了」要两个条件都满足**（`modes.ts:250`）：视图报告到了目标行 **且**（阅读模式）
真正的 scroller 动过 —— 阅读模式的回读会在像素没动之前就把请求值回显出来。

**盖布只隐藏内层 `.view-content`，不隐藏整个 `containerEl`**（`cover.ts:88`）：
后者会把主题页背景露出来（`COVER_SAFETY_MS = 2000` 必须包住「内容就绪 + settle + 静默保持」全程）。

**cue 的宽限**（`cue.ts:7`，`CUE_DISMISS_GRACE_MS = 2000`）：移动端恢复后的抖动会被轮询
误判成读者移动，没有宽限就是「一闪而过」。墓碑记录（scroll 0 且无光标）不出提示（`:54`）。

**anchor 重定位的四种 key**（`anchor.ts:36`）：`outline:<标题>`、`#slug`、`#^block`、
`caller:<时间戳>`。**`note.md#^id` 也带 `#`，必须先判块**，否则全被当成标题 slug（`:74`）。
`decodeURIComponent` 遇到孤立 `%` 会抛，必须 try/catch（`:122`）。

**被 supersede 的恢复绝不许锚定**（`modes.ts:317`）；后台恢复走 `noAnchorLeafIds`
（`background-settle.ts:157`），因为记录基线只有活动 leaf 有。

## 怎么验证它没坏

- `npx vitest run tests/restorer-dedup.test.ts`、`restorer-leaf-run.test.ts`、
  `restorer-injected-activate.test.ts`
- `npx vitest run tests/patcher-inject.test.ts`、`patcher-link-text.test.ts`
- `npx vitest run tests/anchor.test.ts`、`background-settle.test.ts`、`restore-popover-leaf.test.ts`
- 手工验：打开一篇长笔记，视线**不应**先看见文件顶部再跳走（这是整个插件存在的理由）。
