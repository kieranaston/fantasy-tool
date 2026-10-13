"""Publish FantasyCalc trade values for the trade recommender.

Fetches the current crowdsourced values (auto-updated, no API key) and writes
``docs/data/trade/values.json`` keyed by Sleeper id. K/DEF are excluded by the
source and ignored by the model.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import httpx

from src.export.json_writer import utc_now_iso, write_json
from src.loaders.fantasycalc import fetch_fantasycalc_values, normalize_fc_values

ROOT = Path(__file__).resolve().parents[1]
TRADE_DIR = ROOT / "docs" / "data" / "trade"
OUT_NAME = "values.json"

SLEEPER_LEAGUE_URL = "https://api.sleeper.app/v1/league/{league_id}"
SUPERFLEX_SLOTS = {"SUPER_FLEX", "SUPERFLEX", "Q/W/R/T"}


def format_from_league(league_id: str) -> dict:
    """Derive FantasyCalc format params from a Sleeper league."""
    response = httpx.get(
        SLEEPER_LEAGUE_URL.format(league_id=league_id),
        headers={"User-Agent": "fantasy-tool/0.1"},
        timeout=30.0,
    )
    response.raise_for_status()
    league = response.json()
    positions = [str(p).upper() for p in (league.get("roster_positions") or [])]
    num_qbs = 2 if any(p in SUPERFLEX_SLOTS for p in positions) else 1
    rec = float((league.get("scoring_settings") or {}).get("rec", 1) or 0)
    ppr = 1 if rec >= 1 else (0.5 if rec >= 0.5 else 0)
    return {
        "name": league.get("name"),
        "num_teams": int(league.get("total_rosters") or 12),
        "num_qbs": num_qbs,
        "ppr": ppr,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", help="Sleeper league id; derives teams/1QB/PPR")
    parser.add_argument("--dynasty", action="store_true", help="dynasty (default: redraft)")
    parser.add_argument("--num-qbs", type=int, default=1)
    parser.add_argument("--num-teams", type=int, default=12)
    parser.add_argument("--ppr", type=float, default=1)
    # FantasyCalc currently only accepts tep="none"; other values 404.
    parser.add_argument("--tep", default="none")
    args = parser.parse_args()

    num_qbs, num_teams, ppr = args.num_qbs, args.num_teams, args.ppr
    league_name = None
    if args.league:
        fmt = format_from_league(args.league)
        num_qbs, num_teams, ppr = fmt["num_qbs"], fmt["num_teams"], fmt["ppr"]
        league_name = fmt["name"]
        print(f"League {args.league} ({league_name}): {num_teams}-team, "
              f"{'Superflex' if num_qbs == 2 else '1QB'}, {ppr} PPR")

    now = utc_now_iso()
    TRADE_DIR.mkdir(parents=True, exist_ok=True)

    print("Fetching FantasyCalc values…")
    raw = fetch_fantasycalc_values(
        is_dynasty=args.dynasty,
        num_qbs=num_qbs,
        num_teams=num_teams,
        ppr=ppr,
        tep=args.tep,
    )
    players = normalize_fc_values(raw)
    write_json(
        TRADE_DIR / OUT_NAME,
        {
            "source": "fantasycalc",
            "format": {
                "is_dynasty": args.dynasty,
                "num_qbs": num_qbs,
                "num_teams": num_teams,
                "ppr": ppr,
                "tep": args.tep,
            },
            "last_updated": now,
            "count": len(players),
            "players": players,
        },
        {"source", "format", "last_updated", "count", "players"},
    )
    print(f"  {len(players)} players → docs/data/trade/{OUT_NAME}")
    print("Done.")


if __name__ == "__main__":
    main()
