# DEVELOPMENT

Running, building, troubleshooting and calibration.

## Requirements

- **Windows 10/11**
- **PowerShell 7 (`pwsh`)** on `PATH`, **64-bit** — reading another process's PEB needs a 64-bit reader for the
  64-bit `claude.exe`. Check: `pwsh -NoProfile -Command "[Environment]::Is64BitProcess"` → must be `True`.
- **Node ≥ 18** (for Electron)

> No `pwsh`? `winget install Microsoft.PowerShell`. You can also point Glance at a specific path with the
> `CSC_PWSH` environment variable (read by `src/engine.js`).

## Run

```bash
npm install
npm start
```

The overlay appears at the top of the screen and a tray icon is created. Quit from the tray → **Exit**.

## Build / distribute

```bash
npm run dist        # → dist/Glance-<version>-portable.exe (electron-builder, portable, unsigned)
```

- `helper.ps1` is placed outside `app.asar` via `asarUnpack` (an external `pwsh` can't read from inside the
  archive); the engine runs it from `app.asar.unpacked`.
- Icon: `assets/icon.ico` (exe) + `assets/icon.png` (window/tray), bundled.
- **Rich data (exact context % + usage bar)** relies on the statusLine capture, which Glance installs itself
  (Settings → "Rich data" — pure PowerShell, **no `jq`**, chains your existing statusLine). The core
  (state / dots / focus / notifications) works without it via the CPU heuristic + `sessions/<pid>.json`.
  Exact state needs Claude Code **v2.1.198+** (the session file).

## Project layout

```
glance/
├─ package.json
├─ README.md · ARCHITECTURE.md · CHANGELOG.md · DEVELOPMENT.md
├─ .gitignore · .editorconfig · .gitattributes
├─ .github/workflows/       # release: build portable exe + attach to a GitHub Release on tag
├─ src/
│  ├─ main.js               # Electron main: window, tray, config, IPC, click-through, notifications
│  ├─ engine.js             # drives the helper; snapshot → state + workload
│  ├─ helper.ps1            # PowerShell + C#: detection, cwd (PEB), owner-window walk, focus
│  ├─ statusline.ps1        # optional "rich data" capture (jq-free, chains the original)
│  ├─ preload.js            # contextBridge → window.api
│  └─ renderer/             # overlay UI (index.html, styles.css, renderer.js)
└─ assets/                  # icon + mockup
```

Runtime user data: `%APPDATA%/Glance/config.json` (names + settings).

## State detection & the CPU fallback

State is taken (in priority order) from Claude's session file, the statusLine capture, the transcript tail, and
— as a last resort — a CPU heuristic. The CPU fallback uses a **rolling window** (IO proved too noisy). Thresholds
live in `src/engine.js`:

```js
this.pollMs         = 1200;  // poll interval (ms)
this.cpuMsThreshold = 35;    // >35ms CPU in a tick → that tick is "active"
this.strongCpu      = 90;    // >90ms CPU → clearly working, green immediately
this.windowSize     = 4;     // look at the last 4 ticks
this.busyTicks      = 2;     // ≥2 of the last 4 active → working (green)
```

Measured pattern: **idle** sessions stay ≤16ms/tick (scheduler noise), **working** sessions run 30–266ms/tick.
The 35ms threshold separates them cleanly; the rolling window prevents flicker in both directions. To recalibrate
on different hardware, sample per-session CPU deltas and pick a threshold between the working-min and idle-max.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No dots but sessions exist | `pwsh` missing / 32-bit | install 64-bit PowerShell 7; set `CSC_PWSH` |
| Empty cwd / `?` in tooltip | PEB unreadable (perms/bitness) | 64-bit `pwsh`; same user as the process? |
| Click doesn't focus the window | `hwnd=0` (no host window) | tooltip shows "no window"; host not found |
| Wrong color (working ↔ waiting) | heuristic threshold | recalibrate as above |
| Bar blocks desktop clicks | click-through toggle | `main.js` `setIgnoreMouseEvents` / renderer hover logic |
| Helper died, updates stopped | pwsh process exit | the watchdog restarts it; else relaunch the app |

## Notes

- No Node in the renderer (isolated). New capability = a narrow `window.api` method in `preload.js` + IPC in
  `main.js`.
- Helper protocol is line-based: `SNAP` / `FOCUS:<hwnd>` / `EXIT` → `SNAP:{json}` / `FOCUS:ok`.
