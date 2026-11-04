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
      yKey: "weather_index",
      labelKey: "last_name",
      // Must mirror K_CHART_*_WEIGHT in src/def_streamers/projection_pool.py.
      // The page sorts on the stored chart_score; these are only the fallback.
      xWeight: 0.6,
      yWeight: 0.4,
      xTickStep: 2,
      yTickStep: 0.5,
      xFormat: (v) => v.toFixed(0),
      yFormat: (v) => v.toFixed(1),
      xLabel: "Team Implied Total",
      yLabel: "Kickoff Weather (0 = ideal)",
      guideXLabel: "Charted median",
      guideYLabel: "Charted median",
      quadrantLabels: {
        topLeft: "Low total · good weather",
        topRight: "High total · good weather",
        bottomLeft: "Low total · poor weather",
        bottomRight: "High total · poor weather",
      },
      tooltip: (t) => {
        const wx =
          t.weather_source === "indoors"
            ? "indoors"
            : t.weather_source === "forecast"
              ? `${Math.round(t.wind_mph)} mph wind, ${Math.round(t.temp_f)}°F`
              : "weather n/a";
        return `${t.player_name || t.team} (${t.team}) ${t.matchup_label} · ${wx} · ${t.vegas_projected_points} pts`;
      },
    },
  });
  revealPage();
}
