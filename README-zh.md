# Position Restore（位置恢复）

[English](README.md) | 简体中文

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.13.0-8A6BE8)

每次切回一篇笔记，还要手动翻找上次看到的地方？**Position Restore** 为每篇笔记记住光标与滚动位置，重新打开即落在原处——保存的位置随文件打开流程交给 Obsidian 原生应用，源码模式零闪烁，阅读模式无顶部闪跳。

![Position Restore 演示](docs/demo.gif)

## 为什么选它

- **源码模式零闪烁** — 插件把保存的位置合并进 Obsidian 打开文件时的 ephemeral state，由其原生恢复流程直接应用，编辑器首帧即绘制在目标位置，观感与原生打开毫无差别；阅读模式同样在渲染前应用，消除了"先顶部后跳转"的闪跳（渲染期间以短暂空白过渡）
- **光标、滚动一个不落** — 精确回到上次编辑的行列；记录随 vault 持久化，重启 Obsidian、换设备（同步 vault）都不丢
- **顺滑的打开体验** — 源码 / 阅读模式可分别选择立即恢复或平滑滚动（glide）恢复；可选恢复提示（面包屑），恢复完成后显示当前所在的目录层级位置
- **干净、可控的数据库** — 紧凑数组存储 + 自动按最近访问裁剪；可跳过短文件和指定文件夹

## 功能与配置

| 配置项 | 说明 |
| --- | --- |
| 默认行为 | 无保存位置时：使用 Obsidian 默认行为，或跳转到文末 |
| 链接打开行为 | 打开 `[[链接]]` 时恢复保存位置，或总是从文件开头打开（标题/块锚点链接自动让位于链接目标） |
| 恢复方式（源码 / 阅读） | 分别可选**立即恢复**或**平滑滚动（glide）恢复** |
| 恢复提示 | 关 / 面包屑 / 面包屑+提示，恢复完成后显示当前所在的目录层级位置 |
| 排除文件夹 | 跳过指定文件夹（及其子文件夹）内的文件 |
| 最小行数过滤 | 短文件（临时便签等）不记录位置 |
| Bases 滚动记录 | 可选记录 Obsidian Bases 视图的滚动位置 |
| 数据库文件 | 存储路径可自定义，设置中可查看条目数量 |

## 安装

插件尚未上架 Obsidian 官方社区插件市场，可通过以下两种方式安装。

### 通过 BRAT 安装（推荐）

1. 先安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 打开命令面板（`Ctrl/Cmd + P`），执行 **BRAT: Add a beta plugin for testing**
3. 输入仓库地址 `aisahpA/obsidian-position-restore` 并确认
4. 在 **设置** → **第三方插件** 中启用 **Position Restore**

> 之后 BRAT 会自动检测并提示更新，无需手动重新下载。

### 手动安装

1. 从[发布页面](https://github.com/aisahpA/obsidian-position-restore/releases)下载最新版本的 `main.js`、`manifest.json`
2. 在你的仓库中创建 `.obsidian/plugins/position-restore/` 目录，把下载的文件复制进去
3. 重启 Obsidian，在 **设置** → **第三方插件** 中启用 **Position Restore**

## 从 Remember Cursor Position 迁移？

本插件与 [dy-sh/obsidian-remember-cursor-position](https://github.com/dy-sh/obsidian-remember-cursor-position) 的数据格式不同，位置数据不会自动迁移。两个插件同时启用会互相干扰位置恢复，建议安装本插件后禁用或卸载原插件；之后打开过的笔记会逐步建立自己的位置记录。

## 数据存储与隐私

- 位置数据保存在 vault 本地的 JSON 文件中（默认为插件目录下的 `positions.json`），路径可在设置中修改
- 不联网，不上传任何数据；数据库文件可随 vault 一起备份、同步

## 工作原理

每当你在笔记中移动光标或滚动时，插件都会记录当前状态。再次打开同一篇笔记时，插件把保存的位置合并进 Obsidian 打开文件时的 ephemeral state，由 Obsidian 原生恢复流程应用：源码模式首帧即落在目标位置，无感完成；阅读模式则以短暂空白替代了"先顶部后跳转"的闪屏。相比原插件"打开后延时跳转"的方式，恢复在打开过程中就已一次到位，从机制上避免了闪跳。

## 来源与致谢

本插件最初只想优化 [dy-sh/obsidian-remember-cursor-position](https://github.com/dy-sh/obsidian-remember-cursor-position) 的性能、补充一些配置，结果改动远超预期，最终重写并独立成了这个新插件；期间也参考了 [omeyenburg/obsidian-scrolling](https://github.com/omeyenburg/obsidian-scrolling) 项目。感谢这些项目的启发。

## 反馈与支持

- 遇到问题或有功能建议，欢迎[提交 Issue](https://github.com/aisahpA/obsidian-position-restore/issues)
- 如果这个插件对你有帮助，欢迎点一个 [Star](https://github.com/aisahpA/obsidian-position-restore) ⭐
