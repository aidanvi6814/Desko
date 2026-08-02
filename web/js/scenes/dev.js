// Dev scene — repo + active file + changes + last commit + today's totals.
//
// Data arrives from one of two sources (see desko/collectors/git.py): the VS
// Code extension while the editor is open, the git collector once it isn't.
// `dev.source` says which, and is also the liveness signal — the scene never
// computes staleness from `updatedAt`, because that timestamp now only moves
// when something actually CHANGED. A quiet hour of editing is not a dead link.
Desko.scenes.dev = (function () {
  var E = {};

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtTime(t) {
    var d = new Date(t * 1000);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function fmtAgo(sec) {
    if (sec < 45) return "just now";
    if (sec < 3600) return Math.round(sec / 60) + "m ago";
    if (sec < 86400) return Math.round(sec / 3600) + "h ago";
    return Math.round(sec / 86400) + "d ago";
  }
  // Server clock, not the phone's — a spare device's system time can be wildly
  // wrong, which would turn every commit age into nonsense.
  function nowSec() {
    var off = (window.Desko && Desko.getClockOffsetMs) ? Desko.getClockOffsetMs() : 0;
    return (Date.now() + off) / 1000;
  }

  function setText(node, value) { if (node) node.textContent = value; }

  // The chip in the panel label doubles as the data-source readout.
  function sourceLabel(d) {
    if (!d || !d.source) return "OFFLINE";
    if (d.source === "git") return "GIT";
    return d.focused ? "ACTIVE" : "IDLE";
  }

  function renderCommit(d) {
    var c = d && d.commit;
    if (!c || (!c.hash && !c.subject)) {
      setText(E.hash, "—");
      setText(E.commit, d && d.source ? "no commits yet" : "awaiting data…");
      return;
    }
    var age = c.at ? Math.max(0, nowSec() - c.at) : null;
    setText(E.hash, c.hash + (age == null ? "" : " · " + fmtAgo(age)));
    setText(E.commit, c.subject || "(no message)");
  }

  function renderToday(d) {
    var t = d && d.today;
    if (!t || (!t.commits && !t.added && !t.removed)) { setText(E.today, ""); return; }
    var bits = t.commits + (t.commits === 1 ? " commit" : " commits");
    if (t.added || t.removed) bits += " · +" + t.added + " −" + t.removed;
    setText(E.today, "TODAY " + bits.toUpperCase());
  }

  function renderEmpty() {
    setText(E.workspace, "VS Code");
    setText(E.path, "—");
    setText(E.branch, "—");
    setText(E.pub, "↑0 ↓0");
    setText(E.focus, "OFFLINE");
    setText(E.file, "—");
    setText(E.lang, "");
    setText(E.caret, "—");
    setText(E.eol, "—");
    setText(E.dirty, "0 DIRTY");
    if (E.changes) E.changes.innerHTML = '<li><b>·</b> no repo data…</li>';
    setText(E.hash, "—");
    setText(E.commit, "waiting for VS Code or a configured repo");
    setText(E.today, "");
    setText(E.time, "--:--:--");
    if (E.scene) E.scene.classList.add("stale");
  }

  function render(s) {
    var d = s && s.dev;
    if (!d || !d.source) {
      // Keep whatever the last known repo was visible but clearly dimmed when
      // we have data yet no live source; blank it entirely when we never did.
      if (!d) { renderEmpty(); return; }
      if (E.scene) E.scene.classList.add("stale");
    } else if (E.scene) {
      E.scene.classList.remove("stale");
    }

    setText(E.workspace, d.workspace || "VS Code");
    setText(E.path, d.path || "—");
    setText(E.branch, d.branch || "—");
    setText(E.focus, sourceLabel(d));
    setText(E.dirty, (d.dirty || 0) + " DIRTY");
    setText(E.pub, "↑" + (d.ahead || 0) + " ↓" + (d.behind || 0));

    // Editor-only fields are blank when git is the source — it has no idea
    // which file you had open, and guessing would look identical to knowing.
    setText(E.file, d.file || "—");
    setText(E.lang, (d.lang || "").toUpperCase());
    setText(E.caret, d.line ? "Ln " + d.line + ", Col " + (d.col || 1) : "—");
    setText(E.eol, d.eol || "—");

    if (E.changes) {
      var changes = d.changes || [];
      var items = "";
      for (var i = 0; i < changes.length; i++) {
        var c = changes[i] || {};
        var name = String(c.file || "").replace(/[<>&]/g, "");
        var mark = String(c.status || "M").replace(/[<>&]/g, "");
        items += '<li><b>' + mark + '</b> ' + name + '</li>';
      }
      if (!items) items = '<li><b>·</b> working tree clean</li>';
      E.changes.innerHTML = items;
    }

    renderCommit(d);
    renderToday(d);
    setText(E.time, fmtTime(d.updatedAt || nowSec()));
  }

  return {
    onEnter: function (state) {
      E = {
        scene: document.querySelector('[data-scene="dev"]'),
        workspace: document.getElementById("d-workspace"),
        path: document.getElementById("d-path"),
        branch: document.getElementById("d-branch"),
        pub: document.getElementById("d-pub"),
        focus: document.getElementById("d-focus"),
        file: document.getElementById("d-file"),
        lang: document.getElementById("d-lang"),
        caret: document.getElementById("d-caret"),
        eol: document.getElementById("d-eol"),
        dirty: document.getElementById("d-dirty"),
        changes: document.getElementById("d-changes"),
        hash: document.getElementById("d-hash"),
        commit: document.getElementById("d-commit"),
        today: document.getElementById("d-today"),
        time: document.getElementById("d-time"),
      };
      render(state);
    },
    onStateChange: function (state) { render(state); },
    // Only the commit age is time-dependent; everything else is push-driven.
    onTick: function (state) {
      if (state && state.dev) renderCommit(state.dev);
    },
    onExit: function () {},
  };
})();
