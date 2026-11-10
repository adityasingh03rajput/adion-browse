# Adion Browse 🦁🛡️

**Adion Browse** is a high-performance, privacy-first web browser built on top of the real **Chromium** engine, featuring a built-in **Adion Shields** ad & tracker blocking engine inspired by Brave.

---

## 🚀 Key Features

### 1. 🛡️ Adion Shields (Brave-Style Ad & Tracker Blocker)
- **Built-in Network Filtering**: Powered by `@ghostery/adblocker-electron` with **EasyList**, **Peter Lowe's List**, and Ghostery privacy filter databases.
- **Live Shield Badge**: Displays the exact number of blocked ads, trackers, and telemetry scripts directly on the address bar shield icon in real-time.
- **Shields Dropdown Panel**:
  - Site-specific toggle: Turn Shields **UP** or **DOWN** per domain.
  - Tracker & Ad counter per page.
  - Script Blocker (NoScript mode) toggle.
  - Automatic **HTTPS Upgrade** (forces secure encrypted connections).

### 2. ⚡ Brave-Inspired New Tab Dashboard
- **Live Privacy Statistics**:
  - 🛡️ *Trackers & Ads Blocked* count
  - 💾 *Bandwidth Saved* (calculated live in KB / MB)
  - ⏱️ *Time Saved* (calculated live in seconds / minutes)
- **Clock & Date**: High-contrast, elegant typography.
- **Speed Dial Shortcuts Grid**: Quick access to Brave Search, YouTube, GitHub, Reddit, Wikipedia, DuckDuckGo, etc.
- **Integrated Omnibox Search**: Search with Brave Search, DuckDuckGo, Google, or Bing directly.

### 3. 📑 Advanced Tab Management
- Multi-tab browsing powered by isolated Chromium `BrowserView` processes.
- Favicon support, title updates, and loading spinners.
- Keyboard shortcuts:
  - `Ctrl + T`: Open new tab
  - `Ctrl + W`: Close active tab
  - `Ctrl + R` / `F5`: Reload page
  - `Ctrl + L`: Focus and select address bar
  - `Ctrl + H`: Open Browsing History
  - `F12`: Toggle Chromium Developer Tools

### 4. 🔒 Privacy & Security Defaults
- Sandboxed web renderer processes.
- No telemetry or tracking back to external servers.
- Persistent local profile storage saved in user profile data.

---

## 📦 How to Run

### Method 1: One-Click Launch (Windows)
Double-click `run-adion.bat` in this folder.

### Method 2: Command Line
```powershell
npm start
```

---

## 🛠️ Project Structure

```
Adion Browse/
├── package.json               # Dependencies & build scripts
├── run-adion.bat              # One-click Windows launcher
├── src/
│   ├── main/
│   │   ├── index.js           # Electron main process & IPC handlers
│   │   ├── shield.js          # Adion Shields ad & tracker blocker engine
│   │   ├── tabManager.js      # Chromium BrowserView tab management
│   │   └── store.js           # Persistent bookmarks, history & shields stats
│   ├── preload/
│   │   └── preload.js         # Context bridge exposing window.adionAPI
│   ├── renderer/
│   │   ├── index.html         # Browser chrome UI (tabs, omnibox, shields menu)
│   │   ├── styles.css         # Dark cyberpunk / Brave-inspired theme
│   │   └── app.js             # UI state controller & event bindings
│   └── newtab/
│       ├── newtab.html        # Brave-style New Tab dashboard
│       ├── newtab.css         # Stats cards & shortcuts layout
│       └── newtab.js          # Live clock & search logic
```

