/* ==========================================================================
   GymTrack — weightlifting & rock climbing progress tracker

   Storage has two modes:
     • Local  (signed out / not configured) — data in localStorage, this device.
     • Cloud  (signed in) — data in Supabase, synced across devices, private per
       user via Row-Level Security. Magic-link email auth (no passwords).
   On first sign-in, any local data is offered up for migration to the cloud.
   ========================================================================== */

(function () {
  'use strict';

  const STORE_KEY = 'gymtrack.v1';

  /* ----- Grade systems ----- */
  const V_GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16', 'V17'];
  const YDS_GRADES = [
    '5.5', '5.6', '5.7', '5.8', '5.9',
    '5.10a', '5.10b', '5.10c', '5.10d',
    '5.11a', '5.11b', '5.11c', '5.11d',
    '5.12a', '5.12b', '5.12c', '5.12d',
    '5.13a', '5.13b', '5.13c', '5.13d',
    '5.14a', '5.14b', '5.14c', '5.14d',
    '5.15a', '5.15b', '5.15c', '5.15d'
  ];
  const gradesFor = (d) => (d === 'Bouldering' ? V_GRADES : YDS_GRADES);
  const gradeRank = (d, g) => gradesFor(d).indexOf(g); // higher = harder

  /* ----- In-memory state (single source the UI renders from) ----- */
  let state = { lifts: [], climbs: [], routines: [] };

  /* ======================================================================
     Supabase setup
     ====================================================================== */
  const cfg = window.SUPABASE_CONFIG || {};
  const CONFIGURED = !!(
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR-PROJECT') &&
    !cfg.anonKey.includes('YOUR-ANON') &&
    window.supabase && window.supabase.createClient
  );
  // If the magic-link redirect carried an error (expired/pre-consumed link),
  // capture it before the client is created — the client mutates the hash.
  let authHashError = (() => {
    const m = /error_description=([^&]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  })();

  // Explicit session persistence: the login (refresh token) lives in
  // localStorage and is silently renewed on every visit, so you stay signed
  // in across visits until you sign out or the browser evicts site storage.
  const sb = CONFIGURED ? window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage
    }
  }) : null;

  // Best effort: ask the browser to treat this site's storage as persistent,
  // reducing the chance it evicts the saved login under storage pressure.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  let session = null;            // current auth session (or null)
  let migrationHandled = false;  // only prompt to migrate once per page load

  /* ----- Local persistence ----- */
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d.lifts) && Array.isArray(d.climbs)) {
          return { lifts: d.lifts, climbs: d.climbs, routines: Array.isArray(d.routines) ? d.routines : [] };
        }
      }
    } catch (e) { /* ignore */ }
    return { lifts: [], climbs: [], routines: [] };
  }
  function saveLocal() {
    localStorage.setItem(STORE_KEY, JSON.stringify({ lifts: state.lifts, climbs: state.climbs, routines: state.routines }));
  }
  function clearLocal() { localStorage.removeItem(STORE_KEY); }

  /* ----- Row mapping between DB and UI shapes ----- */
  const liftRow = (l) => ({
    date: l.date, exercise: l.exercise, weight: Number(l.weight),
    sets: Number(l.sets), reps: Number(l.reps), unit: l.unit, notes: l.notes || ''
  });
  const climbRow = (c) => {
    const row = {
      date: c.date, discipline: c.discipline, grade: c.grade,
      attempts: Number(c.attempts), result: c.result, location: c.location || '', notes: c.notes || ''
    };
    // Only send color when set, so inserts keep working on databases that
    // haven't run the color-column migration yet.
    if (c.color) row.color = c.color;
    return row;
  };
  const fromLift = (r) => ({ id: r.id, ...liftRow(r) });
  const fromClimb = (r) => ({ id: r.id, ...climbRow(r), color: r.color || '' });
  const routineRow = (r) => ({
    name: r.name, position: r.position | 0,
    exercises: r.exercises || [], last_run: r.last_run || null
  });
  const fromRoutine = (r) => ({ id: r.id, ...routineRow(r) });

  const cloudOn = () => !!(sb && session);

  /* ----- Weightlifting is owner-only -----
     Everyone else gets a climbing-only app. This is a UI gate (the email
     is visible in the source), not a security boundary — but each user's
     data is already private per-account via RLS regardless. Local/dev mode
     (no Supabase) always keeps lifting on. */
  const OWNER_EMAILS = ['jmandelmvp@gmail.com'];
  function liftingEnabled() {
    if (!CONFIGURED) return true;
    const email = session && session.user && session.user.email;
    return !!email && OWNER_EMAILS.includes(email.toLowerCase());
  }
  function applyLiftingMode() {
    document.body.classList.toggle('lifting-on', liftingEnabled());
  }

  /* ======================================================================
     Offline support (cloud mode)
     Reads:  every successful load/mutation snapshots state to localStorage,
             so with no signal the app opens on the last synced data.
     Writes: mutations that fail on a network error apply to the UI
             immediately and queue locally; the queue replays automatically
             when connectivity returns.
     ====================================================================== */
  const CACHE_KEY = 'gymtrack.cloudcache.v1';
  const QUEUE_KEY = 'gymtrack.queue.v1';

  // Network failure (offline / gym basement), as opposed to a real API error.
  function isNetErr(e) {
    return (typeof navigator !== 'undefined' && navigator.onLine === false) ||
      e instanceof TypeError ||
      /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(errMsg(e));
  }

  function saveCloudCache() {
    if (!cloudOn()) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        userId: session.user.id,
        lifts: state.lifts, climbs: state.climbs, routines: state.routines
      }));
    } catch (e) { /* storage full — cache is best-effort */ }
  }
  function loadCloudCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && session && c.userId === session.user.id) return c;
    } catch (e) { /* ignore */ }
    return null;
  }

  function loadQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY));
      if (q && q.userId && Array.isArray(q.ops)) return q;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveQueue(q) {
    if (!q || !q.ops.length) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    updatePendingUI();
  }
  // The queue for the signed-in user (a different account's leftovers don't apply)
  function myQueue() {
    const q = loadQueue();
    if (q && session && q.userId === session.user.id) return q;
    return { userId: session ? session.user.id : null, ops: [] };
  }
  function enqueue(op) {
    const q = myQueue();
    q.ops.push(op);
    saveQueue(q);
  }
  function pendingCount() {
    const q = loadQueue();
    return q && session && q.userId === session.user.id ? q.ops.length : 0;
  }
  function updatePendingUI() {
    const pill = $('#pending-pill');
    if (!pill) return;
    const n = cloudOn() ? pendingCount() : 0;
    pill.hidden = !n;
    if (n) pill.querySelector('b').textContent = n;
  }
  const isTemp = (id) => String(id).startsWith('tmp_');

  // Client-generated row id for inserts. Sending the id with the INSERT makes
  // it idempotent: if a response is lost after the server committed, the
  // queued replay hits the primary key instead of creating a duplicate row.
  const newRowId = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }));

  const isDupKeyErr = (e) => e && (e.code === '23505' || /duplicate key/i.test(errMsg(e)));

  // Replay one queued op against Supabase (throws on failure).
  async function applyOp(op) {
    const table = op.table;
    const rowMap = { lifts: liftRow, climbs: climbRow, routines: routineRow }[table];
    const fromMap = { lifts: fromLift, climbs: fromClimb, routines: fromRoutine }[table];
    if (op.kind === 'add') {
      // Ops from before client ids existed have no rowId — they insert the
      // old (non-idempotent) way rather than being dropped.
      const row = op.rowId ? { id: op.rowId, ...rowMap(op.entry) } : rowMap(op.entry);
      let rec;
      const { data, error } = await sb.from(table).insert(row).select().single();
      if (error) {
        if (!(op.rowId && isDupKeyErr(error))) throw error;
        rec = row; // a lost-response attempt already landed this exact row
      } else {
        rec = data;
      }
      // Swap the optimistic temp row for the real one
      const arr = state[table];
      const i = arr.findIndex((x) => x.id === op.tempId);
      if (i !== -1) arr[i] = fromMap(rec);
      else if (!arr.some((x) => x.id === rec.id)) arr.push(fromMap(rec));
    } else if (op.kind === 'upd') {
      const payload = op.patch || rowMap(op.entry);
      const { error } = await sb.from(table).update(payload).eq('id', op.id);
      if (error) throw error;
    } else if (op.kind === 'del') {
      const { error } = await sb.from(table).delete().eq('id', op.id);
      if (error) throw error;
    }
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing || !cloudOn()) return;
    flushing = true;
    let applied = false;
    try {
      while (true) {
        // Re-read the queue every iteration: enqueue() may have appended ops
        // while we awaited the previous replay, and a stale in-memory copy
        // would clobber them on save. (Two tabs can still race each other —
        // localStorage has no locking — but a single tab is now safe.)
        const q = myQueue();
        if (!q.ops.length) break;
        const op = q.ops[0];
        try {
          await applyOp(op);
          applied = true;
        } catch (e) {
          if (isNetErr(e)) break; // still offline — leave the rest queued
          // Real API error: keep the op and retry on later flushes, so a
          // transient server hiccup doesn't silently eat the change. Only
          // give up after several distinct flushes fail.
          op.tries = (op.tries || 0) + 1;
          if (op.tries < 3) { saveQueue(q); break; }
          console.warn('Dropping change after repeated sync failures:', op, e);
          alert(`One queued change couldn't sync (${errMsg(e)}) and was discarded.`);
        }
        // Handled (applied or dropped) — remove it. Ops are append-only, so
        // it is still at index 0 of a fresh read.
        const q2 = myQueue();
        q2.ops.shift();
        saveQueue(q2);
      }
    } finally {
      flushing = false;
    }
    updatePendingUI();
    if (applied) {
      saveCloudCache();
      renderAll();
    }
  }
  window.addEventListener('online', () => { flushQueue(); });

  // Shared shape for the cloud branch of every mutation: try the network;
  // on a network failure apply the change locally and queue it instead.
  async function cloudWrite(networkFn, offlineFn, op) {
    try {
      await networkFn();
    } catch (e) {
      if (!isNetErr(e)) throw e;
      offlineFn();
      if (op) enqueue(op);
    }
    saveCloudCache();
  }

  /* ----- Unified data layer ----- */
  const Store = {
    async load() {
      if (cloudOn()) {
        try {
          const [lifts, climbs] = await Promise.all([
            sb.from('lifts').select('*').order('date', { ascending: true }),
            sb.from('climbs').select('*').order('date', { ascending: true })
          ]);
          if (lifts.error) throw lifts.error;
          if (climbs.error) throw climbs.error;
          state.lifts = lifts.data.map(fromLift);
          state.climbs = climbs.data.map(fromClimb);
          // Routines fail soft: if the table hasn't been created yet (schema
          // not re-run), the rest of the app keeps working.
          try {
            const r = await sb.from('routines').select('*').order('position', { ascending: true });
            if (r.error) throw r.error;
            state.routines = r.data.map(fromRoutine);
          } catch (e) {
            const cached = isNetErr(e) ? loadCloudCache() : null;
            if (cached) state.routines = cached.routines || [];
            else {
              console.warn('Routines unavailable — run the routines section of supabase-schema.sql:', e);
              state.routines = [];
            }
          }
          saveCloudCache();
        } catch (e) {
          // Offline: open on the last synced snapshot instead of failing.
          const cached = isNetErr(e) ? loadCloudCache() : null;
          if (!cached) throw e;
          console.warn('Offline — showing the last synced data.');
          state.lifts = cached.lifts || [];
          state.climbs = cached.climbs || [];
          state.routines = cached.routines || [];
        }
      } else {
        const local = loadLocal();
        state.lifts = local.lifts;
        state.climbs = local.climbs;
        state.routines = local.routines;
      }
      updatePendingUI();
    },
    async addLift(entry) {
      if (cloudOn()) {
        const tempId = 'tmp_' + uid();
        const rowId = newRowId();
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('lifts').insert({ id: rowId, ...liftRow(entry) }).select().single();
            if (error) throw error;
            state.lifts.push(fromLift(data));
          },
          () => state.lifts.push({ id: tempId, ...entry }),
          { kind: 'add', table: 'lifts', tempId, rowId, entry }
        );
      } else {
        state.lifts.push({ id: uid(), ...entry });
        saveLocal();
      }
    },
    async addClimb(entry) {
      if (cloudOn()) {
        const tempId = 'tmp_' + uid();
        const rowId = newRowId();
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('climbs').insert({ id: rowId, ...climbRow(entry) }).select().single();
            if (error) throw error;
            state.climbs.push(fromClimb(data));
          },
          () => state.climbs.push({ id: tempId, ...entry }),
          { kind: 'add', table: 'climbs', tempId, rowId, entry }
        );
      } else {
        state.climbs.push({ id: uid(), ...entry });
        saveLocal();
      }
    },
    async updateLift(id, entry) {
      if (cloudOn()) {
        const apply = () => {
          const i = state.lifts.findIndex((x) => x.id === id);
          if (i !== -1) state.lifts[i] = { id, ...entry };
        };
        if (isTemp(id)) {
          // Not on the server yet — rewrite the queued insert instead.
          const q = myQueue();
          const op = q.ops.find((o) => o.tempId === id);
          if (op) { op.entry = entry; saveQueue(q); }
          apply();
          saveCloudCache();
          return;
        }
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('lifts').update(liftRow(entry)).eq('id', id).select().single();
            if (error) throw error;
            const i = state.lifts.findIndex((x) => x.id === id);
            if (i !== -1) state.lifts[i] = fromLift(data);
          },
          apply,
          { kind: 'upd', table: 'lifts', id, entry }
        );
      } else {
        const i = state.lifts.findIndex((x) => x.id === id);
        if (i !== -1) state.lifts[i] = { id, ...entry };
        saveLocal();
      }
    },
    async updateClimb(id, entry) {
      if (cloudOn()) {
        const apply = () => {
          const i = state.climbs.findIndex((x) => x.id === id);
          if (i !== -1) state.climbs[i] = { id, ...entry };
        };
        if (isTemp(id)) {
          const q = myQueue();
          const op = q.ops.find((o) => o.tempId === id);
          if (op) { op.entry = entry; saveQueue(q); }
          apply();
          saveCloudCache();
          return;
        }
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('climbs').update(climbRow(entry)).eq('id', id).select().single();
            if (error) throw error;
            const i = state.climbs.findIndex((x) => x.id === id);
            if (i !== -1) state.climbs[i] = fromClimb(data);
          },
          apply,
          { kind: 'upd', table: 'climbs', id, entry }
        );
      } else {
        const i = state.climbs.findIndex((x) => x.id === id);
        if (i !== -1) state.climbs[i] = { id, ...entry };
        saveLocal();
      }
    },
    async addRoutine(entry) {
      if (cloudOn()) {
        const tempId = 'tmp_' + uid();
        const rowId = newRowId();
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('routines').insert({ id: rowId, ...routineRow(entry) }).select().single();
            if (error) throw error;
            state.routines.push(fromRoutine(data));
          },
          () => state.routines.push({ id: tempId, ...routineRow(entry) }),
          { kind: 'add', table: 'routines', tempId, rowId, entry }
        );
      } else {
        state.routines.push({ id: uid(), ...routineRow(entry) });
        saveLocal();
      }
    },
    // patch: any subset of { name, position, exercises, last_run }
    async updateRoutine(id, patch) {
      if (cloudOn()) {
        const apply = () => {
          const i = state.routines.findIndex((x) => x.id === id);
          if (i !== -1) state.routines[i] = { ...state.routines[i], ...patch };
        };
        if (isTemp(id)) {
          const q = myQueue();
          const op = q.ops.find((o) => o.tempId === id);
          if (op) { op.entry = { ...op.entry, ...patch }; saveQueue(q); }
          apply();
          saveCloudCache();
          return;
        }
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('routines').update(patch).eq('id', id).select().single();
            if (error) throw error;
            const i = state.routines.findIndex((x) => x.id === id);
            if (i !== -1) state.routines[i] = fromRoutine(data);
          },
          apply,
          { kind: 'upd', table: 'routines', id, patch }
        );
      } else {
        const i = state.routines.findIndex((x) => x.id === id);
        if (i !== -1) state.routines[i] = { ...state.routines[i], ...patch };
        saveLocal();
      }
    },
    async delRoutine(id) {
      if (cloudOn()) {
        if (isTemp(id)) {
          const q = myQueue();
          q.ops = q.ops.filter((o) => o.tempId !== id);
          saveQueue(q);
        } else {
          await cloudWrite(
            async () => {
              const { error } = await sb.from('routines').delete().eq('id', id);
              if (error) throw error;
            },
            () => {},
            { kind: 'del', table: 'routines', id }
          );
        }
        state.routines = state.routines.filter((x) => x.id !== id);
        saveCloudCache();
      } else {
        state.routines = state.routines.filter((x) => x.id !== id);
        saveLocal();
      }
    },
    async delLift(id) {
      if (cloudOn()) {
        if (isTemp(id)) {
          const q = myQueue();
          q.ops = q.ops.filter((o) => o.tempId !== id);
          saveQueue(q);
        } else {
          await cloudWrite(
            async () => {
              const { error } = await sb.from('lifts').delete().eq('id', id);
              if (error) throw error;
            },
            () => {},
            { kind: 'del', table: 'lifts', id }
          );
        }
        state.lifts = state.lifts.filter((x) => x.id !== id);
        saveCloudCache();
      } else {
        state.lifts = state.lifts.filter((x) => x.id !== id);
        saveLocal();
      }
    },
    async delClimb(id) {
      if (cloudOn()) {
        if (isTemp(id)) {
          const q = myQueue();
          q.ops = q.ops.filter((o) => o.tempId !== id);
          saveQueue(q);
        } else {
          await cloudWrite(
            async () => {
              const { error } = await sb.from('climbs').delete().eq('id', id);
              if (error) throw error;
            },
            () => {},
            { kind: 'del', table: 'climbs', id }
          );
        }
        state.climbs = state.climbs.filter((x) => x.id !== id);
        saveCloudCache();
      } else {
        state.climbs = state.climbs.filter((x) => x.id !== id);
        saveLocal();
      }
    },
    async resetAll() {
      if (cloudOn()) {
        const uidv = session.user.id;
        const a = await sb.from('lifts').delete().eq('user_id', uidv);
        const b = await sb.from('climbs').delete().eq('user_id', uidv);
        if (a.error) throw a.error;
        if (b.error) throw b.error;
        state.lifts = []; state.climbs = [];
        saveCloudCache();
      } else {
        // "All logged data" = the logs. Routines are templates and survive a
        // reset in both modes (the cloud branch above leaves them too).
        state = { lifts: [], climbs: [], routines: state.routines };
        saveLocal();
      }
    },
    async importData(data) {
      const routines = Array.isArray(data.routines) ? data.routines : [];
      if (cloudOn()) {
        if (data.lifts.length) {
          const { error } = await sb.from('lifts').insert(data.lifts.map(liftRow));
          if (error) throw error;
        }
        if (data.climbs.length) {
          const { error } = await sb.from('climbs').insert(data.climbs.map(climbRow));
          if (error) throw error;
        }
        if (routines.length) {
          const { error } = await sb.from('routines').insert(routines.map(routineRow));
          if (error) throw error;
        }
        await this.load();
      } else {
        state = {
          lifts: data.lifts,
          climbs: data.climbs,
          routines: routines.map((r) => ({ id: r.id || uid(), ...routineRow(r) }))
        };
        saveLocal();
      }
    }
  };

  /* ----- Migrate local data into the cloud on first sign-in ----- */
  async function maybeMigrate() {
    if (migrationHandled) return;
    migrationHandled = true;
    const local = loadLocal();
    if (!local.lifts.length && !local.climbs.length) return;
    const msg = `Upload your ${local.lifts.length} local lift set(s) and ${local.climbs.length} climb(s) to your account so they sync across devices?`;
    if (!confirm(msg)) return;
    setSync(true);
    try {
      if (local.lifts.length) {
        const { error } = await sb.from('lifts').insert(local.lifts.map(liftRow));
        if (error) throw error;
      }
      if (local.climbs.length) {
        const { error } = await sb.from('climbs').insert(local.climbs.map(climbRow));
        if (error) throw error;
      }
      clearLocal();
    } catch (e) {
      console.error('Migration error:', e);
      alert('Could not upload local data: ' + errMsg(e));
    } finally {
      setSync(false);
    }
  }

  /* ======================================================================
     Helpers
     ====================================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // Always the LOCAL calendar date. (toISOString() is UTC — in the US evening
  // that's already tomorrow, which mis-stamped logs and zeroed the streak.)
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayISO = () => isoOf(new Date());
  const fmtNum = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });

  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateShort(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function escapeHTML(str) {
    return String(str || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function mostCommon(arr) {
    if (!arr.length) return null;
    const counts = {};
    arr.forEach((x) => { counts[x] = (counts[x] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  // Extract a human-readable message from a Supabase / fetch error object
  function errMsg(e) {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    const m = e.message || e.error_description || e.msg || e.error || e.hint;
    if (m) return m;
    if (e.status || e.code) return `request failed (${e.code || e.status})`;
    try { const s = JSON.stringify(e); if (s && s !== '{}') return s; } catch (x) { /* ignore */ }
    return 'request failed — check the browser console for details';
  }

  // Run an async mutation with the sync indicator + basic error handling
  async function withSync(fn) {
    setSync(true);
    try {
      await fn();
    } catch (e) {
      console.error('Sync error:', e);
      alert('Sync error: ' + errMsg(e));
    } finally {
      setSync(false);
      flushQueue(); // being able to mutate implies we may be back online
    }
  }

  /* ======================================================================
     Tabs
     ====================================================================== */
  // Top tab bar, mobile bottom nav, and the header avatar all switch views.
  function showView(view) {
    $$('.tab[data-view], .bnav-btn[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.remove('is-active'));
    $('#view-' + view).classList.add('is-active');
    const ava = $('#profile-btn');
    if (ava) ava.classList.toggle('is-active', view === 'profile');
    window.scrollTo(0, 0); // each page opens from its top
    redrawActiveCharts();  // charts drawn while hidden re-fit to real width
  }
  $$('.tab[data-view], .bnav-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  /* ----- Floating "+" button: log a set or a climb from anywhere ----- */
  const fabMenu = $('#fab-menu');
  $('#fab').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!liftingEnabled()) { openQuickLog(); return; } // climbing-only: straight to the quick sheet
    fabMenu.hidden = !fabMenu.hidden;
  });
  $('#fab-lift').addEventListener('click', () => { fabMenu.hidden = true; openAddLift(); });
  $('#fab-climb').addEventListener('click', () => { fabMenu.hidden = true; openQuickLog(); });

  /* ----- "Log entry" pill on the dashboard: same chooser, under the button ----- */
  const logMenu = $('#log-menu');
  $('#dash-log-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!liftingEnabled()) { openQuickLog(); return; }
    logMenu.hidden = !logMenu.hidden;
  });
  $('#log-lift').addEventListener('click', () => { logMenu.hidden = true; openAddLift(); });
  $('#log-climb').addEventListener('click', () => { logMenu.hidden = true; openQuickLog(); });
  document.addEventListener('click', (e) => {
    if (!fabMenu.hidden && !e.target.closest('.fab-wrap')) fabMenu.hidden = true;
    if (!logMenu.hidden && !e.target.closest('.log-wrap')) logMenu.hidden = true;
  });

  /* ----- Per-view "log" buttons in the page headers ----- */
  $('#lift-add-btn').addEventListener('click', openAddLift);
  $('#climb-add-btn').addEventListener('click', openQuickLog);

  /* ======================================================================
     Weightlifting
     ====================================================================== */

  /* ----- Exercise-name normalization -----
     "back squat", "Back  Squat", and "BACK SQUAT" are the same exercise.
     Entries are grouped case-insensitively everywhere, and names are
     canonicalized on save so stored data converges on one spelling. */
  const exKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

  // key -> display spelling (most common; title-cased if it starts lowercase)
  function exerciseDisplayMap() {
    const counts = {};
    state.lifts.forEach((l) => {
      const k = exKey(l.exercise);
      counts[k] = counts[k] || {};
      counts[k][l.exercise.trim().replace(/\s+/g, ' ')] = (counts[k][l.exercise.trim().replace(/\s+/g, ' ')] || 0) + 1;
    });
    const map = {};
    Object.keys(counts).forEach((k) => {
      const best = Object.entries(counts[k]).sort((a, b) => b[1] - a[1])[0][0];
      map[k] = /^[a-z]/.test(best) ? titleCase(best) : best;
    });
    return map;
  }

  // The spelling an entry should be stored under.
  function canonicalExercise(input) {
    const clean = String(input || '').trim().replace(/\s+/g, ' ');
    if (!clean) return clean;
    const existing = exerciseDisplayMap()[exKey(clean)];
    return existing || (/^[a-z]/.test(clean) ? titleCase(clean) : clean);
  }

  const DEFAULT_EXERCISES = [
    // Pulls & back
    'Pull-up', 'Weighted Pull-up', 'Chin-up', 'Lat Pulldown',
    'Barbell Row', 'Pendlay Row', 'Chest-Supported Row', 'Single-Arm Dumbbell Row',
    // Presses & chest
    'Bench Press', 'Incline Bench Press', 'Dumbbell Bench Press', 'Incline Dumbbell Press',
    'Overhead Press', 'Seated Dumbbell Shoulder Press', 'Weighted Dip', 'Cable Fly', 'Pec Deck',
    // Shoulders & arms
    'Lateral Raise', 'Face Pull', 'Rear-Delt Flye',
    'EZ Bar Curl', 'Hammer Curl', 'Overhead Tricep Extension', 'Tricep Pushdown',
    // Legs
    'Back Squat', 'Front Squat', 'Bulgarian Split Squat', 'Walking Lunge',
    'Deadlift', 'Trap Bar Deadlift', 'Romanian Deadlift', 'Hip Thrust',
    'Leg Extension', 'Seated Leg Curl', 'Standing Calf Raise', 'Seated Calf Raise',
    // Core
    'Hanging Leg Raise', 'Ab Wheel Rollout', 'Weighted Plank', 'Cable Crunch',
    // Grip & climbing-specific
    'Dead Hang', 'Hangboard Hang', 'Hangboard Repeaters', 'Plate Pinch',
    'Wrist Curl', 'Reverse Wrist Curl'
  ];

  // User's own exercises first, then remaining defaults, deduped by key.
  function exerciseSuggestions() {
    const seen = new Set();
    const names = [];
    Object.values(exerciseDisplayMap()).sort().forEach((n) => {
      if (!seen.has(exKey(n))) { seen.add(exKey(n)); names.push(n); }
    });
    DEFAULT_EXERCISES.forEach((n) => {
      if (!seen.has(exKey(n))) { seen.add(exKey(n)); names.push(n); }
    });
    return names;
  }

  /* Custom type-ahead dropdown. iOS renders <datalist> suggestions inside the
     keyboard's QuickType bar, which is easy to miss — this panel shows them
     directly under the input instead, on every platform. */
  function attachSuggest(input) {
    const panel = input.parentElement.querySelector('.suggest-panel');
    let active = -1; // keyboard-highlighted item

    function matches() {
      const q = input.value.trim().toLowerCase();
      const all = exerciseSuggestions();
      const hits = q ? all.filter((n) => n.toLowerCase().includes(q)) : all;
      // Don't show a single suggestion that's already exactly what's typed
      if (hits.length === 1 && hits[0].toLowerCase() === q) return [];
      return hits.slice(0, 8);
    }

    function render() {
      const hits = matches();
      active = -1;
      if (!hits.length) { panel.hidden = true; panel.innerHTML = ''; return; }
      const q = input.value.trim();
      panel.innerHTML = hits.map((n) => {
        const i = q ? n.toLowerCase().indexOf(q.toLowerCase()) : -1;
        const label = i === -1 ? escapeHTML(n)
          : escapeHTML(n.slice(0, i)) + '<b>' + escapeHTML(n.slice(i, i + q.length)) + '</b>' + escapeHTML(n.slice(i + q.length));
        return `<div class="suggest-item" data-value="${escapeHTML(n)}">${label}</div>`;
      }).join('');
      panel.hidden = false;
      // pointerdown (not click) so choosing an item wins over the input's blur
      panel.querySelectorAll('.suggest-item').forEach((el) => {
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          input.value = el.dataset.value;
          hide();
        });
      });
    }

    function hide() { panel.hidden = true; panel.innerHTML = ''; active = -1; }

    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keydown', (e) => {
      const items = [...panel.querySelectorAll('.suggest-item')];
      if (panel.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = e.key === 'ArrowDown'
          ? (active + 1) % items.length
          : (active - 1 + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('is-active', i === active));
        items[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault(); // choose the suggestion instead of submitting
        input.value = items[active].dataset.value;
        hide();
      } else if (e.key === 'Escape') {
        hide();
      }
    });
  }

  $$('input[data-suggest="exercise"]').forEach(attachSuggest);

  function renderLifting() {
    const map = exerciseDisplayMap();
    const el = $('#lift-filter');
    const prev = el.value;
    el.innerHTML = '';
    el.add(new Option('All exercises', ''));
    Object.keys(map).sort((a, b) => map[a].localeCompare(map[b])).forEach((k) => el.add(new Option(map[k], k)));
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;

    renderLiftTable();
    renderLiftChart();
    renderLiftWeekChart();
  }

  function renderLiftTable() {
    const tbody = $('#lift-table tbody');
    const filter = $('#lift-filter').value; // an exercise key, or ''
    const display = exerciseDisplayMap();
    // Newest session first; within a date group same-exercise sets together,
    // keeping the order they were logged (stable sort) — so an ascending
    // 135/185/225 pyramid reads top to bottom.
    const rows = state.lifts
      .filter((l) => !filter || exKey(l.exercise) === filter)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        const ka = exKey(a.exercise), kb = exKey(b.exercise);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });

    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No sets logged yet.</td></tr>';
      return;
    }
    let prev = null;
    rows.forEach((l) => {
      const sameGroup = prev && prev.date === l.date && exKey(prev.exercise) === exKey(l.exercise);
      prev = l;
      const tr = document.createElement('tr');
      if (sameGroup) tr.className = 'grouped';
      tr.innerHTML = `
        <td class="date">${sameGroup ? '' : fmtDate(l.date)}</td>
        <td class="ex">${sameGroup ? '<span class="set-cont">＋ set</span>' : escapeHTML(display[exKey(l.exercise)] || l.exercise)}</td>
        <td class="wt">${l.weight > 0 ? `${fmtNum(l.weight)} ${escapeHTML(l.unit)}` : 'BW'}</td>
        <td>${l.sets} × ${l.reps}</td>
        <td class="muted">${escapeHTML(l.notes)}</td>
        <td class="row-actions">
          <button class="edit-btn" title="Edit" aria-label="Edit"><svg class="ico"><use href="#i-pencil"/></svg></button>
          <button class="del-btn" title="Delete" aria-label="Delete"><svg class="ico"><use href="#i-x"/></svg></button>
        </td>`;
      tr.querySelector('.edit-btn').addEventListener('click', () => openEditLift(l));
      tr.querySelector('.del-btn').addEventListener('click', () => {
        withSync(async () => {
          await Store.delLift(l.id);
          renderLifting(); renderDashboard();
        });
      });
      tbody.appendChild(tr);
    });
  }

  // '30'/'60'/'90' -> cutoff ISO date; 'all' -> null (no cutoff)
  function rangeCutoff(sel) {
    const v = $(sel).value;
    return v === 'all' ? null : daysAgoISO(parseInt(v, 10));
  }

  // Per-exercise, per-session series for the selected metric.
  // metric: 'top' (heaviest weight), 'volume' (weight×sets×reps), 'reps' (sets×reps)
  // Exercises are grouped case-insensitively (see exKey).
  function liftSeries(metric, lifts) {
    const unit = dominantUnit();
    const display = exerciseDisplayMap();
    const byEx = {};
    lifts.forEach((l) => {
      const w = toUnit(l.weight, l.unit, unit);
      const k = exKey(l.exercise);
      const ex = (byEx[k] = byEx[k] || {});
      const day = (ex[l.date] = ex[l.date] || { top: 0, volume: 0, reps: 0 });
      day.top = Math.max(day.top, w);
      day.volume += w * l.sets * l.reps;
      day.reps += l.sets * l.reps;
    });
    return Object.keys(byEx).sort((a, b) => display[a].localeCompare(display[b])).map((k) => ({
      label: display[k],
      points: Object.keys(byEx[k]).sort().map((d) => ({ date: d, value: byEx[k][d][metric] }))
    }));
  }

  // Weekly volume bars on the Weightlifting page — last 12 weeks, empty
  // weeks shown as zero so gaps in training are visible.
  function renderLiftWeekChart() {
    const wrap = $('#lift-week-chart');
    if (!wrap) return;
    const unit = dominantUnit();
    const nWeeks = 12;
    const weeks = [];
    const start = weekStart(daysAgoISO(7 * (nWeeks - 1)));
    for (let i = 0; i < nWeeks; i++) {
      const d = new Date(start + 'T00:00:00');
      d.setDate(d.getDate() + i * 7);
      weeks.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    const wIndex = new Set(weeks);
    const volByWeek = {};
    state.lifts.forEach((l) => {
      const w = weekStart(l.date);
      if (wIndex.has(w)) volByWeek[w] = (volByWeek[w] || 0) + toUnit(l.weight, l.unit, unit) * l.sets * l.reps;
    });
    drawBars(wrap,
      weeks.map((w) => ({ date: w, value: volByWeek[w] || 0 })),
      (v) => `${fmtCompact(v)} ${unit}`);
  }

  function renderLiftChart() {
    const metric = $('#lift-chart-metric').value;
    const cutoff = rangeCutoff('#lift-range');
    const prStrip = $('#lift-prs');
    const wrap = $('#lift-chart');
    const unit = dominantUnit();

    const lifts = cutoff ? state.lifts.filter((l) => l.date >= cutoff) : state.lifts;
    if (!lifts.length) {
      wrap.innerHTML = `<div class="chart-empty">${state.lifts.length ? 'No sets in this range.' : 'Log a set to see progress.'}</div>`;
      prStrip.innerHTML = '';
      return;
    }

    const fmt = metric === 'reps' ? (v) => fmtNum(Math.round(v)) : (v) => `${fmtCompact(v)} ${unit}`;
    drawChart(wrap, liftSeries(metric, lifts), fmt);

    // PR chips for the selected range
    const volLabel = cutoff ? 'Total volume' : 'All-time volume';
    const display = exerciseDisplayMap();
    let heaviest = null;
    lifts.forEach((l) => {
      if (!(l.weight > 0)) return; // bodyweight sets can't be the heaviest lift
      const w = toUnit(l.weight, l.unit, unit);
      if (!heaviest || w > heaviest.w) heaviest = { w, exercise: display[exKey(l.exercise)] || l.exercise };
    });
    const volByDate = {};
    lifts.forEach((l) => {
      volByDate[l.date] = (volByDate[l.date] || 0) + toUnit(l.weight, l.unit, unit) * l.sets * l.reps;
    });
    const bestSession = Math.max(...Object.values(volByDate));
    const totalVol = Object.values(volByDate).reduce((s, v) => s + v, 0);
    prStrip.innerHTML = `
      ${heaviest ? `<span class="pr-chip">Heaviest lift <b>${escapeHTML(heaviest.exercise)} ${fmtNum(heaviest.w)} ${unit}</b></span>` : ''}
      <span class="pr-chip">Best session volume <b>${fmtCompact(bestSession)} ${unit}</b></span>
      <span class="pr-chip">${volLabel} <b>${fmtCompact(totalVol)} ${unit}</b></span>`;
  }

  $('#lift-filter').addEventListener('change', renderLiftTable);
  $('#lift-chart-metric').addEventListener('change', renderLiftChart);
  $('#lift-range').addEventListener('change', renderLiftChart);

  /* ======================================================================
     Rock climbing
     ====================================================================== */
  const isSend = (r) => r !== 'Project';

  function renderClimbing() {
    renderClimberRating();
    renderClimbTable();
    renderClimbChart();
  }

  // History as sessions: filtered list for display, full history for scoring.
  function renderClimbTable() {
    const filter = $('#climb-filter').value;
    const climbs = state.climbs.filter((c) => !filter || c.discipline === filter);
    renderSessions($('#climb-sessions'), climbs, {
      editable: true,
      allClimbs: state.climbs,
      emptyMsg: 'No climbs logged yet.'
    });
  }

  const ALL_DISCIPLINES = ['Bouldering', 'Sport', 'Top Rope', 'Trad'];
  const ROPE_DISCIPLINES = ['Sport', 'Top Rope', 'Trad'];

  // Hardest grade sent per session for one discipline (values are grade ranks).
  function hardestSeries(discipline, sends) {
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

  // Sends per session for one discipline.
  function sendsSeries(discipline, sends) {
    const byDate = {};
    sends
      .filter((c) => c.discipline === discipline)
      .forEach((c) => { byDate[c.date] = (byDate[c.date] || 0) + 1; });
    return {
      label: discipline,
      points: Object.keys(byDate).sort().map((d) => ({ date: d, value: byDate[d] }))
    };
  }

  /* ======================================================================
     Send Score — a cumulative points total, computed client-side.

     SENDS earn points that grow EXPONENTIALLY with the route's absolute
     difficulty (×1.5 per V-grade), so one climb near your limit outscores a
     whole session of easy laps, and the gap between grades widens as they
     get harder — matching the real effort jump from V7→V8 vs V1→V2.

     PROJECTS (fails) cost a small penalty that depends on how far BELOW your
     AVERAGE send the failed grade is:
       • harder than your average  → ~1–2 pts (trying hard is never punished)
       • at/below your average     → grows smoothly the further below you go,
                                      capped so a fluke fall costs little.
     The penalty is strictly monotonic (an easier fail always costs more than
     a harder one) and bounded; a whole rough session subtracts at most
     SS_SESSION_CAP, so one bad day can never erase weeks of progress, and
     the total is floored at 0 (never negative).

     Two independent totals — Bouldering (V) and Roped (YDS) — since the
     scales differ. Ties within a date replay in id order so every device and
     the SQL leaderboard replay agree on the same sequence. KEEP THE CONSTANTS
     AND grade→D MAPS IN SYNC with supabase-schema.sql (climb_send_scores_impl).
     ====================================================================== */
  const SS_P0 = 5, SS_GROWTH = 1.5;               // send points: 5·1.5^D at D0 (V0 / 5.10c)
  const SS_PEN_FLOOR = 1, SS_PEN_CEIL = 10, SS_PEN_MID = 3, SS_PEN_WIDTH = 1.4; // fail-penalty logistic
  const SS_SESSION_CAP = 24;                       // max a single session's fails can subtract

  const ratingGroup = (discipline) => (discipline === 'Bouldering' ? 'boulder' : 'rope');

  // Grade → difficulty index D (V-scale units; 5.10c ≈ V0 ≈ D0). Roped uses a
  // standard boulder-equivalent conversion so a V5 boulder and a ~5.12d route
  // are worth similar points.
  const V_D = {}; V_GRADES.forEach((g, i) => { V_D[g] = i - 1; }); // VB=-1, V0=0 … V17=17
  const YDS_D_LIST = [-4, -3.5, -3, -2.5, -2, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.7, 4.3, 5, 6, 6.7, 7.3, 8, 9, 9.7, 10.3, 11, 12, 13, 14, 15];
  const YDS_D = {}; YDS_GRADES.forEach((g, i) => { YDS_D[g] = YDS_D_LIST[i]; });
  const gradeD = (discipline, grade) => (discipline === 'Bouldering' ? V_D[grade] : YDS_D[grade]);

  const sendPoints = (discipline, grade) => {
    const d = gradeD(discipline, grade);
    return d === undefined ? 0 : Math.max(1, Math.round(SS_P0 * Math.pow(SS_GROWTH, d)));
  };
  // Penalty as a function of (your average send D − the failed grade's D).
  const failPenalty = (avgD, failD) => {
    const delta = avgD - failD;
    const p = SS_PEN_FLOOR + (SS_PEN_CEIL - SS_PEN_FLOOR) / (1 + Math.exp(-(delta - SS_PEN_MID) / SS_PEN_WIDTH));
    return Math.round(p * 10) / 10;
  };
  const climbKey = (c) => `${c.grade}|${c.color || ''}`; // identifies "the same climb" in a session

  // THE scoring replay over an explicit climb list, grouped into sessions
  // (dates). Returns per-session detail with each climb's exact ± points.
  function scoreBreakdown(allClimbs, group) {
    const climbs = allClimbs
      .filter((c) => ratingGroup(c.discipline) === group && gradeD(c.discipline, c.grade) !== undefined)
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
        : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

    let total = 0, sendCount = 0, sendDSum = 0;
    const sessions = [];
    let i = 0;
    while (i < climbs.length) {
      const date = climbs[i].date;
      const sesh = [];
      while (i < climbs.length && climbs[i].date === date) { sesh.push(climbs[i]); i++; }

      const avgD = sendCount ? sendDSum / sendCount : null; // average send as of the session start
      const sentKeys = new Set(sesh.filter((c) => isSend(c.result)).map(climbKey));
      const before = total;
      const detail = [];
      const seenFail = new Set();
      let sendPts = 0, rawPen = 0, sends = 0, hardestRank = -1, hardestDisc = null;
      for (const c of sesh) {
        const d = gradeD(c.discipline, c.grade);
        if (isSend(c.result)) {
          const pts = sendPoints(c.discipline, c.grade);
          sendPts += pts; sends++;
          sendCount++; sendDSum += d;
          const rk = gradeRank(c.discipline, c.grade);
          if (rk > hardestRank) { hardestRank = rk; hardestDisc = c.discipline; }
          detail.push({ id: c.id, group, _send: true, raw: pts, climb: c });
        } else {
          // Fail: waived if the same climb was sent this session; each distinct
          // failed climb is penalised once (extra attempts don't stack).
          const k = climbKey(c);
          if (sentKeys.has(k) || seenFail.has(k)) { detail.push({ id: c.id, group, raw: 0, climb: c }); continue; }
          seenFail.add(k);
          const pen = failPenalty(avgD === null ? d : avgD, d); // no history yet → treat as at-average
          rawPen += pen;
          detail.push({ id: c.id, group, raw: -pen, climb: c });
        }
      }
      // Cap the session's total penalty; scale each fail's shown cost to match.
      const penScale = rawPen > SS_SESSION_CAP ? SS_SESSION_CAP / rawPen : 1;
      detail.forEach((x) => { x.delta = x._send ? x.raw : Math.round(x.raw * penScale * 10) / 10; delete x.raw; delete x._send; });
      total = Math.max(0, total + sendPts - Math.min(rawPen, SS_SESSION_CAP)); // never negative
      sessions.push({
        date, delta: Math.round(total - before), end: Math.round(total),
        count: detail.length, sends, climbs: detail,
        hardest: hardestRank >= 0 ? (hardestDisc === 'Bouldering' ? V_GRADES[hardestRank] : YDS_GRADES[hardestRank]) : null
      });
    }
    return { group, sessions, rating: Math.round(total), hasData: sessions.length > 0 };
  }

  // The headline view of the replay (hero, cards, charts).
  function climberRating(group) {
    const b = scoreBreakdown(state.climbs, group);
    const last = b.sessions.length ? b.sessions[b.sessions.length - 1] : null;
    return {
      group,
      rating: b.rating,
      sessions: b.sessions.length,
      hasData: b.hasData,
      history: b.sessions.map((x) => ({ date: x.date, value: x.end })),
      lastSession: last,
      lastSessionDelta: last ? last.delta : 0
    };
  }

  const RATING_GROUPS = [
    { key: 'boulder', label: 'Bouldering', scale: 'V-scale', color: '#1f3a5f' },
    { key: 'rope', label: 'Roped', scale: 'YDS', color: '#f59e2c' }
  ];

  // The rating cards shown on the climbing page and profile.
  function renderClimberRating() {
    const hidden = !!getSettings().hide_rating;
    const html = hidden ? '' : RATING_GROUPS.map((g) => {
      const r = climberRating(g.key);
      if (!r.hasData) return '';
      const d = r.lastSessionDelta;
      const delta = d ? `<span class="rating-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>` : '';
      const sub = `${g.scale} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}`;
      return `
        <div class="rating-card ${g.key}" title="Your Send Score — points for every send, growing steeply with grade; a rough day barely dents it.">
          <span class="rating-label">${g.label} Send Score</span>
          <span class="rating-value">${r.rating}${delta}</span>
          <span class="rating-sub">${sub}</span>
        </div>`;
    }).join('');
    ['#climb-rating', '#profile-rating'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.hidden = !html;
      el.innerHTML = html || '';
    });
  }

  // The discipline the hero features — whichever the user climbs most.
  function primaryRatingGroup() {
    const disc = mostCommon(state.climbs.map((c) => c.discipline));
    return disc ? ratingGroup(disc) : 'boulder';
  }

  // Rating change over the last `days`: current minus the rating as of the
  // most recent session on/before the cutoff (START if there wasn't one).
  function ratingChange(group, days) {
    const r = climberRating(group);
    if (!r.hasData) return null;
    const cut = daysAgoISO(days);
    let baseline = 0; // the score accumulates from zero
    for (const p of r.history) { if (p.date < cut) baseline = p.value; else break; }
    return { now: r.rating, change: Math.round(r.rating - baseline) };
  }

  // The rating hero at the top of Home — the dashboard's centerpiece.
  function renderRatingHero() {
    const de = $('#rh-delta');
    // Rating hidden by preference → fall back to the weekly-sessions hero.
    $('#rating-panel').hidden = !!getSettings().hide_rating;
    if (getSettings().hide_rating) {
      const wk = weekStart(todayISO());
      const dates = new Set(state.climbs.filter((x) => x.date >= wk).map((x) => x.date));
      const goal = weeklyGoal();
      const pct = Math.min(100, Math.round(dates.size / goal * 100));
      $('#rh-label').textContent = 'This week';
      $('#rh-value').textContent = dates.size;
      de.textContent = ''; de.className = 'rating-delta';
      $('#rh-sub').textContent = `sessions · goal ${goal}`;
      $('#rh-session').textContent = '';
      $('#hero-ring').style.background = `conic-gradient(var(--accent) ${pct}%, rgba(253,248,239,0.20) 0)`;
      $('#hero-pct').textContent = pct + '%';
      return;
    }
    const pg = primaryRatingGroup();
    const g = RATING_GROUPS.find((x) => x.key === pg);
    const other = RATING_GROUPS.find((x) => x.key !== pg);
    const r = climberRating(pg);
    const ro = climberRating(other.key);
    $('#rh-label').textContent = `${g.label} Send Score`;
    const hero = $('.rating-hero');
    if (!r.hasData) {
      // Inviting empty state — no ghost ring or "—" that reads as broken.
      hero.classList.add('is-empty');
      $('#rh-label').textContent = 'Send Score';
      $('#rh-value').textContent = '0';
      de.textContent = ''; de.className = 'rating-delta';
      $('#rh-sub').textContent = 'Send your first climb to start banking points.';
      $('#rh-session').textContent = '';
      return;
    }
    hero.classList.remove('is-empty');
    $('#rh-value').textContent = r.rating;
    const d = r.lastSessionDelta;
    de.className = 'rating-delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
    de.textContent = d ? `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}` : '';
    const parts = [`${g.scale} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}`];
    if (ro.hasData) parts.push(`${other.label} ${ro.rating}`);
    $('#rh-sub').textContent = parts.join(' · ');
    const ls = r.lastSession;
    $('#rh-session').textContent = ls
      ? `Last session: ${ls.count} climb${ls.count === 1 ? '' : 's'}${ls.hardest ? ` · hardest ${ls.hardest}` : ''} · ${ls.delta >= 0 ? '+' : ''}${ls.delta}`
      : '';
    // Ring fills toward the next 100-point milestone.
    const band = ((r.rating % 100) + 100) % 100;
    $('#hero-ring').style.background = `conic-gradient(var(--accent) ${band}%, rgba(253,248,239,0.20) 0)`;
    $('#hero-pct').textContent = Math.ceil((r.rating + 1) / 100) * 100;
  }

  // Rating-over-time chart. History is replayed over ALL climbs (truncating
  // would give a wrong rating); the range only limits the displayed window.
  function drawRatingChart(wrap, cutoff) {
    const series = RATING_GROUPS.map((g) => {
      const r = climberRating(g.key);
      const points = cutoff ? r.history.filter((p) => p.date >= cutoff) : r.history;
      return { label: g.label, color: g.color, points };
    }).filter((s) => s.points.length);
    if (!series.length) {
      wrap.innerHTML = '<div class="chart-empty">Log climbs to build your Send Score.</div>';
      return;
    }
    drawChart(wrap, series, (v) => fmtNum(Math.round(v)));
  }

  function renderClimbChart() {
    const metric = $('#climb-chart-metric').value;
    const cutoff = rangeCutoff('#climb-range');
    const wrap = $('#climb-chart');
    const prStrip = $('#climb-prs');

    const sends = state.climbs.filter((c) => isSend(c.result) && (!cutoff || c.date >= cutoff));

    // Brand mapping: bouldering is navy, roped disciplines lead with orange.
    const DISC_COLORS = { 'Bouldering': '#1f3a5f', 'Sport': '#f59e2c', 'Top Rope': '#16181d', 'Trad': '#3a7d44' };
    if (metric === 'rating') {
      drawRatingChart(wrap, cutoff);
    } else if (!sends.length) {
      wrap.innerHTML = `<div class="chart-empty">${state.climbs.length ? 'No sends in this range.' : 'Log a send to see progress.'}</div>`;
      prStrip.innerHTML = '';
      return;
    } else if (metric === 'sends') {
      drawChart(wrap, ALL_DISCIPLINES.map((d) => ({ ...sendsSeries(d, sends), color: DISC_COLORS[d] })), (v) => fmtNum(Math.round(v)));
    } else {
      // Hardest sends: bouldering (V scale) and ropes (YDS) use different
      // scales, so each gets its own chart and axis.
      wrap.innerHTML = '';
      const boulder = { ...hardestSeries('Bouldering', sends), color: DISC_COLORS['Bouldering'] };
      const ropes = ROPE_DISCIPLINES.map((d) => ({ ...hardestSeries(d, sends), color: DISC_COLORS[d] })).filter((s) => s.points.length);
      if (boulder.points.length) {
        const t = document.createElement('p');
        t.className = 'subchart-title';
        t.textContent = 'Bouldering (V scale)';
        const div = document.createElement('div');
        wrap.appendChild(t); wrap.appendChild(div);
        drawChart(div, [boulder], (v) => V_GRADES[Math.round(v)] || '');
      }
      if (ropes.length) {
        const t = document.createElement('p');
        t.className = 'subchart-title';
        t.textContent = 'Ropes (YDS)';
        const div = document.createElement('div');
        wrap.appendChild(t); wrap.appendChild(div);
        drawChart(div, ropes, (v) => YDS_GRADES[Math.round(v)] || '');
      }
    }

    // PR chips across all disciplines
    const boulderSends = sends.filter((c) => c.discipline === 'Bouldering');
    const ropeSends = sends.filter((c) => ROPE_DISCIPLINES.includes(c.discipline));
    const chips = [];
    if (boulderSends.length) {
      const best = Math.max(...boulderSends.map((c) => gradeRank('Bouldering', c.grade)));
      chips.push(`<span class="pr-chip">Hardest boulder <b>${V_GRADES[best]}</b></span>`);
    }
    if (ropeSends.length) {
      const best = Math.max(...ropeSends.map((c) => gradeRank(c.discipline, c.grade)));
      chips.push(`<span class="pr-chip">Hardest route <b>${YDS_GRADES[best]}</b></span>`);
    }
    if (sends.length) chips.push(`<span class="pr-chip">Total sends <b>${sends.length}</b></span>`);
    prStrip.innerHTML = chips.join('');
  }

  $('#climb-filter').addEventListener('change', renderClimbTable);
  $('#climb-chart-metric').addEventListener('change', renderClimbChart);
  $('#climb-range').addEventListener('change', renderClimbChart);

  /* ======================================================================
     Entry modal — used both to log new sets/climbs and to edit existing ones.
     editingLiftId/editingClimbId are null while adding.
     ====================================================================== */
  const editModal = $('#edit-modal');
  const editLiftForm = $('#edit-lift-form');
  const editClimbForm = $('#edit-climb-form');
  const editStatus = $('#edit-status');
  let editingLiftId = null;
  let editingClimbId = null;

  /* ----- Hold-color picker (climb form) ----- */
  const CLIMB_COLORS = {
    'Red': '#d64545', 'Orange': '#f59e2c', 'Yellow': '#eac54f', 'Green': '#3a7d44',
    'Blue': '#3b82c4', 'Purple': '#8b5cf6', 'Pink': '#ec6aa0', 'Black': '#16181d',
    'White': '#f5f2ea', 'Gray': '#9aa0a8', 'Brown': '#8a6240'
  };
  // A colored dot for known hold colors; a hollow neutral dot otherwise, so
  // every climb row keeps the same anatomy (no missing-dot gaps).
  const routeDot = (color) =>
    CLIMB_COLORS[color]
      ? `<span class="route-dot" style="background:${CLIMB_COLORS[color]}" title="${escapeHTML(color)} route"></span>`
      : '<span class="route-dot route-dot-none" title="No color logged"></span>';

  // Build the swatch row once; tapping selects, tapping again clears.
  (function buildColorRow() {
    const row = $('#climb-colors');
    Object.keys(CLIMB_COLORS).forEach((name) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.style.background = CLIMB_COLORS[name];
      btn.dataset.color = name;
      btn.title = name;
      btn.setAttribute('aria-label', name);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        setClimbColor(editClimbForm.elements.color.value === name ? '' : name);
      });
      row.appendChild(btn);
    });
  })();

  function setClimbColor(name) {
    editClimbForm.elements.color.value = name || '';
    $$('#climb-colors .color-swatch').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.color === name));
    });
  }

  function populateEditGradeSelect() {
    const d = $('#edit-climb-discipline').value;
    const sel = $('#edit-climb-grade');
    const prev = sel.value;
    sel.innerHTML = '';
    gradesFor(d).forEach((g) => sel.add(new Option(g, g)));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  $('#edit-climb-discipline').addEventListener('change', populateEditGradeSelect);

  function openEntryModal(kind, title) {
    editLiftForm.hidden = kind !== 'lift';
    editClimbForm.hidden = kind !== 'climb';
    $('#edit-title').textContent = title;
    editStatus.textContent = '';
    editStatus.className = 'auth-status';
    editModal.hidden = false;
  }
  function closeEditModal() {
    editModal.hidden = true;
    editingLiftId = null;
    editingClimbId = null;
    // Leaving the modal pauses any routine session; its saved state (if not
    // finished) surfaces as the Resume bar on the program panel.
    run = null;
    renderResumeBar();
    $('#run-strip').hidden = true;
    $('#run-hint').hidden = true;
    $('#run-next').hidden = true;
    $('#lift-another').textContent = 'Save & add another set';
  }
  $('#edit-close').addEventListener('click', closeEditModal);
  editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });

  /* ----- Lifts ----- */
  // Bodyweight sets are stored with weight 0; the checkbox just relaxes the
  // form so no weight has to be typed. Anything with weight 0 displays as "BW".
  function applyBodyweight() {
    const bw = editLiftForm.elements.bodyweight.checked;
    const w = editLiftForm.elements.weight;
    w.disabled = bw;
    w.required = !bw;
    if (bw) w.value = '';
  }
  editLiftForm.elements.bodyweight.addEventListener('change', applyBodyweight);

  // Segmented lbs/kg control writes the hidden unit field and reflects state.
  function setLiftUnit(u) {
    editLiftForm.elements.unit.value = u;
    $$('#edit-lift-form .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.unit === u));
  }
  $$('#edit-lift-form .seg-btn').forEach((b) => b.addEventListener('click', () => setLiftUnit(b.dataset.unit)));

  function openAddLift() {
    editingLiftId = null;
    editLiftForm.reset();
    applyBodyweight(); // reset unchecks the box — re-enable the weight field
    editLiftForm.elements.date.value = todayISO();
    editLiftForm.elements.sets.value = 1;
    setLiftUnit(dominantUnit());
    // Fast path: prefill the most recent exercise and its last numbers, so
    // an ad-hoc set needs zero typing (change the exercise only if needed).
    if (state.lifts.length) {
      const recent = state.lifts[state.lifts.length - 1];
      const last = lastFor(recent.exercise);
      editLiftForm.elements.exercise.value = recent.exercise;
      if (last) {
        editLiftForm.elements.bodyweight.checked = !(last.weight > 0);
        applyBodyweight();
        if (last.weight > 0) editLiftForm.elements.weight.value = last.weight;
        editLiftForm.elements.reps.value = last.reps;
        setLiftUnit(last.unit);
      }
    }
    $('#edit-lift-submit').textContent = 'Add set';
    $('#lift-another').hidden = false;
    openEntryModal('lift', 'Log a set');
  }

  function openEditLift(l) {
    editingLiftId = l.id;
    editLiftForm.elements.date.value = l.date;
    editLiftForm.elements.exercise.value = l.exercise;
    editLiftForm.elements.bodyweight.checked = !(l.weight > 0);
    applyBodyweight();
    if (l.weight > 0) editLiftForm.elements.weight.value = l.weight;
    editLiftForm.elements.sets.value = l.sets;
    editLiftForm.elements.reps.value = l.reps;
    setLiftUnit(l.unit);
    editLiftForm.elements.notes.value = l.notes || '';
    $('#edit-lift-submit').textContent = 'Save changes';
    $('#lift-another').hidden = true;
    openEntryModal('lift', 'Edit set');
  }

  // keepOpen: log the set but stay in the modal with date/exercise/unit kept,
  // so an ascending pyramid (135 → 185 → 225…) is just "bump weight, tap again".
  function saveLift(keepOpen) {
    if (!editLiftForm.reportValidity()) return;
    const bw = editLiftForm.elements.bodyweight.checked;
    const f = new FormData(editLiftForm);
    const entry = {
      date: f.get('date'),
      exercise: canonicalExercise(f.get('exercise')),
      weight: bw ? 0 : parseFloat(f.get('weight')),
      sets: parseInt(f.get('sets'), 10),
      reps: parseInt(f.get('reps'), 10),
      unit: f.get('unit'),
      notes: (f.get('notes') || '').trim()
    };
    if (!entry.exercise || isNaN(entry.weight) || isNaN(entry.reps)) return;
    const id = editingLiftId;
    withSync(async () => {
      if (id) await Store.updateLift(id, entry);
      else await Store.addLift(entry);
      renderLifting();
      renderDashboard();
      if (keepOpen && !id) {
        editStatus.className = 'auth-status ok';
        editStatus.textContent = `Added ${entry.exercise} — ${bw ? 'BW' : `${fmtNum(entry.weight)} ${entry.unit}`} × ${entry.reps}. Log the next set:`;
        editLiftForm.elements.notes.value = '';
        if (!bw) editLiftForm.elements.weight.select();
      } else if (run) {
        advanceRun(); // routine session: logged this exercise, move to the next
      } else {
        closeEditModal();
      }
    });
  }

  editLiftForm.addEventListener('submit', (e) => { e.preventDefault(); saveLift(false); });
  $('#lift-another').addEventListener('click', () => saveLift(true));

  // Steppers: weight moves by 5 lbs / 2.5 kg, sets and reps by 1 — a changed
  // set is a couple of taps instead of typing mid-workout.
  $$('#edit-lift-form .step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = editLiftForm.elements[btn.dataset.target];
      if (input.disabled) return; // bodyweight mode locks the weight field
      const dir = Number(btn.dataset.dir);
      const stepBy = btn.dataset.target === 'weight'
        ? (editLiftForm.elements.unit.value === 'kg' ? 2.5 : 5)
        : 1;
      const min = btn.dataset.target === 'weight' ? 0 : 1;
      const cur = parseFloat(input.value) || 0;
      input.value = Math.max(min, Math.round((cur + dir * stepBy) * 100) / 100);
    });
  });

  /* ----- Climbs ----- */
  function openAddClimb() {
    editingClimbId = null;
    editClimbForm.reset();
    editClimbForm.elements.date.value = todayISO();
    // default to whatever was climbed most recently
    const last = state.climbs.length ? state.climbs[state.climbs.length - 1] : null;
    editClimbForm.elements.discipline.value = last ? last.discipline : 'Bouldering';
    populateEditGradeSelect();
    setClimbColor(''); // every route is its own color — start unpicked
    editClimbForm.elements.attempts.value = 1;
    editClimbForm.elements.result.value = 'Send';
    if (last && last.location) editClimbForm.elements.location.value = last.location;
    $('#edit-climb-submit').textContent = 'Add climb';
    $('#climb-another').hidden = false;
    openEntryModal('climb', 'Log a climb');
  }

  function openEditClimb(c) {
    editingClimbId = c.id;
    editClimbForm.elements.date.value = c.date;
    editClimbForm.elements.discipline.value = c.discipline;
    populateEditGradeSelect();
    editClimbForm.elements.grade.value = c.grade;
    setClimbColor(c.color || '');
    editClimbForm.elements.attempts.value = c.attempts;
    editClimbForm.elements.result.value = c.result;
    editClimbForm.elements.location.value = c.location || '';
    editClimbForm.elements.notes.value = c.notes || '';
    $('#edit-climb-submit').textContent = 'Save changes';
    $('#climb-another').hidden = true;
    openEntryModal('climb', 'Edit climb');
  }

  function saveClimb(keepOpen) {
    if (!editClimbForm.reportValidity()) return;
    const f = new FormData(editClimbForm);
    const entry = {
      date: f.get('date'),
      discipline: f.get('discipline'),
      grade: f.get('grade'),
      attempts: parseInt(f.get('attempts'), 10) || 1,
      result: f.get('result'),
      color: f.get('color') || '',
      location: (f.get('location') || '').trim(),
      notes: (f.get('notes') || '').trim()
    };
    const id = editingClimbId;
    withSync(async () => {
      if (id) await Store.updateClimb(id, entry);
      else await Store.addClimb(entry);
      renderClimbing();
      renderDashboard();
      if (keepOpen && !id) {
        editStatus.className = 'auth-status ok';
        editStatus.textContent = `Added ${entry.grade} · ${entry.discipline}. Log the next climb:`;
        editClimbForm.elements.attempts.value = 1;
        editClimbForm.elements.notes.value = '';
        setClimbColor(''); // the next route will be a different color
      } else {
        closeEditModal();
      }
    });
  }

  editClimbForm.addEventListener('submit', (e) => { e.preventDefault(); saveClimb(false); });
  $('#climb-another').addEventListener('click', () => saveClimb(true));

  /* ======================================================================
     Quick-Log sheet — the fast path for climbs. Grade chip + result button
     = logged (two taps), saved instantly with today's date and defaults.
     Detail (color, attempts, location, notes) is deferred to the full
     modal. The sheet stays open for rapid-fire logging at the wall.
     ====================================================================== */
  const QS_KEY = 'gymtrack.quicklog.v1';
  const quickSheet = $('#quick-sheet');
  let qsState = { discipline: 'Bouldering', grade: null };
  try { qsState = { ...qsState, ...(JSON.parse(localStorage.getItem(QS_KEY)) || {}) }; } catch (e) { /* ignore */ }
  const saveQs = () => { try { localStorage.setItem(QS_KEY, JSON.stringify(qsState)); } catch (e) { /* ignore */ } };

  let toastTimer = null;
  function showToast(msg, onUndo) {
    const t = $('#toast');
    $('#toast-msg').textContent = msg;
    $('#toast-undo').hidden = !onUndo;
    $('#toast-undo').onclick = () => { t.hidden = true; if (onUndo) onUndo(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  function openQuickLog() {
    if (!qsState.grade && state.climbs.length) {
      const last = state.climbs[state.climbs.length - 1];
      qsState.discipline = last.discipline;
      qsState.grade = last.grade;
    }
    renderQuickLog();
    quickSheet.hidden = false;
    // Bring the selected grade into view once the sheet has laid out
    const active = $('#qs-grades .qs-grade.is-active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderQuickLog() {
    $('#qs-disciplines').innerHTML = ALL_DISCIPLINES.map((d) =>
      `<button type="button" class="qs-tab${d === qsState.discipline ? ' is-active' : ''}" data-d="${d}">${d === 'Bouldering' ? 'Boulder' : d}</button>`).join('');
    $$('#qs-disciplines .qs-tab').forEach((b) => b.addEventListener('click', () => {
      qsState.discipline = b.dataset.d;
      if (!gradesFor(qsState.discipline).includes(qsState.grade)) qsState.grade = null;
      saveQs();
      renderQuickLog();
    }));

    $('#qs-grades').innerHTML = gradesFor(qsState.discipline).map((g) =>
      `<button type="button" class="qs-grade${g === qsState.grade ? ' is-active' : ''}" data-g="${escapeHTML(g)}">${escapeHTML(g)}</button>`).join('');
    $$('#qs-grades .qs-grade').forEach((b) => b.addEventListener('click', () => {
      qsState.grade = b.dataset.g;
      saveQs();
      renderQuickLog();
    }));

    // One-tap repeat of the most recent climb
    const last = state.climbs.length ? state.climbs[state.climbs.length - 1] : null;
    const rpt = $('#qs-repeat');
    rpt.hidden = !last;
    if (last) {
      rpt.innerHTML = `Same as last: <b>${escapeHTML(last.grade)} · ${escapeHTML(last.result)}</b>`;
      rpt.onclick = () => quickSaveClimb(last.discipline, last.grade, last.result);
    }

    // Today's climbs in the active discipline group — tap to fix a mistake
    const grp = ratingGroup(qsState.discipline);
    const today = state.climbs
      .filter((c) => c.date === todayISO() && ratingGroup(c.discipline) === grp)
      .slice(-3).reverse();
    $('#qs-recent').innerHTML = today.length
      ? '<span class="qs-recent-label">Today</span>' + today.map((c) => `
          <button type="button" class="qs-recent-row" data-id="${escapeHTML(String(c.id))}">
            ${escapeHTML(c.grade)} · ${escapeHTML(c.result)} <svg class="ico"><use href="#i-pencil"/></svg>
          </button>`).join('')
      : '';
    $$('#qs-recent .qs-recent-row').forEach((b) => b.addEventListener('click', () => {
      const c = state.climbs.find((x) => String(x.id) === b.dataset.id);
      if (c) { quickSheet.hidden = true; openEditClimb(c); }
    }));

    $$('#quick-sheet .qs-result').forEach((b) => { b.disabled = !qsState.grade; });
  }

  function quickSaveClimb(discipline, grade, result) {
    const entry = {
      date: todayISO(), discipline, grade,
      attempts: result === 'Project' ? 2 : 1, // a project implies more than one go
      result, location: '', notes: ''
    };
    withSync(async () => {
      await Store.addClimb(entry);
      renderClimbing();
      renderDashboard();
      const added = state.climbs[state.climbs.length - 1];
      showToast(`${grade} ${result} ✓`, () => {
        withSync(async () => {
          await Store.delClimb(added.id);
          renderClimbing(); renderDashboard(); renderQuickLog();
        });
      });
      qsState.discipline = discipline;
      qsState.grade = grade;
      saveQs();
      renderQuickLog(); // sheet stays open — refresh the Today list
    });
  }

  $$('#quick-sheet .qs-result').forEach((b) => b.addEventListener('click', () => {
    if (qsState.grade) quickSaveClimb(qsState.discipline, qsState.grade, b.dataset.result);
  }));
  $('#qs-close').addEventListener('click', () => { quickSheet.hidden = true; });
  quickSheet.addEventListener('click', (e) => { if (e.target === quickSheet) quickSheet.hidden = true; });
  $('#qs-detail').addEventListener('click', () => {
    quickSheet.hidden = true;
    openAddClimb();
    // Carry the sheet's selection into the full form
    editClimbForm.elements.discipline.value = qsState.discipline;
    populateEditGradeSelect();
    if (qsState.grade) editClimbForm.elements.grade.value = qsState.grade;
  });

  /* ======================================================================
     Routines — saved training days, runnable as a guided session.
     ====================================================================== */
  const rx = (exercise, sets, reps) => ({ exercise, sets, reps });

  // The 5-day Upper/Lower/Push/Pull/Legs program, importable with one tap.
  const PROGRAM_ROUTINES = [
    { name: 'Upper', exercises: [
      rx('Weighted Pull-up', 4, '5–8'), rx('Incline Bench Press', 4, '6–10'),
      rx('Chest-Supported Row', 3, '8–12'), rx('Overhead Press', 3, '6–10'),
      rx('Lat Pulldown', 3, '10–12'), rx('Lateral Raise', 4, '12–20'),
      rx('Face Pull', 3, '15–20'), rx('EZ Bar Curl', 3, '10–12'),
      rx('Overhead Tricep Extension', 3, '10–12'), rx('Dead Hang', 3, 'max')
    ] },
    { name: 'Lower', exercises: [
      rx('Back Squat', 4, '5–8'), rx('Romanian Deadlift', 3, '8–10'),
      rx('Bulgarian Split Squat', 3, '8–12'), rx('Leg Extension', 3, '12–15'),
      rx('Standing Calf Raise', 4, '10–15'), rx('Hanging Leg Raise', 3, '10–15')
    ] },
    { name: 'Push', exercises: [
      rx('Bench Press', 4, '6–10'), rx('Seated Dumbbell Shoulder Press', 3, '8–12'),
      rx('Weighted Dip', 3, '8–12'), rx('Cable Fly', 3, '12–15'),
      rx('Lateral Raise', 4, '12–20'), rx('Tricep Pushdown', 3, '10–15'),
      rx('Ab Wheel Rollout', 3, '10–15')
    ] },
    { name: 'Pull', exercises: [
      rx('Chin-up', 4, '6–10'), rx('Pendlay Row', 4, '6–10'),
      rx('Single-Arm Dumbbell Row', 3, '8–12'), rx('EZ Bar Curl', 3, '10–12'),
      rx('Hammer Curl', 3, '10–12'), rx('Rear-Delt Flye', 3, '15–20'),
      rx('Hangboard Repeaters', 3, 'max'), rx('Wrist Curl', 2, '15–20')
    ] },
    { name: 'Legs', exercises: [
      rx('Deadlift', 3, '5–8'), rx('Hip Thrust', 3, '8–12'),
      rx('Walking Lunge', 3, '10–12'), rx('Seated Leg Curl', 3, '12–15'),
      rx('Seated Calf Raise', 4, '15–20'), rx('Cable Crunch', 3, '12–15')
    ] }
  ];

  function seedProgram() {
    withSync(async () => {
      for (let i = 0; i < PROGRAM_ROUTINES.length; i++) {
        await Store.addRoutine({ name: PROGRAM_ROUTINES[i].name, position: i, exercises: PROGRAM_ROUTINES[i].exercises, last_run: null });
      }
      renderProgram();
    });
  }

  // The routine after the most recently run one (cycling), or the first.
  function upNextId(rs) {
    const ran = rs.filter((r) => r.last_run);
    if (!ran.length) return rs[0].id;
    const last = ran.slice().sort((a, b) => (a.last_run < b.last_run ? 1 : -1))[0];
    const i = rs.findIndex((r) => r.id === last.id);
    return rs[(i + 1) % rs.length].id;
  }

  // The program panel lives on the Weightlifting page.
  function renderProgram() {
    renderResumeBar(); // interrupted session? offer the one-tap pickup
    const containers = [$('#routine-list-lift')].filter(Boolean);
    const rs = state.routines.slice().sort((a, b) => (a.position | 0) - (b.position | 0));
    containers.forEach((el) => {
      if (!rs.length) {
        el.innerHTML = `
          <div class="routine-empty">
            <p class="muted">Save your training days once, then run them with one tap — each exercise pre-filled from the last time you did it.</p>
            <button class="btn pill routine-seed">＋ Add the 5-day program</button>
          </div>`;
        el.querySelector('.routine-seed').addEventListener('click', seedProgram);
        return;
      }
      const nextId = upNextId(rs);
      el.innerHTML = rs.map((r) => `
        <div class="routine-row" data-id="${escapeHTML(String(r.id))}">
          <div>
            <div class="feed-main">${escapeHTML(r.name)}${r.id === nextId ? ' <span class="you-chip">Up next</span>' : ''}</div>
            <div class="feed-sub">${r.exercises.length} exercise${r.exercises.length === 1 ? '' : 's'}${r.last_run ? ' · last run ' + fmtDateShort(r.last_run) : ''}</div>
          </div>
          <div class="routine-actions">
            <button class="edit-btn" title="Edit routine" aria-label="Edit routine"><svg class="ico"><use href="#i-pencil"/></svg></button>
            <button class="btn pill sm run-btn">Start</button>
          </div>
        </div>`).join('');
      el.querySelectorAll('.routine-row').forEach((row) => {
        const r = rs.find((x) => String(x.id) === row.dataset.id);
        row.querySelector('.edit-btn').addEventListener('click', () => openRoutineEditor(r));
        row.querySelector('.run-btn').addEventListener('click', () => startRoutine(r));
      });
    });
  }

  /* ----- Routine editor modal ----- */
  const routineModal = $('#routine-modal');
  const routineForm = $('#routine-form');
  let editingRoutineId = null;

  function routineRowEl(item) {
    const div = document.createElement('div');
    div.className = 'routine-edit-row';
    div.innerHTML = `
      <div class="suggest-wrap">
        <input type="text" class="r-ex" placeholder="Exercise" autocomplete="off" autocapitalize="words" value="${escapeHTML(item ? item.exercise : '')}" />
        <div class="suggest-panel" hidden></div>
      </div>
      <input type="number" class="r-sets" min="1" max="12" step="1" value="${item ? item.sets : 3}" aria-label="Sets" />
      <input type="text" class="r-reps" placeholder="8–12" value="${escapeHTML(item ? item.reps : '')}" aria-label="Reps" />
      <button type="button" class="row-del" title="Remove exercise" aria-label="Remove exercise"><svg class="ico"><use href="#i-x"/></svg></button>`;
    attachSuggest(div.querySelector('.r-ex'));
    div.querySelector('.row-del').addEventListener('click', () => div.remove());
    return div;
  }

  function openRoutineEditor(r) {
    editingRoutineId = r ? r.id : null;
    routineForm.reset();
    routineForm.elements.name.value = r ? r.name : '';
    const rows = $('#routine-rows');
    rows.innerHTML = '';
    (r ? r.exercises : [null, null, null]).forEach((it) => rows.appendChild(routineRowEl(it)));
    $('#routine-title').textContent = r ? 'Edit routine' : 'New routine';
    $('#routine-delete').hidden = !r;
    const status = $('#routine-status');
    status.textContent = ''; status.className = 'auth-status';
    routineModal.hidden = false;
  }
  function closeRoutineModal() { routineModal.hidden = true; editingRoutineId = null; }

  $$('.routine-new-btn').forEach((btn) => btn.addEventListener('click', () => openRoutineEditor(null)));
  $('#routine-close').addEventListener('click', closeRoutineModal);
  routineModal.addEventListener('click', (e) => { if (e.target === routineModal) closeRoutineModal(); });
  $('#routine-add-row').addEventListener('click', () => $('#routine-rows').appendChild(routineRowEl(null)));

  routineForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = routineForm.elements.name.value.trim();
    const items = [...$('#routine-rows').children].map((row) => ({
      exercise: canonicalExercise(row.querySelector('.r-ex').value),
      sets: parseInt(row.querySelector('.r-sets').value, 10) || 3,
      reps: row.querySelector('.r-reps').value.trim()
    })).filter((it) => it.exercise);
    if (!name || !items.length) {
      const status = $('#routine-status');
      status.className = 'auth-status err';
      status.textContent = 'Give the routine a name and at least one exercise.';
      return;
    }
    const id = editingRoutineId;
    withSync(async () => {
      if (id) await Store.updateRoutine(id, { name, exercises: items });
      else await Store.addRoutine({ name, position: state.routines.length, exercises: items, last_run: null });
      closeRoutineModal();
      renderProgram();
    });
  });

  $('#routine-delete').addEventListener('click', () => {
    const id = editingRoutineId;
    if (!id || !confirm('Delete this routine? Your logged sets are not affected.')) return;
    withSync(async () => {
      await Store.delRoutine(id);
      closeRoutineModal();
      renderProgram();
    });
  });

  /* ----- Session runner: walk a routine exercise by exercise ----- */
  let run = null; // { routine, idx } while a session is in progress

  // The in-progress session survives an app close: every exercise change
  // snapshots {routineId, idx, date} so reopening offers a one-tap resume.
  const RUN_KEY = 'gymtrack.run.v1';
  function saveRunState() {
    try {
      if (run) localStorage.setItem(RUN_KEY, JSON.stringify({ routineId: run.routine.id, idx: run.idx, date: todayISO() }));
    } catch (e) { /* ignore */ }
  }
  function clearRunState() {
    try { localStorage.removeItem(RUN_KEY); } catch (e) { /* ignore */ }
    renderResumeBar();
  }
  function savedRunState() {
    try {
      const s = JSON.parse(localStorage.getItem(RUN_KEY));
      if (s && s.date === todayISO() && state.routines.some((r) => String(r.id) === String(s.routineId))) return s;
    } catch (e) { /* ignore */ }
    return null;
  }
  function renderResumeBar() {
    const bar = $('#resume-bar');
    if (!bar) return;
    const s = savedRunState();
    // Hidden while the runner is actually open — it's for coming back later.
    if (!s || run) { bar.hidden = true; return; }
    const r = state.routines.find((x) => String(x.id) === String(s.routineId));
    bar.hidden = false;
    bar.innerHTML = `
      <span class="resume-text">Session in progress: <b>${escapeHTML(r.name)}</b> — exercise ${Math.min(s.idx + 1, r.exercises.length)} of ${r.exercises.length}</span>
      <span class="resume-actions">
        <button type="button" class="btn pill sm" id="resume-run">Resume</button>
        <button type="button" class="btn ghost sm" id="resume-dismiss">Dismiss</button>
      </span>`;
    $('#resume-run').addEventListener('click', () => {
      run = { routine: r, idx: Math.min(s.idx, r.exercises.length - 1) };
      renderResumeBar();
      runExercise();
    });
    $('#resume-dismiss').addEventListener('click', clearRunState);
  }

  // The most recent day this exercise was logged; heaviest set from that day.
  function lastFor(exercise) {
    const k = exKey(exercise);
    const mine = state.lifts.filter((l) => exKey(l.exercise) === k);
    if (!mine.length) return null;
    const lastDate = mine.reduce((m, l) => (l.date > m ? l.date : m), mine[0].date);
    return mine.filter((l) => l.date === lastDate).reduce((a, b) => (b.weight > a.weight ? b : a));
  }

  function startRoutine(r) {
    run = { routine: r, idx: 0 };
    // Mark it run today so "Up next" advances to the following day.
    withSync(async () => {
      await Store.updateRoutine(r.id, { last_run: todayISO() });
      renderProgram();
    });
    runExercise();
  }

  function runExercise() {
    saveRunState();
    const { routine, idx } = run;
    const item = routine.exercises[idx];
    const lastEx = idx === routine.exercises.length - 1;
    editingLiftId = null;
    editLiftForm.reset();
    editLiftForm.elements.date.value = todayISO();
    editLiftForm.elements.exercise.value = item.exercise;
    editLiftForm.elements.sets.value = item.sets || 1;
    const last = lastFor(item.exercise);
    if (last) {
      setLiftUnit(last.unit);
      editLiftForm.elements.bodyweight.checked = !(last.weight > 0);
      applyBodyweight();
      if (last.weight > 0) editLiftForm.elements.weight.value = last.weight;
      editLiftForm.elements.reps.value = last.reps;
    } else {
      applyBodyweight();
      setLiftUnit(dominantUnit());
    }
    const strip = $('#run-strip');
    strip.hidden = false;
    strip.textContent = `Exercise ${idx + 1} of ${routine.exercises.length} · target ${item.sets}×${item.reps || '?'}`;
    const hint = $('#run-hint');
    hint.hidden = !last;
    if (last) {
      hint.textContent = `Last time: ${last.weight > 0 ? `${fmtNum(last.weight)} ${last.unit}` : 'BW'} — ${last.sets}×${last.reps} on ${fmtDateShort(last.date)}`;
    }
    $('#edit-lift-submit').textContent = lastEx ? 'Log set & finish' : 'Log set & next';
    $('#lift-another').hidden = false;
    $('#lift-another').textContent = 'Log set & stay';
    const skip = $('#run-next');
    skip.hidden = false;
    skip.textContent = lastEx ? 'Skip & finish' : 'Skip exercise';
    openEntryModal('lift', routine.name);
  }

  function advanceRun() {
    run.idx++;
    if (run.idx >= run.routine.exercises.length) {
      clearRunState(); // finished — nothing to resume
      closeEditModal();
    } else {
      runExercise();
    }
  }
  $('#run-next').addEventListener('click', advanceRun);

  /* ======================================================================
     Dashboard
     ====================================================================== */
  // "▲ 12% vs prior 30d" — trend annotation under a stat value
  function setDelta(sel, cur, prev, rangeDays) {
    const el = $(sel);
    el.classList.remove('up', 'down');
    if (!cur && !prev) { el.textContent = ''; return; }
    if (!prev) { el.textContent = 'new this period'; el.classList.add('up'); return; }
    const diff = cur - prev;
    if (diff === 0) { el.textContent = `same as prior ${rangeDays}d`; return; }
    const pct = Math.round(Math.abs(diff) / prev * 100);
    el.textContent = `${diff > 0 ? '▲' : '▼'} ${pct}% vs prior ${rangeDays}d`;
    el.classList.add(diff > 0 ? 'up' : 'down');
  }

  function renderDashboard() {
    const R = parseInt($('#dash-range').value, 10) || 30;
    const cutCur = daysAgoISO(R);
    const cutPrev = daysAgoISO(R * 2);
    const inCurrent = (x) => x.date >= cutCur;
    const inPrevious = (x) => x.date >= cutPrev && x.date < cutCur;
    $$('.stat-label .rng').forEach((el) => { el.textContent = `${R}d`; });

    // Climbing: sessions + sends
    const climbSess = (rows) => new Set(rows.map((c) => c.date)).size;
    const sendCount = (rows) => rows.filter((c) => isSend(c.result)).length;
    const climbsCur = state.climbs.filter(inCurrent);
    const climbsPrev = state.climbs.filter(inPrevious);

    $('#dash-climb-sessions').textContent = climbSess(climbsCur);
    setDelta('#dash-climb-sessions-delta', climbSess(climbsCur), climbSess(climbsPrev), R);
    $('#dash-climb-sends').textContent = sendCount(climbsCur);
    setDelta('#dash-climb-sends-delta', sendCount(climbsCur), sendCount(climbsPrev), R);

    // Rating change over the range (primary discipline)
    const pg = primaryRatingGroup();
    const rc = ratingChange(pg, R);
    const rcEl = $('#dash-rating-change');
    const rcSub = $('#dash-rating-change-sub');
    rcEl.classList.remove('up', 'down');
    if (rc) {
      rcEl.textContent = `${rc.change >= 0 ? '+' : ''}${rc.change}`;
      rcEl.classList.add(rc.change > 0 ? 'up' : rc.change < 0 ? 'down' : '');
      const label = RATING_GROUPS.find((x) => x.key === pg).label;
      rcSub.textContent = `${label} · now ${rc.now}`;
    } else {
      rcEl.textContent = '—';
      rcSub.textContent = 'Log climbs to start';
    }

    // Weekly trend charts (also redrawn on view switch / resize)
    renderDashCharts();

    // Home top section: week strip, hero, mini cards, streak, recent feed
    renderHome();
    renderProgram();
    renderLeaderboard(); // async; manages its own visibility
  }

  // Weekly trend charts spanning the selected range (empty weeks shown as zero).
  // Separate from renderDashboard so chart redraws skip stats + leaderboard RPC.
  function renderDashCharts() {
    const R = parseInt($('#dash-range').value, 10) || 30;
    const nWeeks = Math.ceil(R / 7) + 1;
    const weeks = [];
    const start = weekStart(daysAgoISO(7 * (nWeeks - 1)));
    for (let i = 0; i < nWeeks; i++) {
      const d = new Date(start + 'T00:00:00');
      d.setDate(d.getDate() + i * 7);
      weeks.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    const wIndex = new Set(weeks);

    // Bouldering vs everything on a rope, one line each (navy / orange)
    const sendSeries = [
      { label: 'Bouldering', match: (d) => d === 'Bouldering', color: '#1f3a5f' },
      { label: 'Roped', match: (d) => ROPE_DISCIPLINES.includes(d), color: '#f59e2c' }
    ].map(({ label, match, color }) => {
      const byWeek = {};
      state.climbs
        .filter((c) => match(c.discipline) && isSend(c.result))
        .forEach((c) => {
          const w = weekStart(c.date);
          if (wIndex.has(w)) byWeek[w] = (byWeek[w] || 0) + 1;
        });
      return Object.keys(byWeek).length
        ? { label, color, points: weeks.map((w) => ({ date: w, value: byWeek[w] || 0 })) }
        : { label, color, points: [] };
    });
    drawChart($('#dash-climb-chart'), sendSeries, (v) => fmtNum(Math.round(v)));

    // Rating over time — the centerpiece chart (shown all-time, not clipped
    // to the range, since the whole journey is the story).
    drawRatingChart($('#dash-rating-chart'), null);
  }

  // Redraw the visible view's charts at their current on-screen width.
  // (Profile has no charts — nothing to do there.)
  function redrawActiveCharts() {
    if ($('#view-dashboard').classList.contains('is-active')) renderDashCharts();
    else if ($('#view-lifting').classList.contains('is-active')) { renderLiftChart(); renderLiftWeekChart(); }
    else if ($('#view-climbing').classList.contains('is-active')) renderClimbChart();
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawActiveCharts, 150);
  });

  $('#dash-range').addEventListener('change', renderDashboard);

  /* ----- Send Score leaderboard (cross-user, via the climb_send_scores RPC) -----
     The same standings render in two places: the Home panel and the one on
     the climbing page right under the user's own Send Score cards. The two
     discipline selects stay in sync. ----- */
  const LB_PANELS = [
    { panel: '#leaderboard-panel', list: '#leaderboard-list' },
    { panel: '#leaderboard-panel-climb', list: '#leaderboard-list-climb' }
  ];
  const lbSelects = () => ['#lb-discipline', '#lb-discipline-climb'].map((s) => $(s)).filter(Boolean);
  let lbDefaultApplied = false; // auto-pick the user's main discipline group once per load

  async function renderLeaderboard() {
    const panels = LB_PANELS.map((p) => ({ panel: $(p.panel), list: $(p.list) })).filter((p) => p.panel);
    const setHidden = (h) => panels.forEach((p) => { p.panel.hidden = h; });
    if (!cloudOn()) { setHidden(true); return; }
    // Default the filter to whichever scale this user climbs most.
    if (!lbDefaultApplied && state.climbs.length) {
      lbSelects().forEach((sel) => { sel.value = primaryRatingGroup(); });
      lbDefaultApplied = true;
    }
    const grp = $('#lb-discipline').value;
    try {
      const { data, error } = await sb.rpc('climb_send_scores', { grp });
      if (error) throw error;
      setHidden(false);
      const rows = (data || []).slice().sort((a, b) => b.score - a.score).slice(0, 20);
      const html = !rows.length
        ? '<li class="empty">No Send Scores yet — log a session to start yours.</li>'
        : rows.map((r, i) => {
            const d = r.last_delta || 0;
            const delta = d ? `<span class="rating-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>` : '';
            const sub = [
              `${r.sessions} session${r.sessions === 1 ? '' : 's'}`,
              r.hardest ? `hardest ${escapeHTML(r.hardest)}` : ''
            ].filter(Boolean).join(' · ');
            return `
            <li class="${r.is_me ? 'me' : ''}" title="See ${escapeHTML(r.display_name)}'s summary">
              <div class="feed-left">
                <span class="lb-rank${i < 3 ? ' r' + (i + 1) : ''}">${i + 1}</span>
                <div>
                  <div class="feed-main">${escapeHTML(r.display_name)}${r.is_me ? ' <span class="you-chip">You</span>' : ''}</div>
                  <div class="feed-sub">${sub}</div>
                </div>
              </div>
              <div class="lb-grade">${r.score}${delta}</div>
            </li>`;
          }).join('');
      panels.forEach((p) => {
        p.list.innerHTML = html;
        // Row click → per-climber summary (aggregates via climb_user_summary)
        p.list.querySelectorAll('li:not(.empty)').forEach((li, i) => {
          li.addEventListener('click', () => openLbSummary(rows[i]));
        });
      });
    } catch (e) {
      // Function not installed yet, or transient failure — hide quietly.
      console.warn('Leaderboard unavailable:', e);
      setHidden(true);
    }
  }

  lbSelects().forEach((sel) => {
    sel.addEventListener('change', () => {
      lbDefaultApplied = true; // the user's manual choice sticks
      lbSelects().forEach((s) => { s.value = sel.value; }); // both pickers agree
      renderLeaderboard();
    });
  });

  /* ----- Climber summary modal: what a leaderboard entry actually did.
     Same privacy stance as the leaderboard itself — grade-by-grade counts
     only, never locations, notes, dates, or individual climbs. ----- */
  const lbModal = $('#lb-modal');
  $('#lb-close').addEventListener('click', () => { lbModal.hidden = true; });
  lbModal.addEventListener('click', (e) => { if (e.target === lbModal) lbModal.hidden = true; });

  /* ----- "How the Send Score works" explainer (static content) ----- */
  const scoreModal = $('#score-modal');
  $$('.score-info-btn').forEach((btn) => {
    btn.addEventListener('click', () => { scoreModal.hidden = false; });
  });
  $('#score-close').addEventListener('click', () => { scoreModal.hidden = true; });
  scoreModal.addEventListener('click', (e) => { if (e.target === scoreModal) scoreModal.hidden = true; });

  async function openLbSummary(row) {
    const grp = $('#lb-discipline').value;
    const g = RATING_GROUPS.find((x) => x.key === grp);
    $('#lb-name').textContent = row.display_name;
    $('#lb-sub').textContent = `${g.label} · Send Score ${row.score} · all time`;
    const box = $('#lb-summary');
    box.innerHTML = '<div class="chart-empty" style="height:90px">Loading…</div>';
    lbModal.hidden = false;
    try {
      // Whole-history view — the pyramid and sessions never clip to a range.
      const { data, error } = await sb.rpc('climb_user_summary', { target: row.user_id, days: 36500, grp });
      if (error) throw error;
      // Any rope discipline reads grades off the shared YDS scale
      renderLbSummary(box, data, grp === 'boulder' ? 'Bouldering' : 'Sport');
    } catch (e) {
      console.warn('Climber summary unavailable:', e);
      box.innerHTML = `<p class="auth-status err">Couldn't load the summary (${escapeHTML(errMsg(e))}). If this persists, re-run supabase-schema.sql — the summary needs its updated functions.</p>`;
      return;
    }
    // Session-by-session breakdown: my own comes from local state (works
    // offline); anyone else's replayable history comes from the RPC.
    try {
      const isMe = session && row.user_id === session.user.id;
      let hist;
      if (isMe) {
        hist = state.climbs.filter((c) => ratingGroup(c.discipline) === grp);
      } else {
        const { data: rows, error } = await sb.rpc('climb_user_history', { target: row.user_id, grp });
        if (error) throw error;
        hist = rows || [];
      }
      if (hist.length) {
        box.insertAdjacentHTML('beforeend',
          '<h3 class="score-sub">Sessions</h3><div class="sess-list" id="lbs-sessions"></div>');
        renderSessions($('#lbs-sessions'), hist, { pageSize: 8 });
      }
    } catch (e) {
      // History RPC missing (schema not applied yet) or offline — the
      // pyramid above still stands on its own.
      console.warn('Session history unavailable:', e);
    }
  }

  function renderLbSummary(box, data, disc) {
    if (!data) {
      box.innerHTML = '<p class="muted small">Nothing logged yet.</p>';
      return;
    }
    // Collapse per-result rows into per-grade buckets
    const byGrade = {};
    (data.by_grade || []).forEach((g) => {
      const b = (byGrade[g.grade] = byGrade[g.grade] || { sends: 0, flash: 0, project: 0 });
      if (g.result === 'Project') b.project += g.n;
      else {
        b.sends += g.n;
        // 'Onsight' is retired — legacy rows read as flashes
        if (g.result === 'Flash' || g.result === 'Onsight') b.flash += g.n;
      }
    });
    const grades = Object.keys(byGrade).sort((a, b) => gradeRank(disc, b) - gradeRank(disc, a));
    if (!grades.length) {
      box.innerHTML = '<p class="muted small">Nothing logged yet.</p>';
      return;
    }
    const totalSends = grades.reduce((s, g) => s + byGrade[g].sends, 0);
    const totalFlash = grades.reduce((s, g) => s + byGrade[g].flash, 0);
    const hardest = grades.find((g) => byGrade[g].sends > 0);
    const chips = `
      <div class="pr-strip">
        <span class="pr-chip">Hardest <b>${hardest ? escapeHTML(hardest) : '—'}</b></span>
        <span class="pr-chip">Sends <b>${totalSends}</b></span>
        ${totalFlash ? `<span class="pr-chip">Flashes <b>${totalFlash}</b></span>` : ''}
        <span class="pr-chip">Sessions <b>${data.sessions || 0}</b></span>
      </div>`;
    // One wrapping row of pills, hardest grade first: solid pills count
    // sends; dashed muted pills mark grades still being projected.
    const pills = grades.map((g) => {
      const b = byGrade[g];
      const out = [];
      if (b.sends) out.push(`<span class="grade-pill">${escapeHTML(g)}${b.sends > 1 ? ` <i>×${b.sends}</i>` : ''}</span>`);
      if (b.project) out.push(`<span class="grade-pill proj">${escapeHTML(g)} <i>proj${b.project > 1 ? ' ×' + b.project : ''}</i></span>`);
      return out.join('');
    }).join('');
    box.innerHTML = `${chips}<div class="grade-pills">${pills}</div>`;
  }

  // Sessions per week the hero ring fills toward — user-set in Profile.
  function weeklyGoal() {
    const g = parseInt(getSettings().weekly_goal, 10);
    return g >= 1 && g <= 14 ? g : 6;
  }

  // "▲ 8% vs last week" / "▲ 2 vs last week" — mini-card bottom line
  function setMiniDelta(sel, cur, prev, mode) {
    const el = $(sel);
    el.classList.remove('up', 'down');
    if (!cur && !prev) { el.textContent = ''; return; }
    if (!prev) { el.textContent = 'new this week'; el.classList.add('up'); return; }
    const diff = cur - prev;
    if (diff === 0) { el.textContent = '— same as last week'; return; }
    const amount = mode === 'pct' ? `${Math.round(Math.abs(diff) / prev * 100)}%` : fmtNum(Math.abs(diff));
    el.textContent = `${diff > 0 ? '▲' : '▼'} ${amount} vs last week`;
    el.classList.add(diff > 0 ? 'up' : 'down');
  }

  function renderHome() {
    // Home is a climbing dashboard for everyone — sessions, rings, streak,
    // and the feed all come from climbs. Lifting lives on its own page.
    const todayIso = todayISO();
    // Fold any future-dated entries into today — logs stamped with tomorrow's
    // UTC date (before dates went local) still count for rings and the streak.
    const clampDate = (d) => (d > todayIso ? todayIso : d);
    const activeDates = new Set(state.climbs.map((c) => clampDate(c.date)));

    // ----- Week strip: last 7 days ending today -----
    // Ringed days are climbing days; a plain border is a rest day.
    const strip = $('#week-strip');
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push({
        iso,
        dow: d.toLocaleDateString(undefined, { weekday: 'short' }),
        num: d.getDate()
      });
    }
    const ringClass = (iso) => (activeDates.has(iso) ? ' ring-climb' : '');
    strip.innerHTML = days.map((d) => `
      <div class="day${d.iso === todayIso ? ' today' : ''}" title="${d.iso}">
        <span class="dow">${d.dow}</span>
        <span class="dnum${ringClass(d.iso)}">${d.num}</span>
      </div>`).join('');

    // ----- This week (since Monday) vs last week -----
    const wkStart = weekStart(todayIso);
    const prevD = new Date(wkStart + 'T00:00:00');
    prevD.setDate(prevD.getDate() - 7);
    const prevStart = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, '0')}-${String(prevD.getDate()).padStart(2, '0')}`;

    const climbsWk = state.climbs.filter((c) => c.date >= wkStart);
    const climbsPrev = state.climbs.filter((c) => c.date >= prevStart && c.date < wkStart);
    const sessionDates = new Set(climbsWk.map((x) => x.date));

    // Greeting
    const hour = new Date().getHours();
    const tod = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const first = (currentDisplayName() || '').trim().split(/\s+/)[0];
    $('#greeting').textContent = `Good ${tod}${first ? ', ' + first : ''}`;
    const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const goal = weeklyGoal();
    const remaining = Math.max(0, goal - sessionDates.size);
    $('#greeting-sub').textContent = `${dateStr} · ${remaining
      ? `${remaining} session${remaining === 1 ? '' : 's'} to hit your weekly goal`
      : 'weekly goal hit — nice work'}`;

    // Hero: the Send Score (the dashboard's centerpiece)
    renderRatingHero();

    // Sessions-this-week mini (moved off the hero, which now shows the score)
    $('#mini-sessions').textContent = sessionDates.size;
    $('#mini-sessions-sub').textContent = remaining
      ? `${remaining} to goal of ${goal}`
      : `goal of ${goal} hit`;

    // Minis
    const sendsWk = climbsWk.filter((c) => isSend(c.result)).length;
    $('#mini-sends').textContent = sendsWk;
    setMiniDelta('#mini-sends-sub', sendsWk, climbsPrev.filter((c) => isSend(c.result)).length, 'abs');

    // Hardest grade sent this week
    const wkSends = climbsWk.filter((c) => isSend(c.result));
    const wkBoulder = wkSends.filter((c) => c.discipline === 'Bouldering');
    const wkRope = wkSends.filter((c) => ROPE_DISCIPLINES.includes(c.discipline));
    let hv = '—', hsub = '';
    if (wkBoulder.length) {
      hv = V_GRADES[Math.max(...wkBoulder.map((c) => gradeRank('Bouldering', c.grade)))]; hsub = 'Bouldering';
    } else if (wkRope.length) {
      hv = YDS_GRADES[Math.max(...wkRope.map((c) => gradeRank(c.discipline, c.grade)))]; hsub = 'Roped';
    }
    $('#mini-hardest').textContent = hv;
    $('#mini-hardest-sub').textContent = hsub;

    // ----- Day streak: session days in a row, ending now -----
    // A single rest day between sessions keeps the chain alive; two missed
    // days in a row break it. Today doesn't count against you until it's over.
    let streak = 0;
    let misses = 0;
    const cursor = new Date();
    if (!activeDates.has(todayIso)) cursor.setDate(cursor.getDate() - 1); // grace: today isn't over yet
    while (misses < 2) {
      if (activeDates.has(isoOf(cursor))) { streak++; misses = 0; }
      else { misses++; }
      cursor.setDate(cursor.getDate() - 1);
    }
    $('#streak-count').textContent = streak;
    $('#streak-pill').hidden = streak === 0; // no sad "🔥 0" for new climbers

    // ----- Sessions: the full climb history, grouped by day -----
    renderSessions($('#recent-feed'), state.climbs);
  }

  /* ======================================================================
     Session lists — climbs grouped by day, expandable to the individual
     climbs with each one's exact Send Score contribution. One component,
     used on Home, the climbing History panel, and the climber summary.
     ====================================================================== */
  // Display points per climb via cumulative rounding, so the visible climb
  // values in a session always sum exactly to the session's shown change.
  function climbPoints(allClimbs) {
    const pts = {};
    ['boulder', 'rope'].forEach((g) => {
      scoreBreakdown(allClimbs, g).sessions.forEach((sess) => {
        let cum = 0, shown = 0;
        sess.climbs.forEach((d) => {
          cum += d.delta;
          const c2 = Math.round(cum);
          pts[d.id] = { group: g, pts: c2 - shown };
          shown = c2;
        });
      });
    });
    return pts;
  }

  // Group climbs into sessions (newest first). Scoring always replays
  // allClimbs (the full history), even when the displayed list is filtered.
  function sessionizeClimbs(climbs, allClimbs) {
    const pts = climbPoints(allClimbs || climbs);
    const byDate = {};
    climbs.forEach((c) => { (byDate[c.date] = byDate[c.date] || []).push(c); });
    return Object.keys(byDate).sort().reverse().map((date) => {
      const list = byDate[date].slice().sort((a, b) =>
        (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
      const deltas = {};
      let hb = -1, hr = -1; // hardest send rank per scale
      list.forEach((c) => {
        const p = pts[c.id];
        if (p) deltas[p.group] = (deltas[p.group] || 0) + p.pts;
        if (isSend(c.result)) {
          const rk = gradeRank(c.discipline, c.grade);
          if (c.discipline === 'Bouldering') { if (rk > hb) hb = rk; }
          else if (rk > hr) hr = rk;
        }
      });
      const hardest = [hb >= 0 ? V_GRADES[hb] : null, hr >= 0 ? YDS_GRADES[hr] : null]
        .filter(Boolean).join(' · ');
      return { date, climbs: list, deltas, hardest, pts };
    });
  }

  const deltaChip = (v, label) => {
    const cls = v > 0 ? 'up' : v < 0 ? 'down' : '';
    const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '·';
    return `<span class="rating-delta ${cls}">${label ? label + ' ' : ''}${arrow} ${Math.abs(v)}</span>`;
  };

  // The shared session-list component.
  // opts: { editable, pageSize, allClimbs, emptyMsg }
  function renderSessions(el, climbs, opts = {}) {
    if (!el) return;
    const pageSize = opts.pageSize || 10;
    // Expansion + pagination state live on the element, surviving re-renders.
    const st = (el.__sess = el.__sess || { shown: pageSize, open: new Set() });
    const sessions = sessionizeClimbs(climbs, opts.allClimbs);
    if (!sessions.length) {
      el.innerHTML = `<div class="empty">${opts.emptyMsg || 'Tap ＋ to log your first climb.'}</div>`;
      return;
    }
    const visible = sessions.slice(0, st.shown);
    el.innerHTML = visible.map((s) => {
      const both = Object.keys(s.deltas).length > 1;
      const chips = ['boulder', 'rope']
        .filter((g) => s.deltas[g] !== undefined)
        .map((g) => deltaChip(s.deltas[g], both ? (g === 'boulder' ? 'B' : 'R') : ''))
        .join(' ');
      const open = st.open.has(s.date);
      const rows = s.climbs.map((c) => {
        const p = s.pts[c.id];
        const resClass = isSend(c.result) ? 'send' : 'project';
        const extra = opts.editable ? [c.location, c.notes].filter(Boolean).join(' · ') : '';
        return `
        <div class="sess-climb" data-id="${escapeHTML(String(c.id))}">
          <div class="sc-main">
            <div class="sc-head">${opts.editable ? routeDot(c.color) : ''}<span class="sc-grade">${escapeHTML(c.grade)}</span><span class="badge ${resClass}">${escapeHTML(c.result)}</span>${(Number(c.attempts) || 1) > 1 ? `<span class="sc-att">${Number(c.attempts)} tries</span>` : ''}</div>
            ${extra ? `<div class="sc-meta">${escapeHTML(extra)}</div>` : ''}
          </div>
          <span class="sc-pts ${p && p.pts > 0 ? 'up' : p && p.pts < 0 ? 'down' : ''}">${p ? (p.pts >= 0 ? '+' : '') + p.pts : ''}</span>
          ${opts.editable ? `
          <span class="row-actions">
            <button class="edit-btn" title="Edit" aria-label="Edit"><svg class="ico"><use href="#i-pencil"/></svg></button>
            <button class="del-btn" title="Delete" aria-label="Delete"><svg class="ico"><use href="#i-x"/></svg></button>
          </span>` : ''}
        </div>`;
      }).join('');
      return `
      <div class="sess" data-date="${s.date}">
        <button type="button" class="sess-row" aria-expanded="${open}">
          <span class="sess-chev">${open ? '▾' : '▸'}</span>
          <span class="sess-main">
            <span class="feed-main">${fmtDate(s.date)}</span>
            <span class="feed-sub">${s.climbs.length} climb${s.climbs.length === 1 ? '' : 's'}${s.hardest ? ' · hardest ' + escapeHTML(s.hardest) : ''}</span>
          </span>
          <span class="sess-delta">${chips}</span>
        </button>
        <div class="sess-climbs" ${open ? '' : 'hidden'}>${rows}</div>
      </div>`;
    }).join('') + (sessions.length > st.shown
      ? `<button type="button" class="btn ghost sm sess-more">Show ${Math.min(pageSize, sessions.length - st.shown)} more session${sessions.length - st.shown === 1 ? '' : 's'}</button>`
      : '');

    el.querySelectorAll('.sess-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = btn.closest('.sess').dataset.date;
        if (st.open.has(d)) st.open.delete(d); else st.open.add(d);
        renderSessions(el, climbs, opts);
      });
    });
    const more = el.querySelector('.sess-more');
    if (more) more.addEventListener('click', () => { st.shown += pageSize; renderSessions(el, climbs, opts); });

    if (opts.editable) {
      el.querySelectorAll('.sess-climb').forEach((row) => {
        const c = climbs.find((x) => String(x.id) === row.dataset.id);
        if (!c) return;
        row.querySelector('.edit-btn').addEventListener('click', () => openEditClimb(c));
        row.querySelector('.del-btn').addEventListener('click', () => {
          withSync(async () => {
            await Store.delClimb(c.id);
            renderClimbing(); renderDashboard();
          });
        });
      });
    }
  }

  /* ======================================================================
     Multi-series SVG line chart
     series: [{ label, points: [{date, value}] }] — dates form a shared x axis.
     ====================================================================== */
  const CHART_COLORS = ['#16181d', '#f59e2c', '#1f3a5f', '#3a7d44', '#b9741f', '#85806f'];

  // Weekly bar chart (dashboard lifting volume): muted sand bars, the current
  // week highlighted orange with its value labeled above.
  function drawBars(wrap, points, fmtValue) {
    const max = points.length ? Math.max(...points.map((p) => p.value)) : 0;
    if (max <= 0) {
      wrap.innerHTML = '<div class="chart-empty">No data yet.</div>';
      return;
    }
    const measured = Math.round(wrap.getBoundingClientRect().width);
    const W = measured >= 200 ? measured : 640;
    const H = 210, padT = 28, padB = 24, padX = 6;
    const baseY = H - padB;
    const n = points.length;
    const slot = (W - padX * 2) / n;
    const barW = Math.min(34, slot * 0.6);
    const cx = (i) => padX + slot * i + slot / 2;
    const bars = points.map((p, i) => {
      const x = padX + slot * i + (slot - barW) / 2;
      // Empty weeks get a faint baseline stub so the timeline reads as
      // continuous rather than "missing bars".
      if (p.value <= 0) {
        return `<rect x="${x.toFixed(1)}" y="${(baseY - 3).toFixed(1)}" width="${barW.toFixed(1)}" height="3" rx="1.5" fill="var(--hairline)"><title>Week of ${fmtDateShort(p.date)}: none</title></rect>`;
      }
      const h = Math.max(3, (p.value / max) * (baseY - padT));
      const y = baseY - h;
      const last = i === n - 1;
      const label = last
        ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#b9741f" font-family="Space Grotesk, Archivo, sans-serif">${fmtCompact(p.value)}</text>`
        : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(7, barW / 2)}" fill="${last ? '#f59e2c' : '#e2d9c4'}"><title>Week of ${fmtDateShort(p.date)}: ${fmtValue(p.value)}</title></rect>${label}`;
    }).join('');
    // X-axis: first / middle / last week so a 12-week span is legible.
    const labelIdx = n <= 1 ? [0] : [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    const xLabels = labelIdx.map((i) =>
      `<text class="chart-label" x="${cx(i).toFixed(1)}" y="${H - 7}" text-anchor="middle">${fmtDateShort(points[i].date)}</text>`
    ).join('');
    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly volume chart">
        <line class="chart-base" x1="0" y1="${baseY}" x2="${W}" y2="${baseY}"/>
        ${bars}
        ${xLabels}
      </svg>`;
  }

  // Rounded gridline values ("nice numbers") spanning a data range.
  function niceTicks(lo, hi, count) {
    if (lo === hi) return [lo];
    const rawStep = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }

  function drawChart(wrap, series, fmtValue) {
    series = series.filter((s) => s.points.length);
    if (!series.length) {
      wrap.innerHTML = '<div class="chart-empty">No data yet.</div>';
      return;
    }

    const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
    const xi = new Map(dates.map((d, i) => [d, i]));
    const values = series.flatMap((s) => s.points.map((p) => p.value));
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    let min = dataMin, max = dataMax;
    if (min === max) { min -= 1; max += 1; }
    const vpad = (max - min) * 0.1;
    min -= vpad; max += vpad;

    // Draw at the wrap's real pixel width so nothing stretches (a fixed
    // viewBox scaled to 100% width distorted dots and text on desktop).
    // Hidden views measure 0 — fall back and let redrawActiveCharts() fix
    // it when the view becomes visible.
    const measured = Math.round(wrap.getBoundingClientRect().width);
    const W = measured >= 200 ? measured : 640;
    const H = 200, padL = 46, padR = 14, padT = 14, padB = 28;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = dates.length;
    const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v) => padT + innerH - ((v - min) / (max - min)) * innerH;

    // "Nice" rounded gridline values over the real data range (no more
    // 1,299 / 1,165 oddities — proper 1,300 / 1,150 / 1,000 stops).
    const ticks = niceTicks(dataMin, dataMax, 3).filter((t) => t >= min && t <= max);
    const yTicks = ticks.map((t) =>
      `<line class="chart-axis" x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}"/>
       <text class="chart-label" x="${padL - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmtValue(t)}</text>`
    ).join('');
    const baseline = `<line class="chart-base" x1="${padL}" y1="${(padT + innerH).toFixed(1)}" x2="${W - padR}" y2="${(padT + innerH).toFixed(1)}"/>`;

    const idxs = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    const xLabels = [...new Set(idxs)].map((i) =>
      `<text class="chart-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtDateShort(dates[i])}</text>`
    ).join('');

    const colorOf = (s, si) => s.color || CHART_COLORS[si % CHART_COLORS.length];

    const seriesSvg = series.map((s, si) => {
      const color = colorOf(s, si);
      const pts = s.points.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(xi.get(p.date)).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
      // Invisible per-point hover targets keep the tooltips; only the line's
      // end gets a visible dot (design: end-point dots).
      const hovers = pts.map((p) =>
        `<circle cx="${x(xi.get(p.date)).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="8" fill="transparent"><title>${escapeHTML(s.label)} — ${fmtDateShort(p.date)}: ${fmtValue(p.value)}</title></circle>`
      ).join('');
      const end = pts[pts.length - 1];
      const ex = x(xi.get(end.date)), ey = y(end.value);
      // A one-point series has no line to anchor the dot — give it a ringed
      // marker and an inline value label so it reads as data, not a stray dot.
      if (pts.length === 1) {
        const lx = Math.min(ex + 10, W - padR - 34);
        return `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="6" fill="${color}"/>
          <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="10" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.4"/>
          <text class="chart-point-label" x="${lx.toFixed(1)}" y="${(ey - 10).toFixed(1)}" fill="${color}">${fmtValue(end.value)}</text>
          <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="12" fill="transparent"><title>${escapeHTML(end.label)} — ${fmtDateShort(end.date)}: ${fmtValue(end.value)}</title></circle>`;
      }
      const endDot = `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5" fill="${color}"/>`;
      // A soft area fill under the line adds depth (single-series only —
      // stacked fills would muddy a multi-line chart).
      let area = '';
      if (series.length === 1) {
        const fx = x(xi.get(pts[0].date));
        const fillId = 'cfill' + si;
        area = `<defs><linearGradient id="${fillId}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="${color}" stop-opacity="0.16"/>
            <stop offset="1" stop-color="${color}" stop-opacity="0"/>
          </linearGradient></defs>
          <path d="${path} L${ex.toFixed(1)},${(padT + innerH).toFixed(1)} L${fx.toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="url(#${fillId})" stroke="none"/>`;
      }
      return `${area}<path d="${path}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>${hovers}${endDot}`;
    }).join('');

    const legend = series.length > 1
      ? `<div class="chart-legend">${series.map((s, si) =>
          `<span class="legend-item"><span class="legend-dot" style="background:${colorOf(s, si)}"></span>${escapeHTML(s.label)}</span>`
        ).join('')}</div>`
      : '';

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart">
        ${yTicks}
        ${baseline}
        ${seriesSvg}
        ${xLabels}
      </svg>${legend}`;
  }

  /* ----- Unit + time helpers for progress metrics ----- */
  function dominantUnit() {
    const pref = getSettings().unit;
    if (pref === 'lbs' || pref === 'kg') return pref;
    return mostCommon(state.lifts.map((l) => l.unit)) || 'lbs';
  }
  function toUnit(w, from, to) {
    if (from === to) return w;
    return from === 'kg' ? w * 2.20462 : w / 2.20462;
  }
  function weekStart(iso) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  function daysAgoISO(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return isoOf(d); // local calendar date, not UTC
  }
  const fmtCompact = (n) => Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });

  /* ======================================================================
     Export / Import / Reset
     ====================================================================== */
  $('#export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ lifts: state.lifts, climbs: state.climbs, routines: state.routines }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gymtrack-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
        if (!Array.isArray(data.lifts) || !Array.isArray(data.climbs)) throw new Error('bad format');
      } catch (err) {
        alert('Could not import: the file is not a valid GymTrack export.');
        return;
      }
      withSync(async () => {
        await Store.importData(data);
        renderAll();
      });
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#reset-btn').addEventListener('click', () => {
    const scope = cloudOn() ? 'your account' : 'this browser';
    if (!confirm(`Delete ALL logged data from ${scope}? This cannot be undone.`)) return;
    withSync(async () => {
      await Store.resetAll();
      renderAll();
    });
  });

  /* ======================================================================
     Auth UI + sign-in gate
     ====================================================================== */
  const accountEl = $('#account');
  const gate = $('#gate');
  const authForm = $('#auth-form');
  const authStatus = $('#auth-status');
  let namePrompted = false;

  /* ----- User settings (display name, weekly goal, units, avatar color) -----
     Signed in: stored on the account in user_metadata, so they follow you
     across devices. Local mode: stored in this browser. */
  const SETTINGS_KEY = 'gymtrack.settings.v1';
  function getSettings() {
    if (session && session.user) return session.user.user_metadata || {};
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }
  async function saveSettings(patch) {
    if (cloudOn()) {
      const { error } = await sb.auth.updateUser({ data: patch });
      if (error) throw error;
      session.user.user_metadata = Object.assign({}, session.user.user_metadata, patch);
    } else {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign({}, getSettings(), patch)));
    }
  }

  // Strip leftover auth tokens/errors from the address bar. Supabase puts the
  // session in the URL hash on magic-link redirects; if a stale hash survives
  // into a reload, the client re-parses an expired token and auth misbehaves.
  // Only call this after the client has finished its URL detection.
  function cleanAuthHash() {
    const h = location.hash || '';
    if (h === '#' || /[#&](access_token|refresh_token|expires_in|expires_at|token_type|type|error|error_code|error_description|code)=/.test(h)) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  // Drop the boot splash and reveal whatever is underneath (gate or app).
  // Called synchronously right before a render, so the reveal and the first
  // painted frame of real data happen together — no flash of empty defaults.
  function revealApp() {
    document.body.classList.remove('booting');
  }

  // Show only the gate when Supabase is configured and nobody is signed in.
  // Signed-out visitors reveal immediately (the gate needs no data); signed-in
  // visitors keep the splash until refresh() has loaded and rendered.
  function applyGate() {
    const gated = CONFIGURED && !session;
    document.body.classList.toggle('auth-gated', gated);
    gate.hidden = !gated;
    if (gated) revealApp();
    // A failed magic link (expired / already used) redirects here with the
    // error in the hash — explain it instead of showing a blank gate.
    if (gated && authHashError) {
      authStatus.className = 'auth-status err';
      authStatus.textContent = `Sign-in link problem: ${authHashError}. Request a new link below.`;
      authHashError = null;
    }
    // A code was requested before a reload — reopen the code box so pasting
    // it still works (the pending email is restored from localStorage).
    if (gated && pendingAuthEmail) {
      $('#otp-form').hidden = false;
      $('#auth-email').value = $('#auth-email').value || pendingAuthEmail;
    }
  }

  // Send the sign-in email (gate form). The email carries both a link (fine
  // in a normal browser) and a 6-digit code — the code is what works inside
  // the installed app, where email links would open Safari's separate session.
  // The pending email survives a reload (people often close the app while
  // fetching the code from their mail client) so the code still verifies.
  const PENDING_EMAIL_KEY = 'gymtrack.pending_email';
  let pendingAuthEmail = null;
  try { pendingAuthEmail = localStorage.getItem(PENDING_EMAIL_KEY) || null; } catch (e) { /* ignore */ }
  function setPendingAuthEmail(email) {
    pendingAuthEmail = email;
    try {
      if (email) localStorage.setItem(PENDING_EMAIL_KEY, email);
      else localStorage.removeItem(PENDING_EMAIL_KEY);
    } catch (e) { /* ignore */ }
  }
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    if (!email) return;
    const submit = $('#auth-submit');
    submit.disabled = true;
    authStatus.className = 'auth-status';
    authStatus.textContent = 'Sending…';
    try {
      const redirectTo = location.href.split('#')[0].split('?')[0];
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
      if (error) throw error;
      setPendingAuthEmail(email);
      $('#otp-form').hidden = false;
      authStatus.className = 'auth-status ok';
      authStatus.textContent = 'Check your email — enter the 6-digit code here (or tap the link if you\'re in a browser).';
      setTimeout(() => $('#otp-token').focus(), 50);
    } catch (err) {
      console.error('Sign-in error:', err);
      authStatus.className = 'auth-status err';
      authStatus.textContent = 'Error: ' + errMsg(err);
    } finally {
      submit.disabled = false;
    }
  });

  // Verify the emailed code — signs in right here, no browser round-trip.
  // Accepts whatever the email template renders: the 6-digit {{ .Token }},
  // the long {{ .TokenHash }}, or the entire pasted sign-in link.
  $('#otp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let raw = $('#otp-token').value.trim().replace(/\s+/g, '');
    if (!raw) return;
    try {
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        raw = u.searchParams.get('token') || raw; // ConfirmationURL carries the token hash
      }
    } catch (x) { /* not a URL — treat as a code */ }
    const isDigits = /^\d{6,10}$/.test(raw); // OTP length is configurable (6–10 digits)
    if (isDigits && !pendingAuthEmail) {
      // A code only verifies against the email it was sent to, and we no
      // longer know it — say so instead of silently ignoring the submit.
      authStatus.className = 'auth-status err';
      authStatus.textContent = 'Enter your email above and send a new code first — a code only works with the email it was sent to.';
      return;
    }
    // A pasted token hash could have been minted as any of these kinds
    // depending on the email template / whether the account is new.
    const attempts = isDigits
      ? [{ email: pendingAuthEmail, token: raw, type: 'email' }]
      : [
          { token_hash: raw, type: 'email' },
          { token_hash: raw, type: 'magiclink' },
          { token_hash: raw, type: 'signup' }
        ];
    const submit = $('#otp-submit');
    submit.disabled = true;
    authStatus.className = 'auth-status';
    authStatus.textContent = 'Checking…';
    let lastErr = null;
    try {
      for (const payload of attempts) {
        const { error } = await sb.auth.verifyOtp(payload);
        if (!error) { lastErr = null; break; }
        lastErr = error;
        console.warn('verifyOtp attempt failed:', payload.type, errMsg(error));
      }
      if (lastErr) throw lastErr;
      // Success fires onAuthStateChange(SIGNED_IN), which un-gates the app.
      setPendingAuthEmail(null);
      $('#otp-form').hidden = true;
      $('#otp-token').value = '';
      authStatus.textContent = '';
    } catch (err) {
      console.error('Code verify error:', err);
      authStatus.className = 'auth-status err';
      authStatus.textContent = `That code didn't work (${errMsg(err)}). Codes are single-use and only the newest email counts — request a fresh code, don't tap the email's link, and paste the new code here.`;
    } finally {
      submit.disabled = false;
    }
  });

  function currentDisplayName() {
    return getSettings().display_name || '';
  }

  function renderAccount() {
    applyLiftingMode(); // owner sees weightlifting; everyone else gets climbing-only
    const signedIn = CONFIGURED && !!session;
    if (!signedIn) { accountEl.hidden = true; accountEl.innerHTML = ''; return; }
    accountEl.hidden = false;
    const label = currentDisplayName() || session.user.email || 'Account';
    const initial = (label.trim()[0] || '?').toUpperCase();
    const color = AVATAR_COLORS[getSettings().avatar_color] || AVATAR_COLORS.Navy;
    // Colored circle avatar with the user's initial; opens the Profile page.
    accountEl.innerHTML = `
      <span class="sync-dot" id="sync-dot" title="Synced"></span>
      <button class="avatar" id="profile-btn" style="background:${color}" title="${escapeHTML(label)} — profile" aria-label="Profile">${escapeHTML(initial)}</button>`;
    const btn = $('#profile-btn');
    btn.addEventListener('click', () => showView('profile'));
    btn.classList.toggle('is-active', $('#view-profile').classList.contains('is-active'));
  }

  /* ======================================================================
     Profile page — identity, lifetime stats, achievements, settings
     ====================================================================== */
  const AVATAR_COLORS = {
    'Navy': '#1f3a5f', 'Orange': '#f59e2c', 'Green': '#3a7d44', 'Purple': '#8b5cf6',
    'Pink': '#ec6aa0', 'Red': '#d64545', 'Blue': '#3b82c4', 'Ink': '#16181d'
  };

  // Longest run of session days, where a single rest day keeps the chain
  // alive — the same rule as the header streak, over all history.
  function longestStreak() {
    const dates = [...new Set([...state.lifts, ...state.climbs].map((x) => x.date))].sort();
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

  function profileStats() {
    const unit = dominantUnit();
    const sessions = new Set([...state.lifts, ...state.climbs].map((x) => x.date)).size;
    const volume = state.lifts.reduce((s, l) => s + toUnit(l.weight, l.unit, unit) * l.sets * l.reps, 0);
    const sendsArr = state.climbs.filter((c) => isSend(c.result));
    const boulderRank = Math.max(-1, ...sendsArr.filter((c) => c.discipline === 'Bouldering').map((c) => gradeRank('Bouldering', c.grade)));
    const routeRank = Math.max(-1, ...sendsArr.filter((c) => ROPE_DISCIPLINES.includes(c.discipline)).map((c) => gradeRank(c.discipline, c.grade)));
    const liftDates = new Set(state.lifts.map((l) => l.date));
    const doubleDay = state.climbs.some((c) => liftDates.has(c.date));
    return {
      unit, sessions, volume, sends: sendsArr.length,
      boulderRank, routeRank,
      hardestBoulder: boulderRank >= 0 ? V_GRADES[boulderRank] : null,
      hardestRoute: routeRank >= 0 ? YDS_GRADES[routeRank] : null,
      longest: longestStreak(), doubleDay
    };
  }

  const ACHIEVEMENTS = [
    { id: 'first', name: 'First Entry', desc: 'Log your first set or climb', icon: 'star', earned: (s) => s.sessions >= 1 },
    { id: 'double', name: 'Double Day', desc: 'Lift and climb on the same day', icon: 'bolt', earned: (s) => s.doubleDay },
    { id: 's10', name: 'Regular', desc: '10 sessions', icon: 'calendar', earned: (s) => s.sessions >= 10, progress: (s) => `${s.sessions}/10 sessions` },
    { id: 's50', name: 'Committed', desc: '50 sessions', icon: 'medal', earned: (s) => s.sessions >= 50, progress: (s) => `${s.sessions}/50 sessions` },
    { id: 's100', name: 'Century Club', desc: '100 sessions', icon: 'trophy', earned: (s) => s.sessions >= 100, progress: (s) => `${s.sessions}/100 sessions` },
    { id: 'streak7', name: 'One Week Strong', desc: '7-day streak', icon: 'flame', earned: (s) => s.longest >= 7, progress: (s) => `best ${s.longest}/7 days` },
    { id: 'streak30', name: 'Unstoppable', desc: '30-day streak', icon: 'bolt', earned: (s) => s.longest >= 30, progress: (s) => `best ${s.longest}/30 days` },
    { id: 'v100k', name: '100k Club', desc: '100,000 lifted, lifetime', icon: 'barbell', earned: (s) => s.volume >= 100000, progress: (s) => `${fmtCompact(s.volume)}/100K ${s.unit}` },
    { id: 'v1m', name: 'Million Mover', desc: '1,000,000 lifted, lifetime', icon: 'medal', earned: (s) => s.volume >= 1000000, progress: (s) => `${fmtCompact(s.volume)}/1M ${s.unit}` },
    { id: 'send1', name: 'First Send', desc: 'Top out your first climb', icon: 'mountain', earned: (s) => s.sends >= 1 },
    { id: 'send50', name: 'Sender', desc: '50 sends', icon: 'mountain', earned: (s) => s.sends >= 50, progress: (s) => `${s.sends}/50 sends` },
    { id: 'v5', name: 'V5 Club', desc: 'Send V5 or harder', icon: 'medal', earned: (s) => s.boulderRank >= V_GRADES.indexOf('V5') },
    { id: 'v8', name: 'V8 Club', desc: 'Send V8 or harder', icon: 'trophy', earned: (s) => s.boulderRank >= V_GRADES.indexOf('V8') },
    { id: 'r511', name: '5.11 Club', desc: 'Send 5.11a or harder', icon: 'medal', earned: (s) => s.routeRank >= YDS_GRADES.indexOf('5.11a') },
    { id: 'r512', name: '5.12 Club', desc: 'Send 5.12a or harder', icon: 'trophy', earned: (s) => s.routeRank >= YDS_GRADES.indexOf('5.12a') }
  ];

  const statCard = (label, value, unit) =>
    `<div class="stat-card"><span class="stat-label">${label}</span><span class="stat-value">${value}${unit ? ` <span class="unit">${unit}</span>` : ''}</span></div>`;

  function renderProfile() {
    const s = profileStats();
    const settings = getSettings();

    // Identity
    const name = currentDisplayName();
    const label = name || (session && session.user && session.user.email) || 'Athlete';
    const ava = $('#profile-ava');
    ava.textContent = (label.trim()[0] || '?').toUpperCase();
    ava.style.background = AVATAR_COLORS[settings.avatar_color] || AVATAR_COLORS.Navy;
    if (document.activeElement !== $('#profile-name')) $('#profile-name').value = name;
    const meta = [];
    if (session && session.user) {
      if (session.user.email) meta.push(session.user.email);
      if (session.user.created_at) {
        meta.push('Member since ' + new Date(session.user.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
      }
    } else {
      meta.push('Local mode — data lives in this browser');
    }
    $('#profile-meta').textContent = meta.join(' · ');
    $('#modal-signout').hidden = !(CONFIGURED && session);

    // Lifetime stats (Volume lifted only when weightlifting is on)
    const lifting = liftingEnabled();
    $('#profile-stats').innerHTML = [
      statCard('Sessions', s.sessions),
      lifting ? statCard('Volume lifted', s.volume ? fmtCompact(s.volume) : '0', s.unit) : '',
      statCard('Sends', s.sends),
      statCard('Hardest boulder', s.hardestBoulder || '—'),
      statCard('Hardest route', s.hardestRoute || '—'),
      statCard('Longest streak', s.longest, s.longest === 1 ? 'day' : 'days')
    ].join('');

    // Climber rating cards (climbing page + profile)
    renderClimberRating();

    // Controls reflect current settings
    $('#pref-goal').value = String(weeklyGoal());
    $('#pref-unit').value = settings.unit === 'lbs' || settings.unit === 'kg' ? settings.unit : '';
    $('#pref-rating').checked = !settings.hide_rating;
    $$('#pref-colors .color-swatch').forEach((b) => {
      b.setAttribute('aria-pressed', String((settings.avatar_color || 'Navy') === b.dataset.color));
    });

    // Achievements (drop lifting-only badges when weightlifting is off)
    const LIFT_ACH = new Set(['v100k', 'v1m', 'double']);
    const achList = lifting ? ACHIEVEMENTS : ACHIEVEMENTS.filter((a) => !LIFT_ACH.has(a.id));
    const earned = achList.filter((a) => a.earned(s)).length;
    $('#ach-count').textContent = `${earned} of ${achList.length} earned`;
    $('#badge-grid').innerHTML = achList.map((a) => {
      const ok = a.earned(s);
      return `
        <div class="badge-card${ok ? '' : ' locked'}" title="${escapeHTML(a.desc)}">
          <span class="b-ico"><svg class="ico"><use href="#i-${a.icon}"/></svg></span>
          <div>
            <div class="b-name">${a.name}</div>
            <div class="b-desc">${ok ? a.desc : (a.progress ? a.progress(s) : a.desc)}</div>
          </div>
        </div>`;
    }).join('');
  }

  // Save a setting, then repaint everything it can touch.
  function applySetting(patch) {
    withSync(async () => {
      await saveSettings(patch);
      renderAccount();
      renderAll();
    });
  }

  (function buildAvatarColorRow() {
    const row = $('#pref-colors');
    Object.keys(AVATAR_COLORS).forEach((cName) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.style.background = AVATAR_COLORS[cName];
      btn.dataset.color = cName;
      btn.title = cName;
      btn.setAttribute('aria-label', cName);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => applySetting({ avatar_color: cName }));
      row.appendChild(btn);
    });
  })();

  $('#pref-goal').addEventListener('change', () => applySetting({ weekly_goal: parseInt($('#pref-goal').value, 10) }));
  $('#pref-unit').addEventListener('change', () => applySetting({ unit: $('#pref-unit').value }));
  $('#pref-rating').addEventListener('change', () => applySetting({ hide_rating: !$('#pref-rating').checked }));

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#profile-name').value.trim();
    const submit = $('#profile-submit');
    const status = $('#profile-status');
    submit.disabled = true;
    status.className = 'auth-status';
    status.textContent = 'Saving…';
    try {
      await saveSettings({ display_name: name });
      status.className = 'auth-status ok';
      status.textContent = 'Saved.';
      setTimeout(() => { if (status.textContent === 'Saved.') status.textContent = ''; }, 1600);
      renderAccount();
      renderHome();
      renderProfile();
    } catch (err) {
      console.error('Save name error:', err);
      status.className = 'auth-status err';
      status.textContent = 'Error: ' + errMsg(err);
    } finally {
      submit.disabled = false;
    }
  });

  $('#modal-signout').addEventListener('click', async () => {
    if (sb) await sb.auth.signOut();
  });

  /* ----- One-time "What's new" popup -----
     Shown once per release id, then never again: the seen flag lives in
     localStorage (this device) and, when signed in, in user_metadata too —
     so dismissing it on your phone also silences it on your laptop. */
  const WHATS_NEW_VERSION = '2026-07-15';
  const WHATS_NEW_KEY = 'gymtrack.whatsnew';
  let whatsNewShownThisLoad = false;

  function whatsNewSeen() {
    return localStorage.getItem(WHATS_NEW_KEY) === WHATS_NEW_VERSION ||
      getSettings().whatsnew_seen === WHATS_NEW_VERSION;
  }
  function dismissWhatsNew() {
    $('#whatsnew-modal').hidden = true;
    localStorage.setItem(WHATS_NEW_KEY, WHATS_NEW_VERSION);
    if (cloudOn()) saveSettings({ whatsnew_seen: WHATS_NEW_VERSION }).catch(() => {});
  }
  function maybeShowWhatsNew() {
    if (whatsNewShownThisLoad || whatsNewSeen()) return;
    if (document.body.classList.contains('auth-gated')) return;
    if (namePrompted) return; // first-sign-in onboarding wins; popup next visit
    // Brand-new users skip it — everything is new to them anyway.
    if (!state.lifts.length && !state.climbs.length && !state.routines.length) return;
    whatsNewShownThisLoad = true;
    $('#whatsnew-modal').hidden = false;
  }
  $('#wn-done').addEventListener('click', dismissWhatsNew);
  $('#wn-close').addEventListener('click', dismissWhatsNew);
  $('#whatsnew-modal').addEventListener('click', (e) => { if (e.target === $('#whatsnew-modal')) dismissWhatsNew(); });

  // On first sign-in with no name yet, land on Profile to set one.
  function maybePromptName() {
    if (namePrompted) return;
    if (session && !currentDisplayName()) {
      namePrompted = true;
      showView('profile');
      setTimeout(() => $('#profile-name').focus(), 300);
    }
  }

  function setSync(busy) {
    const dot = $('#sync-dot');
    if (dot) dot.classList.toggle('busy', !!busy);
  }

  /* ======================================================================
     Boot
     ====================================================================== */
  function renderAll() {
    renderDashboard();
    renderLifting();
    renderClimbing();
    renderProfile();
  }

  async function refresh() {
    setSync(true);
    try {
      await Store.load();
    } catch (e) {
      console.error('Load error:', e);
      alert(isNetErr(e)
        ? "You're offline and this device has no synced copy of your data yet — connect once to download it."
        : 'Could not load data: ' + errMsg(e));
    } finally {
      setSync(false);
    }
    // Reveal and render in the same task: the browser paints the app for the
    // first time already filled with data (and charts measure real widths).
    revealApp();
    renderAll();
    maybeShowWhatsNew();
    flushQueue(); // push anything logged while offline
  }

  async function boot() {
    // PWA: cache the app shell so it opens instantly (and fully offline).
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker unavailable:', e));
    }
    if (sb) {
      // React to sign-in / sign-out / profile updates
      sb.auth.onAuthStateChange(async (event, newSession) => {
        session = newSession;
        applyGate();
        if (event === 'SIGNED_IN') {
          cleanAuthHash(); // tokens are consumed by now; drop them from the URL
          setPendingAuthEmail(null); // signed in — the outstanding code is moot
          await maybeMigrate();
          maybePromptName();
        }
        renderAccount();
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
          await refresh();
        }
      });

      // getSession() awaits client initialization, which includes consuming
      // any auth tokens from the URL — safe to clean the hash after it.
      const { data } = await sb.auth.getSession();
      session = data.session;
      cleanAuthHash();
      applyGate();
      renderAccount();
      await refresh();
    } else {
      // Supabase not configured — run in local-only mode (no gate).
      cleanAuthHash();
      applyGate();
      renderAccount();
      await refresh();
    }
  }

  boot();
})();
