# Desko — Implementation Plan

> **How to use this document:** implement strictly in milestone order (§9). Each
> milestone has acceptance criteria — do not move on until they pass. All data
> contracts (§4), API endpoints (§5), and config schema (§3) are binding; do not
> rename fields. When a detail is missing, prefer the simplest option that keeps
> the contracts intact.

---

## 1. Product summary

Desko turns a spare Android phone (**realme 3**, landscape on a desk stand, same
WiFi as the PC) into an always-on dashboard. A single lightweight Python process
on a **Windows** PC collects local data and pushes it over WebSocket to one
browser tab on the phone. The phone shows one of four **scenes** and switches
automatically based on what the user is doing on the PC, with swipe/tap manual
override.

| Scene  | Shown when | Content |
|--------|-----------|---------|
| `music` | Media is playing on Windows (browser YouTube Music, Spotify, etc.) | Album art, karaoke-style synced lyrics, progress bar |
| `stats` | A configured game process is running | CPU/GPU %, CPU/GPU temps, RAM, network, sparklines |
| `dev`   | VS Code reports a fresh heartbeat and is focused | Workspace, git branch, dirty file count, current file |
| `idle`  | None of the above | Big clock, date, weather, ambient gradient (auto-dims) |

**Hard constraints**

- Server must be light: one process, target <1% CPU idle, <100 MB RAM, no database
  (small JSON file caches only), no build tooling for the frontend.
- Graceful degradation: any missing data source hides its widget; nothing crashes.
- Windows-only features (media sessions, WMI temps) must be import-guarded so the
  server still starts on macOS/Linux for frontend development.

---

## 2. Tech choices (fixed)

| Concern | Choice | Why |
|---|---|---|
| Server | Python 3.11+, `aiohttp` (HTTP + WebSocket + static files in one) | Single async process, mature |
| Media detection | `winsdk` → Windows GSMTC (GlobalSystemMediaTransportControls) | Sees ALL Windows media incl. browser YT Music; zero user setup |
| Lyrics | LRCLIB (`https://lrclib.net/api/get`) | Free, no key, returns synced LRC |
| System stats | `psutil` | CPU/RAM/net, cross-platform, light |
| Temps + GPU load | LibreHardwareMonitor (tray app) + `wmi` package (`root\LibreHardwareMonitor`) | Only practical way to get CPU/GPU temps on Windows |
| Weather | Open-Meteo (forecast + geocoding APIs) | Free, no API key |
| VS Code source | Tiny bundled VS Code extension POSTing to the server | Accurate branch/dirty state; polling git dirs is guesswork |
| Game/foreground detection | `psutil.process_iter` + `ctypes.windll.user32` | No extra deps |
| Frontend | Vanilla HTML/CSS/JS, no framework, no bundler | Phone is weak; keep it trivial |
| Keep-awake | Vendored NoSleep.js (Wake Lock API needs a *secure context*; `http://lan-ip` is not one) + documented Android "Stay awake while charging" developer option | Actually works over plain HTTP |

Python dependencies (`requirements.txt`): `aiohttp`, `winsdk` (Windows only),
`psutil`, `wmi` + `pywin32` (Windows only, for temps), `qrcode` (optional, for
terminal QR pairing). Everything else is stdlib. Guard platform-specific imports:

```python
try:
    import winsdk  # etc.
    HAS_WINSDK = True
except ImportError:
    HAS_WINSDK = False
```

---

## 3. Configuration

`config.json` at project root. Missing file → server writes this default and
continues. Never crash on bad values; fall back per-field.

```json
{
  "host": "0.0.0.0",
  "port": 7777,
  "weather_city": "",
  "weather_lat": null,
  "weather_lon": null,
  "game_processes": ["valorant-win64-shipping.exe", "cs2.exe"],
  "poll": { "media_sec": 1.0, "sysstats_sec": 1.0, "temps_sec": 3.0, "weather_sec": 1800 },
  "override_timeout_sec": 300,
  "vscode_stale_sec": 45,
  "lhm_enabled": true
}
```

- `weather_city` empty → resolve location once at startup via `http://ip-api.com/json`
  (fields `lat`, `lon`, `city`). Non-empty → resolve via
  `https://geocoding-api.open-meteo.com/v1/search?name=<city>&count=1`. Explicit
  `weather_lat/lon` win over both.
- `game_processes`: lowercase `.exe` names, compared against `psutil` process names.

---

## 4. State & wire protocol (binding)

### 4.1 Server state

One in-memory `State` object (`desko/state.py`) with a section per data domain.
`set_section(name, data)` deep-compares with the previous value; only broadcasts
when changed. Keeps the full snapshot for new connections.

```jsonc
{
  "scene": "idle",              // active scene: music|stats|dev|idle
  "override": null,             // manual override scene or null (auto)
  "media": {
    "playing": true, "title": "", "artist": "", "album": "",
    "artDataUrl": "data:image/jpeg;base64,...",  // "" when none
    "positionSec": 12.3, "durationSec": 200.0,
    "sourceApp": "chrome", "updatedAt": 1721587200.0  // time.time()
  },
  "lyrics": {
    "trackKey": "artist||title",       // which track these lyrics belong to
    "synced": [[12.34, "line text"]],  // seconds, or null
    "plain": "full text or null",
    "found": true
  },
  "sys": {
    "cpuPercent": 12.0, "perCore": [10.0, 14.0],
    "ramPercent": 55.0, "ramUsedGb": 8.7, "ramTotalGb": 16.0,
    "netUpKbs": 10.2, "netDownKbs": 512.4,
    "gpuPercent": 30.0,       // null when LHM absent
    "cpuTempC": 55.0,         // null when LHM absent
    "gpuTempC": 60.0,         // null when LHM absent
    "history": { "cpu": [/* last 60 cpuPercent */], "gpu": [/* last 60, may be [] */] }
  },
  "weather": {
    "tempC": 29.0, "feelsC": 31.0, "code": 2, "label": "Partly cloudy",
    "hiC": 33.0, "loC": 24.0, "city": "Pune", "updatedAt": 0.0
  },
  "dev": {
    "workspace": "Desko", "branch": "main", "dirty": 3,
    "file": "server.py", "lang": "Python",
    "focused": true, "updatedAt": 0.0
  }
}
```

Empty/absent sections are `null` (e.g. `"media": null` when nothing has ever
played, `"weather": null` while offline). Frontend must handle `null` everywhere.

### 4.2 WebSocket (`GET /ws`)

Server → client:

```jsonc
{ "type": "snapshot", "data": { /* full §4.1 state */ } }          // on connect
{ "type": "update", "section": "media", "data": { /* section */ } } // on change
{ "type": "scene", "scene": "music", "reason": "auto" }             // reason: auto|manual
```

Client → server:

```jsonc
{ "type": "override", "scene": "stats" }  // force a scene (manual mode)
{ "type": "override", "scene": null }     // resume auto mode
{ "type": "cycle", "dir": 1 }             // swipe: next (1) / prev (-1) scene, implies manual
```

Scene cycle order (for `cycle` and swipe): **`music → stats → dev → idle`**, wrapping.

### 4.3 Scene priority (context engine, `desko/context.py`)

Evaluated every 0.5 s. Highest priority wins:

1. `music` — `media.playing == true` and `updatedAt` within 10 s
2. `stats` — any `config.game_processes` name matches a running process
3. `dev` — `dev.updatedAt` younger than `vscode_stale_sec` **and** `dev.focused == true`
4. `idle` — fallback

Rules:
- A non-null `override` always wins until cleared or `override_timeout_sec` elapses
  (then auto-resume by clearing it).
- Hysteresis: a *lower*-priority candidate must win 2 consecutive evaluations
  before the scene actually switches (prevents flicker when a song ends).
- Broadcast a `scene` message (and update state) on every effective change.

---

## 5. HTTP API (binding)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | `web/index.html` |
| GET | `/static/*` | files under `web/` (css/js/manifest) |
| GET | `/ws` | WebSocket, protocol in §4.2 |
| GET | `/api/state` | current full snapshot as JSON (debugging) |
| POST | `/api/vscode` | body = dev section JSON from the VS Code extension; server stamps `updatedAt`; responds `204` |

No auth (LAN-only). CORS: allow `*` on `/api/vscode` only.

---

## 6. File layout (create exactly this)

```
Desko/
├── AGENTS.md                     # already exists
├── IMPLEMENTATION_PLAN.md        # this file
├── README.md                     # M6: user-facing setup guide
├── requirements.txt
├── config.json                   # generated on first run; may be committed as default
├── run.py                        # entrypoint
├── desko/
│   ├── __init__.py
│   ├── server.py                 # aiohttp app, routes, ws broadcast
│   ├── state.py                  # State: sections, diffing, pub/sub
│   ├── context.py                # scene priority engine (§4.3)
│   ├── demo.py                   # --demo fake data generator
│   └── collectors/
│       ├── __init__.py
│       ├── media.py              # GSMTC now-playing
│       ├── lyrics.py             # LRCLIB synced lyrics + cache
│       ├── sysstats.py           # psutil + LibreHardwareMonitor WMI
│       ├── weather.py            # Open-Meteo
│       └── vscode.py             # POST handler logic (called from server.py)
├── web/
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── css/style.css
│   └── js/
│       ├── nosleep.min.js        # vendored NoSleep.js v0.12.0
│       ├── app.js                # ws client, scene router, gestures, keep-awake
│       └── scenes/
│           ├── idle.js
│           ├── music.js
│           ├── stats.js
│           └── dev.js
├── vscode-extension/
│   ├── package.json
│   └── extension.js
├── scripts/
│   └── setup-lhm.ps1             # installs LibreHardwareMonitor + autostart
└── cache/                        # runtime-created (lyrics, weather); gitignored
```

---

## 7. Collector specifications

### 7.1 `media.py` — Windows GSMTC (Windows only)

- API: `winsdk.windows.media.control.GlobalSystemMediaTransportControlsSessionManager`.
- Every `poll.media_sec` (1 s):
  1. `manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()`
     (cache the manager; re-request on error).
  2. `session = manager.get_current_session()` → `None` ⇒ publish `media: null`-ish
     (`playing: false`, keep last metadata or clear; choose: clear after 10 s idle).
  3. `props = await session.try_get_media_properties_async()` → title, artist,
     album_title, and `props.thumbnail` (a stream reference). Read the thumbnail
     fully via `winsdk.windows.storage.streams.DataReader` → bytes → base64 data
     URL (JPEG/PNG as-is; cap ~50 KB, skip if larger).
  4. `info = session.get_playback_info()` → `playback_status` (4 = PLAYING, 5 = PAUSED).
  5. `timeline = session.get_timeline_properties()` → `position`, `end_time`
     (`timedelta`s → seconds).
- Publish `media` section per §4.1. **Gotcha:** GSMTC `position` only updates on
  play/pause/seek — the *client* interpolates between updates (§8.3). Always send
  `updatedAt` so interpolation works.
- Track identity for lyrics: `trackKey = f"{artist}||{title}"`; when it changes,
  call `lyrics.fetch(trackKey, artist, title, album, durationSec)`.
- All winsdk calls wrapped in try/except; on `OSError` (session gone), log once
  and continue polling.

### 7.2 `lyrics.py` — LRCLIB

- `GET https://lrclib.net/api/get` with query `artist_name`, `track_name`,
  `album_name`, `duration` (int seconds). 10 s timeout via `aiohttp.ClientSession`.
- Response JSON: `syncedLyrics` (LRC string, may be `""`), `plainLyrics` (may be `""`).
- Parse LRC: lines like `[mm:ss.xx]text` → list of `[seconds_float, text]`
  (multiple timestamps per line → multiple entries; sort by time; drop empty text).
- Cache to `cache/lyrics/<sha1(trackKey)>.json`; cache **negative results too**
  (`found: false`) so instrumentals aren't re-fetched every run.
- Publish `lyrics` section per §4.1 (`synced: null` → frontend falls back to
  `plain`; both empty → `found: false` → frontend shows art-only card).

### 7.3 `sysstats.py` — psutil + LibreHardwareMonitor

- Fast loop every `poll.sysstats_sec` (1 s), all psutil:
  - `psutil.cpu_percent(interval=None, percpu=True)` (non-blocking; **prime once at
    startup** before first publish so it's not all zeros).
  - `psutil.virtual_memory()` → percent, used/total GB.
  - `psutil.net_io_counters()` → delta bytes since last call → KB/s up/down.
  - Append cpu/gpu to deques (maxlen 60) for `history`.
- Slow loop every `poll.temps_sec` (3 s), only when `lhm_enabled`:
  - `wmi.WMI(namespace="root\\LibreHardwareMonitor")` — constructor raises if LHM
    isn't running; catch once, set a flag, **silently skip forever after** (values
    stay `null`).
  - Query: `SELECT Name, SensorType, Value FROM Sensor`. Pick:
    - `cpuTempC`: first `SensorType == "Temperature"` whose name contains
      `CPU Package` (fallback: `Core (Tctl/Tdie)`, then any name containing `CPU`).
    - `gpuTempC`: `Temperature` containing `GPU Core` (fallback: any `GPU` temp).
    - `gpuPercent`: `Load` containing `GPU Core`.
  - WMI is blocking COM → run in `asyncio.to_thread` (never block the event loop).

### 7.4 `weather.py` — Open-Meteo

- Resolve location per §3 once at startup (and retry every 10 min until success).
- Every `poll.weather_sec` (1800 s):
  `GET https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`
- Map WMO `weather_code` → label + icon key with this table (frontend maps icon
  key → emoji/SVG):

  | code(s) | label | icon |
  |---|---|---|
  | 0 | Clear sky | `clear` |
  | 1, 2, 3 | Partly cloudy / Overcast | `clouds` |
  | 45, 48 | Fog | `fog` |
  | 51–57, 61–67, 80–82 | Rain / Drizzle | `rain` |
  | 71–77, 85–86 | Snow | `snow` |
  | 95–99 | Thunderstorm | `storm` |

- On network failure keep the previous section; start `null` (frontend hides it).

### 7.5 `vscode.py` — extension ingest

- `POST /api/vscode` handler: validate body keys (`workspace`, `branch`, `dirty`,
  `file`, `lang`, `focused` — all optional except none required; missing → sensible
  defaults), stamp `updatedAt = time.time()`, `state.set_section("dev", ...)`.
- Never errors out the request; always `204`.

---

## 8. Frontend specification (`web/`)

Landscape-first, target viewport **1520×720** (realme 3), must remain usable down
to ~1280×600. Dark theme, ambient, glanceable from 1 m. System font stack only
(no webfonts — works offline). No external CDN requests at all.

### 8.1 `index.html` / `manifest.webmanifest`

- One `<section class="scene" id="scene-music|stats|dev|idle">` per scene; exactly
  one has `.active` (CSS: opacity/transform crossfade ~400 ms, non-active
  `pointer-events: none`).
- Top-right pill showing `AUTO` or `MANUAL`; tiny connection dot (green/red).
- Manifest: `display: "fullscreen"`, `orientation: "landscape"`,
  `background_color`/`theme_color` `#0a0a0f`, name `Desko`.

### 8.2 `app.js`

- WebSocket to `ws://<location.host>/ws`, auto-reconnect with backoff 1→5 s,
  re-request snapshot on reconnect. Apply `snapshot`, merge `update` by section,
  dispatch to scene modules, follow `scene` messages (unless URL override below).
- **URL override:** `?scene=music|stats|dev|idle` forces a scene client-side
  (preview/demo aid; ignores server scene messages).
- **Gestures:** horizontal swipe >50 px → send `{"type":"cycle","dir":±1}`;
  double-tap → send `{"type":"override","scene":null}` (resume auto). Single tap
  toggles the AUTO/MANUAL pill visibility.
- **Keep-awake:** `new NoSleep(); noSleep.enable()` on first user gesture
  (autoplay policy) and re-enable on `visibilitychange` → visible.
- Expose a tiny global `Desko = { state, send }` for scene modules and debugging.

### 8.3 Scene modules (one file each, plain script tags, no modules/build)

- `music.js`: blurred `artDataUrl` as scene background; crisp art left (rounded,
  subtle shadow); right column: title (marquee if overflowing), artist, progress
  bar (`positionSec/durationSec`), synced lyrics list. **Interpolation:** while
  `playing`, effective position = `positionSec + (now − updatedAt)`; re-evaluate
  ~4×/s via `requestAnimationFrame` or 250 ms timer. Active lyric = last line with
  `t <= position`; translate list so active line is vertically centered; brighten
  active, fade neighbors (karaoke style). `synced == null` → render `plain`
  centered, dimmed. `found == false` → big art + title only.
- `stats.js`: large CPU% and GPU% numbers with thin sparklines from `history`
  (inline `<svg>`, 60 points, no library); per-core mini-bars; RAM bar; net
  up/down; temps shown only when non-null. Gaming-HUD look: monospace numerals,
  thin lines, accent color.
- `dev.js`: workspace name large; branch as a pill with a small branch glyph;
  dirty count badge (green when 0, amber otherwise); current file + language;
  if `updatedAt` older than `vscode_stale_sec`, show "VS Code idle — last seen
  Xs ago" dimmed.
- `idle.js`: HH:MM clock (1 s ticker), full date line, weather row (icon, temp,
  feels-like, hi/lo, city), slow animated CSS gradient background. After 5 min
  without a scene change, add `.dimmed` (CSS filter brightness 0.35); remove on
  any state/scene change or tap.

### 8.4 Styling

- CSS custom properties: `--bg: #0a0a0f`, `--fg: #eaeaf2`, `--accent: #7c9aff`,
  `--good: #4ade80`, `--warn: #fbbf24`, `--dim: #8b8b9e`.
- Use `cqw`/`vh` sizing so one layout scales across phone resolutions; no media
  queries needed beyond a portrait fallback that stacks columns.

---

## 9. Milestones (implement in this order)

Each milestone ends with `python run.py` working and its criteria verifiably true.
Commit-worthy but **do not git-commit unless the user asks**.

### M1 — Skeleton + idle scene
Create full file layout, `config.json` handling, `run.py` (prints LAN URL +
terminal QR via `qrcode`, UDP-socket trick for LAN IP: connect to `8.8.8.8:80`
and read `getsockname()`), aiohttp server with `/`, `/static/*`, `/ws`,
`/api/state`, `State` with snapshot/update broadcast, `weather.py`, `idle.js`
with clock/weather/gradient, `app.js` with reconnect + `?scene=` override.
**Accept:** desktop browser at `http://localhost:7777` shows live clock and real
weather (or gracefully hidden weather offline); `/api/state` returns valid §4.1
JSON; ws updates visible in devtools.

### M2 — Music scene
`media.py`, `lyrics.py` (+`cache/lyrics`), `music.js` with karaoke lyrics and
client-side position interpolation.
**Accept:** play a song in browser YouTube Music → art/title/lyrics appear within
2 s; line highlight tracks the song; pause → interpolation freezes; seek → lyric
jumps correctly; instrumental → art-only card; song change → new lyrics fetched
(use `/api/state` to verify cache writes).

### M3 — Stats scene
`sysstats.py` (psutil loop first; LHM loop second), `stats.js` with sparklines.
**Accept:** CPU/RAM/net numbers update every second and match Task Manager;
with LibreHardwareMonitor running (tray), temps + GPU% appear within 5 s; without
it, temp widgets hide and nothing errors in the log.

### M4 — Dev scene + VS Code extension
`vscode.py` route, `dev.js`, `vscode-extension/` (below).
**Accept:** with extension installed (F1 → "Install from VSIX"-less: just copy
folder to `%USERPROFILE%\.vscode\extensions\desko-status-0.0.1` and reload),
opening a git repo in VS Code shows workspace/branch/dirty on `?scene=dev`
within 10 s; values update on branch switch and file edits; closing VS Code →
stale message after `vscode_stale_sec`.

### M5 — Context engine + override + polish
`context.py` per §4.3, swipe/double-tap gestures, AUTO/MANUAL pill, NoSleep,
scene transitions, idle auto-dim, `demo.py` (`python run.py --demo` fabricates
plausible media+lyrics+sys+dev data and cycles scenes every 20 s).
**Accept:** music playing → auto `music`; start a configured game exe → auto
`stats`; focus VS Code → auto `dev`; all stop → auto `idle`. Swipe forces scene
(pill → MANUAL), double-tap resumes (pill → AUTO). `--demo` runs on a clean
machine with **no** media/LHM/extension and exercises every scene.

### M6 — Docs + setup tooling
`scripts/setup-lhm.ps1` (download pinned LibreHardwareMonitor release, extract to
`%LOCALAPPDATA%\Desko\lhm`, create a `HKCU\...\Run` registry entry to start it
minimized; print the two GUI toggles the user must enable: "Start minimized",
"Minimize on close"), `README.md` (install deps → `python run.py` → scan QR →
Add to Home Screen → enable Android Developer Options "Stay awake while charging";
troubleshooting: firewall prompt, LHM admin note, lyrics-miss note).
**Accept:** a fresh clone following only README reaches a working dashboard.

---

## 10. VS Code extension spec (`vscode-extension/`)

`package.json`: name `desko-status`, version `0.0.1`, `engines.vscode: ^1.80.0`,
`activationEvents: ["onStartupFinished"]`, `main: "./extension.js"`, no deps.

`extension.js` behavior:
- On activate and then every 10 s (plus on `onDidChangeActiveTextEditor` and git
  state change), gather:
  - `workspace`: `vscode.workspace.name ?? ""`
  - git: `const git = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1)`
    → `repo = git.repositories[0]`; `branch = repo.state.HEAD?.name ?? ""`;
    `dirty = repo.state.workingTreeChanges.length`
  - `file`: basename of active editor document, `lang`: `languageId`
  - `focused`: `vscode.window.state.focused`
- `fetch('http://localhost:7777/api/vscode', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})`
  — modern VS Code has global `fetch` (Node 18+). Wrap everything in try/catch;
  **never** surface errors to the user.

---

## 11. Demo mode (`desko/demo.py`)

`python run.py --demo`: skips real collectors; a single task fabricates state:
rotating fake tracks with generated synced lyric timestamps (position advancing in
real time, one track with `synced: null`, one with `found: false`), random-walk
CPU/GPU/temp history, static weather, a fake git heartbeat, and cycles the scene
every 20 s. Must reuse the *real* `State` and broadcast path so the frontend can't
tell the difference.

---

## 12. Gotchas (learned requirements — read before coding)

1. **Wake Lock API is unavailable** on `http://<lan-ip>` (secure-context-only).
   Hence vendored NoSleep.js; document Android "Stay awake while charging".
2. **GSMTC position is stale** between transport events — interpolate on the client
   using `updatedAt`; never try to poll-faster on the server.
3. **WMI blocks** — always `asyncio.to_thread`; and instantiating the
   `root\LibreHardwareMonitor` namespace throws when LHM isn't installed: catch
   once, degrade silently. LHM needs admin rights for some sensors — README note.
4. **winsdk/pywin32 import on non-Windows** — guard all imports; server must boot
   on Linux/macOS with media/temps disabled (frontend dev workflow).
5. **First `cpu_percent` call returns 0.0** — prime it during startup.
6. **Phone browser is old Chromium** (realme 3): avoid ES2022+ syntax, use plain
   script tags (no ES modules), test with Chrome device emulation at 1520×720.
7. **Album art can be large** — cap data URL ~50 KB or the ws payloads get heavy.
8. **Negative-cache lyrics** or every restart re-hammers LRCLIB for instrumentals.
9. **Don't block shutdown**: all collector tasks must be cancelled cleanly on
   Ctrl+C (aiohttp `on_cleanup`).
10. **Firewall**: first run triggers a Windows Firewall prompt for the port —
    README must tell the user to allow Private networks.

---

## 13. Definition of done (whole project)

- `python run.py` on the Windows PC serves all four scenes; phone on same WiFi
  opens the QR link fullscreen and stays awake.
- Auto context switching works end-to-end (M5 accept list).
- Idle CPU of the server process <1% (check Task Manager over 1 min).
- Every collector disabled/missing → server and UI still fully functional.
- `--demo` mode demonstrates all scenes on any OS with zero setup.
