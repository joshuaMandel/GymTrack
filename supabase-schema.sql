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
