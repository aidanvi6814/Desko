"""Central in-memory state with diffing and WebSocket pub/sub.

Implements the §4 wire protocol: a single State object holds all sections;
set_section deep-compares and broadcasts an ``update`` message only on change;
set_scene broadcasts a ``scene`` message. New ws clients receive a ``snapshot``.
"""
import asyncio
import json
import logging
import queue
import socket
import time
from typing import Any, Optional

log = logging.getLogger("desko.state")

SCENES = ("idle", "music", "stats", "dev", "focus")


def _detect_ip() -> str:
    """Return the best-guess LAN IPv4 (UDP-connect trick, no packets sent)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


class State:
    def __init__(self) -> None:
        import platform
        self._data = {
            "scene": "idle",
            "override": None,
            "locked": False,
            "media": None,
            "lyrics": None,
            "sys": None,
            "weather": None,
            "dev": None,
            "procs": None,
            "focus": None,
            "info": {
                "hostname": platform.node() or "desko",
                "ip": _detect_ip(),
                "startedAt": time.time(),
            },
            "game": None,
            "volume": None,
        }
        self._subs: set = set()
        # Thread-safe queue for commands the media thread should execute
        # (e.g. play/pause/next/prev, seek:<sec>). The HTTP handler pushes; the
        # media thread pops on its own event loop.
        self.media_commands: "queue.Queue[str]" = queue.Queue()
        # Thread-safe queue for the volume thread (set:<0-100>, mute).
        self.volume_commands: "queue.Queue[str]" = queue.Queue()
        # Wall-clock of the last POST /api/vscode, i.e. proof the editor
        # extension is alive. Deliberately NOT a section: it moves on every
        # heartbeat, so putting it in _data would broadcast the whole dev
        # section to the phone every few seconds to say "nothing changed".
        # The git collector reads it to decide when VS Code has gone away.
        self.dev_seen_at: float = 0.0
        # Whether the phone has performance mode (the bolt) switched on. A
        # per-device browser setting, reported over the WebSocket, kept off the
        # broadcast state because it is an input to the server rather than
        # something any client needs told. Last client to speak wins, which is
        # right for the one-phone setup Desko is built for.
        self.perf_mode: bool = False

    # --- accessors ---------------------------------------------------------
    def snapshot(self) -> dict:
        return json.loads(json.dumps(self._data))

    def get(self, section: Optional[str] = None) -> Any:
        return self._data if section is None else self._data.get(section)

    # --- mutations ---------------------------------------------------------
    def set_section(self, name: str, data: Any) -> bool:
        """Set a data section; broadcast ``update`` only if it actually changed."""
        if self._data.get(name) == data:
            return False
        self._data[name] = data
        asyncio.ensure_future(self._broadcast({"type": "update", "section": name, "data": data}))
        return True

    def patch_section(self, name: str, partial: Any) -> bool:
        """Merge a partial update into an existing dict section and broadcast only
        the partial. Used for high-frequency, small changes (e.g. media position
        every second) so large fields like album art aren't re-sent each tick.
        Falls back to set_section when the section isn't a dict. The client also
        merges partials, so omitted fields (art) are preserved on both sides.
        """
        cur = self._data.get(name)
        if isinstance(cur, dict) and isinstance(partial, dict):
            changed = False
            for k, v in partial.items():
                if cur.get(k) != v:
                    cur[k] = v
                    changed = True
            if changed:
                asyncio.ensure_future(
                    self._broadcast({"type": "update", "section": name, "data": partial})
                )
            return changed
        return self.set_section(name, partial)

    def set_scene(self, scene: str, reason: str = "auto", override: Any = None) -> bool:
        """Update scene + override and broadcast a ``scene`` message."""
        scene_changed = self._data.get("scene") != scene
        self._data["scene"] = scene
        self._data["override"] = override
        asyncio.ensure_future(
            self._broadcast({"type": "scene", "scene": scene, "reason": reason, "override": override})
        )
        return scene_changed

    def set_override(self, scene: Optional[str]) -> None:
        """Manual override (scene name) or resume auto (None).

        Deliberately takes no timeout: how long an override survives is the
        rotation engine's business, and it reads ``override_timeout_sec`` from
        config itself (see context.py). An argument here would look
        configurable while changing nothing.
        """
        if scene is None:
            self._data["override"] = None
            # context engine will re-evaluate; for now broadcast clearing override
            asyncio.ensure_future(
                self._broadcast({"type": "scene", "scene": self._data["scene"], "reason": "auto", "override": None})
            )
            return
        self.set_scene(scene, reason="manual", override=scene)

    def cycle_scene(self, direction: int) -> str:
        """Move to the next/prev scene in SCENES order; implies manual override."""
        current = self._data.get("scene", "idle")
        try:
            idx = SCENES.index(current)
        except ValueError:
            idx = SCENES.index("idle")
        new = SCENES[(idx + direction) % len(SCENES)]
        self.set_scene(new, reason="manual", override=new)
        return new

    def request_media_command(self, action: str) -> None:
        """Enqueue a media transport action for the dedicated media thread.

        action ∈ {"play_pause", "next", "prev"}. Returns immediately.
        """
        if action not in ("play_pause", "next", "prev"):
            return
        try:
            self.media_commands.put_nowait(action)
        except Exception:
            pass

    def request_media_seek(self, position_sec: float) -> None:
        """Enqueue a seek to an absolute position (seconds) on the media thread.

        Tapping a synced lyric line jumps the track here. Clamped to >=0; the
        media thread converts to WinRT ticks and calls the GSMTC session.
        """
        try:
            position_sec = max(0.0, float(position_sec))
        except (TypeError, ValueError):
            return
        try:
            self.media_commands.put_nowait(f"seek:{position_sec:.3f}")
        except Exception:
            pass

    def request_volume(self, command: str) -> None:
        """Enqueue a system-volume command for the dedicated volume thread.

        command is ``set:<0-100>`` or ``mute`` (toggle). Returns immediately.
        """
        if not (command == "mute" or command.startswith("set:")):
            return
        try:
            self.volume_commands.put_nowait(command)
        except Exception:
            pass

    def uptime_sec(self) -> float:
        """Seconds since the server started (from state.info.startedAt)."""
        return time.time() - float(self._data.get("info", {}).get("startedAt", time.time()))

    # --- pub/sub -----------------------------------------------------------
    async def subscribe(self, ws) -> None:
        self._subs.add(ws)
        try:
            await ws.send_json({"type": "snapshot", "data": self.snapshot()})
        except Exception:
            self._subs.discard(ws)

    def unsubscribe(self, ws) -> None:
        self._subs.discard(ws)

    async def _broadcast(self, msg: dict) -> None:
        if not self._subs:
            return
        dead = []
        for ws in list(self._subs):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._subs.discard(ws)
