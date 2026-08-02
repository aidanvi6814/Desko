"""VS Code ingest — POST /api/vscode handler logic (IMPLEMENTATION_PLAN §7.5).

The route is wired in server.py; this module owns validation + state.dev update.
Accepts a JSON body from the bundled VS Code extension. Always returns 204;
never raises (the extension must never be broken by us).

TWO THINGS WORTH KNOWING:

1. ``updatedAt`` is stamped only when the payload actually CHANGED. The
   extension heartbeats every 15s to prove it's alive, and stamping the time on
   every heartbeat made ``set_section`` see a difference each time -- which
   pushed the whole dev section down the WebSocket 4x/min to tell the phone
   nothing had happened. Liveness lives in ``state.dev_seen_at`` instead, off
   the wire entirely, and the git collector watches that.

2. Every incoming string is length-capped and every number coerced. This is an
   unauthenticated LAN POST whose contents are broadcast verbatim to the phone,
   so an unbounded ``branch`` would be a megabyte of WebSocket traffic and a
   string in ``dirty`` would break the frontend's arithmetic.
"""
import logging
import time

from aiohttp import web

log = logging.getLogger("desko.vscode")

# key -> max length. Anything longer is truncated, not rejected: a too-long
# path is still worth showing the tail of.
_STR_KEYS = {
    "workspace": 60,
    "path": 120,
    "branch": 60,
    "file": 80,
    "lang": 24,
    "eol": 4,
}
_INT_KEYS = ("dirty", "ahead", "behind", "line", "col")

MAX_CHANGES = 12


def _clean_str(v, cap: int) -> str:
    try:
        return str(v)[:cap]
    except Exception:
        return ""


def _clean_int(v) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    # Clamp rather than pass through: these drive layout (badge widths, line
    # numbers) and a 20-digit number would blow the panel apart.
    return max(0, min(n, 999999))


def _sanitize_changes(raw) -> list:
    """Keep the changes payload small and well-formed regardless of what the
    extension sends (it's an untrusted LAN POST)."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:MAX_CHANGES]:
        if isinstance(item, dict):
            out.append({
                "file": _clean_str(item.get("file", ""), 80),
                "status": _clean_str(item.get("status", "M"), 2),
            })
    return out


def _sanitize_commit(raw):
    """Last-commit block: {hash, subject, at}. None when absent/malformed."""
    if not isinstance(raw, dict):
        return None
    subject = _clean_str(raw.get("subject", ""), 90)
    hash_ = _clean_str(raw.get("hash", ""), 12)
    if not hash_ and not subject:
        return None
    try:
        at = float(raw.get("at") or 0)
    except (TypeError, ValueError):
        at = 0.0
    return {"hash": hash_, "subject": subject, "at": at}


async def handle_post(request: web.Request) -> web.Response:
    state = request.app["state"]
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    # Liveness first, and unconditionally: even a payload we end up discarding
    # as unchanged still proves the editor is running.
    state.dev_seen_at = time.time()

    current = state.get("dev") or {}
    dev = dict(current)

    for k, cap in _STR_KEYS.items():
        if k in body:
            dev[k] = _clean_str(body[k], cap)
    for k in _INT_KEYS:
        if k in body:
            dev[k] = _clean_int(body[k])
    if "changes" in body:
        dev["changes"] = _sanitize_changes(body["changes"])
    if "commit" in body:
        dev["commit"] = _sanitize_commit(body["commit"])
    if "focused" in body:
        dev["focused"] = bool(body["focused"])

    dev.setdefault("workspace", "")
    dev.setdefault("path", "")
    dev.setdefault("branch", "")
    dev.setdefault("dirty", 0)
    dev.setdefault("ahead", 0)
    dev.setdefault("behind", 0)
    dev.setdefault("changes", [])
    dev.setdefault("file", "")
    dev.setdefault("lang", "")
    dev.setdefault("line", 0)
    dev.setdefault("col", 0)
    dev.setdefault("eol", "")
    dev.setdefault("commit", None)
    dev.setdefault("focused", False)

    # Claim the section back from the git fallback. This field is also the
    # frontend's liveness signal -- it can't use updatedAt for that any more,
    # since that only moves on real change now.
    dev["source"] = "vscode"

    if _meaningful(dev) != _meaningful(current):
        dev["updatedAt"] = time.time()
        state.set_section("dev", dev)
    return web.Response(status=204)


def _meaningful(d: dict) -> dict:
    """The part of a dev section worth broadcasting a change for.

    ``updatedAt`` is excluded because it's derived, and ``today`` because the
    git collector owns it -- comparing it here would make every heartbeat look
    like a change on the tick after git refreshed the day's totals.
    """
    return {k: v for k, v in d.items() if k not in ("updatedAt", "today")}
