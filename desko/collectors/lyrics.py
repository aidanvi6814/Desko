"""Lyrics collector — provider chain with LRCLIB first (IMPLEMENTATION_PLAN §7.2).

On-demand: the media collector calls ``fetch(...)`` when the playing track
changes. Sources are tried in order and the first hit wins:

  1. ``cache/lyrics/manual/<slug>.lrc`` — a file you dropped in yourself.
     Always wins, never cached, so editing it takes effect on the next track
     change. Slug is ``artist-title`` (or just ``title``), lowercased with
     every run of non-alphanumerics collapsed to ``-``. ``.txt`` is accepted
     for unsynced lyrics.
  2. LRCLIB ``/api/get`` (exact match) — tried once per query *variant*, since
     GSMTC hands us whatever the browser tab is called: "Song (Official Video)",
     "Artist - Topic", "Song [Lyrics]" and so on all miss an exact lookup.
  3. LRCLIB ``/api/search`` (substring) — same catalogue, far looser matching,
     and it still returns *synced* lyrics. This is where most recovered tracks
     actually come from.
  4. lyrics.ovh — an independent catalogue, so it survives an LRCLIB outage.
     Plain text only (no timestamps), so it's a genuine last resort: the UI
     falls back to the centred unsynced rendering.

NetEase Cloud Music would be the better #4 — it has synced LRC and deep
non-Western coverage — but music.163.com (and c.y.qq.com) are DNS-hijacked to
a sinkhole on Indian ISPs and the TLS handshake is reset, so it can never
answer from this network. Left out deliberately rather than as an oversight.

Results are cached to cache/lyrics/ including negative ones, so instrumentals
aren't re-hammered every run. A *transient* failure (timeout, 5xx) is never
cached — an outage must not get baked in as "no lyrics".
"""
import hashlib
import json
import logging
import os
import re
from urllib.parse import quote

log = logging.getLogger("desko.lyrics")

CACHE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "cache",
    "lyrics",
)
MANUAL_DIR = os.path.join(CACHE_DIR, "manual")

LRC_GET_URL = "https://lrclib.net/api/get"
LRC_SEARCH_URL = "https://lrclib.net/api/search"
OVH_URL = "https://api.lyrics.ovh/v1"

# A candidate whose length differs from what's playing by more than this is a
# different recording (live version, edit, wrong song entirely), so reject it
# rather than show lyrics that drift further out of sync every line.
DURATION_TOL_SEC = 10.0

_LRC_RE = re.compile(r"\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]")

# LRCLIB asks API users to identify themselves; a UA also avoids some generic
# bot/rate-limit rejections.
_HEADERS = {"User-Agent": "Desko desk dashboard (https://github.com/)"}

# Returned by a provider that failed in a way worth retrying (network, 5xx),
# as distinct from None which means "this provider genuinely has no lyrics".
_TRANSIENT = object()


# --- LRC parsing -------------------------------------------------------------

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


# --- Query cleanup -----------------------------------------------------------
# GSMTC reports whatever the source app calls the track. Browser YouTube Music
# is the worst offender: the tab title becomes the "song", so an exact LRCLIB
# lookup misses on decoration that isn't part of the song's name at all.

# Bracketed groups that are packaging, not title: "(Official Video)",
# "[Lyrics]", "(Remastered 2011)", "(4K)". A group is only dropped when it
# contains one of these words, so "(feat. X)" and "(From \"Dangal\")" survive.
_JUNK_IN_BRACKETS = (
    "official", "lyric", "lyrics", "audio", "video", "visualizer", "visualiser",
    "hd", "hq", "4k", "mv", "m/v", "full song", "full video", "remaster",
    "remastered", "explicit", "clean version", "radio edit", "with lyrics",
)
_BRACKET_RE = re.compile(r"\s*[\(\[]([^)\]]*)[\)\]]")
# Trailing " - Official Video" style suffixes with no brackets at all.
_TAIL_JUNK_RE = re.compile(
    r"\s*[-–|]\s*(official\s*(music\s*)?video|official\s*audio|lyric[s]?\s*video|"
    r"official\s*lyric[s]?\s*video|audio|video|hd|4k)\s*$",
    re.I,
)
# YouTube's auto-generated artist channels.
_TOPIC_RE = re.compile(r"\s*-\s*topic\s*$", re.I)
# "feat." in any of its spellings, kept as a separate strip step so we can try
# with and without it.
_FEAT_RE = re.compile(r"\s*[\(\[]?\s*(feat\.?|ft\.?|featuring)\s+[^)\]]*[\)\]]?\s*$", re.I)


def _clean_title(title):
    s = title or ""

    def _drop(m):
        inner = (m.group(1) or "").lower()
        return "" if any(w in inner for w in _JUNK_IN_BRACKETS) else m.group(0)

    s = _BRACKET_RE.sub(_drop, s)
    s = _TAIL_JUNK_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip(" -–|·")


def _clean_artist(artist):
    s = _TOPIC_RE.sub("", artist or "")
    return re.sub(r"\s+", " ", s).strip()


def _primary_artist(artist):
    """First credited artist only — LRCLIB indexes "A" far more often than
    "A, B & C", and a collaboration string is a guaranteed exact-match miss."""
    s = re.split(r"\s*(?:,|;|&|/| feat\.?| ft\.?| featuring | x | with )\s*",
                 artist or "", maxsplit=1, flags=re.I)[0]
    return s.strip()


def _variants(artist, title):
    """Ordered, de-duplicated (artist, title) pairs to try against LRCLIB's
    exact endpoint. Most faithful first so a correct raw match is never
    second-guessed; progressively more aggressive after that."""
    a_raw, t_raw = (artist or "").strip(), (title or "").strip()
    a_clean, t_clean = _clean_artist(a_raw), _clean_title(t_raw)
    a_first = _primary_artist(a_clean)
    t_nofeat = _FEAT_RE.sub("", t_clean).strip()

    out, seen = [], set()
    for pair in ((a_raw, t_raw), (a_clean, t_clean), (a_first, t_clean),
                 (a_first, t_nofeat)):
        key = (pair[0].lower(), pair[1].lower())
        if pair[1] and key not in seen:
            seen.add(key)
            out.append(pair)
    return out or [(a_raw, t_raw)]


def _best_query(artist, title):
    """The single cleanest (artist, title) to hand to the fuzzy providers."""
    return _variants(artist, title)[-1]


# --- Cache -------------------------------------------------------------------

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


# --- Provider 1: manual override --------------------------------------------

def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def _load_manual(artist, title):
    """Read cache/lyrics/manual/<slug>.lrc|.txt if the user dropped one in."""
    names = []
    a, t = _slug(artist), _slug(title)
    if a and t:
        names.append(a + "-" + t)
    if t:
        names.append(t)
    for name in names:
        for ext in (".lrc", ".txt"):
            p = os.path.join(MANUAL_DIR, name + ext)
            if not os.path.exists(p):
                continue
            try:
                with open(p, encoding="utf-8") as f:
                    text = f.read()
            except Exception as e:
                log.warning("manual lyrics unreadable (%s): %s", p, e)
                continue
            synced = _parse_lrc(text)
            plain = None if synced else (text.strip() or None)
            if synced or plain:
                log.info("lyrics: using manual file %s", os.path.basename(p))
                return {"synced": synced, "plain": plain}
    return None


# --- Provider 2/3: LRCLIB ----------------------------------------------------

def _from_lrclib_row(j):
    synced = _parse_lrc(j.get("syncedLyrics"))
    plain = (j.get("plainLyrics") or "").strip() or None
    if not synced and not plain:
        return None
    return {"synced": synced, "plain": plain}


async def _lrclib_get(session, artist, title, album, duration_sec):
    params = {"artist_name": artist, "track_name": title, "album_name": album or ""}
    if duration_sec:
        params["duration"] = str(int(duration_sec))
    try:
        async with session.get(LRC_GET_URL, params=params, headers=_HEADERS, timeout=10) as r:
            if r.status == 404:
                return None
            if r.status != 200:
                log.warning("lrclib get status %s for %r - %r", r.status, artist, title)
                return _TRANSIENT
            j = await r.json()
    except Exception as e:
        log.warning("lrclib get failed for %r - %r: %s", artist, title, e)
        return _TRANSIENT
    return _from_lrclib_row(j)


async def _lrclib_search(session, artist, title, duration_sec):
    # Deliberately searching on track_name alone rather than the `q` free-text
    # field: `q` mixes artist and title into one fuzzy blob and floats covers,
    # "(Slowed)" edits and random uploaders to the top. track_name keeps the
    # candidate set tight and lets the ranking below pick the right artist.
    params = {"track_name": title}
    try:
        async with session.get(LRC_SEARCH_URL, params=params, headers=_HEADERS, timeout=10) as r:
            if r.status == 404:
                return None
            if r.status != 200:
                log.warning("lrclib search status %s for %r - %r", r.status, artist, title)
                return _TRANSIENT
            rows = await r.json()
    except Exception as e:
        log.warning("lrclib search failed for %r - %r: %s", artist, title, e)
        return _TRANSIENT

    if not isinstance(rows, list) or not rows:
        return None
    # Rank: right artist first, then synced over plain, then closest duration.
    # Artist outranks synced deliberately -- a synced cover by some uploader is
    # worse than the correct song unsynced. Ranking tuples hold scalars only and
    # carry the row by index, so two equal scores never compare dicts.
    want = (artist or "").lower()
    scored = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        d = row.get("duration")
        delta = 0.0
        if duration_sec and isinstance(d, (int, float)):
            delta = abs(float(d) - float(duration_sec))
            if delta > DURATION_TOL_SEC:
                continue
        got = (row.get("artistName") or "").lower()
        artist_miss = 0 if (want and (want in got or got in want)) else 1
        scored.append((artist_miss, 0 if row.get("syncedLyrics") else 1, delta, i))
    if not scored:
        return None
    scored.sort()
    return _from_lrclib_row(rows[scored[0][3]])


# --- Provider 4: lyrics.ovh --------------------------------------------------

async def _lyrics_ovh(session, artist, title):
    """Independent catalogue, plain text only. Reached last, so a hit here
    means LRCLIB had nothing at all — unsynced lyrics beat an empty panel."""
    if not artist or not title:
        return None
    url = "%s/%s/%s" % (OVH_URL, quote(artist, safe=""), quote(title, safe=""))
    try:
        async with session.get(url, headers=_HEADERS, timeout=12) as r:
            if r.status == 404:
                return None
            if r.status != 200:
                log.warning("lyrics.ovh status %s for %r - %r", r.status, artist, title)
                return _TRANSIENT
            # Served without a JSON content-type on some responses.
            j = await r.json(content_type=None)
    except Exception as e:
        log.warning("lyrics.ovh failed for %r - %r: %s", artist, title, e)
        return _TRANSIENT

    plain = ((j or {}).get("lyrics") or "").strip()
    if not plain:
        return None
    log.info("lyrics: lyrics.ovh (plain) hit for %r - %r", artist, title)
    return {"synced": None, "plain": plain}


# --- Orchestration -----------------------------------------------------------

async def start(state, config, session) -> None:
    # Lyrics are fetched on-demand by the media collector; no fixed loop here.
    return


def _publish_if_current(state, track_key, data) -> None:
    """Publish lyrics only if the user hasn't already moved to another track."""
    cur = state.get("media")
    if cur and f"{cur.get('artist', '')}||{cur.get('title', '')}" == track_key:
        state.set_section("lyrics", data)


async def fetch(state, session, track_key, artist, title, album, duration_sec) -> bool:
    """Fetch + publish lyrics for a track.

    Returns True when the result is *definitive* (lyrics found, or every
    provider confirmed it has none), False when at least one provider failed
    transiently and nothing was found — the caller retries those. Only
    definitive results are cached, so an outage can't get baked in as
    "no lyrics".
    """
    manual = _load_manual(artist, title)
    if manual is not None:
        data = {"trackKey": track_key, "synced": manual["synced"],
                "plain": manual["plain"], "found": True}
        _publish_if_current(state, track_key, data)
        return True

    cached = _load_cache(track_key)
    if cached is not None:
        _publish_if_current(state, track_key, cached)
        return True

    result, transient = None, False
    variants = _variants(artist, title)

    # 2. LRCLIB exact, once per query variant. The album only belongs with the
    #    untouched strings; pairing it with a cleaned title narrows the match
    #    on a field we've already decided is unreliable.
    for i, (a, t) in enumerate(variants):
        r = await _lrclib_get(session, a, t, album if i == 0 else "", duration_sec)
        if r is _TRANSIENT:
            # LRCLIB itself is unhappy — trying three more variants against it
            # just triples the delay before we fall through to NetEase.
            transient = True
            break
        if r:
            result = r
            break

    # 3. LRCLIB fuzzy (skipped if LRCLIB is already known to be down).
    if result is None and not transient:
        a, t = _best_query(artist, title)
        r = await _lrclib_search(session, a, t, duration_sec)
        if r is _TRANSIENT:
            transient = True
        elif r:
            result = r

    # 4. lyrics.ovh — always tried, including when LRCLIB was the thing that
    #    failed. That's the whole point of a second catalogue.
    if result is None:
        a, t = _best_query(artist, title)
        r = await _lyrics_ovh(session, a, t)
        if r is _TRANSIENT:
            transient = True
        elif r:
            result = r

    if result is not None:
        data = {"trackKey": track_key, "synced": result["synced"],
                "plain": result["plain"], "found": True}
        _save_cache(track_key, data)
        _publish_if_current(state, track_key, data)
        return True

    if transient:
        log.warning("lyrics: no provider answered for %r (will retry)", track_key)
        return False

    data = {"trackKey": track_key, "synced": None, "plain": None, "found": False}
    _save_cache(track_key, data)
    _publish_if_current(state, track_key, data)
    return True
