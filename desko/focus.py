"""Focus (Pomodoro) timer -- server-authoritative so every connected device
agrees and the timer survives page reloads / reconnects.

State is broadcast as the ``focus`` section; the client renders a live
countdown from ``endsAt`` (a server epoch, corrected for clock skew the same
way the music position is). Control comes in over the WebSocket as
``{"type":"focus","action":...}`` messages, handled by ``apply``. A tiny async
loop auto-advances work<->break when a phase's time runs out.
"""
import asyncio
import logging
import time

log = logging.getLogger("desko.focus")


def _default(config: dict) -> dict:
    work = int(config.get("focus_work_min", 25))
    brk = int(config.get("focus_break_min", 5))
    return {
        "running": False,
        "mode": "work",              # "work" | "break"
        "workMin": work,
        "breakMin": brk,
        "durationSec": work * 60,    # length of the current phase
        "remainingSec": work * 60,   # authoritative while paused
        "endsAt": None,              # server epoch while running
        "cyclesDone": 0,             # completed work phases
    }


def _phase_len(f: dict, mode: str) -> int:
    return (f["workMin"] if mode == "work" else f["breakMin"]) * 60


def _advance(f: dict, at: float, auto_start: bool) -> None:
    """Move to the next phase. `at` is the moment the previous phase ended
    (pass the old endsAt, not time.time(), so auto-flow doesn't drift)."""
    if f["mode"] == "work":
        f["cyclesDone"] += 1
        f["mode"] = "break"
    else:
        f["mode"] = "work"
    f["durationSec"] = _phase_len(f, f["mode"])
    f["remainingSec"] = f["durationSec"]
    if auto_start:
        f["running"] = True
        f["endsAt"] = at + f["durationSec"]
    else:
        f["running"] = False
        f["endsAt"] = None


def _clamp(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def apply(state, msg: dict) -> None:
    """Handle a focus control message and re-broadcast the section."""
    f = dict(state.get("focus") or {})
    if not f:
        return
    action = msg.get("action")
    now = time.time()
    if action == "start":
        if not f["running"] and f["remainingSec"] > 0:
            f["endsAt"] = now + f["remainingSec"]
            f["running"] = True
    elif action == "pause":
        if f["running"] and f["endsAt"]:
            f["remainingSec"] = max(0, int(round(f["endsAt"] - now)))
            f["running"] = False
            f["endsAt"] = None
    elif action == "reset":
        f["mode"] = "work"
        f["durationSec"] = _phase_len(f, "work")
        f["remainingSec"] = f["durationSec"]
        f["running"] = False
        f["endsAt"] = None
        f["cyclesDone"] = 0
    elif action == "skip":
        _advance(f, now, auto_start=False)
    elif action == "set":
        if "workMin" in msg:
            f["workMin"] = _clamp(msg.get("workMin"), 1, 180, f["workMin"])
        if "breakMin" in msg:
            f["breakMin"] = _clamp(msg.get("breakMin"), 1, 60, f["breakMin"])
        if not f["running"]:
            f["durationSec"] = _phase_len(f, f["mode"])
            f["remainingSec"] = f["durationSec"]
    else:
        return
    state.set_section("focus", f)


async def start(state, config) -> None:
    state.set_section("focus", _default(config))
    while True:
        f = state.get("focus")
        if f and f.get("running") and f.get("endsAt") and time.time() >= f["endsAt"]:
            nf = dict(f)
            _advance(nf, f["endsAt"], auto_start=True)  # auto-flow to next phase
            log.info("focus phase complete -> %s (cycle %d)", nf["mode"], nf["cyclesDone"])
            state.set_section("focus", nf)
        await asyncio.sleep(0.5)
