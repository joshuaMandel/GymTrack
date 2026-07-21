// Send Score rating engine — ported verbatim from the web app
// (app.js:1244-1373). Pure ELO-style replay over a climb list; no DOM, no
// globals. `scoreBreakdown` is the primitive; `climberRatingFromClimbs` is the
// headline helper (matchAdj is the additive head-to-head layer, {} until M4).

import { V_GRADES, YDS_GRADES, gradeD, gradeRank } from './grades.js';

export const SS_BASE = 1000, SS_STEP = 100, SS_SPREAD = 200; // rating = 1000 + 100·D
export const SS_K_PROV = 40, SS_K_EST = 16, SS_PROV_SESSIONS = 5; // fast then stable
export const SS_FLASH_BONUS = 1; // a flash = a send + exactly 1 point
export const SS_ROPE_OFFSET = 300; // roped ratings sit a constant offset higher

export const ratingGroup = (discipline) => (discipline === 'Bouldering' ? 'boulder' : 'rope');
export const isSend = (r) => r !== 'Project';

export const ALL_DISCIPLINES = ['Bouldering', 'Sport', 'Top Rope', 'Trad'];
export const ROPE_DISCIPLINES = ['Sport', 'Top Rope', 'Trad'];

// Hardest grade sent per session for one discipline (values are grade ranks).
// Ported verbatim (app.js:1195).
export function hardestSeries(discipline, sends) {
  const byDate = {};
  sends
    .filter((c) => c.discipline === discipline)
    .forEach((c) => {
      const r = gradeRank(discipline, c.grade);
      if (byDate[c.date] === undefined || r > byDate[c.date]) byDate[c.date] = r;
    });
  return {
    label: discipline,
    points: Object.keys(byDate).sort().map((d) => ({ date: d, value: byDate[d] }))
  };
}

// Sends per session for one discipline. Ported verbatim (app.js:1210).
export function sendsSeries(discipline, sends) {
  const byDate = {};
  sends
    .filter((c) => c.discipline === discipline)
    .forEach((c) => { byDate[c.date] = (byDate[c.date] || 0) + 1; });
  return {
    label: discipline,
    points: Object.keys(byDate).sort().map((d) => ({ date: d, value: byDate[d] }))
  };
}

export const routeRating = (discipline, grade) => SS_BASE + (discipline === 'Bouldering' ? 0 : SS_ROPE_OFFSET) + SS_STEP * gradeD(discipline, grade);
export const sendExpected = (R, routeR) => 1 / (1 + Math.pow(10, (routeR - R) / SS_SPREAD));

// How hard a send is relative to YOUR level → celebration intensity 1..3
// (app.js:2175 maMagnitude). Pass your Send Score for the discipline's group.
export function sendMagnitude(discipline, grade, myRating) {
  const base = SS_BASE + (discipline === 'Bouldering' ? 0 : SS_ROPE_OFFSET);
  const R = myRating || base;
  const delta = routeRating(discipline, grade) - R;
  return delta >= 60 ? 3 : delta >= -40 ? 2 : 1;
}

export const RATING_GROUPS = [
  { key: 'boulder', label: 'Bouldering', scale: 'V-scale', color: '#1f3a5f' },
  { key: 'rope', label: 'Roped', scale: 'YDS', color: '#f59e2c' }
];

// THE scoring replay over an explicit climb list, grouped into sessions (dates).
// Returns the converged rating plus per-session detail with each climb's exact
// ± rating move.
export function scoreBreakdown(allClimbs, group) {
  const climbs = allClimbs
    .filter((c) => ratingGroup(c.discipline) === group && gradeD(c.discipline, c.grade) !== undefined)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
      : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

  if (!climbs.length) return { group, sessions: [], rating: null, provisional: true, hasData: false };

  // Seed at the first SEND's grade (else the first climb's).
  const firstSend = climbs.find((c) => isSend(c.result)) || climbs[0];
  let R = routeRating(firstSend.discipline, firstSend.grade);

  const sessions = [];
  let sIdx = 0, i = 0, hardestRank = -1, hardestDisc = null;
  while (i < climbs.length) {
    const date = climbs[i].date;
    const sesh = [];
    while (i < climbs.length && climbs[i].date === date) { sesh.push(climbs[i]); i++; }
    const K = sIdx < SS_PROV_SESSIONS ? SS_K_PROV : SS_K_EST;
    const startRounded = Math.round(R);
    const detail = [];
    let sends = 0;
    for (const c of sesh) {
      const sent = isSend(c.result);
      const routeR = routeRating(c.discipline, c.grade);
      const prevRounded = Math.round(R);
      R += K * ((sent ? 1 : 0) - sendExpected(R, routeR));
      if (c.result === 'Flash') R += SS_FLASH_BONUS;
      if (sent) {
        sends++;
        const rk = gradeRank(c.discipline, c.grade);
        if (rk > hardestRank) { hardestRank = rk; hardestDisc = c.discipline; }
      }
      detail.push({ id: c.id, group, delta: Math.round(R) - prevRounded, climb: c });
    }
    sIdx++;
    sessions.push({
      date, delta: Math.round(R) - startRounded, end: Math.round(R),
      count: detail.length, sends, climbs: detail,
      hardest: hardestRank >= 0 ? (hardestDisc === 'Bouldering' ? V_GRADES[hardestRank] : YDS_GRADES[hardestRank]) : null
    });
  }
  return { group, sessions, rating: Math.round(R), provisional: sIdx < SS_PROV_SESSIONS, hasData: true };
}

// The headline view of the replay. Pass the user's climbs (from Supabase) and an
// optional head-to-head adjustment map ({} for M1). Mirrors app.js climberRating.
export function climberRatingFromClimbs(climbs, group, matchAdj = {}) {
  const b = scoreBreakdown(climbs, group);
  const last = b.sessions.length ? b.sessions[b.sessions.length - 1] : null;
  return {
    group,
    rating: b.rating == null ? null : b.rating + (matchAdj[group] || 0),
    provisional: b.provisional,
    sessions: b.sessions.length,
    hasData: b.hasData,
    history: b.sessions.map((x) => ({ date: x.date, value: x.end })),
    lastSession: last,
    lastSessionDelta: last ? last.delta : 0
  };
}
