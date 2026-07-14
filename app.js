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
  let state = { lifts: [], climbs: [] };

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
  const sb = CONFIGURED ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;

  let session = null;            // current auth session (or null)
  let migrationHandled = false;  // only prompt to migrate once per page load

  /* ----- Local persistence ----- */
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d.lifts) && Array.isArray(d.climbs)) return d;
      }
    } catch (e) { /* ignore */ }
    return { lifts: [], climbs: [] };
  }
  function saveLocal() {
    localStorage.setItem(STORE_KEY, JSON.stringify({ lifts: state.lifts, climbs: state.climbs }));
  }
  function clearLocal() { localStorage.removeItem(STORE_KEY); }

  /* ----- Row mapping between DB and UI shapes ----- */
  const liftRow = (l) => ({
    date: l.date, exercise: l.exercise, weight: Number(l.weight),
    sets: Number(l.sets), reps: Number(l.reps), unit: l.unit, notes: l.notes || ''
  });
  const climbRow = (c) => ({
    date: c.date, discipline: c.discipline, grade: c.grade,
    attempts: Number(c.attempts), result: c.result, location: c.location || '', notes: c.notes || ''
  });
  const fromLift = (r) => ({ id: r.id, ...liftRow(r) });
  const fromClimb = (r) => ({ id: r.id, ...climbRow(r) });

  const cloudOn = () => !!(sb && session);

  /* ----- Unified data layer ----- */
  const Store = {
    async load() {
      if (cloudOn()) {
        const [lifts, climbs] = await Promise.all([
          sb.from('lifts').select('*').order('date', { ascending: true }),
          sb.from('climbs').select('*').order('date', { ascending: true })
        ]);
        if (lifts.error) throw lifts.error;
        if (climbs.error) throw climbs.error;
        state.lifts = lifts.data.map(fromLift);
        state.climbs = climbs.data.map(fromClimb);
      } else {
        const local = loadLocal();
        state.lifts = local.lifts;
        state.climbs = local.climbs;
      }
    },
    async addLift(entry) {
      if (cloudOn()) {
        const { data, error } = await sb.from('lifts').insert(liftRow(entry)).select().single();
        if (error) throw error;
        state.lifts.push(fromLift(data));
      } else {
        state.lifts.push({ id: uid(), ...entry });
        saveLocal();
      }
    },
    async addClimb(entry) {
      if (cloudOn()) {
        const { data, error } = await sb.from('climbs').insert(climbRow(entry)).select().single();
        if (error) throw error;
        state.climbs.push(fromClimb(data));
      } else {
        state.climbs.push({ id: uid(), ...entry });
        saveLocal();
      }
    },
    async updateLift(id, entry) {
      if (cloudOn()) {
        const { data, error } = await sb.from('lifts').update(liftRow(entry)).eq('id', id).select().single();
        if (error) throw error;
        const i = state.lifts.findIndex((x) => x.id === id);
        if (i !== -1) state.lifts[i] = fromLift(data);
      } else {
        const i = state.lifts.findIndex((x) => x.id === id);
        if (i !== -1) state.lifts[i] = { id, ...entry };
        saveLocal();
      }
    },
    async updateClimb(id, entry) {
      if (cloudOn()) {
        const { data, error } = await sb.from('climbs').update(climbRow(entry)).eq('id', id).select().single();
        if (error) throw error;
        const i = state.climbs.findIndex((x) => x.id === id);
        if (i !== -1) state.climbs[i] = fromClimb(data);
      } else {
        const i = state.climbs.findIndex((x) => x.id === id);
        if (i !== -1) state.climbs[i] = { id, ...entry };
        saveLocal();
      }
    },
    async delLift(id) {
      if (cloudOn()) {
        const { error } = await sb.from('lifts').delete().eq('id', id);
        if (error) throw error;
      }
      state.lifts = state.lifts.filter((x) => x.id !== id);
      if (!cloudOn()) saveLocal();
    },
    async delClimb(id) {
      if (cloudOn()) {
        const { error } = await sb.from('climbs').delete().eq('id', id);
        if (error) throw error;
      }
      state.climbs = state.climbs.filter((x) => x.id !== id);
      if (!cloudOn()) saveLocal();
    },
    async resetAll() {
      if (cloudOn()) {
        const uidv = session.user.id;
        const a = await sb.from('lifts').delete().eq('user_id', uidv);
        const b = await sb.from('climbs').delete().eq('user_id', uidv);
        if (a.error) throw a.error;
        if (b.error) throw b.error;
        state.lifts = []; state.climbs = [];
      } else {
        state = { lifts: [], climbs: [] };
        saveLocal();
      }
    },
    async importData(data) {
      if (cloudOn()) {
        if (data.lifts.length) {
          const { error } = await sb.from('lifts').insert(data.lifts.map(liftRow));
          if (error) throw error;
        }
        if (data.climbs.length) {
          const { error } = await sb.from('climbs').insert(data.climbs.map(climbRow));
          if (error) throw error;
        }
        await this.load();
      } else {
        state = { lifts: data.lifts, climbs: data.climbs };
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
  const todayISO = () => new Date().toISOString().slice(0, 10);
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
    }
  }

  /* ======================================================================
     Tabs
     ====================================================================== */
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach((b) => b.classList.remove('is-active'));
      $$('.view').forEach((v) => v.classList.remove('is-active'));
      btn.classList.add('is-active');
      $('#view-' + btn.dataset.view).classList.add('is-active');
    });
  });

  /* ======================================================================
     Weightlifting
     ====================================================================== */
  const liftForm = $('#lift-form');
  $('#lift-date').value = todayISO();

  liftForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(liftForm);
    const entry = {
      date: f.get('date'),
      exercise: canonicalExercise(f.get('exercise')),
      weight: parseFloat(f.get('weight')),
      sets: parseInt(f.get('sets'), 10),
      reps: parseInt(f.get('reps'), 10),
      unit: f.get('unit'),
      notes: (f.get('notes') || '').trim()
    };
    if (!entry.exercise || isNaN(entry.weight) || isNaN(entry.reps)) return;
    withSync(async () => {
      await Store.addLift(entry);
      liftForm.reset();
      $('#lift-date').value = todayISO();
      $('#lift-unit').value = entry.unit;
      renderLifting();
      renderDashboard();
    });
  });

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

  const DEFAULT_EXERCISES = ['Back Squat', 'Front Squat', 'Bench Press', 'Overhead Press', 'Deadlift', 'Barbell Row', 'Pull-up'];

  function refreshExerciseDatalist() {
    const dl = $('#exercise-list');
    const seen = new Set();
    const names = [];
    // User's own exercises first, then remaining defaults
    Object.values(exerciseDisplayMap()).sort().forEach((n) => {
      if (!seen.has(exKey(n))) { seen.add(exKey(n)); names.push(n); }
    });
    DEFAULT_EXERCISES.forEach((n) => {
      if (!seen.has(exKey(n))) { seen.add(exKey(n)); names.push(n); }
    });
    dl.innerHTML = '';
    names.forEach((n) => dl.appendChild(new Option(n, n)));
  }

  function renderLifting() {
    const map = exerciseDisplayMap();
    const el = $('#lift-filter');
    const prev = el.value;
    el.innerHTML = '';
    el.add(new Option('All exercises', ''));
    Object.keys(map).sort((a, b) => map[a].localeCompare(map[b])).forEach((k) => el.add(new Option(map[k], k)));
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;

    refreshExerciseDatalist();
    renderLiftTable();
    renderLiftChart();
  }

  function renderLiftTable() {
    const tbody = $('#lift-table tbody');
    const filter = $('#lift-filter').value; // an exercise key, or ''
    const display = exerciseDisplayMap();
    const rows = state.lifts
      .filter((l) => !filter || exKey(l.exercise) === filter)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No sets logged yet.</td></tr>';
      return;
    }
    rows.forEach((l) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtDate(l.date)}</td>
        <td>${escapeHTML(display[exKey(l.exercise)] || l.exercise)}</td>
        <td>${fmtNum(l.weight)} ${l.unit}</td>
        <td>${l.sets} × ${l.reps}</td>
        <td class="muted">${escapeHTML(l.notes)}</td>
        <td class="row-actions">
          <button class="edit-btn" title="Edit" aria-label="Edit">✎</button>
          <button class="del-btn" title="Delete" aria-label="Delete">✕</button>
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

  // Per-exercise, per-session series for the selected metric.
  // metric: 'top' (heaviest weight), 'volume' (weight×sets×reps), 'reps' (sets×reps)
  // Exercises are grouped case-insensitively (see exKey).
  function liftSeries(metric) {
    const unit = dominantUnit();
    const display = exerciseDisplayMap();
    const byEx = {};
    state.lifts.forEach((l) => {
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
    const prStrip = $('#lift-prs');
    const wrap = $('#lift-chart');
    const unit = dominantUnit();

    if (!state.lifts.length) {
      wrap.innerHTML = '<div class="chart-empty">Log a set to see progress.</div>';
      prStrip.innerHTML = '';
      return;
    }

    const fmt = metric === 'reps' ? (v) => fmtNum(Math.round(v)) : (v) => `${fmtCompact(v)} ${unit}`;
    drawChart(wrap, liftSeries(metric), fmt);

    // PR chips (all-time, across every exercise)
    const display = exerciseDisplayMap();
    let heaviest = null;
    state.lifts.forEach((l) => {
      const w = toUnit(l.weight, l.unit, unit);
      if (!heaviest || w > heaviest.w) heaviest = { w, exercise: display[exKey(l.exercise)] || l.exercise };
    });
    const volByDate = {};
    state.lifts.forEach((l) => {
      volByDate[l.date] = (volByDate[l.date] || 0) + toUnit(l.weight, l.unit, unit) * l.sets * l.reps;
    });
    const bestSession = Math.max(...Object.values(volByDate));
    const totalVol = Object.values(volByDate).reduce((s, v) => s + v, 0);
    prStrip.innerHTML = `
      <span class="pr-chip">Heaviest lift <b>${fmtNum(heaviest.w)} ${unit}</b> (${escapeHTML(heaviest.exercise)})</span>
      <span class="pr-chip">Best session volume <b>${fmtCompact(bestSession)} ${unit}</b></span>
      <span class="pr-chip">All-time volume <b>${fmtCompact(totalVol)} ${unit}</b></span>`;
  }

  $('#lift-filter').addEventListener('change', renderLiftTable);
  $('#lift-chart-metric').addEventListener('change', renderLiftChart);

  /* ======================================================================
     Rock climbing
     ====================================================================== */
  const climbForm = $('#climb-form');
  $('#climb-date').value = todayISO();

  function populateGradeSelect() {
    const d = $('#climb-discipline').value;
    const sel = $('#climb-grade');
    const prev = sel.value;
    sel.innerHTML = '';
    gradesFor(d).forEach((g) => sel.add(new Option(g, g)));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  $('#climb-discipline').addEventListener('change', populateGradeSelect);
  populateGradeSelect();

  climbForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(climbForm);
    const entry = {
      date: f.get('date'),
      discipline: f.get('discipline'),
      grade: f.get('grade'),
      attempts: parseInt(f.get('attempts'), 10) || 1,
      result: f.get('result'),
      location: (f.get('location') || '').trim(),
      notes: (f.get('notes') || '').trim()
    };
    withSync(async () => {
      await Store.addClimb(entry);
      const keepDisc = entry.discipline;
      climbForm.reset();
      $('#climb-date').value = todayISO();
      $('#climb-discipline').value = keepDisc;
      populateGradeSelect();
      renderClimbing();
      renderDashboard();
    });
  });

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
        <td>${fmtDate(c.date)}</td>
        <td><span class="badge ${discClass}">${c.discipline}</span></td>
        <td><b>${c.grade}</b></td>
        <td><span class="badge ${resClass}">${c.result}</span></td>
        <td>${c.attempts}</td>
        <td class="muted">${escapeHTML(c.location)}</td>
        <td class="muted">${escapeHTML(c.notes)}</td>
        <td class="row-actions">
          <button class="edit-btn" title="Edit" aria-label="Edit">✎</button>
          <button class="del-btn" title="Delete" aria-label="Delete">✕</button>
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
  function hardestSeries(discipline) {
    const byDate = {};
    state.climbs
      .filter((c) => c.discipline === discipline && isSend(c.result))
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
  function sendsSeries(discipline) {
    const byDate = {};
    state.climbs
      .filter((c) => c.discipline === discipline && isSend(c.result))
      .forEach((c) => { byDate[c.date] = (byDate[c.date] || 0) + 1; });
    return {
      label: discipline,
      points: Object.keys(byDate).sort().map((d) => ({ date: d, value: byDate[d] }))
    };
  }

  function renderClimbChart() {
    const metric = $('#climb-chart-metric').value;
    const wrap = $('#climb-chart');
    const prStrip = $('#climb-prs');

    const sends = state.climbs.filter((c) => isSend(c.result));
    if (!sends.length) {
      wrap.innerHTML = '<div class="chart-empty">Log a send to see progress.</div>';
      prStrip.innerHTML = '';
      return;
    }

    if (metric === 'sends') {
      drawChart(wrap, ALL_DISCIPLINES.map(sendsSeries), (v) => fmtNum(Math.round(v)));
    } else {
      // Hardest sends: bouldering (V scale) and ropes (YDS) use different
      // scales, so each gets its own chart and axis.
      wrap.innerHTML = '';
      const boulder = hardestSeries('Bouldering');
      const ropes = ROPE_DISCIPLINES.map(hardestSeries).filter((s) => s.points.length);
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

  /* ======================================================================
     Edit-entry modal
     ====================================================================== */
  const editModal = $('#edit-modal');
  const editLiftForm = $('#edit-lift-form');
  const editClimbForm = $('#edit-climb-form');
  const editStatus = $('#edit-status');
  let editingLiftId = null;
  let editingClimbId = null;

  function populateEditGradeSelect() {
    const d = $('#edit-climb-discipline').value;
    const sel = $('#edit-climb-grade');
    const prev = sel.value;
    sel.innerHTML = '';
    gradesFor(d).forEach((g) => sel.add(new Option(g, g)));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  $('#edit-climb-discipline').addEventListener('change', populateEditGradeSelect);

  function openEditModal(kind) {
    editLiftForm.hidden = kind !== 'lift';
    editClimbForm.hidden = kind !== 'climb';
    $('#edit-title').textContent = kind === 'lift' ? 'Edit set' : 'Edit climb';
    editStatus.textContent = '';
    editStatus.className = 'auth-status';
    editModal.hidden = false;
  }
  function closeEditModal() {
    editModal.hidden = true;
    editingLiftId = null;
    editingClimbId = null;
  }
  $('#edit-close').addEventListener('click', closeEditModal);
  editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });

  function openEditLift(l) {
    editingLiftId = l.id;
    editLiftForm.elements.date.value = l.date;
    editLiftForm.elements.exercise.value = l.exercise;
    editLiftForm.elements.weight.value = l.weight;
    editLiftForm.elements.sets.value = l.sets;
    editLiftForm.elements.reps.value = l.reps;
    editLiftForm.elements.unit.value = l.unit;
    editLiftForm.elements.notes.value = l.notes || '';
    openEditModal('lift');
  }

  function openEditClimb(c) {
    editingClimbId = c.id;
    editClimbForm.elements.date.value = c.date;
    editClimbForm.elements.discipline.value = c.discipline;
    populateEditGradeSelect();
    editClimbForm.elements.grade.value = c.grade;
    editClimbForm.elements.attempts.value = c.attempts;
    editClimbForm.elements.result.value = c.result;
    editClimbForm.elements.location.value = c.location || '';
    editClimbForm.elements.notes.value = c.notes || '';
    openEditModal('climb');
  }

  editLiftForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingLiftId) return;
    const f = new FormData(editLiftForm);
    const entry = {
      date: f.get('date'),
      exercise: canonicalExercise(f.get('exercise')),
      weight: parseFloat(f.get('weight')),
      sets: parseInt(f.get('sets'), 10),
      reps: parseInt(f.get('reps'), 10),
      unit: f.get('unit'),
      notes: (f.get('notes') || '').trim()
    };
    if (!entry.exercise || isNaN(entry.weight) || isNaN(entry.reps)) return;
    const id = editingLiftId;
    withSync(async () => {
      await Store.updateLift(id, entry);
      closeEditModal();
      renderLifting();
      renderDashboard();
    });
  });

  editClimbForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingClimbId) return;
    const f = new FormData(editClimbForm);
    const entry = {
      date: f.get('date'),
      discipline: f.get('discipline'),
      grade: f.get('grade'),
      attempts: parseInt(f.get('attempts'), 10) || 1,
      result: f.get('result'),
      location: (f.get('location') || '').trim(),
      notes: (f.get('notes') || '').trim()
    };
    const id = editingClimbId;
    withSync(async () => {
      await Store.updateClimb(id, entry);
      closeEditModal();
      renderClimbing();
      renderDashboard();
    });
  });

  /* ======================================================================
     Dashboard
     ====================================================================== */
  // "▲ 12% vs prior 30 days" — trend annotation under a stat value
  function setDelta(sel, cur, prev) {
    const el = $(sel);
    el.classList.remove('up', 'down');
    if (!cur && !prev) { el.textContent = ''; return; }
    if (!prev) { el.textContent = 'new this period'; el.classList.add('up'); return; }
    const diff = cur - prev;
    if (diff === 0) { el.textContent = 'same as prior 30d'; return; }
    const pct = Math.round(Math.abs(diff) / prev * 100);
    el.textContent = `${diff > 0 ? '▲' : '▼'} ${pct}% vs prior 30d`;
    el.classList.add(diff > 0 ? 'up' : 'down');
  }

  function renderDashboard() {
    const unit = dominantUnit();
    const cut30 = daysAgoISO(30);
    const cut60 = daysAgoISO(60);
    const inLast30 = (x) => x.date >= cut30;
    const inPrev30 = (x) => x.date >= cut60 && x.date < cut30;

    // Lifting: sessions + volume, last 30 days vs the 30 before
    const liftVol = (rows) => rows.reduce((s, l) => s + toUnit(l.weight, l.unit, unit) * l.sets * l.reps, 0);
    const liftSess = (rows) => new Set(rows.map((l) => l.date)).size;
    const lifts30 = state.lifts.filter(inLast30);
    const liftsPrev = state.lifts.filter(inPrev30);

    $('#dash-lift-sessions').textContent = liftSess(lifts30);
    setDelta('#dash-lift-sessions-delta', liftSess(lifts30), liftSess(liftsPrev));
    $('#dash-lift-volume').textContent = fmtCompact(liftVol(lifts30));
    $('#dash-lift-volume-unit').textContent = unit + ' moved';
    setDelta('#dash-lift-volume-delta', Math.round(liftVol(lifts30)), Math.round(liftVol(liftsPrev)));

    // Climbing: sessions + sends
    const climbSess = (rows) => new Set(rows.map((c) => c.date)).size;
    const sendCount = (rows) => rows.filter((c) => isSend(c.result)).length;
    const climbs30 = state.climbs.filter(inLast30);
    const climbsPrev = state.climbs.filter(inPrev30);

    $('#dash-climb-sessions').textContent = climbSess(climbs30);
    setDelta('#dash-climb-sessions-delta', climbSess(climbs30), climbSess(climbsPrev));
    $('#dash-climb-sends').textContent = sendCount(climbs30);
    setDelta('#dash-climb-sends-delta', sendCount(climbs30), sendCount(climbsPrev));

    // Weekly trend charts (last 12 weeks, empty weeks shown as zero)
    const weeks = [];
    const start = weekStart(daysAgoISO(7 * 11));
    for (let i = 0; i < 12; i++) {
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
    drawChart($('#dash-lift-chart'),
      [{ label: 'Volume', points: weeks.map((w) => ({ date: w, value: volByWeek[w] || 0 })) }],
      (v) => `${fmtCompact(v)} ${unit}`);

    const sendSeries = ALL_DISCIPLINES.map((disc) => {
      const byWeek = {};
      state.climbs
        .filter((c) => c.discipline === disc && isSend(c.result))
        .forEach((c) => {
          const w = weekStart(c.date);
          if (wIndex.has(w)) byWeek[w] = (byWeek[w] || 0) + 1;
        });
      return Object.keys(byWeek).length
        ? { label: disc, points: weeks.map((w) => ({ date: w, value: byWeek[w] || 0 })) }
        : { label: disc, points: [] };
    });
    drawChart($('#dash-climb-chart'), sendSeries, (v) => fmtNum(Math.round(v)));

    // Recent activity feeds
    renderFeed('#dash-lift-feed', state.lifts, (l) => ({
      main: l.exercise,
      sub: `${fmtNum(l.weight)} ${l.unit} · ${l.sets}×${l.reps}`,
      date: l.date
    }), 'No lifting logged yet.');

    renderFeed('#dash-climb-feed', state.climbs, (c) => ({
      main: `${c.grade} · ${c.discipline}`,
      sub: `${c.result}${c.location ? ' · ' + c.location : ''}`,
      date: c.date
    }), 'No climbing logged yet.');
  }

  function renderFeed(sel, items, mapFn, emptyMsg) {
    const el = $(sel);
    const rows = items.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
    if (!rows.length) {
      el.innerHTML = `<li class="empty">${emptyMsg}</li>`;
      return;
    }
    el.innerHTML = rows.map((it) => {
      const m = mapFn(it);
      return `<li>
        <div>
          <div class="feed-main">${escapeHTML(m.main)}</div>
          <div class="feed-sub">${escapeHTML(m.sub)}</div>
        </div>
        <div class="feed-date">${fmtDateShort(m.date)}</div>
      </li>`;
    }).join('');
  }

  /* ======================================================================
     Multi-series SVG line chart
     series: [{ label, points: [{date, value}] }] — dates form a shared x axis.
     ====================================================================== */
  const CHART_COLORS = ['#f5a524', '#38bdf8', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#facc15'];

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

    const W = 480, H = 200, padL = 46, padR = 14, padT = 14, padB = 28;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = dates.length;
    const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v) => padT + innerH - ((v - min) / (max - min)) * innerH;

    const ticks = [min + (max - min) * 0.1, (min + max) / 2, max - (max - min) * 0.1];
    const yTicks = ticks.map((t) =>
      `<line class="chart-axis" x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}" opacity="0.4"/>
       <text class="chart-label" x="${padL - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmtValue(t)}</text>`
    ).join('');

    const idxs = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    const xLabels = [...new Set(idxs)].map((i) =>
      `<text class="chart-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtDateShort(dates[i])}</text>`
    ).join('');

    const seriesSvg = series.map((s, si) => {
      const color = CHART_COLORS[si % CHART_COLORS.length];
      const pts = s.points.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(xi.get(p.date)).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
      const dots = pts.map((p) =>
        `<circle cx="${x(xi.get(p.date)).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="${color}"><title>${escapeHTML(s.label)} — ${fmtDateShort(p.date)}: ${fmtValue(p.value)}</title></circle>`
      ).join('');
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>${dots}`;
    }).join('');

    const legend = series.length > 1
      ? `<div class="chart-legend">${series.map((s, si) =>
          `<span class="legend-item"><span class="legend-dot" style="background:${CHART_COLORS[si % CHART_COLORS.length]}"></span>${escapeHTML(s.label)}</span>`
        ).join('')}</div>`
      : '';

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Progress chart">
        ${yTicks}
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
    return d.toISOString().slice(0, 10);
  }
  const fmtCompact = (n) => Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });

  /* ======================================================================
     Export / Import / Reset
     ====================================================================== */
  $('#export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ lifts: state.lifts, climbs: state.climbs }, null, 2)], { type: 'application/json' });
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

  // Show only the gate when Supabase is configured and nobody is signed in.
  // Also lifts the boot splash — by the time this runs, auth state is known,
  // so we can reveal the right screen without the app flashing first.
  function applyGate() {
    const gated = CONFIGURED && !session;
    document.body.classList.toggle('auth-gated', gated);
    gate.hidden = !gated;
    document.body.classList.remove('booting');
  }

  // Send the magic-link sign-in email (gate form)
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
      authStatus.className = 'auth-status ok';
      authStatus.textContent = 'Check your email for the login link, then come back here.';
    } catch (err) {
      console.error('Sign-in error:', err);
      authStatus.className = 'auth-status err';
      authStatus.textContent = 'Error: ' + errMsg(err);
    } finally {
      submit.disabled = false;
    }
  });

  function currentDisplayName() {
    return (session && session.user && session.user.user_metadata && session.user.user_metadata.display_name) || '';
  }

  function renderAccount() {
    if (!CONFIGURED || !session) { accountEl.hidden = true; accountEl.innerHTML = ''; return; }
    accountEl.hidden = false;
    const label = currentDisplayName() || session.user.email || 'Account';
    // Compact chip: name opens the profile modal (edit name / sign out).
    accountEl.innerHTML = `
      <span class="sync-dot" id="sync-dot" title="Synced"></span>
      <button class="acct-name" id="profile-btn" title="Account">${escapeHTML(label)} <span class="edit-ico">✎</span></button>`;
    $('#profile-btn').addEventListener('click', () => openProfile(false));
  }

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
      alert('Could not load data: ' + errMsg(e));
    } finally {
      setSync(false);
    }
    renderAll();
  }

  async function boot() {
    if (sb) {
      // React to sign-in / sign-out / profile updates
      sb.auth.onAuthStateChange(async (event, newSession) => {
        session = newSession;
        applyGate();
        if (event === 'SIGNED_IN') {
          await maybeMigrate();
          maybePromptName();
        }
        renderAccount();
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
          await refresh();
        }
      });

      const { data } = await sb.auth.getSession();
      session = data.session;
      applyGate();
      renderAccount();
      await refresh();
    } else {
      // Supabase not configured — run in local-only mode (no gate).
      applyGate();
      renderAccount();
      await refresh();
    }
  }

  boot();
})();
