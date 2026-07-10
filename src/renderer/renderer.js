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
let lastHealth = null;
let lastUpdate = null;          // son güncelleme durumu (main'den 'update' olayı)
let updatesSupported = false;   // portable/dev'de false → update UI gizli

const orientSeg = document.getElementById('set-orient');
const scaleLabel = document.getElementById('scale-label');
const scaleDn = document.getElementById('scale-dn');
const scaleUp = document.getElementById('scale-up');

let curScale = 1;        // aktif overlay ölçeği (main'den 'scale' olayıyla senkron)
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
  if (status === 'question') return 'asking you';        // AskUserQuestion / plan onayı
  if (status === 'permission') return 'needs approval';  // bir tool için izin bekliyor
  if (status === 'waiting') return 'idle';               // turn bitti, sıradaki komutu bekliyor
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

// Aynı pencereyi (hwnd) paylaşan session'lar (ör. tek WT penceresindeki sekmeler): tıklamada
// artık UIA ile doğru sekme öne gelir; yine de kullanıcıya "bu pencere paylaşılıyor" ipucu ver.
function sharedWindowInfo(s) {
  if (!s.hwnd) return '';
  const sib = sessions.filter((x) => x.hwnd === s.hwnd).sort((a, b) => a.created - b.created);
  if (sib.length < 2) return '';
  const n = sib.findIndex((x) => x.pid === s.pid) + 1;
  return ` · same window (${n}/${sib.length})`;
}

// ---- tooltip ----
function showTooltip(s, rect) {
  // renk sınıfı durumla eşleşir (busy/question/permission/waiting/compacting)
  const KNOWN = ['busy', 'question', 'permission', 'waiting', 'compacting'];
  const stateCls = KNOWN.includes(s.status) ? `t-state-${s.status}` : '';
  tooltipEl.innerHTML =
    `<div class="t-name">${escapeHtml(s.name)}</div>` +
    `<div class="${stateCls}">● ${stateLabel(s.status)}${s.ctx ? ` <span class="t-sub">· context ${Math.round((s.ctxPct || 0) * 100)}% (${fmtTokens(s.ctx)})</span>` : ''}</div>` +
    `<div class="t-sub">${escapeHtml(s.cwd || '?')}</div>` +
    `<div class="t-sub">pid ${s.pid} · ${escapeHtml(s.host || '?')} · ${fmtAge(s.created)}` +
    (s.cost != null ? ` · ${fmtCost(s.cost)}` : '') +
    (s.hwnd ? escapeHtml(sharedWindowInfo(s)) : ' · no window') + `</div>`;
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

// ---- nokta sıralama (drag-drop ile yeniden sıralama; runtime'lık, restart'ta sıfırlanır) ----
// manualOrder: kullanıcının belirlediği pid sırası. Listede olmayan (yeni) session'lar
// created-order'daki yerinde sona eklenir; ölü pid'ler zararsız yok sayılır.
let manualOrder = [];
function applyOrder(list) {
  const rank = (pid) => { const i = manualOrder.indexOf(pid); return i < 0 ? Infinity : i; };
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (rank(a.s.pid) - rank(b.s.pid)) || (a.i - b.i))
    .map((x) => x.s);
}
const dotEl = (pid) => dotsEl.querySelector(`.dot[data-pid="${pid}"]`);
let dotDrag = null;            // aktif nokta sürüklemesi (transform-tabanlı; DOM'u sürükleme boyunca yeniden düzenlemez)
let suppressClickUntil = 0;    // reorder sonrası takip eden click'i (focus) bastır

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

  applyOrder(sessions).forEach((s) => {
    wanted.add(String(s.pid));
    let dot = existing.get(String(s.pid));
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'dot';
      dot.dataset.pid = String(s.pid);
      wireDot(dot);
    }
    dot.classList.remove('busy', 'question', 'permission', 'waiting', 'new', 'compacting');
    dot.classList.add(s.status || 'new'); // boş status classList.add'i patlatmasın
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

  // keep any open tooltip fresh — hover ettiğin session kaybolduysa tooltip'i kapat
  // (dot .remove() edilince mouseleave gelmez → yoksa hayalet tooltip asılı kalırdı)
  if (!tooltipEl.classList.contains('hidden') && hoverPid != null) {
    const s = sessions.find((x) => x.pid === hoverPid);
    if (s && lastHoverRect) showTooltip(s, lastHoverRect);
    else { hideTooltip(); hoverPid = null; }
  }
}

let hoverPid = null;
let lastHoverRect = null;

function wireDot(dot) {
  dot.addEventListener('mouseenter', () => {
    if (dotDrag) return; // sürükleme sırasında tooltip açma
    const s = dot._session; if (!s) return;
    hoverPid = s.pid; lastHoverRect = dot.getBoundingClientRect();
    showTooltip(s, lastHoverRect);
  });
  dot.addEventListener('mouseleave', () => { if (!dotDrag) { hoverPid = null; hideTooltip(); } });

  dot.addEventListener('click', async () => {
    if (Date.now() < suppressClickUntil) return; // az önce sürüklenip bırakıldı → focus etme
    const s = dot._session; if (!s) return;
    if (!s.hwnd) return;
    await window.api.focus(s.pid); // main pid'den host/hwnd/başlığı çözer (WT'de sekme odağı)
  });

  // Sürükle-bırak ile yeniden sırala. DOM'u sürükleme boyunca YENİDEN DÜZENLEMEZ (jitter'ı
  // önler): sürüklenen nokta transform ile parmağı takip eder, kardeşler boşluk açmak için
  // yumuşakça kayar; yeni sıra yalnız BIRAKINCA commit edilir. Eşik 6px (yanlışlıkla click'te
  // reorder tetiklenmesin). Sıra runtime'lık (manualOrder).
  dot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const s = dot._session; if (!s) return;
    dotDrag = { pid: s.pid, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
    try { dot.setPointerCapture(e.pointerId); } catch {}
  });
  dot.addEventListener('pointermove', (e) => {
    if (!dotDrag || e.pointerId !== dotDrag.id) return;
    const vert = orientation === 'vertical';
    if (!dotDrag.moved) {
      if (Math.abs(e.clientX - dotDrag.sx) + Math.abs(e.clientY - dotDrag.sy) < 6) return;
      dotDrag.moved = true;
      hideTooltip(); hoverPid = null;
      // düzeni dondur: mevcut sıradaki noktaların merkezleri = kararlı referans çerçevesi
      const els = [...dotsEl.querySelectorAll('.dot')];
      dotDrag.els = els;
      dotDrag.pids = els.map((d) => parseInt(d.dataset.pid, 10));
      dotDrag.centers = els.map((d) => { const r = d.getBoundingClientRect(); return vert ? r.top + r.height / 2 : r.left + r.width / 2; });
      dotDrag.from = dotDrag.pids.indexOf(dotDrag.pid);
      dotDrag.slot = els.length >= 2 ? Math.abs(dotDrag.centers[1] - dotDrag.centers[0]) : 25;
      dotDrag.to = dotDrag.from;
      els.forEach((d) => { d.style.transition = 'transform 0.14s ease'; });
      dot.classList.add('dragging');
      dot.style.transition = 'none'; // sürüklenen anında takip etsin (kardeşler yumuşak)
    }
    const delta = vert ? (e.clientY - dotDrag.sy) : (e.clientX - dotDrag.sx);
    const n = dotDrag.centers.length;
    let to = Math.round((dotDrag.centers[dotDrag.from] + delta - dotDrag.centers[0]) / dotDrag.slot);
    to = Math.max(0, Math.min(n - 1, to));
    dotDrag.to = to;
    // sürüklenen: parmağı takip et
    dot.style.transform = `${vert ? `translateY(${delta}px)` : `translateX(${delta}px)`} scale(1.3)`;
    // kardeşler: hedefe göre bir slot kayarak boşluk aç
    const from = dotDrag.from;
    dotDrag.els.forEach((d, i) => {
      if (i === from) return;
      let ni = i;
      if (from < to && i > from && i <= to) ni = i - 1;
      else if (from > to && i >= to && i < from) ni = i + 1;
      const off = (ni - i) * dotDrag.slot;
      d.style.transform = off ? (vert ? `translateY(${off}px)` : `translateX(${off}px)`) : '';
    });
  });
  const endDotDrag = (e) => {
    if (!dotDrag || e.pointerId !== dotDrag.id) return;
    const d = dotDrag; dotDrag = null;
    try { dot.releasePointerCapture(e.pointerId); } catch {}
    if (d.els) d.els.forEach((el) => { el.style.transform = ''; el.style.transition = ''; });
    dot.classList.remove('dragging'); dot.style.transition = '';
    if (d.moved) {
      // yeni sırayı commit et: mevcut görünen sıradan (pids) sürükleneni çıkar, hedef slota koy
      const order = d.pids.filter((p) => p !== d.pid);
      order.splice(d.to, 0, d.pid);
      manualOrder = order;
      suppressClickUntil = Date.now() + 250;
      render();
    }
  };
  dot.addEventListener('pointerup', endDotDrag);
  dot.addEventListener('pointercancel', endDotDrag);

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
  if (act === 'focus') { if (menuTarget.hwnd) window.api.focus(menuTarget.pid); closeMenu(); maybeIgnore(); }
  if (act === 'rename') { closeMenu(); openRename(menuTarget); }
  if (act === 'switch') {
    // pencere paylaşılıyor mu? (VS Code/WT: aynı hwnd birden çok session'da → sekme,
    // pencereyi kapatamayız). main buna göre WM_CLOSE ya da kill seçer.
    const shared = !!menuTarget.hwnd && sessions.filter((s) => s.hwnd === menuTarget.hwnd).length > 1;
    window.api.switchToTerminal({
      pid: menuTarget.pid, hwnd: menuTarget.hwnd, host: menuTarget.host, sharedWindow: shared,
      sessionId: menuTarget.sessionId, cwd: menuTarget.cwd,
    });
    closeMenu(); maybeIgnore();
  }
  if (act === 'openfolder') { if (menuTarget.cwd) window.api.openFolder(menuTarget.cwd); closeMenu(); maybeIgnore(); }
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

// Pill'in BOŞ zemininden de taşı (küçük ✥ tutamağına ek — daha büyük isabet alanı).
// Yalnız hedef doğrudan #dots ise (nokta/kontrol/+/usage değil) sürükle; 3px eşikle
// yanlışlıkla mikro-hareketleri yut. Mevcut drag IPC akışını yeniden kullanır.
let pillDrag = null;
dotsEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target !== dotsEl) return; // yalnız boş pill zemini
  pillDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, started: false };
  try { dotsEl.setPointerCapture(e.pointerId); } catch {}
});
dotsEl.addEventListener('pointermove', (e) => {
  if (!pillDrag || e.pointerId !== pillDrag.id) return;
  if (!pillDrag.started) {
    if (Math.abs(e.clientX - pillDrag.sx) + Math.abs(e.clientY - pillDrag.sy) < 3) return;
    pillDrag.started = true;
    window.api.dragStart();
  }
  window.api.dragMove(); // main işaretçiyi (DPI-doğru) okuyup pencereyi taşır
});
function endPillDrag(e) {
  if (!pillDrag || e.pointerId !== pillDrag.id) return;
  const started = pillDrag.started;
  try { dotsEl.releasePointerCapture(e.pointerId); } catch {}
  pillDrag = null;
  if (started) window.api.dragEnd();
}
dotsEl.addEventListener('pointerup', endPillDrag);
dotsEl.addEventListener('pointercancel', endPillDrag);

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
  // Auto-update açıksa panel açılınca taze kontrol et → son sürümdeysek buton
  // kendiliğinden pasif "Update now" olur (elle "Check" gerekmez). Kapalıyken ağa
  // çıkma (ilke #1). Süren indirme/mevcut güncellemeyi bozmamak için o durumlarda atla.
  const ust = lastUpdate && lastUpdate.status;
  if (updatesSupported && s && s.autoUpdate && ust !== 'downloading' && ust !== 'available' && ust !== 'ready') {
    window.api.checkForUpdates();
  }
  renderHealth();
  markOrient((s && s.orientation) || orientation);
  if (s && Number.isFinite(s.scale)) { curScale = s.scale; updateScaleLabel(); }
  settingsEl.classList.remove('hidden');
  if (orientation === 'vertical') { settingsEl.style.left = '60px'; settingsEl.style.top = '8px'; }
  else { settingsEl.style.left = '8px'; settingsEl.style.top = '40px'; }
}
function closeSettings() {
  settingsEl.classList.add('hidden');
  // 'none'/'error' geçici durumlar: panel kapanınca idle'a dön ki yeniden açınca
  // pasif "Update now" değil tekrar "Check for updates" görünsün. (available/ready kalır.)
  if (lastUpdate && (lastUpdate.status === 'none' || lastUpdate.status === 'error')) {
    lastUpdate = { ...lastUpdate, status: 'idle' };
  }
}

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
    case 'none': // kontrol edildi, güncelleme yok → "Update now" pasif
      updateBtn.textContent = 'Update now'; updateBtn.disabled = true;
      updateStatusEl.textContent = "You're up to date.";
      updateStatusEl.classList.add('ok'); break;
    case 'error':
      updateBtn.textContent = 'Retry';
      updateStatusEl.textContent = `Update failed: ${u.error || 'unknown'}`;
      updateStatusEl.classList.add('err'); break;
    default: // idle: henüz kontrol edilmedi → check eylemi
      updateBtn.textContent = 'Check for updates';
      updateStatusEl.textContent = '';
  }
}
window.api.onUpdate((u) => {
  lastUpdate = u;
  if (u && typeof u.supported === 'boolean') updatesSupported = u.supported;
  if (!settingsEl.classList.contains('hidden')) renderUpdatePanel();
});
setAutoUpdate.addEventListener('change', () => window.api.setAutoUpdate(setAutoUpdate.checked));
updateBtn.addEventListener('click', () => {
  if (!updatesSupported) return;
  const st = lastUpdate && lastUpdate.status;
  if (st === 'available' || st === 'ready') window.api.installUpdate();
  else window.api.checkForUpdates(); // idle / none / error → yeniden kontrol
});
document.getElementById('set-center').addEventListener('click', () => window.api.resetPosition());
orientSeg.addEventListener('click', (e) => {
  const o = e.target.dataset.o;
  if (o) window.api.setOrientation(o);
});

// ---- ölçek (scale/zoom) ----
function updateScaleLabel() {
  if (scaleLabel) scaleLabel.textContent = Math.round(curScale * 100) + '%';
}
// −/+ stepper: her tık 0.1 adım, hemen uygular. (Tık-tabanlı → canlı-drag'in thumb'ı
// kaçırma bug'ı yok.) main kaydeder + pencereyi yeniden boyutlar + 'scale' echo eder.
function stepScale(dir) {
  const next = Math.min(2, Math.max(0.7, Math.round((curScale + dir * 0.1) * 10) / 10));
  if (next !== curScale) { curScale = next; updateScaleLabel(); window.api.setScale(next); }
}
if (scaleDn) scaleDn.addEventListener('click', () => stepScale(-1));
if (scaleUp) scaleUp.addEventListener('click', () => stepScale(1));
window.api.onScale((sc) => { curScale = sc; updateScaleLabel(); }); // main→zoom uygulandı, etiketi senkronla

// Ctrl+tekerlek ile canlı zoom (pill'in üstündeyken; yakalama açık olur). 0.7–2.0, 0.1 adım.
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const next = Math.min(2, Math.max(0.7, Math.round((curScale + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10));
  if (next !== curScale) { curScale = next; window.api.setScale(next); }
}, { passive: false });

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
  maybeIgnore(); // popup boş alana tıklanıp kapanınca capture'ı bırak (yoksa masaüstü tıkları bloke olurdu)
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
// Sürükleme sırasında yeniden render etme (transform'ları bozmasın); bırakınca güncel veriyle render olur.
window.api.onSessions((s) => { sessions = s; if (dotDrag && dotDrag.moved) return; render(); });

