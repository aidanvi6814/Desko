// Stats scene — game heading, 3 meters, telemetry, footer.
Desko.scenes.stats = (function () {
  var E = {};
  var sessionStart = 0;      // ms; when the current session/scene started
  var sessionGameKey = null; // detects a game (re)start to reset the session clock

  function fmtRate(kbs) {
    if (kbs == null) return "—";
    if (kbs >= 1024) return (kbs / 1024).toFixed(1) + " MB/s";
    return Math.round(kbs) + " KB/s";
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtHMS(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(s / 3600)) + ":" + pad2(Math.floor((s % 3600) / 60)) + ":" + pad2(s % 60);
  }
  // Render a polyline into an SVG sparkline. `scaleMax`:
  //   - a number  -> fixed scale (percentages use 100)
  //   - "auto"     -> scale to the window's own peak (for unbounded series
  //                   like network KB/s, which have no natural 0-100 range)
  function spark(svg, data, scaleMax) {
    if (!svg) return;
    var line = svg.querySelector("polyline");
    if (!line) return;
    if (!data || !data.length) { line.setAttribute("points", ""); return; }
    var max = 100;
    if (scaleMax === "auto") {
      max = 1;
      for (var k = 0; k < data.length; k++) if (data[k] > max) max = data[k];
    } else if (typeof scaleMax === "number") {
      max = scaleMax;
    }
    var n = data.length, pts = [];
    for (var i = 0; i < n; i++) {
      var x = n === 1 ? 0 : (i / (n - 1)) * 100;
      var v = Math.max(0, Math.min(1, data[i] / max));
      pts.push(x.toFixed(1) + "," + (40 - v * 30).toFixed(1));
    }
    line.setAttribute("points", pts.join(" "));
  }
  function setText(el, v) { if (el) el.textContent = (v == null || v === "") ? "—" : v; }

  function render(s) {
    var sys = s && s.sys;
    var game = s && s.game;
    if (!sys) return;

    // Game heading
    if (E.eyebrow) E.eyebrow.textContent = game ? "PROCESS DETECTED" : "PERFORMANCE MONITOR";
    if (E.game) E.game.textContent = game ? game.label : "SYSTEM TELEMETRY";
    if (E.load) {
      // "LOAD" = max(cpu, gpu) as a v0-style FPS-ish headline
      var load = Math.max(sys.cpuPercent || 0, sys.gpuPercent || 0);
      E.load.textContent = Math.round(load);
      var loadEl = E.load.parentElement;
      if (loadEl) loadEl.classList.toggle("amber", sys.gpuTempC != null && sys.gpuTempC >= 80);
    }

    // CPU meter
    if (E.cpu) { E.cpu.innerHTML = Math.round(sys.cpuPercent || 0) + "<small>%</small>"; }
    if (E.cpuTemp) setText(E.cpuTemp, sys.cpuTempC != null ? sys.cpuTempC + "°" : "—");
    if (E.cpuFill) E.cpuFill.style.width = (sys.cpuPercent || 0) + "%";

    // GPU meter
    var gpuShown = sys.gpuPercent != null;
    if (E.gpuCard) E.gpuCard.style.display = gpuShown ? "" : "none";
    if (gpuShown) {
      if (E.gpu) E.gpu.innerHTML = Math.round(sys.gpuPercent) + "<small>%</small>";
      var hot = sys.gpuTempC != null && sys.gpuTempC >= 80;
      if (E.gpu) E.gpu.classList.toggle("amber", hot);
      if (E.gpuTemp) setText(E.gpuTemp, sys.gpuTempC != null ? sys.gpuTempC + "°" : "—");
      if (E.gpuFill) {
        E.gpuFill.style.width = (sys.gpuPercent || 0) + "%";
        E.gpuFill.classList.toggle("warning-fill", hot);
      }
    }

    // RAM meter
    if (E.ram) E.ram.innerHTML = Math.round(sys.ramPercent || 0) + "<small>%</small>";
    if (E.ramFill) E.ramFill.style.width = (sys.ramPercent || 0) + "%";
    if (E.ramSub) setText(E.ramSub, (sys.ramUsedGb != null ? sys.ramUsedGb.toFixed(1) : "—") + " GB");
    // Desko's own footprint. Rounded to whole MB: the value drifts by a few
    // hundred KB between ticks and a decimal place would just flicker.
    if (E.ramSelf) setText(E.ramSelf, sys.procMemMb != null ? "DESKO " + Math.round(sys.procMemMb) + " MB" : null);

    // Session clock: reset when a game is (re)detected, otherwise counts from
    // when the Stats scene was entered. game.updatedAt is stamped once when a
    // game is first detected (see context.py), so it's a stable session start.
    if (game && game.updatedAt) {
      var gk = game.matched + "|" + game.updatedAt;
      if (gk !== sessionGameKey) { sessionGameKey = gk; sessionStart = game.updatedAt * 1000; }
    } else if (sessionGameKey !== null) {
      sessionGameKey = null; sessionStart = Date.now();
    }
    if (E.session) E.session.textContent = fmtHMS(Date.now() - sessionStart);

    // Sparklines (cpu/gpu are 0-100 percentages; net auto-scales to its peak)
    spark(E.sparkCpu, (sys.history || {}).cpu, 100);
    spark(E.sparkGpu, (sys.history || {}).gpu, 100);
    spark(E.sparkNet, (sys.history || {}).net, "auto");

    // Footer — large temp chips
    setTempChip(E.cpuChip, E.cpuTempBig, sys.cpuTempC);
    setTempChip(E.gpuChip, E.gpuTempBig, sys.gpuTempC);
    if (E.netDown) setText(E.netDown, fmtRate(sys.netDownKbs));
    if (E.netUp) setText(E.netUp, fmtRate(sys.netUpKbs));
  }

  function setTempChip(chip, valEl, t) {
    if (!chip || !valEl) return;
    if (t == null) {
      valEl.textContent = "LHM offline";
      chip.classList.add("missing");
      chip.classList.remove("hot");
      return;
    }
    valEl.textContent = Math.round(t) + "°C";
    chip.classList.remove("missing");
    chip.classList.toggle("hot", t >= 80);
  }

  return {
    onEnter: function (state) {
      E = {
        eyebrow: document.getElementById("s-eyebrow"),
        game: document.getElementById("s-game"),
        session: document.getElementById("s-session"),
        load: document.getElementById("s-load"),
        cpu: document.getElementById("s-cpu"),
        cpuTemp: document.getElementById("s-cpu-temp"),
        cpuFill: document.getElementById("s-cpu-fill"),
        gpu: document.getElementById("s-gpu"),
        gpuCard: document.getElementById("s-gpu-card"),
        gpuTemp: document.getElementById("s-gpu-temp"),
        gpuFill: document.getElementById("s-gpu-fill"),
        ram: document.getElementById("s-ram"),
        ramFill: document.getElementById("s-ram-fill"),
        ramSub: document.getElementById("s-ram-sub"),
        ramSelf: document.getElementById("s-ram-self"),
        sparkCpu: document.getElementById("s-spark-cpu"),
        sparkGpu: document.getElementById("s-spark-gpu"),
        sparkNet: document.getElementById("s-spark-net"),
        cpuChip: document.getElementById("s-cpu-chip"),
        cpuTempBig: document.getElementById("s-cputemp-big"),
        gpuChip: document.getElementById("s-gpu-chip"),
        gpuTempBig: document.getElementById("s-gputemp-big"),
        netDown: document.getElementById("s-net-down"),
        netUp: document.getElementById("s-net-up"),
      };
      // Default the session clock to "entered now"; render() overrides this
      // with the game's start time if one is running.
      sessionStart = Date.now();
      sessionGameKey = null;
      render(state);
    },
    onStateChange: function (state) { render(state); },
    onTick: function (state, now) {
      // Tick the session clock every frame (cheap string format) so it counts
      // up smoothly even between the ~1s sys updates.
      if (E.session) E.session.textContent = fmtHMS(now - sessionStart);
    },
    onExit: function () {},
  };
})();
