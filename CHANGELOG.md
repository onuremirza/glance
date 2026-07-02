# Changelog

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com); this
project adheres to [SemVer](https://semver.org).

## [0.1.0]

First public release. A minimal always-on-top Windows overlay that shows running Claude Code sessions as dots.

### Sessions & state
- Detects `claude.exe` sessions via a persistent PowerShell helper (WMI enumeration + a C# P/Invoke layer that
  reads each process's working directory from its PEB). No native Node modules.
- Filters out non-session processes (subagent/worker `claude.exe` children, headless `-p`/`--print` runs).
- **Exact state** from Claude's own `~/.claude/sessions/<pid>.json` (working / waiting / compacting); transcript
  tail and a CPU rolling-window heuristic as fallbacks for older versions.
- Auto-names each dot from the session's topic (first transcript message), with per-cwd disambiguation; manual
  rename always wins.

### Overlay
- Dot per session: 🟢 working · 🔴 waiting for you · 🔵 compacting. Hover shows project, state, context %, cost,
  pid; click focuses the terminal window; right-click to rename / hide / terminate; `+` starts a new session.
- **Context-usage ring** around each dot (workload) and an account **usage bar** (5-hour limit).
- **Desktop notification** when a session flips working → waiting.
- Horizontal or vertical layout, draggable (position persisted, multi-monitor aware), always-on-top,
  click-through, single-instance, tray menu, dimmed "empty" look.
- Left controls (settings / move / close) and `+` are absolute so revealing them never shifts the dots.

### Focus
- Brings the session's terminal window forward. For shared-process hosts (VS Code, Windows Terminal) it matches
  the project by window title so the correct window is focused. Tab-level focus is an OS limitation.

### Rich data (optional)
- Exact context % and the usage bar come from the JSON Claude pipes to its statusLine. Settings → "Rich data"
  installs a pure-PowerShell capture (**no `jq`, no manual editing**) that **chains** your existing statusLine so
  it's preserved; turning it off restores the original (backed up).

### Reliability
- Helper watchdog (restart with backoff), snap timeout (recover from a lost reply), and a health indicator
  (which authoritative data sources are connected).

### Packaging
- `npm run dist` builds a portable `.exe` (electron-builder); a GitHub Actions workflow attaches it to a Release
  on a `v*` tag. Custom app icon; `pwsh`-required, jq-free.
