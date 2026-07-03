'use strict';

const dotsEl = document.getElementById('dots');
const hintEl = document.getElementById('hint');
const addEl = document.getElementById('add');
const tooltipEl = document.getElementById('tooltip');
const menuEl = document.getElementById('menu');
const renameEl = document.getElementById('rename');
const renameInput = document.getElementById('rename-input');
const settingsEl = document.getElementById('settings');
const setStartup = document.getElementById('set-startup');
const setNotify = document.getElementById('set-notify');
const setRich = document.getElementById('set-rich');
const panelHealth = document.getElementById('panel-health');
const setAutoUpdate = document.getElementById('set-autoupdate');
const updateBtn = document.getElementById('set-update-btn');
const updateStatusEl = document.getElementById('update-status');
const updateDot = document.getElementById('update-dot');
let lastHealth = null;
let lastUpdate = null;          // son güncelleme durumu (main'den 'update' olayı)
let updatesSupported = false;   // portable/dev'de false → update UI gizli

const orientSeg = document.getElementById('set-orient');

let sessions = [];
let menuTarget = null;   // session for context menu / rename
let statusErr = '';      // non-empty => engine problem (e.g. pwsh missing)
let orientation = 'horizontal';

// ---- click-through management ----
// The window is mostly transparent and click-through by default. We only capture
// the mouse when it is actually over an interactive element (a dot / the pill / an
// open popup); everywhere else clicks pass through to whatever is behind.
const INTERACTIVE = '#dots, #menu, #rename, #settings';
let capturing = false; // true => mouse events captured (ignore=false)

function setCapture(on) {
  if (on === capturing) return;
  capturing = on;
  window.api.setIgnore(!on); // ignore mouse when NOT capturing
}
function popupOpen() {
  return !menuEl.classList.contains('hidden')
    || !renameEl.classList.contains('hidden')
    || !settingsEl.classList.contains('hidden');
}

document.addEventListener('mousemove', (e) => {
  const overUi = !!(e.target.closest && e.target.closest(INTERACTIVE));
  setCapture(overUi || popupOpen());
});
document.addEventListener('mouseleave', () => {
  if (popupOpen()) return;
  hideTooltip();
  setCapture(false);
});

function stateLabel(status) {
  if (status === 'busy') return 'working';
  if (status === 'waiting') return 'waiting';
  if (status === 'compacting') return 'compacting';
  return '...';
}
function fmtCost(c) { return c >= 1 ? '$' + c.toFixed(2) : '$' + c.toFixed(3); }

function fmtTokens(n) {
  if (!n) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function fmtAge(created) {
  if (!created) return '';
  const secs = Math.floor((Date.now() - created) / 1000);
  if (secs < 60) return secs + 's';
  const m = Math.floor(secs / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

// ---- tooltip ----
function showTooltip(s, rect) {
  const stateCls = s.status === 'busy' ? 't-state-busy'
    : (s.status === 'waiting' ? 't-state-waiting'
    : (s.status === 'compacting' ? 't-state-compacting' : ''));
  tooltipEl.innerHTML =
    `<div class="t-name">${escapeHtml(s.name)}</div>` +
    `<div class="${stateCls}">● ${stateLabel(s.status)}${s.ctx ? ` <span class="t-sub">· context ${Math.round((s.ctxPct || 0) * 100)}% (${fmtTokens(s.ctx)})</span>` : ''}</div>` +
    `<div class="t-sub">${escapeHtml(s.cwd || '?')}</div>` +
    `<div class="t-sub">pid ${s.pid} · ${escapeHtml(s.host || '?')} · ${fmtAge(s.created)}` +
    (s.cost != null ? ` · ${fmtCost(s.cost)}` : '') +
    (s.hwnd ? '' : ' · no window') + `</div>`;
  tooltipEl.classList.remove('hidden');
  const tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
  let left, top;
  if (orientation === 'vertical') {
    left = rect.right + 10;                          // to the right of the dot
    top = rect.top + rect.height / 2 - th / 2;
  } else {
    left = rect.left + rect.width / 2 - tw / 2;      // centered under the dot
    top = 40;
  }
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
  top = Math.max(6, Math.min(top, window.innerHeight - th - 6));
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}
function hideTooltip() { tooltipEl.classList.add('hidden'); }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- render ----
function render() {
  if (statusErr) {
    hintEl.textContent = statusErr;
    hintEl.classList.add('err');
    hintEl.classList.remove('hidden');
  } else {
    hintEl.textContent = 'no sessions';
    hintEl.classList.remove('err');
    hintEl.classList.toggle('hidden', sessions.length > 0);
  }
  dotsEl.classList.toggle('empty', sessions.length === 0 || !!statusErr); // keeps "+" / hint visible

  // reconcile .dot children by pid (leave #hint / #add untouched)
  const existing = new Map([...dotsEl.querySelectorAll('.dot')].map((c) => [c.dataset.pid, c]));
  const wanted = new Set();

  sessions.forEach((s) => {
    wanted.add(String(s.pid));
    let dot = existing.get(String(s.pid));
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'dot';
      dot.dataset.pid = String(s.pid);
      wireDot(dot);
    }
    dot.classList.remove('busy', 'waiting', 'new', 'compacting');
    dot.classList.add(s.status);
    dot._session = s;
    // context-usage ring (workload)
    if (s.ctxPct != null) {
      const p = s.ctxPct;
      dot.style.setProperty('--ctx', p);
      dot.style.setProperty('--ring', p >= 0.9 ? '#ff4d4f' : (p >= 0.75 ? '#ff9f43' : '#5a9cff'));
      dot.style.setProperty('--ring-op', '1');
    } else {
      dot.style.setProperty('--ring-op', '0');
    }
    dotsEl.insertBefore(dot, hintEl); // keep dots before the hint/#add, in created-order
  });

  existing.forEach((c, pid) => { if (!wanted.has(pid)) c.remove(); });

  // keep any open tooltip fresh
  if (!tooltipEl.classList.contains('hidden') && hoverPid != null) {
    const s = sessions.find((x) => x.pid === hoverPid);
    if (s && lastHoverRect) showTooltip(s, lastHoverRect);
  }
}

let hoverPid = null;
let lastHoverRect = null;

function wireDot(dot) {
  dot.addEventListener('mouseenter', () => {
    const s = dot._session; if (!s) return;
    hoverPid = s.pid; lastHoverRect = dot.getBoundingClientRect();
    showTooltip(s, lastHoverRect);
  });
  dot.addEventListener('mouseleave', () => { hoverPid = null; hideTooltip(); });

  dot.addEventListener('click', async () => {
    const s = dot._session; if (!s) return;
    if (!s.hwnd) return;
    await window.api.focus(s.hwnd);
  });

  dot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const s = dot._session; if (!s) return;
    menuTarget = s;
    hideTooltip();
    openMenu(e.clientX, e.clientY);
  });
}

// ---- context menu ----
function openMenu(x, y) {
  menuEl.classList.remove('hidden');
  const mw = menuEl.offsetWidth;
  let left = Math.min(x, window.innerWidth - mw - 6);
  menuEl.style.left = Math.max(6, left) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - menuEl.offsetHeight - 6) + 'px';
}
function closeMenu() { menuEl.classList.add('hidden'); }

menuEl.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act || !menuTarget) return;
  if (act === 'focus') { if (menuTarget.hwnd) window.api.focus(menuTarget.hwnd); closeMenu(); maybeIgnore(); }
  if (act === 'rename') { closeMenu(); openRename(menuTarget); }
  if (act === 'hide') { window.api.hideSession(menuTarget.pid); closeMenu(); maybeIgnore(); }
  if (act === 'kill') { window.api.killSession(menuTarget.pid); closeMenu(); maybeIgnore(); }
});

// ---- rename ----
function openRename(s) {
  renameEl.classList.remove('hidden');
  renameInput.value = s.name || '';
  const dot = dotsEl.querySelector(`.dot[data-pid="${s.pid}"]`);
  const r = dot ? dot.getBoundingClientRect() : { left: window.innerWidth / 2, right: 60, top: 20 };
  if (orientation === 'vertical') {
    renameEl.style.left = (r.right + 10) + 'px';
    renameEl.style.top = Math.max(6, r.top) + 'px';
  } else {
    renameEl.style.left = Math.max(6, Math.min(r.left - 80, window.innerWidth - 190)) + 'px';
    renameEl.style.top = '40px';
  }
  renameInput.focus();
  renameInput.select();
}
function closeRename() { renameEl.classList.add('hidden'); }

renameInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    await window.api.rename({ pid: menuTarget.pid, cwd: menuTarget.cwd, name: renameInput.value });
    closeRename(); maybeIgnore();
  } else if (e.key === 'Escape') { closeRename(); maybeIgnore(); }
});
renameInput.addEventListener('blur', () => { closeRename(); maybeIgnore(); });

function maybeIgnore() {
  // After a popup closes, drop capture unless the pointer is still over the pill.
  if (!dotsEl.matches(':hover')) setCapture(false);
}

// "+" opens a new Claude session
addEl.addEventListener('click', (e) => {
  e.stopPropagation();
  window.api.newSession();
});

// ---- left controls: settings / move / close ----
document.getElementById('c-close').addEventListener('click', (e) => {
  e.stopPropagation();
  window.api.quit();
});
document.getElementById('c-settings').addEventListener('click', async (e) => {
  e.stopPropagation();
  await openSettings();
});
// #c-move: drag the overlay via pointer capture (reliable with click-through;
// keeps firing pointermove even when the cursor leaves the small window).
const cMove = document.getElementById('c-move');
let dragOrigin = false;
cMove.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  try { cMove.setPointerCapture(e.pointerId); } catch {}
  dragOrigin = true;
  window.api.dragStart();
});
cMove.addEventListener('pointermove', () => {
  if (!dragOrigin) return;
  window.api.dragMove(); // main reads the cursor (DPI-correct) and moves the window
});
function endDrag(e) {
  if (!dragOrigin) return;
  dragOrigin = false;
  try { cMove.releasePointerCapture(e.pointerId); } catch {}
  window.api.dragEnd();
}
cMove.addEventListener('pointerup', endDrag);
cMove.addEventListener('pointercancel', endDrag);

async function openSettings() {
  closeMenu(); closeRename();
  const s = await window.api.getSettings();
  setStartup.checked = !!(s && s.openAtLogin);
  setNotify.checked = !(s && s.notify === false);
  setRich.checked = !!(s && s.richData);
  setAutoUpdate.checked = !!(s && s.autoUpdate);
  updatesSupported = !!(s && s.updatesSupported);
  if (s && s.update) lastUpdate = s.update;
  renderUpdatePanel();
  renderHealth();
  markOrient((s && s.orientation) || orientation);
  settingsEl.classList.remove('hidden');
  if (orientation === 'vertical') { settingsEl.style.left = '60px'; settingsEl.style.top = '8px'; }
  else { settingsEl.style.left = '8px'; settingsEl.style.top = '40px'; }
}
function closeSettings() { settingsEl.classList.add('hidden'); }

function markOrient(o) {
  [...orientSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.o === o));
}

setStartup.addEventListener('change', () => window.api.setOpenAtLogin(setStartup.checked));
setNotify.addEventListener('change', () => window.api.setNotify(setNotify.checked));
setRich.addEventListener('change', async () => {
  const ok = await window.api.setRichData(setRich.checked);
  if (!ok) setRich.checked = !setRich.checked; // revert on failure
});

function renderHealth() {
  const h = lastHealth;
  if (!h) { panelHealth.textContent = ''; return; }
  const ok = (b) => (b ? '✓' : '✕');
  panelHealth.innerHTML =
    `<span class="${h.sessions ? 'ok' : 'bad'}">${ok(h.sessions)} sessions</span>` +
    `<span class="${h.statusline ? 'ok' : 'bad'}">${ok(h.statusline)} statusLine</span>`;
}
window.api.onHealth((h) => { lastHealth = h; if (!settingsEl.classList.contains('hidden')) renderHealth(); });

// ---- güncelleme durumu ----
// Sarı nokta: güncelleme hazır/mevcut olduğunda hover gerektirmeden görünür.
function renderUpdateDot() {
  const st = lastUpdate && lastUpdate.status;
  const show = st === 'available' || st === 'ready';
  updateDot.classList.toggle('hidden', !show);
}
// Ayarlar panelindeki anahtar + düğme + durum satırı (duruma göre bağlamsal).
function renderUpdatePanel() {
  const row = document.getElementById('row-auto-update');
  if (!updatesSupported) {
    row.classList.add('hidden');
    updateBtn.classList.add('hidden');
    updateStatusEl.textContent = 'Updates: portable/dev sürümünde kapalı.';
    updateStatusEl.className = 'update-status';
    return;
  }
  row.classList.remove('hidden');
  updateBtn.classList.remove('hidden');
  const u = lastUpdate || { status: 'idle' };
  const v = u.version ? ` (${u.version})` : '';
  updateStatusEl.className = 'update-status';
  updateBtn.disabled = false;
  switch (u.status) {
    case 'checking':
      updateBtn.textContent = 'Checking…'; updateBtn.disabled = true;
      updateStatusEl.textContent = 'Checking for updates…'; break;
    case 'available':
      updateBtn.textContent = 'Update now';
      updateStatusEl.textContent = `Update available${v}`; break;
    case 'downloading':
      updateBtn.textContent = `Downloading ${u.progress || 0}%`; updateBtn.disabled = true;
      updateStatusEl.textContent = `Downloading update${v}…`; break;
    case 'ready':
      updateBtn.textContent = 'Restart & install';
      updateStatusEl.textContent = `Update ready${v} — restart to apply`;
      updateStatusEl.classList.add('ok'); break;
    case 'none':
      updateBtn.textContent = 'Check for updates';
      updateStatusEl.textContent = "You're up to date.";
      updateStatusEl.classList.add('ok'); break;
    case 'error':
      updateBtn.textContent = 'Retry';
      updateStatusEl.textContent = `Update failed: ${u.error || 'unknown'}`;
      updateStatusEl.classList.add('err'); break;
    default: // idle
      updateBtn.textContent = 'Check for updates';
      updateStatusEl.textContent = '';
  }
}
window.api.onUpdate((u) => {
  lastUpdate = u;
  if (u && typeof u.supported === 'boolean') updatesSupported = u.supported;
  renderUpdateDot();
  if (!settingsEl.classList.contains('hidden')) renderUpdatePanel();
});
setAutoUpdate.addEventListener('change', () => window.api.setAutoUpdate(setAutoUpdate.checked));
updateBtn.addEventListener('click', () => {
  if (!updatesSupported) return;
  const st = lastUpdate && lastUpdate.status;
  if (st === 'available' || st === 'ready') window.api.installUpdate();
  else window.api.checkForUpdates(); // idle / none / error → yeniden kontrol
});
// Sarı noktaya tıkla → ayarları aç (kullanıcı "Update now"ı bulsun)
updateDot.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
document.getElementById('set-center').addEventListener('click', () => window.api.resetPosition());
orientSeg.addEventListener('click', (e) => {
  const o = e.target.dataset.o;
  if (o) window.api.setOrientation(o);
});

// orientation applied from main (on load + on change)
window.api.onOrientation((o) => {
  orientation = o === 'vertical' ? 'vertical' : 'horizontal';
  document.body.classList.toggle('vertical', orientation === 'vertical');
  markOrient(orientation);
  // clear any popup stranded at the old orientation's coordinates
  hideTooltip(); closeMenu(); closeRename(); closeSettings(); maybeIgnore();
});

// close popups on: click elsewhere inside the overlay, or window blur (click on
// another app — which can't reach the renderer directly).
document.addEventListener('click', (e) => {
  if (!menuEl.contains(e.target)) closeMenu();
  if (!settingsEl.contains(e.target)) closeSettings();
});
window.api.onPopupClose(() => { closeMenu(); closeRename(); closeSettings(); maybeIgnore(); });
window.api.onStatus((s) => { statusErr = s.ok ? '' : (s.msg || 'hata'); render(); });

// account-wide usage (5-hour rate-limit window), from the statusLine capture
const usageEl = document.getElementById('usage');
const usageFill = document.getElementById('usage-fill');
let usageInfo = '';
window.api.onUsage((u) => {
  const fh = u && u.five_hour;
  if (!fh || fh.used_percentage == null) { usageEl.classList.add('hidden'); return; }
  const p = Math.round(fh.used_percentage);
  usageEl.classList.remove('hidden');
  usageFill.style.setProperty('--u', Math.max(2, p) + '%'); // visible sliver even at low %
  usageFill.style.setProperty('--uc', p >= 80 ? '#ff4d4f' : (p >= 50 ? '#ffb454' : '#5a9cff'));
  let info = `5-hour usage: ${p}%`;
  if (fh.resets_at) { const r = new Date(fh.resets_at * 1000); info += ` · resets ${r.getHours()}:${String(r.getMinutes()).padStart(2, '0')}`; }
  const sd = u.seven_day;
  if (sd && sd.used_percentage != null) info += ` · 7-day: ${Math.round(sd.used_percentage)}%`;
  usageInfo = info;
});
usageEl.addEventListener('mouseenter', () => {
  if (!usageInfo) return;
  tooltipEl.innerHTML = `<div class="t-name">Usage limit</div><div class="t-sub">${escapeHtml(usageInfo)}</div>`;
  tooltipEl.classList.remove('hidden');
  const r = usageEl.getBoundingClientRect();
  const tw = tooltipEl.offsetWidth;
  let left = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = (orientation === 'vertical' ? Math.max(6, r.top) + 'px' : '40px');
});
usageEl.addEventListener('mouseleave', () => hideTooltip());

// ---- data ----
window.api.onSessions((s) => { sessions = s; render(); });
