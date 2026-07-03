'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const readline = require('readline');
const { EventEmitter } = require('events');

// Prefer PowerShell 7 (pwsh) — it is 64-bit and matches claude.exe for PEB reads.
function resolvePwsh() {
  return process.env.CSC_PWSH || 'pwsh.exe';
}

// Turn a session's opening message into a short (~22 char) dot label.
function shortLabel(text) {
  const MAX = 22;
  let t = text.trim();
  if (t.length <= MAX) return capitalize(t);
  // cut at the last word boundary before MAX, else hard cut
  let cut = t.slice(0, MAX);
  const sp = cut.lastIndexOf(' ');
  if (sp >= 12) cut = cut.slice(0, sp);
  return capitalize(cut.trim()) + '…';
}
function capitalize(s) { return s ? s.charAt(0).toLocaleUpperCase('tr') + s.slice(1) : s; }

// Bekleyen (sonuçlanmamış) bir assistant turn'ünün son tool_use ADINI döndür.
// Yalnızca ad okunur — argüman/içerik (soru metni, plan, komut) OKUNMAZ (ilke #3):
// "sana soruyor" (AskUserQuestion/ExitPlanMode) ile "izin bekliyor"u ayırmaya yeter.
function lastToolName(msg) {
  const c = msg && msg.content;
  if (!Array.isArray(c)) return null;
  // Bir soru aracı varsa onu tercih et (bloke edici tool turn'ün sonunda olmayabilir).
  let last = null;
  for (const b of c) {
    if (b && b.type === 'tool_use') { last = b.name || null; if (QUESTION_TOOLS.has(b.name)) return b.name; }
  }
  return last;
}
// Kullanıcıyı bloke eden "soru" araçları. (EnterPlanMode plana GİRİŞ — onay istemez;
// yalnızca ExitPlanMode planı onaya sunar.)
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Bir transcript girdisini konuşma rolüne indir. Claude Code formatı evrildi:
// eski `type:"user"|"assistant"` + yeni `type:"message"` (rol `message.role`'da).
// Üst-seviye type ya da message.role'dan rolü çöz (ileriye dönük dayanıklılık).
function convRole(o) {
  if (o.type === 'user' || o.type === 'assistant') return o.type;
  if (o.type === 'message' && o.message && (o.message.role === 'user' || o.message.role === 'assistant')) return o.message.role;
  return null;
}

// Context-window limit for the % ring. 1M-capable models (opus/sonnet 4+, [1m]
// variants) → 1M, else 200k; if observed context exceeds the guess, bump (a
// session can't hold more tokens than its window). Fixes wrong % for 1M sessions.
function ctxLimit(model, ctx) {
  const m = (model || '').toLowerCase();
  let limit = /(opus|sonnet)-[4-9]|opus-5|sonnet-5|-1m|\[1m\]/.test(m) ? 1000000 : 200000;
  if (ctx > limit) limit = ctx > 1000000 ? 2000000 : 1000000;
  return limit;
}

class Engine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.pollMs = opts.pollMs || 1200;
    // Busy detection (CPU only — IO proved too noisy: idle sessions emit large
    // one-off IO spikes, and the TUI blinks the cursor causing tiny bursts).
    // Measured: idle sessions stay <=16ms CPU/interval (scheduler noise); working
    // sessions (spinner/streaming) sustain 30-266ms. So:
    //   active tick  = dCpu > cpuMsThreshold
    //   strong tick  = dCpu > strongCpu       (unambiguous work → green immediately)
    //   busy         = strong(now) OR (active ticks in last `windowSize` >= busyTicks)
    // A rolling window kills flicker in both directions: one idle 16ms blip never
    // turns green, and one work dip never turns red.
    this.cpuMsThreshold = opts.cpuMsThreshold != null ? opts.cpuMsThreshold : 35;
    this.strongCpu = opts.strongCpu != null ? opts.strongCpu : 90;
    this.windowSize = opts.windowSize != null ? opts.windowSize : 4;
    this.busyTicks = opts.busyTicks != null ? opts.busyTicks : 2;
    // helper.ps1 is spawned by an external pwsh, which cannot read from inside
    // app.asar — electron-builder `asarUnpack` places it in app.asar.unpacked, so
    // resolve the on-disk path. In dev (__dirname has no app.asar) this is a no-op.
    this.helperPath = path.join(__dirname, 'helper.ps1')
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    this.proc = null;
    this.ready = false;
    this._prev = new Map();       // pid -> { cpuMs, io, ts, hist:[dCpu,...] }
    this._timer = null;
    this._focusWaiters = [];
    // Reliability: watchdog (restart helper if it dies) + snap timeout (recover if
    // a SNAP reply is lost so polling never freezes permanently).
    this._stopped = false;
    this._awaiting = false;
    this._snapTimeout = null;
    this._restarts = 0;
    this.maxRestarts = opts.maxRestarts != null ? opts.maxRestarts : 20;

    // --- topic auto-naming via activity correlation ---
    // PID<->sessionId can't be read directly, so we correlate: when exactly one
    // session in a cwd is CPU-active AND exactly one transcript (.jsonl) in that
    // cwd's project dir just changed, that's a vote pairing them. Votes accumulate
    // and the winner (>= minVotes) resolves the pid -> sessionId -> topic label.
    this.projectsRoot = opts.projectsRoot || path.join(os.homedir(), '.claude', 'projects');
    // Claude Code (v2.1.198+) writes ~/.claude/sessions/<pid>.json with the exact
    // sessionId + live status + kind + name. When present it's authoritative and
    // makes the correlation/elimination heuristics a fallback for older versions.
    this.sessionsDir = opts.sessionsDir || path.join(os.homedir(), '.claude', 'sessions');
    // Written by our statusLine capture (see ~/.claude/statusline.sh): exact context
    // window %/size + account-wide 5h/7d rate-limit usage + cost, per sessionId.
    this.statusDir = opts.statusDir || path.join(os.homedir(), '.claude', 'glance-status');
    this.minVotes = opts.minVotes != null ? opts.minVotes : 3;
    this._mtimes = new Map();     // jsonl abs path -> mtimeMs (previous tick)
    this._votes = new Map();      // pid -> Map(sessionId -> count)
    this._pidSid = new Map();     // pid -> resolved sessionId
    this._sidTopic = new Map();   // sessionId -> short label (cached)
    this._mtimeInit = false;
  }

  start() {
    this._stopped = false;
    this._awaiting = false;
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath];
    this.proc = spawn(resolvePwsh(), args, { windowsHide: true });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    this.proc.stderr.on('data', (d) => this.emit('log', 'stderr: ' + d.toString()));
    this.proc.on('exit', (code) => { this.emit('log', 'helper exited: ' + code); this._onDown(); });
    this.proc.on('error', (err) => {
      // e.g. pwsh not found — surface it, then let the watchdog retry/backoff.
      this.emit('error', err);
      this.emit('status', { ok: false, msg: 'pwsh failed to start' });
      this._onDown();
    });
  }

  // Helper went down: reject pending focus calls, then restart with backoff
  // (unless we stopped it on purpose or crash-looped past the cap).
  _onDown() {
    this.ready = false;
    this._awaiting = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._snapTimeout) { clearTimeout(this._snapTimeout); this._snapTimeout = null; }
    this._focusWaiters.splice(0).forEach((w) => w(false));
    if (this._stopped) return;
    this._restarts++;
    if (this._restarts > this.maxRestarts) {
      this.emit('status', { ok: false, msg: 'helper keeps crashing — stopped' });
      return;
    }
    const delay = Math.min(10000, 500 * this._restarts);
    this.emit('log', `restarting helper in ${delay}ms (#${this._restarts})`);
    setTimeout(() => { if (!this._stopped) this.start(); }, delay);
  }

  _onLine(line) {
    if (line === 'READY') {
      this.ready = true;
      this.emit('log', 'helper ready');
      this._tick();
      return;
    }
    if (line.startsWith('SNAP:')) {
      this._awaiting = false;
      if (this._snapTimeout) { clearTimeout(this._snapTimeout); this._snapTimeout = null; }
      this._handleSnapshot(line.slice(5));
      this._scheduleNext();
      return;
    }
    if (line.startsWith('FOCUS:')) {
      const ok = line.slice(6) === 'ok';
      const w = this._focusWaiters.shift();
      if (w) w(ok);
      return;
    }
    if (line.startsWith('ERR:')) {
      this.emit('log', line);
    }
  }

  _scheduleNext() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick(), this.pollMs);
  }

  _tick() {
    if (!this.ready || !this.proc || this._awaiting) return;
    this._awaiting = true;
    try {
      this.proc.stdin.write('SNAP\n');
    } catch (e) {
      this._awaiting = false;
      this.emit('error', e);
      return;
    }
    // If no reply arrives (helper hung/lost line), recover instead of freezing.
    if (this._snapTimeout) clearTimeout(this._snapTimeout);
    this._snapTimeout = setTimeout(() => {
      this.emit('log', 'snap timeout — recovering');
      this._awaiting = false;
      this._scheduleNext();
    }, this.pollMs * 4);
  }

  _handleSnapshot(json) {
    let data;
    try { data = JSON.parse(json); } catch (e) { this.emit('log', 'bad json: ' + e.message); return; }
    if (this._restarts) { this._restarts = 0; this.emit('status', { ok: true }); } // healthy again
    let sessions = data.sessions || [];
    if (!Array.isArray(sessions)) sessions = [sessions]; // ConvertTo-Json collapses single element
    const now = Date.now();
    const seen = new Set();

    const activeByPid = new Map(); // pid -> true if this tick's dCpu was active
    let out = sessions.map((s) => {
      seen.add(s.pid);
      const prev = this._prev.get(s.pid);
      let status = 'new';
      let cpuPct = 0;
      let hist = prev ? prev.hist.slice() : [];
      if (prev) {
        const dt = Math.max(1, now - prev.ts);
        const dCpu = Math.max(0, s.cpuMs - prev.cpuMs);
        cpuPct = (dCpu / dt) * 100;
        hist.push(dCpu);
        if (hist.length > this.windowSize) hist = hist.slice(-this.windowSize);
        const active = hist.filter((d) => d > this.cpuMsThreshold).length;
        const strongNow = dCpu > this.strongCpu;
        status = (strongNow || active >= this.busyTicks) ? 'busy' : 'waiting';
        if (dCpu > this.cpuMsThreshold) activeByPid.set(s.pid, true);
      }
      this._prev.set(s.pid, { cpuMs: s.cpuMs, io: s.io, ts: now, hist });
      return {
        pid: s.pid,
        ppid: s.ppid,
        cwd: (s.cwd || '').replace(/\\+$/, ''),
        cmd: s.cmd || '',
        created: s.created || 0,
        hwnd: s.hwnd || 0,
        host: s.host || '',
        status,
        cpuPct: Math.round(cpuPct * 10) / 10,
      };
    });

    // Authoritative pass: Claude's own per-pid session file (exact sessionId + live
    // status). Overrides the CPU/transcript heuristics when present.
    let metaSeen = false;
    for (const s of out) {
      const meta = this._readSessionMeta(s.pid);
      if (!meta) continue;
      metaSeen = true;
      if (meta.sessionId) s.sessionId = meta.sessionId;
      if (meta.name) s.claudeName = meta.name;
      s.kind = meta.kind; // "interactive" | "bg" — bg'nin terminal penceresi yok (aşağıda süzülür)
      if (meta.status === 'compacting') { s.status = 'compacting'; s.stateSrc = 'claude'; }
      else if (meta.status === 'waiting') {
        // v2.1.199+: Claude "seni bekliyor" diyor; türü waitingFor'dan. Varsayılanı
        // 'question' YAPMA (boş waitingFor gelen her biten session'ı yanlışça mor
        // "seni bekliyor" yapardı). Soru-türü → question, başka bilinen blok → izin,
        // boş/bilinmeyen → transcript rafine etsin (aşağıda).
        const wf = (meta.waitingFor || '').toLowerCase();
        if (/quest|plan|answer|choose|select|\binput\b|response|elicit/.test(wf)) { s.status = 'question'; s.stateSrc = 'claude'; }
        else if (wf) { s.status = 'permission'; s.stateSrc = 'claude'; } // "permission prompt" vb.
        else { s.status = 'waiting'; s.stateSrc = 'claude'; } // boş waitingFor → aşağıda transcript rafine eder (jsonIdle)
      }
      else if (meta.status === 'busy') {
        // Aktif turn. ANCAK eski sürümler (v2.1.198) soru sorarken de 'busy' yazar;
        // transcript kesin bir soru aracı (AskUserQuestion/plan) gösteriyorsa düzelt.
        s.status = 'busy'; s.stateSrc = 'claude'; s._maybeQuestion = true;
      }
      else if (meta.status === 'idle') { s.status = 'waiting'; s.stateSrc = 'claude'; }
    }
    this._metaSeen = metaSeen; // for the health indicator

    // Arka plan job'larını (kind:"bg", Claude Code v2.1.199+) GİZLE: bir terminal
    // penceresi yok → tıklanıp odaklanamaz/switch edilemez ve job sistemi öldürülünce
    // yeniden başlatır ("hayalet session"). Glance yalnızca etkileşimli oturumları izler.
    out = out.filter((s) => s.kind !== 'bg');

    // Prune dead pids (and their correlation state).
    for (const pid of [...this._prev.keys()]) if (!seen.has(pid)) this._prev.delete(pid);
    for (const pid of [...this._votes.keys()]) if (!seen.has(pid)) this._votes.delete(pid);
    for (const pid of [...this._pidSid.keys()]) if (!seen.has(pid)) this._pidSid.delete(pid);

    this._correlateTopics(out, activeByPid);

    out.sort((a, b) => a.created - b.created);
    this.emit('sessions', out);
  }

  // Correlate CPU-active PIDs with just-modified transcripts, per cwd, to resolve
  // each session's topic label. Attaches `topic` to out items when known.
  _correlateTopics(out, activeByPid) {
    // Group live sessions by cwd.
    const byCwd = new Map();
    for (const s of out) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
      byCwd.get(s.cwd).push(s);
    }

    // If every session already has an exact sessionId (from Claude's session file),
    // the CPU/transcript correlation voting is unnecessary this tick — skip it.
    const needCorrelation = out.some((s) => !s.sessionId);
    const dirByCwd = new Map();    // computed once per cwd, reused when attaching topics
    const recentByCwd = new Map(); // cwd -> sids sorted by mtime (most recent first)
    for (const [cwd, group] of byCwd) {
      const dir = this._projectDir(cwd);
      dirByCwd.set(cwd, dir);
      if (!dir) continue;
      let files;
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }

      // Which transcripts changed since last tick? Also collect sids sorted by mtime.
      const changed = [];
      const withM = [];
      for (const f of files) {
        const abs = path.join(dir, f);
        let m = 0;
        try { m = fs.statSync(abs).mtimeMs; } catch { continue; }
        const prevM = this._mtimes.get(abs);
        if (prevM != null && m > prevM) changed.push(f.replace(/\.jsonl$/, ''));
        this._mtimes.set(abs, m);
        withM.push({ sid: f.replace(/\.jsonl$/, ''), m });
      }
      withM.sort((a, b) => b.m - a.m);
      recentByCwd.set(cwd, withM.map((x) => x.sid)); // most-recent first

      // Vote only on unambiguous ticks: exactly one active session AND one changed
      // transcript in this cwd. (First run just seeds mtimes — no votes.)
      if (this._mtimeInit && needCorrelation) {
        const activePids = group.filter((s) => activeByPid.get(s.pid)).map((s) => s.pid);
        if (activePids.length === 1 && changed.length === 1) {
          const pid = activePids[0];
          const sid = changed[0];
          if (!this._votes.has(pid)) this._votes.set(pid, new Map());
          const vm = this._votes.get(pid);
          vm.set(sid, (vm.get(sid) || 0) + 1);
          // Resolve when a clear leader crosses the threshold.
          if (!this._pidSid.has(pid)) {
            let bestSid = null, best = 0, second = 0;
            for (const [k, v] of vm) { if (v > best) { second = best; best = v; bestSid = k; } else if (v > second) second = v; }
            if (best >= this.minVotes && best > second) this._pidSid.set(pid, bestSid);
          }
        }
      }
    }
    this._mtimeInit = true;

    // Build effective pid→sessionId: voted mapping is authoritative; then fill the
    // single remaining unclaimed pid in each cwd by elimination (the most-recent
    // still-unclaimed .jsonl). Covers single-session cwds and "one idle sibling
    // left" cases. Recomputed each tick (not stored) so votes correct any guess.
    const eff = new Map();
    for (const s of out) {
      const sid = s.sessionId || this._pidSid.get(s.pid); // Claude's session file is exact
      if (sid) eff.set(s.pid, sid);
    }
    for (const [cwd, group] of byCwd) {
      const unclaimed = group.filter((s) => !eff.has(s.pid));
      if (unclaimed.length !== 1) continue;
      const claimed = new Set(group.map((s) => eff.get(s.pid)).filter(Boolean));
      const cand = (recentByCwd.get(cwd) || []).find((sid) => !claimed.has(sid));
      if (cand) eff.set(unclaimed[0].pid, cand);
    }

    // Attach topic + workload. ctx/state source priority: statusLine capture (exact
    // context % + account rate-limits) > transcript tail (fallback) > CPU (last resort).
    let freshUsage = null;
    let statusSeen = false;
    for (const s of out) {
      const sid = eff.get(s.pid);
      if (!sid) continue;
      const dir = dirByCwd.get(s.cwd);
      s.topic = this._topicFor(dir, sid); // cached per sid
      // Exact numbers from the statusLine capture first (context %, cost, rate-limits).
      let haveCtx = false;
      const cap = this._readStatus(sid);
      if (cap) {
        statusSeen = true;
        const cw = cap.context_window;
        if (cw && cw.used_percentage != null) {
          s.ctxPct = cw.used_percentage / 100;
          s.ctx = (cw.total_input_tokens || 0) + (cw.total_output_tokens || 0);
          haveCtx = true;
        }
        if (cap.cost && cap.cost.total_cost_usd != null) s.cost = cap.cost.total_cost_usd;
        if (cap.rate_limits && (!freshUsage || (cap.ts || 0) > freshUsage.ts)) {
          freshUsage = { ts: cap.ts || 0, rate_limits: cap.rate_limits };
        }
      }
      // Transcript fallback ONLY for what the authoritative sources didn't cover
      // (skips a per-tick 64KB read when Claude status + statusLine already gave us it).
      // Claude 'idle' dediğinde transcript ile RAFİNE ederiz (boşta mı, soru/izin mi);
      // 'busy' dediğinde de eski sürüm bir soruyu maskeliyor olabilir → sorarsa düzelt.
      const needState = s.stateSrc !== 'claude';
      const jsonIdle = s.stateSrc === 'claude' && s.status === 'waiting';
      if (needState || jsonIdle || s._maybeQuestion || !haveCtx) {
        const st = this._sessionState(dir, sid, s.status === 'busy');
        if (st) {
          if (needState && st.state) { s.status = st.state; s.stateSrc = 'transcript'; }
          // json 'idle' otoriter → yalnızca idle-ailesi (question/permission/waiting), busy'e döndürme
          else if (jsonIdle && st.state && st.state !== 'busy') { s.status = st.state; s.stateSrc = 'claude+transcript'; }
          // json 'busy' ama transcript kesin bir soru aracı gösteriyor (eski sürüm maskeleme) → düzelt
          else if (s._maybeQuestion && st.state === 'question') { s.status = 'question'; s.stateSrc = 'claude+transcript'; }
          if (!haveCtx && st.ctxTokens != null) {
            s.ctx = st.ctxTokens;
            s.ctxPct = Math.min(1, st.ctxTokens / ctxLimit(st.model, st.ctxTokens));
          }
        }
      }
    }
    // Account-wide usage (5h/7d rate-limit window) — same across sessions; emit freshest.
    this.emit('usage', freshUsage ? freshUsage.rate_limits : null);
    // Health: which authoritative data sources are actually connected.
    this.emit('health', { sessions: !!this._metaSeen, statusline: statusSeen });
  }

  // Determine a session's real state + context size from the tail of its transcript.
  // Far more accurate than CPU: "waiting for you" = completed assistant turn while
  // idle; "working" = user/tool-result last, or actively writing, or thinking.
  _sessionState(dir, sid, cpuBusy) {
    if (!dir) return null;
    try {
      const abs = path.join(dir, sid + '.jsonl');
      const st = fs.statSync(abs);
      const CHUNK = 65536;
      const start = Math.max(0, st.size - CHUNK);
      const len = st.size - start;
      if (len <= 0) return null;
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); } // drop partial line
      const lines = text.split('\n');
      let lastReal = null, lastRole = null, ctxTokens = null, model = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i]; if (!ln.trim()) continue;
        let o; try { o = JSON.parse(ln); } catch { continue; }
        const role = convRole(o); // 'user' | 'assistant' | null (yeni type:"message"'ı da tanır)
        if (ctxTokens == null && role === 'assistant') {
          const u = o.message && o.message.usage;
          if (u) {
            ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            model = o.message.model || null;
          }
        }
        if (!lastReal && role) { lastReal = o; lastRole = role; }
        if (lastReal && ctxTokens != null) break;
      }
      if (!lastReal) return { state: null, ctxTokens, model };
      // NOT: mtime'a GÜVENME — yeni meta girdileri (ai-title/mode/permission-mode) mtime'ı
      // bumpluyor; "fresh → busy" kısa-devresi soru/izni 2.5s bastırıyordu. Onun yerine
      // stop_reason: yoksa akış sürüyor (busy), tool_use → bloke, bittiyse boşta.
      const msg = lastReal.message || {};
      const sr = msg.stop_reason;
      let state;
      if (lastRole === 'user') {
        state = 'busy';                          // prompt/tool-result → düşünüyor
      } else if (!sr) {
        state = 'busy';                          // assistant akış hâlinde (henüz tamamlanmadı)
      } else if (sr === 'tool_use') {
        // Assistant turn bir tool çağrısıyla bitti, sonuçlanmadı → seni bloke etti.
        const tn = lastToolName(msg);
        if (QUESTION_TOOLS.has(tn)) state = 'question';   // AskUserQuestion / plan onayı
        else state = cpuBusy ? 'busy' : 'permission';     // tool koşuyor mu, izin mi bekliyor
      } else {
        state = 'waiting';                       // end_turn/stop_sequence/max_tokens → bitti, boşta
      }
      return { state, ctxTokens, model };
    } catch { return null; }
  }

  // Read Claude's own per-pid session file (exact sessionId + live status + name).
  _readSessionMeta(pid) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, pid + '.json'), 'utf8'));
      // waitingFor: Claude Code v2.1.199+ 'waiting' durumunda NEDEN durduğunu söyler
      // ("permission prompt" vb). Bloke türünü (izin vs soru) transcript'ten daha kesin verir.
      return { sessionId: o.sessionId, status: o.status, kind: o.kind, name: o.name, waitingFor: o.waitingFor };
    } catch { return null; }
  }

  // Read our statusLine capture (exact context window + account rate-limits + cost).
  _readStatus(sid) {
    try { return JSON.parse(fs.readFileSync(path.join(this.statusDir, sid + '.json'), 'utf8')); }
    catch { return null; }
  }

  _projectDir(cwd) {
    if (!cwd) return null;
    // Claude encodes the cwd path into the project dir name by replacing / \ :
    const enc = cwd.replace(/[\\/:]/g, '-');
    const dir = path.join(this.projectsRoot, enc);
    return fs.existsSync(dir) ? dir : null;
  }

  _topicFor(dir, sid) {
    if (this._sidTopic.has(sid)) return this._sidTopic.get(sid);
    if (!dir) return '';
    let label = '';
    let ok = false;
    try {
      const abs = path.join(dir, sid + '.jsonl');
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(131072); // first 128KB holds the opening user message
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      ok = true;
      const lines = buf.toString('utf8', 0, n).split('\n');
      for (const ln of lines) {
        if (!ln.trim()) continue;
        let o; try { o = JSON.parse(ln); } catch { continue; }
        if (convRole(o) !== 'user' || o.isMeta) continue; // yeni type:"message"'ı da al, meta'yı atla
        const c = o.message && o.message.content;
        // ilk METİN bloğunu al (ilk blok image/tool_result olabilir)
        let text = typeof c === 'string' ? c
          : (Array.isArray(c) ? ((c.find((b) => b && b.type === 'text') || {}).text || '') : '');
        text = String(text).replace(/\s+/g, ' ').trim();
        // slash-komut yankısı / caveat gibi sentetik açılışları atla, gerçek prompt'a devam et
        if (!text || /^<command-|^<local-command|^Caveat:/i.test(text)) continue;
        label = shortLabel(text); break;
      }
    } catch { /* transient (locked/mid-write) — don't cache, retry next tick */ }
    if (ok) this._sidTopic.set(sid, label); // cache only successful reads (blank is fine — falls back)
    return label;
  }

  focus(hwnd) {
    return new Promise((resolve) => {
      if (!this.ready || !hwnd) return resolve(false);
      let done = false;
      const waiter = (ok) => { if (done) return; done = true; resolve(ok); };
      const finish = (ok) => {
        const i = this._focusWaiters.indexOf(waiter);
        if (i >= 0) this._focusWaiters.splice(i, 1); // keep FIFO aligned with replies
        waiter(ok);
      };
      this._focusWaiters.push(waiter);
      try { this.proc.stdin.write('FOCUS:' + hwnd + '\n'); } catch { finish(false); }
      setTimeout(() => finish(false), 3000);
    });
  }

  // Bir terminal penceresini nazikçe kapat (WM_CLOSE). Fire-and-forget; yanıtı
  // ('CLOSE:ok') önemsemeyiz. "Switch to terminal"da barındıran pencereyi temiz
  // kapatmak için (taskkill /F yerine → terminal bozulmaz, spam olmaz).
  closeWindow(hwnd) {
    if (!this.ready || !this.proc || !hwnd) return false;
    try { this.proc.stdin.write('CLOSE:' + hwnd + '\n'); return true; } catch { return false; }
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._snapTimeout) clearTimeout(this._snapTimeout);
    try { this.proc && this.proc.stdin.write('EXIT\n'); } catch {}
    try { this.proc && this.proc.kill(); } catch {}
  }
}

module.exports = { Engine };
