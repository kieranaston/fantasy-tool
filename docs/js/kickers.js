import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { chartPageShell, drawStreamerChart } from "./streamer-chart.js?v=3";

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

  root.innerHTML = chartPageShell(
    `Week ${data.week} Fantasy Kickers`,
    data,
    formatUpdated,
    "Kicker streamer scatter chart"
  );

  const svg = root.querySelector(".def-chart");
  const draw = () =>
    drawStreamerChart(svg, data, {
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
    });
  draw();
  revealPage();
  new ResizeObserver(draw).observe(root.querySelector(".def-chart-wrap"));
}
