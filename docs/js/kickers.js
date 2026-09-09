import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { chartTitleHead, drawStreamerChart } from "./streamer-chart.js";

export async function mountKStreamersPage() {
  const root = document.getElementById("k-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/k-board.json");
  const teams = Array.isArray(data.teams) ? data.teams : [];
  if (!teams.length) {
    root.innerHTML = `<div class="error">No kicker matchups in board.</div>`;
    revealPage();
    return;
  }

  root.innerHTML = `
    <div class="def-chart-head">
      ${chartTitleHead(`Week ${data.week} Fantasy Kickers`, data, formatUpdated)}
    </div>
    <div class="def-chart-wrap">
      <svg class="def-chart" role="img" aria-label="Kicker streamer scatter chart"></svg>
    </div>
  `;

  const svg = root.querySelector(".def-chart");
  const draw = () =>
    drawStreamerChart(svg, data, {
      xKey: "vegas_projected_points",
      yKey: "fg_attempts_per_game",
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
        `${t.team} ${t.matchup_label} · ${t.fg_attempts_per_game.toFixed(2)} FG/g · ${t.vegas_projected_points} pts`,
    });
  draw();
  revealPage();
  new ResizeObserver(draw).observe(root.querySelector(".def-chart-wrap"));
}
