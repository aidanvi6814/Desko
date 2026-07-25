"""System stats collector — psutil + LibreHardwareMonitor WMI (§7.3).

Fast loop (poll.sysstats_sec, 1s): CPU %, per-core, RAM, network KB/s via psutil.
Slow loop (poll.temps_sec, 3s): CPU/GPU temps + GPU load via LibreHardwareMonitor's
WMI namespace (root\\LibreHardwareMonitor). WMI is blocking COM -> run in a thread.
If LHM isn't installed/running the namespace lookup throws once; we then degrade
silently forever (temps/gpu stay null, frontend hides those widgets).
"""
import asyncio
import collections
import logging
import threading
import time

import psutil

log = logging.getLogger("desko.sysstats")

HAS_WMI = False
try:
    import wmi as _wmi

    HAS_WMI = True
except ImportError:
    pass

HIST = 60

# Login task registered by scripts/setup-lhm.ps1. Because elevation is baked
# into the task principal, *anyone* who owns the task can start it without a
# UAC prompt -- which lets the server revive LHM when temps go offline.
LHM_TASK = "Desko-LibreHardwareMonitor"


def _lhm_process_running() -> bool:
    try:
        for p in psutil.process_iter(["name"]):
            if (p.info.get("name") or "").lower() == "librehardwaremonitor.exe":
                return True
    except Exception:
        pass
    return False


def _try_start_lhm() -> bool:
    """Start LHM via its elevated scheduled task. Blocking; call off-loop.

    No-op (False) when LHM is already running (don't spawn a second instance
    while it's still warming up its sensor table) or when the task was never
    registered -- that's setup-lhm.ps1 territory, not ours.
    """
    import subprocess

    if _lhm_process_running():
        return False
    try:
        rc = subprocess.run(
            ["schtasks", "/run", "/tn", LHM_TASK],
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=10,
        ).returncode
    except Exception:
        return False
    return rc == 0


def _query_lhm(w):
    """Pick CPU/GPU temp + GPU load from LHM's WMI Sensor table. Blocking.

    Returns ``(data, sensor_count)``. ``sensor_count == 0`` is the important
    case: LHM registered the ``root\\LibreHardwareMonitor`` namespace on a past
    run (so the namespace lookup succeeds) but the app isn't currently running,
    so the Sensor table is empty. Callers must treat that as "offline", not as
    "linked" -- otherwise the server reports success while every temp is null.
    """
    sensors = w.query("SELECT Name, SensorType, Value FROM Sensor")
    cpu_temp = None
    cpu_temp_fb = None
    gpu_temp = None
    gpu_load = None
    for s in sensors:
        name = s.Name or ""
        stype = s.SensorType or ""
        val = s.Value
        if stype == "Temperature":
            if "CPU Package" in name or "Core (Tctl/Tdie)" in name or "Core (Tctl)" in name:
                cpu_temp = val
            elif "CPU" in name and cpu_temp_fb is None:
                cpu_temp_fb = val
            elif "GPU Core" in name and gpu_temp is None:
                gpu_temp = val
        elif stype == "Load":
            if "GPU Core" in name and gpu_load is None:
                gpu_load = val
    if cpu_temp is None:
        cpu_temp = cpu_temp_fb
    return {"cpuTempC": cpu_temp, "gpuTempC": gpu_temp, "gpuPercent": gpu_load}, len(sensors)


def _lhm_thread_main(shared, temps_interval, stop_event):
    """Poll LibreHardwareMonitor over WMI on a dedicated COM-initialized thread.

    WMI is COM, and COM objects are apartment-bound: the object must be created
    AND queried on the SAME thread, and that thread must have called
    CoInitialize first. The previous version used ``asyncio.to_thread``, which
    runs each call on an arbitrary thread-pool worker with no CoInitialize ->
    the "running inside a thread without first calling pythoncom.CoInitialize"
    error, and even when it happened to work it marshaled the WMI proxy across
    threads. One dedicated thread (mirroring the media collector) fixes both.
    """
    try:
        import pythoncom
    except ImportError:
        log.info("pythoncom (pywin32) not available -- temps/GPU disabled")
        return
    pythoncom.CoInitialize()
    try:
        w = None
        online = False   # are sensors actually flowing right now?
        retry_sec = 20.0
        last_kick = 0.0  # monotonic ts of the last auto-start attempt

        def _go_offline():
            """Blank the shared temps so the frontend shows 'LHM offline'."""
            shared["cpuTempC"] = None
            shared["gpuTempC"] = None
            shared["gpuPercent"] = None

        def _kick_lhm():
            """Auto-start LHM (throttled) so temps come back without the user
            having to launch it by hand. Runs on this dedicated thread, so
            the blocking schtasks call can't stall the event loop."""
            nonlocal last_kick
            if time.monotonic() - last_kick < 300:
                return
            last_kick = time.monotonic()
            if _try_start_lhm():
                log.info("LHM offline -- started it via scheduled task '%s'", LHM_TASK)

        # Single loop that (re)acquires the namespace, polls it, and downgrades
        # to "offline" whenever the Sensor table is empty or a query throws --
        # so a late-starting, restarted, or closed LHM is tracked live without a
        # server restart. Acquiring the namespace is NOT enough: it persists in
        # the WMI repository after LHM exits, so we only report "linked" once a
        # query returns actual sensors.
        while not stop_event.is_set():
            if w is None:
                try:
                    w = _wmi.WMI(namespace=r"root\LibreHardwareMonitor")
                except Exception as e:
                    log.info(
                        "LibreHardwareMonitor WMI namespace not available yet, "
                        "retrying in %.0fs (%s)", retry_sec, e,
                    )
                    _kick_lhm()
                    stop_event.wait(retry_sec)
                    continue

            try:
                res, count = _query_lhm(w)
            except Exception as e:
                # Provider went away (LHM closed) -> drop the handle, re-acquire.
                if online:
                    log.info("LibreHardwareMonitor stopped responding (%s); retrying", e)
                online = False
                _go_offline()
                w = None
                _kick_lhm()
                stop_event.wait(retry_sec)
                continue

            if count == 0:
                # Namespace exists but no sensors -> LHM isn't running.
                if online:
                    log.info("LibreHardwareMonitor has no sensors (LHM not running?); showing offline")
                online = False
                _go_offline()
                _kick_lhm()
                stop_event.wait(retry_sec)
                continue

            if not online:
                log.info("LibreHardwareMonitor linked and providing data (%d sensors)", count)
                online = True
            shared["cpuTempC"] = res["cpuTempC"]
            shared["gpuTempC"] = res["gpuTempC"]
            shared["gpuPercent"] = res["gpuPercent"]
            stop_event.wait(temps_interval)
    finally:
        pythoncom.CoUninitialize()


async def start(state, config, session) -> None:
    interval = float(config.get("poll", {}).get("sysstats_sec", 1.0))
    temps_interval = float(config.get("poll", {}).get("temps_sec", 3.0))
    lhm_enabled = bool(config.get("lhm_enabled", True))

    # Prime cpu_percent so the first reading isn't 0.0 (gotcha #5).
    psutil.cpu_percent(interval=None, percpu=True)

    cpu_hist = collections.deque(maxlen=HIST)
    gpu_hist = collections.deque(maxlen=HIST)
    net_hist = collections.deque(maxlen=HIST)  # download KB/s, auto-scaled client-side
    shared = {"gpuPercent": None, "cpuTempC": None, "gpuTempC": None}

    # LHM temps/GPU run on a dedicated COM-initialized thread (see
    # _lhm_thread_main). It only writes scalar values into `shared`; this async
    # loop reads them and owns the gpu sparkline history, so the deque is never
    # mutated from two threads.
    stop_event = threading.Event()
    if lhm_enabled and HAS_WMI:
        threading.Thread(
            target=_lhm_thread_main,
            args=(shared, temps_interval, stop_event),
            daemon=True,
            name="desko-lhm",
        ).start()
    elif lhm_enabled and not HAS_WMI:
        log.info("wmi/pywin32 not available -- temps/GPU disabled")

    net_last = psutil.net_io_counters()
    last_time = time.monotonic()
    try:
        while True:
            try:
                per = psutil.cpu_percent(interval=None, percpu=True)
                cpu_avg = sum(per) / len(per) if per else 0.0
                vm = psutil.virtual_memory()
                net = psutil.net_io_counters()
                now = time.monotonic()
                dt = max(now - last_time, 1e-6)
                up_kbs = (net.bytes_sent - net_last.bytes_sent) / 1024.0 / dt
                dn_kbs = (net.bytes_recv - net_last.bytes_recv) / 1024.0 / dt
                net_last = net
                last_time = now
                cpu_hist.append(round(cpu_avg, 1))
                net_hist.append(round(dn_kbs, 1))
                gpu = shared["gpuPercent"]
                if gpu is not None:
                    gpu_hist.append(round(float(gpu), 1))
                sysd = {
                    "cpuPercent": round(cpu_avg, 1),
                    "perCore": [round(x, 1) for x in per],
                    "ramPercent": round(vm.percent, 1),
                    "ramUsedGb": round(vm.used / (1024 ** 3), 2),
                    "ramTotalGb": round(vm.total / (1024 ** 3), 2),
                    "netUpKbs": round(up_kbs, 1),
                    "netDownKbs": round(dn_kbs, 1),
                    "gpuPercent": round(gpu, 1) if gpu is not None else None,
                    "cpuTempC": shared["cpuTempC"],
                    "gpuTempC": shared["gpuTempC"],
                    "history": {"cpu": list(cpu_hist), "gpu": list(gpu_hist), "net": list(net_hist)},
                }
                state.set_section("sys", sysd)
            except Exception as e:
                log.warning("sysstats read failed: %s", e)
            await asyncio.sleep(interval)
    finally:
        stop_event.set()
