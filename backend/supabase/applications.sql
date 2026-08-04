-- Tvarin applications table — server-side store for the hosted dashboard.
-- The extension syncs each logged application here; the web dashboard reads
-- (and edits status on) it. Run once in the Supabase SQL editor.

create table if not exists public.applications (
  id            uuid primary key,                       -- client-generated (stable per application)
  user_id       uuid not null default auth.uid()
                  references auth.users (id) on delete cascade,
  url           text,
  hostname      text,
  job_title     text,
  company       text,
  ats           text,
  status        text not null default 'started',        -- started|applied|interviewing|offer|rejected
  filled        integer,
  resume_attached boolean,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists applications_user_idx on public.applications (user_id, updated_at desc);

alter table public.applications enable row level security;

-- Each user sees and edits only their own rows.
drop policy if exists "apps select own" on public.applications;
create policy "apps select own" on public.applications
  for select using (user_id = auth.uid());

drop policy if exists "apps insert own" on public.applications;
create policy "apps insert own" on public.applications
  for insert with check (user_id = auth.uid());

drop policy if exists "apps update own" on public.applications;
create policy "apps update own" on public.applications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "apps delete own" on public.applications;
create policy "apps delete own" on public.applications
  for delete using (user_id = auth.uid());

-- Table-level privileges for signed-in users. RLS (above) still scopes every
-- row to its owner — this just lets the `authenticated` role reach the table.
grant select, insert, update, delete on public.applications to authenticated;
