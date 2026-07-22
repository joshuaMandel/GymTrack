// Climb data access with an offline write queue. Reads are RLS-scoped to the
// signed-in user; writes try the network first and, on a network failure (or
// when NetInfo reports offline), fall back to an AsyncStorage queue that replays
// on reconnect — mirroring the web app's optimistic queue (app.js:177-347,
// 412-608). The pure merge/enqueue logic lives in @gymtrack/core (climbQueue);
// this module is the IO shell around it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { supabase } from './supabase';
import {
  climbRow,
  fromClimb,
  applyQueue,
  enqueueAdd,
  enqueueUpd,
  enqueueDel,
  isPending,
  type Climb,
  type QueueOp,
} from '@gymtrack/core';

export type NewClimb = {
  date: string;
  discipline: string;
  grade: string;
  attempts: number;
  result: string;
  location?: string;
  notes?: string;
  color?: string;
};

// ---- helpers ----
async function currentUid(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

const qKey = (uid: string) => `gymtrack.climbQueue.${uid}`;
const cKey = (uid: string) => `gymtrack.climbCache.${uid}`;

// Treat only genuine connectivity failures as "offline"; real API errors still
// surface (mirrors app.js isNetErr:189).
function isNetErr(e: any): boolean {
  const msg = (e && (e.message || String(e))) || '';
  return e instanceof TypeError || /network request failed|failed to fetch|fetch failed|networkerror|load failed|network error|timeout/i.test(msg);
}
const isDupKey = (e: any) => !!e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));

async function loadOps(uid: string): Promise<QueueOp[]> {
  try {
    const raw = await AsyncStorage.getItem(qKey(uid));
    if (!raw) return [];
    const q = JSON.parse(raw) as { userId?: string; ops?: QueueOp[] };
    return q.userId === uid ? q.ops ?? [] : []; // ignore another account's leftovers
  } catch {
    return [];
  }
}
async function saveOps(uid: string, ops: QueueOp[]): Promise<void> {
  try {
    await AsyncStorage.setItem(qKey(uid), JSON.stringify({ userId: uid, ops }));
  } catch {
    /* ignore */
  }
}
async function loadCache(uid: string): Promise<Climb[]> {
  try {
    const raw = await AsyncStorage.getItem(cKey(uid));
    return raw ? (JSON.parse(raw) as Climb[]) : [];
  } catch {
    return [];
  }
}
async function saveCache(uid: string, climbs: Climb[]): Promise<void> {
  try {
    await AsyncStorage.setItem(cKey(uid), JSON.stringify(climbs));
  } catch {
    /* ignore */
  }
}

function optimisticClimb(id: string, e: NewClimb, pending: boolean): Climb {
  return {
    id,
    date: e.date,
    discipline: e.discipline,
    grade: e.grade,
    attempts: Number(e.attempts),
    result: e.result,
    location: e.location || '',
    notes: e.notes || '',
    color: e.color || '',
    ...(pending ? { pending: true } : {}),
  };
}

async function knownOffline(): Promise<boolean> {
  try {
    const net = await NetInfo.fetch();
    return net.isConnected === false;
  } catch {
    return false; // unknown → attempt the network
  }
}

// ---- reads ----
export async function fetchMyClimbs(): Promise<Climb[]> {
  const uid = await currentUid();
  let server: Climb[];
  try {
    const { data, error } = await supabase
      .from('climbs')
      .select('*')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    server = (data ?? []).map(fromClimb);
    if (uid) await saveCache(uid, server);
  } catch (e) {
    if (!isNetErr(e) || !uid) throw e;
    server = await loadCache(uid); // offline: last synced snapshot
  }
  const ops = uid ? await loadOps(uid) : [];
  return applyQueue(server, ops);
}

// ---- writes ----
export async function addClimb(entry: NewClimb): Promise<Climb> {
  const uid = await currentUid();
  const id = Crypto.randomUUID();
  if (!(await knownOffline())) {
    try {
      const { data, error } = await supabase.from('climbs').insert({ id, ...climbRow(entry) }).select().single();
      if (error) throw error;
      flushClimbQueue();
      return fromClimb(data);
    } catch (e) {
      if (!isNetErr(e) || !uid) throw e;
    }
  }
  if (!uid) throw new Error('Not signed in');
  await saveOps(uid, enqueueAdd(await loadOps(uid), id, entry));
  return optimisticClimb(id, entry, true);
}

export async function updateClimb(id: string, entry: NewClimb): Promise<Climb> {
  const uid = await currentUid();
  const ops = uid ? await loadOps(uid) : [];
  if (uid && isPending(ops, id)) {
    await saveOps(uid, enqueueUpd(ops, id, entry)); // rewrite the queued insert; no network
    return optimisticClimb(id, entry, true);
  }
  if (!(await knownOffline())) {
    try {
      const { data, error } = await supabase.from('climbs').update(climbRow(entry)).eq('id', id).select().single();
      if (error) throw error;
      return fromClimb(data);
    } catch (e) {
      if (!isNetErr(e) || !uid) throw e;
    }
  }
  if (!uid) throw new Error('Not signed in');
  await saveOps(uid, enqueueUpd(await loadOps(uid), id, entry));
  return optimisticClimb(id, entry, false);
}

export async function delClimb(id: string): Promise<void> {
  const uid = await currentUid();
  const ops = uid ? await loadOps(uid) : [];
  if (uid && isPending(ops, id)) {
    await saveOps(uid, enqueueDel(ops, id)); // cancel the queued insert; no network
    return;
  }
  if (!(await knownOffline())) {
    try {
      const { error } = await supabase.from('climbs').delete().eq('id', id);
      if (error) throw error;
      return;
    } catch (e) {
      if (!isNetErr(e) || !uid) throw e;
    }
  }
  if (!uid) throw new Error('Not signed in');
  await saveOps(uid, enqueueDel(await loadOps(uid), id));
}

// ---- flush ----
async function applyOp(op: QueueOp): Promise<void> {
  if (op.kind === 'add') {
    const { error } = await supabase.from('climbs').insert({ id: op.id, ...climbRow(op.entry as any) });
    if (error && !isDupKey(error)) throw error; // dup key = a prior attempt already landed this row
  } else if (op.kind === 'upd') {
    const { error } = await supabase.from('climbs').update(climbRow(op.entry as any)).eq('id', op.id);
    if (error) throw error;
  } else if (op.kind === 'del') {
    const { error } = await supabase.from('climbs').delete().eq('id', op.id);
    if (error) throw error;
  }
}

let flushing = false;
// Drain the queue FIFO, single-flight. Re-reads the queue each iteration so a
// write that lands mid-flush isn't clobbered; drops an op after 3 non-network
// failures so one bad change can't wedge the queue forever.
export async function flushClimbQueue(): Promise<void> {
  if (flushing) return;
  const uid = await currentUid();
  if (!uid) return;
  flushing = true;
  try {
    while (true) {
      const ops = await loadOps(uid);
      if (!ops.length) break;
      const op = ops[0];
      let drop = false;
      try {
        await applyOp(op);
        drop = true;
      } catch (e) {
        if (isNetErr(e)) break; // still offline → keep everything queued
        const tries = (op.tries || 0) + 1;
        if (tries < 3) {
          const cur = await loadOps(uid);
          if (cur.length && cur[0].id === op.id) {
            cur[0].tries = tries;
            await saveOps(uid, cur);
          }
          break; // transient — retry on the next flush
        }
        console.warn('Dropping queued climb change after repeated sync failures:', op, e);
        drop = true;
      }
      if (drop) {
        const cur = await loadOps(uid);
        if (cur.length && cur[0].id === op.id) {
          cur.shift();
          await saveOps(uid, cur);
        }
      }
    }
  } finally {
    flushing = false;
  }
}

// Count of not-yet-synced climbs, for the Home "syncing" pill.
export async function pendingClimbCount(): Promise<number> {
  const uid = await currentUid();
  if (!uid) return 0;
  return (await loadOps(uid)).filter((o) => o.kind === 'add').length;
}
