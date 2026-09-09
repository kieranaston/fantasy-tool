"""Refresh weekly fantasy streamer boards (DEF + kickers) → docs/data/streamers/."""

from __future__ import annotations

from pathlib import Path

from src.def_streamers.board import build_def_board
from src.def_streamers.k_board import build_k_board
from src.def_streamers.qb_board import build_qb_board
from src.def_streamers.rb_board import build_rb_board
from src.def_streamers.wr_board import build_wr_board
from src.export.json_writer import utc_now_iso, write_json

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs" / "data" / "streamers"


def _write(name: str, board: dict, required: set[str]) -> None:
    path = OUT_DIR / name
    write_json(path, board, required)
    print(
        f"  {name}: season={board['season']} week={board['week']} "
        f"teams={len(board['teams'])}"
    )


def main() -> None:
    now = utc_now_iso()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Building streamer boards…")
    def_board = build_def_board()
    def_board["last_updated"] = now
    _write(
        "def-board.json",
        def_board,
        {
            "season",
            "week",
            "sack_season",
            "pbp_seasons",
            "sack_window_games",
            "sack_formula",
            "sack_note",
            "x_formula",
            "y_formula",
            "source",
            "last_updated",
            "medians",
            "teams",
        },
    )
    print(
        f"    sack_season={def_board['sack_season']} "
        f"pbp={def_board['pbp_seasons']} window={def_board['sack_window_games']}"
    )

    k_board = build_k_board()
    k_board["last_updated"] = now
    _write(
        "k-board.json",
        k_board,
        {
            "season",
            "week",
            "fg_season",
            "pbp_seasons",
            "fg_window_games",
            "fg_note",
            "x_formula",
            "y_formula",
            "source",
            "last_updated",
            "medians",
            "teams",
        },
    )
    print(
        f"    fg_season={k_board['fg_season']} "
        f"pbp={k_board['pbp_seasons']} window={k_board['fg_window_games']}"
    )

    qb_board = build_qb_board()
    qb_board["last_updated"] = now
    _write(
        "qb-board.json",
        qb_board,
        {
            "season",
            "week",
            "position",
            "stats_season",
            "stat_seasons",
            "rush_window_games",
            "stats_note",
            "x_formula",
            "y_formula",
            "source",
            "last_updated",
            "guides",
            "medians",
            "players",
            "teams",
        },
    )
    print(
        f"    stats_season={qb_board['stats_season']} "
        f"stats={qb_board['stat_seasons']} players={len(qb_board['players'])}"
    )

    rb_board = build_rb_board()
    rb_board["last_updated"] = now
    _write(
        "rb-board.json",
        rb_board,
        {
            "season",
            "week",
            "position",
            "stats_season",
            "stat_seasons",
            "stats_window_games",
            "scoring",
            "stats_note",
            "x_formula",
            "y_formula",
            "source",
            "last_updated",
            "guides",
            "medians",
            "players",
            "teams",
        },
    )
    print(
        f"    stats_season={rb_board['stats_season']} "
        f"stats={rb_board['stat_seasons']} players={len(rb_board['players'])}"
    )

    wr_board = build_wr_board()
    wr_board["last_updated"] = now
    _write(
        "wr-board.json",
        wr_board,
        {
            "season",
            "week",
            "position",
            "stats_season",
            "stat_seasons",
            "stats_window_games",
            "scoring",
            "stats_note",
            "x_formula",
            "y_formula",
            "source",
            "last_updated",
            "guides",
            "medians",
            "players",
            "teams",
        },
    )
    print(
        f"    stats_season={wr_board['stats_season']} "
        f"stats={wr_board['stat_seasons']} players={len(wr_board['players'])}"
    )
    print("Done.")


if __name__ == "__main__":
    main()
