import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard, xfpVsActualOpts } from "./streamer-chart.js?v=11";

export async function mountWrStreamersPage() {
  const root = document.getElementById("wr-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/wr-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} WRs · Usage vs Efficiency`,
    data,
    formatUpdated,
    ariaLabel: "WR expected vs actual scatter chart",
    emptyMessage: "No WR matchups in board.",
    chartOpts: xfpVsActualOpts(),
  });
  revealPage();
}
