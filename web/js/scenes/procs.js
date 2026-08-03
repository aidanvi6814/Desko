// Processes scene — top memory consumers, grouped per application.
//
// Nothing here is filtered: svchost.exe and Memory Compression usually sit near
// the top and that's deliberate, this reports what the OS reports.
//
// Icons come from /api/proc-icon/<name> rather than inline data URLs, so the
// browser caches them once instead of the server re-sending a few KB per row on
// every refresh. A missing icon 404s and onerror hides the <img>, so apps
// without an extractable icon just render as text.
Desko.scenes.procs = (function () {
  var E = {};
  var lastKey = "";

  function fmtMb(mb) {
    if (mb == null) return "—";
    return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[<>&"]/g, ""); }

  function render(s) {
    var p = s && s.procs;
    if (!E.rows) return;
    if (!p || !p.top || !p.top.length) {
      E.rows.innerHTML = '<li class="proc-empty">scanning…</li>';
      if (E.meta) E.meta.textContent = "—";
      lastKey = "";
      return;
    }

    // Rebuilding innerHTML swaps every <img>, which makes the icons flicker on
    // a slow phone even when nothing changed. Only redraw when the data moved.
    var key = "";
    for (var k = 0; k < p.top.length; k++) key += p.top[k].name + ":" + p.top[k].mb + "|";
    if (key === lastKey) return;
    lastKey = key;

    var peak = p.top[0].mb || 1;
    var html = "";
    for (var i = 0; i < p.top.length; i++) {
      var e = p.top[i];
      var pct = Math.max(2, Math.round((e.mb / peak) * 100));
      var icon = e.icon
        ? '<img class="proc-icon" src="/api/proc-icon/' + encodeURIComponent(e.name) +
          '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<span class="proc-icon"></span>';
      html += '<li>' + icon +
        '<span class="proc-name">' + esc(e.label) + '</span>' +
        '<span class="proc-count">' + (e.count > 1 ? "×" + e.count : "") + '</span>' +
        '<span class="proc-mb">' + fmtMb(e.mb) + '</span>' +
        '<i class="proc-bar"><b style="width:' + pct + '%"></b></i>' +
        '</li>';
    }
    E.rows.innerHTML = html;

    if (E.meta) {
      E.meta.textContent = fmtMb(p.totalMb) + " total"
        + (p.sweepMs != null ? " · scan " + p.sweepMs + "ms" : "");
    }
  }

  return {
    onEnter: function (state) {
      E = {
        rows: document.getElementById("p-rows"),
        meta: document.getElementById("p-meta"),
      };
      lastKey = "";
      render(state);
    },
    onStateChange: function (state) { render(state); },
    onTick: function () {},
    onExit: function () {},
  };
})();
