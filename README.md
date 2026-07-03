<div align="center">

# Glance

**A minimal always-on-top overlay that shows your running Claude Code sessions at a glance (Windows).**

_🟢 working · 🟣 asking you · 🟠 needs approval · ⚪ idle · 🔵 compacting — with a context-usage ring and an account usage bar._

[MIT License](LICENSE)

![Glance overlay](assets/screenshot.png)

</div>

When you run several Claude Code sessions at once, "which one is done, which is still working, which is
**waiting for my input**?" normally means hunting through terminal windows. Glance answers it from a tiny bar
at the top of your screen. Each session is a **dot**:

- 🟢 **green** = working · 🟣 **purple** = asking you a question (or plan approval) · 🟠 **amber** = waiting to
  run a tool (needs your approval) · ⚪ **gray** = idle (finished, waiting for your next prompt) · 🔵 **blue** =
  compacting context
- the **ring** around a dot = context window usage (workload)
- the little bar on the pill = your account's **5-hour usage limit**
- **hover** a dot for details (project, state, context %, cost, pid); **click** to bring its terminal window
  forward; **right-click** to rename / hide / terminate; **`+`** to start a new session

The purple/amber states answer "why did it stop?" at a glance — it's blocked on *you*. A desktop
**notification** fires when a session needs you (asks a question / needs approval), so you don't have to keep
checking.

## Features

- **Rich states** — beyond working/idle, Glance splits "waiting for you" into **asking you a question** (🟣) vs
  **needs approval to run a tool** (🟠), derived from the transcript (tool name only, never its content)
- **Accurate state** from Claude's own session file (`~/.claude/sessions/<pid>.json`); transcript + CPU
  heuristics as a fallback for older versions
- **Workload** — a context-fill ring per dot + tokens/cost in the tooltip
- **Usage limit** — 5-hour / 7-day account usage (optional "rich data")
- **Notifications** when a session needs you (question / approval)
- **Jump to session** — brings the right terminal window forward (matches the project by window title)
- **Horizontal or vertical**, draggable, always-on-top, click-through (never blocks the desktop), single-instance
- **Opt-in auto-update** (off by default) — checks GitHub Releases only when you enable it; no network otherwise
- **Local & private** — no telemetry; detection is pure local process + file inspection (the only optional
  network is the opt-in updater)

## Requirements

- **Windows 10/11**
- **PowerShell 7 (`pwsh`)** on `PATH`, 64-bit _(process inspection + PEB reads)_
- **Claude Code v2.1.198+** for exact status _(otherwise the heuristic fallback is used)_
- **Node ≥ 18** to run from source

> No `jq` and no manual `statusline.sh` editing required. The optional "rich data" is installed by Glance
> itself (see below).

## Install

**Installer (recommended):** grab `Glance-<version>-Setup.exe` from [Releases](../../releases) and run it. It
installs per-user (no admin prompt), adds a desktop + Start-menu shortcut (searchable), and registers an
uninstaller under _Apps & features_. Enable **Auto-update** in Settings to get future versions from within the
app.

**Portable:** prefer no install? Grab `Glance-<version>-portable.exe` and run it directly (portable builds
don't self-update).

_Both are unsigned, so Windows SmartScreen may warn on first launch → More info → Run anyway._

**From source:**

```bash
npm install
npm start
```

Quit from the **tray** icon → Exit. Build the installer + portable exe with `npm run dist`.

## Rich data (optional)

Exact context percentage and the usage-limit bar come from the JSON that Claude only pipes to its **statusLine**
command. Settings (⚙) → **"Rich data"** turns this on in one click:

- Glance installs a pure-PowerShell statusLine capture (**no `jq`**) and **chains** your existing statusLine, so
  your own status line is preserved. Turning it off restores the original (backed up).
- With it off, the app works fully — context % is heuristic and the usage bar is hidden.

## How it works

A persistent PowerShell helper enumerates `claude.exe` processes and, via a small C# P/Invoke layer, reads each
one's working directory (PEB) and resolves the terminal window that owns it. The Electron main process turns
that into the overlay, joins it with Claude's session/statusLine data for exact state and workload, and handles
notifications, focus and the tray. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design.

## License

[MIT](LICENSE) © onuremirza
