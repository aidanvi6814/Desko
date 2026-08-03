// Desko frontend core — v0 design port (system bar + scene frame + scene rail + launcher).
// Plain script (no modules) for old Chromium on the realme 3.
window.Desko = (function () {
  var SCENES = ["idle", "music", "stats", "dev", "focus"];
  var state = { scene: "idle", override: null, locked: false, info: null, media: null, lyrics: null, sys: null, weather: null, dev: null, procs: null, game: null, focus: null, volume: null };
  var info = { hostname: "—", ip: "—" }; // from /api/info
  var scenes = {};
  var launcher = null;            // launcher module (optional)
  var active = null;              // current scene name
  var urlOverride = null;         // ?scene=...
  var launcherOpen = false;       // UI flag
  var launcherOpenedAt = 0;       // ms; guards the home screen against the same
                                  // double-tap's synthesized click closing it
  var ws = null;
  var backoff = 1000;
  var reconnectTimer = null;
  var pingTimer = null;
  var pingSent = 0;
  var lastPongAt = 0;      // ms; 0 = nothing heard back yet on this socket
  var lastTickAt = 0;      // ms; used to detect a suspended/throttled page
  var lastLinkMs = null;
  var lastUptimeTick = 0;
  var clockOffsetMs = 0;   // estimated (serverNow - clientNow), refreshed each pong

  // --- DOM helpers ----------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // --- WS send / scene routing ---------------------------------------------
  function send(msg) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch (e) {} } }

  function applyScene(name, reason, overrideVal) {
    if (typeof name !== "string") return;
    state.scene = name;
    if (typeof overrideVal !== "undefined") state.override = overrideVal;
    var target = urlOverride || name;
    if (target === active) {
      // Scene unchanged, but the lock state may have just flipped — keep
      // that indicator in sync even when the visible scene doesn't change.
      syncLockIndicator();
      if (scenes[active] && scenes[active].onStateChange) try { scenes[active].onStateChange(state); } catch (e) { console.error(e); }
      return;
    }
    if (active && scenes[active] && scenes[active].onExit) { try { scenes[active].onExit(); } catch (e) {} }
    qsa(".scene").forEach(function (n) { n.classList.remove("active"); });
    var node = qs('[data-scene="' + target + '"]');
    if (node) node.classList.add("active");
    active = target;
    syncLockIndicator();
    if (scenes[target] && scenes[target].onEnter) {
      try { scenes[target].onEnter(state); } catch (e) { console.error(e); }
    }
  }

  // Lock indicator lives in the top system bar (id="lock-btn") so it's always
  // visible — icon-only (open/closed padlock), no text. See desko/context.py
  // for what locking actually does server-side.
  function syncLockIndicator() {
    var btn = el("lock-btn");
    if (btn) btn.classList.toggle("locked", !!state.locked);
  }

  function mergeUpdate(section, data) {
    if (data === null) {
      state[section] = null;
    } else if (typeof data === "object" && state[section] && typeof state[section] === "object") {
      state[section] = Object.assign({}, state[section], data);
    } else {
      state[section] = data;
    }
    if (section === "info") {
      info.hostname = state.info.hostname || "—";
      info.ip = state.info.ip || "—";
      noteServerStart(state.info.startedAt);
      renderSysBar();
    }
    if (section === "locked") { syncLockIndicator(); }
    if (section === "media" || section === "lyrics") {
      if (scenes.music && scenes.music.onStateChange) try { scenes.music.onStateChange(state); } catch (e) {}
    } else if (section === "volume") {
      // Volume changes shouldn't re-run the track/marquee logic in
      // onStateChange, so route them to the music scene's dedicated handler.
      if (scenes.music && scenes.music.onVolume) try { scenes.music.onVolume(state); } catch (e) {}
    } else if (section === "sys" || section === "game" || section === "procs") {
      if (scenes.stats && scenes.stats.onStateChange) try { scenes.stats.onStateChange(state); } catch (e) {}
    } else if (section === "weather") {
      if (scenes.idle && scenes.idle.onStateChange) try { scenes.idle.onStateChange(state); } catch (e) {}
    } else if (section === "dev") {
      if (scenes.dev && scenes.dev.onStateChange) try { scenes.dev.onStateChange(state); } catch (e) {}
    } else {
      if (active && scenes[active] && scenes[active].onStateChange) try { scenes[active].onStateChange(state); } catch (e) {}
    }
  }

  function handle(msg) {
    if (msg.type === "snapshot") {
      var d = msg.data || {};
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) state[k] = d[k];
      if (state.info) {
        info.hostname = state.info.hostname || "—";
        info.ip = state.info.ip || "—";
        noteServerStart(state.info.startedAt);
      }
      renderSysBar();
      syncLockIndicator();
      applyScene(state.scene, "auto", state.override);
      // ping all scenes once on snapshot so initial UI is correct
      Object.keys(scenes).forEach(function (n) {
        if (n === active && scenes[n].onStateChange) { try { scenes[n].onStateChange(state); } catch (e) {} }
      });
    } else if (msg.type === "update") {
      mergeUpdate(msg.section, msg.data);
    } else if (msg.type === "scene") {
      applyScene(msg.scene, msg.reason, msg.override);
    } else if (msg.type === "pong") {
      lastPongAt = Date.now();   // liveness proof; see startPing / checkLink
      if (typeof msg.t === "number") {
        var nowMs = Date.now();
        lastLinkMs = nowMs - msg.t;
        renderLink();
        // Estimate client/server clock offset from the round trip (assumes
        // symmetric latency): serverNow ~= msg.st + rtt/2. Used by music.js
        // to keep the lyrics/progress interpolation correct even when the
        // phone's system clock doesn't match the PC's.
        if (typeof msg.st === "number" && lastLinkMs >= 0) {
          var serverNowMs = msg.st * 1000 + lastLinkMs / 2;
          clockOffsetMs = serverNowMs - nowMs;
        }
      }
    }
  }

  // --- WebSocket ------------------------------------------------------------
  function connect() {
    // Never stack sockets: a manual reconnect (see dropSocket / checkLink) can
    // race the scheduled one, and two live sockets means two snapshots and
    // double the traffic on a phone that can least afford it.
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/ws";
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = function () {
      backoff = 1000;
      document.body.parentElement && document.body.parentElement.classList.remove("offline");
      var shell = qs(".dashboard-shell"); if (shell) shell.classList.remove("offline");
      var t = el("sb-link-text"); if (t) t.textContent = "LINKED";
      startPing();
    };
    ws.onmessage = function (ev) { try { handle(JSON.parse(ev.data)); } catch (e) {} };
    ws.onclose = function () { onDisconnect(); scheduleReconnect(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function onDisconnect() {
    document.body.parentElement && document.body.parentElement.classList.add("offline");
    var shell = qs(".dashboard-shell"); if (shell) shell.classList.add("offline");
    var t = el("sb-link-text"); if (t) t.textContent = "OFFLINE";
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, backoff);
    backoff = Math.min(backoff * 1.7, 5000);
  }

  // Tear down a socket we believe is wedged. Wi-Fi power-save on the phone can
  // drop the TCP connection with neither side seeing a FIN: readyState stays
  // OPEN, onclose never fires, nothing arrives — and because music.js keeps
  // interpolating the last known playhead, the dashboard looks alive while the
  // track and lyrics silently go stale. Detaching the handlers first means the
  // dead socket can't deliver a late message or a late onclose into the new
  // connection's lifecycle.
  function dropSocket() {
    if (ws) {
      try {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      } catch (e) {}
      ws = null;
    }
    onDisconnect();
    backoff = 1000;
    scheduleReconnect();
  }

  // --- Latency ping / link health ------------------------------------------
  // The ping was previously fire-and-forget: it measured RTT when a pong came
  // back but never noticed one that didn't, so a half-open socket read as
  // "LINKED" forever. Now an unanswered ping is the liveness signal.
  var PONG_TIMEOUT_MS = 15000;
  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    lastPongAt = Date.now();
    pingSent = Date.now();
    send({ type: "ping", t: pingSent });
    sendPerf();
    pingTimer = setInterval(function () {
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) { dropSocket(); return; }
      pingSent = Date.now();
      send({ type: "ping", t: pingSent });
    }, 5000);
  }

  // Called after the ticker notices it was suspended (see tick). Everything on
  // screen is stale by the length of the freeze, and the socket may or may not
  // have survived it, so make it prove itself now rather than waiting up to 5s
  // for the next scheduled ping.
  function checkLink() {
    if (!ws || ws.readyState > 1) { backoff = 1000; scheduleReconnect(); return; }
    if (ws.readyState !== 1) return;                      // still CONNECTING
    // A freeze longer than the pong window is indistinguishable from a dead
    // socket from here, and reconnecting is cheap (one handshake + a fresh
    // snapshot that resyncs every section), so prefer the certain path.
    if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) { dropSocket(); return; }
    pingSent = Date.now();
    send({ type: "ping", t: pingSent });
  }
  function renderLink() {
    var e = el("i-link"); if (!e) return;
    e.textContent = (lastLinkMs == null ? "—" : Math.max(1, Math.round(lastLinkMs))) + "ms";
  }

  // --- /api/info (hostname, ip, uptime) ------------------------------------
  // Server start time, as a SERVER epoch in seconds. The "PC UPTIME" readout
  // used to be measured from when this script loaded, which made it the phone
  // tab's lifetime -- it reset on every reload and had nothing to do with the
  // PC. Preferred source is state.info.startedAt (arrives with the ws
  // snapshot, exact); /api/info's uptime_sec is the fallback for the moment
  // before the socket is up. Rendering corrects for clock skew the same way
  // the media position does, so a phone with a wrong system clock still shows
  // the real number.
  var serverStartedAt = null;
  function noteServerStart(startedAt) {
    if (typeof startedAt === "number" && startedAt > 0) serverStartedAt = startedAt;
  }
  function serverUptimeSec() {
    if (serverStartedAt == null) return null;
    return Math.max(0, (Date.now() + clockOffsetMs) / 1000 - serverStartedAt);
  }
  function renderUptime() {
    var u = el("i-uptime"); if (!u) return;
    var up = serverUptimeSec();
    u.textContent = up == null ? "—" : fmtUptime(up);
  }
  function fetchInfo() {
    fetch("/api/info", { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        info.hostname = j.hostname || "—";
        info.ip = j.ip || "—";
        // uptime_sec is relative to *now*, so convert to an absolute start.
        if (serverStartedAt == null && typeof j.uptime_sec === "number") {
          noteServerStart(Date.now() / 1000 - j.uptime_sec);
        }
        renderSysBar();
      })
      .catch(function () {});
  }
  function fmtUptime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return pad(h) + ":" + pad(m) + ":" + pad(sec);
  }

  function renderSysBar() {
    var h = el("sb-hostname"); if (h) h.textContent = (info.hostname || "—").toUpperCase();
    var i = el("sb-ip"); if (i) i.textContent = info.ip || "—";
    var clk = el("sb-clock"); if (clk) clk.textContent = hhmmNow();
    renderUptime();
  }
  function hhmmNow() {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

  // --- Phone battery (Battery Status API) ----------------------------------
  // Real battery for the device the dashboard runs on (the phone), shown in the
  // system bar and on the idle scene's DEVICE row. The Battery Status API is
  // simply absent in a lot of mobile browsers (and over plain http on some),
  // so when it's unavailable we HIDE the chip entirely rather than leave a dead
  // "—" that looks broken. Where it's supported, it updates live.
  var battery = { level: null, charging: null, supported: false };
  function batteryUnavailable() {
    var wrap = el("sb-batt"); if (wrap) wrap.style.display = "none";
    var dev = el("i-device"); if (dev) dev.textContent = "—";
  }
  function renderBattery() {
    if (!battery.supported || battery.level == null) { batteryUnavailable(); return; }
    var wrap = el("sb-batt"); if (wrap) wrap.style.display = "";
    var lvl = Math.max(0, Math.min(1, battery.level));
    var low = lvl <= 0.2 && !battery.charging;
    var fill = el("sb-batt-fill"); if (fill) fill.setAttribute("width", (14 * lvl).toFixed(2));
    var pct = el("sb-batt-pct"); if (pct) pct.textContent = Math.round(lvl * 100) + "%";
    var bolt = el("sb-batt-bolt"); if (bolt) bolt.style.display = battery.charging ? "" : "none";
    if (wrap) wrap.classList.toggle("batt-low", low);
    var dev = el("i-device"); if (dev) dev.textContent = Math.round(lvl * 100) + "%" + (battery.charging ? " CHRG" : "");
  }
  function initBattery() {
    if (!navigator.getBattery) { batteryUnavailable(); return; }
    try {
      navigator.getBattery().then(function (b) {
        battery.supported = true;
        var sync = function () { battery.level = b.level; battery.charging = b.charging; renderBattery(); };
        b.addEventListener("levelchange", sync);
        b.addEventListener("chargingchange", sync);
        sync();
      }).catch(batteryUnavailable);
    } catch (e) { batteryUnavailable(); }
  }

  // --- Keep-awake (NoSleep shim) -------------------------------------------
  var noSleep = null;
  function enableNoSleep() {
    if (!noSleep) noSleep = new NoSleep();
    try { noSleep.enable(); } catch (e) {}
    document.removeEventListener("touchend", enableNoSleep);
    document.removeEventListener("click", enableNoSleep);
  }

  // --- Fullscreen toggle ----------------------------------------------------
  function toggleFullscreen() {
    var d = document, root = d.documentElement;
    var isFs = d.fullscreenElement || d.webkitFullscreenElement;
    if (isFs) { (d.exitFullscreen || d.webkitExitFullscreen || function () {}).call(d); }
    else {
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) { try { var p = req.call(root); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
    }
  }
  function syncFsState() {
    var fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.body.classList.toggle("is-fs", fs);
  }
  document.addEventListener("fullscreenchange", syncFsState);
  document.addEventListener("webkitfullscreenchange", syncFsState);

  // --- Perf mode ------------------------------------------------------------
  // Flat, no-GPU rendering of the theme (see the html.perf block in style.css).
  // The class is put on <html> before first paint by the inline script in
  // index.html; this only handles toggling afterwards.
  //
  // Stored per-device in localStorage rather than in config.json, because perf
  // mode describes the screen doing the rendering, not the PC: a desktop
  // browser opening the same dashboard shouldn't inherit the phone's setting.
  // The trade-off is that localStorage is per-origin, so desko.local and the
  // raw IP each keep their own flag -- ?perf=1 / ?perf=0 exists to force it.
  var PERF_KEY = "desko:perf";
  function perfOn() { return document.documentElement.classList.contains("perf"); }
  function setPerf(on) {
    document.documentElement.classList.toggle("perf", !!on);
    try { localStorage.setItem(PERF_KEY, on ? "1" : "0"); } catch (e) {}
    syncPerfIndicator();
    sendPerf();
  }
  // Perf mode is a per-device browser setting, but the server needs to know
  // about it: the process sweep costs ~1s of CPU and backs off to a slower
  // clock while the bolt is on, so "go easy on me" means fewer updates to
  // render as well as a flatter theme. Sent on every toggle and on connect,
  // since a reconnect gets a fresh server that has never heard of us.
  function sendPerf() {
    send({ type: "perf", on: perfOn() });
  }
  function syncPerfIndicator() {
    var b = el("perf-btn"); if (!b) return;
    var on = perfOn();
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }

  // --- Frame-time HUD (?fps=1) ---------------------------------------------
  // Opt-in only. Reports the rolling worst frame time alongside the average,
  // because on a weak GPU the average stays respectable while the occasional
  // 200ms hitch is what you actually notice.
  function startFpsHud() {
    var node = document.createElement("div");
    node.className = "fps-hud";
    document.body.appendChild(node);
    var last = 0, frames = 0, worst = 0, acc = 0;
    (function loop(t) {
      if (last) { var dt = t - last; acc += dt; frames++; if (dt > worst) worst = dt; }
      last = t;
      if (acc >= 500) {
        node.textContent = Math.round(1000 / (acc / frames)) + " FPS · max " + Math.round(worst) + "ms";
        acc = 0; frames = 0; worst = 0;
      }
      requestAnimationFrame(loop);
    })(0);
  }

  // --- Gestures (swipe, double-tap) ---------------------------------------
  var touchStartX = null, touchStartY = null, lastTap = 0;
  function onTouchStart(e) {
    var t = e.changedTouches[0];
    touchStartX = t.clientX; touchStartY = t.clientY;
  }
  function onTouchEnd(e) {
    if (touchStartX == null) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - touchStartX, dy = t.clientY - touchStartY;
    // On the minimal home screen, any tap or swipe just returns to the
    // dashboard (scene selection happens by swiping on the dashboard itself).
    if (launcherOpen) {
      touchStartX = null;
      // Ignore the tap that belongs to the same double-tap that just opened the
      // home screen (its synthesized click/second-tap arrives ~immediately);
      // only a deliberate later tap should dismiss it.
      if (Date.now() - launcherOpenedAt >= 500) closeLauncher();
      return;
    }
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      send({ type: "cycle", dir: dx > 0 ? -1 : 1 });
      touchStartX = null; return;
    }
    if (Math.abs(dx) < 14 && Math.abs(dy) < 14) {
      var now = Date.now();
      if (now - lastTap < 320) { lastTap = 0; onDoubleTapAnywhere(); }
      else { lastTap = now; }
    }
    touchStartX = null;
  }
  function onDoubleTapAnywhere() {
    // Default: open launcher when on idle. The idle scene's clock-button also
    // opens launcher, so this is a global convenience.
    if (scenes.idle && typeof scenes.idle.onDoubleTap === "function") {
      try { scenes.idle.onDoubleTap(); } catch (e) { console.error(e); }
    }
  }

  // --- Global ticker (4x/s) -------------------------------------------------
  // A gap this much larger than the 250ms interval means the page was
  // suspended or throttled, not merely busy: Android stops timers and rAF when
  // the screen sleeps, when the browser is backgrounded, and under battery
  // saver — and ColorOS does it aggressively even with keep-awake holding the
  // display on. The old code relied on visibilitychange alone, which never
  // fires for a throttle-to-a-crawl and doesn't tell us the socket also died
  // in the meantime, so the dashboard sat on stale data until a touch woke it.
  var FREEZE_GAP_MS = 2000;
  function tick() {
    var now = Date.now();
    var gap = lastTickAt ? now - lastTickAt : 0;
    lastTickAt = now;
    if (gap > FREEZE_GAP_MS) checkLink();

    if (launcherOpen) { renderLauncherTick(); return; }
    if (active && scenes[active] && scenes[active].onTick) {
      // Scenes render from Date.now(), so this call alone re-syncs the
      // playhead, lyric highlight and countdown after a freeze.
      try { scenes[active].onTick(state, now); } catch (e) {}
    }
    if (now - lastUptimeTick > 1000) {
      lastUptimeTick = now;
      renderUptime();
      var clk = el("sb-clock"); if (clk) clk.textContent = hhmmNow();
    }
  }
  function renderLauncherTick() {
    if (launcher && launcher.onTick) { try { launcher.onTick(Date.now()); } catch (e) {} }
  }

  // --- Nav controls (lock button + tap-to-dismiss home) --------------------
  function wireNav() {
    var lockBtn = el("lock-btn");
    if (lockBtn) {
      lockBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        send({ type: "lock", locked: !state.locked });
      });
      // Stop bubbling so a quick tap here can't also register as part of the
      // document-level double-tap-anywhere gesture (same pattern as fs-btn).
      lockBtn.addEventListener("touchend", function (e) { e.stopPropagation(); }, { passive: true });
    }
    // Minimal home screen: a click (desktop) anywhere returns to the dashboard.
    // Touch devices are handled in onTouchEnd (any tap/swipe dismisses).
    var launcherEl = el("launcher");
    if (launcherEl) launcherEl.addEventListener("click", function () {
      // Guard against the synthesized click from the opening double-tap (see
      // launcherOpenedAt) closing the home screen the instant it appears.
      if (Date.now() - launcherOpenedAt < 500) return;
      closeLauncher();
    });
  }

  // --- Public launcher controls (used by idle scene's double-tap) ----------
  function openLauncher() {
    var l = el("launcher"); if (!l) return;
    launcherOpen = true;
    launcherOpenedAt = Date.now();
    l.hidden = false;
    if (launcher && launcher.onEnter) { try { launcher.onEnter(state); } catch (e) {} }
  }
  function closeLauncher() {
    var l = el("launcher"); if (!l) return;
    launcherOpen = false;
    l.hidden = true;
    if (launcher && launcher.onExit) { try { launcher.onExit(); } catch (e) {} }
  }
  function isLauncherOpen() { return launcherOpen; }

  // --- Init -----------------------------------------------------------------
  function init() {
    // ?scene= override, ?launcher=1 to open the home screen on load
    var p = new URLSearchParams(location.search);
    var s = p.get("scene");
    if (s && SCENES.indexOf(s) >= 0) urlOverride = s;
    if (p.get("launcher") === "1") launcherOpen = true;

    // System bar
    renderSysBar();
    setInterval(renderSysBar, 1000);

    // Gestures + keep-awake
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchend", enableNoSleep, { once: true });
    document.addEventListener("click", enableNoSleep, { once: true });

    // Fullscreen: bind a small hotkey "f" for desktop dev; phone uses the
    // fs-btn in the system bar / touch.
    document.addEventListener("keydown", function (e) {
      if (e.key === "f" || e.key === "F") toggleFullscreen();
    });

    wireNav();
    // Fullscreen button (system bar, top-left)
    var fsBtn = el("fs-btn");
    if (fsBtn) {
      fsBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        enableNoSleep();
        toggleFullscreen();
      });
      fsBtn.addEventListener("touchend", function (e) { e.stopPropagation(); }, { passive: true });
    }
    // Perf-mode button (system bar, top-right next to the padlock).
    var perfBtn = el("perf-btn");
    if (perfBtn) {
      perfBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        setPerf(!perfOn());
      });
      // Same guard fs-btn/lock-btn use: a tap here must not also count towards
      // the document-level double-tap-anywhere gesture.
      perfBtn.addEventListener("touchend", function (e) { e.stopPropagation(); }, { passive: true });
    }
    syncPerfIndicator();
    if (p.get("fps") === "1") startFpsHud();
    if (launcherOpen) {
      var l = el("launcher");
      if (l) l.hidden = false;
      if (launcher && launcher.onEnter) { try { launcher.onEnter(state); } catch (e) {} }
    }
    initBattery();
    fetchInfo();
    setInterval(fetchInfo, 30000);
    connect();
    setInterval(tick, 250);
    // Some Android WebViews/browsers throttle timers and defer compositing
    // while the page sits untouched or briefly backgrounded, which stalls the
    // lyric highlight/scroll until you touch the screen. Force an immediate
    // resync the moment the page becomes visible again so it snaps to the
    // correct position instead of waiting for the next 250ms tick.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { try { tick(); } catch (e) {} }
    });
  }

  return {
    init: init,
    send: send,
    state: state,
    info: info,
    scenes: scenes,
    toggleFullscreen: toggleFullscreen,
    setPerf: setPerf,
    perfOn: perfOn,
    openLauncher: openLauncher,
    closeLauncher: closeLauncher,
    isLauncherOpen: isLauncherOpen,
    getClockOffsetMs: function () { return clockOffsetMs; },
  };
})();
