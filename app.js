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
  function est1RM(weight, reps) { return reps <= 1 ? weight : weight * (1 + reps / 30); }

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
      exercise: f.get('exercise').trim(),
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

  function liftExercises() {
    return Array.from(new Set(state.lifts.map((l) => l.exercise))).sort();
  }

  function renderLifting() {
    const exercises = liftExercises();
    syncSelect('#lift-filter', exercises, true);
    syncSelect('#lift-chart-exercise', exercises, false);
    renderLiftTable();
    renderLiftChart();
  }

  function syncSelect(sel, options, includeAll) {
    const el = $(sel);
    const prev = el.value;
    el.innerHTML = '';
    if (includeAll) el.add(new Option('All exercises', ''));
    options.forEach((o) => el.add(new Option(o, o)));
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;
  }

  function renderLiftTable() {
    const tbody = $('#lift-table tbody');
    const filter = $('#lift-filter').value;
    const rows = state.lifts
      .filter((l) => !filter || l.exercise === filter)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No sets logged yet.</td></tr>';
      return;
    }
    rows.forEach((l) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtDate(l.date)}</td>
        <td>${escapeHTML(l.exercise)}</td>
        <td>${fmtNum(l.weight)} ${l.unit}</td>
        <td>${l.sets} × ${l.reps}</td>
        <td>${fmtNum(est1RM(l.weight, l.reps))} ${l.unit}</td>
        <td class="muted">${escapeHTML(l.notes)}</td>
        <td><button class="del-btn" title="Delete" aria-label="Delete">✕</button></td>`;
      tr.querySelector('.del-btn').addEventListener('click', () => {
        withSync(async () => {
          await Store.delLift(l.id);
          renderLifting(); renderDashboard();
        });
      });
      tbody.appendChild(tr);
    });
  }

  function renderLiftChart() {
    const ex = $('#lift-chart-exercise').value;
    const prStrip = $('#lift-prs');
    const wrap = $('#lift-chart');

    if (!ex) {
      wrap.innerHTML = '<div class="chart-empty">Log a set to see progress.</div>';
      prStrip.innerHTML = '';
      return;
    }

    const entries = state.lifts
      .filter((l) => l.exercise === ex)
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const byDate = {};
    entries.forEach((l) => {
      const v = est1RM(l.weight, l.reps);
      if (!byDate[l.date] || v > byDate[l.date].value) byDate[l.date] = { value: v, unit: l.unit };
    });
    const points = Object.keys(byDate).sort().map((d) => ({ date: d, value: byDate[d].value }));
    const unit = entries.length ? entries[entries.length - 1].unit : '';

    drawLineChart(wrap, points, (v) => `${fmtNum(v)} ${unit}`);

    const maxWeight = Math.max(...entries.map((l) => l.weight));
    const max1RM = Math.max(...entries.map((l) => est1RM(l.weight, l.reps)));
    const totalVol = entries.reduce((s, l) => s + l.weight * l.sets * l.reps, 0);
    prStrip.innerHTML = `
      <span class="pr-chip">Top weight <b>${fmtNum(maxWeight)} ${unit}</b></span>
      <span class="pr-chip">Best est. 1RM <b>${fmtNum(max1RM)} ${unit}</b></span>
      <span class="pr-chip">Volume <b>${fmtNum(totalVol)} ${unit}</b></span>`;
  }

  $('#lift-filter').addEventListener('change', renderLiftTable);
  $('#lift-chart-exercise').addEventListener('change', renderLiftChart);

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
        <td><button class="del-btn" title="Delete" aria-label="Delete">✕</button></td>`;
      tr.querySelector('.del-btn').addEventListener('click', () => {
        withSync(async () => {
          await Store.delClimb(c.id);
          renderClimbing(); renderDashboard();
        });
      });
      tbody.appendChild(tr);
    });
  }

  function renderClimbChart() {
    const d = $('#climb-chart-discipline').value;
    const wrap = $('#climb-chart');
    const prStrip = $('#climb-prs');

    const sends = state.climbs
      .filter((c) => c.discipline === d && isSend(c.result))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    if (!sends.length) {
      wrap.innerHTML = '<div class="chart-empty">Log a send to see progress.</div>';
      prStrip.innerHTML = '';
      return;
    }

    const byDate = {};
    sends.forEach((c) => {
      const r = gradeRank(d, c.grade);
      if (byDate[c.date] === undefined || r > byDate[c.date]) byDate[c.date] = r;
    });
    const grades = gradesFor(d);
    const points = Object.keys(byDate).sort().map((dt) => ({ date: dt, value: byDate[dt] }));

    drawLineChart(wrap, points, (v) => grades[Math.round(v)] || '');

    const hardestRank = Math.max(...sends.map((c) => gradeRank(d, c.grade)));
    const totalSends = sends.length;
    const flashes = sends.filter((c) => c.result === 'Flash' || c.result === 'Onsight').length;
    prStrip.innerHTML = `
      <span class="pr-chip">Hardest <b>${grades[hardestRank]}</b></span>
      <span class="pr-chip">Sends <b>${totalSends}</b></span>
      <span class="pr-chip">Flash/Onsight <b>${flashes}</b></span>`;
  }

  $('#climb-filter').addEventListener('change', renderClimbTable);
  $('#climb-chart-discipline').addEventListener('change', renderClimbChart);

  /* ======================================================================
     Dashboard
     ====================================================================== */
  function renderDashboard() {
    const liftSessions = new Set(state.lifts.map((l) => l.date)).size;
    const climbSessions = new Set(state.climbs.map((c) => c.date)).size;
    const totalVol = state.lifts.reduce((s, l) => s + l.weight * l.sets * l.reps, 0);
    const totalSends = state.climbs.filter((c) => isSend(c.result)).length;
    const commonUnit = mostCommon(state.lifts.map((l) => l.unit)) || '';

    $('#dash-lift-sessions').textContent = liftSessions;
    $('#dash-lift-volume').textContent = fmtNum(totalVol);
    $('#dash-lift-volume-unit').textContent = totalVol ? commonUnit + ' moved' : '';
    $('#dash-climb-sessions').textContent = climbSessions;
    $('#dash-climb-sends').textContent = totalSends;

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
     Simple SVG line chart
     ====================================================================== */
  function drawLineChart(wrap, points, fmtValue) {
    if (!points.length) {
      wrap.innerHTML = '<div class="chart-empty">No data yet.</div>';
      return;
    }

    const W = 480, H = 200, padL = 46, padR = 14, padT = 14, padB = 28;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const values = points.map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.1;
    min -= pad; max += pad;

    const n = points.length;
    const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v) => padT + innerH - ((v - min) / (max - min)) * innerH;

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

    const ticks = [min + (max - min) * 0.1, (min + max) / 2, max - (max - min) * 0.1];
    const yTicks = ticks.map((t) =>
      `<line class="chart-axis" x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}" opacity="0.4"/>
       <text class="chart-label" x="${padL - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmtValue(t)}</text>`
    ).join('');

    const idxs = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    const xLabels = [...new Set(idxs)].map((i) =>
      `<text class="chart-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtDateShort(points[i].date)}</text>`
    ).join('');

    const dots = points.map((p, i) =>
      `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5"><title>${fmtDateShort(p.date)}: ${fmtValue(p.value)}</title></circle>`
    ).join('');

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Progress chart">
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.6"/>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${yTicks}
        <path class="chart-area" d="${areaPath}"/>
        <path class="chart-line" d="${linePath}"/>
        ${dots}
        ${xLabels}
      </svg>`;
  }

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
  function applyGate() {
    const gated = CONFIGURED && !session;
    document.body.classList.toggle('auth-gated', gated);
    gate.hidden = !gated;
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
    accountEl.innerHTML = `
      <span class="sync-dot" id="sync-dot" title="Synced"></span>
      <button class="acct-name" id="profile-btn" title="Edit your name">${escapeHTML(label)} <span class="edit-ico">✎</span></button>
      <button class="btn ghost" id="signout-btn">Sign out</button>`;
    $('#profile-btn').addEventListener('click', () => openProfile(false));
    $('#signout-btn').addEventListener('click', async () => { await sb.auth.signOut(); });
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
