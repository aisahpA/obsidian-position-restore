# Position Restore

English | [简体中文](README-zh.md)

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.version&label=version&color=blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Obsidian](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&color=8A6BE8&prefix=%3E%3D)

**Position Restore** remembers the cursor and scroll position for each note and puts you right back when it reopens, with back/forward navigation and a recent-files list.

## Features

### Last position

Remembers the cursor and scroll position for each note, and reopens right where you left off: no top flash, no corrective jump. You can exclude notes by folder, line count, or frontmatter property.

### Back and forward

VSCode-style back / forward across file switches, tab switches and in-file jumps (outline clicks, anchor links, large cursor moves). Provided as two commands you can bind hotkeys to.

### Recent files

A record of the notes you have visited.

## Installation

### From Obsidian Community Plugins (recommended)

1. Open **Settings** → **Community plugins** and turn off Restricted mode (safe mode)
2. Click **Browse** and search for **Position Restore**
3. Click **Install** and enable the plugin

### Manual installation

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the [releases page](https://github.com/aisahpA/obsidian-position-restore/releases)
2. Create a `.obsidian/plugins/position-restore/` directory in your vault and copy the downloaded files into it
3. Restart Obsidian and enable **Position Restore** in **Settings** → **Community plugins**

## Feedback & support

- Found a bug or have a feature request? Please [open an issue](https://github.com/aisahpA/obsidian-position-restore/issues)
- If this plugin helps you, consider giving it a [Star](https://github.com/aisahpA/obsidian-position-restore) ⭐
