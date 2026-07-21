// Date/number/relative-time formatting — ported from the web app
// (app.js:684-698, 2808-2815). Pure; no DOM. Uses the LOCAL calendar date on
// purpose (toISOString() is UTC and mis-stamps evening logs as tomorrow).

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const todayISO = () => isoOf(new Date());

// Local calendar date N days ago (app.js:4523) — used for chart range cutoffs.
export function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return isoOf(d);
}

export const fmtNum = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });

export function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtDateShort(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
