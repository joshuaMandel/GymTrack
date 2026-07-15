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
-- Signed-in users normally see only their own rows (RLS above). This
-- SECURITY DEFINER function is a deliberate exception: it exposes
-- cross-user AGGREGATES ONLY — display name, Send Score, session count,
-- hardest send. Locations, notes, dates, and individual climbs are never
-- revealed.
--
-- It replays every climber's session history with the SAME algorithm the
-- app runs client-side (climberRating in app.js) so your own hero number
-- and your leaderboard number always agree. KEEP THE CONSTANTS IN SYNC
-- with app.js: start 1000; V-grade step 200; YDS step 100; K = 80 for the
-- first 5 sessions then 44; full volume weight at 6 climbs/session;
-- onsight +80 / flash +40; repeated attempts −8 each, capped at −40.
drop function if exists public.climb_leaderboard(integer, text); -- replaced by Send Score standings
drop function if exists public.climb_send_scores(text);
drop function if exists public.climb_send_scores_impl(text);
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
  anchor int;
  step numeric;
  rec record;
  cur_uid uuid := null;
  cur_date date := null;
  rating numeric := 1000;
  n_sessions int := 0;
  sess_delta numeric := 0;
  max_pos int := null;
  sum_surprise numeric := 0;
  n_climbs int := 0;
  eff numeric;
  expected numeric;
  sent boolean;
  k numeric;
  vol numeric;
begin
  if grp = 'boulder' then
    scale := array['VB','V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15','V16','V17'];
    anchor := array_position(scale, 'V0');
    step := 200;
  else
    scale := array['5.5','5.6','5.7','5.8','5.9','5.10a','5.10b','5.10c','5.10d','5.11a','5.11b','5.11c','5.11d','5.12a','5.12b','5.12c','5.12d','5.13a','5.13b','5.13c','5.13d','5.14a','5.14b','5.14c','5.14d','5.15a','5.15b','5.15c','5.15d'];
    anchor := array_position(scale, '5.6');
    step := 100;
  end if;

  for rec in
    select c.user_id as uid, c.date as cdate,
           array_position(scale, c.grade) as pos,
           greatest(coalesce(c.attempts, 1), 1) as tries,
           c.result as res
    from public.climbs c
    where (case when grp = 'boulder' then c.discipline = 'Bouldering'
                else c.discipline <> 'Bouldering' end)
      and array_position(scale, c.grade) is not null
    order by c.user_id, c.date
  loop
    if cur_uid is distinct from rec.uid or cur_date is distinct from rec.cdate then
      -- close the session that just ended (a session = one user + one date)
      if cur_uid is not null and n_climbs > 0 then
        k := case when n_sessions < 5 then 80 else 44 end;
        vol := 0.5 + 0.5 * least(1.0, n_climbs / 6.0);
        sess_delta := k * (sum_surprise / n_climbs) * vol;
        rating := rating + sess_delta;
        n_sessions := n_sessions + 1;
      end if;
      if cur_uid is distinct from rec.uid then
        -- emit the user whose history just finished
        if cur_uid is not null and n_sessions > 0 then
          user_id := cur_uid;
          select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber')
            into display_name from auth.users u where u.id = cur_uid;
          is_me := cur_uid = auth.uid();
          score := round(rating);
          sessions := n_sessions;
          provisional := n_sessions < 5;
          last_delta := round(sess_delta);
          hardest := case when max_pos is null then null else scale[max_pos] end;
          return next;
        end if;
        cur_uid := rec.uid;
        rating := 1000; n_sessions := 0; sess_delta := 0; max_pos := null;
      end if;
      cur_date := rec.cdate;
      sum_surprise := 0; n_climbs := 0;
    end if;

    -- score this climb against the rating as it stood entering the session
    sent := rec.res <> 'Project';
    eff := 1000 + (rec.pos - anchor) * step;
    if sent then
      eff := eff + case rec.res when 'Onsight' then 80 when 'Flash' then 40 else 0 end;
      eff := eff - least((rec.tries - 1) * 8, 40);
      if max_pos is null or rec.pos > max_pos then max_pos := rec.pos; end if;
    end if;
    expected := 1 / (1 + power(10, (eff - rating) / 400.0));
    sum_surprise := sum_surprise + (case when sent then 1 else 0 end) - expected;
    n_climbs := n_climbs + 1;
  end loop;

  -- close the final session and emit the final user
  if cur_uid is not null and n_climbs > 0 then
    k := case when n_sessions < 5 then 80 else 44 end;
    vol := 0.5 + 0.5 * least(1.0, n_climbs / 6.0);
    sess_delta := k * (sum_surprise / n_climbs) * vol;
    rating := rating + sess_delta;
    n_sessions := n_sessions + 1;
  end if;
  if cur_uid is not null and n_sessions > 0 then
    user_id := cur_uid;
    select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), 'Anonymous climber')
      into display_name from auth.users u where u.id = cur_uid;
    is_me := cur_uid = auth.uid();
    score := round(rating);
    sessions := n_sessions;
    provisional := n_sessions < 5;
    last_delta := round(sess_delta);
    hardest := case when max_pos is null then null else scale[max_pos] end;
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
