"""Scene rotation engine.

Pure carousel: every scene gets equal air time -- ``rotate_sec`` seconds each
(default 60) -- cycling idle -> music -> stats -> dev -> focus -> idle... The
only things that change the visible scene are (1) this rotation timer, (2) a
manual swipe / scene pick (a temporary override), and (3) lock, which freezes
the current scene. Music/game/focus no longer auto-interrupt the rotation (by
request); the old priority engine caused visible flicker (e.g. clock<->workspace
bouncing every few seconds as VS Code focus flickered), which this removes.

Also publishes the ``game`` section whenever the set of running game processes
changes, so the Stats scene header can show the current game's friendly name.
Rotation is evaluated 2x/s; the game scan runs on its own slower clock (see
GAME_SCAN_SEC).
"""
import asyncio
import logging
import time

log = logging.getLogger("desko.context")

# Fixed carousel order. Mirrors state.SCENES; kept local so the rotation order
# is explicit and independent of that tuple's ordering.
ROTATION = ("idle", "music", "stats", "dev", "focus")

# How often to look for a running game. Deliberately NOT the rotation interval:
# _find_running_game walks every process on the box, which is one of the more
# expensive psutil calls on Windows, and running it 2x/s made it the server's
# largest steady-state CPU cost against the <1% idle target. A game starting or
# stopping doesn't need sub-second latency -- it only relabels a header.
GAME_SCAN_SEC = 5.0

# Friendly label map for well-known game processes. The first matching alias
# wins; the rest fall back to the matched .exe name in upper case.
_GAME_ALIASES = {
    "valorant-win64-shipping.exe": "VALORANT",
    "cs2.exe": "COUNTER-STRIKE 2",
    "csgo.exe": "COUNTER-STRIKE: GLOBAL OFFENSIVE",
    "cyberpunk2077.exe": "CYBERPUNK 2077",
    "hl2.exe": "HALF-LIFE 2",
    "dota2.exe": "DOTA 2",
    "league of legends.exe": "LEAGUE OF LEGENDS",
    "r5apex.exe": "APEX LEGENDS",
    "fortnite.exe": "FORTNITE",
    "minecraft.exe": "MINECRAFT",
    "javaw.exe": "MINECRAFT",  # Java edition
    "overwatch.exe": "OVERWATCH 2",
    "wow.exe": "WORLD OF WARCRAFT",
}


def _scene_available(state, name: str) -> bool:
    """Should auto-rotation park on this scene right now?

    Only ``dev`` can answer no, and only when it has no data source at all --
    neither the VS Code extension nor the git fallback (see collectors/git.py).
    Parking a 60s slot on a scene that reads OFFLINE is worse than having one
    fewer scene in the carousel.

    Deliberately consulted ONLY on auto-rotation: a manual swipe or scene pick
    still lands on Dev, because "show me the thing I asked for, even if it's
    empty" is the correct answer to an explicit request.
    """
    if name == "dev":
        dev = state.get("dev")
        return bool(dev) and dev.get("source") is not None
    return True


def _find_running_game(config):
    """Return (matched_exe, friendly_label) or (None, None)."""
    games = {(g or "").lower() for g in config.get("game_processes", []) if g}
    if not games:
        return None, None
    try:
        import psutil

        for p in psutil.process_iter(["name"]):
            n = (p.info.get("name") or "").lower()
            if n in games:
                label = _GAME_ALIASES.get(n, n.upper().replace(".EXE", "").replace("-", " "))
                return n, label
    except Exception:
        pass
    return None, None


async def start(state, config) -> None:
    interval = 0.5
    override_timeout = float(config.get("override_timeout_sec", 300))
    override_set_at = None
    last_game_key = None
    last_game_scan = 0.0  # monotonic; 0 forces a scan on the first tick

    # Carousel position + when we last advanced. Seed the index from whatever
    # scene is showing so the first rotation doesn't jump.
    try:
        rotate_idx = ROTATION.index(state.get("scene"))
    except ValueError:
        rotate_idx = 0
    last_rotate = time.monotonic()

    while True:
        try:
            now_m = time.monotonic()

            # Publish the game section on its own slow clock (set_section diffs
            # so unchanged state doesn't broadcast). Independent of scene logic.
            if now_m - last_game_scan >= GAME_SCAN_SEC:
                last_game_scan = now_m
                matched, label = _find_running_game(config)
                game_payload = (
                    {"matched": matched, "label": label, "updatedAt": time.time()}
                    if matched
                    else None
                )
                game_key = (matched, label)
                if game_key != last_game_key:
                    state.set_section("game", game_payload)
                    last_game_key = game_key

            # Locked = hard freeze: never rotate or switch. Hold the rotate clock
            # so unlocking gives a full rotate_sec on the current scene instead
            # of instantly advancing.
            if state.get("locked"):
                override_set_at = None
                last_rotate = now_m
                await asyncio.sleep(interval)
                continue

            # Manual override (swipe / scene pick) pins a scene until it times
            # out, then rotation resumes from there.
            ov = state.get("override")
            if ov is not None:
                if override_set_at is None:
                    override_set_at = time.time()
                elif time.time() - override_set_at > override_timeout:
                    state.set_override(None)
                    override_set_at = None
                    ov = None
            else:
                override_set_at = None

            if ov is not None:
                # Keep the carousel aligned to the chosen scene and hold the
                # rotate clock so it doesn't lurch forward when the override ends.
                if ov in ROTATION:
                    rotate_idx = ROTATION.index(ov)
                last_rotate = now_m
                desired = ov
            else:
                # Re-read each tick: rotate_sec is editable live from /config
                # (the shared config dict is updated in place on save).
                rotate_sec = max(1.0, float(config.get("rotate_sec", 60)))
                if now_m - last_rotate >= rotate_sec:
                    last_rotate = now_m
                    # Step over unavailable scenes. Bounded by the rotation
                    # length so an all-unavailable carousel (impossible today,
                    # but cheap to guard) can't spin forever.
                    for _ in range(len(ROTATION)):
                        rotate_idx = (rotate_idx + 1) % len(ROTATION)
                        if _scene_available(state, ROTATION[rotate_idx]):
                            break
                desired = ROTATION[rotate_idx]

            if desired != state.get("scene"):
                state.set_scene(desired, reason="rotate", override=ov)
        except Exception as e:
            log.warning("context rotate failed: %s", e)
        await asyncio.sleep(interval)
