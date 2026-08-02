-- Personal ranking boards (one row per position per user).
-- Run once in the Supabase SQL editor.

create table if not exists public.ranking_boards (
  user_id uuid not null references auth.users (id) on delete cascade,
  position text not null,
  orders jsonb not null default '{}'::jsonb,
  tier_breaks jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, position)
);

alter table public.ranking_boards enable row level security;

drop policy if exists "ranking_boards_select_own" on public.ranking_boards;
drop policy if exists "ranking_boards_insert_own" on public.ranking_boards;
drop policy if exists "ranking_boards_update_own" on public.ranking_boards;
drop policy if exists "ranking_boards_delete_own" on public.ranking_boards;

create policy "ranking_boards_select_own"
  on public.ranking_boards for select
  using (auth.uid() = user_id);

create policy "ranking_boards_insert_own"
  on public.ranking_boards for insert
  with check (auth.uid() = user_id);

create policy "ranking_boards_update_own"
  on public.ranking_boards for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "ranking_boards_delete_own"
  on public.ranking_boards for delete
  using (auth.uid() = user_id);
