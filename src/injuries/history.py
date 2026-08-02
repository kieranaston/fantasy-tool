"""Comprehensive season injury/availability history from nflverse sources."""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

import polars as pl

REG_WEEKS = range(1, 19)
OUT_STATUSES = frozenset({"out", "doubtful"})
NOTE_STATUSES = frozenset({"out", "doubtful", "questionable"})
MIN_MISSED_WEEKS = 2

# High-level roster status (nflverse dictionary_roster_status).
ROSTER_STATUS_LABELS = {
    "ACT": "Active",
    "INA": "Inactive",
    "RES": "Reserve",
    "DEV": "Practice squad",
    "CUT": "Cut",
    "EXE": "Exempt",
    "PUP": "PUP",
    "SUS": "Suspended",
    "RET": "Retired",
    "RSN": "Non-football IR",
}

# Common status_description_abbr values seen on RES/INA rows.
STATUS_ABBR_LABELS = {
    "A01": "Active / inactive list",
    "R01": "Injured Reserve",
    "R02": "Reserve / Non-Football Injury",
    "R03": "Reserve / Non-Football Illness",
    "R04": "Reserve / Retired",
    "R05": "Reserve / Suspended",
    "R06": "Reserve / Did Not Report",
    "R09": "Reserve / Left Squad",
    "R23": "Reserve / COVID-19",
    "R27": "Reserve / Military",
    "R36": "Reserve / Commissioner's Exempt",
    "R40": "Reserve / Future",
    "R48": "IR — designated to return",
    "P01": "Practice squad",
    "P02": "Practice squad / Injured",
    "P03": "Practice squad / COVID-19",
    "P04": "Practice squad / International",
    "P06": "Practice squad / Exemption",
    "P07": "Practice squad / Protected",
    "I01": "Injured — short-term",
    "I02": "Injured — short-term",
    "W03": "Waived / Injured",
    "W04": "Waived",
    "E02": "Exempt",
    "F01": "Future contract",
}


def _norm(value: str | None) -> str:
    return (value or "").strip()


def _norm_lower(value: str | None) -> str:
    return _norm(value).lower()


def format_week_ranges(weeks: list[int]) -> str:
    """Compress sorted weeks into 'W3–4, W8, W10–11'."""
    if not weeks:
        return ""
    ordered = sorted({int(w) for w in weeks})
    ranges: list[tuple[int, int]] = []
    start = prev = ordered[0]
    for week in ordered[1:]:
        if week == prev + 1:
            prev = week
            continue
        ranges.append((start, prev))
        start = prev = week
    ranges.append((start, prev))
    parts: list[str] = []
    for lo, hi in ranges:
        parts.append(f"W{lo}" if lo == hi else f"W{lo}–{hi}")
    return ", ".join(parts)


def _clusters(week_values: list[tuple[int, str]]) -> list[dict[str, Any]]:
    if not week_values:
        return []
    out: list[dict[str, Any]] = []
    cur_val, cur_weeks = week_values[0][1], [week_values[0][0]]
    for week, value in week_values[1:]:
        if value == cur_val and week == cur_weeks[-1] + 1:
            cur_weeks.append(week)
            continue
        out.append({"label": cur_val, "weeks": cur_weeks})
        cur_val, cur_weeks = value, [week]
    out.append({"label": cur_val, "weeks": cur_weeks})
    return out


def roster_detail_label(status: str | None, abbr: str | None) -> str:
    status = _norm(status).upper()
    abbr = _norm(abbr).upper()
    if status == "INA":
        return "Inactive"
    if status == "ACT":
        return "Active"
    if abbr in STATUS_ABBR_LABELS and status != "ACT":
        return STATUS_ABBR_LABELS[abbr]
    if status in ROSTER_STATUS_LABELS:
        base = ROSTER_STATUS_LABELS[status]
        return f"{base} ({abbr})" if abbr else base
    if status or abbr:
        return " / ".join(x for x in (status, abbr) if x)
    return "Unknown"


def load_ranking_pool(docs_data) -> list[dict[str, Any]]:
    """Collect player rows from exported Sleeper ADP boards (skill positions)."""
    import json
    from pathlib import Path

    docs_data = Path(docs_data)
    pool: list[dict[str, Any]] = []
    seen: set[str] = set()
    # Prefer full_ppr order, then backfill anyone only present in half_ppr.
    format_keys = ("full_ppr", "half_ppr")

    for position in ("qb", "rb", "wr", "te"):
        path = docs_data / position / "adp.json"
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        players_by_format = payload.get("players") or {}
        for format_key in format_keys:
            for row in players_by_format.get(format_key) or []:
                pid = row.get("player_id")
                if not pid or pid in seen:
                    continue
                # Injury history is GSIS-keyed via nflverse; skip Sleeper-only ids.
                if str(pid).startswith("sleeper:"):
                    continue
                seen.add(pid)
                pool.append({
                    "player_id": pid,
                    "player_name": row.get("player") or "",
                    "position": (
                        row.get("position")
                        or payload.get("position")
                        or position
                    ).upper(),
                    "team": row.get("team") or "",
                    "games_played": 0,
                    "logo": row.get("logo"),
                })
    return pool


def _team_game_weeks(schedules: pl.DataFrame) -> dict[str, set[int]]:
    reg = schedules.filter(
        (pl.col("game_type") == "REG") & pl.col("week").is_in(list(REG_WEEKS))
    )
    by_team: dict[str, set[int]] = defaultdict(set)
    for row in reg.iter_rows(named=True):
        week = int(row["week"])
        by_team[str(row["home_team"])].add(week)
        by_team[str(row["away_team"])].add(week)
    return dict(by_team)


def _player_weekly_appearances(
    weekly: pl.DataFrame,
    player_ids: set[str],
) -> tuple[dict[str, set[int]], dict[str, str]]:
    frame = weekly.filter(
        pl.col("player_id").is_in(list(player_ids))
        & (pl.col("season_type") == "REG")
        & pl.col("week").is_in(list(REG_WEEKS))
    ).select("player_id", pl.col("week").cast(pl.Int32), "team")
    played: dict[str, set[int]] = defaultdict(set)
    teams: dict[str, Counter] = defaultdict(Counter)
    for row in frame.iter_rows(named=True):
        pid = str(row["player_id"])
        played[pid].add(int(row["week"]))
        if row.get("team"):
            teams[pid][str(row["team"])] += 1
    primary = {
        pid: counts.most_common(1)[0][0] for pid, counts in teams.items() if counts
    }
    return dict(played), primary


def _consecutive_spans(weeks: list[int]) -> list[list[int]]:
    """Group sorted weeks into contiguous runs."""
    if not weeks:
        return []
    ordered = sorted({int(w) for w in weeks})
    spans: list[list[int]] = [[ordered[0]]]
    for week in ordered[1:]:
        if week == spans[-1][-1] + 1:
            spans[-1].append(week)
        else:
            spans.append([week])
    return spans


def _span_injury(span_weeks: list[int], week_rows: list[dict[str, Any]]) -> str | None:
    by_week = {int(w["week"]): w for w in week_rows}
    names = []
    for week in span_weeks:
        injury = (by_week.get(week) or {}).get("injury")
        if (
            injury
            and injury != "Undisclosed"
            and not str(injury).lower().startswith("not injury")
        ):
            names.append(str(injury))
    if not names:
        return None
    return Counter(names).most_common(1)[0][0]


def _span_status(span_weeks: list[int], week_rows: list[dict[str, Any]]) -> str:
    by_week = {int(w["week"]): w for w in week_rows}
    statuses = [
        (by_week.get(week) or {}).get("roster_status") for week in span_weeks
    ]
    counts = Counter(s for s in statuses if s)
    if not counts:
        return "missed"
    top = counts.most_common(1)[0][0]
    if top == "RES":
        return "IR"
    if top == "INA":
        return "inactive"
    return "missed"


def _played_between(
    earlier: list[int],
    later: list[int],
    played_weeks: set[int],
) -> list[int]:
    if not earlier or not later:
        return []
    lo = earlier[-1] + 1
    hi = later[0]
    return sorted(w for w in played_weeks if lo <= w < hi)


def build_overview(record: dict[str, Any]) -> str:
    """Narrative overview of absence stretches, returns, and injuries."""
    gp = int(record.get("games_played") or 0)
    tg = int(record.get("team_games") or 0)
    missed = list(record.get("missed_weeks") or [])
    week_rows = list(record.get("weeks") or [])
    played_weeks = {
        int(w["week"]) for w in week_rows if w.get("player_played")
    }

    if not missed:
        if tg:
            return f"Played all {tg} team games with no multi-week absences."
        return "No multi-week absences recorded."

    spans = _consecutive_spans(missed)
    described: list[dict[str, Any]] = []
    for span in spans:
        described.append({
            "weeks": span,
            "n": len(span),
            "range": format_week_ranges(span),
            "injury": _span_injury(span, week_rows),
            "status": _span_status(span, week_rows),
        })

    def _clause(span: dict[str, Any], *, include_games: bool = True) -> str:
        bits = [span["range"]]
        if include_games and span["n"] > 1:
            bits.append(f"{span['n']} games")
        elif include_games and span["n"] == 1:
            bits.append("1 game")
        if span["status"] == "IR":
            bits.append("IR")
        elif span["status"] == "inactive":
            bits.append("inactive")
        if span["injury"]:
            bits.append(span["injury"].lower())
        if len(bits) == 1:
            return bits[0]
        head, *rest = bits
        return f"{head} ({', '.join(rest)})"

    total = len(missed)
    opener = f"Played {gp} of {tg} team games," if tg else f"Played {gp} games,"

    if len(described) == 1:
        span = described[0]
        games_bit = f"{total} game" if total == 1 else f"{total} games"
        if span["injury"] and span["status"] == "IR":
            return (
                f"{opener} missing {games_bit} in one IR stretch "
                f"({span['range']}) with a {span['injury'].lower()}."
            )
        if span["injury"]:
            return (
                f"{opener} missing {games_bit} in one stretch "
                f"due to a {span['injury'].lower()} ({span['range']})."
            )
        if span["status"] == "IR":
            return (
                f"{opener} missing {games_bit} in one IR stretch "
                f"({span['range']})."
            )
        return (
            f"{opener} missing {games_bit} in one stretch "
            f"({span['range']})."
        )

    # Multiple stretches — narrate in order with returns between.
    injuries = [s["injury"] for s in described if s["injury"]]
    same_injury = len(set(injuries)) == 1 and len(injuries) == len(described)

    if len(described) == 2:
        first, second = described
        mid = _played_between(first["weeks"], second["weeks"], played_weeks)
        mid_bit = ""
        if mid:
            n = len(mid)
            mid_bit = (
                f", returned for {n} game{'s' if n != 1 else ''}, then "
            )
        else:
            mid_bit = ", then "

        if same_injury and first["injury"]:
            injury = first["injury"].lower()
            return (
                f"{opener} missing {total} games across two stretches "
                f"with a {injury}: {_clause(first)}{mid_bit}{_clause(second)}."
            )
        return (
            f"{opener} missing {total} games across two stretches: "
            f"{_clause(first)}{mid_bit}{_clause(second)}."
        )

    # 3+ stretches
    unique_injuries = list(dict.fromkeys(injuries))
    stretch_word = "stretches" if len(described) > 1 else "stretch"
    lead = (
        f"{opener} missing {total} games across {len(described)} {stretch_word}"
    )
    if len(unique_injuries) == 1:
        lead += f" ({unique_injuries[0].lower()})"
    elif 1 < len(unique_injuries) <= 3:
        lead += f" ({'/'.join(i.lower() for i in unique_injuries)})"

    pieces: list[str] = []
    for idx, span in enumerate(described):
        piece = _clause(span)
        if idx > 0:
            mid = _played_between(
                described[idx - 1]["weeks"], span["weeks"], played_weeks
            )
            if mid:
                n = len(mid)
                piece = (
                    f"played {n} in between, then {piece}"
                )
        pieces.append(piece)

    if len(pieces) <= 5:
        body = "; ".join(pieces)
        return f"{lead}: {body}."

    # Very choppy seasons — summarize pattern instead of listing everything.
    long_spans = [s for s in described if s["n"] >= 3]
    if long_spans:
        long_bit = ", ".join(_clause(s) for s in long_spans[:3])
        n_long = len(long_spans)
        abs_word = "absence" if n_long == 1 else "absences"
        return (
            f"{lead}, including {n_long} longer {abs_word} "
            f"({long_bit})."
        )
    return (
        f"{lead} with frequent short absences "
        f"({format_week_ranges(missed)})."
    )


def build_label(record: dict[str, Any]) -> str:
    ir_weeks = record.get("ir_weeks") or []
    missed = record.get("missed_weeks") or []
    injuries = record.get("primary_injuries") or []
    injury_bit = "/".join(i.lower() for i in injuries[:2]) if injuries else ""

    if ir_weeks:
        n = len(ir_weeks)
        unit = "wk" if n == 1 else "wks"
        base = f"IR {n} {unit}"
        return f"{base} · {injury_bit}" if injury_bit else base
    if missed:
        n = len(missed)
        unit = "game" if n == 1 else "games"
        base = f"Missed {n} {unit}"
        return f"{base} · {injury_bit}" if injury_bit else base
    out_weeks = record.get("out_weeks") or []
    if out_weeks:
        n = len(out_weeks)
        unit = "wk" if n == 1 else "wks"
        base = f"Out {n} {unit}"
        return f"{base} · {injury_bit}" if injury_bit else base
    return ""


def aggregate_injury_history(
    *,
    season: int,
    pool: list[dict[str, Any]],
    injuries: pl.DataFrame | None = None,
    weekly: pl.DataFrame | None = None,
    schedules: pl.DataFrame | None = None,
    rosters_weekly: pl.DataFrame | None = None,
) -> list[dict[str, Any]]:
    """Combine weekly rosters, injury reports, and game appearances."""
    if not pool:
        return []

    import nflreadpy as nfl

    if injuries is None:
        injuries = nfl.load_injuries(seasons=season)
    if weekly is None:
        weekly = nfl.load_player_stats(seasons=season, summary_level="week")
    if schedules is None:
        schedules = nfl.load_schedules(seasons=season)
    if rosters_weekly is None:
        rosters_weekly = nfl.load_rosters_weekly(seasons=season)

    id_set = {p["player_id"] for p in pool}
    meta = {p["player_id"]: p for p in pool}
    team_weeks = _team_game_weeks(schedules)
    played_weeks, weekly_teams = _player_weekly_appearances(weekly, id_set)

    # --- Injury reports by player/week ---
    report_by: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    for row in (
        injuries.filter(
            pl.col("gsis_id").is_in(list(id_set))
            & (pl.col("season_type") == "REG")
            & pl.col("week").is_in(list(REG_WEEKS))
        )
        .select(
            pl.col("gsis_id").alias("player_id"),
            pl.col("week").cast(pl.Int32),
            "report_status",
            "report_primary_injury",
            "report_secondary_injury",
            "practice_status",
            "practice_primary_injury",
            "practice_secondary_injury",
        )
        .unique(subset=["player_id", "week"], keep="last")
        .iter_rows(named=True)
    ):
        injury = (
            _norm(row.get("report_primary_injury"))
            or _norm(row.get("practice_primary_injury"))
            or None
        )
        report_by[row["player_id"]][int(row["week"])] = {
            "report_status": _norm(row.get("report_status")) or None,
            "report_primary_injury": _norm(row.get("report_primary_injury")) or None,
            "report_secondary_injury": _norm(row.get("report_secondary_injury")) or None,
            "practice_status": _norm(row.get("practice_status")) or None,
            "practice_primary_injury": _norm(row.get("practice_primary_injury")) or None,
            "practice_secondary_injury": _norm(row.get("practice_secondary_injury"))
            or None,
            "injury": injury,
        }

    # --- Weekly roster status by player/week ---
    roster_by: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    for row in (
        rosters_weekly.filter(
            pl.col("gsis_id").is_in(list(id_set))
            & (pl.col("game_type") == "REG")
            & pl.col("week").is_in(list(REG_WEEKS))
        )
        .select(
            pl.col("gsis_id").alias("player_id"),
            pl.col("week").cast(pl.Int32),
            "team",
            "status",
            "status_description_abbr",
        )
        .unique(subset=["player_id", "week"], keep="last")
        .iter_rows(named=True)
    ):
        status = _norm(row.get("status")).upper() or None
        abbr = _norm(row.get("status_description_abbr")).upper() or None
        roster_by[row["player_id"]][int(row["week"])] = {
            "team": _norm(row.get("team")) or None,
            "status": status,
            "status_abbr": abbr,
            "roster_label": roster_detail_label(status, abbr),
        }

    records: list[dict[str, Any]] = []
    for player in pool:
        pid = player["player_id"]
        team = weekly_teams.get(pid) or player.get("team") or ""
        scheduled = set(team_weeks.get(team, set()))
        played = set(played_weeks.get(pid, set()))
        missed = sorted(scheduled - played)
        bye_weeks = sorted(set(REG_WEEKS) - scheduled) if team else []

        reports = report_by.get(pid) or {}
        rosters = roster_by.get(pid) or {}

        # Carry forward last known injury body part across IR gaps.
        last_injury: str | None = None
        week_rows: list[dict[str, Any]] = []
        ir_weeks: list[int] = []
        inactive_weeks: list[int] = []
        out_weeks: list[int] = []
        doubtful_weeks: list[int] = []
        injury_names: list[str] = []
        roster_labels_by_week: list[tuple[int, str]] = []

        for week in REG_WEEKS:
            report = reports.get(week) or {}
            roster = rosters.get(week) or {}
            status = roster.get("status")
            abbr = roster.get("status_abbr")
            report_status = _norm_lower(report.get("report_status"))
            injury = report.get("injury") or last_injury
            if report.get("injury"):
                last_injury = report["injury"]
                relevant = (
                    status in {"RES", "INA"}
                    or report_status in OUT_STATUSES | {"questionable"}
                    or (week in played) is False and week in scheduled
                )
                raw_injury = report["injury"]
                if (
                    relevant
                    and raw_injury
                    and raw_injury != "Undisclosed"
                    and not str(raw_injury).lower().startswith("not injury")
                ):
                    injury_names.append(raw_injury)

            team_played = week in scheduled
            player_played = week in played
            is_bye = bool(team) and week not in scheduled

            if status == "RES" or (abbr or "").startswith("R"):
                if status == "RES":
                    ir_weeks.append(week)
            if status == "INA":
                inactive_weeks.append(week)
            if report_status == "out":
                out_weeks.append(week)
            elif report_status == "doubtful":
                doubtful_weeks.append(week)

            roster_label = roster.get("roster_label")
            if roster_label and status in {"RES", "INA", "PUP"}:
                # Attach injury to roster span key when known.
                span_key = roster_label
                if injury and status == "RES":
                    span_key = f"{roster_label} · {injury}"
                roster_labels_by_week.append((week, span_key))

            week_rows.append({
                "week": week,
                "is_bye": is_bye,
                "team_played": team_played,
                "player_played": player_played,
                "roster_status": status,
                "roster_status_abbr": abbr,
                "roster_label": roster_label,
                "report_status": report.get("report_status"),
                "practice_status": report.get("practice_status"),
                "injury": injury if (status in {"RES", "INA"} or report or not player_played) else report.get("injury"),
                "report_primary_injury": report.get("report_primary_injury"),
                "practice_primary_injury": report.get("practice_primary_injury"),
            })

        ir_weeks = sorted(set(ir_weeks))
        inactive_weeks = sorted(set(inactive_weeks))
        out_weeks = sorted(set(out_weeks))
        doubtful_weeks = sorted(set(doubtful_weeks))

        include = (
            bool(ir_weeks)
            or bool(out_weeks)
            or len(missed) >= MIN_MISSED_WEEKS
            or len(inactive_weeks) >= MIN_MISSED_WEEKS
        )
        if not include:
            continue

        primary = [name for name, _ in Counter(injury_names).most_common(5)]
        if not primary:
            carried = [
                w.get("injury")
                for w in week_rows
                if w.get("week") in set(ir_weeks + inactive_weeks + missed)
                and w.get("injury")
                and w.get("injury") != "Undisclosed"
                and not str(w.get("injury")).lower().startswith("not injury")
            ]
            primary = [name for name, _ in Counter(carried).most_common(5)]
        roster_spans = []
        for cluster in _clusters(roster_labels_by_week):
            label = cluster["label"]
            injury = None
            if " · " in label:
                label, injury = label.split(" · ", 1)
            roster_spans.append({
                "label": label,
                "injury": injury,
                "weeks": cluster["weeks"],
            })

        # Official Out spans with body part.
        out_events = []
        for week in out_weeks + doubtful_weeks:
            report = reports.get(week) or {}
            out_events.append((
                week,
                report.get("report_primary_injury")
                or report.get("injury")
                or "Undisclosed",
            ))
        out_events.sort(key=lambda x: x[0])
        injury_spans = [
            {"injury": c["label"], "weeks": c["weeks"]}
            for c in _clusters(out_events)
        ]

        record = {
            "player_id": pid,
            "player_name": player.get("player_name") or "",
            "position": player.get("position") or "",
            "team": team,
            "logo": player.get("logo"),
            "games_played": len(played),
            "team_games": len(scheduled),
            "bye_weeks": bye_weeks,
            "missed_weeks": missed,
            "ir_weeks": ir_weeks,
            "inactive_weeks": inactive_weeks,
            "out_weeks": out_weeks,
            "doubtful_weeks": doubtful_weeks,
            "primary_injuries": primary,
            "roster_spans": roster_spans,
            "injury_spans": injury_spans,
            "weeks": week_rows,
        }
        record["label"] = build_label(record)
        record["overview"] = build_overview(record)
        # Keep summary alias for rankings tooltip compatibility.
        record["summary"] = record["overview"]
        if record["label"]:
            records.append(record)

    records.sort(
        key=lambda r: (
            -len(r.get("ir_weeks") or []),
            -len(r.get("missed_weeks") or []),
            r["player_name"],
        )
    )
    return records
