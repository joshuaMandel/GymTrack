/* ==========================================================================
   SendOff — weightlifting & rock climbing progress tracker

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
     Motion — vanilla spring animations via motion.dev (window.Motion),
     vendored same-origin and precached for offline (index.html + sw.js).
     This layer ONLY enhances: every call falls back to the existing CSS (or
     a no-op) when Motion is absent or the user prefers reduced motion, so
     nothing here is load-bearing. Springs are easing generators in this
     build (spring({stiffness,damping,mass}) → easing), not {type:'spring'}.
     ====================================================================== */
  const MO = (typeof window !== 'undefined' && window.Motion) || null;
  // Spring feels, tuned lively-but-professional and reused app-wide. Referenced
  // by name via the opts.spring shorthand so the generator is only built after
  // the motionOK() guard (MO may be null).
  const SPRING_CFG = {
    pop: { stiffness: 560, damping: 26, mass: 0.9 }, // default entrance
    gentle: { stiffness: 380, damping: 30 }, // calm slide/fade
    snappy: { stiffness: 720, damping: 32 }, // quick, minimal overshoot
    bouncy: { stiffness: 480, damping: 17 } // playful overshoot (receive, chips)
  };
  function motionOK() { return !!MO && !maReduced(); }
  // animate(el, keyframes, opts) when Motion is usable; else run cssFallback
  // (if given) and return null. opts.spring:'pop' expands to a spring easing.
  // Never throws — a bad call degrades to the fallback.
  function mAnim(el, keyframes, opts, cssFallback) {
    if (!el) return null;
    if (!motionOK()) { if (cssFallback) cssFallback(); return null; }
    const o = Object.assign({}, opts);
    if (o.spring) { o.easing = MO.spring(SPRING_CFG[o.spring] || SPRING_CFG.pop); delete o.spring; }
    try { return MO.animate(el, keyframes, o); }
    catch (e) { if (cssFallback) cssFallback(); return null; }
  }
  // Stop a Motion playback controls object safely (no-op if null/absent).
  function mStop(a) { try { a && a.stop && a.stop(); } catch (e) { /* ignore */ } }
  // Spring an overlay's dialog/sheet into view. Call right AFTER setting the
  // overlay's hidden=false; a pure no-op when Motion is off/reduced (the overlay
  // is already visible). Bottom sheets slide up; centered dialogs pop in.
  function animOverlayIn(overlay) {
    if (!overlay || !motionOK()) return;
    mAnim(overlay, { opacity: [0, 1] }, { duration: 0.16, easing: 'ease-out' });
    const panel = overlay.querySelector('.sheet, .modal');
    if (!panel) return;
    const sheet = panel.classList.contains('sheet');
    mAnim(panel,
      sheet ? { transform: ['translateY(100%)', 'translateY(0)'] }
        : { transform: ['translateY(8px) scale(.92)', 'translateY(0) scale(1)'] },
      { spring: sheet ? 'gentle' : 'pop' });
  }

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
  let myAvatarV = 0;             // my profile-picture version (0 = default avatar)
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
  const fromClimb = (r) => ({ id: r.id, ...climbRow(r), color: r.color || '', created_at: r.created_at });
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

  /* ======================================================================
     Avatars — one renderer for every surface. A user with a picture (avatar
     version > 0) shows their thumbnail from Supabase Storage; everyone else
     gets a stable initials-on-color default, the color derived deterministically
     from their user id so it's identical on every surface. The colored circle
     reserves the space immediately and the photo fades in over it (no layout
     shift, no broken-image icon — a failed load just leaves the initial).
     ====================================================================== */
  const AVATAR_PALETTE = ['#1f3a5f', '#2e7d5b', '#b4531f', '#6b4ea0', '#a03a5f', '#2f6f8f', '#8a6d1f', '#3f7d6b', '#9a4b3f', '#4a5db0'];
  function avatarColorFor(uid) {
    const s = String(uid || ''); let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  }
  const avatarInitial = (name) => (String(name || '').trim()[0] || '?').toUpperCase();
  const avatarStorageBase = () => `${(cfg.url || '').replace(/\/$/, '')}/storage/v1/object/public/avatars`;
  function avatarPicUrl(uid, which, v) {
    // Resolve through the storage client so the public URL matches the backend;
    // ?v busts the browser cache on replace (fixed object paths). data: URLs
    // (test stub) already change on replace, so they skip the query.
    try {
      const u = sb.storage.from('avatars').getPublicUrl(`${uid}/${which}.webp`).data.publicUrl;
      return u.startsWith('data:') ? u : `${u}?v=${v || 1}`;
    } catch (e) { return `${avatarStorageBase()}/${uid}/${which}.webp?v=${v || 1}`; }
  }
  // In-memory version cache so a surface that doesn't carry avatar_v (e.g. a
  // realtime feed row) can still render the right picture once we've seen it.
  const avatarVer = new Map();
  function noteAvatar(uid, v) { if (uid != null && v != null) avatarVer.set(uid, v); }
  function avatarVersion(uid, v) { if (v != null) { noteAvatar(uid, v); return v; } return avatarVer.get(uid) || 0; }
  // size: 'sm' (lists) | 'md' (cards/matches) | 'lg' (profile hero). data-uid lets
  // sweepAvatars() upgrade a default to a photo once we learn its version.
  function avatarHTML(uid, name, size, v) {
    const ver = avatarVersion(uid, v);
    const which = size === 'lg' ? 'full' : 'thumb';
    const color = avatarColorFor(uid);
    const ini = escapeHTML(avatarInitial(name));
    // Render a known photo already-visible ('on') and EAGER: on a full re-render
    // (e.g. the head-to-head's ~3s poll) a fresh img must not restart the opacity
    // fade, and lazy/async-decode would leave a blank frame on iOS Safari even for
    // a cached image — either way the default circle flashes underneath. The
    // first-appearance fade (and lazy loading) is kept for the sweep-upgrade path
    // (upgradeAvatarDom), which handles avatars whose version wasn't known yet.
    const img = ver > 0
      ? `<img class="av-img on" src="${avatarPicUrl(uid, which, ver)}" alt="" decoding="sync" onerror="this.remove()">`
      : '';
    return `<span class="av av-${size || 'sm'}" style="background:${color}" data-uid="${uid || ''}" data-avsize="${size || 'sm'}"><span class="av-ini">${ini}</span>${img}</span>`;
  }
  // Upgrade default circles to photos (and back) from the version cache — no
  // layout shift, the photo fades in. Called after a fetch or a local change.
  function upgradeAvatarDom() {
    document.querySelectorAll('.av[data-uid]').forEach((span) => {
      const uid = span.getAttribute('data-uid'); if (!uid) return;
      const v = avatarVer.get(uid) || 0;
      const existing = span.querySelector('.av-img');
      if (v > 0 && !existing) {
        const which = span.getAttribute('data-avsize') === 'lg' ? 'full' : 'thumb';
        const img = document.createElement('img');
        img.className = 'av-img'; img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
        img.onload = () => img.classList.add('on'); img.onerror = () => img.remove();
        img.src = avatarPicUrl(uid, which, v);
        span.appendChild(img);
      } else if (v === 0 && existing) {
        existing.remove(); // picture was removed → back to the initial
      }
    });
  }
  // Learn the picture versions of everyone currently on screen (one round-trip
  // for the unknowns), then upgrade their avatars. Cached, so scrolling back
  // doesn't refetch; offline → no fetch, defaults stay.
  let avatarSweepT = null;
  function sweepAvatars() {
    if (avatarSweepT) return; // coalesce bursts of renders into one sweep
    avatarSweepT = setTimeout(async () => {
      avatarSweepT = null;
      const uids = [...new Set([...document.querySelectorAll('.av[data-uid]')].map((s) => s.getAttribute('data-uid')).filter(Boolean))];
      // Re-check users we've only ever seen as default (v 0/unknown) so a newly
      // uploaded picture appears; users WITH a picture stay cached (their image
      // is browser-cached, so scrolling never refetches it).
      const need = uids.filter((u) => !(avatarVer.get(u) > 0));
      if (cloudOn() && need.length) {
        try {
          const { data, error } = await sb.rpc('avatars_for', { uids: need });
          if (!error) { (data || []).forEach((r) => avatarVer.set(r.id, r.v)); need.forEach((u) => { if (!avatarVer.has(u)) avatarVer.set(u, 0); }); }
        } catch (e) { /* offline — keep defaults */ }
      }
      upgradeAvatarDom();
    }, 30);
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
    // Admin is owner-only: a non-admin who reaches for it lands on Home, nothing
    // special (the screen + its endpoints are gated server-side regardless).
    if (view === 'admin' && !isAdmin) view = 'dashboard';
    const target = $('#view-' + view) || $('#view-dashboard');
    if (!target) return;
    $$('.tab[data-view], .bnav-btn[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.remove('is-active'));
    target.classList.add('is-active');
    const ava = $('#profile-btn');
    if (ava) ava.classList.toggle('is-active', view === 'profile');
    window.scrollTo(0, 0); // each page opens from its top
    redrawActiveCharts();  // charts drawn while hidden re-fit to real width
    if (view === 'friends') { renderFriendsScreen(); loadFriends(); loadFeed(); } // freshest data on entry
    if (view === 'admin') renderAdmin();
    if (typeof renderMatchDock === "function") renderMatchDock(); // dock only on Home + Climbing
    sweepAvatars();
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
     Send Score — a converging chess-style Elo rating, computed client-side.

     Your rating is a number on a chess-like scale: a beginner on V0s sits
     near 1000, and each V-grade is +100. Every climb is a "match" against
     the route's difficulty rating:
         E = expected send chance = 1 / (1 + 10^((routeR − R)/SS_SPREAD))
         R += K · (didSend − E)
     The rating CONVERGES to your current sending level and does NOT inflate
     with volume — sending easy laps (E≈1) barely moves you, so you can't farm
     it. The expected-outcome math also gives the fail behaviour for free:
       • fail a route ABOVE your level → E small → tiny drop (trying hard ≈ free)
       • fail a route AT your level    → E≈0.5  → drop ≈ the gain a send earns
       • fail a route BELOW your level → E→1    → bigger drop (you were expected to)
     K is large while provisional (first SS_PROV_SESSIONS sessions) so a new
     climber converges fast, then small so an established rating is stable. A
     flash scores exactly like the send plus a flat +1 bonus point.

     Two independent ratings — Bouldering (V) and Roped (YDS) — since the
     scales differ. Ties within a date replay in id order so every device and
     the SQL leaderboard replay agree on the same sequence. KEEP THE CONSTANTS
     AND grade→D MAPS IN SYNC with supabase-schema.sql (climb_send_scores_impl).
     ====================================================================== */
  const SS_BASE = 1000, SS_STEP = 100, SS_SPREAD = 200;   // boulder scale: rating = 1000 + 100·D
  const SS_K_PROV = 40, SS_K_EST = 16, SS_PROV_SESSIONS = 5; // sensitivity: fast then stable
  const SS_FLASH_BONUS = 1;                                // a flash = a send + exactly 1 point
  // Roped ratings sit a constant offset higher so a 5.10c climber (D0) lands
  // near 1300, not 1000. Pure display shift: Elo depends only on (routeR − R),
  // and both move together, so NO dynamics change (convergence, penalties, etc.).
  const SS_ROPE_OFFSET = 300;

  const ratingGroup = (discipline) => (discipline === 'Bouldering' ? 'boulder' : 'rope');

  // Grade → difficulty index D (V-scale units; 5.10c ≈ V0 ≈ D0). Roped uses a
  // standard boulder-equivalent conversion so a V5 boulder and a ~5.12d route
  // land at a similar rating.
  const V_D = {}; V_GRADES.forEach((g, i) => { V_D[g] = i - 1; }); // VB=-1, V0=0 … V17=17
  const YDS_D_LIST = [-4, -3.5, -3, -2.5, -2, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.7, 4.3, 5, 6, 6.7, 7.3, 8, 9, 9.7, 10.3, 11, 12, 13, 14, 15];
  const YDS_D = {}; YDS_GRADES.forEach((g, i) => { YDS_D[g] = YDS_D_LIST[i]; });
  const gradeD = (discipline, grade) => (discipline === 'Bouldering' ? V_D[grade] : YDS_D[grade]);

  const routeRating = (discipline, grade) => SS_BASE + (discipline === 'Bouldering' ? 0 : SS_ROPE_OFFSET) + SS_STEP * gradeD(discipline, grade);
  const sendExpected = (R, routeR) => 1 / (1 + Math.pow(10, (routeR - R) / SS_SPREAD));

  /* ---------- Match par-points helpers ----------
     Matches score PAR POINTS: each climb's value is a pure function of grade vs
     YOUR par (from match_state), so it's knowable before you climb. Turn state
     (turn / can_log) always comes from the server — never derived locally. */
  const MATCH_DISCS = { boulder: ['Bouldering'], lead: ['Sport'], toprope: ['Top Rope'], agnostic: ['Sport', 'Top Rope'] };
  // The live ruleset match state; mdState is kept fresh by the dock's 3s poll
  // even while the dock itself is hidden.
  function matchLive() {
    return (matches.active && mdState && mdState.id === matches.active.id && mdState.status === 'active'
      && mdState.rules && mdState.rules.discipline != null) ? mdState : null;
  }
  const matchMySide = (s) => (s.i_am === 'challenger' ? s.challenger : s.opponent);
  const matchTheirSide = (s) => (s.i_am === 'challenger' ? s.opponent : s.challenger);
  // Battle-mode damage ladder (mirrors core ladderDamage + SQL battle_damage): a
  // send's rung value, floored at 1. Boulder floor V0 → 1 (+1/grade); route floor
  // 5.7 → 1 (+1/letter). NO handicap — the raw grade is the damage.
  function battleDamage(discipline, grade) {
    const rank = gradeRank(discipline, grade);
    if (rank < 0) return 1;
    const raw = discipline === 'Bouldering' ? rank : rank - 1;
    return Math.max(1, raw);
  }
  // The damage a SEND of this grade would deal right now — the point-pill value.
  // Null when the climb wouldn't count (wrong discipline / no live match).
  function matchPointsFor(discipline, grade) {
    const live = matchLive(); if (!live) return null;
    const discs = MATCH_DISCS[live.rules.discipline]; if (!discs || !discs.includes(discipline)) return null;
    return battleDamage(discipline, grade);
  }
  // A side's most recent counting climb as a phrase for the turn handoff:
  // "flashed V9 (+10)" / "sent 5.11a (+3)" / "fell on V6". '' when none yet.
  function matchLastLine(p) {
    const l = p && p.last; if (!l || !l.grade) return '';
    const verb = l.result === 'Flash' ? 'flashed' : l.result === 'Project' ? 'fell on' : 'sent';
    return `${verb} ${l.grade}${l.points > 0 ? ` (+${l.points})` : ''}`;
  }

  // THE scoring replay over an explicit climb list, grouped into sessions
  // (dates). Returns the converged rating plus per-session detail with each
  // climb's exact ± rating move.
  function scoreBreakdown(allClimbs, group) {
    const climbs = allClimbs
      .filter((c) => ratingGroup(c.discipline) === group && gradeD(c.discipline, c.grade) !== undefined)
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
        : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

    if (!climbs.length) return { group, sessions: [], rating: null, provisional: true, hasData: false };

    // Seed at the first SEND's grade (else the first climb's) so a climber
    // starts near their level, not a long warm-up from a fixed number.
    const firstSend = climbs.find((c) => isSend(c.result)) || climbs[0];
    let R = routeRating(firstSend.discipline, firstSend.grade);

    const sessions = [];
    let sIdx = 0, i = 0, hardestRank = -1, hardestDisc = null;
    while (i < climbs.length) {
      const date = climbs[i].date;
      const sesh = [];
      while (i < climbs.length && climbs[i].date === date) { sesh.push(climbs[i]); i++; }
      const K = sIdx < SS_PROV_SESSIONS ? SS_K_PROV : SS_K_EST;
      const startRounded = Math.round(R);
      const detail = [];
      let sends = 0;
      for (const c of sesh) {
        const sent = isSend(c.result);
        const routeR = routeRating(c.discipline, c.grade);
        // Per-climb Δ is the change in the ROUNDED running rating, so per-climb
        // moves always sum exactly to the session's shown change (telescoping).
        const prevRounded = Math.round(R);
        R += K * ((sent ? 1 : 0) - sendExpected(R, routeR));
        if (c.result === 'Flash') R += SS_FLASH_BONUS; // flash = same send, one extra point
        if (sent) {
          sends++;
          const rk = gradeRank(c.discipline, c.grade);
          if (rk > hardestRank) { hardestRank = rk; hardestDisc = c.discipline; }
        }
        detail.push({ id: c.id, group, delta: Math.round(R) - prevRounded, climb: c });
      }
      sIdx++;
      sessions.push({
        date, delta: Math.round(R) - startRounded, end: Math.round(R),
        count: detail.length, sends, climbs: detail,
        hardest: hardestRank >= 0 ? (hardestDisc === 'Bouldering' ? V_GRADES[hardestRank] : YDS_GRADES[hardestRank]) : null
      });
    }
    return { group, sessions, rating: Math.round(R), provisional: sIdx < SS_PROV_SESSIONS, hasData: true };
  }

  // The headline view of the replay (hero, cards, charts).
  function climberRating(group) {
    const b = scoreBreakdown(state.climbs, group);
    const last = b.sessions.length ? b.sessions[b.sessions.length - 1] : null;
    return {
      group,
      // Displayed rating = pure climb replay + head-to-head match adjustment,
      // matching the leaderboard. The per-climb engine (scoreBreakdown) is
      // untouched; matchAdj is the additive win/loss layer.
      rating: b.rating == null ? null : b.rating + (matchAdj[group] || 0),
      provisional: b.provisional,
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
    let html = hidden ? '' : RATING_GROUPS.map((g) => {
      const r = climberRating(g.key);
      if (!r.hasData) return '';
      const d = r.lastSessionDelta;
      const delta = d ? `<span class="rating-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>` : '';
      const sub = `${g.scale} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}${r.provisional ? ' · provisional' : ''}`;
      return `
        <div class="rating-card ${g.key}" title="Your Send Score — a climbing rating like a chess Elo. It rises when you send above your level and settles at your current level; trying hard projects barely moves it.">
          <span class="rating-label">${g.label} Send Score</span>
          <span class="rating-value">${r.rating}${delta}</span>
          <span class="rating-sub">${sub}</span>
        </div>`;
    }).join('');
    // No sends yet → still lead the screen with an empty Send Score card so the
    // score→match order and the new-user anchor match the Home hero.
    if (!hidden && !html) {
      html = `
        <div class="rating-card is-empty">
          <span class="rating-label">Send Score</span>
          <span class="rating-value">1000</span>
          <span class="rating-sub">Log a climb to set your rating.</span>
        </div>`;
    }
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
    // Baseline = rating as of the most recent session before the cutoff; if
    // every session is more recent (a new climber), fall back to where the
    // rating first landed rather than zero.
    let baseline = r.history.length ? r.history[0].value : r.rating;
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
      $('#rh-value').textContent = SS_BASE;
      de.textContent = ''; de.className = 'rating-delta';
      $('#rh-sub').textContent = 'Log a climb to set your rating.';
      $('#rh-session').textContent = '';
      return;
    }
    hero.classList.remove('is-empty');
    $('#rh-value').textContent = r.rating;
    const d = r.lastSessionDelta;
    de.className = 'rating-delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
    de.textContent = d ? `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}` : '';
    const parts = [`${g.scale} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}${r.provisional ? ' · provisional' : ''}`];
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
    animOverlayIn(editModal);
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
  let toastAnim = null;
  // The toast is centered with translateX(-50%); keep that in every keyframe so
  // the spring rise/fall never knocks it off-center.
  function hideToast(t) {
    t = t || $('#toast');
    mStop(toastAnim);
    const done = () => { t.hidden = true; };
    const a = mAnim(t,
      { opacity: [1, 0], transform: ['translateX(-50%) translateY(0)', 'translateX(-50%) translateY(10px)'] },
      { duration: 0.2, easing: 'ease-in' }, done);
    toastAnim = a;
    if (a && a.finished) a.finished.then(done, done); else if (!a) done();
  }
  function showToast(msg, onUndo) {
    const t = $('#toast');
    mStop(toastAnim);
    $('#toast-msg').textContent = msg;
    $('#toast-undo').hidden = !onUndo;
    $('#toast-undo').onclick = () => { if (onUndo) onUndo(); hideToast(t); };
    t.hidden = false;
    toastAnim = mAnim(t,
      { opacity: [0, 1], transform: ['translateX(-50%) translateY(14px) scale(.96)', 'translateX(-50%) translateY(0) scale(1)'] },
      { spring: 'pop' });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hideToast(t), 5000);
  }

  async function openQuickLog() {
    if (!qsState.grade && state.climbs.length) {
      const last = state.climbs[state.climbs.length - 1];
      qsState.discipline = last.discipline;
      qsState.grade = last.grade;
    }
    // During a match, pull the live state BEFORE rendering so the recent list's
    // delete affordance is current: your latest climb is only deletable until the
    // opponent responds, and the dock's 3s poll could otherwise leave a stale
    // "deletable" row for a few seconds after they do. Fetch directly (the dock
    // refresh skips when a poll is mid-flight). (Also lands point chips on the
    // first open right after accept.)
    if (cloudOn() && matches.active) {
      try { const { data } = await sb.rpc('match_state', { mid: matches.active.id }); if (data) mdState = data; } catch (e) { /* keep last-known state */ }
    }
    renderQuickLog();
    quickSheet.hidden = false;
    animOverlayIn(quickSheet);
    // Bring the selected grade into view once the sheet has laid out
    const active = $('#qs-grades .qs-grade.is-active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderQuickLog() {
    // During a live match the discipline is already decided, so we don't offer
    // the others at all: show only the discipline(s) that count, and when it's a
    // single one, drop the chooser entirely (the match screen already states it).
    // Agnostic route matches keep both Sport and Top Rope as a real chooser.
    const qsLive = matchLive();
    const qsAllowed = qsLive ? MATCH_DISCS[qsLive.rules.discipline] : null;
    if (qsAllowed && !qsAllowed.includes(qsState.discipline)) qsState.discipline = qsAllowed[0];
    const qsDiscs = qsAllowed || ALL_DISCIPLINES;
    const discRow = $('#qs-disciplines');
    discRow.hidden = !!(qsAllowed && qsAllowed.length < 2);
    discRow.innerHTML = qsDiscs.map((d) =>
      `<button type="button" class="qs-tab${d === qsState.discipline ? ' is-active' : ''}" data-d="${d}">${d === 'Bouldering' ? 'Boulder' : d}</button>`
    ).join('');
    $$('#qs-disciplines .qs-tab').forEach((b) => b.addEventListener('click', () => {
      qsState.discipline = b.dataset.d;
      if (!gradesFor(qsState.discipline).includes(qsState.grade)) qsState.grade = null;
      saveQs();
      renderQuickLog();
    }));

    // During a live match, every grade pill shows what a send of it is worth
    // for YOU (par points — knowable before you climb, so you can strategize).
    $('#qs-grades').innerHTML = gradesFor(qsState.discipline).map((g) => {
      const p = matchPointsFor(qsState.discipline, g);
      const chip = p == null ? '' : `<span class="qs-pts${p === 0 ? ' zero' : ''}">${p === 0 ? '0' : '+' + p}</span>`;
      return `<button type="button" class="qs-grade${g === qsState.grade ? ' is-active' : ''}" data-g="${escapeHTML(g)}">${escapeHTML(g)}${chip}</button>`;
    }).join('');
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

    // The recent list — "tap to fix a mistake". In a live match it shows ONLY
    // this match's climbs (mine, in the match discipline, logged since the
    // match window opened — mirroring the server's membership rule) and each
    // row DELETES (with undo) instead of opening the full edit form, which is
    // kept out of matches. Outside a match it's today's climbs in the active
    // rating group, and a row opens the edit modal.
    let recent, recentLabel, canDelLatest = false;
    if (qsLive) {
      const start = new Date(qsLive.window_start).getTime();
      recent = state.climbs
        .filter((c) => qsAllowed.includes(c.discipline) && c.created_at && new Date(c.created_at).getTime() >= start)
        .slice(-3).reverse();
      recentLabel = 'This SendOff';
      // Match scoring re-derives the whole turn-walk from the current climbs, so
      // deleting a mid-sequence climb could un-count the OPPONENT's next climb.
      // Only your latest climb is safe to remove, and only while it's still the
      // global tail — i.e. the opponent hasn't logged a counting climb since. Once
      // they respond, every row is read-only.
      const them = matchTheirSide(qsLive);
      canDelLatest = qsLive.status === 'active' && recent.length > 0
        && (!them.last || !them.last.at || new Date(recent[0].created_at).getTime() > new Date(them.last.at).getTime());
    } else {
      const grp = ratingGroup(qsState.discipline);
      recent = state.climbs
        .filter((c) => c.date === todayISO() && ratingGroup(c.discipline) === grp)
        .slice(-3).reverse();
      recentLabel = 'Today';
    }
    $('#qs-recent').innerHTML = recent.length
      ? `<span class="qs-recent-label">${recentLabel}</span>` + recent.map((c, i) => {
        const del = qsLive && i === 0 && canDelLatest;   // only the safe latest match row deletes
        const edit = !qsLive;                             // non-match rows open the editor
        const cls = del ? ' is-del' : (qsLive ? ' is-static' : '');
        const icon = del ? '<svg class="ico"><use href="#i-x"/></svg>' : edit ? '<svg class="ico"><use href="#i-pencil"/></svg>' : '';
        return `<button type="button" class="qs-recent-row${cls}" data-id="${escapeHTML(String(c.id))}"${del ? ' data-del="1"' : ''}${edit ? ' data-edit="1"' : ''}>
            ${escapeHTML(c.grade)} · ${escapeHTML(c.result)} ${icon}
          </button>`;
      }).join('')
      : '';
    $$('#qs-recent .qs-recent-row').forEach((b) => b.addEventListener('click', () => {
      const c = state.climbs.find((x) => String(x.id) === b.dataset.id);
      if (!c) return;
      if (b.dataset.del) { removeMatchClimb(c); return; }
      if (b.dataset.edit) { quickSheet.hidden = true; openEditClimb(c); }
      // read-only match rows: no action
    }));

    $$('#quick-sheet .qs-result').forEach((b) => { b.disabled = !qsState.grade; });

    // The "More detail" form lets you change discipline/attempts/grade in ways
    // that may not count toward the match — during a live match we hide it and
    // keep logging on the fast, match-aware path.
    const detailBtn = $('#qs-detail');
    if (detailBtn) detailBtn.hidden = !!qsLive;

    // Match strip: whose turn it is and whether this sheet's discipline counts.
    const note = $('#qs-match-note');
    if (note) {
      const live = matchLive();
      const discs = live ? MATCH_DISCS[live.rules.discipline] : null;
      if (!live || !discs || !discs.includes(qsState.discipline)) { note.hidden = true; }
      else {
        const me = matchMySide(live), them = matchTheirSide(live), bn = live.rules.best_n;
        note.hidden = false;
        const theirLast = matchLastLine(them);
        if (bn && me.counted != null && me.counted >= bn) note.textContent = `SendOff · your ${bn} slots are full — climbs log as session only.`;
        else if (me.can_log === false) note.textContent = `SendOff · ${them.name}'s turn — climbs log as session only.`;
        else if (me.par_d == null) note.textContent = 'SendOff · your turn — your first send sets your par: any send scores 3, flash +1.';
        else if (theirLast) note.textContent = `SendOff · ${them.name} ${theirLast} — your turn.`;
        else note.textContent = 'SendOff · your turn — each grade shows its points, flash +1.';
      }
    }
  }

  function quickSaveClimb(discipline, grade, result) {
    const entry = {
      date: todayISO(), discipline, grade,
      attempts: result === 'Project' ? 2 : 1, // a project implies more than one go
      result, location: '', notes: '',
      // Stamp a client timestamp so the optimistic row passes the match-window
      // filter before the server round-trip; the synced row replaces it via
      // fromClimb(data). climbRow() ignores this field, so the insert still
      // lets the DB default created_at = now().
      created_at: new Date().toISOString()
    };
    // Predict whether this climb will COUNT toward the live match (turns/slots/
    // discipline). Client-side prediction from the last poll; the server's walk
    // is the truth and the next poll reconciles a rare race.
    const live = matchLive();
    const inDisc = !!(live && (MATCH_DISCS[live.rules.discipline] || []).includes(discipline));
    const willCount = inDisc && matchMySide(live).can_log === true;
    withSync(async () => {
      await Store.addClimb(entry);
      renderClimbing();
      renderDashboard();
      const added = state.climbs[state.climbs.length - 1];
      let toastMsg = `${grade} ${result} ✓`;
      if (live && inDisc && !willCount) {
        const me = matchMySide(live), them = matchTheirSide(live), bn = live.rules.best_n;
        toastMsg += bn && me.counted != null && me.counted >= bn
          ? ' — session only (SendOff slots full)'
          : ` — session only (${them.name}'s turn)`;
      }
      showToast(toastMsg, () => {
        withSync(async () => {
          await Store.delClimb(added.id);
          renderClimbing(); renderDashboard(); renderQuickLog();
        });
      });
      qsState.discipline = discipline;
      qsState.grade = grade;
      saveQs();
      renderQuickLog(); // refresh the Today list
      // my own climb won't come back over realtime — refresh the live match views
      if (typeof refreshMatchDock === 'function' && matches.active) refreshMatchDock();
      if (h2hMid) refreshH2H();
      // A COUNTING match climb drops the sheet, RETURNS TO THE HEAD-TO-HEAD
      // (wherever you logged from — dock, hub, FAB) and fires the stick-figure
      // moment over it. A session-only climb during a match keeps the sheet
      // open and stays quiet. If the live state isn't known yet (first poll
      // pending), fall back to the old always-close behavior.
      if (matches.active && (live == null || willCount)) {
        quickSheet.hidden = true;
        if (!h2hMid) openH2H(matches.active.id);
        playMatchAnim({
          type: result === 'Project' ? 'fail' : 'send',
          grade, discipline, magnitude: maMagnitude(discipline, grade)
        });
      }
    });
  }

  // Remove a match climb straight from the recent list — no edit modal. Deletes
  // the climb (freeing its slot / adjusting the score), keeps the h2h in sync,
  // and offers Undo, which re-logs it. Mirrors quickSaveClimb's undo path.
  async function removeMatchClimb(c) {
    // Safety re-verify against FRESH server state before removing. Match scoring
    // re-derives the whole turn-walk, so only your LATEST climb — and only while
    // the opponent hasn't logged a counting climb since — is safe to remove
    // without un-counting THEIR climb. The on-screen affordance can lag the ~3s
    // poll, so never trust it for the act itself.
    if (matches.active) {
      try {
        const { data: s, error } = await sb.rpc('match_state', { mid: matches.active.id });
        if (!error && s) {
          mdState = s; // adopt fresh state
          const discs = MATCH_DISCS[s.rules && s.rules.discipline] || [];
          const them = s.i_am === 'challenger' ? s.opponent : s.challenger;
          const start = new Date(s.window_start).getTime();
          const mine = state.climbs
            .filter((x) => discs.includes(x.discipline) && x.created_at && new Date(x.created_at).getTime() >= start)
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
          const latest = mine[mine.length - 1];
          const safe = s.status === 'active' && latest && String(latest.id) === String(c.id)
            && (!them.last || !them.last.at || new Date(latest.created_at).getTime() > new Date(them.last.at).getTime());
          if (!safe) {
            renderQuickLog();
            if (h2hMid) refreshH2H();
            showToast('Can’t remove — the SendOff has moved on');
            return;
          }
        }
      } catch (e) { /* offline / RPC failure: fall through to the optimistic delete */ }
    }
    const label = `${c.grade} · ${c.result}`;
    const restore = { date: c.date, discipline: c.discipline, grade: c.grade, attempts: c.attempts, result: c.result, location: c.location || '', notes: c.notes || '', color: c.color || '', created_at: c.created_at };
    withSync(async () => {
      await Store.delClimb(c.id);
      renderClimbing(); renderDashboard(); renderQuickLog();
      if (typeof refreshMatchDock === 'function' && matches.active) refreshMatchDock();
      if (h2hMid) refreshH2H();
    });
    showToast(`Removed ${label}`, () => {
      withSync(async () => {
        await Store.addClimb(restore);
        renderClimbing(); renderDashboard(); renderQuickLog();
        if (typeof refreshMatchDock === 'function' && matches.active) refreshMatchDock();
        if (h2hMid) refreshH2H();
      });
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
     Match animations — a stick-figure "moment" (send / fail / receive) that
     plays ONLY during a live match, AFTER the climb is saved. SVG + CSS only;
     it never blocks logging (top-of-screen card, taps pass to the sheet below),
     is skippable (tap the card), collapses an offline backlog into a summary,
     and honors reduced-motion. Layer on top — it touches no scoring or the
     fast-log path. Markup/timings pair with the ".ma-*" rules in styles.css.
     ====================================================================== */
  let maTimers = [];
  let maAnims = []; // live Motion controls for the current card, stopped on teardown
  const maClear = () => {
    maTimers.forEach(clearTimeout); maTimers = [];
    maAnims.forEach(mStop); maAnims = [];
  };
  // Card-level Motion beats (spring entrance, "fired a message" fling, receive
  // slide-out). Motion owns ONLY the card transform (via the .ma-mo class, which
  // suppresses the CSS card keyframes); the internal figure/confetti/FX stay CSS.
  function maCardIn(card, recv) {
    const kf = recv
      ? { opacity: [0, 1], transform: ['translateX(60px) scale(.85)', 'translateX(0) scale(1)'] }
      : { opacity: [0, 1], transform: ['translateY(-14px) scale(.86)', 'translateY(0) scale(1)'] };
    const a = mAnim(card, kf, { spring: recv ? 'bouncy' : 'pop' });
    if (a) maAnims.push(a);
  }
  function maFling(card) {
    // a hair of wind-up, then hurl the card toward the opponent (top-right)
    const a = mAnim(card,
      { transform: ['translateY(0) rotate(0deg) scale(1)', 'translate(62vw,-26vh) rotate(20deg) scale(.18)'], opacity: [1, 0] },
      { duration: 0.6, easing: [0.5, -0.25, 0.85, 0.35] });
    if (a) maAnims.push(a);
  }
  function maRecvOut(card) {
    const a = mAnim(card,
      { transform: ['translateX(0) scale(1)', 'translateX(-22px) translateY(-10px) scale(.9)'], opacity: [1, 0] },
      { duration: 0.4, easing: 'ease-in' });
    if (a) maAnims.push(a);
  }
  function maReduced() {
    if (typeof window.__REDUCED !== 'undefined') return !!window.__REDUCED; // test hook
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }
  const maGroup = (disc) => (disc === 'Bouldering' ? 'boulder' : 'rope');
  const maDiscOf = (grade) => (/^v/i.test(grade || '') ? 'Bouldering' : 'Sport');
  // How hard was it, relative to YOUR level → 1..3 (existing data, no new scoring).
  function maMagnitude(disc, grade) {
    try {
      const base = SS_BASE + (disc === 'Bouldering' ? 0 : SS_ROPE_OFFSET);
      const R = (climberRating(maGroup(disc)) || {}).rating || base;
      const delta = routeRating(disc, grade) - R;
      return delta >= 60 ? 3 : delta >= -40 ? 2 : 1;
    } catch (e) { return 2; }
  }
  // Bright, celebratory — deliberately NOT the wall-hold colors (orange/navy),
  // so the confetti pops against them instead of reading as holds falling off.
  const MA_CONFETTI = ['#ffd23f', '#e0459b', '#22c1c3', '#7ee06a', '#e2574c', '#a06bff'];
  // Distinct stick-figure poses (swapped over the body timeline so each beat
  // reads): reaching-climb, arms-up top-out, airborne flail, dazed splat.
  const MA_POSES = {
    climb: '<g class="pose pose-climb"><circle class="hd" cx="23" cy="12" r="5"/><path class="ln" d="M23 17 L22 34"/><path class="ln" d="M23 20 L14 8"/><path class="ln" d="M23 22 L31 18"/><path class="ln" d="M22 34 L14 43"/><path class="ln" d="M22 34 L28 49"/></g>',
    top: '<g class="pose pose-top"><circle class="hd" cx="23" cy="11" r="5"/><path class="ln" d="M23 16 L23 35"/><path class="ln" d="M23 19 L13 7"/><path class="ln" d="M23 19 L33 7"/><path class="ln" d="M23 35 L18 50"/><path class="ln" d="M23 35 L28 50"/></g>',
    fall: '<g class="pose pose-fall"><circle class="hd" cx="23" cy="15" r="5"/><path class="ln" d="M23 20 L23 34"/><path class="ln" d="M23 23 L11 17"/><path class="ln" d="M23 23 L35 17"/><path class="ln" d="M23 34 L12 45"/><path class="ln" d="M23 34 L34 45"/></g>',
    splat: '<g class="pose pose-splat"><circle class="hd" cx="13" cy="42" r="5"/><path class="ln" d="M18 43 L35 46"/><path class="ln" d="M23 44 L18 35"/><path class="ln" d="M28 45 L32 37"/><path class="ln" d="M35 46 L42 41"/><path class="ln" d="M35 46 L41 51"/></g>'
  };
  function maFigure(disc, kind) {
    const rope = maGroup(disc) === 'rope' ? ' rope' : '';
    const poses = kind === 'send' ? MA_POSES.climb + MA_POSES.top
      : kind === 'fail' ? MA_POSES.climb + MA_POSES.fall + MA_POSES.splat
        : kind === 'recv-fail' ? MA_POSES.splat : MA_POSES.top;
    return `<div class="ma-figure${rope}"><svg class="ma-climber" viewBox="0 0 46 58" aria-hidden="true">${poses}</svg></div>`;
  }
  function maHolds() {
    const pos = [[18, 24, ''], [70, 34, 'b'], [30, 62, 'b'], [86, 72, ''], [50, 98, ''], [16, 90, 'b'], [90, 104, '']];
    return pos.map((p) => `<span class="ma-hold ${p[2]}" style="left:${p[0]}px;top:${p[1]}px"></span>`).join('');
  }
  // The one entry point. opts: { type:'send'|'fail'|'receive', grade, discipline,
  // magnitude, variant:'send'|'fail' (receive), summary, count, from }.
  function playMatchAnim(opts) {
    const host = $('#match-anim'); if (!host) return;
    maClear();
    const reduced = maReduced();
    const recv = opts.type === 'receive';
    const fail = opts.type === 'fail' || (recv && opts.variant === 'fail');
    const disc = opts.discipline || (recv ? maDiscOf(opts.grade) : 'Bouldering');
    const mag = opts.magnitude || 2;
    const gradeHTML = opts.grade ? ` <span class="ma-grade">${escapeHTML(opts.grade)}</span>` : '';

    let title, tail = '';
    if (opts.summary) { title = `${opts.count} sends`; tail = opts.grade ? `hardest${gradeHTML}` : ''; }
    else if (recv) { title = fail ? 'came off' : 'sent'; tail = gradeHTML; }
    else if (fail) { title = 'Whipped!'; tail = gradeHTML; }
    else { title = mag >= 3 ? 'Big send!' : 'Sent!'; tail = gradeHTML; }

    let cls = 'ma-card ' + (fail ? 'ma-fail' : 'ma-send');
    if (recv) cls += ' ma-receive ' + (fail ? 'recv-fail' : 'recv-send');
    else cls += ` ma-mag-${mag}`;

    let stageHTML;
    if (reduced || opts.summary) {
      cls += ' ma-reduced';
      const mark = opts.summary ? '➔' : (fail ? '✕' : '✓');
      stageHTML = `<div class="ma-stage"><span class="ma-mark">${mark}</span></div>`;
    } else {
      const kind = recv ? ('recv-' + (fail ? 'fail' : 'send')) : (fail ? 'fail' : 'send');
      let fx;
      if (fail) {
        // a dust puff on impact, dazed stars orbiting the fallen head, then a
        // red X stamped over the splat a beat later
        fx = '<span class="ma-dust"></span><span class="ma-star" style="left:10%;top:56%">⭐</span><span class="ma-star" style="left:22%;top:42%;animation-delay:1.36s">✦</span><span class="ma-star" style="left:33%;top:56%;animation-delay:1.48s">⭐</span><span class="ma-star" style="left:20%;top:64%;animation-delay:1.6s">✨</span><div class="ma-x">✕</div>';
      } else {
        const n = recv ? 8 : (mag === 3 ? 28 : mag === 2 ? 16 : 8);
        let conf = mag >= 3 && !recv ? '<span class="ma-flash"></span>' : '';
        for (let i = 0; i < n; i++) {
          const dx = Math.round(Math.random() * 170 - 85), dy = Math.round(-(Math.random() * 72 + 22));
          const delay = (recv ? 0.3 : 0.9) + (i % 6) * 0.028;
          conf += `<span class="ma-confetti" style="--dx:${dx}px;--dy:${dy}px;background:${MA_CONFETTI[i % MA_CONFETTI.length]};animation-delay:${delay}s"></span>`;
        }
        fx = conf;
      }
      stageHTML = `<div class="ma-stage">${maHolds()}${maFigure(disc, kind)}<div class="ma-fx">${fx}</div></div>`;
    }
    const fromHTML = recv ? `<span class="ma-from">${escapeHTML(opts.from || 'Opponent')}</span>` : '';
    host.innerHTML = `<div class="${cls}" role="status">${fromHTML}${stageHTML}<div class="ma-label"><b>${escapeHTML(title)}</b>${tail}</div></div>`;
    host.hidden = false; host.setAttribute('aria-hidden', 'false');
    const card = host.firstElementChild;
    const dismiss = () => { maClear(); host.hidden = true; host.innerHTML = ''; host.setAttribute('aria-hidden', 'true'); };
    card.addEventListener('click', dismiss); // tap to skip

    // Motion drives the card-level beats with real springs when available; the
    // calm summary/reduced card keeps its gentle CSS fade. ma-mo suppresses the
    // CSS card keyframes so the two engines never fight over the transform.
    const useMotion = motionOK() && !opts.summary;
    if (useMotion) { card.classList.add('ma-mo'); maCardIn(card, recv); }

    if (recv || reduced || opts.summary) {
      const dur = recv ? 2300 : 1500;
      if (recv) maTimers.push(setTimeout(() => {
        if (useMotion) maRecvOut(card); else card.classList.add('ma-recv-out');
      }, dur - 400));
      maTimers.push(setTimeout(dismiss, dur));
    } else {
      // send/fail: after the climb + top-out / crash, whisk the whole card off
      // toward the opponent (the "fired a message" swoosh).
      const swooshAt = fail ? 2050 : 1500;
      const dur = fail ? 2750 : 2250;
      maTimers.push(setTimeout(() => {
        if (useMotion) maFling(card); else card.classList.add('ma-swooshing');
      }, swooshAt));
      maTimers.push(setTimeout(dismiss, dur));
    }
  }

  // Receive detection off the opponent's climb_session activity (existing data):
  // a per-day session summary carrying { sends, attempts, hardest }. We baseline
  // at match start and animate the DELTA — +1 send → a send moment; an extra
  // attempt with no new send → a fall; a jump of ≥2 (an offline backlog arriving
  // at once) collapses into a single summary, never a stack of animations.
  let maSeen = { matchId: null, sends: 0, attempts: 0 };
  const maToday = (i) => i.user_id && i.kind === 'climb_session' && i.occurred_on === todayISO();
  function maSetBaseline(active) {
    // A match is a today event, so only today's session counts as the opponent's
    // starting point (0 if they haven't climbed yet today).
    const it = feedItems.find((i) => i.user_id === active.opponent && maToday(i));
    const p = (it && it.payload) || {};
    maSeen = { matchId: active.id, sends: p.sends || 0, attempts: p.attempts || 0 };
  }
  function maReceive(item) {
    const a = matches.active;
    if (!a || !item || item.user_id !== a.opponent || !maToday(item)) return;
    if (maSeen.matchId !== a.id) { maSetBaseline(a); return; } // first sighting → baseline only
    const p = item.payload || {};
    const s = p.sends || 0, at = p.attempts || 0;
    const dS = s - maSeen.sends, dA = at - maSeen.attempts;
    maSeen.sends = s; maSeen.attempts = at;
    if (dS <= 0 && dA <= 0) return;
    if (dS >= 2) playMatchAnim({ type: 'receive', summary: true, count: dS, grade: p.hardest, from: a.opponent_name });
    else if (dS === 1) playMatchAnim({ type: 'receive', variant: 'send', grade: p.hardest, from: a.opponent_name });
    else if (dA >= 1) playMatchAnim({ type: 'receive', variant: 'fail', grade: p.hardest || null, from: a.opponent_name });
  }
  // Also catch a backlog that arrives via a feed refresh on reconnect (not a
  // single realtime event) — idempotent: no delta → nothing plays.
  function maScanReceive() {
    const a = matches.active; if (!a) { maSeen.matchId = null; return; }
    const it = feedItems.find((i) => i.user_id === a.opponent && maToday(i));
    if (it) maReceive(it);
  }

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
    animOverlayIn(routineModal);
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
      if (rc.change !== 0) rcEl.classList.add(rc.change > 0 ? 'up' : 'down');
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
              r.hardest ? `hardest ${escapeHTML(r.hardest)}` : '',
              r.provisional ? 'provisional' : ''
            ].filter(Boolean).join(' · ');
            return `
            <li class="${r.is_me ? 'me' : ''}" title="See ${escapeHTML(r.display_name)}'s summary">
              <div class="feed-left">
                <span class="lb-rank${i < 3 ? ' r' + (i + 1) : ''}">${i + 1}</span>
                ${avatarHTML(r.user_id, r.display_name, 'sm', r.avatar_v)}
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
      sweepAvatars();
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

  /* ======================================================================
     Friends + activity feed.

     A social layer on top of the same Supabase backend. Friendship is the
     permission boundary — enforced SERVER-SIDE by RLS + SECURITY DEFINER RPCs
     (see supabase-schema.sql); the client never sees a non-friend's data.

     The feed is READ-ONLY and fully isolated from the local-first logging
     path: every call is cloudOn()-gated and its failures are swallowed, so a
     flaky feed never blocks or slows logging. Realtime uses Supabase Realtime
     (websockets) with RLS-authorized postgres_changes — chosen because it's
     native to the stack and reuses the existing auth session, delivering new
     friend activity in well under the 10s bar. If the socket drops we show a
     subtle "reconnecting" indicator, fall back to an ~8s poll, and render the
     last cached items until it recovers on its own.
     ====================================================================== */
  const FEED_CACHE_KEY = 'gymtrack.feedcache.v1';
  let friends = { me: null, list: [], requests: [] };
  let feedItems = [];
  let feedChannel = null, feedStatus = 'idle', feedPollTimer = null, searchTimer = null;
  const myUid = () => (session && session.user ? session.user.id : null);

  function feedCacheLoad() {
    try { const c = JSON.parse(localStorage.getItem(FEED_CACHE_KEY)); return c && c.userId === myUid() ? c.items : null; } catch (e) { return null; }
  }
  function feedCacheSave() {
    try { localStorage.setItem(FEED_CACHE_KEY, JSON.stringify({ userId: myUid(), items: feedItems.slice(0, 50) })); } catch (e) {}
  }
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const friendRating = (userId) => { const f = friends.list.find((x) => x.user_id === userId); return f && f.boulder != null ? f.boulder : (f && f.rope != null ? f.rope : null); };

  // Headline text for one sanitized activity item.
  function feedLine(it) {
    const p = it.payload || {};
    const who = escapeHTML(it.display_name || 'Climber');
    if (it.kind === 'match_result') {
      const opp = escapeHTML(p.opponent || 'a friend');
      const verb = p.result === 'won' ? `beat ${opp}` : p.result === 'lost' ? `lost to ${opp}` : `drew with ${opp}`;
      const chg = p.delta ? ` · <span class="${p.delta > 0 ? 'pr-flag' : ''}" style="${p.delta < 0 ? 'color:var(--danger);font-weight:700' : ''}">${p.delta > 0 ? '+' : ''}${p.delta}</span>` : '';
      return { ico: 'i-bolt', cls: '', main: `${who} ${verb}`, sub: `SendOff${chg}` };
    }
    if (it.kind === 'lift_session') {
      const parts = [`${p.exercises || 0} exercise${p.exercises === 1 ? '' : 's'}`];
      if (p.volume) parts.push(`${Math.round(p.volume).toLocaleString()} ${escapeHTML(p.unit || 'lbs')}`);
      if (p.top_exercise) parts.push(escapeHTML(p.top_exercise));
      return { ico: 'i-barbell', cls: '', main: `${who} lifted`, sub: parts.join(' · ') };
    }
    const bits = [`${p.sends || 0} send${p.sends === 1 ? '' : 's'}`];
    if (p.hardest) bits.push(`hardest ${escapeHTML(p.hardest)}`);
    let sub = bits.join(' · ');
    if (p.new_hardest) sub += ' · <span class="pr-flag">new PR!</span>';
    return { ico: 'i-mountain', cls: 'climb', main: `${who} climbed`, sub };
  }
  function renderFeedInto(el, items) {
    if (!el) return;
    el.innerHTML = items.length ? items.map((it) => {
      const L = feedLine(it);
      const r = friendRating(it.user_id);
      return `<li>
        <div class="feed-left">
          <span class="feed-av">${avatarHTML(it.user_id, it.display_name, 'sm', it.avatar_v)}<span class="feed-ico-badge ${L.cls}"><svg class="ico"><use href="#${L.ico}"/></svg></span></span>
          <div><div class="feed-main">${L.main}</div><div class="feed-sub">${L.sub}</div></div>
        </div>
        <div class="feed-date">${ago(it.created_at)}${r != null ? `<span class="feed-score">${r}</span>` : ''}</div>
      </li>`;
    }).join('') : '<li class="empty">No friend activity yet.</li>';
  }
  function renderFeeds() {
    const show = cloudOn() && (feedItems.length || friends.list.length);
    const dash = $('#friends-feed-panel'), climb = $('#friends-feed-climb-panel');
    if (dash) dash.hidden = !show;
    if (climb) climb.hidden = !show;
    renderFeedInto($('#friends-feed'), feedItems);
    renderFeedInto($('#friends-feed-climb'), feedItems.filter((i) => i.kind === 'climb_session'));
    sweepAvatars();
    const stale = feedStatus === 'stale';
    ['#friends-feed-stale', '#friends-feed-climb-stale'].forEach((s) => { const e = $(s); if (e) e.hidden = !stale; });
  }

  async function loadFeed() {
    if (!cloudOn()) { feedItems = []; renderFeeds(); return; }
    const cached = feedCacheLoad();
    if (cached && !feedItems.length) { feedItems = cached; renderFeeds(); }
    try {
      const { data, error } = await sb.rpc('friend_feed', { surface: 'all', before_ts: null, before_id: null, lim: 30 });
      if (error) throw error;
      feedItems = (data || []).map((r) => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
      feedCacheSave();
      // A successful load means we're reachable again; clear the stale state
      // (unless the realtime socket itself is down and will re-flag it).
      if (feedStatus === 'stale') feedStatus = feedChannel ? 'live' : 'idle';
      stopFeedPoll();
      renderFeeds();
      maScanReceive(); // a reconnect may bring the opponent's backlog → collapse it
    } catch (e) {
      // Offline or dropped: keep the cached items on screen, show the stale
      // badge, and poll until we recover. Logging is untouched by any of this.
      console.warn('Feed unavailable:', e);
      feedStatus = 'stale';
      startFeedPoll();
      renderFeeds();
    }
  }

  // A person row (search result, request, or friend), with the right actions.
  // The @handle and Send Score live on a sub-line under the name — the actions
  // column is flex-shrink:0, so anything inline with the name gets overlapped
  // on narrow phones (score used to render on top of the handle).
  function personRow(p, rel) {
    const name = escapeHTML(p.display_name || 'Climber');
    const score = rel === 'friends' ? (p.boulder != null ? p.boulder : p.rope) : null;
    const subBits = [];
    if (p.username) subBits.push(`<span class="feed-handle">@${escapeHTML(p.username)}</span>`);
    if (score != null) subBits.push(`<span class="feed-score inl">${score}</span>`);
    const sub = subBits.length ? `<div class="feed-sub">${subBits.join(' · ')}</div>` : '';
    let right = '';
    if (rel === 'friends') {
      right = `<button class="btn primary sm" data-mchal="${p.user_id}">Challenge</button><button class="btn ghost sm" data-fact="unfriend" data-uid="${p.user_id}">Unfriend</button>`;
    } else if (rel === 'outgoing') {
      right = `<span class="rel-chip">Requested</span><button class="btn ghost sm" data-fact="cancel" data-uid="${p.user_id}">Cancel</button>`;
    } else if (rel === 'incoming') {
      right = `<button class="btn primary sm" data-fact="accept" data-uid="${p.user_id}">Accept</button><button class="btn ghost sm" data-fact="decline" data-uid="${p.user_id}">Decline</button>`;
    } else if (rel === 'self') {
      right = `<span class="rel-chip">You</span>`;
    } else {
      right = `<button class="btn primary sm" data-fact="request" data-uid="${p.user_id}">Add</button>`;
    }
    return `<li>
      <div class="feed-left">
        ${avatarHTML(p.user_id, p.display_name, 'sm', p.avatar_v)}
        <div><div class="feed-main">${name}</div>${sub}</div>
      </div>
      <div class="feed-actions">${right}</div>
    </li>`;
  }

  function renderFriendsScreen() {
    const note = $('#friends-auth-note'), body = $('#friends-body');
    if (!cloudOn()) { if (note) note.hidden = false; if (body) body.hidden = true; updateFriendsBadge(); return; }
    if (note) note.hidden = true; if (body) body.hidden = false;
    const ui = $('#username-input');
    if (ui && friends.me && friends.me.username && document.activeElement !== ui && !ui.value) ui.value = friends.me.username;
    const reqPanel = $('#friend-requests-panel'), reqList = $('#friend-requests-list');
    if (reqList) {
      reqPanel.hidden = !friends.requests.length;
      reqList.innerHTML = friends.requests.map((r) => personRow(r, r.direction === 'incoming' ? 'incoming' : 'outgoing')).join('');
    }
    const fl = $('#friends-list');
    if (fl) fl.innerHTML = friends.list.length ? friends.list.map((f) => personRow(f, 'friends')).join('') : '<li class="empty">No friends yet — search above to add some.</li>';
    renderMatchesPanel();
    updateFriendsBadge();
    sweepAvatars();
  }
  function updateFriendsBadge() {
    const inc = friends.requests.filter((r) => r.direction === 'incoming').length + matches.incoming.length;
    const b = $('#friends-badge'); if (b) { b.hidden = !inc; b.textContent = inc || ''; }
  }

  async function loadFriends() {
    if (!cloudOn()) { friends = { me: null, list: [], requests: [] }; renderFriendsScreen(); return; }
    try {
      const [me, list, reqs] = await Promise.all([
        sb.from('profiles').select('username, display_name').eq('id', myUid()).maybeSingle(),
        sb.rpc('friend_list'),
        sb.rpc('friend_requests')
      ]);
      friends.me = (me && me.data) || null;
      friends.list = (list && list.data) || [];
      friends.requests = (reqs && reqs.data) || [];
    } catch (e) { console.warn('Friends unavailable:', e); }
    renderFriendsScreen();
    renderFeeds(); // ratings may have arrived
    renderMatchHub(); // the hub's idle CTA depends on whether you have friends
  }

  async function friendAct(fact, targetUid) {
    if (!cloudOn() || !targetUid) return null;
    let result = null, failed = false;
    try {
      const rpc = fact === 'request' ? sb.rpc('friend_request', { target: targetUid })
        : fact === 'accept' ? sb.rpc('friend_respond', { other: targetUid, accept: true })
        : fact === 'decline' ? sb.rpc('friend_respond', { other: targetUid, accept: false })
        : fact === 'cancel' ? sb.rpc('friend_cancel', { other: targetUid })
        : fact === 'unfriend' ? sb.rpc('unfriend', { other: targetUid })
        : null;
      if (rpc) { const { data, error } = await rpc; if (error) throw error; result = data; }
    } catch (e) { console.warn('Friend action failed:', e); failed = true; }
    await loadFriends();
    await loadFeed();
    // The search box only exists on the Friends screen; this runs from the
    // leaderboard too, so guard it.
    const fs = $('#friend-search');
    if (fs && fs.value.trim().length >= 2) runFriendSearch();
    return failed ? { error: true } : { result };
  }

  async function runFriendSearch() {
    const q = $('#friend-search').value.trim();
    const box = $('#friend-search-results');
    if (!box) return;
    if (q.length < 2 || !cloudOn()) { box.innerHTML = ''; return; }
    try {
      const { data, error } = await sb.rpc('friend_search', { q });
      if (error) throw error;
      box.innerHTML = (data && data.length)
        ? data.map((p) => personRow(p, p.relationship === 'none' ? 'none' : p.relationship)).join('')
        : '<li class="empty">No climbers found.</li>';
    } catch (e) { console.warn('Search failed:', e); box.innerHTML = ''; }
  }

  // ---- Realtime: new friend activity within seconds; graceful degradation ----
  function onRealtimeActivity(row) {
    if (!row || row.user_id === myUid()) return;
    const f = friends.list.find((x) => x.user_id === row.user_id);
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const item = { id: row.id, user_id: row.user_id, kind: row.kind, occurred_on: row.occurred_on, created_at: row.created_at, payload, username: f && f.username, display_name: (f && f.display_name) || 'Climber' };
    feedItems = [item, ...feedItems.filter((i) => i.id !== item.id && !(i.user_id === item.user_id && i.kind === item.kind && i.occurred_on === item.occurred_on))].slice(0, 50);
    feedCacheSave();
    renderFeeds();
    if (h2hMid) refreshH2H(); // opponent logged during our match → refresh the live score
    if (matches.active) refreshMatchDock(); // and the docked bar's live score
    // Incoming result from THE match opponent → play the "message arrived" moment.
    if (matches.active && row.user_id === matches.active.opponent && item.kind === 'climb_session') {
      maReceive(item);
    }
    if (!f) loadFriends(); // a brand-new friend we don't have a name/rating for yet
  }
  function startFeedPoll() { if (feedPollTimer) return; feedPollTimer = setInterval(() => { if (feedStatus !== 'live') { loadFeed(); loadFriends(); } }, 8000); }
  function stopFeedPoll() { if (feedPollTimer) { clearInterval(feedPollTimer); feedPollTimer = null; } }
  function unsubscribeRealtime() { try { if (feedChannel && sb.removeChannel) sb.removeChannel(feedChannel); } catch (e) {} feedChannel = null; }
  function subscribeRealtime() {
    if (!cloudOn() || typeof sb.channel !== 'function' || feedChannel) return;
    try {
      feedChannel = sb.channel('friends-activity')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (p) => onRealtimeActivity(p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'activity' }, (p) => onRealtimeActivity(p.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => { loadFriends(); loadFeed(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => { loadMatches(); if (h2hMid) refreshH2H(); })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') { feedStatus = 'live'; stopFeedPoll(); }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { feedStatus = 'stale'; startFeedPoll(); }
          renderFeeds();
        });
    } catch (e) { console.warn('Realtime unavailable:', e); feedStatus = 'stale'; startFeedPoll(); }
  }

  // Called from refresh(): (re)load friends + feed and ensure a subscription.
  function initFriends() {
    if (!cloudOn()) { unsubscribeRealtime(); stopFeedPoll(); friends = { me: null, list: [], requests: [] }; feedItems = []; feedStatus = 'idle'; matches = { incoming: [], outgoing: [], active: null, history: [] }; matchAdj = { boulder: 0, rope: 0 }; matchesLoaded = false; isAdmin = false; const ae = $('#admin-entry'); if (ae) ae.hidden = true; renderFriendsScreen(); renderFeeds(); renderMatchesPanel(); renderMatchHub(); renderMatchDock(); return; }
    if (!matchesLoaded) renderMatchHub(); // first load → hub skeleton until matches arrive
    loadFriends();
    loadFeed();
    loadMatches();
    loadAdminFlag();
    loadMyAvatar();
    subscribeRealtime();
  }
  async function loadMyAvatar() {
    if (!cloudOn()) { myAvatarV = 0; return; }
    try {
      const { data } = await sb.rpc('avatars_for', { uids: [myUid()] });
      const r = (data || []).find((x) => x.id === myUid());
      myAvatarV = r ? r.v : 0; avatarVer.set(myUid(), myAvatarV);
      renderAccount(); if ($('#view-profile') && $('#view-profile').classList.contains('is-active')) renderProfile();
    } catch (e) { /* offline — header keeps the default/cached */ }
  }

  /* ======================================================================
     Profile-picture editor: tap the avatar → pick → square crop → resize +
     compress to two WebP sizes → upload to Storage → bump version. Remove
     deletes both objects and reverts to the default. Uploads need a connection.
     ====================================================================== */
  const AV_THUMB = 96, AV_FULL = 400, AV_MAX_BYTES = 150 * 1024;
  const avatarOffline = () => !!window.__OFFLINE || navigator.onLine === false;
  let crop = null; // { img, k, base, ox, oy, F }
  function profileStatus(msg, ok) {
    const s = $('#profile-status'); if (!s) return;
    s.textContent = msg || ''; s.hidden = !msg; s.className = 'auth-status' + (ok === false ? ' err' : '');
  }
  function onAvatarTap() {
    if (!cloudOn()) { profileStatus('Sign in to add a profile picture.', false); return; }
    if (avatarOffline()) { profileStatus('You’re offline — connect to change your picture. Your current one still shows.', false); return; }
    profileStatus('');
    $('#avatar-file').click();
  }
  function onAvatarFile(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { profileStatus('That file isn’t a supported image (JPEG, PNG, or WebP).', false); return; }
    if (file.size > 25 * 1024 * 1024) { profileStatus('That image is too large (over 25 MB).', false); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    // Keep the object URL alive for the whole crop session — the visible
    // preview (#crop-img) points at it, and iOS Safari strictly invalidates a
    // revoked blob: URL (desktop Chrome tolerates it from cache), so revoking
    // before the preview loads leaves a broken image. closeCrop() revokes it.
    img.onload = () => openCrop(img, url);
    img.onerror = () => { URL.revokeObjectURL(url); profileStatus('Couldn’t read that image — try another.', false); };
    img.src = url;
  }
  function closeCrop() {
    $('#avatar-crop-modal').hidden = true;
    if (crop && crop.url) URL.revokeObjectURL(crop.url);
    crop = null;
  }
  function openCrop(img, url) {
    const modal = $('#avatar-crop-modal'); modal.hidden = false;
    $('#avatar-crop-status').hidden = true;
    const frameEl = $('#crop-frame');
    const F = frameEl.getBoundingClientRect().width || 260;
    const base = F / Math.min(img.naturalWidth, img.naturalHeight); // cover
    crop = { img, url, base, F, z: 1, k: base, ox: 0, oy: 0 };
    const ie = $('#crop-img'); ie.src = url;
    $('#crop-zoom').value = '1';
    centerCrop(); applyCrop();
  }
  function centerCrop() { crop.k = crop.base * crop.z; crop.ox = (crop.F - crop.img.naturalWidth * crop.k) / 2; crop.oy = (crop.F - crop.img.naturalHeight * crop.k) / 2; }
  function clampCrop() {
    const wk = crop.img.naturalWidth * crop.k, hk = crop.img.naturalHeight * crop.k;
    crop.ox = Math.min(0, Math.max(crop.F - wk, crop.ox));
    crop.oy = Math.min(0, Math.max(crop.F - hk, crop.oy));
  }
  function applyCrop() {
    clampCrop();
    const ie = $('#crop-img');
    ie.style.width = crop.img.naturalWidth * crop.k + 'px';
    ie.style.height = crop.img.naturalHeight * crop.k + 'px';
    ie.style.left = crop.ox + 'px'; ie.style.top = crop.oy + 'px';
  }
  function setZoom(z) {
    const prevK = crop.k; crop.z = Math.max(1, Math.min(4, z)); crop.k = crop.base * crop.z;
    // keep the frame center anchored while zooming
    const cx = crop.F / 2, cy = crop.F / 2;
    crop.ox = cx - (cx - crop.ox) * (crop.k / prevK);
    crop.oy = cy - (cy - crop.oy) * (crop.k / prevK);
    applyCrop();
  }
  async function canvasBlobUnder(canvas, maxBytes) {
    const encode = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
    // Prefer WebP (smallest), then JPEG. The catch: Safari ignores an
    // unsupported encode type and silently hands back a PNG (per the HTML
    // spec) — and a PNG of a photo ignores the quality knob and easily blows
    // past the Storage size cap, which is exactly the "object exceeded the
    // maximum allowed size" rejection. So we only trust a result whose
    // blob.type is the format we actually asked for; otherwise we fall through
    // to JPEG, which every canvas encodes and which honors quality.
    for (const type of ['image/webp', 'image/jpeg']) {
      let smallest = null;
      for (let q = 0.9; q >= 0.4; q -= 0.12) {
        const blob = await encode(type, q);
        if (!blob || blob.type !== type) { smallest = null; break; } // unsupported → next format
        smallest = blob; // each lower-quality step is smaller than the last
        if (blob.size <= maxBytes) return blob;
      }
      if (smallest) return smallest; // supported, but even lowest quality is over cap
    }
    return null;
  }
  function cropToCanvas(dim) {
    const srcSize = crop.F / crop.k, sx = -crop.ox / crop.k, sy = -crop.oy / crop.k;
    const c = document.createElement('canvas'); c.width = dim; c.height = dim;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(crop.img, sx, sy, srcSize, srcSize, 0, 0, dim, dim);
    return c;
  }
  async function saveCrop() {
    const btn = $('#avatar-crop-save'); const st = $('#avatar-crop-status');
    btn.disabled = true; st.hidden = false; st.className = 'auth-status'; st.textContent = 'Processing…';
    try {
      const thumb = await canvasBlobUnder(cropToCanvas(AV_THUMB), AV_MAX_BYTES);
      const full = await canvasBlobUnder(cropToCanvas(AV_FULL), AV_MAX_BYTES);
      if (!thumb || !full) throw new Error('Could not process the image.');
      const uid = myUid();
      st.textContent = 'Uploading…';
      const up1 = await sb.storage.from('avatars').upload(`${uid}/thumb.webp`, thumb, { upsert: true, contentType: thumb.type });
      if (up1.error) throw up1.error;
      const up2 = await sb.storage.from('avatars').upload(`${uid}/full.webp`, full, { upsert: true, contentType: full.type });
      if (up2.error) throw up2.error;
      const { data: nv, error } = await sb.rpc('avatar_set');
      if (error) throw error;
      myAvatarV = nv || (myAvatarV + 1); avatarVer.set(uid, myAvatarV);
      closeCrop();
      renderAccount(); renderProfile(); profileStatus('Profile picture updated ✓', true);
    } catch (e) {
      st.textContent = avatarOffline() ? 'You went offline — try again when connected.' : (errMsg(e) || 'Upload failed.');
      st.className = 'auth-status err';
    } finally { btn.disabled = false; }
  }
  async function removeAvatar() {
    if (avatarOffline()) { profileStatus('You’re offline — connect to remove your picture.', false); return; }
    const uid = myUid();
    try {
      await sb.storage.from('avatars').remove([`${uid}/thumb.webp`, `${uid}/full.webp`]);
      const { error } = await sb.rpc('avatar_clear'); if (error) throw error;
      myAvatarV = 0; avatarVer.set(uid, 0);
      renderAccount(); renderProfile(); profileStatus('Reverted to the default avatar.', true);
    } catch (e) { profileStatus('Couldn’t remove the picture — try again.', false); }
  }
  (function bindAvatarEditor() {
    const av = $('#profile-ava'); if (!av) return;
    av.addEventListener('click', onAvatarTap);
    $('#avatar-remove').addEventListener('click', removeAvatar);
    $('#avatar-file').addEventListener('change', onAvatarFile);
    $('#avatar-crop-cancel').addEventListener('click', closeCrop);
    $('#avatar-crop-modal').addEventListener('click', (e) => { if (e.target.id === 'avatar-crop-modal') closeCrop(); });
    $('#avatar-crop-save').addEventListener('click', saveCrop);
    $('#crop-zoom').addEventListener('input', (e) => { if (crop) setZoom(parseFloat(e.target.value)); });
    // drag + wheel-zoom + two-finger pinch on the frame
    const frame = $('#crop-frame'); const pts = new Map(); let pinchD0 = 0, pinchZ0 = 1, dragX = 0, dragY = 0;
    frame.addEventListener('pointerdown', (e) => { frame.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); dragX = e.clientX; dragY = e.clientY; if (pts.size === 2) { const p = [...pts.values()]; pinchD0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); pinchZ0 = crop.z; } });
    frame.addEventListener('pointermove', (e) => {
      if (!crop || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const p = [...pts.values()]; const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); if (pinchD0) { setZoom(pinchZ0 * (d / pinchD0)); $('#crop-zoom').value = String(crop.z); } return; }
      crop.ox += e.clientX - dragX; crop.oy += e.clientY - dragY; dragX = e.clientX; dragY = e.clientY; applyCrop();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinchD0 = 0; };
    frame.addEventListener('pointerup', up); frame.addEventListener('pointercancel', up);
    frame.addEventListener('wheel', (e) => { if (!crop) return; e.preventDefault(); setZoom(crop.z * (e.deltaY < 0 ? 1.1 : 0.9)); $('#crop-zoom').value = String(crop.z); }, { passive: false });
  })();

  /* ======================================================================
     Admin (owner-only). The screen and every RPC are gated server-side by
     admin_is(); this just hides the entry and renders the list + delete for
     the owner. A non-admin who forces the view is bounced back to Home.
     ====================================================================== */
  let isAdmin = false, adminPage = 0, adminQ = '', adminRows = [], adminDelUid = null, adminSearchT = null;
  const ADMIN_PAGE = 20;
  // joined / last_active come back as full timestamptz strings (not date-only),
  // so format them directly rather than via fmtDate (which assumes YYYY-MM-DD).
  const adminDate = (ts) => { const d = new Date(ts); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
  async function loadAdminFlag() {
    if (!cloudOn()) { isAdmin = false; const e = $('#admin-entry'); if (e) e.hidden = true; return; }
    try { const { data, error } = await sb.rpc('admin_is'); isAdmin = !error && data === true; }
    catch (e) { isAdmin = false; }
    const entry = $('#admin-entry'); if (entry) entry.hidden = !isAdmin;
    if (!isAdmin && $('#view-admin') && $('#view-admin').classList.contains('is-active')) showView('dashboard');
    if (typeof renderMatchHub === 'function') renderMatchHub(); // reveal the owner-only Practice button
  }
  async function renderAdmin() {
    const list = $('#admin-list'); if (!list) return;
    if (!isAdmin) { showView('dashboard'); return; }
    list.innerHTML = '<div class="admin-empty muted">Loading…</div>';
    let rows = [];
    try {
      const { data, error } = await sb.rpc('admin_user_list', { q: adminQ, page: adminPage, page_size: ADMIN_PAGE });
      if (error) throw error;
      rows = data || [];
    } catch (e) { list.innerHTML = '<div class="admin-empty muted">Could not load users.</div>'; return; }
    adminRows = rows;
    if (!rows.length) {
      list.innerHTML = `<div class="admin-empty muted">${adminQ ? 'No users match your search.' : 'No users yet.'}</div>`;
    } else {
      list.innerHTML = rows.map((u) => {
        const name = escapeHTML(u.display_name || 'Climber');
        const handle = u.username ? '@' + escapeHTML(u.username) : 'no username';
        const last = u.last_active ? adminDate(u.last_active) : "never";
        return `<button type="button" class="admin-row" data-auid="${u.id}">
          <div class="admin-row-main">
            <div class="admin-row-name">${name}${u.is_admin ? ' <span class="admin-badge">admin</span>' : ''}</div>
            <div class="admin-row-sub">${handle} · ${escapeHTML(u.email || 'no email')}</div>
          </div>
          <div class="admin-row-meta"><b>${u.send_score}</b><span>${u.friend_count} friend${u.friend_count === 1 ? '' : 's'} · ${last}</span></div>
        </button>`;
      }).join('');
    }
    const pager = $('#admin-pager');
    if (pager) {
      const more = rows.length === ADMIN_PAGE;
      pager.hidden = adminPage === 0 && !more;
      $('#admin-prev').disabled = adminPage === 0;
      $('#admin-next').disabled = !more;
      $('#admin-page-lbl').textContent = `Page ${adminPage + 1}`;
    }
  }
  function openAdminDetail(uid) {
    const u = adminRows.find((x) => x.id === uid); if (!u) return;
    adminDelUid = uid;
    $('#admin-detail').innerHTML = `
      <div class="admin-detail-name">${escapeHTML(u.display_name || 'Climber')}${u.is_admin ? ' <span class="admin-badge">admin</span>' : ''}</div>
      <div class="admin-detail-grid">
        <div><span>Username</span><b>${u.username ? '@' + escapeHTML(u.username) : '—'}</b></div>
        <div><span>Email</span><b>${escapeHTML(u.email || '—')}</b></div>
        <div><span>Joined</span><b>${u.joined ? adminDate(u.joined) : "—"}</b></div>
        <div><span>Last active</span><b>${u.last_active ? adminDate(u.last_active) : "never"}</b></div>
        <div><span>Send Score</span><b>${u.send_score}</b></div>
        <div><span>Friends</span><b>${u.friend_count}</b></div>
      </div>`;
    // The confirmation token is the username, or the email for accounts that
    // never claimed a handle.
    const token = u.username || u.email || '';
    const input = $('#admin-del-input'), confirm = $('#admin-del-confirm'), st = $('#admin-del-status');
    // Show the EXACT string that must be typed (the bare username, or the email
    // for accounts with no handle) — no "@" prefix, so the label matches input.
    $('#admin-del-handle').textContent = token || '(this account)';
    input.value = ''; input.placeholder = token; input.dataset.token = token;
    st.hidden = true; confirm.disabled = true;
    const selfBlocked = u.id === myUid();
    input.disabled = selfBlocked;
    if (selfBlocked) { st.hidden = false; st.textContent = 'You can’t delete your own admin account.'; st.className = 'auth-status'; }
    $('#admin-del-modal').hidden = false;
    if (!selfBlocked) input.focus();
  }
  (function bindAdminUI() {
    const openEl = $('#admin-open'); if (!openEl) return;
    openEl.addEventListener('click', () => { adminPage = 0; adminQ = ''; const s = $('#admin-search'); if (s) s.value = ''; showView('admin'); });
    $('#admin-back').addEventListener('click', () => showView('profile'));
    $('#admin-search').addEventListener('input', (e) => {
      clearTimeout(adminSearchT);
      adminSearchT = setTimeout(() => { adminQ = e.target.value.trim(); adminPage = 0; renderAdmin(); }, 250);
    });
    $('#admin-prev').addEventListener('click', () => { if (adminPage > 0) { adminPage--; renderAdmin(); } });
    $('#admin-next').addEventListener('click', () => { adminPage++; renderAdmin(); });
    $('#admin-list').addEventListener('click', (e) => { const r = e.target.closest('[data-auid]'); if (r) openAdminDetail(r.dataset.auid); });
    const closeDel = () => { $('#admin-del-modal').hidden = true; adminDelUid = null; };
    $('#admin-del-cancel').addEventListener('click', closeDel);
    $('#admin-del-modal').addEventListener('click', (e) => { if (e.target.id === 'admin-del-modal') closeDel(); });
    const input = $('#admin-del-input'), confirm = $('#admin-del-confirm');
    input.addEventListener('input', () => {
      confirm.disabled = input.disabled || input.value.trim() !== (input.dataset.token || '') || !input.value.trim();
    });
    confirm.addEventListener('click', async () => {
      const uid = adminDelUid; if (!uid) return;
      confirm.disabled = true;
      const st = $('#admin-del-status'); st.hidden = false; st.className = 'auth-status'; st.textContent = 'Deleting…';
      try {
        const { error } = await sb.rpc('admin_delete_user', { target: uid });
        if (error) throw error;
        closeDel();
        renderAdmin();
      } catch (e) {
        const m = errMsg(e);
        st.textContent = /authorized|own admin|no such/.test(m) ? m : 'Could not delete that account.';
        st.className = 'auth-status err'; confirm.disabled = false;
      }
    });
  })();

  // One-time UI bindings (module load).
  (function bindFriendsUI() {
    const search = $('#friend-search');
    if (search) search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runFriendSearch, 250); });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-fact]');
      if (btn) { e.preventDefault(); friendAct(btn.dataset.fact, btn.dataset.uid); }
    });
    const uform = $('#username-form');
    if (uform) uform.addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = $('#username-status');
      const handle = ($('#username-input').value || '').trim().toLowerCase();
      const show = (msg, ok) => { if (st) { st.hidden = false; st.textContent = msg; st.className = 'auth-status ' + (ok ? 'ok' : 'err'); } };
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) return show('3–20 letters, numbers or underscores.', false);
      if (!cloudOn()) return show('Sign in first.', false);
      try {
        const { error } = await sb.rpc('friend_set_username', { handle, dname: currentDisplayName() || null });
        if (error) throw error;
        show('Saved ✓', true);
        loadFriends();
      } catch (err) {
        show(/taken|duplicate|23505/.test(errMsg(err)) ? 'That @username is taken.' : 'Could not save that username.', false);
      }
    });
  })();

  /* ======================================================================
     Head-to-head match game.

     Two friends race a climbing session. Each is really playing THEIR OWN
     level: the match score is how many points the match climbs earn in the
     EXISTING Send Score engine (server-side, via match_state → the same replay
     the leaderboard uses), so a V3 climber who sends above their level beats a
     V8 coasting on easy repeats. The winner gets a chess-Elo bump, the loser a
     loss — an adjustment layered on top of the displayed rating. Logging during
     a match uses the exact same quick-log flow (zero extra taps); the match
     only watches. Realtime + offline degrade exactly like the friends feed.
     ====================================================================== */
  let matches = { incoming: [], outgoing: [], active: null, history: [] };
  let matchAdj = { boulder: 0, rope: 0 };
  let h2hMid = null, h2hTimer = null, h2hLastHtml = null, h2hLastState = null, h2hForfeitArm = false;

  async function loadMatches() {
    if (!cloudOn()) { matches = { incoming: [], outgoing: [], active: null, history: [] }; matchAdj = { boulder: 0, rope: 0 }; renderMatchesPanel(); return; }
    try {
      const [list, adj] = await Promise.all([sb.rpc('match_list'), sb.rpc('match_my_adjustments')]);
      const rows = list.data || [];
      matches.incoming = rows.filter((m) => m.status === 'pending' && m.i_am === 'opponent');
      matches.outgoing = rows.filter((m) => m.status === 'pending' && m.i_am === 'challenger');
      matches.active = rows.find((m) => m.status === 'active') || null;
      // Baseline the opponent's send/attempt counts when a match becomes active,
      // so the FIRST result they log lands as a delta (a receive moment).
      if (matches.active) { if (maSeen.matchId !== matches.active.id) maSetBaseline(matches.active); }
      else maSeen.matchId = null;
      matches.history = rows.filter((m) => m.status === 'resolved' || m.status === 'abandoned').slice(0, 8);
      const a = adj.data || {};
      const changed = matchAdj.boulder !== (a.boulder || 0) || matchAdj.rope !== (a.rope || 0);
      matchAdj = { boulder: a.boulder || 0, rope: a.rope || 0 };
      if (changed) { renderClimberRating(); renderRatingHero(); } // keep hero/cards in step with the leaderboard
    } catch (e) { console.warn('SendOffs unavailable:', e); }
    matchesLoaded = true; // even on error: the hub falls back to its idle state
    renderMatchesPanel();
    renderMatchHub();  // hub first — its card gates the dock
    renderMatchDock(); // match started/ended → show or dismiss the dock
    updateFriendsBadge();
  }

  function renderMatchesPanel() {
    const panel = $('#matches-panel'), list = $('#matches-list');
    if (!panel || !list) return;
    const any = matches.incoming.length || matches.outgoing.length || matches.active || matches.history.length;
    panel.hidden = !(cloudOn() && any);
    let html = '';
    const rules = (m) => escapeHTML(m.rules_label || 'Any climbing');
    if (matches.active) {
      const m = matches.active;
      html += `<li data-mopen="${m.id}" style="cursor:pointer">
        <div class="feed-left"><span class="feed-ico climb"><svg class="ico"><use href="#i-bolt"/></svg></span>
          <div><div class="feed-main">Match vs ${escapeHTML(m.opponent_name)}</div><div class="feed-sub">${rules(m)} · tap to open</div></div></div>
        <div class="feed-actions"><span class="match-badge live">LIVE</span></div></li>`;
    }
    matches.incoming.forEach((m) => { html += `<li>
      <div class="feed-left"><span class="feed-ico"><svg class="ico"><use href="#i-bolt"/></svg></span>
        <div><div class="feed-main">${escapeHTML(m.opponent_name)} challenged you</div><div class="feed-sub">${rules(m)} · ${m.ranked === false ? 'no elo at stake' : 'winner takes elo'}</div></div></div>
      <div class="feed-actions"><button class="btn primary sm" data-mact="accept" data-mid="${m.id}">Accept</button><button class="btn ghost sm" data-mact="decline" data-mid="${m.id}">Decline</button></div></li>`; });
    matches.outgoing.forEach((m) => { html += `<li>
      <div class="feed-left"><span class="feed-ico"><svg class="ico"><use href="#i-bolt"/></svg></span>
        <div><div class="feed-main">Challenge sent to ${escapeHTML(m.opponent_name)}</div><div class="feed-sub">${rules(m)} · waiting to accept</div></div></div>
      <div class="feed-actions"><button class="btn ghost sm" data-mact="cancelm" data-mid="${m.id}">Cancel</button></div></li>`; });
    matches.history.forEach((m) => {
      // Won/lost comes from the stored winner, never the delta sign — an
      // unranked win moves no elo (delta 0) but is still a win.
      const res = m.status === 'abandoned' ? 'draw' : (m.winner === 'draw' || !m.winner ? 'draw' : (m.winner === m.i_am ? 'won' : 'lost'));
      const lbl = m.status === 'abandoned' ? 'abandoned' : res;
      html += `<li><div class="feed-left"><span class="feed-ico"><svg class="ico"><use href="#i-bolt"/></svg></span>
        <div><div class="feed-main">vs ${escapeHTML(m.opponent_name)}</div><div class="feed-sub">${m.status === 'abandoned' ? 'no climbs logged' : `you ${res}`}</div></div></div>
        <div class="feed-actions"><span class="match-badge ${res}">${lbl}${m.my_delta ? ` ${m.my_delta > 0 ? '+' : ''}${m.my_delta}` : ''}</span></div></li>`;
    });
    list.innerHTML = html || '<li class="empty">No SendOffs yet — challenge a friend below.</li>';
  }

  // ----- Match creation: pick the ruleset, then send the challenge -----
  let mcTarget = null; // { uid, name }
  const mcState = { discipline: 'boulder', style: 'lead', length: 3, ranked: true, practice: false };
  const mcModal = $('#match-create-modal');
  // Map the pickers to the backend discipline: bouldering, or the rope style.
  function mcMappedDiscipline() { return mcState.discipline === 'boulder' ? 'boulder' : mcState.style; }
  function matchChallenge(uid) {
    if (!cloudOn()) return;
    const f = (friends.list || []).find((x) => x.user_id === uid);
    openMatchCreate(uid, (f && f.display_name) || 'your friend');
  }
  // Owner-only: a solo match against the Practice Partner bot (verify the whole
  // flow on one account). Same sheet, but no opponent picker and it calls
  // match_practice instead of match_challenge.
  function openPracticeCreate() { openMatchCreate(null, null, true); }
  // Enable/disable the Send button: you must have an opponent (or be in practice
  // mode, which needs none). Called on open + whenever the selection changes.
  function syncMcSend() {
    const send = $('#mc-send'); if (send) send.disabled = !mcState.practice && !mcTarget;
  }
  function openMatchCreate(uid, name, practice) {
    mcTarget = uid ? { uid, name } : null;
    mcState.discipline = 'boulder'; mcState.style = 'lead'; mcState.length = 3; mcState.ranked = true;
    mcState.practice = !!practice;
    const st = $('#mc-status'); if (st) { st.hidden = true; st.textContent = ''; }
    const ff = $('#mc-friend-field');
    // Preselect the friend you came in on (or your only friend), but keep the
    // picker VISIBLE so you can see who you're challenging and switch. Practice
    // has no opponent to pick.
    if (!mcState.practice && !mcTarget && friends.list.length === 1) {
      const f = friends.list[0];
      mcTarget = { uid: f.user_id, name: f.display_name || 'your friend' };
    }
    if (ff) {
      ff.hidden = mcState.practice || friends.list.length === 0;
      const box = $('#mc-friends');
      if (box && !ff.hidden) {
        // People chips: avatar + name, with a clear selected state.
        box.innerHTML = friends.list.map((f) => {
          const on = mcTarget && mcTarget.uid === f.user_id;
          return `<button type="button" class="mc-friend-opt${on ? ' is-active' : ''}" data-fuid="${f.user_id}" aria-pressed="${on ? 'true' : 'false'}">${avatarHTML(f.user_id, f.display_name || 'Climber', 'sm', f.avatar_v)}<span class="mc-friend-nm">${escapeHTML(f.display_name || 'Climber')}</span></button>`;
        }).join('');
        sweepAvatars(); // load real photos into the fresh avatar nodes
      }
    }
    const nm = $('#mc-name'); if (nm) nm.textContent = mcState.practice ? 'Practice Partner 🤖' : (mcTarget ? mcTarget.name : 'a friend');
    const send = $('#mc-send'); if (send) send.textContent = mcState.practice ? 'Start practice' : 'Send challenge';
    renderMcPickers();
    syncMcSend();
    if (mcModal) { mcModal.hidden = false; animOverlayIn(mcModal); }
  }
  function closeMatchCreate() { if (mcModal) mcModal.hidden = true; mcTarget = null; }
  function renderMcPickers() {
    $$('#mc-discipline .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.disc === mcState.discipline));
    $$('#mc-style .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.style === mcState.style));
    $$('#mc-length .grade-pill').forEach((b) => {
      const v = b.dataset.n === '' ? null : parseInt(b.dataset.n, 10);
      b.classList.toggle('is-active', v === mcState.length);
    });
    $$('#mc-ranked .seg-btn').forEach((b) => b.classList.toggle('is-active', (b.dataset.ranked === '1') === mcState.ranked));
    const styleField = $('#mc-style-field'); if (styleField) styleField.hidden = mcState.discipline !== 'routes';
    // Live plain-language summary of exactly what the opponent will agree to.
    const one = mcState.discipline === 'boulder' ? 'problem' : 'route';
    const discLabel = mcState.discipline === 'boulder' ? 'Bouldering'
      : (mcState.style === 'lead' ? 'Lead routes' : mcState.style === 'toprope' ? 'Top-rope routes' : 'Any roped routes');
    const intro = `${discLabel}, best of ${mcState.length} — you take turns, and you go first.`;
    const sum = $('#mc-summary');
    if (sum) sum.textContent = mcState.ranked
      ? `${intro} Every ${one} is scored against your own level: one at your level is worth 3 points, and each grade harder is worth 1 more. A grade easier scores 2, two easier scores 1, and anything well below your level — or a fall — scores 0. A flash adds 1 point. Most points wins, and the winner takes elo.`
      : mcState.discipline === 'boulder'
        ? `${intro} Unranked, so there's no handicap — your grade is your score: a V5 is worth 5, a V8 is worth 8, and so on. A flash adds 1, a fall is 0. Whoever climbs harder wins, and no elo is on the line.`
        : `${intro} Unranked, so there's no handicap — climbs score up from 5.10c (worth 3), with each grade harder worth 1 more. A flash adds 1, a fall is 0. Whoever climbs harder wins, and no elo is on the line.`;
  }
  async function sendMatchChallenge() {
    const st = $('#mc-status'); const btn = $('#mc-send');
    if (!cloudOn()) return;
    if (!mcState.practice && !mcTarget) { if (st) { st.hidden = false; st.className = 'auth-status err'; st.textContent = 'Pick who to challenge first.'; } return; }
    if (btn) btn.disabled = true;
    try {
      const { data, error } = mcState.practice
        ? await sb.rpc('match_practice', { discipline: mcMappedDiscipline(), best_n: mcState.length, ranked: mcState.ranked })
        : await sb.rpc('match_challenge', { friend: mcTarget.uid, discipline: mcMappedDiscipline(), best_n: mcState.length, ranked: mcState.ranked });
      if (error) throw error;
      closeMatchCreate();
      await loadMatches();
      if (data) openH2H(data);
    } catch (e) {
      if (st) { st.hidden = false; st.className = 'auth-status err'; st.textContent = /already in progress/i.test(errMsg(e)) ? 'You already have a SendOff going with them.' : errMsg(e); }
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  (function bindMatchCreate() {
    if (!mcModal) return;
    $('#mc-close').addEventListener('click', closeMatchCreate);
    $('#mc-cancel').addEventListener('click', closeMatchCreate);
    $('#mc-send').addEventListener('click', sendMatchChallenge);
    mcModal.addEventListener('click', (ev) => { if (ev.target === mcModal) closeMatchCreate(); });
    $('#mc-discipline').addEventListener('click', (ev) => { const b = ev.target.closest('[data-disc]'); if (!b) return; mcState.discipline = b.dataset.disc; renderMcPickers(); });
    $('#mc-style').addEventListener('click', (ev) => { const b = ev.target.closest('[data-style]'); if (!b) return; mcState.style = b.dataset.style; renderMcPickers(); });
    $('#mc-length').addEventListener('click', (ev) => { const b = ev.target.closest('[data-n]'); if (!b) return; mcState.length = b.dataset.n === '' ? null : parseInt(b.dataset.n, 10); renderMcPickers(); });
    $('#mc-ranked').addEventListener('click', (ev) => { const b = ev.target.closest('[data-ranked]'); if (!b) return; mcState.ranked = b.dataset.ranked === '1'; renderMcPickers(); });
    const mf = $('#mc-friends');
    if (mf) mf.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-fuid]'); if (!b) return;
      const f = friends.list.find((x) => x.user_id === b.dataset.fuid); if (!f) return;
      mcTarget = { uid: f.user_id, name: f.display_name || 'your friend' };
      const nm = $('#mc-name'); if (nm) nm.textContent = mcTarget.name;
      $$('#mc-friends .mc-friend-opt').forEach((p) => {
        const on = p.dataset.fuid === b.dataset.fuid;
        p.classList.toggle('is-active', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const st = $('#mc-status'); if (st) { st.hidden = true; st.textContent = ''; }
      syncMcSend();
    });
  })();
  async function matchAct(act, mid) {
    if (!cloudOn()) return;
    try {
      if (act === 'accept') { await sb.rpc('match_respond', { mid, accept: true }); await loadMatches(); openH2H(mid); }
      else if (act === 'decline') { await sb.rpc('match_respond', { mid, accept: false }); await loadMatches(); }
      else if (act === 'cancelm') { await sb.rpc('match_cancel', { mid }); await loadMatches(); }
    } catch (e) { console.warn('SendOff action failed:', e); loadMatches(); }
  }
  // Forfeit: quit now and take the loss, without waiting on the opponent.
  async function forfeitMatch() {
    if (!cloudOn() || !h2hMid) return;
    h2hForfeitArm = false;
    try { await sb.rpc('match_forfeit', { mid: h2hMid }); } catch (e) { console.warn('Forfeit failed:', e); }
    refreshH2H();
    if (matches.active) refreshMatchDock();
    loadMatches();
  }

  const matchModal = $('#match-modal');
  function openH2H(mid) { h2hMid = mid; h2hLastHtml = null; h2hForfeitArm = false; if (matchModal) { matchModal.hidden = false; animOverlayIn(matchModal); } refreshH2H(); if (h2hTimer) clearInterval(h2hTimer); h2hTimer = setInterval(refreshH2H, 3000); }
  function closeH2H() { if (matchModal) matchModal.hidden = true; if (h2hTimer) { clearInterval(h2hTimer); h2hTimer = null; } h2hMid = null; h2hForfeitArm = false; loadMatches(); }
  async function refreshH2H() {
    if (!h2hMid || !cloudOn()) return;
    try { const { data, error } = await sb.rpc('match_state', { mid: h2hMid }); if (error) throw error; renderH2H(data); maybeBotMove(data); }
    catch (e) { console.warn('SendOff state unavailable:', e); }
  }
  // Practice matches: when it's the bot's turn, nudge it to take its move (the
  // server logs one climb and the next poll shows it). A short "thinking" delay
  // makes the turn handoff feel real. Idempotent + re-entrancy-guarded.
  let botMoving = false;
  async function maybeBotMove(s) {
    if (!s || !s.practice || s.status !== 'active' || botMoving) return;
    const bot = s.challenger.is_bot ? s.challenger : s.opponent.is_bot ? s.opponent : null;
    if (!bot || bot.can_log !== true) return;
    botMoving = true;
    setTimeout(async () => {
      try { const { data } = await sb.rpc('match_bot_move', { mid: s.id }); if (data && h2hMid === s.id) renderH2H(data); }
      catch (e) { console.warn('Bot move failed:', e); }
      botMoving = false;
      if (h2hMid === s.id) refreshH2H();
      if (matches.active && matches.active.id === s.id) refreshMatchDock();
    }, 800);
  }
  // Battle FX: a landed hit — pop a damage number over the target, drain its HP
  // bar down from the pre-hit level, flash the avatars, shake on a big one; a
  // KO faints the target. A miss (project) is a stumble with no drain. Driven by
  // real score changes in renderH2H, so it always matches the server. Reduced
  // motion → no-op (the re-render already set the bar; CSS kills the transition).
  function battleHit(side, dmg, opts) {
    opts = opts || {};
    if (!motionOK()) return;
    const arena = $('.arena'); if (!arena) return;
    const target = arena.querySelector('.arena-ava.' + side);
    const attacker = arena.querySelector('.arena-ava.' + (side === 'foe' ? 'hero' : 'foe'));
    const bar = arena.querySelector('.bt-hpbar[data-side="' + side + '"] > span');
    const hpFull = parseInt(arena.dataset.hpfull || '0', 10);
    if (target) {
      const ar = arena.getBoundingClientRect(), tr = target.getBoundingClientRect();
      const dn = document.createElement('div');
      dn.className = 'bt-dmg' + (opts.miss ? ' miss' : (dmg >= 10 ? ' crit' : ''));
      dn.textContent = opts.miss ? 'MISS' : '-' + dmg;
      dn.style.left = (tr.left - ar.left + tr.width / 2 - 18) + 'px';
      dn.style.top = (tr.top - ar.top + 4) + 'px';
      arena.appendChild(dn);
      mAnim(dn, { transform: ['translateY(2px) scale(.6)', 'translateY(-6px) scale(1.15)', 'translateY(-36px) scale(1)'], opacity: [0, 1, 1, 0] }, { duration: 0.95, easing: [0.2, 1, 0.4, 1] });
      maTimers.push(setTimeout(() => dn.remove(), 1000));
    }
    if (opts.miss) {
      arena.classList.add('bt-dim', 'bt-shake'); maTimers.push(setTimeout(() => arena.classList.remove('bt-dim', 'bt-shake'), 470));
      if (attacker) { attacker.classList.add('bt-miss'); maTimers.push(setTimeout(() => attacker.classList.remove('bt-miss'), 520)); }
      return;
    }
    if (attacker) { attacker.classList.add('bt-hit'); maTimers.push(setTimeout(() => attacker.classList.remove('bt-hit'), 340)); }
    if (bar && hpFull) {
      const newPct = parseFloat(bar.style.width) || 0;
      const oldPct = Math.min(100, newPct + 100 * dmg / hpFull);
      bar.style.transition = 'none'; bar.style.width = oldPct + '%';
      void bar.offsetWidth; // reflow so the drain animates from the pre-hit level
      bar.style.transition = ''; requestAnimationFrame(() => { bar.style.width = newPct + '%'; });
    }
    if (target) { target.classList.add('bt-hit'); maTimers.push(setTimeout(() => target.classList.remove('bt-hit'), 340)); }
    if (dmg >= 10 && !opts.ko) { arena.classList.add('bt-shake'); maTimers.push(setTimeout(() => arena.classList.remove('bt-shake'), 360)); }
    if (opts.ko) {
      // Knockout payoff: white flash + hard shake + a stamped "K.O.!" + the faint.
      arena.classList.add('bt-shake', 'bt-flash');
      maTimers.push(setTimeout(() => arena.classList.remove('bt-shake', 'bt-flash'), 540));
      const ko = document.createElement('div'); ko.className = 'bt-ko'; ko.innerHTML = '<span>K.O.!</span>';
      arena.appendChild(ko); maTimers.push(setTimeout(() => ko.remove(), 950));
      if (target) maTimers.push(setTimeout(() => target.classList.add('bt-faint'), 300));
      // My knockout (I emptied the foe's bar) → a burst of confetti to celebrate.
      if (side === 'foe') {
        const burst = document.createElement('div'); burst.className = 'bt-burst';
        const cols = ['#ffd23f', '#e0459b', '#22c1c3', '#7ee06a', '#e2574c', '#a06bff'];
        for (let i = 0; i < 20; i++) { const it = document.createElement('i'); it.style.background = cols[i % cols.length]; burst.appendChild(it); }
        arena.appendChild(burst);
        [...burst.children].forEach((it, i) => { const ang = (i / 20) * Math.PI * 2, dist = 58 + (i % 4) * 22;
          mAnim(it, { opacity: [1, 1, 0], transform: ['translate(-4px,0) scale(1)', `translate(${Math.cos(ang) * dist}px,${Math.sin(ang) * dist - 8}px) scale(1)`, `translate(${Math.cos(ang) * dist * 1.4}px,${Math.sin(ang) * dist * 1.4 + 34}px) scale(.6)`] }, { duration: 1.15, easing: [0.2, 0.7, 0.3, 1] }); });
        maTimers.push(setTimeout(() => burst.remove(), 1250));
      }
    }
  }

  function renderH2H(s) {
    const body = $('#match-body'); if (!body || !s) return;
    const h2hPrev = h2hLastState; // previous poll's state — diff scores to drive battle FX
    h2hLastState = s; // kept so the forfeit confirm can re-render without a fetch
    const iAmCh = s.i_am === 'challenger';
    const me = iAmCh ? s.challenger : s.opponent, them = iAmCh ? s.opponent : s.challenger;
    const resolved = s.status === 'resolved' || s.status === 'abandoned';
    if (resolved && h2hTimer) { clearInterval(h2hTimer); h2hTimer = null; }
    const rules = s.rules || {};
    // Par-points mode = any ruleset match; legacy (null-discipline) rows keep
    // the old signed-elo-delta presentation end to end.
    const parMode = rules.discipline != null;
    // Unranked = the same turn-by-turn game with the handicap and elo stake
    // removed: everyone scores off the same scratch baseline, absolute points.
    const unranked = parMode && rules.ranked === false;
    const sc = (v) => (parMode ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const noun = rules.discipline === 'boulder' ? 'problems' : 'routes';
    // Hard cap: once your best_n slots are used your side is full — further
    // climbs no longer count toward the match.
    const myFull = !!(rules.best_n && me.counted != null && me.counted >= rules.best_n);
    const myTurn = me.can_log === true;
    // Battle arena applies to every ruleset SendOff (a best_n → an HP pool of
    // best_n × 8, mirroring core hpMax). Legacy null-discipline rows fall back
    // to the old scoreboard.
    const arena = rules.best_n != null && me.score != null;
    const hpFull = (rules.best_n || 0) * 8;
    // Rules banner — always visible so the agreed ruleset is unambiguous.
    let html = rules.style_label ? `<div class="h2h-rules"><svg class="ico"><use href="#i-bolt"/></svg><span>${escapeHTML(rules.style_label)}${s.practice ? ' · practice' : ''}</span></div>` : '';
    if (s.practice) html += `<div class="h2h-practice">🤖 Practice SendOff — the challenger bot fights on its own. Doesn’t affect your Send Score.</div>`;

    if (arena) {
      // ---- monster-battle arena: two facing climbers, each with an HP bar ----
      // Your damage (me.score) drains the FOE's bar; their damage drains yours.
      const hpOf = (foeDmg) => Math.max(0, hpFull - foeDmg);
      const plate = (p, isMe, foeDmg) => {
        const hp = hpOf(foeDmg), pct = hpFull ? Math.round(100 * hp / hpFull) : 0;
        const tone = pct > 50 ? 'hp-hi' : pct > 20 ? 'hp-mid' : 'hp-lo';
        const used = p.counted != null ? Math.min(p.counted, rules.best_n) : 0;
        return `<div class="bt-plate ${isMe ? 'me' : ''}">
          <div class="bt-nm">${escapeHTML(p.name)}${isMe ? ' (you)' : ''}<span class="bt-lv">SS ${p.elo != null ? p.elo : '—'}</span></div>
          <div class="bt-hpbar ${tone}" data-side="${isMe ? 'hero' : 'foe'}"><span style="width:${pct}%"></span></div>
          <div class="bt-hprow"><span class="bt-hp" data-side="${isMe ? 'hero' : 'foe'}">${hp}/${hpFull}</span><span class="bt-moves">${used}/${rules.best_n} ${noun}</span></div>
        </div>`;
      };
      const liveTurn = !resolved && s.status === 'active';
      const heroTurn = liveTurn && myTurn ? ' is-turn' : '';
      const foeTurn = liveTurn && s.turn && !myTurn && !myFull ? ' is-turn' : '';
      html += `<div class="arena" data-hpfull="${hpFull}">
        <div class="arena-row foe">${plate(them, false, me.score)}<div class="arena-ava foe${foeTurn}" data-avaside="foe">${avatarHTML(them.uid, them.name, 'lg', them.avatar_v)}</div></div>
        <div class="arena-row hero"><div class="arena-ava hero${heroTurn}" data-avaside="hero">${avatarHTML(me.uid, me.name, 'lg', me.avatar_v)}</div>${plate(me, true, them.score)}</div>
        <div class="arena-vs">VS</div>
      </div>`;

      // Narration text-box (retro dialog): result → out-of-moves → turn handoff.
      const foeName = escapeHTML(them.name), foeFirst = escapeHTML((them.name || '').split(' ')[0]);
      if (resolved) {
        const r = s.status === 'abandoned' ? 'draw' : (s.winner === 'draw' ? 'draw' : ((s.winner === 'challenger') === iAmCh ? 'won' : 'lost'));
        const iForfeited = s.forfeited_by && s.forfeited_by === me.uid;
        const theyForfeited = s.forfeited_by && s.forfeited_by === them.uid;
        const resultText = s.status === 'abandoned' ? 'The SendOff fizzled — nobody landed a hit.'
          : iForfeited ? 'You fled the battle.'
          : theyForfeited ? `${foeName} fled the battle — you win! 🏆`
          : r === 'won' ? `${foeName} fainted! You win! 🏆` : r === 'lost' ? `You fainted! ${foeName} wins.` : 'Draw — both climbers still standing.';
        html += `<div class="bt-narr ${r}">${resultText}</div>`;
        if (s.practice && s.status !== 'abandoned') html += `<div class="h2h-elochange">Practice — ${me.delta ? `would’ve been ${me.delta > 0 ? '+' : ''}${me.delta} Send Score, but ` : ''}your real score is untouched</div>`;
        else if (me.delta) html += `<div class="h2h-elochange" style="color:${me.delta > 0 ? 'var(--good)' : 'var(--danger)'}">${me.delta > 0 ? '+' : ''}${me.delta} Send Score · ${foeName} ${them.delta > 0 ? '+' : ''}${them.delta}</div>`;
        else if (unranked && s.status !== 'abandoned') html += `<div class="h2h-elochange">Unranked — no Send Score on the line</div>`;
      } else if (s.status === 'pending') {
        html += `<div class="bt-narr">Waiting for ${foeName} to answer the challenge…</div>`;
      } else if (myFull) {
        html += `<div class="bt-narr">Out of moves — your ${rules.best_n} ${noun} are in. Hold on while ${foeFirst} finishes.</div>`;
      } else {
        // Deterministic per-turn copy variety (stable for the render diff-guard).
        const turnIdx = (me.counted || 0) + (them.counted || 0);
        const pick = (arr) => arr[turnIdx % arr.length];
        const l = them.last;
        let foeLast = '';
        if (l && l.grade) {
          if (l.result === 'Project') foeLast = `${foeName} ${pick(['whiffed', 'blew', 'came off'])} ${escapeHTML(l.grade)} — no damage.`;
          else { const v = l.points || 0, verb = v >= 10 ? pick(['CRUSHED', 'obliterated', 'demolished']) : v >= 6 ? pick(['nailed', 'stuck', 'powered up']) : pick(['sent', 'ticked', 'dispatched']); foeLast = `${foeName} ${verb} ${escapeHTML(l.grade)} for ${v}!`; }
        }
        const prompts = ['⚔ Your move — hit back with a hard send!', '⚔ Your turn — send big to bite their HP!', '⚔ Fire back — harder grade, bigger hit!'];
        const line = myTurn ? (foeLast ? `${foeLast} ${pick(prompts)}` : pick(prompts)) : `${foeName} ${pick(['is eyeing the wall…', 'chalks up…', 'reads the next line…'])}`;
        html += `<div class="bt-narr ${myTurn ? 'mine' : ''}">${line}</div>`;
      }
      // Rules cheat-sheet only before the first attack, then it gets out of the way.
      if (!resolved && s.status === 'active' && (me.counted || 0) === 0 && (them.counted || 0) === 0) {
        const scale = rules.discipline === 'boulder' ? 'a V0 hits for 1, each grade up hits harder (V8 → 9)' : '5.7 hits for 1, each grade up hits harder (5.12a → 12)';
        html += `<div class="h2h-guide">Every send is an attack — ${scale}. A fall misses. Empty your foe’s ${hpFull} HP for a knockout, or deal the most damage before time runs out.</div>`;
      }
    } else {
      // ---- legacy scoreboard (null-discipline matches) ----
      const side = (p, isMe, lead) => `<div class="h2h-side ${isMe ? 'me' : ''} ${lead ? 'leading' : ''}">
        <div class="h2h-ava">${avatarHTML(p.uid, p.name, 'md', p.avatar_v)}</div>
        <div class="h2h-name">${escapeHTML(p.name)}${isMe ? ' (you)' : ''}</div>
        <div class="h2h-score ${sc(p.score)}">${p.score > 0 ? '+' : ''}${p.score}</div>
        <div class="h2h-base">racing level ${p.baseline != null ? p.baseline : '—'}</div>
        <div class="h2h-elo">Send Score ${p.elo != null ? p.elo : '—'}</div></div>`;
      if (resolved) {
        const r = s.status === 'abandoned' ? 'draw' : (s.winner === 'draw' ? 'draw' : ((s.winner === 'challenger') === iAmCh ? 'won' : 'lost'));
        const resultText = s.status === 'abandoned' ? 'SendOff abandoned' : r === 'won' ? 'You won 🏆' : r === 'lost' ? 'You lost' : 'Draw';
        html += `<div class="h2h-result ${r}">${resultText}</div>`;
        if (me.delta) html += `<div class="h2h-elochange" style="color:${me.delta > 0 ? 'var(--good)' : 'var(--danger)'}">${me.delta > 0 ? '+' : ''}${me.delta} Send Score · opponent ${them.delta > 0 ? '+' : ''}${them.delta}</div>`;
      } else if (s.status === 'pending') {
        html += `<div class="h2h-status">Waiting for ${escapeHTML(them.name)} to accept your challenge…</div>`;
      }
      html += `<div class="h2h">${side(me, true, !resolved && me.score > them.score)}<div class="h2h-vs">vs</div>${side(them, false, !resolved && them.score > me.score)}</div>`;
    }
    if (!resolved && s.status === 'active') {
      const logBtn = myFull
        ? `<button class="btn primary" id="h2h-log" disabled>Limit reached · ${rules.best_n} of ${rules.best_n}</button>`
        : (parMode && s.turn && !myTurn && !me.ended)
          ? `<button class="btn primary" id="h2h-log" disabled>${escapeHTML(them.name)}’s turn…</button>`
          : arena ? `<button class="btn primary" id="h2h-log">⚔ Attack</button>` : `<button class="btn primary" id="h2h-log">Log a climb</button>`;
      // Second action: forfeit (quit now, take the loss, no waiting on them) —
      // but if you've already used all your slots there's nothing to give up, so
      // it's just "waiting for them to finish". A tap arms an inline confirm.
      let endBtn;
      if (myFull) {
        endBtn = `<button class="btn ghost" id="h2h-end" disabled>Waiting for ${escapeHTML((them.name || '').split(' ')[0])}…</button>`;
      } else if (h2hForfeitArm) {
        endBtn = `<button class="btn danger" id="h2h-forfeit-yes">Forfeit &amp; take the loss</button><button class="btn ghost" id="h2h-forfeit-no">Cancel</button>`;
      } else {
        endBtn = `<button class="btn ghost" id="h2h-end">Forfeit</button>`;
      }
      html += `<div class="h2h-actions">${logBtn}${endBtn}</div>`;
      if (h2hForfeitArm) html += `<div class="h2h-guide">Forfeiting ends the SendOff right now and hands ${escapeHTML((them.name || '').split(' ')[0])} the win — no waiting for them to finish.</div>`;
    } else if (resolved) {
      html += `<div class="h2h-actions"><button class="btn primary" id="h2h-done">Done</button></div>`;
    }
    // The 3s poll usually returns an unchanged state. Rewriting identical HTML
    // would recreate the avatar <img> elements, and (on iOS Safari especially)
    // a fresh img shows a blank frame before it paints — flashing the default
    // circle underneath every poll. Skip the write when nothing changed; the
    // existing DOM (and its listeners) stays live.
    if (html === h2hLastHtml) return;
    h2hLastHtml = html;
    body.innerHTML = html;
    sweepAvatars();
    // Battle FX: if a side's damage rose since the last poll, play the hit (or a
    // whiff when a slot was used but nothing scored). KO faints at an empty bar.
    if (arena && h2hPrev && h2hPrev.id === s.id && h2hPrev.status === 'active') {
      const pMe = h2hPrev.i_am === 'challenger' ? h2hPrev.challenger : h2hPrev.opponent;
      const pThem = h2hPrev.i_am === 'challenger' ? h2hPrev.opponent : h2hPrev.challenger;
      const dFoe = (me.score || 0) - (pMe.score || 0), cFoe = (me.counted || 0) - (pMe.counted || 0);
      const dHero = (them.score || 0) - (pThem.score || 0), cHero = (them.counted || 0) - (pThem.counted || 0);
      if (dFoe > 0) battleHit('foe', dFoe, { ko: me.score >= hpFull });
      else if (cFoe > 0) battleHit('foe', 0, { miss: true });
      if (dHero > 0) battleHit('hero', dHero, { ko: them.score >= hpFull });
      else if (cHero > 0) battleHit('hero', 0, { miss: true });
    }
    const l = $('#h2h-log'); if (l) l.addEventListener('click', () => openQuickLog());
    // Forfeit is a two-tap confirm (arm → confirm), re-rendered from the stored
    // state so it survives the 3s poll.
    const e = $('#h2h-end'); if (e && !e.disabled) e.addEventListener('click', () => { h2hForfeitArm = true; if (h2hLastState) renderH2H(h2hLastState); });
    const fy = $('#h2h-forfeit-yes'); if (fy) fy.addEventListener('click', forfeitMatch);
    const fn = $('#h2h-forfeit-no'); if (fn) fn.addEventListener('click', () => { h2hForfeitArm = false; if (h2hLastState) renderH2H(h2hLastState); });
    const d = $('#h2h-done'); if (d) d.addEventListener('click', closeH2H);
  }

  // Test hook: drive the battle arena / animations with mock state (headless
  // Playwright can't reach an authed match_state). Guarded, no side effects.
  if (typeof window !== 'undefined') window.__battle = { renderH2H, get playMatchAnim() { return playMatchAnim; }, get battleHit() { return typeof battleHit === 'function' ? battleHit : null; } };

  /* ---------------- Persistent active-match dock ----------------
     A docked bar (music-player style) shown on Home + Rock Climbing while a
     match is live. Same realtime + ~3s poll as the head-to-head; degrades to a
     cached "offline" state and recovers on its own. Logging from it is the exact
     same quick sheet as everywhere else (zero extra taps). It sits above the
     bottom dock and adds bottom padding, so it never covers a screen's actions. */
  const matchDock = $('#match-dock');
  let mdTimer = null, mdState = null, mdStale = false, mdEndedHideAt = 0, mdHideTimer = null;
  function dockableView() {
    const v = document.querySelector('.view.is-active');
    return !!v && (v.id === 'view-dashboard' || v.id === 'view-climbing');
  }
  function stopDockPoll() { if (mdTimer) { clearInterval(mdTimer); mdTimer = null; } }
  function startDockPoll() { if (!mdTimer) mdTimer = setInterval(refreshMatchDock, 3000); }
  // The hub's live-match card (top of Home/Climbing) is the primary display;
  // the dock is its companion, appearing only once the card scrolls out of
  // view — like a mini-player — so the match stays visible while you browse.
  function hubCardOnScreen() {
    const v = document.querySelector('.view.is-active');
    if (!v) return false;
    const card = v.querySelector('.match-hub:not([hidden]) .hub-active');
    if (!card) return false;
    const r = card.getBoundingClientRect();
    return r.bottom > 70 && r.top < window.innerHeight - 50;
  }
  function renderMatchDock() {
    if (!matchDock) return;
    const active = matches.active;
    const resolvedRecently = mdState && (mdState.status === 'resolved' || mdState.status === 'abandoned') && Date.now() < mdEndedHideAt;
    const anyLive = cloudOn() && dockableView() && (active || resolvedRecently);
    // Polling runs whenever a match is ACTIVE on any view — the hub card, the
    // head-to-head, and the quick sheet's turn/point chips all read mdState,
    // and the sheet can open from anywhere. Dock VISIBILITY stays view-gated.
    if (cloudOn() && active) {
      startDockPoll();
      if (!mdState || (mdState.id !== active.id)) { mdState = null; refreshMatchDock(); }
    } else {
      stopDockPoll();
      if (!active && mdState && mdState.status === 'active' && !mdFetching) {
        refreshMatchDock(); // match ended elsewhere — fetch the final result once
      } else if (!active && !resolvedRecently) {
        mdState = null; // no match at all → truly gone
      }
    }
    const show = anyLive && !hubCardOnScreen();
    if (!show) {
      matchDock.hidden = true;
      document.body.classList.remove('has-match-dock');
      return;
    }
    const wasHidden = matchDock.hidden;
    matchDock.hidden = false;
    document.body.classList.add('has-match-dock');
    // Spring the mini-player in ONLY on the hidden→shown transition — this runs
    // on every 3s poll, so re-animating each time would jitter.
    if (wasHidden) mAnim(matchDock, { opacity: [0, 1], transform: ['translateY(16px) scale(.97)', 'translateY(0) scale(1)'] }, { spring: 'gentle' });
    paintMatchDock();
  }
  let mdFetching = false;
  async function refreshMatchDock() {
    const active = matches.active;
    if (!cloudOn() || (!active && !mdState) || mdFetching) return;
    const mid = active ? active.id : (mdState && mdState.id);
    if (!mid) return;
    mdFetching = true;
    try {
      const { data, error } = await sb.rpc('match_state', { mid });
      if (error) throw error;
      mdStale = false; mdState = data;
      if (data && (data.status === 'resolved' || data.status === 'abandoned')) {
        // Brief result state, then dismiss cleanly (never a frozen stale bar).
        if (!mdEndedHideAt) { mdEndedHideAt = Date.now() + 5000; if (mdHideTimer) clearTimeout(mdHideTimer); mdHideTimer = setTimeout(() => { mdEndedHideAt = 0; mdState = null; stopDockPoll(); loadMatches(); renderMatchDock(); }, 5200); }
        stopDockPoll();
      } else { mdEndedHideAt = 0; }
    } catch (e) {
      mdStale = true; // keep the last-known state on screen, flag it offline
    } finally {
      mdFetching = false;
    }
    if (mdState && !mdStale) maybeBotMove(mdState); // drive the practice bot's turn
    renderMatchHub(); // hub card first (it may hide/show the dock)
    renderMatchDock();
    // If the quick sheet is open, keep its turn note + point chips current —
    // but only rebuild when the match facts actually changed (rebuilding every
    // poll would recreate the pill buttons mid-tap).
    if (quickSheet && !quickSheet.hidden) {
      const live = matchLive();
      const key = live ? JSON.stringify([live.turn, matchMySide(live).counted, matchMySide(live).can_log, matchMySide(live).par_d]) : '';
      if (quickSheet.__matchKey !== key) { quickSheet.__matchKey = key; renderQuickLog(); }
    }
  }
  // Dock appears/disappears as the hub card scrolls out of / into view.
  let mdScrollT = null;
  window.addEventListener('scroll', () => {
    if (mdScrollT || !matches.active) return;
    mdScrollT = setTimeout(() => { mdScrollT = null; renderMatchDock(); }, 120);
  }, { passive: true });
  function fmtRemaining(iso) {
    if (!iso) return '';
    const ms = new Date(iso) - new Date();
    if (ms <= 0) return 'ending…';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  }
  function paintMatchDock() {
    const c = $('#md-content'), logBtn = $('#md-log');
    if (!c || !mdState) return;
    const s = mdState, iAmCh = s.i_am === 'challenger';
    const me = iAmCh ? s.challenger : s.opponent, them = iAmCh ? s.opponent : s.challenger;
    const resolved = s.status === 'resolved' || s.status === 'abandoned';
    // Par-points are unsigned; only legacy elo-delta scores color by sign.
    const sc = (v) => ((s.rules && s.rules.discipline != null) ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    if (resolved) {
      const r = s.status === 'abandoned' ? 'draw' : (s.winner === 'draw' ? 'draw' : ((s.winner === 'challenger') === iAmCh ? 'won' : 'lost'));
      matchDock.classList.add('resolved');
      if (logBtn) logBtn.hidden = true;
      c.innerHTML = `<span class="md-ico ${r}"><svg class="ico"><use href="#i-bolt"/></svg></span>
        <span class="md-body"><span class="md-line1"><b>${r === 'won' ? 'You won 🏆' : r === 'lost' ? 'You lost' : s.status === 'abandoned' ? 'SendOff abandoned' : 'Draw'}</b></span>
        <span class="md-line2">vs ${escapeHTML(them.name)}${me.delta ? ` · ${me.delta > 0 ? '+' : ''}${me.delta} Send Score` : ''}</span></span>`;
      return;
    }
    matchDock.classList.remove('resolved');
    if (logBtn) logBtn.hidden = false;
    const rules = s.rules || {};
    const parMode = rules.discipline != null;
    const noun = rules.discipline === 'boulder' ? 'problems' : 'routes';
    const prog = (rules.best_n && me.counted != null) ? `${Math.min(me.counted, rules.best_n)} of ${rules.best_n} ${noun}`
      : (me.counted != null ? `${me.counted} ${noun}` : '');
    const dockLast = matchLastLine(them);
    const turnHint = parMode && s.turn ? (me.can_log === true ? (dockLast ? `${them.name} ${dockLast} · your turn` : 'your turn') : `${them.name}’s turn`) : '';
    const meta = [prog, turnHint, fmtRemaining(s.window_end)].filter(Boolean).join(' · ');
    // Arena matches (best_n → HP pool) show two mini HP bars + the last hit;
    // legacy null-discipline rows keep the old "X vs Y" score line.
    const arena = parMode && rules.best_n != null && me.score != null;
    if (arena) {
      const hpFull = (rules.best_n || 0) * 8;
      const foePct = Math.max(0, Math.round(100 * (hpFull - me.score) / hpFull));
      const myPct = Math.max(0, Math.round(100 * (hpFull - them.score) / hpFull));
      const tone = (p) => p > 50 ? 'hp-hi' : p > 20 ? 'hp-mid' : 'hp-lo';
      c.innerHTML = `<span class="md-ico"><svg class="ico"><use href="#i-bolt"/></svg></span>
        <span class="md-body">
          <span class="md-hprow"><span class="md-hpnm">You</span><span class="md-mini ${tone(myPct)}"><span style="width:${myPct}%"></span></span></span>
          <span class="md-hprow"><span class="md-hpnm">${escapeHTML((them.name || '').split(' ')[0])}</span><span class="md-mini ${tone(foePct)}"><span style="width:${foePct}%"></span></span></span>
          <span class="md-line2">${escapeHTML(meta)}${mdStale ? ' <span class="md-stale">· offline</span>' : ''}</span>
        </span>`;
    } else {
      const num = (v) => parMode ? `${v}` : `${v > 0 ? '+' : ''}${v}`;
      c.innerHTML = `<span class="md-ico"><svg class="ico"><use href="#i-bolt"/></svg></span>
        <span class="md-body">
          <span class="md-line1"><b class="${sc(me.score)}">${num(me.score)}</b><span class="md-vs">vs</span><b class="${sc(them.score)}">${num(them.score)}</b>${parMode ? ' <span class="md-pts">pts</span>' : ''} <span class="md-them">${escapeHTML(them.name)}</span></span>
          <span class="md-line2">${escapeHTML(meta)}${mdStale ? ' <span class="md-stale">· offline</span>' : ''}</span>
        </span>`;
    }
    // Pop the legacy score when a point lands (arena bars animate via width).
    const prev = matchDock.__mdScore;
    matchDock.__mdScore = me.score;
    if (!arena) {
      const myB = c.querySelector('.md-line1 b');
      if (myB && prev != null && prev !== me.score) mAnim(myB, { transform: ['scale(1)', 'scale(1.34)', 'scale(1)'] }, { duration: 0.42, easing: [0.2, 1.3, 0.4, 1] });
    }
  }

  /* ---------------- Match hub ----------------
     Matches are the heart of the app, so the top of Home (and Climbing) always
     says something about them: the live match when one is on, an incoming or
     outgoing challenge, or — idle — a primary "Challenge a friend" action with
     a recent-results strip. New users with no friends get pointed to Friends.
     A skeleton renders while the first match fetch is in flight. */
  let matchesLoaded = false;
  function renderMatchHub() {
    const els = [$('#match-hub-dash'), $('#match-hub-climb')].filter(Boolean);
    if (!els.length) return;
    if (!CONFIGURED || !cloudOn()) { els.forEach((e) => { e.hidden = true; e.innerHTML = ''; e.__hubHtml = ''; }); renderMatchDock(); return; }
    // Owner-only: a solo practice match against the bot, to verify the flow.
    const practiceBtn = isAdmin ? '<button type="button" class="btn ghost sm" data-hubpractice>🤖 Practice</button>' : '';
    let html = '';
    if (!matchesLoaded) {
      html = `<div class="hub-card hub-skel" aria-hidden="true"><span class="skel skel-ico"></span><span class="skel-lines"><span class="skel skel-line"></span><span class="skel skel-line short"></span></span><span class="skel skel-btn"></span></div>`;
    } else if (matches.active) {
      const a = matches.active;
      const s = mdState && mdState.id === a.id && mdState.status === 'active' ? mdState : null;
      const iAmCh = s && s.i_am === 'challenger';
      const me = s ? (iAmCh ? s.challenger : s.opponent) : null;
      const them = s ? (iAmCh ? s.opponent : s.challenger) : null;
      const parMode = !!(((s && s.rules && s.rules.discipline) || a.discipline) != null);
      const sc = (v) => (parMode ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
      const rules = (s && s.rules && s.rules.style_label) || a.rules_label || 'SendOff';
      const noun = ((s && s.rules && s.rules.discipline) || a.discipline) === 'boulder' ? 'problems' : 'routes';
      const bn = (s && s.rules && s.rules.best_n) != null ? s.rules.best_n : a.best_n;
      const prog = me && me.counted != null ? (bn ? `${Math.min(me.counted, bn)} of ${bn} ${noun}` : `${me.counted} ${noun}`) : '';
      const myTurn = s && me.can_log === true;
      // The hub card is a tight glanceable scoreboard — keep its meta short
      // (the opponent's-last-climb handoff lives on the full match screen + dock,
      // which have room). A long line here clips the avatars off the card edges.
      const turnHint = s && parMode && s.turn ? (myTurn ? 'your turn' : `${them.name}’s turn`) : '';
      const meta = [prog, turnHint, s ? fmtRemaining(s.window_end) : ''].filter(Boolean).join(' · ') || 'syncing…';
      const fmtScore = (v) => parMode ? `${v}` : `${v > 0 ? '+' : ''}${v}`;
      const youScore = s ? `<b class="${sc(me.score)}">${fmtScore(me.score)}</b>` : '<b>—</b>';
      const themName = s ? escapeHTML(them.name) : escapeHTML(a.opponent_name);
      const themScore = s ? `<b class="${sc(them.score)}">${fmtScore(them.score)}</b>` : '<b>—</b>';
      const myFull = !!(s && bn && me.counted != null && me.counted >= bn);
      const logGated = !!(s && parMode && s.turn && !myTurn);
      const logLabel = myFull ? 'Slots full'
        : logGated ? `${escapeHTML((them.name || '').split(' ')[0])}’s turn…`
        : (noun === 'problems' ? 'Log a problem' : 'Log a route');
      // Body = live head + a tight You–vs–opponent scoreboard; action zone on the
      // right (desktop) / below (mobile). Content fills the card like the hero.
      html = `<div class="hub-card hub-active" data-mopen="${a.id}" role="button" tabindex="0">
        <div class="hub-body">
          <div class="hub-live-head"><span class="match-badge live">LIVE</span><span class="hub-rules">${escapeHTML(rules)}</span>${mdStale ? '<span class="feed-stale">offline — last known</span>' : ''}</div>
          <div class="hub-scores">
            <span class="hub-side you">${avatarHTML(myUid(), 'You', 'sm', myAvatarV)}<span class="hub-nm">You</span>${youScore}</span>
            <span class="hub-mid"><span class="hub-vs">vs</span><span class="hub-prog">${escapeHTML(meta)}</span></span>
            <span class="hub-side">${avatarHTML(s ? them.uid : a.opponent, s ? them.name : a.opponent_name, 'sm', s ? them.avatar_v : a.avatar_v)}<span class="hub-nm">${themName}</span>${themScore}</span>
          </div>
        </div>
        <div class="hub-cta-zone"><button type="button" class="btn primary sm" data-hublog${(myFull || logGated) ? ' disabled' : ''}>${logLabel}</button><button type="button" class="btn ghost sm" data-mopen="${a.id}">Open match</button></div>
      </div>`;
    } else if (matches.incoming.length) {
      const m = matches.incoming[0];
      html = `<div class="hub-card hub-idle">
        <div class="hub-body"><div class="hub-idle-title">${escapeHTML(m.opponent_name)} challenged you</div>
        <div class="hub-idle-sub">${escapeHTML(m.rules_label || 'SendOff')} · ${m.ranked === false ? 'no elo at stake' : 'winner takes elo'}</div></div>
        <div class="hub-cta-zone"><button type="button" class="btn primary" data-mact="accept" data-mid="${m.id}">Accept</button><button type="button" class="btn ghost sm" data-mact="decline" data-mid="${m.id}">Decline</button></div>
      </div>`;
    } else if (matches.outgoing.length) {
      const m = matches.outgoing[0];
      html = `<div class="hub-card hub-idle">
        <div class="hub-body"><div class="hub-idle-title">Challenge sent to ${escapeHTML(m.opponent_name)}</div>
        <div class="hub-idle-sub">${escapeHTML(m.rules_label || 'SendOff')} · waiting for them to accept</div></div>
        <div class="hub-cta-zone"><button type="button" class="btn ghost sm" data-mact="cancelm" data-mid="${m.id}">Cancel</button></div>
      </div>`;
    } else if (!friends.list.length) {
      html = `<div class="hub-card hub-idle">
        <div class="hub-body"><div class="hub-idle-title">Ready for a head-to-head?</div>
        <div class="hub-idle-sub">Add a friend, then race a session — each of you plays your own level, so anyone can win.</div></div>
        <div class="hub-cta-zone"><button type="button" class="btn primary" data-hubfriends>Find friends</button>${practiceBtn}</div>
      </div>`;
    } else {
      const chips = matches.history.slice(0, 4).map((m) => {
        // Winner-based, not delta-sign: unranked wins carry delta 0.
        const res = m.status === 'abandoned' ? 'draw' : (m.winner === 'draw' || !m.winner ? 'draw' : (m.winner === m.i_am ? 'won' : 'lost'));
        const lbl = res === 'won' ? 'W' : res === 'lost' ? 'L' : 'D';
        return `<button type="button" class="hub-chip ${res}" data-mopen="${m.id}"><b>${lbl}</b> ${escapeHTML(m.opponent_name)}${m.my_delta ? ` <span>${m.my_delta > 0 ? '+' : ''}${m.my_delta}</span>` : ''}</button>`;
      }).join('');
      html = `<div class="hub-card hub-idle">
        <div class="hub-body"><div class="hub-idle-title">No match on</div>
        <div class="hub-idle-sub">${matches.history.length ? 'Recent results — tap one to revisit it.' : 'Race a friend at your own levels. Winner takes elo.'}</div>
        ${chips ? `<div class="hub-chips">${chips}</div>` : ''}</div>
        <div class="hub-cta-zone"><button type="button" class="btn primary" data-hubchallenge>Challenge a friend</button>${practiceBtn}</div>
      </div>`;
    }
    // The dock's 3s poll re-renders the hub too; skip the write when the card
    // hasn't changed so its avatar imgs keep their painted pixels (no flash).
    els.forEach((e) => { e.hidden = false; if (e.__hubHtml !== html) { e.innerHTML = html; e.__hubHtml = html; } });
    sweepAvatars();
    // The hub owns the single dark primary on the climbing screen (Challenge /
    // Log-in-match). Demote the header "Log a climb" pill to an outline so it
    // doesn't compete — logging stays one tap via it and the FAB.
    const cab = $('#climb-add-btn');
    if (cab) cab.classList.add('is-secondary');
    renderMatchDock(); // hub card visibility gates the dock
  }

  (function bindMatchUI() {
    if (matchModal) {
      $('#match-close').addEventListener('click', closeH2H);
      matchModal.addEventListener('click', (ev) => { if (ev.target === matchModal) closeH2H(); });
    }
    document.addEventListener('click', (ev) => {
      const chal = ev.target.closest('[data-mchal]'); if (chal) { ev.preventDefault(); matchChallenge(chal.dataset.mchal); return; }
      const b = ev.target.closest('[data-mact]'); if (b) { ev.preventDefault(); matchAct(b.dataset.mact, b.dataset.mid); return; }
      // Hub actions — checked before [data-mopen] so buttons inside the live
      // card don't also open the head-to-head.
      const hl = ev.target.closest('[data-hublog]'); if (hl) { ev.preventDefault(); openQuickLog(); return; }
      const hc = ev.target.closest('[data-hubchallenge]'); if (hc) { ev.preventDefault(); openMatchCreate(null); return; }
      const hp = ev.target.closest('[data-hubpractice]'); if (hp) { ev.preventDefault(); openPracticeCreate(); return; }
      const hf = ev.target.closest('[data-hubfriends]'); if (hf) { ev.preventDefault(); showView('friends'); return; }
      const open = ev.target.closest('[data-mopen]'); if (open) { ev.preventDefault(); openH2H(open.dataset.mopen); }
    });
    // The persistent dock: tap the bar → head-to-head; Log → the usual quick sheet.
    const mo = $('#md-open'); if (mo) mo.addEventListener('click', () => { if (matches.active) openH2H(matches.active.id); });
    const ml = $('#md-log'); if (ml) ml.addEventListener('click', () => openQuickLog());
  })();

  /* ----- Climber summary modal: what a leaderboard entry actually did.
     Same privacy stance as the leaderboard itself — grade-by-grade counts
     only, never locations, notes, dates, or individual climbs. ----- */
  const lbModal = $('#lb-modal');
  $('#lb-close').addEventListener('click', () => { lbModal.hidden = true; });
  lbModal.addEventListener('click', (e) => { if (e.target === lbModal) lbModal.hidden = true; });

  /* ----- "How the Send Score works" explainer (static content) ----- */
  const scoreModal = $('#score-modal');
  $$('.score-info-btn').forEach((btn) => {
    btn.addEventListener('click', () => { scoreModal.hidden = false; animOverlayIn(scoreModal); });
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
    animOverlayIn(lbModal);
    try {
      // Whole-history view — the pyramid and sessions never clip to a range.
      const { data, error } = await sb.rpc('climb_user_summary', { target: row.user_id, days: 36500, grp });
      if (error) throw error;
      // Detailed sessions are friends-only: the RPC returns null for a
      // non-friend. Show the public score with an invitation to connect.
      if (!data) {
        box.innerHTML = `<p class="muted small">Add ${escapeHTML(row.display_name)} as a friend to see their sessions.</p>
          <p class="muted small" style="margin-top:6px"><a href="#" class="lb-add-friend" data-uid="${row.user_id}">Send a friend request →</a></p>`;
        const link = box.querySelector('.lb-add-friend');
        if (link) link.addEventListener('click', async (ev) => {
          ev.preventDefault();
          link.textContent = 'Sending…';
          const r = await friendAct('request', row.user_id);
          lbModal.hidden = true; showView('friends');
          // Confirm the outcome — without this the request goes out silently and
          // reads as "nothing happened".
          // No trailing period — display names can already end in one ("Sam K.").
          if (!r || r.error) showToast(`Couldn’t send the request to ${row.display_name} — try again`);
          else if (r.result === 'accepted') showToast(`You’re now friends with ${row.display_name}! 🎉`);
          else if (r.result === 'already_friends') showToast(`Already friends with ${row.display_name}`);
          else if (r.result === 'already_requested') showToast(`Request to ${row.display_name} is already pending`);
          else showToast(`Friend request sent to ${row.display_name}`);
        });
        return;
      }
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
    a.download = `sendoff-${todayISO()}.json`;
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
        alert('Could not import: the file is not a valid SendOff export.');
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
    if (gated) { revealApp(); initSocial(); }
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

  /* ======================================================================
     One-tap social sign-in (Google + Apple)
     ----------------------------------------------------------------------
     Web PWA path: the provider hands back a signed ID token, which we pass
     to Supabase's signInWithIdToken — GoTrue verifies the token's signature
     and audience server-side before issuing a session, exactly the way the
     rest of the app's auth works (no separate backend to run). Google uses
     Identity Services / One Tap for a genuine "Continue as [name]" single
     tap; Apple uses Sign in with Apple JS in a popup. Both are gated on a
     configured public client id — with none set, only email shows.
     ====================================================================== */
  const socialCfg = {
    google: (cfg.googleClientId && !/YOUR-GOOGLE/i.test(cfg.googleClientId)) ? cfg.googleClientId : null,
    apple:  (cfg.appleServicesId && !/YOUR-APPLE/i.test(cfg.appleServicesId)) ? cfg.appleServicesId : null
  };
  const SOCIAL_ON = CONFIGURED && !!(socialCfg.google || socialCfg.apple);

  // Nonce: replay protection for the ID token. GIS embeds the SHA-256 of our
  // raw nonce in the token; Supabase re-hashes the raw value we pass and
  // compares — so the token can't be replayed to a different session.
  function randNonce() {
    const a = new Uint8Array(32); crypto.getRandomValues(a);
    return Array.from(a, (b) => ('0' + b.toString(16)).slice(-2)).join('');
  }
  async function sha256hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => ('0' + b.toString(16)).slice(-2)).join('');
  }
  function loadScript(src, id) {
    return new Promise((resolve, reject) => {
      if (document.getElementById(id)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.defer = true; s.id = id;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  // Cancel is not an error — dismissing the sheet just returns to the login
  // screen. Providers signal this in assorted ways; treat them all as calm.
  function isAuthCancel(e) {
    const code = ((e && (e.error || e.code || e.message)) || '').toString();
    return /popup_closed|closed_by_user|user_cancel|user_trigger_new_signin|abort|canceled|cancelled|dismiss/i.test(code);
  }
  function socialStatus(msg, kind) {
    if (!authStatus) return;
    authStatus.className = 'auth-status' + (kind ? ' ' + kind : '');
    authStatus.textContent = msg || '';
  }
  function setSocialBusy(b) { const g = $('#social-auth'); if (g) g.classList.toggle('busy', !!b); }

  async function exchangeIdToken(provider, token, nonce) {
    setSocialBusy(true);
    try {
      const opts = { provider, token };
      if (nonce) opts.nonce = nonce;
      const { error } = await sb.auth.signInWithIdToken(opts);
      if (error) throw error;
      socialStatus('', ''); // SIGNED_IN fires → the app un-gates
    } catch (e) {
      if (isAuthCancel(e)) socialStatus('', '');
      else socialStatus('Sign-in error: ' + errMsg(e), 'err');
    } finally {
      setSocialBusy(false);
    }
  }

  let googleReady = false, googleNonceRaw = null;
  async function initGoogle() {
    if (!socialCfg.google) return;
    await loadScript('https://accounts.google.com/gsi/client', 'gis-sdk');
    googleNonceRaw = randNonce();
    const hashed = await sha256hex(googleNonceRaw);
    /* global google */
    google.accounts.id.initialize({
      client_id: socialCfg.google,
      callback: (resp) => { if (resp && resp.credential) exchangeIdToken('google', resp.credential, googleNonceRaw); },
      nonce: hashed,
      use_fedcm_for_prompt: true,
      auto_select: false,
      cancel_on_tap_outside: true
    });
    const mount = $('#google-btn');
    if (mount) {
      mount.hidden = false;
      mount.innerHTML = '';
      // Width must be given in px (GIS caps it at 400): match the mount so the
      // button fills the centered social column edge-to-edge on any screen.
      google.accounts.id.renderButton(mount, {
        type: 'standard', theme: 'outline', size: 'large',
        text: 'continue_with', shape: 'pill', logo_alignment: 'left',
        width: Math.min(400, Math.max(200, mount.clientWidth || 300))
      });
    }
    googleReady = true;
    promptOneTap();
  }
  // One Tap: the "Continue as [name]" auto-prompt returning users get — the
  // genuine single tap. Safe to call again whenever we land back on the gate.
  function promptOneTap() {
    if (!googleReady || session) return;
    try { google.accounts.id.prompt(); } catch (e) { /* One Tap unavailable — the button still works */ }
  }

  let appleBound = false;
  async function initApple() {
    if (!socialCfg.apple) return;
    await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js', 'apple-sdk');
    /* global AppleID */
    AppleID.auth.init({
      clientId: socialCfg.apple,
      scope: 'name email',
      redirectURI: location.href.split('#')[0].split('?')[0],
      usePopup: true
    });
    const btn = $('#apple-btn');
    if (btn) {
      btn.hidden = false;
      if (!appleBound) {
        appleBound = true;
        btn.addEventListener('click', async () => {
          try {
            setSocialBusy(true);
            const data = await AppleID.auth.signIn();
            const idToken = data && data.authorization && data.authorization.id_token;
            if (!idToken) throw new Error('No Apple identity token returned');
            // Apple's popup returns a fresh, single-use token each time and
            // Supabase verifies its signature + audience (your Services ID),
            // so we rely on that rather than a nonce round-trip here.
            await exchangeIdToken('apple', idToken, null);
          } catch (e) {
            if (isAuthCancel(e)) socialStatus('', '');
            else socialStatus('Sign-in error: ' + errMsg(e), 'err');
          } finally {
            setSocialBusy(false);
          }
        });
      }
    }
  }

  let socialInited = false;
  function initSocial() {
    if (!SOCIAL_ON) return;
    if (socialInited) { promptOneTap(); return; }
    socialInited = true;
    const wrap = $('#social-auth'); if (wrap) wrap.hidden = false;
    const div = $('#auth-divider'); if (div) div.hidden = false;
    initGoogle().catch((e) => console.warn('Google sign-in unavailable:', e));
    initApple().catch((e) => console.warn('Apple sign-in unavailable:', e));
  }

  /* ---------- First sign-in: pick a @username once ---------- */
  const USERNAME_PROMPTED_KEY = 'gymtrack.username_prompted';
  function usernamePrompted(uid) { try { return localStorage.getItem(USERNAME_PROMPTED_KEY) === uid; } catch (e) { return false; } }
  function markUsernamePrompted(uid) { try { localStorage.setItem(USERNAME_PROMPTED_KEY, uid); } catch (e) { /* ignore */ } }
  // A friendly display-name guess from the email local-part ("audrey.langum"
  // → "Audrey Langum") when a provider gave us no name (email sign-up).
  function suggestName() {
    const cur = currentDisplayName();
    if (cur) return cur;
    const email = (session && session.user && session.user.email) || '';
    const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    return local.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function suggestUsername() {
    const src = (currentDisplayName() || (session && session.user && session.user.email) || '').toString();
    let base = src.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (base.length < 3) base = ('climber' + base).slice(0, 20);
    return base.slice(0, 20);
  }
  // Called ONLY from the SIGNED_IN event (an actual sign-in this session), so
  // an existing user restoring a session on reload is never nagged — and once
  // shown (saved or skipped) a per-user flag means it never appears again.
  async function maybePromptUsername() {
    if (!cloudOn()) return;
    const uid = session.user.id;
    if (usernamePrompted(uid)) return;
    let uname = friends && friends.me ? friends.me.username : undefined;
    if (!uname) {
      try { const { data } = await sb.from('profiles').select('username').eq('id', uid).maybeSingle(); uname = data && data.username; } catch (e) { /* ignore */ }
    }
    if (uname) {
      // Already has a username. Don't re-prompt for it — but a returning user
      // who never set a display name still gets the (separate) name nudge.
      markUsernamePrompted(uid);
      maybePromptName();
      return;
    }
    openUsernameModal();
  }
  function openUsernameModal() {
    const modal = $('#username-modal'); if (!modal) return;
    // This IS the first-run onboarding, so the separate "go to Profile to set a
    // name" nudge must not also fire and yank the screen out from under it.
    namePrompted = true;
    const nameEl = $('#username-modal-name');
    const input = $('#username-modal-input');
    const status = $('#username-modal-status');
    if (status) { status.hidden = true; status.textContent = ''; }
    if (nameEl) nameEl.value = suggestName();
    if (input) input.value = suggestUsername();
    modal.hidden = false;
    setTimeout(() => { const f = nameEl && !nameEl.value ? nameEl : input; if (f) { f.focus(); f.select(); } }, 60);
  }
  function closeUsernameModal() {
    const modal = $('#username-modal'); if (modal) modal.hidden = true;
    if (session && session.user) markUsernamePrompted(session.user.id); // never ask again
  }
  (function bindUsernameModal() {
    const form = $('#username-modal-form');
    const skip = $('#username-modal-skip');
    if (skip) skip.addEventListener('click', () => closeUsernameModal());
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!cloudOn()) return closeUsernameModal();
      const nameEl = $('#username-modal-name');
      const input = $('#username-modal-input');
      const status = $('#username-modal-status');
      const name = (nameEl && nameEl.value || '').trim();
      const handle = (input.value || '').trim().toLowerCase();
      const err = (msg) => { if (status) { status.hidden = false; status.className = 'auth-status err'; status.textContent = msg; } };
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) return err('Username: 3–20 characters — letters, numbers, or underscore.');
      const save = $('#username-modal-save'); if (save) save.disabled = true;
      try {
        // Set the display name locally first so the header/Profile update
        // instantly, then claim the username (its dname mirrors the name into
        // the friends directory — one round-trip, same as the Profile save).
        if (name) await saveSettings({ display_name: name });
        const { error } = await sb.rpc('friend_set_username', { handle, dname: name || currentDisplayName() || null });
        if (error) throw error;
        closeUsernameModal();
        renderAccount(); renderHome(); renderProfile();
        loadFriends();
      } catch (e2) {
        err(/taken|duplicate|unique|23505/i.test(errMsg(e2)) ? 'That username is taken — try another.' : ('Could not save: ' + errMsg(e2)));
      } finally {
        if (save) save.disabled = false;
      }
    });
  })();

  /* ---------- Linked sign-in methods (Profile) ---------- */
  const PROVIDER_META = { google: { icon: 'G', label: 'Google' }, apple: { icon: '', label: 'Apple' }, email: { icon: '✉', label: 'Email' } };
  function isRelayEmail(email) { return /@privaterelay\.appleid\.com$/i.test(email || ''); }
  async function renderLinkedAccounts() {
    const panel = $('#linked-accounts-panel');
    const listEl = $('#linked-accounts-list');
    if (!panel || !listEl) return;
    if (!SOCIAL_ON || !cloudOn() || typeof sb.auth.getUserIdentities !== 'function') { panel.hidden = true; return; }
    let identities = [];
    try {
      const { data } = await sb.auth.getUserIdentities();
      identities = (data && data.identities) || [];
    } catch (e) { panel.hidden = true; return; }
    panel.hidden = false;
    const have = new Set(identities.map((i) => i.provider));
    const rows = identities.map((i) => {
      const m = PROVIDER_META[i.provider] || { icon: '•', label: i.provider };
      const email = (i.identity_data && i.identity_data.email) || '';
      const relay = isRelayEmail(email) ? ' <span class="muted micro">(private relay)</span>' : '';
      const canUnlink = identities.length > 1;
      return `<li class="feed-item"><div class="feed-left"><span class="linked-prov">${escapeHTML(m.icon || m.label[0])}</span><div><b>${escapeHTML(m.label)}</b><span class="muted micro"> ${escapeHTML(email)}${relay}</span></div></div>
        <div class="feed-actions">${canUnlink ? `<button class="btn ghost sm" data-unlink="${i.provider}">Unlink</button>` : `<span class="linked-badge">Primary</span>`}</div></li>`;
    });
    // Offer to link whichever configured provider isn't attached yet.
    ['google', 'apple'].forEach((p) => {
      if (!socialCfg[p] || have.has(p)) return;
      const m = PROVIDER_META[p];
      rows.push(`<li class="feed-item"><div class="feed-left"><span class="linked-prov">${escapeHTML(m.icon || m.label[0])}</span><div><b>${escapeHTML(m.label)}</b><span class="muted micro"> Not linked</span></div></div>
        <div class="feed-actions"><button class="btn primary sm" data-link="${p}">Link</button></div></li>`);
    });
    listEl.innerHTML = rows.join('');
    listEl.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => linkProvider(b.getAttribute('data-link'))));
    listEl.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', () => unlinkProvider(b.getAttribute('data-unlink'), identities)));
  }
  async function linkProvider(provider) {
    const status = $('#linked-accounts-status');
    if (!cloudOn() || typeof sb.auth.linkIdentity !== 'function') return;
    try {
      // Explicit, user-initiated link to THIS account — the safe path for
      // Apple's private-relay email, which won't auto-match your other emails.
      const { error } = await sb.auth.linkIdentity({ provider, options: { redirectTo: location.href.split('#')[0].split('?')[0] } });
      if (error) throw error;
      await renderLinkedAccounts();
    } catch (e) {
      if (status) { status.hidden = false; status.className = 'auth-status err'; status.textContent = errMsg(e); }
    }
  }
  async function unlinkProvider(provider, identities) {
    const status = $('#linked-accounts-status');
    if (!cloudOn() || typeof sb.auth.unlinkIdentity !== 'function') return;
    if ((identities || []).length <= 1) return; // never strip the last method
    const target = identities.find((i) => i.provider === provider);
    if (!target) return;
    try {
      const { error } = await sb.auth.unlinkIdentity(target);
      if (error) throw error;
      await renderLinkedAccounts();
    } catch (e) {
      if (status) { status.hidden = false; status.className = 'auth-status err'; status.textContent = errMsg(e); }
    }
  }

  function currentDisplayName() {
    return getSettings().display_name || '';
  }

  function renderAccount() {
    applyLiftingMode(); // owner sees weightlifting; everyone else gets climbing-only
    const signedIn = CONFIGURED && !!session;
    if (!signedIn) { accountEl.hidden = true; accountEl.innerHTML = ''; return; }
    accountEl.hidden = false;
    const label = currentDisplayName() || session.user.email || 'Account';
    // The shared avatar (photo if set, else stable initials-on-color), opens Profile.
    accountEl.innerHTML = `
      <span class="sync-dot" id="sync-dot" title="Synced"></span>
      <button class="avatar-btn" id="profile-btn" title="${escapeHTML(label)} — profile" aria-label="Profile">${avatarHTML(myUid(), label, 'sm', myAvatarV)}</button>`;
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
    ava.innerHTML = avatarHTML(myUid(), label, 'lg', myAvatarV);
    const rm = $('#avatar-remove'); if (rm) rm.hidden = !(myAvatarV > 0);
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
    renderLinkedAccounts(); // Google/Apple/email link management (async, self-gated)

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
      // Mirror the name into the friends directory so friends see the update.
      if (cloudOn()) sb.rpc('profile_set_display', { dname: name }).then(() => loadFriends()).catch(() => {});
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
    renderFriendsScreen();
    renderFeeds();
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
    initFriends(); // read-only social layer; isolated from the logging path
  }

  // A small build footer on every page, so it's obvious which deploy you're on
  // (the service worker can keep serving an old shell until it updates — the
  // version here is whatever actually loaded). Sourced from the <meta name=build>
  // tag, which the deploy bump keeps in lockstep with the cache tag / SW_VERSION.
  function renderBuildBadge() {
    const build = (document.querySelector('meta[name="build"]') || {}).content || 'dev';
    document.querySelectorAll('.view').forEach((v) => {
      let f = v.querySelector(':scope > .build-badge');
      if (!f) { f = document.createElement('footer'); f.className = 'build-badge'; v.appendChild(f); }
      f.textContent = `SendOff · build ${build}`;
      f.title = 'App version — bumps on every deploy';
    });
  }

  async function boot() {
    renderBuildBadge();
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
          // Onboarding is driven by maybePromptUsername after refresh (below):
          // a single first-run modal for name + @username. It falls back to the
          // Profile name nudge for users who already have a username but no name.
        }
        renderAccount();
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
          await refresh();
        }
        if (event === 'SIGNED_IN') maybePromptUsername(); // fresh sign-in → one onboarding step
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
