"""Weather collector — Open-Meteo (IMPLEMENTATION_PLAN §7.4).

Free, no API key. Resolves location once (explicit lat/lon > city geocode >
IP geolocation), then polls current weather + today's hi/lo on poll.weather_sec.
Degrades to null section on network failure (frontend hides the widget).
"""
import asyncio
import logging
import time

log = logging.getLogger("desko.weather")

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
IP_GEO_URL = "http://ip-api.com/json/"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"


def _wmo_to_label(code):
    if code == 0:
        return "Clear sky", "clear"
    if code in (1, 2, 3):
        return "Partly cloudy", "clouds"
    if code in (45, 48):
        return "Fog", "fog"
    if code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82):
        return "Rain", "rain"
    if code in (71, 73, 75, 77, 85, 86):
        return "Snow", "snow"
    if code in (95, 96, 99):
        return "Thunderstorm", "storm"
    return "Unknown", "clouds"


async def _resolve_location(config, session):
    lat = config.get("weather_lat")
    lon = config.get("weather_lon")
    city = config.get("weather_city", "") or ""
    if lat is not None and lon is not None:
        return float(lat), float(lon), city

    if city:
        try:
            async with session.get(
                GEOCODE_URL, params={"name": city, "count": 1, "language": "en"}, timeout=10
            ) as r:
                j = await r.json()
                results = j.get("results") or []
                if results:
                    hit = results[0]
                    return float(hit["latitude"]), float(hit["longitude"]), hit.get("name", city)
        except Exception as e:
            log.warning("geocode for %r failed: %s", city, e)

    try:
        async with session.get(IP_GEO_URL, timeout=10) as r:
            j = await r.json()
            if j.get("status") == "success":
                return float(j["lat"]), float(j["lon"]), j.get("city", "") or ""
    except Exception as e:
        log.warning("IP geolocation failed: %s", e)

    return None, None, ""


async def _fetch_weather(session, lat, lon, city):
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,apparent_temperature,weather_code",
        "daily": "temperature_2m_max,temperature_2m_min",
        "timezone": "auto",
        "forecast_days": 1,
    }
    async with session.get(FORECAST_URL, params=params, timeout=10) as r:
        j = await r.json()
    cur = j.get("current") or {}
    daily = j.get("daily") or {}
    code = cur.get("weather_code")
    label, icon = _wmo_to_label(code)
    hi_list = daily.get("temperature_2m_max") or []
    lo_list = daily.get("temperature_2m_min") or []
    return {
        "tempC": cur.get("temperature_2m"),
        "feelsC": cur.get("apparent_temperature"),
        "code": code,
        "label": label,
        "icon": icon,
        "hiC": hi_list[0] if hi_list else None,
        "loC": lo_list[0] if lo_list else None,
        "city": city,
        "updatedAt": time.time(),
    }


async def start(state, config, session) -> None:
    interval = float(config.get("poll", {}).get("weather_sec", 1800))
    lat = lon = None
    city = ""
    resolve_backoff = 600  # retry location resolve every 10 min until it works
    while True:
        if lat is None:
            lat, lon, city = await _resolve_location(config, session)
            if lat is None:
                await asyncio.sleep(resolve_backoff)
                continue
        try:
            data = await _fetch_weather(session, lat, lon, city)
            state.set_section("weather", data)
        except Exception as e:
            log.warning("weather fetch failed: %s", e)
        await asyncio.sleep(interval)
