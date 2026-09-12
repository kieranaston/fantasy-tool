import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard } from "./streamer-chart.js?v=4";

export async function mountWrStreamersPage() {
  const root = document.getElementById("wr-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/wr-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} WR Fantasy Matchups`,
    data,
    formatUpdated,
    ariaLabel: "WR matchup scatter chart",
    emptyMessage: "No WR matchups in board.",
    chartOpts: {
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
    },
  });
  revealPage();
}
