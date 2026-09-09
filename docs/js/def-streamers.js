import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { chartTitleHead, drawStreamerChart } from "./streamer-chart.js";

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
  const teams = Array.isArray(data.teams) ? data.teams : [];
  if (!teams.length) {
    root.innerHTML = `<div class="error">No DEF matchups in board.</div>`;
    revealPage();
    return;
  }

  root.innerHTML = `
    <div class="def-chart-head">
      ${chartTitleHead(`Week ${data.week} Fantasy Defenses`, data, formatUpdated)}
    </div>
    <div class="def-chart-wrap">
      <svg class="def-chart" role="img" aria-label="Defense streamer scatter chart"></svg>
    </div>
  `;

  const svg = root.querySelector(".def-chart");
  const draw = () =>
    drawStreamerChart(svg, data, {
      xKey: "projected_sack_rate",
      yKey: "vegas_projected_points",
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
    });
  draw();
  revealPage();
  new ResizeObserver(draw).observe(root.querySelector(".def-chart-wrap"));
}
