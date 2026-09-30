import { escapeHtml } from "./shared.js";

/** Equal padding so the plot area stays square when the SVG is square. */
const BASE_PAD = { top: 44, right: 44, bottom: 44, left: 48 };
const LOGO = 34;

/** X/Y formula lines (shown under the chart). */
export function axisFormulaHead(data) {
  const x = data.x_formula
    ? `<p class="def-formula"><span class="def-axis-key">X</span> ${escapeHtml(data.x_formula)}</p>`
    : "";
  const y = data.y_formula
    ? `<p class="def-formula"><span class="def-axis-key">Y</span> ${escapeHtml(data.y_formula)}</p>`
    : "";
  return `${x}${y}`;
}

/** Inclusion note: top of the chart by its own axes. */
export function projectionPoolHead(data) {
  const n = Number(data.proj_limit);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `<p class="def-formula">Includes top ${n} by chart score</p>`;
}

/** Title row with last-updated stamp only (keeps the chart higher in the viewport). */
export function chartTitleHead(title, data, formatUpdated) {
  const updated = formatUpdated?.(data.last_updated) || "";
  const stamp = updated
    ? `<span class="def-updated">${escapeHtml(updated)}</span>`
    : "";
  return `
    <div class="def-title-row">
      <h1 class="def-title">${escapeHtml(title)}</h1>
      ${stamp}
    </div>
  `;
}

/** Projection + axis notes rendered under the chart. */
export function chartMetaFoot(data) {
  return `${projectionPoolHead(data)}${axisFormulaHead(data)}`;
}

/** QB/RB/WR/TE: usage (xFP/G) vs efficiency (FPOE/G), split at the medians. */
export function xfpVsActualOpts() {
  const points = (v) => Number(v).toFixed(1);
  const signed = (v) => {
    const n = Number(v);
    return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
  };
  return {
    xKey: "xfpts",
    yKey: "fpoe",
    labelKey: "last_name",
    guideXKey: "xfpts",
    guideYKey: "fpoe",
    guideXLabel: "Median",
    guideYLabel: "Median",
    xFormat: (v) => v.toFixed(0),
    yFormat: (v) => {
      const n = Math.round(v);
      if (n === 0) return "0";
      return n > 0 ? `+${n}` : String(n);
    },
    xLabel: "xFP Per Game",
    yLabel: "FPOE Per Game",
    quadrantLabels: {
      topLeft: "Sell high",
      topRight: "Elite studs",
      bottomRight: "Buy low",
    },
    tooltip: (t) =>
      `${t.player_name} (${t.team}) ${t.matchup_label} · ${points(t.xfpts)} xFP/g · ${signed(t.fpoe)} FPOE/g · ${t.games}g`,
  };
}

/** Shared streamer page shell: title, chart + rank list, meta under chart. */
export function chartPageShell(title, data, formatUpdated, ariaLabel) {
  return `
    <div class="def-chart-head">
      ${chartTitleHead(title, data, formatUpdated)}
    </div>
    <div class="def-chart-body">
      <div class="def-chart-col">
        <div class="def-chart-wrap">
          <svg class="def-chart" role="img" aria-label="${escapeHtml(ariaLabel)}"></svg>
        </div>
        <div class="def-chart-foot">
          ${chartMetaFoot(data)}
        </div>
      </div>
      <aside class="def-rank-panel" aria-label="Chart ranking">
        <div class="def-quad-filters" hidden></div>
        <div class="def-rank-cols" aria-hidden="true">
          <span class="def-rank-col def-rank-col--num">#</span>
          <span class="def-rank-col def-rank-col--name">Player</span>
          <span class="def-rank-col def-rank-col--x">X</span>
          <span class="def-rank-col def-rank-col--y">Y</span>
        </div>
        <div class="def-rank-list" role="listbox" aria-label="Ranked players"></div>
      </aside>
    </div>
  `;
}

function playerId(t) {
  return String(t.player_id || t.team || "");
}

function playerListName(t) {
  return t.player_name || t.last_name || t.team || "Unknown";
}

function chartGuides(data, teams, opts) {
  const xVals = teams.map((t) => Number(t[opts.xKey]));
  const yVals = teams.map((t) => Number(t[opts.yKey]));
  const medXKey = opts.medianXKey || opts.xKey;
  const medYKey = opts.medianYKey || opts.yKey;
  const guideXKey = opts.guideXKey || medXKey;
  const guideYKey = opts.guideYKey || medYKey;
  return {
    medX:
      data.guides?.[guideXKey] ??
      data.medians?.[medXKey] ??
      median(xVals),
    medY:
      data.guides?.[guideYKey] ??
      data.medians?.[medYKey] ??
      median(yVals),
  };
}

/** Which median box a point sits in. Ties on a line count as the high side. */
function quadrantKey(x, y, medX, medY) {
  const highX = x >= medX;
  const highY = y >= medY;
  if (highY && highX) return "topRight";
  if (highY) return "topLeft";
  if (highX) return "bottomRight";
  return "bottomLeft";
}

function labeledQuadrants(opts) {
  const labels = opts.quadrantLabels || {};
  return ["topLeft", "topRight", "bottomLeft", "bottomRight"]
    .filter((key) => labels[key])
    .map((key) => ({ key, label: labels[key] }));
}

/** Min–max normalize axes, score toward the good corner, sort best → worst. */
export function rankChartPlayers(teams, opts) {
  const xKey = opts.xKey;
  const yKey = opts.yKey;
  const xSign = opts.xSign ?? 1;
  const ySign = opts.ySign ?? 1;
  const xs = teams.map((t) => Number(t[xKey]));
  const ys = teams.map((t) => Number(t[yKey]));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  return teams
    .map((t, i) => {
      const xv = Number(t[xKey]);
      const yv = Number(t[yKey]);
      const normX = (xv - xMin) / xSpan;
      const normY = (yv - yMin) / ySpan;
      return {
        item: t,
        id: playerId(t) || `row-${i}`,
        score: xSign * normX + ySign * normY,
        x: xv,
        y: yv,
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function renderRankList(listEl, ranked, opts, selectedId) {
  if (!listEl) return;
  const xFormat = opts.xFormat || String;
  const yFormat = opts.yFormat || String;
  const xLabel = opts.xLabel || "X";
  const yLabel = opts.yLabel || "Y";

  const cols = listEl.previousElementSibling;
  if (cols?.classList.contains("def-rank-cols")) {
    const xCol = cols.querySelector(".def-rank-col--x");
    const yCol = cols.querySelector(".def-rank-col--y");
    if (xCol) {
      xCol.textContent = "X";
      xCol.title = xLabel;
    }
    if (yCol) {
      yCol.textContent = "Y";
      yCol.title = yLabel;
    }
  }

  listEl.innerHTML = ranked
    .map((row, i) => {
      const t = row.item;
      const name = playerListName(t);
      const team = t.team && t.player_name ? t.team : "";
      const teamHtml = team
        ? ` <span class="def-rank-team">${escapeHtml(team)}</span>`
        : "";
      const selected = selectedId && row.id === selectedId;
      return `
        <button
          type="button"
          role="option"
          class="def-rank-row${selected ? " is-selected" : ""}"
          data-player-id="${escapeHtml(row.id)}"
          aria-selected="${selected ? "true" : "false"}"
        >
          <span class="def-rank-num">${i + 1}</span>
          <span class="def-rank-name">${escapeHtml(name)}${teamHtml}</span>
          <span class="def-rank-x" title="${escapeHtml(xLabel)}">${escapeHtml(xFormat(row.x))}</span>
          <span class="def-rank-y" title="${escapeHtml(yLabel)}">${escapeHtml(yFormat(row.y))}</span>
        </button>
      `;
    })
    .join("");
}

function syncRankSelection(listEl, selectedId) {
  if (!listEl) return;
  for (const row of listEl.querySelectorAll(".def-rank-row")) {
    const on = selectedId != null && row.dataset.playerId === selectedId;
    row.classList.toggle("is-selected", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
  }
}

/**
 * Mount a streamer board: shell, ranked side list, chart draw + selection.
 * Returns false when the board is empty (caller should revealPage).
 */
export function mountStreamerBoard(root, {
  title,
  data,
  formatUpdated,
  ariaLabel,
  emptyMessage,
  chartOpts,
}) {
  const teams = data.players || data.teams || [];
  if (!teams.length) {
    root.innerHTML = `<div class="error">${escapeHtml(emptyMessage || "No matchups in board.")}</div>`;
    return false;
  }

  root.innerHTML = chartPageShell(title, data, formatUpdated, ariaLabel);

  let selectedId = null;
  let activeQuad = "";
  const svg = root.querySelector(".def-chart");
  const listEl = root.querySelector(".def-rank-list");
  const filterEl = root.querySelector(".def-quad-filters");
  const ranked = rankChartPlayers(teams, chartOpts);
  const guides = chartGuides(data, teams, chartOpts);
  const quads = labeledQuadrants(chartOpts);

  const quadOf = (row) => quadrantKey(row.x, row.y, guides.medX, guides.medY);
  const visibleRanked = () =>
    activeQuad ? ranked.filter((row) => quadOf(row) === activeQuad) : ranked;

  const draw = () =>
    drawStreamerChart(svg, data, {
      ...chartOpts,
      selectedId,
      activeQuad,
      guideMedX: guides.medX,
      guideMedY: guides.medY,
    });

  const render = () => {
    const shown = visibleRanked();
    if (selectedId && !shown.some((row) => row.id === selectedId)) {
      selectedId = null;
    }
    renderRankList(listEl, shown, chartOpts, selectedId);
  };

  if (filterEl && quads.length) {
    filterEl.hidden = false;
    filterEl.innerHTML = [
      `<button type="button" class="def-quad-filter is-active" data-quad="">All</button>`,
      ...quads.map(
        (q) =>
          `<button type="button" class="def-quad-filter" data-quad="${escapeHtml(q.key)}">${escapeHtml(q.label)}</button>`
      ),
    ].join("");
    const syncFilters = () => {
      for (const btn of filterEl.querySelectorAll(".def-quad-filter")) {
        const on = (btn.dataset.quad || "") === activeQuad;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    };
    const setQuad = (key) => {
      activeQuad = activeQuad === key ? "" : key;
      syncFilters();
      render();
      draw();
    };
    filterEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".def-quad-filter");
      if (!btn) return;
      setQuad(btn.dataset.quad || "");
    });
    svg?.addEventListener("click", (e) => {
      const label = e.target.closest?.(".def-quad-label");
      if (!label?.dataset.quad) return;
      setQuad(label.dataset.quad);
    });
  }

  render();
  listEl?.addEventListener("click", (e) => {
    const row = e.target.closest(".def-rank-row");
    if (!row) return;
    const id = row.dataset.playerId;
    selectedId = selectedId === id ? null : id;
    syncRankSelection(listEl, selectedId);
    draw();
  });

  draw();
  const wrap = root.querySelector(".def-chart-wrap");
  if (wrap) new ResizeObserver(draw).observe(wrap);
  return true;
}


function ticksByStep(domain, step) {
  const [a, b] = domain;
  const out = [];
  const start = Math.ceil(a / step - 1e-9) * step;
  for (let v = start; v <= b + 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/** Domain from player min/max, with just enough margin for logos/names. */
function dataDomain(values, plotPx, padPx) {
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const span = Math.max(dataMax - dataMin, 1e-6);
  const pad = (padPx / Math.max(plotPx, 1)) * span;
  return [dataMin - pad, dataMax + pad];
}

/**
 * Scale hugs the players on the chart. Tick labels keep their interval but are
 * only drawn where they fall inside that player-based domain (no empty margin
 * forced by outer tick marks).
 */
function resolveAxis(
  values,
  { ticks: fixedTicks, tickStep, domain: fixedDomain, includeZero },
  plotPx,
  padPx
) {
  let [lo, hi] = fixedDomain
    ? dataDomain(
        [
          Math.min(...values, fixedDomain[0]),
          Math.max(...values, fixedDomain[1]),
        ],
        plotPx,
        padPx
      )
    : dataDomain(values, plotPx, padPx);

  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }

  let labelTicks;
  if (fixedTicks?.length) {
    const span = hi - lo;
    labelTicks = [];
    for (const t of fixedTicks) {
      // Include a fixed tick if it lands in the domain, or sits just outside
      // so edge labels like -2 / +2 still appear when players nearly reach them.
      if (t >= lo && t <= hi) {
        labelTicks.push(t);
      } else if (t < lo && t >= Math.min(...values) - span * 0.2) {
        lo = t;
        labelTicks.push(t);
      } else if (t > hi && t <= Math.max(...values) + span * 0.2) {
        hi = t;
        labelTicks.push(t);
      }
    }
  } else if (tickStep) {
    labelTicks = ticksByStep([lo, hi], tickStep);
  } else {
    labelTicks = ticks([lo, hi], 5);
  }

  return { domain: [lo, hi], ticks: labelTicks };
}

function scaleLinear(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const m = (r1 - r0) / (d1 - d0 || 1);
  return (v) => r0 + (v - d0) * m;
}

function ticks(domain, count = 5) {
  const [a, b] = domain;
  const step = (b - a) / (count - 1);
  return Array.from({ length: count }, (_, i) => a + step * i);
}

function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Margin (px) so logos/names clear the edge without emptying the plot. */
const MARKER_PAD_X = 36;
const MARKER_PAD_Y = 36;

/**
 * Draw a logo scatter chart with a square plot area.
 *
 * @param {SVGElement} svg
 * @param {object} data board JSON with teams[]/players[] + medians/guides
 * @param {object} opts
 * @param {string} opts.xKey
 * @param {string} opts.yKey
 * @param {(v:number)=>string} opts.xFormat
 * @param {(v:number)=>string} opts.yFormat
 * @param {string} opts.xLabel
 * @param {string} opts.yLabel
 * @param {(t:object)=>string} opts.tooltip
 * @param {string} [opts.medianXKey]
 * @param {string} [opts.medianYKey]
 * @param {string} [opts.labelKey]
 * @param {string} [opts.guideXKey]
 * @param {string} [opts.guideYKey]
 * @param {[number, number]} [opts.xDomain]
 * @param {[number, number]} [opts.yDomain]
 * @param {number[]} [opts.xTicks]
 * @param {number[]} [opts.yTicks]
 * @param {number} [opts.xTickStep]
 * @param {number} [opts.yTickStep]
 * @param {string} [opts.guideXLabel]
 * @param {string} [opts.guideYLabel]
 * @param {{topLeft?:string,topRight?:string,bottomLeft?:string,bottomRight?:string}} [opts.quadrantLabels]
 * @param {number} [opts.xSign] +1 / -1 for ranking toward the good corner
 * @param {number} [opts.ySign] +1 / -1 for ranking toward the good corner
 * @param {string|null} [opts.selectedId] player_id or team to highlight
 */
export function drawStreamerChart(svg, data, opts) {
  if (!svg) return;
  const wrap = svg.parentElement;
  const cssW = wrap?.clientWidth || 0;
  const cssH = wrap?.clientHeight || 0;
  const size = Math.max(280, Math.min(cssW || 560, cssH || cssW || 560, 560));
  const width = size;
  const height = size;
  const quads = opts.quadrantLabels || null;
  const PAD = quads
    ? { top: 56, right: BASE_PAD.right, bottom: 62, left: BASE_PAD.left }
    : { ...BASE_PAD };
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const teams = data.players || data.teams;
  const labelKey = opts.labelKey || "matchup_label";
  const xVals = teams.map((t) => t[opts.xKey]);
  const yVals = teams.map((t) => t[opts.yKey]);
  // Shared scale so the even line is y = x on a square plot.
  const axisVals = opts.equalLine ? [...xVals, ...yVals] : null;

  const xAxis = resolveAxis(
    axisVals || xVals,
    {
      ticks: opts.xTicks,
      tickStep: opts.xTickStep,
      domain: opts.xDomain,
      includeZero: opts.xIncludeZero,
    },
    innerW,
    MARKER_PAD_X
  );
  const yAxis = resolveAxis(
    axisVals || yVals,
    {
      ticks: opts.yTicks,
      tickStep: opts.yTickStep,
      domain: opts.yDomain,
      includeZero: opts.yIncludeZero,
    },
    innerH,
    MARKER_PAD_Y
  );
  const xDom = xAxis.domain;
  const yDom = yAxis.domain;
  const xTicks = xAxis.ticks;
  const yTicks = yAxis.ticks;

  const x = scaleLinear(xDom, [PAD.left, PAD.left + innerW]);
  const y = scaleLinear(yDom, [PAD.top + innerH, PAD.top]);

  const medXKey = opts.medianXKey || opts.xKey;
  const medYKey = opts.medianYKey || opts.yKey;
  const guideXKey = opts.guideXKey || medXKey;
  const guideYKey = opts.guideYKey || medYKey;
  const medX = opts.guideMedX ?? (
    data.guides?.[guideXKey] ??
    data.medians?.[medXKey] ??
    median(xVals)
  );
  const medY = opts.guideMedY ?? (
    data.guides?.[guideYKey] ??
    data.medians?.[medYKey] ??
    median(yVals)
  );

  const grid = [
    ...xTicks.map(
      (v) =>
        `<line class="def-grid" x1="${x(v)}" y1="${PAD.top}" x2="${x(v)}" y2="${PAD.top + innerH}" />`
    ),
    ...yTicks.map(
      (v) =>
        `<line class="def-grid" x1="${PAD.left}" y1="${y(v)}" x2="${PAD.left + innerW}" y2="${y(v)}" />`
    ),
  ].join("");

  const equalLo = Math.max(xDom[0], yDom[0]);
  const equalHi = Math.min(xDom[1], yDom[1]);
  const equalLine =
    opts.equalLine && equalHi > equalLo
      ? `<line class="def-median" x1="${x(equalLo)}" y1="${y(equalLo)}" x2="${x(equalHi)}" y2="${y(equalHi)}" />`
      : "";
  const crossGuides = opts.equalLine
    ? ""
    : `<line class="def-median" x1="${x(medX)}" y1="${PAD.top}" x2="${x(medX)}" y2="${PAD.top + innerH}" />
    <line class="def-median" x1="${PAD.left}" y1="${y(medY)}" x2="${PAD.left + innerW}" y2="${y(medY)}" />`;
  const axes = `
    <line class="def-axis" x1="${PAD.left}" y1="${PAD.top + innerH}" x2="${PAD.left + innerW}" y2="${PAD.top + innerH}" />
    <line class="def-axis" x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + innerH}" />
    ${crossGuides}
    ${equalLine}
  `;

  const guideXLabel = opts.equalLine
    ? ""
    : opts.guideXLabel
    ? `<text class="def-guide-label" x="${x(medX) + 5}" y="${PAD.top + 11}">${escapeHtml(opts.guideXLabel)}</text>`
    : "";
  const guideYLabel = opts.equalLine
    ? ""
    : opts.guideYLabel
    ? `<text class="def-guide-label" x="${PAD.left + innerW - 4}" y="${y(medY) - 5}" text-anchor="end">${escapeHtml(opts.guideYLabel)}</text>`
    : "";

  // Outside the plot vertically; horizontally centered between each guide
  // divider and the left/right plot edge.
  let quadrantMarkup = "";
  if (quads) {
    const midX = x(medX);
    const leftCx = (PAD.left + midX) / 2;
    const rightCx = (midX + PAD.left + innerW) / 2;
    const topY = PAD.top - 14;
    const bottomY = PAD.top + innerH + 34;
    const mk = (label, key, cx, cy) =>
      label
        ? `<text class="def-quad-label${opts.activeQuad === key ? " is-active" : ""}" data-quad="${escapeHtml(key)}" x="${cx}" y="${cy}" text-anchor="middle">${escapeHtml(label)}</text>`
        : "";
    quadrantMarkup = [
      mk(quads.topLeft, "topLeft", leftCx, topY),
      mk(quads.topRight, "topRight", rightCx, topY),
      mk(quads.bottomLeft, "bottomLeft", leftCx, bottomY),
      mk(quads.bottomRight, "bottomRight", rightCx, bottomY),
    ].join("");
  }

  const xLabels = xTicks
    .map(
      (v) =>
        `<text class="def-tick" x="${x(v)}" y="${PAD.top + innerH + 18}" text-anchor="middle">${opts.xFormat(v)}</text>`
    )
    .join("");
  const yLabels = yTicks
    .map(
      (v) =>
        `<text class="def-tick" x="${PAD.left - 10}" y="${y(v) + 4}" text-anchor="end">${opts.yFormat(v)}</text>`
    )
    .join("");

  const axisTitles = `
    <text class="def-axis-title" x="${PAD.left + innerW / 2}" y="${height - 14}" text-anchor="middle">${escapeHtml(opts.xLabel)}</text>
    <text class="def-axis-title" x="16" y="${PAD.top + innerH / 2}" text-anchor="middle" transform="rotate(-90 16 ${PAD.top + innerH / 2})">${escapeHtml(opts.yLabel)}</text>
  `;

  const selectedId = opts.selectedId != null ? String(opts.selectedId) : null;
  const activeQuad = opts.activeQuad || "";
  const pointNodes = teams.map((t, i) => {
    const cx = x(t[opts.xKey]);
    const cy = y(t[opts.yKey]);
    const label = t[labelKey] || "";
    const id = playerId(t) || `row-${i}`;
    const inQuad =
      !activeQuad ||
      quadrantKey(Number(t[opts.xKey]), Number(t[opts.yKey]), medX, medY) ===
        activeQuad;
    const isFocus = selectedId != null && id === selectedId;
    const isDim = !inQuad || (selectedId != null && !isFocus);
    const cls = ["def-point", isFocus ? "is-focus" : "", isDim ? "is-dim" : ""]
      .filter(Boolean)
      .join(" ");
    return {
      id,
      isFocus,
      html: `
        <g class="${cls}" data-player-id="${escapeHtml(id)}" transform="translate(${cx}, ${cy})">
          <title>${escapeHtml(opts.tooltip(t))}</title>
          <image
            href="${escapeHtml(t.logo_url)}"
            x="${-LOGO / 2}"
            y="${-LOGO / 2}"
            width="${LOGO}"
            height="${LOGO}"
          />
          <text class="def-matchup" x="0" y="${LOGO / 2 + 4}" text-anchor="middle" dominant-baseline="hanging">${escapeHtml(label)}</text>
        </g>
      `,
    };
  });
  // Selected marker last so it paints on top of overlaps.
  pointNodes.sort((a, b) => Number(a.isFocus) - Number(b.isFocus));
  const points = pointNodes.map((p) => p.html).join("");

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // Draw quadrant labels under points so logos/names stay on top when they overlap.
  svg.innerHTML = `${grid}${axes}${guideXLabel}${guideYLabel}${quadrantMarkup}${xLabels}${yLabels}${axisTitles}${points}`;
}
