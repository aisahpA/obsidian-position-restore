# 02 采集：位置是怎么记下来的

## 这段是干什么的

两个文件，一条腿负责「读」，一条腿负责「什么时候值得写」：

- `position/capture/ephemeral.ts` —— 视图 ⇄ 状态对象的**纯读写**。
- `position/capture/sampler.ts` —— 判断「这次移动算不算读者动的」，并把结论写进 store。

外加 `shared/wait.ts` 提供的一小把等待原语（`nextPaint`、`waitForContentReady`、
`waitForRestorePainted`），恢复那层也用它。

## 入口在哪

- 读：[`readEphemeralState`](/src/position/capture/ephemeral.ts#L7)（热路径，每次都用）、
  [`readSampledState`](/src/position/capture/ephemeral.ts#L104)（走缓存）、
  [`readNavEntryState`](/src/position/capture/ephemeral.ts#L129)（导航用）。
- 写：[`applyEphemeralState`](/src/position/capture/ephemeral.ts#L251)。
- 采集：[`Sampler`](/src/position/capture/sampler.ts#L22)，[`sampleActiveView`](/src/position/capture/sampler.ts#L81)、[`onScrollCapture`](/src/position/capture/sampler.ts#L187)、
  [`flushOnLeave`](/src/position/capture/sampler.ts#L273)。
- 主循环在 [`main.ts:194`](/src/main.ts#L194)：每 100ms 调一次 `manager.sampleActiveView()`。

## 数据怎么流

两条腿，因为**移动端会丢 scroll 事件**：

```
桌面：scroll 事件（捕获阶段）──► onScrollCapture ──┐
     100ms 轮询（只记光标变化）──► sampleActiveView ─┼─► store.write()
移动端：100ms 轮询（记全量，因为事件会丢）──────────┘        │
                                                            ▼
                                                   funnel.settled() / funnel.leave()
```

写入前先过两道闸：`policy/exclusion.ts` 的「这篇笔记该不该记」，与 `hasUserIntent()`
（见下）的「这次是不是读者动的」。

## 有哪些坑

**`getScroll()` 没追上时返回 `null` 而不是 `undefined`**（[`ephemeral.ts:20`](/src/position/capture/ephemeral.ts#L20)）：
`isNaN(null)` 是 false，会漏过旧判断，被 `Math.round` 读成「文件开头」。

**必须 `Math.round`，不能用 `Math.floor`**（[`ephemeral.ts:35`](/src/position/capture/ephemeral.ts#L35)）：floor 的死区不对称，
会产生单向向下漂移；round 的 ±0.5 死区恰好吃掉 `applyScroll` 约 0.04 行的落点误差 ——
于是「存 42 读回 42」，不会多写一次库。

**读 scroll 分三级，别用错**（这是全局最容易踩的坑）：

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 回读 / 校验 / 重落 / 轮询 | **实时** `getScroll()` | 缓存会让 settle 与真实视口脱钩 |
| 导航读取 | `readNavEntryState` | DOM 不在 layout 时才退到 `view.scroll` |
| 桌面 scroll 监听 | `readSampledState` | — |

**移动端任何路径都不许用缓存**。`readSampledState` 会先读 `view.scroll`（[`ephemeral.ts:97`](/src/position/capture/ephemeral.ts#L97)），
那是因为隐藏标签页的 scroller 不在布局里、`scrollTop` 恒为 0；但可见视图必须以实时为准，
因为一次已应用的恢复会把**请求值**写进缓存。

**「读者刚动过吗」有一个 2 秒的绝对窗口**（[`INTENT_WINDOW_MS = 2000`](/src/position/capture/sampler.ts#L51)）：
没有近期输入的位移一律视为程序性移动（同步换文件、懒加载重排），不记。
**这个窗口绝不能从 `lastAnchorAt` 起算**（[`hasUserIntent()`](/src/position/capture/sampler.ts#L405)）。

**嵌入式渲染器内部的滚动一律拒绝**（[`EMBED_BOUNDARY_SELECTOR`](/src/position/capture/sampler.ts#L56)）：`.internal-embed`、`.cm-embed-block`
里滚的不是这篇笔记。

**有选区时必须丢基线**（[`sampler.ts:359`](/src/position/capture/sampler.ts#L359)）：选区跨度不是读者走过的距离。
传送检测只在桌面（[`installTeleportWatcher()`](/src/position/capture/sampler.ts#L320)），阈值非正数一律当 0 —— 坏值的兜底方向是「什么都不记」。

**主题分隔线永不当 anchor**（[`ephemeral.ts:73`](/src/position/capture/ephemeral.ts#L73)）：`---`/`***`/`___` 在重映射扫描里会命中
别处的分隔线。另外 `remapAnchorLine` 返回 `undefined` 表示「不知道」，**不是「没变」**
（[`remapAnchorLine()`](/src/position/capture/ephemeral.ts#L190)），窗口是 30 行、先纯文本后归一化两趟。

**光标在 (0,0) 折叠态直接省略**（[`ephemeral.ts:46`](/src/position/capture/ephemeral.ts#L46)）：让「来过但停在顶部」的墓碑记录保持最小。

## 怎么验证它没坏

- `npx vitest run tests/ephemeral-remap.test.ts` —— anchor 文本重映射。
- `npx vitest run tests/sampler-scroll-capture.test.ts` —— 两条腿的采集。
- `npx vitest run tests/teleport-event.test.ts` —— 推断跳变（含选区、阈值为 0）。
- `npx vitest run tests/landing-absorb.test.ts` —— 落点吸收窗口。
- 手工验：打开一篇长笔记滚到中间，**什么都不做**等两秒，再切走切回来 —— 位置应该还在
  （反之说明把程序性移动误记成了读者移动）。
