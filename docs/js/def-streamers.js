import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard } from "./streamer-chart.js?v=14";

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
      // Must mirror DEF_CHART_*_WEIGHT in src/def_streamers/projection_pool.py.
      // The page sorts on the stored chart_score; these are only the fallback.
      xWeight: 0.2,
      yWeight: 0.8,
      xTickStep: 0.01,
      yTickStep: 2,
      xFormat: pct,
      yFormat: (v) => v.toFixed(0),
      xLabel: "Projected Sack Rate",
      yLabel: "Opponent Implied Total",
      guideXLabel: "Charted median",
      guideYLabel: "Charted median",
      quadrantLabels: {
        topLeft: "Low sack · high total",
        topRight: "High sack · high total",
        bottomLeft: "Low sack · low total",
        bottomRight: "High sack · low total",
      },
      tooltip: (t) =>
        `${t.team} ${t.matchup_label} · sack ${pctExact(t.projected_sack_rate)} · opp implied ${t.vegas_projected_points}`,
    },
  });
  revealPage();
}
