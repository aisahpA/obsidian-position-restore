# Position Restore（位置恢复）

[English](README.md) | 简体中文

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.version&label=version&color=blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Obsidian](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&color=8A6BE8&prefix=%3E%3D)

**Position Restore** 为每篇笔记记住光标与滚动位置，重新打开即落回原处，并提供前进/后退导航与一份「最近文件」列表。

## 功能

### 最后位置

为每篇笔记记住光标与滚动位置，重新打开即落回原处：没有顶部闪跳，也没有二次跳动。可以按文件夹、行数，或用 frontmatter 属性排除某些笔记。

### 前进后退

VSCode 风格的前进 / 后退，覆盖文件切换、标签页切换和文件内跳转（大纲点击、锚点链接、光标大幅移动）。以后退、前进两个命令提供，可绑定快捷键。

### 最近文件

记录你访问过的笔记。

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
