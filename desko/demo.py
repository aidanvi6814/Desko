"""Demo mode (IMPLEMENTATION_PLAN §11).

Fabricates plausible media + lyrics + sys + dev + weather data and cycles the
scene every 20 s, reusing the real State broadcast path so the frontend can't
tell it apart from live data. Lets every scene be exercised on any machine with
no media / LibreHardwareMonitor / VS Code extension installed.
"""
import asyncio
import logging
import random
import time

log = logging.getLogger("desko.demo")

SCENES = ("music", "stats", "dev", "idle")
SCENE_SEC = 20.0

DEMO_LYRIC_LINES = [
    "Is this the demo life",
    "Streaming through the air",
    "Every word in time",
    "With the music playing there",
    "A spare phone on the desk",
    "Showing what it can do",
    "Desko keeps the rhythm",
    "Turning data into view",
    "So the screen stays alive",
    "Even when nothing is new",
]


def _spark(seed, n, lo, hi, step):
    out = []
    v = seed
    for _ in range(n):
        v = max(lo, min(hi, v + random.uniform(-step, step)))
        out.append(round(v, 1))
    return out


async def start(state, config, session) -> None:
    log.info("demo mode active — cycling scenes every %.0fs", SCENE_SEC)

    now = time.time()
    state.set_section(
        "weather",
        {
            "tempC": 21.0, "feelsC": 20.2, "code": 2, "label": "Partly cloudy",
            "icon": "clouds", "hiC": 24.0, "loC": 18.0, "city": "Demo City",
            "updatedAt": now,
        },
    )
    state.set_section(
        "dev",
        {
            "workspace": "Desko", "branch": "main", "dirty": 2,
            "file": "server.py", "lang": "python", "focused": True, "updatedAt": now,
        },
    )
    state.set_section(
        "lyrics",
        {
            "trackKey": "Demo||Sunshine",
            "synced": [[i * 5.0, line] for i, line in enumerate(DEMO_LYRIC_LINES)],
            "plain": "\n".join(DEMO_LYRIC_LINES),
            "found": True,
        },
    )

    idx = 0
    state.set_scene(SCENES[0], reason="auto", override=None)

    last_scene = time.monotonic()
    last_tick = time.monotonic()
    pos = 0.0
    cpu_hist = _spark(12.0, 60, 2, 60, 4)
    gpu_hist = _spark(30.0, 60, 5, 80, 6)
    net_hist = _spark(120.0, 60, 20, 900, 90)
    cpu_temp = 55.0
    gpu_temp = 60.0
    cpu = 12.0
    gpu = 30.0

    while True:
        now_m = time.monotonic()
        dt = now_m - last_tick
        last_tick = now_m

        if now_m - last_scene > SCENE_SEC:
            last_scene = now_m
            idx = (idx + 1) % len(SCENES)
            scene = SCENES[idx]
            state.set_scene(scene, reason="auto", override=None)
            if scene == "music":
                pos = 0.0
            if scene == "idle" and state.get("media") is not None:
                state.set_section("media", None)
        scene = SCENES[idx]

        if scene == "music":
            pos += dt
            if pos > 50.0:
                pos = 0.0
            state.patch_section(
                "media",
                {
                    "playing": True, "title": "Sunshine", "artist": "Demo",
                    "album": "Demo", "artDataUrl": "", "sourceApp": "demo",
                    "positionSec": round(pos, 2), "durationSec": 50.0,
                    "updatedAt": time.time(),
                },
            )
        elif scene == "stats":
            cpu = max(2.0, min(95.0, cpu + random.uniform(-6, 6)))
            gpu = max(5.0, min(95.0, gpu + random.uniform(-7, 7)))
            cpu_temp = max(30.0, min(85.0, cpu_temp + random.uniform(-0.6, 0.6)))
            gpu_temp = max(35.0, min(90.0, gpu_temp + random.uniform(-0.7, 0.7)))
            cpu_hist.append(round(cpu, 1))
            gpu_hist.append(round(gpu, 1))
            net_down = round(random.uniform(50, 900), 1)
            net_hist.append(net_down)
            per = [round(max(2, min(100, cpu + random.uniform(-12, 12))), 1) for _ in range(8)]
            state.set_section(
                "sys",
                {
                    "cpuPercent": round(cpu, 1), "perCore": per,
                    "ramPercent": 62.0, "ramUsedGb": 9.8, "ramTotalGb": 16.0,
                    "netUpKbs": round(random.uniform(2, 40), 1),
                    "netDownKbs": net_down,
                    "gpuPercent": round(gpu, 1),
                    "cpuTempC": round(cpu_temp, 1), "gpuTempC": round(gpu_temp, 1),
                    "history": {"cpu": list(cpu_hist)[-60:], "gpu": list(gpu_hist)[-60:], "net": list(net_hist)[-60:]},
                },
            )
        elif scene == "dev":
            state.patch_section("dev", {"updatedAt": time.time(), "focused": True})
        # idle: nothing to fabricate; the clock + weather drive the scene.

        await asyncio.sleep(1.0)
