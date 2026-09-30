import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard, xfpVsActualOpts } from "./streamer-chart.js?v=11";

export async function mountRbStreamersPage() {
  const root = document.getElementById("rb-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/rb-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} RBs · Usage vs Efficiency`,
    data,
    formatUpdated,
    ariaLabel: "RB expected vs actual scatter chart",
    emptyMessage: "No RB matchups in board.",
    chartOpts: xfpVsActualOpts(),
  });
  revealPage();
}
