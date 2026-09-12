import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard } from "./streamer-chart.js?v=4";

function pct(rate) {
  return `${(rate * 100).toFixed(0)}%`;
}

function pctExact(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

export async function mountDefStreamersPage() {
  const root = document.getElementById("def-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/def-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} Fantasy Defenses`,
    data,
    formatUpdated,
    ariaLabel: "Defense streamer scatter chart",
    emptyMessage: "No DEF matchups in board.",
    chartOpts: {
      xKey: "projected_sack_rate",
      yKey: "vegas_projected_points",
      xSign: 1,
      ySign: -1,
      xTickStep: 0.01,
      yTickStep: 2,
      xFormat: pct,
      yFormat: (v) => v.toFixed(0),
      xLabel: "Projected Sack Rate",
      yLabel: "Opponent Implied Total",
      guideXLabel: "Median",
      guideYLabel: "Median",
      quadrantLabels: {
        topLeft: "Bad spot",
        bottomRight: "Good spot",
      },
      tooltip: (t) =>
        `${t.team} ${t.matchup_label} · sack ${pctExact(t.projected_sack_rate)} · opp implied ${t.vegas_projected_points}`,
    },
  });
  revealPage();
}
