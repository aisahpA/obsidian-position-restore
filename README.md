# Position Restore

English | [简体中文](README-zh.md)

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.version&label=version&color=blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Obsidian](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&color=8A6BE8&prefix=%3E%3D)

Tired of manually hunting for where you left off every time you reopen a note? **Position Restore** remembers the cursor and scroll position for each note and drops you right back — the restore completes within the file open itself, hidden behind a brief blank: the landing is calibrated first and revealed only when stable, with no top flash and no corrective jump. An optimized alternative to the Remember Cursor Position plugin.

![Position Restore demo](docs/demo.gif)

## Why this plugin

- **Exact, jump-free restore** — the restore completes within the file open, under a brief blank: the position is applied and the landing pixel-calibrated before the blank lifts; neither the "top-first then jump" flash nor a corrective jump afterward — when the blank lifts, the note is exactly where you left off
- **Cursor and scroll, both restored** — back to the exact line and column; records persist with the vault and survive app restarts and device switches (via vault sync)
- **Smooth opening experience** — source / reading mode can each choose instant or glide (smooth scroll) restore; an optional restore breadcrumb shows your current position in the folder hierarchy after a restore
- **Flexible recording filters** — exclude selected folders (and their subfolders) from recording, and set a minimum line count so short files (scratch notes, etc.) are never recorded
- **Clean, controllable database** — compact array storage with automatic recency-based pruning

## Features & options

| Option | Description |
| --- | --- |
| Default behavior | When no saved position exists: Obsidian's default, or jump to end of file |
| Link-open behavior | Restore the saved position when opening `[[links]]`, or always open at file start (heading/block anchor links automatically yield to the link target) |
| Restore method (source / reading) | **Instant** or **glide (smooth scroll)** restore, configured separately |
| Restore indicator | Off / breadcrumb / breadcrumb + notice, showing your current position in the folder hierarchy after a restore |
| Excluded folders | Skip files in selected folders (and their subfolders) |
| Minimum length filter | Short files (scratch notes, etc.) are never recorded |
| Bases scroll recording | Optionally record scroll position in Obsidian Bases views |
| Database file | Customizable storage path; entry count shown in settings |

## Installation

### From Obsidian Community Plugins (recommended)

1. Open **Settings** → **Community plugins** and turn off Restricted mode (safe mode)
2. Click **Browse** and search for **Position Restore**
3. Click **Install** and enable the plugin

### Manual installation

1. Download the latest release (`main.js`, `manifest.json`) from the [releases page](https://github.com/aisahpA/obsidian-position-restore/releases)
2. Create a `.obsidian/plugins/position-restore/` directory in your vault and copy the downloaded files into it
3. Restart Obsidian and enable **Position Restore** in **Settings** → **Community plugins**

## Migrating from Remember Cursor Position?

This plugin's data format differs from [dy-sh/obsidian-remember-cursor-position](https://github.com/dy-sh/obsidian-remember-cursor-position), so existing positions won't carry over automatically. Since both plugins restore positions and would interfere with each other, it's best to disable or uninstall the original after installing this one; notes you open afterwards will gradually build up their own records.

## Data storage & privacy

- Positions are stored in a local JSON file inside your vault (default: `positions.json` in the plugin directory); the path is customizable in settings
- No network access, no data uploaded; the database file can be backed up and synced along with your vault

## How it works

Each time you move the cursor or scroll in a note, the plugin records that state. When the note is reopened, the plugin applies the saved position within the open itself: a brief blank covers the screen while the landing is pixel-calibrated, and the reveal shows the note exactly in place — no "top-first then jump" flash, no corrective jump. In source mode (instant restore) the position is additionally merged into the ephemeral state of the file open and applied by Obsidian's native restore, so even tabs opened in the background land correctly. Unlike the original plugin's "delay after open, then jump" approach, the restore completes within the open itself, avoiding the jump at the mechanism level.

## Credits

This plugin started as an attempt to improve the performance of [dy-sh/obsidian-remember-cursor-position](https://github.com/dy-sh/obsidian-remember-cursor-position) and add a few options, but the changes grew far beyond that and it became a standalone rewrite. It also draws on ideas from [omeyenburg/obsidian-scrolling](https://github.com/omeyenburg/obsidian-scrolling). Thanks to these projects for the inspiration.

## Feedback & support

- Found a bug or have a feature request? Please [open an issue](https://github.com/aisahpA/obsidian-position-restore/issues)
- If this plugin helps you, consider giving it a [Star](https://github.com/aisahpA/obsidian-position-restore) ⭐
