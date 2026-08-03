"""Top memory consumers — grouped per application, like Task Manager's list.

WHY THIS IS A THREAD, NOT A COROUTINE
Reading memory for every process means opening a handle to each one. Measured
on a 347-process box: ``process_iter(["name"])`` costs 2ms, but adding
``memory_info`` costs **950ms**, consistently, warm or cold. (WMI's
Win32_Process is worse still at ~1900ms, so there is no cheaper route here.)

950ms of synchronous work on the event loop would stall the WebSocket, the 5/s
media position patches and the lyric highlighting every time it ran, which is
plainly visible on the phone. So the sweep runs on its own thread and drops the
result into a shared dict; a cheap async loop publishes it. Same split as the
LHM thread in sysstats.py.

ADAPTIVE INTERVAL
Even threaded, ~1s of CPU per sweep is not free: at 10s that is ~9.5% of a core
sustained, which would make this the most expensive thing Desko does. So it
sweeps fast only while you are actually looking at the Processes scene, and
backs off to a slow clock otherwise. Memory rankings barely move minute to
minute, so the slow clock costs nothing in usefulness.

NOTHING IS FILTERED. svchost.exe and Memory Compression will usually occupy the
top slots. That is deliberate: this reports what the OS reports.

ICONS are extracted from each executable and cached per name, so the cost is
paid once per app. They are served from /api/proc-icon rather than inlined in
the state payload, so the browser caches them instead of re-receiving a few KB
of base64 on every refresh. Requires Pillow; without it, names are used alone.
"""
import asyncio
import io
import logging
import threading
import time

import psutil

log = logging.getLogger("desko.procs")

TOP_N = 12          # entries kept in the payload (detail scene shows all)
ICON_PX = 32
PUBLISH_SEC = 1.0   # how often the async side checks for a fresh sweep

# name -> PNG bytes (or None once we've tried and failed). Read by the
# /api/proc-icon route in server.py; never keyed by anything user-supplied.
ICON_CACHE: dict = {}
_LABEL_CACHE: dict = {}

_HAS_ICONS = False
try:
    import win32api
    import win32con  # noqa: F401  (imported for completeness of the win32 set)
    import win32gui
    import win32ui
    from PIL import Image

    _HAS_ICONS = True
except Exception:
    pass


def _extract_icon(exe_path: str):
    """An exe's icon as PNG bytes, or None."""
    if not _HAS_ICONS or not exe_path:
        return None
    large = small = ()
    try:
        large, small = win32gui.ExtractIconEx(exe_path, 0)
        handles = list(large) + list(small)
        if not handles:
            return None
        hdc = win32ui.CreateDCFromHandle(win32gui.GetDC(0))
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(hdc, ICON_PX, ICON_PX)
        mem = hdc.CreateCompatibleDC()
        mem.SelectObject(bmp)
        mem.DrawIcon((0, 0), handles[0])
        img = Image.frombuffer(
            "RGBA", (ICON_PX, ICON_PX), bmp.GetBitmapBits(True), "raw", "BGRA", 0, 1
        )
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue()
    except Exception:
        return None
    finally:
        for h in list(large) + list(small):
            try:
                win32gui.DestroyIcon(h)
            except Exception:
                pass


def _friendly(exe_path: str, name: str) -> str:
    """The exe's FileDescription ("Brave Browser") if we can read it, else the
    bare name with .exe stripped. Task Manager shows the description too, and
    "Visual Studio Code" reads far better than "Code.exe" from across a desk."""
    desc = None
    if _HAS_ICONS and exe_path:
        try:
            info = win32api.GetFileVersionInfo(exe_path, "\\VarFileInfo\\Translation")
            if info:
                lang, cp = info[0]
                key = "\\StringFileInfo\\%04X%04X\\FileDescription" % (lang, cp)
                desc = (win32api.GetFileVersionInfo(exe_path, key) or "").strip()
        except Exception:
            desc = None
    if not desc:
        desc = name[:-4] if name.lower().endswith(".exe") else name
        desc = desc[:1].upper() + desc[1:]
    # Generous cap: this is a payload bound, not a display one. The CSS
    # ellipsis does the visual truncation, and cutting at 28 here produced
    # "Host Process for Windows Ser" with no ellipsis to explain it.
    return desc[:40]


def _sweep() -> dict:
    """One full pass. Runs on the worker thread; ~950ms on a busy machine."""
    totals: dict = {}
    for p in psutil.process_iter(["name", "memory_info"]):
        try:
            name = p.info.get("name")
            mi = p.info.get("memory_info")
            if not name or not mi:
                continue
            slot = totals.get(name)
            if slot is None:
                totals[name] = [mi.rss, 1, p.pid]
            else:
                slot[0] += mi.rss
                slot[1] += 1
        except Exception:
            continue  # process died mid-sweep; normal

    ranked = sorted(totals.items(), key=lambda kv: kv[1][0], reverse=True)[:TOP_N]
    total_ram = psutil.virtual_memory().total or 1

    out = []
    for name, (rss, count, pid) in ranked:
        if name not in _LABEL_CACHE:
            exe = ""
            try:
                exe = psutil.Process(pid).exe()
            except Exception:
                exe = ""
            _LABEL_CACHE[name] = _friendly(exe, name)
            if name not in ICON_CACHE:
                ICON_CACHE[name] = _extract_icon(exe)
        out.append({
            "name": name,
            "label": _LABEL_CACHE[name],
            "mb": round(rss / (1024 ** 2), 1),
            "count": count,
            "pct": round(rss / total_ram * 100, 1),
            "icon": bool(ICON_CACHE.get(name)),
        })
    return {"top": out, "totalMb": round(total_ram / (1024 ** 2)), "updatedAt": time.time()}


def _worker(state, config, shared, stop: threading.Event) -> None:
    poll = config.get("poll", {})
    normal_sec = float(poll.get("procs_sec", 10.0))
    perf_sec = float(poll.get("procs_perf_sec", 30.0))
    while not stop.is_set():
        try:
            t0 = time.perf_counter()
            payload = _sweep()
            payload["sweepMs"] = round((time.perf_counter() - t0) * 1000)
            shared["payload"] = payload
        except Exception as e:
            log.warning("process sweep failed: %s", e)
        # Back off while the phone has performance mode (the bolt) on. That
        # switch means "this device is struggling", and fewer sweeps means
        # fewer state updates for it to render as well as less CPU here.
        interval = perf_sec if getattr(state, "perf_mode", False) else normal_sec
        stop.wait(max(2.0, interval))


async def start(state, config, session=None) -> None:
    if not bool(config.get("procs_enabled", True)):
        log.info("process list disabled by config")
        return
    if not _HAS_ICONS:
        log.info("Pillow/pywin32 not available -- process list will show names without icons")

    shared: dict = {"payload": None}
    stop = threading.Event()
    threading.Thread(
        target=_worker, args=(state, config, shared, stop), daemon=True, name="desko-procs"
    ).start()
    try:
        last = None
        while True:
            payload = shared.get("payload")
            if payload is not None and payload is not last:
                last = payload
                state.set_section("procs", payload)
            await asyncio.sleep(PUBLISH_SEC)
    finally:
        stop.set()
