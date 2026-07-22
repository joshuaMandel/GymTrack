// Head-to-head match helpers — ported from app.js:1269-1298. All pure. Scoring
// is server-authoritative (match_play); these only read the live match_state and
// preview a send's value. `matchLive()` (which read globals) stays in the client.
import { ladderDamage } from './battle.js';

// backend discipline → the climbs.discipline values that count in the match.
export const MATCH_DISCS = {
  boulder: ['Bouldering'],
  lead: ['Sport'],
  toprope: ['Top Rope'],
  agnostic: ['Sport', 'Top Rope'],
};

export const matchMySide = (s) => (s.i_am === 'challenger' ? s.challenger : s.opponent);
export const matchTheirSide = (s) => (s.i_am === 'challenger' ? s.opponent : s.challenger);

// Battle mode: the damage a SEND of this grade would deal — the raw grade ladder,
// no handicap (mirrors the server). `state` is the live match_state (or null).
// Null when the climb wouldn't count (wrong discipline / no live match).
export function matchPointsFor(state, discipline, grade) {
  const live = state && state.status === 'active' && state.rules && state.rules.discipline != null ? state : null;
  if (!live) return null;
  const discs = MATCH_DISCS[live.rules.discipline];
  if (!discs || !discs.includes(discipline)) return null;
  return ladderDamage(discipline, grade);
}

// A side's most recent counting climb as a phrase for the turn handoff:
// "flashed V9 (+10)" / "sent 5.11a (+3)" / "fell on V6". '' when none yet.
export function matchLastLine(p) {
  const l = p && p.last;
  if (!l || !l.grade) return '';
  const verb = l.result === 'Flash' ? 'flashed' : l.result === 'Project' ? 'fell on' : 'sent';
  return `${verb} ${l.grade}${l.points > 0 ? ` (+${l.points})` : ''}`;
}
