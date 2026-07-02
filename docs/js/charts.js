import { fetchJSON, showError } from "./config.js";

const CHART_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

/** Load trend chart JSON and render a Chart.js line chart. */
async function renderTrendChart(canvasId, jsonPath) {
  const container = document.getElementById("chart-container");
  try {
    const chartData = await fetchJSON(jsonPath);
    document.getElementById("chart-title").textContent = chartData.title;

    const ctx = document.getElementById(canvasId).getContext("2d");
    new Chart(ctx, {
      type: "line",
      data: {
        labels: chartData.labels,
        datasets: chartData.datasets.map((dataset, index) => ({
          label: dataset.label,
          data: dataset.data,
          borderColor: CHART_COLORS[index % CHART_COLORS.length],
          backgroundColor: CHART_COLORS[index % CHART_COLORS.length] + "33",
          tension: 0.2,
          fill: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { labels: { color: "#e7ecf3" } },
        },
        scales: {
          x: {
            ticks: { color: "#8b9cb3" },
            grid: { color: "#2d3a4f" },
          },
          y: {
            ticks: { color: "#8b9cb3" },
            grid: { color: "#2d3a4f" },
            title: {
              display: true,
              text: "Half-PPR Points",
              color: "#8b9cb3",
            },
          },
        },
      },
    });
  } catch (err) {
    showError(container, err.message);
  }
}

export { renderTrendChart };
