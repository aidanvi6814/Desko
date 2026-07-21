"""VS Code ingest — POST /api/vscode handler logic (IMPLEMENTATION_PLAN §7.5).

The route is wired in server.py; this module owns validation + state.dev update.
Accepts a JSON body from the bundled VS Code extension and stamps updatedAt.
Always returns 204; never raises (the extension must never be broken by us).
"""
import logging
import time

from aiohttp import web

log = logging.getLogger("desko.vscode")

VALID_KEYS = ("workspace", "branch", "dirty", "ahead", "behind", "changes", "file", "lang", "focused")


def _sanitize_changes(raw) -> list:
    """Keep the changes payload small and well-formed regardless of what the
    extension sends (it's an untrusted LAN POST)."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:12]:
        if isinstance(item, dict):
            out.append({
                "file": str(item.get("file", ""))[:80],
                "status": str(item.get("status", "M"))[:2],
            })
    return out


async def handle_post(request: web.Request) -> web.Response:
    state = request.app["state"]
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    current = request.app["state"].get("dev") or {}
    dev = dict(current)
    for k in VALID_KEYS:
        if k in body:
            dev[k] = body[k]
    if "changes" in dev:
        dev["changes"] = _sanitize_changes(dev["changes"])
    dev.setdefault("workspace", "")
    dev.setdefault("branch", "")
    dev.setdefault("dirty", 0)
    dev.setdefault("ahead", 0)
    dev.setdefault("behind", 0)
    dev.setdefault("changes", [])
    dev.setdefault("file", "")
    dev.setdefault("lang", "")
    dev.setdefault("focused", False)
    dev["updatedAt"] = time.time()
    state.set_section("dev", dev)
    return web.Response(status=204)
