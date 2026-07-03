# Changelog

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com); this
project adheres to [SemVer](https://semver.org).

## [0.2.2]

### Changed
- **Ayarlar açılınca otomatik güncelleme kontrolü** (yalnızca Auto-update açıkken). Böylece son sürümdeysen
  "Update now" düğmesi elle "Check" gerektirmeden kendiliğinden **pasif** ("You're up to date") olur; güncelleme
  varsa etkin kalır. Auto-update kapalıyken ağa çıkılmaz (elle "Check for updates").

## [0.2.1]

### Fixed
- **Ayarlar paneli kırpılması.** Auto-update öğeleri eklendikten sonra panel pencere yüksekliğini aşıp
  alttan kesiliyordu (Update now / durum / health görünmüyordu). Pencere yüksekliği panele göre ayarlandı;
  panele ayrıca taşma güvenliği (max-height + scroll) eklendi.
- **Yan kontrollerin görünürlüğü.** Ayarlar/taşı/kapat ve `+` düğmeleri pill'in dışında, saydam pencere
  alanında açıldığından parlak masaüstünde görünmüyordu → koyu daire arka plan + gölge ile her zeminde okunur.

### Changed
- **Güncelleme bildirimi sadeleştirildi.** Güncelleme durumu yalnızca Ayarlar panelinde görünür (Auto-update
  anahtarı + "Update now" + durum satırı); ayrı bir overlay göstergesi yok. Buton bağlamsal: kontrol sonrası
  güncelleme yoksa pasif "Update now".

## [0.2.0]

### Added
- **Opt-in otomatik güncelleme.** Ayarlarda "Auto-update" anahtarı (varsayılan **kapalı**) ve "Update now"
  düğmesi. Açıkken başlangıçta + 6 saatte bir GitHub Releases'e bakar; güncelleme varsa ayar dişlisinin
  üstünde **sarı bildirim noktası** belirir (noktaya tıkla → ayarlar). Kapalıyken sıfır ağ çağrısı; "Update
  now" yalnızca tıklanınca kontrol eder. İndirme/kurulum hep açık kullanıcı eylemiyle. Yalnızca kurulan
  (NSIS) sürümde; portable/dev kendini güncellemez. Gizlilik ilkesinin dar istisnası —
  [ADR 0011](docs/adr/0011-opt-in-auto-update.md). (`electron-updater`, native derleme yok.)

### Packaging
- **Kurulum paketi (NSIS).** `npm run dist` artık portable exe'nin yanında bir kurulum paketi
  (`Glance-<version>-Setup.exe`) da üretir. Kurulum masaüstü + Start menü kısayolu oluşturur (Windows
  aramasında görünür) ve "Uygulamalar & özellikler" listesine kaldırma kaydı ekler. Kullanıcı bazlı kurulum
  (yönetici/UAC istemez), tek tık akışı.

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
