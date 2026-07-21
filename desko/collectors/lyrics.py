"""Lyrics collector — LRCLIB synced lyrics (IMPLEMENTATION_PLAN §7.2).

On-demand: the media collector calls ``fetch(...)`` when the playing track
changes. Fetches from LRCLIB (free, no key), parses LRC into [seconds, text]
pairs, caches to cache/lyrics/ (including negative results so instrumentals
aren't re-hammered each run), and publishes the ``lyrics`` section.
"""
import hashlib
import json
import logging
import os
import re

log = logging.getLogger("desko.lyrics")

CACHE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "cache",
    "lyrics",
)
LRC_URL = "https://lrclib.net/api/get"
_LRC_RE = re.compile(r"\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]")


def _parse_lrc(text):
    if not text:
        return None
    out = []
    for raw in text.splitlines():
        stamps = list(_LRC_RE.finditer(raw))
        if not stamps:
            continue
        lyric = raw[stamps[-1].end():].strip()
        if not lyric:
            continue
        for m in stamps:
            mm = int(m.group(1))
            ss = int(m.group(2))
            frac = (m.group(3) or "0").ljust(3, "0")[:3]
            t = mm * 60 + ss + int(frac) / 1000.0
            out.append([round(t, 3), lyric])
    out.sort(key=lambda x: x[0])
    return out or None


def _cache_path(track_key: str) -> str:
    h = hashlib.sha1(track_key.encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, h + ".json")


def _load_cache(track_key: str):
    p = _cache_path(track_key)
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def _save_cache(track_key: str, data: dict) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(_cache_path(track_key), "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as e:
        log.debug("cache save failed: %s", e)


async def start(state, config, session) -> None:
    # Lyrics are fetched on-demand by the media collector; no fixed loop here.
    return


async def fetch(state, session, track_key, artist, title, album, duration_sec):
    cached = _load_cache(track_key)
    if cached is not None:
        state.set_section("lyrics", cached)
        return

    try:
        params = {"artist_name": artist, "track_name": title, "album_name": album or ""}
        if duration_sec:
            params["duration"] = str(int(duration_sec))
        async with session.get(LRC_URL, params=params, timeout=10) as r:
            if r.status == 404:
                data = {"trackKey": track_key, "synced": None, "plain": None, "found": False}
                _save_cache(track_key, data)
                state.set_section("lyrics", data)
                return
            if r.status != 200:
                log.debug("lrclib status %s for %r", r.status, track_key)
                return
            j = await r.json()
    except Exception as e:
        log.warning("lrclib fetch failed: %s", e)
        return

    synced = _parse_lrc(j.get("syncedLyrics"))
    plain = j.get("plainLyrics") or None
    found = bool(synced or plain)
    data = {"trackKey": track_key, "synced": synced, "plain": plain, "found": found}
    _save_cache(track_key, data)

    # Only publish if the user hasn't already moved to a different track.
    cur = state.get("media")
    if cur and f"{cur.get('artist', '')}||{cur.get('title', '')}" == track_key:
        state.set_section("lyrics", data)
