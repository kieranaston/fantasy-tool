import { fetchJSON, formatUpdated, revealPage } from "./config.js";
import { mountStreamerBoard, xfpVsActualOpts } from "./streamer-chart.js?v=11";

export async function mountTeStreamersPage() {
  const root = document.getElementById("te-streamers");
  if (!root) return;

  const data = await fetchJSON("streamers/te-board.json");
  mountStreamerBoard(root, {
    title: `Week ${data.week} TEs · Usage vs Efficiency`,
    data,
    formatUpdated,
    ariaLabel: "TE expected vs actual scatter chart",
    emptyMessage: "No TE matchups in board.",
    chartOpts: xfpVsActualOpts(),
  });
  revealPage();
}
