// Profile stats — the climbing-only, pure subset of app.js:5073-5105
// (profileStats/longestStreak). Lifting fields (volume/unit) are dropped since
// the native app is climbing-only.
import { isSend, ROPE_DISCIPLINES } from './rating.js';
import { gradeRank, V_GRADES, YDS_GRADES } from './grades.js';

// Longest streak of active days; one rest day (gap ≤ 2) keeps the chain alive.
export function longestStreak(climbs) {
  const dates = [...new Set((climbs || []).map((x) => x.date))].sort();
  let best = 0, cur = 0, prev = null;
  dates.forEach((d) => {
    if (prev) {
      const gap = Math.round((new Date(d + 'T00:00:00') - new Date(prev + 'T00:00:00')) / 86400000);
      cur = gap <= 2 ? cur + 1 : 1;
    } else {
      cur = 1;
    }
    prev = d;
    if (cur > best) best = cur;
  });
  return best;
}

export function climbingProfileStats(climbs) {
  const list = climbs || [];
  const sessions = new Set(list.map((x) => x.date)).size;
  const sendsArr = list.filter((c) => isSend(c.result));
  const boulderRank = Math.max(-1, ...sendsArr.filter((c) => c.discipline === 'Bouldering').map((c) => gradeRank('Bouldering', c.grade)));
  const routeRank = Math.max(-1, ...sendsArr.filter((c) => ROPE_DISCIPLINES.includes(c.discipline)).map((c) => gradeRank(c.discipline, c.grade)));
  return {
    sessions,
    sends: sendsArr.length,
    boulderRank,
    routeRank,
    hardestBoulder: boulderRank >= 0 ? V_GRADES[boulderRank] : null,
    hardestRoute: routeRank >= 0 ? YDS_GRADES[routeRank] : null,
    longest: longestStreak(list),
  };
}
