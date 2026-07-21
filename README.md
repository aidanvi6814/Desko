# Desko

Turn a spare Android phone (or any old tablet/laptop with a browser) into an
always-on desk dashboard. A lightweight Python server on your Windows PC pushes
live data over a WebSocket to a single browser tab on the phone (same WiFi). The
screen auto-switches between scenes based on what you're doing, with swipe/tap to
override and a lock to pin it.

| Scene | Shows automatically when | Content |
|-------|--------------------------|---------|
| **Idle** | Nothing else is active | IST + London clock, date, weather, phone battery, link latency, PC uptime |
| **Music** | Media is playing on Windows (YouTube Music, Spotify, browser, ...) | Album art **ambient background**, synced karaoke lyrics, transport controls, per-track color theming |
| **Stats** | A configured game process is running | CPU/GPU %/temps, RAM, network, live sparklines, session timer |
| **Dev** | VS Code is open + focused | Workspace, branch, ahead/behind, real changed-file list, current file |
| **Focus** | A Pomodoro timer is running | Countdown ring, work/break auto-flow, cycle counter, adjustable lengths |
| **Agenda** | *(manual)* | Upcoming calendar events from your `.ics` feeds, with a live countdown |

Everything degrades gracefully: no media, no LibreHardwareMonitor, no VS Code, no
calendar — those widgets simply hide, nothing breaks.

## Quick start

```powershell
git clone <your-fork-url> Desko
cd Desko
python -m pip install -r requirements.txt
python -m pip install -r requirements-windows.txt   # Windows: media + temps/GPU
python run.py
```

The terminal prints a URL and a scannable QR code. Open it on your phone's
browser (same WiFi). That's it.

**Even easier on Windows:** double-click **`desko.bat`** (or the Desktop shortcut,
if you made one — right-click `desko.bat` → *Send to* → *Desktop (create
shortcut)*). It starts the server in a window that shows the URL/QR and stays
open; close it to stop. Running it twice just tells you it's already up.

Try it with nothing playing / no game / no VS Code:

```powershell
python run.py --demo    # or:  desko.bat --demo
```

Demo mode fabricates every scene and cycles them every 20 s.

## Phone setup

1. Open the printed URL (or scan the QR with the phone camera).
2. **Add to Home Screen** (Chrome menu / Safari share) for a fullscreen,
   chromeless app with a proper Desko icon. Launch it from the home-screen icon.
3. **Keep the screen on.** Desko keeps the display awake itself (a hidden
   always-playing video — works over plain HTTP). For extra reliability on a
   permanent desk display, also enable Android's *Stay awake while charging*:
   - Settings → About phone → tap *Build number* 7× (enables Developer options)
   - Settings → System → Developer options → enable **Stay awake**
   - Keep the phone plugged in.

## Controls (on the phone)

- **Swipe left/right** — switch to the next/previous scene (manual).
- **Double-tap** — open the Desko home screen (launcher) to pick any scene.
- **Lock button** (top-right padlock) — freeze the current scene so nothing
  auto-switches. Tap again to resume automatic selection. Open padlock = AUTO,
  closed = LOCKED.

## Configuration

Two ways to configure:

- **In the browser:** open **`http://<pc-ip>:7777/config`** — a settings page for
  the weather city, game list, calendar links, Pomodoro lengths, and port. It
  tells you which changes apply live vs. need a restart.
- **By hand:** edit **`config.json`** (created on first run from
  `config.example.json`) and restart.

```jsonc
{
  "port": 7777,
  "weather_city": "",                 // e.g. "Pune, IN"; empty = auto-detect via IP
  "game_processes": ["cs2.exe"],      // lowercase .exe names -> Stats scene
  "calendar_ics_urls": [],            // .ics links -> Agenda scene (see below)
  "focus_work_min": 25,               // Pomodoro defaults
  "focus_break_min": 5,
  "lhm_enabled": true                 // LibreHardwareMonitor for temps/GPU
}
```

## Per-scene setup

### Music (Windows)
Install `requirements-windows.txt` (for `winsdk`). Play audio in any app/browser
tab **on the PC** — Windows' media session API picks up Chrome, Edge, Brave,
Spotify, and most desktop players. Synced lyrics come from LRCLIB (free, no key)
and are cached, including "no lyrics" results.

### Stats — temperatures + GPU (Windows)
CPU/RAM/network work with just `psutil`. For **temps and GPU %**, install
LibreHardwareMonitor once:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/setup-lhm.ps1
```

This installs LHM (portable) under `%LOCALAPPDATA%\Desko\lhm` and registers an
elevated scheduled task so it launches at login with admin rights. Without it,
the temp/GPU widgets hide.

### Dev — VS Code integration
Copy the bundled reporter extension into your VS Code extensions folder:

```powershell
Copy-Item -Recurse vscode-extension "$env:USERPROFILE\.vscode\extensions\desko-status-0.0.2"
```

Restart VS Code. It reports workspace, branch, **ahead/behind**, the **real
changed-file list**, dirty count, and the current file every 10 s and on editor
switches. It reads the first git repository in your workspace; switch branches
normally and the dashboard follows. Closing VS Code (or 45 s idle) falls back to
another scene.

### Agenda — calendar
Add one or more iCalendar (`.ics`) URLs via the `/config` page or
`calendar_ics_urls` in `config.json`. For Google Calendar: *Settings → your
calendar → Integrate calendar → **Secret address in iCal format***. Desko fetches
them every 15 min, expands recurring events, and shows the next 14 days. No
account/OAuth needed. Timezone-aware (via the `tzdata` package).

### Focus — Pomodoro
No setup. Open the Focus scene (launcher or swipe), press play. Work/break phases
auto-flow, the timer is server-side so it's identical on every connected device
and survives reloads, and starting one auto-switches the display to Focus.

### Weather
Leave `weather_city` empty for IP-based auto-detect, or set your city
(e.g. `"Bengaluru, IN"`, `"Berlin, DE"`). Powered by Open-Meteo (free, no key).

## How it works

One Python process (`aiohttp`) serves the static frontend and a WebSocket.
Collectors run as async tasks and push state diffs only when data changes:
`winsdk` (media, on a dedicated WinRT thread), LRCLIB (lyrics), `psutil` +
LibreHardwareMonitor over WMI (stats, on a dedicated COM thread), Open-Meteo
(weather), a dependency-free `.ics` parser (calendar), a server-side Pomodoro
timer, and a POST endpoint fed by the VS Code extension. A context engine picks
the scene by priority (focus > music > game > dev > idle) with hysteresis, a
manual override, and a hard lock. Target idle cost: <1% CPU, <100 MB RAM.

See `IMPLEMENTATION_PLAN.md` for the original architecture and data contracts.

## Project layout

```
run.py                # entrypoint: prints URL + QR, starts the server
desko.bat             # Windows double-click launcher (single-instance guard)
config.json           # your settings (git-ignored; generated on first run)
config.example.json   # reference config committed to the repo
desko/                # server, state, context engine, focus timer, collectors, demo
  collectors/         #   media, lyrics, sysstats, weather, vscode, calendar_ics
web/                  # vanilla HTML/CSS/JS frontend (no build step) + icons
  config.html         #   the /config settings page
vscode-extension/     # tiny reporter extension (workspace + git status)
scripts/setup-lhm.ps1 # one-time LibreHardwareMonitor installer
requirements.txt      # cross-platform deps
requirements-windows.txt  # winsdk + wmi + pywin32 (media + temps)
```

## Troubleshooting

- **Can't open the URL on the phone** — the first run triggers a Windows Firewall
  prompt. Allow Python on **Private networks**. Confirm both devices are on the
  same WiFi.
- **No music detected** — play audio in an app/tab **on the PC** (not the phone),
  and install `requirements-windows.txt`.
- **No temperatures / GPU** — LibreHardwareMonitor isn't running or isn't
  elevated. Launch it (allow the UAC prompt). Desko links to it automatically
  within ~20 s once it's up — no restart needed.
- **No lyrics for a song** — LRCLIB doesn't have synced lyrics for every track;
  Desko falls back to plain lyrics, then an art-only card. Cached either way.
- **Agenda empty** — add an `.ics` URL on `/config`. If events look an hour off,
  ensure `tzdata` is installed (`pip install -r requirements.txt`).
- **Screen turns off** — Desko's keep-awake needs one tap/interaction on the page
  to arm (browser autoplay policy). Tap once; optionally enable Android *Stay
  awake* as a backstop.

## License

MIT — see `LICENSE`. Put your own name on the copyright line if you like.
