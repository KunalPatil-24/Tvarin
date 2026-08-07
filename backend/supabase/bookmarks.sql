-- Tvarin bookmarks table — server-side store for jobs the user saved by hand.
-- The extension syncs each bookmark here; the web dashboard reads / edits notes
-- and deletes on it. Separate from `applications` on purpose: bookmarks are
-- manual, have no pipeline status, and never auto-expire. Run once in the
-- Supabase SQL editor (same as applications.sql).

create table if not exists public.bookmarks (
  id            uuid primary key,                       -- client-generated (stable per bookmark)
  user_id       uuid not null default auth.uid()
                  references auth.users (id) on delete cascade,
  url           text,
  hostname      text,
  job_title     text,
  company       text,
  ats           text,
  note          text,                                   -- freeform: "waiting on referral from…"
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists bookmarks_user_idx on public.bookmarks (user_id, created_at desc);

alter table public.bookmarks enable row level security;

-- Each user sees and edits only their own rows.
drop policy if exists "bookmarks select own" on public.bookmarks;
create policy "bookmarks select own" on public.bookmarks
  for select using (user_id = auth.uid());

drop policy if exists "bookmarks insert own" on public.bookmarks;
create policy "bookmarks insert own" on public.bookmarks
  for insert with check (user_id = auth.uid());

drop policy if exists "bookmarks update own" on public.bookmarks;
create policy "bookmarks update own" on public.bookmarks
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "bookmarks delete own" on public.bookmarks;
create policy "bookmarks delete own" on public.bookmarks
  for delete using (user_id = auth.uid());

-- Table-level privileges for signed-in users. RLS (above) still scopes every
-- row to its owner — this just lets the `authenticated` role reach the table.
grant select, insert, update, delete on public.bookmarks to authenticated;
