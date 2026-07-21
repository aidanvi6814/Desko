// Focus scene — Pomodoro timer. State is server-authoritative (see desko/
// focus.py); this renders a live countdown ring and sends control messages.
Desko.scenes.focus = (function () {
  var E = {};
  var CIRC = 2 * Math.PI * 54; // ring radius 54 (viewBox 120)
  var busy = false;

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    return pad2(Math.floor(sec / 60)) + ":" + pad2(sec % 60);
  }

  // Remaining seconds, computed live from the server's endsAt while running
  // (clock-skew corrected the same way music position is), or the stored
  // remainingSec while paused.
  function remaining(f, now) {
    if (!f) return 0;
    if (f.running && f.endsAt) {
      var off = (window.Desko && Desko.getClockOffsetMs) ? Desko.getClockOffsetMs() : 0;
      return Math.max(0, f.endsAt - (now + off) / 1000);
    }
    return f.remainingSec || 0;
  }

  function paint(f, now) {
    if (!f) return;
    var scene = E.scene;
    var isBreak = f.mode === "break";
    if (scene) scene.classList.toggle("is-break", isBreak);
    var rem = remaining(f, now);
    var dur = f.durationSec || 1;
    var frac = Math.max(0, Math.min(1, rem / dur));
    if (E.ring) E.ring.style.strokeDashoffset = (CIRC * (1 - frac)).toFixed(2);
    if (E.time) E.time.textContent = fmt(rem);
    if (E.phase) E.phase.textContent = isBreak ? "BREAK" : "WORK SESSION";
    if (E.state) E.state.textContent = f.running ? (isBreak ? "ON BREAK" : "FOCUSING") : "PAUSED";
    if (E.toggleIcon) E.toggleIcon.innerHTML = f.running
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }

  function renderStatic(f) {
    if (!f) return;
    if (E.cycles) E.cycles.textContent = f.cyclesDone || 0;
    if (E.work) E.work.textContent = f.workMin;
    if (E.brk) E.brk.textContent = f.breakMin;
    if (E.pips) {
      // A little row of pips: filled = completed work sessions in the current
      // set of 4 (classic Pomodoro long-break cadence).
      var done = (f.cyclesDone || 0) % 4;
      var html = "";
      for (var i = 0; i < 4; i++) html += '<i class="' + (i < done ? "on" : "") + '"></i>';
      E.pips.innerHTML = html;
    }
  }

  function send(action, extra) {
    var msg = { type: "focus", action: action };
    if (extra) for (var k in extra) msg[k] = extra[k];
    Desko.send(msg);
  }
  function tap(fn) {
    // light debounce so a double-fire doesn't double-toggle
    if (busy) return;
    busy = true;
    setTimeout(function () { busy = false; }, 160);
    fn();
  }

  function wire() {
    if (E.toggle) E.toggle.addEventListener("click", function () {
      var f = Desko.state.focus;
      tap(function () { send(f && f.running ? "pause" : "start"); });
    });
    if (E.reset) E.reset.addEventListener("click", function () { tap(function () { send("reset"); }); });
    if (E.skip) E.skip.addEventListener("click", function () { tap(function () { send("skip"); }); });
    E.presets.forEach(function (b) {
      b.addEventListener("click", function () {
        var f = Desko.state.focus; if (!f) return;
        var d = parseInt(b.dataset.d, 10) || 0;
        if (b.dataset.adj === "work") send("set", { workMin: (f.workMin || 25) + d });
        else send("set", { breakMin: (f.breakMin || 5) + d });
      });
    });
  }

  return {
    onEnter: function (state) {
      E = {
        scene: document.querySelector('[data-scene="focus"]'),
        state: document.getElementById("f-state"),
        ring: document.getElementById("f-ring"),
        time: document.getElementById("f-time"),
        phase: document.getElementById("f-phase"),
        cycles: document.getElementById("f-cycles"),
        pips: document.getElementById("f-pips"),
        work: document.getElementById("f-work"),
        brk: document.getElementById("f-break"),
        toggle: document.getElementById("f-toggle"),
        toggleIcon: document.getElementById("f-toggle-icon"),
        reset: document.getElementById("f-reset"),
        skip: document.getElementById("f-skip"),
        presets: Array.prototype.slice.call(document.querySelectorAll(".focus-preset .preset-btn")),
      };
      if (E.ring) { E.ring.style.strokeDasharray = CIRC.toFixed(2); }
      wire();
      renderStatic(state.focus);
      paint(state.focus, Date.now());
    },
    onStateChange: function (state) { renderStatic(state.focus); paint(state.focus, Date.now()); },
    onTick: function (state, now) { paint(state.focus, now); },
    onExit: function () {},
  };
})();
