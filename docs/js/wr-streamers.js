import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { chartTitleHead, drawStreamerChart } from "./streamer-chart.js?v=2";

export async function mountWrStreamersPage() {
  const root = document.getElementById("wr-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/wr-board.json");
  const players = Array.isArray(data.players) ? data.players : [];
  if (!players.length) {
    root.innerHTML = `<div class="error">No WR matchups in board.</div>`;
    revealPage();
    return;
  }

  root.innerHTML = `
    <div class="def-chart-head">
      ${chartTitleHead(`Week ${data.week} WR Fantasy Matchups`, data, formatUpdated)}
    </div>
    <div class="def-chart-wrap">
      <svg class="def-chart" role="img" aria-label="WR matchup scatter chart"></svg>
    </div>
  `;

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
