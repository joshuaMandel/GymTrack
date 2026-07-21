// Row mapping between the DB shape and the UI/entry shape — ported from the web
// app (app.js:142-153). climbRow builds the insert payload; fromClimb maps a DB
// row back to a client climb object. The same insert path the web app uses:
//   sb.from('climbs').insert({ id, ...climbRow(entry) }).select().single()

export const climbRow = (c) => {
  const row = {
    date: c.date, discipline: c.discipline, grade: c.grade,
    attempts: Number(c.attempts), result: c.result, location: c.location || '', notes: c.notes || ''
  };
  // Only send color when set, so inserts keep working on databases that haven't
  // run the color-column migration yet.
  if (c.color) row.color = c.color;
  return row;
};

export const fromClimb = (r) => ({ id: r.id, ...climbRow(r), color: r.color || '', created_at: r.created_at });

// Hold-color name → hex (app.js:1573) and per-discipline series color
// (app.js:1508). Data only; the swatch/dot is a render concern in the client.
export const CLIMB_COLORS = {
  Red: '#d64545', Orange: '#f59e2c', Yellow: '#eac54f', Green: '#3a7d44',
  Blue: '#3b82c4', Purple: '#8b5cf6', Pink: '#ec6aa0', Black: '#16181d',
  White: '#f5f2ea', Gray: '#9aa0a8', Brown: '#8a6240',
};
export const DISC_COLORS = {
  Bouldering: '#1f3a5f', Sport: '#f59e2c', 'Top Rope': '#16181d', Trad: '#3a7d44',
};
