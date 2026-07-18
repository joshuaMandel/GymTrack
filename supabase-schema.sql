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
-- It replays every climber's history with the SAME converging Elo rating the
-- app runs client-side (scoreBreakdown in app.js) so your own hero number and
-- your leaderboard number always agree. KEEP THE CONSTANTS AND grade→D MAPS
-- IN SYNC with app.js (SS_BASE, SS_STEP, SS_SPREAD, SS_K_*, SS_FLASH_EDGE):
--   • routeRating = 1000 + 100·D   (boulder VB=-1 … V17=17; roped 5.10c≈D0),
--     plus a +300 offset for roped so a 5.10c climber lands ~1300 not 1000
--     (a pure display shift — both R and routeR move together, dynamics unchanged).
--   • Each climb updates the rating like a chess match against the route:
--       E = 1 / (1 + 10^((routeR − R)/200));   R += K·(didSend − E)
--     so the rating CONVERGES to the climber's level and volume can't inflate
--     it (easy sends have E≈1, barely moving R). Failing a route ABOVE your
--     level barely moves R (E small); failing AT your level costs about what a
--     send there earns; failing BELOW costs more. A flash adds +30 to routeR.
--   • R is seeded at the climber's first send grade (else first climb) so a
--     new climber starts near their level. K = 40 for the first 5 sessions
--     (provisional, fast convergence) then 16 (stable). Ties within a date
--     replay in id order on both sides.

-- 'Onsight' was retired from the UI (July 2026): existing rows become
-- flashes. Idempotent — after the first apply this matches zero rows.
update public.climbs set result = 'Flash' where result = 'Onsight';
drop function if exists public.climb_leaderboard(integer, text); -- replaced by Send Score standings
drop function if exists public.climb_send_scores(text);
drop function if exists public.climb_send_scores_impl(text);
drop function if exists public.climb_ss_session(int[], numeric[], text[], text[], text[], numeric); -- retired points model

-- The replay itself: emits every user in history order (RETURN NEXT can't
-- sort). Internal only — the public wrapper below orders and limits it.
create function public.climb_send_scores_impl(grp text default 'boulder')
returns table (
  user_id uuid,
  display_name text,
  is_me boolean,
  score integer,
  sessions integer,
  provisional boolean,
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
  BASE constant numeric := 1000; STEP constant numeric := 100; SPREAD constant numeric := 200;
  K_PROV constant numeric := 40; K_EST constant numeric := 16; PROV_SESSIONS constant int := 5;
  FLASH_EDGE constant numeric := 30;
  ROPE_OFFSET constant numeric := 300;  -- roped ratings sit higher: 5.10c→~1300, not 1000
  disc_offset numeric := 0;             -- 0 for boulder, ROPE_OFFSET for roped (pure display shift)
  rec record;
  cur_uid uuid := null;
  cur_date date := null;
  -- running per-user state
  R numeric := 0;
  s_idx int := 0;                 -- session index (drives K and provisional)
  n_sessions int := 0;
  sess_start_rounded numeric := 0;
  last_sess_delta numeric := 0;
  hardest_pos int := null;
  k_now numeric := K_PROV;
  seed_grade text;
  route_r numeric;
  e numeric;
begin
  if grp = 'boulder' then
    scale := array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17'];
    dvals := array[-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17];
    disc_offset := 0;
  else
    scale := array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d'];
    dvals := array[-4,-3.5,-3,-2.5,-2,-1,-0.5,0,0.5,1,1.5,2,2.5,3,3.7,4.3,5,6,6.7,7.3,8,9,9.7,10.3,11,12,13,14,15];
    disc_offset := ROPE_OFFSET;
  end if;

  for rec in
    select c.user_id as uid, c.date as cdate,
           array_position(scale, c.grade) as pos,
           c.result as res
    from public.climbs c
    where (case when grp = 'boulder' then c.discipline = 'Bouldering'
                else c.discipline <> 'Bouldering' end)
      and array_position(scale, c.grade) is not null
    order by c.user_id, c.date, c.id -- id breaks same-day ties, matching the app
  loop
    -- ----- user boundary: close previous user's last session, emit, reset -----
    if rec.uid is distinct from cur_uid then
      if cur_uid is not null then
        n_sessions := n_sessions + 1;
        last_sess_delta := round(R) - sess_start_rounded;
        user_id := cur_uid;
        select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber')
          into display_name from auth.users u where u.id = cur_uid;
        is_me := cur_uid = auth.uid();
        score := round(R);
        sessions := n_sessions;
        provisional := n_sessions < PROV_SESSIONS;
        last_delta := round(last_sess_delta);
        hardest := case when hardest_pos is null then null else scale[hardest_pos] end;
        return next;
      end if;
      cur_uid := rec.uid;
      -- seed R at the first SEND's grade (else the first climb's) in this group
      select c2.grade into seed_grade from public.climbs c2
        where c2.user_id = cur_uid
          and (case when grp = 'boulder' then c2.discipline = 'Bouldering' else c2.discipline <> 'Bouldering' end)
          and array_position(scale, c2.grade) is not null and c2.result <> 'Project'
        order by c2.date, c2.id limit 1;
      if seed_grade is null then
        select c2.grade into seed_grade from public.climbs c2
          where c2.user_id = cur_uid
            and (case when grp = 'boulder' then c2.discipline = 'Bouldering' else c2.discipline <> 'Bouldering' end)
            and array_position(scale, c2.grade) is not null
          order by c2.date, c2.id limit 1;
      end if;
      R := BASE + disc_offset + STEP * dvals[array_position(scale, seed_grade)];
      s_idx := 0; n_sessions := 0; hardest_pos := null; last_sess_delta := 0;
      cur_date := null;
    end if;

    -- ----- session boundary: close the prior session, start a new one -----
    if rec.cdate is distinct from cur_date then
      if cur_date is not null then
        n_sessions := n_sessions + 1;
        last_sess_delta := round(R) - sess_start_rounded;
        s_idx := s_idx + 1;
      end if;
      cur_date := rec.cdate;
      sess_start_rounded := round(R);
      k_now := case when s_idx < PROV_SESSIONS then K_PROV else K_EST end;
    end if;

    -- ----- the climb: one Elo update (flash adds FLASH_EDGE to routeR) -----
    route_r := BASE + disc_offset + STEP * dvals[rec.pos] + (case when rec.res = 'Flash' then FLASH_EDGE else 0 end);
    e := 1 / (1 + power(10, (route_r - R) / SPREAD));
    R := R + k_now * ((case when rec.res <> 'Project' then 1 else 0 end) - e);
    if rec.res <> 'Project' and (hardest_pos is null or rec.pos > hardest_pos) then
      hardest_pos := rec.pos;
    end if;
  end loop;

  -- ----- close + emit the final user's last session -----
  if cur_uid is not null then
    n_sessions := n_sessions + 1;
    last_sess_delta := round(R) - sess_start_rounded;
    user_id := cur_uid;
    select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber')
      into display_name from auth.users u where u.id = cur_uid;
    is_me := cur_uid = auth.uid();
    score := round(R);
    sessions := n_sessions;
    provisional := n_sessions < PROV_SESSIONS;
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
  provisional boolean,
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
