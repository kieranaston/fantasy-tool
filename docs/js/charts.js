import { fetchJSON, showError } from "./config.js";

function loadLogo(src) {
  if (!src) {
    return null;
  }

  const image = new Image();
  image.src = src;
  return image;
}

function wrapName(name) {
  const parts = name.split(" ");
  if (parts.length <= 2) {
    return [name];
  }

  return [parts.slice(0, -1).join(" "), parts.at(-1)];
}

const playerLabelPlugin = {
  id: "playerLabelPlugin",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    const points = chart.data.datasets[0].data;
    const area = chart.chartArea;
    const logoSize = 26;
    const labelGap = 4;
    const labelFontSize = 12;
    const labelLineHeight = 13;

    ctx.save();
    // Clip to the chart area so logos/labels don't bleed into axes or outside the box
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top + 86);
    ctx.clip();
    ctx.textBaseline = "top";

    meta.data.forEach((element, index) => {
      const point = points[index];
      const x = element.x;
      const y = element.y;
      const logoX = x - logoSize / 2;
      const logoY = y - logoSize / 2;

      if (point.logoImage?.complete && point.logoImage.naturalWidth > 0) {
        ctx.drawImage(point.logoImage, logoX, logoY, logoSize, logoSize);
      } else {
        ctx.fillStyle = point.team_color || "#2563eb";
        ctx.font = "700 10px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(point.team, x, logoY + 8);
      }

      const labelLines = wrapName(point.player);
      const labelY = logoY + logoSize + labelGap;
      ctx.fillStyle = "#0f172a";
      ctx.textAlign = "center";
      ctx.font = `700 ${labelFontSize}px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
      labelLines.forEach((line, lineIndex) => {
        ctx.fillText(line, x, labelY + lineIndex * labelLineHeight);
      });
    });

    ctx.restore();
  },
};

function buildScatterDataset(chartData) {
  const points = Array.isArray(chartData?.points) ? chartData.points : [];
  return points.map((point) => ({
    ...point,
    logoImage: loadLogo(point.logo),
  }));
}

/** Load production-vs-opportunity JSON and render a labeled Chart.js scatter plot. */
async function renderTrendChart(canvasId, jsonPath) {
  const container = document.getElementById("chart-container");
  try {
    const chartData = await fetchJSON(jsonPath);
    document.getElementById("chart-title").textContent = chartData.title;

    const points = buildScatterDataset(chartData).slice(0, 18);
    if (!points.length) {
      throw new Error("No chart points were returned.");
    }
    const ctx = document.getElementById(canvasId).getContext("2d");
    const chart = new Chart(ctx, {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "Wide Receivers",
            data: points,
            parsing: false,
            pointRadius: 0,
            pointHoverRadius: 0,
          },
        ],
      },
      plugins: [playerLabelPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        events: [],
        layout: {
          padding: { top: 18, right: 56, bottom: 86, left: 56 },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            grace: "15%",
            title: {
              display: true,
              text: chartData.x_axis,
              color: "#475569",
            },
            ticks: { color: "#475569" },
            grid: { color: "#e2e8f0" },
          },
          y: {
            grace: "15%",
            title: {
              display: true,
              text: chartData.y_axis,
              color: "#475569",
            },
            ticks: { color: "#475569" },
            grid: { color: "#e2e8f0" },
          },
        },
      },
    });

    points.forEach((point) => {
      if (point.logoImage) {
        point.logoImage.addEventListener("load", () => chart.draw(), { once: true });
      }
    });
  } catch (err) {
    showError(container, err.message);
  }
}

/** Load WR percentile scatter JSON and render with team logos — identical style to renderTrendChart.
/** Load WR percentile scatter JSON. Scroll to zoom, drag to pan, double-click to reset. */
async function renderWrScatter(canvasId, jsonPath) {
  const container = document.getElementById("chart-container");
  try {
    const chartData = await fetchJSON(jsonPath);
    document.getElementById("chart-title").textContent = chartData.title;

    const points = buildScatterDataset(chartData).filter((p) => p.top24);
    if (!points.length) {
      throw new Error("No chart points were returned.");
    }

    const xVals = points.map((p) => p.x);
    const yVals = points.map((p) => p.y);
    const xMin = Math.floor(Math.min(...xVals) - 1);
    const xMax = Math.ceil(Math.max(...xVals)  + 1);
    const yMin = Math.floor(Math.min(...yVals) - 1);
    const yMax = Math.ceil(Math.max(...yVals)  + 1);

    const wrLabelPlugin = {
      id: "wrLabelPlugin",
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const area            = chart.chartArea;
        const logoSize        = 26;
        const labelGap        = 4;
        const labelFontSize   = 12;
        const labelLineHeight = 13;

        ctx.save();
        ctx.beginPath();
        ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top + 86);
        ctx.clip();

        points.forEach((point) => {
          const x = chart.scales.x.getPixelForValue(point.x);
          const y = chart.scales.y.getPixelForValue(point.y);

          if (point.logoImage?.complete && point.logoImage.naturalWidth > 0) {
            ctx.drawImage(point.logoImage, x - logoSize / 2, y - logoSize / 2, logoSize, logoSize);
          } else {
            ctx.fillStyle    = point.team_color || "#2563eb";
            ctx.font         = "700 10px system-ui, sans-serif";
            ctx.textAlign    = "center";
            ctx.textBaseline = "top";
            ctx.fillText(point.team, x, y - logoSize / 2 + 8);
          }

          const labelLines = wrapName(point.player);
          const labelY     = y + logoSize / 2 + labelGap;
          ctx.fillStyle    = "#0f172a";
          ctx.textAlign    = "center";
          ctx.textBaseline = "top";
          ctx.font = `700 ${labelFontSize}px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
          labelLines.forEach((line, li) => {
            ctx.fillText(line, x, labelY + li * labelLineHeight);
          });
        });

        ctx.restore();
      },
    };

    const ctx = document.getElementById(canvasId).getContext("2d");
    const chart = new Chart(ctx, {
      type: "scatter",
      data: {
        datasets: [{
          data: points,
          parsing: false,
          pointRadius: 0,
          pointHoverRadius: 0,
        }],
      },
      plugins: [wrLabelPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: { top: 18, right: 56, bottom: 86, left: 56 },
        },
        plugins: {
          legend:  { display: false },
          tooltip: { enabled: false },
          zoom: {
            pan:  { enabled: true, mode: "xy" },
            zoom: {
              wheel:  { enabled: true },
              pinch:  { enabled: true },
              mode:   "xy",
              onZoomComplete({ chart }) { chart.draw(); },
            },
            limits: {
              x: { min: xMin - 5, max: xMax + 5 },
              y: { min: yMin - 5, max: yMax + 5 },
            },
          },
        },
        scales: {
          x: {
            min: xMin, max: xMax,
            title: { display: true, text: chartData.x_axis, color: "#475569" },
            ticks: { color: "#475569" },
            grid:  { color: "#e2e8f0" },
          },
          y: {
            min: yMin, max: yMax,
            title: { display: true, text: chartData.y_axis, color: "#475569" },
            ticks: { color: "#475569" },
            grid:  { color: "#e2e8f0" },
          },
        },
      },
    });

    // Double-click resets zoom/pan to original view
    document.getElementById(canvasId).addEventListener("dblclick", () => chart.resetZoom());

    points.forEach((point) => {
      if (point.logoImage) {
        point.logoImage.addEventListener("load", () => chart.draw(), { once: true });
      }
    });

  } catch (err) {
    showError(container, err.message);
  }
}

export { renderTrendChart, renderWrScatter };

