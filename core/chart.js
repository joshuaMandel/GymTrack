// Chart geometry — the pure math behind the web app's hand-drawn SVG line chart
// (app.js:4399 niceTicks, 4410 drawChart). The RN <LineChart> feeds `lineScale`
// a measured width and renders the returned coordinates declaratively.

// "Nice" rounded gridline values over [lo, hi]. Ported verbatim (app.js:4399).
export function niceTicks(lo, hi, count) {
  if (lo === hi) return [lo];
  const rawStep = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

export const CHART_COLORS = ['#16181d', '#f59e2c', '#1f3a5f', '#3a7d44', '#b9741f', '#85806f'];

// Compute the scale + coordinates for a multi-series line chart at pixel width W.
// Mirrors drawChart's domain/padding/tick math (app.js:4417-4452). Returns null
// when there's no data. layout matches the web (H=200, padL=46, …).
export function lineScale(series, W, H = 200) {
  const withPts = series.filter((s) => s.points && s.points.length);
  if (!withPts.length) return null;

  const dates = [...new Set(withPts.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const xi = new Map(dates.map((d, i) => [d, i]));
  const values = withPts.flatMap((s) => s.points.map((p) => p.value));
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  let min = dataMin, max = dataMax;
  if (min === max) { min -= 1; max += 1; }
  const vpad = (max - min) * 0.1;
  min -= vpad; max += vpad;

  const padL = 46, padR = 14, padT = 14, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = dates.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - min) / (max - min)) * innerH;

  const ticks = niceTicks(dataMin, dataMax, 3).filter((t) => t >= min && t <= max);
  const idxs = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const labelIdxs = [...new Set(idxs)];

  // Per-series pixel points (date-sorted), keeping color + label.
  const lines = withPts.map((s) => ({
    label: s.label,
    color: s.color || null,
    pts: s.points
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((p) => ({ date: p.date, value: p.value, cx: x(xi.get(p.date)), cy: y(p.value) })),
  }));

  return {
    W, H, padL, padR, padT, padB, innerW, innerH, n, min, max, dataMin, dataMax,
    dates, ticks, labelIdxs, baselineY: padT + innerH,
    x, y, lines,
  };
}
