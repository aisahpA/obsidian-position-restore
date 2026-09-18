# Position Restore

English | [简体中文](README-zh.md)

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.version&label=version&color=blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Obsidian](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&color=8A6BE8&prefix=%3E%3D)

**Position Restore** remembers the cursor and scroll position for each note and puts you right back when it reopens — with VSCode-style back/forward navigation history on top.

## Why this plugin

- **Jump-free restore** — the note reopens exactly where you left off: no top flash, no corrective jump
- **Cursor and scroll, both restored** — exact line and column; records persist with the vault across restarts and devices
- **Per-tab positions** — the same note open in several tabs keeps a separate position per tab
- **Navigation history** — VSCode-style back/forward across files, tabs and in-file jumps, with a browsable history list
- **Resident history sidebar** — the same list as a permanent sidebar panel that follows the history while you work, instead of a dialog you open and dismiss
- **Mobile ready** — works on both desktop and mobile

## Features

- **Position restore** — remembers cursor and scroll per note; the restore completes during the file open itself, hidden under a brief blank
- **Navigation history** — VSCode-style back/forward across files, tabs and in-file jumps (outline clicks, anchor links, large cursor moves, graph view), plus a browsable history list; provided as commands you can bind hotkeys to
- **History sidebar** — "Open navigation history in sidebar" turns the same list into a resident panel: it stays where you put it, follows the history as it moves, and a jump leaves it standing. The panel is click-only — nothing happens on hover, in the dialog just as much as in the sidebar, so it cannot change under a passing mouse; a jump is one click on the arrow in front of a row, and a right-click on the row goes there at once — no menu in between. A note prints the spot you left it at, with its older spots one click away (or all of them, with "Landings per note: all"), and the panel shows either the recorded spot or the note as it stands now — one switch, remembered. Links in the panel are links: tapping one opens it, instead of navigating the app away from under you
- **Restore modes** — source / reading mode each choose instant or glide (smooth scroll) restore
- **Restore indicator** — optional breadcrumb showing your position in the folder hierarchy after a restore
- **Recording filters** — excluded folders, minimum line count, frontmatter property exclusion, and a per-file `position-restore` opt-out/in
- **Open behavior** — files without a saved position: Obsidian default or end of file; `[[link]]` opens: restore or always start
- **Bases scroll recording** — optionally record scroll position in Obsidian Bases views
- **Local database** — compact storage with automatic pruning; path customizable; fully offline

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
