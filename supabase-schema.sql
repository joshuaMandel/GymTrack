-- ============================================================================
-- GymTrack — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- It creates the two tables and locks them down so each user can only ever
-- read or write their own rows (Row-Level Security).
-- ============================================================================

-- ---------- Tables ----------
create table if not exists public.lifts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null,
  exercise   text not null,
  weight     numeric not null,
  sets       integer not null default 1,
  reps       integer not null,
  unit       text not null default 'lbs',
  notes      text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.climbs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null,
  discipline text not null,
  grade      text not null,
  attempts   integer not null default 1,
  result     text not null,
  color      text default '',   -- hold color of the route ("Blue", "Pink", …)
  location   text default '',
  notes      text default '',
  created_at timestamptz not null default now()
);

-- Existing installs: add the color column if the table predates it.
alter table public.climbs add column if not exists color text default '';

create index if not exists lifts_user_idx  on public.lifts  (user_id);
create index if not exists climbs_user_idx on public.climbs (user_id);

-- ---------- Row-Level Security ----------
alter table public.lifts  enable row level security;
alter table public.climbs enable row level security;

-- A user may do anything to a row only if they own it.
drop policy if exists "own lifts"  on public.lifts;
drop policy if exists "own climbs" on public.climbs;

create policy "own lifts" on public.lifts
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own climbs" on public.climbs
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- Workout routines ----------
-- A routine is a saved training day: a name plus an ordered list of exercises
-- with target sets/reps, stored as JSON. last_run drives the "Up next" hint.
create table if not exists public.routines (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null,
  position   integer not null default 0,
  exercises  jsonb not null default '[]',
  last_run   date,
  created_at timestamptz not null default now()
);

create index if not exists routines_user_idx on public.routines (user_id);

alter table public.routines enable row level security;

drop policy if exists "own routines" on public.routines;
create policy "own routines" on public.routines
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- Send Score leaderboard ----------
-- Signed-in users normally see only their own rows (RLS above). The
-- SECURITY DEFINER functions in this section are the deliberate social
-- surface: standings, per-climber grade summaries, and (via
-- climb_user_history below) each climber's dates, grades, results, and
-- attempts. Locations, notes, and hold colors are NEVER shared.
--
-- It replays every climber's history with the SAME cumulative-points
-- algorithm the app runs client-side (scoreBreakdown in app.js) so your own
-- hero number and your leaderboard number always agree. KEEP THE CONSTANTS
-- AND grade→D MAPS IN SYNC with app.js:
--   • Send points  = max(1, round(5 · 1.5^D))   — exponential in grade D
--       (boulder: VB=-1, V0=0 … V17=17; roped: 5.10c≈D0, standard V-equiv).
--   • Fail penalty = round( (1 + 9/(1+e^(-(Δ-3)/1.4))) , 0.1 ),  Δ = avgD−failD
--       (harder-than-average fail → ~1 pt; the further below average, the
--        more it costs; strictly monotonic and bounded).
--   • Per session: total = max(0, total + Σsend − min(Σpenalty, 24)).
--       Penalty waived if the same climb (grade+color) was sent that
--       session; each distinct failed climb penalised once; avg send D is
--       taken as of the session start; total floored at 0 (never negative);
--       a single session's fails subtract at most 24, so one rough day can't
--       erase weeks. Ties within a date replay in id order on both sides.

-- 'Onsight' was retired from the UI (July 2026): existing rows become
-- flashes. Idempotent — after the first apply this matches zero rows.
update public.climbs set result = 'Flash' where result = 'Onsight';
drop function if exists public.climb_leaderboard(integer, text); -- replaced by Send Score standings
drop function if exists public.climb_send_scores(text);
drop function if exists public.climb_send_scores_impl(text);
drop function if exists public.climb_ss_session(int[], numeric[], text[], text[], text[], numeric);

-- Pure per-session scorer: given one session's climbs (as parallel arrays)
-- and the climber's average send D as of the session start (null if no
-- sends yet), returns the session's send points, raw fail penalty (uncapped),
-- and the sends' count / difficulty-sum / hardest position. Constants here
-- MUST match app.js (SS_P0, SS_GROWTH, SS_PEN_*).
create function public.climb_ss_session(
  b_pos int[], b_d numeric[], b_grade text[], b_color text[], b_result text[], avg_d numeric,
  out send_pts numeric, out raw_pen numeric, out sends_n int, out sends_dsum numeric, out sess_hardest int
)
language plpgsql
immutable
set search_path = public
as $sess$
declare
  P0 constant numeric := 5;   GROWTH constant numeric := 1.5;
  PEN_FLOOR constant numeric := 1; PEN_CEIL constant numeric := 10;
  PEN_MID constant numeric := 3;  PEN_WIDTH constant numeric := 1.4;
  n int := coalesce(array_length(b_pos, 1), 0);
  i int; k text; a numeric; delta numeric; d numeric;
  sent_keys text[] := '{}';
  seen_fail text[] := '{}';
begin
  send_pts := 0; raw_pen := 0; sends_n := 0; sends_dsum := 0; sess_hardest := null;
  -- pre-scan: which climbs (grade+color) were SENT this session
  for i in 1..n loop
    if b_result[i] <> 'Project' then
      sent_keys := sent_keys || (b_grade[i] || '|' || b_color[i]);
    end if;
  end loop;
  for i in 1..n loop
    d := b_d[i];
    if b_result[i] <> 'Project' then
      send_pts := send_pts + greatest(1, round(P0 * power(GROWTH, d)));
      sends_n := sends_n + 1;
      sends_dsum := sends_dsum + d;
      if sess_hardest is null or b_pos[i] > sess_hardest then sess_hardest := b_pos[i]; end if;
    else
      k := b_grade[i] || '|' || b_color[i];
      -- waive if the same climb was sent this session; penalise each distinct
      -- failed climb once (repeat attempts don't stack)
      if (k = any(sent_keys)) or (k = any(seen_fail)) then
        continue;
      end if;
      seen_fail := seen_fail || k;
      a := coalesce(avg_d, d); -- no history yet → treat as at-average (minimal cost)
      delta := a - d;
      raw_pen := raw_pen + round((PEN_FLOOR + (PEN_CEIL - PEN_FLOOR) / (1 + exp(-(delta - PEN_MID) / PEN_WIDTH))) * 10) / 10.0;
    end if;
  end loop;
end
$sess$;

revoke all on function public.climb_ss_session(int[], numeric[], text[], text[], text[], numeric) from public, anon, authenticated;

-- The replay itself: emits every user in history order (RETURN NEXT can't
-- sort). Internal only — the public wrapper below orders and limits it.
create function public.climb_send_scores_impl(grp text default 'boulder')
returns table (
  user_id uuid,
  display_name text,
  is_me boolean,
  score integer,
  sessions integer,
  last_delta integer,
  hardest text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  scale text[];
  dvals numeric[];
  SESSION_CAP constant numeric := 24;
  rec record;
  cur_uid uuid := null;
  cur_date date := null;
  -- running per-user state
  total numeric := 0;
  send_count int := 0;
  send_dsum numeric := 0;
  n_sessions int := 0;
  last_sess_delta numeric := 0;
  hardest_pos int := null;
  -- current session buffer (parallel arrays)
  b_grade text[] := '{}';
  b_color text[] := '{}';
  b_result text[] := '{}';
  b_pos int[] := '{}';
  b_d numeric[] := '{}';
  -- flush scratch
  avg_d numeric;
  before numeric;
  s record;
begin
  if grp = 'boulder' then
    scale := array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17'];
    dvals := array[-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17];
  else
    scale := array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d'];
    dvals := array[-4,-3.5,-3,-2.5,-2,-1,-0.5,0,0.5,1,1.5,2,2.5,3,3.7,4.3,5,6,6.7,7.3,8,9,9.7,10.3,11,12,13,14,15];
  end if;

  for rec in
    select c.user_id as uid, c.date as cdate,
           array_position(scale, c.grade) as pos,
           c.grade as grade, coalesce(c.color, '') as color, c.result as res
    from public.climbs c
    where (case when grp = 'boulder' then c.discipline = 'Bouldering'
                else c.discipline <> 'Bouldering' end)
      and array_position(scale, c.grade) is not null
    order by c.user_id, c.date, c.id -- id breaks same-day ties, matching the app
  loop
    if cur_uid is null then
      cur_uid := rec.uid; cur_date := rec.cdate;
    elsif (rec.uid is distinct from cur_uid) or (rec.cdate is distinct from cur_date) then
      -- flush the buffered session under the current running state
      avg_d := case when send_count > 0 then send_dsum / send_count else null end;
      select * into s from public.climb_ss_session(b_pos, b_d, b_grade, b_color, b_result, avg_d);
      before := total;
      total := greatest(0, total + s.send_pts - least(s.raw_pen, SESSION_CAP));
      last_sess_delta := total - before;
      n_sessions := n_sessions + 1;
      send_count := send_count + s.sends_n;
      send_dsum := send_dsum + s.sends_dsum;
      if s.sess_hardest is not null and (hardest_pos is null or s.sess_hardest > hardest_pos) then
        hardest_pos := s.sess_hardest;
      end if;
      if rec.uid is distinct from cur_uid then
        -- emit the user whose history just finished, then reset per-user state
        user_id := cur_uid;
        select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber')
          into display_name from auth.users u where u.id = cur_uid;
        is_me := cur_uid = auth.uid();
        score := round(total);
        sessions := n_sessions;
        last_delta := round(last_sess_delta);
        hardest := case when hardest_pos is null then null else scale[hardest_pos] end;
        return next;
        total := 0; send_count := 0; send_dsum := 0; n_sessions := 0;
        last_sess_delta := 0; hardest_pos := null;
        cur_uid := rec.uid;
      end if;
      cur_date := rec.cdate;
      b_grade := '{}'; b_color := '{}'; b_result := '{}'; b_pos := '{}'; b_d := '{}';
    end if;

    b_grade := b_grade || rec.grade;
    b_color := b_color || rec.color;
    b_result := b_result || rec.res;
    b_pos := b_pos || rec.pos;
    b_d := b_d || dvals[rec.pos];
  end loop;

  -- flush + emit the final buffered session / user
  if cur_uid is not null then
    avg_d := case when send_count > 0 then send_dsum / send_count else null end;
    select * into s from public.climb_ss_session(b_pos, b_d, b_grade, b_color, b_result, avg_d);
    before := total;
    total := greatest(0, total + s.send_pts - least(s.raw_pen, SESSION_CAP));
    last_sess_delta := total - before;
    n_sessions := n_sessions + 1;
    if s.sess_hardest is not null and (hardest_pos is null or s.sess_hardest > hardest_pos) then
      hardest_pos := s.sess_hardest;
    end if;
    user_id := cur_uid;
    select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber')
      into display_name from auth.users u where u.id = cur_uid;
    is_me := cur_uid = auth.uid();
    score := round(total);
    sessions := n_sessions;
    last_delta := round(last_sess_delta);
    hardest := case when hardest_pos is null then null else scale[hardest_pos] end;
    return next;
  end if;
end
$fn$;

-- Nobody calls the impl directly (definer-only, via the wrapper).
revoke all on function public.climb_send_scores_impl(text) from public, anon, authenticated;

-- What the app calls: top 50 standings, best score first.
create function public.climb_send_scores(grp text default 'boulder')
returns table (
  user_id uuid,
  display_name text,
  is_me boolean,
  score integer,
  sessions integer,
  last_delta integer,
  hardest text
)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.climb_send_scores_impl(grp)
  order by score desc, sessions desc
  limit 50
$$;

revoke all on function public.climb_send_scores(text) from public, anon;
grant execute on function public.climb_send_scores(text) to authenticated;

-- ---------- Per-climber summary (leaderboard drill-down) ----------
-- Aggregates only, same privacy stance as the leaderboard: grade-by-grade
-- counts per result plus a session count. Locations, notes, dates, and
-- individual climbs are never revealed. Scoped by grade-scale group like
-- the leaderboard: 'boulder' (V scale) or 'rope' (YDS — Sport/TR/Trad).
drop function if exists public.climb_user_summary(uuid, integer, text); -- param renamed disc -> grp
create function public.climb_user_summary(target uuid, days integer default 30, grp text default 'boulder')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'display_name', coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber'),
    'sessions', (
      select count(distinct c.date)
      from public.climbs c
      where c.user_id = target
        and (case when grp = 'boulder' then c.discipline = 'Bouldering' else c.discipline <> 'Bouldering' end)
        and c.date >= current_date - days
    ),
    'by_grade', coalesce((
      select jsonb_agg(jsonb_build_object('grade', t.grade, 'result', t.result, 'n', t.n))
      from (
        select c.grade, c.result, count(*) as n
        from public.climbs c
        where c.user_id = target
          and (case when grp = 'boulder' then c.discipline = 'Bouldering' else c.discipline <> 'Bouldering' end)
          and c.date >= current_date - days
        group by c.grade, c.result
      ) t
    ), '[]'::jsonb)
  )
  from auth.users u
  where u.id = target
$$;

revoke all on function public.climb_user_summary(uuid, integer, text) from public, anon;
grant execute on function public.climb_user_summary(uuid, integer, text) to authenticated;

-- ---------- Per-climber session history (summary drill-down) ----------
-- The replayable fields for one climber's discipline group, in the app's
-- exact replay order (date, then id) — the client runs its own scoring
-- engine over these to show per-session and per-climb Send Score changes.
-- Deliberately shared: dates, grades, results, attempts. Deliberately
-- withheld: locations, notes, hold colors.
drop function if exists public.climb_user_history(uuid, text);
create function public.climb_user_history(target uuid, grp text default 'boulder')
returns table (
  id uuid,
  date date,
  discipline text,
  grade text,
  attempts integer,
  result text
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.date, c.discipline, c.grade, c.attempts, c.result
  from public.climbs c
  where c.user_id = target
    and (case when grp = 'boulder' then c.discipline = 'Bouldering' else c.discipline <> 'Bouldering' end)
    and array_position(
      case when grp = 'boulder'
        then array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17']::text[]
        else array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d']::text[]
      end, c.grade) is not null
  order by c.date, c.id
$$;

revoke all on function public.climb_user_history(uuid, text) from public, anon;
grant execute on function public.climb_user_history(uuid, text) to authenticated;
