"""Media collector — Windows GSMTC now-playing (IMPLEMENTATION_PLAN §7.1).

Reads the current GlobalSystem Media Transport Controls session (browser YouTube
Music, Spotify, Edge, Brave, ...). Publishes a full ``media`` section on track /
art / play-state change, and a small ``patch_section`` for position when the
playhead has moved enough to matter (so the karaoke highlight + progress bar
feel tight on the phone without re-sending album art each tick).

Also services transport commands (play/pause/next/prev) pushed by the HTTP
layer via ``state.request_media_command`` — the commands run on this same
dedicated thread because the GSMTC session APIs are WinRT and must share the
WinRT apartment this thread owns.

IMPORTANT: GSMTC async operations hang when awaited on an event loop shared
with other coroutines (COM apartment / completion-marshalling quirk in
Python-WinRT). So this collector runs its poll loop on a DEDICATED THREAD with
its OWN event loop, and marshals every state update back onto the server's
main loop via ``loop.call_soon_threadsafe`` /
``asyncio.run_coroutine_threadsafe``. This is the standard pattern for mixing
WinRT/COM with asyncio and is what makes music detection reliable alongside
the other collectors.

ART CACHE: GSMTC updates a player's track title and its thumbnail reference
as two separate internal steps rather than atomically. After auto-advance, the
first 1–3 reads can return the PREVIOUS track's thumbnail (or empty). The
fix is ``ART_CACHE``: we never trust a thumbnail for a trackKey until we've
seen the same art for at least two consecutive reads, and after any track
change we ignore the cache and keep re-reading the thumbnail for a short
settle window so the correct (new-track) image is eventually picked up.
"""
import asyncio
import base64
import logging
import threading
import time
from collections import OrderedDict

log = logging.getLogger("desko.media")

_HAS = False
try:
    from winsdk.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as _Mgr,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as _Status,
    )
    from winsdk.windows.storage.streams import DataReader as _DataReader

    _HAS = True
except ImportError:
    pass

ART_CAP = 200000  # bytes; skip larger thumbnails. Some YT Music tracks ship ~100-180KB.

# Position patch cadence: publish a small position update when the playhead has
# moved this many seconds, or immediately on a play/pause/seek jump. ~0.2s gives
# the client a fresh anchor often enough that the karaoke highlight feels
# frame-accurate, without flooding the WebSocket.
PATCH_STEP_SEC = 0.2
JUMP_THRESHOLD_SEC = 0.4

# How long to ignore the art cache and keep reading the thumbnail after a
# track change. GSMTC's thumbnail handoff is the dominant race; ~6s gives it
# plenty of room to settle.
ART_SETTLE_SEC = 6.0
# How many consecutive identical reads are required to "lock in" a track's
# art into ART_CACHE. 2 is enough to ignore the transient old-art race.
ART_LOCK_IN_RUNS = 2

# Both caches are bounded LRU maps so an always-on display doesn't accumulate
# every track ever played (each art data-URL is up to ART_CAP bytes). Oldest
# entries are evicted past ART_CACHE_MAX.
ART_CACHE_MAX = 256
# trackKey -> artDataUrl. Only contains entries we've confirmed stable.
ART_CACHE: "OrderedDict[str, str]" = OrderedDict()
# trackKey -> [last_seen_art, consecutive_identical_count]. Drives the
# stabilization that ignores GSMTC's transient wrong/empty thumbnails right
# after a track change.
ART_SEEN: "OrderedDict[str, list]" = OrderedDict()


def _lru_put(d: "OrderedDict", key, value, cap: int) -> None:
    d[key] = value
    d.move_to_end(key)
    while len(d) > cap:
        d.popitem(last=False)


from . import lyrics as lyrics_mod


def _pick_session(mgr):
    sessions = mgr.get_sessions()
    n = sessions.size
    if n == 0:
        return None
    for i in range(n):
        s = sessions.get_at(i)
        try:
            if int(s.get_playback_info().playback_status) == int(_Status.PLAYING):
                return s
        except Exception:
            continue
    try:
        cur = mgr.get_current_session()
        if cur is not None:
            return cur
    except Exception:
        pass
    return sessions.get_at(0)


async def _read_thumbnail(ref) -> str:
    if ref is None:
        return ""
    try:
        stream = await ref.open_read_async()
        size = int(stream.size)
        if size <= 0 or size > ART_CAP:
            return ""
        reader = _DataReader(stream)
        loaded = await reader.load_async(size)
        if loaded < size:
            return ""
        b = bytearray(size)
        reader.read_bytes(b)
        mime = "image/jpeg"
        try:
            ct = stream.content_type
            if ct:
                mime = ct
        except Exception:
            pass
        return "data:" + mime + ";base64," + base64.b64encode(bytes(b)).decode("ascii")
    except Exception as e:
        log.debug("thumbnail read failed: %s", e)
        return ""


def _total_seconds(ts) -> float:
    try:
        return float(ts.total_seconds())
    except Exception:
        return 0.0


async def _read(mgr, force_art: bool = False) -> dict | None:
    """Read current media state. If `force_art` is True, always re-read the
    thumbnail (used during the post-track-change settle window so GSMTC's
    slow thumbnail handoff is eventually picked up). Otherwise the cached
    art is used when available."""
    sess = _pick_session(mgr)
    if sess is None:
        return None
    props = await sess.try_get_media_properties_async()
    title = props.title or ""
    artist = props.artist or ""
    album = props.album_title or ""
    track_key = f"{artist}||{title}"

    cached = ART_CACHE.get(track_key)
    if cached is not None and not force_art:
        art = cached
        ART_CACHE.move_to_end(track_key)  # LRU touch
    else:
        art = await _read_thumbnail(props.thumbnail)
        # Stabilization: only lock art into ART_CACHE after seeing the same
        # non-empty image ART_LOCK_IN_RUNS times in a row for this trackKey.
        # While the settle window is open we re-read every tick, so "same twice"
        # only happens once GSMTC has actually settled on the correct image --
        # the transient wrong/empty first read never gets locked in.
        rec = ART_SEEN.get(track_key)
        if art and rec is not None and rec[0] == art:
            rec[1] += 1
            ART_SEEN.move_to_end(track_key)
            if rec[1] >= ART_LOCK_IN_RUNS:
                _lru_put(ART_CACHE, track_key, art, ART_CACHE_MAX)
        else:
            _lru_put(ART_SEEN, track_key, [art, 1 if art else 0], ART_CACHE_MAX)

    info = sess.get_playback_info()
    playing = int(info.playback_status) == int(_Status.PLAYING)
    tl = sess.get_timeline_properties()
    pos = _total_seconds(tl.position)
    dur = _total_seconds(tl.end_time)
    try:
        source = sess.source_app_user_model_id or ""
    except Exception:
        source = ""
    return {
        "playing": playing,
        "title": title,
        "artist": artist,
        "album": album,
        "artDataUrl": art,
        "positionSec": pos,
        "durationSec": dur,
        "sourceApp": source,
        "updatedAt": time.time(),
        "trackKey": track_key,
    }


async def _execute_command(sess, action: str) -> None:
    """Run one transport command on the GSMTC session. Same thread/loop."""
    try:
        if action == "play_pause":
            await sess.try_toggle_play_pause_async()
        elif action == "next":
            await sess.try_skip_next_async()
        elif action == "prev":
            await sess.try_skip_previous_async()
    except Exception as e:
        log.debug("media command %r failed: %r", action, e)


# --- thread-isolated poll loop ------------------------------------------------
def _thread_main(state, config, session, main_loop, stop: threading.Event) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_poll_loop(state, config, session, main_loop, stop))
    except Exception as e:
        log.warning("media thread exited: %r", e)
    finally:
        try:
            loop.close()
        except Exception:
            pass


async def _poll_loop(state, config, session, main_loop, stop: threading.Event) -> None:
    interval = float(config.get("poll", {}).get("media_sec", 1.0))
    mgr = None
    last_track_key = None
    last_art = "__init__"
    last_playing = None
    last_pos_pub: float | None = None
    no_session_since = None
    lyrics_in_flight = None
    errored = False
    # Monotonic deadline while we keep ignoring the art cache and re-reading
    # the thumbnail on every tick. Set to "now + ART_SETTLE_SEC" on every
    # track change, and on a transport command (next/prev).
    art_force_until = 0.0

    def publish(fn, *args):
        try:
            main_loop.call_soon_threadsafe(fn, *args)
        except Exception:
            pass

    while not stop.is_set():
        # 1) Drain any pending transport commands (play/pause/next/prev).
        cmd_actions = []
        try:
            while True:
                cmd_actions.append(state.media_commands.get_nowait())
        except Exception:
            pass

        force_art = time.monotonic() < art_force_until
        media = None
        try:
            if mgr is None:
                mgr = await _Mgr.request_async()
            media = await _read(mgr, force_art=force_art)
            if errored:
                errored = False
        except Exception as e:
            mgr = None
            if not errored:
                log.warning("media read error (will keep retrying): %r", e)
                errored = True
            else:
                log.debug("media read error: %r", e)

        if media is not None:
            no_session_since = None
            track_key = media["trackKey"]
            art = media["artDataUrl"]
            track_changed = track_key != last_track_key
            full = (
                track_changed
                or art != last_art
                or media["playing"] != last_playing
            )
            if track_changed:
                # Re-read the thumbnail for a few seconds. Also clear any
                # pending stabilization count for this key.
                art_force_until = time.monotonic() + ART_SETTLE_SEC
                ART_SEEN.pop(track_key, None)
                ART_CACHE.pop(track_key, None)
            if full:
                last_track_key = track_key
                last_art = art
                last_playing = media["playing"]
                last_pos_pub = media["positionSec"]
                pub = {k: v for k, v in media.items() if k != "trackKey"}
                publish(state.set_section, "media", pub)
                if lyrics_in_flight is None or lyrics_in_flight.done():
                    lyrics_in_flight = asyncio.run_coroutine_threadsafe(
                        lyrics_mod.fetch(
                            state, session, track_key,
                            media["artist"], media["title"], media["album"], media["durationSec"],
                        ),
                        main_loop,
                    )
            else:
                # Tight, non-flooding position update.
                pos = media["positionSec"]
                jump = (
                    last_pos_pub is not None
                    and abs(pos - last_pos_pub) >= JUMP_THRESHOLD_SEC
                )
                if last_pos_pub is None or jump or abs(pos - last_pos_pub) >= PATCH_STEP_SEC:
                    last_pos_pub = pos
                    publish(
                        state.patch_section,
                        "media",
                        {
                            "positionSec": pos,
                            "updatedAt": media["updatedAt"],
                            "playing": media["playing"],
                        },
                    )

            # 2) Run any transport commands on the same session.
            if cmd_actions:
                sess = _pick_session(mgr)
                if sess is not None:
                    for action in cmd_actions:
                        await _execute_command(sess, action)
                    # Force a fresh art read after a transport command (next/prev
                    # almost always changes track). Open the settle window too
                    # in case the GSMTC thumbnail hasn't caught up yet.
                    art_force_until = time.monotonic() + ART_SETTLE_SEC
                    try:
                        media2 = await _read(mgr, force_art=True)
                    except Exception:
                        media2 = None
                    if media2 is not None:
                        tk2 = media2["trackKey"]
                        full2 = (
                            tk2 != last_track_key
                            or media2["artDataUrl"] != last_art
                            or media2["playing"] != last_playing
                        )
                        if tk2 != last_track_key:
                            art_force_until = time.monotonic() + ART_SETTLE_SEC
                            ART_SEEN.pop(tk2, None)
                            ART_CACHE.pop(tk2, None)
                        if full2:
                            last_track_key = tk2
                            last_art = media2["artDataUrl"]
                            last_playing = media2["playing"]
                            last_pos_pub = media2["positionSec"]
                            pub2 = {k: v for k, v in media2.items() if k != "trackKey"}
                            publish(state.set_section, "media", pub2)
                            if lyrics_in_flight is None or lyrics_in_flight.done():
                                lyrics_in_flight = asyncio.run_coroutine_threadsafe(
                                    lyrics_mod.fetch(
                                        state, session, tk2,
                                        media2["artist"], media2["title"], media2["album"],
                                        media2["durationSec"],
                                    ),
                                    main_loop,
                                )
                        else:
                            last_pos_pub = media2["positionSec"]
                            publish(
                                state.patch_section,
                                "media",
                                {
                                    "positionSec": media2["positionSec"],
                                    "updatedAt": media2["updatedAt"],
                                    "playing": media2["playing"],
                                },
                            )
        else:
            if no_session_since is None:
                no_session_since = time.time()
            elif time.time() - no_session_since > 10:
                if state.get("media") is not None:
                    publish(state.set_section, "media", None)
                last_track_key = None
                last_art = "__init__"
                last_pos_pub = None
                last_playing = None

        await asyncio.sleep(interval)


async def start(state, config, session) -> None:
    if not _HAS:
        log.info("winsdk not available -- media collector disabled")
        return
    main_loop = asyncio.get_running_loop()
    stop = threading.Event()

    def spawn() -> threading.Thread:
        t = threading.Thread(
            target=_thread_main,
            args=(state, config, session, main_loop, stop),
            daemon=True,
            name="desko-media",
        )
        t.start()
        return t

    thread = spawn()
    log.info("media collector started (dedicated thread)")
    restarts = 0
    try:
        # Supervise the worker: if the GSMTC/WinRT thread ever dies (a WinRT
        # hiccup, a driver reset, etc.) respawn it with a small backoff instead
        # of losing music detection until the whole server restarts.
        while not stop.is_set():
            await asyncio.sleep(1.0)
            if not thread.is_alive() and not stop.is_set():
                restarts += 1
                backoff = min(2.0 + restarts, 10.0)
                log.warning("media thread died -- restarting in %.0fs (#%d)", backoff, restarts)
                await asyncio.sleep(backoff)
                if not stop.is_set():
                    thread = spawn()
    finally:
        stop.set()
