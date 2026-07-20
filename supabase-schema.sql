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
-- IN SYNC with app.js (SS_BASE, SS_STEP, SS_SPREAD, SS_K_*, SS_FLASH_BONUS):
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

-- ---------- Shared Send Score core: ONE Elo step ----------
-- The single source of truth for a per-climb rating update. Both the
-- leaderboard replay (climb_send_scores_impl) and the match subset scorer
-- (match rulesets) call this, so a discipline-filtered or best-of-N match is
-- scored by the EXACT same math as the leaderboard — never a second formula.
-- route_r is the climb's target rating (base + discipline offset + grade step
-- + flash edge); did_send is false only for a Project. SPREAD = 200.
create or replace function public.ss_step(r numeric, k numeric, route_r numeric, did_send boolean)
returns numeric language sql immutable as $$
  select r + k * ((case when did_send then 1 else 0 end) - 1 / (1 + power(10, (route_r - r) / 200.0)));
$$;
revoke all on function public.ss_step(numeric, numeric, numeric, boolean) from public, anon;
grant execute on function public.ss_step(numeric, numeric, numeric, boolean) to authenticated;

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
  FLASH_BONUS constant numeric := 1; -- a flash = the send + exactly 1 point
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

    -- ----- the climb: one Elo update; a flash adds a flat FLASH_BONUS point -----
    -- Same math as before, now via the shared ss_step core (SPREAD=200 there).
    route_r := BASE + disc_offset + STEP * dvals[rec.pos];
    R := public.ss_step(R, k_now, route_r, rec.res <> 'Project');
    if rec.res = 'Flash' then R := R + FLASH_BONUS; end if;
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

-- ============================================================================
-- Friends system + activity feed
-- ============================================================================
-- Three new tables (profiles, friendships, activity) plus SECURITY DEFINER
-- RPCs that are the deliberate social surface — the ONLY way one user's data
-- reaches another. RLS stays default-deny for direct cross-user reads; every
-- friend/feed function checks the friendship server-side (auth.uid()), exactly
-- like the leaderboard functions above.
--
-- Privacy stance (same as the leaderboard): friends see SANITIZED session
-- aggregates only — counts, total volume, top grade, PR flags. Raw lifts/climbs
-- rows (and their locations, notes, hold colors) are NEVER exposed to anyone
-- but their owner; friends read only the `activity` aggregates below.

create extension if not exists citext;

-- ---------- profiles: the searchable directory + stable @handle ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     citext unique,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.profiles drop constraint if exists profiles_username_chk;
alter table public.profiles add constraint profiles_username_chk
  check (username is null or username ~ '^[a-z0-9_]{3,20}$');

alter table public.profiles enable row level security;
-- Own row only: you can read/claim/update your own profile. Other people's
-- usernames/names reach you exclusively through friend_search / friend_list
-- (SECURITY DEFINER), so the directory can't be bulk-enumerated.
drop policy if exists "profile self read"   on public.profiles;
drop policy if exists "profile self insert" on public.profiles;
drop policy if exists "profile self update" on public.profiles;
create policy "profile self read"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "profile self insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profile self update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------- friendships: one row per unordered pair, full lifecycle ----------
-- user_a < user_b keeps the pair canonical so (A,B) and (B,A) are the same row;
-- requested_by records the direction of a pending request.
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  user_a       uuid not null references auth.users (id) on delete cascade,
  user_b       uuid not null references auth.users (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  unique (user_a, user_b)
);
alter table public.friendships drop constraint if exists friendship_pair_order;
alter table public.friendships drop constraint if exists friendship_no_self;
alter table public.friendships drop constraint if exists friendship_status_chk;
alter table public.friendships add constraint friendship_pair_order check (user_a < user_b);
alter table public.friendships add constraint friendship_no_self  check (user_a <> user_b);
alter table public.friendships add constraint friendship_status_chk check (status in ('pending','accepted','declined','canceled'));
create index if not exists friendships_a_idx on public.friendships (user_a);
create index if not exists friendships_b_idx on public.friendships (user_b);

alter table public.friendships enable row level security;
-- You may READ any friendship row you're part of (to see your requests/friends).
-- There are NO write policies: all mutations go through the definer RPCs below,
-- which enforce legal transitions. Direct INSERT/UPDATE/DELETE is denied.
drop policy if exists "friendship read" on public.friendships;
create policy "friendship read" on public.friendships for select to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

-- ---------- activity: sanitized per-session aggregates (the feed) ----------
create table if not exists public.activity (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null,                 -- 'lift_session' | 'climb_session'
  occurred_on date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  payload     jsonb not null default '{}',
  unique (user_id, kind, occurred_on)
);
alter table public.activity drop constraint if exists activity_kind_chk;
-- match_result is a later feed kind (see the match section); allow it here too
-- so re-applying this file over a DB that already has match_result rows works.
alter table public.activity add constraint activity_kind_chk check (kind in ('lift_session','climb_session','match_result'));
create index if not exists activity_user_created_idx on public.activity (user_id, created_at desc, id desc);

alter table public.activity enable row level security;
-- THE privacy boundary: an activity row is visible to its owner, or to an
-- accepted friend of the owner. This single policy gates BOTH friend_feed and
-- Supabase Realtime postgres_changes delivery (Realtime evaluates RLS per row
-- per subscriber), so a non-friend can never read or stream another's activity.
drop policy if exists "activity visible to friends" on public.activity;
create policy "activity visible to friends" on public.activity for select to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and f.user_a = least(auth.uid(), activity.user_id)
      and f.user_b = greatest(auth.uid(), activity.user_id)
  )
);
-- No write policies → only the SECURITY DEFINER trigger below writes activity.

-- Expose activity to Supabase Realtime (idempotent add to the publication).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity'
    ) then
      alter publication supabase_realtime add table public.activity;
    end if;
  end if;
end $$;

-- ---------- grade → difficulty index D (mirrors app.js V_D / YDS_D) ----------
-- Used only to pick the "hardest send" of a day and detect a new personal best.
-- KEEP IN SYNC with the maps in climb_send_scores_impl above.
create or replace function public.grade_d(discipline text, grade text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when discipline = 'Bouldering' then
      (array_position(
        array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17'],
        grade) - 2)::numeric
    else
      (array[-4,-3.5,-3,-2.5,-2,-1,-0.5,0,0.5,1,1.5,2,2.5,3,3.7,4.3,5,6,6.7,7.3,8,9,9.7,10.3,11,12,13,14,15]::numeric[])[
        array_position(
          array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d'],
          grade)]
  end
$$;

-- ---------- rebuild one (user, date, domain) activity aggregate ----------
-- Recomputes the sanitized headline stats for a day and upserts (or deletes if
-- the day is now empty) the single activity row. SECURITY DEFINER so it can
-- write activity despite the default-deny RLS. Reads only the owner's own rows.
create or replace function public.rebuild_activity(uid uuid, d date, knd text)
returns void
language plpgsql
security definer
set search_path = public
as $ra$
declare
  cnt int := 0;
  pl jsonb;
  best_grade text;
  best_disc text;
  best_d numeric;
  prior_best numeric;
begin
  if knd = 'lift_session' then
    select count(*),
           jsonb_build_object(
             'sets', coalesce(sum(sets), 0),
             'volume', round(coalesce(sum(weight * sets * reps), 0)),
             'exercises', count(distinct exercise),
             'unit', coalesce(max(unit), 'lbs'),
             'top_exercise', (select l2.exercise from public.lifts l2
                              where l2.user_id = uid and l2.date = d
                              order by l2.weight desc nulls last, l2.exercise limit 1)
           )
      into cnt, pl
      from public.lifts where user_id = uid and date = d;
  else
    -- hardest SEND of the day (max D), across both scales
    select c.grade, c.discipline, public.grade_d(c.discipline, c.grade)
      into best_grade, best_disc, best_d
      from public.climbs c
      where c.user_id = uid and c.date = d and c.result <> 'Project'
        and public.grade_d(c.discipline, c.grade) is not null
      order by public.grade_d(c.discipline, c.grade) desc nulls last, c.id
      limit 1;
    -- the climber's best send BEFORE this day (to flag a new personal best)
    select max(public.grade_d(c.discipline, c.grade))
      into prior_best
      from public.climbs c
      where c.user_id = uid and c.date < d and c.result <> 'Project';
    select count(*),
           jsonb_build_object(
             'sends', count(*) filter (where result <> 'Project'),
             'flashes', count(*) filter (where result = 'Flash'),
             'attempts', count(*),
             'hardest', best_grade,
             'hardest_discipline', best_disc,
             'new_hardest', (best_d is not null and (prior_best is null or best_d > prior_best))
           )
      into cnt, pl
      from public.climbs where user_id = uid and date = d;
  end if;

  if cnt = 0 then
    delete from public.activity where user_id = uid and kind = knd and occurred_on = d;
  else
    insert into public.activity (user_id, kind, occurred_on, payload, updated_at, created_at)
    values (uid, knd, d, pl, now(), now())
    on conflict (user_id, kind, occurred_on)
    do update set payload = excluded.payload, updated_at = now();
  end if;
end;
$ra$;

-- Triggers: any change to a user's lifts/climbs rebuilds that day's aggregate
-- (and the old day too, if a row's date moved). AFTER triggers, statement-safe.
create or replace function public.trg_refresh_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $tr$
declare
  knd text := case when tg_table_name = 'lifts' then 'lift_session' else 'climb_session' end;
begin
  if tg_op = 'DELETE' then
    perform public.rebuild_activity(old.user_id, old.date, knd);
  else
    perform public.rebuild_activity(new.user_id, new.date, knd);
    if tg_op = 'UPDATE' and (old.date <> new.date or old.user_id <> new.user_id) then
      perform public.rebuild_activity(old.user_id, old.date, knd);
    end if;
  end if;
  return null;
end;
$tr$;

drop trigger if exists lifts_activity  on public.lifts;
drop trigger if exists climbs_activity on public.climbs;
create trigger lifts_activity  after insert or update or delete on public.lifts  for each row execute function public.trg_refresh_activity();
create trigger climbs_activity after insert or update or delete on public.climbs for each row execute function public.trg_refresh_activity();

-- ---------- Friend RPCs (the ONLY write path; friendship checked server-side) ----------
-- My relationship to `other`. Uses auth.uid() as the viewer (never a caller-
-- supplied identity), so it can't be used to probe two arbitrary users.
drop function if exists public.friend_status(uuid, uuid);
create or replace function public.friend_status(other uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when auth.uid() = other then 'self' else coalesce((
    select case
      when f.status = 'accepted' then 'friends'
      when f.status = 'pending' and f.requested_by = auth.uid() then 'outgoing'
      when f.status = 'pending' and f.requested_by = other then 'incoming'
      else 'none'
    end
    from public.friendships f
    where f.user_a = least(auth.uid(), other) and f.user_b = greatest(auth.uid(), other)
  ), 'none') end
$$;

-- Claim / change your @username (unique, case-insensitive). Also mirrors your
-- display name into profiles. Raises on a taken or malformed handle.
create or replace function public.friend_set_username(handle text, dname text default null)
returns public.profiles language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); h text := lower(trim(handle)); row public.profiles;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if h !~ '^[a-z0-9_]{3,20}$' then raise exception 'invalid username' using errcode = '22023'; end if;
  if exists (select 1 from public.profiles p where p.username = h and p.id <> me) then
    raise exception 'username taken' using errcode = '23505';
  end if;
  insert into public.profiles (id, username, display_name, updated_at)
  values (me, h, coalesce(dname, (select display_name from public.profiles where id = me)), now())
  on conflict (id) do update set username = excluded.username,
    display_name = coalesce(excluded.display_name, public.profiles.display_name), updated_at = now()
  returning * into row;
  return row;
end $$;

-- Keep profiles.display_name in sync when the user renames (no username change).
create or replace function public.profile_set_display(dname text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  insert into public.profiles (id, display_name, updated_at) values (me, dname, now())
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now();
end $$;

-- Search the directory by @username or display name (prefix). Never returns
-- sessions; capped; excludes yourself. Includes our relationship for the UI.
create or replace function public.friend_search(q text)
returns table (user_id uuid, username text, display_name text, relationship text)
language sql stable security definer set search_path = public as $$
  select p.id, p.username::text, p.display_name, public.friend_status(p.id)
  from public.profiles p
  where p.id <> auth.uid()
    and length(coalesce(trim(q), '')) >= 2
    and (p.username ilike (trim(q) || '%') or p.display_name ilike (trim(q) || '%'))
  order by (p.username ilike (trim(q) || '%')) desc, p.username
  limit 20
$$;

-- Send a request. Mutual request auto-accepts; duplicate is a no-op; a prior
-- declined/canceled row reopens. Returns the resulting status.
create or replace function public.friend_request(target uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; row public.friendships;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if target is null or target = me then raise exception 'cannot friend yourself'; end if;
  if not exists (select 1 from auth.users u where u.id = target) then raise exception 'no such user'; end if;
  a := least(me, target); b := greatest(me, target);
  select * into row from public.friendships where user_a = a and user_b = b for update;
  if not found then
    insert into public.friendships (user_a, user_b, requested_by, status) values (a, b, me, 'pending');
    return 'requested';
  elsif row.status = 'accepted' then
    return 'already_friends';
  elsif row.status = 'pending' then
    if row.requested_by = me then return 'already_requested'; end if;
    update public.friendships set status = 'accepted', responded_at = now() where id = row.id; -- mutual merge
    return 'accepted';
  else -- declined / canceled → reopen as a fresh request from me
    update public.friendships set status = 'pending', requested_by = me, created_at = now(), responded_at = null where id = row.id;
    return 'requested';
  end if;
end $$;

-- Respond to an incoming request (must be the addressee of a pending request).
create or replace function public.friend_respond(other uuid, accept boolean)
returns text language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid := least(auth.uid(), other); b uuid := greatest(auth.uid(), other); row public.friendships;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select * into row from public.friendships where user_a = a and user_b = b for update;
  if not found or row.status <> 'pending' then raise exception 'no pending request'; end if;
  if row.requested_by = me then raise exception 'cannot respond to your own request'; end if;
  update public.friendships set status = case when accept then 'accepted' else 'declined' end, responded_at = now() where id = row.id;
  return case when accept then 'accepted' else 'declined' end;
end $$;

-- Cancel an outgoing pending request (must be the requester).
create or replace function public.friend_cancel(other uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid := least(auth.uid(), other); b uuid := greatest(auth.uid(), other); row public.friendships;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select * into row from public.friendships where user_a = a and user_b = b for update;
  if not found or row.status <> 'pending' or row.requested_by <> me then raise exception 'no cancelable request'; end if;
  update public.friendships set status = 'canceled', responded_at = now() where id = row.id;
  return 'canceled';
end $$;

-- Unfriend: remove the friendship entirely (both directions lose visibility).
create or replace function public.unfriend(other uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid := least(auth.uid(), other); b uuid := greatest(auth.uid(), other);
begin
  if me is null then raise exception 'not authenticated'; end if;
  delete from public.friendships where user_a = a and user_b = b and status = 'accepted';
  if not found then raise exception 'not friends'; end if;
  return 'unfriended';
end $$;

-- ---------- Friend read RPCs (server-side friendship scoping) ----------
-- My accepted friends, each with their current Send Scores + last-active time.
create or replace function public.friend_list()
returns table (user_id uuid, username text, display_name text, boulder integer, rope integer, last_active timestamptz)
language sql stable security definer set search_path = public as $$
  with fr as (
    select case when f.user_a = auth.uid() then f.user_b else f.user_a end as fid
    from public.friendships f
    where f.status = 'accepted' and (f.user_a = auth.uid() or f.user_b = auth.uid())
  ),
  b as (select s.user_id, s.score from public.climb_send_scores_impl('boulder') s),
  r as (select s.user_id, s.score from public.climb_send_scores_impl('rope') s)
  select fr.fid, p.username::text, coalesce(p.display_name, 'Climber'),
         b.score, r.score,
         (select max(a.created_at) from public.activity a where a.user_id = fr.fid) as last_active
  from fr
  left join public.profiles p on p.id = fr.fid
  left join b on b.user_id = fr.fid
  left join r on r.user_id = fr.fid
  order by last_active desc nulls last
$$;

-- My pending requests, incoming and outgoing.
create or replace function public.friend_requests()
returns table (user_id uuid, username text, display_name text, direction text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select (case when f.user_a = auth.uid() then f.user_b else f.user_a end) as uid,
         p.username::text, coalesce(p.display_name, 'Climber'),
         (case when f.requested_by = auth.uid() then 'outgoing' else 'incoming' end),
         f.created_at
  from public.friendships f
  left join public.profiles p on p.id = (case when f.user_a = auth.uid() then f.user_b else f.user_a end)
  where f.status = 'pending' and (f.user_a = auth.uid() or f.user_b = auth.uid())
  order by f.created_at desc
$$;

-- The feed: accepted friends' sanitized activity, keyset-paginated (never
-- loads everything). surface 'climbing' filters to climbing sessions; 'all'
-- returns lifting + climbing. Friendship enforced by the join, server-side.
create or replace function public.friend_feed(surface text default 'all', before_ts timestamptz default null, before_id uuid default null, lim integer default 20)
returns table (id uuid, user_id uuid, username text, display_name text, kind text, occurred_on date, created_at timestamptz, payload jsonb)
language sql stable security definer set search_path = public as $$
  with fr as (
    select case when f.user_a = auth.uid() then f.user_b else f.user_a end as fid
    from public.friendships f
    where f.status = 'accepted' and (f.user_a = auth.uid() or f.user_b = auth.uid())
  )
  select a.id, a.user_id, p.username::text, coalesce(p.display_name, 'Climber'),
         a.kind, a.occurred_on, a.created_at, a.payload
  from public.activity a
  join fr on fr.fid = a.user_id
  left join public.profiles p on p.id = a.user_id
  where (surface <> 'climbing' or a.kind = 'climb_session')
    and (before_ts is null or (a.created_at, a.id) < (before_ts, before_id))
  order by a.created_at desc, a.id desc
  limit greatest(1, least(coalesce(lim, 20), 50))
$$;

-- ---------- Lock down: internals definer-only; public RPCs to authenticated ----------
revoke all on function public.grade_d(text, text)               from public, anon, authenticated;
revoke all on function public.rebuild_activity(uuid, date, text) from public, anon, authenticated;
revoke all on function public.trg_refresh_activity()            from public, anon, authenticated;
revoke all on function public.friend_status(uuid)              from public, anon;
grant execute on function public.friend_status(uuid)           to authenticated;

revoke all on function public.friend_set_username(text, text) from public, anon;
revoke all on function public.profile_set_display(text)       from public, anon;
revoke all on function public.friend_search(text)             from public, anon;
revoke all on function public.friend_request(uuid)            from public, anon;
revoke all on function public.friend_respond(uuid, boolean)   from public, anon;
revoke all on function public.friend_cancel(uuid)             from public, anon;
revoke all on function public.unfriend(uuid)                  from public, anon;
revoke all on function public.friend_list()                   from public, anon;
revoke all on function public.friend_requests()               from public, anon;
revoke all on function public.friend_feed(text, timestamptz, uuid, integer) from public, anon;

grant execute on function public.friend_set_username(text, text) to authenticated;
grant execute on function public.profile_set_display(text)       to authenticated;
grant execute on function public.friend_search(text)             to authenticated;
grant execute on function public.friend_request(uuid)            to authenticated;
grant execute on function public.friend_respond(uuid, boolean)   to authenticated;
grant execute on function public.friend_cancel(uuid)             to authenticated;
grant execute on function public.unfriend(uuid)                  to authenticated;
grant execute on function public.friend_list()                   to authenticated;
grant execute on function public.friend_requests()               to authenticated;
grant execute on function public.friend_feed(text, timestamptz, uuid, integer) to authenticated;

-- ---------- Table privileges (RLS is the gate; these just enable it) ----------
-- Supabase grants these to `authenticated` by default; declaring them keeps the
-- schema self-contained. Writes to friendships/activity have no RLS policy, so
-- they're denied even with the grant — only the definer RPCs/trigger write them.
grant select, insert, update on public.profiles    to authenticated;
grant select                 on public.friendships to authenticated;
grant select                 on public.activity    to authenticated;
revoke all on public.profiles, public.friendships, public.activity from anon;

-- ---------- Gate the leaderboard DRILL-DOWN to self-or-friends ----------
-- The leaderboard RANKING (climb_send_scores: name, score, hardest grade) is
-- intentionally public — that's the whole point of a global leaderboard. But a
-- climber's detailed per-session history and grade-by-grade summary are private
-- unless you're friends. These redefinitions add that friendship check (they
-- run AFTER the friendships table exists, so `create or replace` wins on apply).
-- Found by a hostile-privacy pen test: without this guard, any authenticated
-- user could read anyone's climb history by passing a guessed target uuid.
create or replace function public.can_view_sessions(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select target = auth.uid() or exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and f.user_a = least(auth.uid(), target) and f.user_b = greatest(auth.uid(), target)
  )
$$;
revoke all on function public.can_view_sessions(uuid) from public, anon, authenticated;

create or replace function public.climb_user_summary(target uuid, days integer default 30, grp text default 'boulder')
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.can_view_sessions(target) then null else (
    select jsonb_build_object(
      'display_name', coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber'),
      'sessions', (
        select count(distinct c.date) from public.climbs c
        where c.user_id = target
          and (case when grp = 'boulder' then c.discipline = 'Bouldering' else c.discipline <> 'Bouldering' end)
          and c.date >= current_date - days
      ),
      'by_grade', coalesce((
        select jsonb_agg(jsonb_build_object('grade', t.grade, 'result', t.result, 'n', t.n))
        from (
          select c.grade, c.result, count(*) as n from public.climbs c
          where c.user_id = target
            and (case when grp = 'boulder' then c.discipline = 'Bouldering' else c.discipline <> 'Bouldering' end)
            and c.date >= current_date - days
          group by c.grade, c.result
        ) t
      ), '[]'::jsonb)
    )
    from auth.users u where u.id = target
  ) end
$$;

create or replace function public.climb_user_history(target uuid, grp text default 'boulder')
returns table (id uuid, date date, discipline text, grade text, attempts integer, result text)
language sql stable security definer set search_path = public as $$
  select c.id, c.date, c.discipline, c.grade, c.attempts, c.result
  from public.climbs c
  where c.user_id = target
    and public.can_view_sessions(target)   -- self or accepted friend only
    and (case when grp = 'boulder' then c.discipline = 'Bouldering' else c.discipline <> 'Bouldering' end)
    and array_position(
      case when grp = 'boulder'
        then array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17']::text[]
        else array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d']::text[]
      end, c.grade) is not null
  order by c.date, c.id
$$;

-- ---------- One-time backfill so existing sessions appear in feeds ----------
-- Runs only when the activity table is still empty (first install of the
-- friends feature); rebuild_activity upserts, so it's safe either way.
do $backfill$
declare r record;
begin
  if not exists (select 1 from public.activity limit 1) then
    for r in select distinct user_id, date from public.climbs loop
      perform public.rebuild_activity(r.user_id, r.date, 'climb_session');
    end loop;
    for r in select distinct user_id, date from public.lifts loop
      perform public.rebuild_activity(r.user_id, r.date, 'lift_session');
    end loop;
  end if;
end
$backfill$;

-- ---------- Make the directory cover EVERYONE, not just @username-claimers ----------
-- A user's display name lives in auth.users (set via the profile rename long
-- before the friends feature existed); the profiles row (which holds the
-- @username) only appears once they claim a handle. So search + name display
-- must fall back to the auth display name, or existing climbers are invisible.
create or replace function public.user_display(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  -- A null id, or an id whose auth row is gone (an admin-deleted account), shows
  -- as a deleted placeholder so preserved match history reads cleanly instead of
  -- rewriting other people's records.
  select case
    when uid is null or not exists (select 1 from auth.users u where u.id = uid) then 'Deleted climber'
    else coalesce(
      nullif(trim((select p.display_name from public.profiles p where p.id = uid)), ''),
      nullif(trim((select u.raw_user_meta_data->>'display_name' from auth.users u where u.id = uid)), ''),
      'Climber')
  end
$$;
revoke all on function public.user_display(uuid) from public, anon, authenticated;

-- Search by @username (profiles) OR display name (profiles or auth.users).
create or replace function public.friend_search(q text)
returns table (user_id uuid, username text, display_name text, relationship text)
language sql stable security definer set search_path = public as $$
  select u.id, p.username::text,
         coalesce(nullif(trim(p.display_name), ''), nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Climber'),
         public.friend_status(u.id)
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id <> auth.uid()
    and length(coalesce(trim(q), '')) >= 2
    and (
      p.username ilike (trim(q) || '%')
      or coalesce(p.display_name, u.raw_user_meta_data->>'display_name') ilike (trim(q) || '%')
    )
  order by (p.username ilike (trim(q) || '%')) desc nulls last, p.username nulls last
  limit 20
$$;

-- Friend/request/feed name display also falls back to the auth display name.
create or replace function public.friend_list()
returns table (user_id uuid, username text, display_name text, boulder integer, rope integer, last_active timestamptz)
language sql stable security definer set search_path = public as $$
  with fr as (
    select case when f.user_a = auth.uid() then f.user_b else f.user_a end as fid
    from public.friendships f
    where f.status = 'accepted' and (f.user_a = auth.uid() or f.user_b = auth.uid())
  ),
  b as (select s.user_id, s.score from public.climb_send_scores_impl('boulder') s),
  r as (select s.user_id, s.score from public.climb_send_scores_impl('rope') s)
  select fr.fid, p.username::text, public.user_display(fr.fid), b.score, r.score,
         (select max(a.created_at) from public.activity a where a.user_id = fr.fid) as last_active
  from fr
  left join public.profiles p on p.id = fr.fid
  left join b on b.user_id = fr.fid
  left join r on r.user_id = fr.fid
  order by last_active desc nulls last
$$;

create or replace function public.friend_requests()
returns table (user_id uuid, username text, display_name text, direction text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select (case when f.user_a = auth.uid() then f.user_b else f.user_a end) as uid,
         p.username::text,
         public.user_display(case when f.user_a = auth.uid() then f.user_b else f.user_a end),
         (case when f.requested_by = auth.uid() then 'outgoing' else 'incoming' end),
         f.created_at
  from public.friendships f
  left join public.profiles p on p.id = (case when f.user_a = auth.uid() then f.user_b else f.user_a end)
  where f.status = 'pending' and (f.user_a = auth.uid() or f.user_b = auth.uid())
  order by f.created_at desc
$$;

create or replace function public.friend_feed(surface text default 'all', before_ts timestamptz default null, before_id uuid default null, lim integer default 20)
returns table (id uuid, user_id uuid, username text, display_name text, kind text, occurred_on date, created_at timestamptz, payload jsonb)
language sql stable security definer set search_path = public as $$
  with fr as (
    select case when f.user_a = auth.uid() then f.user_b else f.user_a end as fid
    from public.friendships f
    where f.status = 'accepted' and (f.user_a = auth.uid() or f.user_b = auth.uid())
  )
  select a.id, a.user_id, p.username::text, public.user_display(a.user_id),
         a.kind, a.occurred_on, a.created_at, a.payload
  from public.activity a
  join fr on fr.fid = a.user_id
  left join public.profiles p on p.id = a.user_id
  where (surface <> 'climbing' or a.kind = 'climb_session')
    and (before_ts is null or (a.created_at, a.id) < (before_ts, before_id))
  order by a.created_at desc, a.id desc
  limit greatest(1, least(coalesce(lim, 20), 50))
$$;

-- ============================================================================
-- Head-to-head match game
-- ============================================================================
-- Two friends race turn by turn, each against THEIR OWN level. At accept, each
-- player's rating snapshot converts to a personal "par" grade. The match is
-- best-of-N slots (3/5/7/9), strict alternation with the challenger first: a
-- matching-discipline climb logged on your turn consumes a slot and scores PAR
-- POINTS — a pure function of grade vs your par, knowable before you climb:
--   fall/project 0 (still burns the slot) · send max(0, 3 + round(D − parD))
--   (3+ below par 0 — no farming trivial volume — 2 below 1, 1 below 2, at par
--   3, +1 grade 4, …) · flash +1, only on a send that scored.
-- Out-of-turn climbs stay ordinary session data. You log freely once the
-- opponent has ended their session or filled their slots. Most points wins;
-- an exact tie is a draw. The stake is a real Elo step between the two
-- players' displayed ratings (Δ = 16·(outcome − E)), stored per match and
-- added on top of the displayed rating. An UNRANKED match (ranked = false,
-- challenger's choice at creation) is the same game with the handicap and the
-- stake removed: both players score off the same fixed scratch baseline
-- (par D = 0 — a V0 / 5.10c send is 3, +1 per grade above), so whoever climbs
-- harder and sends more simply wins, and no elo changes hands (deltas 0).
-- The per-climb Send Score algorithm is
-- NEVER modified; climbs are scored once by the normal pipeline and the match
-- adjustment is applied once on top. Legacy matches (created before rulesets,
-- discipline null) keep the original engine-delta scoring end to end.

create table if not exists public.matches (
  id           uuid primary key default gen_random_uuid(),
  challenger   uuid not null references auth.users (id) on delete cascade,
  opponent     uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending',   -- pending/active/declined/canceled/resolved/abandoned
  ch_snap_boulder integer, ch_snap_rope integer,  -- each player's rating per group at accept (baseline)
  op_snap_boulder integer, op_snap_rope integer,
  window_start timestamptz, window_end timestamptz, -- time cap
  ch_ended     boolean not null default false,
  op_ended     boolean not null default false,
  grp          text,                              -- dominant discipline (set at resolve)
  ch_score     numeric, op_score numeric,         -- match scores (par points; legacy rows hold rating deltas)
  winner       text,                              -- 'challenger' | 'opponent' | 'draw'
  ch_delta     integer, op_delta integer,         -- elo adjustments applied (+X / −X)
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
alter table public.matches drop constraint if exists matches_no_self;
alter table public.matches drop constraint if exists matches_status_chk;
alter table public.matches add constraint matches_no_self check (challenger <> opponent);
alter table public.matches add constraint matches_status_chk check (status in ('pending','active','declined','canceled','resolved','abandoned'));
create index if not exists matches_ch_idx on public.matches (challenger, status);
create index if not exists matches_op_idx on public.matches (opponent, status);
-- Preserve completed matches when a participant is deleted: the reference goes
-- NULL (shown as "Deleted climber" via user_display) instead of cascade-deleting
-- the row, so the surviving player's elo history and record stay intact. The
-- admin delete flow removes in-flight matches explicitly first.
alter table public.matches drop constraint if exists matches_challenger_fkey;
alter table public.matches drop constraint if exists matches_opponent_fkey;
alter table public.matches alter column challenger drop not null;
alter table public.matches alter column opponent drop not null;
alter table public.matches add constraint matches_challenger_fkey
  foreign key (challenger) references auth.users (id) on delete set null;
alter table public.matches add constraint matches_opponent_fkey
  foreign key (opponent) references auth.users (id) on delete set null;

-- Ruleset (configured by the challenger at creation; agreed to on accept; never
-- changes after). discipline null = a legacy match created before rulesets — it
-- keeps the original auto-derived-group behavior. best_n = the slot count: your
-- first N counting climbs, logged turn by turn, are your match (null only on
-- old open-session rows; new ruleset matches always carry 3/5/7/9).
alter table public.matches add column if not exists discipline text;   -- 'boulder'|'lead'|'toprope'|'agnostic'
alter table public.matches add column if not exists best_n integer;    -- slots (3/5/7/9); null = legacy open
-- When each side ended their session. The turn walk needs the INSTANT (not just
-- the flag): a climb logged before the opponent ended must not retroactively
-- become counting when scored after they ended.
alter table public.matches add column if not exists ch_ended_at timestamptz;
alter table public.matches add column if not exists op_ended_at timestamptz;
-- Unranked (scratch) matches: par is a shared fixed baseline instead of each
-- player's rating, and no elo is exchanged. Pre-existing rows are ranked.
alter table public.matches add column if not exists ranked boolean not null default true;
alter table public.matches drop constraint if exists matches_discipline_chk;
alter table public.matches add constraint matches_discipline_chk check (discipline is null or discipline in ('boulder','lead','toprope','agnostic'));
alter table public.matches drop constraint if exists matches_best_n_chk;
alter table public.matches add constraint matches_best_n_chk check (best_n is null or (best_n between 1 and 50));

alter table public.matches enable row level security;
-- Only the two participants may read a match. Writes go only through the
-- SECURITY DEFINER RPCs below (no write policy = default deny), so a
-- non-participant can neither read nor inject into someone else's match.
drop policy if exists "match participants read" on public.matches;
create policy "match participants read" on public.matches for select to authenticated
  using (auth.uid() = challenger or auth.uid() = opponent);
grant select on public.matches to authenticated;
revoke all on public.matches from anon;

-- Allow a 'match_result' feed item, and relax the once-per-day uniqueness to
-- session kinds only (a climber can play several matches in a day).
alter table public.activity drop constraint if exists activity_kind_chk;
alter table public.activity add constraint activity_kind_chk check (kind in ('lift_session','climb_session','match_result'));
alter table public.activity drop constraint if exists activity_user_id_kind_occurred_on_key;
drop index if exists public.activity_user_id_kind_occurred_on_key;
create unique index if not exists activity_session_key on public.activity (user_id, kind, occurred_on) where kind in ('lift_session','climb_session');

-- A user's total match elo adjustment for a group = sum of their per-match
-- deltas across resolved matches whose dominant discipline was that group.
create or replace function public.match_adjustment(uid uuid, grp text)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when m.challenger = uid then m.ch_delta else m.op_delta end), 0)::int
  from public.matches m
  where m.status = 'resolved' and m.grp = grp and (m.challenger = uid or m.opponent = uid)
$$;
revoke all on function public.match_adjustment(uuid, text) from public, anon, authenticated;

-- The DISPLAYED rating = the pure climb-replay rating (unchanged engine) PLUS
-- the match adjustment. The per-climb algorithm is untouched; this is the
-- additive win/loss layer the challenge feature adds on top.
create or replace function public.climb_display_rating(uid uuid, grp text)
returns integer language sql stable security definer set search_path = public as $$
  select (select s.score from public.climb_send_scores_impl(grp) s where s.user_id = uid)
       + public.match_adjustment(uid, grp)
$$;
revoke all on function public.climb_display_rating(uuid, text) from public, anon, authenticated;

-- Inject the match adjustment into the public leaderboard ranking (the ranking
-- stays public; the number now includes match results). Rewrites the wrapper
-- only — the replay engine climb_send_scores_impl is untouched.
create or replace function public.climb_send_scores(grp text default 'boulder')
returns table (user_id uuid, display_name text, is_me boolean, score integer, sessions integer, provisional boolean, last_delta integer, hardest text)
language sql stable security definer set search_path = public as $$
  select s.user_id, s.display_name, s.is_me,
         s.score + public.match_adjustment(s.user_id, grp),
         s.sessions, s.provisional, s.last_delta, s.hardest
  from public.climb_send_scores_impl(grp) s
  order by (s.score + public.match_adjustment(s.user_id, grp)) desc, s.sessions desc
  limit 50
$$;

-- Thin accessor: a user's pure climb-replay rating (existing engine).
create or replace function public.impl_rating(uid uuid, grp text)
returns integer language sql stable security definer set search_path = public as $$
  select (select s.score from public.climb_send_scores_impl(grp) s where s.user_id = uid)
$$;
revoke all on function public.impl_rating(uuid, text) from public, anon, authenticated;

-- ---------- Match ruleset mapping ----------
-- The rating group (boulder/rope) a match discipline scores in.
create or replace function public.match_group(disc text)
returns text language sql immutable as $$
  select case when disc = 'boulder' then 'boulder' else 'rope' end
$$;
-- The set of climb.discipline values that COUNT toward a match discipline.
-- Trad is deliberately excluded from matches (it still logs as normal session
-- data); lead = Sport, top rope = Top Rope, agnostic = either roped style.
create or replace function public.match_disciplines(disc text)
returns text[] language sql immutable as $$
  select case disc
    when 'boulder'  then array['Bouldering']
    when 'lead'     then array['Sport']
    when 'toprope'  then array['Top Rope']
    when 'agnostic' then array['Sport','Top Rope']
    else null end
$$;

-- Human-readable ruleset label for the challenge + head-to-head screens.
-- (The old 2-arg signature must go or the 2-arg calls would be ambiguous.)
drop function if exists public.match_rules_label(text, int);
create or replace function public.match_rules_label(disc text, best_n int, ranked boolean default true)
returns text language sql immutable as $$
  select case when disc is null then 'Any climbing'
    else (case disc when 'boulder' then 'Bouldering' when 'lead' then 'Lead'
                    when 'toprope' then 'Top rope' when 'agnostic' then 'Routes (any)' else disc end)
       || ' · ' || (case when best_n is null then 'open session'
                         else 'best of ' || best_n || (case when disc = 'boulder' then ' problems' else ' routes' end) end)
       || (case when coalesce(ranked, true) then '' else ' · unranked' end)
  end
$$;

-- Nearest grade name for a (possibly fractional) difficulty D — displays a
-- player's par as a grade ("par V4" / "par 5.11a"). Ties resolve to the easier
-- grade. Same arrays as grade_d.
create or replace function public.par_grade(grp text, par_d numeric)
returns text language sql immutable as $$
  select case when par_d is null then null
    when grp = 'boulder' then
      (array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17'])
        [least(19, greatest(1, floor(par_d + 0.5)::int + 2))]
    else
      (select t.g from unnest(
         array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d'],
         array[-4,-3.5,-3,-2.5,-2,-1,-0.5,0,0.5,1,1.5,2,2.5,3,3.7,4.3,5,6,6.7,7.3,8,9,9.7,10.3,11,12,13,14,15]::numeric[]) t(g, d)
       order by abs(t.d - par_d), t.d limit 1)
  end
$$;

-- THE match engine: one deterministic pass over BOTH players' matching climbs
-- implementing turn-by-turn par-point scoring. Merged order (created_at, id);
-- turn starts at the challenger. A climb COUNTS iff its owner hasn't ended at
-- that instant, has free slots, and it's their turn — unless the opponent is
-- "released" (ended_at <= that instant, or slots already full), after which
-- alternation is over and they log freely. A counting climb consumes a slot,
-- scores par points (fall 0 · send max(0, 3 + rnd(D − parD)) — 3+ grades below
-- par is a warm-up worth nothing · flash +1 only on a send that scored, with
-- rnd(x) = floor(x + 0.5) — MUST match JS Math.round; plpgsql round() differs
-- at −0.5), and flips the turn. Out-of-turn climbs are ordinary session data.
-- parD comes from the accept snapshot ((snap − 1000 − ropeOffset)/100, kept
-- fractional) or seeds from the first matching send like the engine. best_n
-- null (old open rows) = no turn gate, no cap. Returns null on legacy matches.
create or replace function public.match_play(mid uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m record; discs text[]; grp text; n int; off int;
  ch_par numeric; op_par numeric; ch_pts int := 0; op_pts int := 0; ch_n int := 0; op_n int := 0;
  turn text := 'challenger'; ch_rel timestamptz; op_rel timestamptz;
  rec record; is_ch boolean; other_rel boolean; par numeric; pts int; ch_can boolean; op_can boolean;
  fg text; fd text;
begin
  select * into m from public.matches where id = mid;
  if not found or m.discipline is null then return null; end if;
  discs := public.match_disciplines(m.discipline);
  grp := public.match_group(m.discipline);
  n := m.best_n;
  off := case when grp = 'boulder' then 0 else 300 end;
  -- Release instants (ended flags without a timestamp — deploy straddlers —
  -- count as released from the window start; mildly lenient, window-bounded).
  ch_rel := case when m.ch_ended then coalesce(m.ch_ended_at, m.window_start) end;
  op_rel := case when m.op_ended then coalesce(m.op_ended_at, m.window_start) end;
  -- Par per side: snapshot → fractional D; null snapshot → seed from the first
  -- matching send (else first matching climb), the engine's own seeding rule.
  ch_par := case when (case grp when 'boulder' then m.ch_snap_boulder else m.ch_snap_rope end) is not null
    then ((case grp when 'boulder' then m.ch_snap_boulder else m.ch_snap_rope end) - 1000 - off) / 100.0 end;
  op_par := case when (case grp when 'boulder' then m.op_snap_boulder else m.op_snap_rope end) is not null
    then ((case grp when 'boulder' then m.op_snap_boulder else m.op_snap_rope end) - 1000 - off) / 100.0 end;
  if ch_par is null and m.challenger is not null then
    select c.grade, c.discipline into fg, fd from public.climbs c
      where c.user_id = m.challenger and c.created_at >= m.window_start and c.discipline = any(discs)
        and public.grade_d(c.discipline, c.grade) is not null
      order by (c.result <> 'Project') desc, c.created_at, c.id limit 1;
    if fg is not null then ch_par := public.grade_d(fd, fg); end if;
  end if;
  if op_par is null and m.opponent is not null then
    select c.grade, c.discipline into fg, fd from public.climbs c
      where c.user_id = m.opponent and c.created_at >= m.window_start and c.discipline = any(discs)
        and public.grade_d(c.discipline, c.grade) is not null
      order by (c.result <> 'Project') desc, c.created_at, c.id limit 1;
    if fg is not null then op_par := public.grade_d(fd, fg); end if;
  end if;
  -- Unranked: no handicap. Both sides score off the same fixed scratch
  -- baseline (D 0 = V0 / 5.10c → 3 points, +1 per grade above), so points are
  -- absolute — whoever climbs harder and sends more wins.
  if not coalesce(m.ranked, true) then ch_par := 0; op_par := 0; end if;
  -- The walk.
  for rec in
    select c.user_id, c.created_at, c.result as res, public.grade_d(c.discipline, c.grade) as gd
    from public.climbs c
    where (c.user_id = m.challenger or c.user_id = m.opponent)
      and c.created_at >= m.window_start
      and c.discipline = any(discs)
      and public.grade_d(c.discipline, c.grade) is not null
    order by c.created_at, c.id
  loop
    is_ch := rec.user_id = m.challenger;
    -- own side already ended at this instant → session-only
    if is_ch and ch_rel is not null and rec.created_at >= ch_rel then continue; end if;
    if not is_ch and op_rel is not null and rec.created_at >= op_rel then continue; end if;
    -- own slots full → session-only
    if n is not null and ((is_ch and ch_n >= n) or (not is_ch and op_n >= n)) then continue; end if;
    -- turn gate (only while the opponent is not released)
    if n is not null then
      other_rel := case when is_ch
        then (op_rel is not null and op_rel <= rec.created_at) or op_n >= n
        else (ch_rel is not null and ch_rel <= rec.created_at) or ch_n >= n end;
      if not other_rel and turn <> (case when is_ch then 'challenger' else 'opponent' end) then continue; end if;
    else
      other_rel := true; -- open rows: no alternation
    end if;
    par := case when is_ch then ch_par else op_par end;
    pts := case when rec.res = 'Project' then 0
           else greatest(0, 3 + floor(rec.gd - coalesce(par, rec.gd) + 0.5)::int) end;
    if pts > 0 and rec.res = 'Flash' then pts := pts + 1; end if;
    if is_ch then ch_n := ch_n + 1; ch_pts := ch_pts + pts;
    else op_n := op_n + 1; op_pts := op_pts + pts; end if;
    if n is not null and not other_rel then
      turn := case when is_ch then 'opponent' else 'challenger' end;
    end if;
  end loop;
  -- Current affordances (uses the live ended flags — a "now" question).
  ch_can := m.status = 'active' and not m.ch_ended and (n is null or ch_n < n)
        and (n is null or turn = 'challenger' or m.op_ended or op_n >= n);
  op_can := m.status = 'active' and not m.op_ended and (n is null or op_n < n)
        and (n is null or turn = 'opponent' or m.ch_ended or ch_n >= n);
  return jsonb_build_object(
    'group', grp,
    'turn', case when n is null or m.status <> 'active' then null else turn end,
    -- Unranked: par_d 0 still drives the point math (and the client's pill
    -- chips), but there's no personal par to DISPLAY — par comes back null.
    'ch', jsonb_build_object('points', ch_pts, 'counted', ch_n, 'par_d', ch_par,
      'par', case when coalesce(m.ranked, true) then public.par_grade(grp, ch_par) end, 'can_log', ch_can),
    'op', jsonb_build_object('points', op_pts, 'counted', op_n, 'par_d', op_par,
      'par', case when coalesce(m.ranked, true) then public.par_grade(grp, op_par) end, 'can_log', op_can));
end $$;
revoke all on function public.match_play(uuid) from public, anon, authenticated;

-- Slots a player has consumed (counting climbs only — out-of-turn climbs are
-- invisible here). Drives the "2 of 5" progress and the abandon check.
create or replace function public.match_counted(mid uuid, uid uuid)
returns integer language plpgsql stable security definer set search_path = public as $$
declare m record; j jsonb;
begin
  select challenger, discipline into m from public.matches where id = mid;
  if not found or m.discipline is null then return 0; end if;
  j := public.match_play(mid);
  return coalesce((j->(case when uid = m.challenger then 'ch' else 'op' end)->>'counted')::int, 0);
end $$;
revoke all on function public.match_counted(uuid, uuid) from public, anon, authenticated;

-- A player's match score. Ruleset matches: PAR POINTS from the turn walk
-- (match_play). Legacy matches: the original engine rating delta, summed
-- across groups, exactly as before rulesets existed.
create or replace function public.match_score(mid uuid, uid uuid)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare m record; s numeric := 0; g text; cur int; snap int; seedg numeric; fg text; fd text;
begin
  select * into m from public.matches where id = mid;
  if not found then return 0; end if;
  if m.discipline is not null then
    return coalesce((public.match_play(mid)
      ->(case when uid = m.challenger then 'ch' else 'op' end)->>'points')::numeric, 0);
  end if;
  -- Legacy match (created before rulesets): original whole-group behavior.
  foreach g in array array['boulder','rope'] loop
    cur := public.impl_rating(uid, g);
    snap := case when uid = m.challenger then (case g when 'boulder' then m.ch_snap_boulder else m.ch_snap_rope end)
                 else (case g when 'boulder' then m.op_snap_boulder else m.op_snap_rope end) end;
    if cur is null then
      continue;
    elsif snap is not null then
      s := s + (cur - snap);
    else
      select c.grade, c.discipline into fg, fd from public.climbs c
      where c.user_id = uid and c.created_at >= m.window_start
        and (case when g = 'boulder' then c.discipline = 'Bouldering' else c.discipline <> 'Bouldering' end)
        and public.grade_d(c.discipline, c.grade) is not null
      order by c.date, c.id limit 1;
      if fg is not null then
        seedg := 1000 + (case when fd = 'Bouldering' then 0 else 300 end) + 100 * public.grade_d(fd, fg);
        s := s + (cur - round(seedg));
      end if;
    end if;
  end loop;
  return s;
end $$;
revoke all on function public.match_score(uuid, uuid) from public, anon, authenticated;

-- Post a match result to a player's activity feed (visible to their friends).
create or replace function public.post_match_result(me uuid, opp uuid, winner text, my_delta integer, grp text, my_score numeric, opp_score numeric, mid uuid, i_am_challenger boolean)
returns void language plpgsql security definer set search_path = public as $$
declare res text;
begin
  res := case when winner = 'draw' then 'draw' when (winner = 'challenger') = i_am_challenger then 'won' else 'lost' end;
  insert into public.activity (user_id, kind, occurred_on, payload, created_at, updated_at)
  values (me, 'match_result', current_date,
    jsonb_build_object('opponent', public.user_display(opp), 'result', res, 'delta', my_delta,
      'group', grp, 'my_score', round(my_score, 1), 'opp_score', round(opp_score, 1), 'match_id', mid),
    now(), now());
end $$;
revoke all on function public.post_match_result(uuid, uuid, text, integer, text, numeric, numeric, uuid, boolean) from public, anon, authenticated;

-- Resolve a match: handicapped winner + chess-Elo stake between the two
-- DISPLAYED ratings (Δ = 16·(outcome − E)). Abandoned if nobody logged a climb.
create or replace function public.match_resolve(mid uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare m record; chs numeric; ops numeric; g text; ra int; rb int; ea numeric; kf numeric := 16; d int; win text;
  chb int; chr int; opb int; opr int; j jsonb;
begin
  select * into m from public.matches where id = mid for update;
  if not found or m.status <> 'active' then return; end if;
  if m.discipline is not null then
    -- Ruleset match: par points from the turn walk (one pass for both sides).
    -- Abandon if neither player logged a single COUNTING climb (out-of-turn or
    -- non-matching climbs are recorded but irrelevant to the match).
    g := public.match_group(m.discipline);
    j := public.match_play(mid);
    chb := coalesce((j->'ch'->>'counted')::int, 0);
    opb := coalesce((j->'op'->>'counted')::int, 0);
    if chb + opb = 0 then
      update public.matches set status = 'abandoned', resolved_at = now(), ch_score = 0, op_score = 0, grp = g where id = mid;
      return;
    end if;
  else
    -- Legacy match: original auto-derived dominant group over all window climbs.
    select count(*) filter (where discipline = 'Bouldering'), count(*) filter (where discipline <> 'Bouldering')
      into chb, chr from public.climbs where user_id = m.challenger and created_at >= m.window_start;
    select count(*) filter (where discipline = 'Bouldering'), count(*) filter (where discipline <> 'Bouldering')
      into opb, opr from public.climbs where user_id = m.opponent and created_at >= m.window_start;
    if coalesce(chb,0)+coalesce(chr,0)+coalesce(opb,0)+coalesce(opr,0) = 0 then
      update public.matches set status = 'abandoned', resolved_at = now(), ch_score = 0, op_score = 0 where id = mid;
      return;
    end if;
    g := case when (coalesce(chb,0)+coalesce(opb,0)) >= (coalesce(chr,0)+coalesce(opr,0)) then 'boulder' else 'rope' end;
  end if;
  if m.discipline is not null then
    -- Par points are exact small integers: any edge is a real edge, so only an
    -- EXACT tie is a draw.
    chs := coalesce((j->'ch'->>'points')::numeric, 0);
    ops := coalesce((j->'op'->>'points')::numeric, 0);
    if chs = ops then win := 'draw';
    elsif chs > ops then win := 'challenger'; else win := 'opponent'; end if;
  else
    chs := public.match_score(mid, m.challenger);
    ops := public.match_score(mid, m.opponent);
    -- Legacy scores are engine rating deltas where a few points are noise, not
    -- skill — a ≤4-point gap stays a virtual tie on those old rows.
    if abs(chs - ops) <= 4 then win := 'draw';
    elsif chs > ops then win := 'challenger'; else win := 'opponent'; end if;
  end if;
  ra := coalesce(public.climb_display_rating(m.challenger, g), 1000);
  rb := coalesce(public.climb_display_rating(m.opponent, g), 1000);
  ea := 1 / (1 + power(10, (rb - ra) / 200.0));
  d := round(kf * ((case win when 'challenger' then 1 when 'opponent' then 0 else 0.5 end) - ea));
  -- A genuine draw means both climbers performed equally relative to their OWN
  -- baselines, so neither out-performed the other: no rating changes hands. (For
  -- wins/losses the chess-Elo gap still makes upsets pay more than expected wins.)
  -- Unranked matches never move elo — that's the point of playing unranked.
  if win = 'draw' or not coalesce(m.ranked, true) then d := 0; end if;
  update public.matches set status = 'resolved', resolved_at = now(), grp = g,
    ch_score = chs, op_score = ops, winner = win, ch_delta = d, op_delta = -d where id = mid;
  perform public.post_match_result(m.challenger, m.opponent, win, d,  g, chs, ops, mid, true);
  perform public.post_match_result(m.opponent, m.challenger, win, -d, g, ops, chs, mid, false);
end $$;
revoke all on function public.match_resolve(uuid) from public, anon, authenticated;

-- ---------- Match lifecycle RPCs (participant + friendship checked) ----------
-- discipline: 'boulder'|'lead'|'toprope'|'agnostic'. best_n: null = open session
-- length, else best-of-N (1..50). Defaults keep the old 1-arg call working
-- (legacy null ruleset) for older harnesses; the app always sends a ruleset.
drop function if exists public.match_challenge(uuid);
drop function if exists public.match_challenge(uuid, text, integer);
create or replace function public.match_challenge(friend uuid, discipline text default null, best_n integer default null, ranked boolean default true)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); mid uuid; a uuid := least(auth.uid(), friend); b uuid := greatest(auth.uid(), friend);
begin
  if me is null then raise exception 'not authenticated'; end if;
  if friend = me then raise exception 'cannot challenge yourself'; end if;
  if discipline is not null and discipline not in ('boulder','lead','toprope','agnostic') then
    raise exception 'invalid discipline';
  end if;
  -- Matches are a best-of odd series: 3, 5, 7, or 9 — and a ruleset match MUST
  -- carry one (open ruleset matches would let min-1-point sends farm volume).
  -- The bare 1-arg legacy call (both null) stays allowed for old harnesses.
  if best_n is not null and best_n not in (3,5,7,9) then raise exception 'invalid match length'; end if;
  if discipline is not null and best_n is null then raise exception 'invalid match length'; end if;
  -- Unranked is a scratch-scoring variant of the ruleset game; a legacy
  -- null-discipline match has no per-climb scoring for it to change.
  if not coalesce(ranked, true) and discipline is null then raise exception 'invalid ruleset'; end if;
  if not exists (select 1 from public.friendships f where f.status='accepted' and f.user_a=a and f.user_b=b) then
    raise exception 'can only challenge friends';
  end if;
  if exists (select 1 from public.matches m where m.status in ('pending','active')
      and ((m.challenger=me and m.opponent=friend) or (m.challenger=friend and m.opponent=me))) then
    raise exception 'a match with this friend is already in progress';
  end if;
  insert into public.matches (challenger, opponent, status, discipline, best_n, ranked)
    values (me, friend, 'pending', discipline, best_n, coalesce(ranked, true)) returning id into mid;
  return mid;
end $$;

create or replace function public.match_respond(mid uuid, accept boolean)
returns text language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); m record;
begin
  select * into m from public.matches where id = mid for update;
  if not found or m.opponent <> me or m.status <> 'pending' then raise exception 'no pending challenge'; end if;
  if not accept then
    update public.matches set status = 'declined' where id = mid; return 'declined';
  end if;
  update public.matches set status = 'active', window_start = now(), window_end = now() + interval '4 hours',
    ch_snap_boulder = public.impl_rating(m.challenger, 'boulder'), ch_snap_rope = public.impl_rating(m.challenger, 'rope'),
    op_snap_boulder = public.impl_rating(m.opponent, 'boulder'),  op_snap_rope = public.impl_rating(m.opponent, 'rope')
  where id = mid;
  return 'active';
end $$;

create or replace function public.match_cancel(mid uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); m record;
begin
  select * into m from public.matches where id = mid for update;
  if not found or m.challenger <> me or m.status <> 'pending' then raise exception 'nothing to cancel'; end if;
  update public.matches set status = 'canceled' where id = mid;
  return 'canceled';
end $$;

-- End your side of an active match. When both have ended (or the time cap has
-- passed) the match resolves. A player who never ends still resolves at the cap.
create or replace function public.match_end(mid uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); m record;
begin
  select * into m from public.matches where id = mid for update;
  if not found or (m.challenger <> me and m.opponent <> me) then raise exception 'not your match'; end if;
  if m.status <> 'active' then return m.status; end if;
  if me = m.challenger then update public.matches set ch_ended = true, ch_ended_at = coalesce(ch_ended_at, now()) where id = mid; m.ch_ended := true; end if;
  if me = m.opponent  then update public.matches set op_ended = true, op_ended_at = coalesce(op_ended_at, now()) where id = mid; m.op_ended := true; end if;
  if m.ch_ended and m.op_ended then perform public.match_resolve(mid); end if;
  return (select status from public.matches where id = mid);
end $$;

-- Live head-to-head state (participant only). Resolves on read if the time cap
-- has passed. Returns each side's live score (par points), par grade, whose
-- turn it is, per-side can_log, and elo — numbers only, never the opponent's
-- raw climbs. Legacy matches keep the old shape (par/turn/can_log null).
create or replace function public.match_state(mid uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); m record; j jsonb := null;
begin
  select * into m from public.matches where id = mid;
  if not found or (m.challenger <> me and m.opponent <> me) then raise exception 'not your match'; end if;
  if m.status = 'active' and m.window_end is not null and now() > m.window_end then
    perform public.match_resolve(mid);
    select * into m from public.matches where id = mid;
  end if;
  if m.discipline is not null then j := public.match_play(mid); end if;
  return jsonb_build_object(
    'id', m.id, 'status', m.status, 'window_end', m.window_end,
    'i_am', case when me = m.challenger then 'challenger' else 'opponent' end,
    'winner', m.winner, 'group', m.grp,
    'turn', case when j is null then null else j->>'turn' end,
    'rules', jsonb_build_object('discipline', m.discipline, 'best_n', m.best_n,
      'ranked', coalesce(m.ranked, true),
      'style_label', public.match_rules_label(m.discipline, m.best_n, m.ranked)),
    'challenger', jsonb_build_object('name', public.user_display(m.challenger),
      'uid', m.challenger, 'avatar_v', coalesce((select avatar_v from public.profiles where id = m.challenger), 0),
      'baseline', coalesce(m.ch_snap_boulder, m.ch_snap_rope),
      'par', case when j is null then null else j->'ch'->>'par' end,
      'par_d', case when j is null then null else (j->'ch'->>'par_d')::numeric end,
      'can_log', case when j is null then null else coalesce((j->'ch'->>'can_log')::boolean, false) end,
      'elo', coalesce(public.climb_display_rating(m.challenger, coalesce(m.grp,'boulder')), public.climb_display_rating(m.challenger, 'rope')),
      'score', round(case when m.status in ('resolved','abandoned') then coalesce(m.ch_score,0)
                          when j is not null then coalesce((j->'ch'->>'points')::numeric, 0)
                          else public.match_score(mid, m.challenger) end, 1),
      'counted', case when j is null then null else (j->'ch'->>'counted')::int end,
      'ended', m.ch_ended, 'delta', m.ch_delta),
    'opponent', jsonb_build_object('name', public.user_display(m.opponent),
      'uid', m.opponent, 'avatar_v', coalesce((select avatar_v from public.profiles where id = m.opponent), 0),
      'baseline', coalesce(m.op_snap_boulder, m.op_snap_rope),
      'par', case when j is null then null else j->'op'->>'par' end,
      'par_d', case when j is null then null else (j->'op'->>'par_d')::numeric end,
      'can_log', case when j is null then null else coalesce((j->'op'->>'can_log')::boolean, false) end,
      'elo', coalesce(public.climb_display_rating(m.opponent, coalesce(m.grp,'boulder')), public.climb_display_rating(m.opponent, 'rope')),
      'score', round(case when m.status in ('resolved','abandoned') then coalesce(m.op_score,0)
                          when j is not null then coalesce((j->'op'->>'points')::numeric, 0)
                          else public.match_score(mid, m.opponent) end, 1),
      'counted', case when j is null then null else (j->'op'->>'counted')::int end,
      'ended', m.op_ended, 'delta', m.op_delta)
  );
end $$;

-- My matches: pending/active (to act on) and resolved (history), with ruleset.
drop function if exists public.match_list();
create or replace function public.match_list()
returns table (id uuid, status text, i_am text, opponent uuid, opponent_name text, winner text, my_delta integer, my_score numeric, opp_score numeric, discipline text, best_n integer, ranked boolean, rules_label text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.status,
    case when m.challenger = auth.uid() then 'challenger' else 'opponent' end,
    case when m.challenger = auth.uid() then m.opponent else m.challenger end,
    public.user_display(case when m.challenger = auth.uid() then m.opponent else m.challenger end),
    m.winner,
    case when m.challenger = auth.uid() then m.ch_delta else m.op_delta end,
    case when m.challenger = auth.uid() then m.ch_score else m.op_score end,
    case when m.challenger = auth.uid() then m.op_score else m.ch_score end,
    m.discipline, m.best_n, coalesce(m.ranked, true), public.match_rules_label(m.discipline, m.best_n, m.ranked),
    m.created_at
  from public.matches m
  where m.challenger = auth.uid() or m.opponent = auth.uid()
  order by m.created_at desc
$$;

revoke all on function public.match_challenge(uuid, text, integer, boolean) from public, anon;
revoke all on function public.match_respond(uuid, boolean) from public, anon;
revoke all on function public.match_cancel(uuid)           from public, anon;
revoke all on function public.match_end(uuid)              from public, anon;
revoke all on function public.match_state(uuid)            from public, anon;
revoke all on function public.match_list()                 from public, anon;
grant execute on function public.match_challenge(uuid, text, integer, boolean) to authenticated;
grant execute on function public.match_respond(uuid, boolean) to authenticated;
grant execute on function public.match_cancel(uuid)           to authenticated;
grant execute on function public.match_end(uuid)              to authenticated;
grant execute on function public.match_state(uuid)            to authenticated;
grant execute on function public.match_list()                 to authenticated;

-- rebuild_activity's upsert must target the PARTIAL unique index (session kinds
-- only) now that match_result rows are exempt — restate with the predicate.
create or replace function public.rebuild_activity(uid uuid, d date, knd text)
returns void language plpgsql security definer set search_path = public as $ra$
declare
  cnt int := 0; pl jsonb; best_grade text; best_disc text; best_d numeric; prior_best numeric;
begin
  if knd = 'lift_session' then
    select count(*), jsonb_build_object(
      'sets', coalesce(sum(sets), 0), 'volume', round(coalesce(sum(weight * sets * reps), 0)),
      'exercises', count(distinct exercise), 'unit', coalesce(max(unit), 'lbs'),
      'top_exercise', (select l2.exercise from public.lifts l2 where l2.user_id = uid and l2.date = d order by l2.weight desc nulls last, l2.exercise limit 1))
      into cnt, pl from public.lifts where user_id = uid and date = d;
  else
    select c.grade, c.discipline, public.grade_d(c.discipline, c.grade) into best_grade, best_disc, best_d
      from public.climbs c where c.user_id = uid and c.date = d and c.result <> 'Project'
        and public.grade_d(c.discipline, c.grade) is not null
      order by public.grade_d(c.discipline, c.grade) desc nulls last, c.id limit 1;
    select max(public.grade_d(c.discipline, c.grade)) into prior_best
      from public.climbs c where c.user_id = uid and c.date < d and c.result <> 'Project';
    select count(*), jsonb_build_object(
      'sends', count(*) filter (where result <> 'Project'), 'flashes', count(*) filter (where result = 'Flash'),
      'attempts', count(*), 'hardest', best_grade, 'hardest_discipline', best_disc,
      'new_hardest', (best_d is not null and (prior_best is null or best_d > prior_best)))
      into cnt, pl from public.climbs where user_id = uid and date = d;
  end if;
  if cnt = 0 then
    delete from public.activity where user_id = uid and kind = knd and occurred_on = d;
  else
    insert into public.activity (user_id, kind, occurred_on, payload, updated_at, created_at)
    values (uid, knd, d, pl, now(), now())
    on conflict (user_id, kind, occurred_on) where kind in ('lift_session','climb_session')
    do update set payload = excluded.payload, updated_at = now();
  end if;
end;
$ra$;

-- The current user's match adjustment per group, so the app's own hero/rating
-- display matches the leaderboard (which already adds it).
create or replace function public.match_my_adjustments()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('boulder', public.match_adjustment(auth.uid(), 'boulder'),
                            'rope', public.match_adjustment(auth.uid(), 'rope'))
$$;
revoke all on function public.match_my_adjustments() from public, anon;
grant execute on function public.match_my_adjustments() to authenticated;

-- ============================================================================
-- Admin — a private, owner-only screen to see the full user list and delete
-- accounts. The gate is a flag on the owner's profile row (matched once, by
-- email); EVERY admin RPC checks it server-side, so hiding the UI is not the
-- security boundary. Deleting an account preserves other people's completed
-- match history (the deleted side shows as "Deleted climber"), removes the
-- account's own data + in-flight matches, hard-deletes the auth row so the same
-- email can sign up fresh, and logs the deletion.
-- ============================================================================

-- The owner's email lives in exactly one place.
create or replace function public.admin_email() returns text
  language sql immutable as $$ select 'jmandelmvp@gmail.com'::text $$;

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- is_admin is DERIVED from the auth email on every profile write, so a user can
-- never grant themselves admin by updating their own row (the trigger recomputes
-- it and overrides whatever they set).
create or replace function public.profile_admin_flag() returns trigger
  language plpgsql security definer set search_path = public, auth as $$
begin
  new.is_admin := exists (
    select 1 from auth.users u
    where u.id = new.id and lower(u.email) = lower(public.admin_email()));
  return new;
end $$;
drop trigger if exists profiles_admin_flag on public.profiles;
create trigger profiles_admin_flag before insert or update on public.profiles
  for each row execute function public.profile_admin_flag();

-- Backfill any existing profile (idempotent on re-apply).
update public.profiles p set is_admin = true
  where p.is_admin is distinct from true
    and exists (select 1 from auth.users u where u.id = p.id and lower(u.email) = lower(public.admin_email()));

-- The gate every admin endpoint calls.
create or replace function public.admin_is() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;
revoke all on function public.admin_is() from public, anon;
grant execute on function public.admin_is() to authenticated;

-- A simple audit log of deletions.
create table if not exists public.admin_deletions (
  id          bigserial primary key,
  deleted_uid uuid,
  username    text,
  email       text,
  deleted_by  uuid,
  deleted_at  timestamptz not null default now()
);
alter table public.admin_deletions enable row level security;  -- no policy → reachable only via the gated RPCs

-- Full user list with the useful columns, paginated + searchable. Server-gated.
drop function if exists public.admin_user_list(text, integer, integer);
create or replace function public.admin_user_list(q text default '', page integer default 0, page_size integer default 25)
returns table (id uuid, username text, display_name text, email text, joined timestamptz,
               last_active timestamptz, send_score integer, friend_count integer, is_admin boolean)
language plpgsql stable security definer set search_path = public, auth as $$
declare lim integer := greatest(1, least(page_size, 100));
begin
  if not public.admin_is() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
  select u.id,
         p.username::text,
         public.user_display(u.id),
         u.email::text,
         u.created_at,
         greatest(
           (select max(c.created_at) from public.climbs   c where c.user_id = u.id),
           (select max(l.created_at) from public.lifts    l where l.user_id = u.id),
           (select max(a.created_at) from public.activity a where a.user_id = u.id)
         ),
         coalesce(public.climb_display_rating(u.id, 'boulder'), 1000)::integer,
         (select count(*)::int from public.friendships f
            where f.status = 'accepted' and (f.user_a = u.id or f.user_b = u.id)),
         coalesce(p.is_admin, false)
    from auth.users u
    left join public.profiles p on p.id = u.id
   where coalesce(q, '') = ''
         or p.username ilike '%' || q || '%'
         or public.user_display(u.id) ilike '%' || q || '%'
         or u.email ilike '%' || q || '%'
   order by u.created_at desc nulls last
   limit lim offset greatest(0, page) * lim;
end $$;
revoke all on function public.admin_user_list(text, integer, integer) from public, anon;
grant execute on function public.admin_user_list(text, integer, integer) to authenticated;

-- Delete a user. Server-gated; cannot delete yourself.
create or replace function public.admin_delete_user(target uuid)
returns void language plpgsql security definer set search_path = public, auth as $$
declare uname text; uemail text;
begin
  if not public.admin_is() then raise exception 'not authorized' using errcode = '42501'; end if;
  if target = auth.uid() then raise exception 'cannot delete your own admin account' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users where id = target) then raise exception 'no such user'; end if;

  select p.username, u.email into uname, uemail
    from auth.users u left join public.profiles p on p.id = u.id where u.id = target;

  -- in-flight matches can't continue → remove them; resolved/abandoned survive
  -- (their FK goes NULL on the auth delete below → "Deleted climber")
  delete from public.matches
   where (challenger = target or opponent = target)
     and status in ('pending', 'active', 'declined', 'canceled');

  -- the account's own records
  delete from public.activity    where user_id = target;
  delete from public.climbs      where user_id = target;
  delete from public.lifts       where user_id = target;
  delete from public.routines    where user_id = target;
  delete from public.friendships where user_a = target or user_b = target or requested_by = target;
  delete from public.profiles    where id = target;

  insert into public.admin_deletions (deleted_uid, username, email, deleted_by)
    values (target, uname, uemail, auth.uid());

  -- hard-delete the auth row: frees the email/credentials for a fresh signup
  delete from auth.users where id = target;
end $$;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- Recent deletions, for the owner's record. Server-gated.
drop function if exists public.admin_deletion_list(integer);
create or replace function public.admin_deletion_list(lim integer default 50)
returns table (username text, email text, deleted_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.admin_is() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query select d.username, d.email, d.deleted_at
    from public.admin_deletions d order by d.deleted_at desc limit greatest(1, least(lim, 200));
end $$;
revoke all on function public.admin_deletion_list(integer) from public, anon;
grant execute on function public.admin_deletion_list(integer) to authenticated;

-- ============================================================================
-- Profile pictures. The image bytes live in Supabase Storage (bucket
-- "avatars", public read); the profile row stores only a version counter
-- (avatar_v: 0 = default initials avatar, >0 = has a picture and doubles as a
-- cache-buster). Two fixed object paths per user — {uid}/thumb.webp and
-- {uid}/full.webp — so replacing a picture overwrites in place (the old blob is
-- gone) and removing deletes both. Owner-only writes are enforced by the
-- storage policies below; avatar_set/avatar_clear only ever touch your own row.
-- ============================================================================
alter table public.profiles add column if not exists avatar_v integer not null default 0;

-- Version lookup for a set of users, so any surface can upgrade its default
-- avatars to photos in one round-trip (public info; authenticated only).
create or replace function public.avatars_for(uids uuid[])
returns table (id uuid, v integer)
language sql stable security definer set search_path = public as $$
  select p.id, p.avatar_v from public.profiles p where p.id = any(uids)
$$;
revoke all on function public.avatars_for(uuid[]) from public, anon;
grant execute on function public.avatars_for(uuid[]) to authenticated;

-- Bump my picture version (called after a successful upload). Upserts my
-- profile so a user can have a picture before claiming a @username. Own row only.
create or replace function public.avatar_set()
returns integer language plpgsql security definer set search_path = public as $$
declare nv integer;
begin
  insert into public.profiles (id, avatar_v) values (auth.uid(), 1)
    on conflict (id) do update set avatar_v = public.profiles.avatar_v + 1, updated_at = now()
    returning avatar_v into nv;
  return nv;
end $$;
revoke all on function public.avatar_set() from public, anon;
grant execute on function public.avatar_set() to authenticated;

-- Revert to the default avatar (called after deleting the storage objects).
create or replace function public.avatar_clear()
returns void language sql security definer set search_path = public as $$
  update public.profiles set avatar_v = 0, updated_at = now() where id = auth.uid();
$$;
revoke all on function public.avatar_clear() from public, anon;
grant execute on function public.avatar_clear() to authenticated;

-- Storage bucket + owner-only policies. Guarded so this schema still applies on
-- a plain Postgres test cluster (no storage schema) — it runs only on real
-- Supabase. Public read; a hard 256 KB server-side size cap and an image-only
-- mime allowlist back up the client checks; writes restricted to your own
-- {uid}/… folder so you can only change your own picture.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 262144, array['image/webp','image/jpeg','image/png'])
    on conflict (id) do update set public = true, file_size_limit = 262144,
      allowed_mime_types = array['image/webp','image/jpeg','image/png'];
    execute 'drop policy if exists "avatars public read" on storage.objects';
    execute 'create policy "avatars public read" on storage.objects for select using (bucket_id = ''avatars'')';
    execute 'drop policy if exists "avatars owner insert" on storage.objects';
    execute 'create policy "avatars owner insert" on storage.objects for insert to authenticated with check (bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text)';
    execute 'drop policy if exists "avatars owner update" on storage.objects';
    execute 'create policy "avatars owner update" on storage.objects for update to authenticated using (bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text)';
    execute 'drop policy if exists "avatars owner delete" on storage.objects';
    execute 'create policy "avatars owner delete" on storage.objects for delete to authenticated using (bucket_id = ''avatars'' and (storage.foldername(name))[1] = auth.uid()::text)';
  end if;
end $$;
