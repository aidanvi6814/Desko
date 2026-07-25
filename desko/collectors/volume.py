"""System master-volume collector + control (Windows Core Audio via pycaw).

Publishes a ``volume`` section — ``{"level": 0-100, "muted": bool}`` — and
services set/mute commands the phone's Music-scene slider pushes through
``state.request_volume``.

Windows has no volume in its media-session API (that only does play/pause/
next/prev/seek), so this reaches the *system* endpoint volume through Core
Audio. pycaw is COM, and COM is apartment-bound, so — exactly like the WMI
temps reader and the GSMTC media reader — this runs on ONE dedicated thread
that CoInitializes itself, creates the endpoint there, and both polls and
mutates it there. Reading the level back every tick means the slider on the
phone also tracks changes made on the PC (keyboard volume keys, mixer).

Degrades silently: if pycaw/comtypes aren't installed or there's no audio
endpoint, the section stays null and the frontend hides the control.
"""
import logging
import threading
import time

log = logging.getLogger("desko.volume")

_HAS = False
try:
    from ctypes import POINTER, cast

    from comtypes import CLSCTX_ALL
    from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume

    _HAS = True
except Exception:  # ImportError, or comtypes failing to load on non-Windows
    pass


def _get_endpoint():
    """Return an IAudioEndpointVolume for the default output device.

    pycaw >= ~2024 wraps the device: GetSpeakers() returns an AudioDevice that
    exposes ``.EndpointVolume`` directly. Older pycaw returns a raw IMMDevice
    that must be ``.Activate``-d. Support both so either version works.
    """
    speakers = AudioUtilities.GetSpeakers()
    ev = getattr(speakers, "EndpointVolume", None)
    if ev is not None:
        return ev
    interface = speakers.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
    return cast(interface, POINTER(IAudioEndpointVolume))


def _thread_main(state, config, main_loop, stop: threading.Event) -> None:
    try:
        import comtypes

        comtypes.CoInitialize()
    except Exception as e:
        log.info("comtypes CoInitialize failed -- volume control disabled (%s)", e)
        return

    def publish(fn, *args):
        try:
            main_loop.call_soon_threadsafe(fn, *args)
        except Exception:
            pass

    endpoint = None
    last_pub = None  # last {"level","muted"} we broadcast
    interval = float(config.get("poll", {}).get("volume_sec", 0.5))

    try:
        while not stop.is_set():
            # (Re)acquire the endpoint if we lost it (device switch, etc.).
            if endpoint is None:
                try:
                    endpoint = _get_endpoint()
                    log.info("system volume endpoint linked")
                except Exception as e:
                    log.debug("no audio endpoint yet (%s)", e)
                    stop.wait(2.0)
                    continue

            # 1) Apply any pending set/mute commands first so the UI feels snappy.
            try:
                while True:
                    cmd = state.volume_commands.get_nowait()
                    try:
                        if cmd == "mute":
                            endpoint.SetMute(0 if endpoint.GetMute() else 1, None)
                        elif cmd.startswith("set:"):
                            lvl = max(0, min(100, int(float(cmd.split(":", 1)[1]))))
                            endpoint.SetMasterVolumeLevelScalar(lvl / 100.0, None)
                            # Setting a level while muted implies "unmute" — that's
                            # what dragging the slider up is meant to do.
                            if lvl > 0 and endpoint.GetMute():
                                endpoint.SetMute(0, None)
                    except Exception as e:
                        log.debug("volume command %r failed: %s", cmd, e)
            except Exception:
                pass

            # 2) Read current state and publish on change.
            try:
                level = int(round(endpoint.GetMasterVolumeLevelScalar() * 100))
                muted = bool(endpoint.GetMute())
            except Exception as e:
                log.debug("volume read failed (%s); re-acquiring", e)
                endpoint = None
                stop.wait(1.0)
                continue

            payload = {"level": level, "muted": muted}
            if payload != last_pub:
                last_pub = payload
                publish(state.set_section, "volume", payload)

            stop.wait(interval)
    finally:
        try:
            import comtypes

            comtypes.CoUninitialize()
        except Exception:
            pass


async def start(state, config, session=None) -> None:
    if not _HAS:
        log.info("pycaw not available -- volume control disabled")
        return
    import asyncio

    main_loop = asyncio.get_running_loop()
    stop = threading.Event()
    t = threading.Thread(
        target=_thread_main,
        args=(state, config, main_loop, stop),
        daemon=True,
        name="desko-volume",
    )
    t.start()
    log.info("volume collector started (dedicated thread)")
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        stop.set()
