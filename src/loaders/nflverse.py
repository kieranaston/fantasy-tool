"""Lightweight nflverse loaders (schedules + PBP sack rates) without nflreadpy."""

from __future__ import annotations

import csv
import io
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import polars as pl

GAMES_CSV_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv"
PBP_PARQUET_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/pbp/"
    "play_by_play_{season}.parquet"
)
PLAYER_WEEK_STATS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/stats_player/"
    "stats_player_week_{season}.parquet"
)
ROSTER_PARQUET_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/rosters/"
    "roster_{season}.parquet"
)
DEPTH_CHART_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/"
    "depth_charts_{season}.parquet"
)

# Rolling opportunity window (≈ one NFL regular season).
STATS_WINDOW_GAMES = 17

USER_AGENT = "fantasy-tool/0.1 (+https://github.com/nflverse)"


def _http_get(url: str, *, timeout: float = 180) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_schedules(*, seasons: list[int] | None = None) -> list[dict[str, Any]]:
    """Lee Sharpe / nflverse games.csv as list of dicts (numeric fields coerced)."""
    text = _http_get(GAMES_CSV_URL, timeout=120).decode("utf-8")
    rows: list[dict[str, Any]] = []
    for raw in csv.DictReader(io.StringIO(text)):
        season = _to_int(raw.get("season"))
        if seasons is not None and season not in seasons:
            continue
        rows.append(
            {
                "game_id": (raw.get("game_id") or "").strip(),
                "season": season,
                "game_type": (raw.get("game_type") or "").strip(),
                "week": _to_int(raw.get("week")),
                "away_team": (raw.get("away_team") or "").strip(),
                "home_team": (raw.get("home_team") or "").strip(),
                "away_score": _to_float(raw.get("away_score")),
                "home_score": _to_float(raw.get("home_score")),
                "spread_line": _to_float(raw.get("spread_line")),
                "total_line": _to_float(raw.get("total_line")),
            }
        )
    return rows


def fetch_pbp_parquet(season: int, *, cache_dir: Path | None = None) -> Path:
    """Download (or reuse) play-by-play parquet for a season; return local path."""
    if cache_dir is None:
        cache_dir = Path.home() / ".cache" / "fantasy-tool" / "pbp"
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"play_by_play_{season}.parquet"
    if path.exists() and path.stat().st_size > 1_000_000:
        return path
    url = PBP_PARQUET_URL.format(season=season)
    try:
        path.write_bytes(_http_get(url, timeout=300))
    except urllib.error.HTTPError as exc:
        if path.exists():
            path.unlink(missing_ok=True)
        raise FileNotFoundError(f"PBP parquet unavailable for {season}: {url}") from exc
    return path


def available_pbp_seasons(
    seasons: list[int],
    *,
    cache_dir: Path | None = None,
) -> list[int]:
    """Return seasons whose PBP parquet is cached or downloadable."""
    found: list[int] = []
    for season in seasons:
        try:
            fetch_pbp_parquet(season, cache_dir=cache_dir)
        except FileNotFoundError:
            continue
        found.append(season)
    return found


def resolve_pbp_seasons(
    current_season: int,
    *,
    cache_dir: Path | None = None,
) -> list[int]:
    """Prior + current PBP when available so rolling windows shift on week 1."""
    seasons = available_pbp_seasons(
        [current_season - 1, current_season],
        cache_dir=cache_dir,
    )
    if not seasons:
        raise FileNotFoundError(
            f"No PBP available for {current_season - 1} or {current_season}"
        )
    return seasons


def fetch_player_week_stats(season: int, *, cache_dir: Path | None = None) -> Path:
    """Download (or reuse) nflverse weekly player stats parquet."""
    if cache_dir is None:
        cache_dir = Path.home() / ".cache" / "fantasy-tool" / "player_stats"
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"stats_player_week_{season}.parquet"
    if path.exists() and path.stat().st_size > 100_000:
        return path
    url = PLAYER_WEEK_STATS_URL.format(season=season)
    try:
        path.write_bytes(_http_get(url, timeout=300))
    except urllib.error.HTTPError as exc:
        if path.exists():
            path.unlink(missing_ok=True)
        raise FileNotFoundError(
            f"Player week stats unavailable for {season}: {url}"
        ) from exc
    return path


def available_player_stat_seasons(
    seasons: list[int],
    *,
    cache_dir: Path | None = None,
) -> list[int]:
    found: list[int] = []
    for season in seasons:
        try:
            fetch_player_week_stats(season, cache_dir=cache_dir)
        except FileNotFoundError:
            continue
        found.append(season)
    return found


def resolve_player_stat_seasons(
    current_season: int,
    *,
    cache_dir: Path | None = None,
) -> list[int]:
    """Prior + current weekly player stats when available.

    Rolling windows always mean "last N games" across whatever seasons are
    returned here — never a single-season average when both files exist.
    """
    seasons = available_player_stat_seasons(
        [current_season - 1, current_season],
        cache_dir=cache_dir,
    )
    if not seasons:
        raise FileNotFoundError(
            f"No player week stats for {current_season - 1} or {current_season}"
        )
    return seasons


def fetch_roster_parquet(season: int, *, cache_dir: Path | None = None) -> Path:
    """Download (or reuse) nflverse season roster parquet."""
    if cache_dir is None:
        cache_dir = Path.home() / ".cache" / "fantasy-tool" / "rosters"
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"roster_{season}.parquet"
    if path.exists() and path.stat().st_size > 50_000:
        return path
    url = ROSTER_PARQUET_URL.format(season=season)
    try:
        path.write_bytes(_http_get(url, timeout=180))
    except urllib.error.HTTPError as exc:
        if path.exists():
            path.unlink(missing_ok=True)
        raise FileNotFoundError(f"Roster unavailable for {season}: {url}") from exc
    return path


def load_roster_teams(
    season: int,
    *,
    cache_dir: Path | None = None,
) -> dict[str, str]:
    """Map gsis player_id → current team from the season roster."""
    try:
        path = fetch_roster_parquet(season, cache_dir=cache_dir)
    except FileNotFoundError:
        return {}
    df = (
        pl.scan_parquet(path)
        .select(["gsis_id", "team", "status"])
        .filter(pl.col("gsis_id").is_not_null() & pl.col("team").is_not_null())
        .collect()
    )
    # Prefer active listings when duplicates appear.
    prefer = {"ACT": 0, "RES": 1, "INA": 2, "CUT": 3, "DEV": 4}
    out: dict[str, str] = {}
    rows = sorted(
        df.iter_rows(named=True),
        key=lambda r: prefer.get(str(r.get("status") or ""), 9),
    )
    for row in rows:
        pid = str(row["gsis_id"]).strip()
        team = str(row["team"]).strip()
        if pid and team and pid not in out:
            out[pid] = team
    return out


def fetch_depth_charts(season: int, *, cache_dir: Path | None = None) -> Path:
    if cache_dir is None:
        cache_dir = Path.home() / ".cache" / "fantasy-tool" / "depth"
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"depth_charts_{season}.parquet"
    if path.exists() and path.stat().st_size > 100_000:
        return path
    url = DEPTH_CHART_URL.format(season=season)
    try:
        path.write_bytes(_http_get(url, timeout=180))
    except urllib.error.HTTPError as exc:
        if path.exists():
            path.unlink(missing_ok=True)
        raise FileNotFoundError(f"Depth charts unavailable for {season}: {url}") from exc
    return path


def load_depth_chart_starters(
    season: int,
    position: str = "QB",
    *,
    cache_dir: Path | None = None,
) -> dict[str, str]:
    """Map team → gsis_id for depth-chart rank-1 at ``position`` (latest snapshot)."""
    try:
        path = fetch_depth_charts(season, cache_dir=cache_dir)
    except FileNotFoundError:
        return {}
    df = (
        pl.scan_parquet(path)
        .select(["dt", "team", "gsis_id", "pos_abb", "pos_rank"])
        .filter(
            (pl.col("pos_abb") == position.upper())
            & (pl.col("pos_rank") == 1)
            & pl.col("gsis_id").is_not_null()
            & pl.col("team").is_not_null()
        )
        .collect()
    )
    if df.is_empty():
        return {}
    latest = df["dt"].max()
    snap = df.filter(pl.col("dt") == latest)
    return {
        str(row["team"]): str(row["gsis_id"])
        for row in snap.iter_rows(named=True)
        if row.get("team") and row.get("gsis_id")
    }


def _apply_roster_teams(
    rows: list[dict[str, Any]],
    roster_teams: dict[str, str] | None,
) -> list[dict[str, Any]]:
    if not roster_teams:
        return rows
    updated: list[dict[str, Any]] = []
    for row in rows:
        copy = dict(row)
        mapped = roster_teams.get(str(copy.get("player_id") or ""))
        if mapped:
            copy["team"] = mapped
        updated.append(copy)
    return updated


def _load_reg_player_week_stats(
    seasons: list[int],
    *,
    position: str | None = None,
    cache_dir: Path | None = None,
) -> pl.DataFrame:
    frames: list[pl.DataFrame] = []
    cols = [
        "player_id",
        "player_display_name",
        "position",
        "season",
        "week",
        "season_type",
        "game_id",
        "team",
        "opponent_team",
        "attempts",
        "carries",
        "rushing_yards",
        "receptions",
        "fantasy_points",
        "fantasy_points_ppr",
    ]
    for season in seasons:
        path = fetch_player_week_stats(season, cache_dir=cache_dir)
        frame = (
            pl.scan_parquet(path)
            .select(cols)
            .filter(pl.col("season_type") == "REG")
            .collect()
        )
        frames.append(frame)
    df = pl.concat(frames) if len(frames) > 1 else frames[0]
    if position:
        df = df.filter(pl.col("position") == position)
    if df.is_empty():
        raise ValueError(f"No REG player-week rows for seasons {seasons}")
    return df.with_columns(
        (pl.col("fantasy_points") + 0.5 * pl.col("receptions")).alias("half_ppr")
    )


def _filter_before_slate(
    df: pl.DataFrame,
    *,
    as_of_season: int | None,
    as_of_week: int | None,
) -> pl.DataFrame:
    """Keep only games strictly before the chart slate (no same-week leakage)."""
    if as_of_season is None or as_of_week is None:
        return df
    return df.filter(
        (pl.col("season") < as_of_season)
        | ((pl.col("season") == as_of_season) & (pl.col("week") < as_of_week))
    )


def position_avg_half_ppr(
    seasons: list[int],
    position: str,
    *,
    window: int = STATS_WINDOW_GAMES,
    min_games: int = 4,
    min_avg: float = 5.0,
    roster_teams: dict[str, str] | None = None,
    as_of_season: int | None = None,
    as_of_week: int | None = None,
    cache_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Rolling half-PPR averages: last ``window`` games across ``seasons``.

    When ``as_of_season``/``as_of_week`` are set, games from that slate onward
    are excluded so a Week N chart never uses Week N (or later) box scores.
    """
    df = _load_reg_player_week_stats(seasons, position=position, cache_dir=cache_dir)
    df = _filter_before_slate(df, as_of_season=as_of_season, as_of_week=as_of_week)
    if df.is_empty():
        return []
    df = df.sort(["player_id", "season", "week", "game_id"])

    out: list[dict[str, Any]] = []
    for player_key, group in df.partition_by("player_id", as_dict=True).items():
        player_id = player_key[0] if isinstance(player_key, tuple) else player_key
        if not player_id:
            continue
        tail = group.sort(["season", "week", "game_id"]).tail(window)
        games = int(tail.height)
        if games < min_games:
            continue
        avg = float(tail["half_ppr"].mean())
        if avg < min_avg:
            continue
        latest = tail.sort(["season", "week", "game_id"]).tail(1).row(0, named=True)
        name = str(latest.get("player_display_name") or "")
        out.append(
            {
                "player_id": str(player_id),
                "player_name": name,
                "last_name": _last_name(name),
                "team": str(latest.get("team") or ""),
                "avg_half_ppr": avg,
                "games": games,
            }
        )
    out = _apply_roster_teams(out, roster_teams)
    out.sort(key=lambda r: -r["avg_half_ppr"])
    return out


def defense_position_half_ppr_sos(
    seasons: list[int],
    position: str,
    *,
    cache_dir: Path | None = None,
) -> dict[str, dict[str, float]]:
    """Per-defense SOS adj: mean position half-PPR allowed minus league mean."""
    df = _load_reg_player_week_stats(seasons, position=position, cache_dir=cache_dir)
    by_def = (
        df.filter(pl.col("opponent_team").is_not_null())
        .group_by("opponent_team")
        .agg(
            pl.col("half_ppr").mean().alias("allowed"),
            pl.len().alias("n"),
        )
    )
    if by_def.is_empty():
        raise ValueError(f"No {position} defense rows for seasons {seasons}")
    league = float(by_def["allowed"].mean())
    allowed_key = f"{position.lower()}_half_ppr_allowed"
    out: dict[str, dict[str, float]] = {}
    for row in by_def.iter_rows(named=True):
        team = str(row["opponent_team"])
        allowed = float(row["allowed"])
        out[team] = {
            allowed_key: allowed,
            "sos_adj": allowed - league,
            "n": float(row["n"]),
        }
    return out


def rb_avg_half_ppr(
    seasons: list[int],
    *,
    window: int = STATS_WINDOW_GAMES,
    min_games: int = 4,
    min_avg: float = 5.0,
    roster_teams: dict[str, str] | None = None,
    as_of_season: int | None = None,
    as_of_week: int | None = None,
    cache_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Rolling half-PPR averages for RBs."""
    return position_avg_half_ppr(
        seasons,
        "RB",
        window=window,
        min_games=min_games,
        min_avg=min_avg,
        roster_teams=roster_teams,
        as_of_season=as_of_season,
        as_of_week=as_of_week,
        cache_dir=cache_dir,
    )


def defense_rb_half_ppr_sos(
    seasons: list[int],
    *,
    cache_dir: Path | None = None,
) -> dict[str, dict[str, float]]:
    """Per-defense SOS adj vs RBs."""
    return defense_position_half_ppr_sos(seasons, "RB", cache_dir=cache_dir)


def qb_rush_yards_per_game(
    seasons: list[int],
    *,
    window: int = 8,
    min_pass_attempts: int = 10,
    roster_teams: dict[str, str] | None = None,
    depth_starters: dict[str, str] | None = None,
    starters_only: bool = True,
    as_of_season: int | None = None,
    as_of_week: int | None = None,
    cache_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Rolling QB rush yards/game (last ``window`` games across ``seasons``).

    When ``starters_only`` is True (default), returns one starter per current
    team — prefers depth-chart QB1 when provided, otherwise most pass attempts
    in the window. When False, returns every QB meeting ``min_pass_attempts``.

    ``as_of_season``/``as_of_week`` drop games from that slate onward.
    """
    df = _load_reg_player_week_stats(seasons, position="QB", cache_dir=cache_dir)
    df = _filter_before_slate(df, as_of_season=as_of_season, as_of_week=as_of_week)
    if df.is_empty():
        return []
    df = df.with_columns(
        pl.col("attempts").fill_null(0),
        pl.col("rushing_yards").fill_null(0),
    )

    per_player: list[dict[str, Any]] = []
    for player_key, group in df.partition_by("player_id", as_dict=True).items():
        player_id = player_key[0] if isinstance(player_key, tuple) else player_key
        if not player_id:
            continue
        # Last N games chronologically across whatever seasons were loaded.
        tail = group.sort(["season", "week", "game_id"]).tail(window)
        attempts = int(tail["attempts"].sum())
        if attempts < min_pass_attempts:
            continue
        latest = tail.sort(["season", "week", "game_id"]).tail(1).row(0, named=True)
        name = str(latest.get("player_display_name") or "")
        per_player.append(
            {
                "player_id": str(player_id),
                "player_name": name,
                "last_name": _last_name(name),
                "team": str(latest.get("team") or ""),
                "rush_yards_per_game": float(tail["rushing_yards"].mean()),
                "pass_attempts": attempts,
                "games": int(tail.height),
            }
        )

    per_player = _apply_roster_teams(per_player, roster_teams)
    if not starters_only:
        per_player.sort(key=lambda r: -r["rush_yards_per_game"])
        return per_player

    by_id = {row["player_id"]: row for row in per_player}

    by_team: dict[str, dict[str, Any]] = {}
    if depth_starters:
        for team, gsis_id in depth_starters.items():
            row = by_id.get(str(gsis_id))
            if row:
                copy = dict(row)
                copy["team"] = team
                by_team[team] = copy

    # Fill any teams missing a depth-chart hit with attempts fallback.
    for row in per_player:
        team = row["team"]
        if not team or team in by_team:
            continue
        prev = by_team.get(team)
        if prev is None or row["pass_attempts"] > prev["pass_attempts"]:
            by_team[team] = row

    out = list(by_team.values())
    out.sort(key=lambda r: -r["rush_yards_per_game"])
    return out


def _last_name(full_name: str) -> str:
    parts = [p for p in full_name.replace(".", " ").split() if p]
    skip = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}
    while len(parts) > 1 and parts[-1].lower().rstrip(".") in skip:
        parts.pop()
    return parts[-1] if parts else full_name


def _load_reg_pbp(
    seasons: list[int],
    columns: list[str],
    *,
    cache_dir: Path | None = None,
) -> pl.DataFrame:
    if not seasons:
        raise ValueError("seasons must be non-empty")
    needed = list(dict.fromkeys(["season", "season_type", "week", "game_id", *columns]))
    frames: list[pl.DataFrame] = []
    for season in seasons:
        path = fetch_pbp_parquet(season, cache_dir=cache_dir)
        frames.append(
            pl.scan_parquet(path)
            .select(needed)
            .filter(pl.col("season_type") == "REG")
            .collect()
        )
    df = pl.concat(frames) if len(frames) > 1 else frames[0]
    if df.is_empty():
        raise ValueError(f"No REG PBP rows for seasons {seasons}")
    return df


def _tail_games_by_team(team_games: pl.DataFrame, window: int) -> pl.DataFrame:
    """Keep the last ``window`` games per team (ordered by season, week, game_id)."""
    parts: list[pl.DataFrame] = []
    for team_key, group in team_games.partition_by("team", as_dict=True).items():
        team = team_key[0] if isinstance(team_key, tuple) else team_key
        if team is None:
            continue
        parts.append(group.sort(["season", "week", "game_id"]).tail(window))
    if not parts:
        raise ValueError("No team-games available for rolling window")
    return pl.concat(parts)


def team_sack_rates(
    seasons: list[int] | int,
    *,
    window: int = STATS_WINDOW_GAMES,
    cache_dir: Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Rolling REG sack rates by team from nflverse PBP (qb_dropback plays).

    Returns ``{team: {offense_sack_rate, defense_sack_rate, off_n, def_n, games, ...}}``.
    Offense = rate the team's QB was sacked; defense = rate the team recorded sacks.
    Rates pool dropbacks from each team's last ``window`` games.
    """
    if isinstance(seasons, int):
        seasons = [seasons]

    df = _load_reg_pbp(
        seasons,
        ["posteam", "defteam", "sack", "qb_dropback"],
        cache_dir=cache_dir,
    ).filter(pl.col("qb_dropback") == 1)
    if df.is_empty():
        raise ValueError(f"No REG qb_dropback rows for seasons {seasons}")

    off_games = (
        df.filter(pl.col("posteam").is_not_null())
        .select(["season", "week", "game_id", pl.col("posteam").alias("team")])
        .unique()
    )
    def_games = (
        df.filter(pl.col("defteam").is_not_null())
        .select(["season", "week", "game_id", pl.col("defteam").alias("team")])
        .unique()
    )
    off_tail = _tail_games_by_team(off_games, window)
    def_tail = _tail_games_by_team(def_games, window)

    off = (
        df.join(
            off_tail.select(["game_id", pl.col("team").alias("posteam")]),
            on=["game_id", "posteam"],
            how="inner",
        )
        .group_by("posteam")
        .agg(
            pl.col("sack").mean().alias("offense_sack_rate"),
            pl.len().alias("off_n"),
            pl.col("game_id").n_unique().alias("games"),
        )
        .drop_nulls("posteam")
    )
    deff = (
        df.join(
            def_tail.select(["game_id", pl.col("team").alias("defteam")]),
            on=["game_id", "defteam"],
            how="inner",
        )
        .group_by("defteam")
        .agg(
            pl.col("sack").mean().alias("defense_sack_rate"),
            pl.len().alias("def_n"),
            pl.col("game_id").n_unique().alias("games"),
        )
        .drop_nulls("defteam")
    )

    out: dict[str, dict[str, Any]] = {}
    for row in off.iter_rows(named=True):
        team = str(row["posteam"])
        out[team] = {
            "offense_sack_rate": float(row["offense_sack_rate"]),
            "defense_sack_rate": 0.0,
            "off_n": float(row["off_n"]),
            "def_n": 0.0,
            "games": float(row["games"]),
        }
    for row in deff.iter_rows(named=True):
        team = str(row["defteam"])
        slot = out.setdefault(
            team,
            {
                "offense_sack_rate": 0.0,
                "defense_sack_rate": 0.0,
                "off_n": 0.0,
                "def_n": 0.0,
                "games": 0.0,
            },
        )
        slot["defense_sack_rate"] = float(row["defense_sack_rate"])
        slot["def_n"] = float(row["def_n"])
        slot["games"] = max(float(slot.get("games") or 0), float(row["games"]))

    return out


def team_fg_attempts_per_game(
    seasons: list[int],
    *,
    window: int = STATS_WINDOW_GAMES,
    cache_dir: Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Rolling FG attempts per game by team from REG PBP.

    Uses the last ``window`` team-games across ``seasons`` (ordered by season, week).
    """
    df = _load_reg_pbp(
        seasons,
        ["posteam", "field_goal_attempt"],
        cache_dir=cache_dir,
    )

    team_games = (
        df.filter(pl.col("posteam").is_not_null())
        .select(["season", "week", "game_id", pl.col("posteam").alias("team")])
        .unique()
    )
    fg = (
        df.filter(pl.col("field_goal_attempt") == 1)
        .group_by(["game_id", "posteam"])
        .agg(pl.len().alias("fg_att"))
        .rename({"posteam": "team"})
    )
    rates = (
        team_games.join(fg, on=["game_id", "team"], how="left")
        .with_columns(pl.col("fg_att").fill_null(0))
        .sort(["team", "season", "week", "game_id"])
    )
    tail = _tail_games_by_team(rates, window)

    out: dict[str, dict[str, Any]] = {}
    for team_key, group in tail.partition_by("team", as_dict=True).items():
        team = team_key[0] if isinstance(team_key, tuple) else team_key
        if team is None:
            continue
        row: dict[str, Any] = {
            "fg_attempts_per_game": float(group["fg_att"].mean()),
            "games": float(group.height),
        }
        out[str(team)] = row
    if not out:
        raise ValueError(f"No team FG rates for seasons {seasons}")
    return out


def count_completed_reg(games: list[dict[str, Any]], season: int) -> int:
    return sum(
        1
        for g in games
        if g.get("season") == season
        and g.get("game_type") == "REG"
        and g.get("away_score") is not None
        and g.get("home_score") is not None
    )


def resolve_sack_season(
    pbp_seasons: list[int],
    current_season: int,
) -> int:
    """Newest PBP season in the rolling window (current once its file exists)."""
    if not pbp_seasons:
        return current_season - 1
    return max(pbp_seasons)


def resolve_target_week(games: list[dict[str, Any]], season: int) -> int:
    """Earliest REG week with lines that is not fully scored; else latest lined week."""
    reg = [
        g
        for g in games
        if g.get("season") == season
        and g.get("game_type") == "REG"
        and g.get("total_line") is not None
        and g.get("spread_line") is not None
        and g.get("week") is not None
    ]
    if not reg:
        raise ValueError(f"No REG games with lines for season {season}")

    by_week: dict[int, list[dict[str, Any]]] = {}
    for g in reg:
        by_week.setdefault(int(g["week"]), []).append(g)

    for week in sorted(by_week):
        slate = by_week[week]
        unfinished = any(
            g.get("away_score") is None or g.get("home_score") is None for g in slate
        )
        if unfinished:
            return week
    return max(by_week)


def implied_team_totals(spread_line: float, total_line: float) -> tuple[float, float]:
    """Return (away_implied, home_implied).

    nflverse ``spread_line``: positive means home favored by that many points.
    """
    home = (total_line + spread_line) / 2.0
    away = (total_line - spread_line) / 2.0
    return away, home


def espn_logo_url(team: str) -> str:
    """ESPN CDN team logo (500px)."""
    key = _ESPN_ABBREV.get(team.upper(), team.lower())
    return f"https://a.espncdn.com/i/teamlogos/nfl/500/{key}.png"


_ESPN_ABBREV = {
    "ARI": "ari",
    "ATL": "atl",
    "BAL": "bal",
    "BUF": "buf",
    "CAR": "car",
    "CHI": "chi",
    "CIN": "cin",
    "CLE": "cle",
    "DAL": "dal",
    "DEN": "den",
    "DET": "det",
    "GB": "gb",
    "HOU": "hou",
    "IND": "ind",
    "JAC": "jax",
    "JAX": "jax",
    "KC": "kc",
    "LA": "lar",
    "LAR": "lar",
    "LAC": "lac",
    "LV": "lv",
    "MIA": "mia",
    "MIN": "min",
    "NE": "ne",
    "NO": "no",
    "NYG": "nyg",
    "NYJ": "nyj",
    "PHI": "phi",
    "PIT": "pit",
    "SEA": "sea",
    "SF": "sf",
    "TB": "tb",
    "TEN": "ten",
    "WAS": "wsh",
    "WSH": "wsh",
}


def _to_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
