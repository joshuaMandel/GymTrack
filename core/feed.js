// Activity feed line builder — ported from app.js:2819, but pure: returns plain
// strings + structured fields (no HTML), so the client styles the match delta and
// the "new PR!" flag itself. Encodes the whole activity kind→text mapping and the
// exact payload field names.
//   ico ∈ 'bolt' | 'barbell' | 'mountain'  (client maps to its icon set)
//   delta: signed match rating change (match_result only)
//   pr: true when this climb set a new hardest send

export function feedLine(it) {
  const p = it.payload || {};
  const who = it.display_name || 'Climber';

  if (it.kind === 'match_result') {
    const opp = p.opponent || 'a friend';
    const verb = p.result === 'won' ? `beat ${opp}` : p.result === 'lost' ? `lost to ${opp}` : `drew with ${opp}`;
    return { ico: 'bolt', cls: '', main: `${who} ${verb}`, sub: 'Head-to-head match', delta: p.delta || 0 };
  }

  if (it.kind === 'lift_session') {
    const parts = [`${p.exercises || 0} exercise${p.exercises === 1 ? '' : 's'}`];
    if (p.volume) parts.push(`${Math.round(p.volume).toLocaleString()} ${p.unit || 'lbs'}`);
    if (p.top_exercise) parts.push(p.top_exercise);
    return { ico: 'barbell', cls: '', main: `${who} lifted`, sub: parts.join(' · ') };
  }

  // default: climb_session
  const bits = [`${p.sends || 0} send${p.sends === 1 ? '' : 's'}`];
  if (p.hardest) bits.push(`hardest ${p.hardest}`);
  return { ico: 'mountain', cls: 'climb', main: `${who} climbed`, sub: bits.join(' · '), pr: !!p.new_hardest };
}
