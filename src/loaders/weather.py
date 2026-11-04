"""Kickoff weather for the kicker board (Open-Meteo forecast, no API key).

Kickers lose accuracy and range in wind and cold, and domes remove both. The
backtest (see ``src/analysis/k_weather_backtest.py``) found a simple index of
wind and cold adds real signal on top of the team implied total.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from src.loaders import nflverse

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
NFL_TIMEZONE = ZoneInfo("America/New_York")
# Average the hours a game spans: kickoff through roughly three hours later.
GAME_HOURS = 3

# Home stadium by nflverse team code: (latitude, longitude, roof). ``retractable``
# stadiums are treated as closed unless the schedule says the roof is open,
# because they close in exactly the cold or wet weather that matters here.
STADIUMS: dict[str, tuple[float, float, str]] = {
    "ARI": (33.5276, -112.2626, "retractable"),
    "ATL": (33.7554, -84.4009, "retractable"),
    "BAL": (39.2780, -76.6227, "outdoors"),
    "BUF": (42.7738, -78.7870, "outdoors"),
    "CAR": (35.2258, -80.8528, "outdoors"),
    "CHI": (41.8623, -87.6167, "outdoors"),
    "CIN": (39.0954, -84.5160, "outdoors"),
    "CLE": (41.5061, -81.6995, "outdoors"),
    "DAL": (32.7473, -97.0945, "retractable"),
    "DEN": (39.7439, -105.0201, "outdoors"),
    "DET": (42.3400, -83.0456, "dome"),
    "GB": (44.5013, -88.0622, "outdoors"),
    "HOU": (29.6847, -95.4107, "retractable"),
    "IND": (39.7601, -86.1639, "retractable"),
    "JAX": (30.3239, -81.6373, "outdoors"),
    "KC": (39.0489, -94.4839, "outdoors"),
    "LA": (33.9535, -118.3392, "dome"),
    "LAC": (33.9535, -118.3392, "dome"),
    "LV": (36.0909, -115.1833, "dome"),
    "MIA": (25.9580, -80.2389, "outdoors"),
    "MIN": (44.9740, -93.2575, "dome"),
    "NE": (42.0909, -71.2643, "outdoors"),
    "NO": (29.9511, -90.0812, "dome"),
    "NYG": (40.8135, -74.0745, "outdoors"),
    "NYJ": (40.8135, -74.0745, "outdoors"),
    "PHI": (39.9008, -75.1675, "outdoors"),
    "PIT": (40.4468, -80.0158, "outdoors"),
    "SEA": (47.5952, -122.3316, "outdoors"),
    "SF": (37.4032, -121.9695, "outdoors"),
    "TB": (27.9759, -82.5033, "outdoors"),
    "TEN": (36.1665, -86.7713, "outdoors"),
    "WAS": (38.9076, -76.8645, "outdoors"),
}

# Conditions assumed inside a closed stadium (matches the backtest).
DOME_TEMP_F = 70.0
DOME_WIND_MPH = 0.0


def kicker_weather_index(wind_mph: float, temp_f: float) -> float:
    """Kicker-friendliness: 0 is ideal, more negative is worse.

    One point per 10 mph of wind plus one per 10 degrees below 50F. This is the
    index the kicker backtest validated.
    """
    cold = max(0.0, 50.0 - temp_f)
    return -(wind_mph / 10.0) - (cold / 10.0)


def kickoff_utc(game: dict[str, Any]) -> datetime | None:
    """Kickoff as an aware UTC datetime (schedule times are US Eastern)."""
    day = str(game.get("gameday") or "")
    clock = str(game.get("gametime") or "")
    if not day or not clock:
        return None
    try:
        local = datetime.strptime(f"{day} {clock}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None
    return local.replace(tzinfo=NFL_TIMEZONE).astimezone(timezone.utc)


def stadium_for(game: dict[str, Any]) -> tuple[float, float, str] | None:
    """Home stadium for a game; None for neutral sites we have no coordinates for."""
    if str(game.get("location") or "").lower() == "neutral":
        return None
    return STADIUMS.get(str(game.get("home_team") or ""))


def is_closed_roof(game: dict[str, Any], stadium_roof: str) -> bool:
    """True when the game is played indoors (dome, or a retractable roof closed)."""
    scheduled = str(game.get("roof") or "").lower()
    if scheduled in ("dome", "closed"):
        return True
    if scheduled in ("outdoors", "open"):
        return False
    return stadium_roof in ("dome", "retractable")


def fetch_hourly_forecast(
    lat: float, lon: float, *, http_get=None
) -> dict[str, tuple[float, float]]:
    """Hourly ``{"YYYY-MM-DDTHH:00": (temp_f, wind_mph)}`` in UTC."""
    http_get = http_get or nflverse._http_get
    query = urlencode(
        {
            "latitude": lat,
            "longitude": lon,
            "hourly": "temperature_2m,wind_speed_10m",
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "timezone": "UTC",
            "past_days": 2,
            "forecast_days": 16,
        }
    )
    payload = json.loads(http_get(f"{OPEN_METEO_URL}?{query}", timeout=30))
    hourly = payload["hourly"]
    out: dict[str, tuple[float, float]] = {}
    for stamp, temp, wind in zip(
        hourly["time"], hourly["temperature_2m"], hourly["wind_speed_10m"]
    ):
        if temp is None or wind is None:
            continue
        out[stamp] = (float(temp), float(wind))
    return out


def game_weather(
    game: dict[str, Any],
    *,
    forecasts: dict[tuple[float, float], dict[str, tuple[float, float]]] | None = None,
    http_get=None,
) -> dict[str, Any]:
    """Weather summary for one game's home team, with a fallback when unknown.

    Returns ``roof`` ("closed" / "open"), ``temp_f``, ``wind_mph``,
    ``weather_index`` and ``weather_source`` ("indoors", "forecast" or
    "unavailable"). Unavailable weather has ``weather_index`` None so the caller
    can substitute a neutral value.
    """
    unavailable = {
        "roof": None,
        "temp_f": None,
        "wind_mph": None,
        "weather_index": None,
        "weather_source": "unavailable",
    }
    stadium = stadium_for(game)
    if stadium is None:
        return unavailable
    lat, lon, stadium_roof = stadium
    if is_closed_roof(game, stadium_roof):
        return {
            "roof": "closed",
            "temp_f": DOME_TEMP_F,
            "wind_mph": DOME_WIND_MPH,
            "weather_index": kicker_weather_index(DOME_WIND_MPH, DOME_TEMP_F),
            "weather_source": "indoors",
        }
    start = kickoff_utc(game)
    if start is None:
        return unavailable
    cache = forecasts if forecasts is not None else {}
    try:
        if (lat, lon) not in cache:
            cache[(lat, lon)] = fetch_hourly_forecast(lat, lon, http_get=http_get)
        hours = cache[(lat, lon)]
    except Exception:  # network/API failure must never break the board build
        return unavailable
    first = start.replace(minute=0, second=0, microsecond=0)
    samples = [
        hours[(first + timedelta(hours=i)).strftime("%Y-%m-%dT%H:00")]
        for i in range(GAME_HOURS)
        if (first + timedelta(hours=i)).strftime("%Y-%m-%dT%H:00") in hours
    ]
    if not samples:
        return unavailable
    temp = sum(t for t, _ in samples) / len(samples)
    wind = sum(w for _, w in samples) / len(samples)
    return {
        "roof": "open",
        "temp_f": round(temp, 1),
        "wind_mph": round(wind, 1),
        "weather_index": round(kicker_weather_index(wind, temp), 3),
        "weather_source": "forecast",
    }
