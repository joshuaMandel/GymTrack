// Offline write queue — the pure, DOM/IO-free core of the native app's optimistic
// climb sync. Ported in spirit from the web app's queue (app.js:177-347, 412-608),
// restructured as a reducer so the native IO shell (native/lib/climbs.ts) stays a
// thin wrapper and the merge logic is unit-testable in Node.
//
// An op is { kind: 'add'|'upd'|'del', id, entry?, tries? }. `id` is the
// client-generated UUID sent with the INSERT, which makes replay idempotent
// (a lost-response insert re-hits the same primary key). `add` ops represent
// climbs that haven't reached the server yet ("pending"); `upd`/`del` ops target
// already-synced server rows (edits/deletes of a still-pending add are folded
// into the add op by enqueueUpd/enqueueDel, so they never hit the network).
import { climbRow } from './climbs.js';

// Build the optimistic climb object for a queued add (shape matches fromClimb,
// minus the DB-assigned created_at, plus a `pending` flag for the UI).
function pendingClimb(id, entry) {
  return { id, ...climbRow(entry), color: entry.color || '', pending: true };
}

// Merge the server climbs with the pending queue into the list every screen
// renders. Replays ops in FIFO order onto a map keyed by id, so a flushed insert
// (same id now present from the server) never doubles the optimistic row.
export function applyQueue(serverClimbs, ops) {
  const map = new Map();
  for (const c of serverClimbs || []) map.set(c.id, { ...c });
  for (const op of ops || []) {
    if (op.kind === 'add') {
      if (map.has(op.id)) map.set(op.id, { ...map.get(op.id), ...climbRow(op.entry), color: op.entry.color || '' });
      else map.set(op.id, pendingClimb(op.id, op.entry));
    } else if (op.kind === 'upd') {
      if (map.has(op.id)) map.set(op.id, { ...map.get(op.id), ...climbRow(op.entry), color: op.entry.color || '' });
    } else if (op.kind === 'del') {
      map.delete(op.id);
    }
  }
  // Match fetchMyClimbs order: date desc, then created_at desc. Pending rows have
  // no created_at yet — treat them as newest within their date (sort to top).
  return [...map.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const ac = a.created_at || '￿';
    const bc = b.created_at || '￿';
    return ac < bc ? 1 : ac > bc ? -1 : 0;
  });
}

export function isPending(ops, id) {
  return (ops || []).some((o) => o.kind === 'add' && o.id === id);
}

// Number of not-yet-synced climbs (drives the Home "syncing" pill).
export function pendingCount(ops) {
  return (ops || []).filter((o) => o.kind === 'add').length;
}

export function enqueueAdd(ops, id, entry) {
  return [...(ops || []), { kind: 'add', id, entry }];
}

// Editing a still-pending add rewrites that op in place (it'll insert with the
// new fields). Otherwise it's a synced row: replace any prior upd (last write
// wins) and append.
export function enqueueUpd(ops, id, entry) {
  const list = ops || [];
  const addIdx = list.findIndex((o) => o.kind === 'add' && o.id === id);
  if (addIdx >= 0) {
    const next = list.slice();
    next[addIdx] = { ...next[addIdx], entry };
    return next;
  }
  return [...list.filter((o) => !(o.kind === 'upd' && o.id === id)), { kind: 'upd', id, entry }];
}

// Deleting a still-pending add just drops its ops (never a network delete).
// Otherwise it's a synced row: drop any queued upd for it, then append a del.
export function enqueueDel(ops, id) {
  const list = ops || [];
  if (isPending(list, id)) return list.filter((o) => o.id !== id);
  return [...list.filter((o) => !(o.kind === 'upd' && o.id === id)), { kind: 'del', id }];
}
