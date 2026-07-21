// Head-to-head match helpers — ported from app.js:1269-1298. All pure. Scoring
// is server-authoritative (match_play); these only read the live match_state and
// preview a send's value. `matchLive()` (which read globals) stays in the client.
import { gradeD } from './grades.js';

// backend discipline → the climbs.discipline values that count in the match.
export const MATCH_DISCS = {
  boulder: ['Bouldering'],
  lead: ['Sport'],
  toprope: ['Top Rope'],
  agnostic: ['Sport', 'Top Rope'],
};

export const matchMySide = (s) => (s.i_am === 'challenger' ? s.challenger : s.opponent);
export const matchTheirSide = (s) => (s.i_am === 'challenger' ? s.opponent : s.challenger);

// What a SEND of this grade is worth for me right now: max(0, atPar + round(D −
// parD)). `state` is the live match_state (or null). Null when it wouldn't count.
// Parameterized from app.js:1280 (the web read matchLive()/mdState globals).
export function matchPointsFor(state, discipline, grade) {
  const live = state && state.status === 'active' && state.rules && state.rules.discipline != null ? state : null;
  if (!live) return null;
  const discs = MATCH_DISCS[live.rules.discipline];
  if (!discs || !discs.includes(discipline)) return null;
  const d = gradeD(discipline, grade);
  if (d == null) return null;
  const me = matchMySide(live);
  // Unranked boulder: the V-number IS your score (V5 = 5), so at-par is 0.
  const atPar = (live.rules.ranked === false && live.rules.discipline === 'boulder') ? 0 : 3;
  // No par yet: the engine seeds par from your first send, so it scores at-par.
  if (me.par_d == null) return atPar;
  return Math.max(0, atPar + Math.round(d - me.par_d));
}

// A side's most recent counting climb as a phrase for the turn handoff:
// "flashed V9 (+10)" / "sent 5.11a (+3)" / "fell on V6". '' when none yet.
export function matchLastLine(p) {
  const l = p && p.last;
  if (!l || !l.grade) return '';
  const verb = l.result === 'Flash' ? 'flashed' : l.result === 'Project' ? 'fell on' : 'sent';
  return `${verb} ${l.grade}${l.points > 0 ? ` (+${l.points})` : ''}`;
}
