// Desko Status — reports VS Code workspace + git branch + dirty count + current
// file to the local Desko server. Dependency-free, silent on every error.
const vscode = require("vscode");
const path = require("path");
const http = require("http");

const HOST = "127.0.0.1";
const PORT = 7777;
const PATH_ = "/api/vscode";
const INTERVAL_MS = 10000;
const MAX_CHANGES = 8; // cap the changed-file list sent to the dashboard

let timer = null;

// vscode.git Status enum -> short letter for the dashboard's GIT.CHANGES list.
const STATUS_LETTER = {
  0: "M", 1: "A", 2: "D", 3: "R", 4: "C", // staged (index) variants
  5: "M", 6: "D", 7: "U", 8: "I", 9: "A", // working-tree variants
};
function statusLetter(s) { return STATUS_LETTER[s] || "M"; }

function post(payload) {
  return new Promise(function (resolve) {
    var body;
    try { body = JSON.stringify(payload); } catch (e) { return resolve(); }
    var req = http.request(
      {
        host: HOST, port: PORT, path: PATH_, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      function () { resolve(); }
    );
    req.on("error", function () { resolve(); });
    req.write(body);
    req.end();
  });
}

function collect() {
  try {
    var branch = "";
    var dirty = 0;
    var ahead = 0;
    var behind = 0;
    var changes = [];
    var gitExt = vscode.extensions.getExtension("vscode.git");
    if (gitExt && gitExt.exports && gitExt.exports.getAPI) {
      var git = gitExt.exports.getAPI(1);
      var repos = (git && git.repositories) || [];
      if (repos.length) {
        var r = repos[0];
        var st = r.state || {};
        if (st.HEAD && st.HEAD.name) branch = st.HEAD.name;
        if (st.HEAD && typeof st.HEAD.ahead === "number") ahead = st.HEAD.ahead;
        if (st.HEAD && typeof st.HEAD.behind === "number") behind = st.HEAD.behind;
        // Staged (index) changes first, then working-tree changes -- this is
        // the real "what's dirty" list, replacing the old fabricated one.
        var all = [].concat(st.indexChanges || [], st.workingTreeChanges || []);
        dirty = all.length;
        for (var i = 0; i < all.length && changes.length < MAX_CHANGES; i++) {
          var c = all[i];
          var p = (c.uri && (c.uri.fsPath || c.uri.path)) || "";
          changes.push({ file: path.basename(p) || p, status: statusLetter(c.status) });
        }
      }
    }
    var editor = vscode.window.activeTextEditor;
    var file = editor ? path.basename(editor.document.fileName) : "";
    var lang = editor ? editor.document.languageId : "";
    var payload = {
      workspace: vscode.workspace.name || "",
      branch: branch,
      dirty: dirty,
      ahead: ahead,
      behind: behind,
      changes: changes,
      file: file,
      lang: lang,
      focused: !!vscode.window.state.focused,
    };
    post(payload);
  } catch (e) {
    // never surface errors to the user
  }
}

function activate(context) {
  collect();
  timer = setInterval(collect, INTERVAL_MS);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(collect),
    vscode.commands.registerCommand("desko-status.ping", collect)
  );
}

function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { activate: activate, deactivate: deactivate };
