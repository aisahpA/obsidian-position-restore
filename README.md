# Position Restore

English | [简体中文](README-zh.md)

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.version&label=version&color=blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Obsidian](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FaisahpA%2Fobsidian-position-restore%2Fmain%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&color=8A6BE8&prefix=%3E%3D)

**Position Restore** remembers the cursor and scroll position for each note and puts you right back when it reopens — with VSCode-style back/forward navigation history on top.

## Why this plugin

- **Jump-free restore** — the note reopens exactly where you left off: no top flash, no corrective jump
- **Cursor and scroll, both restored** — exact line and column; records persist across restarts, and follow you to other devices once the database sits in the vault (see [Syncing across devices](#syncing-across-devices))
- **Per-tab positions** — the same note open in several tabs keeps a separate position per tab
- **Navigation history** — VSCode-style back/forward across files, tabs and in-file jumps
- **Recent files** — a browsable list of the notes you have been in and the headings/anchors you jumped to, with the same list available as a resident sidebar panel that follows it while you work
- **Mobile ready** — works on both desktop and mobile

## Features

- **Position restore** — remembers cursor and scroll per note; the restore completes during the file open itself, hidden under a brief blank
- **Navigation history** — VSCode-style back/forward across files, tabs and in-file jumps (outline clicks, anchor links, cursor jumps, graph view); provided as commands you can bind hotkeys to
- **Recent files** — "Open recent files" is the notes you have been in, newest first, plus the headings and anchor links you jumped to inside them (a file-less view in the main area — the graph above all — takes a row of its own too, wearing that view's own name and icon; the state it had while you were there is kept alongside, so a local graph opened long after its tab was closed still comes back on the note it was showing). It is its own list, not the back/forward stack: going back and then somewhere else adds a place instead of discarding the ones ahead, and it has its own rules about what it lists — "Folders not listed" and "Properties not listed" — so a folder you keep out of position recording, or a class of notes you exclude by frontmatter, can still be somewhere you navigate back to. A row that names a note opens it plainly — the position database lands it, exactly as the file explorer would — while a row that names a heading or an anchor lands on that spot. How far back the list reaches is the last group in the toolbar gear. Resting the pointer on a row asks Obsidian for its own page preview of that note, and what it opens at is what the row stands for: a note's own row asks for the WHOLE note, scrolled to the spot a plain open would land on, while a row naming a heading asks for that section — and whatever opens is there the moment it appears, rather than jumping to it, which is what the app's own preview does when it is merely handed a line number. Hovering alone is not enough by default, though: this panel appears by name under Core plugins → Page preview, starting with the key (Ctrl/Cmd) required, which is where the app itself starts for the file explorer and every other list, and it is there that you change it.
- **Recent files sidebar** — "Open recent files in sidebar" turns the same list into a resident panel: it stays where you put it, follows the list as it moves, and a travel leaves it standing. The list IS the navigation, and a row is the whole of it: one click opens what that row stands for. The list keeps one row per note (a click opens it at the last spot it stands for); older places are found with the search box (which matches the lines recorded at the time, so "the words I saw" still finds them), or listed under the note by switching the setting at the far end of the toolbar to "Every landing" — each spot then gets a row of its own, printing its line and the section it sits in.
- **Restore modes** — source / reading mode each choose instant or glide (smooth scroll) restore
- **Restore indicator** — optional breadcrumb showing your position in the folder hierarchy after a restore
- **Recording filters** — excluded folders, minimum line count, frontmatter property exclusion, and a per-file `position-restore` opt-out/in
- **Open behavior** — files without a saved position: Obsidian default or end of file; `[[link]]` opens: restore or always start
- **Bases scroll recording** — optionally record scroll position in Obsidian Bases views
- **Local database** — compact storage with automatic pruning; path customizable; fully offline

## Syncing across devices

Position records live in the plugin's own database file, and whether they follow you to another device depends on where that file sits:

- **Inside the plugin folder (the default)** — Obsidian Sync never reads it: out of a community plugin's folder it carries only `data.json`, `main.js`, `manifest.json` and `styles.css`, so as far as Obsidian Sync is concerned the records stay on the device that wrote them. Clients that mirror the whole configuration folder (Nutstore Sync, Remotely Save, iCloud, git) carry it as it stands.
- **Inside the vault** — an ordinary vault file, so every client can carry it. Point **Settings → Position Restore → Data storage → Database file** at a vault path (the dialog picks a folder for you, or an existing JSON file to adopt); records already stored at the old path are merged in on the way, and the settings item states where the file now is. For Obsidian Sync, also enable **Sync → Selective sync → Sync all other types** on *every* device, and avoid a folder whose name starts with `.` — it excludes those (the configuration folder is the single exception).

Per-tab positions (the same note open in two tabs) are deliberately device-local and are never synced.

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
