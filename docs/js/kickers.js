import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard } from "./streamer-chart.js?v=14";

export async function mountKStreamersPage() {
  const root = document.getElementById("k-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/k-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} Fantasy Kickers`,
    data,
    formatUpdated,
    ariaLabel: "Kicker streamer scatter chart",
    emptyMessage: "No kicker matchups in board.",
    chartOpts: {
      xKey: "vegas_projected_points",
      yKey: "fg_attempts_per_game",
      labelKey: "last_name",
      // Must mirror K_CHART_*_WEIGHT in src/def_streamers/projection_pool.py.
      // The page sorts on the stored chart_score; these are only the fallback.
      xWeight: 0.8,
      yWeight: 0.2,
      xTickStep: 2,
      yTickStep: 0.5,
      xFormat: (v) => v.toFixed(0),
      yFormat: (v) => v.toFixed(1),
      xLabel: "Team Implied Total",
      yLabel: "Team FG Attempts Per Game",
      guideXLabel: "Charted median",
      guideYLabel: "Charted median",
      quadrantLabels: {
        topLeft: "Low total · many FG",
        topRight: "High total · many FG",
        bottomLeft: "Low total · few FG",
        bottomRight: "High total · few FG",
      },
      tooltip: (t) =>
        `${t.player_name || t.team} (${t.team}) ${t.matchup_label} · ${t.fg_attempts_per_game.toFixed(2)} FG/g · ${t.vegas_projected_points} pts`,
    },
  });
  revealPage();
}
