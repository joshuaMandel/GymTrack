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
