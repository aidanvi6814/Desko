// Dev scene — repo + active-file + changes + commit heartbeat.
Desko.scenes.dev = (function () {
  var E = {};

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtTime(t) {
    var d = new Date(t * 1000);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function render(s) {
    var d = s && s.dev;
    if (!d) {
      if (E.workspace) E.workspace.textContent = "VS Code";
      if (E.branch) E.branch.textContent = "—";
      if (E.pub) E.pub.textContent = "↑0 ↓0";
      if (E.file) E.file.textContent = "—";
      if (E.lang) E.lang.textContent = "";
      if (E.dirty) E.dirty.textContent = "0 DIRTY";
      if (E.changes) E.changes.innerHTML = '<li><b>·</b> awaiting VS Code data…</li>';
      if (E.commit) E.commit.textContent = "scene sync heartbeat";
      if (E.time) E.time.textContent = "--:--:--";
      return;
    }
    if (E.workspace) E.workspace.textContent = d.workspace || "VS Code";
    if (E.branch) E.branch.textContent = d.branch || "—";
    var dirty = d.dirty || 0;
    if (E.dirty) E.dirty.textContent = dirty + " DIRTY";
    if (E.file) E.file.textContent = d.file || "—";
    if (E.lang) E.lang.textContent = (d.lang || "").toUpperCase();
    // Real ahead/behind from the extension's read of the git upstream.
    if (E.pub) E.pub.textContent = "↑" + (d.ahead || 0) + " ↓" + (d.behind || 0);
    if (E.changes) {
      // Real changed-file list from the extension (staged + working tree).
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
    if (E.time) E.time.textContent = fmtTime(d.updatedAt || (Date.now() / 1000));
    if (E.commit) {
      var ago = Math.max(0, Math.floor(Date.now() / 1000 - (d.updatedAt || Date.now() / 1000)));
      E.commit.textContent = "scene sync heartbeat received " + ago + "s ago";
    }
  }

  return {
    onEnter: function (state) {
      E = {
        workspace: document.getElementById("d-workspace"),
        branch: document.getElementById("d-branch"),
        pub: document.getElementById("d-pub"),
        focus: document.getElementById("d-focus"),
        file: document.getElementById("d-file"),
        lang: document.getElementById("d-lang"),
        dirty: document.getElementById("d-dirty"),
        changes: document.getElementById("d-changes"),
        commit: document.getElementById("d-commit"),
        time: document.getElementById("d-time"),
      };
      render(state);
    },
    onStateChange: function (state) { render(state); },
    onTick: function (state, now) {
      if (state.dev && E.commit) {
        var ago = Math.max(0, Math.floor(Date.now() / 1000 - (state.dev.updatedAt || Date.now() / 1000)));
        E.commit.textContent = "scene sync heartbeat received " + ago + "s ago";
      }
    },
    onExit: function () {},
  };
})();
