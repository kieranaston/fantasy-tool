-- Personal fantasy-tool sync tables.
-- Run once in the Supabase SQL editor (safe to re-run).

-- Starred players (Draft Companion + ADP board).
create table if not exists public.starred_players (
  user_id uuid not null references auth.users (id) on delete cascade,
  ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id)
);

alter table public.starred_players enable row level security;

drop policy if exists "starred_players_select_own" on public.starred_players;
drop policy if exists "starred_players_insert_own" on public.starred_players;
drop policy if exists "starred_players_update_own" on public.starred_players;
drop policy if exists "starred_players_delete_own" on public.starred_players;

create policy "starred_players_select_own"
  on public.starred_players for select
  using (auth.uid() = user_id);

create policy "starred_players_insert_own"
  on public.starred_players for insert
  with check (auth.uid() = user_id);

create policy "starred_players_update_own"
  on public.starred_players for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "starred_players_delete_own"
  on public.starred_players for delete
  using (auth.uid() = user_id);
