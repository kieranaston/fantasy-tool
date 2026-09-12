import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard } from "./streamer-chart.js?v=4";

export async function mountRbStreamersPage() {
  const root = document.getElementById("rb-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/rb-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} RB Fantasy Matchups`,
    data,
    formatUpdated,
    ariaLabel: "RB matchup scatter chart",
    emptyMessage: "No RB matchups in board.",
    chartOpts: {
      xKey: "avg_half_ppr",
      yKey: "sos_adj",
      labelKey: "last_name",
      guideXKey: "avg_half_ppr",
      guideYKey: "sos_adj",
      xTickStep: 2,
      yTicks: [-2, -1, 0, 1, 2],
      guideXLabel: "10 FP",
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
    },
  });
  revealPage();
}
