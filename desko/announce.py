"""mDNS announcer: a stable URL for the phone, whatever DHCP does.

The LAN IP printed at startup changes whenever the router hands out a new
lease (192.168.0.4 one week, .7 the next), which breaks the URL saved /
pinned on the phone. This module advertises the dashboard over mDNS as

    http://desko.local:<port>

so devices that resolve mDNS (iOS/macOS, Windows, Linux, Android 12+) always
find the server by name. The announcement follows IP changes live: a
background thread re-checks the LAN IP and updates the mDNS record when it
moves (laptop roaming, lease renewal) without a restart.

Degrades gracefully: if the optional ``zeroconf`` package is missing, we log
one hint and do nothing -- the numeric URL keeps working as before.
"""
import logging
import socket
import threading

log = logging.getLogger("desko.announce")

_CHECK_SEC = 30.0


def start(get_ip, port: int, name: str = "desko"):
    """Advertise ``http://<name>.local:<port>`` via mDNS.

    ``get_ip`` is a zero-arg callable returning the current LAN IP (called
    periodically so the record tracks IP changes). Returns a ``stop()``
    callable; safe to call on any platform.
    """
    try:
        from zeroconf import ServiceInfo, Zeroconf
    except ImportError:
        log.info(
            "zeroconf not installed -- http://%s.local:%d unavailable "
            "(pip install zeroconf to enable the stable URL)", name, port,
        )
        return lambda: None

    stop_event = threading.Event()

    def _make_info(ip: str) -> "ServiceInfo":
        return ServiceInfo(
            "_http._tcp.local.",
            f"{name}._http._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=port,
            server=f"{name}.local.",
            properties={"path": "/"},
        )

    def run() -> None:
        zc = None
        registered = None  # ServiceInfo currently announced
        current_ip = None
        while not stop_event.is_set():
            try:
                ip = get_ip()
                if ip and not ip.startswith("127.") and ip != current_ip:
                    if zc is None:
                        zc = Zeroconf()
                    info = _make_info(ip)
                    if registered is None:
                        zc.register_service(info)
                    else:
                        zc.update_service(info)
                    registered = info
                    current_ip = ip
                    log.info("mDNS: %s.local -> %s:%d", name, ip, port)
            except Exception as e:
                # Transient network trouble (interface down, socket error):
                # keep retrying on the next tick rather than dying silently.
                log.warning("mDNS announce failed (will retry): %s", e)
            stop_event.wait(_CHECK_SEC)
        if zc is not None:
            try:
                zc.close()  # sends the mDNS goodbye packet
            except Exception:
                pass

    threading.Thread(target=run, name="desko-mdns", daemon=True).start()
    return stop_event.set
