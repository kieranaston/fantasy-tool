import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard } from "./streamer-chart.js?v=4";

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
      xTickStep: 2,
      yTickStep: 0.5,
      xFormat: (v) => v.toFixed(0),
      yFormat: (v) => v.toFixed(1),
      xLabel: "Team Implied Total",
      yLabel: "Team FG Attempts Per Game",
      guideXLabel: "Median",
      guideYLabel: "Median",
      quadrantLabels: {
        topRight: "Smash",
        bottomLeft: "Fade",
      },
      tooltip: (t) =>
        `${t.player_name || t.team} (${t.team}) ${t.matchup_label} · ${t.fg_attempts_per_game.toFixed(2)} FG/g · ${t.vegas_projected_points} pts`,
    },
  });
  revealPage();
}
