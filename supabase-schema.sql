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
  location   text default '',
  notes      text default '',
  created_at timestamptz not null default now()
);

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

-- ---------- Climbing leaderboard ----------
-- Signed-in users normally see only their own rows (RLS above). This
-- SECURITY DEFINER function is the one deliberate exception: it exposes
-- cross-user AGGREGATES ONLY — display name, hardest grade, send counts.
-- Locations, notes, dates, and individual climbs are never revealed.
--
-- Ranking: hardest grade sent in the window, ties broken by how many sends
-- at that grade, then by total sends. One discipline at a time, so grades
-- are always compared within a single scale.
drop function if exists public.climb_leaderboard(integer, text); -- return type changed (added user_id)
create function public.climb_leaderboard(days integer default 30, disc text default 'Bouldering')
returns table (
  user_id uuid,
  display_name text,
  is_me boolean,
  hardest text,
  sends_at_hardest bigint,
  total_sends bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with scale as (
    select case when disc = 'Bouldering'
      then array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17']::text[]
      else array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d']::text[]
    end as g
  ),
  ranked as (
    select c.user_id, array_position(s.g, c.grade) as r
    from public.climbs c, scale s
    where c.discipline = disc
      and c.result <> 'Project'
      and c.date >= current_date - days
      and array_position(s.g, c.grade) is not null
  ),
  agg as (
    select user_id, max(r) as hardest_rank, count(*) as total_sends
    from ranked
    group by user_id
  ),
  at_hardest as (
    select r.user_id, count(*) as n
    from ranked r
    join agg a on a.user_id = r.user_id and r.r = a.hardest_rank
    group by r.user_id
  )
  select
    a.user_id,
    coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber') as display_name,
    a.user_id = auth.uid() as is_me,
    (select g from scale)[a.hardest_rank] as hardest,
    h.n as sends_at_hardest,
    a.total_sends
  from agg a
  join at_hardest h on h.user_id = a.user_id
  join auth.users u on u.id = a.user_id
  order by a.hardest_rank desc, h.n desc, a.total_sends desc
  limit 20
$$;

revoke all on function public.climb_leaderboard(integer, text) from public, anon;
grant execute on function public.climb_leaderboard(integer, text) to authenticated;

-- ---------- Per-climber summary (leaderboard drill-down) ----------
-- Aggregates only, same privacy stance as the leaderboard: grade-by-grade
-- counts per result plus a session count. Locations, notes, dates, and
-- individual climbs are never revealed.
create or replace function public.climb_user_summary(target uuid, days integer default 30, disc text default 'Bouldering')
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
      where c.user_id = target and c.discipline = disc and c.date >= current_date - days
    ),
    'by_grade', coalesce((
      select jsonb_agg(jsonb_build_object('grade', t.grade, 'result', t.result, 'n', t.n))
      from (
        select c.grade, c.result, count(*) as n
        from public.climbs c
        where c.user_id = target and c.discipline = disc and c.date >= current_date - days
        group by c.grade, c.result
      ) t
    ), '[]'::jsonb)
  )
  from auth.users u
  where u.id = target
$$;

revoke all on function public.climb_user_summary(uuid, integer, text) from public, anon;
grant execute on function public.climb_user_summary(uuid, integer, text) to authenticated;
