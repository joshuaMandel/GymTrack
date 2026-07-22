// Battle mode — the monster-battle scoring layer over SendOff matches.
//
// Damage is a linear grade ladder with NO handicap: a send's damage is just its
// grade's rung. V0=1 and +1 per grade (V15=16, V17=18); 5.7=1 and +1 per letter
// (5.15d=27); anything easier than the floor = 1. A project (fail) is a miss (0).
// This mirrors the server's battle_damage() used in match_play and the client's
// point-preview pills — all three must agree. HP pool = best_n × 8 per player.
import { gradeRank } from './grades.js';

export const HP_PER_SLOT = 8;

// A player's HP pool: they faint when the opponent's cumulative damage reaches it.
export const hpMax = (bestN) => Math.max(1, bestN || 0) * HP_PER_SLOT;

// Damage a SEND of this grade deals (floored at 1). Boulder uses the V ladder,
// routes the 5.x ladder; the floor rung is V0 / 5.7. Unknown grades → 1.
export function ladderDamage(discipline, grade) {
  const rank = gradeRank(discipline, grade); // index in the discipline's ladder; -1 if unknown
  if (rank < 0) return 1;
  // Boulder floor V0 sits at index 1 → 1; route floor 5.7 sits at index 2 → 1.
  const raw = discipline === 'Bouldering' ? rank : rank - 1;
  return Math.max(1, raw);
}

// A logged climb's battle damage: a send or flash deals its ladder value; a
// project (fail) is a miss. (Flash counts exactly as a send — no bonus.)
export function climbDamage(discipline, grade, result) {
  return result === 'Project' ? 0 : ladderDamage(discipline, grade);
}
