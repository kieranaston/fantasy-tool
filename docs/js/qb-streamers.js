import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { chartTitleHead, drawStreamerChart } from "./streamer-chart.js?v=2";

export async function mountQbStreamersPage() {
  const root = document.getElementById("qb-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/qb-board.json");
  const players = Array.isArray(data.players) ? data.players : [];
  if (!players.length) {
    root.innerHTML = `<div class="error">No QB matchups in board.</div>`;
    revealPage();
    return;
  }

  root.innerHTML = `
    <div class="def-chart-head">
      ${chartTitleHead(`Week ${data.week} Fantasy QBs`, data, formatUpdated)}
    </div>
    <div class="def-chart-wrap">
      <svg class="def-chart" role="img" aria-label="QB streamer scatter chart"></svg>
    </div>
  `;

  const svg = root.querySelector(".def-chart");
  const draw = () =>
    drawStreamerChart(svg, data, {
      xKey: "implied_team_total",
      yKey: "rush_yards_per_game",
      labelKey: "last_name",
      guideXKey: "implied_team_total",
      guideYKey: "rush_yards_per_game",
      guideXLabel: "Median",
      guideYLabel: "Median",
      xTickStep: 2,
      yTickStep: 5,
      yIncludeZero: true,
      xFormat: (v) => v.toFixed(0),
      yFormat: (v) => v.toFixed(0),
      xLabel: "Team Implied Total",
      yLabel: "Rushing Yards Per Game",
      quadrantLabels: {
        topLeft: "Rushing floor",
        topRight: "Elite upside",
        bottomLeft: "Low ceiling",
        bottomRight: "Passing QBs",
      },
      tooltip: (t) =>
        `${t.player_name} (${t.team}) ${t.matchup_label} · ${t.implied_team_total} implied · ${t.rush_yards_per_game} rush yds/g`,
    });
  draw();
  revealPage();
  new ResizeObserver(draw).observe(root.querySelector(".def-chart-wrap"));
}
