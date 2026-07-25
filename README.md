<div align="center">

# ⌁ DESKO

**Turn a spare phone into an always-on desk dashboard.**

Music with karaoke lyrics · live PC vitals · git status · a clock that actually looks good ·
a Pomodoro timer — pushed from your Windows PC to any old phone on your WiFi.

[![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/server-Windows-0078D4?style=flat-square&logo=windows&logoColor=white)](#requirements)
[![Frontend](https://img.shields.io/badge/frontend-vanilla%20JS-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](#how-it-works)
[![No build step](https://img.shields.io/badge/build%20step-none-82f59b?style=flat-square)](#how-it-works)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## What it is

That old phone in your drawer has a perfectly good screen. Desko gives it a job.

A **single lightweight Python process** runs on your Windows PC, collects things worth
looking at, and pushes them over a WebSocket to **one browser tab** on the phone sitting
on your desk stand. No app to install, no account, no cloud, no build tooling — you open
a URL and it just runs, forever.

The display cycles through five scenes on a timer. Swipe to take manual control, tap the
padlock to pin one.

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │ ⛶  DESKO OS 0.8.5   │ ● LINKED  OMEN-PC  192.168.0.7 │ 21:04  🔋87% ⚡🔒│
   ├──────────────────────────────────────────────────────────────────────┤
   │  ┌────────────┐   MEDIA.TRACK                            PLAYING     │
   │  │            │   DALER MEHNDI · DANGAL                              │
   │  │  ▓▓ album  │   ┌─ LYRICS ─────────────────────────────────────┐   │
   │  │  ▓▓  art   │   │      dhaakad dhaakad dhaakad                 │   │
   │  │            │   │  ▌ bapu sehat ke liye tu toh                 │   │  ← active line
   │  └────────────┘   │      haanikaarak hai                         │   │     glows + scrolls
   │  ◉ YT MUSIC       │      dangal dangal                           │   │
   │                   └──────────────────────────────────────────────┘   │
   │  0:44 ▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░ -4:15    ⏮   ⏸   ⏭   🔊              │
   └──────────────────────────────────────────────────────────────────────┘
        ambient background = the album art, blurred, filling the whole screen
```

Everything degrades gracefully. No media playing, no LibreHardwareMonitor, no VS Code —
those widgets just hide. Nothing crashes, nothing shows a dead `—`.

## The five scenes

| | Scene | What's on it |
|:--:|---|---|
| 🕐 | **Idle** | Big IST clock + London secondary, date, live weather, phone battery, link latency, PC uptime |
| 🎵 | **Music** | Album art as an ambient blurred backdrop, **synced karaoke lyrics**, transport + volume control of the *PC*, per-track colour theming pulled from the cover |
| 📊 | **Stats** | CPU/GPU load and temperature, RAM, network up/down, 60-second sparklines, session timer, game name when a configured process is running |
| 💻 | **Dev** | Workspace, git branch, ahead/behind, the real changed-file list, current file — live while VS Code is open |
| 🍅 | **Focus** | Pomodoro countdown ring, work/break auto-flow, cycle counter, adjustable lengths. Server-side, so it's identical on every device and survives reloads |

<div align="center">

**Rotation order** &nbsp;·&nbsp; `idle → music → stats → dev → focus` &nbsp;·&nbsp; wrapping, `rotate_sec` each

</div>

---

## Quick start

```powershell
git clone https://github.com/<you>/Desko.git
cd Desko
python -m pip install -r requirements.txt
python -m pip install -r requirements-windows.txt   # Windows: media, temps, volume
python run.py
```

The terminal prints two URLs and a scannable QR code. Open one on your phone's browser —
same WiFi, that's the only requirement.

> [!TIP]
> **Windows shortcut:** double-click **`desko.bat`** instead. It keeps a window open showing
> the URL and QR, and closing the window stops the server. Running it twice just tells you
> it's already up. Right-click → *Send to* → *Desktop (create shortcut)* if you want it one click away.

### Which URL to save

| URL | Use it when |
|---|---|
| **`http://desko.local:7777`** ⭐ | **Save this one.** An mDNS name that keeps working when the router hands your PC a different IP. Works on iOS, macOS, Windows, Linux, **Android 12+**. Always type the full `http://` so Chrome doesn't force HTTPS. |
| `http://<current-ip>:7777` | Also in the QR. Changes whenever the DHCP lease moves. On **Android 10/11** there's no `.local` resolver, so you need this one — make it permanent with a **DHCP reservation** in your router for the PC's MAC (Desko prints the MAC under the QR). |

### Try it with nothing running

```powershell
python run.py --demo        # or:  desko.bat --demo
```

Demo mode fabricates every scene — media, lyrics, stats, git, weather — and cycles them
every 20 s. Works on any OS with zero setup, no Windows deps needed.

---

## Phone setup

<details open>
<summary><b>Three steps, once</b></summary>

1. **Open the URL** (or scan the QR with the phone camera).
2. **Add to Home Screen** — Chrome menu → *Add to Home screen*. You get a fullscreen,
   chromeless app with a proper icon. Launch it from there, not from the browser.
3. **Keep the screen on.** Desko holds the display awake itself (a hidden always-playing
   video — the one trick that works over plain HTTP). For a permanently-mounted display,
   also enable Android's *Stay awake*:
   - Settings → About phone → tap **Build number** 7× to unlock Developer options
   - Settings → System → Developer options → enable **Stay awake**
   - Keep it plugged in.

</details>

<details>
<summary><b>Optional: enable the real Wake Lock API (cheaper on the battery)</b></summary>

Desko's keep-awake falls back to a looping hidden video because the proper
[Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
requires a *secure context*, and `http://` on a LAN isn't one. Playing a video forever
costs a decoder instance and real battery.

You can grant the exception, once, on the phone:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Set **Enabled**, and enter `http://desko.local:7777` in the box
3. Relaunch Chrome

The bundled NoSleep.js feature-detects the native API and switches to it automatically —
no code change. The entry is a full origin including the port, and Chrome sometimes clears
flags across major updates, so re-check it there if the screen starts sleeping again.

</details>

## Controls

| Gesture | Does |
|---|---|
| **Swipe** ← → | Previous / next scene (takes manual control) |
| **Double-tap** | Open the Desko home screen |
| **Tap a lyric line** | Seek the PC's playback to that moment (synced lyrics only) |
| 🔒 **Padlock** (top right) | Freeze the current scene — nothing auto-switches. Open = AUTO, closed = LOCKED |
| ⚡ **Bolt** (top right) | [Performance mode](#performance-mode) — flattens the theme for weak GPUs |
| ⛶ **Corners** (top left) | Fullscreen |

---

## Performance mode

Old phones have old GPUs. The Realme 3 this was built for chokes on full-resolution
backdrop blur, layered glows, and half a dozen infinite animations all compositing at once.

Tap the **⚡ bolt** in the system bar to strip all of it: no blur, no glows, no looping
animation, no scanline overlay, no edge-fade mask, opaque panels instead of translucent
ones. Same green-on-dark identity, same layout, none of the fill-rate cost.

- The setting sticks per device (`localStorage`), and applies **before first paint** — no
  flash of the expensive theme on reload.
- Auto-enables by default if your phone has OS-level *Reduce motion* switched on. An
  explicit choice always wins over that.
- Force it from a URL with **`?perf=1`** or **`?perf=0`** — useful because `localStorage`
  is per-origin, so `desko.local` and the raw IP keep separate settings.
- Measure it: **`?fps=1`** puts a live frame-time readout in the corner. Watch the `max`
  number while lyrics scroll — that's where the difference shows, not in the average.

---

## Configuration

Two ways, both fine:

- **In the browser** — open **`http://desko.local:7777/config`**. A settings page for the
  weather city, game list, Pomodoro lengths, rotation speed and port. It tells you which
  changes apply live and which need a restart.
- **By hand** — edit **`config.json`** (created on first run from `config.example.json`)
  and restart.

```jsonc
{
  "port": 7777,
  "mdns_name": "desko",               // stable URL name -> http://desko.local:7777
  "rotate_sec": 60,                   // seconds each scene holds in the carousel
  "weather_city": "",                 // e.g. "Pune, IN"; empty = auto-detect by IP
  "game_processes": ["cs2.exe"],      // lowercase .exe names -> Stats scene header
  "focus_work_min": 25,               // Pomodoro defaults
  "focus_break_min": 5,
  "override_timeout_sec": 300,        // how long a manual swipe holds before auto resumes
  "lhm_enabled": true                 // LibreHardwareMonitor for temps + GPU
}
```

---

## Per-scene setup

<details>
<summary><b>🎵 Music — now playing, lyrics, volume</b> &nbsp;(Windows)</summary>

Install `requirements-windows.txt` for `winsdk`. Then just play audio in any app or browser
tab **on the PC** — Windows' media session API sees Chrome, Edge, Brave, Spotify, and most
desktop players. Nothing to configure per-app.

**Lyrics** resolve through a chain, first hit wins:

1. `cache/lyrics/manual/<slug>.lrc` — a file you dropped in yourself
2. **LRCLIB** exact match, retried across cleaned-up query variants
3. **LRCLIB** search — looser matching, still synced
4. **lyrics.ovh** — independent catalogue, plain text only

Step 2's cleanup matters more than it sounds: Windows reports whatever the browser tab is
called, so `Channa Mereya (Official Video) [Lyrics]` by `Arijit Singh - Topic` used to be a
guaranteed miss. It now resolves. Results are cached including "no lyrics", so instrumentals
aren't re-fetched every run — but a network failure is never cached as a miss.

**To force lyrics for a specific song**, drop an `.lrc` at
`cache/lyrics/manual/<artist>-<title>.lrc` — lowercase, non-alphanumerics collapsed to `-`
(`arijit-singh-channa-mereya.lrc`). Bare `<title>.lrc` also matches, and `.txt` works for
unsynced text. Manual files are read *before* the cache, so edits apply on the next track
change with no restart.

**Volume** — the slider drives the PC's system master volume via `pycaw`, tracks changes you
make on the PC, and the speaker button mutes. Without `pycaw` the control just hides.

</details>

<details>
<summary><b>📊 Stats — temperatures and GPU load</b> &nbsp;(Windows, one-time install)</summary>

CPU, RAM and network need nothing but `psutil`. **Temps and GPU %** need
LibreHardwareMonitor, which this script installs for you:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/setup-lhm.ps1
```

It puts LHM (portable) under `%LOCALAPPDATA%\Desko\lhm` and registers an elevated scheduled
task `Desko-LibreHardwareMonitor` so it starts at login with the admin rights the sensors
need. Desko also **relaunches LHM itself** whenever temps go offline — it triggers that task,
so no UAC prompt — and a closed or crashed LHM is back within ~20 s.

Re-running the script is safe: if LHM is already there it skips the download and just
repairs the task. Without any of it, the temperature widgets simply hide.

</details>

<details>
<summary><b>💻 Dev — VS Code integration</b></summary>

Copy the bundled reporter extension into your extensions folder:

```powershell
Copy-Item -Recurse vscode-extension "$env:USERPROFILE\.vscode\extensions\desko-status-0.0.2"
```

Restart VS Code. It reports workspace, branch, ahead/behind, the real changed-file list,
dirty count and the current file every 10 s and on editor switches, reading the first git
repository in the workspace. Switch branches normally and the dashboard follows. Close VS
Code (or leave it idle 45 s) and the scene shows it as stale.

</details>

<details>
<summary><b>🍅 Focus — Pomodoro</b></summary>

No setup at all. Open the Focus scene and press play. Work and break phases auto-flow, the
lengths are adjustable from the scene itself or `/config`, and the timer lives on the
**server** — so every connected device shows the same countdown and a page reload doesn't
reset it.

</details>

<details>
<summary><b>🌤️ Weather</b></summary>

Leave `weather_city` empty to auto-detect by IP, or set it explicitly
(`"Bengaluru, IN"`, `"Berlin, DE"`). Powered by Open-Meteo — free, no API key. Offline, the
widget hides rather than showing stale numbers.

</details>

---

## How it works

```
   WINDOWS PC                                          PHONE (any browser)
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
   │    ├─ collectors (async tasks)    │               │   └──────────────┘ │
   │    │   ├ media ──── winsdk/GSMTC ─┤ (WinRT thread)│                    │
   │    │   ├ lyrics ─── LRCLIB → ovh  │               │   POST /api/media  │
   │    │   ├ sysstats ─ psutil + WMI ─┤ (COM thread)  │◀── /api/volume ────┤
   │    │   ├ volume ─── pycaw ────────┤ (COM thread)  │                    │
   │    │   └ weather ── Open-Meteo    │               └────────────────────┘
   │    │                              │
   │    ├─ focus ─── server-side timer │               ┌────────────────────┐
   │    ├─ context ─ scene carousel    │◀── POST ──────│  VS Code extension │
   │    └─ announce ─ mDNS desko.local │   /api/vscode └────────────────────┘
   └───────────────────────────────────┘
```

One `aiohttp` process serves the static frontend and a WebSocket. Collectors run as async
tasks and push **state diffs only when something actually changes** — the socket is quiet
when nothing is happening. Three collectors that touch COM or WinRT (`media`, `sysstats`,
`volume`) each own a dedicated thread, because those APIs are apartment-bound and would
otherwise block the event loop.

Scene selection is a **carousel**: every scene gets equal air time (`rotate_sec`, default
60 s), wrapping `idle → music → stats → dev → focus`. A swipe overrides it for
`override_timeout_sec`; the padlock freezes it indefinitely. *(An earlier build picked
scenes by priority, but VS Code focus flickering made the display bounce between scenes
every few seconds — the carousel removed that entirely.)*

The frontend is vanilla HTML/CSS/JS. No framework, no bundler, no build step, no CDN
requests, ES5-flavoured syntax throughout — because the target device is an old Chromium on
a budget phone and every one of those choices was load-bearing.

**Design targets:** <1% idle CPU, <100 MB RAM, no database. See `IMPLEMENTATION_PLAN.md`
for the original architecture and the binding data contracts.

## Requirements

| | Needed for | Without it |
|---|---|---|
| **Python 3.11+** | everything | — |
| `aiohttp`, `psutil` | the server, CPU/RAM/net | required |
| `qrcode` | the terminal QR code | URL still prints |
| `zeroconf` | `http://desko.local` | numeric IP still works |
| `winsdk` **(Win)** | Music scene / now playing | Music scene stays empty |
| `wmi` + `pywin32` **(Win)** | CPU/GPU temperatures | temp widgets hide |
| `pycaw` + `comtypes` **(Win)** | volume slider | slider hides |
| LibreHardwareMonitor | the sensors `wmi` reads | temp widgets hide |
| VS Code + bundled extension | Dev scene | Dev scene shows as idle |

The server boots on macOS and Linux too — the Windows-only collectors are import-guarded,
so you get idle/weather/focus and a working `--demo`. Useful for frontend work.

## Project layout

```
run.py                     entrypoint — prints URL + QR, starts the server
desko.bat                  Windows double-click launcher (single-instance guard)
desko-hidden.vbs           start with no console window at all → logs to desko.log
desko-stop.cmd             stop the hidden server
config.json                your settings (git-ignored, generated on first run)
config.example.json        reference config, committed

desko/
  server.py                aiohttp app, routes, WebSocket, collector lifecycle
  state.py                 shared state, diffing, pub/sub to connected clients
  context.py               scene carousel + override/lock handling
  focus.py                 server-side Pomodoro
  announce.py              mDNS, so desko.local survives DHCP
  demo.py                  --demo fake-data generator
  collectors/              media · lyrics · sysstats · volume · weather · vscode

web/                       vanilla frontend, no build step
  index.html               all five scenes + the launcher
  css/style.css            the whole theme, including html.perf
  js/app.js                WebSocket client, scene router, gestures, keep-awake
  js/scenes/*.js           one module per scene
  config.html              the /config settings page

vscode-extension/          tiny reporter (workspace + git status → POST /api/vscode)
scripts/setup-lhm.ps1      one-time LibreHardwareMonitor installer
```

---

## Troubleshooting

<details>
<summary><b>Can't open the URL on the phone</b></summary>

The first run triggers a Windows Firewall prompt — allow Python on **Private networks**. If
you dismissed it, re-run and allow it, or add the rule manually. Confirm both devices are on
the same WiFi (not one on 2.4 GHz guest and one on 5 GHz main).
</details>

<details>
<summary><b>The IP keeps changing — 192.168.0.4 one day, .7 the next</b></summary>

That's the router's DHCP lease. Use `http://desko.local:7777`, which follows the IP
automatically. If the phone is too old for mDNS (Android 10/11), add a **DHCP reservation**
for the PC's MAC in the router admin page — Desko prints the MAC under the QR at startup.
</details>

<details>
<summary><b><code>desko.local</code> shows "not a secure connection"</b></summary>

Chrome tried HTTPS. Type the full `http://desko.local:7777` including the scheme. On Android
10/11 there's no `.local` resolver at all — use the numeric IP.
</details>

<details>
<summary><b>No music detected</b></summary>

Play audio in an app or tab **on the PC**, not on the phone, and make sure
`requirements-windows.txt` is installed (`winsdk`).
</details>

<details>
<summary><b>No temperatures or GPU load</b></summary>

LibreHardwareMonitor isn't running, or isn't elevated. Run `scripts/setup-lhm.ps1` once.
Desko relinks within ~20 s once LHM is up — no restart needed.
</details>

<details>
<summary><b>No lyrics for a song</b></summary>

Not every track exists in LRCLIB or lyrics.ovh, and some only have unsynced text. Desko
falls back plain → art-only card. If you want a specific song fixed for good, drop an `.lrc`
into `cache/lyrics/manual/` — see the Music section above.
</details>

<details>
<summary><b>The screen keeps turning off</b></summary>

Keep-awake needs one tap on the page to arm (browser autoplay policy — it can't start the
hidden video without a gesture). Tap once after loading. For a permanent display, enable
Android's *Stay awake* as a backstop, or grant the Wake Lock flag described in Phone setup.
</details>

<details>
<summary><b>The UI feels sluggish / the lyrics stutter</b></summary>

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
- **Don't run it on public or shared WiFi** (cafés, hostels, offices, campus networks).
- To limit it to this machine while testing, set `"host": "127.0.0.1"` in `config.json`.

`config.json` is git-ignored because it holds your location and machine-specific settings —
keep it that way if you fork this.

## License

MIT — see [LICENSE](LICENSE). Put your own name on the copyright line.
