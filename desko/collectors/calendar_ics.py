"""Calendar collector -- upcoming events from iCalendar (.ics) URLs.

Opt-in: set ``calendar_ics_urls`` in config.json to one or more public/secret
``.ics`` links (Google Calendar's "Secret address in iCal format", an Outlook
published calendar, a Nextcloud share, ...). With none configured the collector
no-ops and the Agenda scene shows a hint, exactly like weather/LHM degrade.

Dependency-free on purpose so a fresh clone "just works": a small RFC-5545
parser (line unfolding + property parsing), timezone resolution via the stdlib
``zoneinfo`` (needs the ``tzdata`` package on Windows -- in requirements.txt),
and recurrence expansion for the common cases (FREQ DAILY / WEEKLY[+BYDAY] /
MONTHLY, with INTERVAL / COUNT / UNTIL). Anything it can't parse is skipped, not
crashed -- a bad feed must never take the collector down.
"""
import asyncio
import logging
import time
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger("desko.calendar")

HORIZON_DAYS = 14        # how far ahead to expand recurring events
MAX_EVENTS = 8           # most upcoming events published to the client
_RECUR_GUARD = 1000      # hard cap on occurrences generated per event

try:
    from zoneinfo import ZoneInfo
    _HAS_TZ = True
except Exception:  # pragma: no cover - very old Python
    _HAS_TZ = False

_WEEKDAY = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


# --- RFC-5545 text parsing ---------------------------------------------------
def _unfold(text: str) -> list:
    """Undo line folding: a line beginning with a space/tab continues the prev."""
    out = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line[:1] in (" ", "\t") and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def _parse_line(line: str):
    """'DTSTART;TZID=Asia/Kolkata:20260722T090000' -> (name, params, value)."""
    ci = line.find(":")
    if ci < 0:
        return None
    left, value = line[:ci], line[ci + 1:]
    segs = left.split(";")
    name = segs[0].upper()
    params = {}
    for seg in segs[1:]:
        if "=" in seg:
            k, v = seg.split("=", 1)
            params[k.upper()] = v.strip('"')
    return name, params, value


def _unescape(v: str) -> str:
    return v.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()


# --- date/time resolution ----------------------------------------------------
def _to_utc(value: str, params: dict):
    """Return (aware-UTC datetime, all_day: bool). Raises on unparseable input."""
    v = value.strip()
    if params.get("VALUE") == "DATE" or (len(v) == 8 and "T" not in v):
        d = datetime.strptime(v[:8], "%Y%m%d")
        # All-day: anchor at local midnight so it lands on the right calendar day.
        return d.replace(tzinfo=None).astimezone(timezone.utc), True
    if v.endswith("Z"):
        return datetime.strptime(v[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc), False
    naive = datetime.strptime(v[:15], "%Y%m%dT%H%M%S")
    tzid = params.get("TZID")
    if tzid and _HAS_TZ:
        try:
            return naive.replace(tzinfo=ZoneInfo(tzid)).astimezone(timezone.utc), False
        except Exception:
            pass
    # Floating time -> interpret in the server's local zone.
    return naive.astimezone().astimezone(timezone.utc), False


def _parse_rrule(value: str) -> dict:
    out = {}
    for part in value.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.upper()] = v
    return out


def _add_months(dt: datetime, months: int) -> datetime:
    m = dt.month - 1 + months
    year = dt.year + m // 12
    month = m % 12 + 1
    # Clamp day to the month length (e.g. Jan 31 + 1 month -> Feb 28/29).
    for day in (dt.day, 28, 29, 30, 31):
        try:
            return dt.replace(year=year, month=month, day=min(day, 31))
        except ValueError:
            continue
    return dt


# --- recurrence expansion ----------------------------------------------------
def _expand(ev: dict, win_start: datetime, win_end: datetime) -> list:
    start, end = ev["start"], ev["end"]
    dur = end - start
    rr = ev.get("rrule")
    occ = []

    def emit(s):
        e = s + dur
        if e >= win_start and s <= win_end:
            occ.append((s, e))

    if not rr:
        emit(start)
        return occ

    freq = rr.get("FREQ", "")
    interval = max(1, int(rr.get("INTERVAL", "1") or "1"))
    count = int(rr["COUNT"]) if rr.get("COUNT", "").isdigit() else None
    until = None
    if rr.get("UNTIL"):
        try:
            until, _ = _to_utc(rr["UNTIL"], {})
        except Exception:
            until = None

    emitted = 0
    guard = 0

    def within(s):
        return (until is None or s <= until) and (count is None or emitted < count)

    if freq == "WEEKLY":
        bydays = [_WEEKDAY[d] for d in rr.get("BYDAY", "").split(",") if d in _WEEKDAY]
        if not bydays:
            bydays = [start.weekday()]
        week0 = (start - timedelta(days=start.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        wk = 0
        while guard < _RECUR_GUARD:
            guard += 1
            base = week0 + timedelta(weeks=wk * interval)
            if base > win_end + timedelta(days=7):
                break
            for wd in sorted(bydays):
                s = datetime.combine((base + timedelta(days=wd)).date(), start.timetz())
                if s < start or not within(s):
                    continue
                emitted += 1
                emit(s)
            if count is not None and emitted >= count:
                break
            wk += 1
    elif freq == "DAILY":
        k = 0
        while guard < _RECUR_GUARD:
            guard += 1
            s = start + timedelta(days=k * interval)
            if s > win_end or not within(s):
                break
            emitted += 1
            emit(s)
            k += 1
    elif freq == "MONTHLY":
        k = 0
        while guard < _RECUR_GUARD:
            guard += 1
            s = _add_months(start, k * interval)
            if s > win_end or not within(s):
                break
            emitted += 1
            emit(s)
            k += 1
    else:
        # Unsupported frequency (YEARLY, etc.) -> at least show the base event.
        emit(start)
    return occ


# --- ICS document -> event list ----------------------------------------------
def _parse_ics(text: str) -> list:
    events = []
    cur = None
    for line in _unfold(text):
        u = line.strip()
        if u == "BEGIN:VEVENT":
            cur = {}
            continue
        if u == "END:VEVENT":
            if cur is not None and "start" in cur:
                if "end" not in cur:
                    cur["end"] = cur["start"] + (timedelta(days=1) if cur.get("all_day") else timedelta(hours=1))
                events.append(cur)
            cur = None
            continue
        if cur is None:
            continue
        parsed = _parse_line(line)
        if not parsed:
            continue
        name, params, value = parsed
        try:
            if name == "DTSTART":
                cur["start"], cur["all_day"] = _to_utc(value, params)
            elif name == "DTEND":
                cur["end"], _ = _to_utc(value, params)
            elif name == "SUMMARY":
                cur["title"] = _unescape(value)
            elif name == "LOCATION":
                cur["location"] = _unescape(value)
            elif name == "RRULE":
                cur["rrule"] = _parse_rrule(value)
        except Exception:
            # A single malformed property shouldn't drop the whole event; just
            # skip it (DTSTART failing means the event is dropped at END:VEVENT).
            continue
    return events


def _collect_upcoming(ics_texts: list) -> list:
    now = datetime.now(timezone.utc)
    win_start = now - timedelta(hours=6)   # keep events that started recently / are ongoing
    win_end = now + timedelta(days=HORIZON_DAYS)
    rows = []
    for text in ics_texts:
        for ev in _parse_ics(text):
            for s, e in _expand(ev, win_start, win_end):
                if e < now:
                    continue  # already finished
                rows.append({
                    "start": s.timestamp(),
                    "end": e.timestamp(),
                    "title": ev.get("title", "(untitled)"),
                    "location": ev.get("location", ""),
                    "allDay": bool(ev.get("all_day")),
                })
    rows.sort(key=lambda r: r["start"])
    # De-dupe identical (start,title) occurrences across overlapping feeds.
    seen = set()
    out = []
    for r in rows:
        key = (round(r["start"]), r["title"])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
        if len(out) >= MAX_EVENTS:
            break
    return out


# --- collector loop ----------------------------------------------------------
async def _fetch(session, url: str) -> str:
    async with session.get(url, timeout=20) as r:
        if r.status != 200:
            log.debug("calendar %s -> HTTP %s", url, r.status)
            return ""
        return await r.text()


async def start(state, config, session) -> None:
    urls = config.get("calendar_ics_urls") or []
    if isinstance(urls, str):
        urls = [urls]
    urls = [u for u in urls if u]
    if not urls:
        log.info("no calendar_ics_urls configured -- calendar disabled")
        return
    interval = float(config.get("poll", {}).get("calendar_sec", 900))
    while True:
        texts = []
        for u in urls:
            try:
                t = await _fetch(session, u)
                if t:
                    texts.append(t)
            except Exception as e:
                log.warning("calendar fetch failed for %s: %s", u, e)
        try:
            events = _collect_upcoming(texts) if texts else []
            state.set_section("calendar", {"events": events, "updatedAt": time.time()})
        except Exception as e:
            log.warning("calendar parse failed: %s", e)
        await asyncio.sleep(interval)
