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

  // Replay one queued op against Supabase (throws on failure).
  async function applyOp(op) {
    const table = op.table;
    const rowMap = { lifts: liftRow, climbs: climbRow, routines: routineRow }[table];
    const fromMap = { lifts: fromLift, climbs: fromClimb, routines: fromRoutine }[table];
    if (op.kind === 'add') {
      const { data, error } = await sb.from(table).insert(rowMap(op.entry)).select().single();
      if (error) throw error;
      // Swap the optimistic temp row for the real one
      const arr = state[table];
      const i = arr.findIndex((x) => x.id === op.tempId);
      if (i !== -1) arr[i] = fromMap(data); else arr.push(fromMap(data));
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
    const q = loadQueue();
    if (!q || q.userId !== session.user.id || !q.ops.length) return;
    flushing = true;
    let applied = false;
    try {
      while (q.ops.length) {
        try {
          await applyOp(q.ops[0]);
          applied = true;
        } catch (e) {
          if (isNetErr(e)) break; // still offline — leave the rest queued
          console.warn('Dropping change that no longer applies:', q.ops[0], e);
        }
        q.ops.shift();
        saveQueue(q);
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
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('lifts').insert(liftRow(entry)).select().single();
            if (error) throw error;
            state.lifts.push(fromLift(data));
          },
          () => state.lifts.push({ id: tempId, ...entry }),
          { kind: 'add', table: 'lifts', tempId, entry }
        );
      } else {
        state.lifts.push({ id: uid(), ...entry });
        saveLocal();
      }
    },
    async addClimb(entry) {
      if (cloudOn()) {
        const tempId = 'tmp_' + uid();
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('climbs').insert(climbRow(entry)).select().single();
            if (error) throw error;
            state.climbs.push(fromClimb(data));
          },
          () => state.climbs.push({ id: tempId, ...entry }),
          { kind: 'add', table: 'climbs', tempId, entry }
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
        await cloudWrite(
          async () => {
            const { data, error } = await sb.from('routines').insert(routineRow(entry)).select().single();
            if (error) throw error;
            state.routines.push(fromRoutine(data));
          },
          () => state.routines.push({ id: tempId, ...routineRow(entry) }),
          { kind: 'add', table: 'routines', tempId, entry }
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
        state = { lifts: [], climbs: [] };
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
  // Top tab bar and mobile bottom nav both switch views; keep them in sync.
  // (Profile in the bottom nav has no data-view — it opens a modal instead.)
  $$('.tab[data-view], .bnav-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      $$('.tab[data-view], .bnav-btn[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
      $$('.view').forEach((v) => v.classList.remove('is-active'));
      $('#view-' + view).classList.add('is-active');
      window.scrollTo(0, 0); // each page opens from its top
      redrawActiveCharts();  // charts drawn while hidden re-fit to real width
    });
  });

  /* ----- Floating "+" button: log a set or a climb from anywhere ----- */
  const fabMenu = $('#fab-menu');
  $('#fab').addEventListener('click', (e) => {
    e.stopPropagation();
    fabMenu.hidden = !fabMenu.hidden;
  });
  $('#fab-lift').addEventListener('click', () => { fabMenu.hidden = true; openAddLift(); });
  $('#fab-climb').addEventListener('click', () => { fabMenu.hidden = true; openAddClimb(); });

  /* ----- "Log entry" pill on the dashboard: same chooser, under the button ----- */
  const logMenu = $('#log-menu');
  $('#dash-log-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    logMenu.hidden = !logMenu.hidden;
  });
  $('#log-lift').addEventListener('click', () => { logMenu.hidden = true; openAddLift(); });
  $('#log-climb').addEventListener('click', () => { logMenu.hidden = true; openAddClimb(); });
  document.addEventListener('click', (e) => {
    if (!fabMenu.hidden && !e.target.closest('.fab-wrap')) fabMenu.hidden = true;
    if (!logMenu.hidden && !e.target.closest('.log-wrap')) logMenu.hidden = true;
  });

  /* ----- Per-view "log" buttons in the page headers ----- */
  $('#lift-add-btn').addEventListener('click', openAddLift);
  $('#climb-add-btn').addEventListener('click', openAddClimb);

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
        <td class="wt">${l.weight > 0 ? `${fmtNum(l.weight)} ${l.unit}` : 'BW'}</td>
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
    renderClimbTable();
    renderClimbChart();
  }

  function renderClimbTable() {
    const tbody = $('#climb-table tbody');
    const filter = $('#climb-filter').value;
    const rows = state.climbs
      .filter((c) => !filter || c.discipline === filter)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No climbs logged yet.</td></tr>';
      return;
    }
    rows.forEach((c) => {
      const discClass = c.discipline === 'Bouldering' ? 'boulder' : 'rope';
      const resClass = isSend(c.result) ? 'send' : 'project';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="date">${fmtDate(c.date)}</td>
        <td><span class="badge ${discClass}">${c.discipline}</span></td>
        <td class="wt">${routeDot(c.color)}${c.grade}</td>
        <td><span class="badge ${resClass}">${c.result}</span></td>
        <td>${c.attempts}</td>
        <td class="muted">${escapeHTML(c.location)}</td>
        <td class="muted">${escapeHTML(c.notes)}</td>
        <td class="row-actions">
          <button class="edit-btn" title="Edit" aria-label="Edit"><svg class="ico"><use href="#i-pencil"/></svg></button>
          <button class="del-btn" title="Delete" aria-label="Delete"><svg class="ico"><use href="#i-x"/></svg></button>
        </td>`;
      tr.querySelector('.edit-btn').addEventListener('click', () => openEditClimb(c));
      tr.querySelector('.del-btn').addEventListener('click', () => {
        withSync(async () => {
          await Store.delClimb(c.id);
          renderClimbing(); renderDashboard();
        });
      });
      tbody.appendChild(tr);
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

  function renderClimbChart() {
    const metric = $('#climb-chart-metric').value;
    const cutoff = rangeCutoff('#climb-range');
    const wrap = $('#climb-chart');
    const prStrip = $('#climb-prs');

    const sends = state.climbs.filter((c) => isSend(c.result) && (!cutoff || c.date >= cutoff));
    if (!sends.length) {
      wrap.innerHTML = `<div class="chart-empty">${state.climbs.length ? 'No sends in this range.' : 'Log a send to see progress.'}</div>`;
      prStrip.innerHTML = '';
      return;
    }

    // Brand mapping: bouldering is navy, roped disciplines lead with orange.
    const DISC_COLORS = { 'Bouldering': '#1f3a5f', 'Sport': '#f59e2c', 'Top Rope': '#16181d', 'Trad': '#3a7d44' };
    if (metric === 'sends') {
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
    chips.push(`<span class="pr-chip">Total sends <b>${sends.length}</b></span>`);
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
  const routeDot = (color) =>
    CLIMB_COLORS[color] ? `<span class="route-dot" style="background:${CLIMB_COLORS[color]}" title="${color} route"></span>` : '';

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
    // Leaving the modal ends any routine session and removes its chrome.
    run = null;
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

  function openAddLift() {
    editingLiftId = null;
    editLiftForm.reset();
    applyBodyweight(); // reset unchecks the box — re-enable the weight field
    editLiftForm.elements.date.value = todayISO();
    editLiftForm.elements.sets.value = 1;
    editLiftForm.elements.unit.value = dominantUnit();
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
    editLiftForm.elements.unit.value = l.unit;
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

  // The program panel appears on both Home and the Weightlifting page —
  // render the same content into every routine-list container.
  function renderProgram() {
    const containers = [$('#routine-list'), $('#routine-list-lift')].filter(Boolean);
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
      editLiftForm.elements.unit.value = last.unit;
      editLiftForm.elements.bodyweight.checked = !(last.weight > 0);
      applyBodyweight();
      if (last.weight > 0) editLiftForm.elements.weight.value = last.weight;
      editLiftForm.elements.reps.value = last.reps;
    } else {
      applyBodyweight();
      editLiftForm.elements.unit.value = dominantUnit();
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
    if (run.idx >= run.routine.exercises.length) closeEditModal();
    else runExercise();
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
    const unit = dominantUnit();
    const R = parseInt($('#dash-range').value, 10) || 30;
    const cutCur = daysAgoISO(R);
    const cutPrev = daysAgoISO(R * 2);
    const inCurrent = (x) => x.date >= cutCur;
    const inPrevious = (x) => x.date >= cutPrev && x.date < cutCur;
    $$('.stat-label .rng').forEach((el) => { el.textContent = `${R}d`; });

    // Lifting: sessions + volume, last R days vs the R before
    const liftVol = (rows) => rows.reduce((s, l) => s + toUnit(l.weight, l.unit, unit) * l.sets * l.reps, 0);
    const liftSess = (rows) => new Set(rows.map((l) => l.date)).size;
    const liftsCur = state.lifts.filter(inCurrent);
    const liftsPrev = state.lifts.filter(inPrevious);

    $('#dash-lift-sessions').textContent = liftSess(liftsCur);
    setDelta('#dash-lift-sessions-delta', liftSess(liftsCur), liftSess(liftsPrev), R);
    $('#dash-lift-volume').textContent = fmtCompact(liftVol(liftsCur));
    $('#dash-lift-volume-unit').textContent = unit + ' moved';
    setDelta('#dash-lift-volume-delta', Math.round(liftVol(liftsCur)), Math.round(liftVol(liftsPrev)), R);

    // Climbing: sessions + sends
    const climbSess = (rows) => new Set(rows.map((c) => c.date)).size;
    const sendCount = (rows) => rows.filter((c) => isSend(c.result)).length;
    const climbsCur = state.climbs.filter(inCurrent);
    const climbsPrev = state.climbs.filter(inPrevious);

    $('#dash-climb-sessions').textContent = climbSess(climbsCur);
    setDelta('#dash-climb-sessions-delta', climbSess(climbsCur), climbSess(climbsPrev), R);
    $('#dash-climb-sends').textContent = sendCount(climbsCur);
    setDelta('#dash-climb-sends-delta', sendCount(climbsCur), sendCount(climbsPrev), R);

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
    const unit = dominantUnit();
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

    const volByWeek = {};
    state.lifts.forEach((l) => {
      const w = weekStart(l.date);
      if (wIndex.has(w)) volByWeek[w] = (volByWeek[w] || 0) + toUnit(l.weight, l.unit, unit) * l.sets * l.reps;
    });
    drawBars($('#dash-lift-chart'),
      weeks.map((w) => ({ date: w, value: volByWeek[w] || 0 })),
      (v) => `${fmtCompact(v)} ${unit}`);

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
  }

  // Redraw the visible view's charts at their current on-screen width.
  function redrawActiveCharts() {
    if (!$('#view-dashboard').classList.contains('is-active')) {
      if ($('#view-lifting').classList.contains('is-active')) renderLiftChart();
      else renderClimbChart();
    } else {
      renderDashCharts();
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawActiveCharts, 150);
  });

  $('#dash-range').addEventListener('change', renderDashboard);

  /* ----- Climbing leaderboard (cross-user, via the climb_leaderboard RPC) ----- */
  let lbDefaultApplied = false; // auto-pick the user's main discipline once per load

  async function renderLeaderboard() {
    const panel = $('#leaderboard-panel');
    if (!cloudOn()) { panel.hidden = true; return; }
    // Default the filter to the discipline this user climbs most (e.g. Sport
    // for a lead climber). Recent climbs (90d) decide, so a stack of old
    // entries in another discipline doesn't win; manual selection sticks.
    if (!lbDefaultApplied && state.climbs.length) {
      const recentCut = daysAgoISO(90);
      const recent = state.climbs.filter((c) => c.date >= recentCut);
      const main = mostCommon((recent.length ? recent : state.climbs).map((c) => c.discipline));
      const sel = $('#lb-discipline');
      if (main && [...sel.options].some((o) => o.value === main)) sel.value = main;
      lbDefaultApplied = true;
    }
    const days = parseInt($('#dash-range').value, 10) || 30;
    const disc = $('#lb-discipline').value;
    try {
      const { data, error } = await sb.rpc('climb_leaderboard', { days, disc });
      if (error) throw error;
      panel.hidden = false;
      const list = $('#leaderboard-list');
      if (!data || !data.length) {
        list.innerHTML = '<li class="empty">No sends in this range yet — get after it.</li>';
        return;
      }

      list.innerHTML = data.map((r, i) => `
        <li class="${r.is_me ? 'me' : ''}" title="See ${escapeHTML(r.display_name)}'s summary">
          <div class="feed-left">
            <span class="lb-rank${i < 3 ? ' r' + (i + 1) : ''}">${i + 1}</span>
            <div>
              <div class="feed-main">${escapeHTML(r.display_name)}${r.is_me ? ' <span class="you-chip">You</span>' : ''}</div>
              <div class="feed-sub">${r.sends_at_hardest}× at ${escapeHTML(r.hardest)} · ${r.total_sends} send${r.total_sends === 1 ? '' : 's'} total</div>
            </div>
          </div>
          <div class="lb-grade">${escapeHTML(r.hardest)}</div>
        </li>`).join('');
      // Row click → per-climber summary (aggregates via climb_user_summary)
      list.querySelectorAll('li').forEach((li, i) => {
        li.addEventListener('click', () => openLbSummary(data[i]));
      });
    } catch (e) {
      // Function not installed yet, or transient failure — hide quietly.
      console.warn('Leaderboard unavailable:', e);
      panel.hidden = true;
    }
  }

  $('#lb-discipline').addEventListener('change', () => {
    lbDefaultApplied = true; // the user's manual choice sticks
    renderLeaderboard();
  });

  /* ----- Climber summary modal: what a leaderboard entry actually did.
     Same privacy stance as the leaderboard itself — grade-by-grade counts
     only, never locations, notes, dates, or individual climbs. ----- */
  const lbModal = $('#lb-modal');
  $('#lb-close').addEventListener('click', () => { lbModal.hidden = true; });
  lbModal.addEventListener('click', (e) => { if (e.target === lbModal) lbModal.hidden = true; });

  async function openLbSummary(row) {
    const days = parseInt($('#dash-range').value, 10) || 30;
    const disc = $('#lb-discipline').value;
    $('#lb-name').textContent = row.display_name;
    $('#lb-sub').textContent = `${disc} · last ${days} days`;
    const box = $('#lb-summary');
    box.innerHTML = '<div class="chart-empty" style="height:90px">Loading…</div>';
    lbModal.hidden = false;
    try {
      const { data, error } = await sb.rpc('climb_user_summary', { target: row.user_id, days, disc });
      if (error) throw error;
      renderLbSummary(box, data, disc);
    } catch (e) {
      console.warn('Climber summary unavailable:', e);
      box.innerHTML = `<p class="auth-status err">Couldn't load the summary (${escapeHTML(errMsg(e))}). If this persists, re-run supabase-schema.sql — the summary needs its updated functions.</p>`;
    }
  }

  function renderLbSummary(box, data, disc) {
    if (!data) {
      box.innerHTML = '<p class="muted small">Nothing logged in this range.</p>';
      return;
    }
    // Collapse per-result rows into per-grade buckets
    const byGrade = {};
    (data.by_grade || []).forEach((g) => {
      const b = (byGrade[g.grade] = byGrade[g.grade] || { sends: 0, flash: 0, onsight: 0, project: 0 });
      if (g.result === 'Project') b.project += g.n;
      else {
        b.sends += g.n;
        if (g.result === 'Flash') b.flash += g.n;
        if (g.result === 'Onsight') b.onsight += g.n;
      }
    });
    const grades = Object.keys(byGrade).sort((a, b) => gradeRank(disc, b) - gradeRank(disc, a));
    if (!grades.length) {
      box.innerHTML = '<p class="muted small">Nothing logged in this range.</p>';
      return;
    }
    const totalSends = grades.reduce((s, g) => s + byGrade[g].sends, 0);
    const hardest = grades.find((g) => byGrade[g].sends > 0);
    const maxN = Math.max(...grades.map((g) => byGrade[g].sends + byGrade[g].project));
    const chips = `
      <div class="pr-strip">
        <span class="pr-chip">Hardest <b>${hardest ? escapeHTML(hardest) : '—'}</b></span>
        <span class="pr-chip">Sends <b>${totalSends}</b></span>
        <span class="pr-chip">Sessions <b>${data.sessions || 0}</b></span>
      </div>`;
    const rows = grades.map((g) => {
      const b = byGrade[g];
      // Flashes/onsights ARE sends — show them as a breakdown of the send
      // count ("1 send (flash)"), never as a separate tally beside it.
      const parts = [];
      if (b.sends) {
        const subs = [];
        if (b.flash) subs.push(`${b.flash} flash${b.flash === 1 ? '' : 'es'}`);
        if (b.onsight) subs.push(`${b.onsight} onsight${b.onsight === 1 ? '' : 's'}`);
        let label = `${b.sends} send${b.sends === 1 ? '' : 's'}`;
        if (subs.length) {
          label += b.sends === 1
            ? ` (${b.flash ? 'flash' : 'onsight'})`
            : ` (${subs.join(' · ')})`;
        }
        parts.push(label);
      }
      if (b.project) parts.push(`${b.project} project${b.project === 1 ? '' : 's'}`);
      const w = Math.max(4, Math.round(((b.sends + b.project) / maxN) * 100));
      return `
        <div class="lbs-row">
          <span class="lbs-grade">${escapeHTML(g)}</span>
          <div class="lbs-bar"><span style="width:${w}%"></span></div>
          <span class="lbs-count">${parts.join(' · ')}</span>
        </div>`;
    }).join('');
    box.innerHTML = chips + rows;
  }

  const WEEKLY_GOAL = 6; // sessions per week the hero ring fills toward

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
    const unit = dominantUnit();
    const display = exerciseDisplayMap();
    const todayIso = todayISO();
    // Fold any future-dated entries into today — logs stamped with tomorrow's
    // UTC date (before dates went local) still count for rings and the streak.
    const clampDate = (d) => (d > todayIso ? todayIso : d);
    const liftDates = new Set(state.lifts.map((l) => clampDate(l.date)));
    const climbDates = new Set(state.climbs.map((c) => clampDate(c.date)));
    const activeDates = new Set([...liftDates, ...climbDates]);

    // ----- Week strip: last 7 days ending today -----
    // Ring color says what kind of session the day held: orange = lifting,
    // navy = climbing, half-and-half = both, plain border = rest day.
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
    const ringClass = (iso) => {
      const l = liftDates.has(iso), c = climbDates.has(iso);
      return l && c ? ' ring-both' : l ? ' ring-lift' : c ? ' ring-climb' : '';
    };
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

    const liftsWk = state.lifts.filter((l) => l.date >= wkStart);
    const climbsWk = state.climbs.filter((c) => c.date >= wkStart);
    const liftsPrev = state.lifts.filter((l) => l.date >= prevStart && l.date < wkStart);
    const climbsPrev = state.climbs.filter((c) => c.date >= prevStart && c.date < wkStart);
    const sessionDates = new Set([...liftsWk, ...climbsWk].map((x) => x.date));

    // Greeting
    const hour = new Date().getHours();
    const tod = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const first = (currentDisplayName() || '').trim().split(/\s+/)[0];
    $('#greeting').textContent = `Good ${tod}${first ? ', ' + first : ''}`;
    const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const remaining = Math.max(0, WEEKLY_GOAL - sessionDates.size);
    $('#greeting-sub').textContent = `${dateStr} · ${remaining
      ? `${remaining} session${remaining === 1 ? '' : 's'} to hit your weekly goal`
      : 'weekly goal hit — nice work'}`;

    // Hero: sessions + progress ring toward the weekly goal
    $('#hero-sessions').textContent = sessionDates.size;
    $('#hero-label').textContent = `sessions this week · goal ${WEEKLY_GOAL}`;
    const pct = Math.min(100, Math.round(sessionDates.size / WEEKLY_GOAL * 100));
    $('#hero-ring').style.background = `conic-gradient(var(--accent) ${pct}%, #2e3038 0)`;
    $('#hero-pct').textContent = pct + '%';

    // Minis
    const vol = (rows) => rows.reduce((s, l) => s + toUnit(l.weight, l.unit, unit) * l.sets * l.reps, 0);
    const volWk = vol(liftsWk);
    $('#mini-volume').innerHTML = volWk ? `${fmtCompact(volWk)} <span class="unit">${unit}</span>` : '0';
    setMiniDelta('#mini-volume-sub', Math.round(volWk), Math.round(vol(liftsPrev)), 'pct');

    const sendsWk = climbsWk.filter((c) => isSend(c.result)).length;
    $('#mini-sends').textContent = sendsWk;
    setMiniDelta('#mini-sends-sub', sendsWk, climbsPrev.filter((c) => isSend(c.result)).length, 'abs');

    let top = null;
    liftsWk.forEach((l) => {
      if (!(l.weight > 0)) return; // bodyweight sets don't set a top weight
      const w = toUnit(l.weight, l.unit, unit);
      if (!top || w > top.w) top = { w, exercise: display[exKey(l.exercise)] || l.exercise, date: l.date };
    });
    $('#mini-top').innerHTML = top ? `${fmtNum(top.w)} <span class="unit">${unit}</span>` : '—';
    $('#mini-top-sub').textContent = top
      ? `${top.exercise} · ${new Date(top.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' })}`
      : '';

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
    $('#streak-pill').hidden = false;

    // ----- Recent activity: lifts + climbs merged -----
    const items = [
      ...state.lifts.map((l) => ({
        kind: 'lift',
        icon: 'barbell',
        main: `${display[exKey(l.exercise)] || l.exercise} · ${l.weight > 0 ? `${fmtNum(l.weight)} ${l.unit}` : 'BW'} · ${l.sets}×${l.reps}`,
        sub: l.notes || '',
        date: l.date
      })),
      ...state.climbs.map((c) => ({
        kind: 'climb',
        icon: 'mountain',
        dot: c.color,
        main: `${c.grade} · ${c.result}${c.attempts > 1 ? ` · ${c.attempts} attempts` : ''}`,
        sub: [c.discipline !== 'Bouldering' ? c.discipline : '', c.location, c.notes].filter(Boolean).join(' · '),
        date: c.date
      }))
    ];
    renderFeed('#recent-feed', items, (m) => m, 'Tap ＋ to log your first set or climb.');
  }

  // Recent dates read as weekdays ("Thu"); older ones as short dates ("Jul 5").
  function feedDate(iso) {
    return iso >= daysAgoISO(6)
      ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })
      : fmtDateShort(iso);
  }

  function renderFeed(sel, items, mapFn, emptyMsg) {
    const el = $(sel);
    const rows = items.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
    if (!rows.length) {
      el.innerHTML = `<li class="empty">${emptyMsg}</li>`;
      return;
    }
    el.innerHTML = rows.map((it) => {
      const m = mapFn(it);
      return `<li>
        <div class="feed-left">
          ${m.icon ? `<span class="feed-ico${m.kind ? ' ' + m.kind : ''}"><svg class="ico"><use href="#i-${m.icon}"/></svg></span>` : ''}
          <div>
            <div class="feed-main">${m.dot ? routeDot(m.dot) : ''}${escapeHTML(m.main)}</div>
            ${m.sub ? `<div class="feed-sub">${escapeHTML(m.sub)}</div>` : ''}
          </div>
        </div>
        <div class="feed-date">${feedDate(m.date)}</div>
      </li>`;
    }).join('');
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
    const H = 200, padT = 28, padB = 10, padX = 6;
    const baseY = H - padB;
    const n = points.length;
    const slot = (W - padX * 2) / n;
    const barW = Math.min(34, slot * 0.6);
    const bars = points.map((p, i) => {
      if (p.value <= 0) return '';
      const h = Math.max(3, (p.value / max) * (baseY - padT));
      const x = padX + slot * i + (slot - barW) / 2;
      const y = baseY - h;
      const last = i === n - 1;
      const label = last
        ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#b9741f" font-family="Space Grotesk, Archivo, sans-serif">${fmtCompact(p.value)}</text>`
        : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(7, barW / 2)}" fill="${last ? '#f59e2c' : '#e2d9c4'}"><title>Week of ${fmtDateShort(p.date)}: ${fmtValue(p.value)}</title></rect>${label}`;
    }).join('');
    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly volume chart">
        <line class="chart-base" x1="0" y1="${baseY}" x2="${W}" y2="${baseY}"/>
        ${bars}
      </svg>`;
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
    let min = Math.min(...values);
    let max = Math.max(...values);
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

    const ticks = [min + (max - min) * 0.1, (min + max) / 2, max - (max - min) * 0.1];
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
      const endDot = `<circle cx="${x(xi.get(end.date)).toFixed(1)}" cy="${y(end.value).toFixed(1)}" r="5" fill="${color}"/>`;
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>${hovers}${endDot}`;
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
  const profileModal = $('#profile-modal');
  let namePrompted = false;

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
  }

  // Send the sign-in email (gate form). The email carries both a link (fine
  // in a normal browser) and a 6-digit code — the code is what works inside
  // the installed app, where email links would open Safari's separate session.
  let pendingAuthEmail = null;
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
      pendingAuthEmail = email;
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
    if (isDigits && !pendingAuthEmail) return;
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
    return (session && session.user && session.user.user_metadata && session.user.user_metadata.display_name) || '';
  }

  function renderAccount() {
    const signedIn = CONFIGURED && !!session;
    $('#nav-profile').hidden = !signedIn; // mobile bottom-nav Profile
    if (!signedIn) { accountEl.hidden = true; accountEl.innerHTML = ''; return; }
    accountEl.hidden = false;
    const label = currentDisplayName() || session.user.email || 'Account';
    const initial = (label.trim()[0] || '?').toUpperCase();
    // Navy circle avatar with the user's initial; opens the profile modal.
    accountEl.innerHTML = `
      <span class="sync-dot" id="sync-dot" title="Synced"></span>
      <button class="avatar" id="profile-btn" title="${escapeHTML(label)} — account" aria-label="Account">${escapeHTML(initial)}</button>`;
    $('#profile-btn').addEventListener('click', () => openProfile(false));
  }

  $('#nav-profile').addEventListener('click', () => { if (CONFIGURED && session) openProfile(false); });

  // ----- Edit-name modal -----
  function openProfile(onboarding) {
    $('#profile-name').value = currentDisplayName();
    $('#profile-title').textContent = onboarding ? 'Welcome! What should we call you?' : 'Your name';
    const status = $('#profile-status'); status.textContent = ''; status.className = 'auth-status';
    profileModal.hidden = false;
    setTimeout(() => $('#profile-name').focus(), 50);
  }
  function closeProfile() { profileModal.hidden = true; }
  $('#profile-close').addEventListener('click', closeProfile);
  profileModal.addEventListener('click', (e) => { if (e.target === profileModal) closeProfile(); });
  $('#modal-signout').addEventListener('click', async () => {
    closeProfile();
    await sb.auth.signOut();
  });

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#profile-name').value.trim();
    const submit = $('#profile-submit');
    const status = $('#profile-status');
    submit.disabled = true;
    status.className = 'auth-status';
    status.textContent = 'Saving…';
    try {
      const { error } = await sb.auth.updateUser({ data: { display_name: name } });
      if (error) throw error;
      if (session && session.user) {
        session.user.user_metadata = Object.assign({}, session.user.user_metadata, { display_name: name });
      }
      renderAccount();
      closeProfile();
    } catch (err) {
      console.error('Save name error:', err);
      status.className = 'auth-status err';
      status.textContent = 'Error: ' + errMsg(err);
    } finally {
      submit.disabled = false;
    }
  });

  // On first sign-in with no name yet, gently prompt for one.
  function maybePromptName() {
    if (namePrompted) return;
    if (session && !currentDisplayName()) {
      namePrompted = true;
      openProfile(true);
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
