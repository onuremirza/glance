# Glance — Architecture

> A local overlay that shows running Claude Code sessions as a bar of dots at the top of the screen ·
> Tech: Electron + PowerShell/Win32.

## Responsibility

One job: **detect the `claude.exe` sessions running on this machine, present their live state
(working / asking you / needs approval / idle / compacting) in a minimal always-on-top bar, and jump to the
right terminal window on click.** It does not _manage_ sessions (no start/stop) and does not read Claude's
conversation content (only structural signals — status, `stop_reason`, tool _names_ — never message text).

## Process topology

Three layers, fed in one direction:

```
┌─────────────────────────── Electron ───────────────────────────┐
│  Renderer (overlay)  ⇄ IPC ⇄  Main  ── stdin/stdout ──▶ Helper   │
│  HTML/CSS/JS               Node.js                     pwsh + C#  │
│  dots / tooltip / menu     window, tray, config        Win32 API  │
└─────────────────────────────────────────────────────────────────┘
                                                          │
                                                          ▼
                                          Windows processes (claude.exe …)
```

- **Renderer** (`src/renderer/*`): frameless, transparent, always-on-top bar. Presentation + interaction only.
  No Node access (`contextIsolation`); a narrow `window.api` surface via `preload.js`.
- **Main** (`src/main.js`): BrowserWindow + Tray + config + IPC routing + click-through + notifications.
- **Engine** (`src/engine.js`): runs the helper as **one persistent process**, polls it with `SNAP`, and turns
  each snapshot into session state + workload (joining Claude's own data — see below).
- **Helper** (`src/helper.ps1`): a C# P/Invoke layer compiled in-process via `Add-Type` inside PowerShell 7.
  **No native Node module** (no build toolchain) — minimal install friction on Windows.

## Data flow (one poll)

1. Main writes `SNAP\n` → the helper runs `Get-Snapshot`.
2. The helper enumerates `claude.exe` processes (`Win32_Process`) and for each reads:
   - **cwd** — the target's PEB via `NtQueryInformationProcess` + `ReadProcessMemory` (the project name).
   - **owner window** — walk up the process tree to the first ancestor with `MainWindowHandle != 0` (VS Code /
     Windows Terminal / console), refined by title match to the right project window. On click, a **Windows
     Terminal** session is focused at the **tab** level via UI Automation — the helper matches the tab whose
     title equals the session's live `ai-title` and `Select()`s it, falling back to window-level focus
     ([ADR 0015](docs/adr/0015-uia-wt-tab-focus.md)).
   - **metrics** — CPU time (`TotalProcessorTime`) + IO transfer counters (CPU-heuristic fallback).
3. The helper returns a single line `SNAP:{json}`.
4. The engine parses it, joins each session with Claude's own data for state + workload (below), prunes dead
   PIDs, sorts by start time, and emits `sessions` to the renderer.

## State & workload sources (priority order)

There is no direct "is Claude waiting for input?" signal from the outside, so Glance joins several sources,
most authoritative first:

1. **`~/.claude/sessions/<pid>.json`** (Claude Code v2.1.198+) — exact `sessionId` + live `status`
   (`busy` → working, `idle`, `compacting`) + name. Authoritative for busy-vs-idle; `idle` is then *refined* by
   the transcript tail (see below) into `asking you` / `needs approval` / `idle`.
2. **statusLine capture** (optional "rich data") — exact context-window % + account 5h/7d usage + cost, from the
   JSON Claude pipes to its statusLine command. Installed by Glance as a pure-PowerShell script (no `jq`) that
   **chains** the user's original statusLine.
3. **Transcript tail** — splits an idle session by its last assistant turn (see [ADR 0012](docs/adr/0012-expanded-session-states.md)):
   a pending `tool_use` whose **name** is `AskUserQuestion`/`ExitPlanMode` → **question** (asking you); any other
   pending tool → **permission** (needs approval); `stop=end_turn` → **idle** (done); a `user`/tool-result entry
   or a recent write → **working**. Only the tool *name* is read, never its content. Also yields context tokens.
4. **CPU heuristic** (last resort) — a rolling window over per-tick CPU deltas; see [DEVELOPMENT.md](DEVELOPMENT.md).

## Reliability

- **Watchdog** — if the helper process dies the engine restarts it with exponential backoff (capped by
  `maxRestarts`; past the cap it reports via a `status` event). The counter resets on the first good snapshot.
- **Snap timeout** — polling is single-flight; if no reply arrives within `pollMs*4` the tick is considered lost
  and rescheduled, so one dropped reply never freezes polling permanently.
- **Health** — if `pwsh` can't start or the helper crash-loops, `status:{ok:false,msg}` surfaces in the tray
  tooltip and a red hint in the overlay.

## Persistent state

- `app.getPath('userData')/config.json` — session names and settings. `byPid` (per-PID custom name) and
  `settings` (`newSessionDir`, `pos` = dragged position, `orientation`, `scale` = overlay zoom, `notify`,
  `origStatusLine`). Name resolution: `byPid[pid] → Claude name (nameSource:user) → live ai-title →
  first-message topic → Claude's derived slug → folder basename (#N)` — the live `ai-title` keeps the label
  current as the session's topic evolves ([ADR 0014](docs/adr/0014-live-ai-title-naming.md)). Auto names and
  dot order aren't persisted (derived at runtime).
- No other DB / cache / queue.

## Ports / permissions

- **No network by default.** No sockets are opened, no external calls are made — except the **opt-in
  auto-updater** (off by default), which checks GitHub Releases only when the user enables it (ADR 0011).
- Permissions needed: reading the user's own processes (`PROCESS_VM_READ | QUERY_INFORMATION`) and window focus
  (`user32`). No admin required (for processes in the same user session).

## Distribution

`npm start` for development; `npm run dist` builds a **Windows installer (NSIS) + a portable `.exe`** with
electron-builder (`--publish never`; the release step uploads). A GitHub Actions workflow builds and attaches
them — plus `latest.yml` for the opt-in auto-updater — to a Release on a `v*` tag.

## Key decisions

Electron overlay; PowerShell + C# (PEB) backend with no native deps; authoritative state from Claude's session
file with heuristic fallbacks; live `ai-title` naming; **tab-level focus in Windows Terminal via UI Automation**
(window-level fallback elsewhere); jq-free, chaining statusLine capture; `webFrame` overlay scaling;
user-triggered rename / open-folder / hide / terminate.
