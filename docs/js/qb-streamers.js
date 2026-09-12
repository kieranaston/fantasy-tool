import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard } from "./streamer-chart.js?v=4";

export async function mountQbStreamersPage() {
  const root = document.getElementById("qb-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/qb-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} Fantasy QBs`,
    data,
    formatUpdated,
    ariaLabel: "QB streamer scatter chart",
    emptyMessage: "No QB matchups in board.",
    chartOpts: {
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
    },
  });
  revealPage();
}
