// Session grouping between the scoring engine and the history UI — ported
// verbatim from the web app (app.js:4221-4261). Pure; depends only on
// scoreBreakdown + grade helpers. Scoring always replays the FULL history
// (allClimbs) even when the displayed list is filtered.
import { scoreBreakdown, isSend } from './rating.js';
import { V_GRADES, YDS_GRADES, gradeRank } from './grades.js';

// id -> { group, pts } — per-climb integer rating move (cumulative-rounded
// telescoping, so per-climb pts sum exactly to the session's shown change).
export function climbPoints(allClimbs) {
  const pts = {};
  ['boulder', 'rope'].forEach((g) => {
    scoreBreakdown(allClimbs, g).sessions.forEach((sess) => {
      let cum = 0, shown = 0;
      sess.climbs.forEach((d) => {
        cum += d.delta;
        const c2 = Math.round(cum);
        pts[d.id] = { group: g, pts: c2 - shown };
        shown = c2;
      });
    });
  });
  return pts;
}

// Group climbs into sessions (newest first), each with per-group point deltas
// and the hardest send per scale.
export function sessionizeClimbs(climbs, allClimbs) {
  const pts = climbPoints(allClimbs || climbs);
  const byDate = {};
  climbs.forEach((c) => { (byDate[c.date] = byDate[c.date] || []).push(c); });
  return Object.keys(byDate).sort().reverse().map((date) => {
    const list = byDate[date].slice().sort((a, b) =>
      (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const deltas = {};
    let hb = -1, hr = -1; // hardest send rank per scale
    list.forEach((c) => {
      const p = pts[c.id];
      if (p) deltas[p.group] = (deltas[p.group] || 0) + p.pts;
      if (isSend(c.result)) {
        const rk = gradeRank(c.discipline, c.grade);
        if (c.discipline === 'Bouldering') { if (rk > hb) hb = rk; }
        else if (rk > hr) hr = rk;
      }
    });
    const hardest = [hb >= 0 ? V_GRADES[hb] : null, hr >= 0 ? YDS_GRADES[hr] : null]
      .filter(Boolean).join(' · ');
    return { date, climbs: list, deltas, hardest, pts };
  });
}
