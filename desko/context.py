"""Scene priority engine (IMPLEMENTATION_PLAN §4.3).

Priority (highest wins): music > stats (game running) > dev (VS Code fresh+focused)
> idle. A manual override always wins until cleared or override_timeout_sec elapses.
Hysteresis: a lower-priority candidate must win 2 consecutive evaluations before
the scene actually switches (prevents flicker when a song ends). Evaluated 2x/s.

Also publishes the ``game`` section whenever the set of running game processes
changes, so the Stats scene header can show the current game's friendly name.
"""
import asyncio
import logging
import time

log = logging.getLogger("desko.context")

# Lower wins. A running focus timer is the strongest auto signal (you asked
# for it), then music > game > dev > idle. `calendar` is manual-only (never
# returned by evaluate()); it falls back to the default rank for hysteresis.
PRIORITY = {"focus": 0, "music": 1, "stats": 2, "dev": 3, "idle": 4}

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


def _running_games(config) -> bool:
    matched, _ = _find_running_game(config)
    return matched is not None


def evaluate(state, config) -> str:
    """Return the desired scene based on current state (ignores override)."""
    focus = state.get("focus")
    if focus and focus.get("running"):
        return "focus"
    media = state.get("media")
    if (
        media
        and media.get("playing")
        and media.get("updatedAt")
        and time.time() - media["updatedAt"] < 10
    ):
        return "music"
    if _running_games(config):
        return "stats"
    dev = state.get("dev")
    stale = float(config.get("vscode_stale_sec", 45))
    if (
        dev
        and dev.get("updatedAt")
        and time.time() - dev["updatedAt"] < stale
        and dev.get("focused")
    ):
        return "dev"
    return "idle"


async def start(state, config) -> None:
    interval = 0.5
    override_timeout = float(config.get("override_timeout_sec", 300))
    pending = None
    pending_count = 0
    override_set_at = None
    last_game_key = None

    while True:
        try:
            # Publish the game section (cheap, low frequency; set_section
            # diffs so unchanged state doesn't broadcast).
            matched, label = _find_running_game(config)
            if matched:
                game_payload = {"matched": matched, "label": label, "updatedAt": time.time()}
            else:
                game_payload = None
            game_key = (matched, label)
            if game_key != last_game_key:
                state.set_section("game", game_payload)
                last_game_key = game_key

            # Hard freeze: skip scene selection entirely while locked, so the
            # visible scene never changes on its own (and any leftover manual
            # override just sits inert — no timeout logic needed while locked
            # since we never reach it below).
            if state.get("locked"):
                pending = None
                pending_count = 0
                override_set_at = None
                await asyncio.sleep(interval)
                continue

            ov = state.get("override")
            if ov is not None:
                if override_set_at is None:
                    override_set_at = time.time()
                elif time.time() - override_set_at > override_timeout:
                    state.set_override(None, override_timeout)
                    override_set_at = None
                    ov = None
            else:
                override_set_at = None

            if ov is not None:
                desired = ov
            else:
                desired = evaluate(state, config)

            current = state.get("scene")
            if desired != current:
                # Manual overrides (incl. calendar/focus) switch immediately;
                # hysteresis only exists to stop auto-downgrade flicker (e.g. a
                # song ending for a moment), which shouldn't delay a deliberate
                # user selection.
                is_downgrade = ov is None and PRIORITY.get(desired, 9) > PRIORITY.get(current, 9)
                if is_downgrade:
                    if pending == desired:
                        pending_count += 1
                    else:
                        pending = desired
                        pending_count = 1
                    if pending_count >= 2:
                        state.set_scene(desired, reason="auto", override=ov)
                        pending = None
                        pending_count = 0
                else:
                    state.set_scene(desired, reason="auto", override=ov)
                    pending = None
                    pending_count = 0
        except Exception as e:
            log.warning("context eval failed: %s", e)
        await asyncio.sleep(interval)
