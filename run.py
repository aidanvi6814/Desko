import argparse
import json
import logging
import os
import socket

from aiohttp import web

from desko.server import create_app
from desko.state import State

DEFAULT_CONFIG = {
    "host": "0.0.0.0",
    "port": 7777,
    "weather_city": "",
    "weather_lat": None,
    "weather_lon": None,
    "game_processes": ["valorant-win64-shipping.exe", "cs2.exe"],
    "calendar_ics_urls": [],
    "focus_work_min": 25,
    "focus_break_min": 5,
    "poll": {"media_sec": 0.3, "sysstats_sec": 1.0, "temps_sec": 3.0, "weather_sec": 1800, "calendar_sec": 900},
    "override_timeout_sec": 300,
    "vscode_stale_sec": 45,
    "lhm_enabled": True,
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def load_config(path: str) -> dict:
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        cfg = DEFAULT_CONFIG
    else:
        try:
            with open(path, encoding="utf-8") as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logging.warning("config.json unreadable (%s); using defaults", e)
            cfg = {}
        merged = json.loads(json.dumps(DEFAULT_CONFIG))
        merged.update(cfg)
        cfg = merged
    poll = cfg.get("poll") or {}
    cfg["poll"] = {**DEFAULT_CONFIG["poll"], **poll}
    return cfg


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def print_qr(url: str) -> None:
    try:
        import qrcode
    except ImportError:
        print("  (install 'qrcode' for a scannable QR: pip install qrcode)")
        return
    try:
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
    except Exception:
        print(f"  open: {url}")
        return
    # print_tty() renders with ANSI colour but REQUIRES a real terminal
    # (raises when stdout isn't a tty), which is why it fell back to "QR
    # unavailable". print_ascii() draws with unicode half-blocks, needs no
    # tty, and renders fine in cmd/PowerShell -- try it as the fallback so a
    # scannable QR shows in far more situations before giving up on the URL.
    try:
        qr.print_tty(invert=True)
    except Exception:
        try:
            qr.print_ascii(invert=True)
        except Exception:
            print(f"  open: {url}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Desko desk dashboard server")
    parser.add_argument("--demo", action="store_true", help="fabricate all data; no real collectors")
    parser.add_argument("--port", type=int, default=None, help="override config port")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    config = load_config(os.path.join(BASE_DIR, "config.json"))
    if args.port:
        config["port"] = args.port

    state = State()
    app = create_app(state, config, demo=args.demo)

    ip = lan_ip()
    port = int(config.get("port", 7777))
    url = f"http://{ip}:{port}"
    print("\n  Desko ready")
    print(f"  Open on your phone: {url}")
    print("  QR code:")
    print_qr(url)
    print()
    if args.demo:
        print("  (demo mode — fabricated data)\n")

    web.run_app(app, host=config.get("host", "0.0.0.0"), port=port, print=None)


if __name__ == "__main__":
    main()
