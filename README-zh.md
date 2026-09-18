# Position Restore（位置恢复）

[English](README.md) | 简体中文

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.version&label=version&color=blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Obsidian](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&color=8A6BE8&prefix=%3E%3D)

**Position Restore** 为每篇笔记记住光标与滚动位置，重新打开即落回原处——并附带 VSCode 风格的前进/后退导航历史。

## 为什么选它

- **无闪跳恢复** — 笔记重新打开即精确停在上次所在处：无顶部闪跳，无二次跳动
- **光标、滚动一个不落** — 精确回到上次的行列；记录跨重启保留，数据文件放进 vault 后即可跟着你换设备（见[跨设备同步](#跨设备同步)）
- **每个标签页独立记录** — 同一篇笔记开在多个标签页时，每个标签页各自记住自己的位置
- **导航历史** — VSCode 风格的前进/后退，覆盖文件切换、标签页切换和文件内跳转，并提供可浏览的历史列表
- **历史侧栏常驻** — 同一份列表可以变成常驻的侧栏面板：放在哪儿就留在哪儿，随历史变化实时更新，跳转之后依然在原地
- **支持手机端** — 桌面端与移动端均可使用

## 功能

- **位置恢复** — 逐篇笔记记住光标与滚动位置；恢复在文件打开过程内完成，隐藏于短暂空白之下
- **导航历史** — VSCode 风格的前进/后退，覆盖文件切换、标签页切换和文件内跳转（大纲点击、锚点链接、大范围光标跳变、关系图谱），并提供可浏览的历史列表；以后退 / 前进 / 浏览历史三个命令提供，可绑定快捷键
- **历史侧栏** — 「在侧边栏打开导航历史」把同一份列表变成常驻面板：放在哪儿就留在哪儿，随历史变化实时更新，跳转之后面板不会关闭；面板只认明确的点击（对话框里的那份列表也一样），鼠标划过不会有任何反应；跳转是单击行首的箭头，或在行上直接右键——按下去就走，中间不再有菜单要确认。列表默认每篇笔记一行，点一下就（在旁边的面板里）看到你离开它时所在的落点，更早的落点用搜索框找，或把工具栏最右端的设置切到「全部落点」让它们直接列在笔记下面；面板显示的是当时记录的落点，还是这篇笔记现在的样子——一个开关，选过就记住。面板正文里的双链可以直接点，不会再让 WebView 自己跳走
- **恢复方式** — 源码 / 阅读模式可分别选择立即恢复或平滑滚动（glide）恢复
- **恢复提示** — 可选面包屑，恢复完成后显示当前所在的目录层级位置
- **记录过滤** — 排除文件夹、最小行数、frontmatter 属性排除，以及单文件 `position-restore` 属性开关
- **打开行为** — 无保存位置的文件：使用 Obsidian 默认行为或跳到文末；`[[链接]]` 打开：恢复保存位置或总是从开头打开
- **Bases 滚动记录** — 可选记录 Obsidian Bases 视图的滚动位置
- **本地数据库** — 紧凑存储 + 自动裁剪；路径可自定义；完全离线

## 跨设备同步

位置记录保存在插件自己的数据文件里，**它放哪儿决定了它能不能跟着你换设备**：

- **放在插件目录内（默认）** — Obsidian Sync 不会读它：它从社区插件目录里只同步 `data.json`、`main.js`、`manifest.json` 和 `styles.css`，所以就 Obsidian Sync 而言，记录留在写入它的那台设备上。而会整体镜像配置目录的同步工具（坚果云、Remotely Save、iCloud、git）则能原样同步它。
- **放在 vault 内** — 它就是普通的仓库文件，任何同步工具都能带上它。把 **设置 → Position Restore → 数据存储 → 数据文件** 指向一个 vault 路径即可（弹窗里可以选择文件夹，也可以直接选中一个已有的 JSON 文件并采用它）；原路径上已有的记录会在迁移时合并进来，设置项里也会显示当前文件的位置。若用 Obsidian Sync，还需在**每台设备**上开启 **Sync → 选择性同步 → 同步其他所有类型文件**，并且不要用名称以 `.` 开头的文件夹——它会排除这些目录（配置文件夹是唯一的例外）。

按标签页记录的位置（同一篇笔记开在两个标签页）刻意只在本地保存，不参与同步。

## 安装

### 通过 Obsidian 社区插件市场安装（推荐）

1. 打开 **设置** → **第三方插件**，关闭安全模式（受限模式）
2. 点击 **浏览**，搜索 **Position Restore**
3. 点击 **安装** 并启用插件

### 手动安装

1. 从[发布页面](https://github.com/aisahpA/obsidian-position-restore/releases)下载最新版本的 `main.js`、`manifest.json`、`styles.css`
2. 在你的仓库中创建 `.obsidian/plugins/position-restore/` 目录，把下载的文件复制进去
3. 重启 Obsidian，在 **设置** → **第三方插件** 中启用 **Position Restore**

## 反馈与支持

- 遇到问题或有功能建议，欢迎[提交 Issue](https://github.com/aisahpA/obsidian-position-restore/issues)
- 如果这个插件对你有帮助，欢迎点一个 [Star](https://github.com/aisahpA/obsidian-position-restore) ⭐
