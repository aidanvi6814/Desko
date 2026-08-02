// Desko Status — reports VS Code workspace + git state + cursor position to the
// local Desko server. Dependency-free, silent on every error.
//
// EVENT-DRIVEN, NOT POLLED. This used to rebuild and POST the whole payload on
// a 10s timer, which got the latency exactly backwards: switching branches is
// the moment you're most likely to glance at the dashboard, and it was the
// moment with up to 10s of lag. The git extension exposes
// `repository.state.onDidChange`, which fires the instant the branch, index or
// working tree moves — so branch switches now land on the phone in well under
// a second, while sending FEWER requests than before, because identical
// payloads are dropped instead of re-sent.
//
// The 15s heartbeat that remains is pure liveness: the server records it as
// proof the editor is alive (without broadcasting anything to the phone) and
// hands the Dev scene over to its git collector when the heartbeats stop.
const vscode = require("vscode");
const path = require("path");
const http = require("http");

const HOST = "127.0.0.1";
const PORT = 7777;
const PATH_ = "/api/vscode";

const HEARTBEAT_MS = 15000;
const DEBOUNCE_MS = 250;
// Selection fires per keystroke while you hold an arrow key; the cursor
// readout is not worth a request per repeat.
const SELECTION_DEBOUNCE_MS = 400;
const MAX_CHANGES = 8;

let heartbeat = null;
let debounceTimer = null;
let gitApiRef = null;
let lastBody = "";
let lastCommitHash = "";
let lastCommitInfo = null;

// vscode.git Status enum -> short letter for the dashboard's GIT.CHANGES list.
const STATUS_LETTER = {
  0: "M", 1: "A", 2: "D", 3: "R", 4: "C", // staged (index) variants
  5: "M", 6: "D", 7: "U", 8: "I", 9: "A", // working-tree variants
};
function statusLetter(s) { return STATUS_LETTER[s] || "M"; }

function post(body) {
  try {
    const req = http.request({
      host: HOST, port: PORT, path: PATH_, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, function (res) { res.resume(); });
    req.on("error", function () {});
    req.write(body);
    req.end();
  } catch (e) {
    // server not running — expected, stay silent
  }
}

// Pick the repo that owns the file you're actually looking at, not
// `repositories[0]`. Longest matching root wins so nested repos resolve to the
// inner one; falls back to the first repo when nothing is open.
function pickRepo() {
  const repos = (gitApiRef && gitApiRef.repositories) || [];
  if (!repos.length) return null;
  const ed = vscode.window.activeTextEditor;
  const file = ed && ed.document && ed.document.uri && ed.document.uri.fsPath;
  if (file) {
    const f = file.toLowerCase();
    let best = null;
    let bestLen = -1;
    for (let i = 0; i < repos.length; i++) {
      const root = (repos[i].rootUri && repos[i].rootUri.fsPath) || "";
      if (root && f.indexOf(root.toLowerCase()) === 0 && root.length > bestLen) {
        best = repos[i];
        bestLen = root.length;
      }
    }
    if (best) return best;
  }
  return repos[0];
}

// repo.log() hits disk, so only re-read when HEAD actually moved.
function refreshCommit(repo) {
  const head = repo && repo.state && repo.state.HEAD;
  const hash = (head && head.commit) || "";
  if (!hash) { lastCommitHash = ""; lastCommitInfo = null; return Promise.resolve(null); }
  if (hash === lastCommitHash) return Promise.resolve(lastCommitInfo);
  return Promise.resolve(repo.log({ maxEntries: 1 })).then(function (commits) {
    const c = commits && commits[0];
    if (!c) return lastCommitInfo;
    lastCommitHash = hash;
    lastCommitInfo = {
      hash: String(c.hash || hash).slice(0, 8),
      subject: String(c.message || "").split("\n")[0].slice(0, 90),
      at: Math.floor(new Date(c.commitDate || c.authorDate || Date.now()).getTime() / 1000),
    };
    return lastCommitInfo;
  }).catch(function () { return lastCommitInfo; });
}

function buildPayload(repo, commit) {
  let branch = "";
  let dirty = 0;
  let ahead = 0;
  let behind = 0;
  const changes = [];
  let repoPath = "";

  if (repo) {
    const st = repo.state || {};
    repoPath = (repo.rootUri && repo.rootUri.fsPath) || "";
    if (st.HEAD && st.HEAD.name) branch = st.HEAD.name;
    if (st.HEAD && typeof st.HEAD.ahead === "number") ahead = st.HEAD.ahead;
    if (st.HEAD && typeof st.HEAD.behind === "number") behind = st.HEAD.behind;
    // Staged (index) changes first, then working-tree changes -- the real
    // "what's dirty" list.
    const all = [].concat(st.indexChanges || [], st.workingTreeChanges || []);
    dirty = all.length;
    for (let i = 0; i < all.length && changes.length < MAX_CHANGES; i++) {
      const c = all[i];
      const p = (c.uri && (c.uri.fsPath || c.uri.path)) || "";
      changes.push({ file: path.basename(p) || p, status: statusLetter(c.status) });
    }
  }

  const editor = vscode.window.activeTextEditor;
  let file = "";
  let lang = "";
  let line = 0;
  let col = 0;
  let eol = "";
  if (editor && editor.document) {
    file = path.basename(editor.document.fileName);
    lang = editor.document.languageId;
    eol = editor.document.eol === vscode.EndOfLine.CRLF ? "CRLF" : "LF";
    const pos = editor.selection && editor.selection.active;
    if (pos) { line = pos.line + 1; col = pos.character + 1; }
  }

  if (!repoPath) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) repoPath = folders[0].uri.fsPath;
  }

  return {
    workspace: vscode.workspace.name || (repoPath ? path.basename(repoPath) : ""),
    path: repoPath,
    branch: branch,
    dirty: dirty,
    ahead: ahead,
    behind: behind,
    changes: changes,
    commit: commit || null,
    file: file,
    lang: lang,
    line: line,
    col: col,
    eol: eol,
    focused: !!vscode.window.state.focused,
  };
}

// force=true always sends (the heartbeat, and the first report after wiring up).
function collect(force) {
  try {
    const repo = pickRepo();
    const pending = repo ? refreshCommit(repo) : Promise.resolve(null);
    pending.then(function (commit) {
      let body;
      try { body = JSON.stringify(buildPayload(repo, commit)); } catch (e) { return; }
      if (!force && body === lastBody) return;
      lastBody = body;
      post(body);
    }).catch(function () {});
  } catch (e) {
    // never surface errors to the user
  }
}

function schedule(ms) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function () { debounceTimer = null; collect(false); }, ms);
}

// The git extension may not have activated yet at onStartupFinished, and repos
// can open long after (folder added, clone finished) — so subscribe to
// onDidOpenRepository rather than snapshotting the list once.
function wireGit(context) {
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) return;
  Promise.resolve(ext.isActive ? ext.exports : ext.activate()).then(function (exports) {
    const api = exports && exports.getAPI ? exports.getAPI(1) : null;
    if (!api) return;
    gitApiRef = api;
    const wireRepo = function (r) {
      try {
        context.subscriptions.push(r.state.onDidChange(function () { schedule(DEBOUNCE_MS); }));
      } catch (e) {}
      schedule(DEBOUNCE_MS);
    };
    (api.repositories || []).forEach(wireRepo);
    try {
      context.subscriptions.push(
        api.onDidOpenRepository(wireRepo),
        api.onDidCloseRepository(function () { schedule(DEBOUNCE_MS); })
      );
    } catch (e) {}
    collect(true);
  }).catch(function () {});
}

function activate(context) {
  collect(true);
  heartbeat = setInterval(function () { collect(true); }, HEARTBEAT_MS);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(function () { schedule(DEBOUNCE_MS); }),
    vscode.window.onDidChangeTextEditorSelection(function () { schedule(SELECTION_DEBOUNCE_MS); }),
    vscode.window.onDidChangeWindowState(function () { schedule(DEBOUNCE_MS); }),
    vscode.workspace.onDidSaveTextDocument(function () { schedule(DEBOUNCE_MS); }),
    vscode.commands.registerCommand("desko-status.ping", function () { collect(true); })
  );
  wireGit(context);
}

function deactivate() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
}

module.exports = { activate: activate, deactivate: deactivate };
