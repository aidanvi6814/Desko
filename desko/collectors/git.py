"""Git collector — keeps the Dev scene honest and alive without VS Code.

Three jobs:

1. WATCHDOG. The editor extension heartbeats into ``/api/vscode``. When those
   stop -- editor closed, extension disabled, PC asleep -- the ``dev`` section
   would otherwise sit there presenting an hours-old branch as current, with
   nothing on screen admitting it. Past ``vscode_stale_sec`` this collector
   takes the section over and relabels it, so the scene can say where its data
   is actually coming from.

2. FALLBACK. It reads the same facts straight from git, so the Dev scene keeps
   working for repos edited outside VS Code -- and keeps working at all once
   the editor is closed, which is exactly when you're most likely to be looking
   at the dashboard rather than the monitor.

3. TODAY. Commits and lines touched since midnight. The editor extension has no
   cheap way to compute this (the git extension API exposes state, not history),
   and it's the one number on that screen with any sense of progress to it.
   Published on its own slow clock via ``patch_section`` so it rides along
   whichever source is active.

WHICH REPO? Whatever the extension last reported as the workspace path, so in
the normal case this needs no configuration at all: open a folder in VS Code
once and Desko remembers which repo to watch after you close it.
``git_repo_path`` in config.json overrides that.

COST. ``git`` is a subprocess, which is not free, so the full read only runs
when VS Code is NOT reporting (there's nothing to add while the extension is
live and faster), and the today-totals run once a minute. On Windows every
child is spawned with CREATE_NO_WINDOW -- without it each poll flashes a
console window over whatever is fullscreen.
"""
import asyncio
import logging
import os
import time

log = logging.getLogger("desko.git")

# Liveness is checked on this clock; the expensive reads have their own.
WATCH_SEC = 2.0
# Today's totals walk the day's commits — worth a minute of staleness.
TODAY_SEC = 60.0
# Match the extension's cap so the panel looks the same from either source.
MAX_CHANGES = 8
# git that hangs (network remote, index.lock contention) must not wedge the loop.
GIT_TIMEOUT = 5.0

_NO_WINDOW = {"creationflags": 0x08000000} if os.name == "nt" else {}

# porcelain=v2 XY status pair -> the single letter the Changes panel shows.
_STATUS_ORDER = ("U", "A", "D", "R", "C", "M")


async def _run(args, cwd):
    """Run `git <args>` in cwd; stdout text, or None on any failure."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            **_NO_WINDOW,
        )
    except (OSError, ValueError, NotImplementedError):
        return None  # git not installed, or cwd vanished
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), GIT_TIMEOUT)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return None
    if proc.returncode != 0:
        return None
    return out.decode("utf-8", "replace")


def _letter(xy: str) -> str:
    """porcelain-v2 gives a staged+worktree pair like '.M' or 'MM'."""
    for c in _STATUS_ORDER:
        if c in xy:
            return c
    return "M"


def _base(p: str) -> str:
    p = p.strip().strip('"')
    return p.replace("\\", "/").rsplit("/", 1)[-1] or p


def _parse_status(text: str) -> dict:
    """Parse `git status --porcelain=v2 --branch`."""
    branch, ahead, behind, dirty = "", 0, 0, 0
    changes = []
    for line in text.splitlines():
        if line.startswith("# branch.head "):
            head = line[len("# branch.head "):].strip()
            branch = "" if head == "(detached)" else head
        elif line.startswith("# branch.oid ") and not branch:
            pass
        elif line.startswith("# branch.ab "):
            for tok in line[len("# branch.ab "):].split():
                try:
                    if tok.startswith("+"):
                        ahead = int(tok[1:])
                    elif tok.startswith("-"):
                        behind = int(tok[1:])
                except ValueError:
                    pass
        elif line[:2] in ("1 ", "2 "):
            # 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            # 2 <XY> ... <path><TAB><origPath>   (rename/copy)
            dirty += 1
            parts = line.split(" ", 8)
            if len(parts) < 9:
                continue
            path = parts[8].split("\t", 1)[0]
            if len(changes) < MAX_CHANGES:
                changes.append({"file": _base(path), "status": _letter(parts[1])})
        elif line.startswith("u "):
            dirty += 1
            parts = line.split(" ", 10)
            if len(changes) < MAX_CHANGES and len(parts) >= 11:
                changes.append({"file": _base(parts[10]), "status": "U"})
        elif line.startswith("? "):
            dirty += 1
            if len(changes) < MAX_CHANGES:
                changes.append({"file": _base(line[2:]), "status": "?"})
    return {
        "branch": branch, "ahead": ahead, "behind": behind,
        "dirty": dirty, "changes": changes,
    }


def _sum_numstat(text: str):
    """Sum `git ... --numstat` output. Binary files report '-' and are skipped."""
    added = removed = 0
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        try:
            added += int(parts[0])
            removed += int(parts[1])
        except ValueError:
            continue
    return added, removed


async def _read_today(repo: str):
    """Commits since midnight, plus lines touched today.

    "Lines touched" deliberately means commits-since-midnight PLUS whatever is
    currently uncommitted -- work you haven't committed yet is still work you
    did today, and a number that only moved on commit would read as zero for
    most of the day.
    """
    count_out = await _run(["rev-list", "--count", "--since=midnight", "HEAD"], repo)
    if count_out is None:
        return None  # no commits yet, or not a repo
    try:
        commits = int(count_out.strip() or 0)
    except ValueError:
        commits = 0

    added = removed = 0
    logged = await _run(["log", "--since=midnight", "--numstat", "--format="], repo)
    if logged:
        a, r = _sum_numstat(logged)
        added += a
        removed += r
    working = await _run(["diff", "--numstat", "HEAD"], repo)
    if working:
        a, r = _sum_numstat(working)
        added += a
        removed += r
    return {"commits": commits, "added": added, "removed": removed}


async def _read_repo(repo: str):
    """Full dev-section payload read from git, or None if this isn't a repo."""
    status = await _run(["status", "--porcelain=v2", "--branch"], repo)
    if status is None:
        return None
    data = _parse_status(status)

    commit = None
    # \x1f (unit separator) can't appear in a commit subject, unlike anything
    # printable we might otherwise delimit on.
    log_out = await _run(["log", "-1", "--format=%h%x1f%s%x1f%ct"], repo)
    if log_out:
        bits = log_out.strip().split("\x1f")
        if len(bits) == 3:
            try:
                at = float(bits[2])
            except ValueError:
                at = 0.0
            commit = {"hash": bits[0][:12], "subject": bits[1][:90], "at": at}

    data["commit"] = commit
    data["workspace"] = os.path.basename(os.path.normpath(repo)) or repo
    data["path"] = repo[:120]
    # The editor-only fields: blank rather than stale. Showing the file that
    # happened to be open when VS Code closed would be a small lie that looks
    # exactly like a true reading.
    data["file"] = ""
    data["lang"] = ""
    data["line"] = 0
    data["col"] = 0
    data["eol"] = ""
    data["focused"] = False
    return data


def _repo_path(state, config):
    """Explicit config wins; otherwise follow whatever VS Code last opened."""
    explicit = str(config.get("git_repo_path") or "").strip()
    if explicit:
        return explicit if os.path.isdir(explicit) else None
    dev = state.get("dev") or {}
    remembered = str(dev.get("path") or "").strip()
    if remembered and os.path.isdir(remembered):
        return remembered
    return None


def _meaningful(d: dict) -> dict:
    return {k: v for k, v in d.items() if k not in ("updatedAt", "today")}


async def start(state, config, session=None) -> None:
    interval = float(config.get("poll", {}).get("git_sec", 10.0))
    stale_sec = float(config.get("vscode_stale_sec", 45))
    today = None
    last_read = 0.0
    last_today = 0.0

    while True:
        try:
            repo = _repo_path(state, config)
            vscode_live = (time.time() - state.dev_seen_at) <= stale_sec
            now_m = time.monotonic()

            if repo and now_m - last_today >= TODAY_SEC:
                last_today = now_m
                fresh = await _read_today(repo)
                if fresh is not None:
                    today = fresh
                    if state.get("dev"):
                        state.patch_section("dev", {"today": today})

            if vscode_live:
                await asyncio.sleep(WATCH_SEC)
                continue

            if repo and now_m - last_read >= interval:
                last_read = now_m
                data = await _read_repo(repo)
                if data:
                    data["source"] = "git"
                    if today is not None:
                        data["today"] = today
                    current = state.get("dev") or {}
                    if _meaningful(data) != _meaningful(current):
                        data["updatedAt"] = time.time()
                        state.set_section("dev", data)
            elif not repo:
                # Nothing to fall back to. Say so rather than leaving the last
                # known branch on screen looking live; source=None is what the
                # frontend renders as OFFLINE and what the rotation engine
                # reads to skip the scene entirely.
                current = state.get("dev")
                if current and current.get("source") is not None:
                    dead = dict(current)
                    dead["source"] = None
                    dead["focused"] = False
                    dead["updatedAt"] = time.time()
                    state.set_section("dev", dead)
        except Exception as e:
            log.warning("git collector tick failed: %s", e)
        await asyncio.sleep(WATCH_SEC)
