import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { chartPageShell, drawStreamerChart } from "./streamer-chart.js?v=3";

export async function mountTeStreamersPage() {
  const root = document.getElementById("te-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/te-board.json");
  const players = Array.isArray(data.players) ? data.players : [];
  if (!players.length) {
    root.innerHTML = `<div class="error">No TE matchups in board.</div>`;
    revealPage();
    return;
  }

  root.innerHTML = chartPageShell(
    `Week ${data.week} TE Fantasy Matchups`,
    data,
    formatUpdated,
    "TE matchup scatter chart"
  );

  const svg = root.querySelector(".def-chart");
  const draw = () =>
    drawStreamerChart(svg, data, {
      xKey: "avg_half_ppr",
      yKey: "sos_adj",
      labelKey: "last_name",
      guideXKey: "avg_half_ppr",
      guideYKey: "sos_adj",
      xTickStep: 2,
      yTickStep: 1,
      guideXLabel: "Median FP",
      guideYLabel: "Avg SOS",
      quadrantLabels: {
        topRight: "Good player, good matchup",
        bottomRight: "Good player, bad matchup",
      },
      xFormat: (v) => v.toFixed(0),
      yFormat: (v) => (v > 0 ? `+${v}` : String(v)),
      xLabel: "Average Fantasy Points",
      yLabel: "Opponents FPs Allowed (SOS Adj)",
      tooltip: (t) =>
        `${t.player_name} (${t.team}) ${t.matchup_label} · ${t.avg_half_ppr} avg · SOS ${t.sos_adj}`,
    });
  draw();
  revealPage();
  new ResizeObserver(draw).observe(root.querySelector(".def-chart-wrap"));
}
