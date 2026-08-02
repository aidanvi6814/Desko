<div align="center">

# ⌁ DESKO

**Turn a spare phone into an always-on desk dashboard.**

Music with karaoke lyrics · live PC vitals · git status · a clock that actually looks good ·
a Pomodoro timer, pushed from your PC to any old phone on your WiFi.

[![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![Windows](https://img.shields.io/badge/Windows-full-0078D4?style=flat-square&logo=windows&logoColor=white)](#platform-support)
[![macOS](https://img.shields.io/badge/macOS%20%2F%20Linux-partial-999?style=flat-square&logo=apple&logoColor=white)](#platform-support)
[![Frontend](https://img.shields.io/badge/frontend-vanilla%20JS-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](#how-it-works)
[![No build step](https://img.shields.io/badge/build%20step-none-82f59b?style=flat-square)](#how-it-works)
[![License](https://img.shields.io/badge/license-Noncommercial-blue?style=flat-square)](LICENSE)

</div>

---

## What it is

That old phone in your drawer has a perfectly good screen. Desko gives it a job.

A **single lightweight Python process** runs on your PC, collects things worth looking at,
and pushes them over a WebSocket to **one browser tab** on the phone sitting on your desk
stand. No app to install, no account, no cloud, no build tooling. You open a URL and it
just runs, forever.

The display cycles through five scenes on a timer. Swipe to take manual control, tap the
padlock to pin one.

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │ ⛶  DESKO OS 0.8.5   │ ● LINKED  OMEN-PC  192.168.0.7 │ 21:04  🔋87% ⚡🔒│
   ├──────────────────────────────────────────────────────────────────────┤
   │  ┌────────────┐   MEDIA.TRACK                            PLAYING     │
   │  │            │   EAGLES · HOTEL CALIFORNIA                          │
   │  │  ▓▓ album  │   ┌─ LYRICS ─────────────────────────────────────┐   │
   │  │  ▓▓  art   │   │      on a dark desert highway                │   │
   │  │            │   │  ▌ cool wind in my hair                      │   │  ← active line
   │  └────────────┘   │      warm smell of colitas                   │   │     glows + scrolls
   │  ◉ YT MUSIC       │      rising up through the air               │   │
   │                   └──────────────────────────────────────────────┘   │
   │  0:44 ▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░ -4:15    ⏮   ⏸   ⏭   🔊              │
   └──────────────────────────────────────────────────────────────────────┘
        ambient background = the album art, blurred, filling the whole screen
```

Everything degrades gracefully. No media playing, no LibreHardwareMonitor, no VS Code, and
those widgets just hide. Nothing crashes, nothing shows a dead `-`.

## The five scenes

| | Scene | What's on it |
|:--:|---|---|
| 🕐 | **Idle** | Big IST clock plus London secondary, date, live weather, phone battery, link latency, PC uptime |
| 🎵 | **Music** | Album art as an ambient blurred backdrop, **synced karaoke lyrics**, transport and volume control of the *PC*, per-track colour theming pulled from the cover |
| 📊 | **Stats** | CPU/GPU load and temperature, RAM, network up/down, 60-second sparklines, session timer, game name when a configured process is running |
| 💻 | **Dev** | Workspace, branch, ahead/behind, changed files, cursor position, **last commit**, **today's commits and lines**. Live from VS Code, and from git alone once the editor is closed |
| 🍅 | **Focus** | Pomodoro countdown ring, work/break auto-flow, cycle counter, adjustable lengths. Server-side, so it's identical on every device and survives reloads |

<div align="center">

**Rotation order** &nbsp;·&nbsp; `idle → music → stats → dev → focus` &nbsp;·&nbsp; wrapping, `rotate_sec` each

</div>

---

## Quick start

```powershell
git clone https://github.com/typewriter03/Desko.git
cd Desko
python -m pip install -r requirements.txt
python -m pip install -r requirements-windows.txt   # Windows only: media, temps, volume
python run.py
```

The terminal prints two URLs and a scannable QR code. Open one on your phone's browser.
Same WiFi is the only requirement.

> [!TIP]
> **On Windows, double-click [`desko.bat`](#launchers-windows) instead.** It keeps a window
> open showing the URL and QR, and closing the window stops the server. Running it twice just
> tells you it's already up.

### Which URL to save

| URL | Use it when |
|---|---|
| **`http://desko.local:7777`** ⭐ | **Save this one.** An mDNS name that keeps working when the router hands your PC a different IP. Works on iOS, macOS, Windows, Linux and **Android 12+**. Always type the full `http://` so Chrome doesn't force HTTPS. |
| `http://<current-ip>:7777` | Also in the QR. Changes whenever the DHCP lease moves. On **Android 10/11** there's no `.local` resolver, so you need this one. Make it permanent with a **DHCP reservation** in your router for the PC's MAC, which Desko prints under the QR. |

### Try it with nothing running

```powershell
python run.py --demo        # or:  desko.bat --demo
```

Demo mode fabricates every scene (media, lyrics, stats, git, weather) and cycles them every
20 s. Works on any OS with zero setup, no platform deps needed.

---

## Platform support

The server is cross-platform Python. Only some *collectors* are Windows-bound, and every one
of them is import-guarded. Here is what actually happens on a machine with no Windows modules
available, measured rather than assumed by booting the server with `winsdk`, `wmi`,
`pythoncom`, `pycaw` and `comtypes` blocked at import:

| Feature | Windows | macOS / Linux | Why |
|---|:--:|:--:|---|
| Server, WebSocket, scene carousel | ✅ | ✅ | pure Python |
| Idle: clock, date, weather, battery | ✅ | ✅ | Open-Meteo plus the phone's own Battery API |
| Focus: Pomodoro | ✅ | ✅ | server-side timer, no OS calls |
| Stats: CPU %, RAM, network, sparklines | ✅ | ✅ | `psutil` is cross-platform |
| Stats: CPU/GPU **temperature**, GPU load | ✅ | ❌ | reads LibreHardwareMonitor over WMI |
| **Dev: branch, changes, commit, today** | ✅ | ✅ | plain `git` subprocesses |
| **Dev: live editor state** | ✅ | ✅ | the VS Code extension is just JS plus HTTP |
| Music: now playing, album art, lyrics | ✅ | ❌ | Windows GSMTC media session |
| Music: PC volume slider | ✅ | ❌ | `pycaw` / Core Audio |
| `http://desko.local` (mDNS) | ✅ | ✅ | `zeroconf` |
| `--demo` mode | ✅ | ✅ | fabricated data |

<details>
<summary><b>What that looks like in practice</b></summary>

Booting on a non-Windows machine gives you a working dashboard with **Idle, Stats, Dev and
Focus**. The Music scene stays empty and the temperature widgets hide. Verbatim output of the
degradation test:

```
sections after 6s with all Windows modules blocked:
  sys      {'cpuPercent': 21.8, 'ramPercent': 82.2, 'netDownKbs': 2869.5,
            'cpuTempC': None, 'gpuTempC': None, 'gpuPercent': None}
  media    ABSENT
  volume   ABSENT
  weather  {'tempC': 29.5, 'city': 'Bengaluru'}
  dev      {'source': 'git', 'branch': 'master', 'dirty': 16}
  focus    {'running': False}
```

> [!NOTE]
> That test ran on Windows with the platform modules hidden. It proves the import guards and
> the degradation paths, **not** that Desko has been run on a real Mac. Nothing in the code is
> known to be Windows-path-dependent, but treat macOS as untested rather than supported.

**What macOS parity would take**, if you want it:

- **Now playing.** A `nowplaying-cli` style shim, or AppleScript against Music and Spotify.
  Apple's private `MediaRemote` framework has been progressively locked down for third-party
  processes, so the AppleScript route is the durable one.
- **Volume.** `osascript -e 'set volume output volume N'`, as a small `volume.py` sibling.
- **Temps.** `powermetrics` needs root; `iStats` and `smc` are the usual third-party route.

The Dev scene needs nothing. `desko/collectors/git.py` shells out to `git` and the VS Code
extension is plain JavaScript, so both already work anywhere.

</details>

---

## Phone setup

<details open>
<summary><b>Three steps, once</b></summary>

1. **Open the URL** (or scan the QR with the phone camera).
2. **Add to Home Screen** via Chrome menu → *Add to home screen*. You get a fullscreen,
   chromeless app with a proper icon. Launch it from there, not from the browser.
3. **Keep the screen on.** Desko holds the display awake itself with a hidden always-playing
   video, the one trick that works over plain HTTP. For a permanently-mounted display, also
   enable Android's *Stay awake*:
   - Settings → About phone → tap **Build number** 7 times to unlock Developer options
   - Settings → System → Developer options → enable **Stay awake**
   - Keep it plugged in.

</details>

<details>
<summary><b>Optional: enable the real Wake Lock API (cheaper on the battery)</b></summary>

Desko's keep-awake falls back to a looping hidden video because the proper
[Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
requires a *secure context*, and `http://` on a LAN isn't one. Playing a video forever costs a
decoder instance and real battery.

You can grant the exception, once, on the phone:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Set **Enabled**, and enter `http://desko.local:7777` in the box
3. Relaunch Chrome

The bundled keep-awake shim feature-detects the native API and switches to it automatically,
with no code change. The entry is a full origin including the port, and Chrome sometimes
clears flags across major updates, so re-check it there if the screen starts sleeping again.

</details>

<details>
<summary><b>If the display freezes until you touch it</b></summary>

Android suspends timers and can drop a WiFi TCP connection without closing it. Desko detects
both. An unanswered ping for 15 s forces a reconnect, and a gap of over 2 s in the render tick
re-probes the link, so it recovers on its own within seconds. If it still stalls:

- Settings → Battery → **App battery management** → allow Chrome to run in the background.
  If you launched Desko from the home screen, that's a **separate** app entry, so set it there too.
- Turn off any **WiFi power-saving** toggle in the WiFi advanced settings.
- Enable the Wake Lock flag above, so keep-awake stops relying on the video fallback.

</details>

## Controls

| Gesture | Does |
|---|---|
| **Swipe** ← → | Previous / next scene (takes manual control) |
| **Double-tap** | Open the Desko home screen |
| **Tap a lyric line** | Seek the PC's playback to that moment (synced lyrics only) |
| 🔒 **Padlock** (top right) | Freeze the current scene so nothing auto-switches. Open = AUTO, closed = LOCKED |
| ⚡ **Bolt** (top right) | [Performance mode](#performance-mode), which flattens the theme for weak GPUs |
| ⛶ **Corners** (top left) | Fullscreen |

---

## Performance mode

Old phones have old GPUs. The Realme 3 this was built for chokes on full-resolution backdrop
blur, layered glows, and half a dozen infinite animations all compositing at once.

Tap the **⚡ bolt** in the system bar to strip all of it: no blur, no glows, no looping
animation, no scanline overlay, no edge-fade mask, opaque panels instead of translucent ones.
Same green-on-dark identity, same layout, none of the fill-rate cost.

- The setting sticks per device (`localStorage`), and applies **before first paint**, so
  there's no flash of the expensive theme on reload.
- Auto-enables by default if your phone has OS-level *Reduce motion* switched on. An explicit
  choice always wins over that.
- Force it from a URL with **`?perf=1`** or **`?perf=0`**. Useful because `localStorage` is
  per-origin, so `desko.local` and the raw IP keep separate settings.
- Measure it: **`?fps=1`** puts a live frame-time readout in the corner. Watch the `max`
  number while lyrics scroll, because that's where the difference shows, not in the average.

---

## Configuration

Two ways, both fine:

- **In the browser.** Open **`http://desko.local:7777/config`**, a settings page for the
  weather city, game list, Pomodoro lengths, rotation speed and port. It tells you which
  changes apply live and which need a restart.
- **By hand.** Edit **`config.json`** (created on first run from `config.example.json`) and
  restart.

```jsonc
{
  "host": "0.0.0.0",                  // "127.0.0.1" to keep it on this machine only
  "port": 7777,
  "mdns_name": "desko",               // stable URL name -> http://desko.local:7777
  "rotate_sec": 60,                   // seconds each scene holds in the carousel
  "weather_city": "",                 // e.g. "Pune, IN"; empty = auto-detect by IP
  "weather_lat": null,                // set both to skip geocoding entirely
  "weather_lon": null,
  "game_processes": ["cs2.exe"],      // lowercase .exe names -> Stats scene header
  "focus_work_min": 25,               // Pomodoro defaults
  "focus_break_min": 5,
  "override_timeout_sec": 300,        // how long a manual swipe holds before auto resumes
  "vscode_stale_sec": 45,             // no editor heartbeat for this long -> git takes over
  "git_repo_path": "",                // Dev fallback repo; empty = follow VS Code's workspace
  "lhm_enabled": true,                // LibreHardwareMonitor for temps + GPU
  "poll": {
    "media_sec": 0.3,                 // playhead freshness (karaoke sync depends on it)
    "sysstats_sec": 1.0,
    "temps_sec": 3.0,
    "weather_sec": 1800,
    "volume_sec": 0.5,
    "git_sec": 10                     // only polls while VS Code is NOT reporting
  }
}
```

> [!NOTE]
> Any key you leave out is filled from the defaults in `run.py`, so an old `config.json` keeps
> working after an update. You don't have to re-add new keys by hand.

---

## Per-scene setup

<details>
<summary><b>🎵 Music: now playing, lyrics, volume</b> &nbsp;(Windows)</summary>

Install `requirements-windows.txt` for `winsdk`. Then just play audio in any app or browser
tab **on the PC**. Windows' media session API sees Chrome, Edge, Brave, Spotify, and most
desktop players. Nothing to configure per-app.

**Lyrics** resolve through a chain, first hit wins:

1. `cache/lyrics/manual/<slug>.lrc`, a file you dropped in yourself
2. **LRCLIB** exact match, retried across cleaned-up query variants
3. **LRCLIB** search, looser matching, still synced
4. **lyrics.ovh**, an independent catalogue, plain text only

Step 2's cleanup matters more than it sounds. Windows reports whatever the browser tab is
called, so `Channa Mereya (Official Video) [Lyrics]` by `Arijit Singh - Topic` used to be a
guaranteed miss. It now resolves. Results are cached including "no lyrics", so instrumentals
aren't re-fetched every run, but a network failure is never cached as a miss.

**To force lyrics for a specific song**, drop an `.lrc` at
`cache/lyrics/manual/<artist>-<title>.lrc`, lowercase, with non-alphanumerics collapsed to `-`
(`arijit-singh-channa-mereya.lrc`). Bare `<title>.lrc` also matches, and `.txt` works for
unsynced text. Manual files are read *before* the cache, so edits apply on the next track
change with no restart.

**Volume.** The slider drives the PC's system master volume via `pycaw`, tracks changes you
make on the PC, and the speaker button mutes. Without `pycaw` the control just hides.

</details>

<details>
<summary><b>📊 Stats: temperatures and GPU load</b> &nbsp;(Windows, one-time install)</summary>

CPU, RAM and network need nothing but `psutil`. **Temps and GPU %** need
LibreHardwareMonitor, which this script installs for you:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/setup-lhm.ps1
```

It puts LHM (portable) under `%LOCALAPPDATA%\Desko\lhm` and registers an elevated scheduled
task `Desko-LibreHardwareMonitor` so it starts at login with the admin rights the sensors
need. Desko also **relaunches LHM itself** whenever temps go offline by triggering that task,
so there's no UAC prompt, and a closed or crashed LHM is back within about 20 s.

Re-running the script is safe. If LHM is already there it skips the download and just repairs
the task. Without any of it, the temperature widgets simply hide.

</details>

<details>
<summary><b>💻 Dev: VS Code and git</b> &nbsp;(any OS)</summary>

The Dev scene has **two independent data sources**, so it keeps working whether or not your
editor is open.

**1. The VS Code extension** (fast path). Copy it in:

```powershell
Copy-Item -Recurse vscode-extension "$env:USERPROFILE\.vscode\extensions\desko-status-0.1.0"
```

```bash
# macOS / Linux
cp -r vscode-extension ~/.vscode/extensions/desko-status-0.1.0
```

Then reload the window (`Ctrl/Cmd+Shift+P` → *Developer: Reload Window*). It reports the
workspace, branch, ahead/behind, the real changed-file list, the current file, **cursor
position and line ending**, and the **last commit**.

It's **event-driven**, not polled. It subscribes to the git extension's `state.onDidChange`
plus editor focus, selection and save events, so a branch switch reaches the phone in well
under a second. Identical payloads are dropped rather than re-sent, and a 15 s heartbeat
exists purely to prove the editor is alive. It also picks the repo that owns the file you're
actually looking at, so multi-root workspaces resolve correctly.

**2. The git collector** (the floor). When the extension stops reporting for
`vscode_stale_sec` (default 45 s), `desko/collectors/git.py` takes the section over and reads
the repo directly. The chip in the panel header changes from `ACTIVE` to `GIT`, and the
editor-only fields blank out rather than showing what happened to be open when you quit.

It follows whatever workspace VS Code last reported, **so it needs no configuration**. Open a
folder once and Desko remembers which repo to watch. Set `git_repo_path` to pin it somewhere
else. It also computes **today's commits and lines changed**, which rides along under either
source.

If neither source has data, auto-rotation skips the Dev scene entirely rather than parking
60 s on an empty screen. A manual swipe still lands on it.

</details>

<details>
<summary><b>🍅 Focus: Pomodoro</b> &nbsp;(any OS)</summary>

No setup at all. Open the Focus scene and press play. Work and break phases auto-flow, the
lengths are adjustable from the scene itself or `/config`, and the timer lives on the
**server**, so every connected device shows the same countdown and a page reload doesn't
reset it.

</details>

<details>
<summary><b>🌤️ Weather</b> &nbsp;(any OS)</summary>

Leave `weather_city` empty to auto-detect by IP, or set it explicitly (`"Bengaluru, IN"`,
`"Berlin, DE"`). Powered by Open-Meteo, free, no API key. Offline, the widget hides rather
than showing stale numbers.

</details>

---

## Launchers (Windows)

Four helpers ship in the repo root. All of them are optional, since `python run.py` is always
equivalent.

| File | Double-click behaviour | Use it when |
|---|---|---|
| **`desko.bat`** | Opens a console showing the URL and QR and streams the log. Closing the window (or `Ctrl+C`) stops the server. | **Normal use.** Right-click → *Send to* → *Desktop (create shortcut)* to keep it one click away. |
| **`desko-hidden.vbs`** | Starts with **no window at all** via `pythonw`; output is redirected to `desko.log`. | You want it running invisibly at all times, for example from `shell:startup`. |
| **`desko-stop.cmd`** | Finds whatever is LISTENING on the port and kills it. | Stopping the hidden launcher, which has no window to close. |
| **`scripts/setup-lhm.ps1`** | Installs LibreHardwareMonitor and its scheduled task (one UAC prompt). | Once, to enable temperatures and GPU load. |

Notes worth knowing:

- Both launchers **probe the port first** and refuse to start a second copy. A duplicate would
  just fail to bind and spam the log.
- Both `cd` to their own folder first, so double-clicking from anywhere works. `run.py`
  resolves `config.json` and `web/` relative to the project root.
- `desko.bat` forwards arguments, so `desko.bat --demo` and `desko.bat --port 8080` both work.
- The port is hardcoded as `7777` in all three scripts purely for the "already running" check.
  **If you change `port` in `config.json`, update it in these files too.** `run.py` itself
  always reads the real value from config.
- To autostart: press `Win+R`, type `shell:startup`, and drop a shortcut to `desko.bat`
  (visible) or `desko-hidden.vbs` (invisible) in the folder that opens.

---

## How it works

```
   PC (Windows / macOS / Linux)                        PHONE (any browser)
   ┌───────────────────────────────────┐               ┌────────────────────┐
   │  run.py                           │               │                    │
   │    │                              │               │   index.html       │
   │    ├─ aiohttp ──── GET /  ─────────────────────────▶   + app.js        │
   │    │               /static/*      │               │   + scenes/*.js    │
   │    │                              │               │                    │
   │    ├─ WebSocket /ws ◀═══════════════ diffs only ══▶   scene router     │
   │    │                              │               │                    │
   │    ├─ State ── set_section() ─────┤               │   ┌──────────────┐ │
   │    │    deep-compares, broadcasts │               │   │ idle  music  │ │
   │    │    only what changed         │               │   │ stats dev    │ │
   │    │                              │               │   │ focus        │ │
   │    ├─ collectors (8 async tasks)  │               │   └──────────────┘ │
   │    │   ├ media ──── winsdk/GSMTC ─┤ (WinRT thread)│                    │
   │    │   ├ lyrics ─── LRCLIB → ovh  │               │   POST /api/media  │
   │    │   ├ sysstats ─ psutil + WMI ─┤ (COM thread)  │◀── /api/volume ────┤
   │    │   ├ volume ─── pycaw ────────┤ (COM thread)  │                    │
   │    │   ├ weather ── Open-Meteo    │               └────────────────────┘
   │    │   └ git ────── git subprocess│
   │    │        ▲ takes over `dev` when the editor goes quiet
   │    ├─ focus ─── server-side timer │               ┌────────────────────┐
   │    ├─ context ─ scene carousel    │◀── POST ──────│  VS Code extension │
   │    └─ announce ─ mDNS desko.local │   /api/vscode └────────────────────┘
   └───────────────────────────────────┘                 event-driven, 15s heartbeat
```

One `aiohttp` process serves the static frontend and a WebSocket. Collectors run as async
tasks and push **state diffs only when something actually changes**, so the socket is quiet
when nothing is happening. Three collectors that touch COM or WinRT (`media`, `sysstats`,
`volume`) each own a dedicated thread, because those APIs are apartment-bound and would
otherwise block the event loop.

**The Dev section has two writers and one arbiter.** The VS Code extension POSTs on real
editor events. The server stamps `updatedAt` *only when the payload actually changed*, so an
idle editor costs zero WebSocket traffic. Liveness is tracked separately, off the wire
entirely, and the git collector watches it: when heartbeats stop, git claims the section.
`dev.source` tells the frontend which one it's looking at.

Scene selection is a **carousel**. Every scene gets equal air time (`rotate_sec`, default
60 s), wrapping `idle → music → stats → dev → focus`. A swipe overrides it for
`override_timeout_sec`; the padlock freezes it indefinitely. *(An earlier build picked scenes
by priority, but VS Code focus flickering made the display bounce between scenes every few
seconds, which the carousel removed entirely.)*

The frontend is vanilla HTML/CSS/JS. No framework, no bundler, no build step, no CDN
requests, ES5-flavoured syntax throughout, because the target device is an old Chromium on a
budget phone and every one of those choices was load-bearing.

**Design targets:** under 1% idle CPU, under 100 MB RAM, no database. See
`IMPLEMENTATION_PLAN.md` for the original architecture and the binding data contracts.

## Requirements

| | Needed for | Without it |
|---|---|---|
| **Python 3.11+** | everything | required |
| `aiohttp`, `psutil` | the server, CPU/RAM/net | required |
| `qrcode` | the terminal QR code | URL still prints |
| `zeroconf` | `http://desko.local` | numeric IP still works |
| `git` on PATH | Dev scene without VS Code | Dev needs the editor running |
| `winsdk` **(Win)** | Music scene, now playing | Music scene stays empty |
| `wmi` and `pywin32` **(Win)** | CPU/GPU temperatures | temp widgets hide |
| `pycaw` and `comtypes` **(Win)** | volume slider | slider hides |
| LibreHardwareMonitor | the sensors `wmi` reads | temp widgets hide |
| VS Code and the bundled extension | live editor state on Dev | git fallback covers the rest |

## Project layout

```
run.py                     entrypoint, prints URL + QR, starts the server
desko.bat                  Windows double-click launcher (single-instance guard)
desko-hidden.vbs           start with no console window at all, logs to desko.log
desko-stop.cmd             stop the hidden server
config.json                your settings (git-ignored, generated on first run)
config.example.json        reference config, committed

desko/
  server.py                aiohttp app, routes, WebSocket, collector lifecycle
  state.py                 shared state, diffing, pub/sub to connected clients
  context.py               scene carousel, override and lock handling
  focus.py                 server-side Pomodoro
  announce.py              mDNS, so desko.local survives DHCP
  demo.py                  --demo fake-data generator
  collectors/
    media.py               Windows GSMTC now-playing (own WinRT thread)
    lyrics.py              4-provider lyric chain plus cache
    sysstats.py            psutil + LibreHardwareMonitor over WMI (own COM thread)
    volume.py              system master volume via pycaw (own COM thread)
    weather.py             Open-Meteo
    vscode.py              POST /api/vscode ingest and validation
    git.py                 git fallback for the Dev scene, plus today's totals

web/                       vanilla frontend, no build step
  index.html               all five scenes plus the launcher
  css/style.css            the whole theme, including html.perf
  js/app.js                WebSocket client, scene router, gestures, keep-awake
  js/scenes/*.js           one module per scene
  config.html              the /config settings page

vscode-extension/          event-driven reporter (editor + git state -> POST /api/vscode)
scripts/setup-lhm.ps1      one-time LibreHardwareMonitor installer
THIRD-PARTY-NOTICES.md     bundled font and downloaded tool licensing
```

---

## Troubleshooting

<details>
<summary><b>Can't open the URL on the phone</b></summary>

The first run triggers a Windows Firewall prompt. Allow Python on **Private networks**. If you
dismissed it, re-run and allow it, or add the rule manually. Confirm both devices are on the
same WiFi, not one on 2.4 GHz guest and one on 5 GHz main.
</details>

<details>
<summary><b>The IP keeps changing, 192.168.0.4 one day and .7 the next</b></summary>

That's the router's DHCP lease. Use `http://desko.local:7777`, which follows the IP
automatically. If the phone is too old for mDNS (Android 10/11), add a **DHCP reservation**
for the PC's MAC in the router admin page. Desko prints the MAC under the QR at startup.
</details>

<details>
<summary><b><code>desko.local</code> shows "not a secure connection"</b></summary>

Chrome tried HTTPS. Type the full `http://desko.local:7777` including the scheme. On Android
10/11 there's no `.local` resolver at all, so use the numeric IP.
</details>

<details>
<summary><b>No music detected</b></summary>

Play audio in an app or tab **on the PC**, not on the phone, and make sure
`requirements-windows.txt` is installed (`winsdk`). Not available on macOS or Linux, see
[Platform support](#platform-support).
</details>

<details>
<summary><b>No temperatures or GPU load</b></summary>

LibreHardwareMonitor isn't running, or isn't elevated. Run `scripts/setup-lhm.ps1` once. Desko
relinks within about 20 s once LHM is up, with no restart needed.
</details>

<details>
<summary><b>No lyrics for a song</b></summary>

Not every track exists in LRCLIB or lyrics.ovh, and some only have unsynced text. Desko falls
back to plain, then to an art-only card. If you want a specific song fixed for good, drop an
`.lrc` into `cache/lyrics/manual/`, see the Music section above.
</details>

<details>
<summary><b>The Dev scene says GIT when VS Code is open</b></summary>

The extension isn't reporting. Check it's installed in the right folder for your editor
(`.vscode-insiders/extensions` for Insiders), reload the window, and run *Desko: Ping now*
from the command palette to force a report. If the scene says **OFFLINE** instead, there's no
repo to fall back to either, so set `git_repo_path` in `config.json`, or open a git workspace
in VS Code once so Desko learns the path.
</details>

<details>
<summary><b>The screen keeps turning off</b></summary>

Keep-awake needs one tap on the page to arm, because browser autoplay policy won't let it
start the hidden video without a gesture. Tap once after loading. For a permanent display,
enable Android's *Stay awake* as a backstop, or grant the Wake Lock flag described in Phone
setup.
</details>

<details>
<summary><b>The UI feels sluggish, or the lyrics stutter</b></summary>

Tap the ⚡ bolt for [performance mode](#performance-mode). Add `?fps=1` to the URL to see
whether it actually helped.
</details>

---

## Security

> [!IMPORTANT]
> **Desko has no authentication and is meant for your home LAN only.**

The server binds `0.0.0.0` by default, and anyone who can reach the port can read the
dashboard, control your PC's media playback and volume, and change settings via `/config`.
That's a deliberate trade for zero-friction setup on a trusted network.

- **Do not port-forward it** or expose it to the internet.
- **Don't run it on public or shared WiFi** such as cafés, hostels, offices or campus networks.
- To limit it to this machine while testing, set `"host": "127.0.0.1"` in `config.json`.

`config.json` is git-ignored because it holds your location and machine-specific settings.
Keep it that way if you fork this.

---

## License

Desko is licensed under the **[Desko Noncommercial License 1.0](LICENSE)**.

Copyright 2026 **typewriter03**.

In plain terms:

| You may | You may not |
|---|---|
| Use it personally, for hobby projects, study, experiments and private entertainment | **Sell it**, or use it for any commercial purpose |
| Modify it, build on it, and share your changes | Strip the license or the copyright notice |
| Use it at a charity, school, university, public research body, or government institution | Sublicense it or transfer your rights to someone else |

**Credit is mandatory, not a request.** The license's *Notices* section requires that anyone
who receives any part of Desko from you also receives a copy of these terms and the
`Required Notice:` line naming the copyright holder. That line sits at the top of
[`LICENSE`](LICENSE), so keeping the file intact is all it takes.

If you want to use Desko commercially, ask. The license is written so that a separate
agreement with the copyright holder is the way to get that.

<details>
<summary><b>Why this license and not MIT</b></summary>

MIT explicitly grants the right to **sell** the software, which is the opposite of the intent
here. So do Apache-2.0 and BSD. Creative Commons has a noncommercial variant, but Creative
Commons themselves recommend against using CC licenses for software, and their "NonCommercial"
wording is famously ambiguous at the edges.

What's in `LICENSE` instead is a short, plain-English noncommercial license: every
noncommercial use stays wide open (personal, hobby, study, charity, education, public research,
government), while commercial use is reserved to the copyright holder and available by asking.

Two trade-offs worth knowing:

- Because it restricts a field of use, this is **not** "open source" as the OSI defines the
  term. Some package registries, Linux distros and corporate policies exclude such licenses on
  principle. In exchange, nobody can take Desko, close it up and sell it.
- It grants **copyright rights only**. No patent license is granted, and the *No Other Rights*
  section makes that explicit by stating that these terms imply no other licenses.

**The warranty disclaimer is not optional boilerplate.** The *No Liability* section is this
license's equivalent of MIT's `AS IS` block, and it's the one paragraph that protects the
author rather than the user. It disclaims implied warranties (merchantability, fitness for a
particular purpose) that some jurisdictions otherwise read into any supply of software, and it
caps liability for damages. Desko launches LibreHardwareMonitor with administrator rights and
reads hardware sensors, so that clause matters more here than it would for a static site.

</details>

<details>
<summary><b>Do I need a license at all? (short version, for anyone reading this repo)</b></summary>

Yes. Three facts that surprise most people:

1. **Copyright is automatic.** You own what you wrote the moment you wrote it. There's no form
   to file and no fee for the copyright itself to exist.
2. **Public on GitHub does not mean free to use.** With no LICENSE file, the default is *all
   rights reserved*. People may read your code but have no legal right to copy, modify or run
   it. The license is what changes that.
3. **Adding one is the entire procedure.** A text file in the repo root plus your name on the
   notice line. No lawyer, no registration, no paperwork.

Registration is a separate, optional thing. Some countries let you register a copyright with a
government office for a fee, which mainly matters if you intend to sue for statutory damages.
For a desk dashboard, skip it.

</details>

Third-party material, namely the bundled **Geist Mono** font (SIL OFL 1.1) and
**LibreHardwareMonitor** (MPL-2.0, downloaded at runtime rather than redistributed), is
documented in **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**.
