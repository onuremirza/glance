'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { Engine } = require('./engine');

let win = null;
let tray = null;
let engine = null;
let lastSessions = [];
let _dragBase = null; // window bounds at drag start
const hidden = new Set(); // pids the user chose to hide (not kill) — runtime only
let prevStatus = new Map(); // pid -> last status, for busy→waiting notifications

// Single instance: a second launch just resurfaces the existing overlay.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// Window is mostly transparent + click-through, sized per orientation. Horizontal:
// wide+short (popups open downward). Vertical: narrow-ish+tall (dots stack, popups
// open to the right). Generous so popups/tooltips aren't clipped.
const SIZE = {
  horizontal: { w: 560, h: 460 }, // tall enough for the settings panel (opens downward, ~421px)
  vertical: { w: 400, h: 560 },
};
function orientation() {
  return (config.settings && config.settings.orientation) === 'vertical' ? 'vertical' : 'horizontal';
}
function barSize() { return SIZE[orientation()]; }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

// ---------- config (names + settings) ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = { byPid: {}, settings: { pollMs: 1200 } };

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const c = JSON.parse(raw);
    config = Object.assign({ byPid: {}, settings: {} }, c);
    config.byPid = config.byPid || {};
    config.settings = config.settings || {};
  } catch { /* first run */ }
}
function saveConfig() {
  try { fs.writeFileSync(configPath(), JSON.stringify(config, null, 2)); } catch (e) { console.error(e); }
}

// ---------- rich data (optional): Glance's own pwsh statusLine, no jq / no manual edit ----------
// Claude pipes context% / 5h usage / cost to the statusLine command's stdin. Glance
// installs a pure-PowerShell capture (src/statusline.ps1, copied to a stable path)
// as that command, backing up & restoring the user's original. Opt-in; the app works
// fully without it (heuristic context, no usage bar).
const claudeDir = path.join(os.homedir(), '.claude');
const claudeSettingsPath = path.join(claudeDir, 'settings.json');
const glanceSlPath = path.join(claudeDir, 'glance-statusline.ps1');
const glanceOrigFile = path.join(claudeDir, 'glance-orig-statusline'); // original statusLine command, for chaining
function bundled(rel) {
  return path.join(__dirname, rel).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}
function readClaudeSettings() {
  // returns { obj, existed } or null if the file exists but can't be parsed (never clobber it)
  if (!fs.existsSync(claudeSettingsPath)) return { obj: {}, existed: false };
  try { return { obj: JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')), existed: true }; }
  catch { return null; }
}
function richDataEnabled() {
  const r = readClaudeSettings();
  return !!(r && r.obj.statusLine && typeof r.obj.statusLine.command === 'string'
    && r.obj.statusLine.command.includes('glance-statusline.ps1'));
}
function enableRichData() {
  try {
    const r = readClaudeSettings();
    if (!r) return false; // unparseable settings — abort rather than risk it
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.copyFileSync(bundled('statusline.ps1'), glanceSlPath); // stable location (survives app moves)
    const s = r.obj;
    if (r.existed && !fs.existsSync(claudeSettingsPath + '.glance-bak')) {
      fs.copyFileSync(claudeSettingsPath, claudeSettingsPath + '.glance-bak');
    }
    if (s.statusLine && !(typeof s.statusLine.command === 'string' && s.statusLine.command.includes('glance-statusline.ps1'))) {
      config.settings.origStatusLine = s.statusLine; // remember the user's own statusLine
      saveConfig();
      // give the capture script the original command so it can CHAIN (preserve the line)
      if (typeof s.statusLine.command === 'string') {
        try { fs.writeFileSync(glanceOrigFile, s.statusLine.command); } catch {}
      }
    }
    s.statusLine = { type: 'command', command: `pwsh -NoProfile -ExecutionPolicy Bypass -File "${glanceSlPath.replace(/\\/g, '/')}"`, padding: 0 };
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(s, null, 2));
    return true;
  } catch (e) { console.error('enableRichData', e); return false; }
}
function disableRichData() {
  try {
    const r = readClaudeSettings();
    if (!r) return false;
    const s = r.obj;
    if (config.settings && config.settings.origStatusLine) s.statusLine = config.settings.origStatusLine;
    else delete s.statusLine;
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(s, null, 2));
    try { fs.rmSync(glanceOrigFile, { force: true }); } catch {}
    return true;
  } catch (e) { console.error('disableRichData', e); return false; }
}

function baseName(p) {
  if (!p) return 'claude';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
// Assign a display name to every session. Custom names are keyed by pid ONLY:
// several sessions can share a cwd (e.g. 5 in the same repo), so a per-cwd name
// would wrongly apply to all of them. Un-named sessions default to the folder
// name, disambiguated with "#N" (by start order) when a cwd has more than one.
function enrichNames(list) {
  const cwdCount = {};
  list.forEach((s) => { cwdCount[s.cwd] = (cwdCount[s.cwd] || 0) + 1; });
  const cwdIdx = {};
  return list.map((s) => {
    // Priority: user rename > auto topic (transcript) > Claude's derived name > folder (#N).
    let name = config.byPid[s.pid];
    if (!name && s.topic) name = s.topic;
    if (!name && s.claudeName) name = s.claudeName;
    if (!name) {
      const base = baseName(s.cwd);
      if (cwdCount[s.cwd] > 1) {
        cwdIdx[s.cwd] = (cwdIdx[s.cwd] || 0) + 1;
        name = `${base} #${cwdIdx[s.cwd]}`;
      } else {
        name = base;
      }
    }
    return { ...s, name };
  });
}

// Open a brand-new Claude session in its own PowerShell window (pwsh is already a
// hard requirement of this app). Starts in `settings.newSessionDir` (default:
// home). `start "" ...` opens a detached window; the empty title arg keeps
// `start` from misreading the program name as a window title.
const PWSH = process.env.CSC_PWSH || 'pwsh'; // engine.resolvePwsh ile aynı override
function openNewSession() {
  let dir = (config.settings && config.settings.newSessionDir) || os.homedir();
  if (!dir || !fs.existsSync(dir)) dir = os.homedir(); // stale/missing config dir → don't fail silently
  try {
    const p = spawn('cmd.exe', ['/c', 'start', '', PWSH, '-NoExit', '-Command', 'claude'],
      { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false });
    p.unref();
  } catch (e) { console.error('new session failed', e); }
}

// Terminate a session (and its child processes) by pid.
function killSession(pid) {
  pid = parseInt(pid, 10);
  if (!pid) return;
  try {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    p.unref();
  } catch (e) { console.error('kill failed', e); }
}

// "Switch to terminal": mevcut session'ı BARINDIRAN terminali kapat ve AYNI konuşmayı
// kendi yeni PowerShell penceresinde `claude --resume <sessionId>` ile aç. VS Code /
// Windows Terminal sekmesine odaklanmak OS sınırı (ADR 0004) — bu, ona temiz kaçış yolu.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Session'ın diskte resume edilebilir bir konuşması var mı? (Taze/idle bir session'da
// yoktur → `claude --resume` "No conversation found" der; o durumda taze başlatırız.)
function hasConversation(sessionId, cwd) {
  try {
    const enc = (cwd || '').replace(/[\\/:]/g, '-'); // engine._projectDir ile aynı kodlama
    return fs.existsSync(path.join(os.homedir(), '.claude', 'projects', enc, sessionId + '.jsonl'));
  } catch { return false; }
}

// WM_CLOSE YALNIZ dedike konsol penceresinde güvenli (o pencere = o terminal, kapatınca
// yalnız o kapanır). WT / VS Code / cursor gibi MULTIPLEXER host'larda pencere paylaşılır
// → WM_CLOSE tüm editörü/başka sekmeleri kapatır (felaket) → oralarda ASLA, yalnız kill.
const DEDICATED_HOST = /^(conhost|pwsh|powershell|cmd)\.exe$/i;

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }; // ESRCH → yok
// Bir pid gerçekten ölene kadar bekle (WM_CLOSE'un OS grace süresi var), sonra done(stillAlive).
function waitPidGone(pid, timeoutMs, done) {
  const start = Date.now();
  const tick = () => {
    if (!pidAlive(pid)) return done(false);
    if (Date.now() - start >= timeoutMs) return done(true); // hâlâ yaşıyor (WM_CLOSE başarısız?)
    setTimeout(tick, 250);
  };
  setTimeout(tick, 250);
}

function switchToTerminal({ pid, hwnd, host, sharedWindow, sessionId, cwd } = {}) {
  pid = parseInt(pid, 10);
  // Yalnız İZLENEN bir session üzerinde çalış (renderer'dan gelen pid/hwnd doğrula).
  const tracked = lastSessions.find((s) => s.pid === pid);
  if (!tracked) return;
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // Konuşma varsa aynı session'ı resume et; yoksa taze `claude` (resume hatası olmasın).
  const resumable = UUID_RE.test(sessionId || '') && hasConversation(sessionId, dir);
  const cmd = resumable ? `claude --resume ${sessionId}` : 'claude';
  // Eski terminali kapat: dedike konsolsa pencereyi WM_CLOSE ile nazikçe kapat (X gibi —
  // TUI'yi /F ile öldürüp terminali bozup SPAM yapmaz). Multiplexer host / paylaşılan
  // pencere / kapatma teslim edilemedi → yalnız claude.exe'yi öldür (sekme kalır).
  const canClose = hwnd && hwnd === tracked.hwnd && !sharedWindow && DEDICATED_HOST.test(host || '') && engine;
  const closed = canClose ? engine.closeWindow(hwnd) : false;
  if (!closed) killSession(pid);
  // Eski süreç TAM ölene kadar bekle, SONRA resume et — aksi halde iki süreç aynı session
  // dosyasına yazıp bozar / resume başarısız olur. 6s'de hâlâ yaşıyorsa (WM_CLOSE sessizce
  // başarısız) son çare öldür, sonra aç.
  const openResume = () => {
    try {
      const p = spawn('cmd.exe', ['/c', 'start', '', PWSH, '-NoExit', '-Command', cmd],
        { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false });
      p.unref();
    } catch (e) { console.error('switch-to-terminal failed', e); }
  };
  waitPidGone(pid, 6000, (stillAlive) => {
    if (stillAlive) { killSession(pid); setTimeout(openResume, 600); } // son çare kill + kısa bekle
    else openResume();
  });
}

// ---------- tray icon (generated, no asset file needed) ----------
function trayImage() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
    if (img && !img.isEmpty()) return img.resize({ width: 18, height: 18 });
  } catch { /* fall through */ }
  // fallback: 16x16 green dot
  const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAt0lEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFAJ9wA1G7g0MjAAAAAElFTkSuQmCC';
  try { return nativeImage.createFromBuffer(Buffer.from(png, 'base64')); }
  catch { return nativeImage.createEmpty(); }
}

function positionWindow() {
  const { w, h } = barSize();
  const pos = config.settings && config.settings.pos;
  let x, y;
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    // clamp to the display the saved position is on (multi-monitor aware), not primary
    const d = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y }).workArea;
    x = clamp(pos.x, d.x, d.x + d.width - w);
    y = clamp(pos.y, d.y, d.y + d.height - h);
    win.setBounds({ x, y, width: w, height: h });
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  if (orientation() === 'vertical') {
    x = wa.x + 8; y = wa.y + 8;                  // top-left; dots stack down, popups to the right
  } else {
    x = Math.round(wa.x + (wa.width - w) / 2); y = wa.y + 2; // top-center
  }
  win.setBounds({ x, y, width: w, height: h });
}

function sendOrientation() {
  if (win && !win.isDestroyed()) win.webContents.send('orientation', orientation());
}

let _savePosTimer = null;
function rememberPosition() {
  if (!win || win.isDestroyed()) return;
  if (_savePosTimer) clearTimeout(_savePosTimer);
  _savePosTimer = setTimeout(() => {
    const b = win.getBounds();
    config.settings.pos = { x: b.x, y: b.y };
    saveConfig();
  }, 400); // debounce: 'moved' fires continuously while dragging
}

function createWindow() {
  const { w, h } = barSize();
  win = new BrowserWindow({
    width: w,
    height: h,
    frame: false,
    transparent: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    resizable: false,
    movable: true, // draggable via the "move" handle (-webkit-app-region: drag)
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  positionWindow();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', sendOrientation); // apply saved orientation on load

  // Click-through by default; renderer toggles when hovering interactive elements.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Clicking another app (outside the overlay) can't reach the renderer, so close
  // any open popup (context menu / rename) when the overlay loses focus.
  win.on('blur', () => { if (win && !win.isDestroyed()) win.webContents.send('popup-close'); });

  // Persist the position when the user drags the overlay via the move handle.
  win.on('moved', rememberPosition);

  screen.on('display-metrics-changed', positionWindow);
  screen.on('display-added', positionWindow);
  screen.on('display-removed', positionWindow);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Glance');
  const menu = Menu.buildFromTemplate([
    { label: 'Reposition', click: positionWindow },
    { label: 'Reload', click: () => win && win.reload() },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => win && (win.isVisible() ? win.hide() : win.show()));
}

function pushSessions() {
  // prune hidden pids that have since exited, then drop hidden ones from the view
  const live = new Set(lastSessions.map((s) => s.pid));
  for (const pid of [...hidden]) if (!live.has(pid)) hidden.delete(pid);
  // Aynı şekilde ölmüş pid'lerin özel isimlerini (byPid) buda: aksi halde config
  // sonsuza dek büyür ve Windows pid'i geri kullanınca yeni bir session eski ismi kapar.
  let prunedNames = false;
  for (const pid of Object.keys(config.byPid)) {
    if (!live.has(parseInt(pid, 10))) { delete config.byPid[pid]; prunedNames = true; }
  }
  if (prunedNames) saveConfig();
  const enriched = enrichNames(lastSessions.filter((s) => !hidden.has(s.pid)));
  notifyTransitions(enriched);
  if (win && !win.isDestroyed()) win.webContents.send('sessions', enriched);
}

// Desktop notification on meaningful transitions, fired once. En önemlisi: bir session
// seni bloke ettiğinde (sana soruyor / izin bekliyor) haber ver — çünkü orada duruyor,
// senden aksiyon bekliyor. Turn bitişi (boşta) daha hafif bir "done" bildirimi.
const BLOCKED = (st) => st === 'question' || st === 'permission';
function notifyTransitions(enriched) {
  const enabled = !config.settings || config.settings.notify !== false;
  const next = new Map();
  const fire = (title, body, s) => {
    try {
      const n = new Notification({ title, body });
      n.on('click', () => { if (s.hwnd) engine.focus(s.hwnd); });
      n.show();
    } catch { /* notifications unsupported */ }
  };
  for (const s of enriched) {
    const prev = prevStatus.get(s.pid);
    if (enabled && prev !== undefined) {
      if (BLOCKED(s.status) && !BLOCKED(prev)) {
        // yeni blok: aksiyon lazım
        const body = s.status === 'question' ? `${s.name} — asking you a question` : `${s.name} — needs your approval`;
        fire('Glance — needs you', body, s);
      } else if (s.status === 'waiting' && prev === 'busy') {
        fire('Glance — done', s.name, s); // turn bitti, sıradaki komutu bekliyor
      }
    }
    next.set(s.pid, s.status);
  }
  prevStatus = next;
}

// ---------- auto-update (opt-in; bkz. ADR 0011) ----------
// İlke #1 (ağ yok) burada bilinçli ve dar biçimde gevşetilir: yalnızca GitHub
// Releases'e sürüm kontrolü + indirme. Telemetri/kullanım verisi gitmez. Varsayılan
// KAPALI (config.settings.autoUpdate). Kapalıyken hiç ağa çıkılmaz; kullanıcı ayardan
// açar ya da "Update now" ile elle tetikler (ilke #4: eylemi kullanıcı başlatır).
// Portable exe ve dev modu kendini güncelleyemez → updater tamamen devre dışı.
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const updatesSupported = app.isPackaged && !PORTABLE;
let updateState = { status: 'idle', version: null, progress: 0, error: null, supported: updatesSupported };
let installWhenReady = false; // "Update now" tıklandı → indirme bitince otomatik kur

function sendUpdate() {
  if (win && !win.isDestroyed()) win.webContents.send('update', updateState);
}
function setUpdate(patch) { updateState = { ...updateState, ...patch }; sendUpdate(); }

function initUpdater() {
  if (!updatesSupported) return;
  autoUpdater.autoDownload = false;         // arka plan kontrolü İNDİRMEZ; indirme yalnızca açık eylemle
  autoUpdater.autoInstallOnAppQuit = false; // kurulum yalnızca açık kullanıcı eylemiyle
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    setUpdate({ status: 'available', version: info && info.version });
    if (installWhenReady) startDownload();
  });
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', progress: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    setUpdate({ status: 'ready', version: info && info.version });
    if (installWhenReady) { installWhenReady = false; try { autoUpdater.quitAndInstall(); } catch (e) { console.error(e); } }
  });
  autoUpdater.on('error', (err) => setUpdate({ status: 'error', error: String((err && err.message) || err) }));
}

function checkForUpdates() {
  if (!updatesSupported) return;
  try { autoUpdater.checkForUpdates(); } catch (e) { setUpdate({ status: 'error', error: String(e.message || e) }); }
}
function startDownload() {
  if (!updatesSupported) return;
  try { autoUpdater.downloadUpdate(); } catch (e) { setUpdate({ status: 'error', error: String(e.message || e) }); }
}

app.whenReady().then(() => {
  if (!gotLock) return;
  app.setAppUserModelId('com.glance.overlay'); // required for Windows notifications
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.show(); positionWindow(); } });
  loadConfig();
  createWindow();
  createTray();

  engine = new Engine({ pollMs: (config.settings && config.settings.pollMs) || 1200 });
  engine.on('sessions', (s) => { lastSessions = s; pushSessions(); });
  engine.on('usage', (u) => { if (win && !win.isDestroyed()) win.webContents.send('usage', u); });
  engine.on('health', (h) => { if (win && !win.isDestroyed()) win.webContents.send('health', h); });
  engine.on('log', (m) => console.log('[engine]', m));
  engine.on('error', (e) => console.error('[engine]', e));
  engine.on('status', (s) => {
    const base = 'Glance';
    if (tray) tray.setToolTip(s.ok ? base : `${base} — ${s.msg}`);
    if (win && !win.isDestroyed()) win.webContents.send('status', s);
  });
  engine.start();

  // Güncelleme: yalnızca opt-in açıkken başlangıçta + periyodik kontrol (sarı nokta için).
  // Kapalıyken hiçbir ağ çağrısı yapılmaz; sadece elle "Update now" tetikler.
  initUpdater();
  if (config.settings.autoUpdate === true) {
    setTimeout(checkForUpdates, 4000); // pencere yüklensin ki nokta gösterilebilsin
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000); // 6 saatte bir
  }

  // ---------- IPC ----------
  ipcMain.handle('focus', async (_e, hwnd) => engine.focus(hwnd));

  ipcMain.handle('rename', (_e, { pid, name }) => {
    name = (name || '').trim();
    if (name) config.byPid[pid] = name;   // per-session only (see enrichNames)
    else delete config.byPid[pid];
    saveConfig();
    pushSessions();
    return true;
  });

  ipcMain.on('set-ignore', (_e, ignore) => {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.on('new-session', () => openNewSession());

  ipcMain.on('kill-session', (_e, pid) => killSession(pid));

  ipcMain.on('switch-to-terminal', (_e, payload) => switchToTerminal(payload));

  ipcMain.on('hide-session', (_e, pid) => { hidden.add(parseInt(pid, 10)); pushSessions(); });

  ipcMain.handle('get-settings', () => ({
    ...(config.settings || {}),
    orientation: orientation(),
    notify: !config.settings || config.settings.notify !== false, // default on
    richData: richDataEnabled(),
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    autoUpdate: config.settings.autoUpdate === true, // default off
    updatesSupported,
    update: updateState,
  }));

  ipcMain.on('set-notify', (_e, on) => { config.settings.notify = !!on; saveConfig(); });

  ipcMain.handle('set-rich-data', (_e, on) => (on ? enableRichData() : disableRichData()));

  ipcMain.on('set-orientation', (_e, o) => {
    config.settings.orientation = o === 'vertical' ? 'vertical' : 'horizontal';
    delete config.settings.pos; // reset to a sensible default for the new shape
    saveConfig();
    positionWindow();
    sendOrientation();
  });

  ipcMain.on('set-open-at-login', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on });
  });

  // Otomatik güncelleme anahtarı: açınca hemen bir kontrol yap (nokta belirebilsin).
  ipcMain.on('set-auto-update', (_e, on) => {
    config.settings.autoUpdate = !!on;
    saveConfig();
    if (on) checkForUpdates();
  });

  // Elle kontrol (açık kullanıcı eylemi — opt-in kapalı olsa da çalışır).
  ipcMain.handle('check-for-updates', () => { installWhenReady = false; checkForUpdates(); return updateState; });

  // "Update now": hazırsa kur; değilse indir (gerekirse önce kontrol et), bitince kur.
  ipcMain.on('install-update', () => {
    if (!updatesSupported) return;
    if (updateState.status === 'ready') { try { autoUpdater.quitAndInstall(); } catch (e) { console.error(e); } return; }
    installWhenReady = true;
    if (updateState.status === 'available') startDownload();
    else checkForUpdates(); // 'available' değil → kontrol et; event zinciri indirip kurar
  });

  ipcMain.on('reset-position', () => {
    if (config.settings) delete config.settings.pos;
    saveConfig();
    positionWindow();
  });

  // Manual drag (via the move handle) — pointer-capture in the renderer sends
  // screen deltas; app-region drag is unreliable with setIgnoreMouseEvents.
  ipcMain.on('drag-start', () => {
    const b = win.getBounds();
    _dragBase = { win: { x: b.x, y: b.y }, cur: screen.getCursorScreenPoint() }; // all DIP
  });
  ipcMain.on('drag-move', () => {
    if (!_dragBase || !win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const { w, h } = barSize();
    win.setBounds({
      x: _dragBase.win.x + (c.x - _dragBase.cur.x),
      y: _dragBase.win.y + (c.y - _dragBase.cur.y),
      width: w, height: h,
    });
  });
  ipcMain.on('drag-end', () => { _dragBase = null; rememberPosition(); });

  ipcMain.on('quit', () => { app.isQuitting = true; app.quit(); });
});

app.on('window-all-closed', (e) => { /* keep running in tray */ });
app.on('before-quit', () => { if (engine) engine.stop(); });
