# Changelog

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com); this
project adheres to [SemVer](https://semver.org).

## [0.3.0]

### Added
- **Overlay ölçekleme.** Ayarlar → "Size" **−/+ adımlayıcısı** **+ pill üstünde Ctrl+tekerlek** ile tüm
  overlay (nokta/pill/yazı/halka) **0.7–2.0** arası ölçeklenir; kalıcı. `webFrame.setZoomFactor` ile
  hit-test doğru ve CSS koordinat uzayı sabit kaldığından popup/panel **hiç kırpılmaz** ([ADR 0016](docs/adr/0016-overlay-scale-and-direct-drag.md)).
- **Doğrudan sürükleme + yeniden sıralama.** Pill'in **boş zemininden** tutup taşıma (küçük `✥`
  tutamağına ek, daha büyük isabet alanı) ve noktaları **sürükle-bırak** ile yeniden sıralama
  (transform-tabanlı: sürüklenen parmağı takip eder, kardeşler boşluk açar, sıra bırakınca commit;
  runtime'lık) ([ADR 0016](docs/adr/0016-overlay-scale-and-direct-drag.md)).
- **Windows Terminal sekme-düzeyi odak.** Win11'de tüm session'lar tek WT penceresine akar (aynı `hwnd`);
  artık tıklama **UIA** ile DOĞRU sekmeyi seçip öne getirir (başlık = `ai-title` ile eşleşir), eşleşmez
  / UIA hata / WT değilse **pencere-düzeyi odağa** düşer. ADR 0004'ün sekme non-goal'ını WT için geçersiz
  kılar ([ADR 0015](docs/adr/0015-uia-wt-tab-focus.md)).
- **Sağ-tık → "Open folder".** Session'ın klasörünü Explorer'da açar (kullanıcı-tetikli).
- **prefers-reduced-motion.** Sistem "hareketi azalt" açıkken nabız/geçişler kısılır (bloke durum yine
  renk + sabit glow ile ayrışır).
- Tooltip: aynı pencereyi paylaşan session'lar için **"same window (N/M)"** ipucu.

### Fixed
- **Nokta ismi "donuyordu".** Session'ın konusu ilerledikçe değişse de ad ilk mesajda sabit kalıyordu
  (`topic` sessionId başına sonsuza önbellekli + önceliği ezerdi). Artık Claude'un **canlı `ai-title`**'ı
  öncelikli okunur (mevcut transcript-kuyruğu okumasına biner, **ek IO yok**) → ad session'ın o anki
  konusunu izler; `nameSource:"user"` (Claude içinde elle verilen ad) daha da güçlü ([ADR 0014](docs/adr/0014-live-ai-title-naming.md)).

### Changed
- `focus` IPC artık `pid` alır; host/hwnd/başlığı main **izlenen session'dan** çözer (renderer'a güvenmeden)
  → WT'de sekme-düzeyi, aksi halde pencere-düzeyi odak. Bildirim tıklaması da aynı yolu kullanır.

## [0.2.6]

### Fixed
- **"Switch to terminal" düzgün çalışmıyordu.** (1) Taze/idle bir session'ın konuşması yoksa `claude --resume`
  "No conversation found" veriyordu → artık konuşma varsa resume, yoksa taze `claude`. (2) TUI'yi `taskkill /F`
  ile öldürmek barındıran terminali bozup **spam** yapıyordu → artık **dedike konsol** penceresi WM_CLOSE ile
  nazikçe kapatılıyor (X'e basmak gibi).
- **KRİTİK güvenlik:** WM_CLOSE yalnızca **dedike konsol host'unda** (conhost/pwsh/cmd) uygulanıyor. VS Code /
  Windows Terminal gibi multiplexer'da tek session olsa bile pencere kapatmak **tüm editörü/başka sekmeleri**
  kapatabilirdi → o host'larda artık yalnızca session süreci sonlandırılıyor.
- Switch, resume'u ancak **eski süreç tam ölünce** açıyor (WM_CLOSE'un OS grace süresi var; yoksa iki süreç
  aynı konuşmayı açıp bozabilirdi); kapatma teslim edilemezse süreç öldürmeye düşüyor. pid/hwnd izlenen bir
  session'a ait mi doğrulanıyor.
- Overlay: hover edilen session kaybolunca **hayalet tooltip** asılı kalmıyor; popup'ı boş alana tıklayıp
  kapatınca fare yakalama bırakılıyor (masaüstü tıkları bloke olmuyor).

## [0.2.5]

### Added
- **"Switch to terminal"** (sağ-tık menüsü). Session'ı sonlandırıp **aynı konuşmayı** kendi yeni PowerShell
  penceresinde `claude --resume` ile açar — VS Code / Windows Terminal'de sekmeye odaklanamadığımız (OS sınırı)
  durumlarda session'ı odaklanabilir bir pencereye taşımanın pratik yolu ([ADR 0013](docs/adr/0013-hide-bg-sessions-and-switch-to-terminal.md)).

### Fixed
- **Hayalet session.** Claude Code v2.1.199 arka plan job'ları (`kind:"bg"`) dot olarak görünüyordu ama
  terminal penceresi olmadığından tıklanamıyor/kapatılamıyordu (kapatılınca job sistemi yeniden başlatıyordu).
  Artık gizleniyor — Glance yalnızca etkileşimli terminal oturumlarını gösterir.
- **Yanlış pencere odağı.** `BestWindow` ilk-eşleşen sığ yol segmentinde durup yanlış pencereyi seçebiliyordu
  (ör. "Projects" derin "glance"'i ezerdi); artık en derin cwd segmentiyle eşleşen pencere seçiliyor.
- Özel isimler (`byPid`) artık ölen pid'lerde budanıyor — config sonsuza dek büyümüyor ve PID geri
  kullanımında eski isim yeni oturuma yapışmıyor.

## [0.2.4]

### Fixed
- **Soru soran / izin bekleyen session yeşil görünüyordu.** Claude Code v2.1.199, session dosyasına yeni
  `status:"waiting"` + `waitingFor` (ör. "permission prompt") yazıyor; Glance bunu tanımıyordu ve sinyal
  transcript/CPU heuristiğine düşüp yeşil (working) kalıyordu. Artık `waitingFor` okunuyor → 🟠 izin / 🟣 soru.
- **`fresh` (mtime) kısa-devresi.** Yeni meta girdileri (`ai-title`/`mode`/`permission-mode`) dosya mtime'ını
  değiştirdiğinden, soru/izin belirdiği an ~2.5s "working" görünüyordu. mtime yerine `stop_reason` kullanılıyor.

### Changed
- Transcript okuması yeni `type:"message"` formatına ve lider meta girdilerine dayanıklı (`convRole`); dot
  isimlendirmesi sentetik/slash-komut açılışlarını atlıyor. `waitingFor` eşlemesi daha sağlam (boş → yanlış
  "seni bekliyor" üretmez). README + ARCHITECTURE güncellendi.

## [0.2.3]

### Added
- **Daha zengin durumlar.** Nokta artık "seni bekliyor"u ikiye ayırıyor: 🟣 **sana soruyor** (AskUserQuestion /
  plan onayı) ve 🟠 **izin bekliyor** (bir tool için onay). 🟢 çalışıyor ve 🔵 compacting aynı; işi bitip boşta
  bekleyen session artık ⚪ **sönük gri** (acil değil). Böylece "neden duruyor?" tek bakışta belli.
  Transcript'ten türetilir (hook yok, yalnızca tool adı okunur — içerik değil; [ADR 0012](docs/adr/0012-expanded-session-states.md)).
- Bir session seni bloke ettiğinde (soru/izin) **masaüstü bildirimi** ("asking you a question" / "needs your
  approval"); turn bitişi daha hafif "done".

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
