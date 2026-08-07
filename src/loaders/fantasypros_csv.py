"""Load FantasyPros projection CSVs (per-position exports).

Files live under ``data/fantasypros/projections/{season}/`` with names like
``FantasyPros_Fantasy_Football_Projections_QB.csv``. Headers reuse column
names (e.g. YDS for pass and rush), so parsing is positional by position.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIR = ROOT / "data" / "fantasypros" / "projections"

POSITIONS = ("QB", "RB", "WR", "TE")

# Positional column maps after Player, Team (index 0, 1).
# Values are internal stat keys used by src.scoring.league_points.
QB_COLS = {
    2: "pass_att",
    3: "pass_cmp",
    4: "pass_yd",
    5: "pass_td",
    6: "pass_int",
    7: "rush_att",
    8: "rush_yd",
    9: "rush_td",
    10: "fum_lost",
}
RB_COLS = {
    2: "rush_att",
    3: "rush_yd",
    4: "rush_td",
    5: "rec",
    6: "rec_yd",
    7: "rec_td",
    8: "fum_lost",
}
WR_COLS = {
    2: "rec",
    3: "rec_yd",
    4: "rec_td",
    5: "rush_att",
    6: "rush_yd",
    7: "rush_td",
    8: "fum_lost",
}
TE_COLS = {
    2: "rec",
    3: "rec_yd",
    4: "rec_td",
    5: "fum_lost",
}

COLS_BY_POS = {
    "QB": QB_COLS,
    "RB": RB_COLS,
    "WR": WR_COLS,
    "TE": TE_COLS,
}

FILE_PATTERNS = (
    "FantasyPros_Fantasy_Football_Projections_{pos}.csv",
    "{pos}.csv",
    "projections_{pos}.csv",
)


def projections_dir(season: int, *, base: Path | None = None) -> Path:
    return (base or DEFAULT_DIR) / str(season)


def _parse_num(raw: str) -> float | None:
    text = (raw or "").strip().replace(",", "")
    if not text or text in { "-", "—", "N/A" }:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _clean_name(raw: str) -> str:
    # FantasyPros blank rows use \xa0; strip + collapse spaces.
    return re.sub(r"\s+", " ", (raw or "").replace("\xa0", " ").strip())


def _resolve_csv(directory: Path, position: str) -> Path | None:
    for pattern in FILE_PATTERNS:
        path = directory / pattern.format(pos=position)
        if path.is_file():
            return path
    # Fallback: any *_{POS}.csv / *{POS}.csv
    matches = sorted(directory.glob(f"*{position}.csv"))
    return matches[0] if matches else None


def load_position_csv(path: Path, position: str) -> list[dict[str, Any]]:
    """Parse one FantasyPros position CSV into normalized player rows."""
    pos = position.upper()
    col_map = COLS_BY_POS.get(pos)
    if not col_map:
        raise ValueError(f"Unsupported position: {position}")

    rows: list[dict[str, Any]] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if not header:
            return []

        for raw in reader:
            if not raw:
                continue
            name = _clean_name(raw[0] if len(raw) > 0 else "")
            if not name:
                continue
            team = _clean_name(raw[1] if len(raw) > 1 else "").upper()
            stats: dict[str, float] = {}
            for index, key in col_map.items():
                if index >= len(raw):
                    continue
                value = _parse_num(raw[index])
                if value is not None:
                    stats[key] = value

            fpts = None
            fpts_idx = max(col_map) + 1
            if fpts_idx < len(raw):
                fpts = _parse_num(raw[fpts_idx])
            elif header and "FPTS" in header:
                try:
                    idx = header.index("FPTS")
                    if idx < len(raw):
                        fpts = _parse_num(raw[idx])
                except ValueError:
                    pass

            rows.append(
                {
                    "player": name,
                    "team": team,
                    "position": pos,
                    "stats": stats,
                    "fpts_source": fpts,
                    "source_file": path.name,
                }
            )
    return rows


def load_season_csvs(
    season: int,
    *,
    base: Path | None = None,
) -> list[dict[str, Any]]:
    """Load QB/RB/WR/TE FantasyPros CSVs for a season."""
    directory = projections_dir(season, base=base)
    if not directory.is_dir():
        raise FileNotFoundError(f"No FantasyPros projections dir: {directory}")

    players: list[dict[str, Any]] = []
    missing: list[str] = []
    for pos in POSITIONS:
        path = _resolve_csv(directory, pos)
        if path is None:
            missing.append(pos)
            continue
        players.extend(load_position_csv(path, pos))

    if missing and not players:
        raise FileNotFoundError(
            f"No FantasyPros CSVs found in {directory} (missing {', '.join(missing)})"
        )
    if missing:
        # Partial is ok but surface it to the caller via attribute on list? Return tuple.
        pass
    return players


def available_positions(season: int, *, base: Path | None = None) -> list[str]:
    directory = projections_dir(season, base=base)
    if not directory.is_dir():
        return []
    return [pos for pos in POSITIONS if _resolve_csv(directory, pos) is not None]
