"""aiohttp app: routes, WebSocket handler, collector lifecycle.

Routes (binding per IMPLEMENTATION_PLAN §5):
    GET  /                  -> index.html
    GET  /static/*          -> web/ files
    GET  /manifest.webmanifest
    GET  /ws                -> WebSocket (§4.2 protocol)
    GET  /api/state         -> full snapshot JSON (debug)
    GET  /api/info          -> { hostname, ip, uptime_sec } (system bar)
    POST /api/vscode        -> dev heartbeat ingest (M4)
    POST /api/media/{action} -> transport control (play_pause|next|prev)
"""
import asyncio
import json
import logging
import os
import time

from aiohttp import web

from . import context as context_mod
from . import focus as focus_mod
from .collectors import calendar_ics as calendar_mod
from .collectors import lyrics as lyrics_mod
from .collectors import media as media_mod
from .collectors import sysstats as sysstats_mod
from .collectors import vscode as vscode_mod
from .collectors import weather as weather_mod
from .state import SCENES, State

log = logging.getLogger("desko.server")

WEB_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


def _cors_headers() -> dict:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


def create_app(state: State, config: dict, demo: bool = False) -> web.Application:
    app = web.Application()
    app["state"] = state
    app["config"] = config
    app["demo"] = demo

    app.router.add_get("/", index)
    app.router.add_get("/config", config_page)
    app.router.add_get("/manifest.webmanifest", manifest)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/api/info", api_info)
    app.router.add_get("/api/config", api_config_get)
    app.router.add_post("/api/config", api_config_post)
    app.router.add_post("/api/vscode", vscode_mod.handle_post)
    app.router.add_post("/api/media/{action}", api_media_action)
    app.router.add_static("/static/", WEB_ROOT, show_index=False)

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


# --- routes -----------------------------------------------------------------
async def index(request: web.Request) -> web.Response:
    return web.FileResponse(os.path.join(WEB_ROOT, "index.html"))


async def config_page(request: web.Request) -> web.Response:
    return web.FileResponse(os.path.join(WEB_ROOT, "config.html"))


# Editable via the /config page: (key, json-type, needs-restart-to-apply).
# game_processes takes effect live because the context engine reads the shared
# config dict every tick; everything else is read once at startup.
_CONFIG_FIELDS = {
    "weather_city": (str, True),
    "game_processes": (list, False),
    "calendar_ics_urls": (list, True),
    "focus_work_min": (int, True),
    "focus_break_min": (int, True),
    "port": (int, True),
}


async def api_config_get(request: web.Request) -> web.Response:
    cfg = request.app["config"]
    return web.json_response({k: cfg.get(k) for k in _CONFIG_FIELDS})


async def api_config_post(request: web.Request) -> web.Response:
    cfg: dict = request.app["config"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "expected an object"}, status=400)

    changed, restart = [], []
    for key, (typ, needs_restart) in _CONFIG_FIELDS.items():
        if key not in body:
            continue
        val = body[key]
        if typ is list:
            if not isinstance(val, list):
                continue
            val = [str(x).strip() for x in val if str(x).strip()]
        elif typ is int:
            try:
                val = int(val)
            except (TypeError, ValueError):
                continue
            if key == "port":
                val = max(1, min(65535, val))
            elif key.startswith("focus_"):
                val = max(1, min(180, val))
        elif typ is str:
            val = str(val).strip()
        if cfg.get(key) != val:
            cfg[key] = val
            changed.append(key)
            if needs_restart:
                restart.append(key)

    if changed:
        try:
            cfg_path = os.path.join(os.path.dirname(WEB_ROOT), "config.json")
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
        except OSError as e:
            return web.json_response({"error": f"could not write config.json: {e}"}, status=500)

    return web.json_response({"ok": True, "changed": changed, "restartRequired": restart})


async def manifest(request: web.Request) -> web.Response:
    return web.FileResponse(
        os.path.join(WEB_ROOT, "manifest.webmanifest"),
        headers={"Content-Type": "application/manifest+json; charset=utf-8"},
    )


async def api_state(request: web.Request) -> web.Response:
    return web.json_response(request.app["state"].snapshot())


async def api_info(request: web.Request) -> web.Response:
    state: State = request.app["state"]
    info = state.get("info") or {}
    return web.json_response(
        {
            "hostname": info.get("hostname", "desko"),
            "ip": info.get("ip", "127.0.0.1"),
            "uptime_sec": state.uptime_sec(),
        }
    )


async def api_media_action(request: web.Request) -> web.Response:
    """Transport control for the active media session.

    `action` must be one of `play_pause`, `next`, `prev`. Returns 204.
    CORS-open for LAN convenience; no auth.
    """
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=_cors_headers())
    action = request.match_info.get("action", "")
    if action not in ("play_pause", "next", "prev"):
        return web.json_response({"error": "invalid action"}, status=400, headers=_cors_headers())
    state: State = request.app["state"]
    state.request_media_command(action)
    return web.Response(status=204, headers=_cors_headers())


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=1 << 20)
    await ws.prepare(request)
    state: State = request.app["state"]
    await state.subscribe(ws)
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                await _handle_client_msg(state, ws, msg.data)
            elif msg.type == web.WSMsgType.ERROR:
                log.debug("ws error: %s", ws.exception())
    finally:
        state.unsubscribe(ws)
    return ws


async def _handle_client_msg(state: State, ws, raw: str) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return
    t = msg.get("type")
    if t == "override":
        scene = msg.get("scene")
        if scene is not None and scene not in SCENES:
            return
        state.set_override(scene, 300)
    elif t == "cycle":
        direction = int(msg.get("dir", 1))
        if direction not in (1, -1):
            return
        state.cycle_scene(direction)
    elif t == "lock":
        locked = bool(msg.get("locked"))
        state.set_section("locked", locked)
        if not locked:
            # Unlocking hands control straight back to the context engine —
            # drop any leftover manual override so it doesn't sit there stale.
            state.set_override(None, 0)
    elif t == "focus":
        focus_mod.apply(state, msg)
    elif t == "ping":
        # Latency probe: echo the client timestamp back, plus our own clock so
        # the client can estimate client/server clock skew (see app.js pong
        # handler). Without this, phones with a wrong system clock desync the
        # media position interpolation in music.js (effPos) since it mixes
        # client Date.now() with this server's time.time() timestamps.
        try:
            await ws.send_json({"type": "pong", "t": msg.get("t", 0), "st": time.time()})
        except Exception:
            pass
    # unknown types ignored


# --- lifecycle --------------------------------------------------------------
async def on_startup(app: web.Application) -> None:
    state: State = app["state"]
    config: dict = app["config"]
    demo: bool = app["demo"]

    import aiohttp

    app["http_session"] = aiohttp.ClientSession()

    tasks = []
    if demo:
        from . import demo as demo_mod

        tasks.append(asyncio.create_task(demo_mod.start(state, config, app["http_session"])))
    else:
        # Weather always on (cross-platform, graceful offline).
        tasks.append(asyncio.create_task(weather_mod.start(state, config, app["http_session"])))
        # Remaining collectors are platform/feature dependent; each is responsible
        # for its own graceful degradation (no-op / hide widget on failure).
        tasks.append(asyncio.create_task(media_mod.start(state, config, app["http_session"])))
        tasks.append(asyncio.create_task(lyrics_mod.start(state, config, app["http_session"])))
        tasks.append(asyncio.create_task(sysstats_mod.start(state, config, app["http_session"])))
        tasks.append(asyncio.create_task(calendar_mod.start(state, config, app["http_session"])))
        # Focus (Pomodoro) timer — server-authoritative state + auto phase flow.
        tasks.append(asyncio.create_task(focus_mod.start(state, config)))
        # Context engine drives auto scene switching (fully wired in M5).
        tasks.append(asyncio.create_task(context_mod.start(state, config)))

    app["tasks"] = tasks
    log.info("started %d collector tasks (demo=%s)", len(tasks), demo)


async def on_cleanup(app: web.Application) -> None:
    for t in app.get("tasks", []):
        t.cancel()
    for t in app.get("tasks", []):
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    session = app.get("http_session")
    if session is not None:
        await session.close()
