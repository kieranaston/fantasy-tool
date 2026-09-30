import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard, xfpVsActualOpts } from "./streamer-chart.js?v=11";

export async function mountQbStreamersPage() {
  const root = document.getElementById("qb-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/qb-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} QBs · Usage vs Efficiency`,
    data,
    formatUpdated,
    ariaLabel: "QB expected vs actual scatter chart",
    emptyMessage: "No QB matchups in board.",
    chartOpts: xfpVsActualOpts(),
  });
  revealPage();
}
