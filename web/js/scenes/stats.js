// Stats scene — game heading with top-app icons, 3 meters, telemetry, footer.
//
// The memory breakdown lives in a popup rather than its own scene: tapping the
// SYS.RAM meter opens a scrollable list of every tracked app with its memory
// and CPU share. The header carries just the icons as a glance version.
Desko.scenes.stats = (function () {
  var E = {};
  var HEAD_ICONS = 6;

  // Shown for anything with no extractable icon, which is mostly Windows'
  // own processes (svchost, Memory Compression, Registry).
  var SYS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/>' +
    '<path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/></svg>';

  function fmtRate(kbs) {
    if (kbs == null) return "—";
    if (kbs >= 1024) return (kbs / 1024).toFixed(1) + " MB/s";
    return Math.round(kbs) + " KB/s";
  }
  function fmtMb(mb) {
    if (mb == null) return "—";
    return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[<>&"]/g, ""); }
  function setText(el, v) { if (el) el.textContent = (v == null || v === "") ? "—" : v; }

  function iconHtml(e, cls) {
    if (!e.icon) return '<span class="' + cls + ' is-sys">' + SYS_ICON + "</span>";
    return '<img class="' + cls + '" src="/api/proc-icon/' + encodeURIComponent(e.name) +
      '" alt="" onerror="this.style.visibility=\'hidden\'">';
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

  // --- process rendering ----------------------------------------------------
  // Rebuilding innerHTML swaps every <img>, which visibly flickers on a slow
  // phone. Both renderers key on the data and skip redundant redraws.
  var headKey = "";
  function renderHeadIcons(procs) {
    if (!E.headProcs) return;
    var top = (procs && procs.top) || [];
    if (!top.length) { E.headProcs.innerHTML = ""; headKey = ""; return; }
    var n = Math.min(HEAD_ICONS, top.length), key = "", html = "";
    for (var i = 0; i < n; i++) key += top[i].name + "|";
    if (key === headKey) return;
    headKey = key;
    for (var j = 0; j < n; j++) {
      var e = top[j];
      html += '<li title="' + esc(e.label) + " · " + fmtMb(e.mb) + '">' +
        iconHtml(e, "head-icon") + "</li>";
    }
    E.headProcs.innerHTML = html;
  }

  var modalKey = "";
  function renderModal(procs) {
    if (!E.pmRows) return;
    var top = (procs && procs.top) || [];
    if (!top.length) {
      E.pmRows.innerHTML = '<li class="proc-empty">scanning…</li>';
      modalKey = "";
      return;
    }
    var key = "", i;
    for (i = 0; i < top.length; i++) key += top[i].name + ":" + top[i].mb + ":" + top[i].cpu + "|";
    if (key === modalKey) return;
    modalKey = key;

    var peak = top[0].mb || 1, html = "";
    for (i = 0; i < top.length; i++) {
      var e = top[i];
      var w = Math.max(2, Math.round((e.mb / peak) * 100));
      html += "<li>" + iconHtml(e, "proc-icon") +
        '<span class="proc-name">' + esc(e.label) + "</span>" +
        '<span class="proc-count">' + (e.count > 1 ? "×" + e.count : "") + "</span>" +
        '<span class="proc-cpu">' + (e.cpu == null ? "—" : e.cpu + "%") + "</span>" +
        '<span class="proc-mb">' + fmtMb(e.mb) + "</span>" +
        '<i class="proc-bar"><b style="width:' + w + '%"></b></i>' +
        "</li>";
    }
    E.pmRows.innerHTML = html;
    if (E.pmMeta) {
      E.pmMeta.textContent = fmtMb(procs.totalMb) + " total"
        + (procs.sweepMs != null ? " · scan " + procs.sweepMs + "ms" : "");
    }
  }

  // Last state seen by render(), so opening the popup can draw immediately
  // instead of waiting up to 30s for the next procs update to arrive.
  var lastState = null;

  function openModal() {
    if (!E.modal) return;
    E.modal.hidden = false;
    modalKey = "";
    renderModal(lastState && lastState.procs);
  }
  function closeModal() { if (E.modal) E.modal.hidden = true; }

  function render(s) {
    lastState = s;
    var sys = s && s.sys;
    var game = s && s.game;
    renderHeadIcons(s && s.procs);
    if (E.modal && !E.modal.hidden) renderModal(s && s.procs);
    if (!sys) return;

    if (E.eyebrow) E.eyebrow.textContent = game ? "PROCESS DETECTED" : "PERFORMANCE MONITOR";
    if (E.game) E.game.textContent = game ? game.label : "SYSTEM TELEMETRY";
    if (E.load) {
      var load = Math.max(sys.cpuPercent || 0, sys.gpuPercent || 0);
      E.load.textContent = Math.round(load);
      var loadEl = E.load.parentElement;
      if (loadEl) loadEl.classList.toggle("amber", sys.gpuTempC != null && sys.gpuTempC >= 80);
    }

    if (E.cpu) { E.cpu.innerHTML = Math.round(sys.cpuPercent || 0) + "<small>%</small>"; }
    if (E.cpuTemp) setText(E.cpuTemp, sys.cpuTempC != null ? sys.cpuTempC + "°" : "—");
    if (E.cpuFill) E.cpuFill.style.width = (sys.cpuPercent || 0) + "%";

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

    if (E.ram) E.ram.innerHTML = Math.round(sys.ramPercent || 0) + "<small>%</small>";
    if (E.ramFill) E.ramFill.style.width = (sys.ramPercent || 0) + "%";
    if (E.ramSub) setText(E.ramSub, (sys.ramUsedGb != null ? sys.ramUsedGb.toFixed(1) : "—") + " GB");

    spark(E.sparkCpu, (sys.history || {}).cpu, 100);
    spark(E.sparkGpu, (sys.history || {}).gpu, 100);
    spark(E.sparkNet, (sys.history || {}).net, "auto");

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

  var wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    if (E.ramCard) {
      E.ramCard.addEventListener("click", function (ev) { ev.stopPropagation(); openModal(); });
    }
    if (E.pmClose) {
      E.pmClose.addEventListener("click", function (ev) { ev.stopPropagation(); closeModal(); });
    }
    // Tapping the backdrop closes; taps inside the card must not bubble to it.
    if (E.modal) {
      E.modal.addEventListener("click", function () { closeModal(); });
      var card = E.modal.querySelector(".proc-modal-card");
      if (card) card.addEventListener("click", function (ev) { ev.stopPropagation(); });
    }
  }

  return {
    onEnter: function (state) {
      E = {
        eyebrow: document.getElementById("s-eyebrow"),
        game: document.getElementById("s-game"),
        load: document.getElementById("s-load"),
        headProcs: document.getElementById("s-head-procs"),
        cpu: document.getElementById("s-cpu"),
        cpuTemp: document.getElementById("s-cpu-temp"),
        cpuFill: document.getElementById("s-cpu-fill"),
        gpu: document.getElementById("s-gpu"),
        gpuCard: document.getElementById("s-gpu-card"),
        gpuTemp: document.getElementById("s-gpu-temp"),
        gpuFill: document.getElementById("s-gpu-fill"),
        ram: document.getElementById("s-ram"),
        ramCard: document.getElementById("s-ram-card"),
        ramFill: document.getElementById("s-ram-fill"),
        ramSub: document.getElementById("s-ram-sub"),
        sparkCpu: document.getElementById("s-spark-cpu"),
        sparkGpu: document.getElementById("s-spark-gpu"),
        sparkNet: document.getElementById("s-spark-net"),
        cpuChip: document.getElementById("s-cpu-chip"),
        cpuTempBig: document.getElementById("s-cputemp-big"),
        gpuChip: document.getElementById("s-gpu-chip"),
        gpuTempBig: document.getElementById("s-gputemp-big"),
        netDown: document.getElementById("s-net-down"),
        netUp: document.getElementById("s-net-up"),
        modal: document.getElementById("proc-modal"),
        pmRows: document.getElementById("pm-rows"),
        pmMeta: document.getElementById("pm-meta"),
        pmClose: document.getElementById("pm-close"),
      };
      headKey = modalKey = "";
      wire();
      render(state);
    },
    onStateChange: function (state) { render(state); },
    onTick: function () {},
    // Rotating away with the popup still up would leave it floating over the
    // next scene, so it closes with the scene that owns it.
    onExit: function () { closeModal(); },
  };
})();
