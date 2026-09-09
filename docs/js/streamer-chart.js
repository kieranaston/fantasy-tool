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

/** Inclusion note when the board is capped by Sleeper projected points. */
export function projectionPoolHead(data) {
  const n = Number(data.proj_limit);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `<p class="def-formula">Includes top ${n} by Sleeper half-PPR projected points</p>`;
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

/** Shared streamer page shell: title, chart, then meta underneath. */
export function chartPageShell(title, data, formatUpdated, ariaLabel) {
  return `
    <div class="def-chart-head">
      ${chartTitleHead(title, data, formatUpdated)}
    </div>
    <div class="def-chart-wrap">
      <svg class="def-chart" role="img" aria-label="${escapeHtml(ariaLabel)}"></svg>
    </div>
    <div class="def-chart-foot">
      ${chartMetaFoot(data)}
    </div>
  `;
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

  const xAxis = resolveAxis(
    xVals,
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
    yVals,
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
  const medX =
    data.guides?.[guideXKey] ??
    data.medians?.[medXKey] ??
    median(xVals);
  const medY =
    data.guides?.[guideYKey] ??
    data.medians?.[medYKey] ??
    median(yVals);

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

  const axes = `
    <line class="def-axis" x1="${PAD.left}" y1="${PAD.top + innerH}" x2="${PAD.left + innerW}" y2="${PAD.top + innerH}" />
    <line class="def-axis" x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + innerH}" />
    <line class="def-median" x1="${x(medX)}" y1="${PAD.top}" x2="${x(medX)}" y2="${PAD.top + innerH}" />
    <line class="def-median" x1="${PAD.left}" y1="${y(medY)}" x2="${PAD.left + innerW}" y2="${y(medY)}" />
  `;

  const guideXLabel = opts.guideXLabel
    ? `<text class="def-guide-label" x="${x(medX) + 5}" y="${PAD.top + 11}">${escapeHtml(opts.guideXLabel)}</text>`
    : "";
  const guideYLabel = opts.guideYLabel
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
    const mk = (label, cx, cy) =>
      label
        ? `<text class="def-quad-label" x="${cx}" y="${cy}" text-anchor="middle">${escapeHtml(label)}</text>`
        : "";
    quadrantMarkup = [
      mk(quads.topLeft, leftCx, topY),
      mk(quads.topRight, rightCx, topY),
      mk(quads.bottomLeft, leftCx, bottomY),
      mk(quads.bottomRight, rightCx, bottomY),
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

  const points = teams
    .map((t) => {
      const cx = x(t[opts.xKey]);
      const cy = y(t[opts.yKey]);
      const label = t[labelKey] || "";
      return `
        <g class="def-point" transform="translate(${cx}, ${cy})">
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
      `;
    })
    .join("");

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // Draw quadrant labels under points so logos/names stay on top when they overlap.
  svg.innerHTML = `${grid}${axes}${guideXLabel}${guideYLabel}${quadrantMarkup}${xLabels}${yLabels}${axisTitles}${points}`;
}
